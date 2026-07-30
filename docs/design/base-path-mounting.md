# Runtime base-path mounting

**Status:** design for implementation

**Goal:** serve one production Bobbit build at `/` or an arbitrary nested URL prefix such as `/bobbit` or `/team/bobbit`, selected at gateway startup.

## 1. Scope and decisions

Bobbit currently assumes that it owns its origin. The gateway matches `/api/*`, `/ws/*`, `/preview/*`, `/manifest.json`, and static files at the root; the browser builds many root-absolute URLs; Vite emits root-anchored preload URLs; the PWA is registered at `/`; and preview HTML receives a root-absolute `<base>`. A path-stripping proxy fixes only the request that reached the proxy. It does not fix `/assets/*`, `/sw.js`, icons, lazy chunks, copied links, or other URLs that the browser subsequently resolves at the origin root.

The implementation will use these rules:

1. `basePath === ""` is the canonical root-mounted value. A non-root value has one leading slash and no trailing slash.
2. The gateway strips the configured prefix **once at the HTTP and WebSocket boundaries**. Existing internal route literals remain mount-relative (`/api/...`, `/preview/...`, `/ws/...`).
3. URLs crossing from Bobbit to a browser or another process are re-prefixed. Internal route identifiers are not.
4. The production SPA shell is rewritten when served. No prefix-specific build is produced.
5. The Vite development UI remains root-mounted. Its proxy translates root-mounted development requests to a gateway target whose URL may contain a pathname.
6. An explicitly stored `gateway.url` is authoritative, including its pathname. The runtime UI prefix is used only for the same-origin fallback.
7. The `localhost` token remains a local-storage connection sentinel. It is never an HTTP Bearer credential.

The supplied `C:\Users\jsubr\w\bobbit\.bobbit-tmp\basepath.patch` is an intent reference only. Its final `vite.config.ts` hunk is truncated, its normalization accepts unsafe forms, and its call-site list is incomplete. Notable omissions include `src/app/inbox-panel.ts`, `src/ui/inbox/InboxPanel.ts`, the actual request paths in `GitStatusWidget`, `src/app/side-panel-workspace.ts::sidePanelPopoutUrl`, mount-relative parsing in `routing.ts::getRouteFromHash`, server-returned preview URLs, the watchdog health probe, production browser coverage, and Vite proxy response translation.

## 2. Canonical path contract

### 2.1 Shared module

Add dependency-free `src/shared/base-path.ts`, usable by Node and browser bundles:

```ts
export class InvalidBasePathError extends Error {}

/** `""` for root, otherwise `/segment[/segment...]` with no trailing slash. */
export function normalizeBasePath(raw: string | null | undefined): string;

/** Identity in root mode; null means the pathname is outside the mount. */
export function stripBasePath(pathname: string, basePath: string): string | null;

/** Join a canonical base to a mount-relative root-absolute path/query. */
export function withBasePath(path: string, basePath: string): string;
```

`normalizeBasePath` performs the following deterministic algorithm:

1. `undefined`, `null`, an empty/whitespace-only string, and `/` become `""`.
2. Trim surrounding whitespace. For operator convenience, add one leading slash when it is absent (`bobbit` becomes `/bobbit`). Remove trailing slashes (`/bobbit/` becomes `/bobbit`).
3. Reject rather than repair ambiguous or unsafe input:
   - a scheme, authority, query, or fragment (`http:`, `//host`, `?`, `#`);
   - backslashes, NUL/control characters, or embedded whitespace;
   - percent escapes (especially encoded separators or dot segments);
   - duplicate interior separators;
   - `.` or `..` segments; and
   - segments outside the conservative URL-unreserved set `[A-Za-z0-9._~-]+`.
4. Return `""` or the validated canonical path. The allowed alphabet also makes interpolation into `Location`, cookie `Path`, HTML, and URLs unambiguous.

Examples:

| Input | Result |
|---|---|
| absent, `""`, `"  "`, `/` | `""` |
| `bobbit`, `/bobbit/` | `/bobbit` |
| `/team/bobbit/` | `/team/bobbit` |
| `//bobbit`, `/a//b`, `/../x`, `/a%2fb`, `/a?x`, `/a\\b` | error |

`stripBasePath` uses an exact segment boundary:

```text
base=""        pathname="/api/health"       -> "/api/health"
base="/bobbit" pathname="/bobbit/api/health" -> "/api/health"
base="/bobbit" pathname="/bobbit/"           -> "/"
base="/bobbit" pathname="/bobbit-other"      -> null
base="/bobbit" pathname="/api/health"        -> null
```

The bare prefix is redirected before stripping, so mapping it to `/` is useful only to the pure helper and does not suppress the canonical trailing-slash redirect.

