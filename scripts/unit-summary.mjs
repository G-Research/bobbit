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

/**
 * Masked-failure cross-check (independent of the child process's own exit
 * code): each sub-phase's human reporter prints an unambiguous failure count
 * near the end of its output — node's TAP reporter emits `# fail N`,
 * Playwright's default reporter emits `N failed`. 13 real browser-fixture
 * failures were once observed alongside a 0 exit code from run-unit.mjs on a
 * loaded shared machine (root cause not fully pinned down — see
 * tests/run-unit-wrapper.test.ts); this never trusts a runner's reported
 * code alone when its own output says otherwise. Mirrors the precedent
 * already established for the E2E phase's masked-failures incident
 * (scripts/playwright-json-summary.mjs) — never reconstruct pass/fail from
 * decorated human text when that can be avoided, but when the ONLY signal
 * available is that text (the unit phase's reporters are not JSON), treat a
 * nonzero count in it as authoritative over a reported-0 exit code. This
 * never overrides an ALREADY-failing code; it only promotes a reported-0
 * result to failed.
 *
 * @param {string} label - "node-logic" or "browser-fixtures".
 * @param {string} outputText - the runner's captured stdout+stderr tail.
 * @returns {number} the detected failure count, or 0 if the output shows no
 *   failure signature (including for a label with no known signature).
 */
const FAILURE_SIGNATURES = {
	"node-logic": /^# fail (\d+)\s*$/m,
	"browser-fixtures": /^[ \t]*(\d+) failed\b/m,
};

export function detectMaskedFailureCount(label, outputText) {
	const pattern = FAILURE_SIGNATURES[label];
	if (!pattern) return 0;
	const match = pattern.exec(String(outputText ?? ""));
	if (!match) return 0;
	const n = Number(match[1]);
	return Number.isFinite(n) && n > 0 ? n : 0;
}
