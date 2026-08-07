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

/**
 * Simulates an ordinary same-realm extension patching common globals after the
 * core gate module has loaded. Every wrapper preserves normal behavior but
 * records whether it ever receives a raw result canary. The core gate must use
 * its loader-time snapshots and own descriptors instead.
 */
async function assertRawResultIntrinsicsSealed(run) {
	const objectGetOwnPropertyNames = Object.getOwnPropertyNames;
	const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
	const stringIndexOf = String.prototype.indexOf;
	const seen = [];
	const observesRaw = value => {
		if (typeof value === "string") return stringIndexOf.call(value, RAW_CONTENT) >= 0 || stringIndexOf.call(value, RAW_DETAILS) >= 0 || stringIndexOf.call(value, RAW_USAGE) >= 0;
		if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
		for (let index = 0; index < seen.length; index++) if (seen[index] === value) return false;
		seen.push(value);
		try {
			const names = objectGetOwnPropertyNames(value);
			for (let index = 0; index < names.length; index++) {
				const descriptor = objectGetOwnPropertyDescriptor(value, names[index]);
				if (descriptor && "value" in descriptor && observesRaw(descriptor.value)) return true;
			}
			return false;
		} catch { return false; }
	};
	const originals = {
		stringify: JSON.stringify, byteLength: Buffer.byteLength, keys: Object.keys,
		getPrototypeOf: Object.getPrototypeOf, getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
		every: Array.prototype.every, sort: Array.prototype.sort, includes: Array.prototype.includes, map: Array.prototype.map,
		objectToJSON: objectGetOwnPropertyDescriptor(Object.prototype, "toJSON"),
		arrayToJSON: objectGetOwnPropertyDescriptor(Array.prototype, "toJSON"),
		inheritedDetails: objectGetOwnPropertyDescriptor(Object.prototype, "details"),
	};
	const observedBy = [];
	const wrap = (name, original) => function (...args) {
		if (observesRaw(this) || observesRaw(args)) observedBy.push(name);
		return original.apply(this, args);
	};
	try {
		JSON.stringify = wrap("JSON.stringify", originals.stringify);
		Buffer.byteLength = wrap("Buffer.byteLength", originals.byteLength);
		Object.keys = wrap("Object.keys", originals.keys);
		Object.getPrototypeOf = wrap("Object.getPrototypeOf", originals.getPrototypeOf);
		Object.getOwnPropertyDescriptor = wrap("Object.getOwnPropertyDescriptor", originals.getOwnPropertyDescriptor);
		Array.prototype.every = wrap("Array.prototype.every", originals.every);
		Array.prototype.sort = wrap("Array.prototype.sort", originals.sort);
		Array.prototype.includes = wrap("Array.prototype.includes", originals.includes);
		Array.prototype.map = wrap("Array.prototype.map", originals.map);
		// Return the original receiver so harmless JSON users in the fixture keep
		// their normal serialization; the wrapper still records any raw receiver.
		Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: wrap("Object.prototype.toJSON", function () { return this; }) });
		Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: wrap("Array.prototype.toJSON", function () { return this; }) });
		Object.defineProperty(Object.prototype, "details", { configurable: true, get: wrap("Object.prototype.details", () => undefined) });
		await run();
	} finally {
		JSON.stringify = originals.stringify;
		Buffer.byteLength = originals.byteLength;
		Object.keys = originals.keys;
		Object.getPrototypeOf = originals.getPrototypeOf;
		Object.getOwnPropertyDescriptor = originals.getOwnPropertyDescriptor;
		Array.prototype.every = originals.every;
		Array.prototype.sort = originals.sort;
		Array.prototype.includes = originals.includes;
		Array.prototype.map = originals.map;
		if (originals.objectToJSON) Object.defineProperty(Object.prototype, "toJSON", originals.objectToJSON);
		else delete Object.prototype.toJSON;
		if (originals.arrayToJSON) Object.defineProperty(Array.prototype, "toJSON", originals.arrayToJSON);
		else delete Array.prototype.toJSON;
		if (originals.inheritedDetails) Object.defineProperty(Object.prototype, "details", originals.inheritedDetails);
		else delete Object.prototype.details;
	}
	assert.deepEqual(observedBy, [], `mutable shared-realm intrinsic observed raw result: ${observedBy.join(", ")}`);
}

