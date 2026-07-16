import { describe, it } from "vitest";
import * as maintenance from "./maintenance-api-support.js";

const {
	test, expect, apiFetch, expectArchivedScanShape, expectArchivedCleanupShape,
	existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, tmpdir, dirname, join,
	git, branchExists, normalizeTestPath, listedWorktreePaths, initGitRepo,
	tryRemoveWorktree, tryDeleteBranches, tryDeleteBranch,
	seedArchivedSessions, seedArchivedSession, removeSeededSessions,
	findArchivedSession, findArchivedWorktreeItem, findArchivedWorktreeGroup,
	getArchivedWorktreeScan, gateway
} = maintenance;
type SeededSession = maintenance.SeededSession;
maintenance.registerMaintenanceHooks();

describe("archived session worktree maintenance", () => {
	it("stale archived paths do not inherit git metadata from another worktree on the same branch", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-branch-assoc-"));
		const repoPath = join(baseDir, "repo");
		const worktreeBasename = "same-basename-worktree";
		const activeWorktreePath = join(baseDir, "active", worktreeBasename);
		const missingWorktreePath = join(baseDir, "missing", worktreeBasename);
		const branch = `archived-branch-assoc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			mkdirSync(dirname(activeWorktreePath), { recursive: true });
			mkdirSync(dirname(missingWorktreePath), { recursive: true });
			git(repoPath, ["worktree", "add", "-b", branch, activeWorktreePath, "HEAD"]);
			expect(listedWorktreePaths(repoPath)).toContain(normalizeTestPath(activeWorktreePath));
			expect(existsSync(missingWorktreePath)).toBe(false);

			seeded = await seedArchivedSession(gateway(), {
				baseDir,
				title: "Archived stale path sharing another branch",
				cwd: missingWorktreePath,
				repoPath,
				worktreePath: missingWorktreePath,
				branch,
			});

			const diagnosticScan = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
			const diagnosticSession = findArchivedSession(diagnosticScan, seeded.session.id);
			expect(diagnosticSession).toBeTruthy();
			const item = diagnosticSession.worktrees[0];
			expect.soft(item).toMatchObject({
				status: "already-cleaned",
				pathExists: false,
				gitWorktreeMetadataExists: false,
				localBranchExists: true,
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
			expect(cleanupBody.counts.cleaned).toBe(0);
			expect(cleanupBody.counts.branchDeleted).toBe(0);
			expect(cleanupBody.counts.alreadyCleaned).toBe(1);
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: seeded.session.id,
				key: item.key,
				status: "already-cleaned",
				worktreeRemoved: false,
				branchDeleted: false,
			}));

			expect(existsSync(activeWorktreePath)).toBe(true);
			expect(listedWorktreePaths(repoPath)).toContain(normalizeTestPath(activeWorktreePath));
			expect(branchExists(repoPath, branch)).toBe(true);
			git(activeWorktreePath, ["status", "--short"]);
		} finally {
			if (seeded) removeSeededSessions([seeded]);
			tryRemoveWorktree(repoPath, activeWorktreePath);
			tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
	it("stale existing directories with colliding basenames are non-actionable", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-stale-dir-"));
		const repoPath = join(baseDir, "repo");
		const worktreeBasename = "same-basename-worktree";
		const activeWorktreePath = join(baseDir, "active", worktreeBasename);
		const staleWorktreePath = join(baseDir, "stale", worktreeBasename);
		const branch = `archived-stale-dir-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			mkdirSync(dirname(activeWorktreePath), { recursive: true });
			git(repoPath, ["worktree", "add", "-b", branch, activeWorktreePath, "HEAD"]);
			mkdirSync(staleWorktreePath, { recursive: true });
			expect(listedWorktreePaths(repoPath)).toContain(normalizeTestPath(activeWorktreePath));

			seeded = await seedArchivedSession(gateway(), {
				baseDir,
				title: "Archived stale existing path",
				cwd: staleWorktreePath,
				repoPath,
				worktreePath: staleWorktreePath,
				branch,
			});

			const scan = await getArchivedWorktreeScan();
			const scannedSession = findArchivedSession(scan, seeded.session.id);
			expect(scannedSession).toBeTruthy();
			const item = scannedSession.worktrees[0];
			expect(item).toMatchObject({
				status: "skipped",
				reason: "stale-worktree-directory",
				disposition: "needs-attention",
				reasonCategory: "stale-path",
				actionable: false,
				selectable: false,
				defaultSelected: false,
				pathExists: true,
				gitWorktreeMetadataExists: false,
				localBranchExists: true,
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
			expect(cleanupBody.counts).toMatchObject({ cleaned: 0, branchDeleted: 0, skipped: 1, notActionable: 1, failed: 0 });
			expect(cleanupBody.counts.byReason["stale-worktree-directory"]).toBe(1);
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: seeded.session.id,
				key: item.key,
				repo: ".",
				repoPath,
				path: staleWorktreePath,
				branch,
				status: "skipped",
				reason: "stale-worktree-directory",
				worktreeRemoved: false,
				branchDeleted: false,
			}));

			expect(existsSync(staleWorktreePath)).toBe(true);
			expect(existsSync(activeWorktreePath)).toBe(true);
			expect(listedWorktreePaths(repoPath)).toContain(normalizeTestPath(activeWorktreePath));
			expect(branchExists(repoPath, branch)).toBe(true);
			git(activeWorktreePath, ["status", "--short"]);
		} finally {
			if (seeded) removeSeededSessions([seeded]);
			tryRemoveWorktree(repoPath, activeWorktreePath);
			tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
	it("worktree key selectors must match the supplied session id", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-key-session-"));
		const repoPath = join(baseDir, "repo");
		const worktreePath = join(baseDir, "worktree");
		const branch = `archived-key-session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			git(repoPath, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
			seeded = await seedArchivedSession(gateway(), {
				baseDir,
				title: "Archived key/session mismatch candidate",
				cwd: worktreePath,
				repoPath,
				worktreePath,
				branch,
			});

			const scan = await getArchivedWorktreeScan();
			const scannedSession = findArchivedSession(scan, seeded.session.id);
			expect(scannedSession).toBeTruthy();
			const item = scannedSession.worktrees[0];
			expect(item.status).toBe("removable");

			const cleanup = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
				method: "POST",
				body: JSON.stringify({
					mode: "selected",
					worktrees: [{ sessionId: `${seeded.session.id}-wrong`, key: item.key, repo: item.repo, path: item.path }],
				}),
			});
			expect(cleanup.status).toBe(200);
			const cleanupBody = await cleanup.json();
			expectArchivedCleanupShape(cleanupBody);
			expect(cleanupBody.counts).toMatchObject({ requested: 1, cleaned: 0, branchDeleted: 0, skipped: 1, invalidSelection: 1, failed: 0 });
			expect(cleanupBody.counts.byReason["invalid-selection"]).toBe(1);
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				key: item.key,
				sessionId: `${seeded.session.id}-wrong`,
				status: "skipped",
				reason: "invalid-selection",
				worktreeRemoved: false,
				branchDeleted: false,
			}));
			expect(existsSync(worktreePath)).toBe(true);
			expect(listedWorktreePaths(repoPath)).toContain(normalizeTestPath(worktreePath));
			expect(branchExists(repoPath, branch)).toBe(true);
		} finally {
			if (seeded) removeSeededSessions([seeded]);
			tryRemoveWorktree(repoPath, worktreePath);
			tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
