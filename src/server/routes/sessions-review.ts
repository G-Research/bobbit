/**
 * Per-session review annotations + submitted flag.
 * Extracted from server.ts (commit: split server.ts).
 */
import type { ReviewAnnotation } from "../review-annotation-store.js";
import type { Route } from "./types.js";

export const sessionsReviewRoutes: Route[] = [
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/review\/annotations\/bulk$/,
		handler: async ({ deps, params, readBody, json }) => {
			const sessionId = params[1];
			if (!deps.sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
			if (!deps.reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
			const body = await readBody();
			if (!body || typeof body !== "object") { json({ error: "Invalid body" }, 400); return; }
			const annotations: Record<string, ReviewAnnotation[]> = {};
			if (body.annotations && typeof body.annotations === "object") {
				for (const [docTitle, anns] of Object.entries(body.annotations)) {
					if (Array.isArray(anns)) {
						annotations[docTitle] = anns as ReviewAnnotation[];
					}
				}
			}
			const submitted = typeof body.submitted === "boolean"
				? body.submitted
				: deps.reviewAnnotationStore.isSubmitted(sessionId);
			deps.reviewAnnotationStore.writeAll(sessionId, annotations, submitted);
			json({ ok: true });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/review\/annotations$/,
		handler: ({ deps, params, json }) => {
			const sessionId = params[1];
			if (!deps.sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
			if (!deps.reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
			json(deps.reviewAnnotationStore.getAll(sessionId));
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/review\/annotations$/,
		handler: async ({ deps, params, readBody, json }) => {
			const sessionId = params[1];
			if (!deps.sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
			if (!deps.reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
			const body = await readBody();
			if (!body?.docTitle || !body?.annotation) {
				json({ error: "docTitle and annotation required" }, 400);
				return;
			}
			deps.reviewAnnotationStore.addAnnotation(sessionId, body.docTitle, body.annotation);
			json({ ok: true });
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/sessions\/([^/]+)\/review\/annotations\/([^/]+)$/,
		handler: ({ deps, params, url, json }) => {
			const sessionId = params[1];
			if (!deps.sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
			if (!deps.reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
			const annotationId = decodeURIComponent(params[2]);
			const docTitle = url.searchParams.get("docTitle");
			if (!docTitle) { json({ error: "docTitle query parameter is required" }, 400); return; }
			deps.reviewAnnotationStore.removeAnnotation(sessionId, docTitle, annotationId);
			json({ ok: true });
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/sessions\/([^/]+)\/review\/annotations$/,
		handler: async ({ deps, params, readBody, json }) => {
			const sessionId = params[1];
			if (!deps.sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
			if (!deps.reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
			const body = await readBody();
			const docTitle = body?.docTitle;
			if (docTitle) {
				deps.reviewAnnotationStore.clearAnnotations(sessionId, docTitle);
			} else {
				deps.reviewAnnotationStore.clearAll(sessionId);
			}
			json({ ok: true });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/review\/submitted$/,
		handler: ({ deps, params, json }) => {
			const sessionId = params[1];
			if (!deps.sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
			if (!deps.reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
			json({ submitted: deps.reviewAnnotationStore.isSubmitted(sessionId) });
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/sessions\/([^/]+)\/review\/submitted$/,
		handler: async ({ deps, params, readBody, json }) => {
			const sessionId = params[1];
			if (!deps.sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
			if (!deps.reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
			const body = await readBody();
			deps.reviewAnnotationStore.setSubmitted(sessionId, !!body?.submitted);
			json({ ok: true });
		},
	},
];
