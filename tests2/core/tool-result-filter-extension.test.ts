import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertToolResultGatePiCompatibility,
	generateToolResultFilterExtension,
	resetToolResultFilterExtensionCache,
	writeToolResultFilterExtension,
} from "../../src/server/agent/tool-result-filter-extension.ts";

const sessionId = "ep14-extension-session";
const canary = "EP14_EXTENSION_RAW_CANARY_must_not_escape";
const bootstrap = { runtimeGeneration: 0, runtimeKey: "1".repeat(64) };
let originalFetch: typeof globalThis.fetch;
let originalGatewayUrl: string | undefined;
let originalToken: string | undefined;

beforeEach(() => {
	// One test can install several gates. Snapshot the shared globals only once
	// so cleanup always restores the real pre-test values, not an earlier mock.
	originalFetch = globalThis.fetch;
	originalGatewayUrl = process.env.BOBBIT_GATEWAY_URL;
	originalToken = process.env.BOBBIT_TOKEN;
});

async function installGate(response: unknown): Promise<{ gate: (event: unknown) => Promise<any>; coreFetch: ReturnType<typeof vi.fn> }> {
	const temp = await mkdtemp(path.join(os.tmpdir(), "ep14-result-filter-extension-"));
	const file = path.join(temp, "gate.mjs");
	await writeFile(file, generateToolResultFilterExtension(sessionId), "utf8");
	process.env.BOBBIT_GATEWAY_URL = "http://gateway.test";
	process.env.BOBBIT_TOKEN = "test-token";
	// Construct before adversarial globals are installed; the captured fetch must
	// not require a later mutable Buffer/JSON helper to release its response.
	const gatewayResponse = new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
	const coreFetch = vi.fn(async () => gatewayResponse);
	globalThis.fetch = coreFetch as typeof globalThis.fetch;
	const mod = await import(`${pathToFileURL(file).href}?${Date.now()}-${Math.random()}`);
	const gate = mod.default(bootstrap);
	await rm(temp, { recursive: true, force: true });
	if (typeof gate !== "function") throw new Error("EP14 extension did not create its private Pi gate");
	return { gate, coreFetch };
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalGatewayUrl === undefined) delete process.env.BOBBIT_GATEWAY_URL;
	else process.env.BOBBIT_GATEWAY_URL = originalGatewayUrl;
	if (originalToken === undefined) delete process.env.BOBBIT_TOKEN;
	else process.env.BOBBIT_TOKEN = originalToken;
});

