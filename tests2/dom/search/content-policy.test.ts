import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/search/content-policy.spec.ts (v2-dom tier).
// Pure-logic test: imports the REAL content-policy helpers from
// src/server/search/content-policy.
//
// Covers every row of the content policy table (design §5): role detection,
// `<thinking>` stripping, tool-call first-line extraction, >32KB tool-result
// hard skip, 500-char truncation, empty-text filtering, image/thinking/binary
// block skipping.
import { describe, expect, it } from "vitest";
import {
	CONTENT_POLICY_VERSION,
	MAX_TOOL_RESULT_INPUT_CHARS,
	TOOL_RESULT_INDEX_CHARS,
	extractForIndexing,
	stripThinking,
	summariseToolCall,
} from "../../../src/server/search/content-policy.js";

describe("CONTENT_POLICY_VERSION", () => {
	it("is exported and equals 3", () => {
		expect(CONTENT_POLICY_VERSION).toBe(3);
	});
	it("limit constants match design", () => {
		expect(MAX_TOOL_RESULT_INPUT_CHARS).toBe(32_768);
		expect(TOOL_RESULT_INDEX_CHARS).toBe(500);
	});
});

describe("stripThinking", () => {
	it("removes a single block", () => {
		expect(stripThinking("before <thinking>plan</thinking> after")).toBe(
			"before  after".trim(),
		);
	});
	it("removes multi-line blocks", () => {
		const input = "x\n<thinking>\nline1\nline2\n</thinking>\ny";
		expect(stripThinking(input)).toBe("x\n\ny".trim());
	});
	it("removes multiple blocks", () => {
		const input = "a<thinking>1</thinking>b<thinking>2</thinking>c";
		expect(stripThinking(input)).toBe("abc");
	});
	it("leaves unmatched opening tag alone", () => {
		const input = "hello <thinking>unterminated and more text";
		expect(stripThinking(input)).toBe(input.trim());
	});
	it("no thinking block → returned as-is (trimmed)", () => {
		expect(stripThinking("  plain text  ")).toBe("plain text");
	});
	it("empty string", () => {
		expect(stripThinking("")).toBe("");
	});
});

describe("summariseToolCall", () => {
	it("name + first line of stringified input", () => {
		const s = summariseToolCall("read", { path: "/tmp/foo.txt", limit: 10 });
		expect(s.startsWith("read ")).toBe(true);
		expect(s.includes("\n")).toBe(false);
		expect(s).toContain("/tmp/foo.txt");
	});
	it("multi-line string input → first line only", () => {
		const s = summariseToolCall("bash", "line1\nline2\nline3");
		expect(s).toBe("bash line1");
	});
	it("missing input → name only", () => {
		expect(summariseToolCall("ls", undefined)).toBe("ls");
		expect(summariseToolCall("ls", null)).toBe("ls");
	});
	it("non-serialisable input falls back gracefully", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const s = summariseToolCall("weird", circular);
		expect(s).toBe("weird");
	});
	it("non-string name coerced to empty", () => {
		const s = summariseToolCall(undefined as unknown as string, { x: 1 });
		expect(typeof s).toBe("string");
	});
});

describe("extractForIndexing — role detection", () => {
	it("user text block → user, 2.0, full text", () => {
		const { entries } = extractForIndexing({
			role: "user",
			content: [{ type: "text", text: "hello world" }],
		});
		expect(entries).toHaveLength(1);
		expect(entries[0].role).toBe("user");
		expect(entries[0].weight).toBe(2.0);
		expect(entries[0].text).toBe("hello world");
	});

	it("user string content → single user entry", () => {
		const { entries } = extractForIndexing({ role: "user", content: "direct" });
		expect(entries).toEqual([
			{ role: "user", weight: 2.0, text: "direct", blockKey: "text:0" },
		]);
	});

	it("assistant text block → assistant, 1.0, thinking stripped", () => {
		const { entries } = extractForIndexing({
			role: "assistant",
			content: [
				{ type: "text", text: "<thinking>secret</thinking>public answer" },
			],
		});
		expect(entries).toHaveLength(1);
		expect(entries[0].role).toBe("assistant");
		expect(entries[0].weight).toBe(1.0);
		expect(entries[0].text).toBe("public answer");
	});

	it("assistant tool_use → tool_call, 0.8, name + first arg line", () => {
		const { entries } = extractForIndexing({
			role: "assistant",
			content: [
				{ type: "tool_use", name: "web_search", input: { query: "foo bar" } },
			],
		});
		expect(entries).toHaveLength(1);
		expect(entries[0].role).toBe("tool_call");
		expect(entries[0].weight).toBe(0.8);
		expect(entries[0].text.startsWith("web_search ")).toBe(true);
		expect(entries[0].text).toContain("foo bar");
	});

	it("user tool_result block → tool_result, 0.5, first 500 chars", () => {
		const big = "x".repeat(1200);
		const { entries } = extractForIndexing({
			role: "user",
			content: [{ type: "tool_result", content: big }],
		});
		expect(entries).toHaveLength(1);
		expect(entries[0].role).toBe("tool_result");
		expect(entries[0].weight).toBe(0.5);
		expect(entries[0].text.length).toBe(500);
	});

	it("user tool_result with nested content array", () => {
		const { entries } = extractForIndexing({
			role: "user",
			content: [
				{
					type: "tool_result",
					content: [
						{ type: "text", text: "result line A" },
						{ type: "text", text: "result line B" },
					],
				},
			],
		});
		expect(entries).toHaveLength(1);
		expect(entries[0].role).toBe("tool_result");
		expect(entries[0].text).toContain("result line A");
		expect(entries[0].text).toContain("result line B");
	});
});

