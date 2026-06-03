/**
 * Unit test: transcript sanitizer — un-poison persisted blank-text user
 * messages in an agent `.jsonl` at the rehydration boundary.
 *
 * Covers:
 *   (a) image-adjacent blank-text user message  → rewritten to "Attachments:"
 *   (b) standalone blank-text user message (non-image attachment-only send)
 *       → rewritten to "Attachments:"
 *   (c) user message with NO text block (only image)  → leading text inserted
 *   (d) string-content blank user message  → rewritten
 *   (e) valid transcripts pass through unchanged + byte-identical (idempotent)
 *   (f) assistant / non-user blank messages are NOT touched
 *
 * Run with:
 *   npx tsx --test --test-force-exit tests/transcript-sanitizer.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sanitizeTranscriptContent } from "../src/server/agent/transcript-sanitizer.ts";

function msg(role: string, content: unknown, id = "x"): string {
	return JSON.stringify({ type: "message", id, ts: "2026-01-01T00-00-00-000Z", message: { role, content } });
}

const IMG = { type: "image", source: { data: "AAAA" } };

describe("sanitizeTranscriptContent", () => {
	it("(a) rewrites image-adjacent blank-text user message", () => {
		const line = msg("user", [{ type: "text", text: "" }, IMG]);
		const { content, changed, rewritten } = sanitizeTranscriptContent(line);
		assert.equal(changed, true);
		assert.equal(rewritten, 1);
		const parsed = JSON.parse(content);
		assert.equal(parsed.message.content[0].text, "Attachments:");
		// image block preserved
		assert.deepEqual(parsed.message.content[1], IMG);
	});

	it("(b) rewrites standalone blank-text user message", () => {
		const line = msg("user", [{ type: "text", text: "" }]);
		const { content, changed } = sanitizeTranscriptContent(line);
		assert.equal(changed, true);
		assert.equal(JSON.parse(content).message.content[0].text, "Attachments:");
	});

	it("(c) inserts leading text block when user message has only an image", () => {
		const line = msg("user", [IMG]);
		const { content, changed } = sanitizeTranscriptContent(line);
		assert.equal(changed, true);
		const blocks = JSON.parse(content).message.content;
		assert.equal(blocks[0].type, "text");
		assert.equal(blocks[0].text, "Attachments:");
		assert.deepEqual(blocks[1], IMG);
	});

	it("(d) rewrites blank string-content user message", () => {
		const line = msg("user", "   ");
		const { content, changed } = sanitizeTranscriptContent(line);
		assert.equal(changed, true);
		assert.equal(JSON.parse(content).message.content, "Attachments:");
	});

	it("(e) leaves a valid transcript byte-identical (idempotent)", () => {
		const valid = [
			msg("user", [{ type: "text", text: "hello" }]),
			msg("assistant", [{ type: "text", text: "hi" }]),
			msg("user", "plain text"),
		].join("\n");
		const first = sanitizeTranscriptContent(valid);
		assert.equal(first.changed, false);
		assert.equal(first.content, valid);
		// Re-running a sanitized output is also a no-op.
		const poisoned = msg("user", [{ type: "text", text: "" }, IMG]);
		const once = sanitizeTranscriptContent(poisoned);
		const twice = sanitizeTranscriptContent(once.content);
		assert.equal(twice.changed, false);
		assert.equal(twice.content, once.content);
	});

	it("(f) does NOT touch a blank assistant message", () => {
		const line = msg("assistant", [{ type: "text", text: "" }]);
		const { changed, content } = sanitizeTranscriptContent(line);
		assert.equal(changed, false);
		assert.equal(content, line);
	});

	it("preserves other lines and only rewrites poisoned ones in a multi-line file", () => {
		const good1 = msg("user", [{ type: "text", text: "keep me" }], "a");
		const bad = msg("user", [{ type: "text", text: "" }, IMG], "b");
		const good2 = msg("assistant", [{ type: "text", text: "reply" }], "c");
		const file = [good1, bad, good2].join("\n");
		const { content, changed, rewritten } = sanitizeTranscriptContent(file);
		assert.equal(changed, true);
		assert.equal(rewritten, 1);
		const lines = content.split("\n");
		assert.equal(lines[0], good1, "untouched good line must stay byte-identical");
		assert.equal(lines[2], good2, "untouched assistant line must stay byte-identical");
		assert.equal(JSON.parse(lines[1]).message.content[0].text, "Attachments:");
	});

	it("preserves trailing newline shape", () => {
		const file = msg("user", [{ type: "text", text: "" }, IMG]) + "\n";
		const { content } = sanitizeTranscriptContent(file);
		assert.ok(content.endsWith("\n"), "trailing newline preserved");
	});

	it("skips non-JSON and non-message lines untouched", () => {
		const file = ["not json", msg("user", "ok"), '{"type":"compaction","id":"z"}'].join("\n");
		const { content, changed } = sanitizeTranscriptContent(file);
		assert.equal(changed, false);
		assert.equal(content, file);
	});

	it("empty input is a no-op", () => {
		const { content, changed } = sanitizeTranscriptContent("");
		assert.equal(changed, false);
		assert.equal(content, "");
	});
});
