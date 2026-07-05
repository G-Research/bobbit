// src/server/routes/staff-mcp-operator-routes.ts
//
// STR-01 cohort 10: late operator/configuration routes for staff CRUD and
// MCP runtime/meta-tool control, migrated out of handleApiRoute's legacy
// if/else chain into the core route registry. See docs/design/route-registry.md.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Each exact
// route was method-gated before any shared resolution work, and the path-first
// staff :id block only did work inside method-specific branches. Unregistered
// methods still fall through to the terminal legacy 404.

import fs from "node:fs";
import path from "node:path";
import { SYSTEM_PROJECT_ID } from "../agent/project-registry.js";
import { resolveProjectForRequest, validateExecutionCwd } from "../agent/resolve-project.js";
import { resolveGrantPolicy } from "../agent/tool-activation.js";
import { parseMcpToolName } from "../mcp/mcp-meta.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

function writeProjectResolutionError(ctx: CoreRouteCtx, resolved: Extract<ReturnType<typeof resolveProjectForRequest>, { ok: false }>): void {
	ctx.json({ error: resolved.error, code: resolved.code }, resolved.status);
}

function writeCwdValidationError(ctx: CoreRouteCtx, validation: Extract<ReturnType<typeof validateExecutionCwd>, { ok: false }>): void {
	ctx.json({ error: validation.error, code: validation.code }, validation.status);
}

