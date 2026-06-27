import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChannelDispatcher, type ChannelHandlerContext } from "../src/server/extension-host/channel-dispatcher.ts";
import { ChannelRegistry } from "../src/server/extension-host/channel-registry.ts";
import { ChannelError, type ChannelAuditEvent, type ChannelContributionRef, type ChannelOpenGrantBinding } from "../src/server/extension-host/channel-types.ts";

const contribution = (quotas: ChannelContributionRef["quotas"] = {}): ChannelContributionRef => ({
	contributionId: "terminal-panel",
	name: "terminal",
	protocol: "terminal.v1",
	quotas,
});

function grant(registry: ChannelRegistry, overrides: Partial<ChannelOpenGrantBinding> = {}): string {
	return registry.grants.mint({
		sessionId: "sess-1",
		packId: "pack-a",
		contributionId: "terminal-panel",
		channelName: "terminal",
		...overrides,
	});
}

async function open(registry: ChannelRegistry, opts: { clientId?: string; singletonKey?: string; quotas?: ChannelContributionRef["quotas"] } = {}) {
	const singletonKey = opts.singletonKey;
	return await registry.open({
		sessionId: "sess-1",
		packId: "pack-a",
		contribution: contribution(opts.quotas),
		init: { singletonKey },
		clientId: opts.clientId ?? "client-1",
		openGrant: grant(registry, { singletonKey }),
	});
}

function assertChannelReject(fn: () => unknown | Promise<unknown>, code: string): Promise<void> {
	return assert.rejects(fn, (err) => err instanceof ChannelError && err.code === code);
}

