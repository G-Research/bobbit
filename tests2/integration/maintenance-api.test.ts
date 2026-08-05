import { afterAll, beforeAll, describe, it } from "vitest";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { CommandRunner } from "../../src/server/gateway-deps.js";
import { gateStoreV2Root, stableGateStoreId } from "../../src/server/agent/gate-store-v2-persistence.js";
import { WorktreeInventoryService } from "../../src/server/agent/worktree-inventory.js";
import { executeCleanupWorktreesRequest } from "../../src/server/maintenance/cleanup-worktrees-request.js";
import * as maintenance from "./helpers/maintenance-api-support.js";
import { MaintenanceGitModel } from "./helpers/maintenance-git-model.js";

const {
	test, expect, apiFetch,
	existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, tmpdir, join,
	expectNumberCounts, expectNumberMap,
	seedArchivedSession, removeSeededSessions, registerProject, gateway,
} = maintenance;
const maintenanceOwner = maintenance.createMaintenanceApiFixture("maintenance-api");
maintenanceOwner.registerMaintenanceHooks();

const maintenanceBaseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-maintenance-shared-"));
afterAll(() => rmSync(maintenanceBaseDir, { recursive: true, force: true }));

const MAINTENANCE_HEARTBEAT_MS = 5;
const MAX_MAINTENANCE_LAG_MS = 75;

type SeededMaintenanceInventory = {
	payloads: number;
	payloadBytes: number;
	auditRecords: number;
	auditBytes: number;
	largestPayloads: Array<{ name: string; bytes: number }>;
};

function startMaintenanceHeartbeat(): { warm: () => void; stop: () => { maxLagMs: number; samples: number } } {
	let last = performance.now();
	let maxLagMs = 0;
	let samples = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		maxLagMs = Math.max(maxLagMs, Math.max(0, now - last - MAINTENANCE_HEARTBEAT_MS));
		last = now;
		samples++;
	}, MAINTENANCE_HEARTBEAT_MS);
	return {
		warm: () => { last = performance.now(); maxLagMs = 0; samples = 0; },
		stop: () => { clearInterval(timer); return { maxLagMs, samples }; },
	};
}

function seedMaintenanceInventory(
	stateDir: string,
	fixtureId: string,
	counts: { payloads: number; audits: number },
): SeededMaintenanceInventory {
	const v2Root = gateStoreV2Root(stateDir);
	let payloadBytes = 0;
	let auditBytes = 0;
	const largestPayloads: Array<{ name: string; bytes: number }> = [];
	for (let index = 0; index < counts.payloads; index++) {
		const hash = createHash("sha256").update(`${fixtureId}:payload:${index}`).digest("hex");
		const name = `${hash}.payload`;
		const body = "p".repeat(128 + index);
		const directory = join(v2Root, "payloads", hash.slice(0, 2));
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, name), body);
		const bytes = Buffer.byteLength(body);
		payloadBytes += bytes;
		largestPayloads.push({ name, bytes });
	}
	const goalHash = stableGateStoreId(`${fixtureId}:goal`);
	const gateHash = stableGateStoreId(`${fixtureId}:gate`);
	const auditDirectory = join(v2Root, "audit", goalHash, gateHash);
	mkdirSync(auditDirectory, { recursive: true });
	for (let index = 0; index < counts.audits; index++) {
		const signalHash = stableGateStoreId(`${fixtureId}:audit:${index}`);
		const name = `${String(index).padStart(16, "0")}-${signalHash}.json`;
		const body = JSON.stringify({ fixtureId, index });
		writeFileSync(join(auditDirectory, name), body);
		auditBytes += Buffer.byteLength(body);
	}
	largestPayloads.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
	return { payloads: counts.payloads, payloadBytes, auditRecords: counts.audits, auditBytes, largestPayloads: largestPayloads.slice(0, 20) };
}

function expectBoundedMaintenanceScan(body: any): void {
	expect(body.scan, "GATE_MAINTENANCE_WORKER_SCAN_METADATA_MISSING: report must expose bounded worker/cache provenance").toMatchObject({
		id: expect.any(String),
		generatedAt: expect.any(Number),
		source: expect.stringMatching(/^(scan|coalesced|cache|stale)$/),
		peakRetainedEntries: expect.any(Number),
	});
	expect(body.scan.peakRetainedEntries).toBeLessThanOrEqual(20);
	expect(body.largest).toHaveLength(20);
	expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(32 * 1024);
}

