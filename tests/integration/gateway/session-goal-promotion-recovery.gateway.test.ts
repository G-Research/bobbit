import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "./_helpers/e2e/in-process-harness.js";
import { copyGitTemplate } from "../../support/harnesses/shared/git-template.js";
import { apiFetch as harnessApiFetch, createSession, rawApiFetch, registerProject, waitForSessionStatus } from "./_helpers/e2e/e2e-setup.js";
import { SandboxSessionFilesystem } from "../../support/harnesses/shared/sandbox-session-filesystem.js";
import { readAuthorSidecar } from "../../../src/server/agent/author-sidecar.js";
import { sessionTranscriptHostPath } from "../../../src/server/agent/agent-session-path.js";

let operatorCookie: string | undefined;

async function authenticatedOperatorCookie(): Promise<string> {
	const response = await rawApiFetch("/api/goals", {
		headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
	});
	const setCookies = (response.headers as any).getSetCookie?.() as string[] | undefined
		?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") as string] : []);
	return setCookies.map(cookie => cookie.split(";")[0])
		.find(cookie => cookie.startsWith("bobbit_session=")) ?? "";
}

async function apiFetch(requestPath: string, opts: RequestInit = {}): Promise<Response> {
	const method = (opts.method ?? "GET").toUpperCase();
	const requiresOperatorCookie = (/^\/api\/sessions\/[^/]+\/proposal\//.test(requestPath)
		&& (method === "POST" || method === "PUT" || method === "DELETE"))
		|| (method === "POST" && /^\/api\/goals\/[^/]+\/(pause|resume)$/.test(requestPath));
	if (!requiresOperatorCookie) return harnessApiFetch(requestPath, opts);
	operatorCookie ??= await authenticatedOperatorCookie();
	return harnessApiFetch(requestPath, {
		...opts,
		headers: { ...(opts.headers as Record<string, string> | undefined), Cookie: operatorCookie },
	});
}

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

function promotionKickoff(title: string): string {
	return `You have been promoted to the team lead for the goal "${title}".  Proceed to complete the goal, following the instructions in your system prompt carefully.`;
}

function transcriptTextOccurrences(transcriptPath: string, text: string): number {
	const escapedText = JSON.stringify(text).slice(1, -1);
	return fs.readFileSync(transcriptPath, "utf8").split(escapedText).length - 1;
}

async function createPromotionCandidate(gateway: any, label: string): Promise<{
	ownerId: string;
	context: any;
}> {
	const projectRoot = path.join(gateway.bobbitDir, `promotion-${label}-${randomUUID()}`);
	copyGitTemplate(projectRoot);
	const project = await registerProject({
		name: `promotion-${label}-${Date.now()}`,
		rootPath: projectRoot,
		components: [{ name: "app", repo: "." }],
		workflows: {
			"promotion-flow": {
				name: "Promotion Flow",
				description: "Promotion compensation fixture",
				gates: [{ id: "implementation", name: "Implementation", depends_on: [] }],
			},
		},
	});
	const ownerId = await createSession({ projectId: project.id, cwd: projectRoot });
	await waitForSessionStatus(ownerId, "idle", 30_000);
	const seeded = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/seed`, {
		method: "POST",
		body: JSON.stringify({
			args: {
				title: `Promote ${label.slice(0, 18)}`,
				spec: "Exercise promotion compensation.",
				workflow: "promotion-flow",
				projectId: project.id,
			},
		}),
	});
	expect(seeded.status, await seeded.clone().text()).toBe(200);
	const selected = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/worktree-mode`, {
		method: "PUT",
		body: JSON.stringify({ mode: "current-session" }),
	});
	expect(selected.status, await selected.clone().text()).toBe(200);
	return {
		ownerId,
		context: gateway.projectContextManager.getOrCreate(project.id),
	};
}

