import type { AgentEvent } from "@earendil-works/pi-agent-core";

/** The untyped envelope emitted by the Claude Agent SDK query iterator. */
export type ClaudeSdkEvent = Readonly<Record<string, unknown>>;

/** A Pi event annotated when it belongs to a forwarded subagent stream. */
export type ClaudeSdkTranslatedEvent = AgentEvent & { parentToolUseId?: string };

export interface ClaudeSdkTranslatorDiagnostic {
	code: "malformed" | "unknown_kind" | "late_event" | "duplicate" | "partition_mismatch";
	partition: string;
	detail: string;
}

export interface ClaudeSdkTranslation {
	state: ClaudeSdkTranslatorState;
	events: readonly ClaudeSdkTranslatedEvent[];
	diagnostics: readonly ClaudeSdkTranslatorDiagnostic[];
}

type ContentBlock = Readonly<Record<string, unknown>>;

interface PartialAssistant {
	readonly id: string;
	readonly blocks: Readonly<Record<string, ContentBlock>>;
}

interface OpenTool {
	readonly id: string;
	readonly name: string;
	readonly input: unknown;
}

interface PartitionState {
	readonly partials: Readonly<Record<string, PartialAssistant>>;
	readonly openTools: Readonly<Record<string, OpenTool>>;
	readonly finalized: Readonly<Record<string, true>>;
	readonly fingerprints: readonly string[];
}

/**
 * Immutable state for the offline SDK-message translator.  The root key is an
 * implementation detail: all externally visible child events retain their
 * original parentToolUseId.
 */
export interface ClaudeSdkTranslatorState {
	readonly partitions: Readonly<Record<string, PartitionState>>;
	readonly terminated: boolean;
}

const ROOT = "__claude_sdk_root__";
const MAX_FINGERPRINTS = 256;
const MAX_DIAGNOSTIC_DETAIL = 240;
const EMPTY_PARTITION: PartitionState = Object.freeze({
	partials: Object.freeze({}),
	openTools: Object.freeze({}),
	finalized: Object.freeze({}),
	fingerprints: Object.freeze([]),
});

export function createClaudeSdkTranslatorState(): ClaudeSdkTranslatorState {
	return Object.freeze({ partitions: Object.freeze({}), terminated: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function partitionFor(input: Record<string, unknown>): string {
	return nonEmptyString(input.parent_tool_use_id) ?? ROOT;
}

function diagnostic(
	code: ClaudeSdkTranslatorDiagnostic["code"],
	partition: string,
	detail: string,
): ClaudeSdkTranslatorDiagnostic {
	return { code, partition, detail: detail.slice(0, MAX_DIAGNOSTIC_DETAIL) };
}

/** A deterministic, bounded fingerprint which cannot throw on hostile input. */
function fingerprint(value: unknown): string {
	const seen = new WeakSet<object>();
	const visit = (entry: unknown, depth: number): string => {
		if (depth > 12) return "[depth]";
		if (entry === null) return "null";
		switch (typeof entry) {
			case "string": return JSON.stringify(entry.length > 2_000 ? entry.slice(0, 2_000) : entry);
			case "number": return Number.isFinite(entry) ? String(entry) : "[number]";
			case "boolean": return String(entry);
			case "undefined": return "undefined";
			case "bigint": return `[bigint:${entry.toString()}]`;
			case "symbol": return "[symbol]";
			case "function": return "[function]";
			case "object": {
				if (seen.has(entry)) return "[circular]";
				seen.add(entry);
				if (Array.isArray(entry)) return `[${entry.slice(0, 64).map(item => visit(item, depth + 1)).join(",")}]`;
				const record = entry as Record<string, unknown>;
				return `{${Object.keys(record).sort().slice(0, 64).map(key => `${JSON.stringify(key)}:${visit(record[key], depth + 1)}`).join(",")}}`;
			}
		}
		return "[unknown]";
	};
	return visit(value, 0).slice(0, 8_192);
}

function safeValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
	if (depth > 10) return "[truncated]";
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "object") return undefined;
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.slice(0, 128).map(item => safeValue(item, seen, depth + 1));
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).slice(0, 128)) {
		const child = safeValue((value as Record<string, unknown>)[key], seen, depth + 1);
		if (child !== undefined) result[key] = child;
	}
	return result;
}

