import { test, expect } from "@playwright/test";
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const FIXTURE_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 30_000;

test.setTimeout(FIXTURE_TIMEOUT_MS);

async function renameWithRetry(src: string, dest: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			fs.renameSync(src, dest);
			return;
		} catch (err) {
			lastErr = err;
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw err;
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	throw lastErr;
}

const FIXTURE = path.resolve("tests/fixtures/settings-models-tab.html");
const BUNDLE = path.resolve("tests/fixtures/settings-models-tab-bundle.js");
const ENTRY = path.resolve("tests/fixtures/settings-models-tab-entry.ts");
const SETTINGS_SRC = path.resolve("src/app/settings-page.ts");
const DIALOG_SRC = path.resolve("src/ui/dialogs/AigwModelsDialog.ts");

test.beforeAll(async () => {
	// Full-suite browser fixture runs can be CPU/IO constrained while multiple
	// esbuild-backed fixtures initialize concurrently. Keep the fixture-level
	// budget above the global 15s default so a valid cold build is not flaky.
	test.setTimeout(FIXTURE_TIMEOUT_MS);
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(SETTINGS_SRC).mtimeMs,
		fs.statSync(DIALOG_SRC).mtimeMs,
	);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		// Multiple Playwright workers run this beforeAll concurrently and share
		// the same on-disk bundle path. esbuild's outfile write is not atomic
		// (open→truncate→stream→close), so a sibling worker's page.goto can
		// load a partially-written bundle that throws before setting
		// `window.__ready = true`, causing a 15s waitForFunction timeout.
		//
		// Build to a unique tmp path then rename — rename is atomic on POSIX
		// and replaces in-place on Windows, so concurrent readers see either
		// the prior bundle or the new one, never a truncated mix.
		// Build into a unique tmp directory so the sibling .css file esbuild
		// emits alongside the JS bundle is also isolated from the shared path.
		const tmpDir = fs.mkdtempSync(path.join(path.dirname(BUNDLE), ".bundle-tmp-"));
		const tmpOut = path.join(tmpDir, path.basename(BUNDLE));
		const tmpCss = tmpOut.replace(/\.js$/, ".css");
		const finalCss = BUNDLE.replace(/\.js$/, ".css");
		try {
			await esbuild.build({
				entryPoints: [ENTRY],
				bundle: true,
				format: "iife",
				target: "es2022",
				outfile: tmpOut,
				tsconfig: "tsconfig.web.json",
				define: { "import.meta.url": '"http://localhost/"' },
				loader: { ".ts": "ts" },
			});
			// Windows: rename over a destination another worker has currently
			// loaded via page.goto raises EPERM. Retry briefly — the loading
			// worker releases the handle within a few hundred ms once its page
			// has parsed the bundle.
			await renameWithRetry(tmpOut, BUNDLE);
			if (fs.existsSync(tmpCss)) await renameWithRetry(tmpCss, finalCss);
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
		}
	}
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	const pageErrors: string[] = [];
	page.on("pageerror", (err: Error) => pageErrors.push(err.stack || err.message));
	const startedAt = Date.now();
	try {
		await page.goto(PAGE, { timeout: READY_TIMEOUT_MS });
		await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: READY_TIMEOUT_MS });
	} catch (err) {
		const diagnostics = await page.evaluate(() => ({
			ready: (window as any).__ready,
			bodyText: document.body?.innerText ?? "",
			scripts: Array.from(document.scripts).map((script) => script.src),
		})).catch((evalErr: Error) => ({ evalError: evalErr.message }));
		const bundleStat = (() => {
			try {
				const stat = fs.statSync(BUNDLE);
				return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
			} catch (statErr) {
				return { exists: false, error: (statErr as Error).message };
			}
		})();
		throw new Error([
			`Settings models fixture did not become ready after ${Date.now() - startedAt}ms: ${(err as Error).message}`,
			`page=${PAGE}`,
			`bundle=${JSON.stringify(bundleStat)}`,
			`pageErrors=${JSON.stringify(pageErrors)}`,
			`diagnostics=${JSON.stringify(diagnostics)}`,
		].join("\n"));
	}
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

	test("Claude Code executable confirmation uses browser credentials", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((opts) => (window as any).__resetModelsTab(opts), {
			allModels: ALL_MODELS,
			claudeCodeStatus: {
				available: true,
				authenticated: false,
				ready: true,
				checking: false,
				commandPath: "claude",
				modelAliases: ["claude-opus-4-8", "default", "sonnet", "opus"],
			},
		});
		await page.evaluate(() => {
			(window as any).__setNextFetchResponse((url: string) => {
				if (url === "/api/preferences/claude-code/confirmation") return { ok: true, body: { confirmationRequired: true, confirmationToken: "fixture-token" } };
				return { ok: true, body: { ok: true } };
			});
			(window as any).__clearFetchLog();
		});

		const section = page.locator('[data-testid="claude-code-section"]');
		await section.locator('[data-testid="claude-code-executable"]').fill("/opt/bin/claude");
		await section.locator('[data-testid="claude-code-executable"]').blur();
		await page.getByRole("button", { name: "Change executable" }).click();

		await expect.poll(async () => {
			const log = await page.evaluate(() => (window as any).__getFetchLog());
			return log.find((e: any) => e.url === "/api/preferences/claude-code/confirmation");
		}).toMatchObject({ method: "POST", credentials: "include", body: { "claudeCode.executablePath": "/opt/bin/claude" } });
		await expect.poll(async () => {
			const log = await page.evaluate(() => (window as any).__getFetchLog());
			return log.find((e: any) => e.url === "/api/preferences" && e.method === "PUT");
		}).toMatchObject({ credentials: "include", body: { "claudeCode.executablePath": "/opt/bin/claude" } });
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

	// Settings-drift acceptance: the live Models tab must expose a Provider API
	// Keys entry point (the API-key fallback) so users are not directed to a
	// nonexistent screen. The Google AI Studio key path (`google`) must be present.
	test("Provider API Keys section is discoverable with a Google key input", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((opts) => (window as any).__resetModelsTab(opts), {
			aigwConfigured: false,
			allModels: ALL_MODELS,
		});

		const section = page.locator('[data-testid="provider-keys-section"]');
		await expect(section).toBeVisible();
		await expect(section).toContainText(/Provider API Keys/);
		await expect(section).toContainText(/Google AI Studio/);

		// The Google AI Studio key input wrapper + its provider-key-input element render.
		const googleKey = page.locator('[data-testid="provider-key-input-google"]');
		await expect(googleKey).toBeVisible();
		await expect(googleKey.locator("provider-key-input")).toHaveCount(1);
		// The component renders its (capitalized) provider name in the label.
		await expect(googleKey).toContainText(/google/i);

		// OpenRouter key input wrapper + its provider-key-input element render too.
		const openrouterKey = page.locator('[data-testid="provider-key-input-openrouter"]');
		await expect(openrouterKey).toBeVisible();
		await expect(openrouterKey.locator("provider-key-input")).toHaveCount(1);
		await expect(openrouterKey).toContainText(/openrouter/i);

		// Provider API Keys appears after Default Models in document order.
		const order = await page.evaluate(() => {
			const d = document.querySelector('[data-testid="defaults-section"]')!;
			const k = document.querySelector('[data-testid="provider-keys-section"]')!;
			return (d.compareDocumentPosition(k) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
		});
		expect(order).toBe(true);
	});
});
