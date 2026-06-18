#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineMetricFile, metricFile, writeJson } from "./lib.mjs";

const root = mkdtempSync(join(tmpdir(), "bobbit-metrics-smoke-"));
const baselineDir = join(root, "baseline");
const currentDir = join(root, "current");
const badCurrentDir = join(root, "bad-current");
const badBudgetCurrentDir = join(root, "bad-budget-current");
const missingSmokeCurrentDir = join(root, "missing-smoke-current");
const skippedSmokeCurrentDir = join(root, "skipped-smoke-current");
const scopedCurrentDir = join(root, "scoped-current");

function sampleMetric(overrides = {}) {
	return {
		schemaVersion: 1,
		metricName: "coverage",
		kind: "coverage",
		createdAt: new Date().toISOString(),
		status: "passed",
		exitCode: 0,
		durationMs: 10_000,
		cpu: { estimatedCpuMs: 8_000, averageCpuPercent: 80, peakCpuPercent: 150 },
		memory: { peakRssBytes: 128 * 1024 * 1024 },
		coverage: {
			lines: { covered: 900, total: 1000, pct: 90 },
			functions: { covered: 90, total: 100, pct: 90 },
			branches: { covered: 80, total: 100, pct: 80 },
		},
		...overrides,
	};
}

function sampleBrowserMetric(overrides = {}) {
	return {
		schemaVersion: 1,
		metricName: "e2e-browser",
		kind: "e2e-project-split-from-full",
		createdAt: new Date().toISOString(),
		status: "passed",
		exitCode: 0,
		durationMs: 100_000,
		cpu: { estimatedCpuMs: 200_000, averageCpuPercent: 200, peakCpuPercent: 300 },
		memory: { peakRssBytes: 512 * 1024 * 1024 },
		tests: {
			total: 100,
			passed: 100,
			failed: 0,
			skipped: 0,
			flaky: 0,
			nonSkipped: 100,
			durationMs: 100_000,
			files: {
				"scripts/metrics/check.mjs": {
					total: 1,
					passed: 1,
					failed: 0,
					skipped: 0,
					flaky: 0,
					nonSkipped: 1,
					durationMs: 1000,
					titles: [{ title: "retained smoke sentinel", status: "passed", project: "browser" }],
				},
			},
		},
		...overrides,
	};
}

function runCheck(dir) {
	return spawnSync(process.execPath, ["scripts/metrics/check.mjs"], {
		stdio: "inherit",
		env: {
			...process.env,
			BOBBIT_METRICS_BASELINE_DIR: baselineDir,
			BOBBIT_METRICS_CURRENT_DIR: dir,
			BOBBIT_METRICS_REQUIRED: "coverage",
		},
	});
}

function runScopedCheck(baselinePath, currentPath, extraArgs = []) {
	return spawnSync(process.execPath, [
		"scripts/metrics/check.mjs",
		"--baseline",
		baselinePath,
		"--current",
		currentPath,
		...extraArgs,
	], { stdio: "inherit" });
}

function runCoverageMapOnly() {
	return spawnSync(process.execPath, ["scripts/metrics/baseline.mjs", "--coverage-map-only"], {
		stdio: "inherit",
		env: { ...process.env, BOBBIT_METRICS_BASELINE_DIR: baselineDir },
	});
}

function assertCoverageMapSmoke() {
	const coverageMapPath = join(baselineDir, "coverage-map.md");
	writeFileSync(coverageMapPath, `# Split UI E2E coverage map

## Retained full-stack smoke inventory

KEEP-SMOKE-SENTINEL

## Coverage-map update rules

KEEP-RULE-SENTINEL

## Baseline metric files

<!-- baseline-metric-files:start -->
- stale-pre-migration-row

Thresholds: stale-thresholds.json.
<!-- baseline-metric-files:end -->
`);
	const result = runCoverageMapOnly();
	if ((result.status ?? 1) !== 0) throw new Error("expected coverage-map-only baseline refresh to pass");
	const updated = readFileSync(coverageMapPath, "utf8");
	for (const expected of [
		"KEEP-SMOKE-SENTINEL",
		"KEEP-RULE-SENTINEL",
		"<!-- baseline-metric-files:start -->",
		"<!-- baseline-metric-files:end -->",
		"`baseline-coverage.json`",
		"`baseline-e2e-browser.json`",
		"Thresholds: `thresholds.json`.",
	]) {
		if (!updated.includes(expected)) throw new Error(`coverage-map smoke missing ${expected}`);
	}
	for (const stale of ["stale-pre-migration-row", "stale-thresholds.json", "tail-chat-user-scroll-up.spec.ts", "later sidebar gate should add"]) {
		if (updated.includes(stale)) throw new Error(`coverage-map smoke retained stale text: ${stale}`);
	}
}

