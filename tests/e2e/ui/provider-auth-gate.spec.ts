import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";

type CloudProviderId = "anthropic" | "openai" | "google";
type CloudStatusMode = "direct-cloud" | "aigw";

const PROVIDERS: CloudProviderId[] = ["anthropic", "openai", "google"];
const LABELS: Record<CloudProviderId, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	google: "Google Gemini",
};

function providerStatus(
	id: CloudProviderId,
	overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
	return {
		id,
		label: LABELS[id],
		enabled: false,
		configured: false,
		authenticated: false,
		expired: false,
		needsReauth: false,
		status: "disabled",
		credentialTypes: [],
		oauthSupported: id !== "google",
		apiKeySupported: id !== "anthropic",
		...overrides,
	};
}

function cloudAuthStatus(mode: CloudStatusMode, authenticatedProviders: CloudProviderId[] = []): Record<string, unknown> {
	const authenticated = new Set(authenticatedProviders);
	if (mode === "aigw") {
		return {
			mode: "aigw",
			aigwConfigured: true,
			authGateRequired: false,
			providers: PROVIDERS.map((id) => providerStatus(id, {
				enabled: false,
				status: "aigw_bypass",
				message: "AI Gateway is handling model access.",
			})),
		};
	}
	return {
		mode: "direct-cloud",
		aigwConfigured: false,
		authGateRequired: authenticated.size === 0,
		providers: PROVIDERS.map((id) => {
			const isAuthenticated = authenticated.has(id);
			return providerStatus(id, isAuthenticated ? {
				enabled: true,
				configured: true,
				authenticated: true,
				status: "authenticated",
				credentialTypes: ["api_key"],
			} : {});
		}),
	};
}

async function stubPreferencesWithoutExplicitCloudBypass(page: Page): Promise<void> {
	await page.route(/\/api\/preferences(?:\?.*)?$/, async (route, request) => {
		if (request.method() === "GET") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({}),
			});
			return;
		}
		await route.fallback();
	});
}

async function stubCloudProviderStatus(
	page: Page,
	statusFactory: () => Record<string, unknown>,
): Promise<{ requests: () => number }> {
	let requestCount = 0;
	await page.route(/\/api\/cloud-providers\/status(?:\?.*)?$/, async (route) => {
		requestCount++;
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(statusFactory()),
		});
	});
	return { requests: () => requestCount };
}

async function stubSessionCreation(page: Page): Promise<{ posts: () => Array<Record<string, unknown>> }> {
	const postBodies: Array<Record<string, unknown>> = [];
	await page.route(/\/api\/sessions(?:\?.*)?$/, async (route, request) => {
		if (request.method() !== "POST") {
			await route.fallback();
			return;
		}
		const body = request.postDataJSON() as Record<string, unknown> | null;
		postBodies.push(body ?? {});
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ id: `stub-session-${postBodies.length}` }),
		});
	});
	return { posts: () => postBodies };
}

async function clickNewSession(page: Page): Promise<void> {
	await page.locator("button[title^='New session']").first().click();
}

