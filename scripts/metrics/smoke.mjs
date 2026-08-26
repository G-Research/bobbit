#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineMetricFile, metricFile, parsePlaywrightJson, playwrightE2EProjectEntries, writeJson } from "./lib.mjs";

const root = mkdtempSync(join(tmpdir(), "bobbit-metrics-smoke-"));
const baselineDir = join(root, "baseline");
const currentDir = join(root, "current");
const badCurrentDir = join(root, "bad-current");
const badBudgetCurrentDir = join(root, "bad-budget-current");
const missingRuntimeCurrentDir = join(root, "missing-runtime-current");
const missingCpuCurrentDir = join(root, "missing-cpu-current");
const missingTestCountCurrentDir = join(root, "missing-test-count-current");
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

function sampleFullMetric(overrides = {}) {
	return {
		schemaVersion: 1,
		metricName: "e2e-full",
		kind: "e2e-full",
		createdAt: new Date().toISOString(),
		status: "passed",
		exitCode: 0,
		durationMs: 620_000,
		cpu: { estimatedCpuMs: 4_900_000, averageCpuPercent: 790, peakCpuPercent: 1200 },
		memory: { peakRssBytes: 2 * 1024 * 1024 * 1024 },
		tests: {
			total: 1200,
			passed: 1200,
			failed: 0,
			skipped: 0,
			nonSkipped: 1200,
			durationMs: 1_700_000,
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
				"tests/e2e/browser/example.browser-e2e.spec.ts": {
					total: 1,
					passed: 1,
					failed: 0,
					skipped: 0,
					flaky: 0,
					nonSkipped: 1,
					durationMs: 1000,
				},
			},
		},
		...overrides,
	};
}

function checkEnvironment(dir) {
	return {
		...process.env,
		BOBBIT_METRICS_BASELINE_DIR: baselineDir,
		BOBBIT_METRICS_CURRENT_DIR: dir,
		BOBBIT_METRICS_REQUIRED: "coverage",
	};
}

function runCheck(dir) {
	return spawnSync(process.execPath, ["scripts/metrics/check.mjs"], {
		stdio: "inherit",
		env: checkEnvironment(dir),
	});
}

