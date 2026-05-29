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
	gates: Array<{ gateId: string; name: string; status: "pending" | "passed" | "failed" | "running" }>;
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

async function signalGoalGate(goalId: string, gateId: string, content = `# ${gateId}\n\nReady.`): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signal`, {
		method: "POST",
		body: JSON.stringify({ content }),
	});
	const text = await res.text();
	expect(res.status, `signal ${gateId} failed: ${res.status} ${text}`).toBe(201);
	return text ? JSON.parse(text) : null;
}

async function ensureGoalWidgetGateVisible(page: Page, gateId: string): Promise<void> {
	const row = page.locator(`[data-testid="goal-widget-gate"][data-gate-id="${gateId}"]`).first();
	if (await row.isVisible().catch(() => false)) return;
	const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
	await pill.click();
	if (!(await row.isVisible().catch(() => false))) await pill.click();
	await expect(row).toBeVisible({ timeout: 10_000 });
}

async function clickGoalWidgetGateAction(page: Page, gateId: string, actionTestId: string): Promise<void> {
	await ensureGoalWidgetGateVisible(page, gateId);
	const selector = `[data-testid="goal-widget-gate"][data-gate-id="${gateId}"] [data-testid="${actionTestId}"]`;
	await expect.poll(async () => page.evaluate((sel) => {
		const action = document.querySelector(sel) as HTMLElement | null;
		if (!action) return false;
		action.click();
		return true;
	}, selector), { timeout: 10_000 }).toBe(true);
}

async function expectDashboardGateStatus(page: Page, gateId: string, status: "pending" | "passed" | "failed"): Promise<void> {
	await expect(page.locator(`[data-testid="goal-dashboard-pipeline-gate"][data-gate-id="${gateId}"]`))
		.toHaveAttribute("data-gate-status", status, { timeout: 15_000 });
	await expect(page.locator(`[data-testid="goal-dashboard-gate-row"][data-gate-id="${gateId}"]`))
		.toHaveAttribute("data-gate-status", status, { timeout: 15_000 });
}

async function expectSidebarGateBadge(page: Page, goalId: string, passed: number, total: number): Promise<void> {
	await expect.poll(async () => page.evaluate((id) => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		const cached = state?.gateStatusCache?.get?.(id);
		return cached ? { passed: cached.passed, total: cached.total } : null;
	}, goalId), {
		timeout: 15_000,
		message: `sidebar gate status cache should update to ${passed}/${total}`,
	}).toEqual({ passed, total });

	await expect(page.locator(`[data-nav-id="goal:${goalId}"] span[title="${passed} of ${total} gates passed"]`).first())
		.toBeVisible({ timeout: 15_000 });
}

async function resetGoalGate(goalId: string, gateId: string): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/reset`, {
		method: "POST",
		body: JSON.stringify({ reason: "browser E2E gate reset sync coverage" }),
	});
	const text = await res.text();
	expect(res.status, `reset ${gateId} failed: ${res.status} ${text}`).toBe(200);
	return text ? JSON.parse(text) : null;
}

async function ensureGoalWidgetPopoverOpen(page: Page): Promise<void> {
	const dropdown = page.locator("#goal-status-dropdown").first();
	if (await dropdown.isVisible().catch(() => false)) return;
	await page.locator("[data-testid='goal-status-widget-pill']").first().click();
	await expect(dropdown).toBeVisible({ timeout: 10_000 });
}

async function expectWidgetGateSummary(page: Page, passed: number, total: number): Promise<void> {
	const title = `${passed} of ${total} gates passed`;
	const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
	await expect(pill).toBeVisible({ timeout: 15_000 });
	await expect(pill, "widget-local pill title should match gate truth").toHaveAttribute("title", new RegExp(`Goal status: ${passed}/${total} gates passed`), { timeout: 15_000 });
	await expect(pill.locator(`span[title="${title}"]`).first(), "widget pill shared badge should match sidebar badge").toBeVisible({ timeout: 15_000 });

	await ensureGoalWidgetPopoverOpen(page);
	await expect(page.locator(`#goal-status-dropdown span[title="${title}"]`).first(), "widget popover shared badge should match sidebar badge").toBeVisible({ timeout: 15_000 });
}

