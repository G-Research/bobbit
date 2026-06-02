// Compact sidebar ("nav") labels for PR walkthrough cards and orientation beats.
// The rail is narrow (~240px); labels longer than a few words truncate badly, so
// every sidebar entry uses a short label distinct from the full descriptive title.

export const NAV_LABEL_MAX_WORDS = 3;
export const NAV_LABEL_MAX_CHARS = 24;

const NAV_LABEL_ERROR = `nav_label must be ≤${NAV_LABEL_MAX_WORDS} words and ≤${NAV_LABEL_MAX_CHARS} characters.`;
const NAV_LABEL_EMPTY_ERROR = "nav_label must not be empty.";

/**
 * Validate a nav label: non-empty after trim AND ≤3 words AND ≤24 chars.
 * Returns an actionable error string, or null when valid. An empty or
 * whitespace-only label is invalid so callers that validate-then-fallback
 * derive a compact label from the title instead of rendering a blank rail entry.
 */
export function navLabelError(value: string): string | null {
	const trimmed = value.trim();
	if (trimmed.length === 0) return NAV_LABEL_EMPTY_ERROR;
	const wordCount = trimmed.split(/\s+/).length;
	if (wordCount > NAV_LABEL_MAX_WORDS || trimmed.length > NAV_LABEL_MAX_CHARS) return NAV_LABEL_ERROR;
	return null;
}

/**
 * Derive a compact rail label from a full title:
 *   - take the text before the first ':' / '—' / ' - ' when that prefix is non-empty,
 *     otherwise use the whole title;
 *   - keep the first ≤3 words;
 *   - if the result is still >24 chars, hard-truncate to 23 chars + '…'.
 */
export function deriveNavLabel(title: string): string {
	const trimmed = (title ?? "").trim();
	if (trimmed.length === 0) return "";

	let head = trimmed;
	const separator = /\s-\s|[:—]/.exec(trimmed);
	if (separator) {
		const prefix = trimmed.slice(0, separator.index).trim();
		if (prefix.length > 0) head = prefix;
	}

	const label = head.split(/\s+/).slice(0, NAV_LABEL_MAX_WORDS).join(" ");
	if (label.length > NAV_LABEL_MAX_CHARS) return `${label.slice(0, NAV_LABEL_MAX_CHARS - 1)}…`;
	return label;
}
