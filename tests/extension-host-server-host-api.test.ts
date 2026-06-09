/**
 * Unit tests for the SERVER Host API handed to action handlers as `ctx.host`
 * (src/server/extension-host/server-host-api.ts) — design
 * docs/design/extension-host.md §4c / §5.1.
 *
 * Durable v1 contract: there is NO `gateway.fetch` / raw passthrough (the action
 * endpoint is the only sanctioned pack→server path; removing the hatch also
 * deleted the Host-header trusted-base-URL token-leak surface). The server host
 * exposes the bound identity + `capabilities`. `session` (READ-ONLY: B2 reads) and
 * `store` (B1) are implemented; `session.postMessage` is intentionally ABSENT on the
 * server host (Fix B) — driving the agent is a client-only, user-activation +
 * session-secret gated capability. `callRoute`/`ui` are CLIENT-ONLY surfaces and are
 * intentionally NOT server-host capability members (Fix 3) — a server handler calls
 * its routes directly and has no UI, so their absence is by design, not a gap.
 *
 * Pinned invariants:
 *   - `capabilities` is the single source of truth: session + store true; callRoute/ui absent.
 *   - `store` delegates to the injected PackStore, scoped to the server-derived packId.
 *   - `version`/`contractVersion` are exposed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServerHostApi } from "../src/server/extension-host/server-host-api.ts";

describe("createServerHostApi — durable v1 (no gateway passthrough)", () => {
	it("capabilities reports the server-host caps (session + store) — callRoute/ui are client-only", () => {
		const host = createServerHostApi({ sessionId: "s", toolUseId: "tu", packId: "", contributionId: "g/t" });
		// session is READ-ONLY on the server host (B2 reads); the namespace flag is true.
		assert.equal(host.capabilities.session, true);
		// Slice B1: store is implemented — the flag flips true.
		assert.equal(host.capabilities.store, true);
		assert.equal(host.capabilities.has("session"), true);
		assert.equal(host.capabilities.has("store"), true);
		// `callRoute`/`ui` are CLIENT-ONLY surfaces: NOT members of the server host
		// capability map (Fix 3). `has()` returns false for them — not a gap, by design.
		assert.equal((host.capabilities as Record<string, unknown>).callRoute, undefined);
		assert.equal((host.capabilities as Record<string, unknown>).ui, undefined);
		assert.equal(host.capabilities.has("callRoute"), false);
		assert.equal(host.capabilities.has("ui"), false);
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

describe("createServerHostApi — Fix B: NO server-side session.postMessage", () => {
	it("the server host session API does NOT expose postMessage (driving the agent is client-only)", () => {
		const host = createServerHostApi({ sessionId: "s", toolUseId: "tu", packId: "p", contributionId: "g/t" });
		// Reads remain; the write capability is intentionally absent on the server host.
		assert.equal(typeof (host.session as Record<string, unknown>).readTranscript, "function");
		assert.equal(typeof (host.session as Record<string, unknown>).readToolCall, "function");
		assert.equal((host.session as Record<string, unknown>).postMessage, undefined);
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

describe("createServerHostApi — Slice B2 own-session reads (contract adapter)", () => {
	const jsonl = [
		JSON.stringify({ type: "message", id: "e1", message: { role: "assistant", content: [
			{ type: "tool_use", id: "tu-1", name: "sample_action", input: { a: 1 } },
		] } }),
		JSON.stringify({ type: "message", id: "e2", message: { role: "user", content: [
			{ type: "tool_result", tool_use_id: "tu-1", content: "out", is_error: false },
		] } }),
	].join("\n");
	const host = createServerHostApi({
		sessionId: "s", toolUseId: "tu", packId: "", contributionId: "g/t",
		readOwnTranscript: async () => jsonl,
	});

	it("readTranscript maps the bound session's transcript to a contract envelope", async () => {
		const env = await host.session.readTranscript();
		assert.equal(env.total, 2);
		assert.equal(env.messages[0].content[0].type, "tool_use");
	});

	it("readToolCall joins a tool_use with its result by id", async () => {
		const rec = await host.session.readToolCall("tu-1");
		assert.deepEqual(rec, { toolUseId: "tu-1", tool: "sample_action", input: { a: 1 }, output: "out", isError: false });
	});

	it("reads reject when no gateway transcript reader is bound", async () => {
		const noReader = createServerHostApi({ sessionId: "s", packId: "", contributionId: "g/t" });
		await assert.rejects(() => noReader.session.readTranscript(), /gateway transcript reader/);
	});
});
