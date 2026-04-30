/**
 * Acceptance-criteria parser for goal specs.
 *
 * Lives in `src/shared/` so both the server (mutation classifier in
 * `src/server/agent/plan-mutation.ts`) and the client (Plan tab UI in
 * `src/app/`) can import it without bundling `node:fs`. Pure string parsing.
 *
 * See `docs/design/nested-goals.md` §1.3.
 */

/**
 * Parse the `## Acceptance criteria` (or `## Acceptance Criteria`) section of
 * a goal spec into a flat list of criterion strings.
 *
 * Recognised section header (case-insensitive, optional trailing colon):
 *   `^##\s+Acceptance criteria:?\s*$`
 *
 * Within the section, each top-level list item (`- `, `* `, `1. `, `1) `)
 * becomes one criterion. Sub-bullets are flattened by joining their text into
 * the parent with `\n  ` separators so the substring-match check used by the
 * mutation classifier still works.
 *
 * Non-list lines inside the section (paragraphs, headings) are ignored.
 *
 * The section ends at the next ATX heading at the same level or shallower
 * (`#` or `##`). A `### Sub-heading` inside the section is treated as the
 * section terminator too — anything after a deeper heading is excluded
 * because it's no longer "acceptance criteria" content.
 *
 * Returns `[]` if the section header is missing.
 */
export function parseAcceptanceCriteria(spec: string): string[] {
	if (!spec || typeof spec !== "string") return [];

	const lines = spec.split(/\r?\n/);

	// Find the section header. Match `^##\s+Acceptance criteria:?\s*$`
	// case-insensitively. Any heading depth >= 2 is allowed but the spec
	// docs `##` so we accept exactly that.
	const headerRe = /^##\s+acceptance\s+criteria:?\s*$/i;
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (headerRe.test(lines[i])) {
			start = i + 1;
			break;
		}
	}
	if (start === -1) return [];

	// Find the section end — next heading at depth 1 or 2 (`# ` / `## `),
	// or end-of-file. A deeper heading (`### `+) terminates too because the
	// content beyond it is no longer "criteria" prose.
	let end = lines.length;
	for (let i = start; i < lines.length; i++) {
		if (/^#{1,6}\s+/.test(lines[i])) {
			end = i;
			break;
		}
	}

	const sectionLines = lines.slice(start, end);

	// Tokenise into items. Top-level item starts at column 0 with `- `,
	// `* `, `+ `, `1. ` or `1) `. Continuation/sub-bullet lines are any
	// non-empty indented line (starts with whitespace) following a top-
	// level item. We collect each top-level item and its continuation
	// lines into a single string, joined with `\n  `.
	const TOP_LEVEL = /^[-*+]\s+(.+)$/;
	const TOP_LEVEL_NUM = /^\d+[.)]\s+(.+)$/;
	const INDENTED = /^\s+\S/;

	const items: string[] = [];
	let current: string[] | null = null;

	const pushCurrent = () => {
		if (!current) return;
		// Normalise whitespace: collapse runs of internal whitespace inside
		// each segment and join with `\n  ` so multi-line items remain
		// distinguishable to the substring matcher.
		const normalised = current
			.map(seg => seg.replace(/\s+/g, " ").trim())
			.filter(seg => seg.length > 0)
			.join("\n  ");
		if (normalised.length > 0) items.push(normalised);
		current = null;
	};

	for (const raw of sectionLines) {
		const line = raw.replace(/\s+$/, ""); // trim right
		if (line.trim().length === 0) {
			// Blank line — within a list this often means "end of item" or
			// "between paragraphs". Be lenient: blank line ends the current
			// item only if the very next non-blank line is *not* an indented
			// continuation. To keep parsing single-pass we close on the next
			// top-level marker / heading instead, so just drop blank lines.
			continue;
		}

		const topMatch = line.match(TOP_LEVEL) ?? line.match(TOP_LEVEL_NUM);
		if (topMatch) {
			pushCurrent();
			current = [topMatch[1]];
			continue;
		}

		if (current && INDENTED.test(line)) {
			// Continuation / sub-bullet — strip any leading list marker on
			// the indented line so nested bullets don't keep their `-`.
			const stripped = line
				.replace(/^\s+/, "")
				.replace(/^[-*+]\s+/, "")
				.replace(/^\d+[.)]\s+/, "");
			current.push(stripped);
			continue;
		}

		// Non-list line at column 0 (paragraph / heading) — close current
		// item and ignore the line.
		pushCurrent();
	}
	pushCurrent();

	return items;
}
