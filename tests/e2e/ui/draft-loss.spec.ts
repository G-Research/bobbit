/** Browser E2E coverage for prompt draft persistence across session switches and hard reloads. */
import { test, expect } from "../gateway-harness.js";
import { createSession, waitForHealth, waitForSessionStatus, apiFetch, deleteSession } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

async function navigateToSession(page: import("@playwright/test").Page, sessionId: string): Promise<void> {
	await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
}

async function waitForAppShell(page: import("@playwright/test").Page): Promise<void> {
	await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
}

test.describe("Draft persistence bugs", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("draft survives send→switch→reload, immediate hard reload, and late restore", async ({ page }) => {
		const sessionA = await createSession();
		const sessionB = await createSession();
		const sessionC = await createSession();
		const sessionD = await createSession();
		let releaseDelayedDraftRestore: (() => void) | undefined;
		let delayedDraftRestoreReleased = false;
		const releaseDelayedRestoreIfNeeded = () => {
			if (delayedDraftRestoreReleased) return;
			delayedDraftRestoreReleased = true;
			releaseDelayedDraftRestore?.();
		};
		try {
			await Promise.all([sessionA, sessionB, sessionC, sessionD].map((id) => waitForSessionStatus(id, "idle")));
			await openApp(page);

			// Scenario 1: after sending in A, switching away and back must not make
			// the next saved draft look stale compared with draft-send-gen.
			await navigateToSession(page, sessionA);
			await sendMessage(page, "hello agent");
			await waitForAgentResponse(page, { timeout: 15_000 });
			const sendGen = await page.evaluate((id) => parseInt(sessionStorage.getItem(`draft-send-gen-${id}`) || "0", 10), sessionA);
			expect(sendGen).toBeGreaterThan(0);

			await navigateToSession(page, sessionB);
			await navigateToSession(page, sessionA);
			const draftAfterSwitch = "important draft after switch";
			await page.locator("textarea").first().fill(draftAfterSwitch);
			const manualGen = 1;
			await apiFetch(`/api/sessions/${sessionA}/draft`, {
				method: "PUT",
				body: JSON.stringify({ type: "prompt", data: { text: draftAfterSwitch, gen: manualGen } }),
			});
			expect(manualGen).toBeLessThanOrEqual(sendGen);

			await page.reload();
			await waitForAppShell(page);
			await navigateToSession(page, sessionA);
			await expect(async () => {
				const val = await page.locator("textarea").first().inputValue();
				expect(val).toBe(draftAfterSwitch);
			}).toPass({ intervals: [500, 1000, 1000, 2000], timeout: 10_000 });

			// Scenario 2: an immediate hard reload in the same JS tick as typing
			// must still flush the prompt draft via beforeunload/sendBeacon.
			await navigateToSession(page, sessionC);
			await page.waitForFunction(() => {
				const ta = document.querySelector("textarea");
				const me = document.querySelector("message-editor");
				return !!ta && !!me;
			}, null, { timeout: 5_000 });
			const hardReloadDraft = "draft lost on immediate reload";
			await page.evaluate((text) => {
				const textarea = document.querySelector("textarea");
				if (!textarea) throw new Error("No textarea");
				textarea.value = text;
				textarea.dispatchEvent(new Event("input", { bubbles: true }));
				window.location.reload();
			}, hardReloadDraft);

			await waitForAppShell(page);
			await navigateToSession(page, sessionC);
			await expect(async () => {
				const val = await page.locator("textarea").first().inputValue();
				expect(val).toBe(hardReloadDraft);
			}).toPass({ intervals: [250, 500, 1000, 1000, 2000, 2000], timeout: 20_000 });

			// Scenario 3: autosave must be bound before the editor becomes
			// interactive. A delayed stale server restore must not overwrite a fresh
			// local draft typed during first paint/initial navigation.
			const staleServerDraft = "stale server draft from slow restore";
			const freshLocalDraft = "fresh local draft typed before restore returns";
			await apiFetch(`/api/sessions/${sessionD}/draft`, {
				method: "PUT",
				body: JSON.stringify({ type: "prompt", data: { text: staleServerDraft, gen: 1 } }),
			});

			let delayedRestoreSeen = false;
			let delayedRestoreHandled = false;
			let resolveDelayedRestoreResponse!: () => void;
			const delayedRestoreResponse = new Promise<void>((resolve) => { resolveDelayedRestoreResponse = resolve; });
			let releaseRestore!: () => void;
			const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
			releaseDelayedDraftRestore = releaseRestore;
			delayedDraftRestoreReleased = false;
			const matchDelayedPromptDraft = (url: URL) =>
				url.pathname === `/api/sessions/${sessionD}/draft` && url.searchParams.get("type") === "prompt";
			const delayedPromptDraftRoute = async (
				route: import("@playwright/test").Route,
				request: import("@playwright/test").Request,
			) => {
				if (request.method() !== "GET" || delayedRestoreHandled) {
					await route.fallback();
					return;
				}
				delayedRestoreHandled = true;
				delayedRestoreSeen = true;
				try {
					await restoreGate;
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: JSON.stringify({ type: "prompt", data: { text: staleServerDraft, gen: 1 } }),
					});
				} finally {
					resolveDelayedRestoreResponse();
				}
			};
			await page.route(matchDelayedPromptDraft, delayedPromptDraftRoute);

			await navigateToSession(page, sessionD);
			const textarea = page.locator("textarea").first();
			await expect(textarea).toBeEditable({ timeout: 15_000 });
			await textarea.fill(freshLocalDraft);
			await expect(async () => {
				expect(delayedRestoreSeen).toBe(true);
			}).toPass({ intervals: [100, 250, 500, 1000], timeout: 10_000 });
			releaseDelayedRestoreIfNeeded();
			await delayedRestoreResponse;
			await page.unroute(matchDelayedPromptDraft, delayedPromptDraftRoute);

			await expect(textarea).toHaveValue(freshLocalDraft, { timeout: 5_000 });
			await expect(async () => {
				const resp = await apiFetch(`/api/sessions/${sessionD}/draft?type=prompt`);
				expect(resp.ok).toBe(true);
				const body = await resp.json() as { data?: { text?: string } };
				expect(body.data?.text).toBe(freshLocalDraft);
			}).toPass({ intervals: [250, 500, 1000, 1000, 2000], timeout: 15_000 });
		} finally {
			releaseDelayedRestoreIfNeeded();
			await Promise.all([sessionA, sessionB, sessionC, sessionD].map((id) => deleteSession(id).catch(() => { /* best-effort */ })));
		}
	});
});
