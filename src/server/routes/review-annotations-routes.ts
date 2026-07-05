// src/server/routes/review-annotations-routes.ts
//
// STR-01 cohort 6: the review-annotation family —
// POST /api/sessions/:id/review/annotations/bulk,
// GET/POST/DELETE /api/sessions/:id/review/annotations,
// DELETE /api/sessions/:id/review/annotations/:annotationId,
// GET/PUT /api/sessions/:id/review/submitted — migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md (cohorts 1-5 established the seam +
// protocol).
//
// Mechanical extraction — every handler body below is byte-for-byte the same
// logic as the corresponding `if (req.method === ... && url.pathname....)`
// block it replaced in server.ts, with the following mechanical
// substitutions:
//   - `url.pathname.split("/")[3]` (the session id segment) → the registry's
//     named `params.id` (raw, undecoded — matches the legacy `split()`
//     extraction, which never decoded it either).
//   - the legacy single DELETE block branched at runtime on
//     `parts.length >= 7 && parts[6]` to distinguish "delete one annotation"
//     from "clear all/by docTitle"; that branch is now two separate
//     registrations (`.../annotations` and `.../annotations/:annotationId`)
//     sharing the same two verbatim bodies. `params.annotationId` is
//     decoded with `decodeURIComponent`, exactly as the legacy
//     `decodeURIComponent(parts[6])` did.
//   - free variables that used to be handleApiRoute's own params/closures
//     (json, readBody, sessionManager, reviewAnnotationStore) are
//     destructured from `ctx`.
// Zero behavior change for every path shape exercised by
// tests/e2e/review-annotations-api.spec.ts: same validation, same status
// codes, same error shapes.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed (cohort 5's
// shape, not cohort 2/4's). Every legacy block here gated on the method AND
// the path in the SAME `if` condition, with no shared pre-branch resolution
// step — a method mismatch (e.g. PUT .../review/annotations, PATCH
// .../review/submitted) never entered any block, falling straight through
// to the same generic terminal 404 any unmatched path would hit.
// `RouteTable`'s `:param`/exact entries are method-scoped the same way, so
// leaving other methods unregistered on these path shapes reproduces that
// fall-through exactly.
//
// NOT bit-for-bit for one pathological input the legacy code accepted only
// by accident: the old DELETE block matched via
// `url.pathname.includes("/review/annotations")` (not `endsWith`), so a
// DELETE to a path with a trailing slash or extra segments beyond the
// annotation id fell into the same block with slightly different parts[]
// indexing. No test exercises this; `tests/e2e/review-annotations-api.spec.ts`
// only exercises the documented shapes above, all reproduced exactly.

import type { RouteTable } from "./route-table.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { ReviewAnnotation } from "../review-annotation-store.js";

// POST /api/sessions/:id/review/annotations/bulk — bulk save all annotations + submitted flag (used by sendBeacon on page unload)
async function handleReviewAnnotationsBulk(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, readBody, req, sessionManager, reviewAnnotationStore } = ctx;
	const sessionId = params.id;
	if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
	if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
	const body = await readBody(req);
	if (!body || typeof body !== "object") { json({ error: "Invalid body" }, 400); return; }
	const annotations: Record<string, ReviewAnnotation[]> = {};
	if (body.annotations && typeof body.annotations === "object") {
		for (const [docTitle, anns] of Object.entries(body.annotations)) {
			if (Array.isArray(anns)) {
				annotations[docTitle] = anns as ReviewAnnotation[];
			}
		}
	}
	// If `submitted` is omitted (or non-boolean), preserve whatever is
	// already on disk. This is critical: the page-unload beacon historically
	// sent `submitted: false` whenever the local cache hadn't observed a
	// `true`, which clobbered out-of-band PUT(submitted=true) calls (other
	// tabs, REST clients, the test harness) on the next page reload (RP-09).
	// The client now omits the field unless it positively wants to write
	// `true`; the legacy clear path still goes through the dedicated
	// /review/submitted PUT.
	const submitted = typeof body.submitted === "boolean"
		? body.submitted
		: reviewAnnotationStore.isSubmitted(sessionId);
	reviewAnnotationStore.writeAll(sessionId, annotations, submitted);
	json({ ok: true });
}

// GET /api/sessions/:id/review/annotations
async function handleReviewAnnotationsList(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, sessionManager, reviewAnnotationStore } = ctx;
	const sessionId = params.id;
	if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
	if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
	const data = reviewAnnotationStore.getAll(sessionId);
	json(data);
}

// POST /api/sessions/:id/review/annotations
async function handleReviewAnnotationsCreate(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, readBody, req, sessionManager, reviewAnnotationStore } = ctx;
	const sessionId = params.id;
	if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
	if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
	const body = await readBody(req);
	if (!body?.docTitle || !body?.annotation) {
		json({ error: "docTitle and annotation required" }, 400);
		return;
	}
	reviewAnnotationStore.addAnnotation(sessionId, body.docTitle, body.annotation);
	json({ ok: true });
}

// DELETE /api/sessions/:id/review/annotations/:annotationId
async function handleReviewAnnotationDeleteOne(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, sessionManager, reviewAnnotationStore } = ctx;
	const sessionId = params.id;
	if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
	if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
	const annotationId = decodeURIComponent(params.annotationId);
	const docTitle = url.searchParams.get("docTitle");
	if (!docTitle) { json({ error: "docTitle query parameter is required" }, 400); return; }
	reviewAnnotationStore.removeAnnotation(sessionId, docTitle, annotationId);
	json({ ok: true });
}

// DELETE /api/sessions/:id/review/annotations — clear all or by docTitle
async function handleReviewAnnotationsClear(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, readBody, req, sessionManager, reviewAnnotationStore } = ctx;
	const sessionId = params.id;
	if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
	if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
	const body = await readBody(req);
	const docTitle = body?.docTitle;
	if (docTitle) {
		reviewAnnotationStore.clearAnnotations(sessionId, docTitle);
	} else {
		reviewAnnotationStore.clearAll(sessionId);
	}
	json({ ok: true });
}

// GET /api/sessions/:id/review/submitted
async function handleReviewSubmittedGet(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, sessionManager, reviewAnnotationStore } = ctx;
	const sessionId = params.id;
	if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
	if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
	json({ submitted: reviewAnnotationStore.isSubmitted(sessionId) });
}

// PUT /api/sessions/:id/review/submitted
async function handleReviewSubmittedPut(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, readBody, req, sessionManager, reviewAnnotationStore } = ctx;
	const sessionId = params.id;
	if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
	if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
	const body = await readBody(req);
	reviewAnnotationStore.setSubmitted(sessionId, !!body?.submitted);
	json({ ok: true });
}

export function registerReviewAnnotationRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("POST", "/api/sessions/:id/review/annotations/bulk", handleReviewAnnotationsBulk);
	table.register("GET", "/api/sessions/:id/review/annotations", handleReviewAnnotationsList);
	table.register("POST", "/api/sessions/:id/review/annotations", handleReviewAnnotationsCreate);
	table.register("DELETE", "/api/sessions/:id/review/annotations", handleReviewAnnotationsClear);
	table.register("DELETE", "/api/sessions/:id/review/annotations/:annotationId", handleReviewAnnotationDeleteOne);
	table.register("GET", "/api/sessions/:id/review/submitted", handleReviewSubmittedGet);
	table.register("PUT", "/api/sessions/:id/review/submitted", handleReviewSubmittedPut);
}
