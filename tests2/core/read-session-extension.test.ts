import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import registerAgentExtension from "../../defaults/tools/agent/extension.ts";

describe("read_session discriminated tool contract", () => {
	let tool: any, realFetch: typeof fetch;
	const previous: Record<string, string | undefined> = {}, urls: string[] = [];
	beforeAll(() => {
		for (const key of ["BOBBIT_SESSION_ID", "BOBBIT_TOKEN", "BOBBIT_GATEWAY_URL"]) previous[key] = process.env[key];
		Object.assign(process.env, { BOBBIT_SESSION_ID: "caller", BOBBIT_TOKEN: "token", BOBBIT_GATEWAY_URL: "https://gateway.test" });
		realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: any) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => ({ messages: [] }) } as any; }) as any;
		registerAgentExtension({ registerTool(config: any) { if (config.name === "read_session") tool = config; } } as any);
	});
	beforeEach(() => { urls.length = 0; });
	afterAll(() => { globalThis.fetch = realFetch; for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
	it("accepts only the closed list and exact inspect variants", () => {
		const valid = [{ operation: "list", session_id: "s", offset: -20, limit: 20, pattern: "error", case_sensitive: true, context: 2 }, { operation: "inspect", session_id: "s", message_index: 7 }, { operation: "inspect", session_id: "s", message_index: 7, result_index: 1, offset: 5, limit: 40 }];
		const invalid = [{ session_id: "s" }, { operation: "inspect", session_id: "s" },
			...(["verbose", "include_tool_results", "includeToolResults"] as const).map((flag) => ({ operation: "list", session_id: "s", [flag]: true })), { operation: "list", session_id: "s", message_index: 1 },
			{ operation: "inspect", session_id: "s", message_index: 1, pattern: "x" }, { operation: "inspect", session_id: "s", message_index: 1, context: 1 }];
		for (const value of valid) assert.equal(Value.Check(tool.parameters, value), true, JSON.stringify(value));
		for (const value of invalid) assert.equal(Value.Check(tool.parameters, value), false, JSON.stringify(value));
	});

	it("forwards list discovery and exact-result bounds without compatibility flags", async () => {
		await tool.execute("list", { operation: "list", session_id: "target/session", offset: -5, limit: 5, pattern: "fail", case_sensitive: true, context: 1 });
		await tool.execute("inspect", { operation: "inspect", session_id: "target", message_index: 9, result_index: 2, offset: 6, limit: 80 });
		const [list, inspect] = urls.map((url) => new URL(url));
		assert.equal(list.pathname, "/api/sessions/target%2Fsession/transcript");
		assert.deepEqual(Object.fromEntries(list.searchParams), { operation: "list", offset: "-5", limit: "5", pattern: "fail", case_sensitive: "1", context: "1" });
		assert.deepEqual(Object.fromEntries(inspect.searchParams), { operation: "inspect", message_index: "9", result_index: "2", offset: "6", limit: "80" });
		for (const url of [list, inspect]) for (const flag of ["verbose", "include_tool_results", "includeToolResults"]) assert.equal(url.searchParams.has(flag), false);
	});
});
