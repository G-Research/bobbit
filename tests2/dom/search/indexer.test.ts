import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
/**
 * Unit tests for `src/server/search/indexer.ts::Indexer`.
 *
 * Exercises a real FlexSearchStore in a tmp dir. Covers:
 *   - upsertEntries pushes documents into the store
 *   - contentHash dedup skips already-stored entries
 *   - long text (> maxTokens) produces multiple chunk rows sharing parent_id
 *   - removeEntries deletes parent + chunks
 *   - rebuildFromSources with 2 fake sources → correct final count + events
 *   - progress events fire on backlog changes
 *
 * Design reference: docs/design/portable-search.md §3, §6, §13.
 */
import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	FLEX_EXPORT_BUNDLE_FILE,
	FlexSearchStore,
} from "../../../src/server/search/flex-store.ts";
import { Indexer } from "../../../src/server/search/indexer.ts";
import { ProgressBus } from "../../../src/server/search/progress-bus.ts";
import type {
	Indexable,
	IndexSource,
	IndexSourceContext,
} from "../../../src/server/search/types.ts";

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

async function openStore(): Promise<{ store: FlexSearchStore; dir: string }> {
	const dir = path.join(makeTmpDir(), "search.flex");
	const store = await FlexSearchStore.open({ dataDir: dir });
	return { store, dir };
}

function captureProgress(bus: ProgressBus): {
	progress: Array<{ total: number; completed: number; backlog: number; phase: string }>;
	complete: Array<{ rowsWritten: number }>;
	errors: Array<{ message: string }>;
} {
	const progress: Array<{ total: number; completed: number; backlog: number; phase: string }> = [];
	const complete: Array<{ rowsWritten: number }> = [];
	const errors: Array<{ message: string }> = [];
	bus.on("index:progress", (e) => progress.push(e));
	bus.on("index:complete", (e) => complete.push(e));
	bus.on("index:error", (e) => errors.push(e));
	return { progress, complete, errors };
}

test("upsertEntries pushes docs into the store", async () => {
	const { store } = await openStore();
	const bus = new ProgressBus();
	const indexer = new Indexer({
		store,
		progressBus: bus,
		projectId: "p1",
		progressDebounceMs: 0,
	});

	await indexer.upsertEntries([
		makeIndexable("a"),
		makeIndexable("b"),
		makeIndexable("c"),
	]);

	expect(store.count()).toBe(3);
	expect(indexer.backlog).toBe(0);
	await store.close();
}, 60_000);

test("author metadata survives Indexer → disk → search while legacy docs remain compatible", async () => {
	const { store, dir } = await openStore();
	const indexer = new Indexer({
		store,
		progressBus: new ProgressBus(),
		projectId: "p1",
		progressDebounceMs: 0,
	});

	await indexer.upsertEntries([
		makeIndexable("authored", {
			text: "AuthorRoundTripToken",
			metadata: {
				session_id: "s1",
				authorKind: "system",
				authorId: "system:bobbit",
				authorLabel: "Bobbit",
			},
		}),
		makeIndexable("legacy", {
			text: "LegacyAuthorlessToken",
			metadata: { session_id: "s1" },
		}),
	]);
	await store.close();

	const docsPath = path.join(dir, "index", "__docs__.json");
	const docs = JSON.parse(fs.readFileSync(docsPath, "utf-8")) as Array<Record<string, unknown>>;
	const authoredDoc = docs.find((doc) => doc.id === "authored");
	expect(authoredDoc).toMatchObject({
		author_kind: "system",
		author_id: "system:bobbit",
		author_label: "Bobbit",
	});

	// Emulate a mirror row written by a pre-author index. Keep the export
	// bundle coherent so reopen exercises the normal disk-restore path.
	const legacyDoc = docs.find((doc) => doc.id === "legacy")!;
	delete legacyDoc.author_kind;
	delete legacyDoc.author_id;
	delete legacyDoc.author_label;
	const legacyDocsJson = JSON.stringify(docs);
	fs.writeFileSync(docsPath, legacyDocsJson, "utf-8");
	const bundlePath = path.join(dir, "index", FLEX_EXPORT_BUNDLE_FILE);
	const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf-8")) as Record<string, unknown>;
	bundle.docsHash = createHash("sha256").update(legacyDocsJson).digest("hex");
	fs.writeFileSync(bundlePath, JSON.stringify(bundle), "utf-8");

	const reopened = await FlexSearchStore.open({ dataDir: dir });
	try {
		expect(reopened.getById("authored")).toMatchObject({
			author_kind: "system",
			author_id: "system:bobbit",
			author_label: "Bobbit",
		});
		expect(reopened.getById("legacy")).toMatchObject({
			author_kind: null,
			author_id: null,
			author_label: null,
		});

		const authored = await reopened.search({ q: "AuthorRoundTripToken" });
		expect(authored.results[0]).toMatchObject({
			authorKind: "system",
			authorId: "system:bobbit",
			authorLabel: "Bobbit",
		});
		const legacy = await reopened.search({ q: "LegacyAuthorlessToken" });
		expect(legacy.results[0]?.authorKind).toBeUndefined();
		expect(legacy.results[0]?.authorId).toBeUndefined();
		expect(legacy.results[0]?.authorLabel).toBeUndefined();
	} finally {
		await reopened.close();
	}
}, 60_000);

