// src/server/routes/host-config-routes.ts
//
// STR-01 cohort 18: Host configuration routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block here gated on path and method in the same `if` condition. A method
// mismatch skipped the block and fell through to the terminal 404; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.

import {
	bobbitStateDir,
	buildAgentDirRestartGuidance,
	getAgentDirApiState,
	getProjectRoot,
	isKnownAgentDir,
	isPendingAgentDir,
	migrateAgentDirData,
	normalizeAgentDirInput,
	refreshAgentDirNextStart,
	validateAgentDirTarget,
} from "../bobbit-dir.js";
import type { ToolGroupPolicyStore } from "../agent/tool-group-policy-store.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// GET /api/tool-group-policies
async function handleToolGroupPoliciesGet(ctx: CoreRouteCtx): Promise<void> {
	const { configCascade, json, resolveRequiredConfigProjectScope, url, writeConfigProjectScopeError } = ctx;
	const projectScope = resolveRequiredConfigProjectScope(url.searchParams.get("projectId"));
	if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
	json(configCascade.resolveToolGroupPolicies(projectScope.effectiveProjectId));
	return;
}

// PUT /api/tool-group-policies/:group
async function handleToolGroupPolicyPut(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { groupPolicyStore, json, readBody, req, resolveRequiredConfigProjectScope, url, writeConfigProjectScopeError } = ctx;
	const group = decodeURIComponent(params.group);
	const body = await readBody(req);
	if (!body) { json({ error: "Missing body" }, 400); return; }
	const validPolicies = ['allow', 'ask', 'never', 'always-allow', 'ask-once', 'always-ask', 'never-ask'];
	if (body.policy && !validPolicies.includes(body.policy)) {
		json({ error: `Invalid policy. Must be one of: allow, ask, never` }, 400);
		return;
	}
	// Scope the mutation to a project-level store when projectId is given.
	// Headquarters/system alias to server scope (mirrors role mutation routes).
	const projectScope = resolveRequiredConfigProjectScope(body.projectId ?? url.searchParams.get("projectId"), { aliasSystem: true });
	if (!projectScope.ok) { writeConfigProjectScopeError(projectScope); return; }
	const targetStore: ToolGroupPolicyStore = projectScope.context?.toolGroupPolicyStore ?? groupPolicyStore;
	targetStore.setGroupPolicy(group, body.policy || null);
	json({ ok: true });
	return;
}

// GET /api/config/cwd
async function handleConfigCwdGet(ctx: CoreRouteCtx): Promise<void> {
	const { json, mutableGatewayConfig: config } = ctx;
	json({ cwd: config.defaultCwd });
	return;
}

// PUT /api/config/cwd
async function handleConfigCwdPut(ctx: CoreRouteCtx): Promise<void> {
	const { json, mutableGatewayConfig: config, preferencesStore, readBody, req } = ctx;
	const body = await readBody(req);
	if (!body?.cwd || typeof body.cwd !== "string") {
		json({ error: "Missing or invalid cwd" }, 400);
		return;
	}
	config.defaultCwd = body.cwd;
	preferencesStore.set("defaultCwd", body.cwd);
	json({ cwd: config.defaultCwd });
	return;
}

// GET /api/agent-dir — return startup-resolved active dir plus next-start state.
async function handleAgentDirGet(ctx: CoreRouteCtx): Promise<void> {
	const { json } = ctx;
	json(getAgentDirApiState());
	return;
}

// POST /api/agent-dir/validate — validate and probe an agent-dir target.
async function handleAgentDirValidate(ctx: CoreRouteCtx): Promise<void> {
	const { json, readBody, req } = ctx;
	const body = await readBody(req);
	if (!body || typeof body !== "object") { json({ ok: false, error: { code: "MISSING_BODY", message: "Missing body" } }, 400); return; }
	const result = validateAgentDirTarget((body as any).path, getProjectRoot());
	json(result);
	return;
}

// PUT /api/agent-dir/pending — save the next-start agent dir without live-switching.
async function handleAgentDirPendingPut(ctx: CoreRouteCtx): Promise<void> {
	const { broadcastPreferencesChanged, broadcastToAll, json, preferencesStore, readBody, req } = ctx;
	const body = await readBody(req);
	if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
	const rawPath = (body as any).path;
	let persistedPath: string | undefined;
	if (rawPath === null || rawPath === undefined || (typeof rawPath === "string" && rawPath.trim().length === 0)) {
		preferencesStore.remove("agentDir");
	} else if (typeof rawPath === "string") {
		const validation = validateAgentDirTarget(rawPath, getProjectRoot());
		if (!validation.ok) { json(validation, 400); return; }
		persistedPath = validation.resolvedPath;
		preferencesStore.set("agentDir", persistedPath);
	} else {
		json({ error: "path must be a string, null, or empty" }, 400);
		return;
	}

	const state = refreshAgentDirNextStart(persistedPath, bobbitStateDir());
	preferencesStore.set("agentDirHistory", state.history);
	broadcastPreferencesChanged();
	broadcastToAll({ type: "agent_dir_changed", agentDir: getAgentDirApiState() });
	json({ ...getAgentDirApiState(), guidance: buildAgentDirRestartGuidance() });
	return;
}

// POST /api/agent-dir/migrate — copy allowlisted agent data; never delete or move source.
async function handleAgentDirMigrate(ctx: CoreRouteCtx): Promise<void> {
	const { broadcastToAll, json, preferencesStore, readBody, req } = ctx;
	const body = await readBody(req);
	if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
	const sourceRaw = (body as any).sourcePath;
	const destinationRaw = (body as any).destinationPath;
	if (typeof sourceRaw !== "string" || typeof destinationRaw !== "string" || sourceRaw.trim().length === 0 || destinationRaw.trim().length === 0) {
		json({ error: "sourcePath and destinationPath are required" }, 400);
		return;
	}
	const sourcePath = normalizeAgentDirInput(sourceRaw, getProjectRoot());
	const destinationPath = normalizeAgentDirInput(destinationRaw, getProjectRoot());
	if (!isKnownAgentDir(sourcePath)) {
		json({ error: "sourcePath must be the active or a historical agent directory", code: "INVALID_SOURCE" }, 400);
		return;
	}
	if (!isPendingAgentDir(destinationPath)) {
		json({ error: "destinationPath must be the pending next-start agent directory", code: "INVALID_DESTINATION" }, 400);
		return;
	}
	const report = migrateAgentDirData(sourcePath, destinationPath, (body as any).overwrite === true);
	if (report.error) {
		json(report, 400);
		return;
	}
	const state = refreshAgentDirNextStart((preferencesStore.get("agentDir") as string | undefined), bobbitStateDir());
	preferencesStore.set("agentDirHistory", state.history);
	broadcastToAll({ type: "agent_dir_changed", agentDir: getAgentDirApiState() });
	json({ ...report, guidance: buildAgentDirRestartGuidance() });
	return;
}

export function registerHostConfigRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/tool-group-policies", handleToolGroupPoliciesGet);
	table.register("PUT", "/api/tool-group-policies/:group", handleToolGroupPolicyPut);
	table.register("GET", "/api/config/cwd", handleConfigCwdGet);
	table.register("PUT", "/api/config/cwd", handleConfigCwdPut);
	table.register("GET", "/api/agent-dir", handleAgentDirGet);
	table.register("POST", "/api/agent-dir/validate", handleAgentDirValidate);
	table.register("PUT", "/api/agent-dir/pending", handleAgentDirPendingPut);
	table.register("POST", "/api/agent-dir/migrate", handleAgentDirMigrate);
}
