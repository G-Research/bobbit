/**
 * Representative commit-file metadata and commit-scoped diff routes.
 *
 * Git command results are injected through the gateway CommandRunner so parser,
 * route, validation, session, and goal behavior stay covered without spawning
 * Git. Session coverage exercises the full validation matrix; goal coverage is
 * a smoke path for the separate goal route.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createGoal, createSession, defaultProjectId, harnessDefaultProjectRoot } from "./_e2e/e2e-setup.js";
import fs from "node:fs";
import path from "node:path";
import type { CommandRunner } from "../../src/server/gateway-deps.js";

const targetCommits = new Map<string, { sha: string; marker: string }>();
let restoreCommandRunner: (() => void) | undefined;
let sharedRoot = "";
let sessionRoot = "";
let goalRoot = "";
let projectId = "";
let sessionId = "";
let goalId = "";

function fixtureRepo(projectRoot: string, name: string): string {
	const root = path.join(projectRoot, name);
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
	return root;
}

function commitTargetChanges(root: string, trackedContent = "base\ncommit scoped marker\n"): string {
	const marker = trackedContent.includes("goal commit") ? "goal commit scoped marker" : "commit scoped marker";
	const sha = marker.startsWith("goal") ? "2222222222222222222222222222222222222222" : "1111111111111111111111111111111111111111";
	targetCommits.set(path.resolve(root), { sha, marker });
	return sha;
}

function cannedGit(cwd: string, args: readonly string[]): string {
	const target = targetCommits.get(path.resolve(cwd));
	const key = args.join(" ");
	if (key === "rev-parse --show-toplevel") return cwd;
	if (key === "rev-parse --abbrev-ref HEAD") return "master";
	if (key === "rev-parse --verify HEAD" || key === "rev-parse --verify refs/heads/master") return target?.sha ?? "0".repeat(40);
	if (key.startsWith("rev-parse --abbrev-ref ") || key.startsWith("symbolic-ref ")) throw new Error("no upstream");
	if (args[0] === "cat-file" && args[1] === "-e") {
		if (target && args[2] === `${target.sha}^{commit}`) return "";
		throw new Error("unknown commit");
	}
	if (args[0] === "log") {
		if (!target) return "";
		return [
			`\x1e${target.sha}\x1f${target.sha.slice(0, 7)}\x1ftarget commit\x1fCommit Diff Test\x1f2026-01-01T00:00:00.000Z`,
			":100644 100644 0000000 0000000 M\ttracked.txt",
			":000000 100644 0000000 0000000 A\tadded.txt",
			":100644 000000 0000000 0000000 D\tdelete-me.txt",
			":100644 100644 0000000 0000000 R100\trename-old.txt\trename-new.txt",
			"1\t1\ttracked.txt",
		].join("\n");
	}
	if (args[0] === "show" && args.includes("--name-status")) {
		if (!target || !args.includes(target.sha)) throw new Error("unknown commit");
		return "M\ttracked.txt\nA\tadded.txt\nD\tdelete-me.txt\nR100\trename-old.txt\trename-new.txt";
	}
	if (args[0] === "show" && target && args.includes(target.sha)) {
		const file = args.at(-1);
		if (file === "rename-new.txt") return "diff --git a/rename-old.txt b/rename-new.txt\nsimilarity index 100%\nrename from rename-old.txt\nrename to rename-new.txt";
		return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n+${target.marker}`;
	}
	if (args[0] === "diff" && args.includes("tracked.txt")) {
		return "diff --git a/tracked.txt b/tracked.txt\n--- a/tracked.txt\n+++ b/tracked.txt\n+worktree marker";
	}
	if (args[0] === "worktree" || args[0] === "branch") return "";
	throw new Error(`unexpected canned git command: ${key}`);
}

function installCannedGitRunner(gateway: any): void {
	const runner = gateway.sessionManager.commandRunner as CommandRunner;
	const original = { execFile: runner.execFile, execFileSync: runner.execFileSync, spawn: runner.spawn };
	runner.execFile = async (file, args, options) => {
		if (path.basename(file).toLowerCase().replace(/\.exe$/, "") !== "git") throw new Error(`unexpected command: ${file}`);
		return { stdout: cannedGit(String(options?.cwd ?? ""), args), stderr: "" };
	};
	runner.execFileSync = (file, args, options) => {
		if (path.basename(file).toLowerCase().replace(/\.exe$/, "") !== "git") throw new Error(`unexpected command: ${file}`);
		return cannedGit(String(options?.cwd ?? ""), args);
	};
	runner.spawn = undefined;
	restoreCommandRunner = () => Object.assign(runner, original);
}

function byPath(files: any[], p: string): any {
	return files.find(f => f.path === p);
}

function cleanupDir(dir: string): void {
	try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* ignore */ }
}

function assertTargetCommitFiles(commit: any): void {
	expect(commit.filesChanged).toBeGreaterThanOrEqual(4);
	expect(Array.isArray(commit.files)).toBe(true);
	expect(byPath(commit.files, "tracked.txt")).toMatchObject({ status: "M", statusLabel: "modified" });
	expect(byPath(commit.files, "added.txt")).toMatchObject({ status: "A", statusLabel: "added" });
	expect(byPath(commit.files, "delete-me.txt")).toMatchObject({ status: "D", statusLabel: "deleted" });
	expect(byPath(commit.files, "rename-new.txt")).toMatchObject({ status: "R", statusLabel: "renamed", oldPath: "rename-old.txt" });
}

