/**
 * Content-origin route for the embedded HTML preview rewrite.
 *
 * Mounts the per-session preview directory at `/preview/<sessionId>/<rel-path>`.
 *
 * - `text/html` responses get a `<base href="/preview/<sid>/">` injected and
 *   the theme/swipe bridge scripts appended.
 * - All other MIME types stream as-is (no body rewrite).
 * - Path-traversal defence delegates to `path-guard.ts::resolveAssetPath`.
 * - Auth is cookie-based (`bobbit_session`); localhost mode short-circuits.
 *
 * Bearer-token auth is intentionally *not* honoured here: iframe navigations
 * cannot carry an `Authorization` header. The cookie is minted by the API
 * router on the user's first authenticated request.
 */

import fs from "node:fs";
import type http from "node:http";

import { acquirePreviewDirectoryRead, isPreviewDirectoryAvailable, mountPath, readMountDirectory } from "./mount.js";
import { artifactMountDir } from "./artifacts.js";
import { resolveAssetPath } from "./path-guard.js";
import { mimeTypeFor } from "./mime.js";
import { tryAuth as cookieTryAuth, type CookieStore } from "../auth/cookie.js";
import { injectBaseAndScripts, PREVIEW_BRIDGE_SCRIPTS } from "../../shared/preview-bridge-scripts.js";
import { getPreviewThemeSnapshot } from "./theme-snapshot.js";

const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface ContentRouteOptions {
	cookieStore: CookieStore;
	isLocalhost: boolean;
	/** Optional admin token check for fallback bearer-auth (used by SSE callers and tests). */
	adminBearerToken?: string;
}

function send(res: http.ServerResponse, status: number, body: string, contentType = "application/json") {
	res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
	res.end(body);
}

function isAuthorized(req: http.IncomingMessage, opts: ContentRouteOptions): boolean {
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

	// Auth (must come before any disclosure).
	if (!isAuthorized(req, opts)) {
		send(res, 401, JSON.stringify({ error: "Unauthorized" }));
		return true;
	}

	// Parse `/preview/<sid>(/<rel>)?`.
	const remainder = pathname.slice("/preview/".length);
	const slashIdx = remainder.indexOf("/");
	const sid = slashIdx < 0 ? remainder : remainder.slice(0, slashIdx);
	let rel = slashIdx < 0 ? "" : remainder.slice(slashIdx + 1);

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
	let baseHrefPrefix = `/preview/${sid}/`;
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
		baseHrefPrefix = `/preview/${sid}/_artifact/${artifactId}/`;
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
		res.writeHead(301, { Location: `/preview/${sid}/`, "Cache-Control": "no-store" });
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
		res.writeHead(302, { Location: `${baseHrefPrefix}${encodeURIComponent(entry)}`, "Cache-Control": "no-store" });
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
		const baseTag = `<base href="${baseHrefPrefix}">` + getPreviewThemeSnapshot();
		const rewritten = injectBaseAndScripts(body, baseTag, PREVIEW_BRIDGE_SCRIPTS);
		res.writeHead(200, {
			"Content-Type": contentType,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
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
	});
	if (method === "HEAD") {
		res.end();
		return true;
	}
	const stream = fs.createReadStream(guard.resolved);
	stream.on("error", () => { try { res.end(); } catch { /* ignore */ } });
	stream.pipe(res);
	// Wait for stream to finish so the caller's `await` resolves once the response is done.
	await new Promise<void>(resolve => {
		stream.on("end", () => resolve());
		stream.on("close", () => resolve());
		stream.on("error", () => resolve());
	});
	return true;
	} finally {
		releaseRead();
	}
}
