import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
	AgentEvent,
	AgentTool,
	StreamFn,
} from "@earendil-works/pi-agent-core";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolCallEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import { guardProcessEnv } from "./helpers/env-guard.js";

guardProcessEnv();

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tool-lifecycle-contract-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../../src/server/agent/session-manager.ts");
const { subscribeToEvents } = await import("../../src/server/agent/session-setup.ts");
const { PromptQueue } = await import("../../src/server/agent/prompt-queue.ts");
const { EventBuffer } = await import("../../src/server/agent/event-buffer.ts");
const { createManualClock } = await import("../harness/clock.js");

const managers: any[] = [];

const usage = {
	input: 2,
	output: 3,
	cacheRead: 5,
	cacheWrite: 7,
	totalTokens: 17,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};

function makeManager(): any {
	const clock = createManualClock();
	const manager: any = new SessionManager({ clock });
	if (manager._statusHeartbeatTimer) {
		clock.clearInterval(manager._statusHeartbeatTimer);
		manager._statusHeartbeatTimer = null;
	}
	manager._testClock = clock;
	manager._testStore = { update: vi.fn(), get: vi.fn(() => undefined) };
	managers.push(manager);
	return manager;
}

function makeSession(manager: any, rpcClient: Record<string, unknown>): any {
	const session = {
		id: "s-pi-tool-lifecycle",
		title: "Pi tool lifecycle contract",
		cwd: tmpRoot,
		status: "streaming",
		statusVersion: 0,
		clients: new Set(),
		promptQueue: new PromptQueue(),
		eventBuffer: new EventBuffer(),
		createdAt: Date.now(),
		lastActivity: Date.now(),
		setupComplete: true,
		allowedTools: ["read"],
		rpcClient,
	};
	manager.sessions.set(session.id, session);
	return session;
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Compile-time bridge canary: Pi 0.81 exports the coding-agent lifecycle
 * interfaces separately from agent-core's AgentEvent union. Bobbit accepts the
 * core events over RPC, so keep the two public contracts structurally aligned.
 */
function assertCodingAgentToolEventType(event: AgentEvent): void {
	switch (event.type) {
		case "tool_execution_start": {
			const typed: ToolExecutionStartEvent = event;
			void typed;
			break;
		}
		case "tool_execution_update": {
			const typed: ToolExecutionUpdateEvent = event;
			void typed;
			break;
		}
		case "tool_execution_end": {
			const typed: ToolExecutionEndEvent = event;
			void typed;
			break;
		}
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) {
		if (manager._statusHeartbeatTimer) {
			manager._testClock?.clearInterval?.(manager._statusHeartbeatTimer);
			manager._statusHeartbeatTimer = null;
		}
		manager.sessions?.clear?.();
		manager.sessionsWithConnectedClients?.clear?.();
	}
});

