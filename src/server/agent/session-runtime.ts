import type { IRpcBridge, RpcBridgeOptions } from "./rpc-bridge.js";
import { RpcBridge } from "./rpc-bridge.js";
import {
	ClaudeAgentSdkBridge,
	defaultClaudeAgentSdkBridgeDeps,
	type ClaudeAgentSdkBridgeDeps,
} from "./claude-agent-sdk-bridge.js";
import { createDirectClaudeAgentSdkSessionAccess, createSandboxClaudeAgentSdkSessionAccess, defaultClaudeAgentSdkSessionAccessDeps } from "./claude-agent-sdk-session-access.js";

export type SessionRuntime = "pi" | "claude-agent-sdk";

export interface SessionBridgeOptions extends RpcBridgeOptions {
	runtime?: SessionRuntime;
	/** Ephemeral SDK-only sandbox launch descriptor; never persists with SessionInfo. */
	claudeSdkSandboxLaunch?: import("./claude-agent-sdk-bridge.js").ClaudeAgentSdkSandboxLaunch;
	/** Ephemeral direct OAuth/config launch descriptor; never persists with SessionInfo. */
	claudeSdkDirectLaunch?: import("./claude-agent-sdk-bridge.js").ClaudeAgentSdkDirectLaunch;
	claudeAgentSdkSessionId?: string;
	onBeforeCompact?: (input: { trigger?: string; summary?: string }) => Promise<void>;
	claudeSdkToolSurface?: import("./claude-agent-sdk-tool-surface.js").ClaudeSdkToolSurface;
	/** Narrow deterministic dispatcher seam; production leaves this absent. */
	claudeSdkDispatcherTestDeps?: Pick<import("./claude-sdk-tool-dispatcher.js").ClaudeSdkSandboxDispatcherOptions, "spawn" | "workerSource">;
	claudeAgentSdkBridgeDepsFactory?: (options: import("./claude-agent-sdk-bridge.js").ClaudeAgentSdkBridgeOptions) => ClaudeAgentSdkBridgeDeps;
}

/** Only the explicit provider opts into the SDK; anthropic/* remains Pi-backed. */
export function runtimeFromProvider(provider?: string): SessionRuntime {
	return provider === "claude-agent-sdk" ? "claude-agent-sdk" : "pi";
}

/**
 * Derive runtime from the durable model tuple. `persistedRuntime` is only an
 * audit fallback for legacy records without a usable provider; it can never
 * override a known tuple. `runtime` remains a compatibility alias while
 * callers migrate to the explicit name.
 */
export function resolveSessionRuntime(input: {
	modelProvider?: string;
	initialModel?: string;
	persistedRuntime?: SessionRuntime;
	/** @deprecated Use persistedRuntime for a persisted audit fallback. */
	runtime?: SessionRuntime;
}): SessionRuntime {
	const modelProvider = usableProvider(input.modelProvider);
	if (modelProvider) return runtimeFromProvider(modelProvider);

	const initialModelProvider = providerFromInitialModel(input.initialModel);
	if (initialModelProvider) return runtimeFromProvider(initialModelProvider);

	return input.persistedRuntime ?? input.runtime ?? "pi";
}

/** A blank or malformed provider is not a model tuple and cannot select a runtime. */
function usableProvider(provider: string | undefined): string | undefined {
	return typeof provider === "string" && provider.trim().length > 0 ? provider : undefined;
}

/** A bare model ID has no provider segment, so it cannot determine a runtime. */
function providerFromInitialModel(initialModel: string | undefined): string | undefined {
	if (typeof initialModel !== "string") return undefined;
	const separator = initialModel.indexOf("/");
	return separator > 0 ? usableProvider(initialModel.slice(0, separator)) : undefined;
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
		const deps = options.claudeAgentSdkBridgeDepsFactory?.(sdkOptions) ?? sdkDeps;
		const launch = sdkOptions.claudeSdkSandboxLaunch;
		const directLaunch = sdkOptions.claudeSdkDirectLaunch;
		// The deps factory is a test-only seam. Preserve an explicitly injected
		// transcript accessor so executable lifecycle tests never fall through to
		// Docker or the host's native Claude config after their fake SDK is ready.
		const sandboxSessionAccess = launch
			? deps.sessionAccess?.sandboxSdk ?? createSandboxClaudeAgentSdkSessionAccess({
				containerId: launch.containerId,
				cwd: launch.cwd,
				bobbitSessionId: launch.sessionId,
			})
			: undefined;
		const directSessionAccess = directLaunch
			? deps.sessionAccess?.directSdk ?? createDirectClaudeAgentSdkSessionAccess({ configDir: directLaunch.configDir })
			: undefined;
		return new ClaudeAgentSdkBridge(sdkOptions, sandboxSessionAccess || directSessionAccess ? {
			...deps,
			sessionAccess: {
				...(deps.sessionAccess ?? defaultClaudeAgentSdkSessionAccessDeps),
				...(sandboxSessionAccess ? { sandboxSdk: sandboxSessionAccess } : {}),
				...(directSessionAccess ? { directSdk: directSessionAccess } : {}),
			},
		} : deps);
	}
	return new RpcBridge(options);
}
