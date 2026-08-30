// v2-native — contract coverage for finite-shape resource update routes.
//
// This suite deliberately sends an otherwise-valid mixed body with an extra key.
// The update must fail before mutation; returning 200 while projecting selected
// properties is the silent-drop regression this suite reproduces.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getGateway, type EntityCounts, type GatewayFixture } from "../../../tests2/harness/gateway.js";
import { assertNoLeaks, snapshotEntities } from "../../../tests2/harness/leak-detector.js";
import { createScope, type TestScope } from "../../../tests2/harness/scope.js";
import { STRICT_UPDATE_BODY_KEYS } from "../../../src/server/strict-body.js";
import { seedTeamLeadHeader } from "../../../tests2/integration/_e2e/e2e-setup.js";

/**
 * This is the request-contract source of truth the strict-body helper must
 * export. Keeping the expected tuples here makes widening a route's body shape
 * an intentional API decision, rather than an incidental accepted property.
 */
const EXPECTED_STRICT_UPDATE_BODY_KEYS = {
	projects: ["name", "color", "rootPath", "palette", "colorLight", "colorDark"],
	goals: ["title", "cwd", "state", "spec", "branch", "reattemptOf", "team"],
	tools: ["projectId", "description", "group", "docs", "detail_docs", "grantPolicy"],
	roles: ["projectId", "label", "promptTemplate", "accessory", "toolPolicies", "model", "thinkingLevel"],
	tasks: ["title", "spec", "state", "assignedSessionId", "dependsOn", "workflowGateId", "inputGateIds", "headSha", "baseSha", "branch", "resultSummary"],
	workflows: ["name", "description", "gates"],
	staffPut: ["name", "description", "systemPrompt", "cwd", "state", "triggers", "memory", "roleId", "accessory", "contextPolicy"],
	sessions: ["title", "colorIndex", "projectId", "preview", "roleId", "assistantType", "goalAssistant", "goalId", "accessory", "delegateOf", "teamLeadSessionId", "archived"],
	staffPatch: ["projectId"],
	goalPolicy: ["subgoalsAllowed", "maxNestingDepth", "divergencePolicy", "maxConcurrentChildren"],
} as const;

type Json = Record<string, unknown>;
let gw: GatewayFixture;
let scope: TestScope;
let baseline: EntityCounts;
let sequence = 0;

function unique(label: string): string {
	return `strict-body-${label}-${process.pid}-${Date.now()}-${++sequence}`;
}

function jsonInit(method: string, body: Json, headers: Record<string, string> = {}): RequestInit {
	return { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) };
}

async function readJson(path: string): Promise<any> {
	const response = await gw.api(path);
	expect(response.status, `GET ${path}: ${await response.clone().text()}`).toBe(200);
	return response.json();
}

async function createProject(label: string): Promise<any> {
	const rootPath = join(gw.bobbitDir, "strict-update-body-fixtures", unique(label));
	mkdirSync(rootPath, { recursive: true });
	const response = await gw.api("/api/projects", jsonInit("POST", {
		name: unique(label),
		rootPath,
		acceptCanonical: true,
	}));
	expect(response.status, `project creation: ${await response.clone().text()}`).toBe(201);
	const project = await response.json();
	scope.trackProject(project.id);
	return project;
}

async function createGoal(label: string): Promise<any> {
	return scope.createGoal({ title: unique(label), team: false, worktree: false });
}

async function createStaff(label: string): Promise<any> {
	const response = await gw.api("/api/staff", jsonInit("POST", {
		projectId: gw.defaultProjectId,
		name: unique(label),
		systemPrompt: "Strict update body fixture.",
	}));
	expect(response.status, `staff creation: ${await response.clone().text()}`).toBe(201);
	const staff = await response.json();
	if (staff.currentSessionId) scope.trackSession(staff.currentSessionId);
	return staff;
}

async function deleteStaff(id: string): Promise<void> {
	const response = await gw.api(`/api/staff/${id}`, { method: "DELETE" });
	expect([200, 404], `staff cleanup: ${await response.clone().text()}`).toContain(response.status);
}

async function expectUnknownRejected(path: string, method: "PUT" | "PATCH", body: Json, field: string): Promise<void> {
	const response = await gw.api(path, jsonInit(method, body));
	const text = await response.text();
	expect(response.status, `${method} ${path} must reject unknown body field ${field}; response=${text}`).toBe(400);
	expect(text).toContain(field);
}

beforeAll(async () => {
	gw = await getGateway();
	baseline = snapshotEntities(gw);
});

