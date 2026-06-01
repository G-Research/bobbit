/**
 * E2E — Forked sessions load and display the cloned prior conversation.
 *
 * Regression: client `forkSession()` connected to the freshly-spawned fork
 * with `isExisting=false`, so the client never sent `get_messages` and the
 * rehydrated transcript never reached the UI — the fork opened with an empty
 * chat. Continue-Archived / restored sessions connect as existing sessions
 * (`isExisting=true` → `requestMessages()`) and DO show history.
 *
 * The fix connects the fork as an existing session AND re-requests messages
 * once the freshly-spawned agent first reaches idle (the fork spins up a
 * worktree/agent, so it may be "preparing" at navigate time).
 *
 * This spec drives real messages into a source session, forks it through the
 * sidebar popover Fork item, and asserts the fork's transcript shows the
 * source's prior messages. Pre-fix the assertion fails (empty chat); post-fix
 * the cloned conversation renders.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import {
	agentEndPredicate,
	connectWs,
	createSession,
	deleteSession,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const MARKER_1 = "FORK_HISTORY_MARKER_ALPHA";
const MARKER_2 = "FORK_HISTORY_MARKER_BRAVO";

// Fork clones the source transcript, so the source needs a non-empty `.jsonl`
// before forking. Driving prompts to completion over the WS populates it.
async function sendPromptAndWait(id: string, text: string): Promise<void> {
	const ws = await connectWs(id);
	try {
		ws.send({ type: "prompt", text });
		await ws.waitFor(agentEndPredicate(), 15_000);
	} finally {
		ws.ws.close();
	}
}

function sessionRow(page: Page, sessionId: string): Locator {
	return page.locator(`[data-session-id="${sessionId}"]`).first();
}

function triggerFor(row: Locator, sessionId: string): Locator {
	return row
		.locator(`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-kind="session"][data-sidebar-actions-id="${sessionId}"]`)
		.first();
}

async function openSessionMenu(row: Locator, sessionId: string): Promise<void> {
	const page = row.page();
	await expect(row).toBeVisible({ timeout: 10_000 });
	const trigger = triggerFor(row, sessionId);
	await row.hover();
	await expect(trigger, "session hamburger should appear on hover").toBeVisible({ timeout: 5_000 });
	await trigger.click();
	await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
}

test.describe("Forked session loads prior conversation", () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
	});

	test("fork shows the source's prior messages instead of an empty chat", async ({ page }) => {
		const sourceId = await createSession();
		await waitForSessionStatus(sourceId, "idle");
		let forkId: string | undefined;

		try {
			// Seed visible history into the source session.
			await sendPromptAndWait(sourceId, `${MARKER_1} hello from the original session`);
			await sendPromptAndWait(sourceId, `${MARKER_2} second turn please`);

			// Open the source session in the UI and confirm the history is there.
			await openApp(page);
			await navigateToHash(page, `#/session/${sourceId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(
				page.locator("user-message").filter({ hasText: MARKER_1 }).first(),
				"source session should render its first message",
			).toBeVisible({ timeout: 15_000 });
			await expect(
				page.locator("user-message").filter({ hasText: MARKER_2 }).first(),
				"source session should render its second message",
			).toBeVisible({ timeout: 15_000 });

			// Fork via the sidebar popover. Uncheck "New worktree" so the fork
			// reuses the source's existing (plain) worktree — deterministic and
			// avoids standing up a git clone in the harness.
			const row = sessionRow(page, sourceId);
			await openSessionMenu(row, sourceId);
			const checkbox = page
				.locator('sidebar-actions-popover [role="menuitemcheckbox"][data-sidebar-action-id="fork"]')
				.first();
			await expect(checkbox).toBeVisible({ timeout: 5_000 });
			if ((await checkbox.getAttribute("aria-checked")) === "true") {
				await checkbox.click();
				await expect(checkbox).toHaveAttribute("aria-checked", "false");
			}

			const forkRespPromise = page.waitForResponse(
				(resp) => resp.url().includes(`/api/sessions/${sourceId}/fork`) && resp.request().method() === "POST",
				{ timeout: 20_000 },
			);
			await page.locator('sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="fork"]').first().click();
			const forkResp = await forkRespPromise;
			expect(forkResp.status(), "fork endpoint should return 201").toBe(201);
			forkId = (await forkResp.json()).id as string;
			expect(forkId).toBeTruthy();
			expect(forkId).not.toBe(sourceId);

			// The client should navigate to the fork's session route.
			await expect
				.poll(() => page.evaluate(() => window.location.hash), { timeout: 20_000 })
				.toBe(`#/session/${forkId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

			// THE FIX: the fork's transcript shows the cloned prior conversation,
			// exactly like the source / a continued session — not an empty chat.
			await expect(
				page.locator("user-message").filter({ hasText: MARKER_1 }).first(),
				"forked session must render the source's first message (was empty pre-fix)",
			).toBeVisible({ timeout: 20_000 });
			await expect(
				page.locator("user-message").filter({ hasText: MARKER_2 }).first(),
				"forked session must render the source's second message (was empty pre-fix)",
			).toBeVisible({ timeout: 20_000 });
		} finally {
			if (forkId) await deleteSession(forkId).catch(() => { /* best-effort */ });
			await deleteSession(sourceId).catch(() => { /* best-effort */ });
		}
	});
});
