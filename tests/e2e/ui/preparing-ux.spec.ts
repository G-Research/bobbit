/**
 * Preparing UX — reproducing test for the "Setting up worktree…" banner bug.
 *
 * Bug: when a brand-new worktree-backed session is created via the UI, the
 * "Setting up worktree…" banner does NOT appear in the chat panel and the
 * message editor stays enabled. Reload masks the bug because the status frame
 * lands before <agent-interface> is constructed.
 *
 * Root cause: src/app/session-manager.ts::RemoteAgent.onStatusChange only
 * calls agentInterface.requestUpdate() for "aborting"/"idle". For "preparing"
 * it falls through to renderApp(), which doesn't re-render the existing
 * <agent-interface> instance (Lit reference-equality misses the change).
 *
 * This spec deterministically extends the preparing window by setting
 * BOBBIT_TEST_PREPARING_DELAY_MS and asserts the banner is visible.
 * Pre-fix this assertion fails. Post-fix all three phases (banner visible,
 * editor hidden, banner clears + editor shows) pass.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PREPARING_DELAY_MS = 3000;

test.describe("Preparing UX (worktree-backed session)", () => {
	let repoPath: string;
	let projectId: string;

	test.beforeAll(async () => {
		// Set the test-only env-var hook so the server-side worktree pipeline
		// sleeps after status="preparing" is broadcast and before the worktree
		// is actually created. Read at call-time inside executeWorktreeAsync;
		// the worker process is the same one the gateway boots in, so setting
		// it here is sufficient.
		process.env.BOBBIT_TEST_PREPARING_DELAY_MS = String(PREPARING_DELAY_MS);

		// Real git repo so worktree creation runs.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-prep-ux-"));
		repoPath = path.join(root, "repo");
		fs.mkdirSync(repoPath, { recursive: true });
		execFileSync("git", ["init", "--initial-branch=master"], { cwd: repoPath });
		execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: repoPath });
		execFileSync("git", ["config", "user.name", "test"], { cwd: repoPath });
		fs.writeFileSync(path.join(repoPath, "README.md"), "fixture\n");
		execFileSync("git", ["add", "."], { cwd: repoPath });
		execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath });

		const reg = await apiFetch("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `prep-ux-${Date.now()}`, rootPath: repoPath }),
		});
		expect(reg.status).toBe(201);
		projectId = (await reg.json()).id;
	});

	test.afterAll(async () => {
		delete process.env.BOBBIT_TEST_PREPARING_DELAY_MS;
		if (projectId) {
			await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("banner is visible and editor is hidden while preparing, then clears", async ({ page }) => {
		await openApp(page);

		// Click "New session in <project-name>" for our test project. The title
		// carries a timestamp suffix; match by prefix.
		await page.locator(`button[title^="New session in prep-ux-"]`).first().click();

		// PRIMARY ASSERTION — fails pre-fix. The banner must appear within ~1s
		// of session creation. Generous timeout so a slow CI doesn't false-fail
		// on infra latency, but well under PREPARING_DELAY_MS so we're still
		// inside the preparing window.
		const banner = page.getByText("Setting up worktree…");
		await expect(banner).toBeVisible({ timeout: 2000 });

		// Editor is hidden while preparing — the AgentInterface gate at line
		// 1642 hides <message-editor> when state.isPreparing.
		await expect(page.locator("message-editor")).toHaveCount(0);

		// After the preparing window elapses, banner clears and editor mounts.
		await expect(banner).toBeHidden({ timeout: PREPARING_DELAY_MS + 10_000 });
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 5000 });
	});

});
