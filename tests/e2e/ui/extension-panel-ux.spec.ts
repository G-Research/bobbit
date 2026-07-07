/**
 * Extension Panel UX Polish — browser E2E coverage for the launcher-host +
 * side-panel behaviours changed by this goal:
 *   Item 1/2 — launcher feedback is extension-derived and PERSISTENT: a
 *     `pending` state renders a spinner and never auto-clears; an `error`
 *     renders a dismiss control and never auto-clears; a `resolved` event
 *     clears the pending indicator (the panel opening is the confirmation).
 *   Item 5 — in fullscreen side-panel mode the composer is hidden and the panel
 *     fills to the bottom edge; split/collapsed modes keep the composer.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, nonGitCwd } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const FEEDBACK = '[data-testid="launcher-feedback"]';
const DISMISS = '[data-testid="launcher-feedback-dismiss"]';
const HEADER_TOAST = '[data-testid="header-toast"]';

// Grant clipboard perms so the copy-link action (used to raise a transient
// header toast) works in headless Chromium.
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

async function navigateToSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect
		.poll(() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""), { timeout: 10_000 })
		.toBe(sessionId);
}

async function emitLauncherFeedback(page: Page, kind: string, message: string): Promise<void> {
	await page.evaluate(({ kind, message }) => {
		window.dispatchEvent(new CustomEvent("bobbit-launcher-feedback", { detail: { kind, message } }));
	}, { kind, message });
}

/**
 * Raise a transient header toast (via copy-link) and wait — event-driven, no
 * inline sleep — for it to AUTO-CLEAR (~2500ms `showHeaderToast` timer). Callers
 * assert the persistent launcher-feedback element outlives it, proving it does
 * NOT share the auto-clear timer.
 */
async function raiseAndAwaitTransientToastCleared(page: Page): Promise<void> {
	const direct = page.locator('[data-session-action-surface="header"][data-session-action-id="copy-link"]').first();
	if (await direct.isVisible().catch(() => false)) {
		await direct.click();
	} else {
		await page.locator('[data-testid="session-actions-trigger"]').first().click();
		const item = page.locator('sidebar-actions-popover [role="menuitem"][data-session-action-id="copy-link"]').first();
		await expect(item).toBeVisible({ timeout: 5_000 });
		await item.click();
	}
	const toast = page.locator(HEADER_TOAST);
	await expect(toast, "transient header toast should appear").toBeVisible({ timeout: 5_000 });
	// The transient header toast auto-clears (~2500ms). Waiting for it to vanish is
	// an event-driven assertion (Playwright polls) — not a hardcoded sleep.
	await expect(toast, "transient header toast should auto-clear").toHaveCount(0, { timeout: 10_000 });
}

/** Enable preview + mount HTML so the unified side panel exists and can be resized. */
async function mountPreview(page: Page, sessionId: string): Promise<void> {
	const baseUrl = new URL(page.url()).origin;
	const patch = await page.evaluate(async ({ baseUrl, sessionId }) => {
		const r = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
			method: "PATCH",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ preview: true }),
		});
		return { status: r.status, text: await r.text() };
	}, { baseUrl, sessionId });
	expect(patch.status, `PATCH preview should succeed: ${patch.text}`).toBe(200);
	const mount = await page.evaluate(async ({ baseUrl, sessionId }) => {
		const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ entry: "current.html", html: "<!DOCTYPE html><html><body><main><h1>Preview</h1></main></body></html>" }),
		});
		return { status: r.status, text: await r.text() };
	}, { baseUrl, sessionId });
	expect(mount.status, `preview mount should succeed: ${mount.text}`).toBe(200);
	await expect(page.locator('[data-panel-workspace="content"]')).toBeVisible({ timeout: 15_000 });
}

