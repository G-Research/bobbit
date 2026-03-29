import { test, expect } from "./gateway-harness.js";
import { readE2EToken, base, nonGitCwd } from "./e2e-setup.js";

let token: string;

const headers = () => ({
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
});

async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
	return fetch(`${base()}${path}`, {
		...opts,
		headers: { ...headers(), ...(opts?.headers || {}) },
	});
}

async function createGoalWithWorkflow(workflowId: string): Promise<string> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `LLM Review Test ${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			workflowId,
		}),
	});
	expect(resp.status).toBe(201);
	const goal = await resp.json();
	return goal.id;
}

async function deleteGoal(goalId: string): Promise<void> {
	await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" });
}

/**
 * Poll until a gate reaches one of the target statuses or timeout expires.
 */
async function waitForGateAnyStatus(
	goalId: string,
	gateId: string,
	targetStatuses: string[],
	timeoutMs = 30_000,
): Promise<any> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
		const data = await res.json();
		if (targetStatuses.includes(data.status)) return data;
		await new Promise(r => setTimeout(r, 500));
	}
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
	const data = await res.json();
	throw new Error(
		`Gate ${gateId} did not reach any of [${targetStatuses}] within ${timeoutMs}ms. Current: "${data.status}"`,
	);
}

test.beforeAll(() => {
	token = readE2EToken();
});

test.describe("LLM Review Verification", () => {
	test("llm-review step uses skip path when BOBBIT_LLM_REVIEW_SKIP is set", async () => {
		const goalId = await createGoalWithWorkflow("general");
		try {
			// Signal the design-doc gate which has an llm-review verification step
			const signalResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({
					content: "# Design\n\nApproach: implement feature X\n\nFiles: src/x.ts\n\nCriteria: passes tests",
				}),
			});
			expect(signalResp.status).toBe(201);
			const signalData = await signalResp.json();
			expect(signalData.signal.status).toBe("running");

			// Wait for gate to pass — should be fast since skip path is instant
			const gate = await waitForGateAnyStatus(goalId, "design-doc", ["passed", "failed"]);

			// Fetch the signal details to inspect verification step output
			const signalsResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signals`);
			expect(signalsResp.status).toBe(200);
			const { signals } = await signalsResp.json();
			expect(signals.length).toBeGreaterThan(0);

			const lastSignal = signals[signals.length - 1];
			expect(lastSignal.verification.status).toMatch(/^(passed|failed)$/);
			expect(lastSignal.verification.steps.length).toBeGreaterThan(0);

			// Find the llm-review step
			const reviewStep = lastSignal.verification.steps.find(
				(s: any) => s.type === "llm-review",
			);
			expect(reviewStep).toBeTruthy();

			// Must contain the new skip message (not the old auto-pass stub)
			expect(reviewStep.output).toContain("LLM review skipped");
			expect(reviewStep.output).toContain("BOBBIT_LLM_REVIEW_SKIP");

			// Must NOT contain the old auto-pass stub text
			expect(reviewStep.output).not.toContain("auto-passed");
			expect(reviewStep.output).not.toContain("not yet implemented");
		} finally {
			await deleteGoal(goalId);
		}
	});
});
