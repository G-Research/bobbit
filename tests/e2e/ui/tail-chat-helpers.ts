/**
 * Shared helpers for tail-chat-* reproducing tests.
 *
 * Setup: open app, create a session, inject a tall spacer so the scroll
 * container has scrollable content, snap to bottom, then explicitly cancel
 * the 3 s session-load settle window so subsequent stimuli exercise the
 * steady-state code paths (in particular the geometry-flip in `_handleScroll`
 * that the redesign deletes).
 *
 * Usage from a spec:
 *
 *     const { scrollSel } = await setupTailChatScene(page);
 *     await growContent(page, 600);
 *     ... assert ...
 *
 * All helpers are deterministic — they use updateComplete + rAF synchronisation,
 * never fixed setTimeout sleeps.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { openApp, createSessionViaUI } from "./ui-helpers.js";

export const SCROLL_SEL = "agent-interface .overflow-y-auto";
export const CONTENT_SEL = "agent-interface .max-w-5xl";

/**
 * Opens app, creates a session, installs a tall initial spacer, and snaps
 * scrollTop to the bottom. Also disables the 3 s settle window so geometry
 * paths run in their steady-state form.
 *
 * Returns the selector for the scroll container.
 */
export async function setupTailChatScene(page: Page): Promise<{ scrollSel: string }> {
	await openApp(page);
	await createSessionViaUI(page);

	await page.waitForSelector(SCROLL_SEL, { timeout: 10_000 });

	// Install a tall initial spacer so the scroll container has overflow.
	await page.evaluate(() => {
		const ai = document.querySelector("agent-interface");
		const content = ai?.querySelector(".max-w-5xl") as HTMLElement | null;
		if (!content) throw new Error("messages content container not found");
		const spacer = document.createElement("div");
		spacer.id = "__tail_chat_spacer";
		spacer.style.height = "4000px";
		spacer.style.background = "linear-gradient(#eef, #fee)";
		content.appendChild(spacer);
	});

	// Wait for the ResizeObserver to observe the growth and let Lit settle.
	await page.evaluate(() => new Promise<void>((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
	}));

	// Snap to bottom and seed the programmatic-scroll echo latch so the
	// consequent native scroll event is consumed as an echo and doesn't flip
	// `_stickToBottom`. On the post-fix build the latch is a ring buffer
	// (`_programmaticEchoes`); on master it's a single pair of scalars
	// (`_lastProgrammaticScrollTop`/`Height`). Seed whichever surface exists.
	await page.evaluate((sel) => {
		const ai = document.querySelector("agent-interface") as any;
		const el = document.querySelector(sel) as HTMLElement;
		el.scrollTop = el.scrollHeight;
		const top = el.scrollHeight - el.clientHeight;
		const height = el.scrollHeight;
		if (Array.isArray(ai._programmaticEchoes)) {
			ai._programmaticEchoes.push({ top, height });
		} else {
			ai._lastProgrammaticScrollTop = top;
			ai._lastProgrammaticScrollHeight = height;
		}
		ai._stickToBottom = true;
		// Cancel the legacy settle window so steady-state behaviour runs. The
		// redesign removes the settle window entirely; on the post-fix build
		// this field doesn't exist and the assignment is harmless.
		if ("_settleWindowActive" in ai) ai._settleWindowActive = false;
		el.dispatchEvent(new Event("scroll"));
	}, SCROLL_SEL);

	// Confirm the precondition: stickToBottom and at-bottom.
	const pre = await page.evaluate((sel) => {
		const ai = document.querySelector("agent-interface") as any;
		const el = document.querySelector(sel) as HTMLElement;
		return {
			stick: ai._stickToBottom,
			distance: el.scrollHeight - el.scrollTop - el.clientHeight,
		};
	}, SCROLL_SEL);
	expect(pre.stick, "precondition: _stickToBottom must be true").toBe(true);
	expect(pre.distance, "precondition: viewport must start at bottom").toBeLessThanOrEqual(4);

	return { scrollSel: SCROLL_SEL };
}

/**
 * Grow the content container by `pxHeight` pixels. Returns the post-growth
 * scroll metrics. Awaits two rAFs so any ResizeObserver tick fires.
 */
export async function growContent(page: Page, pxHeight: number): Promise<{
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	stick: boolean;
}> {
	return await page.evaluate(async ({ scrollSel, h }) => {
		const ai = document.querySelector("agent-interface") as any;
		const content = ai?.querySelector(".max-w-5xl") as HTMLElement | null;
		if (!content) throw new Error("messages content container not found");
		const node = document.createElement("div");
		node.className = "__tail_chat_growth";
		node.style.height = `${h}px`;
		node.style.background = "rgba(0,0,0,0.04)";
		node.style.borderTop = "1px dashed #888";
		content.appendChild(node);
		await new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		});
		const el = document.querySelector(scrollSel) as HTMLElement;
		return {
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
			stick: ai._stickToBottom,
		};
	}, { scrollSel: SCROLL_SEL, h: pxHeight });
}

/**
 * Dispatch a synthetic scroll event whose (scrollTop, scrollHeight) pair does
 * NOT match the echo latch. This is exactly the race that the redesign
 * documents in Section 4 of the issue analysis: a stale browser-emitted scroll
 * event with old `scrollTop` arriving after a programmatic write has already
 * latched the *next* pair. On master, the geometry path at line 729 of
 * AgentInterface.ts then flips `_stickToBottom = false`. On the fixed build,
 * geometry never mutates the flag.
 *
 * Returns the post-dispatch `_stickToBottom` flag and viewport metrics.
 */
export async function injectStaleScrollEvent(page: Page): Promise<{
	stick: boolean;
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}> {
	return await page.evaluate((sel) => {
		const ai = document.querySelector("agent-interface") as any;
		const el = document.querySelector(sel) as HTMLElement;
		// Push scrollTop to a value that geometry would interpret as "well
		// above bottom" (> 10% of clientHeight away from the floor). Clear the
		// echo-latch so the event isn't filtered as an echo. This mimics a
		// queued browser scroll event that fires after we've already latched
		// the *next* programmatic write. Clear whichever echo surface exists.
		if (Array.isArray(ai._programmaticEchoes)) {
			ai._programmaticEchoes.length = 0;
		} else {
			ai._lastProgrammaticScrollTop = null;
			ai._lastProgrammaticScrollHeight = null;
		}
		const ch = el.clientHeight;
		const targetTop = Math.max(0, el.scrollHeight - ch - Math.ceil(ch * 0.5));
		el.scrollTop = targetTop;
		el.dispatchEvent(new Event("scroll"));
		return {
			stick: ai._stickToBottom,
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		};
	}, SCROLL_SEL);
}

/** Pixel tail used in pin assertions — matches the redesign's sub-pixel tolerance. */
export const TAIL_PX = 4;
