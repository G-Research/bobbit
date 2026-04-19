/**
 * Unit tests for `src/server/search/indexer.ts::Indexer`.
 *
 * Exercises a real embedded LanceStore in a tmp dir against the fake
 * deterministic embedder from `embedder.ts`. Covers:
 *   - upsertEntries embeds + upserts
 *   - contentHash dedup skips already-stored entries
 *   - long text (> maxTokens) produces multiple chunk rows sharing parent_id
 *   - removeEntries deletes parent + chunks
 *   - rebuildFromSources with 2 fake sources → correct final count + events
 *   - progress events fire on backlog changes
 *
 * Design reference: docs/design/semantic-search.md §3, §6, §8, §9, §10.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LanceStore, EMBED_DIM } from "../../src/server/search/lance-store.ts";
import { Indexer } from "../../src/server/search/indexer.ts";
import { ProgressBus } from "../../src/server/search/progress-bus.ts";
import { createFakeEmbedder } from "../../src/server/search/embedder.ts";
import type {
	Indexable,
	IndexSource,
	IndexSourceContext,
} from "../../src/server/search/types.ts";

test.setTimeout(60_000);

function makeTmpDir(prefix = "indexer-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeIndexable(id: string, overrides: Partial<Indexable> = {}): Indexable {
	return {
		id,
		sourceId: "messages",
		text: `text for ${id}`,
		metadata: { session_id: "s1", session_title: "Session 1" },
		contentHash: `hash-${id}`,
		timestamp: 1_700_000_000_000,
		projectId: "p1",
		archived: false,
		weight: 1.0,
		role: "user",
		...overrides,
	};
}

async function openStore(): Promise<{ store: LanceStore; dir: string }> {
	const dir = path.join(makeTmpDir(), "search.lance");
	const store = await LanceStore.open({ dataDir: dir, embedDim: EMBED_DIM });
	return { store, dir };
}

function captureProgress(bus: ProgressBus): {
	progress: Array<{ total: number; completed: number; backlog: number; phase: string }>;
	complete: Array<{ rowsWritten: number }>;
	errors: Array<{ message: string }>;
} {
	const progress: Array<{
		total: number;
		completed: number;
		backlog: number;
		phase: string;
	}> = [];
	const complete: Array<{ rowsWritten: number }> = [];
	const errors: Array<{ message: string }> = [];
	bus.on("index:progress", (e) => progress.push(e));
	bus.on("index:complete", (e) => complete.push(e));
	bus.on("index:error", (e) => errors.push(e));
	return { progress, complete, errors };
}

test("upsertEntries embeds and upserts into the store", async () => {
	const { store } = await openStore();
	const bus = new ProgressBus();
	const embedder = createFakeEmbedder();
	const indexer = new Indexer({
		lance: store,
		embedder,
		progressBus: bus,
		projectId: "p1",
		progressDebounceMs: 0,
	});

	await indexer.upsertEntries([
		makeIndexable("a"),
		makeIndexable("b"),
		makeIndexable("c"),
	]);

	expect(await store.count()).toBe(3);
	// Fake embedder should have been called in document mode.
	expect(embedder.calls.length).toBeGreaterThan(0);
	expect(embedder.calls[0].kind).toBe("document");
	// Document prefix per design Appendix A.
	expect(embedder.calls[0].texts[0].startsWith("search_document: ")).toBe(true);

	expect(indexer.backlog).toBe(0);
	await store.close();
});

test("upsertEntries skips entries whose contentHash is already stored", async () => {
	const { store } = await openStore();
	const bus = new ProgressBus();
	const embedder = createFakeEmbedder();
	const indexer = new Indexer({
		lance: store,
		embedder,
		progressBus: bus,
		projectId: "p1",
		progressDebounceMs: 0,
	});

	const e1 = makeIndexable("a", { contentHash: "h1" });
	await indexer.upsertEntries([e1]);
	expect(await store.count()).toBe(1);
	const callsAfterFirst = embedder.calls.length;

	// Same contentHash → skipped, no new embedder call.
	await indexer.upsertEntries([e1]);
	expect(await store.count()).toBe(1);
	expect(embedder.calls.length).toBe(callsAfterFirst);

	// Changed contentHash → embedded and upserted (row replaced).
	const e1b = makeIndexable("a", { contentHash: "h2", text: "updated" });
	await indexer.upsertEntries([e1b]);
	expect(await store.count()).toBe(1);
	expect(embedder.calls.length).toBeGreaterThan(callsAfterFirst);

	const rows = (await store.query().where("id = 'a'").limit(10).toArray()) as Array<{
		text: string;
		content_hash: string;
	}>;
	expect(rows.length).toBe(1);
	expect(rows[0].text).toBe("updated");
	expect(rows[0].content_hash).toBe("h2");

	await store.close();
});

test("long text produces multiple chunk rows sharing parent_id", async () => {
	const { store } = await openStore();
	const bus = new ProgressBus();
	const embedder = createFakeEmbedder();
	const indexer = new Indexer({
		lance: store,
		embedder,
		progressBus: bus,
		projectId: "p1",
		progressDebounceMs: 0,
		maxTokens: 50,
		chunkOverlap: 5,
	});

	// Build a 300-word message so it splits into several chunks at 50 tokens each.
	const words: string[] = [];
	for (let i = 0; i < 300; i++) words.push(`word${i}`);
	const longText = words.join(" ");

	await indexer.upsertEntries([
		makeIndexable("long", { text: longText }),
		makeIndexable("short", { text: "tiny" }),
	]);

	const rowCount = await store.count();
	expect(rowCount).toBeGreaterThan(2); // several chunks + one short row.

	const chunkRows = (await store
		.query()
		.where("parent_id = 'long'")
		.limit(100)
		.toArray()) as Array<{ id: string; parent_id: string }>;
	expect(chunkRows.length).toBeGreaterThanOrEqual(2);
	for (const r of chunkRows) {
		expect(r.parent_id).toBe("long");
		expect(r.id.startsWith("long:chunk:")).toBe(true);
	}

	// Short row uses its own id as primary key, no parent_id.
	const shortRows = (await store
		.query()
		.where("id = 'short'")
		.limit(10)
		.toArray()) as Array<{ id: string; parent_id: string | null }>;
	expect(shortRows.length).toBe(1);
	expect(shortRows[0].parent_id).toBeNull();

	await store.close();
});

test("removeEntries deletes parent row and its chunks", async () => {
	const { store } = await openStore();
	const bus = new ProgressBus();
	const embedder = createFakeEmbedder();
	const indexer = new Indexer({
		lance: store,
		embedder,
		progressBus: bus,
		projectId: "p1",
		progressDebounceMs: 0,
		maxTokens: 50,
		chunkOverlap: 5,
	});

	// "long" chunks + "keep" parent (no chunks, short text).
	const words: string[] = [];
	for (let i = 0; i < 300; i++) words.push(`w${i}`);
	await indexer.upsertEntries([
		makeIndexable("long", { text: words.join(" ") }),
		makeIndexable("keep", { text: "short" }),
	]);
	const before = await store.count();
	expect(before).toBeGreaterThan(2);

	await indexer.removeEntries(["long"]);

	const remaining = (await store.query().limit(100).toArray()) as Array<{
		id: string;
		parent_id: string | null;
	}>;
	// No long chunks, no parent stub — only "keep" remains.
	for (const r of remaining) {
		expect(r.parent_id === "long" ? false : true).toBe(true);
		expect(r.id === "long").toBe(false);
		expect(r.id.startsWith("long:chunk:")).toBe(false);
	}
	expect(remaining.some((r) => r.id === "keep")).toBe(true);

	await store.close();
});

test("rebuildFromSources drains two sources and emits complete", async () => {
	const { store } = await openStore();
	const bus = new ProgressBus();
	const events = captureProgress(bus);
	const embedder = createFakeEmbedder();
	const indexer = new Indexer({
		lance: store,
		embedder,
		progressBus: bus,
		projectId: "p1",
		progressDebounceMs: 0,
	});

	// Pre-populate with a row that must not survive the rebuild.
	await indexer.upsertEntries([makeIndexable("legacy")]);
	expect(await store.count()).toBe(1);
	const progressBeforeRebuild = events.progress.length;

	const sourceA: IndexSource = {
		sourceId: "goals",
		async *iterate() {
			for (let i = 0; i < 5; i++) {
				yield makeIndexable(`A-${i}`, {
					sourceId: "goals",
					role: "spec",
					weight: 2.5,
				});
			}
		},
	};
	const sourceB: IndexSource = {
		sourceId: "sessions",
		async *iterate() {
			for (let i = 0; i < 5; i++) {
				yield makeIndexable(`B-${i}`, {
					sourceId: "sessions",
					role: "title",
					weight: 3.0,
				});
			}
		},
	};

	// The context is only consumed by sources; our fake sources ignore it,
	// so an empty-ish shape is fine.
	const ctx = {} as unknown as IndexSourceContext;

	await indexer.rebuildFromSources([sourceA, sourceB], ctx);

	expect(await store.count()).toBe(10);
	// Legacy row dropped.
	const legacy = (await store.query().where("id = 'legacy'").limit(1).toArray()) as unknown[];
	expect(legacy.length).toBe(0);

	// At least one rebuild-phase progress event, and an index:complete event.
	const rebuildProgress = events.progress
		.slice(progressBeforeRebuild)
		.filter((e) => e.phase === "rebuild");
	expect(rebuildProgress.length).toBeGreaterThan(0);
	expect(events.complete.length).toBe(1);
	expect(events.complete[0].rowsWritten).toBe(10);
	expect(events.errors.length).toBe(0);

	// Meta was stamped.
	const meta = await store.readMeta();
	expect(meta).not.toBeNull();
	expect(meta!.embedderId).toBe(embedder.id);
	expect(meta!.dim).toBe(embedder.dim);

	await store.close();
});

test("progress events fire on backlog changes", async () => {
	const { store } = await openStore();
	const bus = new ProgressBus();
	const events = captureProgress(bus);
	const embedder = createFakeEmbedder();
	const indexer = new Indexer({
		lance: store,
		embedder,
		progressBus: bus,
		projectId: "p1",
		progressDebounceMs: 0,
	});

	// 40 entries → exceeds the 32 embed-batch, guaranteeing multiple emits.
	const entries: Indexable[] = [];
	for (let i = 0; i < 40; i++) entries.push(makeIndexable(`n${i}`));

	await indexer.upsertEntries(entries);

	expect(events.progress.length).toBeGreaterThanOrEqual(2);
	// At least one event should show non-zero backlog while draining,
	// and the final emit should show backlog back to 0.
	const last = events.progress[events.progress.length - 1];
	expect(last.backlog).toBe(0);
	expect(last.phase).toBe("incremental");
	expect(indexer.backlog).toBe(0);

	await store.close();
});

test("re-upsert of long text (requiring chunking) is skipped when contentHash unchanged", async () => {
	// Regression: _filterUnchanged used to look up by id only, but long
	// entries are stored as chunk rows (id = `<id>:chunk:N`, parent_id = <id>).
	// Without checking parent_id, the lookup missed and every re-upsert
	// re-embedded all chunks. This test guards against that.
	const { store } = await openStore();
	const bus = new ProgressBus();
	const embedder = createFakeEmbedder();
	const indexer = new Indexer({
		lance: store,
		embedder,
		progressBus: bus,
		projectId: "p1",
		progressDebounceMs: 0,
		maxTokens: 50,
		chunkOverlap: 5,
	});

	// Build long text that will split into several chunks at 50 tokens.
	const words: string[] = [];
	for (let i = 0; i < 300; i++) words.push(`word${i}`);
	const longText = words.join(" ");

	const entry = makeIndexable("long", { text: longText, contentHash: "hash-v1" });

	// First upsert: embeds the chunks.
	await indexer.upsertEntries([entry]);
	const rowsAfterFirst = await store.count();
	expect(rowsAfterFirst).toBeGreaterThan(1); // chunked
	const callsAfterFirst = embedder.calls.length;
	expect(callsAfterFirst).toBeGreaterThan(0);

	// Second upsert of the same entry (unchanged contentHash): the
	// indexer MUST match by parent_id on the existing chunk rows and
	// skip re-embedding entirely.
	await indexer.upsertEntries([entry]);
	expect(await store.count()).toBe(rowsAfterFirst);
	expect(embedder.calls.length).toBe(callsAfterFirst);

	// Sanity: if contentHash changes, re-embedding does happen.
	const entryUpdated = makeIndexable("long", { text: longText, contentHash: "hash-v2" });
	await indexer.upsertEntries([entryUpdated]);
	expect(embedder.calls.length).toBeGreaterThan(callsAfterFirst);

	await store.close();
});
