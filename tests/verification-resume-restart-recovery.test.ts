/**
 * Recovery-path tests for verification-resume-after-restart.
 *
 * Companion to `tests/verification-resume-restart-prompt.test.ts` (the
 * canonical case-(b) regression: a resume-prompt timeout must leave the gate
 * `pending`, never `failed`). These cover the two other arms of the fix:
 *
 *   (a) A slow-to-initialise (cold) reviewer that needs a readiness wait
 *       BEFORE the reminder prompt resumes successfully — `waitForReady` is
 *       invoked before `prompt`, and once the agent emits its
 *       verification_result the gate is marked `passed` (no timeout error).
 *
 *   (c) When re-attach to the revived reviewer fails transiently (cold-agent
 *       RPC timeout), `_resumeOneVerification` routes the failure into the
 *       rerun-from-scratch fallback (`_rerunLlmReviewStep`). With
 *       BOBBIT_LLM_REVIEW_SKIP set the rerun returns a trivial pass without a
 *       real agent, so the gate ends `passed` — proving the rerun arm is
 *       reachable (the resume itself produced a failure, so a `passed` gate
 *       can only have come from the rerun).
 *
 * All `resumeInterruptedVerifications()` calls are wrapped in a deadline race
 * so a regression can't hang the unit-test runner.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-resume-recovery-test-"));
const STATE_DIR = path.join(TEST_DIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

const GOAL_ID = "goal-test";
const GATE_ID = "documentation";
const SESSION_ID = "reviewer-sess-1";

function seedPersistedReviewer(signalId: string): void {
	const persistPath = path.join(STATE_DIR, "active-verifications.json");
	const startedAt = Date.now() - 60_000; // 1 min ago
	const data = {
		verifications: [
			{
				goalId: GOAL_ID,
				gateId: GATE_ID,
				signalId,
				overallStatus: "running",
				startedAt,
				currentPhase: 0,
				steps: [
					{
						name: "Doc review",
						type: "llm-review",
						status: "running",
						startedAt,
						sessionId: SESSION_ID,
					},
				],
			},
		],
	};
	fs.writeFileSync(persistPath, JSON.stringify(data, null, 2));
}

function gateStatusCalls(calls: Array<{ kind: string; args: any[] }>): string[] {
	return calls.filter(c => c.kind === "updateGateStatus").map(c => c.args[2]);
}

/** Wrap a resume call in a deadline race so a regression can't hang the runner. */
async function resumeWithDeadline(harness: any, deadlineMs = 10_000): Promise<void> {
	const racer = new Promise<"timeout">(r => {
		const t = setTimeout(() => r("timeout"), deadlineMs);
		if (typeof (t as any).unref === "function") (t as any).unref();
	});
	const winner = await Promise.race([
		harness.resumeInterruptedVerifications().then(() => "ok" as const),
		racer,
	]);
	assert.notStrictEqual(
		winner,
		"timeout",
		`resumeInterruptedVerifications did not finalize within ${deadlineMs}ms — the resume path appears to be hanging.`,
	);
}

test("(a) a slow-to-init reviewer is waited on (waitForReady before prompt) and resumes to PASSED", async () => {
	const SIGNAL_ID = "sig-recovery-slow-init";
	seedPersistedReviewer(SIGNAL_ID);

	const calls: Array<{ kind: string; args: any[] }> = [];
	const stubGateStore = {
		updateSignalVerification: (...args: any[]) => { calls.push({ kind: "updateSignalVerification", args }); },
		updateGateStatus: (...args: any[]) => { calls.push({ kind: "updateGateStatus", args }); },
		getGate: () => undefined,
		getGatesForGoal: () => [],
	} as any;
	const roleStore = { get: () => undefined, getAll: () => [] } as any;

	// Track call ordering to prove waitForReady precedes the reminder prompt.
	const order: string[] = [];
	let pendingResolver: ((r: any) => void) | null = null;

	const fakeSession = {
		rpcClient: {
			onEvent: (_fn: (event: any) => void) => () => {},
			// Cold reviewer: readiness check resolves only after a short delay,
			// mimicking model + MCP init. Must be awaited before prompting.
			waitForReady: (_ms?: number) => {
				order.push("waitForReady");
				return new Promise<void>(res => {
					const t = setTimeout(res, 20);
					if (typeof (t as any).unref === "function") (t as any).unref();
				});
			},
			// The reminder prompt succeeds with the longer resume timeout. When it
			// lands, the agent (eventually) calls verification_result — modelled by
			// resolving the harness's pending result deferred with a passing verdict.
			prompt: (_text: string, _images?: unknown, timeoutMs?: number) => {
				order.push(`prompt:${timeoutMs}`);
				// Resolve the pending verification_result so the SECOND race in
				// _tryResumeFromSession picks the "result" branch.
				if (pendingResolver) pendingResolver({ verdict: true, summary: "Docs look good." });
				return Promise.resolve();
			},
		},
	};

	let idleCalls = 0;
	const stubSessionManager = {
		getSession: (_id: string) => fakeSession,
		// First race → idle (no result yet) so we proceed to the reminder path.
		// Subsequent waitForIdle calls never resolve, so the resolved
		// verification_result deterministically wins the second race.
		waitForIdle: (_id: string, _ms?: number) => {
			idleCalls++;
			return idleCalls === 1 ? Promise.resolve() : new Promise<void>(() => {});
		},
		waitForStreaming: (_id: string, _ms?: number) => Promise.resolve(),
		terminateSession: (_id: string) => Promise.resolve(),
	} as any;

	const stubTeamManager = {
		registerReviewerSession: (..._a: any[]) => Promise.resolve(),
		unregisterReviewerSession: (..._a: any[]) => Promise.resolve(),
	} as any;

	const harness = new VerificationHarness(
		STATE_DIR, stubGateStore, () => {}, roleStore, undefined,
		stubSessionManager, stubTeamManager, undefined, undefined, undefined,
	) as any;

	// Surface the pending-result resolver to the prompt stub the moment the
	// resume path registers it. The deferred is set synchronously at the top of
	// _tryResumeFromSession, so a short poll catches it before the prompt fires.
	const grab = setInterval(() => {
		const r = harness.pendingResults.get(SESSION_ID);
		if (r) { pendingResolver = r; clearInterval(grab); }
	}, 1);
	if (typeof (grab as any).unref === "function") (grab as any).unref();

	await resumeWithDeadline(harness);
	clearInterval(grab);

	// waitForReady must have been invoked BEFORE the reminder prompt.
	const readyIdx = order.indexOf("waitForReady");
	const promptIdx = order.findIndex(o => o.startsWith("prompt:"));
	assert.ok(readyIdx >= 0, `waitForReady was never called before the resume prompt. order=${JSON.stringify(order)}`);
	assert.ok(
		promptIdx > readyIdx,
		`The resume reminder prompt must be sent AFTER waitForReady resolves. order=${JSON.stringify(order)}`,
	);
	// And the prompt must use a longer-than-default (>30s) timeout.
	assert.ok(
		order.some(o => o.startsWith("prompt:") && Number(o.split(":")[1]) > 30_000),
		`The resume reminder prompt must use a generous timeout (>30s), not the 30s default. order=${JSON.stringify(order)}`,
	);

	const statuses = gateStatusCalls(calls);
	assert.strictEqual(
		statuses[statuses.length - 1],
		"passed",
		`A reviewer that becomes ready and emits a passing verification_result must mark the gate PASSED. Recorded updateGateStatus values: ${JSON.stringify(statuses)}.`,
	);
});

