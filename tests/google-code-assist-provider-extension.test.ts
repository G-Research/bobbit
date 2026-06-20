/**
 * Unit tests for the Google Code Assist provider-extension codegen.
 *
 * The generated extension registers a first-class `google-code-assist` api
 * provider INSIDE the spawned pi-coding-agent process via
 * `ExtensionAPI.registerProvider()` with a custom `streamSimple` handler, so
 * `google-gemini-cli/*` models become runnable session models. These tests pin:
 *
 *   1. Codegen string shape — provider/api/baseUrl constants, the per-request
 *      gateway token-endpoint call, gateway URL/token reads with state-file
 *      fallback, abort/timeout wiring, SSE parsing, and the registerProvider call.
 *   2. The generated source parses, transpiles with no errors, and default-exports
 *      a function (the extension factory).
 *   3. No process-wide TLS downgrade (security invariant shared with the bridge).
 *   4. The credential gate: nothing is written when no Google account credential
 *      is present (zero overhead for non-Google users).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

import {
	CODE_ASSIST_PROVIDER_BASE_URL,
	generateGoogleCodeAssistProviderExtension,
	writeGoogleCodeAssistProviderExtension,
	resetGoogleCodeAssistExtensionCache,
	type CodeAssistModelDescriptor,
} from "../src/server/agent/google-code-assist-provider-extension.ts";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gca-ext-"));

after(() => {
	try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
});

const sampleModels: CodeAssistModelDescriptor[] = [
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro (Google account)",
		api: "google-code-assist",
		baseUrl: CODE_ASSIST_PROVIDER_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	},
];

describe("generateGoogleCodeAssistProviderExtension", () => {
	const source = generateGoogleCodeAssistProviderExtension("sess-xyz", sampleModels);

	it("imports the pi-ai event-stream factory (same module instance as the turn loop)", () => {
		assert.ok(
			source.includes('createAssistantMessageEventStream') && source.includes('@earendil-works/pi-ai'),
			"expected createAssistantMessageEventStream import from @earendil-works/pi-ai",
		);
	});

	it("registers the google-code-assist provider with a streamSimple handler", () => {
		assert.ok(source.includes("pi.registerProvider("), "expected pi.registerProvider call");
		assert.ok(source.includes('"google-gemini-cli"'), "expected provider id");
		assert.ok(source.includes('"google-code-assist"'), "expected api discriminator");
		assert.ok(source.includes("streamSimple:"), "expected a streamSimple handler field");
		assert.ok(source.includes(CODE_ASSIST_PROVIDER_BASE_URL), "expected the Code Assist baseUrl");
	});

	it("embeds the session id and the registered models", () => {
		assert.ok(source.includes('"sess-xyz"'), "expected session id baked into source");
		assert.ok(source.includes('"gemini-2.5-pro"'), "expected the model id in the embedded models[]");
	});

	it("calls the gateway token endpoint for a fresh Bearer + project", () => {
		assert.ok(
			source.includes("/google-code-assist/token"),
			"expected GET /api/sessions/:id/google-code-assist/token call",
		);
		assert.ok(source.includes("BOBBIT_GATEWAY_URL"), "expected BOBBIT_GATEWAY_URL env read");
		assert.ok(source.includes("BOBBIT_TOKEN"), "expected BOBBIT_TOKEN env read");
		assert.ok(source.includes('"gateway-url"'), "expected gateway-url state-file fallback");
		assert.ok(source.includes('"token"'), "expected token state-file fallback");
	});

	it("falls back to GOOGLE_CLOUD_ACCESS_TOKEN / project env for offline sandboxes", () => {
		assert.ok(source.includes("GOOGLE_CLOUD_ACCESS_TOKEN"), "expected env token fallback");
		assert.ok(source.includes("GOOGLE_CLOUD_PROJECT"), "expected project env selection");
	});

	it("streams Code Assist SSE and honors abort + timeout", () => {
		assert.ok(source.includes(":streamGenerateContent?alt=sse"), "expected the SSE streaming endpoint");
		assert.ok(source.includes("AbortController"), "expected an AbortController for abort/timeout");
		assert.ok(source.includes("timeoutMs"), "expected timeoutMs handling");
		assert.ok(source.includes('options.signal'), "expected to read options.signal");
	});

	it("emits the pi assistant-message event protocol", () => {
		for (const ev of ["start", "text_delta", "thinking_delta", "toolcall_end", "done", "error"]) {
			assert.ok(source.includes(`"${ev}"`), `expected a '${ev}' event`);
		}
	});

	it("maps tool calls and tool results (functionCall / functionResponse)", () => {
		assert.ok(source.includes("functionCall"), "expected functionCall handling");
		assert.ok(source.includes("functionResponse"), "expected functionResponse mapping");
		assert.ok(source.includes("functionDeclarations"), "expected tool declaration conversion");
	});

	it("forwards maxTokens to generationConfig.maxOutputTokens and toolChoice to functionCallingConfig.mode", () => {
		assert.ok(source.includes("options.maxTokens"), "expected options.maxTokens to be read");
		assert.ok(source.includes("maxOutputTokens"), "expected generationConfig.maxOutputTokens mapping");
		assert.ok(source.includes("toolChoiceMode"), "expected a toolChoice → mode mapper");
		assert.ok(source.includes("functionCallingConfig"), "expected toolConfig.functionCallingConfig");
	});

	it("does NOT downgrade TLS verification process-wide", () => {
		assert.ok(
			!source.includes("NODE_TLS_REJECT_UNAUTHORIZED"),
			"generated source must not touch NODE_TLS_REJECT_UNAUTHORIZED",
		);
	});

	it("emits no TypeScript error diagnostics", () => {
		const transpiled = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
			reportDiagnostics: true,
		});
		const errors = (transpiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
		const msg = errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n");
		assert.equal(errors.length, 0, `Expected no error diagnostics, got:\n${msg}`);
	});

	it("transpiled module loads and default-exports a factory function", async () => {
		const transpiled = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
		});
		// Stub the bare pi-ai import so the CommonJS module can be required.
		const stubDir = path.join(tmpDir, "node_modules", "@earendil-works", "pi-ai");
		fs.mkdirSync(stubDir, { recursive: true });
		fs.writeFileSync(
			path.join(stubDir, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.0.0", main: "index.js" }),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(stubDir, "index.js"),
			"exports.createAssistantMessageEventStream = () => ({ push() {}, end() {} });\n",
			"utf-8",
		);
		const file = path.join(tmpDir, "gca-provider.cjs");
		fs.writeFileSync(file, transpiled.outputText, "utf-8");
		const mod = await import(pathToFileURL(file).href);
		assert.equal(typeof mod.default, "function");

		// The factory must call registerProvider on the supplied pi object.
		let registered: { name?: string; config?: any } = {};
		mod.default({ registerProvider: (name: string, config: any) => { registered = { name, config }; } });
		assert.equal(registered.name, "google-gemini-cli");
		assert.equal(registered.config.api, "google-code-assist");
		assert.equal(typeof registered.config.streamSimple, "function");
		assert.ok(Array.isArray(registered.config.models) && registered.config.models.length === 1);
	});
});

describe("convertContext request mapping (maxTokens / toolChoice)", () => {
	// Drive the generated streamSimple handler end-to-end with a stubbed fetch so
	// we can inspect the actual Code Assist request body it produces. This proves
	// convertContext forwards options.maxTokens and options.toolChoice, not just
	// that the source string mentions them.
	const prevFetch = globalThis.fetch;
	const prevGwUrl = process.env.BOBBIT_GATEWAY_URL;
	const prevGwTok = process.env.BOBBIT_TOKEN;
	let streamSimple: (model: any, context: any, options: any) => any;
	let captured: { body?: any };
	let modDir: string;

	before(async () => {
		modDir = fs.mkdtempSync(path.join(os.tmpdir(), "gca-conv-"));
		// gwUrl/gwToken are read at module-import time from these env vars.
		process.env.BOBBIT_GATEWAY_URL = "http://gw.test";
		process.env.BOBBIT_TOKEN = "gw-token";

		// pi-ai stub: a stream whose push/end forward to global hooks so the test
		// can await completion of the async streamSimple body.
		const stubDir = path.join(modDir, "node_modules", "@earendil-works", "pi-ai");
		fs.mkdirSync(stubDir, { recursive: true });
		fs.writeFileSync(
			path.join(stubDir, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.0.0", main: "index.js" }),
			"utf-8",
		);
		fs.writeFileSync(
			path.join(stubDir, "index.js"),
			"exports.createAssistantMessageEventStream = () => ({ push() {}, end() { if (globalThis.__gcaOnEnd) globalThis.__gcaOnEnd(); } });\n",
			"utf-8",
		);

		const src = generateGoogleCodeAssistProviderExtension("sess-conv", sampleModels);
		const transpiled = ts.transpileModule(src, {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
		});
		const file = path.join(modDir, "gca-conv.cjs");
		fs.writeFileSync(file, transpiled.outputText, "utf-8");
		const mod = await import(pathToFileURL(file).href);
		let config: any = {};
		mod.default({ registerProvider: (_name: string, c: any) => { config = c; } });
		streamSimple = config.streamSimple;
	});

	after(() => {
		globalThis.fetch = prevFetch;
		if (prevGwUrl === undefined) delete process.env.BOBBIT_GATEWAY_URL;
		else process.env.BOBBIT_GATEWAY_URL = prevGwUrl;
		if (prevGwTok === undefined) delete process.env.BOBBIT_TOKEN;
		else process.env.BOBBIT_TOKEN = prevGwTok;
		try { fs.rmSync(modDir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	/** Run one streamSimple turn and return the request body it POSTed. */
	async function run(options: any): Promise<any> {
		captured = {};
		globalThis.fetch = (async (url: any, init: any) => {
			const u = String(url);
			if (u.includes("/google-code-assist/token")) {
				return { status: 200, ok: true, json: async () => ({ token: "tok", project: "proj" }) } as any;
			}
			captured.body = JSON.parse(init.body);
			// No streaming body → handler falls back to res.text() SSE parsing.
			return {
				ok: true,
				status: 200,
				body: undefined,
				text: async () =>
					'data: {"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"hi"}]}}]}\n',
			} as any;
		}) as any;

		const done = new Promise<void>((resolve) => { (globalThis as any).__gcaOnEnd = resolve; });
		const model = { id: "gemini-2.5-pro", provider: "google-gemini-cli", input: ["text"], cost: {} };
		const context = { messages: [{ role: "user", content: "hello" }], tools: [{ name: "t", description: "d", parameters: { type: "object" } }] };
		streamSimple(model, context, options);
		await done;
		delete (globalThis as any).__gcaOnEnd;
		return captured.body;
	}

	it("forwards options.maxTokens to request.generationConfig.maxOutputTokens", async () => {
		const body = await run({ maxTokens: 1234 });
		assert.equal(body.request.generationConfig.maxOutputTokens, 1234);
	});

	it("omits maxOutputTokens when maxTokens is absent or non-positive", async () => {
		const body = await run({});
		assert.ok(!body.request.generationConfig || body.request.generationConfig.maxOutputTokens === undefined);
		const body2 = await run({ maxTokens: 0 });
		assert.ok(!body2.request.generationConfig || body2.request.generationConfig.maxOutputTokens === undefined);
	});

	it("maps options.toolChoice to request.toolConfig.functionCallingConfig.mode", async () => {
		for (const [choice, mode] of [["auto", "AUTO"], ["any", "ANY"], ["none", "NONE"]] as const) {
			const body = await run({ toolChoice: choice });
			assert.equal(body.request.toolConfig.functionCallingConfig.mode, mode, `toolChoice ${choice}`);
		}
	});

	it("omits toolConfig when toolChoice is absent", async () => {
		const body = await run({});
		assert.equal(body.request.toolConfig, undefined);
	});

	it("does not set toolConfig when there are no tools (mirrors server helper)", async () => {
		captured = {};
		globalThis.fetch = (async (url: any, init: any) => {
			const u = String(url);
			if (u.includes("/google-code-assist/token")) {
				return { status: 200, ok: true, json: async () => ({ token: "tok", project: "proj" }) } as any;
			}
			captured.body = JSON.parse(init.body);
			return { ok: true, status: 200, body: undefined, text: async () => 'data: {"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"hi"}]}}]}\n' } as any;
		}) as any;
		const done = new Promise<void>((resolve) => { (globalThis as any).__gcaOnEnd = resolve; });
		const model = { id: "gemini-2.5-pro", provider: "google-gemini-cli", input: ["text"], cost: {} };
		streamSimple(model, { messages: [{ role: "user", content: "hi" }] }, { toolChoice: "auto" });
		await done;
		delete (globalThis as any).__gcaOnEnd;
		assert.equal(captured.body.request.toolConfig, undefined);
		assert.equal(captured.body.request.tools, undefined);
	});
});

