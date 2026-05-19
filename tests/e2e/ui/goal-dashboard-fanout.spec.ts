import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, createSession, deleteGoal, deleteSession } from "../e2e-setup.js";
import { openApp, navigateToGoalDashboard, navigateToHash } from "./ui-helpers.js";

async function expandGate(page: import("@playwright/test").Page, gateName: string): Promise<void> {
	const gateRow = page.locator(".wf-checklist-item").filter({ hasText: gateName });
	await expect(gateRow).toBeVisible({ timeout: 15_000 });
	const viewLabel = gateRow.locator(".wf-checklist-view");
	if ((await viewLabel.textContent())?.trim() === "View") {
		await gateRow.click();
		await expect(viewLabel).toHaveText("Hide", { timeout: 5_000 });
	}
}

test.describe("Goal dashboard fanout", () => {
	test("dashboard receives subscribed gate updates live, persists after reload, and unrelated session tab stays quiet", async ({ page, context }) => {
		const goal = await createGoal({ title: `Dashboard fanout ${Date.now()}`, workflowId: "test-fast" });
		const unrelatedSessionId = await createSession();
		const unrelatedPage = await context.newPage();
		await unrelatedPage.addInitScript(() => {
			(window as any).__goalFanoutGateEvents = [];
			document.addEventListener("gate-verification-event", (event: Event) => {
				(window as any).__goalFanoutGateEvents.push((event as CustomEvent).detail);
			});
		});

		try {
			await openApp(page);
			await navigateToGoalDashboard(page, goal.id as string);
			await expandGate(page, "Design Doc");

			await openApp(unrelatedPage);
			await navigateToHash(unrelatedPage, `#/session/${unrelatedSessionId}`);
			await expect(unrelatedPage.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

			const signalResp = await apiFetch(`/api/goals/${goal.id}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nDashboard fanout browser journey." }),
			});
			expect(signalResp.status).toBe(201);

			const gateRow = page.locator(".wf-checklist-item").filter({ hasText: "Design Doc" });
			await expect(
				gateRow.locator(".wf-checklist-status-label"),
				"dashboard should update from the subscribed viewer WS before the 8s fallback poll",
			).toHaveText("passed", { timeout: 5_000 });
			await expect(gateRow.locator(".gate-signal-badge")).toHaveText("1 signal", { timeout: 5_000 });
			await expect(page.locator(".signal-entry").filter({ hasText: "passed" }).first()).toBeVisible({ timeout: 5_000 });

			const unrelatedEvents = await unrelatedPage.evaluate(() => (window as any).__goalFanoutGateEvents ?? []);
			expect(unrelatedEvents).toEqual([]);

			await page.reload();
			await expect(page.locator(".wf-checklist-item").filter({ hasText: "Design Doc" })).toBeVisible({ timeout: 15_000 });
			await expandGate(page, "Design Doc");
			const gateRowAfterReload = page.locator(".wf-checklist-item").filter({ hasText: "Design Doc" });
			await expect(gateRowAfterReload.locator(".wf-checklist-status-label")).toHaveText("passed", { timeout: 5_000 });
			await expect(gateRowAfterReload.locator(".gate-signal-badge")).toHaveText("1 signal", { timeout: 5_000 });
			await expect(page.locator(".signal-entry").filter({ hasText: "passed" }).first()).toBeVisible({ timeout: 5_000 });
		} finally {
			await unrelatedPage.close().catch(() => undefined);
			await deleteSession(unrelatedSessionId);
			await deleteGoal(goal.id as string);
		}
	});
});
