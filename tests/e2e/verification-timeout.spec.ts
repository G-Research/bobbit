/**
 * E2E API tests for verification command-step tree-kill on timeout and
 * on cancellation.
 *
 * Pins the contract laid out in docs/design (Verification command-step
 * tree-kill v2):
 *
 *   1. A `command` verification step whose `timeout` is exceeded must:
 *      a. Transition the gate signal verification to `failed` within a
 *         small budget (we use 12s for a 3s timeout).
 *      b. Include the marker text `timed out after Ns — killed subprocess
 *         tree` in the step output.
 *      c. Leave no surviving descendant `sleep` processes tagged with
 *         our test marker (a unique env var injected into the spawned
 *         shell so we can find them via `ps`).
 *
 *   2. A running step that is cancelled via the
 *      `POST /api/goals/:goalId/gates/:gateId/cancel-verification` endpoint
 *      must reap the spawned process tree within ~3s of the cancel call.
 *
 * Skipped on Windows: the `ps -ef` scan is POSIX-only. The implementation
 * still works there (taskkill /T /F) and is covered by the unit suite.
 */

import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, deleteGoal } from "./e2e-setup.js";
import { pollUntil as pollUntilCleanup } from "./test-utils/cleanup.js";
import { execSync } from "node:child_process";

const IS_POSIX = process.platform !== "win32";
test.skip(!IS_POSIX, "ps-based assertion is POSIX-only; Windows covered in unit suite");

const TIMEOUT_WORKFLOW = `test-verif-timeout-${Date.now()}`;
const MARKER = `BOBBIT_TIMEOUT_TEST_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
const CANCEL_MARKER = `BOBBIT_CANCEL_TEST_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;

async function createTimeoutWorkflow(): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id: TIMEOUT_WORKFLOW,
			name: "Verification Timeout Test",
			description: "Single-step workflow that always exceeds its timeout",
			gates: [
				{
					id: "timeout-gate",
					name: "Timeout Gate",
					dependsOn: [],
					verify: [
						{
							name: "Times out",
							type: "command",
							// The marker is embedded as a no-op comment inside the bash
							// `-c` argument — `ps -ef` shows that argv verbatim, giving us
							// a reliable way to confirm the descendant sleep (and the
							// outer bash shell) were reaped after the tree-kill.
							run: `bash -c 'sleep 600 # ${MARKER}'`,
							timeout: 3,
						},
					],
				},
			],
		}),
	});
	expect(res.status).toBe(201);
}

async function createCancelWorkflow(): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id: TIMEOUT_WORKFLOW + "-cancel",
			name: "Verification Cancel Test",
			description: "Long-running step we cancel mid-flight",
			gates: [
				{
					id: "cancel-gate",
					name: "Cancel Gate",
					dependsOn: [],
					verify: [
						{
							name: "Long step",
							type: "command",
							run: `bash -c 'sleep 600 # ${CANCEL_MARKER}'`,
							timeout: 120,
						},
					],
				},
			],
		}),
	});
	expect(res.status).toBe(201);
}

async function deleteWorkflowSafe(id: string): Promise<void> {
	await apiFetch(`/api/workflows/${id}`, { method: "DELETE" }).catch(() => {});
}

async function getGateState(goalId: string, gateId: string): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
	expect(res.ok).toBe(true);
	return res.json();
}

async function getActiveVerifications(goalId: string): Promise<any[]> {
	const res = await apiFetch(`/api/goals/${goalId}/verifications/active`);
	expect(res.ok).toBe(true);
	return (await res.json()).verifications || [];
}

async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, budgetMs: number, intervalMs = 100): Promise<T> {
	let captured: T;
	await pollUntilCleanup(async () => {
		captured = await fn();
		return pred(captured);
	}, { timeoutMs: budgetMs, intervalMs, label: "verification-timeout E2E" });
	return captured!;
}

/** Count surviving processes whose command line contains the marker. */
function countMarkedProcs(marker: string): number {
	try {
		const out = execSync("ps -ef", { encoding: "utf8" });
		// Don't count the grep we just ran (we didn't run one), but do exclude
		// any cmd line that's only the marker substring inside another tool.
		const lines = out.split("\n").filter(l => l.includes(marker));
		return lines.length;
	} catch {
		return 0;
	}
}

test.describe("Verification command-step tree-kill (E2E)", () => {
	test.setTimeout(60_000);

	test.beforeAll(async () => {
		await createTimeoutWorkflow();
		await createCancelWorkflow();
	});

	test.afterAll(async () => {
		await deleteWorkflowSafe(TIMEOUT_WORKFLOW);
		await deleteWorkflowSafe(TIMEOUT_WORKFLOW + "-cancel");
	});

	test("step timeout transitions gate to failed with tree-kill marker", async () => {
		const goal = await createGoal({
			title: `Verif Timeout ${Date.now()}`,
			workflowId: TIMEOUT_WORKFLOW,
			worktree: false,
		});
		try {
			const sigRes = await apiFetch(`/api/goals/${goal.id}/gates/timeout-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "trigger timeout" }),
			});
			expect(sigRes.status).toBe(201);

			// Poll the gate until verification settles as failed.
			const settled = await poll(
				() => getGateState(goal.id, "timeout-gate"),
				(g: any) => {
					const sigs = g.signals || g.gate?.signals || [];
					return sigs.some((s: any) => s.verification && s.verification.status && s.verification.status !== "running");
				},
				12_000,
			);
			const sigs = settled.signals || settled.gate?.signals || [];
			const latest = sigs[sigs.length - 1];
			expect(latest.verification.status).toBe("failed");
			const stepOutput = (latest.verification.steps?.[0]?.output || "") as string;
			expect(stepOutput).toMatch(/timed out after 3s\s+\u2014\s+killed subprocess tree/);

			// No surviving marked processes within 3s of failure.
			const cleaned = await poll(
				async () => countMarkedProcs(MARKER),
				(n) => n === 0,
				3000,
			);
			expect(cleaned).toBe(0);
		} finally {
			await deleteGoal(goal.id).catch(() => {});
		}
	});

	test("cancellation tree-kills the subprocess within ~3s", async () => {
		const goal = await createGoal({
			title: `Verif Cancel ${Date.now()}`,
			workflowId: TIMEOUT_WORKFLOW + "-cancel",
			worktree: false,
		});
		try {
			const sigRes = await apiFetch(`/api/goals/${goal.id}/gates/cancel-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "trigger long" }),
			});
			expect(sigRes.status).toBe(201);

			// Wait until at least one marked sleep is running.
			await poll(async () => countMarkedProcs(CANCEL_MARKER), n => n > 0, 8000);

			// Cancel.
			const cancelRes = await apiFetch(`/api/goals/${goal.id}/gates/cancel-gate/cancel-verification`, {
				method: "POST",
			});
			expect(cancelRes.status).toBe(200);

			// Subprocess tree should be reaped within ~3s.
			const cleaned = await poll(async () => countMarkedProcs(CANCEL_MARKER), n => n === 0, 5000);
			expect(cleaned).toBe(0);

			// And the verification should no longer be in `running`.
			await poll(
				() => getActiveVerifications(goal.id),
				(v) => !v.some((a: any) => a.gateId === "cancel-gate" && a.overallStatus === "running"),
				5000,
			);
		} finally {
			await deleteGoal(goal.id).catch(() => {});
		}
	});
});
