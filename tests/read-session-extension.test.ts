import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import registerAgentExtension from "../defaults/tools/agent/extension.ts";

type ExecuteFn = (
	toolCallId: string,
	params: unknown,
	signal?: unknown,
	onUpdate?: unknown,
	ctx?: unknown,
) => Promise<any>;

function makeStubApi(): { api: any; getExecute: () => ExecuteFn } {
	let captured: ExecuteFn | null = null;
	const api = {
		registerTool(config: any) {
			if (config?.name === "read_session" && typeof config?.execute === "function") {
				captured = config.execute.bind(config);
			}
		},
	};
	return {
		api,
		getExecute: () => {
			if (!captured) throw new Error("read_session execute was not registered");
			return captured;
		},
	};
}

describe("read_session extension include_tool_results defaults", () => {
	let execute: ExecuteFn;
	const envBackup: Record<string, string | undefined> = {};
	let realFetch: typeof globalThis.fetch;
	const seenUrls: string[] = [];

	before(() => {
		for (const key of ["BOBBIT_SESSION_ID", "BOBBIT_TOKEN", "BOBBIT_GATEWAY_URL"]) {
			envBackup[key] = process.env[key];
		}
		process.env.BOBBIT_SESSION_ID = "caller-session";
		process.env.BOBBIT_TOKEN = "test-token";
		process.env.BOBBIT_GATEWAY_URL = "https://gateway.test";

		realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: any) => {
			seenUrls.push(String(url));
			return {
				ok: true,
				status: 200,
				async json() {
					return { total: 1, returned: 1, offsetStart: 0, offsetEnd: 0, messages: [] };
				},
			} as any;
		}) as any;

		const { api, getExecute } = makeStubApi();
		registerAgentExtension(api);
		execute = getExecute();
	});

	beforeEach(() => {
		seenUrls.length = 0;
	});

	after(() => {
		globalThis.fetch = realFetch;
		for (const key of ["BOBBIT_SESSION_ID", "BOBBIT_TOKEN", "BOBBIT_GATEWAY_URL"]) {
			if (envBackup[key] === undefined) delete process.env[key];
			else process.env[key] = envBackup[key]!;
		}
	});

	it("sends include_tool_results=0 by default", async () => {
		await execute("toolu_READ", { session_id: "target-session", offset: 0, limit: 1 });
		assert.equal(seenUrls.length, 1);
		const url = new URL(seenUrls[0]);
		assert.equal(url.pathname, "/api/sessions/target-session/transcript");
		assert.equal(url.searchParams.get("include_tool_results"), "0");
	});

	it("sends include_tool_results=1 on explicit opt-in", async () => {
		await execute("toolu_READ", { session_id: "target-session", include_tool_results: true });
		assert.equal(seenUrls.length, 1);
		const url = new URL(seenUrls[0]);
		assert.equal(url.searchParams.get("include_tool_results"), "1");
	});
});
