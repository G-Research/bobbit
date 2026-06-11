/**
 * Reproducing regression test for the verification-resume-after-restart bug.
 *
 * See goal "Fix verification resume after restart" / Issue Analysis gate.
 *
 * Scenario: the gateway is killed while an `llm-review` reviewer session is
 * mid-turn. On restart, `restoreSessions()` revives the reviewer session and
 * `resumeInterruptedVerifications()` then calls `_tryResumeFromSession`, which
 * (when the revived agent is idle-without-result) sends a reminder prompt via
 * `await session.rpcClient.prompt(reminderPrompt)` (verification-harness.ts
 * ~line 1447). That `prompt()` uses a 30s default RPC timeout and is NOT
 * preceded by a readiness wait; a freshly-revived cold reviewer routinely
 * exceeds 30s, so `prompt()` rejects with `Command timed out: prompt`.
 *
 * BUG (Defect B): that rejection has no local try/catch in
 * `_tryResumeFromSession`. It propagates UNCAUGHT past `_resumeOneVerification`
 * into the outer catch in `resumeInterruptedVerifications`
 * (verification-harness.ts ~line 1131-1140), which unconditionally writes a
 * `Resume Error` step and marks the gate **`failed`** — bypassing the
 * `_rerunLlmReviewStep` fallback AND the `shouldSuppressRestartInterrupt`
 * machinery that exists precisely for restart interrupts.
 *
 * EXPECTED (post-fix): a restart-induced resume-prompt timeout must be treated
 * as a transient restart-interrupt and leave the gate **`pending`** (so the
 * team-lead re-signals) — NEVER `failed` with a `Resume Error` step.
 *
 * This test must FAIL on the current (buggy) branch — the gate is marked
 * `failed` and a `Resume Error` step is recorded — and PASS once the resume
 * path catches the RPC timeout and routes it into the suppression path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-resume-prompt-test-"));
const STATE_DIR = path.join(TEST_DIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

const SIGNAL_ID = "sig-resume-prompt-1";
const GOAL_ID = "goal-test";
const GATE_ID = "documentation";
const SESSION_ID = "reviewer-sess-1";

/**
 * Write a synthetic active-verifications.json containing one in-flight
 * llm-review verification with `status: "running"` and a `sessionId` — the
 * shape a real gateway leaves on disk after being killed while a reviewer
 * agent was mid-turn.
 */
function seedPersistedReviewer(): void {
	const persistPath = path.join(STATE_DIR, "active-verifications.json");
	const startedAt = Date.now() - 60_000; // 1 min ago
	const data = {
		verifications: [
			{
				goalId: GOAL_ID,
				gateId: GATE_ID,
				signalId: SIGNAL_ID,
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

/**
 * Build the harness with a session manager whose revived reviewer agent goes
 * idle without a verification_result and then TIMES OUT on the reminder prompt
 * — exactly the cold-agent RPC-timeout defect.
 */
function makeHarness() {
	const gateStoreCalls: Array<{ kind: string; args: any[] }> = [];
	const stubGateStore = {
		updateSignalVerification: (...args: any[]) => { gateStoreCalls.push({ kind: "updateSignalVerification", args }); },
		updateGateStatus: (...args: any[]) => { gateStoreCalls.push({ kind: "updateGateStatus", args }); },
		getGate: () => undefined,
		getGatesForGoal: () => [],
	} as any;

	const roleStore = {
		get: () => undefined,
		getAll: () => [],
	} as any;

	// Fake revived reviewer session. The reminder prompt rejects with the exact
	// cold-agent RPC timeout — this is the defect under test.
	const fakeSession = {
		rpcClient: {
			onEvent: (_fn: (event: any) => void) => () => { /* no-op unsubscribe */ },
			prompt: (_text: string) => Promise.reject(new Error("Command timed out: prompt")),
		},
	};

	const stubSessionManager = {
		getSession: (_sessionId: string) => fakeSession,
		// Resolve so the first Promise.race picks the `idle` branch and the code
		// proceeds to send the reminder prompt (which then times out).
		waitForIdle: (_sessionId: string, _timeoutMs?: number) => Promise.resolve(),
		waitForStreaming: (_sessionId: string, _timeoutMs?: number) => Promise.resolve(),
		terminateSession: (_sessionId: string) => Promise.resolve(),
	} as any;

	const stubTeamManager = {
		registerReviewerSession: (..._args: any[]) => Promise.resolve(),
		unregisterReviewerSession: (..._args: any[]) => Promise.resolve(),
	} as any;

	const harness = new VerificationHarness(
		STATE_DIR,
		stubGateStore,                  // gateStore (fallback path)
		() => {},                       // broadcastFn
		roleStore,                      // roleStore
		undefined,                      // preferencesStore
		stubSessionManager,             // sessionManager — revived reviewer that times out
		stubTeamManager,                // teamManager — no-op register/unregister
		undefined,                      // projectConfigStore
		undefined,                      // projectContextManager (forces fallback gateStore + null rerun ctx)
		undefined,                      // configCascade
	);
	return { harness, gateStoreCalls };
}

test("a restart-induced resume-prompt timeout leaves the gate pending, never failed with a Resume Error", async () => {
	seedPersistedReviewer();
	const { harness, gateStoreCalls } = makeHarness();

	// Wrap in a deadline race so a regression can't hang the unit-test runner.
	const resumePromise = harness.resumeInterruptedVerifications();
	const deadlineMs = 10_000;
	const racer = new Promise<"timeout">(r => {
		const t = setTimeout(() => r("timeout"), deadlineMs);
		// Don't keep the event loop alive once the test resolves first.
		if (typeof (t as any).unref === "function") (t as any).unref();
	});
	const winner = await Promise.race([resumePromise.then(() => "ok" as const), racer]);
	assert.notStrictEqual(
		winner,
		"timeout",
		`resumeInterruptedVerifications did not finalize within ${deadlineMs}ms — the resume path appears to be hanging instead of handling the prompt timeout.`,
	);

	// The recorded updateGateStatus calls — the final gate status the resume
	// path settled on.
	const gateStatusCalls = gateStoreCalls
		.filter(c => c.kind === "updateGateStatus")
		.map(c => c.args[2]); // updateGateStatus(goalId, gateId, status)
	const finalGateStatus = gateStatusCalls[gateStatusCalls.length - 1];

	assert.strictEqual(
		finalGateStatus,
		"pending",
		`A restart-induced resume-prompt timeout ("Command timed out: prompt") must leave the gate PENDING so the team-lead re-signals — not "${finalGateStatus}". The current code lets the cold-agent RPC timeout escape uncaught into the outer catch in resumeInterruptedVerifications, which marks the gate "failed". Recorded updateGateStatus values: ${JSON.stringify(gateStatusCalls)}.`,
	);

	// No "Resume Error" step may be recorded — that is the symptom of the
	// uncaught-timeout-as-hard-failure bug.
	const resumeErrorRecorded = gateStoreCalls
		.filter(c => c.kind === "updateSignalVerification")
		.some(c => {
			const steps = c.args[1]?.steps;
			return Array.isArray(steps) && steps.some((s: any) => s?.name === "Resume Error");
		});
	assert.strictEqual(
		resumeErrorRecorded,
		false,
		`A "Resume Error" verification step was recorded — this is the bug. A resume-prompt RPC timeout caused by a server restart must be routed into the transient/suppression handling (gate left pending, team-lead nudged to re-signal), never surfaced as a hard "Resume Error" verification failure.`,
	);
});
