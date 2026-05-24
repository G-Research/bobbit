# Staff Inbox Queue

Persistent per-staff queue of work items. Triggers, manual API calls, and the UI's
"Add to inbox" button append entries; a background nudger wakes idle staff with a
digest message; the agent works through entries with three dedicated tools and
records outcomes on each one. State lives on disk so nothing is lost across server
restarts, slow turns, or sandbox boots.

For the original design rationale (problem framing, alternatives considered,
deferred work, line-anchored migration plan) see
[docs/design/staff-inbox.md](design/staff-inbox.md). This page is the operator-
and developer-facing reference.

## Why it exists

Before the inbox, a trigger fired and immediately called `StaffManager.wake()`,
which either started a new turn or — if the staff session was already
`streaming`/`starting` — was **silently dropped**. There was no per-item state,
no history, no way to see what was queued, and no way to recover from a stuck
run. The inbox solves all four:

- **No dropped triggers.** `fireTrigger()` does pure I/O against a JSON file.
  Whatever the staff is doing, the entry lands.
- **Per-item lifecycle.** Every enqueue produces an `InboxEntry` with a state
  machine (`pending → completed | failed | cancelled`), a result/error field,
  and a timestamp.
- **Visibility.** The staff session view renders a collapsible inbox panel with
  Pending and History sections. The user can prune, cancel, or manually
  enqueue from the same place.
- **Idempotency contract.** Because two triggers fired 100 ms apart create two
  distinct entries (no coalescing), the contract is explicit: the agent is
  responsible for deduping via its memory and the completed-entries history.

## Where it fits

The inbox sits between trigger fan-in and session fan-out:

```
                  ┌──────────────────────┐
   cron / git ───►│                      │
   manual API ───►│   InboxManager       │── persist ──► <projectStateDir>/inbox/<staffId>.json
   manual UI ────►│   .enqueue()         │── broadcast ► WS  inbox.entry.added
                  └──────────┬───────────┘
                             │ poke(staffId)
                             ▼
                  ┌──────────────────────┐
                  │   InboxNudger        │  every 15 s + on poke
                  │   .tick()/.tickOne() │
                  └──────────┬───────────┘
                             │ if staff is "idle" with pending entries:
                             │   (optional) compact
                             │   enqueuePrompt(session, "[INBOX] You have N pending …")
                             ▼
                  ┌──────────────────────┐
                  │   staff agent turn   │
                  │   inbox_list →       │── HTTP ──► InboxManager.transition* → WS updated
                  │   inbox_complete /   │
                  │   inbox_dismiss      │
                  └──────────────────────┘
```

Component map (all in `src/server/agent/`):

| File | Role |
|---|---|
| `inbox-store.ts` | Per-staff JSON persistence. Lazy load, synchronous writes. |
| `inbox-manager.ts` | Cross-project façade. Owns enqueue + transitions + WS broadcast + nudger poke. |
| `inbox-nudger.ts` | 15 s tick + microtask poke. Owns the only path that wakes a staff. |
| `staff-trigger-engine.ts` | Polled `schedule` / `git` triggers — `fireTrigger()` calls `inboxManager.enqueue()`. |
| `goal-trigger-dispatcher.ts` | Push-based `goal_created` / `goal_archived` triggers fired synchronously from `GoalStore` mutations. See [staff-triggers.md](staff-triggers.md). |

UI surface (all in `src/app/` and `src/ui/inbox/`):

| File | Role |
|---|---|
| `src/app/inbox-panel.ts` | Per-session subscription lifecycle (bootstrap fetches + WS routing). |
| `src/ui/inbox/InboxPanel.ts` | `<inbox-panel>` LitElement — Pending + History sections, "+ Add to inbox" button. |
| `src/ui/inbox/InboxEntry.ts` | Single-row entry with cancel / delete affordances. |
| `src/ui/inbox/AddToInboxDialog.ts` | Manual-enqueue composer. |

## Lifecycle

1. **Enqueue.** A trigger fires, a REST caller hits `POST /api/staff/:id/inbox`,
   or the UI's "+ Add to inbox" submits the dialog.
   `InboxManager.enqueue(staffId, { title, prompt, context, source })` runs
   synchronously:
   - Stamp `id = randomUUID()`, `createdAt = Date.now()`, `state = "pending"`.
   - `InboxStore.put(entry)` — synchronous JSON write to
     `<projectStateDir>/inbox/<staffId>.json`.
   - Broadcast `{ type: "inbox.entry.added", staffId, entry }` to all WS clients.
   - Call `inboxNudger.poke(staffId)`, which schedules a one-shot
     `tickOne(staffId)` on the next microtask.