describe("writeGoogleCodeAssistProviderExtension credential gate", () => {
	const prevAgentDir = process.env.BOBBIT_AGENT_DIR;
	const prevBobbitDir = process.env.BOBBIT_DIR;
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "gca-gate-"));
		process.env.BOBBIT_AGENT_DIR = dir;
		process.env.BOBBIT_DIR = dir;
		resetGoogleCodeAssistExtensionCache();
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
		else process.env.BOBBIT_AGENT_DIR = prevAgentDir;
		if (prevBobbitDir === undefined) delete process.env.BOBBIT_DIR;
		else process.env.BOBBIT_DIR = prevBobbitDir;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("returns undefined (writes nothing) when no Google account credential is present", () => {
		assert.equal(writeGoogleCodeAssistProviderExtension("sess-1"), undefined);
		assert.ok(!fs.existsSync(path.join(dir, "state", "google-code-assist")), "must not create the extension dir");
	});

	it("writes a content-addressed extension when a Google credential exists", () => {
		fs.writeFileSync(
			path.join(dir, "auth.json"),
			JSON.stringify({ "google-gemini-cli": { type: "oauth", access: "ya29.fake", refresh: "r", expires: Date.now() + 600_000 } }),
			"utf-8",
		);
		const p = writeGoogleCodeAssistProviderExtension("sess-2");
		// Only asserts when the underlying pi-ai catalog is available; getGoogleCodeAssistModels
		// returns [] (and we write nothing) if pi-ai's google catalog can't be read.
		if (p) {
			assert.ok(fs.existsSync(p), "expected the extension file to be written");
			assert.ok(p.includes(path.join("state", "google-code-assist")), "expected content-addressed path");
			assert.ok(fs.readFileSync(p, "utf-8").includes("pi.registerProvider("), "expected generated source");
		}
	});
});
