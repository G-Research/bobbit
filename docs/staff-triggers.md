# Staff Triggers

Triggers attached to a [staff agent](staff-agents.md) decide when work lands
in the staff's [inbox](staff-inbox.md). A staff record holds an array of
`StaffTrigger` entries. Legacy triggers use a `config` blob and may provide a
wake `prompt`. Notification triggers instead select a canonical committed fact
and an allowlisted exact-match filter; notification data is delivered as
host-owned metadata, never prompt text.

Triggers themselves never wake the agent directly — they `enqueue` an
inbox entry, and the [inbox nudger](staff-inbox.md#lifecycle) decides when
the staff is idle enough to receive the digest. That decoupling is the
whole point of the inbox; trigger plumbing only has to land the entry.

## Trigger types

There are three dispatch families:

- **Polled** triggers (`schedule`, `git`) are evaluated by
  `staff-trigger-engine.ts` on a 60 s tick.
- **Legacy push-based** triggers (`goal_created`, `goal_archived`) enqueue from
  their store callbacks. The `manual` type is enqueue-only.
- **Canonical notification** triggers consume a post-authority Host notification
  through a per-project durable subscriber outbox. They do not share state with
  the legacy trigger engine or goal dispatcher.

| Type | Dispatcher | `config` | `prompt` | Fires on |
|---|---|---|---|---|
| `schedule` | `staff-trigger-engine.ts` (60 s poll) | `{ cron, timezone? }` | optional (synthesised if blank) | Cron expression matches and `lastFired` is in a prior minute. |
| `git` | `staff-trigger-engine.ts` (60 s poll) | `{ event, branch?, repo? }` | optional (synthesised if blank) | Repository event observed since `lastSeenSha`. |
| `manual` | (no dispatcher) | `{}` | optional | User clicks "Wake Now" / "+ Add to inbox", or an integration `POST`s to `/api/staff/:id/inbox`. |
| `goal_created` | `goal-trigger-dispatcher.ts` (push, from `GoalStore.put`) | `{}` | **required** | A new goal id appears in any project's `GoalStore`. |
| `goal_archived` | `goal-trigger-dispatcher.ts` (push, from `GoalStore.archive`) | `{}` | **required** | A goal transitions from `archived: false` to `archived: true`. |
| `notification` | canonical Host notification dispatcher | `notification: { scope, name }`, `filter` | ignored for notification input | A committed catalogue fact matches the selector and every filter field. |

`manual` exists primarily so the UI can render a row with a "Wake Now"
affordance and so a `prompt` can be attached for ad-hoc one-clicks; the
trigger record itself is never matched against an event.

## Notification triggers

Use notification triggers when staff should react to a committed Bobbit fact rather than a
legacy poll or goal callback:

```json
{
  "id": "successful-example-tool",
  "type": "notification",
  "notification": {
    "scope": "session",
    "name": "toolCallCompleted"
  },
  "filter": {
    "toolName": "example_tool",
    "status": "succeeded"
  },
  "enabled": true
}
```

`id` may be omitted on create/update; the server generates one before validation. The selector
must use a canonical scope/name pair. `toolCallCompleted` is session-scoped, including when
project staff consumes it. Filters are an exact-AND comparison over catalogue-owned scalar
fields. Unknown names, scope mismatches, unfilterable fields, invalid values, or oversized filters
are rejected. The full catalogue and filter list live in
[Unified Host hooks](host-hooks.md#notification-catalogue).

### Project isolation and privacy

The dispatcher considers only active staff in `notification.projectId`. It verifies the staff,
trigger, delivery row, and inbox all belong to that exact project. A session-scoped notification
also carries its exact authoritative `sessionId`; project membership does not change its scope.
There is no cross-project fallback or client-provided project binding.

The persisted input is the complete original validated and frozen canonical envelope. That
envelope is already privacy-bounded: no raw prompt, message content, tool arguments/results,
setting values, secrets, provider error text, stacks, or mutable store object can pass its schema.
The wake prompt is generic and never interpolates event data.

Browser/operator inbox reads and inbox WebSocket events are redacted: they omit
`notificationInput`, root correlation, and causation depth. Only the exact live owning staff
session receives the full metadata, using its gateway-issued `BOBBIT_SESSION_SECRET` as
`X-Bobbit-Session-Secret`. The gateway resolves the secret to the staff's current live session and
verifies staff and project ownership. A bearer token, cookie, public session ID, request body, or
client project claim is not enough. See [Staff inbox](staff-inbox.md#notification-entry-security).

### Durable acceptance and retries

Bobbit persists one matching delivery intent per deterministic
`staffId + triggerId + notification.id` identity before inbox delivery. The row retains the exact
event across retry and restart; it never reprojects a later aggregate. A successful row means the
inbox write was durably accepted, not that the staff ran or completed the work.

Delivery attempts are **at least once**. Inbox insertion is idempotent/effectively once for the
stable identity, including a crash after inbox commit but before outbox acknowledgement. Startup
reconciliation reclaims pending and expired leased rows. Transient storage/unavailable failures
retry with bounded backoff, attempt count, and final deadline; invalid schema/version/project data
fails closed. This is not exactly-once execution and there is no global notification journal or
replay API.

Pausing/retiring staff or disabling/deleting the trigger cancels pending work and aborts a leased
attempt. Subscriber-version checks prevent late application after configuration changes.
Host-owned root/depth tracking suppresses causal loops without rewriting the event's correlation
fields. Successfully accepted inbox work is not rolled back by later retirement.

## Goal lifecycle triggers (`goal_created`, `goal_archived`)

### Why push, not poll

Goal lifecycle events are sparse, ordered, and originate from a single
in-process mutation. A 60 s polling loop would have to scan every goal
across every project on every tick to detect new ids and archive
transitions — wasted work for an event the server already knows happened
the instant it happened.

`GoalStore` exposes two narrow callbacks (`onGoalCreated`,
`onGoalArchived`) wired from `goal-trigger-dispatcher.ts`:

- `put(goal)` detects "first time we've seen this id" before the
  `Map.set`, then calls `onGoalCreated` exactly once. Subsequent `put`s
  on the same id (updates) do **not** re-fire.
- `archive(id)` captures `wasAlreadyArchived = existing.archived === true`
  before flipping the flag, then calls `onGoalArchived` only when the
  transition is `false → true`. Re-archiving an already-archived goal is
  a no-op — `archive` still returns `true` for back-compat with callers,
  but no event fires.

The dispatcher is independent of `TriggerEngine`; it does not share any
state and is not affected by the streaming/starting checks the polled
engine used to carry (those were removed when the inbox shipped — see
[staff-inbox.md — Migration notes](staff-inbox.md#migration-notes)).

### Required prompt

The push-based dispatcher has **no fallback prompt** for goal triggers.
Whatever the user typed into the trigger's `prompt` field is what the
agent will see — there is no equivalent of the engine's
`"Trigger fired: ${trigger.type}"` synth.

To make a missing prompt impossible at runtime, the prompt is required
at the API/store boundary:

- **Server.** `StaffManager.validateTriggers` rejects any
  `goal_created` / `goal_archived` entry whose `prompt` is missing, not
  a string, or trims to the empty string. The `POST /api/staff` and
  `PUT /api/staff/:id` routes call this before persisting and return
  `400 { error: "Trigger of type goal_created requires a non-empty prompt" }`
  on failure.
- **UI.** The trigger editor in the staff creation panel and the staff
  edit page renders the prompt field as "Wake prompt (required)" for
  goal triggers, applies destructive styling when empty, shows an
  inline error (`"Goal triggers require a non-empty wake prompt."`),
  and disables the Save / Propose button until every goal trigger has
  a non-empty prompt.

The other legacy trigger types keep optional prompts because the polled engine can synthesise a
placeholder. Notification triggers do not use their prompt as event input; the canonical envelope
is protected inbox metadata and the wake text is host-owned. Goal triggers have neither fallback,
so a missing prompt is rejected rather than creating a useless wake.

### Fire-all semantics (no filtering yet)

The dispatcher iterates **every staff record across every project** via
`staffManager.listStaff()` and fires every matching enabled trigger.
There is currently no per-project, per-workflow, or per-goal filter on
goal triggers — `config` is always `{}` for these types and is not
consulted.

Practical consequences:

- A staff in project A with a `goal_created` trigger fires when a goal
  is created in project B.
- Multiple matching triggers on the same staff (e.g. two
  `goal_created` rows with different prompts) all fire, producing one
  inbox entry each. Distinct prompts are the user's deliberate
  choice — the dispatcher does not coalesce.

Filtering by `workflow_id` / `project_id` is a planned follow-up; it
will be a new optional field on `config` for the goal-* types, defaulting
to "all" for compatibility with existing records.

### Idempotency

- **`goal_created`** fires exactly once per goal id. The dispatcher
  relies on `GoalStore.put` detecting the not-yet-present id. Crash
  recovery does not re-fire: once a goal exists on disk and is loaded
  into the in-memory map, a subsequent `put` of the same id is treated
  as an update.
- **`goal_archived`** fires exactly once per archive transition.
  `archive` checks `wasAlreadyArchived` before flipping the flag. Calling
  `/archive` on an already-archived goal still returns success but emits
  no event.

The inbox itself does **not** coalesce entries either — see
[staff-inbox.md — Idempotency contract](staff-inbox.md#idempotency-contract).
If a transient bug ever produces a duplicate, the agent dedupes via its
memory and history; the server never auto-merges.

### No backfill for new staff

A staff agent created after a goal already exists does **not** receive a
historical `goal_created` entry for that goal. The dispatcher fires only
on the store mutation, and the staff did not exist when the mutation
happened.

This matches `git`-trigger semantics: a new staff with a `git` trigger
silently initialises `lastSeenSha` to the current head and does not
fire on commits that landed before the staff existed.

If a workflow really needs the historical fan-out, the recommended path
is a one-off manual `POST /api/staff/:id/inbox` per goal of interest.

### Inbox entry shape

Every goal-trigger fire produces one inbox entry with the standard
trigger shape ([staff-inbox.md — Storage](staff-inbox.md#storage)):

| Field | Value |
|---|---|
| `title` | `` `${type}: ${goal.title}` `` (e.g. `"goal_archived: Refactor parser"`). |
| `prompt` | `trigger.prompt` verbatim — guaranteed non-empty by the validator. |
| `context` | Two-line block: `Goal id: <id>\nTitle: <title>`. Lean by design — the agent fetches anything more via `GET /api/goals/:id` or the cross-project search if it needs the spec, gates, or tasks. |
| `source` | `{ type: "trigger", triggerId }` — `triggerId` is the `StaffTrigger.id` that fired, useful for the agent to correlate the entry with the trigger row in the staff config. |

`lastFired` on the matching trigger is bumped after enqueue so the staff
edit page reflects when the trigger last contributed an entry.
Bumping is best-effort — a `lastFired` write failure logs but does not
abort the dispatch.

### Disabled / paused / retired

The dispatcher skips any staff whose `state !== "active"` (i.e. `paused`
or `retired`) and any trigger whose `enabled === false`. These checks
mirror the polled engine. Per-trigger errors during enqueue are caught
so one bad staff does not poison the dispatch for the rest.

## REST validation summary

| Route | Validation |
|---|---|
| `POST /api/staff` | Rejects goal lifecycle triggers with an empty prompt; rejects notification triggers with an unknown/mismatched selector or invalid catalogue filter. |
| `PUT /api/staff/:id` | Applies the same validation to the complete updated `triggers` array. |

The validation lives in `StaffManager.validateTriggers` so both routes
share one source of truth.

## Code orientation

The user-facing model above is what matters; the file paths below are an
orientation aid only.

- **Trigger types.** `src/server/agent/staff-store.ts` — `TriggerType`, legacy triggers, and the notification selector/filter shape.
- **Notification delivery.** `notification-staff-dispatcher.ts` and `notification-delivery-store.ts` — project matching, durable subscriber rows, leases, retry/restart reconciliation, and inbox acceptance.
- **Validation.** `src/server/agent/staff-manager.ts` —
  `validateTriggers()` called from the staff REST routes.
- **Polled dispatch** (`schedule`, `git`). `src/server/agent/staff-trigger-engine.ts`.
- **Push dispatch** (`goal_created`, `goal_archived`).
  `src/server/agent/goal-trigger-dispatcher.ts`. Wired by
  `server.ts` via `ProjectContextManager.setGoalTriggerDispatcher`, which
  attaches `onGoalCreated` / `onGoalArchived` callbacks to every project's
  `GoalStore`.
- **Store hooks.** `src/server/agent/goal-store.ts` — `put` (new-id
  detection) and `archive` (false → true transition) call the
  dispatcher; `onIndexUpdate` (the existing search-index hook) is kept
  separate so the two concerns do not stomp each other.
- **UI editor.** Creation panel in `src/app/render.ts`
  (`renderTriggersEditor` / `renderTriggerCard`), edit page in
  `src/app/staff-page.ts`. Save buttons consult
  `hasInvalidGoalTriggers*` to block save on empty goal-trigger
  prompts.
- **Staff-assistant prompt.** `src/server/agent/staff-assistant.ts` documents legacy and notification trigger forms, including the required goal prompt and canonical selector/filter rules.

## Tests

Registered Test Suite v2 coverage includes the notification dispatcher, selector/filter
validation, project isolation, exact canonical-envelope persistence, idempotent inbox acceptance,
retry/cancellation/loop protection, restart reconciliation, and exact-owner inbox authorization.
Legacy goal-trigger and UI suites remain compatibility coverage.

## See also

- [docs/staff-agents.md](staff-agents.md) — staff agent lifecycle,
  sandbox mode, edit page conventions.
- [Unified Extension Host hooks](host-hooks.md) — canonical notification contract, catalogue, and all consumer delivery semantics.
- [docs/staff-inbox.md](staff-inbox.md) — the inbox queue, notification metadata security, and nudger delivery.
- [docs/rest-api.md](rest-api.md) — staff REST surface, including the
  trigger validation `400` on `POST` / `PUT /api/staff`.
- [docs/goals-workflows-tasks.md](goals-workflows-tasks.md) — goal
  lifecycle and archive semantics that the push triggers fire from.
