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
 *   v1 (legacy inline / raw HTML — read-only, archived sessions only):
 *     __preview_snapshot_v1__\n<full-html-bytes>
 *
 *   v2 (legacy file-mode, just a path on disk — read-only, archived sessions only):
 *     __preview_snapshot_v2__\n{"kind":"file","path":"/abs/path/to/report.html"}\n
 *
 *   v3 (current — per-session preview mount; constant ~150 byte payload):
 *     __preview_snapshot_v3__\n{"kind":"preview","url":"/preview/<sid>/<entry>","path":"<host-abs>"}\n
 *
 * v1 and v2 marker constants and parser arms are preserved for archived-session
 * compatibility. New code emits **only** v3 — the v1/v2 *builder* functions have
 * been removed.
 */

export const PREVIEW_SNAPSHOT_MARKER_V1 = "__preview_snapshot_v1__\n";
export const PREVIEW_SNAPSHOT_MARKER_V2 = "__preview_snapshot_v2__\n";
export const PREVIEW_SNAPSHOT_MARKER_V3 = "__preview_snapshot_v3__\n";

/** All known marker prefixes. */
export const PREVIEW_SNAPSHOT_MARKERS = [
	PREVIEW_SNAPSHOT_MARKER_V1,
	PREVIEW_SNAPSHOT_MARKER_V2,
	PREVIEW_SNAPSHOT_MARKER_V3,
] as const;

/** Backwards-compatible alias — historical code refers to the v1 marker as
 *  "the" marker. New code should reference v1 / v2 / v3 explicitly. */
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
	| { kind: "file"; path: string }
	| { kind: "preview"; url: string; path: string };

/**
 * Parse a snapshot text block into a discriminated union. Returns null if
 * the text does not start with any known marker.
 *
 *   v1 → { kind: "inline",  html: <bytes after marker> }
 *   v2 → { kind: "file",    path: <path from JSON payload> }
 *   v3 → { kind: "preview", url, path }
 *
 * Malformed v2/v3 payloads return null (caller should treat as missing).
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
	if (text.startsWith(PREVIEW_SNAPSHOT_MARKER_V3)) {
		const body = text.slice(PREVIEW_SNAPSHOT_MARKER_V3.length).trim();
		try {
			const parsed = JSON.parse(body);
			if (
				parsed &&
				parsed.kind === "preview" &&
				typeof parsed.url === "string" && parsed.url.length > 0 &&
				typeof parsed.path === "string" && parsed.path.length > 0
			) {
				return { kind: "preview", url: parsed.url, path: parsed.path };
			}
		} catch {
			/* fall through */
		}
		return null;
	}
	return null;
}

/**
 * Build a v3 marker block for a per-session preview-mount entry.
 *
 * Pre-condition: total result block must be ≤ 250 bytes (the unit test
 * asserts this for typical session id + `report.html`).
 */
export function buildPreviewSnapshotV3Block(url: string, hostPath: string): string {
	const payload = JSON.stringify({ kind: "preview", url, path: hostPath });
	return PREVIEW_SNAPSHOT_MARKER_V3 + payload + "\n";
}
