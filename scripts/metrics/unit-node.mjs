#!/usr/bin/env node
import { ensureServerBuild, measureCommand, metricFile, npxCommand } from "./lib.mjs";
import { NODE_UNIT_GLOBS } from "../test-phase-config.mjs";

ensureServerBuild();

const concurrency = process.env.BOBBIT_UNIT_NODE_CONCURRENCY || process.env.BOBBIT_METRICS_UNIT_NODE_CONCURRENCY || "4";

await measureCommand({
	name: "unit-node",
	kind: "unit-node",
	command: npxCommand(),
	args: [
		"tsx",
		"--import", "./tests/helpers/css-stub-loader.mjs",
		"--test",
		"--test-force-exit",
		`--test-concurrency=${concurrency}`,
		...NODE_UNIT_GLOBS,
	],
	outFile: metricFile("unit-node"),
	shell: process.platform === "win32",
});
