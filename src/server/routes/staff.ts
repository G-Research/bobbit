/**
 * Staff agents CRUD + wake + (deprecated) sessions.
 * Extracted from server.ts (commit: split server.ts).
 */
import { resolveProjectForRequest } from "../agent/resolve-project.js";
import type { Route } from "./types.js";

export const staffRoutes: Route[] = [
	{
		method: "GET",
		pattern: "/api/staff",
		handler: ({ deps, url, json }) => {
			const projectId = url.searchParams.get("projectId") || undefined;
			const list = deps.staffManager.listStaff(projectId).map(s => {
				const sandboxed = s.projectId ? (deps.projectContextManager.getOrCreate(s.projectId)?.projectConfigStore.get("sandbox") === "docker") : false;
				return { ...s, sandboxed };
			});
			json({ staff: list });
		},
	},
	{
		method: "POST",
		pattern: "/api/staff",
		handler: async ({ deps, readBody, json, jsonError }) => {
			const body = await readBody();
			if (!body?.name || typeof body.name !== "string") {
				jsonError(400, new Error("Missing name"));
				return;
			}
			if (!body?.systemPrompt || typeof body.systemPrompt !== "string") {
				jsonError(400, new Error("Missing systemPrompt"));
				return;
			}
			const cwd = body.cwd || deps.config.defaultCwd;
			const resolved = resolveProjectForRequest(deps.projectRegistry, deps.projectContextManager, { projectId: body.projectId, cwd });
			if (!resolved.ok) {
				jsonError(resolved.status, new Error(resolved.error));
				return;
			}
			const projectId = resolved.projectId;
			try {
				const staff = await deps.staffManager.createStaff(
					body.name,
					body.description || "",
					body.systemPrompt,
					cwd,
					deps.sessionManager,
					{ triggers: body.triggers, roleId: body.roleId, projectId, sandboxed: body.sandboxed },
				);
				json(staff, 201);
			} catch (err: any) {
				console.error("[server] Failed to create staff agent:", err);
				jsonError(500, err);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/staff\/([^/]+)\/wake$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const id = params[1];
			const staff = deps.staffManager.getStaff(id);
			if (!staff) { jsonError(404, new Error("Staff agent not found")); return; }
			const body = await readBody();
			try {
				const sessionId = await deps.staffManager.wake(id, body?.prompt, deps.sessionManager);
				json({ sessionId }, 201);
			} catch (err) {
				jsonError(400, err);
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/staff\/([^/]+)\/sessions$/,
		handler: ({ jsonError }) => {
			jsonError(410, new Error("Deprecated. Staff agents have a single permanent session. Use GET /api/staff/:id."));
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/staff\/([^/]+)$/,
		handler: ({ deps, params, json, jsonError }) => {
			const id = params[1];
			const staff = deps.staffManager.getStaff(id);
			if (!staff) { jsonError(404, new Error("Staff agent not found")); return; }
			const sandboxed = staff.projectId ? (deps.projectContextManager.getOrCreate(staff.projectId)?.projectConfigStore.get("sandbox") === "docker") : false;
			json({ ...staff, sandboxed });
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/staff\/([^/]+)$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const id = params[1];
			const body = await readBody();
			if (!body) { jsonError(400, new Error("Missing body")); return; }
			const ok = deps.staffManager.updateStaff(id, {
				name: body.name,
				description: body.description,
				systemPrompt: body.systemPrompt,
				cwd: body.cwd,
				state: body.state,
				triggers: body.triggers,
				memory: body.memory,
				roleId: body.roleId,
			});
			if (!ok) { jsonError(404, new Error("Staff agent not found")); return; }
			json(deps.staffManager.getStaff(id));
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/staff\/([^/]+)$/,
		handler: async ({ deps, params, json, jsonError }) => {
			const id = params[1];
			const ok = await deps.staffManager.deleteStaff(id, deps.sessionManager);
			if (!ok) { jsonError(404, new Error("Staff agent not found")); return; }
			json({ ok: true });
		},
	},
];
