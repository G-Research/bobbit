#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ensureFullBuild, measureCommand, metricFile, parsePlaywrightJson, pathFromRoot, runSyncStep } from "./lib.mjs";

const slice = process.argv[2];
const executeSelections = process.argv.includes("--execute-selections");
const sliceMatchers = {
	renderer: [
		/render/i,
		/proposal/i,
		/review/i,
		/panel/i,
		/status-widget/i,
		/cost-popover/i,
		/prompt-stats-e2e/i,
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
		/search-e2e|search-result-navigation/i,
	],
};

if (!sliceMatchers[slice]) {
	console.error("Usage: node scripts/metrics/slice.mjs <renderer|scroll|sidebar>");
	process.exit(1);
}

function listSpecFiles(dir) {
	if (!existsSync(dir)) return [];
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listSpecFiles(full));
		else if (entry.name.endsWith(".spec.ts")) files.push(full);
	}
	return files;
}

function selectFiles(...directories) {
	return directories
		.flatMap((directory) => listSpecFiles(pathFromRoot(...directory)))
		.filter((file) => sliceMatchers[slice].some((matcher) => matcher.test(file)))
		.map((file) => relative(pathFromRoot(), file).replace(/\\/g, "/"))
		.sort();
}

// Canonical fixture/journey suites run under playwright-v2; real-browser
// fidelity runs under playwright-e2e.
const fixtureAndJourneyFiles = selectFiles(
	["tests", "browser", "fixtures"],
	["tests", "browser", "journeys"],
);
const browserE2eFiles = selectFiles(["tests", "e2e", "browser"]);
const selected = [...fixtureAndJourneyFiles, ...browserE2eFiles].sort();

if (selected.length === 0) {
	console.error(`[metrics] no browser files matched ${slice} slice`);
	process.exit(1);
}

const fixtureJourneyReport = pathFromRoot(".profiles", "metrics", `playwright-slice-${slice}-fixture-journey.json`);
const browserE2eReport = pathFromRoot(".profiles", "metrics", `playwright-slice-${slice}-browser-e2e.json`);

if (executeSelections) {
	const playwrightCli = pathFromRoot("node_modules", "playwright", "cli.js");
	if (fixtureAndJourneyFiles.length > 0) {
		runSyncStep(
			`${slice} fixture/journey slice`,
			process.execPath,
			[
				playwrightCli,
				"test",
				"--config", "playwright-v2.config.ts",
				"--reporter=json",
				...fixtureAndJourneyFiles,
				"--project", "browser-canonical",
			],
			{ env: { PLAYWRIGHT_JSON_OUTPUT_NAME: fixtureJourneyReport } },
		);
	}
	if (browserE2eFiles.length > 0) {
		runSyncStep(
			`${slice} browser E2E slice`,
			process.execPath,
			[
				"scripts/run-playwright-e2e.mjs",
				"--project", "browser-canonical",
				"--reporter=json",
				...browserE2eFiles,
			],
			{ env: { PLAYWRIGHT_JSON_OUTPUT_NAME: browserE2eReport } },
		);
	}
	process.exit(0);
}

function mergeTestSummaries(summaries) {
	const merged = {
		total: 0,
		passed: 0,
		failed: 0,
		skipped: 0,
		flaky: 0,
		nonSkipped: 0,
		durationMs: 0,
		files: {},
		projects: {},
	};
	const mergeBucket = (target, source) => {
		for (const key of ["total", "passed", "failed", "skipped", "flaky", "nonSkipped", "durationMs"]) {
			target[key] += source[key] || 0;
		}
	};
	for (const summary of summaries) {
		mergeBucket(merged, summary);
		for (const [file, bucket] of Object.entries(summary.files)) merged.files[file] = bucket;
		for (const [project, bucket] of Object.entries(summary.projects)) {
			if (!merged.projects[project]) merged.projects[project] = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, nonSkipped: 0, durationMs: 0, files: {} };
			mergeBucket(merged.projects[project], bucket);
			Object.assign(merged.projects[project].files, bucket.files);
		}
	}
	return merged;
}

console.log(`[metrics] ${slice} slice files (${selected.length}):\n${selected.map((file) => `  - ${file}`).join("\n")}`);
ensureFullBuild();

await measureCommand({
	name: `slice-${slice}`,
	kind: "e2e-browser-slice",
	command: process.execPath,
	args: ["scripts/metrics/slice.mjs", slice, "--execute-selections"],
	outFile: metricFile(`slice-${slice}`),
	parseArtifacts: async () => ({
		slice,
		files: selected,
		tests: mergeTestSummaries([
			...(fixtureAndJourneyFiles.length > 0 ? [parsePlaywrightJson(fixtureJourneyReport)] : []),
			...(browserE2eFiles.length > 0 ? [parsePlaywrightJson(browserE2eReport)] : []),
		]),
	}),
});