`withBasePath` assumes both arguments are internal validated values. It preserves query and hash text: `withBasePath("/?token=x", "/bobbit")` is `/bobbit/?token=x`. It must not inspect or normalize an already absolute external URL.

### 2.2 Configuration precedence

Extend `src/server/cli.ts::CliArgs` and `src/server/server.ts::GatewayConfig`:

```ts
interface CliArgs {
  // existing fields
  basePath: string;
}

export interface GatewayConfig {
  // existing fields
  /** Canonical runtime mount; omitted/empty means root. */
  basePath?: string;
}
```

`parseArgs` reads `BOBBIT_BASE_PATH` first and then applies `--base-path <value>`, so the CLI is authoritative even when the explicit value is empty/root. A missing flag value or invalid environment/flag value produces a concise fatal configuration error and exit code 1. `createGateway` normalizes again for programmatic callers and stores the canonical value in its effective config.

Root remains the default. No project configuration or persisted preference is introduced; this is process-level deployment configuration.

## 3. Gateway request boundary

### 3.1 HTTP

In `src/server/server.ts::createGateway`, perform mount handling immediately after parsing `req.url` in `requestHandler`, before preview routing, CORS, authentication, API dispatch, manifest handling, or static fallback:

```text
parse URL
if base is non-empty and pathname === base:
    301 Location: base + "/" + original search
    return
mountRelative = stripBasePath(url.pathname, base)
if mountRelative is null:
    404 text/plain
    return
url.pathname = mountRelative
continue existing router
```

The query string is preserved exactly by using the parsed `url.search`; `/bobbit?x=1` redirects to `/bobbit/?x=1`. Only `url.pathname` is changed. The prefix is stripped once, so `/bobbit/bobbit/api/health` becomes the internal `/bobbit/api/health` and is not accidentally treated as `/api/health`.

Consequences:

- `/bobbit/api/health`, `/bobbit/preview/...`, `/bobbit/manifest.json`, `/bobbit/assets/...`, and `/bobbit/session/<id>` enter existing handlers as their current root-relative paths.
- `/`, `/api/...`, `/bobbit-other`, `/other/...`, and encoded lookalikes return 404 when mounted.
- Static SPA fallback continues to serve `index.html` for `/session/<id>` after stripping.
- Root mode is an identity operation and preserves the current router.

The boundary must not use `startsWith(basePath)` without the following slash. Exact matching plus `${basePath}/` is the security and non-collision invariant.

### 3.2 WebSocket upgrades

Apply the same helper in `server.on("upgrade")` before matching `src/server/server.ts` viewer/session routes:

```text
wsPath = stripBasePath(parsed.pathname, basePath)
null -> destroy/reject socket
"/ws/viewer" -> viewer connection
/^\/ws\/([^/]+)$/ -> session connection
anything else -> destroy/reject socket
```

There is no redirect for a WebSocket upgrade. Query tokens and the existing first-frame authentication protocol remain unchanged. Test both a successful viewer upgrade and a successful session upgrade below a nested mount, plus unprefixed and shared-string-sibling rejection.

### 3.3 Advertised and callback URLs

In `src/server/cli.ts::main`, append the canonical prefix to:

- `baseUrl` printed as `Listening`;
- `peerUrl` written to `<state>/gateway-url`;
- the UI launch URL;
- the auto-open command; and
- any startup/deep-link URL derived from those values.

The state file contains no trailing slash: `http://127.0.0.1:3001/team/bobbit`. Agent and extension code already appends `/api/...`, so this form composes without double slashes. Existing wildcard-bind-to-loopback conversion remains before adding the path.

The browser QR flow in `src/app/dialogs.ts::showQrCodeDialog` uses the centralized gateway base for both the mobile launch URL and `/api/ca-cert`. Append `?token=` only for a real token, not the localhost sentinel.

### 3.4 Watchdog

`src/server/watchdog.ts` also consumes `state/gateway-url` but currently discards its pathname and probes `/api/health`. Replace separate host-only discovery with a probe target carrying `{ hostname, port, basePath }`. `--base-path`/`BOBBIT_BASE_PATH` is authoritative during the pre-launch phase; the persisted gateway URL refreshes host, port, and pathname after launch. The health request path is `withBasePath("/api/health", basePath)`. Otherwise a healthy mounted gateway would be classified as dead and repeatedly restarted.

## 4. Production SPA shell and build output

### 4.1 Runtime stamp

Add this exact marker near the top of `index.html`, after charset/viewport and before **every** icon, stylesheet, script, manifest, or module reference:

```html
<script>window.__BOBBIT_BASE_PATH__ = "";</script>
```

Vite development serves it unchanged. Production static serving stamps it with JSON string encoding before sending the shell.

Move shell transformations into a small pure server helper (recommended: `src/server/base-path-http.ts`) so tests do not import the entire gateway graph:

