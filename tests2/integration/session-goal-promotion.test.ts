import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "./_e2e/in-process-harness.js";
import { copyGitTemplate } from "../harness/git-template.js";
import { apiFetch as harnessApiFetch, createSession, rawApiFetch, registerProject, waitForSessionStatus } from "./_e2e/e2e-setup.js";
import { SandboxSessionFilesystem } from "../harness/sandbox-session-filesystem.js";

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
	const mutatesProposal = /^\/api\/sessions\/[^/]+\/proposal\//.test(requestPath)
		&& (method === "POST" || method === "PUT" || method === "DELETE");
	if (!mutatesProposal) return harnessApiFetch(requestPath, opts);
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

async function expectPromotionLifecycleConflict(response: Response): Promise<void> {
	expect(response.status).toBe(409);
	expect((await jsonResponse(response)).code).toBe("PROMOTED_SESSION_LIFECYCLE_CONFLICT");
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

test.describe("current-session goal promotion API", () => {
	test("removes gates and goal after an exact reservation release, then permits a clean retry", async ({ gateway, scope }) => {
		const { ownerId, context } = await createPromotionCandidate(gateway, "released-compensation");
		const goalManager = context.goalManager as any;
		const sessionManager = gateway.sessionManager as any;
		const originalCreateGoal = goalManager.createGoal;
		const originalPromote = sessionManager.promoteToGoalLead;
		const draftPath = path.join(gateway.bobbitDir, "state", "proposal-drafts", ownerId, "goal.md");
		const draftBefore = fs.readFileSync(draftPath, "utf8");
		let attemptedGoalId: string | undefined;
		goalManager.createGoal = async function (...args: any[]) {
			const goal = await originalCreateGoal.apply(this, args);
			attemptedGoalId = goal.id;
			return goal;
		};
		sessionManager.promoteToGoalLead = async () => {
			throw new Error("forced pre-commit promotion failure");
		};

		let failed: Response;
		try {
			failed = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
				method: "POST",
				body: JSON.stringify({ title: "Promote released" }),
			});
		} finally {
			goalManager.createGoal = originalCreateGoal;
			sessionManager.promoteToGoalLead = originalPromote;
		}
		expect(failed!.status).toBe(400);
		expect(attemptedGoalId).toBeTruthy();
		expect(context.goalStore.get(attemptedGoalId!)).toBeUndefined();
		expect(context.gateStore.getGatesForGoal(attemptedGoalId!)).toEqual([]);
		expect(gateway.teamManager.getTeamState(attemptedGoalId!)).toBeUndefined();
		expect(fs.readFileSync(draftPath, "utf8")).toBe(draftBefore);

		const retry = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
			method: "POST",
			body: JSON.stringify({ title: "Promote released" }),
		});
		expect(retry.status, await retry.clone().text()).toBe(201);
		const retriedGoal = await jsonResponse(retry);
		scope.trackGoal(retriedGoal.id);
		expect(retriedGoal.id).not.toBe(attemptedGoalId);
		expect((await sessionRecord(ownerId))).toMatchObject({
			goalId: retriedGoal.id,
			teamGoalId: retriedGoal.id,
			role: "team-lead",
		});
	});

	test("rejects a concurrent role PATCH and preserves the baseline after failed promotion compensation", async ({ gateway }) => {
		const { ownerId, context } = await createPromotionCandidate(gateway, "role-race-compensation");
		const sessionManager = gateway.sessionManager as any;
		const originalPromote = sessionManager.promoteToGoalLead;
		const sourceBefore = sessionManager.getSession(ownerId);
		const baseline = {
			role: sourceBefore.role,
			accessory: sourceBefore.accessory,
			allowedTools: sourceBefore.allowedTools ? [...sourceBefore.allowedTools] : undefined,
		};
		const draftPath = path.join(gateway.bobbitDir, "state", "proposal-drafts", ownerId, "goal.md");
		const draftBefore = fs.readFileSync(draftPath, "utf8");
		let releasePromotion!: () => void;
		const blocked = new Promise<void>(resolve => { releasePromotion = resolve; });
		let enteredPromotion!: () => void;
		const entered = new Promise<void>(resolve => { enteredPromotion = resolve; });
		sessionManager.promoteToGoalLead = async () => {
			enteredPromotion();
			await blocked;
			throw new Error("forced promotion failure after reservation");
		};

		const acceptance = apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
			method: "POST",
			body: JSON.stringify({ title: "Promote role race" }),
		});
		let failed: Response;
		let pendingGoalId: string | undefined;
		try {
			await entered;
			pendingGoalId = context.goalStore.getAll().find((goal: any) => goal.worktreeOwnerSessionId === ownerId)?.id;
			expect(pendingGoalId).toBeTruthy();
			const rolePatch = await apiFetch(`/api/sessions/${ownerId}`, {
				method: "PATCH",
				body: JSON.stringify({ roleId: "coder" }),
			});
			expect(rolePatch.status).toBe(409);
			expect(await jsonResponse(rolePatch)).toMatchObject({
				code: "SESSION_GOAL_PROMOTION_IN_PROGRESS",
			});
			releasePromotion();
			failed = await acceptance;
		} finally {
			releasePromotion();
			sessionManager.promoteToGoalLead = originalPromote;
		}

		expect(failed!.status).toBe(400);
		const liveAfter = sessionManager.getSession(ownerId);
		expect({
			role: liveAfter.role,
			accessory: liveAfter.accessory,
			allowedTools: liveAfter.allowedTools,
		}).toEqual(baseline);
		expect(await sessionRecord(ownerId)).toMatchObject({
			role: baseline.role,
			accessory: baseline.accessory,
		});
		const attemptGoals = context.goalStore.getAll().filter((goal: any) => goal.worktreeOwnerSessionId === ownerId);
		expect(attemptGoals).toEqual([]);
		expect(context.gateStore.getGatesForGoal(pendingGoalId!)).toEqual([]);
		expect(gateway.teamManager.getTeamState(pendingGoalId!)).toBeUndefined();
		expect(fs.readFileSync(draftPath, "utf8")).toBe(draftBefore);
	});

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
	});

	test("rejects archive before mutation while promotion is in flight, then permits ordered archive", async ({ gateway }) => {
		const { ownerId, context } = await createPromotionCandidate(gateway, "archive-flight");
		const sessionManager = gateway.sessionManager as any;
		const originalPromote = sessionManager.promoteToGoalLead;
		let releasePromotion!: () => void;
		const promotionBlocked = new Promise<void>(resolve => { releasePromotion = resolve; });
		let enteredPromotion!: () => void;
		const promotionEntered = new Promise<void>(resolve => { enteredPromotion = resolve; });
		sessionManager.promoteToGoalLead = async (...args: any[]) => {
			enteredPromotion();
			await promotionBlocked;
			return originalPromote.apply(sessionManager, args);
		};

		const acceptance = apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
			method: "POST",
			body: JSON.stringify({ title: "Promote archive flight" }),
		});
		let pendingGoal: any;
		let accepted: Response;
		let released = false;
		try {
			await promotionEntered;
			pendingGoal = context.goalStore.getAll().find((goal: any) => goal.worktreeOwnerSessionId === ownerId && !goal.archived);
			expect(pendingGoal).toBeTruthy();
			const gatesBefore = context.gateStore.getGatesForGoal(pendingGoal.id).length;
			const archive = await apiFetch(`/api/goals/${pendingGoal.id}?cascade=true&mergedManually=true`, { method: "DELETE" });
			expect(archive.status).toBe(409);
			expect((await jsonResponse(archive)).code).toBe("PROMOTION_IN_PROGRESS");
			expect(context.goalStore.get(pendingGoal.id)).toMatchObject({ state: "todo" });
			expect(context.goalStore.get(pendingGoal.id)?.archived).not.toBe(true);
			expect(context.gateStore.getGatesForGoal(pendingGoal.id)).toHaveLength(gatesBefore);
			expect(gateway.teamManager.getTeamState(pendingGoal.id)).toMatchObject({ teamLeadSessionId: ownerId, agents: [] });

			releasePromotion();
			released = true;
			accepted = await acceptance;
		} finally {
			if (!released) releasePromotion();
			sessionManager.promoteToGoalLead = originalPromote;
		}
		expect(accepted!.status, await accepted!.clone().text()).toBe(201);
		expect(context.goalStore.get(pendingGoal.id)?.state).toBe("in-progress");
		const archived = await apiFetch(`/api/goals/${pendingGoal.id}?cascade=true`, { method: "DELETE" });
		expect(archived.status, await archived.clone().text()).toBe(200);
		expect(context.goalStore.get(pendingGoal.id)?.archived).toBe(true);
	});

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
		expect(goal.state).toBe("in-progress");

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
