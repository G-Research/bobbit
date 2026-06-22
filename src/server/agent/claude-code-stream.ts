import { StringDecoder } from "node:string_decoder";
import { toClaudeCodeDisplayModelAlias } from "./claude-code-config.js";

export const CLAUDE_CODE_STREAM_LIMITS = {
	maxJsonlLineLength: 1024 * 1024,
	maxDiagnosticLineLength: 4096,
	maxDiagnosticsRetained: 100,
	maxContentCharsPerEvent: 256 * 1024,
	maxAssistantTextChars: 512 * 1024,
	maxStoredMessages: 200,
} as const;

export class ClaudeCodeStreamLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ClaudeCodeStreamLimitError";
	}
}

export interface ClaudeCodeStreamLimits {
	maxJsonlLineLength?: number;
	maxDiagnosticLineLength?: number;
	maxDiagnosticsRetained?: number;
	maxContentCharsPerEvent?: number;
	maxAssistantTextChars?: number;
	maxStoredMessages?: number;
}

function resolveLimits(limits: ClaudeCodeStreamLimits = {}): Required<ClaudeCodeStreamLimits> {
	return {
		maxJsonlLineLength: limits.maxJsonlLineLength ?? CLAUDE_CODE_STREAM_LIMITS.maxJsonlLineLength,
		maxDiagnosticLineLength: limits.maxDiagnosticLineLength ?? CLAUDE_CODE_STREAM_LIMITS.maxDiagnosticLineLength,
		maxDiagnosticsRetained: limits.maxDiagnosticsRetained ?? CLAUDE_CODE_STREAM_LIMITS.maxDiagnosticsRetained,
		maxContentCharsPerEvent: limits.maxContentCharsPerEvent ?? CLAUDE_CODE_STREAM_LIMITS.maxContentCharsPerEvent,
		maxAssistantTextChars: limits.maxAssistantTextChars ?? CLAUDE_CODE_STREAM_LIMITS.maxAssistantTextChars,
		maxStoredMessages: limits.maxStoredMessages ?? CLAUDE_CODE_STREAM_LIMITS.maxStoredMessages,
	};
}

export interface ClaudeCodeParseDiagnostic {
	level: "debug" | "warning";
	message: string;
	line: string;
	error?: string;
}

export interface ClaudeCodeParseChunkResult {
	events: any[];
	diagnostics: ClaudeCodeParseDiagnostic[];
}

/**
 * Incremental JSONL parser for Claude Code `stream-json` stdout.
 * Uses StringDecoder so UTF-8 codepoints split across chunks are preserved.
 */
export class ClaudeCodeJsonlParser {
	private decoder = new StringDecoder("utf8");
	private lineBuffer = "";
	readonly diagnostics: ClaudeCodeParseDiagnostic[] = [];
	private readonly limits: Required<Pick<ClaudeCodeStreamLimits, "maxJsonlLineLength" | "maxDiagnosticLineLength" | "maxDiagnosticsRetained">>;

	constructor(limits: Pick<ClaudeCodeStreamLimits, "maxJsonlLineLength" | "maxDiagnosticLineLength" | "maxDiagnosticsRetained"> = {}) {
		const resolved = resolveLimits(limits);
		this.limits = {
			maxJsonlLineLength: resolved.maxJsonlLineLength,
			maxDiagnosticLineLength: resolved.maxDiagnosticLineLength,
			maxDiagnosticsRetained: resolved.maxDiagnosticsRetained,
		};
	}

	push(chunk: Buffer | string): ClaudeCodeParseChunkResult {
		const data = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		return this.pushDecoded(data);
	}

	end(): ClaudeCodeParseChunkResult {
		const tail = this.decoder.end();
		const result = this.pushDecoded(tail);
		if (this.lineBuffer.trim()) {
			this.parseLine(this.lineBuffer, result.events, result.diagnostics);
			this.lineBuffer = "";
		}
		return result;
	}

	private pushDecoded(data: string): ClaudeCodeParseChunkResult {
		const events: any[] = [];
		const diagnostics: ClaudeCodeParseDiagnostic[] = [];
		if (!data) return { events, diagnostics };

		this.lineBuffer += data;
		if (this.lineBuffer.length > this.limits.maxJsonlLineLength && !this.lineBuffer.includes("\n")) {
			this.lineBuffer = "";
			throw new ClaudeCodeStreamLimitError(`Claude Code JSONL line exceeded ${this.limits.maxJsonlLineLength} characters`);
		}
		const lines = this.lineBuffer.split("\n");
		this.lineBuffer = lines.pop() ?? "";

		for (const line of lines) this.parseLine(line, events, diagnostics);
		return { events, diagnostics };
	}

