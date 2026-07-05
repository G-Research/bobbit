import type { IRpcBridge, RpcBridgeOptions, RpcEventListener } from "./rpc-bridge.js";
import { RpcBridge } from "./rpc-bridge.js";
import type { ClaudeCodeConfig, ClaudeCodePermissionMode } from "./claude-code-config.js";
import type { SessionRuntime } from "./session-store.js";
// SPIKE (Wave-5 in-process bridge): dependency-free eligibility check only —
// see in-process-bridge-eligibility.ts for why this must not import the pi
// SDK. Does not affect createSessionBridge's behavior when
// BOBBIT_INPROC_BRIDGE is unset (the default).
import { isInProcessBridgeEligible } from "./in-process-bridge-eligibility.js";

export interface ClaudeCodeBridgeOptions extends RpcBridgeOptions {
	runtime: "claude-code";
	claudeCodeSessionId?: string;
	claudeCodeExecutable?: string;
	claudeCodePermissionMode?: ClaudeCodePermissionMode;
	claudeCodeModelAlias?: string;
	claudeCodeAllowBypassPermissions?: boolean;
	readOnly?: boolean;
}

export type SessionBridgeOptions = RpcBridgeOptions & {
	runtime?: SessionRuntime;
	claudeCodeSessionId?: string;
	claudeCodeExecutable?: string;
	claudeCodePermissionMode?: ClaudeCodePermissionMode;
	claudeCodeModelAlias?: string;
	claudeCodeAllowBypassPermissions?: boolean;
	readOnly?: boolean;
};

export class RuntimeSwitchError extends Error {
	readonly code = "RUNTIME_SWITCH_REQUIRES_NEW_SESSION";
	constructor(from: SessionRuntime, to: SessionRuntime) {
		super(`Switching from ${runtimeLabel(from)} to ${runtimeLabel(to)} requires a new session.`);
		this.name = "RuntimeSwitchError";
	}
}

function runtimeLabel(runtime: SessionRuntime): string {
	return runtime === "claude-code" ? "Claude Code local runtime" : "Pi runtime";
}

export function isRuntimeSwitchError(err: unknown): err is RuntimeSwitchError {
	return err instanceof RuntimeSwitchError || ((err as { code?: unknown })?.code === "RUNTIME_SWITCH_REQUIRES_NEW_SESSION");
}

export function runtimeFromProvider(provider?: string): SessionRuntime {
	return provider === "claude-code" ? "claude-code" : "pi";
}

export function runtimeFromModelString(model?: string): SessionRuntime | undefined {
	if (!model) return undefined;
	const slash = model.indexOf("/");
	if (slash <= 0) return undefined;
	return runtimeFromProvider(model.slice(0, slash));
}

export function resolveSessionRuntime(options: { runtime?: SessionRuntime; initialModel?: string; modelProvider?: string }): SessionRuntime {
	return options.runtime ?? runtimeFromModelString(options.initialModel) ?? runtimeFromProvider(options.modelProvider);
}

export function modelAliasFromModelString(model?: string): string | undefined {
	if (!model) return undefined;
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) return undefined;
	return model.slice(slash + 1);
}

export function assertRuntimeSwitchAllowed(currentRuntime: SessionRuntime | undefined, requestedProvider: string): void {
	const from = currentRuntime ?? "pi";
	const to = runtimeFromProvider(requestedProvider);
	if (from !== to) throw new RuntimeSwitchError(from, to);
}

export function assertRuntimeAllowedForSession(runtime: SessionRuntime | undefined, sandboxed?: boolean): void {
	if ((runtime ?? "pi") === "claude-code" && sandboxed) {
		throw new Error("Claude Code local runtime is host-only in the MVP and cannot run inside Bobbit Docker sandboxes.");
	}
}

