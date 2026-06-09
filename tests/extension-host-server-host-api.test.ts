/**
 * Unit tests for the SERVER Host API handed to action handlers as `ctx.host`
 * (src/server/extension-host/server-host-api.ts) — design
 * docs/design/extension-host.md §4c / §5.1.
 *
 * Durable v1 contract: there is NO `gateway.fetch` / raw passthrough (the action
 * endpoint is the only sanctioned pack→server path; removing the hatch also
 * deleted the Host-header trusted-base-URL token-leak surface). The server host
 * exposes only the bound identity + `capabilities`; the scoped Phase-2 namespaces
 * (`callRoute`/`session`/`store`) are present-but-throwing stubs.
 *
 * Pinned invariants:
 *   - `capabilities` is the single source of truth: the Phase-2 scoped caps are false.
 *   - Phase-2 namespaces (session/store) throw a loud "reserved for Phase 2".
 *   - `version`/`contractVersion` are exposed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServerHostApi } from "../src/server/extension-host/server-host-api.ts";

describe("createServerHostApi — durable v1 (no gateway passthrough)", () => {
	it("capabilities reports the scoped Phase-2 caps as false (single source of truth)", () => {
		const host = createServerHostApi({ sessionId: "s", toolUseId: "tu", packId: "", contributionId: "g/t" });
		assert.equal(host.capabilities.callRoute, false);
		assert.equal(host.capabilities.session, false);
		assert.equal(host.capabilities.store, false);
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

	it("store.* throws 'reserved for Phase 2'", () => {
		assert.throws(() => host.store.get("k"), /reserved for Phase 2/);
		assert.throws(() => host.store.put("k", 1), /reserved for Phase 2/);
		assert.throws(() => host.store.list(), /reserved for Phase 2/);
	});

	// Slice B2 implemented the own-session READS; only the WRITE stays frozen (C2).
	it("session.postMessage throws 'reserved for Phase 2' (write lands in C2)", () => {
		assert.throws(() => host.session.postMessage({}), /reserved for Phase 2/);
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
