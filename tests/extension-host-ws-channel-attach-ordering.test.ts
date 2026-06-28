import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleWebSocketConnection } from "../src/server/ws/handler.ts";
import { mintSurfaceToken } from "../src/server/extension-host/surface-binding.ts";
import type { ChannelInfo } from "../src/server/ws/protocol.ts";
import type { HostChannelFrame } from "../src/server/extension-host/channel-types.ts";

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

function makeSurfaceToken(): string {
	return mintSurfaceToken({ sessionId: "sess-1", packId: "terminal", contributionId: "panel:terminal" });
}

function makeContributionRegistry() {
	return {
		getPack: (_projectId: string | undefined, packId: string) => (packId === "terminal" ? { packId: "terminal" } : undefined),
		getPanel: (_projectId: string | undefined, packId: string, id: string) => (packId === "terminal" && id === "terminal" ? { id: "terminal" } : undefined),
		getEntrypoint: () => undefined,
		hasRoute: () => false,
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

async function authenticatedHarness(channelRegistry: any): Promise<FakeWebSocket> {
	const ws = new FakeWebSocket();
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
		channelRegistry,
		undefined,
	);
	ws.emit("message", JSON.stringify({ type: "auth", token: "ignored" }));
	await Promise.resolve();
	return ws;
}

function extMessages(ws: FakeWebSocket): any[] {
	return ws.sent.filter((msg) => typeof msg?.type === "string" && msg.type.startsWith("ext_channel_"));
}

describe("WebSocket extension channel attach ordering", () => {
	it("sends attach result before frames emitted synchronously by channelRegistry.attach", async () => {
		const replayFrame: HostChannelFrame = { kind: "text", data: "replayed history" };
		const statusFrame: HostChannelFrame = { kind: "json", data: { op: "status", state: "attached" } };
		const registry = {
			attach: async ({ client }: any) => {
				client.onFrame(replayFrame);
				client.onFrame(statusFrame);
				return channelInfo();
			},
		};
		const ws = await authenticatedHarness(registry);

		ws.emit("message", JSON.stringify({ type: "ext_channel_attach", requestId: "attach-1", surfaceToken: makeSurfaceToken(), channelId: "chan-1" }));
		await Promise.resolve();

		assert.deepEqual(extMessages(ws), [
			{ type: "ext_channel_result", requestId: "attach-1", ok: true, channel: channelInfo() },
			{ type: "ext_channel_frame", channelId: "chan-1", frame: replayFrame },
			{ type: "ext_channel_frame", channelId: "chan-1", frame: statusFrame },
		]);
	});

	it("sends attach result before a close emitted synchronously by channelRegistry.attach and clears the attachment", async () => {
		const registry = {
			attach: async ({ client }: any) => {
				client.onClose({ reason: "closed during attach" });
				return channelInfo({ state: "closed", attached: false, closeReason: "closed during attach" });
			},
			send: async () => assert.fail("closed attach must not remain sendable"),
		};
		const ws = await authenticatedHarness(registry);

		ws.emit("message", JSON.stringify({ type: "ext_channel_attach", requestId: "attach-1", surfaceToken: makeSurfaceToken(), channelId: "chan-1" }));
		await Promise.resolve();
		ws.emit("message", JSON.stringify({ type: "ext_channel_send", requestId: "send-1", channelId: "chan-1", frame: { kind: "text", data: "after close" } }));
		await Promise.resolve();

		assert.deepEqual(extMessages(ws), [
			{ type: "ext_channel_result", requestId: "attach-1", ok: true, channel: channelInfo({ state: "closed", attached: false, closeReason: "closed during attach" }) },
			{ type: "ext_channel_close", channelId: "chan-1", reason: "closed during attach" },
			{ type: "ext_channel_result", requestId: "send-1", ok: false, error: "channel is not attached to this connection" },
		]);
	});
});
