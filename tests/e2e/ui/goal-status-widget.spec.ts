/**
 * Browser E2E for the chat-header `<goal-status-widget>`.
 *
 * Sign-off content must use the review pane as the decision surface. The widget
 * stays compact: `View content` opens a review document, and approve/reject
 * decisions are submitted from the review pane.
 */
import { test, expect, type Page, type Route } from "../gateway-harness.js";
import { apiFetch, createGoal, createSession, defaultProjectId, deleteGoal, deleteSession, startTeam, teardownTeam, waitForSessionStatus } from "../e2e-setup.js";
import { waitForGateStatus } from "../test-utils/signoff-polling.mjs";
import { openApp, navigateToHash } from "./ui-helpers.js";

const STEP_NAME = "approve-design";
const STEP_LABEL = "Approve design doc";
const GATE_ID = "human-design-approval";
const GATE_NAME = "Approve Design";
const SIGNAL_ID = "mock-signal-1";
const SIGNAL_MARKDOWN = "## Design\n\nContent awaiting sign-off.";
const REVIEW_PANEL_TAB_SELECTOR = ".goal-preview-panel .goal-tab-pill[data-panel-tab-kind='review']";

interface MockState {
	gates: Array<{ gateId: string; name: string; status: "pending" | "passed" | "failed" }>;
	awaiting: boolean;
}

/**
 * Install mock routes for /gates, /verifications/active, /signals, and
 * /signoff for the given goal id. Returns captured /signoff POST bodies.
 */
