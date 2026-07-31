/**
 * Content-origin route for the embedded HTML preview rewrite.
 *
 * Mounts the per-session preview directory at `/preview/<sessionId>/<rel-path>`.
 *
 * - `text/html` responses get a marked, mount-aware `<base>` injected and
 *   the theme/swipe bridge scripts appended.
 * - Script-capable HTML/SVG documents receive an opaque-origin response sandbox.
 * - Path-traversal defence delegates to `path-guard.ts::resolveAssetPath`.
 * - Initial navigation uses ambient browser auth; opaque-frame subresources use
 *   a short-lived, exact-generation asset capability because SameSite cookies
 *   are intentionally unavailable there.
 * - Localhost mode retains its existing auth short-circuit.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type http from "node:http";

import {
	acquirePreviewDirectoryRead,
	ensurePreviewDirectoryGeneration,
	invalidatePreviewDirectoryGeneration,
	isPreviewDirectoryAvailable,
	mountPath,
	previewDirectoryFileMatches,
	previewDirectoryGenerationMatches,
	readMountDirectory,
} from "./mount.js";
import { artifactMountDir } from "./artifacts.js";
import { resolveAssetPath } from "./path-guard.js";
import { mimeTypeFor } from "./mime.js";
import { tryAuth as cookieTryAuth, type CookieStore } from "../auth/cookie.js";
import { canonicalHttpOrigin, canonicalRequestOrigin } from "../auth/browser-cookie.js";
import {
	injectBaseAndScripts,
	PREVIEW_BRIDGE_SCRIPTS,
	previewNavigationBridge,
} from "../../shared/preview-bridge-scripts.js";
import { gatewayRoute, normalizeBasePath, withBasePath } from "../../shared/base-path.js";
import { getPreviewThemeSnapshot } from "./theme-snapshot.js";

const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const VALID_ARTIFACT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTENT_CAPABILITY_SEGMENT = "_content";
const CONTENT_CAPABILITY_BYTES = 32;
const VALID_CONTENT_CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

/** Asset capabilities deliberately outlive only an ordinary page load, not a session. */
export const PREVIEW_ASSET_CAPABILITY_TTL_MS = 5 * 60 * 1_000;
export const PREVIEW_REFERRER_POLICY = "no-referrer";

type PreviewContentCapability = Readonly<{ token: string; path: string; scope: string }>;
type PreviewAssetCapability = Readonly<{
	token: string;
	scope: string;
	baseDir: string;
	generation: string;
	expiresAt: number;
}>;

type PreviewAssetCapabilityState = {
	byToken: Map<string, PreviewAssetCapability>;
	activeByScope: Map<string, PreviewAssetCapability>;
};

// The capability is gateway-memory authority, intentionally separate from the
// 30-day browser CookieStore wire format. A restart revokes every outstanding
// asset URL. Weak keys also keep short-lived test/gateway stores collectible.
const previewAssetCapabilities = new WeakMap<CookieStore, PreviewAssetCapabilityState>();

function contentCapabilityScope(basePath: string, internalBaseRoute: string): string {
	return normalizeBasePath(`${basePath}${internalBaseRoute}`);
}

function contentCapabilityFromRoute(
	rel: string,
	basePath: string,
	internalBaseRoute: string,
): PreviewContentCapability | null {
	if (!rel.startsWith(`${CONTENT_CAPABILITY_SEGMENT}/`)) return null;
	const remainder = rel.slice(CONTENT_CAPABILITY_SEGMENT.length + 1);
	const slash = remainder.indexOf("/");
	const token = slash < 0 ? remainder : remainder.slice(0, slash);
	if (!VALID_CONTENT_CAPABILITY.test(token)) return null;
	return {
		token,
		path: slash < 0 ? "" : remainder.slice(slash + 1),
		scope: contentCapabilityScope(basePath, internalBaseRoute),
	};
}

