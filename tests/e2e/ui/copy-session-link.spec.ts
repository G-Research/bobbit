/**
 * E2E — "Copy session link" header button.
 *
 * Covers the project's hard E2E rule (AGENTS.md):
 *   1. Navigation — open the app, create a session, button visible.
 *   2. Happy path — click → clipboard contains `${origin}/session/<id>`,
 *      and the header-toast ("Link copied") appears.
 *   3. Persistence across reload — after page.reload() the button is still
 *      present and click still copies.
 */
import { test, expect } from "../gateway-harness.js";
import { base, createSession, deleteSession, readE2ETokenAsync, waitForSessionStatus } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

async function openSessionByHash(page: import("@playwright/test").Page, sessionId: string): Promise<void> {
	await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
}

async function expectSessionComposer(page: import("@playwright/test").Page, sessionId: string, label: string): Promise<void> {
	await expect(
		page.locator("textarea").first(),
		`${label}: ROUTE_VIEW_SESSION_MISMATCH expected /session/${sessionId} to open the session composer`,
	).toBeVisible({ timeout: 15_000 });
	await expect(
		page.locator('[data-testid="copy-session-link"] button').first(),
		`${label}: ROUTE_VIEW_SESSION_MISMATCH expected session header actions for ${sessionId}`,
	).toBeVisible({ timeout: 10_000 });
}

async function expectCanonicalSessionHashUrl(page: import("@playwright/test").Page, sessionId: string, label: string): Promise<void> {
	await expect
		.poll(
			() => page.evaluate(() => window.location.href),
			{
				message: `${label}: CANONICAL_SESSION_URL expected path-style entrypoint to settle as /#/session/${sessionId}`,
				timeout: 5_000,
			},
		)
		.toBe(`${base()}/#/session/${sessionId}`);
}

// Grant clipboard read/write permissions so navigator.clipboard works in
// headless Chromium.
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test.describe("Copy session link button (UI)", () => {
	test("button copies session URL to clipboard and shows toast", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			await openApp(page);
			// Navigate to the session.
			await openSessionByHash(page, sessionId);

			// Button is present.
			const btn = page.locator('[data-testid="copy-session-link"] button').first();
			await expect(btn).toBeVisible({ timeout: 10_000 });

			// Click and verify clipboard.
			await btn.click();
			const expectedUrl = await page.evaluate(
				(id) => `${location.origin}/session/${id}`,
				sessionId,
			);
			await expect(async () => {
				const clip = await page.evaluate(() => navigator.clipboard.readText());
				expect(clip).toBe(expectedUrl);
			}).toPass({ timeout: 5_000 });

			// Toast appears (header-only [data-testid="header-toast"]).
			const toast = page.locator('[data-testid="header-toast"]');
			await expect(toast).toBeVisible({ timeout: 5_000 });
			await expect(toast).toContainText("Link copied");

			// Persists across reload.
			await page.reload();
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			const btn2 = page.locator('[data-testid="copy-session-link"] button').first();
			await expect(btn2).toBeVisible({ timeout: 10_000 });
			// Clear the clipboard, click again, verify another copy.
			await page.evaluate(() => navigator.clipboard.writeText(""));
			await btn2.click();
			await expect(async () => {
				const clip = await page.evaluate(() => navigator.clipboard.readText());
				expect(clip).toBe(expectedUrl);
			}).toPass({ timeout: 5_000 });
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});

	test("direct /session path deep link opens the session, canonicalizes, and survives reload", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			const token = await readE2ETokenAsync();
			await page.goto(`${base()}/session/${sessionId}?token=${encodeURIComponent(token)}`);
			await expectSessionComposer(page, sessionId, "direct path load");
			await expectCanonicalSessionHashUrl(page, sessionId, "direct path load");

			await page.reload();
			await expectSessionComposer(page, sessionId, "canonical hash reload");
			await expectCanonicalSessionHashUrl(page, sessionId, "canonical hash reload");
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});

	test("copied path-style session link opens in a fresh full-page load", async ({ page, browser }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		const freshContext = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
		const freshPage = await freshContext.newPage();

		try {
			await openApp(page);
			await openSessionByHash(page, sessionId);

			const btn = page.locator('[data-testid="copy-session-link"] button').first();
			await expect(btn).toBeVisible({ timeout: 10_000 });
			await btn.click();
			const copiedUrl = await page.evaluate(() => navigator.clipboard.readText());
			expect(copiedUrl, "copy action should produce the path-style session URL being fixed").toBe(`${base()}/session/${sessionId}`);

			const token = await readE2ETokenAsync();
			await freshPage.goto(`${copiedUrl}?token=${encodeURIComponent(token)}`);
			await expectSessionComposer(freshPage, sessionId, "copied path link fresh load");
			await expectCanonicalSessionHashUrl(freshPage, sessionId, "copied path link fresh load");
		} finally {
			await freshContext.close().catch(() => { /* best-effort */ });
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});

	test("hash session route takes precedence over conflicting path-style session entrypoint", async ({ page }) => {
		const oldSessionId = await createSession();
		const newSessionId = await createSession();
		await waitForSessionStatus(oldSessionId, "idle");
		await waitForSessionStatus(newSessionId, "idle");

		try {
			const token = await readE2ETokenAsync();
			await page.goto(`${base()}/session/${oldSessionId}?token=${encodeURIComponent(token)}#/session/${newSessionId}`);
			await expectSessionComposer(page, newSessionId, "hash precedence load");
			await expect
				.poll(
					() => page.evaluate(() => window.location.hash),
					{
						message: `hash precedence load: HASH_PRECEDENCE_SESSION_URL expected hash route /session/${newSessionId} to remain active instead of old path session ${oldSessionId}`,
						timeout: 5_000,
					},
				)
				.toBe(`#/session/${newSessionId}`);
			expect(
				page.url(),
				`hash precedence load: HASH_PRECEDENCE_SESSION_URL must not canonicalize conflicting path session ${oldSessionId}`,
			).not.toBe(`${base()}/#/session/${oldSessionId}`);

			const btn = page.locator('[data-testid="copy-session-link"] button').first();
			await btn.click();
			await expect(async () => {
				const clip = await page.evaluate(() => navigator.clipboard.readText());
				expect(clip).toBe(`${base()}/session/${newSessionId}`);
			}).toPass({ timeout: 5_000 });
		} finally {
			await deleteSession(oldSessionId).catch(() => { /* best-effort */ });
			await deleteSession(newSessionId).catch(() => { /* best-effort */ });
		}
	});
});
