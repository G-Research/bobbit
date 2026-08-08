import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { Value } from "@sinclair/typebox/value";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import registerAgentExtension from "../../defaults/tools/agent/extension.ts";

type ExecuteFn = (toolCallId: string, params: unknown) => Promise<any>;

function makeStubApi(): { api: any; config: () => any; execute: () => ExecuteFn } {
	let registered: any;
	return {
		api: {
			registerTool(config: any) {
				if (config?.name === "read_session") registered = config;
			},
		},
		config: () => {
			if (!registered) throw new Error("read_session was not registered");
			return registered;
		},
		execute: () => {
			if (!registered?.execute) throw new Error("read_session execute was not registered");
			return registered.execute.bind(registered);
		},
	};
}

function check(schema: any, value: unknown): boolean {
	return Value.Check(schema, value);
}

describe("read_session discriminated tool contract", () => {
	const stub = makeStubApi();
	const previous: Record<string, string | undefined> = {};
	let realFetch: typeof globalThis.fetch;
	const seenUrls: string[] = [];

	beforeAll(() => {
		for (const key of ["BOBBIT_SESSION_ID", "BOBBIT_TOKEN", "BOBBIT_GATEWAY_URL"]) previous[key] = process.env[key];
		process.env.BOBBIT_SESSION_ID = "caller-session";
		process.env.BOBBIT_TOKEN = "test-token";
		process.env.BOBBIT_GATEWAY_URL = "https://gateway.test";
		realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: any) => {
			seenUrls.push(String(url));
			return { ok: true, status: 200, json: async () => ({ messages: [] }) } as any;
		}) as any;
		registerAgentExtension(stub.api);
	});

	beforeEach(() => seenUrls.length = 0);

	afterAll(() => {
		globalThis.fetch = realFetch;
		for (const key of Object.keys(previous)) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key]!;
		}
	});

	it("accepts list, message inspect, and exact result inspect variants", () => {
		const schema = stub.config().parameters;
		assert.equal(check(schema, { operation: "list", session_id: "target", offset: -20, limit: 20, pattern: "error", case_sensitive: true, context: 2 }), true);
		assert.equal(check(schema, { operation: "inspect", session_id: "target", message_index: 7 }), true);
		assert.equal(check(schema, { operation: "inspect", session_id: "target", message_index: 7, result_index: 1, offset: 5, limit: 40 }), true);
	});

	it("rejects removed flags, missing discriminants, and mixed mode parameters", () => {
		const schema = stub.config().parameters;
		for (const invalid of [
			{ session_id: "target" },
			{ operation: "list", session_id: "target", verbose: true },
			{ operation: "list", session_id: "target", include_tool_results: true },
			{ operation: "list", session_id: "target", includeToolResults: true },
			{ operation: "list", session_id: "target", message_index: 1 },
			{ operation: "inspect", session_id: "target" },
			{ operation: "inspect", session_id: "target", message_index: 1, pattern: "x" },
			{ operation: "inspect", session_id: "target", message_index: 1, context: 1 },
		]) assert.equal(check(schema, invalid), false, JSON.stringify(invalid));
	});

	it("forwards list discovery parameters without raw-result compatibility flags", async () => {
		const result = await stub.execute()("tool-list", {
			operation: "list", session_id: "target/session", offset: -5, limit: 5,
			pattern: "fail", case_sensitive: true, context: 1,
		});
		assert.notEqual(result.isError, true);
		assert.equal(seenUrls.length, 1);
		const url = new URL(seenUrls[0]);
		assert.equal(url.pathname, "/api/sessions/target%2Fsession/transcript");
		assert.equal(url.searchParams.get("operation"), "list");
		assert.equal(url.searchParams.get("offset"), "-5");
		assert.equal(url.searchParams.get("limit"), "5");
		assert.equal(url.searchParams.get("pattern"), "fail");
		assert.equal(url.searchParams.get("case_sensitive"), "1");
		assert.equal(url.searchParams.get("context"), "1");
		assert.equal(url.searchParams.has("verbose"), false);
		assert.equal(url.searchParams.has("include_tool_results"), false);
		assert.equal(url.searchParams.has("includeToolResults"), false);
	});

	it("forwards one exact result target and excerpt bounds", async () => {
		await stub.execute()("tool-inspect", {
			operation: "inspect", session_id: "target", message_index: 9,
			result_index: 2, offset: 6, limit: 80,
		});
		const url = new URL(seenUrls[0]);
		assert.equal(url.searchParams.get("operation"), "inspect");
		assert.equal(url.searchParams.get("message_index"), "9");
		assert.equal(url.searchParams.get("result_index"), "2");
		assert.equal(url.searchParams.get("offset"), "6");
		assert.equal(url.searchParams.get("limit"), "80");
		assert.equal(url.searchParams.has("pattern"), false);
		assert.equal(url.searchParams.has("include_tool_results"), false);
	});
});
