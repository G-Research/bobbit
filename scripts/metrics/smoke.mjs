#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineMetricFile, metricFile, writeJson } from "./lib.mjs";

const root = mkdtempSync(join(tmpdir(), "bobbit-metrics-smoke-"));
const baselineDir = join(root, "baseline");
const currentDir = join(root, "current");
const badCurrentDir = join(root, "bad-current");
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

try {
	const baselineCoveragePath = baselineMetricFile("coverage", baselineDir);
	const scopedCurrentPath = metricFile("coverage", scopedCurrentDir);
	writeJson(baselineCoveragePath, sampleMetric());
	writeJson(metricFile("coverage", currentDir), sampleMetric({ durationMs: 10_500, cpu: { estimatedCpuMs: 8_200, averageCpuPercent: 78, peakCpuPercent: 140 } }));
	writeJson(metricFile("coverage", badCurrentDir), sampleMetric({
		coverage: {
			lines: { covered: 850, total: 1000, pct: 85 },
			functions: { covered: 85, total: 100, pct: 85 },
			branches: { covered: 75, total: 100, pct: 75 },
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

	const fail = runCheck(badCurrentDir);
	if ((fail.status ?? 0) === 0) throw new Error("expected metrics:check to fail for coverage regression");

	console.log("[metrics:smoke] passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
