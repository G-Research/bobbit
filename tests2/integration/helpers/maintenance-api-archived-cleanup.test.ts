import { describe, it } from "vitest";
import * as maintenance from "./maintenance-api-support.js";

const {
	test, expect, apiFetch, expectArchivedCleanupShape,
	existsSync, mkdtempSync, rmSync, tmpdir, join,
	git, branchExists, initGitRepo,
	tryRemoveWorktree, tryDeleteBranch,
	seedArchivedSessions, seedArchivedSession, removeSeededSessions,
	findArchivedSession, findArchivedWorktreeItem, findArchivedWorktreeGroup,
	getArchivedWorktreeScan, gateway
} = maintenance;
type SeededSession = maintenance.SeededSession;
maintenance.registerMaintenanceHooks();

describe("archived session worktree maintenance", () => {
	it("scan and selected cleanup remove archived worktree while preserving archived session visibility", async () => {
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

			seeded = await seedArchivedSession(gateway(), {
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
			expect(candidate).toMatchObject({
				status: "removable",
				reason: "safe-archived-session-worktree",
				disposition: "ready-to-clean",
				reasonCategory: "safe",
				actionable: true,
				selectable: true,
				defaultSelected: true,
				title: "Archived cleanup candidate",
				repo: ".",
				repoPath,
				repoDisplayName: expect.any(String),
				path: worktreePath,
				branch,
				source: "sessionWorktree",
				pathExists: true,
				gitWorktreeMetadataExists: true,
				localBranchExists: true,
				willDeleteBranch: true,
			});
			expect(candidate.selectionCategories).toEqual(expect.arrayContaining(["archived-session", "single-repo"]));

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
			expect(cleanupBody.counts).toMatchObject({
				requested: 1,
				cleaned: 1,
				branchDeleted: 1,
				worktreeRemoved: 1,
				invalidSelection: 0,
				notActionable: 0,
				failed: 0,
			});
			expect(cleanupBody.counts.byStatus.cleaned).toBe(1);
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: seeded.session.id,
				key: candidate.key,
				title: "Archived cleanup candidate",
				repo: ".",
				repoPath,
				path: worktreePath,
				branch,
				status: "cleaned",
				reason: "worktree-and-branch-cleaned",
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
			});
			const persistedSession = seeded.ctx.sessionStore.get(seeded.session.id);
			expect(persistedSession).toMatchObject({
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
			if (seeded) removeSeededSessions([seeded]);
			tryRemoveWorktree(repoPath, worktreePath);
			tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
	it("already-cleaned archived worktrees are hidden by default and stale selected cleanup is non-destructive", async () => {
		test.slow();
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-stale-"));
		const repoPath = join(baseDir, "repo");
		const missingWorktreePath = join(baseDir, "missing-worktree");
		const branch = `archived-stale-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		let seeded: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			git(repoPath, ["branch", branch, "HEAD"]);
			seeded = await seedArchivedSession(gateway(), {
				baseDir,
				title: "Archived already cleaned candidate",
				cwd: missingWorktreePath,
				repoPath,
				worktreePath: missingWorktreePath,
				branch,
			});

			const defaultScan = await getArchivedWorktreeScan();
			expect(findArchivedSession(defaultScan, seeded.session.id)).toBeUndefined();
			expect(findArchivedWorktreeItem(defaultScan, seeded.session.id)).toBeUndefined();
			expect(defaultScan.counts.alreadyCleaned).toBeGreaterThanOrEqual(1);
			const defaultAlreadyGroup = findArchivedWorktreeGroup(defaultScan, "already-cleaned");
			expect(defaultAlreadyGroup).toBeTruthy();
			expect(defaultAlreadyGroup.sampleItems).toContainEqual(expect.objectContaining({
				sessionId: seeded.session.id,
				status: "already-cleaned",
				reason: "already-cleaned",
			}));

			const diagnosticScan = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
			const diagnosticSession = findArchivedSession(diagnosticScan, seeded.session.id);
			expect(diagnosticSession).toBeTruthy();
			expect(diagnosticSession.worktrees).toHaveLength(1);
			const item = diagnosticSession.worktrees[0];
			expect(item).toMatchObject({
				status: "already-cleaned",
				reason: "already-cleaned",
				disposition: "already-cleaned",
				reasonCategory: "already-cleaned",
				actionable: false,
				selectable: false,
				defaultSelected: false,
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
			expect(cleanupBody.counts).toMatchObject({
				requested: 1,
				cleaned: 0,
				branchDeleted: 0,
				worktreeRemoved: 0,
				invalidSelection: 0,
				notActionable: 0,
				failed: 0,
				alreadyCleaned: 1,
			});
			expect(cleanupBody.counts.byStatus["already-cleaned"]).toBe(1);
			expect(cleanupBody.counts.byReason["already-cleaned"]).toBe(1);
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: seeded.session.id,
				key: item.key,
				repo: ".",
				repoPath,
				path: missingWorktreePath,
				branch,
				status: "already-cleaned",
				reason: "already-cleaned",
				worktreeRemoved: false,
				branchDeleted: false,
			}));
			expect(branchExists(repoPath, branch)).toBe(true);
		} finally {
			if (seeded) removeSeededSessions([seeded]);
			tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
	it("branch deletion is blocked when another archived record in the same repo references the branch", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-archived-branch-guard-"));
		const repoPath = join(baseDir, "repo");
		const removablePath = join(baseDir, "removable-worktree");
		const alreadyCleanedPath = join(baseDir, "already-cleaned-worktree");
		const branch = `archived-branch-guard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		let removable: SeededSession | undefined;
		let archivedReference: SeededSession | undefined;
		try {
			initGitRepo(repoPath);
			git(repoPath, ["worktree", "add", "-b", branch, removablePath, "HEAD"]);
			[removable, archivedReference] = seedArchivedSessions(gateway(), [
				{
					baseDir,
					title: "Archived removable with shared branch",
					cwd: removablePath,
					repoPath,
					worktreePath: removablePath,
					branch,
				},
				{
					baseDir,
					title: "Archived already cleaned branch reference",
					cwd: alreadyCleanedPath,
					repoPath,
					worktreePath: alreadyCleanedPath,
					branch,
				},
			]);

			const before = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
			const candidate = findArchivedWorktreeItem(before, removable.session.id);
			expect(candidate).toMatchObject({
				status: "removable",
				localBranchExists: true,
				willDeleteBranch: false,
				branchDeleteBlockedReason: "branch-referenced-by-archived-record",
			});
			expect(findArchivedWorktreeItem(before, archivedReference.session.id)).toMatchObject({ status: "already-cleaned", branch });

			const cleanup = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
				method: "POST",
				body: JSON.stringify({ mode: "all" }),
			});
			expect(cleanup.status).toBe(200);
			const cleanupBody = await cleanup.json();
			expectArchivedCleanupShape(cleanupBody);
			expect(cleanupBody.results).toContainEqual(expect.objectContaining({
				sessionId: removable.session.id,
				status: "cleaned",
				worktreeRemoved: true,
				branchDeleted: false,
			}));
			expect(branchExists(repoPath, branch)).toBe(true);
		} finally {
			removeSeededSessions([removable, archivedReference].filter((seed): seed is SeededSession => !!seed));
			tryRemoveWorktree(repoPath, removablePath);
			tryDeleteBranch(repoPath, branch);
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
});
