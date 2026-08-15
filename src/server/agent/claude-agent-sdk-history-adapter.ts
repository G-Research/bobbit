import {
	createClaudeSdkTranslatorState,
	translateClaudeSdkEvent,
	type ClaudeSdkTranslatorState,
} from "./claude-sdk-event-translator.js";
import type { SdkSessionMessage } from "./claude-agent-sdk-session-access.js";

/** A Pi-shaped history row accepted by the ordinary visible-snapshot pipeline. */
export type ClaudeAgentSdkHistoryMessage = Record<string, unknown> & {
	id: string;
	role: "user" | "assistant" | "toolResult";
	parentToolUseId?: string;
	parentAgentId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function timestampFor(message: SdkSessionMessage): number {
	const raw = isRecord(message.message) ? message.message.timestamp : undefined;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}

function annotations(message: SdkSessionMessage): Pick<ClaudeAgentSdkHistoryMessage, "id" | "parentToolUseId" | "parentAgentId"> {
	return {
		id: message.uuid,
		...(message.parent_tool_use_id ? { parentToolUseId: message.parent_tool_use_id } : {}),
		...(message.parent_agent_id ? { parentAgentId: message.parent_agent_id } : {}),
	};
}

/**
 * SDK history is durable after a session's selected tool surface may have
 * changed. `mcp__bobbit__` is Bobbit's reserved server identity, so retain its
 * canonical suffix for historical projection without trying to re-create an
 * old tool surface. The pinned Agent alias can persist its resolved `Task`
 * transport name; project that one private native name back to public `Agent`.
 * Foreign MCP and all other native names remain unchanged.
 */
export function canonicalizeClaudeSdkHistoryToolName(name: unknown): unknown {
	if (typeof name !== "string") return name;
	if (name === "Task") return "Agent";
	const match = /^mcp__bobbit__([a-z][a-z0-9_-]*)$/i.exec(name);
	return match ? match[1] : name;
}

function canonicalizeHistoryRow(row: ClaudeAgentSdkHistoryMessage): ClaudeAgentSdkHistoryMessage {
	const canonical = canonicalizeClaudeSdkHistoryToolName;
	const toolName = canonical(row.toolName);
	const content = Array.isArray(row.content)
		? row.content.map((block) => {
			if (!isRecord(block)) return block;
			if (block.type === "toolCall" || block.type === "tool_use") {
				const name = canonical(block.name);
				return name === block.name ? block : { ...block, name };
			}
			return block;
		})
		: row.content;
	return toolName === row.toolName && content === row.content
		? row
		: { ...row, ...(toolName !== row.toolName ? { toolName } : {}), content };
}

function userMessage(message: SdkSessionMessage): ClaudeAgentSdkHistoryMessage | undefined {
	if (!isRecord(message.message) || !("content" in message.message)) return undefined;
	return {
		...annotations(message),
		role: "user",
		content: message.message.content,
		timestamp: timestampFor(message),
	};
}

function messagesFromTranslation(
	state: ClaudeSdkTranslatorState,
	message: SdkSessionMessage,
): { state: ClaudeSdkTranslatorState; messages: ClaudeAgentSdkHistoryMessage[] } {
	// The stream translator is also the normalizer for Anthropic text, thinking,
	// tool calls, and tool results. Session history contains finalized frames, so
	// only its message_end output belongs in a snapshot.
	const translated = translateClaudeSdkEvent(state, {
		type: message.type,
		uuid: message.uuid,
		session_id: message.session_id,
		message: message.message,
		parent_tool_use_id: message.parent_tool_use_id,
		parent_agent_id: message.parent_agent_id,
		timestamp_ms: timestampFor(message),
	});
	const rows = translated.events.flatMap((event) => {
		if (event.type !== "message_end" || !isRecord(event.message)) return [];
		const row = event.message as unknown as ClaudeAgentSdkHistoryMessage;
		return [canonicalizeHistoryRow({ ...row, ...annotations(message) })];
	});
	return { state: translated.state, messages: rows };
}

/**
 * Convert official `getSessionMessages()` records into the existing Pi-shaped
 * snapshot contract without reading or creating a Pi transcript. Order and
 * SDK UUID/parent relationships are retained on every rendered history row.
 */
export function adaptSdkSessionMessages(messages: readonly SdkSessionMessage[]): ClaudeAgentSdkHistoryMessage[] {
	let state = createClaudeSdkTranslatorState();
	const snapshot: ClaudeAgentSdkHistoryMessage[] = [];
	for (const message of messages) {
		if (!message || typeof message.uuid !== "string" || !message.uuid) continue;
		if (message.type === "user") {
			const translated = messagesFromTranslation(state, message);
			state = translated.state;
			if (translated.messages.length > 0) snapshot.push(...translated.messages);
			else {
				const row = userMessage(message);
				if (row) snapshot.push(canonicalizeHistoryRow(row));
			}
			continue;
		}
		if (message.type === "assistant" || message.type === "system") {
			const translated = messagesFromTranslation(state, message);
			state = translated.state;
			snapshot.push(...translated.messages);
		}
	}
	return snapshot;
}
