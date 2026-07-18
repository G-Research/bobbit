import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import * as maintenance from "./maintenance-api-support.js";
import type { MaintenanceGitSnapshot } from "./maintenance-git-model.js";

const {
	expect, apiFetch, expectArchivedCleanupShape,
	existsSync, mkdirSync, mkdtempSync, rmSync, tmpdir, dirname, join,
	normalizeTestPath,
	seedArchivedSessions, restoreSeededSessions, removeSeededSessions,
	findArchivedSession,
	getArchivedWorktreeScan, gateway,
} = maintenance;
const maintenanceOwner = maintenance.createMaintenanceApiFixture("archived-guards");
const { git, branchExists, listedWorktreePaths, initGitRepo, maintenanceGit } = maintenanceOwner;
type SeededSession = maintenance.SeededSession;
maintenanceOwner.registerMaintenanceHooks();

type GuardScenario = {
	repoPath: string;
	activeWorktreePath: string;
	candidatePath: string;
	branch: string;
	seeds: SeededSession[];
};

describe("archived session worktree maintenance", () => {
	let baseDir: string;
	let branchAssociation: GuardScenario;
	let staleDirectory: GuardScenario;
	let keyMismatch: GuardScenario;
	let allSeeds: SeededSession[] = [];
	let pristineGit: MaintenanceGitSnapshot;

	beforeAll(() => {
		baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-wt-guards-shared-"));

		const associationRepo = join(baseDir, "branch-association-repo");
		const associationBasename = "same-basename-worktree";
		const associationActive = join(baseDir, "association-active", associationBasename);
		const associationMissing = join(baseDir, "association-missing", associationBasename);
		const associationBranch = `archived-branch-assoc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		initGitRepo(associationRepo);
		mkdirSync(dirname(associationActive), { recursive: true });
		mkdirSync(dirname(associationMissing), { recursive: true });
		git(associationRepo, ["worktree", "add", "-b", associationBranch, associationActive, "HEAD"]);
		const associationSeeds = seedArchivedSessions(gateway(), [{
			baseDir,
			title: "Archived stale path sharing another branch",
			cwd: associationMissing,
			repoPath: associationRepo,
			worktreePath: associationMissing,
			branch: associationBranch,
		}]);
		branchAssociation = {
			repoPath: associationRepo,
			activeWorktreePath: associationActive,
			candidatePath: associationMissing,
			branch: associationBranch,
			seeds: associationSeeds,
		};

		const staleRepo = join(baseDir, "stale-directory-repo");
		const staleBasename = "same-basename-worktree";
		const staleActive = join(baseDir, "stale-active", staleBasename);
		const stalePath = join(baseDir, "stale-candidate", staleBasename);
		const staleBranch = `archived-stale-dir-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		initGitRepo(staleRepo);
		mkdirSync(dirname(staleActive), { recursive: true });
		git(staleRepo, ["worktree", "add", "-b", staleBranch, staleActive, "HEAD"]);
		mkdirSync(stalePath, { recursive: true });
		const staleSeeds = seedArchivedSessions(gateway(), [{
			baseDir,
			title: "Archived stale existing path",
			cwd: stalePath,
			repoPath: staleRepo,
			worktreePath: stalePath,
			branch: staleBranch,
		}]);
		staleDirectory = {
			repoPath: staleRepo,
			activeWorktreePath: staleActive,
			candidatePath: stalePath,
			branch: staleBranch,
			seeds: staleSeeds,
		};

		const mismatchRepo = join(baseDir, "key-mismatch-repo");
		const mismatchWorktree = join(baseDir, "key-mismatch-worktree");
		const mismatchBranch = `archived-key-session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		initGitRepo(mismatchRepo);
		git(mismatchRepo, ["worktree", "add", "-b", mismatchBranch, mismatchWorktree, "HEAD"]);
		const mismatchSeeds = seedArchivedSessions(gateway(), [{
			baseDir,
			title: "Archived key/session mismatch candidate",
			cwd: mismatchWorktree,
			repoPath: mismatchRepo,
			worktreePath: mismatchWorktree,
			branch: mismatchBranch,
		}]);
		keyMismatch = {
			repoPath: mismatchRepo,
			activeWorktreePath: mismatchWorktree,
			candidatePath: mismatchWorktree,
			branch: mismatchBranch,
			seeds: mismatchSeeds,
		};

		allSeeds = [...branchAssociation.seeds, ...staleDirectory.seeds, ...keyMismatch.seeds];
		pristineGit = maintenanceGit.snapshot();
		removeSeededSessions(allSeeds);
	});

	afterEach(() => {
		removeSeededSessions(allSeeds);
	});

	afterAll(() => {
		removeSeededSessions(allSeeds);
		maintenanceGit.restore(pristineGit);
		for (const scenario of [branchAssociation, staleDirectory, keyMismatch]) maintenanceGit.forgetRepo(scenario.repoPath);
		rmSync(baseDir, { recursive: true, force: true });
	});

	function activate(scenario: GuardScenario): void {
		maintenanceGit.restore(pristineGit);
		removeSeededSessions(allSeeds);
		restoreSeededSessions(scenario.seeds);
	}

	it("stale archived paths do not inherit git metadata from another worktree on the same branch", async () => {
		activate(branchAssociation);
		const seeded = branchAssociation.seeds[0];
		const {
			repoPath,
			activeWorktreePath,
			candidatePath: missingWorktreePath,
			branch,
		} = branchAssociation;

		expect(listedWorktreePaths(repoPath)).toContain(normalizeTestPath(activeWorktreePath));
		expect(existsSync(missingWorktreePath)).toBe(false);

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
	});

	it("stale existing directories with colliding basenames are non-actionable", async () => {
		activate(staleDirectory);
		const seeded = staleDirectory.seeds[0];
		const {
			repoPath,
			activeWorktreePath,
			candidatePath: staleWorktreePath,
			branch,
		} = staleDirectory;

		expect(listedWorktreePaths(repoPath)).toContain(normalizeTestPath(activeWorktreePath));

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
	});

	it("worktree key selectors must match the supplied session id", async () => {
		activate(keyMismatch);
		const seeded = keyMismatch.seeds[0];
		const { repoPath, activeWorktreePath: worktreePath, branch } = keyMismatch;

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
	});
});