test("upsertEntries skips entries whose contentHash is already stored", async () => {
	const { store } = await openStore();
	const bus = new ProgressBus();
	const indexer = new Indexer({
		store,
		progressBus: bus,
		projectId: "p1",
		progressDebounceMs: 0,
	});

	const e1 = makeIndexable("a", { contentHash: "h1" });
	await indexer.upsertEntries([e1]);
	expect(store.count()).toBe(1);

	await indexer.upsertEntries([e1]);
	expect(store.count()).toBe(1);
	expect(store.getById("a")!.content_hash).toBe("h1");

	const e1b = makeIndexable("a", { contentHash: "h2", text: "updated" });
	await indexer.upsertEntries([e1b]);
	expect(store.count()).toBe(1);
	expect(store.getById("a")!.text).toBe("updated");
	expect(store.getById("a")!.content_hash).toBe("h2");

	await store.close();
}, 60_000);

test("long text produces multiple chunk rows sharing parent_id", async () => {
	const { store } = await openStore();
	const bus = new ProgressBus();
	const indexer = new Indexer({
		store,
		progressBus: bus,
		projectId: "p1",
		progressDebounceMs: 0,
		maxTokens: 50,
		chunkOverlap: 5,
	});

	const words: string[] = [];
	for (let i = 0; i < 1000; i++) words.push(`word${i}`);
	const longText = words.join(" ");

	await indexer.upsertEntries([
		makeIndexable("long", { text: longText }),
		makeIndexable("short", { text: "tiny" }),
	]);

	const rowCount = store.count();
	expect(rowCount).toBeGreaterThan(2);

	const all = store.list({ limit: 1000 });
	const chunkRows = all.filter((r) => r.parent_id === "long");
	expect(chunkRows.length).toBeGreaterThanOrEqual(2);
	for (const r of chunkRows) {
		expect(r.parent_id).toBe("long");
		expect(r.id.startsWith("long:chunk:")).toBe(true);
	}

	const shortDoc = store.getById("short");
	expect(shortDoc).not.toBeNull();
	expect(shortDoc!.parent_id).toBeNull();

	await store.close();
}, 60_000);

test("removeEntries deletes parent row and its chunks", async () => {
	const { store } = await openStore();
	const bus = new ProgressBus();
	const indexer = new Indexer({
		store,
		progressBus: bus,
		projectId: "p1",
		progressDebounceMs: 0,
		maxTokens: 50,
		chunkOverlap: 5,
	});

	const words: string[] = [];
	for (let i = 0; i < 1000; i++) words.push(`w${i}`);
	await indexer.upsertEntries([
		makeIndexable("long", { text: words.join(" ") }),
		makeIndexable("keep", { text: "short" }),
	]);
	expect(store.count()).toBeGreaterThan(2);

	await indexer.removeEntries(["long"]);

	const remaining = store.list({ limit: 1000 });
	for (const r of remaining) {
		expect(r.parent_id).not.toBe("long");
		expect(r.id).not.toBe("long");
		expect(r.id.startsWith("long:chunk:")).toBe(false);
	}
	expect(remaining.some((r) => r.id === "keep")).toBe(true);

	await store.close();
}, 60_000);