function contentCapabilityCandidate(rel: string, sid: string, basePath: string): PreviewContentCapability | null {
	let internalBaseRoute = `/preview/${sid}/`;
	let candidateRel = rel;
	if (rel.startsWith("_artifact/")) {
		const afterPrefix = rel.slice("_artifact/".length);
		const slash = afterPrefix.indexOf("/");
		const artifactId = slash < 0 ? afterPrefix : afterPrefix.slice(0, slash);
		if (!VALID_ARTIFACT_ID.test(artifactId)) return null;
		internalBaseRoute = `/preview/${sid}/_artifact/${artifactId}/`;
		candidateRel = slash < 0 ? "" : afterPrefix.slice(slash + 1);
	}
	return contentCapabilityFromRoute(candidateRel, basePath, internalBaseRoute);
}

function capabilityNow(opts: ContentRouteOptions): number {
	const now = opts.assetCapabilityClock?.now() ?? Date.now();
	if (!Number.isFinite(now) || now < 0) throw new Error("Preview asset capability clock returned an invalid time");
	return Math.floor(now);
}

function capabilityState(store: CookieStore): PreviewAssetCapabilityState {
	let state = previewAssetCapabilities.get(store);
	if (!state) {
		state = { byToken: new Map(), activeByScope: new Map() };
		previewAssetCapabilities.set(store, state);
	}
	return state;
}

function revokePreviewAssetCapability(store: CookieStore, capability: PreviewAssetCapability): void {
	const state = capabilityState(store);
	if (state.byToken.get(capability.token) === capability) state.byToken.delete(capability.token);
	if (state.activeByScope.get(capability.scope) === capability) state.activeByScope.delete(capability.scope);
}

function sweepExpiredPreviewAssetCapabilities(store: CookieStore, now: number): void {
	const state = capabilityState(store);
	for (const capability of state.byToken.values()) {
		if (now >= capability.expiresAt) revokePreviewAssetCapability(store, capability);
	}
}

function lookupPreviewAssetCapability(
	candidate: PreviewContentCapability,
	opts: ContentRouteOptions,
): PreviewAssetCapability | null {
	const now = capabilityNow(opts);
	sweepExpiredPreviewAssetCapabilities(opts.cookieStore, now);
	const capability = capabilityState(opts.cookieStore).byToken.get(candidate.token);
	if (!capability || capability.scope !== candidate.scope || now >= capability.expiresAt) return null;
	return capability;
}

function issuePreviewAssetCapability(
	scope: string,
	baseDir: string,
	generation: string,
	opts: ContentRouteOptions,
): PreviewAssetCapability {
	const now = capabilityNow(opts);
	sweepExpiredPreviewAssetCapabilities(opts.cookieStore, now);
	const state = capabilityState(opts.cookieStore);
	const active = state.activeByScope.get(scope);
	// Reuse one token for concurrent iframe/popout views of the same immutable
	// generation. Rotate before it is too close to expiry, and immediately when
	// the live tree's exact content generation changes.
	if (
		active
		&& active.baseDir === baseDir
		&& active.generation === generation
		&& active.expiresAt - now > PREVIEW_ASSET_CAPABILITY_TTL_MS / 4
	) {
		return active;
	}
	if (active) revokePreviewAssetCapability(opts.cookieStore, active);
	let token: string;
	do {
		token = randomBytes(CONTENT_CAPABILITY_BYTES).toString("base64url");
	} while (state.byToken.has(token));
	const capability: PreviewAssetCapability = {
		token,
		scope,
		baseDir,
		generation,
		expiresAt: now + PREVIEW_ASSET_CAPABILITY_TTL_MS,
	};
	state.byToken.set(capability.token, capability);
	state.activeByScope.set(scope, capability);
	return capability;
}

function requestIsNavigation(req: http.IncomingMessage): boolean {
	const header = (name: "sec-fetch-mode" | "sec-fetch-dest"): string => {
		const raw = req.headers[name];
		return (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase() ?? "";
	};
	if (header("sec-fetch-mode") === "navigate") return true;
	return ["document", "frame", "iframe", "embed", "object"].includes(header("sec-fetch-dest"));
}

function pathRelativeToPreviewRoot(baseDir: string, resolved: string): string {
	return path.relative(path.resolve(baseDir), path.resolve(resolved)).split(path.sep).join("/");
}

function openPreviewFileNoFollow(resolved: string): Readonly<{ fd: number; stats: fs.Stats }> | null {
	let fd: number | undefined;
	try {
		const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
		fd = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
		const stats = fs.fstatSync(fd);
		if (!stats.isFile()) throw new Error("Preview asset descriptor is not a regular file");
		return { fd, stats };
	} catch {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* preserve the open/stat failure */ }
		}
		return null;
	}
}

