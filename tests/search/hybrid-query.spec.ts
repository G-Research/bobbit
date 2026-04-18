/**
 * Unit tests for `src/server/search/hybrid-query.ts`.
 *
 * Exercises the real LanceDB native binary against a tmp dir, using a
 * test-only concept-map embedder so the vector leg is deterministic
 * and meaningful (related concepts cluster). The lexical leg uses the
 * real Tantivy FTS index.
 *
 * Design reference: docs/design/semantic-search.md §3, §7, §12.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
	LanceStore,
	EMBED_DIM,
	type ContentRow,
} from "../../src/server/search/lance-store.ts";
import { HybridQuery, buildFilter } from "../../src/server/search/hybrid-query.ts";
import type { Embedder, Indexable, SearchQuery } from "../../src/server/search/types.ts";

// Real native binary is slow; budget generously.
test.setTimeout(90_000);

// ── Helpers ──────────────────────────────────────────────────────────

function makeTmpDir(prefix = "hybrid-query-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Concept-map embedder for tests.
 *
 * Each "concept" (e.g. "story") reserves a small contiguous block of
 * dimensions. Texts mentioning that concept (via any of its surface
 * forms) get a unit spike in that block. Unrelated texts land in a
 * different block. This gives us a deterministic, explainable vector
 * space where we can assert "query 'story' ranks all story-adjacent
 * docs above unrelated docs" without paying the cost (or flakiness) of
 * a real ONNX model.
 *
 * The mapping is case-insensitive substring match. Duplicate concepts
 * add more spikes; the result is L2-normalised.
 */
function createConceptEmbedder(conceptMap: Record<string, string[]>): Embedder {
	const concepts = Object.keys(conceptMap);
	if (concepts.length * 8 > EMBED_DIM) {
		throw new Error("concept map too large for EMBED_DIM");
	}
	function embedOne(text: string): Float32Array {
		const v = new Float32Array(EMBED_DIM);
		const lower = text.toLowerCase();
		let hit = false;
		for (let ci = 0; ci < concepts.length; ci++) {
			const surfaces = conceptMap[concepts[ci]];
			for (const s of surfaces) {
				if (lower.includes(s.toLowerCase())) {
					// 8-dim block per concept, all ones.
					for (let k = 0; k < 8; k++) v[ci * 8 + k] += 1.0;
					hit = true;
					break;
				}
			}
		}
		if (!hit) {
			// Fall back to a deterministic hash-based noise so unrelated
			// docs sit far from every concept.
			const h = createHash("sha256").update(text).digest();
			for (let i = 0; i < EMBED_DIM; i++) {
				v[i] = (h[i % h.length] / 255) * 0.01;
			}
		}
		// L2 normalise.
		let s = 0;
		for (let i = 0; i < EMBED_DIM; i++) s += v[i] * v[i];
		const norm = Math.sqrt(s) || 1;
		for (let i = 0; i < EMBED_DIM; i++) v[i] = v[i] / norm;
		return v;
	}
	return {
		id: "concept-embedder-test",
		dim: EMBED_DIM,
		async ready() {},
		async embed(texts) {
			return texts.map(embedOne);
		},
		countTokens(text) {
			return Math.ceil(text.length / 4);
		},
	};
}

function makeRow(overrides: Partial<ContentRow> & {
	id: string;
	text: string;
	embedding: Float32Array | number[];
}): ContentRow {
	return {
		source_id: "messages",
		project_id: "p1",
		entity_type: "message",
		parent_id: null,
		archived: false,
		timestamp: 1_700_000_000_000,
		content_hash: `hash-${overrides.id}`,
		weight: 1.0,
		role: "user",
		title: null,
		goal_id: null,
		session_id: "s1",
		session_title: "Session 1",
		file_path: null,
		start_line: null,
		end_line: null,
		...overrides,
	};
}

