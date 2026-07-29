import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect } from "vitest";

import { ToolManager, __resetToolScanCache } from "../../src/server/agent/tool-manager.ts";
import {
	scopedToolContext,
	type ResolvedPiExtensionContribution,
} from "../../src/server/agent/session-setup.ts";
import { resetToolResultErrorBridgeExtensionCache } from "../../src/server/agent/tool-result-error-bridge-extension.ts";
import { test as gatewayTest } from "./_e2e/in-process-harness.js";
import { loadServerTestRuntime } from "../harness/server-runtime.js";
import { InProcessMockBridge } from "../../tests/e2e/in-process-mock-bridge.mjs";

const FINAL_RESULT_MAX_BYTES = 50 * 1024;
const HEAVY_ERROR_CODE = "CONTEXT_HEAVY_LIMIT_REQUIRED";
const SERVER_EXTRA_MARKER = "STALE_SERVER_DUPLICATE_EXTRA";
const PROJECT_EXTRA_MARKER = "STALE_PROJECT_NESTED_EXTRA";
const FIXTURES = path.resolve("tests2", "integration", "fixtures");

type LifecycleTrace = {
	pid: number;
	activationId: string;
	sandboxed: boolean;
	hostExtensions: string[];
	remappedExtensions: string[];
	loadedExtensions: string[];
};

type ToolEnd = {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	isError: boolean;
	result: any;
};

function extensionPaths(args: string[] = []): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--extension" && typeof args[i + 1] === "string") out.push(args[++i]);
	}
	return out;
}

function comparablePath(value: string): string {
	return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function readJsonl(filePath: string): any[] {
	if (!fs.existsSync(filePath)) return [];
	return fs.readFileSync(filePath, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function appendCount(filePath: string, caller: string): number {
	return readJsonl(filePath).filter((row) => row.caller === caller).length;
}

function canonicalEnvelope(result: any): any {
	const text = result?.content?.find((block: any) => block?.type === "text")?.text;
	expect(typeof text).toBe("string");
	return JSON.parse(text);
}

function assertSuccessfulEnvelope(envelope: any): void {
	expect(Number.isSafeInteger(envelope.total) && envelope.total >= 0).toBe(true);
	expect(Number.isSafeInteger(envelope.returned) && envelope.returned >= 0).toBe(true);
	expect(Array.isArray(envelope.messages)).toBe(true);
	expect(envelope.returned).toBe(envelope.messages.length);
	expect(Number.isSafeInteger(envelope.offsetStart)).toBe(true);
	expect(Number.isSafeInteger(envelope.offsetEnd)).toBe(true);
}

function toolResultValueFromJsonl(filePath: string, toolCallId: string): any {
	const rows = readJsonl(filePath);
	let row: any;
	for (let index = rows.length - 1; index >= 0; index--) {
		const candidate = rows[index];
		if (candidate?.type !== "message"
			|| candidate.message?.role !== "toolResult"
			|| candidate.message?.toolCallId !== toolCallId) continue;
		row = candidate;
		break;
	}
	expect(row, `persisted toolResult ${toolCallId}`).toBeTruthy();
	return {
		content: row.message.content,
		details: row.message.details,
	};
}

function writeToolYaml(groupDir: string, extensionName: string): void {
	fs.mkdirSync(groupDir, { recursive: true });
	fs.writeFileSync(path.join(groupDir, "read_session.yaml"), [
		"name: read_session",
		"description: Lifecycle stale read-session winner",
		"summary: Lifecycle stale read-session winner",
		"group: Agent",
		"grantPolicy: allow",
		"provider:",
		"  type: bobbit-extension",
		`  extension: ${extensionName}`,
		"",
	].join("\n"));
}

function installServerWinner(configDir: string): string {
	const groupDir = path.join(configDir, "tools", "agent");
	fs.rmSync(groupDir, { recursive: true, force: true });
	writeToolYaml(groupDir, "bound-session-stale-server.mjs");
	const extension = path.join(groupDir, "bound-session-stale-server.mjs");
	fs.copyFileSync(path.join(FIXTURES, "bound-session-stale-server.mjs"), extension);
	return extension;
}

function installProjectWinner(projectRoot: string): { extension: string; toolsRoot: string } {
	const packRoot = path.join(projectRoot, ".bobbit", "config", "market-packs", "bound-session-project-stale");
	const groupDir = path.join(packRoot, "tools", "agent");
	writeToolYaml(groupDir, "bound-session-stale-project.mjs");
	const extension = path.join(groupDir, "bound-session-stale-project.mjs");
	fs.copyFileSync(path.join(FIXTURES, "bound-session-stale-project.mjs"), extension);
	fs.writeFileSync(path.join(packRoot, "pack.yaml"), [
		"name: bound-session-project-stale",
		"description: Project-scoped stale lifecycle fixture",
		"version: 1.0.0",
		"contents:",
		"  roles: []",
		"  tools: [agent]",
		"  skills: []",
		"  entrypoints: []",
		"",
	].join("\n"));
	return { extension, toolsRoot: path.join(packRoot, "tools") };
}

function snapshotDirectory(source: string, backup: string): boolean {
	if (!fs.existsSync(source)) return false;
	fs.cpSync(source, backup, { recursive: true });
	return true;
}

function restoreDirectory(target: string, backup: string, existed: boolean): void {
	fs.rmSync(target, { recursive: true, force: true });
	if (existed) fs.cpSync(backup, target, { recursive: true });
}

function seedTargets(gateway: any, projectId: string, root: string, prefix: string): {
	ids: { quote: string; emoji: string; result: string };
	files: string[];
	resultBody: string;
} {
	const store = gateway.sessionManager.getSessionStore(projectId);
	const now = Date.now();
	const quoteText = `QUOTE_CASE_BEGIN ${`"\\\n\t\u0001`.repeat(18_000)} QUOTE_CASE_END`;
	const emojiText = `EMOJI_CASE_BEGIN ${"🧪漢字🙂".repeat(18_000)} EMOJI_CASE_END`;
	const resultBody = `RESULT_CASE_BEGIN\n${"🧪 nested result line\n".repeat(7_000)}RESULT_CASE_END`;
	const ids = {
		quote: `${prefix}-quote`,
		emoji: `${prefix}-emoji`,
		result: `${prefix}-result`,
	};
	const rows: Record<string, any[]> = {
		[ids.quote]: [{ type: "message", message: { role: "user", content: [{ type: "text", text: quoteText }] } }],
		[ids.emoji]: [{ type: "message", message: { role: "user", content: [{ type: "text", text: emojiText }] } }],
		[ids.result]: [
			{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `${prefix}-call`, name: "diagnostic_probe", arguments: { query: "large" } }] } },
			{ type: "message", message: { role: "toolResult", toolCallId: `${prefix}-call`, toolName: "diagnostic_probe", isError: false, content: [{ type: "text", text: resultBody }] } },
		],
	};
	const files: string[] = [];
	for (const id of Object.values(ids)) {
		const agentSessionFile = path.join(root, `${id}.jsonl`);
		fs.writeFileSync(agentSessionFile, `${rows[id].map((row) => JSON.stringify(row)).join("\n")}\n`);
		files.push(agentSessionFile);
		store.put({
			id,
			title: id,
			cwd: root,
			agentSessionFile,
			createdAt: now,
			lastActivity: now,
			projectId,
		});
	}
	return { ids, files, resultBody };
}

