/**
 * E2E tests for scoped sandbox tokens.
 */
import { test, expect } from "./gateway-harness.js";
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

	test("SandboxTokenStore register/lookup/remove lifecycle", async () => {
		const { SandboxTokenStore } = await import("../../dist/server/auth/sandbox-token.js");
		const store = new SandboxTokenStore();

		const token = store.register("s1", "g1");
		expect(token).toHaveLength(64);
		expect(store.register("s1", "g1")).toBe(token); // idempotent

		const scope = store.lookup(token);
		expect(scope).toBeTruthy();
		expect(scope!.sessionId).toBe("s1");
		expect(scope!.goalId).toBe("g1");
		expect(store.getTokenForSession("s1")).toBe(token);

		store.remove("s1");
		expect(store.lookup(token)).toBeUndefined();
		expect(store.getTokenForSession("s1")).toBeUndefined();
	});

	test("SandboxTokenStore child management", async () => {
		const { SandboxTokenStore } = await import("../../dist/server/auth/sandbox-token.js");
		const store = new SandboxTokenStore();

		const token = store.register("parent");
		store.addChild("parent", "child1");
		store.addChild("parent", "child2");

		const scope = store.lookup(token)!;
		expect(scope.childSessionIds.has("child1")).toBe(true);
		expect(scope.childSessionIds.has("child2")).toBe(true);
		expect(scope.childSessionIds.has("stranger")).toBe(false);

		// addChild on unknown parent is a no-op
		store.addChild("nonexistent", "orphan");
	});

	test("sandbox guard allows correct endpoints", async () => {
		const { isSandboxAllowed } = await import("../../dist/server/auth/sandbox-guard.js");
		const scope = { sessionId: "s1", goalId: "g1", childSessionIds: new Set(["child1"]) };

		// Always-allowed
		expect(isSandboxAllowed("/api/health", "GET", scope)).toBe(true);
		expect(isSandboxAllowed("/api/web-proxy/search", "POST", scope)).toBe(true);
		expect(isSandboxAllowed("/api/web-proxy/fetch", "POST", scope)).toBe(true);
		expect(isSandboxAllowed("/api/internal/mcp-call", "POST", scope)).toBe(true);
		expect(isSandboxAllowed("/api/preview", "POST", scope)).toBe(true);
		expect(isSandboxAllowed("/api/personalities", "GET", scope)).toBe(true);
		expect(isSandboxAllowed("/api/sessions", "POST", scope)).toBe(true);

		// Own session
		expect(isSandboxAllowed("/api/sessions/s1", "GET", scope)).toBe(true);
		expect(isSandboxAllowed("/api/sessions/s1", "PATCH", scope)).toBe(true);
		expect(isSandboxAllowed("/api/sessions/s1", "DELETE", scope)).toBe(true);
		expect(isSandboxAllowed("/api/sessions/s1/wait", "POST", scope)).toBe(true);

		// Child session
		expect(isSandboxAllowed("/api/sessions/child1", "GET", scope)).toBe(true);
		expect(isSandboxAllowed("/api/sessions/child1/wait", "POST", scope)).toBe(true);

		// Own goal
		expect(isSandboxAllowed("/api/goals/g1/team/agents", "GET", scope)).toBe(true);
		expect(isSandboxAllowed("/api/goals/g1/gates", "GET", scope)).toBe(true);
		expect(isSandboxAllowed("/api/goals/g1/tasks", "POST", scope)).toBe(true);
		expect(isSandboxAllowed("/api/goals/g1", "GET", scope)).toBe(true);
	});

	test("sandbox guard blocks dangerous endpoints", async () => {
		const { isSandboxAllowed } = await import("../../dist/server/auth/sandbox-guard.js");
		const scope = { sessionId: "s1", goalId: "g1", childSessionIds: new Set<string>() };

		expect(isSandboxAllowed("/api/project-config", "GET", scope)).toBe(false);
		expect(isSandboxAllowed("/api/project-config", "PUT", scope)).toBe(false);
		expect(isSandboxAllowed("/api/preferences", "GET", scope)).toBe(false);
		expect(isSandboxAllowed("/api/roles", "GET", scope)).toBe(false);
		expect(isSandboxAllowed("/api/sessions", "GET", scope)).toBe(false);
		expect(isSandboxAllowed("/api/mcp-servers", "GET", scope)).toBe(false);

		// bg-processes — sandbox escape vector
		expect(isSandboxAllowed("/api/sessions/s1/bg-processes", "POST", scope)).toBe(false);
		expect(isSandboxAllowed("/api/sessions/s1/bg-processes/pid/logs", "GET", scope)).toBe(false);

		// Other session
		expect(isSandboxAllowed("/api/sessions/other", "GET", scope)).toBe(false);

		// Other goal
		expect(isSandboxAllowed("/api/goals/other-goal/gates", "GET", scope)).toBe(false);
	});

	test("no goalId blocks all goal endpoints", async () => {
		const { isSandboxAllowed } = await import("../../dist/server/auth/sandbox-guard.js");
		const scope = { sessionId: "s1", childSessionIds: new Set<string>() };

		expect(isSandboxAllowed("/api/goals/any/gates", "GET", scope)).toBe(false);
		expect(isSandboxAllowed("/api/goals/any/tasks", "GET", scope)).toBe(false);
	});
});