async function seedStore(opts: {
	dataDir: string;
	embedder: Embedder;
	rows: Array<{
		id: string;
		text: string;
		title?: string | null;
		source_id?: Indexable["sourceId"];
		weight?: number;
		archived?: boolean;
		parent_id?: string | null;
		project_id?: string;
	}>;
}): Promise<LanceStore> {
	const store = await LanceStore.open({ dataDir: opts.dataDir, embedDim: EMBED_DIM });
	const vecs = await opts.embedder.embed(
		opts.rows.map((r) => "search_document: " + r.text),
		"document",
	);
	const contentRows: ContentRow[] = opts.rows.map((r, i) =>
		makeRow({
			id: r.id,
			text: r.text,
			title: r.title ?? null,
			source_id: r.source_id ?? "messages",
			weight: r.weight ?? 1.0,
			archived: r.archived ?? false,
			parent_id: r.parent_id ?? null,
			project_id: r.project_id ?? "p1",
			embedding: vecs[i],
		}),
	);
	await store.upsert(contentRows);
	return store;
}

// ── buildFilter (pure) ──────────────────────────────────────────────

test("buildFilter: no projectId, archived excluded by default", () => {
	const sql = buildFilter({ q: "x" });
	expect(sql).toBe("archived = false");
});

test("buildFilter: includeArchived + no other filters → TRUE", () => {
	expect(buildFilter({ q: "x", includeArchived: true })).toBe("TRUE");
});

test("buildFilter: projectId only (with archived excluded)", () => {
	expect(buildFilter({ q: "x", projectId: "proj-1" })).toBe(
		"project_id = 'proj-1' AND archived = false",
	);
});

test("buildFilter: types list", () => {
	expect(buildFilter({ q: "x", includeArchived: true, types: ["goals", "messages"] })).toBe(
		"source_id IN ('goals','messages')",
	);
});

test("buildFilter: all combinations together", () => {
	expect(
		buildFilter({
			q: "x",
			projectId: "proj-1",
			includeArchived: false,
			types: ["sessions"],
		}),
	).toBe("project_id = 'proj-1' AND archived = false AND source_id IN ('sessions')");
});

test("buildFilter: escapes single quotes in projectId", () => {
	expect(buildFilter({ q: "x", includeArchived: true, projectId: "a'b" })).toBe(
		"project_id = 'a''b'",
	);
});

// ── Empty query ─────────────────────────────────────────────────────

test("search: empty query returns zero results without embedding", async () => {
	const dir = path.join(makeTmpDir(), "search.lance");
	const embedder = createConceptEmbedder({ story: ["story"] });
	const store = await seedStore({
		dataDir: dir,
		embedder,
		rows: [{ id: "r1", text: "hello story", title: "t" }],
	});
	// Spy on embed calls: create a wrapper that counts.
	let embedCalls = 0;
	const spyEmbedder: Embedder = {
		...embedder,
		async embed(texts, kind) {
			embedCalls++;
			return embedder.embed(texts, kind);
		},
	};
	const hq = new HybridQuery({ lance: store, embedder: spyEmbedder });
	const res = await hq.search({ q: "" });
	expect(res.total).toBe(0);
	expect(res.results).toEqual([]);
	expect(embedCalls).toBe(0);
	const res2 = await hq.search({ q: "   " });
	expect(res2.total).toBe(0);
	expect(embedCalls).toBe(0);
	await store.close();
});

// ── Paraphrase / vector leg ─────────────────────────────────────────

