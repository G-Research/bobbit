/**
 * Reproducing regression test for the verification-lock-after-restart bug.
 *
 * See goal "Unstick verification lock on restart" / Issue Analysis gate.
 *
 * Scenario: the gateway is killed while a command-type verification step is
 * running. On restart, `.bobbit/state/active-verifications.json` is reloaded
 * into `activeVerifications` with the step's persisted `status: "running"`
 * and no `sessionId` (command steps don't have sessions). The next
 * `gate_signal` on the same SHA then goes through the duplicate-detection
 * path which calls `areVerificationSessionsAlive(signalId)`. That method
 * currently treats `status === "running" && !sessionId` as "process is
 * alive" and returns `true`, locking the gate behind HTTP 409 even though
 * the child process is long dead.
 *
 * EXPECTED (post-fix):
 *   - `areVerificationSessionsAlive(signalId) === false` for a zombie
 *     command step loaded from disk in a brand-new harness process.
 *   - After `resumeInterruptedVerifications()`, the entry is gone from the
 *     in-memory `activeVerifications` map (`getActiveVerifications()`).
 *
 * CURRENT MASTER (failing): assertion 1 fails — the alive-check returns
 * `true` because of the `!step.sessionId → return true` fast-path in
 * `areVerificationSessionsAlive`.
 *
 * This test must FAIL on master and PASS once both bugs are fixed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verif-restart-test-"));
const STATE_DIR = path.join(TEST_DIR, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

const SIGNAL_ID = "sig-zombie-1";
const GOAL_ID = "goal-test";
const GATE_ID = "implementation";

/**
 * Write a synthetic active-verifications.json containing one in-flight
 * command-type verification with `status: "running"` and no `sessionId` —
 * the exact shape a real gateway leaves on disk after being SIGKILLed
 * mid-verification.
 */
function seedPersistedZombie(): void {
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
						name: "Long test",
						type: "command",
						status: "running",
						startedAt,
						// No sessionId — command steps never have one.
					},
				],
			},
		],
	};
	fs.writeFileSync(persistPath, JSON.stringify(data, null, 2));
}

/**
 * Minimal stubs for the harness dependencies the resume/alive-check paths
 * touch. We only need behaviour for: gate-store updates during resume (so
 * resume doesn't throw) and project-context lookup (returns null so the
 * resume path uses the non-PCM fallback gateStore).
 */
function makeHarness() {
	const gateStoreCalls: any[] = [];
	const stubGateStore = {
		updateSignalVerification: (...args: any[]) => { gateStoreCalls.push({ kind: "updateSignalVerification", args }); },
		updateGateStatus: (...args: any[]) => { gateStoreCalls.push({ kind: "updateGateStatus", args }); },
		getGate: () => undefined,
	} as any;

	const roleStore = {
		get: () => undefined,
		getAll: () => [],
	} as any;

	const harness = new VerificationHarness(
		STATE_DIR,
		stubGateStore,                  // gateStore (fallback path)
		() => {},                       // broadcastFn
		roleStore,                      // roleStore
		undefined,                      // preferencesStore
		undefined,                      // sessionManager
		undefined,                      // teamManager
		undefined,                      // projectConfigStore
		undefined,                      // projectContextManager (forces fallback gateStore)
		undefined,                      // configCascade
	);
	return { harness, gateStoreCalls };
}

test("areVerificationSessionsAlive returns false for a zombie command step loaded from disk", () => {
	seedPersistedZombie();
	const { harness } = makeHarness();

	// Constructor loads persisted entries into `activeVerifications` (see
	// verification-harness.ts around line 904-906) so the alive-check sees
	// the zombie immediately.
	const alive = harness.areVerificationSessionsAlive(SIGNAL_ID);

	assert.strictEqual(
		alive,
		false,
		"areVerificationSessionsAlive should return false for a zombie command step loaded from a previous server lifetime — a persisted `status: \"running\"` flag with no sessionId is NOT proof the OS process is alive after restart.",
	);
});

test("resumeInterruptedVerifications removes failed-on-resume zombie entries from activeVerifications", async () => {
	seedPersistedZombie();
	const { harness } = makeHarness();

	// Sanity: the zombie is currently visible in the in-memory map.
	const beforeIds = harness.getActiveVerifications().map(v => v.signalId);
	assert.ok(
		beforeIds.includes(SIGNAL_ID),
		`pre-condition: zombie verification should be loaded into activeVerifications, got ${JSON.stringify(beforeIds)}`,
	);

	await harness.resumeInterruptedVerifications();

	const afterIds = harness.getActiveVerifications().map(v => v.signalId);
	assert.ok(
		!afterIds.includes(SIGNAL_ID),
		`zombie verification not cleaned up after resumeInterruptedVerifications — still present in activeVerifications: ${JSON.stringify(afterIds)}. This is the root cause of the HTTP 409 lock-after-restart bug.`,
	);

	// And the duplicate-detection probe must now agree.
	assert.strictEqual(
		harness.areVerificationSessionsAlive(SIGNAL_ID),
		false,
		"after resumeInterruptedVerifications, areVerificationSessionsAlive must return false for the cleaned-up signal",
	);
});
