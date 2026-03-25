# Networking

By default, Bobbit binds to `localhost` for local-only access (HTTP). Pass `--nord` to bind to the NordLynx interface's IPv4 address with HTTPS, enabling remote access from any device on the NordVPN meshnet.

## Port topology in dev mode

- **Vite** (`:5173`) — User-facing HTTPS, serves UI with HMR, proxies `/api/*` and `/ws/*` to the gateway
- **Gateway** (`:3001`) — HTTPS, REST API, WebSocket sessions, agent subprocess management

In production (`npm start`), the gateway serves the bundled UI directly on `:3001`.

## Dynamic DNS

**deSEC dynamic DNS**: On startup, the gateway updates a deSEC A record so a custom domain (e.g. `bobbit.dedyn.io`) resolves to the current mesh IP. Config stored in `.bobbit/state/desec.json`. Skipped for loopback addresses to avoid clobbering the record during tests.

## TLS

TLS is on by default for non-loopback addresses; disabled for localhost to avoid self-signed certificate warnings. Pass `--tls` to force TLS on localhost. Certs are generated via mkcert (local CA) or openssl fallback. The cert covers the current host IP + localhost and regenerates automatically if the IP changes. Vite reuses the same cert.

## QR Code

Encodes `window.location.origin` + auth token. Scannable from any device on the NordVPN mesh.

See [dev-workflow.md](dev-workflow.md) for the full networking reference, troubleshooting, and local-only setup.
