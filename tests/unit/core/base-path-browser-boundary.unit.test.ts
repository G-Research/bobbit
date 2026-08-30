import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";

import { gatewayRoute, type GatewayRoute } from "../../../src/shared/base-path.ts";

type ErrorCode =
	| "EMPTY"
	| "INVALID_SYNTAX"
	| "NOT_ABSOLUTE"
	| "UNSUPPORTED_PROTOCOL"
	| "CREDENTIALS"
	| "QUERY"
	| "FRAGMENT"
	| "INVALID_PATH";

interface GatewayBoundaryModule {
	GW_URL_KEY: string;
	GW_TOKEN_KEY: string;
	LOCALHOST_TOKEN: string;
	InvalidGatewayBaseUrlError: new (...args: any[]) => Error & { code: ErrorCode };
	normalizeGatewayBaseUrl(raw: string): string;
	runtimeBasePath(): string;
	appUrl(path: string): string;
	gatewayBaseUrl(): string;
	gatewayUrl(route: GatewayRoute, explicitBase?: string): string;
	gatewayWsUrl(route: GatewayRoute, explicitBase?: string): string;
	gatewayAuthorizationHeaders(token?: string | null): Record<string, string>;
	gatewayNativeTransportSupport(explicitBase?: string): { supported: boolean; message?: string };
	activeGatewayConnection(): Readonly<{ baseUrl: string; token: string }>;
	gatewayFetch(route: GatewayRoute, init?: RequestInit): Promise<Response>;
}

class MemoryStorage implements Storage {
	private readonly values = new Map<string, string>();
	get length(): number { return this.values.size; }
	clear(): void { this.values.clear(); }
	getItem(key: string): string | null { return this.values.get(key) ?? null; }
	key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
	removeItem(key: string): void { this.values.delete(key); }
	setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(globalThis, name, descriptor);
	else Reflect.deleteProperty(globalThis, name);
}

afterEach(() => {
	restoreGlobal("window", originalWindow);
	restoreGlobal("location", originalLocation);
	restoreGlobal("localStorage", originalLocalStorage);
	restoreGlobal("fetch", originalFetch);
	vi.restoreAllMocks();
	vi.resetModules();
});

function installBrowser(options: {
	origin?: string;
	pathname?: string;
	basePath?: string;
	storage?: Storage;
	fetch?: typeof fetch;
} = {}): Storage {
	const origin = options.origin ?? "https://ui.example";
	const defaultPathname = `${options.basePath ?? ""}/` || "/";
	const pathname = options.pathname ?? defaultPathname;
	const location = { origin, pathname, search: "", hash: "", href: `${origin}${pathname}` };
	const storage = options.storage ?? new MemoryStorage();
	const windowValue = {
		location,
		localStorage: storage,
		__BOBBIT_BASE_PATH__: options.basePath ?? "",
	};
	Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: windowValue });
	Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: location });
	Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: storage });
	if (options.fetch) Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: options.fetch });
	return storage;
}

async function loadBoundary(): Promise<GatewayBoundaryModule> {
	return await import("../../../src/app/gateway-fetch.ts") as unknown as GatewayBoundaryModule;
}

async function assertGatewayBaseError(raw: string, code: ErrorCode): Promise<void> {
	installBrowser();
	const boundary = await loadBoundary();
	assert.throws(
		() => boundary.normalizeGatewayBaseUrl(raw),
		(error: unknown) => error instanceof boundary.InvalidGatewayBaseUrlError && error.code === code,
		`${JSON.stringify(raw)} should fail with ${code}`,
	);
}

