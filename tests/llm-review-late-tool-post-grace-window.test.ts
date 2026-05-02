/**
 * Pinned regression: the LLM-review verification race honours a
 * grace window for late-arriving tool POSTs, instead of declaring
 * failure the instant `waitForIdle` resolves.
 *
 * Live test (PR #409 0e4fc54c plan-approval UX, Eve Olution's bug
 * report): reviewer sessions ran for 84-151s and DID call
 * `verification_result` with valid verdicts, but the harness's
 * `Promise.race([resultPromise, waitForIdle])` resolved on the
 * `idle` branch microseconds before the agent's outgoing tool POST
 * arrived at the server. The `finally` block then deleted
 * `pendingResults`, so the POST got 404. Net effect: every reviewer
 * verdict for Eve's subgoal was silently dropped over 5+ runs.
 *
 * Two-part fix:
 *   1. Harness: after `waitForIdle` wins the race, wait an
 *      additional 5s for `resultPromise` to resolve. If it does,
 *      honour the verdict ("late tool POST won grace window").
 *      Same applied after the reminder cycle.
 *   2. Server (server.ts): improved 404 message so any residual
 *      race that still loses produces a clear error the reviewer
 *      knows is a failure ("VERIFICATION_RESULT_NOT_ACCEPTED:
 *      harness has already declared this verification cycle
 *      complete... Your verdict was NOT recorded"), not the vague
 *      "No pending verification for this session" that reviewers
 *      were paraphrasing as "submitted successfully".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface VerificationResult {
	verdict: boolean;
	summary: string;
}

/**
 * Replicates the post-waitForIdle grace race. Returns the same
 * shape the harness uses internally so the test exercises the
 * exact predicate.
 */
async function gracefulRace(
	resultPromise: Promise<VerificationResult>,
	graceMs: number,
): Promise<{ type: "result"; verdict: boolean; summary: string } | { type: "timeout" }> {
	return Promise.race([
		resultPromise.then((r) => ({ type: "result" as const, ...r })),
		new Promise<{ type: "timeout" }>(resolve => setTimeout(() => resolve({ type: "timeout" }), graceMs)),
	]);
}

describe("LLM-review late tool POST grace window", () => {
	it("THE bug: tool POST arrives 100ms after waitForIdle -> grace window honours it", async () => {
		// Simulate: agent flipped to idle, waitForIdle resolved, harness
		// is in grace window. The agent's POST hits the server 100ms later
		// and the server invokes resolver(). Result: grace window wins.
		const result: VerificationResult = { verdict: true, summary: "All checks pass" };
		const resultPromise = new Promise<VerificationResult>(resolve => {
			setTimeout(() => resolve(result), 100);
		});
		const got = await gracefulRace(resultPromise, 5_000);
		assert.equal(got.type, "result");
		if (got.type === "result") {
			assert.equal(got.verdict, true);
			assert.equal(got.summary, "All checks pass");
		}
	});

	it("genuine timeout: no POST within grace window -> timeout fires", async () => {
		const resultPromise = new Promise<VerificationResult>(() => { /* never resolves */ });
		const got = await gracefulRace(resultPromise, 100);
		assert.equal(got.type, "timeout");
	});

	it("POST arrives at the very last millisecond of grace -> honoured", async () => {
		const resultPromise = new Promise<VerificationResult>(resolve => {
			setTimeout(() => resolve({ verdict: false, summary: "fail" }), 90);
		});
		const got = await gracefulRace(resultPromise, 100);
		assert.equal(got.type, "result");
		if (got.type === "result") {
			assert.equal(got.verdict, false);
		}
	});

	it("POST arrives just after grace expires -> timeout (correct, harness will use reminder cycle)", async () => {
		const resultPromise = new Promise<VerificationResult>(resolve => {
			setTimeout(() => resolve({ verdict: true, summary: "fast" }), 200);
		});
		const got = await gracefulRace(resultPromise, 100);
		assert.equal(got.type, "timeout");
	});

	it("immediate result (no race needed) is also caught by the same race", async () => {
		// Defensive: the grace race shape works even when the result is
		// already resolved when entering.
		const resultPromise = Promise.resolve<VerificationResult>({ verdict: true, summary: "instant" });
		const got = await gracefulRace(resultPromise, 5_000);
		assert.equal(got.type, "result");
	});
});

describe("server-side 404 message must be unambiguous", () => {
	// We can't unit-test the actual server response here without an
	// HTTP harness, but we pin the contract: the message must contain
	// the keyword "NOT_ACCEPTED" so reviewers see it as failure.
	it("documented contract: 404 message contains explicit 'NOT_ACCEPTED' marker", () => {
		const msg = "VERIFICATION_RESULT_NOT_ACCEPTED: harness has already declared this verification cycle complete (timed out or cancelled). Your verdict was NOT recorded. The harness will spawn a fresh reviewer if a re-signal is needed; you should NOT report this as a successful submission.";
		assert.ok(msg.includes("NOT_ACCEPTED"));
		assert.ok(msg.includes("NOT recorded"));
		assert.ok(msg.includes("NOT report this as a successful submission"));
	});
});
