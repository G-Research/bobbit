/**
 * `propose_goal` end-to-end — inlineWorkflow + inlineRoles preservation.
 *
 * Pins the bug fix where the goal proposal serializer hardcoded only the
 * legacy 4 frontmatter keys (title/cwd/workflow/options) and silently
 * dropped `inlineWorkflow` + `inlineRoles`. The agent's `propose_goal` call
 * succeeded with an ack rev, but the draft on disk omitted both fields and
 * the UI rendered an empty "Advanced: paste inline workflow YAML" textarea
 * with no inline-roles section.
 *
 * Coverage end-to-end:
 *   1. Seed a goal proposal directly via POST /api/sessions/:id/proposal/goal/seed
 *      (the same endpoint propose_goal calls). Read it back via GET
 *      /api/sessions/:id/proposal/goal — both fields must be present.
 *   2. Accept the proposal by issuing POST /api/goals with the same body
 *      shape the client wires up. The created goal must carry the inline
 *      workflow on goal.workflow and the inline roles on goal.inlineRoles.
 *
 * The accept-via-UI path is exercised by tests/e2e/api-goals-spawn-child-route.spec.ts
 * already; this spec focuses on the proposal pipeline (write → read).
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createSession,
	deleteGoal,
	gitCwd,
	readE2EToken,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

let token: string;

test.beforeAll(() => {
	token = readE2EToken();
});

const SAMPLE_INLINE_WORKFLOW = {
	id: "audit-mini-e2e",
	name: "Audit Mini (e2e)",
	description: "ephemeral audit-only workflow",
	gates: [
		{ id: "gather", name: "Gather Inputs", dependsOn: [] },
		{ id: "ready-to-merge", name: "Ready to Merge", dependsOn: ["gather"] },
	],
};

const SAMPLE_INLINE_ROLES = {
	"synthesis-reviewer-e2e": {
		name: "synthesis-reviewer-e2e",
		label: "Synthesis Reviewer (e2e)",
		accessory: "magnifying-glass",
		toolPolicies: { gate_signal: "never" },
		promptTemplate: "You synthesize audit findings. {{AGENT_ID}}",
	},
};

test.describe("propose_goal — inlineWorkflow + inlineRoles round-trip", () => {
	test("seed → read: both fields land in the proposal draft", async () => {
		const sessionId = await createSession({ cwd: gitCwd() });
		// Seed via the same endpoint the propose_goal extension calls.
		const seedRes = await apiFetch(`/api/sessions/${sessionId}/proposal/goal/seed`, {
			method: "POST",
			body: JSON.stringify({
				args: {
					title: "Inline e2e goal",
					spec: "## Mission\n\nTest the inline-fields round-trip through propose.",
					workflow: "feature",
					inlineWorkflow: SAMPLE_INLINE_WORKFLOW,
					inlineRoles: SAMPLE_INLINE_ROLES,
				},
			}),
		});
		expect(seedRes.status).toBe(200);
		const seedJson = await seedRes.json() as any;
		expect(seedJson.ok).toBe(true);
		expect(typeof seedJson.rev).toBe("number");

		// Read the draft back. The endpoint returns raw markdown (Content-Type:
		// text/markdown), NOT JSON — both keys must appear in the YAML
		// frontmatter.
		const readRes = await apiFetch(`/api/sessions/${sessionId}/proposal/goal`);
		expect(readRes.status).toBe(200);
		const content = await readRes.text();
		expect(content).toContain("inlineWorkflow:");
		expect(content).toContain("inlineRoles:");
		expect(content).toContain("audit-mini-e2e");
		expect(content).toContain("synthesis-reviewer-e2e");

		// Cleanup: delete the proposal draft so the test is idempotent.
		await apiFetch(`/api/sessions/${sessionId}/proposal/goal`, { method: "DELETE" });
	});

	test("accept: POST /api/goals with inlineWorkflow + inlineRoles snapshots them onto the goal", async () => {
		const r = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: `inline accept ${Date.now()}`,
				cwd: gitCwd(),
				autoStartTeam: false,
				workflowId: "feature",
				workflow: SAMPLE_INLINE_WORKFLOW,
				inlineRoles: SAMPLE_INLINE_ROLES,
			}),
		});
		expect(r.status).toBe(201);
		const goal = await r.json() as any;
		try {
			// Wait for setupStatus to settle so the persisted record is final.
			const settled = await pollUntil(
				async () => {
					const g = await apiFetch(`/api/goals/${goal.id}`);
					if (g.status !== 200) return null;
					const j = await g.json() as any;
					return j.setupStatus === "ready" ? j : null;
				},
				{ timeoutMs: 30_000, intervalMs: 100, label: `goal ${goal.id} setup ready` },
			);
			// Inline workflow snapshot lands on goal.workflow (server's existing
			// Phase 5b path; bypasses the project workflow store).
			expect(settled.workflow).toBeTruthy();
			expect(settled.workflow.id).toBe("audit-mini-e2e");
			expect(settled.workflow.gates.length).toBe(2);
			// Inline roles snapshot lands on goal.inlineRoles.
			expect(settled.inlineRoles).toBeTruthy();
			expect(settled.inlineRoles["synthesis-reviewer-e2e"].label).toBe("Synthesis Reviewer (e2e)");
			expect(settled.inlineRoles["synthesis-reviewer-e2e"].toolPolicies?.gate_signal).toBe("never");
		} finally {
			await deleteGoal(goal.id);
		}
	});
});