test("(c) a transient resume failure routes into the rerun-from-scratch fallback (_rerunLlmReviewStep) and the gate ends PASSED", async () => {
	const SIGNAL_ID = "sig-recovery-rerun";
	seedPersistedReviewer(SIGNAL_ID);

	const calls: Array<{ kind: string; args: any[] }> = [];
	const stubGateStore = {
		updateSignalVerification: (...args: any[]) => { calls.push({ kind: "updateSignalVerification", args }); },
		updateGateStatus: (...args: any[]) => { calls.push({ kind: "updateGateStatus", args }); },
		getGate: () => undefined,
		getGatesForGoal: () => [],
	} as any;
	const roleStore = { get: () => undefined, getAll: () => [] } as any;

	// Revived reviewer that can't be re-attached: the reminder prompt times out
	// (cold-agent RPC timeout). This produces a transient + restart-interrupt
	// resume failure, which must route into _rerunLlmReviewStep.
	const fakeSession = {
		rpcClient: {
			onEvent: (_fn: (event: any) => void) => () => {},
			waitForReady: (_ms?: number) => Promise.resolve(),
			prompt: (_text: string) => Promise.reject(new Error("Command timed out: prompt")),
		},
	};
	const stubSessionManager = {
		getSession: (_id: string) => fakeSession,
		waitForIdle: (_id: string, _ms?: number) => Promise.resolve(),
		waitForStreaming: (_id: string, _ms?: number) => Promise.resolve(),
		terminateSession: (_id: string) => Promise.resolve(),
	} as any;
	const stubTeamManager = {
		registerReviewerSession: (..._a: any[]) => Promise.resolve(),
		unregisterReviewerSession: (..._a: any[]) => Promise.resolve(),
	} as any;

	const harness = new VerificationHarness(
		STATE_DIR, stubGateStore, () => {}, roleStore, undefined,
		stubSessionManager, stubTeamManager, undefined, undefined, undefined,
	) as any;

	// BOBBIT_LLM_REVIEW_SKIP makes _rerunLlmReviewStep return a trivial pass
	// without spawning a real agent — so a PASSED gate can ONLY have come from
	// the rerun arm (the resume itself failed transiently).
	const prev = process.env.BOBBIT_LLM_REVIEW_SKIP;
	process.env.BOBBIT_LLM_REVIEW_SKIP = "1";
	try {
		await resumeWithDeadline(harness);
	} finally {
		if (prev === undefined) delete process.env.BOBBIT_LLM_REVIEW_SKIP;
		else process.env.BOBBIT_LLM_REVIEW_SKIP = prev;
	}

	const statuses = gateStatusCalls(calls);
	assert.strictEqual(
		statuses[statuses.length - 1],
		"passed",
		`A transient resume failure must be re-run from scratch via _rerunLlmReviewStep; with BOBBIT_LLM_REVIEW_SKIP the rerun returns a pass, so the gate must end PASSED — only reachable if the rerun arm ran. Recorded updateGateStatus values: ${JSON.stringify(statuses)}.`,
	);

	// And no hard "Resume Error" step may be recorded for this transient path.
	const resumeErrorRecorded = calls
		.filter(c => c.kind === "updateSignalVerification")
		.some(c => Array.isArray(c.args[1]?.steps) && c.args[1].steps.some((s: any) => s?.name === "Resume Error"));
	assert.strictEqual(resumeErrorRecorded, false, "A transient resume failure must not record a hard 'Resume Error' step.");
});
