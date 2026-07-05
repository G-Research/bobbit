// Migrated from tests/client-host-api.spec.ts (v2-dom tier).
// Exercises the REAL Phase-1 CLIENT Host API getHostApi (src/app/host-api.ts)
// under happy-dom (was an esbuild file:// bundle). Pure logic — fetch /
// WebSocket / localStorage are stubbed per-helper and restored in finally
// (no geometry). The window.* harness helpers from the legacy entry are ported
// verbatim to local functions.
import { afterEach, describe, expect, it } from "vitest";
// Initialise session-manager FIRST so it is the entry point of the
// session-manager ⇄ pack-panels import cycle: pack-panels then fully
// initialises (its module-level `let sessionSwitcher`) before host-api's
// transitive graph pulls pack-panels in. Otherwise pack-panels loads first via
// host-api's graph and session-manager's top-level setSessionSwitcher() hits a
// TDZ. (esbuild's bundler hoisting hid this; the vitest ESM loader does not.)
import "../../src/app/session-manager.js";
import { getHostApi } from "../../src/app/host-api.js";
import { registerSurfaceTokenMinter, unregisterSurfaceTokenMinter } from "../../src/app/surface-token-bridge.js";

afterEach(() => { document.body.innerHTML = ""; });

function caps() {
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
}

function callStub(which: string): string | null {
	const h: any = getHostApi("sess-1", "tu-1");
	const thunks: Record<string, () => unknown> = {
		"callRoute": () => h.callRoute("x"),
		"session.readTranscript": () => h.session.readTranscript(),
		"session.readToolCall": () => h.session.readToolCall("tu"),
		"session.postMessage": () => h.session.postMessage({ role: "user", text: "x" }),
		"session.subscribe": () => h.session.subscribe("status", () => {}),
		"ui.openPanel": () => h.ui.openPanel({ panelId: "p" }),
		"ui.navigate": () => h.ui.navigate({ route: "r" }),
		"store.get": () => h.store.get("k"),
		"store.put": () => h.store.put("k", 1),
		"store.list": () => h.store.list(),
		"store.delete": () => h.store.delete("k"),
		"store.deletePrefix": () => h.store.deletePrefix("pre"),
		"store.stats": () => h.store.stats("pre"),
	};
	const run = thunks[which];
	if (!run) return "unknown-stub";
	try {
		const r = run() as any;
		// These members are implemented (not Phase-2 stubs) — several reject
		// asynchronously with a capability-specific error. Swallow the async
		// rejection so it isn't surfaced as an unhandled rejection; the test only
		// pins that NO member throws the frozen "reserved for Phase 2" message.
		if (r && typeof r.then === "function") r.then(() => {}, () => {});
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

function storeMethods() {
	const h: any = getHostApi("sess-1", "tu-1");
	return ["get", "put", "list", "delete", "deletePrefix", "stats"].map((name) => `${name}:${typeof h.store[name]}`);
}

async function callRouteHttpError() {
	const originalFetch = window.fetch;
	registerSurfaceTokenMinter("sess-1", async () => "surface-token");
	window.fetch = (async (input: any) => {
		const url = String(input);
		if (url.includes("/api/ext/surface-token")) return new Response("unexpected pack-bound REST mint", { status: 500 });
		if (url.includes("/api/ext/route/publish")) {
			return new Response(JSON.stringify({
				code: "STORE_QUOTA_EXCEEDED",
				error: "Review payload is too large to save.",
				details: { errors: [{ path: "reviews/job/final/payload", message: "maxTotalBytes exceeded" }] },
			}), { status: 500, headers: { "content-type": "application/json" } });
		}
		return new Response("not found", { status: 404 });
	}) as any;
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
}

// Shared mock WebSocket used by the surface-token / channel flows.
function makeMockWebSocket(handlers: (msg: any, emit: (m: unknown) => void, sent: any[]) => void, sent: any[]) {
	return class MockWebSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		readyState = 0;
		onopen: ((e: Event) => void) | null = null;
		onmessage: ((e: MessageEvent) => void) | null = null;
		onerror: ((e: Event) => void) | null = null;
		onclose: ((e: CloseEvent) => void) | null = null;
		constructor(readonly url: string) {
			setTimeout(() => { this.readyState = 1; this.onopen?.(new Event("open")); }, 0);
		}
		send(data: string): void {
			const msg = JSON.parse(data);
			sent.push(msg);
			handlers(msg, (m) => this.emit(m), sent);
		}
		close(): void { this.readyState = 3; this.onclose?.(new CloseEvent("close")); }
		private emit(message: unknown): void { setTimeout(() => this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent), 0); }
	};
}

