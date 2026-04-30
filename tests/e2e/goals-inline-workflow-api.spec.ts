/**
 * E2E — POST /api/goals validates inlineWorkflow / inlineRoles bodies.
 *
 * Covers Phase 6 task 6.3 of the nested-goals workflow:
 *   - Malformed inlineWorkflow shapes return 400 with a structured body
 *     `{ field: "inlineWorkflow", error: <message> }`.
 *   - Malformed inlineRoles shapes return 400 with `{ field: "inlineRoles", error }`.
 *   - A valid inlineWorkflow / inlineRoles pair produces a 201; the goal
 *     record persists `inlineWorkflow` and `inlineRoles` exactly as supplied.
 *
 * See `docs/design/nested-goals.md` §10.4 + §7.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, nonGitCwd, defaultProjectId } from "./e2e-setup.js";

async function createGoalRaw(body: Record<string, unknown>): Promise<Response> {
	return apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

const VALID_WORKFLOW = {
	id: "my-flow",
	name: "My Flow",
	description: "test inline",
	gates: [
		{ id: "charter", name: "Charter" },
		{ id: "ready-to-merge", name: "Ready", dependsOn: ["charter"] },
	],
};

const VALID_ROLES = {
	coder: {
		label: "Coder",
		promptTemplate: "You are a coder.",
		accessory: "hat",
	},
};

test.describe("POST /api/goals — inline workflow / role validation", () => {
	test("400 on inlineWorkflow that is not an object", async () => {
		const projectId = await defaultProjectId();
		const resp = await createGoalRaw({
			title: `Inline Bad Type ${Date.now()}`,
			cwd: nonGitCwd(),
			projectId,
			autoStartTeam: false,
			inlineWorkflow: "not an object",
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.field).toBe("inlineWorkflow");
		expect(typeof body.error).toBe("string");
		expect(body.error.length).toBeGreaterThan(0);
	});

	test("400 on inlineWorkflow with no gates", async () => {
		const projectId = await defaultProjectId();
		const resp = await createGoalRaw({
			title: `Inline No Gates ${Date.now()}`,
			cwd: nonGitCwd(),
			projectId,
			autoStartTeam: false,
			inlineWorkflow: { id: "x", name: "X", gates: [] },
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.field).toBe("inlineWorkflow");
		expect(body.error.toLowerCase()).toContain("gates");
	});

	test("400 on inlineWorkflow with duplicate gate ids", async () => {
		const projectId = await defaultProjectId();
		const resp = await createGoalRaw({
			title: `Inline Dupe Gates ${Date.now()}`,
			cwd: nonGitCwd(),
			projectId,
			autoStartTeam: false,
			inlineWorkflow: {
				id: "dupe", name: "Dupe", gates: [
					{ id: "charter", name: "Charter" },
					{ id: "charter", name: "Charter Again" },
				],
			},
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.field).toBe("inlineWorkflow");
		expect(body.error.toLowerCase()).toContain("duplicate");
	});

	test("400 on inlineWorkflow with dependsOn pointing at unknown gate", async () => {
		const projectId = await defaultProjectId();
		const resp = await createGoalRaw({
			title: `Inline Bad Dep ${Date.now()}`,
			cwd: nonGitCwd(),
			projectId,
			autoStartTeam: false,
			inlineWorkflow: {
				id: "bad-dep", name: "Bad Dep", gates: [
					{ id: "charter", name: "Charter", dependsOn: ["does-not-exist"] },
				],
			},
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.field).toBe("inlineWorkflow");
		expect(body.error.toLowerCase()).toContain("unknown");
	});

	test("400 on inlineWorkflow with self-dependency", async () => {
		const projectId = await defaultProjectId();
		const resp = await createGoalRaw({
			title: `Inline Self Dep ${Date.now()}`,
			cwd: nonGitCwd(),
			projectId,
			autoStartTeam: false,
			inlineWorkflow: {
				id: "self", name: "Self", gates: [
					{ id: "charter", name: "Charter", dependsOn: ["charter"] },
				],
			},
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.field).toBe("inlineWorkflow");
		expect(body.error.toLowerCase()).toMatch(/itself|self/);
	});

	test("400 on inlineRoles with role missing prompt", async () => {
		const projectId = await defaultProjectId();
		const resp = await createGoalRaw({
			title: `Inline Roles No Prompt ${Date.now()}`,
			cwd: nonGitCwd(),
			projectId,
			autoStartTeam: false,
			inlineRoles: {
				coder: { label: "Coder" },
			},
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.field).toBe("inlineRoles");
		expect(body.error.toLowerCase()).toContain("prompt");
	});

	test("400 on inlineRoles with bad role-name pattern", async () => {
		const projectId = await defaultProjectId();
		const resp = await createGoalRaw({
			title: `Inline Roles Bad Name ${Date.now()}`,
			cwd: nonGitCwd(),
			projectId,
			autoStartTeam: false,
			inlineRoles: {
				"BAD NAME": { promptTemplate: "..." },
			},
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.field).toBe("inlineRoles");
	});

	test("happy path: valid inlineWorkflow + inlineRoles is persisted on the goal", async () => {
		const projectId = await defaultProjectId();
		const resp = await createGoalRaw({
			title: `Inline Happy ${Date.now()}`,
			cwd: nonGitCwd(),
			projectId,
			autoStartTeam: false,
			inlineWorkflow: VALID_WORKFLOW,
			inlineRoles: VALID_ROLES,
		});
		expect(resp.status).toBe(201);
		const goal = await resp.json();
		expect(goal.id).toBeTruthy();
		// Server snapshots inline definitions onto the goal record verbatim.
		expect(goal.inlineWorkflow).toEqual(VALID_WORKFLOW);
		expect(goal.inlineRoles).toEqual(VALID_ROLES);

		// Round-trip via GET /api/goals/:id.
		const fetched = await apiFetch(`/api/goals/${goal.id}`);
		expect(fetched.status).toBe(200);
		const detail = await fetched.json();
		const fetchedGoal = detail.goal ?? detail;
		expect(fetchedGoal.inlineWorkflow).toEqual(VALID_WORKFLOW);
		expect(fetchedGoal.inlineRoles).toEqual(VALID_ROLES);

		await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" }).catch(() => { });
	});

	test("happy path: omitting inline fields creates a goal without them", async () => {
		const projectId = await defaultProjectId();
		const resp = await createGoalRaw({
			title: `Inline Omitted ${Date.now()}`,
			cwd: nonGitCwd(),
			projectId,
			autoStartTeam: false,
		});
		expect(resp.status).toBe(201);
		const goal = await resp.json();
		expect(goal.inlineWorkflow).toBeUndefined();
		expect(goal.inlineRoles).toBeUndefined();
		await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" }).catch(() => { });
	});
});
