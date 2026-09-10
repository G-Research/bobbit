// v2-native — NOT a migrated legacy test. Discovered from canonical `tests/unit/core` path.
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
//   Invariant 2 — an authenticated `verification_result` arriving during
//     teardown is honored without retaining its capability beyond that narrow
//     window. The harness must defer SessionManager's normal secret revocation,
//     keep the pending resolver live through termination, then delete the
//     resolver and revoke the exact verifier secret in `finally` — including
//     when termination throws.
//
//     We drive the real `runLlmReviewViaSession` with a mock SessionManager and
//     a real SessionSecretStore. The reviewer goes idle without calling the
//     tool, then its exact secret submits during termination. Assertions pin
//     the capability's validity during teardown and immediate revocation once
//     pending-result cleanup completes.
//
//   Invariant 3 — verifier-only retention never cascades into child teardown.
//     The real SessionManager cascade seam must strip that one option so child
//     secrets are revoked normally while the verifier parent's secret remains
//     temporarily valid.
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

const { VerificationHarness } = await import("../../../src/server/agent/verification-harness.js");
const { isTransientReviewError, shouldRetryVerificationStep } = await import("../../../src/server/agent/verification-logic.js");
const { SessionSecretStore } = await import("../../../src/server/auth/session-secret.js");
const { SessionManager } = await import("../../../src/server/agent/session-manager.js");

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

