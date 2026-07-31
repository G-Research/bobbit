import type { Page } from "@playwright/test";
import { test, expect, openApp, navigateToHash } from "../_helpers/journey-fixture.js";

type AccountProvider = "anthropic" | "openai-codex" | "google-gemini-cli";

const ACCOUNT_ROUTE = "#/settings/system/account";
const AUTHORIZATION_URL = "https://claude.ai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback&scope=org%3Acreate_api_key%20user%3Aprofile%20user%3Ainference%20user%3Asessions%3Aclaude_code%20user%3Amcp_servers%20user%3Afile_upload";

interface MockOAuthService {
	status: Record<AccountProvider, boolean>;
	starts: number;
	completions: number;
	logouts: AccountProvider[];
}

async function mockOAuthService(page: Page): Promise<MockOAuthService> {
	const service: MockOAuthService = {
		status: {
			anthropic: false,
			"openai-codex": true,
			"google-gemini-cli": false,
		},
		starts: 0,
		completions: 0,
		logouts: [],
	};

	await page.route("**/api/oauth/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const provider = url.searchParams.get("provider") as AccountProvider | null;

		if (request.method() === "GET" && url.pathname === "/api/oauth/status" && provider) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ authenticated: service.status[provider] === true }),
			});
			return;
		}

		if (request.method() === "POST" && url.pathname === "/api/oauth/start") {
			const body = request.postDataJSON() as { provider?: string };
			expect(body).toEqual({ provider: "anthropic" });
			service.starts++;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					flowId: "browser-ui-flow",
					provider: "anthropic",
					url: AUTHORIZATION_URL,
					callbackServer: false,
					instructions: "Complete sign-in in the opened browser, then paste its redirect URL.",
				}),
			});
			return;
		}

		if (request.method() === "POST" && url.pathname === "/api/oauth/complete") {
			const body = request.postDataJSON() as { flowId?: unknown; code?: unknown };
			expect(body.flowId).toBe("browser-ui-flow");
			expect(typeof body.code).toBe("string");
			expect((body.code as string).length).toBeGreaterThan(0);
			service.completions++;
			service.status.anthropic = true;
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
			return;
		}

		if (request.method() === "POST" && url.pathname === "/api/oauth/logout") {
			const body = request.postDataJSON() as { provider?: AccountProvider };
			expect(body.provider).toBe("anthropic");
			service.logouts.push(body.provider!);
			service.status.anthropic = false;
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
			return;
		}

		await route.fallback();
	});

	return service;
}

async function openAccountSettings(page: Page): Promise<void> {
	await navigateToHash(page, ACCOUNT_ROUTE);
	await expect(page.getByTestId("account-tab")).toBeVisible({ timeout: 20_000 });
}

test.describe("Journey: Anthropic OAuth", () => {
	test("completes a pasted callback, survives reload, and logs out only Anthropic", async ({ page }) => {
		test.setTimeout(90_000);
		const oauth = await mockOAuthService(page);
		let popup: Page | undefined;

		try {
			await openApp(page);
			await openAccountSettings(page);

			const anthropicRow = page.getByTestId("account-row-anthropic");
			const openAiRow = page.getByTestId("account-row-openai-codex");
			await expect(anthropicRow.getByTestId("account-status-anthropic")).toHaveText("Not authenticated");
			await expect(openAiRow.getByTestId("account-status-openai-codex")).toHaveText("Authenticated");

			const popupPromise = page.waitForEvent("popup");
			await anthropicRow.getByTestId("account-auth-btn-anthropic").getByRole("button").click();
			popup = await popupPromise;
			await expect(popup).toHaveURL(AUTHORIZATION_URL);
			await popup.close();
			popup = undefined;

			const loginHeading = page.getByRole("heading", { name: "Anthropic Login", exact: true });
			await expect(loginHeading).toBeVisible({ timeout: 15_000 });
			await expect(page.getByRole("link", { name: "Click here" })).toHaveAttribute("href", AUTHORIZATION_URL);
			const pastedRedirect = new URL("http://localhost:53692/callback");
			// The disposable value is never captured, asserted, logged, or retained by
			// the mock; the journey verifies only the browser's paste handoff.
			pastedRedirect.searchParams.set("code", crypto.randomUUID());
			await page.getByPlaceholder("Paste code here (format: code#state)").fill(pastedRedirect.toString());
			await page.getByRole("button", { name: "Submit", exact: true }).click();
			await expect(page.getByText("Authenticated successfully.", { exact: true })).toBeVisible();
			await expect(loginHeading).toHaveCount(0, { timeout: 5_000 });
			expect(oauth.starts).toBe(1);
			expect(oauth.completions).toBe(1);

			await expect(anthropicRow.getByTestId("account-status-anthropic")).toHaveText("Authenticated", { timeout: 15_000 });
			await expect(anthropicRow.getByTestId("account-logout-btn-anthropic")).toBeVisible();

			await page.reload({ waitUntil: "domcontentloaded" });
			await openAccountSettings(page);
			await expect(page.getByTestId("account-status-anthropic")).toHaveText("Authenticated", { timeout: 15_000 });
			await expect(page.getByTestId("account-status-openai-codex")).toHaveText("Authenticated");

			await page.getByTestId("account-logout-btn-anthropic").getByRole("button").click();
			await expect(page.getByRole("heading", { name: "Log out of Anthropic?", exact: true })).toBeVisible();
			await page.getByRole("button", { name: "Log out", exact: true }).last().click();

			await expect(page.getByTestId("account-status-anthropic")).toHaveText("Not authenticated", { timeout: 15_000 });
			await expect(page.getByTestId("account-logout-btn-anthropic")).toHaveCount(0);
			await expect(page.getByTestId("account-status-openai-codex")).toHaveText("Authenticated");
			expect(oauth.logouts).toEqual(["anthropic"]);
			// The mocked protocol never supplies token material to the UI; completion
			// only changes authenticated status and logout removes that status.
			await expect(page.locator("input[placeholder*='Paste code']")).toHaveCount(0);
		} finally {
			if (popup && !popup.isClosed()) await popup.close();
		}
	});
});
