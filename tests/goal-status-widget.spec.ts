import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/goal-status-widget.html");
const BUNDLE = path.resolve("tests/fixtures/goal-status-widget-bundle.js");
const ENTRY = path.resolve("tests/fixtures/goal-status-widget-entry.ts");
const WIDGET_SRC = path.resolve("src/ui/components/GoalStatusWidget.ts");
const RENDER_HELPERS_SRC = path.resolve("src/app/render-helpers.ts");

const GOAL_ID = "goal-widget-fixture";

const gates = [
	{ gateId: "design-doc", name: "Design Document", status: "passed", latestPassedSignalId: "sig-pass" },
	{ gateId: "human-approval", name: "Human Approval", status: "pending" },
	{ gateId: "implementation", name: "Implementation", status: "failed" },
];

const verification = {
	signalId: "sig-human",
	gateId: "human-approval",
	overallStatus: "running",
	steps: [{
		name: "approve-design",
		type: "human-signoff",
		status: "running",
		awaitingHuman: true,
		humanLabel: "Approve design",
		humanPrompt: "Please approve **the design**.",
	}],
};

test.beforeAll(() => {
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, WIDGET_SRC, RENDER_HELPERS_SRC],
	});
});

async function loadFixture(page: any) {
	await page.goto(`file://${FIXTURE.replace(/\\/g, "/")}`);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

test.describe("GoalStatusWidget fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("renders compact gate progress, running sign-off state, and starts review from the popover", async ({ page }) => {
		await page.evaluate(({ goalId, gates, verification }) => (window as any).__mountGoalStatusWidget({
			goalId,
			gates,
			verifications: [verification],
			cache: { passed: 1, total: 3 },
			signals: { "human-approval": [{ id: "sig-human", content: "## Design\n\nContent awaiting sign-off." }] },
		}), { goalId: GOAL_ID, gates, verification });

		const pill = page.locator('[data-testid="goal-status-widget-pill"]');
		await expect(pill).toBeVisible({ timeout: 5_000 });
		await expect(pill).toHaveAttribute("data-awaiting-signoffs", "true");
		await expect(pill).toContainText("(1/3)");
		await expect(page.locator('[data-testid="goal-status-widget-awaiting"]')).toBeVisible();

		await pill.click();
		const dropdown = page.locator("#goal-status-dropdown");
		await expect(dropdown).toBeVisible({ timeout: 5_000 });
		await expect(dropdown.locator('[data-testid="goal-widget-gate"]')).toHaveCount(3);
		await expect(dropdown.locator('[data-testid="goal-widget-gate"][data-gate-id="design-doc"]')).toHaveAttribute("data-gate-status", "passed");
		await expect(dropdown.locator('[data-testid="goal-widget-gate"][data-gate-id="human-approval"]')).toHaveAttribute("data-gate-status", "running");
		await expect(dropdown.locator('[data-testid="goal-widget-gate-running-dot"]')).toBeVisible();
		await expect(dropdown.locator('[data-testid="goal-widget-signoff"]')).toContainText("Approve design");
		await expect(dropdown.locator('[data-testid="goal-widget-signoff-content"]')).toHaveCount(0);

		await dropdown.locator('[data-testid="goal-widget-signoff-content-toggle"]').click();
		await expect.poll(() => page.evaluate(() => (window as any).__openReviewEvents.length), { timeout: 5_000 }).toBe(1);
		const event = await page.evaluate(() => (window as any).__openReviewEvents[0]);
		expect(event.title).toContain("Sign-off: fixture/branch / Human Approval / Approve design");
		expect(event.markdown).toContain("Content awaiting sign-off");
		expect(event.source).toMatchObject({ kind: "verification-signoff-markdown", goalId: GOAL_ID, gateId: "human-approval", signalId: "sig-human", stepName: "approve-design" });
	});

	test("passed, failed, bypassed, and completed states expose the right lightweight actions", async ({ page }) => {
		await page.evaluate(({ goalId }) => (window as any).__mountGoalStatusWidget({
			goalId,
			gates: [
				{ gateId: "design-doc", name: "Design Document", status: "passed", latestPassedSignalId: "sig-pass" },
				{ gateId: "qa", name: "QA", status: "failed" },
				{ gateId: "risk", name: "Risk Review", status: "bypassed", whyBypassed: "Emergency fix", whoAmI: "Lead" },
			],
			cache: { passed: 1, total: 3, bypassed: 1 },
			goalState: "complete",
		}), { goalId: GOAL_ID });

		await page.locator('[data-testid="goal-status-widget-pill"]').click();
		const dropdown = page.locator("#goal-status-dropdown");
		await expect(dropdown.locator('[data-testid="goal-widget-completed"]')).toContainText("Completed", { timeout: 5_000 });
		await expect(dropdown.locator('[data-testid="goal-widget-gate"][data-gate-id="design-doc"] [data-testid="goal-widget-gate-view"]')).toBeVisible();
		await expect(dropdown.locator('[data-testid="goal-widget-gate"][data-gate-id="design-doc"] [data-testid="goal-widget-gate-reset"]')).toBeVisible();
		await expect(dropdown.locator('[data-testid="goal-widget-gate"][data-gate-id="qa"] [data-testid="goal-widget-gate-bypass"]')).toBeVisible();
		await expect(dropdown.locator('[data-testid="goal-widget-gate"][data-gate-id="risk"]')).toHaveAttribute("data-gate-status", "bypassed");
		await expect(dropdown.locator('[data-testid="goal-widget-gate-bypass-info"]')).toContainText("Emergency fix");
	});
});
