export const CONTEXT_HEAVY_LIMIT = 10;
export const CONTEXT_HEAVY_ERROR_CODE = "CONTEXT_HEAVY_LIMIT_REQUIRED";

export const CONTEXT_HEAVY_FLAGS = {
	bobbit_read: ["verbose"],
	bobbit_orchestrate: ["verbose"],
	bobbit_admin: ["verbose"],
	read_session: ["verbose", "include_tool_results"],
} as const;

export const CONTEXT_HEAVY_LIMIT_GUIDANCE =
	"You should not typically pull this much data from the API. " +
	"Context-heavy flag(s) {flags} require an explicit limit at or below {cap}. " +
	"Call again with limit <= {cap} and fetch in smaller batches only if you REALLY need full verbosity. " +
	"Keep an eye on token consumption.";

export type ContextHeavyTool = keyof typeof CONTEXT_HEAVY_FLAGS;

export interface ContextHeavyGuardError {
	error: string;
	code: typeof CONTEXT_HEAVY_ERROR_CODE;
}

/** Return active context-heavy flags in their canonical per-tool order. */
export function activeContextHeavyFlags(
	tool: ContextHeavyTool,
	params: Record<string, unknown>,
): string[] {
	return CONTEXT_HEAVY_FLAGS[tool].filter((flag) => params[flag] === true);
}

/** Format the canonical recovery guidance for the active flags. */
export function formatContextHeavyLimitGuidance(flags: readonly string[]): string {
	const formattedFlags = flags.map((flag) => `\`${flag}\``).join(", ");
	return CONTEXT_HEAVY_LIMIT_GUIDANCE
		.replace("{flags}", formattedFlags)
		.replaceAll("{cap}", String(CONTEXT_HEAVY_LIMIT));
}

/**
 * Reject context-heavy reads unless a pageable tool receives a raw, explicit,
 * conservative integer limit. Non-pageable operations have nothing to bound.
 */
export function contextHeavyLimitError(
	tool: ContextHeavyTool,
	params: Record<string, unknown>,
	pageable: boolean,
): ContextHeavyGuardError | undefined {
	const flags = activeContextHeavyFlags(tool, params);
	if (!pageable || flags.length === 0) return undefined;

	const limit = params.limit;
	if (
		typeof limit === "number"
		&& Number.isFinite(limit)
		&& Number.isInteger(limit)
		&& limit >= 1
		&& limit <= CONTEXT_HEAVY_LIMIT
	) {
		return undefined;
	}

	return {
		error: formatContextHeavyLimitGuidance(flags),
		code: CONTEXT_HEAVY_ERROR_CODE,
	};
}