2. **Nudge.** `InboxNudger.tickOne` runs (either from `poke` or from the 15 s
   `setInterval`). It bails when the staff isn't active, the session isn't
   `idle`, `nudgePending` is already set, or the pending list is empty. If all
   four checks pass, it enters `applyPolicyThenNudge`:
   - Sets `nudgePending = true` so a concurrent tick can't re-fire.
   - If `staff.contextPolicy === "compact"` it awaits
     `session.rpcClient.compact(120_000)` — same call surface as the manual
     `/compact` skill.
   - Updates `staff.lastWakeAt` (best-effort; warn-only on failure).
   - Calls `sessionManager.enqueuePrompt(sessionId, "[INBOX] You have N pending …", { isSteered: true })`.
3. **Agent processes.** The agent sees the digest, calls `inbox_list` to fetch
   pending entries, then `inbox_complete` or `inbox_dismiss` per entry. Each
   tool hits `POST /api/staff/:id/inbox/:entryId/{complete,dismiss}`, which
   call `InboxManager.transitionToCompleted` /
   `transitionToTerminal` — these reject non-pending entries with a 409.
4. **Re-arm.** When the agent's next prompt begins streaming,
   `SessionManager` fires `agent_start` and `InboxNudger.onAgentStart` clears
   `nudgePending` for that staff. Any entries that arrived during the previous
   turn are eligible for the next tick once the session goes idle again.

## Entry states

| State | Set by | Meaning | Surfaces in |
|---|---|---|---|
| `pending` | `InboxManager.enqueue` (server) | New work. Server never auto-transitions out. | Pending section; `inbox_list()` default. |
| `completed` | `inbox_complete` (agent) | Work done. `result` holds the summary. | History; `inbox_list(state="completed")`. |
| `failed` | `inbox_dismiss(outcome="failed")` (agent) | Tried and failed. `error` holds the reason. Future triage may retry. | History; `inbox_list(state="failed")`. |
| `cancelled` | `inbox_dismiss(outcome="cancelled")` (agent) | Deliberately not doing it (duplicate / stale / out-of-scope). `error` holds the reason. | History; `inbox_list(state="cancelled")`. |

All transitions are agent-driven. The server never auto-completes or
auto-cancels — even stale pending entries from before a server restart remain
pending until the agent (or the user, via DELETE) resolves them. Terminal
entries persist forever; pruning is manual.

## Sources

The `source.type` field tells the operator (and the agent, via `inbox_list`)
where an entry came from:

| Source | How it gets there | UI badge |
|---|---|---|
| `trigger` | Any staff trigger fires — `schedule` / `git` via the polled engine, or `goal_created` / `goal_archived` via the push dispatcher. `source.triggerId` is set in either case. See [staff-triggers.md](staff-triggers.md). | "trigger" + trigger id. |
| `manual_api` | External integration `POST`s `/api/staff/:id/inbox`. The server normalises `source.type` to `manual_api` when the caller doesn't supply `manual_ui`. | "manual_api" + optional `actorId`. |
| `manual_ui` | User clicks "+ Add to inbox" in the inbox panel or hits "Wake Now" on the staff edit page (both POST `/api/staff/:id/inbox` with `source.type = "manual_ui"`). | "manual_ui" + optional `actorId`. |

## `contextPolicy`

`PersistedStaff.contextPolicy: "preserve" | "compact"` (default **`compact`**)
controls what the nudger does to conversation context immediately before
delivering a wake digest:

- **`compact`** — the nudger awaits a full `/compact` over the session's RPC
  bridge (`session.rpcClient.compact(120_000)`) and only enqueues the digest
  prompt after compaction completes. This keeps long-running staff agents
  inside the model's effective context window across many wake cycles.
- **`preserve`** — the nudger enqueues the digest directly into the existing
  conversation. Appropriate for short-lived threads or when you specifically
  want the agent to remember its previous decisions verbatim.

Edit on the staff page's **Context Policy** radio group between "Pinned
Context" and the save bar. The value is persisted via `PUT /api/staff/:id` and
normalised to `compact` for any legacy record that lacks the field. Existing
staff records get `compact` on first load — see `staff-store.ts` (load and
update normalisation).

