#!/usr/bin/env node
import { relative } from "node:path";
import { ensureFullBuild, measureCommand, metricFile, parsePlaywrightJson, pathFromRoot, projectRoot, schemaVersion, writeJson } from "./lib.mjs";

ensureFullBuild();

const reportFile = pathFromRoot(".profiles", "metrics", "playwright-e2e-all.json");
const attributionMethod = "project-duration-share-largest-remainder";

function projectWeight(project, tests, weightSource) {
	if (weightSource === "durationMs") return tests.durationMs;
	if (weightSource === "testCount") return tests.total;
	return 1;
}

function chooseWeightSource(projectEntries) {
	if (projectEntries.some(([, tests]) => tests.durationMs > 0)) return "durationMs";
	if (projectEntries.some(([, tests]) => tests.total > 0)) return "testCount";
	return "equalProjectShare";
}

function allocateIntegerTotal(total, weightedEntries) {
	const roundedTotal = Math.max(0, Math.round(Number(total) || 0));
	const positiveWeightTotal = weightedEntries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
	const weightTotal = positiveWeightTotal > 0 ? positiveWeightTotal : weightedEntries.length;
	const rows = weightedEntries.map((entry) => {
		const weight = positiveWeightTotal > 0 ? Math.max(0, entry.weight) : 1;
		const exact = weightTotal > 0 ? (roundedTotal * weight) / weightTotal : 0;
		const floor = Math.floor(exact);
		return { ...entry, exact, value: floor, remainder: exact - floor };
	});
	let remaining = roundedTotal - rows.reduce((sum, row) => sum + row.value, 0);
	for (const row of [...rows].sort((a, b) => b.remainder - a.remainder || a.project.localeCompare(b.project))) {
		if (remaining <= 0) break;
		row.value += 1;
		remaining -= 1;
	}
	return Object.fromEntries(rows.map((row) => [row.project, row.value]));
}

function pct(value) {
	return Number(value.toFixed(6));
}

const full = await measureCommand({
	name: "e2e-full",
	kind: "e2e-full",
	command: process.execPath,
	args: ["scripts/run-playwright-e2e.mjs", "--reporter=json"],
	outFile: metricFile("e2e-full"),
	env: { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
	parseArtifacts: async () => ({ tests: parsePlaywrightJson(reportFile) }),
});

const projects = full.tests?.projects;
if (!projects || typeof projects !== "object") {
	throw new Error("metrics:e2e:all could not derive project splits from the Playwright JSON report");
}
for (const project of ["api", "browser"]) {
	if (!projects[project]) throw new Error(`metrics:e2e:all missing required ${project} project split in the Playwright JSON report`);
}

const projectEntries = Object.entries(projects).sort(([a], [b]) => a.localeCompare(b));
const weightSource = chooseWeightSource(projectEntries);
const weightedEntries = projectEntries.map(([project, tests]) => ({
	project,
	weight: projectWeight(project, tests, weightSource),
}));
const positiveWeightTotal = weightedEntries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
const usesEqualFallback = positiveWeightTotal <= 0;
const totalWeight = usesEqualFallback ? (weightedEntries.length || 1) : positiveWeightTotal;
const totalProjectDurationMs = projectEntries.reduce((sum, [, tests]) => sum + Math.max(0, tests.durationMs), 0);
const cpuAllocations = allocateIntegerTotal(full.cpu?.estimatedCpuMs, weightedEntries);
const rssAllocations = allocateIntegerTotal(full.memory?.peakRssBytes, weightedEntries);
const sourceReport = relative(projectRoot, reportFile);

for (const [project, tests] of projectEntries) {
	const projectWeightValue = usesEqualFallback ? 1 : Math.max(0, projectWeight(project, tests, weightSource));
	const projectDurationShare = pct(projectWeightValue / totalWeight);
	const attributedCpuMs = cpuAllocations[project] || 0;
	const attributedPeakRssBytes = rssAllocations[project] || 0;
	const split = {
		schemaVersion,
		metricName: `e2e-${project}`,
		kind: "e2e-project-split-from-full",
		createdAt: new Date().toISOString(),
		status: tests.failed > 0 ? "failed" : full.status,
		exitCode: tests.failed > 0 ? 1 : full.exitCode,
		derivedFrom: "e2e-full",
		durationMs: tests.durationMs,
		attribution: {
			attributionMethod,
			sourceMetric: "e2e-full",
			sourceReport,
			weightSource,
			projectDurationMs: tests.durationMs,
			totalProjectDurationMs,
			projectTestCount: tests.total,
			projectDurationShare,
			totalProjectWeight: totalWeight,
			note: "CPU and RSS are attributed from the single full E2E process-tree measurement by project active-work share from the same Playwright JSON report; projects are not rerun.",
		},
		cpu: {
			estimatedCpuMs: attributedCpuMs,
			averageCpuPercent: tests.durationMs > 0 ? Number(((attributedCpuMs / tests.durationMs) * 100).toFixed(2)) : 0,
			peakCpuPercent: Number(((full.cpu?.peakCpuPercent || 0) * projectDurationShare).toFixed(2)),
			sampleMs: full.cpu?.sampleMs,
			attributionMethod,
			sourceMetric: "e2e-full.cpu.estimatedCpuMs",
			sourceEstimatedCpuMs: full.cpu?.estimatedCpuMs || 0,
			projectDurationShare,
		},
		memory: {
			peakRssBytes: attributedPeakRssBytes,
			attributionMethod,
			sourceMetric: "e2e-full.memory.peakRssBytes",
			sourcePeakRssBytes: full.memory?.peakRssBytes || 0,
			projectDurationShare,
		},
		tests,
	};
	writeJson(metricFile(`e2e-${project}`), split);
	console.log(`[metrics] wrote .profiles/metrics/e2e-${project}.json from one full E2E run with attributed CPU/RSS`);
}
