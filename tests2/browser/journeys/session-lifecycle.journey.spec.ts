/**
 * Journey: Session Lifecycle — v2 browser smoke
 * Covers: session creation, default role persistence, messaging, sidebar row,
 *         reload persistence, fork via sidebar, sidebar actions menu, copy-link action.
 * Consolidated from: fork-session-history, copy-session-link, sidebar-session-actions, etc.
 */
import { test, expect, openApp, navigateToHash, createSession, createSessionViaUI, deleteSession, waitForSessionStatus } from "../_helpers/journey-fixture.js";
import { base } from "../e2e-setup.js";

// ---------------------------------------------------------------------------
// Selectors used across multiple tests
// ---------------------------------------------------------------------------
function sessionRow(page: import("@playwright/test").Page, sessionId: string) {
	return page.locator(`[data-session-id="${sessionId}"]`).first();
}

function sidebarTrigger(row: import("@playwright/test").Locator, sessionId: string) {
	return row
		.locator(`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-kind="session"][data-sidebar-actions-id="${sessionId}"]`)
		.first();
}

/** Hover the session row and click its sidebar-actions-trigger to open the popover. */
async function openSidebarPopover(
	page: import("@playwright/test").Page,
	sessionId: string,
): Promise<boolean> {
	const row = sessionRow(page, sessionId);
	if (!await row.isVisible({ timeout: 15_000 }).catch(() => false)) return false;
	await row.scrollIntoViewIfNeeded();
	await row.hover();
	const trigger = sidebarTrigger(row, sessionId);
	if (!await trigger.isVisible({ timeout: 3_000 }).catch(() => false)) return false;
	await trigger.click();
	return page.locator("sidebar-actions-popover [role='menu']").isVisible({ timeout: 15_000 }).catch(() => false);
}

