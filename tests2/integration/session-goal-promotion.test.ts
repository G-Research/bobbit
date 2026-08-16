import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "./_e2e/in-process-harness.js";
import { copyGitTemplate } from "../harness/git-template.js";
import { apiFetch, createSession, registerProject, waitForSessionStatus } from "./_e2e/e2e-setup.js";

async function jsonResponse(response: Response): Promise<any> {
	const text = await response.text();
	return text ? JSON.parse(text) : {};
}

async function sessionRecord(id: string): Promise<any> {
	const response = await apiFetch(`/api/sessions/${id}?include=archived`);
	expect(response.status).toBe(200);
	return jsonResponse(response);
}

test.describe("current-session goal promotion API", () => {
	test("persists owner mode, rejects authority, and promotes exactly in place", async ({ gateway, scope }) => {
		const projectRoot = path.join(gateway.bobbitDir, `promotion-api-${randomUUID()}`);
		copyGitTemplate(projectRoot);
		const project = await registerProject({
			name: `promotion-api-${Date.now()}`,
			rootPath: projectRoot,
			components: [{ name: "app", repo: "." }],
			workflows: {
				general: {
					name: "General",
					description: "Promotion integration fixture",
					gates: [{ id: "implementation", name: "Implementation", depends_on: [] }],
				},
			},
		});
		const ownerId = await createSession({ projectId: project.id, cwd: projectRoot });
		await waitForSessionStatus(ownerId, "idle", 30_000);
		const before = await sessionRecord(ownerId);
		expect(before.worktreePath).toBeTruthy();
		expect(before.branch).toBeTruthy();

		const seed = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/seed`, {
			method: "POST",
			body: JSON.stringify({
				args: {
					title: "Promote API owner",
					spec: "Keep the exact session checkout.",
					workflow: "general",
					projectId: ownerId && before.projectId,
				},
			}),
		});
		expect(seed.status, await seed.text()).toBe(200);

		const initialBody = await jsonResponse(await apiFetch(`/api/sessions/${ownerId}/proposal/goal/worktree-mode`));
		expect(initialBody.mode).toBe("new-worktree");
		expect(initialBody.eligibility.eligible, JSON.stringify(initialBody)).toBe(true);
		expect(initialBody.eligibility.coordinates.branch).toBe(before.branch);
		expect(initialBody.eligibility.coordinates.worktreePath).toBe(before.worktreePath);

		const update = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/worktree-mode`, {
			method: "PUT",
			body: JSON.stringify({ mode: "current-session" }),
		});
		expect(update.status).toBe(200);
		expect((await jsonResponse(update)).mode).toBe("current-session");
		const rawDraft = await (await apiFetch(`/api/sessions/${ownerId}/proposal/goal`)).text();
		expect(rawDraft).toContain("worktreeMode: current-session");

		const rejected = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
			method: "POST",
			body: JSON.stringify({ title: "Attack", branch: "attacker/branch", worktreePath: "/tmp/attacker" }),
		});
		expect(rejected.status).toBe(400);
		expect((await jsonResponse(rejected)).code).toBe("PROMOTION_AUTHORITY_REJECTED");

		const runner = gateway.sessionManager.commandRunner;
		const worktree = before.worktreePath as string;
		const staged = path.join(worktree, "promotion-staged.txt");
		const untracked = path.join(worktree, "promotion-untracked.txt");
		fs.writeFileSync(staged, "staged before promotion\n");
		fs.writeFileSync(untracked, "untracked before promotion\n");
		await runner.execFile("git", ["add", path.basename(staged)], { cwd: worktree });
		const statusBefore = String((await runner.execFile("git", ["status", "--porcelain"], { cwd: worktree })).stdout);

		const accepted = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
			method: "POST",
			body: JSON.stringify({ title: "Promote API owner", spec: "Keep the exact session checkout." }),
		});
		expect(accepted.status, await accepted.clone().text()).toBe(201);
		const goal = await jsonResponse(accepted);
		scope.trackGoal(goal.id);
		expect(goal.worktreeOwnerSessionId).toBe(ownerId);
		expect(goal.worktreePath).toBe(before.worktreePath);
		expect(goal.branch).toBe(before.branch);
		expect(goal.setupStatus).toBe("ready");

		const after = await sessionRecord(ownerId);
		expect(after.id).toBe(ownerId);
		expect(after.goalId).toBe(goal.id);
		expect(after.teamGoalId).toBe(goal.id);
		expect(after.role).toBe("team-lead");
		expect(after.worktreePath).toBe(before.worktreePath);
		expect(after.branch).toBe(before.branch);
		expect(fs.readFileSync(staged, "utf8")).toBe("staged before promotion\n");
		expect(fs.readFileSync(untracked, "utf8")).toBe("untracked before promotion\n");
		expect(String((await runner.execFile("git", ["status", "--porcelain"], { cwd: worktree })).stdout)).toBe(statusBefore);

		const retry = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
			method: "POST",
			body: JSON.stringify({ title: "Promote API owner", spec: "retry" }),
		});
		expect(retry.status).toBe(201);
		expect((await jsonResponse(retry)).id).toBe(goal.id);
		const goalsBody = await jsonResponse(await apiFetch("/api/goals"));
		const goals = Array.isArray(goalsBody) ? goalsBody : goalsBody.goals;
		expect(goals.filter((candidate: any) => candidate.worktreeOwnerSessionId === ownerId)).toHaveLength(1);
		expect((await apiFetch(`/api/sessions/${ownerId}/proposal/goal`)).status).toBe(404);
	});
});
