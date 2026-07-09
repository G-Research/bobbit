// v2-native — bobbit gateway tool suite. Listed in tests-map.json `v2Native`.
//
// Operation dispatch: path building (ids, query, probe/action selectors,
// cascade), body building, and HTTP method correctness per representative op.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { describe, it, expect, beforeAll } from "vitest";
import { loadBobbitTools, stubFetch, type CapturedTool, type FetchCall } from "./helpers/bobbit-harness.ts";

let tools: Map<string, CapturedTool>;

beforeAll(() => {
	process.env.BOBBIT_TOKEN = "tok";
	process.env.BOBBIT_GATEWAY_URL = "https://gw.test";
	tools = loadBobbitTools();
});

async function run(tool: string, params: any): Promise<FetchCall> {
	const calls = stubFetch();
	await tools.get(tool)!.execute("id", params);
	expect(calls.length).toBe(1);
	return calls[0];
}

describe("bobbit_read — path & query building", () => {
	it("get_goal builds GET /api/goals/:id", async () => {
		const c = await run("bobbit_read", { operation: "get_goal", goalId: "g1" });
		expect(c.method).toBe("GET");
		expect(c.url).toBe("https://gw.test/api/goals/g1");
	});

	it("search encodes q/type as query string", async () => {
		const c = await run("bobbit_read", { operation: "search", q: "foo", type: "goals" });
		expect(c.method).toBe("GET");
		expect(c.url).toContain("/api/search?");
		expect(c.url).toContain("q=foo");
		expect(c.url).toContain("type=goals");
	});

	it("maintenance_inspect maps probe to its path", async () => {
		const c = await run("bobbit_read", { operation: "maintenance_inspect", probe: "worktree_pool" });
		expect(c.url).toBe("https://gw.test/api/worktree-pool");
	});

	it("maintenance_inspect appends projectId for index-row probes", async () => {
		const c = await run("bobbit_read", {
			operation: "maintenance_inspect",
			probe: "orphaned_index_rows",
			projectId: "p1",
		});
		expect(c.url).toBe("https://gw.test/api/maintenance/orphaned-index-rows?projectId=p1");
	});
});

describe("bobbit_orchestrate — method, query & body building", () => {
	it("archive_goal is DELETE with cascade query", async () => {
		const c = await run("bobbit_orchestrate", { operation: "archive_goal", goalId: "g1", cascade: true });
		expect(c.method).toBe("DELETE");
		expect(c.url).toBe("https://gw.test/api/goals/g1?cascade=true");
	});

	it("create_goal is POST and merges projectId/title into the body", async () => {
		const c = await run("bobbit_orchestrate", {
			operation: "create_goal",
			projectId: "p1",
			title: "My Goal",
			body: { spec: "do it", workflowId: "general" },
		});
		expect(c.method).toBe("POST");
		expect(c.url).toBe("https://gw.test/api/goals");
		expect(c.body).toEqual({ projectId: "p1", title: "My Goal", spec: "do it", workflowId: "general" });
	});

	it("update_goal is PUT", async () => {
		const c = await run("bobbit_orchestrate", { operation: "update_goal", goalId: "g1", body: { title: "x" } });
		expect(c.method).toBe("PUT");
		expect(c.url).toBe("https://gw.test/api/goals/g1");
		expect(c.body).toEqual({ title: "x" });
	});

	it("delete_staff is DELETE with no body", async () => {
		const c = await run("bobbit_orchestrate", { operation: "delete_staff", staffId: "staff-1" });
		expect(c.method).toBe("DELETE");
		expect(c.url).toBe("https://gw.test/api/staff/staff-1");
		expect(c.body).toBeUndefined();
	});

	it("transition_task sends { state } in the body", async () => {
		const c = await run("bobbit_orchestrate", { operation: "transition_task", taskId: "t1", state: "complete" });
		expect(c.method).toBe("POST");
		expect(c.url).toBe("https://gw.test/api/tasks/t1/transition");
		expect(c.body).toEqual({ state: "complete" });
	});

	it("signal_gate posts the free-form body", async () => {
		const c = await run("bobbit_orchestrate", {
			operation: "signal_gate",
			goalId: "g1",
			gateId: "ga",
			body: { content: "ready", sessionId: "s1" },
		});
		expect(c.method).toBe("POST");
		expect(c.url).toBe("https://gw.test/api/goals/g1/gates/ga/signal");
		expect(c.body).toEqual({ content: "ready", sessionId: "s1" });
	});
});

describe("bobbit_admin — path & body building", () => {
	it("maintenance_cleanup maps action to its POST path", async () => {
		const c = await run("bobbit_admin", { operation: "maintenance_cleanup", action: "sessions" });
		expect(c.method).toBe("POST");
		expect(c.url).toBe("https://gw.test/api/maintenance/cleanup-sessions");
	});

	it("set_provider_key POSTs { key } to the provider path", async () => {
		const c = await run("bobbit_admin", { operation: "set_provider_key", provider: "openai", key: "sk-1" });
		expect(c.method).toBe("POST");
		expect(c.url).toBe("https://gw.test/api/provider-keys/openai");
		expect(c.body).toEqual({ key: "sk-1" });
	});

	it("custom_providers delete selects DELETE and the id path", async () => {
		const c = await run("bobbit_admin", { operation: "custom_providers", action: "delete", id: "cp1" });
		expect(c.method).toBe("DELETE");
		expect(c.url).toBe("https://gw.test/api/custom-providers/cp1");
	});

	it("update_project_config is PUT with the config body", async () => {
		const c = await run("bobbit_admin", {
			operation: "update_project_config",
			projectId: "p1",
			config: { foo: "bar" },
		});
		expect(c.method).toBe("PUT");
		expect(c.url).toBe("https://gw.test/api/projects/p1/config");
		expect(c.body).toEqual({ foo: "bar" });
	});
});