async function handleStaffMcpOperatorRoute(ctx: CoreRouteCtx): Promise<void> {
	const {
		url,
		req,
		json,
		jsonError,
		readBody,
		sessionManager,
		projectRegistry,
		projectContextManager,
		staffManager,
		resolveRoleForProject,
		toolManager,
		groupPolicyStore,
		refreshMcpExternalTools,
	} = ctx;

	if (url.pathname === "/api/staff/orphaned" && req.method === "GET") {
		json({ staff: staffManager.listOrphaned() });
		return;
	}

	if (url.pathname === "/api/staff" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		json({ staff: staffManager.listStaff(projectId) });
		return;
	}

	if (url.pathname === "/api/staff" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.name || typeof body.name !== "string") {
			json({ error: "Missing name" }, 400);
			return;
		}
		if (!body?.systemPrompt || typeof body.systemPrompt !== "string") {
			json({ error: "Missing systemPrompt" }, 400);
			return;
		}
		if (body.roleId !== undefined && body.roleId !== null && typeof body.roleId !== "string") {
			json({ error: "roleId must be a string or null" }, 400);
			return;
		}
		try {
			staffManager.validateTriggers(body.triggers);
		} catch (err: any) {
			jsonError(400, err);
			return;
		}
		const explicitCwd = typeof body.cwd === "string" && body.cwd.trim().length > 0
			? body.cwd.trim()
			: undefined;
		const explicitProjectId = typeof body.projectId === "string" && body.projectId.trim().length > 0
			? body.projectId.trim()
			: undefined;
		const resolved = resolveProjectForRequest(projectRegistry, { projectId: explicitProjectId });
		if (!resolved.ok) { writeProjectResolutionError(ctx, resolved); return; }
		const cwd = explicitCwd ?? resolved.project.rootPath;
		const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, resolved.projectId, cwd, { kind: "user-input" });
		if (!cwdValidation.ok) { writeCwdValidationError(ctx, cwdValidation); return; }
		const projectId = resolved.projectId;
		if (typeof body.roleId === "string" && body.roleId.length > 0 && !resolveRoleForProject(body.roleId, projectId)) {
			json({ error: "Role not found" }, 404);
			return;
		}
		try {
			const staff = await staffManager.createStaff(
				body.name,
				body.description || "",
				body.systemPrompt,
				cwd,
				sessionManager,
				{
					triggers: body.triggers,
					roleId: body.roleId,
					accessory: body.accessory,
					projectId,
					sandboxed: body.sandboxed === true,
					...(typeof body.worktree === "boolean" ? { worktree: body.worktree } : {}),
				},
			);
			json(staff, 201);
		} catch (err: any) {
			console.error("[server] Failed to create staff agent:", err);
			jsonError(500, err);
		}
		return;
	}

	const staffMatch = url.pathname.match(/^\/api\/staff\/([^/]+)$/);
	if (staffMatch) {
		const id = staffMatch[1];

		if (req.method === "GET") {
			const staff = staffManager.getStaff(id);
			if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
			json(staff);
			return;
		}

		if (req.method === "PATCH") {
			const body = await readBody(req);
			if (!body || typeof body.projectId !== "string" || !body.projectId.trim()) {
				json({ error: "Missing projectId" }, 400);
				return;
			}
			const targetProjectId = body.projectId.trim();
			const targetProject = projectRegistry.get(targetProjectId);
			if (!targetProject) { json({ error: "Project not found" }, 404); return; }
			if (targetProject.hidden || targetProject.id === SYSTEM_PROJECT_ID) {
				json({ error: "projectId must reference a registered project" }, 400);
				return;
			}
			try {
				const staff = await staffManager.reassignProject(id, targetProjectId, sessionManager);
				if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
				json(staff);
			} catch (err: any) {
				jsonError(400, err);
			}
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			if (body.roleId !== undefined && body.roleId !== null && typeof body.roleId !== "string") {
				json({ error: "roleId must be a string or null" }, 400);
				return;
			}
			const existingStaff = staffManager.getStaff(id);
			if (!existingStaff) { json({ error: "Staff agent not found" }, 404); return; }
			if (typeof body.roleId === "string" && body.roleId.length > 0 && !resolveRoleForProject(body.roleId, existingStaff.projectId)) {
				json({ error: "Role not found" }, 404);
				return;
			}
			if (Object.prototype.hasOwnProperty.call(body, "triggers")) {
				try {
					staffManager.validateTriggers(body.triggers);
				} catch (err: any) {
					jsonError(400, err);
					return;
				}
			}

			let cwdUpdate: string | undefined;
			if (Object.prototype.hasOwnProperty.call(body, "cwd")) {
				const staff = existingStaff;
				if (typeof body.cwd !== "string" || body.cwd.trim().length === 0) {
					json({ error: "cwd must be a non-empty string" }, 400);
					return;
				}
				const requestedCwd = body.cwd.trim();
				const normalizeCwdForComparison = (value: string): string => {
					let resolved = path.resolve(value.trim());
					try { resolved = fs.realpathSync(resolved); } catch { /* compare textual path when legacy cwd no longer exists */ }
					let normalized = resolved.replace(/\\/g, "/");
					if (process.platform === "win32") normalized = normalized.toLowerCase();
					return normalized.replace(/\/+$/, "");
				};
				const existingCwd = typeof staff.cwd === "string" ? staff.cwd : "";
				const isUnchangedCwd = existingCwd.trim().length > 0
					&& normalizeCwdForComparison(requestedCwd) === normalizeCwdForComparison(existingCwd);
				if (!isUnchangedCwd) {
					const staffProjectId = typeof staff.projectId === "string" && staff.projectId.trim().length > 0
						? staff.projectId.trim()
						: undefined;
					const staffProject = staffProjectId ? projectRegistry.get(staffProjectId) : undefined;
					if (!staffProject || staffProject.hidden || staffProject.id === SYSTEM_PROJECT_ID) {
						json({ error: "Staff agent is not attached to a registered project" }, 400);
						return;
					}
					const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, staffProject.id, requestedCwd, { kind: "staff", staffId: staff.id });
					if (!cwdValidation.ok) { writeCwdValidationError(ctx, cwdValidation); return; }
					cwdUpdate = requestedCwd;
				}
			}

			const hasAccessoryUpdate = Object.prototype.hasOwnProperty.call(body, "accessory");
			const ok = staffManager.updateStaff(id, {
				name: body.name,
				description: body.description,
				systemPrompt: body.systemPrompt,
				cwd: cwdUpdate,
				state: body.state,
				triggers: body.triggers,
				memory: body.memory,
				roleId: body.roleId,
				accessory: hasAccessoryUpdate ? body.accessory : undefined,
				contextPolicy:
					body.contextPolicy === "preserve" || body.contextPolicy === "compact"
						? body.contextPolicy
						: undefined,
			});
			if (!ok) { json({ error: "Staff agent not found" }, 404); return; }
			const staff = staffManager.getStaff(id);
			if (hasAccessoryUpdate && staff?.currentSessionId) {
				sessionManager.updateSessionMeta(staff.currentSessionId, { accessory: staff.accessory });
			}
			json(staff);
			return;
		}

		if (req.method === "DELETE") {
			const ok = await staffManager.deleteStaff(id, sessionManager);
			if (!ok) { json({ error: "Staff agent not found" }, 404); return; }
			json({ ok: true });
			return;
		}
	}

	const staffSessionsMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/sessions$/);
	if (staffSessionsMatch && req.method === "GET") {
		json({ error: "Deprecated. Staff agents have a single permanent session. Use GET /api/staff/:id." }, 410);
		return;
	}

	if (url.pathname === "/api/mcp-servers" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		const cwd = url.searchParams.get("cwd") || undefined;
		const resolvedProject = resolveProjectForRequest(projectRegistry, { projectId });
		if (!resolvedProject.ok) { writeProjectResolutionError(ctx, resolvedProject); return; }
		if (cwd) {
			const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, resolvedProject.projectId, cwd, { kind: "user-input" });
			if (!cwdValidation.ok) { writeCwdValidationError(ctx, cwdValidation); return; }
		}
		const ensure = url.searchParams.get("ensure") === "true";
		const resolvedProjectId = resolvedProject.projectId;
		const mcpManager = ensure ? await sessionManager.ensureMcpManager({ projectId: resolvedProjectId }) : sessionManager.getMcpManager({ projectId: resolvedProjectId });
		if (!mcpManager) {
			json([]);
			return;
		}
		const statuses = mcpManager.getServerStatuses();
		const routeSnapshots = mcpManager.getToolRouteSnapshots();
		const result = statuses.map(s => {
			const ownedRoutes = routeSnapshots.filter(t => t.runtimeServerKey === s.name);
			const publicServerNames = new Set<string>([
				...ownedRoutes.map(t => t.publicServerName),
				...(s.ownerContributions ?? []).map(c => c.serverName),
			].filter((name): name is string => typeof name === "string" && name.length > 0));
			const publicServerName = publicServerNames.size === 1 ? [...publicServerNames][0] : undefined;
			const serverPolicyKey = publicServerName ? `mcp__${publicServerName}` : `mcp__${s.name}`;
			return {
				...s,
				serverPolicyKey,
				policyKey: serverPolicyKey,
				toolCount: ownedRoutes.length,
				tools: ownedRoutes.map(t => {
					const parsed = parseMcpToolName(t.name);
					const subNamespace = t.subNamespace ?? parsed?.sub;
					const routeServerPolicyKey = `mcp__${t.publicServerName}`;
					const packagePolicyKey = subNamespace ? `${routeServerPolicyKey}__${subNamespace}` : undefined;
					return {
						name: t.name,
						description: t.description,
						serverPolicyKey: routeServerPolicyKey,
						policyKey: t.name,
						operationPolicyKey: t.name,
						...(packagePolicyKey ? { packagePolicyKey, subNamespacePolicyKey: packagePolicyKey } : {}),
						subNamespace,
						op: parsed?.op ?? t.mcpToolName,
					};
				}),
			};
		});
		json(result);
		return;
	}

	const mcpRestartMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/restart$/);
	if (mcpRestartMatch && req.method === "POST") {
		const projectId = url.searchParams.get("projectId") || undefined;
		const cwd = url.searchParams.get("cwd") || undefined;
		const resolvedProject = resolveProjectForRequest(projectRegistry, { projectId });
		if (!resolvedProject.ok) { writeProjectResolutionError(ctx, resolvedProject); return; }
		if (cwd) {
			const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, resolvedProject.projectId, cwd, { kind: "user-input" });
			if (!cwdValidation.ok) { writeCwdValidationError(ctx, cwdValidation); return; }
		}
		const resolvedProjectId = resolvedProject.projectId;
		const mcpManager = await sessionManager.ensureMcpManager({ projectId: resolvedProjectId });
		if (!mcpManager) {
			json({ error: "MCP not initialized" }, 500);
			return;
		}
		const serverName = decodeURIComponent(mcpRestartMatch[1]);
		let statuses = mcpManager.getServerStatuses();
		let existing = statuses.find(s => s.name === serverName);
		if (!existing || !existing.config) {
			const discovered = mcpManager.discoverServers();
			if (!discovered[serverName]) {
				json({ error: `MCP server "${serverName}" not found` }, 404);
				return;
			}
			await mcpManager.connectServer(serverName, discovered[serverName]);
		} else {
			await mcpManager.disconnectServer(serverName);
			const refreshed = mcpManager.discoverServers();
			const config = refreshed[serverName] || existing.config;
			await mcpManager.connectServer(serverName, config);
		}
		refreshMcpExternalTools();
		const updated = mcpManager.getServerStatuses().find(s => s.name === serverName);
		json({ ok: true, ...updated });
		return;
	}

	if (url.pathname === "/api/internal/mcp-call" && req.method === "POST") {
		let parsedToolForError: string | undefined;
		try {
			const body = await new Promise<string>((resolve) => {
				let data = "";
				req.on("data", (chunk: Buffer) => data += chunk.toString());
				req.on("end", () => resolve(data));
			});
			const parsedBody = JSON.parse(body);
			const { tool, args } = parsedBody;
			const scopeKey = typeof parsedBody?.scopeKey === "string" && parsedBody.scopeKey ? parsedBody.scopeKey : undefined;
			parsedToolForError = typeof tool === "string" ? tool : undefined;
			if (!tool) {
				json({ error: "Missing 'tool' field" }, 400);
				return;
			}

			const mcpSessionId = req.headers["x-bobbit-session-id"] as string | undefined;
			if (!mcpSessionId) {
				json({ error: "Missing X-Bobbit-Session-Id header" }, 403);
				return;
			}
			const mcpSession = sessionManager.getSession(mcpSessionId);
			const persistedSession = mcpSession ? null : (
				projectContextManager.getContextForSession(mcpSessionId)?.sessionStore.get(mcpSessionId)
				?? null
			);
			if (!mcpSession && !persistedSession) {
				json({ error: `Session "${mcpSessionId}" not found` }, 403);
				return;
			}
			if (!(mcpSession?.projectId ?? persistedSession?.projectId)) {
				json({ error: "Session missing projectId", code: "PROJECT_ID_REQUIRED" }, 403);
				return;
			}
			const mcpManager = await sessionManager.resolveMcpManagerForSession(mcpSessionId, scopeKey);
			if (!mcpManager) {
				json({ error: "MCP not initialized" }, 500);
				return;
			}
			const toolStr = tool as string;
			if (!toolStr.startsWith("mcp__") && mcpSession?.allowedTools && mcpSession.allowedTools.length > 0) {
				if (!mcpSession.allowedTools.some((t: string) => t.toLowerCase() === toolStr.toLowerCase())) {
					json({ error: `Tool "${tool}" is not allowed for this session` }, 403);
					return;
				}
			}

			if (toolStr.startsWith("mcp__")) {
				const roleName = mcpSession?.role ?? (persistedSession as any)?.role;
				const role = roleName ? resolveRoleForProject(roleName, mcpSession?.projectId ?? (persistedSession as any)?.projectId) : undefined;
				const parsed = parseMcpToolName(toolStr);
				const opGroup = parsed?.server ? `MCP: ${parsed.server}` : undefined;
				const policy = resolveGrantPolicy(toolStr, opGroup, role, toolManager, groupPolicyStore);
				if (policy === "never") {
					json({ error: `tool ${toolStr} denied by policy`, tool: toolStr, reason: "policy=never" }, 403);
					return;
				}
			}

			const result = await mcpManager.callTool(tool, args || {});
			json(result);
		} catch (err) {
			const e = err as Error;
			console.error(`[mcp] Tool call failed:`, e.stack || e);
			let parsedServer: string | undefined;
			let parsedOperation: string | undefined;
			if (parsedToolForError && parsedToolForError.startsWith("mcp__")) {
				const parsedErr = parseMcpToolName(parsedToolForError);
				if (parsedErr) {
					parsedServer = parsedErr.server;
					parsedOperation = parsedErr.sub ? `${parsedErr.sub}__${parsedErr.op}` : parsedErr.op;
				}
			}
			json({ error: e.message, server: parsedServer, operation: parsedOperation, stack: e.stack }, 500);
		}
		return;
	}

	if (url.pathname === "/api/internal/mcp-describe" && req.method === "POST") {
		try {
			const body = await new Promise<string>((resolve) => {
				let data = "";
				req.on("data", (chunk: Buffer) => data += chunk.toString());
				req.on("end", () => resolve(data));
			});
			const parsed = JSON.parse(body || "{}");
			const server: string | undefined = parsed?.server;
			const operation: string | undefined = parsed?.operation;
			const scopeKey = typeof parsed?.scopeKey === "string" && parsed.scopeKey ? parsed.scopeKey : undefined;
			if (!server || typeof server !== "string") {
				json({ error: "Missing 'server' field" }, 400);
				return;
			}

			const describeSessionId = req.headers["x-bobbit-session-id"] as string | undefined;
			if (!describeSessionId) {
				json({ error: "Missing X-Bobbit-Session-Id header" }, 403);
				return;
			}
			const liveSession = sessionManager.getSession(describeSessionId);
			const persistedSession = liveSession ? null : (
				projectContextManager.getContextForSession(describeSessionId)?.sessionStore.get(describeSessionId)
				?? null
			);
			if (!liveSession && !persistedSession) {
				json({ error: `Session "${describeSessionId}" not found` }, 403);
				return;
			}
			if (!(liveSession?.projectId ?? persistedSession?.projectId)) {
				json({ error: "Session missing projectId", code: "PROJECT_ID_REQUIRED" }, 403);
				return;
			}
			const mcpManager = await sessionManager.resolveMcpManagerForSession(describeSessionId, scopeKey);
			if (!mcpManager) {
				json({ error: "MCP not initialized" }, 500);
				return;
			}

			const statuses = mcpManager.getServerStatuses();
			const directStatus = statuses.find(s => s.name === server);
			const ownerStatuses = statuses.filter(s => (s.ownerContributions ?? []).some((c) => c.serverName === server));
			const connectedRuntimeKeys = new Set(
				statuses.filter(s => s.status === "connected").map(s => s.name),
			);
			const serverIsConnected = directStatus?.status === "connected" || ownerStatuses.some(s => s.status === "connected");
			if (!serverIsConnected) {
				const statusForReason = directStatus ?? ownerStatuses.find(s => s.error || s.status !== "connected");
				const reason = statusForReason?.error ?? (statusForReason ? statusForReason.status : "unknown server");
				json({ error: `server ${server} not connected: ${reason}` }, 503);
				return;
			}

			const infos = mcpManager.getToolRouteSnapshots()
				.filter(i => i.publicServerName === server && connectedRuntimeKeys.has(i.runtimeServerKey));
			const describeNameFor = (info: (typeof infos)[number]): { name: string; subNamespace?: string } => {
				const parsedName = parseMcpToolName(info.name);
				if (parsedName?.server === server && info.subNamespace && parsedName.sub === info.subNamespace) {
					return { name: parsedName.op, subNamespace: info.subNamespace };
				}
				return { name: info.mcpToolName };
			};
			const toDescriptor = (info: (typeof infos)[number]) => {
				const described = describeNameFor(info);
				return {
					name: described.name,
					...(described.subNamespace ? { subNamespace: described.subNamespace } : {}),
					description: info.description,
					inputSchema: info.inputSchema,
				};
			};
			if (operation) {
				const match = infos.find(i => i.mcpToolName === operation)
					?? infos.find(i => describeNameFor(i).name === operation);
				if (!match) {
					json({ error: "operation not found" }, 404);
					return;
				}
				json({ tool: toDescriptor(match) });
				return;
			}
			json({ tools: infos.map(toDescriptor) });
		} catch (err) {
			const e = err as Error;
			console.error(`[mcp] Describe failed:`, e.stack || e);
			json({ error: e.message, stack: e.stack }, 500);
		}
		return;
	}
}

export function registerStaffMcpOperatorRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/staff/orphaned", handleStaffMcpOperatorRoute);
	table.register("GET", "/api/staff", handleStaffMcpOperatorRoute);
	table.register("POST", "/api/staff", handleStaffMcpOperatorRoute);
	table.register("GET", "/api/staff/:id", handleStaffMcpOperatorRoute);
	table.register("PATCH", "/api/staff/:id", handleStaffMcpOperatorRoute);
	table.register("PUT", "/api/staff/:id", handleStaffMcpOperatorRoute);
	table.register("DELETE", "/api/staff/:id", handleStaffMcpOperatorRoute);
	table.register("GET", "/api/staff/:id/sessions", handleStaffMcpOperatorRoute);
	table.register("GET", "/api/mcp-servers", handleStaffMcpOperatorRoute);
	table.register("POST", "/api/mcp-servers/:name/restart", handleStaffMcpOperatorRoute);
	table.register("POST", "/api/internal/mcp-call", handleStaffMcpOperatorRoute);
	table.register("POST", "/api/internal/mcp-describe", handleStaffMcpOperatorRoute);
}
