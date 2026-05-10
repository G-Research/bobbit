/**
 * Pure detectors over a recorded Timeline.
 *
 *   detectHangs(timeline, hangMs)
 *     - flags windows where session.status ∈ {streaming, pending, preparing}
 *       and neither messages.length nor the tail message's fingerprint
 *       changed for >= hangMs.
 *
 *   detectOutOfOrder(timeline)
 *     - flags ticks where DOM order disagrees with state order. Both arrays
 *       are aligned by fingerprint; any inversion is reported.
 *
 * Both push entries into `timeline.findings`.
 */

import type { Timeline, Finding, TickRecord } from "./types.ts";

const STREAMING_STATUSES = new Set(["streaming", "pending", "preparing", "starting"]);

export function detectHangs(timeline: Timeline, hangMs: number): void {
	let windowStart: TickRecord | null = null;
	let windowSig: string | null = null;
	let lastFlagged = -Infinity;

	for (let i = 0; i < timeline.ticks.length; i++) {
		const t = timeline.ticks[i];
		const status = t.session?.status ?? "";
		const sig = signature(t);
		const streaming = STREAMING_STATUSES.has(status);

		if (!streaming) {
			windowStart = null;
			windowSig = sig;
			continue;
		}

		if (windowStart == null || sig !== windowSig) {
			windowStart = t;
			windowSig = sig;
			continue;
		}

		const elapsed = t.t - windowStart.t;
		// Re-flag every hangMs to mark sustained hangs.
		if (elapsed >= hangMs && t.t - lastFlagged >= hangMs) {
			lastFlagged = t.t;
			timeline.findings.push({
				kind: "hang",
				atMs: t.t,
				tickIndex: i,
				detail: `agent status=${status} unchanged for ${elapsed}ms (signature=${sig})`,
				evidence: {
					windowStartTickT: windowStart.t,
					sessionId: t.session?.id,
					messageCount: t.session?.messages.length ?? 0,
				},
			});
		}
	}
}

export function detectOutOfOrder(timeline: Timeline): void {
	const seen = new Set<string>();
	for (let i = 0; i < timeline.ticks.length; i++) {
		const t = timeline.ticks[i];
		const finding = compareOrder(t);
		if (finding) {
			// Dedup repeats while the inversion persists.
			const key = finding.detail;
			if (seen.has(key)) continue;
			seen.add(key);
			timeline.findings.push({ ...finding, tickIndex: i, atMs: t.t });
		} else {
			seen.clear();
		}
	}
}

/** Match DOM rows to state rows by fingerprint; if positions differ, that's OOO. */
function compareOrder(t: TickRecord): Finding | null {
	const state = t.session?.messages ?? [];
	const dom = t.dom ?? [];
	if (state.length === 0 || dom.length === 0) return null;

	// Map fingerprint -> index in state (last write wins; OK for prototype).
	const stateIdx = new Map<string, number>();
	state.forEach((m, i) => stateIdx.set(m.fingerprint, i));

	// Walk DOM in order; build the corresponding state-index sequence
	// for fingerprints that exist in both.
	const seq: { dom: number; state: number; fp: string }[] = [];
	for (const d of dom) {
		const si = stateIdx.get(d.fingerprint);
		if (si == null) continue;
		seq.push({ dom: d.domIndex, state: si, fp: d.fingerprint });
	}
	if (seq.length < 2) return null;

	for (let i = 1; i < seq.length; i++) {
		if (seq[i].state < seq[i - 1].state) {
			return {
				kind: "out-of-order",
				atMs: t.t,
				tickIndex: -1,
				detail: `DOM row ${seq[i].dom} (state idx ${seq[i].state}) appears after DOM row ${seq[i - 1].dom} (state idx ${seq[i - 1].state})`,
				evidence: {
					sequence: seq.slice(Math.max(0, i - 2), i + 2),
					stateLen: state.length,
					domLen: dom.length,
				},
			};
		}
	}
	return null;
}

function signature(t: TickRecord): string {
	const msgs = t.session?.messages ?? [];
	const tail = msgs[msgs.length - 1];
	return `${msgs.length}|${tail ? tail.fingerprint : "-"}`;
}
