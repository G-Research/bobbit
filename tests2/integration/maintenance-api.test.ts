import { afterAll, beforeAll, describe, it } from "vitest";
import type { CommandRunner } from "../../src/server/gateway-deps.js";
import { WorktreeInventoryService } from "../../src/server/agent/worktree-inventory.js";
import { executeCleanupWorktreesRequest } from "../../src/server/maintenance/cleanup-worktrees-request.js";
import * as maintenance from "./helpers/maintenance-api-support.js";
import { MaintenanceGitModel } from "./helpers/maintenance-git-model.js";

const {
	test, expect, apiFetch,
	existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, tmpdir, join,
	expectNumberCounts, expectNumberMap,
	seedArchivedSession, removeSeededSessions, gateway,
} = maintenance;
const maintenanceOwner = maintenance.createMaintenanceApiFixture("maintenance-api");
maintenanceOwner.registerMaintenanceHooks();

const maintenanceBaseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-maintenance-shared-"));
afterAll(() => rmSync(maintenanceBaseDir, { recursive: true, force: true }));

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
