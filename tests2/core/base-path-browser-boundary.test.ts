import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";

import { gatewayRoute, type GatewayRoute } from "../../src/shared/base-path.ts";

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
	commitGatewayConnection(baseUrl: string, token: string): { persisted: boolean; warning?: string };
	gatewayFetch(route: GatewayRoute, init?: RequestInit): Promise<Response>;
	prepareRuntimeServiceWorkerMount(environment?: any): Promise<{
		deletedCaches: number;
		registered: boolean;
		reloadRequested: boolean;
		retiredRegistrations: number;
	}>;
	__resetGatewayConnectionForTests(): void;
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
	return await import("../../src/app/gateway-fetch.ts") as unknown as GatewayBoundaryModule;
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

	it("defaults to credentialed requests while preserving caller headers and credential mode", async () => {
		const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
		const storage = installBrowser({ origin: "https://host.example", basePath: "/team/bobbit", fetch: fetchSpy as unknown as typeof fetch });
		storage.setItem("gateway.url", "https://host.example/team/bobbit");
		storage.setItem("gateway.token", "real-token");
		const boundary = await loadBoundary();

		await boundary.gatewayFetch(gatewayRoute("/api/one"), { headers: { Accept: "application/json" }, mode: "cors" });
		let init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
		assert.equal(init.credentials, "include");
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
		assert.equal(init.credentials, "include");
		assert.equal(new Headers(init.headers).has("Authorization"), false);
	});

	it("keeps a same-host bearer only in memory and reloads through the bound cookie", async () => {
		const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
		const storage = installBrowser({ origin: "https://host.example", basePath: "/bobbit", fetch: fetchSpy as unknown as typeof fetch });
		const boundary = await loadBoundary();

		assert.deepEqual(boundary.commitGatewayConnection("https://host.example/bobbit", "admin-secret"), { persisted: true });
		assert.deepEqual(boundary.activeGatewayConnection(), { baseUrl: "https://host.example/bobbit", token: "admin-secret" });
		assert.equal(storage.getItem("gateway.url"), "https://host.example/bobbit");
		assert.equal(storage.getItem("gateway.token"), "localhost", "origin-wide storage must not retain the bearer");

		await boundary.gatewayFetch(gatewayRoute("/api/current-tab"));
		let init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
		assert.equal(new Headers(init.headers).get("Authorization"), "Bearer admin-secret", "the authenticated tab retains its in-memory credential");

		boundary.__resetGatewayConnectionForTests();
		assert.deepEqual(boundary.activeGatewayConnection(), { baseUrl: "https://host.example/bobbit", token: "localhost" });
		await boundary.gatewayFetch(gatewayRoute("/api/reloaded-tab"));
		init = fetchSpy.mock.calls[1]?.[1] as RequestInit;
		assert.equal(init.credentials, "include");
		assert.equal(new Headers(init.headers).has("Authorization"), false, "reload relies on the bound HttpOnly cookie");
	});

	it("uses cookie persistence across same-host ports and a terminal DNS dot", async () => {
		const storage = installBrowser({ origin: "https://host.example.:5173", basePath: "/ui" });
		const boundary = await loadBoundary();

		assert.deepEqual(boundary.gatewayNativeTransportSupport("https://HOST.example:3001/team/bobbit"), { supported: true });
		boundary.commitGatewayConnection("https://host.example:3001/team/bobbit", "same-host-secret");
		assert.equal(storage.getItem("gateway.token"), "localhost");
		assert.equal(storage.getItem("gateway.url"), "https://host.example:3001/team/bobbit");
	});

	it("retains a real token for an explicit different-host gateway", async () => {
		const storage = installBrowser({ origin: "https://ui.example", basePath: "/bobbit" });
		const boundary = await loadBoundary();

		assert.equal(boundary.gatewayNativeTransportSupport("https://gateway.example/team/bobbit").supported, false);
		boundary.commitGatewayConnection("https://gateway.example/team/bobbit", "remote-secret");
		assert.equal(storage.getItem("gateway.url"), "https://gateway.example/team/bobbit");
		assert.equal(storage.getItem("gateway.token"), "remote-secret");
	});
});

