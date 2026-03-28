import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/workflow-panel-buttons.html")}`;

test.describe("Workflow panel button lifecycle", () => {
	test("Cancel (Done) on dedicated workflow assistant should delete the session", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => (window as any).__testDoneDeletesSession());

		// The current "Done" handler only calls backToSessions() which disconnects
		// but does NOT delete the session from the server via DELETE /api/sessions/:id.
		// This assertion verifies session deletion happened — it FAILS with the buggy code.
		expect(
			result.sessionDeleted,
			"BUG: workflow assistant session was not deleted — Done/Cancel handler must call DELETE /api/sessions/:id",
		).toBe(true);
	});

	test("Create Workflow (Save) should delete the session and navigate to workflows", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => (window as any).__testSaveDeletesSession());

		// The current "Save" handler only calls saveWorkflowFromPanel() but does NOT
		// delete the session or navigate to #/workflows.
		// These assertions verify the full lifecycle — they FAIL with the buggy code.
		expect(
			result.sessionDeleted,
			"BUG: workflow assistant session was not deleted — Save/Create handler must call DELETE /api/sessions/:id",
		).toBe(true);

		expect(
			result.navigatedToWorkflows,
			"BUG: did not navigate to workflows page after saving",
		).toBe(true);
	});
});
