#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { baselineMetricFile, baselineMetricsDir, copyMetricToBaseline, ensureDir, listJsonFiles, metricFile, npmCommand, npmRunArgs, projectRoot, requiredMetricNames, runSyncStep, writeJson } from "./lib.mjs";

const metricsToCopy = requiredMetricNames;
const retiredBaselineMetrics = ["e2e-api-realpush"];
const coverageMapOnly = process.argv.includes("--coverage-map-only");
const effectiveBaselineMetricsDir = process.env.BOBBIT_METRICS_BASELINE_DIR
	? resolve(process.env.BOBBIT_METRICS_BASELINE_DIR)
	: baselineMetricsDir;
const coverageMapPath = join(effectiveBaselineMetricsDir, "coverage-map.md");
const baselineSectionStart = "<!-- baseline-metric-files:start -->";
const baselineSectionEnd = "<!-- baseline-metric-files:end -->";

const commands = [
	"metrics:coverage",
	"metrics:unit:node",
	"metrics:unit:browser",
	"metrics:e2e:all",
	"metrics:slice:renderer",
	"metrics:slice:scroll",
	"metrics:slice:sidebar",
];

function baselineMetricBlock(baselineFiles) {
	const rows = baselineFiles.length > 0
		? baselineFiles.map((file) => `- \`${file}\``).join("\n")
		: "- _No baseline metric files found._";
	return `${baselineSectionStart}\n${rows}\n\nThresholds: \`thresholds.json\`.\n${baselineSectionEnd}`;
}

function defaultCoverageMapPrefix() {
	return `# Browser E2E coverage map

This generated fallback records coverage by canonical semantic cell. Baseline metric files are committed as \`docs/testing-metrics/baseline-<name>.json\`; current runtime metrics remain under \`.profiles/metrics/<name>.json\`.

## Coverage ownership

| Behavior | Fast deterministic coverage | Retained real-fidelity coverage |
|---|---|---|
| Renderer, panel, status, and preview behavior | \`tests/dom/**/*.dom.test.ts\` and \`tests/browser/fixtures/**/*.fixture.spec.ts\` | \`tests/e2e/browser/**/*.browser-e2e.spec.ts\` only when real gateway/process wiring is essential |
| Scroll and viewport geometry | \`tests/browser/fixtures/**/*.fixture.spec.ts\` | Retain a browser E2E only for real streaming, reload, or process-bound behavior |
| Sidebar state and navigation | \`tests/dom/**/*.dom.test.ts\`, \`tests/integration/gateway/**/*.gateway.test.ts\`, and normal journeys under \`tests/browser/journeys/**/*.journey.spec.ts\` | Retain a browser E2E only for real persistence, WebSocket, restart, or cross-process behavior |

## Coverage-map update rules

1. Add or identify canonical replacement coverage before deleting or skipping a real-fidelity browser row.
2. Keep normal mock-gateway journeys in \`tests/browser/journeys/\`; use \`tests/e2e/browser/\` only when real process, restart, Docker, or pack fidelity defines the test.
3. Measure the relevant slice before the complete E2E lane.
4. Use \`metrics:e2e:all\` for final split-suite validation.
`;
}

function updateCoverageMapBaselineSection(baselineFiles) {
	ensureDir(effectiveBaselineMetricsDir);
	const generatedBlock = baselineMetricBlock(baselineFiles);
	let existing = existsSync(coverageMapPath)
		? readFileSync(coverageMapPath, "utf8")
		: `${defaultCoverageMapPrefix()}\n## Baseline metric files\n\n${generatedBlock}\n`;

	if (existing.includes(baselineSectionStart) && existing.includes(baselineSectionEnd)) {
		existing = existing.replace(
			new RegExp(`${baselineSectionStart}[\\s\\S]*?${baselineSectionEnd}`, "u"),
			generatedBlock,
		);
	} else if (existing.includes("## Baseline metric files")) {
		existing = existing.replace(
			/(## Baseline metric files\n\n)[\s\S]*?(?=\n## |\s*$)/u,
			`$1${generatedBlock}\n`,
		);
	} else {
		existing = `${existing.trimEnd()}\n\n## Baseline metric files\n\n${generatedBlock}\n`;
	}

	writeFileSync(coverageMapPath, existing.endsWith("\n") ? existing : `${existing}\n`);
}

for (const metric of retiredBaselineMetrics) {
	const retiredBaseline = baselineMetricFile(metric, effectiveBaselineMetricsDir);
	if (existsSync(retiredBaseline)) rmSync(retiredBaseline, { force: true });
}

if (!coverageMapOnly) {
	for (const script of commands) {
		runSyncStep(script, npmCommand(), npmRunArgs(script), { shell: process.platform === "win32" });
	}

	const missingRequired = requiredMetricNames.filter((metric) => !existsSync(metricFile(metric)));
	if (missingRequired.length > 0) {
		throw new Error(`metrics:baseline missing required current metric file(s): ${missingRequired.map((metric) => metricFile(metric).replace(projectRoot, ".")).join(", ")}`);
	}

	ensureDir(baselineMetricsDir);
	for (const metric of metricsToCopy) {
		const obsoleteUnprefixedBaseline = metricFile(metric, baselineMetricsDir);
		if (existsSync(obsoleteUnprefixedBaseline)) rmSync(obsoleteUnprefixedBaseline, { force: true });
		if (existsSync(metricFile(metric))) copyMetricToBaseline(metric);
	}

	const thresholdsPath = join(baselineMetricsDir, "thresholds.json");
	if (!existsSync(thresholdsPath)) {
		writeJson(thresholdsPath, {
			coverageMinDeltaPct: -0.10,
			runtimeMaxIncreaseRatio: 1.50,
			runtimeMaxIncreaseMs: 60000,
			cpuMaxIncreaseRatio: 1.75,
			cpuMaxIncreaseMs: 120000,
			memoryMaxIncreaseRatio: 1.75,
			memoryMaxIncreaseBytes: 536870912,
			browserImprovement: {
				enabled: false,
				targetRuntimeDropPct: 40,
				targetCpuDropPct: 40,
			},
		});
	}
}

const baselineFiles = listJsonFiles(effectiveBaselineMetricsDir).filter((file) => file.startsWith("baseline-"));
updateCoverageMapBaselineSection(baselineFiles);
console.log(`[metrics:baseline] wrote coverage map baseline section to ${coverageMapPath.replace(projectRoot, ".")}`);
if (!coverageMapOnly) console.log(`[metrics:baseline] wrote baselines to ${baselineMetricsDir.replace(projectRoot, ".")}`);
