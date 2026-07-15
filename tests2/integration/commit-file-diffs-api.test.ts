/**
 * API E2E — representative commit-file metadata and commit-scoped diff routes.
 *
 * The suite uses one copied git template so route coverage does not pay repeated
 * git init/config/initial-commit setup. Session coverage exercises the full
 * validation matrix; goal coverage is a smoke path for the separate goal route.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createGoal, createSession, deleteGoal, deleteSession, registerProject } from "./_e2e/e2e-setup.js";
import { awaitableRm } from "../../tests/e2e/test-utils/cleanup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let templateRepo = "";
const cleanupRoots: string[] = [];

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
}

function commitTargetChanges(root: string, trackedContent = "base\ncommit scoped marker\n"): string {
	fs.writeFileSync(path.join(root, "tracked.txt"), trackedContent);
	fs.writeFileSync(path.join(root, "added.txt"), "added marker\n");
	fs.rmSync(path.join(root, "delete-me.txt"));
	git(root, ["mv", "rename-old.txt", "rename-new.txt"]);
	git(root, ["add", "."]);
	git(root, ["commit", "--quiet", "-m", "target commit"]);
	return git(root, ["rev-parse", "HEAD"]);
}

function createTemplateRepo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-commit-diff-template-"));
	git(root, ["init", "--quiet"]);
	git(root, ["checkout", "--quiet", "-B", "master"]);
	git(root, ["config", "user.email", "test@bobbit.local"]);
	git(root, ["config", "user.name", "Commit Diff Test"]);
	git(root, ["config", "core.autocrlf", "false"]);
	git(root, ["config", "commit.gpgsign", "false"]);

	fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
	fs.writeFileSync(path.join(root, "delete-me.txt"), "delete me\n");
	fs.writeFileSync(path.join(root, "rename-old.txt"), "rename me\n");
	git(root, ["add", "."]);
	git(root, ["commit", "--quiet", "-m", "initial"]);
	return root;
}

function fixtureRepo(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-commit-diff-${prefix}-`));
	fs.rmSync(root, { recursive: true, force: true });
	fs.cpSync(templateRepo, root, { recursive: true });
	cleanupRoots.push(root);
	return root;
}

function byPath(files: any[], p: string): any {
	return files.find(f => f.path === p);
}

async function safeRm(dir: string): Promise<void> {
	await awaitableRm(dir, { onFinalFailure: () => {} });
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

test.beforeAll(() => {
	templateRepo = createTemplateRepo();
});

test.afterAll(() => {
	for (const root of cleanupRoots) cleanupDir(root);
	if (templateRepo) cleanupDir(templateRepo);
});

// Shared gateway state and copied git fixtures are intentionally kept serial.
test.describe.configure({ mode: "serial" });

test.describe("commit file diff API", () => {
	test("session commits include changed files and commit-scoped git-diff", async () => {
		const root = fixtureRepo("session");
		const targetSha = commitTargetChanges(root);
		const project = await registerProject({ name: `commit-diff-session-${Date.now()}`, rootPath: root, seedWorkflows: false });
		const sessionId = await createSession({ cwd: root, projectId: project.id });
		try {
			await expectSessionCommitDiffValidation(`/api/sessions/${sessionId}`, targetSha);

			const sessionResp = await apiFetch(`/api/sessions/${sessionId}`);
			expect(sessionResp.status).toBe(200);
			const sessionCwd = (await sessionResp.json()).cwd;
			fs.writeFileSync(path.join(sessionCwd, "tracked.txt"), "base\nworktree marker\n");
			const worktreeResp = await apiFetch(`/api/sessions/${sessionId}/git-diff?file=${encodeURIComponent("tracked.txt")}`);
			expect(worktreeResp.status).toBe(200);
			expect((await worktreeResp.json()).diff).toContain("+worktree marker");
		} finally {
			await deleteSession(sessionId).catch(() => {});
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			await safeRm(root);
		}
	});

	test("goal commits include changed files and commit-scoped git-diff", async ({ gateway }) => {
		const root = fixtureRepo("goal");
		const goalTargetSha = commitTargetChanges(root, "base\ngoal commit scoped marker\n");
		const project = await registerProject({ name: `commit-diff-goal-${Date.now()}`, rootPath: root, seedWorkflows: false });
		let goalId: string | undefined;
		try {
			// Commit-route coverage does not depend on asynchronous worktree
			// provisioning. Create a no-worktree goal, then attach the already-real
			// Git fixture through the harness store seam. This preserves the goal
			// route's real Git behavior without an unrelated readiness timeout whose
			// cleanup could delete the repo while provisioning was still running.
			const goal = await createGoal({
				title: "Commit file diff API goal",
				cwd: root,
				worktree: false,
				autoStartTeam: false,
				projectId: project.id,
			});
			goalId = String(goal.id);
			const goalStore = gateway.projectContextManager.getOrCreate(project.id)?.goalStore;
			expect(goalStore?.update(goalId, {
				branch: "master",
				worktreePath: root,
				setupStatus: "ready",
			})).toBe(true);

			await expectTargetCommitSummary(`/api/goals/${goalId}`, goalTargetSha);
			await expectCommitDiff(`/api/goals/${goalId}`, goalTargetSha, "tracked.txt", "goal commit scoped marker");
		} finally {
			if (goalId) await deleteGoal(goalId).catch(() => {});
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			await safeRm(root);
		}
	});
});
