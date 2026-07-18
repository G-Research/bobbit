/**
 * Journey: Goal → Team → Gates — v2 browser smoke
 */
import { test, expect, openApp, navigateToHash, createGoal, deleteGoal, apiFetch, defaultProjectId, createSession, deleteSession, waitForSessionStatus } from "../_helpers/journey-fixture.js";
import { seedTeamLeadHeader, connectWs, signalAndWaitForGate, startTeam, teardownTeam } from "../e2e-setup.js";
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

// Browser journey for the gate-card human sign-off handoff. The transcript is
// seeded with a real gate_inspect response from the running gateway so the test
// exercises the production renderer, shared launcher, review workspace, and
// sign-off endpoint without asking the mock LLM to synthesize a tool call.
test.describe("Journey: gate-card sign-off review handoff", () => {
	const GATE_ID = "release-approval";
	const GATE_NAME = "Release Approval";
	const STEP_NAME = "approve-release";
	const STEP_LABEL = "Approve release checklist";
	const SIGNAL_CONTENT = "# Release checklist\n\nAll release checks passed for the browser journey.";

	function workflowId(): string {
		return `gate-card-signoff-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}

	async function createSignoffWorkflow(id: string, projectId: string): Promise<void> {
		const response = await apiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify({
				projectId,
				id,
				name: "Gate Card Sign-off Journey",
				description: "Human sign-off workflow for the gate-card browser journey.",
				gates: [{
					id: GATE_ID,
					name: GATE_NAME,
					dependsOn: [],
					content: true,
					verify: [{
						name: STEP_NAME,
						type: "human-signoff",
						label: STEP_LABEL,
						prompt: "Review the submitted release checklist and approve or reject it.",
					}],
				}],
			}),
		});
		expect(response.status, `workflow creation failed: ${await response.clone().text().catch(() => "")}`).toBe(201);
	}

	async function waitForActionableInspect(goalId: string, signalId: string): Promise<any> {
		let latest: any = null;
		await expect.poll(async () => {
			const response = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/inspect?section=verification&mode=full`);
			if (!response.ok) return false;
			latest = await response.json();
			const step = latest?.steps?.find((candidate: any) => candidate?.name === STEP_NAME);
			return latest?.signalId === signalId && latest?.active === true && step?.awaitingHuman === true;
		}, {
			timeout: 15_000,
			message: "human sign-off inspect snapshot should become actionable",
		}).toBe(true);
		return latest;
	}

	function seedInspectCard(gateway: any, sessionId: string, snapshot: any): void {
		const session = gateway.sessionManager?.getSession(sessionId);
		const mockAgent = session?.rpcClient?._agent;
		if (!mockAgent || !Array.isArray(mockAgent.conversationMessages)) {
			throw new Error("gate-card sign-off journey requires the in-process mock agent transcript");
		}
		const toolCallId = `gate-inspect-signoff-${snapshot.signalId}`;
		const input = { gate_id: GATE_ID, section: "verification", mode: "full" };
		const now = Date.now();
		mockAgent.conversationMessages = [
			{
				id: `${toolCallId}-assistant`,
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name: "gate_inspect", arguments: input, input }],
				timestamp: now,
			},
			{
				id: `${toolCallId}-result`,
				role: "toolResult",
				toolCallId,
				toolName: "gate_inspect",
				isError: false,
				content: [{ type: "text", text: JSON.stringify(snapshot) }],
				timestamp: now + 1,
			},
		];
	}

	test("Start Review opens the submitted gate content with sign-off controls and approval hides the matching launcher", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		const priorHumanSignoffSkip = process.env.BOBBIT_HUMAN_SIGNOFF_SKIP;
		process.env.BOBBIT_HUMAN_SIGNOFF_SKIP = "0";
		const id = workflowId();
		const projectId = await defaultProjectId();
		expect(projectId, "gate-card sign-off journey requires a default project").toBeTruthy();
		let goalId = "";
		let sessionId = "";
		try {
			await createSignoffWorkflow(id, projectId as string);
			const goalTitle = `Gate Card Sign-off ${Date.now()}`;
			const goal = await createGoal({
				title: goalTitle,
				workflowId: id,
				projectId,
			});
			goalId = goal.id as string;
			sessionId = await createSession({ goalId, projectId });
			await waitForSessionStatus(sessionId, "idle", 30_000);

			const signalResponse = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/signal`, {
				method: "POST",
				body: JSON.stringify({ content: SIGNAL_CONTENT }),
			});
			expect(signalResponse.status, `gate signal failed: ${await signalResponse.clone().text().catch(() => "")}`).toBe(201);
			const signalId = (await signalResponse.json()).signal.id as string;
			const inspectSnapshot = await waitForActionableInspect(goalId, signalId);
			expect(inspectSnapshot.steps.find((step: any) => step.name === STEP_NAME)).toMatchObject({
				type: "human-signoff",
				awaitingHuman: true,
				humanLabel: STEP_LABEL,
			});
			seedInspectCard(gateway, sessionId, inspectSnapshot);

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });

			const gateCard = page.locator('[data-tool-name="gate_inspect"]').first();
			await expect(gateCard, "real gate_inspect tool card should render").toBeVisible({ timeout: 20_000 });
			const launcher = gateCard.getByRole("button", { name: `Start review: ${STEP_LABEL}`, exact: true });
			await expect(launcher).toBeVisible({ timeout: 15_000 });
			await launcher.click();

			const expectedTitle = `Sign-off: ${goalTitle} / ${GATE_NAME} / ${STEP_LABEL}`;
			const reviewTab = page.locator(".goal-tab-pill[data-panel-tab-kind='review']").filter({ hasText: expectedTitle });
			await expect(reviewTab, "Start Review should open the matching sign-off document tab").toBeVisible({ timeout: 20_000 });
			const reviewPane = page.locator("review-pane");
			await expect(reviewPane).toBeVisible({ timeout: 15_000 });
			await expect(reviewPane).toContainText(expectedTitle);
			await expect(page.locator("review-document").getByText("All release checks passed for the browser journey.").first()).toBeVisible({ timeout: 15_000 });
			await expect(reviewPane.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
			await expect(reviewPane.getByRole("button", { name: "Reject", exact: true })).toBeVisible();

			await reviewPane.getByRole("button", { name: "Approve", exact: true }).click();
			await expect(launcher, "matching sign-off resolution should remove the gate-card launcher").toHaveCount(0, { timeout: 15_000 });
			await expect(reviewTab, "resolved sign-off document should close").toHaveCount(0, { timeout: 15_000 });
			await expect.poll(async () => {
				const response = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}`);
				return response.ok ? (await response.json()).status : null;
			}, { timeout: 15_000, message: "Approve should resolve the real gate verification" }).toBe("passed");
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => {});
			if (goalId) await deleteGoal(goalId, true).catch(() => {});
			await apiFetch(`/api/workflows/${id}?projectId=${encodeURIComponent(projectId as string)}`, { method: "DELETE" }).catch(() => {});
			if (priorHumanSignoffSkip === undefined) delete process.env.BOBBIT_HUMAN_SIGNOFF_SKIP;
			else process.env.BOBBIT_HUMAN_SIGNOFF_SKIP = priorHumanSignoffSkip;
		}
	});
});

