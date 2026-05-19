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

Tabs are derived from their artifact source: live previews use names such as
`Preview: inline.html`, historical preview tool cards get distinct preview
tabs, proposal tabs distinguish the live editable draft from read-only
historical revisions, and review documents appear as top-level `Review: <title>`
tabs. Review tab IDs encode the title, so titles with spaces, slashes, `?`, `#`,
or other reserved URL characters round-trip without being normalized. Desktop
renders a scrollable tab strip next to the chat; mobile renders the same tab set
in the header and slider track.

The main client modules are `src/app/panel-workspace.ts` for tab identity,
`src/app/preview-panel.ts` for selection helpers and preview SSE wiring, and
`src/app/render.ts` for the shared dispatcher and responsive layout.

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
