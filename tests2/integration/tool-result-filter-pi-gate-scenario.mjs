import assert from "node:assert/strict";
const RAW_CONTENT = "EP14_PI_GATE_RAW_CONTENT_CANARY";
const RAW_DETAILS = "EP14_PI_GATE_RAW_DETAILS_CANARY";
const RAW_USAGE = "EP14_PI_GATE_RAW_USAGE_CANARY";
const SAFE_CONTENT = "EP14_PI_GATE_SAFE_RESULT";
const model = {
	id: "test-model", name: "Test model", api: "test", provider: "test", baseUrl: "https://example.invalid",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10_000, maxTokens: 1_000,
};

function rawCanaryAbsent(value) {
	const serialized = JSON.stringify(value);
	assert.equal(serialized.includes(RAW_CONTENT), false, "raw result content escaped");
	assert.equal(serialized.includes(RAW_DETAILS), false, "raw result details escaped");
	assert.equal(serialized.includes(RAW_USAGE), false, "raw result usage escaped");
}

export async function runPatchedPiGateScenario({ Agent, createAssistantMessageEventStream, AgentSession }) {
const emittedToExtensions = [];
const emittedToSession = [];
const persisted = [];
const modelContexts = [];
let gateCalls = 0;
let streamCall = 0;
const tool = {
	name: "canary-tool", label: "Canary tool", description: "Pi result gate fixture",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	async execute(_id, _args, _signal, onUpdate) {
		// Updates are cumulative snapshots: aggregate size is deliberately large,
		// while each individual private frame remains inside the gate limit.
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
			? { role: "assistant", content: [{ type: "toolCall", id: "call-pi-gate", name: "canary-tool", arguments: {} }], api: currentModel.api, provider: currentModel.provider, model: currentModel.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() }
			: { role: "assistant", content: [{ type: "text", text: "done" }], api: currentModel.api, provider: currentModel.provider, model: currentModel.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason, message });
		return stream;
	},
});

// This is the smallest session shell that owns Pi's actual patched hook and
// extension-event methods. The shell records the same model/session/transcript
// fan-out owners without constructing unrelated filesystem/model runtime state.
const session = {
	agent,
	_toolResultGate: async () => {
		gateCalls++;
		return { content: [{ type: "text", text: SAFE_CONTENT }], isError: true };
	},
	_toolResultGateUpdateBytes: new Map(),
	_toolResultGateOverflow: new Set(),
	_extensionRunner: {
		hasHandlers: () => false,
		emit: async event => { emittedToExtensions.push(event); },
		emitMessageEnd: async () => undefined,
	},
	_emit: event => { emittedToSession.push(event); },
	sessionManager: { appendMessage: message => { persisted.push(message); } },
	_willRetryAfterAgentEnd: () => false,
	_steeringMessages: [],
	_followUpMessages: [],
	_emitExtensionEvent: AgentSession.prototype._emitExtensionEvent,
};
session._handleAgentEvent = async event => {
	if (session._toolResultGate && event.type === "tool_execution_update") {
		await session._emitExtensionEvent(event);
		return;
	}
	await session._emitExtensionEvent(event);
	session._emit(event);
	if (event.type === "message_end" && event.message.role === "toolResult") session.sessionManager.appendMessage(event.message);
};
AgentSession.prototype._installAgentToolHooks.call(session);
agent.subscribe(session._handleAgentEvent);

await agent.prompt("run canary");

assert.equal(gateCalls, 1, "the installed Pi hook must call the result gate exactly once");
assert.equal(session._toolResultGateOverflow.size, 0, "terminal result handling must dispose overflow state");
assert.equal(session._toolResultGateUpdateBytes.size, 0, "terminal result handling must dispose update accounting");
assert.equal(emittedToSession.some(event => event.type === "tool_execution_update"), false, "private updates reached session listeners");
assert.equal(emittedToExtensions.some(event => event.type === "tool_execution_update"), false, "private updates reached extensions");
for (const value of [emittedToExtensions, emittedToSession, persisted, modelContexts, agent.state.messages]) rawCanaryAbsent(value);
const terminalEvent = emittedToSession.find(event => event.type === "tool_execution_end");
assert.deepEqual(terminalEvent?.result?.content, [{ type: "text", text: SAFE_CONTENT }]);
assert.equal(terminalEvent?.result?.details, undefined);
assert.equal(terminalEvent?.result?.usage, undefined);
assert.equal(terminalEvent?.isError, true);
const transcriptResult = persisted.find(message => message.role === "toolResult");
assert.equal(transcriptResult?.toolCallId, "call-pi-gate");
assert.equal(transcriptResult?.toolName, "canary-tool");
assert.deepEqual(transcriptResult?.content, [{ type: "text", text: SAFE_CONTENT }]);
assert.equal(transcriptResult?.details, undefined);
assert.equal(transcriptResult?.usage, undefined);
assert.equal(transcriptResult?.isError, true);

const bytes = new Map([["call-abort", 512]]);
const overflow = new Set(["call-abort"]);
let aborted = false;
await AgentSession.prototype.abort.call({
	abortRetry() {},
	_toolResultGateUpdateBytes: bytes,
	_toolResultGateOverflow: overflow,
	agent: { abort() { aborted = true; } },
	waitForIdle: async () => {},
});
assert.equal(aborted, true);
assert.equal(bytes.size, 0, "abort must clear private update accounting");
assert.equal(overflow.size, 0, "abort must clear private overflow state");

}
