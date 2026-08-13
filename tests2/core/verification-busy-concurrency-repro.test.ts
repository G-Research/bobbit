// v2-native — failing-first verifier contention coverage. Listed in tests-map.json `v2Native`.
//
// This test intentionally models provider idleness separately from RPC
// responsiveness. Each reviewer is healthy but rejects a direct prompt once
// with Pi's exact already-processing error. The verifier must enqueue one
// delivery per session, preserve goal/session isolation, and fence a late
// verdict from a cancelled signal.

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initAuthorSidecarDir } from "../../src/server/agent/author-sidecar.ts";
import { VerificationHarness } from "../../src/server/agent/verification-harness.ts";

const MARKER = "VERIFIER_BUSY_CONCURRENCY_REPRO";
const BUSY_ERROR = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";

type QueuedDelivery = {
	sessionId: string;
	text: string;
	cancelled: boolean;
	resolve: () => void;
	reject: (error: Error) => void;
};

function makeStateDir(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const stateDir = path.join(root, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	return stateDir;
}

async function eventually(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.fail(`${MARKER}: ${message}`);
}

/**
 * A provider-shaped delivery controller. `rpcClient.prompt()` is deliberately
 * the unsafe direct boundary: it always throws busy. The SessionManager queue
 * API below admits exactly one intent, then this controller releases it only
 * when the test declares that the existing turn settled.
 */
class BusyOnceDeliveryController {
	readonly directAttempts = new Map<string, number>();
	readonly accepted = new Map<string, number>();
	readonly queued: QueuedDelivery[] = [];
	readonly sessions = new Map<string, any>();
	readonly sessionGoals = new Map<string, string>();
	private harness!: VerificationHarness;

	attachHarness(harness: VerificationHarness): void {
		this.harness = harness;
	}

	createSession(sessionId: string, goalId: string): any {
		const session = {
			id: sessionId,
			status: "streaming",
			transcriptMarker: `preserved transcript for ${goalId}`,
			lastTurnErrored: false,
			rpcClient: {
				onEvent: (_listener: (event: any) => void) => () => {},
				prompt: async () => {
					this.directAttempts.set(sessionId, (this.directAttempts.get(sessionId) ?? 0) + 1);
					throw new Error(BUSY_ERROR);
				},
				promptWhenReady: async () => {
					this.directAttempts.set(sessionId, (this.directAttempts.get(sessionId) ?? 0) + 1);
					throw new Error(BUSY_ERROR);
				},
			},
		};
		this.sessions.set(sessionId, session);
		this.sessionGoals.set(sessionId, goalId);
		return session;
	}

	queue(sessionId: string, text: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.queued.push({ sessionId, text, cancelled: false, resolve, reject });
		});
	}

	queuedForGoal(goalId: string): QueuedDelivery[] {
		return this.queued.filter(item => this.sessionGoals.get(item.sessionId) === goalId && !item.cancelled);
	}

	release(sessionId: string, summary: string): void {
		const item = this.queued.find(candidate => candidate.sessionId === sessionId && !candidate.cancelled);
		assert.ok(item, `${MARKER}: expected one live queued delivery for ${sessionId}`);
		const session = this.sessions.get(sessionId)!;
		this.accepted.set(sessionId, (this.accepted.get(sessionId) ?? 0) + 1);
		session.status = "streaming";
		this.harness.pendingResults.get(sessionId)?.({ verdict: true, summary });
		session.status = "idle";
		item.resolve();
	}

	cancelSession(sessionId: string): void {
		for (const item of this.queued) {
			if (item.sessionId === sessionId && !item.cancelled) {
				item.cancelled = true;
				item.reject(new Error("verification prompt delivery cancelled"));
			}
		}
	}

	publishLate(sessionId: string, summary: string): void {
		this.harness.pendingResults.get(sessionId)?.({ verdict: true, summary });
	}
}

