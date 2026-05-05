/**
 * Shared helpers for tail-chat-* E2E tests.
 *
 * Outcome-only assertions: `expectLatestMessagePinned` reads ONLY
 * `getBoundingClientRect()` and public scroll metrics — never private
 * fields like `_stickToBottom`, `_programmaticEchoes`, `_settleWindowActive`,
 * etc. This is what the user actually sees, and survives scroll-mechanism
 * refactors.
 *
 * `disableScrollAnchoring` cascades `overflow-anchor: none` to every
 * descendant of the chat scroll container so Chromium ≡ Safari inside the
 * test scope, forcing the JS pin path to be the single contract.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const SCROLL_SEL = "agent-interface .overflow-y-auto";

/** Pixel tail used in pin assertions — sub-pixel tolerance. */
export const TAIL_PX = 4;

/** Selector matching all rendered chat-message DOM nodes. */
export const MESSAGE_SEL = "user-message, assistant-message, tool-message";

/**
 * Disable CSS scroll-anchoring on the chat scroll container (and every
 * descendant) inside the test scope. Mirrors Safari (where
 * `overflow-anchor` has limited availability) and forces the JS pin path
 * (`_pinIfSticking` + RO `delta>0`) to be the single contract. Without
 * this, Chromium's default `overflow-anchor: auto` transparently pins the
 * viewport even when the JS path is broken — masking real regressions.
 *
 * Production now also sets `overflow-anchor: none` on the scroll
 * container itself; this helper additionally cascades the rule to every
 * descendant so any nested `overflow-anchor: auto` reset is also
 * disabled. Idempotent — safe to call more than once per page.
 */
export async function disableScrollAnchoring(page: Page): Promise<void> {
	await page.addStyleTag({
		content: `agent-interface .overflow-y-auto, agent-interface .overflow-y-auto * { overflow-anchor: none !important; }`,
	});
}

/**
 * Outcome assertion: the user is at the tail of the chat AND the latest
 * rendered message is fully visible (its bottom is not below the fold).
 *
 * Reads ONLY `getBoundingClientRect()` and public scroll metrics — NEVER
 * private fields like `_stickToBottom`, `_programmaticEchoes`, or any of
 * the deleted-defense surfaces. This is what the user actually sees.
 *
 * Two checks (both must hold within `tailPx`):
 *   1. `scrollHeight - scrollTop - clientHeight <= tailPx`    (pinned)
 *   2. `lastMessageBottom - viewportBottom <= tailPx`         (not cut off)
 *
 * Note: a fully-pinned latest message can sit ABOVE the viewport bottom
 * (the scroll container has padding-bottom underneath the last message);
 * we only fail if it sits BELOW — which is the canonical "tail-chat lost"
 * symptom users report.
 */
export async function expectLatestMessagePinned(
	page: Page,
	opts: { tailPx?: number; label?: string } = {},
): Promise<void> {
	const tailPx = opts.tailPx ?? 8;
	const label = opts.label ? ` [${opts.label}]` : "";
	const probe = await page.evaluate(({ scrollSel, msgSel }) => {
		const el = document.querySelector(scrollSel) as HTMLElement | null;
		if (!el) return { error: "scroll container not found" } as const;
		const msgs = Array.from(document.querySelectorAll(msgSel)) as HTMLElement[];
		if (msgs.length === 0) return { error: "no message DOM nodes" } as const;
		const last = msgs[msgs.length - 1];
		const elRect = el.getBoundingClientRect();
		const lastRect = last.getBoundingClientRect();
		return {
			viewportBottom: elRect.bottom,
			lastBottom: lastRect.bottom,
			lastTag: last.tagName.toLowerCase(),
			lastHeight: lastRect.height,
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
			msgCount: msgs.length,
		} as const;
	}, { scrollSel: SCROLL_SEL, msgSel: MESSAGE_SEL });
	if ("error" in probe) {
		throw new Error(`expectLatestMessagePinned${label}: ${probe.error}`);
	}
	const pinDist = probe.scrollHeight - probe.scrollTop - probe.clientHeight;
	// belowFold > 0 means the latest message extends below the visible
	// viewport (the canonical "tail-chat lost" regression). Negative or zero
	// means the message bottom is at or above the viewport bottom — fine,
	// the scroll container can have padding-bottom underneath it.
	const belowFold = probe.lastBottom - probe.viewportBottom;
	expect(
		pinDist,
		`expectLatestMessagePinned${label}: scroll viewport not pinned to bottom; ` +
		`distFromScrollBottom=${Math.round(pinDist)} (>${tailPx}). ` +
		`scrollTop=${Math.round(probe.scrollTop)} scrollHeight=${probe.scrollHeight} ` +
		`clientHeight=${probe.clientHeight} msgCount=${probe.msgCount}`,
	).toBeLessThanOrEqual(tailPx);
	expect(
		belowFold,
		`expectLatestMessagePinned${label}: latest-message bottom ${Math.round(belowFold)} px ` +
		`BELOW viewport bottom — message is cut off (>${tailPx}). last=<${probe.lastTag}> ` +
		`lastHeight=${Math.round(probe.lastHeight)} ` +
		`scrollTop=${Math.round(probe.scrollTop)} scrollHeight=${probe.scrollHeight} ` +
		`clientHeight=${probe.clientHeight} msgCount=${probe.msgCount}`,
	).toBeLessThanOrEqual(tailPx);
}