function closePreviewFile(fd: number): void {
	try { fs.closeSync(fd); } catch { /* descriptor may already be closed by its stream */ }
}

interface PreviewRequestLifecycle {
	readonly aborted: boolean;
	ownDescriptor(fd: number): boolean;
	closeDescriptor(): void;
	pipeOwnedStream(stream: fs.ReadStream): Promise<void>;
	dispose(): Promise<void>;
}

/**
 * Own the serving lease and opened asset from the first abortable await through
 * descriptor close. IncomingMessage `close` also fires for an ordinary complete
 * GET, so only its aborted/incomplete form is destructive.
 */
function createPreviewRequestLifecycle(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	releaseRead: () => void,
): PreviewRequestLifecycle {
	let aborted = req.aborted === true || res.destroyed === true;
	let released = false;
	let ownedFd: number | undefined;
	let ownedStream: fs.ReadStream | undefined;
	let streamClosed = false;
	let streamClosePromise: Promise<void> | undefined;

	const release = () => {
		if (released) return;
		released = true;
		releaseRead();
	};
	const closeDescriptor = () => {
		if (ownedFd === undefined) return;
		const fd = ownedFd;
		ownedFd = undefined;
		closePreviewFile(fd);
	};
	const abort = () => {
		aborted = true;
		if (ownedStream) {
			if (!ownedStream.destroyed) ownedStream.destroy();
			return;
		}
		closeDescriptor();
		release();
	};
	const onRequestClose = () => {
		if (req.aborted || !req.complete) abort();
	};
	const onResponseClose = () => {
		// A normal response close after `end()` must not truncate a completed read.
		if (!res.writableEnded && !res.writableFinished) abort();
	};
	const removeListener = (emitter: unknown, event: string, listener: () => void) => {
		(emitter as { removeListener?: (name: string, fn: () => void) => void }).removeListener?.(event, listener);
	};
	const removeTransportListeners = () => {
		removeListener(req, "aborted", abort);
		removeListener(req, "close", onRequestClose);
		removeListener(res, "close", onResponseClose);
	};

	if (typeof req.once === "function") {
		req.once("aborted", abort);
		req.once("close", onRequestClose);
	}
	if (typeof res.once === "function") res.once("close", onResponseClose);
	if (aborted) abort();

	return {
		get aborted() { return aborted; },
		ownDescriptor(fd) {
			if (ownedFd !== undefined || ownedStream) {
				throw new Error("Preview request already owns an asset descriptor");
			}
			ownedFd = fd;
			if (!aborted) return true;
			closeDescriptor();
			release();
			return false;
		},
		closeDescriptor,
		async pipeOwnedStream(stream) {
			if (ownedFd === undefined) throw new Error("Preview stream requires an owned descriptor");
			if (ownedStream) throw new Error("Preview request already owns a response stream");
			ownedStream = stream;
			streamClosePromise = new Promise<void>(resolve => {
				const onClose = () => {
					if (streamClosed) return;
					streamClosed = true;
					stream.removeListener("error", onError);
					stream.unpipe(res);
					// `close` follows ReadStream's auto-close. Closing defensively also
					// protects descriptor ownership if an injected stream violated it.
					closeDescriptor();
					release();
					resolve();
				};
				const onError = () => {
					try {
						if (!res.destroyed && !res.writableEnded) res.end();
					} catch { /* ignore a concurrently closed response */ }
					if (!stream.destroyed) stream.destroy();
				};
				stream.once("close", onClose);
				stream.once("error", onError);
			});

			if (aborted) {
				if (!stream.destroyed) stream.destroy();
			} else {
				try {
					stream.pipe(res);
				} catch {
					try {
						if (!res.destroyed && !res.writableEnded) res.end();
					} catch { /* ignore a concurrently closed response */ }
					if (!stream.destroyed) stream.destroy();
				}
			}
			await streamClosePromise;
		},
		async dispose() {
			removeTransportListeners();
			if (ownedStream && !streamClosed) {
				if (!ownedStream.destroyed) ownedStream.destroy();
				await streamClosePromise;
			}
			closeDescriptor();
			release();
		},
	};
}