describe("explicit gateway base URL normalization", () => {
	it.each([
		["https://GW.example:443/team/bobbit/", "https://gw.example/team/bobbit"],
		["  http://127.0.0.1:3001/  ", "http://127.0.0.1:3001"],
		["https://[::1]:443/a_b.c-d~", "https://[::1]/a_b.c-d~"],
	])("canonicalizes %j", async (raw, expected) => {
		installBrowser();
		const boundary = await loadBoundary();
		assert.equal(boundary.normalizeGatewayBaseUrl(raw), expected);
	});

	it.each([
		["", "EMPTY"],
		["   ", "EMPTY"],
		["gw.example/bobbit", "NOT_ABSOLUTE"],
		["//gw.example/bobbit", "NOT_ABSOLUTE"],
		["ftp://gw.example/bobbit", "UNSUPPORTED_PROTOCOL"],
		["https://user:pass@gw.example/bobbit", "CREDENTIALS"],
		["https://gw.example/bobbit?q=1", "QUERY"],
		["https://gw.example/bobbit#fragment", "FRAGMENT"],
		["https://gw.example/a//b", "INVALID_PATH"],
		["https://gw.example/a/../b", "INVALID_PATH"],
		["https://gw.example/a%2fb", "INVALID_PATH"],
		["https://gw.example/a\\b", "INVALID_SYNTAX"],
		["https:\\gw.example\\team", "INVALID_SYNTAX"],
		["https://gw.example/a\tb", "INVALID_SYNTAX"],
		["https://gw.example/a\nb", "INVALID_SYNTAX"],
	] as const)("rejects %j with %s", async (raw, code) => {
		await assertGatewayBaseError(raw, code);
	});
});

describe("runtime app and gateway URL boundaries", () => {
	it("uses the stamped runtime mount for app paths", async () => {
		installBrowser({ origin: "https://host.example", pathname: "/team/bobbit/", basePath: "/team/bobbit" });
		const boundary = await loadBoundary();
		assert.equal(boundary.runtimeBasePath(), "/team/bobbit");
		assert.equal(boundary.appUrl("/favicon.svg"), "/team/bobbit/favicon.svg");
		assert.equal(boundary.appUrl("/#/session/abc"), "/team/bobbit/#/session/abc");
	});

	it("retains a prefixed explicit gateway for HTTP and WebSocket routes exactly once", async () => {
		installBrowser({ origin: "https://ui.example", basePath: "/bobbit" });
		const boundary = await loadBoundary();
		const route = gatewayRoute("/preview/session/index.html?version=2");
		assert.equal(boundary.gatewayUrl(route, "https://remote.example/team/gw/"), "https://remote.example/team/gw/preview/session/index.html?version=2");
		assert.equal(boundary.gatewayWsUrl(gatewayRoute("/ws/viewer"), "https://remote.example/team/gw"), "wss://remote.example/team/gw/ws/viewer");
		assert.equal(boundary.gatewayWsUrl(gatewayRoute("/ws/session"), "http://127.0.0.1:3001/team/gw"), "ws://127.0.0.1:3001/team/gw/ws/session");
	});

	it("falls back to the page origin plus runtime mount when no gateway is stored", async () => {
		installBrowser({ origin: "https://host.example", pathname: "/bobbit/", basePath: "/bobbit" });
		const boundary = await loadBoundary();
		assert.equal(boundary.gatewayBaseUrl(), "https://host.example/bobbit");
		assert.deepEqual(boundary.activeGatewayConnection(), { baseUrl: "https://host.example/bobbit", token: "" });
	});

	it("supports cookie-only native transports for exact-origin mounted gateways", async () => {
		installBrowser({ origin: "https://host.example:8443", pathname: "/bobbit/", basePath: "/bobbit" });
		const boundary = await loadBoundary();
		assert.deepEqual(boundary.gatewayNativeTransportSupport(), { supported: true });
		assert.deepEqual(
			boundary.gatewayNativeTransportSupport("https://host.example:8443/team/gateway/"),
			{ supported: true },
		);
	});

	it("rejects cross-port native transports without disabling prefixed bearer REST or WebSockets", async () => {
		const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
		const storage = installBrowser({
			origin: "https://host.example:8443",
			basePath: "/bobbit",
			fetch: fetchSpy as unknown as typeof fetch,
		});
		storage.setItem("gateway.url", "https://host.example:9443/team/gateway/");
		storage.setItem("gateway.token", "real-token");
		const boundary = await loadBoundary();

		const nativeSupport = boundary.gatewayNativeTransportSupport();
		assert.equal(nativeSupport.supported, false);
		assert.match(nativeSupport.message ?? "", /same origin \(scheme, hostname, and port\)/);
		assert.equal(boundary.gatewayUrl(gatewayRoute("/api/health")), "https://host.example:9443/team/gateway/api/health");
		assert.equal(boundary.gatewayWsUrl(gatewayRoute("/ws/viewer")), "wss://host.example:9443/team/gateway/ws/viewer");

		await boundary.gatewayFetch(gatewayRoute("/api/health"));
		assert.equal(String(fetchSpy.mock.calls[0]?.[0]), "https://host.example:9443/team/gateway/api/health");
		const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
		assert.equal(init.credentials, undefined);
		assert.equal(new Headers(init.headers).get("Authorization"), "Bearer real-token");
	});

	it("treats a valid stored gateway pathname as authoritative", async () => {
		const storage = installBrowser({ origin: "https://ui.example", basePath: "/bobbit" });
		storage.setItem("gateway.url", "https://remote.example/team/gw/");
		storage.setItem("gateway.token", "real-token");
		const boundary = await loadBoundary();
		assert.equal(boundary.gatewayBaseUrl(), "https://remote.example/team/gw");
		assert.deepEqual(boundary.activeGatewayConnection(), { baseUrl: "https://remote.example/team/gw", token: "real-token" });
		assert.equal(boundary.gatewayUrl(gatewayRoute("/api/health")), "https://remote.example/team/gw/api/health");
	});

	it("clears a malformed stored URL and its token before using mounted same-origin fallback", async () => {
		const calls: string[] = [];
		const fetchSpy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
			calls.push(String(input));
			return new Response("ok");
		});
		const storage = installBrowser({ origin: "https://host.example", basePath: "/bobbit", fetch: fetchSpy as unknown as typeof fetch });
		storage.setItem("gateway.url", "https://attacker.example/a/../bobbit");
		storage.setItem("gateway.token", "must-not-leak");

		const boundary = await loadBoundary();
		assert.equal(boundary.gatewayBaseUrl(), "https://host.example/bobbit");
		assert.equal(storage.getItem("gateway.url"), null);
		assert.equal(storage.getItem("gateway.token"), null);
		assert.deepEqual(calls, [], "storage recovery itself must not issue a request");
		await boundary.gatewayFetch(gatewayRoute("/api/health"));
		assert.deepEqual(calls, ["https://host.example/bobbit/api/health"]);
		const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
		assert.equal(new Headers(init.headers).has("Authorization"), false);
	});
});

