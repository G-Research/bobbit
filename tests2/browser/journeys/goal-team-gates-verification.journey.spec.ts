/**
 * Journey: Goal gate verification projections — v2 browser smoke
 */
import {
  test,
  expect,
  openApp,
  createGoal,
  deleteGoal,
  apiFetch,
  defaultProjectId,
  createSession,
  deleteSession,
} from "../_helpers/journey-fixture.js";
import { connectWs, signalAndWaitForGate } from "../e2e-setup.js";
import { navigateToGoalDashboard } from "../fixtures/ui-helpers.js";

// ── Behavioral assertions ported from the master gate-verification-UX specs ──
// Sources: tests/e2e/ui/gate-list-slim-projection.spec.ts (Issue #1) and
// tests/e2e/ui/gate-verification-stale-reconcile.spec.ts (Issue #2 alive-path
// baseline). The stale-death scenario in the source spec is `test.fixme` there
// (needs an un-built server hook to kill an active verification without a
// completion event); only the runnable alive baseline is ported here.
test.describe("Journey: Gate-verification UX — slim projection + stale-reconcile baseline", () => {
	const SLIM_GATE_ID = "slim-gate";
	const SLIM_GATE_NAME = "Slim Projection Gate";
	const BIG_MARKER = "SLIM_PROJECTION_BIG_OUTPUT_MARKER_" + "X".repeat(2000);
	const BIG_OUTPUT_CMD = `node -e "process.stdout.write('${BIG_MARKER}');process.exit(0)"`;
	const STALE_GATE_ID = "stale-gate";
	const STALE_GATE_NAME = "Stale Reconcile Gate";
	const FAST_CMD = `node -e "process.exit(0)"`;

	function makeWorkflowId(): string {
		return `gate-ux-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}

	async function createGateUxWorkflow(workflowId: string, projectId: string): Promise<void> {
		const res = await apiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify({
				projectId,
				id: workflowId,
				name: "Gate-UX Journey Test",
				description: "Command gates for gate-verification UX journey coverage.",
				gates: [
					{ id: SLIM_GATE_ID, name: SLIM_GATE_NAME, dependsOn: [], verify: [{ name: "Big output", type: "command", run: BIG_OUTPUT_CMD }] },
					{ id: STALE_GATE_ID, name: STALE_GATE_NAME, dependsOn: [], verify: [{ name: "Slow step", type: "command", run: FAST_CMD }] },
				],
			}),
		});
		expect(res.status, "gate-UX journey: workflow creation must succeed").toBe(201);
	}

	// The two independent assertions share one deterministic workflow, goal,
	// session, and dashboard hydration. Each still signals and verifies its own
	// gate, preserving the slim-projection and healthy-completion contracts.
	test("gate list stays slim while a completed verification remains non-stale", async ({ page }) => {
		const workflowId = makeWorkflowId();
		const projectId = await defaultProjectId();
		expect(projectId, "must resolve a default projectId").toBeTruthy();
		await createGateUxWorkflow(workflowId, projectId as string);
		const goal = await createGoal({ title: `Gate UX ${Date.now()}`, workflowId, projectId });
		const goalId = goal.id as string;
		let sessionId = "";
		let conn: Awaited<ReturnType<typeof connectWs>> | undefined;
		try {
			sessionId = await createSession({ goalId });
			conn = await connectWs(sessionId);

			await openApp(page);
			await navigateToGoalDashboard(page, goalId);
			await expect(page.locator(".wf-checklist-item").filter({ hasText: SLIM_GATE_NAME })).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(".wf-checklist-item").filter({ hasText: STALE_GATE_NAME })).toBeVisible({ timeout: 15_000 });

			// Issue #1: the gate-LIST payload excludes heavy output, while the
			// lazy inspect endpoint still exposes it.
			await signalAndWaitForGate(conn, goalId, SLIM_GATE_ID, {}, ["passed", "failed"], 60_000);
			const listRes = await apiFetch(`/api/goals/${goalId}/gates`);
			expect(listRes.status, "/gates list must respond 200").toBe(200);
			const gates = await listRes.json();
			const gateArr = (Array.isArray(gates) ? gates : gates.gates ?? []) as any[];
			const gate = gateArr.find((candidate: any) => candidate.gateId === SLIM_GATE_ID || candidate.id === SLIM_GATE_ID);
			const step = gate?.signals?.[0]?.verification?.steps?.[0];
			expect(step, "gate must have a completed signal step").toBeTruthy();
			expect(step.name, "step name preserved in slim projection").toBe("Big output");
			expect(["passed", "failed"]).toContain(step.status);
			expect(
			JSON.stringify(gates).includes(BIG_MARKER),
			"/gates list payload MUST NOT contain full inline step output (Issue #1 slow-load root cause).",
		).toBe(false);
			expect(step.output ?? "", "slim projection blanks step.output").not.toContain(BIG_MARKER);
			const detailRes = await apiFetch(
				`/api/goals/${goalId}/gates/${SLIM_GATE_ID}/inspect?section=verification&signal_index=-1&mode=full`,
			);
			expect(detailRes.status, "verification inspect endpoint must respond 200").toBe(200);
			expect(
				(await detailRes.text()).includes(BIG_MARKER),
				"full step output MUST remain available via the lazy detail path (no regression).",
			).toBe(true);

			// Issue #2: a normally completed verification must be terminal but
			// never be marked stale by the reconcile path.
			await signalAndWaitForGate(conn, goalId, STALE_GATE_ID, {}, ["passed", "failed"], 60_000);
			const sumRes = await apiFetch(`/api/goals/${goalId}/gates/${STALE_GATE_ID}?view=summary`);
			expect(sumRes.status, "gate summary must respond 200").toBe(200);
			const summary = await sumRes.json();
			expect(["passed", "failed"], "completed verification must report a terminal status")
				.toContain(summary?.latestSignal?.verification?.status);
			expect(Boolean(summary?.latestSignal?.verification?.stale), "a healthy completed verification must NOT be flagged stale").toBe(false);
		} finally {
			conn?.close();
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			await deleteGoal(goalId, true);
			await apiFetch(`/api/workflows/${workflowId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("renders durable frozen-source witnesses and keeps pinned failures sanitized after reload", async ({ page }) => {
		test.setTimeout(90_000);
		const workflowId = makeWorkflowId();
		const projectId = await defaultProjectId();
		expect(projectId, "must resolve a default projectId").toBeTruthy();
		const sourceGateId = "frozen-source";
		const failureGateId = "frozen-source-failure";
		const sourceGateName = "Frozen Source Witness";
		const failureGateName = "Frozen Source Failure";
		const internalMarkers = ["/private/frozen-source", "docker://gate-container-deadbeef", "secret=do-not-expose"];
		const workflowRes = await apiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify({
				projectId,
				id: workflowId,
				name: "Frozen source diagnostic journey",
				description: "Exercises public frozen-source attestations and sanitized diagnostics.",
				gates: [
					{ id: sourceGateId, name: sourceGateName, dependsOn: [], verify: [{ name: "Read frozen source", type: "command", run: "node -e \"process.stdout.write('frozen source read')\"" }] },
					{ id: failureGateId, name: failureGateName, dependsOn: [], verify: [{ name: "Attempt frozen source mutation", type: "command", run: "node -e \"require('node:fs').writeFileSync('.bobbit-frozen-source-sentinel','tampered')\"" }] },
				],
			}),
		});
		expect(workflowRes.status, "frozen source diagnostic workflow creation must succeed").toBe(201);
		const goal = await createGoal({ title: `Frozen source diagnostics ${Date.now()}`, workflowId, projectId });
		const goalId = goal.id as string;
		let sessionId = "";
		let conn: Awaited<ReturnType<typeof connectWs>> | undefined;
		try {
			sessionId = await createSession({ goalId });
			conn = await connectWs(sessionId);
			await signalAndWaitForGate(conn, goalId, sourceGateId, {}, "passed", 60_000);
			await signalAndWaitForGate(conn, goalId, failureGateId, {}, "failed", 60_000);

			const sourceHistoryRes = await apiFetch(`/api/goals/${goalId}/gates/${sourceGateId}/signals`);
			expect(sourceHistoryRes.status, "frozen-source history endpoint must respond 200").toBe(200);
			const sourceHistory = await sourceHistoryRes.json();
			const sourceSignal = sourceHistory.signals?.[0];
			expect(sourceSignal?.contentDigest).toMatchObject({ algorithm: "sha256", version: 1, digest: "b".repeat(64), fileCount: 0 });
			expect(sourceSignal?.pinnedCheckout).toMatchObject({ version: 1, commitSha: "a".repeat(40), contentDigest: sourceSignal?.contentDigest });

			const failureHistoryRes = await apiFetch(`/api/goals/${goalId}/gates/${failureGateId}/signals`);
			expect(failureHistoryRes.status, "failed frozen-source history endpoint must respond 200").toBe(200);
			const failureHistory = await failureHistoryRes.json();
			const failureSignal = failureHistory.signals?.[0];
			expect(failureSignal?.pinnedCheckoutError, `unexpected frozen-source failure history: ${JSON.stringify(failureSignal)}`).toEqual({
				code: "PINNED_CHECKOUT_MUTATED",
				message: "Frozen verification source changed during execution.",
			});
			const apiHistory = JSON.stringify({ sourceHistory, failureHistory });
			for (const marker of internalMarkers) expect(apiHistory, `gate history API must not expose ${marker}`).not.toContain(marker);

			await openApp(page);
			await navigateToGoalDashboard(page, goalId);
			const sourceRow = page.locator(".wf-checklist-item").filter({ hasText: sourceGateName });
			await expect(sourceRow).toBeVisible({ timeout: 15_000 });
			await sourceRow.click();
			const sourceDetail = page.locator(`[data-testid="goal-dashboard-gate-detail"][data-gate-id="${sourceGateId}"]`);
			const sourceEntry = sourceDetail.getByTestId("goal-dashboard-signal-entry");
			// Opening a passed gate automatically expands its current passing signal.
			await expect(sourceEntry.getByTestId("goal-dashboard-frozen-source")).toHaveText("Frozen source verified");
			await expect(sourceEntry.getByTestId("goal-dashboard-source-digest")).toContainText(`sha256:${"b".repeat(12)}`);

			const failureRow = page.locator(".wf-checklist-item").filter({ hasText: failureGateName });
			await expect(failureRow).toBeVisible({ timeout: 15_000 });
			await failureRow.click();
			const failureDetail = page.locator(`[data-testid="goal-dashboard-gate-detail"][data-gate-id="${failureGateId}"]`);
			const failureEntry = failureDetail.getByTestId("goal-dashboard-signal-entry");
			await failureEntry.locator(".signal-entry__header").click();
			await expect(failureEntry.getByTestId("goal-dashboard-frozen-source-error")).toHaveText("Frozen source unavailable: Frozen verification source changed during execution. (PINNED_CHECKOUT_MUTATED)");
			for (const marker of internalMarkers) await expect(page.locator("body"), `rendered signal history must not expose ${marker}`).not.toContainText(marker);

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToGoalDashboard(page, goalId);
			await expect(sourceRow).toBeVisible({ timeout: 15_000 });
			await sourceRow.click();
			await expect(sourceDetail.getByTestId("goal-dashboard-source-digest")).toContainText(`sha256:${"b".repeat(12)}`);
			await expect(failureRow).toBeVisible({ timeout: 15_000 });
			await failureRow.click();
			await failureEntry.locator(".signal-entry__header").click();
			await expect(failureEntry.getByTestId("goal-dashboard-frozen-source-error")).toContainText("Frozen verification source changed during execution.");
			for (const marker of internalMarkers) await expect(page.locator("body"), `reloaded history must not expose ${marker}`).not.toContainText(marker);
		} finally {
			conn?.close();
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			await deleteGoal(goalId, true);
			await apiFetch(`/api/workflows/${workflowId}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
