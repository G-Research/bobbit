/**
 * R-011 — `_waitForChildReadyToMerge` returns `"timeout"` after MAX_WAIT_MS
 * (24h) and the harness surfaces a non-fatal failure so the semaphore is
 * released and the step retries on the next signal.
 *
 * Verified two ways:
 *   1. Hook injection (this file) — drives the caller branch directly by
 *      stubbing the test seam to return `"timeout"`. Confirms the outcome
 *      handler short-circuits without merge / archive and surfaces the
 *      documented user-facing message.
 *   2. The polling-loop guard is verified by inspection at the call site:
 *      `Date.now() - startedAt >= MAX_WAIT_MS` returns `"timeout"` between
 *      poll iterations. The 24h ceiling is intentionally not exercised
 *      live to keep the suite fast — the constant is the contract.
 *
 * R-034 — defensive cross-tree check: if the resolved child's
 * `parentGoalId` doesn't match the `_parentGoalId` arg, the wait exits with
 * `archived-other`. Verified separately via the polling path.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildFixture, buildActive, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

describe("runSubgoalStep — _waitForChildReadyToMerge timeout (R-011)", () => {
	it("'timeout' outcome from the wait → step fails non-fatal, no merge, no archive", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		// Inject a hook that returns "timeout" — same contract as the real
		// polling loop hitting the 24h ceiling.
		fx.setReadyToMergeHook(async () => "timeout" as const);

		const step = buildSubgoalStep({ planId: "p-timeout" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		assert.equal(result.passed, false,
			"timeout must surface as a non-fatal failure so the harness retries on next signal");
		assert.match(result.output, /timed out/i,
			`expected timeout message, got: ${result.output}`);
		// No merge, no archive — the child is left intact for retry.
		assert.equal(fx.calls.find(c => c.kind === "mergeChild"), undefined,
			"timeout must NOT merge the child");
		assert.equal(fx.calls.find(c => c.kind === "archiveGoalAfterMerge"), undefined,
			"timeout must NOT archive the child");
		assert.equal(fx.calls.find(c => c.kind === "teardownTeam"), undefined,
			"timeout must NOT tear down the child team");
	});

	it("'timeout' outcome includes the child id in the user-facing message", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		fx.setReadyToMergeHook(async () => "timeout" as const);

		const step = buildSubgoalStep({ planId: "p-timeout-msg" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		// The harness embeds the resolved child id in the message.
		const child = fx.goalStore.getAll().find(g => g.parentGoalId === fx.parent.id);
		assert.ok(child);
		assert.match(result.output, new RegExp(child!.id),
			`expected child id ${child!.id} in output, got: ${result.output}`);
	});
});