async function packSurfaceTokenMintFallsBackToBackgroundWebSocket() {
	const originalFetch = window.fetch;
	const OriginalWebSocket = window.WebSocket;
	const sent: any[] = [];
	let storeToken: string | undefined;
	const MockWebSocket = makeMockWebSocket((msg, emit) => {
		if (msg.type === "auth") emit({ type: "auth_ok", surfaceTokenKey: "authority-key" });
		if (msg.type === "ext_surface_token") emit({ type: "ext_surface_token_result", requestId: msg.requestId, ok: true, token: "background-token" });
	}, sent);
	localStorage.setItem("gateway.url", "https://gateway.test");
	localStorage.setItem("gateway.token", "gateway-token");
	window.fetch = (async (input: any, init?: any) => {
		const url = String(input);
		if (url.includes("/api/ext/surface-token")) return new Response("unexpected pack-bound REST mint", { status: 500 });
		if (url.includes("/api/ext/store/stats")) {
			const body = JSON.parse(String(init?.body ?? "{}"));
			storeToken = body.surfaceToken;
			return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
		}
		return new Response("not found", { status: 404 });
	}) as any;
	(window as any).WebSocket = MockWebSocket;
	try {
		const h: any = getHostApi("sess-background", undefined, { kind: "pack", packId: "terminal", contributionKind: "panel", contributionId: "terminal" } as any);
		await h.store.stats();
		return { storeToken, sentTypes: sent.map((m) => m.type), mint: sent.find((m) => m.type === "ext_surface_token") };
	} finally {
		window.fetch = originalFetch;
		(window as any).WebSocket = OriginalWebSocket;
		localStorage.removeItem("gateway.url");
		localStorage.removeItem("gateway.token");
	}
}

async function staleRegisteredSurfaceTokenMinterFallsBackToBackgroundWebSocket() {
	const originalFetch = window.fetch;
	const OriginalWebSocket = window.WebSocket;
	const sent: any[] = [];
	let storeToken: string | undefined;
	const MockWebSocket = makeMockWebSocket((msg, emit) => {
		if (msg.type === "auth") emit({ type: "auth_ok", surfaceTokenKey: "authority-key" });
		if (msg.type === "ext_surface_token") emit({ type: "ext_surface_token_result", requestId: msg.requestId, ok: true, token: "background-token" });
	}, sent);
	registerSurfaceTokenMinter("sess-stale-minter", async () => { throw new Error("pack surface-token mint: WebSocket not connected"); });
	localStorage.setItem("gateway.url", "https://gateway.test");
	localStorage.setItem("gateway.token", "gateway-token");
	window.fetch = (async (input: any, init?: any) => {
		const url = String(input);
		if (url.includes("/api/ext/store/stats")) {
			const body = JSON.parse(String(init?.body ?? "{}"));
			storeToken = body.surfaceToken;
			return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
		}
		return new Response("not found", { status: 404 });
	}) as any;
	(window as any).WebSocket = MockWebSocket;
	try {
		const h: any = getHostApi("sess-stale-minter", undefined, { kind: "pack", packId: "terminal", contributionKind: "panel", contributionId: "terminal" } as any);
		await h.store.stats();
		return { storeToken, sentTypes: sent.map((m) => m.type) };
	} finally {
		window.fetch = originalFetch;
		(window as any).WebSocket = OriginalWebSocket;
		unregisterSurfaceTokenMinter("sess-stale-minter");
		localStorage.removeItem("gateway.url");
		localStorage.removeItem("gateway.token");
	}
}

