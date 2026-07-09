// v2-native — bobbit gateway tool suite. Listed in tests-map.json `v2Native`.
//
// Error surfacing: non-2xx { error, code } bodies render as one readable line
// with the machine code and HTTP status; 204/empty bodies normalize to a
// success shape.
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

describe("bobbit tools — error & empty-body surfacing", () => {
	it("surfaces { error, code } with the HTTP status on non-2xx", async () => {
		stubFetch(() => ({ status: 409, body: { error: "Goal has descendant teams", code: "HAS_DESCENDANT_TEAMS" } }));
		const result = await tools.get("bobbit_orchestrate")!.execute("id", {
			operation: "team_teardown",
			goalId: "g1",
			cascade: false,
		});
		expect(result.isError).toBe(true);
		const t = text(result);
		expect(t).toContain("Goal has descendant teams");
		expect(t).toContain("[HAS_DESCENDANT_TEAMS]");
		expect(t).toContain("HTTP 409");
	});

	it("falls back to raw text when the error body is not structured", async () => {
		stubFetch(() => ({ status: 500, text: "Internal Server Error" }));
		const result = await tools.get("bobbit_read")!.execute("id", { operation: "get_goal", goalId: "g1" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("HTTP 500");
		expect(text(result)).toContain("Internal Server Error");
	});

	it("normalizes a 204 empty body to { ok: true, status: 204 }", async () => {
		stubFetch(() => ({ status: 204, text: "" }));
		const result = await tools.get("bobbit_admin")!.execute("id", {
			operation: "marketplace_uninstall",
			packName: "some-pack",
			scope: "server",
		});
		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(text(result));
		expect(parsed).toEqual({ ok: true, status: 204 });
	});
});
