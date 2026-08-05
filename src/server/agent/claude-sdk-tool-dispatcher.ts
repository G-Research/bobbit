import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { McpManager } from "../mcp/mcp-manager.js";
import { parseMcpToolName } from "../mcp/mcp-meta.js";
import type { ScopedToolContext, ToolManager } from "./tool-manager.js";
import type { ClaudeSdkToolHandler } from "./claude-agent-sdk-tool-surface.js";

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

export interface ClaudeSdkExtensionDispatcherOptions {
	cwd: string;
	env: Record<string, string>;
	/** Immutable manifest derived from the selected ToolManager providers only. */
	manifest: readonly ClaudeSdkExtensionManifestEntry[];
}

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	abort?: () => void;
};

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

function workerEnv(env: Record<string, string>): Record<string, string> {
	// WorkerOptions.env replaces inherited process.env.  Paths are required for
	// shell tools; every BOBBIT value is explicitly session-scoped or state lookup.
	const out: Record<string, string> = {};
	for (const key of ["PATH", "TMPDIR", "TMP", "TEMP"]) {
		const value = env[key] ?? process.env[key];
		if (value) out[key] = value;
	}
	for (const key of ["BOBBIT_SESSION_ID", "BOBBIT_SESSION_SECRET", "BOBBIT_GOAL_ID", "BOBBIT_STAFF_ID", "BOBBIT_CWD", "BOBBIT_DIR", "BOBBIT_GATEWAY_URL", "BOBBIT_BUILTIN_TOOLS"]) {
		if (env[key]) out[key] = env[key]!;
	}
	return out;
}

/** Session-local adapter around Pi's public extension loader. */
export class ClaudeSdkExtensionDispatcher {
	private worker?: Worker;
	private starting?: Promise<Worker>;
	private startingWorker?: Worker;
	private sequence = 0;
	private disposed = false;
	private schemas: readonly ClaudeSdkExtensionSchema[] = [];
	private readonly pending = new Map<number, Pending>();

	constructor(private readonly options: ClaudeSdkExtensionDispatcherOptions) {}

	/** Load only the trusted manifest and return exact TypeBox JSON schemas before SDK registration. */
	async start(): Promise<readonly ClaudeSdkExtensionSchema[]> {
		await this.getWorker();
		return this.schemas;
	}

	private async getWorker(): Promise<Worker> {
		if (this.disposed) throw new Error("Bobbit extension dispatcher stopped");
		if (this.worker) return this.worker;
		if (!this.starting) {
			this.starting = new Promise<Worker>((resolve, reject) => {
				const compiledWorker = new URL("./claude-sdk-extension-worker.js", import.meta.url);
				// Vitest executes TypeScript directly from src/, where tsc has not emitted
				// a sibling .js worker. Production always uses the compiled worker.
				const sourceWorker = new URL("./claude-sdk-extension-worker.ts", import.meta.url);
				const useSourceWorker = !fs.existsSync(compiledWorker) && fs.existsSync(sourceWorker);
				const worker = new Worker(useSourceWorker ? sourceWorker : compiledWorker, {
					workerData: { cwd: this.options.cwd, env: workerEnv(this.options.env), manifest: this.options.manifest },
					env: workerEnv(this.options.env),
					...(useSourceWorker ? { execArgv: ["--import", "tsx"] } : {}),
				});
				this.startingWorker = worker;
				const rejectStartup = (diagnostic?: unknown) => {
					worker.off("message", onMessage);
					if (this.startingWorker === worker) this.startingWorker = undefined;
					void worker.terminate();
					const detail = typeof diagnostic === "string" ? diagnostic.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 160) : "";
					reject(new Error(`Bobbit extension dispatcher failed to start${detail ? ` (${detail})` : ""}`));
				};
				const onMessage = (message: any) => {
					if (message?.type === "ready") {
						if (!Array.isArray(message.schemas)) return rejectStartup();
						worker.off("message", onMessage);
						if (this.disposed) return rejectStartup();
						this.schemas = Object.freeze(message.schemas.map((schema: unknown) => {
							if (!schema || typeof schema !== "object" || typeof (schema as ClaudeSdkExtensionSchema).name !== "string" || !(schema as ClaudeSdkExtensionSchema).inputSchema || typeof (schema as ClaudeSdkExtensionSchema).inputSchema !== "object") throw new Error("Invalid Claude SDK extension schema");
							return Object.freeze({ name: (schema as ClaudeSdkExtensionSchema).name, inputSchema: (schema as ClaudeSdkExtensionSchema).inputSchema });
						}));
						this.startingWorker = undefined;
						this.attach(worker);
						this.worker = worker;
						resolve(worker);
					} else if (message?.type === "startup-error") rejectStartup(message.diagnostic);
				};
				worker.on("message", onMessage);
				worker.once("error", rejectStartup);
			});
		}
		return this.starting;
	}

	private attach(worker: Worker): void {
		worker.on("message", (message: any) => {
			if (message?.type !== "result" || typeof message.id !== "number") return;
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			pending.abort?.();
			if (message.error) pending.reject(new Error("Bobbit tool execution failed"));
			else pending.resolve(message.result);
		});
		worker.on("error", error => this.failAll(error));
		worker.on("exit", code => {
			this.worker = undefined;
			this.starting = undefined;
			if (code !== 0 && !this.disposed) this.failAll(new Error("Bobbit extension dispatcher exited"));
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
			const cancel = () => worker.postMessage({ type: "cancel", id });
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
			worker.postMessage({ type: "invoke", id, name, args, toolUseId: context.toolUseId ?? `sdk-${id}` });
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
		if (worker) void worker.terminate();
		if (startingWorker && startingWorker !== worker) void startingWorker.terminate();
	}
}

/** Dispatch a Bobbit MCP meta-tool through its already-connected McpManager. */
export function createMcpMetaToolHandler(server: string, sub: string | undefined, mcpManager: McpManager): ClaudeSdkToolHandler {
	return async (args, { signal }) => {
		if (signal?.aborted) throw new Error("Tool call cancelled.");
		const operation = args.operation;
		const operationArgs = args.args;
		if (typeof operation !== "string" || !operationArgs || typeof operationArgs !== "object" || Array.isArray(operationArgs)) throw new Error("Invalid MCP meta-tool request.");
		const candidates = mcpManager.getToolInfos().filter(info => {
			const parsed = parseMcpToolName(info.name);
			return parsed?.server === server && parsed.sub === sub && parsed.op === operation;
		});
		if (candidates.length !== 1) throw new Error("MCP operation is unavailable in this Bobbit session.");
		if (signal?.aborted) throw new Error("Tool call cancelled.");
		return mcpManager.callTool(candidates[0]!.name, operationArgs as Record<string, unknown>);
	};
}