	private parseLine(rawLine: string, events: any[], diagnostics: ClaudeCodeParseDiagnostic[]): void {
		const line = rawLine.replace(/\r$/, "");
		if (line.length > this.limits.maxJsonlLineLength) {
			throw new ClaudeCodeStreamLimitError(`Claude Code JSONL line exceeded ${this.limits.maxJsonlLineLength} characters`);
		}
		const trimmed = line.trim();
		if (!trimmed) return;

		try {
			events.push(JSON.parse(trimmed));
		} catch (err: any) {
			const diagnostic: ClaudeCodeParseDiagnostic = {
				level: "warning",
				message: "Ignoring non-JSON Claude Code stdout line",
				line: truncateString(line, this.limits.maxDiagnosticLineLength),
				error: truncateString(err?.message ? String(err.message) : String(err), this.limits.maxDiagnosticLineLength),
			};
			this.diagnostics.push(diagnostic);
			if (this.diagnostics.length > this.limits.maxDiagnosticsRetained) this.diagnostics.splice(0, this.diagnostics.length - this.limits.maxDiagnosticsRetained);
			diagnostics.push(diagnostic);
		}
	}
}

export interface ClaudeCodeTranslatorState {
	claudeCodeSessionId?: string;
	modelAlias?: string;
	assistantText: string;
	assistantToolCalls: any[];
	toolNamesById: Record<string, string>;
	assistantMessageId?: string;
	assistantTimestamp?: number;
	assistantOpen: boolean;
	messages: any[];
	lastUsage?: any;
	lastCostUsd?: number;
	lastTiming?: any;
}

export interface ClaudeCodeTranslationResult {
	events: any[];
	state: ClaudeCodeTranslatorState;
}

export interface ClaudeCodeTranslatorOptions extends ClaudeCodeStreamLimits {
	messageIdPrefix?: string;
}

let globalMessageCounter = 0;

export function createClaudeCodeTranslatorState(modelAlias = "sonnet"): ClaudeCodeTranslatorState {
	return {
		modelAlias,
		assistantText: "",
		assistantToolCalls: [],
		toolNamesById: {},
		assistantOpen: false,
		messages: [],
	};
}

export class ClaudeCodeStreamTranslator {
	readonly state: ClaudeCodeTranslatorState;
	private readonly messageIdPrefix: string;
	private readonly limits: Required<ClaudeCodeStreamLimits>;
	private localMessageCounter = 0;

	constructor(state: ClaudeCodeTranslatorState = createClaudeCodeTranslatorState(), options: ClaudeCodeTranslatorOptions = {}) {
		this.state = state;
		this.messageIdPrefix = options.messageIdPrefix ?? "claude-code";
		this.limits = resolveLimits(options);
	}

	translate(event: any): any[] {
		return translateClaudeCodeEvent(event, this.state, () => this.nextMessageId(), this.limits);
	}

	private nextMessageId(): string {
		this.localMessageCounter += 1;
		globalMessageCounter += 1;
		return `${this.messageIdPrefix}-${Date.now().toString(36)}-${this.localMessageCounter}-${globalMessageCounter}`;
	}
}

