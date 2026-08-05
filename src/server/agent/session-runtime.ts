import type { IRpcBridge, RpcBridgeOptions } from "./rpc-bridge.js";
import { RpcBridge } from "./rpc-bridge.js";
import {
	ClaudeAgentSdkBridge,
	defaultClaudeAgentSdkBridgeDeps,
	type ClaudeAgentSdkBridgeDeps,
} from "./claude-agent-sdk-bridge.js";

export type SessionRuntime = "pi" | "claude-agent-sdk";

export interface SessionBridgeOptions extends RpcBridgeOptions {
	runtime?: SessionRuntime;
	claudeAgentSdkSessionId?: string;
	onBeforeCompact?: (input: { span?: string; summary?: string }) => Promise<void>;
	claudeSdkToolSurface?: import("./claude-agent-sdk-tool-surface.js").ClaudeSdkToolSurface;
	claudeAgentSdkBridgeDepsFactory?: (options: import("./claude-agent-sdk-bridge.js").ClaudeAgentSdkBridgeOptions) => ClaudeAgentSdkBridgeDeps;
}

/** Only the explicit provider opts into the SDK; anthropic/* remains Pi-backed. */
export function runtimeFromProvider(provider?: string): SessionRuntime {
	return provider === "claude-agent-sdk" ? "claude-agent-sdk" : "pi";
}

export function resolveSessionRuntime(input: { runtime?: SessionRuntime; initialModel?: string; modelProvider?: string }): SessionRuntime {
	if (input.runtime) return input.runtime;
	return runtimeFromProvider(input.modelProvider ?? input.initialModel?.split("/", 1)[0]);
}

let sdkDeps: ClaudeAgentSdkBridgeDeps = defaultClaudeAgentSdkBridgeDeps;
/** Test-only deterministic Agent SDK seam. */
export function setClaudeAgentSdkBridgeDepsForTesting(deps: ClaudeAgentSdkBridgeDeps | undefined): void {
	sdkDeps = deps ?? defaultClaudeAgentSdkBridgeDeps;
}

export function createSessionBridge(options: SessionBridgeOptions): IRpcBridge {
	const runtime = resolveSessionRuntime(options);
	if (runtime === "claude-agent-sdk") {
		const sdkOptions = { ...options, runtime } as import("./claude-agent-sdk-bridge.js").ClaudeAgentSdkBridgeOptions;
		return new ClaudeAgentSdkBridge(sdkOptions, options.claudeAgentSdkBridgeDepsFactory?.(sdkOptions) ?? sdkDeps);
	}
	return new RpcBridge(options);
}
