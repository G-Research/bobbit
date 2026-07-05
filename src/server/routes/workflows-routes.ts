// src/server/routes/workflows-routes.ts
//
// STR-01 cohort 6: the workflows family — GET/POST /api/workflows,
// POST /api/workflows/:id/customize, DELETE /api/workflows/:id/override,
// GET/PUT/DELETE /api/workflows/:id — migrated out of handleApiRoute's
// legacy if/else chain into the core route registry. See
// docs/design/route-registry.md (cohorts 1-5 established the seam +
// protocol).
//
// Mechanical extraction — every handler body below is byte-for-byte the same
// logic as the corresponding `if (workflow*Match && req.method === ...)`
// block it replaced in server.ts, with only the following mechanical
// substitutions:
//   - `url.pathname.match(...)[1]` → the registry's named `params.id`.
//   - free variables that used to be handleApiRoute's own params/closures
//     (json, jsonError, readBody, configCascade, projectContextManager) are
//     destructured from `ctx`.
// Zero behavior change: same validation, same status codes, same error
// shapes. No new CoreRouteCtx fields needed — configCascade and
// projectContextManager were already threaded through by cohort 1/2.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed (cohort 5's
// shape, not cohort 2/4's). `/api/workflows` and `/api/workflows/:id` each
// gate on the path match AND the method in the SAME `if` condition, with no
// shared pre-branch resolution step (unlike project-config's path-first
// project lookup) — a method mismatch never entered any block, falling
// straight through to the same generic terminal 404 any unmatched path
// would hit. `RouteTable`'s `:param` entries are method-scoped the same way,
// so leaving other methods unregistered on these path shapes reproduces that
// fall-through exactly. `/api/workflows/:id/customize` (POST-only) and
// `/api/workflows/:id/override` (DELETE-only) never had any other method
// registered in the legacy chain either.

import type { RouteTable } from "./route-table.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";

// GET /api/workflows — a missing projectId returns an empty list (there is no
// server-scope workflow set); a projectId returns that project's workflows.
async function handleWorkflowsList(ctx: CoreRouteCtx): Promise<void> {
	const { url, json, configCascade } = ctx;
	const projectId = url.searchParams.get("projectId") || undefined;
	const resolved = configCascade.resolveWorkflows(projectId);
	json({ workflows: resolved.map(r => ({ ...r.item, origin: r.origin, ...(r.overrides ? { overrides: r.overrides } : {}) })) });
}

// POST /api/workflows — requires projectId.
async function handleWorkflowsCreate(ctx: CoreRouteCtx): Promise<void> {
	const { json, jsonError, readBody, req, projectContextManager } = ctx;
	const body = await readBody(req);
	if (!body) { json({ error: "Missing body" }, 400); return; }
	const targetProjectId = body?.projectId;
	if (!targetProjectId) { json({ error: "projectId required" }, 400); return; }
	try {
		const c = projectContextManager.getOrCreate(targetProjectId);
		if (!c) { json({ error: "Project not found" }, 404); return; }
		const now = Date.now();
		const workflow = {
			id: body.id as string,
			name: (body.name as string) ?? body.id,
			description: (body.description as string) ?? "",
			gates: body.gates || [],
			createdAt: now,
			updatedAt: now,
		};
		if (!workflow.id || typeof workflow.id !== "string") throw new Error("Missing id");
		c.workflowStore.put(workflow);
		json(workflow, 201);
	} catch (err: any) {
		jsonError(400, err);
	}
}

// POST /api/workflows/:id/customize — copy resolved workflow into a project.
async function handleWorkflowCustomize(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, configCascade, projectContextManager } = ctx;
	const id = decodeURIComponent(params.id);
	const projectId = url.searchParams.get("projectId") || undefined;
	if (!projectId) { json({ error: "projectId required" }, 400); return; }

	const resolved = configCascade.resolveWorkflows(projectId);
	const source = resolved.find(r => r.item.id === id);
	if (!source) { json({ error: "Workflow not found" }, 404); return; }

	const c = projectContextManager.getOrCreate(projectId);
	if (!c) { json({ error: "Project not found" }, 404); return; }

	const now = Date.now();
	const copy = { ...source.item, createdAt: now, updatedAt: now };
	c.workflowStore.put(copy);
	json(copy, 201);
}

// DELETE /api/workflows/:id/override — remove project-level override.
async function handleWorkflowOverrideDelete(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, projectContextManager } = ctx;
	const id = decodeURIComponent(params.id);
	const projectId = url.searchParams.get("projectId") || undefined;
	if (!projectId) { json({ error: "projectId required" }, 400); return; }

	const c = projectContextManager.getOrCreate(projectId);
	if (!c) { json({ error: "Project not found" }, 404); return; }

	c.workflowStore.remove(id);
	json({ ok: true });
}

// GET /api/workflows/:id
async function handleWorkflowGet(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, configCascade } = ctx;
	const id = decodeURIComponent(params.id);
	const qProjectId = url.searchParams.get("projectId") || undefined;
	if (!qProjectId) { json({ error: "Workflow not found" }, 404); return; }
	const resolved = configCascade.resolveWorkflows(qProjectId);
	const found = resolved.find(r => r.item.id === id);
	if (!found) { json({ error: "Workflow not found" }, 404); return; }
	json({ ...found.item, origin: found.origin, ...(found.overrides ? { overrides: found.overrides } : {}) });
}

// PUT /api/workflows/:id — requires projectId.
async function handleWorkflowPut(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, readBody, req, projectContextManager } = ctx;
	const id = decodeURIComponent(params.id);
	const body = await readBody(req);
	if (!body) { json({ error: "Missing body" }, 400); return; }
	const qProjectId = url.searchParams.get("projectId") || undefined;
	if (!qProjectId) { json({ error: "projectId required" }, 400); return; }
	const c = projectContextManager.getOrCreate(qProjectId);
	if (!c) { json({ error: "Project not found" }, 404); return; }
	const existing = c.workflowStore.get(id);
	if (!existing) { json({ error: "Workflow not found in project" }, 404); return; }
	const updated = {
		...existing,
		name: body.name ?? existing.name,
		description: body.description ?? existing.description,
		gates: Array.isArray(body.gates) ? body.gates : existing.gates,
		id,
		updatedAt: Date.now(),
	};
	c.workflowStore.put(updated);
	json(updated);
}

// DELETE /api/workflows/:id — requires projectId.
async function handleWorkflowDelete(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, projectContextManager } = ctx;
	const id = decodeURIComponent(params.id);
	const qProjectId = url.searchParams.get("projectId") || undefined;
	if (!qProjectId) { json({ error: "projectId required" }, 400); return; }
	const c = projectContextManager.getOrCreate(qProjectId);
	if (!c) { json({ error: "Project not found" }, 404); return; }
	c.workflowStore.remove(id);
	json({ ok: true });
}

export function registerWorkflowsRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/workflows", handleWorkflowsList);
	table.register("POST", "/api/workflows", handleWorkflowsCreate);
	table.register("POST", "/api/workflows/:id/customize", handleWorkflowCustomize);
	table.register("DELETE", "/api/workflows/:id/override", handleWorkflowOverrideDelete);
	table.register("GET", "/api/workflows/:id", handleWorkflowGet);
	table.register("PUT", "/api/workflows/:id", handleWorkflowPut);
	table.register("DELETE", "/api/workflows/:id", handleWorkflowDelete);
}
