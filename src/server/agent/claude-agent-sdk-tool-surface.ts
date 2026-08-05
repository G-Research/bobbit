import type { CanUseTool, McpSdkServerConfigWithInstance, Options, PermissionResult, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

/** The pinned Claude Code 2.1.222 native inventory, owned in one place. */
export const CLAUDE_NATIVE_TOOL_FLOOR = [
	"Task", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Skill",
	"NotebookEdit", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
	"Monitor", "ScheduleWakeup", "PushNotification", "RemoteTrigger", "CronCreate", "CronDelete", "CronList",
	"TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "ToolSearch",
] as const;

const RETAINED_NATIVE_TOOLS = ["Skill"] as const;
const RESERVED_NATIVE_TOOLS = ["Agent"] as const;
const SUPPRESSED_NATIVE_TOOLS = CLAUDE_NATIVE_TOOL_FLOOR.filter((name) => name !== "Skill");

/** Immutable policy consumed by both SDK option assembly and permission checks. */
export const CLAUDE_NATIVE_TOOL_POLICY = Object.freeze({
	floor: CLAUDE_NATIVE_TOOL_FLOOR,
	retained: RETAINED_NATIVE_TOOLS,
	reserved: RESERVED_NATIVE_TOOLS,
	suppressed: SUPPRESSED_NATIVE_TOOLS,
	disallowed: [...SUPPRESSED_NATIVE_TOOLS, ...RESERVED_NATIVE_TOOLS],
});

const SDK_PREFIX = "mcp__bobbit__";
const CANONICAL_NAME = /^[a-z][a-z0-9_]*$/;
const MAX_APPROVALS = 256;

export type ClaudeSdkToolPolicy = "allow" | "ask" | "never";
export type ClaudeSdkToolHandler = (args: Record<string, unknown>, context: { signal?: AbortSignal; toolUseId?: string }) => Promise<unknown>;

export interface ClaudeSdkToolEntryInput {
	name: string;
	description: string;
	group: string;
	policy: ClaudeSdkToolPolicy;
	/** Existing dispatch surface. It is deliberately injected, never an HTTP callback. */
	invoke: ClaudeSdkToolHandler;
}

export interface ClaudeSdkToolEntry extends ClaudeSdkToolEntryInput {
	readonly rawName: string;
}

export interface ClaudeSdkGrantResolution {
	granted: boolean;
	tools?: readonly string[];
	group?: string;
	mode?: "one-time" | "session-only" | "persistent";
	reason?: string;
}

export interface ClaudeSdkToolSurfaceOptions {
	sessionId: string;
	restriction: "unrestricted" | "restricted";
	entries: readonly ClaudeSdkToolEntryInput[];
	requestToolGrant: (toolName: string, toolGroup: string) => Promise<ClaudeSdkGrantResolution>;
}

export interface ClaudeSdkNormalizedToolName {
	rawName: string;
	canonicalName: string;
	definition: ClaudeSdkToolEntry;
}

export interface ClaudeSdkToolSurface {
	readonly runtime: "claude-agent-sdk";
	readonly restriction: "unrestricted" | "restricted";
	readonly entriesBySdkRawLower: ReadonlyMap<string, ClaudeSdkToolEntry>;
	readonly entriesByCanonicalLower: ReadonlyMap<string, ClaudeSdkToolEntry>;
	readonly sdkAllowNames: readonly string[];
	readonly sdkDisallowNames: readonly string[];
	readonly policyFingerprint: string;
	readonly server: McpSdkServerConfigWithInstance;
	readonly canUseTool: CanUseTool;
	readonly preToolUseMatcher: NonNullable<Options["hooks"]>["PreToolUse"] extends (infer V)[] | undefined ? V : never;
}

export class ClaudeSdkToolSurfaceError extends Error {
	constructor(message: string) { super(message); this.name = "ClaudeSdkToolSurfaceError"; }
}

function diagnostic(sessionId: string, message: string): ClaudeSdkToolSurfaceError {
	return new ClaudeSdkToolSurfaceError(`[claude-agent-sdk][session=${sessionId.slice(0, 128)}] ${message.slice(0, 500)}`);
}

/**
 * Converts only a server-owned MCP identity. Native and foreign MCP identities
 * never become Bobbit tools simply because their suffix happens to match.
 */
export function normalizeClaudeSdkMcpToolName(
	rawName: unknown,
	entries: ReadonlyMap<string, ClaudeSdkToolEntry>,
): ClaudeSdkNormalizedToolName | undefined {
	if (typeof rawName !== "string" || rawName.length <= SDK_PREFIX.length) return undefined;
	const lower = rawName.toLowerCase();
	if (!lower.startsWith(SDK_PREFIX)) return undefined;
	const entry = entries.get(lower);
	if (!entry || entry.rawName.toLowerCase() !== lower) return undefined;
	return { rawName, canonicalName: entry.name, definition: entry };
}

function isCurrentGrant(grant: ClaudeSdkGrantResolution, entry: ClaudeSdkToolEntry): boolean {
	if (!grant.granted || !grant.tools?.some((name) => name.toLowerCase() === entry.name.toLowerCase())) return false;
	return !grant.group || grant.group.toLowerCase() === entry.group.toLowerCase();
}

function deny(message: string): PermissionResult { return { behavior: "deny", message: message.slice(0, 300) }; }
function allow(): PermissionResult { return { behavior: "allow", updatedInput: undefined }; }

function raceAbort<T>(signal: AbortSignal, operation: Promise<T>): Promise<T | undefined> {
	if (signal.aborted) return Promise.resolve(undefined);
	return new Promise((resolve, reject) => {
		const abort = () => resolve(undefined);
		signal.addEventListener("abort", abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** Build the sole SDK MCP server and all three independent policy ceilings. */
export function buildClaudeSdkToolSurface(options: ClaudeSdkToolSurfaceOptions): ClaudeSdkToolSurface {
	const byRaw = new Map<string, ClaudeSdkToolEntry>();
	const byCanonical = new Map<string, ClaudeSdkToolEntry>();
	for (const source of options.entries) {
		if (!CANONICAL_NAME.test(source.name)) throw diagnostic(options.sessionId, `invalid canonical tool name ${JSON.stringify(source.name)}`);
		const canonicalLower = source.name.toLowerCase();
		const rawName = `${SDK_PREFIX}${source.name}`;
		const rawLower = rawName.toLowerCase();
		// `read` and `bash` are valid Bobbit replacements. Their SDK identities are
		// MCP-prefixed, so they cannot collide with native `Read`/`Bash`; only an
		// attempted already-prefixed adapter identity is reserved.
		if (source.name.toLowerCase().startsWith(SDK_PREFIX) || RESERVED_NATIVE_TOOLS.some((name) => name.toLowerCase() === canonicalLower)) {
			throw diagnostic(options.sessionId, `reserved or colliding tool name ${JSON.stringify(source.name)}`);
		}
		if (byCanonical.has(canonicalLower) || byRaw.has(rawLower)) throw diagnostic(options.sessionId, `ambiguous SDK tool identity ${JSON.stringify(source.name)}`);
		const entry: ClaudeSdkToolEntry = Object.freeze({ ...source, rawName });
		byCanonical.set(canonicalLower, entry);
		byRaw.set(rawLower, entry);
	}

	const approvals = new Set<string>();
	const rememberApproval = (toolUseId: string | undefined): void => {
		if (!toolUseId) return;
		approvals.add(toolUseId);
		while (approvals.size > MAX_APPROVALS) approvals.delete(approvals.values().next().value!);
	};
	const normalized = (raw: unknown) => normalizeClaudeSdkMcpToolName(raw, byRaw);
	const eligible = (entry: ClaudeSdkToolEntry | undefined) => !!entry && entry.policy !== "never";

	const canUseTool: CanUseTool = async (rawName, _input, context) => {
		const tool = normalized(rawName);
		if (!eligible(tool?.definition)) return deny("Tool is not available in this Bobbit session.");
		if (context.signal.aborted || context.agentID) return deny("Tool request was cancelled or originated from a subagent.");
		if (tool!.definition.policy === "allow") return allow();
		const grant = await raceAbort(context.signal, options.requestToolGrant(tool!.canonicalName, tool!.definition.group));
		if (!grant || context.signal.aborted || !isCurrentGrant(grant, tool!.definition)) return deny(grant?.reason ?? "Tool permission was not granted.");
		// One-time approvals are intentionally scoped to this SDK tool use only.
		rememberApproval(context.toolUseID);
		return allow();
	};

	const preToolUse = async (input: PreToolUseHookInput) => {
		const tool = normalized(input.tool_name);
		if (!eligible(tool?.definition)) return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: "Tool is not in the Bobbit surface." } };
		const permitted = tool!.definition.policy === "allow" || approvals.delete(input.tool_use_id);
		return permitted
			? { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const } }
			: { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: "Tool needs a current Bobbit grant." } };
	};

	const definitions = [...byRaw.values()].filter(eligible).map((entry) => tool(
		entry.name,
		entry.description,
		{},
		async (args, extra: unknown) => {
			try {
				const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
				if (signal?.aborted) return { content: [{ type: "text" as const, text: "Tool call cancelled." }], isError: true };
				const result = await entry.invoke(args as Record<string, unknown>, { signal });
				return typeof result === "object" && result !== null && "content" in result
					? result as any
					: { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result ?? null) }] };
			} catch (error) {
				return { content: [{ type: "text" as const, text: `Tool failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}` }], isError: true };
			}
		},
		{ alwaysLoad: true },
	));
	const server = createSdkMcpServer({ name: "bobbit", alwaysLoad: true, tools: definitions });
	const sdkAllowNames = [...byRaw.values()].filter((entry) => entry.policy === "allow").map((entry) => entry.rawName).sort();
	return Object.freeze({
		runtime: "claude-agent-sdk" as const,
		restriction: options.restriction,
		entriesBySdkRawLower: byRaw,
		entriesByCanonicalLower: byCanonical,
		sdkAllowNames,
		sdkDisallowNames: CLAUDE_NATIVE_TOOL_POLICY.disallowed,
		policyFingerprint: [...byRaw.values()].map((entry) => `${entry.name}:${entry.policy}:${entry.group}`).sort().join("|"),
		server,
		canUseTool,
		preToolUseMatcher: [{ hooks: [preToolUse] }] as any,
	});
}

/** The only supported Agent SDK query posture. It never merges caller settings. */
export function buildClaudeAgentSdkQueryOptions(
	surface: ClaudeSdkToolSurface,
	base: Pick<Options, "cwd" | "env" | "abortController" | "systemPrompt" | "model" | "resume">,
	preCompact?: NonNullable<Options["hooks"]>["PreCompact"],
): Options {
	return {
		...base,
		tools: [...RETAINED_NATIVE_TOOLS],
		disallowedTools: [...surface.sdkDisallowNames],
		allowedTools: [...surface.sdkAllowNames],
		agents: {},
		mcpServers: { bobbit: surface.server },
		settingSources: [],
		strictMcpConfig: true,
		managedSettings: { autoMemoryEnabled: false },
		permissionMode: "default",
		canUseTool: surface.canUseTool,
		hooks: { ...(preCompact ? { PreCompact: preCompact } : {}), PreToolUse: surface.preToolUseMatcher as any },
	};
}
