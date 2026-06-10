# Orchestration Core — Design Document

**Status:** Design (pre-implementation). Three sequenced sub-goals: **A** (core + rename + restart), **B** (archive cascade + modal, deps A), **C** (`host.agents` + fixture, deps A).

This document specifies the **HOW**. The product **WHAT** is locked in the goal spec and is not relitigated here. Every file/line reference below was verified against the working tree at design time; line numbers may drift — grep the cited symbol.

---

## 1. Problem & current code (verified)

"Launch and orchestrate a child agent" exists in four divergent forms:

| # | Location | What it does | Sins |
|---|---|---|---|
| 1 | `src/server/agent/team-manager.ts` | Goal-keyed role-agent manager. `spawnRole` → `createSession(..worktreeOpts..)` (`team-manager.ts:1751`), `dismissRole` → `terminateSession`, idle-nudge/stuck-watchdog. | Goal-only; not reusable by a non-goal agent. |
| 2 | `defaults/tools/agent/extension.ts` (`delegate`) | Agent-process tool. Mints a child via REST `POST /api/sessions {delegateOf,instructions}`, long-polls `POST /api/sessions/:id/wait`, then `DELETE`s it. | (a) **inlines** a duplicate of `_shared/gateway.ts` (`getGatewayUrl`/`getGatewayToken`/`gatewayFetch`, lines 40-80); (b) drops to **system-default model** (no `initialModel`); (c) one-shot spawn→wait→archive, **no restart survival**; (d) no shared registry/audit; (e) `BOBBIT_DELEGATE_OF` env early-return recursion guard (`extension.ts:316`). |
| 3 | `src/server/pr-walkthrough/walkthrough-agent-manager.ts` | First-class child via `createSession({parentSessionId, childKind:"pr-walkthrough", readOnly, initialModel})`. **Model inheritance** = `resolveParentInitialModel` (`:577-580`). **Boot cascade-reap** = `shouldReapWalkthroughChildOnBoot` (`walkthrough-reap.ts`). | Walkthrough-specific; the two good behaviours are not generalized. |
| 4 | `market-packs/pr-walkthrough/` (pack) | The launch privilege was **deleted** — re-expressed as a client `host.session.postMessage` gesture driving the user's own agent. | Capability downgrade; no new principal. |

**Root cause:** there was never a sanctioned shared way to mint a child agent. `OrchestrationCore` is that one implementation; team-manager becomes a thin goal-aware adapter; `delegate` becomes `team_delegate` over a REST route into the core; packs reach the core through a new ambient `host.agents` capability.

### 1.1 The two layers (do not conflate)

- **Agent-process extension tools** (`delegate`/`team_*`, `browser_*`, `web_*`) run in the agent subprocess and reach the gateway over **authenticated REST + on-disk creds** via `defaults/tools/_shared/gateway.ts` (`readGatewayCreds`/`apiCall`, with 401-refresh + transient retry). This is sanctioned and unchanged. `team/extension.ts` and `children/extension.ts` already use it.
- **Extension-host packs** run **in-process, server-side** inside a confined worker (`ModuleHost.invoke`). Their durable Host API has **no `gateway.fetch`/no raw transport** (`src/server/extension-host/server-host-api.ts:9-21`). `host.agents` is added to *this* layer.

So: **agent tool → REST route → `OrchestrationCore` (in-process); pack handler → `ctx.host.agents` (proxied to parent) → `OrchestrationCore` (in-process).** Both converge on one core.

### 1.2 Session-manager primitives the core wraps (verified)

All in `src/server/agent/session-manager.ts`:

- `createSession(cwd, agentArgs?, goalId?, assistantType?, opts?)` (`:3779`). `opts` already supports `parentSessionId`, `childKind`, `readOnly`, `initialModel`, `initialThinkingLevel`, `allowedTools`, `worktreeOpts`, `sandboxed`, `sessionId`, `rolePrompt`/`roleName`/`role`. Sandbox inheritance is handled per-path.
- `createDelegateSession(parentSessionId, {instructions, cwd, title?, context?})` (`:3995`) — bare-context child via `mode:"delegate"`, inherits parent `allowedTools` (`:4024-4034`), propagates parent sandbox (`:4008-4022`), auto-sends the instructions as first prompt (`sendDelegatePrompt`, `DELEGATE_SPAWN_TIMEOUT_MS`). **Does NOT pass `initialModel`** — this is the model-drop bug.
- `enqueuePrompt(sessionId, text, opts?)` (`:1819`) — run-if-idle / queue-if-busy; `opts.source: PromptSource` controls nudge-reset semantics.
- `deliverLiveSteer(sessionId, message, opts?)` (`:1984`) — mid-turn steer; requires a live turn (callers gate on `streaming`).
- `waitForIdle(sessionId, timeoutMs=600_000)` (`:4063`) — resolves on `agent_end`, rejects on `process_exit`/timeout, instant if already `idle`. `waitForStreaming` (`:4098`) is the symmetric helper.
- `getSessionOutput(sessionId)` (`:4128`) — concatenated assistant text.
- `terminateSession(id)` (`:5297`) — terminate + archive; **already cascades** to live children where `delegateOf===id` OR (`childKind==="pr-walkthrough" && parentSessionId===id`) (`:5305`), and archives persisted-but-dormant such children (`:5314-5322`).
- `restoreSessions()` (`:3150`) — restores `regular` sessions; **`delegateOf` children are deferred as dormant** (`:3179-3203`, revived on-demand via `addClient`); **no boot-reap for delegates**. `pr-walkthrough` children are boot-reaped in `restoreOneSession` via `shouldReapWalkthroughChildOnBoot` (`:3293-3318`).
- `updateSessionMeta(id, {delegateOf?, parentSessionId?, childKind?, readOnly?, ...})` (`:4854`).

Model-inheritance resolver already exists at the call sites: `resolveSessionModel(sessionId)` (`server.ts:1536`, `:2398`) returns `"${provider}/${id}"` from the persisted session — this is what `OrchestrationCore` uses to inherit the parent's **current** model.

---

## 2. `OrchestrationCore` — the one implementation

### 2.1 Location & shape

New module: **`src/server/agent/orchestration-core.ts`**. Pure orchestration logic; constructed once in `server.ts` near `teamManager`, injected with a narrow view of `SessionManager` (not the whole class — keeps it unit-testable).

