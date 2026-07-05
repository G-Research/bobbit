/**
 * Pinning test for scripts/unit-summary.mjs — the consolidated
 * `[unit-summary] node=<status> browser=<status>` line run-unit.mjs prints
 * after both sub-phases settle. Pattern mirrors tests/test-unit-args.test.ts:
 * exercise the pure seam directly instead of spawning the ~90s unit phase.
 *
 * See tests/playwright-json-summary.test.ts's header for why this pairing
 * matters: gate orchestration must have exactly one plain, ANSI-free,
 * greppable line per runner instead of reconstructing status from decorated
 * human output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeUnitSummary, formatUnitSummaryLine } from "../scripts/unit-summary.mjs";

test("both phases pass", () => {
	const results = [{ label: "node-logic", code: 0 }, { label: "browser-fixtures", code: 0 }];
	const summary = computeUnitSummary(results);
	assert.deepEqual(summary, { node: "pass", browser: "pass" });
	assert.equal(formatUnitSummaryLine(summary), "[unit-summary] node=pass browser=pass");
});

test("node fails, browser passes", () => {
	const results = [{ label: "node-logic", code: 1 }, { label: "browser-fixtures", code: 0 }];
	const summary = computeUnitSummary(results);
	assert.deepEqual(summary, { node: "fail", browser: "pass" });
	assert.equal(formatUnitSummaryLine(summary), "[unit-summary] node=fail browser=pass");
});

test("both phases fail", () => {
	const results = [{ label: "node-logic", code: 1 }, { label: "browser-fixtures", code: 1 }];
	const summary = computeUnitSummary(results);
	assert.deepEqual(summary, { node: "fail", browser: "fail" });
	assert.equal(formatUnitSummaryLine(summary), "[unit-summary] node=fail browser=fail");
});

test("a phase skipped by TEST-01 affected-only selection reports skip, not pass", () => {
	const results = [{ label: "node-logic", code: 0 }];
	const summary = computeUnitSummary(results);
	assert.deepEqual(summary, { node: "pass", browser: "skip" });
	assert.equal(formatUnitSummaryLine(summary), "[unit-summary] node=pass browser=skip");
});

test("a nonzero exit code other than 1 (e.g. a signal-derived code) still reports fail", () => {
	const results = [{ label: "node-logic", code: 137 }, { label: "browser-fixtures", code: 0 }];
	const summary = computeUnitSummary(results);
	assert.deepEqual(summary, { node: "fail", browser: "pass" });
});

test("the summary line contains no ANSI escape sequences", () => {
	const line = formatUnitSummaryLine(computeUnitSummary([{ label: "node-logic", code: 1 }]));
	// eslint-disable-next-line no-control-regex
	assert.doesNotMatch(line, /\x1b\[/);
	assert.match(line, /^\[unit-summary\] node=(pass|fail|skip) browser=(pass|fail|skip)$/);
});
