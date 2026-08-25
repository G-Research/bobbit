//
// Failing-first verifier lifecycle coverage for Retry Reviewer Resume.
// These tests pin that llm-review and agent-qa verifier sessions are recovered
// like regular Bobbit agents: same session identity/history, no blank same-id
// replacement, retryable infrastructure errors re-drive the existing session,
// dead processes get bounded same-session resurrection, and idle QA gets the
// same fair reminder/grace semantics as llm-review.

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
	VerificationHarness,
	VERIFIER_COLD_PROMPT_DISPATCH_TIMEOUT_MS,
	VERIFIER_PROMPT_DISPATCH_TIMEOUT_MS,
} = await import("../../../src/server/agent/verification-harness.js");
const {
	isTransientVerifierReviewError,
	isTransientVerifierQaError,
} = await import("../../../src/server/agent/verification-logic.js");
const {
	COLD_REPROMPT_PROMPT_TIMEOUT_MS,
	COLD_REPROMPT_READY_TIMEOUT_MS,
	RpcBridge,
} = await import("../../../src/server/agent/rpc-bridge.js");

const MARKER = "VERIFIER_LIFECYCLE_REPRO";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function makeStateDir(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const stateDir = path.join(root, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	return stateDir;
}

function makeFakeClock() {
	let now = 0;
	return {
		now: () => now,
		setTimeout: (handler: () => void, ms: number) => {
			now += Math.max(0, ms);
			return globalThis.setTimeout(handler, 0);
		},
		setInterval: (handler: () => void, ms: number) => globalThis.setInterval(handler, ms),
		clearTimeout: (handle: any) => globalThis.clearTimeout(handle),
	};
}

function makeManualClock() {
	let now = 0;
	let sequence = 0;
	const timers = new Map<number, { at: number; handler: () => void }>();
	return {
		now: () => now,
		setTimeout: (handler: () => void, ms: number) => {
			const id = ++sequence;
			timers.set(id, { at: now + Math.max(0, ms), handler });
			return id as any;
		},
		setInterval: (_handler: () => void, _ms: number) => 0 as any,
		clearTimeout: (id: number) => timers.delete(id),
		clearInterval: (_id: number) => {},
		advance: (ms: number) => {
			now += ms;
			for (const [id, timer] of [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at)) {
				timers.delete(id);
				timer.handler();
			}
		},
	};
}

function makeProjectContext(goalId: string, roleStore: any) {
	const ctx = {
		project: { id: "project-verifier-life", name: "Verifier lifecycle" },
		goalStore: { get: (id: string) => id === goalId ? { id, title: "Goal", state: "active" } : undefined },
		gateStore: { getGate: () => ({ signals: [] }) },
		projectConfigStore: {
			get: () => "",
			getWithDefaults: () => ({}),
			getComponents: () => [],
			getQaMaxDurationMinutes: () => 1,
		},
	};
	return {
		roleStore,
		projectContextManager: {
			getContextForGoal: (id: string) => id === goalId ? ctx : null,
			all: () => [ctx],
		},
	};
}

function verifierTeamManager() {
	return { registerReviewerSession: () => {}, unregisterReviewerSession: () => {}, getTeamState: () => undefined };
}

function qaRoleStore() {
	return {
		get: (name: string) => name === "qa-tester" || name === "test-engineer" || name === "reviewer"
			? { name, promptTemplate: "You are a QA verifier. Call verification_result when complete.", accessory: "clipboard" }
			: undefined,
		getAll: () => [{ name: "qa-tester", promptTemplate: "You are a QA verifier." }],
	};
}

describe("verifier lifecycle reproductions", () => {
	it("VERIFIER_BUSY_RACE_REPRO forwards atomic followUp behavior to Pi", async () => {
		const commands: Record<string, unknown>[] = [];
		const bridge = new RpcBridge({}) as any;
		bridge.sendCommand = async (command: Record<string, unknown>) => {
			commands.push(command);
			return { success: true };
		};
		bridge.waitForReady = async () => {};

		await bridge.prompt("ordinary prompt");
		await bridge.promptWhenReady("verifier follow-up", undefined, { streamingBehavior: "followUp" });

		assert.deepEqual(commands, [
			{ type: "prompt", message: "ordinary prompt" },
			{ type: "prompt", message: "verifier follow-up", streamingBehavior: "followUp" },
		], `${MARKER}: followUp must be carried in the one prompt RPC command, not retried after a busy rejection`);
	});

	it("agent-qa retryable fetch failures auto-retry the same session instead of creating an empty-history replacement", async () => {
		const goalId = "goal-agent-qa-fetch-retry";
		const stateDir = makeStateDir("verifier-agent-qa-fetch-");
		const prompts: string[] = [];
		const calls: string[] = [];
		const createdIds: string[] = [];
		const sessionId = "agent-qa-fetch-retry-same-session";
		let harness: any;

		const fakeSession = {
			id: sessionId,
			status: "idle",
			lastTurnErrored: true,
			lastTurnErrorMessage: "TypeError: fetch failed while streaming verifier response",
			pendingAutoRetryTimer: undefined,
			rpcClient: {
				onEvent: (_fn: (event: any) => void) => () => {},
				prompt: async (text: string) => {
					prompts.push(text);
					return { success: true };
				},
			},
		};

		const { roleStore, projectContextManager } = makeProjectContext(goalId, qaRoleStore());
		const sessionManager = {
			isSandboxEnabled: false,
			createSession: async (_cwd: string, _args: unknown, _goalId: string, _assistantType: unknown, opts: any) => {
				createdIds.push(opts.sessionId);
				assert.equal(
					createdIds.filter(id => id === opts.sessionId).length,
					1,
					`${MARKER}: agent-qa recovery must not recreate a blank session using the same session id ${opts.sessionId}`,
				);
				return fakeSession;
			},
			setTitle: () => {},
			updateSessionMeta: () => {},
			getSession: () => fakeSession,
			retryLastPrompt: async (sid: string, opts?: { auto?: boolean }) => {
				calls.push(`retryLastPrompt:${sid}:${opts?.auto === true}`);
				assert.equal(sid, sessionId, `${MARKER}: retry must target the original agent-qa session id`);
				fakeSession.lastTurnErrored = false;
				fakeSession.lastTurnErrorMessage = "";
				fakeSession.status = "streaming";
				const resolver = harness.pendingResults.get(sessionId);
				resolver?.({ verdict: true, summary: "Recovered same agent-qa session after fetch failed." });
			},
			waitForStreaming: async (sid: string) => {
				calls.push(`waitForStreaming:${sid}`);
				assert.equal(sid, sessionId, `${MARKER}: streaming grace must wait on the original agent-qa session id`);
			},
			waitForIdle: async (sid: string) => {
				calls.push(`waitForIdle:${sid}`);
				assert.equal(sid, sessionId, `${MARKER}: idle wait must remain on the original agent-qa session id`);
			},
			terminateSession: async (sid: string) => { calls.push(`terminate:${sid}`); },
		} as any;

		harness = new VerificationHarness(
			stateDir,
			undefined,
			() => {},
			roleStore,
			undefined,
			sessionManager,
			verifierTeamManager() as any,
			undefined,
			projectContextManager as any,
			undefined,
			{ clock: makeFakeClock() as any },
		) as any;

		const result = await harness.runAgentQaStep(
			{ name: "QA retryable fetch", prompt: "Exercise the app", timeout: 1, role: "qa-tester" },
			stateDir,
			goalId,
			{ branch: "goal/retry-reviewer", commit: "abc123" },
			"signal content",
			{},
			"goal spec",
			new Map(),
			sessionId,
		);

		assert.equal(
			result.passed,
			true,
			`${MARKER}: agent-qa retryable fetch/connection errors must use normal same-session auto-retry/resurrection and complete when the retry produces verification_result; got ${JSON.stringify(result)} calls=${JSON.stringify(calls)} prompts=${prompts.length}`,
		);
		assert.deepEqual(createdIds, [sessionId], `${MARKER}: recovery must preserve the original agent-qa session identity/history and must not spawn a replacement`);
		assert.ok(calls.some(c => c.startsWith("retryLastPrompt:")), `${MARKER}: retryable fetch failure should call sessionManager.retryLastPrompt(auto:true) before any from-scratch retry`);
	});

	it("dead llm-review process gets three same-session resurrection attempts before failing", async () => {
		const goalId = "goal-dead-reviewer-resurrection";
		const stateDir = makeStateDir("verifier-dead-reviewer-");
		const sessionId = "llm-review-dead-same-session";
		const createdIds: string[] = [];
		const calls: string[] = [];

		const fakeSession = {
			id: sessionId,
			status: "terminated",
			lastTurnErrored: false,
			transcriptMarker: "preserved reviewer history",
			rpcClient: {
				onEvent: (_fn: (event: any) => void) => () => {},
				prompt: async () => { calls.push("prompt:kickoff"); },
			},
		};
		const roleStore = { get: () => undefined, getAll: () => [] };
		const { projectContextManager } = makeProjectContext(goalId, roleStore);
		const sessionManager = {
			isSandboxEnabled: false,
			createSession: async (_cwd: string, _args: unknown, _goalId: string, _assistantType: unknown, opts: any) => {
				createdIds.push(opts.sessionId);
				return fakeSession;
			},
			setTitle: () => {},
			updateSessionMeta: () => {},
			getSession: (sid: string) => {
				assert.equal(sid, sessionId, `${MARKER}: resurrection checks must target the original reviewer id`);
				return fakeSession;
			},
			waitForIdle: async () => {
				calls.push("waitForIdle:process-dead");
				throw new Error("Agent process not running");
			},
			waitForStreaming: async () => { calls.push("waitForStreaming"); },
			ensureSessionAlive: async (sid: string) => {
				calls.push(`ensureSessionAlive:${sid}`);
				assert.equal(sid, sessionId, `${MARKER}: dead-process resurrection must preserve session id`);
				assert.equal(fakeSession.transcriptMarker, "preserved reviewer history", `${MARKER}: same-session resurrection must preserve transcript/history metadata`);
				fakeSession.status = "idle";
			},
			restartAgent: async (sid: string) => { calls.push(`restartAgent:${sid}`); },
			terminateSession: async (sid: string) => { calls.push(`terminate:${sid}`); },
		} as any;

		const harness = new VerificationHarness(
			stateDir,
			undefined,
			() => {},
			roleStore as any,
			undefined,
			sessionManager,
			verifierTeamManager() as any,
			undefined,
			projectContextManager as any,
			undefined,
			{ clock: makeFakeClock() as any },
		) as any;

		const result = await harness.runLlmReviewViaSession(
			{ name: "Dead reviewer", prompt: "Review the diff", timeout: 1, role: "reviewer" },
			stateDir,
			goalId,
			{ name: "reviewer", promptTemplate: "You are a code reviewer.", accessory: "magnifier" },
			"combined prompt",
			"kickoff prompt",
			1_000,
			sessionId,
		);

		const resurrectionCalls = calls.filter(c => c === `ensureSessionAlive:${sessionId}` || c === `restartAgent:${sessionId}`);
		assert.equal(
			resurrectionCalls.length,
			3,
			`${MARKER}: a dead llm-review verifier process must be restarted/resurrected exactly 3 times with the same session identity/history before failing. calls=${JSON.stringify(calls)} result=${JSON.stringify(result)}`,
		);
		assert.deepEqual(createdIds, [sessionId], `${MARKER}: dead-process recovery must not create a blank replacement session with the same id`);
		assert.equal(result.passed, false, `${MARKER}: exhausted same-session resurrection should fail the step only after the 3 recovery attempts`);
	});

	it("resurrected llm-review that goes idle without a verdict does not multiply timeout or fake more resurrection attempts", async () => {
		const goalId = "goal-reviewer-resurrection-idle-budget";
		const stateDir = makeStateDir("verifier-reviewer-idle-budget-");
		const sessionId = "llm-review-resurrected-idle-same-session";
		const createdIds: string[] = [];
		const calls: string[] = [];
		const idleWaitTimeouts: number[] = [];
		const streamingWaitTimeouts: number[] = [];
		let idleWaitCount = 0;
		let now = 0;

		const fakeClock = {
			now: () => now,
			setTimeout: (handler: () => void, ms: number) => {
				now += Math.max(0, ms);
				return globalThis.setTimeout(handler, 0);
			},
			setInterval: (handler: () => void, ms: number) => globalThis.setInterval(handler, ms),
			clearTimeout: (handle: any) => globalThis.clearTimeout(handle),
		};
		const fakeSession = {
			id: sessionId,
			status: "terminated",
			lastTurnErrored: false,
			transcriptMarker: "preserved reviewer history",
			rpcClient: {
				onEvent: (_fn: (event: any) => void) => () => {},
				prompt: async () => { calls.push("prompt:resume"); },
				promptWhenReady: async () => { calls.push("promptWhenReady:resume"); },
			},
		};
		const roleStore = { get: () => undefined, getAll: () => [] };
		const { projectContextManager } = makeProjectContext(goalId, roleStore);
		const sessionManager = {
			isSandboxEnabled: false,
			createSession: async (_cwd: string, _args: unknown, _goalId: string, _assistantType: unknown, opts: any) => {
				createdIds.push(opts.sessionId);
				return fakeSession;
			},
			setTitle: () => {},
			updateSessionMeta: () => {},
			getSession: (sid: string) => {
				assert.equal(sid, sessionId, `${MARKER}: idle-after-resurrection checks must target the original reviewer id`);
				return fakeSession;
			},
			waitForIdle: async (_sid: string, timeoutMs: number) => {
				idleWaitCount += 1;
				idleWaitTimeouts.push(timeoutMs);
				calls.push(`waitForIdle:${timeoutMs}`);
				if (idleWaitCount === 1) throw new Error("Agent process not running");
				return;
			},
			waitForStreaming: async (_sid: string, timeoutMs: number) => {
				streamingWaitTimeouts.push(timeoutMs);
				calls.push(`waitForStreaming:${timeoutMs}`);
				now += Math.max(0, timeoutMs);
			},
			ensureSessionAlive: async (sid: string) => {
				calls.push(`ensureSessionAlive:${sid}`);
				assert.equal(fakeSession.transcriptMarker, "preserved reviewer history", `${MARKER}: same-session resurrection must preserve transcript/history metadata`);
				fakeSession.status = "idle";
			},
			restartAgent: async (sid: string) => { calls.push(`restartAgent:${sid}`); },
			terminateSession: async (sid: string) => { calls.push(`terminate:${sid}`); },
		} as any;

		const harness = new VerificationHarness(
			stateDir,
			undefined,
			() => {},
			roleStore as any,
			undefined,
			sessionManager,
			verifierTeamManager() as any,
			undefined,
			projectContextManager as any,
			undefined,
			{ clock: fakeClock as any },
		) as any;

		const result = await harness.runLlmReviewViaSession(
			{ name: "Dead then idle reviewer", prompt: "Review the diff", timeout: 60, role: "reviewer" },
			stateDir,
			goalId,
			{ name: "reviewer", promptTemplate: "You are a code reviewer.", accessory: "magnifier" },
			"combined prompt",
			"kickoff prompt",
			60_000,
			sessionId,
		);

		const resurrectionCalls = calls.filter(c => c === `ensureSessionAlive:${sessionId}` || c === `restartAgent:${sessionId}`);
		assert.equal(
			resurrectionCalls.length,
			1,
			`${MARKER}: once same-session resurrection succeeds and the verifier is alive-but-idle without verification_result, recovery must not issue fake resurrection attempts 2/3. calls=${JSON.stringify(calls)} result=${JSON.stringify(result)}`,
		);
		assert.deepEqual(createdIds, [sessionId], `${MARKER}: idle-after-resurrection recovery must not create a blank replacement session with the same id`);
		assert.deepEqual(streamingWaitTimeouts, [15_000], `${MARKER}: resurrection streaming settle should remain a fixed operational window outside the active-turn allowance`);
		assert.deepEqual(
			idleWaitTimeouts,
			[60_000, 60_000],
			`${MARKER}: a same-session resurrection receives a fresh full active-turn allowance after its fixed streaming settle; prior waits must not decrement it. calls=${JSON.stringify(calls)}`,
		);
		assert.equal(result.passed, false, `${MARKER}: idle-without-result after successful same-session resurrection should fail clearly instead of looping as process death`);
		assert.match(result.output, /idle without verification_result|not issuing duplicate resurrection/i, `${MARKER}: failure diagnostics should explain idle-without-result after resurrection. output=${result.output}`);
	});

	it("alive idle agent-qa gets repeated fair reminders with streaming grace before termination", async () => {
		const goalId = "goal-agent-qa-idle-grace";
		const stateDir = makeStateDir("verifier-agent-qa-idle-");
		const sessionId = "agent-qa-idle-same-session";
		const prompts: string[] = [];
		const calls: string[] = [];

		const fakeSession = {
			id: sessionId,
			status: "idle",
			lastTurnErrored: false,
			rpcClient: {
				onEvent: (_fn: (event: any) => void) => () => {},
				prompt: async (text: string) => {
					prompts.push(text);
					return { success: true };
				},
			},
		};
		const { roleStore, projectContextManager } = makeProjectContext(goalId, qaRoleStore());
		const sessionManager = {
			isSandboxEnabled: false,
			createSession: async (_cwd: string, _args: unknown, _goalId: string, _assistantType: unknown, opts: any) => {
				assert.equal(opts.sessionId, sessionId, `${MARKER}: idle QA reminder flow must preserve the original session id`);
				return fakeSession;
			},
			setTitle: () => {},
			updateSessionMeta: () => {},
			getSession: () => fakeSession,
			waitForIdle: async (sid: string) => { calls.push(`waitForIdle:${sid}`); },
			waitForStreaming: async (sid: string) => { calls.push(`waitForStreaming:${sid}`); },
			terminateSession: async (sid: string) => { calls.push(`terminate:${sid}`); },
		} as any;

		const harness = new VerificationHarness(
			stateDir,
			undefined,
			() => {},
			roleStore,
			undefined,
			sessionManager,
			verifierTeamManager() as any,
			undefined,
			projectContextManager as any,
			undefined,
			{ clock: makeFakeClock() as any },
		) as any;

		const result = await harness.runAgentQaStep(
			{ name: "QA idle reminder", prompt: "Run checks", timeout: 1, role: "qa-tester" },
			stateDir,
			goalId,
			{ branch: "goal/retry-reviewer", commit: "abc123" },
			"signal content",
			{},
			"goal spec",
			new Map(),
			sessionId,
		);

		const reminderPrompts = prompts.slice(1); // prompt[0] is kickoff.
		const streamingGraceCalls = calls.filter(c => c === `waitForStreaming:${sessionId}`);
		assert.ok(
			reminderPrompts.length >= 2,
			`${MARKER}: alive idle agent-qa must get at least two same-session reminders/steers before kill or retry, matching llm-review fairness. prompts=${prompts.length} calls=${JSON.stringify(calls)} result=${JSON.stringify(result)}`,
		);
		assert.ok(
			streamingGraceCalls.length >= 2,
			`${MARKER}: each agent-qa reminder must get streaming grace before idle/termination accounting starts. calls=${JSON.stringify(calls)}`,
		);
		assert.equal(result.passed, false, `${MARKER}: no-result idle QA may fail only after fair reminder/grace exhaustion`);
	});

	it("resurrected agent-qa gets restart-aware QA continuation context, not alive-idle reminder wording", async () => {
		const goalId = "goal-agent-qa-process-death-prompt";
		const stateDir = makeStateDir("verifier-agent-qa-process-death-");
		const sessionId = "agent-qa-dead-continuation-same-session";
		const prompts: string[] = [];
		const calls: string[] = [];
		let harness: any;
		let initialWait = true;

		const fakeSession = {
			id: sessionId,
			status: "terminated",
			lastTurnErrored: false,
			transcriptMarker: "preserved QA history",
			rpcClient: {
				onEvent: (_fn: (event: any) => void) => () => {},
				prompt: async (text: string) => {
					prompts.push(text);
					return { success: true };
				},
				promptWhenReady: async (text: string) => {
					prompts.push(text);
					const resolver = harness.pendingResults.get(sessionId);
					resolver?.({ verdict: true, summary: "Recovered QA continued from preserved context." });
				},
			},
		};
		const { roleStore, projectContextManager } = makeProjectContext(goalId, qaRoleStore());
		const sessionManager = {
			isSandboxEnabled: false,
			createSession: async (_cwd: string, _args: unknown, _goalId: string, _assistantType: unknown, opts: any) => {
				assert.equal(opts.sessionId, sessionId, `${MARKER}: QA process-death recovery must preserve session id`);
				return fakeSession;
			},
			setTitle: () => {},
			updateSessionMeta: () => {},
			getSession: (sid: string) => {
				assert.equal(sid, sessionId, `${MARKER}: QA resurrection must target the original session`);
				return fakeSession;
			},
			waitForIdle: async (sid: string) => {
				calls.push(`waitForIdle:${sid}`);
				if (initialWait) {
					initialWait = false;
					throw new Error("Agent process not running");
				}
			},
			waitForStreaming: async (sid: string) => { calls.push(`waitForStreaming:${sid}`); },
			ensureSessionAlive: async (sid: string) => {
				calls.push(`ensureSessionAlive:${sid}`);
				assert.equal(fakeSession.transcriptMarker, "preserved QA history", `${MARKER}: QA same-session resurrection must preserve transcript/history metadata`);
				fakeSession.status = "idle";
			},
			restartAgent: async (sid: string) => { calls.push(`restartAgent:${sid}`); },
			terminateSession: async (sid: string) => { calls.push(`terminate:${sid}`); },
		} as any;

		harness = new VerificationHarness(
			stateDir,
			undefined,
			() => {},
			roleStore,
			undefined,
			sessionManager,
			verifierTeamManager() as any,
			undefined,
			projectContextManager as any,
			undefined,
			{ clock: makeFakeClock() as any },
		) as any;

		const result = await harness.runAgentQaStep(
			{ name: "QA process death", prompt: "Run the browser smoke plan", timeout: 60, role: "qa-tester", component: "web" },
			stateDir,
			goalId,
			{ branch: "goal/retry-reviewer", commit: "abc123" },
			"signal content",
			{},
			"goal spec",
			new Map(),
			sessionId,
		);

		const recoveryPrompt = prompts[1] || "";
		assert.equal(result.passed, true, `${MARKER}: QA should complete from same-session process-death recovery. result=${JSON.stringify(result)} calls=${JSON.stringify(calls)}`);
		assert.match(recoveryPrompt, /server\/infrastructure|process restarted/i, `${MARKER}: resurrected QA prompt must explain restart/process recovery. prompt=${recoveryPrompt}`);
		assert.match(recoveryPrompt, /continue.*QA|QA.*continue/i, `${MARKER}: resurrected QA prompt must ask the agent to continue QA, not submit an already-formed idle verdict. prompt=${recoveryPrompt}`);
		assert.match(recoveryPrompt, /\[QA-TEST CONTEXT\]\ncomponent: web/, `${MARKER}: resurrected QA prompt must preserve full QA kickoff context. prompt=${recoveryPrompt}`);
		assert.match(recoveryPrompt, /Run the browser smoke plan/, `${MARKER}: resurrected QA prompt must include the original QA test plan. prompt=${recoveryPrompt}`);
		assert.doesNotMatch(recoveryPrompt, /ALREADY FORMED|do not re-investigate|STOP — verification_result not called/i, `${MARKER}: resurrected QA prompt must not use alive-idle reminder wording. prompt=${recoveryPrompt}`);
	});

	it("VERIFIER_BUSY_RACE_REPRO queues a fresh llm-review kickoff when its reviewer is already processing", async () => {
		const goalId = "goal-busy-llm-kickoff";
		const stateDir = makeStateDir("verifier-busy-llm-kickoff-");
		const sessionId = "busy-llm-kickoff-same-session";
		const createdIds: string[] = [];
		const providerAccepted: string[] = [];
		let busyRejections = 0;
		let verdicts = 0;
		let harness: any;
		const fakeSession = {
			id: sessionId,
			status: "idle",
			transcriptMarker: "preserved llm kickoff history",
			lastTurnErrored: false,
			rpcClient: {
				onEvent: (_fn: (event: any) => void) => () => {},
				prompt: async () => {
					busyRejections += 1;
					throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
				},
			},
		};
		const roleStore = { get: () => undefined, getAll: () => [] };
		const { projectContextManager } = makeProjectContext(goalId, roleStore);
		const sessionManager = {
			isSandboxEnabled: false,
			createSession: async (_cwd: string, _args: unknown, _goalId: string, _assistantType: unknown, opts: any) => {
				createdIds.push(opts.sessionId);
				return fakeSession;
			},
			setTitle: () => {}, updateSessionMeta: () => {}, getSession: () => fakeSession,
			// Models SessionManager's durable admission: the first bridge attempt is
			// busy, the same logical row is retained, then accepted exactly once.
			enqueuePrompt: async (sid: string, text: string, opts: any) => {
				assert.equal(sid, sessionId, `${MARKER}: VERIFIER_BUSY_RACE_REPRO must queue the original reviewer session`);
				assert.equal(opts.source, "verification", `${MARKER}: queued verifier prompts retain verification attribution`);
				busyRejections += 1;
				providerAccepted.push(text);
				verdicts += 1;
				harness.pendingResults.get(sessionId)?.({ verdict: true, summary: "Queued kickoff completed from preserved session." });
				return { status: "dispatched" };
			},
			waitForIdle: async () => {}, waitForStreaming: async () => {},
			terminateSession: async () => {},
		} as any;
		harness = new VerificationHarness(stateDir, undefined, () => {}, roleStore as any, undefined, sessionManager, verifierTeamManager() as any, undefined, projectContextManager as any, undefined, { clock: makeFakeClock() as any }) as any;

		const result = await harness.runLlmReviewViaSession(
			{ name: "Busy kickoff", prompt: "Review", timeout: 1, role: "reviewer" }, stateDir, goalId,
			{ name: "reviewer", promptTemplate: "You are a code reviewer." }, "combined", "kickoff", 1_000, sessionId,
		);

		assert.equal(result.passed, true, `${MARKER}: VERIFIER_BUSY_RACE_REPRO fresh kickoff must survive already-processing contention. result=${JSON.stringify(result)}`);
		assert.deepEqual(createdIds, [sessionId], `${MARKER}: VERIFIER_BUSY_RACE_REPRO must not replace the busy reviewer or lose its history`);
		assert.equal(fakeSession.transcriptMarker, "preserved llm kickoff history", `${MARKER}: VERIFIER_BUSY_RACE_REPRO preserves same-session context`);
		assert.equal(busyRejections, 1, `${MARKER}: VERIFIER_BUSY_RACE_REPRO recovers one busy kickoff intent without a duplicate dispatch`);
		assert.equal(providerAccepted.length, 1, `${MARKER}: VERIFIER_BUSY_RACE_REPRO accepts the queued kickoff exactly once`);
		assert.equal(verdicts, 1, `${MARKER}: VERIFIER_BUSY_RACE_REPRO publishes exactly one verdict`);
	});

	it("VERIFIER_BUSY_RACE_REPRO queues an llm-review reminder on the same busy reviewer", async () => {
		const goalId = "goal-busy-llm-reminder";
		const stateDir = makeStateDir("verifier-busy-llm-reminder-");
		const sessionId = "busy-llm-reminder-same-session";
		const createdIds: string[] = [];
		const providerAccepted: string[] = [];
		let busyRejections = 0;
		let verdicts = 0;
		let harness: any;
		let rawPromptCalls = 0;
		const fakeSession = {
			id: sessionId, status: "idle", transcriptMarker: "preserved llm reminder history", lastTurnErrored: false,
			rpcClient: {
				onEvent: (_fn: (event: any) => void) => () => {},
				prompt: async () => {
					rawPromptCalls += 1;
					if (rawPromptCalls === 1) return { success: true }; // kickoff becomes idle without a verdict
					busyRejections += 1;
					throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
				},
			},
		};
		const roleStore = { get: () => undefined, getAll: () => [] };
		const { projectContextManager } = makeProjectContext(goalId, roleStore);
		const sessionManager = {
			isSandboxEnabled: false,
			createSession: async (_cwd: string, _args: unknown, _goalId: string, _assistantType: unknown, opts: any) => { createdIds.push(opts.sessionId); return fakeSession; },
			setTitle: () => {}, updateSessionMeta: () => {}, getSession: () => fakeSession,
			enqueuePrompt: async (sid: string, text: string) => {
				assert.equal(sid, sessionId, `${MARKER}: VERIFIER_BUSY_RACE_REPRO reminder must retain its reviewer identity`);
				providerAccepted.push(text);
				if (providerAccepted.length === 2) {
					busyRejections += 1;
					verdicts += 1;
					harness.pendingResults.get(sessionId)?.({ verdict: true, summary: "Queued reminder completed from preserved session." });
				}
				return { status: "dispatched" };
			},
			// The kickoff ended idle with no result, which is precisely the reminder race window.
			waitForIdle: async () => {}, waitForStreaming: async () => {}, terminateSession: async () => {},
		} as any;
		harness = new VerificationHarness(stateDir, undefined, () => {}, roleStore as any, undefined, sessionManager, verifierTeamManager() as any, undefined, projectContextManager as any, undefined, { clock: makeFakeClock() as any }) as any;

		const result = await harness.runLlmReviewViaSession(
			{ name: "Busy reminder", prompt: "Review", timeout: 1, role: "reviewer" }, stateDir, goalId,
			{ name: "reviewer", promptTemplate: "You are a code reviewer." }, "combined", "kickoff", 1_000, sessionId,
		);

		assert.equal(result.passed, true, `${MARKER}: VERIFIER_BUSY_RACE_REPRO same-session reminder must recover busy contention. result=${JSON.stringify(result)}`);
		assert.deepEqual(createdIds, [sessionId], `${MARKER}: VERIFIER_BUSY_RACE_REPRO reminder must not spawn a replacement reviewer`);
		assert.equal(fakeSession.transcriptMarker, "preserved llm reminder history", `${MARKER}: VERIFIER_BUSY_RACE_REPRO reminder preserves context`);
		assert.equal(busyRejections, 1, `${MARKER}: VERIFIER_BUSY_RACE_REPRO has one recovered busy reminder`);
		assert.equal(providerAccepted.length, 2, `${MARKER}: VERIFIER_BUSY_RACE_REPRO accepts kickoff and reminder exactly once each`);
		assert.equal(verdicts, 1, `${MARKER}: VERIFIER_BUSY_RACE_REPRO reminder publishes one verdict`);
	});

	it("VERIFIER_BUSY_RACE_REPRO does not mistake promptWhenReady liveness for idle during same-session resurrection", async () => {
		const goalId = "goal-busy-llm-resurrection";
		const stateDir = makeStateDir("verifier-busy-llm-resurrection-");
		const sessionId = "busy-llm-resurrection-same-session";
		const createdIds: string[] = [];
		const providerAccepted: string[] = [];
		let readyButBusyCalls = 0;
		let verdicts = 0;
		let idleWaits = 0;
		let harness: any;
		const fakeSession = {
			id: sessionId, status: "terminated", transcriptMarker: "preserved resurrection transcript", lastTurnErrored: false,
			rpcClient: {
				onEvent: (_fn: (event: any) => void) => () => {},
				prompt: async () => ({ success: true }),
				// This mock represents a successful get_state/readiness probe followed
				// by the exact busy prompt rejection. Readiness is not prompt idleness.
				promptWhenReady: async () => {
					readyButBusyCalls += 1;
					throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
				},
			},
		};
		const roleStore = { get: () => undefined, getAll: () => [] };
		const { projectContextManager } = makeProjectContext(goalId, roleStore);
		const sessionManager = {
			isSandboxEnabled: false,
			createSession: async (_cwd: string, _args: unknown, _goalId: string, _assistantType: unknown, opts: any) => { createdIds.push(opts.sessionId); return fakeSession; },
			setTitle: () => {}, updateSessionMeta: () => {}, getSession: () => fakeSession,
			enqueuePrompt: async (sid: string, text: string) => {
				assert.equal(sid, sessionId, `${MARKER}: VERIFIER_BUSY_RACE_REPRO resurrection must retain original reviewer id`);
				providerAccepted.push(text);
				if (providerAccepted.length === 2) {
					readyButBusyCalls += 1;
					verdicts += 1;
					harness.pendingResults.get(sessionId)?.({ verdict: true, summary: "Queued resurrection continuation completed." });
				}
				return { status: "dispatched" };
			},
			waitForIdle: async () => {
				idleWaits += 1;
				if (idleWaits === 1) throw new Error("Agent process not running");
			},
			waitForStreaming: async () => {},
			ensureSessionAlive: async (sid: string) => {
				assert.equal(sid, sessionId, `${MARKER}: VERIFIER_BUSY_RACE_REPRO resurrects the same session`);
				assert.equal(fakeSession.transcriptMarker, "preserved resurrection transcript", `${MARKER}: VERIFIER_BUSY_RACE_REPRO keeps transcript history during resurrection`);
				fakeSession.status = "idle";
			},
			terminateSession: async () => {},
		} as any;
		harness = new VerificationHarness(stateDir, undefined, () => {}, roleStore as any, undefined, sessionManager, verifierTeamManager() as any, undefined, projectContextManager as any, undefined, { clock: makeFakeClock() as any }) as any;

		const result = await harness.runLlmReviewViaSession(
			{ name: "Busy resurrection", prompt: "Review", timeout: 1, role: "reviewer" }, stateDir, goalId,
			{ name: "reviewer", promptTemplate: "You are a code reviewer." }, "combined", "kickoff", 1_000, sessionId,
		);

		assert.equal(result.passed, true, `${MARKER}: VERIFIER_BUSY_RACE_REPRO resurrection must queue after a ready-but-busy reviewer. result=${JSON.stringify(result)}`);
		assert.deepEqual(createdIds, [sessionId], `${MARKER}: VERIFIER_BUSY_RACE_REPRO must not replace a healthy-but-busy resurrected reviewer`);
		assert.equal(readyButBusyCalls, 1, `${MARKER}: VERIFIER_BUSY_RACE_REPRO must recover one ready-but-busy continuation without a second raw prompt`);
		assert.equal(providerAccepted.length, 2, `${MARKER}: VERIFIER_BUSY_RACE_REPRO accepts kickoff and resurrection continuation once each`);
		assert.equal(verdicts, 1, `${MARKER}: VERIFIER_BUSY_RACE_REPRO resurrection publishes one verdict`);
	});

	it("VERIFIER_BUSY_RACE_REPRO queues a fresh agent-qa kickoff and preserves its report artifact", async () => {
		const goalId = "goal-busy-qa-kickoff";
		const stateDir = makeStateDir("verifier-busy-qa-kickoff-");
		const sessionId = "busy-qa-kickoff-same-session";
		const createdIds: string[] = [];
		const providerAccepted: string[] = [];
		let busyRejections = 0;
		let verdicts = 0;
		let harness: any;
		const fakeSession = {
			id: sessionId, status: "idle", transcriptMarker: "preserved QA kickoff history", lastTurnErrored: false,
			rpcClient: {
				onEvent: (_fn: (event: any) => void) => () => {},
				prompt: async () => { throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."); },
			},
		};
		const { roleStore, projectContextManager } = makeProjectContext(goalId, qaRoleStore());
		const sessionManager = {
			isSandboxEnabled: false,
			createSession: async (_cwd: string, _args: unknown, _goalId: string, _assistantType: unknown, opts: any) => { createdIds.push(opts.sessionId); return fakeSession; },
			setTitle: () => {}, updateSessionMeta: () => {}, getSession: () => fakeSession,
			enqueuePrompt: async (sid: string, text: string) => {
				assert.equal(sid, sessionId, `${MARKER}: VERIFIER_BUSY_RACE_REPRO QA kickoff queues original session`);
				busyRejections += 1;
				providerAccepted.push(text);
				verdicts += 1;
				harness.pendingResults.get(sessionId)?.({ verdict: true, summary: "Queued QA kickoff completed.", reportHtml: "<p>queued QA</p>" });
				return { status: "dispatched" };
			},
			waitForIdle: async () => {}, waitForStreaming: async () => {}, terminateSession: async () => {},
		} as any;
		harness = new VerificationHarness(stateDir, undefined, () => {}, roleStore, undefined, sessionManager, verifierTeamManager() as any, undefined, projectContextManager as any, undefined, { clock: makeFakeClock() as any }) as any;

		const result = await harness.runAgentQaStep(
			{ name: "Busy QA kickoff", prompt: "Run checks", timeout: 1, role: "qa-tester" }, stateDir, goalId,
			{ branch: "goal/busy", commit: "abc123" }, "signal", {}, "goal", new Map(), sessionId,
		);

		assert.equal(result.passed, true, `${MARKER}: VERIFIER_BUSY_RACE_REPRO QA kickoff must survive busy contention. result=${JSON.stringify(result)}`);
		assert.deepEqual(createdIds, [sessionId], `${MARKER}: VERIFIER_BUSY_RACE_REPRO QA must not replace its busy reviewer`);
		assert.equal(fakeSession.transcriptMarker, "preserved QA kickoff history", `${MARKER}: VERIFIER_BUSY_RACE_REPRO QA preserves context`);
		assert.equal(busyRejections, 1, `${MARKER}: VERIFIER_BUSY_RACE_REPRO recovers one busy QA kickoff`);
		assert.equal(providerAccepted.length, 1, `${MARKER}: VERIFIER_BUSY_RACE_REPRO QA kickoff is accepted once`);
		assert.equal(verdicts, 1, `${MARKER}: VERIFIER_BUSY_RACE_REPRO QA publishes one verdict`);
		assert.deepEqual(result.artifact, { content: "<p>queued QA</p>", contentType: "text/html" }, `${MARKER}: VERIFIER_BUSY_RACE_REPRO QA preserves report artifact`);
	});

	it("VERIFIER_BUSY_RACE_REPRO queues an agent-qa reminder on the same busy reviewer", async () => {
		const goalId = "goal-busy-qa-reminder";
		const stateDir = makeStateDir("verifier-busy-qa-reminder-");
		const sessionId = "busy-qa-reminder-same-session";
		const createdIds: string[] = [];
		const providerAccepted: string[] = [];
		let busyRejections = 0;
		let verdicts = 0;
		let harness: any;
		let rawPromptCalls = 0;
		const fakeSession = {
			id: sessionId, status: "idle", transcriptMarker: "preserved QA reminder history", lastTurnErrored: false,
			rpcClient: {
				onEvent: (_fn: (event: any) => void) => () => {},
				prompt: async () => {
					rawPromptCalls += 1;
					if (rawPromptCalls === 1) return { success: true }; // kickoff becomes idle without a verdict
					busyRejections += 1;
					throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
				},
			},
		};
		const { roleStore, projectContextManager } = makeProjectContext(goalId, qaRoleStore());
		const sessionManager = {
			isSandboxEnabled: false,
			createSession: async (_cwd: string, _args: unknown, _goalId: string, _assistantType: unknown, opts: any) => { createdIds.push(opts.sessionId); return fakeSession; },
			setTitle: () => {}, updateSessionMeta: () => {}, getSession: () => fakeSession,
			enqueuePrompt: async (sid: string, text: string) => {
				assert.equal(sid, sessionId, `${MARKER}: VERIFIER_BUSY_RACE_REPRO QA reminder must retain session identity`);
				providerAccepted.push(text);
				if (providerAccepted.length === 2) {
					busyRejections += 1;
					verdicts += 1;
					harness.pendingResults.get(sessionId)?.({ verdict: true, summary: "Queued QA reminder completed.", reportHtml: "<p>queued reminder</p>" });
				}
				return { status: "dispatched" };
			},
			waitForIdle: async () => {}, waitForStreaming: async () => {}, terminateSession: async () => {},
		} as any;
		harness = new VerificationHarness(stateDir, undefined, () => {}, roleStore, undefined, sessionManager, verifierTeamManager() as any, undefined, projectContextManager as any, undefined, { clock: makeFakeClock() as any }) as any;

		const result = await harness.runAgentQaStep(
			{ name: "Busy QA reminder", prompt: "Run checks", timeout: 1, role: "qa-tester" }, stateDir, goalId,
			{ branch: "goal/busy", commit: "abc123" }, "signal", {}, "goal", new Map(), sessionId,
		);

		assert.equal(result.passed, true, `${MARKER}: VERIFIER_BUSY_RACE_REPRO QA reminder must survive busy contention. result=${JSON.stringify(result)}`);
		assert.deepEqual(createdIds, [sessionId], `${MARKER}: VERIFIER_BUSY_RACE_REPRO QA reminder must not replace reviewer`);
		assert.equal(fakeSession.transcriptMarker, "preserved QA reminder history", `${MARKER}: VERIFIER_BUSY_RACE_REPRO QA reminder preserves context`);
		assert.equal(busyRejections, 1, `${MARKER}: VERIFIER_BUSY_RACE_REPRO has one recovered busy QA reminder`);
		assert.equal(providerAccepted.length, 2, `${MARKER}: VERIFIER_BUSY_RACE_REPRO accepts QA kickoff and reminder once each`);
		assert.equal(verdicts, 1, `${MARKER}: VERIFIER_BUSY_RACE_REPRO QA reminder publishes one verdict`);
		assert.deepEqual(result.artifact, { content: "<p>queued reminder</p>", contentType: "text/html" }, `${MARKER}: VERIFIER_BUSY_RACE_REPRO QA reminder preserves report artifact`);
	});

	it("VERIFIER_BUSY_RACE_REPRO accepts a failing LLM verdict before its kickoff receipt acknowledgement and ignores a late acknowledgement", async () => {
		const goalId = "goal-verdict-before-ack-llm";
		const stateDir = makeStateDir("verdict-before-ack-llm-");
		const sessionId = "verdict-before-ack-llm-reviewer";
		const acknowledgement = deferred<void>();
		let cancelCount = 0;
		let deliveries = 0;
		let harness: any;
		const session = { id: sessionId, status: "idle", lastTurnErrored: false, rpcClient: { onEvent: () => () => {}, prompt: async () => ({ success: true }) } };
		const { projectContextManager } = makeProjectContext(goalId, { get: () => undefined, getAll: () => [] });
		const sessionManager = {
			isSandboxEnabled: false,
			createSession: async () => session,
			setTitle: () => {}, updateSessionMeta: () => {}, getSession: () => session,
			enqueueVerifierPrompt: () => {
				deliveries += 1;
				harness.pendingResults.get(sessionId)?.({ verdict: false, summary: "FAIL_VERDICT_BEFORE_ACK" });
				return { rowId: "kickoff-row", mode: "queued", dispatched: acknowledgement.promise, cancel: () => { cancelCount += 1; return true; } };
			},
			waitForIdle: async () => {}, waitForStreaming: async () => {}, terminateSession: async () => {},
		} as any;
		harness = new VerificationHarness(stateDir, undefined, () => {}, { get: () => undefined, getAll: () => [] } as any, undefined, sessionManager, verifierTeamManager() as any, undefined, projectContextManager as any, undefined, { clock: makeFakeClock() as any }) as any;

		const result = await harness.runLlmReviewViaSession(
			{ name: "Verdict before ACK", prompt: "Review", timeout: 1, role: "reviewer" }, stateDir, goalId,
			{ name: "reviewer", promptTemplate: "Review faithfully." }, "role context", "kickoff", 1_000, sessionId,
		);
		acknowledgement.resolve();
		await Promise.resolve();
		assert.equal(result.passed, false, `${MARKER}: the first failing verdict must win over a pending kickoff receipt. result=${JSON.stringify(result)}`);
		assert.equal(result.output, "FAIL_VERDICT_BEFORE_ACK");
		assert.equal(deliveries, 1, `${MARKER}: a late RPC acknowledgement must not trigger a retry/redrain`);
		assert.equal(cancelCount, 1, `${MARKER}: verdict-before-ack must cancel the exact queued receipt`);
	});

	it("VERIFIER_BUSY_RACE_REPRO cancels a queued LLM reminder when the prior turn's verdict arrives before reminder acknowledgement", async () => {
		const goalId = "goal-verdict-before-ack-reminder";
		const stateDir = makeStateDir("verdict-before-ack-reminder-");
		const sessionId = "verdict-before-ack-reminder-reviewer";
		const reminderAcknowledgement = deferred<void>();
		let deliveries = 0;
		let reminderCancels = 0;
		let harness: any;
		const session = { id: sessionId, status: "idle", lastTurnErrored: false, rpcClient: { onEvent: () => () => {}, prompt: async () => ({ success: true }) } };
		const { projectContextManager } = makeProjectContext(goalId, { get: () => undefined, getAll: () => [] });
		const sessionManager = {
			isSandboxEnabled: false, createSession: async () => session, setTitle: () => {}, updateSessionMeta: () => {}, getSession: () => session,
			enqueueVerifierPrompt: () => {
				deliveries += 1;
				if (deliveries === 1) return { rowId: "kickoff-row", mode: "direct", dispatched: Promise.resolve(), cancel: () => true };
				harness.pendingResults.get(sessionId)?.({ verdict: true, summary: "PRIOR_TURN_VERDICT_BEFORE_REMINDER_ACK" });
				return { rowId: "reminder-row", mode: "queued", dispatched: reminderAcknowledgement.promise, cancel: () => { reminderCancels += 1; return true; } };
			},
			waitForIdle: async () => {}, waitForStreaming: async () => {}, terminateSession: async () => {},
		} as any;
		harness = new VerificationHarness(stateDir, undefined, () => {}, { get: () => undefined, getAll: () => [] } as any, undefined, sessionManager, verifierTeamManager() as any, undefined, projectContextManager as any, undefined, { clock: makeFakeClock() as any }) as any;

		const result = await harness.runLlmReviewViaSession(
			{ name: "Reminder prior verdict", prompt: "Review", timeout: 1, role: "reviewer" }, stateDir, goalId,
			{ name: "reviewer", promptTemplate: "Review faithfully." }, "role context", "kickoff", 1_000, sessionId,
		);
		reminderAcknowledgement.resolve();
		await Promise.resolve();
		assert.equal(result.passed, true, `${MARKER}: prior turn verdict must prevent a fresh reminder retry. result=${JSON.stringify(result)}`);
		assert.equal(result.output, "PRIOR_TURN_VERDICT_BEFORE_REMINDER_ACK");
		assert.equal(deliveries, 2, `${MARKER}: only kickoff and the cancelled reminder intent may be admitted`);
		assert.equal(reminderCancels, 1, `${MARKER}: the exact queued reminder must be purged before its late acknowledgement`);
	});

	it("VERIFIER_BUSY_RACE_REPRO preserves the QA report artifact when verdict arrives before kickoff acknowledgement", async () => {
		const goalId = "goal-verdict-before-ack-qa";
		const stateDir = makeStateDir("verdict-before-ack-qa-");
		const sessionId = "verdict-before-ack-qa-reviewer";
		const acknowledgement = deferred<void>();
		let cancelCount = 0;
		let harness: any;
		const session = { id: sessionId, status: "idle", lastTurnErrored: false, rpcClient: { onEvent: () => () => {}, prompt: async () => ({ success: true }) } };
		const { roleStore, projectContextManager } = makeProjectContext(goalId, qaRoleStore());
		const sessionManager = {
			isSandboxEnabled: false, createSession: async () => session, setTitle: () => {}, updateSessionMeta: () => {}, getSession: () => session,
			enqueueVerifierPrompt: () => {
				harness.pendingResults.get(sessionId)?.({ verdict: true, summary: "QA_VERDICT_BEFORE_ACK", reportHtml: "<p>QA report survives</p>" });
				return { rowId: "qa-kickoff-row", mode: "queued", dispatched: acknowledgement.promise, cancel: () => { cancelCount += 1; return true; } };
			},
			waitForIdle: async () => {}, waitForStreaming: async () => {}, terminateSession: async () => {},
		} as any;
		harness = new VerificationHarness(stateDir, undefined, () => {}, roleStore, undefined, sessionManager, verifierTeamManager() as any, undefined, projectContextManager as any, undefined, { clock: makeFakeClock() as any }) as any;

		const result = await harness.runAgentQaStep(
			{ name: "QA verdict before ACK", prompt: "Test", timeout: 1, role: "qa-tester" }, stateDir, goalId,
			{ branch: "goal/qa", commit: "abc123" }, "signal", {}, "goal", new Map(), sessionId,
		);
		acknowledgement.resolve();
		await Promise.resolve();
		assert.equal(result.passed, true, `${MARKER}: QA verdict before ACK must be honored. result=${JSON.stringify(result)}`);
		assert.deepEqual(result.artifact, { content: "<p>QA report survives</p>", contentType: "text/html" }, `${MARKER}: QA report artifact must survive verdict-before-ack`);
		assert.equal(cancelCount, 1, `${MARKER}: QA exact queued receipt must be cancelled before late acknowledgement`);
	});

	it("VERIFIER_BUSY_RACE_REPRO honors a failing LLM verdict when its parked receipt rejects", async () => {
		const goalId = "goal-verdict-on-rejected-llm-receipt";
		const stateDir = makeStateDir("verdict-on-rejected-llm-receipt-");
		const sessionId = "rejected-llm-receipt-reviewer";
		const acknowledgement = deferred<void>();
		let cancelCount = 0;
		let deliveries = 0;
		let createdSessions = 0;
		let harness: any;
		const session = { id: sessionId, status: "idle", lastTurnErrored: false, rpcClient: { onEvent: () => () => {}, prompt: async () => ({ success: true }) } };
		const { projectContextManager } = makeProjectContext(goalId, { get: () => undefined, getAll: () => [] });
		const sessionManager = {
			isSandboxEnabled: false, createSession: async () => { createdSessions += 1; return session; }, setTitle: () => {}, updateSessionMeta: () => {}, getSession: () => session,
			enqueueVerifierPrompt: () => {
				deliveries += 1;
				queueMicrotask(() => {
					acknowledgement.reject(new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."));
					queueMicrotask(() => harness.pendingResults.get(sessionId)?.({ verdict: false, summary: "FAIL_VERDICT_AFTER_RECEIPT_REJECTION" }));
				});
				return { rowId: "parked-llm-row", mode: "queued", dispatched: acknowledgement.promise, cancel: () => { cancelCount += 1; return true; } };
			},
			waitForIdle: async () => {}, waitForStreaming: async () => {}, terminateSession: async () => {},
		} as any;
		harness = new VerificationHarness(stateDir, undefined, () => {}, { get: () => undefined, getAll: () => [] } as any, undefined, sessionManager, verifierTeamManager() as any, undefined, projectContextManager as any, undefined, { clock: makeFakeClock() as any }) as any;

		const result = await harness.runLlmReviewViaSession(
			{ name: "Rejected parked LLM receipt", prompt: "Review", timeout: 1, role: "reviewer" }, stateDir, goalId,
			{ name: "reviewer", promptTemplate: "Review faithfully." }, "role context", "kickoff", 1_000, sessionId,
		);
		await Promise.resolve();
		assert.equal(result.passed, false, `${MARKER}: a first FAIL verdict must win over its parked receipt rejection. result=${JSON.stringify(result)}`);
		assert.equal(result.output, "FAIL_VERDICT_AFTER_RECEIPT_REJECTION", `${MARKER}: late busy rejection must not overwrite the attempt-scoped verdict`);
		assert.equal(createdSessions, 1, `${MARKER}: receipt contention must retain one reviewer session`);
		assert.equal(deliveries, 1, `${MARKER}: rejected receipt plus verdict must not retry or redrain`);
		assert.equal(cancelCount, 1, `${MARKER}: the rejected parked receipt must be cancelled exactly once`);
	});

	it("VERIFIER_BUSY_RACE_REPRO preserves QA reportHtml when its parked receipt rejects", async () => {
		const goalId = "goal-verdict-on-rejected-qa-receipt";
		const stateDir = makeStateDir("verdict-on-rejected-qa-receipt-");
		const sessionId = "rejected-qa-receipt-reviewer";
		const acknowledgement = deferred<void>();
		let cancelCount = 0;
		let deliveries = 0;
		let createdSessions = 0;
		let harness: any;
		const session = { id: sessionId, status: "idle", lastTurnErrored: false, rpcClient: { onEvent: () => () => {}, prompt: async () => ({ success: true }) } };
		const { roleStore, projectContextManager } = makeProjectContext(goalId, qaRoleStore());
		const sessionManager = {
			isSandboxEnabled: false, createSession: async () => { createdSessions += 1; return session; }, setTitle: () => {}, updateSessionMeta: () => {}, getSession: () => session,
			enqueueVerifierPrompt: () => {
				deliveries += 1;
				queueMicrotask(() => {
					acknowledgement.reject(new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."));
					queueMicrotask(() => harness.pendingResults.get(sessionId)?.({ verdict: true, summary: "QA_VERDICT_AFTER_RECEIPT_REJECTION", reportHtml: "<p>QA artifact survives receipt rejection</p>" }));
				});
				return { rowId: "parked-qa-row", mode: "queued", dispatched: acknowledgement.promise, cancel: () => { cancelCount += 1; return true; } };
			},
			waitForIdle: async () => {}, waitForStreaming: async () => {}, terminateSession: async () => {},
		} as any;
		harness = new VerificationHarness(stateDir, undefined, () => {}, roleStore, undefined, sessionManager, verifierTeamManager() as any, undefined, projectContextManager as any, undefined, { clock: makeFakeClock() as any }) as any;

		const result = await harness.runAgentQaStep(
			{ name: "Rejected parked QA receipt", prompt: "Test", timeout: 1, role: "qa-tester" }, stateDir, goalId,
			{ branch: "goal/qa", commit: "abc123" }, "signal", {}, "goal", new Map(), sessionId,
		);
		await Promise.resolve();
		assert.equal(result.passed, true, `${MARKER}: QA verdict must win over parked receipt rejection. result=${JSON.stringify(result)}`);
		assert.equal(result.output, "QA_VERDICT_AFTER_RECEIPT_REJECTION");
		assert.deepEqual(result.artifact, { content: "<p>QA artifact survives receipt rejection</p>", contentType: "text/html" }, `${MARKER}: rejected receipt must not lose QA reportHtml`);
		assert.equal(createdSessions, 1, `${MARKER}: QA receipt contention must retain one reviewer session`);
		assert.equal(deliveries, 1, `${MARKER}: QA rejected receipt plus verdict must not retry or redrain`);
		assert.equal(cancelCount, 1, `${MARKER}: QA rejected receipt must be cancelled exactly once`);
	});

	it("VERIFIER_BUSY_RACE_REPRO honors a verdict resolved before receipt result subscription", async () => {
		const stateDir = makeStateDir("pre-resolved-verdict-receipt-");
		const sessionId = "pre-resolved-verdict-reviewer";
		const verdict = Promise.resolve({ verdict: false, summary: "PRE_RESOLVED_VERDICT_WINS" });
		let deliveries = 0;
		let cancelCount = 0;
		const session = { id: sessionId, status: "idle", rpcClient: {} };
		const sessionManager = {
			enqueueVerifierPrompt: (receivedSessionId: string) => {
				deliveries += 1;
				assert.equal(receivedSessionId, sessionId, `${MARKER}: pre-resolved verdict retains the original reviewer session`);
				return { rowId: "pre-resolved-row", mode: "queued", dispatched: Promise.reject(new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.")), cancel: () => { cancelCount += 1; return true; } };
			},
		} as any;
		const harness = new VerificationHarness(stateDir, undefined, () => {}, { get: () => undefined, getAll: () => [] } as any, undefined, sessionManager, verifierTeamManager() as any, undefined, undefined, undefined, { clock: makeFakeClock() as any }) as any;

		const outcome = await harness.dispatchVerifierPrompt(session, "Review", {
			goalId: "goal-pre-resolved-verdict",
			gateId: "gate-pre-resolved-verdict",
			signalId: "signal-pre-resolved-verdict",
			stepName: "Pre-resolved verdict",
			verifierKind: "llm-review",
			promptKind: "kickoff",
			resultPromise: verdict,
		});
		assert.deepEqual(outcome, { type: "result", result: { verdict: false, summary: "PRE_RESOLVED_VERDICT_WINS" } }, `${MARKER}: verdict settled before receipt subscription must still win`);
		assert.equal(deliveries, 1, `${MARKER}: pre-resolved verdict does not re-deliver the prompt`);
		assert.equal(cancelCount, 1, `${MARKER}: rejected receipt is cancelled exactly once after accepting pre-resolved verdict`);
	});

	it("VERIFIER_BUSY_RACE_REPRO gives cold verifier receipts the bridge-ready budget before timing out", async () => {
		const stateDir = makeStateDir("cold-verifier-receipt-budget-");
		const clock = makeManualClock();
		const sessionId = "cold-budget-reviewer";
		const receiptAck = deferred<void>();
		let admissions = 0;
		let cancelCount = 0;
		const sessionManager = {
			enqueueVerifierPrompt: () => {
				admissions += 1;
				return {
					rowId: "cold-budget-row",
					mode: "queued",
					dispatched: receiptAck.promise,
					cancel: () => { cancelCount += 1; return true; },
				};
			},
		} as any;
		const harness = new VerificationHarness(stateDir, undefined, () => {}, { get: () => undefined, getAll: () => [] } as any, undefined, sessionManager, verifierTeamManager() as any, undefined, undefined, undefined, { clock: clock as any }) as any;
		const outcome = harness.dispatchVerifierPrompt({ id: sessionId, status: "idle", rpcClient: {} }, "Review", {
			goalId: "goal-cold-budget", gateId: "gate-cold-budget", signalId: "signal-cold-budget",
			stepName: "Cold receipt", verifierKind: "llm-review", promptKind: "restart-resume", whenReady: true,
		});

		await Promise.resolve();
		assert.equal(VERIFIER_COLD_PROMPT_DISPATCH_TIMEOUT_MS, COLD_REPROMPT_READY_TIMEOUT_MS + COLD_REPROMPT_PROMPT_TIMEOUT_MS + 5_000, `${MARKER}: cold receipt budget derives from both bridge allowances plus scheduling margin`);
		clock.advance(VERIFIER_PROMPT_DISPATCH_TIMEOUT_MS + 1);
		await Promise.resolve();
		assert.equal(cancelCount, 0, `${MARKER}: a cold receipt remains live after the ordinary warm 60s budget`);
		receiptAck.resolve();
		assert.deepEqual(await outcome, { type: "dispatched" }, `${MARKER}: a >60s cold acknowledgement dispatches once without a replacement`);
		assert.equal(admissions, 1, `${MARKER}: cold receipt is admitted exactly once`);
		assert.equal(cancelCount, 0, `${MARKER}: successful cold acknowledgement is not purged`);
	});

	it("VERIFIER_BUSY_RACE_REPRO purges exhausted cold receipts and fences stale delivery", async () => {
		const stateDir = makeStateDir("cold-verifier-receipt-exhaustion-");
		const clock = makeManualClock();
		const sessionId = "cold-budget-expired-reviewer";
		const receiptAck = deferred<void>();
		const staleVerdict = deferred<any>();
		let admissions = 0;
		let cancelCount = 0;
		const sessionManager = {
			enqueueVerifierPrompt: () => {
				admissions += 1;
				return {
					rowId: "cold-expired-row",
					mode: "queued",
					dispatched: receiptAck.promise,
					cancel: () => { cancelCount += 1; return true; },
				};
			},
		} as any;
		const harness = new VerificationHarness(stateDir, undefined, () => {}, { get: () => undefined, getAll: () => [] } as any, undefined, sessionManager, verifierTeamManager() as any, undefined, undefined, undefined, { clock: clock as any }) as any;
		const outcome = harness.dispatchVerifierPrompt({ id: sessionId, status: "idle", rpcClient: {} }, "Review", {
			goalId: "goal-cold-expired", gateId: "gate-cold-expired", signalId: "signal-cold-expired",
			stepName: "Cold exhaustion", verifierKind: "agent-qa", promptKind: "restart-resume", whenReady: true,
			resultPromise: staleVerdict.promise,
		});

		await Promise.resolve();
		clock.advance(VERIFIER_COLD_PROMPT_DISPATCH_TIMEOUT_MS);
		const error = await outcome.then(() => assert.fail("expected cold receipt timeout"), (err: unknown) => err as Error);
		assert.match(error.message, new RegExp(`did not dispatch within ${VERIFIER_COLD_PROMPT_DISPATCH_TIMEOUT_MS}ms`));
		assert.equal(cancelCount, 1, `${MARKER}: exhausted receipt is cancelled so its durable row is purged`);
		assert.equal(admissions, 1, `${MARKER}: timeout does not redeliver the same verifier intent`);
		const wrapped = `Reviewer agent was not ready / timed out while resuming after server restart: ${error.message} Last turn hit a provider backoff error — auto-retry still pending`;
		assert.equal(isTransientVerifierReviewError(wrapped), true, `${MARKER}: cold recovery timeout remains verifier-transient after its backoff diagnostic`);
		assert.equal(isTransientVerifierQaError(wrapped), true, `${MARKER}: cold QA recovery timeout remains verifier-transient after its backoff diagnostic`);

		receiptAck.resolve();
		staleVerdict.resolve({ verdict: false, summary: "STALE_COLD_RECEIPT_VERDICT" });
		await Promise.resolve();
		assert.equal(cancelCount, 1, `${MARKER}: stale acknowledgement/verdict cannot resurrect or double-purge the superseded receipt`);
	});

	it("VERIFIER_BUSY_RACE_REPRO fences cancellation and stale verdicts while a cold receipt is parked", async () => {
		const stateDir = makeStateDir("cold-verifier-receipt-cancel-");
		const clock = makeManualClock();
		const sessionId = "cold-budget-cancelled-reviewer";
		const receiptAck = deferred<void>();
		const staleVerdict = deferred<any>();
		let cancelCount = 0;
		const sessionManager = {
			enqueueVerifierPrompt: () => ({
				rowId: "cold-cancelled-row", mode: "queued", dispatched: receiptAck.promise,
				cancel: () => { cancelCount += 1; return true; },
			}),
		} as any;
		const harness = new VerificationHarness(stateDir, undefined, () => {}, { get: () => undefined, getAll: () => [] } as any, undefined, sessionManager, verifierTeamManager() as any, undefined, undefined, undefined, { clock: clock as any }) as any;
		const signalId = "signal-cold-cancelled";
		const outcome = harness.dispatchVerifierPrompt({ id: sessionId, status: "idle", rpcClient: {} }, "Review", {
			goalId: "goal-cold-cancelled", gateId: "gate-cold-cancelled", signalId,
			stepName: "Cold cancellation", verifierKind: "llm-review", promptKind: "restart-resume", whenReady: true,
			resultPromise: staleVerdict.promise,
		});

		await Promise.resolve();
		(harness.cancelledVerificationSignals as Set<string>).add(signalId);
		for (const notify of harness.verifierDispatchCancellationWaiters.get(signalId) ?? []) notify("test superseded signal");
		assert.deepEqual(await outcome, { type: "cancelled", reason: "test superseded signal" }, `${MARKER}: cancellation wins while a cold receipt waits for bridge readiness`);
		assert.equal(cancelCount, 1, `${MARKER}: cancellation purges the exact parked verifier row`);
		receiptAck.resolve();
		staleVerdict.resolve({ verdict: true, summary: "STALE_CANCELLED_COLD_VERDICT" });
		await Promise.resolve();
		assert.equal(cancelCount, 1, `${MARKER}: stale receipt delivery or verdict cannot publish/revive a cancelled signal`);
	});

	it("agent-qa honors a late verification_result posted during teardown", async () => {
		const goalId = "goal-agent-qa-late-verdict";
		const stateDir = makeStateDir("verifier-agent-qa-late-verdict-");
		const sessionId = "agent-qa-late-verdict-same-session";
		const prompts: string[] = [];
		let harness: any;

		const fakeSession = {
			id: sessionId,
			status: "idle",
			lastTurnErrored: false,
			rpcClient: {
				onEvent: (_fn: (event: any) => void) => () => {},
				prompt: async (text: string) => {
					prompts.push(text);
					return { success: true };
				},
			},
		};
		const { roleStore, projectContextManager } = makeProjectContext(goalId, qaRoleStore());
		const sessionManager = {
			isSandboxEnabled: false,
			createSession: async (_cwd: string, _args: unknown, _goalId: string, _assistantType: unknown, opts: any) => {
				assert.equal(opts.sessionId, sessionId, `${MARKER}: late QA verdict path must preserve session id`);
				return fakeSession;
			},
			setTitle: () => {},
			updateSessionMeta: () => {},
			getSession: () => fakeSession,
			waitForIdle: async () => {},
			waitForStreaming: async () => {},
			terminateSession: async (sid: string) => {
				const resolver = harness.pendingResults.get(sid);
				resolver?.({ verdict: true, summary: "Late QA verdict captured during teardown.", reportHtml: "<p>late</p>" });
			},
		} as any;

		harness = new VerificationHarness(
			stateDir,
			undefined,
			() => {},
			roleStore,
			undefined,
			sessionManager,
			verifierTeamManager() as any,
			undefined,
			projectContextManager as any,
			undefined,
			{ clock: makeFakeClock() as any },
		) as any;

		const result = await harness.runAgentQaStep(
			{ name: "QA late verdict", prompt: "Run checks", timeout: 1, role: "qa-tester" },
			stateDir,
			goalId,
			{ branch: "goal/retry-reviewer", commit: "abc123" },
			"signal content",
			{},
			"goal spec",
			new Map(),
			sessionId,
		);

		assert.ok(prompts.length >= 2, `${MARKER}: QA must exhaust reminder path before teardown late-verdict capture is exercised. prompts=${prompts.length}`);
		assert.equal(result.passed, true, `${MARKER}: late QA verification_result during teardown must be honored, not replaced by did-not-call failure. result=${JSON.stringify(result)}`);
		assert.equal(result.output, "Late QA verdict captured during teardown.");
		assert.deepEqual(result.artifact, { content: "<p>late</p>", contentType: "text/html" });
	});
});
