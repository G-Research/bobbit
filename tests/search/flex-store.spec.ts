/**
 * Core FlexSearchStore behaviour:
 *   - upsert / search round-trip
 *   - persistence across reopen
 *   - deleteByIds + parent_id chunk cascade
 *   - deleteWhere (session sweep)
 *   - clear
 *   - BM25 identifier ranking (camel/snake/kebab/path forms)
 *   - weight post-multiplier
 *   - recency boost
 *   - parent_id collapse keeps highest-scoring chunk
 *   - corrupt index file on open is tolerated
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	FlexSearchStore,
	extractIdentifierTokens,
	recencyMultiplier,
	type FlexDoc,
} from "../../src/server/search/flex-store.ts";

function tmp(prefix = "flex-store-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function doc(overrides: Partial<FlexDoc> & { id: string; text: string }): FlexDoc {
	return {
		id: overrides.id,
		source_id: overrides.source_id ?? "messages",
		project_id: overrides.project_id ?? "p1",
		entity_type: overrides.entity_type ?? "message",
		parent_id: overrides.parent_id ?? null,
		archived: overrides.archived ?? false,
		archived_tag: (overrides.archived ? "true" : "false") as "true" | "false",
		timestamp: overrides.timestamp ?? 1_700_000_000_000,
		content_hash: overrides.content_hash ?? `${overrides.id}:h`,
		weight: overrides.weight ?? 1.0,
		role: overrides.role ?? null,
		title: overrides.title ?? null,
		text: overrides.text,
		identifier_text: overrides.identifier_text ?? "",
		goal_id: overrides.goal_id ?? null,
		session_id: overrides.session_id ?? null,
		session_title: overrides.session_title ?? null,
		file_path: overrides.file_path ?? null,
		start_line: overrides.start_line ?? null,
		end_line: overrides.end_line ?? null,
	};
}

test("open → upsert → search round-trip", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	try {
		await store.upsert([
			doc({ id: "a", text: "hello world goal one" }),
			doc({ id: "b", text: "entirely different subject" }),
		]);
		const res = await store.search({ q: "hello" });
		expect(res.results.length).toBeGreaterThanOrEqual(1);
		expect(res.results.map((r) => r.id)).toContain("a");
	} finally {
		await store.close();
	}
});

test("persistence across reopen", async () => {
	const dir = tmp("flex-persist-");
	const a = await FlexSearchStore.open({ dataDir: dir });
	await a.upsert([
		doc({ id: "g1", source_id: "goals", entity_type: "goal", text: "portable search engine swap" }),
		doc({ id: "g2", source_id: "goals", entity_type: "goal", text: "unrelated goal" }),
	]);
	await a.close();

	const b = await FlexSearchStore.open({ dataDir: dir });
	try {
		expect(b.count()).toBe(2);
		const res = await b.search({ q: "portable" });
		expect(res.results.map((r) => r.id)).toContain("g1");
	} finally {
		await b.close();
	}
});

test("deleteByIds cascades to chunk rows via parent_id", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	try {
		await store.upsert([
			doc({ id: "parent", text: "parent" }),
			doc({ id: "parent:chunk:0", parent_id: "parent", text: "first" }),
			doc({ id: "parent:chunk:1", parent_id: "parent", text: "second" }),
			doc({ id: "other", text: "other" }),
		]);
		expect(store.count()).toBe(4);
		await store.deleteByIds(["parent"]);
		expect(store.count()).toBe(1);
		expect(store.getById("other")).not.toBeNull();
	} finally {
		await store.close();
	}
});

test("deleteWhere sweeps messages for a session", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	try {
		await store.upsert([
			doc({ id: "m1", source_id: "messages", session_id: "sX", text: "hi" }),
			doc({ id: "m2", source_id: "messages", session_id: "sX", text: "hello" }),
			doc({ id: "m3", source_id: "messages", session_id: "sY", text: "other" }),
			doc({ id: "s1", source_id: "sessions", session_id: "sX", text: "session title" }),
		]);
		await store.deleteWhere({ session_id: "sX", source_id: "messages" });
		expect(store.count()).toBe(2);
		expect(store.getById("m1")).toBeNull();
		expect(store.getById("m2")).toBeNull();
		expect(store.getById("m3")).not.toBeNull();
		expect(store.getById("s1")).not.toBeNull();
	} finally {
		await store.close();
	}
});

test("clear removes everything", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	try {
		await store.upsert([doc({ id: "a", text: "x" }), doc({ id: "b", text: "y" })]);
		expect(store.count()).toBe(2);
		await store.clear();
		expect(store.count()).toBe(0);
		const res = await store.search({ q: "x" });
		expect(res.results).toEqual([]);
	} finally {
		await store.close();
	}
});

test("identifier tokenization recognises camel/snake/kebab/path forms", () => {
	const text = "class SearchService and search_service and search-service and src/server/search/service";
	const tokens = extractIdentifierTokens(text);
	expect(tokens).toContain("SearchService");
	expect(tokens).toContain("Search");
	expect(tokens).toContain("Service");
	expect(tokens).toContain("search_service");
	expect(tokens).toContain("search-service");
});

test("identifier field finds SearchService across multiple query forms", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	try {
		await store.upsert([
			doc({ id: "a", title: "SearchService overview", text: "The SearchService facade wraps FlexSearchStore." }),
			doc({ id: "b", title: "unrelated", text: "Nothing about the subject." }),
		]);
		for (const q of ["SearchService", "searchservice", "Search", "Service"]) {
			const res = await store.search({ q });
			expect(res.results.map((r) => r.id), `query ${q}`).toContain("a");
		}
	} finally {
		await store.close();
	}
});

test("weight post-multiplier: higher weight outranks equal-BM25 lower weight", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	try {
		await store.upsert([
			doc({ id: "lo", text: "widget", weight: 0.5, timestamp: 1_000 }),
			doc({ id: "hi", text: "widget", weight: 3.0, timestamp: 1_000 }),
		]);
		const res = await store.search({ q: "widget" });
		const ids = res.results.map((r) => r.id);
		expect(ids.indexOf("hi")).toBeLessThan(ids.indexOf("lo"));
	} finally {
		await store.close();
	}
});

test("recency multiplier: fresh > stale", () => {
	const now = 2_000_000_000_000;
	const fresh = recencyMultiplier(now, now);
	const stale = recencyMultiplier(0, now);
	expect(fresh).toBeGreaterThan(stale);
	// Fresh ≈ 1.2, stale ≈ 1.0 (decay effectively complete).
	expect(fresh).toBeGreaterThan(1.1);
	expect(stale).toBeLessThanOrEqual(1.01);
});

test("parent_id collapse keeps the single best chunk per parent", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	try {
		await store.upsert([
			doc({ id: "p:chunk:0", parent_id: "p", title: "Shared title", text: "widget widget widget" }),
			doc({ id: "p:chunk:1", parent_id: "p", title: "Shared title", text: "widget" }),
			doc({ id: "other", text: "unrelated" }),
		]);
		const res = await store.search({ q: "widget" });
		// Exactly one hit carrying parent "p".
		const pHits = res.results.filter((r) => r.parentId === "p");
		expect(pHits.length).toBe(1);
	} finally {
		await store.close();
	}
});

test("corrupt index file is tolerated on open", async () => {
	const dir = tmp();
	const indexDir = path.join(dir, "index");
	fs.mkdirSync(indexDir, { recursive: true });
	fs.writeFileSync(path.join(indexDir, "reg.json"), "{not valid json");
	const store = await FlexSearchStore.open({ dataDir: dir });
	try {
		// Count reports 0; search succeeds without throwing.
		expect(store.count()).toBe(0);
		const res = await store.search({ q: "anything" });
		expect(res.results).toEqual([]);
	} finally {
		await store.close();
	}
});

test("tag filter: archived excluded by default, included when requested", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	try {
		await store.upsert([
			doc({ id: "live", text: "widget", archived: false }),
			doc({ id: "dead", text: "widget", archived: true }),
		]);
		const hidden = await store.search({ q: "widget" });
		expect(hidden.results.map((r) => r.id)).not.toContain("dead");
		const visible = await store.search({ q: "widget", includeArchived: true });
		expect(visible.results.map((r) => r.id)).toContain("dead");
	} finally {
		await store.close();
	}
});

test("empty query short-circuits to empty results", async () => {
	const dir = tmp();
	const store = await FlexSearchStore.open({ dataDir: dir });
	try {
		await store.upsert([doc({ id: "a", text: "hello" })]);
		const res = await store.search({ q: "" });
		expect(res.results).toEqual([]);
		expect(res.total).toBe(0);
	} finally {
		await store.close();
	}
});

test("meta.json roundtrips across open", async () => {
	const dir = tmp();
	const a = await FlexSearchStore.open({ dataDir: dir });
	await a.writeMeta({
		engine: "flexsearch",
		engineVersion: "0.8.158",
		schemaVersion: 2,
		contentPolicyVersion: 1,
		createdAt: 1_700_000_000_000,
	});
	await a.close();
	const b = await FlexSearchStore.open({ dataDir: dir });
	try {
		const meta = await b.readMeta();
		expect(meta).not.toBeNull();
		expect(meta!.engine).toBe("flexsearch");
		expect(meta!.createdAt).toBe(1_700_000_000_000);
	} finally {
		await b.close();
	}
});
