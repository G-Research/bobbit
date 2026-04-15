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

export interface TruncatedContent {
	_truncated: true;
	_originalLength: number;
	preview: string;
}

/**
 * If the event is a `message_update` or `message_end` containing tool_use
 * blocks with large string content, return a shallow clone with those
 * content values replaced by a truncated descriptor.
 *
 * Returns the original event unchanged when no truncation is needed.
 */
export function truncateLargeToolContent(event: any, threshold: number = LARGE_CONTENT_THRESHOLD): any {
	// Fast-path: only process message events with content arrays
	const eventType = event?.type;
	if (eventType !== "message_update" && eventType !== "message_end") return event;

	const content = event.message?.content;
	if (!Array.isArray(content)) return event;

	// Scan for any tool_use block that needs truncation
	let needsTruncation = false;
	for (const block of content) {
		if (
			block?.type === "tool_use" &&
			typeof block.input?.content === "string" &&
			block.input.content.length > threshold
		) {
			needsTruncation = true;
			break;
		}
	}

	if (!needsTruncation) return event;

	// Build a shallow clone of the event with truncated content blocks
	const newContent = content.map((block: any) => {
		if (
			block?.type === "tool_use" &&
			typeof block.input?.content === "string" &&
			block.input.content.length > threshold
		) {
			const original = block.input.content as string;
			const truncatedContent: TruncatedContent = {
				_truncated: true,
				_originalLength: original.length,
				preview: original.slice(0, 512),
			};
			return {
				...block,
				input: {
					...block.input,
					content: truncatedContent,
				},
			};
		}
		return block;
	});

	return {
		...event,
		message: {
			...event.message,
			content: newContent,
		},
	};
}
