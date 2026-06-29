// src/app/channel-bridge.ts
//
// Trusted client transport for the generic Extension Host `host.channels` API.
// Pack code receives only the HostChannel abstraction constructed by host-api.ts;
// this module owns the private Bobbit WebSocket, request correlation, open-grant
// minting, and server frame dispatch. It deliberately exports no raw socket, URL,
// bearer token, or caller-selectable pack identity.

import { GW_TOKEN_KEY, GW_URL_KEY } from "./gateway-fetch.js";

export type HostChannelFrame =
	| { kind: "text"; data: string }
	| { kind: "json"; data: unknown };

export interface HostChannelOpenInit {
	data?: unknown;
	singletonKey?: string;
}

export interface ChannelInfo {
	id: string;
	name: string;
	packId: string;
	sessionId: string;
	state: "opening" | "open" | "closing" | "closed";
	createdAt: number;
	lastActiveAt: number;
	attached: boolean;
	closeReason?: string;
}

export interface HostChannel {
	readonly id: string;
	readonly name: string;
	readonly state: "open" | "closing" | "closed";
	send(frame: HostChannelFrame): Promise<void>;
	close(reason?: string): Promise<void>;
	onFrame(cb: (frame: HostChannelFrame) => void): () => void;
	onClose(cb: (ev: { reason?: string; error?: string }) => void): () => void;
}

export interface HostChannelsApi {
	open(name: string, init?: HostChannelOpenInit): Promise<HostChannel>;
	attach(id: string): Promise<HostChannel>;
	list(opts?: { name?: string; includeClosed?: boolean }): Promise<ChannelInfo[]>;
}

interface BridgeOptions {
	sessionId: string | undefined;
	getSurfaceToken: () => Promise<string>;
	invalidateSurfaceToken?: () => void;
	consumeOpenGesture: () => boolean;
}

