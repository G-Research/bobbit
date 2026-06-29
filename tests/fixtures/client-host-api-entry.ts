// Test entry — exercises the Phase-1 CLIENT Host API `getHostApi`
// (src/app/host-api.ts), the durable v1 contract (design extension-host.md §3).
//
// Pins:
//   1. `host.capabilities` is the single source of truth: invokeAction +
//      requestRender are true; the Phase-2 caps (callRoute/session/ui/store) are
//      false; `has(name)` mirrors the flags.
//   2. `version`/`contractVersion` are the frozen consts.
//   3. There is NO `gateway` member (escape hatch removed).
//   4. Every Phase-2 stub throws "reserved for Phase 2".
//
// Loaded under a file:// fixture so the real `getHostApi` (which transitively
// imports lit/renderer-registry/state) runs in a browser context.
import { getHostApi } from "../../src/app/host-api.js";
import { registerSurfaceTokenMinter, unregisterSurfaceTokenMinter } from "../../src/app/surface-token-bridge.js";

(window as any).__getHostApi = () => getHostApi("sess-1", "tu-1");

// Capture a snapshot of the capability flags + meta for assertions.
(window as any).__caps = () => {
	const h = getHostApi("sess-1", "tu-1");
	return {
		version: h.version,
		contractVersion: h.contractVersion,
		invokeAction: h.capabilities.invokeAction,
		requestRender: h.capabilities.requestRender,
		callRoute: h.capabilities.callRoute,
		session: h.capabilities.session,
		ui: h.capabilities.ui,
		store: h.capabilities.store,
		hasInvokeAction: h.capabilities.has("invokeAction"),
		hasCallRoute: h.capabilities.has("callRoute"),
		hasUnknown: h.capabilities.has("nope"),
		hasGatewayMember: (h as Record<string, unknown>).gateway !== undefined,
	};
};

// Returns the thrown message (or null) for a given Phase-2 stub invocation.
(window as any).__callStub = (which: string): string | null => {
	const h: any = getHostApi("sess-1", "tu-1");
	try {
		switch (which) {
			case "callRoute": h.callRoute("x"); break;
			case "session.readTranscript": h.session.readTranscript(); break;
			case "session.readToolCall": h.session.readToolCall("tu"); break;
			case "session.postMessage": h.session.postMessage({ role: "user", text: "x" }); break;
			case "session.subscribe": h.session.subscribe("status", () => {}); break;
			case "ui.openPanel": h.ui.openPanel({ panelId: "p" }); break;
			case "ui.navigate": h.ui.navigate({ route: "r" }); break;
			case "store.get": h.store.get("k"); break;
			case "store.put": h.store.put("k", 1); break;
			case "store.list": h.store.list(); break;
			case "store.delete": h.store.delete("k"); break;
			case "store.deletePrefix": h.store.deletePrefix("pre"); break;
			case "store.stats": h.store.stats("pre"); break;
			default: return "unknown-stub";
		}
		return null; // did not throw → failure
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
};

(window as any).__storeMethods = () => {
	const h: any = getHostApi("sess-1", "tu-1");
	return ["get", "put", "list", "delete", "deletePrefix", "stats"].map((name) => `${name}:${typeof h.store[name]}`);
};

(window as any).__callRouteHttpError = async () => {
	const originalFetch = window.fetch;
	registerSurfaceTokenMinter("sess-1", async () => "surface-token");
	window.fetch = async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/api/ext/surface-token")) {
			return new Response("unexpected pack-bound REST mint", { status: 500 });
		}
		if (url.includes("/api/ext/route/publish")) {
			return new Response(JSON.stringify({
				code: "STORE_QUOTA_EXCEEDED",
				error: "Review payload is too large to save.",
				details: { errors: [{ path: "reviews/job/final/payload", message: "maxTotalBytes exceeded" }] },
			}), { status: 500, headers: { "content-type": "application/json" } });
		}
		return new Response("not found", { status: 404 });
	};
	try {
		const h: any = getHostApi("sess-1", undefined, { kind: "pack", packId: "pr-walkthrough", contributionKind: "panel", contributionId: "pr-walkthrough.panel" } as any);
		await h.callRoute("publish", { method: "POST", body: {} });
		return null;
	} catch (e: any) {
		return { message: e?.message, status: e?.status, code: e?.code, routeError: e?.routeError, details: e?.details };
	} finally {
		window.fetch = originalFetch;
		unregisterSurfaceTokenMinter("sess-1");
	}
};

(window as any).__packSurfaceTokenMintUsesTrustedBridge = async () => {
	const originalFetch = window.fetch;
	let fetchMinted = false;
	let bridgeMinted = false;
	registerSurfaceTokenMinter("sess-bridge", async (surface) => {
		bridgeMinted = surface.packId === "terminal" && surface.contributionKind === "panel" && surface.contributionId === "terminal";
		return "surface-token";
	});
	window.fetch = async (input: RequestInfo | URL) => {
		if (String(input).includes("/api/ext/surface-token")) fetchMinted = true;
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
	};
	try {
		const h: any = getHostApi("sess-bridge", undefined, { kind: "pack", packId: "terminal", contributionKind: "panel", contributionId: "terminal" } as any);
		await h.store.stats();
		return { bridgeMinted, fetchMinted };
	} finally {
		window.fetch = originalFetch;
		unregisterSurfaceTokenMinter("sess-bridge");
	}
};

