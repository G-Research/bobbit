/**
 * Tier 2.5 — REALISTIC tail-chat reproducing test for the markdown-async
 * image-decode reflow path.
 *
 * Why this test exists
 * --------------------
 * The 5 pre-existing `tail-chat-*.spec.ts` synthetic tests bypass the actual
 * streaming → reducer → MessagesContainer → DOM growth path the user
 * experiences, and assert on private fields. Empirically, on commit
 * `6613e8fb` they pass even with all three production pin paths
 * (`_pinIfSticking` body, RO `delta>0` branch, `_imageLoadHandler`)
 * neutered, because Chromium's `overflow-anchor: auto` quietly fixes
 * the viewport for them.
 *
 * Safari has no scroll-anchoring (MDN: "limited availability"). On iOS
 * PWA users, only the JS pin path keeps the viewport pinned. Any
 * regression there is invisible to the existing suite.
 *
 * This spec drives the REAL path: it sends a user message containing a
 * markdown-rendered image with intrinsic height ≥ 800 px. The
 * `<markdown-block>` custom element is lazy-loaded; the image element
 * loads + decodes asynchronously *after* initial layout, then reflows
 * the scroll container by ~800–1000 px. The only thing keeping the
 * viewport pinned to the latest-message bottom across that reflow is
 * the production `_imageLoadHandler` (`load` capture-phase listener)
 * + `_pinIfSticking()` re-pin tick.
 *
 * To make the JS pin path the *only* contract (Chromium ≡ Safari) we
 * inject `overflow-anchor: none !important` into the test scope. With
 * `_imageLoadHandler` neutered, the assertion fails:
 *
 *     latest-message bottom <X> px below viewport (>8)
 *
 * Assertion target: `getBoundingClientRect()` of the last message DOM
 * node vs the scroll container's viewport bottom. NEVER private fields.
 *
 * RECORDSCREEN=1 produces a frame-by-frame video so a human can scrub
 * the moment the viewport drifts off the latest message.
 */
import { test, expect } from "./fixtures.js";
import { waitForHealth, waitForSessionStatus, createSession } from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

const SCROLL_SEL = "agent-interface .overflow-y-auto";
const MESSAGE_SEL = "user-message, assistant-message, tool-message";
const TAIL_PX = 8;
const IMG_HEIGHT = 1000; // intrinsic px — comfortably ≥ 800 as required by the task spec

/**
 * A self-contained SVG sized 800×1000 px, base64-encoded into a data URI.
 * Used inside markdown image syntax to drive a real image.decode() reflow
 * without any network round trip. The image element only fires `load`
 * after the SVG is parsed and the natural dimensions are known — the
 * exact path `_imageLoadHandler` is wired to re-pin against.
 */
const TALL_IMAGE_DATA_URI = (() => {
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${IMG_HEIGHT}" viewBox="0 0 800 ${IMG_HEIGHT}">` +
		`<rect width="100%" height="100%" fill="#fcc"/>` +
		`<text x="400" y="500" text-anchor="middle" font-size="48" fill="#600">tail-chat reflow probe</text>` +
		`</svg>`;
	const b64 = Buffer.from(svg, "utf8").toString("base64");
	return `data:image/svg+xml;base64,${b64}`;
})();

