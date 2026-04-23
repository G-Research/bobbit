/**
 * Truncates large tool_use content in agent events before broadcasting
 * over WebSocket and storing in EventBuffer.
 *
 * This prevents catastrophic memory pressure when agents write large files
 * (10MB+) — each streaming token would otherwise broadcast the full
 * accumulated content through multiple JSON serialization stages.
 *
 * The original event is never mutated — a shallow clone is returned when
 * truncation occurs. Events that don't need truncation are returned as-is
 * (zero overhead).
 */

/** Default threshold: 32KB. Normal code files pass through untouched. */
export const LARGE_CONTENT_THRESHOLD = 32 * 1024;

/** Sentinel prefix on preview_open snapshot tool_result text blocks. */
const PREVIEW_SNAPSHOT_MARKER = "__preview_snapshot_v1__\n";

export interface TruncatedContent {
	_truncated: true;
	_originalLength: number;
	preview: string;
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
	if (!block.text.startsWith(PREVIEW_SNAPSHOT_MARKER)) return block;
	if (block._truncated) return block;
	if (block.text.length <= threshold) return block;
	const html = block.text.slice(PREVIEW_SNAPSHOT_MARKER.length);
	return {
		...block,
		text: PREVIEW_SNAPSHOT_MARKER,
		_truncated: true,
		_originalLength: block.text.length,
		preview: html.slice(0, 512),
	};
}

/** True if the message's role marks it as a tool_result. */
function isToolResultMessage(msg: any): boolean {
	return msg?.role === "toolResult" || msg?.role === "tool_result" || msg?.role === "tool";
}

/** Helper: check if a content block is a tool call (either format) */
function isToolBlock(block: any): boolean {
	return block?.type === "toolCall" || block?.type === "tool_use";
}

/**
 * Truncate large tool content inside a list of persisted messages (as
 * returned by the agent's `get_messages` RPC). Used when sending history
 * to clients on session open / reconnect / tab wake — previously, the full
 * untruncated history was serialized into a single WebSocket frame, which
 * caused very slow (and sometimes failing) history loads for sessions with
 * large file writes/reads.
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
		const isToolResult = isToolResultMessage(msg);
		const newContent = content.map((block: any) => {
			if (isToolResult) {
				const truncatedSnap = truncateSnapshotBlock(block, threshold);
				if (truncatedSnap !== block) {
					msgChanged = true;
					return truncatedSnap;
				}
				return block;
			}
			if (!isToolBlock(block)) return block;
			const c = getToolContent(block);
			if (c === undefined || c.length <= threshold) return block;
			msgChanged = true;
			const truncatedContent: TruncatedContent = {
				_truncated: true,
				_originalLength: c.length,
				preview: c.slice(0, 512),
			};
			if (block.arguments?.content !== undefined) {
				return { ...block, arguments: { ...block.arguments, content: truncatedContent } };
			}
			return { ...block, input: { ...block.input, content: truncatedContent } };
		});
		if (!msgChanged) return msg;
		changed = true;
		return { ...msg, content: newContent };
	});
	return changed ? out : messages;
}

/** Helper: get the string content from a tool block (either format) */
function getToolContent(block: any): string | undefined {
	const c = block.arguments?.content ?? block.input?.content;
	return typeof c === "string" ? c : undefined;
}

/**
 * If the event is a `message_update` or `message_end` containing tool_use
 * or toolCall blocks with large string content, return a shallow clone with
 * those content values replaced by a truncated descriptor.
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

	const isToolResult = isToolResultMessage(event.message);

	// Scan for any block that needs truncation
	let needsTruncation = false;
	for (const block of content) {
		if (isToolResult) {
			if (truncateSnapshotBlock(block, threshold) !== block) {
				needsTruncation = true;
				break;
			}
		}
		if (isToolBlock(block)) {
			const c = getToolContent(block);
			if (c !== undefined && c.length > threshold) {
				needsTruncation = true;
				break;
			}
		}
	}

	if (!needsTruncation) return event;

	// Build a shallow clone of the event with truncated content blocks
	const newContent = content.map((block: any) => {
		if (isToolResult) {
			const truncatedSnap = truncateSnapshotBlock(block, threshold);
			if (truncatedSnap !== block) return truncatedSnap;
			return block;
		}
		if (!isToolBlock(block)) return block;
		const c = getToolContent(block);
		if (c === undefined || c.length <= threshold) return block;

		const truncatedContent: TruncatedContent = {
			_truncated: true,
			_originalLength: c.length,
			preview: c.slice(0, 512),
		};

		// Preserve the original field structure (arguments vs input)
		if (block.arguments?.content !== undefined) {
			return {
				...block,
				arguments: { ...block.arguments, content: truncatedContent },
			};
		}
		return {
			...block,
			input: { ...block.input, content: truncatedContent },
		};
	});

	return {
		...event,
		message: {
			...event.message,
			content: newContent,
		},
	};
}