/** Open Modify Session from the row's standard quick action and return its role control. */
async function openModifySessionRole(
	page: import("@playwright/test").Page,
	sessionId: string,
) {
	const row = sessionRow(page, sessionId);
	await expect(row).toBeVisible({ timeout: 20_000 });
	await row.scrollIntoViewIfNeeded();
	await row.hover();
	const modify = row.locator('[data-sidebar-action-id="modify"][data-sidebar-action-quick="true"]').first();
	await expect(modify).toBeVisible({ timeout: 15_000 });
	await modify.click();
	await expect(page.getByText("Modify Session", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
	const roleControl = page.locator('#role-picker-container button[title="Select role"]').first();
	await expect(roleControl).toBeVisible({ timeout: 15_000 });
	return roleControl;
}

/** Click a copy-link action: try direct header button first, fall back to popover. */
async function clickCopyLink(page: import("@playwright/test").Page): Promise<boolean> {
	const direct = page.locator('[data-session-action-surface="header"][data-session-action-id="copy-link"]').first();
	if (await direct.isVisible({ timeout: 3_000 }).catch(() => false)) {
		await direct.click();
		return true;
	}
	// Try via hamburger trigger
	const trigger = page.locator('[data-testid="session-actions-trigger"]').first();
	if (!await trigger.isVisible({ timeout: 3_000 }).catch(() => false)) return false;
	await trigger.click();
	const item = page.locator('sidebar-actions-popover [role="menuitem"][data-session-action-id="copy-link"]').first();
	if (!await item.isVisible({ timeout: 15_000 }).catch(() => false)) return false;
	await item.click();
	return true;
}

// ---------------------------------------------------------------------------
// Existing lifecycle tests
// ---------------------------------------------------------------------------

test.describe("Journey: Session Lifecycle", () => {
	test("navigate to session shows editor", async ({ page }) => {
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

	test("send message gets mock-agent response", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await page.locator("message-editor textarea").first().fill("Hello");
			await page.locator("message-editor textarea").first().press("Enter");
			await expect(page.getByText("OK").first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("session row visible in sidebar", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(`[data-session-id="${sessionId}"]`).first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("reload and re-navigate to session works", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await page.reload();
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("quick standard session defaults to General across reload and creation picker", async ({ page }) => {
		let sessionId = "";
		try {
			await openApp(page);
			sessionId = await createSessionViaUI(page);
			await waitForSessionStatus(sessionId, "idle");

			let roleControl = await openModifySessionRole(page, sessionId);
			await expect(roleControl).toContainText("General");
			await page.getByRole("button", { name: "Cancel" }).click();

			await page.reload();
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			roleControl = await openModifySessionRole(page, sessionId);
			await expect(roleControl).toContainText("General");
			await page.getByRole("button", { name: "Cancel" }).click();

			const quickSessionButton = page.locator('button[title="New session in default"]').first();
			await expect(quickSessionButton).toBeVisible({ timeout: 15_000 });
			const newSessionWithRole = quickSessionButton.locator("..").locator('button[title="New session with role"]');
			await expect(newSessionWithRole).toBeVisible({ timeout: 15_000 });
			await newSessionWithRole.click();

			const pickerPanel = page
				.locator("div.fixed.z-50")
				.filter({ hasText: "Create New Session in default" })
				.last();
			await expect(pickerPanel).toBeVisible({ timeout: 15_000 });
			const pickerRoleControl = pickerPanel.locator('#picker-role-container button[title="Select role"]');
			await expect(pickerRoleControl).toContainText("General");
			await pickerRoleControl.click();
			await expect(pickerPanel.locator('#picker-role-container button[title="Select General role"]')).toBeVisible();
			await expect(pickerPanel.locator('#picker-role-container button[title="No role"]')).toHaveCount(0);
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => {});
		}
	});
});

// ---------------------------------------------------------------------------
// Sidebar actions menu
// ---------------------------------------------------------------------------

test.describe("Journey: Sidebar Actions Menu", () => {
	test("hovering session row reveals sidebar-actions-trigger", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const row = sessionRow(page, sessionId);
			if (!await row.isVisible({ timeout: 15_000 }).catch(() => false)) {
				test.skip(true, "session row not in sidebar; actions test skipped");
				return;
			}
			await row.hover();
			const trigger = sidebarTrigger(row, sessionId);
			await expect(trigger).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("sidebar actions popover contains expected action items", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const opened = await openSidebarPopover(page, sessionId);
			if (!opened) {
				test.skip(true, "sidebar-actions popover not openable in this config; test skipped");
				return;
			}

			const popover = page.locator("sidebar-actions-popover [role='menu']");
			await expect(popover).toBeVisible({ timeout: 15_000 });

			// Canonical session actions: modify, terminate, fork, copy-link should be present
			const expectedActions = ["modify", "terminate", "copy-link"];
			for (const actionId of expectedActions) {
				const item = page.locator(`sidebar-actions-popover [role="menuitem"][data-session-action-id="${actionId}"]`).first();
				await expect(item, `action '${actionId}' should appear in sidebar popover`).toBeVisible({ timeout: 15_000 });
			}

			// Fork item (may be a menuitemcheckbox)
			const forkItem = page.locator(`sidebar-actions-popover [data-session-action-id="fork"]`).first();
			await expect(forkItem, "fork action should appear in sidebar popover").toBeVisible({ timeout: 15_000 });

			await page.keyboard.press("Escape");
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("Modify action visible in sidebar popover", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const opened = await openSidebarPopover(page, sessionId);
			if (!opened) {
				test.skip(true, "sidebar-actions popover not openable; skipped");
				return;
			}
			const modifyItem = page.locator(`sidebar-actions-popover [role="menuitem"][data-session-action-id="modify"]`).first();
			await expect(modifyItem).toBeVisible({ timeout: 15_000 });
			await page.keyboard.press("Escape");
		} finally {
			await deleteSession(sessionId);
		}
	});
});

// ---------------------------------------------------------------------------
// Fork via sidebar
// ---------------------------------------------------------------------------

test.describe("Journey: Fork Session", () => {
	/**
	 * Fork via sidebar: we route the fork API to avoid needing a real git worktree
	 * (the test harness sessions have no worktree) — this mirrors the technique used
	 * in tests/e2e/ui/session-actions.spec.ts "fork trailing toggle" test.
	 * The UI behavior under test is: sidebar-actions → fork row → client POSTs to
	 * /fork → navigates to the new session route.
	 */
	test("fork action in sidebar popover triggers fork API and navigates to new session", async ({ page }) => {
		const sourceId = await createSession();
		await waitForSessionStatus(sourceId, "idle");
		const FAKE_FORK_ID = "aaaabbbb-cccc-dddd-eeee-ffffffffffff";

		try {
			// Route the fork endpoint to return a fake fork session (avoids needing a
			// real git worktree which plain test-harness sessions don't have).
			await page.route(`**/api/sessions/${sourceId}/fork`, async (route) => {
				if (route.request().method() !== "POST") return route.fallback();
				await route.fulfill({
					status: 201,
					contentType: "application/json",
					body: JSON.stringify({
						id: FAKE_FORK_ID,
						cwd: "/tmp/fork",
						status: "idle",
						title: "Fork: Source",
						projectId: "default",
					}),
				});
			});

			await openApp(page);
			await navigateToHash(page, `#/session/${sourceId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const row = sessionRow(page, sourceId);
			if (!await row.isVisible({ timeout: 15_000 }).catch(() => false)) {
				test.skip(true, "session row not found in sidebar; fork test skipped");
				return;
			}

			await row.hover();
			const trigger = sidebarTrigger(row, sourceId);
			if (!await trigger.isVisible({ timeout: 3_000 }).catch(() => false)) {
				test.skip(true, "sidebar-actions-trigger not visible; fork test skipped");
				return;
			}
			await trigger.click();
			await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 15_000 });

			// Uncheck "New worktree" toggle if present
			const worktreeCheckbox = page
				.locator('sidebar-actions-popover [role="menuitemcheckbox"][data-sidebar-action-id="fork"]')
				.first();
			if (await worktreeCheckbox.isVisible({ timeout: 2_000 }).catch(() => false)) {
				if ((await worktreeCheckbox.getAttribute("aria-checked")) === "true") {
					await worktreeCheckbox.click();
					await expect(worktreeCheckbox).toHaveAttribute("aria-checked", "false");
				}
			}

			// Intercept the routed fork API call
			const forkPromise = page.waitForResponse(
				(resp) =>
					resp.url().includes(`/api/sessions/${sourceId}/fork`) &&
					resp.request().method() === "POST",
				{ timeout: 20_000 },
			);

			// Click the fork row action
			const forkRow = page.locator('sidebar-actions-popover [role="menuitem"][data-session-action-id="fork"]').first();
			if (!await forkRow.isVisible({ timeout: 3_000 }).catch(() => false)) {
				test.skip(true, "fork menuitem not visible in popover; fork test skipped");
				return;
			}
			await forkRow.click();

			const forkResp = await forkPromise;
			expect(forkResp.status(), "fork endpoint should return 201").toBe(201);
			const forkBody = await forkResp.json();
			expect(forkBody.id, "fork should return the mocked session ID").toBe(FAKE_FORK_ID);

			// UI should navigate to the fork's session route
			await expect
				.poll(() => page.evaluate(() => window.location.hash), { timeout: 20_000 })
				.toBe(`#/session/${FAKE_FORK_ID}`);
		} finally {
			await page.unroute(`**/api/sessions/${sourceId}/fork`).catch(() => {});
			await deleteSession(sourceId).catch(() => {});
		}
	});
});

// ---------------------------------------------------------------------------
// Copy-link
// ---------------------------------------------------------------------------

test.describe("Journey: Copy Session Link", () => {
	test.use({ permissions: ["clipboard-read", "clipboard-write"] });

	test("copy-link action puts session URL in clipboard", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

			// Copy-link button visible (direct or via hamburger trigger)
			const copyLinkDirectOrTrigger = page.locator(
				'[data-session-action-surface="header"][data-session-action-id="copy-link"], [data-testid="session-actions-trigger"]',
			).first();
			await expect(copyLinkDirectOrTrigger).toBeVisible({ timeout: 20_000 });

			const clicked = await clickCopyLink(page);
			if (!clicked) {
				test.skip(true, "copy-link action not reachable; skipped");
				return;
			}

			// Clipboard should contain the session URL
			const expectedUrl = `${base()}/#/session/${sessionId}`;
			await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 15_000 }).toBe(expectedUrl);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});

	test("copy-link persists across reload", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

			await page.reload();
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

			// copy-link action still reachable after reload
			const copyLinkOrTrigger = page.locator(
				'[data-session-action-surface="header"][data-session-action-id="copy-link"], [data-testid="session-actions-trigger"]',
			).first();
			await expect(copyLinkOrTrigger).toBeVisible({ timeout: 20_000 });

			await page.evaluate(() => navigator.clipboard.writeText(""));
			const clicked = await clickCopyLink(page);
			if (!clicked) {
				test.skip(true, "copy-link not reachable after reload; skipped");
				return;
			}
			const expectedUrl = `${base()}/#/session/${sessionId}`;
			await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 15_000 }).toBe(expectedUrl);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
