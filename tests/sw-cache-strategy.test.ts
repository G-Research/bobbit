/**
 * Unit tests for `public/sw.js` fetch-handler cache strategy.
 *
 * Asserts (per design doc §H):
 *   1. `/assets/*` is cache-first (cached response served without
 *      network round-trip; misses populate the cache).
 *   2. `index.html` (and other non-asset URLs) is network-first
 *      (network always tried first; cache populated as a side effect).
 *   3. `/api/*` and `/ws*` are NOT intercepted at all.
 *   4. Pre-cache marker `/*__BOBBIT_PRECACHE_CHUNKS__*\/` is preserved
 *      in unstamped sources so the file remains valid JS.
 *
 * The SW runs in a Worker global (`self`, `caches`, `fetch`,
 * `addEventListener`). We synthesise a minimal stub of that env,
 * load the SW into a Node `vm` context with `self` bound to that
 * stub, then drive the captured `fetch` handler with mock request
 * objects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";

const SW_SOURCE = readFileSync(
	path.join(process.cwd(), "public", "sw.js"),
	"utf-8",
);

interface MockResponse {
	ok: boolean;
	type: "basic" | "cors" | "opaque" | "error";
	url: string;
	clone(): MockResponse;
}

function makeResponse(url: string, opts: Partial<MockResponse> = {}): MockResponse {
	const r: MockResponse = {
		ok: opts.ok ?? true,
		type: opts.type ?? "basic",
		url,
		clone() { return makeResponse(url, opts); },
	};
	return r;
}

interface MockRequest {
	url: string;
	method: string;
	mode: string;
}

function req(url: string, method = "GET", mode = "no-cors"): MockRequest {
	return { url, method, mode };
}

interface SwHarness {
	fetchHandler: (event: any) => void;
	mockCache: Map<string, MockResponse>;
	fetchCalls: string[];
	cacheMatches: string[];
	respondWithPromise: Promise<any> | null;
	fetchImpl: (r: MockRequest) => Promise<MockResponse>;
}

function loadSw(opts: { fetchImpl?: (r: MockRequest) => Promise<MockResponse> } = {}): SwHarness {
	const harness: SwHarness = {
		fetchHandler: () => {},
		mockCache: new Map(),
		fetchCalls: [],
		cacheMatches: [],
		respondWithPromise: null,
		fetchImpl: opts.fetchImpl ?? (async (r) => makeResponse(r.url)),
	};

	const listeners: Record<string, any[]> = {};
	const swSelf: any = {
		addEventListener(name: string, fn: any) {
			(listeners[name] ||= []).push(fn);
		},
		skipWaiting() {},
		clients: { claim() { return Promise.resolve(); } },
	};

	const mockCacheObj = {
		match(req: MockRequest) {
			harness.cacheMatches.push(req.url);
			const r = harness.mockCache.get(req.url);
			return Promise.resolve(r);
		},
		put(req: MockRequest, response: MockResponse) {
			harness.mockCache.set(req.url, response);
			return Promise.resolve();
		},
		addAll() { return Promise.resolve(); },
		keys() { return Promise.resolve([]); },
		delete() { return Promise.resolve(true); },
	};

	const cachesObj = {
		match(r: MockRequest) { return mockCacheObj.match(r); },
		open() { return Promise.resolve(mockCacheObj); },
		keys() { return Promise.resolve([] as string[]); },
		delete() { return Promise.resolve(true); },
	};

	const sandbox: any = {
		self: swSelf,
		caches: cachesObj,
		fetch: (r: MockRequest) => {
			harness.fetchCalls.push(r.url);
			return harness.fetchImpl(r);
		},
		URL,
		Promise,
		Error,
		console,
	};
	sandbox.globalThis = sandbox;

	vm.createContext(sandbox);
	vm.runInContext(SW_SOURCE, sandbox);

	const fetchHandlers = listeners["fetch"] ?? [];
	assert.equal(fetchHandlers.length, 1, "expected exactly one fetch listener");
	harness.fetchHandler = fetchHandlers[0];
	return harness;
}

function fireFetch(h: SwHarness, request: MockRequest): Promise<any> | undefined {
	let respondedWith: Promise<any> | undefined;
	const event = {
		request,
		respondWith(p: Promise<any>) { respondedWith = p; },
		waitUntil() {},
	};
	h.fetchHandler(event);
	return respondedWith;
}

test("SW: /assets/* is cache-first — cached response wins, no network", async () => {
	const h = loadSw();
	const url = "https://app.bobbit/assets/index-abc123.js";
	const cached = makeResponse(url);
	h.mockCache.set(url, cached);

	const promise = fireFetch(h, req(url));
	assert.ok(promise, "expected respondWith to be called");
	const resp = await promise;
	assert.equal(resp, cached, "cached response should be returned");
	assert.deepEqual(h.fetchCalls, [], "network must NOT be hit on cache hit");
	assert.deepEqual(h.cacheMatches, [url]);
});

test("SW: /assets/* cache miss — network fetched and cached", async () => {
	const h = loadSw();
	const url = "https://app.bobbit/assets/main-xyz789.css";

	const promise = fireFetch(h, req(url));
	const resp = await promise;
	assert.equal(resp.url, url);
	assert.deepEqual(h.fetchCalls, [url], "network fetched on cache miss");
	// Wait a tick for the async cache.put() side effect.
	await new Promise((r) => setTimeout(r, 10));
	assert.ok(h.mockCache.has(url), "response should have been cached after miss");
});

test("SW: /index.html is network-first — network tried before cache", async () => {
	const h = loadSw();
	const url = "https://app.bobbit/index.html";
	// Pre-populate cache with stale value to prove network wins.
	const stale = makeResponse(url);
	h.mockCache.set(url, stale);

	const promise = fireFetch(h, req(url));
	const resp = await promise;
	// Network call MUST happen even though cache had a hit.
	assert.deepEqual(h.fetchCalls, [url], "network must be tried first for HTML");
	assert.equal(resp.url, url);
});

test("SW: navigation `/` is network-first", async () => {
	const h = loadSw();
	const url = "https://app.bobbit/";
	const promise = fireFetch(h, req(url, "GET", "navigate"));
	const resp = await promise;
	assert.deepEqual(h.fetchCalls, [url]);
	assert.equal(resp.url, url);
});

test("SW: /api/* is NOT intercepted", () => {
	const h = loadSw();
	const url = "https://app.bobbit/api/sessions";
	const promise = fireFetch(h, req(url));
	assert.equal(promise, undefined, "respondWith should not be called for /api/*");
	assert.deepEqual(h.fetchCalls, []);
});

test("SW: /ws is NOT intercepted", () => {
	const h = loadSw();
	const url = "https://app.bobbit/ws";
	const promise = fireFetch(h, req(url));
	assert.equal(promise, undefined);
});

test("SW: non-GET requests are NOT intercepted", () => {
	const h = loadSw();
	const url = "https://app.bobbit/assets/main-abc.js";
	const promise = fireFetch(h, req(url, "POST"));
	assert.equal(promise, undefined);
});

test("SW: /assets/* cache-first survives network failure when cached", async () => {
	const h = loadSw({
		fetchImpl: async () => { throw new Error("offline"); },
	});
	const url = "https://app.bobbit/assets/chunk-def456.js";
	const cached = makeResponse(url);
	h.mockCache.set(url, cached);
	const resp = await fireFetch(h, req(url))!;
	assert.equal(resp, cached);
	assert.deepEqual(h.fetchCalls, [], "network not even tried on cache hit");
});

test("SW: HTML network failure falls back to cache", async () => {
	const h = loadSw({
		fetchImpl: async () => { throw new Error("offline"); },
	});
	const url = "https://app.bobbit/index.html";
	const cached = makeResponse(url);
	h.mockCache.set(url, cached);
	const resp = await fireFetch(h, req(url))!;
	assert.equal(resp, cached, "HTML cache fallback when network fails");
});

test("SW source: precache marker is preserved as no-op comment in unstamped source", () => {
	// The marker must remain a syntactically-valid no-op comment in the
	// raw `public/sw.js` so unit tests (this file) and dev-mode loads
	// can parse it. Build-time stamping replaces it with concrete URLs.
	assert.match(SW_SOURCE, /\/\*__BOBBIT_PRECACHE_CHUNKS__\*\//, "precache marker must be present in unstamped source");
	assert.match(SW_SOURCE, /__BOBBIT_BUILD_ID__/, "build-id placeholder must be present");
});

test("SW source: cache-first asset rule is documented in source comments", () => {
	// Regression guard: if someone reverts to network-first-for-everything
	// (the pre-§H behaviour), this assertion catches it. The comment
	// header explicitly mentions cache-first for /assets/*.
	assert.match(SW_SOURCE, /Cache-first for `\/assets\/\*`/i);
});
