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

2. **Browser client** (`src/app/`) — Connects to the gateway via WebSocket. Renders the chat UI using components from `src/ui/`. Desktop layout has a session sidebar; mobile has a landing page with session cards. Supports multi-device access and QR code sharing.

3. **UI components** (`src/ui/`) — Lit-based component library (forked from pi-web-ui). Message rendering, specialised tool call renderers, model selection, settings, and more.

## Client routing

Bobbit's browser UI is primarily hash-routed so it can run as a static single-page app behind the gateway, Vite, or a remote reverse proxy. Session routes support both forms:

- `#/session/<session-id>` — the normal in-app route used by sidebar and hash navigation.
- `/session/<session-id>` — a path-style external/shareable deep link used by the session header's copy-link action.

Path-style session links are intentionally valid entrypoints. Opening or reloading `/session/<session-id>` after a full page load selects the same session as the hash route, so copied links continue to work when pasted into a fresh browser tab. Auth query parameters are also supported; for example, `/session/<id>?token=...` can authenticate the browser and still open `<id>`.

After the app resolves and connects a path-style session route, the visible in-app URL is canonicalized to `/#/session/<id>`. The cleanup uses history replacement rather than dispatching hash or route changes, so it does not restart or race the active `connectToSession()` flow.

Hash routes take precedence over the path-style session fallback once the app has loaded. This keeps in-app navigation meaningful even from a copied path URL: `/session/old#/session/new` opens `new`, not `old`. Non-session pathnames are not treated as session deep links. Extension surfaces (e.g. the PR walkthrough pack) are reached through the generic hash route `#/ext/<routeId>` rather than a dedicated pathname route.

## Side-panel workspace

Every chat session owns a dynamic side-panel workspace. The workspace is shared
by regular sessions and assistant sessions, so HTML previews, proposals, review
documents, PR walkthroughs, and the staff inbox are selected by the same tab
dispatcher instead of by assistant-specific branches. Chat stays outside the
strip; when a non-staff session has no side-panel tabs, the side pane hides and
chat fills the layout.

Tabs are derived from their artifact source. Preview tabs represent current or
historical `preview_open` artifacts and use `contentHash` to collapse duplicate
content when available. Proposal tabs distinguish the live editable draft from
historical revisions. Review tabs map to review documents by encoded title.
The PR walkthrough review surface now ships as a **built-in first-party pack**
(`market-packs/pr-walkthrough/`) reached through the generic extension route
`#/ext/pr-walkthrough`, rather than a bespoke side-panel tab kind. A pack
entrypoint opens the pack panel and its "Run PR walkthrough" action drives the
current session's agent via `host.session.postMessage`. See
[pr-walkthrough-panel.md](pr-walkthrough-panel.md) and
[built-in-first-party-packs.md](design/built-in-first-party-packs.md). Desktop
renders a scrollable tab strip next to the chat; mobile renders the same
side-panel tab set in the header and slider track.

The main client modules are `src/app/panel-workspace.ts` for tab identity and
persistence, `src/app/preview-panel.ts` for preview selection helpers and SSE
wiring, and `src/app/render.ts` for the shared dispatcher and responsive layout. See
[Side-Panel Tab Contract](design/side-panel-tab-contract.md) for the full id /
ordering contract and [Embedded HTML preview — architecture](preview-architecture.md)
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
- [Pi 0.77 / Claude Opus 4.8 compatibility](pi-0.77-opus-4.8.md) — model catalog, ranking, spawn pinning, transcript, and regression-test notes for the Pi upgrade