// ---------------------------------------------------------------------------
// GET /api/maintenance/worktrees
// ---------------------------------------------------------------------------
test("GET /api/maintenance/worktrees returns canonical inventory shape", async () => {
	const resp = await apiFetch("/api/maintenance/worktrees");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(Array.isArray(body.items)).toBe(true);
	expectNumberCounts(body, ["total", "readyToClean", "protectedInUse", "archivedOwned", "unownedGitWorktrees", "poolEntries", "alreadyCleaned", "needsAttention", "scanErrors", "defaultSelected"]);
	expectNumberMap(body.counts.byClassification, "counts.byClassification");
	expectNumberMap(body.counts.byReason, "counts.byReason");
	expectNumberMap(body.counts.bySource, "counts.bySource");
	expect(typeof body.generatedAt).toBe("number");
	for (const item of body.items as any[]) {
		expect(typeof item.id).toBe("string");
		expect(typeof item.classification).toBe("string");
		expect(Array.isArray(item.sources)).toBe(true);
		expect(Array.isArray(item.owners)).toBe(true);
		expect(typeof item.reason).toBe("string");
		expect(typeof item.detail).toBe("string");
		expect(typeof item.actionable).toBe("boolean");
		expect(typeof item.defaultSelected).toBe("boolean");
	}
});

// ---------------------------------------------------------------------------
// GET /api/maintenance/orphaned-worktrees
// ---------------------------------------------------------------------------
test("GET /api/maintenance/orphaned-worktrees returns list", async () => {
	const resp = await apiFetch("/api/maintenance/orphaned-worktrees");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(body).toHaveProperty("worktrees");
	expect(Array.isArray(body.worktrees)).toBe(true);
});

test("GET /api/maintenance/gate-store requires and scopes to a project", async () => {
	const missingProject = await apiFetch("/api/maintenance/gate-store");
	expect(missingProject.status).toBe(400);
	expect(await missingProject.json()).toMatchObject({ error: "Missing projectId" });

	const unknownProject = await apiFetch("/api/maintenance/gate-store?projectId=missing-project");
	expect(unknownProject.status).toBe(404);

	const projectId = gateway().defaultProjectId;
	const resp = await apiFetch(`/api/maintenance/gate-store?projectId=${encodeURIComponent(projectId)}`);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(body).toMatchObject({
		schemaVersion: 2,
		migration: { state: "complete" },
		cutoffs: {
			hotSignals: expect.any(Number),
			ordinarySignals: expect.any(Number),
			ordinaryBytes: expect.any(Number),
		},
		totals: {
			goalBytes: expect.any(Number),
			legacyBytes: expect.any(Number),
			payloadBytes: expect.any(Number),
		},
		staleStaging: expect.any(Boolean),
	});
	expect(body.largest.length).toBeLessThanOrEqual(20);
	expect(JSON.stringify(body)).not.toContain("content");
	expect(JSON.stringify(body)).not.toContain("diagnostics");
});