function makeHarness(goalIds: string[], controller: BusyOnceDeliveryController, stateDir: string) {
	initAuthorSidecarDir(stateDir, {
		secretsDir: path.join(stateDir, "private-secrets"),
		hmacKey: Buffer.alloc(32, 0x5b),
	});
	const verificationWrites: Array<{ signalId: string; verification: any }> = [];
	const gateStatusWrites: Array<{ goalId: string; gateId: string; status: string }> = [];
	const gateStates = new Map(goalIds.map(goalId => [goalId, { status: "pending", signals: [] as any[] }]));
	const gateStore = {
		getGate: (goalId: string) => gateStates.get(goalId),
		getGatesForGoal: (goalId: string) => [gateStates.get(goalId)],
		updateSignalVerification: (signalId: string, verification: any) => {
			verificationWrites.push({ signalId, verification });
		},
		updateGateStatus: (goalId: string, gateId: string, status: string) => {
			gateStatusWrites.push({ goalId, gateId, status });
			const gate = gateStates.get(goalId);
			if (gate) gate.status = status;
		},
	};
	const projectContextManager = {
		getContextForGoal: (goalId: string) => goalIds.includes(goalId) ? {
			project: { id: "project-busy-concurrency", name: "Busy concurrency" },
			goalStore: { get: (id: string) => id === goalId ? { id, title: goalId, state: "active", branch: `goal/${goalId}` } : undefined },
			gateStore,
			projectConfigStore: {
				get: () => "",
				getWithDefaults: () => ({}),
				getComponents: () => [],
				getQaMaxDurationMinutes: () => 1,
			},
		} : null,
		all: () => [],
	};
	const sessionManager: any = {
		isSandboxEnabled: false,
		createSession: async (_cwd: string, _args: unknown, goalId: string, _assistantType: unknown, opts: any) => controller.createSession(opts.sessionId, goalId),
		getSession: (sessionId: string) => controller.sessions.get(sessionId),
		setTitle: () => {},
		updateSessionMeta: () => {},
		waitForIdle: async () => {},
		waitForStreaming: async () => {},
		terminateSession: async (sessionId: string) => { controller.cancelSession(sessionId); },
		// Expected verifier-owned durable delivery API. Keep enqueuePrompt as an
		// alias so the contract also accepts an implementation built directly on
		// SessionManager's existing durable FIFO queue.
		enqueueVerificationPrompt: async (sessionId: string, text: string) => controller.queue(sessionId, text),
		enqueuePrompt: async (sessionId: string, text: string) => controller.queue(sessionId, text),
		queueVerificationPrompt: async (sessionId: string, text: string) => controller.queue(sessionId, text),
	};
	const harness = new VerificationHarness(
		stateDir,
		gateStore as any,
		() => {},
		{ get: (name: string) => name === "reviewer" ? { name, promptTemplate: "Review faithfully.", accessory: "magnifier" } : undefined, getAll: () => [] } as any,
		undefined,
		sessionManager,
		{ registerReviewerSession: () => {}, unregisterReviewerSession: () => {}, getTeamState: () => undefined } as any,
		undefined,
		projectContextManager as any,
		undefined,
		{ commandRunner: { execFile: async () => ({ stdout: "", stderr: "" }) } as any },
	) as any;
	// Keep the focused test independent of Git/worktree discovery.
	harness.resolveVerificationBaseBranch = async () => "main";
	harness.resolveLegacyMasterBranch = async () => "main";
	controller.attachHarness(harness);
	return { harness, verificationWrites, gateStatusWrites };
}

function llmGate(goalId: string) {
	return {
		id: "review-gate",
		name: "Review gate",
		dependsOn: [],
		verify: [{ name: "Busy review", type: "llm-review", prompt: `Review ${goalId}`, timeout: 60, phase: 0 }],
	};
}

function signal(goalId: string, id: string) {
	return {
		id,
		goalId,
		gateId: "review-gate",
		sessionId: `${goalId}-lead`,
		timestamp: Date.now(),
		commitSha: `${id}-commit`,
		content: "review artifact",
		metadata: {},
		verification: { status: "running", steps: [] },
	};
}