function makeSandboxManager(projectId: string, containerPathToHost: (value: string) => string) {
	const sandbox = {
		async getContainerId() { return `lifecycle-container-${projectId}`; },
		async exec(args: string[]) {
			const command = args[0];
			const target = args.at(-1) ?? "";
			const hostTarget = containerPathToHost(target);
			if (command === "test" && args[1] === "-f") {
				if (!fs.existsSync(hostTarget)) throw new Error("missing");
				return "";
			}
			if (command === "cat") return fs.readFileSync(hostTarget, "utf8");
			if (command === "echo") return "ok\n";
			if (command === "rm") {
				fs.rmSync(hostTarget, { force: true });
				return "";
			}
			throw new Error(`unsupported lifecycle sandbox command: ${args.join(" ")}`);
		},
	};
	return {
		async ensureForProject(requested: string) {
			if (requested !== projectId) throw new Error(`unexpected sandbox project ${requested}`);
		},
		get(requested: string) { return requested === projectId ? sandbox : undefined; },
	};
}

function replaceExtensionPaths(args: string[] = [], replacements: Map<string, string>): string[] {
	const next = [...args];
	for (let i = 0; i < next.length; i++) {
		if (next[i] !== "--extension" || typeof next[i + 1] !== "string") continue;
		next[i + 1] = replacements.get(next[i + 1]) ?? next[i + 1];
		i += 1;
	}
	return next;
}

