/**
 * Sidebar stories E2E smoke — CT-03/CT-04 matrix coverage now lives in
 * tests/ui-fixtures/sidebar-navigation-fixture.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import {
	createSession,
	deleteSession,
	apiFetch,
	nonGitCwd,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("CT-03 & CT-04: Sidebar stories", () => {
	const sessionIds: string[] = [];

	test.afterEach(async () => {
		for (const id of sessionIds.splice(0)) {
			await deleteSession(id).catch(() => {});
		}
	});

	test("SB-24/SB-concurrent: Filter search narrows concurrently created sessions @smoke", async ({ page }) => {
		const [sessionA, sessionB, sessionC] = await Promise.all([
			createSession({ cwd: nonGitCwd() }),
			createSession({ cwd: nonGitCwd() }),
			createSession({ cwd: nonGitCwd() }),
		]);
		sessionIds.push(sessionA, sessionB, sessionC);
		await Promise.all([
			waitForSessionStatus(sessionA, "idle"),
			waitForSessionStatus(sessionB, "idle"),
			waitForSessionStatus(sessionC, "idle"),
		]);
		await Promise.all([
			apiFetch(`/api/sessions/${sessionA}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "AlphaSBTest" }),
			}),
			apiFetch(`/api/sessions/${sessionB}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "BravoSBTest" }),
			}),
			apiFetch(`/api/sessions/${sessionC}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "CharlieSBTest" }),
			}),
		]);

		await openApp(page);
		await expect(page.getByText("AlphaSBTest")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText("BravoSBTest")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("CharlieSBTest")).toBeVisible({ timeout: 5_000 });

		await page.keyboard.press("Control+k");
		const searchInput = page.locator("input[data-search]");
		await expect(searchInput).toBeFocused({ timeout: 5_000 });
		await searchInput.fill("AlphaSB");

		await expect(page.getByText("AlphaSBTest")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("BravoSBTest")).not.toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("CharlieSBTest")).not.toBeVisible({ timeout: 5_000 });

		await searchInput.fill("");
		await expect(page.getByText("AlphaSBTest")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("BravoSBTest")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("CharlieSBTest")).toBeVisible({ timeout: 5_000 });
	});
});
