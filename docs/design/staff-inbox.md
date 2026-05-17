# Staff Inbox Queue — Design

> **Status: shipped.** Operational documentation lives in [docs/staff-inbox.md](../staff-inbox.md). This page is the original design record — kept verbatim for historical reference. Where this doc and the operator doc disagree, the operator doc and the source code win.

Goal: introduce a first-class **inbox** for staff agents — a persistent, per-staff ordered queue of work items that decouples triggers from agent wakes.

---

## 1. Problem & motivation

Today the path from a trigger to a staff agent processing the work is:

```
TriggerEngine.tick()  →  fireTrigger()  →  staffManager.wake()  →  sessionManager.enqueuePrompt()
```

`fireTrigger` in `src/server/agent/staff-trigger-engine.ts:227` calls `staffManager.wake()` directly. The trigger engine guards against a busy session by skipping firing when `session.status === "streaming" | "starting"` (`staff-trigger-engine.ts:130`). When the engine skips, **the trigger event is silently dropped**: cron triggers `lastFired`-gate per-minute (`staff-trigger-engine.ts:166`), and git triggers update `lastSeenSha` before checking status (`staff-trigger-engine.ts:204`), so the work is gone. The agent has no record that it was ever signalled.

This has three operational problems:

- **Drops on streaming/starting.** A long-running task or a slow process boot loses every trigger that fires during that window.
- **No per-item lifecycle.** An enqueued prompt is just text in `session.promptQueue` — no state machine, no result, no idempotency contract, no audit trail.
- **No visibility.** The user can't see what work is queued for a staff agent, nor mark items done, dismissed, or fix a stuck run.

The fix is a per-staff **InboxStore** (persistent, ordered, JSON-backed) that owns the queue, a **side-effect-free trigger path** that only appends entries, and a periodic **InboxNudger** that wakes idle staff with a digest message. All state transitions are agent-driven via three new tools (`inbox_list`, `inbox_complete`, `inbox_dismiss`) — the server never mutates entry state. A new collapsible **inbox panel** in the staff session UI surfaces pending + history.

---

## 2. Data model

### 2.1 `InboxEntry`

```ts
// src/server/agent/inbox-store.ts (NEW)

export type InboxEntryState = "pending" | "completed" | "failed" | "cancelled";

export interface InboxEntrySource {
  type: "trigger" | "manual_api" | "manual_ui";
  /** Set when source.type === "trigger". The trigger id from PersistedStaff.triggers[].id. */
  triggerId?: string;
  /** Optional caller identifier for manual_api / manual_ui sources (e.g. user id, integration name). */
  actorId?: string;
}

export interface InboxEntry {
  id: string;                 // uuid
  staffId: string;
  source: InboxEntrySource;
  title: string;              // short label for UI lists (e.g. "schedule: daily-sync")
  prompt: string;             // the body delivered to the agent — full trigger prompt + extra context
  context?: string;           // optional structured context (git log, file diff, etc.)
  state: InboxEntryState;
  createdAt: number;
  completedAt?: number;       // set when state transitions to terminal
  result?: string;            // staff-written summary, set by inbox_complete
  error?: string;             // dismissal reason, set by inbox_dismiss
}
```

Lifecycle: `pending → completed | failed | cancelled`. **All transitions agent-driven via tools**; the server never mutates `state` outside of `enqueue` (always `pending`) and explicit tool calls. Terminal entries persist forever; the user prunes them manually via the UI.

No coalescing — every enqueue produces a new entry. Two triggers firing 100 ms apart create two distinct entries; the agent dedupes during processing.

### 2.2 Persistence

One JSON file per staff: `<projectStateDir>/inbox/<staffId>.json`. Mirrors `StaffStore` (`src/server/agent/staff-store.ts`) — synchronous JSON load/save, no migrations, lazy directory creation. `projectStateDir` is `<project-root>/.bobbit/state/` as set by `ProjectContext` (`src/server/agent/project-context.ts:67-68`).

File schema:

```jsonc
{
  "staffId": "0a3b...",
  "entries": [
    {
      "id": "ec1...",
      "staffId": "0a3b...",
      "source": { "type": "trigger", "triggerId": "c8f..." },
      "title": "schedule: 0 9 * * *",
      "prompt": "Daily standup digest.",
      "state": "pending",
      "createdAt": 1782900000000
    }
  ]
}
```

Entries are stored in insertion order (FIFO).

### 2.3 `PersistedStaff` extension

Add one field to `PersistedStaff` in `src/server/agent/staff-store.ts`:

```ts
/**
 * What the InboxNudger does to context before injecting a wake digest.
 * - "preserve" — leave conversation context as-is (long-running threads).
 * - "compact"  — run /compact before nudging (default).
 *
 * A future "clear" policy (terminate + respawn subprocess with fresh jsonl) is
 * deliberately deferred — see "Out of scope".
 */
contextPolicy: "preserve" | "compact";
```

`StaffStore.load()` normalises missing records to `"compact"` (the same pattern used for `sandboxed` in `staff-store.ts:73-77`).

---

## 3. Component breakdown

All paths relative to repo root. NEW files marked as such; everything else already exists.

### 3.1 `src/server/agent/inbox-store.ts` (NEW)

Pure JSON persistence — no events, no nudger coupling.

```ts
export class InboxStore {
  constructor(stateDir: string);                                  // stateDir is <projectStateDir>
  put(entry: InboxEntry): void;                                   // overwrites by id
  get(staffId: string, entryId: string): InboxEntry | undefined;
  list(staffId: string): InboxEntry[];                            // FIFO
  listPending(staffId: string): InboxEntry[];
  update(staffId: string, entryId: string, updates: Partial<Omit<InboxEntry, "id" | "staffId" | "createdAt">>): boolean;
  remove(staffId: string, entryId: string): boolean;
  /** Wipe an entire staff's inbox file. Called from StaffManager.deleteStaff. */
  removeAll(staffId: string): void;
}
```

