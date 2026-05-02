/**
 * Parse a "## Acceptance criteria" section out of spec markdown.
 * Returns each list item as a string (trimmed). Heading match is
 * case-insensitive; supports H1-H3. Items: "- item", "* item", "1. item",
 * "1) item".
 *
 * Section ends at the next heading of equal or shallower depth.
 *
 * Used by:
 * - GoalManager.createGoal (auto-populates PersistedGoal.acceptanceCriteria)
 * - plan-mutation classifier (criteria-coverage check) — Phase 4
 *
 * Edge cases handled:
 * - Heading variants: "# Acceptance criteria", "## acceptance criteria",
 *   "### Acceptance Criteria"
 * - Bullet styles: "-", "*", "1.", "1)"
 * - Code-fenced regions inside the section are skipped (no parse inside ```)
 * - Multi-paragraph items (continuation lines) flatten with single-space joins
 * - Empty section / missing section → []
 * - Section ends at the next heading of equal or shallower depth than the
 *   matched header
 *
 * No DOM, no Lit, no node-only APIs. Importable from server and app.
 */

const ACCEPTANCE_HEADING_RE = /^(#{1,3})\s+acceptance\s+criteria\s*$/i;
const HEADING_RE = /^(#{1,6})\s+/;
const CODE_FENCE_RE = /^(```|~~~)/;
const BULLET_RE = /^\s*(?:[-*]|\d+[.)])\s+(.+)$/;
// A line that opens a bullet but has no content after the marker (e.g. "-").
const EMPTY_BULLET_RE = /^\s*(?:[-*]|\d+[.)])\s*$/;
// Continuation lines must begin with whitespace (indented under the prior
// bullet); flush bullets that aren't indented.

export function parseAcceptanceCriteria(specMarkdown: string): string[] {
	if (!specMarkdown) return [];
	const lines = specMarkdown.split(/\r?\n/);

	// Locate the heading. Track whether we're inside a code fence so a
	// "## Acceptance criteria" line buried in a fenced block isn't matched.
	let inFence = false;
	let headingDepth = -1;
	let i = 0;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (CODE_FENCE_RE.test(line.trim())) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const m = ACCEPTANCE_HEADING_RE.exec(line.trim());
		if (m) {
			headingDepth = m[1].length;
			i++;
			break;
		}
	}
	if (headingDepth < 0) return [];

	// Collect items until the next heading of equal-or-shallower depth, or EOF.
	// Track code-fence state from the heading scan onward (independent of the
	// outer scan above — we restart the toggle here).
	inFence = false;
	const items: string[] = [];
	let current: string | null = null;

	const flush = () => {
		if (current !== null) {
			const trimmed = current.trim();
			if (trimmed.length > 0) items.push(trimmed);
			current = null;
		}
	};

	for (; i < lines.length; i++) {
		const raw = lines[i];
		const trimmed = raw.trim();

		// Code fence toggling — fenced lines are not parsed.
		if (CODE_FENCE_RE.test(trimmed)) {
			inFence = !inFence;
			// Fence boundaries terminate any in-progress item.
			flush();
			continue;
		}
		if (inFence) {
			// Inside a fence: skip — bullets and headings have no meaning.
			continue;
		}

		// Stop at the next heading of equal-or-shallower depth.
		const headingMatch = HEADING_RE.exec(raw);
		if (headingMatch) {
			const depth = headingMatch[1].length;
			if (depth <= headingDepth) {
				flush();
				return items;
			}
			// Deeper heading — treat as section content boundary; flush the
			// current item but keep going (deeper headings aren't list
			// items so we just don't add to current).
			flush();
			continue;
		}

		// Blank line ends the current item (standard markdown semantics for
		// loose lists).
		if (trimmed === "") {
			flush();
			continue;
		}

		const bullet = BULLET_RE.exec(raw);
		if (bullet) {
			flush();
			current = bullet[1];
			continue;
		}

		// Empty bullet marker (e.g. a lone "-") — flushes the current item
		// and starts nothing new. Without this branch, the line falls
		// through and gets treated as a continuation of the prior item.
		if (EMPTY_BULLET_RE.test(raw)) {
			flush();
			continue;
		}

		// Continuation line — append to the current item with a single space.
		// Outside a list (no current item) we ignore non-bullet content.
		if (current !== null) {
			current = `${current} ${trimmed}`;
		}
	}

	flush();
	return items;
}
