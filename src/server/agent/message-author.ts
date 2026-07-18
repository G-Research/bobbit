import {
	LOCAL_USER_AUTHOR,
	MAX_MESSAGE_AUTHOR_LABEL_LENGTH,
	isMessageAuthor,
	type BobbitMessage,
	type MessageAuthor,
	type MessageAuthorKind,
} from "../../shared/message-author.js";
import type { PromptSource } from "../../shared/prompt-source.js";
import type { PersistedStaff } from "./staff-store.js";
import type { Role } from "./role-store.js";

export interface AgentSessionIdentity {
	id: string;
	title?: string;
	role?: string;
	staffId?: string;
}

export interface AgentAuthorDependencies {
	getStaff?: (id: string) => PersistedStaff | undefined;
	getRole?: (name: string) => Role | undefined;
}

export const BOBBIT_SYSTEM_AUTHOR: MessageAuthor = Object.freeze({
	kind: "system",
	id: "system:bobbit",
	label: "Bobbit",
});

export const DYNAMIC_CONTEXT_AUTHOR: MessageAuthor = Object.freeze({
	kind: "system",
	id: "system:bobbit:dynamic-context",
	label: "Bobbit context",
});

export const BATCH_SYSTEM_AUTHOR: MessageAuthor = Object.freeze({
	kind: "system",
	id: "system:bobbit:batch",
	label: "Bobbit",
});

function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

/** Sanitize one identity component; author ids are metadata, never path names. */
export function sanitizeAuthorIdComponent(
	value: string,
	fallback = "unknown",
	maxLength = 64,
): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "")
		.slice(0, Math.max(1, maxLength));
	if (normalized) return normalized;
	const safeFallback = fallback
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "")
		.slice(0, Math.max(1, maxLength));
	return safeFallback || "unknown";
}

function boundedLabel(value: string): string {
	return value.trim().slice(0, MAX_MESSAGE_AUTHOR_LABEL_LENGTH) || "Bobbit";
}

export function agentAuthorForSession(
	session: AgentSessionIdentity,
	deps: AgentAuthorDependencies = {},
): MessageAuthor {
	const staffId = nonEmpty(session.staffId);
	const staff = staffId ? deps.getStaff?.(staffId) : undefined;
	const roleName = nonEmpty(session.role);
	const role = roleName ? deps.getRole?.(roleName) : undefined;
	const label = nonEmpty(staff?.name)
		?? nonEmpty(session.title)
		?? nonEmpty(role?.label)
		?? nonEmpty(role?.name)
		?? roleName
		?? "Agent";
	return {
		kind: "agent",
		id: staffId
			? `staff:${sanitizeAuthorIdComponent(staffId, "unknown", 128)}`
			: `session:${sanitizeAuthorIdComponent(session.id, "unknown", 128)}`,
		label: boundedLabel(label),
	};
}

export function extensionSystemAuthor(packId: string, tool: string, label?: string): MessageAuthor {
	const fallbackLabel = `${nonEmpty(packId) ?? "extension"}/${nonEmpty(tool) ?? "tool"}`;
	return {
		kind: "system",
		id: `system:extension:${sanitizeAuthorIdComponent(packId, "extension")}:${sanitizeAuthorIdComponent(tool, "tool")}`,
		label: boundedLabel(nonEmpty(label) ?? fallbackLabel),
	};
}

/** Naming alias for call sites that read producer-first. */
export const systemAuthorForExtension = extensionSystemAuthor;

export function authorKindForPromptSource(source: PromptSource): MessageAuthorKind {
	if (source === "user") return "user";
	if (source === "agent") return "agent";
	return "system";
}

export interface ResolvePromptAuthorContext {
	/** Trusted caller/owner agent identity for an agent-to-agent prompt. */
	agentAuthor?: MessageAuthor;
	callerAuthor?: MessageAuthor;
	agentSession?: AgentSessionIdentity;
	callerSession?: AgentSessionIdentity;
	agentDeps?: AgentAuthorDependencies;
	/** Trusted producer-specific system identity, for example an extension surface. */
	systemAuthor?: MessageAuthor;
	extensionAuthor?: MessageAuthor;
}

