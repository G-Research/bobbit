import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, it } from "vitest";

import { __resetGatewayConnectionForTests } from "../../src/app/gateway-fetch.ts";
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
import { gatewayRoute, type GatewayRoute } from "../../src/shared/base-path.ts";

// This isolate:false suite selects explicit gateway generations in its
// cross-tab cases. Release that module-owned state before any later file reuses
// the browser boundary.
afterEach(__resetGatewayConnectionForTests);

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
		viteDevProxy: false,
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

const ROOT_GATEWAY_ROUTE = /^\/(?:api|preview|ws)(?:\/|\?|$)/;
const URL_SINK_PROPERTY = /^(?:src|href|action|poster|icon(?:Url|Src)?|iframe(?:Url|Src)|popoutUrl|sidePanelPopoutUrl)$/i;

type FunctionRegion =
	| ts.FunctionDeclaration
	| ts.FunctionExpression
	| ts.ArrowFunction
	| ts.MethodDeclaration
	| ts.ConstructorDeclaration
	| ts.GetAccessorDeclaration
	| ts.SetAccessorDeclaration;

function isFunctionRegion(node: ts.Node): node is FunctionRegion {
	return ts.isFunctionDeclaration(node)
		|| ts.isFunctionExpression(node)
		|| ts.isArrowFunction(node)
		|| ts.isMethodDeclaration(node)
		|| ts.isConstructorDeclaration(node)
		|| ts.isGetAccessorDeclaration(node)
		|| ts.isSetAccessorDeclaration(node);
}

function propertyName(node: ts.PropertyName | ts.MemberName | undefined): string | undefined {
	if (!node) return undefined;
	if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
	if (ts.isNumericLiteral(node)) return node.text;
	return undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current)
		|| ts.isAsExpression(current)
		|| ts.isTypeAssertionExpression(current)
		|| ts.isNonNullExpression(current)
		|| ts.isSatisfiesExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function directRootGatewayRoute(expression: ts.Expression): boolean {
	const current = unwrapExpression(expression);
	if (ts.isStringLiteralLike(current)) return ROOT_GATEWAY_ROUTE.test(current.text);
	return ts.isTemplateExpression(current) && ROOT_GATEWAY_ROUTE.test(current.head.text);
}

function sameOriginExpression(expression: ts.Expression, sourceFile: ts.SourceFile): boolean {
	const current = unwrapExpression(expression).getText(sourceFile).replace(/\s+/g, "");
	return /^(?:(?:window|globalThis|self)\.)?location\.origin$/.test(current);
}

function memberKey(expression: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
	const current = unwrapExpression(expression);
	if (ts.isPropertyAccessExpression(current)) return current.getText(sourceFile).replace(/\s+/g, "");
	if (ts.isElementAccessExpression(current) && current.argumentExpression) {
		const argument = unwrapExpression(current.argumentExpression);
		if (ts.isStringLiteralLike(argument)) {
			return `${current.expression.getText(sourceFile).replace(/\s+/g, "")}.${argument.text}`;
		}
	}
	return undefined;
}

