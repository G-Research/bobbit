# Orchestration: launching and orchestrating child agents

Bobbit has one primitive for **"launch and orchestrate a child agent"** — a new,
properly-scoped principal — and it lives in one place: the **`OrchestrationCore`**.
Two entry points sit on top of it: the `team_*` agent tools (for agents) and the
`host.agents` extension-host capability (for packs). This doc explains the surface,
the lifecycle guarantees, and the design reasoning.

> **Why one core?** "Spawn a child agent" used to be reimplemented or faked in four
> divergent places (the goal-team manager, the old `delegate` tool, the legacy
> PR-walkthrough launch wiring, and the PR-walkthrough pack that *couldn't* mint a
> principal and drove the user's own agent instead). Each invented its own model
> handling, restart behaviour, and cleanup — or gave up. `OrchestrationCore` is the
> single sanctioned implementation; everything else is now a thin adapter over it.

For the full HOW (internal API, route shapes, sub-goal decomposition), see the design
record [docs/design/orchestration-core.md](design/orchestration-core.md). This page is
the user/developer-facing reference.

---

## Big picture

A **child agent** is a full agent session (its own process, system prompt, tools, and
optionally its own model/sandbox/worktree) spawned by and linked to a parent session.
Unlike a tool call, a child is an independent principal that reasons and acts on its own;
unlike a fresh top-level session, it is *owned* by its parent — tracked, orchestrable,
and cleaned up with it.

There are two ways to reach the core, and they must not be conflated:

| Caller | Path to the core | Mechanism |
|---|---|---|
| **Agent** (any session) | `team_*` tool → REST route `/api/sessions/:id/orchestrate/*` → `OrchestrationCore` | Agent-process tools reach the gateway over authenticated REST with on-disk creds (`defaults/tools/_shared/gateway.ts`). |
| **Pack handler** (server-side) | `host.agents.*` → `OrchestrationCore` | In-process call. The extension-host worker proxies the verb to the parent, which holds the live core. No transport, no token. |

Both converge on the same `OrchestrationCore` running in-process in the gateway.

---

## The `team_*` agent tool surface

The old `delegate` tool was **hard-renamed to `team_delegate`** (no alias — the name
`delegate` is gone everywhere) and joined by `team_wait` plus the own-children
orchestration verbs. The persisted session field that links a child to its parent is
still named **`delegateOf`** — only the *tool* name changed, not the data model.

### Decision rule

> **Need its own branch and a gate?** Use `team_spawn` (goal/team-lead only).
> **Just need a helper in your current worktree?** Use `team_delegate`.

`team_spawn` mints a role agent in its own git worktree on a sub-branch, working toward
a workflow gate — it is the team-lead's tool and is unchanged. `team_delegate` works
anywhere `delegate` was granted and runs the child in *your* worktree.

### `team_delegate`

Launch a child agent in your worktree. The child gets full tool access but **no
conversation context** — it sees only the `instructions` (and optional `context`) you
pass, preserving the context-isolation contract the old `delegate` had.

- **Blocking one-shot (default)** — spawn → wait for the child to finish → auto-dismiss,
  returning the child's output as the tool result. This is the drop-in replacement for
  `delegate`. `parallel` spawns N children at once; blocking mode waits for **all** of
  them and returns each child's output plus a summary.
- **Non-blocking (`non_blocking: true`)** — returns immediately with the child's session
  id; the child keeps running and you orchestrate it with `team_wait` / `team_prompt` /
  `team_steer` / `team_dismiss`. Enables interactive, long-lived helpers.
- **Model inheritance** — the child inherits **your current model** (and thinking level)
  unless you pass `model` / `thinking_level`. (The old `delegate` silently dropped to the
  system default; that bug is gone.)
- **Timeout** — blocking-mode default is 10 minutes.

> ### ⚠️ Shared-worktree race (non-blocking mode) — accepted, not mitigated
>
> A `team_delegate` child runs in **your** worktree (shares your `cwd`). In **blocking**
> mode the window is bounded — the child finishes before you continue. In
> **`non_blocking`** mode the child shares your files for an open-ended lifetime:
> concurrent edits are **last-write-wins, with no locking**. This is a deliberately
> accepted risk (no `readOnly` restriction, no copy-on-spawn, no locking). Only use
> `non_blocking` for children that touch files you are **not** editing. Revisit only if
> it bites in practice.

### `team_wait`

Collect results from non-blocking children. It returns **as soon as the first awaited
child settles** (not when all are done), so you can process that result eagerly and call
`team_wait` again for the rest.

- **Settled** = idle **or** terminal. Terminal statuses are `terminated` (process exited
  / was dismissed), `timeout` (heartbeat elapsed), and `failed` (other error). A single
  crashed child never rejects the wait — it just reports that child's terminal status.
- The result carries (a) the first settled child's output tail, (b) a **status line for
  every awaited child** (`idle` / `streaming` / `queued` / `not-started` / `terminated` /
  `timeout` / `failed`), and (c) an explicit instruction to **call `team_wait` again** to
  await the remaining children. When all are settled it says so instead.
- Already-idle children return immediately; `not-started` never satisfies the wait on its
  own. Omit `child_session_ids` to await all your live children.

> **Two wait semantics, both intentional.** Blocking `team_delegate(parallel)` waits for
> **all** spawned children before returning (delegate parity). Standalone `team_wait`
> returns on the **first** settled child. They share one wait implementation but differ in
> await-set and return policy — this is by design.

### Orchestration verbs over child session ids

For non-blocking children you spawned, these verbs work over the child's session id:

- **`team_prompt`** — run-if-idle / queue-if-busy a follow-up prompt (re-task the child).
- **`team_steer`** — mid-turn redirect; requires the child to be `streaming` (else `409`).
- **`team_abort`** — force-abort a stuck child.
- **`team_dismiss`** — terminate and archive the child.
- **`read_session`** — read the child's full transcript (unchanged).

The team-lead's goal-scoped versions of these verbs (plus `team_spawn`, `team_list`,
`team_complete`) keep their existing behaviour, signatures, and worktree/role/gate
semantics — `team_delegate` and `team_wait` are *added* alongside them.

