import type { SandboxScope } from "./sandbox-token.js";

function isKnownProposalSubpath(subpath: string, method: string): boolean {
	const proposalMatch = subpath.match(/^\/proposal\/[^/]+(\/edit|\/seed|\/restore|\/snapshot)?$/);
	if (!proposalMatch) return false;
	const suffix = proposalMatch[1] || "";
	if (suffix === "") return method === "GET" || method === "DELETE";
	if (suffix === "/snapshot") return method === "GET";
	if (suffix === "/edit" || suffix === "/seed" || suffix === "/restore") return method === "POST";
	return false;
}

function isOwnSessionToolEndpoint(subpath: string, method: string): boolean {
	// Agent/process tools under defaults/tools/**. These are allowed only after
	// the caller's token has already matched the :sessionId in the route.
	if (subpath.startsWith("/bg-processes")) return true;
	if (method === "GET" && subpath === "/google-code-assist/token") return true;
	if (method === "POST" && subpath === "/tool-grant-request") return true;
	if (method === "POST" && subpath === "/activate-skill") return true;
	if (method === "GET" && subpath === "/transcript") return true;
	if (method === "POST" && subpath === "/prompt") return true;
	if (method === "GET" && subpath === "/proposals") return true;
	if (isKnownProposalSubpath(subpath, method)) return true;

	const orchestrateMatch = subpath.match(/^\/orchestrate\/([a-z]+)$/);
	if (orchestrateMatch) {
		const verb = orchestrateMatch[1];
		if (verb === "children") return method === "GET";
		return method === "POST" && ["spawn", "prompt", "steer", "abort", "dismiss", "wait", "delegate"].includes(verb);
	}

	return false;
}

function isOwnGoalToolEndpoint(subpath: string, method: string): boolean {
	if (method === "GET" && subpath === "") return true;

	// Team/task/gate tools are goal-scoped by the :goalId in the route.
	if (subpath.startsWith("/team")) return true;
	if (subpath.startsWith("/tasks")) return true;

	// /signoff and /reset are human-only actions — an agent must not be able to
	// self-approve or invalidate workflow gates. Block before the broad /gates
	// allow-rule. (The human-only bypass endpoint is also blocked here.)
	if (/^\/gates\/[^/]+\/(signoff|reset|bypass)$/.test(subpath)) return false;
	if (subpath.startsWith("/gates")) return true;

	// Children/nested-goal tools. The parent goal id in the path must be in the
	// token scope; handlers perform the finer child/session-secret checks.
	if (method === "POST" && subpath === "/spawn-child") return true;
	if ((method === "GET" || method === "PATCH") && subpath === "/plan") return true;
	if (method === "POST" && /^\/integrate-child\/[^/]+$/.test(subpath)) return true;
	if (method === "POST" && (subpath === "/pause" || subpath === "/resume")) return true;
	if (method === "DELETE" && /^\/archive-child\/[^/]+$/.test(subpath)) return true;
	if (method === "POST" && /^\/mutation\/[^/]+\/decision$/.test(subpath)) return true;
	if (method === "PATCH" && subpath === "/policy") return true;

	return false;
}

/**
 * Check if a sandbox-scoped token is allowed to access the given API route.
 *
 * Returns true if the request is allowed, false → 403.
 * Everything not explicitly listed is blocked.
 */
export function isSandboxAllowed(
	pathname: string,
	method: string,
	scope: SandboxScope,
): boolean {
	const m = method.toUpperCase();

	// ── Always-allowed endpoints ───────────────────────────────────────
	if (pathname === "/api/health" && m === "GET") return true;
	// MCP calls are blocked — sandbox agents must not trigger host-side execution.
	// if (pathname === "/api/internal/mcp-call" && m === "POST") return true;
	if (pathname === "/api/internal/verification-result" && m === "POST") return true;
	// mcp_describe is a discovery/read endpoint used by the first-party MCP tool.
	// Its handler requires X-Bobbit-Session-Id and resolves discovery from that
	// session's project scope; this guard only lets the request reach that scoped
	// handler, not the host-side /api/internal/mcp-call executor above.
	if (pathname === "/api/internal/mcp-describe" && m === "POST") return true;
	// PR walkthrough YAML submission is allowed through the sandbox guard; the
	// route manager performs the scoped child-session/job ownership check.
	if (pathname === "/api/internal/pr-walkthrough/submit-yaml" && m === "POST") return true;
	// /api/internal/user-question/submit is called from UI widgets (not the
	// sandboxed agent) — the legacy POST /api/internal/user-question used by the
	// blocking tool extension has been removed.
	// Embedded-preview mount endpoint — the only preview surface the agent
	// is allowed to call (WP-B/WP-D/WP-G). Per-session content is served
	// via the cookie-authed `/preview/<sid>/...` route, which is not
	// reachable from the agent.
	if (pathname === "/api/preview/mount" && m === "POST") return true;
	// Image generation: handler enforces session-scope ownership against sandboxScope
	// (rejects with 403 if body.sessionId is missing or outside scope).
	if (pathname === "/api/image-generation/generate" && m === "POST") return true;

	// ── Session creation (delegates) ──────────────────────────────────
	// POST /api/sessions — server.ts forces sandboxed:true for sandbox tokens.
	// Bare POST /api/goals is intentionally NOT listed here.
	if (pathname === "/api/sessions" && m === "POST") return true;

	// ── Session-scoped endpoints ──────────────────────────────────────
	const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
	if (sessionMatch) {
		const targetId = sessionMatch[1];
		const subpath = sessionMatch[2] || "";
		const isOwnSession = scope.sessionIds.has(targetId);

		if (!isOwnSession) return false;

		if (m === "GET" && subpath === "") return true;       // session info
		if (m === "PATCH" && subpath === "") return true;     // preview_open metadata
		if (m === "DELETE" && subpath === "") return true;    // delegate cleanup
		if (m === "POST" && subpath === "/wait") return true; // delegate wait
		if (isOwnSessionToolEndpoint(subpath, m)) return true;

		return false;
	}

	// ── Goal-scoped endpoints ─────────────────────────────────────────
	if (scope.goalIds.size > 0) {
		const goalMatch = pathname.match(/^\/api\/goals\/([^/]+)(\/.*)?$/);
		if (goalMatch) {
			const targetGoalId = goalMatch[1];
			const subpath = goalMatch[2] || "";
			if (!scope.goalIds.has(targetGoalId)) return false;
			return isOwnGoalToolEndpoint(subpath, m);
		}
	}

	// ── Task endpoints (tool extensions use /api/tasks/:id directly) ──
	const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(\/.*)?$/);
	if (taskMatch) {
		const subpath = taskMatch[2] || "";
		if (m === "GET" && subpath === "") return true;        // task info read-back
		if (m === "PUT" && subpath === "") return true;        // task_update fields
		if (m === "POST" && subpath === "/assign") return true;     // task assignment
		if (m === "POST" && subpath === "/transition") return true; // task state change
		return false;
	}

	// ── Everything else: BLOCKED ──────────────────────────────────────
	return false;
}
