import { test, expect } from "./in-process-harness.js";
import { execFileSync } from "node:child_process";
import { apiFetch, createGoal, createSession, defaultProjectId, deleteGoal, deleteSession, gitCwd, nonGitCwd } from "./e2e-setup.js";

async function json(resp: Response): Promise<any> {
	return resp.json().catch(() => ({}));
}

test.describe.configure({ mode: "serial" });

test.describe("sidebar actions server endpoints", () => {
	test("POST /api/sessions/:id/duplicate copies live plain session metadata and rejects unsupported sources", async ({ gateway }) => {
		const sourceId = await createSession();
		let duplicateId: string | undefined;
		try {
			await apiFetch(`/api/sessions/${sourceId}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "Source session" }),
			});
			gateway.sessionManager.persistSessionModel(sourceId, "openai", "gpt-4.1");

			const resp = await apiFetch(`/api/sessions/${sourceId}/duplicate`, { method: "POST" });
			expect(resp.status).toBe(201);
			const body = await resp.json();
			duplicateId = body.id;
			expect(body.id).toBeTruthy();
			expect(body.id).not.toBe(sourceId);
			expect(body.cwd).toBeTruthy();
			expect(body.status).toBe("idle");
			expect(body.projectId).toBe(await defaultProjectId());

			const dupResp = await apiFetch(`/api/sessions/${duplicateId}`);
			expect(dupResp.status).toBe(200);
			const dup = await dupResp.json();
			expect(dup.title).toBe("Copy of Source session");
			expect(dup.modelProvider).toBe("openai");
			expect(dup.modelId).toBe("gpt-4.1");

			const childId = await createSession();
			try {
				await apiFetch(`/api/sessions/${childId}`, {
					method: "PATCH",
					body: JSON.stringify({ delegateOf: sourceId }),
				});
				const rejected = await apiFetch(`/api/sessions/${childId}/duplicate`, { method: "POST" });
				expect(rejected.status).toBe(422);
				expect((await json(rejected)).error).toContain("delegate");
			} finally {
				await deleteSession(childId);
			}

			const archivedId = await createSession();
			await deleteSession(archivedId);
			const archivedRejected = await apiFetch(`/api/sessions/${archivedId}/duplicate`, { method: "POST" });
			expect(archivedRejected.status).toBe(422);
			expect((await json(archivedRejected)).error).toContain("archived");
		} finally {
			if (duplicateId) await deleteSession(duplicateId);
			await deleteSession(sourceId);
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
