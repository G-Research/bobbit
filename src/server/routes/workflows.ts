/**
 * Project-scoped workflows CRUD + customize/override.
 * Extracted from server.ts (commit: split server.ts).
 */
import type { Route } from "./types.js";

export const workflowsRoutes: Route[] = [
	{
		method: "GET",
		pattern: "/api/workflows",
		handler: ({ deps, url, json }) => {
			const projectId = url.searchParams.get("projectId") || undefined;
			const resolved = deps.configCascade.resolveWorkflows(projectId);
			json({ workflows: resolved.map(r => ({ ...r.item, origin: r.origin, ...(r.overrides ? { overrides: r.overrides } : {}) })) });
		},
	},
	{
		method: "POST",
		pattern: "/api/workflows",
		handler: async ({ deps, readBody, json, jsonError }) => {
			const body = await readBody();
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const targetProjectId = body?.projectId;
			if (!targetProjectId) { json({ error: "projectId required" }, 400); return; }
			try {
				const ctx = deps.projectContextManager.getOrCreate(targetProjectId);
				if (!ctx) { json({ error: "Project not found" }, 404); return; }
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
				ctx.workflowStore.put(workflow);
				json(workflow, 201);
			} catch (err: any) {
				jsonError(400, err);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/workflows\/([^/]+)\/customize$/,
		handler: ({ deps, params, url, json }) => {
			const id = decodeURIComponent(params[1]);
			const projectId = url.searchParams.get("projectId") || undefined;
			if (!projectId) { json({ error: "projectId required" }, 400); return; }

			const resolved = deps.configCascade.resolveWorkflows(projectId);
			const source = resolved.find(r => r.item.id === id);
			if (!source) { json({ error: "Workflow not found" }, 404); return; }

			const ctx = deps.projectContextManager.getOrCreate(projectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }

			const now = Date.now();
			const copy = { ...source.item, createdAt: now, updatedAt: now };
			ctx.workflowStore.put(copy);
			json(copy, 201);
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/workflows\/([^/]+)\/override$/,
		handler: ({ deps, params, url, json }) => {
			const id = decodeURIComponent(params[1]);
			const projectId = url.searchParams.get("projectId") || undefined;
			if (!projectId) { json({ error: "projectId required" }, 400); return; }

			const ctx = deps.projectContextManager.getOrCreate(projectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }

			ctx.workflowStore.remove(id);
			json({ ok: true });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/workflows\/([^/]+)$/,
		handler: ({ deps, params, url, json }) => {
			const id = decodeURIComponent(params[1]);
			const qProjectId = url.searchParams.get("projectId") || undefined;
			if (!qProjectId) { json({ error: "Workflow not found" }, 404); return; }
			const resolved = deps.configCascade.resolveWorkflows(qProjectId);
			const found = resolved.find(r => r.item.id === id);
			if (!found) { json({ error: "Workflow not found" }, 404); return; }
			json({ ...found.item, origin: found.origin, ...(found.overrides ? { overrides: found.overrides } : {}) });
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/workflows\/([^/]+)$/,
		handler: async ({ deps, params, url, readBody, json }) => {
			const id = decodeURIComponent(params[1]);
			const body = await readBody();
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const qProjectId = url.searchParams.get("projectId") || undefined;
			if (!qProjectId) { json({ error: "projectId required" }, 400); return; }
			const ctx = deps.projectContextManager.getOrCreate(qProjectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			const existing = ctx.workflowStore.get(id);
			if (!existing) { json({ error: "Workflow not found in project" }, 404); return; }
			const updated = {
				...existing,
				name: body.name ?? existing.name,
				description: body.description ?? existing.description,
				gates: Array.isArray(body.gates) ? body.gates : existing.gates,
				id,
				updatedAt: Date.now(),
			};
			ctx.workflowStore.put(updated);
			json(updated);
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/workflows\/([^/]+)$/,
		handler: ({ deps, params, url, json }) => {
			const id = decodeURIComponent(params[1]);
			const qProjectId = url.searchParams.get("projectId") || undefined;
			if (!qProjectId) { json({ error: "projectId required" }, 400); return; }
			const ctx = deps.projectContextManager.getOrCreate(qProjectId);
			if (!ctx) { json({ error: "Project not found" }, 404); return; }
			ctx.workflowStore.remove(id);
			json({ ok: true });
		},
	},
];
