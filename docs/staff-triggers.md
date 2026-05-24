# Staff Triggers

Triggers attached to a [staff agent](staff-agents.md) decide when work lands
in the staff's [inbox](staff-inbox.md). A staff record holds an array of
`StaffTrigger` entries; each entry has a `type`, a `config` blob, an
`enabled` flag, and (for some types) a `prompt` that becomes the wake
message delivered to the agent.

Triggers themselves never wake the agent directly — they `enqueue` an
inbox entry, and the [inbox nudger](staff-inbox.md#lifecycle) decides when
the staff is idle enough to receive the digest. That decoupling is the
whole point of the inbox; trigger plumbing only has to land the entry.

## Trigger types

There are two dispatch families:

- **Polled** triggers (`schedule`, `git`) are evaluated by
  `staff-trigger-engine.ts` on a 60 s tick. The engine re-reads cron and
  git state, decides whether each trigger should fire, and enqueues an
  inbox entry per fire.
- **Push-based** triggers (`goal_created`, `goal_archived`) are dispatched
  synchronously from the relevant store mutation — there is no polling
  loop. The `manual` type is enqueue-only (the UI button) and is not
  evaluated by either path.

| Type | Dispatcher | `config` | `prompt` | Fires on |
|---|---|---|---|---|
| `schedule` | `staff-trigger-engine.ts` (60 s poll) | `{ cron, timezone? }` | optional (synthesised if blank) | Cron expression matches and `lastFired` is in a prior minute. |
| `git` | `staff-trigger-engine.ts` (60 s poll) | `{ event, branch?, repo? }` | optional (synthesised if blank) | Repository event observed since `lastSeenSha`. |
| `manual` | (no dispatcher) | `{}` | optional | User clicks "Wake Now" / "+ Add to inbox", or an integration `POST`s to `/api/staff/:id/inbox`. |
| `goal_created` | `goal-trigger-dispatcher.ts` (push, from `GoalStore.put`) | `{}` | **required** | A new goal id appears in any project's `GoalStore`. |
| `goal_archived` | `goal-trigger-dispatcher.ts` (push, from `GoalStore.archive`) | `{}` | **required** | A goal transitions from `archived: false` to `archived: true`. |

`manual` exists primarily so the UI can render a row with a "Wake Now"
affordance and so a `prompt` can be attached for ad-hoc one-clicks; the
trigger record itself is never matched against an event.

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

Other trigger types keep their existing optional-prompt semantics
because the polled engine synthesises a placeholder if `prompt` is
blank. Goal triggers do not have that escape hatch by design — a
silently-fired wake with no instructions is worse than a save-time
error.

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
| `POST /api/staff` | Rejects `400` if any element of `triggers[]` has `type === "goal_created"` or `type === "goal_archived"` and a missing / empty / whitespace-only `prompt`. |
| `PUT /api/staff/:id` | Same validation on the updated `triggers` array. |

The validation lives in `StaffManager.validateTriggers` so both routes
share one source of truth.

## Code orientation

The user-facing model above is what matters; the file paths below are an
orientation aid only.

- **Trigger types.** `src/server/agent/staff-store.ts` — `TriggerType`
  union and the `StaffTrigger` shape.
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
- **Staff-assistant prompt.** `src/server/agent/staff-assistant.ts`
  documents all five trigger types so creation sessions suggest the
  goal lifecycle ones with a non-empty prompt.

## Tests

- `tests/goal-trigger-dispatcher.test.ts` — unit: dispatcher fires
  `goal_created` once per new id; `goal_archived` once per transition;
  skips disabled triggers and non-active staff; per-trigger error
  isolation.
- `tests/e2e/staff-goal-triggers.spec.ts` — API E2E: create goal
  → assert inbox entry; `POST /archive` → assert entry; re-archive →
  no new entry; `POST/PUT` with empty prompt → 400.
- `tests/e2e/ui/staff-triggers.spec.ts` — browser E2E: trigger
  type dropdown shows the new options; empty prompt blocks save with
  an inline error; saving with a prompt persists and round-trips on
  reload.

## See also

- [docs/staff-agents.md](staff-agents.md) — staff agent lifecycle,
  sandbox mode, edit page conventions.
- [docs/staff-inbox.md](staff-inbox.md) — the inbox queue that every
  trigger enqueues into, plus the nudger that delivers digests.
- [docs/rest-api.md](rest-api.md) — staff REST surface, including the
  trigger validation `400` on `POST` / `PUT /api/staff`.
- [docs/goals-workflows-tasks.md](goals-workflows-tasks.md) — goal
  lifecycle and archive semantics that the push triggers fire from.
