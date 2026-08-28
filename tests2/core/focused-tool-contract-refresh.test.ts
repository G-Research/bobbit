// v2-native — focused runtime contract regression. Discovered from its `tests2/core` path.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as Value from "typebox/value";
import { afterEach, describe, it } from "vitest";

import agentExtension from "../../defaults/tools/agent/extension.ts";
import bobbitExtension from "../../defaults/tools/bobbit/extension.ts";
import { registerRpcBridgeFactory } from "../../src/server/agent/rpc-bridge.ts";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import { initPromptDirs } from "../../src/server/agent/system-prompt.ts";
import { ToolManager, __resetToolScanCache } from "../../src/server/agent/tool-manager.ts";
import { readAgentTranscript, TranscriptReaderError } from "../../src/server/agent/transcript-reader.ts";
import { generateToolResultErrorBridgeExtension } from "../../src/server/agent/tool-result-error-bridge-extension.ts";
import { loadBobbitTools } from "./helpers/bobbit-harness.ts";
import { guardProcessEnv } from "./helpers/env-guard.ts";

guardProcessEnv();

const roots: string[] = [];
const managers: any[] = [];

// Exact PR #1016 shipped snapshot, compressed to keep this focused fixture small.
// Production recognizes its canonical seven-file byte manifest, not this encoding.
const HISTORICAL_AGENT_SNAPSHOT = [
	"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",
].join("");

function writeHistoricalAgentSnapshot(groupDir: string): void {
	const files = JSON.parse(gunzipSync(Buffer.from(HISTORICAL_AGENT_SNAPSHOT, "base64")).toString("utf8")) as Record<string, string>;
	fs.mkdirSync(groupDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(groupDir, name), Buffer.from(content, "base64"));
	}
	const sharedDir = path.join(path.dirname(groupDir), "_shared");
	fs.mkdirSync(sharedDir, { recursive: true });
	fs.writeFileSync(path.join(sharedDir, "context-heavy-guard.js"), "export function contextHeavyLimitError() {}\n");
}

function writeDefinition(file: string, params: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, [
		"name: bobbit_read",
		"description: Read gateway state",
		"summary: Read gateway state",
		`params: [${params}]`,
		"provider:",
		"  type: bobbit-extension",
		"  extension: extension.ts",
		"group: Bobbit",
		"",
	].join("\n"), "utf8");
}

function restoreDirectoryTimes(dir: string, stat: fs.Stats): void {
	fs.utimesSync(dir, stat.atime, stat.mtime);
}

