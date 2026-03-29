import type { AppContext } from "../app-context.js";
import http from "node:http";

// Route modules — each exports handle(ctx, url, req, res) => Promise<boolean>
import * as health from "./health.js";
import * as sessions from "./sessions.js";
import * as goals from "./goals.js";
import * as teams from "./teams.js";
import * as gates from "./gates.js";
import * as tasks from "./tasks.js";
import * as roles from "./roles.js";
import * as tools from "./tools.js";
import * as aigw from "./aigw.js";
import * as models from "./models.js";
import * as preferences from "./preferences.js";
import * as personalities from "./personalities.js";
import * as workflows from "./workflows.js";
import * as auth from "./auth.js";
import * as skills from "./skills.js";
import * as staff from "./staff.js";
import * as mcp from "./mcp.js";
import * as git from "./git.js";
import * as preview from "./preview.js";

export type RouteHandler = (
	ctx: AppContext,
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
) => Promise<boolean>;

// Ordered handler list. Multiple handlers can share a prefix — the router
// tries each in order and stops at the first one that returns true.
// More-specific handlers (teams, gates, tasks under /api/goals) are listed
// before less-specific ones (goals) so they get first crack.
const handlers: Array<{ prefix: string; handle: RouteHandler }> = [
	// Health / setup / shutdown
	{ prefix: "/api/health", handle: health.handle },
	{ prefix: "/api/setup-status", handle: health.handle },
	{ prefix: "/api/shutdown", handle: health.handle },

	// Auth
	{ prefix: "/api/ca-cert", handle: auth.handle },
	{ prefix: "/api/connection-info", handle: auth.handle },
	{ prefix: "/api/oauth", handle: auth.handle },

	// Sessions (git sub-routes tried first via git.handle)
	{ prefix: "/api/sessions", handle: git.handle },
	{ prefix: "/api/sessions", handle: sessions.handle },

	// Goals sub-resources (more-specific before less-specific)
	{ prefix: "/api/goals", handle: teams.handle },
	{ prefix: "/api/goals", handle: gates.handle },
	{ prefix: "/api/goals", handle: tasks.handle },
	{ prefix: "/api/goals", handle: git.handle },
	{ prefix: "/api/goals", handle: goals.handle },

	// Tasks (top-level /api/tasks/:id)
	{ prefix: "/api/tasks", handle: tasks.handle },

	// Tools
	{ prefix: "/api/tools", handle: tools.handle },

	// Config / preferences
	{ prefix: "/api/config", handle: preferences.handle },
	{ prefix: "/api/preferences", handle: preferences.handle },
	{ prefix: "/api/project-config", handle: preferences.handle },

	// PR status cache (bulk hydration)
	{ prefix: "/api/pr-status-cache", handle: git.handle },
	{ prefix: "/api/models", handle: models.handle },

	// AI Gateway
	{ prefix: "/api/custom-providers", handle: aigw.handle },
	{ prefix: "/api/provider-keys", handle: aigw.handle },
	{ prefix: "/api/aigw", handle: aigw.handle },

	// Roles & personalities
	{ prefix: "/api/roles", handle: roles.handle },
	{ prefix: "/api/personalities", handle: personalities.handle },

	// Workflows
	{ prefix: "/api/workflows", handle: workflows.handle },

	// Skills
	{ prefix: "/api/slash-skills", handle: skills.handle },

	// Preview
	{ prefix: "/api/preview", handle: preview.handle },

	// Staff
	{ prefix: "/api/staff", handle: staff.handle },

	// MCP
	{ prefix: "/api/mcp-servers", handle: mcp.handle },
	{ prefix: "/api/internal/mcp-call", handle: mcp.handle },
];

/**
 * Route an API request through the handler chain.
 * Tries each handler whose prefix matches the URL pathname.
 * Returns 404 if no handler claims the request.
 */
export async function routeApiRequest(
	ctx: AppContext,
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	for (const { prefix, handle } of handlers) {
		if (url.pathname === prefix || url.pathname.startsWith(prefix + "/")) {
			const handled = await handle(ctx, url, req, res);
			if (handled) return;
		}
	}
	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "Not found" }));
}
