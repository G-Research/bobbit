import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
	VITEST_ENTRY,
	aggregateProcessRecords,
	buildVitestArgs,
	parseArgs,
	resolveWorkerLimit,
} from "../../scripts/testing-v2/profile-windows-unit.mjs";

const profilerPath = fileURLToPath(new URL("../../scripts/testing-v2/profile-windows-unit.mjs", import.meta.url));

describe("Windows unit child-process profiler", () => {
	it("aggregates executable cost and peak concurrency without retaining arguments", () => {
		const records = [
			{ type: "start", id: "1:1", executable: "git.exe", startedAt: 100 },
			{ type: "start", id: "1:2", executable: "cmd.exe", startedAt: 120 },
			{ type: "end", id: "1:2", executable: "cmd.exe", startedAt: 120, endedAt: 150, durationMs: 30, outcome: "failed" },
			{ type: "end", id: "1:1", executable: "git.exe", startedAt: 100, endedAt: 200, durationMs: 100, outcome: "ok" },
			{ type: "start", id: "1:3", executable: "node.exe", startedAt: 210 },
			{ type: "end", id: "1:3", executable: "node.exe", startedAt: 210, endedAt: 260, durationMs: 50, outcome: "timeout" },
			{ type: "start", id: "1:4", executable: "bash.exe", startedAt: 270 },
		];
		const report = aggregateProcessRecords(records);
		assert.equal(report.completed, 3);
		assert.equal(report.incomplete, 1);
		assert.equal(report.peakConcurrent, 2);
		assert.deepEqual(report.byExecutable.map((row: any) => row.executable), ["git.exe", "node.exe", "cmd.exe", "bash.exe"]);
		assert.equal(report.byExecutable[0].cumulativeMs, 100);
		assert.equal(report.byExecutable[1].timeouts, 1);
		assert.equal(report.byExecutable[2].failed, 1);
		assert.equal(report.byExecutable[3].incomplete, 1);
		assert.equal(JSON.stringify(report).includes("args"), false, "reports must never retain child arguments");
	});

	it("invokes Vitest directly with explicit projects and file filters", () => {
		assert.match(VITEST_ENTRY.replaceAll("\\", "/"), /\/node_modules\/vitest\/vitest\.mjs$/);
		const args = buildVitestArgs("core", ["tests2/core/windows-process-profile.test.ts"]);
		assert.equal(args[0], "run");
		assert.equal(args[1], "--config");
		assert.match(String(args[2]).replaceAll("\\", "/"), /\/vitest\.config\.ts$/);
		assert.deepEqual(args.slice(3), [
			"--project", "v2-core",
			"--silent=passed-only",
			"tests2/core/windows-process-profile.test.ts",
		]);

		assert.deepEqual(parseArgs([]).projects, ["v2-core", "v2-integration", "v2-dom", "v2-isolated"]);
		const options = parseArgs(["--lane", "integration", "--project=v2-dom", "tests2/dom/example.test.ts"]);
		assert.deepEqual(options.projects, ["v2-integration", "v2-dom"]);
		assert.deepEqual(options.filters, ["tests2/dom/example.test.ts"]);
	});

	it("keeps the fixed worker cap and excludes deleted unit orchestration", () => {
		assert.equal(resolveWorkerLimit(undefined, undefined), 3);
		assert.equal(resolveWorkerLimit("2", undefined), 2);
		assert.equal(resolveWorkerLimit("2", 3), 2);
		assert.equal(resolveWorkerLimit(undefined, 12), 3);

		const source = readFileSync(profilerPath, "utf8");
		for (const forbidden of [
			"run-unit-lanes.mjs",
			"ledger.mjs",
			"BOBBIT_V2_SLOTS",
			"BOBBIT_V2_LEDGER",
			".profiles/unit-lanes",
			"shardByCost",
			"BOBBIT_V2_GATEWAY_BOOT",
		]) {
			assert.equal(source.includes(forbidden), false, `profiler must not reference deleted unit orchestration: ${forbidden}`);
		}
	});
});