afterEach(() => {
	registerRpcBridgeFactory(null);
	__resetToolScanCache();
	for (const manager of managers.splice(0)) {
		if (manager._statusHeartbeatTimer) clearInterval(manager._statusHeartbeatTimer);
		manager.sessions?.clear?.();
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("focused tool contract refresh", () => {
	it("invalidates warmed prompt docs when a nested tool YAML contract changes", () => {
		process.env.BOBBIT_TOKEN = "focused-contract-token";
		process.env.BOBBIT_GATEWAY_URL = "https://focused-contract.invalid";
		const runtimeSchema = loadBobbitTools().get("bobbit_read")!.parameters;
		assert.equal(Value.Check(runtimeSchema, { operation: "health" }), true);
		assert.equal(Value.Check(runtimeSchema, { operation: "health", verbose: true }), false);

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "focused-tool-contract-"));
		roots.push(root);
		const configDir = path.join(root, "config");
		const toolsDir = path.join(configDir, "tools");
		const builtinToolsDir = path.join(root, "defaults", "tools");
		const bobbitDir = path.join(builtinToolsDir, "bobbit");
		const definition = path.join(bobbitDir, "bobbit_read.yaml");
		fs.mkdirSync(toolsDir, { recursive: true });
		writeDefinition(definition, "operation, verbose?");
		const stableDirectoryTime = new Date("2020-01-02T03:04:05.000Z");
		fs.utimesSync(bobbitDir, stableDirectoryTime, stableDirectoryTime);
		fs.utimesSync(builtinToolsDir, stableDirectoryTime, stableDirectoryTime);

		__resetToolScanCache();
		const warmManager = new ToolManager(configDir, builtinToolsDir);
		const staleDocs = warmManager.getToolDocsForPrompt(["bobbit_read"]);
		assert.match(staleDocs, /bobbit_read\(operation, verbose\?\)/);

		const rootStat = fs.statSync(builtinToolsDir);
		const groupStat = fs.statSync(bobbitDir);
		writeDefinition(definition, "operation, goalId?");
		// A nested file replacement does not reliably change either parent directory
		// timestamp (and coarse filesystems can preserve it). Reproduce that upgrade
		// boundary explicitly while leaving the nested file's own metadata current.
		restoreDirectoryTimes(bobbitDir, groupStat);
		restoreDirectoryTimes(builtinToolsDir, rootStat);
		assert.equal(fs.statSync(bobbitDir).mtimeMs, groupStat.mtimeMs);
		assert.equal(fs.statSync(builtinToolsDir).mtimeMs, rootStat.mtimeMs);

		// Session refresh/reattach constructs a new manager in the same server process;
		// the process-wide scan cache must not preserve the old injected contract.
		const refreshedManager = new ToolManager(configDir, builtinToolsDir);
		const refreshedDocs = refreshedManager.getToolDocsForPrompt(["bobbit_read"]);
		assert.match(
			refreshedDocs,
			/bobbit_read\(operation, goalId\?\)/,
			"FOCUSED_TOOL_CONTRACT_CACHE_STALE: refreshed prompt still advertises the warmed nested YAML contract",
		);
		assert.doesNotMatch(refreshedDocs, /verbose/);
	});

	it("restores one persisted session with matching prompt, registered schemas, and focused reads", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "focused-agent-runtime-"));
		roots.push(root);
		const stateDir = path.join(root, "state");
		const configDir = path.join(root, "config");
		process.env.BOBBIT_DIR = root;
		process.env.BOBBIT_AGENT_DIR = path.join(root, "agent");
		process.env.BOBBIT_SECRETS_DIR = path.join(root, "secrets");
		fs.mkdirSync(process.env.BOBBIT_SECRETS_DIR, { recursive: true });
		fs.writeFileSync(path.join(process.env.BOBBIT_SECRETS_DIR, "token"), "a".repeat(64));
		const builtinToolsDir = path.resolve("defaults", "tools");
		const historicalAgentDir = path.join(configDir, "tools", "agent");
		writeHistoricalAgentSnapshot(historicalAgentDir);
		initPromptDirs(stateDir);
		fs.mkdirSync(path.join(stateDir, "tool-docs"));
		fs.writeFileSync(path.join(stateDir, "tool-docs", "agent.md"), "Use verbose and include_tool_results for broad raw reads.\n");

		const toolManager = new ToolManager(configDir, builtinToolsDir);
		const warmedDocs = toolManager.getToolDocsForPrompt(["bobbit_read", "read_session"]);
		assert.match(warmedDocs, /bobbit_read\(operation/);
		assert.match(warmedDocs, /read_session\(operation, session_id/);
		assert.doesNotMatch(warmedDocs, /verbose|include_tool_results/);
		assert.equal(path.resolve(toolManager.getToolGroupBaseDir("agent")), builtinToolsDir);

		const transcript = [
			{ role: "assistant", content: [
				{ type: "toolCall", id: "p0", name: "read", arguments: { path: "first" } },
				{ type: "toolCall", id: "p1", name: "read", arguments: { path: "second" } },
			] },
			{ role: "user", content: [
				{ type: "tool_result", tool_use_id: "p0", content: "FIRST_MUST_NOT_LEAK", is_error: false },
				{ type: "tool_result", tool_use_id: "p1", content: "0123456789SECOND_ONLY_AND_MORE", is_error: false },
			] },
		].map((message) => JSON.stringify({ type: "message", message })).join("\n") + "\n";
		const agentSessionFile = path.join(root, "agent", "sessions", "focused-runtime.jsonl");
		fs.mkdirSync(path.dirname(agentSessionFile), { recursive: true });
		fs.writeFileSync(agentSessionFile, transcript);

		const registered = new Map<string, any>();
		let spawnedOptions: any;
		const sessionStartHandlers: Array<() => unknown> = [];
		const pi: any = {
			on(event: string, handler: () => unknown) { if (event === "session_start") sessionStartHandlers.push(handler); },
			registerTool(spec: any) { registered.set(spec.name, spec); },
			getAllTools() { return [...registered.values()]; },
		};
		pi.tool = (spec: any) => pi.registerTool(spec);
		pi.tools = { register: (spec: any) => pi.registerTool(spec) };
		const bridgeSource = generateToolResultErrorBridgeExtension()
			.replace("export default function(pi)", "return function(pi)");
		const validationBridge = new Function(bridgeSource)() as (runtime: any) => void;

		registerRpcBridgeFactory((options: any) => {
			spawnedOptions = options;
			return {
				async start() {
					const extensions = (options.args ?? []).flatMap((arg: string, index: number, args: string[]) => arg === "--extension" ? [args[index + 1]] : []);
					assert.ok(extensions.includes(toolManager.getExtensionPath("bobbit", "extension.ts")));
					assert.ok(extensions.includes(toolManager.getExtensionPath("agent", "extension.ts")));
					assert.equal(extensions.includes(path.join(historicalAgentDir, "extension.ts")), false);
					validationBridge(pi);
					bobbitExtension(pi);
					agentExtension(pi);
					for (const handler of sessionStartHandlers) await handler();
				},
				async stop() {},
				onEvent() { return () => {}; },
				async sendCommand() { return { success: true }; },
			} as any;
		});

		const ps: any = {
			id: "focused-runtime-session",
			title: "Focused runtime",
			cwd: root,
			agentSessionFile,
			createdAt: Date.now(),
			lastActivity: Date.now(),
			projectId: "focused-runtime-project",
			allowedTools: ["bobbit_read", "read_session"],
			sandboxed: false,
		};
		const store = {
			get: () => ps,
			getLive: () => [ps],
			update: (_id: string, patch: Record<string, unknown>) => Object.assign(ps, patch),
			put() {}, archive() {},
		};
		const manager: any = new SessionManager({ toolManager, stateDir });
		managers.push(manager);
		manager._testStore = store;
		manager.resolveCurrentCatalogSpawnModel = async () => undefined;
		manager.resolveCurrentCatalogThinkingLevel = async () => undefined;
		// Model catalog/auth selection is orthogonal to this restore-contract fixture.
		// Keep the real restore boundary while supplying its deterministic spawn tuple.
		manager.finalizeSpawnOptions = async (options: any) => {
			options.initialModel = "fixture/focused-model";
			options.initialThinkingLevel = "low";
		};
		manager.tryAutoSelectModel = async () => {};
		manager.tryApplyDefaultThinkingLevel = async () => {};
		manager.ensureMcpManagerForContext = async () => {};
		await manager.restoreOneSession(ps);

		const restored = manager.getSession(ps.id);
		assert.ok(restored, "persisted session must reattach");
		assert.equal(restored.id, ps.id);
		assert.ok(spawnedOptions.systemPromptPath);
		const prompt = fs.readFileSync(spawnedOptions.systemPromptPath, "utf8");
		assert.match(prompt, /bobbit_read\(operation/);
		assert.match(prompt, /read_session\(operation, session_id/);
		assert.doesNotMatch(prompt, /verbose|include_tool_results/);
		const agentDocsPath = prompt.match(/^## Agent — see (.+agent\.md)$/m)?.[1];
		assert.ok(agentDocsPath);
		const agentDocs = fs.readFileSync(agentDocsPath, "utf8");
		assert.doesNotMatch(agentDocs, /verbose|include_tool_results/);
		assert.match(agentDocs, /operation: "list"/);
		assert.match(agentDocs, /operation: "inspect".*message_index/s);

		const bobbitTool = registered.get("bobbit_read");
		const readSession = registered.get("read_session");
		assert.ok(bobbitTool?.parameters && readSession?.parameters);
		const providerSchemas = JSON.parse(JSON.stringify({ bobbit_read: bobbitTool.parameters, read_session: readSession.parameters }));
		assert.equal(JSON.stringify(providerSchemas).includes("verbose"), false);
		assert.equal(providerSchemas.bobbit_read.additionalProperties, false);
		assert.equal(providerSchemas.read_session.type, "object");
		assert.equal(providerSchemas.read_session.additionalProperties, false);
		const validate = (tool: any, args: Record<string, unknown>) => validateToolArguments(tool, {
			type: "toolCall", id: "validate", name: tool.name, arguments: args,
		});
		assert.deepEqual(validate(readSession, { operation: "list", session_id: ps.id }), { operation: "list", session_id: ps.id });
		assert.deepEqual(validate(readSession, { operation: "inspect", session_id: ps.id, message_index: 1 }), { operation: "inspect", session_id: ps.id, message_index: 1 });
		await assert.rejects(
			() => readSession.execute("invalid", { operation: "list", session_id: ps.id, message_index: 1 }),
			/read_session list does not accept message_index\/result_index/,
		);
		assert.throws(() => validate(bobbitTool, { operation: "health", verbose: true }), /Unrecognized field: verbose/);

		process.env.BOBBIT_GATEWAY_URL = "https://focused-runtime.invalid";
		process.env.BOBBIT_TOKEN = "focused-runtime-token";
		process.env.BOBBIT_SESSION_ID = ps.id;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			const operation = url.searchParams.get("operation");
			try {
				const envelope = await readAgentTranscript(operation === "list" ? {
					operation: "list",
					offset: Number(url.searchParams.get("offset") ?? 0),
					limit: Number(url.searchParams.get("limit") ?? 20),
				} : {
					operation: "inspect",
					messageIndex: Number(url.searchParams.get("message_index")),
					resultIndex: url.searchParams.has("result_index") ? Number(url.searchParams.get("result_index")) : undefined,
					offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : undefined,
					limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
				}, { readContent: async () => transcript });
				return new Response(JSON.stringify(envelope), { status: 200, headers: { "Content-Type": "application/json" } });
			} catch (error) {
				const code = error instanceof TranscriptReaderError ? error.code : "transcript_unavailable";
				return new Response(JSON.stringify({ error: code }), { status: 400, headers: { "Content-Type": "application/json" } });
			}
		}) as typeof fetch;

		const invoke = async (params: Record<string, unknown>) => JSON.parse((await readSession.execute("call", params)).content[0].text);
		const list = await invoke({ operation: "list", session_id: ps.id });
		assert.deepEqual(list.messages.map((message: any) => message.index), [0, 1]);
		assert.equal(list.messages[0].toolUses[0].name, "read");
		assert.doesNotMatch(JSON.stringify(list), /FIRST_MUST_NOT_LEAK|SECOND_ONLY/);
		const inspected = await invoke({ operation: "inspect", session_id: ps.id, message_index: 1 });
		assert.equal(inspected.message.index, 1);
		assert.equal(inspected.messages, undefined);
		const exact = await invoke({ operation: "inspect", session_id: ps.id, message_index: 1, result_index: 1, offset: 10, limit: 6 });
		assert.deepEqual({ excerpt: exact.result.excerpt, returned: exact.result.returned, nextOffset: exact.result.nextOffset }, { excerpt: "SECOND", returned: 6, nextOffset: 16 });
		assert.doesNotMatch(JSON.stringify(exact), /FIRST_MUST_NOT_LEAK/);
	});

	it("preserves any customized historical Agent tree as the winning override", () => {
		const builtinToolsDir = path.resolve("defaults", "tools");
		for (const mutation of ["byte", "extra"] as const) {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), `focused-agent-custom-${mutation}-`));
			roots.push(root);
			const configDir = path.join(root, "config");
			const groupDir = path.join(configDir, "tools", "agent");
			writeHistoricalAgentSnapshot(groupDir);
			if (mutation === "byte") fs.appendFileSync(path.join(groupDir, "extension.ts"), "\n// intentional customization\n");
			else fs.writeFileSync(path.join(groupDir, "custom.txt"), "intentional customization\n");

			const manager = new ToolManager(configDir, builtinToolsDir);
			assert.equal(path.resolve(manager.getToolGroupBaseDir("agent")), path.resolve(path.join(configDir, "tools")));
			assert.equal(manager.getToolByName("read_session")?.params?.includes("verbose?"), true);
			assert.equal(fs.existsSync(path.join(groupDir, mutation === "byte" ? "extension.ts" : "custom.txt")), true);
		}
	});
});
