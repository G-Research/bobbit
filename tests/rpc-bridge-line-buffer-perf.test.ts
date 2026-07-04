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
 * This test doesn't assert brittle absolute millisecond numbers (which would
 * flake on slow/loaded CI hosts). Instead it asserts the SHAPE of the
 * scaling: processing a single huge line delivered in fixed-size chunks
 * must take roughly linear time in the line's size. Quadrupling the input
 * size should roughly quadruple the time (linear), not multiply it by ~16
 * (quadratic) — see the ratio assertion below for the exact threshold and
 * why it comfortably separates the two shapes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { RpcBridge } from "../src/server/agent/rpc-bridge.ts";

const CHUNK_SIZE = 64 * 1024; // mirrors the real stdout chunk size from the audit

/** Feed one giant single-line JSONL frame (no interior "\n") through the
 *  real RpcBridge line scanner in CHUNK_SIZE pieces, and time the total
 *  wall-clock cost of all the handleData() calls it takes. */
function timeProcessSingleHugeLine(totalBytes: number): number {
	const bridge: any = new RpcBridge({});
	bridge.onEvent(() => { /* no-op — still exercises the dispatch path once at the end */ });

	const prefix = '{"type":"marker","payload":"';
	const suffix = '"}\n';
	const payloadLen = Math.max(0, totalBytes - prefix.length - suffix.length);
	const line = prefix + "x".repeat(payloadLen) + suffix;

	const start = performance.now();
	for (let i = 0; i < line.length; i += CHUNK_SIZE) {
		bridge.handleData(line.slice(i, i + CHUNK_SIZE));
	}
	return performance.now() - start;
}

/** Best-of-N to damp GC/scheduler noise on shared CI hosts. */
function bestOf(totalBytes: number, n = 3): number {
	let best = Infinity;
	for (let i = 0; i < n; i++) best = Math.min(best, timeProcessSingleHugeLine(totalBytes));
	return best;
}

test("a multi-MB single-line JSONL frame scales ~linearly with size, not quadratically", () => {
	// Warm up the JIT so the first real measurement isn't penalized by cold compilation.
	timeProcessSingleHugeLine(512 * 1024);

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
	// so a generous 300ms ceiling gives ample headroom for slow CI hosts
	// while still catching a regression to quadratic behavior.
	const totalMs = bestOf(16 * 1024 * 1024, 1);
	assert.ok(totalMs < 300, `expected 16MB single-line processing well under 300ms, got ${totalMs.toFixed(2)}ms`);
});
