import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/search/snippet-highlight.spec.ts (v2-dom tier).
// Pure-logic unit test for the REAL `highlight` from src/server/search/snippet.ts.
// No DOM — the bridge import is present for tier uniformity only.
import { describe, expect, it } from "vitest";
import { highlight } from "../../../src/server/search/snippet.js";

describe("highlight", () => {
	it("wraps matches in <b>", () => {
		const out = highlight("the quick brown fox", "quick");
		expect(out).toContain("<b>quick</b>");
	});

	it("case-insensitive match preserves original casing", () => {
		const out = highlight("The Quick Brown Fox", "quick");
		expect(out).toContain("<b>Quick</b>");
	});

	it("multi-token query wraps each hit", () => {
		const out = highlight("the quick brown fox jumps over the lazy dog", "quick fox");
		expect(out).toContain("<b>quick</b>");
		expect(out).toContain("<b>fox</b>");
	});

	it("HTML-escapes surrounding text", () => {
		const out = highlight('<script>alert("xss")</script> findme', "findme");
		expect(out).not.toContain("<script>");
		expect(out).toContain("&lt;script&gt;");
		expect(out).toContain("<b>findme</b>");
	});

	it("HTML-escapes within the matched region itself", () => {
		const out = highlight('the <b>bold</b> tag', "b");
		// Any matched "b" inside "<b>" source must not produce raw angle brackets.
		expect(out).not.toContain("<<b>");
		expect(out).toContain("&lt;");
	});

	it("centres window on earliest match with leading ellipsis", () => {
		const prefix = "x".repeat(500);
		const out = highlight(prefix + " needle " + "y".repeat(500), "needle");
		expect(out.startsWith("…")).toBe(true);
		expect(out).toContain("<b>needle</b>");
	});

	it("adds trailing ellipsis when tail is truncated", () => {
		const out = highlight("needle " + "y".repeat(1000), "needle");
		expect(out.endsWith("…")).toBe(true);
		expect(out).toContain("<b>needle</b>");
	});

	it("no ellipses when whole text fits in window", () => {
		const out = highlight("short needle text", "needle");
		expect(out.startsWith("…")).toBe(false);
		expect(out.endsWith("…")).toBe(false);
	});

	it("window roughly respects requested size", () => {
		const text = "a".repeat(200) + " needle " + "b".repeat(200);
		const out = highlight(text, "needle", { windowChars: 100 });
		// +/- ellipsis + <b></b> overhead, but window should dominate.
		expect(out.length).toBeLessThan(200);
		expect(out).toContain("<b>needle</b>");
	});

	it("no query → head-of-text preview, no <b>", () => {
		const out = highlight("hello world", "");
		expect(out).toBe("hello world");
		expect(out).not.toContain("<b>");
	});

	it("query with no matches → head preview, HTML-escaped, no <b>", () => {
		const out = highlight("<hello> world", "zzz");
		expect(out).toContain("&lt;hello&gt;");
		expect(out).not.toContain("<b>");
	});

	it("empty text → empty string", () => {
		expect(highlight("", "anything")).toBe("");
	});

	it("ignores stopword-ish boundary characters in query", () => {
		// punctuation between tokens should not be indexed as a match
		const out = highlight("find the needle", "the, needle!");
		expect(out).toContain("<b>needle</b>");
	});

	it("longer token preferred over shorter prefix at same position", () => {
		// "foobar" should beat "foo" at position 0 of "foobar"
		const out = highlight("foobar baz", "foo foobar");
		expect(out).toContain("<b>foobar</b>");
		expect(out).not.toContain("<b>foo</b>bar");
	});

	it("non-overlapping multiple matches in same window", () => {
		const out = highlight("alpha beta alpha beta", "alpha");
		const matches = out.match(/<b>alpha<\/b>/g) ?? [];
		expect(matches.length).toBe(2);
	});
});
