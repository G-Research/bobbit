/**
 * Browser E2E test for session auto-worktree feature.
 *
 * Verifies that creating a new session via the UI automatically creates
 * a worktree branch visible in the git status widget.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, createSessionViaUI } from "./ui-helpers.js";

test.describe("Session worktree (UI)", () => {
	test("new session via UI gets worktree branch", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		// Extract session ID from URL hash
		const sessionId = await page.evaluate(() => {
			const hash = window.location.hash;
			const match = hash.match(/#\/session\/([a-f0-9-]+)/);
			return match ? match[1] : null;
		});
		expect(sessionId).toBeTruthy();

		// Wait for session to be ready (worktree setup is async)
		await expect(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			const data = await resp.json();
			expect(data.status).not.toBe("preparing");
			expect(data.worktreePath).toBeTruthy();
		}).toPass({ timeout: 30_000 });

		// Verify git status widget shows a session/* branch
		const gitStatusResp = await apiFetch(`/api/sessions/${sessionId}/git-status`);
		const gitStatus = await gitStatusResp.json();
		expect(gitStatus.branch).toMatch(/^session\/new-session-[a-f0-9]{8}$/);
	});
});
