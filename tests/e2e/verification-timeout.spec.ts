/**
 * E2E API tests for verification command-step tree-kill on timeout and
 * on cancellation.
 *
 * Pins the contract laid out in docs/design (Verification command-step
 * tree-kill v2):
 *
 *   1. A `command` verification step whose `timeout` is exceeded must
 *      transition to `failed` with output ending in
 *      `timed out after Ns — killed subprocess tree`.
 *   2. A running step that is cancelled via the cancel-verification
 *      endpoint must reap the spawned subprocess tree within ~3s.
 *
 * Cross-platform: the spawned verification command is a `node -e` payload
 * that prints `PARENT_PID=<n>` and `CHILD_PID=<n>` then idles. Liveness
 * checks use `process.kill(pid, 0)` which maps to the right OS primitive
 * in Node on both Windows and POSIX. No `ps`, `pgrep`, `tasklist`, or
 * shell-specific syntax.
 */

import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, deleteGoal, defaultProjectId } from "./e2e-setup.js";
import { pollUntil as pollUntilCleanup } from "./test-utils/cleanup.js";

const TIMEOUT_WORKFLOW = `test-verif-timeout-${Date.now()}`;
const CANCEL_WORKFLOW = `test-verif-cancel-${Date.now()}`;

/**
 * Build a node-only inline payload that prints PARENT_PID and CHILD_PID
 * then idles. Works on Windows and POSIX without invoking any shell.
 * `process.argv0` from the gateway's own Node is used by `run` via the
 * builtin shell, but we wrap with `node -e "..."` so the test command
 * itself never relies on bash/cmd builtins.
 *
 * The script:
 *   - prints `PARENT_PID=<pid>`
 *   - spawns an inner `node -e "setTimeout(()=>{}, 60000)"` child
 *   - prints `CHILD_PID=<pid>`
 *   - idles for 60s
 *
 * The whole thing is base64-encoded so we never have to worry about
 * embedded quotes / shell escaping on either OS. The verification step
 * then runs `node -e "eval(Buffer.from('<b64>','base64').toString())"`.
 */
function nodeTreeRun(): string {
	const inner = [
		'process.stdout.write("PARENT_PID="+process.pid+"\\n");',
		'var c=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{}, 60000)"],{stdio:"ignore"});',
		'process.stdout.write("CHILD_PID="+c.pid+"\\n");',
		'setTimeout(()=>{}, 60000);',
	].join("");
	const b64 = Buffer.from(inner, "utf8").toString("base64");
	// Double-quoted `node -e "..."` is portable across bash and cmd.
	return `node -e "eval(Buffer.from('${b64}','base64').toString())"`;
}

async function createWorkflow(id: string, timeout: number): Promise<void> {
	const projectId = await defaultProjectId();
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			projectId,
			id,
			name: `Verification Tree-Kill ${id}`,
			description: "Verification command-step tree-kill test",
			gates: [
				{
					id: "tree-gate",
					name: "Tree Gate",
					dependsOn: [],
					verify: [
						{
							name: "Tree step",
							type: "command",
							run: nodeTreeRun(),
							timeout,
						},
					],
				},
			],
		}),
	});
	if (res.status !== 201) {
		const body = await res.text().catch(() => "<no body>");
		throw new Error(`createWorkflow(${id}) failed: ${res.status} ${body}`);
	}
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

/** Cross-platform liveness check via Node's `process.kill(pid, 0)`. */
function isAlive(pid: number): boolean {
	if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (err: any) { return err?.code === "EPERM"; }
}

/** Extract the verification signals[] off whatever shape the gate API returns. */
function extractSignals(gate: any): any[] {
	return (gate?.signals || gate?.gate?.signals || []) as any[];
}