type Pending = {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type ServerChannelMessage =
	| { type: "auth_ok"; surfaceTokenKey?: string }
	| { type: "auth_failed" }
	| { type: "ext_channel_open_grant_result"; requestId: string; ok: boolean; openGrant?: string; error?: string }
	| { type: "ext_channel_result"; requestId: string; ok: boolean; channel?: ChannelInfo; channels?: ChannelInfo[]; error?: string }
	| { type: "ext_channel_frame"; channelId: string; frame: HostChannelFrame }
	| { type: "ext_channel_close"; channelId: string; reason?: string; error?: string }
	| { type: "error"; message?: string; code?: string };

function makeRequestId(prefix: string): string {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function isFrame(value: unknown): value is HostChannelFrame {
	if (!value || typeof value !== "object") return false;
	const frame = value as { kind?: unknown; data?: unknown };
	return (frame.kind === "text" && typeof frame.data === "string") || frame.kind === "json";
}

class ClientHostChannel implements HostChannel {
	private _state: "open" | "closing" | "closed" = "open";
	private readonly frameListeners = new Set<(frame: HostChannelFrame) => void>();
	private readonly closeListeners = new Set<(ev: { reason?: string; error?: string }) => void>();

	constructor(
		private readonly bridge: ChannelBridge,
		private readonly info: ChannelInfo,
	) {}

	get id(): string { return this.info.id; }
	get name(): string { return this.info.name; }
	get state(): "open" | "closing" | "closed" { return this._state; }

	async send(frame: HostChannelFrame): Promise<void> {
		if (this._state !== "open") throw new Error(`channel ${this.id} is ${this._state}`);
		if (!isFrame(frame)) throw new Error("host.channels.send supports only text/json frames");
		await this.bridge.sendChannelFrame(this.id, frame);
	}

	async close(reason?: string): Promise<void> {
		if (this._state === "closed") return;
		this._state = "closing";
		await this.bridge.closeChannel(this.id, reason);
		this._markClosed({ reason });
	}

	onFrame(cb: (frame: HostChannelFrame) => void): () => void {
		this.frameListeners.add(cb);
		return () => { this.frameListeners.delete(cb); };
	}

	onClose(cb: (ev: { reason?: string; error?: string }) => void): () => void {
		this.closeListeners.add(cb);
		return () => { this.closeListeners.delete(cb); };
	}

	_emitFrame(frame: HostChannelFrame): void {
		if (this._state === "closed") return;
		for (const cb of [...this.frameListeners]) cb(frame);
	}

	_markClosed(ev: { reason?: string; error?: string }): void {
		if (this._state === "closed") return;
		this._state = "closed";
		for (const cb of [...this.closeListeners]) cb(ev);
	}
}

class ChannelBridge {
	private ws: WebSocket | null = null;
	private connectPromise: Promise<void> | null = null;
	private pending = new Map<string, Pending>();
	private channels = new Map<string, ClientHostChannel>();

	constructor(private readonly sessionId: string) {}

	async open(surfaceToken: string, name: string, init?: HostChannelOpenInit): Promise<HostChannel> {
		const openGrant = await this.mintOpenGrant(surfaceToken, name, init?.singletonKey);
		const channel = await this.requestChannel({
			type: "ext_channel_open",
			surfaceToken,
			name,
			init,
			openGrant,
		});
		return this.remember(channel);
	}

	async attach(surfaceToken: string, id: string): Promise<HostChannel> {
		const channel = await this.requestChannel({ type: "ext_channel_attach", surfaceToken, channelId: id });
		return this.remember(channel);
	}

	async list(surfaceToken: string, opts?: { name?: string; includeClosed?: boolean }): Promise<ChannelInfo[]> {
		await this.ensureConnected();
		const requestId = makeRequestId("extchlist");
		const result = await this.request({ type: "ext_channel_list", requestId, surfaceToken, opts });
		if (!Array.isArray(result.channels)) return [];
		return result.channels as ChannelInfo[];
	}

	async sendChannelFrame(channelId: string, frame: HostChannelFrame): Promise<void> {
		await this.requestAck({ type: "ext_channel_send", channelId, frame });
	}

	async closeChannel(channelId: string, reason?: string): Promise<void> {
		await this.requestAck({ type: "ext_channel_close", channelId, reason });
	}

	private async mintOpenGrant(surfaceToken: string, name: string, singletonKey?: string): Promise<string> {
		await this.ensureConnected();
		const requestId = makeRequestId("extchgrant");
		const result = await this.request({
			type: "ext_channel_open_grant",
			requestId,
			surfaceToken,
			name,
			...(singletonKey !== undefined ? { singletonKey } : {}),
		});
		if (typeof result.openGrant !== "string" || !result.openGrant) throw new Error("host.channels.open: empty open grant");
		return result.openGrant;
	}

	private async requestChannel(msg: Record<string, unknown>): Promise<ChannelInfo> {
		await this.ensureConnected();
		const requestId = makeRequestId("extch");
		const result = await this.request({ ...msg, requestId });
		if (!result.channel || typeof result.channel !== "object") throw new Error("host.channels: empty channel response");
		return result.channel as ChannelInfo;
	}

	private async requestAck(msg: Record<string, unknown>): Promise<void> {
		await this.ensureConnected();
		const requestId = makeRequestId("extch");
		await this.request({ ...msg, requestId });
	}

	private request(msg: Record<string, unknown> & { requestId: string }): Promise<any> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(msg.requestId)) reject(new Error("host.channels: timed out awaiting server response"));
			}, 30_000);
			this.pending.set(msg.requestId, { resolve, reject, timer });
			try {
				this.ws!.send(JSON.stringify(msg));
			} catch (err) {
				this.pending.delete(msg.requestId);
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private remember(info: ChannelInfo): HostChannel {
		const existing = this.channels.get(info.id);
		if (existing && existing.state !== "closed") return existing;
		const channel = new ClientHostChannel(this, info);
		this.channels.set(info.id, channel);
		return channel;
	}

	private ensureConnected(): Promise<void> {
		if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
		if (this.connectPromise) return this.connectPromise;
		const url = localStorage.getItem(GW_URL_KEY) || window.location.origin;
		const token = localStorage.getItem(GW_TOKEN_KEY) || "";
		const wsUrl = url.replace(/^http/, "ws");
		this.connectPromise = new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(`${wsUrl}/ws/${this.sessionId}`);
			this.ws = ws;
			const timer = setTimeout(() => {
				reject(new Error("host.channels: timed out connecting WebSocket"));
				try { ws.close(); } catch { /* ignore */ }
			}, 15_000);
			ws.onopen = () => {
				ws.send(JSON.stringify({ type: "auth", token, clientKind: "extension-channel" }));
			};
			ws.onmessage = (evt) => this.handleMessage(evt.data, resolve, reject, timer);
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error("host.channels: WebSocket error"));
			};
			ws.onclose = () => {
				clearTimeout(timer);
				if (this.ws === ws) this.ws = null;
				this.connectPromise = null;
				this.rejectPending("transport closed");
				for (const channel of this.channels.values()) channel._markClosed({ error: "transport closed" });
			};
		});
		this.connectPromise.catch(() => {
			this.connectPromise = null;
		});
		return this.connectPromise;
	}

	private handleMessage(data: unknown, resolveConnect: () => void, rejectConnect: (error: Error) => void, connectTimer: ReturnType<typeof setTimeout>): void {
		let msg: ServerChannelMessage;
		try { msg = JSON.parse(String(data)); }
		catch { return; }
		if (msg.type === "auth_ok") {
			clearTimeout(connectTimer);
			resolveConnect();
			return;
		}
		if (msg.type === "auth_failed") {
			clearTimeout(connectTimer);
			rejectConnect(new Error("host.channels: authentication failed"));
			return;
		}
		if (msg.type === "ext_channel_open_grant_result" || msg.type === "ext_channel_result") {
			this.settle(msg.requestId, msg.ok, msg);
			return;
		}
		if (msg.type === "ext_channel_frame") {
			const channel = this.channels.get(msg.channelId);
			if (channel && isFrame(msg.frame)) channel._emitFrame(msg.frame);
			return;
		}
		if (msg.type === "ext_channel_close") {
			const channel = this.channels.get(msg.channelId);
			if (channel) channel._markClosed({ reason: msg.reason, error: msg.error });
		}
	}

	private settle(requestId: string, ok: boolean, payload: any): void {
		const pending = this.pending.get(requestId);
		if (!pending) return;
		this.pending.delete(requestId);
		clearTimeout(pending.timer);
		if (ok) pending.resolve(payload);
		else pending.reject(new Error(typeof payload.error === "string" && payload.error ? payload.error : "host.channels request failed"));
	}

	private rejectPending(reason: string): void {
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const p of pending) {
			clearTimeout(p.timer);
			p.reject(new Error(`host.channels: ${reason}`));
		}
	}
}