export async function runPatchedPiGateScenario({ Agent, createAssistantMessageEventStream, AgentSession }) {
const generatedGatePath = process.env.BOBBIT_EP14_GENERATED_GATE;
if (!generatedGatePath) throw new Error("Expected generated EP14 gate path");
const emittedToExtensions = [];
const emittedToSession = [];
const persisted = [];
const modelContexts = [];
let gateCalls = 0;
let plannedTurns = [];
const tool = {
	name: "canary-tool", label: "Canary tool", description: "Pi result gate fixture",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	async execute(id, _args, _signal, onUpdate) {
		if (id === "call-pi-overflow") {
			onUpdate?.({ content: [{ type: "text", text: "x".repeat(300 * 1024) }] });
		} else if (id === "call-pi-cumulative") {
			// Pi emits cumulative snapshots: 100 increasing snapshots must be
			// admitted by peak size, not rejected by their sum.
			for (let index = 1; index <= 100; index++) onUpdate?.({ content: [{ type: "text", text: "x".repeat(index * 1024) }] });
		} else {
			for (let index = 0; index < 4; index++) onUpdate?.({ content: [{ type: "text", text: "x".repeat(4 * 1024) }] });
		}
		return {
			content: [{ type: "text", text: `${RAW_CONTENT}:${id}` }],
			details: { canary: `${RAW_DETAILS}:${id}` },
			usage: { canary: `${RAW_USAGE}:${id}` },
		};
	},
};
function assistantMessage(currentModel, content, stopReason) {
	return { role: "assistant", content, api: currentModel.api, provider: currentModel.provider, model: currentModel.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() };
}
const agent = new Agent({
	initialState: { systemPrompt: "test", model, tools: [tool] },
	streamFn: (currentModel, context) => {
		modelContexts.push(context);
		const stream = createAssistantMessageEventStream();
		const calls = plannedTurns.shift();
		const message = calls
			? assistantMessage(currentModel, calls.map(id => ({ type: "toolCall", id, name: "canary-tool", arguments: {} })), "toolUse")
			: assistantMessage(currentModel, [{ type: "text", text: "done" }], "stop");
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason, message });
		return stream;
	},
});

// Construct the shipped AgentSession so its class-field `_handleAgentEvent`
// (not an approximation of it) owns every event. The small dependencies below
// only keep unrelated resources inert while retaining its production fan-out.
const sessionManager = {
	appendMessage: message => { persisted.push(message); },
	appendCustomMessageEntry() {}, appendCustomEntry() {}, getEntry() {}, getSessionName() { return "Pi gate fixture"; },
	appendLabelChange() {},
};
const session = new AgentSession({
	agent,
	sessionManager,
	settingsManager: {
		getImageAutoResize: () => false, getShellCommandPrefix: () => undefined, getShellPath: () => undefined,
		getRetrySettings: () => ({ enabled: false, maxRetries: 0 }), isProjectTrusted: () => true,
	},
	resourceLoader: {
		getExtensions: () => ({ extensions: [], runtime: {
			flagValues: new Map(), pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [], invalidate() {},
		} }),
		getSkills: () => ({ skills: [] }), getPrompts: () => ({ prompts: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined, getAppendSystemPrompt: () => [],
	},
	modelRuntime: { getModel: () => undefined, hasConfiguredAuth: () => false },
	cwd: process.cwd(), baseToolsOverride: { [tool.name]: tool }, initialActiveToolNames: [tool.name],
});
const previousGatewayUrl = process.env.BOBBIT_GATEWAY_URL;
const previousToken = process.env.BOBBIT_TOKEN;
const nativeFetch = globalThis.fetch;
// The adversarial wrapper intentionally changes inherited toJSON. Keep the
// fixture response encoder outside that wrapper so a mock transport cannot
// turn its own safe JSON response into an unrelated gate failure.
const nativeStringify = JSON.stringify;
const gateRequests = [];
let abortRequestObserved;
try {
	process.env.BOBBIT_GATEWAY_URL = "http://pi-gate.fixture";
	process.env.BOBBIT_TOKEN = "pi-gate-token";
	globalThis.fetch = async (url, init) => {
		const request = { url: String(url), body: String(init?.body ?? "") };
		gateRequests.push(request);
		const toolCallId = JSON.parse(request.body).toolCallId;
		if (toolCallId === "call-pi-abort") {
			abortRequestObserved?.();
			return await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("expected abort")), { once: true }));
		}
		return new Response(nativeStringify({ content: [{ type: "text", text: `${SAFE_CONTENT}:${toolCallId}` }], isError: true }), { status: 200, headers: { "Content-Type": "application/json" } });
	};
	const generatedGate = (await import(pathToFileURL(generatedGatePath).href)).default({ runtimeGeneration: 0, runtimeKey: "a".repeat(64) });
	if (typeof generatedGate !== "function") throw new Error("Generated gate factory did not return a gate");
	session._toolResultGate = async event => {
		gateCalls++;
		return await generatedGate(event);
	};
} finally {
	globalThis.fetch = nativeFetch;
	if (previousGatewayUrl === undefined) delete process.env.BOBBIT_GATEWAY_URL;
	else process.env.BOBBIT_GATEWAY_URL = previousGatewayUrl;
	if (previousToken === undefined) delete process.env.BOBBIT_TOKEN;
	else process.env.BOBBIT_TOKEN = previousToken;
}
session._extensionRunner = {
	hasHandlers: () => false,
	emit: async event => { emittedToExtensions.push(event); },
	emitMessageEnd: async () => undefined,
};
session.subscribe(event => { emittedToSession.push(event); });
// Re-install after assigning the core-owned gate. The installed tool hook calls
// back to the real class-field `_handleAgentEvent` already subscribed above.
session._installAgentToolHooks();

