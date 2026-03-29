import http from "node:http";
import type { AppContext } from "../app-context.js";
import { json, readBody } from "./utils.js";

export async function handle(ctx: AppContext, url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
	const { sessionManager, toolManager } = ctx;

	// GET /api/mcp-servers
	if (url.pathname === "/api/mcp-servers" && req.method === "GET") {
		const mcpManager = sessionManager.getMcpManager();
		if (!mcpManager) {
			json(res, []);
			return true;
		}
		const statuses = mcpManager.getServerStatuses();
		const toolInfos = mcpManager.getToolInfos();
		const result = statuses.map(s => ({
			...s,
			tools: toolInfos.filter(t => t.serverName === s.name).map(t => ({ name: t.name, description: t.description })),
		}));
		json(res, result);
		return true;
	}

	// POST /api/mcp-servers/:name/restart
	const mcpRestartMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/restart$/);
	if (mcpRestartMatch && req.method === "POST") {
		const mcpManager = sessionManager.getMcpManager();
		if (!mcpManager) {
			json(res, { error: "MCP not initialized" }, 500);
			return true;
		}
		const serverName = decodeURIComponent(mcpRestartMatch[1]);
		let statuses = mcpManager.getServerStatuses();
		let existing = statuses.find(s => s.name === serverName);
		if (!existing || !existing.config) {
			// Re-discover servers in case config was added after startup
			const discovered = mcpManager.discoverServers();
			if (!discovered[serverName]) {
				json(res, { error: `MCP server "${serverName}" not found` }, 404);
				return true;
			}
			// Connect the newly discovered server
			await mcpManager.connectServer(serverName, discovered[serverName]);
		} else {
			await mcpManager.disconnectServer(serverName);
			await mcpManager.connectServer(serverName, existing.config);
		}
		// Re-register MCP tools with ToolManager
		if (toolManager) {
			toolManager.removeExternalTools("mcp__");
			const infos = mcpManager.getToolInfos();
			toolManager.registerExternalTools(infos.map(info => ({
				name: info.name,
				description: info.description,
				summary: info.description,
				group: info.group,
				docs: info.docs,
				provider: { type: 'mcp' as const, server: info.serverName, mcpTool: info.mcpToolName },
			})));
		}
		const updated = mcpManager.getServerStatuses().find(s => s.name === serverName);
		json(res, { ok: true, ...updated });
		return true;
	}

	// POST /api/internal/mcp-call
	if (url.pathname === "/api/internal/mcp-call" && req.method === "POST") {
		const mcpManager = sessionManager.getMcpManager();
		if (!mcpManager) {
			json(res, { error: "MCP not initialized" }, 500);
			return true;
		}
		try {
			const body = await readBody(req);
			if (!body) {
				json(res, { error: "Invalid request body" }, 400);
				return true;
			}
			const { tool, args } = body;
			if (!tool) {
				json(res, { error: "Missing 'tool' field" }, 400);
				return true;
			}
			const result = await mcpManager.callTool(tool, args || {});
			json(res, result);
		} catch (err) {
			json(res, { error: (err as Error).message }, 500);
		}
		return true;
	}

	return false;
}
