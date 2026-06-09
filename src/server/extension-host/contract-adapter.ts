// src/server/extension-host/contract-adapter.ts
//
// The internal→contract ADAPTER (design docs/design/extension-host-phase2.md §4 /
// extension-host.md §3 ADAPTER SEAM). It is the SINGLE place that maps Bobbit's
// INTERNAL transcript JSONL wire format onto the FROZEN, versioned, Host-API-OWNED
// contract shapes (`HostMessage` / `HostContentBlock` / `ToolCallRecord`). Packs see
// ONLY the contract shapes, so Bobbit's internals can be refactored freely without
// breaking any installed pack — that decoupling is the whole point of the seam.
//
// The row-walking shape tolerance here is the SAME generalization the action guard
// uses: `action-guard.ts::transcriptHasToolUse` handles both the Anthropic
// `{ type:"tool_use", id, name }` rows and the pi-coding-agent
// `{ toolCallId, toolName }` rows, and returns a boolean. This module walks the same
// rows but EMITS contract content blocks instead. Unknown block types are tolerated
// (skipped — consumers render nothing), per the additive HostContentBlock union.

import { HOST_CONTRACT_VERSION } from "../../shared/extension-host/host-api.js";
import type {
	HostMessage,
	HostContentBlock,
	ToolCallRecord,
	ReadTranscriptOpts,
	TranscriptEnvelope,
} from "../../shared/extension-host/host-api.js";

/** The data-contract version this adapter targets. Pinned equal to the frozen
 *  HOST_CONTRACT_VERSION so a contract-shape bump is a single source of truth. */
export const CONTRACT_VERSION = HOST_CONTRACT_VERSION;

/** Normalize an internal message role onto the contract's closed role set.
 *  pi-coding-agent emits a distinct `toolResult` role row; in contract form a
 *  tool result is carried as a `tool_result` block on a user-role message
 *  (mirroring the Anthropic wire), so `toolResult` maps to `"user"`. Anything
 *  unrecognized defaults to `"assistant"` (never throws — the adapter tolerates
 *  unknown internals). */
function normalizeRole(role: unknown): HostMessage["role"] {
	if (role === "user" || role === "assistant" || role === "system") return role;
	return "user";
}

/** Parse an internal timestamp (ISO string or epoch number) → epoch ms.
 *  Returns 0 when absent/unparseable so the contract `ts` is always a number. */
function parseTs(entry: Record<string, unknown>): number {
	const raw = entry.ts ?? entry.timestamp;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const ms = Date.parse(raw);
		if (Number.isFinite(ms)) return ms;
	}
	return 0;
}

/** Map ONE internal content block onto a contract HostContentBlock, or null for
 *  unknown/unsupported block types (tolerated — the consumer renders nothing).
 *  Shape-tolerant in the same way as transcriptHasToolUse: accepts the Anthropic
 *  `tool_use` / `tool_result` shapes AND the pi-coding-agent `toolCall` /
 *  `toolCallId` / `toolName` shapes. */
function blockToContract(block: unknown): HostContentBlock | null {
	if (!block || typeof block !== "object") return null;
	const b = block as Record<string, unknown>;
	const t = b.type;

	if (t === "text" && typeof b.text === "string") {
		return { type: "text", text: b.text };
	}

	// Explicit tool_result FIRST so the loose toolCallId heuristic below never
	// misclassifies a result row as a tool_use.
	if (t === "tool_result") {
		const toolUseId = String(b.tool_use_id ?? b.toolCallId ?? b.id ?? "");
		const output = b.content ?? b.output ?? null;
		const isError = b.is_error === true || b.isError === true;
		return { type: "tool_result", toolUseId, output, isError };
	}

	const isToolUse = t === "tool_use" || t === "toolCall" || typeof b.toolCallId === "string";
	if (isToolUse) {
		const toolUseId = String(b.id ?? b.toolCallId ?? b.tool_use_id ?? "");
		const nameRaw = b.name ?? b.toolName;
		const tool = typeof nameRaw === "string" ? nameRaw : "";
		const input = b.input ?? b.args ?? b.arguments ?? null;
		return { type: "tool_use", toolUseId, tool, input };
	}

	// Unknown block type — tolerated, render nothing.
	return null;
}

/** Build the content blocks for one internal message. Handles a string body
 *  (single text block), an array of blocks, and the pi-coding-agent message-level
 *  `toolResult` row (where the result identity lives on the message, not a block). */
function messageToBlocks(message: Record<string, unknown>): HostContentBlock[] {
	const content = message.content;

	// pi-coding-agent message-level toolResult: identity on the message, not a block.
	if (message.role === "toolResult" && typeof message.toolCallId === "string") {
		return [{
			type: "tool_result",
			toolUseId: message.toolCallId,
			output: content ?? null,
			isError: message.isError === true,
		}];
	}

	if (typeof content === "string") {
		return content.length > 0 ? [{ type: "text", text: content }] : [];
	}
	if (!Array.isArray(content)) return [];

	const blocks: HostContentBlock[] = [];
	for (const raw of content) {
		const mapped = blockToContract(raw);
		if (mapped) blocks.push(mapped);
	}
	return blocks;
}

