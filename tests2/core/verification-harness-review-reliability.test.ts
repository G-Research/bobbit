// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
//
// REPRODUCING TEST for the "Fix LLM review reliability" goal (Issue Analysis
// gate). Pins two invariants that CURRENT HEAD violates:
//
//   Invariant 1 — per-attempt reviewer session ID + transcript preservation.
//     The bounded llm-review retry loop in `verifyGateSignal` pre-generates a
//     single `stepSessionId` (verification-harness.ts:~3288) *before* the
//     retry loop (~3546) and threads the SAME id into `runLlmReviewStep` on
//     every attempt. Each attempt's `runLlmReviewViaSession` then calls
//     `createSession(..., { sessionId })`, and SessionManager reuses the id in
//     place — clobbering the prior attempt's transcript. The fix must give
//     every from-scratch attempt a FRESH session id so attempt 1's transcript
//     survives and remains viewable at its original URL.
//
//     We drive the real retry loop through `verifyGateSignal`, stubbing only
//     the leaf `runLlmReviewStep` to (a) record the session id it is handed on
//     each attempt and (b) model SessionManager's create-keyed-by-id record so
//     an id reuse is observable as a clobbered record. Attempt 1 returns a
//     transient failure (`ECONNRESET`) so the loop retries; attempt 2 passes.
//
//   Invariant 2 — a `verification_result` arriving during teardown is honored,
//     not 404-dropped. `runLlmReviewViaSession`'s `finally` runs
//     `pendingResults.delete(sessionId)` BEFORE `terminateSession(sessionId)`
//     (verification-harness.ts:~4099). A late verdict POST that lands during
//     teardown therefore finds no resolver and the server returns
//     404 "No pending verification for this session" (server.ts:~15882),
//     silently dropping a real pass. The fix must keep the verdict channel
//     live through teardown so the verdict is honored.
//
//     We drive the real `runLlmReviewViaSession` with a mock SessionManager
//     whose reviewer goes idle without calling the tool (so teardown runs),
//     and reproduce the race by delivering the verdict via the EXACT lookup
//     server.ts performs (`harness.pendingResults.get(sessionId)`) from inside
//     `terminateSession` — the teardown moment.
//
// EXPECTED: this file FAILS on current HEAD and PASSES once the reliability
// fixes land. Every assertion message carries the marker
// `LLM_REVIEW_RELIABILITY_REPRO` so the reproducing-test gate can match a
// specific, non-infra error_pattern.

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { VerificationHarness } = await import("../../src/server/agent/verification-harness.js");

const MARKER = "LLM_REVIEW_RELIABILITY_REPRO";

/**
 * Fake clock: fires the (bounded-retry) sleep callbacks on the macrotask
 * queue immediately while advancing virtual time, so the ~2s inter-attempt
 * backoff in the real retry loop does not slow the unit test.
 */
function makeFakeClock() {
	let t = 0;
	return {
		now: () => t,
		setTimeout: (handler: () => void, ms: number) => {
			t += Math.max(0, ms);
			return globalThis.setTimeout(handler, 0);
		},
		setInterval: (handler: () => void, ms: number) => globalThis.setInterval(handler, ms),
		clearTimeout: (handle: any) => globalThis.clearTimeout(handle),
	};
}

function makeStateDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(dir, "state"), { recursive: true });
	return path.join(dir, "state");
}

test("bounded llm-review retry uses a FRESH session id per attempt and preserves attempt 1's transcript", async () => {
	const GOAL_ID = "goal-review-reliability";
	const GATE_ID = "implementation";
	const SIGNAL_ID = "sig-review-reliability-1";
	const stateDir = makeStateDir("verif-review-reliability-");

	const gateStore = {
		getGate: () => ({ signals: [] }),
		updateSignalVerification: () => {},
		updateGateStatus: () => {},
	};
	const goalStore = { get: () => ({ id: GOAL_ID }) };
	const projectConfigStore = { get: () => "", getWithDefaults: () => ({}) };
	const ctx = { project: { id: "p", name: "p" }, goalStore, gateStore, projectConfigStore };
	const pcm = {
		getContextForGoal: (id: string) => (id === GOAL_ID ? ctx : null),
		all: () => [ctx],
	};
	const roleStore = { get: () => undefined, getAll: () => [] };
	const commandRunner = { execFile: async () => { throw new Error("no git in unit test"); } };

	const harness = new VerificationHarness(
		stateDir,
		undefined,
		() => {},
		roleStore as any,
		undefined,
		undefined,
		undefined,
		undefined,
		pcm as any,
		undefined,
		{ clock: makeFakeClock() as any, commandRunner: commandRunner as any },
	) as any;

	// Avoid spawning real `git` for base-branch detection.
	harness.resolveVerificationBaseBranch = async () => "master";
	harness.resolveLegacyMasterBranch = async () => "master";

	// Capture the session id the retry loop hands to each attempt, and model
	// SessionManager's "create session keyed by id" so an id reuse across
	// attempts is observable as a clobbered transcript record.
	const capturedSessionIds: string[] = [];
	const sessionRecords = new Map<string, { attempt: number; transcript: string }>();
	let attempt = 0;
	harness.runLlmReviewStep = async (...args: any[]) => {
		const sessionId: string = args[8];
		attempt++;
		capturedSessionIds.push(sessionId);
		// Emulate createSession(cwd, ..., { sessionId }): a same-id call
		// overwrites the prior attempt's session record in place.
		sessionRecords.set(sessionId, { attempt, transcript: `attempt-${attempt} transcript` });
		if (attempt === 1) {
			// Transient infra failure → the loop must retry (ECONNRESET is a
			// transient marker in verification-logic.ts).
			return { passed: false, output: "LLM review failed: read ECONNRESET", sessionId };
		}
		return { passed: true, output: "LGTM", sessionId };
	};

	const signal = {
		id: SIGNAL_ID,
		gateId: GATE_ID,
		goalId: GOAL_ID,
		sessionId: "team-lead",
		timestamp: Date.now(),
		commitSha: "abc123",
		verification: { status: "running", steps: [] },
	};
	const gate = {
		id: GATE_ID,
		name: "Implementation",
		verify: [{ name: "Code quality review", type: "llm-review", prompt: "review the diff", timeout: 600, phase: 0 }],
	};

	await harness.verifyGateSignal(
		signal as any,
		gate as any,
		stateDir, // cwd (git is stubbed away)
		undefined, // goalBranch — undefined skips the worktree git-sync block
		"master",
		new Map(),
		"goal spec",
	);

	assert.equal(
		capturedSessionIds.length,
		2,
		`${MARKER}: expected the bounded retry loop to run exactly 2 attempts, got ${capturedSessionIds.length}`,
	);
	const [attempt1Id, attempt2Id] = capturedSessionIds;
	assert.notEqual(
		attempt1Id,
		attempt2Id,
		`${MARKER}: reviewer retry reused the same session id across attempts (attempt1=${attempt1Id}, attempt2=${attempt2Id}). Each from-scratch attempt must get a FRESH session id so a prior attempt's transcript is not clobbered.`,
	);
	assert.equal(
		sessionRecords.size,
		2,
		`${MARKER}: attempt 1's session record was clobbered — only ${sessionRecords.size} distinct reviewer session record(s) exist after 2 attempts. Reusing the session id overwrites the earlier transcript.`,
	);
	assert.equal(
		sessionRecords.get(attempt1Id)?.transcript,
		"attempt-1 transcript",
		`${MARKER}: attempt 1's transcript was overwritten by attempt 2 (found "${sessionRecords.get(attempt1Id)?.transcript}"). Prior attempts must remain viewable at their original session URLs.`,
	);
});

