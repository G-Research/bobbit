import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";
import type { ChildProcess } from "node:child_process";
import type { McpManager } from "../mcp/mcp-manager.js";
import { parseMcpToolName } from "../mcp/mcp-meta.js";
import { bobbitDir } from "../bobbit-dir.js";
import type { ScopedToolContext, ToolManager } from "./tool-manager.js";
import type { ClaudeSdkToolHandler } from "./claude-agent-sdk-tool-surface.js";
import { spawnDockerExec, type DockerSpawn } from "./docker-exec-spawn.js";
import { tryHostPathToContainer } from "./rpc-bridge.js";

export interface ClaudeSdkExtensionManifestEntry {
	/** Absolute, ToolManager-derived path; never a caller-supplied extension path. */
	extensionPath: string;
	/** Candidate tools selected for the SDK surface. Conditional extension tools may be absent. */
	selectedToolNames: readonly string[];
	/** Core builtins must register; their absence is a preflight failure, never a silent downgrade. */
	requiredToolNames?: readonly string[];
	/** Every sibling this trusted extension is permitted to register during preflight. */
	allowedToolNames: readonly string[];
	/** Exact file-builtin selection consumed by `_builtins/extension.ts`, if applicable. */
	builtinToolNames?: readonly string[];
}

export interface ClaudeSdkExtensionSchema {
	name: string;
	inputSchema: Record<string, unknown>;
}

export interface ClaudeSdkSandboxDispatcherOptions {
	/** Current pooled-container identity, rebuilt after replacement/recovery. */
	containerId: string;
	/** Current translated `/workspace…` session working directory. */
	cwd: string;
	/** Existing mount mappings only; an unmapped trusted extension fails closed. */
	builtinToolsDir?: string;
	projectMarketPacksRoot?: string;
	/** Deterministic test seams; production always reads the compiled worker and shared Docker spawn. */
	spawn?: DockerSpawn;
	workerSource?: string;
}

export interface ClaudeSdkExtensionDispatcherOptions {
	cwd: string;
	env: Record<string, string>;
	/** Explicit gateway credentials scoped to this trusted in-gateway worker. */
	gatewayCredentials?: ClaudeSdkWorkerGatewayCredentials;
	/** Immutable manifest derived from the selected ToolManager providers only. */
	manifest: readonly ClaudeSdkExtensionManifestEntry[];
	/** Present only after sandbox wiring; direct SDK sessions retain a host Worker. */
	sandbox?: ClaudeSdkSandboxDispatcherOptions;
}

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	abort?: () => void;
};

/** Fixed worker-failure vocabulary safe for aggregate diagnostics only. */
export const CLAUDE_SDK_TOOL_FAILURE_CATEGORIES = ["unavailable", "invalid-arguments", "handler-failed"] as const;
export type ClaudeSdkToolFailureCategory = typeof CLAUDE_SDK_TOOL_FAILURE_CATEGORIES[number];
export type ClaudeSdkToolFailureCounts = Record<ClaudeSdkToolFailureCategory, number>;

const MAX_CLAUDE_SDK_TOOL_FAILURE_COUNT = 1_000_000;

function emptyClaudeSdkToolFailureCounts(): ClaudeSdkToolFailureCounts {
	return { unavailable: 0, "invalid-arguments": 0, "handler-failed": 0 };
}

/** Never reflect worker-controlled error text into an SDK-facing exception. */
class ClaudeSdkToolExecutionError extends Error {
	constructor(readonly category: ClaudeSdkToolFailureCategory) {
		super("Bobbit tool execution failed");
		this.name = "ClaudeSdkToolExecutionError";
	}
}

/** Collapse the wire's fixed worker error tokens into the public diagnostic vocabulary. */
function workerFailureCategory(error: unknown): ClaudeSdkToolFailureCategory {
	if (error === "unavailable" || error === "invalid-arguments") return error;
	// `failed` is the trusted worker's handler exception token. Unknown values are
	// deliberately collapsed here rather than becoming caller-controlled diagnostics.
	return "handler-failed";
}

