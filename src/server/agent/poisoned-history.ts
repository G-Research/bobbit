/**
 * Anthropic rejects a conversation when a tool_result references a tool_use
 * that is not present in the immediately preceding assistant message. Keep
 * this predicate deliberately narrow: ordinary HTTP 400 validation failures
 * must not trigger an identity-preserving transcript repair/respawn.
 */
export function isOrphanToolResultOrderingError(message: string | undefined): boolean {
	if (!message) return false;
	return /messages\.\d+\.content\.\d+/i.test(message)
		&& /unexpected\s+tool_use_id/i.test(message)
		&& /tool[_ -]?result/i.test(message)
		&& /(?:corresponding[^.\n]*tool[_ -]?use|tool[_ -]?use[^.\n]*(?:previous|preceding)|(?:previous|preceding)[^.\n]*tool[_ -]?use)/i.test(message);
}
