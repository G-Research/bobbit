import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	LARGE_CONTENT_THRESHOLD,
	truncateLargeToolContent,
	truncateLargeToolContentInMessages,
} from "../../src/server/agent/truncate-large-content.js";

function toolCall(arguments_: Record<string, unknown>) {
	return {
		type: "message_update",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name: "review_open", arguments: arguments_ }],
		},
	};
}

function toolUse(input: Record<string, unknown>) {
	return {
		role: "assistant",
		content: [{ type: "tool_use", name: "review_open", input }],
	};
}

describe("review_open argument transport projection", () => {
	it("projects an ordered inline file set when cumulative UTF-8 bytes exceed the threshold", () => {
		const firstMarkdown = "alpha";
		const secondMarkdown = "bravo";
		const firstInline = { title: "First", markdown: firstMarkdown };
		const fileSource = { title: "On disk", file: "docs/details.md" };
		const arguments_ = {
			title: "Exact review title",
			replace: false,
			files: [
				firstInline,
				fileSource,
				{ title: "Second", markdown: secondMarkdown },
			],
		};
		const event = toolCall(arguments_);

		const result = truncateLargeToolContent(event, 9);
		const projected = result.message.content[0].arguments;

		assert.notStrictEqual(result, event);
		assert.equal(projected.title, arguments_.title);
		assert.equal(projected.replace, false);
		assert.equal(projected.files.length, 3);
		assert.deepEqual(projected.files[0], {
			title: "First",
			markdown: { _truncated: true, _originalLength: 5, _originalBytes: 5 },
		});
		assert.strictEqual(projected.files[1], fileSource, "file identity, metadata, and ordering must be retained");
		assert.deepEqual(projected.files[2], {
			title: "Second",
			markdown: { _truncated: true, _originalLength: 5, _originalBytes: 5 },
		});
		assert.equal(JSON.stringify(projected).includes(firstMarkdown), false);
		assert.equal(JSON.stringify(projected).includes(secondMarkdown), false);
		assert.strictEqual(firstInline.markdown, firstMarkdown, "the source payload must not be mutated");
	});

	it("accounts for UTF-8 bytes rather than JavaScript string length", () => {
		const markdown = "😀😀😀";
		assert.equal(markdown.length, 6);
		assert.equal(Buffer.byteLength(markdown, "utf8"), 12);
		const event = toolCall({ title: "Unicode", markdown });

		const result = truncateLargeToolContent(event, 10);

		assert.deepEqual(result.message.content[0].arguments.markdown, {
			_truncated: true,
			_originalLength: 6,
			_originalBytes: 12,
		});
	});

	it("keeps review Markdown at exactly the cumulative UTF-8 threshold", () => {
		const arguments_ = {
			files: [
				{ title: "One", markdown: "😀" },
				{ title: "Two", markdown: "é" },
			],
		};
		assert.equal(Buffer.byteLength("😀é", "utf8"), 6);
		const event = toolCall(arguments_);

		assert.strictEqual(truncateLargeToolContent(event, 6), event);
	});

	it("projects cumulative tool_use input during persisted history hydration", () => {
		const first = "a".repeat(20_000);
		const second = "b".repeat(20_000);
		assert.ok(first.length < LARGE_CONTENT_THRESHOLD);
		assert.ok(second.length < LARGE_CONTENT_THRESHOLD);
		const message = toolUse({
			title: "Large history review",
			files: [
				{ title: "A", markdown: first },
				{ title: "B", markdown: second },
			],
		});

		const result = truncateLargeToolContentInMessages([message]) as any[];
		const input = result[0].content[0].input;

		assert.notStrictEqual(result[0], message);
		assert.deepEqual(input.files.map((file: any) => file.title), ["A", "B"]);
		assert.deepEqual(input.files.map((file: any) => file.markdown._originalBytes), [20_000, 20_000]);
		assert.ok(Buffer.byteLength(JSON.stringify(input), "utf8") < LARGE_CONTENT_THRESHOLD);
	});

	it("leaves file-only reviews and unrelated tool Markdown untouched", () => {
		const fileOnly = toolCall({ title: "File review", file: "docs/review.md" });
		assert.strictEqual(truncateLargeToolContent(fileOnly, 1), fileOnly);

		const unrelated = {
			type: "message_update",
			message: {
				content: [{ type: "toolCall", name: "some_other_tool", arguments: { markdown: "large" } }],
			},
		};
		assert.strictEqual(truncateLargeToolContent(unrelated, 1), unrelated);
	});
});
