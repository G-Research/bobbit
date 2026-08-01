# Networking

By default, Bobbit binds to `localhost` for local-only access (HTTP). Pass `--nord` to bind to the NordLynx interface's IPv4 address with HTTPS, enabling remote access from any device on the NordVPN meshnet.

## Port topology in dev mode

- **Vite** (`:5173`) — User-facing HTTPS, serves UI with HMR, proxies `/api/*` and `/ws/*` to the gateway
- **Gateway** (`:3001`) — HTTPS, REST API, WebSocket sessions, agent subprocess management

In production (`npm start`), the gateway serves the bundled UI directly on `:3001`.

## Production subpath mounting

A production gateway and its bundled UI can share an origin with another app. The mount is a routing and browser-asset boundary, not just a proxy alias: Bobbit uses it for HTTP, WebSocket, PWA, preview, and client-generated URLs.

### Configure and normalize the mount

Set the mount at gateway startup:

```bash
bobbit --base-path /bobbit

# Used only when --base-path is absent
BOBBIT_BASE_PATH=/team/bobbit bobbit
```

`--base-path` takes precedence over `BOBBIT_BASE_PATH`; if repeated, the last flag wins. An explicit empty value or `/` overrides a non-root environment value and selects the default root mount.

Bobbit canonicalizes the selected value once:

- missing, empty, and `/` become the root mount;
- surrounding whitespace is trimmed;
- a missing leading slash is added; and
- trailing slashes are removed.

For example, `team/bobbit/` becomes `/team/bobbit`. Each non-root segment may contain only URL-unreserved ASCII characters: letters, digits, `-`, `.`, `_`, and `~`. Bobbit rejects URL schemes and authorities, queries, fragments, percent escapes, backslashes, embedded whitespace or control characters, repeated separators, `.` or `..` segments, and non-ASCII characters. Invalid input stops startup rather than producing ambiguous URLs.

### Exact mount routing

For a `/bobbit` mount:

- `/bobbit` redirects with 301 to `/bobbit/`; its query string is retained, so `/bobbit?x=1` becomes `/bobbit/?x=1`.
- `/bobbit/`, `/bobbit/api/*`, `/bobbit/ws/*`, `/bobbit/preview/*`, static assets, and SPA deep links are handled below the mount.
- `/`, `/api/*`, `/bobbit-other`, and every other off-mount path return 404. WebSocket upgrades use the same segment boundary and reject off-mount paths.
- The gateway strips the prefix exactly once. Internal API and preview routes remain mount-relative, which prevents accidental double-prefixing.

Nested mounts such as `/team/bobbit` behave the same way. Root mode retains the existing `/api/*`, `/ws/*`, `/preview/*`, and bundled-UI behavior.

The production gateway stamps the active mount into the SPA shell before loading assets, then re-anchors shell assets and lazy/module-preload chunks at runtime. One production build can therefore run at `/`, `/bobbit`, or a nested mount without rebuilding. Hash routes stay below the mount, for example `/bobbit/#/session/<id>`. A copied path-style session link such as `/bobbit/session/<id>` can be loaded directly and is canonicalized to the mounted hash URL.

### Advertised and selected gateway URLs

The canonical mount is retained across every gateway URL boundary:

- **Startup and auto-open:** the listening URL, connectable peer URL, tokenized launch URL when authentication is enforced, and browser auto-open URL include the mount and actual bound port. The peer used for local callbacks translates wildcard listener addresses to connectable loopback addresses instead of using `0.0.0.0` or `::`.
- **Agents and extensions:** the gateway atomically replaces `state/gateway-url` with the published HTTP(S) base, including the mount, before restoring persisted sessions. Stale root-mounted values are not reused.
- **Programmatic gateways:** `GatewayConfig.onBound` may return an authoritative public HTTP(S) base with a different scheme, host, or port. Its normalized path must exactly match `GatewayConfig.basePath`. For example, a `/team/bobbit` gateway may publish `https://bobbit.example/team/bobbit/`, which is stored without the trailing slash; it may not publish `/other`. Invalid callbacks fail before agents or extensions resume.
- **Browser fallback:** when no gateway is stored, the UI uses its own origin plus the runtime mount. A successful local bootstrap persists that mounted base rather than dropping the prefix.
- **Explicit browser connection:** a URL entered in **Connect to Gateway** and stored as `gateway.url` is authoritative, including any existing prefix. Bobbit appends routes to it exactly once; it does not also add the UI's mount. Explicit bases must be absolute `http://` or `https://` URLs without credentials, query, or fragment, and their path follows the same safe segment grammar.
- **Links and QR codes:** UI session links and icons retain the runtime UI mount. Preview URLs and the session QR retain the selected gateway base and its prefix. Real Bobbit tokens are included where needed; the `localhost` sentinel is omitted from QR links.

An explicit cross-origin gateway can use a real token for REST and WebSocket traffic. Cookie-only browser transports—preview iframes, preview popouts, and live preview events—require the UI and gateway to have the exact same scheme, hostname, and port. Put the remote gateway behind the UI's origin when those features are needed.

### Reverse proxy configuration

The proxy must forward the full prefix unchanged for both HTTP and WebSocket requests. This nginx example keeps `/bobbit` on the upstream request:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    # Keep this exact location so Bobbit performs its query-preserving redirect.
    location = /bobbit {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }

    location ^~ /bobbit/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

For `/team/bobbit`, replace both nginx location paths and start Bobbit with `--base-path /team/bobbit`. Do not add a URI such as `/` to `proxy_pass`; that form strips the mount before the request reaches Bobbit.

