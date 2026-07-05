// src/server/routes/roles-routes.ts
//
// STR-05: roles routes migrated out of handleApiRoute's legacy if/else chain
// into the core route registry. See docs/design/route-registry.md.
//
// Mechanical extraction: handler bodies preserve the legacy behavior, with
// handleApiRoute locals destructured from ctx.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. The assistant
// prompt update route was a PUT-only startsWith guard, represented here as a
// method-scoped prefix route. The role :name block was path-first, but only did
// work inside method-specific branches; unregistered methods still fall through
// to the terminal legacy 404.

import type { GrantPolicy, RoleStore } from "../agent/role-store.js";
import type { RoleManager } from "../agent/role-manager.js";
import type { RequiredConfigProjectScopeError, CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

type RoleMutationTarget =
	| { scope: "server"; store: RoleStore; manager: RoleManager }
	| { scope: "project"; store: RoleStore; projectId: string };

function withOrigin(r: { item: Record<string, unknown>; origin: unknown; overrides?: unknown; originPackId?: string | null; originPackName?: string | null }): Record<string, unknown> {
	return {
		...r.item,
		origin: r.origin,
		...(r.overrides ? { overrides: r.overrides } : {}),
		originPackId: r.originPackId ?? null,
		originPackName: r.originPackName ?? null,
	};
}

function withRoleResolution(
	ctx: CoreRouteCtx,
	r: { item: Record<string, unknown>; origin: unknown; overrides?: unknown; originPackId?: string | null; originPackName?: string | null },
	projectId?: string,
): Record<string, unknown> {
	return {
		...withOrigin(r),
		modelResolution: ctx.configCascade.resolveRoleModelResolution(String(r.item.name), projectId),
	};
}

function resolveRoleMutationTarget(ctx: CoreRouteCtx, rawProjectId: unknown): { ok: true; target: RoleMutationTarget } | RequiredConfigProjectScopeError {
	const resolved = ctx.resolveRequiredConfigProjectScope(rawProjectId, { aliasSystem: true });
	if (!resolved.ok) return resolved;
	if (!resolved.effectiveProjectId) return { ok: true, target: { scope: "server", store: ctx.serverRoleStore, manager: ctx.roleManager } };
	if (!resolved.context) return { ok: false, status: 404, error: `Project not found: ${resolved.effectiveProjectId}`, code: "PROJECT_NOT_FOUND" };
	return { ok: true, target: { scope: "project", store: resolved.context.roleStore, projectId: resolved.effectiveProjectId } };
}

function cleanToolPolicies(raw: unknown): Record<string, GrantPolicy> {
	const validPolicies = new Set(["allow", "ask", "never", "always-allow", "ask-once", "always-ask", "never-ask"]);
	const cleaned: Record<string, GrantPolicy> = {};
	if (raw && typeof raw === "object") {
		for (const [k, v] of Object.entries(raw)) {
			if (typeof v === "string" && validPolicies.has(v)) cleaned[k] = v as GrantPolicy;
		}
	}
	return cleaned;
}

async function handleAssistantPromptsGet(ctx: CoreRouteCtx): Promise<void> {
	const { json } = ctx;
	const { ASSISTANT_REGISTRY } = await import("../agent/assistant-registry.js");
	const prompts = Object.values(ASSISTANT_REGISTRY).map((def) => ({
		type: def.type,
		title: def.title,
		promptTitle: def.promptTitle,
		prompt: def.prompt,
	}));
	json({ prompts });
	return;
}

async function handleAssistantPromptPut(ctx: CoreRouteCtx): Promise<void> {
	const { req, url, json, readBody } = ctx;
	const type = url.pathname.slice("/api/roles/assistant/prompts/".length);
	if (!type) {
		json({ error: "Missing type parameter" }, 400);
		return;
	}
	const body = await readBody(req);
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
	return;
}

async function handleRolesList(ctx: CoreRouteCtx): Promise<void> {
	const { url, json, configCascade, resolveRequiredConfigProjectScope, writeConfigProjectScopeError } = ctx;
	const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
	if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
	const effectiveConfigProjectId = projectScope.effectiveProjectId;
	const resolved = configCascade.resolveRoles(effectiveConfigProjectId);
	json({ roles: resolved.map(r => withRoleResolution(ctx, r as any, effectiveConfigProjectId)) });
	return;
}

async function handleRolesCreate(ctx: CoreRouteCtx): Promise<void> {
	const { req, url, json, jsonError, readBody, clampRoleThinking, writeConfigProjectScopeError } = ctx;
	const body = await readBody(req);
	try {
		const resolvedTarget = resolveRoleMutationTarget(ctx, body?.projectId ?? url.searchParams.get("projectId"));
		if (!resolvedTarget.ok) { writeConfigProjectScopeError(resolvedTarget); return; }
		const target = resolvedTarget.target;
		const modelStr = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;
		if (target.scope === "server") {
			const role = target.manager.createRole({
				name: body?.name,
				label: body?.label,
				promptTemplate: body?.promptTemplate || "",
				accessory: body?.accessory,
				toolPolicies: body?.toolPolicies,
				model: modelStr,
				thinkingLevel: clampRoleThinking(body?.thinkingLevel, modelStr),
			});
			json(role, 201);
		} else {
			const now = Date.now();
			const role = {
				name: body?.name,
				label: body?.label ?? body?.name,
				promptTemplate: body?.promptTemplate || "",
				accessory: body?.accessory ?? "none",
				toolPolicies: body?.toolPolicies,
				model: modelStr,
				thinkingLevel: clampRoleThinking(body?.thinkingLevel, modelStr),
				createdAt: now,
				updatedAt: now,
			};
			if (!role.name || typeof role.name !== "string") throw new Error("Missing name");
			const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
			if (!NAME_PATTERN.test(role.name)) throw new Error("Role name must be lowercase alphanumeric + hyphens");
			target.store.put(role);
			json(role, 201);
		}
	} catch (err: any) {
		jsonError(400, err);
	}
	return;
}

async function handleRoleCustomize(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, configCascade, serverRoleStore, resolveRequiredConfigProjectScope, writeConfigProjectScopeError } = ctx;
	const name = decodeURIComponent(params.name);
	const scope = url.searchParams.get("scope") || "server";
	const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"), { aliasSystem: true });
	if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
	const projectId = projectScope.effectiveProjectId;

	const resolved = configCascade.resolveRoles(projectId);
	const source = resolved.find(r => r.item.name === name);
	if (!source) { json({ error: "Role not found" }, 404); return; }

	let targetStore: RoleStore;
	if (scope === "project" && projectId) {
		targetStore = projectScope.context?.roleStore ?? serverRoleStore;
	} else {
		targetStore = serverRoleStore;
	}

	const now = Date.now();
	const copy = { ...source.item, createdAt: now, updatedAt: now };
	targetStore.put(copy);
	json(copy, 201);
	return;
}