```ts
// orchestration-core.ts
export type ChildKind = "delegate" | "team" | "pr-walkthrough" | string;
export type SpawnLifecycle = "bare" | "full";

export interface SpawnOpts {
  ownerSessionId: string;            // the parent/owner; index key
  instructions: string;
  role?: string;                     // optional role injection (goal/team path)
  model?: string;                    // default: inherit owner's CURRENT model
  thinkingLevel?: string;            // default: inherit owner's
  readOnly?: boolean;                // readOnly always implies lifecycle:"bare"
  context?: Record<string, string>;
  lifecycle?: SpawnLifecycle;        // default "bare"; "full" opt-in
  childKind?: ChildKind;             // default "delegate"
  title?: string;
  // Worktree mode: shared-cwd (delegate parity) vs own worktree on sub-branch
  worktree?: { mode: "shared"; cwd: string }
           | { mode: "sub-branch"; repoPath: string; goalId: string; branch: string };
}

export interface ChildHandle {
  sessionId: string;
  ownerSessionId: string;
  childKind: ChildKind;
  spawnedAt: number;
  // "blocking-ness" is RUNTIME-ONLY (never persisted) — see §4.
  blocking: boolean;
}

// A child is SETTLED when it is idle OR terminal (terminated/timeout/failed). See §2.3.
export type ChildStatus =
  | "idle" | "streaming" | "queued" | "not-started"   // live statuses
  | "terminated" | "timeout" | "failed";              // terminal statuses

export interface WaitResult {
  firstIdle?: string;                          // session id that became idle/settled (await-first)
  statuses: Array<{ sessionId: string; status: ChildStatus }>;
  outputTail?: string;                         // short tail of firstIdle's output
  remaining: number;                           // awaited children NEITHER idle NOR terminal
}

export class OrchestrationCore {
  constructor(private deps: {
    sessionManager: OrchestrationSessionView;
    resolveSessionModel: (id: string) => string | undefined;   // server.ts:1536 shape
    resolveSessionThinking?: (id: string) => string | undefined;
    audit: (event: OrchestrationAuditEvent) => void;
  }) {}

  // Throws if `ownerId` is itself a bound child (has delegateOf/childKind) — the
  // single recursion guard called by BOTH the agent-tool spawn path and (in C)
  // host.agents.spawn. Implemented in sub-goal A (§7).
  assertCanSpawn(ownerId: string): void;

  async spawn(opts: SpawnOpts): Promise<ChildHandle>;  // calls assertCanSpawn first
  async prompt(ownerId: string, childId: string, message: string): Promise<{status:"dispatched"|"queued"}>;
  async steer(ownerId: string, childId: string, message: string): Promise<unknown>; // 409 if not streaming
  async abort(ownerId: string, childId: string): Promise<void>;          // force-abort own child (§8.2)
  async wait(ownerId: string, childIds: string[], opts: { policy: "first"|"all"; timeoutMs: number }): Promise<WaitResult>;
  async dismiss(ownerId: string, childId: string): Promise<boolean>;     // terminate+archive
  list(ownerId: string): ChildHandle[];
  async read(ownerId: string, childId: string, opts?: ReadTranscriptOpts): Promise<unknown>; // delegates to read_session machinery

  // Boot/restart hooks (§4):
  rebuildIndexFromPersisted(persisted: PersistedSessionLike[]): void;
  shouldReapChildOnBoot(input: ReapInput): ReapDecision;             // generalized §5
  // Runtime cascade hook (§6) — invoked by terminateSession on archive+terminate
  cascadeReapOwner(ownerId: string): Promise<void>;
}
```

`OrchestrationSessionView` is the narrow injected surface: `createSession`, `createDelegateSession`, `enqueuePrompt`, `deliverLiveSteer`, `waitForIdle`, `getSessionOutput`, `getSession`, `getSessionStatus`, `terminateSession`, `getPersistedSession`. This keeps the core decoupled and unit-testable with a fake.

### 2.2 `spawn` — how it wraps the primitives

`spawn` does **not** add a new session path. It calls existing `SessionManager` methods:

- **Model inheritance (fixes the drop):** if `opts.model` unset, `model = deps.resolveSessionModel(opts.ownerSessionId)` (same resolver PR-walkthrough uses via `resolveParentInitialModel`). Pass as `initialModel` to `createSession`. Same for thinking.
- **Bare context (default):** `lifecycle:"bare"` → route through `createDelegateSession(ownerId, {instructions, cwd, title, context})` **extended to forward `initialModel`/`initialThinkingLevel`** (the one new parameter on `createDelegateSession`). This preserves delegate's AGENTS.md-only context contract.
- **Full lifecycle (opt-in):** `lifecycle:"full"` → `createSession` with the full pipeline (memory recall, context providers — once the Lifecycle Hub lands). `readOnly:true` **forces bare** regardless.
- **Worktree:**
  - `mode:"shared"` → child shares owner `cwd` (delegate parity; this is the **documented unbounded-lifetime worktree race**, §10).
  - `mode:"sub-branch"` (goal/team only) → `createSession(..., { worktreeOpts:{repoPath}, sandboxBranch })` with branch `goal/<goalId8>/<role>-<short4>` — exactly what `team-manager.spawnRole` does today; team-manager keeps owning that call shape and passes it through `spawn`.
- **Recursion guard:** the child's `allowedTools` = owner's `allowedTools` **minus every spawn verb** (`team_delegate`, `team_spawn`) — see §7. Computed in `spawn` and passed to the underlying create.
- **Linkage:** for `delegate` kind, `createDelegateSession` already sets `delegateOf`. For other kinds, `createSession` sets `parentSessionId`/`childKind`. The core does **not** persist its own registry — it reads these fields (§3).
- **Index:** add a `ChildHandle` to the in-memory index keyed on `ownerSessionId`. Emit an audit event.

### 2.3 The single `wait` primitive (two policies)

There is **one** `wait` implementation; the two locked behaviours differ only in await-set/return policy.

**Terminal-child handling (no single crash rejects the wait).** `waitForIdle` rejects on `process_exit`/timeout, so a naive `Promise.all`/`Promise.race` would reject the whole wait if ONE child crashes or is terminated. Instead, `wait` wraps each per-child `waitForIdle` in a catch that maps the rejection to an explicit **terminal status**:

- `process_exit` / dismiss → `terminated`
- timeout → `timeout`
- any other error → `failed`

A child is **settled** when it is idle OR terminal. The per-child wrapper therefore never rejects — it resolves to a settled marker.