function readVerifiedPreviewText(
	resolved: string,
	baseDir: string,
	generation: string,
	relativePath: string,
): string | null {
	const opened = openPreviewFileNoFollow(resolved);
	if (!opened) return null;
	try {
		if (!previewDirectoryFileMatches(baseDir, generation, relativePath, opened.stats)) return null;
		const body = fs.readFileSync(opened.fd, "utf-8");
		const after = fs.fstatSync(opened.fd);
		return previewDirectoryFileMatches(baseDir, generation, relativePath, after) ? body : null;
	} catch {
		return null;
	} finally {
		closePreviewFile(opened.fd);
	}
}

function injectSvgBase(svg: string, baseHref: string): string {
	const root = /<svg\b[^>]*>/i.exec(svg);
	if (!root) return svg;
	const existingBase = /\s+xml:base\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i;
	const nextRoot = existingBase.test(root[0])
		? root[0].replace(existingBase, ` xml:base="${baseHref}"`)
		: root[0].replace(/^<svg\b/i, match => `${match} xml:base="${baseHref}"`);
	return `${svg.slice(0, root.index)}${nextRoot}${svg.slice(root.index + root[0].length)}`;
}

/**
 * Preview HTML and SVG are agent-authored and may be served below Bobbit or
 * another application on the same web origin. The response sandbox is the
 * security boundary for embedded frames and top-level preview popouts alike.
 */
export const PREVIEW_HTML_CONTENT_SECURITY_POLICY = "sandbox allow-scripts";

/**
 * An iframe without `allow-same-origin` cannot inspect its parent to mirror
 * live theme changes. Request the non-sensitive theme snapshot over a narrow
 * postMessage channel instead; render.ts verifies the requesting Window is a
 * currently mounted preview iframe before replying.
 */
const PREVIEW_OPAQUE_THEME_BRIDGE = `<script>
(function() {
	if (parent === window) return;
	var MESSAGE_TYPE = 'bobbit-preview-theme';
	window.addEventListener('message', function(event) {
		if (event.source !== parent || !event.data || event.data.type !== MESSAGE_TYPE) return;
		var theme = event.data.theme;
		if (!theme || typeof theme !== 'object') return;
		var root = document.documentElement;
		root.classList.toggle('dark', theme.dark === true);
		if (typeof theme.palette === 'string' && theme.palette) root.setAttribute('data-palette', theme.palette);
		else root.removeAttribute('data-palette');
		var properties = theme.customProperties;
		if (properties && typeof properties === 'object') {
			Object.keys(properties).forEach(function(name) {
				var value = properties[name];
				if (/^--[A-Za-z0-9_-]+$/.test(name) && typeof value === 'string') root.style.setProperty(name, value);
			});
		}
		if (typeof theme.fontFamily === 'string') root.style.fontFamily = theme.fontFamily;
	});
	function requestTheme() {
		parent.postMessage({ type: 'bobbit-preview-theme-request' }, '*');
	}
	requestTheme();
	window.addEventListener('load', requestTheme, { once: true });
})();
<\/script>`;

export interface ContentRouteOptions {
	cookieStore: CookieStore;
	isLocalhost: boolean;
	/** Optional admin token check for fallback bearer-auth (used by SSE callers and tests). */
	adminBearerToken?: string;
	/** Canonical deployment mount. `pathname` itself has already been stripped. */
	basePath?: string;
	/** Injectable wall clock for focused capability-expiry tests. */
	assetCapabilityClock?: Readonly<{ now(): number }>;
}

function send(res: http.ServerResponse, status: number, body: string, contentType = "application/json") {
	res.writeHead(status, {
		"Content-Type": contentType,
		"Cache-Control": "no-store",
		"Referrer-Policy": PREVIEW_REFERRER_POLICY,
	});
	res.end(body);
}

