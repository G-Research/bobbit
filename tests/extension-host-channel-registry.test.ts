import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelDispatcher, type ChannelHandlerContext } from "../src/server/extension-host/channel-dispatcher.ts";
import { ChannelRegistry } from "../src/server/extension-host/channel-registry.ts";
import { ChannelError, type ChannelAuditEvent, type ChannelContributionRef, type ChannelOpenPermitBinding } from "../src/server/extension-host/channel-types.ts";

const contribution = (quotas: ChannelContributionRef["quotas"] = {}): ChannelContributionRef => ({
	contributionId: "terminal-panel",
	name: "terminal",
	protocol: "terminal.v1",
	quotas,
});

function permit(registry: ChannelRegistry, overrides: Partial<ChannelOpenPermitBinding> = {}): string {
	return registry.permits.mint({
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
		openPermit: permit(registry, { singletonKey }),
	});
}

function assertChannelReject(fn: () => unknown | Promise<unknown>, code: string): Promise<void> {
	return assert.rejects(fn, (err) => err instanceof ChannelError && err.code === code);
}

function noopDispatcher(): ChannelDispatcher {
	const dispatcher = new ChannelDispatcher();
	dispatcher.registerName("terminal", () => ({}));
	return dispatcher;
}

describe("ChannelRegistry — permit-gated open and scoping", () => {
	it("rejects a missing openPermit before handler creation", async () => {
		let handlerOpened = 0;
		const dispatcher = new ChannelDispatcher();
		dispatcher.registerName("terminal", () => { handlerOpened++; return {}; });
		const registry = new ChannelRegistry({ dispatcher });
		await assertChannelReject(() => registry.open({ sessionId: "sess-1", packId: "pack-a", contribution: contribution(), clientId: "client-1" }), "invalid_open_permit");
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

	it("runs pack-declared channel modules and fails closed when a handler cannot be loaded", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "channel-module-host-"));
		try {
			const sourceFile = path.join(root, "channels", "terminal.yaml");
			const moduleFile = path.join(root, "lib", "terminal.mjs");
			fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
			fs.mkdirSync(path.dirname(moduleFile), { recursive: true });
			fs.writeFileSync(moduleFile, `
export const channels = {
  terminal: async (ctx) => {
    await ctx.send({ kind: "text", data: ` + "`welcome:${ctx.channelId}`" + ` });
    return {
      onClientFrame: async (frame) => { await ctx.send({ kind: "json", data: { echo: frame } }); },
      close: async () => {}
    };
  }
};
`, "utf-8");
			const frames: unknown[] = [];
			const registry = new ChannelRegistry({ idGenerator: () => "chan-module" });
			const declared: ChannelContributionRef = {
				...contribution(),
				modulePath: "../lib/terminal.mjs",
				sourceFile,
				packRoot: root,
				handler: "terminal",
			};
			await registry.open({
				sessionId: "sess-1",
				packId: "pack-a",
				contribution: declared,
				clientId: "client-1",
				client: { onFrame: (frame) => { frames.push(frame); } },
				openPermit: permit(registry),
			});
			assert.deepEqual(frames.shift(), { kind: "text", data: "welcome:chan-module" });
			await registry.sendFromClient({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-module", clientId: "client-1", frame: { kind: "text", data: "ping" } });
			assert.deepEqual(frames.shift(), { kind: "json", data: { echo: { kind: "text", data: "ping" } } });

			await assertChannelReject(() => registry.open({
				sessionId: "sess-1",
				packId: "pack-a",
				contribution: { ...declared, handler: "missing" },
				clientId: "client-2",
				openPermit: permit(registry),
			}), "channel_handler_not_found");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
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
			openPermit: permit(registry),
		});
		await ctx.send({ kind: "text", data: "first" });
		await assertChannelReject(() => ctx.send({ kind: "text", data: "second" }), "channel_backpressure");
		assert.deepEqual(registry.drainClient("sess-1", "pack-a", "chan-1", "client-1"), [{ kind: "text", data: "first" }]);
		await registry.attach({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-1", clientId: "client-2", client: { autoDrain: false } });
		assert.deepEqual(registry.drainClient("sess-1", "pack-a", "chan-1", "client-2"), []);
	});

	it("bounds outbound in-flight frames for auto-drain clients", async () => {
		let ctx!: ChannelHandlerContext;
		let release!: () => void;
		const events: ChannelAuditEvent[] = [];
		const dispatcher = new ChannelDispatcher();
		dispatcher.registerName("terminal", (opened) => { ctx = opened; return {}; });
		const registry = new ChannelRegistry({ dispatcher, idGenerator: () => "chan-1", audit: (event) => events.push(event) });
		await registry.open({
			sessionId: "sess-1",
			packId: "pack-a",
			contribution: contribution({ maxOutboundFrames: 1, maxClientOutboundFrames: 1 }),
			clientId: "client-1",
			client: { onFrame: () => new Promise<void>((resolve) => { release = resolve; }) },
			openPermit: permit(registry),
		});
		const first = ctx.send({ kind: "text", data: "first" });
		await assertChannelReject(() => ctx.send({ kind: "text", data: "second" }), "channel_backpressure");
		assert.ok(events.some((event) => event.type === "channel.frame.reject" && event.quota === "maxOutboundFrames"));
		release();
		await first;
	});

	it("detaches a rejecting auto-drain sink through handler detach semantics", async () => {
		let ctx!: ChannelHandlerContext;
		let detached = 0;
		const detachedClients: string[] = [];
		const dispatcher = new ChannelDispatcher();
		dispatcher.registerName("terminal", (opened) => {
			ctx = opened;
			return {
				onDetach: (clientId) => {
					detached++;
					detachedClients.push(clientId);
				},
			};
		});
		const registry = new ChannelRegistry({ dispatcher, idGenerator: () => "chan-1" });
		await registry.open({
			sessionId: "sess-1",
			packId: "pack-a",
			contribution: contribution(),
			clientId: "client-1",
			client: { onFrame: () => { throw new Error("client gone"); } },
			openPermit: permit(registry),
		});

		await ctx.send({ kind: "text", data: "first" });

		assert.equal(detached, 1);
		assert.deepEqual(detachedClients, ["client-1"]);
		assert.equal(registry.list({ sessionId: "sess-1", packId: "pack-a", clientId: "client-1" })[0].attached, false);
		assert.equal(await registry.detach("sess-1", "pack-a", "chan-1", "client-1"), false);
		assert.equal(detached, 1, "later detach remains idempotent after delivery-failure cleanup");
	});

	it("bounds outbound in-flight bytes for auto-drain clients", async () => {
		let ctx!: ChannelHandlerContext;
		let release!: () => void;
		const events: ChannelAuditEvent[] = [];
		const dispatcher = new ChannelDispatcher();
		dispatcher.registerName("terminal", (opened) => { ctx = opened; return {}; });
		const registry = new ChannelRegistry({ dispatcher, idGenerator: () => "chan-1", audit: (event) => events.push(event) });
		await registry.open({
			sessionId: "sess-1",
			packId: "pack-a",
			contribution: contribution({ maxOutboundBytes: 5, maxClientOutboundBytes: 5 }),
			clientId: "client-1",
			client: { onFrame: () => new Promise<void>((resolve) => { release = resolve; }) },
			openPermit: permit(registry),
		});
		const first = ctx.send({ kind: "text", data: "first" });
		await assertChannelReject(() => ctx.send({ kind: "text", data: "x" }), "channel_backpressure");
		assert.ok(events.some((event) => event.type === "channel.frame.reject" && event.quota === "maxOutboundBytes"));
		release();
		await first;
	});

	it("rolls back failed attaches and their queued outbound accounting", async () => {
		let ctx!: ChannelHandlerContext;
		const dispatcher = new ChannelDispatcher();
		let failNextAttach = true;
		dispatcher.registerName("terminal", (opened) => {
			ctx = opened;
			return {
				onAttach: async () => {
					if (!failNextAttach) return;
					failNextAttach = false;
					await ctx.send({ kind: "text", data: "during attach" });
					throw new Error("attach denied");
				},
			};
		});
		const registry = new ChannelRegistry({ dispatcher, idGenerator: () => "chan-1" });
		await registry.open({
			sessionId: "sess-1",
			packId: "pack-a",
			contribution: contribution({ maxOutboundFrames: 1, maxClientOutboundFrames: 1 }),
			clientId: "client-1",
			openPermit: permit(registry),
		});
		await registry.detach("sess-1", "pack-a", "chan-1", "client-1");
		const failedAttachFrames: unknown[] = [];
		await assert.rejects(() => registry.attach({
			sessionId: "sess-1",
			packId: "pack-a",
			channelId: "chan-1",
			clientId: "client-2",
			client: { onFrame: (frame) => { failedAttachFrames.push(frame); } },
		}), /attach denied/);
		assert.deepEqual(failedAttachFrames, [], "frames emitted during a failed attach must not reach that client");
		assert.equal(registry.list({ sessionId: "sess-1", packId: "pack-a", clientId: "client-2" })[0].attached, false);
		assert.throws(() => registry.drainClient("sess-1", "pack-a", "chan-1", "client-2"), (err) => err instanceof ChannelError && err.code === "not_attached");
		await registry.attach({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-1", clientId: "client-3", client: { autoDrain: false } });
		await ctx.send({ kind: "text", data: "after rollback" });
		assert.deepEqual(registry.drainClient("sess-1", "pack-a", "chan-1", "client-3"), [{ kind: "text", data: "after rollback" }]);
	});

	it("omits frame payloads from audit events", async () => {
		const events: ChannelAuditEvent[] = [];
		const registry = new ChannelRegistry({ dispatcher: noopDispatcher(), idGenerator: () => "chan-1", audit: (event) => events.push(event) });
		await open(registry);
		await registry.sendFromClient({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-1", clientId: "client-1", frame: { kind: "text", data: "SECRET_PAYLOAD" } });
		assert.ok(!JSON.stringify(events).includes("SECRET_PAYLOAD"));
		assert.ok(events.some((event) => event.type === "channel.frame.in" && event.frameKind === "text" && event.frameBytes === 14));
	});
});

describe("ChannelRegistry — lifecycle cleanup", () => {
	it("does not revive a channel closed by the handler during open", async () => {
		let ctx!: ChannelHandlerContext;
		let handlerClosed = 0;
		const frames: unknown[] = [];
		const closes: unknown[] = [];
		const dispatcher = new ChannelDispatcher();
		dispatcher.registerName("terminal", async (opened) => {
			ctx = opened;
			await ctx.send({ kind: "text", data: "hello" });
			await ctx.close("closed during open");
			return { close: () => { handlerClosed++; } };
		});
		const registry = new ChannelRegistry({ dispatcher, idGenerator: () => "chan-1" });
		await assertChannelReject(() => registry.open({
			sessionId: "sess-1",
			packId: "pack-a",
			contribution: contribution(),
			clientId: "client-1",
			client: { onFrame: (frame) => { frames.push(frame); }, onClose: (ev) => { closes.push(ev); } },
			openPermit: permit(registry),
		}), "channel_closed");
		assert.deepEqual(frames, [{ kind: "text", data: "hello" }]);
		assert.deepEqual(closes, [{ reason: "closed during open" }]);
		assert.equal(handlerClosed, 1, "late returned handler must be closed instead of leaked");
		assert.equal(registry.activeCount(), 0);
		assert.equal(registry.list({ sessionId: "sess-1", packId: "pack-a", includeClosed: true })[0].state, "closed");
		await assertChannelReject(() => registry.attach({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-1", clientId: "client-2" }), "channel_not_found");
	});

	it("closes late handler sessions after an open timeout", async () => {
		let resolveOpen!: (value: { close: () => void }) => void;
		let handlerClosed = 0;
		const dispatcher = new ChannelDispatcher();
		dispatcher.registerName("terminal", () => new Promise((resolve) => { resolveOpen = resolve; }));
		const registry = new ChannelRegistry({ dispatcher, idGenerator: () => "chan-1" });
		await assertChannelReject(() => registry.open({
			sessionId: "sess-1",
			packId: "pack-a",
			contribution: contribution({ openTimeoutMs: 1 }),
			clientId: "client-1",
			openPermit: permit(registry),
		}), "channel_timeout");
		assert.equal(registry.activeCount(), 0);
		resolveOpen({ close: () => { handlerClosed++; } });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(handlerClosed, 1);
	});

	it("clamps pack quotas so declarations cannot loosen registry limits", async () => {
		let seq = 0;
		const registry = new ChannelRegistry({ dispatcher: noopDispatcher(), idGenerator: () => `chan-${++seq}`, quotas: { maxChannelsPerSessionPerPack: 1, maxFrameBytes: 8 } });
		await open(registry, { quotas: { maxChannelsPerSessionPerPack: 2, maxFrameBytes: 64 } });
		await assertChannelReject(() => registry.sendFromClient({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-1", clientId: "client-1", frame: { kind: "text", data: "123456789" } }), "frame_too_large");
		await assertChannelReject(() => open(registry, { clientId: "client-2", quotas: { maxChannelsPerSessionPerPack: 2 } }), "channel_quota_exceeded");
	});

	it("bounds closed-channel tombstones by count", async () => {
		let seq = 0;
		const registry = new ChannelRegistry({ dispatcher: noopDispatcher(), idGenerator: () => `chan-${++seq}`, maxTombstones: 1 });
		await open(registry, { clientId: "client-1" });
		await registry.close({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-1", clientId: "client-1", reason: "first" });
		await open(registry, { clientId: "client-2" });
		await registry.close({ sessionId: "sess-1", packId: "pack-a", channelId: "chan-2", clientId: "client-2", reason: "second" });
		const closed = registry.list({ sessionId: "sess-1", packId: "pack-a", includeClosed: true });
		assert.deepEqual(closed.map((info) => info.id), ["chan-2"]);
	});

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
		const registry = new ChannelRegistry({ dispatcher: noopDispatcher(), now: () => now, idGenerator: () => `chan-${++seq}` });
		await open(registry, { quotas: { idleTimeoutMs: 5 } });
		await registry.detach("sess-1", "pack-a", "chan-1", "client-1");
		now = 6;
		assert.equal(await registry.sweepIdle(), 1);
		assert.equal(registry.activeCount(), 0);

		await open(registry);
		assert.equal(await registry.closeSession("sess-1", "session ended"), 1);
		assert.equal(registry.activeCount(), 0);
		assert.equal(registry.list({ sessionId: "sess-1", packId: "pack-a", includeClosed: true }).at(-1)?.closeReason, "session ended");
		await registry.dispose();
	});

	it("schedules detached idle cleanup and disposes the timer", async () => {
		const registry = new ChannelRegistry({ dispatcher: noopDispatcher(), idGenerator: () => "chan-1", quotas: { idleTimeoutMs: 1 }, idleSweepIntervalMs: 5 });
		await open(registry, { quotas: { idleTimeoutMs: 1 } });
		await registry.detach("sess-1", "pack-a", "chan-1", "client-1");
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(registry.activeCount(), 0);
		await registry.dispose();
	});

	it("closes channels whose pack contribution becomes unavailable", async () => {
		let available = true;
		let closedReason: string | undefined;
		const dispatcher = new ChannelDispatcher();
		dispatcher.registerName("terminal", () => ({ close: (reason) => { closedReason = reason; } }));
		const registry = new ChannelRegistry({
			dispatcher,
			idGenerator: () => "chan-1",
			contributionRegistry: { getChannel: (_projectId, packId, name) => available && packId === "pack-a" && name === "terminal" ? contribution() : undefined },
		});
		await registry.open({ sessionId: "sess-1", projectId: "project-a", packId: "pack-a", contribution: contribution(), clientId: "client-1", openPermit: permit(registry) });
		available = false;
		assert.equal(await registry.closeUnavailablePacks(), 1);
		assert.equal(registry.activeCount(), 0);
		assert.equal(closedReason, "pack unavailable");
	});
});
