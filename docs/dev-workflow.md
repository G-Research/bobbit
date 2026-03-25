# Development Workflow

How to run, develop, and deploy Bobbit. For project architecture and concepts see [README.md](../README.md). For agent-facing context (repo layout, key abstractions, common tasks) see [AGENTS.md](../AGENTS.md).

---

## Running modes

Bobbit has three runtime modes: **production**, **dev**, and **dev with harness**. The difference is how server-side TypeScript is compiled and how the UI is served.

### Production

```bash
npm run build   # compile server + bundle UI
npm start       # serve everything from dist/
```

The gateway serves the bundled UI from `dist/ui/` as static files. Everything runs from a single process (plus agent child processes). No hot reload — you must rebuild and restart to pick up changes.

### Dev (no harness)

```bash
npm run build:server   # required once before first run
npm run dev            # gateway + vite dev server
```

Runs two processes concurrently:

1. **Gateway** (`node dist/server/cli.js --cwd . --no-ui`) on port 3001 — handles REST API, WebSocket, and agent subprocesses.
2. **Vite** on port 5173 — serves the UI with hot module replacement. Proxies `/api` and `/ws` to the gateway.

UI changes (`src/ui/`, `src/app/`) hot-reload instantly in the browser. Server changes (`src/server/`) require manually rebuilding (`npm run build:server`) and restarting the gateway.

### Dev with harness (recommended)

```bash
npm run dev:harness
```

Same two-process setup, but the gateway is wrapped in a **restart harness** (`src/server/harness.ts`). The harness:

- Watches a sentinel file at `.bobbit/state/gateway-restart`
- On signal: kills the server, waits for the port to free, runs `npm run build:server`, relaunches
- Auto-restarts on unexpected crashes
- Sessions survive restarts (persisted to `.bobbit/state/sessions.json`)

To trigger a restart:

```bash
npm run restart-server
```

This touches the sentinel file. The harness picks it up within ~500ms (polled on Windows, `fs.watch` elsewhere) and begins the restart cycle.

---

## What changes require what

| What you changed | What to do |
|---|---|
| `src/ui/**` or `src/app/**` | Nothing — Vite hot-reloads automatically |
| `src/server/**` | Run `npm run restart-server` (if using harness) or manually `npm run build:server` + restart |
| `package.json` (new dependency) | `npm install`, then restart server |
| `vite.config.ts` | Restart Vite (kill and re-run `npm run dev:harness`) |
| `tsconfig.*.json` | Restart server; may need to restart Vite for web config changes |
| `.bobbit/config/system-prompt.md` | Restart server (the path is resolved at startup and passed to agents) |

**Rule of thumb**: UI is hot. Server is compiled. If you touched anything under `src/server/`, you need a rebuild + restart.

---

## For agents making changes

If you are an AI agent running inside a Bobbit session and you are modifying Bobbit itself:

### UI changes — no action needed

Edit files under `src/ui/` or `src/app/`. Vite picks up the changes and hot-reloads the browser. The user sees updates within seconds. No restart, no build command.

### Server changes — trigger a restart

After editing files under `src/server/`:

```bash
npm run restart-server
```

This signals the harness to rebuild and restart the server. Your current session will survive — the harness persists session metadata to disk, and on relaunch the server restores all sessions from `.bobbit/state/sessions.json`.

**Do not skip this step.** The gateway runs from compiled JavaScript in `dist/server/`. Your TypeScript edits under `src/server/` have no effect until the server is rebuilt.

### Verify your changes compiled

After `npm run restart-server`, watch for the harness output:

```
[harness] ======== RESTART TRIGGERED ========
[harness] Waiting for port 3001 to be free...
[harness] Building server...
[harness] Build complete.
[harness] Launching server (port 3001)...
```

If the build fails, the harness logs the error and attempts to launch the old build anyway. Fix the compilation error and run `npm run restart-server` again.

### Type-checking without restarting

To check both server and UI types without emitting or restarting:

```bash
npm run check
```

This runs `tsc --noEmit` against both `tsconfig.server.json` and `tsconfig.web.json`. Useful to catch errors before triggering a restart.

### Adding new files

New files under `src/server/` are automatically picked up by the next `npm run build:server` (triggered by the harness). No extra configuration needed — the TypeScript config includes all `.ts` files under `src/server/`.

New UI files need to be imported somewhere in the dependency graph (from `src/app/main.ts` or an existing component). Vite handles the rest.

---

## Build outputs

```
dist/
├── server/         # tsc output from src/server/ (Node16 ESM)
│   ├── cli.js      # gateway entry point
│   ├── harness.js  # dev server harness
│   └── agent/      # session manager, RPC bridge, stores
└── ui/             # vite bundle from src/ui/ + src/app/
    ├── index.html  # SPA entry
    └── assets/     # JS, CSS, fonts
```

Two independent build pipelines:

- **Server**: `tsc -p tsconfig.server.json` → `dist/server/`. Plain TypeScript compilation, no bundling.
- **UI**: `vite build` → `dist/ui/`. Bundles, minifies, tree-shakes. In dev mode, Vite serves directly from source with HMR.

---

## Networking architecture

Bobbit is designed for **remote access over a NordVPN mesh network**. The user runs the server on a dev machine and connects from other devices (laptop, tablet) via a mesh IP or a custom domain.