function rawBrowserGatewayUrlViolations(relative: string, source: string): string[] {
	const sourceFile = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const regions: Array<{ root: ts.Node; owner?: FunctionRegion }> = [{ root: sourceFile }];
	const recorded = new Map<string, string>();

	const record = (node: ts.Node, reason: string) => {
		const start = node.getStart(sourceFile);
		const key = `${start}:${reason}`;
		if (recorded.has(key)) return;
		const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
		const excerpt = node.getText(sourceFile).replace(/\s+/g, " ").trim().slice(0, 180);
		recorded.set(key, `${relative}:${line}: ${reason}: ${excerpt}`);
	};

	const collectRegions = (node: ts.Node) => {
		if (isFunctionRegion(node) && node.body) regions.push({ root: node.body, owner: node });
		ts.forEachChild(node, collectRegions);
	};
	collectRegions(sourceFile);

	const walkRegion = (root: ts.Node, visit: (node: ts.Node) => void) => {
		const walk = (node: ts.Node) => {
			if (node !== root && isFunctionRegion(node)) return;
			visit(node);
			ts.forEachChild(node, walk);
		};
		walk(root);
	};

	for (const region of regions) {
		const taintedNames = new Set<string>();
		const taintedMembers = new Set<string>();
		const assignments: Array<{ name?: string; member?: string; value: ts.Expression }> = [];

		const addAssignment = (target: ts.Expression | ts.BindingName, value: ts.Expression) => {
			if (ts.isIdentifier(target)) assignments.push({ name: target.text, value });
			else if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
				const member = memberKey(target, sourceFile);
				if (member) assignments.push({ member, value });
			}
		};

		walkRegion(region.root, (node) => {
			if (ts.isVariableDeclaration(node) && node.initializer) {
				addAssignment(node.name, node.initializer);
				const initializer = unwrapExpression(node.initializer);
				if (ts.isIdentifier(node.name) && ts.isObjectLiteralExpression(initializer)) {
					for (const property of initializer.properties) {
						if (!ts.isPropertyAssignment(property)) continue;
						const name = propertyName(property.name);
						if (name) assignments.push({ member: `${node.name.text}.${name}`, value: property.initializer });
					}
				}
			} else if (ts.isPropertyDeclaration(node) && node.initializer) {
				const name = propertyName(node.name);
				if (name) assignments.push({ member: `this.${name}`, value: node.initializer });
			} else if (
				ts.isBinaryExpression(node)
				&& node.operatorToken.kind === ts.SyntaxKind.EqualsToken
			) {
				addAssignment(node.left, node.right);
			}
		});

		const isTainted = (expression: ts.Expression): boolean => {
			const current = unwrapExpression(expression);
			if (directRootGatewayRoute(current)) return true;
			if (ts.isIdentifier(current)) return taintedNames.has(current.text);
			const key = memberKey(current, sourceFile);
			if (key && taintedMembers.has(key)) return true;
			if (ts.isConditionalExpression(current)) {
				return isTainted(current.whenTrue) || isTainted(current.whenFalse);
			}
			if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
				const left = unwrapExpression(current.left);
				return isTainted(current.left)
					|| (sameOriginExpression(current.left, sourceFile) && directRootGatewayRoute(current.right))
					|| (ts.isStringLiteralLike(left) && left.text === "" && isTainted(current.right));
			}
			if (ts.isTemplateExpression(current)) {
				if (current.head.text !== "" || current.templateSpans.length === 0) return false;
				const firstSpan = current.templateSpans[0]!;
				return isTainted(firstSpan.expression)
					|| (sameOriginExpression(firstSpan.expression, sourceFile) && ROOT_GATEWAY_ROUTE.test(firstSpan.literal.text));
			}
			if (ts.isNewExpression(current)) {
				const callee = unwrapExpression(current.expression);
				return ts.isIdentifier(callee)
					&& callee.text === "URL"
					&& current.arguments?.length === 2
					&& directRootGatewayRoute(current.arguments[0]!)
					&& sameOriginExpression(current.arguments[1]!, sourceFile);
			}
			if (ts.isCallExpression(current)) {
				const callee = unwrapExpression(current.expression);
				const name = ts.isIdentifier(callee)
					? callee.text
					: ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
				if (name === "gatewayUrl" || name === "gatewayWsUrl" || name === "appUrl" || name === "gatewayFetch") return false;
				if (name === "gatewayRoute" || name === "String" || name === "encodeURI") {
					return current.arguments[0] ? isTainted(current.arguments[0]) : false;
				}
			}
			return false;
		};

		let changed = true;
		while (changed) {
			changed = false;
			for (const assignment of assignments) {
				if (!isTainted(assignment.value)) continue;
				if (assignment.name && !taintedNames.has(assignment.name)) {
					taintedNames.add(assignment.name);
					changed = true;
				}
				if (assignment.member && !taintedMembers.has(assignment.member)) {
					taintedMembers.add(assignment.member);
					changed = true;
				}
			}
		}

		walkRegion(region.root, (node) => {
			if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
				const callee = unwrapExpression(node.expression);
				const calleeName = ts.isIdentifier(callee)
					? callee.text
					: ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
				const owner = ts.isPropertyAccessExpression(callee) ? callee.expression.getText(sourceFile) : "";
				const nativeSink = (calleeName === "fetch" && (!owner || /^(?:window|globalThis|self)$/.test(owner)))
					|| ((calleeName === "EventSource" || calleeName === "WebSocket") && !owner)
					|| (calleeName === "open" && /^(?:window|globalThis)$/.test(owner))
					|| (calleeName === "sendBeacon" && owner === "navigator");
				const firstArgument = node.arguments?.[0];
				if (nativeSink && firstArgument && isTainted(firstArgument)) {
					record(node, `raw gateway route reaches ${calleeName}`);
				}
				if (calleeName === "setAttribute" && node.arguments?.length) {
					const attribute = unwrapExpression(node.arguments[0]!);
					const value = node.arguments[1];
					if (ts.isStringLiteralLike(attribute) && URL_SINK_PROPERTY.test(attribute.text) && value && isTainted(value)) {
						record(node, `raw gateway route reaches ${attribute.text} attribute`);
					}
				}
			}

			if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
				const target = unwrapExpression(node.left);
				if (ts.isPropertyAccessExpression(target) && URL_SINK_PROPERTY.test(target.name.text) && isTainted(node.right)) {
					record(node, `raw gateway route reaches ${target.name.text} property`);
				}
			}

			if (ts.isPropertyAssignment(node)) {
				const name = propertyName(node.name);
				if (name && URL_SINK_PROPERTY.test(name) && isTainted(node.initializer)) {
					record(node, `raw gateway route reaches ${name} property`);
				}
			}

			if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === "html") {
				const template = node.template;
				const staticChunks = ts.isTemplateExpression(template)
					? [template.head.text, ...template.templateSpans.map(span => span.literal.text)]
					: [template.text];
				if (staticChunks.some(chunk => /\b(?:src|href|icon)\s*=\s*["']\/(?:api|preview|ws)(?:\/|\?|["'])/i.test(chunk))) {
					record(node, "raw gateway route appears in an HTML URL attribute");
				}
				if (ts.isTemplateExpression(template)) {
					for (let index = 0; index < template.templateSpans.length; index += 1) {
						const before = index === 0 ? template.head.text : template.templateSpans[index - 1]!.literal.text;
						const span = template.templateSpans[index]!;
						if (/\b(?:src|href|icon)\s*=\s*$/i.test(before) && isTainted(span.expression)) {
							record(span.expression, "raw gateway route reaches an HTML URL attribute");
						}
					}
				}
			}
		});

		if (region.owner) {
			const ownerName = propertyName(region.owner.name)
				?? (ts.isVariableDeclaration(region.owner.parent) && ts.isIdentifier(region.owner.parent.name)
					? region.owner.parent.name.text
					: undefined);
			const publicUrlFactory = ownerName === "previewUrlForTab"
				|| (ownerName !== undefined && /(?:iframe|icon|popout).*?(?:url|src)/i.test(ownerName));
			if (publicUrlFactory) {
				if (ts.isArrowFunction(region.owner) && !ts.isBlock(region.owner.body) && isTainted(region.owner.body)) {
					record(region.owner.body, `raw gateway route returned by ${ownerName}`);
				} else {
					walkRegion(region.root, (node) => {
						if (ts.isReturnStatement(node) && node.expression && isTainted(node.expression)) {
							record(node, `raw gateway route returned by ${ownerName}`);
						}
					});
				}
			}
		}
	}

	return [...recorded.values()];
}

