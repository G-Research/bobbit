import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertToolResultGatePiCompatibility, generateToolResultFilterExtension } from "../../src/server/agent/tool-result-filter-extension.ts";

const sessionId = "ep14-extension-session";
const canary = "EP14_EXTENSION_RAW_CANARY_must_not_escape";
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

async function installGate(response: unknown): Promise<(event: unknown) => Promise<any>> {
	const temp = await mkdtemp(path.join(os.tmpdir(), "ep14-result-filter-extension-"));
	const file = path.join(temp, "gate.mjs");
	await writeFile(file, generateToolResultFilterExtension(sessionId), "utf8");
	process.env.BOBBIT_GATEWAY_URL = "http://gateway.test";
	process.env.BOBBIT_TOKEN = "test-token";
	globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } }));
	let gate: ((event: unknown) => Promise<any>) | undefined;
	const mod = await import(`${pathToFileURL(file).href}?${Date.now()}-${Math.random()}`);
	mod.default({ setToolResultGate(fn: (event: unknown) => Promise<any>) { gate = fn; } });
	await rm(temp, { recursive: true, force: true });
	if (!gate) throw new Error("EP14 extension did not install its Pi gate");
	return gate;
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
			readFile(path.join(root, "patches", "@earendil-works+pi-agent-core+0.82.1.patch"), "utf8"),
			readFile(path.join(root, "patches", "@earendil-works+pi-coding-agent+0.82.1.patch"), "utf8"),
		]);
		expect(agentCorePatch).toContain("afterResult.replaceResult === true");
		expect(agentCorePatch).toContain("replaceResult?: boolean");
		expect(codingAgentPatch).toContain("setToolResultGate");
		expect(codingAgentPatch).toContain("this._toolResultGate && event.type === \"tool_execution_update\"");
		expect(codingAgentPatch).toContain("replaceResult: true");
	});

	it("keeps a runtime compatibility guard for protected session setup", () => {
		expect(() => assertToolResultGatePiCompatibility({
			resolve: { paths: () => [] },
		} as unknown as NodeRequire)).toThrow("Tool-result filtering requires the patched Pi result-gate API.");
	});

	it("posts one complete bounded result and releases only the core-selected replacement", async () => {
		const safe = { content: [{ type: "text", text: "EP14_EXTENSION_SAFE" }], isError: false };
		const gate = await installGate(safe);
		const output = await gate({
			toolCallId: "call-1", toolName: "fixture-tool", isError: false,
			result: { content: [{ type: "text", text: canary }], details: { canary }, usage: { inputTokens: 1 } },
		});
		expect(output).toEqual(safe);
		const [url, init] = (globalThis.fetch as any).mock.calls[0];
		expect(url).toBe(`http://gateway.test/api/sessions/${sessionId}/tool-result-filter`);
		expect(JSON.parse(init.body)).toMatchObject({ toolCallId: "call-1", toolName: "fixture-tool", result: { content: [{ text: canary }] } });
	});

	it("preserves legitimate empty content and empty text results", async () => {
		const gate = await installGate({ content: [], isError: false });
		expect(await gate({ toolCallId: "call-empty", toolName: "fixture-tool", isError: false, result: { content: [] } })).toEqual({ content: [], isError: false });

		const textGate = await installGate({ content: [{ type: "text", text: "" }], isError: false });
		expect(await textGate({ toolCallId: "call-empty-text", toolName: "fixture-tool", isError: false, result: { content: [{ type: "text", text: "" }] } })).toEqual({ content: [{ type: "text", text: "" }], isError: false });
	});

	it("fails closed without forwarding malformed or over-cap raw results", async () => {
		const gate = await installGate({ content: [{ type: "text", text: canary }], isError: false, unexpected: true });
		const malformed = await gate({ toolCallId: "call-2", toolName: "fixture-tool", isError: false, result: { content: [{ type: "file", data: canary }] } });
		expect(malformed).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^Tool result withheld/) }] });
		expect(globalThis.fetch).not.toHaveBeenCalled();

		const oversized = await gate({ toolCallId: "call-3", toolName: "fixture-tool", isError: false, result: { content: [{ type: "text", text: "x".repeat(300 * 1024) }] } });
		expect(oversized).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^Tool result withheld/) }] });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("converts malformed gateway output and transport failure to the fixed synthetic result", async () => {
		const gate = await installGate({ content: [{ type: "text", text: canary }], isError: false, unexpected: true });
		const output = await gate({ toolCallId: "call-4", toolName: "fixture-tool", isError: false, result: { content: [{ type: "text", text: canary }] } });
		expect(output).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^Tool result withheld/) }] });
		expect(JSON.stringify(output)).not.toContain(canary);
	});
});
