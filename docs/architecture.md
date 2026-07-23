# System Architecture

## How it works

```
┌─────────────┐         ┌──────────────────────────┐
│  Browser UI  │◄──WS──►│     Bobbit Gateway        │
│  (any device)│         │                           │
└─────────────┘         │  ┌──────────────────────┐ │
                        │  │ pi-coding-agent (RPC) │ │
                        │  │  stdin/stdout JSONL    │ │
                        │  └──────────────────────┘ │
                        └──────────────────────────┘
```

Bobbit has three layers:

1. **Gateway** (`src/server/`) — Node.js HTTP + WebSocket server. Manages agent sessions as child processes communicating over JSONL on stdin/stdout. Sessions persist to disk and survive server restarts. Serves the built UI as static files or runs headless behind a Vite dev server.

2. **Browser client** (`src/app/`) — Connects to the gateway via WebSocket. Renders the chat UI using components from `src/ui/`. Desktop layout has a session sidebar; mobile has a landing page with session cards. Supports multi-device access and QR code sharing. Session navigation is kept cross-device by server-pushed session-list invalidations plus REST refreshes; `/api/sessions` remains authoritative.

3. **UI components** (`src/ui/`) — Lit-based component library (forked from pi-web-ui). Message rendering, specialised tool call renderers, model selection, settings, and more.

## Message attribution boundary

Bobbit-visible messages carry optional `user`, `agent`, or `system` author metadata independently of their Pi role. This separation matters because a Pi `user` row may originate from a human, another agent, or Bobbit orchestration; role remains a protocol concern rather than an accountability signal.

The gateway derives trusted identities and stores prompt correlation in a private host-side sidecar. When loaded history includes an agent- or system-authored prompt, the browser labels all accountable prompt rows for context and gives agent labels a static sidebar-matched Bobbit avatar; all-human history keeps its existing unlabelled layout.

At the final Pi dispatch boundary, trusted system and agent prompts receive a model-facing prefix, while human prompts remain unprefixed. The sidecar is written first and records only the exact prefix plus a keyed digest of exact Pi text, never prompt plaintext. Digest-gated projection restores base text before live/snapshot/transcript, title, search, extension, and fork/continue views, making retry and replay idempotent without rewriting raw Pi JSONL. See [Message author identity](message-author-identity.md) for the prefix, projection, degradation, and verification contracts.

## Client routing

Bobbit's browser UI is primarily hash-routed so it can run as a static single-page app behind the gateway, Vite, or a remote reverse proxy. Session routes support both forms:

- `#/session/<session-id>` — the normal in-app route used by sidebar and hash navigation.
- `/session/<session-id>` — a path-style external/shareable deep link used by unified session actions such as Copy link and Open in new window.

Path-style session links are intentionally valid entrypoints. Opening or reloading `/session/<session-id>` after a full page load selects the same session as the hash route, so copied links continue to work when pasted into a fresh browser tab. Auth query parameters are also supported; for example, `/session/<id>?token=...` can authenticate the browser and still open `<id>`.

After the app resolves and connects a path-style session route, the visible in-app URL is canonicalized to `/#/session/<id>`. The cleanup uses history replacement rather than dispatching hash or route changes, so it does not restart or race the active `connectToSession()` flow.

Hash routes take precedence over the path-style session fallback once the app has loaded. This keeps in-app navigation meaningful even from a copied path URL: `/session/old#/session/new` opens `new`, not `old`. Non-session pathnames are not treated as session deep links. Extension surfaces (e.g. the PR walkthrough pack) are reached through the generic hash route `#/ext/<routeId>` rather than a dedicated pathname route.

## Session list synchronization

A visible session created on one client must become selectable on every other connected client. The server broadcasts `session_created` (or the broader `sessions_changed`) whenever a visible session enters the persisted session list, including sessions created by normal REST/UI flows and `host.agents` pack launches. Browsers treat the event as an invalidation and refresh `GET /api/sessions`; they do not trust the WebSocket payload as the full session record.