interface BootstrapConnection {
	baseUrl: string;
	token: string;
	warning?: string;
}

interface BootstrapConnectionSnapshot {
	connection: Readonly<BootstrapConnection>;
}

interface BootstrapRecoveryDependencies {
	gatewayUrl(route: GatewayRoute, baseUrl: string): string;
	gatewayRoute(raw: string): GatewayRoute;
	captureGatewayConnectionSnapshot(): BootstrapConnectionSnapshot;
	reconcileGatewayConnectionSnapshot(snapshot: BootstrapConnectionSnapshot): {
		unchanged: boolean;
		connection: Readonly<BootstrapConnection>;
	};
	commitGatewayConnectionIfUnchanged(
		snapshot: BootstrapConnectionSnapshot,
		baseUrl: string,
		token: string,
		options: { localhostTrusted: boolean },
	): { committed: boolean; persisted: boolean; connection: Readonly<BootstrapConnection>; warning?: string };
	recordGatewayLocalhostMode(localhostTrusted: boolean): void;
}

type BootstrapRecovery = (
	connection: Readonly<BootstrapConnection>,
	fallbackBase: string,
	fetchHealth: typeof fetch,
) => Promise<BootstrapConnection>;

/** Execute the production helper body without importing main.ts's eager UI graph. */
function loadBootstrapRecovery(dependencies: BootstrapRecoveryDependencies): BootstrapRecovery {
	const source = fs.readFileSync(path.resolve("src/app/main.ts"), "utf8");
	const start = source.indexOf("async function recoverSameOriginGatewayConnection(");
	const bodyStart = source.indexOf("{", start);
	const end = source.indexOf("\n}\n\nasync function initApp()", bodyStart);
	assert.ok(start >= 0 && bodyStart > start && end > bodyStart, "fallback recovery helper must be discoverable");
	const body = source.slice(bodyStart + 1, end);
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
		...args: string[]
	) => (...args: unknown[]) => Promise<BootstrapConnection>;
	const execute = new AsyncFunction(
		"connection",
		"fallbackBase",
		"fetchHealth",
		"gatewayUrl",
		"gatewayRoute",
		"captureGatewayConnectionSnapshot",
		"commitGatewayConnectionIfUnchanged",
		"reconcileGatewayConnectionSnapshot",
		"recordGatewayLocalhostMode",
		"LOCALHOST_TOKEN",
		body,
	);
	return (connection, fallbackBase, fetchHealth) => execute(
		connection,
		fallbackBase,
		fetchHealth,
		dependencies.gatewayUrl,
		dependencies.gatewayRoute,
		dependencies.captureGatewayConnectionSnapshot,
		dependencies.commitGatewayConnectionIfUnchanged,
		dependencies.reconcileGatewayConnectionSnapshot,
		dependencies.recordGatewayLocalhostMode,
		"localhost",
	);
}

