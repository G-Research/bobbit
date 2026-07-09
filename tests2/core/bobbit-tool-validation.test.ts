// v2-native — bobbit gateway tool suite. Listed in tests-map.json `v2Native`.
//
// Runtime validation: unknown operation and missing required params (including
// the mandatory projectId for create_goal/create_session) return an error
// result WITHOUT issuing a fetch.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { describe, it, expect, beforeAll } from "vitest";
import { loadBobbitTools, stubFetch, type CapturedTool } from "./helpers/bobbit-harness.ts";

let tools: Map<string, CapturedTool>;

beforeAll(() => {
	process.env.BOBBIT_TOKEN = "tok";
	process.env.BOBBIT_GATEWAY_URL = "https://gw.test";
	tools = loadBobbitTools();
});

function text(result: any): string {
	return result?.content?.[0]?.text ?? "";
}

describe("bobbit tools — operation validation", () => {
	it("unknown operation → isError, no fetch", async () => {
		const calls = stubFetch();
		const result = await tools.get("bobbit_read")!.execute("id", { operation: "no_such_op" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("unknown operation");
		expect(calls.length).toBe(0);
	});

	it("get_goal without goalId → isError, no fetch", async () => {
		const calls = stubFetch();
		const result = await tools.get("bobbit_read")!.execute("id", { operation: "get_goal" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("goalId");
		expect(calls.length).toBe(0);
	});

	it("create_goal without projectId → isError, no fetch", async () => {
		const calls = stubFetch();
		const result = await tools.get("bobbit_orchestrate")!.execute("id", { operation: "create_goal", title: "x" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("projectId");
		expect(calls.length).toBe(0);
	});

	it("create_session without projectId → isError, no fetch", async () => {
		const calls = stubFetch();
		const result = await tools.get("bobbit_orchestrate")!.execute("id", { operation: "create_session" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("projectId");
		expect(calls.length).toBe(0);
	});

	it("empty-string required param counts as missing", async () => {
		const calls = stubFetch();
		const result = await tools.get("bobbit_read")!.execute("id", { operation: "get_goal", goalId: "" });
		expect(result.isError).toBe(true);
		expect(calls.length).toBe(0);
	});

	it("boolean false satisfies a required param (archive_goal cascade=false)", async () => {
		const calls = stubFetch();
		const result = await tools.get("bobbit_orchestrate")!.execute("id", {
			operation: "archive_goal",
			goalId: "g1",
			cascade: false,
		});
		expect(result.isError).toBeFalsy();
		expect(calls.length).toBe(1);
		expect(calls[0].url).toBe("https://gw.test/api/goals/g1?cascade=false");
	});
});
