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
 *   v3 (current — per-session preview mount; constant ≤250 byte payload;
 *   `artifactId`, `entry`, and `contentHash` are included when they fit the cap):
 *     __preview_snapshot_v3__\n{"kind":"preview","url":"/preview/<sid>/<entry>","path":"<sid>/<entry>","entry":"<entry>","contentHash":"<sha256>","artifactId":"<id>"}\n
 *
 *   The `path` field normally carries the project-root-relative identifier
 *   (`<sessionId>/<entry>`, forward slashes on every OS) rather than the
 *   host-absolute path. When artifact metadata plus the SHA-256 hash would
 *   exceed the 250 B cap, the builder emits compact aliases (`e`/`a`/`h`) and
 *   may shorten `path` to the entry filename because `entry` is explicit.
 *   Block size is therefore bounded by content shape, not by where
 *   `bobbitStateDir()` lives on disk. Archived sessions that recorded the
 *   legacy host-absolute path still parse — `parseSnapshot` only requires a
 *   non-empty string.
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
	| { kind: "preview"; url: string; path: string; entry?: string; contentHash?: string; artifactId?: string };

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
function normalizeContentHash(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const hash = value.trim().toLowerCase();
	return /^[a-f0-9]{64}$/.test(hash) ? hash : undefined;
}

function normalizeArtifactId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const artifactId = value.trim();
	return /^[A-Za-z0-9_-]{6,64}$/.test(artifactId) ? artifactId : undefined;
}

function normalizeEntry(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const entry = value.trim();
	if (!entry || entry.length > 255) return undefined;
	if (entry.includes("\0") || entry.includes("/") || entry.includes("\\")) return undefined;
	return entry;
}

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
				const contentHash = normalizeContentHash(parsed.contentHash);
				const artifactId = normalizeArtifactId(parsed.artifactId ?? parsed.artifact_id ?? parsed.aid);
				const entry = normalizeEntry(parsed.entry ?? parsed.e);
				const result: { kind: "preview"; url: string; path: string; entry?: string; contentHash?: string; artifactId?: string } = {
					kind: "preview",
					url: parsed.url,
					path: parsed.path,
				};
				if (entry) result.entry = entry;
				if (contentHash) result.contentHash = contentHash;
				if (artifactId) result.artifactId = artifactId;
				return result;
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
 *
 * @param url       Content-origin URL (always `/preview/<sid>/<entry>`).
 * @param entryPath The path identifier shown in the block. Callers should pass
 *                  the project-root-relative form (`<sid>/<entry>`) when
 *                  available. Artifact-backed blocks may compact `path` to the
 *                  entry filename if needed to keep `contentHash` under the
 *                  250 B cap.
 */
export function buildPreviewSnapshotV3Block(
	url: string,
	entryPath: string,
	contentHash?: string,
	options?: { artifactId?: string; entry?: string },
): string {
	const hash = normalizeContentHash(contentHash);
	const artifactId = normalizeArtifactId(options?.artifactId);
	const entry = normalizeEntry(options?.entry);
	const payloads: Array<Record<string, string>> = [];
	const addPayload = (payload: Record<string, string>) => {
		const key = JSON.stringify(payload);
		if (!payloads.some(p => JSON.stringify(p) === key)) payloads.push(payload);
	};
	const shortUrl = entry ? compactPreviewUrl(url, entry) : undefined;

	const basePayload: Record<string, string> = { kind: "preview", url, path: entryPath };
	if (entry) basePayload.entry = entry;
	if (artifactId) basePayload.artifactId = artifactId;
	if (hash) addPayload({ ...basePayload, contentHash: hash });

	if (entry && hash) {
		const compactFull: Record<string, string> = {
			kind: "preview",
			url: shortUrl || url,
			path: entry,
			entry,
			contentHash: hash,
		};
		if (artifactId) compactFull.artifactId = artifactId;
		addPayload(compactFull);
		if (artifactId) addPayload({ ...compactFull, artifactId: undefined as never, aid: artifactId });
	}

	addPayload(basePayload);
	if (entry) {
		const compactNoHash: Record<string, string> = { kind: "preview", url: shortUrl || url, path: entry, entry };
		if (artifactId) compactNoHash.artifactId = artifactId;
		addPayload(compactNoHash);
		if (artifactId) addPayload({ ...compactNoHash, artifactId: undefined as never, aid: artifactId });
	}
	addPayload({ kind: "preview", url, path: entryPath });

	for (const payload of payloads) {
		for (const [key, value] of Object.entries(payload)) {
			if (value === undefined) delete payload[key];
		}
		const block = PREVIEW_SNAPSHOT_MARKER_V3 + JSON.stringify(payload) + "\n";
		if (block.length <= 250) return block;
	}

	return PREVIEW_SNAPSHOT_MARKER_V3 + JSON.stringify({ kind: "preview", url, path: entryPath }) + "\n";
}

function compactPreviewUrl(url: string, entry: string): string | undefined {
	const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`^(/preview/[A-Fa-f0-9-]{36}/)${escaped}$`).exec(url);
	return match ? match[1] : undefined;
}
