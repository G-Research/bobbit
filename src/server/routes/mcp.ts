/**
 * MCP server status, restart, and internal mcp-call/describe routes.
 * Extracted from server.ts (commit: split server.ts).
 */
import { parseMcpToolName } from "../mcp/mcp-meta.js";
import { resolveGrantPolicy } from "../agent/tool-activation.js";
import type { Route } from "./types.js";

export const mcpRoutes: Route[] = [
	{
		method: "GET",
		pattern: "/api/mcp-servers",
		handler: ({ deps, json }) => {
			const mcpManager = deps.sessionManager.getMcpManager();
			if (!mcpManager) {
				json([]);
				return;
			}
			const statuses = mcpManager.getServerStatuses();
			const toolInfos = mcpManager.getToolInfos();
			const result = statuses.map(s => ({
				...s,
				tools: toolInfos.filter(t => t.serverName === s.name).map(t => {
					const parsed = parseMcpToolName(t.name);
					return {
						name: t.name,
						description: t.description,
						subNamespace: parsed?.sub,
						op: parsed?.op ?? t.mcpToolName,
					};
				}),
			}));
			json(result);
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/mcp-servers\/([^/]+)\/restart$/,
		handler: async ({ deps, params, json, jsonError }) => {
			const mcpManager = deps.sessionManager.getMcpManager();
			if (!mcpManager) {
				jsonError(500, new Error("MCP not initialized"));
				return;
			}
			const serverName = decodeURIComponent(params[1]);
			let statuses = mcpManager.getServerStatuses();
			let existing = statuses.find(s => s.name === serverName);
			if (!existing || !existing.config) {
				const discovered = mcpManager.discoverServers();
				if (!discovered[serverName]) {
					jsonError(404, new Error(`MCP server "${serverName}" not found`));
					return;
				}
				await mcpManager.connectServer(serverName, discovered[serverName]);
			} else {
				await mcpManager.disconnectServer(serverName);
				const refreshed = mcpManager.discoverServers();
				const config = refreshed[serverName] || existing.config;
				await mcpManager.connectServer(serverName, config);
			}
			if (deps.toolManager) {
				deps.toolManager.removeExternalTools("mcp__");
				const infos = mcpManager.getToolInfos();
				deps.toolManager.registerExternalTools(infos.map(info => ({
					name: info.name,
					description: info.description,
					summary: info.description,
					group: info.group,
					docs: info.docs,
					provider: { type: 'mcp' as const, server: info.serverName, mcpTool: info.mcpToolName },
				})));
			}
			const updated = mcpManager.getServerStatuses().find(s => s.name === serverName);
			json({ ok: true, ...updated });
		},
	},
	{
		method: "POST",
		pattern: "/api/internal/mcp-call",
		handler: async ({ deps, req, json, jsonError }) => {
			const mcpManager = deps.sessionManager.getMcpManager();
			if (!mcpManager) {
				jsonError(500, new Error("MCP not initialized"));
				return;
			}
			let parsedToolForError: string | undefined;
			try {
				const body = await new Promise<string>((resolve) => {
					let data = "";
					req.on("data", (chunk: Buffer) => data += chunk.toString());
					req.on("end", () => resolve(data));
				});
				const { tool, args } = JSON.parse(body);
				parsedToolForError = typeof tool === "string" ? tool : undefined;
				if (!tool) {
					jsonError(400, new Error("Missing 'tool' field"));
					return;
				}

				const mcpSessionId = req.headers["x-bobbit-session-id"] as string | undefined;
				if (!mcpSessionId) {
					jsonError(403, new Error("Missing X-Bobbit-Session-Id header"));
					return;
				}
				const mcpSession = deps.sessionManager.getSession(mcpSessionId);
				const persistedSession = mcpSession ? null : (
					deps.projectContextManager.getContextForSession(mcpSessionId)?.sessionStore.get(mcpSessionId)
					?? null
				);
				if (!mcpSession && !persistedSession) {
					jsonError(403, new Error(`Session "${mcpSessionId}" not found`));
					return;
				}
				const toolStr = tool as string;
				if (!toolStr.startsWith("mcp__") && mcpSession?.allowedTools && mcpSession.allowedTools.length > 0) {
					if (!mcpSession.allowedTools.some((t: string) => t.toLowerCase() === toolStr.toLowerCase())) {
						jsonError(403, new Error(`Tool "${tool}" is not allowed for this session`));
						return;
					}
				}

				if (toolStr.startsWith("mcp__")) {
					const roleName = mcpSession?.role ?? (persistedSession as any)?.role;
					const role = roleName ? deps.roleManager.getRole(roleName) : undefined;
					const parsed = parseMcpToolName(toolStr);
					const opGroup = parsed?.server ? `MCP: ${parsed.server}` : undefined;
					const policy = resolveGrantPolicy(toolStr, opGroup, role, deps.toolManager, deps.groupPolicyStore);
					if (policy === "never") {
						jsonError(403, new Error(`tool ${toolStr} denied by policy`), { tool: toolStr, reason: "policy=never" });
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
				jsonError(500, new Error(e.message), { server: parsedServer, operation: parsedOperation, stack: e.stack });
			}
		},
	},
	{
		method: "POST",
		pattern: "/api/internal/mcp-describe",
		handler: async ({ deps, req, json, jsonError }) => {
			const mcpManager = deps.sessionManager.getMcpManager();
			if (!mcpManager) {
				jsonError(500, new Error("MCP not initialized"));
				return;
			}
			try {
				const body = await new Promise<string>((resolve) => {
					let data = "";
					req.on("data", (chunk: Buffer) => data += chunk.toString());
					req.on("end", () => resolve(data));
				});
				const parsed = JSON.parse(body || "{}");
				const server: string | undefined = parsed?.server;
				const operation: string | undefined = parsed?.operation;
				if (!server || typeof server !== "string") {
					jsonError(400, new Error("Missing 'server' field"));
					return;
				}

				const describeSessionId = req.headers["x-bobbit-session-id"] as string | undefined;
				if (!describeSessionId) {
					jsonError(403, new Error("Missing X-Bobbit-Session-Id header"));
					return;
				}
				const liveSession = deps.sessionManager.getSession(describeSessionId);
				const persistedSession = liveSession ? null : (
					deps.projectContextManager.getContextForSession(describeSessionId)?.sessionStore.get(describeSessionId)
					?? null
				);
				if (!liveSession && !persistedSession) {
					jsonError(403, new Error(`Session "${describeSessionId}" not found`));
					return;
				}

				const statuses = mcpManager.getServerStatuses();
				const status = statuses.find(s => s.name === server);
				if (!status || status.status !== "connected") {
					const reason = status?.error ?? (status ? status.status : "unknown server");
					jsonError(503, new Error(`server ${server} not connected: ${reason}`));
					return;
				}

				const infos = mcpManager.getToolInfos().filter(i => i.serverName === server);
				if (operation) {
					const match = infos.find(i => i.mcpToolName === operation);
					if (!match) {
						jsonError(404, new Error("operation not found"));
						return;
					}
					json({ tool: { name: match.mcpToolName, description: match.description, inputSchema: match.inputSchema } });
					return;
				}
				json({
					tools: infos.map(i => ({
						name: i.mcpToolName,
						description: i.description,
						inputSchema: i.inputSchema,
					})),
				});
			} catch (err) {
				const e = err as Error;
				console.error(`[mcp] Describe failed:`, e.stack || e);
				jsonError(500, new Error(e.message), { stack: e.stack });
			}
		},
	},
];
