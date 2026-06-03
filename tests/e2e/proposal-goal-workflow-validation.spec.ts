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
 *   - seed { workflow: "feature" } / omitted workflow → 200 (no false rejection)
 *   - project-less session (no workflows resolvable)  → 200 (validation skipped)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, deleteSession, rawApiFetch, readE2EToken } from "./e2e-setup.js";

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

	test("omitted workflow is NOT an error (UI supplies the default) → 200", async () => {
		const r = await seedGoal(sid, { title: "G", spec: "body\n" });
		expect(r.status).toBe(200);
	});

	test("project-less session (no resolvable workflows) skips validation → 200", async () => {
		// A tool assistant created with a bogus cwd and no projectId has
		// projectId === undefined (see role-assistant-session.spec.ts), so
		// resolveSessionWorkflows returns [] and validation is skipped — even an
		// otherwise-unknown workflow id must NOT be rejected.
		readE2EToken();
		const bogusCwd = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-projectless-wf-"));
		let projectlessSid: string | undefined;
		try {
			const created = await rawApiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ assistantType: "tool", cwd: bogusCwd }),
			});
			expect(created.status, `expected 201 project-less tool session, got ${created.status}`).toBe(201);
			projectlessSid = (await created.json()).id as string;
			expect(projectlessSid).toBeTruthy();

			const r = await seedGoal(projectlessSid, { title: "G", spec: "body\n", workflow: "does-not-exist" });
			expect(r.status, "project-less session must skip workflow validation").toBe(200);
			expect((await r.json()).ok).toBe(true);
		} finally {
			if (projectlessSid) await rawApiFetch(`/api/sessions/${projectlessSid}`, { method: "DELETE" }).catch(() => {});
			try { fs.rmSync(bogusCwd, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});
});
