import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";

import {
	initAuthorSidecarDir,
	promptAuthorBindingMatchesText,
	readAuthorSidecar,
} from "../../src/server/agent/author-sidecar.ts";
import {
	VerificationHarness,
	VERIFICATION_RESULT_REMINDER,
} from "../../src/server/agent/verification-harness.ts";

it("VerificationHarness persists its actual resumed-review reminder as verification-authored without changing prompt bytes", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verification-author-producer-"));
	const sessionId = "verification-author-producer-session";
	const promptCalls: unknown[][] = [];
	let harness: VerificationHarness;
	try {
		initAuthorSidecarDir(stateDir, {
			secretsDir: path.join(stateDir, "private-secrets"),
			hmacKey: Buffer.alloc(32, 0x33),
		});
		const dispatchPrompt = async (text: string, options?: unknown) => {
			promptCalls.push([text, options]);
			const resolver = (harness as any).pendingResults.get(sessionId);
			resolver?.({ verdict: true, summary: "Reminder handled." });
			return { success: true };
		};
		const fakeSession = {
			id: sessionId,
			status: "idle",
			nonInteractive: true,
			restoreStartupWasStreaming: false,
			rpcClient: {
				onEvent: (_fn: (event: any) => void) => () => {},
				waitForReady: async () => {},
				prompt: dispatchPrompt,
				promptWhenReady: dispatchPrompt,
			},
		};
		const sessionManager = {
			getSession: () => fakeSession,
			waitForIdle: () => new Promise<void>(() => {}),
			waitForStreaming: () => Promise.resolve(),
			terminateSession: () => Promise.resolve(),
		} as any;
		const gateStore = {
			updateSignalVerification: () => {},
			updateGateStatus: () => {},
			getGate: () => undefined,
			getGatesForGoal: () => [],
		} as any;
		harness = new VerificationHarness(
			stateDir,
			gateStore,
			() => {},
			{ get: () => undefined, getAll: () => [] } as any,
			undefined,
			sessionManager,
			{ registerReviewerSession: () => {}, unregisterReviewerSession: () => {} } as any,
		);

		const result = await (harness as any)._tryResumeFromSession(
			{ goalId: "goal-1", gateId: "gate-1", signalId: "signal-1" },
			{
				name: "Author reminder review",
				type: "llm-review",
				status: "running",
				startedAt: 1_700_000_000_000,
				sessionId,
			},
		);

		assert.equal(result.passed, true);
		assert.deepEqual(
			promptCalls,
			[[VERIFICATION_RESULT_REMINDER, undefined]],
			"VerificationHarness must deliver the exact pre-existing reminder bytes and RPC argument shape",
		);
		const bindings = readAuthorSidecar(sessionId);
		assert.equal(bindings.length, 1);
		assert.equal(bindings[0].schemaVersion, 2);
		assert.equal(bindings[0].modelText, undefined);
		assert.equal(promptAuthorBindingMatchesText(bindings[0], VERIFICATION_RESULT_REMINDER), true);
		assert.equal(bindings[0].source, "verification");
		assert.deepEqual(bindings[0].author, {
			kind: "system",
			id: "system:bobbit",
			label: "Bobbit",
		});
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
