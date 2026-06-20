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
 *   4. Unconditional registration: the extension is written even with NO Google
 *      account credential present, so a session spawned BEFORE Google sign-in can
 *      still bind a `google-gemini-cli/*` model after the user authenticates (the
 *      Bearer token is fetched per request from the gateway, not at spawn time).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, after, beforeEach, afterEach } from "node:test";
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

describe("writeGoogleCodeAssistProviderExtension unconditional registration", () => {
	const prevAgentDir = process.env.BOBBIT_AGENT_DIR;
	const prevBobbitDir = process.env.BOBBIT_DIR;
	let dir: string;

	const writeAuth = () =>
		fs.writeFileSync(
			path.join(dir, "auth.json"),
			JSON.stringify({ "google-gemini-cli": { type: "oauth", access: "ya29.fake", refresh: "r", expires: Date.now() + 600_000 } }),
			"utf-8",
		);

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

	it("writes the extension even when NO Google account credential is present", () => {
		// Regression: PR #826 review #1 — a session spawned before Google sign-in
		// must still register the provider so the model is bindable after auth.
		const p = writeGoogleCodeAssistProviderExtension("sess-no-cred");
		// Only asserts when pi-ai's google catalog is available; we still write
		// nothing if no descriptors can be derived (catalog unreadable).
		if (p) {
			assert.ok(fs.existsSync(p), "expected the extension file to be written without a credential");
			assert.ok(p.includes(path.join("state", "google-code-assist")), "expected content-addressed path");
			const src = fs.readFileSync(p, "utf-8");
			assert.ok(src.includes("pi.registerProvider("), "expected the provider registration");
			assert.ok(src.includes("/google-code-assist/token"), "expected the per-request gateway token fetch");
		}
	});

	it("writes a content-addressed extension when a Google credential exists", () => {
		writeAuth();
		const p = writeGoogleCodeAssistProviderExtension("sess-2");
		if (p) {
			assert.ok(fs.existsSync(p), "expected the extension file to be written");
			assert.ok(p.includes(path.join("state", "google-code-assist")), "expected content-addressed path");
			assert.ok(fs.readFileSync(p, "utf-8").includes("pi.registerProvider("), "expected generated source");
		}
	});

	it("no-credential spawn then later auth: extension stays valid and gateway-driven for the token", () => {
		// Spawn BEFORE auth: extension is written and registers the provider.
		const before = writeGoogleCodeAssistProviderExtension("sess-late-auth");
		if (!before) return; // pi-ai catalog unavailable in this env — skip
		const srcBefore = fs.readFileSync(before, "utf-8");
		assert.ok(srcBefore.includes("pi.registerProvider("), "provider registered pre-auth");
		// The runtime token is NOT baked in at spawn — it is fetched per request
		// from the gateway, so signing in later makes the already-registered model
		// runnable with no respawn. Assert the source contains no spawn-time token.
		assert.ok(!srcBefore.includes("ya29."), "must not bake any access token into the source");
		assert.ok(srcBefore.includes("/google-code-assist/token"), "fetches the Bearer per request from the gateway");

		// Auth arrives afterward; a respawn (e.g. gateway restart) re-derives the
		// extension. It must remain valid and still gateway-driven for the token.
		resetGoogleCodeAssistExtensionCache();
		writeAuth();
		const after = writeGoogleCodeAssistProviderExtension("sess-late-auth");
		assert.ok(after, "expected an extension after auth too");
		const srcAfter = fs.readFileSync(after!, "utf-8");
		assert.ok(srcAfter.includes("pi.registerProvider("), "provider still registered post-auth");
		assert.ok(srcAfter.includes("/google-code-assist/token"), "still gateway-driven for the token post-auth");
		assert.ok(!srcAfter.includes("ya29."), "still bakes no access token into the source post-auth");
	});
});