const bridges = new Map<string, ChannelBridge>();

function isSurfaceTokenError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err ?? "");
	return /surface token|surface-token/i.test(message);
}

export function createHostChannelsApi(opts: BridgeOptions): HostChannelsApi {
	const getBridge = (): ChannelBridge => {
		if (!opts.sessionId) throw new Error("host.channels requires a bound session");
		let bridge = bridges.get(opts.sessionId);
		if (!bridge) {
			bridge = new ChannelBridge(opts.sessionId);
			bridges.set(opts.sessionId, bridge);
		}
		return bridge;
	};
	return {
		open(name, init) {
			if (typeof name !== "string" || !name.trim()) return Promise.reject(new Error("host.channels.open requires a channel name"));
			return (async () => {
				try {
					return await getBridge().open(await opts.getSurfaceToken(), name, init);
				} catch (err) {
					if (!isSurfaceTokenError(err) || !opts.invalidateSurfaceToken) throw err;
					opts.invalidateSurfaceToken();
					return getBridge().open(await opts.getSurfaceToken(), name, init);
				}
			})();
		},
		attach(id) {
			if (typeof id !== "string" || !id.trim()) return Promise.reject(new Error("host.channels.attach requires a channel id"));
			return (async () => getBridge().attach(await opts.getSurfaceToken(), id))();
		},
		list(optsList) {
			return (async () => getBridge().list(await opts.getSurfaceToken(), optsList))();
		},
	};
}
