/**
 * Unit tests for the SERVER Host API handed to action handlers as `ctx.host`
 * (src/server/extension-host/server-host-api.ts) — design
 * docs/design/extension-host.md §4c / §5.1.
 *
 * Durable v1 contract: there is NO `gateway.fetch` / raw passthrough (the action
 * endpoint is the only sanctioned pack→server path; removing the hatch also
 * deleted the Host-header trusted-base-URL token-leak surface). The server host
 * exposes the bound identity + `capabilities`; the not-yet-implemented scoped Phase-2
 * namespaces (`callRoute`/`session`) are present-but-throwing stubs. Slice B1 implements
 * `store`, delegating to the injected pack-scoped PackStore.
 *
 * Pinned invariants:
 *   - `capabilities` is the single source of truth: callRoute/session false; store true (B1).
 *   - The not-yet-implemented session namespace throws a loud "reserved for Phase 2".
 *   - `store` delegates to the injected PackStore, scoped to the server-derived packId.
 *   - `version`/`contractVersion` are exposed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServerHostApi } from "../src/server/extension-host/server-host-api.ts";

describe("createServerHostApi — durable v1 (no gateway passthrough)", () => {
	it("capabilities reports the scoped Phase-2 caps (store implemented in B1)", () => {
		const host = createServerHostApi({ sessionId: "s", toolUseId: "tu", packId: "", contributionId: "g/t" });
		assert.equal(host.capabilities.callRoute, false);
		assert.equal(host.capabilities.session, false);
		// Slice B1: store is implemented — the flag flips true.
		assert.equal(host.capabilities.store, true);
		assert.equal(host.capabilities.has("store"), true);
		assert.equal(host.capabilities.has("callRoute"), false);
		assert.equal(host.capabilities.has("nonexistent"), false);
	});

	it("exposes frozen version + contractVersion", () => {
		const host = createServerHostApi({ sessionId: "s", packId: "", contributionId: "g/t" });
		assert.equal(typeof host.version, "number");
		assert.equal(typeof host.contractVersion, "number");
	});

	it("does NOT expose a gateway member (escape hatch removed)", () => {
		const host = createServerHostApi({ sessionId: "s", packId: "", contributionId: "g/t" });
		assert.equal((host as Record<string, unknown>).gateway, undefined);
	});
});

describe("createServerHostApi — Phase-2 namespaces are frozen-not-implemented", () => {
	const host = createServerHostApi({ sessionId: "s", toolUseId: "tu", packId: "", contributionId: "g/t" });

	it("session.* throws 'reserved for Phase 2'", () => {
		assert.throws(() => host.session.readTranscript(), /reserved for Phase 2/);
		assert.throws(() => host.session.readToolCall("tu"), /reserved for Phase 2/);
		assert.throws(() => host.session.postMessage({}), /reserved for Phase 2/);
	});
});

describe("createServerHostApi — store delegates to the injected PackStore scoped to packId", () => {
	it("binds every call to the SERVER-DERIVED packId (never caller-supplied)", async () => {
		const calls: Array<{ op: string; packId: string; key?: string; value?: unknown; prefix?: string }> = [];
		const fakeStore = {
			get: async (packId: string, key: string) => { calls.push({ op: "get", packId, key }); return null; },
			put: async (packId: string, key: string, value: unknown) => { calls.push({ op: "put", packId, key, value }); },
			list: async (packId: string, prefix?: string) => { calls.push({ op: "list", packId, prefix }); return ["a"]; },
		};
		const host = createServerHostApi({ sessionId: "s", packId: "my-pack", contributionId: "g/t", packStore: fakeStore });
		assert.equal(host.capabilities.store, true);
		await host.store.get("k1");
		await host.store.put("k2", { n: 1 });
		assert.deepEqual(await host.store.list("pre"), ["a"]);
		assert.deepEqual(calls, [
			{ op: "get", packId: "my-pack", key: "k1" },
			{ op: "put", packId: "my-pack", key: "k2", value: { n: 1 } },
			{ op: "list", packId: "my-pack", prefix: "pre" },
		]);
	});

	it("throws a clear error when no store backend is injected", () => {
		const host = createServerHostApi({ sessionId: "s", packId: "p", contributionId: "g/t" });
		assert.throws(() => host.store.get("k"), /backend unavailable/);
	});
});
