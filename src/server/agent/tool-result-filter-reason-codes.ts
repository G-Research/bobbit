/** Core-owned reason vocabulary for all filtered-result observability. */
export const TOOL_RESULT_FILTER_REASON_CODES = [
	"no-filter",
	"filter-passed",
	"filter-replaced",
	"filter-redacted",
	"filter-rejected",
	"filter-lower-priority",
	"filter-grant-required",
	"filter-disabled-or-revoked",
	"filter-malformed",
	"filter-timed-out",
	"filter-unavailable",
	"filter-authority-unavailable",
	"filter-authority-changed",
	"filter-aborted",
	"filter-admission-rejected",
] as const;

export type ToolResultFilterReasonCode = typeof TOOL_RESULT_FILTER_REASON_CODES[number];

const reasonCodes = new Set<string>(TOOL_RESULT_FILTER_REASON_CODES);

export function isToolResultFilterReasonCode(value: unknown): value is ToolResultFilterReasonCode {
	return typeof value === "string" && reasonCodes.has(value);
}
