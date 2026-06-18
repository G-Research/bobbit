/**
 * Sidebar navigation E2E smoke — the row-selection/team/dashboard matrix now lives in
 * tests/ui-fixtures/sidebar-navigation-fixture.spec.ts.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import {
	createSession,
	deleteSession,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

async function waitForActiveSessionReady(page: Page, sessionId: string): Promise<void> {
	await expect.poll(
		() => page.evaluate((id) => {
			const state = (window as any).__bobbitState;
			const visibleActiveSessionIds = Array.from(
				document.querySelectorAll<HTMLElement>("[data-session-id][data-nav-active='true']"),
			)
				.filter((row) => row.getClientRects().length > 0)
				.map((row) => row.getAttribute("data-session-id"));
			return {
				hash: window.location.hash,
				selectedSessionId: state?.selectedSessionId ?? null,
				connectingSessionId: state?.connectingSessionId ?? null,
				remoteSessionId: state?.remoteAgent?.gatewaySessionId ?? null,
				connectionStatus: state?.connectionStatus ?? null,
				storedSessionId: localStorage.getItem("gateway.sessionId"),
				visibleActiveSessionIds,
				hasComposer: Boolean(document.querySelector("message-editor textarea, textarea")),
			};
		}, sessionId),
		{ timeout: 15_000, intervals: [50, 100, 250, 500] },
	).toEqual({
		hash: `#/session/${sessionId}`,
		selectedSessionId: sessionId,
		connectingSessionId: null,
		remoteSessionId: sessionId,
		connectionStatus: "connected",
		storedSessionId: sessionId,
		visibleActiveSessionIds: [sessionId],
		hasComposer: true,
	});
}

async function clickSessionRow(page: Page, sessionId: string): Promise<void> {
	const row = page.locator(`[data-session-id="${sessionId}"]`).first();
	await expect(row).toBeVisible({ timeout: 10_000 });
	await row.click();
}

async function rapidlyClickSessionRows(page: Page, sessionIdsToClick: string[]): Promise<void> {
	for (const sessionId of sessionIdsToClick) {
		await expect(page.locator(`[data-session-id="${sessionId}"]`).first()).toBeVisible({ timeout: 10_000 });
	}
	await page.evaluate((ids) => {
		for (const id of ids) {
			const row = document.querySelector<HTMLElement>(`[data-session-id="${id}"]`);
			if (!row) throw new Error(`Session row not found for ${id}`);
			row.click();
		}
	}, sessionIdsToClick);
}

test.describe("Sidebar navigation", () => {
	const sessionIds: string[] = [];

	test.afterAll(async () => {
		for (const sid of sessionIds) await deleteSession(sid).catch(() => {});
	});

	test("SB-01/SB-04: session navigation highlights active row and rapid switching settles on last @smoke", async ({ page }) => {
		const idA = await createSession();
		const idB = await createSession();
		const idC = await createSession();
		sessionIds.push(idA, idB, idC);
		await waitForSessionStatus(idA, "idle");
		await waitForSessionStatus(idB, "idle");
		await waitForSessionStatus(idC, "idle");

		await openApp(page);

		await clickSessionRow(page, idA);
		await waitForActiveSessionReady(page, idA);

		await clickSessionRow(page, idB);
		await waitForActiveSessionReady(page, idB);

		await rapidlyClickSessionRows(page, [idA, idB, idC]);
		await waitForActiveSessionReady(page, idC);
	});
});
