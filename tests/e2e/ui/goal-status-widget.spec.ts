/**
 * Browser E2E for the chat-header `<goal-status-widget>`.
 *
 * Track A (backend `human-signoff` step type + `/signoff` REST endpoint) lands
 * separately. This test mocks the two read endpoints (`/gates`,
 * `/verifications/active`) and the write endpoint (`/signoff`) via
 * `page.route()` so it runs against today's gateway without depending on the
 * backend being merged.
 *
 * Asserts:
 *  - The pill renders for a goal-scoped session.
 *  - The pill shows the pulsing red sign-off overlay when ≥1 sign-off awaits.
 *  - Clicking the pill opens a popover with gate rows + a sign-off card.
 *  - Approve POSTs `/signoff` with `decision: "pass"`, the card transitions to
 *    "Approved ✓", and the awaiting overlay clears.
 *  - Reject opens a modal with a feedback textarea; Submit is disabled while
 *    empty, enabled with text, and POSTs `decision: "fail", feedback`.
 *  - On reload the popover state rehydrates from `/verifications/active`.
 */
import { test, expect, type Page, type Route } from "../gateway-harness.js";
import { apiFetch, createGoal, createSession, deleteGoal, deleteSession, startTeam, teardownTeam, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const STEP_NAME = "approve-design";
const SIGNAL_ID = "mock-signal-1";

interface MockState {
	gates: Array<{ gateId: string; name: string; status: "pending" | "passed" | "failed" }>;
	awaiting: boolean;
}

/**
 * Install mock routes for /gates, /verifications/active, and /signoff for the
 * given goal id. Returns a setter the test can call to toggle the awaiting
 * state, plus a list of captured /signoff POST bodies.
 */
function installMocks(page: Page, goalId: string): { setState: (s: Partial<MockState>) => void; signoffCalls: Array<unknown> } {
	const state: MockState = {
		gates: [
			{ gateId: "design-doc", name: "Design Document", status: "passed" },
			{ gateId: "human-design-approval", name: "Approve Design", status: "pending" },
			{ gateId: "implementation", name: "Implementation", status: "pending" },
		],
		awaiting: true,
	};
	const signoffCalls: Array<unknown> = [];

	const setState = (patch: Partial<MockState>) => Object.assign(state, patch);

	const gatesRe = new RegExp(`/api/goals/${goalId}/gates(?:\\?.*)?$`);
	const activeRe = new RegExp(`/api/goals/${goalId}/verifications/active(?:\\?.*)?$`);
	const signoffRe = new RegExp(`/api/goals/${goalId}/gates/[^/]+/signoff$`);

	void page.route(gatesRe, async (route: Route) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ gates: state.gates }),
		});
	});

	void page.route(activeRe, async (route: Route) => {
		if (route.request().method() !== "GET") return route.fallback();
		const verifications = state.awaiting ? [{
			signalId: SIGNAL_ID,
			gateId: "human-design-approval",
			overallStatus: "running",
			steps: [{
				name: STEP_NAME,
				type: "human-signoff",
				status: "running",
				awaitingHuman: true,
				humanLabel: "Approve design doc",
				humanPrompt: "Please review the **design doc** for `feature/foo` and approve or reject.",
			}],
		}] : [];
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ verifications }),
		});
	});

	void page.route(signoffRe, async (route: Route) => {
		if (route.request().method() !== "POST") return route.fallback();
		try { signoffCalls.push(JSON.parse(route.request().postData() || "{}")); } catch { /* ignore */ }
		// Backend would clear the awaiting state and emit step_complete; we
		// simulate that by flipping the mock state before responding.
		state.awaiting = false;
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ resolved: true }),
		});
	});

	return { setState, signoffCalls };
}

async function openSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
}

