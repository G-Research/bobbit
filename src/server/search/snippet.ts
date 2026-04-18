/**
 * Snippet highlighter — LanceDB / hybrid-query side of the `<b>…</b>`
 * contract that FTS5's `snippet()` used to produce. The UI (search-page)
 * already renders these snippets as HTML, so we must preserve:
 *
 *   - `<b>` wrapping around matched query terms.
 *   - HTML-escaped surrounding text (so raw source can't inject tags).
 *   - A ~300-char window centred on the earliest match, with `…`
 *     ellipses where we trimmed.
 *   - Case-insensitive matching across multi-token queries.
 *
 * See docs/design/semantic-search.md §7.
 */

// ── Public API ───────────────────────────────────────────────────────

export interface HighlightOptions {
	/** Approximate window width in characters. Default 300. */
	windowChars?: number;
}

/**
 * Produce an HTML snippet for `text` with `query` terms wrapped in `<b>`.
 * Output is safe to render as `innerHTML` — the non-`<b>` text is
 * HTML-escaped.
 */
export function highlight(text: string, query: string, options: HighlightOptions = {}): string {
	const windowChars = options.windowChars ?? 300;
	if (!text) return "";

	const tokens = tokenizeQuery(query);
	// No query terms → just a head-of-text preview, HTML-escaped.
	if (tokens.length === 0) {
		const head = text.length > windowChars ? text.slice(0, windowChars) + "…" : text;
		return escapeHtml(head);
	}

	// Find all match ranges (non-overlapping, token-by-token, earliest first).
	const matches = findMatches(text, tokens);

	// No matches — head-of-text preview.
	if (matches.length === 0) {
		const head = text.length > windowChars ? text.slice(0, windowChars) + "…" : text;
		return escapeHtml(head);
	}

	// Window centred on the earliest match.
	const first = matches[0];
	const center = Math.floor((first.start + first.end) / 2);
	const half = Math.floor(windowChars / 2);
	let winStart = Math.max(0, center - half);
	let winEnd = Math.min(text.length, winStart + windowChars);
	// Rebalance if we hit the tail edge.
	if (winEnd - winStart < windowChars) {
		winStart = Math.max(0, winEnd - windowChars);
	}

	const leadingEllipsis = winStart > 0;
	const trailingEllipsis = winEnd < text.length;

	// Clip matches to the window and render.
	const clipped = matches.filter((m) => m.end > winStart && m.start < winEnd);

	let out = "";
	let cursor = winStart;
	for (const m of clipped) {
		const ms = Math.max(m.start, winStart);
		const me = Math.min(m.end, winEnd);
		if (ms > cursor) out += escapeHtml(text.slice(cursor, ms));
		out += "<b>" + escapeHtml(text.slice(ms, me)) + "</b>";
		cursor = me;
	}
	if (cursor < winEnd) out += escapeHtml(text.slice(cursor, winEnd));

	return (leadingEllipsis ? "…" : "") + out + (trailingEllipsis ? "…" : "");
}

// ── Internals ────────────────────────────────────────────────────────

interface MatchRange {
	start: number;
	end: number;
}

/** Split a query into case-insensitive search tokens, longest first. */
function tokenizeQuery(query: string): string[] {
	if (!query) return [];
	// Keep word-ish chars — matches the FTS5-era behaviour that ignored
	// operators like `AND` / quotes at the boundary. Unicode-aware.
	const raw = query
		.toLowerCase()
		.split(/[^\p{L}\p{N}_]+/u)
		.filter((t) => t.length > 0);
	// Deduplicate and sort by length descending so "foobar" wins over "foo"
	// when both appear.
	const uniq = Array.from(new Set(raw));
	uniq.sort((a, b) => b.length - a.length);
	return uniq;
}

/**
 * Scan `text` for all non-overlapping occurrences of any token. Returns
 * ranges in ascending `start` order.
 */
function findMatches(text: string, tokens: string[]): MatchRange[] {
	const lower = text.toLowerCase();
	const ranges: MatchRange[] = [];
	// Walk the string, at each position trying longest token first.
	let i = 0;
	while (i < lower.length) {
		let matched: MatchRange | null = null;
		for (const tok of tokens) {
			if (tok.length === 0) continue;
			if (lower.startsWith(tok, i)) {
				matched = { start: i, end: i + tok.length };
				break;
			}
		}
		if (matched) {
			ranges.push(matched);
			i = matched.end;
		} else {
			i++;
		}
	}
	return ranges;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