function fakeHealthResponse(options: {
	url: string;
	status?: number;
	localhost?: boolean;
	redirected?: boolean;
}): Response {
	const status = options.status ?? 200;
	return {
		ok: status >= 200 && status < 300,
		status,
		url: options.url,
		redirected: options.redirected ?? false,
		json: async () => ({ localhost: options.localhost }),
	} as Response;
}

class BootstrapMemoryStorage implements Storage {
	private readonly values = new Map<string, string>();
	get length(): number { return this.values.size; }
	clear(): void { this.values.clear(); }
	getItem(key: string): string | null { return this.values.get(key) ?? null; }
	key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
	removeItem(key: string): void { this.values.delete(key); }
	setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(globalThis, name, descriptor);
	else Reflect.deleteProperty(globalThis, name);
}

function persistedBootstrapConnection(
	storage: Storage,
	connection: { generation: string; baseUrl: string; token: string; authenticationMode: "bearer" | "cookie" | "localhost" },
): string {
	const record = JSON.stringify({ version: 1, ...connection });
	storage.setItem("gateway.url", connection.baseUrl);
	storage.setItem("gateway.token", connection.token);
	storage.setItem("gateway.auth-mode", connection.authenticationMode);
	storage.setItem("gateway.connection-revision", record);
	return record;
}

function deferredValue<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

function installDeferredBootstrapBrowser(origin = "https://ui.example", basePath = "/bobbit") {
	const storage = new BootstrapMemoryStorage();
	const listeners = new Map<string, Array<(event: any) => void>>();
	const laterRequests: Array<{ url: string; init?: RequestInit }> = [];
	let reloadCount = 0;
	const fallbackBase = `${origin}${basePath}`;
	const location = {
		origin,
		pathname: `${basePath}/`,
		search: "",
		hash: "",
		href: `${fallbackBase}/`,
		reload: () => { reloadCount += 1; },
	};
	const windowValue = {
		location,
		localStorage: storage,
		__BOBBIT_BASE_PATH__: basePath,
		addEventListener(type: string, listener: (event: any) => void) {
			listeners.set(type, [...(listeners.get(type) ?? []), listener]);
		},
		dispatchEvent(event: any) {
			for (const listener of listeners.get(event.type) ?? []) listener(event);
			return true;
		},
	};
	Object.defineProperty(globalThis, "window", { configurable: true, value: windowValue });
	Object.defineProperty(globalThis, "location", { configurable: true, value: location });
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		value: async (input: RequestInfo | URL, init?: RequestInit) => {
			laterRequests.push({ url: String(input), init });
			return new Response("ok");
		},
	});
	return {
		fallbackBase,
		laterRequests,
		reloadCount: () => reloadCount,
		storage,
		dispatchStorage(revision: string) {
			for (const listener of listeners.get("storage") ?? []) {
				listener({
					type: "storage",
					key: "gateway.connection-revision",
					newValue: revision,
					storageArea: storage,
				});
			}
		},
	};
}

