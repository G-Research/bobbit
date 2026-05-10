/**
 * Unit tests for the gateway_api tool registered by
 * defaults/tools/agent/extension.ts.
 *
 * Uses the same fake-`pi` capture pattern as tool-description-budget.test.ts:
 * import the extension with a stub that records every registerTool call, then
 * drive the captured `execute` directly while stubbing globalThis.fetch.
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

interface CapturedTool {
	name: string;
	description?: string;
	execute: (toolCallId: string, params: any) => Promise<any>;
}

const GATEWAY_URL = "http://gw.test.local:9999";
const TOKEN = "test-token-abc";

const captured: CapturedTool[] = [];
let toolExecute: CapturedTool["execute"];

before(async () => {
	process.env.BOBBIT_GATEWAY_URL = GATEWAY_URL;
	process.env.BOBBIT_TOKEN = TOKEN;

	const file = path.join(REPO_ROOT, "defaults/tools/agent/extension.ts");
	const url = pathToFileURL(file).href;
	const mod: any = await import(url);
	const factory = typeof mod.default === "function" ? mod.default : mod.default?.default;
	assert.ok(typeof factory === "function", "extension.ts has no callable default export");

	const pi = {
		registerTool(def: any) {
			captured.push({ name: def.name, description: def.description, execute: def.execute });
		},
		on() {},
	};
	factory(pi);

	const tool = captured.find((t) => t.name === "gateway_api");
	assert.ok(tool, "gateway_api was not registered");
	toolExecute = tool!.execute;
});

interface FakeFetchInput {
	url: string;
	init: RequestInit;
}

const originalFetch = globalThis.fetch;
let lastFetch: FakeFetchInput | undefined;
let fakeResponse: { status: number; headers: Record<string, string>; body: string };

beforeEach(() => {
	lastFetch = undefined;
	fakeResponse = { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
	(globalThis as any).fetch = async (input: any, init: RequestInit = {}) => {
		lastFetch = { url: String(input), init };
		const headers = new Headers(fakeResponse.headers);
		return {
			status: fakeResponse.status,
			ok: fakeResponse.status >= 200 && fakeResponse.status < 300,
			headers,
			text: async () => fakeResponse.body,
			json: async () => JSON.parse(fakeResponse.body),
		} as unknown as Response;
	};
});

afterEach(() => {
	(globalThis as any).fetch = originalFetch;
});

function parseToolText(result: any): { status: number; body: any } {
	assert.ok(result.content?.[0]?.text, "tool result missing content");
	return JSON.parse(result.content[0].text);
}

describe("gateway_api tool", () => {
	it("GET /api/sessions hits the right URL with bearer token", async () => {
		fakeResponse.body = JSON.stringify([{ id: "s1" }]);
		const result = await toolExecute("t1", { method: "GET", path: "/api/sessions" });

		assert.equal(result.isError, undefined);
		assert.equal(lastFetch?.url, `${GATEWAY_URL}/api/sessions`);
		assert.equal(lastFetch?.init.method, "GET");
		const headers = lastFetch?.init.headers as Record<string, string>;
		assert.equal(headers["Authorization"], `Bearer ${TOKEN}`);

		const parsed = parseToolText(result);
		assert.equal(parsed.status, 200);
		assert.deepEqual(parsed.body, [{ id: "s1" }]);
	});

	it("rejects non-/api/ paths without calling fetch", async () => {
		const result = await toolExecute("t2", { method: "GET", path: "/etc/passwd" });
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /must start with \/api\//);
		assert.equal(lastFetch, undefined);
	});

	it("rejects http://... paths", async () => {
		const result = await toolExecute("t3", { method: "GET", path: "http://evil.example.com/api/x" });
		assert.equal(result.isError, true);
		assert.equal(lastFetch, undefined);
	});

	it("appends query params", async () => {
		fakeResponse.body = "{}";
		await toolExecute("t4", { method: "GET", path: "/api/goals", query: { foo: "bar", baz: "qux" } });
		assert.equal(lastFetch?.url, `${GATEWAY_URL}/api/goals?foo=bar&baz=qux`);
	});

	it("appends query params with & when path already has ?", async () => {
		await toolExecute("t5", { method: "GET", path: "/api/goals?a=1", query: { b: "2" } });
		assert.equal(lastFetch?.url, `${GATEWAY_URL}/api/goals?a=1&b=2`);
	});

	it("parses JSON response bodies", async () => {
		fakeResponse.headers = { "content-type": "application/json; charset=utf-8" };
		fakeResponse.body = JSON.stringify({ hello: "world" });
		const result = await toolExecute("t6", { method: "GET", path: "/api/x" });
		const parsed = parseToolText(result);
		assert.deepEqual(parsed.body, { hello: "world" });
	});

	it("returns text/plain bodies as raw string", async () => {
		fakeResponse.headers = { "content-type": "text/plain" };
		fakeResponse.body = "hello plain text";
		const result = await toolExecute("t7", { method: "GET", path: "/api/x" });
		const parsed = parseToolText(result);
		assert.equal(parsed.body, "hello plain text");
	});

	it("truncates bodies > 64 KiB with the documented suffix", async () => {
		fakeResponse.headers = { "content-type": "text/plain" };
		fakeResponse.body = "x".repeat(70 * 1024);
		const result = await toolExecute("t8", { method: "GET", path: "/api/x" });
		const parsed = parseToolText(result);
		assert.equal(typeof parsed.body, "string");
		assert.match(parsed.body, /\(truncated, \d+ bytes\)$/);
		// First 64 KiB preserved
		assert.ok(parsed.body.startsWith("x".repeat(64 * 1024)));
	});

	it("returns 404 status as a normal result, not isError", async () => {
		fakeResponse.status = 404;
		fakeResponse.headers = { "content-type": "application/json" };
		fakeResponse.body = JSON.stringify({ error: "not_found" });
		const result = await toolExecute("t9", { method: "GET", path: "/api/sessions/missing" });
		assert.equal(result.isError, undefined);
		const parsed = parseToolText(result);
		assert.equal(parsed.status, 404);
		assert.deepEqual(parsed.body, { error: "not_found" });
	});

	it("POST serialises body as JSON", async () => {
		fakeResponse.body = "{}";
		await toolExecute("t10", { method: "POST", path: "/api/goals", body: { a: 1 } });
		assert.equal(lastFetch?.init.method, "POST");
		assert.equal(lastFetch?.init.body, JSON.stringify({ a: 1 }));
		const headers = lastFetch?.init.headers as Record<string, string>;
		assert.equal(headers["Content-Type"], "application/json");
	});
});
