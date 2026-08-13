import type { AgentDefinition, CanUseTool, McpSdkServerConfigWithInstance, Options, PermissionResult, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z, type ZodTypeAny } from "zod";

/** The pinned Claude Code 2.1.222 native inventory, owned in one place. */
export const CLAUDE_NATIVE_TOOL_FLOOR = [
	"Task", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Skill",
	"NotebookEdit", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
	"Monitor", "ScheduleWakeup", "PushNotification", "RemoteTrigger", "CronCreate", "CronDelete", "CronList",
	"TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "ToolSearch",
] as const;

/** Reviewed bundled Claude Code skill pin for Agent SDK 0.3.222 / Claude 2.1.222. */
export const CLAUDE_BUNDLED_SKILLS_0_3_222 = [
	"batch", "claude-api", "code-review", "dataviz", "debug", "deep-research", "design-sync",
	"doctor", "fewer-permission-prompts", "loop", "run", "run-skill-generator", "simplify", "update-config", "verify",
] as const;

const RETAINED_NATIVE_TOOLS = ["Skill", "Agent"] as const;
const RESERVED_NATIVE_TOOLS = ["Agent"] as const;
const SUPPRESSED_NATIVE_TOOLS = CLAUDE_NATIVE_TOOL_FLOOR.filter((name) => name !== "Skill");

