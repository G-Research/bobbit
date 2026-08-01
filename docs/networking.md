# Networking

By default, Bobbit binds to `localhost` for local-only access (HTTP). Pass `--nord` to bind to the NordLynx interface's IPv4 address with HTTPS, enabling remote access from any device on the NordVPN meshnet.

## Port topology in dev mode

- **Vite** (`:5173`) — User-facing HTTPS, serves UI with HMR, proxies `/api/*` and `/ws/*` to the gateway
- **Gateway** (`:3001`) — HTTPS, REST API, WebSocket sessions, agent subprocess management

In production (`npm start`), the gateway serves the bundled UI directly on `:3001`.

## Production subpath mounting

A production gateway and its bundled UI can share an origin with another app:

```bash
bobbit --base-path /bobbit
# equivalent default from the environment
BOBBIT_BASE_PATH=/bobbit bobbit
```

Nested prefixes such as `/team/bobbit` are supported. The CLI flag takes precedence over `BOBBIT_BASE_PATH`. Omitting the setting, passing an empty value, or passing `/` keeps the default root mount. Bobbit adds a missing leading slash and removes trailing slashes, so `bobbit/` becomes `/bobbit`. It rejects URL schemes or authorities, query strings, fragments, percent escapes, backslashes, whitespace, repeated separators, dot segments, and characters outside URL-unreserved path segments.

The configured prefix is part of every public gateway URL, WebSocket route, manifest and service-worker scope, preview URL, and browser-session cookie path. The bare prefix redirects permanently to its slash form while preserving the query string; for example, `/bobbit?x=1` redirects to `/bobbit/?x=1`. Routes outside the exact mount, including `/`, `/api/*`, and lookalikes such as `/bobbit-other`, return 404.

A reverse proxy must forward the prefix unchanged. For nginx:

```nginx
location = /bobbit {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /bobbit/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Do not add a trailing path to `proxy_pass` that strips `/bobbit`. A path-stripping proxy is not a substitute for `--base-path`: root-absolute browser assets and lazy chunks are requested directly from `/assets/...`, outside the proxy location, before the proxy can rewrite them. When sharing a path is unnecessary, a dedicated subdomain is simpler and remains the recommended deployment.

For an authentication proxy such as `oauth2-proxy`, leave Bobbit loopback-bound without `--auth` and protect the public proxy location. The stored `localhost` connection value is only a client sentinel and is not sent as a Bearer credential, allowing the proxy's cookie authentication to operate normally. Use `--auth` when Bobbit itself must enforce its token; non-loopback binds enforce token authentication automatically. The startup banner states which mode is active.

### Subpath troubleshooting

- A 404 at the origin root or an unprefixed API route is expected; open the configured prefix with its trailing slash.
- Requests escaping to `/assets`, `/api`, `/ws`, `/preview`, `/manifest.json`, or `/sw.js` usually mean the proxy stripped the prefix or an old root-mounted shell/service worker is still open. Correct the proxy, close old tabs, and unregister the obsolete worker before retrying.
- If the UI loads but API or WebSocket calls fail, verify that the proxy forwards both HTTP and Upgrade requests with the prefix intact.
- If a copied deep link fails only after reload, ensure the proxy sends every path below the mount to Bobbit rather than applying its own file lookup.

## Dynamic DNS

**deSEC dynamic DNS**: On startup, the gateway updates a deSEC A record so a custom domain (e.g. `bobbit.dedyn.io`) resolves to the current mesh IP. Config stored in `.bobbit/state/desec.json`. Skipped for loopback addresses to avoid clobbering the record during tests.

## TLS

TLS is on by default for non-loopback addresses; disabled for localhost to avoid self-signed certificate warnings. Pass `--tls` to force TLS on localhost. Certs are generated via mkcert (local CA) or openssl fallback. The cert covers the current host IP + localhost and regenerates automatically if the IP changes. Vite reuses the same cert.

## QR Code

Encodes `window.location.origin` + auth token. Scannable from any device on the NordVPN mesh.

See [dev-workflow.md](dev-workflow.md) for the full networking reference, troubleshooting, and local-only setup.
