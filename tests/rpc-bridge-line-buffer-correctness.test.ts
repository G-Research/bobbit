/**
 * PERF-02 — correctness pin for the incremental JSONL line scanner in
 * RpcBridge.handleData()/processLine() (src/server/agent/rpc-bridge.ts).
 *
 * The old implementation appended every stdout chunk to `lineBuffer` and
 * re-ran `lineBuffer.split("\n")` over the WHOLE accumulated buffer on every
 * chunk — O(N^2) total scanning work for a single large line spread across
 * many chunks (see rpc-bridge-line-buffer-perf.test.ts for the timing pin).
 * The fix replaces this with an incremental indexOf-based scan that only
 * looks at newly-appended bytes.
 *
 * This file pins that the new scanner produces IDENTICAL line extraction to
 * the naive reference algorithm across the framing edge cases that matter:
 * a single huge line split across many arbitrarily-sized chunks (including
 * cuts inside multi-byte-looking content and zero-length chunks), many
 * lines packed into one chunk, lines that straddle a chunk boundary exactly
 * at the newline, empty lines, and \r\n (CRLF) line endings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcBridge } from "../src/server/agent/rpc-bridge.ts";

/**
 * Reference implementation: the OLD accumulate-and-resplit algorithm that
 * handleData() used before the PERF-02 fix. Used here only to compute the
 * expected line list for a chunk sequence — the ground truth for framing
 * semantics (partial lines, multi-line chunks, \r\n, empty lines).
 */
function naiveLines(chunks: string[]): string[] {
	let buffer = "";
	const out: string[] = [];
	for (const chunk of chunks) {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop()!;
		for (const line of lines) {
			const trimmed = line.replace(/\r$/, "").trim();
			if (!trimmed) continue;
			out.push(trimmed);
		}
	}
	return out;
}

/** Drive the REAL RpcBridge line scanner with the same chunk sequence and
 *  collect the raw JSON text of every dispatched "marker" event, in order. */
function driveBridge(chunks: string[]): string[] {
	const bridge: any = new RpcBridge({});
	const seen: string[] = [];
	bridge.onEvent((e: any) => {
		if (e && e.type === "marker") seen.push(JSON.stringify({ type: e.type, seq: e.seq, payload: e.payload }));
	});
	for (const chunk of chunks) bridge.handleData(chunk);
	return seen;
}

/** Build `count` marker JSON lines (one object per line, no embedded "\n"). */
function markerLines(count: number, payload = ""): string[] {
	const lines: string[] = [];
	for (let i = 0; i < count; i++) {
		lines.push(JSON.stringify({ type: "marker", seq: i, payload }));
	}
	return lines;
}

/** Split a string into chunks at the given cut offsets (sorted, deduped, clamped). */
function chunkAt(text: string, cuts: number[]): string[] {
	const points = Array.from(new Set([0, ...cuts.filter(c => c >= 0 && c <= text.length), text.length])).sort((a, b) => a - b);
	const chunks: string[] = [];
	for (let i = 0; i < points.length - 1; i++) {
		chunks.push(text.slice(points[i], points[i + 1]));
	}
	return chunks;
}

function assertSameLines(label: string, chunks: string[]) {
	const expected = naiveLines(chunks);
	const actualBridge = driveBridge(chunks);
	// The naive reference and the bridge apply JSON.parse identically since
	// every expected line here is exact marker JSON, so re-serializing what
	// the bridge dispatched must reproduce the same trimmed line text.
	const actualAsLines = actualBridge.map(s => JSON.parse(s)).map(o => JSON.stringify({ type: o.type, seq: o.seq, payload: o.payload }));
	const expectedAsLines = expected.map(s => JSON.parse(s)).map(o => JSON.stringify({ type: o.type, seq: o.seq, payload: o.payload }));
	assert.deepEqual(actualAsLines, expectedAsLines, `[${label}] line extraction mismatch`);
}

test("one big line split across many byte-by-byte chunks", () => {
	const text = JSON.stringify({ type: "marker", seq: 0, payload: "x".repeat(5000) }) + "\n";
	const cuts: number[] = [];
	for (let i = 1; i < text.length; i += 7) cuts.push(i); // arbitrary, non-uniform cut cadence
	assertSameLines("byte-by-byte huge line", chunkAt(text, cuts));
});

