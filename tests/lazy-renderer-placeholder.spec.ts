/**
 * Unit tests for the lazy tool-renderer placeholder + resolve flow.
 *
 * Pattern (mirrors preview-renderer.spec.ts):
 *   - esbuild bundles `tests/fixtures/lazy-renderer-placeholder-entry.ts` once,
 *     a file:// fixture loads the bundle, and we drive the registry + Lit
 *     elements via window-exposed helpers.
 *
 * Acceptance criteria covered:
 *   1. Placeholder uses the standard card wrapper + a disabled "Loading…"
 *      button — no card-vs-no-card jump when the real renderer lands.
 *   2. `<tool-message>` re-renders on the `bobbit-tool-renderer-loaded` event
 *      even without a parent prop change.
 *   3. Loader rejection registers a fallback error renderer instead of
 *      leaving the placeholder forever.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/lazy-renderer-placeholder.html");
const BUNDLE = path.resolve("tests/fixtures/lazy-renderer-placeholder-bundle.js");
const ENTRY = path.resolve("tests/fixtures/lazy-renderer-placeholder-entry.ts");
const REGISTRY_SRC = path.resolve("src/ui/tools/renderer-registry.ts");
const MESSAGES_SRC = path.resolve("src/ui/components/Messages.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(REGISTRY_SRC).mtimeMs,
		fs.statSync(MESSAGES_SRC).mtimeMs,
	);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				"--alias:pdfjs-dist=./tests/fixtures/empty-shim",
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	await page.evaluate(() => {
		const c = document.getElementById("container")!;
		c.innerHTML = '<div id="slot"></div>';
	});
}

test.describe("Lazy tool renderer placeholder", () => {
	test("placeholder shows card + disabled button; resolves to real renderer in-place", async ({ page }) => {
		await gotoAndWait(page);

		await page.evaluate(() => {
			(window as any).__registerDeferredLazy("test_lazy_tool");
			(window as any).__mountToolMessage("slot", "test_lazy_tool", "tool-1");
		});

		// Placeholder phase: card wrapper present, disabled Loading button visible,
		// no real button yet.
		const card = page.locator("tool-message .border.rounded-md");
		await expect(card).toHaveCount(1);

		const loadingBtn = page.locator("tool-message [data-lazy-renderer-placeholder-btn]");
		await expect(loadingBtn).toHaveCount(1);
		await expect(loadingBtn).toBeDisabled();
		await expect(loadingBtn).toContainText(/Loading/);
		await expect(page.locator("tool-message [data-real-button]")).toHaveCount(0);

		// Resolve the loader. tool-message should re-render itself via the
		// bobbit-tool-renderer-loaded event.
		await page.evaluate(async () => {
			const wait = (window as any).__waitForRendererLoaded("test_lazy_tool");
			(window as any).__resolveDeferredLazy("test_lazy_tool", "REAL_BUTTON");
			await wait;
		});

		await expect(page.locator("tool-message [data-real-button]")).toContainText("REAL_BUTTON");
		// Card wrapper persists (no flash of unwrapped content).
		await expect(page.locator("tool-message .border.rounded-md")).toHaveCount(1);
		// Placeholder button gone.
		await expect(page.locator("tool-message [data-lazy-renderer-placeholder-btn]")).toHaveCount(0);
	});

	test("loader rejection renders error fallback instead of indefinite spinner", async ({ page }) => {
		await gotoAndWait(page);

		// Silence the expected console.error so it doesn't poison test output.
		page.on("console", () => { /* swallow */ });

		await page.evaluate(async () => {
			(window as any).__registerRejectingLazy("test_failing_tool", "boom");
			const wait = (window as any).__waitForRendererLoaded("test_failing_tool");
			(window as any).__mountToolMessage("slot", "test_failing_tool", "tool-fail");
			await wait;
		});

		// Card wrapper still present, error message rendered.
		await expect(page.locator("tool-message .border.rounded-md")).toHaveCount(1);
		await expect(page.locator("tool-message")).toContainText(/Renderer failed to load/);
		// No placeholder loading button left over.
		await expect(page.locator("tool-message [data-lazy-renderer-placeholder-btn]")).toHaveCount(0);
	});
});

test.describe("Pack renderer { override } precedence (extension-host §4a)", () => {
	test("override shadows a pre-registered eager renderer; resolves to the pack renderer", async ({ page }) => {
		await gotoAndWait(page);

		// 1) Eager built-in registered first, THEN a pack lazy with { override: true }.
		await page.evaluate(() => {
			(window as any).__registerEagerRenderer("shadow_tool", "EAGER");
			(window as any).__registerOverrideDeferredLazy("shadow_tool");
			(window as any).__renderRegistered("shadow_tool");
		});

		// getToolRenderer must return the pack loader's PLACEHOLDER, not the eager
		// renderer — override deleted the eager entry + recorded the name pack-owned.
		await expect(page.locator("#probe [data-lazy-renderer-placeholder-btn]")).toHaveCount(1);
		await expect(page.locator("#probe [data-eager-button]")).toHaveCount(0);

		// 2) A LATER eager registration for the pack-owned name is ignored.
		await page.evaluate(() => {
			(window as any).__registerEagerRenderer("shadow_tool", "LATE_EAGER");
			(window as any).__renderRegistered("shadow_tool");
		});
		await expect(page.locator("#probe [data-lazy-renderer-placeholder-btn]")).toHaveCount(1);
		await expect(page.locator("#probe [data-eager-button]")).toHaveCount(0);

		// 3) Once the pack loader resolves, getToolRenderer returns the PACK renderer.
		await page.evaluate(async () => {
			const wait = (window as any).__waitForRendererLoaded("shadow_tool");
			(window as any).__resolveDeferredLazy("shadow_tool", "PACK_RENDERER");
			await wait;
			(window as any).__renderRegistered("shadow_tool");
		});
		await expect(page.locator("#probe [data-real-button]")).toContainText("PACK_RENDERER");
		await expect(page.locator("#probe [data-eager-button]")).toHaveCount(0);
	});

	test("an unshadowed built-in renderer is untouched by override registrations", async ({ page }) => {
		await gotoAndWait(page);

		await page.evaluate(() => {
			// One tool gets a pack override; a DIFFERENT tool keeps its eager renderer.
			(window as any).__registerEagerRenderer("plain_tool", "PLAIN");
			(window as any).__registerOverrideDeferredLazy("other_tool");
			(window as any).__renderRegistered("plain_tool");
		});

		// The unshadowed builtin renders its eager output — no placeholder.
		await expect(page.locator("#probe [data-eager-button]")).toContainText("PLAIN");
		await expect(page.locator("#probe [data-lazy-renderer-placeholder-btn]")).toHaveCount(0);
	});
});