```ts
export function rewriteSpaShell(html: string, basePath: string): string;
export function rewriteManifestForBasePath(
  manifest: Record<string, unknown>,
  basePath: string,
  token?: string,
): Record<string, unknown>;
```

`rewriteSpaShell` is identity in root mode. In mounted mode it:

1. requires/replaces the single runtime marker using `JSON.stringify(basePath)`; and
2. re-anchors root-absolute `src` and `href` attributes, with either quote style, while leaving protocol-relative (`//...`), absolute external, `data:`, `blob:`, fragment, and relative URLs untouched.

Only the SPA `index.html` (direct root and fallback) is rewritten. User preview HTML has its own constrained rewrite. A missing or duplicate marker is an implementation/test failure, not a silent root fallback.

`src/server/server.ts::serveStatic` keeps traversal protection and existing cache headers. It reads the selected file, calls `rewriteSpaShell` only when the selected basename is `index.html`, and writes the rewritten UTF-8 body. Assets themselves continue to be located with the stripped mount-relative pathname.

The inline manifest injector in `index.html` reads `window.__BOBBIT_BASE_PATH__`; it never embeds a literal `/manifest.json`. Root favicon and Apple icon references are covered by the shell rewrite. `src/app/render.ts::bobbitIcon` uses the browser `appUrl` helper because it is created after boot rather than present in the shell.

### 4.2 Vite lazy and preload URLs

Rewriting `index.html` is insufficient for URLs synthesized inside JavaScript. Vite's default production preload helper can construct `"/" + dep`, causing lazy chunks to escape the mount.

In `vite.config.ts`, configure `experimental.renderBuiltUrl` only for production output:

- JavaScript-hosted asset/chunk references return a runtime expression based on `globalThis.__BOBBIT_BASE_PATH__`, followed by `/${filename}`.
- CSS-hosted assets use paths relative to the emitted CSS file.
- HTML-hosted URLs may remain root-absolute because `rewriteSpaShell` owns them at response time.
- Development mode retains Vite's normal `/` base and HMR URLs.

Do not set a compile-time `base` to `/bobbit`; that would make the artifact deployment-specific. Do not set all HTML references to `./`; path-style SPA reloads such as `/bobbit/session/<id>` would then look under `/bobbit/session/assets`.

The build test must inspect current `dist/ui/assets/*.js`, not merely the config source, and fail if Vite's root-anchoring asset helper is emitted. The production browser journey additionally records network requests and proves every same-origin chunk and preload request stays below the configured mount.

## 5. Central browser URL boundary

Keep `src/app/gateway-fetch.ts` dependency-free and make it the single browser URL/auth boundary. Export:

```ts
export const GW_URL_KEY = "gateway.url";
export const GW_TOKEN_KEY = "gateway.token";
export const LOCALHOST_TOKEN = "localhost";

/** Runtime UI mount stamped into the shell; `""` in Vite/root mode. */
export function runtimeBasePath(): string;

/** Same-origin UI/static/hash/path URL below runtimeBasePath. */
export function appUrl(path: string): string;

/** Explicit gateway.url, or page origin + runtimeBasePath. No trailing slash. */
export function gatewayBaseUrl(): string;

/** Append a mount-relative HTTP path to gatewayBaseUrl. */
export function gatewayUrl(path: string): string;

/** http->ws / https->wss while retaining the selected gateway pathname. */
export function gatewayWsUrl(path: string, explicitBase?: string): string;

/** Empty for absent/localhost sentinel; real Bobbit Bearer otherwise. */
export function gatewayAuthorizationHeaders(token?: string | null): Record<string, string>;

export function gatewayFetch(path: string, init?: RequestInit): Promise<Response>;
```

The global is read defensively for non-window unit imports. `appUrl` accepts only an internal root-absolute UI path and returns a prefix-relative URL (`/bobbit/favicon.svg`), not a full origin. `gatewayBaseUrl` validates and trims an explicit HTTP(S) stored URL without changing its pathname. It adds `runtimeBasePath` only when storage has no explicit URL. Thus:

```text
page https://host/bobbit/, no stored URL -> https://host/bobbit
stored https://remote/team/gw/         -> https://remote/team/gw
page /bobbit + stored https://remote/team/gw -> no /bobbit duplication
Vite page / + proxy target /bobbit     -> Vite origin (proxy performs translation)
```

`gatewayWsUrl` should use `URL` protocol mutation rather than a broad textual replacement. `gatewayFetch` calls `gatewayUrl`, includes `gatewayAuthorizationHeaders`, preserves caller headers, and keeps existing content-type behavior.

Use `appUrl` only for the UI's own shell/static/navigation surfaces (favicon, manifest, service worker, path-style session links). Use `gatewayFetch`, `gatewayUrl`, or `gatewayWsUrl` for gateway REST, preview, SSE, and socket traffic. This distinction is required for explicit remote gateway URLs.

