import path from "node:path";
import { Worker } from "node:worker_threads";
import type { McpManager } from "../mcp/mcp-manager.js";
import { parseMcpToolName } from "../mcp/mcp-meta.js";
import type { ScopedToolContext, ToolManager } from "./tool-manager.js";
import type { ClaudeSdkToolHandler } from "./claude-agent-sdk-tool-surface.js";

export interface ClaudeSdkExtensionDispatcherOptions {
	cwd: string;
	env: Record<string, string>;
	toolManager: ToolManager;
	scope: ScopedToolContext;
	/** Extension paths already selected by the normal session setup pipeline. */
	extensionPaths?: readonly string[];
}

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	abort?: () => void;
};

/**
 * Session-local adapter around Pi's public extension loader.  It deliberately
 * runs in a Worker: Bobbit extensions read process.env at registration time,
 * and modifying the gateway's process.env would let concurrent sessions leak
 * identities or credentials into each other.  The SDK calls this adapter by
 * message, not by a Claude-to-gateway callback endpoint.
 */
export class ClaudeSdkExtensionDispatcher {
	private worker?: Worker;
	private starting?: Promise<Worker>;
	private sequence = 0;
	private readonly pending = new Map<number, Pending>();
	private readonly extensionPaths: readonly string[];

	constructor(private readonly options: ClaudeSdkExtensionDispatcherOptions) {
		const providers = options.toolManager.getToolProviders(options.scope);
		const paths = new Set<string>(options.extensionPaths ?? []);
		let hasFileBuiltin = false;
		let hasBashBuiltin = false;
		for (const provider of providers.values()) {
			if (provider.type === "bobbit-extension" && provider.extension) {
				paths.add(path.join(provider.baseDir, provider.groupDir, provider.extension));
			}
			if (provider.type === "builtin") {
				hasFileBuiltin ||= provider.tool !== "bash";
				hasBashBuiltin ||= provider.tool === "bash";
			}
		}
		if (hasFileBuiltin) paths.add(options.toolManager.getExtensionPath("_builtins", "extension.ts"));
		if (hasBashBuiltin) paths.add(options.toolManager.getExtensionPath("shell", "extension.ts"));
		this.extensionPaths = [...paths];
	}

	private async getWorker(): Promise<Worker> {
		if (this.worker) return this.worker;
		if (!this.starting) {
			this.starting = new Promise<Worker>((resolve, reject) => {
				const worker = new Worker(new URL("./claude-sdk-extension-worker.js", import.meta.url), {
					workerData: { cwd: this.options.cwd, env: this.options.env, extensionPaths: this.extensionPaths },
				});
				const onMessage = (message: any) => {
					if (message?.type === "ready") {
						worker.off("message", onMessage);
						this.attach(worker);
						this.worker = worker;
						resolve(worker);
					} else if (message?.type === "startup-error") {
						worker.off("message", onMessage);
						void worker.terminate();
						reject(new Error(`Bobbit extension dispatcher failed to start: ${String(message.error).slice(0, 300)}`));
					}
				};
				worker.on("message", onMessage);
				worker.once("error", reject);
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
			if (message.error) pending.reject(new Error(String(message.error).slice(0, 300)));
			else pending.resolve(message.result);
		});
		worker.on("error", error => this.failAll(error));
		worker.on("exit", code => {
			this.worker = undefined;
			this.starting = undefined;
			if (code !== 0) this.failAll(new Error(`Bobbit extension dispatcher exited (${code})`));
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
		if (context.signal?.aborted) throw new Error("Tool call cancelled.");
		const worker = await this.getWorker();
		const id = ++this.sequence;
		return new Promise<unknown>((resolve, reject) => {
			const cancel = () => worker.postMessage({ type: "cancel", id });
			context.signal?.addEventListener("abort", cancel, { once: true });
			this.pending.set(id, {
				resolve,
				reject,
				abort: () => context.signal?.removeEventListener("abort", cancel),
			});
			worker.postMessage({ type: "invoke", id, name, args, toolUseId: context.toolUseId ?? `sdk-${id}` });
		});
	}

	dispose(): void {
		this.failAll(new Error("Bobbit extension dispatcher stopped"));
		const worker = this.worker;
		this.worker = undefined;
		this.starting = undefined;
		if (worker) void worker.terminate();
	}
}

/** Dispatch a Bobbit MCP meta-tool through its already-connected McpManager. */
export function createMcpMetaToolHandler(name: string, mcpManager: McpManager): ClaudeSdkToolHandler {
	return async (args, { signal }) => {
		if (signal?.aborted) throw new Error("Tool call cancelled.");
		const match = /^mcp_([a-z0-9_-]+)(?:__([a-z0-9_-]+))?$/i.exec(name);
		const operation = args.operation;
		const operationArgs = args.args;
		if (!match || typeof operation !== "string" || !operationArgs || typeof operationArgs !== "object" || Array.isArray(operationArgs)) {
			throw new Error("Invalid MCP meta-tool request.");
		}
		const server = match[1]!;
		const sub = match[2];
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
