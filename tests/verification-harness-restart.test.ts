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

test("resumeInterruptedVerifications finalizes a step as failed when pid is alive but startTimeMs indicates pid reuse", async () => {
	// Pin the `pidLooksReused` safeguard inside _resumeCommandStep.
	//
	// Setup: persisted command step with this process's own pid (so the OS
	// pid-existence probe in Case B says "alive"), bootEpoch matching the
	// running harness (so `areVerificationSessionsAlive` would otherwise
	// treat it as ours), and a `startTimeMs` so old that `Date.now() -
	// startTimeMs > timeoutSec * 1000`. The original child cannot still be
	// running — the step's own timeout would have killed it long ago — so
	// the live pid must belong to a recycled, unrelated OS process. The
	// resume path must finalize the step as failed (Case C), NOT enter
	// Case B and poll until the deadline.
	const persistPath = path.join(STATE_DIR, "active-verifications.json");
	try { fs.unlinkSync(persistPath); } catch { /* ignore */ }

	// First, construct a harness so we can read its bootEpoch.
	const { harness } = makeHarness();
	const bootEpoch = (harness as unknown as { bootEpoch: string }).bootEpoch;

	const startedAt = Date.now() - 999_999; // ~16.6 min ago
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
						name: "Recycled-pid check",
						type: "command",
						status: "running",
						startedAt,
						// `process.pid` is, by definition, a live OS pid (this test runner).
						// It cannot be the original verification child — startTimeMs is
						// older than the 300s step timeout — so it must be a recycled pid.
						pid: process.pid,
						startTimeMs: startedAt,
						bootEpoch,
						timeoutSec: 300,
					},
				],
			},
		],
	};
	fs.writeFileSync(persistPath, JSON.stringify(data, null, 2));

	// Re-construct so the new disk fixture is loaded into activeVerifications.
	const { harness: harness2 } = makeHarness();
	// Use the same bootEpoch as the disk fixture so the resume path treats
	// the persisted entry as something this process owns.
	(harness2 as unknown as { bootEpoch: string }).bootEpoch = bootEpoch;

	// Resume must finalize (not block until deadline). Wrap in a deadline
	// guard so a regression doesn't hang the unit-test runner.
	const resumePromise = harness2.resumeInterruptedVerifications();
	const deadlineMs = 10_000;
	const racer = new Promise<"timeout">(r => setTimeout(() => r("timeout"), deadlineMs));
	const winner = await Promise.race([resumePromise.then(() => "ok" as const), racer]);
	assert.notStrictEqual(
		winner,
		"timeout",
		`resumeInterruptedVerifications did not finalize within ${deadlineMs}ms — pidLooksReused safeguard appears to be missing and Case B is polling for a live (recycled) pid until the step deadline.`,
	);

	// Verification must be cleaned up just like any other failed-on-resume zombie.
	const remainingIds = harness2.getActiveVerifications().map(v => v.signalId);
	assert.ok(
		!remainingIds.includes(SIGNAL_ID),
		`pid-reuse verification not cleaned up after resume — still present: ${JSON.stringify(remainingIds)}`,
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

	// Pin the disk-side cleanup too: the persisted active-verifications.json
	// must not still reference the zombie signal, or a subsequent boot would
	// reload it and re-trigger the same HTTP 409 lock.
	const persistPath = path.join(STATE_DIR, "active-verifications.json");
	if (fs.existsSync(persistPath)) {
		const raw = fs.readFileSync(persistPath, "utf-8");
		assert.ok(
			!raw.includes(SIGNAL_ID),
			`zombie verification still present on disk in ${persistPath} after resumeInterruptedVerifications — next boot would reload it.`,
		);
	}

	// And the duplicate-detection probe must now agree.
	assert.strictEqual(
		harness.areVerificationSessionsAlive(SIGNAL_ID),
		false,
		"after resumeInterruptedVerifications, areVerificationSessionsAlive must return false for the cleaned-up signal",
	);
});
