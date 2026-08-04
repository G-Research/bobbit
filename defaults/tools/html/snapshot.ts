import { Buffer } from "node:buffer";

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
 *   v3 (current — per-session preview mount; constant ≤250 UTF-8 byte payload;
 *   valid `artifactId` and `contentHash` are never dropped to fit the cap):
 *     __preview_snapshot_v3__\n{"kind":"preview","url":"/preview/<sid>/<entry>","path":"<sid>/<entry>","entry":"<entry>","contentHash":"<sha256>","artifactId":"<id>"}\n
 *
 *   The `path` field normally carries the project-root-relative identifier
 *   (`<sessionId>/<entry>`, forward slashes on every OS) rather than the
 *   host-absolute path. To retain hash and artifact identity within the cap,
 *   the builder may encode `url` as `/preview/<sid>/` and `path` as the entry
 *   filename. That compact directory URL is valid only with the explicit, safe
 *   `entry`: the reader reconstructs the full route and applies its existing
 *   strict preview-route validation. Thus old compact markers reopen without
 *   accepting a directory URL without an entry.
 *
 *   The builder can additionally use the `aid` or `a` artifact-id aliases,
 *   omit redundant `path`, and (when both replay identities are present) omit
 *   `entry` for the tool-call fallback. If no lossless form fits, it fails
 *   explicitly rather than writing a dead marker. Block size is therefore
 *   bounded by content shape, not by where `bobbitStateDir()` lives on disk. Archived sessions
 *   that recorded the legacy host-absolute path still parse — `parseSnapshot`
 *   only requires a non-empty string.
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
	if (typeof value !== "string") return undefined;
	const entry = value;
	if (!entry || entry.length > 255 || entry === "." || entry === "..") return undefined;
	if (/[\\/\u0000-\u001f\u007f]/u.test(entry)) return undefined;
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
	const hash = normalizeContentHash(contentHash);
	const artifactId = normalizeArtifactId(options?.artifactId);
	const entry = normalizeEntry(options?.entry);
	const shortUrl = entry ? compactPreviewUrl(url, entry) : undefined;
	// Mount responses contain the raw filename in `url`, while marker `entry`
	// deliberately remains raw. Encode that filename exactly once for every full
	// route stored in the marker so literal percent sequences cannot be decoded
	// into a different file when the route is later served.
	const storedUrl = shortUrl && entry ? `${shortUrl}${encodeURIComponent(entry)}` : url;
	const payloads: Array<Record<string, string>> = [];
	const addPayload = (payload: Record<string, string>) => {
		const key = JSON.stringify(payload);
		if (!payloads.some(candidate => JSON.stringify(candidate) === key)) payloads.push(payload);
	};

	const withMetadata = (base: Record<string, string>) => hash ? { ...base, contentHash: hash } : base;
	const addArtifact = (base: Record<string, string>, key: "artifactId" | "aid" | "a") => {
		if (artifactId) addPayload({ ...base, [key]: artifactId });
	};
	const addArtifactAliases = (base: Record<string, string>) => {
		if (!artifactId) {
			addPayload(base);
			return;
		}
		addArtifact(base, "artifactId");
		addArtifact(base, "aid");
		addArtifact(base, "a");
	};
	const fullRoute = withMetadata({
		kind: "preview",
		url: storedUrl,
		path: entryPath,
		...(entry ? { entry } : {}),
	});

	// The original full route with the canonical artifactId key remains first for
	// backwards-compatible payload selection. When it does not fit, a compact
	// route is more valuable than a shorter full-route artifact-key alias: the
	// compact route protects preview reopen and preserves the raw entry.
	if (artifactId) addArtifact(fullRoute, "artifactId");
	else addPayload(fullRoute);

	if (shortUrl && entry) {
		// The compact URL and raw entry are an intentional writer/reader pair: the
		// reader encodes the raw entry exactly once when reconstructing the route.
		const compactRoute = withMetadata({ kind: "preview", url: shortUrl, path: entry, entry });
		addArtifactAliases(compactRoute);

		// Try the full route's shorter artifact-key aliases only after every compact
		// shape that carries an explicit entry. This ordering avoids selecting a
		// barely-fitting full route over a robust compact snapshot.
		if (artifactId) {
			addArtifact(fullRoute, "aid");
			addArtifact(fullRoute, "a");
		}

		// `path` duplicates `entry` in a compact marker, so remove it before
		// removing entry. This is essential for non-ASCII names under the byte cap.
		addArtifactAliases(withMetadata({ kind: "preview", url: shortUrl, entry }));
		// The final lossless compact form relies on preview_open's trusted entry
		// parameter. It is safe only when both identities survive for artifact
		// replay; otherwise a missing entry would create an unrecoverable preview.
		if (hash && artifactId) addArtifactAliases(withMetadata({ kind: "preview", url: shortUrl }));
	} else if (artifactId) {
		// No safe compact route exists, so the full route aliases are the only
		// lossless alternatives to an explicit cap failure.
		addArtifact(fullRoute, "aid");
		addArtifact(fullRoute, "a");
	}

	for (const payload of payloads) {
		const block = PREVIEW_SNAPSHOT_MARKER_V3 + JSON.stringify(payload) + "\n";
		if (Buffer.byteLength(block, "utf8") <= 250) return block;
	}

	const subject = entry ?? entryPath;
	throw new Error(
		`PREVIEW_SNAPSHOT_CAP: cannot preserve preview identity for ${JSON.stringify(subject)} within the 250 UTF-8 byte snapshot cap`,
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