// The agent extension owns these child-session verbs outside goals; the team
// extension owns the same canonical verbs for goal teams. Both are trusted
// ToolManager providers, but exactly one branch registers at runtime.
const CONDITIONAL_AGENT_TEAM_TOOLS = ["team_prompt", "team_steer", "team_abort", "team_dismiss"] as const;

/** Resolve a ToolManager provider to an extension path without accepting paths from callers. */
function trustedExtensionPath(toolManager: ToolManager, provider: ReturnType<ToolManager["getToolProviders"]> extends Map<string, infer P> ? P : never): string {
	if (provider.type === "builtin") {
		return path.resolve(provider.tool === "bash"
			? toolManager.getExtensionPath("shell", "extension.ts")
			: toolManager.getExtensionPath("_builtins", "extension.ts"));
	}
	if (provider.type !== "bobbit-extension") throw new Error("Claude SDK provider is unsupported");
	const groupRoot = path.resolve(provider.baseDir, provider.groupDir);
	const extensionPath = path.resolve(groupRoot, provider.extension ?? "extension.ts");
	const relative = path.relative(groupRoot, extensionPath);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("Claude SDK provider extension path is outside its trusted tool group");
	}
	return extensionPath;
}

/**
 * Build the immutable provider manifest from the resolved ToolManager catalogue.
 * `selectedToolNames` controls SDK exposure, while `allowedToolNames` permits
 * trusted sibling registrations (for example bash also registers bash_bg).
 */
export function buildClaudeSdkExtensionManifest(
	toolManager: ToolManager,
	scope: ScopedToolContext,
	eligibleToolNames: readonly string[],
): readonly ClaudeSdkExtensionManifestEntry[] {
	const providers = toolManager.getToolProviders(scope);
	const selectedByPath = new Map<string, { names: Set<string>; requiredNames: Set<string>; builtinNames: Set<string>; hasFileBuiltin: boolean }>();
	for (const toolName of eligibleToolNames) {
		const provider = providers.get(toolName);
		if (!provider) throw new Error(`Claude SDK provider is unavailable for ${toolName}`);
		const extensionPath = trustedExtensionPath(toolManager, provider);
		const entry = selectedByPath.get(extensionPath) ?? { names: new Set<string>(), requiredNames: new Set<string>(), builtinNames: new Set<string>(), hasFileBuiltin: false };
		const lower = toolName.toLowerCase();
		if (entry.names.has(lower)) throw new Error(`Claude SDK provider manifest duplicates ${toolName}`);
		entry.names.add(lower);
		if (provider.type === "builtin") entry.requiredNames.add(lower);
		if (provider.type === "builtin" && provider.tool !== "bash") {
			entry.hasFileBuiltin = true;
			entry.builtinNames.add(provider.tool ?? lower);
		}
		selectedByPath.set(extensionPath, entry);
	}

	const agentExtensionPath = path.resolve(toolManager.getExtensionPath("agent", "extension.ts"));
	const manifest = [...selectedByPath.entries()].map(([extensionPath, selected]) => {
		const allowed = new Set(selected.names);
		if (extensionPath === agentExtensionPath) {
			for (const name of CONDITIONAL_AGENT_TEAM_TOOLS) allowed.add(name);
		}
		// File builtins are constrained by BOBBIT_BUILTIN_TOOLS, so their exact
		// allowed registrations are the selected names. Other extension siblings
		// are intentional registrations from one trusted provider module.
		if (!selected.hasFileBuiltin) {
			for (const [candidateName, provider] of providers) {
				if ((provider.type !== "builtin" && provider.type !== "bobbit-extension") || trustedExtensionPath(toolManager, provider) !== extensionPath) continue;
				allowed.add(candidateName.toLowerCase());
			}
		}
		return Object.freeze({
			extensionPath,
			selectedToolNames: Object.freeze([...selected.names].sort()),
			requiredToolNames: Object.freeze([...selected.requiredNames].sort()),
			allowedToolNames: Object.freeze([...allowed].sort()),
			...(selected.hasFileBuiltin ? { builtinToolNames: Object.freeze([...selected.builtinNames].sort()) } : {}),
		});
	});
	return Object.freeze(manifest);
}

