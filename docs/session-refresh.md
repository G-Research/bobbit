# Session & Goal Refresh Architecture

## Overview

The client keeps the sidebar in sync with the server via `refreshSessions()` in `src/app/api.ts`. This function fetches both `/api/sessions` and `/api/goals`, updates local state, and calls `renderApp()`. A generation counter mechanism makes this efficient.

## Generation counter pattern

Both `SessionStore` and `GoalStore` maintain a monotonically increasing `generation` counter (resets to 0 on server restart). Every mutation method (`put`, `remove`, `update`, `archive`, `purge`, `setDraft`, `deleteDraft`) increments the counter.

The client tracks `sessionsGeneration` and `goalsGeneration` in `state.ts` (initialized to -1). On each poll, it sends `?since=N` with its last-seen generation. If the server's generation matches, it returns `{ generation: N, changed: false }` — the client skips JSON processing and `renderApp()`.

```
Server mutation → generation++ → stored in memory

Client poll (every 5s):
  GET /api/sessions?since=42 → { changed: false, generation: 42 } → skip
  GET /api/goals?since=17    → { changed: false, generation: 17 } → skip
  → No renderApp(), no gate/PR refresh

Client poll after server mutation:
  GET /api/sessions?since=42 → { generation: 43, sessions: [...] } → update state
  GET /api/goals?since=17    → { changed: false, generation: 17 } → skip
  → renderApp() once
```

## Client refresh patterns

### Pattern 1 — Optimistic local mutations (no fetch needed)

Some callbacks already update `state.gatewaySessions` in place and call `renderApp()` directly:

- `updateLocalSessionTitle()` — updates title in local state
- `updateLocalSessionStatus()` — updates status in local state
- `onTitleChange` / `onStatusChange` callbacks in `session-manager.ts`

These do **not** trigger `refreshSessions()`. The next background poll will reconcile if needed.

### Pattern 2 — Generation-gated background sync

The 5s poll and navigation-time calls use `refreshSessions()`, which is now generation-gated. When nothing has changed on the server, the poll is essentially free (minimal JSON response, no state processing, no `renderApp()`).

### Pattern 3 — Mutation-reactive refresh

After server-side mutations (session deletion, role assignment, team teardown), `refreshSessions()` is called to pick up the new state. These calls will always see a generation bump and process the full payload.

## Key files

| File | Role |
|---|---|
| `src/server/agent/session-store.ts` | Server-side generation counter for sessions |
| `src/server/agent/goal-store.ts` | Server-side generation counter for goals |
| `src/server/server.ts` | API endpoints with `?since=` support |
| `src/app/state.ts` | Client-side `sessionsGeneration` and `goalsGeneration` |
| `src/app/api.ts` | `refreshSessions()` with generation-gated logic |
| `src/app/session-manager.ts` | Session lifecycle (optimistic local updates) |
