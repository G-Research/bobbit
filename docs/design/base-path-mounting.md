# Runtime base-path mounting

**Status:** design for implementation

**Goal:** serve one production Bobbit build at `/` or an arbitrary nested URL prefix such as `/bobbit` or `/team/bobbit`, selected at gateway startup.

## 1. Scope and decisions

Bobbit currently assumes that it owns its origin. The gateway matches `/api/*`, `/ws/*`, `/preview/*`, `/manifest.json`, and static files at the root; the browser builds many root-absolute URLs; Vite emits root-anchored preload URLs; the PWA is registered at `/`; and preview HTML receives a root-absolute `<base>`. A path-stripping proxy fixes only the request that reached the proxy. It does not fix `/assets/*`, `/sw.js`, icons, lazy chunks, copied links, or other URLs that the browser subsequently resolves at the origin root.

The implementation will use these rules:

1. `basePath === ""` is the canonical root-mounted value. A non-root value has one leading slash and no trailing slash.
2. The gateway strips the configured prefix **once at the HTTP and WebSocket boundaries**. Existing internal route literals remain mount-relative (`/api/...`, `/preview/...`, `/ws/...`).
3. There are three deliberately different URL shapes: a mount-relative `GatewayRoute`, a mounted origin-relative `PublicGatewayPath`, and an absolute `PublicGatewayUrl`. They are converted in that order and never fed backwards into a resolver.
4. Preview API, SSE, workspace, and persisted payloads retain a mount-relative `GatewayRoute` even though the legacy field is named `url`. Only direct HTTP browser outputs (`Location` and injected `<base>`) and browser DOM sinks are public/mounted URLs. This gives preview URLs exactly one prefix owner.
5. The production SPA shell is rewritten when served. No prefix-specific build is produced.
6. The Vite development UI remains root-mounted. Its proxy translates root-mounted development requests to a gateway target whose URL may contain a pathname; mount-relative JSON/SSE/workspace payloads need no body translation.
7. An explicitly stored `gateway.url` is authoritative, including its pathname. The runtime UI prefix is used only for the same-origin fallback.
8. The `localhost` token remains a local-storage connection sentinel. It is never an HTTP Bearer credential.
9. Fully browser-navigable explicit distinct-origin gateways are supported when the UI and gateway use the same scheme and hostname (a different port is allowed), so the existing signed-cookie model works for native EventSource, iframe, and popout traffic. Arbitrary cross-site preview embedding is outside this base-path goal; REST and WebSocket connections remain supported there, but the UI must not start cookie-only preview transports and must explain the compatibility boundary.

The supplied `C:\Users\jsubr\w\bobbit\.bobbit-tmp\basepath.patch` is an intent reference only. Its final `vite.config.ts` hunk is truncated, its normalization accepts unsafe forms, and its call-site list is incomplete. Notable omissions include `src/app/inbox-panel.ts`, `src/ui/inbox/InboxPanel.ts`, the actual request paths in `GitStatusWidget`, `src/app/side-panel-workspace.ts::sidePanelPopoutUrl`, mount-relative parsing in `routing.ts::getRouteFromHash`, server-returned preview URLs, the watchdog health probe, production browser coverage, and Vite proxy response translation.

## 2. Canonical path contract

### 2.1 Shared module

Add dependency-free `src/shared/base-path.ts`, usable by Node and browser bundles:

```ts
export class InvalidBasePathError extends Error {}

declare const gatewayRouteBrand: unique symbol;
declare const publicGatewayPathBrand: unique symbol;
export type GatewayRoute = string & { readonly [gatewayRouteBrand]: true };
export type PublicGatewayPath = string & { readonly [publicGatewayPathBrand]: true };

/** `""` for root, otherwise `/segment[/segment...]` with no trailing slash. */
export function normalizeBasePath(raw: string | null | undefined): string;

/** Validate/brand an internal root-absolute route; it has no deployment prefix semantics. */
export function gatewayRoute(raw: string): GatewayRoute;

/** Identity in root mode; null means the pathname is outside the mount. */
export function stripBasePath(pathname: string, basePath: string): string | null;

/** Join a GatewayRoute to the configured mount, producing a PublicGatewayPath. */
export function withBasePath(route: GatewayRoute, basePath: string): PublicGatewayPath;
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

`gatewayRoute` requires one leading slash and rejects absolute/protocol-relative/control/backslash input while preserving query/hash text. `withBasePath` accepts only that opaque type: `withBasePath(gatewayRoute("/?token=x"), "/bobbit")` is `/bobbit/?token=x`. It never accepts a `PublicGatewayPath`/`PublicGatewayUrl`.

### 2.2 URL-shape ownership

These contracts use opaque shared/browser types inside TypeScript. JSON/SSE/storage compatibility surfaces are decoded and branded immediately rather than passed onward as untyped strings:

| Contract | Example at base `/bobbit` | Producer and permitted consumers |
|---|---|---|
| `GatewayRoute` | `/preview/<sid>/index.html`, `/api/health` | Existing routers, preview storage, API JSON, SSE events, workspace/tab state, watchdog route input. It is never assigned directly to `src`, `href`, `EventSource`, `fetch`, or `WebSocket`. |
| `PublicGatewayPath` | `/bobbit/preview/<sid>/index.html` | `withBasePath(GatewayRoute, basePath)` at the server's direct HTTP boundary: `Location`, preview `<base>`, manifest/shell paths, cookie scope. It is not passed to `gatewayUrl`. |
| `PublicGatewayUrl` | `https://host/bobbit/preview/<sid>/index.html` | `gatewayUrl(GatewayRoute)` at a browser/network sink, plus startup/QR/peer URLs. It is final and is never re-prefixed. |
| `AppPath` | `/bobbit/#/session/<sid>` | `appUrl` for the UI shell, static assets, PWA, and UI navigation only. |

