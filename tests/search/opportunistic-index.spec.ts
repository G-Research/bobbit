/**
 * Unit test: opportunistic ANN index rebuild.
 *
 * The Indexer should call `lance.createIndexes()` automatically after
 * enough rows accumulate (>10% growth past the 10K threshold), and
 * rate-limit to once per hour.
 */
import { test, expect } from "@playwright/test";
import { Indexer } from "../../src/server/search/indexer.ts";
import { ProgressBus } from "../../src/server/search/progress-bus.ts";
import { createFakeEmbedder } from "../../src/server/search/embedder.ts";
import type { LanceStore } from "../../src/server/search/lance-store.ts";

type FakeLance = Pick<LanceStore, "count" | "createIndexes" | "upsert" | "deleteByIds" | "deleteByFilter" | "query" | "writeMeta">;

function makeFakeLance(initialRowCount: number): FakeLance & {
	createIndexesCalls: number;
	_rowCount: number;
} {
	let createIndexesCalls = 0;
	return {
		_rowCount: initialRowCount,
		get createIndexesCalls() {
			return createIndexesCalls;
		},
		async count() {
			return (this._rowCount as unknown) as number;
		},
		async createIndexes() {
			createIndexesCalls++;
		},
		async upsert() {},
		async deleteByIds() {},
		async deleteByFilter() {},
		async writeMeta() {},
		query() {
			return {
				where() { return this; },
				select() { return this; },
				limit() { return this; },
				async toArray() { return []; },
			} as unknown as ReturnType<LanceStore["query"]>;
		},
	} as unknown as FakeLance & { createIndexesCalls: number; _rowCount: number };
}

function makeIndexer(lance: FakeLance) {
	return new Indexer({
		lance: lance as unknown as LanceStore,
		embedder: createFakeEmbedder(),
		progressBus: new ProgressBus(),
		projectId: "p1",
		progressDebounceMs: 0,
	});
}

test("_maybeRebuildIndexes: no-op below the 10K-row threshold", async () => {
	const fake = makeFakeLance(500);
	const indexer = makeIndexer(fake) as unknown as {
		_rowsSinceLastIndex: number;
		_maybeRebuildIndexes(now?: number): Promise<boolean>;
	};
	indexer._rowsSinceLastIndex = 100;
	const ran = await indexer._maybeRebuildIndexes();
	expect(ran).toBe(false);
	expect(fake.createIndexesCalls).toBe(0);
});

test("_maybeRebuildIndexes: no-op when growth <= 10%", async () => {
	const fake = makeFakeLance(20_000);
	const indexer = makeIndexer(fake) as unknown as {
		_rowsSinceLastIndex: number;
		_maybeRebuildIndexes(now?: number): Promise<boolean>;
	};
	indexer._rowsSinceLastIndex = 500; // 2.5% < 10%
	const ran = await indexer._maybeRebuildIndexes();
	expect(ran).toBe(false);
	expect(fake.createIndexesCalls).toBe(0);
});

test("_maybeRebuildIndexes: rebuilds when growth > 10% past the 10K threshold", async () => {
	const fake = makeFakeLance(20_000);
	const indexer = makeIndexer(fake) as unknown as {
		_rowsSinceLastIndex: number;
		_maybeRebuildIndexes(now?: number): Promise<boolean>;
	};
	indexer._rowsSinceLastIndex = 3000; // 15%
	const ran = await indexer._maybeRebuildIndexes();
	expect(ran).toBe(true);
	expect(fake.createIndexesCalls).toBe(1);
	// Counter resets after a successful rebuild.
	expect(indexer._rowsSinceLastIndex).toBe(0);
});

test("_maybeRebuildIndexes: rate-limited to once per 60 minutes", async () => {
	const fake = makeFakeLance(20_000);
	const indexer = makeIndexer(fake) as unknown as {
		_rowsSinceLastIndex: number;
		_maybeRebuildIndexes(now?: number): Promise<boolean>;
	};
	indexer._rowsSinceLastIndex = 3000;
	const t0 = Date.now();
	const first = await indexer._maybeRebuildIndexes(t0);
	expect(first).toBe(true);
	expect(fake.createIndexesCalls).toBe(1);

	// Simulate another 3000 rows arriving 30 minutes later — still within cooldown.
	indexer._rowsSinceLastIndex = 3000;
	const second = await indexer._maybeRebuildIndexes(t0 + 30 * 60_000);
	expect(second).toBe(false);
	expect(fake.createIndexesCalls).toBe(1);

	// 61 minutes — cooldown cleared; rebuild fires.
	indexer._rowsSinceLastIndex = 3000;
	const third = await indexer._maybeRebuildIndexes(t0 + 61 * 60_000);
	expect(third).toBe(true);
	expect(fake.createIndexesCalls).toBe(2);
});
