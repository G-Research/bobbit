// v2-native — review-agent timeout contract pinning tests.

import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { VerifyStep } from "../../src/server/agent/workflow-store.js";
import {
	initAuthorSidecarDir,
	promptAuthorBindingMatchesText,
	readAuthorSidecar,
} from "../../src/server/agent/author-sidecar.ts";
import {
	DEFAULT_LLM_REVIEW_TIMEOUT_S,
	MIN_LLM_REVIEW_TIMEOUT_S,
	VerificationHarness,
	VERIFICATION_RESTART_RESUME_PROMPT,
	VERIFICATION_RESULT_REMINDER,
	resolveCommandStepTimeoutSec,
	resolveReviewStepTimeoutSec,
} from "../../src/server/agent/verification-harness.js";

const MARKER = "REVIEW_TIMEOUT_CONTRACT";
const HARNESS_SOURCE = fs.readFileSync(path.resolve("src/server/agent/verification-harness.ts"), "utf8");
const tempRoots: string[] = [];

afterAll(() => {
	for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function makeStateDir(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	const stateDir = path.join(root, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	initAuthorSidecarDir(stateDir, {
		secretsDir: path.join(root, "private-secrets"),
		hmacKey: Buffer.alloc(32, 0x35),
	});
	return stateDir;
}

function makeClock() {
	let now = 0;
	const delays: number[] = [];
	return {
		delays,
		now: () => now,
		setTimeout: (handler: () => void, ms: number) => {
			delays.push(ms);
			now += Math.max(0, ms);
			return globalThis.setTimeout(handler, 0);
		},
		setInterval: (handler: () => void, ms: number) => globalThis.setInterval(handler, ms),
		clearTimeout: (handle: any) => globalThis.clearTimeout(handle),
	};
}

function makeReviewHarness(args: {
	goalId?: string;
	session?: any;
	sessionManager?: any;
	clock?: any;
	qaMinutes?: number;
} = {}) {
	const goalId = args.goalId ?? "goal-review-timeout";
	const roleStore = {
		get: (name: string) => ({ name, promptTemplate: "You are a reviewer. Call verification_result.", accessory: "magnifier" }),
		getAll: () => [],
	};
	const ctx = {
		project: { id: "project-review-timeout", name: "Review timeout" },
		goalStore: { get: (id: string) => id === goalId ? { id, title: "Goal", state: "active" } : undefined },
		gateStore: { getGate: () => ({ signals: [] }), getGatesForGoal: () => [] },
		projectConfigStore: {
			get: () => "",
			getWithDefaults: () => ({}),
			getComponents: () => [],
			getQaMaxDurationMinutes: () => args.qaMinutes ?? 10,
		},
	};
	const projectContextManager = {
		getContextForGoal: (id: string) => id === goalId ? ctx : null,
		all: () => [ctx],
	};
	const stateDir = makeStateDir("review-timeout-contract-");
	const harness = new VerificationHarness(
		stateDir,
		undefined,
		() => {},
		roleStore as any,
		undefined,
		args.sessionManager,
		undefined,
		undefined,
		projectContextManager as any,
		undefined,
		{ clock: args.clock },
	) as any;
	return { harness, goalId, roleStore, projectContextManager, stateDir };
}

async function runLlmSession(harness: any, goalId: string, timeoutMs: number, sessionId = "llm-review-timeout-session") {
	return harness.runLlmReviewViaSession(
		{ name: "Review timeout", prompt: "Review the diff", timeout: timeoutMs / 1000, role: "reviewer" },
		process.cwd(),
		goalId,
		{ name: "reviewer", promptTemplate: "You are a reviewer.", accessory: "magnifier" },
		"combined prompt",
		"kickoff prompt",
		timeoutMs,
		sessionId,
	);
}

describe("review timeout resolution", () => {
	it("uses one 1200s review-only default and a one-second minimum", () => {
		assert.equal(DEFAULT_LLM_REVIEW_TIMEOUT_S, 1200, `${MARKER}: review default drifted`);
		assert.equal(MIN_LLM_REVIEW_TIMEOUT_S, 1, `${MARKER}: review minimum drifted`);
		assert.equal(resolveReviewStepTimeoutSec({ type: "llm-review" }), 1200);
		assert.equal(resolveReviewStepTimeoutSec({ type: "agent-qa" }, 10), 1200);
		assert.equal(resolveReviewStepTimeoutSec({ type: "agent-qa" }, 30), 2100);
	});

	it("honors explicit shorter values, floors fractions, and treats malformed values as omitted", () => {
		assert.equal(resolveReviewStepTimeoutSec({ type: "llm-review", timeout: 7 }), 7);
		assert.equal(resolveReviewStepTimeoutSec({ type: "agent-qa", timeout: 45 }, 30), 45);
		assert.equal(resolveReviewStepTimeoutSec({ type: "llm-review", timeout: 7.9 }), 7);
		assert.equal(resolveReviewStepTimeoutSec({ type: "llm-review", timeout: 0.2 }), 1);
		for (const timeout of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.equal(resolveReviewStepTimeoutSec({ type: "llm-review", timeout }), 1200);
			assert.equal(resolveReviewStepTimeoutSec({ type: "agent-qa", timeout }, 30), 2100);
		}
	});

	it("does not change command/build timeout defaults", () => {
		const unit = { name: "unit", type: "command", component: "server", command: "unit" } satisfies VerifyStep;
		const build = { name: "build", type: "command", component: "server", command: "build" } satisfies VerifyStep;
		assert.equal(resolveCommandStepTimeoutSec(unit), 1200);
		assert.equal(resolveCommandStepTimeoutSec(build), 300);
		assert.equal(resolveCommandStepTimeoutSec({ ...unit, timeout: 42 }), 42);
	});
});

describe("active review turn allowances", () => {
	it("gives an active default reviewer 1,200,000ms and reports timeout distinctly from idle", async () => {
		const clock = makeClock();
		const idleTimeouts: number[] = [];
		let prompts = 0;
		const sessionId = "llm-review-default-floor";
		const session = {
			id: sessionId,
			status: "streaming",
			lastTurnErrored: false,
			rpcClient: {
				prompt: async () => { prompts++; },
				onEvent: () => () => {},
				setThinkingLevel: async () => {},
			},
		};
		const sessionManager = {
			isSandboxEnabled: false,
			createSession: async () => session,
			setTitle: () => {},
			updateSessionMeta: () => {},
			getSession: () => session,
			waitForIdle: async (id: string, timeoutMs: number) => {
				idleTimeouts.push(timeoutMs);
				throw new Error(`Timeout waiting for session ${id} to become idle`);
			},
			waitForStreaming: async () => {},
			terminateSession: async () => {},
		};
		const { harness, goalId } = makeReviewHarness({ session, sessionManager, clock });
		const result = await runLlmSession(harness, goalId, 1_200_000, sessionId);

		assert.equal(idleTimeouts[0], 1_200_000, `${MARKER}: default active turn was cut short`);
		assert.equal(prompts, 1, `${MARKER}: a real timeout must not enter the idle reminder path`);
		assert.equal(result.status, "timeout");
		assert.deepEqual(result.timeout, { configuredSeconds: 1200, elapsedMs: 1_200_000 });
		assert.match(result.output, /timed out after 1200s/i);
	});

	it("uses a fresh full explicit window after each reminder, outside fixed settle/late-verdict windows", async () => {
		const clock = makeClock();
		const idleTimeouts: number[] = [];
		const streamingTimeouts: number[] = [];
		let prompts = 0;
		const sessionId = "llm-review-fresh-reminders";
		const session = {
			id: sessionId,
			status: "idle",
			lastTurnErrored: false,
			rpcClient: {
				prompt: async () => { prompts++; },
				onEvent: () => () => {},
				setThinkingLevel: async () => {},
			},
		};
		const sessionManager = {
			isSandboxEnabled: false,
			createSession: async () => session,
			setTitle: () => {},
			updateSessionMeta: () => {},
			getSession: () => session,
			waitForIdle: async (_id: string, timeoutMs: number) => { idleTimeouts.push(timeoutMs); },
			waitForStreaming: async (_id: string, timeoutMs: number) => { streamingTimeouts.push(timeoutMs); },
			terminateSession: async () => {},
		};
		const { harness, goalId } = makeReviewHarness({ session, sessionManager, clock });
		const result = await runLlmSession(harness, goalId, 7_000, sessionId);

		assert.deepEqual(idleTimeouts, [7_000, 7_000, 7_000], `${MARKER}: reminder windows must not decrement`);
		assert.deepEqual(streamingTimeouts, [15_000, 15_000], `${MARKER}: reminder stream settle must remain fixed`);
		assert.equal(clock.delays.filter(ms => ms === 20_000).length, 2, `${MARKER}: late-verdict settle must remain fixed per streamed reminder`);
		assert.equal(prompts, 3, `${MARKER}: kickoff plus two same-session reminders expected`);
		assert.equal(result.status, undefined, `${MARKER}: real idle-without-result must not be marked timeout`);
		assert.match(result.output, /did not call verification_result/i);
	});
});

describe("recovery windows and provider exclusion", () => {
	it("uses fixed 75s/330s retry-start grace and does not fold provider backoff into a short allowance", async () => {
		for (const scenario of [
			{ error: "read ECONNRESET", grace: 75_000 },
			{ error: "529 overloaded_error: provider capacity", grace: 330_000 },
		]) {
			const streamingTimeouts: number[] = [];
			const session = {
				lastTurnErrored: true,
				lastTurnErrorMessage: scenario.error,
				pendingAutoRetryTimer: {},
			};
			const sessionManager = {
				getSession: () => session,
				waitForStreaming: async (_id: string, timeoutMs: number) => {
					streamingTimeouts.push(timeoutMs);
					session.lastTurnErrored = false;
				},
				waitForIdle: async () => {},
			};
			const { harness } = makeReviewHarness({ session, sessionManager });
			const outcome = await harness.waitForReviewerErroredTurnRecovery(
				"reviewer-backoff",
				new Promise(() => {}),
				7_000,
				"Review",
			);
			assert.deepEqual(streamingTimeouts, [scenario.grace], `${MARKER}: retry-start grace is outside the 7s active allowance`);
			assert.equal(outcome.type, "idle");
		}
	});

	it("restart resume uses persisted allowance per turn, preserves 10s settles, and falls back to 1200s", async () => {
		async function exercise(timeoutSec: number | undefined, restartContinuation: boolean) {
			const idleTimeouts: number[] = [];
			const streamingTimeouts: number[] = [];
			const promptTexts: string[] = [];
			const sessionId = restartContinuation ? "reviewer-resume-restart" : "reviewer-resume-legacy";
			const session = {
				id: sessionId,
				status: "streaming",
				restoreStartupWasStreaming: restartContinuation,
				lastTurnErrored: false,
				rpcClient: {
					onEvent: () => () => {},
					promptWhenReady: async (text: string) => {
						promptTexts.push(text);
						return { success: true };
					},
				},
			};
			const sessionManager = {
				getSession: () => session,
				waitForIdle: async (_id: string, ms: number) => { idleTimeouts.push(ms); },
				waitForStreaming: async (_id: string, ms: number) => { streamingTimeouts.push(ms); },
				terminateSession: async () => {},
			};
			const { harness } = makeReviewHarness({ session, sessionManager });
			await harness._tryResumeFromSession(
				{ goalId: "missing-goal", gateId: "gate", signalId: "signal" },
				{
					name: "Review",
					type: "llm-review",
					status: "running",
					startedAt: Date.now(),
					sessionId,
					...(timeoutSec === undefined ? {} : { timeoutSec }),
				},
			);
			return { idleTimeouts, streamingTimeouts, promptTexts, bindings: readAuthorSidecar(sessionId) };
		}

		const explicit = await exercise(7, true);
		assert.deepEqual(explicit.idleTimeouts, [7_000, 7_000, 7_000], `${MARKER}: restart continuation/fallback each need a fresh persisted allowance`);
		assert.deepEqual(explicit.streamingTimeouts, [10_000, 10_000], `${MARKER}: restart stream settles must stay fixed`);
		assert.ok(!explicit.idleTimeouts.includes(180_000) && !explicit.idleTimeouts.includes(120_000));
		assert.deepEqual(explicit.promptTexts, [VERIFICATION_RESTART_RESUME_PROMPT, VERIFICATION_RESULT_REMINDER], `${MARKER}: tracked restart dispatch must preserve exact prompt bytes`);
		assert.ok(explicit.bindings.every(binding => binding.schemaVersion === 2 && binding.modelText === undefined));
		assert.ok(explicit.bindings.every((binding, index) =>
			promptAuthorBindingMatchesText(binding, explicit.promptTexts[index]),
		));
		assert.ok(explicit.bindings.every(binding => binding.source === "verification"));
		for (const binding of explicit.bindings) {
			assert.deepEqual(binding.author, { kind: "system", id: "system:bobbit", label: "Bobbit" });
		}

		const legacy = await exercise(undefined, false);
		assert.deepEqual(legacy.idleTimeouts, [1_200_000, 1_200_000], `${MARKER}: legacy rows without a resolvable step fall back to 1200s per turn`);
		assert.deepEqual(legacy.streamingTimeouts, [10_000]);
		assert.deepEqual(legacy.promptTexts, [VERIFICATION_RESULT_REMINDER], `${MARKER}: legacy resume must preserve exact reminder bytes`);
		assert.ok(legacy.bindings.every(binding => binding.schemaVersion === 2 && binding.modelText === undefined));
		assert.ok(legacy.bindings.every((binding, index) =>
			promptAuthorBindingMatchesText(binding, legacy.promptTexts[index]),
		));
		assert.ok(legacy.bindings.every(binding => binding.source === "verification"));
		for (const binding of legacy.bindings) {
			assert.deepEqual(binding.author, { kind: "system", id: "system:bobbit", label: "Bobbit" });
		}
	});

	it("keeps LLM review routing session-only after direct-path removal", () => {
		const runStep = HARNESS_SOURCE.slice(
			HARNESS_SOURCE.indexOf("private async runLlmReviewStep("),
			HARNESS_SOURCE.indexOf("private async waitForReviewerErroredTurnRecovery("),
		);
		assert.match(runStep, /return this\.runLlmReviewViaSession\(/, `${MARKER}: LLM reviews must route through managed sessions`);
		assert.doesNotMatch(runStep, /runLlmReviewDirect/, `${MARKER}: direct review routing must stay removed`);
		assert.doesNotMatch(HARNESS_SOURCE, /private async runLlmReviewDirect\(/, `${MARKER}: direct review method must stay removed`);
		assert.doesNotMatch(HARNESS_SOURCE, /private async waitForDirectReviewTurn\(/, `${MARKER}: obsolete direct-turn helper must stay removed`);
	});

	it("shared review timeout results carry machine-readable status and timing", () => {
		const { harness } = makeReviewHarness();
		assert.deepEqual(harness.reviewTimeoutResult("LLM review", 7_000, 7_321, "direct-review"), {
			passed: false,
			status: "timeout",
			timeout: { configuredSeconds: 7, elapsedMs: 7_321 },
			output: "LLM review timed out after 7s.",
			sessionId: "direct-review",
		});
	});
});