The field `PreviewResult.url` stays wire-compatible but is explicitly a `GatewayRoute`, not a link. All preview producers—mount/restore APIs, `readPreviewMountSnapshot`, `preview-changed` SSE payloads, side-panel workspace source/state, and serialized preview tool results—store and return `/preview/...`. They must not call `withBasePath`. The consuming browser calls `gatewayUrl(result.url)` exactly once when constructing an iframe, popout, or direct preview link. Structured `sessionId`, `entry`, and `artifactId` remain preferred for state and identity.

Direct preview protocol responses are different: the content router receives a stripped `GatewayRoute`, then calls `withBasePath` for its 301/302 `Location` and injected live/artifact `<base href>`. These mounted paths are written to HTTP, not copied back into `PreviewResult.url`.

The boundary helpers accept only opaque `GatewayRoute`, while their outputs have distinct `PublicGatewayPath`/`PublicGatewayUrl` types and cannot be fed back without an explicit unsafe cast. Do **not** infer “already mounted” from string prefix: valid deployments may use `/api`, `/preview`, or `/ws` as their base, where `gatewayRoute("/api/health")` below base `/api` correctly resolves to `/api/api/health`. Single-prefix ownership is enforced by types, preview wire decoders that require a validated `/preview/...` route, and producer-boundary tests; a public value cannot enter `gatewayUrl` through the supported API.

### 2.3 Configuration precedence

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

`parseArgs` selects the effective raw value by presence: the last explicit `--base-path <value>` when supplied, otherwise `BOBBIT_BASE_PATH`, otherwise root. It then validates only that selected value, so a valid CLI value—including empty/root—overrides even an invalid environment value. A missing flag value or invalid selected environment/flag value produces a concise fatal configuration error and exit code 1. `createGateway` normalizes again for programmatic callers and stores the canonical value in its effective config.

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

In `src/server/cli.ts::main`, build one `StartupUrls` record after `gateway.start()` reveals the actual port. Append the canonical prefix to:

- `listenUrl` printed as `Listening`;
- `peerUrl` written to `<state>/gateway-url` and supplied to agent/extension callback setup;
- `uiUrl` printed in the banner;
- `openUrl` passed to the injected/OS browser opener; and
- any startup/deep-link URL derived from those values.

`listenUrl` and `peerUrl` have no trailing slash: `http://127.0.0.1:3001/team/bobbit`. `uiUrl`/`openUrl` use `/team/bobbit/`; they append `?token=` only when `authEnforced` is true. Existing wildcard-bind-to-loopback conversion remains before adding the path.

The actual port must be known before persisted sessions respawn. Change gateway startup to a two-phase contract: initialize non-agent services, bind the listener behind a not-ready request gate, then invoke a required `onBound(actualPort)` hook. During this window, HTTP still applies the mount boundary first (off-mount remains 404) and returns 503 only for in-mount requests; WebSocket upgrades are rejected. The CLI builds `StartupUrls`, atomically replaces `gateway-url`, and installs the same `peerUrl` into callback/agent setup in this hook. Only after the hook succeeds may `restoreSessions`, verification/team resumption, or any agent/extension callback launch run; then mark the request gate ready and let `start()` resolve. If `onBound` fails, close the listener and launch no agents. This avoids a stale/unprefixed callback URL even with port `0`; the final `Listening` banner and opener still run only after full readiness.

The browser QR flow in `src/app/dialogs.ts::showQrCodeDialog` uses the centralized gateway base for both the mobile launch URL and `/api/ca-cert`. The mobile launch path is the selected gateway base plus `/`, and it appends `?token=` only for a real token, not the localhost sentinel. Session path/hash deep links use the same selected UI/gateway mount and never bare `location.origin`.

### 3.4 Watchdog

`src/server/watchdog.ts` also consumes `state/gateway-url` but currently discards its pathname and probes `/api/health`. Replace separate host-only discovery with exported pure `resolveWatchdogProbeTarget`/`watchdogHealthPath` helpers carrying `{ protocol, hostname, port, basePath }`.

Before first launch, select by presence exactly like the CLI: forwarded `--base-path` wins over `BOBBIT_BASE_PATH`, including an explicit `""` or `/` root override, and only the selected value is validated. Thus a valid flag also overrides an invalid environment value. A missing or invalid selected value stops the watchdog with exit 1 instead of starting a process it can never probe correctly. At each child launch, snapshot `gateway-url` as `{ raw, mtimeMs }` and record the launch time. A short startup poll and every normal health tick re-read the file; the CLI's post-bind atomic replacement is the fresh-launch generation signal (health may remain 503 until restore completes). Adopt protocol, host, actual port, and pathname together only from a valid record whose content or mtime changed from the pre-launch snapshot. An unchanged pre-launch record is stale unless it already equals the selected pre-launch target; a missing/unparseable record retains that complete target and logs one bounded actionable warning. Stop the startup poll when a fresh record is adopted or the child exits, and repeat this generation/change detection after every relaunch.

The health request path is `withBasePath(gatewayRoute("/api/health"), target.basePath)`. Tests drive the actual probe against a listener and assert that `/team/bobbit/api/health`, not `/api/health`, resets the failure counter. Otherwise a healthy mounted gateway would be classified as dead and repeatedly restarted.

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

Preview-result externalization intentionally does **not** belong in this module: preview results remain `GatewayRoute` data under the URL-shape contract in section 2.2.

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

Keep `src/app/gateway-fetch.ts` dependency-light (its only production import is the dependency-free shared base-path module) and make it the single browser URL/auth boundary. Export:

```ts
import type { GatewayRoute } from "../shared/base-path.js";

export const GW_URL_KEY = "gateway.url";
export const GW_TOKEN_KEY = "gateway.token";
export const LOCALHOST_TOKEN = "localhost";

declare const publicGatewayUrlBrand: unique symbol;
export type PublicGatewayUrl = string & { readonly [publicGatewayUrlBrand]: true };

export class InvalidGatewayBaseUrlError extends Error {
  readonly code: "EMPTY" | "INVALID_SYNTAX" | "NOT_ABSOLUTE" |
    "UNSUPPORTED_PROTOCOL" | "CREDENTIALS" | "QUERY" | "FRAGMENT" |
    "INVALID_PATH";
}

/** Canonical absolute HTTP(S) base, no query/fragment/credentials/trailing slash. */
export function normalizeGatewayBaseUrl(raw: string): string;

/** Runtime UI mount stamped into the shell; `""` in Vite/root mode. */
export function runtimeBasePath(): string;

/** Same-origin UI/static/hash/path URL below runtimeBasePath. */
export function appUrl(path: string): string;

/** Explicit valid gateway.url, or page origin + runtimeBasePath. No trailing slash. */
export function gatewayBaseUrl(): string;

/** Resolve one mount-relative GatewayRoute to an absolute PublicGatewayUrl. */
export function gatewayUrl(route: GatewayRoute, explicitBase?: string): PublicGatewayUrl;

/** http->ws / https->wss while retaining the selected gateway pathname. */
export function gatewayWsUrl(route: GatewayRoute, explicitBase?: string): string;

/** Empty for absent/localhost sentinel; real Bobbit Bearer otherwise. */
export function gatewayAuthorizationHeaders(token?: string | null): Record<string, string>;

export interface ActiveGatewayConnection { baseUrl: string; token: string; }
export function activeGatewayConnection(): Readonly<ActiveGatewayConnection>;
export function gatewayFetch(route: GatewayRoute, init?: RequestInit): Promise<Response>;
```

The global is read defensively for non-window unit imports. `appUrl` accepts only an internal root-absolute UI path and returns an origin-relative mounted path (`/bobbit/favicon.svg`), not a full origin. `gatewayUrl` and `gatewayWsUrl` accept only an opaque `GatewayRoute`; absolute/public values cannot enter without bypassing the type/decoder boundary. One module-local active connection is the runtime source of truth for base URL and token; `gatewayBaseUrl`, `gatewayFetch`, WebSocket, SSE, and preview resolution all read it. On first boot it is hydrated from a valid stored pair or the same-origin mounted fallback—never independently re-read by each transport. Thus:

```text
page https://host/bobbit/, no stored URL       -> https://host/bobbit
stored https://remote/team/gw/                 -> https://remote/team/gw
page /bobbit + stored https://remote/team/gw   -> no /bobbit duplication
gatewayRoute("/preview/x") + stored .../team/gw -> https://remote/team/gw/preview/x
Vite page / + no stored URL, target /bobbit    -> Vite origin; proxy adds /bobbit
```

`gatewayWsUrl` uses `URL` protocol mutation rather than textual replacement. `gatewayFetch` calls `gatewayUrl`, includes `gatewayAuthorizationHeaders`, defaults `credentials` to `"include"`, preserves caller headers/explicit credential mode, and keeps existing content-type behavior. Use `appUrl` only for the UI's shell/static/navigation surfaces. Gateway REST, preview, SSE, and sockets use their gateway helpers; API/SSE data containing a preview `url` is still a `GatewayRoute` and is resolved only at the final sink.

### 5.1 Explicit base normalization and recovery

`normalizeGatewayBaseUrl` is the one parser for operator input, persisted `gateway.url`, and an explicit base passed to socket helpers:

1. Trim the whole input; an empty value throws `InvalidGatewayBaseUrlError("EMPTY")` for an explicit base (absence is represented by no storage key, not an empty explicit base). Reject NUL/control characters, embedded whitespace, and backslashes **anywhere** in the remaining raw string before invoking `URL`.
2. Require a literal case-insensitive `http://` or `https://` prefix and an authority with a hostname. Relative/protocol-relative values and non-HTTP schemes are rejected rather than repaired.
3. Reject username/password, query, and fragment. They are credentials or per-request state, not part of a gateway base.
4. Before constructing/canonicalizing with `URL`, lexically isolate the raw pathname after the authority and validate that text with `normalizeBasePath`. This ordering is mandatory because WHATWG `URL` removes literal/encoded dot segments before exposing `.pathname`. Percent escapes, dot segments, and duplicate separators must therefore fail based on the operator's original text rather than being repaired by the parser. `/` becomes no pathname; a valid nested path is retained without a trailing slash.
5. Return the platform-canonical origin (host case/default port/IPv6 serialization) plus the already-validated canonical pathname. Do not silently delete invalid components.

Examples: `https://GW.example:443/team/bobbit/` becomes `https://gw.example/team/bobbit`; `http://127.0.0.1:3001/` becomes `http://127.0.0.1:3001`. Reject `gw.example/bobbit`, `//gw/bobbit`, `ftp://gw/x`, `https://u:p@gw/x`, `https://gw/x?q=1`, `https://gw/x#f`, `https:\\gw\\team`, `https://gw\\team`, embedded tab/newline input, and every invalid base-path form from section 2.

Persistence and recovery are intentionally asymmetric:

- Operator connection: normalize a candidate first and authenticate against that in-memory candidate. Commit `GW_URL_KEY` and `GW_TOKEN_KEY` only after the health/auth handshake succeeds; on validation, network, or auth failure, leave the previous committed pair unchanged and show the typed error. No failed candidate is persisted.
- Valid but later unreachable stored base: it remains authoritative and the normal reconnect UI is shown. Never silently send its token to the page-origin fallback.
- Malformed stored base: before any network call, remove both URL and token (preventing a real token from leaking to another origin), fall back to `location.origin + runtimeBasePath()`, and surface one recoverable “invalid saved gateway; using this deployment” warning. The fallback is persisted only after its own health/auth probe succeeds.
- URL-token and localhost discovery flows likewise probe first, then persist `location.origin + runtimeBasePath()` and the token/sentinel. Query removal happens after the commit and preserves mounted pathname and hash.

