#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ensureFullBuild, measureCommand, metricFile, parsePlaywrightJson, pathFromRoot } from "./lib.mjs";

const slice = process.argv[2];
const sliceMatchers = {
	renderer: [
		/render/i,
		/proposal/i,
		/review/i,
		/panel/i,
		/status-widget/i,
		/cost-popover/i,
		/dynamic-chat-tabs/i,
		/artifacts-pack/i,
		/preview/i,
		/ask-user-choices-ui/i,
	],
	scroll: [
		/jump-to-last-prompt/i,
		/tail-chat/i,
		/scroll/i,
		/pill-overflow/i,
		/mobile-review-commenting/i,
	],
	sidebar: [
		/sidebar/i,
		/single-project-sidebar/i,
		/mobile-staff-sidebar/i,
		/stories-sidebar/i,
	],
};

if (!sliceMatchers[slice]) {
	console.error("Usage: node scripts/metrics/slice.mjs <renderer|scroll|sidebar>");
	process.exit(1);
}

function listSpecFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listSpecFiles(full));
		else if (entry.name.endsWith(".spec.ts")) files.push(full);
	}
	return files;
}

const uiDir = pathFromRoot("tests", "e2e", "ui");
if (!existsSync(uiDir)) throw new Error(`Missing ${uiDir}`);
const selected = listSpecFiles(uiDir)
	.filter((file) => sliceMatchers[slice].some((matcher) => matcher.test(file)))
	.map((file) => relative(pathFromRoot(), file).replace(/\\/g, "/"))
	.sort();

if (selected.length === 0) {
	console.error(`[metrics] no E2E browser files matched ${slice} slice`);
	process.exit(1);
}

console.log(`[metrics] ${slice} slice files (${selected.length}):\n${selected.map((file) => `  - ${file}`).join("\n")}`);
ensureFullBuild();

const reportFile = pathFromRoot(".profiles", "metrics", `playwright-slice-${slice}.json`);

await measureCommand({
	name: `slice-${slice}`,
	kind: "e2e-browser-slice",
	command: process.execPath,
	args: ["scripts/run-playwright-e2e.mjs", "--project", "browser", "--reporter=json", ...selected],
	outFile: metricFile(`slice-${slice}`),
	env: { PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
	parseArtifacts: async () => ({ slice, files: selected, tests: parsePlaywrightJson(reportFile) }),
});
