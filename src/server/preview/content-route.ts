/**
 * Content-origin route for the embedded HTML preview rewrite.
 *
 * Mounts the per-session preview directory at `/preview/<sessionId>/<rel-path>`.
 *
 * - `text/html` responses get a marked, mount-aware `<base>` injected and
 *   the theme/swipe bridge scripts appended.
 * - All other MIME types stream as-is (no body rewrite).
 * - Path-traversal defence delegates to `path-guard.ts::resolveAssetPath`.
 * - Initial auth uses existing localhost/session/admin authority; opaque
 *   follow-on resources require the exact session-bound preview capability.
 * - Successful content is CSP-sandboxed, including non-HTML and HEAD.
 */

import fs from "node:fs";
import type http from "node:http";

import { acquirePreviewDirectoryRead, isPreviewDirectoryAvailable, mountPath, readMountDirectory } from "./mount.js";
import { artifactMountDir } from "./artifacts.js";
import { resolveAssetPath } from "./path-guard.js";
import { mimeTypeFor } from "./mime.js";
import {
	issuePreviewCookieIfMissing,
	tryAuth as cookieTryAuth,
	tryPreviewAuth,
	type CookieStore,
} from "../auth/cookie.js";
import { injectBaseAndScripts, PREVIEW_BRIDGE_SCRIPTS } from "../../shared/preview-bridge-scripts.js";
import { gatewayRoute, normalizeBasePath, withBasePath } from "../../shared/base-path.js";
import { getPreviewThemeSnapshot } from "./theme-snapshot.js";

const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export const PREVIEW_CONTENT_SECURITY_POLICY = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-top-navigation-by-user-activation; frame-ancestors 'self'";

type PreviewAuthorization = "primary" | "preview";

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

function primaryAuthorization(req: http.IncomingMessage, opts: ContentRouteOptions): boolean {
	if (opts.isLocalhost) return true;
	if (cookieTryAuth(req, opts.cookieStore)) return true;
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

function authorizePreviewRequest(
	req: http.IncomingMessage,
	opts: ContentRouteOptions,
	sessionId: string,
): PreviewAuthorization | undefined {
	const previewAuthorized = tryPreviewAuth(req, opts.cookieStore, sessionId);
	const crossSiteIframeNavigation = req.headers["sec-fetch-site"] === "cross-site"
		&& req.headers["sec-fetch-mode"] === "navigate"
		&& req.headers["sec-fetch-dest"] === "iframe";
	// A preview cookie is ambient browser state, not proof that a cross-site
	// parent may embed the preview. Reject that navigation before redirects or
	// bytes, while retaining the capability for opaque sandbox subresources.
	if (crossSiteIframeNavigation) return undefined;
	const opaqueFollowOn = req.headers.origin === "null"
		|| (req.headers.origin === undefined
			&& req.headers["sec-fetch-site"] === "cross-site"
			&& req.headers["sec-fetch-mode"] !== "navigate");
	if (opaqueFollowOn) return previewAuthorized ? "preview" : undefined;
	return primaryAuthorization(req, opts) ? "primary" : undefined;
}

function successfulContentHeaders(
	req: http.IncomingMessage,
	contentType: string,
	contentLength?: number,
): Record<string, string> {
	return {
		"Content-Type": contentType,
		...(contentLength === undefined ? {} : { "Content-Length": String(contentLength) }),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": PREVIEW_CONTENT_SECURITY_POLICY,
		...(req.headers.origin === "null" ? {
			"Access-Control-Allow-Origin": "null",
			"Access-Control-Allow-Credentials": "true",
			Vary: "Origin",
		} : {}),
	};
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

	// Parse and validate the capability binding before consulting any cookie.
	const remainder = pathname.slice("/preview/".length);
	const slashIdx = remainder.indexOf("/");
	const sid = slashIdx < 0 ? remainder : remainder.slice(0, slashIdx);
	let rel = slashIdx < 0 ? "" : remainder.slice(slashIdx + 1);

	if (!sid || !VALID_SESSION_ID.test(sid)) {
		send(res, 400, JSON.stringify({ error: "Invalid sessionId" }));
		return true;
	}

	// Auth still precedes mount, artifact, entry, and file disclosure.
	const authorization = authorizePreviewRequest(req, opts, sid);
	if (!authorization) {
		send(res, 401, JSON.stringify({ error: "Unauthorized" }));
		return true;
	}

	// `/preview/<sid>/_artifact/<artifactId>/<rel>` — serve directly from the
	// stable per-artifact directory instead of the session's live mount slot.
	// This lets the client switch between preview tabs (each backed by its own
	// artifact) by just changing the iframe src — no POST/restore round-trip
	// needed, since each artifact's bytes live at their own URL forever.
	const basePath = normalizeBasePath(opts.basePath);
	let baseDir = mountPath(sid);
	let internalBaseRoute = gatewayRoute(`/preview/${sid}/`);
	if (rel.startsWith("_artifact/")) {
		const afterPrefix = rel.slice("_artifact/".length);
		const nextSlash = afterPrefix.indexOf("/");
		const artifactId = nextSlash < 0 ? afterPrefix : afterPrefix.slice(0, nextSlash);
		const artRel = nextSlash < 0 ? "" : afterPrefix.slice(nextSlash + 1);
		if (!artifactId || !/^[A-Za-z0-9_-]{1,64}$/.test(artifactId)) {
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
		res.writeHead(302, {
			Location: withBasePath(gatewayRoute(`${internalBaseRoute}${encodeURIComponent(entry)}`), basePath),
			"Cache-Control": "no-store",
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
		// standalone-tab opens (where the runtime parent-pull bridge no-ops) still
		// resolve `var(--background)` etc. The runtime bridge continues to flow
		// live theme toggles into embedded iframes where `parent !== window`.
		const publicBaseHref = withBasePath(internalBaseRoute, basePath);
		const baseTag = `<base data-bobbit-preview-base href="${publicBaseHref}">` + getPreviewThemeSnapshot();
		const rewritten = injectBaseAndScripts(body, baseTag, PREVIEW_BRIDGE_SCRIPTS);
		if (authorization === "primary") {
			issuePreviewCookieIfMissing(req, res, opts.cookieStore, sid, { basePath });
		}
		res.writeHead(200, successfulContentHeaders(req, contentType));
		if (method === "HEAD") {
			res.end();
		} else {
			res.end(rewritten);
		}
		return true;
	}

	// Stream other types as-is.
	if (authorization === "primary") {
		issuePreviewCookieIfMissing(req, res, opts.cookieStore, sid, { basePath });
	}
	res.writeHead(200, successfulContentHeaders(req, contentType, guard.size));
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
