import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "./_helpers/e2e/in-process-harness.js";
import { copyGitTemplate } from "../../support/harnesses/git-template.js";
import { apiFetch as harnessApiFetch, createSession, rawApiFetch, registerProject, waitForSessionStatus } from "./_helpers/e2e/e2e-setup.js";
import { latestRev, readProposalFile } from "../../../src/server/proposals/proposal-files.js";

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

function sessionCapabilityHeaders(gateway: any, sid: string): Record<string, string> {
	return {
		"X-Bobbit-Session-Secret": gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sid),
	};
}

async function expectProposalOwnerMismatch(response: Response, operation: string): Promise<void> {
	const text = await response.text();
	expect.soft(response.status, `${operation} must reject a foreign session capability: ${text}`).toBe(403);
	expect.soft(text, `${operation} must return the stable structured ownership code`).toContain("PROPOSAL_OWNER_MISMATCH");
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

test.describe("current-session goal promotion validation", () => {
	test("foreign capability is denied before victim mode mutation or promotion reservation", async ({ gateway, scope }) => {
		const projectRoot = path.join(gateway.bobbitDir, `promotion-owner-auth-${randomUUID()}`);
		copyGitTemplate(projectRoot);
		const project = await registerProject({
			name: `promotion-owner-auth-${Date.now()}`,
			rootPath: projectRoot,
			components: [{ name: "app", repo: "." }],
			workflows: {
				"owner-flow": {
					name: "Owner Flow",
					description: "Proposal ownership security fixture",
					gates: [{ id: "implementation", name: "Implementation", depends_on: [] }],
				},
			},
		});
		const victimId = await createSession({ projectId: project.id, cwd: projectRoot });
		const attackerId = await createSession({ projectId: project.id, cwd: projectRoot });
		await Promise.all([
			waitForSessionStatus(victimId, "idle", 30_000),
			waitForSessionStatus(attackerId, "idle", 30_000),
		]);
		const victimHeaders = sessionCapabilityHeaders(gateway, victimId);
		const attackerHeaders = sessionCapabilityHeaders(gateway, attackerId);
		const manager = gateway.sessionManager as any;
		const context = gateway.projectContextManager.getOrCreate(project.id);

		const seeded = await rawApiFetch(`/api/sessions/${victimId}/proposal/goal/seed`, {
			method: "POST",
			headers: victimHeaders,
			body: JSON.stringify({ args: {
				title: "Promote owned victim",
				spec: "Only the victim capability may adopt this exact session worktree.",
				workflow: "owner-flow",
				projectId: project.id,
			} }),
		});
		expect(seeded.status, await seeded.clone().text()).toBe(200);
		const selected = await rawApiFetch(`/api/sessions/${victimId}/proposal/goal/worktree-mode`, {
			method: "PUT", headers: victimHeaders, body: JSON.stringify({ mode: "current-session" }),
		});
		expect(selected.status, await selected.clone().text()).toBe(200);
		const selection = await jsonResponse(selected);
		expect(selection.eligibility?.eligible, JSON.stringify(selection)).toBe(true);

		const proposalStateDir = path.join(gateway.bobbitDir, "state");
		const draftBefore = await readProposalFile(proposalStateDir, victimId, "goal");
		const revisionBefore = await latestRev(proposalStateDir, victimId, "goal");
		const goalsBefore = structuredClone(context.goalStore.getAll());
		const tasksBefore = structuredClone(context.taskStore.getAll());
		const gatesBefore = (context.gateStore as any).gates?.size ?? 0;
		const workflowLibraryBefore = structuredClone(context.workflowStore.getAll());
		const workflowConfigBefore = structuredClone(context.projectConfigStore.getWorkflows());
		const victimBefore = structuredClone(manager.getPersistedSession(victimId));
		const worktree = victimBefore.worktreePath as string;
		expect(fs.existsSync(worktree)).toBe(true);

		const originalReserve = manager.reserveSessionGoalPromotion;
		const originalCreateGoal = context.goalManager.createGoal;
		const originalPromote = manager.promoteToGoalLead;
		let reservationCalls = 0;
		let createGoalCalls = 0;
		let promoteCalls = 0;
		manager.reserveSessionGoalPromotion = function (..._args: any[]) {
			reservationCalls += 1;
			throw new Error("PROPOSAL_OWNER_GUARD_RAN_TOO_LATE: promotion reservation was reached");
		};
		context.goalManager.createGoal = async function (...args: any[]) {
			createGoalCalls += 1;
			return originalCreateGoal.apply(this, args);
		};
		manager.promoteToGoalLead = async function (...args: any[]) {
			promoteCalls += 1;
			return originalPromote.apply(this, args);
		};
		try {
			const modeAttack = await rawApiFetch(`/api/sessions/${victimId}/proposal/goal/worktree-mode`, {
				method: "PUT", headers: attackerHeaders, body: JSON.stringify({ mode: "current-session" }),
			});
			await expectProposalOwnerMismatch(modeAttack, "current-session mode mutation");
			const acceptanceAttack = await rawApiFetch(`/api/sessions/${victimId}/proposal/goal/accept`, {
				method: "POST", headers: attackerHeaders, body: JSON.stringify({}),
			});
			await expectProposalOwnerMismatch(acceptanceAttack, "current-session acceptance");
		} finally {
			manager.reserveSessionGoalPromotion = originalReserve;
			context.goalManager.createGoal = originalCreateGoal;
			manager.promoteToGoalLead = originalPromote;
		}

		expect(reservationCalls, "ownership denial must precede promotion reservation").toBe(0);
		expect(createGoalCalls, "ownership denial must precede goal/worktree creation").toBe(0);
		expect(promoteCalls, "ownership denial must precede session role mutation").toBe(0);
		expect(context.goalStore.getAll()).toEqual(goalsBefore);
		expect(context.taskStore.getAll()).toEqual(tasksBefore);
		expect((context.gateStore as any).gates?.size ?? 0).toBe(gatesBefore);
		expect(context.workflowStore.getAll()).toEqual(workflowLibraryBefore);
		expect(context.projectConfigStore.getWorkflows()).toEqual(workflowConfigBefore);
		expect(manager.getPersistedSession(victimId)).toEqual(victimBefore);
		expect(fs.existsSync(worktree)).toBe(true);
		expect(await readProposalFile(proposalStateDir, victimId, "goal"), "denied acceptance must retain the victim draft").toBe(draftBefore);
		expect(await latestRev(proposalStateDir, victimId, "goal"), "denied mode and acceptance must not advance proposal revision").toBe(revisionBefore);

		const ownerAcceptance = await rawApiFetch(`/api/sessions/${victimId}/proposal/goal/accept`, {
			method: "POST", headers: victimHeaders, body: JSON.stringify({}),
		});
		expect(ownerAcceptance.status, await ownerAcceptance.clone().text()).toBe(201);
		const goal = await jsonResponse(ownerAcceptance);
		scope.trackGoal(goal.id);
		expect(goal.worktreeOwnerSessionId).toBe(victimId);
		expect(manager.getPersistedSession(victimId)).toMatchObject({ role: "team-lead", goalId: goal.id, teamGoalId: goal.id });
	});

	test("defers generated workflow persistence until promotion commits", async ({ gateway, scope }) => {
		const projectRoot = path.join(gateway.bobbitDir, `promotion-default-${randomUUID()}`);
		copyGitTemplate(projectRoot);
		const project = await registerProject({
			name: `promotion-default-${Date.now()}`,
			rootPath: projectRoot,
			components: [{ name: "app", repo: "." }],
			seedWorkflows: false,
		});
		const context = gateway.projectContextManager.getOrCreate(project.id);
		expect(context.workflowStore.getAll()).toEqual([]);

		const ownerId = await createSession({ projectId: project.id, cwd: projectRoot });
		await waitForSessionStatus(ownerId, "idle", 30_000);
		const seeded = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/seed`, {
			method: "POST",
			body: JSON.stringify({
				args: {
					title: "Promote generated default",
					spec: "Select and persist the first generated project workflow.",
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

		const proposalStateDir = path.join(gateway.bobbitDir, "state");
		const draftBefore = await readProposalFile(proposalStateDir, ownerId, "goal");
		const revisionBefore = await latestRev(proposalStateDir, ownerId, "goal");
		expect(revisionBefore).toBeGreaterThan(0);
		const workflowsBefore = structuredClone(context.workflowStore.getAll());
		const workflowConfigBefore = structuredClone(context.projectConfigStore.getWorkflows());
		const goalsBefore = structuredClone(context.goalStore.getAll());
		const tasksBefore = structuredClone(context.taskStore.getAll());
		const gatesBefore = (context.gateStore as any).gates?.size ?? 0;
		const sessionBefore = structuredClone(gateway.sessionManager.getPersistedSession(ownerId));
		const goalManager = context.goalManager as any;
		const sessionManager = gateway.sessionManager as any;
		const originalCreateGoal = goalManager.createGoal;
		const originalPromote = sessionManager.promoteToGoalLead;
		let attemptedGoalId: string | undefined;
		goalManager.createGoal = async function (...args: any[]) {
			const goal = await originalCreateGoal.apply(this, args);
			attemptedGoalId = goal.id;
			return goal;
		};
		sessionManager.promoteToGoalLead = async () => {
			throw new Error("forced generated-default promotion failure");
		};

		let failed: Response;
		try {
			failed = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
				method: "POST",
				body: JSON.stringify({}),
			});
		} finally {
			goalManager.createGoal = originalCreateGoal;
			sessionManager.promoteToGoalLead = originalPromote;
		}
		expect(failed!.status).toBe(400);
		expect(await jsonResponse(failed!)).toEqual({ error: "forced generated-default promotion failure" });
		expect(attemptedGoalId).toBeTruthy();
		expect(context.workflowStore.getAll()).toEqual(workflowsBefore);
		expect(context.projectConfigStore.getWorkflows()).toEqual(workflowConfigBefore);
		expect(context.goalStore.getAll()).toEqual(goalsBefore);
		expect(context.taskStore.getAll()).toEqual(tasksBefore);
		expect((context.gateStore as any).gates?.size ?? 0).toBe(gatesBefore);
		expect(context.gateStore.getGatesForGoal(attemptedGoalId!)).toEqual([]);
		expect(gateway.teamManager.getTeamState(attemptedGoalId!)).toBeUndefined();
		expect(gateway.sessionManager.getPersistedSession(ownerId)).toEqual(sessionBefore);
		expect(await readProposalFile(proposalStateDir, ownerId, "goal")).toBe(draftBefore);
		expect(await latestRev(proposalStateDir, ownerId, "goal")).toBe(revisionBefore);

		const accepted = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(accepted.status, await accepted.clone().text()).toBe(201);
		const goal = await jsonResponse(accepted);
		scope.trackGoal(goal.id);
		const persistedWorkflows = context.workflowStore.getAll();
		expect(persistedWorkflows.length).toBeGreaterThan(0);
		const selectedWorkflow = persistedWorkflows.find((workflow: any) => workflow.id === goal.workflowId);
		expect(selectedWorkflow).toBeTruthy();
		expect(goal.workflow).toEqual(selectedWorkflow);
		expect(context.projectConfigStore.getWorkflows()).not.toEqual(workflowConfigBefore);
	});

	test("revalidates a stale workflow against defaults when the live store becomes empty", async ({ gateway }) => {
		const { ownerId, context } = await createPromotionCandidate(gateway, "stale-workflow");
		const workflowBefore = context.projectConfigStore.getWorkflows();
		const goalsBefore = structuredClone(context.goalStore.getAll());
		const tasksBefore = structuredClone(context.taskStore.getAll());
		const gatesBefore = (context.gateStore as any).gates?.size ?? 0;
		const sessionBefore = structuredClone(gateway.sessionManager.getPersistedSession(ownerId));
		const draftBefore = await (await apiFetch(`/api/sessions/${ownerId}/proposal/goal`)).text();
		const worktree = sessionBefore.worktreePath as string;
		expect(fs.existsSync(worktree)).toBe(true);

		const replacementWorkflows = {};
		let rejected: Response;
		let workflowsAfterReject: Record<string, unknown> | undefined;
		try {
			context.projectConfigStore.setWorkflows(replacementWorkflows);
			rejected = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
				method: "POST",
				body: JSON.stringify({ title: "Promote stale workflow" }),
			});
			workflowsAfterReject = context.projectConfigStore.getWorkflows();
		} finally {
			context.projectConfigStore.setWorkflows(workflowBefore ?? {});
		}

		expect(rejected!.status, await rejected!.clone().text()).toBe(400);
		expect(await jsonResponse(rejected!)).toMatchObject({ ok: false, code: "UNKNOWN_WORKFLOW" });
		expect(context.goalStore.getAll()).toEqual(goalsBefore);
		expect(context.taskStore.getAll()).toEqual(tasksBefore);
		expect((context.gateStore as any).gates?.size ?? 0).toBe(gatesBefore);
		expect(workflowsAfterReject ?? {}).toEqual(replacementWorkflows);
		expect(gateway.sessionManager.getPersistedSession(ownerId)).toEqual(sessionBefore);
		expect(fs.existsSync(worktree)).toBe(true);
		expect(await (await apiFetch(`/api/sessions/${ownerId}/proposal/goal`)).text()).toBe(draftBefore);
	});

	test("explicit workflow and empty optional steps override the persisted inline draft", async ({ gateway, scope }) => {
		const optionalVerification = {
			name: "QA testing",
			type: "command",
			run: "echo qa",
			optional: true,
			optionalLabel: "Enable QA testing",
		};
		const projectRoot = path.join(gateway.bobbitDir, `promotion-workflow-override-${randomUUID()}`);
		copyGitTemplate(projectRoot);
		const project = await registerProject({
			name: `promotion-workflow-override-${Date.now()}`,
			rootPath: projectRoot,
			components: [{ name: "app", repo: "." }],
			workflows: {
				"library-b": {
					name: "Library B",
					description: "Acceptance-time library selection.",
					gates: [{
						id: "library-b-gate",
						name: "Library B Gate",
						depends_on: [],
						verify: [optionalVerification],
					}],
				},
			},
		});
		const ownerId = await createSession({ projectId: project.id, cwd: projectRoot });
		await waitForSessionStatus(ownerId, "idle", 30_000);
		const seeded = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/seed`, {
			method: "POST",
			body: JSON.stringify({
				args: {
					title: "Override inline workflow",
					spec: "Accept with a library workflow and no optional steps.",
					projectId: project.id,
					options: "QA testing",
					inlineWorkflow: {
						id: "inline-a",
						name: "Inline A",
						gates: [{
							id: "inline-a-gate",
							name: "Inline A Gate",
							depends_on: [],
							verify: [optionalVerification],
						}],
					},
				},
			}),
		});
		expect(seeded.status, await seeded.clone().text()).toBe(200);
		const selected = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/worktree-mode`, {
			method: "PUT",
			body: JSON.stringify({ mode: "current-session" }),
		});
		expect(selected.status, await selected.clone().text()).toBe(200);
		expect(await (await apiFetch(`/api/sessions/${ownerId}/proposal/goal`)).text()).toContain("options: QA testing");

		const accepted = await apiFetch(`/api/sessions/${ownerId}/proposal/goal/accept`, {
			method: "POST",
			body: JSON.stringify({ workflowId: "library-b", enabledOptionalSteps: [] }),
		});
		expect(accepted.status, await accepted.clone().text()).toBe(201);
		const goal = await jsonResponse(accepted);
		scope.trackGoal(goal.id);
		expect(goal.workflowId).toBe("library-b");
		expect(goal.workflow?.gates?.map((gate: any) => gate.id)).toEqual(["library-b-gate"]);
		expect(goal.enabledOptionalSteps ?? []).toEqual([]);
	});

});