### 5.1 Boot and persistence

In `src/app/main.ts::initApp`:

- A URL token stores `gatewayBaseUrl` as page origin plus `runtimeBasePath`, never bare origin.
- The unauthenticated localhost health probe uses `gatewayUrl("/api/health")`.
- A successful loopback probe persists the same prefixed fallback URL and `LOCALHOST_TOKEN`.
- Query removal preserves the mounted pathname and hash.
- Service worker registration uses `appUrl("/sw.js")` with scope `${runtimeBasePath()}/` (root is `/`).

`src/app/session-manager.ts::authenticateGateway` normalizes the operator-entered explicit base once, persists that exact base, and uses `gatewayAuthorizationHeaders`. Its downstream `RemoteAgent` socket base stays authoritative; route conversion should still pass through `gatewayWsUrl(path, explicitBase)` so every WebSocket is constructed at the central boundary.

### 5.2 Routing and links

Update these symbols:

- `src/app/routing.ts::getRouteFromHash` strips `runtimeBasePath()` from `window.location.pathname` before applying the `/session/<id>` path-style regex.
- `canonicalizePathSessionRoute` recognizes `${base}/session/<id>` and replaces it with `${base}/#/session/<id>`.
- Hash-only routing remains unchanged; setting `location.hash` preserves the mounted pathname.
- `src/app/api.ts::sessionPathDeepLink` uses `location.origin + appUrl(path)`.
- `absoluteHashUrl`, session hash links, and goal links preserve the current mounted pathname.
- `src/app/side-panel-workspace.ts::sidePanelPopoutUrl` and the duplicate preview construction in `src/app/render.ts` use `gatewayUrl` for previews. Hash-only side-panel popouts remain hash-only so they retain the page mount.

This supports initial path loads, reloads, copied path links, hash links, and canonicalization without redirecting to the origin root.

## 6. Exhaustive client audit

The implementation audit is sink-based, not filename-based. Search all of `src/app/**` and `src/ui/**` for `fetch`, `EventSource`, `WebSocket`, `location.origin`, `gateway.url`, `Authorization`, `Bearer`, iframe `src`, image/icon `src`, `window.open`, `href`, `/api/`, `/preview/`, `/ws/`, and service-worker registration. Classify each hit as one of:

1. gateway request — `gatewayFetch`/`gatewayUrl`;
2. gateway socket — `gatewayWsUrl`;
3. UI/static/navigation — `appUrl` or a hash-only URL;
4. explicitly external/user/blob/data URL — documented no-change; or
5. an internal route identifier passed to a centralized API — documented no-change.

### 6.1 Required REST/auth conversions

The following current raw request owners must be converted, including sites omitted by the reference patch:

| Path / symbol | Required boundary |
|---|---|
| `src/app/main.ts::initApp` | `gatewayUrl`, prefixed fallback persistence |
| `src/app/pr-walkthrough-trust.ts::ensureGithubHostTrusted` | `gatewayFetch` (retain injectable test seam if needed) |
| `src/app/preview-panel.ts::startPreviewSubscription` bootstrap | `gatewayFetch` |
| `src/app/proposal-helpers.ts::draftFetch` | `gatewayBaseUrl`/`gatewayUrl` + centralized auth |
| `src/app/session-manager.ts::authenticateGateway` and draft keepalive/beacon URL | explicit normalized gateway base + centralized auth |
| `src/app/inbox-panel.ts::startInboxSubscription` | `gatewayFetch` |
| `src/ui/components/AskUserChoicesWidget.ts` | `gatewayFetch` or `gatewayUrl` + centralized auth |
| `src/ui/components/BgProcessPill.ts` | `gatewayFetch` |
| `src/ui/components/CostPopover.ts` | `gatewayFetch` |
| `src/ui/components/GitStatusWidget.ts::_openDiffModal`, `_fetchCommits` | prefix the **request URL** and centralize auth; changing only the header is insufficient |
| `src/ui/components/GoalStatusWidget.ts::_fetch` | `gatewayFetch`; viewer socket uses `gatewayWsUrl` |
| `src/ui/components/VerificationOutputModal.ts` | `gatewayFetch` |
| `src/ui/components/review/AnnotationStore.ts::_serverFetch` and initialization | centralize in `_serverFetch` so every read/write/bulk route is covered |
| `src/ui/inbox/AddToInboxDialog.ts` and `InboxPanel.ts` | `gatewayFetch` |
| `src/ui/tools/renderers/EditRenderer.ts` | `gatewayFetch` or authoritative gateway URL + auth helper |
| `src/ui/tools/renderers/GateVerificationLive.ts` | `gatewayFetch` |
| `src/ui/tools/renderers/ReadSessionRenderer.ts` | `gatewayFetch` |

