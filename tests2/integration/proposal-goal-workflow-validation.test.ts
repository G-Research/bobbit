/**
 * Goal proposal workflow-validation and parent-injection route contract.
 *
 * The broad gateway router is covered elsewhere. These declarations use the
 * production goal proposal seed core behind a route-shaped fixture whose
 * project contexts, workflow stores, sessions, parents, preferences, and draft
 * state are all suite-owned in memory.
 */
import { beforeEach, expect, test } from "vitest";
import {
	GoalProposalRouteFixture,
	VALIDATION_PROJECT_WORKFLOWS,
} from "./_proposal-goal-route-fixture.js";

const INLINE_WORKFLOW = {
	id: "bespoke-seed-inline-e2e",
	name: "Bespoke Seed Inline E2E",
	description: "Inline workflow snapshot supplied directly to propose_goal seed validation.",
	gates: [
		{
			id: "issue-analysis",
			name: "Issue Analysis",
			dependsOn: [],
			verify: [{ name: "issue-check", type: "command", run: "echo issue" }],
		},
		{
			id: "implementation",
			name: "Implementation",
			dependsOn: ["issue-analysis"],
			verify: [
				{ name: "implementation-check", type: "command", run: "echo implementation" },
				{ name: "Inline QA", type: "command", run: "echo inline qa", optional: true, optionalLabel: "Enable Inline QA" },
			],
		},
		{
			id: "ready-to-merge",
			name: "Ready to Merge",
			dependsOn: ["implementation"],
			verify: [{ name: "merge-check", type: "command", run: "echo merge" }],
		},
	],
};

let route: GoalProposalRouteFixture;
let sessionId: string;
let validationProjectId: string;
let emptyProjectId: string;

beforeEach(() => {
	route = new GoalProposalRouteFixture();
	validationProjectId = route.registerProject("proposal-validation", VALIDATION_PROJECT_WORKFLOWS).id;
	emptyProjectId = route.registerProject("proposal-workflowless").id;
	sessionId = route.createSession(validationProjectId);
});

async function seedGoal(sid: string, args: Record<string, unknown>): Promise<Response> {
	return route.fetch(`/api/sessions/${sid}/proposal/goal/seed`, {
		method: "POST",
		body: JSON.stringify({ args }),
	});
}

function persistedGoalProposalFields(sid: string): Record<string, unknown> {
	const fields = route.proposalFields(sid);
	expect(fields).toBeTruthy();
	return fields!;
}

async function expectSeedOk(response: Response, message: string): Promise<Record<string, unknown>> {
	const text = await response.text();
	expect(response.status, `${message}: ${text}`).toBe(200);
	expect(text, message).not.toContain("UNKNOWN_WORKFLOW");
	const body = JSON.parse(text) as Record<string, unknown>;
	expect(body.ok).toBe(true);
	return body;
}

async function expectMissingWorkflow(response: Response): Promise<void> {
	expect(response.status).toBe(400);
	const body = await response.json();
	expect(body.ok).toBe(false);
	expect(body.code).toBe("MISSING_WORKFLOW");
	expect(Array.isArray(body.availableWorkflows)).toBe(true);
	expect(body.availableWorkflows).toEqual(expect.arrayContaining([
		expect.objectContaining({ id: "feature" }),
		expect.objectContaining({ id: "general" }),
	]));
	const ids = body.availableWorkflows.map((workflow: { id: string }) => workflow.id);
	expect(ids).toContain("feature");
	expect(ids).toContain("general");
	expect(String(body.message)).toMatch(/workflow/i);
	expect(String(body.message)).toMatch(/feature/);
	expect(String(body.message)).toMatch(/general/);
}