describe("verifier busy concurrency reproductions", () => {
	it("isolates two concurrent goals: each busy reviewer queues once on its own preserved session and completes once", async () => {
		const goalAlpha = "goal-busy-alpha";
		const goalBeta = "goal-busy-beta";
		const controller = new BusyOnceDeliveryController();
		const { harness } = makeHarness([goalAlpha, goalBeta], controller, makeStateDir("verifier-busy-concurrent-"));

		const alphaSessionId = "reviewer-alpha-preserved";
		const betaSessionId = "reviewer-beta-preserved";
		const alpha = (harness as any).runLlmReviewViaSession(
			{ name: "Alpha review", prompt: "alpha", timeout: 60, role: "reviewer" },
			process.cwd(), goalAlpha, { name: "reviewer", promptTemplate: "Review faithfully." }, "role context", "alpha kickoff", 60_000, alphaSessionId,
		);
		const beta = (harness as any).runLlmReviewViaSession(
			{ name: "Beta review", prompt: "beta", timeout: 60, role: "reviewer" },
			process.cwd(), goalBeta, { name: "reviewer", promptTemplate: "Review faithfully." }, "role context", "beta kickoff", 60_000, betaSessionId,
		);

		await eventually(
			() => controller.queuedForGoal(goalAlpha).length === 1 && controller.queuedForGoal(goalBeta).length === 1,
			`both healthy-but-busy reviewers must be admitted to independent durable queues instead of terminally failing. direct=${JSON.stringify(Object.fromEntries(controller.directAttempts))}`,
		);
		assert.notEqual(alphaSessionId, betaSessionId, `${MARKER}: distinct goals must never share a reviewer session id`);
		assert.equal(controller.sessions.get(alphaSessionId)?.transcriptMarker, `preserved transcript for ${goalAlpha}`, `${MARKER}: alpha must retain its original reviewer context`);
		assert.equal(controller.sessions.get(betaSessionId)?.transcriptMarker, `preserved transcript for ${goalBeta}`, `${MARKER}: beta must retain its original reviewer context`);

		controller.release(alphaSessionId, "alpha verdict");
		controller.release(betaSessionId, "beta verdict");
		const [alphaResult, betaResult] = await Promise.all([alpha, beta]);

		assert.equal(alphaResult.passed, true, `${MARKER}: alpha busy reviewer must complete after its queued prompt starts. result=${JSON.stringify(alphaResult)}`);
		assert.equal(betaResult.passed, true, `${MARKER}: beta busy reviewer must complete after its queued prompt starts. result=${JSON.stringify(betaResult)}`);
		assert.equal(controller.accepted.get(alphaSessionId), 1, `${MARKER}: alpha provider must accept exactly one logical kickoff`);
		assert.equal(controller.accepted.get(betaSessionId), 1, `${MARKER}: beta provider must accept exactly one logical kickoff`);
		assert.equal(controller.directAttempts.get(alphaSessionId) ?? 0, 0, `${MARKER}: alpha must not issue a raw duplicate prompt after busy contention`);
		assert.equal(controller.directAttempts.get(betaSessionId) ?? 0, 0, `${MARKER}: beta must not issue a raw duplicate prompt after busy contention`);
		assert.doesNotMatch(`${alphaResult.output}\n${betaResult.output}`, /Agent is already processing/i, `${MARKER}: busy contention is infrastructure queueing, never a terminal reviewer finding`);
	});

	it("cancel/re-signal fences a queued old reviewer and cannot publish its late verdict into the replacement signal", async () => {
		const goalId = "goal-busy-resignal";
		const oldSignal = signal(goalId, "signal-busy-old");
		const replacementSignal = signal(goalId, "signal-busy-replacement");
		const controller = new BusyOnceDeliveryController();
		const { harness, verificationWrites, gateStatusWrites } = makeHarness([goalId], controller, makeStateDir("verifier-busy-resignal-"));

		const oldRun = harness.verifyGateSignal(oldSignal, llmGate(goalId), process.cwd(), `goal/${goalId}`, "main", new Map(), "goal spec");
		await eventually(
			() => controller.queuedForGoal(goalId).length === 1,
			"the original signal must remain queued while its healthy reviewer finishes the prior turn",
		);
		const oldSessionId = controller.queuedForGoal(goalId)[0].sessionId;

		await harness.cancelStaleVerifications(goalId, "review-gate");
		controller.publishLate(oldSessionId, "STALE_OLD_VERDICT_MUST_NOT_PUBLISH");

		const replacementRun = harness.verifyGateSignal(replacementSignal, llmGate(goalId), process.cwd(), `goal/${goalId}`, "main", new Map(), "goal spec");
		await eventually(
			() => controller.queuedForGoal(goalId).length === 1,
			"the replacement signal must receive its own fresh queued reviewer delivery",
		);
		const replacementSessionId = controller.queuedForGoal(goalId)[0].sessionId;
		assert.notEqual(replacementSessionId, oldSessionId, `${MARKER}: re-signal must not revive the superseded reviewer session`);
		controller.release(replacementSessionId, "replacement verdict");
		await Promise.all([oldRun, replacementRun]);

		const replacementWrite = verificationWrites.find(write => write.signalId === replacementSignal.id);
		assert.equal(replacementWrite?.verification.status, "passed", `${MARKER}: replacement signal must be the only completed verdict after cancellation. writes=${JSON.stringify(verificationWrites)}`);
		assert.doesNotMatch(JSON.stringify(replacementWrite), /STALE_OLD_VERDICT_MUST_NOT_PUBLISH/, `${MARKER}: late old verdict crossed the signal fence and overwrote/reached the replacement signal`);
		assert.equal(controller.accepted.get(oldSessionId) ?? 0, 0, `${MARKER}: cancelled queued old delivery must never reach the provider`);
		assert.equal(controller.accepted.get(replacementSessionId), 1, `${MARKER}: replacement delivery must reach the provider exactly once`);
		assert.equal(gateStatusWrites.at(-1)?.status, "passed", `${MARKER}: replacement signal should leave the gate passed, never failed from stale busy contention`);
	});
});
