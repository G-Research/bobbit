/**
 * Tier 2.5 — pin survives a tool-result `<details>` toggle reflow.
 *
 * Synthesises a long bash-tool-result-like card with a `<details>` element
 * inside the messages content container. The toggle expands ~400 px of
 * additional content. The contract under test (use-stick-to-bottom port):
 * the RO `delta>0` re-pin must keep the latest message bottom-pinned
 * across the reflow, sampled across a full second post-toggle.
 *
 * Outcome-only — bounding rects, no private-field reads.
 */
import { test, expect } from "./fixtures.js";
import { waitForHealth, waitForSessionStatus, createSession } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { SCROLL_SEL, TAIL_PX, MESSAGE_SEL, disableScrollAnchoring } from "./tail-chat-helpers.js";

test.describe("tail-chat: tool-result <details> toggle reflow keeps pin", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test.setTimeout(60_000);

	test("expanding a long tool-result keeps latest message visible (no Jump click)", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await page.waitForSelector(SCROLL_SEL, { timeout: 10_000 });

		await disableScrollAnchoring(page);

		// Spacer above + a tool-message-shaped card with a <details> at the
		// END. The card is the "latest message" we measure with bounding
		// rects.
		await page.evaluate((sel) => {
			const ai = document.querySelector("agent-interface") as any;
			const content = ai?.querySelector(".max-w-5xl") as HTMLElement | null;
			if (!content) throw new Error("messages content container not found");
			const spacer = document.createElement("div");
			spacer.id = "__pre_spacer";
			spacer.style.height = "5000px";
			spacer.style.background = "linear-gradient(#eef, #fee)";
			content.insertBefore(spacer, content.firstChild);
			// Synthetic tool-message card with a <details> toggle + 400 px
			// of inner content. Tag name is `tool-message` so it matches
			// the MESSAGE_SEL recogniser used by `expectLatestMessagePinned`.
			const card = document.createElement("tool-message");
			card.setAttribute("data-toggle-probe", "1");
			card.setAttribute("style", "display:block;background:#dde;padding:8px;");
			const summary = document.createElement("summary");
			summary.textContent = "bash output (click to expand)";
			summary.id = "__details_summary";
			summary.setAttribute("style", "cursor:pointer;padding:4px;background:#cce;");
			const inner = document.createElement("div");
			inner.setAttribute("style", "height:400px;background:#cee;");
			inner.textContent = "expanded body — 400 px";
			const det = document.createElement("details");
			det.appendChild(summary);
			det.appendChild(inner);
			card.appendChild(document.createTextNode("Header line of tool result"));
			card.appendChild(det);
			content.appendChild(card);
			const el = document.querySelector(sel) as HTMLElement;
			el.scrollTop = el.scrollHeight;
		}, SCROLL_SEL);
		await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

		const pre = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			return {
				overflow: el.scrollHeight - el.clientHeight,
				distance: el.scrollHeight - el.scrollTop - el.clientHeight,
			};
		}, SCROLL_SEL);
		expect(pre.overflow, "pre: overflow").toBeGreaterThan(2000);
		expect(pre.distance, "pre: at bottom").toBeLessThanOrEqual(TAIL_PX);
		await rec.capture(`Pre: at bottom (overflow=${pre.overflow})`);

		// Click the <details> summary to toggle it open. ~400 px of new
		// content reflows below the existing card; the RO `delta>0` branch
		// must re-pin within a frame or two.
		await page.locator("#__details_summary").click();
		await rec.capture("Clicked <details> summary — 400 px reflow");

		// Wait for the RO + rAF re-pin to settle. The contract is
		// "latest message bottom-pinned across the reflow", not "pinned
		// within the same animation frame as the synchronous reflow" — RO
		// fires after layout, then rAF runs scrollToBottom. Two rAFs of
		// settle is consistent with how the rest of the suite waits.
		await page.evaluate(
			() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
		);

		// Sample at 50 ms intervals for 1 s. Latest message bottom must
		// not drop more than 8 px below the viewport bottom in any sample.
		const samples: Array<{ t: number; belowFold: number; dist: number }> = [];
		const start = Date.now();
		while (Date.now() - start < 1000) {
			const probe = await page.evaluate(({ scrollSel, msgSel }) => {
				const el = document.querySelector(scrollSel) as HTMLElement;
				const msgs = Array.from(document.querySelectorAll(msgSel)) as HTMLElement[];
				const last = msgs[msgs.length - 1];
				const elRect = el.getBoundingClientRect();
				const lastRect = last.getBoundingClientRect();
				return {
					belowFold: lastRect.bottom - elRect.bottom,
					dist: el.scrollHeight - el.scrollTop - el.clientHeight,
				};
			}, { scrollSel: SCROLL_SEL, msgSel: MESSAGE_SEL });
			samples.push({ t: Date.now() - start, ...probe });
			await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 50)));
		}

		const offenders = samples.filter((s) => s.belowFold > 8);
		const summary = offenders
			.slice(0, 8)
			.map((s) => `t=${s.t}ms belowFold=${Math.round(s.belowFold)} dist=${Math.round(s.dist)}`)
			.join("\n  ");
		expect(
			offenders.length,
			`tool-expand-reflow: ${offenders.length}/${samples.length} samples had latest-message ` +
			`bottom > 8 px below viewport. Pin lost across <details> toggle reflow.\n  ${summary}`,
		).toBe(0);
		await rec.capture(`Sampled ${samples.length} times \u2014 all pinned`);
	});
});
