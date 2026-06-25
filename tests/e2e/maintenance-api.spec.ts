/**
 * E2E tests for the /api/maintenance/* endpoints.
 *
 * Tests Phase 1 (no auto-cleanup on restart) and Phase 4a (maintenance REST API).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, apiFetch, createSession, deleteSession, defaultProjectId } from "./e2e-setup.js";

let token: string;

test.beforeAll(() => {
	token = readE2EToken();
});

type SeededSession = {
	ctx: any;
	session: any;
	projectId: string;
};

const archivedScanCountKeys = [
	"archivedSessions",
	"sessionsWithWorktrees",
	"removableWorktrees",
	"skippedWorktrees",
	"alreadyCleanedWorktrees",
] as const;

const archivedCleanupCountKeys = [
	"requested",
	"cleaned",
	"branchDeleted",
	"skipped",
	"alreadyCleaned",
	"failed",
] as const;

function expectNumberCounts(body: any, keys: readonly string[]): void {
	expect(body).toHaveProperty("counts");
	for (const key of keys) {
		expect(typeof body.counts[key], `counts.${key}`).toBe("number");
	}
}

function expectArchivedScanShape(body: any): void {
	expect(body).toHaveProperty("sessions");
	expect(Array.isArray(body.sessions)).toBe(true);
	expectNumberCounts(body, archivedScanCountKeys);
	for (const session of body.sessions as any[]) {
		expect(typeof session.id).toBe("string");
		expect(typeof session.title).toBe("string");
		expect(Array.isArray(session.worktrees)).toBe(true);
		for (const item of session.worktrees as any[]) {
			expect(typeof item.key).toBe("string");
			expect(item.sessionId).toBe(session.id);
			expect(typeof item.repo).toBe("string");
			expect(typeof item.repoPath).toBe("string");
			expect(typeof item.path).toBe("string");
			expect(typeof item.pathExists).toBe("boolean");
			expect(typeof item.gitWorktreeMetadataExists).toBe("boolean");
			expect(typeof item.localBranchExists).toBe("boolean");
			expect(["removable", "skipped", "already-cleaned"]).toContain(item.status);
			expect(typeof item.reason).toBe("string");
			expect(typeof item.detail).toBe("string");
			expect(typeof item.willDeleteBranch).toBe("boolean");
		}
	}
}

function expectArchivedCleanupShape(body: any): void {
	expectNumberCounts(body, archivedCleanupCountKeys);
	expect(Array.isArray(body.results)).toBe(true);
	for (const result of body.results as any[]) {
		expect(typeof result.key).toBe("string");
		expect(typeof result.sessionId).toBe("string");
		expect(["cleaned", "skipped", "already-cleaned", "failed"]).toContain(result.status);
		expect(typeof result.worktreeRemoved).toBe("boolean");
		expect(typeof result.branchDeleted).toBe("boolean");
	}
}

function git(repoPath: string, args: string[]): string {
	return execFileSync("git", args, { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function branchExists(repoPath: string, branch: string): boolean {
	try {
		execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function initGitRepo(path: string): void {
	mkdirSync(path, { recursive: true });
	git(path, ["init"]);
	git(path, ["config", "user.email", "e2e@example.invalid"]);
	git(path, ["config", "user.name", "E2E Test"]);
	writeFileSync(join(path, "README.md"), "# archived worktree maintenance e2e\n");
	git(path, ["add", "."]);
	git(path, ["commit", "-m", "init"]);
}

function tryRemoveWorktree(repoPath: string, worktreePath: string): void {
	try { execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath, stdio: "ignore" }); } catch { /* best effort */ }
}

function tryDeleteBranch(repoPath: string, branch: string): void {
	try { execFileSync("git", ["branch", "-D", branch], { cwd: repoPath, stdio: "ignore" }); } catch { /* best effort */ }
}