test("GET /api/maintenance/gate-store coalesces and caches bounded off-loop scans with exact project totals", async () => {
	test.slow();
	const rootA = join(maintenanceBaseDir, `gate-report-wide-a-${Date.now()}`);
	const rootB = join(maintenanceBaseDir, `gate-report-wide-b-${Date.now()}`);
	mkdirSync(rootA, { recursive: true });
	mkdirSync(rootB, { recursive: true });
	const projectA = await registerProject({ name: `gate-report-wide-a-${Date.now()}`, rootPath: rootA, seedWorkflows: false });
	const projectB = await registerProject({ name: `gate-report-wide-b-${Date.now()}`, rootPath: rootB, seedWorkflows: false });
	const contextA = gateway().projectContextManager.getOrCreate(projectA.id);
	const contextB = gateway().projectContextManager.getOrCreate(projectB.id);
	expect(contextA).toBeTruthy();
	expect(contextB).toBeTruthy();

	const fixtureA = seedMaintenanceInventory(contextA.stateDir, "wide-a", { payloads: 1_200, audits: 800 });
	const fixtureB = seedMaintenanceInventory(contextB.stateDir, "isolated-b", { payloads: 7, audits: 3 });
	const urlA = `/api/maintenance/gate-store?projectId=${encodeURIComponent(projectA.id)}`;
	const urlB = `/api/maintenance/gate-store?projectId=${encodeURIComponent(projectB.id)}`;

	const heartbeat = startMaintenanceHeartbeat();
	await new Promise(resolve => setTimeout(resolve, 100));
	heartbeat.warm();
	const responses = await Promise.all(Array.from({ length: 16 }, () => apiFetch(urlA)));
	await new Promise(resolve => setTimeout(resolve, MAINTENANCE_HEARTBEAT_MS * 3));
	const lag = heartbeat.stop();
	const reports = await Promise.all(responses.map(async response => {
		expect(response.status).toBe(200);
		return response.json();
	}));

	for (const report of reports) {
		expectBoundedMaintenanceScan(report);
		expect(report.totals).toMatchObject({
			payloads: fixtureA.payloads,
			payloadBytes: fixtureA.payloadBytes,
			auditRecords: fixtureA.auditRecords,
			auditBytes: fixtureA.auditBytes,
		});
		expect(report.largest).toEqual(fixtureA.largestPayloads.map(row => ({ ...row, kind: "payload", exceedsLimit: false })));
	}
	const scanIds = new Set(reports.map(report => report.scan.id));
	expect(scanIds.size, "GATE_MAINTENANCE_SCAN_NOT_COALESCED: concurrent probes must join one worker inventory").toBe(1);
	expect(reports.filter(report => report.scan.source === "scan")).toHaveLength(1);
	expect(reports.some(report => report.scan.source === "coalesced")).toBe(true);
	expect(lag.samples).toBeGreaterThan(0);
	expect(lag.maxLagMs, `GATE_MAINTENANCE_EVENT_LOOP_STALL: wide scan stalled ${lag.maxLagMs.toFixed(1)}ms`).toBeLessThanOrEqual(MAX_MAINTENANCE_LAG_MS);

	const cachedResponse = await apiFetch(urlA);
	expect(cachedResponse.status).toBe(200);
	const cached = await cachedResponse.json();
	expect(cached.scan).toMatchObject({ id: reports[0].scan.id, generatedAt: reports[0].scan.generatedAt, source: "cache" });
	expect(cached.totals).toEqual(reports[0].totals);

	const isolatedResponse = await apiFetch(urlB);
	expect(isolatedResponse.status).toBe(200);
	const isolated = await isolatedResponse.json();
	expect(isolated.totals).toMatchObject({
		payloads: fixtureB.payloads,
		payloadBytes: fixtureB.payloadBytes,
		auditRecords: fixtureB.auditRecords,
		auditBytes: fixtureB.auditBytes,
	});
	expect(isolated.scan.id).not.toBe(reports[0].scan.id);
	expect(JSON.stringify(isolated)).not.toContain(fixtureA.largestPayloads[0]!.name);
});

test("GET /api/maintenance/gate-store bounds worker scan failures without a synchronous fallback", async () => {
	const root = join(maintenanceBaseDir, `gate-report-failure-${Date.now()}`);
	mkdirSync(root, { recursive: true });
	const project = await registerProject({ name: `gate-report-failure-${Date.now()}`, rootPath: root, seedWorkflows: false });
	const context = gateway().projectContextManager.getOrCreate(project.id);
	expect(context).toBeTruthy();
	const payloadRoot = join(gateStoreV2Root(context.stateDir), "payloads");
	mkdirSync(payloadRoot, { recursive: true });
	writeFileSync(join(payloadRoot, "aa"), "valid-prefix-is-not-a-directory");

	const heartbeat = startMaintenanceHeartbeat();
	await new Promise(resolve => setTimeout(resolve, 25));
	heartbeat.warm();
	let response!: Response;
	let lag!: { maxLagMs: number; samples: number };
	try {
		response = await apiFetch(`/api/maintenance/gate-store?projectId=${encodeURIComponent(project.id)}`, {
			signal: AbortSignal.timeout(2_000),
		});
		await new Promise(resolve => setTimeout(resolve, MAINTENANCE_HEARTBEAT_MS * 3));
	} catch (error) {
		throw new Error("GATE_MAINTENANCE_FAILURE_RESPONSE_MISSING: a worker scan failure must return a bounded retryable response", { cause: error });
	} finally {
		lag = heartbeat.stop();
	}
	const body = await response.json();

	expect(response.status).toBe(503);
	expect(body).toMatchObject({
		error: "Gate store maintenance report unavailable",
		scan: { source: "unavailable", retryable: true },
	});
	expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(4 * 1024);
	expect(JSON.stringify(body)).not.toContain(context.stateDir);
	expect(lag.maxLagMs, `GATE_MAINTENANCE_FAILURE_SYNC_FALLBACK: failed scan stalled ${lag.maxLagMs.toFixed(1)}ms`).toBeLessThanOrEqual(MAX_MAINTENANCE_LAG_MS);
});

