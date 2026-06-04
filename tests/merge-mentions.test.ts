/**
 * Unit tests for buildMergedModelText — the pure merge of slash-skill
 * expansions and @file text mentions (HIGH-2 regression: prefix-only slash
 * skills overlap @file tokens and must not double-splice / corrupt modelText).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { buildMergedModelText } = await import("../src/server/skills/merge-mentions.ts");
const { buildFileReferenceBlock } = await import("../src/server/skills/resolve-file-mentions.ts");

/** Minimal text FileMention factory. */
function textMention(p: string, content: string, range: [number, number]) {
	return { path: p, range, kind: "text" as const, content, bytes: content.length };
}

describe("buildMergedModelText", () => {
	it("no expansions/mentions → original text unchanged", () => {
		assert.equal(buildMergedModelText("hello world", [], []), "hello world");
	});

	it("inline /skill AND @file (disjoint) → both applied", () => {
		// "see /skill and @a.txt"
		const text = "see /skill and @a.txt";
		const skillStart = text.indexOf("/skill");
		const skill = { range: [skillStart, skillStart + "/skill".length] as [number, number], expanded: "SKILL-BODY" };
		const fileStart = text.indexOf("@a.txt");
		const file = textMention("a.txt", "FILE", [fileStart, fileStart + "@a.txt".length]);
		const out = buildMergedModelText(text, [skill], [file]);
		assert.equal(out, "see SKILL-BODY and " + buildFileReferenceBlock("a.txt", "FILE"));
	});

	it("HIGH-2: prefix-only /skill claiming whole range overlaps @file → skill wins, no corruption", () => {
		// "/mockup @notes.txt" — prefix-only skill range covers the whole text.
		const text = "/mockup @notes.txt";
		const skill = { range: [0, text.length] as [number, number], expanded: "EXPANDED" };
		const fileStart = text.indexOf("@notes.txt");
		const file = textMention("notes.txt", "HELLO", [fileStart, fileStart + "@notes.txt".length]);
		const out = buildMergedModelText(text, [skill], [file]);
		// Skill expansion wins for the whole message; file content is NOT inlined.
		assert.equal(out, "EXPANDED");
		assert.ok(!out.includes("file-reference"), "overlapping file mention must not be inlined");
	});

	it("multiple @file mentions splice right-to-left preserving indices", () => {
		const text = "x @a y @b z";
		const aStart = text.indexOf("@a");
		const bStart = text.indexOf("@b");
		const a = textMention("a", "A", [aStart, aStart + 2]);
		const b = textMention("b", "B", [bStart, bStart + 2]);
		const out = buildMergedModelText(text, [], [a, b]);
		assert.equal(out, "x " + buildFileReferenceBlock("a", "A") + " y " + buildFileReferenceBlock("b", "B") + " z");
	});

	it("non-text mentions (image/unresolved) never alter modelText", () => {
		const text = "look @img.png and @bad.bin";
		const img = { path: "img.png", range: [5, 12] as [number, number], kind: "image" as const, data: "x", mimeType: "image/png" };
		const bad = { path: "bad.bin", range: [18, 26] as [number, number], kind: "unresolved" as const, reason: "unsupported-binary" };
		const out = buildMergedModelText(text, [], [img, bad]);
		assert.equal(out, text);
	});
});
