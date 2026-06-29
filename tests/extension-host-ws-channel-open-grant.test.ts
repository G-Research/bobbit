import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleWebSocketConnection } from "../src/server/ws/handler.ts";
import { ChannelOpenPermitStore } from "../src/server/extension-host/channel-open-permits.ts";
import { mintSurfaceToken } from "../src/server/extension-host/surface-binding.ts";
import type { ChannelInfo } from "../src/server/ws/protocol.ts";

class FakeWebSocket extends EventEmitter {
	readyState = 1;
	readonly sent: any[] = [];

	send(data: string, cb?: (err?: Error) => void): void {
		this.sent.push(JSON.parse(data));
		cb?.();
	}

	close(code?: number, reason?: string): void {
		this.readyState = 3;
		this.emit("close", code, reason);
	}
}

function makeSessionManager() {
	const clients = new Set<any>();
	const session = {
		id: "sess-1",
		projectId: "project-1",
		status: "idle",
		statusVersion: 7,
		title: "Test session",
		clients,
		eventBuffer: { size: 0 },
		promptQueue: { toArray: () => [] },
		cwd: process.cwd(),
		rpcClient: {},
	};
	return {
		getSession: (id: string) => (id === "sess-1" ? session : undefined),
		getArchivedSession: () => undefined,
		addClient: (_id: string, ws: any) => { clients.add(ws); },
		removeClient: (_id: string, ws: any) => { clients.delete(ws); },
		getPersistedSession: () => undefined,
		getImageModelForSession: () => undefined,
		withSessionCostInState: (_id: string, data: unknown) => data,
		getSessionCostUpdate: () => undefined,
		getPendingToolPermission: () => undefined,
		getProjectContextManager: () => undefined,
	};
}

function makeSurfaceToken(overrides: Partial<{ sessionId: string; packId: string; contributionId: string }> = {}): string {
	return mintSurfaceToken({
		sessionId: "sess-1",
		packId: "terminal",
		contributionId: "panel:terminal",
		...overrides,
	});
}

function makeContributionRegistry() {
	return {
		getPack: (_projectId: string | undefined, packId: string) => (["terminal", "other"].includes(packId) ? { packId } : undefined),
		getPanel: (_projectId: string | undefined, packId: string, id: string) => (packId === id ? { id } : undefined),
		getEntrypoint: () => undefined,
		hasRoute: () => false,
		getChannel: (_projectId: string | undefined, packId: string, name: string) => {
			if (packId === "terminal" && name === "terminal") return { name: "terminal", protocol: "json", module: "terminal.js" };
			if (packId === "other" && name === "other-channel") return { name: "other-channel", protocol: "json", module: "other.js" };
			return undefined;
		},
	};
}

function channelInfo(overrides: Partial<ChannelInfo> = {}): ChannelInfo {
	return {
		id: "chan-1",
		name: "terminal",
		packId: "terminal",
		sessionId: "sess-1",
		state: "open",
		createdAt: 1,
		lastActiveAt: 2,
		attached: true,
		...overrides,
	};
}

async function authenticatedHarness(opts: { channelRegistry?: any; permits?: ChannelOpenPermitStore; trustedApp?: boolean } = {}): Promise<{ ws: FakeWebSocket; permits: ChannelOpenPermitStore }> {
	const ws = new FakeWebSocket();
	const permits = opts.permits ?? new ChannelOpenPermitStore({ now: () => 1_000, randomToken: () => "grant-1" });
	handleWebSocketConnection(
		ws as any,
		"sess-1",
		{ socket: { remoteAddress: "127.0.0.1" } } as any,
		makeSessionManager() as any,
		"token",
		{ isRateLimited: () => false, recordFailure: () => {} } as any,
		undefined,
		true,
		undefined,
		undefined,
		{} as any,
		makeContributionRegistry() as any,
		undefined,
		opts.channelRegistry,
		permits,
	);
	ws.emit("message", JSON.stringify({ type: "auth", token: "ignored", ...(opts.trustedApp ? {} : { clientKind: "extension-channel" }) }));
	await Promise.resolve();
	return { ws, permits };
}

function extMessages(ws: FakeWebSocket): any[] {
	return ws.sent.filter((msg) => typeof msg?.type === "string" && msg.type.startsWith("ext_"));
}

function surfaceTokenAuthorityKey(ws: FakeWebSocket): string | undefined {
	const authOk = ws.sent.find((msg) => msg?.type === "auth_ok");
	return typeof authOk?.surfaceTokenKey === "string" ? authOk.surfaceTokenKey : undefined;
}

async function requestSurfaceToken(ws: FakeWebSocket, requestId: string, packId: string, contributionKind: "panel" | "entrypoint" | "route", contributionId: string, surfaceTokenKey?: string): Promise<any> {
	ws.emit("message", JSON.stringify({ type: "ext_surface_token", requestId, ...(surfaceTokenKey ? { surfaceTokenKey } : {}), packId, contributionKind, contributionId }));
	await Promise.resolve();
	return extMessages(ws).find((msg) => msg.type === "ext_surface_token_result" && msg.requestId === requestId);
}

async function requestOpenGrant(ws: FakeWebSocket, requestId: string, surfaceToken: string, name: string): Promise<any> {
	ws.emit("message", JSON.stringify({ type: "ext_channel_open_grant", requestId, surfaceToken, name, singletonKey: "main" }));
	await Promise.resolve();
	return extMessages(ws).find((msg) => msg.type === "ext_channel_open_grant_result" && msg.requestId === requestId);
}

