// Bobbit Service Worker — PWA installability + offline fallback + iOS resume.
//
// Design:
//   * Network-first for most GETs (with cache fallback offline).
//   * Stale-while-revalidate for the **app shell** (`/`, `/index.html`,
//     `/manifest.json`, hashed `/assets/*`) so first paint is never blocked
//     on the network — this is what makes Linear/Slack feel instant on
//     resume.
//   * Navigation requests race a 4 s timeout. iOS frequently keeps a
//     half-dead socket alive after long suspension; the platform `fetch()`
//     can hang indefinitely, holding the navigation hostage before
//     `index.html` ever reaches the parser. On timeout we fall back to the
//     cached shell while the real fetch continues in the background and
//     populates the cache for next time.
//   * `BUILD_ID` is replaced at build time by the `bobbit-sw-version`
//     Vite plugin (and stamped to a fresh value on every dev request).
//     A new BUILD_ID -> new CACHE_NAME -> activate handler purges every
//     cache that isn't the current one. Combined with `skipWaiting()` +
//     `clients.claim()` this means: deploy a new build, the next page
//     load activates the new SW, and the old caches are wiped before
//     the user notices.
//   * `/api/*` and `/ws*` are strictly bypassed — they must always hit
//     the gateway, never the cache, and never the navigation timeout.
const BUILD_ID = "__BOBBIT_BUILD_ID__";
const CACHE_NAME = `bobbit-${BUILD_ID}`;
const NAV_TIMEOUT_MS = 4000;
const NAV_TIMEOUT = Symbol("nav-timeout");
// Likely-next route chunks are appended at build time by the
// `bobbit-sw-version` Vite plugin (see vite.config.ts). The placeholder
// is replaced with a JSON array of `/assets/...` paths; in dev it
// becomes `[]`. Pre-warming these chunks during install means the first
// navigation to e.g. /goal-dashboard hits the cache instead of the
// network — cold-launch parse cost becomes the only bottleneck.
// Replaced at build time with a JS array literal of `/assets/...` paths
// for the most-likely next routes (goal-dashboard, settings-page) by the
// `bobbit-sw-version` Vite plugin. In dev it's `[]`. Pre-warming these
// chunks during install means the first navigation hits the cache
// instead of the network — cold-launch parse cost becomes the only
// bottleneck after a deploy.
// The marker `/*__BOBBIT_PRECACHE_CHUNKS__*/` is replaced at build time
// by the `bobbit-sw-version` Vite plugin with the comma-separated hashed
// paths of the most-likely next route chunks (goal-dashboard,
// settings-page) plus their transitive imports/css. Pre-warming these
// during install means the first navigation hits the cache instead of
// the network — cold-launch parse cost becomes the only bottleneck
// after a deploy. In dev / unstamped sources the marker is a no-op
// comment so the file stays valid JS.
const PRECACHE_ROUTE_CHUNKS = [/*__BOBBIT_PRECACHE_CHUNKS__*/];
const PRECACHE_URLS = ["/", "/index.html", "/manifest.json", ...PRECACHE_ROUTE_CHUNKS];

self.addEventListener("install", (event) => {
	// Activate immediately so a new build replaces the old SW on the next
	// navigation rather than waiting for every tab to close first.
	self.skipWaiting();
	// Best-effort pre-cache of the shell so the first launch after a deploy
	// has something to render even on a slow network. Failures must not
	// block install (e.g. some shell URLs may 404 in dev).
	event.waitUntil((async () => {
		try {
			const cache = await caches.open(CACHE_NAME);
			await cache.addAll(PRECACHE_URLS);
		} catch {
			// Pre-cache is best-effort; ignore failures.
		}
	})());
});

self.addEventListener("activate", (event) => {
	// Purge every cache that isn't the current build. This is what
	// guarantees a fresh-deploy client never serves stale assets.
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(
				keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
			);
			await self.clients.claim();
		})(),
	);
});

