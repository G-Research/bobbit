// v2-native — deterministic Agent SDK bridge coverage through its production deps seam.
import { describe, expect, it } from "vitest";

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
	const started = fixture.bridge.start();
	await Promise.resolve();
	fixture.query.initialization.resolve({ models: fixture.models });
	fixture.query.emitSystemInit(sessionId);
	await started;
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

	it("keeps a viable cold bridge running after a steer-specific readiness deadline", async () => {
		const fixture = bridgeFixture();
		const started = fixture.bridge.start();
		await flushMicrotasks();

		const steer = fixture.bridge.steer("redirect while cold");
		fixture.clock.advance(29_999);
		await flushMicrotasks();
		expect((fixture.bridge as any).state).toBe("starting");
		expect(fixture.query.closeCalls).toBe(0);
		expect(fixture.clock.pending()).toBe(2);

		fixture.clock.advance(1);
		await expect(steer).rejects.toMatchObject({ code: "SDK_SESSION_UNAVAILABLE", message: "SDK_SESSION_UNAVAILABLE" });
		expect((fixture.bridge as any).state).toBe("starting");
		expect(fixture.query.closeCalls).toBe(0);
		expect(fixture.clock.pending()).toBe(1);

		fixture.query.initialization.resolve({});
		fixture.query.emitSystemInit("00000000-0000-4000-8000-000000000001");
		await started;
		await expect(fixture.bridge.waitForReady(1)).resolves.toBeUndefined();
		expect((fixture.bridge as any).state).toBe("ready");
		expect(fixture.clock.pending()).toBe(0);
	});

	it("terminally settles every readiness waiter when provider initialization fails", async () => {
		const fixture = bridgeFixture();
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));
		const started = fixture.bridge.start();
		await flushMicrotasks();
		const directWaiter = fixture.bridge.waitForReady(60_000);
		const pendingPrompt = fixture.bridge.promptWhenReady("must not be accepted", undefined, { readyTimeoutMs: 70_000 });

		const providerFailure = "subscription unavailable: Authorization: Bearer sk-secret-value abcdefgh.abcdefgh.ijklmnop /Users/aj/.claude/credentials.json opaque_12345678901234567890123456789012";
		fixture.query.initialization.reject(new Error(providerFailure));
		for (const pending of [started, directWaiter, pendingPrompt]) {
			await expect(pending).rejects.toMatchObject({
				code: "SDK_SESSION_UNAVAILABLE",
				message: "SDK_SESSION_UNAVAILABLE",
			});
		}
		const failure = await started.catch(error => error);
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

	it.each(invalidInitializationIdentities)("fails %s streamed initialization identity once before becoming ready", async (_kind, sessionId) => {
		const fixture = bridgeFixture();
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));
		const started = fixture.bridge.start();
		const pendingPrompt = fixture.bridge.promptWhenReady("must not be accepted");
		await flushMicrotasks();
		fixture.query.initialization.resolve({});
		fixture.query.emitSystemInit(sessionId);

		await expect(started).rejects.toMatchObject({
			code: "SDK_SESSION_UNAVAILABLE",
			message: "SDK_SESSION_UNAVAILABLE",
		});
		await expect(fixture.bridge.waitForReady()).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);
		await expect(pendingPrompt).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);
		expect(fixture.query.closeCalls).toBe(1);
		expect(fixture.bridge.running).toBe(false);
		expect((fixture.bridge as any).state).toBe("failed");
		expect((await fixture.bridge.getState()).data.sessionId).toBeUndefined();
		expect(observed.filter(event => event.type === "process_exit")).toHaveLength(1);
		// Once init fails, no provider event may enter the canonical transcript.
		expect(observed.filter(event => event.type !== "process_exit")).toEqual([]);
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

	it("awaits controls and streamed identity in either official startup order", async () => {
		const fixture = bridgeFixture();
		const started = fixture.bridge.start();
		await flushMicrotasks();
		fixture.query.emitSystemInit("00000000-0000-4000-8000-000000000001");
		await flushMicrotasks();
		expect((fixture.bridge as any).state).toBe("starting");
		fixture.query.initialization.resolve({});
		await expect(started).resolves.toBeUndefined();

		const controlsFirst = bridgeFixture();
		const controlsFirstStart = controlsFirst.bridge.start();
		await flushMicrotasks();
		controlsFirst.query.initialization.resolve({});
		await flushMicrotasks();
		expect((controlsFirst.bridge as any).state).toBe("starting");
		controlsFirst.query.emitSystemInit("00000000-0000-4000-8000-000000000002");
		await expect(controlsFirstStart).resolves.toBeUndefined();
	});

	it("rejects initializationResult identity, duplicate init, and missing streamed init", async () => {
		const resultOnly = bridgeFixture();
		const resultOnlyStart = resultOnly.bridge.start();
		await flushMicrotasks();
		resultOnly.query.initialization.resolve({ session_id: "00000000-0000-4000-8000-000000000001" } as any);
		resultOnly.clock.advance(90_000);
		await expect(resultOnlyStart).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);

		const duplicate = bridgeFixture();
		await startReady(duplicate);
		duplicate.query.emitSystemInit("00000000-0000-4000-8000-000000000002");
		await flushMicrotasks();
		expect((duplicate.bridge as any).state).toBe("failed");
		expect(duplicate.query.closeCalls).toBe(1);
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

	it("uses the shared attachment-only text, forwards translated events, and ignores no translator state", async () => {
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
			expect.objectContaining({ type: "claude_sdk_subagent_work", parentToolUseId: "child", kind: "message" }),
			expect.objectContaining({ type: "agent_end" }),
		]));
		expect(observed.some(event => event.type === "message_end" && event.parentToolUseId === "child")).toBe(false);
		expect(observed.filter(event => event.type === "agent_end")).toHaveLength(1);
	});

	it("bridges verified lifecycle and child partitions without leaking child rows into root events", async () => {
		const { policy, surface } = subagentSurfaceFixture();
		const fixture = bridgeFixture({ claudeSdkToolSurface: surface });
		const query = await startReady(fixture);
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

	it("uses a fixed failure detail for provider-controlled child terminal errors", async () => {
		const fixture = bridgeFixture();
		const query = await startReady(fixture);
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

	it("does not publish agent_start when an unpulled input delivery times out", async () => {
		const fixture = bridgeFixture({ autoPullInputs: false });
		await startReady(fixture);
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));

		const pending = fixture.bridge.prompt("never pulled", undefined, 10);
		await flushMicrotasks();
		fixture.clock.advance(10);
		await expect(pending).rejects.toThrow(/delivery timed out/i);

		expect((fixture.bridge as any).state).toBe("ready");
		expect(observed).toEqual([]);
	});

	it("does not publish agent_start when stop rejects an unpulled input", async () => {
		const fixture = bridgeFixture({ autoPullInputs: false });
		await startReady(fixture);
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
		expect(observed.map(event => event.type)).toEqual(["agent_start", "agent_end"]);
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

	it("keeps aliases as the public model identity while resolving them to SDK wire values", async () => {
		const models: SdkModel[] = [{ value: "sonnet", resolvedModel: "claude-sonnet-5", supportsEffort: true, supportedEffortLevels: ["high"] }];
		const fixture = bridgeFixture({ initialModel: "claude-agent-sdk/sonnet", models });
		const query = await startReady(fixture);
		await expect(fixture.bridge.getState()).resolves.toMatchObject({
			data: { model: expect.objectContaining({ id: "sonnet", reasoning: true }) },
		});

		await fixture.bridge.setModel("claude-agent-sdk", "claude-sonnet-5");
		await expect(fixture.bridge.getState()).resolves.toMatchObject({
			data: { model: expect.objectContaining({ id: "claude-sonnet-5" }) },
		});
		await fixture.bridge.setModel("claude-agent-sdk", "sonnet");
		expect(query.setModels).toEqual(["sonnet", "sonnet"]);
		await expect(fixture.bridge.getState()).resolves.toMatchObject({
			data: { model: expect.objectContaining({ id: "sonnet", reasoning: true }) },
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
		expect(observed.filter(event => event.type === "message_end").map(event => event.message.content[0]?.text)).toEqual(["one", "two"]);
		expect(fixture.bridge.running).toBe(true);
	});

	it("bounds a never-resolving initialization and terminally cleans its single query", async () => {
		const fixture = bridgeFixture();
		const started = fixture.bridge.start();
		await flushMicrotasks();
		fixture.clock.advance(90_000);
		await expect(started).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);
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
			permissionMode: "default",
			mcpServers: { bobbit: expect.any(Object) },
		});
		expect(query.options.disallowedTools).toEqual(expect.arrayContaining([
			"Bash", "Read", "ToolSearch", "Task", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate",
		]));
		expect(query.options.disallowedTools).not.toContain("Agent");
		expect(query.options.canUseTool).toEqual(expect.any(Function));
		await expect((query.options.canUseTool as any)("Agent", {
			subagent_type: "bobbit-backend-parity-reviewer", prompt: "must be denied without a policy", run_in_background: false,
		}, { signal: new AbortController().signal, toolUseID: "agent-use-without-policy" })).resolves.toMatchObject({ behavior: "deny" });
		expect((query.options.hooks as any).PreToolUse).toHaveLength(1);
	});

	it("settles pending readiness on stop and never lets abort resurrect failed or stopped queries", async () => {
		const fixture = bridgeFixture();
		const started = fixture.bridge.start();
		await Promise.resolve();
		const pendingPrompt = fixture.bridge.promptWhenReady("waiting");
		await fixture.bridge.stop();
		await expect(pendingPrompt).rejects.toThrow(/stopped/i);
		await expect(started).rejects.toThrow(/stopped/i);
		expect(fixture.query.closeCalls).toBe(1);
		await expect(fixture.bridge.abort()).resolves.toMatchObject({ success: false });
		expect(fixture.bridge.running).toBe(false);

		const failed = bridgeFixture();
		const failedStart = failed.bridge.start();
		await Promise.resolve();
		failed.query.initialization.reject(new Error("provider unavailable"));
		await expect(failedStart).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);
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