async function expectDashboardGateCount(page: Page, passed: number, total: number): Promise<void> {
	await expect(page.locator(".wf-checklist-count").first()).toHaveText(`${passed}/${total} passed`, { timeout: 15_000 });
	await expect(page.locator(".wf-progress-label").first()).toHaveText(`${passed}/${total} gates passed`, { timeout: 15_000 });
}

async function addInlineAnnotationToActiveReview(page: Page, comment: string): Promise<void> {
	await page.evaluate(({ commentText, quoteText }) => {
		const doc = document.querySelector("review-document") as any;
		if (!doc?.backend || !doc.sessionId || !doc.docTitle) throw new Error("active review-document not ready");
		const markdown = typeof doc.markdown === "string" ? doc.markdown : "";
		const start = markdown.indexOf(quoteText);
		doc.backend.add({ sessionId: doc.sessionId, bucket: doc.docTitle }, {
			id: `signoff-inline-${Date.now()}`,
			quote: quoteText,
			comment: commentText,
			start: start >= 0 ? start : undefined,
			end: start >= 0 ? start + quoteText.length : undefined,
		});
		doc.dispatchEvent(new CustomEvent("annotation-change", { bubbles: true, composed: true }));
	}, { commentText: comment, quoteText: "Content awaiting sign-off" });
}

async function signoffReviewDocTitle(page: Page): Promise<string> {
	const title = await page.evaluate(() => {
		const docs = (window as any).bobbitState?.reviewDocuments;
		return Array.from(docs?.keys?.() || []).find((candidate): candidate is string => typeof candidate === "string" && candidate.startsWith("Sign-off:")) || "";
	});
	expect(title, "sign-off review document should be present in app state").not.toBe("");
	return title;
}

function signoffReviewTab(page: Page) {
	return page.locator(REVIEW_PANEL_TAB_SELECTOR).filter({ hasText: /Sign-off:/ }).first();
}

async function signoffReviewRecords(page: Page): Promise<{ active: string[]; persisted: string[] }> {
	return page.evaluate(() => {
		const isSignoffDoc = (doc: any) => (
			(typeof doc?.title === "string" && doc.title.startsWith("Sign-off:"))
			|| doc?.source?.kind === "verification-signoff-markdown"
			|| doc?.source?.kind === "verification-signoff-pr"
		);
		const label = (doc: any) => `${String(doc?.title || "")}|${String(doc?.source?.kind || "")}`;
		const docs = (window as any).bobbitState?.reviewDocuments;
		const active = Array.from(docs?.values?.() || []).filter(isSignoffDoc).map(label);
		const persisted: string[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i) || "";
			if (!key.startsWith("bobbit-review-contexts-v1:")) continue;
			try {
				const parsed = JSON.parse(localStorage.getItem(key) || "{}");
				for (const doc of Object.values(parsed || {})) {
					if (isSignoffDoc(doc)) persisted.push(label(doc));
				}
			} catch { /* ignore unrelated/corrupt storage */ }
		}
		return { active, persisted };
	});
}