describe("generated tool-result filter Pi gate", () => {
	it("ships the authoritative Pi gate patches", async () => {
		// Do not inspect this worktree's node_modules: it can predate the patches.
		// These are the exact sources applied by postinstall for packed consumers.
		const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
		const [agentCorePatch, codingAgentPatch] = await Promise.all([
			readFile(path.join(root, "patches", "@earendil-works+pi-agent-core+0.84.1.patch"), "utf8"),
			readFile(path.join(root, "patches", "@earendil-works+pi-coding-agent+0.84.1.patch"), "utf8"),
		]);
		expect(agentCorePatch).toContain("gatedAfterResult.replaceResult === true");
		expect(agentCorePatch).toContain("signal?.aborted && config.__bobbitCoreToolResultGateMarker === __bobbitCoreToolResultGateMarker");
		expect(agentCorePatch).toContain("__bobbitCoreToolResultGateMarker");
		expect(agentCorePatch).toContain("MAX_PROTECTED_TOOL_UPDATE_BYTES");
		expect(agentCorePatch).toContain("const $protectedOwnDescriptor = Object.getOwnPropertyDescriptor;");
		expect(agentCorePatch).toContain("protectedSnapshotBytes(descriptor.value, seen)");
		expect(agentCorePatch).not.toContain("JSON.stringify");
		expect(agentCorePatch).not.toContain("toJSON");
		expect(agentCorePatch).toContain("replaceResult?: boolean");
		expect(codingAgentPatch).not.toContain("setToolResultGate");
		expect(codingAgentPatch).toContain("BOBBIT_TOOL_RESULT_FILTER_GATE");
		expect(codingAgentPatch).toContain("consumeCoreToolResultGateBootstrap");
		expect(codingAgentPatch).toContain("input.pause()");
		expect(codingAgentPatch).toContain("__bobbitCoreToolResultGate");
		expect(codingAgentPatch).toContain("__bobbitCoreToolResultGateActive");
		expect(codingAgentPatch).not.toContain("_toolResultGateState");
		expect(codingAgentPatch).not.toContain("event.type === \"tool_execution_update\"");
		expect(codingAgentPatch).toContain("signal?.aborted");
		expect(codingAgentPatch).not.toContain("$abort.call");
		expect(codingAgentPatch).toContain("replaceResult: true");
		const generatedGate = generateToolResultFilterExtension(sessionId);
		expect(generatedGate).not.toContain(bootstrap.runtimeKey);
		expect(generatedGate).not.toContain("const $runtimeKey =");
		expect(generatedGate).toContain("const $abortCall = $call.bind($abort);");
		expect(generatedGate).toContain("const $signalAddCall = $signalAdd ? $call.bind($signalAdd) : undefined;");
		expect(generatedGate).toContain("$abortCall(controller)");
		expect(generatedGate).toContain("$signalAddCall(inputSignal, \"abort\", abortRequest, { once: true })");
		expect(generatedGate).not.toContain("$abort.call");
		expect(generatedGate).not.toContain("$signalAdd.call");
	});

	it("keeps a runtime compatibility guard for protected session setup", () => {
		expect(() => assertToolResultGatePiCompatibility({
			resolve: { paths: () => [] },
		} as unknown as NodeRequire)).toThrow("Tool-result filtering requires the patched Pi result-gate API.");
	});

	it("uses POSIX-traversable mounted directories while retaining a read-only gate", { skip: process.platform === "win32" }, () => {
		const previousBobbitDir = process.env.BOBBIT_DIR;
		const bobbitDir = fs.mkdtempSync(path.join(os.tmpdir(), "ep14-result-filter-permissions-"));
		const mountRoot = path.join(bobbitDir, "state", "tool-result-filter");
		try {
			process.env.BOBBIT_DIR = bobbitDir;
			fs.mkdirSync(mountRoot, { recursive: true, mode: 0o700 });
			fs.chmodSync(mountRoot, 0o700);
			resetToolResultFilterExtensionCache();

			const gatePath = writeToolResultFilterExtension("sandbox-permissions");
			expect(gatePath).toBeDefined();
			expect(fs.statSync(mountRoot).mode & 0o777).toBe(0o755);
			expect(fs.statSync(path.dirname(gatePath!)).mode & 0o777).toBe(0o755);
			expect(fs.statSync(gatePath!).mode & 0o777).toBe(0o444);
			const mountedSource = fs.readFileSync(gatePath!, "utf8");
			expect(mountedSource).not.toContain(bootstrap.runtimeKey);
			expect(mountedSource).not.toContain("BOBBIT_TOOL_RESULT_FILTER_BOOTSTRAP");
		} finally {
			resetToolResultFilterExtensionCache();
			if (previousBobbitDir === undefined) delete process.env.BOBBIT_DIR;
			else process.env.BOBBIT_DIR = previousBobbitDir;
			fs.rmSync(bobbitDir, { recursive: true, force: true });
		}
	});

	it("posts one complete bounded result and releases only the core-selected replacement", async () => {
		const safe = { content: [{ type: "text", text: "EP14_EXTENSION_SAFE" }], isError: false };
		const { gate, coreFetch } = await installGate(safe);
		const output = await gate({
			toolCallId: "call-1", toolName: "fixture-tool", isError: false,
			result: { content: [{ type: "text", text: canary }], details: { canary }, usage: { inputTokens: 1 } },
		});
		expect(output).toEqual(safe);
		const [url, init] = coreFetch.mock.calls[0];
		expect(url).toBe(`http://gateway.test/api/sessions/${sessionId}/tool-result-filter`);
		expect(JSON.parse(init.body)).toMatchObject({ toolCallId: "call-1", toolName: "fixture-tool", result: { content: [{ text: canary }], isError: false } });
		expect(new Headers(init.headers).get("X-Bobbit-Tool-Result-Attempt")).toMatch(/^v1\.[0-9a-z]+\.[0-9a-f-]{36}\.[0-9a-f]{64}$/);
	});

	it("encodes canonical request data without inherited toJSON observation", async () => {
		const safe = { content: [{ type: "text", text: "EP14_EXTENSION_SAFE" }], isError: false };
		const { gate, coreFetch } = await installGate(safe);
		const originals = {
			objectToJSON: Object.getOwnPropertyDescriptor(Object.prototype, "toJSON"),
			arrayToJSON: Object.getOwnPropertyDescriptor(Array.prototype, "toJSON"),
		};
		const objectToJSON = vi.fn();
		const arrayToJSON = vi.fn();
		let output: unknown;
		try {
			Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: objectToJSON });
			Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: arrayToJSON });
			output = await gate({
				toolCallId: "call-no-to-json", toolName: "fixture-tool", isError: false,
				result: { content: [{ type: "text", text: canary }], details: { canary }, usage: { inputTokens: 1 } },
			});
		} finally {
			if (originals.objectToJSON) Object.defineProperty(Object.prototype, "toJSON", originals.objectToJSON);
			else delete (Object.prototype as { toJSON?: unknown }).toJSON;
			if (originals.arrayToJSON) Object.defineProperty(Array.prototype, "toJSON", originals.arrayToJSON);
			else delete (Array.prototype as { toJSON?: unknown }).toJSON;
		}
		expect(output).toEqual(safe);
		expect(objectToJSON).not.toHaveBeenCalled();
		expect(arrayToJSON).not.toHaveBeenCalled();
		expect(coreFetch).toHaveBeenCalledTimes(1);
		expect(JSON.parse(coreFetch.mock.calls[0][1].body)).toMatchObject({
			toolCallId: "call-no-to-json", result: { content: [{ text: canary }], isError: false },
		});
	});

	it("rehydrates a validated gateway result into ordinary Pi containers without inherited setters", async () => {
		const safe = {
			content: [{ type: "text", text: "EP14_EXTENSION_SAFE" }],
			details: { nested: ["safe"] }, usage: { inputTokens: 1 }, isError: false,
		};
		const { gate } = await installGate(safe);
		const originalDefineProperty = Object.defineProperty;
		const descriptors = Object.fromEntries(["content", "details", "isError", "usage", "nested"].map(name => [name, Object.getOwnPropertyDescriptor(Object.prototype, name)]));
		const setter = vi.fn();
		let output: any;
		try {
			for (const name of Object.keys(descriptors)) originalDefineProperty(Object.prototype, name, { configurable: true, set: setter });
			Object.defineProperty = (() => { throw new Error("late defineProperty lookup"); }) as typeof Object.defineProperty;
			output = await gate({ toolCallId: "call-ordinary", toolName: "fixture-tool", isError: false, result: { content: [{ type: "text", text: canary }] } });
		} finally {
			Object.defineProperty = originalDefineProperty;
			for (const [name, descriptor] of Object.entries(descriptors)) {
				if (descriptor) originalDefineProperty(Object.prototype, name, descriptor);
				else delete (Object.prototype as Record<string, unknown>)[name];
			}
		}
		expect(setter).not.toHaveBeenCalled();
		expect(output).toEqual(safe);
		expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(output.content)).toBe(Array.prototype);
		expect(output.content.map).toBe(Array.prototype.map);
		expect(Object.getPrototypeOf(output.content[0])).toBe(Object.prototype);
		expect(Object.getPrototypeOf(output.details)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(output.details.nested)).toBe(Array.prototype);
		expect(Object.getPrototypeOf(output.usage)).toBe(Object.prototype);
	});

	it("preserves legitimate empty content and empty text results", async () => {
		const { gate } = await installGate({ content: [], isError: false });
		expect(await gate({ toolCallId: "call-empty", toolName: "fixture-tool", isError: false, result: { content: [] } })).toEqual({ content: [], isError: false });

		const { gate: textGate } = await installGate({ content: [{ type: "text", text: "" }], isError: false });
		expect(await textGate({ toolCallId: "call-empty-text", toolName: "fixture-tool", isError: false, result: { content: [{ type: "text", text: "" }] } })).toEqual({ content: [{ type: "text", text: "" }], isError: false });
	});

	it("fails closed without forwarding malformed or over-cap raw results", async () => {
		const { gate, coreFetch } = await installGate({ content: [{ type: "text", text: canary }], isError: false, unexpected: true });
		const malformed = await gate({ toolCallId: "call-2", toolName: "fixture-tool", isError: false, result: { content: [{ type: "file", data: canary }] } });
		expect(malformed).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^Tool result withheld/) }] });
		expect(coreFetch).not.toHaveBeenCalled();

		const oversized = await gate({ toolCallId: "call-3", toolName: "fixture-tool", isError: false, result: { content: [{ type: "text", text: "x".repeat(300 * 1024) }] } });
		expect(oversized).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^Tool result withheld/) }] });
		expect(coreFetch).not.toHaveBeenCalled();
	});

	it("converts malformed gateway output and transport failure to the fixed synthetic result", async () => {
		const { gate } = await installGate({ content: [{ type: "text", text: canary }], isError: false, unexpected: true });
		const output = await gate({ toolCallId: "call-4", toolName: "fixture-tool", isError: false, result: { content: [{ type: "text", text: canary }] } });
		expect(output).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^Tool result withheld/) }] });
		expect(JSON.stringify(output)).not.toContain(canary);
	});

	it("cancels before transport and never releases the private terminal value", async () => {
		const { gate, coreFetch } = await installGate({ content: [{ type: "text", text: canary }], isError: false });
		const controller = new AbortController();
		controller.abort();
		const output = await gate({ toolCallId: "call-aborted", toolName: "fixture-tool", signal: controller.signal, isError: false, result: { content: [{ type: "text", text: canary }] } });
		expect(output).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^Tool result withheld/) }] });
		expect(JSON.stringify(output)).not.toContain(canary);
		expect(coreFetch).not.toHaveBeenCalled();
	});

	it("seals transport before an ordinary extension can monkeypatch global fetch", async () => {
		const safe = { content: [{ type: "text", text: "EP14_EXTENSION_SAFE" }], isError: false };
		const { gate, coreFetch } = await installGate(safe);
		const hostileFetch = vi.fn(() => { throw new Error("ordinary extension observed request"); });
		globalThis.fetch = hostileFetch as typeof globalThis.fetch;
		await expect(gate({ toolCallId: "call-sealed", toolName: "fixture-tool", isError: false, result: { content: [{ type: "text", text: canary }] } })).resolves.toEqual(safe);
		expect(coreFetch).toHaveBeenCalledTimes(1);
		expect(hostileFetch).not.toHaveBeenCalled();
	});

	it("never resolves mutable intrinsics, accessors, or prototypes over raw input", async () => {
		const safe = { content: [{ type: "text", text: "EP14_EXTENSION_SAFE" }], isError: false };
		const { gate, coreFetch } = await installGate(safe);
		const originals = {
			stringify: JSON.stringify, byteLength: Buffer.byteLength,
			keys: Object.keys, getPrototypeOf: Object.getPrototypeOf, getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
			getOwnPropertyNames: Object.getOwnPropertyNames, getOwnPropertySymbols: Object.getOwnPropertySymbols,
			create: Object.create, setPrototypeOf: Object.setPrototypeOf,
			every: Array.prototype.every, sort: Array.prototype.sort, includes: Array.prototype.includes,
			objectToJSON: Object.getOwnPropertyDescriptor(Object.prototype, "toJSON"),
			arrayToJSON: Object.getOwnPropertyDescriptor(Array.prototype, "toJSON"),
			inheritedDetails: Object.getOwnPropertyDescriptor(Object.prototype, "details"),
		};
		const spies = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
		let output: unknown;
		try {
			JSON.stringify = spies[0] as typeof JSON.stringify;
			Buffer.byteLength = spies[1] as typeof Buffer.byteLength;
			Object.keys = spies[2] as typeof Object.keys;
			Object.getPrototypeOf = spies[3] as typeof Object.getPrototypeOf;
			Object.getOwnPropertyDescriptor = spies[4] as typeof Object.getOwnPropertyDescriptor;
			Object.getOwnPropertyNames = spies[5] as typeof Object.getOwnPropertyNames;
			Object.getOwnPropertySymbols = spies[6] as typeof Object.getOwnPropertySymbols;
			Object.create = spies[7] as typeof Object.create;
			Object.setPrototypeOf = spies[8] as typeof Object.setPrototypeOf;
			Array.prototype.every = spies[9] as unknown as typeof Array.prototype.every;
			Array.prototype.sort = spies[10] as typeof Array.prototype.sort;
			Array.prototype.includes = spies[11] as typeof Array.prototype.includes;
			Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: spies[12] });
			Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: spies[12] });
			Object.defineProperty(Object.prototype, "details", { configurable: true, get: spies[13] });

			// Deliberately omit an own details field: an inherited accessor is a raw
			// exfiltration sink for the former direct-property implementation.
			output = await gate({ toolCallId: "call-intrinsics", toolName: "fixture-tool", isError: false, result: { content: [{ type: "text", text: canary }] } });
		} finally {
			JSON.stringify = originals.stringify;
			Buffer.byteLength = originals.byteLength;
			Object.keys = originals.keys;
			Object.getPrototypeOf = originals.getPrototypeOf;
			Object.getOwnPropertyDescriptor = originals.getOwnPropertyDescriptor;
			Object.getOwnPropertyNames = originals.getOwnPropertyNames;
			Object.getOwnPropertySymbols = originals.getOwnPropertySymbols;
			Object.create = originals.create;
			Object.setPrototypeOf = originals.setPrototypeOf;
			Array.prototype.every = originals.every;
			Array.prototype.sort = originals.sort;
			Array.prototype.includes = originals.includes;
			if (originals.objectToJSON) Object.defineProperty(Object.prototype, "toJSON", originals.objectToJSON);
			else delete (Object.prototype as { toJSON?: unknown }).toJSON;
			if (originals.arrayToJSON) Object.defineProperty(Array.prototype, "toJSON", originals.arrayToJSON);
			else delete (Array.prototype as { toJSON?: unknown }).toJSON;
			if (originals.inheritedDetails) Object.defineProperty(Object.prototype, "details", originals.inheritedDetails);
			else delete (Object.prototype as { details?: unknown }).details;
		}
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		expect(output).toEqual(safe);
		expect(coreFetch).toHaveBeenCalledTimes(1);
	});
});
