/**
 * Pinned regression: when a `parent`-workflow goal's `goal-plan` gate is
 * re-signalled after the plan was already frozen (e.g. the original
 * goal-plan signal landed pre-fix and never auto-signalled execution,
 * or the auto-signal IIFE was interrupted by a server restart), the
 * route handler must STILL fire the auto-execution-signal IIFE so the
 * harness picks up the subgoal verify steps.
 *
 * Pre-fix behaviour (BUG-15 from team-lead-317cdb83 PR #409): the
 * auto-signal was tied to the FIRST freeze of the execution gate. Re-
 * signalling goal-plan on an already-frozen plan was a noop, leaving
 * the team-lead to manually `gate_signal({gate_id: "execution"})` with
 * the right metadata.
 *
 * Fix: decouple "should freeze" from "should auto-signal execution".
 * The handler now checks separately whether the execution gate has any
 * signals; if none, fire the IIFE regardless of whether `frozen` was
 * just stamped or was already in place. Idempotent: if execution
 * already has a signal, we don't re-fire (would cancel in-flight
 * verification).
 *
 * The unit test below pins the pure decision predicate. End-to-end
 * route behaviour is exercised via curl in the live test session.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Replicates the production logic in `server.ts` at the goal-plan
 * signal handler. Pure / no I/O. If you change either, change both.
 *
 * Returns `{ shouldFreeze, shouldAutoSignal }`:
 *   - shouldFreeze = true iff this is the first goal-plan signal landing
 *   - shouldAutoSignal = true iff the execution gate has no signals yet
 *     (regardless of freeze status)
 */
function decideOnGoalPlanSignal(opts: {
	executionFrozen: boolean;
	executionSignalCount: number;
}): { shouldFreeze: boolean; shouldAutoSignal: boolean } {
	const shouldFreeze = !opts.executionFrozen;
	const shouldAutoSignal = opts.executionSignalCount === 0;
	return { shouldFreeze, shouldAutoSignal };
}

describe("goal-plan signal handler decision logic (BUG-15 fix)", () => {
	it("first signal: freeze AND auto-signal", () => {
		const d = decideOnGoalPlanSignal({ executionFrozen: false, executionSignalCount: 0 });
		assert.deepEqual(d, { shouldFreeze: true, shouldAutoSignal: true });
	});

	it("re-signal on already-frozen plan with NO execution signal: skip freeze BUT auto-signal", () => {
		// This is the BUG-15 case: pre-fix, this returned shouldAutoSignal=false
		// because the auto-signal was nested inside the freeze branch.
		const d = decideOnGoalPlanSignal({ executionFrozen: true, executionSignalCount: 0 });
		assert.deepEqual(d, { shouldFreeze: false, shouldAutoSignal: true });
	});

	it("re-signal on already-frozen plan WITH execution signal already in flight: skip both", () => {
		// Idempotency: the execution gate is already running verification.
		// Don't re-signal it; that would cancel the in-flight verification.
		const d = decideOnGoalPlanSignal({ executionFrozen: true, executionSignalCount: 1 });
		assert.deepEqual(d, { shouldFreeze: false, shouldAutoSignal: false });
	});

	it("re-signal after multiple historical execution signals: skip auto-signal", () => {
		// Once execution has been signalled at all, re-signalling goal-plan
		// shouldn't trigger another execution signal \u2014 the harness handles
		// rerun via gate-cascade resets.
		const d = decideOnGoalPlanSignal({ executionFrozen: true, executionSignalCount: 5 });
		assert.deepEqual(d, { shouldFreeze: false, shouldAutoSignal: false });
	});

	it("hypothetical edge case: execution unfrozen but already signalled \u2014 don't auto-fire (consistency)", () => {
		// Should never happen in practice (signalling execution requires
		// the plan to be frozen), but the predicate is well-defined.
		const d = decideOnGoalPlanSignal({ executionFrozen: false, executionSignalCount: 1 });
		assert.deepEqual(d, { shouldFreeze: true, shouldAutoSignal: false });
	});
});