async function expectNoSignoffReviewContext(page: Page, message: string): Promise<void> {
	await expect(signoffReviewTab(page), message).toHaveCount(0, { timeout: 5_000 });
	await expect.poll(async () => {
		const records = await signoffReviewRecords(page);
		return records.active.length + records.persisted.length;
	}, { timeout: 5_000, message }).toBe(0);
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

async function expectGoalCounterAndIconVerticallyAligned(page: Page): Promise<void> {
	const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
	await expect(pill).toBeVisible({ timeout: 15_000 });
	const delta = await page.evaluate(() => {
		const icon = document.querySelector("[data-testid='goal-status-widget-icon']") as HTMLElement | null;
		const counter = document.querySelector("[data-testid='goal-status-widget-pill'] > span[title*='gates passed']") as HTMLElement | null;
		if (!icon || !counter) return Number.POSITIVE_INFINITY;
		const ir = icon.getBoundingClientRect();
		const cr = counter.getBoundingClientRect();
		return Math.abs((ir.top + ir.height / 2) - (cr.top + cr.height / 2));
	});
	expect(delta, "goal workflow counter and goal icon vertical centers should align").toBeLessThanOrEqual(1);
}

async function expectGoalGateRowsStaySingleLine(page: Page): Promise<void> {
	const rows = page.locator("[data-testid='goal-widget-gate']");
	const count = await rows.count();
	expect(count, "expected one DOM row per gate").toBeGreaterThan(0);
	const metrics = await rows.evaluateAll((els) => els.map((el) => {
		const row = el as HTMLElement;
		const main = row.querySelector(".goal-widget-gate-main") as HTMLElement | null;
		const actions = row.querySelector("[data-testid='goal-widget-gate-actions']") as HTMLElement | null;
		const rowRect = row.getBoundingClientRect();
		const mainRect = main?.getBoundingClientRect();
		const actionsRect = actions?.getBoundingClientRect();
		return {
			gateId: row.dataset.gateId,
			flexWrap: getComputedStyle(row).flexWrap,
			rowHeight: rowRect.height,
			mainAndActionsCenterDelta: mainRect && actionsRect
				? Math.abs((mainRect.top + mainRect.height / 2) - (actionsRect.top + actionsRect.height / 2))
				: 0,
		};
	}));
	for (const metric of metrics) {
		expect(metric.flexWrap, `${metric.gateId} should not wrap actions onto another line`).toBe("nowrap");
		expect(metric.rowHeight, `${metric.gateId} should stay a single compact row`).toBeLessThanOrEqual(28);
		expect(metric.mainAndActionsCenterDelta, `${metric.gateId} main content and actions should share one row`).toBeLessThanOrEqual(1);
	}
}

async function expectGoalWidgetButtonsMatchDashboard(page: Page, selectors: string[]): Promise<void> {
	const dashboardSelector = "[data-testid='goal-widget-dashboard-link']";
	await expect(page.locator(dashboardSelector)).toBeVisible({ timeout: 5_000 });
	await expect(page.locator(`${dashboardSelector} svg`)).toBeVisible();
	for (const selector of selectors) {
		await expect(page.locator(selector).first()).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(`${selector} svg`).first()).toBeVisible();
	}
	const metrics = await page.evaluate((buttonSelectors) => {
		const dashboard = document.querySelector("[data-testid='goal-widget-dashboard-link']") as HTMLElement | null;
		const baselineHeight = dashboard?.getBoundingClientRect().height ?? 0;
		return buttonSelectors.map((selector) => {
			const el = document.querySelector(selector) as HTMLElement | null;
			if (!el) return { selector, missing: true };
			const style = getComputedStyle(el);
			return {
				selector,
				height: el.getBoundingClientRect().height,
				baselineHeight,
				display: style.display,
				alignItems: style.alignItems,
				hasSharedClass: el.classList.contains("goal-widget-button"),
				hasIcon: !!el.querySelector("svg"),
			};
		});
	}, selectors);
	for (const metric of metrics) {
		expect(metric, `${metric.selector} should exist`).not.toMatchObject({ missing: true });
		if ("height" in metric) {
			expect(Math.abs(metric.height - metric.baselineHeight), `${metric.selector} should match dashboard button height`).toBeLessThanOrEqual(0.5);
			expect(["inline-flex", "flex"], `${metric.selector} should use shared app button layout`).toContain(metric.display);
			expect(metric.alignItems, `${metric.selector} should vertically center icon and text`).toBe("center");
			expect(metric.hasSharedClass, `${metric.selector} should use shared goal widget button theme`).toBe(true);
			expect(metric.hasIcon, `${metric.selector} should include an icon`).toBe(true);
		}
	}
}