The app keeps this working even when no chat session is open. Active chat views receive the event on their session socket, while landing/dashboard/mobile views keep a lightweight authenticated `/ws/viewer` socket that refreshes the same session list. A backgrounded tab can still catch up through the normal visibility-triggered and periodic session refresh paths. Removals use the matching `session_removed` push so sidebars and mobile lists drop archived/terminated sessions promptly.

See [websocket-protocol.md](websocket-protocol.md) for the wire contract.

## Side-panel workspace

Every chat session owns a server-backed side-panel workspace for the right side
of the chat view. The workspace is shared by regular sessions and assistant
sessions, so HTML previews, pack panels such as PR walkthrough and artifact
viewers, proposals, review documents, and the staff inbox all use the same tab
strip and window controls. Chat stays outside the strip; when a non-staff
session has no side-panel tabs, the side pane hides and chat fills the layout.

The server is authoritative for open tabs, active tab, tab order, and size mode
(`split`, `fullscreen`, or `collapsed`). Closed tabs are durable absence: render,
refresh, reconnect, content caches, and localStorage must not recreate a tab just
because the underlying preview artifact, proposal draft, review document, inbox,
or pack panel still exists. Tabs open only through explicit workspace open or
reopen events.

Desktop renders the workspace beside chat in `split` mode; in `fullscreen` the
panel fills the whole area down to the bottom edge and the composer is hidden (to
type the user returns to `split` or `collapsed`). Mobile renders the same tab set
in the header and slider track. Popout
links either use the preview content route or the safe app deep link
`#/session/<sessionId>/panel/<tabId>`, which renders only already-open server
workspace tabs.

Main modules: `src/shared/side-panel-workspace.ts` defines the shared model,
`src/server/side-panel-workspace*.ts` canonicalizes and mutates persisted
workspaces, `src/app/side-panel-workspace.ts` hydrates and mutates the client
mirror, `src/app/panel-workspace.ts` keeps tab id helpers and fixture fallback,
and `src/app/render.ts` renders the shared shell. See
[Side-panel workspace](side-panel-workspace.md) for the invariant, lifecycle,
API, popout, and migration rules, and [Embedded HTML preview — architecture](preview-architecture.md)
for the preview mount and `contentHash` contract.

## Build structure

Two separate TypeScript configs produce two outputs:

```
dist/
├── server/         # tsc output (Node16 modules)
│   ├── cli.js      # bin entry point
│   ├── harness.js  # dev server wrapper
│   └── ...         # all server modules
└── ui/             # vite output (browser bundle)
    └── index.html  # SPA entry
```

- `tsconfig.server.json` — Node16 module resolution, `src/server/` → `dist/server/`
- `tsconfig.web.json` — Bundler resolution + DOM libs, `src/ui/` + `src/app/` (bundled by Vite, tsc only type-checks)

## Further reading

- [Build Structure](build-structure.md) — detailed build layout
- [REST API](rest-api.md) — full HTTP API reference
- [WebSocket Protocol](websocket-protocol.md) — real-time communication protocol
- [Security](security.md) — auth, TLS, and threat model
- [Networking](networking.md) — remote access and multi-device setup
- [Per-model thinking-level capabilities](thinking-levels.md) — how the reasoning-level selector adapts to the active model
- [Pi runtime compatibility](pi-runtime-compatibility.md) — browser imports, model catalog subpaths, RPC lifecycle, transcript normalization, orphan tool-result transcript repair and recovery, and upgrade checks
- [Message author identity](message-author-identity.md) — accountable user, agent, and system metadata across live events, persistence, transcripts, search, and client state
- [Pi 0.77 / Claude Opus 4.8 compatibility](pi-0.77-opus-4.8.md) — historical Opus 4.8-specific model, ranking, and spawn notes
