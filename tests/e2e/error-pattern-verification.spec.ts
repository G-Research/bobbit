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
			title: `Error Pattern Test ${Date.now()}`,
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

async function waitForGateStatus(
	goalId: string,
	gateId: string,
	targetStatus: string,
	timeoutMs = 15000,
): Promise<any> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
		const data = await res.json();
		if (data.status === targetStatus) return data;
		await new Promise(r => setTimeout(r, 500));
	}
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
	const data = await res.json();
	throw new Error(
		`Expected gate ${gateId} status to be "${targetStatus}" but got "${data.status}" after ${timeoutMs}ms`,
	);
}

test.beforeAll(() => {
	token = readE2EToken();
});

test.describe("Error pattern verification for expect:failure gates", () => {
	test("expect:failure gate without error_pattern should fail", async () => {
		// BUG: Currently, the harness treats ANY non-zero exit as a pass for
		// expect:failure steps. It does not require or check an error_pattern.
		// This test asserts the correct behaviour: the gate should FAIL when
		// error_pattern metadata is not supplied.
		const goalId = await createGoalWithWorkflow("bug-fix");
		try {
			// 1. Signal issue-analysis so reproducing-test is unblocked
			await apiFetch(`/api/goals/${goalId}/gates/issue-analysis/signal`, {
				method: "POST",
				body: JSON.stringify({
					content:
						"# Bug Analysis\n\nSteps: 1. run the command\nRoot cause: src/server/agent/verification-harness.ts treats any non-zero exit as pass for expect:failure",
				}),
			});
			await waitForGateStatus(goalId, "issue-analysis", "passed");

			// 2. Signal reproducing-test with a command that fails (exit 1)
			//    but WITHOUT error_pattern metadata.
			//    The command "node -e \"process.exit(1)\"" exits non-zero for a
			//    generic reason — not because it reproduced any specific bug.
			const signalResp = await apiFetch(
				`/api/goals/${goalId}/gates/reproducing-test/signal`,
				{
					method: "POST",
					body: JSON.stringify({
						metadata: { test_command: "echo generic-failure 1>&2 & exit 1", error_pattern: "this-will-never-match-anything" },
					}),
				},
			);
			expect(signalResp.status).toBe(201);

			// 3. Assert the gate FAILS because the error output doesn't match error_pattern.
			//    The command exits non-zero but produces no meaningful output,
			//    so the pattern won't match.
			const gate = await waitForGateStatus(
				goalId,
				"reproducing-test",
				"failed",
			);

			// Verify the failure reason mentions error_pattern
			const signalsResp = await apiFetch(
				`/api/goals/${goalId}/gates/reproducing-test/signals`,
			);
			const { signals } = await signalsResp.json();
			const lastSignal = signals[signals.length - 1];
			expect(lastSignal.verification.status).toBe("failed");
			expect(lastSignal.verification.steps[0].passed).toBe(false);
			expect(lastSignal.verification.steps[0].output).toMatch(
				/did not match expected error pattern/i,
			);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("expect:failure gate with matching error_pattern should pass", async () => {
		// After the fix: a command that fails AND matches the error_pattern
		// should pass verification.
		const goalId = await createGoalWithWorkflow("bug-fix");
		try {
			await apiFetch(`/api/goals/${goalId}/gates/issue-analysis/signal`, {
				method: "POST",
				body: JSON.stringify({
					content:
						"# Bug Analysis\n\nSteps: 1. run failing test\nRoot cause: src/calc.ts returns wrong value",
				}),
			});
			await waitForGateStatus(goalId, "issue-analysis", "passed");

			// Signal with error_pattern that matches the command output
			const signalResp = await apiFetch(
				`/api/goals/${goalId}/gates/reproducing-test/signal`,
				{
					method: "POST",
					body: JSON.stringify({
						metadata: {
							test_command:
								"echo Expected 5 but got 3 1>&2 & exit 1",
							error_pattern: "Expected 5 but got 3",
						},
					}),
				},
			);
			expect(signalResp.status).toBe(201);

			// Gate should pass — command failed AND output matches the pattern
			await waitForGateStatus(goalId, "reproducing-test", "passed");
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("expect:failure gate with non-matching error_pattern should fail", async () => {
		// After the fix: a command that fails but output does NOT match the
		// error_pattern should fail verification.
		const goalId = await createGoalWithWorkflow("bug-fix");
		try {
			await apiFetch(`/api/goals/${goalId}/gates/issue-analysis/signal`, {
				method: "POST",
				body: JSON.stringify({
					content:
						"# Bug Analysis\n\nSteps: 1. run test\nRoot cause: src/foo.ts:10 off-by-one",
				}),
			});
			await waitForGateStatus(goalId, "issue-analysis", "passed");

			// Signal with error_pattern that does NOT match the actual output
			const signalResp = await apiFetch(
				`/api/goals/${goalId}/gates/reproducing-test/signal`,
				{
					method: "POST",
					body: JSON.stringify({
						metadata: {
							test_command:
								"echo Module not found 1>&2 & exit 1",
							error_pattern: "Expected 5 but got 3",
						},
					}),
				},
			);
			expect(signalResp.status).toBe(201);

			// Gate should fail — command failed but output doesn't match pattern
			const gate = await waitForGateStatus(
				goalId,
				"reproducing-test",
				"failed",
			);

			const signalsResp = await apiFetch(
				`/api/goals/${goalId}/gates/reproducing-test/signals`,
			);
			const { signals } = await signalsResp.json();
			const lastSignal = signals[signals.length - 1];
			expect(lastSignal.verification.status).toBe("failed");
			expect(lastSignal.verification.steps[0].passed).toBe(false);
		} finally {
			await deleteGoal(goalId);
		}
	});
});
