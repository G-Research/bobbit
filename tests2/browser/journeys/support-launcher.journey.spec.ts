/**
 * Journey: Support Launcher — v2 browser smoke
 *
 * Covers the "Support" launcher (goal: Support Assistant fix-up, Defects 1-4):
 *   - MessageCircleQuestion (help / message-question) icon Button wrapped in
 *     <span data-testid="support-launcher" style="display:contents"> with
 *     title="Open a new support agent session", rendered in BOTH the desktop
 *     sidebar header and the mobile header, immediately to the LEFT of the
 *     QR-code button (title="Show QR code").
 *   - Rendered whenever Headquarters is shown in project lists
 *     (state.showHeadquartersInProjectLists !== false) — visible even when a
 *     NON-Headquarters project is active; hidden ONLY when the
 *     "Show Headquarters in project lists" preference is off.
 *   - The desktop launcher Button matches its QR sibling's sizing (h-6 w-6).
 *   - Clicking it POSTs /api/sessions { assistantType:"support",
 *     projectId:"headquarters" } and connects to the new session — even when a
 *     non-HQ project is the active project.
 *
 * The wrapper span uses display:contents so it does not add a flex box; assert
 * visibility / geometry / title / classes on the inner <button>.
 */
import type { Page } from "@playwright/test";
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus, apiFetch } from "../_helpers/journey-fixture.js";

const HEADQUARTERS_PROJECT_ID = "headquarters";
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 375, height: 667 };

/** The testid wrapper (display:contents span). Use for presence/absence. */
const launcher = (page: Page) => page.locator('[data-testid="support-launcher"]').first();
/** The actual clickable Button inside the launcher. Use for visibility/geometry/title. */
const launcherBtn = (page: Page) => page.locator('[data-testid="support-launcher"] button').first();
const qrButton = (page: Page) => page.locator('button[title="Show QR code"]').first();

const SUPPORT_TITLE = "Open a new support agent session";

async function setHeadquartersVisible(visible: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ showHeadquartersInProjectLists: visible }),
	});
	expect(resp.ok, `set showHeadquartersInProjectLists=${visible}`).toBeTruthy();
}

/** Center-x of a locator's bounding box (throws if not laid out). */
async function centerX(loc: import("@playwright/test").Locator): Promise<number> {
	const box = await loc.boundingBox();
	if (!box) throw new Error("element has no bounding box");
	return box.x + box.width / 2;
}

/**
 * Create a default (non-Headquarters) project session and navigate to it so
 * state.activeProjectId is NOT "headquarters" — proving the launcher no longer
 * depends on the active project being Headquarters.
 * Returns the created session id (caller cleans up).
 */
async function openNonHqSession(page: Page): Promise<string> {
	const sessionId = await createSession();
	await waitForSessionStatus(sessionId, "idle");
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
	// Confirm the app does NOT consider Headquarters the active project.
	await expect
		.poll(() => page.evaluate(() => (window as any).bobbitState?.activeProjectId ?? null), { timeout: 15_000 })
		.not.toBe(HEADQUARTERS_PROJECT_ID);
	return sessionId;
}

