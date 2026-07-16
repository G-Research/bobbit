import { describe, it } from "vitest";
import * as maintenance from "./maintenance-api-support.js";

const {
	test, expect, apiFetch, expectArchivedCleanupShape,
	existsSync, mkdirSync, mkdtempSync, rmSync, tmpdir, join,
	git, branchExists, normalizeTestPath, listedWorktreePaths, initGitRepo,
	tryRemoveWorktree, tryDeleteBranches, tryDeleteBranch,
	seedArchivedSessions, seedArchivedSession, removeSeededSessions,
	findArchivedSession, findArchivedWorktreeItem,
	getArchivedWorktreeScan, gateway
} = maintenance;
type SeededSession = maintenance.SeededSession;
maintenance.registerMaintenanceHooks();

describe("archived session worktree maintenance", () => {
	it("mode all cleans only safe candidates and leaves ineligible archived records untouched", async () => {
		test.slow();
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-all-guard-"));
		const repoPath = join(baseDir, "repo");
		const removablePath = join(baseDir, "all-removable-worktree");
		const liveReferencedPath = join(baseDir, "all-live-referenced-worktree");
		const stalePath = join(baseDir, "all-stale-directory");
		const alreadyCleanedPath = join(baseDir, "all-already-cleaned");
		const removableBranch = `archived-all-removable-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const liveBranch = `archived-all-live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const staleBranch = `archived-all-stale-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const alreadyBranch = `archived-all-already-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const seeded: SeededSession[] = [];
		let liveSessionId: string | undefined;
		try {
			initGitRepo(repoPath);
			git(repoPath, ["worktree", "add", "-b", removableBranch, removablePath, "HEAD"]);
			git(repoPath, ["worktree", "add", "-b", liveBranch, liveReferencedPath, "HEAD"]);
			git(repoPath, ["branch", staleBranch, "HEAD"]);
			git(repoPath, ["branch", alreadyBranch, "HEAD"]);
			mkdirSync(stalePath, { recursive: true });

			const [removable, liveReferenced, sandbox, stale, alreadyCleaned] = seedArchivedSessions(gateway(), [
				{ baseDir, title: "All removable", cwd: removablePath, repoPath, worktreePath: removablePath, branch: removableBranch },
				{ baseDir, title: "All live referenced", cwd: liveReferencedPath, repoPath, worktreePath: liveReferencedPath, branch: liveBranch },
				{ baseDir, title: "All sandbox", cwd: "/workspace-wt/session/all-sandbox", repoPath, worktreePath: "/workspace-wt/session/all-sandbox", branch: "all-sandbox", sandboxed: true },
				{ baseDir, title: "All stale", cwd: stalePath, repoPath, worktreePath: stalePath, branch: staleBranch },
				{ baseDir, title: "All already cleaned", cwd: alreadyCleanedPath, repoPath, worktreePath: alreadyCleanedPath, branch: alreadyBranch },
			]);
			seeded.push(removable, liveReferenced, sandbox, stale, alreadyCleaned);
			liveSessionId = `live-all-guard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			removable.ctx.sessionStore.put({
				id: liveSessionId,
				title: "Live guard for clean all",
				cwd: liveReferencedPath,
				agentSessionFile: join(baseDir, `${liveSessionId}.jsonl`),
				createdAt: Date.now(),
				lastActivity: Date.now(),
				archived: false,
				projectId: removable.projectId,
				repoPath,
				worktreePath: liveReferencedPath,
				branch: liveBranch,
			});

			const before = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
			expect(findArchivedWorktreeItem(before, removable.session.id)).toMatchObject({ status: "removable", actionable: true });
			expect(findArchivedWorktreeItem(before, liveReferenced.session.id)).toMatchObject({ status: "skipped", reason: "referenced-by-live-session", actionable: false });
			expect(findArchivedWorktreeItem(before, sandbox.session.id)).toMatchObject({ status: "skipped", reason: "sandbox-container-path", actionable: false });
			expect(findArchivedWorktreeItem(before, stale.session.id)).toMatchObject({ status: "skipped", reason: "stale-worktree-directory", actionable: false });
			expect(findArchivedWorktreeItem(before, alreadyCleaned.session.id)).toMatchObject({ status: "already-cleaned", reason: "already-cleaned", actionable: false });
			const expectedCleaned = (before.items as any[]).filter((item) => item.status === "removable").length;
			const expectedBranchDeleted = (before.items as any[]).filter((item) => item.status === "removable" && item.willDeleteBranch).length;

			const cleanup = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
				method: "POST",
				body: JSON.stringify({ mode: "all" }),
			});
			expect(cleanup.status).toBe(200);
			const cleanupBody = await cleanup.json();
			expectArchivedCleanupShape(cleanupBody);
			expect(cleanupBody.counts).toMatchObject({ cleaned: expectedCleaned, branchDeleted: expectedBranchDeleted, worktreeRemoved: expectedCleaned, invalidSelection: 0, notActionable: 0, failed: 0 });
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: removable.session.id,
				status: "cleaned",
				path: removablePath,
				branch: removableBranch,
				worktreeRemoved: true,
				branchDeleted: true,
			}));
			expect(cleanupBody.results.some((result: any) => [liveReferenced.session.id, sandbox.session.id, stale.session.id, alreadyCleaned.session.id].includes(result.sessionId))).toBe(false);

			expect(existsSync(removablePath)).toBe(false);
			expect(branchExists(repoPath, removableBranch)).toBe(false);
			expect(existsSync(liveReferencedPath)).toBe(true);
			expect(listedWorktreePaths(repoPath)).toContain(normalizeTestPath(liveReferencedPath));
			expect(existsSync(stalePath)).toBe(true);
			expect(branchExists(repoPath, liveBranch)).toBe(true);
			expect(branchExists(repoPath, staleBranch)).toBe(true);
			expect(branchExists(repoPath, alreadyBranch)).toBe(true);

			const after = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
			expect(findArchivedWorktreeItem(after, removable.session.id)).toMatchObject({ status: "already-cleaned", reason: "already-cleaned" });
			expect(findArchivedWorktreeItem(after, liveReferenced.session.id)).toMatchObject({ status: "skipped", reason: "referenced-by-live-session" });
			expect(findArchivedWorktreeItem(after, sandbox.session.id)).toMatchObject({ status: "skipped", reason: "sandbox-container-path" });
			expect(findArchivedWorktreeItem(after, stale.session.id)).toMatchObject({ status: "skipped", reason: "stale-worktree-directory" });
		} finally {
			removeSeededSessions(seeded, [liveSessionId]);
			tryRemoveWorktree(repoPath, removablePath);
			tryRemoveWorktree(repoPath, liveReferencedPath);
			tryDeleteBranches(repoPath, [removableBranch, liveBranch, staleBranch, alreadyBranch]);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
	it("sandbox container paths are skipped instead of treated as host worktrees", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-sandbox-"));
		const repoPath = join(baseDir, "repo");
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			seeded = await seedArchivedSession(gateway(), {
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
			const item = scannedSession.worktrees[0];
			expect(item).toMatchObject({
				sessionId: seeded.session.id,
				path: "/workspace-wt/session/archived-sandbox",
				status: "skipped",
				reason: "sandbox-container-path",
				disposition: "ineligible",
				reasonCategory: "container-path",
				actionable: false,
				selectable: false,
				willDeleteBranch: false,
			});

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
			expect(cleanupBody.counts).toMatchObject({ cleaned: 0, skipped: 1, notActionable: 1, failed: 0 });
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: seeded.session.id,
				key: item.key,
				status: "skipped",
				reason: "sandbox-container-path",
				worktreeRemoved: false,
				branchDeleted: false,
			}));
		} finally {
			if (seeded) removeSeededSessions([seeded]);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
	it("multi-repo archived sessions expose one worktree row per repoWorktrees entry", async () => {
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
			seeded = await seedArchivedSession(gateway(), {
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
				title: "Archived multi-repo worktree",
				repo: ".",
				repoPath,
				repoDisplayName: expect.any(String),
				path: join(baseDir, "missing-root-worktree"),
				branch,
				source: "repoWorktrees",
				status: "already-cleaned",
				reason: "already-cleaned",
				disposition: "already-cleaned",
				reasonCategory: "already-cleaned",
				localBranchExists: true,
			});
			expect((byRepo.get(".") as any).selectionCategories).toEqual(expect.arrayContaining(["archived-session", "multi-repo"]));
			expect(byRepo.get("packages/api")).toMatchObject({
				title: "Archived multi-repo worktree",
				repo: "packages/api",
				repoPath: packageRepoPath,
				repoDisplayName: expect.any(String),
				path: join(baseDir, "missing-api-worktree"),
				branch,
				source: "repoWorktrees",
				status: "already-cleaned",
				reason: "already-cleaned",
				disposition: "already-cleaned",
				reasonCategory: "already-cleaned",
				localBranchExists: true,
			});
			expect((byRepo.get("packages/api") as any).selectionCategories).toEqual(expect.arrayContaining(["archived-session", "multi-repo"]));
		} finally {
			if (seeded) removeSeededSessions([seeded]);
			tryDeleteBranch(repoPath, branch);
			tryDeleteBranch(packageRepoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
	it("scan skips archived worktree paths still referenced by a live session", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-guard-"));
		const repoPath = join(baseDir, "repo");
		const sharedWorktreePath = join(baseDir, "shared-worktree");
		let seeded: SeededSession | undefined;
		let liveSessionId: string | undefined;
		try {
			initGitRepo(repoPath);
			mkdirSync(sharedWorktreePath, { recursive: true });
			seeded = await seedArchivedSession(gateway(), {
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
				reason: "referenced-by-live-session",
				disposition: "ineligible",
				reasonCategory: "referenced-record",
				actionable: false,
				selectable: false,
				willDeleteBranch: false,
			});
		} finally {
			removeSeededSessions(seeded ? [seeded] : [], [liveSessionId]);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
