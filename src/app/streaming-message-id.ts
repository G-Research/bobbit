/**
 * Compute the `streamingMessageId` for an in-flight assistant `message_end`
 * that has tool calls.
 *
 * The streaming container keeps showing the message until the next event
 * arrives; we need a stable id so the visible-messages filter in
 * `AgentInterface` can hide the duplicate row in `state.messages`.
 *
 * Resolution order:
 *   1. `msg.id` when it's a non-empty string (happy path).
 *   2. `synth:tc:<firstToolCallId>` when `msg.content` contains at least one
 *      `toolCall` block whose `id` is a non-empty string. Real LLM streams
 *      sometimes deliver assistant `message_end` without stamping an id
 *      (undefined / null / numeric / 0 / ""); falling back to the toolCall id
 *      keeps the streaming-card filter stable across deltas.
 *   3. `undefined` when neither is available.
 *
 * The same value MUST be stamped onto the reducer entry (in `remote-agent.ts`)
 * so the visible-messages filter's `m.id !== streamingMessageId` check works.
 */
export function computeStreamingMessageId(msg: { id?: unknown; content?: any[] }): string | undefined {
	if (typeof msg.id === "string" && (msg.id as string).length > 0) return msg.id as string;
	if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (block && block.type === "toolCall" && typeof block.id === "string" && block.id.length > 0) {
				return `synth:tc:${block.id}`;
			}
		}
	}
	return undefined;
}