try {
	const baselineCoveragePath = baselineMetricFile("coverage", baselineDir);
	const baselineBrowserPath = baselineMetricFile("e2e-browser", baselineDir);
	const scopedCurrentPath = metricFile("coverage", scopedCurrentDir);
	writeJson(join(baselineDir, "thresholds.json"), {
		retainedSmokeFiles: ["scripts/metrics/check.mjs"],
		retainedSmokeCoverage: [
			{ file: "scripts/metrics/check.mjs", metric: "e2e-browser", minNonSkippedTests: 1, requiredTitleRegexes: ["retained smoke sentinel"] },
		],
		browserE2eBudget: {
			enabled: true,
			maxTestCountIncrease: 0,
			metricBudgets: {
				"e2e-browser": {
					maxTestCount: 100,
					maxDurationMs: 100_000,
					maxEstimatedCpuMs: 200_000,
					useAbsoluteBudgetForExplicitDecrease: true,
				},
			},
		},
	});
	writeJson(baselineCoveragePath, sampleMetric());
	writeJson(baselineBrowserPath, sampleBrowserMetric());
	writeJson(metricFile("coverage", currentDir), sampleMetric({ durationMs: 10_500, cpu: { estimatedCpuMs: 8_200, averageCpuPercent: 78, peakCpuPercent: 140 } }));
	writeJson(metricFile("e2e-browser", currentDir), sampleBrowserMetric({ durationMs: 95_000, cpu: { estimatedCpuMs: 180_000, averageCpuPercent: 190, peakCpuPercent: 290 } }));
	writeJson(metricFile("coverage", badCurrentDir), sampleMetric({
		coverage: {
			lines: { covered: 850, total: 1000, pct: 85 },
			functions: { covered: 85, total: 100, pct: 85 },
			branches: { covered: 75, total: 100, pct: 75 },
		},
	}));
	writeJson(metricFile("e2e-browser", badCurrentDir), sampleBrowserMetric());
	writeJson(metricFile("coverage", badBudgetCurrentDir), sampleMetric());
	writeJson(metricFile("e2e-browser", badBudgetCurrentDir), sampleBrowserMetric({
		durationMs: 110_000,
		cpu: { estimatedCpuMs: 220_000, averageCpuPercent: 200, peakCpuPercent: 300 },
	}));
	writeJson(metricFile("coverage", missingSmokeCurrentDir), sampleMetric());
	writeJson(metricFile("e2e-browser", missingSmokeCurrentDir), sampleBrowserMetric({
		tests: { ...sampleBrowserMetric().tests, files: {} },
	}));
	writeJson(metricFile("coverage", skippedSmokeCurrentDir), sampleMetric());
	writeJson(metricFile("e2e-browser", skippedSmokeCurrentDir), sampleBrowserMetric({
		tests: {
			...sampleBrowserMetric().tests,
			files: {
				"scripts/metrics/check.mjs": {
					total: 1,
					passed: 0,
					failed: 0,
					skipped: 1,
					flaky: 0,
					nonSkipped: 0,
					durationMs: 0,
					titles: [{ title: "retained smoke sentinel", status: "skipped", project: "browser" }],
				},
			},
		},
	}));
	writeJson(scopedCurrentPath, sampleMetric({
		durationMs: 300_000,
		cpu: { estimatedCpuMs: 300_000, averageCpuPercent: 100, peakCpuPercent: 200 },
		memory: { peakRssBytes: 2 * 1024 * 1024 * 1024 },
	}));

	const pass = runCheck(currentDir);
	if ((pass.status ?? 1) !== 0) throw new Error("expected metrics:check to pass for non-regressing current metrics");

	const scopedPass = runScopedCheck(baselineCoveragePath, scopedCurrentPath);
	if ((scopedPass.status ?? 1) !== 0) throw new Error("expected scoped coverage check to ignore default runtime, CPU, and RSS guardrails");

	const scopedDecreaseFail = runScopedCheck(baselineCoveragePath, scopedCurrentPath, ["--no-coverage", "--min-runtime-decrease", "0.30", "--min-cpu-decrease", "0.30"]);
	if ((scopedDecreaseFail.status ?? 0) === 0) throw new Error("expected scoped check with explicit runtime/CPU decreases to fail");

	const scopedBrowserAbsoluteBudgetPass = runScopedCheck(baselineBrowserPath, metricFile("e2e-browser", currentDir), ["--no-coverage", "--min-runtime-decrease", "0.40", "--min-cpu-decrease", "0.40"]);
	if ((scopedBrowserAbsoluteBudgetPass.status ?? 1) !== 0) throw new Error("expected e2e-browser explicit decrease check to pass under absolute budgets");

	const scopedBrowserAbsoluteBudgetFail = runScopedCheck(baselineBrowserPath, metricFile("e2e-browser", badBudgetCurrentDir), ["--no-coverage", "--min-runtime-decrease", "0.40", "--min-cpu-decrease", "0.40"]);
	if ((scopedBrowserAbsoluteBudgetFail.status ?? 0) === 0) throw new Error("expected e2e-browser explicit decrease check to fail when absolute budgets are exceeded");

	const fail = runCheck(badCurrentDir);
	if ((fail.status ?? 0) === 0) throw new Error("expected metrics:check to fail for coverage regression");

	const budgetFail = runCheck(badBudgetCurrentDir);
	if ((budgetFail.status ?? 0) === 0) throw new Error("expected metrics:check to fail for browser E2E absolute budget growth");

	const missingSmokeReportFail = runCheck(missingSmokeCurrentDir);
	if ((missingSmokeReportFail.status ?? 0) === 0) throw new Error("expected metrics:check to fail when retained smoke file is absent from browser report");

	const skippedSmokeFail = runCheck(skippedSmokeCurrentDir);
	if ((skippedSmokeFail.status ?? 0) === 0) throw new Error("expected metrics:check to fail when retained smoke coverage has zero non-skipped tests");

	writeJson(join(baselineDir, "thresholds.json"), {
		retainedSmokeFiles: ["tests/e2e/ui/does-not-exist-retained-smoke.spec.ts"],
	});
	const missingSmokeFail = runCheck(currentDir);
	if ((missingSmokeFail.status ?? 0) === 0) throw new Error("expected metrics:check to fail for a missing retained smoke file");

	assertCoverageMapSmoke();

	console.log("[metrics:smoke] passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
