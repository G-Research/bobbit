/**
 * Lexical parity suite for the FlexSearch-backed search layer.
 *
 * Seeds a small fixed corpus and exercises expected lexical behaviour
 * (exact token, multi-word queries, case-insensitivity, rare tokens,
 * stack-trace fragments). FlexSearch ranking differs from BM25 + RRF in
 * absolute scores, but the presence / ordering invariants below should
 * hold.
 *
 * Design reference: docs/design/portable-search.md §9.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FlexSearchStore, type FlexDoc } from "../../src/server/search/flex-store.ts";

test.setTimeout(30_000);

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lex-parity-"));
}

function row(id: string, text: string, title: string | null = null): FlexDoc {
	return {
		id,
		source_id: "messages",
		project_id: "p1",
		entity_type: "message",
		parent_id: null,
		archived: false,
		archived_tag: "false",
		timestamp: 1_700_000_000_000,
		content_hash: `h-${id}`,
		weight: 1.0,
		role: "user",
		title,
		text,
		identifier_text: "",
		goal_id: null,
		session_id: "s1",
		session_title: "Session 1",
		file_path: null,
		start_line: null,
		end_line: null,
	};
}

async function seed(rows: FlexDoc[]): Promise<FlexSearchStore> {
	const dir = path.join(tmpDir(), "search.flex");
	const store = await FlexSearchStore.open({ dataDir: dir });
	await store.upsert(rows);
	return store;
}

test("exact token: 'deadbeef' → top-1 on the row containing it", async () => {
	const store = await seed([
		row("a", "normal log output with nothing special"),
		row("b", "exception thrown deadbeef overflow detected"),
		row("c", "another unrelated body of text here"),
	]);
	try {
		const res = await store.search({ q: "deadbeef", limit: 5 });
		expect(res.results.length).toBeGreaterThanOrEqual(1);
		expect(res.results[0].id).toBe("b");
	} finally {
		await store.close();
	}
});

test("multi-word query surfaces rows containing the tokens", async () => {
	const store = await seed([
		row("phrase", "we need to refactor hybrid query soon", "note"),
		row("reshuffled", "query refactor for the hybrid search legs", "note"),
		row("partial", "just a refactor, nothing else", "note"),
		row("none", "totally unrelated content"),
	]);
	try {
		const res = await store.search({ q: "refactor hybrid query", limit: 10 });
		const ids = res.results.map((r) => r.id);
		expect(ids).toContain("phrase");
		expect(ids).toContain("reshuffled");
		expect(ids[0]).not.toBe("none");
	} finally {
		await store.close();
	}
});

test("rare token: UUID-like string ranks top", async () => {
	const uuid = "550e8400-e29b-41d4-a716-446655440000";
	const store = await seed([
		row("has-uuid", `error correlation id ${uuid} captured`),
		row("no-uuid", "error logged without correlation id"),
		row("other", "completely different text"),
	]);
	try {
		const res = await store.search({ q: uuid, limit: 5 });
		expect(res.results.length).toBeGreaterThan(0);
		expect(res.results[0].id).toBe("has-uuid");
	} finally {
		await store.close();
	}
});

test("stack-trace fragment: line-unique tokens surface the matching frame", async () => {
	const store = await seed([
		row("trace-match", "Error: fail\n    at foo.bar (baz.ts:42)\n    at main (app.ts:1)"),
		row("trace-other", "Error: unrelated\n    at foo.qux (baz.ts:99)"),
		row("no-trace", "no stack traces here"),
	]);
	try {
		const res = await store.search({ q: "baz 42", limit: 5 });
		const ids = res.results.map((r) => r.id);
		expect(ids).toContain("trace-match");
		const matchIdx = ids.indexOf("trace-match");
		const noTraceIdx = ids.indexOf("no-trace");
		if (noTraceIdx !== -1) {
			expect(matchIdx).toBeLessThan(noTraceIdx);
		}
	} finally {
		await store.close();
	}
});

test("case-insensitive: uppercase query finds lowercase corpus content", async () => {
	const store = await seed([
		row("lc", "the quick brown fox jumps over the lazy dog"),
		row("other", "unrelated"),
	]);
	try {
		const res = await store.search({ q: "QUICK FOX", limit: 5 });
		expect(res.results.length).toBeGreaterThan(0);
		const ids = res.results.map((r) => r.id);
		expect(ids).toContain("lc");
	} finally {
		await store.close();
	}
});

test("identifier strict tokenization: 'SearchService' beats 'searchutils' distractor", async () => {
	const store = await seed([
		row("a", "the SearchService facade wraps FlexSearchStore nicely"),
		row("b", "miscellaneous searchUtils helpers in this module"),
	]);
	try {
		const res = await store.search({ q: "SearchService", limit: 5 });
		const ids = res.results.map((r) => r.id);
		// Row `a` must come first under the identifier field.
		expect(ids[0]).toBe("a");
	} finally {
		await store.close();
	}
});