test.describe("tail-chat: image-decode reflow keeps latest message pinned", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	// STAY_BUSY:5000 keeps the assistant turn parked for ~5 s; we assert
	// well before that completes so the *user-message* with the embedded
	// image is the latest fully-rendered message DOM node.
	test.setTimeout(60_000);

	test("markdown image (≥800 px) reflow re-pins latest message bottom (Safari-equivalent baseline)", async ({ page, rec }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await page.waitForSelector(SCROLL_SEL, { timeout: 10_000 });

		// Disable CSS scroll-anchoring inside the test scope. Mirrors Safari
		// (`overflow-anchor` has limited availability) and forces the JS
		// pin path to be the single contract. Without this, Chromium
		// transparently masks broken JS by visually pinning the viewport
		// regardless of whether `_imageLoadHandler` ran.
		await page.addStyleTag({
			content: `agent-interface .overflow-y-auto, agent-interface .overflow-y-auto * { overflow-anchor: none !important; }`,
		});

		// Inject a tall pre-stream spacer so the scroll container ALREADY
		// has overflow before the message lands. Without overflow,
		// "viewport at bottom" is trivially true regardless of pin
		// behaviour. The spacer is *prepended* (above all message
		// content) so "at bottom" then means "showing the latest
		// message", not "showing the spacer".
		await page.evaluate((sel) => {
			const ai = document.querySelector("agent-interface") as any;
			const content = ai?.querySelector(".max-w-5xl") as HTMLElement | null;
			if (!content) throw new Error("messages content container not found");
			const spacer = document.createElement("div");
			spacer.id = "__tail_chat_pre_spacer";
			spacer.style.height = "5000px";
			spacer.style.background = "linear-gradient(#eef, #fee)";
			content.insertBefore(spacer, content.firstChild);
			const el = document.querySelector(sel) as HTMLElement;
			el.scrollTop = el.scrollHeight;
			const top = el.scrollHeight - el.clientHeight;
			if (Array.isArray(ai._programmaticEchoes)) {
				ai._programmaticEchoes.push({ top, height: el.scrollHeight });
			}
			ai._stickToBottom = true;
			el.dispatchEvent(new Event("scroll"));
		}, SCROLL_SEL);
		await page.evaluate(() => new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		}));

		// Precondition: scroll container has overflow AND we're at the bottom.
		const pre = await page.evaluate((sel) => {
			const el = document.querySelector(sel) as HTMLElement;
			return {
				overflow: el.scrollHeight - el.clientHeight,
				distance: el.scrollHeight - el.scrollTop - el.clientHeight,
			};
		}, SCROLL_SEL);
		expect(
			pre.overflow,
			`pre-condition: scroll container must have overflow; overflow=${pre.overflow}`,
		).toBeGreaterThan(2000);
		expect(
			pre.distance,
			`pre-condition: must start at bottom; distance=${pre.distance}`,
		).toBeLessThanOrEqual(TAIL_PX);
		await rec.capture(`Pre-stream: 5000px spacer, at bottom (overflow=${pre.overflow})`);

		// Send a user message with a markdown image whose intrinsic height
		// is 1000 px, followed by trailing text. The user-message custom
		// element renders content through `<markdown-block>` (lazy-loaded
		// per `src/ui/lazy/markdown-block.ts::ensureMarkdownBlock`), which
		// emits an `<img>` whose `load` fires AFTER initial layout. That
		// load event triggers a >800 px reflow — exactly the path
		// `_imageLoadHandler` is wired to catch via `_pinIfSticking`.
		//
		// The `STAY_BUSY:5000` prefix keeps the mock-agent turn parked so
		// the assistant doesn't immediately emit a follow-up message that
		// would change "latest message" mid-assertion.
		const messageText =
			`STAY_BUSY:5000\n\n` +
			`Here is a tall image — please tail this chat.\n\n` +
			`![tall](${TALL_IMAGE_DATA_URI})\n\n` +
			`Trailing text after the image. The viewport must stay pinned ` +
			`to the bottom of THIS message after the image decodes.`;
		await sendMessage(page, messageText);
		await rec.capture("Sent markdown user message with embedded ≥800px image");

		// Wait for the user-message card to render in the DOM.
		await page.waitForSelector("user-message", { timeout: 15_000 });
		await rec.capture("user-message rendered (markdown-block lazy-load may still be in-flight)");

		// Wait for the embedded image element to load+decode.
		// `<markdown-block>` lazy-imports its definition; the `<img>`
		// inside doesn't exist until the chunk lands AND the element
		// upgrades AND Lit re-renders. Poll for the image to reach
		// `complete=true && naturalHeight>=800`. This is the specific
		// reflow the production `_imageLoadHandler` must re-pin against.
		await page.waitForFunction(({ minH }) => {
			const um = document.querySelector("user-message");
			if (!um) return false;
			const imgs = Array.from(um.querySelectorAll("img")) as HTMLImageElement[];
			return imgs.some((i) => i.complete && i.naturalHeight >= minH);
		}, { minH: 800 }, { timeout: 20_000 });
		await rec.capture("Embedded image fully decoded (reflow has fired)");

		// Let the production reflow → re-pin path run. Two rAFs cover:
		//   - capture-phase `load` event firing on the scroll container,
		//   - `_imageLoadHandler` calling `_pinIfSticking()`,
		//   - any subsequent `updateComplete` settle.
		// On a regressed build (`_imageLoadHandler` removed / no-op) the
		// viewport stays at the pre-reflow scrollTop and the latest
		// message bottom now sits ~IMG_HEIGHT px below the viewport.
		await page.evaluate(() => new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		}));

		// --- Outcome assertion: getBoundingClientRect-only ---
		//
		// Read the bottom of the last message DOM node and the bottom of
		// the scroll container's viewport. They must be within TAIL_PX.
		// We never touch `_stickToBottom` or any other private field.
		const probe = await page.evaluate(({ scrollSel, msgSel }) => {
			const el = document.querySelector(scrollSel) as HTMLElement | null;
			if (!el) throw new Error("scroll container not found");
			const msgs = Array.from(document.querySelectorAll(msgSel)) as HTMLElement[];
			if (msgs.length === 0) throw new Error("no message DOM nodes");
			const last = msgs[msgs.length - 1];
			const elRect = el.getBoundingClientRect();
			const lastRect = last.getBoundingClientRect();
			return {
				viewportBottom: elRect.bottom,
				viewportTop: elRect.top,
				lastBottom: lastRect.bottom,
				lastTop: lastRect.top,
				lastTag: last.tagName.toLowerCase(),
				lastHeight: lastRect.height,
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				distFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
				msgCount: msgs.length,
			};
		}, { scrollSel: SCROLL_SEL, msgSel: MESSAGE_SEL });

		// Distance from the bottom of the last message to the bottom of
		// the viewport. Positive = message bottom is BELOW the viewport
		// (cut off / below the fold) — the regression symptom. A small
		// negative value (message bottom slightly above the viewport
		// bottom because the scroll container has padding under the last
		// message) is also fine; we abs() for safety.
		const dist = Math.abs(probe.viewportBottom - probe.lastBottom);
		await rec.capture(
			`Probe: last=<${probe.lastTag}> dist=${Math.round(dist)} ` +
			`scrollTop=${Math.round(probe.scrollTop)}/${probe.scrollHeight} ` +
			`clientHeight=${probe.clientHeight} msgCount=${probe.msgCount}`,
		);

		// Sanity: streaming meaningfully grew the scroll container.
		// Otherwise the test trivially passes on a non-overflowing layout.
		expect(
			probe.scrollHeight,
			`tail-chat-image-reflow: scrollHeight (${probe.scrollHeight}) did not grow ` +
			`beyond pre-stream baseline (${pre.overflow + probe.clientHeight}). ` +
			`The image-bearing message didn't add real chat content — test is trivial.`,
		).toBeGreaterThan(pre.overflow + probe.clientHeight + 200);

		// Sanity: a fully-decoded ≥800 px image exists somewhere in the
		// transcript (not necessarily on the LAST message — STAY_BUSY may
		// have emitted follow-up assistant/tool messages by the time we
		// probe). The regression we're catching is: when the embedded
		// image decodes and reflows the layout, the viewport must stay
		// pinned to the LATEST message bottom — even if the image is in
		// an earlier message and reflows everything below it.
		const hasTallImg = await page.evaluate((minH) => {
			const imgs = Array.from(document.querySelectorAll("agent-interface img")) as HTMLImageElement[];
			return imgs.some((i) => i.complete && i.naturalHeight >= minH);
		}, 800);
		expect(
			hasTallImg,
			`tail-chat-image-reflow: a fully-decoded ≥800 px image must be present in the transcript ` +
			`(otherwise no reflow happened and the test is trivial).`,
		).toBe(true);

		// THE assertion. Latest message bottom must align with the
		// viewport bottom within TAIL_PX. On a regressed build (no
		// `_imageLoadHandler` re-pin), this fails with the latest-message
		// bottom ~IMG_HEIGHT px below the viewport — the exact tail-chat-
		// not-following symptom users report.
		expect(
			dist,
			`latest-message bottom ${Math.round(dist)} px below viewport (>${TAIL_PX}). ` +
			`scrollTop=${Math.round(probe.scrollTop)} scrollHeight=${probe.scrollHeight} ` +
			`clientHeight=${probe.clientHeight} distFromScrollBottom=${Math.round(probe.distFromBottom)} ` +
			`lastTag=${probe.lastTag} lastHeight=${Math.round(probe.lastHeight)}. ` +
			`Production _imageLoadHandler did not re-pin after image-decode reflow.`,
		).toBeLessThanOrEqual(TAIL_PX);
	});
});
