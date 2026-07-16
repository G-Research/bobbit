import { afterAll, beforeAll, describe, it } from "vitest";
import * as maintenance from "./helpers/maintenance-api-support.js";

const {
	test, expect, apiFetch, registerProject,
	existsSync, mkdtempSync, rmSync, tmpdir, join,
	expectNumberCounts, expectNumberMap, normalizeTestPath, listedWorktreePaths,
	branchExists, initGitRepo, git, tryRemoveWorktree, tryDeleteBranch, maintenanceGit,
	seedArchivedSession, removeSeededSessions, gateway,
} = maintenance;
maintenance.registerMaintenanceHooks();

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
	const baseDir = maintenanceBaseDir;
	const repoPath = join(baseDir, "repo");
	const worktreePath = join(baseDir, "orphan-worktree");
	const branch = `session/malformed-validation-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	let projectId: string | undefined;
	let baseline: Awaited<ReturnType<typeof snapshotLegacyOrphan>>;

	async function snapshotLegacyOrphan() {
		const response = await apiFetch("/api/maintenance/orphaned-worktrees");
		expect(response.status).toBe(200);
		const body = await response.json();
		const inventory = (body.worktrees as any[])
			.map(item => ({ path: normalizeTestPath(item.path), branch: item.branch, repoPath: normalizeTestPath(item.repoPath) }))
			.sort((a, b) => `${a.repoPath}:${a.path}:${a.branch}`.localeCompare(`${b.repoPath}:${b.path}:${b.branch}`));
		return {
			pathExists: existsSync(worktreePath),
			branchExists: branchExists(repoPath, branch),
			worktreePaths: listedWorktreePaths(repoPath).sort(),
			inventory,
		};
	}

	async function expectLegacyOrphanUnchanged(label: string): Promise<void> {
		expect(await snapshotLegacyOrphan(), label).toEqual(baseline);
	}

	beforeAll(async () => {
		initGitRepo(repoPath);
		const project = await registerProject({ name: `cleanup validation ${Date.now()}`, rootPath: repoPath, seedWorkflows: false });
		projectId = project.id;
		git(repoPath, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
		baseline = await snapshotLegacyOrphan();
		expect(baseline).toMatchObject({ pathExists: true, branchExists: true });
		expect(baseline.worktreePaths).toContain(normalizeTestPath(worktreePath));
		expect(baseline.inventory).toContainEqual({
			path: normalizeTestPath(worktreePath),
			branch,
			repoPath: normalizeTestPath(repoPath),
		});
	});

	afterAll(async () => {
		tryRemoveWorktree(repoPath, worktreePath);
		tryDeleteBranch(repoPath, branch);
		if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		maintenanceGit.forgetRepo(repoPath);
	});

	it("rejects itemIds without mode", async () => {
		const malformed = await apiFetch("/api/maintenance/cleanup-worktrees", {
			method: "POST",
			body: JSON.stringify({ itemIds: ["canonical-selector-without-mode"] }),
		});
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
			const malformed = await apiFetch("/api/maintenance/cleanup-worktrees", {
				method: "POST",
				body: JSON.stringify(invalidBody.value),
			});
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
