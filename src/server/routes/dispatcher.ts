/**
 * Dispatcher — single entry-point for REST routes after auth/sandbox-scope
 * resolution in `requestHandler`. Iterates `allRoutes` in registration order
 * and invokes the first matching handler.
 *
 * Order: domain modules are registered in the exact order below. Within each
 * module, routes are listed most-specific-first. Both layers are necessary
 * only for robustness — every pattern is anchored, so at most one match
 * exists per request. Anchored-regex contract is pinned by
 * `tests/routes-anchor-pinned.test.ts`.
 */
import type http from "node:http";
import type { SandboxScope } from "../auth/sandbox-token.js";
import { matchRoute } from "./match-route.js";
import { readBody } from "./route-helpers.js";
import type { Route, RouteContext } from "./types.js";
import type { RouteDeps } from "./route-deps.js";
import { healthRoutes } from "./health.js";
import { sandboxRoutes } from "./sandbox.js";
import { oauthRoutes } from "./oauth.js";
import { imageGenerationRoutes } from "./image-generation.js";
import { modelsRoutes } from "./models.js";
import { preferencesConfigRoutes } from "./preferences-config.js";
import { rolesRoutes } from "./roles.js";
import { toolsRoutes } from "./tools.js";
import { skillsRoutes } from "./skills.js";
import { workflowsRoutes } from "./workflows.js";
import { staffRoutes } from "./staff.js";
import { mcpRoutes } from "./mcp.js";
import { maintenanceRoutes } from "./maintenance.js";
import { costRoutes } from "./cost.js";
import { projectsRoutes } from "./projects.js";
import { tasksRoutes } from "./tasks.js";
import { gatesRoutes } from "./gates.js";
import { goalsRoutes } from "./goals.js";
import { goalsGitRoutes } from "./goals-git.js";
import { sessionsBgRoutes } from "./sessions-bg.js";
import { sessionsReviewRoutes } from "./sessions-review.js";
import { sessionsGitRoutes } from "./sessions-git.js";
import { previewRoutes } from "./preview.js";
import { sessionsContentRoutes } from "./sessions-content.js";
import { sessionsProposalsRoutes } from "./sessions-proposals.js";

// Registered route arrays — populated as domain migrations land. Each
// `routes/<domain>.ts` exports a `<domain>Routes: Route[]` array. Until all
// migrations land, unmatched requests fall through to the legacy
// `handleApiRoute()` (see requestHandler in server.ts).
const allRoutes: ReadonlyArray<Route> = [
	...healthRoutes,
	...sandboxRoutes,
	...oauthRoutes,
	...imageGenerationRoutes,
	...modelsRoutes,
	...preferencesConfigRoutes,
	...rolesRoutes,
	...toolsRoutes,
	...skillsRoutes,
	...workflowsRoutes,
	...staffRoutes,
	...mcpRoutes,
	...maintenanceRoutes,
	...costRoutes,
	...projectsRoutes,
	...tasksRoutes,
	...gatesRoutes,
	...goalsGitRoutes,
	...goalsRoutes,
	...sessionsBgRoutes,
	...sessionsReviewRoutes,
	...sessionsGitRoutes,
	...previewRoutes,
	...sessionsContentRoutes,
	...sessionsProposalsRoutes,
];

/**
 * Try to dispatch a request to a registered route handler. Returns true if
 * the request was handled, false if no route matched (caller should fall
 * through to the legacy handler).
 */
export async function dispatch(
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
	deps: RouteDeps,
	sandboxScope?: SandboxScope,
): Promise<boolean> {
	const m = matchRoute(req.method ?? "GET", url.pathname, allRoutes);
	if (!m) return false;
	const json = (body: unknown, status = 200) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	};
	const ctx: RouteContext = {
		req,
		res,
		url,
		pathname: url.pathname,
		params: m.params,
		sandboxScope,
		readBody: () => readBody(req),
		json,
		jsonError: (status, err, extra) => {
			const e = err instanceof Error ? err : new Error(String(err));
			json({ error: e.message, stack: e.stack, ...extra }, status);
		},
		deps,
	};
	await m.route.handler(ctx);
	return true;
}
