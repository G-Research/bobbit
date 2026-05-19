import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, summarizeDiagnostics, aggregateRuns } from "../scripts/bench-server-cpu.mjs";

describe("bench-server-cpu CLI parsing", () => {
	it("parses workload options and derived summary path", () => {
		const opts = parseArgs([
			"--workload", "goal-fanout",
			"--duration", "12",
			"--runs", "2",
			"--out", "artifacts/cpu/multi.jsonl",
			"--tabs", "7",
			"--flush-ms=500",
		]);

		assert.equal(opts.workload, "goal-fanout");
		assert.equal(opts.durationSec, 12);
		assert.equal(opts.runs, 2);
		assert.equal(opts.tabs, 7);
		assert.equal(opts.flushMs, 500);
		assert.equal(opts.summaryOut, "artifacts/cpu/multi.summary.json");
	});

	it("applies smoke defaults without requiring a long benchmark", () => {
		const opts = parseArgs(["--smoke", "--out", "artifacts/cpu/smoke.jsonl"]);

		assert.equal(opts.workload, "idle");
		assert.equal(opts.durationSec, 5);
		assert.equal(opts.runs, 1);
		assert.equal(opts.flushMs, 250);
		assert.equal(opts.smoke, true);
	});

	it("rejects unknown workloads", () => {
		assert.throws(
			() => parseArgs(["--workload", "unknown"]),
			/Unknown workload/,
		);
	});
});

describe("bench-server-cpu summary generation", () => {
	it("summarizes CPU, REST, and WS diagnostics", () => {
		const summary = summarizeDiagnostics([
			{
				kind: "cpu",
				wallMs: 1000,
				cpuUserMs: 20,
				cpuSystemMs: 10,
				cpuPct: 3,
				delayP95Ms: 4,
				rest: { "GET /api/projects": { count: 2, p95Ms: 5, bytes: 100 } },
				ws: { "session:message_update": { frames: 4, bytes: 400, recipients: 4 } },
			},
			{
				kind: "cpu",
				wallMs: 1000,
				cpuUserMs: 50,
				cpuSystemMs: 10,
				cpuPct: 6,
				delayP95Ms: 8,
				rest: { "GET /api/sessions": { count: 3, p95Ms: 7, bytes: 200 } },
				ws: { "goal:gate_status_changed": { frames: 1, bytes: 100, recipients: 2, scanned: 5, matchedGoal: 1, fallback: 1 } },
			},
		], { durationSec: 2 });

		assert.equal(summary.sampleCount, 2);
		assert.equal(summary.medianCpuPct, 4.5);
		assert.equal(summary.p95EventLoopDelayMs, 8);
		assert.equal(summary.restRequestCount, 5);
		assert.equal(summary.restRequestsPerSec, 2.5);
		assert.equal(summary.restP95Ms, 7);
		assert.equal(summary.wsFrameCount, 5);
		assert.equal(summary.wsFramesPerSec, 2.5);
		assert.equal(summary.wsByteCount, 500);
		assert.equal(summary.wsBytesPerSec, 250);
		assert.equal(summary.wsRecipientCount, 6);
		assert.equal(summary.wsRecipientsPerSec, 3);
		assert.equal(summary.wsTypes["goal:gate_status_changed"].scanned, 5);
		assert.equal(summary.wsTypes["goal:gate_status_changed"].matchedGoal, 1);
		assert.equal(summary.wsTypes["goal:gate_status_changed"].fallback, 1);
	});

	it("aggregates run summaries with command metadata", () => {
		const aggregate = aggregateRuns(
			{ workload: "idle", runs: 2, durationSec: 5, commit: "abc", node: process.version },
			[
				{ run: 1, success: true, metrics: { medianCpuPct: 2, p95EventLoopDelayMs: 4, restP95Ms: 1, wsFramesPerSec: 0, wsBytesPerSec: 0 }, diagnosticsPath: "a.jsonl", diagnosticsRecords: 1, diagnosticsParseErrors: 0, workloadResult: { ok: true } },
				{ run: 2, success: true, metrics: { medianCpuPct: 4, p95EventLoopDelayMs: 6, restP95Ms: 3, wsFramesPerSec: 2, wsBytesPerSec: 20 }, diagnosticsPath: "b.jsonl", diagnosticsRecords: 1, diagnosticsParseErrors: 0, workloadResult: { ok: true } },
			],
		);

		assert.equal(aggregate.kind, "benchmark_summary");
		assert.equal(aggregate.workload, "idle");
		assert.equal(aggregate.successfulRuns, 2);
		assert.equal(aggregate.medianCpuPct, 3);
		assert.equal(aggregate.wsRecipientsPerSec, null);
		assert.deepEqual(aggregate.diagnosticsPaths, ["a.jsonl", "b.jsonl"]);
	});
});