After successful authentication, set the module-local active pair to the candidate, then attempt the two storage writes synchronously in one connection-commit function; publish cross-tab notification only after both writes. If either write throws, restore the previous persisted pair but retain the authenticated candidate as the active in-memory pair for the current tab with a storage warning. Every fetch, authorization lookup, WebSocket, EventSource, iframe, and popout must continue using that active pair; only a reload returns to the previous persisted connection.

### 5.2 Native transport credentials and compatibility boundary

Fetch/WebSocket bearer or first-frame authentication does not solve native preview transports. The contract is:

1. `gatewayFetch` uses `credentials: "include"`. The successful authenticated handshake/API call deterministically bootstraps the signed `bobbit_session` cookie before preview SSE, iframe, or popout is enabled.
2. Preflight and authenticated bearer REST responses from any syntactically valid HTTP(S) `Origin` receive that exact origin in `Access-Control-Allow-Origin`, plus `Access-Control-Allow-Credentials: true` and `Vary: Origin`; credentials are never combined with `*`. Preflight permits the centralized authorization/content headers. This preserves arbitrary distinct-host bearer REST even though `gatewayFetch` uses `credentials: include`. For an Origin outside the native-transport compatibility set, a signed Bobbit cookie alone is not accepted for API auth—the real bearer remains required—so reflected CORS does not turn a sibling/cross-site cookie into access. Signed-cookie issuance is narrower: extend the browser-cookie classifier to accept `Sec-Fetch-Site: same-site` only when parsed UI Origin and request origin have the same scheme and normalized hostname (ports may differ); all other Fetch Metadata and bearer/localhost bootstrap checks remain. Cookie renewal and cookie-authenticated SSE use the same compatibility check.
3. `EventSource(gatewayUrl(route), { withCredentials: true })` uses that signed cookie. The iframe and `window.open`/anchor use the absolute `PublicGatewayUrl` and the same gateway cookie. The cookie remains host-only, `HttpOnly`, and mount-scoped; no Bobbit token is placed in an SSE or preview URL.
4. Same-origin deployments, root Vite through its proxy, and explicit same-scheme/same-host different-port gateways are fully supported. An oauth2-proxy cookie also works because `credentials: "include"` is used and the localhost sentinel emits no Bearer header.
5. Arbitrary cross-site explicit bases remain valid for authenticated REST and WebSocket round trips, preserving existing remote-gateway capability, but are **not** promised for cookie-only EventSource/iframe/popout because `SameSite=Lax`, third-party-cookie blocking, and native transports make reliable bearer authentication impossible without a larger capability/proxy design. Before starting preview SSE or rendering a preview URL, a pure compatibility check reports this boundary and recommends serving Bobbit UI from the gateway origin or a same-host reverse proxy. It must not emit a broken iframe/EventSource request.

This is a deliberate compatibility boundary, not an accidental partial success: the base-path objective and acceptance journey deploy the bundled UI and gateway at the same origin, while a separate two-origin test uses the same hostname on different ports to exercise all explicit-gateway transports. A second incompatible-host test pins the REST/WS-only warning behavior.

### 5.3 Boot and persistence

In `src/app/main.ts::initApp`:

- A URL token uses page origin plus `runtimeBasePath`, never bare origin, and persists only after validation/authentication as described above.
- The unauthenticated localhost health probe uses `gatewayUrl(gatewayRoute("/api/health"))`.
- A successful loopback probe persists the same prefixed fallback URL and `LOCALHOST_TOKEN`.
- Query removal preserves the mounted pathname and hash.
- Service worker registration uses `appUrl("/sw.js")` with scope `${runtimeBasePath()}/` (root is `/`).

`src/app/session-manager.ts::authenticateGateway` uses the candidate base explicitly during authentication, then commits the normalized exact base. Its downstream `RemoteAgent` socket base stays authoritative; route conversion passes through `gatewayWsUrl(route, explicitBase)` so every WebSocket is constructed at the central boundary.

### 5.4 Routing, links, and historical preview data

Update these symbols:

- `src/app/routing.ts::getRouteFromHash` strips `runtimeBasePath()` from `window.location.pathname` before applying the `/session/<id>` path-style regex.
- `canonicalizePathSessionRoute` recognizes `${base}/session/<id>` and replaces it with `${base}/#/session/<id>`.
- Hash-only routing remains unchanged; setting `location.hash` preserves the mounted pathname.
- `src/app/api.ts::sessionPathDeepLink` uses `location.origin + appUrl(path)`.
- `absoluteHashUrl`, session hash links, and goal links preserve the current mounted pathname.
- `src/app/side-panel-workspace.ts::sidePanelPopoutUrl` and the duplicate preview construction in `src/app/render.ts` resolve a `GatewayRoute` once with `gatewayUrl`. Hash-only side-panel popouts remain hash-only so they retain the page mount.

Centralize URL-only historical parsing in `previewRouteFromStoredValue`. `src/app/render.ts::previewEntryForTab`/`previewSessionIdForTab` and `src/ui/tools/renderers/PreviewRenderer.ts::resolveEntry` must not apply `/^\/preview/` directly. The parser:

1. accepts the current mount-relative `/preview/...` contract;
2. accepts an old absolute `PublicGatewayUrl` only when its origin/path match the selected normalized gateway base, strips that base pathname, and returns the internal `/preview/...` suffix;
3. accepts an old origin-relative mounted value by stripping `runtimeBasePath()` or the explicit gateway base pathname; and
4. as a final compatibility path for URL-only records created under a no-longer-known mount, recognizes a validated `/<old-prefix>/preview/<uuid>/...` suffix, validates the UUID/artifact/entry segments, and returns only the `/preview/...` route. It never navigates or fetches the original historical string.

New state always stores structured identity plus a mount-relative preview route. This supports initial path loads, reloads, copied links, historical records, and canonicalization without redirecting to the origin root or teaching parsers about the deployment mount.

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
- no `PreviewResult.url`/workspace preview `url` assigned to a DOM/network sink without `gatewayUrl`, and no server API/SSE/workspace producer calling `withBasePath` on that field;
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