describe("extractForIndexing — skip rules", () => {
	it("thinking block is skipped", () => {
		const { entries } = extractForIndexing({
			role: "assistant",
			content: [{ type: "thinking", thinking: "private" }],
		});
		expect(entries).toHaveLength(0);
	});

	it("image block is skipped", () => {
		const { entries } = extractForIndexing({
			role: "user",
			content: [
				{ type: "image", source: { type: "base64", data: "…" } },
				{ type: "text", text: "caption" },
			],
		});
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe("caption");
	});

	it("tool_result >32KB is hard-skipped", () => {
		const huge = "y".repeat(MAX_TOOL_RESULT_INPUT_CHARS + 1);
		const { entries } = extractForIndexing({
			role: "user",
			content: [{ type: "tool_result", content: huge }],
		});
		expect(entries).toHaveLength(0);
	});

	it("tool_result exactly at 32KB still indexed", () => {
		const atLimit = "z".repeat(MAX_TOOL_RESULT_INPUT_CHARS);
		const { entries } = extractForIndexing({
			role: "user",
			content: [{ type: "tool_result", content: atLimit }],
		});
		expect(entries).toHaveLength(1);
		expect(entries[0].text.length).toBe(TOOL_RESULT_INDEX_CHARS);
	});

	it("empty text blocks are filtered out", () => {
		const { entries } = extractForIndexing({
			role: "assistant",
			content: [
				{ type: "text", text: "" },
				{ type: "text", text: "   " },
				{ type: "text", text: "real" },
			],
		});
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe("real");
	});

	it("system messages → no entries", () => {
		const { entries } = extractForIndexing({
			role: "system",
			content: "system prompt goes here",
		});
		expect(entries).toHaveLength(0);
	});

	it("non-object message → no entries", () => {
		expect(extractForIndexing(null).entries).toHaveLength(0);
		expect(extractForIndexing(undefined).entries).toHaveLength(0);
		expect(extractForIndexing("just a string").entries).toHaveLength(0);
		expect(extractForIndexing(42).entries).toHaveLength(0);
	});

	it("unknown block types on assistant are skipped", () => {
		const { entries } = extractForIndexing({
			role: "assistant",
			content: [
				{ type: "text", text: "kept" },
				{ type: "mystery", text: "ignored" },
			],
		});
		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe("kept");
	});
});

describe("extractForIndexing — mixed realistic messages", () => {
	it("assistant interleaves text, thinking, and tool calls", () => {
		const { entries } = extractForIndexing({
			role: "assistant",
			content: [
				{ type: "text", text: "<thinking>plan</thinking>I will search." },
				{ type: "thinking", thinking: "extra private" },
				{ type: "tool_use", name: "web_search", input: { query: "lancedb" } },
				{ type: "text", text: "Done." },
			],
		});
		expect(entries).toHaveLength(3);
		expect(entries.map((e) => e.role)).toEqual([
			"assistant",
			"tool_call",
			"assistant",
		]);
		expect(entries[0].text).toBe("I will search.");
		expect(entries[1].text).toContain("web_search");
		expect(entries[1].text).toContain("lancedb");
		expect(entries[2].text).toBe("Done.");
	});

	it("block keys are stable and indexed", () => {
		const { entries } = extractForIndexing({
			role: "assistant",
			content: [
				{ type: "text", text: "a" },
				{ type: "thinking", thinking: "skip" },
				{ type: "text", text: "b" },
			],
		});
		expect(entries.map((e) => e.blockKey)).toEqual(["text:0", "text:2"]);
	});

	it("custom options override defaults", () => {
		const { entries } = extractForIndexing(
			{
				role: "user",
				content: [{ type: "tool_result", content: "abcdefghij" }],
			},
			{ toolResultIndexChars: 4 },
		);
		expect(entries[0].text).toBe("abcd");
	});

	it("custom max chars can tighten the skip threshold", () => {
		const { entries } = extractForIndexing(
			{
				role: "user",
				content: [{ type: "tool_result", content: "x".repeat(11) }],
			},
			{ maxToolResultInputChars: 10 },
		);
		expect(entries).toHaveLength(0);
	});
});
