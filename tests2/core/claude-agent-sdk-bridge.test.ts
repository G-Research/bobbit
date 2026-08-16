// v2-native — deterministic Agent SDK bridge coverage through its production deps seam.
import { describe, expect, it, vi } from "vitest";

import {
	ClaudeAgentSdkBridge,
	ClaudeAgentSdkUnavailableError,
	buildClaudeAgentSdkEnv,
	normalizeClaudeAgentSdkModelCapabilities,
	resolveClaudeAgentSdkModelCapability,
} from "../../src/server/agent/claude-agent-sdk-bridge.ts";
import { buildClaudeSdkSubagentPolicy, buildClaudeSdkToolSurface } from "../../src/server/agent/claude-agent-sdk-tool-surface.ts";
import { claudeAgentSdkUnavailableDiagnostic } from "../../src/server/agent/claude-agent-sdk-error.ts";
import type { Clock } from "../../src/server/gateway-deps.ts";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

class FakeClock implements Clock {
	private nowMs = 0;
	private nextId = 0;
	private readonly timers = new Map<number, { due: number; handler: () => void }>();
	now(): number { return this.nowMs; }
	setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout> {
		const id = ++this.nextId;
		this.timers.set(id, { due: this.nowMs + ms, handler });
		return id as unknown as ReturnType<typeof setTimeout>;
	}
	setInterval(): ReturnType<typeof setInterval> { throw new Error("FakeClock intervals are not expected"); }
	clearTimeout(handle: ReturnType<typeof setTimeout>): void { this.timers.delete(handle as unknown as number); }
	clearInterval(): void {}
	advance(ms: number): void {
		this.nowMs += ms;
		for (const [id, timer] of [...this.timers]) {
			if (timer.due <= this.nowMs) {
				this.timers.delete(id);
				timer.handler();
			}
		}
	}
	pending(): number { return this.timers.size; }
}


type SdkModel = {
	value: string;
	resolvedModel?: string;
	supportsEffort?: boolean;
	supportedEffortLevels?: string[];
	supportsAdaptiveThinking?: boolean;
};
class FakeQuery implements AsyncIterable<unknown> {
	/** Official SDK controls arrive here; resumable identity arrives on system:init. */
	readonly initialization = deferred<{ models?: SdkModel[] }>();
	readonly events: unknown[] = [];
	readonly waiters: Array<(result: IteratorResult<unknown>) => void> = [];
	readonly inputs: unknown[] = [];
	readonly inputWaiters: Array<(input: unknown) => void> = [];
	readonly setModels: string[] = [];
	readonly thinkingBudgets: Array<number | null> = [];
	readonly flagSettings: Array<Record<string, unknown>> = [];
	readonly thinkingControlCalls: string[] = [];
	supportedModelsData?: SdkModel[];
	setModelError?: Error;
	setThinkingError?: Error;
	interruptCalls = 0;
	closeCalls = 0;
	private closed = false;

	onInput?: (input: unknown) => void;

	constructor(readonly prompt: AsyncIterable<unknown>, readonly options: Record<string, unknown>, autoPullInputs = true) {
		if (autoPullInputs) void this.pullInputs();
	}
	initializationResult(): Promise<{ models?: SdkModel[] }> { return this.initialization.promise; }
	emitSystemInit(sessionId: unknown): void { this.emit({ type: "system", subtype: "init", session_id: sessionId }); }
	async supportedModels(): Promise<SdkModel[] | undefined> { return this.supportedModelsData; }
	async pullInputs(): Promise<void> {
		try {
			for await (const input of this.prompt) {
				this.onInput?.(input);
				const waiter = this.inputWaiters.shift();
				if (waiter) waiter(input);
				else this.inputs.push(input);
			}
		} catch { /* terminal input failure is asserted at the bridge boundary */ }
	}
	nextInput(): Promise<unknown> {
		const input = this.inputs.shift();
		return input === undefined ? new Promise(resolve => this.inputWaiters.push(resolve)) : Promise.resolve(input);
	}
	emit(event: unknown): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter({ done: false, value: event });
		else this.events.push(event);
	}
	async interrupt(): Promise<void> { this.interruptCalls++; }
	async setModel(model: string): Promise<void> {
		if (this.setModelError) throw this.setModelError;
		this.setModels.push(model);
	}
	async setMaxThinkingTokens(budget: number | null): Promise<void> {
		if (this.setThinkingError) throw this.setThinkingError;
		this.thinkingBudgets.push(budget);
		this.thinkingControlCalls.push(`budget:${budget}`);
	}
	async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
		if (this.setThinkingError) throw this.setThinkingError;
		this.flagSettings.push(settings);
		this.thinkingControlCalls.push(`effort:${String(settings.effortLevel)}`);
	}
	async close(): Promise<void> {
		this.closeCalls++;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
	}
	[Symbol.asyncIterator](): AsyncIterator<unknown> {
		return {
			next: () => {
				const event = this.events.shift();
				if (event !== undefined) return Promise.resolve({ done: false, value: event });
				if (this.closed) return Promise.resolve({ done: true, value: undefined });
				return new Promise(resolve => this.waiters.push(resolve));
			},
		};
	}
}

function bridgeFixture(overrides: Record<string, unknown> & { autoPullInputs?: boolean; sessionAccess?: any; models?: SdkModel[]; supportedModels?: SdkModel[] } = {}) {
	const { autoPullInputs = true, sessionAccess, models, supportedModels, ...bridgeOptions } = overrides;
	const clock = new FakeClock();
	let query!: FakeQuery;
	const bridge = new ClaudeAgentSdkBridge({
		runtime: "claude-agent-sdk",
		cwd: "/workspace/project",
		initialModel: "claude-agent-sdk/sonnet-test",
		env: { BOBBIT_TOKEN: "gateway-secret", PROJECT_TOKEN: "must-not-leak" },
		...bridgeOptions,
	}, {
		query: ((input: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
			query = new FakeQuery(input.prompt, input.options, autoPullInputs);
			query.supportedModelsData = supportedModels ?? models;
			return query;
		}) as never,
		clock,
		...(sessionAccess ? { sessionAccess } : {}),
	});
	return { bridge, clock, models, get query() { return query; } };
}

async function flushMicrotasks(count = 6): Promise<void> {
	for (let index = 0; index < count; index++) await Promise.resolve();
}

async function startReady(fixture: ReturnType<typeof bridgeFixture>, sessionId = "00000000-0000-4000-8000-000000000001"): Promise<FakeQuery> {
	await fixture.bridge.start();
	// This is an actual test user turn, not bridge bootstrap traffic. The bridge
	// must remain idle until it is delivered to the SDK AsyncIterable.
	const firstTurn = fixture.bridge.prompt("initialize test conversation");
	await flushMicrotasks();
	fixture.query.initialization.resolve({ models: fixture.models });
	fixture.query.emitSystemInit(sessionId);
	fixture.query.emit({ type: "result", subtype: "success" });
	await firstTurn;
	await fixture.query.nextInput();
	return fixture.query;
}

function subagentSurfaceFixture() {
	const entries = ["read", "find", "grep"].map(name => ({
		name, description: name, group: "Files", inputSchema: { type: "object", properties: {} }, policy: "allow" as const, invoke: async () => "ok",
	}));
	const roles = Object.fromEntries([
		"claude-protocol-scout", "backend-parity-reviewer", "billing-safety-auditor",
	].map(name => [name, { name, promptTemplate: "Bounded helper {{AGENT_ID}}" }]));
	const policy = buildClaudeSdkSubagentPolicy({ sessionId: "root-sdk-session", roles, entries });
	const surface = buildClaudeSdkToolSurface({
		sessionId: "root-sdk-session", restriction: "restricted", entries,
		requestToolGrant: async () => ({ granted: false }), subagentPolicy: policy,
	});
	return { policy, surface };
}