async function expectTargetCommitSummary(endpoint: string, targetSha: string): Promise<void> {
	const commitsResp = await apiFetch(`${endpoint}/commits`);
	expect(commitsResp.status).toBe(200);
	const body = await commitsResp.json();
	const commit = body.commits.find((c: any) => c.sha === targetSha);
	expect(commit).toBeTruthy();
	assertTargetCommitFiles(commit);
}

async function expectCommitDiff(endpoint: string, targetSha: string, file: string, marker: string): Promise<void> {
	const diffResp = await apiFetch(`${endpoint}/git-diff?commit=${targetSha}&file=${encodeURIComponent(file)}`);
	expect(diffResp.status).toBe(200);
	const diffBody = await diffResp.json();
	expect(diffBody.diff).toContain(`diff --git a/${file} b/${file}`);
	expect(diffBody.diff).toContain(marker);
}

async function expectSessionCommitDiffValidation(endpoint: string, targetSha: string): Promise<void> {
	await expectTargetCommitSummary(endpoint, targetSha);
	await expectCommitDiff(endpoint, targetSha, "tracked.txt", "commit scoped marker");

	const renameDiffResp = await apiFetch(`${endpoint}/git-diff?commit=${targetSha}&file=${encodeURIComponent("rename-new.txt")}`);
	expect(renameDiffResp.status).toBe(200);
	expect((await renameDiffResp.json()).diff).toContain("rename from rename-old.txt");

	const invalidPathResp = await apiFetch(`${endpoint}/git-diff?commit=${targetSha}&file=${encodeURIComponent("../secret.txt")}`);
	expect(invalidPathResp.status).toBe(400);
	expect((await invalidPathResp.json()).error).toBe("Invalid file path");

	const invalidCommitResp = await apiFetch(`${endpoint}/git-diff?commit=${"f".repeat(40)}&file=${encodeURIComponent("tracked.txt")}`);
	expect(invalidCommitResp.status).toBe(400);
	expect((await invalidCommitResp.json()).error).toBe("Invalid commit");
}

test.beforeAll(async ({ gateway }) => {
	installCannedGitRunner(gateway);
	projectId = (await defaultProjectId())!;
	const workspaceRoot = path.join(harnessDefaultProjectRoot(), ".e2e-workspaces");
	fs.mkdirSync(workspaceRoot, { recursive: true });
	sharedRoot = fs.mkdtempSync(path.join(workspaceRoot, "commit-diff-"));
	sessionRoot = fixtureRepo(sharedRoot, "session");
	goalRoot = fixtureRepo(sharedRoot, "goal");
	commitTargetChanges(sessionRoot);
	commitTargetChanges(goalRoot, "base\ngoal commit scoped marker\n");

	sessionId = await createSession({ cwd: sessionRoot, projectId });
	const goal = await createGoal({
		title: "Commit file diff API goal",
		cwd: goalRoot,
		worktree: false,
		autoStartTeam: false,
		projectId,
	});
	goalId = String(goal.id);
	const goalStore = gateway.projectContextManager.getOrCreate(projectId)?.goalStore;
	expect(goalStore?.update(goalId, {
		branch: "master",
		worktreePath: goalRoot,
		setupStatus: "ready",
	})).toBe(true);
});

test.afterAll(async ({ gateway }) => {
	const context = projectId ? gateway.projectContextManager.getOrCreate(projectId) : undefined;
	if (sessionId) {
		await gateway.sessionManager.terminateSession(sessionId).catch(() => {});
		await gateway.sessionManager.purgeArchivedSession(sessionId).catch(() => {});
	}
	if (goalId) await context?.goalManager.deleteGoal(goalId).catch(() => {});
	restoreCommandRunner?.();
	targetCommits.clear();
	if (sharedRoot) cleanupDir(sharedRoot);
});

// Shared gateway state and the injected command runner are intentionally serial.
test.describe.configure({ mode: "serial" });

test.describe("commit file diff API", () => {
	test("session commits include changed files and commit-scoped git-diff", async () => {
		const targetSha = targetCommits.get(path.resolve(sessionRoot))!.sha;
		await expectSessionCommitDiffValidation(`/api/sessions/${sessionId}`, targetSha);

		const sessionResp = await apiFetch(`/api/sessions/${sessionId}`);
		expect(sessionResp.status).toBe(200);
		const sessionCwd = (await sessionResp.json()).cwd;
		fs.writeFileSync(path.join(sessionCwd, "tracked.txt"), "base\nworktree marker\n");
		const worktreeResp = await apiFetch(`/api/sessions/${sessionId}/git-diff?file=${encodeURIComponent("tracked.txt")}`);
		expect(worktreeResp.status).toBe(200);
		expect((await worktreeResp.json()).diff).toContain("+worktree marker");
	});

	test("goal commits include changed files and commit-scoped git-diff", async () => {
		const goalTargetSha = targetCommits.get(path.resolve(goalRoot))!.sha;
		await expectTargetCommitSummary(`/api/goals/${goalId}`, goalTargetSha);
		await expectCommitDiff(`/api/goals/${goalId}`, goalTargetSha, "tracked.txt", "goal commit scoped marker");
	});
});