Owned by `ProjectContext` (`src/server/agent/project-context.ts`) alongside `staffStore`:

```ts
readonly inboxStore: InboxStore;                                  // NEW
this.inboxStore = new InboxStore(this.stateDir);                  // NEW, next to staffStore
```

Lazy file load per-staff (read on first `list*(staffId)` call) keeps startup cost flat regardless of staff count.

### 3.2 `src/server/agent/inbox-manager.ts` (NEW)

Cross-store façade. Resolves the per-staff store via `ProjectContextManager`, emits WS events, calls into the nudger.

```ts
export class InboxManager {
  constructor(
    private pcm: ProjectContextManager,
    private staffManager: StaffManager,
    private broadcastToAll: (event: unknown) => void,
  );

  /** Used by StaffManager.deleteStaff to wipe the inbox when a staff is deleted. */
  setNudger(nudger: InboxNudger): void;

  enqueue(staffId: string, input: {
    title: string;
    prompt: string;
    context?: string;
    source: InboxEntrySource;
  }): InboxEntry;

  listForStaff(staffId: string, state?: InboxEntryState, limit?: number): InboxEntry[];

  /** Called by inbox_complete handler. Validates entry is pending. */
  transitionToCompleted(staffId: string, entryId: string, summary?: string): InboxEntry;

  /** Called by inbox_dismiss handler. outcome ∈ {"failed", "cancelled"}. */
  transitionToTerminal(
    staffId: string,
    entryId: string,
    outcome: Exclude<InboxEntryState, "pending" | "completed">,
    reason: string,
  ): InboxEntry;

  /** Manual UI/API prune. */
  remove(staffId: string, entryId: string): boolean;
}
```

Responsibilities:

- Resolves the `InboxStore` for a staff by looking up the staff's `projectId` via `StaffManager.findStoreForStaff` (mirror the private helper or add a public `getProjectIdForStaff(id)`).
- Sets `id = randomUUID()`, `createdAt = Date.now()`, `state = "pending"` on enqueue.
- Emits one WS event per mutation (see §7).
- Calls `nudger.poke(staffId)` synchronously after enqueue so an idle staff is woken on the next tick *or earlier* if poke takes the fast path.
- Owned by `server.ts` boot (singleton, instantiated alongside `staffManager` and `teamManager`).

### 3.3 `src/server/agent/inbox-nudger.ts` (NEW)

15-second tick loop. Mirrors `TeamManager.startIdleNudgeTimer` / `shouldSkipNudge` / `nudgePending` (`src/server/agent/team-manager.ts:148, 384, 419`).

```ts
export class InboxNudger {
  /** Lifecycle */
  start(): void;
  stop(): void;

  /** Synchronous hint from InboxManager.enqueue — schedules a tick on the next macrotask so we wake an idle staff with zero tick latency. */
  poke(staffId: string): void;

  /** Wire from session-manager: clears nudgePending so a fresh batch can be sent next idle. */
  onAgentStart(sessionId: string): void;

  private intervalHandle: ReturnType<typeof setInterval> | null;
  private nudgePending = new Map<string, boolean>();        // staffId → in-flight

  private tick(): void;
  private applyPolicyThenNudge(staff: PersistedStaff, count: number): Promise<void>;
  private runCompact(sessionId: string): Promise<void>;
}
```

Pseudocode in §5.

### 3.4 Tool group: `defaults/tools/inbox/` (NEW)

Mirrors `defaults/tools/tasks/` structure: one YAML manifest per tool + a single `extension.ts` that registers them via `pi.registerTool`. Loaded by `mcp-manager` like all other groups.

| File | Purpose |
|---|---|
| `defaults/tools/inbox/inbox_list.yaml` | manifest — params: `state?`, `limit?` |
| `defaults/tools/inbox/inbox_complete.yaml` | manifest — params: `entry_id`, `summary?` |
| `defaults/tools/inbox/inbox_dismiss.yaml` | manifest — params: `entry_id`, `outcome`, `reason` |
| `defaults/tools/inbox/extension.ts` | runtime registration + HTTP calls to REST API |

Target descriptions (≤ 150 chars each, per `tests/tool-description-budget.test.ts:47`):

| Tool | description (≤150) |
|---|---|
| `inbox_list` | `List inbox entries for this staff agent. Defaults to pending entries.` (~71) |
| `inbox_complete` | `Mark an inbox entry as completed with an optional result summary.` (~66) |
| `inbox_dismiss` | `Dismiss an inbox entry as failed or cancelled with a reason.` (~62) |

Parameter descriptions ≤ 80 chars (per `tests/tool-description-budget.test.ts:48`).

Add `"inbox"` to `EXTENSION_FILES` in `tests/tool-description-budget.test.ts:30` so the new group is included in the budget pin.

Gating: §6.

### 3.5 UI components

