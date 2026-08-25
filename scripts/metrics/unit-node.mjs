#!/usr/bin/env node
import { measureCommand, metricFile, npmCommand, npmRunArgs } from "./lib.mjs";

// Keep the historical metric name stable while measuring the complete canonical
// Vitest lane. Discovery and the fixed worker cap come from vitest.config.ts.
await measureCommand({
	name: "unit-node",
	kind: "unit",
	command: npmCommand(),
	args: npmRunArgs("test:unit", ["--retry=0"]),
	outFile: metricFile("unit-node"),
	shell: process.platform === "win32",
});