export function hydrateRuntimeOptions(options: SessionBridgeOptions, defaults?: ClaudeCodeConfig): SessionBridgeOptions {
	const runtime = resolveSessionRuntime({ runtime: options.runtime, initialModel: options.initialModel });
	if (runtime !== "claude-code") return { ...options, runtime: "pi" };
	const initialModelRuntime = runtimeFromModelString(options.initialModel);
	const initialModelAlias = initialModelRuntime === "claude-code"
		? modelAliasFromModelString(options.initialModel)
		: undefined;
	return {
		...options,
		runtime,
		claudeCodeExecutable: options.claudeCodeExecutable || defaults?.executablePath || "claude",
		claudeCodePermissionMode: options.claudeCodePermissionMode || defaults?.permissionMode || "acceptEdits",
		claudeCodeAllowBypassPermissions: options.claudeCodeAllowBypassPermissions ?? defaults?.allowBypassPermissions ?? false,
		claudeCodeModelAlias: options.claudeCodeModelAlias || initialModelAlias || defaults?.defaultModel || "default",
		readOnly: options.readOnly,
	};
}

export function createSessionBridge(options: SessionBridgeOptions): IRpcBridge {
	const hydrated = hydrateRuntimeOptions(options);
	if (hydrated.runtime === "claude-code") {
		return new LazyClaudeCodeBridge(hydrated as ClaudeCodeBridgeOptions);
	}
	// SPIKE (Wave-5 in-process bridge, docs/design/in-process-bridge-spike.md):
	// `isInProcessBridgeEligible` checks `BOBBIT_INPROC_BRIDGE` FIRST and
	// short-circuits before looking at any other option, so this branch is a
	// true no-op — and this function byte-identical to before the spike —
	// whenever the flag is unset (the default). The check itself is a plain
	// import with zero pi-SDK dependency (in-process-bridge-eligibility.ts);
	// only `LazyInProcessBridge.load()` below dynamically imports the pi SDK,
	// and only once an eligible session actually starts.
	if (isInProcessBridgeEligible(hydrated)) {
		return new LazyInProcessBridge(hydrated);
	}
	return new RpcBridge(hydrated);
}

class LazyInProcessBridge implements IRpcBridge {
	private bridge?: IRpcBridge;
	private bridgePromise?: Promise<IRpcBridge>;
	private listeners = new Set<RpcEventListener>();
	private bridgeUnsubscribers = new Map<RpcEventListener, () => void>();

	constructor(private readonly options: RpcBridgeOptions) {}

	get running(): boolean {
		return this.bridge?.running ?? false;
	}

	onEvent(listener: RpcEventListener): () => void {
		this.listeners.add(listener);
		if (this.bridge) this.bridgeUnsubscribers.set(listener, this.bridge.onEvent(listener));
		return () => {
			this.listeners.delete(listener);
			this.bridgeUnsubscribers.get(listener)?.();
			this.bridgeUnsubscribers.delete(listener);
		};
	}

	async start(): Promise<void> { return (await this.load()).start(); }
	async stop(): Promise<void> { return this.bridge ? this.bridge.stop() : undefined; }
	async prompt(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>, timeoutMs?: number): Promise<any> { return (await this.load()).prompt(text, images, timeoutMs); }
	async promptWhenReady(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>, opts?: { readyTimeoutMs?: number; promptTimeoutMs?: number }): Promise<any> { return (await this.load()).promptWhenReady(text, images, opts); }
	async steer(text: string): Promise<any> { return (await this.load()).steer(text); }
	async abort(): Promise<any> { return this.bridge ? this.bridge.abort() : { success: true }; }
	async getState(): Promise<any> { return this.bridge ? this.bridge.getState() : { success: true, data: { status: "starting" } }; }
	async getMessages(): Promise<any> { return this.bridge ? this.bridge.getMessages() : { success: true, data: [] }; }
	async setModel(provider: string, modelId: string): Promise<any> { return (await this.load()).setModel(provider, modelId); }
	async setThinkingLevel(level: string): Promise<any> { return (await this.load()).setThinkingLevel(level); }
	async compact(timeoutMs?: number): Promise<any> { return (await this.load()).compact(timeoutMs); }
	async waitForReady(overallTimeoutMs?: number): Promise<void> { return (await this.load()).waitForReady(overallTimeoutMs); }
	async sendCommand(command: Record<string, any>, timeoutMs?: number): Promise<any> { return (await this.load()).sendCommand(command, timeoutMs); }

