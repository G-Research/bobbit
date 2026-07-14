// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
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

const { VerificationHarness } = await import("../../src/server/agent/verification-harness.js");

const MARKER = "VERIFIER_LIFECYCLE_REPRO";

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
