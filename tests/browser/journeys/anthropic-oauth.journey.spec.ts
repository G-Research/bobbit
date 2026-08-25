import type { Page } from "@playwright/test";
import { test, expect, openApp, navigateToHash } from "../../../tests2/browser/_helpers/journey-fixture.js";

const ACCOUNT_ROUTE = "#/settings/system/account";
const OAUTH_ROUTE = "**/api/oauth/**";

type OAuthCall = {
	method: string;
	path: string;
	search?: string;
	body?: Record<string, unknown>;
};

type MockOAuthRoutes = {
	calls: OAuthCall[];
	cleanup(): Promise<void>;
};

type MockOAuthOptions = {
	failFirstCancellation?: boolean;
	beforeStartResponse?: () => Promise<void>;
	onStartReceived?: () => void;
};

/**
 * The browser journey owns UI request/response, popup, cancellation, retry,
 * reload, logout, provider-isolation, and no-secret rendering coverage. The
 * integration lifecycle suite owns the real gateway/Pi callback lease, token
 * exchange, credential persistence, and cancellation behavior. Keeping this
 * seam mocked prevents concurrent browser coordinators from contending for
 * Pi's provider-fixed Anthropic loopback port.
 */
async function installMockOAuthRoutes(page: Page, options: MockOAuthOptions = {}): Promise<MockOAuthRoutes> {
	let nextFlow = 0;
	let cancellationAttempts = 0;
	const calls: OAuthCall[] = [];
	const flows = new Map<string, { complete: boolean }>();
	const authenticated = new Map<string, boolean>([
		["anthropic", false],
		["openai-codex", true],
	]);

	await page.context().route("https://oauth.example/**", (route) => route.fulfill({
		contentType: "text/html",
		body: "<!doctype html><title>Mock OAuth provider</title>",
	}));
	await page.route(OAUTH_ROUTE, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const body = request.method() === "POST"
			? request.postDataJSON() as Record<string, unknown>
			: undefined;
		calls.push({ method: request.method(), path: url.pathname, ...(url.search ? { search: url.search } : {}), ...(body ? { body } : {}) });
		const json = (value: unknown, status = 200) => route.fulfill({
			status,
			contentType: "application/json",
			body: JSON.stringify(value),
		});

		if (url.pathname === "/api/oauth/status" && request.method() === "GET") {
			const provider = url.searchParams.get("provider") ?? "anthropic";
			return json({
				authenticated: authenticated.get(provider) === true,
				provider,
				...(authenticated.get(provider) === true ? { expires: Date.now() + 86_400_000 } : {}),
			});
		}
		if (url.pathname === "/api/oauth/start" && request.method() === "POST") {
			if (body?.provider !== "anthropic") return json({ error: "Unexpected provider" }, 400);
			const flowId = `anthropic-flow-${++nextFlow}`;
			flows.set(flowId, { complete: false });
			options.onStartReceived?.();
			await options.beforeStartResponse?.();
			return json({
				flowId,
				provider: "anthropic",
				url: `https://oauth.example/authorize?flow=${encodeURIComponent(flowId)}`,
				callbackServer: true,
			});
		}
		if (url.pathname === "/api/oauth/flow-status" && request.method() === "GET") {
			const flowId = url.searchParams.get("flowId") ?? "";
			const flow = flows.get(flowId);
			if (url.searchParams.get("provider") !== "anthropic" || !flow) return json({ error: "flow not found" }, 404);
			return json({ flowId, provider: "anthropic", ...flow });
		}
		if (url.pathname === "/api/oauth/cancel" && request.method() === "POST") {
			cancellationAttempts += 1;
			const flowId = typeof body?.flowId === "string" ? body.flowId : "";
			if (options.failFirstCancellation && cancellationAttempts === 1) {
				return json({
					error: "OAuth cancellation did not complete. Retry cancellation before starting another sign-in.",
					code: "OAUTH_CANCEL_RETRY_REQUIRED",
					retryable: true,
					flowId,
				}, 503);
			}
			flows.delete(flowId);
			return json({ success: true });
		}
		if (url.pathname === "/api/oauth/complete" && request.method() === "POST") {
			const flowId = typeof body?.flowId === "string" ? body.flowId : "";
			const flow = flows.get(flowId);
			if (!flow || body?.provider !== "anthropic" || typeof body.code !== "string" || !body.code) {
				return json({ success: false, error: "Unknown flow" }, 404);
			}
			flow.complete = true;
			authenticated.set("anthropic", true);
			return json({ success: true });
		}
		if (url.pathname === "/api/oauth/finalize" && request.method() === "POST") {
			if (typeof body?.flowId === "string") flows.delete(body.flowId);
			return json({ success: true });
		}
		if (url.pathname === "/api/oauth/logout" && request.method() === "POST") {
			if (body?.provider !== "anthropic") return json({ error: "Unexpected provider" }, 400);
			authenticated.set("anthropic", false);
			return json({ success: true, provider: "anthropic" });
		}
		return json({ error: `Unexpected OAuth request: ${request.method()} ${url.pathname}` }, 404);
	});

	return {
		calls,
		cleanup: async () => {
			await page.unroute(OAUTH_ROUTE);
			await page.context().unroute("https://oauth.example/**");
		},
	};
}