// Resetting a gate is also a goal lifecycle mutation when the team has already
// completed. Pin the user-visible, cross-tab path rather than relying only on
// the reset endpoint: widget, sidebar-backed goal state, and dashboard gates
// must all reconcile before either page reloads, then hydrate the same truth.
test.describe("Journey: completed goal gate reset reopens live UI", () => {
	test("reset clears Completed and updates session/sidebar/dashboard immediately, then survives reload", async ({ page, context }) => {
		test.setTimeout(120_000);
		const goal = await createGoal({
			title: `Completed Gate Reset ${Date.now()}`,
			workflowId: "test-fast",
			team: true,
			autoStartTeam: false,
		});
		const goalId = goal.id as string;
		let teamLeadId = "";
		let conn: Awaited<ReturnType<typeof connectWs>> | undefined;
		const dashboardPage = await context.newPage();
		const browserGoalState = async (targetPage: typeof page) => targetPage.evaluate((targetGoalId) => {
			const clientState = (window as any).bobbitState ?? (window as any).__bobbitState;
			return clientState?.goals?.find((candidate: any) => candidate.id === targetGoalId)?.state ?? null;
		}, goalId);
		try {
			teamLeadId = await startTeam(goalId);
			await waitForSessionStatus(teamLeadId, "idle", 30_000);
			conn = await connectWs(teamLeadId);
			for (const gateId of ["design-doc", "implementation", "ready-to-merge"]) {
				await signalAndWaitForGate(conn, goalId, gateId, {}, ["passed"], 30_000);
			}

			const completeResponse = await apiFetch(`/api/goals/${goalId}/team/complete`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(completeResponse.status, `team completion failed: ${await completeResponse.clone().text().catch(() => "")}`).toBe(200);
			await expect.poll(async () => {
				const response = await apiFetch(`/api/goals/${goalId}`);
				return response.ok ? (await response.json()).state : null;
			}, { timeout: 15_000, message: "fixture goal should be complete before reset" }).toBe("complete");

			await openApp(page);
			await navigateToHash(page, `#/session/${teamLeadId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			const pill = page.locator('[data-testid="goal-status-widget-pill"]').first();
			await expect(pill).toBeVisible({ timeout: 15_000 });
			await pill.click();
			const widgetDropdown = page.locator("#goal-status-dropdown");
			await expect(widgetDropdown.locator('[data-testid="goal-widget-completed"]')).toBeVisible({ timeout: 15_000 });
			expect(await browserGoalState(page)).toBe("complete");

			await openApp(dashboardPage);
			await navigateToHash(dashboardPage, `#/goal/${goalId}`);
			await expect(dashboardPage.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await expect(dashboardPage.locator(`[data-nav-id="goal:${goalId}"]`).first()).toBeVisible({ timeout: 15_000 });
			await dashboardPage.locator('[data-testid="tab-gates"]').first().click();
			const dashboardDesignGate = dashboardPage.locator('[data-testid="goal-dashboard-gate-row"][data-gate-id="design-doc"]').first();
			await expect(dashboardDesignGate).toHaveAttribute("data-gate-status", "passed", { timeout: 15_000 });
			expect(await browserGoalState(dashboardPage)).toBe("complete");

			const designRow = widgetDropdown.locator('[data-testid="goal-widget-gate"][data-gate-id="design-doc"]');
			await designRow.locator('[data-testid="goal-widget-gate-reset"]').click();
			await expect(page.getByText("Reset “Design Doc”?", { exact: true })).toBeVisible({ timeout: 10_000 });
			await page.keyboard.press("Enter");

			await expect(widgetDropdown.locator('[data-testid="goal-widget-completed"]'), "Completed must clear without reload").toHaveCount(0, { timeout: 15_000 });
			await expect(designRow, "reset gate should render pending in the still-open widget").toHaveAttribute("data-gate-status", "pending", { timeout: 15_000 });
			await expect.poll(() => browserGoalState(page), {
				timeout: 15_000,
				message: "session/sidebar client state should reopen without reload",
			}).toBe("in-progress");
			await expect.poll(() => browserGoalState(dashboardPage), {
				timeout: 15_000,
				message: "cross-tab dashboard client state should reopen without reload",
			}).toBe("in-progress");
			await expect(dashboardDesignGate, "cross-tab dashboard gate should reset without reload").toHaveAttribute("data-gate-status", "pending", { timeout: 15_000 });
			await expect(dashboardPage.locator(`[data-nav-id="goal:${goalId}"]`).first(), "reopened goal remains in the live sidebar").toBeVisible();

			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			const reloadedPill = page.locator('[data-testid="goal-status-widget-pill"]').first();
			await expect(reloadedPill).toBeVisible({ timeout: 15_000 });
			await reloadedPill.click();
			await expect(page.locator('#goal-status-dropdown [data-testid="goal-widget-completed"]')).toHaveCount(0);
			await expect(page.locator('#goal-status-dropdown [data-testid="goal-widget-gate"][data-gate-id="design-doc"]')).toHaveAttribute("data-gate-status", "pending", { timeout: 15_000 });

			await dashboardPage.reload({ waitUntil: "domcontentloaded" });
			await expect(dashboardPage.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await dashboardPage.locator('[data-testid="tab-gates"]').first().click();
			await expect(dashboardPage.locator('[data-testid="goal-dashboard-gate-row"][data-gate-id="design-doc"]').first()).toHaveAttribute("data-gate-status", "pending", { timeout: 15_000 });
			await expect.poll(() => browserGoalState(dashboardPage), { timeout: 15_000 }).toBe("in-progress");
		} finally {
			conn?.close();
			await dashboardPage.close().catch(() => {});
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => {});
			await teardownTeam(goalId).catch(() => {});
			await deleteGoal(goalId, true).catch(() => {});
		}
	});
});
