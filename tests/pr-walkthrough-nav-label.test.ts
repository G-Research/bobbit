import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NAV_LABEL_MAX_CHARS, NAV_LABEL_MAX_WORDS, deriveNavLabel, navLabelError } from "../src/shared/pr-walkthrough/nav-label.ts";

describe("PR walkthrough nav label", () => {
	it("exposes the documented limits", () => {
		assert.equal(NAV_LABEL_MAX_WORDS, 3);
		assert.equal(NAV_LABEL_MAX_CHARS, 24);
	});

	it("accepts labels within the word and character limits", () => {
		assert.equal(navLabelError("At a glance"), null);
		assert.equal(navLabelError("Orientation"), null);
		assert.equal(navLabelError("  Where to look  "), null);
	});

	it("rejects empty or whitespace-only labels so callers fall back to the derived label", () => {
		assert.match(navLabelError("") ?? "", /empty/);
		assert.match(navLabelError("   ") ?? "", /empty/);
	});

	it("rejects labels with more than three words", () => {
		assert.match(navLabelError("one two three four") ?? "", /3 words/);
	});

	it("rejects labels longer than the character cap", () => {
		assert.match(navLabelError("abcdefghijklmnopqrstuvwxyz") ?? "", /24 characters/);
	});

	it("derives a compact label from the prefix before a separator", () => {
		assert.equal(deriveNavLabel("render.ts: fullscreen predicate"), "render.ts");
		assert.equal(deriveNavLabel("Schema — validation rules"), "Schema");
		assert.equal(deriveNavLabel("Panel - rail simplification"), "Panel");
	});

	it("uses the whole title when no usable separator prefix exists", () => {
		assert.equal(deriveNavLabel("Agent submits YAML"), "Agent submits YAML");
		assert.equal(deriveNavLabel("Just three words"), "Just three words");
	});

	it("keeps only the first three words", () => {
		assert.equal(deriveNavLabel("one two three four five"), "one two three");
	});

	it("hard-truncates long single-prefix labels to 23 chars plus an ellipsis", () => {
		const derived = deriveNavLabel("supercalifragilisticexpialidocious");
		assert.equal(derived.length, NAV_LABEL_MAX_CHARS);
		assert.ok(derived.endsWith("…"));
	});

	it("returns an empty string for blank titles", () => {
		assert.equal(deriveNavLabel("   "), "");
	});
});
