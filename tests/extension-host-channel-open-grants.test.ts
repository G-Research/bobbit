import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChannelOpenPermitStore } from "../src/server/extension-host/channel-open-permits.ts";
import { ChannelError, type ChannelAuditEvent, type ChannelOpenPermitBinding } from "../src/server/extension-host/channel-types.ts";

const binding = (overrides: Partial<ChannelOpenPermitBinding> = {}): ChannelOpenPermitBinding => ({
	sessionId: "sess-1",
	packId: "pack-a",
	contributionId: "term-panel",
	channelName: "terminal",
	singletonKey: "main",
	...overrides,
});

function assertPermitReject(fn: () => unknown, reason: string): void {
	assert.throws(fn, (err) => err instanceof ChannelError && err.status === 403 && err.code === "invalid_open_permit" && err.message.includes(reason));
}

describe("ChannelOpenPermitStore", () => {
	it("mints and consumes a permit bound to the exact channel open target", () => {
		let now = 10;
		let seq = 0;
		const events: ChannelAuditEvent[] = [];
		const store = new ChannelOpenPermitStore({ now: () => now, randomToken: () => `token-${++seq}`, audit: (e) => events.push(e) });
		const token = store.mint(binding());
		assert.equal(token, "token-1");
		assert.equal(store.pendingCount(), 1);
		const consumed = store.consume(token, binding());
		assert.equal(consumed.createdAt, 10);
		assert.equal(consumed.consumedAt, 10);
		assert.equal(store.pendingCount(), 0, "consumed one-shot permits are removed from the pending store");
		now = 11;
		assertPermitReject(() => store.consume(token, binding()), "replayed");
		assert.deepEqual(events.map((e) => e.type), ["permit.mint", "permit.consume", "permit.reject"]);
		assert.ok(!JSON.stringify(events).includes("payload"));
	});

	it("bounds replay tombstones to the original permit expiry", () => {
		let now = 0;
		const store = new ChannelOpenPermitStore({ ttlMs: 5, now: () => now, randomToken: () => "short" });
		const token = store.mint(binding());
		store.consume(token, binding());
		assert.equal(store.pendingCount(), 0);
		assertPermitReject(() => store.consume(token, binding()), "replayed");
		now = 5;
		assert.equal(store.cleanupExpired(), 1);
		assertPermitReject(() => store.consume(token, binding()), "unknown");
	});

	it("rejects missing and forged permits", () => {
		const store = new ChannelOpenPermitStore({ now: () => 0, randomToken: () => "real" });
		assertPermitReject(() => store.consume(undefined, binding()), "missing");
		assertPermitReject(() => store.consume("forged", binding()), "unknown");
	});

	it("rejects expired permits and removes them", () => {
		let now = 100;
		const store = new ChannelOpenPermitStore({ ttlMs: 5, now: () => now, randomToken: () => "short" });
		const token = store.mint(binding());
		now = 105;
		assertPermitReject(() => store.consume(token, binding()), "expired");
		assertPermitReject(() => store.consume(token, binding()), "unknown");
	});

	it("rejects session/pack/contribution/channel/singleton mismatches", () => {
		let seq = 0;
		const store = new ChannelOpenPermitStore({ now: () => 0, randomToken: () => `t-${++seq}` });
		const mismatchCases: Array<[string, Partial<ChannelOpenPermitBinding>]> = [
			["session", { sessionId: "sess-2" }],
			["pack", { packId: "pack-b" }],
			["contribution", { contributionId: "other" }],
			["channel", { channelName: "logs" }],
			["singleton", { singletonKey: "other" }],
		];
		for (const [, overrides] of mismatchCases) {
			const token = store.mint(binding());
			assertPermitReject(() => store.consume(token, binding(overrides)), "mismatch");
		}
	});

	it("normalizes an empty singleton key to the unkeyed permit binding", () => {
		const store = new ChannelOpenPermitStore({ now: () => 0, randomToken: () => "t" });
		const token = store.mint(binding({ singletonKey: "" }));
		assert.equal(store.consume(token, binding({ singletonKey: undefined })).token, "t");
	});

});
