// Bobbit Service Worker — PWA installability + safe offline fallback only.
//
// Design:
//   * Network-first for navigations and immutable UI assets. Cache is consulted
//     only when the network fetch fails, so an online hard refresh always reaches
//     the gateway.
//   * Cache Storage is origin-wide, not scoped to a service-worker mount. Never
//     store authenticated/token-bearing traffic, manifests, previews, API data,
//     or arbitrary pages that a sibling app on the origin could inspect.
//   * The only stored responses are exact queryless build-stamped assets and a
//     static, token-free offline document created by this worker.
//   * `BUILD_ID` is replaced at build time by the `bobbit-sw-version` Vite plugin.
//     Names also include the runtime mount so sibling Bobbit mounts do not evict
//     one another.
const BUILD_ID = "__BOBBIT_BUILD_ID__";

// The worker is registered at `<mount>/sw.js`, so its own location is the
// deployment-independent source of truth for the active mount. Root mode is
// represented as the empty string, matching the browser runtime boundary.
const SW_PATH = self.location.pathname;
const BASE_PATH = SW_PATH.endsWith("/sw.js")
	? SW_PATH.slice(0, -"/sw.js".length)
	: "";
const CACHE_PREFIX = `bobbit:${encodeURIComponent(BASE_PATH || "/")}:`;
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const OFFLINE_NAVIGATION_URL = `${BASE_PATH}/`;
const OFFLINE_SHELL_HEADER = "X-Bobbit-Offline-Shell";
const OFFLINE_SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<title>Bobbit is offline</title>
<style>
html{color-scheme:light dark;font:16px system-ui,sans-serif}body{min-height:100vh;margin:0;display:grid;place-items:center;background:Canvas;color:CanvasText}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.35rem}p{line-height:1.5;opacity:.75}
</style>
</head>
<body><main><h1>Bobbit is offline</h1><p>Reconnect to the gateway, then reload this page.</p></main></body>
</html>`;

// The marker `/*__BOBBIT_PRECACHE_CHUNKS__*/` is replaced at build time
// by the `bobbit-sw-version` Vite plugin with comma-separated hashed paths.
// In unstamped sources it remains a valid empty array.
const PRECACHE_ROUTE_CHUNKS = [/*__BOBBIT_PRECACHE_CHUNKS__*/];
const MOUNTED_PRECACHE_ROUTE_CHUNKS = PRECACHE_ROUTE_CHUNKS.map((pathname) =>
	`${BASE_PATH}${pathname.startsWith("/") ? pathname : `/${pathname}`}`,
);

/** Return the mount-relative pathname, or null outside this worker's mount. */
function mountRelativePath(url) {
	if (url.origin !== self.location.origin) return null;
	if (!BASE_PATH) return url.pathname;
	if (url.pathname === BASE_PATH) return "/";
	if (!url.pathname.startsWith(`${BASE_PATH}/`)) return null;
	return url.pathname.slice(BASE_PATH.length);
}

function isGatewayTransport(pathname) {
	// Match authenticated transport/content names as complete path segments at
	// any depth. The nested form is defensive migration behavior: a still-
	// controlling root worker must bypass mounted API/WS/preview routes too.
	return /(?:^|\/)(?:api|ws|preview)(?:\/|$)/.test(pathname);
}

function headerValue(headers, name) {
	if (!headers || typeof headers.get !== "function") return "";
	try {
		return headers.get(name) || "";
	} catch {
		return "";
	}
}

function urlCarriesToken(rawUrl) {
	if (!rawUrl) return false;
	try {
		// URLSearchParams also recognizes an encoded parameter name such as
		// `%74oken`, avoiding a lexical-query bypass.
		return new URL(rawUrl, self.location.origin).searchParams.has("token");
	} catch {
		return true;
	}
}

function requestCarriesSecrets(request, url) {
	return urlCarriesToken(url.href)
		|| urlCarriesToken(request.referrer)
		|| headerValue(request.headers, "Authorization").trim() !== "";
}

function responseForbidsStorage(response) {
	const cacheDirectives = headerValue(response.headers, "Cache-Control")
		.toLowerCase()
		.split(",")
		.map((value) => value.trim().split("=", 1)[0].trim());
	if (cacheDirectives.includes("private") || cacheDirectives.includes("no-store")) return true;

	// A credential-varying response must not be stored under a sanitized key.
	const vary = headerValue(response.headers, "Vary")
		.toLowerCase()
		.split(",")
		.map((value) => value.trim());
	return vary.includes("*") || vary.includes("cookie") || vary.includes("authorization");
}

/** Only exact build-stamped, queryless precache assets may enter Cache Storage. */
function isImmutableUiAsset(url) {
	return url.origin === self.location.origin
		&& url.search === ""
		&& MOUNTED_PRECACHE_ROUTE_CHUNKS.includes(url.pathname);
}

function isSafeAssetRequest(request, url) {
	return isImmutableUiAsset(url) && !requestCarriesSecrets(request, url);
}

function isSafeAssetResponse(response, requestUrl) {
	if (!response.ok || responseForbidsStorage(response)) return false;
	if (response.type !== "basic" && response.type !== "cors") return false;
	const finalUrl = new URL(response.url || requestUrl.href, self.location.origin);
	return isImmutableUiAsset(finalUrl);
}

/** Strip headers, credentials, and referrer metadata from origin-readable keys. */
function safeAssetCacheKey(url) {
	return new Request(url.href, {
		method: "GET",
		credentials: "omit",
		referrer: "",
		referrerPolicy: "no-referrer",
	});
}

function makeOfflineShell() {
	return new Response(OFFLINE_SHELL_HTML, {
		status: 200,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-cache",
			[OFFLINE_SHELL_HEADER]: "1",
		},
	});
}

async function precacheAsset(cache, pathname) {
	const url = new URL(pathname, self.location.origin);
	if (!isImmutableUiAsset(url)) return;
	try {
		const response = await fetch(new Request(url.href, {
			credentials: "same-origin",
			referrer: "",
			referrerPolicy: "no-referrer",
		}));
		if (isSafeAssetResponse(response, url)) {
			await cache.put(safeAssetCacheKey(url), response.clone());
		}
	} catch {
		// Pre-warming is best-effort; normal online loading remains network-first.
	}
}

async function isSafeRetainedEntry(cache, request) {
	const url = new URL(request.url);
	if (url.href === new URL(OFFLINE_NAVIGATION_URL, self.location.origin).href && url.search === "") {
		const response = await cache.match(request);
		return headerValue(response?.headers, OFFLINE_SHELL_HEADER) === "1";
	}
	if (!isSafeAssetRequest(request, url)) return false;
	const response = await cache.match(request);
	return Boolean(response) && isSafeAssetResponse(response, url);
}

async function purgeUnsafeEntries(cache) {
	const requests = await cache.keys();
	await Promise.all(requests.map(async (request) => {
		if (!(await isSafeRetainedEntry(cache, request))) await cache.delete(request);
	}));
}

function isLegacyRootCacheName(name) {
	// Historical names were `bobbit-v1`, `bobbit-dev-<timestamp>`, or
	// `bobbit-<base36 timestamp>-<six random chars>`. Avoid a broad `bobbit-`
	// prefix that could delete an unrelated application's cache.
	return /^bobbit-(?:v\d+|dev-\d+|[a-z0-9]+-[a-z0-9]{6})$/.test(name);
}

self.addEventListener("install", (event) => {
	// Activate immediately so a new build replaces the old SW on the next
	// navigation rather than waiting for every tab to close first.
	self.skipWaiting();
	event.waitUntil((async () => {
		try {
			const cache = await caches.open(CACHE_NAME);
			// Never derive the offline document from a gateway response: the real SPA
			// shell is no-store and a launch response may be authenticated. This static
			// document is deliberately queryless, script-free, and token-free.
			await cache.put(OFFLINE_NAVIGATION_URL, makeOfflineShell());
			await Promise.all(MOUNTED_PRECACHE_ROUTE_CHUNKS.map((pathname) =>
				precacheAsset(cache, pathname),
			));
		} catch {
			// Cache creation/pre-warming is best-effort; ignore storage failures.
		}
	})());
});

self.addEventListener("activate", (event) => {
	// Delete only superseded builds for this exact mount. Root mode also cleans
	// the legacy `bobbit-<build>` namespace. Mounted workers never touch sibling
	// mounts or unrelated caches. Then scrub the retained namespace in case an
	// older worker using the same build id stored tokenized/private responses.
	event.waitUntil((async () => {
		const keys = await caches.keys();
		await Promise.all(
			keys
				.filter((key) =>
					(key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
					|| (!BASE_PATH && isLegacyRootCacheName(key)),
				)
				.map((key) => caches.delete(key)),
		);
		try {
			const current = await caches.open(CACHE_NAME);
			await purgeUnsafeEntries(current);
		} catch {
			// Classification must fail closed. Removing only our exact namespace is
			// safer than leaving a legacy token-bearing entry origin-readable.
			try { await caches.delete(CACHE_NAME); } catch { /* best effort */ }
		}
		await self.clients.claim();
	})());
});

self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET") return;

	const url = new URL(req.url);
	const relativePathname = mountRelativePath(url);

	// Do not claim external/sibling requests or authenticated gateway routes.
	if (relativePathname === null || isGatewayTransport(relativePathname)) return;

	// Network-first. Navigations may fall back to the static sanitized shell.
	// Only explicit queryless immutable assets are candidates for storage.
	event.respondWith((async () => {
		try {
			const response = await fetch(req);
			if (isSafeAssetRequest(req, url) && isSafeAssetResponse(response, url)) {
				const clone = response.clone();
				const cacheKey = safeAssetCacheKey(url);
				try {
					const cache = await caches.open(CACHE_NAME);
					await cache.put(cacheKey, clone);
				} catch {
					// Offline storage is best-effort; never fail the network response.
				}
			}
			return response;
		} catch {
			try {
				const cache = await caches.open(CACHE_NAME);
				if (isSafeAssetRequest(req, url)) {
					const cached = await cache.match(safeAssetCacheKey(url));
					if (cached && !responseForbidsStorage(cached)) return cached;
				}
				if (req.mode === "navigate") {
					const root = await cache.match(OFFLINE_NAVIGATION_URL);
					if (headerValue(root?.headers, OFFLINE_SHELL_HEADER) === "1") return root;
				}
			} catch {
				// Storage is optional; navigations can still use an in-memory safe shell.
			}
			if (req.mode === "navigate") return makeOfflineShell();
			throw new Error("offline and no cached response");
		}
	})());
});
