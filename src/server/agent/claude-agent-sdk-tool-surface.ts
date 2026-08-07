import type { CanUseTool, McpSdkServerConfigWithInstance, Options, PermissionResult, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z, type ZodTypeAny } from "zod";

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
const CANONICAL_NAME = /^[a-z][a-z0-9_-]*$/;
const MAX_APPROVALS = 256;

export type ClaudeSdkToolPolicy = "allow" | "ask" | "never";
export type ClaudeSdkToolHandler = (args: Record<string, unknown>, context: { signal?: AbortSignal; toolUseId?: string }) => Promise<unknown>;

export interface ClaudeSdkToolEntryInput {
	name: string;
	description: string;
	group: string;
	/** The selected ToolManager/MCP schema; adapters must never use an untyped `{}` placeholder. */
	inputSchema: Record<string, unknown>;
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
	/** The existing SessionManager grant seam. It must cancel the UI waiter on abort. */
	requestToolGrant: (toolName: string, toolGroup: string, options: { signal: AbortSignal; toolUseId?: string }) => Promise<ClaudeSdkGrantResolution>;
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
	/** Testable canonical dispatch boundary used by SDK adapters. */
	readonly invoke: (rawName: string, args: Record<string, unknown>, context?: { signal?: AbortSignal; toolUseId?: string }) => Promise<unknown>;
	readonly renderToolName: (rawName: string) => string | undefined;
	readonly dispose?: () => void;
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

function approvalKey(toolUseId: string | undefined, canonicalName: string): string | undefined {
	return toolUseId ? `${toolUseId}\u0000${canonicalName.toLowerCase()}` : undefined;
}

/** Do not expose host paths, provider errors, or extension text to the model. */
function modelToolError(error: unknown): string {
	if (error instanceof Error && /cancel/i.test(error.message)) return "Tool call cancelled.";
	return "Bobbit tool execution failed.";
}

/** Adapt the ToolManager/MCP JSON-schema snapshot to the SDK's documented Zod raw shape. */
export function sdkZodShape(schema: Record<string, unknown>): Record<string, ZodTypeAny> {
	const record = (value: unknown): Record<string, unknown> | undefined =>
		value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
	const annotate = (value: ZodTypeAny, description: unknown): ZodTypeAny =>
		typeof description === "string" ? value.describe(description) : value;
	const literal = (value: unknown): ZodTypeAny => z.literal(value as string | number | boolean | null);
	const adapt = (value: Record<string, unknown>): ZodTypeAny => {
		const constant = value.const;
		if (constant !== undefined) return annotate(literal(constant), value.description);
		const values = Array.isArray(value.enum) ? value.enum : undefined;
		if (values?.length) {
			const variants = values.map(literal);
			return annotate(variants.length === 1 ? variants[0]! : z.union(variants as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]), value.description);
		}

		let adapted: ZodTypeAny;
		switch (value.type) {
			case "string": {
				let string = z.string();
				const min = number(value.minLength);
				const max = number(value.maxLength);
				if (min !== undefined) string = string.min(min);
				if (max !== undefined) string = string.max(max);
				if (typeof value.pattern === "string") {
					try { string = string.regex(new RegExp(value.pattern)); } catch { /* Invalid patterns remain worker-validated. */ }
				}
				adapted = string;
				break;
			}
			case "number":
			case "integer": {
				let numeric = value.type === "integer" ? z.number().int() : z.number();
				const min = number(value.minimum);
				const max = number(value.maximum);
				const exclusiveMin = number(value.exclusiveMinimum);
				const exclusiveMax = number(value.exclusiveMaximum);
				if (min !== undefined) numeric = value.exclusiveMinimum === true ? numeric.gt(min) : numeric.gte(min);
				if (max !== undefined) numeric = value.exclusiveMaximum === true ? numeric.lt(max) : numeric.lte(max);
				if (exclusiveMin !== undefined) numeric = numeric.gt(exclusiveMin);
				if (exclusiveMax !== undefined) numeric = numeric.lt(exclusiveMax);
				const multiple = number(value.multipleOf);
				if (multiple !== undefined && multiple > 0) numeric = numeric.multipleOf(multiple);
				adapted = numeric;
				break;
			}
			case "boolean": adapted = z.boolean(); break;
			case "array": {
				let array = z.array(record(value.items) ? adapt(value.items as Record<string, unknown>) : z.unknown());
				const min = number(value.minItems);
				const max = number(value.maxItems);
				if (min !== undefined) array = array.min(min);
				if (max !== undefined) array = array.max(max);
				adapted = array;
				break;
			}
			case "object": {
				const properties = record(value.properties) ?? {};
				const required = new Set(Array.isArray(value.required) ? value.required.filter((key): key is string => typeof key === "string") : []);
				const shape: Record<string, ZodTypeAny> = {};
				for (const [name, property] of Object.entries(properties)) {
					const propertyValue = record(property);
					const propertySchema = propertyValue ? adapt(propertyValue) : z.unknown();
					shape[name] = required.has(name) ? propertySchema : propertySchema.optional();
				}
				const object = z.object(shape);
				const additionalProperties = record(value.additionalProperties);
				if (value.additionalProperties === false) adapted = object.strict();
				else if (additionalProperties) adapted = object.catchall(adapt(additionalProperties));
				else adapted = object.passthrough();
				break;
			}
			default: adapted = z.unknown();
		}
		return annotate(adapted, value.description);
	};
	const properties = record(schema.properties) ?? {};
	const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : []);
	return Object.fromEntries(Object.entries(properties).map(([name, value]) => {
		const propertyValue = record(value);
		const property = propertyValue ? adapt(propertyValue) : z.unknown();
		return [name, required.has(name) ? property : property.optional()];
	}));
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
	let disposed = false;
	const rememberApproval = (toolUseId: string | undefined, canonicalName: string): void => {
		const key = approvalKey(toolUseId, canonicalName);
		if (!key) return;
		approvals.add(key);
		while (approvals.size > MAX_APPROVALS) approvals.delete(approvals.values().next().value!);
	};
	const normalized = (raw: unknown) => normalizeClaudeSdkMcpToolName(raw, byRaw);
	const eligible = (entry: ClaudeSdkToolEntry | undefined) => !disposed && !!entry && entry.policy !== "never";

	const canUseTool: CanUseTool = async (rawName, _input, context) => {
		const normalizedTool = normalized(rawName);
		if (!eligible(normalizedTool?.definition)) return deny("Tool is not available in this Bobbit session.");
		if (context.signal.aborted || context.agentID) return deny("Tool request was cancelled or originated from a subagent.");
		if (normalizedTool!.definition.policy === "allow") return allow();
		let grant: ClaudeSdkGrantResolution;
		try {
			grant = await options.requestToolGrant(normalizedTool!.canonicalName, normalizedTool!.definition.group, {
				signal: context.signal,
				toolUseId: context.toolUseID,
			});
		} catch {
			return deny("Tool permission was not granted.");
		}
		if (disposed || context.signal.aborted || !isCurrentGrant(grant, normalizedTool!.definition)) return deny("Tool permission was not granted.");
		// Approval is bound to both the exact SDK call and canonical Bobbit identity.
		rememberApproval(context.toolUseID, normalizedTool!.canonicalName);
		return allow();
	};

	const preToolUse = async (input: PreToolUseHookInput) => {
		const hookInput = input as PreToolUseHookInput & { agent_id?: unknown };
		const normalizedTool = normalized(input.tool_name);
		if (hookInput.agent_id || !eligible(normalizedTool?.definition)) return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: "Tool is not in the Bobbit surface." } };
		const key = approvalKey(input.tool_use_id, normalizedTool!.canonicalName);
		if (normalizedTool!.definition.policy === "ask" && !(key && approvals.delete(key))) {
			// SDK invokes this hook before canUseTool. Ask lets the documented
			// permission callback obtain a Bobbit-bound approval; re-entry consumes it.
			return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "ask" as const } };
		}
		return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const } };
	};

	const invoke = async (rawName: string, args: Record<string, unknown>, context: { signal?: AbortSignal; toolUseId?: string } = {}): Promise<unknown> => {
		const normalizedTool = normalized(rawName);
		if (!eligible(normalizedTool?.definition)) throw diagnostic(options.sessionId, "Tool is not available in this Bobbit session.");
		if (context.signal?.aborted || disposed) throw new Error("Tool call cancelled.");
		return normalizedTool!.definition.invoke(args, context);
	};
	const definitions = [...byRaw.values()].filter(eligible).map((entry) => tool(
		entry.name,
		entry.description,
		sdkZodShape(entry.inputSchema),
		async (args, extra: unknown) => {
			try {
				const extraContext = extra as { signal?: AbortSignal; toolUseId?: string; toolUseID?: string } | undefined;
				const signal = extraContext?.signal;
				if (signal?.aborted) return { content: [{ type: "text" as const, text: "Tool call cancelled." }], isError: true };
				const result = await invoke(entry.rawName, args as Record<string, unknown>, { signal, toolUseId: extraContext?.toolUseId ?? extraContext?.toolUseID });
				return typeof result === "object" && result !== null && "content" in result
					? result as any
					: { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result ?? null) }] };
			} catch (error) {
				return { content: [{ type: "text" as const, text: modelToolError(error) }], isError: true };
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
		invoke,
		renderToolName: (rawName: string) => normalized(rawName)?.canonicalName,
		dispose: () => { disposed = true; approvals.clear(); },
	});
}

/** Strict direct-bridge seam: absence of a session surface never loads SDK defaults. */
export function buildEmptyClaudeSdkToolSurface(sessionId = "direct-bridge"): ClaudeSdkToolSurface {
	return buildClaudeSdkToolSurface({
		sessionId,
		restriction: "restricted",
		entries: [],
		requestToolGrant: async () => ({ granted: false }),
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