test("rebuildFromSources drains two sources and emits complete", async () => {
	const { store } = await openStore();
	const bus = new ProgressBus();
	const events = captureProgress(bus);
	const indexer = new Indexer({
		store,
		progressBus: bus,
		projectId: "p1",
		progressDebounceMs: 0,
	});

	await indexer.upsertEntries([makeIndexable("legacy")]);
	expect(store.count()).toBe(1);
	const progressBeforeRebuild = events.progress.length;

	const sourceA: IndexSource = {
		sourceId: "goals",
		async *iterate() {
			for (let i = 0; i < 5; i++) {
				yield makeIndexable(`A-${i}`, { sourceId: "goals", role: "spec", weight: 2.5 });
			}
		},
	};
	const sourceB: IndexSource = {
		sourceId: "sessions",
		async *iterate() {
			for (let i = 0; i < 5; i++) {
				yield makeIndexable(`B-${i}`, { sourceId: "sessions", role: "title", weight: 3.0 });
			}
		},
	};

	const ctx = {} as unknown as IndexSourceContext;

	await indexer.rebuildFromSources([sourceA, sourceB], ctx);

	expect(store.count()).toBe(10);
	expect(store.getById("legacy")).toBeNull();

	const rebuildProgress = events.progress
		.slice(progressBeforeRebuild)
		.filter((e) => e.phase === "rebuild");
	expect(rebuildProgress.length).toBeGreaterThan(0);
	expect(events.complete.length).toBe(1);
	expect(events.complete[0].rowsWritten).toBe(10);
	expect(events.errors.length).toBe(0);

	const meta = await store.readMeta();
	expect(meta).not.toBeNull();
	expect(meta!.engine).toBe("flexsearch");

	await store.close();
}, 60_000);

test("progress events fire on backlog changes", async () => {
	const { store } = await openStore();
	const bus = new ProgressBus();
	const events = captureProgress(bus);
	const indexer = new Indexer({
		store,
		progressBus: bus,
		projectId: "p1",
		progressDebounceMs: 0,
	});

	const entries: Indexable[] = [];
	for (let i = 0; i < 200; i++) entries.push(makeIndexable(`n${i}`));
	await indexer.upsertEntries(entries);

	expect(events.progress.length).toBeGreaterThanOrEqual(1);
	const last = events.progress[events.progress.length - 1];
	expect(last.backlog).toBe(0);
	expect(last.phase).toBe("incremental");
	expect(indexer.backlog).toBe(0);

	await store.close();
}, 60_000);

test("re-upsert of long text is skipped when contentHash unchanged", async () => {
	const { store } = await openStore();
	const bus = new ProgressBus();
	const indexer = new Indexer({
		store,
		progressBus: bus,
		projectId: "p1",
		progressDebounceMs: 0,
		maxTokens: 50,
		chunkOverlap: 5,
	});

	const words: string[] = [];
	for (let i = 0; i < 1000; i++) words.push(`word${i}`);
	const longText = words.join(" ");

	const entry = makeIndexable("long", { text: longText, contentHash: "hash-v1" });

	await indexer.upsertEntries([entry]);
	const rowsAfterFirst = store.count();
	expect(rowsAfterFirst).toBeGreaterThan(1);

	await indexer.upsertEntries([entry]);
	expect(store.count()).toBe(rowsAfterFirst);

	const entryUpdated = makeIndexable("long", { text: longText, contentHash: "hash-v2" });
	await indexer.upsertEntries([entryUpdated]);
	// Still chunked the same way, but hashes updated.
	const anyChunk = store.list({ limit: 1000 }).find((d) => d.parent_id === "long");
	expect(anyChunk!.content_hash).toBe("hash-v2");

	await store.close();
}, 60_000);
