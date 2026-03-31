/**
 * Extracts indexable text content and tool names from agent messages.
 * Used by both incremental indexing (live messages) and full rebuild (scanning .jsonl files).
 */

export interface ExtractedContent {
	text: string;
	toolNames: string[];
}

/**
 * Extract text content blocks and tool call names from a message object.
 * 
 * Indexes:
 * - Text content blocks from assistant messages
 * - Tool call/use names (so "which session used web_search" works)
 * 
 * Skips:
 * - Thinking blocks
 * - Tool results (too noisy)
 * - Binary/image content
 * - System messages
 * - User messages (we index assistant output only)
 */
export function extractTextFromMessage(message: unknown): ExtractedContent {
	if (!message || typeof message !== "object") {
		return { text: "", toolNames: [] };
	}

	const msg = message as Record<string, unknown>;
	const role = msg.role as string | undefined;

	// Only index assistant messages
	if (role !== "assistant") {
		return { text: "", toolNames: [] };
	}

	const textParts: string[] = [];
	const toolNames: string[] = [];

	const content = msg.content;

	// Handle string content (simple text message)
	if (typeof content === "string") {
		return { text: content, toolNames: [] };
	}

	// Handle array content blocks
	if (Array.isArray(content)) {
		for (const block of content) {
			if (!block || typeof block !== "object") continue;

			const b = block as Record<string, unknown>;
			const type = b.type as string | undefined;

			switch (type) {
				case "text":
					if (typeof b.text === "string") {
						textParts.push(b.text);
					}
					break;

				case "tool_use":
					// Index tool name so users can search "which session used web_search"
					if (typeof b.name === "string") {
						toolNames.push(b.name);
					}
					break;

				// Skip these block types:
				// - "thinking" blocks (internal reasoning, not useful for search)
				// - "tool_result" blocks (tool output, too noisy)
				// - "image" blocks (binary content)
				// - anything else unknown
			}
		}
	}

	return {
		text: textParts.join("\n"),
		toolNames,
	};
}