Raw `fetch(source)` in attachment/document extraction, OAuth/external URLs returned by the server, `blob:` downloads, and sample code in prompts are deliberate external/content cases and must not be re-prefixed.

Route strings already passed to `gatewayFetch` (the bulk of `src/app/api.ts`, `host-api.ts`, settings, skills, pack routes, and UI components) are internal mount-relative identifiers. They should remain `/api/...`; adding the mount at those call sites would double-prefix explicit gateway URLs.

### 6.2 Required non-fetch conversions

| Transport/surface | Current owners |
|---|---|
| viewer sockets | `src/app/api.ts::sessionListPushWsUrl`, `components/search-status-dot.ts::_connectViewerWs`, `goal-dashboard.ts::connectDashboardWs`, `src/ui/components/GoalStatusWidget.ts::_connectWs` |
| session sockets | `src/app/remote-agent.ts::_connectWs`, `channel-bridge.ts::ensureConnected`, `surface-token-bridge.ts::getBackgroundSurfaceTokenTransport` |
| preview SSE | `src/app/preview-panel.ts::startPreviewSubscription` |
| preview iframe/popout | `src/app/render.ts::htmlPreviewContent`, `previewUrlForTab`, `sidePanelPopoutUrl`; `src/app/side-panel-workspace.ts::sidePanelPopoutUrl` |
| icon/static | `src/app/render.ts::bobbitIcon`, shell references in `index.html` |
| share/QR/deep links | `src/app/api.ts`, `src/app/dialogs.ts`, `src/app/routing.ts` |
| PWA | `index.html`, `src/app/main.ts`, `public/sw.js`, server manifest handler |

### 6.3 Regression guards

Add a source guard test over `src/app` and `src/ui` that reports `file:line` and enforces:

- no `gateway.url || location.origin` bare-origin fallback outside `gateway-fetch.ts`;
- no direct `Authorization: Bearer ${...}` construction outside `gatewayAuthorizationHeaders`;
- no raw root-relative API/preview/WS URL at a browser sink (`fetch`, `EventSource`, `WebSocket`, iframe/image/href/popout);
- no root `/sw.js`, `/manifest.json`, favicon, or icon construction after shell boot; and
- no persistence of bare `window.location.origin` into `GW_URL_KEY`.

Keep explicit, small exceptions for external-content fetches, blob/data URLs, comments/sample prompts, and internal route literals passed to `gatewayFetch`/Host API dispatch. Exceptions are keyed by exact path and symbol with a reason, not broad directories, so a new direct sink fails visibly.

## 7. PWA behavior

### 7.1 Manifest

`src/server/server.ts` continues serving a dynamic `/manifest.json` after the HTTP boundary strips the mount. `rewriteManifestForBasePath` clones the parsed manifest and sets:

- `start_url` to `${base}/` or `${base}/?token=<encoded real token>`;
- `scope` to `${base}/` when mounted; and
- every root-absolute icon `src` to `${base}<src>`.

Relative/external icon URLs remain unchanged. Invalid tokens are never copied. Root mode preserves current root behavior and root icon values. Responses remain `no-store` with `Referrer-Policy: no-referrer`.

### 7.2 Service worker

`public/sw.js` derives the mount at runtime from `self.location.pathname` by removing the terminal `/sw.js`; it is never stamped per deployment. Required changes:

- Re-anchor build-stamped precache entries with `BASE_PATH`.
- Derive a mount-relative pathname only after exact origin and segment-boundary checks.
- Bypass mount-relative `/api`, `/api/...`, `/ws`, and `/ws/...` before `respondWith`, so API responses cannot enter the cache.
- Use `${BASE_PATH}/` as offline navigation fallback.
- Cache only same-origin, within-mount successful responses; do not claim sibling-app or external responses.
- Namespace caches by mount and build, for example `bobbit:<encoded-mount>:<build-id>`.
- During activation delete only old caches in the current mount namespace. A worker mounted at `/bobbit` must never delete caches belonging to another application or another Bobbit mount on the shared origin. Root mode may perform a one-time cleanup of the legacy `bobbit-<build>` namespace.

`src/app/main.ts` registers `${base}/sw.js` with scope `${base}/`. This needs no `Service-Worker-Allowed` header because the script is located at the top of its own scope.

## 8. Preview behavior

Low-level preview storage remains mount-relative. `src/server/preview/mount.ts` and `preview/artifacts.ts` may continue returning `/preview/...` as an internal result, avoiding deployment configuration in filesystem/security modules. At the gateway/public boundary, externalize every browser-facing `url` with `withBasePath` before it is:

- returned by POST/GET `/api/preview/mount`;
- returned by artifact restore;
- broadcast in `preview-changed`/SSE payloads;
- placed in side-panel workspace source/state; or
- returned by any other preview API in `src/server/server.ts`.

