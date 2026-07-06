/**
 * Journey: Stories Registry + Headquarters — v2 browser smoke
 * Covers: journey-stories-registry, journey-headquarters
 * Consolidated from: stories-navigation, stories-resilience, stories-drafts,
 *                    stories-sessions, stories-sidebar, headquarters, etc.
 *
 * Story-registry contract (CT-*) coverage:
 *   CT-02 (draft preservation) — CT-02-a and CT-02-d behavioral stories
 *   CT-03 (sidebar updates)    — active-row highlight after navigation
 *   CT-05 (reload/reconnect)   — session survives page reload
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus, apiFetch } from "../_helpers/journey-fixture.js";

test.describe("Journey: Stories Registry", () => {
	test("stories route renders without error", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/stories"; });
		await page.waitForFunction(() => window.location.hash.includes("stories"), null, { timeout: 10_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
	});

	test("sidebar visible on stories route", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/stories"; });
		await page.waitForFunction(() => window.location.hash.includes("stories"), null, { timeout: 10_000 });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Journey: Headquarters", () => {
	test("headquarters route navigable", async ({ page }) => {
		await openApp(page);
		// Headquarters is usually accessible at /settings or a dedicated hash
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
	});

	test("app shell stable on headquarters/settings route", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 5_000 });
	});
});

// ═══════════════════════════════════════════════════════════════
// Story-registry contract coverage (CT-02 / CT-03 / CT-05)
//
// Each test maps to a CT-* story from tests/e2e/ui/story-registry.ts
// and exercises the behavioral guarantee named by that contract.
// ═══════════════════════════════════════════════════════════════

test.describe("Story Contract Coverage (CT-02 / CT-03 / CT-05)", () => {
	/**
	 * CT-02-a: Draft survives rapid session switching.
	 * Guarantee: Session switch preserves drafts and context (CT-02).
	 */
	test("CT-02-a: draft typed in session A survives switch to B and back", async ({ page }) => {
		const sA = await createSession();
		const sB = await createSession();
		await waitForSessionStatus(sA, "idle");
		await waitForSessionStatus(sB, "idle");
		try {
			await openApp(page);

			// Navigate to A and type a unique draft
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const draftText = `ct02a-draft-${Date.now()}`;
			await page.locator("message-editor textarea").first().fill(draftText);

			// Wait for server-side draft save
			await expect.poll(async () => {
				const resp = await apiFetch(`/api/sessions/${sA}/draft?type=prompt`);
				if (!resp.ok) return null;
				const body = await resp.json() as { data?: { text?: string } };
				return body?.data?.text ?? null;
			}, { timeout: 10_000, intervals: [500, 1000, 1000, 2000] }).toBe(draftText);

			// Switch away to B
			await navigateToHash(page, `#/session/${sB}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// Switch back to A — draft must still be there
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val).toContain(draftText);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 10_000 });
		} finally {
			await deleteSession(sA).catch(() => {});
			await deleteSession(sB).catch(() => {});
		}
	});

	/**
	 * CT-02-d: Draft survives page reload.
	 * Guarantee: Session switch preserves drafts — survives "page-reload" variation (CT-02 × CT-05).
	 */
	test("CT-02-d: draft typed survives page reload", async ({ page }) => {
		const sA = await createSession();
		await waitForSessionStatus(sA, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const draftText = `ct02d-reload-${Date.now()}`;
			await page.locator("message-editor textarea").first().fill(draftText);

			// Confirm server persisted the draft before reloading
			await expect.poll(async () => {
				const resp = await apiFetch(`/api/sessions/${sA}/draft?type=prompt`);
				if (!resp.ok) return null;
				const body = await resp.json() as { data?: { text?: string } };
				return body?.data?.text ?? null;
			}, { timeout: 10_000, intervals: [500, 1000, 1000, 2000] }).toBe(draftText);

			// Reload and navigate back
			await page.reload();
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// Draft must be restored from server
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val).toContain(draftText);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 10_000 });
		} finally {
			await deleteSession(sA).catch(() => {});
		}
	});

	/**
	 * CT-03: Session switch updates the sidebar.
	 * Guarantee: Active session row is highlighted after navigation.
	 */
	test("CT-03: active session row has data-nav-active after navigation", async ({ page }) => {
		const sA = await createSession();
		const sB = await createSession();
		await waitForSessionStatus(sA, "idle");
		await waitForSessionStatus(sB, "idle");
		try {
			await openApp(page);

			// Navigate to A
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// sA row must be active, sB row must not
			await expect(
				page.locator(
					`[data-session-id="${sA}"][data-nav-active="true"], ` +
					`[data-session-id="${sA}"].sidebar-session-active`,
				).first(),
			).toBeVisible({ timeout: 8_000 });

			// Navigate to B
			await navigateToHash(page, `#/session/${sB}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// sB row must now be active
			await expect(
				page.locator(
					`[data-session-id="${sB}"][data-nav-active="true"], ` +
					`[data-session-id="${sB}"].sidebar-session-active`,
				).first(),
			).toBeVisible({ timeout: 8_000 });
		} finally {
			await deleteSession(sA).catch(() => {});
			await deleteSession(sB).catch(() => {});
		}
	});

	/**
	 * CT-05/S-07: Page reload and reconnect restore full state.
	 * Guarantee: Session remains navigable and editor loads after reload.
	 */
	test("CT-05/S-07: session remains navigable and editor loads after page reload", async ({ page }) => {
		const sA = await createSession();
		await waitForSessionStatus(sA, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// Reload the page
			await page.reload();
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });

			// Navigate to the same session — it must still work
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			expect(await page.evaluate(() => window.location.hash)).toContain(sA);

			// Session row must be in the sidebar
			await expect(page.locator(`[data-session-id="${sA}"]`).first()).toBeVisible({ timeout: 5_000 });
		} finally {
			await deleteSession(sA).catch(() => {});
		}
	});

	/**
	 * CT-05/S-03: Draft isolation across sessions.
	 * Guarantee: Drafts are per-session; switching does not bleed content.
	 */
	test("CT-05/S-03: drafts are isolated across sessions — A draft does not appear in B", async ({ page }) => {
		const sA = await createSession();
		const sB = await createSession();
		await waitForSessionStatus(sA, "idle");
		await waitForSessionStatus(sB, "idle");
		try {
			await openApp(page);

			// Type a unique draft in A
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const draftA = `isolated-draft-A-${Date.now()}`;
			await page.locator("message-editor textarea").first().fill(draftA);
			await expect.poll(async () => {
				const resp = await apiFetch(`/api/sessions/${sA}/draft?type=prompt`);
				if (!resp.ok) return null;
				const body = await resp.json() as { data?: { text?: string } };
				return body?.data?.text ?? null;
			}, { timeout: 10_000, intervals: [500, 1000, 1000, 2000] }).toBe(draftA);

			// Switch to B — editor must be empty (no bleed from A)
			await navigateToHash(page, `#/session/${sB}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val).not.toContain(draftA);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 8_000 });

			// Switch back to A — A's draft must be intact
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val).toContain(draftA);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 10_000 });
		} finally {
			await deleteSession(sA).catch(() => {});
			await deleteSession(sB).catch(() => {});
		}
	});
});
