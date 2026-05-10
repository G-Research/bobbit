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
			if (!body) { jsonError(400, new Error("Missing body")); return; }
			const targetProjectId = body?.projectId;
			if (!targetProjectId) { jsonError(400, new Error("projectId required")); return; }
			try {
				const ctx = deps.projectContextManager.getOrCreate(targetProjectId);
				if (!ctx) { jsonError(404, new Error("Project not found")); return; }
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
		handler: ({ deps, params, url, json, jsonError }) => {
			const id = decodeURIComponent(params[1]);
			const projectId = url.searchParams.get("projectId") || undefined;
			if (!projectId) { jsonError(400, new Error("projectId required")); return; }

			const resolved = deps.configCascade.resolveWorkflows(projectId);
			const source = resolved.find(r => r.item.id === id);
			if (!source) { jsonError(404, new Error("Workflow not found")); return; }

			const ctx = deps.projectContextManager.getOrCreate(projectId);
			if (!ctx) { jsonError(404, new Error("Project not found")); return; }

			const now = Date.now();
			const copy = { ...source.item, createdAt: now, updatedAt: now };
			ctx.workflowStore.put(copy);
			json(copy, 201);
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/workflows\/([^/]+)\/override$/,
		handler: ({ deps, params, url, json, jsonError }) => {
			const id = decodeURIComponent(params[1]);
			const projectId = url.searchParams.get("projectId") || undefined;
			if (!projectId) { jsonError(400, new Error("projectId required")); return; }

			const ctx = deps.projectContextManager.getOrCreate(projectId);
			if (!ctx) { jsonError(404, new Error("Project not found")); return; }

			ctx.workflowStore.remove(id);
			json({ ok: true });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/workflows\/([^/]+)$/,
		handler: ({ deps, params, url, json, jsonError }) => {
			const id = decodeURIComponent(params[1]);
			const qProjectId = url.searchParams.get("projectId") || undefined;
			if (!qProjectId) { jsonError(404, new Error("Workflow not found")); return; }
			const resolved = deps.configCascade.resolveWorkflows(qProjectId);
			const found = resolved.find(r => r.item.id === id);
			if (!found) { jsonError(404, new Error("Workflow not found")); return; }
			json({ ...found.item, origin: found.origin, ...(found.overrides ? { overrides: found.overrides } : {}) });
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/workflows\/([^/]+)$/,
		handler: async ({ deps, params, url, readBody, json, jsonError }) => {
			const id = decodeURIComponent(params[1]);
			const body = await readBody();
			if (!body) { jsonError(400, new Error("Missing body")); return; }
			const qProjectId = url.searchParams.get("projectId") || undefined;
			if (!qProjectId) { jsonError(400, new Error("projectId required")); return; }
			const ctx = deps.projectContextManager.getOrCreate(qProjectId);
			if (!ctx) { jsonError(404, new Error("Project not found")); return; }
			const existing = ctx.workflowStore.get(id);
			if (!existing) { jsonError(404, new Error("Workflow not found in project")); return; }
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
		handler: ({ deps, params, url, json, jsonError }) => {
			const id = decodeURIComponent(params[1]);
			const qProjectId = url.searchParams.get("projectId") || undefined;
			if (!qProjectId) { jsonError(400, new Error("projectId required")); return; }
			const ctx = deps.projectContextManager.getOrCreate(qProjectId);
			if (!ctx) { jsonError(404, new Error("Project not found")); return; }
			ctx.workflowStore.remove(id);
			json({ ok: true });
		},
	},
];
