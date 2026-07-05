import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createGoal, createSession, deleteGoal, deleteSession, nonGitCwd } from "./_e2e/e2e-setup.js";
import { awaitableRm, pollUntil } from "../../tests/e2e/test-utils/cleanup.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(): string {
	const root = fs.mkdtempSync(path.join(nonGitCwd(), "bobbit-quiet-pr-status-"));
	git(root, ["init"]);
	git(root, ["checkout", "-B", "master"]);
	git(root, ["config", "user.email", "test@bobbit.local"]);
	git(root, ["config", "user.name", "Quiet PR Test"]);
	git(root, ["config", "core.autocrlf", "false"]);
	fs.writeFileSync(path.join(root, "README.md"), "# quiet pr-status\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "initial"]);
	return root;
}

type QuietPrGoal = { id: string; branch: string; cwd: string; root: string; worktreePath: string; projectId?: string };

async function safeRm(dir: string | undefined): Promise<void> {
	if (!dir) return;
	await awaitableRm(dir, { onFinalFailure: () => {} });
}

async function cleanupGoal(goal: QuietPrGoal | undefined): Promise<void> {
	if (!goal) return;
	await deleteGoal(goal.id).catch(() => {});
	await safeRm(goal.worktreePath ? path.dirname(goal.worktreePath) : undefined);
	await safeRm(goal.root);
}

async function expectEmptyNoContent(resp: Response, label: string): Promise<void> {
	expect(resp.status, `${label} should return 204 No Content`).toBe(204);
	expect(await resp.text(), `${label} 204 response must have no body`).toBe("");
}

async function createGoalWithNoPrBranch(): Promise<QuietPrGoal> {
	const root = initRepo();
	try {
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const goal = await createGoal({
			title: `quiet pr-status no-pr ${suffix}`,
			cwd: root,
			worktree: true,
			autoStartTeam: false,
			spec: "E2E reproducer goal for quiet optional PR status probes with no matching GitHub PR.",
		});

		const readyGoal = await pollUntil(async () => {
			const resp = await apiFetch(`/api/goals/${goal.id}`);
			if (resp.status !== 200) return null;
			const body = await resp.json();
			if (body.setupStatus === "error") {
				throw new Error(`goal worktree setup failed: ${body.setupError ?? "unknown error"}`);
			}
			return body.setupStatus === "ready"
				&& typeof body.cwd === "string"
				&& typeof body.branch === "string"
				&& typeof body.worktreePath === "string"
				&& fs.existsSync(body.cwd)
				? body
				: null;
		}, { timeoutMs: 15_000, label: "quiet pr-status goal worktree ready" });

		return {
			id: String(readyGoal.id),
			branch: readyGoal.branch,
			cwd: readyGoal.cwd,
			root,
			worktreePath: readyGoal.worktreePath,
			projectId: typeof readyGoal.projectId === "string" ? readyGoal.projectId : undefined,
		};
	} catch (err) {
		await safeRm(root);
		throw err;
	}
}

test.describe("quiet optional PR status probes", () => {
	test("keeps bare session PR absence as 404 but returns empty 204 in optional mode", async () => {
		let goal: QuietPrGoal | undefined;
		let sessionId: string | undefined;
		try {
			goal = await createGoalWithNoPrBranch();
			sessionId = await createSession({ goalId: goal.id, cwd: goal.cwd, projectId: goal.projectId });

			const bareResp = await apiFetch(`/api/sessions/${sessionId}/pr-status`);
			expect(bareResp.status, "bare session PR-status absence should remain 404").toBe(404);

			const optionalResp = await apiFetch(`/api/sessions/${sessionId}/pr-status?optional=1`);
			await expectEmptyNoContent(optionalResp, "quiet optional session PR-status absence");
		} finally {
			if (sessionId) await deleteSession(sessionId);
			await cleanupGoal(goal);
		}
	});

	test("returns 404 for a missing session even in optional PR-status mode", async () => {
		const resp = await apiFetch("/api/sessions/no-such-session/pr-status?optional=1");
		expect(resp.status, "missing session should remain 404 even for quiet PR-status probes").toBe(404);
	});

	test("keeps bare goal PR absence as 404 but returns empty 204 in optional mode", async () => {
		let goal: QuietPrGoal | undefined;
		try {
			goal = await createGoalWithNoPrBranch();
			const bareResp = await apiFetch(`/api/goals/${goal.id}/pr-status`);
			expect(bareResp.status, "bare goal PR-status absence should remain 404").toBe(404);

			const optionalResp = await apiFetch(`/api/goals/${goal.id}/pr-status?optional=1`);
			await expectEmptyNoContent(optionalResp, "quiet optional goal PR-status absence");
		} finally {
			await cleanupGoal(goal);
		}
	});

	test("returns 404 for a missing goal even in optional PR-status mode", async () => {
		const resp = await apiFetch("/api/goals/no-such-goal/pr-status?optional=1");
		expect(resp.status, "missing goal should remain 404 even for quiet PR-status probes").toBe(404);
	});
});
