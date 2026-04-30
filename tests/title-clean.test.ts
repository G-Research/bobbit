/**
 * Unit tests for cleanTitle() — extraction strategy for naming-model output.
 *
 * The naming-model prompt asks for output wrapped in <title>…</title>. cleanTitle
 * needs to:
 *   1. Prefer the LAST <title>…</title> block (so models that mention the tag in
 *      reasoning preamble before emitting the real one still parse correctly).
 *   2. Fall back to the last short non-empty line for models that ignored the tag.
 *   3. Strip emojis, surrounding quotes, leading hashes; truncate at 30 chars.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanTitle } from "../src/server/agent/title-generator.js";

describe("cleanTitle", () => {
	it("extracts a plain <title> block", () => {
		assert.equal(cleanTitle("<title>Fix Login Bug</title>"), "Fix Login Bug");
	});

	it("uses the LAST <title> block when multiple appear", () => {
		const raw = "Let me think... I could write <title>Wrong Guess</title> or <title>Real Answer</title>";
		assert.equal(cleanTitle(raw), "Real Answer");
	});

	it("handles <title> on its own line after reasoning", () => {
		const raw = "First I'll consider the topic.\nLooks like a parser fix.\n<title>CSV Parser</title>";
		assert.equal(cleanTitle(raw), "CSV Parser");
	});

	it("falls back to the last short line when <title> is missing", () => {
		const raw = "The user is asking about Redis configuration. Let me pick a label.\nRedis Setup";
		assert.equal(cleanTitle(raw), "Redis Setup");
	});

	it("ignores long lines when falling back", () => {
		const raw =
			"This is a really long reasoning line that should not be picked because it clearly exceeds the eighty character ceiling we set\nDark Mode";
		assert.equal(cleanTitle(raw), "Dark Mode");
	});

	it("falls back to first line when no short lines exist", () => {
		// Single very-long line: no short candidates, no <title>; legacy fallback to first line normalized.
		const raw = "A".repeat(100);
		const result = cleanTitle(raw);
		assert.equal(result.length, 28); // 27 chars + 1-char ellipsis
		assert.ok(result.endsWith("…"));
	});

	it("strips surrounding quotes and leading hashes", () => {
		assert.equal(cleanTitle('<title>"Quoted Label"</title>'), "Quoted Label");
		assert.equal(cleanTitle("<title># Heading Label</title>"), "Heading Label");
	});

	it("strips emoji from inside <title>", () => {
		assert.equal(cleanTitle("<title>🚀 Launch Plan</title>"), "Launch Plan");
	});

	it("truncates titles longer than 30 chars with ellipsis", () => {
		const long = "Refactor the authentication subsystem completely";
		const out = cleanTitle(`<title>${long}</title>`);
		assert.equal(out.length, 28); // 27 chars + 1-char ellipsis
		assert.ok(out.endsWith("…"));
		assert.ok(out.startsWith("Refactor the authentication"));
	});

	it("returns empty string for empty input", () => {
		assert.equal(cleanTitle(""), "");
	});

	it("collapses whitespace inside <title>", () => {
		assert.equal(cleanTitle("<title>  Multi   Word  </title>"), "Multi Word");
	});

	it("is case-insensitive on tag matching", () => {
		assert.equal(cleanTitle("<TITLE>Big Caps</TITLE>"), "Big Caps");
	});
});
