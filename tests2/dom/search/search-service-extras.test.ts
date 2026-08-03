import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SearchService } from "../../../src/server/search/search-service.ts";
import { FlexSearchStore, type FlexDoc } from "../../../src/server/search/flex-store.ts";
import { buildCurrentMeta } from "../../../src/server/search/meta.ts";
import { FLEX_VERSION } from "../../../src/server/search/constants.ts";
import { CONTENT_POLICY_VERSION } from "../../../src/server/search/content-policy.ts";
import { ProgressBus } from "../../../src/server/search/progress-bus.ts";

function tmp(prefix = "search-service-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitForResult(service: SearchService, token: string, type: "goals" | "messages" = "messages"): Promise<void> {
	await expect.poll(async () => (await service.search(token, { type })).results.length, { timeout: 5_000 }).toBe(1);
}

function sources(goals: any[] = []) {
	return {
		goalStore: { getAll: () => goals },
		sessionStore: { getAll: () => [] },
		staffStore: { getAll: () => [] },
	};
}

function mirrorDoc(id: string, text: string): FlexDoc {
	return {
		id, source_id: "goals", project_id: "p1", entity_type: "goal", parent_id: null,
		archived: false, archived_tag: "false", timestamp: 1, content_hash: `${id}:hash`,
		weight: 1, role: "spec", title: text, text, identifier_text: "", goal_id: id,
		session_id: null, session_title: null, file_path: null, start_line: null, end_line: null,
	};
}

async function seedIncompleteMirror(stateDir: string, kind: "missing-meta" | "corrupt-mirror" | "mismatched-meta"): Promise<void> {
	const store = await FlexSearchStore.open({ dataDir: path.join(stateDir, "search.flex") });
	await store.upsert([mirrorDoc("stale-goal", "StaleRecoveredMirrorToken")]);
	if (kind !== "missing-meta") {
		await store.writeMeta(buildCurrentMeta({ engine: "flexsearch", engineVersion: FLEX_VERSION, contentPolicyVersion: CONTENT_POLICY_VERSION }));
	}
	await store.close();
	if (kind === "corrupt-mirror") {
		fs.writeFileSync(path.join(stateDir, "search.flex", "index", "__docs__.json"), "{corrupt mirror");
	}
	if (kind === "mismatched-meta") {
		fs.writeFileSync(path.join(stateDir, "search.flex", "meta.json"), JSON.stringify({
			engine: "obsolete-engine", engine_version: "0", schema_version: 0, content_policy_version: 0, created_at: 1,
		}));
	}
}