async function installMocks(page: Page, goalId: string): Promise<{ setState: (s: Partial<MockState>) => void; signoffCalls: Array<Record<string, unknown>> }> {
	const state: MockState = {
		gates: [
			{ gateId: "design-doc", name: "Design Document", status: "passed" },
			{ gateId: GATE_ID, name: GATE_NAME, status: "pending" },
			{ gateId: "implementation", name: "Implementation", status: "pending" },
		],
		awaiting: true,
	};
	const signoffCalls: Array<Record<string, unknown>> = [];

	const setState = (patch: Partial<MockState>) => Object.assign(state, patch);

	const gatesRe = new RegExp(`/api/goals/${goalId}/gates(?:\\?.*)?$`);
	const activeRe = new RegExp(`/api/goals/${goalId}/verifications/active(?:\\?.*)?$`);
	const signalsRe = new RegExp(`/api/goals/${goalId}/gates/[^/]+/signals(?:\\?.*)?$`);
	const signoffRe = new RegExp(`/api/goals/${goalId}/gates/[^/]+/signoff$`);

	await page.route(gatesRe, async (route: Route) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ gates: state.gates }),
		});
	});

	await page.route(activeRe, async (route: Route) => {
		if (route.request().method() !== "GET") return route.fallback();
		const verifications = state.awaiting ? [{
			signalId: SIGNAL_ID,
			gateId: GATE_ID,
			overallStatus: "running",
			steps: [{
				name: STEP_NAME,
				type: "human-signoff",
				status: "running",
				awaitingHuman: true,
				humanLabel: STEP_LABEL,
				humanPrompt: "Please review the **design doc** for `feature/foo` and approve or reject.",
			}],
		}] : [];
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ verifications }),
		});
	});

	await page.route(signalsRe, async (route: Route) => {
		if (route.request().method() !== "GET") return route.fallback();
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				signals: [{
					id: SIGNAL_ID,
					signalId: SIGNAL_ID,
					gateId: GATE_ID,
					goalId,
					content: SIGNAL_MARKDOWN,
					verification: { status: "running", steps: [] },
				}],
			}),
		});
	});

	await page.route(signoffRe, async (route: Route) => {
		if (route.request().method() !== "POST") return route.fallback();
		try { signoffCalls.push(JSON.parse(route.request().postData() || "{}")); } catch { /* ignore */ }
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

function signoffReviewTab(page: Page) {
	return page.locator(REVIEW_PANEL_TAB_SELECTOR).filter({ hasText: /Sign-off:/ }).first();
}

function reviewPane(page: Page) {
	return page.locator("review-pane").first();
}

async function finalCommentTextarea(page: Page) {
	const pane = reviewPane(page);
	const labelled = pane.getByLabel(/final comment/i).first();
	if (await labelled.count()) return labelled;
	return pane.locator("textarea").first();
}

async function openSignoffReviewFromWidget(page: Page, goalIdentifier: string): Promise<void> {
	const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
	await expect(pill).toBeVisible({ timeout: 15_000 });
	await expect(pill).toHaveAttribute("data-awaiting-signoffs", "true", { timeout: 15_000 });
	await pill.click();

	const card = page.locator("[data-testid='goal-widget-signoff']").first();
	await expect(card).toBeVisible({ timeout: 10_000 });
	await expect(card).toContainText(STEP_LABEL);

	await card.locator("[data-testid='goal-widget-signoff-content-toggle']").click();

	await expect(page.locator("[data-testid='goal-widget-signoff-content']"), "View content must not expand markdown inside the compact widget").toHaveCount(0);

	const tab = signoffReviewTab(page);
	await expect(tab, "View content should open a sign-off review tab").toBeVisible({ timeout: 10_000 });
	await expect(tab).toContainText(goalIdentifier);
	await expect(tab).toContainText(GATE_NAME);
	await expect(tab).toContainText(STEP_LABEL);
	await tab.click();

	await expect(reviewPane(page)).toBeVisible({ timeout: 5_000 });
	await expect(page.locator("review-document").getByText("Content awaiting sign-off").first()).toBeVisible({ timeout: 5_000 });
}

async function authorSignoffWorkflowViaEditor(page: Page, workflowId: string): Promise<void> {
	const projectId = await defaultProjectId();
	const createRes = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			projectId,
			id: workflowId,
			name: `Widget Signoff ${workflowId}`,
			description: "Browser-authored signoff workflow",
			gates: [{
				id: "design",
				name: "Design",
				content: true,
				dependsOn: [],
				verify: [{ name: "Placeholder", type: "command", run: "echo placeholder" }],
			}],
		}),
	});
	expect(createRes.status, `workflow create failed: ${createRes.status} ${await createRes.text().catch(() => "")}`).toBe(201);

	await openApp(page);
	await navigateToHash(page, `#/settings/${projectId}/workflows`);
	const tab = page.locator("[data-testid='workflows-tab']").first();
	await expect(tab).toBeVisible({ timeout: 10_000 });
	await tab.getByText(`Widget Signoff ${workflowId}`).first().click();
	await expect(page.locator(".wf-edit-container")).toBeVisible({ timeout: 10_000 });

	await page.locator(".wf-gate-header").first().click();
	await expect(page.locator(".wf-gate-card.expanded").first()).toBeVisible();
	await page.locator(".wf-vstep-collapsed-header").first().click();
	await expect(page.locator(".wf-vstep-card.vstep-expanded").first()).toBeVisible();

	await page.locator("[data-testid='wf-step-type']").first().selectOption("human-signoff");
	await expect(page.locator("[data-testid='wf-step-label']").first()).toBeVisible({ timeout: 10_000 });
	await page.locator("[data-testid='wf-step-name']").first().fill(STEP_NAME);
	await page.locator("[data-testid='wf-step-label']").first().fill(STEP_LABEL);
	await page.locator("[data-testid='wf-step-prompt']").first().fill("Please review and approve the design from the real widget flow.");

	const saveResponse = page.waitForResponse((res) =>
		res.request().method() === "PUT" && res.url().includes(`/api/workflows/${workflowId}`) && res.status() < 500,
		{ timeout: 10_000 },
	).catch(() => null);
	await page.getByRole("button", { name: /^Save$/ }).click();
	expect(await saveResponse, "workflow editor Save must PUT the authored human-signoff workflow").not.toBeNull();
}

