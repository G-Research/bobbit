import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, createSession, deleteGoal, deleteSession, registerProject } from "./e2e-setup.js";
import { awaitableRm, pollUntil } from "./test-utils/cleanup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitTargetChanges(root: string, trackedContent = "base\ncommit scoped marker\n"): string {
	fs.writeFileSync(path.join(root, "tracked.txt"), trackedContent);
	fs.writeFileSync(path.join(root, "added.txt"), "added marker\n");
	fs.rmSync(path.join(root, "delete-me.txt"));
	git(root, ["mv", "rename-old.txt", "rename-new.txt"]);
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "target commit"]);
	return git(root, ["rev-parse", "HEAD"]);
}

function initRepo(): { root: string; targetSha: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-commit-diff-api-"));
	git(root, ["init"]);
	git(root, ["checkout", "-B", "master"]);
	git(root, ["config", "user.email", "test@bobbit.local"]);
	git(root, ["config", "user.name", "Commit Diff Test"]);
	git(root, ["config", "core.autocrlf", "false"]);

	fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
	fs.writeFileSync(path.join(root, "delete-me.txt"), "delete me\n");
	fs.writeFileSync(path.join(root, "rename-old.txt"), "rename me\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "initial"]);

	const targetSha = commitTargetChanges(root);
	return { root, targetSha };
}

function byPath(files: any[], p: string): any {
	return files.find(f => f.path === p);
}

async function safeRm(dir: string): Promise<void> {
	await awaitableRm(dir, { onFinalFailure: () => {} });
}

function assertTargetCommitFiles(commit: any): void {
	expect(commit.filesChanged).toBeGreaterThanOrEqual(4);
	expect(Array.isArray(commit.files)).toBe(true);
	expect(byPath(commit.files, "tracked.txt")).toMatchObject({ status: "M", statusLabel: "modified" });
	expect(byPath(commit.files, "added.txt")).toMatchObject({ status: "A", statusLabel: "added" });
	expect(byPath(commit.files, "delete-me.txt")).toMatchObject({ status: "D", statusLabel: "deleted" });
	expect(byPath(commit.files, "rename-new.txt")).toMatchObject({ status: "R", statusLabel: "renamed", oldPath: "rename-old.txt" });
}

async function expectTargetCommit(endpoint: string, targetSha: string): Promise<void> {
	const commitsResp = await apiFetch(`${endpoint}/commits`);
	expect(commitsResp.status).toBe(200);
	const body = await commitsResp.json();
	const commit = body.commits.find((c: any) => c.sha === targetSha);
	expect(commit).toBeTruthy();
	assertTargetCommitFiles(commit);

	const diffResp = await apiFetch(`${endpoint}/git-diff?commit=${targetSha}&file=${encodeURIComponent("tracked.txt")}`);
	expect(diffResp.status).toBe(200);
	const diffBody = await diffResp.json();
	expect(diffBody.diff).toContain("diff --git a/tracked.txt b/tracked.txt");
	expect(diffBody.diff).toContain("commit scoped marker");

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

test.describe("commit file diff API", () => {
	test("session commits include changed files and commit-scoped git-diff", async () => {
		const { root, targetSha } = initRepo();
		const project = await registerProject({ name: `commit-diff-session-${Date.now()}`, rootPath: root });
		const sessionId = await createSession({ cwd: root, projectId: project.id });
		try {
			await expectTargetCommit(`/api/sessions/${sessionId}`, targetSha);

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

	test("goal commits include changed files and commit-scoped git-diff", async () => {
		const { root } = initRepo();
		const project = await registerProject({ name: `commit-diff-goal-${Date.now()}`, rootPath: root });
		let goalId: string | undefined;
		try {
			const goal = await createGoal({
				title: "Commit file diff API goal",
				cwd: root,
				worktree: true,
				autoStartTeam: false,
				projectId: project.id,
			});
			goalId = String(goal.id);
			const readyGoal = await pollUntil(async () => {
				const resp = await apiFetch(`/api/goals/${goalId}`);
				if (resp.status !== 200) return null;
				const body = await resp.json();
				return body.setupStatus === "ready"
					&& typeof body.cwd === "string"
					&& typeof body.branch === "string"
					&& typeof body.worktreePath === "string"
					&& fs.existsSync(body.cwd)
					? body
					: null;
			}, { timeoutMs: 15_000, label: "goal worktree ready" });
			const goalCwd = readyGoal.cwd;

			fs.writeFileSync(path.join(goalCwd, "tracked.txt"), "base\n");
			fs.writeFileSync(path.join(goalCwd, "delete-me.txt"), "delete me\n");
			fs.writeFileSync(path.join(goalCwd, "rename-old.txt"), "rename me\n");
			fs.rmSync(path.join(goalCwd, "added.txt"), { force: true });
			fs.rmSync(path.join(goalCwd, "rename-new.txt"), { force: true });
			git(goalCwd, ["add", "."]);
			git(goalCwd, ["commit", "-m", "prepare target commit"]);
			const goalTargetSha = commitTargetChanges(goalCwd, "base\ngoal commit scoped marker\n");

			await expectTargetCommit(`/api/goals/${goalId}`, goalTargetSha);
		} finally {
			if (goalId) await deleteGoal(goalId).catch(() => {});
			await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			await safeRm(root);
		}
	});
});