test.describe("<goal-status-widget>", () => {
	test("pill renders + popover shows sign-off card; approve clears overlay; reload rehydrates", async ({ page }) => {
		const goal = await createGoal({ title: `Goal-Status-Widget ${Date.now()}` });
		const goalId = goal.id;
		let sessionId: string | undefined;
		try {
			const { signoffCalls } = installMocks(page, goalId);

			sessionId = await createSession({ goalId });

			await openApp(page);
			await openSession(page, sessionId);

			// Pill renders for the goal-scoped session.
			const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
			await expect(pill).toBeVisible({ timeout: 15_000 });

			// Pulsing overlay visible while awaiting sign-off.
			await expect(pill).toHaveAttribute("data-awaiting-signoffs", "true", { timeout: 10_000 });
			await expect(page.locator("[data-testid='goal-status-widget-awaiting']")).toBeVisible();

			// Open popover.
			await pill.click();
			await expect(page.locator("[data-testid='goal-widget-gates']")).toBeVisible({ timeout: 5_000 });

			// Gate rows render with status icons.
			const gateRows = page.locator("[data-testid='goal-widget-gate']");
			await expect(gateRows).toHaveCount(3, { timeout: 5_000 });
			await expect(gateRows.filter({ hasText: "Design Document" })).toHaveAttribute("data-gate-status", "passed");
			await expect(gateRows.filter({ hasText: "Approve Design" })).toHaveAttribute("data-gate-status", "pending");

			// Sign-off card with Approve + Reject.
			const card = page.locator("[data-testid='goal-widget-signoff']").first();
			await expect(card).toBeVisible();
			await expect(card.locator("[data-testid='goal-widget-approve']")).toBeVisible();
			await expect(card.locator("[data-testid='goal-widget-reject']")).toBeVisible();

			// Approve → POSTs /signoff, card transitions to resolved state, overlay clears.
			await card.locator("[data-testid='goal-widget-approve']").click();

			// Wait for the POST to land + state to flip.
			await expect.poll(() => signoffCalls.length, { timeout: 5_000 }).toBeGreaterThan(0);
			const approveCall = signoffCalls[0] as Record<string, unknown>;
			expect(approveCall.decision).toBe("pass");
			expect(approveCall.signalId).toBe(SIGNAL_ID);
			expect(approveCall.stepName).toBe(STEP_NAME);

			// Card flips to "Approved ✓".
			await expect(card).toContainText(/Approved/, { timeout: 5_000 });

			// Eventually the awaiting overlay clears (next /verifications/active poll
			// after the WS step_complete equivalent — we trigger via setState).
			// Closing + reopening the popover triggers an explicit refresh; the
			// toHaveAttribute assertion below polls until the refresh has landed,
			// so no manual sleep is required.
			await page.keyboard.press("Escape");
			await pill.click();
			await expect(pill).toHaveAttribute("data-awaiting-signoffs", "false", { timeout: 10_000 });

			// ── Reload — popover state must rehydrate (no awaiting since we
			//    flipped the mock above). Gate rows still render.
			await page.reload();
			await openSession(page, sessionId);
			const pillAfter = page.locator("[data-testid='goal-status-widget-pill']").first();
			await expect(pillAfter).toBeVisible({ timeout: 15_000 });
			await expect(pillAfter).toHaveAttribute("data-awaiting-signoffs", "false");
			await pillAfter.click();
			await expect(page.locator("[data-testid='goal-widget-gates']")).toBeVisible({ timeout: 5_000 });
			await expect(page.locator("[data-testid='goal-widget-signoff']")).toHaveCount(0);
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => { /* ignore */ });
			await deleteGoal(goalId).catch(() => { /* ignore */ });
			await apiFetch("/api/health").catch(() => { /* keep harness happy */ });
		}
	});

	test("reject opens modal; Submit disabled while empty; submitting POSTs feedback", async ({ page }) => {
		const goal = await createGoal({ title: `Goal-Status-Widget Reject ${Date.now()}` });
		const goalId = goal.id;
		let sessionId: string | undefined;
		try {
			const { signoffCalls } = installMocks(page, goalId);
			sessionId = await createSession({ goalId });

			await openApp(page);
			await openSession(page, sessionId);

			const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
			await expect(pill).toBeVisible({ timeout: 15_000 });
			await pill.click();

			const card = page.locator("[data-testid='goal-widget-signoff']").first();
			await expect(card).toBeVisible({ timeout: 5_000 });

			// Reject → opens modal with autofocused textarea.
			await card.locator("[data-testid='goal-widget-reject']").click();
			const textarea = page.locator("[data-testid='goal-widget-reject-textarea']");
			await expect(textarea).toBeVisible({ timeout: 5_000 });

			// Submit disabled while empty.
			const submitBtn = page.locator("[data-testid='goal-widget-reject-submit']");
			await expect(submitBtn).toBeDisabled();

			// Type feedback → Submit enables.
			await textarea.fill("Needs more detail on the resume path.");
			await expect(submitBtn).toBeEnabled();

			// Submit → POSTs decision: "fail", feedback.
			await submitBtn.click();
			await expect.poll(() => signoffCalls.length, { timeout: 5_000 }).toBeGreaterThan(0);
			const rejectCall = signoffCalls[0] as Record<string, unknown>;
			expect(rejectCall.decision).toBe("fail");
			expect(rejectCall.feedback).toBe("Needs more detail on the resume path.");

			// Modal closes on success.
			await expect(textarea).toHaveCount(0, { timeout: 5_000 });
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => { /* ignore */ });
			await deleteGoal(goalId).catch(() => { /* ignore */ });
		}
	});

	/**
	 * Regression — pin the pill's strict visibility on a REAL team-lead session
	 * (not a fixture `goalId`-only session). The original report was that the
	 * widget was invisible on team-lead sessions. A team-lead session has
	 * `teamGoalId` set (not `goalId`) — exercises the second branch of the
	 * mount gate at `AgentInterface.ts:1997`:
	 *
	 *   ${(this.goalId || this.teamGoalId) ? html`<goal-status-widget ...`}
	 *
	 * The widget receives `goalId={this.teamGoalId || this.goalId}`. We also
	 * pin visibility across reload (the prop must survive session refresh) and
	 * — when feasible — at narrow viewport widths (the overflow-math at
	 * `AgentInterface.ts:2557-2562` collapses pills, but the goal-status-widget
	 * is NOT a bg-process-pill and must never get demoted into the "more"
	 * popover).
	 */
	test("pill is strictly visible on a real team-lead session (and across reload + narrow viewport)", async ({ page }) => {
		const goal = await createGoal({
			title: `Goal-Status-Widget Team-Lead ${Date.now()}`,
			team: true,
			worktree: false,
			autoStartTeam: false,
		});
		const goalId = goal.id;
		let teamLeadId: string | undefined;
		try {
			// Install read-mock so the widget has something to render even without
			// a real workflow signal having landed. Backend still owns the routes
			// but the team-lead session is real.
			installMocks(page, goalId);

			teamLeadId = await startTeam(goalId);
			await waitForSessionStatus(teamLeadId, "idle");

			// Sanity-check the REST contract — `teamGoalId` MUST be on the session
			// serialiser response (server.ts:3411). If absent the widget's mount
			// gate fails because both `goalId` and `teamGoalId` end up empty on
			// the AgentInterface host.
			const sessionInfo = await apiFetch(`/api/sessions/${teamLeadId}`).then(r => r.json());
			expect(sessionInfo.teamGoalId, "REST /api/sessions/:id MUST expose teamGoalId for the widget to render").toBe(goalId);

			await openApp(page);
			await openSession(page, teamLeadId);

			// Strict visibility — Playwright's `toBeVisible()` requires the element
			// to be in the DOM AND have a non-zero bounding box AND not be hidden
			// via CSS (display, visibility, opacity:0) or by an ancestor. This is
			// stronger than the original PR's check and pins the team-lead path.
			const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
			await expect(pill).toBeVisible({ timeout: 15_000 });

			// Diagnostic: surface the actual prop state if the assertion above
			// ever fails — easier to debug a future regression than chasing CSS.
			const diag = await page.evaluate(() => {
				const host = document.querySelector("agent-interface") as any;
				const widget = document.querySelector("goal-status-widget") as any;
				if (!widget) return { reason: "no-widget", hostGoalId: host?.goalId, hostTeamGoalId: host?.teamGoalId };
				const rect = widget.getBoundingClientRect();
				const cs = getComputedStyle(widget);
				return {
					hostGoalId: host?.goalId ?? null,
					hostTeamGoalId: host?.teamGoalId ?? null,
					widgetGoalId: widget.goalId,
					display: cs.display,
					visibility: cs.visibility,
					opacity: cs.opacity,
					width: rect.width,
					height: rect.height,
				};
			});
			expect(diag.widgetGoalId, `widget.goalId must equal goalId (got ${JSON.stringify(diag)})`).toBe(goalId);

			// ── Visibility persists across full page reload (the prop
			//    propagation in session-manager.ts:1775-1777 / :2055-2057 must
			//    set teamGoalId during refreshSessions). This is the path the
			//    original PR test entirely skipped — its reload step navigated
			//    back through the same goalId-shortcut session.
			await page.reload();
			await openSession(page, teamLeadId);
			const pillAfterReload = page.locator("[data-testid='goal-status-widget-pill']").first();
			await expect(pillAfterReload).toBeVisible({ timeout: 15_000 });

			// ── Narrow viewport regression — the chat-header pill strip's
			//    overflow math (AgentInterface.ts:2557-2562) subtracts
			//    goal-status-widget's width from the bg-process-pill budget but
			//    the widget itself must NEVER be collapsed into the "more"
			//    popover. Resize down to a narrow width (the project's _isNarrow
			//    threshold is the chat input width — well below 640px) and
			//    re-assert strict visibility.
			await page.setViewportSize({ width: 640, height: 800 });
			await expect(pillAfterReload).toBeVisible({ timeout: 5_000 });
		} finally {
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => { /* ignore */ });
			await teardownTeam(goalId).catch(() => { /* ignore */ });
			await deleteGoal(goalId).catch(() => { /* ignore */ });
		}
	});
});