test.describe("Direct-cloud auth gate", () => {
	test("opens before direct-cloud session start and cancel prevents session creation", async ({ page }) => {
		await stubPreferencesWithoutExplicitCloudBypass(page);
		await stubCloudProviderStatus(page, () => cloudAuthStatus("direct-cloud"));
		const sessions = await stubSessionCreation(page);

		await openApp(page);
		await clickNewSession(page);

		const gate = page.locator('[data-testid="cloud-auth-gate"]');
		await expect(gate).toBeVisible({ timeout: 10_000 });
		expect(sessions.posts()).toHaveLength(0);

		await page.locator('[data-testid="cloud-auth-gate-cancel"]').click();
		await expect(gate).toHaveCount(0, { timeout: 5_000 });
		await expect.poll(() => sessions.posts().length, { timeout: 1_000 }).toBe(0);
	});

	test("fails closed when cloud provider status cannot be loaded", async ({ page }) => {
		await stubPreferencesWithoutExplicitCloudBypass(page);
		let statusRequests = 0;
		await page.route(/\/api\/cloud-providers\/status(?:\?.*)?$/, async (route) => {
			statusRequests++;
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ error: "status unavailable" }),
			});
		});
		const sessions = await stubSessionCreation(page);

		await openApp(page);
		statusRequests = 0;
		await clickNewSession(page);

		await expect.poll(() => statusRequests, { timeout: 5_000 }).toBeGreaterThan(0);
		await expect(page.locator('[data-testid="cloud-auth-gate"]')).toHaveCount(0);
		await expect.poll(() => sessions.posts().length, { timeout: 1_000 }).toBe(0);
	});

	test("saves a Google API key, enables the provider, and resumes session creation", async ({ page }) => {
		let googleAuthenticated = false;
		const providerKeyPosts: Array<Record<string, unknown>> = [];
		await stubPreferencesWithoutExplicitCloudBypass(page);
		await stubCloudProviderStatus(page, () => cloudAuthStatus("direct-cloud", googleAuthenticated ? ["google"] : []));
		const sessions = await stubSessionCreation(page);
		await page.route(/\/api\/provider-keys\/google(?:\?.*)?$/, async (route, request) => {
			if (request.method() !== "POST") {
				await route.fallback();
				return;
			}
			providerKeyPosts.push(request.postDataJSON() as Record<string, unknown>);
			googleAuthenticated = true;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ ok: true, provider: "google", enabled: true }),
			});
		});

		await openApp(page);
		await clickNewSession(page);

		await expect(page.locator('[data-testid="cloud-auth-gate"]')).toBeVisible({ timeout: 10_000 });
		expect(sessions.posts()).toHaveLength(0);

		await page.locator('[data-testid="cloud-auth-gate-provider-google"]').click();
		await expect(page.getByRole("button", { name: "Connect selected" })).toBeEnabled();
		await page.getByRole("button", { name: "Connect selected" }).click();

		const keyInput = page.getByPlaceholder("Paste Gemini API key");
		await expect(keyInput).toBeVisible({ timeout: 5_000 });
		await keyInput.fill("test-gemini-key");
		const saveResponse = page.waitForResponse((response) =>
			response.url().includes("/api/provider-keys/google") && response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Save key" }).click();
		await saveResponse;

		await expect.poll(() => sessions.posts().length, { timeout: 10_000 }).toBe(1);
		await expect(page.locator('[data-testid="cloud-auth-gate"]')).toHaveCount(0, { timeout: 5_000 });
		expect(providerKeyPosts).toEqual([{ key: "test-gemini-key", enable: true }]);
	});

	test("manual OAuth code fallback completes a supported provider and resumes session creation", async ({ page }) => {
		await page.addInitScript(() => {
			window.open = () => null;
		});
		let anthropicAuthenticated = false;
		const oauthCompleteBodies: Array<Record<string, unknown>> = [];
		await stubPreferencesWithoutExplicitCloudBypass(page);
		await stubCloudProviderStatus(page, () => cloudAuthStatus("direct-cloud", anthropicAuthenticated ? ["anthropic"] : []));
		const sessions = await stubSessionCreation(page);
		await page.route(/\/api\/oauth\/start(?:\?.*)?$/, async (route, request) => {
			expect(request.postDataJSON()).toMatchObject({ provider: "anthropic" });
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					flowId: "flow-anthropic-manual",
					url: "https://auth.example/anthropic",
					provider: "anthropic",
					callbackServer: false,
					instructions: "Paste the manual code from the provider.",
				}),
			});
		});
		await page.route(/\/api\/oauth\/complete(?:\?.*)?$/, async (route, request) => {
			const body = request.postDataJSON() as Record<string, unknown>;
			oauthCompleteBodies.push(body);
			anthropicAuthenticated = true;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ success: true, provider: "anthropic" }),
			});
		});

		await openApp(page);
		await clickNewSession(page);

		await expect(page.locator('[data-testid="cloud-auth-gate"]')).toBeVisible({ timeout: 10_000 });
		await page.locator('[data-testid="cloud-auth-gate-provider-anthropic"]').click();
		await page.getByRole("button", { name: "Connect selected" }).click();
		await expect(page.getByText("A browser tab opened for Anthropic")).toBeVisible({ timeout: 5_000 });
		await page.getByPlaceholder("Paste redirect URL or code").fill("manual-auth-code");
		await page.getByRole("button", { name: "Submit code" }).click();

		await expect.poll(() => sessions.posts().length, { timeout: 10_000 }).toBe(1);
		await expect(page.locator('[data-testid="cloud-auth-gate"]')).toHaveCount(0, { timeout: 5_000 });
		expect(oauthCompleteBodies).toEqual([{ flowId: "flow-anthropic-manual", code: "manual-auth-code" }]);
	});

	test("OpenAI OAuth manual code fallback completes via openai-codex and resumes session creation", async ({ page }) => {
		await page.addInitScript(() => {
			window.open = () => null;
		});
		let openaiAuthenticated = false;
		const servedAuthenticatedStatuses: boolean[] = [];
		const oauthStartBodies: Array<Record<string, unknown>> = [];
		const oauthCompleteBodies: Array<Record<string, unknown>> = [];
		await stubPreferencesWithoutExplicitCloudBypass(page);
		await stubCloudProviderStatus(page, () => {
			servedAuthenticatedStatuses.push(openaiAuthenticated);
			return cloudAuthStatus("direct-cloud", openaiAuthenticated ? ["openai"] : []);
		});
		const sessions = await stubSessionCreation(page);
		await page.route(/\/api\/oauth\/start(?:\?.*)?$/, async (route, request) => {
			const body = request.postDataJSON() as Record<string, unknown>;
			oauthStartBodies.push(body);
			expect(body).toMatchObject({ provider: "openai-codex" });
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					flowId: "flow-openai-manual",
					url: "https://auth.example/openai",
					provider: "openai-codex",
					callbackServer: false,
					instructions: "Paste the manual OpenAI code from the provider.",
				}),
			});
		});
		await page.route(/\/api\/oauth\/complete(?:\?.*)?$/, async (route, request) => {
			const body = request.postDataJSON() as Record<string, unknown>;
			oauthCompleteBodies.push(body);
			openaiAuthenticated = true;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ success: true, provider: "openai-codex" }),
			});
		});

		await openApp(page);
		await clickNewSession(page);

		await expect(page.locator('[data-testid="cloud-auth-gate"]')).toBeVisible({ timeout: 10_000 });
		expect(sessions.posts()).toHaveLength(0);
		await page.locator('[data-testid="cloud-auth-gate-provider-openai"]').click();
		await expect(page.getByRole("button", { name: "Connect selected" })).toBeEnabled();
		await page.getByRole("button", { name: "Connect selected" }).click();
		await expect(page.getByText("A browser tab opened for OpenAI")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("Paste the manual OpenAI code from the provider.")).toBeVisible();
		await page.getByPlaceholder("Paste redirect URL or code").fill("manual-openai-code");
		const completeResponse = page.waitForResponse((response) =>
			response.url().includes("/api/oauth/complete") && response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Submit code" }).click();
		await completeResponse;

		await expect.poll(() => sessions.posts().length, { timeout: 10_000 }).toBe(1);
		await expect(page.locator('[data-testid="cloud-auth-gate"]')).toHaveCount(0, { timeout: 5_000 });
		expect(oauthStartBodies).toEqual([{ provider: "openai-codex" }]);
		expect(oauthCompleteBodies).toEqual([{ flowId: "flow-openai-manual", code: "manual-openai-code" }]);
		expect(servedAuthenticatedStatuses).toContain(true);
	});

	test("does not continue when status refresh fails after OAuth", async ({ page }) => {
		await page.addInitScript(() => {
			window.open = () => null;
		});
		let oauthCompleted = false;
		let refreshFailures = 0;
		await stubPreferencesWithoutExplicitCloudBypass(page);
		await page.route(/\/api\/cloud-providers\/status(?:\?.*)?$/, async (route) => {
			if (oauthCompleted) {
				refreshFailures++;
				await route.fulfill({
					status: 503,
					contentType: "application/json",
					body: JSON.stringify({ error: "status unavailable" }),
				});
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(cloudAuthStatus("direct-cloud")),
			});
		});
		const sessions = await stubSessionCreation(page);
		await page.route(/\/api\/oauth\/start(?:\?.*)?$/, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					flowId: "flow-anthropic-refresh-fails",
					url: "https://auth.example/anthropic",
					provider: "anthropic",
					callbackServer: false,
				}),
			});
		});
		await page.route(/\/api\/oauth\/complete(?:\?.*)?$/, async (route) => {
			oauthCompleted = true;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ success: true, provider: "anthropic" }),
			});
		});

		await openApp(page);
		await clickNewSession(page);

		await expect(page.locator('[data-testid="cloud-auth-gate"]')).toBeVisible({ timeout: 10_000 });
		await page.locator('[data-testid="cloud-auth-gate-provider-anthropic"]').click();
		await page.getByRole("button", { name: "Connect selected" }).click();
		await page.getByPlaceholder("Paste redirect URL or code").fill("manual-auth-code");
		await page.getByRole("button", { name: "Submit code" }).click();

		await expect(page.locator('[data-testid="cloud-auth-gate-provider-anthropic"]')).toContainText("could not verify provider status", { timeout: 10_000 });
		await expect(page.locator('[data-testid="cloud-auth-gate"]')).toBeVisible();
		await expect.poll(() => refreshFailures, { timeout: 1_000 }).toBeGreaterThan(0);
		await expect.poll(() => sessions.posts().length, { timeout: 1_000 }).toBe(0);
	});

	test("AI Gateway cloud status bypasses the auth gate", async ({ page }) => {
		await stubPreferencesWithoutExplicitCloudBypass(page);
		const status = await stubCloudProviderStatus(page, () => cloudAuthStatus("aigw"));
		const sessions = await stubSessionCreation(page);

		await openApp(page);
		await clickNewSession(page);

		await expect.poll(() => sessions.posts().length, { timeout: 10_000 }).toBe(1);
		await expect(page.locator('[data-testid="cloud-auth-gate"]')).toHaveCount(0);
		expect(status.requests()).toBeGreaterThan(0);
	});
});
