import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VerificationHarness, type ActiveVerification } from "../../src/server/agent/verification-harness.js";

const CONTAINER_ID = "container-under-test";
const VERIFICATION_NONCE = "pid-reuse-verification-nonce";
const SENTINEL_PID = 321_654;
const ORIGINAL_START_TOKEN = "original-sentinel-start-token";
const REUSED_START_TOKEN = "reused-sentinel-start-token";
const WITNESS_START_TOKEN_MISMATCH = "BOBBIT_CONTAINER_WITNESS_START_TOKEN_MISMATCH";

function makeHarness(stateDir: string): VerificationHarness {
	return new VerificationHarness(
		stateDir,
		{
			updateSignalVerification: () => {},
			updateGateStatus: () => {},
			getGate: () => undefined,
		} as any,
		() => {},
		{ get: () => undefined, getAll: () => [] } as any,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			platform: "linux",
			// The recovered process has reused the sentinel's historical numeric
			// PID and remains a PGID leader. Only its Linux start token exposes
			// that it is unrelated work in this shared container.
			containerProcessIdentityInspector: async (containerId: string, pid: number) => {
				assert.equal(containerId, CONTAINER_ID);
				assert.equal(pid, SENTINEL_PID);
				return { pid: SENTINEL_PID, pgid: SENTINEL_PID, startToken: REUSED_START_TOKEN };
			},
		} as any,
	);
}

test("PID-reused container sentinel never authorizes a negative-PGID signal", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-container-witness-pid-reuse-"));
	const signalAttempts: string[] = [];
	try {
		const harness = makeHarness(stateDir);
		(harness as any)._dockerExecCapture = async (containerId: string, command: string) => {
			assert.equal(containerId, CONTAINER_ID);
			if (/kill\s+-(?:TERM|KILL)\s+--\s+-\$?\w+/.test(command)) {
				// Record the resolved destructive target rather than the shell
				// variable used by the transport script, making the RED diagnostic
				// independent of shell formatting.
				signalAttempts.push(`kill -TERM -- -${SENTINEL_PID}`);
			}
			// The unsafe historical recovery implementation reaches this response
			// after finding no exit file, then attempts to signal -321654. The fixed
			// implementation must reject its exact witness before issuing this call.
			return { code: 0, stdout: "" };
		};

		const step: any = {
			name: "PID-reused recovered container command",
			type: "command",
			status: "running",
			phase: 0,
			startedAt: Date.now() - 1_000,
			startTimeMs: Date.now() - 1_000,
			deadlineMs: Date.now() - 1,
			containerId: CONTAINER_ID,
			restartRecoveryMode: "container-exec",
			exitFile: "/tmp/.bobbit-verif/pid-reuse.exit",
			pidFile: "/tmp/.bobbit-verif/pid-reuse.pid",
			pidNonce: VERIFICATION_NONCE,
			containerOwnershipWitness: {
				containerId: CONTAINER_ID,
				nonce: VERIFICATION_NONCE,
				sentinelPid: SENTINEL_PID,
				pgid: SENTINEL_PID,
				startToken: ORIGINAL_START_TOKEN,
			},
		};
		const active: ActiveVerification = {
			goalId: "goal-container-pid-reuse",
			gateId: "implementation",
			signalId: "sig-container-pid-reuse",
			overallStatus: "running",
			startedAt: Date.now(),
			currentPhase: 0,
			steps: [step],
		};

		// Recovery helpers only act on the exact active-verification instance the
		// harness loaded from durable state; an unregistered object intentionally
		// behaves as a cancelled resume and would hide the destructive path.
		(harness as any).activeVerifications.set(active.signalId, active);

		let cleanupError: unknown;
		try {
			await (harness as any)._resumeContainerCommandStep(active, step, {
				finalize: () => { throw new Error("must not finalize a PID-reused container command"); },
				timeoutResult: () => { throw new Error("must not publish a timeout before exact container cleanup"); },
				restartInterrupted: () => { throw new Error("must preserve failed-closed cleanup as pending"); },
			});
		} catch (error) {
			cleanupError = error;
		}

		assert.deepEqual(
			signalAttempts,
			[],
			`${WITNESS_START_TOKEN_MISMATCH}: a reused in-container sentinel PID must never receive a negative-PGID signal`,
		);
		assert.equal(step.killUnsafeReason, WITNESS_START_TOKEN_MISMATCH);
		assert.match(String((cleanupError as Error | undefined)?.message), new RegExp(WITNESS_START_TOKEN_MISMATCH));
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