export function translateClaudeCodeEvent(
	event: any,
	state: ClaudeCodeTranslatorState = createClaudeCodeTranslatorState(),
	nextMessageId: () => string = () => `claude-code-${++globalMessageCounter}`,
	limits: ClaudeCodeStreamLimits = {},
): any[] {
	const resolvedLimits = resolveLimits(limits);
	assertEventContentWithinLimit(event, resolvedLimits.maxContentCharsPerEvent);
	const out: any[] = [];
	if (!event || typeof event !== "object") return out;
	const eventTimestamp = timestampFromClaudeCodeEvent(event);

	if (event.type === "system" && event.subtype === "init") {
		if (typeof event.session_id === "string") state.claudeCodeSessionId = event.session_id;
		if (typeof event.model === "string") state.modelAlias = toClaudeCodeDisplayModelAlias(event.model) ?? event.model;
		out.push({
			type: "agent_start",
			runtime: "claude-code",
			claudeCodeSessionId: state.claudeCodeSessionId,
			model: state.modelAlias ? { provider: "claude-code", id: state.modelAlias } : undefined,
		});
		return out;
	}

	if (event.type === "user") {
		const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
		const text = textFromContentBlocks(blocks);
		const toolResults = blocks.filter((block: any) => block?.type === "tool_result");
		if (toolResults.length > 0 && (state.assistantOpen || state.assistantToolCalls.length > 0)) {
			if (!state.assistantMessageId) state.assistantMessageId = nextMessageId();
			if (!state.assistantTimestamp) state.assistantTimestamp = eventTimestamp;
			const message = assistantMessageSnapshot(state);
			appendStoredMessage(state, message, resolvedLimits.maxStoredMessages);
			out.push({ type: "message_end", message });
			state.assistantText = "";
			state.assistantToolCalls = [];
			state.assistantMessageId = undefined;
			state.assistantTimestamp = undefined;
			state.assistantOpen = false;
		}
		for (const block of toolResults) {
			const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id : String(block.tool_use_id ?? "");
			if (!toolCallId) continue;
			const toolName = state.toolNamesById[toolCallId];
			const postedStub = isAskUserChoicesPostedPlaceholder(toolName, block)
				? askUserChoicesPostedStub(toolCallId)
				: undefined;
			const result = postedStub ?? stringifyToolContent(block.content);
			const resultContent = postedStub
				? [{ type: "text", text: postedStub }]
				: normalizeToolResultContent(block.content);
			const isError = postedStub ? false : Boolean(block.is_error);
			out.push({
				type: "tool_execution_end",
				id: toolCallId,
				toolId: toolCallId,
				toolCallId,
				toolUseId: toolCallId,
				tool_use_id: toolCallId,
				toolName,
				result,
				content: postedStub ? resultContent : block.content,
				isError,
				...(isError ? { error: result } : {}),
			});
			const message = {
				id: nextMessageId(),
				role: "toolResult",
				toolCallId,
				toolName,
				isError,
				content: resultContent,
				timestamp: eventTimestamp,
			};
			appendStoredMessage(state, message, resolvedLimits.maxStoredMessages);
			out.push({ type: "message_end", message });
		}
		if (text) {
			const message = {
				id: nextMessageId(),
				role: "user",
				content: [{ type: "text", text }],
				timestamp: eventTimestamp,
			};
			appendStoredMessage(state, message, resolvedLimits.maxStoredMessages);
			out.push({ type: "message_end", message });
		}
		return out;
	}

	if (event.type === "assistant") {
		const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
		for (const block of blocks) {
			if (block?.type === "text" && typeof block.text === "string") {
				if (state.assistantText.length + block.text.length > resolvedLimits.maxAssistantTextChars) {
					throw new ClaudeCodeStreamLimitError(`Claude Code assistant text exceeded ${resolvedLimits.maxAssistantTextChars} characters`);
				}
				state.assistantText += block.text;
				state.assistantOpen = true;
				if (!state.assistantMessageId) state.assistantMessageId = nextMessageId();
				if (!state.assistantTimestamp) state.assistantTimestamp = eventTimestamp;
				out.push({
					type: "message_update",
					message: assistantMessageSnapshot(state),
				});
			} else if (block?.type === "tool_use") {
				const toolCallId = typeof block.id === "string" ? block.id : String(block.id ?? "");
				if (!toolCallId) continue;
				const { toolName, input } = normalizeClaudeCodeToolUse(block);
				const toolCall = {
					type: "toolCall",
					id: toolCallId,
					toolCallId,
					name: toolName,
					arguments: input,
					input,
				};
				state.assistantOpen = true;
				if (!state.assistantTimestamp) state.assistantTimestamp = eventTimestamp;
				state.toolNamesById[toolCallId] = toolName;
				if (!state.assistantToolCalls.some((existing) => existing.id === toolCallId)) state.assistantToolCalls.push(toolCall);
				if (!state.assistantMessageId) state.assistantMessageId = nextMessageId();
				out.push({
					type: "tool_execution_start",
					id: toolCallId,
					toolId: toolCallId,
					toolCallId,
					toolUseId: toolCallId,
					tool_use_id: toolCallId,
					toolName,
					name: toolName,
					input,
					arguments: input,
				});
				out.push({
					type: "message_update",
					message: assistantMessageSnapshot(state),
				});
			}
		}
		return out;
	}

	if (event.type === "result") {
		if (typeof event.session_id === "string") state.claudeCodeSessionId = event.session_id;
		const totalCostUsd = finiteNumber(event.total_cost_usd);
		const normalizedUsage = normalizeClaudeCodeUsage(event.usage, totalCostUsd);
		const normalizedTiming = normalizeClaudeCodeTiming(event);
		state.lastUsage = normalizedUsage;
		state.lastCostUsd = totalCostUsd ?? state.lastCostUsd;
		state.lastTiming = normalizedTiming ?? state.lastTiming;
		const isError = Boolean(event.is_error);
		const resultText = typeof event.result === "string" ? event.result : "";
		const finalText = state.assistantText || resultText;
		if (finalText || isError || state.assistantOpen) {
			if (!state.assistantMessageId) state.assistantMessageId = nextMessageId();
			if (!state.assistantTimestamp) state.assistantTimestamp = eventTimestamp;
			const message = assistantMessageSnapshot(state, undefined, finalText);
			message.stopReason = isError ? "error" : "stop";
			if (isError) message.errorMessage = resultText || "Claude Code turn failed";
			if (normalizedUsage) message.usage = normalizedUsage;
			if (event.usage) message.rawClaudeUsage = event.usage;
			if (totalCostUsd !== undefined) message.cost = { totalUsd: totalCostUsd };
			if (normalizedTiming) {
				message.durationMs = normalizedTiming.durationMs;
				message.timing = normalizedTiming;
			}
			appendStoredMessage(state, message, resolvedLimits.maxStoredMessages);
			out.push({ type: "message_end", message, usage: normalizedUsage, rawClaudeUsage: event.usage, cost: message.cost, durationMs: normalizedTiming?.durationMs, timing: normalizedTiming });
		}
		state.assistantText = "";
		state.assistantToolCalls = [];
		state.assistantMessageId = undefined;
		state.assistantTimestamp = undefined;
		state.assistantOpen = false;
		out.push({
			type: "agent_end",
			stopReason: isError ? "error" : "stop",
			runtime: "claude-code",
			claudeCodeSessionId: state.claudeCodeSessionId,
			usage: normalizedUsage,
			rawClaudeUsage: event.usage,
			cost: totalCostUsd !== undefined ? { totalUsd: totalCostUsd } : undefined,
			durationMs: normalizedTiming?.durationMs,
			timing: normalizedTiming,
			error: isError ? resultText : undefined,
		});
		return out;
	}

	return out;
}