| File | Status | Responsibility |
|---|---|---|
| `src/app/inbox-panel.ts` | NEW | Mirrors `src/app/preview-panel.ts`. Owns the per-session subscription lifecycle, maps WS `inbox.entry.*` events into `state.inboxEntries`, exposes `startInboxSubscription(sessionId)` / `stopInboxSubscription()`. |
| `src/ui/inbox/InboxPanel.ts` | NEW | LitElement `<inbox-panel>`. Renders Pending section + History section + Add-to-inbox button. Mirrors `src/ui/components/review/ReviewPane.ts` shape. |
| `src/ui/inbox/InboxEntry.ts` | NEW | Single-row item: title, source badge, age, cancel/delete affordances. |
| `src/ui/inbox/AddToInboxDialog.ts` | NEW | Composer dialog opened from the panel's "Add to inbox" button. Posts to `POST /api/staff/:id/inbox` with `source.type = "manual_ui"`. |
| `src/app/staff-page.ts` | EDIT | Adds the `contextPolicy` radio group in the edit form (between "Pinned Context" and the save bar; see §8). |
| `src/app/state.ts` | EDIT | New fields: `inboxEntries`, `inboxPanelOpen` (mirrors `reviewPanelOpen`, `state.ts:328`). |
| `src/app/main.ts` | EDIT | Extends `canFullscreen` / `hasPanel` checks (`main.ts:548-549, 608, 632`) to include `state.inboxPanelOpen` so the existing `Ctrl+]` / `Ctrl+[` shortcuts treat inbox as a peer of preview/review/proposal. |
| `src/app/render.ts` | EDIT | Renders `<inbox-panel>` in the split-pane slot when the active session has `staffId` set. |
| `src/app/session-manager.ts` | EDIT | On session select: clear `state.inboxEntries`; if `session.staffId` set, call `startInboxSubscription(session.id)`. Resets on session switch (matches the `state.reviewDocuments = new Map()` pattern at `session-manager.ts:860-862`). |

### 3.6 Test files (NEW)

| File | Scenarios |
|---|---|
| `tests/inbox-store.spec.ts` | put/get/list/listPending/update/remove/removeAll round-trip; FIFO order; isolated tmp `stateDir`. |
| `tests/inbox-manager.spec.ts` | enqueue creates pending entry + WS event; transitionToCompleted only allowed from pending; rejects unknown staff/entry; nudger.poke called once per enqueue. |
| `tests/inbox-nudger.spec.ts` | Fake clock (`node:test` `mock.timers`). Idle staff + pending entries → wake. Streaming staff → no wake. `nudgePending` gates re-nudge until `agent_start`. compact policy invokes `session.rpcClient.compact` before enqueuing wake prompt. |
| `tests/e2e/inbox-api.spec.ts` | REST: POST /api/staff/:id/inbox enqueues. GET ?state=pending returns it. DELETE prunes. Inbox tools (impersonated via direct HTTP) transition state. Modelled on `tests/e2e/staff.spec.ts`. |
| `tests/e2e/ui/staff-inbox.spec.ts` | Browser E2E: navigate to staff session, open inbox panel, add manual entry, assert it appears, reload page, assert persistence, cancel entry, assert removal. Modelled on `tests/e2e/ui/settings.spec.ts`. |

---

## 4. Data flow

### 4.1 Trigger fires → entry processed

```
TriggerEngine.tick (60s, staff-trigger-engine.ts:122)
  └─ checkScheduleTrigger / checkGitTrigger
       └─ fireTrigger(staff, trigger, extraContext)
            └─ inboxManager.enqueue(staff.id, { title, prompt, context, source: {type:"trigger", triggerId}})
                 ├─ store.put(entry)                          // persisted
                 ├─ broadcastToAll(WS inbox.entry.added)
                 └─ nudger.poke(staff.id)                     // synchronous hint
                                                              //  (next tick, no setTimeout)

InboxNudger.tick (15s)
  └─ for each active staff with idle session + pending entries + !nudgePending:
       └─ applyPolicyThenNudge(staff, count)
            ├─ nudgePending.set(staff.id, true)
            ├─ if contextPolicy === "compact": await runCompact(session.id)
            └─ sessionManager.enqueuePrompt(session.id,
                 "[INBOX] You have N pending item(s). Use inbox_list ...",
                 { isSteered: true })

Agent (woken)
  └─ inbox_list                                              // sees N pending
       └─ inbox_complete(entry_id, summary)  for each       // OR
       └─ inbox_dismiss(entry_id, outcome, reason)          //

  Each tool → HTTP call → InboxManager.transition* → store.update → WS inbox.entry.updated

agent_end                                                    // session goes idle again
  └─ nudgePending cleared on agent_start of NEXT prompt      // (see §5 hook)
```

### 4.2 Manual UI enqueue

```
UI: "Add to inbox" button
  └─ AddToInboxDialog (composer)
       └─ fetch POST /api/staff/:id/inbox  { title, prompt, source:{type:"manual_ui"} }
            └─ server.ts handler
                 └─ inboxManager.enqueue(...)   // identical to trigger path from here
```

### 4.3 Re-nudge after agent idles with entries still pending

```
Tick T:    staff idle + 3 pending → nudge ("3 pending"). nudgePending=true.
Tick T+1:  staff streaming.        → skip (status !== "idle").
...
agent_start                        → nudgePending.delete(staff.id).
agent_end → session.status = idle.
Tick T+k:  staff idle.
           If pending count > 0 (agent didn't process them all):
              → nudge again ("2 pending"). nudgePending=true.

NO exponential backoff. Inbox nudges only fire against idle agents (no productive
work is being interrupted), so unbounded re-nudge is safe. Contrast with
TeamManager (team-manager.ts:447-451) where backoff caps interruption pressure
on a working lead.
```

---

## 5. Nudger details

### 5.1 Tick (full pseudocode)