### Recursion is fully blocked at all depths

A spawned child inherits a copy of the parent's allowed tools **minus every spawn verb**
(`team_delegate`, `team_spawn`), and `host.agents.spawn` is denied for any bound child
session. So **no child of any kind can spawn grandchildren** — enforced both by tool
subtraction and by a single core guard (`assertCanSpawn`) shared by both spawn paths.

---

## `OrchestrationCore` — the one implementation

`OrchestrationCore` (`src/server/agent/orchestration-core.ts`) owns the child-principal
lifecycle, goal-agnostic. It exposes the verbs `spawn` / `prompt` / `steer` / `abort` /
`wait` / `dismiss` / `list` / `read`, all built on existing `SessionManager` primitives
(`createSession` / `createDelegateSession`, `enqueuePrompt`, `deliverLiveSteer`,
`waitForIdle`, `terminateSession`). It adds the cross-cutting behaviour those primitives
lacked: model inheritance, a single shared wait, the recursion guard, restart survival,
and cascade-reap.

**There is one shared `wait` primitive** with two policies:

- `policy: "all"` — resolves when every awaited child is settled. Backs blocking
  `team_delegate` (including `parallel`).
- `policy: "first"` — resolves on the first settled child. Backs the `team_wait` verb.

Keeping both behaviours on one implementation is deliberate: there is exactly **one** kind
of tracked child and **one** wait path, differing only in await-set/return policy.

### No new persisted registry — the index is derived

The core keeps an **in-memory index keyed by owner session id**, but it persists nothing
of its own. Parent↔child linkage is read from the session fields that already persist —
`delegateOf` / `parentSessionId` / `childKind` (guarded by `team-store-consistency.ts`).
On boot the index is **rebuilt** from those fields. "Blocking-ness" is runtime-only and
never persisted (see restart survival below).

> **Why derive instead of persist?** A second source of truth for parent↔child links would
> drift from the session store and need its own consistency guard. Deriving from the
> already-guarded persisted fields keeps one source of truth and makes restart survival
> fall out almost for free.

### `team-manager` is now a thin adapter

The goal-team manager keeps its goal-specific logic (worktree-on-sub-branch, role
injection, gate-dependency checks, idle-nudge / stuck-team watchdog, `team_complete`,
`maxConcurrent`) but **stops duplicating** spawn / prompt / wait / dismiss — it calls
`OrchestrationCore` for those. All existing goal-scoped tool behaviour is preserved; the
change is purely internal.

---

## Restart survival

