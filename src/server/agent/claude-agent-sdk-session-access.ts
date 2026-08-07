import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ClaudeAgentSdkUnavailableError, isClaudeAgentSdkSessionId } from "./claude-agent-sdk-bridge.js";
import { isSandboxContainerCwd } from "./docker-exec-spawn.js";

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
	/** Read-only SDK API backed by the existing sandbox container, when applicable. */
	sandboxSdk?: ClaudeAgentSdkSessionApi;
}

export interface SdkSessionAccessInput {
	sessionId: string;
	cwd?: string;
}

function sanitizedErrorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw.replace(/(token|secret|key|authorization)\s*[:=]\s*[^\s,;]+/ig, "$1=<redacted>").slice(0, 500);
}

function unavailable(operation: string, error?: unknown): ClaudeAgentSdkUnavailableError {
	if (error instanceof ClaudeAgentSdkUnavailableError) return error;
	const detail = error === undefined ? "session was not found" : sanitizedErrorMessage(error);
	return new ClaudeAgentSdkUnavailableError(`SDK_SESSION_UNAVAILABLE: ${operation}: ${detail}`);
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
		return await work(deps.sandboxSdk ?? await deps.loadSdk());
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

const execFileAsync = promisify(execFile);
const MAX_SANDBOX_SDK_ACCESS_BYTES = 1_000_000;
const SANDBOX_SDK_READER = `
const [operation, sessionId, cwd] = process.argv.slice(1);
const sdk = await import("@anthropic-ai/claude-agent-sdk");
const value = operation === "info"
  ? await sdk.getSessionInfo(sessionId, { dir: cwd })
  : await sdk.getSessionMessages(sessionId, { dir: cwd });
process.stdout.write(JSON.stringify(value ?? null));
`;

/**
 * Read SDK-owned state in the pooled container. This command has no OAuth or
 * gateway environment and only invokes SDK read APIs against the stable mount.
 */
export function createSandboxClaudeAgentSdkSessionAccess(input: {
	containerId: string;
	cwd: string;
	bobbitSessionId: string;
	exec?: (args: string[]) => Promise<string>;
}): ClaudeAgentSdkSessionApi {
	if (!input.containerId || !isSandboxContainerCwd(input.cwd)) {
		throw unavailable("sandbox session access is unavailable");
	}
	const dir = `/bobbit-state/claude-agent-sdk/${input.bobbitSessionId}`;
	const execute = input.exec ?? (async (args: string[]) => {
		const { stdout } = await execFileAsync("docker", args, {
			maxBuffer: MAX_SANDBOX_SDK_ACCESS_BYTES,
			env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
		});
		return stdout;
	});
	const read = async <T>(operation: "info" | "messages", sessionId: string): Promise<T> => {
		const output = await execute([
			"exec", "-i", "-w", input.cwd,
			"-e", "HOME=/home/node", "-e", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			"-e", `CLAUDE_CONFIG_DIR=${dir}`,
			input.containerId, "node", "--input-type=module", "-e", SANDBOX_SDK_READER, operation, sessionId, input.cwd,
		]);
		if (Buffer.byteLength(output) > MAX_SANDBOX_SDK_ACCESS_BYTES) throw new Error("sandbox SDK response exceeds limit");
		try { return JSON.parse(output) as T; }
		catch { throw new Error("sandbox SDK returned invalid JSON"); }
	};
	return {
		getSessionInfo: async (sessionId) => (await read<SdkSessionInfo | null>("info", sessionId)) ?? undefined,
		getSessionMessages: async (sessionId) => {
			const messages = await read<unknown>("messages", sessionId);
			if (!Array.isArray(messages)) throw new Error("sandbox SDK messages are invalid");
			return messages as SdkSessionMessage[];
		},
	};
}

let sdkPromise: Promise<ClaudeAgentSdkSessionApi> | undefined;
function loadSdk(): Promise<ClaudeAgentSdkSessionApi> {
	sdkPromise ??= import("@anthropic-ai/claude-agent-sdk") as Promise<ClaudeAgentSdkSessionApi>;
	return sdkPromise;
}

export const defaultClaudeAgentSdkSessionAccessDeps: ClaudeAgentSdkSessionAccessDeps = { loadSdk };
