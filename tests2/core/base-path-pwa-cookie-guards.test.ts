import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, it } from "vitest";

import {
	COOKIE_NAME,
	CookieStore,
	expireCookie,
	extractCookieValue,
	hasRootScopedCookie,
	issueCookie,
	issueIfMissing,
	tryAuth,
} from "../../src/server/auth/cookie.ts";
import {
	classifyBrowserCookieEligibility,
	type BrowserCookieEligibilityContext,
	type BrowserCookieRequestMetadata,
} from "../../src/server/auth/browser-cookie.ts";

function fakeRequest(cookie?: string): any {
	return { headers: cookie ? { cookie } : {} };
}

function fakeResponse() {
	const headers: Record<string, string | string[]> = {};
	return {
		headers,
		getHeader(name: string) { return headers[name]; },
		setHeader(name: string, value: string | string[]) { headers[name] = value; },
	};
}

function serializedCookie(response: ReturnType<typeof fakeResponse>): string {
	const value = response.headers["Set-Cookie"];
	assert.ok(value, "expected Set-Cookie");
	return Array.isArray(value) ? value.at(-1)! : value;
}

describe("mount-scoped signed browser cookies", () => {
	it("uses root Path in root mode and a trailing-slash mount Path otherwise", () => {
		const store = new CookieStore(Buffer.alloc(32, 0x31));
		const rootResponse = fakeResponse();
		issueCookie(rootResponse as any, store, { localhost: true, basePath: "" });
		assert.match(serializedCookie(rootResponse), /(?:^|; )Path=\/(?:;|$)/);

		const mountedResponse = fakeResponse();
		issueCookie(mountedResponse as any, store, {
			localhost: true,
			basePath: "/team/bobbit",
			origin: "http://localhost:3001",
		});
		assert.match(serializedCookie(mountedResponse), /(?:^|; )Path=\/team\/bobbit\/(?:;|$)/);
		assert.doesNotMatch(serializedCookie(mountedResponse), /; Path=\/(?:;|$)/);
	});

	it.each(["invalid-first", "valid-first"])("authenticates the valid duplicate cookie when it is %s", (order) => {
		const currentStore = new CookieStore(Buffer.alloc(32, 0x41));
		const otherStore = new CookieStore(Buffer.alloc(32, 0x42));
		const binding = { basePath: "/bobbit", origin: "http://localhost:3001" };
		const valid = currentStore.mint(binding);
		const invalidForCurrentMount = otherStore.mint(binding);
		const parts = order === "invalid-first"
			? [`${COOKIE_NAME}=${invalidForCurrentMount}`, `${COOKIE_NAME}=${valid}`]
			: [`${COOKIE_NAME}=${valid}`, `${COOKIE_NAME}=${invalidForCurrentMount}`];
		const request = fakeRequest(parts.join("; "));

		assert.equal(tryAuth(request, currentStore, binding), true);
		assert.equal(extractCookieValue(request, currentStore, binding), valid);
		const response = fakeResponse();
		assert.equal(
			issueIfMissing(request, response as any, currentStore, { localhost: true, ...binding }),
			undefined,
			"a valid duplicate must not be shadowed into needless replacement",
		);
		assert.equal(response.headers["Set-Cookie"], undefined);
	});

	it("rejects a legacy root claim at a mount and emits explicit root expiry before replacement", () => {
		const store = new CookieStore(Buffer.alloc(32, 0x49));
		const legacy = store.mint();
		const request = fakeRequest(`${COOKIE_NAME}=${legacy}`);
		assert.ok(store.verify(legacy, { basePath: "" }));
		assert.equal(store.verify(legacy, { basePath: "/bobbit" }), undefined);
		assert.equal(hasRootScopedCookie(request, store), true);

		const response = fakeResponse();
		expireCookie(response as any, { localhost: true, basePath: "" });
		issueCookie(response as any, store, {
			localhost: true,
			basePath: "/bobbit",
			origin: "http://localhost:3001",
		});
		const setCookies = response.headers["Set-Cookie"];
		assert.ok(Array.isArray(setCookies));
		assert.match(setCookies[0]!, /^bobbit_session=; .*Path=\/; Max-Age=0;/);
		assert.match(setCookies[1]!, /^bobbit_session=v1\.2\..*Path=\/bobbit\//);
	});

	it("recognizes a bound root cookie as stale mount state", () => {
		const store = new CookieStore(Buffer.alloc(32, 0x4a));
		const rootBound = store.mint({ basePath: "", origin: "https://bobbit.example" });
		const request = fakeRequest(`${COOKIE_NAME}=${rootBound}`);
		assert.equal(hasRootScopedCookie(request, store), true);
		assert.equal(store.verify(rootBound, {
			basePath: "/bobbit",
			origin: "https://bobbit.example",
		}), undefined);
	});

	it("rejects and replaces a duplicate set when none verifies in the current store", () => {
		const currentStore = new CookieStore(Buffer.alloc(32, 0x51));
		const otherStore = new CookieStore(Buffer.alloc(32, 0x52));
		const request = fakeRequest(`${COOKIE_NAME}=malformed; ${COOKIE_NAME}=${otherStore.mint()}`);
		assert.equal(tryAuth(request, currentStore), false);
		assert.equal(extractCookieValue(request, currentStore), undefined);

		const response = fakeResponse();
		const replacement = issueIfMissing(request, response as any, currentStore, {
			localhost: true,
			basePath: "/bobbit",
			origin: "http://localhost:3001",
		});
		assert.ok(replacement);
		assert.ok(currentStore.verify(replacement));
		assert.match(serializedCookie(response), /Path=\/bobbit\//);
	});
});

describe("same-host native transport cookie eligibility", () => {
	const request: BrowserCookieRequestMetadata = {
		method: "GET",
		pathname: "/api/health",
		isTls: true,
		headers: {
			host: "bobbit.example:3001",
			origin: "https://bobbit.example:5173",
			"sec-fetch-site": "same-site",
			"sec-fetch-mode": "cors",
		},
	};
	const context: BrowserCookieEligibilityContext = {
		deployment: "direct",
		configuredHost: "bobbit.example",
		authentication: { source: "admin-bearer" },
	};

	it("allows same-scheme, same-host browser bootstrap across ports", () => {
		assert.deepEqual(classifyBrowserCookieEligibility(request, context), {
			mayBootstrap: true,
			mayRenew: false,
			reason: "eligible-bootstrap",
		});
	});

	it("does not widen cookie bootstrap to another host or scheme", () => {
		const otherHost = classifyBrowserCookieEligibility({
			...request,
			headers: { ...request.headers, origin: "https://ui.example:5173" },
		}, context);
		assert.equal(otherHost.mayBootstrap, false);

		const otherScheme = classifyBrowserCookieEligibility({
			...request,
			headers: { ...request.headers, origin: "http://bobbit.example:5173" },
		}, context);
		assert.equal(otherScheme.mayBootstrap, false);
	});
});

interface FakeCacheEntry {
	request: Request;
	response: any;
}

interface WorkerHarness {
	listeners: Record<string, (event: any) => void>;
	openedCaches: string[];
	networkRequests: string[];
	cachePuts: string[];
	cacheMatches: unknown[];
	deletedCaches: string[];
	deletedEntries: string[];
	cacheKeys: string[];
	fetchLifetime: Promise<unknown>[];
	setNetworkFetch(fn: (request: any) => Promise<any>): void;
	seedCache(name: string, request: string | Request, response: any): void;
	cacheEntryUrls(name: string): string[];
	cacheEntryRequests(name: string): Request[];
}

function fakeWorkerResponse(options: {
	url?: string;
	cacheControl?: string;
	vary?: string;
	body?: string;
	type?: string;
} = {}): any {
	const headers: Record<string, string> = {};
	if (options.cacheControl) headers["Cache-Control"] = options.cacheControl;
	if (options.vary) headers.Vary = options.vary;
	return {
		ok: true,
		url: options.url ?? "",
		type: options.type ?? "basic",
		headers: new Headers(headers),
		body: options.body,
		clone() { return this; },
	};
}

function loadWorker(mount: string): WorkerHarness {
	let source = fs.readFileSync(path.resolve("public/sw.js"), "utf8");
	source = source
		.split("__BOBBIT_BUILD_ID__").join("test-build")
		.split("/*__BOBBIT_PRECACHE_CHUNKS__*/").join(
			'"/assets/lazy.js", "/assets/private.js", "/assets/authorized.js", "/assets/referrer.js"',
		);
	const origin = "https://host.example";
	const listeners: Record<string, (event: any) => void> = {};
	const openedCaches: string[] = [];
	const networkRequests: string[] = [];
	const cachePuts: string[] = [];
	const cacheMatches: unknown[] = [];
	const deletedCaches: string[] = [];
	const deletedEntries: string[] = [];
	const cacheKeys: string[] = [];
	const fetchLifetime: Promise<unknown>[] = [];
	const cacheEntries = new Map<string, Map<string, FakeCacheEntry>>();
	let networkFetch: (request: any) => Promise<any> = async () => fakeWorkerResponse();

	const absoluteUrl = (value: string | Request): string => new URL(
		typeof value === "string" ? value : value.url,
		origin,
	).href;
	const cacheFor = (name: string): Map<string, FakeCacheEntry> => {
		let entries = cacheEntries.get(name);
		if (!entries) {
			entries = new Map();
			cacheEntries.set(name, entries);
		}
		return entries;
	};
	const caches = {
		async open(name: string) {
			openedCaches.push(name);
			const entries = cacheFor(name);
			return {
				async put(request: string | Request, response: any) {
					const storedRequest = typeof request === "string"
						? new Request(absoluteUrl(request))
						: request;
					cachePuts.push(storedRequest.url);
					entries.set(storedRequest.url, { request: storedRequest, response });
				},
				async match(request: string | Request) {
					cacheMatches.push(request);
					return entries.get(absoluteUrl(request))?.response;
				},
				async keys() { return [...entries.values()].map((entry) => entry.request); },
				async delete(request: string | Request) {
					const url = absoluteUrl(request);
					deletedEntries.push(url);
					return entries.delete(url);
				},
			};
		},
		async keys() { return [...cacheKeys]; },
		async delete(name: string) {
			deletedCaches.push(name);
			cacheEntries.delete(name);
			return true;
		},
	};
	const self = {
		location: { origin, pathname: `${mount}/sw.js` || "/sw.js" },
		addEventListener(type: string, listener: (event: any) => void) { listeners[type] = listener; },
		skipWaiting() {},
		clients: { async claim() {} },
	};
	vm.runInNewContext(source, {
		self,
		caches,
		URL,
		Request,
		Response,
		Headers,
		Promise,
		Error,
		fetch: (request: any) => {
			const value = typeof request === "string" ? new URL(request, origin).href : request.url;
			networkRequests.push(value);
			return networkFetch(request);
		},
	}, { filename: "public/sw.js" });
	return {
		listeners,
		openedCaches,
		networkRequests,
		cachePuts,
		cacheMatches,
		deletedCaches,
		deletedEntries,
		cacheKeys,
		fetchLifetime,
		setNetworkFetch(fn) { networkFetch = fn; },
		seedCache(name, request, response) {
			const storedRequest = typeof request === "string" ? new Request(absoluteUrl(request)) : request;
			cacheFor(name).set(storedRequest.url, { request: storedRequest, response });
		},
		cacheEntryUrls(name) { return [...cacheFor(name).keys()]; },
		cacheEntryRequests(name) { return [...cacheFor(name).values()].map((entry) => entry.request); },
	};
}

async function dispatchExtendable(listener: (event: any) => void): Promise<void> {
	let pending: Promise<unknown> | undefined;
	listener({ waitUntil(value: Promise<unknown>) { pending = value; } });
	await pending;
}

function dispatchFetch(
	worker: WorkerHarness,
	url: string,
	options: { method?: string; mode?: string; headers?: Record<string, string>; referrer?: string } = {},
): Promise<any> | undefined {
	let response: Promise<any> | undefined;
	worker.listeners.fetch({
		request: {
			url,
			method: options.method ?? "GET",
			mode: options.mode ?? "cors",
			headers: new Headers(options.headers),
			referrer: options.referrer ?? "",
		},
		respondWith(value: Promise<any>) { response = value; },
		waitUntil(value: Promise<unknown>) { worker.fetchLifetime.push(value); },
	});
	return response;
}

async function flushFetchLifetime(worker: WorkerHarness): Promise<void> {
	await Promise.all(worker.fetchLifetime.splice(0));
}

describe("service worker mount isolation and cache confidentiality", () => {
	it("re-anchors queryless precache assets and isolates cache cleanup by mount", async () => {
		const worker = loadWorker("/team/bobbit");
		await dispatchExtendable(worker.listeners.install);
		assert.ok(worker.networkRequests.includes("https://host.example/team/bobbit/assets/lazy.js"));
		assert.ok(worker.cachePuts.includes("https://host.example/team/bobbit/assets/lazy.js"));
		assert.ok(worker.cachePuts.includes("https://host.example/team/bobbit/"), "install creates the sanitized offline shell");
		const currentCache = worker.openedCaches[0];
		assert.ok(currentCache.includes("test-build"));
		assert.match(currentCache, /bobbit/i);

		const oldCurrentMountCache = currentCache.replace("test-build", "old-build");
		worker.cacheKeys.push(currentCache, oldCurrentMountCache, "bobbit:another-mount:old-build", "unrelated-app-cache");
		await dispatchExtendable(worker.listeners.activate);
		assert.deepEqual(worker.deletedCaches, [oldCurrentMountCache]);
	});

	it("root cleanup recognizes only historical Bobbit cache names", async () => {
		const worker = loadWorker("");
		await dispatchExtendable(worker.listeners.install);
		const currentCache = worker.openedCaches[0]!;
		const oldCurrentCache = currentCache.replace("test-build", "old-build");
		worker.cacheKeys.push(
			currentCache,
			oldCurrentCache,
			"bobbit-v1",
			"bobbit-dev-1785450000000",
			"bobbit-mdeadbeef-abc123",
			"bobbit-other-app",
			"unrelated-app-cache",
		);

		await dispatchExtendable(worker.listeners.activate);

		assert.deepEqual(worker.deletedCaches.sort(), [
			oldCurrentCache,
			"bobbit-v1",
			"bobbit-dev-1785450000000",
			"bobbit-mdeadbeef-abc123",
		].sort());
	});

	it("bypasses mounted API/WS/preview and every off-mount or sibling request", () => {
		const worker = loadWorker("/team/bobbit");
		for (const pathname of [
			"/team/bobbit/api",
			"/team/bobbit/api/health",
			"/team/bobbit/ws",
			"/team/bobbit/ws/viewer",
			"/team/bobbit/preview/session/index.html",
			"/api/health",
			"/team/bobbit-other/app.js",
			"/other/app.js",
		]) {
			assert.equal(dispatchFetch(worker, `https://host.example${pathname}`), undefined, pathname);
		}
		assert.ok(dispatchFetch(worker, "https://host.example/team/bobbit/preview-other/app.js"), "preview must match as a complete segment");
		assert.equal(dispatchFetch(worker, "https://other.example/team/bobbit/assets/app.js"), undefined);
	});

	it("never stores tokenized launches/manifests/assets or Authorization requests", async () => {
		const worker = loadWorker("/team/bobbit");
		worker.setNetworkFetch(async (request) => {
			const url = typeof request === "string" ? request : request.url;
			return fakeWorkerResponse({
				url,
				cacheControl: url.includes("manifest.json") ? "no-store" : undefined,
				body: url.includes("manifest.json") ? '{"start_url":"/?token=top-secret"}' : undefined,
			});
		});
		const requests = [
			dispatchFetch(worker, "https://host.example/team/bobbit/?token=top-secret", { mode: "navigate" }),
			dispatchFetch(worker, "https://host.example/team/bobbit/manifest.json?token=top-secret"),
			dispatchFetch(worker, "https://host.example/team/bobbit/assets/lazy.js?token=top-secret"),
			dispatchFetch(worker, "https://host.example/team/bobbit/assets/authorized.js", {
				headers: { Authorization: "Bearer top-secret" },
			}),
			dispatchFetch(worker, "https://host.example/team/bobbit/assets/lazy.js", {
				referrer: "https://host.example/team/bobbit/?token=top-secret",
			}),
		];
		await Promise.all(requests.map(async (request) => {
			assert.ok(request);
			await request;
		}));
		await flushFetchLifetime(worker);
		assert.deepEqual(worker.cachePuts, []);
	});

	it("does not store immutable assets when the response is private, no-store, or credential-varying", async () => {
		const policies = [
			{ cacheControl: "private, max-age=3600" },
			{ cacheControl: "public, no-store" },
			{ cacheControl: "NO-STORE" },
			{ vary: "Accept-Encoding, Authorization" },
			{ vary: "Cookie" },
		];
		for (const policy of policies) {
			const worker = loadWorker("/team/bobbit");
			worker.setNetworkFetch(async (request) => fakeWorkerResponse({
				url: request.url,
				...policy,
			}));
			const response = dispatchFetch(worker, "https://host.example/team/bobbit/assets/lazy.js");
			assert.ok(response);
			await response;
			await flushFetchLifetime(worker);
			assert.deepEqual(worker.cachePuts, [], JSON.stringify(policy));
		}
	});

	it("stores allowlisted assets under sanitized URL-only keys", async () => {
		const worker = loadWorker("/team/bobbit");
		const mounted = dispatchFetch(worker, "https://host.example/team/bobbit/assets/lazy.js", {
			referrer: "https://host.example/team/bobbit/dashboard",
		});
		assert.ok(mounted);
		await mounted;
		await flushFetchLifetime(worker);
		assert.deepEqual(worker.cachePuts, ["https://host.example/team/bobbit/assets/lazy.js"]);
		const cacheName = worker.openedCaches[0]!;
		const key = worker.cacheEntryRequests(cacheName)[0]!;
		assert.equal(key.referrer, "");
		assert.equal(key.credentials, "omit");
		assert.equal(key.headers.get("Authorization"), null);

		const unlisted = dispatchFetch(worker, "https://host.example/team/bobbit/assets/unlisted.js");
		assert.ok(unlisted);
		await unlisted;
		await flushFetchLifetime(worker);
		assert.equal(worker.cachePuts.length, 1, "arbitrary /assets paths are not an immutable allowlist");
	});

	it("purges unsafe entries from the retained Bobbit cache without touching sibling caches", async () => {
		const worker = loadWorker("/team/bobbit");
		await dispatchExtendable(worker.listeners.install);
		const currentCache = worker.openedCaches[0];
		const unrelatedCache = "unrelated-app-cache";
		const safeAsset = "https://host.example/team/bobbit/assets/lazy.js";
		const sensitiveUrls = [
			"https://host.example/team/bobbit/?token=secret",
			"https://host.example/team/bobbit/manifest.json",
			"https://host.example/team/bobbit/session/private-state",
			"https://host.example/team/bobbit/assets/lazy.js?token=secret",
			"https://host.example/team/bobbit/assets/private.js",
		];
		worker.seedCache(currentCache, sensitiveUrls[0]!, fakeWorkerResponse({ body: "secret launch" }));
		worker.seedCache(currentCache, sensitiveUrls[1]!, fakeWorkerResponse({ body: '{"start_url":"/?token=secret"}' }));
		worker.seedCache(currentCache, sensitiveUrls[2]!, fakeWorkerResponse({ body: "private SPA state" }));
		worker.seedCache(currentCache, sensitiveUrls[3]!, fakeWorkerResponse());
		worker.seedCache(currentCache, sensitiveUrls[4]!, fakeWorkerResponse({ cacheControl: "private" }));
		worker.seedCache(
			currentCache,
			new Request("https://host.example/team/bobbit/assets/authorized.js", {
				headers: { Authorization: "Bearer secret" },
			}),
			fakeWorkerResponse(),
		);
		worker.seedCache(
			currentCache,
			new Request("https://host.example/team/bobbit/assets/referrer.js", {
				referrer: "https://host.example/team/bobbit/?token=referrer-secret",
			}),
			fakeWorkerResponse(),
		);
		worker.seedCache(currentCache, safeAsset, fakeWorkerResponse());
		worker.seedCache(unrelatedCache, "https://host.example/other/?token=sibling-secret", fakeWorkerResponse());
		worker.cacheKeys.push(currentCache, unrelatedCache);

		await dispatchExtendable(worker.listeners.activate);

		const retained = worker.cacheEntryUrls(currentCache);
		for (const url of sensitiveUrls) assert.ok(!retained.includes(url), url);
		assert.ok(!retained.includes("https://host.example/team/bobbit/assets/authorized.js"));
		assert.ok(!retained.includes("https://host.example/team/bobbit/assets/referrer.js"));
		assert.ok(retained.includes(safeAsset));
		assert.ok(retained.includes("https://host.example/team/bobbit/"), "marked sanitized shell remains available");
		assert.deepEqual(worker.cacheEntryUrls(unrelatedCache), ["https://host.example/other/?token=sibling-secret"]);
		assert.deepEqual(worker.deletedCaches, []);
	});

	it("uses a script-free token-free mounted shell for offline navigation", async () => {
		const worker = loadWorker("/team/bobbit");
		await dispatchExtendable(worker.listeners.install);
		worker.setNetworkFetch(async () => { throw new Error("offline"); });
		const response = dispatchFetch(worker, "https://host.example/team/bobbit/session/abc", { mode: "navigate" });
		assert.ok(response);
		const shell = await response;
		assert.equal(shell.headers.get("X-Bobbit-Offline-Shell"), "1");
		const html = await shell.text();
		assert.match(html, /Bobbit is offline/);
		assert.doesNotMatch(html, /<script|token=/i);
		assert.ok(worker.cacheMatches.includes("/team/bobbit/"));
	});

	it("retains root-mounted transport bypass, precache, and offline fallback", async () => {
		const worker = loadWorker("");
		await dispatchExtendable(worker.listeners.install);
		assert.ok(worker.cachePuts.includes("https://host.example/assets/lazy.js"));
		for (const pathname of [
			"/api/health",
			"/ws/viewer",
			"/preview/session/index.html",
			"/bobbit/api/health",
			"/team/bobbit/ws/session",
			"/bobbit/preview/session/_artifact/id/index.html",
		]) {
			assert.equal(dispatchFetch(worker, `https://host.example${pathname}`), undefined, pathname);
		}
		assert.ok(dispatchFetch(worker, "https://host.example/preview-other/app.js"), "preview-other is not an authenticated preview route");
		assert.ok(dispatchFetch(worker, "https://host.example/bobbit/preview-other/app.js"), "nested preview-other remains network-first");
		assert.ok(dispatchFetch(worker, "https://host.example/team/bobbit/assets/app.js"), "nested UI assets remain network-first without entering root cache storage");
		worker.setNetworkFetch(async () => { throw new Error("offline"); });
		const response = dispatchFetch(worker, "https://host.example/session/abc", { mode: "navigate" });
		assert.ok(response);
		const shell = await response;
		assert.match(await shell.text(), /Bobbit is offline/);
		assert.ok(worker.cacheMatches.includes("/"));
	});
});

function sourceFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(absolute));
		else if (entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)) files.push(absolute);
	}
	return files;
}