Child agents **survive a gateway restart**. Before, a blocking `delegate` child became an
orphaned dormant session and the parent lost its result. Now:

1. **Children survive.** On boot the in-memory index is rebuilt from the persisted link.
   A child is reaped on boot **only** if its parent is gone or archived (a generalized
   `shouldReapChildOnBoot`, covering delegate, PR-walkthrough, and future kinds). A child
   whose parent is restoring is never reaped — this closes the old orphan-delegate gap.
2. **The parent is reminded.** When a restored parent has live children, the core injects
   a **system reminder** (reusing the boot-resume nudge machinery) enumerating the live
   children and pointing at `team_wait`. The parent re-collects through the shared wait
   path.

> **No transparent tool-call resumption — by design.** A blocking `team_delegate` is *spawn
> a tracked child → call the shared wait → auto-dismiss*, all inside the agent's tool loop.
> A blocking call is an in-flight long-poll **inside the agent subprocess**; on restart
> that subprocess dies and the promise is gone. We do **not** splice a synthetic
> `tool_result` into a turn the new process never issued. Instead the child survives, the
> parent is reminded, and it re-collects explicitly via `team_wait`. Non-blocking children
> were already re-promptable; the reminder simply resurfaces them.

---

## Archive cascade-reap

A child agent **never outlives its parent's archival**. The core owns a single runtime
cascade-reap hook invoked on parent **archive and terminate** (not just terminate),
generalized to all child kinds. Before, a parent archived through a path that didn't fire
the live cascade (parent dormant, or archived while the server was down) leaked its live
read-only child until the next boot; the boot-reap now remains only as defense-in-depth.

**User-facing:** when you archive a non-goal session that has child agents, the
confirmation modal **lists the N child agents** that will also be archived, so you see what
goes with it before confirming. (Goal archival already enumerates affected sessions via its
own path and is unchanged.) Reaped or orphaned children archive **identically** to
team-shutdown child archival — same status, same "show archived" surface, no new badge.

---

## `host.agents` — orchestration for extension packs

Packs run server-side, in-process, inside a confined worker. Their durable Host API
deliberately has **no raw transport** (no `gateway.fetch`). To let a pack handler launch and
orchestrate child agents through the sanctioned path, the Host API exposes an **ambient**
`host.agents` capability backed by the same `OrchestrationCore`. See
[docs/extension-host-authoring.md](extension-host-authoring.md#hostagents--launch-and-orchestrate-child-agents)
for the authoring guide.

Key properties (full detail in the authoring guide):

- **Ambient** — no manifest declaration, no consent line, like `host.session` / `host.store`.
- **Poll-based** — `spawn` / `prompt` / `dismiss` / `list` / `read` / `status`. There is
  **no blocking `wait`**: the worker tier terminates calls on timeout, so a handler spawns
  then polls across worker calls.
- **Scoped to its own children** — every verb is filtered to the bound session's children
  with `childKind === "host-agents"`. A pack cannot see the session's `delegate`/`team`
  children, nor any foreign session. There is no parameter to target the user or another
  session — the method simply does not exist.
- **One hard invariant: sandbox/credential inheritance.** A child inherits the bound
  session's sandbox and credential scope and cannot exceed it. The pack receives
  orchestration verbs, not transport — no token, no raw `fetch`, no privilege escalation.

This resurfaces a privilege that was lost when PR walkthrough became a pack: spawning a
child principal is no longer "not pack-expressible." The capability is exercised by a
deterministic, no-LLM **fixture pack** so its end-to-end test stays non-flaky and in the
e2e phase. (Migrating the real PR-walkthrough pack onto `host.agents` is a separate
follow-up.)

---

## REST routes (agent hop)

The `team_*` tools call a route family that resolves the authenticated caller as the owner
and invokes the core in-process. See [docs/rest-api.md](rest-api.md#orchestration-routes-child-agents)
for the table. Own-children scoping is **server-enforced** — a route verifies the target
child belongs to the calling owner; it is not client-trusted.

---

## Related docs

- [docs/design/orchestration-core.md](design/orchestration-core.md) — the design record (the HOW).
- [docs/extension-host-authoring.md](extension-host-authoring.md) — `host.agents` for packs.
- [docs/goals-workflows-tasks.md](goals-workflows-tasks.md) — goal teams and `team_spawn`.
- [docs/rest-api.md](rest-api.md) — session and orchestration endpoints.
