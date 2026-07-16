/**
 * Representative commit-file metadata and commit-scoped diff routes.
 *
 * Each declaration owns a live route entity, an exact cwd-to-repository model,
 * and a scoped CommandRunner. This keeps the shared fork's runner and commit
 * responses from leaking between this file and neighboring Git suites.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createGoal, createSession, defaultProjectId, harnessDefaultProjectRoot } from "./_e2e/e2e-setup.js";
import fs from "node:fs";
import path from "node:path";
import type { CommandRunner } from "../../src/server/gateway-deps.js";

type CommitFixture = {
	cwd: string;
	sha: string;
	marker: string;
};

type InstalledRunner = {
	reset(): void;
};

function fixtureRepo(projectRoot: string, name: string): string {
	const root = path.resolve(projectRoot, name);
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
	return root;
}

function commitLog(fixture: CommitFixture): string {
	return [
		`\x1e${fixture.sha}\x1f${fixture.sha.slice(0, 7)}\x1ftarget commit\x1fCommit Diff Test\x1f2026-01-01T00:00:00.000Z`,
		":100644 100644 0000000 0000000 M\ttracked.txt",
		":000000 100644 0000000 0000000 A\tadded.txt",
		":100644 000000 0000000 0000000 D\tdelete-me.txt",
		":100644 100644 0000000 0000000 R100\trename-old.txt\trename-new.txt",
		"1\t1\ttracked.txt",
	].join("\n");
}

function cannedGit(fixture: CommitFixture, args: readonly string[]): string {
	const key = args.join(" ");
	if (key === "rev-parse --show-toplevel") return fixture.cwd;
	if (key === "rev-parse --abbrev-ref HEAD") return "master";
	if (key === "rev-parse --verify HEAD" || key === "rev-parse --verify refs/heads/master") return fixture.sha;
	if (key === "symbolic-ref refs/remotes/origin/HEAD") return "refs/remotes/origin/master";
	if (key.startsWith("rev-parse --abbrev-ref ")) throw new Error("no upstream");
	if (args[0] === "cat-file" && args[1] === "-e") {
		if (args[2] === `${fixture.sha}^{commit}`) return "";
		throw new Error("unknown commit");
	}
	if (args[0] === "log") return commitLog(fixture);
	if (args[0] === "show" && args.includes("--name-status")) {
		if (!args.includes(fixture.sha)) throw new Error("unknown commit");
		return "M\ttracked.txt\nA\tadded.txt\nD\tdelete-me.txt\nR100\trename-old.txt\trename-new.txt";
	}
	if (args[0] === "show" && args.includes(fixture.sha)) {
		const file = args.at(-1);
		if (file === "rename-new.txt") {
			return "diff --git a/rename-old.txt b/rename-new.txt\nsimilarity index 100%\nrename from rename-old.txt\nrename to rename-new.txt";
		}
		return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n+${fixture.marker}`;
	}
	if (args[0] === "diff" && args.includes("tracked.txt")) {
		return "diff --git a/tracked.txt b/tracked.txt\n--- a/tracked.txt\n+++ b/tracked.txt\n+worktree marker";
	}
	throw new Error(`unexpected canned git command: ${key}`);
}

function installCannedGitRunner(gateway: any, fixture: CommitFixture): InstalledRunner {
	const runner = gateway.sessionManager.commandRunner as CommandRunner;
	const original = { execFile: runner.execFile, execFileSync: runner.execFileSync, spawn: runner.spawn };
	const commitResponses = new Map<string, CommitFixture>([[path.resolve(fixture.cwd), fixture]]);

	const fixtureFor = (cwd: unknown): CommitFixture => {
		const resolved = path.resolve(String(cwd ?? ""));
		const match = commitResponses.get(resolved);
		if (!match) {
			throw new Error(`unexpected git cwd: ${resolved}; expected ${[...commitResponses.keys()].join(", ")}`);
		}
		return match;
	};

	runner.execFile = async (file, args, options) => {
		if (path.basename(file).toLowerCase().replace(/\.exe$/, "") !== "git") throw new Error(`unexpected command: ${file}`);
		return { stdout: cannedGit(fixtureFor(options?.cwd), args), stderr: "" };
	};
	runner.execFileSync = (file, args, options) => {
		if (path.basename(file).toLowerCase().replace(/\.exe$/, "") !== "git") throw new Error(`unexpected command: ${file}`);
		return cannedGit(fixtureFor(options?.cwd), args);
	};
	runner.spawn = undefined;

	let reset = false;
	return {
		reset() {
			if (reset) return;
			reset = true;
			commitResponses.clear();
			Object.assign(runner, original);
		},
	};
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

function makeCaseRoot(tag: string): string {
	const workspaceRoot = path.join(harnessDefaultProjectRoot(), ".e2e-workspaces");
	fs.mkdirSync(workspaceRoot, { recursive: true });
	return fs.mkdtempSync(path.join(workspaceRoot, `commit-diff-${tag}-`));
}

async function cleanupSession(gateway: any, sessionId: string): Promise<void> {
	await gateway.sessionManager.terminateSession(sessionId).catch(() => {});
	await gateway.sessionManager.purgeArchivedSession(sessionId).catch(() => {});
}

// The gateway CommandRunner is shared within a fork, so these cases must remain serial.
test.describe.configure({ mode: "serial" });

test.describe("commit file diff API", () => {
	test("session commits include changed files and commit-scoped git-diff", async ({ gateway }) => {
		const projectId = (await defaultProjectId())!;
		const caseRoot = makeCaseRoot("session");
		const requestedRoot = fixtureRepo(caseRoot, "repo");
		let sessionId = "";
		let installedRunner: InstalledRunner | undefined;
		try {
			sessionId = await createSession({ cwd: requestedRoot, projectId });
			const liveSession = gateway.sessionManager.getSession(sessionId);
			expect(liveSession).toBeTruthy();
			const liveCwd = path.resolve(liveSession.cwd);
			expect(liveCwd).toBe(path.resolve(requestedRoot));

			const fixture: CommitFixture = {
				cwd: liveCwd,
				sha: "1111111111111111111111111111111111111111",
				marker: "commit scoped marker",
			};
			installedRunner = installCannedGitRunner(gateway, fixture);

			await expectSessionCommitDiffValidation(`/api/sessions/${sessionId}`, fixture.sha);

			const sessionResp = await apiFetch(`/api/sessions/${sessionId}`);
			expect(sessionResp.status).toBe(200);
			const sessionCwd = path.resolve((await sessionResp.json()).cwd);
			expect(sessionCwd).toBe(fixture.cwd);
			fs.writeFileSync(path.join(sessionCwd, "tracked.txt"), "base\nworktree marker\n");
			const worktreeResp = await apiFetch(`/api/sessions/${sessionId}/git-diff?file=${encodeURIComponent("tracked.txt")}`);
			expect(worktreeResp.status).toBe(200);
			expect((await worktreeResp.json()).diff).toContain("+worktree marker");
		} finally {
			installedRunner?.reset();
			if (sessionId) await cleanupSession(gateway, sessionId);
			cleanupDir(caseRoot);
		}
	});

	test("goal commits include changed files and commit-scoped git-diff", async ({ gateway }) => {
		const projectId = (await defaultProjectId())!;
		const caseRoot = makeCaseRoot("goal");
		const requestedRoot = fixtureRepo(caseRoot, "repo");
		let goalId = "";
		let installedRunner: InstalledRunner | undefined;
		try {
			const createdGoal = await createGoal({
				title: "Commit file diff API goal",
				cwd: requestedRoot,
				worktree: false,
				autoStartTeam: false,
				projectId,
			});
			goalId = String(createdGoal.id);
			const context = gateway.projectContextManager.getOrCreate(projectId);
			const goalStore = context?.goalStore;
			expect(goalStore?.update(goalId, {
				branch: "master",
				worktreePath: requestedRoot,
				setupStatus: "ready",
			})).toBe(true);
			const liveGoal = goalStore?.get(goalId);
			expect(liveGoal).toBeTruthy();
			const liveCwd = path.resolve(liveGoal.cwd);
			expect(liveCwd).toBe(path.resolve(requestedRoot));

			const fixture: CommitFixture = {
				cwd: liveCwd,
				sha: "2222222222222222222222222222222222222222",
				marker: "goal commit scoped marker",
			};
			installedRunner = installCannedGitRunner(gateway, fixture);

			await expectTargetCommitSummary(`/api/goals/${goalId}`, fixture.sha);
			await expectCommitDiff(`/api/goals/${goalId}`, fixture.sha, "tracked.txt", fixture.marker);
		} finally {
			installedRunner?.reset();
			if (goalId) {
				const context = gateway.projectContextManager.getOrCreate(projectId);
				await context?.goalManager.deleteGoal(goalId).catch(() => {});
			}
			cleanupDir(caseRoot);
		}
	});
});
