/**
 * Browser E2E test for session auto-worktree feature.
 *
 * Verifies that creating a new session via the API in a git repo
 * automatically creates a worktree branch visible in the git status endpoint.
 *
 * Note: the gateway-harness CWD is a non-git temp dir, so we create a
 * session with an explicit `cwd` pointing to a temporary git repo.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, gitCwd } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Session worktree (UI)", () => {
	test("new session via UI gets worktree branch", async ({ page }) => {
		// Create a session with explicit git CWD (the gateway default CWD is non-git)
		const cwd = gitCwd();
		const createResp = await apiFetch("/api/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd }),
		});
		expect(createResp.status).toBe(201);
		const created = await createResp.json();

		// Wait for session to be ready (worktree setup is async)
		await expect(async () => {
			const resp = await apiFetch(`/api/sessions/${created.id}`);
			const data = await resp.json();
			expect(data.status).not.toBe("preparing");
			expect(data.worktreePath).toBeTruthy();
		}).toPass({ timeout: 30_000 });

		// Verify git status widget shows a session/* branch.
		// Poll because the worktree may still be initializing right after status flips.
		await expect(async () => {
			const gitStatusResp = await apiFetch(`/api/sessions/${created.id}/git-status`);
			const gitStatus = await gitStatusResp.json();
			expect(gitStatus.branch).toMatch(/^session\/new-session-[a-f0-9]{8}$/);
		}).toPass({ timeout: 30_000 });

		// Navigate to the session in the UI and verify it loads
		await openApp(page);
		await navigateToHash(page, `#/session/${created.id}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });
	});
});