- **`policy:"all"`** — used internally by blocking `team_delegate` (incl. `parallel`): resolves when **every** awaited child is settled (idle or terminal). **Never rejects on a single child.** Implemented as `Promise.all(childIds.map(id => settle(id, timeoutMs)))` where `settle` is the catch-wrapped `waitForIdle`; aggregates per-child status + outputs (delegate parity).
- **`policy:"first"`** — used by the standalone `team_wait` verb: resolves on the **first settled** child (idle or terminal), or immediately if one already is. Implemented as `Promise.race` over the per-child `settle` wrappers, then build the all-children status line (§9).

`remaining` counts awaited children that are **neither idle nor terminal** (still `streaming`/`queued`/`not-started`). Timeout semantics match `waitForIdle` (default 10 min = `600_000`); a per-child timeout becomes that child's `timeout` status rather than rejecting the aggregate. "not-yet-started" (status `preparing`/`starting`) is **not** idle/settled and never satisfies a `first` wait by itself. Both paths re-use `getSessionStatus`/`getSessionOutput`.

---

## 3. In-memory index (no new persisted source of truth)

The core keeps `Map<ownerSessionId, ChildHandle[]>` **in memory only**. It is **rebuilt on boot** from the already-persisted fields — never a parallel persisted registry:

- A child is any persisted session with `delegateOf` set, OR (`parentSessionId` set AND `childKind` present).
- Owner = `delegateOf ?? parentSessionId`.
- `rebuildIndexFromPersisted(persisted)` is called from `restoreSessions()` (after the regular/delegate split, before returning). For each linked persisted session not reaped (§5), push a `ChildHandle{ blocking:false, ... }`.

**Blocking-ness is NOT persisted** (locked decision #6). On boot every restored child is `blocking:false`; a blocking `team_delegate` that was in-flight pre-restart is reconstructed as an orchestrable (non-blocking) child plus a **parent reminder** (§4). The consistency of `delegateOf`/`parentSessionId` is already guarded by `team-store-consistency.ts` (orphan-team-entry sweep) — the core piggybacks on the same persisted fields and adds no new invariants there.

---

## 4. Restart survival (outcome #3) — children survive, parent reminded, one shared wait

**Locked principle: no transparent tool-call resumption.** A blocking `team_delegate` is *spawn tracked child → shared `wait(policy:"all")` → auto-dismiss*, all inside the agent's tool loop. On restart the agent subprocess dies; the long-poll promise is gone; the parent is rebuilt from transcript with a `tool_use` and no matching `tool_result`. We **do not** splice a synthetic `tool_result`.

Mechanism:

1. **Children survive.** `restoreSessions()` keeps `delegateOf` children as dormant entries (unchanged, `:3179-3203`) and now also runs `rebuildIndexFromPersisted`. Boot-reap (§5) reaps a child **only** if its parent is gone or archived. A child whose parent is restoring is never reaped.
2. **Parent reminded on resume.** Reuse the **boot-resume nudge machinery** in `team-manager.ts` (`resumeTeams` → boot-resume `enqueuePrompt(..., { isSteered:true })`, `:945-968`). Generalize it to a non-goal owner: after `restoreSessions`, for each owner with ≥1 live restored child, inject a system reminder via `sessionManager.enqueuePrompt(ownerId, msg, { source:"system", isSteered:true })`.
   - **Injection point:** a new `OrchestrationCore.remindOwnersWithLiveChildren()` called from the server boot sequence right after `restoreSessions()` + `teamManager.restoreTeams()` (so team owners and standalone owners are both covered; team-managed children are skipped to avoid double-nudge — filter `childKind!=="team"`).
   - **Reminder text** enumerates the N live children (ids + one-line title) and points at `team_wait`:
     > `[ORCHESTRATION] The gateway restarted. You have N live child agent(s) from before the restart: <id1> "<title1>", … Their results were not collected. Call team_wait to collect them (it returns on the first child idle and tells you who remains).`
3. **Non-blocking children** were already re-promptable; the reminder simply resurfaces them.

Pinned by a restart E2E (§11): kill + reboot mid-orchestration → children survive, parent receives the reminder, `team_wait` collects, no orphan.

---

## 5. Generalized `shouldReapChildOnBoot`

Replace the walkthrough-specific `shouldReapWalkthroughChildOnBoot` (`walkthrough-reap.ts`) with a generalized pure helper in `orchestration-core.ts` (keep a thin `pr-walkthrough` adapter for the job-status terminal check so walkthrough behaviour is byte-identical):

```ts
export interface ReapInput {
  childKind: ChildKind;
  ownerSessionId?: string;
  ownerExists: boolean;
  ownerArchived: boolean;
  // kind-specific terminal signal (e.g. walkthrough job ready/error). undefined ⇒ not terminal.
  kindTerminal?: boolean;
  kindTerminalReason?: string;
}
export function shouldReapChildOnBoot(i: ReapInput): { reap: boolean; reason?: string } {
  if (i.kindTerminal) return { reap: true, reason: i.kindTerminalReason ?? "kind terminal" };
  if (!i.ownerSessionId || !i.ownerExists) return { reap: true, reason: "owner session no longer exists" };
  if (i.ownerArchived) return { reap: true, reason: "owner session is archived" };
  return { reap: false };
}
```

- For `pr-walkthrough`: `kindTerminal` = job status `ready`/`error` or missing job record (preserves `walkthrough-reap.ts` semantics exactly). The walkthrough call site in `restoreOneSession` (`:3293`) switches to this helper with the adapter supplying `kindTerminal`.
- For `delegate`: `kindTerminal` is undefined (delegates have no terminal job); reap only on owner-gone/archived. **This closes the orphan-delegate gap** (today delegates are never boot-reaped).
- Never reap a child whose owner is restoring (owner exists, not archived).

`restoreOneSession` calls `shouldReapChildOnBoot` for any session with a `childKind`/`delegateOf`. Delegate children remain dormant unless reaped.

---

## 6. Runtime cascade-reap on archive AND terminate (outcome #4, sub-goal B)

Today `terminateSession` (`:5297-5322`) cascades to live + dormant `delegateOf`/`pr-walkthrough` children, and archival flows through `terminateSession`. The gap (per spec): a parent archived through a path that does **not** fire the live cascade (parent dormant/not-live, or archived while server was down) leaks a live read-only child until the next boot.

Design:

- Extract the cascade body of `terminateSession` into `OrchestrationCore.cascadeReapOwner(ownerId)` that enumerates children by the same predicate generalized to **all** `childKind`s (not just `pr-walkthrough`): `s.delegateOf===ownerId || (s.childKind && s.parentSessionId===ownerId)`. `terminateSession` calls it (behaviour-preserving refactor).
- Invoke `cascadeReapOwner` on **every** archive path, not just terminate: audit the archive entry points (`getSessionStore(...).archive(id)` callers, `purgeOneSession`, goal/team teardown) and route them through a single `archiveSession(id)` seam that calls `cascadeReapOwner` first. The boot-reap (§5) remains as defense-in-depth.
- Reaped/orphaned children archive **identically** to today's team-shutdown child archival (locked #10): same status, same "show archived" surface, **no new badge**. No UI change beyond the modal (§6.1).

### 6.1 Confirmation modal — name the right path (sub-goal B)

A **non-goal** session is archived/terminated through `confirmAction` in `src/app/session-manager.ts::terminateSession` (the `else` branch around `:2392`, `gatewayFetch(/api/sessions/:id, DELETE)`). Goal archival is the separate `src/app/api.ts` path (`:1369-1395`) that already enumerates affected sessions — **do not touch it**.

Change: in the non-goal branch, before building the confirm body, fetch the owner's live child agents (reuse the sidebar's child enumeration / a small `GET /api/sessions/:id/children-count` or the already-loaded `state.gatewaySessions` filtered by `delegateOf===id || parentSessionId===id`). If N>0, append to the body:

> `This will also archive its N child agent(s).`

Pinned by a browser E2E (§11).

---

## 7. Recursion guard — mechanism change (locked #5)

Remove the `BOBBIT_DELEGATE_OF` env early-return (`extension.ts:316`) and the env-var write in `session-setup.ts:355` (and update `tests/spawn-env.test.ts` which asserts it). Replace with **a single core guard + allowed-tools subtraction**:

- **The core guard `OrchestrationCore.assertCanSpawn(ownerId)`** (built in sub-goal A): throws if `getPersistedSession(ownerId)` has `delegateOf` or a `childKind` set (i.e. the owner is itself a bound child). `spawn` calls it first. This is the **one** mechanism that both spawn paths share: the agent-tool spawn path (A) and, later, `host.agents.spawn` (C) both call the same `assertCanSpawn`. No child, of any kind, spawns grandchildren.
- **`spawn` computes the child's `allowedTools`** = owner's `allowedTools` filter-out `["team_delegate","team_spawn"]`. Passed to `createSession`/`createDelegateSession`. A child therefore never has any spawn verb registered → belt-and-braces with `assertCanSpawn`.
- **`host.agents.spawn` reuses `assertCanSpawn`** (§8.3, sub-goal C): the C-built capability surface calls the A-built guard, so a bound child session's `host.agents.spawn` throws. The denial **mechanism** lives in A's core; the **capability-surface** denial test ships in C (the `host.agents` namespace does not exist in A).
- The `read_session` tool stays registered for children (it is registered **before** the old guard today, `extension.ts:257`) — children must still read transcripts.

Pinned by tests split across sub-goals (§13): A's `tests/recursion-guard.test.ts` pins the **core guard** (`assertCanSpawn` rejects a bound-child owner id; child `allowedTools` excludes both spawn verbs) — NOT the `host.agents` namespace; C pins the **capability-surface** `host.agents.spawn` denial (which calls the same guard).

---

## 8. Entry points

### 8.1 Entry point 1 — agent-process tools (`team_*`)

`delegate` is **hard-removed** (name + inlined creds). New surface, registered in **`defaults/tools/agent/extension.ts`** (renamed conceptually to the "team" agent surface), importing `_shared/gateway.ts` (`readGatewayCreds`/`apiCall`) — **no inlined creds**. All verbs call a new server route (§8.2).

| Tool | Scope | Behaviour |
|---|---|---|
| `team_delegate` | anywhere `delegate` is granted today | Child in **shared worktree** (owner `cwd`), bare context, no role by default, inherits owner `allowedTools` minus spawn verbs. Supports `parallel`. **Default = blocking one-shot** = spawn → `wait(policy:"all")` → auto-dismiss (drop-in `delegate` parity). `non_blocking:true` opt-in. Optional `role`/`model`/`thinking_level`; model defaults to owner's current. Timeout default 10 min. |
| `team_wait` (new) | holder of a spawn verb | Returns on **first** awaited child idle (`wait(policy:"first")`); emits all-children status + await-the-rest instruction (§9). |
| `team_prompt` | goal (existing) + extended to own children | run-if-idle / queue. |
| `team_steer` | existing + own children | steer requires `streaming` else 409 (`server.ts:8631`). |
| `team_abort` | existing (goal, unchanged) + own children | Force-abort. For own children routes through `/orchestrate/abort` → `OrchestrationCore.abort` (§8.2). Goal-scoped `team_abort` keeps its current behaviour (`server.ts:8644` → `forceAbort`). |
| `team_dismiss` | existing + own children | terminate + archive. |
| `team_spawn` / `team_complete` / `team_list` | **goal/team-lead only, unchanged** | own worktree on sub-branch toward a gate. |
| `read_session` | unchanged | |

