/**
 * Browser E2E tests demonstrating draft persistence bugs.
 *
 * Bug 1 — Gen counter mismatch after session switch (PI-04b):
 *   _teardownDraftHandlers() resets _draftGen to 0, but _draftSendGen is
 *   loaded from sessionStorage. After sending a message (which sets a high
 *   _draftSendGen in sessionStorage), switching away and back resets _draftGen
 *   to 0. New saves get gen=1 which is <= the stored sendGen, so on reload
 *   the draft is rejected as "stale".
 *
 * Bug 2 — No beforeunload handler:
 *   Hard refresh kills in-flight fetches. If the 100ms debounce has fired but
 *   the fetch hasn't resolved, or if the debounce hasn't fired at all, the
 *   draft is lost. There is no beforeunload/sendBeacon fallback.
 */
import { test, expect } from "../gateway-harness.js";
import {
	createSession,
	waitForHealth,
	waitForSessionStatus,
	apiFetch,
} from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.describe("Draft persistence bugs", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("Bug 1: draft lost after send → session switch → type → reload (gen counter mismatch)", async ({ page }) => {
		// This demonstrates that after sending a message, switching sessions,
		// and typing a new draft, the draft is rejected on reload because the
		// gen counter resets but _draftSendGen (in sessionStorage) does not.
		const sessionA = await createSession();
		const sessionB = await createSession();
		await waitForSessionStatus(sessionA, "idle");
		await waitForSessionStatus(sessionB, "idle");

		await openApp(page);

		// Navigate to session A
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionA);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Send a message in session A — this sets _draftSendGen in sessionStorage
		await sendMessage(page, "hello agent");
		await waitForAgentResponse(page, { timeout: 15_000 });

		// Verify sessionStorage has a non-zero draft-send-gen for this session
		const sendGen = await page.evaluate((id) => {
			return parseInt(sessionStorage.getItem(`draft-send-gen-${id}`) || "0", 10);
		}, sessionA);
		expect(sendGen).toBeGreaterThan(0);

		// Switch to session B (this resets _draftGen to 0 via _teardownDraftHandlers)
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionB);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Switch back to session A (_draftGen starts from 0 again, but
		// _draftSendGen is loaded from sessionStorage as the high value)
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionA);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Type a new draft — use keyboard input to ensure the input event fires
		// through the real DOM path (fill may not trigger composed events).
		const draftText = "important draft after switch";
		const textarea = page.locator("textarea").first();
		await textarea.click();
		await textarea.fill(draftText);

		// Force a manual draft save via the server API so we can isolate the
		// load-side gen bug from the save-side timing. This simulates what
		// would happen if the debounced save succeeded.
		const manualGen = 1; // This is what _draftGen would be after reset
		await apiFetch(`/api/sessions/${sessionA}/draft`, {
			method: "PUT",
			body: JSON.stringify({ type: "prompt", data: { text: draftText, gen: manualGen } }),
		});

		// Verify: the draft gen on the server (1) is <= the sendGen in
		// sessionStorage. This is the mismatch that causes the load to
		// reject it as stale.
		expect(manualGen).toBeLessThanOrEqual(sendGen);

		// Reload the page
		await page.reload();

		// Wait for app to load
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// Navigate back to session A
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionA);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// The draft should be restored — but it won't be because gen <= sendGen
		await expect(async () => {
			const val = await page.locator("textarea").first().inputValue();
			expect(val).toBe(draftText);
		}).toPass({ intervals: [500, 1000, 1000, 2000], timeout: 10_000 });
	});

	test("Bug 2: draft lost on immediate hard reload (no beforeunload handler)", async ({ page }) => {
		// This demonstrates that a hard reload immediately after typing loses
		// the draft because the 100ms debounce hasn't fired yet and there's
		// no beforeunload handler to flush via sendBeacon.
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		// Navigate to session
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// The sendBeacon flush is wired up lazily the first time the editor
		// mounts. Small jitter here gives the beforeunload listener a chance
		// to attach — without it, the hard reload below can outrun the
		// listener registration on slow/parallel runs.
		await page.waitForFunction(() => {
			// The listener is installed inside session-manager.ts alongside the
			// _draftListenersInstalled flag; we can't see that flag directly,
			// but we can confirm the editor component is fully hydrated.
			const ta = document.querySelector("textarea");
			const me = document.querySelector("message-editor") as any;
			return !!ta && !!me;
		}, { timeout: 5_000 });

		// Type draft text and reload IMMEDIATELY — before the 100ms debounce fires.
		// Use page.evaluate to type + reload in the same JS tick to avoid any
		// Playwright inter-command delay that might let the debounce fire.
		const draftText = "draft lost on immediate reload";
		await page.evaluate((text) => {
			const textarea = document.querySelector("textarea");
			if (!textarea) throw new Error("No textarea");
			// Set value and fire input event (same as user typing)
			textarea.value = text;
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
			// Reload in the same tick — debounce timer hasn't fired yet
			window.location.reload();
		}, draftText);

		// Wait for app to reload
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// Navigate back to the session
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// The draft should be restored via the beforeunload sendBeacon. That
		// beacon fires fire-and-forget, so we give it a generous window for the
		// server to persist it + the UI to rehydrate the textarea on reload.
		await expect(async () => {
			const val = await page.locator("textarea").first().inputValue();
			expect(val).toBe(draftText);
		}).toPass({ intervals: [250, 500, 1000, 1000, 2000, 2000], timeout: 20_000 });
	});
});
