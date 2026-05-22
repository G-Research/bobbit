/** Consolidated Session interaction UI journey: create, send, switch, reload, delete. */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, apiFetch, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.describe("Session interactions (UI)", () => {
	test("create/send, switch sessions, survive reload, and clean up deleted session", async ({ page }) => {
		const created: string[] = [];
		try {
			await openApp(page);
			await createSessionViaUI(page);
			await sendMessage(page, "Hello from session interaction test");
			await waitForAgentResponse(page);
			await expect(page.getByText("OK", { exact: true }).first()).toBeVisible();

			const hash = await page.evaluate(() => window.location.hash);
			const sessionIdMatch = hash.match(/#\/session\/([a-f0-9-]+)/i);
			expect(sessionIdMatch).toBeTruthy();
			const uiSessionId = sessionIdMatch![1];
			created.push(uiSessionId);
			await waitForSessionStatus(uiSessionId, "idle");

			const apiSessionId = await createSession();
			created.push(apiSessionId);
			await waitForSessionStatus(apiSessionId, "idle");

			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, apiSessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
			expect(await page.evaluate(() => window.location.hash)).toContain(apiSessionId);

			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, uiSessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
			expect(await page.evaluate(() => window.location.hash)).toContain(uiSessionId);
			await expect(page.getByText("Hello from session interaction test").first()).toBeVisible({ timeout: 10_000 });

			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
			const resp = await apiFetch(`/api/sessions/${uiSessionId}`);
			expect(resp.ok).toBe(true);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, uiSessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
			await expect(page.getByText("Hello from session interaction test").first()).toBeVisible({ timeout: 10_000 });

			await deleteSession(uiSessionId);
			created.splice(created.indexOf(uiSessionId), 1);
			await page.evaluate(() => { window.location.hash = "#/"; });
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 10_000 });

			const sessionsResp = await apiFetch("/api/sessions");
			const sessions = ((await sessionsResp.json()).sessions || []);
			expect(sessions.find((s: { id: string }) => s.id === uiSessionId)).toBeFalsy();
		} finally {
			await Promise.all(created.map((id) => deleteSession(id).catch(() => { /* best-effort */ })));
		}
	});
});
