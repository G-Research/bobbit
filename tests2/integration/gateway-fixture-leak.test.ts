/**
 * Fast decision coverage for the gateway fixture leak detector and dirty-cleanup
 * policy. The state model is deliberately test-owned: these tests exercise count
 * deltas, scope ownership, dirty signals, uncertain fingerprints, and cleanup
 * statistics without booting a gateway only to manufacture those states.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertNoLeaks, snapshotEntities } from "../harness/leak-detector.js";
import { createScope } from "../harness/scope.js";

type Counts = { sessions: number; goals: number; projects: number };

class EntityGateway {
	readonly defaultProjectId = "default-project";
	readonly sessions = new Set<string>();
	readonly goals = new Set<string>();
	private sequence = 0;

	countEntities(): Counts {
		return { sessions: this.sessions.size, goals: this.goals.size, projects: 1 };
	}

	async apiJson(path: string, init: RequestInit): Promise<any> {
		if (path === "/api/sessions" && init.method === "POST") {
			const id = `session-${++this.sequence}`;
			this.sessions.add(id);
			return { id };
		}
		if (path === "/api/goals" && init.method === "POST") {
			const id = `goal-${++this.sequence}`;
			this.goals.add(id);
			return { id };
		}
		throw new Error(`unexpected apiJson ${init.method} ${path}`);
	}

	async api(path: string, init: RequestInit): Promise<Response> {
		const session = /^\/api\/sessions\/([^?]+)/.exec(path)?.[1];
		if (init.method === "DELETE" && session) {
			const found = this.sessions.delete(session);
			return new Response(null, { status: found ? 204 : 404 });
		}
		const goal = /^\/api\/goals\/([^?]+)/.exec(path)?.[1];
		if (init.method === "DELETE" && goal) {
			const found = this.goals.delete(goal);
			return new Response(null, { status: found ? 204 : 404 });
		}
		return new Response(null, { status: 404 });
	}

	async restoreDefaultProject(): Promise<void> { /* stable baseline */ }
}

interface CleanupStats {
	snapshots: number;
	sweeps: number;
	skippedSweeps: number;
	uncertainSweeps: number;
	defaultResets: number;
	defaultRestores: number;
	deletedGoals: number;
}

class DirtyCleanupModel {
	readonly stats: CleanupStats = {
		snapshots: 0,
		sweeps: 0,
		skippedSweeps: 0,
		uncertainSweeps: 0,
		defaultResets: 0,
		defaultRestores: 0,
		deletedGoals: 0,
	};
	readonly goals = new Set<string>();
	defaultComponent = "test";
	defaultBuild = "echo ok";
	uncertain = false;

	cleanup(): void {
		this.stats.snapshots++;
		const dirtyDefault = this.defaultComponent !== "test" || this.defaultBuild !== "echo ok";
		if (this.goals.size === 0 && !dirtyDefault && !this.uncertain) {
			this.stats.skippedSweeps++;
			return;
		}
		this.stats.sweeps++;
		if (this.uncertain) this.stats.uncertainSweeps++;
		this.stats.deletedGoals += this.goals.size;
		this.goals.clear();
		if (dirtyDefault || this.uncertain) {
			this.defaultComponent = "test";
			this.defaultBuild = "echo ok";
			this.stats.defaultResets++;
		}
		this.uncertain = false;
	}
}

function exportStats(dir: string, stats: CleanupStats): string {
	const outPath = join(dir, `integration-harness-cleanup-${process.pid}.json`);
	writeFileSync(outPath, JSON.stringify({ kind: "integration-harness-cleanup-stats", pid: process.pid, cleanupStats: stats }));
	return outPath;
}

describe("gateway fixture leak detector", () => {
	let gateway: EntityGateway;

	beforeAll(() => { gateway = new EntityGateway(); });
	afterEach(() => {
		gateway.sessions.clear();
		gateway.goals.clear();
	});

	it("exports integration cleanup stats to the profiler directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "bobbit-hook-profile-"));
		try {
			const outPath = exportStats(dir, new DirtyCleanupModel().stats);
			const payload = JSON.parse(readFileSync(outPath, "utf8"));
			expect(payload.kind).toBe("integration-harness-cleanup-stats");
			expect(payload.pid).toBe(process.pid);
			expect(payload.cleanupStats).toMatchObject({
				snapshots: 0,
				sweeps: 0,
				skippedSweeps: 0,
				uncertainSweeps: 0,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws when a test leaks a session", async () => {
		const before = snapshotEntities(gateway as any);
		const session = await gateway.apiJson("/api/sessions", { method: "POST" });
		expect(session.id).toBeTruthy();
		const after = snapshotEntities(gateway as any);
		expect(after.sessions).toBe(before.sessions + 1);
		expect(() => assertNoLeaks(before, after)).toThrow(/entity leak detected/);
	});

	it("does not throw when a scope cleans up its session", async () => {
		const before = snapshotEntities(gateway as any);
		const scope = createScope(gateway as any);
		const session = await scope.createSession({});
		expect(session.id).toBeTruthy();
		expect(snapshotEntities(gateway as any).sessions).toBe(before.sessions + 1);
		await scope.cleanup();
		const after = snapshotEntities(gateway as any);
		expect(after.sessions).toBe(before.sessions);
		expect(() => assertNoLeaks(before, after)).not.toThrow();
	});
});

describe("integration harness dirty cleanup", () => {
	let cleanup: DirtyCleanupModel;
	let rawGoalId: string | undefined;

	beforeAll(() => {
		cleanup = new DirtyCleanupModel();
		rawGoalId = undefined;
	});
	afterEach(() => cleanup.cleanup());

	it("records no-op tests as skipped sweeps without resetting the default project", () => {
		// Intentionally empty: afterEach takes the clean fast path.
	});

	it("skips the previous no-op cleanup", () => {
		expect(cleanup.stats.skippedSweeps).toBeGreaterThanOrEqual(1);
		expect(cleanup.stats.defaultResets).toBe(0);
		expect(cleanup.stats.defaultRestores).toBe(0);
	});

	it("creates a raw API goal without scope helper tracking", () => {
		rawGoalId = "raw-cleanup-goal";
		cleanup.goals.add(rawGoalId);
		expect(cleanup.goals.has(rawGoalId)).toBe(true);
	});

	it("cleans raw API-created entities even when helpers were bypassed", () => {
		expect(rawGoalId).toBeTruthy();
		expect(cleanup.goals.has(rawGoalId!)).toBe(false);
		expect(cleanup.stats.deletedGoals).toBeGreaterThanOrEqual(1);
	});

	it("mutates default project config directly", () => {
		cleanup.defaultComponent = "mutated";
		cleanup.defaultBuild = "echo mutated";
		expect(cleanup.defaultComponent).toBe("mutated");
	});

	it("heals default project mutations before the next test", () => {
		expect(cleanup.stats.defaultResets).toBeGreaterThanOrEqual(1);
		expect(cleanup.defaultComponent).toBe("test");
		expect(cleanup.defaultBuild).toBe("echo ok");
	});

	it("treats uncertain default-project fingerprints as dirty", () => {
		cleanup.uncertain = true;
	});

	it("falls back to a conservative sweep when cleanliness is uncertain", () => {
		expect(cleanup.stats.uncertainSweeps).toBeGreaterThanOrEqual(1);
	});
});
