/**
 * Unit tests for F24's repeat-read dedup wrapper (defaults/tools/_builtins/read-dedup.ts).
 *
 * pi's builtin `read` tool has no path+mtime dedup — every re-read of an
 * unchanged file re-sends the full (truncated) content into the transcript.
 * `wrapReadToolWithDedup` sits in front of the vendored `execute()` and stubs
 * out EXACT repeat reads (same path, same offset, same limit) of a file whose
 * mtime+size have not changed since the prior read.
 *
 * These tests exercise the wrapper directly against a fake underlying
 * `execute()` + an injected `stat` function so behavior is deterministic and
 * independent of the installed pi-coding-agent version (see
 * defaults/tools/_builtins/extension.ts, which wires the real
 * `createReadToolDefinition()` through this wrapper).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	wrapReadToolWithDedup,
	type ReadDedupParams,
	type ReadDedupResult,
	type ReadToolDefinitionLike,
} from "../defaults/tools/_builtins/read-dedup.ts";

const CWD = "/repo";
const FILE_A = "/repo/a.ts";
const FILE_B = "/repo/b.ts";

interface StatRecord {
	mtimeMs: number;
	size: number;
}

function makeHarness(initialStats: Record<string, StatRecord> = {}) {
	const stats: Record<string, StatRecord> = { ...initialStats };
	const calls: ReadDedupParams[] = [];
	let nextResult: ReadDedupResult = {
		content: [{ type: "text", text: "full content" }],
		details: { truncation: { truncated: false } },
	};

	const definition: ReadToolDefinitionLike = {
		name: "read",
		async execute(_toolCallId, params) {
			calls.push(params);
			return nextResult;
		},
	};

	let clockMs = 1_700_000_000_000;
	const wrapped = wrapReadToolWithDedup(definition, CWD, {
		stat: async (absolutePath: string) => {
			const rec = stats[absolutePath];
			if (!rec) throw new Error(`ENOENT: no such file: ${absolutePath}`);
			return rec;
		},
		now: () => new Date(clockMs),
		maxEntries: 500,
	});

	return {
		wrapped,
		calls,
		stats,
		setStat: (p: string, rec: StatRecord) => {
			stats[p] = rec;
		},
		setResult: (r: ReadDedupResult) => {
			nextResult = r;
		},
		tick: (ms: number) => {
			clockMs += ms;
		},
	};
}

async function run(wrapped: ReadToolDefinitionLike, params: ReadDedupParams): Promise<ReadDedupResult> {
	return wrapped.execute("call-1", params, undefined, undefined, {});
}

describe("F24 read-dedup wrapper", () => {
	it("stubs an exact repeat read of an unchanged file", async () => {
		const h = makeHarness({ [FILE_A]: { mtimeMs: 100, size: 10 } });

		const first = await run(h.wrapped, { path: FILE_A });
		assert.equal(h.calls.length, 1, "first read should hit the underlying execute");
		assert.equal(first.content[0]?.type, "text");
		assert.equal((first.content[0] as { text: string }).text, "full content");

		const second = await run(h.wrapped, { path: FILE_A });
		assert.equal(h.calls.length, 1, "repeat read of an unchanged file must NOT hit the underlying execute again");
		assert.equal(second.content.length, 1);
		assert.equal(second.content[0]?.type, "text");
		const stubText = (second.content[0] as { text: string }).text;
		assert.match(stubText, /unchanged since your last read/i);
		assert.match(stubText, /content omitted/i);
		// Truncation metadata from the original read is preserved on the stub.
		assert.deepEqual(second.details, { truncation: { truncated: false } });
	});

	it("returns full content again when mtime changes between reads", async () => {
		const h = makeHarness({ [FILE_A]: { mtimeMs: 100, size: 10 } });

		await run(h.wrapped, { path: FILE_A });
		assert.equal(h.calls.length, 1);

		// File was edited: mtime bumps (size may or may not change).
		h.setStat(FILE_A, { mtimeMs: 200, size: 10 });
		h.setResult({ content: [{ type: "text", text: "new content" }], details: { truncation: { truncated: false } } });

		const second = await run(h.wrapped, { path: FILE_A });
		assert.equal(h.calls.length, 2, "changed mtime must force a real re-read, not a stub");
		assert.equal((second.content[0] as { text: string }).text, "new content");
	});

	it("returns full content again when size changes but mtime does not (belt-and-braces)", async () => {
		const h = makeHarness({ [FILE_A]: { mtimeMs: 100, size: 10 } });
		await run(h.wrapped, { path: FILE_A });
		h.setStat(FILE_A, { mtimeMs: 100, size: 999 });
		const second = await run(h.wrapped, { path: FILE_A });
		assert.equal(h.calls.length, 2, "changed size must force a real re-read even if mtime alone matched");
	});

	it("does not stub reads that cover a different offset/limit range", async () => {
		const h = makeHarness({ [FILE_A]: { mtimeMs: 100, size: 10 } });

		await run(h.wrapped, { path: FILE_A });
		assert.equal(h.calls.length, 1);

		await run(h.wrapped, { path: FILE_A, offset: 50 });
		assert.equal(h.calls.length, 2, "a read with a different offset must not be stubbed against the offset-less read");

		await run(h.wrapped, { path: FILE_A, offset: 50, limit: 20 });
		assert.equal(h.calls.length, 3, "a read with a different limit must not be stubbed against the limit-less read");

		// But repeating the SAME offset+limit combination a second time is stubbed.
		await run(h.wrapped, { path: FILE_A, offset: 50, limit: 20 });
		assert.equal(h.calls.length, 3, "an exact repeat of a specific offset+limit range should still be stubbed");
	});

	it("never stubs non-text (e.g. image) results", async () => {
		const h = makeHarness({ [FILE_A]: { mtimeMs: 100, size: 10 } });
		h.setResult({
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "base64...", mimeType: "image/png" },
			],
		});

		await run(h.wrapped, { path: FILE_A });
		await run(h.wrapped, { path: FILE_A });
		assert.equal(h.calls.length, 2, "image reads must never be cached/stubbed");
	});

	it("fails open (full read) when stat throws for a cached entry", async () => {
		const h = makeHarness({ [FILE_A]: { mtimeMs: 100, size: 10 } });
		await run(h.wrapped, { path: FILE_A });
		assert.equal(h.calls.length, 1);

		// Simulate the file having been deleted between reads.
		delete h.stats[FILE_A];
		const second = await run(h.wrapped, { path: FILE_A });
		assert.equal(h.calls.length, 2, "a stat failure on the cached entry must fall through to a real read");
		assert.equal((second.content[0] as { text: string }).text, "full content");
	});

	it("respects a bounded cache size (FIFO eviction)", async () => {
		const h = makeHarness({
			[FILE_A]: { mtimeMs: 100, size: 10 },
			[FILE_B]: { mtimeMs: 100, size: 10 },
			"/repo/c.ts": { mtimeMs: 100, size: 10 },
		});
		const wrapped = wrapReadToolWithDedup(
			{
				name: "read",
				async execute(_id, params) {
					h.calls.push(params);
					return { content: [{ type: "text", text: "full content" }] };
				},
			},
			CWD,
			{
				stat: async (p: string) => {
					const rec = h.stats[p];
					if (!rec) throw new Error("ENOENT");
					return rec;
				},
				now: () => new Date(),
				maxEntries: 2,
			},
		);

		await run(wrapped, { path: FILE_A }); // cache: [A]
		await run(wrapped, { path: FILE_B }); // cache: [A, B]
		await run(wrapped, { path: "/repo/c.ts" }); // cache full at 2 -> evicts A: [B, C]
		assert.equal(h.calls.length, 3);

		// A was evicted -- re-reading it must be a real (uncached) read again.
		await run(wrapped, { path: FILE_A });
		assert.equal(h.calls.length, 4, "reading an evicted path must not be stubbed");

		// B and C should still be cached (most-recently-used were kept).
		await run(wrapped, { path: FILE_B });
		assert.equal(h.calls.length, 5, "B was evicted when A was re-inserted (cache bound is 2) -- FIFO, not LRU");
	});

	it("resolves cwd-relative and ~-relative paths for cache-key purposes", async () => {
		const h = makeHarness({ [FILE_A]: { mtimeMs: 100, size: 10 } });
		await run(h.wrapped, { path: "a.ts" }); // relative to CWD -> resolves to FILE_A
		assert.equal(h.calls.length, 1);
		const second = await run(h.wrapped, { path: "a.ts" });
		assert.equal(h.calls.length, 1, "relative path repeat read must resolve to the same cache key and be stubbed");
		assert.match((second.content[0] as { text: string }).text, /unchanged/i);
	});

	it("preserves every other tool-definition property untouched", () => {
		const definition: ReadToolDefinitionLike = {
			name: "read",
			label: "read",
			description: "some description",
			async execute() {
				return { content: [] };
			},
		};
		const wrapped = wrapReadToolWithDedup(definition, CWD);
		assert.equal(wrapped.name, "read");
		assert.equal(wrapped.label, "read");
		assert.equal(wrapped.description, "some description");
		assert.notEqual(wrapped.execute, definition.execute, "execute must be replaced by the wrapped version");
	});
});
