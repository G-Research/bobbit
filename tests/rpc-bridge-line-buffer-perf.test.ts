/**
 * PERF-02 — perf pin for RpcBridge.handleData()'s JSONL line scanner
 * (src/server/agent/rpc-bridge.ts).
 *
 * Audit finding: the old implementation appended every stdout chunk to
 * `lineBuffer` and then re-ran `lineBuffer.split("\n")` over the ENTIRE
 * accumulated buffer on every single chunk. A large JSONL line with no
 * interior newline (e.g. a multi-MB get_messages transcript or tool_result)
 * arrives as many ~64KiB chunks with no interior newline, so total scanning
 * work was Sigma O(bufLen) ~= O(len^2) on the single gateway event loop —
 * measured stalls: 1MB->0.48ms, 4MB->8.16ms, 16MB->188.9ms per-chunk, with
 * total cumulative work scaling quadratically with the line's size.
 *
 * This test doesn't assert brittle absolute millisecond numbers, and — after
 * a 2026-07-05 flake fix — it doesn't assert WALL-CLOCK numbers at all.
 * wall-clock (`performance.now()`) measures queue-wait time as well as
 * execution time: under shared-host / concurrent-suite load, this process
 * can be descheduled mid-run for a slice that lands disproportionately in
 * either the "small" or "large" trial, inflating the small/large ratio past
 * a fixed threshold with a probability that scales with host contention (a
 * base flake, same shape as the VER-07 and EXT-04 fixes — see
 * tests/verification-harness-parallel-reviews.test.ts and
 * tests/lifecycle-hub.test.ts). The real invariant under test — "the line
 * scanner does O(N) work, not O(N^2)" — is a statement about CPU WORK done,
 * not about how long the OS took to schedule that work. `process.cpuUsage()`
 * (already used for the same reason in
 * src/server/agent/cpu-diagnostics.ts) measures only CPU time actually
 * consumed by this process (user+system), so it is immune to scheduler
 * contention/preemption: a competing process stealing wall-clock time from
 * us does not add to OUR cpuUsage delta. Quadrupling the input size should
 * still roughly quadruple the CPU work (linear), not multiply it by ~16
 * (quadratic) — see the ratio assertion below for the exact threshold and
 * why it comfortably separates the two shapes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcBridge } from "../src/server/agent/rpc-bridge.ts";

const CHUNK_SIZE = 64 * 1024; // mirrors the real stdout chunk size from the audit

/** Feed one giant single-line JSONL frame (no interior "\n") through the
 *  real RpcBridge line scanner in CHUNK_SIZE pieces, and measure the total
 *  CPU time (user+system, ms) consumed by all the handleData() calls it
 *  takes. CPU time — unlike wall-clock — does not include time spent
 *  descheduled/waiting for the scheduler, so it is immune to contention from
 *  other processes on a shared/loaded host. */
function cpuTimeProcessSingleHugeLine(totalBytes: number): number {
	const bridge: any = new RpcBridge({});
	bridge.onEvent(() => { /* no-op — still exercises the dispatch path once at the end */ });

	const prefix = '{"type":"marker","payload":"';
	const suffix = '"}\n';
	const payloadLen = Math.max(0, totalBytes - prefix.length - suffix.length);
	const line = prefix + "x".repeat(payloadLen) + suffix;

	const startUsage = process.cpuUsage();
	for (let i = 0; i < line.length; i += CHUNK_SIZE) {
		bridge.handleData(line.slice(i, i + CHUNK_SIZE));
	}
	const delta = process.cpuUsage(startUsage);
	return (delta.user + delta.system) / 1000; // microseconds -> ms
}

/** Best-of-N to damp GC/scheduler noise on shared CI hosts. */
function bestOf(totalBytes: number, n = 3): number {
	let best = Infinity;
	for (let i = 0; i < n; i++) best = Math.min(best, cpuTimeProcessSingleHugeLine(totalBytes));
	return best;
}

test("a multi-MB single-line JSONL frame scales ~linearly with size, not quadratically", () => {
	// Warm up the JIT so the first real measurement isn't penalized by cold compilation.
	cpuTimeProcessSingleHugeLine(512 * 1024);

	const small = 4 * 1024 * 1024; // audit measured this at 8.16ms per-chunk-stall on the old code
	const large = 16 * 1024 * 1024; // audit measured this at 188.9ms per-chunk-stall on the old code (~23x for 4x data)

	const tSmall = bestOf(small);
	const tLarge = bestOf(large);
	const ratio = tLarge / Math.max(tSmall, 0.05);

	// Linear (O(N)) scaling gives a ratio of ~4 for a 4x data increase.
	// Quadratic (O(N^2)) scaling — the old bug — gives a ratio of ~16-23
	// (matching the audit's measured 8.16ms -> 188.9ms, a ~23x jump for 4x
	// data). A threshold of 8 sits comfortably between the two shapes: it
	// has 2x headroom over ideal linear scaling to absorb machine noise,
	// while still being far below the quadratic signature.
	assert.ok(
		ratio < 8,
		`expected near-linear scaling (ratio < 8) for a 4x size increase, got ratio=${ratio.toFixed(2)} ` +
		`(small=${tSmall.toFixed(2)}ms @${(small / 1024 / 1024).toFixed(0)}MB, large=${tLarge.toFixed(2)}ms @${(large / 1024 / 1024).toFixed(0)}MB). ` +
		`This regresses to the PERF-02 quadratic accumulate-and-resplit bug if it fails.`,
	);
});

test("a multi-MB single-line JSONL frame processes well within a generous absolute ceiling", () => {
	// Secondary sanity check (not the primary pin — see the ratio test above).
	// The old algorithm's LAST chunk alone stalled ~188.9ms at 16MB per the
	// audit; total cumulative time across all chunks was necessarily larger
	// still. A linear scanner should clear 16MB in a small multiple of that,
	// so a generous 300ms CPU-time ceiling gives ample headroom for slow
	// hosts while still catching a regression to quadratic behavior. This is
	// CPU time (see cpuTimeProcessSingleHugeLine above), not wall-clock, so
	// it isn't inflated by scheduler contention on a busy/shared host.
	const totalMs = bestOf(16 * 1024 * 1024, 1);
	assert.ok(totalMs < 300, `expected 16MB single-line processing well under 300ms of CPU time, got ${totalMs.toFixed(2)}ms`);
});
