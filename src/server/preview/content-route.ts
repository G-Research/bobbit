/**
 * Content-origin route for the embedded HTML preview rewrite.
 *
 * Mounts the per-session preview directory at `/preview/<sessionId>/<rel-path>`.
 *
 * - `text/html` responses get a marked, mount-aware `<base>` injected and
 *   the theme/swipe bridge scripts appended.
 * - All other MIME types stream as-is (no body rewrite).
 * - Path-traversal defence delegates to `path-guard.ts::resolveAssetPath`.
 * - Initial navigation uses the signed browser cookie (or the existing admin
 *   fallback); opaque-frame subresources use a signed, tree-scoped path
 *   capability because SameSite cookies are intentionally unavailable there.
 * - Localhost mode retains its existing auth short-circuit.
 */

import fs from "node:fs";
import type http from "node:http";

import { acquirePreviewDirectoryRead, isPreviewDirectoryAvailable, mountPath, readMountDirectory } from "./mount.js";
import { artifactMountDir } from "./artifacts.js";
import { resolveAssetPath } from "./path-guard.js";
import { mimeTypeFor } from "./mime.js";
import { tryAuth as cookieTryAuth, type CookieStore } from "../auth/cookie.js";
import { canonicalHttpOrigin, canonicalRequestOrigin } from "../auth/browser-cookie.js";
import { injectBaseAndScripts, PREVIEW_BRIDGE_SCRIPTS } from "../../shared/preview-bridge-scripts.js";
import { gatewayRoute, normalizeBasePath, withBasePath } from "../../shared/base-path.js";
import { getPreviewThemeSnapshot } from "./theme-snapshot.js";

const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const VALID_ARTIFACT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VALID_CONTENT_CAPABILITY = /^[A-Za-z0-9._-]{1,256}$/;
const CONTENT_CAPABILITY_SEGMENT = "_content";

type PreviewContentCapability = Readonly<{ token: string; path: string; scope: string }>;

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

