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
	if (pathname === "/api/preview" && m === "POST") return true;
	if (pathname === "/api/personalities" && (m === "GET" || m === "POST")) return true;

	// ── Session creation (delegates) ──────────────────────────────────
	// POST /api/sessions — server.ts forces sandboxed:true for sandbox tokens
	if (pathname === "/api/sessions" && m === "POST") return true;

	// ── Session-scoped endpoints ──────────────────────────────────────
	const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
	if (sessionMatch) {
		const targetId = sessionMatch[1];
		const subpath = sessionMatch[2] || "";
		const isOwnOrChild = targetId === scope.sessionId || scope.childSessionIds.has(targetId);

		if (!isOwnOrChild) return false;

		// bg-processes: allowed for own session (spawns via docker exec inside container)
		if (subpath.startsWith("/bg-processes")) return true;

		if (m === "GET" && subpath === "") return true;       // session info
		if (m === "PATCH" && subpath === "") return true;     // preview_open metadata
		if (m === "DELETE" && subpath === "") return true;    // delegate cleanup
		if (m === "POST" && subpath === "/wait") return true; // delegate wait

		return false;
	}

	// ── Goal-scoped endpoints ─────────────────────────────────────────
	if (scope.goalId) {
		const goalMatch = pathname.match(/^\/api\/goals\/([^/]+)(\/.*)?$/);
		if (goalMatch) {
			const targetGoalId = goalMatch[1];
			const subpath = goalMatch[2] || "";
			if (targetGoalId !== scope.goalId) return false;

			if (subpath.startsWith("/team")) return true;
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