function safeText(value: unknown): string {
	if (typeof value === "string") return value;
	const safe = safeValue(value);
	if (safe === undefined) return "";
	try { return JSON.stringify(safe); } catch { return "[unserializable]"; }
}

function contentBlocks(content: unknown): ContentBlock[] {
	if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	const blocks: ContentBlock[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		const type = nonEmptyString(block.type);
		if (type === "text" && typeof block.text === "string") blocks.push({ type: "text", text: block.text });
		else if ((type === "thinking" || type === "redacted_thinking") && typeof block.thinking === "string") {
			blocks.push({ type: "thinking", thinking: block.thinking, ...(nonEmptyString(block.signature) ? { signature: block.signature } : {}) });
		} else if (type === "tool_use" && nonEmptyString(block.id) && nonEmptyString(block.name)) {
			blocks.push({ type: "toolCall", id: block.id, name: block.name, arguments: safeValue(block.input) ?? {} });
		}
	}
	return blocks;
}

function assistantMessage(id: string, blocks: readonly ContentBlock[], source?: Record<string, unknown>): Record<string, unknown> {
	return {
		id,
		role: "assistant",
		content: blocks,
		api: "anthropic",
		provider: "anthropic",
		model: nonEmptyString(source?.model) ?? "claude-code-sdk",
		...(nonEmptyString(source?.stop_reason) ? { stopReason: nonEmptyString(source?.stop_reason) } : {}),
	};
}

function annotate(event: Record<string, unknown>, partition: string): ClaudeSdkTranslatedEvent {
	return (partition === ROOT ? event : { ...event, parentToolUseId: partition }) as ClaudeSdkTranslatedEvent;
}

function toolsIn(blocks: readonly ContentBlock[]): OpenTool[] {
	return blocks.flatMap((block) => {
		const id = nonEmptyString(block.id);
		const name = nonEmptyString(block.name);
		return block.type === "toolCall" && id && name
			? [{ id, name, input: block.arguments ?? {} }]
			: [];
	});
}

function updatePartition(state: ClaudeSdkTranslatorState, key: string, partition: PartitionState): ClaudeSdkTranslatorState {
	return { ...state, partitions: { ...state.partitions, [key]: partition } };
}

function withFingerprint(partition: PartitionState, value: string): PartitionState {
	const fingerprints = [...partition.fingerprints, value];
	return { ...partition, fingerprints: fingerprints.slice(-MAX_FINGERPRINTS) };
}

function blocksFor(partial: PartialAssistant): ContentBlock[] {
	return Object.keys(partial.blocks).sort((a, b) => Number(a) - Number(b)).map(index => partial.blocks[index]!);
}

function emitAssistantEnd(
	partition: PartitionState,
	partitionKey: string,
	id: string,
	blocks: readonly ContentBlock[],
	source: Record<string, unknown> | undefined,
	events: ClaudeSdkTranslatedEvent[],
): PartitionState {
	if (partition.finalized[id]) return partition;
	events.push(annotate({ type: "message_end", message: assistantMessage(id, blocks, source) }, partitionKey));
	const openTools = { ...partition.openTools };
	for (const tool of toolsIn(blocks)) {
		if (openTools[tool.id]) continue;
		openTools[tool.id] = tool;
		events.push(annotate({ type: "tool_execution_start", toolCallId: tool.id, toolName: tool.name, args: tool.input }, partitionKey));
	}
	const partials = { ...partition.partials };
	delete partials[id];
	return { ...partition, partials, openTools, finalized: { ...partition.finalized, [id]: true } };
}

function extractToolResult(message: Record<string, unknown>): { id: string; content: unknown; isError: boolean } | undefined {
	const content = message.content;
	if (!Array.isArray(content)) return undefined;
	for (const item of content) {
		if (!isRecord(item) || item.type !== "tool_result") continue;
		const id = nonEmptyString(item.tool_use_id);
		if (id) return { id, content: item.content, isError: item.is_error === true };
	}
	return undefined;
}

