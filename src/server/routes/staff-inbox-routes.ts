// src/server/routes/staff-inbox-routes.ts
//
// STR-01 cohort 5: the staff-inbox family — GET/POST /api/staff/:id/inbox,
// POST /api/staff/:id/inbox/:entryId/complete,
// POST /api/staff/:id/inbox/:entryId/dismiss,
// DELETE /api/staff/:id/inbox/:entryId — migrated out of handleApiRoute's
// legacy if/else chain into the core route registry. See
// docs/design/route-registry.md (cohorts 1-4 established the seam +
// protocol).
//
// Mechanical extraction — every handler body below is byte-for-byte the same
// logic as the corresponding `if (staffInbox*Match && req.method === ...)`
// block it replaced in server.ts, with only the following mechanical
// substitutions:
//   - `url.pathname.match(...)[1]` (etc.) → the registry's named `params.id`
//     / `params.entryId`.
//   - free variables that used to be handleApiRoute's own params/closures
//     (json, jsonError, readBody, sessionManager, staffManager,
//     inboxManager) are destructured from `ctx`.
// Zero behavior change: same auth (handled upstream of handleApiRoute,
// untouched), same validation, same status codes, same error shapes.
//
// LEGACY FALL-THROUGH PARITY: unlike cohort 2 (project-config), this family
// needs NO unhandled-method shim. Every legacy block here gated on BOTH the
// path regex AND the method in the SAME `if` condition (e.g.
// `if (staffInboxListMatch && req.method === "GET")`) — a method mismatch
// never entered the block at all, so it fell straight through to the same
// generic terminal 404 any unmatched path would hit (no
// resolve-then-branch-on-method structure to reproduce, unlike
// project-config's path-first matching). A `RouteTable` param entry is
// method-scoped the same way (`match()` filters candidates by method before
// testing the regex), so leaving other methods unregistered on these path
// shapes reproduces that fall-through exactly: no match here, continue into
// the (now shorter) legacy chain, same terminal 404.
//
// NOT migrated in this cohort: the rest of the `/api/staff*` family (list,
// create, get/patch/put/delete by :id) — its own larger review unit (project
// reassignment, worktree/sandbox provisioning, role-cascade validation) and
// not needed for this narrowly-scoped inbox cohort; the deprecated
// `GET /api/staff/:id/sessions` 410 stub (unrelated single-line shim,
// lexically adjacent but not part of the inbox family; left alone rather
// than folded in for an unrelated reason).

import type { RouteTable } from "./route-table.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { InboxEntry } from "../agent/inbox-manager.js";

// GET /api/staff/:id/inbox?state=pending&limit=50
async function handleStaffInboxList(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, staffManager, inboxManager } = ctx;
	const id = params.id;
	if (!inboxManager) { json({ error: "Inbox not initialised" }, 500); return; }
	const staff = staffManager.getStaff(id);
	if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
	const rawState = url.searchParams.get("state");
	const allowedStates: ReadonlyArray<InboxEntry["state"]> = ["pending", "completed", "failed", "cancelled"];
	const state = rawState && (allowedStates as readonly string[]).includes(rawState)
		? (rawState as InboxEntry["state"])
		: undefined;
	const limitRaw = url.searchParams.get("limit");
	const limit = limitRaw != null ? Math.max(0, parseInt(limitRaw, 10) || 0) : undefined;
	const entries = inboxManager.listForStaff(id, state, limit);
	json({ entries });
}

// POST /api/staff/:id/inbox
async function handleStaffInboxCreate(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, readBody, req, staffManager, inboxManager } = ctx;
	const id = params.id;
	if (!inboxManager) { json({ error: "Inbox not initialised" }, 500); return; }
	const staff = staffManager.getStaff(id);
	if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
	const body = await readBody(req);
	if (!body || typeof body.title !== "string" || !body.title.trim()) {
		json({ error: "Missing title" }, 400);
		return;
	}
	if (typeof body.prompt !== "string" || !body.prompt.trim()) {
		json({ error: "Missing prompt" }, 400);
		return;
	}
	const sourceType = body.source?.type === "manual_ui" || body.source?.type === "trigger"
		? body.source.type
		: "manual_api";
	const actorId = typeof body.source?.actorId === "string" ? body.source.actorId : undefined;
	try {
		const entry = inboxManager.enqueue(id, {
			title: body.title,
			prompt: body.prompt,
			context: typeof body.context === "string" ? body.context : undefined,
			source: { type: sourceType, actorId },
		});
		json({ entry }, 201);
	} catch (err) {
		jsonError(400, err);
	}
}

