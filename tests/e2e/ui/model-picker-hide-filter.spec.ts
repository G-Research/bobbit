/**
 * Browser E2E for the §9 "Has key" model-picker filter (Slice E).
 *
 * The model picker gains a persisted, default-OFF, DISPLAY-ONLY toggle that
 * hides built-in models with no API key (`authenticated === false`). This test
 * exercises the real `<agent-model-selector>` dialog end-to-end:
 *   - default OFF shows everything;
 *   - toggling ON hides unauthenticated built-ins while keeping authenticated
 *     built-ins, gateway/custom models (always `authenticated:true`), and the
 *     currently-selected model (even when it is itself unauthenticated);
 *   - toggling OFF restores the hidden rows;
 *   - the choice persists across a full page reload (localStorage);
 *   - the toggle has NO server impact — every `/api/models` request is byte-for
 *     -byte identical regardless of toggle state (no query/body carries it), so
 *     the server response is necessarily identical with the toggle ON vs OFF.
 *
 * `/api/models` is stubbed with Playwright's `page.route()` so the model set is
 * deterministic (the live discovery in the harness is disabled and would be
 * env-dependent). The picker is driven through its real lazy-loaded component:
 * the footer model button registers the custom element, then we open it with a
 * controlled `currentModel` so the "never hide the current model" branch is
 * covered with an unauthenticated current model.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp } from "./ui-helpers.js";
import { createSession, deleteSession } from "../e2e-setup.js";

// Deterministic model set: two authenticated entries (an authed built-in + a
// gateway model that the server always emits `authenticated:true`), two
// unauthenticated built-ins (the ones that must vanish when the filter is ON),
// and one unauthenticated built-in that is also the *current* model (must stay
// visible regardless of the filter).
const FIXTURE = [
	{ provider: "anthropic", id: "claude-authed-builtin", name: "Claude (authed)", api: "anthropic-messages", contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, authenticated: true },
	{ provider: "llama-swap", id: "qwen-coder-gateway", name: "Qwen Coder (gateway)", api: "openai-completions", baseUrl: "http://stub.local/v1", contextWindow: 32000, maxTokens: 8000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, authenticated: true },
	{ provider: "openai", id: "gpt-unauthed-builtin", name: "GPT (unauthed)", api: "openai-completions", contextWindow: 128000, maxTokens: 16000, reasoning: false, input: ["text"], cost: { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 }, authenticated: false },
	{ provider: "google", id: "gemini-unauthed-builtin", name: "Gemini (unauthed)", api: "openai-completions", contextWindow: 1000000, maxTokens: 8000, reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, authenticated: false },
	{ provider: "xai", id: "grok-current-unauthed", name: "Grok (current, unauthed)", api: "openai-completions", contextWindow: 128000, maxTokens: 8000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, authenticated: false },
];

// The current model is an UNAUTHENTICATED built-in: it must never be hidden.
const CURRENT_MODEL = { id: "grok-current-unauthed", provider: "xai" };

const HIDE_KEY = "bobbit.modelPicker.hideUnauthed";
const item = (id: string) => `[data-model-item][data-model-id="${id}"]`;
const FILTER_BTN = "[data-testid='model-filter-haskey']";

test.describe("model picker — hide-unconfigured filter (§9)", () => {
	test("Has key toggle hides unauthenticated built-ins, persists, and never hits the server", async ({ page }) => {
		// Cold-start budget: app load + session create + lazy dialog import.
		test.setTimeout(120_000);

		// Record every /api/models request (regex matches with or without a
		// query string, but NOT sub-paths like /api/models/test). The handler
		// always returns the same FIXTURE — so the response is identical by
		// construction and the only thing that could vary is the *request*.
		const modelsRequests: Array<{ method: string; url: string; postData: string | null }> = [];
		await page.route(/\/api\/models(\?.*)?$/, async (route) => {
			const req = route.request();
			modelsRequests.push({ method: req.method(), url: req.url(), postData: req.postData() });
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(FIXTURE),
			});
		});

		const sessionId = await createSession();
		try {
			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

			// Register the lazy-loaded <agent-model-selector> by opening the real
			// picker from the footer model button (its production entry point).
			const footerModel = page.locator("[data-testid='footer-model-id']").first();
			await expect(footerModel).toBeVisible({ timeout: 20_000 });
			await footerModel.click();
			await page.waitForFunction(() => !!customElements.get("agent-model-selector"), null, { timeout: 20_000 });

			// Drive the picker with a controlled currentModel. Closes any open
			// instance first so re-opens don't stack dialogs.
			const openPicker = async (current: { id: string; provider: string }) => {
				await page.evaluate((cur) => {
					document.querySelectorAll("agent-model-selector").forEach((el) => {
						const close = (el as unknown as { close?: () => void }).close;
						if (typeof close === "function") close.call(el); else el.remove();
					});
					const Cls = customElements.get("agent-model-selector") as
						| { open: (m: unknown, cb: () => void) => void }
						| undefined;
					Cls?.open(cur, () => { /* selection no-op */ });
				}, current);
				// Current model is never filtered out — wait for it to confirm the list rendered.
				await expect(page.locator(item(current.id))).toBeVisible({ timeout: 10_000 });
			};

			// ── Default OFF: nothing persisted yet, all five models present ──
			expect(await page.evaluate((k) => localStorage.getItem(k), HIDE_KEY)).toBeNull();
			await openPicker(CURRENT_MODEL);
			for (const m of FIXTURE) {
				await expect(page.locator(item(m.id))).toBeVisible();
			}
			const requestsAfterDefaultOpen = modelsRequests.length;

			// ── Toggle ON: unauthenticated built-ins (non-current) vanish ──
			await page.locator(FILTER_BTN).click();
			await expect(page.locator(item("gpt-unauthed-builtin"))).toHaveCount(0);
			await expect(page.locator(item("gemini-unauthed-builtin"))).toHaveCount(0);
			// Authenticated built-in + gateway model + current (unauthed) remain.
			await expect(page.locator(item("claude-authed-builtin"))).toBeVisible();
			await expect(page.locator(item("qwen-coder-gateway"))).toBeVisible();
			await expect(page.locator(item("grok-current-unauthed"))).toBeVisible();
			// Persisted to localStorage as "1".
			expect(await page.evaluate((k) => localStorage.getItem(k), HIDE_KEY)).toBe("1");
			// Display-only: toggling did NOT trigger another /api/models fetch.
			expect(modelsRequests.length).toBe(requestsAfterDefaultOpen);

			// ── Toggle OFF: hidden rows reappear, persisted as "0" ──
			await page.locator(FILTER_BTN).click();
			await expect(page.locator(item("gpt-unauthed-builtin"))).toBeVisible();
			await expect(page.locator(item("gemini-unauthed-builtin"))).toBeVisible();
			expect(await page.evaluate((k) => localStorage.getItem(k), HIDE_KEY)).toBe("0");

			// Leave the filter ON to verify persistence across reload.
			await page.locator(FILTER_BTN).click();
			expect(await page.evaluate((k) => localStorage.getItem(k), HIDE_KEY)).toBe("1");

			// ── Persistence across a full reload ──
			await page.reload();
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
			// localStorage survived the reload.
			expect(await page.evaluate((k) => localStorage.getItem(k), HIDE_KEY)).toBe("1");
			// Re-register the lazy component (fresh JS context after reload).
			const footerModel2 = page.locator("[data-testid='footer-model-id']").first();
			await expect(footerModel2).toBeVisible({ timeout: 20_000 });
			await footerModel2.click();
			await page.waitForFunction(() => !!customElements.get("agent-model-selector"), null, { timeout: 20_000 });

			await openPicker(CURRENT_MODEL);
			// Filter is restored ON: unauthenticated built-ins are hidden again.
			await expect(page.locator(item("gpt-unauthed-builtin"))).toHaveCount(0);
			await expect(page.locator(item("gemini-unauthed-builtin"))).toHaveCount(0);
			await expect(page.locator(item("claude-authed-builtin"))).toBeVisible();
			await expect(page.locator(item("grok-current-unauthed"))).toBeVisible();

			// ── No server impact: every /api/models request is identical ──
			// The toggle value never appears in any request (no query, no body)
			// and the method/path are constant — so the server returns the same
			// payload whether the toggle is ON or OFF (it is a pure display filter).
			expect(modelsRequests.length).toBeGreaterThanOrEqual(2);
			for (const r of modelsRequests) {
				const u = new URL(r.url);
				expect(r.method).toBe("GET");
				expect(u.pathname).toBe("/api/models");
				expect(u.search).toBe("");
				expect(r.postData ?? "").toBe("");
				expect(r.url.toLowerCase()).not.toContain("hideunauthed");
				expect(r.url.toLowerCase()).not.toContain("authenticated");
			}
		} finally {
			await deleteSession(sessionId);
		}
	});
});