function isAuthorized(
	req: http.IncomingMessage,
	opts: ContentRouteOptions,
	contentCapability?: PreviewContentCapability | null,
): boolean {
	if (
		contentCapability
		&& !requestIsNavigation(req)
		&& lookupPreviewAssetCapability(contentCapability, opts)
	) {
		return true;
	}
	if (opts.isLocalhost) return true;
	const basePath = normalizeBasePath(opts.basePath);
	const isTls = Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted);
	const requestOrigin = canonicalRequestOrigin({ headers: req.headers, isTls });
	if (!requestOrigin) return false;
	const rawOrigin = req.headers.origin;
	const browserOrigin = canonicalHttpOrigin(rawOrigin);
	if (rawOrigin !== undefined && !browserOrigin) return false;
	// Originless GET/HEAD navigations are unreadable cross-origin and remain
	// usable for iframe/popout loads. Same-origin preview subresources may use the
	// gateway origin; an explicit external UI Origin must match the signed claim.
	const binding = browserOrigin && browserOrigin !== requestOrigin
		? { basePath, origin: browserOrigin }
		: { basePath };
	if (cookieTryAuth(req, opts.cookieStore, binding)) return true;
	// Optional admin bearer (?token= or Authorization: Bearer) — useful for
	// curl-driven testing; iframe loads always come via cookie.
	if (opts.adminBearerToken) {
		const authHeader = req.headers.authorization;
		const tokenHdr = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
		if (tokenHdr && tokenHdr === opts.adminBearerToken) return true;
		try {
			const url = new URL(req.url || "/", `http://${req.headers.host || "x"}`);
			const tokenQ = url.searchParams.get("token");
			if (tokenQ && tokenQ === opts.adminBearerToken) return true;
		} catch { /* ignore */ }
	}
	return false;
}

/**
 * Pick the entry file when the user requests `/preview/<sid>/`.
 * Order: `index.html` → `inline.html` → first `.html` alphabetically.
 */
export async function pickEntry(dir: string): Promise<string | null> {
	let entries: fs.Dirent[];
	try {
		entries = await readMountDirectory(dir);
	} catch {
		return null;
	}
	const files = entries.filter(e => e.isFile()).map(e => e.name);
	if (files.includes("index.html")) return "index.html";
	if (files.includes("inline.html")) return "inline.html";
	const html = files.filter(n => n.toLowerCase().endsWith(".html")).sort((a, b) => a.localeCompare(b));
	return html[0] ?? null;
}

/**
 * Handle a `/preview/...` request. Returns true if the request was handled
 * (response sent). Returns false only for non-matching paths — callers should
 * fall through to the next route.
 */