describe("gateway authorization and fetch", () => {
	it("omits absent, empty, and localhost-sentinel bearer credentials", async () => {
		installBrowser();
		const boundary = await loadBoundary();
		assert.deepEqual(boundary.gatewayAuthorizationHeaders(), {});
		assert.deepEqual(boundary.gatewayAuthorizationHeaders(null), {});
		assert.deepEqual(boundary.gatewayAuthorizationHeaders(""), {});
		assert.deepEqual(boundary.gatewayAuthorizationHeaders("localhost"), {});
		assert.deepEqual(boundary.gatewayAuthorizationHeaders("real-token"), { Authorization: "Bearer real-token" });
	});

	it("uses Fetch's same-origin credential default while preserving caller headers and explicit credential mode", async () => {
		const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
		const storage = installBrowser({ origin: "https://host.example", basePath: "/team/bobbit", fetch: fetchSpy as unknown as typeof fetch });
		storage.setItem("gateway.url", "https://host.example/team/bobbit");
		storage.setItem("gateway.token", "real-token");
		const boundary = await loadBoundary();

		await boundary.gatewayFetch(gatewayRoute("/api/one"), { headers: { Accept: "application/json" }, mode: "cors" });
		let init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
		assert.equal(init.credentials, undefined);
		assert.equal(init.mode, "cors");
		assert.equal(new Headers(init.headers).get("Authorization"), "Bearer real-token");
		assert.equal(new Headers(init.headers).get("Accept"), "application/json");

		await boundary.gatewayFetch(gatewayRoute("/api/two"), { credentials: "omit", headers: { "X-Test": "kept" } });
		init = fetchSpy.mock.calls[1]?.[1] as RequestInit;
		assert.equal(init.credentials, "omit");
		assert.equal(new Headers(init.headers).get("X-Test"), "kept");
	});

	it("never sends the localhost sentinel as an HTTP bearer", async () => {
		const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
		const storage = installBrowser({ origin: "http://localhost:3001", fetch: fetchSpy as unknown as typeof fetch });
		storage.setItem("gateway.url", "http://localhost:3001");
		storage.setItem("gateway.token", "localhost");
		const boundary = await loadBoundary();
		await boundary.gatewayFetch(gatewayRoute("/api/health"));
		const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
		assert.equal(init.credentials, undefined);
		assert.equal(new Headers(init.headers).has("Authorization"), false);
	});
});