test("many lines packed into a single chunk", () => {
	const text = markerLines(500).join("\n") + "\n";
	assertSameLines("many-lines-one-chunk", [text]);
});

test("many lines spread one-per-chunk", () => {
	const lines = markerLines(200);
	const chunks = lines.map(l => l + "\n");
	assertSameLines("one-line-per-chunk", chunks);
});

test("line boundary falls exactly on a chunk boundary", () => {
	const lines = markerLines(3);
	const text = lines.join("\n") + "\n";
	const firstNewline = text.indexOf("\n") + 1; // right after first line's \n
	assertSameLines("boundary-at-newline", chunkAt(text, [firstNewline]));
});

test("chunk containing a partial line, a full line, and the start of the next", () => {
	const lines = markerLines(4);
	const text = lines.join("\n") + "\n";
	// Cut mid-way through line 0, then mid-way through line 2.
	const cutA = Math.floor(lines[0].length / 2);
	const line1End = lines[0].length + 1 + lines[1].length + 1 + lines[2].length;
	const cutB = line1End - 3;
	assertSameLines("mixed-partial-full-partial", chunkAt(text, [cutA, cutB]));
});

test("empty lines (consecutive newlines) are skipped, matching naive trim+skip", () => {
	const lines = markerLines(3);
	const text = `${lines[0]}\n\n\n${lines[1]}\n   \n${lines[2]}\n`;
	assertSameLines("empty-lines", [text]);
	assertSameLines("empty-lines-chunked", chunkAt(text, [3, 10, 17, text.length - 4]));
});

test("CRLF (\\r\\n) line endings are stripped identically to the naive implementation", () => {
	const lines = markerLines(3);
	const text = lines.join("\r\n") + "\r\n";
	assertSameLines("crlf-one-chunk", [text]);
	// Split a chunk right between the \r and the \n of one line ending.
	const firstCrlf = text.indexOf("\r\n");
	assertSameLines("crlf-split-mid-terminator", chunkAt(text, [firstCrlf + 1]));
});

test("trailing data without a final newline is retained as the incomplete fragment (not dispatched)", () => {
	const complete = markerLines(2).join("\n") + "\n";
	const partial = JSON.stringify({ type: "marker", seq: 2, payload: "incomplete" }).slice(0, -5);
	const bridge: any = new RpcBridge({});
	const seen: any[] = [];
	bridge.onEvent((e: any) => { if (e?.type === "marker") seen.push(e.seq); });
	bridge.handleData(complete);
	bridge.handleData(partial);
	assert.deepEqual(seen, [0, 1], "only the two complete lines should have dispatched");
	assert.equal(bridge.lineBuffer, partial, "the incomplete trailing fragment must be preserved verbatim for the next chunk");
});

test("zero-length chunks (e.g. an empty decoder flush) are a no-op and don't corrupt framing", () => {
	const lines = markerLines(3);
	const text = lines.join("\n") + "\n";
	const chunks = chunkAt(text, [Math.floor(text.length / 3), Math.floor((2 * text.length) / 3)]);
	// Interleave empty-string chunks between the real ones.
	const withEmpties: string[] = [];
	for (const c of chunks) { withEmpties.push(""); withEmpties.push(c); withEmpties.push(""); }
	assertSameLines("zero-length-chunks", withEmpties);
});

test("resuming scan position does not re-dispatch or drop lines across dozens of small chunks", () => {
	const lines = markerLines(1000);
	const text = lines.join("\n") + "\n";
	// Chunk at a quasi-random but deterministic cadence to exercise both
	// mid-line and boundary-aligned cuts across many calls.
	const cuts: number[] = [];
	let pos = 0;
	let step = 13;
	while (pos < text.length) {
		pos += step;
		cuts.push(pos);
		step = (step * 17 + 5) % 97 + 3;
	}
	assertSameLines("quasi-random-many-chunks", chunkAt(text, cuts));
});