async function packSurfaceTokenMintUsesTrustedBridge() {
	const originalFetch = window.fetch;
	let fetchMinted = false;
	let bridgeMinted = false;
	registerSurfaceTokenMinter("sess-bridge", async (surface: any) => {
		bridgeMinted = surface.packId === "terminal" && surface.contributionKind === "panel" && surface.contributionId === "terminal";
		return "surface-token";
	});
	window.fetch = (async (input: any) => {
		if (String(input).includes("/api/ext/surface-token")) fetchMinted = true;
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
	}) as any;
	try {
		const h: any = getHostApi("sess-bridge", undefined, { kind: "pack", packId: "terminal", contributionKind: "panel", contributionId: "terminal" } as any);
		await h.store.stats();
		return { bridgeMinted, fetchMinted };
	} finally {
		window.fetch = originalFetch;
		unregisterSurfaceTokenMinter("sess-bridge");
	}
}

async function channelOpenWithoutGesture() {
	const originalFetch = window.fetch;
	const OriginalWebSocket = window.WebSocket;
	const sent: any[] = [];
	const MockWebSocket = makeMockWebSocket((msg, emit) => {
		if (msg.type === "auth") emit({ type: "auth_ok" });
		else if (msg.type === "ext_channel_open_grant") emit({ type: "ext_channel_open_grant_result", requestId: msg.requestId, ok: true, openGrant: "grant-1" });
		else if (msg.type === "ext_channel_open") emit({
			type: "ext_channel_result", requestId: msg.requestId, ok: true,
			channel: { id: "chan-1", name: msg.name, packId: "terminal", sessionId: "sess-channel-no-gesture", state: "open", createdAt: 1, lastActiveAt: 2, attached: true },
		});
	}, sent);
	registerSurfaceTokenMinter("sess-channel-no-gesture", async () => "surface-token");
	window.fetch = (async (input: any, init?: any) => {
		const url = String(input);
		if (url.includes("/api/ext/surface-token")) return new Response("unexpected pack-bound REST mint", { status: 500 });
		return originalFetch(input, init);
	}) as any;
	(window as any).WebSocket = MockWebSocket;
	try {
		const h: any = getHostApi("sess-channel-no-gesture", undefined, { kind: "pack", packId: "terminal", contributionKind: "panel", contributionId: "terminal" } as any);
		const channel = await h.channels.open("terminal", { singletonKey: "main" });
		return { id: channel.id, sentTypes: sent.map((m) => m.type), grant: sent.find((m) => m.type === "ext_channel_open")?.openGrant };
	} finally {
		window.fetch = originalFetch;
		(window as any).WebSocket = OriginalWebSocket;
		unregisterSurfaceTokenMinter("sess-channel-no-gesture");
	}
}

async function channelOpenRemintsStaleSurfaceToken() {
	const OriginalWebSocket = window.WebSocket;
	const tokens: string[] = [];
	let mintCount = 0;
	const sent: any[] = [];
	const MockWebSocket = makeMockWebSocket((msg, emit) => {
		if (msg.type === "auth") emit({ type: "auth_ok" });
		else if (msg.type === "ext_channel_open_grant") {
			tokens.push(msg.surfaceToken);
			if (tokens.length === 1) emit({ type: "ext_channel_open_grant_result", requestId: msg.requestId, ok: false, error: "missing or invalid surface token" });
			else emit({ type: "ext_channel_open_grant_result", requestId: msg.requestId, ok: true, openGrant: "grant-retry" });
		} else if (msg.type === "ext_channel_open") emit({
			type: "ext_channel_result", requestId: msg.requestId, ok: true,
			channel: { id: "chan-retry", name: msg.name, packId: "terminal", sessionId: "sess-channel-stale-token", state: "open", createdAt: 1, lastActiveAt: 2, attached: true },
		});
	}, sent);
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
		(window as any).WebSocket = OriginalWebSocket;
		unregisterSurfaceTokenMinter("sess-channel-stale-token");
	}
}