export interface ClaudeSdkWorkerGatewayCredentials {
	/** Resolved by the gateway for this trusted in-process worker only. */
	token?: string;
	url?: string;
}

export function buildClaudeSdkWorkerEnv(
	env: Record<string, string>,
	credentials: ClaudeSdkWorkerGatewayCredentials = {},
): Record<string, string> {
	// WorkerOptions.env replaces inheritance. This is deliberately the only child
	// that receives the gateway credential: it is an in-gateway worker which loads
	// trusted Bobbit extension handlers. The Agent SDK subprocess remains on its
	// separate closed environment (buildClaudeAgentSdkEnv) and never receives it.
	const out: Record<string, string> = {};
	for (const key of ["PATH", "TMPDIR", "TMP", "TEMP"]) {
		const value = env[key] ?? process.env[key];
		if (value) out[key] = value;
	}
	for (const key of ["BOBBIT_SESSION_ID", "BOBBIT_SESSION_SECRET", "BOBBIT_GOAL_ID", "BOBBIT_STAFF_ID", "BOBBIT_CWD", "BOBBIT_BUILTIN_TOOLS"]) {
		if (env[key]) out[key] = env[key]!;
	}
	const url = credentials.url ?? env.BOBBIT_GATEWAY_URL;
	const token = credentials.token ?? env.BOBBIT_TOKEN;
	if (url) out.BOBBIT_GATEWAY_URL = url;
	if (token) out.BOBBIT_TOKEN = token;
	out.BOBBIT_DIR = env.BOBBIT_DIR || bobbitDir();
	return out;
}

/** Closed environment for a trusted extension process executing inside Docker. */
function buildClaudeSdkSandboxWorkerEnv(
	env: Record<string, string>,
	credentials: ClaudeSdkWorkerGatewayCredentials,
): Record<string, string> {
	const hostDerived = buildClaudeSdkWorkerEnv(env, credentials);
	const { PATH: _path, TMPDIR: _tmpdir, TMP: _tmp, TEMP: _temp, BOBBIT_DIR: _bobbitDir, ...authority } = hostDerived;
	return {
		HOME: "/home/node",
		PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		TMPDIR: "/tmp",
		TMP: "/tmp",
		TEMP: "/tmp",
		LANG: "C.UTF-8",
		...authority,
	};
}

/** Session-local adapter around Pi's public extension loader. */
type DispatcherProcess = Worker | ChildProcess;

type SandboxFrameReader = {
	decoder: StringDecoder;
	buffer: string;
	failed: boolean;
};

// Tool results may legitimately exceed a pipe's typical 64 KiB chunk. Keep a
// bounded incomplete-frame buffer so a malformed worker cannot retain stdout
// indefinitely before its newline arrives.
const MAX_SANDBOX_DISPATCH_FRAME_BYTES = 4 * 1024 * 1024;

export class ClaudeSdkExtensionDispatcher {
	private worker?: DispatcherProcess;
	private starting?: Promise<DispatcherProcess>;
	private startingWorker?: DispatcherProcess;
	private sequence = 0;
	private disposed = false;
	private schemas: readonly ClaudeSdkExtensionSchema[] = [];
	private readonly pending = new Map<number, Pending>();
	private readonly toolFailureCounts = emptyClaudeSdkToolFailureCounts();

	constructor(private readonly options: ClaudeSdkExtensionDispatcherOptions) {}

	/** Aggregate-only failure facts for private diagnostics; no tool identity or payload survives. */
	getToolFailureCounts(): ClaudeSdkToolFailureCounts {
		return { ...this.toolFailureCounts };
	}

	/** Load only the trusted manifest and return exact TypeBox JSON schemas before SDK registration. */
	async start(): Promise<readonly ClaudeSdkExtensionSchema[]> {
		await this.getWorker();
		return this.schemas;
	}

	private async getWorker(): Promise<DispatcherProcess> {
		if (this.disposed) throw new Error("Bobbit extension dispatcher stopped");
		if (this.worker) return this.worker;
		if (!this.starting) this.starting = this.options.sandbox ? this.startSandboxWorker() : this.startHostWorker();
		return this.starting;
	}

