/**
 * Shared helpers for fullstack E2E tests.
 *
 * These tests run against the real gateway + real UI in a Playwright browser.
 * The server uses a mock agent and an isolated BOBBIT_DIR.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect } from "@playwright/test";

/** Port the fullstack E2E gateway is listening on (set by config via env). */
export const PORT = process.env.E2E_PORT || "4100";

/** HTTP base URL. */
export const BASE = `http://127.0.0.1:${PORT}`;

/** The isolated .bobbit directory used by the test server. */
export const BOBBIT_DIR =
	process.env.BOBBIT_DIR || join(import.meta.dirname, "..", "..", ".e2e-fullstack");

/** Read the auth token that the test server auto-created on startup. */
export function readToken(): string {
	return readFileSync(join(BOBBIT_DIR, "state", "token"), "utf-8").trim();
}

/** Authenticated REST fetch against the test gateway. */
export function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${readToken()}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

/**
 * Open the app in the browser, authenticated via token query param.
 * Waits for the authenticated UI to be ready.
 */
export async function openApp(page: Page): Promise<void> {
	const token = readToken();
	await page.goto(`/?token=${encodeURIComponent(token)}`);
	// The app stores the token in localStorage and redirects.
	// Wait for the sidebar to appear — it's the signal that auth succeeded
	// and sessions have loaded.
	await expect(
		page.locator("button[title='New session']").first(),
	).toBeVisible({ timeout: 15_000 });
}

/**
 * Poll a condition on the page until it's true, with short sleeps.
 * Avoids fixed-duration sleeps that cause flakiness.
 */
export async function pollUntil(
	page: Page,
	fn: () => Promise<boolean>,
	{ timeout = 15_000, interval = 100 } = {},
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (await fn()) return;
		await page.waitForTimeout(interval);
	}
	throw new Error(`pollUntil timed out after ${timeout}ms`);
}