function createLifecycleBridgeClass(rpcRuntime: any) {
	return class ReadSessionLifecycleBridge extends InProcessMockBridge {
		declare options: any;
		declare _agent: any;
		readonly activationTrace: LifecycleTrace;
		private readonly stagedRoot: string;
		private invocationSequence = 0;

		constructor(options: any) {
			const spawnedGatewayEnv = options.containerId
				? { BOBBIT_GATEWAY_URL: options.gatewayUrl, BOBBIT_TOKEN: options.gatewayToken }
				: rpcRuntime.resolveDirectGatewayEnv(options);
			options.env = Object.fromEntries(Object.entries({ ...spawnedGatewayEnv, ...options.env })
				.filter(([, value]) => typeof value === "string" && value.length > 0));
			super(options);
			this.stagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bound-session-pi-extensions-"));
			const hostExtensions = extensionPaths(options.args);
			const remapOptions = {
				builtinToolsDir: options.toolManager?.getBuiltinToolsDir?.(),
				projectBase: options.cwd,
				projectMarketPacksRoot: options.projectMarketPacksRoot,
			};
			const remappedExtensions = options.containerId
				? hostExtensions.map((value: string) => rpcRuntime.hostPathToContainer(value, remapOptions))
				: [...hostExtensions];
			const replacements = new Map<string, string>();
			const loadedExtensions: string[] = [];
			for (let index = 0; index < hostExtensions.length; index++) {
				const original = hostExtensions[index];
				const normalized = original.replace(/\\/g, "/");
				const childVisible = remappedExtensions[index];
				if (normalized.includes("/tool-guard/")) {
					loadedExtensions.push(childVisible);
					continue;
				}
				if (!normalized.includes("tool-result-error-bridge")
					&& !normalized.includes("bound-session-stale-server")
					&& !normalized.includes("bound-session-stale-project")) continue;
				const roundTripped = options.containerId
					? rpcRuntime.containerPathToHost(childVisible, remapOptions)
					: original;
				const ext = path.extname(roundTripped) || ".mjs";
				const staged = path.join(this.stagedRoot, "pi-extensions", `${index}-${path.basename(roundTripped, ext)}${ext}`);
				fs.mkdirSync(path.dirname(staged), { recursive: true });
				fs.copyFileSync(roundTripped, staged);
				replacements.set(original, staged);
				loadedExtensions.push(childVisible);
			}
			this.options.args = replaceExtensionPaths(options.args, replacements);
			this.activationTrace = {
				pid: process.pid,
				activationId: randomUUID(),
				sandboxed: !!options.containerId,
				hostExtensions,
				remappedExtensions,
				loadedExtensions,
			};
		}

		private hostSessionPath(value: string): string {
			return this.activationTrace.sandboxed ? rpcRuntime.containerPathToHost(value) : value;
		}

		private containerSessionPath(value: string): string {
			if (!this.activationTrace.sandboxed) return value;
			return rpcRuntime.tryHostPathToContainer(value) ?? value;
		}

		async sendCommand(command: any, timeoutMs?: number): Promise<any> {
			if (command?.type === "lifecycle_trace") {
				return { success: true, data: this.activationTrace };
			}
			if (command?.type === "switch_session" && typeof command.sessionPath === "string") {
				return super.sendCommand({ ...command, sessionPath: this.hostSessionPath(command.sessionPath) }, timeoutMs);
			}
			return super.sendCommand(command, timeoutMs);
		}

		async getState(): Promise<any> {
			const response = await super.getState();
			if (response?.success && typeof response.data?.sessionFile === "string") {
				return {
					...response,
					data: { ...response.data, sessionFile: this.containerSessionPath(response.data.sessionFile) },
				};
			}
			return response;
		}

		async prompt(text: string): Promise<any> {
			const prefix = "BOUND_SESSION_READ:";
			if (!text.startsWith(prefix)) return super.prompt(text);
			const input = JSON.parse(text.slice(prefix.length));
			const toolName = "read_session";
			const toolCallId = `bound-session-${++this.invocationSequence}`;
			const userMessage = { role: "user", content: [{ type: "text", text }] };
			const assistantMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: input, input }],
			};
			this._agent.conversationMessages.push(userMessage, assistantMessage);
			this._emit({ type: "session_status", status: "streaming" });
			this._emit({ type: "agent_start" });
			this._emit({ type: "message_end", message: userMessage });
			this._emit({ type: "tool_execution_start", toolCallId, toolName, args: input });
			this._emit({ type: "message_end", message: assistantMessage });

			let result: any;
			let isError = false;
			try {
				for (const handler of this._agent.mockPiToolCallHandlers) {
					const decision = await handler({ toolName, tool: toolName, input, arguments: input, args: input, toolCallId });
					if (!decision?.block) continue;
					isError = true;
					result = {
						content: [{ type: "text", text: `Tool blocked: ${decision.reason ?? "blocked by policy"}` }],
						details: { blocked: true },
					};
					break;
				}
				if (!isError) {
					const tool = this._agent.mockPiTools.get(toolName);
					if (!tool) throw new Error("resolved read_session did not register in the Pi child");
					result = await tool.handler(toolCallId, input, new AbortController().signal);
				}
			} catch (error: any) {
				isError = true;
				result = error?.bobbitToolResult ?? {
					content: [{ type: "text", text: `Pi extension tool error: ${error?.message ?? String(error)}` }],
					details: { failed: true },
				};
			}

			const toolResultMessage = {
				role: "toolResult",
				toolCallId,
				toolName,
				isError,
				content: result.content,
				details: result.details,
			};
			this._agent.conversationMessages.push(toolResultMessage);
			await super.getState();
			this._emit({ type: "message_end", message: toolResultMessage });
			this._emit({ type: "tool_execution_end", toolCallId, toolName, isError, result });
			this._emit({ type: "agent_end" });
			this._emit({ type: "session_status", status: "idle" });
			return { type: "response", success: true };
		}

		async stop(): Promise<void> {
			await super.stop();
			fs.rmSync(this.stagedRoot, { recursive: true, force: true });
		}
	};
}

async function invokeReadSession(session: any, params: Record<string, unknown>): Promise<ToolEnd> {
	const end = new Promise<ToolEnd>((resolve) => {
		const unsubscribe = session.rpcClient.onEvent((event: any) => {
			if (event?.type !== "tool_execution_end" || event.toolName !== "read_session") return;
			unsubscribe();
			resolve(event);
		});
	});
	await session.rpcClient.prompt(`BOUND_SESSION_READ:${JSON.stringify(params)}`);
	return end;
}

async function lifecycleTrace(session: any): Promise<LifecycleTrace> {
	const response = await session.rpcClient.sendCommand({ type: "lifecycle_trace" });
	expect(response?.success).toBe(true);
	return response.data;
}