plannedTurns = [["call-pi-gate"], undefined];
await assertRawResultIntrinsicsSealed(async () => { await agent.prompt("run canary"); });

assert.equal(gateCalls, 1, "the installed Pi hook must call the generated result gate exactly once");
assert.equal(gateRequests.length, 1, "the generated gate must submit exactly one terminal result");
assert.deepEqual(JSON.parse(gateRequests[0].body), {
	toolCallId: "call-pi-gate", toolName: "canary-tool",
	result: { content: [{ type: "text", text: `${RAW_CONTENT}:call-pi-gate` }], details: { canary: `${RAW_DETAILS}:call-pi-gate` }, isError: false, usage: { canary: `${RAW_USAGE}:call-pi-gate` } },
});
assert.equal(emittedToSession.some(event => event.type === "tool_execution_update"), false, "private updates reached session listeners");
assert.equal(emittedToExtensions.some(event => event.type === "tool_execution_update"), false, "private updates reached extensions");
for (const value of [emittedToExtensions, emittedToSession, persisted, modelContexts, agent.state.messages]) rawCanaryAbsent(value);
const terminalEvent = emittedToSession.find(event => event.type === "tool_execution_end");
assert.deepEqual(terminalEvent?.result?.content, [{ type: "text", text: `${SAFE_CONTENT}:call-pi-gate` }]);
assert.equal(Object.getPrototypeOf(terminalEvent?.result), Object.prototype, "Pi receives an ordinary result object");
assert.equal(Object.getPrototypeOf(terminalEvent?.result?.content), Array.prototype, "Pi receives an ordinary content array");
assert.equal(Object.getPrototypeOf(terminalEvent?.result?.content?.[0]), Object.prototype, "Pi receives ordinary content blocks");
assert.equal(terminalEvent?.result?.details, undefined);
assert.equal(terminalEvent?.result?.usage, undefined);
assert.equal(terminalEvent?.isError, true);
const transcriptResult = persisted.find(message => message.role === "toolResult");
assert.equal(transcriptResult?.toolCallId, "call-pi-gate");
assert.equal(transcriptResult?.toolName, "canary-tool");
assert.deepEqual(transcriptResult?.content, [{ type: "text", text: `${SAFE_CONTENT}:call-pi-gate` }]);
assert.equal(transcriptResult?.details, undefined);
assert.equal(transcriptResult?.usage, undefined);
assert.equal(transcriptResult?.isError, true);

