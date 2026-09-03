// Migrated from tests/e2e/ui/extension-panel-ux.spec.ts (v2 browser/e2e tier).
// Full-gateway browser E2E using the canonical support harness and helpers.
/**
 * Extension Panel UX Polish — browser E2E coverage for side-panel behaviour:
 * in fullscreen mode the composer is hidden and the panel fills to the bottom
 * edge; split/collapsed modes keep the composer.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../../../tests/support/harnesses/browser/gateway-harness.js";
import { apiFetch, createSession, nonGitCwd } from "../../../tests/support/harnesses/browser/e2e-setup.js";
import { openApp, navigateToHash } from "../../../tests/support/helpers/browser/e2e/ui-helpers.js";

async function navigateToSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect
		.poll(() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""), { timeout: 10_000 })
		.toBe(sessionId);
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