/** Immutable policy consumed by both SDK option assembly and permission checks. */
export const CLAUDE_NATIVE_TOOL_POLICY = Object.freeze({
	floor: CLAUDE_NATIVE_TOOL_FLOOR,
	retained: RETAINED_NATIVE_TOOLS,
	reserved: RESERVED_NATIVE_TOOLS,
	suppressed: SUPPRESSED_NATIVE_TOOLS,
	disallowed: SUPPRESSED_NATIVE_TOOLS,
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

export interface ClaudeSdkSubagentRoleSnapshot {
	readonly name: string;
	readonly promptTemplate: string;
}

export interface ClaudeSdkSubagentDefinition {
	readonly type: string;
	readonly sourceRole: string;
	readonly definition: Readonly<AgentDefinition>;
	readonly childRawTools: readonly string[];
}

export interface ClaudeSdkSubagentRegistryEntry {
	readonly agentId: string;
	readonly agentType: string;
	/** The bounded root Agent tool-use that admitted this child. */
	readonly toolUseId: string;
	readonly startedAt: number;
}

/** Lifecycle facts emitted only for entries already admitted by the policy registry. */
export interface ClaudeSdkSubagentLifecycleEvent {
	readonly kind: "start" | "stop" | "aborted";
	readonly entry: ClaudeSdkSubagentRegistryEntry;
	readonly at: number;
}

export type ClaudeSdkSubagentAuditEvent = Readonly<{
	sessionId: string;
	outcome: "admitted" | "denied" | "started" | "stopped" | "diagnostic";
	toolUseId?: string;
	agentId?: string;
	agentType?: string;
	parentToolUseId?: string;
	durationMs?: number;
}>;

export interface ClaudeSdkSubagentPolicy {
	readonly definitions: Readonly<Record<string, AgentDefinition>>;
	readonly byType: ReadonlyMap<string, ClaudeSdkSubagentDefinition>;
	readonly maxConcurrent: 1;
	readonly active: ReadonlyMap<string, ClaudeSdkSubagentRegistryEntry>;
	readonly audit: (event: ClaudeSdkSubagentAuditEvent) => void;
	readonly admit: (rawName: unknown, input: unknown, context: { agentId?: unknown; toolUseId?: string; permissionMode?: unknown }) => boolean;
	readonly authorizeChild: (rawName: unknown, agentId: unknown, agentType?: unknown) => boolean;
	/** Uses only the fields provided by the pinned SubagentStart hook. */
	readonly onStart: (input: { agent_id?: unknown; agent_type?: unknown }) => boolean;
	readonly onStop: (input: { agent_id?: unknown; agent_type?: unknown }) => void;
	/** Emits only facts derived from an already-admitted active registry entry. */
	readonly subscribe: (listener: (event: ClaudeSdkSubagentLifecycleEvent) => void) => () => void;
	readonly clear: () => void;
	readonly dispose: () => void;
}

export interface ClaudeSdkSubagentPolicyOptions {
	sessionId: string;
	roles: Readonly<Record<string, ClaudeSdkSubagentRoleSnapshot | undefined>>;
	entries: readonly (ClaudeSdkToolEntry | ClaudeSdkToolEntryInput)[];
	goalBranch?: string;
	audit?: (event: ClaudeSdkSubagentAuditEvent) => void;
}

export interface ClaudeSdkToolSurfaceOptions {
	sessionId: string;
	restriction: "unrestricted" | "restricted";
	entries: readonly ClaudeSdkToolEntryInput[];
	subagentPolicy?: ClaudeSdkSubagentPolicy;
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
	readonly subagentPolicy?: ClaudeSdkSubagentPolicy;
	readonly server: McpSdkServerConfigWithInstance;
	readonly canUseTool: CanUseTool;
	readonly preToolUseMatcher: NonNullable<Options["hooks"]>["PreToolUse"] extends (infer V)[] | undefined ? V : never;
	readonly subagentStartMatcher: NonNullable<Options["hooks"]>["SubagentStart"] extends (infer V)[] | undefined ? V : never;
	readonly subagentStopMatcher: NonNullable<Options["hooks"]>["SubagentStop"] extends (infer V)[] | undefined ? V : never;
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

const APPROVED_SUBAGENTS = [
	{ type: "bobbit-protocol-scout", role: "claude-protocol-scout", description: "Investigate the installed Claude Agent SDK protocol with bounded empirical evidence.", effort: "high", maxTurns: 6 },
	{ type: "bobbit-backend-parity-reviewer", role: "backend-parity-reviewer", description: "Review a narrowly scoped Claude SDK and Pi runtime parity question.", effort: "medium", maxTurns: 4 },
	{ type: "bobbit-billing-safety-auditor", role: "billing-safety-auditor", description: "Review a narrowly scoped Claude SDK subscription-safety question.", effort: "medium", maxTurns: 4 },
] as const;
const CHILD_CANONICAL_TOOLS = ["read", "find", "grep"] as const;
const MAX_SUBAGENT_PROMPT_BYTES = 8 * 1024;
const MAX_SUBAGENT_ID_BYTES = 512;
const SUBAGENT_DENIAL = "Subagent request is not available in this Bobbit session.";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function boundedString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_SUBAGENT_PROMPT_BYTES;
}

function boundedSubagentId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_SUBAGENT_ID_BYTES;
}

/**
 * Build immutable, query-local SDK projections of the only approved Bobbit
 * roles. This never reads role files: session setup supplies the cascade result.
 */
export function buildClaudeSdkSubagentPolicy(options: ClaudeSdkSubagentPolicyOptions): ClaudeSdkSubagentPolicy {
	const audit = (event: ClaudeSdkSubagentAuditEvent): void => {
		const row = Object.freeze({ ...event });
		try {
			if (options.audit) options.audit(row);
			else console.info("[claude-agent-sdk] subagent", row);
		} catch { /* audit isolation */ }
	};
	const byType = new Map<string, ClaudeSdkSubagentDefinition>();
	const definitions: Record<string, AgentDefinition> = Object.create(null);
	const normalizedEntries = options.entries.map((entry): ClaudeSdkToolEntry => "rawName" in entry
		? entry : Object.freeze({ ...entry, rawName: `${SDK_PREFIX}${entry.name}` }));
	const entriesByCanonical = new Map(normalizedEntries.map(entry => [entry.name.toLowerCase(), entry]));
	const childRawTools = CHILD_CANONICAL_TOOLS.map((name) => entriesByCanonical.get(name));

	for (const approved of APPROVED_SUBAGENTS) {
		const role = options.roles[approved.role];
		if (!role || role.name !== approved.role || typeof role.promptTemplate !== "string" || !role.promptTemplate.trim()) {
			throw diagnostic(options.sessionId, `approved subagent role ${approved.role} is unavailable`);
		}
		// A child only receives Bobbit tools that are selected on the root's D1
		// surface and auto-allowed there. An ask/never root policy cannot be used
		// to smuggle an interactive or broader child permission path.
		const selected = childRawTools.filter((entry): entry is ClaudeSdkToolEntry => !!entry && entry.policy === "allow");
		const prompt = role.promptTemplate
			.replace(/\{\{GOAL_BRANCH\}\}/g, options.goalBranch ?? "")
			.replace(/\{\{AGENT_ID\}\}/g, `sdk-${options.sessionId.slice(0, 64)}`);
		if (!prompt.trim()) throw diagnostic(options.sessionId, `approved subagent role ${approved.role} has an invalid prompt`);
		const selectedRaw = selected.map(entry => entry.rawName);
		const disallowedMcp = normalizedEntries.filter(entry => !selectedRaw.includes(entry.rawName)).map(entry => entry.rawName);
		const definition: AgentDefinition = Object.freeze({
			description: approved.description,
			prompt,
			model: "inherit",
			effort: approved.effort,
			maxTurns: approved.maxTurns,
			background: false,
			permissionMode: "default",
			tools: ["Skill", ...selectedRaw],
			disallowedTools: ["Agent", ...CLAUDE_NATIVE_TOOL_POLICY.disallowed, ...disallowedMcp],
			skills: [...CLAUDE_BUNDLED_SKILLS_0_3_222],
		});
		const projection: ClaudeSdkSubagentDefinition = Object.freeze({ type: approved.type, sourceRole: approved.role, definition, childRawTools: Object.freeze(selectedRaw) });
		byType.set(approved.type, projection);
		definitions[approved.type] = definition;
	}

	const active = new Map<string, ClaudeSdkSubagentRegistryEntry>();
	const admissions = new Map<string, Readonly<{ agentType?: string; admitted: boolean }>>();
	const lifecycleListeners = new Set<(event: ClaudeSdkSubagentLifecycleEvent) => void>();
	const publishLifecycle = (kind: ClaudeSdkSubagentLifecycleEvent["kind"], entry: ClaudeSdkSubagentRegistryEntry): void => {
		const event = Object.freeze({ kind, entry, at: Date.now() });
		for (const listener of lifecycleListeners) {
			try { listener(event); } catch { /* lifecycle observers are display-only */ }
		}
	};
	let pending: Readonly<{ toolUseId: string; agentType: string }> | undefined;
	let disposed = false;
	const record = (outcome: ClaudeSdkSubagentAuditEvent["outcome"], values: Omit<ClaudeSdkSubagentAuditEvent, "sessionId" | "outcome"> = {}) =>
		audit({ sessionId: options.sessionId.slice(0, 128), outcome, ...values });
	const rememberAdmission = (toolUseId: string, agentType: string | undefined, admitted: boolean): void => {
		admissions.set(toolUseId, Object.freeze({ agentType, admitted }));
		while (admissions.size > MAX_APPROVALS) admissions.delete(admissions.keys().next().value!);
	};
	const admit = (rawName: unknown, input: unknown, context: { agentId?: unknown; toolUseId?: string; permissionMode?: unknown }): boolean => {
		const toolUseId = context.toolUseId;
		if (!boundedSubagentId(toolUseId)) {
			record("denied");
			return false;
		}
		const inputType = isPlainRecord(input) && typeof input.subagent_type === "string" && byType.has(input.subagent_type)
			? input.subagent_type : undefined;
		const prior = admissions.get(toolUseId);
		if (prior) return prior.admitted && prior.agentType === inputType;

		let allowed = false;
		if (!disposed && typeof rawName === "string" && rawName.toLowerCase() === "agent" && !context.agentId
			&& context.permissionMode === "default" && isPlainRecord(input)) {
			const keys = Object.keys(input);
			allowed = (keys.length === 3 || keys.length === 4)
				&& !keys.some(key => !["description", "subagent_type", "prompt", "run_in_background"].includes(key))
				&& (!("description" in input) || boundedString(input.description))
				&& typeof input.subagent_type === "string" && byType.has(input.subagent_type)
				&& boundedString(input.prompt) && input.run_in_background === false
				&& !pending && active.size === 0;
		}
		rememberAdmission(toolUseId, inputType, allowed);
		if (!allowed) {
			record("denied", { toolUseId, ...(inputType ? { agentType: inputType } : {}) });
			return false;
		}
		pending = Object.freeze({ toolUseId, agentType: inputType! });
		record("admitted", { toolUseId, agentType: inputType! });
		return true;
	};
	const authorizeChild = (rawName: unknown, agentId: unknown, agentType?: unknown): boolean => {
		if (disposed || !boundedSubagentId(agentId)) return false;
		const entry = active.get(agentId);
		if (!entry || (agentType !== undefined && agentType !== entry.agentType)) return false;
		if (typeof rawName !== "string") return false;
		if (rawName.toLowerCase() === "skill") return true;
		return byType.get(entry.agentType)?.childRawTools.some(name => name.toLowerCase() === rawName.toLowerCase()) ?? false;
	};
	const onStart = (input: { agent_id?: unknown; agent_type?: unknown }): boolean => {
		if (disposed || !boundedSubagentId(input.agent_id) || typeof input.agent_type !== "string" || !byType.has(input.agent_type)
			|| !pending || pending.agentType !== input.agent_type || active.size !== 0 || active.has(input.agent_id)) {
			record("diagnostic", { ...(typeof input.agent_type === "string" && byType.has(input.agent_type) ? { agentType: input.agent_type } : {}) });
			return false;
		}
		const entry = Object.freeze({ agentId: input.agent_id, agentType: input.agent_type, toolUseId: pending.toolUseId, startedAt: Date.now() });
		pending = undefined;
		active.set(entry.agentId, entry);
		record("started", { toolUseId: entry.toolUseId, agentId: entry.agentId, agentType: entry.agentType });
		publishLifecycle("start", entry);
		return true;
	};
	const onStop = (input: { agent_id?: unknown; agent_type?: unknown }): void => {
		if (!boundedSubagentId(input.agent_id) || typeof input.agent_type !== "string") { record("diagnostic"); return; }
		const entry = active.get(input.agent_id);
		if (!entry || entry.agentType !== input.agent_type) {
			record("diagnostic", { agentId: input.agent_id, ...(byType.has(input.agent_type) ? { agentType: input.agent_type } : {}) });
			return;
		}
		// Publish while the matching entry is still active, so observers cannot use
		// a stop hook to fabricate a new identity or race a replacement child.
		publishLifecycle("stop", entry);
		active.delete(input.agent_id);
		// Do not trust a hook-supplied parent id in audit output: retain only the
		// bounded id that originally admitted this exact child.
		record("stopped", { toolUseId: entry.toolUseId, agentId: entry.agentId, agentType: entry.agentType, parentToolUseId: entry.toolUseId, durationMs: Math.max(0, Date.now() - entry.startedAt) });
	};
	const subscribe = (listener: (event: ClaudeSdkSubagentLifecycleEvent) => void): (() => void) => {
		lifecycleListeners.add(listener);
		return () => lifecycleListeners.delete(listener);
	};
	const clear = (): void => {
		pending = undefined;
		// Terminalize each currently active entry exactly once before removing it.
		for (const entry of active.values()) publishLifecycle("aborted", entry);
		active.clear();
		admissions.clear();
	};
	return Object.freeze({
		definitions: Object.freeze(definitions), byType, maxConcurrent: 1 as const,
		get active() { return new Map(active); }, audit,
		admit, authorizeChild, onStart, onStop, subscribe, clear,
		dispose: () => { disposed = true; clear(); lifecycleListeners.clear(); },
	});
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

	const preDecision = (permissionDecision: "allow" | "ask" | "deny", reason?: string) => ({
		continue: true,
		hookSpecificOutput: {
			hookEventName: "PreToolUse" as const,
			permissionDecision,
			...(reason ? { permissionDecisionReason: reason } : {}),
		},
	});
	const canUseTool: CanUseTool = async (rawName, input, context) => {
		if (context.signal.aborted || disposed) return deny("Tool request was cancelled or unavailable.");
		const agentId = context.agentID;
		if (agentId) {
			return options.subagentPolicy?.authorizeChild(rawName, agentId) ? allow() : deny(SUBAGENT_DENIAL);
		}
		if (typeof rawName === "string" && rawName.toLowerCase() === "agent") {
			// Query options fix the root permission mode to default; the pinned
			// CanUseTool context does not expose it, so never infer caller input.
			return options.subagentPolicy?.admit(rawName, input, { toolUseId: context.toolUseID, permissionMode: "default" }) ? allow() : deny(SUBAGENT_DENIAL);
		}
		if (typeof rawName === "string" && rawName.toLowerCase() === "skill") return allow();
		const normalizedTool = normalized(rawName);
		if (!eligible(normalizedTool?.definition)) return deny("Tool is not available in this Bobbit session.");
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
		// agent_id and agent_type are the only subagent fields supplied by the
		// pinned PreToolUse hook. Root mode is fixed by query options below.
		const hookInput = input as PreToolUseHookInput & { agent_id?: unknown; agent_type?: unknown };
		if (disposed) return preDecision("deny", "Tool is not available in this Bobbit session.");
		if (hookInput.agent_id) return options.subagentPolicy?.authorizeChild(input.tool_name, hookInput.agent_id, hookInput.agent_type)
			? preDecision("allow") : preDecision("deny", SUBAGENT_DENIAL);
		if (typeof input.tool_name === "string" && input.tool_name.toLowerCase() === "agent") {
			return options.subagentPolicy?.admit(input.tool_name, input.tool_input, { toolUseId: input.tool_use_id, permissionMode: "default" })
				? preDecision("allow") : preDecision("deny", SUBAGENT_DENIAL);
		}
		if (typeof input.tool_name === "string" && input.tool_name.toLowerCase() === "skill") return preDecision("allow");
		const normalizedTool = normalized(input.tool_name);
		if (!eligible(normalizedTool?.definition)) return preDecision("deny", "Tool is not in the Bobbit surface.");
		const key = approvalKey(input.tool_use_id, normalizedTool!.canonicalName);
		if (normalizedTool!.definition.policy === "ask" && !(key && approvals.delete(key))) {
			// SDK invokes this hook before canUseTool. Ask lets the documented
			// permission callback obtain a Bobbit-bound approval; re-entry consumes it.
			return preDecision("ask");
		}
		return preDecision("allow");
	};
	const subagentStart = async (input: unknown) => {
		const value = input as { agent_id?: unknown; agent_type?: unknown };
		// An unregistered child is already fail-closed at both child tool gates.
		// Do not stop the root query merely because its child lifecycle is invalid.
		options.subagentPolicy?.onStart(value);
		return { continue: true };
	};
	const subagentStop = async (input: unknown) => {
		options.subagentPolicy?.onStop(input as { agent_id?: unknown; agent_type?: unknown });
		return { continue: true };
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
		...(options.subagentPolicy ? { subagentPolicy: options.subagentPolicy } : {}),
		server,
		canUseTool,
		preToolUseMatcher: [{ hooks: [preToolUse] }] as any,
		subagentStartMatcher: [{ hooks: [subagentStart] }] as any,
		subagentStopMatcher: [{ hooks: [subagentStop] }] as any,
		invoke,
		renderToolName: (rawName: string) => normalized(rawName)?.canonicalName,
		dispose: () => { disposed = true; approvals.clear(); options.subagentPolicy?.dispose(); },
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
	base: Pick<Options, "cwd" | "env" | "abortController" | "systemPrompt" | "model" | "resume" | "spawnClaudeCodeProcess">,
	preCompact?: NonNullable<Options["hooks"]>["PreCompact"],
): Options {
	return {
		...base,
		tools: [...RETAINED_NATIVE_TOOLS],
		disallowedTools: [...surface.sdkDisallowNames],
		allowedTools: ["Agent", ...surface.sdkAllowNames],
		agents: surface.subagentPolicy?.definitions ?? {},
		skills: [...CLAUDE_BUNDLED_SKILLS_0_3_222],
		mcpServers: { bobbit: surface.server },
		settingSources: [],
		strictMcpConfig: true,
		managedSettings: { autoMemoryEnabled: false },
		permissionMode: "default",
		canUseTool: surface.canUseTool,
		hooks: {
			...(preCompact ? { PreCompact: preCompact } : {}),
			PreToolUse: surface.preToolUseMatcher as any,
			SubagentStart: surface.subagentStartMatcher as any,
			SubagentStop: surface.subagentStopMatcher as any,
		},
	};
}
