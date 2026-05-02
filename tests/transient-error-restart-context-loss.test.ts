/**
 * Lesson 4.7 — Resumed reviewer context-loss must trigger
 * `_rerunLlmReviewStep` rather than failing.
 *
 * Symptom: after a gateway restart, a resumed reviewer agent is a fresh
 * subprocess and the terse legacy reminder doesn't elicit a tool call. The
 * harness reports "Agent did not call verification_result after server
 * restart and reminder" and the gate marks failed.
 *
 * Fix: include this output substring in `TRANSIENT_ERROR_PATTERNS` so the
 * resume path's transient-detection branch promotes recovery to
 * `_rerunLlmReviewStep`, which rebuilds the kickoff prompt with full context
 * and drives a fresh review session.
 */
import { strict as assert } from "node:assert";
import test, { describe } from "node:test";
import { TRANSIENT_ERROR_PATTERNS, isTransientReviewError } from "../src/server/agent/verification-logic.js";

describe("Lesson 4.7 — resumed-reviewer context-loss transient pattern", () => {
	test("TRANSIENT_ERROR_PATTERNS contains the new restart-context-loss marker", () => {
		assert.ok(
			TRANSIENT_ERROR_PATTERNS.includes("Agent did not call verification_result after server restart and reminder"),
			"Lesson 4.7 requires this exact substring to be classified as transient",
		);
	});

	test("isTransientReviewError matches the full output line emitted by the resume path", () => {
		const output = "Agent did not call verification_result after server restart and reminder.";
		assert.equal(isTransientReviewError(output), true);
	});

	test("isTransientReviewError tolerates extra context appended around the marker", () => {
		const output = "[verification] step xyz: Agent did not call verification_result after server restart and reminder. Bailing.";
		assert.equal(isTransientReviewError(output), true);
	});

	test("isTransientReviewError still does NOT match an unrelated real failure", () => {
		assert.equal(isTransientReviewError("review verdict: FAIL — code is buggy"), false);
	});
});
