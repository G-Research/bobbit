/**
 * Pure per-phase-results → consolidated summary logic for scripts/run-unit.mjs.
 *
 * The unit phase already prints a per-runner line as each sub-phase finishes
 * (`[run-unit] <label> finished in Xs (exit Y)`) and a free-text result
 * summary. Neither is a stable, greppable shape a gate can rely on. This
 * module derives the one consolidated, ANSI-free, machine-parseable line —
 * `[unit-summary] node=<status> browser=<status>` — from the same
 * `{ label, code }` results run-unit.mjs already collects, extracted pure so
 * it's unit-testable without spawning the ~90s unit phase (see
 * tests/unit-summary.test.ts).
 *
 * A phase that was never run (TEST-01 affected-only selection skipped it
 * entirely) reports "skip" rather than being omitted — an omitted key reads
 * ambiguously as "didn't the gate check this?", while "skip" is explicit.
 */

/**
 * @param {Array<{ label: string, code: number }>} results - results actually
 *   produced by run-unit.mjs for the sub-phases that ran (0..2 entries).
 * @returns {{ node: "pass"|"fail"|"skip", browser: "pass"|"fail"|"skip" }}
 */
export function computeUnitSummary(results) {
	const byLabel = new Map((results ?? []).map((r) => [r.label, r.code]));
	const statusFor = (label) => {
		if (!byLabel.has(label)) return "skip";
		return byLabel.get(label) === 0 ? "pass" : "fail";
	};
	return { node: statusFor("node-logic"), browser: statusFor("browser-fixtures") };
}

/** Format the consolidated summary as the single plain gate-parseable line. */
export function formatUnitSummaryLine(summary) {
	return `[unit-summary] node=${summary.node} browser=${summary.browser}`;
}
