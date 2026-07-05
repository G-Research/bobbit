import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/settings-account-tab-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "settings-account-tab-bundle.js");

const SETTINGS_SRC = path.resolve("src/app/settings-page.ts");
const DIALOGS_SRC = path.resolve("src/app/dialogs.ts");

function fileUrl(file: string): string {
	return `file://${file.replace(/\\/g, "/")}`;
}

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, SETTINGS_SRC, DIALOGS_SRC],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(fileUrl(SHELL));
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__accountFixtureReady === true, null, { timeout: 10_000 });
}

const FUTURE = Date.now() + 86_400_000;

test.describe("Settings Account tab — Google OAuth row", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("renders a Google row with canonical id and 'Log in' when unauthenticated", async ({ page }) => {
		await page.evaluate(() => (window as any).__resetAccountTab({ status: {} }));

		const row = page.locator('[data-testid="account-row-google-gemini-cli"]');
		await expect(row).toBeVisible();
		await expect(row).toContainText("Google OAuth");
		await expect(page.locator('[data-testid="account-status-google-gemini-cli"]')).toHaveText("Not authenticated");
		await expect(page.locator('[data-testid="account-auth-btn-google-gemini-cli"]')).toContainText("Log in");

		// Logout button is hidden while unauthenticated.
		await expect(page.locator('[data-testid="account-logout-btn-google-gemini-cli"]')).toHaveCount(0);

		// Caution note retains the unofficial Code Assist / quota / terms warning and the
		// API-key separation, but no longer claims account models can't run sessions.
		const limitNote = page.locator('[data-testid="account-google-gemini-cli-limit-note"]');
		await expect(limitNote).toContainText(/Code Assist/);
		await expect(limitNote).toContainText(/quota/);
		await expect(limitNote).toContainText(/Google AI Studio API key/);
		await expect(limitNote).not.toContainText(/can't|cannot|does not make Gemini/i);
		await expect(page.locator('[data-testid="account-apikey-link-google-gemini-cli"]')).toContainText(/Provider API Keys/);

		// Anthropic/OpenAI rows still render (additive — peers unchanged).
		await expect(page.locator('[data-testid="account-row-anthropic"]')).toBeVisible();
		await expect(page.locator('[data-testid="account-row-openai-codex"]')).toBeVisible();
	});

	test("authenticated status persists across a simulated reload (status fetch)", async ({ page }) => {
		// Drive the real loadAccountStatus() fetch path: the status endpoint
		// reports Google authenticated. This is the reload-persistence path —
		// the client holds no token; it re-fetches status on mount.
		await page.evaluate((expires) => {
			(window as any).__setNextFetchResponse((url: string) => {
				if (url.includes("provider=google-gemini-cli")) return { ok: true, body: { authenticated: true, expires } };
				return { ok: true, body: { authenticated: false } };
			});
			(window as any).__resetAccountTab({}); // status null → triggers loadAccountStatus()
		}, FUTURE);

		const status = page.locator('[data-testid="account-status-google-gemini-cli"]');
		await expect(status).toHaveText("Authenticated");
		await expect(page.locator('[data-testid="account-auth-btn-google-gemini-cli"]')).toContainText("Re-authenticate");
		await expect(page.locator('[data-testid="account-logout-btn-google-gemini-cli"]')).toContainText("Log out");
		await expect(page.locator('[data-testid="account-expires-google-gemini-cli"]')).toBeVisible();
	});

	test("logout confirms, POSTs /api/oauth/logout for the canonical provider, and returns to 'Log in'", async ({ page }) => {
		// Seed Google authenticated, then after logout the status endpoint reports
		// unauthenticated.
		await page.evaluate((expires) => {
			(window as any).__resetAccountTab({ status: { "google-gemini-cli": { authenticated: true, expires } } });
			(window as any).__setNextFetchResponse({ ok: true, body: { authenticated: false } });
			(window as any).__clearFetchLog();
		}, FUTURE);

		await page.locator('[data-testid="account-logout-btn-google-gemini-cli"] button').click();
		// UX-03 (Fable audit): this is a destructive confirmAction dialog —
		// focus defaults to Cancel on open, and Enter is no longer bound
		// globally, so confirming requires clicking (or tabbing to) the
		// dialog's own "Log out" button rather than a stray Enter.
		// dispatchEvent (not .click()) — this fixture loads no CSS, so the
		// dialog's inline `position: fixed` centering never actually applies
		// and Playwright's actionability check sees it as out-of-viewport;
		// mirrors the same workaround already used for this reason elsewhere
		// (settings-admin-fixture.spec.ts's model-selector clicks).
		await page.locator('[role="dialog"]').getByRole("button", { name: "Log out" }).dispatchEvent("click");

		await expect(page.locator('[data-testid="account-status-google-gemini-cli"]')).toHaveText("Not authenticated");
		await expect(page.locator('[data-testid="account-auth-btn-google-gemini-cli"]')).toContainText("Log in");

		const log = await page.evaluate(() => (window as any).__getFetchLog());
		const logoutCalls = log.filter((e: any) => e.url === "/api/oauth/logout" && e.method === "POST");
		expect(logoutCalls).toHaveLength(1);
		expect(logoutCalls[0].body).toEqual({ provider: "google-gemini-cli" });
	});

	test("UX-03: an unfocused Enter on the logout confirm dialog cancels instead of confirming (no accidental logout)", async ({ page }) => {
		await page.evaluate((expires) => {
			(window as any).__resetAccountTab({ status: { "google-gemini-cli": { authenticated: true, expires } } });
			(window as any).__setNextFetchResponse({ ok: true, body: { authenticated: false } });
			(window as any).__clearFetchLog();
		}, FUTURE);

		await page.locator('[data-testid="account-logout-btn-google-gemini-cli"] button').click();
		await expect(page.locator('[role="dialog"]')).toBeVisible();

		// This is the exact repro from finding UX-03: press Enter without
		// clicking or tabbing anywhere. Destructive confirmAction dialogs now
		// default focus to Cancel, so a stray Enter cancels — it used to
		// confirm the destructive logout unconditionally.
		await page.keyboard.press("Enter");

		await expect(page.locator('[role="dialog"]')).toHaveCount(0);
		await expect(page.locator('[data-testid="account-status-google-gemini-cli"]')).toHaveText("Authenticated");
		const log = await page.evaluate(() => (window as any).__getFetchLog());
		expect(log.filter((e: any) => e.url === "/api/oauth/logout" && e.method === "POST")).toHaveLength(0);
	});
});