	private startHostWorker(): Promise<Worker> {
		const compiledWorker = new URL("./claude-sdk-extension-worker.js", import.meta.url);
		// Vitest executes TypeScript directly from src/, where tsc has not emitted
		// a sibling .js worker. Production always uses the compiled worker.
		const sourceWorker = new URL("./claude-sdk-extension-worker.ts", import.meta.url);
		const useSourceWorker = !fs.existsSync(compiledWorker) && fs.existsSync(sourceWorker);
		const workerEnv = buildClaudeSdkWorkerEnv(this.options.env, this.options.gatewayCredentials);
		const worker = new Worker(useSourceWorker ? sourceWorker : compiledWorker, {
			workerData: { cwd: this.options.cwd, env: workerEnv, manifest: this.options.manifest },
			env: workerEnv,
			...(useSourceWorker ? { execArgv: ["--import", "tsx"] } : {}),
		});
		return this.awaitReady(worker, listener => {
			worker.on("message", listener);
			return () => worker.off("message", listener);
		}, () => worker.terminate(), message => worker.postMessage(message));
	}

	private startSandboxWorker(): Promise<ChildProcess> {
		const sandbox = this.options.sandbox!;
		const compiledWorker = new URL("./claude-sdk-extension-worker.js", import.meta.url);
		if (!sandbox.workerSource && !fs.existsSync(compiledWorker)) throw new Error("Claude SDK sandbox dispatcher is unavailable: rebuild the server before starting a sandbox session");
		const manifest = this.options.manifest.map(entry => {
			const extensionPath = tryHostPathToContainer(entry.extensionPath, {
				builtinToolsDir: sandbox.builtinToolsDir,
				projectMarketPacksRoot: sandbox.projectMarketPacksRoot,
			});
			if (!extensionPath) throw new Error("Claude SDK sandbox dispatcher extension is not mounted in the current container");
			return Object.freeze({ ...entry, extensionPath });
		});
		// The compiled worker source is evaluated by the image's Node runtime, so no
		// server source or host path needs mounting into the pooled container. Its
		// trusted extension imports are separately remapped above to existing mounts.
		const source = sandbox.workerSource ?? fs.readFileSync(compiledWorker, "utf8");
		const workerEnv = buildClaudeSdkSandboxWorkerEnv(this.options.env, this.options.gatewayCredentials ?? {});
		const child = spawnDockerExec({
			containerId: sandbox.containerId,
			cwd: sandbox.cwd,
			env: workerEnv,
			command: ["node", "--input-type=module", "--eval", source],
			spawn: sandbox.spawn,
			logPrefix: "claude-sdk-tools",
			drainStderr: true,
		});
		if (!child.stdin || !child.stdout) {
			child.kill("SIGTERM");
			throw new Error("Claude SDK sandbox dispatcher did not provide pipe stdio");
		}
		const reader: SandboxFrameReader = { decoder: new StringDecoder("utf8"), buffer: "", failed: false };
		return this.awaitReady(child, listener => {
			const onData = (chunk: Buffer) => this.readSandboxMessage(reader, chunk, listener);
			child.stdout!.on("data", onData);
			return () => child.stdout!.off("data", onData);
		}, () => child.kill("SIGTERM"), message => this.send(child, message), {
			cwd: sandbox.cwd,
			env: workerEnv,
			manifest,
		}, reader);
	}