describe("getHostApi — durable v1 capabilities (extension-host §3)", () => {
	it("capabilities reports Phase-1 caps true, Phase-2 caps false; no gateway member", () => {
		const c = caps();
		expect(c.version).toBe(1);
		expect(c.contractVersion).toBe(4);
		expect(c.invokeAction).toBe(true);
		expect(c.requestRender).toBe(true);
		expect(c.hasInvokeAction).toBe(true);
		expect(c.callRoute).toBe(true);
		expect(c.session).toBe(true);
		expect(c.ui).toBe(true);
		expect(c.store).toBe(true);
		expect(c.hasCallRoute).toBe(true);
		expect(c.hasUnknown).toBe(false);
		expect(c.hasGatewayMember).toBe(false);
	});

	it("host.store exposes scoped persistence methods", () => {
		expect(storeMethods()).toEqual(["get:function", "put:function", "list:function", "delete:function", "deletePrefix:function", "stats:function"]);
	});

	it("host.callRoute includes structured JSON error bodies on non-2xx responses", async () => {
		const err = await callRouteHttpError();
		expect(err).toMatchObject({ status: 500, code: "STORE_QUOTA_EXCEEDED", routeError: "Review payload is too large to save." });
		expect(err!.message).toContain("callRoute publish HTTP 500");
		expect(err!.message).toContain("STORE_QUOTA_EXCEEDED");
		expect(err!.message).toContain("Review payload is too large to save.");
		expect(err!.message).toContain("reviews/job/final/payload: maxTotalBytes exceeded");
	});

	it("pack-bound surface tokens use the trusted app bridge instead of REST", async () => {
		await expect(packSurfaceTokenMintUsesTrustedBridge()).resolves.toEqual({ bridgeMinted: true, fetchMinted: false });
	});

	it("pack-bound surface tokens fall back to a background trusted WebSocket for inactive sessions", async () => {
		const result = await packSurfaceTokenMintFallsBackToBackgroundWebSocket();
		expect(result.storeToken).toBe("background-token");
		expect(result.sentTypes).toEqual(["auth", "ext_surface_token"]);
		expect(result.mint).toMatchObject({
			type: "ext_surface_token",
			surfaceTokenKey: "authority-key",
			packId: "terminal",
			contributionKind: "panel",
			contributionId: "terminal",
		});
	});

	it("stale registered surface-token minters fall back to a background trusted WebSocket", async () => {
		const result = await staleRegisteredSurfaceTokenMinterFallsBackToBackgroundWebSocket();
		expect(result).toEqual({ storeToken: "background-token", sentTypes: ["auth", "ext_surface_token"] });
	});

	it("host.channels.open does not require user activation", async () => {
		const result = await channelOpenWithoutGesture();
		expect(result).toEqual({ id: "chan-1", sentTypes: ["auth", "ext_channel_open_grant", "ext_channel_open"], grant: "grant-1" });
	});

	it("host.channels.open remints a stale pack surface token once", async () => {
		const result = await channelOpenRemintsStaleSurfaceToken();
		expect(result).toEqual({ id: "chan-retry", mintCount: 2, tokens: ["stale-surface-token", "fresh-surface-token"] });
	});

	it("no Phase-2 member is a frozen 'reserved for Phase 2' stub anymore", () => {
		const formerStubs = ["callRoute", "ui.navigate", "session.postMessage", "session.subscribe"];
		for (const which of formerStubs) {
			const msg = callStub(which);
			expect(msg ?? "", `${which} must not be a Phase-2 stub`).not.toContain("reserved for Phase 2");
		}
	});
});
