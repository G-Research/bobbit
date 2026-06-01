import { test, expect } from "./in-process-harness.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentEndPredicate,
	apiFetch,
	connectWs,
	createGoal,
	createSession,
	defaultProjectId,
	deleteGoal,
	deleteSession,
	gitCwd,
	nonGitCwd,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

async function json(resp: Response): Promise<any> {
	return resp.json().catch(() => ({}));
}

// Fork clones the source transcript, so the source needs a non-empty `.jsonl`
// before forking. Driving one prompt to completion populates `agentSessionFile`.
async function sendPromptAndWait(id: string, text: string): Promise<void> {
	const ws = await connectWs(id);
	try {
		ws.send({ type: "prompt", text });
		await ws.waitFor(agentEndPredicate(), 10_000);
	} finally {
		ws.close();
	}
}

async function getPersisted(id: string): Promise<any> {
	const r = await apiFetch(`/api/sessions/${id}?include=archived`);
	if (!r.ok) return null;
	return r.json();
}

async function waitUntilReady(id: string): Promise<any> {
	return pollUntil(async () => {
		const rec = await getPersisted(id);
		return rec && rec.status !== "preparing" && rec.status !== "starting" ? rec : null;
	}, { timeoutMs: 30_000, intervalMs: 150, label: `session ${id} left preparing` });
}

// Fork's worktree-choice test allocates a real worktree; disable the warm pool
// file-wide for deterministic branch/path assertions. Must be top-level —
// Playwright forbids `test.use({ enableWorktreePool })` inside a describe.
test.use({ enableWorktreePool: false });

test.describe.configure({ mode: "serial" });

