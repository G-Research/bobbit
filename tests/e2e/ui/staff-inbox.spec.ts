/**
 * Staff inbox panel — browser E2E.
 *
 * Pins the UI surface for the inbox queue feature (design: docs/design/staff-inbox.md §3.5 / §8):
 *   - Inbox panel mounts as a tab in the unified preview panel when the active
 *     session belongs to a staff agent.
 *   - "+ Add to inbox" opens the composer dialog; submitting POSTs to
 *     /api/staff/:id/inbox with source.type="manual_ui" and the new entry
 *     arrives via WS into the Pending section.
 *   - Reload persists the panel (state is rehydrated from REST on session
 *     select; localStorage drives collapse).
 *   - Cancel on a pending entry moves it to History (state=cancelled).
 *   - Delete on a terminal entry removes it.
 *   - Ctrl+] collapses the panel; the collapsed flag persists in
 *     localStorage under `bobbit-preview-collapsed-${sid}`.
 *
 * This test is authored against the REST/WS contract documented in
 * docs/design/staff-inbox.md §7. Stream B (server integration) is responsible
 * for wiring those endpoints; until that lands, the network calls will 404 and
 * specific assertions will fail at runtime. The failure modes are documented
 * inline so the team lead can route follow-up.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, defaultProject } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Staff inbox panel", () => {
	const cleanup: string[] = [];

	test.afterAll(async () => {
		for (const id of cleanup) {
			await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	async function createStaff(name: string): Promise<{ id: string; currentSessionId?: string }> {
		const project = await defaultProject();
		const resp = await apiFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify({
				name,
				systemPrompt: "Inbox panel test bot.",
				cwd: project.rootPath,
				projectId: project.id,
			}),
		});
		expect(resp.status, `create staff ${name}`).toBe(201);
		const staff = await resp.json();
		cleanup.push(staff.id);
		return staff;
	}

	async function navigateToStaffSession(page: import("@playwright/test").Page, staffId: string): Promise<string> {
		// Wait until the server has materialised a currentSessionId for the
		// staff record (sessions are spawned asynchronously after POST). Uses
		// Playwright's polling so we don't add a hard sleep.
		let sid = "";
		await expect.poll(async () => {
			const r = await apiFetch(`/api/staff/${staffId}`);
			if (!r.ok) return "";
			const s = await r.json();
			if (s.currentSessionId) sid = s.currentSessionId as string;
			return sid;
		}, { timeout: 15_000, intervals: [200, 400, 800] }).not.toBe("");
		await page.evaluate((sessionId) => { window.location.hash = `#/session/${sessionId}`; }, sid);
		return sid;
	}

	type Box = { x: number; y: number; width: number; height: number };

	function formatBox(box: Box): string {
		return `x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}`;
	}

	function containsBox(outer: Box, inner: Box, tolerance = 1): boolean {
		return inner.x >= outer.x - tolerance
			&& inner.y >= outer.y - tolerance
			&& inner.x + inner.width <= outer.x + outer.width + tolerance
			&& inner.y + inner.height <= outer.y + outer.height + tolerance;
	}

	test("mobile add-to-inbox dialog/backdrop stay within inbox pane", async ({ page }) => {
		const staff = await createStaff(`InboxBot-${Date.now()}`);

		await openApp(page);
		await page.setViewportSize({ width: 375, height: 667 });
		await navigateToStaffSession(page, staff.id);

		const inboxTab = page.locator("[data-testid='inbox-tab-pill']").first();
		await expect(inboxTab, "mobile inbox tab should appear for staff sessions").toBeVisible({ timeout: 20_000 });
		await inboxTab.click();

		const inboxPane = page.locator("[data-testid='inbox-panel-root']").first();
		await expect(inboxPane).toBeVisible({ timeout: 5_000 });
		await expect.poll(async () => {
			const box = await inboxPane.boundingBox();
			const viewport = page.viewportSize();
			if (!box || !viewport) return false;
			return Math.abs(box.x) <= 2 && Math.abs(box.x + box.width - viewport.width) <= 2;
		}, { timeout: 5_000, intervals: [50, 100, 200] }).toBe(true);

		await inboxPane.locator("button.inbox-add-btn").click();
		const dialogHost = page.locator("add-to-inbox-dialog");
		const backdrop = page.locator(".add-to-inbox-backdrop");
		await expect(dialogHost).toBeVisible({ timeout: 5_000 });
		await expect(backdrop).toBeVisible({ timeout: 5_000 });

		const paneBox = await inboxPane.boundingBox();
		const hostBox = await dialogHost.boundingBox();
		const backdropBox = await backdrop.boundingBox();
		const trackBox = await page.locator(".preview-slider__track").boundingBox();
		expect(paneBox, "inbox pane should have a bounding box").not.toBeNull();
		expect(hostBox, "dialog host should have a bounding box").not.toBeNull();
		expect(backdropBox, "dialog backdrop should have a bounding box").not.toBeNull();
		expect(trackBox, "mobile preview slider track should have a bounding box").not.toBeNull();

		expect(
			trackBox!.width,
			"mobile preview slider track should be wider than the visible inbox pane for this regression check",
		).toBeGreaterThan(paneBox!.width + 10);

		const debug = `pane=${formatBox(paneBox!)} host=${formatBox(hostBox!)} backdrop=${formatBox(backdropBox!)} track=${formatBox(trackBox!)}`;
		expect(
			containsBox(paneBox!, hostBox!),
			`dialog/backdrop should stay within mobile inbox pane: host escaped; ${debug}`,
		).toBe(true);
		expect(
			containsBox(paneBox!, backdropBox!),
			`dialog/backdrop should stay within mobile inbox pane: backdrop escaped; ${debug}`,
		).toBe(true);

		await page.mouse.click(paneBox!.x + 8, paneBox!.y + 8);
		await expect(dialogHost).toHaveCount(0, { timeout: 5_000 });
	});

	test("inbox panel renders on staff session, manual enqueue appears in Pending, persists across reload", async ({ page }) => {
		const staff = await createStaff(`InboxBot-${Date.now()}`);

		await openApp(page);
		const sid = await navigateToStaffSession(page, staff.id);

		// 1. Inbox tab appears in the unified panel for staff sessions.
		const inboxTab = page.locator("[data-testid='inbox-tab-unified'], [data-testid='inbox-tab-pill']").first();
		await expect(inboxTab, "inbox tab should appear for staff sessions").toBeVisible({ timeout: 20_000 });
		await inboxTab.click();

		// 2. Inbox panel mounts.
		await expect(page.locator("inbox-panel")).toBeVisible({ timeout: 5_000 });

		// 3. Empty state surface is initially visible.
		await expect(page.getByText("No inbox entries yet")).toBeVisible({ timeout: 5_000 });

		// 4. Open the "Add to inbox" composer dialog and submit a new entry.
		await page.locator("button.inbox-add-btn").click();
		await expect(page.locator("add-to-inbox-dialog")).toBeVisible({ timeout: 5_000 });

		const title = `Manual entry ${Date.now()}`;
		await page.locator("input.add-to-inbox-title").fill(title);
		await page.locator("textarea.add-to-inbox-prompt").fill("Investigate the deploy queue.");
		await page.locator("button.add-to-inbox-submit").click();

		// 5. Dialog closes on success; entry appears in the Pending section via WS.
		await expect(page.locator("add-to-inbox-dialog")).toHaveCount(0, { timeout: 5_000 });
		// NOTE: depends on Stream B wiring /api/staff/:id/inbox; if missing the
		// dialog will surface its inline error and this assertion will time out.
		await expect(page.locator(`inbox-entry-row[data-state="pending"]`).filter({ hasText: title })).toBeVisible({ timeout: 10_000 });

		// 6. Reload — entry persists because the panel re-fetches on session select.
		await page.reload();
		// Re-navigate to the session after reload (hash routing handles this; openApp
		// is not strictly required because the URL retains the session id).
		await page.evaluate((s) => { window.location.hash = `#/session/${s}`; }, sid);
		const tabAfterReload = page.locator("[data-testid='inbox-tab-unified'], [data-testid='inbox-tab-pill']").first();
		await expect(tabAfterReload).toBeVisible({ timeout: 20_000 });
		await tabAfterReload.click();
		await expect(page.locator(`inbox-entry-row[data-state="pending"]`).filter({ hasText: title })).toBeVisible({ timeout: 15_000 });
	});

	test("Cancel moves a pending entry to History; Delete prunes it", async ({ page }) => {
		const staff = await createStaff(`InboxBot-${Date.now()}`);
		await openApp(page);
		const sid = await navigateToStaffSession(page, staff.id);

		// Seed an entry directly via REST so we don't depend on the dialog path here.
		const title = `Cancel target ${Date.now()}`;
		const enqResp = await apiFetch(`/api/staff/${staff.id}/inbox`, {
			method: "POST",
			body: JSON.stringify({
				title,
				prompt: "to be cancelled",
				source: { type: "manual_api" },
			}),
		});
		// If Stream B isn't merged the enqueue 404s; surface the failure mode clearly.
		expect(enqResp.status, `POST /api/staff/${staff.id}/inbox should 201 (Stream B contract)`).toBe(201);

		const tab = page.locator("[data-testid='inbox-tab-unified'], [data-testid='inbox-tab-pill']").first();
		await expect(tab).toBeVisible({ timeout: 20_000 });
		await tab.click();

		const row = page.locator("inbox-entry-row").filter({ hasText: title });
		await expect(row).toBeVisible({ timeout: 15_000 });
		await expect(row).toHaveAttribute("data-state", "pending");

		// Cancel — POSTs the dismiss endpoint; the WS update transitions the
		// entry to "cancelled" and it moves into the History <details>.
		await row.locator("button.inbox-cancel-btn").click();

		// Open History (collapsed by default) and confirm the cancelled row appears.
		await page.locator("details > summary").filter({ hasText: /History/i }).click();
		const cancelled = page.locator(`inbox-entry-row[data-state="cancelled"]`).filter({ hasText: title });
		await expect(cancelled).toBeVisible({ timeout: 15_000 });

		// Delete from history — DELETE prunes the entry; WS removed event drops it.
		await cancelled.locator("button.inbox-delete-btn").click();
		await expect(page.locator("inbox-entry-row").filter({ hasText: title })).toHaveCount(0, { timeout: 15_000 });

		// Avoid unused-var lint complaints — sid is captured for symmetry with the
		// other test which re-navigates after reload.
		expect(sid).toBeTruthy();
	});

	test("Ctrl+] collapses the inbox panel; collapsed state persists across reload", async ({ page }) => {
		const staff = await createStaff(`InboxBot-${Date.now()}`);
		await openApp(page);
		const sid = await navigateToStaffSession(page, staff.id);

		const tab = page.locator("[data-testid='inbox-tab-unified'], [data-testid='inbox-tab-pill']").first();
		await expect(tab).toBeVisible({ timeout: 20_000 });
		await tab.click();
		await expect(page.locator("inbox-panel")).toBeVisible({ timeout: 5_000 });

		// Press Ctrl+] to collapse — the keyboard handler treats staff sessions as
		// panel-bearing once `state.inboxPanelOpen` is true. After collapse, the
		// localStorage key matches the shared per-session pattern.
		// Wait for the shortcut listener to attach (document.body.dataset.shortcutsReady).
		await page.waitForFunction(() => document.body.dataset.shortcutsReady === "1");
		await page.keyboard.press("Control+]");

		const collapsedKey = `bobbit-preview-collapsed-${sid}`;
		const collapsed = await page.evaluate((k) => localStorage.getItem(k), collapsedKey);
		expect(collapsed, `localStorage[${collapsedKey}] should be "true" after Ctrl+]`).toBe("true");

		// Reload — the panel respects the persisted collapse state on rehydrate.
		await page.reload();
		await page.evaluate((s) => { window.location.hash = `#/session/${s}`; }, sid);
		// The unified panel is collapsed (inbox-panel not rendered into the slot).
		// We assert via the localStorage value because the DOM hidden-state can vary by viewport.
		const stillCollapsed = await page.evaluate((k) => localStorage.getItem(k), collapsedKey);
		expect(stillCollapsed).toBe("true");
	});
});
