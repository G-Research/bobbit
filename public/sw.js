// Bobbit Service Worker — PWA installability + offline fallback + cache-first hashed assets.
//
// Design:
//   * Cache-first for `/assets/*` — these URLs are content-addressed
//     (Vite emits `name-<hash>.js`/`.css`), so the URL itself encodes
//     the version. A cached response can never be stale because the
//     hash changes whenever the content does, producing a different
//     URL. This serves the JS bundle from disk on PWA cold resume
//     without a network round-trip.
//   * Network-first for `index.html` and everything else (manifest,
//     icons, …). HTML must stay network-first so a deploy lands fresh
//     HTML referencing the new asset hashes; the cached HTML's old
//     hashes still resolve from cache, but the moment the network
//     succeeds the new HTML wins. This is the property the previous
//     PR #450 stack got wrong by combining HTML SWR with asset
//     cache-first — that produced the "stuck UI after deploy" bug.
//   * Cache is still consulted for non-asset URLs when the network
//     fails — true offline / gateway-down fallback.
//   * `BUILD_ID` is replaced at build time by the `bobbit-sw-version`
//     Vite plugin (and stamped to a fresh value on every dev request).
//     A new BUILD_ID -> new CACHE_NAME -> activate handler purges every
//     cache that isn't the current one. Combined with `skipWaiting()` +
//     `clients.claim()` this means: deploy a new build, the next page
//     load activates the new SW, and the old caches are wiped before
//     the user notices.
const BUILD_ID = "__BOBBIT_BUILD_ID__";
const CACHE_NAME = `bobbit-${BUILD_ID}`;
// The marker `/*__BOBBIT_PRECACHE_CHUNKS__*/` is replaced at build time
// by the `bobbit-sw-version` Vite plugin with the comma-separated hashed
// paths of the most-likely next route chunks (goal-dashboard,
// settings-page) plus their transitive imports/css. Pre-warming these
// during install means the first navigation hits the cache instead of
// the network — cold-launch parse cost becomes the only bottleneck
// after a deploy. In dev / unstamped sources the marker is a no-op
// comment so the file stays valid JS.
const PRECACHE_ROUTE_CHUNKS = [/*__BOBBIT_PRECACHE_CHUNKS__*/];

self.addEventListener("install", (event) => {
	// Activate immediately so a new build replaces the old SW on the next
	// navigation rather than waiting for every tab to close first.
	self.skipWaiting();
	// Best-effort pre-warm of likely-next route chunks so the first
	// navigation to e.g. /goal-dashboard hits the cache instead of the
	// network. Failures must not block install (e.g. unstamped dev SW
	// has an empty list).
	if (PRECACHE_ROUTE_CHUNKS.length > 0) {
		event.waitUntil((async () => {
			try {
				const cache = await caches.open(CACHE_NAME);
				await cache.addAll(PRECACHE_ROUTE_CHUNKS);
			} catch {
				// Pre-cache is best-effort; ignore failures.
			}
		})());
	}
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

self.addEventListener("fetch", (event) => {
	const req = event.request;

	// Only GET is cacheable / fallback-able.
	if (req.method !== "GET") return;

	const url = new URL(req.url);

	// Never touch API or WebSocket traffic — must always hit the gateway.
	if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;

	// Cache-first for hashed `/assets/*` URLs. Safe because the URL is
	// content-addressed: a hash change always invalidates by producing
	// a new URL the cache won't match. Serves JS/CSS chunks from disk on
	// PWA cold resume without a network round-trip.
	if (url.pathname.startsWith("/assets/")) {
		event.respondWith(
			(async () => {
				const cached = await caches.match(req);
				if (cached) return cached;
				const response = await fetch(req);
				if (response.ok && (response.type === "basic" || response.type === "cors")) {
					const clone = response.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
				}
				return response;
			})(),
		);
		return;
	}

	// Network-first with offline cache fallback for every other GET
	// (`/`, `/index.html`, `/manifest.json`, icons, …). HTML stays
	// network-first so a deploy lands fresh HTML referencing the new
	// asset hashes.
	event.respondWith(
		fetch(req)
			.then((response) => {
				// Only cache successful, basic/cors responses. Opaque/error
				// responses can poison the cache and serve garbage offline.
				if (response.ok && (response.type === "basic" || response.type === "cors")) {
					const clone = response.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
				}
				return response;
			})
			.catch(async () => {
				// Network failed — try the per-build cache.
				const cached = await caches.match(req);
				if (cached) return cached;
				// Navigation requests should at least get *some* HTML rather
				// than the browser's default failure page. Fall back to the
				// cached root if we have one.
				if (req.mode === "navigate") {
					const root = await caches.match("/");
					if (root) return root;
				}
				// Re-throw — browser shows offline error.
				throw new Error("offline and no cached response");
			}),
	);
});
