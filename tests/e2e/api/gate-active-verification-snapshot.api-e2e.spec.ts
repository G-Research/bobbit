import { expect, test } from "../in-process-harness.js";
import { apiFetch, createGoal, defaultProjectId } from "../e2e-setup.js";

const GATE_ID = "active-snapshot-gate";
const LIVE_OUTPUT_CMD = `node -e "for (let i=1;i<=60;i++) console.log('active-live-line-'+i); setTimeout(()=>process.exit(0),30000)"`;
const FAST_FOLLOWUP_CMD = `node -e "console.log('should-not-run-before-phase-zero-finishes')"`;
const MARKER = "ACTIVE_GATE_VERIFICATION_SNAPSHOT";

function workflowId(): string {
	return `gate-active-snapshot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createWorkflow(id: string, projectId: string): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			projectId,
			id,
			name: "Active Verification Snapshot Regression",
			description: "Fixture workflow for active verification overlay regression coverage.",
			gates: [{
				id: GATE_ID,
				name: "Active Snapshot Gate",
				dependsOn: [],
				verify: [
					{ name: "Live output command", type: "command", run: LIVE_OUTPUT_CMD, phase: 0 },
					{ name: "Waiting follow-up", type: "command", run: FAST_FOLLOWUP_CMD, phase: 1 },
				],
			}],
		}),
	});
	if (res.status !== 201) {
		throw new Error(`create workflow failed: ${res.status} ${await res.text()}`);
	}
}

async function deleteWorkflow(id: string, projectId: string): Promise<void> {
	const response = await apiFetch(`/api/workflows/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" });
	const text = await response.text();
	expect(response.status, `delete workflow ${id}: ${text}`).toBe(200);
}

async function deleteGoalStrict(id: string): Promise<void> {
	const response = await apiFetch(`/api/goals/${encodeURIComponent(id)}?cascade=true`, { method: "DELETE" });
	const text = await response.text();
	expect(response.status, `delete goal ${id}: ${text}`).toBe(200);
}

