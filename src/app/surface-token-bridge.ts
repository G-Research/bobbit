// src/app/surface-token-bridge.ts
//
// Trusted CLIENT transport for pack-bound Extension Host surface-token minting.
// Pack code receives only the HostApi object built by host-api.ts; it cannot import
// this module or access the RemoteAgent WebSocket that services these requests.

import { GW_TOKEN_KEY, GW_URL_KEY } from "./gateway-fetch.js";
import { waitForSurfaceTokenMinter, type PackSurfaceRef } from "./surface-token-minter-registry.js";
export { registerSurfaceTokenMinter, unregisterSurfaceTokenMinter } from "./surface-token-minter-registry.js";
export type { PackSurfaceRef, WsSurfaceTokenMinter } from "./surface-token-minter-registry.js";

const BACKGROUND_TRANSPORT_IDLE_MS = 250;
const BACKGROUND_READY_TIMEOUT_MS = 15_000;
const BACKGROUND_MINT_TIMEOUT_MS = 30_000;

interface BackgroundSurfaceTokenTransport {
	ws: WebSocket;
	authorityKey?: string;
	ready: Promise<void>;
	pending: Map<string, { resolve: (token: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;
	idleTimer?: ReturnType<typeof setTimeout>;
}

const backgroundTransports = new Map<string, BackgroundSurfaceTokenTransport>();

function closeBackgroundTransport(sessionId: string, transport: BackgroundSurfaceTokenTransport, reason: string): void {
	if (backgroundTransports.get(sessionId) === transport) backgroundTransports.delete(sessionId);
	if (transport.idleTimer) clearTimeout(transport.idleTimer);
	for (const pending of transport.pending.values()) {
		clearTimeout(pending.timer);
		pending.reject(new Error(reason));
	}
	transport.pending.clear();
	try { transport.ws.close(); } catch { /* noop */ }
}

function scheduleBackgroundTransportIdleClose(sessionId: string, transport: BackgroundSurfaceTokenTransport): void {
	if (transport.idleTimer) clearTimeout(transport.idleTimer);
	transport.idleTimer = setTimeout(() => {
		if (transport.pending.size === 0) closeBackgroundTransport(sessionId, transport, "pack surface-token background transport closed");
	}, BACKGROUND_TRANSPORT_IDLE_MS);
}

function getBackgroundSurfaceTokenTransport(sessionId: string): BackgroundSurfaceTokenTransport {
	const existing = backgroundTransports.get(sessionId);
	if (existing && existing.ws.readyState !== WebSocket.CLOSING && existing.ws.readyState !== WebSocket.CLOSED) {
		return existing;
	}
	if (existing) closeBackgroundTransport(sessionId, existing, "pack surface-token background transport reset");

	const gatewayUrl = localStorage.getItem(GW_URL_KEY) || window.location.origin;
	const token = localStorage.getItem(GW_TOKEN_KEY) || "";
	if (!token) throw new Error("pack surface-token transport unavailable (missing gateway token)");
	const ws = new WebSocket(`${gatewayUrl.replace(/^http/, "ws")}/ws/${encodeURIComponent(sessionId)}`);
	const pending = new Map<string, { resolve: (token: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	let authorityKey: string | undefined;
	let resolveReady!: () => void;
	let rejectReady!: (error: Error) => void;
	let settled = false;
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const transport: BackgroundSurfaceTokenTransport = { ws, ready, pending };
	const readyTimer = setTimeout(() => {
		if (settled) return;
		settled = true;
		const error = new Error("pack surface-token background WebSocket auth timed out");
		rejectReady(error);
		closeBackgroundTransport(sessionId, transport, error.message);
	}, BACKGROUND_READY_TIMEOUT_MS);
	backgroundTransports.set(sessionId, transport);

	ws.onopen = () => {
		try {
			ws.send(JSON.stringify({ type: "auth", token, clientKind: "app" }));
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			if (!settled) {
				settled = true;
				clearTimeout(readyTimer);
				rejectReady(err);
			}
			closeBackgroundTransport(sessionId, transport, err.message);
		}
	};
	ws.onmessage = (event) => {
		let msg: any;
		try { msg = JSON.parse(event.data); } catch { return; }
		if (!settled) {
			if (msg.type === "auth_ok") {
				settled = true;
				clearTimeout(readyTimer);
				authorityKey = typeof msg.surfaceTokenKey === "string" ? msg.surfaceTokenKey : undefined;
				transport.authorityKey = authorityKey;
				if (!authorityKey) {
					rejectReady(new Error("pack surface-token transport unavailable (missing authority key)"));
					closeBackgroundTransport(sessionId, transport, "pack surface-token transport unavailable (missing authority key)");
					return;
				}
				resolveReady();
				scheduleBackgroundTransportIdleClose(sessionId, transport);
				return;
			}
			if (msg.type === "auth_failed" || msg.type === "error") {
				settled = true;
				clearTimeout(readyTimer);
				const error = new Error(msg.message || "pack surface-token background WebSocket auth failed");
				rejectReady(error);
				closeBackgroundTransport(sessionId, transport, error.message);
				return;
			}
		}
		if (msg.type === "ext_surface_token_result") {
			const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
			const request = pending.get(requestId);
			if (!request) return;
			pending.delete(requestId);
			clearTimeout(request.timer);
			if (msg.ok && typeof msg.token === "string") request.resolve(msg.token);
			else request.reject(new Error(msg.error || "pack surface-token mint failed"));
			if (pending.size === 0) scheduleBackgroundTransportIdleClose(sessionId, transport);
		}
	};
	ws.onerror = () => {
		const error = new Error("pack surface-token background WebSocket failed");
		if (!settled) {
			settled = true;
			clearTimeout(readyTimer);
			rejectReady(error);
		}
		closeBackgroundTransport(sessionId, transport, error.message);
	};
	ws.onclose = () => {
		const error = new Error("pack surface-token background WebSocket closed");
		if (!settled) {
			settled = true;
			clearTimeout(readyTimer);
			rejectReady(error);
		}
		closeBackgroundTransport(sessionId, transport, error.message);
	};
	return transport;
}

async function mintPackSurfaceTokenWithBackgroundTransport(sessionId: string, surface: PackSurfaceRef): Promise<string> {
	const transport = getBackgroundSurfaceTokenTransport(sessionId);
	await transport.ready;
	if (!transport.authorityKey) throw new Error("pack surface-token transport unavailable (missing authority key)");
	if (transport.ws.readyState !== WebSocket.OPEN) throw new Error("pack surface-token background WebSocket is not open");
	const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	const result = new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			transport.pending.delete(requestId);
			reject(new Error("pack surface-token background mint timed out"));
			if (transport.pending.size === 0) scheduleBackgroundTransportIdleClose(sessionId, transport);
		}, BACKGROUND_MINT_TIMEOUT_MS);
		transport.pending.set(requestId, { resolve, reject, timer });
	});
	try {
		transport.ws.send(JSON.stringify({
			type: "ext_surface_token",
			requestId,
			surfaceTokenKey: transport.authorityKey,
			packId: surface.packId,
			contributionKind: surface.contributionKind,
			contributionId: surface.contributionId,
		}));
	} catch (error) {
		const pending = transport.pending.get(requestId);
		if (pending) {
			transport.pending.delete(requestId);
			clearTimeout(pending.timer);
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
		if (transport.pending.size === 0) scheduleBackgroundTransportIdleClose(sessionId, transport);
	}
	return result;
}

export async function mintPackSurfaceTokenOverWs(sessionId: string | undefined, surface: PackSurfaceRef): Promise<string> {
	if (!sessionId) throw new Error("pack surface-token mint requires a bound session");
	const minter = await waitForSurfaceTokenMinter(sessionId);
	if (minter) {
		try {
			return await minter(surface);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!/WebSocket not connected|WebSocket closed|transport unavailable|key unavailable/i.test(message)) throw error;
		}
	}
	return mintPackSurfaceTokenWithBackgroundTransport(sessionId, surface);
}
