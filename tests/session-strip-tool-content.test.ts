// ============================================================================
// Phase 2B pinning test \u2014 strip-tool-content data shape.
//
// File name note: the task spec called this `.spec.ts` (Playwright glob),
// but the helper is a pure data-shape function with no DOM / no fetch / no
// fixture bundle. The `.test.ts` suffix runs it under `node:test` (the
// project's `tests/*.test.ts` glob), matching the sibling
// `tests/truncate-large-content.test.ts`.
// ============================================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	stripLargeToolContentInMessages,
	parseStripThreshold,
	STRIP_TOOL_CONTENT_DEFAULT_THRESHOLD,
	type StrippedContent,
} from "../src/server/agent/strip-tool-content.js";

const SMALL_CONTENT = "ok";

describe("stripLargeToolContentInMessages", () => {
	it("returns the same reference for non-array input", () => {
		assert.strictEqual(stripLargeToolContentInMessages(null), null);
		assert.strictEqual(stripLargeToolContentInMessages(undefined), undefined);
		const obj = { not: "an array" };
		assert.strictEqual(stripLargeToolContentInMessages(obj as any), obj as any);
	});

	it("returns the same reference when no tool blocks need stripping", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Sure." },
					{
						type: "tool_use",
						name: "write",
						input: { path: "foo.ts", content: SMALL_CONTENT },
					},
				],
			},
		];
		const out = stripLargeToolContentInMessages(messages);
		assert.strictEqual(out, messages, "no strip needed \u2014 same reference");
	});

	it("strips tool_use content above the default threshold", () => {
		const big = "x".repeat(STRIP_TOOL_CONTENT_DEFAULT_THRESHOLD + 1);
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Writing..." },
					{
						type: "tool_use",
						name: "write",
						input: { path: "big.json", content: big },
					},
				],
			},
		];
		const stats = { stripped: 0, bytes: 0 };
		const out = stripLargeToolContentInMessages(messages, undefined, stats) as any[];
		assert.notStrictEqual(out, messages, "rewritten \u2014 new array");
		const block = out[0].content[1];
		const stripped: StrippedContent = block.input.content;
		assert.equal(stripped._truncated, true);
		assert.equal(stripped._originalLength, big.length);
		assert.equal(stripped.preview.length, 512);
		// Other blocks untouched.
		assert.strictEqual(out[0].content[0], messages[0].content[0]);
		// Stats captured.
		assert.equal(stats.stripped, 1);
		assert.equal(stats.bytes, big.length);
	});

	it("strips toolCall (RPC) shape with `arguments.content`", () => {
		const big = "y".repeat(STRIP_TOOL_CONTENT_DEFAULT_THRESHOLD + 1);
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc-1",
						name: "write",
						arguments: { path: "big.md", content: big },
					},
				],
			},
		];
		const out = stripLargeToolContentInMessages(messages) as any[];
		const block = out[0].content[0];
		assert.equal(block.arguments.content._truncated, true);
		assert.equal(block.arguments.content._originalLength, big.length);
		assert.equal(block.arguments.path, "big.md", "non-content args untouched");
	});

	it("respects a custom threshold", () => {
		const small = "z".repeat(50);
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						name: "write",
						input: { path: "small.txt", content: small },
					},
				],
			},
		];
		// With threshold = 10, the 50-byte content should strip.
		const out = stripLargeToolContentInMessages(messages, 10) as any[];
		assert.equal(out[0].content[0].input.content._truncated, true);
		// Default (4KB) leaves it alone.
		const out2 = stripLargeToolContentInMessages(messages);
		assert.strictEqual(out2, messages);
	});

	it("does not strip non-string tool content", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						name: "write",
						input: { path: "a.ts", content: { not: "a string" } },
					},
				],
			},
		];
		const out = stripLargeToolContentInMessages(messages, 1);
		assert.strictEqual(out, messages, "non-string content untouched");
	});

	it("leaves non-tool blocks alone even when large", () => {
		const big = "t".repeat(STRIP_TOOL_CONTENT_DEFAULT_THRESHOLD + 1);
		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: big }],
			},
		];
		const out = stripLargeToolContentInMessages(messages);
		assert.strictEqual(out, messages, "text blocks are not stripped");
	});

	it("preview is the first 512 chars of the original content", () => {
		const big = Array.from({ length: STRIP_TOOL_CONTENT_DEFAULT_THRESHOLD + 100 })
			.map((_, i) => String.fromCharCode(97 + (i % 26)))
			.join("");
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						name: "write",
						input: { path: "alpha.txt", content: big },
					},
				],
			},
		];
		const out = stripLargeToolContentInMessages(messages) as any[];
		const stripped: StrippedContent = out[0].content[0].input.content;
		assert.equal(stripped.preview, big.slice(0, 512));
	});

	it("preserves referential equality for unchanged messages in a mixed array", () => {
		const big = "x".repeat(STRIP_TOOL_CONTENT_DEFAULT_THRESHOLD + 1);
		const userMsg = { role: "user", content: [{ type: "text", text: "hi" }] };
		const messages = [
			userMsg,
			{
				role: "assistant",
				content: [
					{ type: "tool_use", name: "write", input: { content: big } },
				],
			},
		];
		const out = stripLargeToolContentInMessages(messages) as any[];
		assert.notStrictEqual(out, messages);
		assert.strictEqual(out[0], userMsg, "unchanged messages keep their reference");
		assert.notStrictEqual(out[1], messages[1]);
	});
});

describe("parseStripThreshold", () => {
	it("returns the default for null / undefined / empty / truthy keywords", () => {
		const d = STRIP_TOOL_CONTENT_DEFAULT_THRESHOLD;
		assert.equal(parseStripThreshold(null), d);
		assert.equal(parseStripThreshold(undefined), d);
		assert.equal(parseStripThreshold(""), d);
		assert.equal(parseStripThreshold("1"), d);
		assert.equal(parseStripThreshold("true"), d);
	});

	it("parses positive integers as byte thresholds", () => {
		assert.equal(parseStripThreshold("8192"), 8192);
		assert.equal(parseStripThreshold("100"), 100);
	});

	it("falls back to default for non-numeric / negative / zero inputs", () => {
		const d = STRIP_TOOL_CONTENT_DEFAULT_THRESHOLD;
		assert.equal(parseStripThreshold("garbage"), d);
		assert.equal(parseStripThreshold("-5"), d);
		assert.equal(parseStripThreshold("0"), d);
		assert.equal(parseStripThreshold("NaN"), d);
	});
});