describe("client gateway bootstrap recovery", () => {
	it("persists only the cookie sentinel after protected root and nested fallback probes", async () => {
		const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
		const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
		const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		try {
			for (const testCase of [
				{ label: "missing root connection", basePath: "", malformed: false },
				{ label: "malformed nested connection", basePath: "/team/bobbit", malformed: true },
			] as const) {
				const origin = "https://host.example";
				const storage = new BootstrapMemoryStorage();
				if (testCase.malformed) {
					storage.setItem("gateway.url", "https://attacker.example/a/../bobbit");
					storage.setItem("gateway.token", "must-not-survive");
				}
				const location = {
					origin,
					pathname: `${testCase.basePath}/` || "/",
					search: "",
					hash: "",
					href: `${origin}${testCase.basePath}/`,
				};
				const windowValue = {
					location,
					localStorage: storage,
					__BOBBIT_BASE_PATH__: testCase.basePath,
					addEventListener() {},
					dispatchEvent() { return true; },
				};
				Object.defineProperty(globalThis, "window", { configurable: true, value: windowValue });
				Object.defineProperty(globalThis, "location", { configurable: true, value: location });
				Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

				const boundary = await import("../../src/app/gateway-fetch.ts");
				boundary.__resetGatewayConnectionForTests();
				const fallbackBase = `${origin}${testCase.basePath}`;
				const initial = boundary.activeGatewayConnection();
				assert.deepEqual(initial, { baseUrl: fallbackBase, token: "" }, testCase.label);
				const requests: Array<{ url: string; init?: RequestInit }> = [];
				const recover = loadBootstrapRecovery({
					gatewayUrl: boundary.gatewayUrl,
					gatewayRoute,
					captureGatewayConnectionSnapshot: boundary.captureGatewayConnectionSnapshot,
					commitGatewayConnectionIfUnchanged: boundary.commitGatewayConnectionIfUnchanged,
					reconcileGatewayConnectionSnapshot: boundary.reconcileGatewayConnectionSnapshot,
					recordGatewayLocalhostMode: boundary.recordGatewayLocalhostMode,
				});
				const recovered = await recover(initial, fallbackBase, async (input, init) => {
					requests.push({ url: String(input), init });
					return fakeHealthResponse({ url: `${fallbackBase}/api/health`, localhost: false });
				});

				assert.deepEqual(recovered, { baseUrl: fallbackBase, token: "localhost", warning: undefined });
				assert.equal(requests.length, 1);
				assert.equal(requests[0]?.url, `${fallbackBase}/api/health`);
				assert.equal(requests[0]?.init?.credentials, "include");
				assert.equal(requests[0]?.init?.redirect, "error");
				assert.equal(storage.getItem("gateway.url"), fallbackBase);
				assert.equal(storage.getItem("gateway.token"), "localhost");
				assert.equal(storage.getItem("gateway.auth-mode"), "cookie");
				assert.doesNotMatch(storage.getItem("gateway.connection-revision") ?? "", /must-not-survive/);
			}
		} finally {
			restoreGlobal("window", originalWindow);
			restoreGlobal("location", originalLocation);
			restoreGlobal("localStorage", originalStorage);
		}
	});

	it("lets an emitted cross-tab bearer generation win a deferred successful fallback probe", async () => {
		const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
		const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
		const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
		try {
			const browser = installDeferredBootstrapBrowser();
			const { fallbackBase, laterRequests, storage } = browser;
			const newer = { baseUrl: "https://gateway.example/team/gw", token: "newer-bearer" };
			const boundary = await import("../../src/app/gateway-fetch.ts");
			boundary.__resetGatewayConnectionForTests();
			const initial = boundary.activeGatewayConnection();
			const recover = loadBootstrapRecovery({
				gatewayUrl: boundary.gatewayUrl,
				gatewayRoute,
				captureGatewayConnectionSnapshot: boundary.captureGatewayConnectionSnapshot,
				commitGatewayConnectionIfUnchanged: boundary.commitGatewayConnectionIfUnchanged,
				reconcileGatewayConnectionSnapshot: boundary.reconcileGatewayConnectionSnapshot,
				recordGatewayLocalhostMode: boundary.recordGatewayLocalhostMode,
			});
			const health = deferredValue<Response>();
			const probeStarted = deferredValue<void>();
			const recovery = recover(initial, fallbackBase, async () => {
				probeStarted.resolve(undefined);
				return health.promise;
			});
			await probeStarted.promise;

			const revision = persistedBootstrapConnection(storage, {
				generation: "tab-b-bearer",
				...newer,
				authenticationMode: "bearer",
			});
			browser.dispatchStorage(revision);
			health.resolve(fakeHealthResponse({ url: `${fallbackBase}/api/health`, localhost: false }));

			assert.deepEqual(await recovery, newer);
			assert.deepEqual(boundary.activeGatewayConnection(), newer);
			assert.equal(storage.getItem("gateway.connection-revision"), revision, "late fallback success must not replace tab B's generation");
			assert.equal(browser.reloadCount(), 1);
			assert.equal(boundary.gatewayWsUrl(gatewayRoute("/ws/viewer")), "wss://gateway.example/team/gw/ws/viewer");
			await boundary.gatewayFetch(gatewayRoute("/api/later-read"));
			await assert.rejects(
				boundary.gatewayFetch(gatewayRoute("/api/later-mutation"), { method: "POST", body: "{}" }),
				/Gateway changed in another tab/,
			);
			assert.deepEqual(laterRequests.map(request => request.url), ["https://gateway.example/team/gw/api/later-read"]);
			assert.equal(new Headers(laterRequests[0]?.init?.headers).get("Authorization"), "Bearer newer-bearer");
		} finally {
			restoreGlobal("window", originalWindow);
			restoreGlobal("location", originalLocation);
			restoreGlobal("localStorage", originalStorage);
			restoreGlobal("fetch", originalFetch);
		}
	});

	it("adopts a newer cookie generation before its delayed StorageEvent and routes every later transport to it", async () => {
		const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
		const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
		const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
		try {
			const browser = installDeferredBootstrapBrowser();
			const { fallbackBase, laterRequests, storage } = browser;
			const newer = { baseUrl: "https://ui.example:3443/team/gw", token: "localhost" };
			const boundary = await import("../../src/app/gateway-fetch.ts");
			boundary.__resetGatewayConnectionForTests();
			const initial = boundary.activeGatewayConnection();
			const recover = loadBootstrapRecovery({
				gatewayUrl: boundary.gatewayUrl,
				gatewayRoute,
				captureGatewayConnectionSnapshot: boundary.captureGatewayConnectionSnapshot,
				commitGatewayConnectionIfUnchanged: boundary.commitGatewayConnectionIfUnchanged,
				reconcileGatewayConnectionSnapshot: boundary.reconcileGatewayConnectionSnapshot,
				recordGatewayLocalhostMode: boundary.recordGatewayLocalhostMode,
			});
			const health = deferredValue<Response>();
			const probeStarted = deferredValue<void>();
			const recovery = recover(initial, fallbackBase, async () => {
				probeStarted.resolve(undefined);
				return health.promise;
			});
			await probeStarted.promise;
			const revision = persistedBootstrapConnection(storage, {
				generation: "tab-b-cookie",
				...newer,
				authenticationMode: "cookie",
			});
			health.resolve(fakeHealthResponse({ url: `${fallbackBase}/api/health`, localhost: true }));

			assert.deepEqual(await recovery, newer, "the final atomic read must reconcile tab B before its event is delivered");
			assert.equal(storage.getItem("gateway.connection-revision"), revision);
			assert.equal(browser.reloadCount(), 0);
			await boundary.gatewayFetch(gatewayRoute("/api/later-mutation"), { method: "POST", body: "{}" });
			assert.equal(boundary.gatewayWsUrl(gatewayRoute("/ws/viewer")), "wss://ui.example:3443/team/gw/ws/viewer");
			assert.deepEqual(laterRequests.map(request => request.url), ["https://ui.example:3443/team/gw/api/later-mutation"]);
			assert.equal(new Headers(laterRequests[0]?.init?.headers).has("Authorization"), false);

			// Delivery after the synchronous reconciliation is idempotent: it cannot
			// force a reload or make a later mutation fall back to the stale mount.
			browser.dispatchStorage(revision);
			await boundary.gatewayFetch(gatewayRoute("/api/after-event"), { method: "POST", body: "{}" });
			assert.equal(browser.reloadCount(), 0);
			assert.deepEqual(laterRequests.map(request => request.url), [
				"https://ui.example:3443/team/gw/api/later-mutation",
				"https://ui.example:3443/team/gw/api/after-event",
			]);
		} finally {
			restoreGlobal("window", originalWindow);
			restoreGlobal("location", originalLocation);
			restoreGlobal("localStorage", originalStorage);
			restoreGlobal("fetch", originalFetch);
		}
	});

	it("preserves disabled-auth localhost and real bearer semantics", async () => {
		const commits: Array<{ baseUrl: string; token: string; localhostTrusted: boolean }> = [];
		const modes: boolean[] = [];
		const fallbackBase = "http://localhost:3001/bobbit";
		const fallbackConnection = { baseUrl: fallbackBase, token: "" };
		const snapshot = { connection: fallbackConnection };
		const recover = loadBootstrapRecovery({
			gatewayUrl: (route, baseUrl) => `${baseUrl}${route}`,
			gatewayRoute,
			captureGatewayConnectionSnapshot: () => snapshot,
			reconcileGatewayConnectionSnapshot: () => ({ unchanged: true, connection: fallbackConnection }),
			commitGatewayConnectionIfUnchanged: (_snapshot, baseUrl, token, options) => {
				commits.push({ baseUrl, token, localhostTrusted: options.localhostTrusted });
				return { committed: true, persisted: true, connection: { baseUrl, token } };
			},
			recordGatewayLocalhostMode: (mode) => { modes.push(mode); },
		});
		const disabled = await recover({ baseUrl: fallbackBase, token: "" }, fallbackBase, async () => (
			fakeHealthResponse({ url: `${fallbackBase}/api/health`, localhost: true })
		));
		assert.deepEqual(disabled, { baseUrl: fallbackBase, token: "localhost", warning: undefined });
		assert.deepEqual(commits, [{ baseUrl: fallbackBase, token: "localhost", localhostTrusted: true }]);
		assert.deepEqual(modes, [true]);

		let bearerProbeCount = 0;
		const bearer = { baseUrl: fallbackBase, token: "real-bearer" };
		assert.deepEqual(await recover(bearer, fallbackBase, async () => {
			bearerProbeCount += 1;
			throw new Error("real bearer must not use fallback discovery");
		}), bearer);
		assert.equal(bearerProbeCount, 0);
		assert.equal(commits.length, 1);
	});

	it("fails closed for remote candidates, 401s, redirects, wrong origins, and off-mount responses", async () => {
		const commits: string[] = [];
		const fallbackBase = "https://host.example/team/bobbit";
		const empty = { baseUrl: fallbackBase, token: "" };
		const snapshot = { connection: empty };
		const recover = loadBootstrapRecovery({
			gatewayUrl: (route, baseUrl) => `${baseUrl}${route}`,
			gatewayRoute,
			captureGatewayConnectionSnapshot: () => snapshot,
			reconcileGatewayConnectionSnapshot: () => ({ unchanged: true, connection: empty }),
			commitGatewayConnectionIfUnchanged: (_snapshot, baseUrl, token) => {
				commits.push(`${baseUrl}:${token}`);
				return { committed: true, persisted: true, connection: { baseUrl, token } };
			},
			recordGatewayLocalhostMode: () => { throw new Error("rejected probes must not record auth mode"); },
		});
		let remoteProbeCount = 0;
		const remote = { baseUrl: "https://remote.example/team/bobbit", token: "" };
		assert.deepEqual(await recover(remote, fallbackBase, async () => {
			remoteProbeCount += 1;
			throw new Error("remote candidate must remain authoritative");
		}), remote);
		assert.equal(remoteProbeCount, 0);

		for (const response of [
			fakeHealthResponse({ url: `${fallbackBase}/api/health`, status: 401, localhost: false }),
			fakeHealthResponse({ url: `${fallbackBase}/api/health`, localhost: false, redirected: true }),
			fakeHealthResponse({ url: "https://attacker.example/api/health", localhost: false }),
			fakeHealthResponse({ url: "https://host.example/api/health", localhost: false }),
		]) {
			assert.deepEqual(await recover(empty, fallbackBase, async () => response), empty);
		}
		assert.deepEqual(commits, []);
	});
});

