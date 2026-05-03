/**
 * Reproducing test for goal "Fix tail-chat reliability" — Case (3):
 * **Session navigate doesn't always land at the bottom.**
 *
 * Per Issue Analysis section 4 case (3), the 3 s session-load settle window
 * exits early when scrollHeight stabilises across two ticks, but async
 * markdown / syntax highlighting / image-decode reflows can land *after*
 * that exit. Once the settle window is gone, the geometry path in
 * `_handleScroll` re-engages and a queued stale scroll event from the DOM
 * swap flips `_stickToBottom = false`. The user lands above the latest
 * content.
 *
 * The redesign (section 6.4) replaces the time-bounded settle window with
 * an event-driven RO loop and an image-load delegate. The geometry-driven
 * flip is removed.
 *
 * Scenario: pre-create two sessions, manually inflate each with a tall
 * spacer + queue a delayed (post-render) growth event via setTimeout that
 * arrives well after the settle window's 3 s deadline. Navigate A→B→A→B→A
 * (five hops). Each navigate must land at the bottom within 4 px.
 *
 * Expected master failure: at least one hop's settle window exits before
 * the delayed-growth event arrives, the geometry path then flips the flag,
 * and the viewport ends up above the bottom by the delayed-growth height.
 */
import { test, expect } from "./fixtures.js";
import { createSession, waitForSessionStatus, waitForHealth } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { SCROLL_SEL, CONTENT_SEL, TAIL_PX } from "./tail-chat-helpers.js";

test.describe("tail-chat: session navigate lands at bottom", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("navigate A→B→A→B→A: each hop lands at bottom within 4 px", async ({ page, rec }) => {
		const sessionA = await createSession();
		const sessionB = await createSession();
		await waitForSessionStatus(sessionA, "idle");
		await waitForSessionStatus(sessionB, "idle");

		await openApp(page);

		/**
		 * Navigate to a session, install a tall spacer in its `.max-w-5xl`
		 * container, queue a delayed (post-rAF) growth event simulating
		 * async markdown / syntax-highlighting reflow that lands AFTER
		 * the master settle window's two-stable-ticks early exit.
		 *
		 * Returns the post-settle scroll metrics + _stickToBottom flag.
		 */
		const visit = async (id: string, label: string) => {
			await page.evaluate((sid) => {
				window.location.hash = `#/session/${sid}`;
			}, id);
			await page.waitForSelector(SCROLL_SEL, { timeout: 15_000 });
			// Wait for the agent-interface to render and for setupSessionSubscription
			// to install the scroll container + ResizeObserver.
			await page.waitForFunction(() => {
				const ai = document.querySelector("agent-interface") as any;
				return ai && ai._scrollContainer;
			}, null, { timeout: 10_000 });

			// Install a tall spacer so the scroll container has overflow.
			await page.evaluate(({ contentSel }) => {
				const content = document.querySelector(contentSel) as HTMLElement | null;
				if (!content) throw new Error("messages content container not found");
				content.querySelectorAll(".__tail_chat_nav").forEach((n) => n.remove());
				const spacer = document.createElement("div");
				spacer.className = "__tail_chat_nav";
				spacer.style.height = "3500px";
				spacer.style.background = "linear-gradient(#eef, #fee)";
				content.appendChild(spacer);
			}, { contentSel: CONTENT_SEL });

			// Let initial RO + Lit pin chains run.
			await page.evaluate(() => new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			}));

			// Force the session-load settle window to exit (the redesign removes
			// it entirely). This simulates the master failure mode where the
			// settle window exits early (after two stable RO ticks) before all
			// async growth has landed. On the post-fix build the property
			// doesn't exist; assignment is harmless.
			await page.evaluate(() => {
				const ai = document.querySelector("agent-interface") as any;
				if ("_settleWindowActive" in ai) ai._settleWindowActive = false;
			});

			// Inject a stale scroll event whose (scrollTop, scrollHeight) does
			// NOT match the echo latch — mimics the queued browser-emitted
			// scroll event from the navigate-time DOM swap that arrives after
			// the settle window has exited.
			await page.evaluate((sel) => {
				const ai = document.querySelector("agent-interface") as any;
				const el = document.querySelector(sel) as HTMLElement;
				if (Array.isArray(ai._programmaticEchoes)) {
					ai._programmaticEchoes.length = 0;
				} else {
					ai._lastProgrammaticScrollTop = null;
					ai._lastProgrammaticScrollHeight = null;
				}
				const ch = el.clientHeight;
				el.scrollTop = Math.max(0, el.scrollHeight - ch - Math.ceil(ch * 0.5));
				el.dispatchEvent(new Event("scroll"));
			}, SCROLL_SEL);

			// Late async growth (markdown / syntax-highlighting / image-decode
			// reflow that lands after settle exits).
			await page.evaluate(({ contentSel }) => {
				const content = document.querySelector(contentSel) as HTMLElement | null;
				if (!content) return;
				const late = document.createElement("div");
				late.className = "__tail_chat_nav";
				late.style.height = "400px";
				late.style.background = "rgba(255,0,0,0.05)";
				content.appendChild(late);
			}, { contentSel: CONTENT_SEL });

			// Two rAFs so the RO has fired and Lit has committed.
			await page.evaluate(() => new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			}));

			return await page.evaluate((sel) => {
				const ai = document.querySelector("agent-interface") as any;
				const el = document.querySelector(sel) as HTMLElement;
				return {
					stick: ai._stickToBottom,
					scrollTop: el.scrollTop,
					scrollHeight: el.scrollHeight,
					clientHeight: el.clientHeight,
				};
			}, SCROLL_SEL);
		};

		const hops: Array<{ id: string; label: string }> = [
			{ id: sessionA, label: "A (1st)" },
			{ id: sessionB, label: "B (1st)" },
			{ id: sessionA, label: "A (2nd)" },
			{ id: sessionB, label: "B (2nd)" },
			{ id: sessionA, label: "A (3rd)" },
		];

		await rec.capture("Sessions A and B created");
		for (const { id, label } of hops) {
			const m = await visit(id, label);
			const distance = m.scrollHeight - m.scrollTop - m.clientHeight;
			await rec.capture(`Hop "${label}": dist=${distance} stick=${m.stick}`);
			expect(
				distance,
				`tail-chat-session-navigate: hop "${label}" did not land at bottom; ` +
				`scrollTop=${m.scrollTop} scrollHeight=${m.scrollHeight} ` +
				`clientHeight=${m.clientHeight} distance=${distance} (>${TAIL_PX}); ` +
				`_stickToBottom=${m.stick}`,
			).toBeLessThanOrEqual(TAIL_PX);
		}
	});
});
