// v2-native — deterministic Agent SDK bridge coverage through its production deps seam.
import { describe, expect, it } from "vitest";

import {
	ClaudeAgentSdkBridge,
	ClaudeAgentSdkUnavailableError,
	buildClaudeAgentSdkEnv,
} from "../../src/server/agent/claude-agent-sdk-bridge.ts";
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

class FakeQuery implements AsyncIterable<unknown> {
	readonly initialization = deferred<{ session_id: string }>();
	readonly events: unknown[] = [];
	readonly waiters: Array<(result: IteratorResult<unknown>) => void> = [];
	readonly inputs: unknown[] = [];
	readonly inputWaiters: Array<(input: unknown) => void> = [];
	readonly setModels: string[] = [];
	readonly thinkingBudgets: Array<number | null> = [];
	interruptCalls = 0;
	closeCalls = 0;
	private closed = false;

	constructor(readonly prompt: AsyncIterable<unknown>, readonly options: Record<string, unknown>) {
		void this.pullInputs();
	}
	initializationResult(): Promise<{ session_id: string }> { return this.initialization.promise; }
	async pullInputs(): Promise<void> {
		try {
			for await (const input of this.prompt) {
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
	async setModel(model: string): Promise<void> { this.setModels.push(model); }
	async setMaxThinkingTokens(budget: number | null): Promise<void> { this.thinkingBudgets.push(budget); }
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

function bridgeFixture(overrides: Record<string, unknown> = {}) {
	const clock = new FakeClock();
	let query!: FakeQuery;
	const bridge = new ClaudeAgentSdkBridge({
		runtime: "claude-agent-sdk",
		cwd: "/workspace/project",
		initialModel: "claude-agent-sdk/sonnet-test",
		env: { BOBBIT_TOKEN: "gateway-secret", PROJECT_TOKEN: "must-not-leak" },
		...overrides,
	}, {
		query: ((input: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
			query = new FakeQuery(input.prompt, input.options);
			return query;
		}) as never,
		clock,
	});
	return { bridge, clock, get query() { return query; } };
}

async function flushMicrotasks(count = 6): Promise<void> {
	for (let index = 0; index < count; index++) await Promise.resolve();
}

async function startReady(fixture: ReturnType<typeof bridgeFixture>, sessionId = "sdk-session-a"): Promise<FakeQuery> {
	const started = fixture.bridge.start();
	await Promise.resolve();
	fixture.query.initialization.resolve({ session_id: sessionId });
	await started;
	return fixture.query;
}

describe("ClaudeAgentSdkBridge", () => {
	it("waits for initialization, times out deterministically, and fails pending prompts without hanging", async () => {
		const fixture = bridgeFixture();
		const started = fixture.bridge.start();
		await Promise.resolve();
		const wait = fixture.bridge.waitForReady(25);
		fixture.clock.advance(25);
		await expect(wait).rejects.toThrow(/readiness timed out/i);

		fixture.query.initialization.reject(new Error("subscription unavailable: TOKEN=secret"));
		await expect(started).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);
		await expect(fixture.bridge.prompt("must settle", undefined, 10)).rejects.toThrow(/unavailable|subscription/i);
		await expect(fixture.bridge.waitForReady(1)).rejects.toBeInstanceOf(ClaudeAgentSdkUnavailableError);
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
			expect.objectContaining({ type: "message_end", parentToolUseId: "child" }),
			expect.objectContaining({ type: "agent_end" }),
		]));
		expect(observed.filter(event => event.type === "agent_end")).toHaveLength(1);
	});

	it("marks a turn running before a synchronous SDK terminal event can be emitted", async () => {
		const fixture = bridgeFixture();
		const query = await startReady(fixture);
		const observed: any[] = [];
		fixture.bridge.onEvent(event => observed.push(event));
		const input = (fixture.bridge as any).input;
		const push = input.push.bind(input);
		input.push = (...args: any[]) => {
			// Model an SDK consumer that completes its turn while accepting input,
			// before enqueue() resumes from its delivery await.
			query.emit({ type: "result", subtype: "success" });
			return push(...args);
		};

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

	it("applies only verified SDK model/thinking controls and rejects unsupported or cross-runtime controls", async () => {
		const fixture = bridgeFixture();
		const query = await startReady(fixture, "opaque-id");
		await expect(fixture.bridge.setModel("claude-agent-sdk", "opus-test")).resolves.toMatchObject({ success: true });
		expect(query.setModels).toEqual(["opus-test"]);
		await expect(fixture.bridge.setModel("anthropic", "sonnet")).resolves.toMatchObject({ success: false });
		await expect(fixture.bridge.setThinkingLevel("off")).resolves.toMatchObject({ success: true });
		await expect(fixture.bridge.setThinkingLevel("high")).resolves.toMatchObject({ success: true });
		expect(query.thinkingBudgets[0]).toBeNull();
		expect(query.thinkingBudgets[1]).toBeGreaterThan(0);
		await expect(fixture.bridge.compact()).resolves.toMatchObject({ success: false });
		await expect(fixture.bridge.sendCommand()).resolves.toMatchObject({ success: false });
		await expect(fixture.bridge.getMessages()).resolves.toMatchObject({ success: false });
		await expect(fixture.bridge.getState()).resolves.toMatchObject({
			data: expect.objectContaining({ model: { provider: "claude-agent-sdk", id: "opus-test" } }),
		});
	});

	it("adapts SDK PreCompact through the existing beforeCompact callback without fabricating manual compact events", async () => {
		const calls: unknown[] = [];
		const fixture = bridgeFixture({ onBeforeCompact: async (input: unknown) => { calls.push(input); } });
		const query = await startReady(fixture);
		const preCompact = (query.options.hooks as any).PreCompact;
		expect(preCompact).toHaveLength(1);
		await preCompact[0].hooks[0]({ trigger: "auto" });
		expect(calls).toHaveLength(1);
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
		await expect(bridge.start()).rejects.toMatchObject({ code: "CLAUDE_AGENT_SDK_UNAVAILABLE" });
		expect(queryCalls).toBe(0);
	});

	it("uses SDK isolation mode and no built-ins until a provider-neutral policy adapter exists", async () => {
		const fixture = bridgeFixture();
		const query = await startReady(fixture);
		expect(query.options.settingSources).toEqual([]);
		expect(query.options.tools).toEqual([]);
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
		await expect(bridge.start()).rejects.toMatchObject({ code: "CLAUDE_AGENT_SDK_UNAVAILABLE", message: expect.stringContaining("TOKEN=<redacted>") });
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
