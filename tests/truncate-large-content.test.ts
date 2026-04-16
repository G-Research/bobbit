import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { truncateLargeToolContent, LARGE_CONTENT_THRESHOLD } from "../src/server/agent/truncate-large-content.js";

describe("truncateLargeToolContent", () => {
	it("returns the same object for non-message events", () => {
		const event = { type: "agent_start", data: {} };
		const result = truncateLargeToolContent(event);
		assert.strictEqual(result, event, "should be the exact same reference");
	});

	it("returns the same object for message_update with no content array", () => {
		const event = { type: "message_update", message: { role: "assistant", content: "hello" } };
		const result = truncateLargeToolContent(event);
		assert.strictEqual(result, event);
	});

	it("returns the same object for message_update with small tool_use content", () => {
		const event = {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{ type: "tool_use", name: "write", input: { path: "foo.ts", content: "small" } },
				],
			},
		};
		const result = truncateLargeToolContent(event);
		assert.strictEqual(result, event, "no truncation needed — same reference");
	});

	it("truncates large tool_use content and returns a new object", () => {
		const largeContent = "x".repeat(LARGE_CONTENT_THRESHOLD + 1);
		const event = {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Writing file..." },
					{ type: "tool_use", name: "write", input: { path: "big.json", content: largeContent } },
				],
			},
		};

		const result = truncateLargeToolContent(event);

		// Must be a different object
		assert.notStrictEqual(result, event);
		assert.notStrictEqual(result.message, event.message);
		assert.notStrictEqual(result.message.content, event.message.content);

		// Text block unchanged (same reference)
		assert.strictEqual(result.message.content[0], event.message.content[0]);

		// Tool_use block truncated
		const truncated = result.message.content[1].input.content;
		assert.strictEqual(truncated._truncated, true);
		assert.strictEqual(truncated._originalLength, largeContent.length);
		assert.strictEqual(truncated.preview, largeContent.slice(0, 512));
		assert.strictEqual(truncated.preview.length, 512);

		// Path preserved
		assert.strictEqual(result.message.content[1].input.path, "big.json");
		assert.strictEqual(result.message.content[1].name, "write");
	});

	it("does NOT mutate the original event", () => {
		const largeContent = "y".repeat(LARGE_CONTENT_THRESHOLD + 100);
		const event = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "tool_use", name: "write", input: { path: "f.txt", content: largeContent } },
				],
			},
		};

		truncateLargeToolContent(event);

		// Original must still have the full content string
		assert.strictEqual(typeof event.message.content[0].input.content, "string");
		assert.strictEqual(event.message.content[0].input.content.length, largeContent.length);
	});

	it("handles mixed blocks — only truncates large ones", () => {
		const large = "a".repeat(LARGE_CONTENT_THRESHOLD + 1);
		const small = "b".repeat(100);
		const event = {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{ type: "tool_use", name: "write", input: { path: "big.txt", content: large } },
					{ type: "tool_use", name: "write", input: { path: "small.txt", content: small } },
					{ type: "text", text: "done" },
				],
			},
		};

		const result = truncateLargeToolContent(event);

		// First block truncated
		assert.strictEqual(result.message.content[0].input.content._truncated, true);

		// Second block untouched (same reference)
		assert.strictEqual(result.message.content[1], event.message.content[1]);

		// Text block untouched (same reference)
		assert.strictEqual(result.message.content[2], event.message.content[2]);
	});

	it("works with message_end events too", () => {
		const large = "z".repeat(50000);
		const event = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "tool_use", name: "write", input: { path: "out.js", content: large } },
				],
			},
		};

		const result = truncateLargeToolContent(event);
		assert.notStrictEqual(result, event);
		assert.strictEqual(result.message.content[0].input.content._truncated, true);
		assert.strictEqual(result.message.content[0].input.content._originalLength, 50000);
	});

	it("respects custom threshold", () => {
		const content = "c".repeat(200);
		const event = {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{ type: "tool_use", name: "write", input: { path: "f.txt", content } },
				],
			},
		};

		// With default threshold (32KB), not truncated
		assert.strictEqual(truncateLargeToolContent(event), event);

		// With custom threshold of 100, truncated
		const result = truncateLargeToolContent(event, 100);
		assert.notStrictEqual(result, event);
		assert.strictEqual(result.message.content[0].input.content._truncated, true);
		assert.strictEqual(result.message.content[0].input.content._originalLength, 200);
	});

	// ── toolCall / arguments format (pi-coding-agent RPC) ──

	it("truncates large toolCall content (arguments format)", () => {
		const largeContent = "R".repeat(LARGE_CONTENT_THRESHOLD + 1);
		const event = {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", name: "write", arguments: { path: "big.json", content: largeContent } },
				],
			},
		};

		const result = truncateLargeToolContent(event);

		assert.notStrictEqual(result, event);
		const truncated = result.message.content[0].arguments.content;
		assert.strictEqual(truncated._truncated, true);
		assert.strictEqual(truncated._originalLength, largeContent.length);
		assert.strictEqual(truncated.preview, largeContent.slice(0, 512));
		// Path preserved in arguments
		assert.strictEqual(result.message.content[0].arguments.path, "big.json");
		// Must NOT create an input field
		assert.strictEqual(result.message.content[0].input, undefined);
	});

	it("does NOT mutate the original event (toolCall format)", () => {
		const largeContent = "S".repeat(LARGE_CONTENT_THRESHOLD + 100);
		const event = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", name: "write", arguments: { path: "f.txt", content: largeContent } },
				],
			},
		};

		truncateLargeToolContent(event);

		assert.strictEqual(typeof event.message.content[0].arguments.content, "string");
		assert.strictEqual(event.message.content[0].arguments.content.length, largeContent.length);
	});

	it("handles mixed toolCall and tool_use blocks", () => {
		const large1 = "A".repeat(LARGE_CONTENT_THRESHOLD + 1);
		const large2 = "B".repeat(LARGE_CONTENT_THRESHOLD + 1);
		const event = {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", name: "write", arguments: { path: "a.txt", content: large1 } },
					{ type: "tool_use", name: "write", input: { path: "b.txt", content: large2 } },
				],
			},
		};

		const result = truncateLargeToolContent(event);

		// toolCall block truncated in arguments
		assert.strictEqual(result.message.content[0].arguments.content._truncated, true);
		assert.strictEqual(result.message.content[0].input, undefined);
		// tool_use block truncated in input
		assert.strictEqual(result.message.content[1].input.content._truncated, true);
		assert.strictEqual(result.message.content[1].arguments, undefined);
	});

	it("returns same object for small toolCall content", () => {
		const event = {
			type: "message_update",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", name: "write", arguments: { path: "foo.ts", content: "small" } },
				],
			},
		};
		assert.strictEqual(truncateLargeToolContent(event), event);
	});

	it("handles toolCall with non-string content", () => {
		const event = {
			type: "message_update",
			message: {
				content: [
					{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
					{ type: "toolCall", name: "write", arguments: { path: "f.txt", content: 42 } },
				],
			},
		};
		assert.strictEqual(truncateLargeToolContent(event), event);
	});

	it("handles null/undefined input gracefully", () => {
		assert.strictEqual(truncateLargeToolContent(null), null);
		assert.strictEqual(truncateLargeToolContent(undefined), undefined);

		const noInput = {
			type: "message_update",
			message: {
				content: [{ type: "tool_use", name: "bash", input: { command: "ls" } }],
			},
		};
		assert.strictEqual(truncateLargeToolContent(noInput), noInput);
	});

	it("handles tool_use with non-string content (object, number, etc.)", () => {
		const event = {
			type: "message_update",
			message: {
				content: [
					{ type: "tool_use", name: "write", input: { path: "f.txt", content: 12345 } },
					{ type: "tool_use", name: "write", input: { path: "g.txt", content: { nested: true } } },
				],
			},
		};
		// Non-string content is never truncated
		assert.strictEqual(truncateLargeToolContent(event), event);
	});

	it("preserves other event properties in the shallow clone", () => {
		const large = "d".repeat(LARGE_CONTENT_THRESHOLD + 1);
		const event = {
			type: "message_update",
			message: {
				role: "assistant",
				id: "msg-123",
				model: "claude-4",
				content: [
					{ type: "tool_use", name: "write", input: { path: "f.txt", content: large } },
				],
			},
			extraField: "preserved",
		};

		const result = truncateLargeToolContent(event);
		assert.strictEqual(result.extraField, "preserved");
		assert.strictEqual(result.message.id, "msg-123");
		assert.strictEqual(result.message.model, "claude-4");
		assert.strictEqual(result.message.role, "assistant");
		assert.strictEqual(result.type, "message_update");
	});

	it("exports the threshold constant", () => {
		assert.strictEqual(LARGE_CONTENT_THRESHOLD, 32 * 1024);
	});
});
