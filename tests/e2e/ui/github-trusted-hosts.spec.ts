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
import { openApp, navigateToHash, createSessionViaUI, sendMessage } from "./ui-helpers.js";

const PANEL_TAB_SELECTOR = ".goal-preview-panel .goal-tab-pill[data-panel-tab-kind='walkthrough']";
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

const ENTERPRISE_PR_URL = "https://ghe.example.com/owner/repo/pull/5";
const ENTERPRISE_HOST = "ghe.example.com";

/**
 * Intercept the launch endpoint: the first call returns the server's untrusted-host
 * 400 (no job created); subsequent calls (the post-confirm retry) succeed.
 */
async function installUntrustedThenTrustedLaunchRoute(page: Page): Promise<{ launchCalls: () => number }> {
	let calls = 0;
	await page.route("**/api/pr-walkthrough/launch", async (route) => {
		if (route.request().method() !== "POST") {
			await route.fallback();
			return;
		}
		calls += 1;
		if (calls === 1) {
			await route.fulfill({
				status: 400,
				contentType: "application/json",
				body: JSON.stringify({
					error: `Untrusted GitHub PR host: ${ENTERPRISE_HOST}`,
					message: `Untrusted GitHub PR host: ${ENTERPRISE_HOST}`,
					code: "untrusted_github_host",
					host: ENTERPRISE_HOST,
				}),
			});
			return;
		}
		const changesetId = `github:${ENTERPRISE_HOST}/owner/repo#5:abc1234`;
		await route.fulfill({
			status: 201,
			contentType: "application/json",
			body: JSON.stringify({
				jobId: `job-${Date.now()}`,
				childSessionId: `child-${Date.now()}`,
				changesetId,
				status: "waiting_for_yaml",
				tabId: `walkthrough:${encodeURIComponent(changesetId)}`,
				created: true,
			}),
		});
	});
	return { launchCalls: () => calls };
}

async function launchEnterpriseWalkthrough(page: Page): Promise<void> {
	await openApp(page);
	await createSessionViaUI(page);
	await sendMessage(page, `/walkthrough-pr ${ENTERPRISE_PR_URL}`);
}

test.describe("Trusted GitHub hosts — untrusted launch dialog", () => {
	test("confirming the risk dialog adds the host and the launch proceeds", async ({ page }) => {
		await resetTrustedHosts();
		try {
			const { launchCalls } = await installUntrustedThenTrustedLaunchRoute(page);
			await launchEnterpriseWalkthrough(page);

			// The risk dialog names the host and warns about the consequences.
			const dialogText = page.getByText(new RegExp(`${ENTERPRISE_HOST}[\\s\\S]*not in your trusted GitHub hosts`, "i")).first();
			await expect(dialogText).toBeVisible({ timeout: 10_000 });
			const addBtn = page.getByRole("button", { name: "Add & continue" });
			await expect(addBtn).toBeVisible();

			// Confirm → host persisted + launch retried.
			await addBtn.click();
			await expect.poll(launchCalls, { timeout: 10_000, message: "launch should be retried after confirm" }).toBe(2);
			await expect.poll(readTrustedHosts, { timeout: 10_000 }).toContain(ENTERPRISE_HOST);
		} finally {
			await resetTrustedHosts();
		}
	});

	test("cancelling the risk dialog aborts without a walkthrough tab", async ({ page }) => {
		await resetTrustedHosts();
		try {
			const { launchCalls } = await installUntrustedThenTrustedLaunchRoute(page);
			await launchEnterpriseWalkthrough(page);

			const cancelBtn = page.getByRole("button", { name: "Cancel" });
			await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
			await cancelBtn.click();

			// No retry, no persisted host, no walkthrough panel tab.
			await expect(page.locator(PANEL_TAB_SELECTOR)).toHaveCount(0);
			expect(launchCalls()).toBe(1);
			expect(await readTrustedHosts()).not.toContain(ENTERPRISE_HOST);
		} finally {
			await resetTrustedHosts();
		}
	});
});