beforeEach(() => { scope = createScope(gw); });
afterEach(async () => { await scope.cleanup(); });
afterAll(() => { assertNoLeaks(baseline, snapshotEntities(gw)); });

describe("finite-shape update routes reject unknown request fields", () => {
	it("declares the exact body allow-lists alongside the strict parser", () => {
		expect(STRICT_UPDATE_BODY_KEYS).toEqual(EXPECTED_STRICT_UPDATE_BODY_KEYS);
	});

	it("PUT /api/projects/:id persists valid fields and rejects an unknown field without mutation", async () => {
		const project = await createProject("project");
		const validName = unique("renamed-project");
		const valid = await gw.api(`/api/projects/${project.id}`, jsonInit("PUT", { name: validName }));
		expect(valid.status).toBe(200);
		expect((await readJson(`/api/projects/${project.id}`)).name).toBe(validName);

		await expectUnknownRejected(`/api/projects/${project.id}`, "PUT", { ignoredProjectField: true }, "ignoredProjectField");
		expect((await readJson(`/api/projects/${project.id}`)).name).toBe(validName);
	});

	it("PUT /api/goals/:id accepts the goal editor team compatibility field and points policy fields to PATCH /policy", async () => {
		const goal = await createGoal("goal");
		const title = unique("goal-title");
		const valid = await gw.api(`/api/goals/${goal.id}`, jsonInit("PUT", { title, team: false }));
		expect(valid.status).toBe(200);
		expect((await readJson(`/api/goals/${goal.id}`)).title).toBe(title);

		const policyFields = ["subgoalsAllowed", "maxNestingDepth", "divergencePolicy", "maxConcurrentChildren"] as const;
		const responses = await Promise.all(policyFields.map(async (field) => {
			const response = await gw.api(`/api/goals/${goal.id}`, jsonInit("PUT", { [field]: true }));
			return { field, status: response.status, text: await response.text() };
		}));
		for (const response of responses) {
			expect(response.status, `PUT /api/goals/:id must reject wrong-endpoint field ${response.field}; response=${response.text}`).toBe(400);
			expect(response.text).toContain(response.field);
			expect(response.text).toContain("PATCH /api/goals/:id/policy");
		}
		expect((await readJson(`/api/goals/${goal.id}`)).title).toBe(title);
	});

	it("PUT /api/tools/:name preserves valid metadata updates and rejects an unknown field without mutation", async () => {
		const project = await createProject("tool-project");
		const path = `/api/tools/bash?projectId=${encodeURIComponent(project.id)}`;
		const description = unique("tool-description");
		const valid = await gw.api(path, jsonInit("PUT", { projectId: project.id, description }));
		expect(valid.status).toBe(200);
		expect((await readJson(path)).description).toBe(description);

		await expectUnknownRejected(path, "PUT", { projectId: project.id, ignoredToolField: true }, "ignoredToolField");
		expect((await readJson(path)).description).toBe(description);
	});

	it("PUT /api/roles/:name preserves valid metadata updates and rejects an unknown field without mutation", async () => {
		const project = await createProject("role-project");
		const name = unique("role").replace(/[^a-z0-9-]/g, "-").toLowerCase();
		const create = await gw.api("/api/roles", jsonInit("POST", {
			projectId: project.id,
			name,
			label: "Original strict role",
			promptTemplate: "Strict role fixture.",
		}));
		expect(create.status, `role creation: ${await create.clone().text()}`).toBe(201);
		const path = `/api/roles/${name}?projectId=${encodeURIComponent(project.id)}`;
		const label = unique("role-label");
		const valid = await gw.api(path, jsonInit("PUT", { projectId: project.id, label }));
		expect(valid.status).toBe(200);
		expect((await readJson(path)).label).toBe(label);

		await expectUnknownRejected(path, "PUT", { projectId: project.id, ignoredRoleField: true }, "ignoredRoleField");
		expect((await readJson(path)).label).toBe(label);
	});

	it("PUT /api/tasks/:id persists valid fields and rejects an unknown field without mutation", async () => {
		const goal = await createGoal("task-goal");
		const create = await gw.api(`/api/goals/${goal.id}/tasks`, jsonInit("POST", { title: unique("task"), type: "testing" }));
		expect(create.status, `task creation: ${await create.clone().text()}`).toBe(201);
		const task = await create.json();
		const title = unique("task-title");
		const valid = await gw.api(`/api/tasks/${task.id}`, jsonInit("PUT", { title }));
		expect(valid.status).toBe(200);
		expect((await readJson(`/api/tasks/${task.id}`)).title).toBe(title);

		await expectUnknownRejected(`/api/tasks/${task.id}`, "PUT", { ignoredTaskField: true }, "ignoredTaskField");
		expect((await readJson(`/api/tasks/${task.id}`)).title).toBe(title);
	});

	it("PUT /api/workflows/:id persists valid fields and rejects an unknown field without mutation", async () => {
		const project = await createProject("workflow-project");
		const id = unique("workflow");
		const create = await gw.api("/api/workflows", jsonInit("POST", {
			projectId: project.id,
			id,
			name: "Original strict workflow",
			description: "Strict workflow fixture.",
			gates: [],
		}));
		expect(create.status, `workflow creation: ${await create.clone().text()}`).toBe(201);
		const path = `/api/workflows/${id}?projectId=${encodeURIComponent(project.id)}`;
		const name = unique("workflow-name");
		const valid = await gw.api(path, jsonInit("PUT", { name }));
		expect(valid.status).toBe(200);
		expect((await readJson(path)).name).toBe(name);

		await expectUnknownRejected(path, "PUT", { ignoredWorkflowField: true }, "ignoredWorkflowField");
		expect((await readJson(path)).name).toBe(name);
	});

	it("PUT /api/staff/:id preserves valid updates and rejects immutable sandboxed without mutation", async () => {
		const staff = await createStaff("staff");
		const description = unique("staff-description");
		const valid = await gw.api(`/api/staff/${staff.id}`, jsonInit("PUT", { description }));
		expect(valid.status).toBe(200);
		expect((await readJson(`/api/staff/${staff.id}`)).description).toBe(description);

		try {
			await expectUnknownRejected(`/api/staff/${staff.id}`, "PUT", { sandboxed: true }, "sandboxed");
			expect((await readJson(`/api/staff/${staff.id}`)).sandboxed).toBe(false);
			expect((await readJson(`/api/staff/${staff.id}`)).description).toBe(description);
		} finally {
			await deleteStaff(staff.id);
		}
	});

	it("PATCH /api/sessions/:id persists valid updates and rejects an unknown field without mutation", async () => {
		const session = await scope.createSession({ title: unique("session-original") });
		const title = unique("session-title");
		const valid = await gw.api(`/api/sessions/${session.id}`, jsonInit("PATCH", { title }));
		expect(valid.status).toBe(200);
		expect((await readJson(`/api/sessions/${session.id}`)).title).toBe(title);

		await expectUnknownRejected(`/api/sessions/${session.id}`, "PATCH", { ignoredSessionField: true }, "ignoredSessionField");
		expect((await readJson(`/api/sessions/${session.id}`)).title).toBe(title);
	});

	it("PATCH /api/staff/:id rehomes with projectId and rejects mixed unknown fields before mutation", async () => {
		const target = await createProject("staff-target");
		const staff = await createStaff("patch-staff");
		try {
			const valid = await gw.api(`/api/staff/${staff.id}`, jsonInit("PATCH", { projectId: target.id }));
			expect(valid.status).toBe(200);
			expect((await readJson(`/api/staff/${staff.id}`)).projectId).toBe(target.id);

			await expectUnknownRejected(`/api/staff/${staff.id}`, "PATCH", { projectId: target.id, ignoredStaffPatchField: true }, "ignoredStaffPatchField");
			expect((await readJson(`/api/staff/${staff.id}`)).projectId).toBe(target.id);
		} finally {
			await deleteStaff(staff.id);
		}
	});

	it("PATCH /api/goals/:id/policy persists valid fields and rejects mixed unknown fields before mutation", async () => {
		const goal = await createGoal("policy-goal");
		const leadHeaders = seedTeamLeadHeader(gw, goal.id);
		const path = `/api/goals/${goal.id}/policy`;
		const valid = await gw.api(path, jsonInit("PATCH", { subgoalsAllowed: true, maxNestingDepth: 2 }, leadHeaders));
		expect(valid.status, `policy valid update: ${await valid.clone().text()}`).toBe(200);
		expect((await readJson(`/api/goals/${goal.id}`)).subgoalsAllowed).toBe(true);

		const response = await gw.api(path, jsonInit("PATCH", { subgoalsAllowed: false, ignoredPolicyField: true }, leadHeaders));
		const text = await response.text();
		expect(response.status, `PATCH /policy must reject mixed unknown field before mutation; response=${text}`).toBe(400);
		expect(text).toContain("ignoredPolicyField");
		expect((await readJson(`/api/goals/${goal.id}`)).subgoalsAllowed).toBe(true);
	});
});
