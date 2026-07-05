/**
 * Pure JSON → summary-counts logic for scripts/run-playwright-e2e.mjs.
 *
 * Background (see docs on the masked-failures incident cited in the commit
 * that added this file): the human-facing `list`/`line` Playwright reporters
 * are meant to be read by eyes, not greped by a gate. On a run with heavy
 * scrollback, ANSI cursor-movement/erase sequences can land immediately
 * before playwright's own "N failed" line, so a naive substring/regex match
 * over raw stdout silently sees nothing where a human sees the failure count
 * plainly. Gate orchestration must never again reconstruct pass/fail counts
 * by grepping decorated human output.
 *
 * The fix: also run Playwright's built-in `json` reporter to a file (see
 * playwright-e2e.config.ts, gated on BOBBIT_E2E_JSON_REPORT_PATH), and derive
 * one plain, ANSI-free, machine-parseable summary line from THAT — never
 * from the human reporter's stdout. This module is the pure "JSON report ->
 * counts" seam, extracted so it can be unit tested directly (see
 * tests/playwright-json-summary.test.ts) instead of only via a slow
 * end-to-end Playwright invocation.
 *
 * Playwright's own `stats` object (`{ expected, unexpected, flaky, skipped }`)
 * conflates two different things under `skipped`: tests explicitly marked
 * `.skip()`, and tests that never ran at all because the run was interrupted
 * (e.g. --max-failures, a crashed worker). We want those reported separately
 * (`skipped` vs `didNotRun`), so we walk the suite tree ourselves to count
 * tests with zero results (never executed) and subtract that count from
 * `stats.skipped` to recover the "genuinely skipped" count. This has been
 * verified empirically against real Playwright JSON reporter output (see PR
 * description) for: all-pass, mixed pass/fail, explicit .skip(), and
 * --max-failures-interrupted runs.
 */

function numberOr(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Recursively count test entries with zero results — i.e. never executed. */
function countDidNotRun(suites) {
	if (!Array.isArray(suites)) return 0;
	let count = 0;
	for (const suite of suites) {
		for (const spec of suite?.specs ?? []) {
			for (const test of spec?.tests ?? []) {
				if (!Array.isArray(test?.results) || test.results.length === 0) count++;
			}
		}
		count += countDidNotRun(suite?.suites);
	}
	return count;
}

/**
 * Summarize a parsed Playwright JSON reporter report into plain counts.
 * Throws if `report` doesn't look like a Playwright JSON report (missing
 * `stats`) — callers should catch and treat that as "summary unavailable"
 * rather than reporting fabricated zero counts.
 */
export function summarizePlaywrightReport(report) {
	const stats = report?.stats;
	if (!stats || typeof stats !== "object") {
		throw new Error("playwright JSON report is missing a top-level `stats` object");
	}

	const passed = numberOr(stats.expected, 0);
	const failed = numberOr(stats.unexpected, 0);
	const flaky = numberOr(stats.flaky, 0);
	const statsSkipped = numberOr(stats.skipped, 0);

	const didNotRun = countDidNotRun(report.suites);
	const skipped = Math.max(0, statsSkipped - didNotRun);
	const total = passed + failed + flaky + skipped + didNotRun;

	return { passed, failed, flaky, skipped, didNotRun, total };
}

/** Format the counts as the single plain, ANSI-free gate-parseable line. */
export function formatE2ESummaryLine(counts) {
	return `[e2e-summary] passed=${counts.passed} failed=${counts.failed} flaky=${counts.flaky} skipped=${counts.skipped} didNotRun=${counts.didNotRun} total=${counts.total}`;
}

/** Distinct, unambiguous line for when no summary could be derived at all — never emits the passed=/failed=... shape so a gate parser can't mistake "unavailable" for "zero everywhere". */
export function formatE2ESummaryUnavailableLine(reason) {
	return `[e2e-summary] status=unavailable reason=${JSON.stringify(String(reason))}`;
}
