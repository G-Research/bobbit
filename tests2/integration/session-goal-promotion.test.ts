import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "./_e2e/in-process-harness.js";
import { copyGitTemplate } from "../harness/git-template.js";
import { readAuthorSidecar } from "../../src/server/agent/author-sidecar.js";
import { apiFetch as harnessApiFetch, createSession, rawApiFetch, registerProject, waitForSessionStatus } from "./_e2e/e2e-setup.js";

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

function promotionKickoff(title: string): string {
	return `You have been promoted to the team lead for the goal "${title}".  Proceed to complete the goal, following the instructions in your system prompt carefully.`;
}

function transcriptTextOccurrences(transcriptPath: string, text: string): number {
	const escapedText = JSON.stringify(text).slice(1, -1);
	return fs.readFileSync(transcriptPath, "utf8").split(escapedText).length - 1;
}

async function expectPromotionLifecycleConflict(response: Response): Promise<void> {
	expect(response.status).toBe(409);
	expect((await jsonResponse(response)).code).toBe("PROMOTED_SESSION_LIFECYCLE_CONFLICT");
}

async function acceptPromotionWithHeldKickoff(
	gateway: any,
	ownerId: string,
	body: Record<string, unknown>,
): Promise<{ response: Response; core: any }> {
	const teamManager = gateway.teamManager as any;
	const originalFinalize = teamManager.finalizeAdoptedLead;
	let core: any;
	teamManager.finalizeAdoptedLead = async function (...args: any[]) {
		core = gateway.sessionManager.getSession(ownerId)?.rpcClient?._agent;
		if (!core) throw new Error("promoted mock runtime was not established before finalization");
		core.armBarrier("turn:before-agent-end");
		return originalFinalize.apply(teamManager, args);
	};
	try {
		const response = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!core) throw new Error("promotion finalization did not reach the promoted mock runtime");
		await core.waitForBarrier("turn:before-agent-end");
		return { response, core };
	} catch (error) {
		core?.releaseAllBarriers();
		throw error;
	} finally {
		teamManager.finalizeAdoptedLead = originalFinalize;
	}
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

test.describe("current-session goal promotion transaction and lifecycle safety", () => {
	test("removes gates and goal after an exact reservation release, then permits a clean retry", async ({ gateway, scope }) => {
		const { ownerId, context } = await createPromotionCandidate(gateway, "released-compensation");
		const goalManager = context.goalManager as any;
		const sessionManager = gateway.sessionManager as any;
		const originalCreateGoal = goalManager.createGoal;
		const originalPromote = sessionManager.promoteToGoalLead;
		const transcriptPath = sessionManager.getPersistedSession(ownerId)?.agentSessionFile as string;
		expect(transcriptPath).toBeTruthy();
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
		expect(fs.readFileSync(transcriptPath, "utf8"), "pre-commit compensation must not leak a kickoff").not.toContain("You have been promoted to the team lead for the goal");

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
		await expect.poll(
			() => transcriptTextOccurrences(transcriptPath, promotionKickoff(retriedGoal.title)),
			{ timeout: 10_000, interval: 100, message: "successful retry must durably append one promotion kickoff" },
		).toBe(1);
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

		const heldAcceptance = await acceptPromotionWithHeldKickoff(gateway, ownerId, {
			title: "Promote API owner",
			spec: "Keep the exact session checkout.",
		});
		let goal: any;
		let after: any;
		let transcriptPath = "";
		try {
			const accepted = heldAcceptance.response;
			expect(accepted.status, await accepted.clone().text()).toBe(201);
			goal = await jsonResponse(accepted);
			scope.trackGoal(goal.id);
			expect(goal.worktreeOwnerSessionId).toBe(ownerId);
			expect(goal.worktreePath).toBe(before.worktreePath);
			expect(goal.branch).toBe(before.branch);
			expect(goal.setupStatus).toBe("ready");
			expect(goal.state).toBe("in-progress");

			after = await sessionRecord(ownerId);
			expect(after.id).toBe(ownerId);
			expect(after.goalId).toBe(goal.id);
			expect(after.teamGoalId).toBe(goal.id);
			expect(after.role).toBe("team-lead");
			expect(after.worktreePath).toBe(before.worktreePath);
			expect(after.branch).toBe(before.branch);
			expect(gateway.sessionManager.getSession(ownerId)?.status).toBe("streaming");
			expect(fs.readFileSync(staged, "utf8")).toBe("staged before promotion\n");
			expect(fs.readFileSync(untracked, "utf8")).toBe("untracked before promotion\n");
			expect(String((await runner.execFile("git", ["status", "--porcelain"], { cwd: worktree })).stdout)).toBe(statusBefore);

			transcriptPath = gateway.sessionManager.getPersistedSession(ownerId)?.agentSessionFile as string;
			expect(transcriptPath).toBeTruthy();
			expect(transcriptTextOccurrences(transcriptPath, promotionKickoff(goal.title))).toBe(1);

			const retry = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
				method: "POST",
				body: JSON.stringify({ title: "Promote API owner", spec: "retry" }),
			});
			expect(retry.status, await retry.clone().text()).toBe(201);
			expect((await jsonResponse(retry)).id).toBe(goal.id);
			expect(transcriptTextOccurrences(transcriptPath, promotionKickoff(goal.title)), "streaming exact acceptance retry must not duplicate the kickoff").toBe(1);
			expect(readAuthorSidecar(ownerId).filter(binding => binding.intentId === `promotion-kickoff:${goal.id}`)).toHaveLength(1);
			const goalsBody = await jsonResponse(await apiFetch("/api/goals"));
			const goals = Array.isArray(goalsBody) ? goalsBody : goalsBody.goals;
			expect(goals.filter((candidate: any) => candidate.worktreeOwnerSessionId === ownerId)).toHaveLength(1);
			expect((await apiFetch(`/api/sessions/${ownerId}/proposal/goal`)).status).toBe(404);
		} finally {
			heldAcceptance.core.releaseAllBarriers();
		}

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

});
