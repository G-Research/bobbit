import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "./_e2e/in-process-harness.js";
import { copyGitTemplate } from "../harness/git-template.js";
import { apiFetch, createSession, registerProject, waitForSessionStatus } from "./_e2e/e2e-setup.js";
import { SandboxSessionFilesystem } from "../harness/sandbox-session-filesystem.js";

async function jsonResponse(response: Response): Promise<any> {
	const text = await response.text();
	return text ? JSON.parse(text) : {};
}

async function sessionRecord(id: string): Promise<any> {
	const response = await apiFetch("/api/sessions?include=archived");
	expect(response.status).toBe(200);
	const body = await jsonResponse(response);
	const record = body.sessions?.find((session: any) => session.id === id);
	expect(record, `session ${id} missing from list`).toBeTruthy();
	return record;
}

async function expectPromotionLifecycleConflict(response: Response): Promise<void> {
	expect(response.status).toBe(409);
	expect((await jsonResponse(response)).code).toBe("PROMOTED_SESSION_LIFECYCLE_CONFLICT");
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
		const legacyDraft = await (await apiFetch(`/api/sessions/${ownerId}/proposal/goal`)).text();
		expect(legacyDraft).not.toContain("worktreeMode:");

		const explicitNew = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/worktree-mode`, {
			method: "PUT",
			body: JSON.stringify({ mode: "new-worktree" }),
		});
		expect(explicitNew.status).toBe(200);
		expect((await jsonResponse(explicitNew)).mode).toBe("new-worktree");
		expect(await (await apiFetch(`/api/sessions/${ownerId}/proposal/goal`)).text()).toBe(legacyDraft);

		const selectCurrent = async () => apiFetch(`/api/sessions/${ownerId}/proposal/goal/worktree-mode`, {
			method: "PUT",
			body: JSON.stringify({ mode: "current-session" }),
		});
		const update = await selectCurrent();
		expect(update.status).toBe(200);
		expect((await jsonResponse(update)).mode).toBe("current-session");
		expect(await (await apiFetch(`/api/sessions/${ownerId}/proposal/goal`)).text()).toContain("worktreeMode: current-session");

		const resetToNew = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/worktree-mode`, {
			method: "PUT",
			body: JSON.stringify({ mode: "new-worktree" }),
		});
		expect(resetToNew.status).toBe(200);
		expect((await jsonResponse(resetToNew)).mode).toBe("new-worktree");
		expect(await (await apiFetch(`/api/sessions/${ownerId}/proposal/goal`)).text()).toBe(legacyDraft);
		expect((await selectCurrent()).status).toBe(200);

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

		const transcriptPath = gateway.sessionManager.getPersistedSession(ownerId)?.agentSessionFile;
		expect(transcriptPath).toBeTruthy();
		expect(fs.existsSync(transcriptPath)).toBe(true);
		const teamBeforeConflict = await jsonResponse(await apiFetch(`/api/goals/${goal.id}/team`));
		expect(teamBeforeConflict.teamLeadSessionId).toBe(ownerId);

		await expectPromotionLifecycleConflict(await apiFetch(`/api/sessions/${ownerId}`, {
			method: "PATCH",
			body: JSON.stringify({ title: "must-not-apply", archived: true }),
		}));
		await expectPromotionLifecycleConflict(await apiFetch(`/api/sessions/${ownerId}`, { method: "DELETE" }));
		await expectPromotionLifecycleConflict(await apiFetch(`/api/sessions/${ownerId}?purge=true`, { method: "DELETE" }));

		const preserved = await sessionRecord(ownerId);
		expect(preserved.archived).not.toBe(true);
		expect(preserved.title).toBe(after.title);
		expect(preserved.goalId).toBe(goal.id);
		expect(preserved.teamGoalId).toBe(goal.id);
		expect(preserved.worktreePath).toBe(before.worktreePath);
		expect(gateway.sessionManager.getPersistedSession(ownerId)?.agentSessionFile).toBe(transcriptPath);
		expect(fs.existsSync(transcriptPath)).toBe(true);
		expect(fs.readFileSync(staged, "utf8")).toBe("staged before promotion\n");
		expect(fs.readFileSync(untracked, "utf8")).toBe("untracked before promotion\n");
		expect(String((await runner.execFile("git", ["status", "--porcelain"], { cwd: worktree })).stdout)).toBe(statusBefore);
		const teamAfterConflict = await jsonResponse(await apiFetch(`/api/goals/${goal.id}/team`));
		expect(teamAfterConflict.teamLeadSessionId).toBe(ownerId);

		// Goal archival publishes the durable archived bit before team teardown, so
		// the same production guard now permits termination of the adopted source.
		const archivedGoalResponse = await apiFetch(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" });
		expect(archivedGoalResponse.status, await archivedGoalResponse.clone().text()).toBe(200);
		const archivedGoal = await jsonResponse(await apiFetch(`/api/goals/${goal.id}`));
		expect(archivedGoal.archived).toBe(true);
		expect((await apiFetch(`/api/goals/${goal.id}/team`)).status).toBe(404);
		expect((await sessionRecord(ownerId)).archived).toBe(true);

		const permittedPurge = await apiFetch(`/api/sessions/${ownerId}?purge=true`, { method: "DELETE" });
		expect(permittedPurge.status).toBe(200);
		const sessionsAfterPurge = await jsonResponse(await apiFetch("/api/sessions?include=archived"));
		expect(sessionsAfterPurge.sessions.some((session: any) => session.id === ownerId)).toBe(false);
	});

	test("probes a sandbox owner's transcript in its container realm before promotion", async ({ gateway, scope }) => {
		const projectRoot = path.join(gateway.bobbitDir, `promotion-sandbox-${randomUUID()}`);
		copyGitTemplate(projectRoot);
		const project = await registerProject({
			name: `promotion-sandbox-${Date.now()}`,
			rootPath: projectRoot,
			components: [{ name: "app", repo: "." }],
		});
		const ownerId = await createSession({ projectId: project.id, cwd: projectRoot });
		await waitForSessionStatus(ownerId, "idle", 30_000);

		const manager = gateway.sessionManager as any;
		const sandboxManager = manager.sandboxManager as any;
		const live = manager.getSession(ownerId) as any;
		const persisted = manager.getPersistedSession(ownerId) as any;
		expect(live).toBeTruthy();
		expect(persisted).toBeTruthy();

		const branch = `session/promotion-sandbox-${randomUUID().slice(0, 8)}`;
		const worktreePath = `/workspace-wt/${branch}`;
		const transcriptPath = `/home/node/.bobbit/agent/sessions/--workspace--/${ownerId}.jsonl`;
		const containerId = `promotion-container-${randomUUID()}`;
		const sandboxFs = new SandboxSessionFilesystem({
			root: path.join(gateway.bobbitDir, `promotion-container-fs-${randomUUID()}`),
			hostAgentSessionsDir: path.join(gateway.bobbitDir, "agent-sessions"),
		});
		const baseExec = sandboxFs.exec.bind(sandboxFs);
		const sandbox = sandboxFs as any;
		sandbox.getStatus = () => ({ status: "ready", projectId: project.id, containerId });
		sandbox.getContainerId = async () => containerId;
		sandbox.exec = async (args: string[]) => {
			if (args[0] === "git" && args[1] === "branch" && args[2] === "--show-current") return `${branch}\n`;
			if (args[0] === "git" && args[1] === "rev-parse" && args[2] === "--is-inside-work-tree") return "true\n";
			return baseExec(args);
		};

		const store = manager.getSessionStore(project.id);
		store.update(ownerId, {
			agentSessionFile: transcriptPath,
			cwd: worktreePath,
			worktreePath,
			repoPath: "/workspace",
			branch,
			sandboxed: true,
		});
		Object.assign(live, {
			cwd: worktreePath,
			worktreePath,
			repoPath: "/workspace",
			branch,
			sandboxed: true,
			containerId,
		});
		live.rpcClient.getState = async () => ({ success: true, data: { sessionFile: transcriptPath } });

		const originalGet = sandboxManager.get.bind(sandboxManager);
		const originalEnsure = sandboxManager.ensureForProject.bind(sandboxManager);
		const originalApplySandboxWiring = manager.applySandboxWiring.bind(manager);
		let provisioningCalls = 0;
		let acceptedGoalId: string | undefined;
		sandboxManager.get = (candidateProjectId: string) => candidateProjectId === project.id ? sandbox : originalGet(candidateProjectId);
		sandboxManager.ensureForProject = async () => { provisioningCalls += 1; throw new Error("promotion must not provision a sandbox"); };
		manager.applySandboxWiring = async (options: any) => {
			options.sandboxed = true;
			options.containerId = containerId;
			return true;
		};

		try {
			const seed = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/seed`, {
				method: "POST",
				body: JSON.stringify({
					args: {
						title: "Promote sandbox owner",
						spec: "Keep the exact sandbox session.",
						workflow: "general",
						projectId: project.id,
					},
				}),
			});
			expect(seed.status, await seed.clone().text()).toBe(200);

			const missing = await jsonResponse(await apiFetch(`/api/sessions/${ownerId}/proposal/goal/worktree-mode`));
			expect(missing.eligibility).toMatchObject({ eligible: false, code: "TRANSCRIPT_UNAVAILABLE" });
			expect(sandboxFs.calls.some(call => call.args[0] === "test" && call.args[1] === "-f" && call.args[2] === transcriptPath)).toBe(true);

			const transcriptHostPath = sandboxFs.hostPath(transcriptPath);
			fs.mkdirSync(path.dirname(transcriptHostPath), { recursive: true });
			fs.writeFileSync(transcriptHostPath, '{"type":"message","message":{"role":"user","content":"sandbox history"}}\n');

			const projection = await jsonResponse(await apiFetch(`/api/sessions/${ownerId}/proposal/goal/worktree-mode`));
			expect(projection.eligibility.eligible, JSON.stringify(projection)).toBe(true);
			expect(projection.eligibility.coordinates).toMatchObject({
				branch,
				worktreePath,
				sandboxed: true,
			});

			const selection = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/worktree-mode`, {
				method: "PUT",
				body: JSON.stringify({ mode: "current-session" }),
			});
			expect(selection.status, await selection.clone().text()).toBe(200);
			const sessionCountBefore = (await jsonResponse(await apiFetch("/api/sessions?include=archived"))).sessions
				.filter((session: any) => session.projectId === project.id).length;

			const accepted = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
				method: "POST",
				body: JSON.stringify({ title: "Promote sandbox owner", spec: "Keep the exact sandbox session." }),
			});
			expect(accepted.status, await accepted.clone().text()).toBe(201);
			const goal = await jsonResponse(accepted);
			acceptedGoalId = goal.id;
			scope.trackGoal(goal.id);

			const promoted = manager.getSession(ownerId);
			expect(promoted.id).toBe(ownerId);
			expect(promoted.containerId).toBe(containerId);
			expect(promoted.worktreePath).toBe(worktreePath);
			expect(promoted.branch).toBe(branch);
			expect(manager.getPersistedSession(ownerId).agentSessionFile).toBe(transcriptPath);
			expect(goal).toMatchObject({
				worktreeOwnerSessionId: ownerId,
				worktreePath,
				branch,
				sandboxed: true,
			});
			const sessionCountAfter = (await jsonResponse(await apiFetch("/api/sessions?include=archived"))).sessions
				.filter((session: any) => session.projectId === project.id).length;
			expect(sessionCountAfter).toBe(sessionCountBefore);
			expect(provisioningCalls).toBe(0);
			expect(sandboxFs.calls.some(call => call.args[0] === "mkdir" || (call.args[0] === "git" && call.args.includes("worktree")))).toBe(false);

			const archived = await apiFetch(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" });
			expect(archived.status, await archived.clone().text()).toBe(200);
			acceptedGoalId = undefined;
			const purged = await apiFetch(`/api/sessions/${ownerId}?purge=true`, { method: "DELETE" });
			expect(purged.status, await purged.clone().text()).toBe(200);
		} finally {
			if (acceptedGoalId) {
				await apiFetch(`/api/goals/${acceptedGoalId}?cascade=true`, { method: "DELETE" }).catch(() => undefined);
				await apiFetch(`/api/sessions/${ownerId}?purge=true`, { method: "DELETE" }).catch(() => undefined);
			}
			manager.applySandboxWiring = originalApplySandboxWiring;
			sandboxManager.ensureForProject = originalEnsure;
			sandboxManager.get = originalGet;
		}
	});
});
