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
	"Session lost during server restart",
	"Agent process exited unexpectedly",
	"Reviewer agent process died",
];

function isRestartInterrupt(r: { type: string; output: string }): boolean {
	if (RESTART_INTERRUPT_MARKERS.some(m => r.output.includes(m))) return true;
	// Empty-output llm-review / agent-qa failures: the reviewer
	// session was SIGTERM'd before emitting verification_result OR
	// writing any text. Treat as interrupt.
	if (r.output.trim() === "" && (r.type === "llm-review" || r.type === "agent-qa")) return true;
	return false;
}

/** Replicates the suppression decision predicate. */
function shouldSuppressAsRestartInterrupt(steps: ResolvedStep[]): boolean {
	const failed = steps.filter(s => !s.passed);
	if (failed.length === 0) return false;
	return failed.every(r => isRestartInterrupt(r));
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

	it("THE 2nd bug: empty-output llm-review failure is treated as restart-interrupt", () => {
		// Live test (PR #409 0e4fc54c): "Gap analysis" / "Code quality
		// review" / "Security review" all came back with output: ""
		// after every gateway restart — the reviewer session was
		// SIGTERM'd before emitting verification_result OR any text.
		// The original predicate ran .includes() on "" which returned
		// false; the gate was marked failed when it should have been
		// pending.
		const steps: ResolvedStep[] = [
			{ name: "Build", type: "command", passed: true, output: "OK", duration_ms: 1000 },
			{ name: "E2E tests", type: "command", passed: false, output: "Step was running but had no session ID — cannot resume after restart. Re-signal the gate to retry.", duration_ms: 0 },
			{ name: "Gap analysis", type: "llm-review", passed: false, output: "", duration_ms: 30000 },
			{ name: "Code quality review", type: "llm-review", passed: false, output: "", duration_ms: 30000 },
			{ name: "Security review", type: "llm-review", passed: false, output: "", duration_ms: 30000 },
		];
		assert.equal(shouldSuppressAsRestartInterrupt(steps), true,
			"empty llm-review outputs after restart should be treated as interrupts");
	});

	it("empty-output COMMAND failure is NOT auto-treated as interrupt (must have explicit marker)", () => {
		// A command step with empty output is unusual but might mean
		// a true silent failure (e.g. exit code 0 from a misconfigured
		// test runner that produces no output). Don't auto-suppress;
		// only suppress command failures that have the explicit
		// "Step was running" marker.
		const steps: ResolvedStep[] = [
			{ name: "Build", type: "command", passed: false, output: "", duration_ms: 0 },
		];
		assert.equal(shouldSuppressAsRestartInterrupt(steps), false);
	});

	it("empty-output llm-review with whitespace only is treated as interrupt", () => {
		const steps: ResolvedStep[] = [
			{ name: "Gap analysis", type: "llm-review", passed: false, output: "   \n  \n", duration_ms: 0 },
		];
		assert.equal(shouldSuppressAsRestartInterrupt(steps), true);
	});

	it("explicit Session lost marker (added in this fix)", () => {
		const steps: ResolvedStep[] = [
			{ name: "Gap analysis", type: "llm-review", passed: false, output: "Session lost during server restart.", duration_ms: 100 },
		];
		assert.equal(shouldSuppressAsRestartInterrupt(steps), true);
	});

	it("explicit Reviewer agent process died marker (added in this fix)", () => {
		const steps: ResolvedStep[] = [
			{ name: "Gap analysis", type: "llm-review", passed: false, output: "Reviewer agent process died during \"Gap analysis\" (session llm-review-...): Agent process exited unexpectedly (code 143)", duration_ms: 0 },
		];
		assert.equal(shouldSuppressAsRestartInterrupt(steps), true);
	});

	it("REAL llm-review failure with substantive output is NOT suppressed", () => {
		// Verdict from the reviewer with real text — don't paper over.
		const steps: ResolvedStep[] = [
			{ name: "Code quality review", type: "llm-review", passed: false, output: "FAIL: Section 3 of the design doc is not addressed by the implementation.", duration_ms: 90000 },
		];
		assert.equal(shouldSuppressAsRestartInterrupt(steps), false);
	});
});