Low-level preview storage and every data transport remain mount-relative. `src/server/preview/mount.ts`, `preview/artifacts.ts`, `readPreviewMountSnapshot`, POST/GET `/api/preview/mount`, artifact restore, `preview-changed` broadcasts/SSE bootstrap, tool snapshots, and side-panel workspace source/state all preserve:

```ts
// Historical property name; semantic type is GatewayRoute, not PublicGatewayUrl.
{ url: "/preview/<session-id>/<entry>", entry, sessionId, artifactId? }
```

Do not add `externalizePreviewResult`: that helper was the source of the double-prefix ambiguity. A shared `previewGatewayRoute(raw)` decoder requires exact `/preview/<validated-session>/...` syntax and returns opaque `GatewayRoute`; API, SSE, tool-snapshot, and workspace deserializers call it immediately. Clients may inspect/store the route, but call `gatewayUrl(result.url)` only at the iframe/popout/link sink. Direct tests pin POST, GET, restore, SSE bootstrap, live SSE event, and workspace serialization to `/preview/...` under both root and mounted gateways.

Extend `src/server/preview/content-route.ts::ContentRouteOptions` with canonical `basePath`. Its input `pathname` remains stripped. It calls `withBasePath` only for browser-resolved HTTP outputs:

- the 301 `/preview/<sid>` trailing-slash `Location`;
- the 302 entry `Location`; and
- live and artifact `<base href>` values.

Mark the server-owned element as `<base data-bobbit-preview-base href="...">`; the marker lets the Vite proxy rewrite only Bobbit's injected base without touching a user-authored element. Traversal checks (`resolveAssetPath`), stable-directory fencing, session/artifact validation, content MIME handling, cookie/bearer behavior, and bridge injection stay unchanged. Use validated/encoded session, artifact, and entry segments exactly as today. The browser constructs live/artifact iframe and popout `PublicGatewayUrl` values through `gatewayUrl` exactly once. A new-tab preview receives the same scoped signed cookie and resolves sibling assets against the mounted injected `<base>`.

For root Vite targeting a mounted gateway, the request stays `/preview/...` in the browser and the proxy adds the target mount. The proxy strips that mount from redirect `Location` and from the injected preview `<base>` in proxied HTML, so follow-up assets also return through `/preview/...`. API JSON, SSE event data, workspace state, and tool snapshot bodies require **no** Vite rewrite because their `url` fields are intentionally `GatewayRoute` values. For an explicit gateway base in Vite, `gatewayUrl` points directly to that gateway and its mounted `Location`/`<base>` are already correct.

## 9. Cookie and authentication behavior

### 9.1 Signed browser cookie

Extend `src/server/auth/cookie.ts::issueCookie` and `issueIfMissing` options:

```ts
opts: { localhost?: boolean; basePath?: string }
```

Emit `Path=/` in root mode and `Path=<basePath>/` when mounted. `src/server/server.ts` passes the effective canonical path at the sole current issue site. `HttpOnly`, `SameSite=Lax`, lifetime, renewal, signing, and conditional `Secure` behavior are unchanged.

This prevents sibling applications on a shared origin from receiving the newly issued mounted `bobbit_session` while allowing every API and preview path inside the mount to use it.

Cookie names are not port-scoped, and an older/root cookie with the same name may coexist with the mounted cookie. Replace map-style single-value parsing at authentication sites with duplicate-aware collection: read every `bobbit_session` value from the Cookie header without comma folding and accept the request when **any** value verifies against the current gateway's `CookieStore`. An invalid/root/different-gateway cookie must not shadow a valid mounted cookie in either header order. Renewal and `extractCookieValue`/SSE re-authentication select a value that verified in the current store; if none verifies, authentication fails. Keep the common cookie name for compatibility rather than deriving a deployment-specific name.

### 9.2 Localhost sentinel

`gatewayAuthorizationHeaders` returns `{}` for absent/empty tokens and `LOCALHOST_TOKEN`, and returns `{ Authorization: "Bearer <real>" }` for real Bobbit tokens. Route every browser HTTP Bearer construction through it.

This is required for an oauth2-proxy-style reverse proxy: `Bearer localhost` can trigger JWT validation and a 403 instead of normal reverse-proxy cookie authentication. Omitting the meaningless header lets the browser's proxy session cookie authenticate the request. The WebSocket first-frame `token: "localhost"` remains a Bobbit protocol sentinel and is not an HTTP Authorization header.

### 9.3 Truthful startup banner

Use the same loopback set as the server (`localhost`, `127.0.0.1`, `::1`):

```text
authEnforced = forceAuth || !isLoopbackHost(host)
```

When enforced, print the token, include it in launch/auto-open URLs, and retain the secrecy warning. On loopback without `--auth`, omit the token and token query and state clearly that token authentication is disabled and any local process can access the gateway; mention `--auth` as the remedy. Do not describe an unused generated token as protection. Banner formatting is derived from the same `StartupUrls`/`authEnforced` record used by persistence and auto-open, preventing display and behavior from diverging.

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
- rewrite `Set-Cookie Path=<targetBase>/` to `Path=/` for the development origin;
- rebase the dynamic manifest's `start_url`, `scope`, and same-origin icon paths to `/`; and
- for proxied `/preview/...` HTML only, strip the target base from the single `<base data-bobbit-preview-base>` element. Preserve encoding and reject a duplicate marker rather than broadly rewriting user HTML; a missing marker is valid for non-HTML/error responses.

Do not rewrite API JSON, SSE frames, or workspace/tool data: preview `url` fields are `GatewayRoute` values and must remain `/preview/...`. Without the metadata/HTML translations, mounted-target preview redirects/assets escape the Vite proxy and the scoped Bobbit cookie is never sent by the root-mounted dev UI. Production direct serving performs no such translation.

The dev service worker plugin continues serving `/sw.js`; the runtime shell base remains empty; HMR and source module URLs remain root-mounted.

