/**
 * Unit tests for `src/server/search/chunker.ts::chunkText`.
 *
 * Covers: empty, whitespace-only, single short text, exactly-maxTokens,
 * 2001 tokens → 2 chunks with verifiable overlap, deterministic ids.
 *
 * Design reference: docs/design/semantic-search.md §6 (Chunking).
 */
import { test, expect } from "@playwright/test";
import { chunkText } from "../../src/server/search/chunker.ts";

/** Fake token counter: 1 token per whitespace-separated word. */
const wordCount = (s: string): number => {
	const t = s.trim();
	if (!t) return 0;
	return t.split(/\s+/).length;
};

test("empty string → []", () => {
	expect(chunkText("", "p", { countTokens: wordCount })).toEqual([]);
});

test("whitespace-only → []", () => {
	expect(chunkText("   \n\t  ", "p", { countTokens: wordCount })).toEqual([]);
});

test("short text → single chunk with deterministic id", () => {
	const chunks = chunkText("hello world", "parent", { countTokens: wordCount });
	expect(chunks.length).toBe(1);
	expect(chunks[0].id).toBe("parent:chunk:0");
	expect(chunks[0].index).toBe(0);
	expect(chunks[0].text).toBe("hello world");
	expect(chunks[0].tokenCount).toBe(2);
});

test("exactly maxTokens → 1 chunk", () => {
	const words = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(" ");
	const chunks = chunkText(words, "p", {
		countTokens: wordCount,
		maxTokens: 2000,
		overlap: 200,
	});
	expect(chunks.length).toBe(1);
	expect(chunks[0].id).toBe("p:chunk:0");
	expect(chunks[0].tokenCount).toBe(2000);
});

test("2001 tokens → 2 chunks with verifiable overlap", () => {
	const words = Array.from({ length: 2001 }, (_, i) => `w${i}`);
	const text = words.join(" ");
	const chunks = chunkText(text, "p", {
		countTokens: wordCount,
		maxTokens: 2000,
		overlap: 200,
	});
	expect(chunks.length).toBe(2);
	expect(chunks[0].id).toBe("p:chunk:0");
	expect(chunks[1].id).toBe("p:chunk:1");
	expect(chunks[0].index).toBe(0);
	expect(chunks[1].index).toBe(1);
	expect(chunks[0].tokenCount).toBe(2000);

	// First chunk covers words[0..1999].
	const firstWords = chunks[0].text.split(" ");
	expect(firstWords.length).toBe(2000);
	expect(firstWords[0]).toBe("w0");
	expect(firstWords[1999]).toBe("w1999");

	// Second chunk starts 200 tokens before the cut (word 1800).
	const secondWords = chunks[1].text.split(" ");
	expect(secondWords[0]).toBe("w1800");
	expect(secondWords[secondWords.length - 1]).toBe("w2000");
	expect(chunks[1].tokenCount).toBe(secondWords.length);

	// Verifiable overlap: last 200 tokens of chunk[0] == first 200 tokens of chunk[1].
	const tailOfFirst = firstWords.slice(firstWords.length - 200);
	const headOfSecond = secondWords.slice(0, 200);
	expect(tailOfFirst).toEqual(headOfSecond);
});

test("deterministic ids across invocations", () => {
	const text = Array.from({ length: 5000 }, (_, i) => `w${i}`).join(" ");
	const opts = { countTokens: wordCount, maxTokens: 1000, overlap: 100 };
	const a = chunkText(text, "parent-x", opts);
	const b = chunkText(text, "parent-x", opts);
	expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
	expect(a.map((c) => c.text)).toEqual(b.map((c) => c.text));
	for (let i = 0; i < a.length; i++) {
		expect(a[i].id).toBe(`parent-x:chunk:${i}`);
		expect(a[i].index).toBe(i);
	}
});

test("single short text idempotent", () => {
	const opts = { countTokens: wordCount };
	const a = chunkText("lorem ipsum", "pid", opts);
	const b = chunkText("lorem ipsum", "pid", opts);
	expect(a).toEqual(b);
});