	private awaitReady<T extends DispatcherProcess>(worker: T, subscribe: (listener: (message: any) => void) => (() => void) | void, terminate: () => unknown, send: (message: unknown) => void, init?: unknown, sandboxReader?: SandboxFrameReader): Promise<T> {
		this.startingWorker = worker;
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			let detach: (() => void) | undefined;
			const onExit = () => rejectStartup("worker-exited");
			const cleanupStartupListeners = () => {
				detach?.();
				worker.off("error", rejectStartup);
				worker.off("exit", onExit);
			};
			const rejectStartup = (diagnostic?: unknown) => {
				if (settled) return;
				settled = true;
				cleanupStartupListeners();
				if (this.startingWorker === worker) this.startingWorker = undefined;
				void terminate();
				const detail = typeof diagnostic === "string" ? diagnostic.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 160) : "";
				reject(new Error(`Bobbit extension dispatcher failed to start${detail ? ` (${detail})` : ""}`));
			};
			const onMessage = (message: any) => {
				if (settled) return;
				if (message?.type === "protocol-error") return rejectStartup("invalid-protocol");
				if (message?.type === "ready") {
					if (!Array.isArray(message.schemas)) return rejectStartup();
					try {
						if (Array.isArray(message.omittedConditional) && message.omittedConditional.length > 0) {
							const omitted = message.omittedConditional.filter((name: unknown): name is string => typeof name === "string").slice(0, 8).map((name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80));
							console.warn(`[claude-sdk] ${message.omittedConditional.length} selected conditional tool registration(s) omitted${omitted.length ? `: ${omitted.join(",")}` : ""}`);
						}
						this.schemas = Object.freeze(message.schemas.map((schema: unknown) => {
							if (!schema || typeof schema !== "object" || typeof (schema as ClaudeSdkExtensionSchema).name !== "string" || !(schema as ClaudeSdkExtensionSchema).inputSchema || typeof (schema as ClaudeSdkExtensionSchema).inputSchema !== "object") throw new Error("Invalid Claude SDK extension schema");
							return Object.freeze({ name: (schema as ClaudeSdkExtensionSchema).name, inputSchema: (schema as ClaudeSdkExtensionSchema).inputSchema });
						}));
					} catch {
						return rejectStartup("invalid-schema");
					}
					settled = true;
					cleanupStartupListeners();
					this.startingWorker = undefined;
					this.attach(worker, sandboxReader);
					this.worker = worker;
					resolve(worker);
				} else if (message?.type === "startup-error") rejectStartup(message.diagnostic);
			};
			detach = subscribe(onMessage) ?? undefined;
			worker.once("error", rejectStartup);
			worker.once("exit", onExit);
			if (init) send({ type: "init", ...(init as object) });
		});
	}

	private readSandboxMessage(reader: SandboxFrameReader, chunk: Buffer | string, listener: (message: any) => void): void {
		if (reader.failed) return;
		reader.buffer += reader.decoder.write(chunk);
		if (Buffer.byteLength(reader.buffer) > MAX_SANDBOX_DISPATCH_FRAME_BYTES) {
			reader.failed = true;
			listener({ type: "protocol-error" });
			return;
		}
		const lines = reader.buffer.split("\n");
		reader.buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith("BOBBIT_SDK_DISPATCH:")) continue;
			try {
				const message = JSON.parse(line.slice("BOBBIT_SDK_DISPATCH:".length));
				if (!message || typeof message !== "object") throw new Error("invalid protocol message");
				listener(message);
			} catch {
				reader.failed = true;
				listener({ type: "protocol-error" });
				return;
			}
		}
	}

	private failSandboxProtocol(worker: DispatcherProcess): void {
		if (this.worker === worker) this.worker = undefined;
		if (this.startingWorker === worker) this.startingWorker = undefined;
		this.starting = undefined;
		this.failAll(new Error("Bobbit extension dispatcher protocol error"));
		if (worker instanceof Worker) void worker.terminate();
		else worker.kill("SIGTERM");
	}

	private send(worker: DispatcherProcess, message: unknown): void {
		if (worker instanceof Worker) worker.postMessage(message);
		else worker.stdin?.write(`BOBBIT_SDK_DISPATCH:${JSON.stringify(message)}\n`);
	}

	private attach(worker: DispatcherProcess, sandboxReader?: SandboxFrameReader): void {
		const onMessage = (message: any) => {
			if (message?.type === "protocol-error") {
				this.failSandboxProtocol(worker);
				return;
			}
			if (message?.type !== "result" || typeof message.id !== "number") return;
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			pending.abort?.();
			if (message.error) {
				const category = workerFailureCategory(message.error);
				this.toolFailureCounts[category] = Math.min(this.toolFailureCounts[category] + 1, MAX_CLAUDE_SDK_TOOL_FAILURE_COUNT);
				pending.reject(new ClaudeSdkToolExecutionError(category));
			} else pending.resolve(message.result);
		};
		if (worker instanceof Worker) worker.on("message", onMessage);
		else {
			if (!sandboxReader) throw new Error("Claude SDK sandbox dispatcher is missing its stdout frame reader");
			worker.stdout?.on("data", chunk => this.readSandboxMessage(sandboxReader, chunk, onMessage));
		}
		worker.on("error", error => this.failAll(error));
		worker.on("exit", () => {
			this.worker = undefined;
			this.starting = undefined;
			if (!this.disposed) this.failAll(new Error("Bobbit extension dispatcher exited"));
		});
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.abort?.();
			pending.reject(error);
		}
		this.pending.clear();
	}

	async invoke(name: string, args: Record<string, unknown>, context: { signal?: AbortSignal; toolUseId?: string }): Promise<unknown> {
		if (this.disposed || context.signal?.aborted) throw new Error("Tool call cancelled.");
		const worker = await this.getWorker();
		if (this.disposed || context.signal?.aborted) throw new Error("Tool call cancelled.");
		const id = ++this.sequence;
		return new Promise<unknown>((resolve, reject) => {
			const cancel = () => this.send(worker, { type: "cancel", id });
			context.signal?.addEventListener("abort", cancel, { once: true });
			this.pending.set(id, {
				resolve,
				reject,
				abort: () => context.signal?.removeEventListener("abort", cancel),
			});
			if (this.disposed || context.signal?.aborted) {
				this.pending.delete(id);
				context.signal?.removeEventListener("abort", cancel);
				reject(new Error("Tool call cancelled."));
				return;
			}
			this.send(worker, { type: "invoke", id, name, args, toolUseId: context.toolUseId ?? `sdk-${id}` });
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.failAll(new Error("Bobbit extension dispatcher stopped"));
		const worker = this.worker;
		const startingWorker = this.startingWorker;
		this.worker = undefined;
		this.starting = undefined;
		this.startingWorker = undefined;
		this.schemas = [];
		if (worker instanceof Worker) void worker.terminate();
		else worker?.kill("SIGTERM");
		if (startingWorker && startingWorker !== worker) {
			if (startingWorker instanceof Worker) void startingWorker.terminate();
			else startingWorker.kill("SIGTERM");
		}
	}
}

export interface ClaudeSdkMcpOperation {
	/** Exact operation identifier selected from the current McpManager snapshot. */
	operation: string;
	/** Exact per-operation route identity, including raw server/sub casing. */
	toolName: string;
}

/** Dispatch a Bobbit MCP meta-tool through its immutable selected route set. */
export function createMcpMetaToolHandler(
	server: string,
	sub: string | undefined,
	mcpManager: McpManager,
	permittedOperations: readonly ClaudeSdkMcpOperation[],
): ClaudeSdkToolHandler {
	const routes = new Map<string, string>();
	for (const permitted of permittedOperations) {
		const parsed = parseMcpToolName(permitted.toolName);
		if (!parsed || parsed.server !== server || parsed.sub !== sub || parsed.op !== permitted.operation || routes.has(permitted.operation)) {
			throw new Error("Invalid immutable MCP operation surface.");
		}
		routes.set(permitted.operation, permitted.toolName);
	}
	return async (args, { signal }) => {
		if (signal?.aborted) throw new Error("Tool call cancelled.");
		const operation = args.operation;
		const operationArgs = args.args;
		if (typeof operation !== "string" || !operationArgs || typeof operationArgs !== "object" || Array.isArray(operationArgs)) throw new Error("Invalid MCP meta-tool request.");
		const route = routes.get(operation);
		// The Zod enum is only guidance; the frozen allowed route set is the
		// handler-side authority, so forged never/unknown operations cannot reach
		// McpManager after an aggregate was allowed.
		if (!route) throw new Error("MCP operation is unavailable in this Bobbit session.");
		if (signal?.aborted) throw new Error("Tool call cancelled.");
		return mcpManager.callTool(route, operationArgs as Record<string, unknown>);
	};
}
