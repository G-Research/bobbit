// v2-native — deterministic verifier contention coverage using the actual
// SessionManager queue/dispatch implementation and a Pi-shaped RPC transport.

import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { initAuthorSidecarDir } from "../../src/server/agent/author-sidecar.ts";
import { EventBuffer } from "../../src/server/agent/event-buffer.ts";
import { PromptQueue } from "../../src/server/agent/prompt-queue.ts";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import { VerificationHarness } from "../../src/server/agent/verification-harness.ts";
import { createManualClock } from "../harness/clock.js";
import { FakePinnedCheckoutManager, TEST_PINNED_COMMIT } from "../harness/fake-pinned-checkout-manager.js";
import { copyGitTemplate } from "../harness/git-template.js";
import { createRunChild } from "../harness/run-isolation.js";

const MARKER = "VERIFIER_BUSY_CONCURRENCY_REPRO";
const BUSY_ERROR = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

const tempRoots: string[] = [];
const sourceRoots = new Map<string, string>();

/**
 * A run-owned Git template and independent state directory keep this fixture
 * self-contained. The Tier-1 fake manager below is lifecycle-faithful; raw Git
 * process execution belongs to the pinned-checkout manager suite.
 */
function makeStateDir(prefix: string): string {
	const root = createRunChild(prefix);
	const sourceRoot = copyGitTemplate(path.join(root, "source"));
	tempRoots.push(root);
	const stateDir = path.join(root, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	sourceRoots.set(stateDir, sourceRoot);
	return stateDir;
}

async function eventually(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 2));
	}
	assert.fail(`${MARKER}: ${message}`);
}

type PendingPiCommand = {
	sessionId: string;
	text: string;
	streamingBehavior: unknown;
	settled: ReturnType<typeof deferred<{ success: true }>>;
	stopped: boolean;
};

/**
 * Models a responsive Pi RPC transport with an active SDK turn. Direct prompt
 * delivery always gets Pi's busy rejection; the SAME command is accepted when
 * `streamingBehavior: "followUp"` is supplied atomically.
 */
class BusyPiTransport {
	readonly commands: PendingPiCommand[] = [];
	readonly rawBusyAttempts = new Map<string, number>();
	readonly stoppedSessions = new Set<string>();

	prompt(sessionId: string, text: string, _images?: unknown, _third?: unknown, streamingBehavior?: unknown): Promise<{ success: true }> {
		if (streamingBehavior !== "followUp") {
			this.rawBusyAttempts.set(sessionId, (this.rawBusyAttempts.get(sessionId) ?? 0) + 1);
			return Promise.reject(new Error(BUSY_ERROR));
		}
		const settled = deferred<{ success: true }>();
		this.commands.push({ sessionId, text, streamingBehavior, settled, stopped: false });
		return settled.promise;
	}

	pending(sessionId: string): PendingPiCommand | undefined {
		return this.commands.find(command => command.sessionId === sessionId && !command.stopped);
	}

	accept(sessionId: string): void {
		const command = this.pending(sessionId);
		assert.ok(command, `${MARKER}: expected one queued atomic Pi command for ${sessionId}`);
		command.settled.resolve({ success: true });
	}

	stop(sessionId: string): void {
		this.stoppedSessions.add(sessionId);
		for (const command of this.commands) {
			if (command.sessionId !== sessionId || command.stopped) continue;
			command.stopped = true;
			command.settled.reject(new Error("reviewer session terminated before queued followUp started"));
		}
	}
}

const managers: any[] = [];

function makeSessionManager(stateDir: string): any {
	const clock = createManualClock(1_700_000_000_000);
	const manager: any = new SessionManager({
		clock,
		stateDir,
		projectContextManager: {} as any,
	});
	clock.clearInterval(manager._statusHeartbeatTimer);
	manager._statusHeartbeatTimer = null;
	manager.projectContextManager = null;
	manager._testClock = clock;
	manager._testStore = {
		get: () => undefined,
		getAll: () => [],
		getLive: () => [],
		update: () => {},
		archiveAsync: async () => {},
	};
	// Reviewer construction is not the unit under test. Keep the production
	// SessionManager instance for all prompt admission and delivery behavior.
	manager.setTitle = () => {};
	manager.updateSessionMeta = () => {};
	managers.push(manager);
	return manager;
}

