import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SearchService } from "../../../src/server/search/search-service.ts";
import { ProgressBus } from "../../../src/server/search/progress-bus.ts";

function tmp(prefix = "search-service-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitForResult(service: SearchService, token: string): Promise<void> {
	await expect.poll(async () => (await service.search(token, { type: "messages" })).results.length, { timeout: 5_000 }).toBe(1);
}

test("open is ready without starting search work until an operation needs it", async () => {
	const stateDir = tmp();
	const service = new SearchService({ stateDir, projectId: "p1", progressBus: new ProgressBus() });
	try {
		service.open();
		await service.whenReady();
		expect(service.getState()).toBe("ready");
		expect(fs.existsSync(service.dataDir)).toBe(false);

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
	const first = new SearchService({ stateDir, projectId: "p1", progressBus: new ProgressBus() });
	try {
		first.open();
		await first.whenReady();
		first.indexMessage("s1", "Restart session", `message containing ${token}`, [], 123, "p1");
		await waitForResult(first, token);
		await first.close();

		const second = new SearchService({ stateDir, projectId: "p1", progressBus: new ProgressBus() });
		try {
			second.open();
			await second.whenReady();
			await waitForResult(second, token);
		} finally {
			await second.close();
		}
	} finally {
		if (first.getState() !== "closed") await first.close();
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
