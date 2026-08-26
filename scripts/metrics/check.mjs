#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { baselineMetricFile, baselineMetricsDir, currentMetricsDir, listJsonFiles, metricFile, normalizeMetricName, projectRoot, readJson, requiredMetricNames } from "./lib.mjs";

function parseCliArgs(argv) {
	const options = {
		baseline: null,
		current: null,
		noCoverage: false,
		minRuntimeDecrease: null,
		minCpuDecrease: null,
		required: null,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const readValue = () => {
			const value = argv[++i];
			if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
			return value;
		};
		switch (arg) {
			case "--baseline":
				options.baseline = readValue();
				break;
			case "--current":
				options.current = readValue();
				break;
			case "--no-coverage":
				options.noCoverage = true;
				break;
			case "--min-runtime-decrease":
				options.minRuntimeDecrease = parseFraction(readValue(), arg);
				break;
			case "--min-cpu-decrease":
				options.minCpuDecrease = parseFraction(readValue(), arg);
				break;
			case "--required":
				options.required = readValue();
				break;
			default:
				throw new Error(`unknown argument ${arg}`);
		}
	}
	return options;
}

function parseFraction(raw, flag) {
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${flag} must be a fraction from 0 to 1`);
	return value;
}

function classifyInput(path) {
	if (existsSync(path)) return statSync(path).isDirectory() ? "dir" : "file";
	return basename(path).endsWith(".json") ? "file" : "dir";
}

let cli;
try {
	cli = parseCliArgs(process.argv.slice(2));
} catch (error) {
	console.error(`[metrics:check] ${error.message}`);
	process.exit(2);
}

const baselineInput = resolve(cli.baseline || process.env.BOBBIT_METRICS_BASELINE_DIR || baselineMetricsDir);
const currentInput = resolve(cli.current || process.env.BOBBIT_METRICS_CURRENT_DIR || currentMetricsDir);
const baselineInputKind = classifyInput(baselineInput);
const currentInputKind = classifyInput(currentInput);
const baselineDir = baselineInputKind === "dir" ? baselineInput : dirname(baselineInput);
const currentDir = currentInputKind === "dir" ? currentInput : dirname(currentInput);
const thresholdFile = process.env.BOBBIT_METRICS_THRESHOLDS
	? resolve(process.env.BOBBIT_METRICS_THRESHOLDS)
	: join(baselineDir, "thresholds.json");

const defaultThresholds = {
	coverageMinDeltaPct: -0.10,
	runtimeMaxIncreaseRatio: 1.50,
	runtimeMaxIncreaseMs: 60_000,
	cpuMaxIncreaseRatio: 1.75,
	cpuMaxIncreaseMs: 120_000,
	memoryMaxIncreaseRatio: 1.75,
	memoryMaxIncreaseBytes: 512 * 1024 * 1024,
	metricBudgets: {},
	browserE2eBudget: {
		// Disabled by default so ad-hoc scoped checks keep their historical behavior.
		// Branch baselines can enable this from docs/testing-metrics/thresholds.json.
		enabled: false,
		metrics: ["e2e-browser", "slice-renderer", "slice-scroll", "slice-sidebar"],
		metricBudgets: {},
		maxTestCountIncrease: 0,
		maxTestCountIncreaseRatio: 0,
		runtimeMaxIncreaseRatio: 1.50,
		runtimeMaxIncreaseMs: 120_000,
		cpuMaxIncreaseRatio: 1.75,
		cpuMaxIncreaseMs: 240_000,
	},
	browserImprovement: {
		// Disabled until migration gates set branch-local baselines. Downstream can
		// turn this on via docs/testing-metrics/thresholds.json without code changes.
		enabled: false,
		targetRuntimeDropPct: 40,
		targetCpuDropPct: 40,
	},
};

function mergeThresholds(base, override) {
	if (!override || typeof override !== "object" || Array.isArray(override)) return base;
	const merged = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const baseValue = base?.[key];
		merged[key] = baseValue && typeof baseValue === "object" && !Array.isArray(baseValue) && value && typeof value === "object" && !Array.isArray(value)
			? mergeThresholds(baseValue, value)
			: value;
	}
	return merged;
}

const retiredRegistryKeys = new Set([
	"retainedSmokeFiles",
	"retainedSmokeCoverage",
	"requiredTitleRegexes",
	"titleRegexes",
	"minNonSkippedTests",
	"minRunnableTests",
]);

function findRetiredRegistryKeys(value, path = "thresholds") {
	if (!value || typeof value !== "object") return [];
	if (Array.isArray(value)) return value.flatMap((child, index) => findRetiredRegistryKeys(child, `${path}[${index}]`));
	const found = [];
	for (const [key, child] of Object.entries(value)) {
		const childPath = `${path}.${key}`;
		if (retiredRegistryKeys.has(key)) found.push(childPath);
		found.push(...findRetiredRegistryKeys(child, childPath));
	}
	return found;
}

const configuredThresholds = existsSync(thresholdFile) ? readJson(thresholdFile) : null;
const retiredConfiguredKeys = findRetiredRegistryKeys(configuredThresholds);
if (retiredConfiguredKeys.length > 0) {
	console.error(`[metrics:check] retired per-test registry key(s) in ${rel(thresholdFile)}: ${retiredConfiguredKeys.join(", ")}. Remove them; test ownership and discovery come from canonical paths and lane runners.`);
	process.exit(2);
}
const thresholds = configuredThresholds
	? mergeThresholds(defaultThresholds, configuredThresholds)
	: defaultThresholds;

function requiredMetrics() {
	const raw = cli.required ?? process.env.BOBBIT_METRICS_REQUIRED;
	const names = raw == null
		? requiredMetricNames
		: raw.split(",").map((name) => name.trim()).filter(Boolean);
	return names.map((name) => normalizeMetricName(name));
}

function rel(path) {
	return relative(projectRoot, path) || ".";
}

function fmtMs(ms) {
	return `${(ms / 1000).toFixed(1)}s`;
}

function pctChange(base, current) {
	if (!Number.isFinite(base) || base <= 0) return 0;
	return ((current - base) / base) * 100;
}

function maxAllowed(base, ratio, additive) {
	return Math.max(base * ratio, base + additive);
}

function compareNumeric({ label, baseline, current, ratio, additive, format = (v) => String(v) }) {
	if (!Number.isFinite(baseline) || !Number.isFinite(current)) return [];
	const allowed = maxAllowed(baseline, ratio, additive);
	if (current <= allowed) return [];
	return [`${label} increased ${pctChange(baseline, current).toFixed(1)}% (${format(baseline)} → ${format(current)}), max ${format(allowed)}`];
}

function compareAbsoluteMax({ label, current, max, format = (v) => String(v) }) {
	if (!Number.isFinite(max)) return [];
	if (!Number.isFinite(current)) return [`${label} is missing or non-finite; required max is ${format(max)}`];
	if (current <= max) return [];
	return [`${label} ${format(current)} exceeds max ${format(max)}`];
}

function compareMinDecrease({ label, baseline, current, minDecrease, format = (v) => String(v) }) {
	if (minDecrease == null || !Number.isFinite(baseline) || !Number.isFinite(current)) return [];
	const allowed = baseline * (1 - minDecrease);
	if (current <= allowed) return [];
	const dropPct = -pctChange(baseline, current);
	return [`${label} decreased ${dropPct.toFixed(1)}%, below required ${(minDecrease * 100).toFixed(1)}% (${format(baseline)} → ${format(current)}), max ${format(allowed)}`];
}

function compareCoverage(label, baseline, current) {
	if (cli.noCoverage) return [];
	const failures = [];
	for (const key of ["lines", "functions", "branches"]) {
		const before = baseline.coverage?.[key]?.pct;
		const after = current.coverage?.[key]?.pct;
		if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
		const delta = Number((after - before).toFixed(2));
		if (delta < thresholds.coverageMinDeltaPct) {
			failures.push(`${label}: coverage ${key} regressed ${delta.toFixed(2)}pp (${before}% → ${after}%)`);
		}
	}
	return failures;
}

function testCount(metric) {
	const total = metric.tests?.total ?? metric.attribution?.projectTestCount;
	return Number.isFinite(total) ? total : null;
}

function metricBudgetFor(metricName, budget) {
	const perMetric = budget?.metricBudgets?.[metricName] ?? budget?.budgets?.[metricName] ?? budget?.perMetric?.[metricName];
	return perMetric && typeof perMetric === "object" && !Array.isArray(perMetric)
		? { ...budget, ...perMetric }
		: budget;
}

function genericBudgetForMetric(metricName) {
	const budgets = thresholds.metricBudgets;
	if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) return null;
	const normalizedMetricName = normalizeMetricName(metricName);
	const budget = budgets[normalizedMetricName];
	return budget && typeof budget === "object" && !Array.isArray(budget) ? budget : null;
}

function browserBudgetForMetric(metricName) {
	const budget = thresholds.browserE2eBudget;
	if (!budget?.enabled) return null;
	const normalizedMetricName = normalizeMetricName(metricName);
	const metricNames = Array.isArray(budget.metrics) ? budget.metrics.map((name) => normalizeMetricName(name)) : [];
	if (metricNames.length > 0 && !metricNames.includes(normalizedMetricName)) return null;
	return metricBudgetFor(normalizedMetricName, budget);
}

function explicitDecreaseBudgetForMetric(metricName) {
	return genericBudgetForMetric(metricName) ?? browserBudgetForMetric(metricName);
}

function usesAbsoluteBudgetForExplicitDecrease(metricName, kind) {
	const metricBudget = explicitDecreaseBudgetForMetric(metricName);
	if (metricBudget?.useAbsoluteBudgetForExplicitDecrease !== true) return false;
	if (kind === "runtime") return Number.isFinite(metricBudget.maxDurationMs);
	if (kind === "cpu") return Number.isFinite(metricBudget.maxEstimatedCpuMs);
	return false;
}

function compareGenericMetricBudget(label, metricName, current) {
	const metricBudget = genericBudgetForMetric(metricName);
	if (!metricBudget) return [];
	const failures = [];
	const currentCount = testCount(current);
	if (Number.isFinite(metricBudget.maxTestCount)) {
		if (currentCount == null) {
			failures.push(`${label}: metric budget test count is missing or non-finite; required max is ${metricBudget.maxTestCount}`);
		} else if (currentCount > metricBudget.maxTestCount) {
			failures.push(`${label}: metric budget test count ${currentCount} exceeds max ${metricBudget.maxTestCount}`);
		}
	}
	if (Number.isFinite(metricBudget.maxDurationMs)) {
		failures.push(...compareAbsoluteMax({
			label: `${label}: metric budget runtime`,
			current: current.durationMs,
			max: metricBudget.maxDurationMs,
			format: fmtMs,
		}));
	}
	if (Number.isFinite(metricBudget.maxEstimatedCpuMs)) {
		failures.push(...compareAbsoluteMax({
			label: `${label}: metric budget estimated CPU`,
			current: current.cpu?.estimatedCpuMs,
			max: metricBudget.maxEstimatedCpuMs,
			format: fmtMs,
		}));
	}
	if (Number.isFinite(metricBudget.maxPeakRssBytes)) {
		failures.push(...compareAbsoluteMax({
			label: `${label}: metric budget peak RSS`,
			current: current.memory?.peakRssBytes,
			max: metricBudget.maxPeakRssBytes,
			format: (bytes) => `${(bytes / 1024 / 1024).toFixed(0)}MiB`,
		}));
	}
	return failures;
}

function compareLegacyBrowserTestCount(label, baselineCount, currentCount, budget) {
	if (baselineCount == null || currentCount == null) return [];
	const additive = Number.isFinite(budget.maxTestCountIncrease) ? budget.maxTestCountIncrease : 0;
	const ratio = Number.isFinite(budget.maxTestCountIncreaseRatio) ? budget.maxTestCountIncreaseRatio : 0;
	const allowed = Math.floor(Math.max(baselineCount + additive, baselineCount * (1 + ratio)));
	return currentCount > allowed
		? [`${label}: browser E2E test count increased ${baselineCount} → ${currentCount}, max ${allowed}`]
		: [];
}

function compareBrowserBudget(label, metricName, baseline, current) {
	const metricBudget = browserBudgetForMetric(metricName);
	if (!metricBudget) return [];
	const failures = [];
	const baselineCount = testCount(baseline);
	const currentCount = testCount(current);
	const useAbsoluteBudgetForExplicitDecrease = metricBudget.useAbsoluteBudgetForExplicitDecrease === true && (cli.minRuntimeDecrease != null || cli.minCpuDecrease != null);
	if (scopedComparison && !useAbsoluteBudgetForExplicitDecrease) return compareLegacyBrowserTestCount(label, baselineCount, currentCount, metricBudget);
	if (Number.isFinite(metricBudget.maxTestCount)) {
		if (currentCount == null) {
			failures.push(`${label}: browser E2E test count is missing or non-finite; required max is ${metricBudget.maxTestCount}`);
		} else if (currentCount > metricBudget.maxTestCount) {
			failures.push(`${label}: browser E2E test count ${currentCount} exceeds max ${metricBudget.maxTestCount}`);
		}
	} else {
		failures.push(...compareLegacyBrowserTestCount(label, baselineCount, currentCount, metricBudget));
	}
	if (Number.isFinite(metricBudget.maxDurationMs)) {
		failures.push(...compareAbsoluteMax({
			label: `${label}: browser E2E budget runtime`,
			current: current.durationMs,
			max: metricBudget.maxDurationMs,
			format: fmtMs,
		}));
	} else {
		failures.push(...compareNumeric({
			label: `${label}: browser E2E budget runtime`,
			baseline: baseline.durationMs,
			current: current.durationMs,
			ratio: metricBudget.runtimeMaxIncreaseRatio,
			additive: metricBudget.runtimeMaxIncreaseMs,
			format: fmtMs,
		}));
	}
	if (Number.isFinite(metricBudget.maxEstimatedCpuMs)) {
		failures.push(...compareAbsoluteMax({
			label: `${label}: browser E2E budget estimated CPU`,
			current: current.cpu?.estimatedCpuMs,
			max: metricBudget.maxEstimatedCpuMs,
			format: fmtMs,
		}));
	} else {
		failures.push(...compareNumeric({
			label: `${label}: browser E2E budget estimated CPU`,
			baseline: baseline.cpu?.estimatedCpuMs,
			current: current.cpu?.estimatedCpuMs,
			ratio: metricBudget.cpuMaxIncreaseRatio,
			additive: metricBudget.cpuMaxIncreaseMs,
			format: fmtMs,
		}));
	}
	return failures;
}

function currentPathForMetric(metricName) {
	if (currentInputKind === "file") return currentInput;
	return metricFile(metricName, currentDir);
}

function baselinePathForMetric(metricName) {
	if (baselineInputKind === "file") return baselineInput;
	return baselineMetricFile(metricName, baselineDir);
}

function comparisonPairs() {
	if (baselineInputKind === "file") {
		const metricName = normalizeMetricName(baselineInput);
		return [{ baselinePath: baselineInput, currentPath: currentPathForMetric(metricName), label: basename(baselineInput) }];
	}
	if (currentInputKind === "file") {
		const metricName = normalizeMetricName(currentInput);
		const baselinePath = baselinePathForMetric(metricName);
		return [{ baselinePath, currentPath: currentInput, label: basename(baselinePath) }];
	}
	return listJsonFiles(baselineDir)
		.filter((file) => basename(file) !== "thresholds.json" && basename(file).startsWith("baseline-"))
		.map((file) => {
			const metricName = normalizeMetricName(file);
			return {
				baselinePath: join(baselineDir, file),
				currentPath: metricFile(metricName, currentDir),
				label: file,
			};
		});
}

function compareMetric({ baselinePath, currentPath, label }) {
	if (!existsSync(baselinePath)) return [`${label}: missing baseline metric ${rel(baselinePath)}`];
	if (!existsSync(currentPath)) return [`${label}: missing current metric ${basename(currentPath)} in ${rel(dirname(currentPath))}`];
	const metricName = normalizeMetricName(baselinePath);
	const baseline = readJson(baselinePath);
	const current = readJson(currentPath);
	const failures = [];
	if (current.status && current.status !== "passed") failures.push(`${label}: current status is ${current.status}`);
	failures.push(...compareCoverage(label, baseline, current));
	failures.push(...compareGenericMetricBudget(label, metricName, current));
	failures.push(...compareBrowserBudget(label, metricName, baseline, current));
	if (cli.minRuntimeDecrease != null) {
		if (!usesAbsoluteBudgetForExplicitDecrease(metricName, "runtime")) {
			failures.push(...compareMinDecrease({
				label: `${label}: runtime`,
				baseline: baseline.durationMs,
				current: current.durationMs,
				minDecrease: cli.minRuntimeDecrease,
				format: fmtMs,
			}));
		}
	} else if (!scopedComparison) {
		failures.push(...compareNumeric({
			label: `${label}: runtime`,
			baseline: baseline.durationMs,
			current: current.durationMs,
			ratio: thresholds.runtimeMaxIncreaseRatio,
			additive: thresholds.runtimeMaxIncreaseMs,
			format: fmtMs,
		}));
	}
	if (cli.minCpuDecrease != null) {
		if (!usesAbsoluteBudgetForExplicitDecrease(metricName, "cpu")) {
			failures.push(...compareMinDecrease({
				label: `${label}: estimated CPU`,
				baseline: baseline.cpu?.estimatedCpuMs,
				current: current.cpu?.estimatedCpuMs,
				minDecrease: cli.minCpuDecrease,
				format: fmtMs,
			}));
		}
	} else if (!scopedComparison) {
		failures.push(...compareNumeric({
			label: `${label}: estimated CPU`,
			baseline: baseline.cpu?.estimatedCpuMs,
			current: current.cpu?.estimatedCpuMs,
			ratio: thresholds.cpuMaxIncreaseRatio,
			additive: thresholds.cpuMaxIncreaseMs,
			format: fmtMs,
		}));
	}
	if (!scopedComparison) {
		failures.push(...compareNumeric({
			label: `${label}: peak RSS`,
			baseline: baseline.memory?.peakRssBytes,
			current: current.memory?.peakRssBytes,
			ratio: thresholds.memoryMaxIncreaseRatio,
			additive: thresholds.memoryMaxIncreaseBytes,
			format: (bytes) => `${(bytes / 1024 / 1024).toFixed(0)}MiB`,
		}));
	}
	return failures;
}

const scopedComparison = baselineInputKind === "file" || currentInputKind === "file";
const pairs = comparisonPairs();
const requiredMetricNamesForCheck = requiredMetrics();
const retiredMetricNames = new Set(["e2e-api-realpush"]);
const failures = [];
if (!scopedComparison || cli.required != null || process.env.BOBBIT_METRICS_REQUIRED != null) {
	for (const name of requiredMetricNamesForCheck) {
		const baselinePath = baselinePathForMetric(name);
		const currentPath = currentPathForMetric(name);
		if (!existsSync(baselinePath)) failures.push(`baseline-${name}.json: missing required baseline metric in ${rel(dirname(baselinePath))}`);
		if (!existsSync(currentPath)) failures.push(`${name}.json: missing required current metric in ${rel(dirname(currentPath))}`);
	}
}
if (pairs.length === 0) {
	failures.push(`no baseline JSON files found in ${baselineDir}`);
}

for (const pair of pairs) {
	const metricName = normalizeMetricName(pair.baselinePath);
	if (retiredMetricNames.has(metricName)) {
		failures.push(`${pair.label}: retired metric baseline; remove it because Playwright E2E metrics now have only api and browser projects`);
		continue;
	}
	failures.push(...compareMetric(pair));
}

if (!scopedComparison && thresholds.browserImprovement?.enabled) {
	for (const name of ["e2e-browser", "slice-renderer", "slice-scroll", "slice-sidebar"]) {
		const b = baselineMetricFile(name, baselineDir);
		const c = metricFile(name, currentDir);
		if (!existsSync(b) || !existsSync(c)) continue;
		const baseline = readJson(b);
		const current = readJson(c);
		const runtimeDrop = -pctChange(baseline.durationMs, current.durationMs);
		const cpuDrop = -pctChange(baseline.cpu?.estimatedCpuMs, current.cpu?.estimatedCpuMs);
		const baselineFile = `baseline-${name}.json`;
		if (runtimeDrop < thresholds.browserImprovement.targetRuntimeDropPct) failures.push(`${baselineFile}: runtime drop ${runtimeDrop.toFixed(1)}% is below target ${thresholds.browserImprovement.targetRuntimeDropPct}%`);
		if (cpuDrop < thresholds.browserImprovement.targetCpuDropPct) failures.push(`${baselineFile}: CPU drop ${cpuDrop.toFixed(1)}% is below target ${thresholds.browserImprovement.targetCpuDropPct}%`);
	}
}

if (failures.length > 0) {
	console.error(`[metrics:check] ${failures.length} failure(s):`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

const sourceLabel = scopedComparison ? pairs.map((pair) => rel(pair.baselinePath)).join(", ") : rel(baselineDir);
const currentLabel = scopedComparison ? pairs.map((pair) => rel(pair.currentPath)).join(", ") : rel(currentDir);
console.log(`[metrics:check] passed ${pairs.length} metric comparison(s) (${sourceLabel} → ${currentLabel})`);