function runCheckCaptured(dir) {
	return spawnSync(process.execPath, ["scripts/metrics/check.mjs"], {
		encoding: "utf8",
		env: checkEnvironment(dir),
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

function assertAggregateDiscoverySmoke() {
	const reportPath = join(root, "playwright-report.json");
	writeJson(reportPath, {
		suites: [{
			file: "tests/e2e/api/example.api-e2e.spec.ts",
			title: "tests/e2e/api/example.api-e2e.spec.ts",
			specs: [{
				title: "generated title must not become registry data",
				tests: [{ projectName: "api", expectedStatus: "passed", status: "expected", results: [{ duration: 12 }] }],
			}],
		}],
	});
	const summary = parsePlaywrightJson(reportPath);
	const file = summary.projects.api?.files?.["tests/e2e/api/example.api-e2e.spec.ts"];
	if (summary.total !== 1 || summary.projects.api?.total !== 1 || file?.total !== 1 || file.durationMs !== 12) {
		throw new Error("Playwright aggregate parsing lost project/file diagnostics");
	}
	if (Object.hasOwn(file, "titles")) throw new Error("Playwright aggregate parsing must not persist per-test titles");

	const projectEntries = playwrightE2EProjectEntries({ api: { total: 1 }, browser: { total: 2 } });
	if (projectEntries.map(([name]) => name).join(",") !== "api,browser") throw new Error("Playwright metrics project ownership drifted");
	try {
		playwrightE2EProjectEntries({ api: {}, browser: {}, "api-realpush": {} });
		throw new Error("obsolete Playwright metrics project was accepted");
	} catch (error) {
		if (!String(error.message).includes("unsupported Playwright project split(s): api-realpush")) throw error;
	}
}

function assertCoverageMapSmoke() {
	const coverageMapPath = join(baselineDir, "coverage-map.md");
	const retiredBaselinePath = baselineMetricFile("e2e-api-realpush", baselineDir);
	writeJson(retiredBaselinePath, sampleBrowserMetric({ metricName: "e2e-api-realpush" }));
	writeFileSync(coverageMapPath, `# Convention-derived testing metrics

KEEP-SEMANTIC-OWNERSHIP-SENTINEL

## Historical baseline metric files

<!-- baseline-metric-files:start -->
- stale-pre-migration-row

Thresholds: stale-thresholds.json.
<!-- baseline-metric-files:end -->
`);
	const result = runCoverageMapOnly();
	if ((result.status ?? 1) !== 0) throw new Error("expected coverage-map-only baseline refresh to pass");
	const updated = readFileSync(coverageMapPath, "utf8");
	for (const expected of [
		"KEEP-SEMANTIC-OWNERSHIP-SENTINEL",
		"<!-- baseline-metric-files:start -->",
		"<!-- baseline-metric-files:end -->",
		"`baseline-coverage.json`",
		"`baseline-e2e-browser.json`",
		"Thresholds: `thresholds.json`.",
	]) {
		if (!updated.includes(expected)) throw new Error(`coverage-map smoke missing ${expected}`);
	}
	for (const stale of ["stale-pre-migration-row", "stale-thresholds.json", "api-realpush", "retainedSmokeFiles"]) {
		if (updated.includes(stale)) throw new Error(`coverage-map smoke retained stale text: ${stale}`);
	}
	if (readFileSync(coverageMapPath, "utf8").includes("baseline-e2e-api-realpush")) throw new Error("coverage-map smoke retained obsolete real-push baseline");
}

try {
	assertAggregateDiscoverySmoke();
	const baselineCoveragePath = baselineMetricFile("coverage", baselineDir);
	const baselineBrowserPath = baselineMetricFile("e2e-browser", baselineDir);
	const scopedCurrentPath = metricFile("coverage", scopedCurrentDir);
	const fullSuiteBaselineDir = join(root, "full-suite-baseline");
	const fullSuiteCurrentDir = join(root, "full-suite-current");
	const fullSuiteOverBudgetDir = join(root, "full-suite-over-budget-current");
	const fullSuiteMissingRuntimeDir = join(root, "full-suite-missing-runtime-current");
	const fullSuiteMissingCpuDir = join(root, "full-suite-missing-cpu-current");
	const baselineFullPath = baselineMetricFile("e2e-full", fullSuiteBaselineDir);
	writeJson(join(baselineDir, "thresholds.json"), {
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
	writeJson(metricFile("coverage", missingRuntimeCurrentDir), sampleMetric());
	writeJson(metricFile("e2e-browser", missingRuntimeCurrentDir), sampleBrowserMetric({ durationMs: undefined }));
	writeJson(metricFile("coverage", missingCpuCurrentDir), sampleMetric());
	writeJson(metricFile("e2e-browser", missingCpuCurrentDir), sampleBrowserMetric({ cpu: undefined }));
	writeJson(metricFile("coverage", missingTestCountCurrentDir), sampleMetric());
	writeJson(metricFile("e2e-browser", missingTestCountCurrentDir), sampleBrowserMetric({
		tests: { ...sampleBrowserMetric().tests, total: undefined },
	}));
	writeJson(scopedCurrentPath, sampleMetric({
		durationMs: 300_000,
		cpu: { estimatedCpuMs: 300_000, averageCpuPercent: 100, peakCpuPercent: 200 },
		memory: { peakRssBytes: 2 * 1024 * 1024 * 1024 },
	}));
	writeJson(join(fullSuiteBaselineDir, "thresholds.json"), {
		metricBudgets: {
			"e2e-full": {
				maxDurationMs: 700_000,
				maxEstimatedCpuMs: 2_500_000,
				useAbsoluteBudgetForExplicitDecrease: true,
			},
		},
	});
	writeJson(baselineFullPath, sampleFullMetric());
	writeJson(metricFile("e2e-full", fullSuiteCurrentDir), sampleFullMetric({
		durationMs: 619_000,
		cpu: { estimatedCpuMs: 1_800_000, averageCpuPercent: 290, peakCpuPercent: 800 },
	}));
	writeJson(metricFile("e2e-full", fullSuiteOverBudgetDir), sampleFullMetric({
		durationMs: 710_000,
		cpu: { estimatedCpuMs: 2_600_000, averageCpuPercent: 366, peakCpuPercent: 900 },
	}));
	writeJson(metricFile("e2e-full", fullSuiteMissingRuntimeDir), sampleFullMetric({ durationMs: undefined }));
	writeJson(metricFile("e2e-full", fullSuiteMissingCpuDir), sampleFullMetric({ cpu: undefined }));

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

	const scopedFullSuiteAbsoluteBudgetPass = runScopedCheck(baselineFullPath, metricFile("e2e-full", fullSuiteCurrentDir), ["--no-coverage", "--min-runtime-decrease", "0.25", "--min-cpu-decrease", "0.25"]);
	if ((scopedFullSuiteAbsoluteBudgetPass.status ?? 1) !== 0) throw new Error("expected e2e-full explicit decrease check to pass under generic absolute budgets even when runtime decrease is below target");

	const scopedFullSuiteAbsoluteBudgetFail = runScopedCheck(baselineFullPath, metricFile("e2e-full", fullSuiteOverBudgetDir), ["--no-coverage", "--min-runtime-decrease", "0.25", "--min-cpu-decrease", "0.25"]);
	if ((scopedFullSuiteAbsoluteBudgetFail.status ?? 0) === 0) throw new Error("expected e2e-full explicit decrease check to fail when generic absolute budgets are exceeded");

	const scopedFullSuiteMissingRuntimeFail = runScopedCheck(baselineFullPath, metricFile("e2e-full", fullSuiteMissingRuntimeDir), ["--no-coverage"]);
	if ((scopedFullSuiteMissingRuntimeFail.status ?? 0) === 0) throw new Error("expected e2e-full budget check to fail when runtime is missing");

	const scopedFullSuiteMissingCpuFail = runScopedCheck(baselineFullPath, metricFile("e2e-full", fullSuiteMissingCpuDir), ["--no-coverage"]);
	if ((scopedFullSuiteMissingCpuFail.status ?? 0) === 0) throw new Error("expected e2e-full budget check to fail when estimated CPU is missing");

	const fail = runCheck(badCurrentDir);
	if ((fail.status ?? 0) === 0) throw new Error("expected metrics:check to fail for coverage regression");

	const budgetFail = runCheck(badBudgetCurrentDir);
	if ((budgetFail.status ?? 0) === 0) throw new Error("expected metrics:check to fail for browser E2E absolute budget growth");

	const missingRuntimeFail = runCheck(missingRuntimeCurrentDir);
	if ((missingRuntimeFail.status ?? 0) === 0) throw new Error("expected metrics:check to fail when a budgeted runtime field is missing");

	const missingCpuFail = runCheck(missingCpuCurrentDir);
	if ((missingCpuFail.status ?? 0) === 0) throw new Error("expected metrics:check to fail when a budgeted CPU field is missing");

	const missingTestCountFail = runCheck(missingTestCountCurrentDir);
	if ((missingTestCountFail.status ?? 0) === 0) throw new Error("expected metrics:check to fail when a budgeted test-count field is missing");

	const retiredMetricBaseline = baselineMetricFile("e2e-api-realpush", baselineDir);
	writeJson(retiredMetricBaseline, sampleBrowserMetric({ metricName: "e2e-api-realpush" }));
	const retiredMetricFail = runCheckCaptured(currentDir);
	if ((retiredMetricFail.status ?? 0) === 0) throw new Error("expected metrics:check to reject an obsolete real-push baseline");
	const retiredMetricOutput = `${retiredMetricFail.stdout || ""}\n${retiredMetricFail.stderr || ""}`;
	if (!retiredMetricOutput.includes("retired metric baseline") || !retiredMetricOutput.includes("only api and browser projects")) {
		throw new Error("retired metric baseline diagnostic is not actionable");
	}
	rmSync(retiredMetricBaseline, { force: true });

	writeJson(join(baselineDir, "thresholds.json"), {
		retainedSmokeFiles: ["tests/e2e/browser/example.browser-e2e.spec.ts"],
		browserE2eBudget: {
			retainedSmokeCoverage: [{ requiredTitleRegexes: ["legacy title"] }],
		},
	});
	const retiredRegistryFail = runCheckCaptured(currentDir);
	if ((retiredRegistryFail.status ?? 0) === 0) throw new Error("expected metrics:check to reject retired per-test registry keys");
	const retiredRegistryOutput = `${retiredRegistryFail.stdout || ""}\n${retiredRegistryFail.stderr || ""}`;
	for (const expected of ["retired per-test registry key", "thresholds.retainedSmokeFiles", "thresholds.browserE2eBudget.retainedSmokeCoverage", "requiredTitleRegexes", "canonical paths and lane runners"]) {
		if (!retiredRegistryOutput.includes(expected)) throw new Error(`retired-registry diagnostic missing ${expected}`);
	}

	const obsoleteProject = spawnSync(process.execPath, ["scripts/metrics/e2e-project.mjs", "api-realpush"], { encoding: "utf8" });
	if ((obsoleteProject.status ?? 0) === 0) throw new Error("expected obsolete api-realpush metrics project to be rejected");
	const obsoleteProjectOutput = `${obsoleteProject.stdout || ""}\n${obsoleteProject.stderr || ""}`;
	if (!obsoleteProjectOutput.includes("<api|browser>")) throw new Error("obsolete project diagnostic must name only current Playwright metric projects");

	assertCoverageMapSmoke();

	console.log("[metrics:smoke] passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
