import { test, expect } from "../gateway-harness.js";
import { apiFetch, deleteSession } from "../e2e-setup.js";
import { createSessionViaUI, openApp } from "./ui-helpers.js";

test.describe.configure({ mode: "serial" });

const PACK = "performance-optimisation";
const PANEL = '[data-testid="performance-optimisation-panel"]';

async function setEnabled(enabled: boolean): Promise<void> {
	await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({
			scope: "server",
			packName: PACK,
			disabled: enabled
				? { enabled: true, roles: [], tools: [], skills: [], entrypoints: [] }
				: { roles: [], tools: [], skills: [], entrypoints: [] },
		}),
	});
}

test.describe("performance optimisation pack", () => {
	let sessionId: string | undefined;

	test.beforeEach(async () => {
		await setEnabled(true);
	});

	test.afterEach(async () => {
		if (sessionId) await deleteSession(sessionId).catch(() => {});
		sessionId = undefined;
		await setEnabled(false).catch(() => {});
	});

	test("launcher, deep-link fixture, responsive flow, tabs, reload, and cleanup @smoke", async ({ page }) => {
		test.setTimeout(60_000);
		await page.setViewportSize({ width: 1400, height: 900 });
		await openApp(page);
		sessionId = await createSessionViaUI(page);
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.());
		const projectSnapshotResponse = page.waitForResponse((response) => response.url().includes("/api/ext/project-snapshot"));
		await page.evaluate(() => (window as any).__bobbitRunPackLauncher?.("performance-optimisation.open"));

		const panel = page.locator(PANEL);
		await expect(panel).toBeVisible({ timeout: 20_000 });
		expect((await projectSnapshotResponse).ok()).toBe(true);
		await expect(panel.getByRole("tab", { name: "Flow map" })).toBeVisible();
		await expect(panel.getByText(/live project state$/)).toBeVisible();

		await page.reload();
		await expect(page.locator(PANEL), "the launcher-opened singleton panel survives reload").toBeVisible({ timeout: 20_000 });
		await expect(page.locator(PANEL).getByText(/live project state$/)).toBeVisible();

		// The route is registered by the real pack contribution. `demo=true` is an
		// explicitly labelled visual-development fixture, never the launcher default.
		await page.goto(`${page.url().split("#")[0]}#/ext/performance-optimisation?tab=flow&demo=true`);
		await expect(panel).toContainText("Development fixture · not live project data", { timeout: 20_000 });
		for (const name of ["Performance Scanner", "Hypothesis Registry", "Optimisation Director", "Goals", "Pull Requests"]) {
			await expect(panel.getByText(name, { exact: true }).first()).toBeVisible();
		}
		await expect(panel.getByText("Live active scans", { exact: true })).toBeVisible();
		await expect(panel.getByText("Completed scans · last 24h", { exact: true })).toBeVisible();

		await panel.getByRole("tab", { name: "Scan coverage" }).click();
		await expect(panel.getByRole("searchbox", { name: "Filter scan coverage" })).toBeVisible();
		await panel.getByRole("tab", { name: "Hypothesis registry" }).click();
		await expect(panel.getByRole("searchbox", { name: "Search hypothesis registry" })).toBeVisible();

		await page.setViewportSize({ width: 560, height: 900 });
		await panel.getByRole("tab", { name: "Flow map" }).click();
		const overlaps = await panel.locator(".po-node").evaluateAll((nodes) => {
			const rects = nodes.map((node) => node.getBoundingClientRect());
			return rects.flatMap((a, i) => rects.slice(i + 1).filter((b) =>
				Math.max(a.left, b.left) < Math.min(a.right, b.right)
				&& Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom),
			).map(() => i));
		});
		expect(overlaps, "responsive flow cards must not overlap").toEqual([]);
		await expect(page.locator(PANEL).getByText("Live activity", { exact: true })).toBeVisible();
	});
});
