/**
 * E2E tests for scoped sandbox tokens (per-project model).
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken } from "./e2e-setup.js";

function fetchWithToken(baseUrl: string, path: string, token: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${baseUrl}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

test.describe("Sandbox Token Scoping", () => {

	test("admin token still works for all endpoints", async ({ gateway }) => {
		const adminToken = readE2EToken();
		const r1 = await fetchWithToken(gateway.baseURL, "/api/health", adminToken);
		expect(r1.status).toBe(200);
		const r2 = await fetchWithToken(gateway.baseURL, "/api/sessions", adminToken);
		expect(r2.status).toBe(200);
		const r3 = await fetchWithToken(gateway.baseURL, "/api/preferences", adminToken);
		expect(r3.status).toBe(200);
	});

	test("unknown token returns 401", async ({ gateway }) => {
		const fake = "a".repeat(64);
		const resp = await fetchWithToken(gateway.baseURL, "/api/sessions", fake);
		expect(resp.status).toBe(401);
	});

	test("SandboxTokenStore per-project register/lookup/remove lifecycle", async () => {
		const { SandboxTokenStore } = await import("../../dist/server/auth/sandbox-token.js");
		const store = new SandboxTokenStore();

		// Register returns a token for the project
		const token = store.register("project-1");
		expect(token).toHaveLength(64);
		// Idempotent — same token on second call
		expect(store.register("project-1")).toBe(token);

		// Lookup returns scope with projectId
		const scope = store.lookup(token);
		expect(scope).toBeTruthy();
		expect(scope!.projectId).toBe("project-1");
		expect(scope!.sessionIds).toBeInstanceOf(Set);
		expect(scope!.goalIds).toBeInstanceOf(Set);

		// Reverse lookup by projectId
		expect(store.getTokenForProject("project-1")).toBe(token);

		// Remove the project
		store.remove("project-1");
		expect(store.lookup(token)).toBeUndefined();
		expect(store.getTokenForProject("project-1")).toBeUndefined();
	});

	test("SandboxTokenStore session and goal tracking", async () => {
		const { SandboxTokenStore } = await import("../../dist/server/auth/sandbox-token.js");
		const store = new SandboxTokenStore();

		const token = store.register("project-1");

		// Add sessions to the project scope
		store.addSession("project-1", "session-1");
		store.addSession("project-1", "session-2");

		// Add goals to the project scope
		store.addGoal("project-1", "goal-1");

		const scope = store.lookup(token)!;
		expect(scope.sessionIds.has("session-1")).toBe(true);
		expect(scope.sessionIds.has("session-2")).toBe(true);
		expect(scope.sessionIds.has("stranger")).toBe(false);
		expect(scope.goalIds.has("goal-1")).toBe(true);
		expect(scope.goalIds.has("other-goal")).toBe(false);

		// Remove a session
		store.removeSession("project-1", "session-1");
		const scope2 = store.lookup(token)!;
		expect(scope2.sessionIds.has("session-1")).toBe(false);
		expect(scope2.sessionIds.has("session-2")).toBe(true);

		// addSession on unknown project is a no-op
		store.addSession("nonexistent", "orphan");
	});

	test("sandbox guard allows correct endpoints (per-project model)", async () => {
		const { isSandboxAllowed } = await import("../../dist/server/auth/sandbox-guard.js");
		const scope = {
			projectId: "p1",
			goalIds: new Set(["g1"]),
			sessionIds: new Set(["s1", "child1"]),
		};

		// Always-allowed
		expect(isSandboxAllowed("/api/health", "GET", scope)).toBe(true);
		expect(isSandboxAllowed("/api/internal/mcp-call", "POST", scope)).toBe(false);
		expect(isSandboxAllowed("/api/preview", "POST", scope)).toBe(true);
		expect(isSandboxAllowed("/api/personalities", "GET", scope)).toBe(true);
		expect(isSandboxAllowed("/api/sessions", "POST", scope)).toBe(true);

		// Own session (tracked under project)
		expect(isSandboxAllowed("/api/sessions/s1", "GET", scope)).toBe(true);
		expect(isSandboxAllowed("/api/sessions/s1", "PATCH", scope)).toBe(true);
		expect(isSandboxAllowed("/api/sessions/s1", "DELETE", scope)).toBe(true);
		expect(isSandboxAllowed("/api/sessions/s1/wait", "POST", scope)).toBe(true);

		// Child session (also tracked under project)
		expect(isSandboxAllowed("/api/sessions/child1", "GET", scope)).toBe(true);
		expect(isSandboxAllowed("/api/sessions/child1/wait", "POST", scope)).toBe(true);

		// Own goal
		expect(isSandboxAllowed("/api/goals/g1/team/agents", "GET", scope)).toBe(true);
		expect(isSandboxAllowed("/api/goals/g1/gates", "GET", scope)).toBe(true);
		expect(isSandboxAllowed("/api/goals/g1/tasks", "POST", scope)).toBe(true);
		expect(isSandboxAllowed("/api/goals/g1", "GET", scope)).toBe(true);

		// Task endpoints (tool extensions use /api/tasks/:id directly)
		expect(isSandboxAllowed("/api/tasks/t1", "GET", scope)).toBe(true);
		expect(isSandboxAllowed("/api/tasks/t1", "PUT", scope)).toBe(true);
		expect(isSandboxAllowed("/api/tasks/t1/assign", "POST", scope)).toBe(true);
		expect(isSandboxAllowed("/api/tasks/t1/transition", "POST", scope)).toBe(true);
		expect(isSandboxAllowed("/api/tasks/t1", "DELETE", scope)).toBe(false);
	});

	test("sandbox guard blocks dangerous endpoints (per-project model)", async () => {
		const { isSandboxAllowed } = await import("../../dist/server/auth/sandbox-guard.js");
		const scope = {
			projectId: "p1",
			goalIds: new Set(["g1"]),
			sessionIds: new Set(["s1"]),
		};

		// Web proxy endpoints removed — should now be blocked
		expect(isSandboxAllowed("/api/web-proxy/search", "POST", scope)).toBe(false);
		expect(isSandboxAllowed("/api/web-proxy/fetch", "POST", scope)).toBe(false);

		expect(isSandboxAllowed("/api/project-config", "GET", scope)).toBe(false);
		expect(isSandboxAllowed("/api/project-config", "PUT", scope)).toBe(false);
		expect(isSandboxAllowed("/api/preferences", "GET", scope)).toBe(false);
		expect(isSandboxAllowed("/api/roles", "GET", scope)).toBe(false);
		expect(isSandboxAllowed("/api/sessions", "GET", scope)).toBe(false);
		expect(isSandboxAllowed("/api/mcp-servers", "GET", scope)).toBe(false);

		// bg-processes — allowed on own session (runs via docker exec inside container)
		expect(isSandboxAllowed("/api/sessions/s1/bg-processes", "POST", scope)).toBe(true);
		expect(isSandboxAllowed("/api/sessions/s1/bg-processes/pid/logs", "GET", scope)).toBe(true);

		// bg-processes — blocked on OTHER session
		expect(isSandboxAllowed("/api/sessions/other/bg-processes", "POST", scope)).toBe(false);
		expect(isSandboxAllowed("/api/sessions/other/bg-processes/pid/logs", "GET", scope)).toBe(false);

		// Other session
		expect(isSandboxAllowed("/api/sessions/other", "GET", scope)).toBe(false);

		// Other goal
		expect(isSandboxAllowed("/api/goals/other-goal/gates", "GET", scope)).toBe(false);
	});

	test("no goalIds blocks all goal endpoints", async () => {
		const { isSandboxAllowed } = await import("../../dist/server/auth/sandbox-guard.js");
		const scope = {
			projectId: "p1",
			goalIds: new Set<string>(),
			sessionIds: new Set(["s1"]),
		};

		expect(isSandboxAllowed("/api/goals/any/gates", "GET", scope)).toBe(false);
		expect(isSandboxAllowed("/api/goals/any/tasks", "GET", scope)).toBe(false);
	});
});
