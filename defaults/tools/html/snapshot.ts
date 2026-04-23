/**
 * Shared sentinel and helpers for the `preview_open` snapshot block.
 *
 * When the `preview_open` tool successfully opens a preview, the resolved HTML
 * is captured as a second `{type:"text"}` block in the tool_result, prefixed
 * with the versioned marker below. This lets the UI re-open historical previews
 * without re-reading files, and lets the truncation pipeline recognise snapshot
 * blocks and slim them out of agent-facing context.
 */

export const PREVIEW_SNAPSHOT_MARKER = "__preview_snapshot_v1__\n";

/** True if `text` is a string and starts with the snapshot marker. */
export function isSnapshotBlock(text: unknown): text is string {
	return typeof text === "string" && text.startsWith(PREVIEW_SNAPSHOT_MARKER);
}

/** Strip the marker prefix and return the raw HTML snapshot. */
export function extractSnapshot(text: string): string {
	if (!text.startsWith(PREVIEW_SNAPSHOT_MARKER)) return text;
	return text.slice(PREVIEW_SNAPSHOT_MARKER.length);
}
