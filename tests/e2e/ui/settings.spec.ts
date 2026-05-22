/**
 * Settings E2E tests: tab switching, persistence, per-project scope.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Create a unique temp dir for project rootPath to avoid conflicts. */
function uniqueProjectDir(): string {
	const dir = join(tmpdir(), `bobbit-e2e-settings-${process.env.E2E_PORT}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const CLOUD_PROVIDERS = [
	{
		id: "anthropic",
		title: "Anthropic",
		description: "Claude models through Anthropic direct cloud.",
	},
	{
		id: "openai",
		title: "OpenAI",
		description: "GPT models, OpenAI Codex OAuth, and OpenAI image models.",
	},
	{
		id: "google",
		title: "Google Gemini",
		description: "Gemini text models and Google image models.",
	},
] as const;

type CloudProviderId = typeof CLOUD_PROVIDERS[number]["id"];

const PROVIDER_KEY_ALIASES = ["anthropic", "openai", "openai-codex", "google", "google-gemini-cli"];

async function expectResponseOk(resp: Response): Promise<void> {
	if (!resp.ok) expect(resp.ok, await resp.text()).toBe(true);
}

async function putPreferences(values: Record<string, unknown>): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify(values),
	});
	await expectResponseOk(resp);
}

async function cleanupCloudProviderState(): Promise<void> {
	for (const provider of PROVIDER_KEY_ALIASES) {
		await apiFetch(`/api/provider-keys/${provider}`, { method: "DELETE" }).catch(() => undefined);
	}
	await putPreferences({
		"providerEnabled.anthropic": false,
		"providerEnabled.openai": false,
		"providerEnabled.google": false,
		"providerCredentialInvalid.anthropic": null,
		"providerCredentialInvalid.openai": null,
		"providerCredentialInvalid.google": null,
		"aigw.url": null,
		"aigw.models": null,
	});
}

async function providerKeyList(): Promise<string[]> {
	const resp = await apiFetch("/api/provider-keys");
	await expectResponseOk(resp);
	const body = await resp.json();
	return Array.isArray(body?.providers) ? body.providers : [];
}

async function expectNoSavedProviderKeys(): Promise<void> {
	const providers = await providerKeyList();
	expect(providers).not.toEqual(expect.arrayContaining(PROVIDER_KEY_ALIASES));
}

async function expectProviderPreference(provider: CloudProviderId, enabled: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences");
	await expectResponseOk(resp);
	const prefs = await resp.json();
	expect(prefs[`providerEnabled.${provider}`]).toBe(enabled);
}

async function openAccountSettings(page: Parameters<typeof openApp>[0]) {
	await openApp(page);
	await navigateToHash(page, "#/settings/system/account");
	await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });
	await expect(page.locator("[data-testid='settings-account-cloud-providers']")).toBeVisible({ timeout: 10_000 });
	await expect(page.locator("[data-testid='provider-card-anthropic']")).toBeVisible({ timeout: 10_000 });
}

test.describe("Settings (full-stack UI)", () => {
	test("open settings and switch tabs @smoke", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		// Verify settings view renders — look for "Settings" heading
		await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });

		// Verify General tab content is visible — it has the "Show message timestamps" checkbox
		await expect(page.getByText("Show message timestamps")).toBeVisible({ timeout: 5_000 });

		// Switch to Models tab
		const modelsTab = page.locator("button").filter({ hasText: "Models" }).first();
		await modelsTab.click();

		// The URL should update to reflect the Models tab
		await expect(page).toHaveURL(/#\/settings\/system\/models/, { timeout: 5_000 });

		// Switch to Shortcuts tab
		const shortcutsTab = page.locator("button").filter({ hasText: "Shortcuts" }).first();
		await shortcutsTab.click();
		await expect(page).toHaveURL(/#\/settings\/system\/shortcuts/, { timeout: 5_000 });

		// Switch to Color Palette tab
		const paletteTab = page.locator("button").filter({ hasText: "Color Palette" }).first();
		await paletteTab.click();
		await expect(page).toHaveURL(/#\/settings\/system\/palette/, { timeout: 5_000 });
	});

	test("account tab cloud provider toggles render, persist, and clean up", async ({ page }) => {
		await cleanupCloudProviderState();
		try {
			await openAccountSettings(page);

			const section = page.locator("[data-testid='settings-account-cloud-providers']");
			await expect(section).toContainText("Cloud model providers");
			await expect(section).toContainText("Choose which cloud vendors Bobbit can use directly.");

			for (const provider of CLOUD_PROVIDERS) {
				const card = page.locator(`[data-testid='provider-card-${provider.id}']`);
				const toggle = page.locator(`[data-testid='provider-enabled-${provider.id}']`);
				const status = page.locator(`[data-testid='provider-status-${provider.id}']`);
				await expect(card).toBeVisible({ timeout: 5_000 });
				await expect(card).toContainText(provider.title);
				await expect(card).toContainText(provider.description);
				await expect(toggle).toBeVisible();
				await expect(toggle).not.toBeChecked();
				await expect(status).toContainText("Disabled");
			}
			await expectNoSavedProviderKeys();

			for (const provider of CLOUD_PROVIDERS) {
				const toggle = page.locator(`[data-testid='provider-enabled-${provider.id}']`);
				const responsePromise = page.waitForResponse(resp =>
					resp.url().includes(`/api/cloud-providers/${provider.id}`)
					&& resp.request().method() === "PUT"
					&& resp.status() === 200,
				);
				await toggle.click();
				await responsePromise;
				await expect(toggle).toBeChecked({ timeout: 10_000 });
				await expect(page.locator(`[data-testid='provider-status-${provider.id}']`)).toContainText(/Enabled|Authenticated/, { timeout: 10_000 });
				await expectProviderPreference(provider.id, true);
			}
			await expectNoSavedProviderKeys();

			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
			await navigateToHash(page, "#/settings/system/account");
			for (const provider of CLOUD_PROVIDERS) {
				await expect(page.locator(`[data-testid='provider-enabled-${provider.id}']`)).toBeChecked({ timeout: 10_000 });
			}

			for (const provider of CLOUD_PROVIDERS) {
				const toggle = page.locator(`[data-testid='provider-enabled-${provider.id}']`);
				const responsePromise = page.waitForResponse(resp =>
					resp.url().includes(`/api/cloud-providers/${provider.id}`)
					&& resp.request().method() === "PUT"
					&& resp.status() === 200,
				);
				await toggle.click();
				await responsePromise;
				await expect(toggle).not.toBeChecked({ timeout: 10_000 });
				await expect(page.locator(`[data-testid='provider-status-${provider.id}']`)).toContainText("Disabled", { timeout: 10_000 });
				await expectProviderPreference(provider.id, false);
			}
			await expectNoSavedProviderKeys();
		} finally {
			await cleanupCloudProviderState();
		}
	});

	test("account tab shows AI Gateway banner and paused cloud provider statuses", async ({ page }) => {
		await cleanupCloudProviderState();
		try {
			await putPreferences({ "aigw.url": "http://127.0.0.1:9" });

			const statusResp = await apiFetch("/api/cloud-providers/status");
			await expectResponseOk(statusResp);
			const status = await statusResp.json();
			expect(status.mode).toBe("aigw");
			expect(status.authGateRequired).toBe(false);

			await openAccountSettings(page);
			const section = page.locator("[data-testid='settings-account-cloud-providers']");
			await expect(section.getByText("AI Gateway is handling model access")).toBeVisible({ timeout: 10_000 });
			await expect(section).toContainText("Cloud provider sign-in prompts are paused while AI Gateway is configured.");

			for (const provider of CLOUD_PROVIDERS) {
				const card = page.locator(`[data-testid='provider-card-${provider.id}']`);
				await expect(card.locator(`[data-testid='provider-status-${provider.id}']`)).toContainText("Paused by AI Gateway", { timeout: 10_000 });
				await expect(card).toContainText("AI Gateway is active, so Bobbit will not prompt for this provider.");
			}
		} finally {
			await cleanupCloudProviderState();
		}
	});

	test("setting persists after reload", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		// Wait for the General tab content to fully render
		await expect(page.getByText("Show message timestamps")).toBeVisible({ timeout: 10_000 });
		const checkbox = page.locator("input[type='checkbox']").first();
		await expect(checkbox).toBeVisible({ timeout: 5_000 });

		// Get the current state of the checkbox
		const wasChecked = await checkbox.isChecked();

		// Set up response listener BEFORE the click to avoid race condition
		const responsePromise = page.waitForResponse(
			resp => resp.url().includes("/api/preferences") && resp.status() === 200
		);

		// Toggle the checkbox
		await checkbox.click();

		// Verify the checkbox toggled
		if (wasChecked) {
			await expect(checkbox).not.toBeChecked();
		} else {
			await expect(checkbox).toBeChecked();
		}

		// Wait for the setting to persist
		await responsePromise;

		// Reload the page
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// Navigate back to settings
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.getByText("Show message timestamps")).toBeVisible({ timeout: 10_000 });

		// Verify the checkbox retained its new state
		const checkboxAfterReload = page.locator("input[type='checkbox']").first();
		await expect(checkboxAfterReload).toBeVisible({ timeout: 5_000 });

		if (wasChecked) {
			await expect(checkboxAfterReload).not.toBeChecked();
		} else {
			await expect(checkboxAfterReload).toBeChecked();
		}

		// Clean up: toggle back to original state
		await checkboxAfterReload.click();
	});

	test("play-finish-sound toggle persists after reload", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		await expect(page.getByText("Play sound when an agent finishes")).toBeVisible({ timeout: 10_000 });
		const checkbox = page.locator("[data-testid='general-play-finish-sound']");
		await expect(checkbox).toBeVisible({ timeout: 5_000 });

		// Default: ON.
		await expect(checkbox).toBeChecked();

		// Synchronous dataset flag is the testable seam for the playNotificationBeep guard.
		const initialDataset = await page.evaluate(() => document.documentElement.dataset.playAgentFinishSound);
		expect(initialDataset === undefined || initialDataset === "true").toBe(true);

		// Uncheck → verify dataset flips synchronously → verify persists across reload.
		let responsePromise = page.waitForResponse(
			resp => resp.url().includes("/api/preferences") && resp.request().method() === "PUT" && resp.status() === 200,
		);
		await checkbox.click();
		await expect(checkbox).not.toBeChecked();
		await expect.poll(
			() => page.evaluate(() => document.documentElement.dataset.playAgentFinishSound),
		).toBe("false");
		await responsePromise;

		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.getByText("Play sound when an agent finishes")).toBeVisible({ timeout: 10_000 });
		const afterReload = page.locator("[data-testid='general-play-finish-sound']");
		await expect(afterReload).toBeVisible({ timeout: 5_000 });
		await expect(afterReload).not.toBeChecked();
		await expect.poll(
			() => page.evaluate(() => document.documentElement.dataset.playAgentFinishSound),
		).toBe("false");

		// Re-check → reload → still checked.
		responsePromise = page.waitForResponse(
			resp => resp.url().includes("/api/preferences") && resp.request().method() === "PUT" && resp.status() === 200,
		);
		await afterReload.click();
		await expect(afterReload).toBeChecked();
		await responsePromise;

		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.getByText("Play sound when an agent finishes")).toBeVisible({ timeout: 10_000 });
		const finalCheckbox = page.locator("[data-testid='general-play-finish-sound']");
		await expect(finalCheckbox).toBeChecked();
	});

	test("skills catalog budget: change, persists across reload, reset clears preference", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");

		// Navigation
		await expect(page.getByText("Skills catalog budget")).toBeVisible({ timeout: 10_000 });
		const input = page.locator("[data-testid='general-skills-catalog-budget']");
		const resetBtn = page.locator("[data-testid='general-skills-catalog-budget-reset']");
		await expect(input).toBeVisible({ timeout: 5_000 });

		// Default: 16 KB (server default; no override stored).
		await expect(input).toHaveValue("16");
		await expect(resetBtn).toBeDisabled();

		// Happy path: change to 32 KB and wait for the PUT to complete.
		let responsePromise = page.waitForResponse(
			resp => resp.url().includes("/api/preferences") && resp.request().method() === "PUT" && resp.status() === 200,
		);
		await input.fill("32");
		await input.blur();
		await responsePromise;
		await expect(resetBtn).toBeEnabled();

		// Persistence: reload and confirm 32 KB stuck.
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/settings/system/general");
		const inputAfter = page.locator("[data-testid='general-skills-catalog-budget']");
		await expect(inputAfter).toBeVisible({ timeout: 10_000 });
		await expect(inputAfter).toHaveValue("32");

		// Verify GET /api/preferences reflects the override.
		const prefs1 = await (await apiFetch("/api/preferences")).json();
		expect(prefs1.skillsCatalogBudget).toBe(32 * 1024);

		// Cleanup/undo: reset returns to default and clears the preference.
		responsePromise = page.waitForResponse(
			resp => resp.url().includes("/api/preferences") && resp.request().method() === "PUT" && resp.status() === 200,
		);
		const resetBtnAfter = page.locator("[data-testid='general-skills-catalog-budget-reset']");
		await resetBtnAfter.click();
		await responsePromise;
		await expect(inputAfter).toHaveValue("16");
		await expect(resetBtnAfter).toBeDisabled();

		const prefs2 = await (await apiFetch("/api/preferences")).json();
		expect(prefs2.skillsCatalogBudget).toBeUndefined();
	});

	test("per-project settings scope switching", async ({ page }) => {
		// Create a project via API
		const resp = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "Settings Test Project", rootPath: uniqueProjectDir() }),
		});
		expect(resp.ok).toBe(true);
		const project = await resp.json();
		const projectId = project.id;

		try {
			await openApp(page);

			// Navigate to the project's appearance settings
			await navigateToHash(page, `#/settings/${projectId}/appearance`);

			// Verify settings view is rendered
			await expect(page.locator("h1").filter({ hasText: "Settings" })).toBeVisible({ timeout: 10_000 });

			// Verify the project scope button is active (has the active styling) —
			// look for a button with the project name that has the active class
			const projectScopeBtn = page.locator("button").filter({ hasText: "Settings Test Project" });
			await expect(projectScopeBtn).toBeVisible({ timeout: 5_000 });

			// Verify we're on the Appearance tab — look for the Appearance tab button
			// that has the active styling (bg-background class)
			const appearanceTab = page.locator("button").filter({ hasText: "Appearance" });
			await expect(appearanceTab).toBeVisible({ timeout: 5_000 });

			// Verify Appearance tab content is visible — it should have palette or color inputs
			// The appearance tab has "Color Palette" and accent color controls
			await expect(
				page.getByText("Palette").first()
			).toBeVisible({ timeout: 5_000 });
		} finally {
			// Clean up the project
			await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	// PR #369 review fix L1: Account-tab provider connect buttons share a single
	// `accountReauthing` state — when ANY OAuth flow is in flight, every provider
	// connect button is disabled (prevents concurrent OAuth attempts from
	// clobbering each other's pendingFlows entries).
	test("Account tab: clicking an OAuth connect button disables every provider connect button", async ({ page }) => {
		await cleanupCloudProviderState();
		await openAccountSettings(page);

		const connectButtons = page.locator("[data-testid^='provider-connect-']");
		await expect(connectButtons.first()).toBeVisible({ timeout: 10_000 });
		const total = await connectButtons.count();
		expect(total).toBe(CLOUD_PROVIDERS.length);

		for (let i = 0; i < total; i++) {
			await expect(connectButtons.nth(i)).toBeEnabled({ timeout: 5_000 });
		}

		await page.locator("[data-testid='provider-connect-anthropic']").click();

		for (let i = 0; i < total; i++) {
			await expect(connectButtons.nth(i)).toBeDisabled({ timeout: 5_000 });
		}

		await page.getByRole("button", { name: "Cancel" }).last().click({ timeout: 10_000 }).catch(() => undefined);
	});
});
