import { describe, it } from "vitest";
import * as maintenance from "./maintenance-api-support.js";
import type { MaintenanceGitSnapshot } from "./maintenance-git-model.js";

const {
	test, expect, apiFetch, expectArchivedScanShape, expectArchivedCleanupShape,
	mkdirSync, mkdtempSync, rmSync, tmpdir, join,
	seedArchivedSessions, removeSeededSessions,
	findArchivedWorktreeItem, findArchivedWorktreeGroup,
	getArchivedWorktreeScan, gateway
} = maintenance;
const maintenanceOwner = maintenance.createMaintenanceApiFixture("archived-scan");
const { git, initGitRepo, tryRemoveWorktree, tryDeleteBranches, maintenanceGit } = maintenanceOwner;
type SeededSession = maintenance.SeededSession;
maintenanceOwner.registerMaintenanceHooks();

describe("archived session worktree maintenance", () => {
	it("GET /api/maintenance/archived-session-worktrees returns sessions, flattened items, groups, presets, and additive counts", async () => {
		const body = await getArchivedWorktreeScan();
		expectArchivedScanShape(body);
	});
	it("scan exposes UX dispositions, reason categories, groups, and selection presets", async () => {
		test.slow();
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-v2-scan-"));
		const repoPath = join(baseDir, "repo");
		const removablePath = join(baseDir, "removable-worktree");
		const liveReferencedPath = join(baseDir, "live-referenced-worktree");
		const stalePath = join(baseDir, "stale-directory");
		const missingPath = join(baseDir, "already-cleaned-worktree");
		const removableBranch = `archived-v2-removable-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const liveBranch = `archived-v2-live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const staleBranch = `archived-v2-stale-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const missingBranch = `archived-v2-missing-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const seeded: SeededSession[] = [];
		let liveSessionId: string | undefined;
		let pristineGit: MaintenanceGitSnapshot | undefined;
		try {
			initGitRepo(repoPath);
			git(repoPath, ["worktree", "add", "-b", removableBranch, removablePath, "HEAD"]);
			git(repoPath, ["worktree", "add", "-b", liveBranch, liveReferencedPath, "HEAD"]);
			git(repoPath, ["branch", staleBranch, "HEAD"]);
			git(repoPath, ["branch", missingBranch, "HEAD"]);
			mkdirSync(stalePath, { recursive: true });
			pristineGit = maintenanceGit.snapshot();

			const [removable, noPath, missingRepo, sandbox, delegate, alreadyCleaned, stale, liveReferenced] = seedArchivedSessions(gateway(), [
				{ baseDir, title: "V2 removable archived worktree", cwd: removablePath, repoPath, worktreePath: removablePath, branch: removableBranch },
				{ baseDir, title: "V2 missing worktree path", cwd: join(baseDir, "no-path"), repoPath, worktreePath: undefined },
				{ baseDir, title: "V2 missing repo path", cwd: join(baseDir, "missing-repo"), repoPath: undefined, worktreePath: join(baseDir, "missing-repo") },
				{ baseDir, title: "V2 sandbox path", cwd: "/workspace-wt/session/v2-sandbox", repoPath, worktreePath: "/workspace-wt/session/v2-sandbox", branch: "v2-sandbox", sandboxed: true },
				{ baseDir, title: "V2 delegate shared worktree", cwd: join(baseDir, "delegate"), repoPath, worktreePath: join(baseDir, "delegate"), branch: undefined, delegateOf: "parent-session-id" },
				{ baseDir, title: "V2 already cleaned", cwd: missingPath, repoPath, worktreePath: missingPath, branch: missingBranch },
				{ baseDir, title: "V2 stale path", cwd: stalePath, repoPath, worktreePath: stalePath, branch: staleBranch },
				{ baseDir, title: "V2 live referenced", cwd: liveReferencedPath, repoPath, worktreePath: liveReferencedPath, branch: liveBranch },
			]);
			seeded.push(removable, noPath, missingRepo, sandbox, delegate, alreadyCleaned, stale, liveReferenced);
			liveSessionId = `live-v2-guard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			removable.ctx.sessionStore.put({
				id: liveSessionId,
				title: "Live session sharing archived worktree path",
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

			const scan = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
			const cases: Array<[SeededSession, string, string, string, string, boolean]> = [
				[removable, "removable", "safe-archived-session-worktree", "ready-to-clean", "safe", true],
				[noPath, "skipped", "no-worktree-path", "ineligible", "missing-metadata", false],
				[missingRepo, "skipped", "missing-repo-path", "ineligible", "missing-metadata", false],
				[sandbox, "skipped", "sandbox-container-path", "ineligible", "container-path", false],
				[delegate, "skipped", "delegate-shared-worktree", "ineligible", "shared-delegate", false],
				[alreadyCleaned, "already-cleaned", "already-cleaned", "already-cleaned", "already-cleaned", false],
				[stale, "skipped", "stale-worktree-directory", "needs-attention", "stale-path", false],
				[liveReferenced, "skipped", "referenced-by-live-session", "ineligible", "referenced-record", false],
			];
			for (const [seed, status, reason, disposition, reasonCategory, actionable] of cases) {
				const item = findArchivedWorktreeItem(scan, seed.session.id);
				expect(item, seed.session.title).toBeTruthy();
				expect(item).toMatchObject({ status, reason, disposition, reasonCategory, actionable, selectable: actionable, defaultSelected: actionable });
				expect(scan.counts.byReason[reason]).toBeGreaterThanOrEqual(1);
				expect(scan.counts.byDisposition[disposition]).toBeGreaterThanOrEqual(1);
				const groupKey = disposition === "ready-to-clean" ? "ready-to-clean" : disposition === "already-cleaned" ? "already-cleaned" : `reason:${reason}`;
				const group = findArchivedWorktreeGroup(scan, groupKey);
				expect(group, groupKey).toBeTruthy();
				expect(group.count).toBeGreaterThanOrEqual(1);
			}

			const removableItem = findArchivedWorktreeItem(scan, removable.session.id);
			expect(removableItem.selectionCategories).toEqual(expect.arrayContaining(["archived-session", "single-repo"]));
			expect(scan.counts.readyToClean).toBeGreaterThanOrEqual(1);
			expect(scan.counts.defaultSelected).toBe(scan.counts.readyToClean);
			expect(scan.counts.alreadyCleaned).toBeGreaterThanOrEqual(1);
			expect(scan.counts.needsAttention).toBeGreaterThanOrEqual(1);
			expect(scan.counts.bySelectionCategory["archived-session"]).toBeGreaterThanOrEqual(1);
			const allPreset = scan.selectionPresets.find((preset: any) => preset.id === "all-removable");
			expect(allPreset).toMatchObject({ enabled: true, count: scan.counts.readyToClean, cleanupRequest: { mode: "all" } });
			expect(allPreset.worktreeKeys).toContain(removableItem.key);
			const archivedPreset = scan.selectionPresets.find((preset: any) => preset.id === "category:archived-session");
			expect(archivedPreset).toBeTruthy();
			expect(archivedPreset.worktreeKeys).toContain(removableItem.key);
			expect(archivedPreset.worktreeKeys).not.toContain(findArchivedWorktreeItem(scan, stale.session.id).key);

			const defaultScan = await getArchivedWorktreeScan();
			expect(findArchivedWorktreeItem(defaultScan, alreadyCleaned.session.id)).toBeUndefined();
			expect(defaultScan.counts.alreadyCleaned).toBeGreaterThanOrEqual(1);
		} finally {
			removeSeededSessions(seeded, [liveSessionId]);
			if (pristineGit) {
				// Restore only this file's registered model before releasing its lease.
				maintenanceGit.restore(pristineGit);
				tryRemoveWorktree(repoPath, removablePath);
				tryRemoveWorktree(repoPath, liveReferencedPath);
				tryDeleteBranches(repoPath, [removableBranch, liveBranch, staleBranch, missingBranch]);
				maintenanceGit.forgetRepo(repoPath);
			}
			rmSync(baseDir, { recursive: true, force: true });
		}
	});
	it("POST /api/maintenance/cleanup-archived-session-worktrees validates request shape", async () => {
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

		const allWithProjectSelector = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
			method: "POST",
			body: JSON.stringify({ mode: "all", projectId: "project-a" }),
		});
		expect(allWithProjectSelector.status).toBe(400);

		const allWithRepoSelector = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
			method: "POST",
			body: JSON.stringify({ mode: "all", repoPath: "/tmp/repo-a" }),
		});
		expect(allWithRepoSelector.status).toBe(400);

		const allMode = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
			method: "POST",
			body: JSON.stringify({ mode: "all" }),
		});
		expect(allMode.status).toBe(200);
		expectArchivedCleanupShape(await allMode.json());
	});
});