describe("Pi 0.81 tool lifecycle contract", () => {
	it("keeps extension call/result hooks and execution start/update/end in Pi order", async () => {
		const order: string[] = [];
		const extensionPayloads: Array<ToolCallEvent | ToolResultEvent> = [];
		const emitted: AgentEvent[] = [];
		let streamCall = 0;

		const finalResult: AgentToolResult<{ phase: string }> = {
			content: [{ type: "text", text: "complete" }],
			details: { phase: "final" },
			usage,
			addedToolNames: ["dynamic_search"],
		};
		const partialResult: AgentToolResult<{ phase: string }> = {
			content: [{ type: "text", text: "halfway" }],
			details: { phase: "partial" },
		};
		const reportPartial: AgentToolUpdateCallback<{ phase: string }> = (value) => {
			assert.equal(value, partialResult);
		};

		const tool: AgentTool<any, { phase: string }> = {
			name: "sample_tool",
			label: "Sample tool",
			description: "Exercises the Pi lifecycle contract",
			parameters: Type.Object({ value: Type.Number() }),
			async execute(_toolCallId, args, _signal, onUpdate) {
				order.push("execute");
				assert.deepEqual(args, { value: 1 });
				reportPartial(partialResult);
				onUpdate?.(partialResult);
				return finalResult;
			},
		};

		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			const message = streamCall++ === 0
				? {
					role: "assistant" as const,
					content: [{ type: "toolCall" as const, id: "call-1", name: "sample_tool", arguments: { value: 1 } }],
					api: "test",
					provider: "test",
					model: "test-model",
					usage,
					stopReason: "toolUse" as const,
					timestamp: Date.now(),
				}
				: {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "done" }],
					api: "test",
					provider: "test",
					model: "test-model",
					usage,
					stopReason: "stop" as const,
					timestamp: Date.now(),
				};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
			return stream;
		};

		const agent = new Agent({
			initialState: {
				systemPrompt: "test",
				model: {
					id: "test-model",
					name: "Test model",
					api: "test",
					provider: "test",
					baseUrl: "https://example.invalid",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 10_000,
					maxTokens: 1_000,
				},
				tools: [tool],
			},
			streamFn,
			beforeToolCall: async ({ toolCall, args }) => {
				const event = {
					type: "tool_call",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args as Record<string, unknown>,
				} satisfies ToolCallEvent;
				extensionPayloads.push(event);
				order.push(event.type);
				return undefined;
			},
			afterToolCall: async ({ toolCall, args, result, isError }) => {
				const event = {
					type: "tool_result",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					isError,
					usage: result.usage,
				} satisfies ToolResultEvent;
				extensionPayloads.push(event);
				order.push(event.type);
				return undefined;
			},
		});

		agent.subscribe((event) => {
			assertCodingAgentToolEventType(event);
			emitted.push(event);
			if (event.type.startsWith("tool_execution_")) order.push(event.type);
		});

		await agent.prompt("run the sample tool");

		expect(order).toEqual([
			"tool_execution_start",
			"tool_call",
			"execute",
			"tool_execution_update",
			"tool_result",
			"tool_execution_end",
		]);
		expect(extensionPayloads.map((event) => event.type)).toEqual(["tool_call", "tool_result"]);

		const update = emitted.find((event): event is Extract<AgentEvent, { type: "tool_execution_update" }> => event.type === "tool_execution_update");
		assert.ok(update);
		assert.equal(update.partialResult, partialResult);
		expect("usage" in update.partialResult).toBe(false);
		expect("addedToolNames" in update.partialResult).toBe(false);

		const end = emitted.find((event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end");
		assert.ok(end);
		assert.equal(end.result, finalResult);
		assert.equal(end.result.usage, usage);
		expect(end.result.addedToolNames).toEqual(["dynamic_search"]);

		const persistedResult = emitted.find((event) => event.type === "message_end" && event.message.role === "toolResult");
		assert.ok(persistedResult && persistedResult.type === "message_end" && persistedResult.message.role === "toolResult");
		assert.equal(persistedResult.message.usage, usage);
		expect(persistedResult.message.addedToolNames).toEqual(["dynamic_search"]);
	});

	it("forwards partial/final payloads unchanged while policy and steer side effects stay on their boundaries", async () => {
		const manager = makeManager();
		let listener: ((event: any) => void) | undefined;
		const steer = vi.fn(async () => ({ success: true }));
		const session = makeSession(manager, {
			onEvent: (fn: (event: any) => void) => {
				listener = fn;
				return () => { listener = undefined; };
			},
			steer,
		});
		session.promptQueue.enqueue("steer at final boundary", { isSteered: true });

		const policyError = vi.spyOn(console, "error").mockImplementation(() => {});
		const start = {
			type: "tool_execution_start",
			toolCallId: "call-2",
			toolName: "write",
			args: { path: "forbidden.txt" },
		} satisfies ToolExecutionStartEvent;
		const partialResult: AgentToolResult<{ lines: number }> = {
			content: [{ type: "text", text: "writing" }],
			details: { lines: 1 },
		};
		const update = {
			type: "tool_execution_update",
			toolCallId: "call-2",
			toolName: "write",
			args: start.args,
			partialResult,
		} satisfies ToolExecutionUpdateEvent;
		const finalResult: AgentToolResult<{ lines: number }> = {
			content: [{ type: "text", text: JSON.stringify({ isError: true, error: "write denied" }) }],
			details: { lines: 1 },
			usage,
			addedToolNames: ["post_write_tool"],
		};
		const end = {
			type: "tool_execution_end",
			toolCallId: "call-2",
			toolName: "write",
			result: finalResult,
			isError: false,
		} satisfies ToolExecutionEndEvent;

		const ctx: any = {
			store: manager._testStore,
			handleAgentLifecycle: (current: any, event: any) => manager.handleAgentLifecycle(current, event),
			trackCostFromEvent: (current: any, event: any) => manager.trackCostFromEvent(current, event),
		};
		const unsub = subscribeToEvents(session, ctx);

		listener?.(start);
		listener?.(update);
		expect(session.turnHadToolCalls).toBe(true);
		expect(steer).not.toHaveBeenCalled();
		expect(session.promptQueue.length).toBe(1);

		listener?.(end);
		await flush();

		expect(policyError).toHaveBeenCalledTimes(1);
		expect(policyError.mock.calls[0][0]).toContain('executed disallowed tool "write"');
		expect(steer).toHaveBeenCalledTimes(1);
		expect(steer).toHaveBeenCalledWith("steer at final boundary");
		expect(session.promptQueue.length).toBe(0);

		const buffered = session.eventBuffer.getAll().map((entry: any) => entry.event);
		expect(buffered.map((event: any) => event.type)).toEqual([
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
		]);
		assert.equal(buffered[1].partialResult, partialResult);
		expect("usage" in buffered[1].partialResult).toBe(false);
		expect("addedToolNames" in buffered[1].partialResult).toBe(false);
		assert.equal(buffered[2].isError, true, "serialized returned errors stay visible as failed tools");
		assert.equal(buffered[2].result.usage, usage);
		expect(buffered[2].result.addedToolNames).toEqual(["post_write_tool"]);
		assert.equal(end.isError, false, "normalization must not mutate Pi's source event");

		unsub();
	});
});