test.describe("sidebar actions server endpoints", () => {
	test("POST /api/sessions/:id/fork clones the source transcript, preserves metadata, and rejects unsupported sources", async ({ gateway }) => {
		const sourceId = await createSession();
		let forkId: string | undefined;
		try {
			await apiFetch(`/api/sessions/${sourceId}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "Source session" }),
			});
			gateway.sessionManager.persistSessionModel(sourceId, "openai", "gpt-4.1");
			await sendPromptAndWait(sourceId, "FORK_SOURCE_MARKER hello from the original session");

			const resp = await apiFetch(`/api/sessions/${sourceId}/fork`, {
				method: "POST",
				body: JSON.stringify({ newWorktree: false }),
			});
			expect(resp.status).toBe(201);
			const body = await resp.json();
			forkId = body.id;
			expect(body.id).toBeTruthy();
			expect(body.id).not.toBe(sourceId);
			expect(body.cwd).toBeTruthy();
			// Finding 1: a non-worktree source forked with newWorktree=false keeps its
			// own cwd instead of landing in the project root.
			const srcPs = gateway.sessionManager.getPersistedSession(sourceId);
			expect(srcPs?.worktreePath).toBeFalsy();
			expect(srcPs?.cwd).toBeTruthy();
			expect(body.cwd).toBe(srcPs!.cwd);
			expect(body.status).toBeTruthy();
			expect(body.projectId).toBe(await defaultProjectId());
			expect(body.title).toBe("Fork: Source session");

			const dup = await waitUntilReady(forkId!);
			expect(dup.title).toBe("Fork: Source session");
			expect(dup.modelProvider).toBe("openai");
			expect(dup.modelId).toBe("gpt-4.1");
			// The fork rehydrates from the cloned transcript: reaching a non-preparing
			// status above means `switch_session` adopted the clone, and the session
			// now owns a real `.jsonl` on disk.
			const forkPs = gateway.sessionManager.getPersistedSession(forkId!);
			expect(forkPs?.agentSessionFile).toBeTruthy();
			expect(existsSync(forkPs!.agentSessionFile!)).toBe(true);

			const childId = await createSession();
			try {
				await apiFetch(`/api/sessions/${childId}`, {
					method: "PATCH",
					body: JSON.stringify({ delegateOf: sourceId }),
				});
				const rejected = await apiFetch(`/api/sessions/${childId}/fork`, { method: "POST", body: "{}" });
				expect(rejected.status).toBe(422);
				expect((await json(rejected)).error).toContain("delegate");
			} finally {
				await deleteSession(childId);
			}

			const archivedId = await createSession();
			await deleteSession(archivedId);
			const archivedRejected = await apiFetch(`/api/sessions/${archivedId}/fork`, { method: "POST", body: "{}" });
			expect(archivedRejected.status).toBe(422);
			expect((await json(archivedRejected)).error).toContain("archived");

			// Finding 2: non-interactive sources are rejected, matching the client
			// `canForkSidebarSession` guard that hides Fork for `session.nonInteractive`.
			const nonInteractiveId = await createSession();
			try {
				gateway.sessionManager.getSessionStore(await defaultProjectId()).update(nonInteractiveId, { nonInteractive: true });
				const niRejected = await apiFetch(`/api/sessions/${nonInteractiveId}/fork`, { method: "POST", body: "{}" });
				expect(niRejected.status).toBe(422);
				expect((await json(niRejected)).error).toContain("non-interactive");
			} finally {
				await deleteSession(nonInteractiveId);
			}
		} finally {
			if (forkId) await deleteSession(forkId);
			await deleteSession(sourceId);
		}
	});

	test("POST /api/sessions/:id/fork preserves persisted goal/task context", async ({ gateway }) => {
		const goal = await createGoal({ title: `sidebar task fork ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		let sourceId: string | undefined;
		let forkId: string | undefined;
		try {
			const taskResp = await apiFetch(`/api/goals/${goal.id}/tasks`, {
				method: "POST",
				body: JSON.stringify({ title: "Fork task context", type: "implementation" }),
			});
			expect(taskResp.status).toBe(201);
			const task = await taskResp.json();

			sourceId = await createSession({ goalId: goal.id, projectId: goal.projectId as string });
			const assignResp = await apiFetch(`/api/tasks/${task.id}/assign`, {
				method: "POST",
				body: JSON.stringify({ sessionId: sourceId }),
			});
			expect(assignResp.status).toBe(200);

			gateway.sessionManager.getSessionStore(goal.projectId as string).update(sourceId, { taskId: task.id });
			expect(gateway.sessionManager.getPersistedSession(sourceId)?.taskId).toBe(task.id);
			await sendPromptAndWait(sourceId, "FORK_GOAL_MARKER acknowledge please");

			const resp = await apiFetch(`/api/sessions/${sourceId}/fork`, {
				method: "POST",
				body: JSON.stringify({ newWorktree: false }),
			});
			expect(resp.status).toBe(201);
			const respBody = await resp.json();
			forkId = respBody.id;
			expect(respBody.goalId).toBe(goal.id);

			const dup = await waitUntilReady(forkId!);
			expect(dup.goalId).toBe(goal.id);
			expect(dup.taskId).toBe(task.id);
			const forkPs = gateway.sessionManager.getPersistedSession(forkId!);
			expect(forkPs?.taskId).toBe(task.id);
			expect(forkPs?.agentSessionFile).toBeTruthy();
			expect(existsSync(forkPs!.agentSessionFile!)).toBe(true);
		} finally {
			if (forkId) await deleteSession(forkId);
			if (sourceId) await deleteSession(sourceId);
			await deleteGoal(goal.id);
		}
	});

	test("GET /api/goals/:id/github-link returns PR, branch fallback, and unavailable states", async ({ gateway }) => {
		const prGoal = await createGoal({ title: `sidebar pr ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		const noBranchGoal = await createGoal({ title: `sidebar no branch ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		const branchGoal = await createGoal({ title: `sidebar branch ${Date.now()}`, cwd: nonGitCwd(), worktree: false, team: false });
		try {
			gateway.sessionManager.prStatusStore.set(prGoal.id, { state: "OPEN", url: "https://github.com/acme/widget/pull/123" });
			const prResp = await apiFetch(`/api/goals/${prGoal.id}/github-link`);
			expect(prResp.status).toBe(200);
			expect(await prResp.json()).toMatchObject({ available: true, kind: "pr", url: "https://github.com/acme/widget/pull/123" });

			const noBranchResp = await apiFetch(`/api/goals/${noBranchGoal.id}/github-link`);
			expect(noBranchResp.status).toBe(200);
			expect(await noBranchResp.json()).toMatchObject({ available: false, reason: "no-branch" });

			const missingResp = await apiFetch(`/api/goals/does-not-exist/github-link`);
			expect(missingResp.status).toBe(200);
			expect(await missingResp.json()).toMatchObject({ available: false, reason: "goal-not-found" });

			const repo = gitCwd();
			try { execFileSync("git", ["remote", "remove", "origin"], { cwd: repo, stdio: "ignore" }); } catch { /* ignore */ }
			execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], { cwd: repo, stdio: "pipe" });
			const branch = "feature/sidebar-actions";
			gateway.sessionManager.getGoalStoreForProject(branchGoal.projectId).update(branchGoal.id, { branch, repoPath: repo, cwd: repo });
			const branchResp = await apiFetch(`/api/goals/${branchGoal.id}/github-link`);
			expect(branchResp.status).toBe(200);
			expect(await branchResp.json()).toMatchObject({
				available: true,
				kind: "branch",
				url: "https://github.com/acme/widget/tree/feature%2Fsidebar-actions",
			});
		} finally {
			await deleteGoal(prGoal.id);
			await deleteGoal(noBranchGoal.id);
			await deleteGoal(branchGoal.id);
		}
	});
});

// Fork's worktree choice needs a real git-repo-backed project so newWorktree=true
// can allocate a distinct worktree/branch and newWorktree=false can reuse the
// source session's worktree path.
test.describe("fork worktree choice", () => {
	let repoPath: string;
	let projectId: string;

	test.beforeAll(async () => {
		const base = realpathSync(tmpdir()) + `/bobbit-e2e-fork-wt-${process.pid}-${Date.now()}`;
		repoPath = join(base, "repo");
		mkdirSync(repoPath, { recursive: true });
		execFileSync("git", ["init", "--initial-branch=master"], { cwd: repoPath });
		execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoPath });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repoPath });
		execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoPath });

		const reg = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `fork-wt-project-${Date.now()}`, rootPath: repoPath }),
		});
		expect(reg.status).toBe(201);
		projectId = (await reg.json()).id;
	});

	test("newWorktree=true allocates a distinct worktree/branch; newWorktree=false reuses the source worktree", async ({ gateway }) => {
		const created: string[] = [];
		const sresp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: repoPath, worktree: true, projectId }),
		});
		expect(sresp.status).toBe(201);
		const sourceId = (await sresp.json()).id;
		created.push(sourceId);
		try {
			const srcRec = await waitUntilReady(sourceId);
			expect(srcRec.worktreePath).toBeTruthy();
			expect(srcRec.cwd).toBe(srcRec.worktreePath);
			await sendPromptAndWait(sourceId, "FORK_WT_MARKER hello from worktree");

			// newWorktree=true → fresh worktree + branch, distinct from the source.
			const trueResp = await apiFetch(`/api/sessions/${sourceId}/fork`, {
				method: "POST",
				body: JSON.stringify({ newWorktree: true }),
			});
			expect(trueResp.status).toBe(201);
			const trueBody = await trueResp.json();
			created.push(trueBody.id);
			expect(trueBody.title).toMatch(/^Fork: /);

			const freshRec = await waitUntilReady(trueBody.id);
			expect(freshRec.archived).toBeFalsy();
			expect(freshRec.worktreePath).toBeTruthy();
			expect(freshRec.worktreePath).not.toBe(srcRec.worktreePath);
			expect(freshRec.cwd).toBe(freshRec.worktreePath);
			expect(freshRec.branch).toMatch(/^session\//);
			expect(freshRec.branch).not.toBe(srcRec.branch);
			const freshPs = gateway.sessionManager.getPersistedSession(trueBody.id);
			expect(freshPs?.agentSessionFile).toBeTruthy();
			expect(existsSync(freshPs!.agentSessionFile!)).toBe(true);

			// newWorktree=false → reuse the source session's existing worktree path,
			// with no new worktree registered on the fork (shared tree).
			const reuseResp = await apiFetch(`/api/sessions/${sourceId}/fork`, {
				method: "POST",
				body: JSON.stringify({ newWorktree: false }),
			});
			expect(reuseResp.status).toBe(201);
			const reuseBody = await reuseResp.json();
			created.push(reuseBody.id);
			expect(reuseBody.cwd).toBe(srcRec.worktreePath);

			const reuseRec = await waitUntilReady(reuseBody.id);
			expect(reuseRec.cwd).toBe(srcRec.worktreePath);
			expect(reuseRec.worktreePath).toBeFalsy();
			const reusePs = gateway.sessionManager.getPersistedSession(reuseBody.id);
			expect(reusePs?.agentSessionFile).toBeTruthy();
			expect(existsSync(reusePs!.agentSessionFile!)).toBe(true);
		} finally {
			for (const id of created) await deleteSession(id);
		}
	});
});
