/**
 * Unit tests for F1(a)'s oversized-read spill-to-disk wrapper
 * (defaults/tools/_builtins/read-spill.ts).
 *
 * pi's builtin `read` tool caps output at 2000 lines / 50KB and, on
 * overflow, just tells the model to bump `offset` and re-read (paying for
 * every prior chunk again in every subsequent turn's context). This wrapper
 * intercepts a plain (no offset/limit) read that hits pi's own truncation
 * cap, spills the FULL file to a session-scoped scratch path, and replaces
 * the result with a head+tail excerpt + a pointer to that path.
 *
 * These tests exercise the wrapper directly against a fake underlying
 * `execute()` (returning pi-shaped truncation `details`) with injected
 * `readFile`/`writeSpillFile`/`env`, so behavior is deterministic and
 * independent of the real filesystem or the installed pi-coding-agent
 * version (see defaults/tools/_builtins/extension.ts, which wires the real
 * `createReadToolDefinition()` through this wrapper).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { wrapReadToolWithSpill } from "../defaults/tools/_builtins/read-spill.ts";
import type { ReadDedupParams, ReadDedupResult, ReadToolDefinitionLike } from "../defaults/tools/_builtins/read-tool-shared.ts";

const CWD = "/repo";
const FILE_A = "/repo/big.ts";

function makeHarness(opts: {
	result: ReadDedupResult;
	statMtimeMs?: number;
	throwOnRead?: boolean;
	throwOnWrite?: boolean;
} ) {
	const calls: ReadDedupParams[] = [];
	const writes: Array<{ spillPath: string; content: string }> = [];

	const definition: ReadToolDefinitionLike = {
		name: "read",
		async execute(_toolCallId, params) {
			calls.push(params);
			return opts.result;
		},
	};

	const wrapped = wrapReadToolWithSpill(definition, CWD, {
		env: { BOBBIT_DIR: "/home/user/.bobbit", BOBBIT_SESSION_ID: "session-123" },
		stat: async () => ({ mtimeMs: opts.statMtimeMs ?? 12345 }),
		readFile: async (absolutePath: string) => {
			if (opts.throwOnRead) throw new Error("ENOENT");
			return `FULL-CONTENT-OF(${absolutePath})`;
		},
		writeSpillFile: async (spillPath: string, content: string) => {
			if (opts.throwOnWrite) throw new Error("EACCES");
			writes.push({ spillPath, content });
		},
	});

	return { wrapped, calls, writes };
}

async function run(wrapped: ReadToolDefinitionLike, params: ReadDedupParams): Promise<ReadDedupResult> {
	return wrapped.execute("call-1", params, undefined, undefined, {});
}

function truncatedResult(text = "head of a huge file..."): ReadDedupResult {
	return {
		content: [{ type: "text", text }],
		details: { truncation: { truncated: true, truncatedBy: "bytes", totalLines: 50000, totalBytes: 900000 } },
	};
}

function untruncatedResult(text = "small file content"): ReadDedupResult {
	return {
		content: [{ type: "text", text }],
		details: { truncation: { truncated: false } },
	};
}

describe("F1(a) read-spill wrapper", () => {
	it("spills to disk and returns a head+tail+path excerpt when a plain read is truncated", async () => {
		const h = makeHarness({ result: truncatedResult() });
		const result = await run(h.wrapped, { path: FILE_A });

		assert.equal(h.writes.length, 1, "should have written exactly one spill file");
		assert.match(h.writes[0].spillPath, /read-spill[\\/]session-123[\\/]/);
		assert.equal(h.writes[0].content, `FULL-CONTENT-OF(${FILE_A})`);

		assert.equal(result.content.length, 1);
		const text = (result.content[0] as { text: string }).text;
		assert.match(text, /spilled to disk/i);
		assert.match(text, new RegExp(h.writes[0].spillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(text, /head \(first/i);
		assert.match(text, /tail \(last/i);
		assert.ok((result.details as any).spilled?.path === h.writes[0].spillPath);
	});

	it("does not spill (byte-identical passthrough) when the read is not truncated", async () => {
		const h = makeHarness({ result: untruncatedResult() });
		const result = await run(h.wrapped, { path: FILE_A });
		assert.equal(h.writes.length, 0, "an under-cap read must never spill");
		assert.deepEqual(result, untruncatedResult(), "result object must be untouched");
	});

	it("does not spill when the caller explicitly passed offset/limit, even if truncated", async () => {
		const h = makeHarness({ result: truncatedResult() });
		const withOffset = await run(h.wrapped, { path: FILE_A, offset: 100 });
		assert.equal(h.writes.length, 0, "an explicit offset means the caller is already deliberately paginating");
		assert.deepEqual(withOffset, truncatedResult());

		const withLimit = await run(h.wrapped, { path: FILE_A, limit: 500 });
		assert.equal(h.writes.length, 0, "an explicit limit means the caller is already deliberately paginating");
		assert.deepEqual(withLimit, truncatedResult());
	});

	it("falls back to the original truncated result if reading the full file fails", async () => {
		const h = makeHarness({ result: truncatedResult(), throwOnRead: true });
		const result = await run(h.wrapped, { path: FILE_A });
		assert.equal(h.writes.length, 0);
		assert.deepEqual(result, truncatedResult(), "must fail open to pi's own truncated result");
	});

	it("falls back to the original truncated result if writing the spill file fails", async () => {
		const h = makeHarness({ result: truncatedResult(), throwOnWrite: true });
		const result = await run(h.wrapped, { path: FILE_A });
		assert.deepEqual(result, truncatedResult(), "must fail open to pi's own truncated result");
	});

	it("falls back untouched when the path cannot be resolved", async () => {
		const h = makeHarness({ result: truncatedResult() });
		const result = await run(h.wrapped, { path: "" });
		assert.equal(h.writes.length, 0);
		assert.deepEqual(result, truncatedResult());
	});

	it("uses BOBBIT_DIR/state/read-spill/<sessionId>/ as the spill directory", async () => {
		const h = makeHarness({ result: truncatedResult() });
		await run(h.wrapped, { path: FILE_A });
		assert.equal(h.writes[0].spillPath.startsWith("/home/user/.bobbit/state/read-spill/session-123/"), true, h.writes[0].spillPath);
	});

	it("falls back to ~/.pi/read-spill/no-session/ when BOBBIT_DIR/BOBBIT_SESSION_ID are unset", async () => {
		const writes: Array<{ spillPath: string; content: string }> = [];
		const definition: ReadToolDefinitionLike = {
			name: "read",
			async execute() {
				return truncatedResult();
			},
		};
		const wrapped = wrapReadToolWithSpill(definition, CWD, {
			env: {},
			stat: async () => ({ mtimeMs: 12345 }),
			readFile: async () => "full content",
			writeSpillFile: async (spillPath, content) => {
				writes.push({ spillPath, content });
			},
		});
		await run(wrapped, { path: FILE_A });
		assert.equal(writes.length, 1);
		assert.match(writes[0].spillPath, /\.pi[\\/]read-spill[\\/]no-session[\\/]/);
	});

	it("preserves the truncation details alongside the new spilled metadata", async () => {
		const h = makeHarness({ result: truncatedResult() });
		const result = await run(h.wrapped, { path: FILE_A });
		assert.ok((result.details as any).truncation, "original truncation metadata should be preserved");
		assert.equal((result.details as any).truncation.truncated, true);
	});
});