## 11. Reverse-proxy deployment and documentation

Update `docs/networking.md` with:

- `--base-path /bobbit` and `BOBBIT_BASE_PATH=/bobbit` syntax and CLI precedence;
- canonical root/default behavior and accepted/rejected forms;
- a prefix-preserving Nginx/Caddy example including WebSocket upgrades;
- an oauth2-proxy example/notes explaining that the localhost sentinel sends no Bearer header;
- the bare-prefix redirect and exact off-mount 404 behavior;
- troubleshooting for asset 404s, incorrect proxy URI rewriting, service-worker scope/cache, stale `state/gateway-url`, and explicit gateway URLs;
- the explicit-gateway transport boundary: same-scheme/same-host different-port is fully supported; arbitrary distinct-host bases retain bearer REST/WS but preview SSE/iframe/popout require a same-host proxy/origin;
- the requirement that the browser-visible prefix and Bobbit base path agree; and
- a dedicated-subdomain recommendation when a subpath is unnecessary.

Explicitly state that a stripping proxy is not a substitute: the HTML response can reach Bobbit while root-absolute browser asset requests bypass the proxy location entirely.

## 12. Test plan and registration

All new tests are registered individually in `tests2/tests-map.json` under `v2Native` with a precise `reason` and `execution` object. Re-run `node scripts/testing-v2/gen-inventory.mjs` only if required by the repository's census workflow, preserving the explicit v2-native entries.

### 12.1 Focused unit tests

Recommended files and ownership:

| Test | Project | Coverage |
|---|---|---|
| `tests2/core/base-path.test.ts` | `core` | normalization/root equivalence; nested segments; every rejected unsafe form; exact strip boundary; join/query round-trip; strip-once behavior; opaque route/public-path ownership; bases named `/api`, `/preview`, and `/ws` compose without false double-prefix rejection |
| `tests2/core/base-path-http.test.ts` | `core` | SPA marker/rewrite, quote styles, external/protocol-relative exclusions, identity root mode; manifest start/scope/icons/token behavior; preview `Location`/`<base>` public-path conversion |
| `tests2/core/base-path-browser-boundary.test.ts` | `core` or isolated `dom` | runtime app prefix; `normalizeGatewayBaseUrl` accepted/canonical/rejected matrix (including raw backslash/control/dot input) and typed codes; explicit stored precedence; invalid-storage token clearing/fallback warning; failed-candidate rollback; post-auth commit timing/storage failure with the active in-memory pair retained across fetch/WS/SSE/preview resolution; remote prefixed HTTP/WS; opaque type/decoder no-double-prefix contract; localhost vs real auth; same-host vs cross-site native-transport compatibility |
| `tests2/core/base-path-preview-contract.test.ts` | `core`/`dom` | API/SSE/workspace `url` remains `/preview/...`; DOM resolver applies explicit gateway base once; historical root/mounted/absolute URL-only parser and invalid lookalikes |
| `tests2/core/base-path-cli.test.ts` | `core` | environment default, CLI-over-env including invalid env overridden by valid flag, `--base-path /` and explicit empty CLI root override, missing value, selected unsafe env/flag failures, `StartupUrls`, tokenized/non-tokenized banner, wildcard peer URL, actual-port substitution |
| `tests2/core/base-path-pwa-cookie-guards.test.ts` | `core` | cookie `Path`; duplicate-name root/mounted cookies in both orders and verified-value extraction; credentialed CORS/native transport contract; service-worker source/runtime invariants; cache namespace isolation; no raw pathname API bypass; client source guards; root compatibility |
| `tests2/core/base-path-vite-proxy.test.ts` | `core` | target-path request joining for HTTP/WS; response Location/cookie/manifest and injected preview `<base>` rebasing; JSON/SSE route identity; root target identity |
| `tests2/core/base-path-watchdog.test.ts` | `core` | forwarded CLI/env/root precedence including invalid env overridden by valid flag; invalid selected startup config; automatic generation-aware persisted-target polling/refresh as one record; stale-file recovery; mounted health path |

Pure helpers should be exported from small modules rather than tested by source regex where behavior can be invoked. Source inspection remains appropriate for the non-importable service worker, repository-wide regression guards, and emitted bundle assertion.

### 12.2 Actual CLI/startup and watchdog integration

Add isolated `tests2/integration/base-path-cli-startup.test.ts`; helper-only tests are not sufficient. Refactor the production entry into exported `runCli(argv, env, effects)` while keeping `cli.ts`'s executable guard as the sole caller in production. Only OS effects (stdout/stderr, opener, gateway factory, exit) are injectable. The test invokes this same `runCli` path and asserts the object received by the gateway factory contains the canonical `GatewayConfig.basePath`, then lets its listener report an actual ephemeral port and verifies the same mount in `Listening`, UI/open, `peerUrl`, and the atomically persisted `state/gateway-url`.

The matrix covers: env only; CLI over env; valid CLI over an invalid env; CLI `""` and `/` overriding a non-root env to root; missing `--base-path` value; next-token-is-an-option; selected invalid env; invalid flag. Configuration errors must occur before scaffolding/token generation/gateway construction/open and produce exit 1. A focused subprocess smoke (`node --import tsx src/server/cli.ts` in an isolated project/state dir, loopback, ephemeral port, no TLS/UI) starts the actual executable, reads its mounted listening URL/state file, probes the mounted health route, verifies unprefixed 404, then terminates cleanly. This catches a production executable guard or wiring regression that an injected factory could miss.

Startup assertions cover loopback without `--auth` (no displayed token, no token query/secrecy warning, explicit disabled-auth message), loopback with `--auth`, and non-loopback (tokenized/protected message). Capture the injected opener to assert its exact mounted URL; assert wildcard bind yields a mounted loopback `peerUrl`. At the callback-setup and first restored-session spawn invocations, assert the complete mounted `gateway-url` already exists and equals the passed `peerUrl`; include persisted-session startup with port `0` to pin the bind → `onBound` → restore ordering. Separately fault-inject the `onBound` temporary-write/rename step to pin atomic replacement, cleanup, listener close, and zero agent launches. The browser/DOM QR test must invoke the real `showQrCodeDialog` and inspect its generated mobile, CA-cert, and copied/session URLs; a pure builder test is supplemental, not a substitute. Cover real-token and localhost-sentinel variants.