test("verification_result arriving during teardown is honored, not 404-dropped", async () => {
	const GOAL_ID = "goal-review-reliability-2";
	const stateDir = makeStateDir("verif-review-late-verdict-");

	const gateStore = { getGate: () => ({ signals: [] }) };
	const goalStore = { get: () => ({ id: GOAL_ID }) }; // not paused, not sandboxed
	const projectConfigStore = { get: () => "", getWithDefaults: () => ({}) };
	const ctx = { project: { id: "p", name: "p" }, goalStore, gateStore, projectConfigStore };
	const pcm = {
		getContextForGoal: (id: string) => (id === GOAL_ID ? ctx : null),
		all: () => [ctx],
	};
	const roleStore = { get: () => undefined, getAll: () => [] };

	const fakeSession = {
		cwd: stateDir,
		lastTurnErrored: false,
		rpcClient: {
			prompt: async () => {},
			onEvent: () => () => {},
			setThinkingLevel: async () => {},
		},
	};

	let terminateCalled = false;
	// Mirror the exact server.ts channel: look up the resolver for the session
	// and 404 when it is gone (server.ts:~15882).
	let channelStatus: number | null = null;
	let lateVerdictHonored = false;

	const sm: any = {
		isSandboxEnabled: false,
		createSession: async () => fakeSession,
		setTitle: () => {},
		updateSessionMeta: () => {},
		getSession: () => fakeSession,
		getMcpManager: () => undefined,
		// Reviewer goes idle without ever calling verification_result → the
		// harness proceeds to its single reminder and then teardown.
		waitForIdle: async () => {},
		// Not streaming after the reminder (the bug-reproducing condition).
		waitForStreaming: async () => { throw new Error("not streaming"); },
		terminateSession: async (sid: string) => {
			terminateCalled = true;
			// Reproduce the delete-vs-late-POST race: the reviewer's
			// verification_result POST lands DURING teardown. Deliver it via the
			// same lookup the server performs.
			const resolver = harness.pendingResults.get(sid);
			channelStatus = resolver ? 200 : 404;
			if (resolver) {
				lateVerdictHonored = true;
				resolver({ verdict: true, summary: "late pass delivered during teardown" });
			}
		},
	};

	const harness = new VerificationHarness(
		stateDir,
		undefined,
		() => {},
		roleStore as any,
		undefined,
		sm,
		undefined,
		undefined,
		pcm as any,
		undefined,
		{ clock: makeFakeClock() as any },
	) as any;

	const role = { promptTemplate: "You are a code reviewer.", name: "reviewer" };
	const reviewerSessionId = "llm-review-latepost1";

	await harness.runLlmReviewViaSession(
		{ name: "Code quality review", prompt: "review the diff", timeout: 600, role: "reviewer" },
		stateDir,
		GOAL_ID,
		role,
		"combined prompt",
		"kickoff message",
		600_000,
		reviewerSessionId,
	);

	assert.equal(
		terminateCalled,
		true,
		`${MARKER}: expected reviewer teardown (terminateSession) to run — test precondition not met.`,
	);
	assert.notEqual(
		channelStatus,
		404,
		`${MARKER}: a verification_result arriving during teardown was 404-dropped (the pendingResults resolver was deleted before the verdict landed). A late verdict must be honored, not silently lost.`,
	);
	assert.equal(
		lateVerdictHonored,
		true,
		`${MARKER}: late verification_result was not honored during teardown — the delete-vs-late-POST race silently dropped a real pass.`,
	);
});