export function resolvePromptAuthor(
	source: PromptSource,
	context: ResolvePromptAuthorContext = {},
): MessageAuthor {
	const kind = authorKindForPromptSource(source);
	if (kind === "user") return LOCAL_USER_AUTHOR;
	if (kind === "agent") {
		const suppliedAgent = context.agentAuthor ?? context.callerAuthor;
		if (isMessageAuthor(suppliedAgent) && suppliedAgent.kind === "agent") return suppliedAgent;
		const suppliedSession = context.agentSession ?? context.callerSession;
		if (suppliedSession) return agentAuthorForSession(suppliedSession, context.agentDeps);
		return BOBBIT_SYSTEM_AUTHOR;
	}
	const suppliedSystem = context.systemAuthor ?? context.extensionAuthor;
	if (isMessageAuthor(suppliedSystem) && suppliedSystem.kind === "system") {
		return suppliedSystem;
	}
	return BOBBIT_SYSTEM_AUTHOR;
}

export function isToolResultRole(role: unknown): boolean {
	return role === "toolResult" || role === "tool_result" || role === "tool";
}

export function isToolResultBlock(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const block = value as Record<string, unknown>;
	return block.type === "tool_result"
		|| block.type === "toolResult"
		|| isToolResultRole(block.role);
}

/** Provider histories may encode tool output as a user-role message of tool-result blocks. */
export function isToolResultOnlyMessage(message: unknown): boolean {
	if (!message || typeof message !== "object" || Array.isArray(message)) return false;
	const candidate = message as Record<string, unknown>;
	if (isToolResultRole(candidate.role)) return true;
	if (candidate.role !== "user" || !Array.isArray(candidate.content)) return false;
	let foundToolResult = false;
	for (const block of candidate.content) {
		if (isToolResultBlock(block)) {
			foundToolResult = true;
			continue;
		}
		if (
			block
			&& typeof block === "object"
			&& !Array.isArray(block)
			&& (block as Record<string, unknown>).type === "text"
			&& typeof (block as Record<string, unknown>).text === "string"
			&& ((block as Record<string, unknown>).text as string).trim() === ""
		) continue;
		return false;
	}
	return foundToolResult;
}

export const isToolResultMessage = isToolResultOnlyMessage;

function isCompactionSyntheticMessage(message: Record<string, unknown>): boolean {
	if (message.toolName === "__compaction_summary" || message.name === "__compaction_summary") return true;
	if (!Array.isArray(message.content)) return false;
	return message.content.some((part) => {
		if (!part || typeof part !== "object" || Array.isArray(part)) return false;
		const block = part as Record<string, unknown>;
		return block.name === "__compaction_summary"
			|| block.toolName === "__compaction_summary"
			|| (typeof block.id === "string" && block.id.startsWith("compaction-summary:"));
	});
}

function isSystemMessage(message: Record<string, unknown>): boolean {
	if (message.customType === "bobbit:dynamic-context") return true;
	if (message.display === false) return true;
	if (message.role === "system-notification" || message.role === "mutation-pending") return true;
	if (isCompactionSyntheticMessage(message)) return true;
	return message.role === "custom";
}

export interface NormalizeVisibleMessageContext extends AgentAuthorDependencies {
	session?: AgentSessionIdentity;
	agentDeps?: AgentAuthorDependencies;
	agentAuthor?: MessageAuthor;
	systemAuthor?: MessageAuthor;
	/** Preserve an existing author only after a Bobbit-owned boundary validated its provenance. */
	existingAuthorIsTrusted?: boolean;
	/** Author bound to this exact user echo by a live ledger or author sidecar. */
	promptAuthor?: MessageAuthor;
	/** Closest preceding accountable author, supplied by sequential normalization. */
	precedingAuthor?: MessageAuthor;
	/** Per-row prompt binding used when normalizing a snapshot. */
	promptAuthorForMessage?: (message: Record<string, unknown>, index: number) => MessageAuthor | undefined;
}