Centralize this in a pure `externalizePreviewResult(result, basePath)` helper so the current `readPreviewMountSnapshot`, restore, mount, workspace, broadcast, and JSON paths cannot diverge.

Extend `src/server/preview/content-route.ts::ContentRouteOptions` with canonical `basePath`. Its input `pathname` remains stripped. Prefix only browser-resolved outputs:

- the 301 `/preview/<sid>` trailing-slash redirect;
- the 302 entry redirect;
- live and artifact `<base href>` values.

Traversal checks (`resolveAssetPath`), stable-directory fencing, session/artifact validation, content MIME handling, cookie/bearer behavior, and bridge injection stay unchanged. Use validated/encoded session, artifact, and entry segments exactly as today.

The browser constructs live/artifact iframe and popout URLs through `gatewayUrl`. This covers current `render.ts` paths and the separate exported `sidePanelPopoutUrl`. A new-tab preview receives the same scoped signed cookie and resolves sibling assets against the prefixed injected `<base>`.

## 9. Cookie and authentication behavior

### 9.1 Signed browser cookie

Extend `src/server/auth/cookie.ts::issueCookie` and `issueIfMissing` options:

```ts
opts: { localhost?: boolean; basePath?: string }
```

Emit `Path=/` in root mode and `Path=<basePath>/` when mounted. `src/server/server.ts` passes the effective canonical path at the sole current issue site. `HttpOnly`, `SameSite=Lax`, lifetime, renewal, signing, and conditional `Secure` behavior are unchanged.

This prevents sibling applications on a shared origin from receiving `bobbit_session` while allowing every API and preview path inside the mount to use it.

### 9.2 Localhost sentinel

`gatewayAuthorizationHeaders` returns `{}` for absent/empty tokens and `LOCALHOST_TOKEN`, and returns `{ Authorization: "Bearer <real>" }` for real Bobbit tokens. Route every browser HTTP Bearer construction through it.

This is required for an oauth2-proxy-style reverse proxy: `Bearer localhost` can trigger JWT validation and a 403 instead of normal reverse-proxy cookie authentication. Omitting the meaningless header lets the browser's proxy session cookie authenticate the request. The WebSocket first-frame `token: "localhost"` remains a Bobbit protocol sentinel and is not an HTTP Authorization header.

### 9.3 Truthful startup banner

Use the same loopback set as the server (`localhost`, `127.0.0.1`, `::1`):

```text
authEnforced = forceAuth || !isLoopbackHost(host)
```

When enforced, print the token, include it in launch/auto-open URLs, and retain the secrecy warning. On loopback without `--auth`, omit the token and token query and state clearly that token authentication is disabled and any local process can access the gateway; mention `--auth` as the remedy. Do not describe an unused generated token as protection.

## 10. Vite development proxy

`vite.config.ts::readGatewayUrl` already re-reads `state/gateway-url` per request. `dynamicGatewayProxy` currently copies `req.url` directly and therefore ignores `new URL(readGatewayUrl()).pathname`.

Add one helper used by both HTTP and upgrade paths:

```text
targetBase = normalized target.pathname ("" for "/")
proxy path = targetBase + incoming root-mounted dev path/query
```

Thus Vite `/api/health`, `/preview/...`, `/manifest.json`, and `/ws/...` proxy to gateway `/bobbit/api/health`, `/bobbit/preview/...`, and so on. Never apply the target path twice.

Because the public development UI remains at `/`, translate path-bearing response metadata back to the Vite root:

- strip the target base from same-gateway `Location` headers (not external redirects);
- rewrite `Set-Cookie Path=<targetBase>/` to `Path=/` for the development origin; and
- rebase the dynamic manifest's `start_url`, `scope`, and same-origin icon paths to `/` before returning it.

Without these response translations, mounted-target preview redirects escape the Vite proxy and the scoped Bobbit cookie is never sent by the root-mounted dev UI. Production direct serving performs no such translation.

The dev service worker plugin continues serving `/sw.js`; the runtime shell base remains empty; HMR and source module URLs remain root-mounted.

## 11. Reverse-proxy deployment and documentation

Update `docs/networking.md` with:

- `--base-path /bobbit` and `BOBBIT_BASE_PATH=/bobbit` syntax and CLI precedence;
- canonical root/default behavior and accepted/rejected forms;
- a prefix-preserving Nginx/Caddy example including WebSocket upgrades;
- an oauth2-proxy example/notes explaining that the localhost sentinel sends no Bearer header;
- the bare-prefix redirect and exact off-mount 404 behavior;
- troubleshooting for asset 404s, incorrect proxy URI rewriting, service-worker scope/cache, stale `state/gateway-url`, and explicit gateway URLs;
- the requirement that the browser-visible prefix and Bobbit base path agree; and
- a dedicated-subdomain recommendation when a subpath is unnecessary.

