/**
 * Unit test: synthesizeAttachmentText pure helper.
 *
 * The helper is the single source of truth for "image/attachment-only prompts
 * must carry a non-blank text body". It returns the synthetic phrase
 * "Attachments:" when the text is blank/whitespace-only AND at least one image
 * or attachment is present; otherwise the text is returned unchanged.
 *
 * Run with:
 *   npx tsx --test --test-force-exit tests/synthesize-attachment-text.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { synthesizeAttachmentText, ATTACHMENT_ONLY_TEXT } from "../src/server/agent/rpc-bridge.ts";

const IMG = { type: "image", data: "AAAA", mimeType: "image/png" } as const;
const ATTACH = { kind: "file", name: "doc.pdf" } as const;

describe("synthesizeAttachmentText", () => {
	it("uses the exact synthetic phrase 'Attachments:'", () => {
		assert.equal(ATTACHMENT_ONLY_TEXT, "Attachments:");
	});

	it("empty text + image → synthetic phrase", () => {
		assert.equal(synthesizeAttachmentText("", [IMG]), "Attachments:");
	});

	it("whitespace-only text + image → synthetic phrase (R4: trims first)", () => {
		assert.equal(synthesizeAttachmentText("   \n\t  ", [IMG]), "Attachments:");
	});

	it("empty text + non-image attachment (no image) → synthetic phrase", () => {
		assert.equal(synthesizeAttachmentText("", undefined, [ATTACH]), "Attachments:");
	});

	it("empty text + both image and attachment → synthetic phrase", () => {
		assert.equal(synthesizeAttachmentText("", [IMG], [ATTACH]), "Attachments:");
	});

	it("normal text → unchanged (R5)", () => {
		assert.equal(synthesizeAttachmentText("hello world"), "hello world");
	});

	it("normal text + image → unchanged (R5)", () => {
		assert.equal(synthesizeAttachmentText("describe this", [IMG]), "describe this");
	});

	it("whitespace-only text + image preserves nothing — only blank+attachment synthesizes", () => {
		// non-blank text always wins, even with attachments
		assert.equal(synthesizeAttachmentText("  x  ", [IMG]), "  x  ");
	});

	it("empty text + NO image/attachment → unchanged (UI blocks truly-empty sends)", () => {
		assert.equal(synthesizeAttachmentText(""), "");
		assert.equal(synthesizeAttachmentText("   "), "   ");
	});

	it("empty arrays count as no attachments → unchanged", () => {
		assert.equal(synthesizeAttachmentText("", [], []), "");
	});

	it("tolerates null/undefined attachment args", () => {
		assert.equal(synthesizeAttachmentText("", null, null), "");
		assert.equal(synthesizeAttachmentText("", undefined, undefined), "");
	});
});
