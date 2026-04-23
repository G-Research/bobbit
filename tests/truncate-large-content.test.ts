import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	truncateLargeToolContent,
	truncateLargeToolContentInMessages,
	truncateSnapshotBlock,
	LARGE_CONTENT_THRESHOLD,
} from "../src/server/agent/truncate-large-content.js";

const PREVIEW_MARKER = "__preview_snapshot_v1__\n";

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

describe("truncateLargeToolContentInMessages", () => {
	it("returns the same array reference when nothing needs truncating", () => {
		const messages = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [{ type: "text", text: "hello" }] },
			{ role: "assistant", content: [{ type: "tool_use", name: "write", input: { content: "small" } }] },
		];
		const result = truncateLargeToolContentInMessages(messages);
		assert.strictEqual(result, messages);
	});

	it("truncates large tool_use content in history and preserves other messages by reference", () => {
		const large = "y".repeat(LARGE_CONTENT_THRESHOLD + 10);
		const smallMsg = { role: "assistant", content: [{ type: "text", text: "ok" }] };
		const bigMsg = {
			role: "assistant",
			content: [
				{ type: "text", text: "Writing..." },
				{ type: "tool_use", name: "write", input: { path: "big.txt", content: large } },
			],
		};
		const messages = [smallMsg, bigMsg];
		const result = truncateLargeToolContentInMessages(messages) as any[];
		assert.notStrictEqual(result, messages, "array is cloned when something changed");
		assert.strictEqual(result[0], smallMsg, "unchanged messages kept by reference");
		assert.notStrictEqual(result[1], bigMsg, "changed messages are shallow-cloned");
		const block = result[1].content[1];
		assert.deepEqual(block.input.content, {
			_truncated: true,
			_originalLength: large.length,
			preview: large.slice(0, 512),
		});
		assert.strictEqual(bigMsg.content[1].input.content, large, "original not mutated");
	});

	it("supports toolCall/arguments format", () => {
		const large = "z".repeat(LARGE_CONTENT_THRESHOLD + 1);
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", name: "write", arguments: { path: "x", content: large } },
				],
			},
		];
		const result = truncateLargeToolContentInMessages(messages) as any[];
		const block = result[0].content[0];
		assert.strictEqual(block.arguments.content._truncated, true);
		assert.strictEqual(block.arguments.content._originalLength, large.length);
	});

	it("ignores non-array input", () => {
		assert.strictEqual(truncateLargeToolContentInMessages(undefined as any), undefined);
		assert.strictEqual(truncateLargeToolContentInMessages(null as any), null);
		const obj = { messages: [] };
		assert.strictEqual(truncateLargeToolContentInMessages(obj as any), obj);
	});
});

describe("preview_open snapshot truncation", () => {
	it("truncateSnapshotBlock: short snapshot passes through", () => {
		const block = { type: "text", text: PREVIEW_MARKER + "<p>hi</p>" };
		assert.strictEqual(truncateSnapshotBlock(block), block);
	});

	it("truncateSnapshotBlock: marker-less text block passes through", () => {
		const block = { type: "text", text: "x".repeat(LARGE_CONTENT_THRESHOLD + 10) };
		assert.strictEqual(truncateSnapshotBlock(block), block);
	});

	it("truncateSnapshotBlock: large snapshot is truncated", () => {
		const body = "h".repeat(LARGE_CONTENT_THRESHOLD + 100);
		const full = PREVIEW_MARKER + body;
		const block = { type: "text", text: full };
		const out = truncateSnapshotBlock(block) as any;
		assert.notStrictEqual(out, block);
		assert.strictEqual(out._truncated, true);
		assert.strictEqual(out._originalLength, full.length);
		assert.strictEqual(out.text, PREVIEW_MARKER);
		assert.strictEqual(out.preview, body.slice(0, 512));
		// Original not mutated
		assert.strictEqual(block.text, full);
	});

	it("truncateSnapshotBlock: already-truncated block passes through", () => {
		const block = {
			type: "text",
			text: PREVIEW_MARKER,
			_truncated: true,
			_originalLength: 99999,
			preview: "abc",
		};
		assert.strictEqual(truncateSnapshotBlock(block), block);
	});

	it("truncateLargeToolContentInMessages: truncates toolResult snapshot >32KB", () => {
		const body = "H".repeat(LARGE_CONTENT_THRESHOLD + 5);
		const full = PREVIEW_MARKER + body;
		const msg = {
			role: "toolResult",
			toolCallId: "tc-1",
			content: [
				{ type: "text", text: "Preview panel is open and will auto-update." },
				{ type: "text", text: full },
			],
		};
		const result = truncateLargeToolContentInMessages([msg]) as any[];
		assert.notStrictEqual(result, [msg]);
		const newMsg = result[0];
		// Status block untouched (same reference)
		assert.strictEqual(newMsg.content[0], msg.content[0]);
		const snap = newMsg.content[1];
		assert.strictEqual(snap._truncated, true);
		assert.strictEqual(snap._originalLength, full.length);
		assert.strictEqual(snap.preview, body.slice(0, 512));
		assert.strictEqual(snap.text, PREVIEW_MARKER);
		// Original not mutated
		assert.strictEqual(msg.content[1].text, full);
	});

	it("truncateLargeToolContentInMessages: leaves short snapshot untouched (same array ref)", () => {
		const msg = {
			role: "toolResult",
			toolCallId: "tc-1",
			content: [
				{ type: "text", text: "ok" },
				{ type: "text", text: PREVIEW_MARKER + "<p>small</p>" },
			],
		};
		const messages = [msg];
		assert.strictEqual(truncateLargeToolContentInMessages(messages), messages);
	});

	it("truncateLargeToolContentInMessages: leaves marker-less text blocks untouched even when large", () => {
		const big = "x".repeat(LARGE_CONTENT_THRESHOLD + 100);
		const msg = {
			role: "toolResult",
			toolCallId: "tc-1",
			content: [{ type: "text", text: big }],
		};
		const messages = [msg];
		const result = truncateLargeToolContentInMessages(messages);
		// Marker-less text blocks in toolResult are not snapshots — untouched,
		// so the array reference is returned as-is.
		assert.strictEqual(result, messages);
		assert.strictEqual((result as any[])[0].content[0].text, big);
		assert.strictEqual((result as any[])[0].content[0]._truncated, undefined);
	});

	it("truncateLargeToolContent on message_end toolResult with large snapshot returns new event", () => {
		const body = "Z".repeat(LARGE_CONTENT_THRESHOLD + 1);
		const full = PREVIEW_MARKER + body;
		const event = {
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "tc-2",
				content: [
					{ type: "text", text: "Preview opened" },
					{ type: "text", text: full },
				],
			},
		};
		const result = truncateLargeToolContent(event);
		assert.notStrictEqual(result, event);
		const snap = result.message.content[1];
		assert.strictEqual(snap._truncated, true);
		assert.strictEqual(snap._originalLength, full.length);
		assert.strictEqual(snap.text, PREVIEW_MARKER);
		assert.strictEqual(snap.preview, body.slice(0, 512));
		// Status block preserved by reference
		assert.strictEqual(result.message.content[0], event.message.content[0]);
		// Original untouched
		assert.strictEqual(event.message.content[1].text, full);
	});

	it("truncateLargeToolContent on message_end toolResult with small snapshot returns same event", () => {
		const event = {
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "tc-3",
				content: [
					{ type: "text", text: "ok" },
					{ type: "text", text: PREVIEW_MARKER + "<p>small</p>" },
				],
			},
		};
		assert.strictEqual(truncateLargeToolContent(event), event);
	});
});
