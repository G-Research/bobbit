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
import { agentEndPredicate, base, connectWs, readE2ETokenAsync, waitForSessionStatus } from "../e2e-setup.js";

export const SCROLL_SEL = "agent-interface .overflow-y-auto";

/** Pixel tail used in pin assertions — sub-pixel tolerance. */
export const TAIL_PX = 4;

/** Selector matching all rendered chat-message DOM nodes. */
export const MESSAGE_SEL = "user-message, assistant-message, tool-message";

export interface ScrollProbe {
	overflow: number;
	distance: number;
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

export interface TailSample {
	t: number;
	distance: number;
	clientHeight: number;
	scrollHeight: number;
	scrollTop: number;
}

export interface MessageFingerprint {
	role: string;
	fp: string;
}

/** Wait for Lit updates / ResizeObserver-triggered rAF pinning to settle. */
export async function settleFrames(page: Page, frames = 2): Promise<void> {
	await page.evaluate((n) => new Promise<void>((resolve) => {
		const step = (remaining: number) => {
			if (remaining <= 0) resolve();
			else requestAnimationFrame(() => step(remaining - 1));
		};
		step(n);
	}), frames);
}

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

/** Open the app directly on a session route and wait for chat readiness. */
export async function openTailSession(page: Page, sessionId: string): Promise<void> {
	const token = await readE2ETokenAsync();
	await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await page.waitForSelector(SCROLL_SEL, { timeout: 10_000 });
}

/** Navigate an already-open app to a session and wait for chat readiness. */
export async function navigateToTailSession(page: Page, sessionId: string): Promise<void> {
	await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
	await page.waitForSelector(SCROLL_SEL, { timeout: 10_000 });
}

/** Add a tall spacer above transcript content and snap the chat to bottom. */
export async function installPreStreamSpacer(page: Page, heightPx = 5000): Promise<ScrollProbe> {
	await page.evaluate(({ scrollSel, height }) => {
		const content = document.querySelector("agent-interface .max-w-5xl") as HTMLElement | null;
		if (!content) throw new Error("messages content container not found");
		let spacer = content.querySelector("#__tail_chat_pre_spacer") as HTMLElement | null;
		if (!spacer) {
			spacer = document.createElement("div");
			spacer.id = "__tail_chat_pre_spacer";
			spacer.style.background = "linear-gradient(#eef, #fee)";
			content.insertBefore(spacer, content.firstChild);
		}
		spacer.style.height = `${height}px`;
		const el = document.querySelector(scrollSel) as HTMLElement | null;
		if (!el) throw new Error("scroll container not found");
		el.scrollTop = el.scrollHeight;
	}, { scrollSel: SCROLL_SEL, height: heightPx });
	await settleFrames(page);
	const pre = await measureScroll(page);
	expect(pre.overflow, `pre: scroll container must have overflow`).toBeGreaterThan(heightPx / 2);
	expect(pre.distance, `pre: must start at bottom`).toBeLessThanOrEqual(TAIL_PX);
	return pre;
}

export async function measureScroll(page: Page): Promise<ScrollProbe> {
	return await page.evaluate((sel) => {
		const el = document.querySelector(sel) as HTMLElement;
		return {
			overflow: el.scrollHeight - el.clientHeight,
			distance: el.scrollHeight - el.scrollTop - el.clientHeight,
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		};
	}, SCROLL_SEL);
}

/** In-page sampler used by full-stack streaming specs. */
export async function startTailSampler(page: Page, key: string): Promise<void> {
	await page.evaluate(({ scrollSel, sampleKey }) => {
		const w = window as any;
		const intervalKey = `${sampleKey}Interval`;
		if (w[intervalKey]) clearInterval(w[intervalKey]);
		w[sampleKey] = [];
		const start = performance.now();
		w[intervalKey] = setInterval(() => {
			const el = document.querySelector(scrollSel) as HTMLElement | null;
			if (!el) return;
			w[sampleKey].push({
				t: Math.round(performance.now() - start),
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
			});
		}, 250);
	}, { scrollSel: SCROLL_SEL, sampleKey: key });
}

export async function stopTailSampler(page: Page, key: string): Promise<TailSample[]> {
	const rawSamples = await page.evaluate((sampleKey) => {
		const w = window as any;
		const intervalKey = `${sampleKey}Interval`;
		if (w[intervalKey]) clearInterval(w[intervalKey]);
		w[intervalKey] = null;
		return (w[sampleKey] || []) as Array<{
			t: number;
			scrollTop: number;
			scrollHeight: number;
			clientHeight: number;
		}>;
	}, key);
	return rawSamples.map((s) => ({
		t: s.t,
		distance: s.scrollHeight - s.scrollTop - s.clientHeight,
		clientHeight: s.clientHeight,
		scrollHeight: s.scrollHeight,
		scrollTop: s.scrollTop,
	}));
}

export async function waitForBurstDone(page: Page, cycles: number, timeoutMs = 60_000): Promise<void> {
	const doneToken = `STREAM_BURST_DONE:${cycles}`;
	await page.waitForFunction((token) => {
		const ai = document.querySelector("agent-interface");
		const content = ai?.querySelector(".max-w-5xl");
		return !!content && (content.textContent || "").includes(token);
	}, doneToken, { timeout: timeoutMs });
}

/** Seed a session transcript without spending browser time rendering the stream live. */
export async function seedSessionViaWs(sessionId: string, text: string, timeoutMs = 45_000): Promise<void> {
	const conn = await connectWs(sessionId);
	try {
		const cursor = conn.messageCount();
		conn.send({ type: "prompt", text });
		await conn.waitForFrom(cursor, agentEndPredicate(), timeoutMs);
		await waitForSessionStatus(sessionId, "idle");
	} finally {
		conn.close();
	}
}

/**
 * Walk the rendered transcript in DOM order and produce a stable fingerprint.
 * Dynamic timer text is normalized so live and post-refresh snapshots compare
 * on transcript shape/content rather than elapsed seconds.
 */
export async function snapshotMessages(page: Page): Promise<MessageFingerprint[]> {
	await page.evaluate(async () => {
		const DB = (window as unknown as { DeferredBlock?: { forceResolveAll: () => void; instances: Set<HTMLElement & { updateComplete?: Promise<unknown> }> } }).DeferredBlock;
		if (!DB) return;
		DB.forceResolveAll();
		await Promise.all(Array.from(DB.instances).map((inst) => inst.updateComplete ?? Promise.resolve()));
	});
	await settleFrames(page, 1);
	return await page.evaluate((msgSel) => {
		const nodes = Array.from(document.querySelectorAll(msgSel)) as HTMLElement[];
		const stripDynamic = (text: string): string => text
			.replace(/\b\d+s\b/g, "Xs")
			// Proposal cards can hydrate their full spec text asynchronously; live and
			// post-refresh snapshots may legitimately differ on that expanded detail.
			.replace(/\s*proposal #\d+ in stream burst\s*/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return nodes.map((el) => {
			const role = el.tagName.toLowerCase();
			const raw = el.textContent || "";
			const norm = stripDynamic(raw);
			return { role, fp: `${role}|${norm}|${norm.length}` };
		});
	}, MESSAGE_SEL);
}