// Cache a successful response for next time. Only basic/cors are safe —
// opaque/error responses can poison the cache and serve garbage offline.
function cacheIfOk(req, response) {
	if (response && response.ok && (response.type === "basic" || response.type === "cors")) {
		const clone = response.clone();
		caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
	}
	return response;
}

// What counts as "app shell" for stale-while-revalidate. Hashed
// `/assets/*` URLs are deliberately EXCLUDED (and bypassed entirely
// below). They're content-addressed via the bundler hash; the
// browser's HTTP cache + ETags handle them perfectly. Routing them
// through the SW risks (a) serving stale content during a build hash
// bump, or (b) falling through to a gateway SPA-fallback that returns
// `index.html` for an unknown asset URL during teardown — which trips
// browser MIME enforcement ("Failed to load module script: Expected a
// JavaScript-or-Wasm module script but the server responded with a
// MIME type of text/html").
function isShellPath(pathname) {
	return (
		pathname === "/" ||
		pathname === "/index.html" ||
		pathname === "/manifest.json"
	);
}

self.addEventListener("fetch", (event) => {
	const req = event.request;

	// Only GET is cacheable / fallback-able.
	if (req.method !== "GET") return;

	const url = new URL(req.url);

	// Never touch API or WebSocket traffic — must always hit the gateway.
	if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;

	// Bypass the SW entirely for hashed `/assets/*` URLs (see
	// `isShellPath` for rationale).
	if (url.pathname.startsWith("/assets/")) return;

	const isNavigate = req.mode === "navigate";
	const isShell = isNavigate || isShellPath(url.pathname);

	// Stale-while-revalidate for the app shell: cache instantly, refresh in
	// background. For navigations we additionally race a 4 s timeout against
	// the live fetch in case there's no cache entry yet.
	if (isShell) {
		event.respondWith((async () => {
			const cached = (await caches.match(req)) || (isNavigate ? await caches.match("/") : undefined);

			// Kick off the background refresh. Use `event.waitUntil` so the SW
			// stays alive long enough to populate the cache for next time.
			const networkPromise = fetch(req).then((r) => cacheIfOk(req, r)).catch(() => null);
			try {
				event.waitUntil(networkPromise);
			} catch {
				// `waitUntil` throws if event has already settled; ignore.
			}

			if (cached) {
				// Cache hit: serve it instantly. Background fetch keeps cache fresh.
				return cached;
			}

			// No cache yet (cold first launch). For navigations, race the live
			// fetch against a 4 s timeout so a half-dead iOS socket can't pin
			// the launch. If the timeout wins, fall back to whatever cached
			// shell we have; if neither is available, wait for the real fetch
			// (or finally throw the offline error).
			if (isNavigate) {
				const raced = await Promise.race([
					networkPromise,
					new Promise((resolve) => setTimeout(() => resolve(NAV_TIMEOUT), NAV_TIMEOUT_MS)),
				]);
				if (raced && raced !== NAV_TIMEOUT) return raced;
				const fallback = (await caches.match(req)) || (await caches.match("/"));
				if (fallback) return fallback;
				// Last resort: still wait for the actual fetch to settle.
				const final = await networkPromise;
				if (final) return final;
				throw new Error("offline and no cached response");
			}

			// Non-navigation shell asset (e.g. hashed `/assets/*`) on cold
			// cache: just await the live fetch.
			const live = await networkPromise;
			if (live) return live;
			throw new Error("offline and no cached response");
		})());
		return;
	}

	// Network-first with offline cache fallback for every other GET.
	event.respondWith(
		fetch(req)
			.then((response) => cacheIfOk(req, response))
			.catch(async () => {
				// Network failed — try the per-build cache.
				const cached = await caches.match(req);
				if (cached) return cached;
				// Re-throw — browser shows offline error.
				throw new Error("offline and no cached response");
			}),
	);
});