function assertActivation(trace: LifecycleTrace, staleExtension: string, sandboxed: boolean, previousActivationId?: string): void {
	expect(Number.isSafeInteger(trace.pid) && trace.pid > 0).toBe(true);
	expect(trace.activationId).toMatch(/^[0-9a-f-]{36}$/);
	if (previousActivationId !== undefined) expect(trace.activationId).not.toBe(previousActivationId);
	expect(trace.sandboxed).toBe(sandboxed);
	const staleHostIndex = trace.hostExtensions.findIndex((value) => comparablePath(value) === comparablePath(staleExtension));
	const boundaryHostIndex = trace.hostExtensions.findIndex((value) => value.replace(/\\/g, "/").includes("/tool-result-error-bridge/"));
	const guardHostIndex = trace.hostExtensions.findIndex((value) => value.replace(/\\/g, "/").includes("/tool-guard/"));
	expect(staleHostIndex, `stale winner in ${JSON.stringify(trace.hostExtensions)}`).toBeGreaterThanOrEqual(0);
	expect(boundaryHostIndex, "immutable result boundary loaded").toBeGreaterThanOrEqual(0);
	expect(guardHostIndex, "generated heavy guard loaded").toBeGreaterThanOrEqual(0);
	expect(boundaryHostIndex, "result boundary precedes stale registration").toBeLessThan(staleHostIndex);
	expect(trace.loadedExtensions).toContain(trace.remappedExtensions[staleHostIndex]);
	expect(trace.loadedExtensions).toContain(trace.remappedExtensions[boundaryHostIndex]);
	expect(trace.loadedExtensions).toContain(trace.remappedExtensions[guardHostIndex]);
	if (sandboxed) {
		expect(trace.remappedExtensions[staleHostIndex]).toMatch(/^\/market-packs-project\//);
		expect(trace.remappedExtensions[boundaryHostIndex]).toMatch(/^\/bobbit-state\/tool-result-error-bridge\//);
		expect(trace.remappedExtensions[guardHostIndex]).toMatch(/^\/bobbit-state\/tool-guard\//);
	}
}

async function assertLifecycleRound(options: {
	session: any;
	fetchLog: string;
	targets: ReturnType<typeof seedTargets>;
	winner: "server" | "project-sandbox";
}): Promise<void> {
	const { session, fetchLog, targets, winner } = options;
	const before = appendCount(fetchLog, session.id);
	for (const params of [
		{ session_id: targets.ids.quote, verbose: true },
		{ session_id: targets.ids.quote, include_tool_results: true, limit: 11 },
		{ session_id: targets.ids.quote, includeToolResults: true },
		{ session_id: targets.ids.quote, includeToolResults: true, limit: 11 },
	]) {
		const event = await invokeReadSession(session, params);
		expect(event.isError).toBe(true);
		expect(JSON.stringify(event.result)).toContain(HEAVY_ERROR_CODE);
	}
	// The generated pre-call guard, not the stale extension or route, rejected all
	// snake/camel heavy aliases before the first gateway/transcript fetch.
	expect(appendCount(fetchLog, session.id)).toBe(before);

	const valid = [
		{ label: "quote", params: { session_id: targets.ids.quote } },
		{ label: "emoji", params: { session_id: targets.ids.emoji, verbose: true, limit: 10 } },
		{ label: "result", params: { session_id: targets.ids.result, include_tool_results: true, limit: 10 } },
	] as const;
	for (const scenario of valid) {
		const event = await invokeReadSession(session, scenario.params);
		expect(event.isError, `${winner}/${scenario.label}: ${JSON.stringify(event.result)}`).toBe(false);
		expect(serializedBytes(event.result), `${winner}/${scenario.label} emitted value`).toBeLessThanOrEqual(FINAL_RESULT_MAX_BYTES);
		const persistedPath = session.sandboxed
			? (await loadServerTestRuntime()).rpcBridge.containerPathToHost((await session.rpcClient.getState()).data.sessionFile)
			: (await session.rpcClient.getState()).data.sessionFile;
		const persisted = toolResultValueFromJsonl(persistedPath, event.toolCallId);
		expect(serializedBytes(persisted), `${winner}/${scenario.label} persisted value`).toBeLessThanOrEqual(FINAL_RESULT_MAX_BYTES);
		expect(persisted).toEqual(event.result);
		const serialized = JSON.stringify(event.result);
		expect(serialized).not.toContain(SERVER_EXTRA_MARKER);
		expect(serialized).not.toContain(PROJECT_EXTRA_MARKER);
		expect(serialized).not.toContain('"legacy"');
		const envelope = canonicalEnvelope(event.result);
		assertSuccessfulEnvelope(envelope);
		if (scenario.label === "quote") expect(JSON.stringify(envelope)).toContain("QUOTE_CASE_BEGIN");
		if (scenario.label === "emoji") expect(JSON.stringify(envelope)).toContain("EMOJI_CASE_BEGIN");
		if (scenario.label === "result") {
			const result = envelope.messages.flatMap((message: any) => message.toolResults ?? [])[0];
			expect(result).toMatchObject({ name: "diagnostic_probe", status: "ok" });
			expect(result.size).toEqual({
				type: "array",
				blocks: 1,
				chars: targets.resultBody.length,
				lines: targets.resultBody.split("\n").length,
				bytes: Buffer.byteLength(targets.resultBody, "utf8"),
			});
		}
	}
	expect(appendCount(fetchLog, session.id)).toBe(before + valid.length);
}

async function removeSession(gateway: any, id: string, projectId: string): Promise<void> {
	const session = gateway.sessionManager.getSession(id);
	if (session) {
		try { session.unsubscribe?.(); } catch { /* best effort */ }
		try { await session.rpcClient.stop(); } catch { /* best effort */ }
		(gateway.sessionManager as any).sessions.delete(id);
	}
	const store = gateway.sessionManager.getSessionStore(projectId);
	const persisted = store.get(id);
	if (persisted?.agentSessionFile) {
		const runtime = await loadServerTestRuntime();
		const hostPath = persisted.sandboxed
			? runtime.rpcBridge.containerPathToHost(persisted.agentSessionFile)
			: persisted.agentSessionFile;
		fs.rmSync(hostPath, { force: true });
		fs.rmSync(`${hostPath}.bobbit.json`, { force: true });
	}
	store.remove(id);
}

// This is deliberately a lifecycle integration, not another activation-builder
// unit: SessionManager creates and restarts both sessions, `new RpcBridge(...)`
// resolves a fresh Pi-compatible child through the supported bridge factory,
// and that child loads production argv extensions before invoking the stale
// winner. Only process/Docker transport and endpoint transcript data are faked.
gatewayTest("resolved stale server and remapped project/sandbox winners stay guarded and bounded across restart", async ({ gateway }) => {
	const runtime = await loadServerTestRuntime();
	const rpcRuntime = runtime.rpcBridge;
	const sessionManager: any = gateway.sessionManager;
	const originalFactory = rpcRuntime.getRegisteredRpcBridgeFactory();
	const originalToolManager = sessionManager.toolManager;
	const originalGroupPolicyStore = sessionManager.groupPolicyStore;
	const originalSandboxManager = sessionManager.sandboxManager;
	const originalSandboxTokenStore = sessionManager.sandboxTokenStore;
	const LifecycleBridge = createLifecycleBridgeClass(rpcRuntime);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bound-session-resolved-lifecycle-"));
	const fetchLog = path.join(root, "fetches.jsonl");
	fs.writeFileSync(fetchLog, "");
	const serverGroup = path.join(gateway.bobbitDir, "config", "tools", "agent");
	const serverBackup = path.join(root, "server-agent-backup");
	const serverGroupExisted = snapshotDirectory(serverGroup, serverBackup);
	const callerIds: Array<{ id: string; projectId: string }> = [];
	const targetIds: Array<{ id: string; projectId: string }> = [];
	let projectId: string | undefined;
	const oldFetchLog = process.env.BOBBIT_LIFECYCLE_FETCH_LOG;
	process.env.BOBBIT_LIFECYCLE_FETCH_LOG = fetchLog;

	rpcRuntime.registerRpcBridgeFactory((options: any) => {
		const resolvedLifecycleWinner = extensionPaths(options.args).some((value) =>
			/bound-session-stale-(server|project)/.test(value.replace(/\\/g, "/")));
		if (options.env?.BOBBIT_LIFECYCLE_KIND || resolvedLifecycleWinner) return new LifecycleBridge(options) as any;
		return originalFactory?.(options) ?? null;
	});

	try {
		const builtinToolsDir = originalToolManager.getBuiltinToolsDir();

		// Direct/server winner through the gateway's real SessionManager.
		const serverStaleExtension = installServerWinner(path.join(gateway.bobbitDir, "config"));
		__resetToolScanCache();
		const serverToolManager = new ToolManager(path.join(gateway.bobbitDir, "config"), builtinToolsDir);
		sessionManager.toolManager = serverToolManager;
		const serverProvider: any = serverToolManager.getToolProviders().get("read_session");
		expect(comparablePath(path.join(serverProvider.baseDir, serverProvider.groupDir, serverProvider.extension)))
			.toBe(comparablePath(serverStaleExtension));
		const serverTargets = seedTargets(gateway, gateway.defaultProjectId, root, "bound-server-target");
		for (const id of Object.values(serverTargets.ids)) targetIds.push({ id, projectId: gateway.defaultProjectId });
		let direct = await sessionManager.createSession(root, undefined, undefined, undefined, {
			projectId: gateway.defaultProjectId,
			allowedTools: ["read_session"],
			title: "Bound direct stale winner",
			env: { BOBBIT_LIFECYCLE_KIND: "server" },
		});
		callerIds.push({ id: direct.id, projectId: gateway.defaultProjectId });
		const directFirstTrace = await lifecycleTrace(direct);
		assertActivation(directFirstTrace, serverStaleExtension, false);
		await assertLifecycleRound({ session: direct, fetchLog, targets: serverTargets, winner: "server" });
		await sessionManager.restartAgent(direct.id);
		direct = sessionManager.getSession(direct.id);
		assertActivation(await lifecycleTrace(direct), serverStaleExtension, false, directFirstTrace.activationId);
		await assertLifecycleRound({ session: direct, fetchLog, targets: serverTargets, winner: "server" });
		await removeSession(gateway, direct.id, gateway.defaultProjectId);
		callerIds.splice(callerIds.findIndex((row) => row.id === direct.id), 1);

		// Remove the higher-priority server group before installing the distinct
		// project market-pack winner. The project ToolManager and sandbox wiring are
		// production objects; only container process transport is the lightweight Pi child.
		restoreDirectory(serverGroup, serverBackup, serverGroupExisted);
		__resetToolScanCache();
		const projectRoot = path.join(root, "sandbox-project");
		fs.mkdirSync(projectRoot, { recursive: true });
		const projectResponse = await gateway.api("/api/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: `bound-session-sandbox-${Date.now()}`, rootPath: projectRoot }),
		});
		expect(projectResponse.status).toBe(201);
		projectId = (await projectResponse.json()).id;
		const projectContext = gateway.projectContextManager.getOrCreate(projectId!);
		projectContext.projectConfigStore.set("sandbox", "docker");
		const projectWinner = installProjectWinner(projectRoot);
		const projectToolManager = new ToolManager(projectContext.configDir, builtinToolsDir);
		projectToolManager.setMarketToolRootsProvider(() => [{ dir: projectWinner.toolsRoot }]);
		sessionManager.toolManager = projectToolManager;
		sessionManager.groupPolicyStore = projectContext.toolGroupPolicyStore;
		sessionManager.sandboxManager = makeSandboxManager(projectId!, (value) => rpcRuntime.containerPathToHost(value));
		sessionManager.sandboxTokenStore = undefined;
		const projectProvider: any = projectToolManager.getToolProviders().get("read_session");
		expect(comparablePath(path.join(projectProvider.baseDir, projectProvider.groupDir, projectProvider.extension)))
			.toBe(comparablePath(projectWinner.extension));
		const projectTargets = seedTargets(gateway, projectId!, root, "bound-project-target");
		for (const id of Object.values(projectTargets.ids)) targetIds.push({ id, projectId: projectId! });
		let sandbox = await sessionManager.createSession(projectRoot, undefined, undefined, undefined, {
			projectId,
			sandboxed: true,
			allowedTools: ["read_session"],
			title: "Bound project sandbox stale winner",
			env: { BOBBIT_LIFECYCLE_KIND: "project-sandbox" },
		});
		callerIds.push({ id: sandbox.id, projectId: projectId! });
		expect(sandbox.sandboxed).toBe(true);
		const sandboxFirstTrace = await lifecycleTrace(sandbox);
		assertActivation(sandboxFirstTrace, projectWinner.extension, true);
		await assertLifecycleRound({ session: sandbox, fetchLog, targets: projectTargets, winner: "project-sandbox" });
		await sessionManager.restartAgent(sandbox.id);
		sandbox = sessionManager.getSession(sandbox.id);
		expect(sandbox.sandboxed).toBe(true);
		assertActivation(await lifecycleTrace(sandbox), projectWinner.extension, true, sandboxFirstTrace.activationId);
		await assertLifecycleRound({ session: sandbox, fetchLog, targets: projectTargets, winner: "project-sandbox" });
	} finally {
		for (const row of callerIds.splice(0)) await removeSession(gateway, row.id, row.projectId).catch(() => {});
		for (const row of targetIds.splice(0)) await removeSession(gateway, row.id, row.projectId).catch(() => {});
		sessionManager.toolManager = originalToolManager;
		sessionManager.groupPolicyStore = originalGroupPolicyStore;
		sessionManager.sandboxManager = originalSandboxManager;
		sessionManager.sandboxTokenStore = originalSandboxTokenStore;
		rpcRuntime.registerRpcBridgeFactory(originalFactory);
		restoreDirectory(serverGroup, serverBackup, serverGroupExisted);
		__resetToolScanCache();
		if (projectId) await gateway.api(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
		if (oldFetchLog === undefined) delete process.env.BOBBIT_LIFECYCLE_FETCH_LOG;
		else process.env.BOBBIT_LIFECYCLE_FETCH_LOG = oldFetchLog;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// Marketplace Pi discovery is intentionally lazy and mutates the scoped
// ToolManager only when SessionManager resolves runtime contributions. These
// lifecycle cases begin with an empty scoped catalogue and make only the
// tool-result boundary directory unwritable, leaving the rest of gateway state
// available so a stale pre-discovery decision cannot be mistaken for setup I/O.
type MarketplaceBoundaryKind = "read" | "unknown" | "non-read";

type MarketplaceBoundaryScenario = {
	kind: MarketplaceBoundaryKind;
	cwd: string;
	entryPath: string;
	calls: Array<{ catalogueEmptyBeforeResolution: boolean }>;
};

function marketplaceRuntimeToolName(kind: MarketplaceBoundaryKind): string {
	return kind === "non-read" ? "pi_demo" : "read_session";
}

function writeMarketplaceBoundaryExtension(root: string, kind: MarketplaceBoundaryKind): string {
	const extensionRoot = path.join(root, "pi-extensions", kind);
	const entryPath = path.join(extensionRoot, "extension.mjs");
	const toolName = marketplaceRuntimeToolName(kind);
	fs.mkdirSync(extensionRoot, { recursive: true });
	fs.writeFileSync(entryPath, [
		"import fs from 'node:fs';",
		"",
		"export default function activate(pi) {",
		"  const runtime = {",
		"    fetchLog: process.env.BOBBIT_LIFECYCLE_FETCH_LOG,",
		"    gatewayUrl: process.env.BOBBIT_GATEWAY_URL,",
		"    token: process.env.BOBBIT_TOKEN,",
		"    sessionId: process.env.BOBBIT_SESSION_ID,",
		"  };",
		"  pi.registerTool({",
		`    name: ${JSON.stringify(toolName)},`,
		"    description: 'Marketplace boundary lifecycle fixture',",
		"    inputSchema: { type: 'object', properties: {} },",
		"    async execute(_toolCallId, params) {",
		"      fs.appendFileSync(runtime.fetchLog, JSON.stringify({ caller: runtime.sessionId, target: params.session_id }) + '\\n');",
		"      const query = new URLSearchParams();",
		"      if (params.verbose === true) query.set('verbose', 'true');",
		"      if (params.include_tool_results === true || params.includeToolResults === true) query.set('include_tool_results', 'true');",
		"      if (params.limit !== undefined) query.set('limit', String(params.limit));",
		"      const response = await fetch(runtime.gatewayUrl + '/api/sessions/' + encodeURIComponent(params.session_id) + '/transcript?' + query, {",
		"        headers: { Authorization: 'Bearer ' + runtime.token, 'X-Bobbit-Session-Id': runtime.sessionId },",
		"      });",
		"      const body = await response.json();",
		"      return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: !response.ok };",
		"    },",
		"  });",
		"}",
		"",
	].join("\n"));
	return entryPath;
}

function marketplaceBoundaryContribution(scenario: MarketplaceBoundaryScenario): ResolvedPiExtensionContribution {
	const discoveryFailed = scenario.kind === "unknown";
	return {
		listName: `boundary-${scenario.kind}`,
		entryPath: scenario.entryPath,
		entryRelativePath: path.relative(path.dirname(path.dirname(scenario.entryPath)), scenario.entryPath),
		packRoot: path.dirname(path.dirname(scenario.entryPath)),
		origin: {
			scope: "project",
			packName: `boundary-${scenario.kind}`,
			packId: `market:project:boundary-${scenario.kind}`,
		},
		diagnostic: {
			status: discoveryFailed ? "discovery-failed" : "ok",
			code: discoveryFailed ? "probe_failed" : "ok",
			message: discoveryFailed ? "fixture discovery failed" : "fixture discovered",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		discovery: discoveryFailed
			? {
				status: "failed",
				tools: [],
				diagnostic: {
					status: "discovery-failed",
					code: "probe_failed",
					message: "fixture discovery failed",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			}
			: { status: "ok", tools: [{ name: marketplaceRuntimeToolName(scenario.kind) }] },
	};
}

function snapshotPath(source: string, backup: string): { existed: boolean; directory: boolean } {
	if (!fs.existsSync(source)) return { existed: false, directory: false };
	const directory = fs.statSync(source).isDirectory();
	if (directory) fs.cpSync(source, backup, { recursive: true });
	else fs.copyFileSync(source, backup);
	return { existed: true, directory };
}

function restorePath(target: string, backup: string, snapshot: { existed: boolean; directory: boolean }): void {
	fs.rmSync(target, { recursive: true, force: true });
	if (!snapshot.existed) return;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	if (snapshot.directory) fs.cpSync(backup, target, { recursive: true });
	else fs.copyFileSync(backup, target);
}

async function assertUnknownMarketplaceHeavyGuard(session: any, fetchLog: string): Promise<void> {
	const before = appendCount(fetchLog, session.id);
	for (const params of [
		{ session_id: session.id, verbose: true },
		{ session_id: session.id, include_tool_results: true, limit: 11 },
		{ session_id: session.id, includeToolResults: true },
		{ session_id: session.id, includeToolResults: true, limit: 11 },
	]) {
		const event = await invokeReadSession(session, params);
		expect(event.isError).toBe(true);
		expect(JSON.stringify(event.result)).toContain(HEAVY_ERROR_CODE);
	}
	// The runtime extension appends immediately before issuing its gateway fetch.
	// No append proves the immutable guard stopped both handler and request.
	expect(appendCount(fetchLog, session.id)).toBe(before);
}

gatewayTest("marketplace Pi discovery requires read boundaries on initial setup and restore", async ({ gateway }) => {
	const runtime = await loadServerTestRuntime();
	const rpcRuntime = runtime.rpcBridge;
	const sessionManager: any = gateway.sessionManager;
	const originalFactory = rpcRuntime.getRegisteredRpcBridgeFactory();
	const originalToolManager = sessionManager.toolManager;
	const originalResolver = sessionManager.marketplacePiExtensionResolver;
	const LifecycleBridge = createLifecycleBridgeClass(rpcRuntime);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-pi-boundary-lifecycle-"));
	const fetchLog = path.join(root, "fetches.jsonl");
	fs.writeFileSync(fetchLog, "");
	const oldFetchLog = process.env.BOBBIT_LIFECYCLE_FETCH_LOG;
	process.env.BOBBIT_LIFECYCLE_FETCH_LOG = fetchLog;
	const configDir = path.join(root, "config");
	const builtinDir = path.join(root, "builtin-tools");
	fs.mkdirSync(configDir, { recursive: true });
	fs.mkdirSync(builtinDir, { recursive: true });
	const toolManager = new ToolManager(configDir, builtinDir);
	const boundaryBase = path.join(gateway.bobbitDir, "state", "tool-result-error-bridge");
	const boundaryBackup = path.join(root, "boundary-backup");
	const boundarySnapshot = snapshotPath(boundaryBase, boundaryBackup);
	const scenarios = new Map<string, MarketplaceBoundaryScenario>();
	const sessionIds = new Set<string>();
	const spawnArgs = new Map<string, string[][]>();

	for (const kind of ["read", "unknown", "non-read"] as const) {
		const cwd = path.join(root, kind);
		fs.mkdirSync(cwd, { recursive: true });
		scenarios.set(path.resolve(cwd), {
			kind,
			cwd,
			entryPath: writeMarketplaceBoundaryExtension(cwd, kind),
			calls: [],
		});
	}

	const restoreBoundary = () => {
		resetToolResultErrorBridgeExtensionCache();
		restorePath(boundaryBase, boundaryBackup, boundarySnapshot);
	};
	const blockBoundary = () => {
		resetToolResultErrorBridgeExtensionCache();
		fs.rmSync(boundaryBase, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(boundaryBase), { recursive: true });
		fs.writeFileSync(boundaryBase, "block only result-boundary materialization", "utf8");
	};
	const clearScenarioCatalogue = (scenario: MarketplaceBoundaryScenario) => {
		toolManager.clearScopedPiExtensionTools(scopedToolContext(gateway.defaultProjectId, scenario.cwd));
	};
	const create = (scenario: MarketplaceBoundaryScenario, phase: string) => {
		const sessionId = `market-boundary-${scenario.kind}-${phase}-${randomUUID()}`;
		sessionIds.add(sessionId);
		return sessionManager.createSession(scenario.cwd, undefined, undefined, undefined, {
			projectId: gateway.defaultProjectId,
			sessionId,
			title: `Marketplace boundary ${scenario.kind} ${phase}`,
			skipAutoModel: true,
			skipAutoThinking: true,
			env: { BOBBIT_MARKETPLACE_BOUNDARY_SESSION: sessionId },
		});
	};
	const expectBoundaryFailure = async (promise: Promise<unknown>) => {
		await expect(promise).rejects.toThrow(/read_session safety boundary could not be written or verified/);
	};
	const assertLastResolutionStartedEmpty = (scenario: MarketplaceBoundaryScenario) => {
		expect(scenario.calls.at(-1)?.catalogueEmptyBeforeResolution).toBe(true);
	};

	sessionManager.toolManager = toolManager;
	sessionManager.setMarketplacePiExtensionResolver((scope: { projectId?: string; cwd?: string }) => {
		const scenario = scope.cwd ? scenarios.get(path.resolve(scope.cwd)) : undefined;
		if (!scenario) return [];
		const context = scopedToolContext(scope.projectId, scope.cwd);
		const runtimeName = marketplaceRuntimeToolName(scenario.kind);
		const catalogueEmptyBeforeResolution = !toolManager.getToolProviders(context).has(runtimeName);
		scenario.calls.push({ catalogueEmptyBeforeResolution });
		const contribution = marketplaceBoundaryContribution(scenario);
		toolManager.setScopedPiExtensionTools(context, contribution.discovery.tools.map((tool) => ({
			name: tool.name,
			runtimeName: tool.name,
			description: tool.description ?? "Marketplace boundary lifecycle fixture",
			group: "Pi Extensions",
			providerKey: `pi-ext:project:${contribution.origin.packId}:${contribution.listName}:${tool.name}`,
			packName: contribution.origin.packName,
			packId: contribution.origin.packId,
			listName: contribution.listName,
			scope: contribution.origin.scope,
			sourcePath: contribution.entryPath,
		})));
		return [contribution];
	});

	rpcRuntime.registerRpcBridgeFactory((options: any) => {
		const sessionId = options.env?.BOBBIT_MARKETPLACE_BOUNDARY_SESSION ?? options.env?.BOBBIT_SESSION_ID;
		if (!sessionId || !sessionIds.has(sessionId)) return originalFactory?.(options) ?? null;
		const rows = spawnArgs.get(sessionId) ?? [];
		rows.push([...(options.args ?? [])]);
		spawnArgs.set(sessionId, rows);
		return new LifecycleBridge(options) as any;
	});

	try {
		// Initial setup: both known read_session and unknowable discovery-failed
		// runtime registrations fail before RpcBridge construction. A successfully
		// discovered non-read extension keeps the historical best-effort behavior.
		for (const kind of ["read", "unknown"] as const) {
			const scenario = scenarios.get(path.resolve(path.join(root, kind)))!;
			clearScenarioCatalogue(scenario);
			blockBoundary();
			await expectBoundaryFailure(create(scenario, "initial"));
			assertLastResolutionStartedEmpty(scenario);
		}

		const initialNonRead = scenarios.get(path.resolve(path.join(root, "non-read")))!;
		clearScenarioCatalogue(initialNonRead);
		blockBoundary();
		const nonReadSession = await create(initialNonRead, "initial");
		await nonReadSession.pendingMetadataPersist;
		assertLastResolutionStartedEmpty(initialNonRead);
		const nonReadInitialArgs = spawnArgs.get(nonReadSession.id)?.at(-1) ?? [];
		expect(extensionPaths(nonReadInitialArgs)).toContain(initialNonRead.entryPath);
		expect(extensionPaths(nonReadInitialArgs).some((value) => value.includes("tool-result-error-bridge"))).toBe(false);
		expect(extensionPaths(nonReadInitialArgs).some((value) => value.includes("tool-guard"))).toBe(false);
		await removeSession(gateway, nonReadSession.id, gateway.defaultProjectId);
		sessionIds.delete(nonReadSession.id);

		// Restore/respawn: seed each session while the boundaries are writable.
		// The unknown runtime invokes read_session with invalid heavy requests on
		// both activations while its scoped catalogue remains empty. Finally corrupt
		// only the result-boundary path to retain the original fail-closed proof.
		for (const kind of ["read", "unknown", "non-read"] as const) {
			const scenario = scenarios.get(path.resolve(path.join(root, kind)))!;
			const context = scopedToolContext(gateway.defaultProjectId, scenario.cwd);
			restoreBoundary();
			clearScenarioCatalogue(scenario);
			let session = await create(scenario, "restore");
			await session.pendingMetadataPersist;
			assertLastResolutionStartedEmpty(scenario);
			const firstArgs = spawnArgs.get(session.id)?.at(-1) ?? [];
			const firstExtensions = extensionPaths(firstArgs);
			expect(firstExtensions).toContain(scenario.entryPath);
			if (kind !== "non-read") {
				const boundaryIndex = firstExtensions.findIndex((value) => value.includes("tool-result-error-bridge"));
				const marketplaceIndex = firstExtensions.indexOf(scenario.entryPath);
				expect(boundaryIndex).toBeGreaterThanOrEqual(0);
				expect(marketplaceIndex).toBeGreaterThan(boundaryIndex);
			}

			if (kind === "unknown") {
				const assertConservativeGuard = (args: string[]) => {
					expect(toolManager.getToolProviders(context).has("read_session")).toBe(false);
					expect(toolManager.getAvailableTools(context).some((tool) => tool.name === "read_session")).toBe(false);
					const guardPath = extensionPaths(args).find((value) => value.includes("tool-guard"));
					expect(guardPath).toBeTruthy();
					const source = fs.readFileSync(guardPath!, "utf8");
					expect(source).toContain("const askPolicies = {};");
					expect(source).toContain("const neverPolicies = {};");
					expect(source).toContain("const readSessionProtected = true;");
				};
				assertConservativeGuard(firstArgs);
				await assertUnknownMarketplaceHeavyGuard(session, fetchLog);

				clearScenarioCatalogue(scenario);
				await sessionManager.restartAgent(session.id);
				session = sessionManager.getSession(session.id);
				assertLastResolutionStartedEmpty(scenario);
				const restartedArgs = spawnArgs.get(session.id)?.at(-1) ?? [];
				expect(extensionPaths(restartedArgs)).toContain(scenario.entryPath);
				assertConservativeGuard(restartedArgs);
				await assertUnknownMarketplaceHeavyGuard(session, fetchLog);
			}

			clearScenarioCatalogue(scenario);
			blockBoundary();
			if (kind === "non-read") {
				await sessionManager.restartAgent(session.id);
				session = sessionManager.getSession(session.id);
				const restartedArgs = spawnArgs.get(session.id)?.at(-1) ?? [];
				const restartedExtensions = extensionPaths(restartedArgs);
				expect(restartedExtensions).toContain(scenario.entryPath);
				expect(restartedExtensions.some((value) => value.includes("tool-result-error-bridge"))).toBe(false);
				expect(restartedExtensions.some((value) => value.includes("tool-guard"))).toBe(false);
			} else {
				await expectBoundaryFailure(sessionManager.restartAgent(session.id));
				expect(spawnArgs.get(session.id)?.length).toBe(kind === "unknown" ? 2 : 1);
			}
			assertLastResolutionStartedEmpty(scenario);
			await removeSession(gateway, session.id, gateway.defaultProjectId);
			sessionIds.delete(session.id);
		}
	} finally {
		for (const sessionId of sessionIds) {
			await removeSession(gateway, sessionId, gateway.defaultProjectId).catch(() => {});
		}
		sessionManager.toolManager = originalToolManager;
		sessionManager.setMarketplacePiExtensionResolver(originalResolver);
		rpcRuntime.registerRpcBridgeFactory(originalFactory);
		resetToolResultErrorBridgeExtensionCache();
		restorePath(boundaryBase, boundaryBackup, boundarySnapshot);
		if (oldFetchLog === undefined) delete process.env.BOBBIT_LIFECYCLE_FETCH_LOG;
		else process.env.BOBBIT_LIFECYCLE_FETCH_LOG = oldFetchLog;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
