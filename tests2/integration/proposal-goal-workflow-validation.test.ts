/**
 * API E2E — the goal-proposal seed endpoint validates `workflow` / `options`
 * against the project's configured workflows BEFORE persisting a draft.
 *
 * See docs/design — "Validate goal workflow at proposal time".
 *
 * The suite owns a project seeded with `testWorkflows()` (general, feature,
 * bug-fix, …), whose `implementation` gate carries an `optional: true` verify
 * step named "QA testing" (toggle label "Enable QA Testing"). Dedicated stores
 * keep validation independent of fork-global default-project mutations.
 *
 * Optional steps are matched ONLY by the canonical `step.name` — the runtime
 * (verification-logic.ts) and the UI both key on name, so the toggle label
 * ("Enable QA Testing") is intentionally rejected: accepting it would be a
 * false-success path that fails to actually enable the step.
 *
 * Acceptance:
 *   - seed { workflow: "does-not-exist" }            → 400 UNKNOWN_WORKFLOW (+ availableWorkflows)
 *   - seed { workflow: "feature", options: "bad" }   → 400 UNKNOWN_OPTIONAL_STEP (+ validOptionalSteps)
 *   - seed { workflow: "feature", options: "QA testing" } → 200 { ok: true } (canonical name)
 *   - seed { workflow: "feature", options: "Enable QA Testing" } → 400 (label NOT a valid key)
 *   - seed { workflow: "feature" }                  → 200 (no false rejection)
 *   - seed with omitted/empty workflow                → 400 MISSING_WORKFLOW (+ availableWorkflows)
 *   - target project with no workflows resolvable     → 200 (validation skipped)
 */
import { expect } from "./_e2e/in-process-harness.js";
import { afterAll, beforeAll, test } from "vitest";
import { apiFetch, createSession, deleteSession, ensureGateway } from "./_e2e/e2e-setup.js";
import {
	MINIMAL_PROPOSAL_WORKFLOWS,
	createProposalParent,
	proposalFields,
	registerProposalProject,
	releaseSharedProposalSession,
	sharedProposalSession,
	withProposalPreferenceSnapshot,
	withProposalSessionSnapshot,
} from "./_proposal-project-fixture.js";

async function seedGoal(sid: string, args: Record<string, unknown>): Promise<Response> {
	return apiFetch(`/api/sessions/${sid}/proposal/goal/seed`, {
		method: "POST",
		body: JSON.stringify({ args }),
	});
}

let proposalGateway: any;

async function persistedGoalProposalFields(sid: string): Promise<Record<string, unknown>> {
	const fields = await proposalFields(proposalGateway, sid, "goal");
	expect(fields).toBeTruthy();
	return fields!;
}

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

async function expectSeedOk(r: Response, message: string): Promise<Record<string, unknown>> {
	const text = await r.text();
	expect(r.status, `${message}: ${text}`).toBe(200);
	expect(text, message).not.toContain("UNKNOWN_WORKFLOW");
	const body = JSON.parse(text) as Record<string, unknown>;
	expect(body.ok).toBe(true);
	return body;
}

async function expectMissingWorkflow(r: Response): Promise<void> {
	expect(r.status).toBe(400);
	const b = await r.json();
	expect(b.ok).toBe(false);
	expect(b.code).toBe("MISSING_WORKFLOW");
	expect(Array.isArray(b.availableWorkflows)).toBe(true);
	expect(b.availableWorkflows).toEqual(expect.arrayContaining([
		expect.objectContaining({ id: "feature" }),
		expect.objectContaining({ id: "general" }),
	]));
	const ids = b.availableWorkflows.map((w: any) => w.id);
	expect(ids).toContain("feature");
	expect(ids).toContain("general");
	expect(String(b.message)).toMatch(/workflow/i);
	expect(String(b.message)).toMatch(/feature/);
	expect(String(b.message)).toMatch(/general/);
}

