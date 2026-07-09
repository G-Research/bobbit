/**
 * v2 integration — the `human-signoff` verification step runtime.
 *
 * Ported faithfully from tests/e2e/human-signoff.spec.ts (source of truth) onto
 * the Test Suite v2 fork-scoped gateway fixture + in-process mock bridge. Pins
 * the full REST round-trip of a shipped workflow gate (the `human-signoff-test`
 * workflow ships in project.yaml):
 *   1. A workflow with a `human-signoff` step parks verification awaiting human
 *      input — `/verifications/active` exposes `awaitingHuman: true` with the
 *      substituted prompt + label.
 *   2. POST /signoff with `decision: "pass"` resolves the step; the gate
 *      transitions to `passed` and the signal verification records the approval
 *      markdown (persisted as a text/markdown artifact).
 *   3. POST /signoff with `decision: "fail", feedback: "..."` flips the gate to
 *      `failed` and persists the feedback as a markdown artifact on the step.
 *   4. A second /signoff on the same resolved step returns 409 (idempotent).
 *   5. Body validation: bad shape returns 400; unknown signal returns 404.
 *   6. `?view=summary` exposes `awaitingSignoffCount` per gate + top-level total.
 *   7. No fallback to BOBBIT_LLM_REVIEW_SKIP — a human gate parks even when the
 *      llm-review skip is set (the global E2E configuration).
 *
 * `BOBBIT_HUMAN_SIGNOFF_SKIP` is read LIVE at step-execution time by
 * verification-harness.ts (NOT frozen at gateway boot), so the legacy
 * env-manipulation approach ports verbatim: force-park by setting it to "0",
 * restore afterwards so fork-mates keep their default bypass.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createGoal, deleteGoal } from "./_e2e/e2e-setup.js";

// --- polling helpers (ported from tests/e2e/test-utils/signoff-polling.mjs) --

async function waitForAwaitingHuman(goalId: string, signalId: string, stepName: string, timeoutMs = 5_000): Promise<any> {
	const deadline = Date.now() + timeoutMs;
	let last: any = null;
	while (Date.now() < deadline) {
		const res = await apiFetch(`/api/goals/${goalId}/verifications/active`);
		if (res.ok) {
			const body = await res.json();
			const match = (body.verifications || []).find((v: any) => v.signalId === signalId);
			if (match) {
				last = match;
				const step = match.steps.find((s: any) => s.name === stepName);
				if (step?.awaitingHuman === true) return match;
			}
		}
		await new Promise(r => setTimeout(r, 50));
	}
	throw new Error(`Timed out waiting for awaitingHuman; last active=${JSON.stringify(last)}`);
}

async function waitForGateStatus(goalId: string, gateId: string, expected: "passed" | "failed", timeoutMs = 5_000): Promise<any> {
	const deadline = Date.now() + timeoutMs;
	let last: any = null;
	while (Date.now() < deadline) {
		const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
		if (res.ok) {
			last = await res.json();
			if (last?.status === expected) return last;
		}
		await new Promise(r => setTimeout(r, 50));
	}
	throw new Error(`Timed out waiting for gate ${gateId} to reach ${expected}; last=${JSON.stringify(last)}`);
}

// The gateway fixture leaves llm-review / agent-qa steps auto-passing (its boot
// config), and the compat shim sets BOBBIT_HUMAN_SIGNOFF_SKIP=1 at import so
// human gates auto-pass for unrelated specs. Force-park the steps THIS spec
// tests by setting BOBBIT_HUMAN_SIGNOFF_SKIP="0" — the explicit "do not skip"
// override that defeats the fallback. Restored after the suite so unrelated
// specs sharing the fork keep their default bypass.
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
			expect(signalBody.signal.steps).toEqual([
				{
					name: "approve-design",
					type: "human-signoff",
					status: "running",
					passed: false,
					phase: 0,
					output: "",
					duration_ms: 0,
				},
			]);

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
			// `okRes.text()` would consume the body before the subsequent `.json()`
			// call — clone for the diagnostic read.
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

	// The harness used to fall back to honouring BOBBIT_LLM_REVIEW_SKIP=1 when
	// BOBBIT_HUMAN_SIGNOFF_SKIP was unset. That fallback meant the global E2E
	// harness (which sets BOBBIT_LLM_REVIEW_SKIP=1 to auto-pass llm-review /
	// agent-qa) would silently auto-approve every human gate. Only
	// BOBBIT_HUMAN_SIGNOFF_SKIP=1 skips now; unset OR "=0" both park.
	test("no fallback to BOBBIT_LLM_REVIEW_SKIP: human-signoff parks when only the llm-review skip is set", async () => {
		// Drop the BOBBIT_HUMAN_SIGNOFF_SKIP override entirely so the harness sees
		// it as unset — the post-fix behaviour parks regardless.
		// BOBBIT_LLM_REVIEW_SKIP=1 stays set (harness default) so we're exactly
		// reproducing the global-E2E configuration.
		const priorHsSkip = process.env.BOBBIT_HUMAN_SIGNOFF_SKIP;
		const priorLlmSkip = process.env.BOBBIT_LLM_REVIEW_SKIP;
		delete process.env.BOBBIT_HUMAN_SIGNOFF_SKIP;
		process.env.BOBBIT_LLM_REVIEW_SKIP = "1";

		const workflowId = makeWorkflowId();
		await createSignoffWorkflow(workflowId);
		const goal = await createGoal({
			title: `Human Sign-off No Fallback ${Date.now()}`,
			workflowId,
		});
		const goalId = goal.id;

		try {
			const signalRes = await apiFetch(`/api/goals/${goalId}/gates/design/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "## Design\n\nNo fallback bypass." }),
			});
			expect(signalRes.status).toBe(201);
			const signalId = (await signalRes.json()).signal.id;

			// MUST park awaiting human input. If the LLM_REVIEW_SKIP fallback were
			// still in place, the step would have auto-passed before this poller
			// ever observed `awaitingHuman: true`.
			const active = await waitForAwaitingHuman(goalId, signalId, "approve-design");
			const step = active.steps.find((s: any) => s.name === "approve-design");
			expect(step.awaitingHuman).toBe(true);

			// Sanity check: the gate is NOT marked passed.
			const gatesRes = await apiFetch(`/api/goals/${goalId}/gates`);
			expect(gatesRes.ok).toBe(true);
			const gates = await gatesRes.json();
			const design = gates.gates.find((g: any) => g.id === "design");
			expect(design?.status).not.toBe("passed");

			// Clean up the parked resolver so the harness doesn't leak it.
			const okRes = await apiFetch(`/api/goals/${goalId}/gates/design/signoff`, {
				method: "POST",
				body: JSON.stringify({
					signalId,
					stepName: "approve-design",
					decision: "pass",
					feedback: "cleanup",
				}),
			});
			expect(okRes.status).toBe(200);
		} finally {
			await deleteGoal(goalId);
			await deleteSignoffWorkflow(workflowId);
			// Restore prior env so subsequent suites see their expected state.
			if (priorHsSkip === undefined) delete process.env.BOBBIT_HUMAN_SIGNOFF_SKIP;
			else process.env.BOBBIT_HUMAN_SIGNOFF_SKIP = priorHsSkip;
			if (priorLlmSkip === undefined) delete process.env.BOBBIT_LLM_REVIEW_SKIP;
			else process.env.BOBBIT_LLM_REVIEW_SKIP = priorLlmSkip;
		}
	});
});
