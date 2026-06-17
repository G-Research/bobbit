#!/usr/bin/env node
import { existsSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { baselineMetricsDir, currentMetricsDir, listJsonFiles, projectRoot, readJson } from "./lib.mjs";

const baselineDir = resolve(process.env.BOBBIT_METRICS_BASELINE_DIR || baselineMetricsDir);
const currentDir = resolve(process.env.BOBBIT_METRICS_CURRENT_DIR || currentMetricsDir);
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

function compareCoverage(file, baseline, current) {
	const failures = [];
	for (const key of ["lines", "functions", "branches"]) {
		const before = baseline.coverage?.[key]?.pct;
		const after = current.coverage?.[key]?.pct;
		if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
		const delta = Number((after - before).toFixed(2));
		if (delta < thresholds.coverageMinDeltaPct) {
			failures.push(`${file}: coverage ${key} regressed ${delta.toFixed(2)}pp (${before}% → ${after}%)`);
		}
	}
	return failures;
}

function compareMetric(file) {
	const baseline = readJson(join(baselineDir, file));
	const currentPath = join(currentDir, file);
	if (!existsSync(currentPath)) return [`${file}: missing current metric in ${relative(projectRoot, currentDir)}`];
	const current = readJson(currentPath);
	const failures = [];
	if (current.status && current.status !== "passed") failures.push(`${file}: current status is ${current.status}`);
	failures.push(...compareCoverage(file, baseline, current));
	failures.push(...compareNumeric({
		label: `${file}: runtime`,
		baseline: baseline.durationMs,
		current: current.durationMs,
		ratio: thresholds.runtimeMaxIncreaseRatio,
		additive: thresholds.runtimeMaxIncreaseMs,
		format: fmtMs,
	}));
	failures.push(...compareNumeric({
		label: `${file}: estimated CPU`,
		baseline: baseline.cpu?.estimatedCpuMs,
		current: current.cpu?.estimatedCpuMs,
		ratio: thresholds.cpuMaxIncreaseRatio,
		additive: thresholds.cpuMaxIncreaseMs,
		format: fmtMs,
	}));
	failures.push(...compareNumeric({
		label: `${file}: peak RSS`,
		baseline: baseline.memory?.peakRssBytes,
		current: current.memory?.peakRssBytes,
		ratio: thresholds.memoryMaxIncreaseRatio,
		additive: thresholds.memoryMaxIncreaseBytes,
		format: (bytes) => `${(bytes / 1024 / 1024).toFixed(0)}MiB`,
	}));
	return failures;
}

const baselineFiles = listJsonFiles(baselineDir).filter((file) => basename(file) !== "thresholds.json");
if (baselineFiles.length === 0) {
	console.error(`[metrics:check] no baseline JSON files found in ${baselineDir}`);
	process.exit(1);
}

const failures = [];
for (const file of baselineFiles) failures.push(...compareMetric(file));

if (thresholds.browserImprovement?.enabled) {
	for (const file of ["e2e-browser.json", "slice-renderer.json", "slice-scroll.json", "slice-sidebar.json"]) {
		const b = join(baselineDir, file);
		const c = join(currentDir, file);
		if (!existsSync(b) || !existsSync(c)) continue;
		const baseline = readJson(b);
		const current = readJson(c);
		const runtimeDrop = -pctChange(baseline.durationMs, current.durationMs);
		const cpuDrop = -pctChange(baseline.cpu?.estimatedCpuMs, current.cpu?.estimatedCpuMs);
		if (runtimeDrop < thresholds.browserImprovement.targetRuntimeDropPct) failures.push(`${file}: runtime drop ${runtimeDrop.toFixed(1)}% is below target ${thresholds.browserImprovement.targetRuntimeDropPct}%`);
		if (cpuDrop < thresholds.browserImprovement.targetCpuDropPct) failures.push(`${file}: CPU drop ${cpuDrop.toFixed(1)}% is below target ${thresholds.browserImprovement.targetCpuDropPct}%`);
	}
}

if (failures.length > 0) {
	console.error(`[metrics:check] ${failures.length} failure(s):`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

console.log(`[metrics:check] passed ${baselineFiles.length} metric comparison(s) (${relative(projectRoot, baselineDir)} → ${relative(projectRoot, currentDir)})`);
