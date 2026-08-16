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
	/** Positive layout growth that triggered a phase observation, when applicable. */
	growth?: number;
}

export interface TailSample {
	t: number;
	distance: number;
	clientHeight: number;
	scrollHeight: number;
	scrollTop: number;
	/** Positive scroll-height delta since the preceding settled sample. */
	growth: number;
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

/**
 * Register phase observation before dispatching a stream. Phase labels are
 * transient protocol output, so waiting for them one by one after dispatch can
 * miss the first marker entirely. Mutation observation records each named
 * marker at commit time and reads public scroll geometry two animation frames
 * later — the same settled lifecycle used by the production re-pin path.
 */
export async function startTailPhaseTracker(page: Page, key: string, markers: string[], tailPx = TAIL_PX): Promise<void> {
	if (new Set(markers).size !== markers.length) {
		throw new Error("tail phase tracker: expected markers must be unique");
	}
	await page.evaluate(({ scrollSel, trackerKey, phaseMarkers, pinnedTailPx }) => {
		const w = window as any;
		w[trackerKey]?.disconnect?.();
		const el = document.querySelector(scrollSel) as HTMLElement | null;
		const content = el?.querySelector(".max-w-5xl") as HTMLElement | null;
		if (!el || !content) throw new Error("tail phase tracker: chat content container not found");

		const expected = new Set(phaseMarkers);
		const expectedIndex = new Map(phaseMarkers.map((marker, index) => [marker, index]));
		// Marker delivery and layout settlement are independent browser phases.
		// Queue markers in protocol order, then publish one later settled geometry
		// per marker so a fast later stream frame cannot overwrite the earlier
		// phase's proof.
		const pending = new Map<string, number>();
		const evidence = new Map<string, ScrollProbe>();
		const waiters = new Map<string, Array<{ resolve: (sample: ScrollProbe) => void; reject: (reason: Error) => void }>>();
		const markerEventIds = new Map<string, string>();
		const markerOccurrences = new Map<string, number>();
		const pendingDomEchoes = new Set<string>();
		let visibleMarkers = new Set<string>();
		let nextExpectedMarkerIndex = 0;
		let lastEvidenceHeight = el.scrollHeight;
		let failure: Error | null = null;
		let active = true;
		let framePending = false;

		const fail = (message: string) => {
			if (failure) return;
			failure = new Error(`tail phase tracker: ${message}`);
			for (const pendingWaiters of waiters.values()) {
				for (const waiter of pendingWaiters) waiter.reject(failure);
			}
			waiters.clear();
		};
		const exactMarkers = (text: string): Set<string> => {
			const found = new Set<string>();
			for (const match of text.matchAll(/(?:^|[^A-Z0-9_-])((?:PRE|POST)-WAIT-CHUNK-\d+#30)(?![A-Z0-9_-])/g)) {
				found.add(match[1]);
			}
			return found;
		};
		const textAtMutation = (): string => {
			const fromMessages = Array.from(document.querySelectorAll("assistant-message"))
				.map((node) => JSON.stringify((node as any).message ?? ""))
				.join(" ");
			const remote = w.bobbitState?.remoteAgent ?? w.__bobbitState?.remoteAgent;
			return `${content.textContent ?? ""} ${fromMessages} ${JSON.stringify(remote?.state?.streamingMessage ?? "")}`;
		};
		const detectMarkers = (text: string, fromDom: boolean, eventId?: string) => {
			const found = exactMarkers(text);
			for (const marker of found) {
				if (!expected.has(marker)) fail(`unexpected exact marker ${marker}`);
			}
			for (const marker of expected) {
				if (!found.has(marker) || (fromDom && visibleMarkers.has(marker))) continue;
				if (pending.has(marker) || evidence.has(marker)) {
					if (eventId && markerEventIds.get(marker) === eventId) continue;
					if (fromDom && pendingDomEchoes.delete(marker)) continue;
					fail(`duplicate exact marker ${marker}`);
					continue;
				}
				const index = expectedIndex.get(marker)!;
				if (index !== nextExpectedMarkerIndex) {
					fail(`marker ${marker} arrived out of protocol order; expected ${phaseMarkers[nextExpectedMarkerIndex] ?? "no further marker"}`);
					continue;
				}
				nextExpectedMarkerIndex++;
				if (eventId) {
					markerEventIds.set(marker, eventId);
					pendingDomEchoes.add(marker);
				}
				markerOccurrences.set(marker, (markerOccurrences.get(marker) ?? 0) + 1);
				// The exact marker is captured at its commit. Its proof must be a
				// later, positive, post-repin height that no earlier phase used.
				pending.set(marker, el.scrollHeight);
			}
			if (fromDom) visibleMarkers = found;
		};
		const detectMarkersAtCommit = () => detectMarkers(textAtMutation(), true);
		const publishSettledEvidence = () => {
			// Consume only the head of the protocol queue. Multiple markers can arrive
			// before the browser completes two re-pin frames; letting them share this
			// geometry would either reject a valid fast stream or falsely give both
			// phases one height. The next mutation/resize/scroll settles the next phase.
			const next = pending.entries().next().value as [string, number] | undefined;
			if (!next) return;
			const [marker, heightAtMarker] = next;
			const growth = el.scrollHeight - heightAtMarker;
			const sample = {
				overflow: el.scrollHeight - el.clientHeight,
				distance: el.scrollHeight - el.scrollTop - el.clientHeight,
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				growth,
			};
			if (growth <= 0 || sample.distance > pinnedTailPx) return;
			if (sample.scrollHeight <= lastEvidenceHeight) {
				fail(`marker ${marker} reused or regressed settled height ${sample.scrollHeight} (previous ${lastEvidenceHeight})`);
				return;
			}
			lastEvidenceHeight = sample.scrollHeight;
			pending.delete(marker);
			evidence.set(marker, sample);
			for (const waiter of waiters.get(marker) ?? []) waiter.resolve(sample);
			waiters.delete(marker);
		};
		const settle = () => {
			if (!active || framePending) return;
			framePending = true;
			requestAnimationFrame(() => requestAnimationFrame(() => {
				framePending = false;
				if (active) publishSettledEvidence();
			}));
		};
		// The observer sees transient marker-bearing streaming state at mutation
		// commit time. Resize and scroll are independent production events used to
		// retain only that marker's post-repin positive-growth geometry.
		const mutations = new MutationObserver(() => {
			detectMarkersAtCommit();
			settle();
		});
		mutations.observe(content, { childList: true, subtree: true, characterData: true });
		const resize = new ResizeObserver(settle);
		resize.observe(content);
		el.addEventListener("scroll", settle);
		// AssistantMessage throttles DOM text updates, so the final #30 token can
		// be superseded before it reaches a text node. Observe the already-open
		// RemoteAgent event stream as well; this is registered before send and
		// feeds the same exact-marker state machine as the MutationObserver.
		const remote = w.bobbitState?.remoteAgent ?? w.__bobbitState?.remoteAgent;
		const originalHandleServerMessage = remote?.handleServerMessage;
		const wrappedHandleServerMessage = typeof originalHandleServerMessage === "function"
			? function(this: unknown, message: any) {
				// A settled full snapshot replaces reducer state; it is not another stream
				// occurrence. Let the strict DOM observer validate its rendered geometry,
				// while retaining duplicate detection for every real event frame.
				if (message?.type !== "messages") {
					const event = message?.data ?? message;
					const eventId = typeof event?.message?.id === "string" ? event.message.id : undefined;
					detectMarkers(JSON.stringify(message), false, eventId);
				}
				return originalHandleServerMessage.call(this, message);
			}
			: null;
		if (wrappedHandleServerMessage) remote.handleServerMessage = wrappedHandleServerMessage;
		w[trackerKey] = {
			waitFor: (marker: string) => {
				if (!expected.has(marker)) return Promise.reject(new Error(`tail phase tracker: unknown marker ${marker}`));
				if (failure) return Promise.reject(failure);
				return evidence.get(marker)
					?? new Promise<ScrollProbe>((resolve, reject) => {
						const pendingWaiters = waiters.get(marker) ?? [];
						pendingWaiters.push({ resolve, reject });
						waiters.set(marker, pendingWaiters);
					});
			},
			finish: () => {
				if (failure) throw failure;
				if (pending.size > 0) throw new Error(`tail phase tracker: unsettled marker ${pending.keys().next().value}`);
				for (const marker of phaseMarkers) {
					if (markerOccurrences.get(marker) !== 1) {
						throw new Error(`tail phase tracker: expected one exact marker ${marker}, got ${markerOccurrences.get(marker) ?? 0}`);
					}
					if (!evidence.has(marker)) throw new Error(`tail phase tracker: no settled growth evidence for ${marker}`);
				}
				return phaseMarkers.map((marker) => evidence.get(marker)!);
			},
			disconnect: () => {
				active = false;
				mutations.disconnect();
				resize.disconnect();
				el.removeEventListener("scroll", settle);
				if (remote?.handleServerMessage === wrappedHandleServerMessage) {
					remote.handleServerMessage = originalHandleServerMessage;
				}
			},
		};
	}, { scrollSel: SCROLL_SEL, trackerKey: key, phaseMarkers: markers, pinnedTailPx: tailPx });
}

/** Retrieve pre-registered, settled evidence for a named stream milestone. */
export async function awaitTailGrowthPhase(page: Page, key: string, marker: string): Promise<ScrollProbe> {
	return await page.evaluate(async ({ trackerKey, phaseMarker }) => {
		const tracker = (window as any)[trackerKey];
		if (!tracker) throw new Error(`tail phase tracker ${trackerKey} was not registered`);
		return await tracker.waitFor(phaseMarker);
	}, { trackerKey: key, phaseMarker: marker });
}

/** Stop the tracker only after every exact marker has one ordered, distinct proof. */
export async function stopTailPhaseTracker(page: Page, key: string): Promise<ScrollProbe[]> {
	return await page.evaluate((trackerKey) => {
		const w = window as any;
		const tracker = w[trackerKey];
		if (!tracker) throw new Error(`tail phase tracker ${trackerKey} was not registered`);
		try {
			return tracker.finish();
		} finally {
			tracker.disconnect();
			w[trackerKey] = null;
		}
	}, key);
}

/**
 * Observe real transcript growth and sample only after the render lifecycle
 * has let AgentInterface's ResizeObserver re-pin the scroll container.
 *
 * A wall-clock interval can land between a DOM mutation and the next render
 * frame, treating that intentional transient as a user-visible regression.
 * MutationObserver catches transcript commits, ResizeObserver catches layout
 * growth which has no DOM mutation (for example deferred content hydration),
 * and two rAFs put the sample after the production re-pin frame. Samples are
 * therefore assertions about every *settled* observable growth state, not
 * arbitrary points in time.
 */
export async function startTailSampler(page: Page, key: string, tailPx = TAIL_PX): Promise<void> {
	await page.evaluate(({ scrollSel, sampleKey, pinnedTailPx }) => {
		const w = window as any;
		const samplerKey = `${sampleKey}Sampler`;
		w[samplerKey]?.disconnect?.();

		const el = document.querySelector(scrollSel) as HTMLElement | null;
		const content = el?.querySelector(".max-w-5xl") as HTMLElement | null;
		if (!el || !content) throw new Error("tail sampler: chat content container not found");

		const start = performance.now();
		let lastSettledHeight = el.scrollHeight;
		let framePending = false;
		let settleVersion = 0;
		let active = true;
		w[sampleKey] = [];

		const recordSettledGrowth = () => {
			const current = el.scrollHeight;
			const growth = current - lastSettledHeight;
			if (growth <= 0) {
				// A shrink resets the comparison point but is not a stream-growth
				// sample. A later grow is still measured from this settled geometry.
				lastSettledHeight = current;
				return;
			}
			const distance = current - el.scrollTop - el.clientHeight;
			if (distance > pinnedTailPx) {
				// Keep the same baseline until the matching follow-tail scroll lands.
				// Discarding this observation would hide a real drift; publishing it
				// now would call an intermediate layout a settled user-visible state.
				return;
			}
			lastSettledHeight = current;
			w[sampleKey].push({
				t: Math.round(performance.now() - start),
				scrollTop: el.scrollTop,
				scrollHeight: current,
				clientHeight: el.clientHeight,
				growth,
			});
		};

		const sampleAfterRepinFrames = () => {
			if (!active) return;
			const observedVersion = ++settleVersion;
			if (framePending) return;
			framePending = true;
			const waitForLatestGrowth = (version: number) => {
				requestAnimationFrame(() => requestAnimationFrame(() => {
					if (!active) {
						framePending = false;
						return;
					}
					// More transcript/layout growth or its programmatic follow-tail
					// scroll can arrive while the two-frame boundary is pending.
					// Restart at that latest lifecycle event rather than publishing
					// its intermediate geometry.
					if (version !== settleVersion) {
						waitForLatestGrowth(settleVersion);
						return;
					}
					framePending = false;
					recordSettledGrowth();
				}));
			};
			waitForLatestGrowth(observedVersion);
		};

		const mutations = new MutationObserver(sampleAfterRepinFrames);
		mutations.observe(content, { childList: true, subtree: true, characterData: true });
		const growth = new ResizeObserver(sampleAfterRepinFrames);
		growth.observe(content);
		// A transcript resize and AgentInterface's programmatic scroll are separate
		// browser events. Retain a pending positive delta until this follow-tail
		// event has completed its own two-frame lifecycle.
		el.addEventListener("scroll", sampleAfterRepinFrames);

		w[samplerKey] = {
			disconnect: () => {
				active = false;
				mutations.disconnect();
				growth.disconnect();
				el.removeEventListener("scroll", sampleAfterRepinFrames);
			},
			flush: () => new Promise<void>((resolve) => {
				// Stop observing first so this flush is a stable final state, then
				// wait through the same production re-pin lifecycle as ordinary
				// samples before reading public scroll geometry.
				active = false;
				mutations.disconnect();
				growth.disconnect();
				el.removeEventListener("scroll", sampleAfterRepinFrames);
				requestAnimationFrame(() => requestAnimationFrame(() => {
					recordSettledGrowth();
					resolve();
				}));
			}),
		};
	}, { scrollSel: SCROLL_SEL, sampleKey: key, pinnedTailPx: tailPx });
}

export async function stopTailSampler(page: Page, key: string): Promise<TailSample[]> {
	const rawSamples = await page.evaluate(async (sampleKey) => {
		const w = window as any;
		const samplerKey = `${sampleKey}Sampler`;
		await w[samplerKey]?.flush?.();
		w[samplerKey] = null;
		return (w[sampleKey] || []) as Array<{
			t: number;
			scrollTop: number;
			scrollHeight: number;
			clientHeight: number;
			growth: number;
		}>;
	}, key);
	return rawSamples.map((s) => ({
		t: s.t,
		distance: s.scrollHeight - s.scrollTop - s.clientHeight,
		clientHeight: s.clientHeight,
		scrollHeight: s.scrollHeight,
		scrollTop: s.scrollTop,
		growth: s.growth,
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