function serviceWorkerRegistration(scriptURL: string, scope: string) {
	return {
		scope,
		active: { scriptURL },
		unregister: vi.fn(async () => true),
	};
}

describe("service worker mount preparation", () => {
	it("retires proven stale Bobbit state and reloads once before registering", async () => {
		installBrowser({ origin: "https://host.example", basePath: "/team/bobbit" });
		const boundary = await loadBoundary();
		const staleRoot = serviceWorkerRegistration("https://host.example/sw.js", "https://host.example/");
		const current = serviceWorkerRegistration("https://host.example/team/bobbit/sw.js", "https://host.example/team/bobbit/");
		const unrelated = serviceWorkerRegistration("https://host.example/other/sw.js", "https://host.example/other/");
		const register = vi.fn(async () => ({}));
		const cacheNames = [
			"bobbit:%2F:old-root",
			"bobbit-old-legacy-root",
			"bobbit:%2Fteam%2Fbobbit:current",
			"other-app-cache",
		];
		const deleted: string[] = [];
		const guard = new MemoryStorage();
		const reload = vi.fn();

		const result = await boundary.prepareRuntimeServiceWorkerMount({
			origin: "https://host.example",
			serviceWorker: {
				controller: { scriptURL: "https://host.example/sw.js" },
				getRegistrations: async () => [staleRoot, current, unrelated],
				register,
			},
			cacheStorage: {
				keys: async () => cacheNames,
				delete: async (name: string) => { deleted.push(name); return true; },
			},
			sessionStorage: guard,
			reload,
		});

		assert.deepEqual(result, { deletedCaches: 2, registered: false, reloadRequested: true, retiredRegistrations: 1 });
		assert.equal(staleRoot.unregister.mock.calls.length, 1);
		assert.equal(current.unregister.mock.calls.length, 0);
		assert.equal(unrelated.unregister.mock.calls.length, 0, "a generic sibling sw.js is not Bobbit without a Bobbit cache marker");
		assert.deepEqual(deleted.sort(), ["bobbit-old-legacy-root", "bobbit:%2F:old-root"].sort());
		assert.equal(register.mock.calls.length, 0, "registration waits for the controller-releasing navigation");
		assert.equal(reload.mock.calls.length, 1);

		await boundary.prepareRuntimeServiceWorkerMount({
			origin: "https://host.example",
			serviceWorker: {
				controller: { scriptURL: "https://host.example/sw.js" },
				getRegistrations: async () => [staleRoot],
				register,
			},
			cacheStorage: { keys: async () => ["bobbit:%2F:old-root"], delete: async () => true },
			sessionStorage: guard,
			reload,
		});
		assert.equal(reload.mock.calls.length, 1, "the session guard prevents a reload loop");
	});

	it("retires an uncontrolled wrong mount, preserves unrelated state, and registers the current mount", async () => {
		installBrowser({ origin: "https://host.example", basePath: "/team/bobbit" });
		const boundary = await loadBoundary();
		const staleRoot = serviceWorkerRegistration("https://host.example/sw.js", "https://host.example/");
		const unrelated = serviceWorkerRegistration("https://host.example/other/sw.js", "https://host.example/other/");
		const register = vi.fn(async () => ({}));
		const deleted: string[] = [];

		const result = await boundary.prepareRuntimeServiceWorkerMount({
			origin: "https://host.example",
			serviceWorker: {
				controller: null,
				getRegistrations: async () => [staleRoot, unrelated],
				register,
			},
			cacheStorage: {
				keys: async () => ["bobbit:%2F:old", "bobbit:%2Fteam%2Fbobbit:current", "unrelated"],
				delete: async (name: string) => { deleted.push(name); return true; },
			},
			sessionStorage: new MemoryStorage(),
		});

		assert.deepEqual(result, { deletedCaches: 1, registered: true, reloadRequested: false, retiredRegistrations: 1 });
		assert.deepEqual(deleted, ["bobbit:%2F:old"]);
		assert.equal(unrelated.unregister.mock.calls.length, 0);
		assert.deepEqual(register.mock.calls[0], ["/team/bobbit/sw.js", { scope: "/team/bobbit/" }]);
	});
});
