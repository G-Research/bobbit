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

/** Helper: check if a content block is a tool call (either format) */
function isToolBlock(block: any): boolean {
	return block?.type === "toolCall" || block?.type === "tool_use";
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

	// Scan for any tool block that needs truncation
	let needsTruncation = false;
	for (const block of content) {
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
