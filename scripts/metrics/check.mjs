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
	browserImprovement: {
		// Disabled until migration gates set branch-local baselines. Downstream can
		// turn this on via docs/testing-metrics/thresholds.json without code changes.
		enabled: false,
		targetRuntimeDropPct: 40,
		targetCpuDropPct: 40,
	},
};
const thresholds = existsSync(thresholdFile)
	? { ...defaultThresholds, ...readJson(thresholdFile) }
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
	const baseline = readJson(baselinePath);
	const current = readJson(currentPath);
	const failures = [];
	if (current.status && current.status !== "passed") failures.push(`${label}: current status is ${current.status}`);
	failures.push(...compareCoverage(label, baseline, current));
	if (cli.minRuntimeDecrease != null) {
		failures.push(...compareMinDecrease({
			label: `${label}: runtime`,
			baseline: baseline.durationMs,
			current: current.durationMs,
			minDecrease: cli.minRuntimeDecrease,
			format: fmtMs,
		}));
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
		failures.push(...compareMinDecrease({
			label: `${label}: estimated CPU`,
			baseline: baseline.cpu?.estimatedCpuMs,
			current: current.cpu?.estimatedCpuMs,
			minDecrease: cli.minCpuDecrease,
			format: fmtMs,
		}));
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

for (const pair of pairs) failures.push(...compareMetric(pair));

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