A future `clear` policy (terminate + respawn subprocess with a fresh jsonl)
is deliberately out of scope. The enum is forward-compatible — see
[design/staff-inbox.md §10](design/staff-inbox.md#10-out-of-scope) for the
reasoning.

## Tools

Three tools are registered only when the agent process has both
`BOBBIT_SESSION_ID` and `BOBBIT_STAFF_ID` set in its environment — i.e. only
for staff sessions. The extension in `defaults/tools/inbox/extension.ts` early-
returns otherwise, so the tools never appear in the tool catalogue on
non-staff sessions. This mirrors `defaults/tools/tasks/` and is the only
gating layer the agent sees; REST handlers additionally verify
`session.staffId === :id` as defence-in-depth.

| Tool | Params | Effect |
|---|---|---|
| `inbox_list` | `state?` (`pending` (default) / `completed` / `failed` / `cancelled`), `limit?` (default 50) | Returns `{ entries: InboxEntry[] }` in FIFO order. Used after a wake digest to discover work, or with a non-default `state` to inspect history. |
| `inbox_complete` | `entry_id`, `summary?` | Moves a `pending` entry to `completed`. `summary` is stored on `entry.result`. Rejected with 409 if not pending. |
| `inbox_dismiss` | `entry_id`, `outcome` (`failed` / `cancelled`), `reason` | Moves a `pending` entry to the chosen terminal state. `reason` is stored on `entry.error`. Rejected with 409 if not pending. Reason is required and must be non-empty. |

The agent should always include a `summary` on completion — empty results
make the history pane useless for audit. Likewise dismissal reasons are
mandatory at the REST layer (the server returns 400 on empty `reason`).

Tool description budget: descriptions are kept ≤ 150 chars and parameter
descriptions ≤ 80 chars, enforced by `tests/tool-description-budget.test.ts`.

## REST surface

All routes live under `/api/staff/:id/inbox` and are registered in
`server.ts::handleApiRoute()`. Auth is the same bearer token used for the
rest of the gateway.

| Method | Path | Body | 2xx | Notable errors |
|---|---|---|---|---|
| `GET` | `/api/staff/:id/inbox?state=&limit=` | — | `200 { entries: InboxEntry[] }` | `404` if staff unknown. |
| `POST` | `/api/staff/:id/inbox` | `{ title, prompt, context?, source?: { type?: "manual_api" \| "manual_ui" \| "trigger", actorId? } }` | `201 { entry: InboxEntry }` | `400` missing `title`/`prompt`; `404` staff unknown. |
| `POST` | `/api/staff/:id/inbox/:entryId/complete` | `{ sessionId, summary? }` | `200 { entry }` | `403` if `sessionId.staffId !== :id`; `409` if entry not pending; `404` staff/entry. |
| `POST` | `/api/staff/:id/inbox/:entryId/dismiss` | `{ sessionId, outcome: "failed" \| "cancelled", reason }` | `200 { entry }` | `400` empty `reason` or bad outcome; `403`; `409`; `404`. |
| `DELETE` | `/api/staff/:id/inbox/:entryId` | — | `200 { ok: true }` | `404`. |

`source.type` in `POST /api/staff/:id/inbox` defaults to `manual_api` when the
caller omits it. The `sessionId` body field on `complete` and `dismiss` is the
defence-in-depth check — only sessions whose `staffId` matches `:id` may
transition entries.

The legacy `POST /api/staff/:id/wake` route has been **deleted**. The UI's
"Wake Now" button is rewired to `POST /api/staff/:id/inbox` with
`source.type = "manual_ui"`. External callers that previously hit `/wake`
must migrate.

### Examples

```bash
TOKEN=$(cat .bobbit/state/token)
GW=$(cat .bobbit/state/gateway-url)

# Enqueue a manual entry (manual_api source by default)
curl -sk -X POST "$GW/api/staff/$STAFF_ID/inbox" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Check release branch","prompt":"Sweep release/v0.42 for unmerged hotfixes and post the diff to #release."}'
# → 201 { "entry": { "id":"…","state":"pending",… } }

# List pending entries
curl -sk "$GW/api/staff/$STAFF_ID/inbox?state=pending&limit=50" \
  -H "Authorization: Bearer $TOKEN"
# → 200 { "entries": [ … ] }

# Inspect history
curl -sk "$GW/api/staff/$STAFF_ID/inbox?state=completed&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

External integrations should set `source.actorId` to something they can
recognise later (e.g. `"github-bot:auto-triage"`); it surfaces in the inbox
panel and in `inbox_list` responses.

## WebSocket events

Broadcast to all connected clients via `broadcastToAll`. Defined in
`src/server/ws/protocol.ts`:

| Type | Payload | When |
|---|---|---|
| `inbox.entry.added` | `{ type, staffId: string, entry: InboxEntry }` | Any successful `enqueue` — trigger, manual_api, or manual_ui. |
| `inbox.entry.updated` | `{ type, staffId: string, entry: InboxEntry }` | `transitionToCompleted` / `transitionToTerminal` succeed. |
| `inbox.entry.removed` | `{ type, staffId: string, entryId: string }` | `DELETE /api/staff/:id/inbox/:entryId` succeeds. The entry itself is not sent; clients reconcile by id. |

The dotted naming (`inbox.entry.added`) is intentional and follows the goal
spec; it does **not** match the snake_case convention used for `task_changed` /
`gate_status_changed` elsewhere in `ServerMessage`. If the project later
normalises naming, these three events are rename targets.

Clients filter by `staffId` and reconcile against the entry list in
`state.inboxEntries`. The reconciliation logic is in
`src/app/inbox-panel.ts::applyInboxEntry{Added,Updated,Removed}`.

## UI

The inbox panel is a split-pane peer of the preview pane and the review
pane. It is mounted in `src/app/render.ts` whenever the active session has
`staffId` set, and `data-testid="inbox-panel-root"` wraps the host.

- **Pending section** at the top: each entry shows title, source badge, age,
  and a Cancel button (transitions to `cancelled`).
- **History section** below, collapsible: terminal entries grouped by state,
  newest first. Each entry has a Delete button that calls
  `DELETE /api/staff/:id/inbox/:entryId`.
- **"+ Add to inbox" button** opens `<add-to-inbox-dialog>` — a Title + Prompt
  composer that POSTs to `/api/staff/:id/inbox` with `source.type = "manual_ui"`.
- **Keyboard shortcuts**: `Ctrl+]` collapses the panel one level (full → half
  → collapsed); `Ctrl+[` expands one level. Same surface as the preview and
  review panes; wired in `src/app/main.ts` alongside `state.inboxPanelOpen`.
- **Per-session open state** is hydrated from `localStorage`. Reloading the
  page keeps the panel open or collapsed exactly as you left it.

### Mobile add dialog scoping

On mobile, `src/app/render.ts` renders chat and unified-panel tabs inside a
horizontally translated `.preview-slider__track`. Because a transformed
ancestor can become the containing block for positioned descendants, a
viewport-fixed add dialog would size and center against the widened slider
track instead of the visible inbox pane.

The manual composer is therefore intentionally pane-scoped rather than
viewport-scoped:

- `InboxPanel` renders `<add-to-inbox-dialog>` inside its internal
  `.inbox-panel` root, which is `position: relative` and clips overflow.
- The dialog host and `.add-to-inbox-backdrop` use `position: absolute; inset: 0`
  so the backdrop covers only the inbox pane and the dialog stays centered
  within that pane at narrow widths.
- Desktop uses the same pane-scoped dialog, preserving the existing behavior of
  overlaying the inbox/unified panel rather than the whole browser viewport.

The mobile regression is pinned in `tests/e2e/ui/staff-inbox.spec.ts`: the test
opens the Inbox pane, opens "+ Add to inbox", verifies the transformed slider
track is wider than the visible pane, and asserts both the dialog host and
backdrop bounding boxes stay inside `[data-testid="inbox-panel-root"]`.

There is **no sidebar badge** and no pending-count indicator anywhere in the
sidebar. The staff session continues to appear as a normal staff-section
entry; the only inbox UI surface is the panel attached to the session view.
This is deliberate — see [design/staff-inbox.md §8.6](design/staff-inbox.md#86-sidebar--explicit-non-change).

The "Wake Now" button on the staff edit page (`src/app/staff-page.ts`) is
preserved but rewired: it calls `enqueueInboxManual(staffId, { title: "Manual wake", prompt: … })`
and now surfaces an "Enqueued. The agent will process when idle." feedback
line instead of starting a session synchronously.

## Idempotency contract

The server never auto-cancels, auto-completes, or coalesces entries. Two
triggers that fire 100 ms apart create two distinct entries. The agent is
responsible for deduping:

- **Before doing work**, the agent should call `inbox_list(state="completed")`
  (or check its memory) to detect whether the same work has already been
  handled.
- **Completion is the audit trail.** Even for no-op completions, the agent
  should call `inbox_complete` with a `summary` explaining why the entry was
  a no-op. Empty completions make history useless.
- **Failure vs cancellation matters.** `outcome="failed"` signals "I tried and
  it didn't work — retry / triage me." `outcome="cancelled"` signals "I
  deliberately won't do this." Pick honestly so future audits make sense.

The contract is reinforced in the wake digest itself and in each tool's
detailed docs (`detail_docs` in the YAML manifests).

## Storage

One JSON file per staff at `<projectStateDir>/inbox/<staffId>.json`:

```jsonc
{
  "staffId": "0a3b…",
  "entries": [
    {
      "id": "ec1…",
      "staffId": "0a3b…",
      "source": { "type": "trigger", "triggerId": "c8f…" },
      "title": "schedule: 0 9 * * *",
      "prompt": "Daily standup digest.",
      "state": "pending",
      "createdAt": 1782900000000
    }
  ]
}
```

`projectStateDir` is `<project-root>/.bobbit/state/` (single-source from
`ProjectContext`). Entries are stored FIFO by insertion order.

The file is safe to hand-inspect; it is rewritten on every transition (full-
file synchronous write, last-writer-wins per id). Hand-editing while the
server is running is **not** safe — the store caches each staff's entries in
memory on first read and won't see external writes until the next process
restart. To delete or mutate an entry while running, prefer
`DELETE /api/staff/:id/inbox/:entryId` or the UI's per-row Delete button.

When a staff is deleted, `StaffManager.deleteStaff` calls
`InboxManager.removeAll(staffId)` which unlinks the per-staff JSON file and
clears the in-memory cache.

## Migration notes

For anyone upgrading from a pre-inbox checkout:

- **`StaffManager.wake()` is gone.** All three call sites
  (`staff-trigger-engine.ts`, the deleted `/wake` route, the legacy-migration
  branch in `staff-manager.ts`) were migrated to `InboxManager.enqueue()`.
  Session recovery moved into a private `staffManager.ensureSessionForStaff()`
  helper that the nudger calls only when it has decided to nudge.
- **`POST /api/staff/:id/wake` is gone.** External integrations must move to
  `POST /api/staff/:id/inbox` with `source.type = "manual_api"`. The response
  shape changes from `{ sessionId }` to `{ entry }` (201).
- **`TriggerEngine.wakingInProgress` is gone**, as is the streaming/starting
  skip in `fireTrigger`. Enqueueing is pure I/O against the JSON store, so
  there is no race to guard against — the trigger always lands.
- **`PersistedStaff.contextPolicy` is new.** Legacy records normalise to
  `compact` on load and on next write.
- **`lastWakeAt` is now updated by the nudger**, not by the old `wake()`
  method, and reflects the moment the nudger delivers a digest (regardless of
  source).

## Open follow-ups

Identified during code review but deferred from this initial ship — track as
separate work items when they become priorities. None block correct
operation today.

| Area | Severity | Note |
|---|---|---|
| `InboxManager` carries an unused `staffManager` reference | medium | Held for API parity with the design doc; can be dropped once a stable refactor lands. |
| `crossProjectInboxStore` adapter in `server.ts` is a partial stub | medium | Only `listPending` is implemented; the other `InboxStore` methods are no-op stubs cast through `as unknown as InboxStore`. Replace with a proper cross-project store type. |
| `_cancel` / `_delete` in `InboxPanel` swallow HTTP errors silently | medium | UI should surface a toast / banner on non-2xx from the cancel and delete endpoints. |
| Inbox panel bootstrap fires four separate `?state=` fetches | medium | Replace with a single endpoint that returns all states, or batch on the server. |
| `InboxStore.update` mutates entries in place | low | Cosmetic; doesn't affect persistence but makes the store less reasonable about. |
| `InboxNudger.onAgentStart` is O(n_staff) | low | A reverse `sessionId → staffId` map would make it O(1). |
| Search index ingestion of completed entries | out of scope | Entries are addressable via REST but not searchable in the cross-project search. Tracked in the original design doc. |
| `contextPolicy: "clear"` | out of scope | Terminate + respawn the agent subprocess with a fresh jsonl. The enum is forward-compatible; see [design/staff-inbox.md §10](design/staff-inbox.md#10-out-of-scope). |

## See also

- [docs/staff-agents.md](staff-agents.md) — staff agent lifecycle, sandbox
  mode, edit page conventions.
- [docs/staff-triggers.md](staff-triggers.md) — trigger type reference,
  including the push-based `goal_created` / `goal_archived` dispatcher
  and its required-prompt rule.
- [docs/design/staff-inbox.md](design/staff-inbox.md) — original design
  document (kept for reference).
- [docs/rest-api.md](rest-api.md) — REST surface index.
- [docs/websocket-protocol.md](websocket-protocol.md) — WebSocket event
  index.
