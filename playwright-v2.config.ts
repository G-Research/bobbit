/**
 * Playwright v2 config — Tier-2 browser tests for Test Suite v2.
 *
 * Key differences from playwright-e2e.config.ts:
 *   - Chromium only (no Firefox/WebKit)
 *   - retries: 2 (TEMPORARY concurrency bridge — see the `retries` note below
 *     and docs/testing-strategy.md "Concurrency & budgets"; NOT flake-masking)
 *   - Worker count from the shared ledger (cap 4)
 *   - testDir: tests2/browser
 *   - Separate output dir (test-results-v2)
 *   - Global setup: build dist if missing
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function e2eTempRoot(): string {
	if (existsSync("/.dockerenv")) return "/tmp";
	return process.platform === "win32"
		? (process.env.BOBBIT_E2E_TMP_ROOT || "C:\\bobbit-e2e")
		: join(tmpdir(), "bobbit-e2e");
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
				|| `v2-direct-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
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
// (scripts/testing-v2/ledger.mjs, pool "browser", cap in tests2/budget-caps.json).
// The gateway-harness worker fixture acquires a browser slot at worker startup
// (before booting its gateway) and holds it for the worker's whole life; queued
// workers WAIT holding nothing. This directly targets the sustained multi-browser
// RENDER contention behind tier-2 toBeVisible flakes at N-way. Only v2 browser
// runs set this; the legacy e2e config never does, so legacy is unchanged.
process.env.BOBBIT_V2_BROWSER_LEASE = "1";

// Worker count from ledger (PLAYWRIGHT_CAP=2 chromium workers — the IO-bound
// sweet spot; the ledger's Σworkers≤cores caps total Chromium across runs).
// BOBBIT_V2_PLAYWRIGHT_WORKERS overrides for measurement/tuning. Falls back to 2.
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

export default {
	timeout: 60_000,
	// TEMPORARY CONCURRENCY BRIDGE (not a flake budget).
	// Bobbit runs goals CONCURRENTLY in prod. The concurrency proof
	// (docs/testing-v2/concurrency-proof.md, the N=2 → 3/6 finding) shows a PROVEN
	// structural server-throughput ceiling: at N≥2 concurrent full runs a rotating
	// cast of tests hits wall-timeouts / load-induced races under CPU starvation on
	// one box — NOT assertion/logic bugs (browser render-timeouts + one load-induced
	// 403 goal-creation were the tier-2 casualties). With retries:0 those spurious
	// starvation failures would fail concurrent goal gate-loops. The flakes are KNOWN
	// and DOCUMENTED (not blind-masked). REMOVAL CONDITION: restore `retries: 0` once
	// the higher-N server-throughput fix (spin-off goal) lands.
	retries: 2,
	fullyParallel: false,
	workers: playwrightWorkers,
	reporter: [
		[process.stdout.isTTY ? "list" : "line"],
		["json", { outputFile: ".profiles/testing-v2/budgets/playwright-report.json" }],
	] as Array<[string, unknown?]>,
	globalSetup: "./tests2/browser-global-setup.ts",
	globalTeardown: "./tests/e2e/e2e-teardown.ts",
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
			testIgnore: ["**/daily/**"], // bash.exe-dependent tests; run in isolation via test:daily
			use: {
				browserName: "chromium" as const,
			},
		},
		{
			// Real-fidelity browser lane (adapter specs + crash/restart journey).
			// Run only via `test:e2e:v2` — NOT part of tier-2 `test:v2`.
			// retries:2 is inherited from the top-level config (temporary concurrency
			// bridge — see the top-level `retries` note; NOT a flake budget).
			name: "browser-v2-daily",
			testDir: "./tests2/browser/daily",
			testMatch: ["**/*.spec.ts"],
			use: {
				browserName: "chromium" as const,
			},
		},
	],
	outputDir: "test-results-v2",
};