```ts
class InboxNudger {
  private static readonly TICK_INTERVAL_MS = 15_000;

  start() {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => this.tick(), InboxNudger.TICK_INTERVAL_MS);
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = null;
  }

  poke(staffId: string) {
    // Schedule a one-shot tick on the next macrotask. Coalesces with the
    // periodic tick — if we're already inside one, this is a no-op.
    queueMicrotask(() => this.tickOne(staffId));
  }

  private tick() {
    for (const staff of this.staffManager.listStaff()) this.tickOne(staff.id, staff);
  }

  private tickOne(staffId: string, staff?: PersistedStaff) {
    staff ??= this.staffManager.getStaff(staffId);
    if (!staff || staff.state !== "active") return;
    if (!staff.currentSessionId) return;
    const session = this.sessionManager.getSession(staff.currentSessionId);
    if (!session || session.status !== "idle") return;        // mirrors team-manager.ts:388
    if (this.nudgePending.get(staff.id)) return;
    const pending = this.inboxStore.listPending(staff.id);
    if (pending.length === 0) return;
    void this.applyPolicyThenNudge(staff, pending.length);
  }

  private async applyPolicyThenNudge(staff: PersistedStaff, count: number) {
    this.nudgePending.set(staff.id, true);
    try {
      if (staff.contextPolicy === "compact") {
        await this.runCompact(staff.currentSessionId!);
      }
      const word = count === 1 ? "item" : "items";
      const msg =
        `[INBOX] You have ${count} pending ${word}. ` +
        `Use inbox_list to inspect, then process each with inbox_complete or inbox_dismiss.`;
      await this.sessionManager.enqueuePrompt(staff.currentSessionId!, msg, { isSteered: true });
    } catch (err) {
      this.nudgePending.delete(staff.id);                     // allow retry on next tick
      console.error(`[inbox-nudger] applyPolicyThenNudge failed for ${staff.id}:`, err);
    }
  }

  private async runCompact(sessionId: string) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || session.status !== "idle") return;        // double-check race
    // Same call surface as ws/handler.ts:600 — bypass the WS handler, no sidecar
    // accounting needed here (compact-as-prelude isn't a user-visible operation).
    await session.rpcClient.compact(120_000);
  }
}
```

### 5.2 `agent_start` hook wiring

`SessionManager.handleEvent` already routes `agent_start` (`src/server/agent/session-manager.ts:1853`). Wire an event subscription matching `TeamManager.subscribeTeamLeadEvents` (`team-manager.ts:543-560`):

- Subscribe to `session.rpcClient.onEvent` once per staff session at `InboxNudger.start()` and re-subscribe lazily inside `tickOne` when the session pointer changes.
- On `event.type === "agent_start"`: `this.nudgePending.delete(staffId)`.

A simpler equivalent: in `InboxNudger.start()`, register a session-level listener via `sessionManager.addSessionStatusListener(...)` (existing surface used by team manager) keyed on the staff's `currentSessionId`. Either approach is acceptable; concrete choice during implementation. The contract is: `nudgePending` clears the moment the agent begins streaming after a nudge.

### 5.3 Interaction with `TeamManager` nudge timer

Independent timers, no shared infra:

- `TeamManager` nudges **team leads** working on **goals**. Tick interval is dynamic (per-goal `setTimeout` with exponential backoff). Lives on `entry.teamLeadSessionId`.
- `InboxNudger` nudges **staff** working on **inbox entries**. Single global 15 s `setInterval`. Lives on `staff.currentSessionId`.

A session can't be both (staff sessions have `staffId` set, team-lead sessions have `goalId` + role=team-lead), so the two never race for the same session. Both share `sessionManager.enqueuePrompt(..., { isSteered: true })` as the delivery mechanism — but on disjoint sessions.

### 5.4 Why 15 s tick, no backoff

- 15 s is the maximum visible nudge latency for a freshly-idle staff. Trigger latency is `min(60 s trigger poll, 15 s nudger) + compact time`. The synchronous `poke` after `enqueue` brings down latency for the *enqueue → nudge* edge to ~0; the 15 s only governs *idle → nudge* after a long-running task.
- No backoff because inbox nudges only fire against idle agents, by construction. We are not "interrupting productive work" — we are notifying an idle worker that work exists. Re-nudging on every fresh idle is the desired UX. If observed nudge-spam becomes a problem (e.g. agent loops between idle and one-token agent_start), add backoff then.

---

## 6. Tool gating

Inbox tools are useless and dangerous on non-staff sessions: they'd point at no `staffId` and either 400 or silently mutate an unrelated staff's inbox.

**Gating lives in the extension entry-point.** Pattern (mirrors `defaults/tools/tasks/extension.ts:18-22` which early-returns when `goalId` is missing):

```ts
// defaults/tools/inbox/extension.ts
export default function (pi: ExtensionAPI) {
  const sessionId = process.env.BOBBIT_SESSION_ID;
  const staffId   = process.env.BOBBIT_STAFF_ID;        // already set in session-manager.ts:2749
  if (!sessionId || !staffId) {
    return;                                              // tools not registered
  }
  // ... pi.registerTool(...) for inbox_list / inbox_complete / inbox_dismiss
}
```

The agent process for a non-staff session never has `BOBBIT_STAFF_ID` in its env (see `session-manager.ts:2748-2750`), so the extension is a no-op there and the tools are not exposed in the tool catalogue. No further server-side check needed.

For defence-in-depth, the REST handlers behind the tools (POST `/api/staff/:id/inbox/:entryId/complete`, `…/dismiss`) re-verify that the calling session's `staffId` matches the path `:id`. See §7 for the exact body shape.

---

## 7. REST + WebSocket surface

### 7.1 Routes (added to `server.ts::handleApiRoute()`, beside the existing staff routes at `server.ts:8025-8152`)

| Method | Path | Body | 2xx response | Errors |
|---|---|---|---|---|
| `GET` | `/api/staff/:id/inbox?state=pending&limit=50` | — | `{ entries: InboxEntry[] }` | `404` (staff not found) |
| `POST` | `/api/staff/:id/inbox` | `{ title: string, prompt: string, context?: string, source?: { type?: "manual_api" \| "manual_ui", actorId?: string } }` | `201 { entry: InboxEntry }` | `404`, `400` (missing fields) |
| `POST` | `/api/staff/:id/inbox/:entryId/complete` | `{ sessionId: string, summary?: string }` | `200 { entry: InboxEntry }` | `404`, `409` (entry not pending), `403` (sessionId.staffId !== :id) |
| `POST` | `/api/staff/:id/inbox/:entryId/dismiss` | `{ sessionId: string, outcome: "failed" \| "cancelled", reason: string }` | `200 { entry: InboxEntry }` | `404`, `409`, `403` |
| `DELETE` | `/api/staff/:id/inbox/:entryId` | — | `200 { ok: true }` | `404` |