	private async load(): Promise<IRpcBridge> {
		if (this.bridge) return this.bridge;
		if (!this.bridgePromise) {
			this.bridgePromise = import("./in-process-bridge.js").then((mod) => {
				const bridge = new mod.InProcessBridge(this.options) as IRpcBridge;
				for (const listener of this.listeners) {
					this.bridgeUnsubscribers.set(listener, bridge.onEvent(listener));
				}
				this.bridge = bridge;
				return bridge;
			});
		}
		return this.bridgePromise;
	}
}

class LazyClaudeCodeBridge implements IRpcBridge {
	private bridge?: IRpcBridge;
	private bridgePromise?: Promise<IRpcBridge>;
	private listeners = new Set<RpcEventListener>();
	private bridgeUnsubscribers = new Map<RpcEventListener, () => void>();

	constructor(private readonly options: ClaudeCodeBridgeOptions) {}

	get running(): boolean {
		return this.bridge?.running ?? false;
	}

	onEvent(listener: RpcEventListener): () => void {
		this.listeners.add(listener);
		if (this.bridge) this.bridgeUnsubscribers.set(listener, this.bridge.onEvent(listener));
		return () => {
			this.listeners.delete(listener);
			this.bridgeUnsubscribers.get(listener)?.();
			this.bridgeUnsubscribers.delete(listener);
		};
	}

	async start(): Promise<void> { return (await this.load()).start(); }
	async stop(): Promise<void> { return this.bridge ? this.bridge.stop() : undefined; }
	async prompt(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>, timeoutMs?: number): Promise<any> { return (await this.load()).prompt(text, images, timeoutMs); }
	async promptWhenReady(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>, opts?: { readyTimeoutMs?: number; promptTimeoutMs?: number }): Promise<any> { return (await this.load()).promptWhenReady(text, images, opts); }
	async steer(text: string): Promise<any> { return (await this.load()).steer(text); }
	async abort(): Promise<any> { return this.bridge ? this.bridge.abort() : { success: true }; }
	async getState(): Promise<any> { return this.bridge ? this.bridge.getState() : { success: true, data: { runtime: "claude-code", model: { provider: "claude-code", id: this.options.claudeCodeModelAlias }, claudeCodeSessionId: this.options.claudeCodeSessionId, claudeCodeModelAlias: this.options.claudeCodeModelAlias, claudeCodePermissionMode: this.options.claudeCodePermissionMode, thinkingLevel: this.options.initialThinkingLevel } }; }
	async getMessages(): Promise<any> { return this.bridge ? this.bridge.getMessages() : { success: true, data: { messages: [] } }; }
	async setModel(provider: string, modelId: string): Promise<any> { return (await this.load()).setModel(provider, modelId); }
	async setThinkingLevel(level: string): Promise<any> { return (await this.load()).setThinkingLevel(level); }
	async compact(timeoutMs?: number): Promise<any> { return (await this.load()).compact(timeoutMs); }
	async waitForReady(overallTimeoutMs?: number): Promise<void> { return (await this.load()).waitForReady(overallTimeoutMs); }
	async sendCommand(command: Record<string, any>, timeoutMs?: number): Promise<any> { return (await this.load()).sendCommand(command, timeoutMs); }

	private async load(): Promise<IRpcBridge> {
		if (this.bridge) return this.bridge;
		if (!this.bridgePromise) {
			const bridgeModule = "./claude-code-bridge.js";
			this.bridgePromise = import(bridgeModule).then((mod: any) => {
				const Bridge = mod.ClaudeCodeBridge;
				if (typeof Bridge !== "function") throw new Error("ClaudeCodeBridge export not found");
				const bridge = new Bridge(this.options) as IRpcBridge;
				for (const listener of this.listeners) {
					this.bridgeUnsubscribers.set(listener, bridge.onEvent(listener));
				}
				this.bridge = bridge;
				return bridge;
			});
		}
		return this.bridgePromise;
	}
}
