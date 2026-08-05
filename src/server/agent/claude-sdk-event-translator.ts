import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";

/** The untyped envelope emitted by the Claude Agent SDK query iterator. */
export type ClaudeSdkEvent = Readonly<Record<string, unknown>>;

/** SDK terminal information which Pi's AgentEvent vocabulary does not represent. */
export interface ClaudeSdkEventMetadata {
	readonly terminal?: Readonly<{ error?: string; terminalReason?: string; subtype?: string }>;
}

/** A Pi event annotated when it belongs to a forwarded subagent stream. */
type ClaudeSdkEventAnnotation = {
	readonly parentToolUseId?: string;
	readonly claudeSdk?: ClaudeSdkEventMetadata;
};

export type ClaudeSdkTranslatedEvent = AgentEvent & ClaudeSdkEventAnnotation;

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

type TranslatorContent = TextContent | ThinkingContent | (ToolCall & { readonly argumentsJson?: string });
type PartitionKey = string | typeof ROOT;

interface PartialAssistant {
	readonly id: string;
	readonly blocks: ReadonlyMap<number, TranslatorContent>;
	readonly stoppedBlocks: ReadonlySet<number>;
	readonly timestamp: number;
	readonly usage: Usage;
}

interface OpenTool {
	readonly id: string;
	readonly name: string;
	readonly input: Record<string, any>;
}

interface PartitionState {
	readonly partials: ReadonlyMap<string, PartialAssistant>;
	readonly openTools: ReadonlyMap<string, OpenTool>;
	readonly finalized: ReadonlySet<string>;
	readonly fingerprints: readonly string[];
	readonly activeStreamId?: string;
	/** A child result/abort closes only this forwarded stream. */
	readonly terminated?: boolean;
}

/**
 * Immutable state for the offline SDK-message translator. A symbol makes the
 * internal root identity structurally disjoint from every SDK parent_tool_use_id.
 */
export interface ClaudeSdkTranslatorState {
	readonly partitions: ReadonlyMap<PartitionKey, PartitionState>;
	readonly terminated: boolean;
}

const ROOT = Symbol("claude-sdk-root");
const ROOT_LABEL = "root";
const MAX_FINGERPRINTS = 256;
const MAX_DIAGNOSTIC_DETAIL = 240;
const EMPTY_PARTITION: PartitionState = {
	partials: new Map(),
	openTools: new Map(),
	finalized: new Set(),
	fingerprints: [],
};

