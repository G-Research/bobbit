/**
 * 401 → creds refresh → retry behaviour in `apiCall()`.
 *
 * Contract: when the gateway returns 401, `apiCall` clears its in-module
 * creds cache, re-reads the on-disk token+url, and retries the same request
 * once with the fresh bearer. The refresh consumes ZERO transient-retry
 * slots; if the second 401 lands, the auth error propagates without a
 * second refresh.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { apiCall, __clearCredsCacheForTesting } from "../defaults/tools/_shared/gateway.ts";

const origFetch = globalThis.fetch;
const origWarn = console.warn;
let tmp: string;
let prev: { dir?: string; token?: string; url?: string };

before(() => {
	tmp = mkdtempSync(path.join(tmpdir(), "bobbit-401-"));
	prev = {
		dir: process.env.BOBBIT_DIR,
		token: process.env.BOBBIT_TOKEN,
		url: process.env.BOBBIT_GATEWAY_URL,
	};
	delete process.env.BOBBIT_TOKEN;
	delete process.env.BOBBIT_GATEWAY_URL;
	console.warn = () => { /* silence */ };
});

after(() => {
	rmSync(tmp, { recursive: true, force: true });
	const restore = (k: keyof typeof prev, env: string) => {
		if (prev[k] === undefined) delete process.env[env];
		else process.env[env] = prev[k] as string;
	};
	restore("dir", "BOBBIT_DIR");
	restore("token", "BOBBIT_TOKEN");
	restore("url", "BOBBIT_GATEWAY_URL");
	globalThis.fetch = origFetch;
	console.warn = origWarn;
});

describe("apiCall 401 → creds refresh", () => {
	it("refreshes from disk on 401 and retries with the new bearer", async () => {
		const dir = mkdtempSync(path.join(tmp, "case-"));
		const stateDir = path.join(dir, "state");
		mkdirSync(stateDir, { recursive: true });
		// Initial disk state — old token.
		writeFileSync(path.join(stateDir, "token"), "old-token");
		writeFileSync(path.join(stateDir, "gateway-url"), "https://gw.test");
		process.env.BOBBIT_DIR = dir;
		__clearCredsCacheForTesting();

		const seenAuth: string[] = [];
		let calls = 0;
		globalThis.fetch = (async (url, init) => {
			calls += 1;
			const auth = (init as RequestInit).headers as Record<string, string>;
			seenAuth.push(auth.Authorization);
			if (calls === 1) {
				// Simulate gateway restart having rotated the token: the agent's
				// in-memory creds (passed in below) are stale; disk now has "new-token".
				writeFileSync(path.join(stateDir, "token"), "new-token");
				return new Response(JSON.stringify({ error: "unauthorized" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const result = await apiCall(
			{ token: "old-token", baseUrl: "https://gw.test" },
			"GET",
			"/api/who-am-i",
		);

		assert.deepEqual(result, { ok: true });
		assert.equal(calls, 2, "expected one retry after 401");
		assert.equal(seenAuth[0], "Bearer old-token");
		assert.equal(seenAuth[1], "Bearer new-token", "second call should use refreshed bearer");
	});

	it("propagates the 401 error if the refresh also returns 401 (no second refresh)", async () => {
		const dir = mkdtempSync(path.join(tmp, "case2-"));
		const stateDir = path.join(dir, "state");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(path.join(stateDir, "token"), "still-bad");
		writeFileSync(path.join(stateDir, "gateway-url"), "https://gw.test");
		process.env.BOBBIT_DIR = dir;
		__clearCredsCacheForTesting();

		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return new Response(JSON.stringify({ error: "unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		await assert.rejects(
			() => apiCall(
				{ token: "stale", baseUrl: "https://gw.test" },
				"GET",
				"/api/x",
			),
			(err: Error) => {
				assert.match(err.message, /unauthorized/);
				return true;
			},
		);
		// Initial call + ONE refresh-retry only.
		assert.equal(calls, 2);
	});
});
