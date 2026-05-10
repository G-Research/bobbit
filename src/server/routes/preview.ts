/**
 * Preview routes — POST /api/preview/mount, GET /api/preview/mount,
 * GET /api/sessions/:id/preview-events (SSE).
 * Extracted from server.ts (commit: split server.ts).
 */
import fs from "node:fs";
import path from "node:path";
import * as previewMount from "../preview/mount.js";
import { broadcastPreviewChanged, subscribePreviewChanged } from "../preview/events.js";
import type { Route } from "./types.js";

const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export const previewRoutes: Route[] = [
	{
		method: "POST",
		pattern: "/api/preview/mount",
		handler: async ({ url, sandboxScope, readBody, json, jsonError }) => {
			const sessionId = url.searchParams.get("sessionId") || "";
			if (!VALID_SESSION_ID.test(sessionId)) {
				json({ error: "Invalid sessionId" }, 400);
				return;
			}
			if (sandboxScope && !sandboxScope.sessionIds.has(sessionId)) {
				json({ error: "Forbidden: session out of scope" }, 403);
				return;
			}
			const body = await readBody().catch(() => ({}));
			const hasHtml = typeof body?.html === "string";
			const hasFile = typeof body?.file === "string" && body.file.length > 0;
			const hasAssets = Array.isArray(body?.assets);
			const hasManifest = typeof body?.manifest === "string" && body.manifest.length > 0;
			if (!hasHtml && !hasFile) {
				json({ error: "Body must contain one of 'html' or 'file'" }, 400);
				return;
			}
			if (hasHtml && (hasAssets || hasManifest)) {
				json({ error: "`assets`/`manifest` only valid with `file`" }, 400);
				return;
			}
			try {
				let result: previewMount.MountResult | previewMount.MountFileResult;
				if (hasHtml) {
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
				broadcastPreviewChanged(sessionId, {
					entry: result.entry,
					mtime: result.mtime,
					url: result.url,
					path: result.path,
				});
				json(result);
			} catch (err: any) {
				if (err && err instanceof previewMount.PreviewMountError) {
					jsonError(err.statusCode, err);
					return;
				}
				jsonError(500, err, { error: `preview mount failed: ${err?.message ?? String(err)}` });
			}
		},
	},
	{
		method: "GET",
		pattern: "/api/preview/mount",
		handler: async ({ url, sandboxScope, json, jsonError }) => {
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
				const { pickEntry } = await import("../preview/content-route.js");
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
				json({
					url: `/preview/${sessionId}/${entry}`,
					path: entryPath,
					entry,
					mtime: Math.floor(stat.mtimeMs),
				});
			} catch (err: any) {
				if (err && err instanceof previewMount.PreviewMountError) {
					jsonError(err.statusCode, err);
					return;
				}
				jsonError(500, err, { error: `preview mount lookup failed: ${err?.message ?? String(err)}` });
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/preview-events$/,
		handler: async ({ params, req, res, sandboxScope, json }) => {
			const sid = params[1];
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
			res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

			const unsubscribe = subscribePreviewChanged(sid, payload => {
				try {
					res.write(`event: preview-changed\ndata: ${JSON.stringify(payload)}\n\n`);
				} catch { /* socket closed */ }
			});
			try {
				const { pickEntry } = await import("../preview/content-route.js");
				const dir = previewMount.mountDir(sid);
				if (fs.existsSync(dir)) {
					const entry = pickEntry(dir);
					if (entry) {
						const entryPath = path.join(dir, entry);
						const stat = fs.statSync(entryPath);
						res.write(`event: preview-changed\ndata: ${JSON.stringify({
							entry,
							mtime: Math.floor(stat.mtimeMs),
							url: `/preview/${sid}/${entry}`,
							path: entryPath,
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
		},
	},
];
