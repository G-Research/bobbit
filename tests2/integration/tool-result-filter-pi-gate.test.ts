import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentSession } from "@earendil-works/pi-coding-agent";

const RAW_CONTENT = "EP14_PI_GATE_RAW_CONTENT_CANARY";
const RAW_DETAILS = "EP14_PI_GATE_RAW_DETAILS_CANARY";
const RAW_USAGE = "EP14_PI_GATE_RAW_USAGE_CANARY";
const SAFE_CONTENT = "EP14_PI_GATE_SAFE_RESULT";

const model: any = {
	id: "test-model", name: "Test model", api: "test", provider: "test", baseUrl: "https://example.invalid",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1_000,
};

function rawCanaryAbsent(value: unknown): void {
	const serialized = JSON.stringify(value);
	expect(serialized).not.toContain(RAW_CONTENT);
	expect(serialized).not.toContain(RAW_DETAILS);
	expect(serialized).not.toContain(RAW_USAGE);
}

describe("patched Pi result gate", () => {
	it("withholds all raw updates and makes the gate result authoritative before session, transcript, and model fan-out", async () => {
		const emittedToExtensions: unknown[] = [];
		const emittedToSession: unknown[] = [];
		const persisted: unknown[] = [];
		const modelContexts: unknown[] = [];
		let gateCalls = 0;
		let streamCall = 0;

		const tool: any = {
			name: "canary-tool", label: "Canary tool", description: "Pi result gate fixture",
			parameters: Type.Object({}),
			async execute(_id: string, _args: unknown, _signal?: AbortSignal, onUpdate?: (result: unknown) => void) {
				// Pi updates are cumulative snapshots. Their aggregate exceeds 256 KiB,
				// but no individual snapshot does.
				for (let index = 0; index < 100; index++) onUpdate?.({ content: [{ type: "text", text: "x".repeat(4 * 1024) }] });
				return {
					content: [{ type: "text", text: RAW_CONTENT }],
					details: { canary: RAW_DETAILS },
					usage: { canary: RAW_USAGE },
				};
			},
		};
		const agent = new Agent({
			initialState: { systemPrompt: "test", model, tools: [tool] },
			streamFn: (currentModel, context) => {
				modelContexts.push(context);
				const stream = createAssistantMessageEventStream();
				const message = streamCall++ === 0
					? { role: "assistant" as const, content: [{ type: "toolCall" as const, id: "call-pi-gate", name: "canary-tool", arguments: {} }], api: currentModel.api, provider: currentModel.provider, model: currentModel.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" as const, timestamp: Date.now() }
					: { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }], api: currentModel.api, provider: currentModel.provider, model: currentModel.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: Date.now() };
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: message.stopReason, message });
				return stream;
			},
		});

		// Exercise the actual installed AgentSession methods without its unrelated
		// model/session setup. The object contains exactly the private owners used
		// by the patched Pi result gate path.
		const session: any = {
			agent,
			_toolResultGate: async () => {
				gateCalls++;
				return { content: [{ type: "text", text: SAFE_CONTENT }], isError: true };
			},
			_toolResultGateUpdateBytes: new Map<string, number>(),
			_toolResultGateOverflow: new Set<string>(),
			_extensionRunner: {
				hasHandlers: () => false,
				emit: async (event: unknown) => { emittedToExtensions.push(event); },
				emitMessageEnd: async () => undefined,
			},
			_emit: (event: unknown) => { emittedToSession.push(event); },
			sessionManager: { appendMessage: (message: unknown) => { persisted.push(message); } },
			_willRetryAfterAgentEnd: () => false,
			_steeringMessages: [],
			_followUpMessages: [],
			_emitExtensionEvent: (AgentSession.prototype as any)._emitExtensionEvent,
		};
		session._handleAgentEvent = async (event: any) => {
			if (session._toolResultGate && event.type === "tool_execution_update") {
				await session._emitExtensionEvent(event);
				return;
			}
			await session._emitExtensionEvent(event);
			session._emit(event);
			if (event.type === "message_end" && event.message.role === "toolResult") session.sessionManager.appendMessage(event.message);
		};
		(AgentSession.prototype as any)._installAgentToolHooks.call(session);
		agent.subscribe(session._handleAgentEvent);

		await agent.prompt("run canary");

		expect(gateCalls).toBe(1);
		expect(session._toolResultGateOverflow.size).toBe(0);
		expect(session._toolResultGateUpdateBytes.size).toBe(0);
		expect(emittedToSession.some((event: any) => event.type === "tool_execution_update")).toBe(false);
		expect(emittedToExtensions.some((event: any) => event.type === "tool_execution_update")).toBe(false);
		for (const value of [emittedToExtensions, emittedToSession, persisted, modelContexts, agent.state.messages]) rawCanaryAbsent(value);
		expect(emittedToSession.find((event: any) => event.type === "tool_execution_end")).toMatchObject({ result: { content: [{ text: SAFE_CONTENT }], details: undefined, usage: undefined }, isError: true });
		expect(persisted).toContainEqual(expect.objectContaining({ role: "toolResult", content: [{ type: "text", text: SAFE_CONTENT }], isError: true, details: undefined, usage: undefined }));
	});

	it("clears private result-gate buffer state on abort", async () => {
		const bytes = new Map([["call-abort", 512]]);
		const overflow = new Set(["call-abort"]);
		let aborted = false;
		await (AgentSession.prototype as any).abort.call({
			abortRetry() {},
			_toolResultGateUpdateBytes: bytes,
			_toolResultGateOverflow: overflow,
			agent: { abort() { aborted = true; } },
			waitForIdle: async () => {},
		});
		expect(aborted).toBe(true);
		expect(bytes.size).toBe(0);
		expect(overflow.size).toBe(0);
	});
});
