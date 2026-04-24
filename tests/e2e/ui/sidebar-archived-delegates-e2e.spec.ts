/**
 * Browser E2E test for SB-00b: Archived delegates survive "Show Archived" toggle.
 *
 * Scenario: Create a session → create a delegate → archive the delegate →
 * toggle "Show Archived" → verify the archived delegate appears nested
 * under the parent in the sidebar.
 */
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	waitForSessionStatus,
	nonGitCwd,
} from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

/**
 * Create a delegate session for a parent session via the REST API.
 */
async function createDelegate(parentId: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			delegateOf: parentId,
			instructions: "E2E delegate for SB-00b",
			cwd: nonGitCwd(),
		}),
	});
	expect(resp.status).toBe(201);
	return (await resp.json()).id;
}

/**
 * Terminate (archive) a session via DELETE.
 */
async function terminateSession(id: string): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${id}`, { method: "DELETE" });
	expect(resp.ok, `Failed to terminate session ${id}: ${resp.status}`).toBe(true);
}

/**
 * Rename a session via the REST API so we can find it by title in the sidebar.
 */
async function renameSession(id: string, title: string): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${id}`, {
		method: "PATCH",
		body: JSON.stringify({ title }),
	});
	expect(resp.ok, `Failed to rename session ${id}: ${resp.status}`).toBe(true);
}

