#!/usr/bin/env node
import { measureCommand, metricFile, npxCommand, parsePlaywrightJson, pathFromRoot } from "./lib.mjs";

const reportFile = pathFromRoot(".profiles", "metrics", "playwright-unit-browser.json");
const workers = process.env.BOBBIT_UNIT_BROWSER_WORKERS || process.env.BOBBIT_METRICS_UNIT_BROWSER_WORKERS || "4";

await measureCommand({
	name: "unit-browser",
	kind: "unit-browser",
	command: npxCommand(),
	args: ["playwright", "test", "--config", "tests/playwright.config.ts", "--workers", workers, "--reporter=json"],
	outFile: metricFile("unit-browser"),
	shell: process.platform === "win32",
	env: { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
	parseArtifacts: async () => ({ tests: parsePlaywrightJson(reportFile) }),
});
