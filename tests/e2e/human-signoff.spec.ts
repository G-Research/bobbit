/**
 * E2E test for the `human-signoff` verification step type.
 *
 * Pins the full REST round-trip:
 *   1. A workflow with a `human-signoff` step parks verification awaiting
 *      human input — `/verifications/active` exposes `awaitingHuman: true`
 *      with the substituted prompt + label.
 *   2. POST /signoff with `decision: "pass"` resolves the step; the gate
 *      transitions to `passed` and the signal verification records the
 *      approval markdown.
 *   3. A second signal can be sent (cascade-reset). Posting `decision: "fail",
 *      feedback: "..."` flips the gate to `failed` and persists the feedback
 *      as a markdown artifact on the step.
 *   4. Submitting `/signoff` a second time on the same resolved step returns
 *      409 — idempotent surface for racing UI clients.
 *   5. Body validation: bad shape returns 400.
 *   6. The `?view=summary` payload exposes `awaitingSignoffCount` per gate
 *      and as a top-level total while a sign-off is parked.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, deleteGoal } from "./e2e-setup.js";
import { waitForAwaitingHuman, waitForGateStatus } from "./test-utils/signoff-polling.mjs";

// The global in-process harness sets BOBBIT_LLM_REVIEW_SKIP=1 so llm-review /
// agent-qa steps auto-pass during E2E. The human-signoff branch honours that
// flag too (see verification-harness.ts), which would auto-pass the step we
// want to test. Force-park by setting BOBBIT_HUMAN_SIGNOFF_SKIP="0" — the
// explicit "do not skip" override that defeats the fallback. Restored after
// the suite so unrelated specs keep their default bypass.
let __priorHumanSignoffSkip: string | undefined;
test.beforeAll(() => {
	__priorHumanSignoffSkip = process.env.BOBBIT_HUMAN_SIGNOFF_SKIP;
	process.env.BOBBIT_HUMAN_SIGNOFF_SKIP = "0";
});
test.afterAll(() => {
	if (__priorHumanSignoffSkip === undefined) delete process.env.BOBBIT_HUMAN_SIGNOFF_SKIP;
	else process.env.BOBBIT_HUMAN_SIGNOFF_SKIP = __priorHumanSignoffSkip;
});

function makeWorkflowId(): string {
	return `signoff-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createSignoffWorkflow(workflowId: string): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id: workflowId,
			name: "Human Sign-off Test",
			description: "Inline workflow pinning the human-signoff REST flow.",
			gates: [
				{
					id: "design",
					name: "Design",
					dependsOn: [],
					content: true,
					verify: [
						{
							name: "approve-design",
							type: "human-signoff",
							label: "Approve design",
							prompt: "Review the design on branch {{branch}} and approve or reject.",
						},
					],
				},
			],
		}),
	});
	expect(res.status, `workflow POST status: ${res.status} ${await res.text().catch(() => "")}`).toBe(201);
}

async function deleteSignoffWorkflow(workflowId: string): Promise<void> {
	await apiFetch(`/api/workflows/${workflowId}`, { method: "DELETE" }).catch(() => {});
}

test.describe("human-signoff verification step", () => {
	test.setTimeout(30_000);

	test("approve flow: parked → POST /signoff pass → gate passes", async () => {
		const workflowId = makeWorkflowId();
		await createSignoffWorkflow(workflowId);
		const goal = await createGoal({
			title: `Human Sign-off Approve ${Date.now()}`,
			workflowId,
		});
		const goalId = goal.id;

		try {
			// 1. Signal the gate — verification immediately parks awaiting human.
			const signalRes = await apiFetch(`/api/goals/${goalId}/gates/design/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "## Design\n\nLooks good." }),
			});
			expect(signalRes.status, "signal POST 201").toBe(201);
			const signalBody = await signalRes.json();
			const signalId: string = signalBody.signal.id;
			expect(signalBody.signal.steps).toEqual([{ name: "approve-design", type: "human-signoff" }]);

			// 2. Poll /verifications/active until awaitingHuman appears.
			const active = await waitForAwaitingHuman(goalId, signalId, "approve-design");
			const step = active.steps.find((s: any) => s.name === "approve-design");
			expect(step.awaitingHuman).toBe(true);
			expect(step.humanLabel).toBe("Approve design");
			// Prompt should have {{branch}} substituted (or pass-through if no branch).
			expect(typeof step.humanPrompt).toBe("string");
			expect(step.humanPrompt.length).toBeGreaterThan(0);
			expect(step.humanPrompt).not.toContain("{{branch}}");

			// 3. ?view=summary surfaces awaitingSignoffCount per gate + top-level total.
			const summaryRes = await apiFetch(`/api/goals/${goalId}/gates?view=summary`);
			expect(summaryRes.ok).toBe(true);
			const summary = await summaryRes.json();
			expect(summary.awaitingSignoffCount).toBe(1);
			const designSummary = summary.gates.find((g: any) => g.gateId === "design");
			expect(designSummary?.awaitingSignoffCount).toBe(1);

			// 4. POST /signoff with pass → 200.
			const okRes = await apiFetch(`/api/goals/${goalId}/gates/design/signoff`, {
				method: "POST",
				body: JSON.stringify({
					signalId,
					stepName: "approve-design",
					decision: "pass",
					feedback: "LGTM",
				}),
			});
					// `okRes.text()` would consume the body before the subsequent
			// `.json()` call — clone for the diagnostic read.
			expect(okRes.status, `signoff POST status: ${okRes.status} ${await okRes.clone().text().catch(() => "")}`).toBe(200);
			const okBody = await okRes.json();
			expect(okBody.resolved).toBe(true);

			// 5. Gate transitions to passed; verification artifact carries the approval text.
			const gate = await waitForGateStatus(goalId, "design", "passed");
			expect(gate.status).toBe("passed");
			const sig = gate.signals.find((s: any) => s.id === signalId);
			expect(sig?.verification?.status).toBe("passed");
			const stepResult = sig?.verification?.steps?.find((s: any) => s.name === "approve-design");
			expect(stepResult.passed).toBe(true);
			expect(stepResult.type).toBe("human-signoff");
			expect(stepResult.output).toContain("Approved");
			expect(stepResult.output).toContain("LGTM");
			expect(stepResult.artifact?.contentType).toBe("text/markdown");
			expect(stepResult.artifact.content).toContain("Approved");
			expect(stepResult.artifact.content).toContain("LGTM");

			// 6. Idempotency: a second POST on the already-resolved step returns 409.
			const dupRes = await apiFetch(`/api/goals/${goalId}/gates/design/signoff`, {
				method: "POST",
				body: JSON.stringify({
					signalId,
					stepName: "approve-design",
					decision: "pass",
				}),
			});
			expect(dupRes.status, "double-resolve must surface 409").toBe(409);
			const dupBody = await dupRes.json();
			expect(dupBody.error).toMatch(/no longer awaiting human/i);

			// 7. After resolution, awaitingSignoffCount drops back to zero.
			const summary2 = await (await apiFetch(`/api/goals/${goalId}/gates?view=summary`)).json();
			expect(summary2.awaitingSignoffCount).toBe(0);
			const designSummary2 = summary2.gates.find((g: any) => g.gateId === "design");
			expect(designSummary2?.awaitingSignoffCount ?? 0).toBe(0);
		} finally {
			await deleteGoal(goalId);
			await deleteSignoffWorkflow(workflowId);
		}
	});

	test("reject flow: POST /signoff fail → gate fails with feedback persisted as markdown artifact", async () => {
		const workflowId = makeWorkflowId();
		await createSignoffWorkflow(workflowId);
		const goal = await createGoal({
			title: `Human Sign-off Reject ${Date.now()}`,
			workflowId,
		});
		const goalId = goal.id;

		try {
			const signalRes = await apiFetch(`/api/goals/${goalId}/gates/design/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "## Design\n\nFirst draft." }),
			});
			expect(signalRes.status).toBe(201);
			const signalId = (await signalRes.json()).signal.id;

			await waitForAwaitingHuman(goalId, signalId, "approve-design");

			const rejectRes = await apiFetch(`/api/goals/${goalId}/gates/design/signoff`, {
				method: "POST",
				body: JSON.stringify({
					signalId,
					stepName: "approve-design",
					decision: "fail",
					feedback: "Needs revision — the data model is wrong.",
				}),
			});
			expect(rejectRes.status).toBe(200);

			const gate = await waitForGateStatus(goalId, "design", "failed");
			expect(gate.status).toBe("failed");
			const sig = gate.signals.find((s: any) => s.id === signalId);
			expect(sig?.verification?.status).toBe("failed");
			const stepResult = sig?.verification?.steps?.find((s: any) => s.name === "approve-design");
			expect(stepResult.passed).toBe(false);
			expect(stepResult.output).toContain("Rejected");
			expect(stepResult.output).toContain("data model is wrong");
			expect(stepResult.artifact?.contentType).toBe("text/markdown");
			expect(stepResult.artifact.content).toContain("Rejected");
			expect(stepResult.artifact.content).toContain("data model is wrong");
		} finally {
			await deleteGoal(goalId);
			await deleteSignoffWorkflow(workflowId);
		}
	});

	test("body validation: bad payloads return 400", async () => {
		const workflowId = makeWorkflowId();
		await createSignoffWorkflow(workflowId);
		const goal = await createGoal({
			title: `Human Sign-off Validation ${Date.now()}`,
			workflowId,
		});
		const goalId = goal.id;

		try {
			const cases: Array<{ name: string; body: unknown }> = [
				{ name: "missing all", body: {} },
				{ name: "bad decision", body: { signalId: "x", stepName: "y", decision: "yes" } },
				{ name: "missing decision", body: { signalId: "x", stepName: "y" } },
				{ name: "non-string stepName", body: { signalId: "x", stepName: 42, decision: "pass" } },
			];
			for (const c of cases) {
				const res = await apiFetch(`/api/goals/${goalId}/gates/design/signoff`, {
					method: "POST",
					body: JSON.stringify(c.body),
				});
				expect(res.status, `case "${c.name}" should return 400`).toBe(400);
			}

			// Unknown signal returns 404 (not 400 — body shape was valid).
			const unknownRes = await apiFetch(`/api/goals/${goalId}/gates/design/signoff`, {
				method: "POST",
				body: JSON.stringify({ signalId: "nope", stepName: "approve-design", decision: "pass" }),
			});
			expect(unknownRes.status).toBe(404);
		} finally {
			await deleteGoal(goalId);
			await deleteSignoffWorkflow(workflowId);
		}
	});
});
