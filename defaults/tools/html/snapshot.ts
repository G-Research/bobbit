/**
 * Shared sentinels and helpers for the `preview_open` snapshot block.
 *
 * When the `preview_open` tool successfully opens a preview, a second
 * `{type:"text"}` block is appended to the tool_result, prefixed with one
 * of the versioned markers below. This lets the UI re-open historical
 * previews without re-reading files, and lets the truncation pipeline
 * recognise snapshot blocks and slim them out of agent-facing context.
 *
 * Marker formats:
 *
 *   v1 (inline / raw HTML):
 *     __preview_snapshot_v1__\n<full-html-bytes>
 *
 *   v2 (file-mode, just a path on disk):
 *     __preview_snapshot_v2__\n{"kind":"file","path":"/abs/path/to/report.html"}\n
 *
 * v1 is unchanged from the original implementation. v2 is purely additive.
 */

export const PREVIEW_SNAPSHOT_MARKER_V1 = "__preview_snapshot_v1__\n";
export const PREVIEW_SNAPSHOT_MARKER_V2 = "__preview_snapshot_v2__\n";

/** All known marker prefixes. */
export const PREVIEW_SNAPSHOT_MARKERS = [
	PREVIEW_SNAPSHOT_MARKER_V1,
	PREVIEW_SNAPSHOT_MARKER_V2,
] as const;

/** Backwards-compatible alias — historical code refers to the v1 marker as
 *  "the" marker. New code should reference v1 / v2 explicitly. */
export const PREVIEW_SNAPSHOT_MARKER = PREVIEW_SNAPSHOT_MARKER_V1;

/** True if `text` is a string and starts with any known snapshot marker. */
export function isSnapshotBlock(text: unknown): text is string {
	if (typeof text !== "string") return false;
	for (const m of PREVIEW_SNAPSHOT_MARKERS) {
		if (text.startsWith(m)) return true;
	}
	return false;
}

/** Strip the v1 marker prefix and return the raw HTML snapshot.
 *  Kept for backwards compatibility — only meaningful for v1. */
export function extractSnapshot(text: string): string {
	if (!text.startsWith(PREVIEW_SNAPSHOT_MARKER_V1)) return text;
	return text.slice(PREVIEW_SNAPSHOT_MARKER_V1.length);
}

/** Discriminated union returned by `parseSnapshot`. */
export type ParsedSnapshot =
	| { kind: "inline"; html: string }
	| { kind: "file"; path: string };

/**
 * Parse a snapshot text block into a discriminated union. Returns null if
 * the text does not start with any known marker.
 *
 *   v1 → { kind: "inline", html: <bytes after marker> }
 *   v2 → { kind: "file",   path: <path from JSON payload> }
 *
 * Malformed v2 payloads return null (caller should treat as missing).
 */
export function parseSnapshot(text: unknown): ParsedSnapshot | null {
	if (typeof text !== "string") return null;
	if (text.startsWith(PREVIEW_SNAPSHOT_MARKER_V1)) {
		return { kind: "inline", html: text.slice(PREVIEW_SNAPSHOT_MARKER_V1.length) };
	}
	if (text.startsWith(PREVIEW_SNAPSHOT_MARKER_V2)) {
		const body = text.slice(PREVIEW_SNAPSHOT_MARKER_V2.length).trim();
		try {
			const parsed = JSON.parse(body);
			if (parsed && parsed.kind === "file" && typeof parsed.path === "string" && parsed.path.length > 0) {
				return { kind: "file", path: parsed.path };
			}
		} catch {
			/* fall through */
		}
		return null;
	}
	return null;
}

/** Build a v2 marker block for a file-mode preview. The resulting string is
 *  guaranteed to be < 1 KB for any realistic absolute path. */
export function buildFileSnapshotBlock(absPath: string): string {
	const payload = JSON.stringify({ kind: "file", path: absPath });
	return PREVIEW_SNAPSHOT_MARKER_V2 + payload + "\n";
}