test("verification_result arriving during teardown keeps only the exact verifier secret until pending cleanup", async () => {
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
	const reviewerSessionId = "llm-review-latepost1";
	const foreignSessionId = "llm-review-foreign-session";
	const sessionSecretStore = new SessionSecretStore();
	const exactSecret = sessionSecretStore.getOrCreateSecret(reviewerSessionId);
	const foreignSecret = sessionSecretStore.getOrCreateSecret(foreignSessionId);
	const secretRemovalWindows: string[] = [];
	const realRemove = sessionSecretStore.remove.bind(sessionSecretStore);
	let harness: any;
	sessionSecretStore.remove = (sessionId: string) => {
		secretRemovalWindows.push(harness?.pendingResults.has(sessionId) ? "pending" : "closed");
		realRemove(sessionId);
	};

	const fakeSession = {
		cwd: stateDir,
		lastTurnErrored: false,
		rpcClient: {
			prompt: async () => {},
			onEvent: () => () => {},
			setThinkingLevel: async () => {},
		},
	};

	let terminateOptions: Record<string, unknown> | undefined;
	let channelStatus: number | null = null;
	let lateVerdictHonored = false;

	const sm: any = {
		isSandboxEnabled: false,
		sessionSecretStore,
		createSession: async () => fakeSession,
		setTitle: () => {},
		updateSessionMeta: () => {},
		getSession: () => fakeSession,
		getMcpManager: () => undefined,
		// Reviewer goes idle without ever calling verification_result, so the
		// harness exhausts reminders and enters its late-verdict teardown window.
		waitForIdle: async () => {},
		waitForStreaming: async () => { throw new Error("not streaming"); },
		terminateSession: async (sid: string, options?: Record<string, unknown>) => {
			terminateOptions = options;
			// Model SessionManager's normal revocation. The verifier-only option must
			// defer it while pendingResults intentionally remains reachable.
			if (options?.deferSessionSecretRevocation !== true) sessionSecretStore.remove(sid);

			// Mirror server.ts authorization order: resolve the secret first, then
			// consult pendingResults. A foreign real secret must remain foreign.
			const authenticSessionId = sessionSecretStore.resolveSessionIdBySecret(exactSecret);
			assert.equal(sessionSecretStore.resolveSessionIdBySecret(foreignSecret), foreignSessionId);
			const resolver = harness.pendingResults.get(sid);
			channelStatus = authenticSessionId !== sid ? 403 : resolver ? 200 : 404;
			if (channelStatus === 200) {
				lateVerdictHonored = true;
				resolver({ verdict: true, summary: "late pass delivered during teardown" });
			}
		},
	};

	harness = new VerificationHarness(
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
	const result = await harness.runLlmReviewViaSession(
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
		terminateOptions?.deferSessionSecretRevocation,
		true,
		`${MARKER}: verifier teardown must explicitly defer secret revocation only for the live pending-result window.`,
	);
	assert.equal(
		channelStatus,
		200,
		`${MARKER}: the exact verifier secret did not authorize a verification_result during the intentionally retained teardown window (status=${channelStatus}).`,
	);
	assert.equal(lateVerdictHonored, true, `${MARKER}: the authenticated late verdict was not delivered.`);
	assert.equal(result.passed, true, `${MARKER}: the authenticated late verdict was not honored.`);
	assert.deepEqual(
		secretRemovalWindows,
		["closed"],
		`${MARKER}: the exact secret must be revoked once, immediately after pendingResults closes, never while it is live.`,
	);
	assert.equal(harness.pendingResults.has(reviewerSessionId), false, `${MARKER}: pending resolver leaked after verifier teardown.`);
	assert.equal(
		sessionSecretStore.resolveSessionIdBySecret(exactSecret),
		undefined,
		`${MARKER}: verifier secret remained valid after pending-result cleanup.`,
	);
	assert.equal(
		sessionSecretStore.resolveSessionIdBySecret(foreignSecret),
		foreignSessionId,
		`${MARKER}: verifier cleanup revoked another session's secret.`,
	);
});

test("verifier secret is revoked in finally when termination fails", async () => {
	const GOAL_ID = "goal-review-secret-cleanup-failure";
	const stateDir = makeStateDir("verif-review-secret-cleanup-failure-");
	const gateStore = { getGate: () => ({ signals: [] }) };
	const goalStore = { get: () => ({ id: GOAL_ID }) };
	const ctx = {
		project: { id: "p", name: "p" },
		goalStore,
		gateStore,
		projectConfigStore: { get: () => "", getWithDefaults: () => ({}) },
	};
	const pcm = { getContextForGoal: (id: string) => (id === GOAL_ID ? ctx : null), all: () => [ctx] };
	const reviewerSessionId = "llm-review-termination-error";
	const sessionSecretStore = new SessionSecretStore();
	const exactSecret = sessionSecretStore.getOrCreateSecret(reviewerSessionId);
	let harness: any;
	let terminateOptions: Record<string, unknown> | undefined;
	let secretOwnerDuringTermination: string | undefined;
	const removalWindows: string[] = [];
	const realRemove = sessionSecretStore.remove.bind(sessionSecretStore);
	sessionSecretStore.remove = (sessionId: string) => {
		removalWindows.push(harness?.pendingResults.has(sessionId) ? "pending" : "closed");
		realRemove(sessionId);
	};

	const fakeSession = {
		cwd: stateDir,
		lastTurnErrored: false,
		rpcClient: { prompt: async () => {}, onEvent: () => () => {}, setThinkingLevel: async () => {} },
	};
	const sm: any = {
		isSandboxEnabled: false,
		sessionSecretStore,
		createSession: async () => fakeSession,
		setTitle: () => {},
		updateSessionMeta: () => {},
		getSession: () => fakeSession,
		getMcpManager: () => undefined,
		waitForIdle: async () => {},
		waitForStreaming: async () => { throw new Error("not streaming"); },
		terminateSession: async (sid: string, options?: Record<string, unknown>) => {
			terminateOptions = options;
			if (options?.deferSessionSecretRevocation !== true) sessionSecretStore.remove(sid);
			secretOwnerDuringTermination = sessionSecretStore.resolveSessionIdBySecret(exactSecret);
			throw new Error("synthetic teardown failure");
		},
	};
	harness = new VerificationHarness(
		stateDir, undefined, () => {}, { get: () => undefined, getAll: () => [] } as any,
		undefined, sm, undefined, undefined, pcm as any, undefined,
		{ clock: makeFakeClock() as any },
	) as any;

	await harness.runLlmReviewViaSession(
		{ name: "Code quality review", prompt: "review the diff", timeout: 600, role: "reviewer" },
		stateDir,
		GOAL_ID,
		{ promptTemplate: "You are a code reviewer.", name: "reviewer" },
		"combined prompt",
		"kickoff message",
		600_000,
		reviewerSessionId,
	);

	assert.equal(terminateOptions?.deferSessionSecretRevocation, true, `${MARKER}: failed termination was not given the verifier-only retention boundary.`);
	assert.equal(secretOwnerDuringTermination, reviewerSessionId, `${MARKER}: exact secret was revoked before failed termination settled.`);
	assert.equal(harness.pendingResults.has(reviewerSessionId), false, `${MARKER}: termination failure leaked the pending resolver.`);
	assert.deepEqual(removalWindows, ["closed"], `${MARKER}: termination failure must revoke once, after pending cleanup.`);
	assert.equal(
		sessionSecretStore.resolveSessionIdBySecret(exactSecret),
		undefined,
		`${MARKER}: termination failure leaked the verifier secret after pending cleanup.`,
	);
});

test("verifier-only secret retention is not inherited by child cascade termination", async () => {
	const parentSessionId = "llm-review-parent";
	const childSessionId = "llm-review-child";
	const sessionSecretStore = new SessionSecretStore();
	const parentSecret = sessionSecretStore.getOrCreateSecret(parentSessionId);
	const childSecret = sessionSecretStore.getOrCreateSecret(childSessionId);
	let childTerminateOptions: Record<string, unknown> | undefined;

	const cascadeOwner: any = {
		sessions: new Map([[childSessionId, { id: childSessionId, delegateOf: parentSessionId }]]),
		projectContextManager: undefined,
		_testStore: { getLive: () => [] },
		orchestrationCore: undefined,
		terminateSession: async (sessionId: string, options?: Record<string, unknown>) => {
			childTerminateOptions = options;
			if (options?.deferSessionSecretRevocation !== true) sessionSecretStore.remove(sessionId);
		},
	};

	await (SessionManager.prototype as any).cascadeReapOwner.call(cascadeOwner, parentSessionId, {
		preserveEvidence: true,
		deferSessionSecretRevocation: true,
	});

	assert.equal(
		childTerminateOptions?.deferSessionSecretRevocation,
		undefined,
		`${MARKER}: verifier-only secret retention leaked into child cascade teardown.`,
	);
	assert.equal(childTerminateOptions?.preserveEvidence, true, `${MARKER}: cascade stripped an unrelated teardown option.`);
	assert.equal(
		sessionSecretStore.resolveSessionIdBySecret(childSecret),
		undefined,
		`${MARKER}: child secret survived because verifier-only retention cascaded to it.`,
	);
	assert.equal(
		sessionSecretStore.resolveSessionIdBySecret(parentSecret),
		parentSessionId,
		`${MARKER}: the parent verifier secret should remain valid until its own pending resolver closes.`,
	);
});

// Companion invariant (added by the fix): a "completed-but-missed-tool-call"
// reviewer outcome must be classified NON-transient, so the bounded retry loop
// does NOT throw away the reviewer's work with a fresh-ID from-scratch re-run.
// The fair-turn in-session re-nudge (MAX_REVIEWER_REMINDERS in
// runLlmReviewViaSession) is the recovery mechanism for this case — consistent
// with the QA path's intent (QA_NON_TRANSIENT_PATTERNS). If someone later adds
// this phrasing to the transient markers, this test fails loudly.
test("'did not call verification_result after reminder' is non-transient (no from-scratch re-run)", () => {
	const output = "Agent did not call verification_result after reminder.";
	assert.equal(
		isTransientReviewError(output),
		false,
		`${MARKER}: a completed-but-missed-tool-call outcome must NOT be transient — otherwise the loop re-runs from scratch and discards the reviewer's analysis.`,
	);
	const decision = shouldRetryVerificationStep({
		passed: false,
		output,
		attempt: 1,
		maxBoundedAttempts: 3,
		isTransient: isTransientReviewError,
	});
	assert.equal(
		decision,
		"break",
		`${MARKER}: the bounded retry loop must break (not from-scratch re-run) on a completed-but-missed-tool-call outcome; in-session re-nudging is the recovery path.`,
	);
});

// Companion invariant: an infra-transient reviewer failure (e.g. ECONNRESET)
// within budget must still request a from-scratch retry (which now mints a
// fresh session id per attempt). Guards against over-broadly reclassifying
// transient failures as terminal while fixing the missed-tool-call case.
test("transient reviewer failure within budget still retries from scratch", () => {
	const decision = shouldRetryVerificationStep({
		passed: false,
		output: "LLM review failed: read ECONNRESET",
		attempt: 1,
		maxBoundedAttempts: 3,
		isTransient: isTransientReviewError,
	});
	assert.equal(
		decision,
		"retry",
		`${MARKER}: a within-budget transient reviewer failure must still retry (fresh-id from-scratch attempt).`,
	);
});