export function createClaudeSdkTranslatorState(): ClaudeSdkTranslatorState {
	return { partitions: new Map(), terminated: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function partitionFor(input: Record<string, unknown>): PartitionKey {
	return nonEmptyString(input.parent_tool_use_id) ?? ROOT;
}

function partitionLabel(key: PartitionKey): string {
	return key === ROOT ? ROOT_LABEL : key;
}

function diagnostic(
	code: ClaudeSdkTranslatorDiagnostic["code"],
	partition: PartitionKey,
	detail: string,
): ClaudeSdkTranslatorDiagnostic {
	return { code, partition: partitionLabel(partition), detail: detail.slice(0, MAX_DIAGNOSTIC_DETAIL) };
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
	const result: Record<string, unknown> = Object.create(null);
	for (const key of Object.keys(value).slice(0, 128)) {
		const child = safeValue((value as Record<string, unknown>)[key], seen, depth + 1);
		if (child !== undefined) result[key] = child;
	}
	return result;
}

function safeRecord(value: unknown): Record<string, any> {
	const safe = safeValue(value);
	return isRecord(safe) ? safe : {};
}

function safeText(value: unknown): string {
	if (typeof value === "string") return value;
	const safe = safeValue(value);
	if (safe === undefined) return "";
	try { return JSON.stringify(safe); } catch { return "[unserializable]"; }
}

function timestampFor(input: Record<string, unknown>): number {
	const timestamp = input.timestamp_ms ?? input.timestamp;
	return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : 0;
}

function usageFor(value: unknown): Usage {
	const usage = isRecord(value) ? value : {};
	const number = (name: string): number => typeof usage[name] === "number" && Number.isFinite(usage[name]) ? usage[name] as number : 0;
	const input = number("input_tokens") || number("input");
	const output = number("output_tokens") || number("output");
	const cacheRead = number("cache_read_input_tokens") || number("cacheRead");
	const cacheWrite = number("cache_creation_input_tokens") || number("cacheWrite");
	const cost = typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd) ? usage.cost_usd : 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function stopReasonFor(value: unknown, error = false, aborted = false): StopReason {
	if (aborted) return "aborted";
	if (error) return "error";
	switch (value) {
		case "end_turn": case "stop_sequence": case "stop": return "stop";
		case "max_tokens": case "length": return "length";
		case "tool_use": case "toolUse": return "toolUse";
		case "error": case "refusal": return "error";
		case "aborted": case "aborted_streaming": case "aborted_tools": return "aborted";
		default: return "stop";
	}
}

function parsedToolArguments(block: ToolCall & { readonly argumentsJson?: string }): Record<string, any> {
	if (block.argumentsJson !== undefined) {
		try {
			const parsed: unknown = JSON.parse(block.argumentsJson);
			return isRecord(parsed) ? safeRecord(parsed) : {};
		} catch { return {}; }
	}
	return safeRecord(block.arguments);
}

function contentBlocks(content: unknown): TranslatorContent[] {
	if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	const blocks: TranslatorContent[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		const type = nonEmptyString(block.type);
		if (type === "text" && typeof block.text === "string") blocks.push({ type: "text", text: block.text });
		else if (type === "thinking" && typeof block.thinking === "string") {
			const signature = nonEmptyString(block.signature);
			blocks.push({ type: "thinking", thinking: block.thinking, ...(signature ? { thinkingSignature: signature } : {}) });
		} else if (type === "redacted_thinking" && typeof block.data === "string") {
			blocks.push({ type: "thinking", thinking: "", thinkingSignature: block.data, redacted: true });
		} else if (type === "tool_use") {
			const id = nonEmptyString(block.id);
			const name = nonEmptyString(block.name);
			if (id && name) blocks.push({ type: "toolCall", id, name, arguments: safeRecord(block.input) });
		}
	}
	return blocks;
}

function assistantMessage(
	blocks: readonly TranslatorContent[],
	source: Record<string, unknown> | undefined,
	timestamp: number,
	usage?: Usage,
	error = false,
	aborted = false,
): AssistantMessage {
	return {
		role: "assistant",
		content: blocks.map((block) => {
			if (block.type !== "toolCall") return block;
			const { argumentsJson: _internalArgumentsJson, ...toolCall } = block;
			return { ...toolCall, arguments: parsedToolArguments(block) };
		}),
		api: "anthropic",
		provider: "anthropic",
		model: nonEmptyString(source?.model) ?? "claude-code-sdk",
		usage: usage ?? usageFor(source?.usage),
		stopReason: stopReasonFor(source?.stop_reason, error, aborted),
		timestamp,
		...(error ? { errorMessage: terminalError(source) } : {}),
	};
}

function toolsIn(blocks: readonly TranslatorContent[]): OpenTool[] {
	return blocks.flatMap((block) => block.type === "toolCall"
		? [{ id: block.id, name: block.name, input: parsedToolArguments(block) }]
		: []);
}

function updatePartition(state: ClaudeSdkTranslatorState, key: PartitionKey, partition: PartitionState): ClaudeSdkTranslatorState {
	const partitions = new Map(state.partitions);
	partitions.set(key, partition);
	return { ...state, partitions };
}

function withFingerprint(partition: PartitionState, value: string): PartitionState {
	return { ...partition, fingerprints: [...partition.fingerprints, value].slice(-MAX_FINGERPRINTS) };
}

function blocksFor(partial: PartialAssistant): TranslatorContent[] {
	return [...partial.blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block);
}

/** Pi content indexes address the normalized content array, not raw SDK indexes. */
function contentIndexFor(partial: PartialAssistant, rawIndex: number): number | undefined {
	return [...partial.blocks.keys()].sort((left, right) => left - right).indexOf(rawIndex);
}

function annotate<T extends AgentEvent>(event: T, partition: PartitionKey, metadata?: ClaudeSdkEventMetadata): T & ClaudeSdkEventAnnotation {
	return partition === ROOT
		? { ...event, ...(metadata ? { claudeSdk: metadata } : {}) }
		: { ...event, parentToolUseId: partition, ...(metadata ? { claudeSdk: metadata } : {}) };
}

function partialEvent(
	partial: PartialAssistant,
	source: Record<string, unknown> | undefined,
	type: AssistantMessageEvent["type"],
	rawIndex?: number,
	delta?: string,
): ClaudeSdkTranslatedEvent | undefined {
	const message = assistantMessage(blocksFor(partial), source, partial.timestamp, partial.usage);
	if (type === "start") {
		return { type: "message_update", message, assistantMessageEvent: { type, partial: message } };
	}
	if (rawIndex === undefined) return undefined;
	const contentIndex = contentIndexFor(partial, rawIndex);
	if (contentIndex === undefined || contentIndex < 0) return undefined;
	let event: AssistantMessageEvent;
	switch (type) {
		case "text_start": case "thinking_start": case "toolcall_start": event = { type, contentIndex, partial: message }; break;
		case "text_delta": case "thinking_delta": case "toolcall_delta": event = { type, contentIndex, delta: delta ?? "", partial: message }; break;
		case "text_end": case "thinking_end": event = { type, contentIndex, content: delta ?? "", partial: message }; break;
		case "toolcall_end": {
			const block = partial.blocks.get(rawIndex);
			if (!block || block.type !== "toolCall") return undefined;
			const { argumentsJson: _internalArgumentsJson, ...toolCall } = block;
			event = { type, contentIndex, toolCall: { ...toolCall, arguments: parsedToolArguments(block) }, partial: message };
			break;
		}
		default: return undefined;
	}
	return { type: "message_update", message, assistantMessageEvent: event };
}

function emitAssistantEnd(
	partition: PartitionState,
	partitionKey: PartitionKey,
	identities: readonly string[],
	blocks: readonly TranslatorContent[],
	source: Record<string, unknown> | undefined,
	timestamp: number,
	events: ClaudeSdkTranslatedEvent[],
): PartitionState {
	if (identities.some((id) => partition.finalized.has(id))) return partition;
	events.push(annotate({ type: "message_end", message: assistantMessage(blocks, source, timestamp) }, partitionKey));
	const openTools = new Map(partition.openTools);
	for (const tool of toolsIn(blocks)) {
		if (openTools.has(tool.id)) continue;
		openTools.set(tool.id, tool);
		events.push(annotate({ type: "tool_execution_start", toolCallId: tool.id, toolName: tool.name, args: tool.input }, partitionKey));
	}
	const partials = new Map(partition.partials);
	for (const id of identities) partials.delete(id);
	return {
		...partition,
		partials,
		openTools,
		finalized: new Set([...partition.finalized, ...identities]),
		activeStreamId: identities.includes(partition.activeStreamId ?? "") ? undefined : partition.activeStreamId,
	};
}

function extractToolResults(message: Record<string, unknown>): { id: string; content: unknown; isError: boolean }[] {
	if (!Array.isArray(message.content)) return [];
	const results: { id: string; content: unknown; isError: boolean }[] = [];
	for (const item of message.content) {
		if (!isRecord(item) || item.type !== "tool_result") continue;
		const id = nonEmptyString(item.tool_use_id);
		if (id) results.push({ id, content: item.content, isError: item.is_error === true });
	}
	return results;
}

function toolResultMessage(tool: OpenTool, content: unknown, isError: boolean, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: tool.id,
		toolName: tool.name,
		content: [{ type: "text", text: safeText(content) }],
		isError,
		timestamp,
	};
}

function terminalError(source: Record<string, unknown> | undefined): string {
	if (!source) return "";
	if (Array.isArray(source.errors)) return source.errors.map(safeText).filter(Boolean).join("; ").slice(0, 2_000);
	if (typeof source.error === "string") return source.error.slice(0, 2_000);
	if (source.aborted === true) return "Request aborted";
	if (typeof source.terminal_reason === "string") return source.terminal_reason.slice(0, 2_000);
	return safeText(source.subtype ?? source.result).slice(0, 2_000);
}

function isTerminalEvent(type: string, input: Record<string, unknown>): boolean {
	return type === "result" || (type === "assistant" && (input.aborted === true || typeof input.error === "string"));
}

function terminalIsError(source: Record<string, unknown>): boolean {
	return source.is_error === true || source.aborted === true || typeof source.error === "string"
		|| /^error/.test(String(source.subtype ?? "")) || /^aborted/.test(String(source.terminal_reason ?? ""));
}

function drainPartition(
	partition: PartitionState,
	partitionKey: PartitionKey,
	events: ClaudeSdkTranslatedEvent[],
	source: Record<string, unknown>,
): PartitionState {
	for (const partial of partition.partials.values()) {
		partition = emitAssistantEnd(partition, partitionKey, [partial.id], blocksFor(partial), undefined, partial.timestamp, events);
	}
	for (const tool of partition.openTools.values()) {
		const result = toolResultMessage(tool, "Tool call ended before a result was received.", true, timestampFor(source));
		events.push(annotate({ type: "message_end", message: result }, partitionKey));
		events.push(annotate({ type: "tool_execution_end", toolCallId: tool.id, toolName: tool.name, result: { content: result.content }, isError: true }, partitionKey));
	}
	return { ...partition, openTools: new Map(), activeStreamId: undefined, terminated: true };
}

function drain(state: ClaudeSdkTranslatorState, events: ClaudeSdkTranslatedEvent[], source: Record<string, unknown>): ClaudeSdkTranslatorState {
	let next: ClaudeSdkTranslatorState = { ...state, partitions: new Map(state.partitions), terminated: true };
	for (const [partitionKey, partition] of state.partitions) {
		next = updatePartition(next, partitionKey, drainPartition(partition, partitionKey, events, source));
	}
	const error = terminalIsError(source);
	const terminalReason = nonEmptyString(source.terminal_reason);
	const errorText = error ? terminalError(source) : undefined;
	events.push(annotate(
		{ type: "agent_end", messages: [] },
		ROOT,
		{ terminal: { ...(errorText ? { error: errorText } : {}), ...(terminalReason ? { terminalReason } : {}), ...(nonEmptyString(source.subtype) ? { subtype: nonEmptyString(source.subtype) } : {}) } },
	));
	return next;
}

function streamId(input: Record<string, unknown>, raw: Record<string, unknown>, partition: PartitionState): string | undefined {
	const rawMessage = isRecord(raw.message) ? raw.message : undefined;
	return nonEmptyString(rawMessage?.id) ?? partition.activeStreamId ?? nonEmptyString(input.uuid);
}

function contentStart(block: Record<string, unknown>): TranslatorContent | undefined {
	return contentBlocks([block])[0] ?? (block.type === "tool_use" && nonEmptyString(block.id) && nonEmptyString(block.name)
		? { type: "toolCall", id: block.id, name: block.name, arguments: {}, argumentsJson: "" }
		: undefined);
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
		return { state: { ...state, partitions: new Map(state.partitions) }, events, diagnostics: [diagnostic("malformed", ROOT, "SDK event must be an object")] };
	}

	const partitionKey = partitionFor(input);
	if (state.terminated) {
		return { state: { ...state, partitions: new Map(state.partitions) }, events, diagnostics: [diagnostic("late_event", partitionKey, "event arrived after terminal result")] };
	}
	let partition = state.partitions.get(partitionKey) ?? EMPTY_PARTITION;
	if (partition.terminated) {
		return { state: updatePartition(state, partitionKey, partition), events, diagnostics: [diagnostic("late_event", partitionKey, "event arrived after partition terminal result")] };
	}
	const type = nonEmptyString(input.type);
	if (!type) return { state: updatePartition(state, partitionKey, partition), events, diagnostics: [diagnostic("malformed", partitionKey, "SDK event is missing type")] };

	// Streaming deltas are transitions, not replayable snapshots: two equal deltas append twice.
	if (type !== "stream_event") {
		const frame = fingerprint(input);
		if (partition.fingerprints.includes(frame)) {
			return { state: updatePartition(state, partitionKey, partition), events, diagnostics: [diagnostic("duplicate", partitionKey, "duplicate SDK event")] };
		}
		partition = withFingerprint(partition, frame);
	}
	let next = updatePartition(state, partitionKey, partition);

	if (isTerminalEvent(type, input)) {
		if (partitionKey !== ROOT) {
			return { state: updatePartition(next, partitionKey, drainPartition(partition, partitionKey, events, input)), events, diagnostics };
		}
		return { state: drain(next, events, input), events, diagnostics };
	}

	if (type === "assistant") {
		const message = isRecord(input.message) ? input.message : undefined;
		const envelopeId = nonEmptyString(input.uuid);
		const messageId = nonEmptyString(message?.id);
		const primaryId = envelopeId ?? messageId;
		if (!message || !primaryId) return { state: next, events, diagnostics: [diagnostic("malformed", partitionKey, "assistant event is missing message identity")] };
		const identities = [...new Set([primaryId, envelopeId, messageId, partition.activeStreamId].filter((id): id is string => !!id))];
		if (identities.some((id) => partition.finalized.has(id))) {
			return { state: next, events, diagnostics: [diagnostic("late_event", partitionKey, "assistant message is already final")] };
		}
		partition = emitAssistantEnd(partition, partitionKey, identities, contentBlocks(message.content), message, timestampFor(input), events);
		return { state: updatePartition(next, partitionKey, partition), events, diagnostics };
	}

	if (type === "stream_event") {
		const raw = isRecord(input.event) ? input.event : undefined;
		const rawType = nonEmptyString(raw?.type);
		const id = raw && streamId(input, raw, partition);
		if (!raw || !rawType || !id) return { state: next, events, diagnostics: [diagnostic("malformed", partitionKey, "stream event is missing event type or message identity")] };
		if (partition.finalized.has(id)) return { state: next, events, diagnostics: [diagnostic("late_event", partitionKey, "stream event follows final assistant message")] };
		const source = isRecord(raw.message) ? raw.message : undefined;
		if (rawType === "message_start") {
			if (!partition.partials.has(id)) {
				const partial: PartialAssistant = { id, blocks: new Map(), stoppedBlocks: new Set(), timestamp: timestampFor(input), usage: usageFor(source?.usage) };
				partition = { ...partition, partials: new Map([...partition.partials, [id, partial]]), activeStreamId: id };
				const event = partialEvent(partial, source, "start");
				if (event) events.push(annotate(event, partitionKey));
			} else partition = { ...partition, activeStreamId: id };
			return { state: updatePartition(next, partitionKey, partition), events, diagnostics };
		}
		if (rawType === "content_block_start" || rawType === "content_block_delta") {
			const index = typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index >= 0 ? raw.index : undefined;
			if (index === undefined) return { state: next, events, diagnostics: [diagnostic("malformed", partitionKey, "content block event is missing index")] };
			const previous = partition.partials.get(id) ?? { id, blocks: new Map(), stoppedBlocks: new Set(), timestamp: timestampFor(input), usage: usageFor(undefined) };
			const existing = previous.blocks.get(index);
			if (rawType === "content_block_start" && existing) {
				return { state: next, events, diagnostics: [diagnostic("duplicate", partitionKey, "content block start already exists")] };
			}
			if (previous.stoppedBlocks.has(index)) {
				return { state: next, events, diagnostics: [diagnostic("duplicate", partitionKey, "content block is already stopped")] };
			}
			const block = rawType === "content_block_start" ? raw.content_block : raw.delta;
			if (!isRecord(block)) return { state: next, events, diagnostics: [diagnostic("malformed", partitionKey, "content block payload must be an object")] };
			let normalized: TranslatorContent | undefined;
			let messageEvent: AssistantMessageEvent["type"];
			let delta: string | undefined;
			if (rawType === "content_block_start") {
				normalized = contentStart(block);
				messageEvent = normalized?.type === "text" ? "text_start" : normalized?.type === "thinking" ? "thinking_start" : "toolcall_start";
			} else if (existing?.type === "text" && typeof block.text === "string") {
				normalized = { ...existing, text: existing.text + block.text }; messageEvent = "text_delta"; delta = block.text;
			} else if (existing?.type === "thinking" && typeof block.thinking === "string") {
				normalized = { ...existing, thinking: existing.thinking + block.thinking }; messageEvent = "thinking_delta"; delta = block.thinking;
			} else if (existing?.type === "thinking" && typeof block.signature === "string") {
				normalized = { ...existing, thinkingSignature: block.signature }; messageEvent = "thinking_delta"; delta = "";
			} else if (existing?.type === "toolCall" && typeof block.partial_json === "string") {
				normalized = { ...existing, argumentsJson: (existing.argumentsJson ?? "") + block.partial_json }; messageEvent = "toolcall_delta"; delta = block.partial_json;
			}
			if (!normalized) return { state: next, events, diagnostics: [diagnostic("unknown_kind", partitionKey, "unrecognized content block")] };
			const partial: PartialAssistant = { ...previous, blocks: new Map([...previous.blocks, [index, normalized]]) };
			partition = { ...partition, partials: new Map([...partition.partials, [id, partial]]), activeStreamId: id };
			const event = partialEvent(partial, source, messageEvent!, index, delta);
			if (event) events.push(annotate(event, partitionKey));
			return { state: updatePartition(next, partitionKey, partition), events, diagnostics };
		}
		if (rawType === "content_block_stop") {
			const index = typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index >= 0 ? raw.index : undefined;
			const partial = index === undefined ? undefined : partition.partials.get(id);
			if (index === undefined || !partial) return { state: next, events, diagnostics };
			if (partial.stoppedBlocks.has(index)) return { state: next, events, diagnostics: [diagnostic("duplicate", partitionKey, "content block is already stopped")] };
			const block = partial.blocks.get(index);
			if (!block) return { state: next, events, diagnostics: [diagnostic("malformed", partitionKey, "content block stop has no block")] };
			const stopped = { ...partial, stoppedBlocks: new Set([...partial.stoppedBlocks, index]) };
			partition = { ...partition, partials: new Map([...partition.partials, [id, stopped]]) };
			const eventType = block.type === "text" ? "text_end" : block.type === "thinking" ? "thinking_end" : "toolcall_end";
			const event = partialEvent(stopped, source, eventType, index, block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : undefined);
			if (event) events.push(annotate(event, partitionKey));
			return { state: updatePartition(next, partitionKey, partition), events, diagnostics };
		}
		if (rawType === "message_delta") {
			const partial = partition.partials.get(id);
			const usage = isRecord(raw.usage) ? raw.usage : isRecord(raw.delta) ? raw.delta.usage : undefined;
			if (partial && usage) {
				const updated = { ...partial, usage: usageFor(usage) };
				partition = { ...partition, partials: new Map([...partition.partials, [id, updated]]) };
			}
			return { state: updatePartition(next, partitionKey, partition), events, diagnostics };
		}
		if (rawType === "message_stop") return { state: updatePartition(next, partitionKey, { ...partition, activeStreamId: partition.activeStreamId === id ? undefined : partition.activeStreamId }), events, diagnostics };
		if (rawType === "ping") return { state: next, events, diagnostics };
		return { state: next, events, diagnostics: [diagnostic("unknown_kind", partitionKey, `unknown stream event ${rawType}`)] };
	}

	if (type === "user") {
		const message = isRecord(input.message) ? input.message : undefined;
		const results = message ? extractToolResults(message) : [];
		if (results.length === 0) return { state: next, events, diagnostics };
		const openTools = new Map(partition.openTools);
		for (const result of results) {
			const tool = openTools.get(result.id);
			if (!tool) {
				diagnostics.push(diagnostic("late_event", partitionKey, "tool result has no open tool in this partition"));
				continue;
			}
			const messageEnd = toolResultMessage(tool, result.content, result.isError, timestampFor(input));
			events.push(annotate({ type: "message_end", message: messageEnd }, partitionKey));
			events.push(annotate({ type: "tool_execution_end", toolCallId: tool.id, toolName: tool.name, result: { content: messageEnd.content }, isError: result.isError }, partitionKey));
			openTools.delete(tool.id);
		}
		return { state: updatePartition(next, partitionKey, { ...partition, openTools }), events, diagnostics };
	}

	if (type === "system" && input.subtype === "permission_denied") {
		const id = nonEmptyString(input.tool_use_id);
		const name = nonEmptyString(input.tool_name);
		if (!id || !name) return { state: next, events, diagnostics: [diagnostic("malformed", partitionKey, "permission denial is missing tool identity")] };
		const tool = partition.openTools.get(id) ?? { id, name, input: {} };
		const message = toolResultMessage(tool, input.message ?? input.error ?? "Permission denied", true, timestampFor(input));
		events.push(annotate({ type: "message_end", message }, partitionKey));
		if (partition.openTools.has(id)) {
			events.push(annotate({ type: "tool_execution_end", toolCallId: tool.id, toolName: tool.name, result: { content: message.content }, isError: true }, partitionKey));
			const openTools = new Map(partition.openTools);
			openTools.delete(id);
			partition = { ...partition, openTools };
		}
		return { state: updatePartition(next, partitionKey, partition), events, diagnostics };
	}

	return { state: next, events, diagnostics: [diagnostic("unknown_kind", partitionKey, `unknown SDK message type ${type}`)] };
}
