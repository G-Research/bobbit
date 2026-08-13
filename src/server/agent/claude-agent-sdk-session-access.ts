import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isClaudeAgentSdkSessionId } from "./claude-agent-sdk-bridge.js";
import { ClaudeAgentSdkUnavailableError, normalizeClaudeAgentSdkUnavailableError } from "./claude-agent-sdk-error.js";
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
	/** Pinned SDK API: values are child ids, never parent/lifecycle records. */
	listSubagents(sessionId: string, options?: { dir?: string }): Promise<string[]>;
	getSubagentMessages(sessionId: string, agentId: string, options?: { dir?: string; limit?: number; offset?: number }): Promise<SdkSessionMessage[]>;
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

const MAX_SUBAGENT_ID_BYTES = 512;

function isSubagentId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_SUBAGENT_ID_BYTES;
}

/** Read official child identities. An identity is never treated as a parent mapping. */
export async function readSdkSubagents(
	input: SdkSessionAccessInput,
	deps: ClaudeAgentSdkSessionAccessDeps = defaultClaudeAgentSdkSessionAccessDeps,
): Promise<string[]> {
	return withSdk(input, deps, "read subagents", async (sdk) => {
		const ids = await sdk.listSubagents(input.sessionId, { dir: input.cwd });
		if (!Array.isArray(ids) || ids.some((id) => !isSubagentId(id))) throw unavailable("read subagents", new Error("SDK subagent identities are invalid"));
		return ids;
	});
}

/**
 * Read one official child transcript. Its parent relationship remains on each
 * row and must be checked by the caller before any rendering projection.
 */
export async function readSdkSubagentMessages(
	input: SdkSessionAccessInput & { agentId: string; limit?: number },
	deps: ClaudeAgentSdkSessionAccessDeps = defaultClaudeAgentSdkSessionAccessDeps,
): Promise<SdkSessionMessage[]> {
	if (!isSubagentId(input.agentId)) throw unavailable("invalid SDK subagent identity");
	if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 0)) {
		throw unavailable("invalid SDK subagent message limit");
	}
	return withSdk(input, deps, "read subagent messages", (sdk) =>
		sdk.getSubagentMessages(input.sessionId, input.agentId, {
			dir: input.cwd,
			...(input.limit !== undefined ? { limit: input.limit } : {}),
		}));
}

const execFileAsync = promisify(execFile);
/** Each container invocation serializes at most one SDK API page. */
export const SANDBOX_SDK_HISTORY_PAGE_SIZE = 100;
export const MAX_SANDBOX_SDK_HISTORY_MESSAGES = 1_000;
export const MAX_SANDBOX_SDK_HISTORY_PAGE_BYTES = 4 * 1024 * 1024;
export const MAX_SANDBOX_SDK_HISTORY_TOTAL_BYTES = 16 * 1024 * 1024;
const SANDBOX_SDK_READER = `
// Keep operation at the historical argv position: deterministic Docker seams
// inspect it while the child-only agent id remains an explicit extra input.
const [agentId, operation, sessionId, cwd, limitText, offsetText, includeSystemText] = process.argv.slice(1);
const sdk = await import("@anthropic-ai/claude-agent-sdk");
const limit = Number(limitText);
const offset = Number(offsetText);
const options = { dir: cwd, ...((operation === "messages" || operation === "subagentMessages") ? {
  limit,
  offset,
  ...(includeSystemText === "true" ? { includeSystemMessages: true } : {}),
} : {}) };
const value = operation === "info"
  ? await sdk.getSessionInfo(sessionId, options)
  : operation === "messages"
    ? await sdk.getSessionMessages(sessionId, options)
    : operation === "subagents"
      ? await sdk.listSubagents(sessionId, options)
      : await sdk.getSubagentMessages(sessionId, agentId, options);
process.stdout.write(JSON.stringify(value ?? null));
`;

function boundedNonNegativeInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Read SDK-owned state in the pooled container. This command has no OAuth or
 * gateway environment and only invokes SDK read APIs against the stable mount.
 * History is deliberately fetched page-by-page so neither the container nor the
 * host serializes an unbounded transcript in one operation.
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
			maxBuffer: MAX_SANDBOX_SDK_HISTORY_PAGE_BYTES,
			env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
		});
		return stdout;
	});
	const read = async <T>(request: {
		operation: "info" | "messages" | "subagents" | "subagentMessages";
		sessionId: string;
		agentId?: string;
		limit?: number;
		offset?: number;
		includeSystemMessages?: boolean;
	}): Promise<T> => {
		const output = await execute([
			"exec", "-i", "-w", input.cwd,
			"-e", "HOME=/home/node", "-e", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			"-e", `CLAUDE_CONFIG_DIR=${dir}`,
			input.containerId, "node", "--input-type=module", "-e", SANDBOX_SDK_READER,
			request.agentId ?? "", request.operation, request.sessionId, input.cwd,
			String(request.limit ?? 0), String(request.offset ?? 0), String(request.includeSystemMessages === true),
		]);
		if (Buffer.byteLength(output) > MAX_SANDBOX_SDK_HISTORY_PAGE_BYTES) throw new Error("sandbox SDK response page exceeds limit");
		try { return JSON.parse(output) as T; }
		catch { throw new Error("sandbox SDK returned invalid JSON"); }
	};
	const readMessages = async (
		operation: "messages" | "subagentMessages",
		sessionId: string,
		agentId: string | undefined,
		options: { limit?: number; offset?: number; includeSystemMessages?: boolean } | undefined,
	): Promise<SdkSessionMessage[]> => {
		const requested = boundedNonNegativeInteger(options?.limit, MAX_SANDBOX_SDK_HISTORY_MESSAGES);
		const target = Math.min(requested, MAX_SANDBOX_SDK_HISTORY_MESSAGES);
		let offset = boundedNonNegativeInteger(options?.offset, 0);
		let bytes = 0;
		const messages: SdkSessionMessage[] = [];
		while (messages.length < target) {
			const limit = Math.min(SANDBOX_SDK_HISTORY_PAGE_SIZE, target - messages.length);
			const page = await read<unknown>({ operation, sessionId, agentId, limit, offset, includeSystemMessages: options?.includeSystemMessages });
			if (!Array.isArray(page)) throw new Error("sandbox SDK messages are invalid");
			if (page.length > limit) throw new Error("sandbox SDK returned more messages than requested");
			const pageBytes = Buffer.byteLength(JSON.stringify(page));
			if (bytes + pageBytes > MAX_SANDBOX_SDK_HISTORY_TOTAL_BYTES) throw new Error("sandbox SDK history exceeds cumulative byte limit");
			bytes += pageBytes;
			messages.push(...page as SdkSessionMessage[]);
			if (page.length < limit) break;
			offset += page.length;
		}
		return messages;
	};
	return {
		getSessionInfo: async (sessionId) => (await read<SdkSessionInfo | null>({ operation: "info", sessionId })) ?? undefined,
		getSessionMessages: async (sessionId, options) => readMessages("messages", sessionId, undefined, options),
		listSubagents: async (sessionId) => {
			const ids = await read<unknown>({ operation: "subagents", sessionId });
			if (!Array.isArray(ids) || ids.some((id) => !isSubagentId(id))) throw new Error("sandbox SDK subagent identities are invalid");
			return ids;
		},
		getSubagentMessages: async (sessionId, agentId, options) => {
			if (!isSubagentId(agentId)) throw new Error("sandbox SDK subagent identity is invalid");
			return readMessages("subagentMessages", sessionId, agentId, options);
		},
	};
}

let sdkPromise: Promise<ClaudeAgentSdkSessionApi> | undefined;
function loadSdk(): Promise<ClaudeAgentSdkSessionApi> {
	sdkPromise ??= import("@anthropic-ai/claude-agent-sdk") as Promise<ClaudeAgentSdkSessionApi>;
	return sdkPromise;
}

export const defaultClaudeAgentSdkSessionAccessDeps: ClaudeAgentSdkSessionAccessDeps = { loadSdk };
