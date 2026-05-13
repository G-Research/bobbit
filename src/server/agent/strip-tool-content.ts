/**
 * Phase 2B: lazy-tool-content strip helper for `GET /api/sessions/:id`.
 *
 * Hypothesis (see docs/perf/sidebar-nav-baseline.md): the initial session
 * payload ships tool input/output blobs that aren't rendered on first
 * paint. Stripping blobs above a low threshold (default 4KB) and lazy-
 * loading them on demand via the existing
 * `GET /api/sessions/:id/tool-content/:mi/:bi` endpoint should reduce the
 * `api.session.fetch` payload size + parse time and, by extension, the
 * `nav.session.ready` p50/p95.
 *
 * This is the **lower-threshold sibling** of `truncate-large-content.ts`
 * (32KB hard cap, applied always on the WebSocket transport). The two
 * differ in intent:
 *   - `truncate-large-content` is a transport-safety floor (never ship a
 *     10MB blob through a WebSocket frame).
 *   - `strip-tool-content`   is an opt-in perf-experiment floor (drop
 *     anything bigger than 4KB out of the initial REST payload because the
 *     renderer can already lazy-load it).
 *
 * Default behaviour is unchanged — the strip is only applied when the
 * caller opts in via `?stripToolContent=1`. The output uses the same
 * `TruncatedContent` shape that `truncate-large-content.ts` produces and
 * that `src/ui/tools/renderers/WriteRenderer.ts` already renders with the
 * existing "Load full content" lazy-fetch hook. No renderer changes
 * needed.
 *
 * Pinning test: `tests/session-strip-tool-content.test.ts`.
 */

/**
 * Default threshold for the strip-tool-content path. Lower than
 * `LARGE_CONTENT_THRESHOLD` (32KB) because most tool-call inputs are <4KB
 * and anything bigger is a file write that the renderer collapses behind
 * a "Load full content" affordance anyway.
 */
export const STRIP_TOOL_CONTENT_DEFAULT_THRESHOLD = 4 * 1024;

/**
 * Shape produced when a tool content string is stripped. Intentionally
 * identical to the `TruncatedContent` shape produced by
 * `truncate-large-content.ts` so the existing
 * `WriteRenderer`/`Messages.ts::_onLoadFullContent` flow lights up
 * unchanged.
 */
export interface StrippedContent {
	_truncated: true;
	_originalLength: number;
	preview: string;
}

/** Preview prefix length kept inline alongside the stripped descriptor. */
const PREVIEW_CHARS = 512;

function isToolBlock(block: any): boolean {
	return block?.type === "toolCall" || block?.type === "tool_use";
}

function getToolContent(block: any): string | undefined {
	const c = block?.arguments?.content ?? block?.input?.content;
	return typeof c === "string" ? c : undefined;
}

/**
 * Strip tool-call content strings larger than `threshold` from a list of
 * persisted messages (same shape as the agent's `get_messages` RPC).
 *
 * Returns:
 *   - The original array (referential equality) when no block needs
 *     stripping. Cheap when nothing matches.
 *   - A shallow-cloned array when at least one block is rewritten. Each
 *     rewritten block has its `arguments.content` / `input.content`
 *     replaced with a `StrippedContent` descriptor. Other blocks pass
 *     through untouched (referential equality).
 *
 * `stats` is mutated to record how many blocks were stripped and the
 * total original byte count — useful for the `[timing]` log line and the
 * A/B report.
 */
export function stripLargeToolContentInMessages(
	messages: unknown,
	threshold: number = STRIP_TOOL_CONTENT_DEFAULT_THRESHOLD,
	stats?: { stripped: number; bytes: number },
): unknown {
	if (!Array.isArray(messages)) return messages;
	let changed = false;
	const out = messages.map((msg: any) => {
		const content = msg?.content;
		if (!Array.isArray(content)) return msg;
		let msgChanged = false;
		const newContent = content.map((block: any) => {
			if (!isToolBlock(block)) return block;
			const c = getToolContent(block);
			if (c === undefined || c.length <= threshold) return block;
			msgChanged = true;
			if (stats) {
				stats.stripped++;
				stats.bytes += c.length;
			}
			const stripped: StrippedContent = {
				_truncated: true,
				_originalLength: c.length,
				preview: c.slice(0, PREVIEW_CHARS),
			};
			if (block.arguments?.content !== undefined) {
				return { ...block, arguments: { ...block.arguments, content: stripped } };
			}
			return { ...block, input: { ...block.input, content: stripped } };
		});
		if (!msgChanged) return msg;
		changed = true;
		return { ...msg, content: newContent };
	});
	return changed ? out : messages;
}

/**
 * Parse the strip-threshold from a URL query string. Accepts:
 *   - missing / empty / "1" / "true" → use default 4KB
 *   - integer N (bytes) → use that threshold
 *   - any other / negative / non-finite → use default 4KB
 *
 * Defensive: never throws. The route handler should never crash on a
 * malformed query string.
 */
export function parseStripThreshold(raw: string | null | undefined): number {
	if (raw === null || raw === undefined) return STRIP_TOOL_CONTENT_DEFAULT_THRESHOLD;
	if (raw === "" || raw === "1" || raw === "true") return STRIP_TOOL_CONTENT_DEFAULT_THRESHOLD;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return STRIP_TOOL_CONTENT_DEFAULT_THRESHOLD;
	return Math.floor(n);
}