function putReviewer(manager: any, transport: BusyPiTransport, sessionId: string, goalId: string): any {
	const session: any = {
		id: sessionId,
		title: `Reviewer ${goalId}`,
		titleGenerated: true,
		cwd: "/virtual/project",
		goalId,
		status: "idle",
		statusVersion: 0,
		createdAt: manager._testClock.now(),
		lastActivity: manager._testClock.now(),
		clients: new Set(),
		promptQueue: new PromptQueue(),
		eventBuffer: new EventBuffer(),
		setupComplete: true,
		transcriptMarker: `preserved transcript for ${goalId}`,
		unsubscribe: () => {},
		rpcClient: {
			onEvent: () => () => {},
			prompt: (text: string, images?: unknown, third?: unknown, streamingBehavior?: unknown) =>
				transport.prompt(sessionId, text, images, third, streamingBehavior),
			getState: async () => ({}),
			stop: async () => { transport.stop(sessionId); },
		},
	};
	manager.sessions.set(sessionId, session);
	return session;
}

function makeHarness(goalIds: string[], stateDir: string, manager: any) {
	const sourceRoot = sourceRoots.get(stateDir);
	assert.ok(sourceRoot, `${MARKER}: fixture source root is missing`);
	const commitSha = TEST_PINNED_COMMIT;
	const pinnedCheckoutManager = new FakePinnedCheckoutManager(path.join(stateDir, "verification-checkouts"));
	initAuthorSidecarDir(stateDir, {
		secretsDir: path.join(stateDir, "private-secrets"),
		hmacKey: Buffer.alloc(32, 0x5b),
	});
	const verificationWrites: Array<{ signalId: string; verification: any }> = [];
	const gateStatusWrites: Array<{ goalId: string; gateId: string; status: string }> = [];
	const gates = new Map(goalIds.map(goalId => [goalId, { status: "pending", signals: [] as any[] }]));
	const gateStore = {
		getGate: (goalId: string) => gates.get(goalId),
		getGatesForGoal: (goalId: string) => [gates.get(goalId)],
		updateSignalVerification: (signalId: string, verification: any) => verificationWrites.push({ signalId, verification }),
		updateGateStatus: (goalId: string, gateId: string, status: string) => {
			gateStatusWrites.push({ goalId, gateId, status });
			const gate = gates.get(goalId);
			if (gate) gate.status = status;
		},
	};
	const projectContextManager = {
		getContextForGoal: (goalId: string) => goalIds.includes(goalId) ? {
			project: { id: "project-verifier-contention", name: "Verifier contention" },
			goalStore: { get: (id: string) => id === goalId ? { id, title: goalId, state: "active", branch: `goal/${goalId}` } : undefined },
			gateStore,
			projectConfigStore: { get: () => "", getWithDefaults: () => ({}), getComponents: () => [], getQaMaxDurationMinutes: () => 1 },
		} : null,
		all: () => [],
	};
	const harness: any = new VerificationHarness(
		stateDir,
		gateStore as any,
		() => {},
		{ get: (name: string) => name === "reviewer" ? { name, promptTemplate: "Review faithfully.", accessory: "magnifier" } : undefined, getAll: () => [] } as any,
		undefined,
		manager,
		{ registerReviewerSession: () => {}, unregisterReviewerSession: () => {}, getTeamState: () => undefined } as any,
		undefined,
		projectContextManager as any,
		undefined,
		{
			// The fake is the Tier-1 lifecycle seam: it gives every UUID signal a
			// distinct immutable lease and validates it before and after review.
			commandRunner: {
				execFile: async (file: string, args: string[]) => file === "git" && args.join(" ") === "rev-parse --verify HEAD^{commit}"
					? { stdout: `${commitSha}\n`, stderr: "" }
					: { stdout: "", stderr: "" },
			} as any,
			// LLM reviewer admission is the unit under test; this explicit Tier-1
			// backend avoids requiring Docker after the real frozen source is acquired.
			verificationExecutionBackend: { acquire: async ({ checkout }: any) => ({ cwd: checkout.path }) },
			pinnedCheckoutManager: pinnedCheckoutManager as any,
			clock: manager._testClock,
		},
	);
	harness.resolveVerificationBaseBranch = async () => "main";
	harness.resolveLegacyMasterBranch = async () => "main";
	return { harness, verificationWrites, gateStatusWrites, gates, sourceRoot, commitSha, pinnedCheckoutManager };
}

