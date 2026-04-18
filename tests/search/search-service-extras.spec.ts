/**
 * Unit tests for SearchService additions from the gap-analysis pass:
 *   - Shared model cache directory across project instances.
 *   - Scheduled 24h dataset compaction timer.
 */
import { test, expect } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import { SearchService } from "../../src/server/search/search-service.ts";
import { createFakeEmbedder } from "../../src/server/search/embedder.ts";
import { ProgressBus } from "../../src/server/search/progress-bus.ts";
import * as fs from "node:fs";

test("sharedModelCacheDir returns the same path regardless of stateDir", () => {
	// Clear any test-time override.
	const saved = process.env.BOBBIT_MODEL_CACHE_DIR;
	delete process.env.BOBBIT_MODEL_CACHE_DIR;
	try {
		const a = SearchService.sharedModelCacheDir();
		const b = SearchService.sharedModelCacheDir();
		expect(a).toBe(b);
		expect(a).toBe(path.join(os.homedir(), ".bobbit", "models"));
	} finally {
		if (saved !== undefined) process.env.BOBBIT_MODEL_CACHE_DIR = saved;
	}
});

test("two SearchService instances with different stateDirs share model cache dir", () => {
	const saved = process.env.BOBBIT_MODEL_CACHE_DIR;
	delete process.env.BOBBIT_MODEL_CACHE_DIR;
	try {
		// Instantiate two services pointing at different state dirs; the
		// model cache dir must be identical (and per-user, not per-project).
		const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "svc-a-"));
		const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "svc-b-"));
		// Pass fake embedders so we don't accidentally instantiate Nomic
		// (and trigger a model download). The invariant is on the static
		// helper, which the Nomic default uses.
		const s1 = new SearchService({ stateDir: dir1, projectId: "p1", embedder: createFakeEmbedder() });
		const s2 = new SearchService({ stateDir: dir2, projectId: "p2", embedder: createFakeEmbedder() });
		expect(s1.stateDir).not.toBe(s2.stateDir);
		// The shared helper is what the default embedder uses; it must be
		// stateDir-independent.
		expect(SearchService.sharedModelCacheDir()).toBe(path.join(os.homedir(), ".bobbit", "models"));
	} finally {
		if (saved !== undefined) process.env.BOBBIT_MODEL_CACHE_DIR = saved;
	}
});

test("BOBBIT_MODEL_CACHE_DIR env var overrides the default", () => {
	const saved = process.env.BOBBIT_MODEL_CACHE_DIR;
	process.env.BOBBIT_MODEL_CACHE_DIR = "/tmp/override-models";
	try {
		expect(SearchService.sharedModelCacheDir()).toBe("/tmp/override-models");
	} finally {
		if (saved === undefined) delete process.env.BOBBIT_MODEL_CACHE_DIR;
		else process.env.BOBBIT_MODEL_CACHE_DIR = saved;
	}
});

test("scheduled compaction timer fires every 24h and stops on close", async () => {
	// Stub setInterval / clearInterval on globalThis so we can observe
	// the timer cadence without actually waiting a day.
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-compact-"));
	fs.mkdirSync(path.join(stateDir, "search.lance"), { recursive: true });

	const captured: Array<{ fn: () => void; ms: number }> = [];
	let cleared = 0;
	const origSet = globalThis.setInterval;
	const origClear = globalThis.clearInterval;
	const fakeHandle = { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
	(globalThis as unknown as { setInterval: typeof setInterval }).setInterval = ((fn: () => void, ms: number) => {
		captured.push({ fn, ms });
		return fakeHandle;
	}) as unknown as typeof setInterval;
	(globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = ((_: unknown) => {
		cleared++;
	}) as unknown as typeof clearInterval;

	try {
		const svc = new SearchService({
			stateDir,
			projectId: "p1",
			embedder: createFakeEmbedder(),
			progressBus: new ProgressBus(),
		});
		svc.open();
		await svc.whenReady();
		// One interval registered at 24h.
		expect(captured.length).toBe(1);
		expect(captured[0].ms).toBe(24 * 60 * 60 * 1000);

		// Invoke the timer callback — should call compact() without
		// throwing (store is open; may also be a no-op but must not crash).
		let compactCalls = 0;
		const origCompact = svc.compact.bind(svc);
		(svc as unknown as { compact: () => Promise<void> }).compact = async () => {
			compactCalls++;
			return origCompact();
		};
		captured[0].fn();
		// setInterval callback schedules an async compact; let it settle.
		await new Promise((r) => setTimeout(r, 50));
		expect(compactCalls).toBeGreaterThanOrEqual(1);

		await svc.close();
		expect(cleared).toBeGreaterThanOrEqual(1);
	} finally {
		(globalThis as unknown as { setInterval: typeof setInterval }).setInterval = origSet;
		(globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = origClear;
	}
});