describe("WebSocket extension channel open grants", () => {
	it("mints a legitimate pack-bound panel surface token over the trusted app websocket", async () => {
		const { ws } = await authenticatedHarness({ trustedApp: true });
		const key = surfaceTokenAuthorityKey(ws);
		assert.equal(typeof key, "string");
		const result = await requestSurfaceToken(ws, "surface", "terminal", "panel", "terminal", key);
		assert.equal(result.type, "ext_surface_token_result");
		assert.equal(result.requestId, "surface");
		assert.equal(result.ok, true);
		assert.equal(typeof result.token, "string");

		const grant = await requestOpenGrant(ws, "grant", result.token, "terminal");
		assert.deepEqual(grant, { type: "ext_channel_open_grant_result", requestId: "grant", ok: true, openGrant: "grant-1" });
		ws.close();
	});

	it("rejects raw same-session websocket attempts to mint a victim pack surface token", async () => {
		const main = await authenticatedHarness({ trustedApp: true });
		assert.equal(typeof surfaceTokenAuthorityKey(main.ws), "string");
		const raw = await authenticatedHarness();
		assert.equal(surfaceTokenAuthorityKey(raw.ws), undefined);

		const forged = await requestSurfaceToken(raw.ws, "surface", "terminal", "panel", "terminal");
		assert.deepEqual(forged, {
			type: "ext_surface_token_result",
			requestId: "surface",
			ok: false,
			error: "pack-bound surface-token mint requires trusted app surface authority",
		});

		const grant = await requestOpenGrant(raw.ws, "grant", forged.token, "terminal");
		assert.deepEqual(grant, {
			type: "ext_channel_open_grant_result",
			requestId: "grant",
			ok: false,
			error: "missing or invalid surface token",
		});
		main.ws.close();
		raw.ws.close();
	});

	it("mints and uses a declared panel channel permit without prior launcher activation", async () => {
		let now = 1_000;
		const permits = new ChannelOpenPermitStore({ now: () => now, randomToken: () => "grant-1" });
		const opened: any[] = [];
		const registry = {
			open: async (input: any) => {
				permits.consume(input.openPermit, {
					sessionId: "sess-1",
					packId: "terminal",
					contributionId: "panel:terminal",
					channelName: "terminal",
					singletonKey: "main",
				});
				opened.push(input);
				return channelInfo();
			},
		};
		const { ws } = await authenticatedHarness({ channelRegistry: registry, permits });
		const surfaceToken = makeSurfaceToken();

		const grant = await requestOpenGrant(ws, "grant", surfaceToken, "terminal");
		assert.deepEqual(grant, { type: "ext_channel_open_grant_result", requestId: "grant", ok: true, openGrant: "grant-1" });

		ws.emit("message", JSON.stringify({ type: "ext_channel_open", requestId: "open", surfaceToken, name: "terminal", init: { singletonKey: "main" }, openGrant: "grant-1" }));
		await Promise.resolve();
		assert.equal(opened.length, 1);
		assert.equal(opened[0].packId, "terminal");
		assert.equal(opened[0].contribution.contributionId, "panel:terminal");
		assert.equal(opened[0].contribution.name, "terminal");

		now = 1_001;
		ws.emit("message", JSON.stringify({ type: "ext_channel_open", requestId: "replay", surfaceToken, name: "terminal", init: { singletonKey: "main" }, openGrant: "grant-1" }));
		await Promise.resolve();
		assert.deepEqual(extMessages(ws).filter((msg) => msg.type.startsWith("ext_channel_")).slice(-3), [
			{ type: "ext_channel_open_grant_result", requestId: "grant", ok: true, openGrant: "grant-1" },
			{ type: "ext_channel_result", requestId: "open", ok: true, channel: channelInfo() },
			{ type: "ext_channel_result", requestId: "replay", ok: false, error: "invalid_open_permit", message: "channel open permit rejected: replayed", status: 403 },
		]);
	});

	it("rejects a grant for an undeclared channel", async () => {
		const { ws } = await authenticatedHarness();
		const result = await requestOpenGrant(ws, "grant", makeSurfaceToken(), "missing");
		assert.deepEqual(result, { type: "ext_channel_open_grant_result", requestId: "grant", ok: false, error: "channel is not declared by this pack" });
	});

	it("rejects a grant when the surface token belongs to another session", async () => {
		const { ws } = await authenticatedHarness();
		const result = await requestOpenGrant(ws, "grant", makeSurfaceToken({ sessionId: "sess-2" }), "terminal");
		assert.deepEqual(result, { type: "ext_channel_open_grant_result", requestId: "grant", ok: false, error: "surface token session mismatch" });
	});

	it("rejects cross-pack channel opens using the caller pack from the surface token", async () => {
		const { ws } = await authenticatedHarness();
		const otherSurface = makeSurfaceToken({ packId: "other", contributionId: "panel:other" });
		const result = await requestOpenGrant(ws, "grant", otherSurface, "terminal");
		assert.deepEqual(result, { type: "ext_channel_open_grant_result", requestId: "grant", ok: false, error: "channel is not declared by this pack" });
	});
});
