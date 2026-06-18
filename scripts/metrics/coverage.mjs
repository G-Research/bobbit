#!/usr/bin/env node
import { measureCommand, metricFile, npmCommand, npmRunArgs, parseLcovTotals, pathFromRoot } from "./lib.mjs";

await measureCommand({
	name: "coverage",
	kind: "coverage",
	command: npmCommand(),
	args: npmRunArgs("test:coverage"),
	outFile: metricFile("coverage"),
	shell: process.platform === "win32",
	parseArtifacts: async () => ({
		coverage: parseLcovTotals(pathFromRoot("coverage", "lcov.info")),
	}),
});
