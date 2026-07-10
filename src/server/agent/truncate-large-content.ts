/**
 * Truncates large message content in agent events before broadcasting
 * over WebSocket and storing in EventBuffer.
 *
 * This prevents catastrophic memory pressure when agents write large files
 * or produce large verification artifacts — each event would otherwise carry
 * the full accumulated payload through JSON serialization and replay buffers.
 *
 * The original event is never mutated — a shallow clone is returned when
 * truncation occurs. Events that don't need truncation are returned as-is
 * (zero overhead).
 */

/** Default threshold: 32KB. Normal code files pass through untouched. */
export const LARGE_CONTENT_THRESHOLD = 32 * 1024;

const PREVIEW_LENGTH = 512;

/**
 * Sentinel prefixes on preview_open snapshot tool_result text blocks.
 * Recognises v1/v2/v3 — only v1 ever needs truncation in practice (v2/v3
 * are constant ~250 bytes), but matching all three keeps the truncation
 * layer aligned with what the renderer accepts.
 *
 * Mirrors `PREVIEW_SNAPSHOT_MARKERS` in `defaults/tools/html/snapshot.ts`;
 * inlined here because `defaults/` lives outside the server `rootDir` and
 * `src/ui/tools/renderers/PreviewRenderer.ts` follows the same pattern.
 */
const PREVIEW_SNAPSHOT_MARKERS = [
	"__preview_snapshot_v1__\n",
	"__preview_snapshot_v2__\n",
	"__preview_snapshot_v3__\n",
] as const;

const VERIFICATION_RESULT_LARGE_FIELDS = ["summary", "report_html"] as const;

/** Return the matched marker prefix, or undefined if none matches. */
function matchMarker(text: string): string | undefined {
	for (const m of PREVIEW_SNAPSHOT_MARKERS) {
		if (text.startsWith(m)) return m;
	}
	return undefined;
}

export interface TruncatedContent {
	_truncated: true;
	_originalLength: number;
	preview: string;
}

function truncatedStringDescriptor(text: string): TruncatedContent {
	return {
		_truncated: true,
		_originalLength: text.length,
		preview: text.slice(0, PREVIEW_LENGTH),
	};
}

function isLargeString(value: any, threshold: number): value is string {
	return typeof value === "string" && value.length > threshold;
}

/**
 * If `block` is a text block whose `text` starts with the preview snapshot
 * marker and exceeds `threshold`, return a shallow-cloned truncated block.
 * Otherwise returns the original block (referential equality).
 *
 * The resulting block keeps its marker prefix (so downstream consumers can
 * still detect it) and embeds a `TruncatedContent` descriptor alongside the
 * preview text (first 512 chars of the full snapshot, excluding the marker).
 */
export function truncateSnapshotBlock(block: any, threshold: number = LARGE_CONTENT_THRESHOLD): any {
	if (!block || block.type !== "text" || typeof block.text !== "string") return block;
	const marker = matchMarker(block.text);
	if (!marker) return block;
	if (block._truncated) return block;
	if (block.text.length <= threshold) return block;
	const html = block.text.slice(marker.length);
	return {
		...block,
		text: marker,
		_truncated: true,
		_originalLength: block.text.length,
		preview: html.slice(0, PREVIEW_LENGTH),
	};
}

function truncateTextBlock(block: any, threshold: number): any {
	const snapshot = truncateSnapshotBlock(block, threshold);
	if (snapshot !== block) return snapshot;
	if (!block || block.type !== "text" || typeof block.text !== "string") return block;
	if (block._truncated) return block;
	if (block.text.length <= threshold) return block;
	const preview = block.text.slice(0, PREVIEW_LENGTH);
	return {
		...block,
		text: preview,
		_truncated: true,
		_originalLength: block.text.length,
		preview,
	};
}

/** Helper: check if a content block is a tool call (either format) */
function isToolBlock(block: any): boolean {
	return block?.type === "toolCall" || block?.type === "tool_use";
}

function isVerificationResultTool(block: any): boolean {
	return block?.name === "verification_result";
}

function truncateToolPayload(payload: any, block: any, threshold: number): any {
	if (!payload || typeof payload !== "object") return payload;
	let next = payload;

	if (isLargeString(payload.content, threshold)) {
		next = { ...next, content: truncatedStringDescriptor(payload.content) };
	}

	if (isVerificationResultTool(block)) {
		for (const field of VERIFICATION_RESULT_LARGE_FIELDS) {
			if (isLargeString(payload[field], threshold)) {
				if (next === payload) next = { ...payload };
				next[field] = truncatedStringDescriptor(payload[field]);
			}
		}
	}

	return next;
}

function truncateToolBlock(block: any, threshold: number): any {
	if (!isToolBlock(block)) return block;

	const nextArguments = truncateToolPayload(block.arguments, block, threshold);
	const nextInput = truncateToolPayload(block.input, block, threshold);
	if (nextArguments === block.arguments && nextInput === block.input) return block;

	const nextBlock = { ...block };
	if (nextArguments !== block.arguments) nextBlock.arguments = nextArguments;
	if (nextInput !== block.input) nextBlock.input = nextInput;
	return nextBlock;
}

function truncateMessageContentBlock(block: any, threshold: number): any {
	const textBlock = truncateTextBlock(block, threshold);
	if (textBlock !== block) return textBlock;
	return truncateToolBlock(block, threshold);
}

/**
 * Truncate large content inside a list of persisted messages (as returned by
 * the agent's `get_messages` RPC). Used when sending history to clients on
 * session open / reconnect / tab wake — previously, the full untruncated
 * history was serialized into a single WebSocket frame, which caused very slow
 * (and sometimes failing) history loads for sessions with large payloads.
 *
 * Returns the original array when nothing needs truncation.
 */
export function truncateLargeToolContentInMessages(messages: any, threshold: number = LARGE_CONTENT_THRESHOLD): any {
	if (!Array.isArray(messages)) return messages;
	let changed = false;
	const out = messages.map((msg: any) => {
		const content = msg?.content;
		if (!Array.isArray(content)) return msg;
		let msgChanged = false;
		const newContent = content.map((block: any) => {
			const truncated = truncateMessageContentBlock(block, threshold);
			if (truncated !== block) {
				msgChanged = true;
				return truncated;
			}
			return block;
		});
		if (!msgChanged) return msg;
		changed = true;
		return { ...msg, content: newContent };
	});
	return changed ? out : messages;
}

/**
 * If the event is a `message_update` or `message_end` containing large text,
 * tool content, or verification_result artifact fields, return a shallow clone
 * with those values replaced by bounded previews and metadata.
 *
 * Supports both formats:
 *  - Anthropic API: `{ type: "tool_use", input: { content: "..." } }`
 *  - pi-coding-agent RPC: `{ type: "toolCall", arguments: { content: "..." } }`
 *
 * Returns the original event unchanged when no truncation is needed.
 */
export function truncateLargeToolContent(event: any, threshold: number = LARGE_CONTENT_THRESHOLD): any {
	// Fast-path: only process message events with content arrays
	const eventType = event?.type;
	if (eventType !== "message_update" && eventType !== "message_end") return event;

	const content = event.message?.content;
	if (!Array.isArray(content)) return event;

	let needsTruncation = false;
	for (const block of content) {
		if (truncateMessageContentBlock(block, threshold) !== block) {
			needsTruncation = true;
			break;
		}
	}

	if (!needsTruncation) return event;

	// Build a shallow clone of the event with truncated content blocks
	const newContent = content.map((block: any) => truncateMessageContentBlock(block, threshold));

	return {
		...event,
		message: {
			...event.message,
			content: newContent,
		},
	};
}
