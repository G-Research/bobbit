/**
 * Browser E2E: clicking "+ New Role" on the Roles page creates a Role
 * Assistant session.
 *
 * Regression guard for the Role Assistant 400 bug: `createRoleAssistantSession`
 * used to POST `{ assistantType: "role" }` only, and the server unconditionally
 * required a project, returning 400 in directories that don't match a
 * registered project. Role/Tool/Staff assistants are server-scope config
 * editors and don't need a project — this test asserts the happy path works
 * end-to-end through the browser.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

test.describe("Roles page — + New Role creates a session", () => {
	test("clicking + New Role opens a Role Assistant session @smoke", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/roles");

		// "+ New Role" button — created via mini-lit Button with label "New Role".
		const newRoleBtn = page.locator("button").filter({ hasText: /New Role/ }).first();
		await expect(newRoleBtn).toBeVisible({ timeout: 10_000 });

		// Capture the session-creation POST so we can assert 201 instead of 400.
		const respPromise = page.waitForResponse(
			resp => resp.url().includes("/api/sessions") && resp.request().method() === "POST",
			{ timeout: 15_000 },
		);

		await newRoleBtn.click();

		const resp = await respPromise;
		expect(
			resp.status(),
			`POST /api/sessions for role assistant should succeed; got ${resp.status()}`,
		).toBe(201);

		// Hash transitions to a session route (#/session/<id>).
		await expect.poll(
			() => page.evaluate(() => window.location.hash),
			{ timeout: 10_000 },
		).toMatch(/^#\/session\//);

		// Chat textarea is the canonical "session is open" signal.
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		// No connection-error modal — the bug surfaced as
		// `showConnectionError("Failed to create role assistant", ...)`.
		await expect(page.getByText("Failed to create role assistant")).toHaveCount(0);
	});
});