The `complete` / `dismiss` POSTs are the API surface the inbox tools hit. `sessionId` in the body is matched against the session's `staffId` for the defence-in-depth check in §6.

### 7.2 Removal of legacy `POST /api/staff/:id/wake`

`server.ts:8131-8145` is deleted. UI's "Wake Now" button (`src/app/staff-page.ts:504` — `handleWake` calls `wakeStaffAgent`) is rewired to call `POST /api/staff/:id/inbox` with `source.type = "manual_ui"`, title = `"Manual wake"`, prompt = the existing optional wake message. The `api.ts::wakeStaffAgent` helper is renamed `enqueueInboxManual` and its return shape changes from `{ sessionId }` to `{ entry }`.

### 7.3 WebSocket events

Three new events broadcast via `broadcastToAll` (mirrors `task_changed`, `gate_status_changed`). Add to `ServerMessage` union in `src/server/ws/protocol.ts:64-101`:

```ts
| { type: "inbox.entry.added";   staffId: string; entry: InboxEntry }
| { type: "inbox.entry.updated"; staffId: string; entry: InboxEntry }
| { type: "inbox.entry.removed"; staffId: string; entryId: string }
```

Names use **dotted** convention (`inbox.entry.added`) as specified in the goal spec. *Note for the implementer:* this is **not** the convention used elsewhere in `protocol.ts` (which uses snake_case `task_changed`, `gate_status_changed`). Stick with the dotted form because the goal spec is explicit; ignore the discrepancy. If the project later normalises to a single convention, this will be one of the rename targets.