// ---------------------------------------------------------------------------
// POST /api/maintenance/cleanup-worktrees returns cleaned count
// ---------------------------------------------------------------------------
test("POST /api/maintenance/cleanup-worktrees returns cleaned count", async () => {
	test.slow(); // Worktree scan can be slow when other tests create worktrees concurrently
	const resp = await apiFetch("/api/maintenance/cleanup-worktrees", {
		method: "POST",
		body: JSON.stringify({}),
	});
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(body).toHaveProperty("cleaned");
	expect(typeof body.cleaned).toBe("number");
});

test("POST /api/maintenance/cleanup-worktrees rejects malformed canonical cleanup bodies", async () => {
	const invalidMode = await apiFetch("/api/maintenance/cleanup-worktrees", {
		method: "POST",
		body: JSON.stringify({ mode: "all" }),
	});
	expect(invalidMode.status).toBe(400);

	const selectedWithLegacyShape = await apiFetch("/api/maintenance/cleanup-worktrees", {
		method: "POST",
		body: JSON.stringify({ mode: "selected", worktrees: [] }),
	});
	expect(selectedWithLegacyShape.status).toBe(400);

	const legacyShape = await apiFetch("/api/maintenance/cleanup-worktrees", {
		method: "POST",
		body: JSON.stringify({ worktrees: [] }),
	});
	expect(legacyShape.status).toBe(200);
	expect(await legacyShape.json()).toHaveProperty("cleaned");
});

