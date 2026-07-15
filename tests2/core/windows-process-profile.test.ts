import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { aggregateProcessRecords } from "../../scripts/testing-v2/profile-windows-unit.mjs";

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
});
