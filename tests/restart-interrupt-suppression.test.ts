/**
 * Lesson 4.6 — Restart-interrupt suppression.
 *
 * `_resumeOneVerification` consults `shouldSuppressRestartInterrupt` to decide
 * whether the gate should fall back to `pending` (with a benign team-lead
 * notification) or `failed`. This unit test pins the pure predicate that
 * drives that decision: the file-greppable invariant is that gates whose
 * every failure is a restart-interrupt do NOT mark the gate failed.
 */
import { strict as assert } from "node:assert";
import test, { describe } from "node:test";
import {
	RESTART_INTERRUPT_MARKERS,
	isRestartInterruptedStep,
	shouldSuppressRestartInterrupt,
} from "../src/server/agent/verification-logic.js";

describe("RESTART_INTERRUPT_MARKERS", () => {
	test("includes the six marker strings the harness emits when a restart kills a step", () => {
		// Re-pinning the catalogue: if a new marker is added, this test must be
		// updated alongside the call site that emits it.
		const expected = [
			"Step was running but had no session ID",
			"Step was interrupted by server restart",
			"Session lost during server restart",
			"Agent process exited unexpectedly",
			"Reviewer agent process died",
			"Agent did not call verification_result after server restart",
		];
		for (const m of expected) {
			assert.ok(RESTART_INTERRUPT_MARKERS.includes(m), `expected marker ${JSON.stringify(m)} in RESTART_INTERRUPT_MARKERS`);
		}
		assert.equal(RESTART_INTERRUPT_MARKERS.length, expected.length);
	});
});

describe("isRestartInterruptedStep", () => {
	test("matches the 'no session id' marker on a failed command step", () => {
		const step = { passed: false, type: "command", output: "Step was running but had no session ID — cannot resume after restart." };
		assert.equal(isRestartInterruptedStep(step), true);
	});

	test("matches the 'session lost' marker on a failed llm-review step", () => {
		const step = { passed: false, type: "llm-review", output: "Session lost during server restart." };
		assert.equal(isRestartInterruptedStep(step), true);
	});

	test("matches the 'reviewer process died' marker", () => {
		const step = { passed: false, type: "llm-review", output: "Reviewer agent process died during step xyz" };
		assert.equal(isRestartInterruptedStep(step), true);
	});

	test("treats empty-output llm-review failures as restart-interrupts (SIGTERM-during-review)", () => {
		const step = { passed: false, type: "llm-review", output: "" };
		assert.equal(isRestartInterruptedStep(step), true);
	});

	test("treats empty-output agent-qa failures as restart-interrupts", () => {
		const step = { passed: false, type: "agent-qa", output: "   " };
		assert.equal(isRestartInterruptedStep(step), true);
	});

	test("does NOT treat empty-output command failures as restart-interrupts (commands have rerun paths)", () => {
		// command steps have explicit markers; an empty-output command failure
		// is a real (silent) failure — don't suppress it.
		const step = { passed: false, type: "command", output: "" };
		assert.equal(isRestartInterruptedStep(step), false);
	});

	test("does NOT match a real test failure", () => {
		const step = { passed: false, type: "command", output: "FAIL test-suite\n  TypeError: foo is undefined" };
		assert.equal(isRestartInterruptedStep(step), false);
	});

	test("ignores passed steps", () => {
		const step = { passed: true, type: "command", output: "Reviewer agent process died" };
		assert.equal(isRestartInterruptedStep(step), false);
	});

	test("matches the new 'Agent did not call verification_result after server restart' marker (Lesson 4.7 boundary)", () => {
		const step = { passed: false, type: "llm-review", output: "Agent did not call verification_result after server restart and reminder." };
		assert.equal(isRestartInterruptedStep(step), true);
	});
});

describe("shouldSuppressRestartInterrupt", () => {
	test("returns false when every step passed (no failures to suppress)", () => {
		const steps = [
			{ passed: true, type: "command", output: "ok" },
			{ passed: true, type: "llm-review", output: "good" },
		];
		assert.equal(shouldSuppressRestartInterrupt(steps), false);
	});

	test("returns true when every failed step is a restart-interrupt (gate should mark pending)", () => {
		const steps = [
			{ passed: true, type: "command", output: "ok" },
			{ passed: false, type: "command", output: "Step was running but had no session ID — cannot resume after restart." },
			{ passed: false, type: "llm-review", output: "Session lost during server restart." },
		];
		assert.equal(shouldSuppressRestartInterrupt(steps), true);
	});

	test("returns false when ANY failed step is a real failure (mixed — gate should mark failed)", () => {
		const steps = [
			{ passed: false, type: "command", output: "Step was running but had no session ID — cannot resume after restart." },
			{ passed: false, type: "command", output: "FAIL test-suite\n  TypeError: foo is undefined" },
		];
		assert.equal(shouldSuppressRestartInterrupt(steps), false);
	});

	test("returns true for a single all-empty llm-review failure", () => {
		const steps = [
			{ passed: false, type: "llm-review", output: "" },
		];
		assert.equal(shouldSuppressRestartInterrupt(steps), true);
	});
});
