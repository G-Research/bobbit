import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	LARGE_CONTENT_THRESHOLD,
	truncateLargeToolContent,
	truncateLargeToolContentInMessages,
} from "../../../src/server/agent/truncate-large-content.js";

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

	it("projects oversized top-level metadata and file-only paths on live transport", () => {
		const oversizedTitle = "é".repeat(200_000);
		const oversizedPath = `docs/${"segment/".repeat(80_000)}review.md`;
		const event = toolCall({ title: oversizedTitle, file: oversizedPath, replace: false });

		const result = truncateLargeToolContent(event);
		const projected = result.message.content[0].arguments;
		const serialized = JSON.stringify(projected);

		assert.equal(projected.replace, false);
		assert.deepEqual(projected.title, {
			_invalid: true,
			_reason: "review_metadata_too_large",
			_originalLength: oversizedTitle.length,
			_originalBytes: Buffer.byteLength(oversizedTitle, "utf8"),
		});
		assert.equal(projected.file._invalid, true);
		assert.equal(projected.file._reason, "review_metadata_too_large");
		assert.doesNotMatch(serialized, /segment\/segment|éééé/);
		assert.ok(Buffer.byteLength(serialized, "utf8") < LARGE_CONTENT_THRESHOLD);
		assert.equal(event.message.content[0].arguments.title, oversizedTitle, "the source payload must not be mutated");
	});

	it("projects oversized nested titles and paths during persisted history hydration", () => {
		const nestedTitle = "nested-title-".repeat(100_000);
		const nestedPath = `reports/${"nested/".repeat(100_000)}review.md`;
		const validFile = { title: "Kept", file: "docs/kept.md" };
		const message = toolUse({
			title: "History review",
			files: [
				validFile,
				{ title: nestedTitle, markdown: "short" },
				{ title: "Path", file: nestedPath },
			],
		});

		const result = truncateLargeToolContentInMessages([message]) as any[];
		const projected = result[0].content[0].input;
		const serialized = JSON.stringify(projected);

		assert.deepEqual(projected.files[0], validFile, "valid ordered metadata must remain exact");
		assert.equal(projected.files[1].title._invalid, true);
		assert.equal(projected.files[1].title._reason, "review_metadata_too_large");
		assert.equal(projected.files[1].markdown, "short");
		assert.equal(projected.files[2].file._invalid, true);
		assert.doesNotMatch(serialized, /nested-title-nested-title|nested\/nested/);
		assert.ok(Buffer.byteLength(serialized, "utf8") < LARGE_CONTENT_THRESHOLD);
	});

	it("collapses too-many file entries on both live and history transport", () => {
		const entries = Array.from({ length: 65 }, (_, index) => ({
			title: `File ${index + 1}`,
			markdown: `body-${index}`,
		}));
		const liveEvent = toolCall({ title: "Too many", files: entries });
		const historyMessage = toolUse({ title: "Too many", files: entries });

		const live = truncateLargeToolContent(liveEvent).message.content[0].arguments;
		const history = (truncateLargeToolContentInMessages([historyMessage]) as any[])[0].content[0].input;

		for (const projected of [live, history]) {
			assert.deepEqual(projected.files, {
				_invalid: true,
				_reason: "too_many_review_files",
				_originalCount: 65,
				_maximumCount: 64,
			});
			assert.doesNotMatch(JSON.stringify(projected), /body-64/);
			assert.ok(Buffer.byteLength(JSON.stringify(projected), "utf8") < LARGE_CONTENT_THRESHOLD);
		}
		assert.equal(entries.length, 65, "the source array must not be mutated");
	});

	it("leaves bounded file-only reviews and unrelated tool Markdown untouched", () => {
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