async function inspectVerification(goalId: string, params: Record<string, string | number> = {}): Promise<any> {
	const qs = new URLSearchParams({ section: "verification" });
	for (const [key, value] of Object.entries(params)) qs.set(key, String(value));
	const res = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/inspect?${qs.toString()}`);
	if (res.status !== 200) {
		throw new Error(`${MARKER}: gate inspect request failed: ${res.status} ${await res.text()}`);
	}
	return res.json();
}

function durationOf(step: Record<string, unknown>): number | undefined {
	const value = step.duration_ms ?? step.durationMs;
	return typeof value === "number" ? value : undefined;
}

function selectedOutputLines(output: unknown): string[] {
	return typeof output === "string" ? output.split(/\r?\n/).filter(Boolean) : [];
}

function liveLineNumbers(output: unknown): number[] {
	return selectedOutputLines(output).flatMap((line) => {
		const match = /active-live-line-(\d+)/.exec(line);
		return match ? [Number(match[1])] : [];
	});
}

function expectExactTail(step: any, lines: number): void {
	const outputLines = selectedOutputLines(step.output);
	expect(outputLines, `${MARKER}: tail must contain exactly ${lines} retained output lines`).toHaveLength(lines);
	const liveNumbers = liveLineNumbers(step.output);
	expect(liveNumbers.at(-1), `${MARKER}: tail must retain the final live stdout line`).toBe(60);
	expect(liveNumbers).toEqual(Array.from(
		{ length: liveNumbers.length },
		(_, index) => 60 - liveNumbers.length + 1 + index,
	));
	expect(step.selection).toMatchObject({ mode: "tail" });
	expect(step.selection.range.to).toBe(step.selection.totalLines);
	expect(step.selection.range.to - step.selection.range.from + 1).toBe(lines);
}

async function waitForActiveLiveOutput(goalId: string): Promise<void> {
	await expect.poll(async () => {
		const res = await apiFetch(`/api/goals/${goalId}/verifications/active`);
		if (!res.ok) return false;
		const body = await res.json();
		const active = body.verifications?.find((v: any) => v.gateId === GATE_ID && v.overallStatus === "running");
		const running = active?.steps?.find((s: any) => s.name === "Live output command");
		const waiting = active?.steps?.find((s: any) => s.name === "Waiting follow-up");
		return running?.status === "running"
			&& typeof running.startedAt === "number"
			&& Date.now() > running.startedAt
			&& typeof running.output === "string"
			&& running.output.includes("active-live-line-60")
			&& waiting?.status === "waiting";
	}, { timeout: 10_000, intervals: [100, 200, 500] }).toBe(true);
}

test.describe("active gate verification snapshot overlay", () => {
	test("gate inspect and status detail overlay active running/waiting state instead of seeded placeholders", async () => {
		test.setTimeout(45_000);
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const wfId = workflowId();
		let goalId: string | undefined;
		try {
			await createWorkflow(wfId, projectId!);
			const goal = await createGoal({
				title: `Active Verification Snapshot ${Date.now()}`,
				workflowId: wfId,
				projectId,
				worktree: false,
			});
			goalId = goal.id;

			const signalRes = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Active snapshot regression" }),
			});
			if (signalRes.status !== 201) {
				throw new Error(`signal failed: ${signalRes.status} ${await signalRes.text()}`);
			}
			const signalBody = await signalRes.json();
			await waitForActiveLiveOutput(goalId);

			const inspect = await inspectVerification(goalId);
			expect(inspect.signalId).toBe(signalBody.signal.id);
			expect(inspect.steps, `${MARKER}: inspect must return verification steps`).toHaveLength(2);

			const running = inspect.steps.find((s: any) => s.name === "Live output command");
			const waiting = inspect.steps.find((s: any) => s.name === "Waiting follow-up");
			expect(running, `${MARKER}: inspect missing running command step`).toBeTruthy();
			expect(waiting, `${MARKER}: inspect missing waiting follow-up step`).toBeTruthy();

			expect(running.status, `${MARKER}: running active step must expose status=running, not a persisted placeholder`).toBe("running");
			expect(running.passed === undefined || running.passed === null, `${MARKER}: running active step must not be surfaced as final passed=false`).toBe(true);
			expect(durationOf(running), `${MARKER}: running active step must expose non-zero elapsed duration`).toBeGreaterThan(0);
			expect(running.output, `${MARKER}: running active command step must expose live output tail`).toContain("active-live-line-60");
			// The command runner merges stdout and stderr. Windows PowerShell may add
			// a final CLIXML diagnostic row, so assert the exact tail selection rather
			// than assuming all 20 retained rows came from stdout.
			expectExactTail(running, 20);

			expect(["waiting", "yet-to-run", "pending"], `${MARKER}: waiting active step must expose waiting/yet-to-run status`).toContain(waiting.status);
			expect(waiting.passed === undefined || waiting.passed === null, `${MARKER}: waiting active step must not be surfaced as final passed=false`).toBe(true);

			const tail25 = await inspectVerification(goalId, { mode: "tail", lines: 25 });
			const tailStep = tail25.steps.find((s: any) => s.name === "Live output command");
			expectExactTail(tailStep, 25);

			const slice = await inspectVerification(goalId, { mode: "slice", from: 10, to: 12 });
			const sliceStep = slice.steps.find((s: any) => s.name === "Live output command");
			expect(sliceStep.output, `${MARKER}: slice selection should work against active live output`).toMatch(/^10\b.*active-live-line-10/m);
			expect(sliceStep.output).toMatch(/^12\b.*active-live-line-12/m);
			expect(sliceStep.output).not.toContain("active-live-line-13");

			const grep = await inspectVerification(goalId, { mode: "grep", pattern: "active-live-line-5[0-2]" });
			const grepStep = grep.steps.find((s: any) => s.name === "Live output command");
			expect(grepStep.output, `${MARKER}: grep selection should work against active live output`).toContain("active-live-line-50");
			expect(grepStep.output).toContain("active-live-line-52");
			expect(grepStep.selection).toMatchObject({ mode: "grep", matchCount: 3, shownMatches: 3 });
			expect(grepStep.selection.totalLines).toBeGreaterThanOrEqual(60);

			const statusRes = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}?view=summary`);
			if (statusRes.status !== 200) {
				throw new Error(`${MARKER}: gate status detail request failed: ${statusRes.status} ${await statusRes.text()}`);
			}
			const statusDetail = await statusRes.json();
			expect(statusDetail.goalId, `${MARKER}: gate status summary must include goalId for live REST reconciliation`).toBe(goalId);
			const statusSteps = statusDetail.latestSignal?.verification?.steps ?? [];
			const statusRunning = statusSteps.find((s: any) => s.name === "Live output command");
			const statusWaiting = statusSteps.find((s: any) => s.name === "Waiting follow-up");
			expect(statusRunning?.status, `${MARKER}: gate status detail must agree with inspect for the running step`).toBe("running");
			expect(statusRunning?.passed === undefined || statusRunning?.passed === null, `${MARKER}: gate status running step must not be surfaced as final passed=false`).toBe(true);
			expect(durationOf(statusRunning), `${MARKER}: gate status running step must expose non-zero elapsed duration`).toBeGreaterThan(0);
			expect(statusRunning?.output, `${MARKER}: gate status detail must include bounded live output tail`).toContain("active-live-line-60");
			expect(selectedOutputLines(statusRunning?.output), `${MARKER}: gate status detail must retain exactly the default 20 lines`).toHaveLength(20);
			expect(statusRunning?.output, `${MARKER}: gate status detail must bound live output to the last 20 lines`).not.toContain("active-live-line-40");
			expect(["waiting", "yet-to-run", "pending"], `${MARKER}: gate status detail must agree with inspect for the waiting step`).toContain(statusWaiting?.status);
			expect(statusWaiting?.passed === undefined || statusWaiting?.passed === null, `${MARKER}: gate status waiting step must not be surfaced as final passed=false`).toBe(true);
		} finally {
			if (goalId) {
				const cancel = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/cancel-verification`, { method: "POST" });
				const cancelText = await cancel.text();
				expect(cancel.status, `cancel verification for ${goalId}: ${cancelText}`).toBe(200);
				await deleteGoalStrict(goalId);
			}
			await deleteWorkflow(wfId, projectId!);
		}
	});
});
