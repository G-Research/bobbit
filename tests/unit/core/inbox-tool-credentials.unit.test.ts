import { guardProcessEnv } from "../../../tests2/core/helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import inboxExtension from "../../../defaults/tools/inbox/extension.ts";

interface RegisteredTool {
	name: string;
	execute(toolCallId: string, params: any): Promise<any>;
}

const envKeys = [
	"BOBBIT_SESSION_ID",
	"BOBBIT_SESSION_SECRET",
	"BOBBIT_STAFF_ID",
	"BOBBIT_TOKEN",
	"BOBBIT_GATEWAY_URL",
] as const;

describe("first-party inbox tool credentials", () => {
	let previousEnv: Record<string, string | undefined>;
	let realFetch: typeof fetch;

	beforeEach(() => {
		previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
		Object.assign(process.env, {
			BOBBIT_SESSION_ID: "staff-session",
			BOBBIT_SESSION_SECRET: "host-issued-session-secret",
			BOBBIT_STAFF_ID: "staff-id",
			BOBBIT_TOKEN: "gateway-token",
			BOBBIT_GATEWAY_URL: "https://gateway.test",
		});
		realFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		for (const key of envKeys) {
			const value = previousEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("forwards only the host-issued session capability on every inbox request", async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		globalThis.fetch = (async (input, init = {}) => {
			requests.push({ url: String(input), init });
			return new Response(JSON.stringify({ entries: [], ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const tools = new Map<string, RegisteredTool>();
		inboxExtension({ registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); } } as any);
		assert.deepEqual([...tools.keys()].sort(), ["inbox_complete", "inbox_dismiss", "inbox_list"]);

		await tools.get("inbox_list")!.execute("list-call", { state: "pending", limit: 5 });
		await tools.get("inbox_complete")!.execute("complete-call", { entry_id: "entry-1", summary: "done" });
		await tools.get("inbox_dismiss")!.execute("dismiss-call", { entry_id: "entry-2", outcome: "cancelled", reason: "duplicate" });

		assert.equal(requests.length, 3);
		for (const request of requests) {
			const headers = new Headers(request.init.headers);
			assert.equal(headers.get("X-Bobbit-Session-Secret"), "host-issued-session-secret");
			assert.equal(headers.get("Authorization"), "Bearer gateway-token");
			const body = request.init.body ? JSON.parse(String(request.init.body)) : {};
			assert.equal("rootCorrelationId" in body, false);
			assert.equal("causationDepth" in body, false);
			assert.equal("correlationId" in body, false);
			assert.equal("causationId" in body, false);
		}
	});

	it("does not register staff inbox tools without a host-issued session secret", () => {
		delete process.env.BOBBIT_SESSION_SECRET;
		const tools: RegisteredTool[] = [];
		inboxExtension({ registerTool(tool: RegisteredTool) { tools.push(tool); } } as any);
		assert.deepEqual(tools, []);
	});
});