test.describe("current-session goal promotion recovery and ownership continuity", () => {
	test("retains the recoverable goal, gates, and lead when reservation release is refused", async ({ gateway, scope }) => {
		const { ownerId, context } = await createPromotionCandidate(gateway, "refused-compensation");
		const teamManager = gateway.teamManager as any;
		const sessionManager = gateway.sessionManager as any;
		const originalRelease = teamManager.releaseAdoptedLead;
		const originalPromote = sessionManager.promoteToGoalLead;
		teamManager.releaseAdoptedLead = async () => false;
		sessionManager.promoteToGoalLead = async () => {
			throw new Error("forced pre-commit promotion failure");
		};

		let failed: Response;
		try {
			failed = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
				method: "POST",
				body: JSON.stringify({ title: "Promote refused compensation" }),
			});
		} finally {
			teamManager.releaseAdoptedLead = originalRelease;
			sessionManager.promoteToGoalLead = originalPromote;
		}
		expect(failed!.status).toBe(400);
		const retainedGoals = context.goalStore.getAll()
			.filter((goal: any) => goal.worktreeOwnerSessionId === ownerId && !goal.archived);
		expect(retainedGoals).toHaveLength(1);
		const retainedGoal = retainedGoals[0];
		expect(context.gateStore.getGatesForGoal(retainedGoal.id)).toHaveLength(1);
		expect(gateway.teamManager.getTeamState(retainedGoal.id)).toMatchObject({
			teamLeadSessionId: ownerId,
			agents: [],
		});
		expect(await sessionRecord(ownerId)).toMatchObject({ role: "general" });

		const retry = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
			method: "POST",
			body: JSON.stringify({ title: "Promote refused compensation" }),
		});
		expect(retry.status, await retry.clone().text()).toBe(201);
		const retriedGoal = await jsonResponse(retry);
		scope.trackGoal(retriedGoal.id);
		expect(retriedGoal.id).toBe(retainedGoal.id);
		expect(context.gateStore.getGatesForGoal(retainedGoal.id)).toHaveLength(1);
		expect(await sessionRecord(ownerId)).toMatchObject({
			goalId: retainedGoal.id,
			teamGoalId: retainedGoal.id,
			role: "team-lead",
		});
	});

	test("keeps a committed lead attached when finalization fails, then finalizes the exact goal on retry", async ({ gateway, scope }) => {
		const { ownerId, context } = await createPromotionCandidate(gateway, "finalizer-retry");
		const teamManager = gateway.teamManager as any;
		const transcriptPath = gateway.sessionManager.getPersistedSession(ownerId)?.agentSessionFile as string;
		expect(transcriptPath).toBeTruthy();
		const originalFinalize = teamManager.finalizeAdoptedLead;
		let finalizeCalls = 0;
		teamManager.finalizeAdoptedLead = async () => {
			finalizeCalls += 1;
			throw new Error("forced post-commit finalizer failure");
		};

		let failed: Response;
		try {
			failed = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
				method: "POST",
				body: JSON.stringify({ title: "Promote finalizer retry" }),
			});
		} finally {
			teamManager.finalizeAdoptedLead = originalFinalize;
		}
		expect(failed!.status).toBe(400);
		expect(finalizeCalls).toBe(1);
		const retained = context.goalStore.getAll().filter((goal: any) => goal.worktreeOwnerSessionId === ownerId && !goal.archived);
		expect(retained).toHaveLength(1);
		const goal = retained[0];
		scope.trackGoal(goal.id);
		expect(goal.state).toBe("todo");
		expect(await sessionRecord(ownerId)).toMatchObject({
			goalId: goal.id,
			teamGoalId: goal.id,
			role: "team-lead",
		});
		expect(gateway.teamManager.getTeamState(goal.id)).toMatchObject({ teamLeadSessionId: ownerId, agents: [] });
		expect((await apiFetch(`/api/sessions/${ownerId}/proposal/goal`)).status).toBe(200);
		expect(transcriptTextOccurrences(transcriptPath, promotionKickoff(goal.title)), "failed finalization must not dispatch before the goal is in progress").toBe(0);

		const paused = await apiFetch(`/api/goals/${goal.id}/pause`, {
			method: "POST",
			body: JSON.stringify({ cascade: false }),
		});
		expect(paused.status, await paused.clone().text()).toBe(200);
		expect(context.goalStore.get(goal.id)?.paused).toBe(true);
		const pausedLive = gateway.sessionManager.getSession(ownerId) as any;
		const transcriptBeforePausedRetry = fs.readFileSync(transcriptPath, "utf8");
		const queueBeforePausedRetry = structuredClone(pausedLive.promptQueue.toArray());
		const durableQueueBeforePausedRetry = structuredClone(gateway.sessionManager.getPersistedSession(ownerId)?.messageQueue ?? []);
		const authorSidecarBeforePausedRetry = structuredClone(readAuthorSidecar(ownerId));
		const statusBeforePausedRetry = pausedLive.status;
		const activityBeforePausedRetry = gateway.sessionManager.getPersistedSession(ownerId)?.lastActivity;

		const pausedRetry = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
			method: "POST",
			body: JSON.stringify({ title: "Promote finalizer retry" }),
		});
		expect(pausedRetry.status).toBe(409);
		expect(await jsonResponse(pausedRetry)).toMatchObject({ code: "GOAL_PAUSED", goalId: goal.id });
		expect(fs.readFileSync(transcriptPath, "utf8")).toBe(transcriptBeforePausedRetry);
		expect(pausedLive.promptQueue.toArray()).toEqual(queueBeforePausedRetry);
		expect(gateway.sessionManager.getPersistedSession(ownerId)?.messageQueue ?? []).toEqual(durableQueueBeforePausedRetry);
		expect(readAuthorSidecar(ownerId)).toEqual(authorSidecarBeforePausedRetry);
		expect(pausedLive.status).toBe(statusBeforePausedRetry);
		expect(gateway.sessionManager.getPersistedSession(ownerId)?.lastActivity).toBe(activityBeforePausedRetry);

		const resumed = await apiFetch(`/api/goals/${goal.id}/resume`, {
			method: "POST",
			body: JSON.stringify({ cascade: false }),
		});
		expect(resumed.status, await resumed.clone().text()).toBe(200);
		expect(context.goalStore.get(goal.id)?.paused).toBe(false);

		const retry = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
			method: "POST",
			body: JSON.stringify({ title: "Promote finalizer retry" }),
		});
		expect(retry.status, await retry.clone().text()).toBe(201);
		expect((await jsonResponse(retry)).id).toBe(goal.id);
		expect(context.goalStore.get(goal.id)?.state).toBe("in-progress");
		expect(gateway.teamManager.getTeamState(goal.id)).toMatchObject({ teamLeadSessionId: ownerId, agents: [] });
		expect(context.goalStore.getAll().filter((candidate: any) => candidate.worktreeOwnerSessionId === ownerId)).toHaveLength(1);
		expect((await apiFetch(`/api/sessions/${ownerId}/proposal/goal`)).status).toBe(404);
		await expect.poll(
			() => transcriptTextOccurrences(transcriptPath, promotionKickoff(goal.title)),
			{ timeout: 10_000, interval: 100, message: "retry finalization must append exactly one durable kickoff" },
		).toBe(1);

		await waitForSessionStatus(ownerId, "idle", 30_000);
		const exactRetry = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
			method: "POST",
			body: JSON.stringify({ title: "Promote finalizer retry" }),
		});
		expect(exactRetry.status, await exactRetry.clone().text()).toBe(201);
		await gateway.teamManager.finalizeAdoptedLead(goal.id, { coldStart: true });
		expect(transcriptTextOccurrences(transcriptPath, promotionKickoff(goal.title))).toBe(1);
		expect(readAuthorSidecar(ownerId).filter(binding => binding.intentId === `promotion-kickoff:${goal.id}`)).toHaveLength(1);
	});

	test("preserves a real two-component worktree set through archive and removes it on final purge", async ({ gateway }) => {
		const projectRoot = path.join(gateway.bobbitDir, `promotion-multi-${randomUUID()}`);
		fs.mkdirSync(projectRoot, { recursive: true });
		copyGitTemplate(path.join(projectRoot, "alpha"));
		copyGitTemplate(path.join(projectRoot, "packages", "beta"));
		const project = await registerProject({
			name: `promotion-multi-${Date.now()}`,
			rootPath: projectRoot,
			components: [
				{ name: "alpha", repo: "alpha" },
				{ name: "beta", repo: "packages/beta" },
			],
			workflows: {
				general: {
					name: "General",
					description: "Multi-repo promotion fixture",
					gates: [{ id: "implementation", name: "Implementation", depends_on: [] }],
				},
			},
		});
		const ownerId = await createSession({ projectId: project.id, cwd: projectRoot });
		await waitForSessionStatus(ownerId, "idle", 30_000);
		const before = await sessionRecord(ownerId);
		const repoWorktrees = before.repoWorktrees as Record<string, string>;
		expect(Object.keys(repoWorktrees).sort()).toEqual(["alpha", "packages/beta"]);
		const componentPaths = Object.values(repoWorktrees);
		for (const componentPath of componentPaths) expect(fs.existsSync(componentPath)).toBe(true);
		expect(fs.existsSync(path.join(before.worktreePath, ".git"))).toBe(false);

		const seed = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/seed`, {
			method: "POST",
			body: JSON.stringify({ args: {
				title: "Promote multi-repo owner",
				spec: "Keep both component worktrees.",
				workflow: "general",
				projectId: project.id,
			} }),
		});
		expect(seed.status, await seed.clone().text()).toBe(200);
		const selected = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/worktree-mode`, {
			method: "PUT",
			body: JSON.stringify({ mode: "current-session" }),
		});
		expect(selected.status, await selected.clone().text()).toBe(200);
		const accepted = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
			method: "POST",
			body: JSON.stringify({ title: "Promote multi-repo owner" }),
		});
		expect(accepted.status, await accepted.clone().text()).toBe(201);
		const goal = await jsonResponse(accepted);
		expect(goal.repoWorktrees).toEqual(repoWorktrees);
		expect((await sessionRecord(ownerId)).repoWorktrees).toEqual(repoWorktrees);

		const archived = await apiFetch(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" });
		expect(archived.status, await archived.clone().text()).toBe(200);
		for (const componentPath of componentPaths) expect(fs.existsSync(componentPath)).toBe(true);
		expect(fs.existsSync(before.worktreePath)).toBe(true);
		const inventory = await jsonResponse(await apiFetch("/api/maintenance/archived-session-worktrees?includeAlreadyCleaned=1"));
		const archivedSource = inventory.sessions.find((session: any) => session.id === ownerId);
		expect(archivedSource?.worktrees).toHaveLength(2);
		expect(new Set(archivedSource.worktrees.map((item: any) => item.path))).toEqual(new Set(componentPaths));
		expect(archivedSource.worktrees.every((item: any) => item.disposition !== "protected")).toBe(true);

		const purged = await apiFetch(`/api/sessions/${ownerId}?purge=true`, { method: "DELETE" });
		expect(purged.status, await purged.clone().text()).toBe(200);
		for (const componentPath of componentPaths) expect(fs.existsSync(componentPath)).toBe(false);
		expect(fs.existsSync(before.worktreePath)).toBe(false);
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
			expect(sandboxFs.calls.some(call => call.args[0] === "test" && call.args[1] === "-f" && call.args[2] === transcriptPath)).toBe(false);

			const transcriptHostPath = sessionTranscriptHostPath(ownerId, transcriptPath);
			expect(transcriptHostPath).toBeTruthy();
			fs.mkdirSync(path.dirname(transcriptHostPath!), { recursive: true });
			fs.writeFileSync(transcriptHostPath!, '{"type":"message","message":{"role":"user","content":"sandbox history"}}\n');

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
	});});