Clients filter by `staffId` (the staff page's inbox panel and the staff session view each subscribe to events for their `staffId`).

---

## 8. UI architecture

### 8.1 Panel parallelism with `preview-panel.ts`

`src/app/inbox-panel.ts` (NEW) mirrors `src/app/preview-panel.ts` 1:1:

```ts
// State
let currentSid: string | null = null;

// API
export function startInboxSubscription(sessionId: string): void;
export function stopInboxSubscription(): void;
```

Differences:
- No SSE; the WebSocket already carries the events. The subscription is just a session-id pointer + a render reset.
- Bootstrap fetch: `GET /api/staff/:id/inbox?state=pending` then `GET /api/staff/:id/inbox?state=completed&limit=100` for history. Result populates `state.inboxEntries`.
- WS handler in `src/app/remote-agent.ts` adds a case for `inbox.entry.*` that mutates `state.inboxEntries` and calls `renderApp()` (mirrors the existing `review_open` handler at `remote-agent.ts:1763-1792`).

### 8.2 App state additions (`src/app/state.ts`)

Add next to `reviewPanelOpen` (`state.ts:328`):

```ts
/** Inbox panel (per-session split panel for staff session views) */
inboxEntries: [] as InboxEntry[],          // pending + recent terminal, populated on session select
inboxPanelOpen: false,                     // collapsed/open toggle, persisted per-session via localStorage
inboxAddDialogOpen: false,                 // manual enqueue dialog
```

`inboxPanelOpen` is hydrated from `localStorage` keyed by session id (mirror `bobbit-preview-collapsed-${sid}` pattern in `main.ts:551`).

### 8.3 Keyboard shortcut wiring (`src/app/main.ts`)

Three sites at `main.ts:548-559`, `main.ts:608`, `main.ts:632-643`. Extend the existing predicates by treating the inbox as another panel-bearing session type:

```ts
// Before
const canFullscreen = !state.assistantType && (state.isPreviewSession || state.reviewPanelOpen);
const hasPanel = canFullscreen || (!state.assistantType && state.activeProposals.goal != null);

// After
const isInboxSession = !!state.activeSession?.staffId;
const canFullscreen = !state.assistantType && (state.isPreviewSession || state.reviewPanelOpen || isInboxSession);
const hasPanel = canFullscreen || (!state.assistantType && state.activeProposals.goal != null);
```

`Ctrl+]` collapses one level; `Ctrl+[` expands one level; per-session collapse state is stored under the existing `bobbit-preview-collapsed-${activeSessionId()}` key (the panels are mutually exclusive on a given session — a session is either preview-bearing, review-bearing, or inbox-bearing).

### 8.4 Manual-enqueue dialog

`src/ui/inbox/AddToInboxDialog.ts` (NEW) — modal triggered from the panel's "+ Add to inbox" button. Two fields:
- Title (single line)
- Prompt (multi-line)

Submits `POST /api/staff/:id/inbox` with `{ title, prompt, source: { type: "manual_ui" } }`. The added entry arrives via WS and is rendered into the Pending section.

### 8.5 `contextPolicy` radio in staff edit form

Insert into `src/app/staff-page.ts::renderEditView` between the "Pinned Context" textarea (`staff-page.ts:670-678`) and the save bar (`staff-page.ts:680-694`):

```html
<div>
  <label class="text-xs text-muted-foreground mb-1.5 block font-medium">Context Policy</label>
  <p class="text-[10px] text-muted-foreground mb-1">
    What happens before a wake digest is sent when the inbox has pending entries.
  </p>
  <div class="flex gap-3">
    <!-- radio: preserve -->
    <!-- radio: compact (default) -->
  </div>
</div>
```

`editContextPolicy` is added to the page-local state (`staff-page.ts:22-39`) and threaded through `handleSave` (which `PUT`s to `/api/staff/:id`). Add `contextPolicy` to the body accepted by `server.ts:8107-8121` and the `StaffStore.update` `Partial` type.

### 8.6 Sidebar — explicit non-change

No sidebar badge. No pending-count affordance anywhere. The staff session continues to appear as a normal sidebar entry under the staff section; the inbox panel attached to the session view is the only inbox UI surface. Stated in goal spec; called out here so the implementer doesn't accidentally add a count.

### 8.7 Reference: review pane

There is no top-level `userstories/review-pane.md` in the repo (verified). The closest references are:
- `src/ui/components/review/ReviewPane.ts` — the `<review-pane>` LitElement.
- `src/ui/components/review/review-pane.css` — collapsible split-pane layout.
- `src/app/remote-agent.ts:1763-1792` — the agent → WS → panel-open flow used by `review_open`.

The inbox panel is structurally identical: tabbed/sectioned LitElement, collapsible split, per-session open/closed state in localStorage, reload-persistent because state is rehydrated from REST on session select.

---

## 9. Migration plan

`staffManager.wake()` is **deleted**, not deprecated. Three in-tree call sites must be migrated:

### 9.1 `src/server/agent/staff-trigger-engine.ts:227`

**Before**

```ts
private async fireTrigger(staff: PersistedStaff, trigger: StaffTrigger, extraContext?: string): Promise<void> {
  // ...
  this.wakingInProgress.add(staff.id);
  this.staffManager.updateTriggerState(staff.id, trigger.id, { lastFired: Date.now() });

  let prompt = trigger.prompt || `Trigger fired: ${trigger.type}`;
  if (extraContext) prompt += "\n\n" + extraContext;

  try {
    await this.staffManager.wake(staff.id, prompt, this.sessionManager);
  } catch (err) { /* ... */ }
  finally { this.wakingInProgress.delete(staff.id); }
}
```

**After**

```ts
private fireTrigger(staff: PersistedStaff, trigger: StaffTrigger, extraContext?: string): void {
  this.staffManager.updateTriggerState(staff.id, trigger.id, { lastFired: Date.now() });

  let prompt = trigger.prompt || `Trigger fired: ${trigger.type}`;
  if (extraContext) prompt += "\n\n" + extraContext;

  this.inboxManager.enqueue(staff.id, {
    title: `${trigger.type}: ${trigger.config.cron ?? trigger.config.branch ?? trigger.id}`,
    prompt,
    context: extraContext,
    source: { type: "trigger", triggerId: trigger.id },
  });
}
```

Also drop `wakingInProgress` (the field at `staff-trigger-engine.ts:104`) and the streaming/starting skip at `staff-trigger-engine.ts:130-133` — both exist solely because `wake()` was racey. `inboxManager.enqueue()` is synchronous against the JSON file and always safe.

Constructor signature gains `inboxManager: InboxManager` (passed from `server.ts` boot).

### 9.2 `src/server/server.ts:8131-8145`

**Before**

```ts
// POST /api/staff/:id/wake — manually trigger a wake cycle
const staffWakeMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/wake$/);
if (staffWakeMatch && req.method === "POST") {
  const id = staffWakeMatch[1];
  const staff = staffManager.getStaff(id);
  if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
  const body = await readBody(req);
  try {
    const sessionId = await staffManager.wake(id, body?.prompt, sessionManager);
    json({ sessionId }, 201);
  } catch (err) { jsonError(400, err); }
  return;
}
```

**After**

The whole block is **deleted**. The new `POST /api/staff/:id/inbox` route from §7 supersedes it. UI's "Wake Now" button switches to that endpoint (§7.2).

### 9.3 `src/server/agent/staff-manager.ts:426-430`

**Before** (inside `wake()`, legacy-migration branch):

```ts
const session = sessionManager.getSession(staff.currentSessionId);
if (!session || session.status === "terminated") {
  try { await sessionManager.ensureSessionAlive(staff.currentSessionId); }
  catch {
    console.log(`[staff-manager] Session ${staff.currentSessionId} unrecoverable, creating new one for "${staff.name}"`);
    store.update(staffId, { currentSessionId: undefined as any });
    staff.currentSessionId = undefined as any;
    return this.wake(staffId, prompt, sessionManager);   // ← recursion
  }
}
```

**After**

`wake()` is deleted as a public method. The session-recovery logic (`ensureSessionAlive` + recreate fallback) is folded into a new private helper `staffManager.ensureSessionForStaff(staffId)`:

```ts
async ensureSessionForStaff(staffId: string, sessionManager: SessionManager): Promise<string> {
  const found = this.findStoreForStaff(staffId);
  if (!found) throw new Error("Staff agent not found");
  const { store, staff } = found;

  if (!staff.currentSessionId) {
    // ... existing legacy-migration createSession block from staff-manager.ts:391-417 ...
    return session.id;
  }

  const session = sessionManager.getSession(staff.currentSessionId);
  if (!session || session.status === "terminated") {
    try { await sessionManager.ensureSessionAlive(staff.currentSessionId); }
    catch {
      store.update(staffId, { currentSessionId: undefined as any });
      staff.currentSessionId = undefined as any;
      return this.ensureSessionForStaff(staffId, sessionManager);
    }
  }
  return staff.currentSessionId;
}
```

`InboxNudger.tickOne` calls `ensureSessionForStaff` *only when it has decided to nudge*, ensuring the subprocess is alive before `applyPolicyThenNudge`. Trigger-engine enqueues without touching session state at all — entries accumulate against a dead session and the nudger picks them up after recovery.

`StaffManager.refreshWorktree` (`staff-manager.ts:283-340`) moves into `ensureSessionForStaff` as the rebase step (preserve its current call-before-wake semantics).

`createStaff` keeps `currentSessionId` initialisation as-is; no change.

The `lastWakeAt` update at `staff-manager.ts:413, 456` moves to `InboxNudger.applyPolicyThenNudge` (set right before the `enqueuePrompt` call).

### 9.4 Confirmed deletions

- `StaffManager.wake` — removed entirely.
- `POST /api/staff/:id/wake` — removed entirely.
- `TriggerEngine.wakingInProgress` field + the streaming/starting skip — removed.

No compatibility shim. There are no external callers (verified: only the three sites above ref `wake`).

---

## 10. Out of scope

Restated from the goal spec for the implementer's convenience:

- **`contextPolicy: "clear"`** — terminate + respawn subprocess with fresh jsonl. Deferred; the enum is forward-compatible.
- **Coalescing / dedup** of pending entries. Every enqueue produces a new entry. Agent dedupes via `inbox_list`.
- **Memory-editing tool for staff.** Memory remains editable only via the UI (`staff-page.ts:672-678`).
- **Auto-cancel / "stuck entry" surfacing.** Pending is pending. Only the agent or the user resolves entries.
- **Exponential backoff for re-nudges.** Add later if observed spamming.
- **Search index ingestion of completed inbox entries.** Entries are addressable via REST but not in the cross-project search.

---

## 11. Open questions / risks

| # | Question | Working answer |
|---|---|---|
| 1 | Does `runCompact` block too long? `session.rpcClient.compact(120_000)` can take seconds-to-minutes. | Awaiting it serially is correct — the digest message must be delivered *into* a freshly-compacted context. The 15 s tick is non-overlapping per-staff via `nudgePending`. If a compact stalls past 120 s the RPC rejects and the catch in `applyPolicyThenNudge` clears `nudgePending` for retry on next tick. |
| 2 | What if the staff session is `"starting"` (not `"idle"`)? | The nudger only fires on `status === "idle"` (matches `team-manager.ts:388`). `"starting"` returns false and the nudger retries next tick. No drop — entries remain pending. |
| 3 | What if an inbox entry references a deleted staff? | `StaffManager.deleteStaff` calls `inboxManager.removeAll(staffId)` (via the WS-broadcast wrapper). No dangling files. If somehow an entry survives (manual file edit), `InboxNudger.tickOne` returns early via the `staffManager.getStaff()` null check; tools 404 the entry. |
| 4 | Concurrent enqueue from trigger + manual UI on the same idle staff? | Both append distinct entries (no coalescing). Both call `nudger.poke()`. The poke microtask is idempotent — one tick processes the batch (count = 2) with one digest. |
| 5 | Does `poke` race the 15 s `setInterval`? | The `queueMicrotask`-scheduled `tickOne(staffId)` and the periodic `tick()` both consult `nudgePending` first. Worst case: one redundant call, gated to a no-op by the `nudgePending.get(...)` check. |
| 6 | What happens during server restart with a streaming staff session? | Restart restores sessions to `idle` (assuming graceful) and `inboxStore.load()` reads pending entries off disk. First tick after boot nudges. |
| 7 | Sandboxed staff — does compact work? | Yes; compact is an RPC over the bridge, not a host-side filesystem op. Sidecar entries land at `<projectStateDir>/compaction-sidecar/<sessionId>.jsonl` regardless of sandbox (per `compaction-sidecar.ts:11-13`). |

---

## 12. Idempotency contract

**The agent is responsible for idempotency.** Re-running an inbox entry is, in general, *not* idempotent (e.g. "post a daily digest to Slack" twice posts twice). Constraints:

- The server never auto-cancels or auto-completes entries. State transitions are exclusively driven by `inbox_complete` / `inbox_dismiss` tool calls.
- The agent must re-read its memory (`PersistedStaff.memory`, surfaced in the system prompt's "Pinned Context" section) and any external side-effect log it maintains *before* re-doing work for a given trigger.
- Two enqueues from the same trigger (e.g. cron fires twice during a long compaction) are distinct entries. The agent must inspect title / source / timestamp and dedupe in its own head.
- `inbox_complete` is the *only* way to record "this work is done". Dismissing with `outcome="cancelled"` is the "I see this but won't act on it" signal; with `outcome="failed"` is the error signal. Neither requires a retry — the user inspects and re-enqueues if needed.

The system prompt addendum for staff agents (rendered into the wake digest, not a permanent prompt change) is the only place this contract is reinforced at runtime. The full contract belongs in the staff system prompt template the assistant generates; that template lives in `src/server/agent/staff-assistant.ts` and is editable by staff creators.

---

## 13. Test plan summary

Cross-references the goal spec's step 9.

| File | Layer | Scenarios |
|---|---|---|
| `tests/inbox-store.spec.ts` | unit (file://) | `put`/`get`/`list`/`listPending`/`update`/`remove`/`removeAll` with isolated tmp `stateDir`. FIFO ordering. Reload from disk recovers state. Concurrent put on the same staff id collapses to last-writer-wins (mirrors `StaffStore` behaviour). |
| `tests/inbox-manager.spec.ts` | unit | `enqueue` emits `inbox.entry.added` and calls `nudger.poke(staffId)` exactly once. `transitionToCompleted` rejects non-pending. `transitionToTerminal` rejects unknown id with 404 semantics. `remove` emits `inbox.entry.removed`. Reject unknown staff id. |
| `tests/inbox-nudger.spec.ts` | unit (fake clock via `node:test` `mock.timers`) | Idle staff + pending → wake exactly once until `agent_start` clears `nudgePending`. Streaming staff → no wake. Starting staff → no wake. `contextPolicy="compact"` calls `session.rpcClient.compact(120_000)` before `enqueuePrompt`. `contextPolicy="preserve"` skips compact. `poke()` fast-paths a wake within one microtask. Empty inbox → no wake. |
| `tests/e2e/inbox-api.spec.ts` | API E2E (in-process gateway) | `POST /api/staff/:id/inbox` returns 201 with pending entry. `GET /api/staff/:id/inbox?state=pending` lists it. `GET ?state=completed` excludes it. `POST /api/staff/:id/inbox/:entryId/complete` (with valid `sessionId.staffId === :id`) transitions state. `…/dismiss` with `outcome="failed"` and `reason` transitions. `DELETE /api/staff/:id/inbox/:entryId` prunes. 403 on `sessionId` whose `staffId` doesn't match. 404 on unknown staff/entry. 409 on non-pending entry transition. |
| `tests/e2e/ui/staff-inbox.spec.ts` | Browser E2E (spawned gateway) | Open app → navigate to a staff session (created via REST in the `beforeAll`) → inbox panel visible → "+ Add to inbox" opens dialog → submit → entry appears in Pending section → reload page → entry still there (persistence) → click Cancel on entry → entry moves to History section (state=cancelled) → click delete in history → entry removed. Toggle Ctrl+] to collapse the panel; reload; assert collapsed state is restored from localStorage. Required by AGENTS.md ("every user-facing feature MUST have a browser E2E"). |
| `tests/tool-description-budget.test.ts` | unit (existing — extended) | Add `"inbox"` to `EXTENSION_FILES`. Existing assertions automatically enforce the 150-char / 80-char budgets on the three new tools. |
| `tests/staff-trigger-engine.test.ts` | unit (existing — updated) | Replace `wake()` assertions with `inboxManager.enqueue()` assertions. Confirm the streaming/starting skip is gone (trigger always enqueues regardless of session state). |

Run order:
1. `npm run check` after wiring the new files.
2. `npm run test:unit` for the four new unit specs and the updated trigger-engine test.
3. `npm run test:e2e` for the API + browser E2Es.
4. Optional: `npm run test:manual` to confirm the nudger drives a real staff agent end-to-end.

---

## Appendix A — file inventory

| Path | Status | Why |
|---|---|---|
| `src/server/agent/inbox-store.ts` | NEW | Per-staff JSON persistence. |
| `src/server/agent/inbox-manager.ts` | NEW | Cross-store façade + WS events + nudger.poke. |
| `src/server/agent/inbox-nudger.ts` | NEW | 15 s tick loop + applyPolicyThenNudge. |
| `src/server/agent/project-context.ts` | EDIT | Instantiate `inboxStore`. |
| `src/server/agent/staff-store.ts` | EDIT | Add `contextPolicy` to `PersistedStaff` + normalise on load. |
| `src/server/agent/staff-manager.ts` | EDIT | Delete `wake()`. Add `ensureSessionForStaff()`. Call `inboxManager.removeAll()` on delete. |
| `src/server/agent/staff-trigger-engine.ts` | EDIT | Replace `wake()` with `inboxManager.enqueue()`. Drop streaming/starting skip + `wakingInProgress`. |
| `src/server/agent/session-manager.ts` | EDIT | Add `agent_start` hook wiring for `InboxNudger.onAgentStart(sessionId)`. |
| `src/server/server.ts` | EDIT | New REST routes + delete `/wake` route. Instantiate `inboxManager`, `inboxNudger`. Wire `broadcastToAll`. |
| `src/server/ws/protocol.ts` | EDIT | Add three `inbox.entry.*` event types to `ServerMessage`. |
| `defaults/tools/inbox/inbox_list.yaml` | NEW | Tool manifest. |
| `defaults/tools/inbox/inbox_complete.yaml` | NEW | Tool manifest. |
| `defaults/tools/inbox/inbox_dismiss.yaml` | NEW | Tool manifest. |
| `defaults/tools/inbox/extension.ts` | NEW | Tool runtime + REST plumbing. Gates on `BOBBIT_STAFF_ID`. |
| `src/app/state.ts` | EDIT | `inboxEntries`, `inboxPanelOpen`, `inboxAddDialogOpen`. |
| `src/app/inbox-panel.ts` | NEW | Subscription lifecycle, REST bootstrap, WS event → state diff. |
| `src/app/main.ts` | EDIT | Extend `canFullscreen` / `hasPanel` to include inbox sessions. |
| `src/app/remote-agent.ts` | EDIT | Handle `inbox.entry.*` WS events. |
| `src/app/render.ts` | EDIT | Mount `<inbox-panel>` for staff sessions. |
| `src/app/session-manager.ts` | EDIT | Start/stop inbox subscription on session select. |
| `src/app/staff-page.ts` | EDIT | `contextPolicy` radio + thread through `handleSave`. Rewire "Wake Now" to `/inbox` POST. |
| `src/app/api.ts` | EDIT | Replace `wakeStaffAgent` with inbox enqueue helpers. |
| `src/ui/inbox/InboxPanel.ts` | NEW | LitElement `<inbox-panel>`. |
| `src/ui/inbox/InboxEntry.ts` | NEW | Single-row item component. |
| `src/ui/inbox/AddToInboxDialog.ts` | NEW | Manual enqueue composer. |
| `tests/inbox-store.spec.ts` | NEW | Unit. |
| `tests/inbox-manager.spec.ts` | NEW | Unit. |
| `tests/inbox-nudger.spec.ts` | NEW | Unit. |
| `tests/e2e/inbox-api.spec.ts` | NEW | API E2E. |
| `tests/e2e/ui/staff-inbox.spec.ts` | NEW | Browser E2E. |
| `tests/tool-description-budget.test.ts` | EDIT | Add `"inbox"` to `EXTENSION_FILES`. |
| `tests/staff-trigger-engine.test.ts` | EDIT | Re-target from `wake()` to `inboxManager.enqueue()`. |
