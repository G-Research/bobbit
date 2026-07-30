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
//     Cache names include both the worker's runtime mount and the build,
//     so separate Bobbit mounts on one origin cannot evict each other.
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

// The worker is registered at `<mount>/sw.js`, so its own location is the
// deployment-independent source of truth for the active mount. Root mode is
// represented as the empty string, matching the browser runtime boundary.
const SW_PATH = self.location.pathname;
const BASE_PATH = SW_PATH.endsWith("/sw.js")
	? SW_PATH.slice(0, -"/sw.js".length)
	: "";
const CACHE_PREFIX = `bobbit:${encodeURIComponent(BASE_PATH || "/")}:`;
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;

// The marker `/*__BOBBIT_PRECACHE_CHUNKS__*/` is replaced at build time
// by the `bobbit-sw-version` Vite plugin with the comma-separated hashed
// paths of the most-likely next route chunks (goal-dashboard,
// settings-page) plus their transitive imports/css. Pre-warming these
// during install means the first navigation hits the cache instead of
// the network — cold-launch parse cost becomes the only bottleneck
// after a deploy. In dev / unstamped sources the marker is a no-op
// comment so the file stays valid JS.
const PRECACHE_ROUTE_CHUNKS = [/*__BOBBIT_PRECACHE_CHUNKS__*/];
const MOUNTED_PRECACHE_ROUTE_CHUNKS = PRECACHE_ROUTE_CHUNKS.map((pathname) =>
	`${BASE_PATH}${pathname.startsWith("/") ? pathname : `/${pathname}`}`,
);
const OFFLINE_NAVIGATION_URL = `${BASE_PATH}/`;

/** Return the mount-relative pathname, or null outside this worker's mount. */
function mountRelativePath(url) {
	if (url.origin !== self.location.origin) return null;
	if (!BASE_PATH) return url.pathname;
	if (url.pathname === BASE_PATH) return "/";
	if (!url.pathname.startsWith(`${BASE_PATH}/`)) return null;
	return url.pathname.slice(BASE_PATH.length);
}

function isGatewayTransport(pathname) {
	// Match transport names as complete path segments at any depth. The nested
	// form is defensive migration behavior: a still-controlling root worker must
	// bypass `/bobbit/api/...` and `/bobbit/ws/...` while the mounted app retires it.
	return /(?:^|\/)(?:api|ws)(?:\/|$)/.test(pathname);
}

self.addEventListener("install", (event) => {
	// Activate immediately so a new build replaces the old SW on the next
	// navigation rather than waiting for every tab to close first.
	self.skipWaiting();
	// Always create the mount-scoped namespace. Besides offline ownership, this
	// is the durable identity marker used by a later mount to distinguish stale
	// Bobbit registrations from unrelated service workers on the shared origin.
	event.waitUntil((async () => {
		try {
			const cache = await caches.open(CACHE_NAME);
			// Best-effort pre-warm of likely-next route chunks so the first
			// navigation to e.g. /goal-dashboard hits the cache instead of the
			// network. Unstamped dev workers simply have an empty list.
			if (MOUNTED_PRECACHE_ROUTE_CHUNKS.length > 0) {
				await cache.addAll(MOUNTED_PRECACHE_ROUTE_CHUNKS);
			}
		} catch {
			// Cache creation/pre-warming is best-effort; ignore failures.
		}
	})());
});

self.addEventListener("activate", (event) => {
	// Delete only superseded builds for this exact mount. Root mode also
	// cleans up the legacy `bobbit-<build>` namespace used before caches were
	// mount-scoped; a mounted worker must never touch those or sibling mounts.
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(
				keys
					.filter((key) =>
						(key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
						|| (!BASE_PATH && key.startsWith("bobbit-")),
					)
					.map((key) => caches.delete(key)),
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
	const relativePathname = mountRelativePath(url);

	// Do not claim external or same-origin sibling-app requests, and never
	// touch gateway API/WebSocket traffic. Comparisons are mount-relative so
	// mounted transports cannot accidentally enter the offline cache.
	if (relativePathname === null || isGatewayTransport(relativePathname)) return;

	// Network-first with offline cache fallback for every other in-mount GET.
	event.respondWith(
		fetch(req)
			.then((response) => {
				const finalUrl = new URL(response.url || req.url);
				// Redirects can leave the mount. Cache only successful final responses
				// that remain on this origin and within this exact mount.
				if (
					response.ok
					&& mountRelativePath(finalUrl) !== null
					&& (response.type === "basic" || response.type === "cors")
				) {
					const clone = response.clone();
					caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
				}
				return response;
			})
			.catch(async () => {
				// Network failed — consult only this mount/build's cache.
				const cache = await caches.open(CACHE_NAME);
				const cached = await cache.match(req);
				if (cached) return cached;
				// Navigation requests should at least get the mounted SPA shell rather
				// than the browser's default failure page.
				if (req.mode === "navigate") {
					const root = await cache.match(OFFLINE_NAVIGATION_URL);
					if (root) return root;
				}
				// Re-throw — browser shows offline error.
				throw new Error("offline and no cached response");
			}),
	);
});
