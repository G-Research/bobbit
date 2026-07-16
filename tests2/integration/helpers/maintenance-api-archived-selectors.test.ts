import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorktreeInventoryService } from "../../../src/server/agent/worktree-inventory.js";
import type { PersistedSession } from "../../../src/server/agent/session-store.js";
import type { CommandRunner } from "../../../src/server/gateway-deps.js";
import { MaintenanceGitModel } from "./maintenance-git-model.js";

const projectId = "archived-selectors-project";
const clockNow = 1_750_000_000_000;
const maintenanceGit = new MaintenanceGitModel("archived-selectors-isolated");
const archivedSessions: PersistedSession[] = [];
const liveSessions: PersistedSession[] = [];

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
let removable: PersistedSession;
let liveReferenced: PersistedSession;
let sandbox: PersistedSession;
let stale: PersistedSession;
let alreadyCleaned: PersistedSession;
let multiRepo: PersistedSession;
let guarded: PersistedSession;
let inventory: WorktreeInventoryService;
let scanSnapshot: Awaited<ReturnType<WorktreeInventoryService["legacyArchivedSessionWorktrees"]>>;
let cleanupAllSnapshot: Awaited<ReturnType<WorktreeInventoryService["cleanupLegacyArchivedSessionWorktrees"]>>;
let cleanupSandboxBySessionSnapshot: Awaited<ReturnType<WorktreeInventoryService["cleanupLegacyArchivedSessionWorktrees"]>>;
let cleanupSandboxByKeySnapshot: Awaited<ReturnType<WorktreeInventoryService["cleanupLegacyArchivedSessionWorktrees"]>>;

const normalizeTestPath = (value: string): string => value.replace(/\\/g, "/").toLowerCase();
const findArchivedSession = (scan: typeof scanSnapshot, sessionId: string) => scan.sessions.find(session => session.id === sessionId);
const findArchivedWorktreeItem = (scan: typeof scanSnapshot, sessionId: string) => scan.items.find(item => item.sessionId === sessionId);

function makeSession(id: string, title: string, overrides: Partial<PersistedSession>): PersistedSession {
	return {
		id,
		title,
		cwd: overrides.worktreePath ?? baseDir,
		agentSessionFile: join(baseDir, `${id}.jsonl`),
		createdAt: clockNow - 2_000,
		lastActivity: clockNow - 1_000,
		archived: true,
		archivedAt: clockNow,
		projectId,
		...overrides,
	};
}

function registerRepo(path: string): void {
	mkdirSync(join(path, ".git"), { recursive: true });
	writeFileSync(join(path, "README.md"), "# isolated archived selector fixture\n");
	maintenanceGit.registerRepo(path);
}

const commandRunner: CommandRunner = {
	async execFile(file, args, options) {
		if (!/(^|[\\/])git(?:\.exe)?$/i.test(file)) throw new Error(`unexpected archived selector executable: ${file}`);
		const cwd = typeof options?.cwd === "string" ? options.cwd : repoPath;
		return { stdout: maintenanceGit.run(cwd, args), stderr: "" };
	},
};