async function seedArchivedSession(gateway: any, overrides: Partial<any> & { id?: string; title?: string; baseDir?: string } = {}): Promise<SeededSession> {
	const projectId = await defaultProjectId();
	expect(projectId).toBeTruthy();
	const ctx = gateway.projectContextManager.getOrCreate(projectId!);
	expect(ctx).toBeTruthy();
	const now = Date.now();
	const baseDir = overrides.baseDir ?? mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-session-"));
	const id = overrides.id ?? `archived-wt-${now}-${Math.random().toString(36).slice(2, 8)}`;
	const agentSessionFile = overrides.agentSessionFile ?? join(baseDir, `${id}.jsonl`);
	mkdirSync(dirname(agentSessionFile), { recursive: true });
	if (!existsSync(agentSessionFile)) {
		writeFileSync(agentSessionFile, JSON.stringify({ type: "system", cwd: overrides.cwd ?? baseDir }) + "\n");
	}
	const session = {
		id,
		title: overrides.title ?? `Archived worktree ${id}`,
		cwd: overrides.cwd ?? baseDir,
		agentSessionFile,
		createdAt: now - 1000,
		lastActivity: now - 500,
		archived: true,
		archivedAt: now,
		projectId,
		...overrides,
	};
	delete session.baseDir;
	ctx.sessionStore.put(session);
	return { ctx, session, projectId: projectId! };
}

function findArchivedSession(scan: any, sessionId: string): any | undefined {
	return (scan.sessions as any[]).find((session) => session.id === sessionId);
}

