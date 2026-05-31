import { expect, test } from "./in-process-harness.js";
import { apiFetch, createGoal, defaultProjectId, deleteGoal } from "./e2e-setup.js";

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
	await apiFetch(`/api/workflows/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => { /* best-effort */ });
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
			expect(running.output, `${MARKER}: default inspect output must be bounded to the last 20 lines per step`).toContain("active-live-line-41");
			expect(running.output, `${MARKER}: default inspect output must not include line 40 when 60 live lines exist`).not.toContain("active-live-line-40");
			expect(running.selection, `${MARKER}: running step selection must describe the default 20-line live tail`).toMatchObject({
				mode: "tail",
				totalLines: 60,
				range: { from: 41, to: 60 },
			});

			expect(["waiting", "yet-to-run", "pending"], `${MARKER}: waiting active step must expose waiting/yet-to-run status`).toContain(waiting.status);
			expect(waiting.passed === undefined || waiting.passed === null, `${MARKER}: waiting active step must not be surfaced as final passed=false`).toBe(true);

			const tail25 = await inspectVerification(goalId, { mode: "tail", lines: 25 });
			const tailStep = tail25.steps.find((s: any) => s.name === "Live output command");
			expect(tailStep.output, `${MARKER}: explicit tail selection should allow deeper active output inspection`).toContain("active-live-line-36");
			expect(tailStep.output).not.toContain("active-live-line-35");
			expect(tailStep.selection).toMatchObject({ mode: "tail", totalLines: 60, range: { from: 36, to: 60 } });

			const slice = await inspectVerification(goalId, { mode: "slice", from: 10, to: 12 });
			const sliceStep = slice.steps.find((s: any) => s.name === "Live output command");
			expect(sliceStep.output, `${MARKER}: slice selection should work against active live output`).toMatch(/^10\b.*active-live-line-10/m);
			expect(sliceStep.output).toMatch(/^12\b.*active-live-line-12/m);
			expect(sliceStep.output).not.toContain("active-live-line-13");

			const grep = await inspectVerification(goalId, { mode: "grep", pattern: "active-live-line-5[0-2]" });
			const grepStep = grep.steps.find((s: any) => s.name === "Live output command");
			expect(grepStep.output, `${MARKER}: grep selection should work against active live output`).toContain("active-live-line-50");
			expect(grepStep.output).toContain("active-live-line-52");
			expect(grepStep.selection).toMatchObject({ mode: "grep", totalLines: 60, matchCount: 3, shownMatches: 3 });

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
			expect(statusRunning?.output, `${MARKER}: gate status detail must bound live output to the last 20 lines`).not.toContain("active-live-line-40");
			expect(["waiting", "yet-to-run", "pending"], `${MARKER}: gate status detail must agree with inspect for the waiting step`).toContain(statusWaiting?.status);
			expect(statusWaiting?.passed === undefined || statusWaiting?.passed === null, `${MARKER}: gate status waiting step must not be surfaced as final passed=false`).toBe(true);
		} finally {
			if (goalId) {
				await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/cancel-verification`, { method: "POST" }).catch(() => { /* best-effort */ });
				await deleteGoal(goalId);
			}
			await deleteWorkflow(wfId, projectId!);
		}
	});
});