describe("client gateway sink regression guard", () => {
	const files = [...sourceFiles(path.resolve("src/app")), ...sourceFiles(path.resolve("src/ui"))];

	it("guards stale workers before auth and retries registration after cookie bootstrap", () => {
		const source = fs.readFileSync(path.resolve("src/app/main.ts"), "utf8");
		const initStart = source.indexOf("async function initApp()");
		const initEnd = source.indexOf("\ninitApp();", initStart);
		assert.ok(initStart >= 0 && initEnd > initStart, "initApp source must be discoverable");
		const init = source.slice(initStart, initEnd);
		const cleanup = init.indexOf("await prepareRuntimeServiceWorkerMount()");
		const safeDecision = init.indexOf("serviceWorkerPreparation.safeToProceed");
		const hydrate = init.indexOf("activeGatewayConnection()");
		const firstProbe = init.indexOf("await recoverSameOriginGatewayConnection(");
		const authenticated = init.indexOf("await waitForGateway(");
		const retry = init.indexOf("await prepareRuntimeServiceWorkerMount()", cleanup + 1);
		assert.ok(cleanup >= 0, "initApp must await stale mount retirement");
		assert.ok(cleanup < safeDecision && safeDecision < hydrate, "wrong-controller safety must resolve before credential hydration");
		assert.ok(cleanup < firstProbe, "service-worker cleanup must precede the first gateway request");
		assert.ok(retry > authenticated, "protected startup must retry worker registration after authenticated cookie bootstrap");
		assert.equal((source.match(/serviceWorker\.register/g) ?? []).length, 0, "main must keep registration inside the mount boundary");
	});

	it("constructs credentialed root and mounted manifest URLs only from the current launch query", () => {
		const shell = fs.readFileSync(path.resolve("index.html"), "utf8");
		const manifestMarker = shell.indexOf("// Inject the PWA manifest link");
		const scriptStart = shell.lastIndexOf("<script>", manifestMarker);
		const scriptEnd = shell.indexOf("</script>", manifestMarker);
		assert.ok(manifestMarker >= 0 && scriptStart >= 0 && scriptEnd > manifestMarker, "manifest bootstrap must be discoverable");
		const bootstrap = shell.slice(scriptStart + "<script>".length, scriptEnd);
		const credentialStart = bootstrap.indexOf("var params = new URLSearchParams(window.location.search)");
		const credentialEnd = bootstrap.indexOf("document.head.appendChild(link)", credentialStart);
		assert.ok(credentialStart >= 0 && credentialEnd > credentialStart, "manifest credential source must be discoverable");
		const credentialSource = bootstrap.slice(credentialStart, credentialEnd);
		assert.match(credentialSource, /params\.get\(['"]token['"]\)/);
		assert.doesNotMatch(credentialSource, /localStorage|gateway\.token/, "remote or malformed stored credentials must not escape before validation");

		function manifestLink(basePath: string, search: string): Record<string, string> {
			const appended: Array<Record<string, string>> = [];
			vm.runInNewContext(bootstrap, {
				window: {
					__BOBBIT_BASE_PATH__: basePath,
					location: { search },
					localStorage: { getItem: () => "stored-remote-secret" },
				},
				document: {
					createElement: () => ({}),
					head: { appendChild: (link: Record<string, string>) => appended.push(link) },
				},
				URLSearchParams,
				encodeURIComponent,
			});
			assert.equal(appended.length, 1, "manifest bootstrap must append exactly one link");
			return appended[0]!;
		}

		for (const [basePath, search, expectedHref] of [
			["", "?token=launch%20secret", "/manifest.json?token=launch%20secret"],
			["/team/bobbit", "?token=launch%20secret", "/team/bobbit/manifest.json?token=launch%20secret"],
			["", "", "/manifest.json"],
			["/team/bobbit", "?token=localhost", "/team/bobbit/manifest.json"],
		] as const) {
			const link = manifestLink(basePath, search);
			assert.equal(link.rel, "manifest");
			assert.equal(link.id, "pwa-manifest");
			assert.equal(link.crossOrigin, "use-credentials");
			assert.equal(link.href, expectedHref);
		}
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

	it("pins variable, template, property, iframe, icon, and popout flows without flagging internal routes", () => {
		const unsafe = `
			const apiPath = \`/api/goals/\${goalId}\`;
			fetch(apiPath);
			const previewRecord = { route: \`/preview/\${sessionId}/index.html\` };
			iframe.src = previewRecord.route;
			const socketPath = "/ws/viewer";
			new WebSocket(socketPath);
			const action = { iconUrl: "/api/icons/goal.svg" };
			function sidePanelPopoutUrl() { return \`/preview/\${sessionId}/inline.html\`; }
			html\`<iframe src="/preview/static/index.html"></iframe>\`;
			const absoluteApi = window.location.origin + "/api/projects";
			fetch(absoluteApi);
			const absolutePreview = \`\${globalThis.location.origin}/preview/\${sessionId}/index.html\`;
			previewIframe.src = absolutePreview;
			fetch(new URL("/api/health", self.location.origin));
			const absoluteSocket = location.origin + "/ws/viewer";
			new WebSocket(absoluteSocket);
		`;
		const unsafeViolations = rawBrowserGatewayUrlViolations("fixture-unsafe.ts", unsafe);
		assert.equal(unsafeViolations.length, 10, unsafeViolations.join("\n"));
		for (const expected of ["fetch(apiPath)", "iframe.src", "WebSocket(socketPath)", "iconUrl", "sidePanelPopoutUrl", "<iframe src=", "fetch(absoluteApi)", "absolutePreview", "new URL", "WebSocket(absoluteSocket)"]) {
			assert.ok(unsafeViolations.some(violation => violation.includes(expected)), `${expected}:\n${unsafeViolations.join("\n")}`);
		}

		const safe = `
			gatewayFetch(\`/api/goals/\${goalId}\`);
			gatewayFetch(gatewayRoute(\`/api/sessions/\${sessionId}\`));
			const internalPreviewRoute = gatewayRoute(\`/preview/\${sessionId}/index.html\`);
			const structuredResult = { url: internalPreviewRoute };
			iframe.src = gatewayUrl(structuredResult.url);
			const internalSocketRoute = "/ws/viewer";
			new WebSocket(gatewayWsUrl(gatewayRoute(internalSocketRoute)));
			const deliberateInternalRoute = \`/api/goals/\${goalId}/gates\`;
			gatewayFetch(gatewayRoute(deliberateInternalRoute));
			function sidePanelPopoutUrl() { return gatewayUrl(internalPreviewRoute); }
			html\`<iframe src=\${gatewayUrl(internalPreviewRoute)}></iframe>\`;
			const resolvedApi = gatewayUrl(gatewayRoute("/api/projects"));
			fetch(resolvedApi);
			fetch("https://gateway.example/team/bobbit/api/projects");
		`;
		assert.deepEqual(rawBrowserGatewayUrlViolations("fixture-safe.ts", safe), []);
	});

	it("has no raw root-relative gateway route flowing to a native browser sink", () => {
		const root = path.resolve("src");
		const violations = files.flatMap((file) => rawBrowserGatewayUrlViolations(
			path.relative(root, file).split(path.sep).join("/"),
			fs.readFileSync(file, "utf8"),
		));
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
