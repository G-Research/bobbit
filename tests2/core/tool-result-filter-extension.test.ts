import { pathToFileURL } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateToolResultFilterExtension } from "../../src/server/agent/tool-result-filter-extension.ts";

const sessionId = "ep14-extension-session";
const canary = "EP14_EXTENSION_RAW_CANARY_must_not_escape";
let restoreFetch: typeof globalThis.fetch | undefined;
let priorUrl: string | undefined;
let priorToken: string | undefined;

async function installGate(response: unknown): Promise<(event: unknown) => Promise<any>> {
	const temp = await mkdtemp(path.join(os.tmpdir(), "ep14-result-filter-extension-"));
	const file = path.join(temp, "gate.mjs");
	await writeFile(file, generateToolResultFilterExtension(sessionId), "utf8");
	priorUrl = process.env.BOBBIT_GATEWAY_URL;
	priorToken = process.env.BOBBIT_TOKEN;
	process.env.BOBBIT_GATEWAY_URL = "http://gateway.test";
	process.env.BOBBIT_TOKEN = "test-token";
	restoreFetch = globalThis.fetch;
	globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } }));
	let gate: ((event: unknown) => Promise<any>) | undefined;
	const mod = await import(`${pathToFileURL(file).href}?${Date.now()}-${Math.random()}`);
	mod.default({ setToolResultGate(fn: (event: unknown) => Promise<any>) { gate = fn; } });
	await rm(temp, { recursive: true, force: true });
	if (!gate) throw new Error("EP14 extension did not install its Pi gate");
	return gate;
}

afterEach(() => {
	if (restoreFetch) globalThis.fetch = restoreFetch;
	restoreFetch = undefined;
	if (priorUrl === undefined) delete process.env.BOBBIT_GATEWAY_URL;
	else process.env.BOBBIT_GATEWAY_URL = priorUrl;
	if (priorToken === undefined) delete process.env.BOBBIT_TOKEN;
	else process.env.BOBBIT_TOKEN = priorToken;
	priorUrl = undefined;
	priorToken = undefined;
});

describe("generated tool-result filter Pi gate", () => {
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
