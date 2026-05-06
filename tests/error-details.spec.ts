/**
 * Unit fixture tests for the shared `<error-details>` component used inside
 * dialogs/modals (introduced by the symlink + error UX hardening goal).
 *
 * Verified contract:
 *  - Always renders the human-readable message.
 *  - Renders a muted monospace code line iff `code` is set.
 *  - Renders a collapsed `<details>` "Show stack trace" disclosure iff
 *    `stack` is set; the `<pre>` child contains the stack text.
 *
 * NOTE: The fixture mirrors `src/ui/components/ErrorDetails.ts` in plain JS
 * (mirrors the same DOM shape). Behaviour parity must be kept manually if
 * the source structure changes — same pattern as the BgProcessPill /
 * AskUserChoices fixtures.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/error-details.html").replace(/\\/g, "/")}`;

test.describe("<error-details>", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("renders message + no <details> when stack is undefined", async ({ page }) => {
		await page.evaluate(() => (window as any).mount({ message: "Something broke" }));
		await expect(page.locator('[data-testid="error-details-message"]')).toHaveText("Something broke");
		await expect(page.locator('[data-testid="error-details-stack"]')).toHaveCount(0);
		await expect(page.locator("details")).toHaveCount(0);
		await expect(page.locator("pre")).toHaveCount(0);
	});

	test("renders <details> collapsed when stack is provided; <pre> contains stack text", async ({ page }) => {
		const stack = "Error: boom\n    at frob (foo.ts:42:10)\n    at <anonymous>";
		await page.evaluate((s) => (window as any).mount({ message: "Crashed", stack: s }), stack);
		const det = page.locator('[data-testid="error-details-stack"]');
		await expect(det).toHaveCount(1);
		// Collapsed by default (no `open` attribute).
		const isOpen = await det.evaluate((el) => (el as HTMLDetailsElement).open);
		expect(isOpen).toBe(false);
		// <pre> exists and contains the stack text.
		const pre = det.locator("pre");
		await expect(pre).toHaveCount(1);
		await expect(pre).toContainText("Error: boom");
		await expect(pre).toContainText("frob (foo.ts:42:10)");
	});

	test("renders code line when code is provided; omits when undefined", async ({ page }) => {
		await page.evaluate(() => (window as any).mount({ message: "Auth failed", code: "ERR_UNAUTHORIZED" }));
		await expect(page.locator('[data-testid="error-details-code"]')).toHaveText("ERR_UNAUTHORIZED");
		// Now mount without code → code line absent.
		await page.evaluate(() => (window as any).mount({ message: "Other failure" }));
		await expect(page.locator('[data-testid="error-details-code"]')).toHaveCount(0);
	});

	test("user can expand the disclosure and see the stack", async ({ page }) => {
		await page.evaluate(() => (window as any).mount({ message: "Crashed", stack: "TRACE-LINE-1\nTRACE-LINE-2" }));
		const summary = page.locator('[data-testid="error-details-stack"] summary');
		await summary.click();
		const isOpen = await page.locator('[data-testid="error-details-stack"]').evaluate((el) => (el as HTMLDetailsElement).open);
		expect(isOpen).toBe(true);
	});

	test("escapes HTML in message/code/stack (no injection)", async ({ page }) => {
		await page.evaluate(() => (window as any).mount({
			message: "<script>boom</script>",
			code: "<b>code</b>",
			stack: "<img onerror=x>",
		}));
		// No injected children — text content shows the literal markup.
		await expect(page.locator('[data-testid="error-details-message"]')).toHaveText("<script>boom</script>");
		await expect(page.locator('[data-testid="error-details-code"]')).toHaveText("<b>code</b>");
		await expect(page.locator('[data-testid="error-details-stack"] pre')).toContainText("<img onerror=x>");
		// Confirm no actual <script>/<img> elements were created from the inputs.
		const injectedScripts = await page.locator('[data-testid="error-details-message"] script').count();
		expect(injectedScripts).toBe(0);
	});
});
