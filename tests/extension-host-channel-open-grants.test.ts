import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChannelOpenGrantStore } from "../src/server/extension-host/channel-open-grants.ts";
import { ChannelError, type ChannelAuditEvent, type ChannelOpenGrantBinding } from "../src/server/extension-host/channel-types.ts";

const binding = (overrides: Partial<ChannelOpenGrantBinding> = {}): ChannelOpenGrantBinding => ({
	sessionId: "sess-1",
	packId: "pack-a",
	contributionId: "term-panel",
	channelName: "terminal",
	singletonKey: "main",
	...overrides,
});

function assertGrantReject(fn: () => unknown, reason: string): void {
	assert.throws(fn, (err) => err instanceof ChannelError && err.status === 403 && err.code === "invalid_open_grant" && err.message.includes(reason));
}

describe("ChannelOpenGrantStore", () => {
	it("mints and consumes a grant bound to the exact channel open target", () => {
		let now = 10;
		let seq = 0;
		const events: ChannelAuditEvent[] = [];
		const store = new ChannelOpenGrantStore({ now: () => now, randomToken: () => `token-${++seq}`, audit: (e) => events.push(e) });
		const token = store.mint(binding());
		assert.equal(token, "token-1");
		const consumed = store.consume(token, binding());
		assert.equal(consumed.createdAt, 10);
		assert.equal(consumed.consumedAt, 10);
		now = 11;
		assertGrantReject(() => store.consume(token, binding()), "replayed");
		assert.deepEqual(events.map((e) => e.type), ["grant.mint", "grant.consume", "grant.reject"]);
		assert.ok(!JSON.stringify(events).includes("payload"));
	});

	it("rejects missing and forged grants", () => {
		const store = new ChannelOpenGrantStore({ now: () => 0, randomToken: () => "real" });
		assertGrantReject(() => store.consume(undefined, binding()), "missing");
		assertGrantReject(() => store.consume("forged", binding()), "unknown");
	});

	it("rejects expired grants and removes them", () => {
		let now = 100;
		const store = new ChannelOpenGrantStore({ ttlMs: 5, now: () => now, randomToken: () => "short" });
		const token = store.mint(binding());
		now = 105;
		assertGrantReject(() => store.consume(token, binding()), "expired");
		assertGrantReject(() => store.consume(token, binding()), "unknown");
	});

	it("rejects session/pack/contribution/channel/singleton mismatches", () => {
		let seq = 0;
		const store = new ChannelOpenGrantStore({ now: () => 0, randomToken: () => `t-${++seq}` });
		const mismatchCases: Array<[string, Partial<ChannelOpenGrantBinding>]> = [
			["session", { sessionId: "sess-2" }],
			["pack", { packId: "pack-b" }],
			["contribution", { contributionId: "other" }],
			["channel", { channelName: "logs" }],
			["singleton", { singletonKey: "other" }],
		];
		for (const [, overrides] of mismatchCases) {
			const token = store.mint(binding());
			assertGrantReject(() => store.consume(token, binding(overrides)), "mismatch");
		}
	});

	it("normalizes an empty singleton key to the unkeyed grant binding", () => {
		const store = new ChannelOpenGrantStore({ now: () => 0, randomToken: () => "t" });
		const token = store.mint(binding({ singletonKey: "" }));
		assert.equal(store.consume(token, binding({ singletonKey: undefined })).token, "t");
	});
});
