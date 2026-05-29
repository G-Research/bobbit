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

## Side-panel workspace

Every chat session owns a dynamic side-panel workspace. The workspace is shared
by regular sessions and assistant sessions, so proposal, review, HTML preview,
inbox, and chat panes are selected by the same tab dispatcher instead of by
assistant-specific branches.

Tabs are derived from their artifact source. Live preview tabs are the current
per-session server mount views: `preview:live` is titled from the active entry
(such as `Preview: inline.html`) and updates from the preview bootstrap probe and
`preview-changed` SSE events. Historical preview tabs originate from
`preview_open` tool cards and represent chat artifacts that can be selected or
remounted later.

Preview tabs also carry content identity when available. v3 historical previews
use `contentHash` to collapse same-content artifacts into `preview:live`, so
users do not see duplicate tabs for the same mounted bytes. If a v3 marker omits
the hash to stay within its size cap, the remount response can supply it and the
artifact can still collapse after the refresh. Different-content preview
artifacts keep separate tabs and remain independently restorable through the one
live server mount. Legacy v1/v2 snapshots remain historical even when their
remount response includes a hash; they predate the v3 content-identity contract.
Proposal tabs distinguish the live editable draft from read-only historical
revisions, and review documents appear as top-level `Review: <title>` tabs.
Review tab IDs encode the title, so titles with spaces, slashes, `?`, `#`, or
other reserved URL characters round-trip without being normalized. Desktop
renders a scrollable tab strip next to the chat; mobile renders the same tab set
in the header and slider track.

The main client modules are `src/app/panel-workspace.ts` for tab identity,
`src/app/preview-panel.ts` for selection helpers and preview SSE wiring, and
`src/app/render.ts` for the shared dispatcher and responsive layout. See
[Embedded HTML preview — architecture](preview-architecture.md) for the preview
mount and `contentHash` contract.

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
