/**
 * Transient retry behaviour in `apiCall()`.
 *
 * Contract:
 *  - Transient TCP errors (ECONNRESET / EPIPE / "fetch failed" / etc.) are
 *    retried up to `opts.retries` times (default 3 = 4 total attempts) with
 *    exponential back-off (250 / 500 / 1000 ms).
 *  - On final transient failure the thrown error is structured: it includes
 *    the method, URL, last-error, cached gateway-url, and on-disk path.
 *  - Non-transient failures (4xx/5xx other than 401) propagate immediately
 *    without retry.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { apiCall } from "../defaults/tools/_shared/gateway.ts";

const origFetch = globalThis.fetch;
const origWarn = console.warn;
let tmp: string;
let prev: { dir?: string };

before(() => {
	tmp = mkdtempSync(path.join(tmpdir(), "bobbit-retry-"));
	prev = { dir: process.env.BOBBIT_DIR };
	process.env.BOBBIT_DIR = tmp;
	console.warn = () => { /* silence */ };
});

after(() => {
	rmSync(tmp, { recursive: true, force: true });
	if (prev.dir === undefined) delete process.env.BOBBIT_DIR;
	else process.env.BOBBIT_DIR = prev.dir;
	globalThis.fetch = origFetch;
	console.warn = origWarn;
});

afterEach(() => {
	globalThis.fetch = origFetch;
});

function makeTransientError(): Error {
	const e = new Error("fetch failed");
	(e as { cause?: unknown }).cause = { code: "ECONNRESET", message: "ECONNRESET" };
	return e;
}

describe("apiCall transient retry", () => {
	it("retries on ECONNRESET and succeeds on the 3rd attempt", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			if (calls < 3) throw makeTransientError();
			return new Response(JSON.stringify({ ok: true, n: calls }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const t0 = Date.now();
		const result = await apiCall(
			{ token: "t", baseUrl: "https://gw.test" },
			"GET",
			"/api/foo",
			undefined,
			{ retries: 3 },
		);
		const elapsed = Date.now() - t0;

		assert.deepEqual(result, { ok: true, n: 3 });
		assert.equal(calls, 3);
		// Two back-offs: 250ms + 500ms = 750ms minimum.
		assert.ok(elapsed >= 700, `expected >= ~750ms, got ${elapsed}ms`);
	});

	it("throws structured error after max retries on persistent transient failure", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			throw makeTransientError();
		}) as typeof fetch;

		await assert.rejects(
			() => apiCall(
				{ token: "t", baseUrl: "https://gw.test" },
				"POST",
				"/api/bar",
				{ x: 1 },
				{ retries: 3 },
			),
			(err: Error) => {
				assert.match(err.message, /Gateway request failed after 4 attempts/);
				assert.match(err.message, /POST https:\/\/gw\.test\/api\/bar/);
				assert.match(err.message, /Cached gateway-url: https:\/\/gw\.test/);
				assert.match(err.message, /on-disk:.*gateway-url/);
				return true;
			},
		);
		assert.equal(calls, 4);
	});

	it("does NOT retry non-401 4xx/5xx responses", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return new Response(JSON.stringify({ error: "bad request" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		await assert.rejects(
			() => apiCall(
				{ token: "t", baseUrl: "https://gw.test" },
				"POST",
				"/api/baz",
				undefined,
				{ retries: 3 },
			),
			(err: Error) => {
				assert.match(err.message, /bad request/);
				return true;
			},
		);
		assert.equal(calls, 1);
	});

	it("respects retries: 0 (fail-fast)", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			throw makeTransientError();
		}) as typeof fetch;

		await assert.rejects(
			() => apiCall(
				{ token: "t", baseUrl: "https://gw.test" },
				"GET",
				"/api/q",
				undefined,
				{ retries: 0 },
			),
		);
		assert.equal(calls, 1);
	});
});