function sourcePatternViolations(
	files: string[],
	pattern: RegExp,
	allow: (relative: string, match: RegExpMatchArray) => boolean = () => false,
): string[] {
	assert.equal(pattern.global, true, "source guard patterns must be global");
	const root = path.resolve("src");
	const violations: string[] = [];
	for (const file of files) {
		const relative = path.relative(root, file).split(path.sep).join("/");
		const source = fs.readFileSync(file, "utf8");
		for (const match of source.matchAll(pattern)) {
			if (allow(relative, match)) continue;
			const offset = match.index ?? 0;
			const line = source.slice(0, offset).split(/\r?\n/).length;
			const excerpt = match[0].replace(/\s+/g, " ").trim().slice(0, 180);
			violations.push(`${relative}:${line}: ${excerpt}`);
		}
	}
	return violations;
}

describe("client gateway sink regression guard", () => {
	const files = [...sourceFiles(path.resolve("src/app")), ...sourceFiles(path.resolve("src/ui"))];

	it("retires stale service-worker mount state before gateway connection hydration", () => {
		const source = fs.readFileSync(path.resolve("src/app/main.ts"), "utf8");
		const initStart = source.indexOf("async function initApp()");
		const initEnd = source.indexOf("\ninitApp();", initStart);
		assert.ok(initStart >= 0 && initEnd > initStart, "initApp source must be discoverable");
		const init = source.slice(initStart, initEnd);
		const cleanup = init.indexOf("await prepareRuntimeServiceWorkerMount()");
		const hydrate = init.indexOf("activeGatewayConnection()");
		const firstFetch = init.indexOf("await fetch(");
		assert.ok(cleanup >= 0, "initApp must await stale mount retirement");
		assert.ok(cleanup < hydrate, "service-worker cleanup must precede credential hydration");
		assert.ok(cleanup < firstFetch, "service-worker cleanup must precede the first gateway request");
		assert.equal((source.match(/serviceWorker\.register/g) ?? []).length, 0, "main must not race a separate late worker registration");
	});

	it("centralizes direct browser bearer construction", () => {
		const directBearer = /(?:["']?Authorization["']?|headers\s*\[\s*["']Authorization["']\s*\])\s*(?::|=)[\s\S]{0,120}?(?:`Bearer\s+\$\{|["']Bearer\s+["']\s*\+)/g;
		const violations = sourcePatternViolations(
			files,
			directBearer,
			(relative) => relative === "app/gateway-fetch.ts", // Sole documented owner: gatewayAuthorizationHeaders.
		);
		assert.deepEqual(violations, [], `Direct client Bearer construction must use gatewayAuthorizationHeaders:\n${violations.join("\n")}`);
	});

	it("does not pass legacy credentials into the centralized git-status widget", () => {
		const source = fs.readFileSync(path.resolve("src/app/goal-dashboard.ts"), "utf8");
		const widgetStart = source.indexOf("<git-status-widget");
		const widgetEnd = source.indexOf("></git-status-widget>", widgetStart);
		assert.ok(widgetStart >= 0 && widgetEnd > widgetStart, "dashboard git-status widget template must be discoverable");
		assert.doesNotMatch(source.slice(widgetStart, widgetEnd), /\.token\s*=/, "GitStatusWidget owns centralized requests and must not receive a credential property");
	});

	it("has no bare-origin stored gateway fallback outside the boundary", () => {
		const bareFallback = /(?:getItem\(\s*(?:GW_URL_KEY|["']gateway\.url["'])\s*\)|gateway\.url)\s*(?:\|\||\?\?)\s*(?:window\.)?location\.origin|setItem\(\s*GW_URL_KEY\s*,\s*window\.location\.origin\s*\)/g;
		const violations = sourcePatternViolations(
			files,
			bareFallback,
			(relative) => relative === "app/gateway-fetch.ts", // Sole documented fallback owner validates and retains runtimeBasePath.
		);
		assert.deepEqual(violations, [], `Bare-origin gateway fallback/persistence drops the runtime mount:\n${violations.join("\n")}`);
	});

	it("has no raw root-relative gateway route at a native browser sink", () => {
		const rawSink = /(?:\bfetch|new\s+EventSource|new\s+WebSocket|window\.open)\s*\(\s*[`"']\/(?:api|preview|ws)(?:[\/?`"']|\$\{)/g;
		const violations = sourcePatternViolations(files, rawSink);
		assert.deepEqual(violations, [], `Raw gateway routes must cross gatewayFetch/gatewayUrl/gatewayWsUrl:\n${violations.join("\n")}`);
	});

	it("does not bind a preview result URL directly to a DOM/network sink", () => {
		const previewOwners = files.filter(file => /(?:render\.ts|side-panel-workspace\.ts|PreviewRenderer\.ts)$/.test(file));
		const rawPreviewSink = /(?:\bsrc|\bhref)\s*=\s*(?:\$\{\s*)?(?:(?!gatewayUrl)[\s\S]){0,120}?\b(?:result|source|preview)\.url\b/g;
		const violations = sourcePatternViolations(previewOwners, rawPreviewSink);
		assert.deepEqual(violations, [], `PreviewResult.url is a GatewayRoute and must cross gatewayUrl at its final sink:\n${violations.join("\n")}`);
	});

	it("has no post-boot root service-worker or app-icon sink", () => {
		const rawAppAsset = /(?:serviceWorker\.register|\.src\s*=|\.href\s*=|window\.open)\s*\(?\s*[`"']\/(?:sw\.js|manifest\.json|favicon[^/]*|icon[^/]*)/g;
		const violations = sourcePatternViolations(files, rawAppAsset);
		assert.deepEqual(violations, [], `Runtime app assets must cross appUrl:\n${violations.join("\n")}`);
	});
});
