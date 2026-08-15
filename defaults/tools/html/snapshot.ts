import { Buffer } from "node:buffer";
import { decodePreviewEntry, encodePreviewEntry, isValidPreviewEntry } from "./preview-entry-codec.js";

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
 *   v3 (current — per-session preview mount; entire block is at most 250 UTF-8
 *   bytes; valid `artifactId` and `contentHash` are never dropped to fit it):
 *     __preview_snapshot_v3__\n{"kind":"preview","url":"/preview/<sid>/","entry":"<entry>","contentHash":"<sha256>","artifactId":"<id>"}\n
 *
 *   `entry` is a standalone raw filename unless a bounded reversible compact
 *   envelope is needed. It is never a percent-encoded segment. The reader
 *   decodes that envelope and encodes the raw value exactly once while
 *   reconstructing compact routes, so literal percent sequences and non-ASCII
 *   filenames round-trip unchanged. Historical `path`, identity-key aliases,
 *   and entry-omitted markers remain read-compatible only.
 *
 *   If no lossless form fits, the builder throws `PREVIEW_SNAPSHOT_CAP` rather
 *   than writing a truncated marker or silently dropping replay identity.
 *   Archived sessions that recorded the legacy host-absolute path still parse
 *   — `parseSnapshot` only requires a non-empty string.
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
	| { kind: "preview"; url: string; path?: string; entry?: string; contentHash?: string; artifactId?: string };

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
	const entry = decodePreviewEntry(value);
	return isValidPreviewEntry(entry) ? entry : undefined;
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
				(parsed.path === undefined || (typeof parsed.path === "string" && parsed.path.length > 0))
			) {
				const contentHash = normalizeContentHash(parsed.contentHash);
				const artifactId = normalizeArtifactId(parsed.artifactId ?? parsed.artifact_id ?? parsed.aid ?? parsed.a);
				const entry = normalizeEntry(parsed.entry ?? parsed.e);
				const result: { kind: "preview"; url: string; path?: string; entry?: string; contentHash?: string; artifactId?: string } = {
					kind: "preview",
					url: parsed.url,
				};
				if (typeof parsed.path === "string") result.path = parsed.path;
				else if (entry) result.path = entry; // compatibility for callers that read parsed.path
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
 * Every returned block is at most 250 UTF-8 bytes. Valid caller-supplied
 * identity is never omitted to meet that cap: when no lossless form fits, this
 * throws `PREVIEW_SNAPSHOT_CAP` so `preview_open` can report the filename.
 *
 * @param url       Content-origin URL (always `/preview/<sid>/<entry>`).
 * @param entryPath The path identifier shown in the block. Callers should pass
 *                  the project-root-relative form (`<sid>/<entry>`) when
 *                  available.
 */
export function buildPreviewSnapshotV3Block(
	url: string,
	entryPath: string,
	contentHash?: string,
	options?: { artifactId?: string; entry?: string },
): string {
	if (options?.entry !== undefined && !isValidPreviewEntry(options.entry)) {
		throw new Error(`PREVIEW_SNAPSHOT_ENTRY: invalid preview filename ${JSON.stringify(options.entry)}`);
	}

	const hash = normalizeContentHash(contentHash);
	const artifactId = normalizeArtifactId(options?.artifactId);
	const entry = options?.entry;
	const shortUrl = entry ? compactPreviewUrl(url, entry) : undefined;
	const storedUrl = shortUrl && entry ? `${shortUrl}${encodeURIComponent(entry)}` : url;
	const blockFor = (payload: Record<string, string>): string | undefined => {
		const block = PREVIEW_SNAPSHOT_MARKER_V3 + JSON.stringify(payload) + "\n";
		return Buffer.byteLength(block, "utf8") <= 250 ? block : undefined;
	};
	const withMetadata = (base: Record<string, string>): Record<string, string> => ({
		...base,
		...(hash ? { contentHash: hash } : {}),
		...(artifactId ? { artifactId } : {}),
	});

	if (entry) {
		// New markers are standalone and canonical: compact directory URL, raw (or
		// losslessly encoded) entry, and never an identity-key alias or duplicate path.
		const markerUrl = shortUrl ?? storedUrl;
		const raw = blockFor(withMetadata({ kind: "preview", url: markerUrl, entry }));
		if (raw) return raw;
		if (shortUrl) {
			const compactEntry = encodePreviewEntry(entry);
			if (compactEntry !== entry) {
				const compressed = blockFor(withMetadata({ kind: "preview", url: shortUrl, entry: compactEntry }));
				if (compressed) return compressed;
			}
		}
		// The renderer may recover this entry only from the trusted params of the
		// same preview_open call. Keep both canonical replay identities; without
		// either, an omitted entry would create an unreopenable marker.
		if (shortUrl && hash && artifactId) {
			const omitted = blockFor({ kind: "preview", url: shortUrl, contentHash: hash, artifactId });
			if (omitted) return omitted;
		}
		throw new Error(
			`PREVIEW_SNAPSHOT_CAP: cannot preserve preview identity for ${JSON.stringify(entry)} within the 250 UTF-8 byte snapshot cap`,
		);
	}

	// Older callers may not have supplied an entry. Preserve their historical
	// full-route/path marker shape, but never use it for new preview_open calls.
	const legacy = blockFor(withMetadata({ kind: "preview", url: storedUrl, path: entryPath }));
	if (legacy) return legacy;
	throw new Error(
		`PREVIEW_SNAPSHOT_CAP: cannot preserve preview identity for ${JSON.stringify(entryPath)} within the 250 UTF-8 byte snapshot cap`,
	);
}

/**
 * `entry` is the raw filename supplied by the preview mount, not a URI-encoded
 * route segment. The mount URL may contain either form, so compare equivalent
 * raw and encoded segments rather than matching a raw filename against an
 * encoded URL. Marker construction always stores the raw entry separately and
 * encodes it exactly once when it writes a full route.
 */
function compactPreviewUrl(url: string, entry: string): string | undefined {
	const match = /^(\/preview\/[A-Fa-f0-9-]{36}\/)(.*)$/.exec(url);
	if (!match) return undefined;
	const [, directoryUrl, storedEntry] = match;
	return storedEntry === entry || storedEntry === encodeURIComponent(entry) ? directoryUrl : undefined;
}
