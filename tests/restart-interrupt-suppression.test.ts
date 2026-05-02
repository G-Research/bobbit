/**
 * Pinned regression: restart-interrupted verification steps no longer
 * mark the gate as failed. The gate is left pending so the team-lead
 * can re-signal cleanly.
 *
 * Live test (PR #409 0e4fc54c plan-approval UX): every gateway
 * restart hit Eve's `implementation` gate mid-verification and
 * produced a false-negative "Step was running but had no session ID
 * — cannot resume after restart" failure. Four such restart-induced
 * failures in a row sent user-visible noise. Eve spent turns
 * repeatedly re-signalling instead of moving forward.
 *
 * Root cause: in `_resumeOneVerification`, command steps that were
 * `running` at restart had no rerun path (only llm-review and
 * agent-qa do). They fell through to a catch-all branch that pushed
 * a failed step record with output "Step was running but had no
 * session ID — cannot resume after restart". The verification then
 * computed `allPassed === false` → marked the gate failed → notified
 * the team-lead with a noisy failure message.
 *
 * Fix: when computing the overall result, check whether ALL failed
 * steps are restart-interrupts (output contains specific markers).
 * If so, mark the gate `pending` instead of `failed` and notify the
 * team-lead with a benign "interrupted, please re-signal" message.
 *
 * Real verification failures (where at least one failed step is NOT
 * a restart-interrupt) still mark the gate failed as before — we
 * never paper over genuine failures.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface ResolvedStep {
	name: string;
	type: string;
	passed: boolean;
	output: string;
	duration_ms: number;
}

const RESTART_INTERRUPT_MARKERS = [
	"Step was running but had no session ID",
	"Step was interrupted by server restart",
];

/** Replicates the suppression decision predicate. */
function shouldSuppressAsRestartInterrupt(steps: ResolvedStep[]): boolean {
	const failed = steps.filter(s => !s.passed);
	if (failed.length === 0) return false;
	return failed.every(r => RESTART_INTERRUPT_MARKERS.some(m => r.output.includes(m)));
}

describe("restart-interrupt suppression predicate", () => {
	it("THE bug: ALL failed steps are restart-interrupts -> suppress", () => {
		const steps: ResolvedStep[] = [
			{ name: "Build", type: "command", passed: true, output: "OK", duration_ms: 1000 },
			{ name: "Type check", type: "command", passed: false, output: "Step was running but had no session ID — cannot resume after restart.", duration_ms: 0 },
			{ name: "E2E tests", type: "command", passed: false, output: "Step was running but had no session ID — cannot resume after restart.", duration_ms: 0 },
		];
		assert.equal(shouldSuppressAsRestartInterrupt(steps), true);
	});

	it("ONE real failure mixed with restart-interrupts -> NOT suppressed (real bug wins)", () => {
		// We never paper over a genuine verification failure. If any
		// failed step has a non-interrupt output, mark the gate failed.
		const steps: ResolvedStep[] = [
			{ name: "Type check", type: "command", passed: false, output: "Step was running but had no session ID — cannot resume after restart.", duration_ms: 0 },
			{ name: "Code review", type: "llm-review", passed: false, output: "FAIL: implementation does not address the design doc's Section 3.", duration_ms: 12000 },
		];
		assert.equal(shouldSuppressAsRestartInterrupt(steps), false);
	});

	it("all steps passed -> NOT suppressed (no failure to suppress)", () => {
		const steps: ResolvedStep[] = [
			{ name: "Build", type: "command", passed: true, output: "OK", duration_ms: 1000 },
		];
		assert.equal(shouldSuppressAsRestartInterrupt(steps), false);
	});

	it("explicit interrupt-message variant: 'Step was interrupted by server restart'", () => {
		// Future-proofing: an alternate marker string that the harness
		// might emit for subgoal/QA paths in some recovery scenarios.
		const steps: ResolvedStep[] = [
			{ name: "Subgoal A", type: "subgoal", passed: false, output: "Step was interrupted by server restart and rerun was unavailable. Re-signal the gate to retry.", duration_ms: 0 },
		];
		assert.equal(shouldSuppressAsRestartInterrupt(steps), true);
	});

	it("REAL command-step failure (no marker) -> NOT suppressed", () => {
		const steps: ResolvedStep[] = [
			{ name: "Type check", type: "command", passed: false, output: "tsc error TS2339: Property 'foo' does not exist on type 'Bar'.", duration_ms: 8000 },
		];
		assert.equal(shouldSuppressAsRestartInterrupt(steps), false);
	});

	it("empty step list -> NOT suppressed", () => {
		assert.equal(shouldSuppressAsRestartInterrupt([]), false);
	});

	it("output substring matches anywhere in the string, not just the prefix", () => {
		// Some output may have a prefix (e.g. step name in stdout)
		// before the interrupt marker. The check is .includes, not
		// .startsWith, so it tolerates this.
		const steps: ResolvedStep[] = [
			{ name: "Unit", type: "command", passed: false, output: "Some prelude...\nStep was running but had no session ID — cannot resume after restart.", duration_ms: 0 },
		];
		assert.equal(shouldSuppressAsRestartInterrupt(steps), true);
	});
});
