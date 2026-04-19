/**
 * @slow Scale smoke test: 100K synthetic Indexables, ANN index build,
 * p95 < 300ms across 50 random hybrid queries.
 *
 * Opt-in only. Set `RUN_SCALE_SMOKE=1` to run. Default `npm run test:unit`
 * skips this suite entirely.
 *
 * Design reference: docs/design/semantic-search.md §12 + §13.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	LanceStore,
	EMBED_DIM,
	type ContentRow,
} from "../../src/server/search/lance-store.ts";
import { Indexer } from "../../src/server/search/indexer.ts";
import { HybridQuery } from "../../src/server/search/hybrid-query.ts";
import { ProgressBus } from "../../src/server/search/progress-bus.ts";
import type { Embedder, Indexable } from "../../src/server/search/types.ts";

const SHOULD_RUN = process.env.RUN_SCALE_SMOKE === "1";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "scale-smoke-"));
}

/**
 * Sub-millisecond fake embedder: deterministic 768-dim vectors derived
 * from a tiny hash. No crypto, no allocation per-call beyond the output
 * Float32Array. Vastly faster than the real Nomic model — required to
 * index 100K rows in a reasonable time budget.
 */
function fastFakeEmbedder(): Embedder {
	function embedOne(text: string): Float32Array {
		const v = new Float32Array(EMBED_DIM);
		let h = 2166136261 >>> 0;
		for (let i = 0; i < text.length; i++) {
			h ^= text.charCodeAt(i);
			h = Math.imul(h, 16777619) >>> 0;
		}
		let s = 0;
		for (let i = 0; i < EMBED_DIM; i++) {
			h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
			const f = (h / 0xffffffff) * 2 - 1;
			v[i] = f;
			s += f * f;
		}
		const norm = Math.sqrt(s) || 1;
		for (let i = 0; i < EMBED_DIM; i++) v[i] /= norm;
		return v;
	}
	return {
		id: "fast-fake",
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

function synthText(i: number): string {
	// Mix common and rare tokens so FTS has real work to do.
	const topics = ["error", "session", "goal", "story", "refactor", "token", "query", "plan"];
	const t = topics[i % topics.length];
	const rare = `rare-${i.toString(36)}`;
	return `${t} ${rare} line ${i} message body with some padding text for realism`;
}

function synthEntry(i: number): Indexable {
	return {
		id: `e${i}`,
		sourceId: "messages",
		text: synthText(i),
		metadata: { session_id: `s${i % 100}` },
		contentHash: `h${i}`,
		timestamp: 1_700_000_000_000 + i,
		projectId: "p1",
		archived: false,
		weight: 1.0,
		role: "user",
	};
}

async function directUpsert(store: LanceStore, entries: Indexable[], embedder: Embedder) {
	// Direct-to-store upsert bypassing the Indexer's dedup query, which
	// is per-batch and grows unusably at 100K rows. We still use the
	// Indexer's contract by invoking its `upsertEntries` only on the
	// last batch, as a smoke check of normal-path behaviour.
	const BATCH = 2000;
	for (let i = 0; i < entries.length; i += BATCH) {
		const batch = entries.slice(i, i + BATCH);
		const vecs = await embedder.embed(
			batch.map((e) => "search_document: " + e.text),
			"document",
		);
		const rows: ContentRow[] = batch.map((e, j) => ({
			id: e.id,
			source_id: e.sourceId,
			project_id: e.projectId,
			entity_type: "message",
			parent_id: null,
			archived: false,
			timestamp: e.timestamp,
			content_hash: e.contentHash,
			weight: e.weight,
			role: e.role ?? null,
			title: null,
			text: e.text,
			goal_id: null,
			session_id: null,
			session_title: null,
			file_path: null,
			start_line: null,
			end_line: null,
			embedding: vecs[j],
		}));
		await store.upsert(rows);
	}
}

test.describe("@slow scale smoke", () => {
	test.skip(!SHOULD_RUN, "Set RUN_SCALE_SMOKE=1 to run the 100K scale test");
	test.setTimeout(30 * 60_000); // 30 minutes

	test("100K synthetic rows, ANN index, p95 < 300ms across 50 queries", async () => {
		const dir = path.join(tmpDir(), "search.lance");
		const embedder = fastFakeEmbedder();
		const store = await LanceStore.open({ dataDir: dir, embedDim: EMBED_DIM });

		const N = 100_000;
		const entries: Indexable[] = new Array(N);
		for (let i = 0; i < N; i++) entries[i] = synthEntry(i);

		const t0 = Date.now();
		await directUpsert(store, entries, embedder);
		// eslint-disable-next-line no-console
		console.log(`[scale-smoke] upsert 100K: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

		// Exercise the Indexer's normal path on a handful of extra rows so
		// the test also covers its streaming behaviour at large dataset
		// sizes.
		const bus = new ProgressBus();
		const indexer = new Indexer({
			lance: store,
			embedder,
			progressBus: bus,
			projectId: "p1",
			progressDebounceMs: 0,
		});
		const extras: Indexable[] = [];
		for (let i = 0; i < 32; i++) extras.push(synthEntry(N + i));
		await indexer.upsertEntries(extras);

		// Build ANN + FTS indexes.
		const tIdx = Date.now();
		await store.createIndexes();
		// eslint-disable-next-line no-console
		console.log(`[scale-smoke] createIndexes: ${((Date.now() - tIdx) / 1000).toFixed(1)}s`);

		// 50 random queries; take p95 of wall-clock per query.
		const hq = new HybridQuery({ lance: store, embedder });
		const latencies: number[] = [];
		const topics = ["error", "session", "goal", "story", "refactor", "token", "query", "plan"];
		for (let i = 0; i < 50; i++) {
			const q = topics[i % topics.length] + " " + (i % 2 === 0 ? "line" : "rare");
			const start = Date.now();
			await hq.search({ q, limit: 20 });
			latencies.push(Date.now() - start);
		}
		latencies.sort((a, b) => a - b);
		const p95 = latencies[Math.floor(latencies.length * 0.95)];
		// eslint-disable-next-line no-console
		console.log(
			`[scale-smoke] query latencies ms: min=${latencies[0]} p50=${latencies[25]} p95=${p95} max=${latencies[latencies.length - 1]}`,
		);
		expect(p95).toBeLessThan(300);

		await store.close();
	});
});