async function expectGoalAndGitPillsVerticallyAligned(page: Page): Promise<void> {
	const goalPill = page.locator("[data-testid='goal-status-widget-pill']").first();
	await expect(goalPill).toBeVisible({ timeout: 15_000 });
	await page.evaluate(() => {
		if (document.querySelector("git-status-widget button")) return;
		const strip = document.querySelector("[data-pill-content]") || document.body;
		const fake = document.createElement("git-status-widget");
		fake.setAttribute("data-testid", "alignment-fake-git-widget");
		fake.innerHTML = `<button class="git-status-pill inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-card border border-border text-muted-foreground text-[12px] leading-tight" style="max-width:100%; height:var(--pill-h, auto)"><span>⎇</span><span>goal/foo</span></button>`;
		strip.appendChild(fake);
	});
	const gitPill = page.locator("git-status-widget button").first();
	await expect(gitPill).toBeVisible({ timeout: 15_000 });
	const delta = await page.evaluate(() => {
		const goal = document.querySelector("[data-testid='goal-status-widget-pill']") as HTMLElement | null;
		const git = document.querySelector("git-status-widget button") as HTMLElement | null;
		if (!goal || !git) return Number.POSITIVE_INFINITY;
		const gr = goal.getBoundingClientRect();
		const gitr = git.getBoundingClientRect();
		return Math.abs((gr.top + gr.height / 2) - (gitr.top + gitr.height / 2));
	});
	await page.evaluate(() => document.querySelector("[data-testid='alignment-fake-git-widget']")?.remove());
	expect(delta, "goal status and git status pill vertical centers should align").toBeLessThanOrEqual(1);
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

			await expectGoalCounterAndIconVerticallyAligned(page);
			await page.setViewportSize({ width: 640, height: 800 });
			await expectGoalAndGitPillsVerticallyAligned(page);
			await expectGoalCounterAndIconVerticallyAligned(page);
			await page.setViewportSize({ width: 1280, height: 800 });

			await pill.click();
			await expect(page.locator("[data-testid='goal-widget-gates']")).toBeVisible({ timeout: 5_000 });

			// Gate rows render with status icons.
			const gateRows = page.locator("[data-testid='goal-widget-gate']");
			await expect(gateRows).toHaveCount(3, { timeout: 5_000 });
			await expect(gateRows.filter({ hasText: "Design Document" })).toHaveAttribute("data-gate-status", "passed");
			await expect(gateRows.filter({ hasText: GATE_NAME })).toHaveAttribute("data-gate-status", "pending");
			const runningDot = gateRows.filter({ hasText: GATE_NAME }).locator("[data-testid='goal-widget-gate-running-dot']");
			await expect(runningDot).toBeVisible();
			expect(await runningDot.evaluate((el) => {
				const style = getComputedStyle(el);
				return {
					background: style.backgroundColor,
					animationName: style.animationName,
					animationDuration: style.animationDuration,
				};
			})).toMatchObject({
				animationName: "goal-widget-running-dot-pulse",
				animationDuration: "1.25s",
			});
			await expectGoalGateRowsStaySingleLine(page);
			await expect(page.locator("[data-testid='goal-widget-dashboard-link']")).toContainText("Goal Dashboard");
			await expect(page.locator("[data-testid='goal-widget-dashboard-link'] svg")).toBeVisible();
			await expectGoalWidgetButtonsMatchDashboard(page, ["[data-testid='goal-widget-signoff-content-toggle']"]);

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

	test("widget-opened review document and signoff source survive reload, and inline annotations submit", async ({ page }) => {
		const goal = await createGoal({ title: `Goal-Status-Widget Reload ${Date.now()}` });
		const goalId = goal.id;
		let sessionId: string | undefined;
		try {
			const { signoffCalls } = await installMocks(page, goalId);
			sessionId = await createSession({ goalId });

			await openApp(page);
			await openSession(page, sessionId);
			await openSignoffReviewFromWidget(page, goalId);
			const docTitle = await signoffReviewDocTitle(page);

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

			const inlineComment = `signoff-inline-comment-${Date.now()}`;
			await addInlineAnnotationToActiveReview(page, inlineComment);
			await expect(reviewPane(page).locator(".review-tab-badge"), "inline comments should count before rejecting from the sign-off review").toHaveText("1", { timeout: 5_000 });
			await reviewPane(page).getByRole("button", { name: /^Reject$/ }).click();

			await expect.poll(() => signoffCalls.length, { timeout: 5_000 }).toBeGreaterThan(0);
			const rejectCall = signoffCalls[0];
			expect(rejectCall.decision).toBe("fail");
			expect(rejectCall.signalId).toBe(SIGNAL_ID);
			expect(rejectCall.stepName).toBe(STEP_NAME);
			const feedback = String(rejectCall.feedback ?? "");
			expect(feedback).toContain("Inline comments");
			expect(feedback).toContain("Content awaiting sign-off");
			expect(feedback).toContain(inlineComment);
			expect(feedback).toContain(docTitle);
			await expect(signoffReviewTab(page)).toHaveCount(0, { timeout: 5_000 });
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => { /* ignore */ });
			await deleteGoal(goalId).catch(() => { /* ignore */ });
		}
	});

	test("dismissing widget-opened signoff review clears persisted context and does not rehydrate", async ({ page }) => {
		const goal = await createGoal({ title: `Goal-Status-Widget Dismiss ${Date.now()}` });
		const goalId = goal.id;
		let sessionId: string | undefined;
		try {
			const { signoffCalls } = await installMocks(page, goalId);
			sessionId = await createSession({ goalId });

			await openApp(page);
			await openSession(page, sessionId);
			await openSignoffReviewFromWidget(page, goalId);
			const docTitle = await signoffReviewDocTitle(page);
			const expectedRecord = `${docTitle}|verification-signoff-markdown`;

			await expect.poll(async () => (await signoffReviewRecords(page)).active.includes(expectedRecord), { timeout: 5_000 }).toBe(true);
			await expect.poll(async () => (await signoffReviewRecords(page)).persisted.includes(expectedRecord), { timeout: 5_000 }).toBe(true);

			await reviewPane(page).getByRole("button", { name: /^Dismiss$/ }).click();
			await expectNoSignoffReviewContext(page, "dismissing should remove the active and persisted sign-off review context");
			expect(signoffCalls, "dismiss must not submit a sign-off decision").toHaveLength(0);

			await page.reload();
			await openSession(page, sessionId);
			await expectNoSignoffReviewContext(page, "dismissed sign-off review must not rehydrate after reload");
			expect(signoffCalls, "reload after dismiss must not submit a sign-off decision").toHaveLength(0);

			await navigateToHash(page, `#/settings/${await defaultProjectId()}`);
			await openSession(page, sessionId);
			await expectNoSignoffReviewContext(page, "dismissed sign-off review must not rehydrate after navigation away and back");
			expect(signoffCalls, "navigation after dismiss must not submit a sign-off decision").toHaveLength(0);
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => { /* ignore */ });
			await deleteGoal(goalId).catch(() => { /* ignore */ });
		}
	});

	test("passed gates show View and Reset only; View focuses the dashboard gate, supports Back, and survives reload", async ({ page }) => {
		const goal = await createGoal({ title: `Goal-Status-Widget View Reset ${Date.now()}`, workflowId: "test-fast", worktree: false, team: false });
		const goalId = goal.id;
		let sessionId: string | undefined;
		try {
			sessionId = await createSession({ goalId });
			const signalData = await signalGoalGate(goalId, "design-doc", "# Design Doc\n\nCurrent pass for widget view.");
			const signalId = signalData.signal.id;
			await waitForGateStatus(goalId, "design-doc", "passed", 20_000);

			await openApp(page);
			await openSession(page, sessionId);
			const sourceHash = `#/session/${sessionId}`;
			await expect.poll(async () => page.evaluate(() => window.location.hash), { timeout: 5_000 }).toContain(sourceHash);

			const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
			await expect(pill).toBeVisible({ timeout: 15_000 });
			await pill.click();

			const passedRow = page.locator('[data-testid="goal-widget-gate"][data-gate-id="design-doc"]');
			await expect(passedRow).toHaveAttribute("data-gate-status", "passed", { timeout: 10_000 });
			await expect(passedRow.locator('[data-testid="goal-widget-gate-view"]')).toBeVisible();
			await expect(passedRow.locator('[data-testid="goal-widget-gate-reset"]')).toBeVisible();
			await expectGoalWidgetButtonsMatchDashboard(page, [
				'[data-testid="goal-widget-gate"][data-gate-id="design-doc"] [data-testid="goal-widget-gate-view"]',
				'[data-testid="goal-widget-gate"][data-gate-id="design-doc"] [data-testid="goal-widget-gate-reset"]',
			]);
			await expectGoalGateRowsStaySingleLine(page);

			for (const pendingGate of ["implementation", "ready-to-merge"]) {
				const pendingRow = page.locator(`[data-testid="goal-widget-gate"][data-gate-id="${pendingGate}"]`);
				await expect(pendingRow).toHaveAttribute("data-gate-status", "pending", { timeout: 10_000 });
				await expect(pendingRow.locator('[data-testid="goal-widget-gate-view"]')).toHaveCount(0);
				await expect(pendingRow.locator('[data-testid="goal-widget-gate-reset"]')).toHaveCount(0);
			}

			await passedRow.locator('[data-testid="goal-widget-gate-view"]').click();
			await page.waitForFunction(
				({ goalId: expectedGoalId, gateId, expectedSignalId }) => {
					const hash = window.location.hash;
					if (!hash.startsWith(`#/goal/${expectedGoalId}?`)) return false;
					const query = hash.slice(hash.indexOf("?") + 1);
					const params = new URLSearchParams(query);
					return params.get("tab") === "gates"
						&& params.get("gate") === gateId
						&& (params.get("signal") === expectedSignalId || params.get("signal") === "latest-passed");
				},
				{ goalId, gateId: "design-doc", expectedSignalId: signalId },
				{ timeout: 10_000 },
			);

			const focusedRow = page.locator('[data-testid="goal-dashboard-gate-row"][data-gate-id="design-doc"]');
			await expect(focusedRow).toHaveAttribute("data-expanded", "true", { timeout: 15_000 });
			await expect(focusedRow).toHaveAttribute("data-focused", "true");
			await expect(page.locator('[data-testid="goal-dashboard-gate-detail"][data-gate-id="design-doc"]')).toBeVisible();
			await expect(page.locator(`[data-testid="goal-dashboard-signal-entry"][data-signal-id="${signalId}"]`)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });

			await page.evaluate(() => window.history.back());
			await page.waitForFunction((hash) => window.location.hash.startsWith(hash), sourceHash, { timeout: 10_000 });
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
			await expect(pill).toBeVisible({ timeout: 10_000 });

			await clickGoalWidgetGateAction(page, "design-doc", "goal-widget-gate-view");
			await page.waitForFunction(
				({ goalId: expectedGoalId, gateId, expectedSignalId }) => {
					const hash = window.location.hash;
					if (!hash.startsWith(`#/goal/${expectedGoalId}?`)) return false;
					const query = hash.slice(hash.indexOf("?") + 1);
					const params = new URLSearchParams(query);
					return params.get("tab") === "gates"
						&& params.get("gate") === gateId
						&& (params.get("signal") === expectedSignalId || params.get("signal") === "latest-passed");
				},
				{ goalId, gateId: "design-doc", expectedSignalId: signalId },
				{ timeout: 10_000 },
			);

			await page.reload();
			await expect(page.locator('[data-testid="goal-dashboard-gate-row"][data-gate-id="design-doc"]')).toHaveAttribute("data-expanded", "true", { timeout: 15_000 });
			await expect(page.locator(`[data-testid="goal-dashboard-signal-entry"][data-signal-id="${signalId}"]`)).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => { /* ignore */ });
			await deleteGoal(goalId).catch(() => { /* ignore */ });
		}
	});

	test("API gate_reset keeps sidebar badge, widget pill/popover, dashboard, and reload truth in sync", async ({ page, context }) => {
		test.setTimeout(60_000);
		const goal = await createGoal({
			title: `Goal-Status-Widget Reset Sync ${Date.now()}`,
			workflowId: "test-fast",
			worktree: false,
			team: true,
			autoStartTeam: false,
		});
		const goalId = goal.id;
		let teamLeadId: string | undefined;
		let dashboardPage: Page | undefined;
		try {
			teamLeadId = await startTeam(goalId);
			await waitForSessionStatus(teamLeadId, "idle", 30_000);

			await signalGoalGate(goalId, "design-doc", "# Design Doc\n\nInitial pass for cross-surface reset sync.");
			await waitForGateStatus(goalId, "design-doc", "passed", 20_000);
			await signalGoalGate(goalId, "implementation", "# Implementation\n\nInitial downstream pass.");
			await waitForGateStatus(goalId, "implementation", "passed", 20_000);
			await signalGoalGate(goalId, "ready-to-merge", "# Ready\n\nInitial transitive pass.");
			await waitForGateStatus(goalId, "ready-to-merge", "passed", 20_000);

			dashboardPage = await context.newPage();
			await openApp(dashboardPage);
			await navigateToHash(dashboardPage, `#/goal/${goalId}?tab=gates`);
			await expectDashboardGateCount(dashboardPage, 3, 3);
			for (const gateId of ["design-doc", "implementation", "ready-to-merge"]) {
				await expectDashboardGateStatus(dashboardPage, gateId, "passed");
			}

			await openApp(page);
			await openSession(page, teamLeadId);
			await expectSidebarGateBadge(page, goalId, 3, 3);
			await expectWidgetGateSummary(page, 3, 3);
			for (const gateId of ["design-doc", "implementation", "ready-to-merge"]) {
				await ensureGoalWidgetGateVisible(page, gateId);
				await expect(page.locator(`[data-testid="goal-widget-gate"][data-gate-id="${gateId}"]`))
					.toHaveAttribute("data-gate-status", "passed", { timeout: 10_000 });
			}

			const resetBody = await resetGoalGate(goalId, "design-doc");
			expect(resetBody.affectedGateIds).toEqual(expect.arrayContaining(["design-doc", "implementation", "ready-to-merge"]));
			expect(resetBody.changedGateIds).toEqual(expect.arrayContaining(["design-doc", "implementation", "ready-to-merge"]));

			await expectSidebarGateBadge(page, goalId, 0, 3);
			await expectWidgetGateSummary(page, 0, 3);
			await expectDashboardGateCount(dashboardPage, 0, 3);
			for (const gateId of ["design-doc", "implementation", "ready-to-merge"]) {
				await waitForGateStatus(goalId, gateId, "pending", 20_000);
				await ensureGoalWidgetGateVisible(page, gateId);
				await expect(page.locator(`[data-testid="goal-widget-gate"][data-gate-id="${gateId}"]`))
					.toHaveAttribute("data-gate-status", "pending", { timeout: 15_000 });
				await expectDashboardGateStatus(dashboardPage, gateId, "pending");
			}

			await page.reload();
			await openSession(page, teamLeadId);
			await expectSidebarGateBadge(page, goalId, 0, 3);
			await expectWidgetGateSummary(page, 0, 3);
			for (const gateId of ["design-doc", "implementation", "ready-to-merge"]) {
				await ensureGoalWidgetGateVisible(page, gateId);
				await expect(page.locator(`[data-testid="goal-widget-gate"][data-gate-id="${gateId}"]`))
					.toHaveAttribute("data-gate-status", "pending", { timeout: 15_000 });
			}

			await dashboardPage.reload();
			await navigateToHash(dashboardPage, `#/goal/${goalId}?tab=gates`);
			await expectDashboardGateCount(dashboardPage, 0, 3);
			for (const gateId of ["design-doc", "implementation", "ready-to-merge"]) {
				await expectDashboardGateStatus(dashboardPage, gateId, "pending");
			}
		} finally {
			if (dashboardPage) await dashboardPage.close().catch(() => { /* ignore */ });
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => { /* ignore */ });
			await teardownTeam(goalId).catch(() => { /* ignore */ });
			await deleteGoal(goalId).catch(() => { /* ignore */ });
		}
	});

	test("Reset is confirmation-guarded and refreshes downstream widget rows, sidebar badge, dashboard pipeline, and team lead message", async ({ page, context }) => {
		test.setTimeout(60_000);
		const goal = await createGoal({
			title: `Goal-Status-Widget Reset ${Date.now()}`,
			workflowId: "test-fast",
			worktree: false,
			team: true,
			autoStartTeam: false,
		});
		const goalId = goal.id;
		let teamLeadId: string | undefined;
		let dashboardPage: Page | undefined;
		let resetRequests = 0;
		try {
			teamLeadId = await startTeam(goalId);
			await waitForSessionStatus(teamLeadId, "idle", 30_000);

			await signalGoalGate(goalId, "design-doc", "# Design Doc\n\nReset me.");
			await waitForGateStatus(goalId, "design-doc", "passed", 20_000);
			await signalGoalGate(goalId, "implementation", "# Implementation\n\nDownstream work depends on design.");
			await waitForGateStatus(goalId, "implementation", "passed", 20_000);
			await signalGoalGate(goalId, "ready-to-merge", "# Ready\n\nTransitive downstream work is ready.");
			await waitForGateStatus(goalId, "ready-to-merge", "passed", 20_000);

			const dashboard = await context.newPage();
			dashboardPage = dashboard;
			await openApp(dashboard);
			await navigateToHash(dashboard, `#/goal/${goalId}?tab=gates`);
			await expectDashboardGateStatus(dashboard, "design-doc", "passed");
			await expectDashboardGateStatus(dashboard, "implementation", "passed");
			await expectDashboardGateStatus(dashboard, "ready-to-merge", "passed");

			page.on("request", (request) => {
				if (request.method() === "POST" && request.url().includes(`/api/goals/${goalId}/gates/design-doc/reset`)) resetRequests += 1;
			});

			await openApp(page);
			await openSession(page, teamLeadId);
			await expectSidebarGateBadge(page, goalId, 3, 3);
			const pill = page.locator("[data-testid='goal-status-widget-pill']").first();
			await expect(pill).toBeVisible({ timeout: 15_000 });
			await pill.click();

			for (const gateId of ["design-doc", "implementation", "ready-to-merge"]) {
				await expect(page.locator(`[data-testid="goal-widget-gate"][data-gate-id="${gateId}"]`))
					.toHaveAttribute("data-gate-status", "passed", { timeout: 10_000 });
			}

			await clickGoalWidgetGateAction(page, "design-doc", "goal-widget-gate-reset");

			const dialogTitle = page.getByText(/Reset .*Design Doc/i).first();
			await expect(dialogTitle).toBeVisible({ timeout: 5_000 });
			expect(resetRequests, "opening confirmation must not call reset API").toBe(0);
			await page.getByRole("button", { name: "Cancel" }).last().click();
			await expect(dialogTitle).toBeHidden({ timeout: 5_000 });
			expect(resetRequests, "cancel must not call reset API").toBe(0);
			await waitForGateStatus(goalId, "design-doc", "passed", 5_000);
			await waitForGateStatus(goalId, "implementation", "passed", 5_000);
			await waitForGateStatus(goalId, "ready-to-merge", "passed", 5_000);

			await clickGoalWidgetGateAction(page, "design-doc", "goal-widget-gate-reset");
			await expect(dialogTitle).toBeVisible({ timeout: 5_000 });
			const resetResponse = page.waitForResponse((response) =>
				response.request().method() === "POST"
				&& response.url().includes(`/api/goals/${goalId}/gates/design-doc/reset`)
				&& response.status() < 500,
				{ timeout: 10_000 },
			);
			await page.getByRole("button", { name: /^Reset$/ }).last().click();
			const response = await resetResponse;
			expect(response.status()).toBe(200);
			const body = await response.json();
			expect(body.affectedGateIds).toEqual(expect.arrayContaining(["design-doc", "implementation", "ready-to-merge"]));
			expect(body.changedGateIds).toEqual(expect.arrayContaining(["design-doc", "implementation", "ready-to-merge"]));
			expect(body.teamLeadNotified).toBe(true);
			expect(resetRequests).toBe(1);

			await expectSidebarGateBadge(page, goalId, 0, 3);

			for (const gateId of ["design-doc", "implementation", "ready-to-merge"]) {
				await waitForGateStatus(goalId, gateId, "pending", 20_000);
				await ensureGoalWidgetGateVisible(page, gateId);
				const row = page.locator(`[data-testid="goal-widget-gate"][data-gate-id="${gateId}"]`);
				await expect(row).toHaveAttribute("data-gate-status", "pending", { timeout: 15_000 });
				await expect(row.locator('[data-testid="goal-widget-gate-view"]')).toHaveCount(0);
				await expect(row.locator('[data-testid="goal-widget-gate-reset"]')).toHaveCount(0);
				await expectDashboardGateStatus(dashboard, gateId, "pending");
			}

			await expect(page.locator("user-message").filter({ hasText: "Gate reset: Design Doc" }).first())
				.toBeVisible({ timeout: 20_000 });
			await expect(page.locator("user-message").filter({ hasText: "Implementation" }).filter({ hasText: /downstream work|Why this matters/i }).first())
				.toBeVisible({ timeout: 20_000 });
		} finally {
			if (dashboardPage) await dashboardPage.close().catch(() => { /* ignore */ });
			if (teamLeadId) await deleteSession(teamLeadId).catch(() => { /* ignore */ });
			await teardownTeam(goalId).catch(() => { /* ignore */ });
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
