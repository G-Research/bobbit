import { test, expect } from "@playwright/test";
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/settings-models-tab.html");
const BUNDLE = path.resolve("tests/fixtures/settings-models-tab-bundle.js");
const ENTRY = path.resolve("tests/fixtures/settings-models-tab-entry.ts");
const SETTINGS_SRC = path.resolve("src/app/settings-page.ts");
const DIALOG_SRC = path.resolve("src/ui/dialogs/AigwModelsDialog.ts");

test.beforeAll(async () => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(SETTINGS_SRC).mtimeMs,
		fs.statSync(DIALOG_SRC).mtimeMs,
	);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		await esbuild.build({
			entryPoints: [ENTRY],
			bundle: true,
			format: "iife",
			target: "es2022",
			outfile: BUNDLE,
			tsconfig: "tsconfig.web.json",
			define: { "import.meta.url": '"http://localhost/"' },
			loader: { ".ts": "ts" },
		});
	}
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 15_000 });
}

const AIGW_MODELS = [
	{ id: "aws/us.anthropic.claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, maxTokens: 8192, reasoning: false },
	{ id: "aws/us.anthropic.claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200_000, maxTokens: 8192, reasoning: true },
];
const ALL_MODELS = [
	{ id: "us.anthropic.claude-haiku-4-5", provider: "aigw", reasoning: false },
	{ id: "us.anthropic.claude-sonnet-4-5", provider: "aigw", reasoning: true },
];

test.describe("Settings Models tab redesign", () => {
	test("section ordering: AI Gateway before Default Models", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((opts) => (window as any).__resetModelsTab(opts), {
			aigwConfigured: true,
			aigwUrl: "http://dummy/v1",
			aigwModels: AIGW_MODELS,
			allModels: ALL_MODELS,
		});

		const aigwBox = page.locator('[data-testid="aigw-section"]');
		const defaultsBox = page.locator('[data-testid="defaults-section"]');
		await expect(aigwBox).toBeVisible();
		await expect(defaultsBox).toBeVisible();

		// Assert DOM order: aigw appears before defaults in document order.
		const order = await page.evaluate(() => {
			const a = document.querySelector('[data-testid="aigw-section"]')!;
			const d = document.querySelector('[data-testid="defaults-section"]')!;
			const pos = a.compareDocumentPosition(d);
			// DOCUMENT_POSITION_FOLLOWING = 4 → d follows a → aigw is first.
			return (pos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
		});
		expect(order).toBe(true);
	});

	test("Unavailable badge + Clear X for stale pref", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((opts) => (window as any).__resetModelsTab(opts), {
			aigwConfigured: true,
			aigwUrl: "http://dummy/v1",
			aigwModels: AIGW_MODELS,
			allModels: ALL_MODELS,
			prefReviewModel: "aigw/aws/us.anthropic.claude-stale", // not in allModels
		});

		const badges = page.locator('[data-testid="model-unavailable-badge"]');
		await expect(badges).toHaveCount(1);
		// And the Clear X for the Review row exists.
		const reviewRow = page.locator('[data-row-label="Review"]');
		await expect(reviewRow.locator('[data-testid="model-clear-btn"]')).toBeVisible();
	});

	test("Clear button resets the pref value", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((opts) => (window as any).__resetModelsTab(opts), {
			aigwConfigured: true,
			aigwModels: AIGW_MODELS,
			allModels: ALL_MODELS,
			prefSessionModel: "aigw/us.anthropic.claude-sonnet-4-5",
		});

		// Arrange the fetch stub so the savePref PUT succeeds.
		await page.evaluate(() => {
			(window as any).__setNextFetchResponse({ ok: true, body: { ok: true } });
			(window as any).__clearFetchLog();
		});

		const sessionRow = page.locator('[data-row-label="Session"]');
		const clearBtn = sessionRow.locator('[data-testid="model-clear-btn"]');
		await expect(clearBtn).toBeVisible();
		await clearBtn.click();

		// After clear, the row should re-render without a Clear button (pref is empty).
		await expect(sessionRow.locator('[data-testid="model-clear-btn"]')).toHaveCount(0);

		const log = await page.evaluate(() => (window as any).__getFetchLog());
		const prefWrites = log.filter((e: any) => e.url === "/api/preferences" && e.method === "PUT");
		expect(prefWrites.length).toBeGreaterThanOrEqual(1);
		expect(prefWrites[prefWrites.length - 1].body).toMatchObject({ "default.sessionModel": null });
	});

	test("Test button invokes /api/models/test and shows result", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((opts) => (window as any).__resetModelsTab(opts), {
			aigwConfigured: true,
			aigwModels: AIGW_MODELS,
			allModels: ALL_MODELS,
			prefReviewModel: "aigw/us.anthropic.claude-haiku-4-5",
		});

		// Stub the /api/models/test response to a success.
		await page.evaluate(() => {
			(window as any).__setNextFetchResponse((url: string) => {
				if (url === "/api/models/test") return { ok: true, body: { ok: true, modelResolved: "aws/us.anthropic.claude-haiku-4-5", latencyMs: 123 } };
				return { ok: true, body: {} };
			});
			(window as any).__clearFetchLog();
		});

		const reviewRow = page.locator('[data-row-label="Review"]');
		const testBtn = reviewRow.locator('[data-testid="model-test-btn"]');
		await expect(testBtn).toBeVisible();
		await testBtn.click();

		// Result text should appear.
		await expect(reviewRow.locator('[data-testid="model-test-result"]')).toContainText(/Test OK/);

		const log = await page.evaluate(() => (window as any).__getFetchLog());
		const testCalls = log.filter((e: any) => e.url === "/api/models/test");
		expect(testCalls).toHaveLength(1);
		expect(testCalls[0].method).toBe("POST");
		expect(testCalls[0].body).toEqual({ pref: "aigw/us.anthropic.claude-haiku-4-5" });
	});

	test("View available models… button renders and dispatches", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((opts) => (window as any).__resetModelsTab(opts), {
			aigwConfigured: true,
			aigwModels: AIGW_MODELS,
			allModels: ALL_MODELS,
		});

		const viewBtn = page.locator('[data-testid="view-aigw-models-btn"]');
		await expect(viewBtn).toBeVisible();
		await expect(viewBtn).toContainText(/View available models/);

		// Clicking should mount the <aigw-models-dialog> custom element into the body.
		await viewBtn.click();
		await page.waitForFunction(() => !!document.querySelector("aigw-models-dialog"), null, { timeout: 2000 });
		const dialogExists = await page.evaluate(() => !!document.querySelector("aigw-models-dialog"));
		expect(dialogExists).toBe(true);
	});
});