test("paraphrase: query 'story' surfaces story / stories / narrative / user journey", async () => {
	const dir = path.join(makeTmpDir(), "search.lance");
	const embedder = createConceptEmbedder({
		// All four surface forms share the same concept block → cluster
		// in the fake embedding space. Unrelated doc lands elsewhere.
		story: ["story", "stories", "narrative", "user journey"],
		unrelated: ["database", "compiler"],
	});
	const rows = [
		{ id: "story", text: "the user wrote a story about adventure", title: "Story doc" },
		{ id: "stories", text: "we read many stories each night", title: "Stories doc" },
		{ id: "narrative", text: "the narrative flows well", title: "Narrative doc" },
		{ id: "journey", text: "this user journey is confusing", title: "Journey doc" },
		{ id: "db", text: "database schema migration", title: "DB doc" },
		{ id: "cc", text: "compiler optimisation", title: "Compiler doc" },
	];
	const store = await seedStore({ dataDir: dir, embedder, rows });
	const hq = new HybridQuery({ lance: store, embedder });
	const res = await hq.search({ q: "story", limit: 10 });

	const topIds = res.results.slice(0, 4).map((r) => r.id);
	// All four story-family docs should appear in the top 4 (order may
	// vary because FTS favours lexical matches, vector favours semantic).
	for (const id of ["story", "stories", "narrative", "journey"]) {
		expect(topIds).toContain(id);
	}
	await store.close();
});

// ── Lexical dominance ──────────────────────────────────────────────

test("lexical: rare exact phrase ranks top via hybrid+RRF", async () => {
	const dir = path.join(makeTmpDir(), "search.lance");
	// Concept map clusters everything equally so only FTS distinguishes.
	const embedder = createConceptEmbedder({ x: ["log", "rare", "marker"] });
	const rareToken = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
	const rows = [
		{ id: "r1", text: `log line with marker ${rareToken}`, title: "Log 1" },
		{ id: "r2", text: "log line with marker but different uuid", title: "Log 2" },
		{ id: "r3", text: "another rare log line", title: "Log 3" },
		{ id: "r4", text: "totally different content", title: "Other" },
	];
	const store = await seedStore({ dataDir: dir, embedder, rows });
	const hq = new HybridQuery({ lance: store, embedder });
	const res = await hq.search({ q: rareToken, limit: 10 });
	expect(res.results.length).toBeGreaterThan(0);
	expect(res.results[0].id).toBe("r1");
	await store.close();
});

// ── Weight application ─────────────────────────────────────────────

test("weight: higher-weight row outranks equal-relevance lower-weight row", async () => {
	const dir = path.join(makeTmpDir(), "search.lance");
	// Identical concept mapping → near-identical vector relevance.
	const embedder = createConceptEmbedder({ match: ["match"] });
	const rows = [
		{ id: "low", text: "this is a match phrase", title: "low", weight: 1.0 },
		{ id: "high", text: "this is a match phrase", title: "high", weight: 2.0 },
	];
	const store = await seedStore({ dataDir: dir, embedder, rows });
	const hq = new HybridQuery({ lance: store, embedder });
	const res = await hq.search({ q: "match", limit: 10 });
	expect(res.results.length).toBe(2);
	// high should outrank low purely because of the weight multiplier.
	expect(res.results[0].id).toBe("high");
	expect(res.results[1].id).toBe("low");
	expect(res.results[0].score).toBeGreaterThan(res.results[1].score);
	await store.close();
});

// ── Chunk collapse ────────────────────────────────────────────────

test("collapse: three chunks sharing parent_id collapse to one result", async () => {
	const dir = path.join(makeTmpDir(), "search.lance");
	const embedder = createConceptEmbedder({ x: ["chunked", "message"] });
	const rows = [
		{ id: "foo:chunk:0", parent_id: "foo", text: "chunk 0 of the chunked message", title: "t" },
		{ id: "foo:chunk:1", parent_id: "foo", text: "chunk 1 of the chunked message", title: "t" },
		{ id: "foo:chunk:2", parent_id: "foo", text: "chunk 2 of the chunked message", title: "t" },
		{ id: "bar", parent_id: null, text: "an unrelated message body", title: "bar" },
	];
	const store = await seedStore({ dataDir: dir, embedder, rows });
	const hq = new HybridQuery({ lance: store, embedder });
	const res = await hq.search({ q: "chunked message", limit: 10 });
	const foos = res.results.filter((r) => r.parentId === "foo" || r.id === "foo");
	expect(foos.length).toBe(1);
	// Survivor carries the parentId so the UI can route to the parent.
	expect(foos[0].parentId).toBe("foo");
	await store.close();
});

