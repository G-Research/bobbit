/**
 * True end-to-end test: real UI in a real browser, mock agent backend.
 *
 * Flow: open app → create session → send message → verify response renders →
 *       optionally screenshot → terminate session.
 */
import { test, expect } from "@playwright/test";
import { openApp, apiFetch, pollUntil } from "./fullstack-setup.js";

// Allow opt-in screenshots via env: SCREENSHOT=1 npx playwright test ...
const SCREENSHOT = process.env.SCREENSHOT === "1";

test.describe("Session lifecycle (full-stack)", () => {
	test("create session, send message, see response, terminate", async ({ page }) => {
		// ── 1. Open the app (fresh state — no sessions) ─────────────
		await openApp(page);

		// ── 2. Create a new session via the sidebar button ──────────
		const newSessionBtn = page.locator("button[title='New session']").first();
		await newSessionBtn.click();

		// Wait for the message editor textarea to appear — means the
		// session was created and we're connected.
		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 15_000 });

		// ── 3. Send a message ───────────────────────────────────────
		await textarea.fill("Hello from the fullstack test");
		await textarea.press("Enter");

		// ── 4. Wait for the agent response to render ────────────────
		// The mock agent replies with "OK" for generic messages.
		// The user message is inside a collapsible, so "OK" standing
		// alone is the assistant reply. Use a text locator.
		await expect(
			page.getByText("OK", { exact: true }).first(),
		).toBeVisible({ timeout: 15_000 });

		// Verify the session moved back to idle (agent finished).
		// Poll the REST API rather than relying on UI indicators.
		let sessionId: string | undefined;
		const sessionsResp = await apiFetch("/api/sessions");
		const sessionsData = await sessionsResp.json();
		const sessions = sessionsData.sessions || [];
		expect(sessions.length).toBeGreaterThanOrEqual(1);
		sessionId = sessions[0].id;

		await pollUntil(page, async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			const data = await resp.json();
			return data.status === "idle";
		});

		// ── 5. Optional screenshot ──────────────────────────────────
		if (SCREENSHOT) {
			await page.screenshot({
				path: `tests/fullstack/screenshots/session-with-response.png`,
				fullPage: true,
			});
		}

		// ── 6. Terminate the session via the REST API ───────────────
		// Using the API avoids dealing with the confirm dialog, keeping
		// the test focused on UI rendering rather than dialog mechanics.
		const delResp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "DELETE",
		});
		expect(delResp.ok).toBe(true);

		// Wait for the session to disappear from the sidebar.
		// The sidebar polls sessions every few seconds, but we can
		// trigger a faster update by navigating.
		await pollUntil(page, async () => {
			const resp = await apiFetch("/api/sessions");
			const data = await resp.json();
			const remaining = (data.sessions || []).filter(
				(s: { id: string }) => s.id === sessionId,
			);
			return remaining.length === 0;
		});

		// The textarea should no longer be visible since the session is gone.
		// Allow time for the UI to react to the session disappearing.
		await expect(textarea).not.toBeVisible({ timeout: 10_000 });
	});
});