Add isolated watchdog behavior to the same file or `tests2/integration/base-path-watchdog.test.ts`: launch a tiny HTTP listener that records paths, snapshot stale `gateway-url`, start the real watchdog launch/poll loop with an injected clock/child seam, and let the simulated CLI atomically replace the file with a different actual port/nested path. Advance only the production timers—do not call refresh manually—and assert the loop automatically adopts the new generation, only the persisted nested `/api/health` makes the policy healthy, and unchanged/invalid/missing state retains the complete pre-launch target.

### 12.3 In-process gateway integration

Add `tests2/integration/base-path-gateway.test.ts`. Register it in the isolated Vitest project because it owns process-global gateway/path state and a listener. Use an isolated temporary state/static directory and explicit `GatewayDeps`; shut the gateway down and remove all state.

Drive the real `createGateway` and assert:

- nested mounted API succeeds with auth;
- `/`, unprefixed `/api/health`, `/bobbit-other`, and other off-mount paths return 404;
- `/team/bobbit?x=1` returns 301 to `/team/bobbit/?x=1`;
- static asset bytes are served below the mount;
- `/team/bobbit/session/<id>` receives the rewritten SPA fallback and stamped prefix;
- manifest plain/tokenized start URL, scope, and icons are prefixed;
- browser-shaped API auth mints `Path=/team/bobbit/`;
- mounted preview redirect, entry redirect, and injected live/artifact `<base>` are prefixed;
- POST mount, GET snapshot, artifact restore, SSE bootstrap, and a subsequent live `preview-changed` event each return `url: "/preview/..."` (never `/team/bobbit/preview/...`), while traversal/auth failures are unchanged;
- resolving each returned route against `https://host/team/bobbit` produces one and only one mounted request;
- mounted viewer and real session WebSocket upgrades authenticate; unprefixed and sibling upgrades fail; and
- a root-configured instance retains existing routes, shell bytes, manifest, route-shaped preview payloads, cookie path, and sockets.

### 12.4 Production browser journey

Add `tests2/browser/journeys/base-path-mounting.journey.spec.ts` to the normal `browser-v2` project, not the real-agent/manual lane. Extend `tests/e2e/gateway-harness.ts` with an optional worker-scoped `basePath` option; when set, pass it to `GatewayConfig`, include it in `GatewayInfo.baseURL`/`wsBase`/persisted gateway URL, and keep an origin-only value for deliberate off-mount probes. Existing workers default to `""`.

The journey uses `/team/bobbit` and the production `dist/ui` already guaranteed by browser global setup. It must:

1. navigate to the mounted shell and verify emitted JS/CSS/icon requests stay inside the prefix;
2. exercise an API-backed screen and observe the live viewer socket;
3. create/connect a session and observe session socket activity;
4. navigate to a lazy route and verify its chunk/preload request stays mounted;
5. load `/team/bobbit/session/<id>`, reload, and verify canonicalization to `/team/bobbit/#/session/<id>`;
6. mount an HTML preview with a sibling asset, verify the iframe, its injected base, and a popout/new-tab URL;
7. inspect the mount API and one SSE bootstrap/live event and assert their raw `url` fields start with `/preview/`, then assert the iframe/popout request contains `/team/bobbit/preview/` exactly once;
8. persist an explicit gateway URL that already contains `/team/bobbit`, reload, and assert there is no doubled prefix;
9. open QR/share UI and assert mobile, certificate, copied session path, and hash links retain `/team/bobbit` and omit a localhost token query;
10. assert origin `/`, unprefixed API, and a shared-string sibling return 404 without navigating the app away;
11. capture request headers while the sentinel is stored and verify no `Authorization: Bearer localhost`; and
12. delete every created session/goal/project/preview state through fixture cleanup.

Also read the freshly built `dist/ui/assets/*.js` in this journey (or a sibling browser test) and fail on Vite's root-anchoring assets/preload helper. This makes the assertion run only after the content-addressed production build is current.

### 12.5 Explicit distinct-origin browser journey

Add `tests2/browser/journeys/explicit-gateway-base-path.journey.spec.ts` with two HTTP origins on the same normalized hostname: a root UI origin and a gateway on another ephemeral port mounted at `/team/gw`. Store `gateway.url` with that pathname and a real token before app initialization. Assert:

1. direct REST requests include the remote origin/path exactly once, use `credentials: include`, and bootstrap the remote mount-scoped signed cookie through credentialed exact-origin CORS even when an invalid `bobbit_session` cookie already exists at `Path=/`; repeat/inspect auth with both cookie header orders;
2. viewer/session WebSockets use the remote origin and retain `/team/gw`;
3. mount GET/POST and raw SSE events return internal `/preview/...` routes;
4. native EventSource connects to the explicit remote `/team/gw/api/...` with credentials;
5. iframe, sibling asset, and popout navigate to the explicit remote `/team/gw/preview/...` once and authenticate by the signed cookie; and
6. no REST, SSE, WS, iframe, or popout request falls back to the UI origin.

A companion case uses a different hostname alias, completes an authenticated REST request and viewer/session WebSocket round trip at the prefixed gateway, and verifies the app shows the documented preview-transport compatibility message without starting EventSource/iframe/popout. This pins the boundary rather than accidentally depending on third-party-cookie behavior. A root-Vite-to-mounted-gateway proxy test separately asserts raw JSON/SSE/workspace routes stay `/preview/...` while redirect and injected `<base>` are rebased to `/preview/...`.

### 12.6 Commands

Implementation verification order:

```bash
npm run check
npx vitest run --config vitest.config.ts tests2/core/base-path.test.ts tests2/core/base-path-http.test.ts tests2/core/base-path-browser-boundary.test.ts tests2/core/base-path-preview-contract.test.ts tests2/core/base-path-cli.test.ts tests2/core/base-path-pwa-cookie-guards.test.ts tests2/core/base-path-vite-proxy.test.ts tests2/core/base-path-watchdog.test.ts tests2/integration/base-path-cli-startup.test.ts tests2/integration/base-path-watchdog.test.ts tests2/integration/base-path-gateway.test.ts
npm run build
npx playwright test --config playwright-v2.config.ts --project browser-v2 tests2/browser/journeys/base-path-mounting.journey.spec.ts tests2/browser/journeys/explicit-gateway-base-path.journey.spec.ts
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
| Prefix applied twice | API/SSE/workspace preview data is decoded as opaque `GatewayRoute`; resolvers output distinct public types that cannot be fed back; producer-boundary tests pin the wire shape |
| Prefix lost after initial probe | persist `origin + runtimeBasePath` only after success; source guard rejects bare-origin fallback |
| Lazy chunks escape to `/assets` | runtime `renderBuiltUrl`; inspect emitted JS and browser network |
| Path-style reload resolves relative assets incorrectly | keep HTML assets root-absolute until response rewrite; do not use global `./` build base |
| Off-mount request reaches auth/static fallback | reject before all handlers at HTTP/WS boundary |
| Preview asset escapes mount | only direct `Location`/`<base>` and DOM sinks become public; retain path guard and stable-directory fencing |
| Preview cookie reaches sibling apps | cookie `Path=<base>/` |
| Reverse proxy rejects fake Bearer | centralized auth helper omits localhost sentinel |
| Explicit remote prefixed gateway duplicates UI mount | stored URL wins; preview payload remains `/preview/...`; gateway helpers append only that route |
| Invalid stored gateway leaks token/fails boot | strict typed normalization; clear URL+token before fallback; new candidates commit only after auth; one active in-memory pair drives all transports when storage fails |
| Restored agent sees stale callback URL | bind behind readiness gate, persist/install peer URL in required `onBound`, restore sessions only afterward |
| Root cookie shadows mounted cookie | collect duplicate names and accept/extract a value only after current-store verification |
| Cross-site native preview silently fails | full support is bounded to same-scheme/same-host origins; incompatible hosts keep REST/WS but block native transports with an actionable message |
| Mounted gateway appears dead to watchdog | generation-aware automatic file polling adopts the full configured/persisted target; test the real loop and health request |
| Vite ignores target pathname | shared request join for HTTP and WS; translate response path/cookie/manifest and injected preview `<base>`, never route-shaped JSON/SSE |
| Service worker caches API or sibling app | mount-relative bypass, within-mount check, per-mount cache namespace/deletion |
| Stale service worker/build | existing build ID/no-cache retained; mounted offline fallback and precache re-anchored |
| Prefix treated as authentication | documentation: base path is routing isolation only; existing Bobbit/proxy auth remains mandatory off loopback |

## 14. Low-conflict implementation partition

The work can be split after agreeing on the interfaces in sections 2 and 5:

1. **Gateway/foundation owner**

   `src/shared/base-path.ts`, `src/shared/preview-bridge-scripts.ts`, `src/server/base-path-http.ts`, `src/server/server.ts`, `src/server/cli.ts`, `src/server/watchdog.ts`, `src/server/auth/cookie.ts`, `src/server/auth/browser-cookie.ts`, `src/server/preview/content-route.ts`, and `docs/networking.md`. This owner alone edits `server.ts`, including HTTP/WS stripping, manifest/static rewrite wiring, route-shaped preview payload preservation, direct preview `Location`/`<base>`, credentialed compatible-origin CORS, and banner/advertised URLs.

2. **Browser boundary/audit owner**

   `src/app/gateway-fetch.ts`, `main.ts`, `api.ts`, `routing.ts`, `session-manager.ts`, `remote-agent.ts`, transport bridges, preview/render/side-panel files, and every `src/ui` raw request/auth site listed in section 6. This owner first lands normalization/recovery and the central API, then converts sinks, native-transport compatibility, and historical preview parsers; it adds no production changes outside app/UI.

3. **Build/PWA/development-proxy owner**

   `index.html`, `public/sw.js`, and `vite.config.ts`. This owner implements the runtime build URL expression, per-mount worker caching, and Vite mounted-target request/response translation. Coordinate only the agreed global name `__BOBBIT_BASE_PATH__` and browser helper behavior.

4. **Test owner**

   New `tests2/core/*base-path*`, actual CLI/watchdog and gateway integration, mounted plus explicit-distinct-origin browser journeys, optional `basePath`/separate-origin fixture support in `tests/e2e/gateway-harness.ts`, and `tests2/tests-map.json`. This owner does not change production behavior to satisfy source-pattern tests; behavior tests remain primary.

To avoid merge conflicts, do not split `server.ts` preview/static/routing work between agents, do not split `gateway-fetch.ts` from its call-site audit, and make one owner responsible for the single `tests2/tests-map.json` registration batch.

## 15. Completion criteria

The feature is complete when the same `dist/ui` build runs at root and `/team/bobbit`; all REST, viewer/session WebSocket, lazy chunk, preview, PWA, link/reload, QR, agent callback, and watchdog traffic retains the selected mount; off-mount/sibling routes are rejected; API/SSE/workspace preview data remains mount-relative while every actual navigation is resolved once; an explicit prefixed same-host distinct-origin gateway passes REST/WS/SSE/iframe/popout coverage and an incompatible host fails at the documented native-transport boundary; the real CLI path proves precedence, wiring, startup/persistence/banner/open behavior; malformed stored bases recover without token leakage; Vite remains root-mounted while proxying to a mounted target; the localhost sentinel produces no Bearer header; root behavior is unchanged; and the unit, integration, production browser, full unit, and full browser gates pass.