test.describe("Verification command-step tree-kill (E2E)", () => {
	test.setTimeout(60_000);

	test.beforeAll(async () => {
		await createWorkflow(TIMEOUT_WORKFLOW, 3);
		await createWorkflow(CANCEL_WORKFLOW, 60);
	});

	test.afterAll(async () => {
		await deleteWorkflowSafe(TIMEOUT_WORKFLOW);
		await deleteWorkflowSafe(CANCEL_WORKFLOW);
	});

	test("step timeout transitions to failed with tree-kill marker and reaps descendants", async () => {
		const goal = await createGoal({
			title: `Verif Timeout ${Date.now()}`,
			workflowId: TIMEOUT_WORKFLOW,
			worktree: false,
		});
		try {
			const sigRes = await apiFetch(`/api/goals/${goal.id}/gates/tree-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "trigger timeout" }),
			});
			expect(sigRes.status).toBe(201);

			// Poll the gate until the verification settles (status != "running").
			const settled = await poll(
				() => getGateState(goal.id, "tree-gate"),
				(g: any) => {
					const sigs = extractSignals(g);
					return sigs.some((s: any) => s.verification?.status && s.verification.status !== "running");
				},
				15_000,
			);
			const sigs = extractSignals(settled);
			const latest = sigs[sigs.length - 1];
			expect(latest.verification.status).toBe("failed");
			const stepOutput = (latest.verification.steps?.[0]?.output ?? "") as string;
			expect(stepOutput).toMatch(/timed out after 3s\s+\u2014\s+killed subprocess tree/);

			// Verify the descendant node process was reaped via Node's portable
			// kill(pid, 0). The step output contains both PARENT_PID and CHILD_PID.
			const parentMatch = /PARENT_PID=(\d+)/.exec(stepOutput);
			const childMatch = /CHILD_PID=(\d+)/.exec(stepOutput);
			expect(parentMatch, `output missing PARENT_PID: ${stepOutput}`).not.toBeNull();
			expect(childMatch, `output missing CHILD_PID: ${stepOutput}`).not.toBeNull();
			const parentPid = Number(parentMatch![1]);
			const childPid = Number(childMatch![1]);

			let cleaned = !isAlive(parentPid) && !isAlive(childPid);
			await pollUntilCleanup(async () => {
				cleaned = !isAlive(parentPid) && !isAlive(childPid);
				return cleaned;
			}, { timeoutMs: 5000, intervalMs: 100, label: "timeout-tree-reaped" }).catch(() => {});
			expect(cleaned, `tree should be reaped; parent=${isAlive(parentPid)} child=${isAlive(childPid)}`).toBe(true);
		} finally {
			await deleteGoal(goal.id).catch(() => {});
		}
	});

	test("cancellation tree-kills the subprocess within ~3s", async () => {
		const goal = await createGoal({
			title: `Verif Cancel ${Date.now()}`,
			workflowId: CANCEL_WORKFLOW,
			worktree: false,
		});
		try {
			const sigRes = await apiFetch(`/api/goals/${goal.id}/gates/tree-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "trigger long" }),
			});
			expect(sigRes.status).toBe(201);

			// Wait until the verification is running AND has printed both pids.
			// Use the active-verifications endpoint — it surfaces the live step
			// `output` from the in-memory tailer, which beats waiting for the
			// gate signal verification record to be flushed back into the store.
			const readyVers = await poll(
				() => getActiveVerifications(goal.id),
				(v: any[]) => {
					const run = v.find(a => a.gateId === "tree-gate" && a.overallStatus === "running");
					const out = run?.steps?.[0]?.output ?? "";
					return /PARENT_PID=\d+/.test(out) && /CHILD_PID=\d+/.test(out);
				},
				15_000,
			);
			const runActive = readyVers.find((a: any) => a.gateId === "tree-gate" && a.overallStatus === "running");
			const startOut = runActive.steps[0].output as string;
			const parentPid = Number(/PARENT_PID=(\d+)/.exec(startOut)![1]);
			const childPid = Number(/CHILD_PID=(\d+)/.exec(startOut)![1]);
			expect(isAlive(parentPid)).toBe(true);
			expect(isAlive(childPid)).toBe(true);

			// Cancel.
			const cancelRes = await apiFetch(`/api/goals/${goal.id}/gates/tree-gate/cancel-verification`, {
				method: "POST",
			});
			expect(cancelRes.status).toBe(200);

			// Subprocess tree should be reaped within ~3s.
			let cleaned = !isAlive(parentPid) && !isAlive(childPid);
			await pollUntilCleanup(async () => {
				cleaned = !isAlive(parentPid) && !isAlive(childPid);
				return cleaned;
			}, { timeoutMs: 5000, intervalMs: 100, label: "cancel-tree-reaped" }).catch(() => {});
			expect(cleaned, `tree should be reaped after cancel; parent=${isAlive(parentPid)} child=${isAlive(childPid)}`).toBe(true);

			// And the verification should no longer be in `running`.
			await poll(
				() => getActiveVerifications(goal.id),
				(v) => !v.some((a: any) => a.gateId === "tree-gate" && a.overallStatus === "running"),
				5000,
			);
		} finally {
			await deleteGoal(goal.id).catch(() => {});
		}
	});
});
