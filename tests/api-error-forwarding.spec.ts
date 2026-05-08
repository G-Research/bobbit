/**
 * Unit fixture tests for the descriptive-API-error forwarding pattern in
 * `src/app/api.ts`. Verifies the contract documented in the
 * "Descriptive API Errors" design doc:
 *
 *   1. When the server returns a non-OK response with a structured body
 *      `{ error, code, stack }`, the matching `<error-details>` element
 *      inside the connection-error dialog must show:
 *        - the server's `error` text in `[data-testid=error-details-message]`
 *        - the server's `stack` inside `[data-testid=error-details-stack]`
 *        - never the fallback string "Failed to create goal: 400".
 *
 * The fixture stubs `window.fetch` to return the structured 400 body, then
 * calls `createGoal(...)` directly. The connection-error dialog is rendered
 * by the real production code path (api.ts → dialogs.ts → ErrorDetails).
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/api-error-forwarding.html");
const BUNDLE = path.resolve("tests/fixtures/api-error-forwarding-bundle.js");
const ENTRY = path.resolve("tests/fixtures/api-error-forwarding-entry.ts");
const API_SRC = path.resolve("src/app/api.ts");
const DIALOGS_SRC = path.resolve("src/app/dialogs.ts");
const ERR_DETAILS_SRC = path.resolve("src/ui/components/ErrorDetails.ts");

test.beforeAll(() => {
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, API_SRC, DIALOGS_SRC, ERR_DETAILS_SRC],
	});
});

const PAGE = `file://${FIXTURE.replace(/\\/g, "/")}`;

const STACK = "Error: Missing title\n    at handler (server.ts:3137:9)\n    at handleApiRoute (server.ts:42:5)";

test.describe("createGoal — descriptive error forwarding", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(PAGE);
		await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	});

	test("forwards server error/code/stack into connection-error modal", async ({ page }) => {
		await page.evaluate((stack) => {
			(window as any).__setFetchResponder(() => ({
				status: 400,
				body: { error: "Missing title", code: "bad_request", stack },
			}));
		}, STACK);

		const result = await page.evaluate(async () => {
			return await (window as any).__createGoal("", "/tmp", { projectId: "p1" });
		});
		expect(result).toBeNull();

		// Dialog renders; <error-details> shows the server's message + stack.
		const message = page.locator('[data-testid="error-details-message"]');
		await expect(message).toHaveText("Missing title");

		const code = page.locator('[data-testid="error-details-code"]');
		await expect(code).toHaveText("bad_request");

		const stackBlock = page.locator('[data-testid="error-details-stack"]');
		await expect(stackBlock).toHaveCount(1);
		const pre = stackBlock.locator("pre");
		await expect(pre).toContainText("Error: Missing title");
		await expect(pre).toContainText("handler (server.ts:3137:9)");
		await expect(pre).toContainText("handleApiRoute (server.ts:42:5)");

		// The fallback "Failed to create goal: 400" string must NOT appear
		// anywhere on the page.
		const bodyText = await page.locator("body").innerText();
		expect(bodyText).not.toContain("Failed to create goal: 400");
		expect(bodyText).not.toContain("Failed: 400");
	});

	test("falls back to status-code message ONLY when server returns no error body", async ({ page }) => {
		// Stub a 400 with empty body — the fallback path should kick in. This
		// guards against a regression where errorFromResponse() throws on
		// JSON parse instead of using the fallback string.
		await page.evaluate(() => {
			(window as any).__setFetchResponder(() => ({ status: 400, body: {} }));
		});

		const result = await page.evaluate(async () => {
			return await (window as any).__createGoal("x", "/tmp", { projectId: "p1" });
		});
		expect(result).toBeNull();

		// With an empty body, the fallback status-code message IS expected.
		// (The local thrown Error still has a JS stack — that's fine; the
		// point of this test is to pin the fallback-message branch.)
		await expect(page.locator('[data-testid="error-details-message"]'))
			.toHaveText("Failed to create goal: 400");
	});
});
