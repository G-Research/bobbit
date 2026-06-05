import type { SandboxScope } from "./sandbox-token.js";

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
	// POST /api/sessions — server.ts forces sandboxed:true for sandbox tokens
	if (pathname === "/api/sessions" && m === "POST") return true;

	// ── Session-scoped endpoints ──────────────────────────────────────
	const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
	if (sessionMatch) {
		const targetId = sessionMatch[1];
		const subpath = sessionMatch[2] || "";
		const isOwnSession = scope.sessionIds.has(targetId);

		if (!isOwnSession) return false;

		// bg-processes: allowed for own session (spawns via docker exec inside container)
		if (subpath.startsWith("/bg-processes")) return true;

		if (m === "GET" && subpath === "") return true;       // session info
		if (m === "PATCH" && subpath === "") return true;     // preview_open metadata
		if (m === "DELETE" && subpath === "") return true;    // delegate cleanup
		if (m === "POST" && subpath === "/wait") return true; // delegate wait

		return false;
	}

	// ── Goal-scoped endpoints ─────────────────────────────────────────
	if (scope.goalIds.size > 0) {
		const goalMatch = pathname.match(/^\/api\/goals\/([^/]+)(\/.*)?$/);
		if (goalMatch) {
			const targetGoalId = goalMatch[1];
			const subpath = goalMatch[2] || "";
			if (!scope.goalIds.has(targetGoalId)) return false;

			if (subpath.startsWith("/team")) return true;
			// /signoff and /reset are human-only actions — a sandboxed agent must
			// not be able to self-approve or invalidate workflow gates.
			// Block before the broad /gates allow-rule.
			if (/^\/gates\/[^/]+\/(signoff|reset)$/.test(subpath)) return false;
			if (subpath.startsWith("/gates")) return true;
			if (subpath.startsWith("/tasks")) return true;
			if (m === "GET" && subpath === "") return true;

			return false;
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
