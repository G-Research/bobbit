import { isClaudeAgentSdkSessionId } from "./claude-agent-sdk-bridge.js";
import { ClaudeAgentSdkUnavailableError, normalizeClaudeAgentSdkUnavailableError } from "./claude-agent-sdk-error.js";

export interface SdkSessionInfo {
	readonly sessionId: string;
	readonly summary: string;
	readonly lastModified: number;
	readonly [key: string]: unknown;
}

/** The public, transcript-reading shape exposed by the pinned Agent SDK. */
export interface SdkSessionMessage {
	readonly type: "user" | "assistant" | "system";
	readonly uuid: string;
	readonly session_id: string;
	readonly message: unknown;
	readonly parent_tool_use_id: string | null;
	readonly parent_agent_id: string | null;
}

export interface ClaudeAgentSdkSessionApi {
	getSessionInfo(sessionId: string, options?: { dir?: string }): Promise<SdkSessionInfo | undefined>;
	getSessionMessages(sessionId: string, options?: { dir?: string; limit?: number; offset?: number; includeSystemMessages?: boolean }): Promise<SdkSessionMessage[]>;
}

export interface ClaudeAgentSdkSessionAccessDeps {
	/** Lazy by design: Pi-only sessions must not import the optional SDK bundle. */
	loadSdk: () => Promise<ClaudeAgentSdkSessionApi>;
}

export interface SdkSessionAccessInput {
	sessionId: string;
	cwd?: string;
}

function unavailable(_operation: string, error?: unknown): ClaudeAgentSdkUnavailableError {
	return normalizeClaudeAgentSdkUnavailableError(error);
}

function validate(input: SdkSessionAccessInput): void {
	if (!isClaudeAgentSdkSessionId(input.sessionId)) {
		throw unavailable("invalid SDK session identity");
	}
}

async function withSdk<T>(
	input: SdkSessionAccessInput,
	deps: ClaudeAgentSdkSessionAccessDeps,
	operation: string,
	work: (sdk: ClaudeAgentSdkSessionApi) => Promise<T>,
): Promise<T> {
	validate(input);
	try {
		return await work(await deps.loadSdk());
	} catch (error) {
		throw unavailable(operation, error);
	}
}

/** Read one SDK-owned session record without touching host transcript files. */
export async function readSdkSessionInfo(
	input: SdkSessionAccessInput,
	deps: ClaudeAgentSdkSessionAccessDeps = defaultClaudeAgentSdkSessionAccessDeps,
): Promise<SdkSessionInfo> {
	return withSdk(input, deps, "read session info", async (sdk) => {
		const info = await sdk.getSessionInfo(input.sessionId, { dir: input.cwd });
		if (!info) throw unavailable("read session info");
		return info;
	});
}

/**
 * Read SDK-owned history. The preceding info lookup distinguishes a real empty
 * transcript from the SDK's identical empty-array response for an absent one.
 */
export async function readSdkSessionMessages(
	input: SdkSessionAccessInput,
	deps: ClaudeAgentSdkSessionAccessDeps = defaultClaudeAgentSdkSessionAccessDeps,
): Promise<SdkSessionMessage[]> {
	return withSdk(input, deps, "read session messages", async (sdk) => {
		const info = await sdk.getSessionInfo(input.sessionId, { dir: input.cwd });
		if (!info) throw unavailable("read session messages");
		return sdk.getSessionMessages(input.sessionId, { dir: input.cwd });
	});
}

let sdkPromise: Promise<ClaudeAgentSdkSessionApi> | undefined;
function loadSdk(): Promise<ClaudeAgentSdkSessionApi> {
	sdkPromise ??= import("@anthropic-ai/claude-agent-sdk") as Promise<ClaudeAgentSdkSessionApi>;
	return sdkPromise;
}

export const defaultClaudeAgentSdkSessionAccessDeps: ClaudeAgentSdkSessionAccessDeps = { loadSdk };
