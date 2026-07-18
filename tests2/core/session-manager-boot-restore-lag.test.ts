import assert from "node:assert/strict";
import path from "node:path";
import { describe, it, vi } from "vitest";

vi.mock("../../src/server/agent/orphan-cleanup.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/server/agent/orphan-cleanup.ts")>();
	return {
		...original,
		scanOrphanedTranscriptsAsync: async () => ({ count: 0, paths: [] }),
	};
});

const { SessionManager } = await import("../../src/server/agent/session-manager.ts");

function persisted(id: string, overrides: Record<string, unknown> = {}): any {
	return {
		id,
		title: id,
		cwd: path.resolve("/pure/session-manager-restore"),
		projectId: "project",
		agentSessionFile: path.resolve("/pure/session-manager-restore", `${id}.jsonl`),
		createdAt: 1,
		lastActivity: 1,
		...overrides,
	};
}

function makeManager(rows: any[], lagSamples: number[]) {
	let sample = 0;
	const byId = new Map(rows.map((row) => [row.id, row]));
	const archived: string[] = [];
	const sessionStore = {
		getLive: () => rows,
		getAll: () => rows,
		get: (id: string) => byId.get(id),
		archive: (id: string) => { archived.push(id); },
	};
	const context = { project: { id: "project" }, sessionStore };
	const pcm = {
		getAllLiveSessions: () => rows,
		getAllSessions: () => rows,
		all: () => [context].values(),
		getOrCreate: (projectId: string) => projectId === "project" ? context : null,
	};
	const manager: any = Object.create(SessionManager.prototype);
	manager.projectContextManager = pcm;
	manager.sessions = new Map();
	manager.orchestrationCore = null;
	manager.clock = { now: () => Date.now() };
	manager._bootRestoreLagSampler = () => lagSamples[sample++] ?? 0;
	const attempted: string[] = [];
	const yieldAt: number[] = [];
	const yieldDelays: number[] = [];
	manager.restoreOneSession = async (row: any) => { attempted.push(row.id); };
	manager.yieldBootRestore = async (delay: number) => {
		yieldAt.push(attempted.length);
		yieldDelays.push(delay);
	};
	return { manager, attempted, archived, yieldAt, yieldDelays };
}

describe("SessionManager lag-aware eager boot restore", () => {
	it("uses nominal batches of five under healthy lag without deferring any session", async () => {
		const rows = Array.from({ length: 12 }, (_, i) => persisted(`s${i}`));
		const { manager, attempted, yieldAt, yieldDelays } = makeManager(rows, [0, 25, 50]);
		await manager.restoreSessions();
		assert.deepEqual(attempted, rows.map((row) => row.id));
		assert.deepEqual(yieldAt, [5, 10]);
		assert.deepEqual(yieldDelays, [0, 0]);
	});

	it("shrinks to one and applies bounded backoff under high lag", async () => {
		const rows = Array.from({ length: 4 }, (_, i) => persisted(`high${i}`));
		const { manager, attempted, yieldAt, yieldDelays } = makeManager(rows, [250, 250, 250, 250]);
		await manager.restoreSessions();
		assert.deepEqual(attempted, rows.map((row) => row.id));
		assert.deepEqual(yieldAt, [1, 2, 3]);
		assert.deepEqual(yieldDelays, [25, 25, 25]);
	});

	it("interpolates middle lag and advances by each actual batch length", async () => {
		const rows = Array.from({ length: 10 }, (_, i) => persisted(`mid${i}`));
		const { manager, attempted, yieldAt } = makeManager(rows, [125, 125, 125, 125]);
		await manager.restoreSessions();
		assert.deepEqual(attempted, rows.map((row) => row.id));
		assert.deepEqual(yieldAt, [3, 6, 9]);
	});

	it("changing lag changes only batch boundaries, never membership or input order", async () => {
		const rows = Array.from({ length: 12 }, (_, i) => persisted(`vary${i}`));
		const { manager, attempted, yieldAt } = makeManager(rows, [0, 250, 125, 0]);
		await manager.restoreSessions();
		assert.deepEqual(attempted, rows.map((row) => row.id));
		assert.deepEqual(yieldAt, [5, 6, 9]);
		assert.equal(new Set(attempted).size, rows.length);
	});

	it("preserves current-master regular plus surviving-delegate membership and order", async () => {
		const owner = persisted("owner");
		const regular = persisted("regular");
		const survivor = persisted("delegate-survivor", { delegateOf: owner.id });
		const orphan = persisted("delegate-orphan", { delegateOf: "missing-owner" });
		const { manager, attempted, archived } = makeManager([owner, survivor, orphan, regular], [0]);

		await manager.restoreSessions();
		assert.deepEqual(attempted, [owner.id, regular.id, survivor.id]);
		assert.deepEqual(archived, [orphan.id]);
	});
});