// ── Filters ───────────────────────────────────────────────────────

test("filter: types restricts results to named sources", async () => {
	const dir = path.join(makeTmpDir(), "search.lance");
	const embedder = createConceptEmbedder({ alpha: ["alpha"] });
	const rows = [
		{ id: "g1", text: "alpha in a goal", title: "Goal", source_id: "goals" as const },
		{ id: "s1", text: "alpha in a session", title: "Session", source_id: "sessions" as const },
		{ id: "m1", text: "alpha in a message", title: "Message", source_id: "messages" as const },
	];
	const store = await seedStore({ dataDir: dir, embedder, rows });
	const hq = new HybridQuery({ lance: store, embedder });
	const res = await hq.search({ q: "alpha", types: ["goals"], limit: 10 });
	expect(res.results.length).toBe(1);
	expect(res.results[0].id).toBe("g1");
	expect(res.results[0].type).toBe("goal");
	await store.close();
});

test("filter: archived excluded by default, surfaced when includeArchived", async () => {
	const dir = path.join(makeTmpDir(), "search.lance");
	const embedder = createConceptEmbedder({ beta: ["beta"] });
	const rows = [
		{ id: "live", text: "beta live row", title: "live", archived: false },
		{ id: "dead", text: "beta archived row", title: "dead", archived: true },
	];
	const store = await seedStore({ dataDir: dir, embedder, rows });
	const hq = new HybridQuery({ lance: store, embedder });

	const resDefault = await hq.search({ q: "beta", limit: 10 });
	expect(resDefault.results.map((r) => r.id)).toEqual(["live"]);

	const resArchived = await hq.search({ q: "beta", includeArchived: true, limit: 10 });
	const ids = resArchived.results.map((r) => r.id).sort();
	expect(ids).toEqual(["dead", "live"]);
	await store.close();
});

test("filter: projectId restricts to a single project", async () => {
	const dir = path.join(makeTmpDir(), "search.lance");
	const embedder = createConceptEmbedder({ gamma: ["gamma"] });
	const rows = [
		{ id: "p1-row", text: "gamma in project one", title: "p1", project_id: "p1" },
		{ id: "p2-row", text: "gamma in project two", title: "p2", project_id: "p2" },
	];
	const store = await seedStore({ dataDir: dir, embedder, rows });
	const hq = new HybridQuery({ lance: store, embedder });
	const res = await hq.search({ q: "gamma", projectId: "p2", limit: 10 });
	expect(res.results.map((r) => r.id)).toEqual(["p2-row"]);
	await store.close();
});

// ── Result shape / snippet ────────────────────────────────────────

test("result shape: snippet wraps query term in <b>, metadata threaded through", async () => {
	const dir = path.join(makeTmpDir(), "search.lance");
	const embedder = createConceptEmbedder({ kw: ["keyword"] });
	const rows = [
		{
			id: "m1",
			text: "a sentence containing the keyword for highlighting",
			title: "Msg title",
		},
	];
	const store = await seedStore({ dataDir: dir, embedder, rows });
	const hq = new HybridQuery({ lance: store, embedder });
	const res = await hq.search({ q: "keyword", limit: 10 });
	expect(res.results.length).toBe(1);
	const r = res.results[0];
	expect(r.id).toBe("m1");
	expect(r.title).toBe("Msg title");
	expect(r.type).toBe("message");
	expect(r.snippet).toContain("<b>keyword</b>");
	expect(r.sessionId).toBe("s1");
	expect(r.projectId).toBe("p1");
	await store.close();
});