Explicitly state that a stripping proxy is not a substitute: the HTML response can reach Bobbit while root-absolute browser asset requests bypass the proxy location entirely.

## 12. Test plan and registration

All new tests are registered individually in `tests2/tests-map.json` under `v2Native` with a precise `reason` and `execution` object. Re-run `node scripts/testing-v2/gen-inventory.mjs` only if required by the repository's census workflow, preserving the explicit v2-native entries.

### 12.1 Focused unit tests

Recommended files and ownership:

| Test | Project | Coverage |
|---|---|---|
| `tests2/core/base-path.test.ts` | `core` | normalization/root equivalence; nested segments; every rejected unsafe form; exact strip boundary; join/query round-trip; strip-once behavior |
| `tests2/core/base-path-http.test.ts` | `core` | SPA marker/rewrite, quote styles, external/protocol-relative exclusions, identity root mode; manifest start/scope/icons/token behavior; preview result externalization |
| `tests2/core/base-path-browser-boundary.test.ts` | `core` or isolated `dom` if globals are required | runtime app prefix; explicit stored gateway precedence; trailing slash cleanup; same-origin fallback; remote prefixed HTTP/WS URLs; no double prefix; localhost vs real auth headers |
| `tests2/core/base-path-pwa-cookie-guards.test.ts` | `core` | cookie `Path`; service-worker source/runtime invariants; cache namespace isolation; no raw pathname API bypass; client source guards; root-mode compatibility |
| `tests2/core/base-path-vite-proxy.test.ts` | `core` | target-path request joining for HTTP/WS; response Location/cookie/manifest rebasing; root target identity |

Pure helpers should be exported from small modules rather than tested by source regex where behavior can be invoked. Source inspection remains appropriate for the non-importable service worker, repository-wide regression guards, and emitted bundle assertion.

### 12.2 In-process gateway integration

Add `tests2/integration/base-path-gateway.test.ts`. Register it in the isolated Vitest project because it owns process-global gateway/path state and a listener. Use an isolated temporary state/static directory and explicit `GatewayDeps`; shut the gateway down and remove all state.

Drive the real `createGateway` and assert:

- nested mounted API succeeds with auth;
- `/`, unprefixed `/api/health`, `/bobbit-other`, and other off-mount paths return 404;
- `/team/bobbit?x=1` returns 301 to `/team/bobbit/?x=1`;
- static asset bytes are served below the mount;
- `/team/bobbit/session/<id>` receives the rewritten SPA fallback and stamped prefix;
- manifest plain/tokenized start URL, scope, and icons are prefixed;
- browser-shaped API auth mints `Path=/team/bobbit/`;
- mounted preview redirect, entry redirect, injected `<base>`, artifact URL, and API-returned `url` are prefixed while traversal/auth failures are unchanged;
- mounted viewer and real session WebSocket upgrades authenticate; unprefixed and sibling upgrades fail; and
- a root-configured instance retains existing routes, shell bytes, manifest, cookie path, and sockets.

### 12.3 Production browser journey

Add `tests2/browser/journeys/base-path-mounting.journey.spec.ts` to the normal `browser-v2` project, not the real-agent/manual lane. Extend `tests/e2e/gateway-harness.ts` with an optional worker-scoped `basePath` option; when set, pass it to `GatewayConfig`, include it in `GatewayInfo.baseURL`/`wsBase`/persisted gateway URL, and keep an origin-only value for deliberate off-mount probes. Existing workers default to `""`.

The journey uses `/team/bobbit` and the production `dist/ui` already guaranteed by browser global setup. It must:

1. navigate to the mounted shell and verify emitted JS/CSS/icon requests stay inside the prefix;
2. exercise an API-backed screen and observe the live viewer socket;
3. create/connect a session and observe session socket activity;
4. navigate to a lazy route and verify its chunk/preload request stays mounted;
5. load `/team/bobbit/session/<id>`, reload, and verify canonicalization to `/team/bobbit/#/session/<id>`;
6. mount an HTML preview with a sibling asset, verify the iframe, its injected base, and a popout/new-tab URL;
7. persist an explicit gateway URL that already contains `/team/bobbit`, reload, and assert there is no doubled prefix;
8. assert origin `/`, unprefixed API, and a shared-string sibling return 404 without navigating the app away;
9. capture request headers while the sentinel is stored and verify no `Authorization: Bearer localhost`; and
10. delete every created session/goal/project/preview state through fixture cleanup.

Also read the freshly built `dist/ui/assets/*.js` in this journey (or a sibling browser test) and fail on Vite's root-anchoring assets/preload helper. This makes the assertion run only after the content-addressed production build is current.

### 12.4 Commands

Implementation verification order:

