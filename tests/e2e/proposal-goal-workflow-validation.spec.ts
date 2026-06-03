/**
 * API E2E — the goal-proposal seed endpoint validates `workflow` / `options`
 * against the project's configured workflows BEFORE persisting a draft.
 *
 * See docs/design — "Validate goal workflow at proposal time".
 *
 * The harness default project is seeded with `testWorkflows()` (general,
 * feature, bug-fix, …), whose `implementation` gate carries an `optional: true`
 * verify step named "QA testing" (toggle label "Enable QA Testing"). We use
 * those directly so the test needs no project.yaml writes or reload polling.
 *
 * Acceptance:
 *   - seed { workflow: "does-not-exist" }            → 400 UNKNOWN_WORKFLOW (+ availableWorkflows)
 *   - seed { workflow: "feature", options: "bad" }   → 400 UNKNOWN_OPTIONAL_STEP (+ validOptionalSteps)
 *   - seed { workflow: "feature", options: "QA testing" } → 200 { ok: true }
 *   - seed { workflow: "feature" } / omitted workflow → 200 (no false rejection)
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, deleteSession } from "./e2e-setup.js";

async function seedGoal(sid: string, args: Record<string, unknown>): Promise<Response> {
	return apiFetch(`/api/sessions/${sid}/proposal/goal/seed`, {
		method: "POST",
		body: JSON.stringify({ args }),
	});
}

test.describe("goal proposal — workflow validation @smoke", () => {
	let sid: string;

	test.beforeAll(async () => {
		// createSession injects the harness default projectId (which has workflows).
		sid = await createSession();
	});

	test.afterAll(async () => {
		await deleteSession(sid);
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

	test("the optional toggle-label alias is also accepted → 200", async () => {
		const r = await seedGoal(sid, { title: "G", spec: "body\n", workflow: "feature", options: "Enable QA Testing" });
		expect(r.status).toBe(200);
	});

	test("valid workflow with no options → 200 (no false rejection)", async () => {
		const r = await seedGoal(sid, { title: "G", spec: "body\n", workflow: "feature" });
		expect(r.status).toBe(200);
		expect((await r.json()).ok).toBe(true);
	});

	test("omitted workflow is NOT an error (UI supplies the default) → 200", async () => {
		const r = await seedGoal(sid, { title: "G", spec: "body\n" });
		expect(r.status).toBe(200);
	});
});
