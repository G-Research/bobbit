import path from "node:path";
import { Worker } from "node:worker_threads";
import type { McpManager } from "../mcp/mcp-manager.js";
import { parseMcpToolName } from "../mcp/mcp-meta.js";
import type { ScopedToolContext, ToolManager } from "./tool-manager.js";
import type { ClaudeSdkToolHandler } from "./claude-agent-sdk-tool-surface.js";

export interface ClaudeSdkExtensionManifestEntry {
	extensionPath: string;
	expectedToolNames: readonly string[];
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

/**
 * Build an exact provider manifest from the resolved ToolManager catalogue.
 * Callers cannot add a raw `--extension` path to this runtime.
 */
export function buildClaudeSdkExtensionManifest(
	toolManager: ToolManager,
	scope: ScopedToolContext,
	eligibleToolNames: readonly string[],
): readonly ClaudeSdkExtensionManifestEntry[] {
	const providers = toolManager.getToolProviders(scope);
	const entries = new Map<string, Set<string>>();
	for (const toolName of eligibleToolNames) {
		const provider = providers.get(toolName);
		if (!provider) throw new Error(`Claude SDK provider is unavailable for ${toolName}`);
		let extensionPath: string;
		if (provider.type === "bobbit-extension") {
			extensionPath = path.resolve(provider.baseDir, provider.groupDir, provider.extension ?? "extension.ts");
		} else if (provider.type === "builtin") {
			// These are resolved by ToolManager, rather than accepting a caller path.
			extensionPath = provider.tool === "bash"
				? toolManager.getExtensionPath("shell", "extension.ts")
				: toolManager.getExtensionPath("_builtins", "extension.ts");
		} else {
			throw new Error(`Claude SDK provider is unsupported for ${toolName}`);
		}
		const expected = entries.get(extensionPath) ?? new Set<string>();
		if (expected.has(toolName.toLowerCase())) throw new Error(`Claude SDK provider manifest duplicates ${toolName}`);
		expected.add(toolName.toLowerCase());
		entries.set(extensionPath, expected);
	}
	return Object.freeze([...entries.entries()].map(([extensionPath, names]) => Object.freeze({
		extensionPath,
		expectedToolNames: Object.freeze([...names].sort()),
	})));
}

function workerEnv(env: Record<string, string>): Record<string, string> {
	// WorkerOptions.env replaces inherited process.env.  Paths are required for
	// shell tools; every BOBBIT value is explicitly session-scoped or state lookup.
	const out: Record<string, string> = {};
	for (const key of ["PATH", "TMPDIR", "TMP", "TEMP"]) {
		const value = env[key] ?? process.env[key];
		if (value) out[key] = value;
	}
	for (const key of ["BOBBIT_SESSION_ID", "BOBBIT_SESSION_SECRET", "BOBBIT_GOAL_ID", "BOBBIT_STAFF_ID", "BOBBIT_CWD", "BOBBIT_DIR", "BOBBIT_GATEWAY_URL"]) {
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
	private readonly pending = new Map<number, Pending>();

	constructor(private readonly options: ClaudeSdkExtensionDispatcherOptions) {}

	private async getWorker(): Promise<Worker> {
		if (this.disposed) throw new Error("Bobbit extension dispatcher stopped");
		if (this.worker) return this.worker;
		if (!this.starting) {
			this.starting = new Promise<Worker>((resolve, reject) => {
				const worker = new Worker(new URL("./claude-sdk-extension-worker.js", import.meta.url), {
					workerData: { cwd: this.options.cwd, env: workerEnv(this.options.env), manifest: this.options.manifest },
					env: workerEnv(this.options.env),
				});
				this.startingWorker = worker;
				const rejectStartup = () => {
					worker.off("message", onMessage);
					if (this.startingWorker === worker) this.startingWorker = undefined;
					void worker.terminate();
					reject(new Error("Bobbit extension dispatcher failed to start"));
				};
				const onMessage = (message: any) => {
					if (message?.type === "ready") {
						worker.off("message", onMessage);
						if (this.disposed) return rejectStartup();
						this.startingWorker = undefined;
						this.attach(worker);
						this.worker = worker;
						resolve(worker);
					} else if (message?.type === "startup-error") rejectStartup();
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

/** YAML `params` are the catalogue's portable schema source for SDK adapters. */
export function schemaFromToolParams(params: readonly string[] | undefined): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const raw of params ?? []) {
		const optional = raw.endsWith("?");
		const name = optional ? raw.slice(0, -1) : raw;
		if (!name) continue;
		properties[name] = {};
		if (!optional) required.push(name);
	}
	return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: true };
}
