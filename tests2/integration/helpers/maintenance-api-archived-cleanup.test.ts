import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import * as maintenance from "./maintenance-api-support.js";
import type { MaintenanceGitSnapshot } from "./maintenance-git-model.js";

const {
	test, expect, apiFetch, expectArchivedCleanupShape,
	existsSync, mkdtempSync, rmSync, tmpdir, join,
	seedArchivedSessions, removeSeededSessions, restoreSeededSessions,
	findArchivedSession, findArchivedWorktreeItem, findArchivedWorktreeGroup,
	getArchivedWorktreeScan, gateway,
} = maintenance;
const maintenanceOwner = maintenance.createMaintenanceApiFixture("archived-cleanup");
const { git, branchExists, initGitRepo, maintenanceGit } = maintenanceOwner;
type SeededSession = maintenance.SeededSession;
maintenanceOwner.registerMaintenanceHooks();

type CleanupScenario = {
	repoPath: string;
	worktreePath: string;
	branch: string;
	seeds: SeededSession[];
};

describe("archived session worktree maintenance", () => {
	let baseDir: string;
	let removable: CleanupScenario;
	let alreadyCleaned: CleanupScenario;
	let sharedBranch: CleanupScenario;
	let allSeeds: SeededSession[] = [];
	let pristineGit: MaintenanceGitSnapshot;

	beforeAll(() => {
		baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-cleanup-shared-"));

		const removableRepo = join(baseDir, "removable-repo");
		const removablePath = join(baseDir, "removable-worktree");
		const removableBranch = `archived-cleanup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		initGitRepo(removableRepo);
		git(removableRepo, ["worktree", "add", "-b", removableBranch, removablePath, "HEAD"]);
		const removableSeed = seedArchivedSessions(gateway(), [{
			baseDir,
			title: "Archived cleanup candidate",
			cwd: removablePath,
			repoPath: removableRepo,
			worktreePath: removablePath,
			branch: removableBranch,
		}]);
		removable = { repoPath: removableRepo, worktreePath: removablePath, branch: removableBranch, seeds: removableSeed };

		const cleanedRepo = join(baseDir, "already-cleaned-repo");
		const missingPath = join(baseDir, "missing-worktree");
		const cleanedBranch = `archived-stale-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		initGitRepo(cleanedRepo);
		git(cleanedRepo, ["branch", cleanedBranch, "HEAD"]);
		const cleanedSeed = seedArchivedSessions(gateway(), [{
			baseDir,
			title: "Archived already cleaned candidate",
			cwd: missingPath,
			repoPath: cleanedRepo,
			worktreePath: missingPath,
			branch: cleanedBranch,
		}]);
		alreadyCleaned = { repoPath: cleanedRepo, worktreePath: missingPath, branch: cleanedBranch, seeds: cleanedSeed };

		const sharedRepo = join(baseDir, "shared-branch-repo");
		const sharedRemovablePath = join(baseDir, "shared-removable-worktree");
		const sharedMissingPath = join(baseDir, "shared-already-cleaned-worktree");
		const sharedBranchName = `archived-branch-guard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		initGitRepo(sharedRepo);
		git(sharedRepo, ["worktree", "add", "-b", sharedBranchName, sharedRemovablePath, "HEAD"]);
		const sharedSeeds = seedArchivedSessions(gateway(), [
			{
				baseDir,
				title: "Archived removable with shared branch",
				cwd: sharedRemovablePath,
				repoPath: sharedRepo,
				worktreePath: sharedRemovablePath,
				branch: sharedBranchName,
			},
			{
				baseDir,
				title: "Archived already cleaned branch reference",
				cwd: sharedMissingPath,
				repoPath: sharedRepo,
				worktreePath: sharedMissingPath,
				branch: sharedBranchName,
			},
		]);
		sharedBranch = { repoPath: sharedRepo, worktreePath: sharedRemovablePath, branch: sharedBranchName, seeds: sharedSeeds };

		allSeeds = [...removable.seeds, ...alreadyCleaned.seeds, ...sharedBranch.seeds];
		pristineGit = maintenanceGit.snapshot();
		removeSeededSessions(allSeeds);
	});

	afterEach(() => {
		removeSeededSessions(allSeeds);
	});

	afterAll(() => {
		removeSeededSessions(allSeeds);
		maintenanceGit.restore(pristineGit);
		for (const scenario of [removable, alreadyCleaned, sharedBranch]) maintenanceGit.forgetRepo(scenario.repoPath);
		rmSync(baseDir, { recursive: true, force: true });
	});

	function activate(scenario: CleanupScenario): void {
		maintenanceGit.restore(pristineGit);
		removeSeededSessions(allSeeds);
		restoreSeededSessions(scenario.seeds);
	}

	it("scan and selected cleanup remove archived worktree while preserving archived session visibility", async () => {
		test.slow();
		activate(removable);
		const seeded = removable.seeds[0];
		const { repoPath, worktreePath, branch } = removable;

		expect(existsSync(worktreePath)).toBe(true);
		expect(branchExists(repoPath, branch)).toBe(true);

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
	});

	it("already-cleaned archived worktrees are hidden by default and stale selected cleanup is non-destructive", async () => {
		test.slow();
		activate(alreadyCleaned);
		const seeded = alreadyCleaned.seeds[0];
		const { repoPath, worktreePath: missingWorktreePath, branch } = alreadyCleaned;

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
	});

	it("branch deletion is blocked when another archived record in the same repo references the branch", async () => {
		activate(sharedBranch);
		const [removableSeed, archivedReference] = sharedBranch.seeds;
		const { repoPath, worktreePath: removablePath, branch } = sharedBranch;

		const before = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
		const candidate = findArchivedWorktreeItem(before, removableSeed.session.id);
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
			sessionId: removableSeed.session.id,
			status: "cleaned",
			worktreeRemoved: true,
			branchDeleted: false,
		}));
		expect(branchExists(repoPath, branch)).toBe(true);
		expect(existsSync(removablePath)).toBe(false);
	});
});