test.describe("<goal-status-widget>", () => {
	test("View content opens review pane; approve there posts pass and no inline widget content", async ({ page }) => {
		const goal = await createGoal({ title: `Goal-Status-Widget ${Date.now()}` });
		const goalId = goal.id;
		let sessionId: string | undefined;
		try {
			const { signoffCalls } = await installMocks(page, goalId);

			sessionId = await createSession({ goalId });

			await openApp(page);
			await openSession(page, sessionId);

			// Pill renders for the goal-scoped session.
			const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
			await expect(pill).toBeVisible({ timeout: 15_000 });

			// Pulsing icon visible while awaiting sign-off, positioned between the goal icon and gate counter.
			await expect(pill).toHaveAttribute("data-awaiting-signoffs", "true", { timeout: 10_000 });
			const awaitingIcon = page.locator("[data-testid='goal-status-widget-awaiting']");
			await expect(awaitingIcon).toBeVisible();
			expect(await awaitingIcon.evaluate((el) => {
				const style = getComputedStyle(el);
				const primaryProbe = document.createElement("span");
				primaryProbe.style.color = "var(--primary)";
				document.body.appendChild(primaryProbe);
				const primaryColor = getComputedStyle(primaryProbe).color;
				primaryProbe.remove();
				const previous = el.previousElementSibling as HTMLElement | null;
				return {
					isDirectPillChild: el.parentElement?.getAttribute("data-testid") === "goal-status-widget-pill",
					previousIsGoalIcon: previous?.getAttribute("data-testid") === "goal-status-widget-icon",
					background: style.backgroundColor,
					usesPrimaryColor: style.color === primaryColor,
				};
			})).toMatchObject({
				isDirectPillChild: true,
				previousIsGoalIcon: true,
				background: "rgba(0, 0, 0, 0)",
				usesPrimaryColor: true,
			});

			await pill.click();
			await expect(page.locator("[data-testid='goal-widget-gates']")).toBeVisible({ timeout: 5_000 });

			// Gate rows render with status icons.
			const gateRows = page.locator("[data-testid='goal-widget-gate']");
			await expect(gateRows).toHaveCount(3, { timeout: 5_000 });
			await expect(gateRows.filter({ hasText: "Design Document" })).toHaveAttribute("data-gate-status", "passed");
			await expect(gateRows.filter({ hasText: GATE_NAME })).toHaveAttribute("data-gate-status", "pending");
			await expect(page.locator("[data-testid='goal-widget-dashboard-link']")).toContainText("Goal Dashboard");
			await expect(page.locator("[data-testid='goal-widget-dashboard-link'] svg")).toBeVisible();

			await page.keyboard.press("Escape");
			await openSignoffReviewFromWidget(page, goalId);

			await expect(reviewPane(page).getByRole("button", { name: /^Approve$/ })).toBeEnabled();
			await expect(reviewPane(page).getByRole("button", { name: /^Reject$/ })).toBeEnabled();
			await expect(await finalCommentTextarea(page)).toBeVisible();

			await reviewPane(page).getByRole("button", { name: /^Approve$/ }).click();

			await expect.poll(() => signoffCalls.length, { timeout: 5_000 }).toBeGreaterThan(0);
			const approveCall = signoffCalls[0];
			expect(approveCall.decision).toBe("pass");
			expect(approveCall.signalId).toBe(SIGNAL_ID);
			expect(approveCall.stepName).toBe(STEP_NAME);
			expect(String(approveCall.feedback ?? "").trim()).toMatch(/^(|## Review Approved\s+Approved with no comments\.)$/);

			await expect(signoffReviewTab(page)).toHaveCount(0, { timeout: 5_000 });
			await expect(pill).toHaveAttribute("data-awaiting-signoffs", "false", { timeout: 10_000 });

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

	test("real workflow-editor-authored human-signoff signal opens review pane and Approve resolves gate", async ({ page }) => {
		test.setTimeout(60_000);
		const workflowId = `widget-real-signoff-${Date.now()}`;
		let goalId: string | undefined;
		let sessionId: string | undefined;
		try {
			await authorSignoffWorkflowViaEditor(page, workflowId);

			const goal = await createGoal({
				title: `Goal-Status-Widget Real Signoff ${Date.now()}`,
				workflowId,
			});
			goalId = goal.id;
			sessionId = await createSession({ goalId });

			await openSession(page, sessionId);
			const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
			await expect(pill).toBeVisible({ timeout: 15_000 });

			const signalRes = await apiFetch(`/api/goals/${goalId}/gates/design/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "## Design\n\nReady for approval." }),
			});
			expect(signalRes.status, `signal POST failed: ${signalRes.status} ${await signalRes.text().catch(() => "")}`).toBe(201);

			await expect(pill).toHaveAttribute("data-awaiting-signoffs", "true", { timeout: 15_000 });
			await expect(page.locator("[data-testid='goal-status-widget-awaiting']")).toBeVisible();

			await pill.click();
			const card = page.locator("[data-testid='goal-widget-signoff']").first();
			await expect(card).toBeVisible({ timeout: 10_000 });
			await expect(card).toContainText(STEP_LABEL);
			await card.locator("[data-testid='goal-widget-signoff-content-toggle']").click();
			await expect(page.locator("[data-testid='goal-widget-signoff-content']")).toHaveCount(0);
			await expect(signoffReviewTab(page)).toBeVisible({ timeout: 10_000 });
			await signoffReviewTab(page).click();
			await expect(page.locator("review-document").getByText("Ready for approval").first()).toBeVisible({ timeout: 5_000 });
			await reviewPane(page).getByRole("button", { name: /^Approve$/ }).click();

			await waitForGateStatus(goalId, "design", "passed", 20_000);
			await expect(pill).toHaveAttribute("data-awaiting-signoffs", "false", { timeout: 15_000 });
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => { /* ignore */ });
			if (goalId) await deleteGoal(goalId).catch(() => { /* ignore */ });
			await apiFetch(`/api/workflows/${workflowId}`, { method: "DELETE" }).catch(() => { /* ignore */ });
		}
	});

	test("review-pane Reject validates feedback and submits fail with final comment", async ({ page }) => {
		const goal = await createGoal({ title: `Goal-Status-Widget Reject ${Date.now()}` });
		const goalId = goal.id;
		let sessionId: string | undefined;
		try {
			const { signoffCalls } = await installMocks(page, goalId);
			sessionId = await createSession({ goalId });

			await openApp(page);
			await openSession(page, sessionId);
			await openSignoffReviewFromWidget(page, goalId);

			const rejectButton = reviewPane(page).getByRole("button", { name: /^Reject$/ });
			await expect(rejectButton).toBeEnabled();
			await rejectButton.click();

			await expect.poll(() => signoffCalls.length, { timeout: 1_000 }).toBe(0);
			await expect(reviewPane(page).getByText(/Add a final comment or at least one inline comment before rejecting\./i).first()).toBeVisible({ timeout: 5_000 });

			const feedback = "Needs more detail on the resume path.";
			await (await finalCommentTextarea(page)).fill(feedback);
			await rejectButton.click();

			await expect.poll(() => signoffCalls.length, { timeout: 5_000 }).toBeGreaterThan(0);
			const rejectCall = signoffCalls[0];
			expect(rejectCall.decision).toBe("fail");
			expect(rejectCall.signalId).toBe(SIGNAL_ID);
			expect(rejectCall.stepName).toBe(STEP_NAME);
			expect(String(rejectCall.feedback ?? "")).toContain(feedback);
			await expect(signoffReviewTab(page)).toHaveCount(0, { timeout: 5_000 });
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => { /* ignore */ });
			await deleteGoal(goalId).catch(() => { /* ignore */ });
		}
	});

	test("widget-opened review document and signoff source survive reload until submitted", async ({ page }) => {
		const goal = await createGoal({ title: `Goal-Status-Widget Reload ${Date.now()}` });
		const goalId = goal.id;
		let sessionId: string | undefined;
		try {
			const { signoffCalls } = await installMocks(page, goalId);
			sessionId = await createSession({ goalId });

			await openApp(page);
			await openSession(page, sessionId);
			await openSignoffReviewFromWidget(page, goalId);

			await page.reload();
			await openSession(page, sessionId);

			const tab = signoffReviewTab(page);
			await expect(tab, "widget-launched sign-off review should rehydrate after reload").toBeVisible({ timeout: 10_000 });
			await expect(tab).toContainText(goalId);
			await expect(tab).toContainText(GATE_NAME);
			await expect(tab).toContainText(STEP_LABEL);
			await tab.click();
			await expect(reviewPane(page)).toBeVisible({ timeout: 5_000 });
			await expect(page.locator("review-document").getByText("Content awaiting sign-off").first()).toBeVisible({ timeout: 5_000 });

			const feedback = "Rejected after reload with persisted signoff context.";
			await (await finalCommentTextarea(page)).fill(feedback);
			await reviewPane(page).getByRole("button", { name: /^Reject$/ }).click();

			await expect.poll(() => signoffCalls.length, { timeout: 5_000 }).toBeGreaterThan(0);
			const rejectCall = signoffCalls[0];
			expect(rejectCall.decision).toBe("fail");
			expect(rejectCall.signalId).toBe(SIGNAL_ID);
			expect(rejectCall.stepName).toBe(STEP_NAME);
			expect(String(rejectCall.feedback ?? "")).toContain(feedback);
			await expect(signoffReviewTab(page)).toHaveCount(0, { timeout: 5_000 });
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
			await installMocks(page, goalId);

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