test.describe("goal proposal — workflow validation @smoke", () => {
	test("team-lead goal proposal auto-fills parent only when a child can be spawned", async () => {
		const parent = route.createParent(validationProjectId);
		route.setTeamLeadParent(sessionId, parent.id);
		route.setPreference("subgoalsEnabled", true);
		const seeded = await seedGoal(sessionId, {
			title: "Implicit Child",
			workflow: "feature",
			spec: "Team-lead proposal with a spawn-capable parent should become an implicit child proposal.",
		});
		expect(seeded.status).toBe(200);
		expect(persistedGoalProposalFields(sessionId).parentGoalId).toBe(parent.id);
	});

	test("team-lead goal proposal stays top-level when parent disallows subgoals", async () => {
		const parent = route.createParent(validationProjectId, false);
		route.setTeamLeadParent(sessionId, parent.id);
		route.setPreference("subgoalsEnabled", true);
		const seeded = await seedGoal(sessionId, {
			title: "Implicit Root",
			workflow: "feature",
			spec: "Team-lead proposal with subgoals disabled on the parent should remain a top-level goal proposal.",
		});
		expect(seeded.status).toBe(200);
		expect(persistedGoalProposalFields(sessionId).parentGoalId).toBeUndefined();
	});

	test("team-lead goal proposal stays top-level when system subgoals are disabled", async () => {
		const parent = route.createParent(validationProjectId);
		route.setTeamLeadParent(sessionId, parent.id);
		route.setPreference("subgoalsEnabled", false);
		const seeded = await seedGoal(sessionId, {
			title: "Implicit Root Off",
			workflow: "feature",
			spec: "Team-lead proposal with system subgoals disabled should remain a top-level goal proposal.",
		});
		expect(seeded.status).toBe(200);
		expect(persistedGoalProposalFields(sessionId).parentGoalId).toBeUndefined();
	});

	test("unknown workflow id → 400 UNKNOWN_WORKFLOW listing available ids", async () => {
		const response = await seedGoal(sessionId, { title: "G", spec: "body\n", workflow: "does-not-exist" });
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.ok).toBe(false);
		expect(body.code).toBe("UNKNOWN_WORKFLOW");
		expect(Array.isArray(body.availableWorkflows)).toBe(true);
		const ids = body.availableWorkflows.map((workflow: { id: string }) => workflow.id);
		expect(ids).toContain("feature");
		expect(ids).toContain("general");
		expect(String(body.message)).toMatch(/feature/);
	});

	test("valid inlineWorkflow only → 200 and persists inline workflow fields", async () => {
		const response = await seedGoal(sessionId, {
			title: "Inline Only Goal",
			spec: "body\n",
			inlineWorkflow: INLINE_WORKFLOW,
		});
		await expectSeedOk(response, "BESPOKE_INLINE_SEED_ONLY: inlineWorkflow should satisfy the workflow requirement");

		const fields = persistedGoalProposalFields(sessionId);
		expect(fields.workflow).toBeUndefined();
		expect(fields.inlineWorkflow).toMatchObject({
			id: INLINE_WORKFLOW.id,
			name: INLINE_WORKFLOW.name,
			gates: expect.arrayContaining([
				expect.objectContaining({ id: "issue-analysis" }),
				expect.objectContaining({ id: "implementation" }),
				expect.objectContaining({ id: "ready-to-merge" }),
			]),
		});
		expect((fields.inlineWorkflow as typeof INLINE_WORKFLOW).gates).toHaveLength(INLINE_WORKFLOW.gates.length);
	});

	test("valid inlineWorkflow plus stale workflow → 200 without UNKNOWN_WORKFLOW", async () => {
		const response = await seedGoal(sessionId, {
			title: "Inline Plus Stale Workflow Goal",
			spec: "body\n",
			workflow: "stale-workflow",
			inlineWorkflow: INLINE_WORKFLOW,
		});
		await expectSeedOk(response, "BESPOKE_INLINE_STALE_WORKFLOW: inlineWorkflow should take precedence over stale workflow ids");

		const fields = persistedGoalProposalFields(sessionId);
		expect(fields.workflow).toBe("stale-workflow");
		expect(fields.inlineWorkflow).toMatchObject({ id: INLINE_WORKFLOW.id, name: INLINE_WORKFLOW.name });
	});

	test("inlineWorkflow options are validated against inline optional step names", async () => {
		const response = await seedGoal(sessionId, {
			title: "Inline Optional Step Goal",
			spec: "body\n",
			workflow: "feature",
			inlineWorkflow: INLINE_WORKFLOW,
			options: "Inline QA",
		});
		await expectSeedOk(response, "BESPOKE_INLINE_OPTIONS: inline optional step names should be accepted even when absent from the project workflow");

		const fields = persistedGoalProposalFields(sessionId);
		expect(fields.workflow).toBe("feature");
		expect(fields.options).toBe("Inline QA");
		expect(fields.inlineWorkflow).toMatchObject({ id: INLINE_WORKFLOW.id });
	});

	test("inlineWorkflow options reject names that are not optional in the inline snapshot", async () => {
		const response = await seedGoal(sessionId, {
			title: "Inline Invalid Optional Step Goal",
			spec: "body\n",
			inlineWorkflow: INLINE_WORKFLOW,
			options: "QA testing",
		});
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.ok).toBe(false);
		expect(body.code).toBe("UNKNOWN_OPTIONAL_STEP");
		expect(body.validOptionalSteps).toEqual(["Inline QA"]);
		expect(String(body.message)).toMatch(/Inline QA/);
		expect(String(body.message)).not.toMatch(/feature/);
	});

	test("valid workflow + unknown optional step → 400 UNKNOWN_OPTIONAL_STEP", async () => {
		const response = await seedGoal(sessionId, { title: "G", spec: "body\n", workflow: "feature", options: "Not A Step" });
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.ok).toBe(false);
		expect(body.code).toBe("UNKNOWN_OPTIONAL_STEP");
		expect(Array.isArray(body.validOptionalSteps)).toBe(true);
		expect(body.validOptionalSteps).toContain("QA testing");
		expect(String(body.message)).toMatch(/QA testing/);
	});

	test("valid workflow + valid optional step → 200 ok", async () => {
		const response = await seedGoal(sessionId, { title: "G", spec: "body\n", workflow: "feature", options: "QA testing" });
		expect(response.status).toBe(200);
		expect((await response.json()).ok).toBe(true);
	});

	test("the optional toggle-LABEL (not the canonical name) is rejected → 400", async () => {
		const response = await seedGoal(sessionId, { title: "G", spec: "body\n", workflow: "feature", options: "Enable QA Testing" });
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.code).toBe("UNKNOWN_OPTIONAL_STEP");
		expect(body.validOptionalSteps).toContain("QA testing");
		expect(body.validOptionalSteps).not.toContain("Enable QA Testing");
	});

	test("valid workflow with no options → 200 (no false rejection)", async () => {
		const response = await seedGoal(sessionId, { title: "G", spec: "body\n", workflow: "feature" });
		expect(response.status).toBe(200);
		expect((await response.json()).ok).toBe(true);
	});

	test("omitted workflow → 400 MISSING_WORKFLOW listing available ids", async () => {
		await expectMissingWorkflow(await seedGoal(sessionId, { title: "G", spec: "body\n" }));
	});

	test("empty string workflow → 400 MISSING_WORKFLOW listing available ids", async () => {
		await expectMissingWorkflow(await seedGoal(sessionId, { title: "G", spec: "body\n", workflow: "" }));
	});

	test("whitespace-only workflow → 400 MISSING_WORKFLOW listing available ids", async () => {
		await expectMissingWorkflow(await seedGoal(sessionId, { title: "G", spec: "body\n", workflow: "   " }));
	});

	test("target project with no resolvable workflows skips validation → 200", async () => {
		const response = await seedGoal(sessionId, {
			title: "G",
			spec: "body\n",
			workflow: "does-not-exist",
			projectId: emptyProjectId,
		});
		expect(response.status, "workflow-less target project must skip validation").toBe(200);
		expect((await response.json()).ok).toBe(true);
	});
});
