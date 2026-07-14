// v2-native — timeout marker propagation through verification, persistence,
// snapshots, and WebSocket sanitization.

import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GateStore } from "../../src/server/agent/gate-store.js";
import { buildGateVerificationSnapshot } from "../../src/server/gate-verification-snapshot.js";
import { VerificationHarness, sanitizeVerificationWsEvent } from "../../src/server/agent/verification-harness.js";

const MARKER = "REVIEW_TIMEOUT_PAYLOAD";
const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeStateDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-timeout-payload-"));
	tempRoots.push(root);
	const stateDir = path.join(root, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	return stateDir;
}

describe("review timeout payload propagation", () => {
	it("keeps timeout status/timing across start, completion, GateStore reload, snapshot, and sanitization", async () => {
		const goalId = "goal-review-timeout-payload";
		const gateId = "implementation";
		const signalId = "signal-review-timeout-payload";
		const stateDir = makeStateDir();
		const gateStore = new GateStore(stateDir);
		gateStore.initGatesForGoal(goalId, [gateId]);

		const signal = {
			id: signalId,
			gateId,
			goalId,
			sessionId: "team-lead",
			timestamp: Date.now(),
			commitSha: "abc123",
			verification: { status: "running" as const, steps: [] },
		};
		gateStore.recordSignal(signal);

		const workflowGate = {
			id: gateId,
			name: "Implementation",
			verify: [{ name: "Focused review", type: "llm-review", prompt: "Review the timeout contract", timeout: 7, phase: 0 }],
		};
		const goalStore = {
			get: (id: string) => id === goalId ? { id, title: "Goal", state: "active", branch: "goal/review-timeout" } : undefined,
			bumpGeneration: () => {},
		};
		const ctx = {
			project: { id: "project-review-timeout", name: "Review timeout" },
			goalStore,
			gateStore,
			projectConfigStore: {
				get: () => "",
				getWithDefaults: () => ({}),
				getComponents: () => [],
				getQaMaxDurationMinutes: () => 10,
			},
		};
		const projectContextManager = {
			getContextForGoal: (id: string) => id === goalId ? ctx : null,
			all: () => [ctx],
		};
		const events: any[] = [];
		let fakeNow = 0;
		const fakeClock = {
			now: () => fakeNow,
			setTimeout: (handler: () => void, ms: number) => {
				fakeNow += Math.max(0, ms);
				return globalThis.setTimeout(handler, 0);
			},
			setInterval: (handler: () => void, ms: number) => globalThis.setInterval(handler, ms),
			clearTimeout: (handle: any) => globalThis.clearTimeout(handle),
		};
		const harness = new VerificationHarness(
			stateDir,
			gateStore,
			(_id, event) => events.push(event),
			{ get: () => undefined, getAll: () => [] } as any,
			undefined,
			undefined,
			undefined,
			undefined,
			projectContextManager as any,
			undefined,
			{ clock: fakeClock as any },
		) as any;

		// Keep this integration deterministic: drive the real phase/event/store
		// plumbing while replacing only the external reviewer leaf.
		harness.resolveVerificationBaseBranch = async () => "master";
		harness.resolveLegacyMasterBranch = async () => "master";
		harness.runLlmReviewStep = async () => ({
			passed: false,
			status: "timeout",
			timeout: { configuredSeconds: 7, elapsedMs: 7_004 },
			output: "LLM review timed out after 7s.",
			sessionId: "llm-review-timeout-payload",
		});

		await harness.verifyGateSignal(
			signal as any,
			workflowGate as any,
			stateDir,
			undefined,
			"master",
			new Map(),
			"goal spec",
		);

		const started = events.find(event => event.type === "gate_verification_step_started");
		assert.ok(started, `${MARKER}: missing step-start event`);
		assert.equal(started.timeoutSec, 7, `${MARKER}: resolved allowance missing from start event`);

		const completed = events.find(event => event.type === "gate_verification_step_complete");
		assert.ok(completed, `${MARKER}: missing step-complete event`);
		assert.equal(completed.status, "timeout", `${MARKER}: timeout was collapsed to generic failed`);
		assert.deepEqual(completed.timeout, { configuredSeconds: 7, elapsedMs: 7_004 });

		const reloaded = new GateStore(stateDir);
		const persistedGate = reloaded.getGate(goalId, gateId);
		const persistedSignal = persistedGate?.signals.find(candidate => candidate.id === signalId);
		assert.equal(persistedGate?.status, "failed", `${MARKER}: overall gate outcome must remain failed`);
		assert.equal(persistedSignal?.verification.status, "failed");
		assert.equal(persistedSignal?.verification.steps[0]?.passed, false);
		assert.equal(persistedSignal?.verification.steps[0]?.status, "timeout");
		assert.deepEqual(persistedSignal?.verification.steps[0]?.timeout, { configuredSeconds: 7, elapsedMs: 7_004 });

		const snapshot = buildGateVerificationSnapshot({
			goalId,
			gateId,
			signalId,
			verification: persistedSignal!.verification,
			now: Date.now(),
		});
		assert.equal(snapshot.status, "failed");
		assert.equal(snapshot.steps[0]?.status, "timeout");
		assert.equal(snapshot.counts.timeout, 1);
		assert.deepEqual(snapshot.steps[0]?.timeout, { configuredSeconds: 7, elapsedMs: 7_004 });

		const largeOutput = `LLM review timed out after 7s.\n${"diagnostic ".repeat(20_000)}`;
		const sanitized = sanitizeVerificationWsEvent({
			type: "gate_verification_step_complete",
			goalId,
			gateId,
			signalId,
			stepIndex: 0,
			stepName: "Focused review",
			status: "timeout",
			timeout: { configuredSeconds: 7, elapsedMs: 7_004 },
			durationMs: 7_200,
			output: largeOutput,
		}) as any;
		assert.equal(sanitized.status, "timeout");
		assert.deepEqual(sanitized.timeout, { configuredSeconds: 7, elapsedMs: 7_004 });
		assert.equal(sanitized.outputTruncated, true, `${MARKER}: test precondition requires output sanitization`);
	});

	it("maps a timed-out active row without relying on output text", () => {
		const timeout = { configuredSeconds: 45, elapsedMs: 45_321 };
		const snapshot = buildGateVerificationSnapshot({
			goalId: "goal-active-timeout",
			gateId: "gate-active-timeout",
			signalId: "signal-active-timeout",
			verification: {
				status: "failed",
				steps: [{
					name: "QA timeout",
					type: "agent-qa",
					status: "timeout",
					passed: false,
					output: "opaque diagnostic with no timeout words",
					duration_ms: 90_000,
					timeout,
				}],
			},
			now: Date.now(),
		});
		assert.equal(snapshot.steps[0]?.status, "timeout");
		assert.deepEqual(snapshot.steps[0]?.timeout, timeout);
		assert.equal(snapshot.counts.timeout, 1);
		assert.equal(snapshot.counts.failed, 0, `${MARKER}: timeout has its own step count while top-level verification stays failed`);
	});
});