A path-stripping proxy is not a substitute for base-path support. Without `--base-path`, the root-built shell, manifest, service worker, and lazy chunks still produce browser requests such as `/assets/...` and `/sw.js`. Those requests bypass a `/bobbit/` proxy location entirely, so rewriting only the initial HTML request cannot make the application mount-safe. If sharing an origin path is unnecessary, use a dedicated subdomain; it is the simpler recommended deployment.

Forwarded headers do not change the configured mount or automatically replace the persisted peer URL with a public proxy origin. Programmatic deployments that need agents and extensions to use a public origin should return that origin from `onBound`, while retaining the configured mount path. Browser same-origin fallback already uses the public page origin and mount.

### Authentication, cookies, and OAuth proxies

Loopback binds do not enforce Bobbit token authentication unless `--auth` is set. In that mode the startup banner says authentication is disabled and does not print the generated token or secrecy warning. `--auth` on loopback and all non-loopback binds enforce the real Bobbit token; the banner and launch URL then show the token and its warning.

The browser may store `localhost` as a local-connection sentinel. It is not emitted as `Authorization: Bearer localhost`, so a cookie-authenticating reverse proxy can evaluate the request normally. For HTTP requests, real Bobbit tokens are sent unchanged as bearer credentials. If both an authentication proxy and Bobbit `--auth` are enabled, clients must satisfy both layers.

For `oauth2-proxy` or a similar front end:

1. Bind Bobbit to loopback without `--auth`.
2. Protect both the exact bare-prefix location and every descendant, including WebSocket upgrades.
3. Keep the upstream inaccessible except through the authenticating proxy.
4. Configure the proxy's own cookie domain, path, `Secure`, and `SameSite` attributes for the public mount.

Bobbit's signed browser cookie is separate from the proxy's cookie. Its `Path` is `/` in root mode and `<mount>/` otherwise, such as `/bobbit/`, so sibling applications do not receive it. Same-origin API requests use normal browser cookie credentials; preview events explicitly use credentials. The manifest link also uses `crossOrigin = "use-credentials"`, including on the same origin, because an OAuth proxy may require its cookie before serving the manifest.

### PWA, previews, and Vite development

Mounted production behavior includes:

- manifest `start_url`, `scope`, and root-absolute icons below the mount; a valid real token may be embedded in the mounted `start_url`;
- service-worker script and scope below the mount, with per-mount caches, mounted precache entries and offline navigation fallback, and mount-relative API/WebSocket cache bypasses;
- preview iframe and popout URLs, redirects, artifact URLs, and the injected preview `<base>` below the mount; and
- a mount-scoped signed cookie so preview documents can authenticate without an `Authorization` header.

Vite development deliberately remains root-mounted at its own origin. On each proxied request it reads the discovered gateway target, including any pathname in `state/gateway-url` or `GATEWAY_URL`, and joins root Vite `/api`, `/ws`, `/manifest.json`, and `/preview` requests to that mounted target. It rebases same-gateway redirects, cookie paths, manifest fields, and Bobbit's injected preview base back to the root-mounted development UI. Do not browse to the gateway's production mount through the Vite port.

### Subpath troubleshooting

- **The origin root or unprefixed API returns 404:** expected for a mounted gateway. Open the configured prefix with its trailing slash.
- **The bare prefix does not redirect:** ensure the proxy forwards `/bobbit` unchanged and routes the exact location to Bobbit instead of redirecting or stripping it itself.
- **Requests escape to `/assets`, `/api`, `/ws`, `/preview`, `/manifest.json`, or `/sw.js`:** verify the active base-path setting and proxy, then close old root-mounted tabs and unregister any obsolete service worker.
- **The shell loads but API or sockets fail:** confirm the proxy forwards both normal HTTP and Upgrade requests with the prefix intact and does not match a sibling prefix accidentally.
- **A copied session link fails only after reload:** route every path below the mount to Bobbit's SPA fallback; do not apply a proxy-side file existence check.
- **The PWA launches at `/` or shows old assets:** inspect the served manifest and worker URL for the mount, then unregister the old worker and clear its site data before reinstalling.
- **Previews are unavailable with an explicit gateway:** compare scheme, hostname, and port. Use a same-origin proxy; matching only the hostname is insufficient.
- **An OAuth-protected manifest or preview returns 401:** verify that the proxy cookie covers the mount, credentialed requests are allowed, and both proxy locations use the same authentication policy.
- **`state/gateway-url` has the wrong origin or path:** restart with the intended base path. For an embedded gateway behind a public proxy, return the public origin plus the same configured mount from `onBound`; a differing callback path is rejected.

## Dynamic DNS

**deSEC dynamic DNS**: On startup, the gateway updates a deSEC A record so a custom domain (e.g. `bobbit.dedyn.io`) resolves to the current mesh IP. Config stored in `.bobbit/state/desec.json`. Skipped for loopback addresses to avoid clobbering the record during tests.

## TLS

TLS is on by default for non-loopback addresses; disabled for localhost to avoid self-signed certificate warnings. Pass `--tls` to force TLS on localhost. Certs are generated via mkcert (local CA) or openssl fallback. The cert covers the current host IP + localhost and regenerates automatically if the IP changes. Vite reuses the same cert.

## QR Code

The session QR encodes the selected gateway base URL, including its mounted prefix, and appends a real Bobbit auth token when one is configured. The client-only `localhost` sentinel is omitted. The QR is scannable from any device on the NordVPN mesh.

See [dev-workflow.md](dev-workflow.md) for the full networking reference, troubleshooting, and local-only setup.
