/**
 * Roles + assistant prompts CRUD + customize/override.
 * Extracted from server.ts (commit: split server.ts).
 */
import type { GrantPolicy } from "../agent/role-store.js";
import type { Route } from "./types.js";

const VALID_POLICIES = new Set(['allow', 'ask', 'never', 'always-allow', 'ask-once', 'always-ask', 'never-ask']);

export const rolesRoutes: Route[] = [
	{
		method: "GET",
		pattern: "/api/roles/assistant/prompts",
		handler: async ({ json }) => {
			const { ASSISTANT_REGISTRY } = await import("../agent/assistant-registry.js");
			const prompts = Object.values(ASSISTANT_REGISTRY).map((def) => ({
				type: def.type,
				title: def.title,
				promptTitle: def.promptTitle,
				prompt: def.prompt,
			}));
			json({ prompts });
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/roles\/assistant\/prompts\/(.+)$/,
		handler: async ({ params, readBody, json }) => {
			const type = decodeURIComponent(params[1]);
			if (!type) {
				json({ error: "Missing type parameter" }, 400);
				return;
			}
			const body = await readBody();
			const { updateAssistantDef } = await import("../agent/assistant-registry.js");
			const updated = updateAssistantDef(type, {
				prompt: body?.prompt,
				title: body?.title,
				promptTitle: body?.promptTitle,
			});
			if (!updated) {
				json({ error: `Unknown assistant type: ${type}` }, 404);
				return;
			}
			json(updated);
		},
	},
	{
		method: "GET",
		pattern: "/api/roles",
		handler: ({ deps, url, json }) => {
			const projectId = url.searchParams.get("projectId") || undefined;
			const resolved = deps.configCascade.resolveRoles(projectId);
			json({ roles: resolved.map(r => ({ ...r.item, origin: r.origin, ...(r.overrides ? { overrides: r.overrides } : {}) })) });
		},
	},
	{
		method: "POST",
		pattern: "/api/roles",
		handler: async ({ deps, readBody, json, jsonError }) => {
			const body = await readBody();
			const targetProjectId = body?.projectId;
			try {
				if (targetProjectId) {
					const ctx = deps.projectContextManager.getOrCreate(targetProjectId);
					if (!ctx) { json({ error: "Project not found" }, 404); return; }
					const now = Date.now();
					const role = {
						name: body?.name,
						label: body?.label ?? body?.name,
						promptTemplate: body?.promptTemplate || "",
						accessory: body?.accessory ?? "none",
						toolPolicies: body?.toolPolicies,
						model: typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined,
						thinkingLevel: typeof body?.thinkingLevel === "string" && body.thinkingLevel.trim() ? body.thinkingLevel.trim() : undefined,
						createdAt: now,
						updatedAt: now,
					};
					if (!role.name || typeof role.name !== "string") throw new Error("Missing name");
					const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
					if (!NAME_PATTERN.test(role.name)) throw new Error("Role name must be lowercase alphanumeric + hyphens");
					ctx.roleStore.put(role);
					json(role, 201);
				} else {
					const role = deps.roleManager.createRole({
						name: body?.name,
						label: body?.label,
						promptTemplate: body?.promptTemplate || "",
						accessory: body?.accessory,
						toolPolicies: body?.toolPolicies,
						model: typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined,
						thinkingLevel: typeof body?.thinkingLevel === "string" && body.thinkingLevel.trim() ? body.thinkingLevel.trim() : undefined,
					});
					json(role, 201);
				}
			} catch (err: any) {
				jsonError(400, err);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/roles\/([^/]+)\/customize$/,
		handler: ({ deps, params, url, json }) => {
			const name = decodeURIComponent(params[1]);
			const scope = url.searchParams.get("scope") || "server";
			const projectId = url.searchParams.get("projectId") || undefined;

			const resolved = deps.configCascade.resolveRoles(projectId);
			const source = resolved.find(r => r.item.name === name);
			if (!source) { json({ error: "Role not found" }, 404); return; }

			let targetStore;
			if (scope === "project") {
				if (!projectId) { json({ error: "projectId required for project scope" }, 400); return; }
				const ctx = deps.projectContextManager.getOrCreate(projectId);
				if (!ctx) { json({ error: "Project not found" }, 404); return; }
				targetStore = ctx.roleStore;
			} else {
				targetStore = deps.roleStore;
			}

			const now = Date.now();
			const copy = { ...source.item, createdAt: now, updatedAt: now };
			targetStore.put(copy);
			json(copy, 201);
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/roles\/([^/]+)\/override$/,
		handler: ({ deps, params, url, json }) => {
			const name = decodeURIComponent(params[1]);
			const scope = url.searchParams.get("scope") || "server";
			const projectId = url.searchParams.get("projectId") || undefined;

			let targetStore;
			if (scope === "project") {
				if (!projectId) { json({ error: "projectId required for project scope" }, 400); return; }
				const ctx = deps.projectContextManager.getOrCreate(projectId);
				if (!ctx) { json({ error: "Project not found" }, 404); return; }
				targetStore = ctx.roleStore;
			} else {
				targetStore = deps.roleStore;
			}

			targetStore.remove(name);
			json({ ok: true });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/roles\/([^/]+)$/,
		handler: ({ deps, params, url, json }) => {
			const name = decodeURIComponent(params[1]);
			const qProjectId = url.searchParams.get("projectId") || undefined;
			if (qProjectId) {
				const resolved = deps.configCascade.resolveRoles(qProjectId);
				const found = resolved.find(r => r.item.name === name);
				if (!found) { json({ error: "Role not found" }, 404); return; }
				json({ ...found.item, origin: found.origin, ...(found.overrides ? { overrides: found.overrides } : {}) });
			} else {
				const role = deps.roleManager.getRole(name);
				if (!role) { json({ error: "Role not found" }, 404); return; }
				json(role);
			}
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/roles\/([^/]+)$/,
		handler: async ({ deps, params, url, readBody, json }) => {
			const name = decodeURIComponent(params[1]);
			const body = await readBody();
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const qProjectId = url.searchParams.get("projectId") || undefined;
			if (qProjectId) {
				const ctx = deps.projectContextManager.getOrCreate(qProjectId);
				if (!ctx) { json({ error: "Project not found" }, 404); return; }
				const existing = ctx.roleStore.get(name);
				if (!existing) { json({ error: "Role not found in project" }, 404); return; }
				let toolPolicies = existing.toolPolicies;
				if (body.toolPolicies !== undefined) {
					const cleaned: Record<string, any> = {};
					if (body.toolPolicies && typeof body.toolPolicies === 'object') {
						for (const [k, v] of Object.entries(body.toolPolicies)) {
							if (typeof v === 'string' && VALID_POLICIES.has(v)) cleaned[k] = v;
						}
					}
					toolPolicies = cleaned;
				}
				let model = existing.model;
				if (body.model !== undefined) {
					model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
				}
				let thinkingLevel = existing.thinkingLevel;
				if (body.thinkingLevel !== undefined) {
					thinkingLevel = typeof body.thinkingLevel === "string" && body.thinkingLevel.trim() ? body.thinkingLevel.trim() : undefined;
				}
				const updated = {
					...existing,
					label: body.label ?? existing.label,
					promptTemplate: body.promptTemplate ?? existing.promptTemplate,
					accessory: body.accessory ?? existing.accessory,
					toolPolicies,
					model,
					thinkingLevel,
					name,
					updatedAt: Date.now(),
				};
				ctx.roleStore.put(updated);
				json({ ok: true });
			} else {
				const modelUpdate = body.model !== undefined
					? (typeof body.model === "string" && body.model.trim() ? body.model.trim() : "")
					: undefined;
				const thinkingUpdate = body.thinkingLevel !== undefined
					? (typeof body.thinkingLevel === "string" && body.thinkingLevel.trim() ? body.thinkingLevel.trim() : "")
					: undefined;
				if (modelUpdate !== undefined || thinkingUpdate !== undefined) {
					const existing = deps.roleManager.getRole(name);
					if (existing) {
						const patched = {
							...existing,
							model: modelUpdate !== undefined ? (modelUpdate || undefined) : existing.model,
							thinkingLevel: thinkingUpdate !== undefined ? (thinkingUpdate || undefined) : existing.thinkingLevel,
							updatedAt: Date.now(),
						};
						deps.roleStore.put(patched);
					}
				}
				const ok = deps.roleManager.updateRole(name, {
					label: body.label,
					promptTemplate: body.promptTemplate,
					accessory: body.accessory,
					toolPolicies: body.toolPolicies !== undefined ? (() => {
						const cleaned: Record<string, GrantPolicy> = {};
						if (body.toolPolicies && typeof body.toolPolicies === 'object') {
							for (const [k, v] of Object.entries(body.toolPolicies)) {
								if (typeof v === 'string' && VALID_POLICIES.has(v)) cleaned[k] = v as GrantPolicy;
							}
						}
						return cleaned;
					})() : undefined,
				});
				if (!ok) { json({ error: "Role not found" }, 404); return; }
				json({ ok: true });
			}
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/roles\/([^/]+)$/,
		handler: ({ deps, params, url, json }) => {
			const name = decodeURIComponent(params[1]);
			const qProjectId = url.searchParams.get("projectId") || undefined;
			if (qProjectId) {
				const ctx = deps.projectContextManager.getOrCreate(qProjectId);
				if (!ctx) { json({ error: "Project not found" }, 404); return; }
				ctx.roleStore.remove(name);
				json({ ok: true });
			} else {
				const ok = deps.roleManager.deleteRole(name);
				if (!ok) { json({ error: "Role not found" }, 404); return; }
				json({ ok: true });
			}
		},
	},
];