test.describe("Journey: Support Launcher", () => {
	test.beforeEach(async () => {
		await setHeadquartersVisible(true);
	});

	test("launcher is visible (left of QR) with a non-HQ project active when Headquarters is enabled (desktop)", async ({ page }) => {
		await page.setViewportSize(DESKTOP);
		let session: string | undefined;
		try {
			await openApp(page);
			session = await openNonHqSession(page);

			// Present + visible even though the active project is NOT Headquarters.
			await expect(launcher(page)).toHaveCount(1);
			await expect(launcherBtn(page)).toBeVisible({ timeout: 15_000 });

			// Descriptive tooltip.
			await expect(launcherBtn(page)).toHaveAttribute("title", SUPPORT_TITLE);

			// Renders an icon (message-question) — assert an svg is present.
			await expect(launcherBtn(page).locator("svg").first()).toBeVisible({ timeout: 15_000 });

			// Matches sibling sizing (same as the QR button: h-6 w-6).
			await expect(launcherBtn(page)).toHaveClass(/(?:^|\s)h-6(?:\s|$)/);
			await expect(launcherBtn(page)).toHaveClass(/(?:^|\s)w-6(?:\s|$)/);

			// Sits immediately LEFT of the QR button (same header row).
			await expect(qrButton(page)).toBeVisible({ timeout: 15_000 });
			const supportX = await centerX(launcherBtn(page));
			const qrX = await centerX(qrButton(page));
			expect(supportX, "support launcher should sit left of the QR button").toBeLessThan(qrX);
		} finally {
			if (session) await deleteSession(session).catch(() => {});
		}
	});

	test("launcher is hidden when 'Show Headquarters in project lists' is off", async ({ page }) => {
		await page.setViewportSize(DESKTOP);
		// Turn the preference off BEFORE the app boots so the client picks it up.
		await setHeadquartersVisible(false);
		let session: string | undefined;
		try {
			session = await createSession();
			await waitForSessionStatus(session, "idle");
			await openApp(page);
			await navigateToHash(page, `#/session/${session}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });

			// The QR button proves the header rendered, but the launcher is absent.
			await expect(qrButton(page)).toBeVisible({ timeout: 15_000 });
			await expect(page.locator('[data-testid="support-launcher"]')).toHaveCount(0);
		} finally {
			if (session) await deleteSession(session).catch(() => {});
		}
	});

	test("launcher is visible left of the QR button with a non-HQ project active (mobile)", async ({ page }) => {
		await page.setViewportSize(MOBILE);
		let session: string | undefined;
		try {
			await openApp(page);
			session = await openNonHqSession(page);

			// The mobile launcher renders in the mobile landing header (not the in-session
			// header), so drop back to the landing route.
			await navigateToHash(page, "#/");
			await expect(launcher(page)).toHaveCount(1);
			await expect(launcherBtn(page)).toBeVisible({ timeout: 20_000 });
			await expect(launcherBtn(page)).toHaveAttribute("title", SUPPORT_TITLE);

			// Sits left of the QR button in the mobile header too.
			await expect(qrButton(page)).toBeVisible({ timeout: 15_000 });
			const supportX = await centerX(launcherBtn(page));
			const qrX = await centerX(qrButton(page));
			expect(supportX, "mobile support launcher should sit left of the QR button").toBeLessThan(qrX);
		} finally {
			if (session) await deleteSession(session).catch(() => {});
		}
	});

	test("clicking the launcher (from a non-HQ project) creates + opens an HQ support session that persists across reload", async ({ page }) => {
		test.setTimeout(90_000);
		await page.setViewportSize(DESKTOP);
		let session: string | undefined;
		let supportSession: string | undefined;
		try {
			await openApp(page);
			session = await openNonHqSession(page);
			await expect(launcherBtn(page)).toBeVisible({ timeout: 15_000 });

			// Capture the session-create POST driven by showSupportDialog().
			const reqPromise = page.waitForRequest(
				(r) => /\/api\/sessions(\?|$)/.test(r.url()) && r.method() === "POST",
				{ timeout: 30_000 },
			);
			const respPromise = page.waitForResponse(
				(r) => /\/api\/sessions(\?|$)/.test(r.url()) && r.request().method() === "POST",
				{ timeout: 30_000 },
			);

			await launcherBtn(page).click();

			const req = await reqPromise;
			const body = JSON.parse(req.postData() || "{}") as { assistantType?: string; projectId?: string };
			expect(body.assistantType, "support launcher POSTs assistantType=support").toBe("support");
			expect(body.projectId, "support launcher targets the Headquarters project").toBe(HEADQUARTERS_PROJECT_ID);

			const resp = await respPromise;
			expect(resp.ok(), "session-create should succeed").toBeTruthy();
			const created = await resp.json() as { id?: string; assistantType?: string; projectId?: string };
			expect(created.id, "created session has an id").toBeTruthy();
			supportSession = created.id!;

			// The app navigates to the new support session.
			await expect
				.poll(() => page.evaluate(() => window.location.hash), { timeout: 20_000 })
				.toContain(supportSession);

			// Server-side, the created session is a Headquarters support session.
			await expect.poll(async () => {
				const r = await apiFetch(`/api/sessions/${supportSession}`);
				if (!r.ok) return null;
				const s = await r.json() as { assistantType?: string; projectId?: string };
				return { assistantType: s.assistantType, projectId: s.projectId };
			}, { timeout: 20_000 }).toEqual({ assistantType: "support", projectId: HEADQUARTERS_PROJECT_ID });

			// Reload persists the session — it is still reachable and re-openable.
			await page.reload();
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });
			const afterReload = await apiFetch(`/api/sessions/${supportSession}`);
			expect(afterReload.ok, "support session still exists after reload").toBeTruthy();
			await navigateToHash(page, `#/session/${supportSession}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
		} finally {
			if (supportSession) await deleteSession(supportSession).catch(() => {});
			if (session) await deleteSession(session).catch(() => {});
		}
	});
});
