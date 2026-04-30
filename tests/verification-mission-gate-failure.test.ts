/**
 * Bug 3 regression: when a mission-gate verification step fails, the gate
 * MUST transition from `running` to `failed` (and never get stuck `running`).
 *
 * This unit test drives `verifyMissionGateSignal` directly with a synthetic
 * gate definition whose step type is unsupported by the mission-owned path.
 * The harness should:
 *   1. Mark the step `passed:false` (output: `not supported in v1`).
 *   2. Call markStatus("failed", ...) which calls
 *        - gateStore.updateSignalVerification(signalId, {status:"failed",...})
 *        - gateStore.updateGateStatusFor("mission", missionId, gateId, "failed")
 *
 * Asserting the second store update is the heart of the regression: a stuck
 * `running` gate after agent idle/timeout means this code path didn't run.
 *
 * The shared LLM-review reminder/timeout logic (runLlmReviewViaSession) is
 * tested via the existing goal-path tests; this test just verifies the
 * mission status-finalisation pipe is wired so reminder/timeout failures
 * actually flow through to the gate store.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GateStore } from "../src/server/agent/gate-store.ts";
import { RoleStore } from "../src/server/agent/role-store.ts";
import { VerificationHarness } from "../src/server/agent/verification-harness.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mission-verify-"));
}

describe("verifyMissionGateSignal — finalises gate status on step failure", () => {
	it("transitions gate from running to failed (no stuck-running)", async () => {
		const dir = tmpDir();
		const gateStore = new GateStore(dir);
		const roleStore = new RoleStore(dir);
		const broadcasts: any[] = [];
		const harness = new VerificationHarness(
			dir,
			gateStore,
			(_id, ev) => broadcasts.push(ev),
			roleStore,
		);

		const missionId = "mission-" + randomUUID().slice(0, 8);
		const gateId = "charter";
		// Synthetic gate def with one step whose type is unsupported for mission
		// gates (anything other than "command" or "llm-review"). The mission
		// path explicitly returns passed:false and `output: "...not supported in v1"`.
		const gate: any = {
			id: gateId,
			content: true,
			dependsOn: [],
			verify: [{ name: "Bogus check", type: "agent-qa" }],
		};

		// Initialize gate states + record a "running" signal for the gate.
		gateStore.initGatesFor("mission", missionId, [gateId]);
		const signal: any = {
			id: randomUUID(),
			gateId,
			ownerKind: "mission",
			ownerId: missionId,
			goalId: missionId,
			sessionId: "test-session",
			timestamp: Date.now(),
			commitSha: "mission",
			verification: { status: "running", steps: [] },
		};
		gateStore.recordSignal(signal);

		// Sanity: gate is running before we kick verification.
		assert.equal(gateStore.getGateFor("mission", missionId, gateId)?.status, "pending");

		await harness.verifyMissionGateSignal(
			missionId,
			signal,
			gate,
			dir,
			"mission/integration",
			"master",
			new Map(),
			"",
		);

		// Gate must have moved to "failed" — never stuck "running".
		const finalGate = gateStore.getGateFor("mission", missionId, gateId);
		assert.ok(finalGate, "gate state must exist after verification");
		assert.equal(finalGate!.status, "failed", `gate status must be failed, got "${finalGate!.status}"`);

		// Signal verification must also be finalised (status != "running").
		const finalSignal = finalGate!.signals.find(s => s.id === signal.id);
		assert.ok(finalSignal, "signal must exist on gate");
		assert.notEqual(finalSignal!.verification.status, "running",
			"signal verification must not be stuck running");
		assert.equal(finalSignal!.verification.status, "failed");

		// Status-changed broadcast was emitted.
		const statusBroadcasts = broadcasts.filter(b => b?.type === "gate_status_changed");
		assert.ok(statusBroadcasts.some(b => b.status === "failed"),
			"a gate_status_changed=failed event must be broadcast");
	});

	it("auto-passes a mission gate with no verify steps (sanity / control)", async () => {
		const dir = tmpDir();
		const gateStore = new GateStore(dir);
		const roleStore = new RoleStore(dir);
		const harness = new VerificationHarness(
			dir, gateStore, () => {}, roleStore,
		);

		const missionId = "mission-" + randomUUID().slice(0, 8);
		const gateId = "auto-pass";
		const gate: any = { id: gateId, content: true, dependsOn: [], verify: [] };

		gateStore.initGatesFor("mission", missionId, [gateId]);
		const signal: any = {
			id: randomUUID(),
			gateId,
			ownerKind: "mission",
			ownerId: missionId,
			goalId: missionId,
			sessionId: "test-session",
			timestamp: Date.now(),
			commitSha: "mission",
			verification: { status: "running", steps: [] },
		};
		gateStore.recordSignal(signal);

		await harness.verifyMissionGateSignal(
			missionId, signal, gate, dir, "branch", "master", new Map(), "",
		);

		assert.equal(gateStore.getGateFor("mission", missionId, gateId)?.status, "passed");
	});
});