beforeAll(async () => {
	baseDir = mkdtempSync(join(tmpdir(), "bobbit-archived-selectors-isolated-"));
	repoPath = join(baseDir, "repo");
	packageRepoPath = join(repoPath, "packages", "api");
	removablePath = join(baseDir, "all-removable-worktree");
	liveReferencedPath = join(baseDir, "all-live-referenced-worktree");
	stalePath = join(baseDir, "all-stale-directory");
	alreadyCleanedPath = join(baseDir, "all-already-cleaned");
	sharedWorktreePath = join(baseDir, "shared-worktree");
	removableBranch = "session/archived-all-removable";
	liveBranch = "session/archived-all-live";
	staleBranch = "session/archived-all-stale";
	alreadyBranch = "session/archived-all-already";
	multiBranch = "session/archived-multirepo";

	registerRepo(repoPath);
	registerRepo(packageRepoPath);
	maintenanceGit.addWorktree(repoPath, removablePath, removableBranch);
	maintenanceGit.addWorktree(repoPath, liveReferencedPath, liveBranch);
	for (const branch of [staleBranch, alreadyBranch, multiBranch]) maintenanceGit.addBranch(repoPath, branch);
	maintenanceGit.addBranch(packageRepoPath, multiBranch);
	mkdirSync(stalePath, { recursive: true });
	mkdirSync(sharedWorktreePath, { recursive: true });

	removable = makeSession("archived-all-removable", "All removable", {
		cwd: removablePath, repoPath, worktreePath: removablePath, branch: removableBranch,
	});
	liveReferenced = makeSession("archived-all-live", "All live referenced", {
		cwd: liveReferencedPath, repoPath, worktreePath: liveReferencedPath, branch: liveBranch,
	});
	sandbox = makeSession("archived-all-sandbox", "All sandbox", {
		cwd: "/workspace-wt/session/all-sandbox", repoPath,
		worktreePath: "/workspace-wt/session/all-sandbox", branch: "session/all-sandbox", sandboxed: true,
	});
	stale = makeSession("archived-all-stale", "All stale", {
		cwd: stalePath, repoPath, worktreePath: stalePath, branch: staleBranch,
	});
	alreadyCleaned = makeSession("archived-all-already", "All already cleaned", {
		cwd: alreadyCleanedPath, repoPath, worktreePath: alreadyCleanedPath, branch: alreadyBranch,
	});
	multiRepo = makeSession("archived-multirepo", "Archived multi-repo worktree", {
		cwd: join(baseDir, "container"), repoPath, worktreePath: join(baseDir, "container"), branch: multiBranch,
		repoWorktrees: {
			".": join(baseDir, "missing-root-worktree"),
			"packages/api": join(baseDir, "missing-api-worktree"),
		},
	});
	guarded = makeSession("archived-guarded", "Archived guarded worktree", {
		cwd: sharedWorktreePath, repoPath, worktreePath: sharedWorktreePath, branch: "session/archived-guarded-branch",
	});
	archivedSessions.push(removable, liveReferenced, sandbox, stale, alreadyCleaned, multiRepo, guarded);
	liveSessions.push(
		makeSession("live-all-guard", "Live all guard", {
			archived: false, archivedAt: undefined, cwd: liveReferencedPath,
			repoPath, worktreePath: liveReferencedPath, branch: liveBranch,
		}),
		makeSession("live-guard", "Live guard", {
			archived: false, archivedAt: undefined, cwd: sharedWorktreePath,
			repoPath, worktreePath: sharedWorktreePath, branch: "session/live-guard-branch",
		}),
	);

	const projectContext = {
		project: { id: projectId, name: "Archived selector project", rootPath: repoPath },
		projectConfigStore: {
			getComponents: () => [
				{ name: "root", repo: "." },
				{ name: "api", repo: "packages/api" },
			],
			get: () => undefined,
		},
		sessionStore: {
			getArchived: () => archivedSessions,
			getLive: () => liveSessions,
			get: (id: string) => [...archivedSessions, ...liveSessions].find(session => session.id === id),
		},
		goalStore: { getAll: () => [] },
		teamStore: { getAll: () => [] },
		staffStore: { getAll: () => [] },
	};
	inventory = new WorktreeInventoryService({
		projectContextManager: { visible: () => [projectContext], all: () => [projectContext] } as any,
		sessionManager: { listSessions: () => [], getAllWorktreePools: () => new Map() } as any,
		commandRunner,
		clock: () => clockNow,
		remotePolicy: { skipNonLocalRemoteGit: true },
	});

	scanSnapshot = await inventory.legacyArchivedSessionWorktrees(true);
	cleanupAllSnapshot = await inventory.cleanupLegacyArchivedSessionWorktrees({ mode: "all" });
	cleanupSandboxBySessionSnapshot = await inventory.cleanupLegacyArchivedSessionWorktrees({
		mode: "selected",
		sessionIds: [sandbox.id],
	});
	const sandboxItem = findArchivedWorktreeItem(scanSnapshot, sandbox.id)!;
	cleanupSandboxByKeySnapshot = await inventory.cleanupLegacyArchivedSessionWorktrees({
		mode: "selected",
		worktrees: [{ sessionId: sandbox.id, key: sandboxItem.key }],
	});
});

afterAll(() => {
	archivedSessions.length = 0;
	liveSessions.length = 0;
	maintenanceGit.reset();
	if (baseDir) rmSync(baseDir, { recursive: true, force: true });
});

