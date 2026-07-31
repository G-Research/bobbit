import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, openApp, navigateToHash } from "../_helpers/journey-fixture.js";

const ACCOUNT_ROUTE = "#/settings/system/account";
const TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";

function seedAccountFixture(agentDir: string): void {
	// Deliberately credential-free: the other account slot establishes that
	// Anthropic cancellation and logout remain provider-scoped.
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
		"openai-codex": { type: "oauth", expires: Date.now() + 60_000 },
	}), "utf8");
}

function installMockAnthropicProvider(): () => void {
	const originalFetch = globalThis.fetch;
	// Generated only at runtime, never captured or asserted. The mock models the
	// provider token exchange while the browser uses the real gateway routes.
	const access = randomUUID();
	const refresh = randomUUID();
	globalThis.fetch = (async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url === TOKEN_ENDPOINT) {
			return new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return originalFetch(input, init);
	}) as typeof fetch;
	return () => { globalThis.fetch = originalFetch; };
}

function pastedCallback(authorizeUrl: string): string {
	const state = new URL(authorizeUrl).searchParams.get("state");
	if (!state) throw new Error("mock provider start omitted OAuth state");
	return `http://localhost:53692/callback?code=${encodeURIComponent(randomUUID())}&state=${encodeURIComponent(state)}`;
}

async function openAccountSettings(page: Page): Promise<void> {
	await navigateToHash(page, ACCOUNT_ROUTE);
	await expect(page.getByTestId("account-tab")).toBeVisible({ timeout: 20_000 });
}

test.describe("Journey: Anthropic OAuth", () => {
	test("cancels and immediately retries the real Pi-backed gateway flow without exposing credentials", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		const restoreProvider = installMockAnthropicProvider();
		let popup: Page | undefined;
		try {
			seedAccountFixture(join(gateway.bobbitDir, "agent"));
			await openApp(page);
			await openAccountSettings(page);

			const anthropicRow = page.getByTestId("account-row-anthropic");
			const openAiRow = page.getByTestId("account-row-openai-codex");
			await expect(anthropicRow.getByTestId("account-status-anthropic")).toHaveText("Not authenticated");
			await expect(openAiRow.getByTestId("account-status-openai-codex")).toHaveText("Authenticated");

			const firstPopup = page.waitForEvent("popup");
			await anthropicRow.getByTestId("account-auth-btn-anthropic").getByRole("button").click();
			popup = await firstPopup;
			await expect(popup).toHaveURL(/https:\/\/claude\.ai\/oauth\/authorize/);
			await popup.close();
			popup = undefined;
			await expect(page.getByRole("heading", { name: "Anthropic Login", exact: true })).toBeVisible();

			const cancelled = page.waitForResponse((response) =>
				response.url().endsWith("/api/oauth/cancel") && response.request().method() === "POST",
			);
			await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
			expect((await cancelled).status()).toBe(200);
			await expect(page.getByRole("heading", { name: "Anthropic Login", exact: true })).toHaveCount(0);

			// Retry directly after the cancel response: the dialog waits for the
			// provider-scoped cancellation before starting the next Pi flow.
			const retryPopup = page.waitForEvent("popup");
			await anthropicRow.getByTestId("account-auth-btn-anthropic").getByRole("button").click();
			popup = await retryPopup;
			const authorizeUrl = popup.url();
			await popup.close();
			popup = undefined;
			await expect(page.getByRole("heading", { name: "Anthropic Login", exact: true })).toBeVisible();
			await page.getByPlaceholder("Paste redirect URL or code").fill(pastedCallback(authorizeUrl));
			await page.getByRole("button", { name: "Submit", exact: true }).click();
			await expect(page.getByText("Authenticated successfully.", { exact: true })).toBeVisible();
			await expect(anthropicRow.getByTestId("account-status-anthropic")).toHaveText("Authenticated", { timeout: 15_000 });

			await page.reload({ waitUntil: "domcontentloaded" });
			await openAccountSettings(page);
			await expect(page.getByTestId("account-status-anthropic")).toHaveText("Authenticated", { timeout: 15_000 });
			await expect(page.getByTestId("account-status-openai-codex")).toHaveText("Authenticated");
			await expect(page.locator("body")).not.toContainText(/access_token|refresh_token/i);

			await page.getByTestId("account-logout-btn-anthropic").getByRole("button").click();
			await expect(page.getByRole("heading", { name: "Log out of Anthropic?", exact: true })).toBeVisible();
			await page.getByRole("button", { name: "Log out", exact: true }).last().click();
			await expect(page.getByTestId("account-status-anthropic")).toHaveText("Not authenticated", { timeout: 15_000 });
			await expect(page.getByTestId("account-status-openai-codex")).toHaveText("Authenticated");
		} finally {
			if (popup && !popup.isClosed()) await popup.close();
			restoreProvider();
			seedAccountFixture(join(gateway.bobbitDir, "agent"));
		}
	});
});