async function getArchivedWorktreeScan(query = ""): Promise<any> {
	const resp = await apiFetch(`/api/maintenance/archived-session-worktrees${query}`);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expectArchivedScanShape(body);
	return body;
}

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
// Archived session worktree maintenance
// ---------------------------------------------------------------------------
test.describe("archived session worktree maintenance", () => {
	test("GET /api/maintenance/archived-session-worktrees returns sessions and counts", async () => {
		const body = await getArchivedWorktreeScan();
		expectArchivedScanShape(body);
	});

	test("POST /api/maintenance/cleanup-archived-session-worktrees validates request shape", async () => {
		const missingMode = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(missingMode.status).toBe(400);

		const mixedSelectors = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
			method: "POST",
			body: JSON.stringify({
				mode: "selected",
				sessionIds: ["archived-a"],
				worktrees: [{ sessionId: "archived-a", key: "archived-a:." }],
			}),
		});
		expect(mixedSelectors.status).toBe(400);

		const emptySelected = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
			method: "POST",
			body: JSON.stringify({ mode: "selected", worktrees: [] }),
		});
		expect(emptySelected.status).toBe(200);
		const emptyBody = await emptySelected.json();
		expectArchivedCleanupShape(emptyBody);
		expect(emptyBody.counts).toMatchObject({
			requested: 0,
			cleaned: 0,
			branchDeleted: 0,
			skipped: 0,
			alreadyCleaned: 0,
			failed: 0,
		});
		expect(emptyBody.results).toEqual([]);

		const allMode = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
			method: "POST",
			body: JSON.stringify({ mode: "all" }),
		});
		expect(allMode.status).toBe(200);
		expectArchivedCleanupShape(await allMode.json());
	});

	test("scan and selected cleanup remove archived worktree while preserving archived session visibility", async ({ gateway }) => {
		test.slow();
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-cleanup-"));
		const repoPath = join(baseDir, "repo");
		const worktreePath = join(baseDir, "worktree");
		const branch = `archived-cleanup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			git(repoPath, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
			expect(existsSync(worktreePath)).toBe(true);
			expect(branchExists(repoPath, branch)).toBe(true);

			seeded = await seedArchivedSession(gateway, {
				baseDir,
				title: "Archived cleanup candidate",
				cwd: worktreePath,
				repoPath,
				worktreePath,
				branch,
			});

			const scan = await getArchivedWorktreeScan();
			const scannedSession = findArchivedSession(scan, seeded.session.id);
			expect(scannedSession).toBeTruthy();
			expect(scannedSession.worktrees).toHaveLength(1);
			const candidate = scannedSession.worktrees[0];
			expect(candidate.status).toBe("removable");
			expect(candidate.path).toBe(worktreePath);
			expect(candidate.repoPath).toBe(repoPath);
			expect(candidate.pathExists).toBe(true);
			expect(candidate.gitWorktreeMetadataExists).toBe(true);
			expect(candidate.localBranchExists).toBe(true);
			expect(candidate.willDeleteBranch).toBe(true);

			const cleanup = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
				method: "POST",
				body: JSON.stringify({
					mode: "selected",
					worktrees: [{ sessionId: seeded.session.id, key: candidate.key }],
				}),
			});
			expect(cleanup.status).toBe(200);
			const cleanupBody = await cleanup.json();
			expectArchivedCleanupShape(cleanupBody);
			expect(cleanupBody.counts.cleaned).toBe(1);
			expect(cleanupBody.counts.branchDeleted).toBe(1);
			expect(cleanupBody.counts.failed).toBe(0);
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: seeded.session.id,
				key: candidate.key,
				status: "cleaned",
				worktreeRemoved: true,
				branchDeleted: true,
			}));
			expect(existsSync(worktreePath)).toBe(false);
			expect(branchExists(repoPath, branch)).toBe(false);

			const archivedResp = await apiFetch(`/api/sessions/${seeded.session.id}?include=archived`);
			expect(archivedResp.status).toBe(200);
			const archivedSession = await archivedResp.json();
			expect(archivedSession).toMatchObject({
				id: seeded.session.id,
				title: "Archived cleanup candidate",
				archived: true,
				repoPath,
				worktreePath,
				branch,
			});
			expect(existsSync(seeded.session.agentSessionFile)).toBe(true);

			const rescan = await getArchivedWorktreeScan();
			expect(findArchivedSession(rescan, seeded.session.id)).toBeUndefined();
		} finally {
			if (seeded) seeded.ctx.sessionStore.remove(seeded.session.id);
			tryRemoveWorktree(repoPath, worktreePath);
			tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	test("already-cleaned archived worktrees are hidden by default and stale selected cleanup is non-destructive", async ({ gateway }) => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-stale-"));
		const repoPath = join(baseDir, "repo");
		const missingWorktreePath = join(baseDir, "missing-worktree");
		const branch = `archived-stale-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			git(repoPath, ["branch", branch, "HEAD"]);
			seeded = await seedArchivedSession(gateway, {
				baseDir,
				title: "Archived already cleaned candidate",
				cwd: missingWorktreePath,
				repoPath,
				worktreePath: missingWorktreePath,
				branch,
			});

			const defaultScan = await getArchivedWorktreeScan();
			expect(findArchivedSession(defaultScan, seeded.session.id)).toBeUndefined();

			const diagnosticScan = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
			const diagnosticSession = findArchivedSession(diagnosticScan, seeded.session.id);
			expect(diagnosticSession).toBeTruthy();
			expect(diagnosticSession.worktrees).toHaveLength(1);
			const item = diagnosticSession.worktrees[0];
			expect(item.status).toBe("already-cleaned");
			expect(item.pathExists).toBe(false);
			expect(item.gitWorktreeMetadataExists).toBe(false);
			expect(item.localBranchExists).toBe(true);
			expect(item.willDeleteBranch).toBe(false);

			const cleanup = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
				method: "POST",
				body: JSON.stringify({
					mode: "selected",
					worktrees: [{ sessionId: seeded.session.id, key: item.key }],
				}),
			});
			expect(cleanup.status).toBe(200);
			const cleanupBody = await cleanup.json();
			expectArchivedCleanupShape(cleanupBody);
			expect(cleanupBody.counts.cleaned).toBe(0);
			expect(cleanupBody.counts.branchDeleted).toBe(0);
			expect(cleanupBody.counts.failed).toBe(0);
			expect(cleanupBody.counts.alreadyCleaned).toBe(1);
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: seeded.session.id,
				key: item.key,
				status: "already-cleaned",
				worktreeRemoved: false,
				branchDeleted: false,
			}));
			expect(branchExists(repoPath, branch)).toBe(true);
		} finally {
			if (seeded) seeded.ctx.sessionStore.remove(seeded.session.id);
			tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	test("sandbox container paths are skipped instead of treated as host worktrees", async ({ gateway }) => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-sandbox-"));
		const repoPath = join(baseDir, "repo");
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			seeded = await seedArchivedSession(gateway, {
				baseDir,
				title: "Archived sandbox worktree",
				cwd: "/workspace-wt/session/archived-sandbox",
				repoPath,
				worktreePath: "/workspace-wt/session/archived-sandbox",
				branch: "archived-sandbox-branch",
				sandboxed: true,
			});

			const scan = await getArchivedWorktreeScan();
			const scannedSession = findArchivedSession(scan, seeded.session.id);
			expect(scannedSession).toBeTruthy();
			expect(scannedSession.sandboxed).toBe(true);
			expect(scannedSession.worktrees).toHaveLength(1);
			expect(scannedSession.worktrees[0]).toMatchObject({
				sessionId: seeded.session.id,
				path: "/workspace-wt/session/archived-sandbox",
				status: "skipped",
				willDeleteBranch: false,
			});
		} finally {
			if (seeded) seeded.ctx.sessionStore.remove(seeded.session.id);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	test("multi-repo archived sessions expose one worktree row per repoWorktrees entry", async ({ gateway }) => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-multirepo-"));
		const repoPath = join(baseDir, "repo");
		const packageRepoPath = join(repoPath, "packages", "api");
		const branch = `archived-multirepo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			mkdirSync(packageRepoPath, { recursive: true });
			initGitRepo(packageRepoPath);
			git(repoPath, ["branch", branch, "HEAD"]);
			git(packageRepoPath, ["branch", branch, "HEAD"]);
			seeded = await seedArchivedSession(gateway, {
				baseDir,
				title: "Archived multi-repo worktree",
				cwd: join(baseDir, "container"),
				repoPath,
				worktreePath: join(baseDir, "container"),
				repoWorktrees: {
					".": join(baseDir, "missing-root-worktree"),
					"packages/api": join(baseDir, "missing-api-worktree"),
				},
				branch,
			});

			const scan = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
			const scannedSession = findArchivedSession(scan, seeded.session.id);
			expect(scannedSession).toBeTruthy();
			expect(scannedSession.worktrees).toHaveLength(2);
			const byRepo = new Map(scannedSession.worktrees.map((item: any) => [item.repo, item]));
			expect(byRepo.get(".")).toMatchObject({
				repo: ".",
				repoPath,
				path: join(baseDir, "missing-root-worktree"),
				status: "already-cleaned",
				localBranchExists: true,
			});
			expect(byRepo.get("packages/api")).toMatchObject({
				repo: "packages/api",
				repoPath: packageRepoPath,
				path: join(baseDir, "missing-api-worktree"),
				status: "already-cleaned",
				localBranchExists: true,
			});
		} finally {
			if (seeded) seeded.ctx.sessionStore.remove(seeded.session.id);
			tryDeleteBranch(repoPath, branch);
			tryDeleteBranch(packageRepoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});

	test("scan skips archived worktree paths still referenced by a live session", async ({ gateway }) => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-guard-"));
		const repoPath = join(baseDir, "repo");
		const sharedWorktreePath = join(baseDir, "shared-worktree");
		let seeded: SeededSession | undefined;
		let liveSessionId: string | undefined;
		try {
			initGitRepo(repoPath);
			mkdirSync(sharedWorktreePath, { recursive: true });
			seeded = await seedArchivedSession(gateway, {
				baseDir,
				title: "Archived guarded worktree",
				cwd: sharedWorktreePath,
				repoPath,
				worktreePath: sharedWorktreePath,
				branch: "archived-guarded-branch",
			});
			liveSessionId = `live-guard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			seeded.ctx.sessionStore.put({
				id: liveSessionId,
				title: "Live session sharing archived worktree path",
				cwd: sharedWorktreePath,
				agentSessionFile: join(baseDir, `${liveSessionId}.jsonl`),
				createdAt: Date.now(),
				lastActivity: Date.now(),
				archived: false,
				projectId: seeded.projectId,
				repoPath,
				worktreePath: sharedWorktreePath,
				branch: "live-guard-branch",
			});

			const scan = await getArchivedWorktreeScan();
			const scannedSession = findArchivedSession(scan, seeded.session.id);
			expect(scannedSession).toBeTruthy();
			expect(scannedSession.worktrees).toHaveLength(1);
			expect(scannedSession.worktrees[0]).toMatchObject({
				sessionId: seeded.session.id,
				path: sharedWorktreePath,
				pathExists: true,
				status: "skipped",
				willDeleteBranch: false,
			});
		} finally {
			if (liveSessionId && seeded) seeded.ctx.sessionStore.remove(liveSessionId);
			if (seeded) seeded.ctx.sessionStore.remove(seeded.session.id);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Integration: create a session, terminate (archive) it, check expired-archives
// ---------------------------------------------------------------------------
test("expired archives stats reflect archived sessions", async () => {
	// Create and immediately terminate a session (which archives it)
	const sessionId = await createSession();
	await deleteSession(sessionId);

	// Get expired archive stats — newly archived session shouldn't be expired (< 7 days old)
	const statsResp = await apiFetch("/api/maintenance/expired-archives");
	expect(statsResp.status).toBe(200);
	const stats = await statsResp.json();
	// Fresh archive should NOT be expired — count should stay at 0 in clean test env
	expect(stats.count).toBe(0);
});
