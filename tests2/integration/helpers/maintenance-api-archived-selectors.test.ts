import { describe, it } from "vitest";
import * as maintenance from "./maintenance-api-support.js";

const {
	test, expect, apiFetch, expectArchivedCleanupShape,
	existsSync, mkdirSync, mkdtempSync, rmSync, tmpdir, join,
	git, branchExists, normalizeTestPath, listedWorktreePaths, initGitRepo,
	tryRemoveWorktree, tryDeleteBranches,
	seedArchivedSessions, removeSeededSessions,
	findArchivedSession, findArchivedWorktreeItem,
	getArchivedWorktreeScan, gateway, maintenanceGit,
} = maintenance;
type SeededSession = maintenance.SeededSession;
maintenance.registerMaintenanceHooks();

let baseDir: string;
let repoPath: string;
let packageRepoPath: string;
let removablePath: string;
let liveReferencedPath: string;
let stalePath: string;
let alreadyCleanedPath: string;
let sharedWorktreePath: string;
let removableBranch: string;
let liveBranch: string;
let staleBranch: string;
let alreadyBranch: string;
let multiBranch: string;
let seeded: SeededSession[] = [];
let liveSessionIds: string[] = [];
let removable: SeededSession;
let liveReferenced: SeededSession;
let sandbox: SeededSession;
let stale: SeededSession;
let alreadyCleaned: SeededSession;
let multiRepo: SeededSession;
let guarded: SeededSession;
let scanSnapshot: any;
let cleanupAllSnapshot: any;
let cleanupSandboxSnapshot: any;

test.beforeAll(async () => {
	// Build one command-visible model and one filesystem tree. Every declaration
	// below reads immutable response snapshots from this single authored state.
	baseDir = mkdtempSync(join(tmpdir(), "bobbit-e2e-archived-selectors-shared-"));
	repoPath = join(baseDir, "repo");
	packageRepoPath = join(repoPath, "packages", "api");
	removablePath = join(baseDir, "all-removable-worktree");
	liveReferencedPath = join(baseDir, "all-live-referenced-worktree");
	stalePath = join(baseDir, "all-stale-directory");
	alreadyCleanedPath = join(baseDir, "all-already-cleaned");
	sharedWorktreePath = join(baseDir, "shared-worktree");
	const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	removableBranch = `archived-all-removable-${stamp}`;
	liveBranch = `archived-all-live-${stamp}`;
	staleBranch = `archived-all-stale-${stamp}`;
	alreadyBranch = `archived-all-already-${stamp}`;
	multiBranch = `archived-multirepo-${stamp}`;

	initGitRepo(repoPath);
	mkdirSync(packageRepoPath, { recursive: true });
	initGitRepo(packageRepoPath);
	git(repoPath, ["worktree", "add", "-b", removableBranch, removablePath, "HEAD"]);
	git(repoPath, ["worktree", "add", "-b", liveBranch, liveReferencedPath, "HEAD"]);
	for (const branch of [staleBranch, alreadyBranch, multiBranch]) git(repoPath, ["branch", branch, "HEAD"]);
	git(packageRepoPath, ["branch", multiBranch, "HEAD"]);
	mkdirSync(stalePath, { recursive: true });
	mkdirSync(sharedWorktreePath, { recursive: true });

	[removable, liveReferenced, sandbox, stale, alreadyCleaned, multiRepo, guarded] = seedArchivedSessions(gateway(), [
		{ baseDir, title: "All removable", cwd: removablePath, repoPath, worktreePath: removablePath, branch: removableBranch },
		{ baseDir, title: "All live referenced", cwd: liveReferencedPath, repoPath, worktreePath: liveReferencedPath, branch: liveBranch },
		{ baseDir, title: "All sandbox", cwd: "/workspace-wt/session/all-sandbox", repoPath, worktreePath: "/workspace-wt/session/all-sandbox", branch: "all-sandbox", sandboxed: true },
		{ baseDir, title: "All stale", cwd: stalePath, repoPath, worktreePath: stalePath, branch: staleBranch },
		{ baseDir, title: "All already cleaned", cwd: alreadyCleanedPath, repoPath, worktreePath: alreadyCleanedPath, branch: alreadyBranch },
		{
			baseDir,
			title: "Archived multi-repo worktree",
			cwd: join(baseDir, "container"),
			repoPath,
			worktreePath: join(baseDir, "container"),
			repoWorktrees: {
				".": join(baseDir, "missing-root-worktree"),
				"packages/api": join(baseDir, "missing-api-worktree"),
			},
			branch: multiBranch,
		},
		{
			baseDir,
			title: "Archived guarded worktree",
			cwd: sharedWorktreePath,
			repoPath,
			worktreePath: sharedWorktreePath,
			branch: "archived-guarded-branch",
		},
	]);
	seeded = [removable, liveReferenced, sandbox, stale, alreadyCleaned, multiRepo, guarded];

	const liveRefId = `live-all-guard-${stamp}`;
	const guardedId = `live-guard-${stamp}`;
	liveSessionIds = [liveRefId, guardedId];
	for (const [id, cwd, branch] of [
		[liveRefId, liveReferencedPath, liveBranch],
		[guardedId, sharedWorktreePath, "live-guard-branch"],
	] as const) {
		removable.ctx.sessionStore.put({
			id,
			title: `Live guard ${id}`,
			cwd,
			agentSessionFile: join(baseDir, `${id}.jsonl`),
			createdAt: Date.now(),
			lastActivity: Date.now(),
			archived: false,
			projectId: removable.projectId,
			repoPath,
			worktreePath: cwd,
			branch,
		});
	}

	scanSnapshot = await getArchivedWorktreeScan("?includeAlreadyCleaned=1");
	const cleanupAll = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
		method: "POST",
		body: JSON.stringify({ mode: "all" }),
	});
	expect(cleanupAll.status).toBe(200);
	cleanupAllSnapshot = await cleanupAll.json();

	const sandboxItem = findArchivedWorktreeItem(scanSnapshot, sandbox.session.id);
	const cleanupSandbox = await apiFetch("/api/maintenance/cleanup-archived-session-worktrees", {
		method: "POST",
		body: JSON.stringify({
			mode: "selected",
			worktrees: [{ sessionId: sandbox.session.id, key: sandboxItem.key }],
		}),
	});
	expect(cleanupSandbox.status).toBe(200);
	cleanupSandboxSnapshot = await cleanupSandbox.json();
});

