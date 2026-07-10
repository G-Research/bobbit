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

describe("bobbit_read — paging schema", () => {
	it("exposes shared paging and cursor params as list-wide controls", () => {
		const props = tools.get("bobbit_read")!.parameters?.properties ?? {};

		for (const name of ["limit", "offset", "after", "cursor"]) {
			expect(props[name], `${name} should be registered in the bobbit_read schema`).toBeTruthy();
		}

		expect(props.limit.description).toMatch(/page|list|bounded/i);
		expect(props.limit.description).not.toMatch(/^search:/i);
		expect(props.offset.description).toMatch(/page|list|offset/i);
		expect(props.offset.description).not.toMatch(/^search:/i);
		expect(props.after.description).toMatch(/cursor|after/i);
		expect(props.cursor.description).toMatch(/cursor|after/i);
	});
});

describe("bobbit_admin — create_project schema", () => {
	it("exposes rootPath as a top-level parameter", () => {
		const props = tools.get("bobbit_admin")!.parameters?.properties ?? {};
		expect(props.rootPath, "rootPath should be registered in the bobbit_admin schema").toBeTruthy();
		expect(props.rootPath.description).toMatch(/project root path|create_project/i);
	});
});

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

	it("delete_staff without staffId → isError, no fetch", async () => {
		const calls = stubFetch();
		const result = await tools.get("bobbit_orchestrate")!.execute("id", { operation: "delete_staff" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("staffId");
		expect(calls.length).toBe(0);
	});

	it("create_project without name → isError, no fetch", async () => {
		const calls = stubFetch();
		const result = await tools.get("bobbit_admin")!.execute("id", {
			operation: "create_project",
			rootPath: "/workspace/demo",
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("name");
		expect(calls.length).toBe(0);
	});

	it("create_project without rootPath → isError, no fetch", async () => {
		const calls = stubFetch();
		const result = await tools.get("bobbit_admin")!.execute("id", {
			operation: "create_project",
			name: "Demo Project",
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("rootPath");
		expect(calls.length).toBe(0);
	});

	it("create_project with empty rootPath → isError, no fetch", async () => {
		const calls = stubFetch();
		const result = await tools.get("bobbit_admin")!.execute("id", {
			operation: "create_project",
			name: "Demo Project",
			rootPath: "",
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("rootPath");
		expect(calls.length).toBe(0);
	});

	it("delete_staff not-found response includes clear backend error details", async () => {
		const calls = stubFetch(() => ({
			status: 404,
			body: { error: "Staff not found", code: "STAFF_NOT_FOUND" },
		}));
		const result = await tools.get("bobbit_orchestrate")!.execute("id", {
			operation: "delete_staff",
			staffId: "missing-staff",
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Staff not found");
		expect(text(result)).toContain("STAFF_NOT_FOUND");
		expect(text(result)).toContain("HTTP 404");
		expect(calls.length).toBe(1);
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
