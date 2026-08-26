#!/usr/bin/env node
import { ensureFullBuild, measureCommand, metricFile, parsePlaywrightJson, pathFromRoot, playwrightE2EMetricProjects } from "./lib.mjs";

const project = process.argv[2];
if (!project || !playwrightE2EMetricProjects.includes(project)) {
	console.error(`Usage: node scripts/metrics/e2e-project.mjs <${playwrightE2EMetricProjects.join("|")}>`);
	process.exit(1);
}

ensureFullBuild();

const reportFile = pathFromRoot(".profiles", "metrics", `playwright-e2e-${project}.json`);

await measureCommand({
	name: `e2e-${project}`,
	kind: "e2e-project",
	command: process.execPath,
	args: ["scripts/run-playwright-e2e.mjs", "--project", project, "--reporter=json"],
	outFile: metricFile(`e2e-${project}`),
	env: { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
	parseArtifacts: async () => ({ tests: parsePlaywrightJson(reportFile) }),
});