function installReviewerCreation(manager: any, transport: BusyPiTransport): void {
	manager.createSession = async (_cwd: string, _args: unknown, goalId: string, _assistantType: unknown, opts: { sessionId: string }) =>
		putReviewer(manager, transport, opts.sessionId, goalId);
}

function reviewStep(name: string) {
	return { name, prompt: `Review ${name}`, timeout: 60, role: "reviewer" };
}

function gate() {
	return { id: "review-gate", name: "Review gate", dependsOn: [], verify: [{ name: "Busy review", type: "llm-review", prompt: "Review", timeout: 60, phase: 0 }] };
}

function signal(goalId: string, id: string, commitSha: string) {
	return {
		id: randomUUID(),
		goalId,
		gateId: "review-gate",
		sessionId: `${goalId}-lead`,
		timestamp: Date.now(),
		commitSha,
		content: `review artifact ${id}`,
		metadata: {},
		verification: { status: "running", steps: [] },
	};
}

afterEach(() => {
	while (managers.length > 0) {
		const manager = managers.pop();
		manager._testClock?.clearInterval(manager._statusHeartbeatTimer);
		manager.sessions.clear();
	}
	while (tempRoots.length > 0) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
	sourceRoots.clear();
});

describe("verifier busy concurrency reproductions", () => {
	it("drives two concurrent goals through real SessionManager atomic followUp delivery exactly once", async () => {
		const stateDir = makeStateDir("verifier-busy-concurrent-");
		const manager = makeSessionManager(stateDir);
		const transport = new BusyPiTransport();
		installReviewerCreation(manager, transport);
		const goalAlpha = "goal-busy-alpha";
		const goalBeta = "goal-busy-beta";
		const { harness, sourceRoot } = makeHarness([goalAlpha, goalBeta], stateDir, manager);
		const alphaId = "reviewer-alpha-preserved";
		const betaId = "reviewer-beta-preserved";

		const alpha = harness.runLlmReviewViaSession(reviewStep("Alpha"), sourceRoot, goalAlpha, { name: "reviewer", promptTemplate: "Review faithfully." }, "role context", "alpha kickoff", 60_000, alphaId);
		const beta = harness.runLlmReviewViaSession(reviewStep("Beta"), sourceRoot, goalBeta, { name: "reviewer", promptTemplate: "Review faithfully." }, "role context", "beta kickoff", 60_000, betaId);

		await eventually(() => transport.pending(alphaId) !== undefined && transport.pending(betaId) !== undefined,
			"both healthy-but-processing Pi reviewers must receive one atomic followUp command");
		assert.equal(transport.commands.length, 2, `${MARKER}: two goals must produce exactly two distinct provider commands`);
		assert.deepEqual(new Set(transport.commands.map(command => command.sessionId)), new Set([alphaId, betaId]));
		assert.ok(transport.commands.every(command => command.streamingBehavior === "followUp"), `${MARKER}: Pi must receive followUp in the original RPC command`);
		assert.ok(transport.commands.every(command => command.text.startsWith("[System]: ")), `${MARKER}: verifier prompts retain system attribution at the provider boundary`);
		assert.equal(manager.getSession(alphaId).transcriptMarker, `preserved transcript for ${goalAlpha}`);
		assert.equal(manager.getSession(betaId).transcriptMarker, `preserved transcript for ${goalBeta}`);

		transport.accept(alphaId);
		transport.accept(betaId);
		harness.pendingResults.get(alphaId)?.({ verdict: true, summary: "alpha verdict" });
		harness.pendingResults.get(betaId)?.({ verdict: true, summary: "beta verdict" });
		manager.getSession(alphaId).status = "idle";
		manager.getSession(betaId).status = "idle";
		const [alphaResult, betaResult] = await Promise.all([alpha, beta]);

		assert.equal(alphaResult.passed, true, `${MARKER}: alpha result=${JSON.stringify(alphaResult)}`);
		assert.equal(betaResult.passed, true, `${MARKER}: beta result=${JSON.stringify(betaResult)}`);
		assert.equal(transport.commands.filter(command => command.sessionId === alphaId).length, 1, `${MARKER}: alpha must not raw-retry or duplicate its kickoff`);
		assert.equal(transport.commands.filter(command => command.sessionId === betaId).length, 1, `${MARKER}: beta must not raw-retry or duplicate its kickoff`);
		assert.equal(transport.rawBusyAttempts.size, 0, `${MARKER}: a raw prompt would have been rejected busy; followUp must be atomic`);
		assert.doesNotMatch(`${alphaResult.output}\n${betaResult.output}`, /Agent is already processing/i);
	});

	it("cancels one exact queued receipt when dispatch admission times out", async () => {
		const stateDir = makeStateDir("verifier-busy-dispatch-timeout-");
		const manager = makeSessionManager(stateDir);
		const transport = new BusyPiTransport();
		const goalId = "goal-busy-dispatch-timeout";
		const { harness } = makeHarness([goalId], stateDir, manager);
		const session = putReviewer(manager, transport, "reviewer-dispatch-timeout", goalId);
		session.status = "streaming";
		session.promptQueue.enqueue("ordinary durable queue row");

		const dispatch = harness.dispatchVerifierPrompt(session, "timed-out verifier receipt", {
			goalId,
			gateId: "review-gate",
			signalId: "signal-dispatch-timeout",
			stepName: "Busy review",
			verifierKind: "llm-review",
			promptKind: "reminder",
		});
		await eventually(
			() => session.promptQueue.toArray().some((row: any) => row.text === "timed-out verifier receipt"),
			"VERIFIER_BUSY_CONCURRENCY_REPRO: receipt must remain durable while the reviewer streams",
		);
		manager._testClock.advance(60_000);
		await assert.rejects(dispatch, /Verifier prompt .* did not dispatch within 60000ms/);

		assert.deepEqual(
			session.promptQueue.toArray().map((row: any) => row.text),
			["ordinary durable queue row"],
			"VERIFIER_BUSY_CONCURRENCY_REPRO: timeout cancellation removes only the verifier-owned row",
		);
		assert.equal(transport.commands.length, 0, "the queued receipt must not dispatch after its owner timed out");
	});

	it("fences queued reviewers before held same-phase command cleanup in stale-gate and goal-wide cancellation", async () => {
		for (const cancellation of [
			{ name: "stale-gate", run: (harness: any, goalId: string) => harness.cancelStaleVerificationsForGates(goalId, ["review-gate"]) },
			{ name: "goal-wide", run: (harness: any, goalId: string) => harness.cancelAllVerifications(goalId) },
		]) {
			const stateDir = makeStateDir(`verifier-cancel-order-${cancellation.name}-`);
			const manager = makeSessionManager(stateDir);
			const transport = new BusyPiTransport();
			installReviewerCreation(manager, transport);
			const goalId = `goal-cancel-order-${cancellation.name}`;
			const { harness, verificationWrites, gates, sourceRoot, commitSha, pinnedCheckoutManager } = makeHarness([goalId], stateDir, manager);
			const oldSignal = signal(goalId, `signal-cancel-order-old-${cancellation.name}`, commitSha);
			gates.get(goalId)!.signals.push(oldSignal);
			const oldSessionId = `reviewer-cancel-order-${cancellation.name}`;
			const oldSession = putReviewer(manager, transport, oldSessionId, goalId);
			oldSession.status = "streaming";
			const active = {
				goalId,
				gateId: "review-gate",
				signalId: oldSignal.id,
				overallStatus: "running",
				startedAt: Date.now(),
				steps: [
					{ name: "held command", type: "command", status: "running", phase: 0, startedAt: Date.now() },
					{ name: "queued review", type: "llm-review", status: "running", phase: 0, startedAt: Date.now(), sessionId: oldSessionId },
				],
			};
			harness.activeVerifications.set(oldSignal.id, active);
			harness._persistActive();
			let lateVerdicts = 0;
			harness.pendingResults.set(oldSessionId, () => { lateVerdicts += 1; });

			const queued = harness.dispatchVerifierPrompt(oldSession, "queued old verifier", {
				goalId,
				gateId: "review-gate",
				signalId: oldSignal.id,
				stepName: "queued review",
				verifierKind: "llm-review",
				promptKind: "reminder",
			});
			const queuedCancelled = queued;
			await eventually(
				() => oldSession.promptQueue.toArray().some((row: any) => row.text === "queued old verifier"),
				`${MARKER}: ${cancellation.name} must start with one queued reviewer receipt`,
			);

			const cleanupStarted = deferred<void>();
			const releaseCleanup = deferred<void>();
			const heldCommand = active.steps[0];
			harness._killTrackedForSignal = async () => {
				cleanupStarted.resolve();
				await releaseCleanup.promise;
				// Production only reports tracked cleanup settled after it durably
				// records this exact command's kill completion. Mirror that contract:
				// a bare `true` leaves the cancellation intentionally pending.
				(heldCommand as any).killCompletedAt ??= Date.now();
				return true;
			};
			harness._killPersistedCommandSteps = async () => true;
			const cancelling = cancellation.run(harness, goalId);
			await cleanupStarted.promise;

			assert.equal(manager.getSession(oldSessionId), undefined, `${MARKER}: ${cancellation.name} must terminate the queued reviewer before command cleanup settles`);
			assert.equal((await queuedCancelled).type, "cancelled", `${MARKER}: ${cancellation.name} must resolve the exact queued receipt as cancelled before teardown`);
			assert.equal(oldSession.promptQueue.toArray().some((row: any) => row.text === "queued old verifier"), false, `${MARKER}: ${cancellation.name} must purge its exact queued verifier receipt`);
			const cancelledAdmission = await harness.dispatchVerifierPrompt(oldSession, "must not enqueue after cancellation", {
				goalId, gateId: "review-gate", signalId: oldSignal.id, stepName: "queued review",
				verifierKind: "llm-review", promptKind: "reminder",
			});
			assert.equal(cancelledAdmission.type, "cancelled", `${MARKER}: ${cancellation.name} must fence admission after its exact signal generation is cancelled`);
			// A stale agent_end after termination must find no verifier row to drain.
			oldSession.status = "idle";
			(manager as any).drainQueue(oldSession);
			await Promise.resolve();
			assert.equal(transport.commands.length, 0, `${MARKER}: stale agent_end must not dispatch an old reviewer turn`);
			harness.pendingResults.get(oldSessionId)?.({ verdict: true, summary: "STALE_LATE_VERDICT" });
			assert.equal(lateVerdicts, 1, `${MARKER}: test must model the late old verdict`);
			assert.equal(verificationWrites.length, 0, `${MARKER}: no cancellation or stale verdict may publish while command cleanup is held`);
			assert.equal(harness.activeVerifications.has(oldSignal.id), true, `${MARKER}: cancellation must remain active until exact command cleanup completes`);

			releaseCleanup.resolve();
			await cancelling;
			assert.equal(harness.activeVerifications.has(oldSignal.id), false, `${MARKER}: old cancellation finalizes only after command cleanup`);

			const replacementSignal = signal(goalId, `signal-cancel-order-replacement-${cancellation.name}`, commitSha);
			gates.get(goalId)!.signals.push(replacementSignal);
			const replacementRun = harness.verifyGateSignal(replacementSignal, gate(), sourceRoot, `goal/${goalId}`, "main", new Map(), "goal spec");
			await eventually(() => transport.commands.length === 1, `${MARKER}: replacement alone must dispatch its reviewer`);
			const replacementSessionId = transport.commands[0].sessionId;
			transport.accept(replacementSessionId);
			harness.pendingResults.get(replacementSessionId)?.({ verdict: true, summary: "replacement only verdict" });
			manager.getSession(replacementSessionId).status = "idle";
			await replacementRun;
			assert.deepEqual(pinnedCheckoutManager.acquiredSourceRoots, [sourceRoot], `${MARKER}: replacement must acquire an isolated frozen source before reviewer dispatch`);
			assert.deepEqual(pinnedCheckoutManager.releasedSignalIds, [replacementSignal.id], `${MARKER}: replacement must release its exact frozen-source lease`);
			assert.ok(pinnedCheckoutManager.assertionCount >= 2, `${MARKER}: frozen source must be audited before and after the reviewer step`);
			const replacementWrite = verificationWrites.find(write => write.signalId === replacementSignal.id);
			assert.equal(replacementWrite?.verification.status, "passed", `${MARKER}: ${cancellation.name} replacement alone must publish the verdict`);
			assert.doesNotMatch(JSON.stringify(replacementWrite), /STALE_LATE_VERDICT/);
		}
	});

	it("terminates a queued followUp on cancel/re-signal and fences its late verdict from the replacement", async () => {
		const stateDir = makeStateDir("verifier-busy-resignal-");
		const manager = makeSessionManager(stateDir);
		const transport = new BusyPiTransport();
		installReviewerCreation(manager, transport);
		const goalId = "goal-busy-resignal";
		const { harness, verificationWrites, gateStatusWrites, gates, sourceRoot, commitSha, pinnedCheckoutManager } = makeHarness([goalId], stateDir, manager);
		const oldSignal = signal(goalId, "signal-busy-old", commitSha);
		const replacementSignal = signal(goalId, "signal-busy-replacement", commitSha);
		gates.get(goalId)!.signals.push(oldSignal);

		const oldRun = harness.verifyGateSignal(oldSignal, gate(), sourceRoot, `goal/${goalId}`, "main", new Map(), "goal spec");
		await eventually(() => transport.commands.length === 1, "old signal should be waiting in Pi's followUp queue");
		const oldSessionId = transport.commands[0].sessionId;

		await harness.cancelStaleVerifications(goalId, "review-gate");
		assert.equal(transport.stoppedSessions.has(oldSessionId), true, `${MARKER}: cancellation must terminate the reviewer owning the queued followUp`);
		assert.equal(manager.getSession(oldSessionId), undefined, `${MARKER}: cancelled reviewer must no longer be live for a stale delivery`);
		// This models a delayed tool POST after the old transport's cancellation.
		harness.pendingResults.get(oldSessionId)?.({ verdict: true, summary: "STALE_OLD_VERDICT_MUST_NOT_PUBLISH" });

		gates.get(goalId)!.signals.push(replacementSignal);
		const replacementRun = harness.verifyGateSignal(replacementSignal, gate(), sourceRoot, `goal/${goalId}`, "main", new Map(), "goal spec");
		await eventually(() => transport.commands.length === 2, "replacement signal should receive its own atomic followUp delivery");
		const replacementSessionId = transport.commands[1].sessionId;
		assert.notEqual(replacementSessionId, oldSessionId, `${MARKER}: re-signal must never reuse the superseded reviewer identity`);

		transport.accept(replacementSessionId);
		harness.pendingResults.get(replacementSessionId)?.({ verdict: true, summary: "replacement verdict" });
		manager.getSession(replacementSessionId).status = "idle";
		await Promise.all([oldRun, replacementRun]);

		assert.deepEqual(pinnedCheckoutManager.acquiredSourceRoots, [sourceRoot, sourceRoot], `${MARKER}: both signal generations must acquire their own frozen source before reviewer dispatch`);
		assert.deepEqual(new Set(pinnedCheckoutManager.releasedSignalIds), new Set([oldSignal.id, replacementSignal.id]), `${MARKER}: cancellation and replacement must release only their own frozen-source leases`);
		assert.ok(pinnedCheckoutManager.assertionCount >= 3, `${MARKER}: each source generation must be audited around reviewer execution`);
		const replacementWrite = verificationWrites.find(write => write.signalId === replacementSignal.id);
		assert.equal(replacementWrite?.verification.status, "passed", `${MARKER}: replacement must pass after its own verdict. writes=${JSON.stringify(verificationWrites)}`);
		assert.doesNotMatch(JSON.stringify(replacementWrite), /STALE_OLD_VERDICT_MUST_NOT_PUBLISH/);
		assert.equal(transport.commands.filter(command => command.sessionId === oldSessionId).length, 1, `${MARKER}: cancellation must not redrain the old queued followUp`);
		assert.equal(transport.commands.filter(command => command.sessionId === replacementSessionId).length, 1, `${MARKER}: replacement accepts exactly one provider command`);
		assert.equal(gateStatusWrites.at(-1)?.status, "passed", `${MARKER}: stale cancellation must not leave the replacement gate failed`);
	});
});