test.afterAll(() => {
	removeSeededSessions(seeded, liveSessionIds);
	tryRemoveWorktree(repoPath, removablePath);
	tryRemoveWorktree(repoPath, liveReferencedPath);
	tryDeleteBranches(repoPath, [removableBranch, liveBranch, staleBranch, alreadyBranch, multiBranch]);
	tryDeleteBranches(packageRepoPath, [multiBranch]);
	maintenanceGit.forgetRepo(packageRepoPath);
	maintenanceGit.forgetRepo(repoPath);
	if (baseDir) rmSync(baseDir, { recursive: true, force: true });
});

describe("archived session worktree maintenance", () => {
	it("mode all cleans only safe candidates and leaves ineligible archived records untouched", () => {
		expect(findArchivedWorktreeItem(scanSnapshot, removable.session.id)).toMatchObject({ status: "removable", actionable: true });
		expect(findArchivedWorktreeItem(scanSnapshot, liveReferenced.session.id)).toMatchObject({ status: "skipped", reason: "referenced-by-live-session", actionable: false });
		expect(findArchivedWorktreeItem(scanSnapshot, sandbox.session.id)).toMatchObject({ status: "skipped", reason: "sandbox-container-path", actionable: false });
		expect(findArchivedWorktreeItem(scanSnapshot, stale.session.id)).toMatchObject({ status: "skipped", reason: "stale-worktree-directory", actionable: false });
		expect(findArchivedWorktreeItem(scanSnapshot, alreadyCleaned.session.id)).toMatchObject({ status: "already-cleaned", reason: "already-cleaned", actionable: false });

		expectArchivedCleanupShape(cleanupAllSnapshot);
		expect(cleanupAllSnapshot.counts).toMatchObject({ cleaned: 1, branchDeleted: 1, worktreeRemoved: 1, invalidSelection: 0, notActionable: 0, failed: 0 });
		expect(cleanupAllSnapshot.results).toContainEqual(expect.objectContaining({
			sessionId: removable.session.id,
			status: "cleaned",
			path: removablePath,
			branch: removableBranch,
			worktreeRemoved: true,
			branchDeleted: true,
		}));
		expect(cleanupAllSnapshot.results.some((result: any) => [liveReferenced.session.id, sandbox.session.id, stale.session.id, alreadyCleaned.session.id].includes(result.sessionId))).toBe(false);
		expect(existsSync(removablePath)).toBe(false);
		expect(branchExists(repoPath, removableBranch)).toBe(false);
		expect(existsSync(liveReferencedPath)).toBe(true);
		expect(listedWorktreePaths(repoPath)).toContain(normalizeTestPath(liveReferencedPath));
		expect(existsSync(stalePath)).toBe(true);
		expect(branchExists(repoPath, liveBranch)).toBe(true);
		expect(branchExists(repoPath, staleBranch)).toBe(true);
		expect(branchExists(repoPath, alreadyBranch)).toBe(true);
	});

	it("sandbox container paths are skipped instead of treated as host worktrees", () => {
		const scannedSession = findArchivedSession(scanSnapshot, sandbox.session.id);
		expect(scannedSession).toBeTruthy();
		expect(scannedSession.sandboxed).toBe(true);
		expect(scannedSession.worktrees).toHaveLength(1);
		const item = scannedSession.worktrees[0];
		expect(item).toMatchObject({
			sessionId: sandbox.session.id,
			path: "/workspace-wt/session/all-sandbox",
			status: "skipped",
			reason: "sandbox-container-path",
			disposition: "ineligible",
			reasonCategory: "container-path",
			actionable: false,
			selectable: false,
			willDeleteBranch: false,
		});
		expectArchivedCleanupShape(cleanupSandboxSnapshot);
		expect(cleanupSandboxSnapshot.counts).toMatchObject({ cleaned: 0, skipped: 1, notActionable: 1, failed: 0 });
		expect(cleanupSandboxSnapshot.results).toContainEqual(expect.objectContaining({
			sessionId: sandbox.session.id,
			key: item.key,
			status: "skipped",
			reason: "sandbox-container-path",
			worktreeRemoved: false,
			branchDeleted: false,
		}));
	});

	it("multi-repo archived sessions expose one worktree row per repoWorktrees entry", () => {
		const scannedSession = findArchivedSession(scanSnapshot, multiRepo.session.id);
		expect(scannedSession).toBeTruthy();
		expect(scannedSession.worktrees).toHaveLength(2);
		const byRepo = new Map(scannedSession.worktrees.map((item: any) => [item.repo, item]));
		expect(byRepo.get(".")).toMatchObject({
			title: "Archived multi-repo worktree",
			repo: ".",
			repoPath,
			repoDisplayName: expect.any(String),
			path: join(baseDir, "missing-root-worktree"),
			branch: multiBranch,
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
			branch: multiBranch,
			source: "repoWorktrees",
			status: "already-cleaned",
			reason: "already-cleaned",
			disposition: "already-cleaned",
			reasonCategory: "already-cleaned",
			localBranchExists: true,
		});
		expect((byRepo.get("packages/api") as any).selectionCategories).toEqual(expect.arrayContaining(["archived-session", "multi-repo"]));
	});

	it("scan skips archived worktree paths still referenced by a live session", () => {
		const scannedSession = findArchivedSession(scanSnapshot, guarded.session.id);
		expect(scannedSession).toBeTruthy();
		expect(scannedSession.worktrees).toHaveLength(1);
		expect(scannedSession.worktrees[0]).toMatchObject({
			sessionId: guarded.session.id,
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
	});
});