export async function handlePreviewRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	pathname: string,
	opts: ContentRouteOptions,
): Promise<boolean> {
	if (!pathname.startsWith("/preview/")) return false;

	// Method gate: only GET (HEAD acceptable as GET).
	const method = (req.method || "GET").toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		send(res, 405, JSON.stringify({ error: "Method not allowed" }));
		return true;
	}

	// Parse enough route shape to authenticate an opaque-frame content
	// capability, but retain the historical auth-before-disclosure response
	// ordering for malformed session/artifact paths.
	const remainder = pathname.slice("/preview/".length);
	const slashIdx = remainder.indexOf("/");
	const sid = slashIdx < 0 ? remainder : remainder.slice(0, slashIdx);
	let rel = slashIdx < 0 ? "" : remainder.slice(slashIdx + 1);
	const basePath = normalizeBasePath(opts.basePath);
	const capability = VALID_SESSION_ID.test(sid)
		? contentCapabilityCandidate(rel, sid, basePath)
		: null;

	// Auth (must come before any route/filesystem disclosure).
	if (!isAuthorized(req, opts, capability)) {
		send(res, 401, JSON.stringify({ error: "Unauthorized" }));
		return true;
	}

	if (!sid || !VALID_SESSION_ID.test(sid)) {
		send(res, 400, JSON.stringify({ error: "Invalid sessionId" }));
		return true;
	}

	// `/preview/<sid>/_artifact/<artifactId>/<rel>` — serve directly from the
	// stable per-artifact directory instead of the session's live mount slot.
	// This lets the client switch between preview tabs (each backed by its own
	// artifact) by just changing the iframe src — no POST/restore round-trip
	// needed, since each artifact's bytes live at their own URL forever.
	let baseDir = mountPath(sid);
	let internalBaseRoute = gatewayRoute(`/preview/${sid}/`);
	if (rel.startsWith("_artifact/")) {
		const afterPrefix = rel.slice("_artifact/".length);
		const nextSlash = afterPrefix.indexOf("/");
		const artifactId = nextSlash < 0 ? afterPrefix : afterPrefix.slice(0, nextSlash);
		const artRel = nextSlash < 0 ? "" : afterPrefix.slice(nextSlash + 1);
		if (!VALID_ARTIFACT_ID.test(artifactId)) {
			send(res, 400, JSON.stringify({ error: "Invalid artifactId" }));
			return true;
		}
		try {
			baseDir = artifactMountDir(sid, artifactId);
		} catch {
			send(res, 400, JSON.stringify({ error: "Invalid artifactId" }));
			return true;
		}
		if (!fs.existsSync(baseDir)) {
			send(res, 404, JSON.stringify({ error: "Preview artifact not found" }));
			return true;
		}
		internalBaseRoute = gatewayRoute(`/preview/${sid}/_artifact/${artifactId}/`);
		rel = artRel;
	}

	// Opaque sandbox frames do not receive SameSite=Lax cookies on subresource
	// requests. A short-lived path capability restores only assets from the
	// exact session/artifact content generation that minted it.
	let routedCapability: PreviewAssetCapability | null = null;
	if (rel.startsWith(`${CONTENT_CAPABILITY_SEGMENT}/`)) {
		const candidate = contentCapabilityFromRoute(rel, basePath, internalBaseRoute);
		routedCapability = candidate && candidate.path !== "" && !requestIsNavigation(req)
			? lookupPreviewAssetCapability(candidate, opts)
			: null;
		if (!candidate || !routedCapability || routedCapability.baseDir !== baseDir) {
			send(res, 401, JSON.stringify({ error: "Unauthorized" }));
			return true;
		}
		rel = candidate.path;
	}

	// Whole-root installs fence the exact destination through post-rename
	// identity verification. Fail closed while that fence is active.
	if (!isPreviewDirectoryAvailable(baseDir)) {
		send(res, 404, JSON.stringify({ error: "Preview mount is not available" }));
		return true;
	}

	// `/preview/<sid>` → 301 redirect to add trailing slash so relative URLs resolve.
	if (slashIdx < 0) {
		res.writeHead(301, {
			Location: withBasePath(gatewayRoute(`/preview/${sid}/`), basePath),
			"Cache-Control": "no-store",
			"Referrer-Policy": PREVIEW_REFERRER_POLICY,
		});
		res.end();
		return true;
	}

	const releaseRead = acquirePreviewDirectoryRead(baseDir);
	if (!releaseRead) {
		send(res, 404, JSON.stringify({ error: "Preview mount is not available" }));
		return true;
	}
	const requestLifecycle = createPreviewRequestLifecycle(req, res, releaseRead);
	try {
		if (requestLifecycle.aborted) return true;
		let capabilityAuthorized = false;
		if (routedCapability) {
			const stillActive = capabilityState(opts.cookieStore).byToken.get(routedCapability.token) === routedCapability;
			const expired = capabilityNow(opts) >= routedCapability.expiresAt;
			const generationMatches = await previewDirectoryGenerationMatches(baseDir, routedCapability.generation);
			if (requestLifecycle.aborted) return true;
			if (!stillActive || expired || !generationMatches) {
				revokePreviewAssetCapability(opts.cookieStore, routedCapability);
				send(res, 401, JSON.stringify({ error: "Unauthorized" }));
				return true;
			}
			capabilityAuthorized = true;
		}

		// `/preview/<sid>/` → pick entry and 302.
	if (rel === "") {
		if (!fs.existsSync(baseDir)) {
			send(res, 404, JSON.stringify({ error: "Preview mount not found" }));
			return true;
		}
		const entry = await pickEntry(baseDir);
		if (requestLifecycle.aborted) return true;
		if (!isPreviewDirectoryAvailable(baseDir)) {
			send(res, 404, JSON.stringify({ error: "Preview mount is not available" }));
			return true;
		}
		if (!entry) {
			send(res, 404, JSON.stringify({ error: "Preview mount is empty" }));
			return true;
		}
		res.writeHead(302, {
			Location: withBasePath(gatewayRoute(`${internalBaseRoute}${encodeURIComponent(entry)}`), basePath),
			"Cache-Control": "no-store",
			"Referrer-Policy": PREVIEW_REFERRER_POLICY,
		});
		res.end();
		return true;
	}

	// Decode the relative path; the path-guard rejects backslashes, NULs,
	// absolute paths and anything that escapes baseDir.
	let decoded: string;
	try {
		decoded = decodeURIComponent(rel);
	} catch {
		send(res, 400, JSON.stringify({ error: "Invalid path" }));
		return true;
	}

	const guard = resolveAssetPath(baseDir, decoded);
	if (!guard.ok) {
		const status = guard.status === 400 ? 403 : guard.status; // traversal → 403
		send(res, status, JSON.stringify({ error: guard.error }));
		return true;
	}

	const relativeAssetPath = pathRelativeToPreviewRoot(baseDir, guard.resolved);
	const contentType = mimeTypeFor(guard.resolved);
	const isHtml = contentType.startsWith("text/html");
	const isSvg = contentType.startsWith("image/svg+xml");

	// A capability is subresource authority only. It must never create a new
	// opaque document (or recursively mint more authority) even when Fetch
	// Metadata is missing from a non-browser client.
	if (capabilityAuthorized && isHtml) {
		send(res, 403, JSON.stringify({ error: "Preview asset capability cannot authorize HTML" }));
		return true;
	}

	if (isHtml) {
		// Validate the complete published tree, then bind this exact file to a
		// no-follow descriptor before reading any bytes into the response.
		let generation: string;
		try {
			generation = await ensurePreviewDirectoryGeneration(baseDir);
		} catch {
			if (!requestLifecycle.aborted) send(res, 404, JSON.stringify({ error: "Preview mount is not available" }));
			return true;
		}
		if (requestLifecycle.aborted) return true;
		const body = readVerifiedPreviewText(guard.resolved, baseDir, generation, relativeAssetPath);
		if (body === null) {
			invalidatePreviewDirectoryGeneration(baseDir);
			send(res, 404, JSON.stringify({ error: "Preview mount changed before it could be read" }));
			return true;
		}
		// `<base>` + inline theme-token snapshot. Both land inside <head> via
		// injectBaseAndScripts; the snapshot defines `:root`/`.dark` defaults so
		// standalone-tab opens still resolve `var(--background)` etc. Opaque
		// embedded frames receive live theme updates over the constrained
		// postMessage bridge instead of reading parent.document.
		const issuedCapability = issuePreviewAssetCapability(
			contentCapabilityScope(basePath, internalBaseRoute),
			baseDir,
			generation,
			opts,
		);
		const capabilityBaseRoute = gatewayRoute(
			`${internalBaseRoute}${CONTENT_CAPABILITY_SEGMENT}/${issuedCapability.token}/`,
		);
		const publicBaseHref = withBasePath(capabilityBaseRoute, basePath);
		const baseTag = `<base data-bobbit-preview-base href="${publicBaseHref}">` + getPreviewThemeSnapshot();
		const rewritten = injectBaseAndScripts(
			body,
			baseTag,
			PREVIEW_BRIDGE_SCRIPTS
				+ previewNavigationBridge()
				+ PREVIEW_OPAQUE_THEME_BRIDGE,
		);
		res.writeHead(200, {
			"Content-Type": contentType,
			"Cache-Control": "no-store",
			"Content-Security-Policy": PREVIEW_HTML_CONTENT_SECURITY_POLICY,
			"Referrer-Policy": PREVIEW_REFERRER_POLICY,
			"X-Content-Type-Options": "nosniff",
			// The scoped path capability is the authority. Reflect only the opaque
			// sandbox origin so modules/fetch can read their own mounted assets;
			// normal cookie-authenticated preview/API routes are not widened.
			...(capabilityAuthorized ? { "Access-Control-Allow-Origin": "null" } : {}),
		});
		if (method === "HEAD") {
			res.end();
		} else {
			res.end(rewritten);
		}
		return true;
	}

	if (isSvg) {
		// SVG is a script-capable document in a popout. Apply the same opaque
		// response sandbox as HTML. When ambient auth loaded the document, inject
		// XML Base so its relative images/styles use generation-bound authority.
		let generation = routedCapability?.generation;
		if (!generation) {
			try {
				generation = await ensurePreviewDirectoryGeneration(baseDir);
			} catch {
				if (!requestLifecycle.aborted) send(res, 404, JSON.stringify({ error: "Preview mount is not available" }));
				return true;
			}
		}
		if (requestLifecycle.aborted) return true;
		let body = readVerifiedPreviewText(guard.resolved, baseDir, generation, relativeAssetPath);
		if (body === null) {
			invalidatePreviewDirectoryGeneration(baseDir);
			if (routedCapability) revokePreviewAssetCapability(opts.cookieStore, routedCapability);
			send(res, capabilityAuthorized ? 401 : 404, JSON.stringify({ error: capabilityAuthorized ? "Unauthorized" : "Preview mount changed before it could be read" }));
			return true;
		}
		if (!capabilityAuthorized) {
			const issuedCapability = issuePreviewAssetCapability(
				contentCapabilityScope(basePath, internalBaseRoute),
				baseDir,
				generation,
				opts,
			);
			const capabilityBaseRoute = gatewayRoute(
				`${internalBaseRoute}${CONTENT_CAPABILITY_SEGMENT}/${issuedCapability.token}/`,
			);
			body = injectSvgBase(body, withBasePath(capabilityBaseRoute, basePath));
		}
		res.writeHead(200, {
			"Content-Type": contentType,
			"Cache-Control": "no-store",
			"Content-Security-Policy": PREVIEW_HTML_CONTENT_SECURITY_POLICY,
			"Referrer-Policy": PREVIEW_REFERRER_POLICY,
			"X-Content-Type-Options": "nosniff",
			...(capabilityAuthorized ? { "Access-Control-Allow-Origin": "null" } : {}),
		});
		if (method === "HEAD") res.end();
		else res.end(body);
		return true;
	}

	// Validate the published tree, then bind the pathname to one no-follow
	// descriptor before headers. Ambient-auth and capability reads share the
	// same file identity proof; only their failure status differs.
	let generation = routedCapability?.generation;
	if (!generation) {
		try {
			generation = await ensurePreviewDirectoryGeneration(baseDir);
		} catch {
			if (!requestLifecycle.aborted) send(res, 404, JSON.stringify({ error: "Preview mount is not available" }));
			return true;
		}
	}
	if (requestLifecycle.aborted) return true;
	const opened = openPreviewFileNoFollow(guard.resolved);
	if (!opened) {
		if (!requestLifecycle.aborted) send(res, 404, JSON.stringify({ error: "File not found" }));
		return true;
	}
	if (!requestLifecycle.ownDescriptor(opened.fd)) return true;
	if (!previewDirectoryFileMatches(baseDir, generation, relativeAssetPath, opened.stats)) {
		requestLifecycle.closeDescriptor();
		invalidatePreviewDirectoryGeneration(baseDir);
		if (routedCapability) revokePreviewAssetCapability(opts.cookieStore, routedCapability);
		if (!requestLifecycle.aborted) {
			send(res, routedCapability ? 401 : 404, JSON.stringify({
				error: routedCapability ? "Unauthorized" : "Preview mount changed before it could be read",
			}));
		}
		return true;
	}
	if (requestLifecycle.aborted) return true;
	res.writeHead(200, {
		"Content-Type": contentType,
		"Content-Length": String(opened.stats.size),
		"Cache-Control": "no-store",
		"Referrer-Policy": PREVIEW_REFERRER_POLICY,
		"X-Content-Type-Options": "nosniff",
		...(capabilityAuthorized ? { "Access-Control-Allow-Origin": "null" } : {}),
	});
	if (method === "HEAD") {
		requestLifecycle.closeDescriptor();
		res.end();
		return true;
	}
	let stream: fs.ReadStream;
	try {
		stream = fs.createReadStream(guard.resolved, { fd: opened.fd, autoClose: true });
	} catch {
		requestLifecycle.closeDescriptor();
		try {
			if (!res.destroyed && !res.writableEnded) res.end();
		} catch { /* ignore a concurrently closed response */ }
		return true;
	}
	// Stream close, not merely source end, proves the descriptor is gone before
	// the directory lease admits a writer. Request aborts are observed from the
	// moment the lease is acquired, including during generation verification.
	await requestLifecycle.pipeOwnedStream(stream);
	return true;
	} finally {
		await requestLifecycle.dispose();
	}
}
