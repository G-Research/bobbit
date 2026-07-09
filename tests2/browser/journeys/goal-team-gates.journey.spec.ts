/**
 * Journey: Goal → Team → Gates — v2 browser smoke
 */
import { test, expect, openApp, navigateToHash, createGoal, deleteGoal, apiFetch, defaultProjectId, createSession } from "../_helpers/journey-fixture.js";
import { seedTeamLeadHeader, connectWs, signalAndWaitForGate } from "../e2e-setup.js";
import { navigateToGoalDashboard } from "../fixtures/ui-helpers.js";

test.describe("Journey: Goal → Team → Gates", () => {
	test("goal dashboard renders after navigation", async ({ page }) => {
		const goal = await createGoal({ title: "v2-journey-smoke-goal" });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			const dashboard = page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first();
			await expect(dashboard).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("goal title visible in dashboard", async ({ page }) => {
		const title = "v2-journey-title-visible";
		const goal = await createGoal({ title });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText(title).first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("sidebar shows sidebar-edge after goal navigation", async ({ page }) => {
		const goal = await createGoal({ title: "v2-journey-sidebar-goal" });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("goal API returns goal after creation", async () => {
		const { apiFetch } = await import("../../../tests/e2e/e2e-setup.js");
		const goal = await createGoal({ title: "v2-journey-api-check" });
		try {
			const resp = await apiFetch(`/api/goals/${goal.id}`);
			expect(resp.ok).toBe(true);
			const data = await resp.json();
			expect(data.id).toBe(goal.id);
		} finally {
			await deleteGoal(goal.id, true);
		}
	});
});

// Behavioral assertions ported from plan-tab-gate-status.spec.ts
test.describe("Journey: Plan-Tab Gate-Status — behavioral assertions", () => {
	test("gate list API returns gates for a workflow-linked goal", async () => {
		const goal = await createGoal({ title: "v2-plan-gates-api-check", workflowId: "test-fast" });
		try {
			const resp = await apiFetch(`/api/goals/${goal.id}/gates`);
			expect(resp.ok).toBe(true);
			const data = await resp.json();
			expect(Array.isArray(data.gates)).toBe(true);
			expect(data.gates.length).toBeGreaterThan(0);
			const gateIds = (data.gates as Array<{ gateId: string }>).map((g) => g.gateId);
			expect(gateIds).toContain("design-doc");
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("goal dashboard shows workflow checklist for a workflow-linked goal", async ({ page }) => {
		const goal = await createGoal({ title: "v2-plan-checklist-smoke", workflowId: "test-fast" });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			// Workflow checklist items should render for a workflow-linked goal
			await expect(page.locator(".wf-checklist-item").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("plan tab renders archived child with data-archived='true'", async ({ page, gateway }) => {
		const parent = await createGoal({ title: "v2-plan-archived-parent", team: false });
		const parentId = parent.id as string;
		try {
			const r1 = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
				method: "POST",
				headers: seedTeamLeadHeader(gateway, parentId),
				body: JSON.stringify({
					planId: "p1",
					title: "Child A",
					spec: "child a spec for plan-tab gate-status journey test, padded to satisfy spec validator minimum length requirement.",
				}),
			});
			expect(r1.status).toBe(201);
			const childId = (await r1.json()).id as string;
			// Archive the child so it is sourced from /descendants
			const arch = await apiFetch(`/api/goals/${childId}?cascade=true`, { method: "DELETE" });
			expect([200, 204]).toContain(arch.status);

			await openApp(page);
			await navigateToHash(page, `#/goal/${parentId}`);
			const planTab = page.locator('[data-testid="tab-plan"]').first();
			await expect(planTab).toBeVisible({ timeout: 15_000 });
			await planTab.click();
			await expect(page.locator('[data-testid="plan-tab"]').first()).toBeVisible({ timeout: 15_000 });
			// Archived node must render with data-archived="true"
			await expect(page.locator('[data-testid="plan-node"][data-archived="true"]').first()).toBeVisible({ timeout: 20_000 });
			// Archived pill renders inside the node
			await expect(page.locator('[data-testid="plan-node-archived-pill"]').first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(parentId, true);
		}
	});

	test("route-injected gateStatus:failed renders as data-plan-gate-status on plan node", async ({ page, gateway }) => {
		test.setTimeout(90_000); // plan-tab with real goal hierarchy: parent+child create, archive, route inject
		const parent = await createGoal({ title: "v2-plan-gate-status-inject", team: false });
		const parentId = parent.id as string;
		let childId = "";
		try {
			const r1 = await apiFetch(`/api/goals/${parentId}/spawn-child`, {
				method: "POST",
				headers: seedTeamLeadHeader(gateway, parentId),
				body: JSON.stringify({
					planId: "p2",
					title: "Child B",
					spec: "child b spec for plan-tab gate-status injection journey test, padded to satisfy minimum length requirement here.",
				}),
			});
			expect(r1.status).toBe(201);
			childId = (await r1.json()).id as string;
			// Archive child so it's served from /descendants
			await apiFetch(`/api/goals/${childId}?cascade=true`, { method: "DELETE" });

			// Inject gateStatus via route mock before navigation
			await page.route(/\/api\/goals\/[^/]+\/descendants(?:\?.*)?$/, async (route, req) => {
				if (req.method() !== "GET") return route.fallback();
				const resp = await route.fetch();
				const body = await resp.json() as { goals?: Array<{ id: string; [k: string]: unknown }> };
				for (const g of body.goals ?? []) {
					if (g.id === childId) Object.assign(g, { gateStatus: "failed", mergeConflict: false });
				}
				await route.fulfill({ response: resp, json: body });
			});

			await openApp(page);
			await navigateToHash(page, `#/goal/${parentId}`);
			const planTab = page.locator('[data-testid="tab-plan"]').first();
			await expect(planTab).toBeVisible({ timeout: 15_000 });
			await planTab.click();
			await expect(page.locator('[data-testid="plan-tab"]').first()).toBeVisible({ timeout: 15_000 });

			const node = page.locator(`[data-testid="plan-node"][data-child-goal-id="${childId}"]`).first();
			await expect(node).toBeVisible({ timeout: 20_000 });
			await expect(node).toHaveAttribute("data-plan-gate-status", "failed");
			await expect(
				page.locator('[data-testid="plan-node-gate-dot"][data-gate-status="failed"]').first(),
			).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(parentId, true);
		}
	});
});

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

	function makeWorkflowId(prefix: string): string {
		return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}

	async function createCommandWorkflow(
		workflowId: string,
		projectId: string,
		gateId: string,
		gateName: string,
		stepName: string,
		cmd: string,
	): Promise<void> {
		const res = await apiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify({
				projectId,
				id: workflowId,
				name: "Gate-UX Journey Test",
				description: "One command gate for gate-verification UX journey coverage.",
				gates: [
					{ id: gateId, name: gateName, dependsOn: [], verify: [{ name: stepName, type: "command", run: cmd }] },
				],
			}),
		});
		expect(res.status, "gate-UX journey: workflow creation must succeed").toBe(201);
	}

	async function deleteWorkflow(workflowId: string): Promise<void> {
		await apiFetch(`/api/workflows/${workflowId}`, { method: "DELETE" }).catch(() => { /* best-effort */ });
	}

	// Issue #1: the gate-LIST endpoint returns a slim projection (inline step
	// output stripped) while the lazy detail/inspect path still carries the full
	// output — no behavioural regression on expand.
	test("gate-list endpoint strips inline step output; full output remains available lazily", async ({ page }) => {
		const workflowId = makeWorkflowId("slim-projection");
		const projectId = await defaultProjectId();
		expect(projectId, "must resolve a default projectId").toBeTruthy();
		await createCommandWorkflow(workflowId, projectId as string, SLIM_GATE_ID, SLIM_GATE_NAME, "Big output", BIG_OUTPUT_CMD);
		const goal = await createGoal({ title: `Slim Projection ${Date.now()}`, workflowId, projectId });
		const goalId = goal.id as string;
		try {
			const sessionId = await createSession({ goalId });
			const conn = await connectWs(sessionId);
			await signalAndWaitForGate(conn, goalId, SLIM_GATE_ID, {}, ["passed", "failed"], 60_000);

			const listRes = await apiFetch(`/api/goals/${goalId}/gates`);
			expect(listRes.status, "/gates list must respond 200").toBe(200);
			const gates = await listRes.json();
			const gateArr = (Array.isArray(gates) ? gates : gates.gates ?? []) as any[];
			const gate = gateArr.find((g: any) => g.gateId === SLIM_GATE_ID || g.id === SLIM_GATE_ID);
			const step = gate?.signals?.[0]?.verification?.steps?.[0];
			expect(step, "gate must have a completed signal step").toBeTruthy();
			expect(step.name, "step name preserved in slim projection").toBe("Big output");
			expect(["passed", "failed"]).toContain(step.status);

			// The heavy inline output must be stripped from the LIST payload.
			expect(
				JSON.stringify(gates).includes(BIG_MARKER),
				"/gates list payload MUST NOT contain full inline step output (Issue #1 slow-load root cause).",
			).toBe(false);
			expect(step.output ?? "", "slim projection blanks step.output").not.toContain(BIG_MARKER);

			// …but the full output must remain available via the lazy detail path.
			const detailRes = await apiFetch(
				`/api/goals/${goalId}/gates/${SLIM_GATE_ID}/inspect?section=verification&signal_index=-1&mode=full`,
			);
			expect(detailRes.status, "verification inspect endpoint must respond 200").toBe(200);
			expect(
				(await detailRes.text()).includes(BIG_MARKER),
				"full step output MUST remain available via the lazy detail path (no regression).",
			).toBe(true);

			// DOM smoke: dashboard still renders the gate row.
			await openApp(page);
			await navigateToGoalDashboard(page, goalId);
			await expect(
				page.locator(".wf-checklist-item").filter({ hasText: SLIM_GATE_NAME }),
			).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(goalId, true);
			await deleteWorkflow(workflowId);
		}
	});

	// Issue #2 (alive-path baseline): a verification that runs to normal
	// completion must report a terminal status and must NOT be flagged stale —
	// the stale-reconcile fix must not over-eagerly coerce a healthy verification.
	test("a completed (alive) verification is not flagged stale", async ({ page }) => {
		const workflowId = makeWorkflowId("stale-reconcile");
		const projectId = await defaultProjectId();
		expect(projectId, "must resolve a default projectId").toBeTruthy();
		await createCommandWorkflow(workflowId, projectId as string, STALE_GATE_ID, STALE_GATE_NAME, "Slow step", FAST_CMD);
		const goal = await createGoal({ title: `Stale Reconcile ${Date.now()}`, workflowId, projectId });
		const goalId = goal.id as string;
		try {
			await openApp(page);
			await navigateToGoalDashboard(page, goalId);
			await expect(
				page.locator(".wf-checklist-item").filter({ hasText: STALE_GATE_NAME }),
			).toBeVisible({ timeout: 15_000 });

			const sessionId = await createSession({ goalId });
			const conn = await connectWs(sessionId);
			await signalAndWaitForGate(conn, goalId, STALE_GATE_ID, {}, ["passed", "failed"], 60_000);

			const sumRes = await apiFetch(`/api/goals/${goalId}/gates/${STALE_GATE_ID}?view=summary`);
			expect(sumRes.status, "gate summary must respond 200").toBe(200);
			const summary = await sumRes.json();
			expect(
				["passed", "failed"],
				"completed verification must report a terminal status",
			).toContain(summary?.latestSignal?.verification?.status);
			expect(
				Boolean(summary?.latestSignal?.verification?.stale),
				"a healthy completed verification must NOT be flagged stale",
			).toBe(false);
		} finally {
			await deleteGoal(goalId, true);
			await deleteWorkflow(workflowId);
		}
	});
});