async function handleRoleOverrideDelete(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, serverRoleStore, resolveRequiredConfigProjectScope, writeConfigProjectScopeError } = ctx;
	const name = decodeURIComponent(params.name);
	const scope = url.searchParams.get("scope") || "server";
	const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"), { aliasSystem: true });
	if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
	const projectId = projectScope.effectiveProjectId;

	let targetStore: RoleStore;
	if (scope === "project" && projectId) {
		targetStore = projectScope.context?.roleStore ?? serverRoleStore;
	} else {
		targetStore = serverRoleStore;
	}

	targetStore.remove(name);
	json({ ok: true });
	return;
}

async function handleRoleGet(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, configCascade, roleManager, resolveRequiredConfigProjectScope, writeConfigProjectScopeError } = ctx;
	const name = decodeURIComponent(params.name);
	const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
	if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
	const effectiveConfigProjectId = projectScope.effectiveProjectId;
	const resolved = configCascade.resolveRoles(effectiveConfigProjectId);
	const found = resolved.find(r => r.item.name === name);
	if (found) {
		json(withRoleResolution(ctx, found as any, effectiveConfigProjectId));
	} else if (!effectiveConfigProjectId) {
		const role = roleManager.getRole(name);
		if (!role) { json({ error: "Role not found" }, 404); return; }
		json({ ...role, modelResolution: configCascade.resolveRoleModelResolution(name, effectiveConfigProjectId) });
	} else {
		json({ error: "Role not found" }, 404);
	}
	return;
}

