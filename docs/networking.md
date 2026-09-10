# Networking

By default, Bobbit binds to `localhost` for local-only access over HTTP. Pass `--nord` to bind to the NordLynx interface's IPv4 address with HTTPS, enabling remote access from devices on the NordVPN meshnet.

Binding decides which interfaces accept connections; request admission separately decides which authorities may address the gateway. Every HTTP request and WebSocket upgrade must use a configured authority, which prevents DNS rebinding and cross-site browser access even when the socket itself is reachable. See [Security — Request admission](security.md#request-admission) for the browser context and CORS policy.

## Request-admission configuration

The CLI builds a finite authority set from the actual selected port, the non-wildcard bind host, loopback aliases, configured TLS/deSEC names, the published gateway origin, and any explicit public origins. Wildcard listeners (`0.0.0.0` and `::`) open interfaces but never trust arbitrary hostnames.

Use a public origin whenever browsers address the gateway through a scheme, hostname, or port that the direct listener configuration does not already declare:

```bash
# TLS is terminated by a reverse proxy at https://bobbit.example.
# --auth makes the CLI print a tokenized bootstrap URL as well as enforcing auth.
bobbit --host 127.0.0.1 --port 3001 --no-tls --auth \
  --public-origin https://bobbit.example

# Shared-origin subpath deployment: the origin and mount are separate settings.
bobbit --host 127.0.0.1 --port 3001 --no-tls --auth \
  --public-origin https://tools.example --base-path /bobbit
```

`--public-origin <origin>` is repeatable. Alternatively, set `BOBBIT_PUBLIC_ORIGINS` to a comma-separated list. Supplying at least one command-line flag replaces the environment list; it does not append to it. A value is an origin only, such as `https://bobbit.example` or `https://bobbit.example:8443`: put a mount path in `--base-path`, not in the origin.

Values are normalized for DNS case, a single trailing dot, IPv4/IPv6 notation, and default ports. Startup fails on non-HTTP(S) schemes, credentials, wildcard hosts, paths other than `/`, queries, fragments, whitespace, malformed IP literals, or invalid ports. Failing at startup is intentional: silently dropping an authority could leave some routes unreachable, while accepting an ambiguous value could weaken the Host boundary.

Programmatic gateway construction has equivalent finite inputs:

- `GatewayConfig.publicOrigins` declares externally visible origins.
- `GatewayConfig.tlsHostnames` declares finite names covered by direct TLS. Bobbit does not inspect a certificate to infer them.
- `GatewayConfig.onBound` may publish one authoritative mounted URL after the actual port is known. Its origin is admitted, and its path must exactly match `GatewayConfig.basePath`.
- `GatewayConfig.viteOrigins` declares browser-visible Vite development origins. It is not a general cross-origin allowlist.

Any non-loopback authority disables the credential-free localhost policy for the whole gateway. Preserve the normal bearer/signed-cookie boundary in public and proxied deployments; an originless CLI or agent request still needs a trusted `Host` and the applicable credential.

### Vite development origin

Vite is the one supported cross-origin development path: the browser talks to Vite while Vite proxies API, preview, and WebSocket requests to a trusted gateway authority. Bobbit admits only an exact configured Vite-origin-to-gateway pair; arbitrary localhost ports and origins are not inferred.

The standard `npm run dev`, `npm run dev:harness`, and `npm run dev:watchdog` launchers derive `http://<VITE_HOST-or-localhost>:5173`. The Nord development launcher derives the finite HTTPS origins for its configured mesh IP and deSEC hostname. For a custom host, scheme, or port, use repeatable `--vite-origin <origin>` values or the comma-separated `BOBBIT_VITE_ORIGINS` environment variable. As with public origins, command-line values replace the environment list, invalid values stop startup, and a wildcard `VITE_HOST` is never converted into a trusted browser origin.

Do not use `--vite-origin` to expose a production website. The exception allows only that browser origin when Vite has rewritten `Host` to an already trusted gateway authority; it does not make the Vite hostname a general gateway `Host`.

## Port topology in dev mode

- **Vite** (`:5173`) — serves the UI with HMR and proxies `/api/*` and `/ws/*` to the gateway.
- **Gateway** (`:3001`) — serves the REST API and WebSocket sessions and manages agent subprocesses.

The standard `npm run dev`, `npm run dev:harness`, and
`npm run dev:watchdog` paths use HTTP for both processes. `npm run dev:nord`
pre-provisions the certificate and uses HTTPS for both. In production
(`npm start`), there is no Vite; the gateway serves the bundled UI directly on
`:3001`, with the listener's configured HTTP or HTTPS scheme.

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

An explicit cross-origin gateway can use a real token for REST and WebSocket
traffic. The browser UI enables native preview transports—iframes, popouts, and
live preview events—only when its configured gateway URL has the page's exact
scheme, hostname, and port. This client capability check is separate from
server request admission. In Vite development, the browser still uses its own
same-origin proxy URLs while the gateway admits only the configured finite
Vite-origin-to-upstream pair. For other remote UIs, put the gateway behind the
UI's origin when preview transports are needed.

### Reverse proxy configuration

Declare the browser-visible origin with `--public-origin`, preserve that external `Host`, and forward the full prefix unchanged for HTTP and WebSocket requests. Bobbit intentionally ignores `Forwarded` and `X-Forwarded-*`; those headers cannot repair a rewritten or untrusted `Host`.

For example, start the upstream for `https://tools.example/bobbit` with:

```bash
bobbit --host 127.0.0.1 --port 3001 --no-tls --auth \
  --public-origin https://tools.example --base-path /bobbit
```

Then retain the public authority and mount in nginx:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    server_name tools.example;

    # Keep this exact location so Bobbit performs its query-preserving redirect.
    location = /bobbit {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }

    location ^~ /bobbit/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

`$http_host` retains an explicit public port when one is present. That port must also appear in `--public-origin`. Ensure the virtual host rejects unknown server names rather than forwarding them to Bobbit.

For `/team/bobbit`, replace both nginx location paths and start Bobbit with `--base-path /team/bobbit`. Do not add a URI such as `/` to `proxy_pass`; that form strips the mount before the request reaches Bobbit.

A path-stripping proxy is not a substitute for base-path support. Without `--base-path`, the root-built shell, manifest, service worker, and lazy chunks still produce browser requests such as `/assets/...` and `/sw.js`. Those requests bypass a `/bobbit/` proxy location entirely, so rewriting only the initial HTML request cannot make the application mount-safe. If sharing an origin path is unnecessary, use a dedicated subdomain; it is the simpler recommended deployment.

Forwarded headers do not change the configured mount, participate in request admission, or replace the persisted peer URL with a public proxy origin. Programmatic deployments that need agents and extensions to use a public origin should return that origin from `onBound`, while retaining the configured mount path. Browser same-origin fallback already uses the public page origin and mount.

### Authentication, cookies, and OAuth proxies

A genuinely all-loopback policy does not enforce Bobbit token authentication unless `--auth` is set. The unauthenticated startup banner does not print the generated token or secrecy warning. `--auth`, a non-loopback bind, or any declared non-loopback public/published/TLS/Vite authority disables that bypass. For a loopback backend exposed by a proxy, pass `--auth` explicitly so the banner and launch URL make the effective token requirement clear.

The browser may store `localhost` as a local-connection sentinel. It is never emitted as `Authorization: Bearer localhost`. A public deployment cannot use that sentinel or a proxy cookie as a substitute for Bobbit authorization: bootstrap the browser through the public mounted URL with the real Bobbit token. HTTP requests then send real Bobbit bearer credentials unchanged, while Bobbit's signed cookie supports eligible same-origin browser and preview flows.

For `oauth2-proxy` or a similar front end:

1. Bind Bobbit to loopback with `--auth`, declare `--public-origin`, and keep the upstream unreachable except through the proxy.
2. Protect both the exact bare-prefix location and every descendant, including WebSocket upgrades.
3. Preserve the external `Host`; do not rely on `Forwarded` or `X-Forwarded-*` for admission.
4. Bootstrap Bobbit with its real token after satisfying the proxy login. Clients must continue satisfying both authorization layers.
5. Configure the proxy's cookie domain, path, `Secure`, and `SameSite` attributes for the public mount.

Bobbit's signed browser cookie is separate from the proxy's cookie. Its `Path` is `/` in root mode and `<mount>/` otherwise, such as `/bobbit/`, so sibling applications do not receive it. Same-origin API requests use normal browser cookie credentials; preview events explicitly use credentials. The manifest link also uses `crossOrigin = "use-credentials"`, including on the same origin, because an OAuth proxy may require its cookie before serving the manifest.

### PWA, previews, and Vite development

Mounted production behavior includes:

- manifest `start_url`, `scope`, and root-absolute icons below the mount; a valid real token may be embedded in the mounted `start_url`;
- service-worker script and scope below the mount, with per-mount caches, mounted precache entries and offline navigation fallback, and mount-relative API/WebSocket cache bypasses;
- preview iframe and popout URLs, redirects, artifact URLs, and the injected preview `<base>` below the mount; and
- a mount-scoped signed cookie so preview documents can authenticate without an `Authorization` header.

Vite development deliberately remains root-mounted at its own origin. On each proxied request it reads the discovered gateway target, including any pathname in `state/gateway-url` or `GATEWAY_URL`, and joins root Vite `/api`, `/ws`, `/manifest.json`, and `/preview` requests to that mounted target. It rebases same-gateway redirects, cookie paths, manifest fields, and Bobbit's injected preview base back to the root-mounted development UI. The exact Vite origin must be present when the gateway compiles admission; do not browse to the gateway's production mount through the Vite port or assume a later random Vite port will be accepted.

### Subpath troubleshooting

- **The origin root or unprefixed API returns 404:** expected for a mounted gateway. Open the configured prefix with its trailing slash.
- **The bare prefix does not redirect:** ensure the proxy forwards `/bobbit` unchanged and routes the exact location to Bobbit instead of redirecting or stripping it itself.
- **Requests escape to `/assets`, `/api`, `/ws`, `/preview`, `/manifest.json`, or `/sw.js`:** verify the active base-path setting and proxy, then close old root-mounted tabs and unregister any obsolete service worker.
- **The shell loads but API or sockets fail:** confirm the proxy preserves the public `Host`, forwards normal HTTP and Upgrade requests with the prefix intact, and does not match a sibling prefix accidentally. A `403` with a `[security] request admission rejected` log usually means the public or Vite origin is undeclared or mismatched; a `401` means admission passed and authentication failed.
- **A copied session link fails only after reload:** route every path below the mount to Bobbit's SPA fallback; do not apply a proxy-side file existence check.
- **The PWA launches at `/` or shows old assets:** inspect the served manifest and worker URL for the mount, then unregister the old worker and clear its site data before reinstalling.
- **Previews are unavailable with an explicit gateway:** compare scheme, hostname, and port. Use a same-origin proxy; matching only the hostname is insufficient.
- **An OAuth-protected manifest or preview returns 401:** verify both the proxy cookie and Bobbit token/cookie, ensure they cover the mount, and apply the same authentication policy to both proxy locations.
- **`state/gateway-url` has the wrong origin or path:** restart with the intended base path. For an embedded gateway behind a public proxy, return the public origin plus the same configured mount from `onBound`; a differing callback path is rejected.

## Dynamic DNS

**deSEC dynamic DNS**: On startup, the gateway updates a deSEC A record so a custom domain (e.g. `bobbit.dedyn.io`) resolves to the current mesh IP. Config stored in `.bobbit/state/desec.json`. Skipped for loopback addresses to avoid clobbering the record during tests.

## TLS

TLS is on by default for non-loopback addresses; disabled for localhost to avoid self-signed certificate warnings. Pass `--tls` to force TLS on localhost. Certs are generated via mkcert (local CA) or openssl fallback. The cert covers the current host IP + localhost and regenerates automatically if the IP changes. Vite reuses the same cert.

## QR Code

The session QR encodes the selected gateway base URL, including its mounted prefix, and appends a real Bobbit auth token when one is configured. The client-only `localhost` sentinel is omitted. The QR is scannable from any device on the NordVPN mesh.

See [dev-workflow.md](dev-workflow.md) for the full networking reference, troubleshooting, and local-only setup.