function toolResultMessage(tool: OpenTool, content: unknown, isError: boolean): Record<string, unknown> {
	return {
		role: "toolResult",
		toolCallId: tool.id,
		toolName: tool.name,
		content: [{ type: "text", text: safeText(content) }],
		isError,
	};
}

function drain(state: ClaudeSdkTranslatorState, events: ClaudeSdkTranslatedEvent[], source: Record<string, unknown>): ClaudeSdkTranslatorState {
	let next: ClaudeSdkTranslatorState = { ...state, partitions: { ...state.partitions }, terminated: true };
	for (const [partitionKey, original] of Object.entries(state.partitions)) {
		let partition = original;
		for (const partial of Object.values(partition.partials)) {
			partition = emitAssistantEnd(partition, partitionKey, partial.id, blocksFor(partial), undefined, events);
		}
		const openTools = Object.values(partition.openTools);
		for (const tool of openTools) {
			const result = toolResultMessage(tool, "Tool call ended before a result was received.", true);
			events.push(annotate({ type: "message_end", message: result }, partitionKey));
			events.push(annotate({ type: "tool_execution_end", toolCallId: tool.id, toolName: tool.name, result: { content: result.content }, isError: true }, partitionKey));
		}
		partition = { ...partition, openTools: {} };
		next = updatePartition(next, partitionKey, partition);
	}
	const error = source.is_error === true || source.type === "error" || source.type === "abort" || /^error|abort/.test(String(source.subtype ?? ""));
	events.push(annotate({ type: "agent_end", messages: [], ...(error ? { error: safeText(source.error ?? source.result ?? source.subtype) } : {}) }, ROOT));
	return next;
}

/**
 * Translate one SDK message without touching a bridge, process, store, clock,
 * or input/state object. Partition selection happens before any message or tool
 * identity lookup, preventing forwarded child traffic from entering root state.
 */