describe("ChannelRegistry — grant-gated open and scoping", () => {
	it("rejects a missing openGrant before handler creation", async () => {
		let handlerOpened = 0;
		const dispatcher = new ChannelDispatcher();
		dispatcher.registerName("terminal", () => { handlerOpened++; return {}; });
		const registry = new ChannelRegistry({ dispatcher });
		await assertChannelReject(() => registry.open({ sessionId: "sess-1", packId: "pack-a", contribution: contribution(), clientId: "client-1" }), "invalid_open_grant");
		assert.equal(handlerOpened, 0);
		assert.equal(registry.activeCount(), 0);
	});

	it("opens, attaches, lists, rejects cross-scope access, and detaches without closing", async () => {
		let attached = 0;
		let detached = 0;
		const dispatcher = new ChannelDispatcher();
		dispatcher.registerName("terminal", () => ({ onAttach: () => { attached++; }, onDetach: () => { detached++; } }));
		const registry = new ChannelRegistry({ dispatcher, idGenerator: () => "chan-1" });
		const result = await open(registry, { clientId: "client-1" });
		assert.equal(result.channelId, "chan-1");
		assert.equal(result.info.state, "open");
		assert.equal(result.info.attached, true);
		assert.equal(attached, 0, "initial opener is attached before the handler exists");

		await registry.attach({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-1", clientId: "client-2" });
		assert.equal(attached, 1);
		assert.equal(registry.list({ sessionId: "sess-1", packId: "pack-a", clientId: "client-2" })[0].attached, true);
		await assertChannelReject(() => registry.attach({ sessionId: "sess-2", packId: "pack-a", channelId: "chan-1", clientId: "evil" }), "channel_not_found");
		await assertChannelReject(() => registry.sendFromClient({ sessionId: "sess-1", packId: "pack-b", channelId: "chan-1", clientId: "client-2", frame: { kind: "text", data: "x" } }), "channel_not_found");

		assert.equal(await registry.detach("sess-1", "pack-a", "chan-1", "client-2"), true);
		assert.equal(detached, 1);
		assert.equal(registry.list({ sessionId: "sess-1", packId: "pack-a", clientId: "client-2" })[0].attached, false);
		assert.equal(registry.activeCount(), 1);
	});

	it("reuses a live singleton without creating a second handler", async () => {
		let openCount = 0;
		let seq = 0;
		const dispatcher = new ChannelDispatcher();
		dispatcher.registerName("terminal", () => { openCount++; return {}; });
		const registry = new ChannelRegistry({ dispatcher, idGenerator: () => `chan-${++seq}` });
		const first = await open(registry, { clientId: "client-1", singletonKey: "main" });
		const second = await open(registry, { clientId: "client-2", singletonKey: "main" });
		assert.equal(first.channelId, second.channelId);
		assert.equal(second.reused, true);
		assert.equal(openCount, 1);
		assert.equal(registry.activeCount(), 1);
	});
});

describe("ChannelRegistry — frames, quotas, backpressure, and no replay", () => {
	it("accepts only text/json frames and enforces maxFrameBytes", async () => {
		let received: unknown;
		const dispatcher = new ChannelDispatcher();
		dispatcher.registerName("terminal", () => ({ onClientFrame: (frame) => { received = frame; } }));
		const registry = new ChannelRegistry({ dispatcher, idGenerator: () => "chan-1" });
		await open(registry, { quotas: { maxFrameBytes: 10 } });
		await registry.sendFromClient({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-1", clientId: "client-1", frame: { kind: "json", data: { ok: 1 } } });
		assert.deepEqual(received, { kind: "json", data: { ok: 1 } });
		await assertChannelReject(() => registry.sendFromClient({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-1", clientId: "client-1", frame: { kind: "bytes", data: "x" } }), "invalid_frame");
		await assertChannelReject(() => registry.sendFromClient({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-1", clientId: "client-1", frame: { kind: "text", data: "this is too long" } }), "frame_too_large");
	});

	it("bounds inbound in-flight frames", async () => {
		let release!: () => void;
		const dispatcher = new ChannelDispatcher();
		dispatcher.registerName("terminal", () => ({ onClientFrame: () => new Promise<void>((resolve) => { release = resolve; }) }));
		const registry = new ChannelRegistry({ dispatcher, idGenerator: () => "chan-1" });
		await open(registry, { quotas: { maxInboundFrames: 1 } });
		const first = registry.sendFromClient({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-1", clientId: "client-1", frame: { kind: "text", data: "a" } });
		await assertChannelReject(() => registry.sendFromClient({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-1", clientId: "client-1", frame: { kind: "text", data: "b" } }), "channel_backpressure");
		release();
		await first;
	});

	it("bounds outbound delivery buffers per channel/client and does not replay history to later attaches", async () => {
		let ctx!: ChannelHandlerContext;
		const dispatcher = new ChannelDispatcher();
		dispatcher.registerName("terminal", (opened) => { ctx = opened; return {}; });
		const registry = new ChannelRegistry({ dispatcher, idGenerator: () => "chan-1" });
		await registry.open({
			sessionId: "sess-1",
			packId: "pack-a",
			contribution: contribution({ maxOutboundFrames: 1, maxClientOutboundFrames: 1 }),
			clientId: "client-1",
			client: { autoDrain: false },
			openGrant: grant(registry),
		});
		await ctx.send({ kind: "text", data: "first" });
		await assertChannelReject(() => ctx.send({ kind: "text", data: "second" }), "channel_backpressure");
		assert.deepEqual(registry.drainClient("sess-1", "pack-a", "chan-1", "client-1"), [{ kind: "text", data: "first" }]);
		await registry.attach({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-1", clientId: "client-2", client: { autoDrain: false } });
		assert.deepEqual(registry.drainClient("sess-1", "pack-a", "chan-1", "client-2"), []);
	});

	it("omits frame payloads from audit events", async () => {
		const events: ChannelAuditEvent[] = [];
		const registry = new ChannelRegistry({ idGenerator: () => "chan-1", audit: (event) => events.push(event) });
		await open(registry);
		await registry.sendFromClient({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-1", clientId: "client-1", frame: { kind: "text", data: "SECRET_PAYLOAD" } });
		assert.ok(!JSON.stringify(events).includes("SECRET_PAYLOAD"));
		assert.ok(events.some((event) => event.type === "channel.frame.in" && event.frameKind === "text" && event.frameBytes === 14));
	});
});

describe("ChannelRegistry — lifecycle cleanup", () => {
	it("closes channels with tombstones and scoped closed listings", async () => {
		let closedReason: string | undefined;
		const dispatcher = new ChannelDispatcher();
		dispatcher.registerName("terminal", () => ({ close: (reason) => { closedReason = reason; } }));
		const registry = new ChannelRegistry({ dispatcher, idGenerator: () => "chan-1" });
		await open(registry);
		const closed = await registry.close({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-1", clientId: "client-1", reason: "user killed" });
		assert.equal(closed.state, "closed");
		assert.equal(closed.closeReason, "user killed");
		assert.equal(closedReason, "user killed");
		assert.equal(registry.activeCount(), 0);
		assert.deepEqual(registry.list({ sessionId: "sess-1", packId: "pack-a" }), []);
		assert.equal(registry.list({ sessionId: "sess-1", packId: "pack-a", includeClosed: true })[0].state, "closed");
		assert.deepEqual(registry.list({ sessionId: "sess-2", packId: "pack-a", includeClosed: true }), []);
	});

	it("supports idle and session cleanup hooks", async () => {
		let now = 0;
		let seq = 0;
		const registry = new ChannelRegistry({ now: () => now, idGenerator: () => `chan-${++seq}` });
		await open(registry, { quotas: { idleTimeoutMs: 5 } });
		await registry.detach("sess-1", "pack-a", "chan-1", "client-1");
		now = 6;
		assert.equal(await registry.sweepIdle(), 1);
		assert.equal(registry.activeCount(), 0);

		await open(registry);
		assert.equal(await registry.closeSession("sess-1", "session ended"), 1);
		assert.equal(registry.activeCount(), 0);
		assert.equal(registry.list({ sessionId: "sess-1", packId: "pack-a", includeClosed: true }).at(-1)?.closeReason, "session ended");
	});
});
