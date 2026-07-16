/**
 * API integration tests: project-scoped sessions, goals, and gates never fall
 * back to another project.
 *
 * The suite installs two lightweight ProjectContext instances once. Their
 * execution stores use memfs and their inline workflow config is seeded
 * directly, avoiding repeated project registration, YAML parsing, search-index
 * startup, and NTFS state trees. Each test still drives the real REST handlers;
 * only the incidental persistence fixture is replaced.
 */
import { afterAll, afterEach, beforeAll, describe as vitestDescribe, expect, test as vitestTest } from "vitest";
import { createFsFromVolume, Volume } from "memfs";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ProjectContext } from "../../src/server/agent/project-context.js";
import type { FsLike } from "../../src/server/gateway-deps.js";
import { TEST_DEFAULT_COMPONENT } from "../../tests/e2e/seed-workflows.js";
import type { GatewayFixture } from "../harness/gateway.js";
import { apiFetch, defaultProject, ensureGateway } from "./_e2e/e2e-setup.js";

interface SuiteProject {
	id: string;
	rootPath: string;
	context: ProjectContext;
}

let gateway: GatewayFixture;
let defaultProjectFixture: { id: string; rootPath: string; name?: string };
let projectB: SuiteProject;
let projectC: SuiteProject;
const createdSessionIds = new Set<string>();
const test = Object.assign(vitestTest, { describe: vitestDescribe });

const ISOLATION_WORKFLOWS = {
	general: {
		id: "general",
		name: "General",
		description: "Minimal project-isolation workflow",
		gates: [{ id: "design-doc", name: "Design Document", content: true }],
	},
};

function contextMap(): Map<string, ProjectContext> {
	return (gateway.projectContextManager as unknown as {
		contexts: Map<string, ProjectContext>;
	}).contexts;
}

/** Install a project context without opening search or writing project state to NTFS. */
function installSuiteProject(name: string): SuiteProject {
	const rootPath = join(gateway.bobbitDir, "project-isolation", name);
	mkdirSync(rootPath, { recursive: true });

	const registry = gateway.projectContextManager.getRegistry();
	const project = registry.register(name, rootPath, { acceptCanonical: true });
	const fsImpl = createFsFromVolume(new Volume()) as unknown as FsLike;
	const context = new ProjectContext(project, { fsImpl, clock: gateway.clock });
	context.projectConfigStore.setComponents([TEST_DEFAULT_COMPONENT]);
	context.projectConfigStore.setWorkflows(ISOLATION_WORKFLOWS);
	contextMap().set(project.id, context);
	return { id: project.id, rootPath, context };
}

/** Directly reset suite-owned stores; persistence itself is not under test here. */
async function resetSuiteEntities(): Promise<void> {
	for (const id of createdSessionIds) {
		await gateway.sessionManager.terminateSession(id).catch(() => false);
	}
	for (const context of gateway.projectContextManager.all()) {
		const sessions = (context.sessionStore as any).sessions as Map<string, unknown>;
		for (const id of createdSessionIds) sessions.delete(id);
	}
	createdSessionIds.clear();

	for (const project of [projectB, projectC]) {
		const goalStore = project.context.goalStore as any;
		const gateStore = project.context.gateStore as any;
		for (const goal of goalStore.getAll()) gateStore.removeGoalGates(goal.id);
		goalStore.goals.clear();
	}
}

async function uninstallSuiteProject(project: SuiteProject): Promise<void> {
	contextMap().delete(project.id);
	await project.context.close();
	gateway.projectContextManager.getRegistry().remove(project.id);
}

/** Create a session in a specific project through the production REST route. */
async function createSessionInProject(project: SuiteProject): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: project.rootPath, projectId: project.id }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	createdSessionIds.add(data.id);
	return data.id;
}

/** Get live sessions from the list endpoint. */
async function listSessions(projectId?: string): Promise<any[]> {
	let url = "/api/sessions";
	if (projectId) url += `?projectId=${projectId}`;
	const resp = await apiFetch(url);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	return body.sessions ?? body;
}