/**
 * Map an internal transcript JSONL string onto contract HostMessages. Tolerant of
 * the Anthropic `{ type:"tool_use", id, name }` and pi-coding-agent
 * `{ toolCallId, toolName }` shapes (reuses the transcriptHasToolUse row walk) and
 * of unknown block types (skipped). Bad lines are skipped, never thrown.
 */
export function transcriptToHostMessages(jsonl: string | null | undefined): HostMessage[] {
	if (!jsonl) return [];
	const out: HostMessage[] = [];
	let idx = 0;
	for (const rawLine of jsonl.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		let entry: unknown;
		try { entry = JSON.parse(line); } catch { continue; }
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const message = e.message;
		if (!message || typeof message !== "object") continue;
		const m = message as Record<string, unknown>;
		const id = typeof e.id === "string" ? e.id : `msg-${idx}`;
		out.push({
			id,
			role: normalizeRole(m.role),
			content: messageToBlocks(m),
			ts: parseTs(e),
		});
		idx++;
	}
	return out;
}

/**
 * Extract a single tool call (input + output) by tool_use id from an internal
 * transcript JSONL string. Reuses transcriptToHostMessages so the shape tolerance
 * lives in one place. Returns null when no tool_use block with that id exists; the
 * matching tool_result (in a later message) supplies output + isError when present.
 */
export function transcriptToToolCall(
	jsonl: string | null | undefined,
	toolUseId: string,
): ToolCallRecord | null {
	if (!jsonl || !toolUseId) return null;
	const messages = transcriptToHostMessages(jsonl);
	let call: Extract<HostContentBlock, { type: "tool_use" }> | null = null;
	let result: Extract<HostContentBlock, { type: "tool_result" }> | null = null;
	for (const msg of messages) {
		for (const block of msg.content) {
			if (block.type === "tool_use" && block.toolUseId === toolUseId) {
				call = block;
			} else if (block.type === "tool_result" && block.toolUseId === toolUseId) {
				result = block;
			}
		}
	}
	if (!call) return null;
	return {
		toolUseId,
		tool: call.tool,
		input: call.input,
		output: result ? result.output : null,
		isError: result ? result.isError : false,
	};
}

const MAX_LIMIT = 500;

/** Apply pattern filter + offset/limit window to contract messages and wrap them
 *  in the frozen TranscriptEnvelope. `total` counts the messages AFTER pattern
 *  filtering (the population being paged); `returned` counts the window. The
 *  pattern is matched against a flattened text projection of each message
 *  (text + tool names + serialized tool io).
 *
 *  SECURITY: `pattern` is treated as a LITERAL, case-insensitive SUBSTRING filter
 *  (`.toLowerCase().includes(...)`) — NOT a regex. `ReadTranscriptOpts.pattern` is
 *  caller-controlled (a pack passes it through `host.session.readTranscript`);
 *  compiling it as `new RegExp(...)` was a catastrophic-backtracking (ReDoS) DoS
 *  vector. The frozen contract type is just `pattern?: string` (never pinned to
 *  regex semantics), so literal substring matching is contract-conformant and
 *  pathological input (e.g. `(a+)+$`) is harmless — matched verbatim, never
 *  executed as a pattern. */
export function buildTranscriptEnvelope(
	messages: HostMessage[],
	opts?: ReadTranscriptOpts,
): TranscriptEnvelope {
	let working = messages;
	if (opts?.pattern && opts.pattern.length > 0) {
		const needle = opts.pattern.toLowerCase();
		working = messages.filter((m) => flattenMessage(m).toLowerCase().includes(needle));
	}
	const total = working.length;

	const offset = Number.isFinite(opts?.offset) ? Math.max(0, Math.floor(opts!.offset!)) : 0;
	let limit = Number.isFinite(opts?.limit) ? Math.floor(opts!.limit!) : total;
	if (limit < 0) limit = 0;
	if (limit > MAX_LIMIT) limit = MAX_LIMIT;

	const window = working.slice(offset, offset + limit);
	return { total, returned: window.length, messages: window };
}

/** Flatten a contract message to a searchable text blob (used only for pattern
 *  filtering — never returned to packs). */
function flattenMessage(m: HostMessage): string {
	const parts: string[] = [m.role];
	for (const b of m.content) {
		if (b.type === "text") parts.push(b.text);
		else if (b.type === "tool_use") parts.push(b.tool, safeStringify(b.input));
		else if (b.type === "tool_result") parts.push(safeStringify(b.output));
	}
	return parts.join(" ");
}

function safeStringify(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "string") return v;
	try { return JSON.stringify(v); } catch { return String(v); }
}