describe("cleanup-worktrees validation preserves one shared legacy orphan", () => {
	const baseDir = join(maintenanceBaseDir, "validation-core");
	const repoPath = join(baseDir, "repo");
	const worktreePath = join(baseDir, "orphan-worktree");
	const branch = `session/malformed-validation-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	const validationGit = new MaintenanceGitModel("maintenance-api-malformed-validation");
	const validationRunner: CommandRunner = {
		async execFile(file, args, options) {
			if (!/(^|[\\/])git(?:\.exe)?$/i.test(file)) throw new Error(`unexpected validation fixture executable: ${file}`);
			const cwd = typeof options?.cwd === "string" ? options.cwd : repoPath;
			return { stdout: validationGit.run(cwd, args), stderr: "" };
		},
	};
	const emptySessionStore = { getArchived: () => [], getLive: () => [], get: () => undefined };
	const emptyRecordStore = { getAll: () => [] };
	const projectContext = {
		project: { id: "maintenance-validation-project", name: "Maintenance validation", rootPath: repoPath },
		projectConfigStore: { getComponents: () => [], get: () => undefined },
		sessionStore: emptySessionStore,
		goalStore: emptyRecordStore,
		teamStore: emptyRecordStore,
		staffStore: emptyRecordStore,
	};
	const validationInventory = new WorktreeInventoryService({
		projectContextManager: { visible: () => [projectContext], all: () => [projectContext] } as any,
		sessionManager: { listSessions: () => [], getAllWorktreePools: () => new Map() } as any,
		commandRunner: validationRunner,
	});
	let baseline: Awaited<ReturnType<typeof snapshotLegacyOrphan>>;

	const normalizePath = (value: string) => value.replace(/\\/g, "/").toLowerCase();

	async function snapshotLegacyOrphan() {
		const body = await validationInventory.legacyOrphanedWorktrees();
		const inventory = body.worktrees
			.map(item => ({ path: normalizePath(item.path), branch: item.branch, repoPath: normalizePath(item.repoPath) }))
			.sort((a, b) => `${a.repoPath}:${a.path}:${a.branch}`.localeCompare(`${b.repoPath}:${b.path}:${b.branch}`));
		return {
			pathExists: existsSync(worktreePath),
			branchExists: validationGit.branchExists(repoPath, branch),
			worktreePaths: validationGit.listedWorktreePaths(repoPath).map(normalizePath).sort(),
			inventory,
		};
	}

	async function expectLegacyOrphanUnchanged(label: string): Promise<void> {
		expect(await snapshotLegacyOrphan(), label).toEqual(baseline);
	}

	beforeAll(async () => {
		mkdirSync(join(repoPath, ".git"), { recursive: true });
		writeFileSync(join(repoPath, "README.md"), "# isolated maintenance validation fixture\n");
		validationGit.registerRepo(repoPath);
		validationGit.addWorktree(repoPath, worktreePath, branch);
		baseline = await snapshotLegacyOrphan();
		expect(baseline).toMatchObject({ pathExists: true, branchExists: true });
		expect(baseline.worktreePaths).toContain(normalizePath(worktreePath));
		expect(baseline.inventory).toContainEqual({
			path: normalizePath(worktreePath),
			branch,
			repoPath: normalizePath(repoPath),
		});
	});

	afterAll(() => {
		validationGit.forgetRepo(repoPath);
		validationGit.reset();
	});

	it("rejects itemIds without mode", async () => {
		const malformed = await executeCleanupWorktreesRequest(
			{ itemIds: ["canonical-selector-without-mode"] },
			true,
			validationInventory,
		);
		expect(malformed.status).toBe(400);
		await expectLegacyOrphanUnchanged("itemIds without mode");
	});

	it("rejects every non-object body", async () => {
		const invalidBodies = [
			{ label: "array", value: [] },
			{ label: "string", value: "legacy-orphaned" },
			{ label: "number", value: 1 },
			{ label: "boolean", value: true },
			{ label: "null", value: null },
		] as const;

		for (const invalidBody of invalidBodies) {
			const malformed = await executeCleanupWorktreesRequest(invalidBody.value, true, validationInventory);
			expect(malformed.status, invalidBody.label).toBe(400);
			await expectLegacyOrphanUnchanged(invalidBody.label);
		}
	});
});

// ---------------------------------------------------------------------------
// GET /api/maintenance/orphaned-sessions
// ---------------------------------------------------------------------------
test("GET /api/maintenance/orphaned-sessions returns list", async () => {
	const resp = await apiFetch("/api/maintenance/orphaned-sessions");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(body).toHaveProperty("sessions");
	expect(Array.isArray(body.sessions)).toBe(true);
});

// ---------------------------------------------------------------------------
// POST /api/maintenance/cleanup-sessions
// ---------------------------------------------------------------------------
test("POST /api/maintenance/cleanup-sessions returns terminated count", async () => {
	const resp = await apiFetch("/api/maintenance/cleanup-sessions", {
		method: "POST",
		body: JSON.stringify({}),
	});
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(body).toHaveProperty("terminated");
	expect(typeof body.terminated).toBe("number");
});

// ---------------------------------------------------------------------------
// GET /api/maintenance/expired-archives
// ---------------------------------------------------------------------------
test("GET /api/maintenance/expired-archives returns stats", async () => {
	const resp = await apiFetch("/api/maintenance/expired-archives");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(body).toHaveProperty("count");
	expect(body).toHaveProperty("totalSizeBytes");
	expect(typeof body.count).toBe("number");
	expect(typeof body.totalSizeBytes).toBe("number");
});

// ---------------------------------------------------------------------------
// POST /api/maintenance/purge-archives
// ---------------------------------------------------------------------------
test("POST /api/maintenance/purge-archives runs purge", async () => {
	const resp = await apiFetch("/api/maintenance/purge-archives", {
		method: "POST",
		body: JSON.stringify({}),
	});
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(body).toHaveProperty("purged", true);
	expect(body).toHaveProperty("remaining");
});

// ---------------------------------------------------------------------------
// Integration: create a session, terminate (archive) it, check expired-archives
// ---------------------------------------------------------------------------
test("expired archives stats reflect archived sessions", async () => {
	const seeded = await seedArchivedSession(gateway(), {
		baseDir: maintenanceBaseDir,
		title: "Fresh archived maintenance candidate",
		archivedAt: Date.now(),
	});
	try {
		// Get expired archive stats — newly archived session shouldn't be expired (< 7 days old)
		const statsResp = await apiFetch("/api/maintenance/expired-archives");
		expect(statsResp.status).toBe(200);
		const stats = await statsResp.json();
		// Fresh archive should NOT be expired — count should stay at 0 in clean test env
		expect(stats.count).toBe(0);
	} finally {
		removeSeededSessions([seeded]);
	}
});