export function normalizeClaudeCodeUsage(rawUsage: any, totalCostUsd?: number): any | undefined {
	if (!rawUsage || typeof rawUsage !== "object") return undefined;
	const input = pickFiniteNumber(rawUsage, "input", "input_tokens");
	const output = pickFiniteNumber(rawUsage, "output", "output_tokens");
	const cacheRead = pickFiniteNumber(rawUsage, "cacheRead", "cache_read", "cache_read_input_tokens");
	const cacheWrite = pickFiniteNumber(rawUsage, "cacheWrite", "cache_write", "cache_creation_input_tokens");
	const explicitTotal = pickOptionalFiniteNumber(rawUsage, "totalTokens", "total_tokens");
	const totalTokens = explicitTotal ?? input + output + cacheRead + cacheWrite;
	const costTotal = totalCostUsd ?? finiteNumber(rawUsage.cost?.total) ?? finiteNumber(rawUsage.cost) ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: {
			input: finiteNumber(rawUsage.cost?.input) ?? 0,
			output: finiteNumber(rawUsage.cost?.output) ?? 0,
			cacheRead: finiteNumber(rawUsage.cost?.cacheRead) ?? 0,
			cacheWrite: finiteNumber(rawUsage.cost?.cacheWrite) ?? 0,
			total: costTotal,
		},
	};
}

export function normalizeClaudeCodeTiming(event: any): any | undefined {
	if (!event || typeof event !== "object") return undefined;
	const durationMs = pickOptionalFiniteNumber(event, "durationMs", "duration_ms", "elapsedMs", "elapsed_ms");
	const apiDurationMs = pickOptionalFiniteNumber(event, "apiDurationMs", "duration_api_ms", "api_duration_ms");
	if (durationMs === undefined && apiDurationMs === undefined) return undefined;
	return {
		...(durationMs !== undefined ? { durationMs } : {}),
		...(apiDurationMs !== undefined ? { apiDurationMs } : {}),
	};
}

function pickFiniteNumber(source: any, ...keys: string[]): number {
	return pickOptionalFiniteNumber(source, ...keys) ?? 0;
}

