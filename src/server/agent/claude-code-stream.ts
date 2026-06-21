import { StringDecoder } from "node:string_decoder";

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
		const lines = this.lineBuffer.split("\n");
		this.lineBuffer = lines.pop() ?? "";

		for (const line of lines) this.parseLine(line, events, diagnostics);
		return { events, diagnostics };
	}

	private parseLine(rawLine: string, events: any[], diagnostics: ClaudeCodeParseDiagnostic[]): void {
		const line = rawLine.replace(/\r$/, "");
		const trimmed = line.trim();
		if (!trimmed) return;

		try {
			events.push(JSON.parse(trimmed));
		} catch (err: any) {
			const diagnostic: ClaudeCodeParseDiagnostic = {
				level: "warning",
				message: "Ignoring non-JSON Claude Code stdout line",
				line,
				error: err?.message ? String(err.message) : String(err),
			};
			this.diagnostics.push(diagnostic);
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
	assistantOpen: boolean;
	messages: any[];
	lastUsage?: any;
	lastCostUsd?: number;
}

export interface ClaudeCodeTranslationResult {
	events: any[];
	state: ClaudeCodeTranslatorState;
}

export interface ClaudeCodeTranslatorOptions {
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
	private localMessageCounter = 0;

	constructor(state: ClaudeCodeTranslatorState = createClaudeCodeTranslatorState(), options: ClaudeCodeTranslatorOptions = {}) {
		this.state = state;
		this.messageIdPrefix = options.messageIdPrefix ?? "claude-code";
	}

	translate(event: any): any[] {
		return translateClaudeCodeEvent(event, this.state, () => this.nextMessageId());
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
): any[] {
	const out: any[] = [];
	if (!event || typeof event !== "object") return out;

	if (event.type === "system" && event.subtype === "init") {
		if (typeof event.session_id === "string") state.claudeCodeSessionId = event.session_id;
		if (typeof event.model === "string") state.modelAlias = event.model;
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
			const message = assistantMessageSnapshot(state);
			state.messages.push(message);
			out.push({ type: "message_end", message });
			state.assistantText = "";
			state.assistantToolCalls = [];
			state.assistantMessageId = undefined;
			state.assistantOpen = false;
		}
		for (const block of toolResults) {
			const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id : String(block.tool_use_id ?? "");
			if (!toolCallId) continue;
			const result = stringifyToolContent(block.content);
			const toolName = state.toolNamesById[toolCallId];
			out.push({
				type: "tool_execution_end",
				id: toolCallId,
				toolId: toolCallId,
				toolCallId,
				toolUseId: toolCallId,
				tool_use_id: toolCallId,
				toolName,
				result,
				content: block.content,
				isError: Boolean(block.is_error),
				error: block.is_error ? result : undefined,
			});
			const message = {
				id: nextMessageId(),
				role: "toolResult",
				toolCallId,
				toolName,
				isError: Boolean(block.is_error),
				content: normalizeToolResultContent(block.content),
			};
			state.messages.push(message);
			out.push({ type: "message_end", message });
		}
		if (text) {
			const message = {
				id: nextMessageId(),
				role: "user",
				content: [{ type: "text", text }],
			};
			state.messages.push(message);
			out.push({ type: "message_end", message });
		}
		return out;
	}

	if (event.type === "assistant") {
		const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
		for (const block of blocks) {
			if (block?.type === "text" && typeof block.text === "string") {
				state.assistantText += block.text;
				state.assistantOpen = true;
				if (!state.assistantMessageId) state.assistantMessageId = nextMessageId();
				out.push({
					type: "message_update",
					message: assistantMessageSnapshot(state),
				});
			} else if (block?.type === "tool_use") {
				const toolCallId = typeof block.id === "string" ? block.id : String(block.id ?? "");
				if (!toolCallId) continue;
				const toolName = typeof block.name === "string" ? block.name : "unknown";
				const toolCall = {
					type: "toolCall",
					id: toolCallId,
					toolCallId,
					name: toolName,
					arguments: block.input ?? {},
					input: block.input ?? {},
				};
				state.assistantOpen = true;
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
					input: block.input ?? {},
					arguments: block.input ?? {},
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
		state.lastUsage = event.usage;
		state.lastCostUsd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : state.lastCostUsd;
		const isError = Boolean(event.is_error);
		const resultText = typeof event.result === "string" ? event.result : "";
		const finalText = state.assistantText || resultText;
		if (finalText || isError || state.assistantOpen) {
			if (!state.assistantMessageId) state.assistantMessageId = nextMessageId();
			const message = assistantMessageSnapshot(state, undefined, finalText);
			message.stopReason = isError ? "error" : "stop";
			if (isError) message.errorMessage = resultText || "Claude Code turn failed";
			if (event.usage) message.usage = event.usage;
			if (typeof event.total_cost_usd === "number") message.cost = { totalUsd: event.total_cost_usd };
			state.messages.push(message);
			out.push({ type: "message_end", message, usage: event.usage, cost: message.cost });
		}
		state.assistantText = "";
		state.assistantToolCalls = [];
		state.assistantMessageId = undefined;
		state.assistantOpen = false;
		out.push({
			type: "agent_end",
			stopReason: isError ? "error" : "stop",
			runtime: "claude-code",
			claudeCodeSessionId: state.claudeCodeSessionId,
			usage: event.usage,
			cost: typeof event.total_cost_usd === "number" ? { totalUsd: event.total_cost_usd } : undefined,
			error: isError ? resultText : undefined,
		});
		return out;
	}

	return out;
}

function assistantMessageSnapshot(state: ClaudeCodeTranslatorState, extraContent: any[] = [], overrideText?: string): any {
	const text = overrideText ?? state.assistantText;
	return {
		id: state.assistantMessageId,
		role: "assistant",
		model: state.modelAlias ? `claude-code/${state.modelAlias}` : "claude-code",
		content: [
			...(text ? [{ type: "text", text }] : []),
			...state.assistantToolCalls,
			...extraContent,
		],
	};
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