function sessionAgentAuthor(context: NormalizeVisibleMessageContext): MessageAuthor {
	if (isMessageAuthor(context.agentAuthor) && context.agentAuthor.kind === "agent") {
		return context.agentAuthor;
	}
	return agentAuthorForSession(
		context.session ?? { id: "unknown" },
		context.agentDeps ?? { getStaff: context.getStaff, getRole: context.getRole },
	);
}

function contextSystemAuthor(context: NormalizeVisibleMessageContext): MessageAuthor {
	if (isMessageAuthor(context.systemAuthor) && context.systemAuthor.kind === "system") {
		return context.systemAuthor;
	}
	return BOBBIT_SYSTEM_AUTHOR;
}

export function inferMessageAuthor(
	message: Record<string, unknown>,
	context: NormalizeVisibleMessageContext = {},
): MessageAuthor {
	if (isSystemMessage(message)) {
		return message.customType === "bobbit:dynamic-context"
			? DYNAMIC_CONTEXT_AUTHOR
			: contextSystemAuthor(context);
	}
	if (message.role === "assistant") return sessionAgentAuthor(context);
	if (isToolResultOnlyMessage(message)) {
		return isMessageAuthor(context.precedingAuthor)
			? context.precedingAuthor
			: sessionAgentAuthor(context);
	}
	if (message.role === "user" || message.role === "user-with-attachments") {
		return isMessageAuthor(context.promptAuthor) ? context.promptAuthor : LOCAL_USER_AUTHOR;
	}
	// Bobbit custom rows not represented by Pi's standard roles are server-created.
	return contextSystemAuthor(context);
}

/** Normalize one Bobbit-visible row without mutating the Pi-owned object. */
export function normalizeVisibleMessage<T extends object>(
	message: T,
	context: NormalizeVisibleMessageContext = {},
): BobbitMessage<T> {
	const raw = message as T & { author?: unknown };
	if (context.existingAuthorIsTrusted && isMessageAuthor(raw.author)) {
		return raw as BobbitMessage<T>;
	}
	return { ...message, author: inferMessageAuthor(message as Record<string, unknown>, context) };
}

/** Sequential normalization lets tool results inherit the closest accountable author. */
export function normalizeVisibleMessages<T extends object>(
	messages: T[],
	context: NormalizeVisibleMessageContext = {},
): Array<BobbitMessage<T>> {
	if (!Array.isArray(messages)) return messages;
	let precedingAuthor = isMessageAuthor(context.precedingAuthor) ? context.precedingAuthor : undefined;
	let changed = false;
	const normalized = messages.map((message, index) => {
		const promptAuthor = context.promptAuthorForMessage?.(message as Record<string, unknown>, index)
			?? context.promptAuthor;
		const row = normalizeVisibleMessage(message, { ...context, promptAuthor, precedingAuthor });
		if (row !== message) changed = true;
		if (isMessageAuthor(row.author)) precedingAuthor = row.author;
		return row;
	});
	return changed ? normalized : messages as Array<BobbitMessage<T>>;
}

/** Stamp message-bearing Pi events at the single live-event normalization boundary. */
export function normalizeVisibleAgentEvent<T>(
	_session: AgentSessionIdentity,
	event: T,
	context: Omit<NormalizeVisibleMessageContext, "session" | "existingAuthorIsTrusted"> = {},
): T {
	if (!event || typeof event !== "object" || Array.isArray(event)) return event;
	const candidate = event as Record<string, unknown>;
	if ((candidate.type !== "message_update" && candidate.type !== "message_end")
		|| !candidate.message
		|| typeof candidate.message !== "object"
		|| Array.isArray(candidate.message)) return event;
	// Pi/provider/transcript event payloads are untrusted at this live boundary.
	// Always replace even structurally valid incoming metadata with Bobbit's
	// prompt binding, session identity, or system inference.
	const message = normalizeVisibleMessage(candidate.message as Record<string, unknown>, {
		...context,
		session: _session,
		existingAuthorIsTrusted: false,
	});
	return (message === candidate.message ? event : { ...candidate, message }) as T;
}
