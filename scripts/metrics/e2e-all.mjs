#!/usr/bin/env node
import { ensureFullBuild, measureCommand, metricFile, parsePlaywrightJson, pathFromRoot, schemaVersion, writeJson } from "./lib.mjs";

ensureFullBuild();

const reportFile = pathFromRoot(".profiles", "metrics", "playwright-e2e-all.json");

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

for (const [project, tests] of Object.entries(projects)) {
	const split = {
		schemaVersion,
		metricName: `e2e-${project}`,
		kind: "e2e-project-split-from-full",
		createdAt: new Date().toISOString(),
		status: tests.failed > 0 ? "failed" : full.status,
		exitCode: tests.failed > 0 ? 1 : full.exitCode,
		derivedFrom: "e2e-full",
		durationMs: tests.durationMs,
		cpu: { ...full.cpu, splitNote: "CPU is measured for the full one-pass E2E run; project CPU is not separable from Playwright's parallel execution." },
		memory: { ...full.memory, splitNote: "Peak RSS is measured for the full one-pass E2E run." },
		tests,
	};
	writeJson(metricFile(`e2e-${project}`), split);
	console.log(`[metrics] wrote .profiles/metrics/e2e-${project}.json from one full E2E run`);
}
