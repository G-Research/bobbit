/**
 * Unit — generic channel substrate behaviour with public test seams/mocks.
 *
 * The production channel modules are expected to land in parallel implementation
 * branches. Until then these tests fail with explicit "expected dependency" text;
 * after merge they exercise grants, frame validation, lifecycle, quotas, singleton
 * reuse, tombstones, detach-vs-close, and session cleanup without terminal code.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

type AnyRecord = Record<string, any>;

type ChannelTarget = {
	sessionId: string;
	projectId?: string;
	packId: string;
	contributionId: string;
	channelName: string;
	singletonKey?: string;
};

async function importExpected(modulePath: string): Promise<AnyRecord> {
	try {
		return await import(modulePath) as AnyRecord;
	} catch (err: any) {
		assert.fail(`expected channel implementation dependency ${modulePath}: ${err?.message ?? err}`);
	}
}

function pick(obj: AnyRecord, names: string[], label: string): any {
	for (const name of names) {
		if (typeof obj?.[name] === "function") return obj[name].bind(obj);
	}
	assert.fail(`${label} must expose one of: ${names.join(", ")}`);
}

function construct(mod: AnyRecord, names: string[], args: unknown, label: string): any {
	for (const name of names) {
		if (typeof mod[name] === "function") return new mod[name](args);
	}
	assert.fail(`${label} module must export one of: ${names.join(", ")}`);
}

async function mintGrant(store: any, target: ChannelTarget): Promise<string> {
	const fn = pick(store, ["mint", "mintGrant", "mintOpenGrant", "create", "createGrant"], "open grant service");
	const grant = await fn(target);
	assert.equal(typeof grant, "string");
	assert.match(grant, /\S/);
	return grant;
}

async function consumeGrant(store: any, grant: string | undefined, target: ChannelTarget): Promise<void> {
	const fn = pick(store, ["consume", "consumeGrant", "consumeOpenGrant", "validateAndConsume"], "open grant service");
	await fn(grant, target);
}

function assertFrameAccepted(mod: AnyRecord, frame: unknown, opts?: AnyRecord): void {
	const fn = mod.validateChannelFrame ?? mod.assertValidChannelFrame ?? mod.normalizeChannelFrame;
	assert.equal(typeof fn, "function", "channel-types must export validate/assert frame helper");
	const result = fn(frame, opts);
	if (result === false || result?.ok === false) assert.fail(`expected frame to be accepted: ${JSON.stringify(frame)}`);
}

function assertFrameRejected(mod: AnyRecord, frame: unknown, pattern: RegExp, opts?: AnyRecord): void {
	const fn = mod.validateChannelFrame ?? mod.assertValidChannelFrame ?? mod.normalizeChannelFrame;
	assert.equal(typeof fn, "function", "channel-types must export validate/assert frame helper");
	try {
		const result = fn(frame, opts);
		if (result === false || result?.ok === false) {
			assert.match(String(result?.error ?? result?.reason ?? "invalid frame"), pattern);
			return;
		}
		assert.fail(`expected frame to be rejected: ${JSON.stringify(frame)}`);
	} catch (err: any) {
		assert.match(String(err?.message ?? err), pattern);
	}
}

function target(overrides: Partial<ChannelTarget> = {}): ChannelTarget {
	return {
		sessionId: "session-a",
		projectId: "project-a",
		packId: "pack-a",
		contributionId: "panel-a",
		channelName: "echo",
		...overrides,
	};
}

function contribution(overrides: AnyRecord = {}): AnyRecord {
	return {
		name: "echo",
		protocol: "echo.v1",
		module: "lib/echo.mjs",
		handler: "echo",
		requiresUserGesture: true,
		maxChannelsPerSessionPerPack: 2,
		maxFrameBytes: 64,
		maxInboundBufferedFrames: 4,
		maxOutboundBufferedFrames: 4,
		maxAttachedClientBufferedFrames: 2,
		maxInboundFramesPerSecond: 100,
		maxOutboundFramesPerSecond: 100,
		idleTimeoutMs: 60_000,
		openTimeoutMs: 1_000,
		closeGraceMs: 100,
		...overrides,
	};
}

async function makeRegistryHarness(opts: { contrib?: AnyRecord; now?: () => number } = {}): Promise<AnyRecord> {
	const grantsMod = await importExpected("../src/server/extension-host/channel-open-grants.ts");
	const registryMod = await importExpected("../src/server/extension-host/channel-registry.ts");
	const contrib = opts.contrib ?? contribution();
	const opened: AnyRecord[] = [];
	const inbound: unknown[] = [];
	const outbound: unknown[] = [];
	const audits: AnyRecord[] = [];
	let closed = 0;
	let now = opts.now?.() ?? 1_000;
	const nowFn = opts.now ?? (() => now);
	const grantStore = construct(grantsMod, ["ChannelOpenGrantStore", "ChannelOpenGrantService", "OpenGrantService"], { now: nowFn, ttlMs: 1_000 }, "open grants");
	const surfaceBindings = new Map<string, AnyRecord>([
		["surface-a", { sessionId: "session-a", packId: "pack-a", contributionId: "panel-a" }],
		["surface-b", { sessionId: "session-b", packId: "pack-a", contributionId: "panel-a" }],
		["surface-other-pack", { sessionId: "session-a", packId: "pack-b", contributionId: "panel-b" }],
	]);
	const registry = construct(registryMod, ["ChannelRegistry", "ExtensionHostChannelRegistry"], {
		now: nowFn,
		openGrants: grantStore,
		grants: grantStore,
		audit: (event: AnyRecord) => audits.push(event),
		auditLog: { write: (event: AnyRecord) => audits.push(event) },
		surfaceBindings: { resolve: (token: string) => surfaceBindings.get(token), validate: (token: string) => surfaceBindings.get(token) },
		contributionRegistry: {
			getChannel: (_projectId: string | undefined, packId: string, name: string) => (packId === "pack-a" && name === contrib.name ? contrib : undefined),
		},
		dispatcher: {
			open: async (ctx: AnyRecord) => {
				opened.push(ctx);
				return {
					onClientFrame: async (frame: unknown) => { inbound.push(frame); },
					send: async (frame: unknown) => { outbound.push(frame); },
					close: async () => { closed++; },
				};
			},
			openChannel: async (ctx: AnyRecord) => {
				opened.push(ctx);
				return {
					onFrame: async (frame: unknown) => { inbound.push(frame); },
					emit: async (frame: unknown) => { outbound.push(frame); },
					close: async () => { closed++; },
				};
			},
		},
	});
	return { registry, grantStore, opened, inbound, outbound, audits, get closed() { return closed; }, tick: (ms: number) => { now += ms; } };
}

async function registryCall(registry: any, names: string[], args: AnyRecord): Promise<any> {
	return pick(registry, names, "channel registry")(args);
}

async function openChannel(h: AnyRecord, args: AnyRecord): Promise<any> {
	return registryCall(h.registry, ["open", "openChannel"], args);
}
async function attachChannel(h: AnyRecord, args: AnyRecord): Promise<any> {
	return registryCall(h.registry, ["attach", "attachChannel"], args);
}
async function listChannels(h: AnyRecord, args: AnyRecord): Promise<any[]> {
	return registryCall(h.registry, ["list", "listChannels"], args);
}
async function sendFrame(h: AnyRecord, args: AnyRecord): Promise<void> {
	await registryCall(h.registry, ["send", "sendFrame", "receiveClientFrame"], args);
}
async function detachChannel(h: AnyRecord, args: AnyRecord): Promise<void> {
	await registryCall(h.registry, ["detach", "detachChannel", "detachClient"], args);
}
async function closeChannel(h: AnyRecord, args: AnyRecord): Promise<void> {
	await registryCall(h.registry, ["close", "closeChannel"], args);
}
async function cleanupSession(h: AnyRecord, sessionId: string): Promise<void> {
	await registryCall(h.registry, ["cleanupSession", "closeForSession", "closeSessionChannels"], { sessionId, reason: "session terminated" });
}

function channelId(ch: AnyRecord): string {
	assert.equal(typeof ch?.id, "string", `channel open/attach result must include id; got ${JSON.stringify(ch)}`);
	return ch.id;
}

describe("channel open grants", () => {
	it("requires valid one-shot grants bound to session/pack/contribution/channel/singleton", async () => {
		let now = 1_000;
		const mod = await importExpected("../src/server/extension-host/channel-open-grants.ts");
		const grants = construct(mod, ["ChannelOpenGrantStore", "ChannelOpenGrantService", "OpenGrantService"], { now: () => now, ttlMs: 100 }, "open grants");
		const base = target({ singletonKey: "primary" });

		await assert.rejects(() => consumeGrant(grants, undefined, base), /grant|required|missing/i);
		await assert.rejects(() => consumeGrant(grants, "forged", base), /grant|invalid|unknown|forged/i);

		const grant = await mintGrant(grants, base);
		await assert.rejects(() => consumeGrant(grants, grant, target({ singletonKey: "other" })), /mismatch|bound|singleton/i);
		await consumeGrant(grants, grant, base);
		await assert.rejects(() => consumeGrant(grants, grant, base), /used|replay|consumed/i);

		const expiring = await mintGrant(grants, base);
		now += 101;
		await assert.rejects(() => consumeGrant(grants, expiring, base), /expired|ttl/i);
	});
});

describe("channel frame validation", () => {
	it("accepts only v1 text/json frames and rejects binary/invalid shapes", async () => {
		const mod = await importExpected("../src/server/extension-host/channel-types.ts");
		assertFrameAccepted(mod, { kind: "text", data: "hello" }, { maxFrameBytes: 128 });
		assertFrameAccepted(mod, { kind: "json", data: { op: "resize", cols: 80, rows: 24 } }, { maxFrameBytes: 128 });
		assertFrameRejected(mod, { kind: "bytes", data: [1, 2, 3] }, /binary|bytes|kind/i);
		assertFrameRejected(mod, { kind: "binary", data: "AAAA" }, /binary|bytes|kind/i);
		assertFrameRejected(mod, { kind: "text", data: 123 }, /text|string|data/i);
		assertFrameRejected(mod, { kind: "json" }, /data|frame/i);
		assertFrameRejected(mod, { kind: "text", data: "x".repeat(65) }, /size|bytes|quota/i, { maxFrameBytes: 64 });
	});
});

describe("channel registry lifecycle and authorization", () => {
	it("rejects raw open without a grant before handler creation", async () => {
		const h = await makeRegistryHarness();
		await assert.rejects(() => openChannel(h, {
			sessionId: "session-a",
			projectId: "project-a",
			clientId: "client-a",
			surfaceToken: "surface-a",
			name: "echo",
			init: {},
		}), /grant|required|missing/i);
		assert.equal(h.opened.length, 0, "missing grants must be rejected before handler/PTY creation");
	});

	it("rejects cross-session/cross-pack opens and mismatched grants before handler creation", async () => {
		const h = await makeRegistryHarness();
		const grant = await mintGrant(h.grantStore, target());
		await assert.rejects(() => openChannel(h, {
			sessionId: "session-a",
			projectId: "project-a",
			clientId: "client-a",
			surfaceToken: "surface-b",
			name: "echo",
			openGrant: grant,
			init: {},
		}), /session|scope|token|mismatch/i);
		const otherPackGrant = await mintGrant(h.grantStore, target({ packId: "pack-b", contributionId: "panel-b" }));
		await assert.rejects(() => openChannel(h, {
			sessionId: "session-a",
			projectId: "project-a",
			clientId: "client-a",
			surfaceToken: "surface-other-pack",
			name: "echo",
			openGrant: otherPackGrant,
			init: {},
		}), /pack|scope|handler|channel/i);
		assert.equal(h.opened.length, 0);
	});

	it("opens, lists, sends text/json, detaches without close, attaches, then closes with a tombstone", async () => {
		const h = await makeRegistryHarness();
		const openGrant = await mintGrant(h.grantStore, target({ singletonKey: "primary" }));
		const ch = await openChannel(h, {
			sessionId: "session-a",
			projectId: "project-a",
			clientId: "client-a",
			surfaceToken: "surface-a",
			name: "echo",
			openGrant,
			init: { singletonKey: "primary", data: { hello: true } },
		});
		const id = channelId(ch);
		assert.equal(h.opened.length, 1);

		let listed = await listChannels(h, { sessionId: "session-a", projectId: "project-a", surfaceToken: "surface-a" });
		assert.deepEqual(listed.map((c) => ({ id: c.id, name: c.name, attached: c.attached, state: c.state })), [{ id, name: "echo", attached: true, state: "open" }]);

		await sendFrame(h, { sessionId: "session-a", clientId: "client-a", surfaceToken: "surface-a", channelId: id, frame: { kind: "text", data: "ping" } });
		await sendFrame(h, { sessionId: "session-a", clientId: "client-a", surfaceToken: "surface-a", channelId: id, frame: { kind: "json", data: { op: "resize", cols: 80, rows: 24 } } });
		assert.deepEqual(h.inbound, [{ kind: "text", data: "ping" }, { kind: "json", data: { op: "resize", cols: 80, rows: 24 } }]);

		await detachChannel(h, { sessionId: "session-a", clientId: "client-a", surfaceToken: "surface-a", channelId: id });
		assert.equal(h.closed, 0, "detach/remount must not close the handler resource");
		listed = await listChannels(h, { sessionId: "session-a", projectId: "project-a", surfaceToken: "surface-a" });
		assert.equal(listed[0].attached, false);

		const attached = await attachChannel(h, { sessionId: "session-a", projectId: "project-a", clientId: "client-b", surfaceToken: "surface-a", channelId: id });
		assert.equal(channelId(attached), id);
		await closeChannel(h, { sessionId: "session-a", clientId: "client-b", surfaceToken: "surface-a", channelId: id, reason: "test close" });
		assert.equal(h.closed, 1);

		listed = await listChannels(h, { sessionId: "session-a", projectId: "project-a", surfaceToken: "surface-a", includeClosed: true });
		assert.equal(listed.find((c) => c.id === id)?.state, "closed");
		await assert.rejects(() => attachChannel(h, { sessionId: "session-a", projectId: "project-a", clientId: "client-c", surfaceToken: "surface-a", channelId: id }), /closed|not found|tombstone/i);
	});

	it("reuses singleton channels and preserves closed tombstones without reopening", async () => {
		const h = await makeRegistryHarness();
		const first = await openChannel(h, {
			sessionId: "session-a",
			projectId: "project-a",
			clientId: "client-a",
			surfaceToken: "surface-a",
			name: "echo",
			openGrant: await mintGrant(h.grantStore, target({ singletonKey: "primary" })),
			init: { singletonKey: "primary" },
		});
		const second = await openChannel(h, {
			sessionId: "session-a",
			projectId: "project-a",
			clientId: "client-b",
			surfaceToken: "surface-a",
			name: "echo",
			openGrant: await mintGrant(h.grantStore, target({ singletonKey: "primary" })),
			init: { singletonKey: "primary" },
		});
		assert.equal(channelId(second), channelId(first), "same session+pack+name+singletonKey reuses the live channel");
		assert.equal(h.opened.length, 1, "singleton reuse must not create a second handler");

		await closeChannel(h, { sessionId: "session-a", clientId: "client-a", surfaceToken: "surface-a", channelId: channelId(first), reason: "done" });
		const afterCloseGrant = await mintGrant(h.grantStore, target({ singletonKey: "primary" }));
		await assert.rejects(() => openChannel(h, {
			sessionId: "session-a",
			projectId: "project-a",
			clientId: "client-c",
			surfaceToken: "surface-a",
			name: "echo",
			openGrant: afterCloseGrant,
			init: { singletonKey: "primary" },
		}), /closed|tombstone|restart|new singleton/i);
	});

	it("enforces inbound frame size/count quotas and audits bounded denial", async () => {
		const h = await makeRegistryHarness({ contrib: contribution({ maxFrameBytes: 16, maxInboundBufferedFrames: 1 }) });
		const ch = await openChannel(h, {
			sessionId: "session-a",
			projectId: "project-a",
			clientId: "client-a",
			surfaceToken: "surface-a",
			name: "echo",
			openGrant: await mintGrant(h.grantStore, target()),
			init: {},
		});
		const id = channelId(ch);
		await assert.rejects(() => sendFrame(h, { sessionId: "session-a", clientId: "client-a", surfaceToken: "surface-a", channelId: id, frame: { kind: "text", data: "x".repeat(32) } }), /size|bytes|quota|backpressure/i);
		await sendFrame(h, { sessionId: "session-a", clientId: "client-a", surfaceToken: "surface-a", channelId: id, frame: { kind: "text", data: "a" } });
		await assert.rejects(() => sendFrame(h, { sessionId: "session-a", clientId: "client-a", surfaceToken: "surface-a", channelId: id, frame: { kind: "text", data: "b" } }), /quota|backpressure|buffer/i);
		assert.ok(h.audits.some((e: AnyRecord) => /quota|backpressure|frame/i.test(JSON.stringify(e))), "quota/backpressure denial must be audited without payload logging");
		assert.equal(JSON.stringify(h.audits).includes("xxxxxxxx"), false, "audit logs must not include frame payloads");
	});

	it("closes all channels for a terminated session and rejects later attach/send", async () => {
		const h = await makeRegistryHarness();
		const ch = await openChannel(h, {
			sessionId: "session-a",
			projectId: "project-a",
			clientId: "client-a",
			surfaceToken: "surface-a",
			name: "echo",
			openGrant: await mintGrant(h.grantStore, target()),
			init: {},
		});
		const id = channelId(ch);
		await cleanupSession(h, "session-a");
		assert.equal(h.closed, 1);
		await assert.rejects(() => attachChannel(h, { sessionId: "session-a", projectId: "project-a", clientId: "client-b", surfaceToken: "surface-a", channelId: id }), /closed|terminated|not found/i);
		await assert.rejects(() => sendFrame(h, { sessionId: "session-a", clientId: "client-a", surfaceToken: "surface-a", channelId: id, frame: { kind: "text", data: "late" } }), /closed|terminated|not found/i);
	});
});
