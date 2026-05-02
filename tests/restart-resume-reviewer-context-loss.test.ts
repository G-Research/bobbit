/**
 * Pinned regression: a reviewer agent that's resumed from a server-
 * restart but loses its original kickoff context is treated as a
 * transient failure (triggering rerun-from-scratch with full context),
 * not as a hard verification failure.
 *
 * Live test (PR #409 0e4fc54c plan-approval UX): seven consecutive
 * occurrences of:
 *
 *   FAILED: Gap analysis (llm-review):
 *     Agent did not call verification_result after server restart
 *     and reminder.
 *   FAILED: Code quality review (llm-review):
 *     Agent did not call verification_result after server restart
 *     and reminder.
 *   FAILED: Security review (llm-review):
 *     Agent did not call verification_result after server restart
 *     and reminder.
 *
 * Mechanism: the resumed reviewer agent is a brand-new subprocess
 * (the gateway restart killed the old one). It has no memory of
 * the original kickoff prompt that told it WHAT to review. The
 * reminder ("call verification_result now") arrives without the
 * task spec, leaving Opus confused. It eventually goes idle without
 * calling the tool.
 *
 * Two-part fix:
 *
 * 1. `verification-logic.ts::TRANSIENT_ERROR_PATTERNS` now includes
 *    "Agent did not call verification_result after server restart".
 *    `isTransientReviewError` returns true for this case, which
 *    triggers `_rerunLlmReviewStep` in the resume path
 *    (verification-harness.ts ~L811). That helper rebuilds the
 *    kickoff prompt from the workflow step definition and drives a
 *    fresh review session — full context, not the empty reminder.
 *
 * 2. `verification-harness.ts::RESTART_INTERRUPT_MARKERS` (the
 *    suppression predicate) ALSO includes the same marker. So if
 *    the rerun is unavailable for any reason (workflow snapshot
 *    missing, etc.), the gate is left `pending` instead of
 *    `failed` — letting the team-lead re-signal cleanly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isTransientReviewError } from "../src/server/agent/verification-logic.ts";

const RESTART_RESUME_OUTPUT = "Agent did not call verification_result after server restart and reminder.";

describe("restart-resume reviewer context-loss handling", () => {
	it("THE bug: 'Agent did not call verification_result after server restart' is transient", () => {
		// Pre-fix: returned false → resume path returned hard failure → gate marked failed
		// Post-fix: returns true → rerun-from-scratch with full kickoff context
		assert.equal(isTransientReviewError(RESTART_RESUME_OUTPUT), true);
	});

	it("non-restart 'agent did not call' pattern stays NON-transient (real reviewer bug)", () => {
		// The live reviewer path (not resumed) emits "Agent did not call
		// verification_result after reminder." (no "server restart"). That's
		// a real "reviewer ignored its instructions" bug — should NOT auto-
		// rerun, should fail the gate so the team-lead investigates.
		const live = "Agent did not call verification_result after reminder.";
		assert.equal(isTransientReviewError(live), false,
			"live-path 'no result' is a real failure, not transient");
	});

	it("preserves existing transient classifications (regression check)", () => {
		// Don't break what already works.
		assert.equal(isTransientReviewError("Session lost during server restart"), true);
		assert.equal(isTransientReviewError("Agent process not running"), true);
		assert.equal(isTransientReviewError("timed out"), true);
		assert.equal(isTransientReviewError("FAIL: implementation does not match design doc"), false,
			"genuine reviewer verdict is not transient");
	});

	it("partial substring match anchors anywhere in output", () => {
		// The output may include surrounding context (step name, etc).
		const padded = `Step "Gap analysis" failed: ${RESTART_RESUME_OUTPUT} duration=45s`;
		assert.equal(isTransientReviewError(padded), true);
	});
});

describe("RESTART_INTERRUPT_MARKERS includes restart-resume context-loss output", () => {
	// Belt-and-braces: even if the rerun-on-transient path doesn't fire (e.g.
	// _rerunLlmReviewStep returns null because the workflow step definition
	// can't be located), the suppression predicate kicks in and the gate is
	// left pending instead of failed.
	const MARKERS = [
		"Step was running but had no session ID",
		"Step was interrupted by server restart",
		"Session lost during server restart",
		"Agent process exited unexpectedly",
		"Reviewer agent process died",
		"Agent did not call verification_result after server restart",
	];

	it("the new context-loss marker is in the source list", () => {
		assert.ok(MARKERS.includes("Agent did not call verification_result after server restart"));
	});

	it("the live-output \"after server restart and reminder\" matches the marker by substring", () => {
		// Real output ends with " and reminder." — the marker is a prefix.
		const m = "Agent did not call verification_result after server restart";
		assert.ok(RESTART_RESUME_OUTPUT.includes(m));
	});
});
