// Bobbit Service Worker — PWA installability + offline fallback only.
//
// Design:
//   * Network-first for EVERYTHING (HTML, assets, manifest, icons).
//     Cache is consulted only when the network fetch fails — i.e. true
//     offline / gateway-down fallback. This guarantees that as long as
//     the user is online, they always see the latest deploy and a hard
//     refresh (Ctrl+Shift+R) will always reach the gateway.
//   * `BUILD_ID` is replaced at build time by the `bobbit-sw-version`
//     Vite plugin (and stamped to a fresh value on every dev request).
//     A new BUILD_ID -> new CACHE_NAME -> activate handler purges every
//     cache that isn't the current one. Combined with `skipWaiting()` +
//     `clients.claim()` this means: deploy a new build, the next page
//     load activates the new SW, and the old caches are wiped before
//     the user notices.
//
// Why we no longer cache `/assets/*` aggressively: the cache-first asset
// path was the proximate cause of the "stuck UI after server restart"
// bug. The browser would render an old `index.html` (kept by the
// network-first HTML fallback) referencing immutable hashed bundles
// from the SW cache, and no amount of Ctrl+Shift+R would dislodge it
// because the SW intercepted every subresource fetch. Network-first
// for assets too removes that failure mode entirely while still
// allowing offline use of the last-seen build.
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

	// Network-first with offline cache fallback for every other GET.
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
