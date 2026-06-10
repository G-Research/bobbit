/**
 * Browser E2E — Manage PR walkthrough trusted GitHub hosts.
 *
 * Covers two surfaces from docs/design "Manage PR walkthrough trusted hosts":
 *   1. System → General → "Trusted GitHub hosts": add a host, persist across
 *      reload, remove it.
 *   2. PR walkthrough launch: an untrusted host surfaces the risk-warning
 *      dialog; confirming adds the host to preferences and the launch proceeds
 *      (no untrusted error); cancelling creates no walkthrough tab.
 *
 * Pattern: tests/e2e/ui/settings.spec.ts (settings) +
 *          tests/e2e/ui/pr-walkthrough-panel.spec.ts (launch).
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const tid = (id: string) => `[data-testid="${id}"]`;

async function resetTrustedHosts(): Promise<void> {
	await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ githubTrustedHosts: [] }),
	}).catch(() => undefined);
}

async function readTrustedHosts(): Promise<string[]> {
	const res = await apiFetch("/api/preferences");
	if (!res.ok) return [];
	const prefs = await res.json() as Record<string, unknown>;
	const hosts = prefs.githubTrustedHosts;
	return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
}

async function openGeneralSettings(page: Page): Promise<void> {
	await navigateToHash(page, "#/settings/system/general");
	await expect(page.locator(tid("github-trusted-host-input"))).toBeVisible({ timeout: 10_000 });
}

test.describe("Trusted GitHub hosts — settings", () => {
	test("add a host, persist across reload, then remove it", async ({ page }) => {
		await resetTrustedHosts();
		try {
			const host = "ghe.example.com";
			await openApp(page);
			await openGeneralSettings(page);

			// Add a host. The PUT is fire-and-forget; wait for it to land.
			const putAfterAdd = page.waitForResponse(
				(resp) => resp.url().includes("/api/preferences") && resp.request().method() === "PUT",
			);
			await page.locator(tid("github-trusted-host-input")).fill(host);
			await page.locator(tid("github-trusted-host-add")).click();
			await putAfterAdd;

			const row = page.locator(`${tid("github-trusted-host-row")}[data-host="${host}"]`);
			await expect(row).toBeVisible({ timeout: 5_000 });
			await expect.poll(readTrustedHosts).toContain(host);

			// Reload — value should persist.
			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
			await openGeneralSettings(page);
			await expect(page.locator(`${tid("github-trusted-host-row")}[data-host="${host}"]`)).toBeVisible({ timeout: 5_000 });

			// Remove it.
			const putAfterRemove = page.waitForResponse(
				(resp) => resp.url().includes("/api/preferences") && resp.request().method() === "PUT",
			);
			await page.locator(`${tid("github-trusted-host-row")}[data-host="${host}"]`).locator(tid("github-trusted-host-remove")).click();
			await putAfterRemove;
			await expect(page.locator(`${tid("github-trusted-host-row")}[data-host="${host}"]`)).toHaveCount(0);
			await expect.poll(readTrustedHosts).not.toContain(host);

			// Reload — removal should persist.
			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
			await openGeneralSettings(page);
			await expect(page.locator(`${tid("github-trusted-host-row")}[data-host="${host}"]`)).toHaveCount(0);
		} finally {
			await resetTrustedHosts();
		}
	});

	test("rejects invalid input without persisting", async ({ page }) => {
		await resetTrustedHosts();
		try {
			await openApp(page);
			await openGeneralSettings(page);
			await page.locator(tid("github-trusted-host-input")).fill("not a host / with spaces");
			await page.locator(tid("github-trusted-host-add")).click();
			// Input clears, no row added.
			await expect(page.locator(tid("github-trusted-host-input"))).toHaveValue("");
			await expect(page.locator(tid("github-trusted-host-row"))).toHaveCount(0);
			expect(await readTrustedHosts()).toEqual([]);
		} finally {
			await resetTrustedHosts();
		}
	});
});

// NOTE: the untrusted-launch risk-dialog tests were removed with the built-in
// PR-walkthrough viewer/launcher deletion. The launch flow no longer has a
// client launcher (`/walkthrough-pr`); the first-party pack provides the
// entrypoints, and the server `/api/pr-walkthrough/launch` route + its trusted-
// host enforcement are covered by tests/e2e/pr-walkthrough-api.spec.ts. The
// trusted-hosts SETTINGS surface (above) is unaffected and still verified here.