beforeAll(async () => {
	gateway = await ensureGateway();
	defaultProjectFixture = await defaultProject();
	projectB = installSuiteProject("isolation-b");
	projectC = installSuiteProject("isolation-c");
});

afterEach(resetSuiteEntities);

afterAll(async () => {
	await resetSuiteEntities();
	await uninstallSuiteProject(projectC);
	await uninstallSuiteProject(projectB);
	rmSync(join(gateway.bobbitDir, "project-isolation"), { recursive: true, force: true });
});

test.describe("Project isolation — no default fallback", () => {
	test("session created in project B has correct projectId and is filtered correctly @smoke", async () => {
		const sessionId = await createSessionInProject(projectB);

		// Verify the session detail has the correct projectId
		const detailResp = await apiFetch(`/api/sessions/${sessionId}`);
		expect(detailResp.status).toBe(200);
		const detail = await detailResp.json();
		expect(detail.projectId).toBe(projectB.id);

		// Verify the session appears in project B's filtered list
		const sessionsB = await listSessions(projectB.id);
		expect(sessionsB.some((s: any) => s.id === sessionId)).toBe(true);

		// Verify the session does NOT appear in the default project's filtered list
		const sessionsDefault = await listSessions(defaultProjectFixture.id);
		expect(sessionsDefault.some((s: any) => s.id === sessionId)).toBe(false);
	});

	test("terminated session is removed from the correct project store", async () => {
		const sessionId = await createSessionInProject(projectB);

		// Verify session is live and in project B
		const sessionsBeforeB = await listSessions(projectB.id);
		expect(sessionsBeforeB.some((s: any) => s.id === sessionId)).toBe(true);

		// Terminate
		const delResp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		expect(delResp.status).toBe(200);

		// Verify session is no longer in project B's live list
		const sessionsAfterB = await listSessions(projectB.id);
		expect(sessionsAfterB.some((s: any) => s.id === sessionId)).toBe(false);

		// Verify session is not in the default project's live list either
		const sessionsAfterDefault = await listSessions(defaultProjectFixture.id);
		expect(sessionsAfterDefault.some((s: any) => s.id === sessionId)).toBe(false);

		// Verify the session doesn't appear in any project's live list
		const allSessions = await listSessions();
		expect(allSessions.some((s: any) => s.id === sessionId)).toBe(false);

		// Verify no cross-contamination into the default project's archive
		const archivedDefaultResp = await apiFetch(`/api/sessions?projectId=${defaultProjectFixture.id}&include=archived`);
		expect(archivedDefaultResp.status).toBe(200);
		const archivedDefaultBody = await archivedDefaultResp.json();
		const archivedDefault = archivedDefaultBody.sessions ?? archivedDefaultBody;
		expect(archivedDefault.some((s: any) => s.id === sessionId)).toBe(false);

		// The owning project may retain the terminated session as an archive.
		const archivedBResp = await apiFetch(`/api/sessions?projectId=${projectB.id}&include=archived`);
		expect(archivedBResp.status).toBe(200);
		const archivedBBody = await archivedBResp.json();
		const archivedB = archivedBBody.sessions ?? archivedBBody;
		const archivedSession = archivedB.find((s: any) => s.id === sessionId);
		if (archivedSession) expect(archivedSession.projectId).toBe(projectB.id);
	});

	test("goal creation and retrieval respects project isolation", async () => {
		const createResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Isolation test goal",
				spec: "Test spec for isolation",
				cwd: projectB.rootPath,
				projectId: projectB.id,
				team: false,
				worktree: false,
			}),
		});
		expect(createResp.status).toBe(201);
		const goal = await createResp.json();
		const goalId = goal.id as string;
		expect(goal.projectId).toBe(projectB.id);

		// Verify the goal appears when filtered by project B
		const goalsB = await apiFetch(`/api/goals?projectId=${projectB.id}`);
		const goalsBBody = await goalsB.json();
		const goalsBList = goalsBBody.goals ?? goalsBBody;
		const foundInB = goalsBList.find((g: any) => g.id === goalId);
		expect(foundInB).toBeTruthy();
		expect(foundInB.projectId).toBe(projectB.id);

		// Verify the goal does NOT appear when filtered by default project
		const goalsDefault = await apiFetch(`/api/goals?projectId=${defaultProjectFixture.id}`);
		const goalsDefaultBody = await goalsDefault.json();
		const goalsDefaultList = goalsDefaultBody.goals ?? goalsDefaultBody;
		expect(goalsDefaultList.find((g: any) => g.id === goalId)).toBeUndefined();
	});

	test("goal with workflow — gates resolve to correct project", async () => {
		const createResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Gate isolation test",
				cwd: projectB.rootPath,
				projectId: projectB.id,
				team: false,
				worktree: false,
				workflowId: "general",
			}),
		});
		expect(createResp.status).toBe(201);
		const goal = await createResp.json();
		const goalId = goal.id as string;

		// Verify gates exist for this goal
		const gatesResp = await apiFetch(`/api/goals/${goalId}/gates`);
		expect(gatesResp.status).toBe(200);
		const { gates } = await gatesResp.json();
		expect(gates.length).toBeGreaterThan(0);
		expect(gates.map((g: any) => g.gateId)).toContain("design-doc");

		// Signal the design-doc gate and verify it resolves in the owning store.
		const signalResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
			method: "POST",
			body: JSON.stringify({
				content: "# Design\n\nApproach: test isolation\n\nFiles: a.ts\n\nCriteria: works",
			}),
		});
		expect(signalResp.status).toBe(201);
		await expect.poll(async () => {
			const gateResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc`);
			expect(gateResp.status).toBe(200);
			return (await gateResp.json()).status;
		}, { interval: 1, timeout: 1_000 }).not.toBe("pending");

		// Verify the goal remains scoped to project B.
		const goalResp = await apiFetch(`/api/goals/${goalId}`);
		expect((await goalResp.json()).projectId).toBe(projectB.id);
	});

	test("multi-project session lifecycle — no cross-contamination", async () => {
		const sessionB = await createSessionInProject(projectB);
		const sessionC = await createSessionInProject(projectC);

		// Verify live sessions have correct projectIds
		const detailB = await apiFetch(`/api/sessions/${sessionB}`);
		expect((await detailB.json()).projectId).toBe(projectB.id);
		const detailC = await apiFetch(`/api/sessions/${sessionC}`);
		expect((await detailC.json()).projectId).toBe(projectC.id);

		// Verify project-filtered lists are correct
		const sessionsB = await listSessions(projectB.id);
		expect(sessionsB.some((s: any) => s.id === sessionB)).toBe(true);
		expect(sessionsB.some((s: any) => s.id === sessionC)).toBe(false);
		const sessionsC = await listSessions(projectC.id);
		expect(sessionsC.some((s: any) => s.id === sessionC)).toBe(true);
		expect(sessionsC.some((s: any) => s.id === sessionB)).toBe(false);

		// Default project should have neither
		const sessionsDefault = await listSessions(defaultProjectFixture.id);
		expect(sessionsDefault.some((s: any) => s.id === sessionB)).toBe(false);
		expect(sessionsDefault.some((s: any) => s.id === sessionC)).toBe(false);
	});

	test("session creation without projectId defaults to the default project", async () => {
		// apiFetch supplies the harness default project when the body omits it.
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		const sessionId = data.id as string;
		createdSessionIds.add(sessionId);

		const detailResp = await apiFetch(`/api/sessions/${sessionId}`);
		expect(detailResp.status).toBe(200);
		expect((await detailResp.json()).projectId).toBe(defaultProjectFixture.id);

		const sessionsDefault = await listSessions(defaultProjectFixture.id);
		expect(sessionsDefault.some((s: any) => s.id === sessionId)).toBe(true);
	});

	test("session list filtering by non-existent project returns empty", async () => {
		const sessionId = await createSessionInProject(projectB);

		const sessionsB = await listSessions(projectB.id);
		expect(sessionsB.some((s: any) => s.id === sessionId)).toBe(true);

		const sessionsNone = await listSessions("nonexistent-project-id");
		expect(sessionsNone.some((s: any) => s.id === sessionId)).toBe(false);
	});
});
