/**
 * Unit tests for `stripAuthorizationHeaders` (src/app/gateway-fetch.ts) — the
 * client-side Host API security choke point (design extension-host.md §5.1).
 *
 * Invariant: a renderer-/extension-supplied `Authorization` header is DROPPED
 * (case-insensitive) before the host API delegates to `gatewayFetch`, so the
 * injected admin bearer always wins. Other headers pass through unchanged across
 * the three `HeadersInit` shapes (plain object, `[k,v][]`, `Headers`).
 *
 * `gateway-fetch.ts` is intentionally dependency-free, so this imports + runs in
 * plain node with no DOM/UI graph.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripAuthorizationHeaders } from "../src/app/gateway-fetch.ts";

describe("stripAuthorizationHeaders", () => {
	it("drops a caller-supplied Authorization header (plain object), keeps the rest", () => {
		const out = stripAuthorizationHeaders({
			Authorization: "Bearer evil",
			"Content-Type": "application/json",
			"x-bobbit-session-id": "sess-1",
		});
		assert.equal(out.Authorization, undefined);
		assert.equal(out["Content-Type"], "application/json");
		assert.equal(out["x-bobbit-session-id"], "sess-1");
	});

	it("is case-insensitive on the Authorization key", () => {
		assert.deepEqual(stripAuthorizationHeaders({ authorization: "Bearer evil" }), {});
		assert.deepEqual(stripAuthorizationHeaders({ AUTHORIZATION: "Bearer evil" }), {});
		assert.deepEqual(stripAuthorizationHeaders({ AuThOrIzAtIoN: "Bearer evil" }), {});
	});

	it("handles the [k,v][] header shape", () => {
		const out = stripAuthorizationHeaders([
			["authorization", "Bearer evil"],
			["X-Foo", "bar"],
		]);
		assert.equal(out.authorization, undefined);
		assert.equal(out["X-Foo"], "bar");
	});

	it("handles a Headers instance", () => {
		const h = new Headers();
		h.set("Authorization", "Bearer evil");
		h.set("X-Foo", "bar");
		const out = stripAuthorizationHeaders(h);
		// Headers lowercases keys; the Authorization entry must be gone either way.
		assert.ok(!("authorization" in out) && !("Authorization" in out));
		assert.equal(out["x-foo"] ?? out["X-Foo"], "bar");
	});

	it("returns an empty object for undefined headers", () => {
		assert.deepEqual(stripAuthorizationHeaders(undefined), {});
	});
});
