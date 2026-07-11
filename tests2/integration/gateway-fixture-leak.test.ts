/**
 * Negative test for the gateway-fixture leak detector.
 *
 * Proves the detector actually catches a leak: we deliberately create a session
 * WITHOUT tracking it in a scope, snapshot entity counts before/after, and
 * assert that assertNoLeaks() throws. The file itself stays clean by purging the
 * leaked session in afterEach, so this test does not poison the shared fork.
 *
 * It also asserts the happy path: a scope that creates and cleans up a session
 * returns entity counts to baseline and assertNoLeaks() does NOT throw.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getGateway, type GatewayFixture } from "../harness/gateway.js";
import { assertNoLeaks, snapshotEntities } from "../harness/leak-detector.js";
import { createScope } from "../harness/scope.js";
import {
	expect as compatExpect,
	exportIntegrationHarnessCleanupStatsForProfile,
	integrationHarnessCleanupStats,
	resetIntegrationHarnessCleanupStats,
	test as compatTest,
} from "./_e2e/in-process-harness.js";

let gw: GatewayFixture;
const leakedSessionIds: string[] = [];

beforeAll(async () => {
	gw = await getGateway();
});

afterEach(async () => {
	// Purge any deliberately-leaked sessions so this file leaves no residue.
	for (const id of leakedSessionIds.splice(0)) {
		const resp = await gw.api(`/api/sessions/${id}?purge=true`, { method: "DELETE" });
		if (!resp.ok && resp.status !== 404) throw new Error(`cleanup failed: ${resp.status}`);
	}
});

describe("gateway fixture leak detector", () => {
	it("exports integration cleanup stats to the profiler directory", () => {
		const previousDir = process.env.BOBBIT_V2_HOOK_PROFILE_DIR;
		const dir = mkdtempSync(join(tmpdir(), "bobbit-hook-profile-"));
		try {
			process.env.BOBBIT_V2_HOOK_PROFILE_DIR = dir;
			resetIntegrationHarnessCleanupStats();

			const outPath = exportIntegrationHarnessCleanupStatsForProfile();

			expect(outPath).toBeTruthy();
			expect(outPath!.startsWith(dir)).toBe(true);
			const payload = JSON.parse(readFileSync(outPath!, "utf8"));
			expect(payload.kind).toBe("integration-harness-cleanup-stats");
			expect(payload.pid).toBe(process.pid);
			expect(payload.cleanupStats).toMatchObject({
				snapshots: 0,
				sweeps: 0,
				skippedSweeps: 0,
				uncertainSweeps: 0,
			});
		} finally {
			if (previousDir === undefined) delete process.env.BOBBIT_V2_HOOK_PROFILE_DIR;
			else process.env.BOBBIT_V2_HOOK_PROFILE_DIR = previousDir;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws when a test leaks a session", async () => {
		const before = snapshotEntities(gw);

		// Deliberate leak: create a session and do NOT track it in a scope.
		const session = await gw.apiJson<any>("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId: gw.defaultProjectId }),
		});
		expect(session?.id).toBeTruthy();
		leakedSessionIds.push(session.id);

		const after = snapshotEntities(gw);
		expect(after.sessions).toBe(before.sessions + 1);
		expect(() => assertNoLeaks(before, after)).toThrow(/entity leak detected/);
	});

	it("does not throw when a scope cleans up its session", async () => {
		const before = snapshotEntities(gw);

		const scope = createScope(gw);
		const session = await scope.createSession({});
		expect(session?.id).toBeTruthy();
		expect(snapshotEntities(gw).sessions).toBe(before.sessions + 1);

		await scope.cleanup();

		const after = snapshotEntities(gw);
		expect(after.sessions).toBe(before.sessions);
		expect(() => assertNoLeaks(before, after)).not.toThrow();
	});
});

function activeGoalIds(gateway: GatewayFixture): Set<string> {
	const ids = new Set<string>();
	for (const ctx of Array.from(gateway.projectContextManager.visible?.() ?? []) as any[]) {
		for (const goal of (ctx.goalStore?.getAll?.() ?? [])) {
			if (goal?.id && !goal.archived) ids.add(goal.id);
		}
	}
	return ids;
}

function visibleDefaultContext(gateway: GatewayFixture): any {
	for (const ctx of Array.from(gateway.projectContextManager.visible?.() ?? []) as any[]) {
		const project = ctx?.project;
		if (project?.name === "default" && !project.hidden) return ctx;
	}
	throw new Error("default project context not found");
}

async function defaultProjectRoot(gateway: GatewayFixture): Promise<string> {
	const list = await gateway.apiJson<any>("/api/projects");
	const projects: Array<{ id?: string; rootPath?: string; hidden?: boolean }> = Array.isArray(list) ? list : (list?.projects ?? []);
	const project = projects.find(p => p.id === gateway.defaultProjectId && !p.hidden);
	compatExpect(project?.rootPath).toBeTruthy();
	return project!.rootPath!;
}

let rawGoalId: string | undefined;
let restoreDefaultConfigGetAll: (() => void) | undefined;

compatTest.describe.serial("integration harness dirty cleanup", () => {
	compatTest.beforeAll(() => {
		resetIntegrationHarnessCleanupStats();
		rawGoalId = undefined;
		restoreDefaultConfigGetAll = undefined;
	});

	compatTest.afterAll(() => {
		restoreDefaultConfigGetAll?.();
		restoreDefaultConfigGetAll = undefined;
	});

	compatTest("records no-op tests as skipped sweeps without resetting the default project", async () => {
		// Intentionally empty: the assertion runs in the next test after harness afterEach.
	});

	compatTest("skips the previous no-op cleanup", async () => {
		const stats = integrationHarnessCleanupStats();
		compatExpect(stats.skippedSweeps).toBeGreaterThanOrEqual(1);
		compatExpect(stats.defaultResets).toBe(0);
		compatExpect(stats.defaultRestores).toBe(0);
	});

	compatTest("creates a raw API goal without scope helper tracking", async ({ gateway }) => {
		const goal = await gateway.apiJson<any>("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				projectId: gateway.defaultProjectId,
				title: "Raw cleanup goal",
				spec: "Created through raw gateway.api to prove cleanup detects helper bypasses.",
				cwd: await defaultProjectRoot(gateway),
				worktree: false,
			}),
		});
		rawGoalId = goal?.id ?? goal?.goalId ?? goal?.session?.goalId;
		compatExpect(rawGoalId).toBeTruthy();
		compatExpect(activeGoalIds(gateway).has(rawGoalId!)).toBe(true);
	});

	compatTest("cleans raw API-created entities even when helpers were bypassed", async ({ gateway }) => {
		compatExpect(rawGoalId).toBeTruthy();
		compatExpect(activeGoalIds(gateway).has(rawGoalId!)).toBe(false);
		const stats = integrationHarnessCleanupStats();
		compatExpect(stats.deletedGoals).toBeGreaterThanOrEqual(1);
	});

	compatTest("mutates default project config directly", async ({ gateway }) => {
		const res = await gateway.api(`/api/projects/${gateway.defaultProjectId}/config`, {
			method: "PUT",
			body: JSON.stringify({ components: [{ name: "mutated", repo: ".", commands: { build: "echo mutated" } }] }),
		});
		compatExpect(res.status).toBe(200);
		const structured = await gateway.apiJson<any>(`/api/projects/${gateway.defaultProjectId}/structured`);
		compatExpect(structured.components?.[0]?.name).toBe("mutated");
	});

	compatTest("heals default project mutations before the next test", async ({ gateway }) => {
		const stats = integrationHarnessCleanupStats();
		compatExpect(stats.defaultResets).toBeGreaterThanOrEqual(1);
		const structured = await gateway.apiJson<any>(`/api/projects/${gateway.defaultProjectId}/structured`);
		compatExpect(structured.components?.[0]?.name).toBe("test");
		compatExpect(structured.components?.[0]?.commands?.build).toBe("echo ok");
	});

	compatTest("treats uncertain default-project fingerprints as dirty", async ({ gateway }) => {
		const cfg = visibleDefaultContext(gateway).projectConfigStore;
		const original = cfg.getAll;
		restoreDefaultConfigGetAll = () => { cfg.getAll = original; };
		cfg.getAll = () => { throw new Error("intentional cleanup fingerprint failure"); };
	});

	compatTest("falls back to a conservative sweep when cleanliness is uncertain", () => {
		const stats = integrationHarnessCleanupStats();
		compatExpect(stats.uncertainSweeps).toBeGreaterThanOrEqual(1);
		restoreDefaultConfigGetAll?.();
		restoreDefaultConfigGetAll = undefined;
	});
});
