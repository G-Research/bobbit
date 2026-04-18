/**
 * Unit test for the post-rank weight multiplier applied by
 * `HybridQuery`. Per design §5 + §7 + §12: at equal base relevance, a
 * higher-weighted row must outrank a lower-weighted one.
 *
 * This is a focused regression guard — the same concept is re-tested
 * end-to-end in hybrid-query.spec.ts, but that test goes through the
 * FTS+vector machinery. This one drops a synthetic pair of rows with
 * identical text so BM25 cannot break the tie; all ordering must come
 * from the weight multiplier.
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
import { HybridQuery } from "../../src/server/search/hybrid-query.ts";
import type { Embedder } from "../../src/server/search/types.ts";

test.setTimeout(60_000);

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "weight-apply-test-"));
}

function conceptEmbedder(): Embedder {
	function embedOne(text: string): Float32Array {
		const v = new Float32Array(EMBED_DIM);
		const h = createHash("sha256").update(text).digest();
		for (let i = 0; i < EMBED_DIM; i++) {
			v[i] = (h[i % h.length] / 255) * 0.01;
		}
		// If text contains "alpha", spike a concept block so the query
		// vector has a target to lock onto.
		if (text.toLowerCase().includes("alpha")) {
			for (let k = 0; k < 8; k++) v[k] += 1.0;
		}
		let s = 0;
		for (let i = 0; i < EMBED_DIM; i++) s += v[i] * v[i];
		const norm = Math.sqrt(s) || 1;
		for (let i = 0; i < EMBED_DIM; i++) v[i] /= norm;
		return v;
	}
	return {
		id: "concept",
		dim: EMBED_DIM,
		async ready() {},
		async embed(texts) {
			return texts.map(embedOne);
		},
		countTokens(t) {
			return Math.ceil(t.length / 4);
		},
	};
}

function row(id: string, weight: number, embedding: Float32Array): ContentRow {
	return {
		id,
		source_id: "messages",
		project_id: "p1",
		entity_type: "message",
		parent_id: null,
		archived: false,
		timestamp: 1_700_000_000_000,
		content_hash: `h-${id}-${weight}`,
		weight,
		role: "user",
		title: `Title ${id}`,
		text: "alpha alpha alpha",
		goal_id: null,
		session_id: "s1",
		session_title: "Session 1",
		file_path: null,
		start_line: null,
		end_line: null,
		embedding,
	};
}

test("weight 2.0 outranks weight 1.0 at identical relevance", async () => {
	const dir = path.join(tmpDir(), "search.lance");
	const embedder = conceptEmbedder();
	const store = await LanceStore.open({ dataDir: dir, embedDim: EMBED_DIM });

	// Identical text → identical vectors → identical _relevance_score.
	const [emb] = await embedder.embed(["search_document: alpha alpha alpha"], "document");
	await store.upsert([row("low", 1.0, emb), row("high", 2.0, emb)]);

	const hq = new HybridQuery({ lance: store, embedder });
	const res = await hq.search({ q: "alpha", limit: 10 });
	expect(res.results.length).toBe(2);
	expect(res.results[0].id).toBe("high");
	expect(res.results[1].id).toBe("low");
	// Scores should relate by the weight ratio (≈2×).
	expect(res.results[0].score).toBeGreaterThan(res.results[1].score);
	const ratio = res.results[0].score / res.results[1].score;
	expect(ratio).toBeCloseTo(2.0, 1);
	await store.close();
});

test("weight ordering persists across three distinct weights", async () => {
	const dir = path.join(tmpDir(), "search.lance");
	const embedder = conceptEmbedder();
	const store = await LanceStore.open({ dataDir: dir, embedDim: EMBED_DIM });
	const [emb] = await embedder.embed(["search_document: alpha alpha alpha"], "document");
	await store.upsert([
		row("w05", 0.5, emb),
		row("w10", 1.0, emb),
		row("w25", 2.5, emb),
	]);
	const hq = new HybridQuery({ lance: store, embedder });
	const res = await hq.search({ q: "alpha", limit: 10 });
	expect(res.results.map((r) => r.id)).toEqual(["w25", "w10", "w05"]);
	await store.close();
});
