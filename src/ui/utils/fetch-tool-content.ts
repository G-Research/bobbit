import { gatewayFetch } from "../../app/api.js";

/**
 * Fetch full tool input content from the server on demand.
 * Used when content was truncated in the WebSocket broadcast for performance.
 *
 * @param sessionId - The session that owns the message
 * @param messageIndex - Index of the message in the conversation
 * @param blockIndex - Index of the content block within the message
 * @returns The full content string
 */
export async function fetchToolContent(
	sessionId: string,
	messageIndex: number,
	blockIndex: number,
): Promise<string> {
	const res = await gatewayFetch(
		`/api/sessions/${sessionId}/tool-content/${messageIndex}/${blockIndex}`,
	);
	if (!res.ok) {
		throw new Error(`Failed to fetch tool content: ${res.status} ${res.statusText}`);
	}
	const json = await res.json();
	return json.content;
}
