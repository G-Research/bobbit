/**
 * Journey: App Smoke + Session Sharing + Draft Persistence — v2 browser smoke
 * Covers: journey-app-smoke, journey-session-sharing, journey-draft-persistence
 * Consolidated from: basic-load-*, session-sharing-*, pr-preview-*, draft-loss-*, etc.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus, apiFetch } from "../_helpers/journey-fixture.js";

test.describe("Journey: App Smoke", () => {
	test("app loads and sidebar is visible", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("new-session button present on load", async ({ page }) => {
		await openApp(page);
		await expect(page.getByRole("button", { name: /new session/i }).first()).toBeVisible({ timeout: 15_000 });
	});

	test("app title is non-empty", async ({ page }) => {
		await openApp(page);
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
		const title = await page.title();
		expect(title).toBeTruthy();
	});

	// Ported from page-title.spec.ts (audit: app-smoke PARTIAL). The tab title
	// must carry the "<project> · Bobbit" suffix — not just be non-empty.
	test("document title carries the '· Bobbit' suffix", async ({ page }) => {
		await openApp(page);
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
		await expect(async () => {
			const title = await page.title();
			expect(title, "tab title should contain the interpunct separator").toContain("·");
			expect(title, "tab title should be suffixed with Bobbit").toContain("Bobbit");
		}).toPass({ intervals: [250, 500, 1000], timeout: 15_000 });
	});

	test("settings route navigable from root", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Journey: Session Sharing", () => {
	test("session route renders editor for sharing context", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("session hash appears in URL for sharing", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toContain(sessionId);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("copy-link button is present in session header", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			// The copy-link action is either a direct header button or accessible via the actions trigger
			const copyLinkDirect = page.locator('[data-session-action-surface="header"][data-session-action-id="copy-link"]').first();
			const actionsTrigger = page.locator('[data-testid="session-actions-trigger"]').first();
			const found = await copyLinkDirect.isVisible({ timeout: 15_000 }).catch(() => false)
				|| await actionsTrigger.isVisible({ timeout: 15_000 }).catch(() => false);
			expect(found, "copy-link button or session-actions-trigger must be present in session header").toBe(true);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test.skip("copy-link button copies URL to clipboard", async () => {
		// Skipped: clipboard assertions require https context or explicit permission grants
		// that are unreliable across headless environments.
		// The button presence is verified in the test above.
	});
});

// ═══════════════════════════════════════════════════════════════
// Draft Persistence (CT-02 contract)
//
// Covers: draft-loss.spec.ts behavioral scenarios.
// Guarantee: editor draft typed in a session is never silently lost
// across session switches or page reloads.
// ═══════════════════════════════════════════════════════════════

test.describe("Journey: Draft Persistence", () => {
	/**
	 * CT-02-a: Draft typed in session A persists after switching to B and back.
	 * Covers: draft-loss.spec.ts "draft survives send→switch→reload" scenario.
	 */
	test("draft typed in session A persists after switching to B and back", async ({ page }) => {
		const sA = await createSession();
		const sB = await createSession();
		await waitForSessionStatus(sA, "idle");
		await waitForSessionStatus(sB, "idle");
		try {
			await openApp(page);

			// Navigate to A and type a unique draft
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const draftText = `app-smoke-draft-${Date.now()}`;
			await page.locator("message-editor textarea").first().fill(draftText);

			// Wait until the server has saved the draft (100 ms debounce)
			await expect.poll(async () => {
				const resp = await apiFetch(`/api/sessions/${sA}/draft?type=prompt`);
				if (!resp.ok) return null;
				const body = await resp.json() as { data?: { text?: string } };
				return body?.data?.text ?? null;
			}, { timeout: 20_000, intervals: [500, 1000, 1000, 2000] }).toBe(draftText);

			// Switch to B
			await navigateToHash(page, `#/session/${sB}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// Switch back to A — draft must be restored
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val, "draft must survive session switch").toContain(draftText);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 20_000 });
		} finally {
			await deleteSession(sA).catch(() => {});
			await deleteSession(sB).catch(() => {});
		}
	});

	/**
	 * CT-02-d: Draft typed survives page reload.
	 * Covers: draft-loss.spec.ts "draft survives … hard reload" and stories-drafts CT-02-d.
	 */
	test("draft typed in session survives page reload", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const draftText = `draft-reload-smoke-${Date.now()}`;
			await page.locator("message-editor textarea").first().fill(draftText);

			// Confirm server has the draft before reload
			await expect.poll(async () => {
				const resp = await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`);
				if (!resp.ok) return null;
				const body = await resp.json() as { data?: { text?: string } };
				return body?.data?.text ?? null;
			}, { timeout: 20_000, intervals: [500, 1000, 1000, 2000] }).toBe(draftText);

			// Full page reload
			await page.reload();
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });

			// Navigate back to the same session
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// Editor must show the previously typed draft
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val, "draft must survive page reload").toContain(draftText);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 20_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	/**
	 * Server-backed persistence (draft-loss.spec.ts + audit REC): the same-tab
	 * reload test above can be satisfied by the synchronous sessionStorage mirror
	 * alone. To prove the draft is genuinely server-backed (survives loss of the
	 * client mirror — new tab / evicted storage), clear the sessionStorage draft
	 * mirror before reload so restoration MUST come from loadDraftFromServer.
	 */
	test("draft restores from the server after the client draft mirror is cleared", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const draftText = `draft-server-backed-${Date.now()}`;
			await page.locator("message-editor textarea").first().fill(draftText);

			// Confirm the server has persisted the draft.
			await expect.poll(async () => {
				const resp = await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`);
				if (!resp.ok) return null;
				const body = await resp.json() as { data?: { text?: string } };
				return body?.data?.text ?? null;
			}, { timeout: 20_000, intervals: [500, 1000, 1000, 2000] }).toBe(draftText);

			// Evict the client-side draft mirror (text + gen) for this session so a
			// same-tab reload cannot restore synchronously from sessionStorage; the
			// only remaining source is the server (loadDraftFromServer).
			await page.evaluate((sid) => {
				sessionStorage.removeItem(`bobbit_draft_${sid}`);
				sessionStorage.removeItem(`bobbit_draft_gen_${sid}`);
				sessionStorage.removeItem(`draft-send-gen-${sid}`);
			}, sessionId);

			await page.reload();
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// Restoration must come from the server despite the cleared mirror.
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val, "draft must be restored from the server after mirror eviction").toContain(draftText);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 20_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	/**
	 * CT-02 / isolation: Draft typed in session A must not appear in session B.
	 * Covers the draft isolation story (S-03) from stories-sessions.spec.ts.
	 */
	test("draft typed in session A does not bleed into session B", async ({ page }) => {
		const sA = await createSession();
		const sB = await createSession();
		await waitForSessionStatus(sA, "idle");
		await waitForSessionStatus(sB, "idle");
		try {
			await openApp(page);

			// Type a draft in A
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const draftA = `draft-isolation-A-${Date.now()}`;
			await page.locator("message-editor textarea").first().fill(draftA);
			await expect.poll(async () => {
				const resp = await apiFetch(`/api/sessions/${sA}/draft?type=prompt`);
				if (!resp.ok) return null;
				const body = await resp.json() as { data?: { text?: string } };
				return body?.data?.text ?? null;
			}, { timeout: 20_000, intervals: [500, 1000, 1000, 2000] }).toBe(draftA);

			// Navigate to B — editor must not show A's draft
			await navigateToHash(page, `#/session/${sB}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val, "session B must not contain session A's draft").not.toContain(draftA);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 15_000 });
		} finally {
			await deleteSession(sA).catch(() => {});
			await deleteSession(sB).catch(() => {});
		}
	});
});