export function translateClaudeSdkEvent(state: ClaudeSdkTranslatorState, input: unknown): ClaudeSdkTranslation {
	const events: ClaudeSdkTranslatedEvent[] = [];
	const diagnostics: ClaudeSdkTranslatorDiagnostic[] = [];
	if (!isRecord(input)) {
		return { state: { ...state, partitions: { ...state.partitions } }, events, diagnostics: [diagnostic("malformed", ROOT, "SDK event must be an object")] };
	}

	const partitionKey = partitionFor(input);
	if (state.terminated) {
		return { state: { ...state, partitions: { ...state.partitions } }, events, diagnostics: [diagnostic("late_event", partitionKey, "event arrived after terminal result")] };
	}
	let partition = state.partitions[partitionKey] ?? EMPTY_PARTITION;
	const frame = fingerprint(input);
	if (partition.fingerprints.includes(frame)) {
		return { state: updatePartition(state, partitionKey, partition), events, diagnostics: [diagnostic("duplicate", partitionKey, "duplicate SDK event")] };
	}
	partition = withFingerprint(partition, frame);
	let next = updatePartition(state, partitionKey, partition);

	const type = nonEmptyString(input.type);
	if (!type) return { state: next, events, diagnostics: [diagnostic("malformed", partitionKey, "SDK event is missing type")] };

	if (type === "result" || type === "error" || type === "abort") return { state: drain(next, events, input), events, diagnostics };

	if (type === "assistant") {
		const message = isRecord(input.message) ? input.message : undefined;
		const id = nonEmptyString(input.uuid) ?? nonEmptyString(message?.id);
		if (!message || !id) return { state: next, events, diagnostics: [diagnostic("malformed", partitionKey, "assistant event is missing message identity")] };
		if (partition.finalized[id]) return { state: next, events, diagnostics: [diagnostic("late_event", partitionKey, "assistant message is already final")] };
		partition = emitAssistantEnd(partition, partitionKey, id, contentBlocks(message.content), message, events);
		return { state: updatePartition(next, partitionKey, partition), events, diagnostics };
	}

	if (type === "stream_event") {
		const raw = isRecord(input.event) ? input.event : undefined;
		const rawMessage = isRecord(raw?.message) ? raw.message : undefined;
		const rawType = nonEmptyString(raw?.type);
		const id = nonEmptyString(input.uuid) ?? nonEmptyString(rawMessage?.id);
		if (!raw || !rawType || !id) return { state: next, events, diagnostics: [diagnostic("malformed", partitionKey, "stream event is missing event type or message identity")] };
		if (partition.finalized[id]) return { state: next, events, diagnostics: [diagnostic("late_event", partitionKey, "stream event follows final assistant message")] };
		if (rawType === "message_start") {
			if (!partition.partials[id]) {
				const partial: PartialAssistant = { id, blocks: {} };
				partition = { ...partition, partials: { ...partition.partials, [id]: partial } };
				events.push(annotate({ type: "message_update", message: assistantMessage(id, [], isRecord(raw.message) ? raw.message : undefined) }, partitionKey));
			}
			return { state: updatePartition(next, partitionKey, partition), events, diagnostics };
		}
		if (rawType === "content_block_start" || rawType === "content_block_delta") {
			const index = typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index >= 0 ? String(raw.index) : undefined;
			if (!index) return { state: next, events, diagnostics: [diagnostic("malformed", partitionKey, "content block event is missing index")] };
			const previous = partition.partials[id] ?? { id, blocks: {} };
			const existing = previous.blocks[index];
			const block = rawType === "content_block_start" ? raw.content_block : raw.delta;
			if (!isRecord(block)) return { state: next, events, diagnostics: [diagnostic("malformed", partitionKey, "content block payload must be an object")] };
			let normalized: ContentBlock | undefined;
			if (rawType === "content_block_start") normalized = contentBlocks([block])[0];
			else if (existing?.type === "text" && typeof block.text === "string") normalized = { ...existing, text: `${existing.text ?? ""}${block.text}` };
			else if (existing?.type === "thinking" && typeof block.thinking === "string") normalized = { ...existing, thinking: `${existing.thinking ?? ""}${block.thinking}` };
			else if (existing?.type === "toolCall" && typeof block.partial_json === "string") normalized = { ...existing, arguments: `${existing.arguments ?? ""}${block.partial_json}` };
			if (!normalized) return { state: next, events, diagnostics: [diagnostic("unknown_kind", partitionKey, "unrecognized content block")] };
			const partial: PartialAssistant = { id, blocks: { ...previous.blocks, [index]: normalized } };
			partition = { ...partition, partials: { ...partition.partials, [id]: partial } };
			events.push(annotate({ type: "message_update", message: assistantMessage(id, blocksFor(partial)) }, partitionKey));
			return { state: updatePartition(next, partitionKey, partition), events, diagnostics };
		}
		if (rawType === "message_stop" || rawType === "content_block_stop" || rawType === "message_delta" || rawType === "ping") return { state: next, events, diagnostics };
		return { state: next, events, diagnostics: [diagnostic("unknown_kind", partitionKey, `unknown stream event ${rawType}`)] };
	}

	if (type === "user") {
		const message = isRecord(input.message) ? input.message : undefined;
		const result = message && extractToolResult(message);
		if (!result) return { state: next, events, diagnostics: [diagnostic("malformed", partitionKey, "user event has no tool result")] };
		const tool = partition.openTools[result.id];
		if (!tool) return { state: next, events, diagnostics: [diagnostic("late_event", partitionKey, "tool result has no open tool in this partition")] };
		const messageEnd = toolResultMessage(tool, result.content, result.isError);
		events.push(annotate({ type: "message_end", message: messageEnd }, partitionKey));
		events.push(annotate({ type: "tool_execution_end", toolCallId: tool.id, toolName: tool.name, result: { content: messageEnd.content }, isError: result.isError }, partitionKey));
		const openTools = { ...partition.openTools };
		delete openTools[tool.id];
		return { state: updatePartition(next, partitionKey, { ...partition, openTools }), events, diagnostics };
	}

	if (type === "system" && String(input.subtype ?? "") === "permission_denial") {
		const text = safeText(input.error ?? input.message ?? "Permission denied");
		events.push(annotate({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text }], isError: true } }, partitionKey));
		return { state: next, events, diagnostics };
	}

	return { state: next, events, diagnostics: [diagnostic("unknown_kind", partitionKey, `unknown SDK message type ${type}`)] };
}
