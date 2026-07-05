// src/server/routes/preview-routes.ts
//
// STR-01 cohort 16b: Preview mount/artifact/SSE routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block gated on route match and method in the same `if` condition. A method
// mismatch skipped the block and fell through to the terminal 404; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.

import fs from "node:fs";
import path from "node:path";

import { openSidePanelWorkspaceTab } from "../side-panel-workspace-routes.js";
import { pickEntry } from "../preview/content-route.js";
import * as previewMount from "../preview/mount.js";
import * as previewArtifacts from "../preview/artifacts.js";
import { broadcastPreviewChanged, subscribePreviewChanged } from "../preview/events.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function previewEntryLabelForWorkspace(entry: string | undefined | null): string {
	const clean = (entry || "inline.html").split(/[?#]/, 1)[0]?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "inline.html";
	return clean.split("/").filter(Boolean).pop() || clean || "inline.html";
}

async function openPreviewMountWorkspaceTab(ctx: CoreRouteCtx, sessionId: string, result: {
	entry?: string;
	mtime?: number;
	url?: string;
	path?: string;
	contentHash?: string;
	artifactId?: string;
}): Promise<void> {
	const { broadcastToSession, packContributionRegistry, readBody, sessionManager } = ctx;
	const entry = previewEntryLabelForWorkspace(result.entry);
	try {
		await openSidePanelWorkspaceTab({
			sessionManager,
			readBody,
			broadcastToSession,
			packContributionRegistry,
		}, sessionId, {
			id: `preview:entry:${encodeURIComponent(entry)}`,
			kind: "preview",
			title: entry,
			label: entry,
			source: {
				type: "preview",
				sessionId,
				entry,
				live: true,
				...(typeof result.contentHash === "string" && result.contentHash ? { contentHash: result.contentHash } : {}),
				...(typeof result.path === "string" && result.path ? { path: result.path } : {}),
				...(typeof result.url === "string" && result.url ? { url: result.url } : {}),
				...(typeof result.artifactId === "string" && result.artifactId ? { artifactId: result.artifactId } : {}),
			},
			state: {
				entry,
				origin: "preview-mount",
				...(typeof result.mtime === "number" ? { mtime: result.mtime } : {}),
				...(typeof result.url === "string" && result.url ? { url: result.url } : {}),
				...(typeof result.path === "string" && result.path ? { path: result.path } : {}),
				...(typeof result.contentHash === "string" && result.contentHash ? { contentHash: result.contentHash } : {}),
				...(typeof result.artifactId === "string" && result.artifactId ? { artifactId: result.artifactId } : {}),
			},
			updatedAt: Date.now(),
		}, { focus: true, placeAfterActive: true });
	} catch (err) {
		console.warn(`[preview/mount] failed to open side-panel workspace tab for ${sessionId}:`, err);
	}
}

// POST /api/preview/mount?sessionId=<sid> — v3 per-session preview mount.
async function handlePreviewMountPost(ctx: CoreRouteCtx): Promise<void> {
	const { json, jsonError, readBody, req, sandboxScope, url } = ctx;
	const sessionId = url.searchParams.get("sessionId") || "";
	if (!VALID_SESSION_ID.test(sessionId)) {
		json({ error: "Invalid sessionId" }, 400);
		return;
	}
	if (sandboxScope && !sandboxScope.sessionIds.has(sessionId)) {
		json({ error: "Forbidden: session out of scope" }, 403);
		return;
	}
	const body = await readBody(req).catch(() => ({}));
	const shouldOpenWorkspaceTab = body?.workspaceTab !== false
		&& body?.openWorkspaceTab !== false
		&& body?.internalRestore !== true
		&& url.searchParams.get("workspaceTab") !== "false";
	const hasArtifact = typeof body?.artifactId === "string" && body.artifactId.length > 0;
	const hasHtml = typeof body?.html === "string";
	const hasFile = typeof body?.file === "string" && body.file.length > 0;
	const hasAssets = Array.isArray(body?.assets);
	const hasManifest = typeof body?.manifest === "string" && body.manifest.length > 0;
	if (hasArtifact && (hasHtml || hasFile || hasAssets || hasManifest)) {
		json({ error: "`artifactId` restore cannot be combined with `html`, `file`, `assets`, or `manifest`" }, 400);
		return;
	}
	if (!hasArtifact && !hasHtml && !hasFile) {
		json({ error: "Body must contain one of 'html', 'file', or 'artifactId'" }, 400);
		return;
	}
	if (hasHtml && (hasAssets || hasManifest)) {
		json({ error: "`assets`/`manifest` only valid with `file`" }, 400);
		return;
	}
	try {
		let result: previewMount.MountResult | previewMount.MountFileResult | previewArtifacts.PreviewArtifactMountResult;
		if (hasArtifact) {
			const restored = previewArtifacts.restorePreviewArtifact(sessionId, body.artifactId as string);
			if (shouldOpenWorkspaceTab) await openPreviewMountWorkspaceTab(ctx, sessionId, restored);
			broadcastPreviewChanged(sessionId, {
				entry: restored.entry,
				mtime: restored.mtime,
				url: restored.url,
				path: restored.path,
				contentHash: restored.contentHash,
				artifactId: restored.artifactId,
			});
			json(restored);
			return;
		}
		if (hasHtml) {
			// `html` wins over `file` when both are provided.
			let entry: string | undefined;
			if (typeof body.entry === "string" && body.entry.length > 0) {
				const e = body.entry;
				if (e.includes("/") || e.includes("\\") || e.includes("..") || e.includes("\0")) {
					json({ error: "Invalid entry name" }, 400);
					return;
				}
				entry = e;
			}
			result = previewMount.writeInline(sessionId, body.html as string, entry);
		} else {
			const filePath = body.file as string;
			if (!path.isAbsolute(filePath)) {
				json({ error: "file path must be absolute" }, 400);
				return;
			}
			if (!fs.existsSync(filePath)) {
				json({ error: "file not found" }, 404);
				return;
			}
			let stat: fs.Stats;
			try { stat = fs.statSync(filePath); } catch {
				json({ error: "file not found" }, 404);
				return;
			}
			if (!stat.isFile()) {
				json({ error: "path is not a regular file" }, 404);
				return;
			}
			const base = path.basename(filePath).toLowerCase();
			if (!base.endsWith(".html") && !base.endsWith(".htm")) {
				json({ error: "file must end in .html or .htm" }, 400);
				return;
			}
			// Collect assets from inline `assets[]` and optional `manifest` JSON.
			const declared: string[] = [];
			if (hasAssets) {
				for (const a of body.assets as unknown[]) {
					if (typeof a !== "string") {
						json({ error: "`assets[]` entries must be strings" }, 400);
						return;
					}
					declared.push(a);
				}
			}
			if (hasManifest) {
				const manifestRel = body.manifest as string;
				if (path.isAbsolute(manifestRel) || manifestRel.includes("\0") ||
					manifestRel.includes("\\") || manifestRel.split("/").some(s => s === "..")) {
					json({ error: "Invalid manifest path" }, 400);
					return;
				}
				const manifestAbs = path.resolve(path.dirname(filePath), manifestRel);
				if (!fs.existsSync(manifestAbs)) {
					json({ error: `Manifest '${manifestRel}' not found` }, 404);
					return;
				}
				let manifestParsed: any;
				try {
					manifestParsed = JSON.parse(fs.readFileSync(manifestAbs, "utf-8"));
				} catch (err: any) {
					jsonError(400, err, { error: `Manifest JSON parse error: ${err?.message ?? err}` });
					return;
				}
				if (!manifestParsed || !Array.isArray(manifestParsed.assets)) {
					json({ error: "Manifest must be an object with an `assets[]` array" }, 400);
					return;
				}
				for (const a of manifestParsed.assets) {
					if (typeof a !== "string") {
						json({ error: "Manifest `assets[]` entries must be strings" }, 400);
						return;
					}
					declared.push(a);
				}
			}
			// De-duplicate while preserving order.
			const seen = new Set<string>();
			const dedup: string[] = [];
			for (const a of declared) {
				const k = a.trim();
				if (seen.has(k)) continue;
				seen.add(k);
				dedup.push(a);
			}
			result = previewMount.mountFile(sessionId, filePath, dedup);
		}
		const artifact = previewArtifacts.persistPreviewArtifact(sessionId, result);
		const resultWithArtifact = { ...result, artifactId: artifact.artifactId };
		if (shouldOpenWorkspaceTab) await openPreviewMountWorkspaceTab(ctx, sessionId, resultWithArtifact);
		broadcastPreviewChanged(sessionId, {
			entry: result.entry,
			mtime: result.mtime,
			url: result.url,
			path: result.path,
			contentHash: result.contentHash,
			artifactId: artifact.artifactId,
		});
		json(resultWithArtifact);
		return;
	} catch (err: any) {
		if (err && err instanceof previewMount.PreviewMountError) {
			jsonError(err.statusCode, err);
			return;
		}
		if (err && err instanceof previewArtifacts.PreviewArtifactError) {
			jsonError(err.statusCode, err);
			return;
		}
		jsonError(500, err, { error: `preview mount failed: ${err?.message ?? String(err)}` });
		return;
	}
}

// POST /api/preview/artifacts/:artifactId/restore?sessionId=<sid> — restore
// an immutable preview artifact into the single live preview mount.
async function handlePreviewArtifactRestore(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, readBody, req, sandboxScope, url } = ctx;
	const sessionId = url.searchParams.get("sessionId") || "";
	const artifactId = decodeURIComponent(params.artifactId || "");
	if (!VALID_SESSION_ID.test(sessionId)) {
		json({ error: "Invalid sessionId" }, 400);
		return;
	}
	if (sandboxScope && !sandboxScope.sessionIds.has(sessionId)) {
		json({ error: "Forbidden: session out of scope" }, 403);
		return;
	}
	const body = await readBody(req).catch(() => ({}));
	if (typeof body?.artifactId === "string" && body.artifactId.length > 0 && body.artifactId !== artifactId) {
		json({ error: "artifactId body does not match route" }, 400);
		return;
	}
	try {
		const restored = previewArtifacts.restorePreviewArtifact(sessionId, artifactId);
		broadcastPreviewChanged(sessionId, {
			entry: restored.entry,
			mtime: restored.mtime,
			url: restored.url,
			path: restored.path,
			contentHash: restored.contentHash,
			artifactId: restored.artifactId,
		});
		json(restored);
		return;
	} catch (err: any) {
		if (err && err instanceof previewArtifacts.PreviewArtifactError) {
			jsonError(err.statusCode, err);
			return;
		}
		jsonError(500, err, { error: `preview artifact restore failed: ${err?.message ?? String(err)}` });
		return;
	}
}