```bash
npm run check
npx vitest run --config vitest.config.ts tests2/core/base-path.test.ts tests2/core/base-path-http.test.ts tests2/core/base-path-browser-boundary.test.ts tests2/core/base-path-pwa-cookie-guards.test.ts tests2/core/base-path-vite-proxy.test.ts tests2/integration/base-path-gateway.test.ts
npm run build
npx playwright test --config playwright-v2.config.ts --project browser-v2 tests2/browser/journeys/base-path-mounting.journey.spec.ts
npm run test:unit
npm run test:browser
```

Inspect `dist/ui/index.html`, the entry chunk, lazy chunks, module-preload helper, `sw.js`, and `.vite/manifest.json` as part of the targeted build check.

## 13. Compatibility and security risks

| Risk | Mitigation / invariant |
|---|---|
| Root deployments regress | `""` is identity in every helper; explicit root-mode assertions; no compile-time Vite base |
| Prefix string collision | exact equality or `${base}/`, never raw `startsWith(base)` |
| Prefix traversal/header/cookie injection | conservative validation, no percent/control/backslash/dot segments, JSON encoding in shell |
| Prefix applied twice | internal routes stay mount-relative; explicit `gateway.url` is authoritative; only boundary helpers join |
| Prefix lost after initial probe | persist `origin + runtimeBasePath`; source guard rejects bare-origin fallback |
| Lazy chunks escape to `/assets` | runtime `renderBuiltUrl`; inspect emitted JS and browser network |
| Path-style reload resolves relative assets incorrectly | keep HTML assets root-absolute until response rewrite; do not use global `./` build base |
| Off-mount request reaches auth/static fallback | reject before all handlers at HTTP/WS boundary |
| Preview asset escapes mount | prefix only URL outputs; retain existing path guard and stable-directory fencing |
| Preview cookie reaches sibling apps | cookie `Path=<base>/` |
| Reverse proxy rejects fake Bearer | centralized auth helper omits localhost sentinel |
| Explicit remote prefixed gateway duplicates UI mount | stored URL wins; gateway helpers append only route path |
| Mounted gateway appears dead to watchdog | probe persisted/configured pathname |
| Vite ignores target pathname | shared request join for HTTP and WS; response path/cookie/manifest translation |
| Service worker caches API or sibling app | mount-relative bypass, within-mount check, per-mount cache namespace/deletion |
| Stale service worker/build | existing build ID/no-cache retained; mounted offline fallback and precache re-anchored |
| Prefix treated as authentication | documentation: base path is routing isolation only; existing Bobbit/proxy auth remains mandatory off loopback |

## 14. Low-conflict implementation partition

The work can be split after agreeing on the interfaces in sections 2 and 5:

1. **Gateway/foundation owner**

   `src/shared/base-path.ts`, `src/server/base-path-http.ts`, `src/server/server.ts`, `src/server/cli.ts`, `src/server/watchdog.ts`, `src/server/auth/cookie.ts`, `src/server/preview/content-route.ts`, and `docs/networking.md`. This owner alone edits `server.ts`, including HTTP/WS stripping, manifest/static rewrite wiring, preview URL externalization, and banner/advertised URLs.

2. **Browser boundary/audit owner**

   `src/app/gateway-fetch.ts`, `main.ts`, `api.ts`, `routing.ts`, `session-manager.ts`, `remote-agent.ts`, transport bridges, preview/render/side-panel files, and every `src/ui` raw request/auth site listed in section 6. This owner first lands the central API, then converts sinks and adds no production changes outside app/UI.

3. **Build/PWA/development-proxy owner**

   `index.html`, `public/sw.js`, and `vite.config.ts`. This owner implements the runtime build URL expression, per-mount worker caching, and Vite mounted-target request/response translation. Coordinate only the agreed global name `__BOBBIT_BASE_PATH__` and browser helper behavior.

4. **Test owner**

   New `tests2/core/*base-path*`, isolated gateway integration, production browser journey, optional `basePath` fixture support in `tests/e2e/gateway-harness.ts`, and `tests2/tests-map.json`. This owner does not change production behavior to satisfy source-pattern tests; behavior tests remain primary.

To avoid merge conflicts, do not split `server.ts` preview/static/routing work between agents, do not split `gateway-fetch.ts` from its call-site audit, and make one owner responsible for the single `tests2/tests-map.json` registration batch.

## 15. Completion criteria

The feature is complete when the same `dist/ui` build runs at root and `/team/bobbit`; all REST, viewer/session WebSocket, lazy chunk, preview, PWA, link/reload, QR, agent callback, and watchdog traffic retains the selected mount; off-mount/sibling routes are rejected; explicit prefixed gateways are not rewritten twice; Vite remains root-mounted while proxying to a mounted target; the localhost sentinel produces no Bearer header; root behavior is unchanged; and the unit, integration, production browser, full unit, and full browser gates pass.
