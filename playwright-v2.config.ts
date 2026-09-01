/**
 * Playwright v2 config — Tier-2 browser tests for Test Suite v2.
 *
 * Key differences from playwright-e2e.config.ts:
 *   - Chromium only (no Firefox/WebKit)
 *   - retries: 3 for normal developer workflow; retry-free qualification uses
 *     BOBBIT_V2_RETRY_FREE=1 without changing the default safety net
 *   - Worker count from the shared ledger (cap 4)
 *   - Canonical browser fixtures and journeys only
 *   - Per-coordinator result artifacts under the owned run root
 *   - One stable ignored JSON summary for the budget gate
 *   - Global setup: build dist if missing
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { seedTransformCacheForRunDir } from "./scripts/testing-v2/pwtest-cache.js";
import { captureMachineGlobalLedgerDirectory } from "./scripts/run-playwright-e2e.mjs";
import { TEST_LAYOUT } from "./scripts/testing/layout-policy.mjs";
import { capturePlaywrightBrowserRegistry, createRunArtifactDirectory, getRunRoot, installRunIsolation, isOwnedRunPath } from "./tests/support/harnesses/shared/run-isolation.js";

// The browser harness redirects TMPDIR below. Preserve the intentional
// machine-global concurrency ledger before that isolation takes effect.
process.env.BOBBIT_V2_LEDGER_DIR = captureMachineGlobalLedgerDirectory();

// This config is evaluated before browser workers import the isolated gateway
// harness. Pin the host Playwright cache now; workers can then isolate HOME for
// Bobbit config discovery without making Chromium resolve into their empty home.
capturePlaywrightBrowserRegistry();
// Direct Playwright invocations do not pass through the browser coordinator.
// Scrub host runtime discovery before config evaluation and worker spawn.
installRunIsolation();

// Allocate this before Playwright spawns workers so every worker inherits the
// same coordinator-owned root. It is removed only by that coordinator after
// reporters finish; workers can never clean a sibling's diagnostics.
const browserRunRoot = getRunRoot();
process.env.BOBBIT_E2E_TMP_ROOT = join(browserRunRoot, "tmp", "bobbit-e2e");
process.env.BOBBIT_E2E_PWTEST_CACHE_ROOT = join(browserRunRoot, "pwtest-transform-cache");
process.env.BOBBIT_E2E_PWTEST_RUN_CACHE_ROOT = process.env.BOBBIT_E2E_PWTEST_CACHE_ROOT;
process.env.PWTEST_CACHE_DIR = process.env.BOBBIT_E2E_PWTEST_CACHE_ROOT;
mkdirSync(process.env.BOBBIT_E2E_TMP_ROOT!, { recursive: true });
const playwrightArtifactsDir = createRunArtifactDirectory("playwright-v2");
const playwrightResultsDir = join(playwrightArtifactsDir, "test-results");
// The browser coordinator supplies a unique report path inside its owned run
// root. Direct config use gets the same isolated default; never fall back to a
// shared checkout-local "latest" report that concurrent coordinators could race.
function resolvePlaywrightBudgetReport(): string {
	const report = resolve(process.env.BOBBIT_V2_PLAYWRIGHT_REPORT_PATH?.trim() || join(playwrightArtifactsDir, "playwright-report.json"));
	if (!isOwnedRunPath(report)) throw new Error(`Playwright report must be inside the owned run root: ${report}`);
	mkdirSync(dirname(report), { recursive: true });
	return report;
}
const playwrightBudgetReport = resolvePlaywrightBudgetReport();

function e2eTempRoot(): string {
	// Coordinators always provide an owned compatibility parent. Prefer it even
	// in Docker, where `/tmp/bobbit-e2e` would otherwise be shared by runs.
	if (process.env.BOBBIT_E2E_TMP_ROOT) return process.env.BOBBIT_E2E_TMP_ROOT;
	if (existsSync("/.dockerenv")) return "/tmp";
	return process.platform === "win32" ? "C:\\bobbit-e2e" : join(tmpdir(), "bobbit-e2e");
}

function sanitizeCacheSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "run";
}

function e2ePwtestCacheBaseRoot(): string {
	return process.env.BOBBIT_E2E_PWTEST_CACHE_ROOT?.trim()
		|| process.env.BOBBIT_PWTEST_CACHE_ROOT?.trim()
		|| e2eTempRoot();
}

function prepareV2RuntimeCaches(): void {
	process.env.NODE_DISABLE_COMPILE_CACHE = "1";
	delete process.env.NODE_COMPILE_CACHE;

	if (!process.env.PWTEST_CACHE_DIR) {
		const runId = sanitizeCacheSegment(
			process.env.BOBBIT_V2_BROWSER_RUN_ID?.trim()
				|| `v2-direct-${process.pid}-${randomUUID()}`,
		);
		const runCacheRoot = join(resolve(e2ePwtestCacheBaseRoot()), "pwtest-transform-cache-v2", runId);
		process.env.BOBBIT_V2_PWTEST_RUN_CACHE_ROOT = runCacheRoot;
		process.env.PWTEST_CACHE_DIR = runCacheRoot;
		process.env.BOBBIT_E2E_PWTEST_CACHE_OWNED = "1";
	}
	const transformCacheDir = process.env.PWTEST_CACHE_DIR!;
	const runCacheRoot = process.env.BOBBIT_V2_PWTEST_RUN_CACHE_ROOT?.trim() || transformCacheDir;
	process.env.BOBBIT_E2E_PWTEST_CACHE_DIR = runCacheRoot;
	mkdirSync(runCacheRoot, { recursive: true });
	mkdirSync(transformCacheDir, { recursive: true });
	// Warm-start the per-run transform cache from the last published snapshot
	// (`<base>/pwtest-transform-cache-v2/latest`). Entries are content-hashed so
	// reuse is safe; per-run dirs only isolate WRITES. Fail-open: any copy error
	// just means a cold cache. The matching publish happens in
	// tests/support/harnesses/browser/global-teardown.ts.
	seedTransformCacheForRunDir(runCacheRoot);
}

prepareV2RuntimeCaches();

// GLOBAL CONCURRENCY BUDGET: opt this run's browser gateway boots into the
// cross-process gateway-boot lease pool (scripts/testing-v2/ledger.mjs). Set in
// the config module (the Playwright runner process) so it is inherited by every
// spawned worker. Only v2 browser runs set it — the legacy e2e config does not,
// so the shared worker fixture in tests/e2e/gateway-harness.ts is unchanged for
// legacy runs.
process.env.BOBBIT_V2_GATEWAY_BOOT_LEASE = "1";

// GLOBAL CONCURRENCY BUDGET (browser-render lease): cap the TOTAL number of
// Chromium browser workers rendering the app at once across ALL concurrent runs
// (scripts/testing-v2/ledger.mjs, pool "browser", cap in tests/support/data/quality/budgets/budget-caps.json).
// The gateway-harness worker fixture acquires a browser slot at worker startup
// (before booting its gateway) and holds it for the worker's whole life; queued
// workers WAIT holding nothing. This directly targets the sustained multi-browser
// RENDER contention behind tier-2 toBeVisible flakes at N-way. Only v2 browser
// runs set this; the legacy e2e config never does, so legacy is unchanged.
process.env.BOBBIT_V2_BROWSER_LEASE = "1";

// Worker count from ledger (PLAYWRIGHT_CAP=3 chromium workers; raised 2→3 after
// a solo isolated run measured ~3.8x faster with more browser workers — the
// ledger's Σworkers≤cores reservation + the browser-render lease cap total
// Chromium across runs). BOBBIT_V2_PLAYWRIGHT_WORKERS overrides for measurement/tuning.
function resolvePlaywrightWorkers(): number {
	const override = Number(process.env.BOBBIT_V2_PLAYWRIGHT_WORKERS);
	if (Number.isFinite(override) && override >= 1) return Math.floor(override);
	try {
		const req = createRequire(import.meta.url);
		const { reserveWorkerSlots } = req("./scripts/testing-v2/ledger.mjs") as {
			reserveWorkerSlots: (kind: string) => { workerSlots: number; release: () => void };
		};
		const { workerSlots, release } = reserveWorkerSlots("playwright");
		process.once("exit", release);
		return Math.min(4, Math.max(1, workerSlots));
	} catch {
		// Ledger unavailable — use safe default.
		return 2;
	}
}

const playwrightWorkers = resolvePlaywrightWorkers();
const canonicalBrowserMatches = (TEST_LAYOUT as readonly { semantic: string; suffix: string }[])
	.filter(({ semantic }) => semantic === "browser-fixture" || semantic === "browser-journey")
	.map(({ suffix }) => `**/*${suffix}`);

export default {
	timeout: 60_000,
	// Normal workflow retains the developer safety net. Qualification sets
	// BOBBIT_V2_RETRY_FREE=1 and accepts only first-attempt results.
	retries: process.env.BOBBIT_V2_RETRY_FREE === "1" ? 0 : 3,
	fullyParallel: false,
	workers: playwrightWorkers,
	reporter: [
		[process.stdout.isTTY ? "list" : "line"],
		["json", { outputFile: playwrightBudgetReport }],
	] as Array<[string, unknown?]>,
	globalSetup: "./tests/support/harnesses/browser/global-setup.ts",
	globalTeardown: "./tests/support/harnesses/browser/global-teardown.ts",
	use: {
		video: "off",
		trace: "off",
		screenshot: "off",
		launchOptions: {
			args: [
				"--disable-gpu",
				"--disable-dev-shm-usage",
				"--disable-background-timer-throttling",
				"--disable-renderer-backgrounding",
				"--disable-backgrounding-occluded-windows",
				"--disable-features=TranslateUI,BackForwardCache,CalculateNativeWinOcclusion",
			],
		},
	},
	projects: [
		{
			name: "browser-v2",
			testDir: "./tests2/browser",
			testMatch: ["**/*.spec.ts"],
			testIgnore: ["**/e2e/**"], // real-fidelity e2e:v2 specs; run only via `test:e2e:v2` (project browser-v2-e2e), never in tier-2 `test:v2`
			use: {
				browserName: "chromium" as const,
			},
		},
		{
			name: "browser-canonical",
			testDir: "./tests/browser",
			testMatch: canonicalBrowserMatches,
			fullyParallel: true,
			use: {
				browserName: "chromium" as const,
			},
		},
		{
			// Real-fidelity browser lane (adapter specs + crash/restart journey).
			// Run only via `test:e2e:v2` — NOT part of tier-2 `test:v2`.
			// Inherits normal retries:3; BOBBIT_V2_RETRY_FREE=1 makes this lane
			// retry-free for concurrent first-attempt qualification.
			name: "browser-v2-e2e",
			testDir: "./tests2/browser/e2e",
			testMatch: ["**/*.spec.ts"],
			use: {
				browserName: "chromium" as const,
			},
		},
	],
	outputDir: playwrightResultsDir,
};
