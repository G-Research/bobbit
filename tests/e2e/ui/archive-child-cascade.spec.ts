/**
 * Browser E2E — Sub-goal B: non-goal archive confirmation modal + cascade-reap.
 *
 * OrchestrationCore §6 / §6.1. Covers:
 *   (a) Archiving a NON-GOAL (plain) session that has spawned child agents shows
 *       a confirmation modal that NAMES the children: "This will also archive
 *       its N child agent(s)." (enumerated via GET /api/sessions/:id/children-count).
 *   (b) After confirming, the children are cascade-archived — they leave the
 *       live session list and appear in the "include=archived" surface, with
 *       parity to today's team-shutdown child archival (no new badge).
 *   (c) A childless plain session shows NO child-cascade note (the enumeration
 *       is conditional + scoped to the non-goal path).
 *
 * The flow drives the real non-goal terminate path (the sidebar "Terminate"
 * action → terminateSession() → confirmAction() → DELETE /api/sessions/:id),
 * NOT the separate goal-archival path in src/app/api.ts (which enumerates
 * affected sessions itself and is intentionally left untouched by sub-goal B).
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	createSession,
	deleteSession,
	waitForSessionStatus,
	nonGitCwd,
} from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

async function createDelegate(parentId: string, title: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ delegateOf: parentId, instructions: title, cwd: nonGitCwd() }),
	});
	expect(resp.status).toBe(201);
	return (await resp.json()).id;
}

function sessionRow(page: Page, sessionId: string): Locator {
	return page.locator(`[data-session-id="${sessionId}"]`).first();
}

async function openTerminateModal(page: Page, sessionId: string): Promise<void> {
	const row = sessionRow(page, sessionId);
	await expect(row).toBeVisible({ timeout: 10_000 });
	await row.hover();
	const trigger = row
		.locator(`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-kind="session"][data-sidebar-actions-id="${sessionId}"]`)
		.first();
	await expect(trigger, "session hamburger should appear on hover").toBeVisible({ timeout: 5_000 });
	await trigger.click();
	await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
	const terminateItem = page.locator(`sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="terminate"]`).first();
	await expect(terminateItem).toBeVisible({ timeout: 5_000 });
	await terminateItem.click();
}

/** The confirmAction dialog body paragraph. */
function confirmBody(page: Page): Locator {
	return page.locator("p.text-muted-foreground").filter({ hasText: /Are you sure you want to terminate/ }).first();
}

async function liveSessionIds(): Promise<string[]> {
	const resp = await apiFetch("/api/sessions");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	return (body.sessions as Array<{ id: string }>).map((s) => s.id);
}

async function archivedSessionIds(): Promise<string[]> {
	const resp = await apiFetch("/api/sessions?include=archived&limit=200");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	const ids = new Set<string>();
	for (const s of (body.sessions as Array<{ id: string; archived?: boolean }>)) if (s.archived) ids.add(s.id);
	for (const s of ((body.archivedDelegates ?? []) as Array<{ id: string }>)) ids.add(s.id);
	return [...ids];
}

test.describe("Non-goal archive cascade + confirmation modal (UI)", () => {
	const cleanupSessionIds: string[] = [];

	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
	});

	test.afterAll(async () => {
		for (const id of cleanupSessionIds.splice(0)) await deleteSession(id).catch(() => {});
	});

	test("modal lists child agents; confirm cascade-archives them", async ({ page }) => {
		// 1. Plain (non-goal) parent + two delegate children.
		const parentId = await createSession();
		cleanupSessionIds.push(parentId);
		await waitForSessionStatus(parentId, "idle");

		const childA = await createDelegate(parentId, "CascadeChildA");
		const childB = await createDelegate(parentId, "CascadeChildB");
		cleanupSessionIds.push(childA, childB);
		await waitForSessionStatus(childA, "idle");
		await waitForSessionStatus(childB, "idle");

		// 2. The children-count route (modal's authoritative source) reports 2.
		const ccResp = await apiFetch(`/api/sessions/${parentId}/children-count`);
		expect(ccResp.status).toBe(200);
		const cc = await ccResp.json();
		expect(cc.count, "children-count should report both delegate children").toBe(2);

		// 3. Open the app and trigger the parent's Terminate action.
		await openApp(page);
		await navigateToHash(page, `#/session/${parentId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await openTerminateModal(page, parentId);

		// 4. The confirmation modal NAMES the children that will be archived.
		const body = confirmBody(page);
		await expect(body).toBeVisible({ timeout: 10_000 });
		await expect(body).toContainText("This will also archive its 2 child agents.");

		// 5. Confirm (destructive "Terminate" button in the dialog footer).
		await page.getByRole("button", { name: "Terminate", exact: true }).last().click();

		// 6. Cascade: both children leave the live session list...
		await expect.poll(async () => {
			const live = await liveSessionIds();
			return live.includes(childA) || live.includes(childB) || live.includes(parentId);
		}, { timeout: 15_000 }).toBe(false);

		// 7. ...and surface under the archived listing (parity with team-shutdown
		//    child archival — same "show archived" surface, no new badge).
		await expect.poll(async () => {
			const archived = await archivedSessionIds();
			return archived.includes(childA) && archived.includes(childB);
		}, { timeout: 15_000 }).toBe(true);
	});

	test("childless plain session shows NO child-cascade note", async ({ page }) => {
		const soloId = await createSession();
		cleanupSessionIds.push(soloId);
		await waitForSessionStatus(soloId, "idle");

		const ccResp = await apiFetch(`/api/sessions/${soloId}/children-count`);
		expect(ccResp.status).toBe(200);
		expect((await ccResp.json()).count).toBe(0);

		await openApp(page);
		await navigateToHash(page, `#/session/${soloId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await openTerminateModal(page, soloId);

		const body = confirmBody(page);
		await expect(body).toBeVisible({ timeout: 10_000 });
		await expect(body).not.toContainText("child agent");

		// Dismiss without archiving (Cancel) — keeps cleanup simple.
		await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
	});
});