describe("archived session worktree maintenance", () => {
	it("mode all cleans only safe candidates and leaves ineligible archived records untouched", () => {
		expect(findArchivedWorktreeItem(scanSnapshot, removable.id)).toMatchObject({ status: "removable", actionable: true });
		expect(findArchivedWorktreeItem(scanSnapshot, liveReferenced.id)).toMatchObject({ status: "skipped", reason: "referenced-by-live-session", actionable: false });
		expect(findArchivedWorktreeItem(scanSnapshot, sandbox.id)).toMatchObject({ status: "skipped", reason: "sandbox-container-path", actionable: false });
		expect(findArchivedWorktreeItem(scanSnapshot, stale.id)).toMatchObject({ status: "skipped", reason: "stale-worktree-directory", actionable: false });
		expect(findArchivedWorktreeItem(scanSnapshot, alreadyCleaned.id)).toMatchObject({ status: "already-cleaned", reason: "already-cleaned", actionable: false });

		expect(cleanupAllSnapshot.counts).toMatchObject({ cleaned: 1, branchDeleted: 1, worktreeRemoved: 1, invalidSelection: 0, notActionable: 0, failed: 0 });
		expect(cleanupAllSnapshot.results).toContainEqual(expect.objectContaining({
			sessionId: removable.id,
			status: "cleaned",
			path: removablePath,
			branch: removableBranch,
			worktreeRemoved: true,
			branchDeleted: true,
		}));
		expect(cleanupAllSnapshot.results.some(result => [liveReferenced.id, sandbox.id, stale.id, alreadyCleaned.id].includes(result.sessionId))).toBe(false);
		expect(existsSync(removablePath)).toBe(false);
		expect(maintenanceGit.branchExists(repoPath, removableBranch)).toBe(false);
		expect(existsSync(liveReferencedPath)).toBe(true);
		expect(maintenanceGit.listedWorktreePaths(repoPath).map(normalizeTestPath)).toContain(normalizeTestPath(liveReferencedPath));
		expect(existsSync(stalePath)).toBe(true);
		expect(maintenanceGit.branchExists(repoPath, liveBranch)).toBe(true);
		expect(maintenanceGit.branchExists(repoPath, staleBranch)).toBe(true);
		expect(maintenanceGit.branchExists(repoPath, alreadyBranch)).toBe(true);
	});

	it("sandbox container paths are skipped instead of treated as host worktrees", () => {
		const scannedSession = findArchivedSession(scanSnapshot, sandbox.id);
		expect(scannedSession).toBeTruthy();
		expect(scannedSession!.sandboxed).toBe(true);
		expect(scannedSession!.worktrees).toHaveLength(1);
		const item = scannedSession!.worktrees[0];
		expect(item).toMatchObject({
			sessionId: sandbox.id,
			path: "/workspace-wt/session/all-sandbox",
			status: "skipped",
			reason: "sandbox-container-path",
			disposition: "ineligible",
			reasonCategory: "container-path",
			actionable: false,
			selectable: false,
			willDeleteBranch: false,
		});
		for (const cleanup of [cleanupSandboxBySessionSnapshot, cleanupSandboxByKeySnapshot]) {
			expect(cleanup.counts).toMatchObject({ cleaned: 0, skipped: 1, notActionable: 1, failed: 0 });
			expect(cleanup.results).toContainEqual(expect.objectContaining({
				sessionId: sandbox.id,
				key: item.key,
				status: "skipped",
				reason: "sandbox-container-path",
				worktreeRemoved: false,
				branchDeleted: false,
			}));
		}
	});

	it("multi-repo archived sessions expose one worktree row per repoWorktrees entry", () => {
		const scannedSession = findArchivedSession(scanSnapshot, multiRepo.id);
		expect(scannedSession).toBeTruthy();
		expect(scannedSession!.worktrees).toHaveLength(2);
		const byRepo = new Map(scannedSession!.worktrees.map(item => [item.repo, item]));
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
		expect(byRepo.get(".")!.selectionCategories).toEqual(expect.arrayContaining(["archived-session", "multi-repo"]));
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
		expect(byRepo.get("packages/api")!.selectionCategories).toEqual(expect.arrayContaining(["archived-session", "multi-repo"]));
	});

	it("scan skips archived worktree paths still referenced by a live session", () => {
		const scannedSession = findArchivedSession(scanSnapshot, guarded.id);
		expect(scannedSession).toBeTruthy();
		expect(scannedSession!.worktrees).toHaveLength(1);
		expect(scannedSession!.worktrees[0]).toMatchObject({
			sessionId: guarded.id,
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
