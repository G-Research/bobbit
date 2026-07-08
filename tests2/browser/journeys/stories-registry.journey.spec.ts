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
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus, apiFetch, registerProject } from "../_helpers/journey-fixture.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test.describe("Journey: Stories Registry", () => {
	test("stories route renders without error", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/stories"; });
		await page.waitForFunction(() => window.location.hash.includes("stories"), null, { timeout: 20_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
	});

	test("sidebar visible on stories route", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/stories"; });
		await page.waitForFunction(() => window.location.hash.includes("stories"), null, { timeout: 20_000 });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Journey: Headquarters", () => {
	test("headquarters route navigable", async ({ page }) => {
		await openApp(page);
		// Headquarters is usually accessible at /settings or a dedicated hash
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
	});

	test("app shell stable on headquarters/settings route", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
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
			}, { timeout: 20_000, intervals: [500, 1000, 1000, 2000] }).toBe(draftText);

			// Switch away to B
			await navigateToHash(page, `#/session/${sB}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// Switch back to A — draft must still be there
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val).toContain(draftText);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 20_000 });
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
			}, { timeout: 20_000, intervals: [500, 1000, 1000, 2000] }).toBe(draftText);

			// Reload and navigate back
			await page.reload();
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// Draft must be restored from server
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val).toContain(draftText);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 20_000 });
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
			).toBeVisible({ timeout: 15_000 });

			// Navigate to B
			await navigateToHash(page, `#/session/${sB}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			// sB row must now be active
			await expect(
				page.locator(
					`[data-session-id="${sB}"][data-nav-active="true"], ` +
					`[data-session-id="${sB}"].sidebar-session-active`,
				).first(),
			).toBeVisible({ timeout: 15_000 });
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
			await expect(page.locator(`[data-session-id="${sA}"]`).first()).toBeVisible({ timeout: 15_000 });
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
			}, { timeout: 20_000, intervals: [500, 1000, 1000, 2000] }).toBe(draftA);

			// Switch to B — editor must be empty (no bleed from A)
			await navigateToHash(page, `#/session/${sB}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val).not.toContain(draftA);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 15_000 });

			// Switch back to A — A's draft must be intact
			await navigateToHash(page, `#/session/${sA}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(async () => {
				const val = await page.locator("message-editor textarea").first().inputValue();
				expect(val).toContain(draftA);
			}).toPass({ intervals: [500, 1000, 2000], timeout: 20_000 });
		} finally {
			await deleteSession(sA).catch(() => {});
			await deleteSession(sB).catch(() => {});
		}
	});

	// Ported from stories-sessions.spec.ts (S-01, audit GAP): the Send button
	// must be disabled on an empty composer and enabled once text is entered.
	test("Send button is disabled when the composer is empty, enabled once typed", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const textarea = page.locator("message-editor textarea").first();
			await expect(textarea).toBeVisible({ timeout: 15_000 });

			const sendBtn = page.locator('message-editor button[title="Send message"]').first();
			await expect(sendBtn).toBeVisible({ timeout: 15_000 });
			// Empty composer → Send disabled.
			await expect(sendBtn).toBeDisabled({ timeout: 10_000 });
			// Type → Send enabled.
			await textarea.fill(`send-enable-${Date.now()}`);
			await expect(sendBtn).toBeEnabled({ timeout: 10_000 });
			// Clear → Send disabled again.
			await textarea.fill("");
			await expect(sendBtn).toBeDisabled({ timeout: 10_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});

// Ported from stories-goal-routing.spec.ts (audit: stories-registry GAP / BR70):
// with 2+ projects, the toolbar New Goal opens a project picker; picking a
// project opens a goal-assistant session scoped to it.
test.describe("Journey: Goal Routing (multi-project)", () => {
	test("multi-project New Goal opens the project picker and picking scopes the assistant", async ({ page }) => {
		test.setTimeout(120_000);
		const dir = mkdtempSync(join(tmpdir(), `bobbit-v2-route-${process.env.E2E_PORT ?? "0"}-`));
		const projB = await registerProject({ name: `v2-route-b-${Date.now()}`, rootPath: dir });
		try {
			await openApp(page);
			const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
			await expect(newGoalBtn).toBeVisible({ timeout: 15_000 });
			await newGoalBtn.click();
			// Two visible projects → the picker popover must appear listing project B.
			const picker = page.locator("project-picker-popover").first();
			await expect(picker).toBeVisible({ timeout: 10_000 });
			const projBBtn = picker.locator(`button[data-project-id="${projB.id}"]`);
			await expect(projBBtn).toBeVisible({ timeout: 5_000 });
			// Picking project B opens a goal-assistant session.
			await projBBtn.click();
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await apiFetch(`/api/projects/${projB.id}`, { method: "DELETE" }).catch(() => {});
		}
	});
});

// Ported from headquarters.spec.ts (audit: stories-registry GAP): settings must
// expose the "Show Headquarters in project lists" visibility toggle (by label).
test.describe("Journey: Headquarters Visibility", () => {
	test("settings exposes the Show-Headquarters visibility toggle", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");
		await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 15_000 });
		const checkbox = page
			.getByLabel("Show Headquarters in project lists")
			.or(page.locator("label", { hasText: "Show Headquarters in project lists" }).locator('input[type="checkbox"]'))
			.first();
		await expect(checkbox).toBeVisible({ timeout: 15_000 });
	});
});
