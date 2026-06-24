import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/oauth-expiry-modal-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "oauth-expiry-modal-bundle.js");

const SESSION_MANAGER_SRC = path.resolve("src/app/session-manager.ts");
const DIALOGS_SRC = path.resolve("src/app/dialogs.ts");
const DIALOGS_LAZY_SRC = path.resolve("src/app/dialogs-lazy.ts");
const GATEWAY_FETCH_SRC = path.resolve("src/app/gateway-fetch.ts");
const STATE_SRC = path.resolve("src/app/state.ts");

const ANTHROPIC_EXPIRES = 1_700_000_001_000;
const OPENAI_EXPIRES = 1_700_000_002_000;
const GOOGLE_EXPIRES = 1_700_000_003_000;
const GOOGLE_EXPIRES_CHANGED = 1_700_000_004_000;

type OAuthStatus = { authenticated: boolean; expires?: number };
type ProviderId = "anthropic" | "openai-codex" | "google-gemini-cli";
type StatusMap = Partial<Record<ProviderId, OAuthStatus>>;

function fileUrl(file: string): string {
	return `file://${file.replace(/\\/g, "/")}`;
}

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, SESSION_MANAGER_SRC, DIALOGS_SRC, DIALOGS_LAZY_SRC, GATEWAY_FETCH_SRC, STATE_SRC],
	});
});

async function loadFixture(page: Page, statuses: StatusMap, opts: { preserveStorage?: boolean } = {}): Promise<void> {
	await page.goto(fileUrl(SHELL));
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__oauthExpiryFixtureReady === true, null, { timeout: 10_000 });
	if (opts.preserveStorage) {
		await page.evaluate((next) => (window as any).__setOAuthExpiryStatuses(next), statuses);
	} else {
		await page.evaluate((next) => (window as any).__resetOAuthExpiryFixture(next), statuses);
	}
}

async function runGatewayAuth(page: Page): Promise<void> {
	await page.evaluate(() => (window as any).__runGatewayAuth());
}

async function startGatewayAuth(page: Page): Promise<void> {
	await page.evaluate(() => (window as any).__startGatewayAuth());
}

function expired(expires: number): OAuthStatus {
	return { authenticated: false, expires };
}

function authenticated(): OAuthStatus {
	return { authenticated: true, expires: Date.now() + 86_400_000 };
}

function modalPrimary(page: Page) {
	return page.getByRole("button", { name: "Go to Account Settings" });
}

function modalDismiss(page: Page) {
	return page.getByRole("button", { name: "Dismiss" });
}

async function expectExpiryModalFor(page: Page, providerNames: string[]): Promise<void> {
	await expect(modalPrimary(page)).toBeVisible();
	await expect(modalDismiss(page)).toBeVisible();
	for (const name of providerNames) {
		await expect(page.locator("body")).toContainText(name);
	}
}

test.describe("OAuth expiry modal fixture", () => {
	test("expired existing credentials for every account provider show one provider-neutral modal", async ({ page }) => {
		await loadFixture(page, {
			anthropic: expired(ANTHROPIC_EXPIRES),
			"openai-codex": expired(OPENAI_EXPIRES),
			"google-gemini-cli": expired(GOOGLE_EXPIRES),
		});

		await startGatewayAuth(page);

		await expectExpiryModalFor(page, ["Anthropic", "OpenAI", "Google"]);
		await expect(page.locator("button")).toHaveText(["Dismiss", "Go to Account Settings"]);
	});

	test("never-authenticated or missing credentials do not show the expiry modal or launch legacy OAuth", async ({ page }) => {
		await loadFixture(page, {
			anthropic: { authenticated: false },
			"openai-codex": { authenticated: false },
			"google-gemini-cli": { authenticated: false },
		});

		await startGatewayAuth(page);
		await page.waitForTimeout(250);

		await expect(modalPrimary(page)).toHaveCount(0);
		await expect(page.locator("body")).not.toContainText(/Anthropic Login|OpenAI Login|Google Login/);
	});

	test("dismiss suppresses the same provider plus expiry reminder across auth checks and reloads", async ({ page }) => {
		const statuses = {
			anthropic: authenticated(),
			"openai-codex": { authenticated: false },
			"google-gemini-cli": expired(GOOGLE_EXPIRES),
		} satisfies StatusMap;
		await loadFixture(page, statuses);

		await runGatewayAuth(page);
		await expectExpiryModalFor(page, ["Google"]);
		await modalDismiss(page).click();
		await expect(modalPrimary(page)).toHaveCount(0);

		await runGatewayAuth(page);
		await page.waitForTimeout(100);
		await expect(modalPrimary(page)).toHaveCount(0);

		await loadFixture(page, statuses, { preserveStorage: true });
		await runGatewayAuth(page);
		await page.waitForTimeout(100);
		await expect(modalPrimary(page)).toHaveCount(0);
	});

	test("a different expired provider resurfaces the modal after dismissing another provider", async ({ page }) => {
		await loadFixture(page, {
			anthropic: authenticated(),
			"openai-codex": { authenticated: false },
			"google-gemini-cli": expired(GOOGLE_EXPIRES),
		});
		await runGatewayAuth(page);
		await expectExpiryModalFor(page, ["Google"]);
		await modalDismiss(page).click();

		await page.evaluate((next) => (window as any).__setOAuthExpiryStatuses(next), {
			anthropic: authenticated(),
			"openai-codex": expired(OPENAI_EXPIRES),
			"google-gemini-cli": expired(GOOGLE_EXPIRES),
		} satisfies StatusMap);
		await runGatewayAuth(page);

		await expectExpiryModalFor(page, ["OpenAI"]);
	});

	test("a changed expiry timestamp resurfaces the modal for the same provider", async ({ page }) => {
		await loadFixture(page, {
			anthropic: authenticated(),
			"openai-codex": { authenticated: false },
			"google-gemini-cli": expired(GOOGLE_EXPIRES),
		});
		await runGatewayAuth(page);
		await expectExpiryModalFor(page, ["Google"]);
		await modalDismiss(page).click();

		await page.evaluate((next) => (window as any).__setOAuthExpiryStatuses(next), {
			anthropic: authenticated(),
			"openai-codex": { authenticated: false },
			"google-gemini-cli": expired(GOOGLE_EXPIRES_CHANGED),
		} satisfies StatusMap);
		await runGatewayAuth(page);

		await expectExpiryModalFor(page, ["Google"]);
	});

	test("Go to Account Settings closes the modal and navigates to the Account tab", async ({ page }) => {
		await loadFixture(page, {
			anthropic: authenticated(),
			"openai-codex": { authenticated: false },
			"google-gemini-cli": expired(GOOGLE_EXPIRES),
		});
		await runGatewayAuth(page);
		await expectExpiryModalFor(page, ["Google"]);

		await modalPrimary(page).click();

		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/settings/system/account");
		await expect(modalPrimary(page)).toHaveCount(0);
	});
});
