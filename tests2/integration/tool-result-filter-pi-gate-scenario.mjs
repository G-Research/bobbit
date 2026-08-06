import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
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

async function verifySealedCoreLoader(root) {
	const temp = await mkdtemp(join(tmpdir(), "ep14-sealed-pi-loader-"));
	const gatePath = join(temp, "core-gate.mjs");
	const ordinaryPath = join(temp, "ordinary-extension.mjs");
	const previous = process.env.BOBBIT_TOOL_RESULT_FILTER_GATE;
	const nativeFetch = globalThis.fetch;
	const nativeDefineProperty = Object.defineProperty;
	try {
		await writeFile(gatePath, `const capturedFetch = globalThis.fetch; export default () => async () => ({ content: [{ type: "text", text: "EP14_PRIVATE_GATE_SAFE" }], isError: true, capturedFetch });`, "utf8");
		await writeFile(ordinaryPath, `export default (pi) => { if ("setToolResultGate" in pi) throw new Error("public gate setter leaked"); globalThis.fetch = () => { throw new Error("ordinary extension observed core request"); }; Object.defineProperty = () => { throw new Error("ordinary extension replaced core primitive"); }; };`, "utf8");
		process.env.BOBBIT_TOOL_RESULT_FILTER_GATE = gatePath;
		const { loadExtensionsCached } = await import(pathToFileURL(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "extensions", "loader.js")).href);
		const loaded = await loadExtensionsCached([ordinaryPath], root);
		assert.deepEqual(loaded.errors, [], "ordinary extension must load without a public setter");
		const descriptor = Object.getOwnPropertyDescriptor(loaded.runtime, "__bobbitCoreToolResultGate");
		assert.equal(descriptor?.enumerable, false, "core gate must be absent from ordinary runtime enumeration");
		assert.equal(descriptor?.writable, false, "ordinary extensions cannot replace the core gate");
		assert.equal(typeof descriptor?.value, "function", "core gate must install before ordinary extensions");
		const gateOutput = await descriptor.value({});
		assert.deepEqual(gateOutput.content, [{ type: "text", text: "EP14_PRIVATE_GATE_SAFE" }]);
		assert.equal(gateOutput.isError, true);
		assert.notEqual(gateOutput.capturedFetch, globalThis.fetch, "ordinary fetch monkeypatch must not replace core transport");
		process.env.BOBBIT_TOOL_RESULT_FILTER_GATE = join(temp, "attacker-gate.mjs");
		const reloaded = await loadExtensionsCached([ordinaryPath], root);
		assert.equal(reloaded.runtime.__bobbitCoreToolResultGate, descriptor.value, "delayed environment changes cannot replace the sealed gate");
	} finally {
		Object.defineProperty = nativeDefineProperty;
		globalThis.fetch = nativeFetch;
		if (previous === undefined) delete process.env.BOBBIT_TOOL_RESULT_FILTER_GATE;
		else process.env.BOBBIT_TOOL_RESULT_FILTER_GATE = previous;
		await rm(temp, { recursive: true, force: true });
	}
}

async function runChildScenario(root) {
	const [{ Agent }, { createAssistantMessageEventStream }, { AgentSession }] = await Promise.all([
		import(pathToFileURL(join(root, "node_modules", "@earendil-works", "pi-agent-core", "dist", "index.js")).href),
		import(pathToFileURL(join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")).href),
		import(pathToFileURL(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href),
	]);
	await verifySealedCoreLoader(root);
	await runPatchedPiGateScenario({ Agent, createAssistantMessageEventStream, AgentSession });
}

function runChildNodeProcess(root) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [fileURLToPath(import.meta.url), root], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", chunk => { stdout += chunk; });
		child.stderr.on("data", chunk => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (exitCode, signal) => resolve({ stdout, stderr, exitCode, signal }));
	});
}

if (!isMainThread) {
	if (typeof workerData !== "string") throw new Error("Expected private Pi harness root worker data");
	runChildNodeProcess(workerData)
		.then(result => parentPort?.postMessage(result))
		.catch(error => parentPort?.postMessage({ error: error instanceof Error ? error.stack ?? error.message : String(error) }));
} else if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const root = process.argv[2];
	if (!root) throw new Error("Expected private Pi harness root argument");
	runChildScenario(root)
		.then(() => process.stdout.write("PI_RESULT_GATE_SCENARIO_PASSED\n"))
		.catch(error => {
			process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
			process.exitCode = 1;
		});
}