describe("ClaudeAgentSdkBridge", () => {
	const invalidInitializationIdentities: ReadonlyArray<[string, unknown]> = [
		["missing", undefined],
		["malformed", "not-an-sdk-uuid"],
	];

	it("exposes only bounded allowlisted worker failure counts to manual diagnostics", () => {
		const fixture = bridgeFixture({
			claudeSdkToolSurface: {
				getToolFailureCounts: () => ({
					unavailable: 2,
					"invalid-arguments": -4,
					"handler-failed": 1_000_009,
					"handler-error-result": 3,
					privateWorkerText: "/private/path private-token",
				}),
			} as any,
		});
		const facts = fixture.bridge.getToolFailureCounts();
		expect(facts).toEqual({ unavailable: 2, "invalid-arguments": 0, "handler-failed": 1_000_000, "handler-error-result": 3 });
		expect(Object.keys(facts)).toEqual(["unavailable", "invalid-arguments", "handler-failed", "handler-error-result"]);
		expect(JSON.stringify(facts)).not.toContain("private-token");
	});

	it("starts an idle bridge without consuming an input or requiring streamed initialization", async () => {
		const fixture = bridgeFixture({ autoPullInputs: false });
		await expect(fixture.bridge.start()).resolves.toBeUndefined();

		expect((fixture.bridge as any).state).toBe("ready");
		expect(fixture.query.inputs).toEqual([]);
		expect(fixture.query.closeCalls).toBe(0);
		expect(fixture.clock.pending()).toBe(0);
		await expect(fixture.bridge.setModel("claude-agent-sdk", "sonnet-test")).resolves.toMatchObject({
			success: false, error: "Claude Agent SDK controls are unavailable until initialization completes",
		});
		await fixture.bridge.stop();
	});

	it("projects initial thinking into idle query options and acknowledges only its exact pre-init tuple", async () => {
		const off = bridgeFixture({ autoPullInputs: false, initialThinkingLevel: "off" });
		await off.bridge.start();
		expect(off.query.options.thinking).toEqual({ type: "disabled" });
		await expect(off.bridge.setThinkingLevel("off")).resolves.toEqual({ success: true });
		await expect(off.bridge.setThinkingLevel("high")).resolves.toMatchObject({
			success: false, error: "Claude Agent SDK controls are unavailable until initialization completes",
		});
		expect(off.query.thinkingControlCalls).toEqual([]);
		await off.bridge.stop();

		const models: SdkModel[] = [{ value: "opus", supportsAdaptiveThinking: true }];
		const fixedBudget = bridgeFixture({
			autoPullInputs: false,
			initialModel: "claude-agent-sdk/opus",
			initialThinkingLevel: "high",
			models,
		});
		await fixedBudget.bridge.start();
		expect(fixedBudget.query.options.thinking).toEqual({ type: "enabled", budgetTokens: 8_192 });
		await expect(fixedBudget.bridge.setThinkingLevel("high")).resolves.toEqual({ success: true });
		expect(fixedBudget.query.thinkingControlCalls).toEqual([]);

		void fixedBudget.query.pullInputs();
		await startReady(fixedBudget);
		await expect(fixedBudget.bridge.setThinkingLevel("high")).resolves.toEqual({ success: true });
		expect(fixedBudget.query.thinkingControlCalls).toEqual(["effort:null", "budget:8192"]);
		await fixedBudget.bridge.stop();
	});

	it("terminally settles the first input when provider initialization fails", async () => {
		const fixture = bridgeFixture();
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));
		await fixture.bridge.start();
		await expect(fixture.bridge.waitForReady(60_000)).resolves.toBeUndefined();
		const pendingPrompt = fixture.bridge.promptWhenReady("must not be accepted", undefined, { readyTimeoutMs: 70_000 });
		await flushMicrotasks();

		const providerFailure = "subscription unavailable: Authorization: Bearer sk-secret-value abcdefgh.abcdefgh.ijklmnop /Users/aj/.claude/credentials.json opaque_12345678901234567890123456789012";
		fixture.query.initialization.reject(new Error(providerFailure));
		await expect(pendingPrompt).rejects.toMatchObject({
			code: "SDK_SESSION_UNAVAILABLE",
			message: "SDK_SESSION_UNAVAILABLE",
		});
		const failure = await pendingPrompt.catch(error => error);
		const diagnostic = claudeAgentSdkUnavailableDiagnostic(failure);
		for (const secret of ["sk-secret-value", "abcdefgh.abcdefgh.ijklmnop", "/Users/aj/.claude/credentials.json", "opaque_12345678901234567890123456789012"]) {
			expect(diagnostic).not.toContain(secret);
			expect(JSON.stringify(observed)).not.toContain(secret);
		}
		expect(fixture.query.closeCalls).toBe(1);
		expect(fixture.clock.pending()).toBe(0);
		expect(observed.filter(event => event.type === "process_exit")).toEqual([
			expect.objectContaining({ error: "SDK_SESSION_UNAVAILABLE" }),
		]);
	});

	it.each(invalidInitializationIdentities)("fails %s streamed initialization identity once the first real input starts it", async (_kind, sessionId) => {
		const fixture = bridgeFixture();
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));
		await fixture.bridge.start();
		const pendingPrompt = fixture.bridge.promptWhenReady("must not be accepted");
		await flushMicrotasks();
		fixture.query.initialization.resolve({});
		fixture.query.emitSystemInit(sessionId);

		await expect(pendingPrompt).rejects.toMatchObject({
			code: "SDK_SESSION_UNAVAILABLE",
			message: "SDK_SESSION_UNAVAILABLE",
		});
		await expect(fixture.bridge.waitForReady()).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);
		await expect(pendingPrompt).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);
		expect(fixture.query.closeCalls).toBe(1);
		expect(fixture.bridge.running).toBe(false);
		expect((fixture.bridge as any).state).toBe("failed");
		expect((await fixture.bridge.getState()).data.sessionId).toBeUndefined();
		// Input delivery was accepted before the SDK rejected its streamed identity.
		// Preserve that acceptance fence; only transcript-bearing provider frames are
		// suppressed after the failure.
		expect(observed).toEqual([
			{ type: "agent_start" },
			{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "must not be accepted" }] } },
			expect.objectContaining({ type: "process_exit", code: 1, error: "SDK_SESSION_UNAVAILABLE" }),
		]);
		expect(observed.filter(event => event.type === "agent_end"
			|| (event.type.startsWith("message") && event.message?.role !== "user")
			|| event.type.includes("tool"))).toEqual([]);
	});

	it("keeps SDK rate-limit admission updates lifecycle-neutral", async () => {
		const fixture = bridgeFixture();
		const observed: any[] = [];
		const warn = vi.spyOn(console, "warn");
		fixture.bridge.onEvent(event => observed.push(event));
		await fixture.bridge.start();

		fixture.query.emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: "provider-reset", utilization: 0.5 } });
		fixture.query.emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rate_limit_type: "provider-limit" } });
		await flushMicrotasks();

		expect(fixture.bridge.running).toBe(true);
		expect(fixture.query.closeCalls).toBe(0);
		expect(observed).toEqual([]);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
		await fixture.bridge.stop();
	});

	it("fails a rejected SDK rate-limit admission without forwarding provider details", async () => {
		const fixture = bridgeFixture();
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));
		await fixture.bridge.start();
		const activeTurn = fixture.bridge.prompt("active user turn");
		await fixture.query.nextInput();

		fixture.query.emit({
			type: "rate_limit_event",
			rate_limit_info: {
				status: "rejected", resetsAt: "provider-reset", utilization: 0.99, rate_limit_type: "provider-limit",
			},
			uuid: "provider-uuid", body: "provider-body",
		});
		await expect(activeTurn).rejects.toMatchObject({
			code: "SDK_SESSION_UNAVAILABLE",
			message: "SDK_SESSION_UNAVAILABLE",
		});
		const failure = await activeTurn.catch(error => error);
		expect(claudeAgentSdkUnavailableDiagnostic(failure)).toBe("CLAUDE_AGENT_SDK_RATE_LIMITED");
		await flushMicrotasks();

		expect(fixture.query.closeCalls).toBe(1);
		expect(fixture.bridge.running).toBe(false);
		expect((fixture.bridge as any).state).toBe("failed");
		expect(observed.filter(event => event.type === "process_exit")).toEqual([
			{ type: "process_exit", code: 1, error: "SDK_SESSION_UNAVAILABLE" },
		]);
		expect(observed.some(event => event.type === "agent_end")).toBe(false);
		const payload = JSON.stringify(observed);
		for (const providerDetail of ["provider-reset", "provider-limit", "provider-uuid", "provider-body", "0.99"]) {
			expect(payload).not.toContain(providerDetail);
		}
	});

	it("becomes ready with the valid streamed system:init UUID as its only resumable identity", async () => {
		const fixture = bridgeFixture();
		await startReady(fixture);
		expect((await fixture.bridge.getState()).data).toMatchObject({
			provider: "claude-agent-sdk",
			sessionId: "00000000-0000-4000-8000-000000000001",
		});
		expect((fixture.bridge as any).state).toBe("ready");
	});

	it("awaits controls and streamed identity in either official order after the first input", async () => {
		const fixture = bridgeFixture();
		await fixture.bridge.start();
		const identityFirst = fixture.bridge.prompt("first user prompt");
		await fixture.query.nextInput();
		fixture.query.emitSystemInit("00000000-0000-4000-8000-000000000001");
		await flushMicrotasks();
		expect((fixture.bridge as any).state).toBe("running");
		fixture.query.initialization.resolve({});
		await expect(identityFirst).resolves.toBeUndefined();

		const controlsFirst = bridgeFixture();
		await controlsFirst.bridge.start();
		const controlsFirstPrompt = controlsFirst.bridge.prompt("first user prompt");
		await controlsFirst.query.nextInput();
		controlsFirst.query.initialization.resolve({});
		await flushMicrotasks();
		expect((controlsFirst.bridge as any).state).toBe("running");
		controlsFirst.query.emitSystemInit("00000000-0000-4000-8000-000000000002");
		await expect(controlsFirstPrompt).resolves.toBeUndefined();
	});

	it("requires streamed system:init rather than accepting an initializationResult identity", async () => {
		const resultOnly = bridgeFixture();
		await resultOnly.bridge.start();
		const resultOnlyPrompt = resultOnly.bridge.prompt("first user prompt");
		await resultOnly.query.nextInput();
		resultOnly.query.initialization.resolve({ session_id: "00000000-0000-4000-8000-000000000001" } as any);
		resultOnly.clock.advance(90_000);
		await expect(resultOnlyPrompt).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);
	});

	it("accepts the stable system:init repeated before a second SDK turn", async () => {
		const sessionId = "00000000-0000-4000-8000-000000000002";
		const fixture = bridgeFixture();
		const query = await startReady(fixture, sessionId);
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));

		const secondTurn = fixture.bridge.prompt("second user prompt");
		await query.nextInput();
		query.emitSystemInit(sessionId);
		query.emit({ type: "result", subtype: "success" });
		await expect(secondTurn).resolves.toBeUndefined();
		await flushMicrotasks();

		expect((fixture.bridge as any).state).toBe("ready");
		expect((await fixture.bridge.getState()).data.sessionId).toBe(sessionId);
		expect(observed.map(event => event.type)).toEqual(["agent_start", "message_end", "agent_end"]);
		expect(observed[1]).toEqual({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "second user prompt" }] } });
		expect(observed.some(event => event.type === "process_exit")).toBe(false);
	});

	it("opts into pinned SDK partial frames and keeps accepted users before streamed and final assistant content", async () => {
		const sessionId = "00000000-0000-4000-8000-000000000013";
		const fixture = bridgeFixture();
		const query = await startReady(fixture, sessionId);
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));

		expect(query.options.includePartialMessages).toBe(true);
		const streamedTurn = fixture.bridge.prompt("stream this response");
		await query.nextInput();
		query.emit({
			type: "stream_event", uuid: "sdk-assistant-stream",
			event: { type: "message_start", message: { id: "sdk-assistant-message", role: "assistant", content: [] } },
		});
		query.emit({ type: "stream_event", uuid: "sdk-assistant-stream", event: {
			type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
		} });
		query.emit({ type: "stream_event", uuid: "sdk-assistant-stream", event: {
			type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streamed " },
		} });
		query.emit({ type: "stream_event", uuid: "sdk-assistant-stream", event: {
			type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "response" },
		} });
		query.emit({ type: "stream_event", uuid: "sdk-assistant-stream", event: { type: "content_block_stop", index: 0 } });
		query.emit({
			type: "assistant", uuid: "sdk-assistant-stream", message: {
				id: "sdk-assistant-message", content: [{ type: "text", text: "streamed response" }],
			},
		});
		query.emit({ type: "result", subtype: "success", session_id: sessionId });
		await streamedTurn;
		await flushMicrotasks(12);

		expect(observed[0]).toEqual({ type: "agent_start" });
		expect(observed[1]).toEqual({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "stream this response" }] },
		});
		expect(observed.filter(event => event.type === "message_update").map(event => event.assistantMessageEvent.type)).toEqual([
			"start", "text_start", "text_delta", "text_delta", "text_end",
		]);
		const finalized = observed.filter(event => event.type === "message_end" && event.message?.role === "assistant");
		expect(finalized).toHaveLength(1);
		expect(finalized[0].message.content).toEqual([{ type: "text", text: "streamed response" }]);
		expect(observed.map(event => event.type)).toEqual([
			"agent_start", "message_end", "message_update", "message_update", "message_update", "message_update", "message_update", "message_end", "agent_end",
		]);
	});

	it("starts a fresh translator for a second SDK turn while consuming repeated init frames", async () => {
		const sessionId = "00000000-0000-4000-8000-000000000012";
		const fixture = bridgeFixture();
		const observed: any[] = [];
		const warn = vi.spyOn(console, "warn");
		fixture.bridge.onEvent(event => observed.push(event));
		await fixture.bridge.start();

		const first = fixture.bridge.prompt("first user prompt");
		await fixture.query.nextInput();
		fixture.query.initialization.resolve({});
		fixture.query.emitSystemInit(sessionId);
		await first;
		fixture.query.emit({
			type: "assistant", uuid: "first-assistant", message: { content: [{ type: "text", text: "first response" }] },
		});
		fixture.query.emit({
			type: "result", subtype: "success", uuid: "first-result", session_id: sessionId,
			usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
			modelUsage: { "claude-sonnet-test": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 } },
		});
		await flushMicrotasks();

		const second = fixture.bridge.prompt("second user prompt");
		await fixture.query.nextInput();
		fixture.query.emitSystemInit(sessionId);
		fixture.query.emit({
			type: "assistant", uuid: "second-assistant", message: {
				content: [{ type: "tool_use", id: "second-tool", name: "Read", input: { path: "two.txt" } }],
			},
		});
		fixture.query.emit({
			type: "user", message: { content: [{ type: "tool_result", tool_use_id: "second-tool", content: "second result" }] },
		});
		fixture.query.emit({
			type: "result", subtype: "success", uuid: "second-result", session_id: sessionId,
			usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 },
			modelUsage: { "claude-sonnet-test": { inputTokens: 5, outputTokens: 6, cacheReadInputTokens: 7, cacheCreationInputTokens: 8 } },
		});
		await second;
		await flushMicrotasks();
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();

		expect(observed.map(event => event.type)).toEqual([
			"agent_start", "message_end", "message_end", "agent_end",
			"agent_start", "message_end", "message_end", "tool_execution_start", "message_end", "tool_execution_end", "agent_end",
		]);
		expect(observed.filter(event => event.type === "message_end" && event.message?.role === "user").map(event => event.message.content)).toEqual([
			[{ type: "text", text: "first user prompt" }],
			[{ type: "text", text: "second user prompt" }],
		]);
		expect(observed).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "tool_execution_start", toolCallId: "second-tool", toolName: "Read", args: { path: "two.txt" } }),
			expect.objectContaining({ type: "message_end", message: expect.objectContaining({ role: "toolResult", toolCallId: "second-tool", toolName: "Read" }) }),
			expect.objectContaining({ type: "tool_execution_end", toolCallId: "second-tool", toolName: "Read", isError: false }),
			expect.objectContaining({ type: "agent_end", claudeSdkUsage: expect.objectContaining({ sourceResultId: `${sessionId}:first-result` }) }),
			expect.objectContaining({ type: "agent_end", claudeSdkUsage: expect.objectContaining({ sourceResultId: `${sessionId}:second-result` }) }),
		]));
		expect(observed.some(event => event.type === "process_exit")).toBe(false);
	});

	it("fails closed when a repeated SDK init changes or invalidates the established identity", async () => {
		const establishedId = "00000000-0000-4000-8000-000000000002";
		const changedId = "00000000-0000-4000-8000-000000000003";
		for (const repeatedId of [changedId, "provider-controlled-invalid-identity"]) {
			const fixture = bridgeFixture();
			await startReady(fixture, establishedId);
			const observed: any[] = [];
			fixture.bridge.onEvent(event => observed.push(event));

			fixture.query.emitSystemInit(repeatedId);
			await flushMicrotasks();

			expect((fixture.bridge as any).state).toBe("failed");
			expect(fixture.query.closeCalls).toBe(1);
			expect((await fixture.bridge.getState()).data.sessionId).toBe(establishedId);
			expect(observed).toEqual([expect.objectContaining({ type: "process_exit", code: 1, error: "SDK_SESSION_UNAVAILABLE" })]);
			expect(JSON.stringify(observed)).not.toContain(repeatedId);
		}
	});

	it("fails closed when a resumed query does not confirm its persisted identity", async () => {
		const resumeId = "00000000-0000-4000-8000-000000000009";
		const invalidResume = bridgeFixture({ claudeAgentSdkSessionId: "not-an-sdk-uuid" });
		await expect(invalidResume.bridge.start()).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);

		const mismatch = bridgeFixture({ claudeAgentSdkSessionId: resumeId });
		await mismatch.bridge.start();
		const firstPrompt = mismatch.bridge.prompt("resume this actual user prompt");
		await mismatch.query.nextInput();
		mismatch.query.initialization.resolve({});
		mismatch.query.emitSystemInit("00000000-0000-4000-8000-000000000010");
		await expect(firstPrompt).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);
		// The persisted id remains authoritative for a lazy restored bridge even
		// after the mismatched streamed identity has failed the query closed.
		expect((await mismatch.bridge.getState()).data.sessionId).toBe(resumeId);
		expect(mismatch.query.closeCalls).toBe(1);
	});

	it("reads restored SDK history before the lazy resumed query receives input", async () => {
		const resumeId = "00000000-0000-4000-8000-000000000012";
		const calls: Array<[string, string, unknown]> = [];
		const fixture = bridgeFixture({
			claudeAgentSdkSessionId: resumeId,
			sessionAccess: {
				loadSdk: async () => ({
					getSessionInfo: async (id: string, options: unknown) => {
						calls.push(["info", id, options]);
						return { sessionId: id, summary: "restored", lastModified: 1 };
					},
					getSessionMessages: async (id: string, options: unknown) => {
						calls.push(["messages", id, options]);
						return [{
							type: "user", uuid: "restored-user", session_id: id,
							message: { role: "user", content: "persisted SDK history" },
							parent_tool_use_id: null, parent_agent_id: null,
						}];
					},
					forkSession: async () => ({ sessionId: resumeId }),
				}),
			},
		});
		await fixture.bridge.start();

		await expect(fixture.bridge.getMessages()).resolves.toEqual({
			success: true,
			data: [expect.objectContaining({ id: "restored-user", role: "user", content: "persisted SDK history" })],
		});
		expect((await fixture.bridge.getState()).data.sessionId).toBe(resumeId);
		expect(fixture.query.inputs).toEqual([]);
		expect(calls).toEqual([
			["info", resumeId, { dir: "/workspace/project" }],
			["messages", resumeId, { dir: "/workspace/project" }],
		]);
		await fixture.bridge.stop();
	});

	it("keeps a new SDK bridge unavailable for history before its first init", async () => {
		const fixture = bridgeFixture();
		await fixture.bridge.start();

		await expect(fixture.bridge.getMessages()).resolves.toEqual({
			success: false,
			error: "SDK_SESSION_UNAVAILABLE: Claude Agent SDK has no valid resumable session id",
		});
		expect((await fixture.bridge.getState()).data.sessionId).toBeUndefined();
		await fixture.bridge.stop();
	});

	it("retries a first prompt after unpulled delivery times out without yielding bootstrap input", async () => {
		const fixture = bridgeFixture({ autoPullInputs: false });
		await fixture.bridge.start();
		const timedOut = fixture.bridge.prompt("never delivered", undefined, 10);
		await flushMicrotasks();
		fixture.clock.advance(10);
		await expect(timedOut).rejects.toThrow(/delivery timed out/i);

		void fixture.query.pullInputs();
		const retry = fixture.bridge.prompt("the only delivered prompt");
		const delivered = await fixture.query.nextInput() as any;
		expect(delivered.message.content).toBe("the only delivered prompt");
		fixture.query.initialization.resolve({});
		fixture.query.emitSystemInit("00000000-0000-4000-8000-000000000011");
		await expect(retry).resolves.toBeUndefined();
	});

	it("reads visible history through the SDK session API with the initialized UUID and cwd", async () => {
		const sessionId = "00000000-0000-4000-8000-000000000003";
		const calls: Array<[string, string, unknown]> = [];
		const fixture = bridgeFixture({
			sessionAccess: {
				loadSdk: async () => ({
					getSessionInfo: async (id: string, options: unknown) => {
						calls.push(["info", id, options]);
						return { sessionId: id, summary: "ready", lastModified: 1 };
					},
					getSessionMessages: async (id: string, options: unknown) => {
						calls.push(["messages", id, options]);
						return [{
							type: "user",
							uuid: "history-user",
							session_id: id,
							message: { role: "user", content: "from the SDK" },
							parent_tool_use_id: null,
							parent_agent_id: null,
						}];
					},
					forkSession: async () => ({ sessionId }),
				}),
			},
		});
		await startReady(fixture, sessionId);

		await expect(fixture.bridge.getMessages()).resolves.toEqual({
			success: true,
			data: [expect.objectContaining({ id: "history-user", role: "user", content: "from the SDK" })],
		});
		expect(calls).toEqual([
			["info", sessionId, { dir: "/workspace/project" }],
			["messages", sessionId, { dir: "/workspace/project" }],
		]);
	});

	it("delivers prompts and priority steers once in input order only after Query pulls them", async () => {
		const fixture = bridgeFixture();
		const query = await startReady(fixture);
		const first = fixture.bridge.prompt("first", undefined, 50);
		const firstInput = await query.nextInput() as any;
		await expect(first).resolves.toBeUndefined();
		expect(fixture.clock.pending()).toBe(0);
		const steer = fixture.bridge.steer("redirect now");
		const steerInput = await query.nextInput() as any;
		await expect(steer).resolves.toBeUndefined();

		expect(firstInput.message.content).toBe("first");
		expect(firstInput.priority).toBeUndefined();
		expect(steerInput.message.content).toBe("redirect now");
		expect(steerInput.priority).toBe("now");
	});

	it("uses the shared attachment-only text, forwards root events, and ignores unverified child partitions", async () => {
		const fixture = bridgeFixture();
		const query = await startReady(fixture);
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));
		const delivered = fixture.bridge.prompt("  ", [{ type: "image", data: "AA==", mimeType: "image/png" }]);
		const input = await query.nextInput() as any;
		await delivered;
		expect(input.message.content).toContainEqual(expect.objectContaining({ type: "text", text: "Attachments:" }));

		query.emit({ type: "assistant", uuid: "root", message: { content: [{ type: "text", text: "root text" }] } });
		query.emit({ type: "assistant", parent_tool_use_id: "child", uuid: "child", message: { content: [{ type: "text", text: "child text" }] } });
		query.emit({ type: "result", subtype: "success" });
		await flushMicrotasks();
		expect(observed).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "message_end", message: expect.objectContaining({ role: "assistant" }) }),
			expect.objectContaining({ type: "agent_end" }),
		]));
		expect(observed.some(event => event.type === "claude_sdk_subagent_work")).toBe(false);
		expect(observed.some(event => event.type === "message_end" && event.parentToolUseId === "child")).toBe(false);
		expect(observed.filter(event => event.type === "agent_end")).toHaveLength(1);
	});

	it("bridges verified lifecycle and child partitions without leaking child rows into root events", async () => {
		const { policy, surface } = subagentSurfaceFixture();
		const fixture = bridgeFixture({ claudeSdkToolSurface: surface });
		const query = await startReady(fixture);
		// The child runs in the next root turn, whose enqueue boundary resets the
		// terminal translator state left by startReady's first turn.
		const nextTurn = fixture.bridge.prompt("run child work");
		await query.nextInput();
		await nextTurn;
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));
		const child = { agent_id: "child-1", agent_type: "bobbit-backend-parity-reviewer" };
		expect(policy.admit("Agent", {
			subagent_type: child.agent_type, prompt: "Inspect the bounded change", run_in_background: false,
		}, { toolUseId: "agent-use-1", permissionMode: "default" })).toBe(true);
		await (query.options.hooks as any).SubagentStart[0].hooks[0](child);
		query.emit({
			type: "assistant", uuid: "child-message", parent_tool_use_id: "agent-use-1", parent_agent_id: "child-1",
			message: { content: [{ type: "text", text: "child-only evidence" }] },
		});
		await flushMicrotasks();
		await (query.options.hooks as any).SubagentStop[0].hooks[0](child);
		await flushMicrotasks();

		expect(observed.filter(event => event.type === "claude_sdk_subagent_work")).toEqual([
			expect.objectContaining({ type: "claude_sdk_subagent_work", kind: "start", parentToolUseId: "agent-use-1" }),
			expect.objectContaining({ type: "claude_sdk_subagent_work", kind: "message", parentToolUseId: "agent-use-1" }),
			expect.objectContaining({ type: "claude_sdk_subagent_work", kind: "stop", parentToolUseId: "agent-use-1", terminal: { phase: "completed" } }),
		]);
		expect(observed.some(event => event.type === "message_end" && event.parentToolUseId === "agent-use-1")).toBe(false);
		expect(observed.some(event => event.type === "agent_end")).toBe(false);
		await fixture.bridge.stop();
	});

	it("projects verified child tool completion after the root terminal and ignores settled or unrelated frames", async () => {
		const { policy, surface } = subagentSurfaceFixture();
		const fixture = bridgeFixture({ claudeSdkToolSurface: surface });
		const query = await startReady(fixture);
		const nextTurn = fixture.bridge.prompt("run child work");
		await query.nextInput();
		await nextTurn;
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));
		const child = { agent_id: "child-1", agent_type: "bobbit-backend-parity-reviewer" };
		expect(policy.admit("Agent", {
			subagent_type: child.agent_type, prompt: "Inspect the bounded change", run_in_background: false,
		}, { toolUseId: "agent-use-1", permissionMode: "default" })).toBe(true);
		await (query.options.hooks as any).SubagentStart[0].hooks[0](child);

		// The root terminal is final for root traffic, but this active child drains
		// its own partition afterward without producing a second root terminal.
		query.emit({ type: "result", subtype: "success" });
		await flushMicrotasks();
		const beforeUnverified = observed.length;
		query.emit({
			type: "assistant", uuid: "unverified-child", parent_tool_use_id: "agent-use-1", parent_agent_id: "other-child",
			message: { content: [{ type: "text", text: "ignored" }] },
		});
		await flushMicrotasks();
		expect(observed).toHaveLength(beforeUnverified);
		query.emit({
			type: "assistant", uuid: "child-read-call", parent_tool_use_id: "agent-use-1", parent_agent_id: child.agent_id,
			message: { content: [{ type: "tool_use", id: "child-read", name: "Read", input: { path: "fixture.md" } }], stop_reason: "tool_use" },
		});
		query.emit({
			type: "user", uuid: "child-read-result", parent_tool_use_id: "agent-use-1", parent_agent_id: child.agent_id,
			message: { content: [{ type: "tool_result", tool_use_id: "child-read", content: "read result" }] },
		});
		query.emit({ type: "result", parent_tool_use_id: "agent-use-1", parent_agent_id: child.agent_id, subtype: "success" });
		await flushMicrotasks();

		const childFrames = observed.filter(event => event.type === "claude_sdk_subagent_work");
		expect(childFrames).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "tool_start", parentToolUseId: "agent-use-1", toolEvent: expect.objectContaining({ toolCallId: "child-read" }) }),
			expect.objectContaining({ kind: "tool_end", parentToolUseId: "agent-use-1", toolEvent: expect.objectContaining({ toolCallId: "child-read" }) }),
			expect.objectContaining({ kind: "terminal", parentToolUseId: "agent-use-1", terminal: { phase: "completed" } }),
		]));
		expect(observed.filter(event => event.type === "agent_end")).toHaveLength(1);

		query.emit({ type: "system", subtype: "task_notification", tool_use_id: "agent-use-1", status: "completed" });
		await flushMicrotasks();
		expect(policy.active.size).toBe(0);
		const afterSettlement = observed.length;
		query.emit({
			type: "assistant", uuid: "after-settlement", parent_tool_use_id: "agent-use-1", parent_agent_id: child.agent_id,
			message: { content: [{ type: "text", text: "ignored" }] },
		});
		query.emit({
			type: "assistant", uuid: "unrelated-child", parent_tool_use_id: "other-agent-root", parent_agent_id: "other-child",
			message: { content: [{ type: "text", text: "ignored" }] },
		});
		await flushMicrotasks();
		expect(observed).toHaveLength(afterSettlement);
		await fixture.bridge.stop();
	});

	it("accepts the verified native task completion that arrives after its root result", async () => {
		const { policy, surface } = subagentSurfaceFixture();
		const fixture = bridgeFixture({ claudeSdkToolSurface: surface });
		const query = await startReady(fixture);
		const nextTurn = fixture.bridge.prompt("run child work");
		await query.nextInput();
		await nextTurn;
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));
		const child = { agent_id: "child-1", agent_type: "bobbit-backend-parity-reviewer" };
		expect(policy.admit("Agent", {
			subagent_type: child.agent_type, prompt: "Inspect the bounded change", run_in_background: false,
		}, { toolUseId: "agent-use-1", permissionMode: "default" })).toBe(true);
		await (query.options.hooks as any).SubagentStart[0].hooks[0](child);

		query.emit({ type: "result", subtype: "success" });
		await flushMicrotasks();
		expect(policy.active.size).toBe(1);
		query.emit({ type: "system", subtype: "task_notification", tool_use_id: "agent-use-1", status: "completed" });
		await flushMicrotasks();
		expect(policy.active.size).toBe(0);

		expect(observed.filter(event => event.type === "claude_sdk_subagent_work")).toEqual([
			expect.objectContaining({ kind: "start", parentToolUseId: "agent-use-1" }),
			expect.objectContaining({ kind: "terminal", parentToolUseId: "agent-use-1", terminal: { phase: "completed" } }),
		]);
		await (query.options.hooks as any).SubagentStop[0].hooks[0](child);
		expect(policy.active.size).toBe(0);
		await fixture.bridge.stop();
	});

	it("uses a fixed failure detail for provider-controlled child terminal errors", async () => {
		const { policy, surface } = subagentSurfaceFixture();
		const fixture = bridgeFixture({ claudeSdkToolSurface: surface });
		const query = await startReady(fixture);
		const child = { agent_id: "child-1", agent_type: "bobbit-backend-parity-reviewer" };
		expect(policy.admit("Agent", {
			subagent_type: child.agent_type, prompt: "Inspect the bounded change", run_in_background: false,
		}, { toolUseId: "agent-use-1", permissionMode: "default" })).toBe(true);
		await (query.options.hooks as any).SubagentStart[0].hooks[0](child);
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));
		const providerError = "Authorization: Bearer sensitive-bearer-token sk-ant-api03-sensitive-key /home/node/.claude/credentials.json";

		const projected = (fixture.bridge as any).subagentProjectionEvent({
			type: "agent_end",
			parentToolUseId: "agent-use-1",
			claudeSdk: { terminal: { error: providerError } },
		}, { uuid: "child-terminal", parent_agent_id: "child-1", error: providerError, subtype: "error" });
		expect(projected).toMatchObject({
			claudeSdk: { terminal: { terminalReason: "error", error: "Subagent failed" } },
		});

		query.emit({
			type: "result", parent_tool_use_id: "agent-use-1", parent_agent_id: "child-1",
			error: providerError, subtype: "error",
		});
		await flushMicrotasks();

		const frames = observed.filter(event => event.type === "claude_sdk_subagent_work");
		expect(frames).toEqual([expect.objectContaining({
			parentToolUseId: "agent-use-1", kind: "terminal",
			terminal: { phase: "error", error: "Subagent failed" },
		})]);
		const payload = JSON.stringify({ projected, frames });
		for (const sentinel of ["Authorization", "Bearer", "sk-ant", "/home/node/.claude/credentials.json"]) {
			expect(payload).not.toContain(sentinel);
		}
		await fixture.bridge.stop();
	});

	it("terminal cleanup aborts a live verified child once before disposing its observer", async () => {
		const { policy, surface } = subagentSurfaceFixture();
		const fixture = bridgeFixture({ claudeSdkToolSurface: surface });
		const query = await startReady(fixture);
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));
		const child = { agent_id: "child-1", agent_type: "bobbit-backend-parity-reviewer" };
		policy.admit("Agent", { subagent_type: child.agent_type, prompt: "Inspect", run_in_background: false }, { toolUseId: "agent-use-1", permissionMode: "default" });
		await (query.options.hooks as any).SubagentStart[0].hooks[0](child);
		await fixture.bridge.stop();
		await fixture.bridge.stop();

		expect(observed.filter(event => event.type === "claude_sdk_subagent_work").map(event => [event.kind, event.terminal?.phase])).toEqual([
			["start", undefined], ["stop", "aborted"],
		]);
	});

	it("forwards only root-result usage annotations without reconstructing accounting from messages", async () => {
		const fixture = bridgeFixture();
		const query = await startReady(fixture);
		const nextTurn = fixture.bridge.prompt("account this turn");
		await query.nextInput();
		await nextTurn;
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));

		query.emit({
			type: "result", subtype: "success", uuid: "root-result-usage", session_id: "00000000-0000-4000-8000-000000000001",
			total_cost_usd: 0.01,
			usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 },
			modelUsage: { sonnet: {
				inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 1, cacheCreationInputTokens: 0,
				costUSD: 0.01, contextWindow: 200_000, maxOutputTokens: 16_384,
			} },
		});
		await flushMicrotasks();

		expect(observed).toEqual([expect.objectContaining({
			type: "agent_end",
			claudeSdkUsage: expect.objectContaining({ sourceResultId: "00000000-0000-4000-8000-000000000001:root-result-usage" }),
		})]);
	});

	it("does not publish agent_start when the first unpulled input delivery times out", async () => {
		const fixture = bridgeFixture({ autoPullInputs: false });
		await fixture.bridge.start();
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));

		const pending = fixture.bridge.prompt("never pulled", undefined, 10);
		await flushMicrotasks();
		fixture.clock.advance(10);
		await expect(pending).rejects.toThrow(/delivery timed out/i);

		expect((fixture.bridge as any).state).toBe("ready");
		expect(observed).toEqual([]);
	});

	it("does not publish agent_start when stop rejects the first unpulled input", async () => {
		const fixture = bridgeFixture({ autoPullInputs: false });
		await fixture.bridge.start();
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));

		const pending = fixture.bridge.prompt("never pulled");
		await flushMicrotasks();
		await fixture.bridge.stop();
		await expect(pending).rejects.toThrow(/stopped/i);

		expect(observed).toEqual([]);
	});

	it("orders agent_start before a synchronous SDK pull result", async () => {
		const fixture = bridgeFixture();
		const query = await startReady(fixture);
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));
		query.onInput = () => query.emit({ type: "result", subtype: "success" });

		const delivered = fixture.bridge.prompt("complete immediately");
		await query.nextInput();
		await delivered;
		await flushMicrotasks();

		expect((fixture.bridge as any).state).toBe("ready");
		expect(observed.map(event => event.type)).toEqual(["agent_start", "message_end", "agent_end"]);
		expect(observed[1]).toEqual({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "complete immediately" }] },
		});
	});

	it("soft-interrupts without closing, but terminal stop closes once, rejects unsent work, and clears running", async () => {
		const fixture = bridgeFixture();
		const query = await startReady(fixture);
		await fixture.bridge.abort();
		expect(query.interruptCalls).toBe(1);
		const usable = fixture.bridge.prompt("after interrupt");
		await query.nextInput();
		await usable;

		const unsent = fixture.bridge.prompt("never delivered");
		await fixture.bridge.stop();
		await fixture.bridge.stop();
		expect(query.closeCalls).toBe(1);
		await expect(unsent).rejects.toThrow(/stopped|closed|terminated/i);
		expect(fixture.bridge.running).toBe(false);
	});

	it("derives live SDK capability metadata, resolves canonical ids to wire aliases, and routes effort controls", async () => {
		const models: SdkModel[] = [{
			value: "sonnet", resolvedModel: "claude-sonnet-5", supportsEffort: true,
			supportedEffortLevels: ["low", "high", "max"],
		}];
		const fixture = bridgeFixture({ models });
		const query = await startReady(fixture, "00000000-0000-4000-8000-000000000004");
		await expect(fixture.bridge.setModel("claude-agent-sdk", "claude-sonnet-5")).resolves.toMatchObject({ success: true });
		expect(query.setModels).toEqual(["sonnet"]);
		await expect(fixture.bridge.setThinkingLevel("high")).resolves.toMatchObject({ success: true });
		expect(query.flagSettings).toEqual([{ effortLevel: "high" }]);
		await expect(fixture.bridge.setThinkingLevel("off")).resolves.toMatchObject({ success: true });
		expect(query.flagSettings).toEqual([{ effortLevel: "high" }, { effortLevel: null }]);
		expect(query.thinkingBudgets).toEqual([null, null]);
		expect(query.thinkingControlCalls).toEqual(["budget:null", "effort:high", "effort:null", "budget:null"]);
		await expect(fixture.bridge.setThinkingLevel("minimal")).resolves.toMatchObject({ success: false });
		await expect(fixture.bridge.getState()).resolves.toMatchObject({
			data: expect.objectContaining({ model: expect.objectContaining({
				provider: "claude-agent-sdk", id: "claude-sonnet-5", reasoning: true,
				thinkingLevelMap: expect.objectContaining({ off: "off", minimal: null, low: "low", high: "high", max: "max" }),
			}) }),
		});
	});

	it("keeps documented aliases as the public model identity while resolving them to SDK wire values", async () => {
		const models: SdkModel[] = [
			{ value: "sonnet", resolvedModel: "claude-sonnet-5", supportsEffort: true, supportedEffortLevels: ["high"] },
			{ value: "haiku", resolvedModel: "claude-haiku-5" },
		];
		const fixture = bridgeFixture({ initialModel: "claude-agent-sdk/sonnet", models });
		const query = await startReady(fixture);
		await expect(fixture.bridge.getState()).resolves.toMatchObject({
			data: { model: expect.objectContaining({ id: "sonnet", reasoning: true }) },
		});

		await fixture.bridge.setModel("claude-agent-sdk", "claude-sonnet-5");
		await expect(fixture.bridge.getState()).resolves.toMatchObject({
			data: { model: expect.objectContaining({ id: "claude-sonnet-5" }) },
		});
		await fixture.bridge.setModel("claude-agent-sdk", "haiku");
		expect(query.setModels).toEqual(["sonnet", "haiku"]);
		await expect(fixture.bridge.getState()).resolves.toMatchObject({
			data: { model: expect.objectContaining({ id: "haiku", reasoning: false }) },
		});
	});

	it("clears stale controls when switching between SDK effort, fixed-budget, and off thinking", async () => {
		const fixture = bridgeFixture({ models: [{ value: "opus", supportsEffort: true, supportedEffortLevels: ["high"], supportsAdaptiveThinking: true }] });
		const query = await startReady(fixture);
		await fixture.bridge.setModel("claude-agent-sdk", "opus");
		await fixture.bridge.setThinkingLevel("high");
		await fixture.bridge.setThinkingLevel("minimal");
		await fixture.bridge.setThinkingLevel("high");
		await fixture.bridge.setThinkingLevel("off");

		expect(query.thinkingControlCalls).toEqual([
			"budget:null", "effort:high",
			"effort:null", "budget:1024",
			"budget:null", "effort:high",
			"effort:null", "budget:null",
		]);
		expect(query.flagSettings).toEqual([
			{ effortLevel: "high" }, { effortLevel: null }, { effortLevel: "high" }, { effortLevel: null },
		]);
	});

	it("uses fixed token budgets only for adaptive-thinking models and rejects unadvertised models without SDK mutation", async () => {
		const fixture = bridgeFixture({ models: [{ value: "opus", supportsAdaptiveThinking: true }] });
		const query = await startReady(fixture);
		await expect(fixture.bridge.setModel("claude-agent-sdk", "not-advertised")).resolves.toMatchObject({ success: false });
		expect(query.setModels).toEqual([]);
		await expect(fixture.bridge.setModel("claude-agent-sdk", "opus")).resolves.toMatchObject({ success: true });
		await expect(fixture.bridge.setThinkingLevel("high")).resolves.toMatchObject({ success: true });
		await expect(fixture.bridge.setThinkingLevel("off")).resolves.toMatchObject({ success: true });
		expect(query.thinkingBudgets).toEqual([8_192, null]);
	});

	it("does not alter the locally read-back model or thinking tuple after an SDK control failure", async () => {
		const fixture = bridgeFixture({ models: [{ value: "sonnet", supportsEffort: true, supportedEffortLevels: ["high"] }] });
		const query = await startReady(fixture);
		query.setModelError = new Error("model rejected");
		await expect(fixture.bridge.setModel("claude-agent-sdk", "sonnet")).rejects.toThrow("model rejected");
		query.setModelError = undefined;
		await fixture.bridge.setModel("claude-agent-sdk", "sonnet");
		query.setThinkingError = new Error("effort rejected");
		await expect(fixture.bridge.setThinkingLevel("high")).rejects.toThrow("effort rejected");
		await expect(fixture.bridge.getState()).resolves.toMatchObject({
			data: expect.objectContaining({ model: expect.objectContaining({ id: "sonnet" }), thinkingLevel: undefined }),
		});
	});

	it("normalizes only SDK-proven effort levels and matches aliases through the pure resolver", () => {
		const capabilities = normalizeClaudeAgentSdkModelCapabilities([{ value: "sonnet", resolvedModel: "claude-sonnet-5", supportsEffort: true, supportedEffortLevels: ["low", "minimal", "bogus"] }]);
		expect(capabilities).toHaveLength(1);
		expect(resolveClaudeAgentSdkModelCapability(capabilities, "claude-sonnet-5")).toMatchObject({ wireValue: "sonnet", effortLevels: ["low"] });
		expect(resolveClaudeAgentSdkModelCapability(capabilities, "sonnet")).toMatchObject({ id: "claude-sonnet-5" });
		expect(capabilities![0].thinkingLevelMap).toMatchObject({ off: "off", minimal: null, low: "low", medium: null });
	});

	it("clears legacy SDK thinking without flags but rejects advertised effort controls", async () => {
		const fixture = bridgeFixture({ models: [{ value: "sonnet", supportsEffort: true, supportedEffortLevels: ["high"] }] });
		const query = await startReady(fixture);
		await fixture.bridge.setModel("claude-agent-sdk", "sonnet");
		Object.defineProperty(query, "applyFlagSettings", { value: undefined });

		await expect(fixture.bridge.setThinkingLevel("off")).resolves.toMatchObject({ success: true });
		expect(query.thinkingBudgets).toEqual([null]);
		await expect(fixture.bridge.setThinkingLevel("high")).resolves.toMatchObject({
			success: false,
			error: "Claude Agent SDK does not support advertised effort controls",
		});
		expect(query.thinkingBudgets).toEqual([null]);
		await expect(fixture.bridge.getState()).resolves.toMatchObject({
			data: expect.objectContaining({ thinkingLevel: "off" }),
		});
	});

	it("keeps capability-less SDKs conservative while retaining cross-runtime rejection", async () => {
		const fixture = bridgeFixture();
		const query = await startReady(fixture, "00000000-0000-4000-8000-000000000004");
		await expect(fixture.bridge.setModel("claude-agent-sdk", "opus-test")).resolves.toMatchObject({ success: true });
		expect(query.setModels).toEqual(["opus-test"]);
		await expect(fixture.bridge.setModel("anthropic", "sonnet")).resolves.toMatchObject({ success: false });
		await expect(fixture.bridge.setThinkingLevel("off")).resolves.toMatchObject({ success: true });
		await expect(fixture.bridge.setThinkingLevel("high")).resolves.toMatchObject({ success: false });
		await expect(fixture.bridge.compact()).resolves.toMatchObject({ success: false });
		await expect(fixture.bridge.sendCommand()).resolves.toMatchObject({ success: false });
		await expect(fixture.bridge.getMessages()).resolves.toMatchObject({ success: false });
	});

	it("adapts SDK PreCompact through the existing beforeCompact callback without fabricating manual compact events", async () => {
		const calls: unknown[] = [];
		const fixture = bridgeFixture({ onBeforeCompact: async (input: unknown) => { calls.push(input); } });
		const query = await startReady(fixture);
		const preCompact = (query.options.hooks as any).PreCompact;
		expect(preCompact).toHaveLength(1);
		await preCompact[0].hooks[0]({ trigger: "auto" });
		expect(calls).toEqual([{ source: "claude-agent-sdk", trigger: "auto" }]);
		await expect(fixture.bridge.compact()).resolves.toMatchObject({ success: false });
	});

	it("resets translation at each root turn boundary, including a post-abort turn", async () => {
		const fixture = bridgeFixture();
		const query = await startReady(fixture);
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));

		const first = fixture.bridge.prompt("one");
		await query.nextInput();
		await first;
		query.emit({ type: "assistant", uuid: "first", message: { content: [{ type: "text", text: "one" }] } });
		query.emit({ type: "result", subtype: "success" });
		await flushMicrotasks();

		await fixture.bridge.abort();
		const second = fixture.bridge.prompt("two");
		await query.nextInput();
		await second;
		query.emit({ type: "assistant", uuid: "second", message: { content: [{ type: "text", text: "two" }] } });
		query.emit({ type: "result", subtype: "success" });
		await flushMicrotasks();

		expect(query.interruptCalls).toBe(1);
		expect(observed.filter(event => event.type === "agent_end")).toHaveLength(2);
		// Each fresh root boundary must retain its canonical accepted-user echo
		// and independently translated assistant terminal after the abort reset.
		expect(observed.filter(event => event.type === "message_end" && event.message?.role === "user")
			.map(event => event.message.content[0]?.text)).toEqual(["one", "two"]);
		expect(observed.filter(event => event.type === "message_end" && event.message?.role === "assistant")
			.map(event => event.message.content[0]?.text)).toEqual(["one", "two"]);
		expect(fixture.bridge.running).toBe(true);
	});

	it("bounds first-input initialization and terminally cleans its single query", async () => {
		const fixture = bridgeFixture();
		await fixture.bridge.start();
		const firstPrompt = fixture.bridge.prompt("first user prompt");
		await fixture.query.nextInput();
		await flushMicrotasks();
		fixture.clock.advance(90_000);
		await expect(firstPrompt).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);
		expect(fixture.query.closeCalls).toBe(1);
		expect(fixture.clock.pending()).toBe(0);
		await expect(fixture.bridge.prompt("after timeout", undefined, 10)).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);
	});

	it("fails sandboxed SDK sessions before invoking the host-local SDK query", async () => {
		const clock = new FakeClock();
		let queryCalls = 0;
		const bridge = new ClaudeAgentSdkBridge({ runtime: "claude-agent-sdk", sandboxed: true }, {
			query: (() => { queryCalls++; throw new Error("must not run"); }) as never,
			clock,
		});
		await expect(bridge.start()).rejects.toMatchObject({ code: "SDK_SESSION_UNAVAILABLE", message: "SDK_SESSION_UNAVAILABLE" });
		expect(queryCalls).toBe(0);
	});

	it("fails missing direct OAuth launch authority before spawning a query", async () => {
		const clock = new FakeClock();
		let queryCalls = 0;
		const bridge = new ClaudeAgentSdkBridge({
			runtime: "claude-agent-sdk",
			env: { BOBBIT_SESSION_ID: "00000000-0000-4000-8000-000000000001" },
		}, {
			query: (() => { queryCalls++; throw new Error("must not run"); }) as never,
			clock,
		});
		await expect(bridge.start()).rejects.toMatchObject({ code: "SDK_SESSION_UNAVAILABLE", message: "SDK_SESSION_UNAVAILABLE" });
		expect(queryCalls).toBe(0);
	});

	it("disposes an eagerly allocated tool surface when validation fails before surface attachment", async () => {
		const { surface } = subagentSurfaceFixture();
		let disposeCalls = 0;
		const trackedSurface = { ...surface, dispose: () => { disposeCalls++; surface.dispose?.(); } };
		const fixture = bridgeFixture({ claudeSdkToolSurface: trackedSurface, args: ["--extension", "unsupported"] });

		await expect(fixture.bridge.start()).rejects.toMatchObject({
			code: "SDK_SESSION_UNAVAILABLE",
			message: "SDK_SESSION_UNAVAILABLE",
		});
		expect(disposeCalls).toBe(1);
	});

	it("disposes an eagerly allocated tool surface exactly once when stopped before start", async () => {
		const { surface } = subagentSurfaceFixture();
		let disposeCalls = 0;
		const trackedSurface = { ...surface, dispose: () => { disposeCalls++; surface.dispose?.(); } };
		const fixture = bridgeFixture({ claudeSdkToolSurface: trackedSurface });

		await fixture.bridge.stop();
		await fixture.bridge.stop();
		expect(disposeCalls).toBe(1);
	});

	it("uses the strict isolated direct-bridge SDK surface", async () => {
		const fixture = bridgeFixture();
		const query = await startReady(fixture);
		expect(query.options).toMatchObject({
			settingSources: [],
			strictMcpConfig: true,
			tools: ["Skill", "Agent"],
			allowedTools: ["Agent"],
			agents: {},
			skills: [
				"batch", "claude-api", "code-review", "dataviz", "debug", "deep-research", "design-sync",
				"doctor", "fewer-permission-prompts", "loop", "run", "run-skill-generator", "simplify", "update-config", "verify",
			],
			managedSettings: { autoMemoryEnabled: false },
			forwardSubagentText: true,
			permissionMode: "default",
			mcpServers: { bobbit: expect.any(Object) },
		});
		expect(query.options.disallowedTools).toEqual(expect.arrayContaining([
			"Bash", "Read", "ToolSearch", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate",
		]));
		// Task is private alias transport rather than a registered/allowed SDK
		// tool; PreToolUse and canUseTool deny it explicitly.
		expect(query.options.disallowedTools).not.toContain("Task");
		expect(query.options.disallowedTools).not.toContain("Agent");
		expect(query.options.canUseTool).toEqual(expect.any(Function));
		await expect((query.options.canUseTool as any)("Agent", {
			subagent_type: "bobbit-backend-parity-reviewer", prompt: "must be denied without a policy", run_in_background: false,
		}, { signal: new AbortController().signal, toolUseID: "agent-use-without-policy" })).resolves.toMatchObject({ behavior: "deny" });
		expect((query.options.hooks as any).PreToolUse).toHaveLength(1);
	});

	it("settles the first input on stop and never lets abort resurrect failed or stopped queries", async () => {
		const fixture = bridgeFixture();
		await fixture.bridge.start();
		const pendingPrompt = fixture.bridge.promptWhenReady("waiting");
		await fixture.bridge.stop();
		await expect(pendingPrompt).rejects.toThrow(/stopped/i);
		expect(fixture.query.closeCalls).toBe(1);
		await expect(fixture.bridge.abort()).resolves.toMatchObject({ success: false });
		expect(fixture.bridge.running).toBe(false);

		const failed = bridgeFixture();
		await failed.bridge.start();
		const failedPrompt = failed.bridge.prompt("first user prompt");
		await failed.query.nextInput();
		failed.query.initialization.reject(new Error("provider unavailable"));
		await expect(failedPrompt).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);
		await expect(failed.bridge.abort()).resolves.toMatchObject({ success: false });
		expect(failed.bridge.running).toBe(false);
	});

	it("normalizes lazy query-loader failure per SDK session without needing readiness observers", async () => {
		const clock = new FakeClock();
		let calls = 0;
		const bridge = new ClaudeAgentSdkBridge({ runtime: "claude-agent-sdk" }, {
			query: (async () => { calls++; throw new Error("SDK loader missing TOKEN=secret"); }) as never,
			clock,
		});
		await expect(bridge.start()).rejects.toMatchObject({ code: "SDK_SESSION_UNAVAILABLE", message: "SDK_SESSION_UNAVAILABLE" });
		expect(calls).toBe(1);
		await expect(bridge.waitForReady()).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);
	});

	it("builds isolated minimal SDK environments without gateway, project, or provider secrets", () => {
		const base = {
			env: {
				HOME: "/home/test", PATH: "/usr/bin", LANG: "C", BOBBIT_SESSION_ID: "session-a",
				BOBBIT_SESSION_SECRET: "session-secret", BOBBIT_TOKEN: "gateway-secret", PROJECT_KEY: "project-secret",
				AWS_ACCESS_KEY_ID: "cloud-secret", NODE_OPTIONS: "--require evil",
			},
		};
		const first = buildClaudeAgentSdkEnv(base);
		const second = buildClaudeAgentSdkEnv({ ...base, env: { ...base.env, BOBBIT_SESSION_ID: "session-b" } });
		expect(first).toMatchObject({ BOBBIT_SESSION_ID: "session-a", BOBBIT_SESSION_SECRET: "session-secret", CLAUDE_AGENT_SDK_CLIENT_APP: "bobbit" });
		expect(first).not.toHaveProperty("BOBBIT_TOKEN");
		expect(first).not.toHaveProperty("PROJECT_KEY");
		expect(first).not.toHaveProperty("AWS_ACCESS_KEY_ID");
		expect(first).not.toHaveProperty("NODE_OPTIONS");
		expect(second).not.toBe(first);
		expect(second.BOBBIT_SESSION_ID).toBe("session-b");
	});
});