export function assertTranscriptSnapshotsEqual(liveSnap: MessageFingerprint[], refreshSnap: MessageFingerprint[]): void {
	if (liveSnap.length !== refreshSnap.length) {
		const dump = (label: string, snap: MessageFingerprint[]): string =>
			`${label} (${snap.length}):\n` + snap.map((m, i) => `  [${i}] ${m.fp.slice(0, 120)}`).join("\n");
		throw new Error(
			`Transcript fidelity broken: live count ≠ post-refresh count.\n` +
			`${dump("LIVE", liveSnap)}\n${dump("REFRESH", refreshSnap)}`,
		);
	}

	const countOccurrences = (snap: MessageFingerprint[]): Map<string, number> => {
		const counts = new Map<string, number>();
		for (const m of snap) counts.set(m.fp, (counts.get(m.fp) || 0) + 1);
		return counts;
	};
	for (const [fp, n] of countOccurrences(liveSnap)) {
		if (n > 1) throw new Error(`Live duplicate (×${n}): ${fp.slice(0, 200)}`);
	}
	for (const [fp, n] of countOccurrences(refreshSnap)) {
		if (n > 1) throw new Error(`Refresh duplicate (×${n}): ${fp.slice(0, 200)}`);
	}
	for (let i = 0; i < liveSnap.length; i++) {
		if (liveSnap[i].fp !== refreshSnap[i].fp) {
			throw new Error(
				`Transcript order mismatch at index ${i}.\n` +
				`  live:    ${liveSnap[i].fp.slice(0, 200)}\n` +
				`  refresh: ${refreshSnap[i].fp.slice(0, 200)}`,
			);
		}
	}
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