### Port topology (dev mode)

```
Browser (ProArt / phone / etc.)
  │
  │  https://yourname.dedyn.io:5173   ← user-facing URL
  │
  ▼
Vite dev server (:5173)             ← serves UI with HMR, HTTPS using gateway cert
  │  proxy /api/* ──────────────►  Gateway (:3001)  ← REST API + agent management
  │  proxy /ws/*  ──────────────►  Gateway (:3001)  ← WebSocket (session streaming)
  │
  └─ HMR websocket (:5173)         ← Vite's own hot-reload channel (same port)
```

In **production mode** (`npm start`), there is no Vite — the gateway serves the bundled UI directly on port 3001.

### Host binding

Both the gateway and Vite auto-detect the **NordLynx** (NordVPN mesh) interface IP and bind to it.

- **Gateway**: exits with an error if NordLynx isn't found, unless you pass `--host <addr>`
- **Vite**: falls back to `localhost` with a warning, or uses `VITE_HOST` env var

The detected mesh IP (e.g. `<mesh-ip>`) is what other mesh devices use to reach the server.

### deSEC dynamic DNS

On startup, the gateway updates a **deSEC** (dedyn.io) DNS A record so that `yourname.dedyn.io` points to the current mesh IP. Config lives at `.bobbit/state/desec.json`:

```json
{ "domain": "yourname.dedyn.io", "token": "<deSEC API token>" }
```

This means the user can always access `https://yourname.dedyn.io:5173` (dev) or `https://yourname.dedyn.io:3001` (prod) without memorizing mesh IPs, even when the IP changes across NordVPN reconnects.

**Important**: The deSEC update is skipped for loopback addresses (`127.0.0.1`, `::1`, `localhost`) to prevent E2E tests or local-only runs from clobbering the DNS record. If DNS points to `127.0.0.1`, a prior server start with `--host 127.0.0.1` likely caused it — restart the server normally (without `--host`) to push the correct mesh IP.

### TLS certificates

TLS is **on by default**. The server generates certificates on first run and stores them at:

| File | Purpose |
|---|---|
| `.bobbit/state/tls/cert.pem` | Server certificate (covers the host IP + `localhost`) |
| `.bobbit/state/tls/key.pem` | Server private key |
| `.bobbit/state/tls/ca.crt` | Local CA certificate (install on other devices to trust) |
| `.bobbit/state/tls/ca.key` | Local CA private key |

The cert is generated via **mkcert** (npm package) signed by the local CA, with fallback to openssl self-signed. Vite reuses the same cert/key for its HTTPS server (`vite.config.ts` reads them from disk).

To trust the cert on a remote device, install `.bobbit/state/tls/ca.crt` as a trusted CA.

If the cert doesn't cover the current host (e.g. the mesh IP changed), it is regenerated automatically on next startup.

### Troubleshooting connectivity

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERR_CONNECTION_REFUSED` on `:5173` | Vite not running, or not bound to mesh IP | Check `npm run dev:harness` output; verify NordVPN is connected |
| `ERR_CONNECTION_REFUSED` on `:3001` | Gateway not running | Same as above |
| WebSocket connects but session fails | Browser has wrong gateway URL in `localStorage` | Open DevTools console: `localStorage.getItem("gw-url")` — should match the gateway's actual address. Fix with `localStorage.setItem("gw-url", "<correct URL>")` and reload |
| DNS resolves to `127.0.0.1` | A prior `--host 127.0.0.1` run (e.g. E2E tests) pushed loopback to deSEC | Restart the server normally — it will push the mesh IP to deSEC. Flush DNS on the client device if cached |
| Vite HMR WebSocket error in console | Normal when accessing via domain/mesh IP — Vite's HMR can't always connect back | Harmless. Vite falls back to polling. The "Direct websocket connection fallback" message confirms this |
| `ERR_CERT_AUTHORITY_INVALID` | Remote device doesn't trust the local CA | Install `.bobbit/state/tls/ca.crt` on the device, or click through the browser warning |

### Local-only development (no NordVPN)

```bash
# Terminal 1: gateway on localhost
node dist/server/cli.js --host localhost --port 3001 --cwd . --no-ui --no-tls

# Terminal 2: vite on localhost
GATEWAY_NO_TLS=1 VITE_HOST=localhost npx vite
```

Or use the E2E test config which does this automatically:

```bash
npx playwright test --config playwright-e2e.config.ts
```

---

## Testing

```bash
npm test              # Mobile header Playwright tests (standalone)
npm run test:e2e      # E2E integration tests (starts gateway + vite on localhost)
```

E2E tests use `playwright-e2e.config.ts` (at the project root) which starts a sandboxed gateway on localhost automatically. Tests run against the real system — creating sessions, sending prompts, verifying UI behavior.

---

## Related docs

- **[README.md](../README.md)** — Architecture overview, quick start, CLI flags
- **[REST API](rest-api.md)** — Full REST API reference
- **[Security Model](security.md)** — Auth, TLS, and security details
- **[Networking](networking.md)** — Bind addresses, TLS, deSEC, QR codes
- **[AGENTS.md](../AGENTS.md)** — Agent context: repo layout, key concepts, common tasks, debugging tips
