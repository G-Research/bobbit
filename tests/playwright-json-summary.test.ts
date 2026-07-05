/**
 * Pinning test for the machine-readable E2E summary line (scripts/run-playwright-e2e.mjs
 * + scripts/playwright-json-summary.mjs).
 *
 * Incident this guards against: a run WITH real test failures streamed the
 * human `list`/`line` Playwright reporter's decorated stdout (which can carry
 * ANSI cursor-erase sequences immediately before its own "N failed" line) to
 * gate orchestration, which grepped that stdout for pass/fail counts. The
 * ANSI prefix masked the failure text and the gate mis-extracted "0 failed"
 * across five merge windows. The fix moved count derivation off human stdout
 * entirely and onto Playwright's own JSON reporter output, summarized by the
 * pure `summarizePlaywrightReport` seam exercised here — directly, without
 * spawning a real (~minutes-long) Playwright run.
 *
 * Report fixtures below are hand-built to match the real shape emitted by
 * Playwright's built-in `json` reporter (verified empirically against an
 * actual run: top-level `stats: { expected, unexpected, flaky, skipped }`,
 * plus `suites[].specs[].tests[].results[]` with zero-length `results` for
 * tests that never ran, e.g. after `--max-failures` interrupts a run).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatE2ESummaryLine, formatE2ESummaryUnavailableLine, summarizePlaywrightReport } from "../scripts/playwright-json-summary.mjs";

function specWithResults(title: string, resultStatuses: string[]) {
	return {
		title,
		tests: [
			{
				expectedStatus: resultStatuses.at(-1) === "skipped" ? "skipped" : "passed",
				results: resultStatuses.map((status) => ({ status })),
			},
		],
	};
}

test("all-pass report: passed=N, everything else 0", () => {
	const report = {
		stats: { expected: 3, unexpected: 0, flaky: 0, skipped: 0 },
		suites: [{ specs: [
			specWithResults("a", ["passed"]),
			specWithResults("b", ["passed"]),
			specWithResults("c", ["passed"]),
		] }],
	};
	const counts = summarizePlaywrightReport(report);
	assert.deepEqual(counts, { passed: 3, failed: 0, flaky: 0, skipped: 0, didNotRun: 0, total: 3 });
	assert.equal(formatE2ESummaryLine(counts), "[e2e-summary] passed=3 failed=0 flaky=0 skipped=0 didNotRun=0 total=3");
});

test("mixed pass/fail/skip report — this is the shape that must never read as all-pass", () => {
	const report = {
		stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 1 },
		suites: [{ specs: [
			specWithResults("passes", ["passed"]),
			specWithResults("fails", ["failed"]),
			specWithResults("skipped", ["skipped"]),
		] }],
	};
	const counts = summarizePlaywrightReport(report);
	assert.deepEqual(counts, { passed: 1, failed: 1, flaky: 0, skipped: 1, didNotRun: 0, total: 3 });
	assert.equal(formatE2ESummaryLine(counts), "[e2e-summary] passed=1 failed=1 flaky=0 skipped=1 didNotRun=0 total=3");
});

test("flaky (retried then passed) is counted separately from passed and failed", () => {
	const report = {
		stats: { expected: 1, unexpected: 0, flaky: 1, skipped: 0 },
		suites: [{ specs: [
			specWithResults("stable", ["passed"]),
			specWithResults("flaky", ["failed", "passed"]),
		] }],
	};
	const counts = summarizePlaywrightReport(report);
	assert.deepEqual(counts, { passed: 1, failed: 0, flaky: 1, skipped: 0, didNotRun: 0, total: 2 });
});

test("--max-failures-interrupted run: never-executed tests count as didNotRun, not skipped", () => {
	// Mirrors real Playwright JSON output: a test that never ran has an empty
	// `results` array, and playwright's own `stats.skipped` folds it in with
	// genuinely-skipped tests. summarizePlaywrightReport must separate them.
	const report = {
		stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 1 },
		suites: [{ specs: [
			specWithResults("passes", ["passed"]),
			specWithResults("fails", ["failed"]),
			{ title: "neverruns", tests: [{ expectedStatus: "passed", results: [] }] },
		] }],
	};
	const counts = summarizePlaywrightReport(report);
	assert.deepEqual(counts, { passed: 1, failed: 1, flaky: 0, skipped: 0, didNotRun: 1, total: 3 });
	assert.equal(formatE2ESummaryLine(counts), "[e2e-summary] passed=1 failed=1 flaky=0 skipped=0 didNotRun=1 total=3");
});

test("nested suites (project > file > describe) are walked recursively", () => {
	const report = {
		stats: { expected: 2, unexpected: 0, flaky: 0, skipped: 0 },
		suites: [{
			title: "project",
			specs: [],
			suites: [{
				title: "file.spec.ts",
				specs: [specWithResults("a", ["passed"])],
				suites: [{ title: "describe block", specs: [specWithResults("b", ["passed"])] }],
			}],
		}],
	};
	const counts = summarizePlaywrightReport(report);
	assert.deepEqual(counts, { passed: 2, failed: 0, flaky: 0, skipped: 0, didNotRun: 0, total: 2 });
});

test("the summary line contains no ANSI escape sequences", () => {
	const counts = summarizePlaywrightReport({
		stats: { expected: 0, unexpected: 5, flaky: 0, skipped: 0 },
		suites: [{ specs: [specWithResults("fails", ["failed"])] }],
	});
	const line = formatE2ESummaryLine(counts);
	// eslint-disable-next-line no-control-regex
	assert.doesNotMatch(line, /\x1b\[/);
	assert.match(line, /^\[e2e-summary\] passed=\d+ failed=\d+ flaky=\d+ skipped=\d+ didNotRun=\d+ total=\d+$/);
});

test("a report missing `stats` throws — callers must treat this as unavailable, not fabricate zeros", () => {
	assert.throws(() => summarizePlaywrightReport({}), /stats/);
	assert.throws(() => summarizePlaywrightReport(null), /stats/);
});

test("the unavailable line never matches the passed=/failed=... shape, so a gate parser can't confuse it with real zero counts", () => {
	const line = formatE2ESummaryUnavailableLine("ENOENT: no such file");
	assert.doesNotMatch(line, /passed=\d/);
	assert.match(line, /^\[e2e-summary\] status=unavailable reason=/);
	// eslint-disable-next-line no-control-regex
	assert.doesNotMatch(line, /\x1b\[/);
});