async function handleRolePut(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { req, url, json, readBody, clampRoleThinking, writeConfigProjectScopeError } = ctx;
	const name = decodeURIComponent(params.name);
	const body = await readBody(req);
	if (!body) { json({ error: "Missing body" }, 400); return; }
	const resolvedTarget = resolveRoleMutationTarget(ctx, body.projectId ?? url.searchParams.get("projectId"));
	if (!resolvedTarget.ok) { writeConfigProjectScopeError(resolvedTarget); return; }
	const target = resolvedTarget.target;
	if (target.scope === "project") {
		const existing = target.store.get(name);
		if (!existing) { json({ error: "Role not found in project" }, 404); return; }
		let toolPolicies = existing.toolPolicies;
		if (body.toolPolicies !== undefined) {
			toolPolicies = cleanToolPolicies(body.toolPolicies);
		}
		let model = existing.model;
		if (body.model !== undefined) {
			model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
		}
		let thinkingLevel = existing.thinkingLevel;
		if (body.thinkingLevel !== undefined) {
			thinkingLevel = clampRoleThinking(body.thinkingLevel, model);
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
		target.store.put(updated);
		json({ ok: true });
	} else {
		const modelUpdate = body.model !== undefined
			? (typeof body.model === "string" && body.model.trim() ? body.model.trim() : "")
			: undefined;
		const thinkingUpdate = body.thinkingLevel !== undefined
			? (clampRoleThinking(body.thinkingLevel, typeof modelUpdate === "string" ? modelUpdate : undefined) ?? "")
			: undefined;
		if (modelUpdate !== undefined || thinkingUpdate !== undefined) {
			const existing = target.manager.getRole(name);
			if (existing) {
				const patched = {
					...existing,
					model: modelUpdate !== undefined ? (modelUpdate || undefined) : existing.model,
					thinkingLevel: thinkingUpdate !== undefined ? (thinkingUpdate || undefined) : existing.thinkingLevel,
					updatedAt: Date.now(),
				};
				target.store.put(patched);
			}
		}
		const ok = target.manager.updateRole(name, {
			label: body.label,
			promptTemplate: body.promptTemplate,
			accessory: body.accessory,
			toolPolicies: body.toolPolicies !== undefined ? cleanToolPolicies(body.toolPolicies) : undefined,
		});
		if (!ok) { json({ error: "Role not found" }, 404); return; }
		json({ ok: true });
	}
	return;
}

async function handleRoleDelete(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { url, json, writeConfigProjectScopeError } = ctx;
	const name = decodeURIComponent(params.name);
	const resolvedTarget = resolveRoleMutationTarget(ctx, url.searchParams.get("projectId"));
	if (!resolvedTarget.ok) { writeConfigProjectScopeError(resolvedTarget); return; }
	const target = resolvedTarget.target;
	if (target.scope === "project") {
		target.store.remove(name);
		json({ ok: true });
	} else {
		const ok = target.manager.deleteRole(name);
		if (!ok) { json({ error: "Role not found" }, 404); return; }
		json({ ok: true });
	}
	return;
}

export function registerRolesRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/roles/assistant/prompts", handleAssistantPromptsGet);
	table.register("PUT", "/api/roles/assistant/prompts/*", handleAssistantPromptPut);
	table.register("GET", "/api/roles", handleRolesList);
	table.register("POST", "/api/roles", handleRolesCreate);
	table.register("POST", "/api/roles/:name/customize", handleRoleCustomize);
	table.register("DELETE", "/api/roles/:name/override", handleRoleOverrideDelete);
	table.register("GET", "/api/roles/:name", handleRoleGet);
	table.register("PUT", "/api/roles/:name", handleRolePut);
	table.register("DELETE", "/api/roles/:name", handleRoleDelete);
}