test("open is ready without starting search work until an operation needs it", async () => {
	const stateDir = tmp();
	const service = new SearchService({ stateDir, projectId: "p1", progressBus: new ProgressBus() });
	try {
		const emptySources = sources();
		service.open(emptySources as any);
		await service.whenReady();
		expect(service.getState()).toBe("ready");
		expect(fs.existsSync(service.dataDir)).toBe(false);

		// Stats are observational: maintenance/UI polling cannot start a worker or
		// create derived search state for a project that has never used search.
		await expect(service.getStats()).resolves.toEqual({
			state: "ready", engine: "flexsearch", engineVersion: FLEX_VERSION,
			lastRebuildAt: null, rowCountsBySource: { goals: 0, sessions: 0, messages: 0, staff: 0, files: 0 },
			datasetBytes: 0, degraded: false, unavailableReason: null,
		});
		expect((service as unknown as { _worker: unknown; _workerStart: unknown })._worker).toBeNull();
		expect((service as unknown as { _worker: unknown; _workerStart: unknown })._workerStart).toBeNull();
		expect(fs.existsSync(service.dataDir)).toBe(false);

		// A fresh mirror has no metadata, so the first query is explicitly fenced
		// until the authoritative (empty) source rebuild succeeds.
		await expect(service.search("no corpus yet")).rejects.toMatchObject({ code: "SEARCH_UNAVAILABLE", reason: "rebuilding" });
		await service.rebuildFromStores(emptySources.goalStore as any, emptySources.sessionStore as any, undefined, emptySources.staffStore as any);
		await service.search("no corpus yet");
		expect(fs.existsSync(service.dataDir)).toBe(true);
	} finally {
		await service.close();
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("search results remain correct after a service restart from the durable mirror", async () => {
	const stateDir = tmp();
	const token = "RestartMirrorSearchToken";
	const goal = { id: "restart-goal", title: token, spec: "authoritative durable source", state: "in-progress", createdAt: 1 };
	const authoritativeSources = sources([goal]);
	const first = new SearchService({ stateDir, projectId: "p1", progressBus: new ProgressBus() });
	try {
		first.open(authoritativeSources as any);
		await first.whenReady();
		await first.rebuildFromStores(authoritativeSources.goalStore as any, authoritativeSources.sessionStore as any, undefined, authoritativeSources.staffStore as any);
		await waitForResult(first, token, "goals");
		await first.close();

		const second = new SearchService({ stateDir, projectId: "p1", progressBus: new ProgressBus() });
		try {
			second.open(authoritativeSources as any);
			await second.whenReady();
			await waitForResult(second, token, "goals");
		} finally {
			await second.close();
		}
	} finally {
		if (first.getState() !== "closed") await first.close();
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test.each(["missing-meta", "corrupt-mirror", "mismatched-meta"] as const)("incomplete %s recovery fences partial mirrors until sources rebuild", async (kind) => {
	const stateDir = tmp(`search-recovery-${kind}-`);
	const token = `AuthoritativeRecovery${kind.replace(/-/g, "")}`;
	const authoritativeSources = sources([{ id: "authoritative-goal", title: token, spec: "complete source", state: "in-progress", createdAt: 1 }]);
	await seedIncompleteMirror(stateDir, kind);
	const service = new SearchService({ stateDir, projectId: "p1", progressBus: new ProgressBus() });
	try {
		service.open(authoritativeSources as any);
		await service.whenReady();

		// This starts the lazy worker. Its recovered mirror contains a stale row
		// (or is corrupt), but open must mark rebuilding before search is accepted.
		await expect(service.search("StaleRecoveredMirrorToken")).rejects.toMatchObject({ code: "SEARCH_UNAVAILABLE", reason: "rebuilding" });
		expect((service as unknown as { _worker: unknown })._worker).not.toBeNull();
		expect((service as unknown as { _rebuildTimer: unknown })._rebuildTimer).not.toBeNull();
		expect(service.needsRebuild()).toBe(true);
		// Once a worker exists, stats continues to report its recovery fence rather
		// than treating the service as an idle index and masking incomplete results.
		await expect(service.getStats()).resolves.toMatchObject({ state: "ready", degraded: true, unavailableReason: "rebuilding" });

		await service.rebuildFromStores(authoritativeSources.goalStore as any, authoritativeSources.sessionStore as any, undefined, authoritativeSources.staffStore as any);
		expect(service.needsRebuild()).toBe(false);
		await expect(service.search(token, { type: "goals" })).resolves.toMatchObject({ total: 1 });
		await expect(service.search("StaleRecoveredMirrorToken")).resolves.toMatchObject({ total: 0 });
	} finally {
		await service.close();
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a saturated worker ingest queue is bounded and explicitly degraded", async () => {
	const service = new SearchService({ stateDir: tmp(), projectId: "p1" });
	const internals = service as unknown as {
		_call(command: string, payload?: unknown): Promise<unknown>;
		_pendingMutations: number;
	};
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	internals._call = () => blocked;
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
	try {
		service.open();
		await service.whenReady();
		const startedAt = Date.now();
		for (let i = 0; i < 1_001; i++) {
			service.indexMessage("s1", "Busy session", `bounded ingest ${i}`, [], i, "p1");
		}
		expect(Date.now() - startedAt).toBeLessThan(250);
		expect(internals._pendingMutations).toBeLessThanOrEqual(1_000);
		expect(warnings.some((line) => line.includes("ingest backlog saturated"))).toBe(true);
		const stats = await service.getStats();
		expect(stats.degraded).toBe(true);
		expect(stats.unavailableReason).toBe("backpressure");
		await expect(service.search("bounded ingest")).rejects.toMatchObject({ code: "SEARCH_UNAVAILABLE" });
	} finally {
		console.warn = originalWarn;
		release();
		await service.close();
		fs.rmSync(service.stateDir, { recursive: true, force: true });
	}
});

test("all worker RPC classes reject oversized payloads before queueing", async () => {
	const service = new SearchService({ stateDir: tmp(), projectId: "p1" });
	const internals = service as unknown as {
		_worker: { postMessage(message: unknown): void; terminate(): Promise<number> } | null;
		_post(command: string, payload?: unknown): Promise<unknown>;
	};
	internals._worker = { postMessage: () => { throw new Error("oversized requests must not reach worker"); }, terminate: async () => 0 };
	try {
		await expect(internals._post("search", { q: "x".repeat(9 * 1024 * 1024) })).rejects.toMatchObject({ code: "SEARCH_UNAVAILABLE" });
		await expect(internals._post("rebuild", { rows: ["x".repeat(9 * 1024 * 1024)] })).rejects.toMatchObject({ code: "SEARCH_UNAVAILABLE" });
	} finally {
		internals._worker = null;
		await service.close();
		fs.rmSync(service.stateDir, { recursive: true, force: true });
	}
});

test("a worker error is handled permanently and recovery rebuilds accepted data", async () => {
	const stateDir = tmp();
	const service = new SearchService({ stateDir, projectId: "p1", progressBus: new ProgressBus() });
	const goal = { id: "g1", title: "WorkerRecoveryGoal", spec: "rebuild source", state: "in-progress", createdAt: 1 };
	const stores = {
		goalStore: { getAll: () => [goal] },
		sessionStore: { getAll: () => [] },
		staffStore: { getAll: () => [] },
	};
	try {
		service.open(stores as any);
		await service.whenReady();
		await service.rebuildFromStores(stores.goalStore as any, stores.sessionStore as any, undefined, stores.staffStore as any);
		await service.search("starts worker");
		service.indexGoal(goal as any, "p1");
		await expect.poll(async () => (await service.search("WorkerRecoveryGoal")).total, { timeout: 5_000 }).toBe(1);
		const oldWorker = (service as unknown as { _worker: { emit(event: string, error: Error): boolean } | null })._worker;
		expect(oldWorker).not.toBeNull();
		expect(() => oldWorker!.emit("error", new Error("test worker crash"))).not.toThrow();
		await expect(service.search("WorkerRecoveryGoal")).rejects.toMatchObject({ code: "SEARCH_UNAVAILABLE" });

		await expect.poll(async () => {
			try { return (await service.search("WorkerRecoveryGoal")).total; }
			catch { return 0; }
		}, { timeout: 6_000 }).toBe(1);
	} finally {
		await service.close();
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