// GET /api/preview/mount?sessionId=<sid> — bootstrap the preview panel after
// session select. Returns the current entry/mtime/url/path for the mount,
// or 404 if the mount is empty / nonexistent. Same auth as the POST.
async function handlePreviewMountGet(ctx: CoreRouteCtx): Promise<void> {
	const { json, jsonError, sandboxScope, url } = ctx;
	const sessionId = url.searchParams.get("sessionId") || "";
	if (!VALID_SESSION_ID.test(sessionId)) {
		json({ error: "Invalid sessionId" }, 400);
		return;
	}
	if (sandboxScope && !sandboxScope.sessionIds.has(sessionId)) {
		json({ error: "Forbidden: session out of scope" }, 403);
		return;
	}
	try {
		const dir = previewMount.mountDir(sessionId);
		const entry = pickEntry(dir);
		if (!entry) {
			json({ error: "no preview mount" }, 404);
			return;
		}
		const entryPath = path.join(dir, entry);
		let stat: fs.Stats;
		try { stat = fs.statSync(entryPath); } catch {
			json({ error: "no preview mount" }, 404);
			return;
		}
		const contentHash = previewMount.contentHashForMount(sessionId);
		const artifact = previewArtifacts.findPreviewArtifactByHash(sessionId, contentHash);
		json({
			url: `/preview/${sessionId}/${entry}`,
			path: entryPath,
			relPath: path.posix.join(sessionId, entry),
			entry,
			mtime: Math.floor(stat.mtimeMs),
			contentHash,
			artifactId: artifact?.artifactId,
		});
		return;
	} catch (err: any) {
		if (err && err instanceof previewMount.PreviewMountError) {
			jsonError(err.statusCode, err);
			return;
		}
		jsonError(500, err, { error: `preview mount lookup failed: ${err?.message ?? String(err)}` });
		return;
	}
}