function pickOptionalFiniteNumber(source: any, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const value = finiteNumber(source?.[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function finiteNumber(value: any): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function assistantMessageSnapshot(state: ClaudeCodeTranslatorState, extraContent: any[] = [], overrideText?: string): any {
	const text = overrideText ?? state.assistantText;
	return {
		id: state.assistantMessageId,
		role: "assistant",
		model: state.modelAlias ? `claude-code/${state.modelAlias}` : "claude-code",
		timestamp: state.assistantTimestamp ?? Date.now(),
		content: [
			...(text ? [{ type: "text", text }] : []),
			...state.assistantToolCalls,
			...extraContent,
		],
	};
}

function appendStoredMessage(state: ClaudeCodeTranslatorState, message: any, maxStoredMessages: number): void {
	state.messages.push(message);
	if (state.messages.length > maxStoredMessages) state.messages.splice(0, state.messages.length - maxStoredMessages);
}

function assertEventContentWithinLimit(event: any, maxContentCharsPerEvent: number): void {
	const size = estimateContentChars(event?.message?.content ?? event?.result ?? event?.content);
	if (size > maxContentCharsPerEvent) {
		throw new ClaudeCodeStreamLimitError(`Claude Code event content exceeded ${maxContentCharsPerEvent} characters`);
	}
}

function estimateContentChars(value: any): number {
	if (typeof value === "string") return value.length;
	if (typeof value === "number" || typeof value === "boolean" || value == null) return 0;
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateContentChars(item), 0);
	if (typeof value === "object") {
		let total = 0;
		for (const [key, nested] of Object.entries(value)) {
			total += key.length + estimateContentChars(nested);
		}
		return total;
	}
	return String(value).length;
}

function truncateString(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function timestampFromClaudeCodeEvent(event: any): number {
	const raw = event?.timestamp ?? event?.ts ?? event?.created_at ?? event?.createdAt;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw < 10_000_000_000 ? raw * 1000 : raw;
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		if (Number.isFinite(parsed)) return parsed;
	}
	return Date.now();
}

function textFromContentBlocks(blocks: any[]): string {
	return blocks
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

function normalizeToolResultContent(content: any): any[] {
	if (Array.isArray(content)) return content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (content == null) return [];
	return [{ type: "text", text: stringifyToolContent(content) }];
}

function askUserChoicesPostedStub(toolUseId: string): string {
	return JSON.stringify({ status: "posted", tool_use_id: toolUseId });
}

function isAskUserChoicesPostedPlaceholder(toolName: unknown, block: any): boolean {
	if (toolName !== "ask_user_choices") return false;
	return stringifyToolContent(block?.content).trim() === "Answer questions?";
}

function normalizeClaudeCodeToolUse(block: any): { toolName: string; input: any } {
	const rawToolName = typeof block.name === "string" ? block.name : "unknown";
	const rawInput = block.input ?? {};
	if (!isClaudeCodeAskUserQuestionTool(rawToolName, rawInput)) {
		return { toolName: rawToolName, input: rawInput };
	}
	return { toolName: "ask_user_choices", input: normalizeAskUserChoicesInput(rawInput) };
}

function isClaudeCodeAskUserQuestionTool(toolName: string, input: any): boolean {
	const normalizedName = toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
	return normalizedName === "askuserquestion" && Array.isArray(input?.questions);
}

function normalizeAskUserChoicesInput(input: any): any {
	return {
		...input,
		questions: input.questions.map((question: any) => normalizeAskUserChoicesQuestion(question)),
	};
}

function normalizeAskUserChoicesQuestion(question: any): any {
	if (!question || typeof question !== "object") return question;
	const normalized: any = {
		...question,
		options: Array.isArray(question.options) ? question.options.map(normalizeAskUserChoiceOption) : question.options,
	};
	if (normalized.tab_label === undefined && typeof question.header === "string") normalized.tab_label = question.header;
	if (normalized.multi === undefined && typeof question.multiSelect === "boolean") normalized.multi = question.multiSelect;
	delete normalized.header;
	delete normalized.multiSelect;
	return normalized;
}

function normalizeAskUserChoiceOption(option: any): any {
	if (typeof option === "string") return option;
	if (option && typeof option === "object" && typeof option.label === "string") return option.label;
	return option;
}

function stringifyToolContent(content: any): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n");
	if (content == null) return "";
	try {
		return JSON.stringify(content);
	} catch {
		return String(content);
	}
}
