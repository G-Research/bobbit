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

	test("unregister restores the displaced built-in renderer in place (uninstall reconciliation §4a)", async ({ page }) => {
		await gotoAndWait(page);

		// 1) Eager built-in, then a pack override that displaces it; render once to
		//    kick off the lazy loader, then resolve the pack.
		await page.evaluate(async () => {
			(window as any).__registerEagerRenderer("reconcile_tool", "BUILTIN");
			(window as any).__registerOverrideDeferredLazy("reconcile_tool");
			(window as any).__renderRegistered("reconcile_tool"); // placeholder → starts load
			const wait = (window as any).__waitForRendererLoaded("reconcile_tool");
			(window as any).__resolveDeferredLazy("reconcile_tool", "PACK_RENDERER");
			await wait;
			(window as any).__renderRegistered("reconcile_tool");
		});
		// Pack renderer is effective; the built-in is suppressed.
		await expect(page.locator("#probe [data-real-button]")).toContainText("PACK_RENDERER");
		await expect(page.locator("#probe [data-eager-button]")).toHaveCount(0);

		// 2) Unregister the pack (uninstall) → the displaced built-in is RESTORED.
		await page.evaluate(() => {
			(window as any).__unregisterPack("reconcile_tool");
			(window as any).__renderRegistered("reconcile_tool");
		});
		await expect(page.locator("#probe [data-eager-button]")).toContainText("BUILTIN");
		await expect(page.locator("#probe [data-real-button]")).toHaveCount(0);
		await expect(page.locator("#probe [data-lazy-renderer-placeholder-btn]")).toHaveCount(0);
	});

	test("unregister restores a displaced LAZY builtin loader (not just eager) §4a", async ({ page }) => {
		await gotoAndWait(page);

		// 1) A LAZY builtin loader is registered (lives in pendingLazy, not yet
		//    loaded — like team_*/task_*/gate_*), THEN a pack { override } shadows
		//    it BEFORE it loads. Two distinct deferred keys so we can resolve the
		//    builtin loader independently of the pack loader.
		await page.evaluate(() => {
			(window as any).__registerKeyedLazy("lazy_builtin_tool", "BUILTIN_LOADER", false);
			(window as any).__registerKeyedLazy("lazy_builtin_tool", "PACK_LOADER", true);
			(window as any).__renderRegistered("lazy_builtin_tool"); // pack placeholder → starts pack load
		});
		// Pack override is effective → its placeholder, not the builtin.
		await expect(page.locator("#probe [data-lazy-renderer-placeholder-btn]")).toHaveCount(1);

		// 2) Unregister the pack (uninstall) → the displaced LAZY builtin loader is
		//    RE-ARMED in pendingLazy (NOT lost to default rendering).
		await page.evaluate(() => {
			(window as any).__unregisterPack("lazy_builtin_tool");
			(window as any).__renderRegistered("lazy_builtin_tool"); // builtin loader → placeholder, starts builtin load
		});
		// getToolRenderer re-triggered the restored builtin lazy loader → placeholder
		// again (NOT [data-no-renderer], which would mean the loader was lost).
		await expect(page.locator("#probe [data-lazy-renderer-placeholder-btn]")).toHaveCount(1);
		await expect(page.locator("#probe [data-no-renderer]")).toHaveCount(0);

		// 3) Resolve the BUILTIN loader → the real specialized builtin renderer lands.
		await page.evaluate(async () => {
			const wait = (window as any).__waitForRendererLoaded("lazy_builtin_tool");
			(window as any).__resolveKeyedLazy("BUILTIN_LOADER", "LAZY_BUILTIN");
			await wait;
			(window as any).__renderRegistered("lazy_builtin_tool");
		});
		await expect(page.locator("#probe [data-real-button]")).toContainText("LAZY_BUILTIN");
	});

	test("unregister of a pack tool with no built-in falls back to default (no renderer)", async ({ page }) => {
		await gotoAndWait(page);

		await page.evaluate(async () => {
			(window as any).__registerOverrideDeferredLazy("orphan_pack_tool");
			(window as any).__renderRegistered("orphan_pack_tool"); // placeholder → starts load
			const wait = (window as any).__waitForRendererLoaded("orphan_pack_tool");
			(window as any).__resolveDeferredLazy("orphan_pack_tool", "PACK_ONLY");
			await wait;
			(window as any).__renderRegistered("orphan_pack_tool");
		});
		await expect(page.locator("#probe [data-real-button]")).toContainText("PACK_ONLY");

		await page.evaluate(() => {
			(window as any).__unregisterPack("orphan_pack_tool");
			(window as any).__renderRegistered("orphan_pack_tool");
		});
		// No built-in to restore → getToolRenderer returns undefined (default render).
		await expect(page.locator("#probe [data-no-renderer]")).toHaveCount(1);
		await expect(page.locator("#probe [data-real-button]")).toHaveCount(0);
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

test.describe("In-flight lazy load TOCTOU guard (generation token)", () => {
	test("unregister while a load is in flight: a late resolve does NOT resurrect the pack renderer", async ({ page }) => {
		await gotoAndWait(page);

		// Eager built-in, then a pack override that displaces it. Render once to
		// kick off the (still-pending) lazy loader — placeholder is shown.
		await page.evaluate(() => {
			(window as any).__registerEagerRenderer("race_tool", "BUILTIN");
			(window as any).__registerOverrideDeferredLazy("race_tool");
			(window as any).__renderRegistered("race_tool"); // placeholder → starts load
		});
		await expect(page.locator("#probe [data-lazy-renderer-placeholder-btn]")).toHaveCount(1);

		// Uninstall the pack BEFORE the loader resolves → built-in is restored.
		const countAfterUnregister = await page.evaluate(() => {
			(window as any).__unregisterPack("race_tool");
			(window as any).__renderRegistered("race_tool");
			return (window as any).__loadedEventCount("race_tool");
		});
		await expect(page.locator("#probe [data-eager-button]")).toContainText("BUILTIN");

		// NOW resolve the superseded loader. It must be a no-op: no write, no repaint.
		const countAfterResolve = await page.evaluate(async () => {
			(window as any).__resolveDeferredLazy("race_tool", "STALE_PACK");
			await (window as any).__flush();
			(window as any).__renderRegistered("race_tool");
			return (window as any).__loadedEventCount("race_tool");
		});

		// The stale renderer never landed — the restored built-in still renders.
		await expect(page.locator("#probe [data-eager-button]")).toContainText("BUILTIN");
		await expect(page.locator("#probe [data-real-button]")).toHaveCount(0);
		// No resurrecting repaint fired for the superseded resolve.
		expect(countAfterResolve).toBe(countAfterUnregister);
	});

	test("re-register a different renderer while a load is in flight: the stale load is ignored, the new one wins", async ({ page }) => {
		await gotoAndWait(page);

		// Loader A registered + started (placeholder shown).
		await page.evaluate(() => {
			(window as any).__registerKeyedLazy("rereg_tool", "A", true);
			(window as any).__renderRegistered("rereg_tool"); // starts load A
		});
		await expect(page.locator("#probe [data-lazy-renderer-placeholder-btn]")).toHaveCount(1);

		// Re-register a DIFFERENT loader B for the same name (bumps generation +
		// drops the in-flight A promise so B can start a fresh load), then start it.
		await page.evaluate(() => {
			(window as any).__registerKeyedLazy("rereg_tool", "B", true);
			(window as any).__renderRegistered("rereg_tool"); // starts load B
		});

		// Resolve the STALE loader A first — must be ignored.
		await page.evaluate(async () => {
			(window as any).__resolveKeyedLazy("A", "STALE_A");
			await (window as any).__flush();
			(window as any).__renderRegistered("rereg_tool");
		});
		await expect(page.locator("#probe [data-real-button]")).toHaveCount(0);

		// Resolve the fresh loader B — it wins.
		await page.evaluate(async () => {
			(window as any).__resolveKeyedLazy("B", "FRESH_B");
			await (window as any).__flush();
			(window as any).__renderRegistered("rereg_tool");
		});
		await expect(page.locator("#probe [data-real-button]")).toContainText("FRESH_B");
	});
});

/**
 * Writer-ordering MATRIX (Wave 10C). The renderer registry routes EVERY
 * mutation through one generation-guarded chokepoint, so a deferred lazy load
 * resolving AFTER a superseding write is structurally dropped — regardless of
 * which writer superseded it. Each case drives a different ordering and asserts
 * BOTH the resolved renderer AND that no resurrecting repaint event fired for
 * the superseded resolve (the loaded-event-count helper).
 */
test.describe("Writer-ordering matrix: stale deferred applies are structurally dropped (Wave 10C)", () => {
	test("lazy-start → eager registerToolRenderer → stale lazy resolves: the EAGER renderer wins (eager-gap fix)", async ({ page }) => {
		await gotoAndWait(page);

		// 1) A non-pack lazy renderer is registered and STARTED (placeholder shown).
		await page.evaluate(() => {
			(window as any).__registerKeyedLazy("eager_gap_tool", "LAZY", false);
			(window as any).__renderRegistered("eager_gap_tool"); // starts the lazy load
		});
		await expect(page.locator("#probe [data-lazy-renderer-placeholder-btn]")).toHaveCount(1);

		// 2) An EAGER registerToolRenderer lands for the SAME name while the lazy
		//    load is still in flight. This must bump the generation + drop the
		//    in-flight promise so the stale lazy can no longer resurrect over it.
		const countAfterEager = await page.evaluate(() => {
			(window as any).__registerEagerRenderer("eager_gap_tool", "EAGER_WINS");
			(window as any).__renderRegistered("eager_gap_tool");
			return (window as any).__loadedEventCount("eager_gap_tool");
		});
		await expect(page.locator("#probe [data-eager-button]")).toContainText("EAGER_WINS");

		// 3) The stale lazy resolves LAST — it must be a no-op (no write, no repaint).
		const countAfterResolve = await page.evaluate(async () => {
			(window as any).__resolveKeyedLazy("LAZY", "STALE_LAZY");
			await (window as any).__flush();
			(window as any).__renderRegistered("eager_gap_tool");
			return (window as any).__loadedEventCount("eager_gap_tool");
		});
		// Eager renderer still wins; the stale lazy never landed.
		await expect(page.locator("#probe [data-eager-button]")).toContainText("EAGER_WINS");
		await expect(page.locator("#probe [data-real-button]")).toHaveCount(0);
		// No resurrecting repaint fired for the superseded resolve.
		expect(countAfterResolve).toBe(countAfterEager);
	});

	test("lazy-start → pack {override} → stale lazy resolves: the PACK renderer wins", async ({ page }) => {
		await gotoAndWait(page);

		// 1) A non-pack lazy renderer registered + started.
		await page.evaluate(() => {
			(window as any).__registerKeyedLazy("override_race_tool", "BUILTIN_LAZY", false);
			(window as any).__renderRegistered("override_race_tool"); // starts builtin lazy load
		});
		await expect(page.locator("#probe [data-lazy-renderer-placeholder-btn]")).toHaveCount(1);

		// 2) A pack { override } loader supersedes it mid-flight (bumps generation,
		//    drops the in-flight builtin promise), then starts the pack load.
		await page.evaluate(() => {
			(window as any).__registerKeyedLazy("override_race_tool", "PACK", true);
			(window as any).__renderRegistered("override_race_tool"); // starts pack load
		});

		// 3) The stale BUILTIN lazy resolves first — must be ignored.
		await page.evaluate(async () => {
			(window as any).__resolveKeyedLazy("BUILTIN_LAZY", "STALE_BUILTIN");
			await (window as any).__flush();
			(window as any).__renderRegistered("override_race_tool");
		});
		await expect(page.locator("#probe [data-real-button]")).toHaveCount(0);

		// 4) The pack loader resolves — it wins.
		await page.evaluate(async () => {
			const wait = (window as any).__waitForRendererLoaded("override_race_tool");
			(window as any).__resolveKeyedLazy("PACK", "PACK_WINS");
			await wait;
			(window as any).__renderRegistered("override_race_tool");
		});
		await expect(page.locator("#probe [data-real-button]")).toContainText("PACK_WINS");
	});

	test("lazy-start → unregisterPackRenderer → stale lazy resolves: it does NOT resurrect", async ({ page }) => {
		await gotoAndWait(page);

		// 1) An eager builtin, then a pack { override } that displaces it; render
		//    once to start the (still-pending) pack lazy load — placeholder shown.
		await page.evaluate(() => {
			(window as any).__registerEagerRenderer("unreg_race_tool", "BUILTIN");
			(window as any).__registerOverrideDeferredLazy("unreg_race_tool");
			(window as any).__renderRegistered("unreg_race_tool"); // starts pack load
		});
		await expect(page.locator("#probe [data-lazy-renderer-placeholder-btn]")).toHaveCount(1);

		// 2) Uninstall the pack BEFORE the loader resolves → builtin restored.
		const countAfterUnregister = await page.evaluate(() => {
			(window as any).__unregisterPack("unreg_race_tool");
			(window as any).__renderRegistered("unreg_race_tool");
			return (window as any).__loadedEventCount("unreg_race_tool");
		});
		await expect(page.locator("#probe [data-eager-button]")).toContainText("BUILTIN");

		// 3) The superseded pack loader resolves LAST — no-op, no resurrection.
		const countAfterResolve = await page.evaluate(async () => {
			(window as any).__resolveDeferredLazy("unreg_race_tool", "STALE_PACK");
			await (window as any).__flush();
			(window as any).__renderRegistered("unreg_race_tool");
			return (window as any).__loadedEventCount("unreg_race_tool");
		});
		await expect(page.locator("#probe [data-eager-button]")).toContainText("BUILTIN");
		await expect(page.locator("#probe [data-real-button]")).toHaveCount(0);
		expect(countAfterResolve).toBe(countAfterUnregister);
	});

	test("eager-then-override: a stale eager-era lazy load cannot resurrect after override claims the name", async ({ page }) => {
		await gotoAndWait(page);

		// 1) A non-pack lazy renderer registered + started (placeholder).
		await page.evaluate(() => {
			(window as any).__registerKeyedLazy("eager_then_override", "OLD_LAZY", false);
			(window as any).__renderRegistered("eager_then_override"); // starts old lazy load
		});
		await expect(page.locator("#probe [data-lazy-renderer-placeholder-btn]")).toHaveCount(1);

		// 2) An eager registration lands (bumps generation), then a pack override
		//    claims the name (bumps again + marks pack-owned + starts the pack load).
		await page.evaluate(() => {
			(window as any).__registerEagerRenderer("eager_then_override", "MID_EAGER");
			(window as any).__registerKeyedLazy("eager_then_override", "PACK", true);
			(window as any).__renderRegistered("eager_then_override"); // starts pack load
		});

		// 3) The original lazy resolves LAST — two generations stale → no-op.
		await page.evaluate(async () => {
			(window as any).__resolveKeyedLazy("OLD_LAZY", "STALE_OLD");
			await (window as any).__flush();
			(window as any).__renderRegistered("eager_then_override");
		});
		await expect(page.locator("#probe [data-real-button]")).toHaveCount(0);
		await expect(page.locator("#probe [data-eager-button]")).toHaveCount(0);

		// 4) The pack loader resolves — it wins (pack-owned name, override precedence).
		await page.evaluate(async () => {
			const wait = (window as any).__waitForRendererLoaded("eager_then_override");
			(window as any).__resolveKeyedLazy("PACK", "PACK_WINS");
			await wait;
			(window as any).__renderRegistered("eager_then_override");
		});
		await expect(page.locator("#probe [data-real-button]")).toContainText("PACK_WINS");
	});
});