// GET /api/sessions/:sid/preview-events — SSE stream of preview-changed events
// for the per-session preview mount. Cookie auth (or admin bearer) only;
// sandbox tokens are not permitted (handled by the route-guard above).
async function handlePreviewEvents(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, res, req, sandboxScope } = ctx;
	const sid = params.sid;
	if (!VALID_SESSION_ID.test(sid)) {
		json({ error: "Invalid sessionId" }, 400);
		return;
	}
	if (sandboxScope) {
		json({ error: "Forbidden" }, 403);
		return;
	}
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		"Connection": "keep-alive",
		"X-Accel-Buffering": "no",
	});
	try { (res as { flushHeaders?: () => void }).flushHeaders?.(); } catch { /* ok */ }
	// Initial hello so the client knows the stream is live.
	res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

	// Subscribe to the in-process preview-changed channel populated by the
	// mount POST endpoint. Payload shape `{entry, mtime, url, path}` is
	// forwarded verbatim — the client reads `entry` to seed the iframe.
	const unsubscribe = subscribePreviewChanged(sid, payload => {
		try {
			res.write(`event: preview-changed\ndata: ${JSON.stringify(payload)}\n\n`);
		} catch { /* socket closed */ }
	});
	// Bootstrap: if a mount already exists for this session, emit the
	// current state synchronously so the just-connected client doesn't
	// wait for the next agent write. Avoids a race where
	// broadcastPreviewChanged fires between EventSource open and the
	// subscription being registered. Payload shape `{entry, mtime, url,
	// path}` matches broadcastPreviewChanged so the client doesn't need
	// to distinguish bootstrap from live events.
	try {
		const dir = previewMount.mountDir(sid);
		if (fs.existsSync(dir)) {
			const entry = pickEntry(dir);
			if (entry) {
				const entryPath = path.join(dir, entry);
				const stat = fs.statSync(entryPath);
				const contentHash = previewMount.contentHashForMount(sid);
				const artifact = previewArtifacts.findPreviewArtifactByHash(sid, contentHash);
				res.write(`event: preview-changed\ndata: ${JSON.stringify({
					entry,
					mtime: Math.floor(stat.mtimeMs),
					url: `/preview/${sid}/${entry}`,
					path: entryPath,
					contentHash,
					artifactId: artifact?.artifactId,
				})}\n\n`);
			}
		}
	} catch { /* ok — bootstrap is best-effort */ }
	const keepalive = setInterval(() => {
		try { res.write(":keepalive\n\n"); } catch { /* ok */ }
	}, 25_000);
	if (typeof keepalive.unref === "function") keepalive.unref();
	const cleanup = () => {
		clearInterval(keepalive);
		try { unsubscribe(); } catch { /* ok */ }
	};
	req.on("close", cleanup);
	req.on("error", cleanup);
	return;
}

export function registerPreviewRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("POST", "/api/preview/mount", handlePreviewMountPost);
	table.register("POST", "/api/preview/artifacts/:artifactId/restore", handlePreviewArtifactRestore);
	table.register("GET", "/api/preview/mount", handlePreviewMountGet);
	table.register("GET", "/api/sessions/:sid/preview-events", handlePreviewEvents);
}
