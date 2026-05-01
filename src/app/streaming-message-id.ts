/**
 * Compute the `streamingMessageId` for an in-flight assistant `message_end`
 * that has tool calls.
 *
 * The streaming container keeps showing the message until the next event
 * arrives; we need a stable id so the visible-messages filter in
 * `AgentInterface` can hide the duplicate row in `state.messages`.
 *
 * NOTE: current behavior matches the legacy inline ternary in
 * `remote-agent.ts` — returns `undefined` whenever `msg.id` is not a
 * non-empty string (undefined / null / numeric / 0 / ""). Real LLM streams
 * produce these in practice, which causes the dual-render bug. The fix
 * (synthetic `synth:tc:<firstToolCallId>` fallback) lands in the
 * implementation gate.
 */
export function computeStreamingMessageId(msg: { id?: unknown; content?: any[] }): string | undefined {
	if (typeof msg.id === "string" && (msg.id as string).length > 0) return msg.id as string;
	return undefined;
}