test.describe("SB-00b: Archived delegates visible after Show Archived toggle", () => {
	const cleanupSessionIds: string[] = [];

	test.afterAll(async () => {
		for (const id of cleanupSessionIds) {
			await deleteSession(id).catch(() => {});
		}
	});

	test("archived delegate appears nested under live parent after toggling Show Archived", async ({ page }) => {
		// Use distinctive titles so we can find them in the sidebar
		const PARENT_TITLE = "SB00b-Parent";
		const DELEGATE_TITLE = "SB00b-Delegate";

		// 1. Create a live parent session and rename it
		const parentId = await createSession();
		cleanupSessionIds.push(parentId);
		await waitForSessionStatus(parentId, "idle");
		await renameSession(parentId, PARENT_TITLE);

		// 2. Create a delegate of the parent and rename it
		const delegateId = await createDelegate(parentId);
		cleanupSessionIds.push(delegateId);
		await waitForSessionStatus(delegateId, "idle");
		await renameSession(delegateId, DELEGATE_TITLE);

		// 3. Terminate (archive) the delegate
		await terminateSession(delegateId);

		// 4. Open the app — the parent should be visible in the sidebar
		await openApp(page);

		// Navigate to the parent session so it's highlighted and visible
		await navigateToHash(page, `#/session/${parentId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// 5. Wait for the parent row to render (positive sentinel that the
		// sidebar has populated), then assert the archived delegate is NOT
		// visible yet. The toHaveCount assertion polls, so no blind pad needed.
		await expect(page.getByText(PARENT_TITLE, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText(DELEGATE_TITLE, { exact: true })).toHaveCount(0, { timeout: 3_000 });

		// 6. Toggle "Show Archived" on
		const seeArchivedBtn = page.locator("button").filter({ hasText: "See Archived" }).first();
		await expect(seeArchivedBtn).toBeVisible({ timeout: 10_000 });
		await seeArchivedBtn.click();

		// 7. Wait for the toggle to take effect. After #328 (per-project Archived
		// subsections), no span.uppercase "Archived" header renders in this
		// scenario — the project has no standalone archived goals or sessions,
		// only a delegate of a LIVE parent, so the per-project Archived
		// subsection stays empty. Instead poll for the button's active state
		// (text-primary class).
		await expect.poll(
			async () => seeArchivedBtn.evaluate((el) => el.className.includes("text-primary")),
			{ timeout: 10_000 },
		).toBe(true);

		// 8. Wait for sidebar to render with archived data. Either the parent
		// row gains an expand chevron ▸, or the delegate appears standalone.
		const parentText = page.getByText(PARENT_TITLE, { exact: true }).first();
		await expect(parentText).toBeVisible({ timeout: 10_000 });
		await page.waitForFunction(
			({ parentTitle, delegateTitle }) => {
				if (Array.from(document.querySelectorAll(".truncate")).some(
					(el) => el.textContent?.trim() === delegateTitle,
				)) return true;
				for (const el of document.querySelectorAll(".truncate")) {
					if (el.textContent?.trim() !== parentTitle) continue;
					const row = el.closest("[class*='cursor-pointer']");
					if (!row) continue;
					for (const s of row.querySelectorAll("span")) {
						const t = s.textContent?.trim();
						if (t === "▸" || t === "▾") return true;
					}
				}
				return false;
			},
			{ parentTitle: PARENT_TITLE, delegateTitle: DELEGATE_TITLE },
			{ timeout: 10_000 },
		);

		// Look for expand chevron ▸ near the parent row — use evaluate for reliability
		const expanded = await page.evaluate((parentTitle: string) => {
			// Find the parent row by title text
			const allElements = document.querySelectorAll(".truncate");
			for (const el of allElements) {
				if (el.textContent?.trim() === parentTitle) {
					// Found the parent title element. Go up to the row container.
					const row = el.closest("[class*='cursor-pointer']");
					if (!row) continue;
					// Look for a collapsed chevron ▸ to click
					const chevron = row.querySelector("span");
					if (chevron && chevron.textContent?.trim() === "▸") {
						(chevron as HTMLElement).click();
						return true;
					}
				}
			}
			return false;
		}, PARENT_TITLE);

		// No pad needed — delegateLocator assertion below polls up to 10s.
		void expanded;

		// 9. Check if the delegate appears anywhere — it could be nested under the
		//    parent OR in the standalone archived section at the bottom.
		//    The bug fix ensures it appears in both contexts.
		const delegateLocator = page.getByText(DELEGATE_TITLE, { exact: true }).first();
		await expect(delegateLocator).toBeVisible({ timeout: 10_000 });

		// 10. Toggle OFF then ON — delegate should survive the cycle
		await seeArchivedBtn.click();
		// Wait for button to leave active state, then assert delegate is gone.
		await expect.poll(
			async () => seeArchivedBtn.evaluate((el) => el.className.includes("text-primary")),
			{ timeout: 10_000 },
		).toBe(false);
		await expect(page.getByText(DELEGATE_TITLE, { exact: true })).toHaveCount(0, { timeout: 3_000 });

		// Toggle back on
		await seeArchivedBtn.click();
		await expect.poll(
			async () => seeArchivedBtn.evaluate((el) => el.className.includes("text-primary")),
			{ timeout: 10_000 },
		).toBe(true);
		// Wait until sidebar repopulates with archived data.
		await page.waitForFunction(
			({ parentTitle, delegateTitle }) => {
				if (Array.from(document.querySelectorAll(".truncate")).some(
					(el) => el.textContent?.trim() === delegateTitle,
				)) return true;
				for (const el of document.querySelectorAll(".truncate")) {
					if (el.textContent?.trim() !== parentTitle) continue;
					const row = el.closest("[class*='cursor-pointer']");
					if (!row) continue;
					for (const s of row.querySelectorAll("span")) {
						const t = s.textContent?.trim();
						if (t === "▸" || t === "▾") return true;
					}
				}
				return false;
			},
			{ parentTitle: PARENT_TITLE, delegateTitle: DELEGATE_TITLE },
			{ timeout: 10_000 },
		);

		// Re-expand parent if needed
		await page.evaluate((parentTitle: string) => {
			const allElements = document.querySelectorAll(".truncate");
			for (const el of allElements) {
				if (el.textContent?.trim() === parentTitle) {
					const row = el.closest("[class*='cursor-pointer']");
					if (!row) continue;
					const chevron = row.querySelector("span");
					if (chevron && chevron.textContent?.trim() === "▸") {
						(chevron as HTMLElement).click();
						return;
					}
				}
			}
		}, PARENT_TITLE);

		// Delegate should still be visible after toggle cycle
		await expect(
			page.getByText(DELEGATE_TITLE, { exact: true }).first(),
		).toBeVisible({ timeout: 10_000 });
	});

	test("archived delegate not visible when Show Archived is off", async ({ page }) => {
		const PARENT_TITLE = "SB00b-ParentB";
		const DELEGATE_TITLE = "SB00b-DelegateB";

		// 1. Create parent + delegate, archive the delegate
		const parentId = await createSession();
		cleanupSessionIds.push(parentId);
		await waitForSessionStatus(parentId, "idle");
		await renameSession(parentId, PARENT_TITLE);

		const delegateId = await createDelegate(parentId);
		cleanupSessionIds.push(delegateId);
		await waitForSessionStatus(delegateId, "idle");
		await renameSession(delegateId, DELEGATE_TITLE);

		await terminateSession(delegateId);

		// 2. Open the app without enabling Show Archived
		await openApp(page);
		await navigateToHash(page, `#/session/${parentId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// 3. Wait for the parent row to render as a positive sentinel that the
		// sidebar has populated (archived toggle is off, so parent is live).
		await expect(page.getByText(PARENT_TITLE, { exact: true }).first()).toBeVisible({ timeout: 10_000 });

		// 4. The archived delegate title should NOT appear in the sidebar
		await expect(page.getByText(DELEGATE_TITLE, { exact: true })).toHaveCount(0, { timeout: 3_000 });

		// Cleanup
		await terminateSession(parentId);
	});
});