test.describe("goal proposal — workflow validation @smoke", () => {
	let sid: string;
	let gw: any;
	let validationProjectId: string;
	let validationProjectRoot: string;
	let emptyProjectId: string;
	let parent: ReturnType<typeof createProposalParent>;

	beforeAll(async () => {
		gw = await ensureGateway();
		proposalGateway = gw;
		const project = registerProposalProject(gw, {
			key: "validated",
			workflows: MINIMAL_PROPOSAL_WORKFLOWS,
		});
		validationProjectId = project.id;
		validationProjectRoot = project.rootPath;
		sid = await sharedProposalSession(gw, validationProjectId, () =>
			createSession({ cwd: validationProjectRoot, projectId: validationProjectId }));
		emptyProjectId = registerProposalProject(gw, { key: "workflowless" }).id;
		parent = createProposalParent(gw, project);
	});

	afterAll(async () => {
		try { parent?.remove(); } catch { /* setup may have stopped before the parent was fully registered */ }
		if (gw && validationProjectId) {
			await releaseSharedProposalSession(gw, validationProjectId, deleteSession);
		}
	});

	async function withTeamLeadParent(
		_title: string,
		opts: { subgoalsAllowed?: boolean },
		run: (parentId: string) => Promise<void>,
	): Promise<void> {
		const hadOverride = Object.prototype.hasOwnProperty.call(parent.record, "subgoalsAllowed");
		const originalOverride = parent.record.subgoalsAllowed;
		if (opts.subgoalsAllowed === undefined) delete parent.record.subgoalsAllowed;
		else parent.record.subgoalsAllowed = opts.subgoalsAllowed;
		try {
			await withProposalSessionSnapshot(gw, sid, { role: "team-lead", teamGoalId: parent.id }, () => run(parent.id));
		} finally {
			if (hadOverride) parent.record.subgoalsAllowed = originalOverride;
			else delete parent.record.subgoalsAllowed;
		}
	}

	test("team-lead goal proposal auto-fills parent only when a child can be spawned", async () => {
		await withProposalPreferenceSnapshot(gw, "subgoalsEnabled", true, () =>
			withTeamLeadParent(`proposal-parent-${Date.now()}`, {}, async (parentId) => {
				const seeded = await seedGoal(sid, {
					title: "Implicit Child",
					workflow: "feature",
					spec: "Team-lead proposal with a spawn-capable parent should become an implicit child proposal.",
				});
				expect(seeded.status).toBe(200);
				const fields = await persistedGoalProposalFields(sid);
				expect(fields.parentGoalId).toBe(parentId);
			}));
	});

	test("team-lead goal proposal stays top-level when parent disallows subgoals", async () => {
		await withProposalPreferenceSnapshot(gw, "subgoalsEnabled", true, () =>
			withTeamLeadParent(`proposal-parent-no-subgoals-${Date.now()}`, { subgoalsAllowed: false }, async () => {
				const seeded = await seedGoal(sid, {
					title: "Implicit Root",
					workflow: "feature",
					spec: "Team-lead proposal with subgoals disabled on the parent should remain a top-level goal proposal.",
				});
				expect(seeded.status).toBe(200);
				const fields = await persistedGoalProposalFields(sid);
				expect(fields.parentGoalId).toBeUndefined();
			}));
	});

	test("team-lead goal proposal stays top-level when system subgoals are disabled", async () => {
		await withProposalPreferenceSnapshot(gw, "subgoalsEnabled", false, () =>
			withTeamLeadParent(`proposal-parent-system-off-${Date.now()}`, {}, async () => {
				const seeded = await seedGoal(sid, {
					title: "Implicit Root Off",
					workflow: "feature",
					spec: "Team-lead proposal with system subgoals disabled should remain a top-level goal proposal.",
				});
				expect(seeded.status).toBe(200);
				const fields = await persistedGoalProposalFields(sid);
				expect(fields.parentGoalId).toBeUndefined();
			}));
	});

	test("unknown workflow id → 400 UNKNOWN_WORKFLOW listing available ids", async () => {
		const r = await seedGoal(sid, { title: "G", spec: "body\n", workflow: "does-not-exist" });
		expect(r.status).toBe(400);
		const b = await r.json();
		expect(b.ok).toBe(false);
		expect(b.code).toBe("UNKNOWN_WORKFLOW");
		expect(Array.isArray(b.availableWorkflows)).toBe(true);
		const ids = b.availableWorkflows.map((w: any) => w.id);
		expect(ids).toContain("feature");
		expect(ids).toContain("general");
		expect(String(b.message)).toMatch(/feature/);
	});

	test("valid inlineWorkflow only → 200 and persists inline workflow fields", async () => {
		const r = await seedGoal(sid, {
			title: "Inline Only Goal",
			spec: "body\n",
			inlineWorkflow: INLINE_WORKFLOW,
		});
		await expectSeedOk(r, "BESPOKE_INLINE_SEED_ONLY: inlineWorkflow should satisfy the workflow requirement");

		const fields = await persistedGoalProposalFields(sid);
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
		expect((fields.inlineWorkflow as any).gates).toHaveLength(INLINE_WORKFLOW.gates.length);
	});

	test("valid inlineWorkflow plus stale workflow → 200 without UNKNOWN_WORKFLOW", async () => {
		const r = await seedGoal(sid, {
			title: "Inline Plus Stale Workflow Goal",
			spec: "body\n",
			workflow: "stale-workflow",
			inlineWorkflow: INLINE_WORKFLOW,
		});
		await expectSeedOk(r, "BESPOKE_INLINE_STALE_WORKFLOW: inlineWorkflow should take precedence over stale workflow ids");

		const fields = await persistedGoalProposalFields(sid);
		expect(fields.workflow).toBe("stale-workflow");
		expect(fields.inlineWorkflow).toMatchObject({ id: INLINE_WORKFLOW.id, name: INLINE_WORKFLOW.name });
	});

	test("inlineWorkflow options are validated against inline optional step names", async () => {
		const r = await seedGoal(sid, {
			title: "Inline Optional Step Goal",
			spec: "body\n",
			workflow: "feature",
			inlineWorkflow: INLINE_WORKFLOW,
			options: "Inline QA",
		});
		await expectSeedOk(r, "BESPOKE_INLINE_OPTIONS: inline optional step names should be accepted even when absent from the project workflow");

		const fields = await persistedGoalProposalFields(sid);
		expect(fields.workflow).toBe("feature");
		expect(fields.options).toBe("Inline QA");
		expect(fields.inlineWorkflow).toMatchObject({ id: INLINE_WORKFLOW.id });
	});

	test("inlineWorkflow options reject names that are not optional in the inline snapshot", async () => {
		const r = await seedGoal(sid, {
			title: "Inline Invalid Optional Step Goal",
			spec: "body\n",
			inlineWorkflow: INLINE_WORKFLOW,
			options: "QA testing",
		});
		expect(r.status).toBe(400);
		const b = await r.json();
		expect(b.ok).toBe(false);
		expect(b.code).toBe("UNKNOWN_OPTIONAL_STEP");
		expect(b.validOptionalSteps).toEqual(["Inline QA"]);
		expect(String(b.message)).toMatch(/Inline QA/);
		expect(String(b.message)).not.toMatch(/feature/);
	});

	test("valid workflow + unknown optional step → 400 UNKNOWN_OPTIONAL_STEP", async () => {
		const r = await seedGoal(sid, { title: "G", spec: "body\n", workflow: "feature", options: "Not A Step" });
		expect(r.status).toBe(400);
		const b = await r.json();
		expect(b.ok).toBe(false);
		expect(b.code).toBe("UNKNOWN_OPTIONAL_STEP");
		expect(Array.isArray(b.validOptionalSteps)).toBe(true);
		expect(b.validOptionalSteps).toContain("QA testing");
		expect(String(b.message)).toMatch(/QA testing/);
	});

	test("valid workflow + valid optional step → 200 ok", async () => {
		const r = await seedGoal(sid, { title: "G", spec: "body\n", workflow: "feature", options: "QA testing" });
		expect(r.status).toBe(200);
		expect((await r.json()).ok).toBe(true);
	});

	test("the optional toggle-LABEL (not the canonical name) is rejected → 400", async () => {
		// step.name is "QA testing" (accepted above); "Enable QA Testing" is only the
		// toggle label and is NOT a valid enable key — must be rejected, not a false 200.
		const r = await seedGoal(sid, { title: "G", spec: "body\n", workflow: "feature", options: "Enable QA Testing" });
		expect(r.status).toBe(400);
		const b = await r.json();
		expect(b.code).toBe("UNKNOWN_OPTIONAL_STEP");
		// The valid list advertises the canonical name only.
		expect(b.validOptionalSteps).toContain("QA testing");
		expect(b.validOptionalSteps).not.toContain("Enable QA Testing");
	});

	test("valid workflow with no options → 200 (no false rejection)", async () => {
		const r = await seedGoal(sid, { title: "G", spec: "body\n", workflow: "feature" });
		expect(r.status).toBe(200);
		expect((await r.json()).ok).toBe(true);
	});

	test("omitted workflow → 400 MISSING_WORKFLOW listing available ids", async () => {
		const r = await seedGoal(sid, { title: "G", spec: "body\n" });
		await expectMissingWorkflow(r);
	});

	test("empty string workflow → 400 MISSING_WORKFLOW listing available ids", async () => {
		const r = await seedGoal(sid, { title: "G", spec: "body\n", workflow: "" });
		await expectMissingWorkflow(r);
	});

	test("whitespace-only workflow → 400 MISSING_WORKFLOW listing available ids", async () => {
		const r = await seedGoal(sid, { title: "G", spec: "body\n", workflow: "   " });
		await expectMissingWorkflow(r);
	});

	test("target project with no resolvable workflows skips validation → 200", async () => {
		// When the resolved TARGET project has zero configured workflows,
		// validation is skipped entirely — even an otherwise-unknown workflow id
		// must NOT be rejected (validateGoalProposalWorkflow's empty-list branch).
		//
		// NOTE: a system-scope tool/role assistant (bogus cwd) resolves to the
		// `system` project, which the cross-project seed resolver maps to the
		// user-facing `headquarters` scope (docs/design/cross-project-proposals.md
		// §6). Headquarters carries the default workflows, so that session shape
		// now DOES validate; the target-based validation is covered in
		// cross-project-proposals.test.ts (e). Here we exercise the skip branch
		// against the suite-owned project that has no workflows at all.
		const r = await seedGoal(sid, {
			title: "G",
			spec: "body\n",
			workflow: "does-not-exist",
			projectId: emptyProjectId,
		});
		expect(r.status, "workflow-less target project must skip validation").toBe(200);
		expect((await r.json()).ok).toBe(true);
	});
});
