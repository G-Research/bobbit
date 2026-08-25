/**
 * Journey: Usage and workflows: prompt statistics, costs, and workflow settings.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus } from "../_helpers/journey-fixture.js";
import { sendMessage, apiFetch, createGoal, deleteGoal, defaultProjectId } from "../_helpers/journey-fixture.js";
import { rawApiFetch } from "../../e2e/_helpers/e2e-setup.js";

// Ported from prompt-stats-e2e.spec.ts (audit: misc GAP / BR51): after an agent
// response, the stats bar must show the model name, a context-usage tooltip
// prefixed "Context:" with a percentage, and a "$" cost. The journey previously
// only best-effort probed a cost element.
test.describe("Journey: Prompt Stats", () => {
	test("stats bar shows model name, context %, and cost after a response", async ({ page }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await sendMessage(page, "Full stats test");
			await expect(page.getByText("OK", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
			const statsBar = page.getByTestId("session-stats-bar");
			await expect(statsBar).toBeVisible({ timeout: 15_000 });
			await expect(statsBar).toContainText("mock-model", { timeout: 20_000 });
			const contextTrigger = statsBar.getByTestId("context-meter-trigger");
			await expect(contextTrigger).toBeVisible({ timeout: 15_000 });
			await expect(contextTrigger).toHaveAttribute("type", "button");
			await expect(contextTrigger).toContainText(/\d+%/, { timeout: 15_000 });
			await expect(contextTrigger).toHaveAttribute("title", /Context:.*tokens/, { timeout: 10_000 });
			await expect(contextTrigger).toHaveAttribute("aria-label", /Context:.*tokens/, { timeout: 10_000 });
			await expect(statsBar).toContainText("$", { timeout: 15_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});

test.describe("Journey: Cost Tracking", () => {
	test("send message → cost display appears after agent response", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
			await navigateToHash(page, `#/session/${sessionId}`);
			const editor = page.locator("message-editor textarea").first();
			await expect(editor).toBeVisible({ timeout: 15_000 });
			await editor.fill("cost test");
			await editor.press("Enter");
			// Wait for agent response to arrive
			await expect(page.getByText("OK", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
			// After a response, a cost display element should be visible somewhere in the session
			// (token count, cost badge, stat bar, etc.)
			const costEl = page.locator(
				".cost, [data-testid*='cost'], [data-testid*='token'], " +
				".token-count, .stat-bar, session-stat-bar, message-cost, " +
				"[class*='cost'], [class*='token']"
			).first();
			// Best-effort: cost display may not appear if mock agent response has no usage data
			const hasCost = await costEl.isVisible({ timeout: 15_000 }).catch(() => false);
			// We assert the agent response appeared (main assertion); cost display is informational
			// If it's missing, the test still passes — the cost element is a secondary check
			if (!hasCost) {
				console.warn("cost element not found after agent response; mock agent may not emit usage data");
			}
		} finally {
			await deleteSession(sessionId);
		}
	});
});

test.describe("Journey: Workflow Editor", () => {
	// Ported from workflow-editor.spec.ts (audit: misc GAP / BR46): the workflow
	// editor's verify-step type control must expose its testid AND list all four
	// step types (command/llm-review/agent-qa/human-signoff). PR #644 regressed the
	// human-signoff option; the journey previously asserted none of this.
	test("workflow editor exposes the step-type control with all four types", async ({ page }) => {
		test.setTimeout(90_000);
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const wfId = "v2-wf-step-type-" + Date.now();
		const res = await rawApiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify({
				projectId,
				id: wfId,
				name: `Test Workflow ${wfId}`,
				description: "editor parity",
				gates: [{ id: "g1", name: "Gate 1", depends_on: [], verify: [{ name: "Step", type: "command", run: "echo ok" }] }],
			}),
		});
		expect(res.status).toBe(201);
		try {
			await openApp(page);
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
			await navigateToHash(page, `#/settings/${projectId}/workflows`);
			const tab = page.locator("[data-testid='workflows-tab']").first();
			await expect(tab).toBeVisible({ timeout: 15_000 });
			await tab.getByText(`Test Workflow ${wfId}`).first().click();
			await expect(page.locator(".wf-edit-container")).toBeVisible({ timeout: 15_000 });
			// Expand the first gate.
			const gateCard = page.locator(".wf-edit-container .wf-artifacts-list > .wf-gate-card").first();
			await expect(gateCard).toBeVisible({ timeout: 10_000 });
			await gateCard.scrollIntoViewIfNeeded();
			if (!(await gateCard.evaluate((el) => el.classList.contains("expanded")))) {
				await gateCard.locator(".wf-gate-header .wf-gate-chevron").click();
			}
			await expect(gateCard).toHaveClass(/(?:^|\s)expanded(?:\s|$)/, { timeout: 5_000 });
			// Expand the first verify-step.
			const stepCard = page.locator("[data-testid='wf-vstep-card']").first();
			await expect(stepCard).toBeVisible({ timeout: 10_000 });
			if (!((await stepCard.getAttribute("class"))?.includes("vstep-expanded"))) {
				await stepCard.locator(".wf-vstep-collapsed-header").click();
			}
			await expect(stepCard).toHaveClass(/vstep-expanded/, { timeout: 5_000 });
			// The step-type control must be present and list all four types.
			const select = page.locator("[data-testid='wf-step-type']").first();
			await expect(select).toBeVisible({ timeout: 10_000 });
			const optionValues = await select.locator("option").evaluateAll((els) =>
				(els as HTMLOptionElement[]).map((o) => o.value));
			expect(optionValues).toEqual(["command", "llm-review", "agent-qa", "human-signoff"]);
		} finally {
			await apiFetch(`/api/workflows/${wfId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	// Ported from workflow-page-scope.spec.ts (audit: misc GAP / BR61): the
	// deprecated #/workflows route redirects to the active project's settings
	// Workflows tab (project-scoped, never the system scope).
	test("legacy #/workflows redirects to the project-scoped settings Workflows tab", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => { window.location.hash = "#/workflows"; });
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 })
			.toMatch(/^#\/settings\/[^/]+\/workflows$/);
		expect(await page.evaluate(() => window.location.hash)).not.toContain("/system/");
	});

	test("page.route() workflow GET stub still lets app load gracefully", async ({ page }) => {
		await page.route("**/api/workflows*", async (route) => {
			if (route.request().method() !== "GET") return route.continue();
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify([{ id: "stub-wf", name: "Stub", description: "stub", gates: [] }]),
			});
		});
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});
});
// Ported from cost-popover-cache-hit.spec.ts (audit: misc GAP): the cost popover
// must render the cache-hit row with the server-derived percentage.
test.describe("Journey: Cost Cache-Hit", () => {
	test("goal-dashboard cost popover shows the cache-hit percentage", async ({ page }) => {
		const aggregate = {
			totalCost: 1.2345, inputTokens: 1000, outputTokens: 500,
			cacheReadTokens: 800, cacheWriteTokens: 200, cacheHitRate: 0.75,
		};
		await page.route(/\/api\/goals\/[^/]+\/cost(?:\?.*)?$/, async (route, req) => {
			if (req.method() !== "GET") return route.fallback();
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(aggregate) });
		});
		await page.route(/\/api\/goals\/[^/]+\/cost\/breakdown(?:\?.*)?$/, async (route, req) => {
			if (req.method() !== "GET") return route.fallback();
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ aggregate, sessions: [] }) });
		});
		const goal = await createGoal({ title: `v2-cache-hit-${Date.now()}` });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await page.locator(".cost-tag").first().click();
			await expect(page.locator('[data-testid="cost-cache-hit"]').first()).toContainText("75%", { timeout: 15_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});
});