(window as any).__channelOpenWithoutGesture = async () => {
	const originalFetch = window.fetch;
	const OriginalWebSocket = window.WebSocket;
	const sent: any[] = [];
	class MockWebSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		readonly url: string;
		readyState = MockWebSocket.CONNECTING;
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: MessageEvent) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		onclose: ((event: CloseEvent) => void) | null = null;

		constructor(url: string) {
			this.url = url;
			setTimeout(() => {
				this.readyState = MockWebSocket.OPEN;
				this.onopen?.(new Event("open"));
			}, 0);
		}

		send(data: string): void {
			const msg = JSON.parse(data);
			sent.push(msg);
			if (msg.type === "auth") {
				this.emit({ type: "auth_ok" });
			} else if (msg.type === "ext_channel_open_grant") {
				this.emit({ type: "ext_channel_open_grant_result", requestId: msg.requestId, ok: true, openGrant: "grant-1" });
			} else if (msg.type === "ext_channel_open") {
				this.emit({
					type: "ext_channel_result",
					requestId: msg.requestId,
					ok: true,
					channel: {
						id: "chan-1",
						name: msg.name,
						packId: "terminal",
						sessionId: "sess-channel-no-gesture",
						state: "open",
						createdAt: 1,
						lastActiveAt: 2,
						attached: true,
					},
				});
			}
		}

		close(): void {
			this.readyState = MockWebSocket.CLOSED;
			this.onclose?.(new CloseEvent("close"));
		}

		private emit(message: unknown): void {
			setTimeout(() => this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent), 0);
		}
	}

	registerSurfaceTokenMinter("sess-channel-no-gesture", async () => "surface-token");
	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.includes("/api/ext/surface-token")) {
			return new Response("unexpected pack-bound REST mint", { status: 500 });
		}
		return originalFetch(input, init);
	};
	(window as any).WebSocket = MockWebSocket;
	try {
		const h: any = getHostApi("sess-channel-no-gesture", undefined, { kind: "pack", packId: "terminal", contributionKind: "panel", contributionId: "terminal" } as any);
		const channel = await h.channels.open("terminal", { singletonKey: "main" });
		return { id: channel.id, sentTypes: sent.map((msg) => msg.type), grant: sent.find((msg) => msg.type === "ext_channel_open")?.openGrant };
	} finally {
		window.fetch = originalFetch;
		window.WebSocket = OriginalWebSocket;
		unregisterSurfaceTokenMinter("sess-channel-no-gesture");
	}
};

(window as any).__channelOpenRemintsStaleSurfaceToken = async () => {
	const OriginalWebSocket = window.WebSocket;
	const tokens: string[] = [];
	let mintCount = 0;
	class MockWebSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		readyState = MockWebSocket.CONNECTING;
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: MessageEvent) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		onclose: ((event: CloseEvent) => void) | null = null;

		constructor(_url: string) {
			setTimeout(() => {
				this.readyState = MockWebSocket.OPEN;
				this.onopen?.(new Event("open"));
			}, 0);
		}

		send(data: string): void {
			const msg = JSON.parse(data);
			if (msg.type === "auth") {
				this.emit({ type: "auth_ok" });
			} else if (msg.type === "ext_channel_open_grant") {
				tokens.push(msg.surfaceToken);
				if (tokens.length === 1) this.emit({ type: "ext_channel_open_grant_result", requestId: msg.requestId, ok: false, error: "missing or invalid surface token" });
				else this.emit({ type: "ext_channel_open_grant_result", requestId: msg.requestId, ok: true, openGrant: "grant-retry" });
			} else if (msg.type === "ext_channel_open") {
				this.emit({
					type: "ext_channel_result",
					requestId: msg.requestId,
					ok: true,
					channel: {
						id: "chan-retry",
						name: msg.name,
						packId: "terminal",
						sessionId: "sess-channel-stale-token",
						state: "open",
						createdAt: 1,
						lastActiveAt: 2,
						attached: true,
					},
				});
			}
		}

		close(): void {
			this.readyState = MockWebSocket.CLOSED;
			this.onclose?.(new CloseEvent("close"));
		}

		private emit(message: unknown): void {
			setTimeout(() => this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent), 0);
		}
	}

	registerSurfaceTokenMinter("sess-channel-stale-token", async () => {
		mintCount += 1;
		return mintCount === 1 ? "stale-surface-token" : "fresh-surface-token";
	});
	(window as any).WebSocket = MockWebSocket;
	try {
		const h: any = getHostApi("sess-channel-stale-token", undefined, { kind: "pack", packId: "terminal", contributionKind: "panel", contributionId: "terminal" } as any);
		const channel = await h.channels.open("terminal", { singletonKey: "main" });
		return { id: channel.id, mintCount, tokens };
	} finally {
		window.WebSocket = OriginalWebSocket;
		unregisterSurfaceTokenMinter("sess-channel-stale-token");
	}
};

(window as any).__ready = true;