**Two wait semantics are both intended** (locked #9): blocking `team_delegate(parallel)` waits for **all**; standalone `team_wait` returns on **first**. They share `OrchestrationCore.wait` but pass different `policy`. Do not unify the behaviours.

The `non_blocking` mode and shared-worktree race must be documented prominently in `team_delegate`'s `detail_docs` (§10).

### 8.2 Server route for the agent hop

New route family in `server.ts::handleApiRoute` (mirrors the team routes), all resolving the **authentic caller** session id from the existing auth/secret machinery (same as `/team/*`), then calling `orchestrationCore.*` in-process:

```
POST /api/sessions/:id/orchestrate/spawn     { instructions, parallel?, role?, model?, thinking_level?, read_only?, non_blocking?, context?, timeout_ms?, lifecycle? }
POST /api/sessions/:id/orchestrate/prompt    { childSessionId, message }
POST /api/sessions/:id/orchestrate/steer     { childSessionId, message }   // 409 if child not streaming
POST /api/sessions/:id/orchestrate/abort     { childSessionId }            // force-abort own child → OrchestrationCore.abort
POST /api/sessions/:id/orchestrate/wait      { childSessionIds?, timeout_ms? }  // policy "first"; chunked heartbeat like /wait
POST /api/sessions/:id/orchestrate/delegate  { instructions?, parallel?, role?, model?, thinking_level?, read_only?, context?, timeout_ms?, lifecycle? }  // blocking: spawn+wait(all)+dismiss (§8.2.1)
POST /api/sessions/:id/orchestrate/dismiss   { childSessionId }
GET  /api/sessions/:id/orchestrate/children
```

- `:id` is the **owner**. The route enforces that `childSessionId` belongs to that owner via `orchestrationCore.list(ownerId)` (own-children scoping is server-enforced, not client-trusted).
- `/orchestrate/abort` reuses the existing force-abort machinery: `OrchestrationCore.abort` calls `sessionManager.forceAbort(childId)` (`session-manager.ts:6085`, the same path `/api/sessions/:id/abort` `:11342` and goal `team/abort` `:8644-8665` use), after verifying the child belongs to the owner.
- **Decision: blocking `team_delegate` uses the single server-side `POST /api/sessions/:id/orchestrate/delegate` route** (server owns the heartbeat, surviving the undici body-timeout like today's `/wait`). The granular verbs (`/spawn`, `/wait`, `/dismiss`) serve the interactive (non-blocking) path. The full `/orchestrate/delegate` contract is pinned in §8.2.1.
- The legacy `POST /api/sessions {delegateOf,instructions}` (`server.ts:4134`) and `POST /api/sessions/:id/wait` (`:9096`) stay for now (other callers); `team_delegate` no longer uses them directly — it goes through `/orchestrate/*`.

#### 8.2.1 `POST /api/sessions/:id/orchestrate/delegate` — the pinned blocking contract

The single specified blocking path. `:id` is the owner.

- **Request:** `{ instructions?, parallel?: Array<{ instructions, context? }>, role?, model?, thinking_level?, read_only?, context?, timeout_ms? (default 600000), lifecycle? }`. Exactly one of `instructions` (single child) or `parallel` (N children) is the spawn set.
- **Behaviour:** spawn the single child or **all** `parallel` children → server-side `wait(policy:"all")` with the per-child terminal mapping from §2.3 (a crashed/terminated/timed-out child becomes a terminal status, never rejects the aggregate) → **auto-dismiss EVERY child** regardless of outcome (success, timeout, failure, terminal) → aggregate. The server owns the chunked heartbeat (reuse the `/wait` pattern at `server.ts:9096-9135`) so the long-poll survives the undici body-timeout.
- **Response (drop-in `delegate` parity):**
  ```
  { delegates: Array<{ id, sessionId, status: "completed"|"failed"|"timeout"|"terminated", output, durationMs, error? }>,
    summary: string }
  ```
  mirroring today's `delegate` tool output shape (per-child `output` + aggregate `summary`). The `wait` terminal statuses map to the response `status`: idle→`completed`, `failed`→`failed`, `timeout`→`timeout`, `terminated`→`terminated`.
- **Partial failure:** the route **always returns 2xx** (never 5xx) once every child settles; per-child `status` carries success/timeout/failure. **Cleanup (dismiss/archive) is guaranteed for every child** regardless of outcome — the auto-dismiss runs in a `finally` over the full spawn set, so no child leaks even if some failed or timed out.

### 8.3 Entry point 2 — `host.agents` capability (sub-goal C)

Add an **ambient** capability to the server Host API. No manifest declaration, no consent line (locked #14) — ambient like `host.session`/`host.store`.

**Type surface** (`src/server/extension-host/server-host-api.ts`):

```ts
export interface ServerHostAgentsApi {
  spawn(opts: { instructions: string; role?: string; model?: string; thinkingLevel?: string;
                readOnly?: boolean; context?: Record<string,string>; lifecycle?: "bare"|"full" }): Promise<{ childSessionId: string }>;
  prompt(childSessionId: string, message: string): Promise<{ status: "dispatched"|"queued" }>;
  dismiss(childSessionId: string): Promise<boolean>;
  list(): Promise<Array<{ childSessionId: string; status: string; childKind: string }>>;
  read(childSessionId: string, opts?: ReadTranscriptOpts): Promise<TranscriptEnvelope>;
  status(childSessionId: string): Promise<{ status: "idle"|"streaming"|"queued"|"preparing"|"terminated" }>;
}
```

- **Poll-based, no blocking `wait`** (locked #12): the worker tier (`ModuleHost.invoke`) terminates calls on timeout, so a handler `spawn`s then **polls** `status`/`list`/`read` across worker calls.
- **Capability flag:** add `readonly agents: boolean` to `ServerHostCapabilities` (`server-host-api.ts:55`), and to the `flags` object (`:134`, currently `{ session: true, store: true }`) → `{ session: true, store: true, agents: true }` once wired. `has()` then reports it.
- **Wiring:** `createServerHostApi` gains an injected `orchestrationCore?: OrchestrationCore` and the **bound owner session id** (`opts.sessionId`, already passed). The `agents` namespace methods close over `opts.sessionId` as the owner. Both `createServerHostApi` call sites in `server.ts` (`:5519`, `:5887`) pass `orchestrationCore: orchestrationCore`.
- **Worker proxy allowlist:** add `agents: new Set(["spawn","prompt","dismiss","list","read","status"])` to `PROXYABLE` in `module-host-worker.ts:112`. The live `ServerHostApi` (with `agents`) **stays in the parent** and services proxied calls (the worker only sends `{path:[ns,method],args}`); this is the existing channel (`module-host-worker.ts:262`).
- **Source discriminator — host.agents children carry a distinct `childKind`.** `host.agents.spawn` calls `OrchestrationCore.spawn` with `childKind:"host-agents"` (set at spawn time, persisted on the session like any other `childKind`). This is the discriminator that makes scoping consistent.
- **Own-children scoping is API shape AND source-filtered** (locked #15): every verb (`list/read/dismiss/status/prompt`) filters to children where `ownerSessionId === opts.sessionId` **AND** `childKind === "host-agents"`. So `host.agents` is scoped to **the bound session's host.agents-sourced children only** — it cannot see agent-tool (`delegate`) children or `team` children of the same session, nor any foreign session. There is **no parameter** for a foreign/owner-user session — the method simply does not exist (mirrors how `ServerHostSessionApi` is own-session-only and `postMessage` is absent).
  - Because the discriminator lives in the already-persisted `childKind`, it **survives restart** and is rebuilt by the in-memory index (§3) with no new persisted registry.
  - **Known simplification:** two packs sharing one bound session would both see all `host-agents` children of that session (the filter is per-session, not per-pack). The follow-up goal may refine this (decision #11 permits API amendment); not addressed now.
- **`host.agents.spawn` denied for bound child sessions** (§7): `host.agents.spawn` calls the A-built `OrchestrationCore.assertCanSpawn(opts.sessionId)` (which throws if the bound session has `delegateOf`/`childKind`), surfaced as `host.agents.spawn is not permitted for a child session`. The denial **mechanism** is A's shared guard; this **surface** wiring + its test ship in C.
- **One hard invariant — sandbox/credential inheritance (no escalation):** the child is created via `OrchestrationCore.spawn`, which propagates the owner's sandbox (`createDelegateSession` parent-sandbox propagation `:4008-4022`) and never grants a credential the owner lacks. The pack receives orchestration verbs, **not** transport (no token, no raw `fetch`). No security *claims* beyond this.
- **API may be amended later** (locked #11): flipping `agents:true` does **not** freeze the shape; the pr-walkthrough migration (separate goal) may extend it.

---

## 9. `team_wait` exact wording (locked #9)

`team_wait` returns immediately when the first awaited child is idle (or one already is). The tool result text:

```
First idle child: <childId> ("<title>")
--- output tail ---
<last ~1500 chars of getSessionOutput(firstIdle)>

Awaited children (N):
  • <id1> "<title1>" — idle
  • <id2> "<title2>" — streaming
  • <id3> "<title3>" — queued
  • <id4> "<title4>" — terminated
Remaining: 2 child(ren) not yet settled.
➜ Process this result now, then call team_wait again to await the remaining children.
```

Rules:
- Status vocabulary is `idle | streaming | queued | not-started` for live children **plus** the terminal statuses `terminated | timeout | failed` (§2.3). Live mapping: `idle`→idle; `streaming`→streaming; queued prompt rows→queued; `preparing`/`starting`→not-started. Terminal mapping: `process_exit`/dismiss→terminated; wait timeout→timeout; error→failed. A child marked `<id> "<title>" — terminated` is **settled** and does not count toward `Remaining`.
- `Remaining` counts only children that are neither idle nor terminal. If `Remaining===0`, replace the last line with `All awaited children are settled.` (no "call again").
- `firstIdle` is the first **settled** child (idle or terminal); the header reads `First settled child:` when that child is terminal.
- Chunked-heartbeat timeout default 10 min (reuse the `/wait` heartbeat pattern).

---

## 10. Worktree race (accepted, documented — locked #16)

Non-blocking, re-promptable children share the owner's `cwd`. Today's bounded one-shot race (short-lived, last-write-wins) becomes **unbounded-lifetime** (two agents editing the same files over an open-ended life). **Not mitigated** — no `readOnly` restriction, no copy-on-spawn, no locking. Blocking one-shot `team_delegate` keeps today's bounded behaviour.

Document prominently in `defaults/tools/agent/delegate.yaml` → renamed `team_delegate.yaml`, in the `detail_docs` "Notes / Gotchas":

> **Shared worktree (non-blocking mode).** A `team_delegate` child runs in **your** worktree (`cwd`). In blocking mode this is bounded (the child finishes before you continue). In `non_blocking` mode the child shares your files for an open-ended lifetime — concurrent edits are last-write-wins and there is no locking. Only use `non_blocking` for children that touch files you are not editing.

---

## 11. `DelegateRenderer` reuse/rename

The renderer is registered lazily for the tool name `"delegate"` in `src/ui/tools/index.ts:111` and the class lives in `src/ui/tools/renderers/DelegateRenderer.ts` (cards in `delegate-cards.ts`). Plan:

- Register the **same `DelegateRenderer`** for the new tool names: `registerLazyToolRenderer("team_delegate", …)` and `registerLazyToolRenderer("team_wait", …)`. Keep the class name `DelegateRenderer` (or rename to `TeamDelegateRenderer` with a re-export) — the card logic is identical (`delegates[]` details shape is unchanged; the tool returns the same `{ delegates:[…] }` details).
- `team_wait` details should reuse the card list; its `details` payload mirrors `WaitResult.statuses` mapped to `DelegateCardEntry[]`.
- Update `ToolGroup.ts` (`:30` icon map, `:42` verb map, `:59` switch) and `MessageList.ts`/`Messages.ts` `GROUPABLE_TOOLS` sets (replace `"delegate"` with `"team_delegate"`).

No renderer behaviour change; just registration keys + the groupable-tools string.

---

## 12. Complete migration map (`delegate` → `team_delegate`)

Every verified site and what it becomes (sub-goal A unless noted):

**Tool definition & extension**
- `defaults/tools/agent/delegate.yaml` → rename to `team_delegate.yaml`; `name: team_delegate`; update `renderer` key; rewrite `detail_docs` (drop "delegate" prose, add shared-worktree-race note §10, model-inheritance, blocking/non-blocking). Keep ≤150-char `description` / ≤80-char param descriptions (budget test §13).
- `defaults/tools/agent/extension.ts` — register `team_delegate` + `team_wait` (+ `team_prompt`/`team_dismiss`/`team_steer`/`team_abort` for own children when not a team-lead); **delete** inlined `getGatewayUrl`/`getGatewayToken`/`gatewayFetch` (`:40-80`), import `_shared/gateway.ts`; delete `createDelegateSession`/`waitForDelegate`/`runDelegateSession` REST helpers (now server-side); **delete** the `BOBBIT_DELEGATE_OF` guard (`:316`); route all verbs through `/api/sessions/:id/orchestrate/*`.

**Allow grant sites**
- `defaults/roles/assistant/tool.yaml:75` `delegate: allow` → `team_delegate: allow`.
- `defaults/roles/assistant/tool.yaml:59` (prose tool list) — `delegate` → `team_delegate`.
- `defaults/roles/assistant/role.yaml:22, :33` (prose tool lists) — `delegate` → `team_delegate`.
- `src/server/agent/role-assistant.ts:22, :36` (prose tool lists) — `delegate` → `team_delegate`.
- `defaults/system-prompt.md:7-11` — rewrite the delegate guidance to `team_delegate`; add the decision-table line (§12.1).

**Deny grant sites (must migrate or the deny becomes a dead key)**
- `defaults/roles/reviewer.yaml:7` `delegate: never` → `team_delegate: never` (+ prose `:69`).
- `defaults/roles/spec-auditor.yaml:7` `delegate: never` → `team_delegate: never` (+ prose `:96`).
- `defaults/roles/security-reviewer.yaml:7` `delegate: never` → `team_delegate: never` (+ prose `:78`).
- `defaults/roles/code-reviewer.yaml:7` `delegate: never` → `team_delegate: never` (+ prose `:90`).
- Add a test that reviewer roles cannot `team_delegate` (§13).

**team-lead prose (no grant — leave the English verb "delegate", it is not a tool name)**
- `defaults/roles/team-lead.yaml:36,:47,:189,:252,:282` use "delegate" as a verb — **do not** change to a tool token; these are not grants.

**Recursion-guard plumbing**
- `src/server/agent/session-setup.ts:355` — remove `BOBBIT_DELEGATE_OF` env write.
- `tests/spawn-env.test.ts:66-78` — update to assert the env var is gone and that `allowedTools` subtraction is the mechanism.

**Pen-test skill**
- `.claude/skills/pen-test/SKILL.md:17` lists `delegate` as an allowed tool — update to `team_delegate`.

**User-config blast radius (migration warning)**
- User/project tool-policy configs and saved roles under `.bobbit/config` may reference `delegate`. The hard cut silently strips it. **Emit a one-time migration warning** at config-cascade load when a resolved policy/role references the now-unknown `delegate` key (point them at `team_delegate`). Implement in the pack/config resolver where unknown tool keys are already detected; do not auto-rewrite user files.

**Docs (non-grant references — update where they describe the tool, leave historical design docs)**
- `docs/internals.md:658` (lifecycle table) — `delegate` tool reference → `team_delegate`.
- `docs/rest-api.md`, `userstories/*`, other `docs/design/*` mention `delegateOf`/"delegate session" as a **session relationship** — that persisted field name **stays** (`delegateOf` is unchanged); only the *tool* name changes. Do not rename `delegateOf`.

### 12.1 Decision-table line (tool docs + `system-prompt.md`)

> Need its own branch and a gate? `team_spawn` (goal only). Just a helper in your current worktree? `team_delegate`.

---

## 13. Test plan

Phase rules (AGENTS.md / `tests/test-phase-invariant.test.ts`): unit = `tests/*.test.ts` (node) / `*.spec.ts` (file://); API E2E = `tests/e2e/*.spec.ts`; browser E2E = `tests/e2e/ui/*.spec.ts`. **No `test:manual`** for any new test (host.agents fixture is canned/no-LLM).

**Sub-goal A**
- `tests/orchestration-core.test.ts` (unit, fake `OrchestrationSessionView`): `spawn` model inheritance (asserts `initialModel` = resolver output; per-call override wins); `allowedTools` subtraction (child loses `team_delegate`/`team_spawn`); `wait` policy `all` vs `first`; index rebuild from persisted fields; `shouldReapChildOnBoot` table (delegate owner-gone reaps; owner-restoring does not; pr-walkthrough terminal parity).
- `tests/reviewer-cannot-team-delegate.test.ts` (unit): resolve reviewer/spec-auditor/security-reviewer/code-reviewer tool policies → assert `team_delegate` is `never`.
- `tests/recursion-guard.test.ts` (unit): pins the **A-built core guard** — `OrchestrationCore.assertCanSpawn` rejects a bound-child owner id (one with `delegateOf`/`childKind`); `spawn` calls it; child `allowedTools` excludes both spawn verbs. Does **NOT** assert the `host.agents` namespace (it does not exist in A) — the capability-surface `host.agents.spawn` denial test is **deferred to Sub-goal C** (C's surface calls this same guard).
- Update `tests/spawn-env.test.ts` (remove `BOBBIT_DELEGATE_OF`).
- `tests/e2e/team-delegate.spec.ts` (API): non-goal agent `team_delegate` blocking one-shot (+ `parallel` waits for all); `team_prompt`→`team_wait`→`read_session`→`team_dismiss`; team-lead can also `team_delegate`/`team_wait` with no goal-tool regression.
- `tests/e2e/team-wait-semantics.spec.ts` (API): first-idle return, all-children status line, await-the-rest instruction, already-idle immediate, not-started ≠ idle, timeout. **Terminal-child handling:** one child exits/terminates (or times out) while others continue → `wait` still returns (never rejects the aggregate) with that child marked `terminated`/`timeout`/`failed` and the other children's real statuses; `policy:"all"` resolves when all are settled, `policy:"first"` resolves on the first settled (idle or terminal).
- `tests/e2e/orchestrate-restart.spec.ts` (API or `tests/e2e/ui`): kill + reboot mid-orchestration → children survive, owner gets the live-children reminder, `team_wait` re-collects, no orphan; non-blocking children re-link; owner-gone child reaped.
- `tests/e2e/ui/team-delegate.spec.ts` (browser): blocking one-shot card render; non-goal spawn→prompt→wait→read→dismiss; team-lead helper; restart reminder + re-collect.
- Reuse/rename existing: `tests/e2e/sandbox-delegate.spec.ts`, `tests/e2e/archived-delegates-api.spec.ts`, `tests/sidebar-archived-delegates.spec.ts`, `tests/e2e/ui/sidebar-archived-delegates-e2e.spec.ts` — these assert the `delegateOf` **session relationship** (unchanged) but invoke the tool; update tool name where used.
- `tests/tool-description-budget.test.ts` (`EXTENSION_FILES` includes `agent`) — keep `team_delegate`/`team_wait` within budget.

**Sub-goal B**
- `tests/orchestration-cascade.test.ts` (unit): `cascadeReapOwner` reaps all child kinds on archive **and** terminate; dormant/persisted children archived.
- `tests/e2e/ui/archive-child-cascade.spec.ts` (browser): non-goal archive confirm modal **lists** child agents (`session-manager.ts:2392` path); after confirm, children are archived (cascade), parity with team-shutdown archival; assert goal-archival path (`api.ts`) is unchanged.

**Sub-goal C**
- `market-packs/_fixtures/host-agents-exerciser/` — deterministic fixture pack whose child is **canned / no-LLM** (the spawned child runs a fixed scripted transcript, not a real model) so the E2E is non-flaky and stays in the e2e phase.
- `tests/e2e/host-agents.spec.ts` (API): fixture handler `spawn`→`prompt`→poll `status`/`list`/`read`→`dismiss` (poll-based, no blocking wait); scoped to own children.
- `tests/host-agents-scope.test.ts` (unit): `ServerHostCapabilities.agents===true` & `has("agents")`; **no** foreign-session method on the type (compile-time + runtime assertion that `agents` exposes only the six verbs); **filtered scoping** — a `delegate`-sourced (or `team`) child of the **same** bound session is **NOT** visible to `host.agents.list/read/status/dismiss/prompt` (only `childKind==="host-agents"` children are); **capability-surface `host.agents.spawn` denial** for a bound child session (the surface calls A's `assertCanSpawn`).
- `tests/host-agents-sandbox-inheritance.spec.ts` (API): child inherits the bound session's sandbox/credential scope and cannot exceed it.
- `PROXYABLE` allowlist test (extend `module-host-worker` tests): `agents` methods proxy; non-listed names throw.

**All sub-goals:** `.gitattributes` LF (no CRLF in `.ts`/`.md`/`.yaml`); `npm run check` + unit + e2e green at/above baseline.

---

## 14. Sub-goal decomposition & file ownership

Sequence: **A** first (no deps); then **B** and **C** in parallel (both dep A only). The shared-file hotspots are `session-manager.ts`, `server.ts`, `team-manager.ts`. A owns the structural seams in all three so B and C only **append** to them.

### Sub-goal A — Core + rename + restart (owns the seams)
**Creates:** `src/server/agent/orchestration-core.ts` (incl. generalized `shouldReapChildOnBoot`, the `assertCanSpawn` recursion guard §7, and the `abort` verb §8.2 — both consumed by the agent-tool path now and by `host.agents` in C); `tests/orchestration-core.test.ts`, `tests/reviewer-cannot-team-delegate.test.ts`, `tests/recursion-guard.test.ts`, `tests/e2e/team-delegate.spec.ts`, `tests/e2e/team-wait-semantics.spec.ts`, `tests/e2e/orchestrate-restart.spec.ts`, `tests/e2e/ui/team-delegate.spec.ts`. Rename `delegate.yaml`→`team_delegate.yaml`.
**Edits:** `session-manager.ts` (extend `createDelegateSession` to forward `initialModel`/`initialThinkingLevel`; add `rebuildIndexFromPersisted` call + reminder hook in `restoreSessions`; extract `cascadeReapOwner` **stub** that A wires into `terminateSession` so B can fill the archive seam); `server.ts` (construct `OrchestrationCore`; add `/api/sessions/:id/orchestrate/*` routes — `spawn`/`prompt`/`steer`/`abort`/`wait`/`dismiss`/`children` + the blocking `/orchestrate/delegate` route §8.2.1; pass `orchestrationCore` into the two `createServerHostApi` calls as injected dep — **flag stays false in A**); `team-manager.ts` (route `spawnRole` spawn/`dismissRole`/prompt/steer through the core — behaviour-preserving); `session-setup.ts` (remove `BOBBIT_DELEGATE_OF` write); `defaults/tools/agent/extension.ts`; all grant/deny/prose sites in §12; `src/ui/tools/index.ts`, `ToolGroup.ts`, `MessageList.ts`, `Messages.ts`, `DelegateRenderer.ts`; `tests/spawn-env.test.ts`.
**Acceptance:** §"Sub-goal A" acceptance criteria in the goal spec; all A tests green.
**B/C must NOT touch (A owns):** `orchestration-core.ts` public API, the `/orchestrate/*` routes, the `createDelegateSession`/`restoreSessions` edits, the rename, all §12 grant sites.

### Sub-goal B — Archive cascade + modal (deps A)
**Creates:** `tests/orchestration-cascade.test.ts`, `tests/e2e/ui/archive-child-cascade.spec.ts`.
**Edits:** **fills** `cascadeReapOwner` (A left the seam) and routes all archive entry points (`archive(id)` callers, `purgeOneSession`, teardown) through the single archive seam in `session-manager.ts`; `src/app/session-manager.ts` `terminateSession` non-goal `else` branch (`:2392`) — child enumeration in the confirm body; optional `GET /api/sessions/:id/children-count` route in `server.ts` (append-only).
**Acceptance:** §"Sub-goal B".
**Must NOT touch:** the `/orchestrate/*` routes, `host.agents`, `src/app/api.ts` goal-archival path (leave it — it already enumerates).

### Sub-goal C — host.agents + fixture (deps A)
**Creates:** `market-packs/_fixtures/host-agents-exerciser/`; `tests/e2e/host-agents.spec.ts`, `tests/host-agents-scope.test.ts`, `tests/host-agents-sandbox-inheritance.spec.ts`; `module-host-worker` PROXYABLE test.
**Edits:** `src/server/extension-host/server-host-api.ts` (add `ServerHostAgentsApi`, `agents` to `ServerHostCapabilities`, implement the namespace, flip `agents:true` in `flags`); `module-host-worker.ts:112` (add `agents` to `PROXYABLE`); `server.ts` — the `agents` namespace consumes the `orchestrationCore` dep **A already passes into `createServerHostApi`** (C only flips the flag + implements; the injection point is A's seam).
**Acceptance:** §"Sub-goal C".
**Must NOT touch:** the `/orchestrate/*` routes, `team-manager.ts`, the rename, the cascade seam (B owns).

### Sequencing B vs C (no conflict after A merges)
- B touches `session-manager.ts` (archive seam) + `src/app/session-manager.ts`. C touches `server-host-api.ts` + `module-host-worker.ts` + `server.ts` (flag flip only). The only shared file is `server.ts`: A pre-creates both seams (the `/orchestrate/*` block for itself, the `createServerHostApi` injected dep for C, and a clearly-commented child-count route slot for B), so B and C edit **disjoint regions** of `server.ts`. Merge order B-then-C or C-then-B is immaterial; if both edit `server.ts`, the regions don't overlap.

---

## 15. Open items deferred to implementation
- Exact `OrchestrationAuditEvent` shape (retained per locked #17; reuse existing audit sink if one exists, else a structured `console.log` line keyed `[orchestration]`).
- Whether the blocking `team_delegate` uses the server-side `/orchestrate/delegate` convenience route (preferred, server owns heartbeat) vs client-side spawn+wait loop — §8.2 recommends the server route for undici-timeout parity with today's `/wait`.
- `read` verb: delegate to the existing `read_session` transcript machinery (`/api/sessions/:id/transcript`) scoped to own children, rather than re-implementing.