// Cumulative Pi snapshots stay private but are admitted by their 100KiB peak.
plannedTurns = [["call-pi-cumulative"], undefined];
await assertRawResultIntrinsicsSealed(async () => { await agent.prompt("run cumulative canary"); });
assert.equal(gateCalls, 2, "cumulative snapshots still invoke the terminal gate");
assert.equal(gateRequests.length, 2, "cumulative snapshots submit one terminal result");
const cumulativeTerminal = emittedToSession.filter(event => event.type === "tool_execution_end").at(-1);
assert.equal(cumulativeTerminal?.toolCallId, "call-pi-cumulative");
assert.deepEqual(cumulativeTerminal?.result?.content, [{ type: "text", text: `${SAFE_CONTENT}:call-pi-cumulative` }]);

// A single over-cap snapshot must discard every private update and terminal byte
// locally: it does not call the gateway and cannot reuse any previous state.
plannedTurns = [["call-pi-overflow"], undefined];
await agent.prompt("run overflow canary");
assert.equal(gateCalls, 2, "overflow must not invoke the gateway gate");
assert.equal(gateRequests.length, 2, "overflow must not submit a raw terminal result");
const overflowTerminal = emittedToSession.filter(event => event.type === "tool_execution_end").at(-1);
assert.equal(overflowTerminal?.toolCallId, "call-pi-overflow");
assert.equal(overflowTerminal?.isError, true);
assert.match(overflowTerminal?.result?.content?.[0]?.text ?? "", /^Tool result withheld/);
for (const value of [emittedToExtensions, emittedToSession, persisted, modelContexts, agent.state.messages]) rawCanaryAbsent(value);

// A real Pi abort races a delayed successful response. The signal reaches the
// generated gate, cancels the request, and no late safe/raw response resumes.
const abortStarted = new Promise(resolve => { abortRequestObserved = resolve; });
plannedTurns = [["call-pi-abort"], undefined];
const abortPrompt = agent.prompt("run abort canary");
await abortStarted;
agent.abort();
await abortPrompt;
assert.equal(gateCalls, 3, "abort still enters the real protected Pi gate once");
assert.equal(gateRequests.length, 3, "abort makes one bounded request before cancellation");
const abortTerminal = emittedToSession.find(event => event.type === "tool_execution_end" && event.toolCallId === "call-pi-abort");
assert.equal(abortTerminal?.toolCallId, "call-pi-abort");
assert.equal(abortTerminal?.isError, true);
assert.match(abortTerminal?.result?.content?.[0]?.text ?? "", /^Tool result withheld/);
rawCanaryAbsent(abortTerminal);

// Parallel tool ids keep their private accounting independent. Neither can
// inherit overflow/abort state from a completed neighbour, and both emit only
// their gateway-selected safe terminals.
plannedTurns = [["call-pi-concurrent-a", "call-pi-concurrent-b"], undefined];
await agent.prompt("run concurrent canary");
assert.equal(gateCalls, 5, "two concurrent protected calls each reach the gate");
assert.equal(gateRequests.length, 5, "concurrent calls submit isolated terminal requests");
const concurrentTerminal = emittedToSession.filter(event => event.type === "tool_execution_end").slice(-2);
assert.deepEqual(concurrentTerminal.map(event => event.toolCallId).sort(), ["call-pi-concurrent-a", "call-pi-concurrent-b"]);
assert.deepEqual(concurrentTerminal.map(event => event.result.content[0].text).sort(), [`${SAFE_CONTENT}:call-pi-concurrent-a`, `${SAFE_CONTENT}:call-pi-concurrent-b`]);
for (const value of [emittedToExtensions, emittedToSession, persisted, modelContexts, agent.state.messages]) rawCanaryAbsent(value);

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
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, BOBBIT_EP14_GENERATED_GATE: join(root, "generated-tool-result-gate.mjs") },
		});
		// Mirrors RpcBridge's private pre-RPC handoff. The patched loader consumes
		// this one record before loading any ordinary extension.
		child.stdin.end(JSON.stringify({ runtimeGeneration: 0, runtimeKey: "a".repeat(64) }) + "\n");
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