async function setSizeMode(page: Page, sessionId: string, sizeMode: "split" | "fullscreen" | "collapsed"): Promise<void> {
	const r = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/resize`, {
		method: "POST",
		body: JSON.stringify({ sizeMode }),
	});
	expect(r.status, await r.text()).toBe(200);
	if (sizeMode === "collapsed") {
		// Collapsed replaces the workspace content with a restore rail button.
		await expect(page.locator('[data-testid="side-panel-restore"]')).toBeVisible({ timeout: 10_000 });
		return;
	}
	await expect
		.poll(() => page.locator('[data-panel-workspace="content"]').getAttribute("data-side-panel-mode"), { timeout: 10_000 })
		.toBe(sizeMode);
}

test.describe("Extension panel UX polish", () => {
	test("launcher feedback is extension-derived, persistent, dismissible, and cleared on resolve", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createSession({ cwd: nonGitCwd() });
		await navigateToSession(page, sessionId);

		// Item 1: pending message is extension-derived (no hardcoded "PR walkthrough").
		await emitLauncherFeedback(page, "pending", "Starting Custom Extension…");
		const feedback = page.locator(FEEDBACK);
		await expect(feedback).toBeVisible({ timeout: 10_000 });
		await expect(feedback).toHaveText(/Starting Custom Extension…/);
		await expect(feedback).toHaveAttribute("data-kind", "pending");
		// Pending shows a spinner and NO dismiss control.
		await expect(feedback.locator("svg.animate-spin")).toBeVisible();
		await expect(page.locator(DISMISS)).toHaveCount(0);

		// Item 2: pending is persistent — it must NOT auto-clear. Prove it by racing
		// against the transient header toast, which DOES auto-clear at ~2500ms: after
		// that toast vanishes the launcher-feedback element must still be present.
		await raiseAndAwaitTransientToastCleared(page);
		await expect(feedback, "pending launcher feedback must outlive the transient toast timer").toBeVisible();
		await expect(feedback).toHaveText(/Starting Custom Extension…/);

		// resolved clears the pending indicator (panel opening is the confirmation).
		await emitLauncherFeedback(page, "resolved", "");
		await expect(feedback).toHaveCount(0, { timeout: 10_000 });

		// error is persistent and dismissible.
		await emitLauncherFeedback(page, "error", "Could not start Custom Extension.");
		await expect(feedback).toBeVisible({ timeout: 10_000 });
		await expect(feedback).toHaveAttribute("data-kind", "error");
		await expect(feedback).toHaveText(/Could not start Custom Extension\./);
		await raiseAndAwaitTransientToastCleared(page);
		await expect(feedback, "error feedback must not auto-disappear").toBeVisible();
		const dismiss = page.locator(DISMISS);
		await expect(dismiss).toBeVisible();
		await dismiss.click();
		await expect(feedback).toHaveCount(0, { timeout: 10_000 });
	});

	test("fullscreen hides the composer and fills to the bottom edge; split/collapsed keep it", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createSession({ cwd: nonGitCwd() });
		await navigateToSession(page, sessionId);
		await mountPreview(page, sessionId);

		const composer = page.locator("textarea").first();

		// Split: composer visible alongside the panel.
		await setSizeMode(page, sessionId, "split");
		await expect(composer).toBeVisible();

		// Fullscreen: composer hidden and the panel reaches the bottom edge of its container.
		await setSizeMode(page, sessionId, "fullscreen");
		await expect(composer).toBeHidden();
		// The removed prompt strip must be gone.
		await expect(page.locator(".side-panel-fullscreen-prompt, .preview-fullscreen-prompt")).toHaveCount(0);
		const fillsToBottom = await page.evaluate(() => {
			const panel = document.querySelector('[data-panel-workspace="content"]') as HTMLElement | null;
			if (!panel) return false;
			const container = panel.parentElement as HTMLElement | null;
			if (!container) return false;
			const panelBottom = panel.getBoundingClientRect().bottom;
			const containerBottom = container.getBoundingClientRect().bottom;
			return Math.abs(panelBottom - containerBottom) <= 1;
		});
		expect(fillsToBottom, "fullscreen panel must reach the bottom edge (no reserved prompt strip)").toBe(true);

		// Collapsed: composer visible again (chat fills, panel collapses to a rail).
		await setSizeMode(page, sessionId, "collapsed");
		await expect(composer).toBeVisible();

		// Return to split — composer stays visible.
		await setSizeMode(page, sessionId, "split");
		await expect(composer).toBeVisible();
	});
});