// POST /api/staff/:id/inbox/:entryId/complete
async function handleStaffInboxComplete(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, readBody, req, sessionManager, staffManager, inboxManager } = ctx;
	const { id, entryId } = params;
	if (!inboxManager) { json({ error: "Inbox not initialised" }, 500); return; }
	const staff = staffManager.getStaff(id);
	if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
	const body = await readBody(req);
	if (!body || typeof body.sessionId !== "string" || !body.sessionId) {
		json({ error: "Missing sessionId" }, 400);
		return;
	}
	const session = sessionManager.getSession(body.sessionId);
	if (!session || session.staffId !== id) {
		json({ error: "Forbidden: session does not belong to this staff" }, 403);
		return;
	}
	const existing = inboxManager.listForStaff(id).find(e => e.id === entryId);
	if (!existing) { json({ error: "Inbox entry not found" }, 404); return; }
	if (existing.state !== "pending") {
		json({ error: `Inbox entry ${entryId} is ${existing.state}, expected pending` }, 409);
		return;
	}
	try {
		const entry = inboxManager.transitionToCompleted(id, entryId, typeof body.summary === "string" ? body.summary : undefined);
		json({ entry });
	} catch (err) {
		jsonError(400, err);
	}
}

// POST /api/staff/:id/inbox/:entryId/dismiss
async function handleStaffInboxDismiss(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, readBody, req, sessionManager, staffManager, inboxManager } = ctx;
	const { id, entryId } = params;
	if (!inboxManager) { json({ error: "Inbox not initialised" }, 500); return; }
	const staff = staffManager.getStaff(id);
	if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
	const body = await readBody(req);
	if (!body || typeof body.sessionId !== "string" || !body.sessionId) {
		json({ error: "Missing sessionId" }, 400);
		return;
	}
	const session = sessionManager.getSession(body.sessionId);
	if (!session || session.staffId !== id) {
		json({ error: "Forbidden: session does not belong to this staff" }, 403);
		return;
	}
	if (body.outcome !== "failed" && body.outcome !== "cancelled") {
		json({ error: "outcome must be 'failed' or 'cancelled'" }, 400);
		return;
	}
	if (typeof body.reason !== "string" || !body.reason.trim()) {
		json({ error: "Missing reason" }, 400);
		return;
	}
	const existing = inboxManager.listForStaff(id).find(e => e.id === entryId);
	if (!existing) { json({ error: "Inbox entry not found" }, 404); return; }
	if (existing.state !== "pending") {
		json({ error: `Inbox entry ${entryId} is ${existing.state}, expected pending` }, 409);
		return;
	}
	try {
		const entry = inboxManager.transitionToTerminal(id, entryId, body.outcome, body.reason);
		json({ entry });
	} catch (err) {
		jsonError(400, err);
	}
}

// DELETE /api/staff/:id/inbox/:entryId
async function handleStaffInboxDelete(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, staffManager, inboxManager } = ctx;
	const { id, entryId } = params;
	if (!inboxManager) { json({ error: "Inbox not initialised" }, 500); return; }
	const staff = staffManager.getStaff(id);
	if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
	const ok = inboxManager.remove(id, entryId);
	if (!ok) { json({ error: "Inbox entry not found" }, 404); return; }
	json({ ok: true });
}

export function registerStaffInboxRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/staff/:id/inbox", handleStaffInboxList);
	table.register("POST", "/api/staff/:id/inbox", handleStaffInboxCreate);
	table.register("POST", "/api/staff/:id/inbox/:entryId/complete", handleStaffInboxComplete);
	table.register("POST", "/api/staff/:id/inbox/:entryId/dismiss", handleStaffInboxDismiss);
	table.register("DELETE", "/api/staff/:id/inbox/:entryId", handleStaffInboxDelete);
}
