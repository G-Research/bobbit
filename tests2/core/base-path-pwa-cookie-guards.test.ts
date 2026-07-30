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

interface WorkerHarness {
	listeners: Record<string, (event: any) => void>;
	openedCaches: string[];
	precacheAdds: string[][];
	cachePuts: string[];
	cacheMatches: unknown[];
	deletedCaches: string[];
	cacheKeys: string[];
	setNetworkFetch(fn: (request: any) => Promise<any>): void;
}

function loadWorker(mount: string): WorkerHarness {
	let source = fs.readFileSync(path.resolve("public/sw.js"), "utf8");
	source = source
		.split("__BOBBIT_BUILD_ID__").join("test-build")
		.split("/*__BOBBIT_PRECACHE_CHUNKS__*/").join('"/assets/lazy.js"');
	const listeners: Record<string, (event: any) => void> = {};
	const openedCaches: string[] = [];
	const precacheAdds: string[][] = [];
	const cachePuts: string[] = [];
	const cacheMatches: unknown[] = [];
	const deletedCaches: string[] = [];
	const cacheKeys: string[] = [];
	let networkFetch: (request: any) => Promise<any> = async () => ({
		ok: true,
		type: "basic",
		clone() { return this; },
	});
	const caches = {
		async open(name: string) {
			openedCaches.push(name);
			return {
				async addAll(values: string[]) { precacheAdds.push([...values]); },
				async put(request: any) { cachePuts.push(typeof request === "string" ? request : request.url); },
				async match(request: any) {
					cacheMatches.push(request);
					const value = typeof request === "string" ? request : request.url;
					if (value === `${mount}/` || (mount === "" && value === "/")) return { offline: true };
					return undefined;
				},
			};
		},
		async keys() { return [...cacheKeys]; },
		async delete(name: string) { deletedCaches.push(name); return true; },
	};
	const self = {
		location: { origin: "https://host.example", pathname: `${mount}/sw.js` || "/sw.js" },
		addEventListener(type: string, listener: (event: any) => void) { listeners[type] = listener; },
		skipWaiting() {},
		clients: { async claim() {} },
	};
	vm.runInNewContext(source, {
		self,
		caches,
		URL,
		Promise,
		Error,
		fetch: (request: any) => networkFetch(request),
	}, { filename: "public/sw.js" });
	return {
		listeners,
		openedCaches,
		precacheAdds,
		cachePuts,
		cacheMatches,
		deletedCaches,
		cacheKeys,
		setNetworkFetch(fn) { networkFetch = fn; },
	};
}

async function dispatchExtendable(listener: (event: any) => void): Promise<void> {
	let pending: Promise<unknown> | undefined;
	listener({ waitUntil(value: Promise<unknown>) { pending = value; } });
	await pending;
}

function dispatchFetch(worker: WorkerHarness, url: string, options: { method?: string; mode?: string } = {}): Promise<any> | undefined {
	let response: Promise<any> | undefined;
	worker.listeners.fetch({
		request: { url, method: options.method ?? "GET", mode: options.mode ?? "cors" },
		respondWith(value: Promise<any>) { response = value; },
	});
	return response;
}

describe("service worker mount isolation", () => {
	it("re-anchors precache entries and isolates cache cleanup by mount", async () => {
		const worker = loadWorker("/team/bobbit");
		await dispatchExtendable(worker.listeners.install);
		assert.deepEqual(worker.precacheAdds, [["/team/bobbit/assets/lazy.js"]]);
		const currentCache = worker.openedCaches[0];
		assert.ok(currentCache.includes("test-build"));
		assert.match(currentCache, /bobbit/i);

		const oldCurrentMountCache = currentCache.replace("test-build", "old-build");
		worker.cacheKeys.push(currentCache, oldCurrentMountCache, "bobbit:another-mount:old-build", "unrelated-app-cache");
		await dispatchExtendable(worker.listeners.activate);
		assert.deepEqual(worker.deletedCaches, [oldCurrentMountCache]);
	});

	it("bypasses mounted API/WS and every off-mount or sibling request", () => {
		const worker = loadWorker("/team/bobbit");
		for (const pathname of [
			"/team/bobbit/api",
			"/team/bobbit/api/health",
			"/team/bobbit/ws",
			"/team/bobbit/ws/viewer",
			"/api/health",
			"/team/bobbit-other/app.js",
			"/other/app.js",
		]) {
			assert.equal(dispatchFetch(worker, `https://host.example${pathname}`), undefined, pathname);
		}
		assert.equal(dispatchFetch(worker, "https://other.example/team/bobbit/assets/app.js"), undefined);
	});

	it("claims and caches only successful same-origin requests within its mount", async () => {
		const worker = loadWorker("/team/bobbit");
		const mounted = dispatchFetch(worker, "https://host.example/team/bobbit/assets/app.js");
		assert.ok(mounted);
		await mounted;
		await Promise.resolve();
		assert.deepEqual(worker.cachePuts, ["https://host.example/team/bobbit/assets/app.js"]);
	});

	it("uses the mounted root as the offline navigation fallback", async () => {
		const worker = loadWorker("/team/bobbit");
		worker.setNetworkFetch(async () => { throw new Error("offline"); });
		const response = dispatchFetch(worker, "https://host.example/team/bobbit/session/abc", { mode: "navigate" });
		assert.ok(response);
		assert.deepEqual(await response, { offline: true });
		assert.ok(worker.cacheMatches.includes("/team/bobbit/"));
	});

	it("retains root-mounted API bypass and offline fallback", async () => {
		const worker = loadWorker("");
		assert.equal(dispatchFetch(worker, "https://host.example/api/health"), undefined);
		worker.setNetworkFetch(async () => { throw new Error("offline"); });
		const response = dispatchFetch(worker, "https://host.example/session/abc", { mode: "navigate" });
		assert.ok(response);
		assert.deepEqual(await response, { offline: true });
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

	it("centralizes direct browser bearer construction", () => {
		const directBearer = /(?:["']?Authorization["']?|headers\s*\[\s*["']Authorization["']\s*\])\s*(?::|=)[\s\S]{0,120}?(?:`Bearer\s+\$\{|["']Bearer\s+["']\s*\+)/g;
		const violations = sourcePatternViolations(
			files,
			directBearer,
			(relative) => relative === "app/gateway-fetch.ts", // Sole documented owner: gatewayAuthorizationHeaders.
		);
		assert.deepEqual(violations, [], `Direct client Bearer construction must use gatewayAuthorizationHeaders:\n${violations.join("\n")}`);
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