function callsFor(routes: MockOAuthRoutes, path: string): OAuthCall[] {
	return routes.calls.filter((call) => call.path === path);
}

async function openAccountSettings(page: Page): Promise<void> {
	await navigateToHash(page, ACCOUNT_ROUTE);
	await expect(page.getByTestId("account-tab")).toBeVisible();
}

test.describe("Journey: Anthropic OAuth", () => {
	test("uses deterministic OAuth route responses for the UI cancel, retry, complete, reload, and logout journey", async ({ page }) => {
		const oauth = await installMockOAuthRoutes(page);
		let popup: Page | undefined;
		try {
			await openApp(page);
			await openAccountSettings(page);

			const anthropicRow = page.getByTestId("account-row-anthropic");
			const openAiRow = page.getByTestId("account-row-openai-codex");
			await expect(anthropicRow.getByTestId("account-status-anthropic")).toHaveText("Not authenticated");
			await expect(openAiRow.getByTestId("account-status-openai-codex")).toHaveText("Authenticated");

			const firstPopup = page.waitForEvent("popup");
			const firstFlowStatus = page.waitForRequest((request) =>
				request.url().includes("/api/oauth/flow-status?flowId=anthropic-flow-1&provider=anthropic"),
			);
			await anthropicRow.getByTestId("account-auth-btn-anthropic").getByRole("button").click();
			popup = await firstPopup;
			await expect(popup).toHaveURL(/https:\/\/oauth\.example\/authorize\?flow=anthropic-flow-1/);
			await popup.close();
			popup = undefined;
			await firstFlowStatus;
			await expect(page.getByRole("heading", { name: "Anthropic Login", exact: true })).toBeVisible();
			expect(callsFor(oauth, "/api/oauth/start")).toEqual([{
				method: "POST",
				path: "/api/oauth/start",
				body: { provider: "anthropic" },
			}]);
			expect(callsFor(oauth, "/api/oauth/flow-status")).toContainEqual({
				method: "GET",
				path: "/api/oauth/flow-status",
				search: "?flowId=anthropic-flow-1&provider=anthropic",
			});

			await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
			await expect(page.getByRole("heading", { name: "Anthropic Login", exact: true })).toHaveCount(0);
			expect(callsFor(oauth, "/api/oauth/cancel")).toEqual([{
				method: "POST",
				path: "/api/oauth/cancel",
				body: { flowId: "anthropic-flow-1", provider: "anthropic" },
			}]);

			const retryPopup = page.waitForEvent("popup");
			const retryFlowStatus = page.waitForRequest((request) =>
				request.url().includes("/api/oauth/flow-status?flowId=anthropic-flow-2&provider=anthropic"),
			);
			await anthropicRow.getByTestId("account-auth-btn-anthropic").getByRole("button").click();
			popup = await retryPopup;
			await expect(popup).toHaveURL(/https:\/\/oauth\.example\/authorize\?flow=anthropic-flow-2/);
			await popup.close();
			popup = undefined;
			await retryFlowStatus;
			await expect(page.getByRole("heading", { name: "Anthropic Login", exact: true })).toBeVisible();
			expect(callsFor(oauth, "/api/oauth/flow-status")).toContainEqual({
				method: "GET",
				path: "/api/oauth/flow-status",
				search: "?flowId=anthropic-flow-2&provider=anthropic",
			});
			const manualRedirect = "https://oauth.example/callback?code=mock-code&state=mock-state";
			await page.getByPlaceholder("Paste redirect URL or code").fill(manualRedirect);
			await page.getByRole("button", { name: "Submit", exact: true }).click();
			await expect(page.getByText("Authenticated successfully.", { exact: true })).toBeVisible();
			await expect(anthropicRow.getByTestId("account-status-anthropic")).toHaveText("Authenticated");
			expect(callsFor(oauth, "/api/oauth/complete")).toEqual([{
				method: "POST",
				path: "/api/oauth/complete",
				body: { flowId: "anthropic-flow-2", code: manualRedirect, provider: "anthropic" },
			}]);

			await page.reload({ waitUntil: "domcontentloaded" });
			await openAccountSettings(page);
			await expect(page.getByTestId("account-status-anthropic")).toHaveText("Authenticated");
			await expect(page.getByTestId("account-status-openai-codex")).toHaveText("Authenticated");
			await expect(page.locator("body")).not.toContainText(/access_token|refresh_token/i);
			expect(JSON.stringify(oauth.calls)).not.toMatch(/access_token|refresh_token/i);

			await page.getByTestId("account-logout-btn-anthropic").getByRole("button").click();
			await expect(page.getByRole("heading", { name: "Log out of Anthropic?", exact: true })).toBeVisible();
			await page.getByRole("button", { name: "Log out", exact: true }).last().click();
			await expect(page.getByTestId("account-status-anthropic")).toHaveText("Not authenticated");
			await expect(page.getByTestId("account-status-openai-codex")).toHaveText("Authenticated");
			expect(callsFor(oauth, "/api/oauth/logout")).toEqual([{
				method: "POST",
				path: "/api/oauth/logout",
				body: { provider: "anthropic" },
			}]);
		} finally {
			if (popup && !popup.isClosed()) await popup.close();
			await oauth.cleanup();
		}
	});

	test("keeps the dialog on a retryable cancellation failure and retries the same flow before another start", async ({ page }) => {
		const oauth = await installMockOAuthRoutes(page, { failFirstCancellation: true });
		try {
			await openApp(page);
			await openAccountSettings(page);
			const anthropicRow = page.getByTestId("account-row-anthropic");

			const firstPopup = page.waitForEvent("popup");
			await anthropicRow.getByTestId("account-auth-btn-anthropic").getByRole("button").click();
			const popup = await firstPopup;
			await popup.close();
			await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
			await expect(page.getByText("OAuth cancellation did not complete. Retry cancellation before starting another sign-in.", { exact: true })).toBeVisible();
			await expect(page.getByRole("button", { name: "Retry cancellation", exact: true })).toBeVisible();
			expect(callsFor(oauth, "/api/oauth/start")).toHaveLength(1);
			await expect(anthropicRow.getByTestId("account-auth-btn-anthropic").getByRole("button")).toBeDisabled();

			await page.getByRole("button", { name: "Retry cancellation", exact: true }).click();
			await expect(page.getByText("OAuth cancellation completed. You can start a new sign-in.", { exact: true })).toBeVisible();
			expect(callsFor(oauth, "/api/oauth/cancel")).toHaveLength(2);
			expect(callsFor(oauth, "/api/oauth/start")).toHaveLength(1);

			const retryPopup = page.waitForEvent("popup");
			await page.getByRole("button", { name: "Try again", exact: true }).click();
			const replacementPopup = await retryPopup;
			await replacementPopup.close();
			expect(callsFor(oauth, "/api/oauth/start")).toHaveLength(2);
			await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
			await expect(page.getByRole("heading", { name: "Anthropic Login", exact: true })).toHaveCount(0);
		} finally {
			await oauth.cleanup();
		}
	});

	test("cancels a flow returned after its loading dialog closes before opening a popup or polling", async ({ page }) => {
		let releaseStartResponse!: () => void;
		const startResponseHeld = new Promise<void>((resolve) => { releaseStartResponse = resolve; });
		let markStartReceived!: () => void;
		const startReceived = new Promise<void>((resolve) => { markStartReceived = resolve; });
		const oauth = await installMockOAuthRoutes(page, {
			beforeStartResponse: () => startResponseHeld,
			onStartReceived: markStartReceived,
		});
		try {
			await openApp(page);
			await openAccountSettings(page);
			const anthropicRow = page.getByTestId("account-row-anthropic");
			await anthropicRow.getByTestId("account-auth-btn-anthropic").getByRole("button").click();
			await startReceived;
			await page.keyboard.press("Escape");
			await expect(page.getByRole("heading", { name: "Anthropic Login", exact: true })).toHaveCount(0);

			const lateCancel = page.waitForRequest((request) =>
				request.url().includes("/api/oauth/cancel") && request.method() === "POST",
			);
			releaseStartResponse();
			await lateCancel;
			await expect(page.getByRole("heading", { name: "Anthropic Login", exact: true })).toHaveCount(0);
			expect(callsFor(oauth, "/api/oauth/cancel")).toEqual([{
				method: "POST",
				path: "/api/oauth/cancel",
				body: { flowId: "anthropic-flow-1", provider: "anthropic" },
			}]);
			expect(callsFor(oauth, "/api/oauth/flow-status")).toEqual([]);

			const retryPopup = page.waitForEvent("popup");
			await anthropicRow.getByTestId("account-auth-btn-anthropic").getByRole("button").click();
			const popup = await retryPopup;
			await expect(popup).toHaveURL(/https:\/\/oauth\.example\/authorize\?flow=anthropic-flow-2/);
			await popup.close();
			await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
		} finally {
			await oauth.cleanup();
		}
	});
});