/**
 * Preview HTML is agent-authored and may be served below Bobbit or another
 * application on the same web origin. The response sandbox is therefore the
 * security boundary for both embedded frames and top-level preview popouts.
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
}

function send(res: http.ServerResponse, status: number, body: string, contentType = "application/json") {
	res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
	res.end(body);
}

function isAuthorized(
	req: http.IncomingMessage,
	opts: ContentRouteOptions,
	contentCapability?: PreviewContentCapability | null,
): boolean {
	if (contentCapability) {
		// Capability values live in the URL path, not a Cookie header. Verify the
		// signed value against a session/artifact-specific synthetic base scope;
		// it cannot authenticate APIs or a different preview tree.
		if (opts.cookieStore.verify(contentCapability.token, { basePath: contentCapability.scope })) return true;
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
	const capabilityAuthorized = Boolean(
		capability && opts.cookieStore.verify(capability.token, { basePath: capability.scope }),
	);

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
	// requests. A signed path capability restores access only to this exact
	// session/artifact tree; it cannot authenticate Bobbit APIs or siblings.
	if (rel.startsWith(`${CONTENT_CAPABILITY_SEGMENT}/`)) {
		const routedCapability = contentCapabilityFromRoute(rel, basePath, internalBaseRoute);
		if (!routedCapability || !opts.cookieStore.verify(routedCapability.token, { basePath: routedCapability.scope })) {
			send(res, 401, JSON.stringify({ error: "Unauthorized" }));
			return true;
		}
		rel = routedCapability.path;
	}

	// Whole-root installs fence the exact destination through post-rename
	// identity verification. Fail closed while that fence is active.
	if (!isPreviewDirectoryAvailable(baseDir)) {
		send(res, 404, JSON.stringify({ error: "Preview mount is not available" }));
		return true;
	}

	// `/preview/<sid>` → 301 redirect to add trailing slash so relative URLs resolve.
	if (slashIdx < 0) {
		res.writeHead(301, { Location: withBasePath(gatewayRoute(`/preview/${sid}/`), basePath), "Cache-Control": "no-store" });
		res.end();
		return true;
	}

	const releaseRead = acquirePreviewDirectoryRead(baseDir);
	if (!releaseRead) {
		send(res, 404, JSON.stringify({ error: "Preview mount is not available" }));
		return true;
	}
	try {
		// `/preview/<sid>/` → pick entry and 302.
	if (rel === "") {
		if (!fs.existsSync(baseDir)) {
			send(res, 404, JSON.stringify({ error: "Preview mount not found" }));
			return true;
		}
		const entry = await pickEntry(baseDir);
		if (!isPreviewDirectoryAvailable(baseDir)) {
			send(res, 404, JSON.stringify({ error: "Preview mount is not available" }));
			return true;
		}
		if (!entry) {
			send(res, 404, JSON.stringify({ error: "Preview mount is empty" }));
			return true;
		}
		const redirectBaseRoute = capabilityAuthorized && capability
			? gatewayRoute(`${internalBaseRoute}${CONTENT_CAPABILITY_SEGMENT}/${capability.token}/`)
			: internalBaseRoute;
		res.writeHead(302, {
			Location: withBasePath(gatewayRoute(`${redirectBaseRoute}${encodeURIComponent(entry)}`), basePath),
			"Cache-Control": "no-store",
			...(capabilityAuthorized ? { "Access-Control-Allow-Origin": "null" } : {}),
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

	const contentType = mimeTypeFor(guard.resolved);
	const isHtml = contentType.startsWith("text/html");

	if (isHtml) {
		// Read into memory and inject base + bridge scripts.
		let body: string;
		try {
			body = fs.readFileSync(guard.resolved, "utf-8");
		} catch {
			send(res, 404, JSON.stringify({ error: "File not found" }));
			return true;
		}
		// `<base>` + inline theme-token snapshot. Both land inside <head> via
		// injectBaseAndScripts; the snapshot defines `:root`/`.dark` defaults so
		// standalone-tab opens still resolve `var(--background)` etc. Opaque
		// embedded frames receive live theme updates over the constrained
		// postMessage bridge instead of reading parent.document.
		const requestOrigin = canonicalRequestOrigin({
			headers: req.headers,
			isTls: Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted),
		});
		const capabilityBaseRoute = requestOrigin
			? gatewayRoute(`${internalBaseRoute}${CONTENT_CAPABILITY_SEGMENT}/${opts.cookieStore.mint({
				basePath: contentCapabilityScope(basePath, internalBaseRoute),
				origin: requestOrigin,
			})}/`)
			: internalBaseRoute;
		const publicBaseHref = withBasePath(capabilityBaseRoute, basePath);
		const baseTag = `<base data-bobbit-preview-base href="${publicBaseHref}">` + getPreviewThemeSnapshot();
		const rewritten = injectBaseAndScripts(
			body,
			baseTag,
			PREVIEW_BRIDGE_SCRIPTS + PREVIEW_OPAQUE_THEME_BRIDGE,
		);
		res.writeHead(200, {
			"Content-Type": contentType,
			"Cache-Control": "no-store",
			"Content-Security-Policy": PREVIEW_HTML_CONTENT_SECURITY_POLICY,
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

	// Stream other types as-is.
	res.writeHead(200, {
		"Content-Type": contentType,
		"Content-Length": String(guard.size),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		...(capabilityAuthorized ? { "Access-Control-Allow-Origin": "null" } : {}),
	});
	if (method === "HEAD") {
		res.end();
		return true;
	}
	const stream = fs.createReadStream(guard.resolved);
	// Keep the read lease until exactly one terminal condition wins. A client
	// abort/close must stop disk I/O rather than leaving the stream (and lease)
	// alive until the file naturally reaches EOF.
	await new Promise<void>(resolve => {
		let settled = false;
		const removeListener = (emitter: unknown, event: string, listener: () => void) => {
			(emitter as { removeListener?: (name: string, fn: () => void) => void }).removeListener?.(event, listener);
		};
		const cleanup = () => {
			stream.removeListener("end", onEnd);
			stream.removeListener("close", onStreamClose);
			stream.removeListener("error", onStreamError);
			removeListener(req, "aborted", onAbort);
			removeListener(req, "close", onRequestClose);
			removeListener(res, "close", onAbort);
		};
		const settle = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};
		const onAbort = () => {
			if (!stream.destroyed) stream.destroy();
			settle();
		};
		// IncomingMessage also emits close after an ordinary fully received GET.
		// Only an incomplete/aborted request close represents client disconnect.
		const onRequestClose = () => {
			if (req.aborted || !req.complete) onAbort();
		};
		const onEnd = () => settle();
		const onStreamClose = () => settle();
		const onStreamError = () => {
			try {
				if (!res.destroyed && !res.writableEnded) res.end();
			} catch { /* ignore a concurrently closed response */ }
			settle();
		};

		stream.once("end", onEnd);
		stream.once("close", onStreamClose);
		stream.once("error", onStreamError);
		if (typeof req.once === "function") {
			req.once("aborted", onAbort);
			req.once("close", onRequestClose);
		}
		if (typeof res.once === "function") res.once("close", onAbort);
		stream.pipe(res);
	});
	return true;
	} finally {
		releaseRead();
	}
}
