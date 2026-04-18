/**
 * Unit tests for `src/server/search/snippet.ts::highlight`.
 *
 * Covers the contract inherited from the FTS5 `snippet()` call we used to
 * ship: `<b>`-wrap, HTML-escape, ~300-char window centred on the earliest
 * match, edge ellipses, case-insensitive, multi-token queries.
 *
 * Runs under the unit `playwright.config.ts` (testMatch "**\/*.spec.ts",
 * testDir "."). Plain Node — no `page` fixture.
 */
import { test, expect } from "@playwright/test";
import { highlight } from "../../src/server/search/snippet.ts";

test.describe("highlight", () => {
	test("wraps matches in <b>", () => {
		const out = highlight("the quick brown fox", "quick");
		expect(out).toContain("<b>quick</b>");
	});

	test("case-insensitive match preserves original casing", () => {
		const out = highlight("The Quick Brown Fox", "quick");
		expect(out).toContain("<b>Quick</b>");
	});

	test("multi-token query wraps each hit", () => {
		const out = highlight("the quick brown fox jumps over the lazy dog", "quick fox");
		expect(out).toContain("<b>quick</b>");
		expect(out).toContain("<b>fox</b>");
	});

	test("HTML-escapes surrounding text", () => {
		const out = highlight('<script>alert("xss")</script> findme', "findme");
		expect(out).not.toContain("<script>");
		expect(out).toContain("&lt;script&gt;");
		expect(out).toContain("<b>findme</b>");
	});

	test("HTML-escapes within the matched region itself", () => {
		const out = highlight('the <b>bold</b> tag', "b");
		// Any matched "b" inside "<b>" source must not produce raw angle brackets.
		expect(out).not.toContain("<<b>");
		expect(out).toContain("&lt;");
	});

	test("centres window on earliest match with leading ellipsis", () => {
		const prefix = "x".repeat(500);
		const out = highlight(prefix + " needle " + "y".repeat(500), "needle");
		expect(out.startsWith("…")).toBe(true);
		expect(out).toContain("<b>needle</b>");
	});

	test("adds trailing ellipsis when tail is truncated", () => {
		const out = highlight("needle " + "y".repeat(1000), "needle");
		expect(out.endsWith("…")).toBe(true);
		expect(out).toContain("<b>needle</b>");
	});

	test("no ellipses when whole text fits in window", () => {
		const out = highlight("short needle text", "needle");
		expect(out.startsWith("…")).toBe(false);
		expect(out.endsWith("…")).toBe(false);
	});

	test("window roughly respects requested size", () => {
		const text = "a".repeat(200) + " needle " + "b".repeat(200);
		const out = highlight(text, "needle", { windowChars: 100 });
		// +/- ellipsis + <b></b> overhead, but window should dominate.
		expect(out.length).toBeLessThan(200);
		expect(out).toContain("<b>needle</b>");
	});

	test("no query → head-of-text preview, no <b>", () => {
		const out = highlight("hello world", "");
		expect(out).toBe("hello world");
		expect(out).not.toContain("<b>");
	});

	test("query with no matches → head preview, HTML-escaped, no <b>", () => {
		const out = highlight("<hello> world", "zzz");
		expect(out).toContain("&lt;hello&gt;");
		expect(out).not.toContain("<b>");
	});

	test("empty text → empty string", () => {
		expect(highlight("", "anything")).toBe("");
	});

	test("ignores stopword-ish boundary characters in query", () => {
		// punctuation between tokens should not be indexed as a match
		const out = highlight("find the needle", "the, needle!");
		expect(out).toContain("<b>needle</b>");
	});

	test("longer token preferred over shorter prefix at same position", () => {
		// "foobar" should beat "foo" at position 0 of "foobar"
		const out = highlight("foobar baz", "foo foobar");
		expect(out).toContain("<b>foobar</b>");
		expect(out).not.toContain("<b>foo</b>bar");
	});

	test("non-overlapping multiple matches in same window", () => {
		const out = highlight("alpha beta alpha beta", "alpha");
		const matches = out.match(/<b>alpha<\/b>/g) ?? [];
		expect(matches.length).toBe(2);
	});
});
