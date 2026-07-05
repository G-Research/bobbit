# SessionManager decomposition — spike (STR-06)

**Status**: design spike, no production code changed. This document is the
deliverable.

Finding: `~/Documents/dev/bobbit-fable-refactor/FINDINGS.md` STR-06 covers
`handleApiRoute`'s positional-args problem, already fixed by the seam in
[route-registry.md](route-registry.md). This doc asks the analogous question
about `SessionManager` (`src/server/agent/session-manager.ts`): a **10,034-line
file**, class body **lines 1121–9872** (lines 9874–10034 are trailing
module-level exports, not part of the class), containing on the order of
**215 methods**. This is the biggest remaining god-class in the server after
`handleApiRoute`'s cohort-1 extraction, and — unlike `handleApiRoute`, which
was one large but structurally uniform if/else chain — `SessionManager` mixes
several genuinely different subsystems (process lifecycle, MCP client
management, git/filesystem bookkeeping, WS broadcast, persistence routing)
behind one shared `this`. **This spike proposes a seam and a cohort order; it
migrates nothing.**

All line numbers below were verified live against
`src/server/agent/session-manager.ts` in this worktree
(`fable/d5-str06-spike`, based on `origin/aj-current`) on 2026-07-05 — grep and
read, not recalled.

---

## 1. Responsibility inventory

The class holds ~35 fields (`sessions`, per-scope caches, injected
collaborators) and ~215 methods. Grouping by what state each method reads or
mutates yields nine cohesion clusters:

### 1.1 Fields (selected — the ones that matter for coupling, §2)

| Field | Line | Holds |
|---|---|---|
| `sessions` | 1122 | `Map<sessionId, SessionInfo>` — the live in-memory registry; the one truly universal shared mutable state |
| `sessionsWithConnectedClients` | 1124 | `Set<SessionInfo>` with ≥1 open WS client |
| `taskIdCache` | 1139 | `Map<sessionId, {taskId, gen}>` |
| `mcpManager` | 1165 | default (unscoped) `McpManager \| null` |
| `scopedMcpManagers` | 1166 | `Map<scopeKey, McpManager>` |
| `marketplaceMcpResolver` / `marketplacePiExtensionResolver` | 1167–1168 | injected marketplace resolver callbacks |
| `piExtensionRuntimeDiagnostics` | 1169 | `Map<key, PiExtensionDiagnostic>` |
| `worktreePools` | 1170 | `Map<projectId, WorktreePool>` |
| `sandboxManager` (no modifier — effectively public) | 1171 | `SandboxManager \| null`, set post-construction |
| `configCascade` (no modifier) | 1183 | `ConfigCascade \| null` |
| `purgeInterval` | 1208 | 24h archive-purge `setInterval` handle |
| `_statusHeartbeatTimer` + `STATUS_HEARTBEAT_INTERVAL_MS` (static) | 1213–1214 | 15s heartbeat timer |
| `_restoreCoordinators` | 1216 | `Map<sessionId, RestoreCoordinator>` — in-flight restore/respawn coalescing |
| `_sessionRespawnGenerations` | 1218 | `Map<sessionId, gen>` — lifecycle-generation fence |
| `_aigwModelCache` + TTL (static) | 1220–1221 | AIGW model-discovery cache |
| `_idleWaiters` | 1222 | `Map<sessionId, Set<IdleWaiter>>` |
| `_bootRepromptedSessions` | 1228 | boot-time mid-turn recovery set |
| `orchestrationCore` | 1345 | `OrchestrationCore \| null` — child-session index |

**Not a declared field at all**: `bgProcessManager`. It is injected via
`(sessionManager as any).bgProcessManager = bgProcessManager` at
`src/server/server.ts:2001` and read at 6 sites in session-manager.ts (3488,
5755–5759, 8021–8023, 9801, 9856–9859), every one through an `as any` cast.
This is a pre-existing collaborator-injection pattern with **zero
compile-time contract** — worth flagging on its own, independent of the
decomposition.

### 1.2 Clusters

**A — Session bring-up** (create / restore / delegate). The largest cluster
and, per §2, the one with the real architectural problem.
- `createSession` (5791, 263 lines) — normal + worktree-mode entry, builds a
  `PipelineContext` (`buildPipelineContext`, 1799) and hands off to
  `session-setup.ts`'s `executePlan`/`executeWorktreeAsync`.
- `createDelegateSession` (6062, ~150 lines) — same pipeline, delegate-flavored plan.
- `restoreSessions` (5008, 157 lines), `restoreOneSession` (5170, 133 lines),
  `_restoreSessionCoalesced` (1281), `_coalesceRestore` (1264),
  `addDormantSession` (5304).
- **`restoreSession` (5333, 457 lines — the single largest method in the
  file)** — does **not** go through `session-setup.ts`. It hand-duplicates
  the entire bring-up sequence inline: sandbox wiring (`applySandboxWiring`,
  1972, called inline at 5359), tool activation
  (`resolveSessionRole` 2800 at 5453, `ensureMcpManagerForContext` 2347 at
  5483, `buildToolActivationArgs` 2709 at 5484), prompt assembly
  (5489–5569), bridge construction (`createSessionBridge`, session-runtime.ts:94,
  called at 5597), RPC start + `switch_session` replay (5694–5719),
  `sessions.set` (5745), and **bg-process reattach**: `bgMgr.restoreSession(ps.id)`
  at 5755–5759. Comments at 2684/2697/2764/2788 literally read "Mirrors
  session-setup.ts::X" — the duplication is hand-maintained in parallel, not
  accidental.
- `ensureSessionAlive` (7810) — chooses in-place respawn vs. full restore.

**B — Steer / abort / respawn-in-place.**
- `enqueuePrompt` (3173), `deliverLiveSteer` (3414), `steerQueued` (3458),
  `_dispatchSteer` (3486, the one steer-dispatch site — reads
  `(this as any).bgProcessManager` at 3488), `markPromptDispatchStreaming` /
  `dispatchDirectPrompt` / `drainQueue` (3593/3736/3785), retry state machine
  (3641–4472).
- `handleAgentLifecycle` (3890, 398 lines) — the central lifecycle-event
  switch; confirmed **no** MCP/bg-process/respawn calls in its body.
- `trackCostFromEvent` (4933).
- `grantToolPermission` / `requestToolGrant` / `denyToolPermission` /
  `recomputeAllowedToolsForRestart` (4565/4681/4733/4742) —
  `grantToolPermission` ends by calling `_restartSessionWithUpdatedRole`
  (4772), which calls `_respawnAgentInPlace`.
- **`_respawnAgentInPlace` (4833)** — the "official" shared respawn engine
  (used by `restartAgent`, `_restartSessionWithUpdatedRole`,
  `recoverSandboxSessions`, `ensureSessionAlive`): unsubscribe → snapshot →
  fence → `rpcClient.stop()` → delete from `sessions` → **`await
  this.restoreSession(ps)`** (4855) → reattach. No MCP call of its own — it
  delegates to `restoreSession`.
- **`forceAbort` (9521, 255 lines, to 9761)** — confirmed, does **not** call
  `_respawnAgentInPlace` or `restoreSession`. It inlines a **third**,
  independent copy of the rebuild sequence directly inside its
  `_coalesceRestore` callback (verified 9607–9761: its own
  `RpcBridgeOptions` construction, its own
  `ensureMcpManagerForContext(...)` call at line 9668, its own
  `buildToolActivationArgs(...)` at 9669, its own `createSessionBridge(...)`
  at 9697).
- `assignRole` (7483, ~220 lines) — a **fourth** independent rebuild: stops
  the current `rpcClient`, calls `createSessionBridge` directly, replays
  `switch_session`.
- Lifecycle-fence primitives shared by all four: `_currentRespawnGeneration`
  (1237), `_nextRespawnGeneration` (1241), `_sessionWriterIsCurrent` (1247),
  `_fenceReplacedSession` (1254).

**C — Persistence / store resolution.** Thin routing layer over
`ProjectContextManager`: `resolveStoreForSession`/`resolveStoreForId`
(1691/1708), `getSessionStore`/`getBgProcessStore`/`getGoalStoreForProject`/
`getGateStoreForGoal`/`getSearchIndexForProject` (1616–1679),
`resolveCostTracker`/`resolveSearchIndex`/`resolveGoal` (1732–1755),
`persistSessionMetadata` (7003), plus generic read/write helpers
(`getPersistedSession` 8159, `updateSessionMeta` 7368, `markChildTerminal`
7415, drafts 7461–7473). Barely touches `sessions` except to merge live
fields into DTOs.

**D — MCP wiring.** ~15 methods, lines 2224–2562:
`mcpScopeKey`/`createMcpManager`/`getMcpManagerForContext` (2224/2304/2341,
pure lookup/construction, no connect), **`ensureMcpManager` (2322)** — the
create-and-connect entry point (`createMcpManager` → `scopedMcpManagers.set`
→ `await mgr.connectAll()` at line 2337), `ensureMcpManagerForContext`
(2347) and routing wrappers (2353–2369),
`removeScopedMcpManagerByKey` (2264, **the only `.disconnectAll(` call site
in the whole file**, line 2269),
`cleanupScopedMcpManagersForProject`/`cleanupScopedMcpManagersForSessionScope`
(2276/2295), `aggregateMcpReloadResults`/`reloadMcpAfterMarketplaceMutation`
(2379/2398), `refreshExternalMcpToolRegistrations` (2244), marketplace/pi-extension
wiring (2436–2474), `initMcp` (2549, startup bootstrap — the other two
`.connectAll(` sites, lines 2553 and 2562).

**E — Status/broadcast** (mostly already extracted). `_trackConnectedSession`/
`_untrackConnectedSession` (1479/1487), `_emitStatusHeartbeat` (1496, ~80
lines), `broadcastQueue`/`broadcastQueueUpdate`/`broadcastSessionCost`
(3094/3078/2177), `addClient`/`removeClient` (9459/9497 — `addClient` revives
dormant sessions via `_restoreSessionCoalesced`, coupling this cluster back
to A). The actual status-mutation invariant (sole writer of
`session.status`/`statusVersion`) already lives outside session-manager.ts,
in the tiny standalone `session-status.ts` — see §4.

**F — Tool-grants / tool-activation.** `resolveEffectiveAllowedTools`/
`mergeToolNames`/`disabledToolsForGoal`/`promptSectionOrderForGoal`/
`resolveEffectiveGoalMetadataForSession` (2603–2702),
**`buildToolActivationArgs` (2709, ~90 lines)** — touches `toolManager`,
`groupPolicyStore`, `mcpManager` (via `getMcpManagerForContext`); called by
`restoreSession` (5484) and `forceAbort` (9669) but **not** by
`createSession` (which uses `session-setup.ts`'s `resolveToolActivation`
instead — a third variant of the same logic). `resolveSessionRole` (2800).
Tool-grant lifecycle methods are listed under B because granting ends in a
respawn — a genuine cross-cluster straddle.

**G — Archived-worktree bookkeeping.** ~35 methods, lines **8195–9424**:
`updateArchivedMeta` (8179), `listArchivedSessions` (8195),
`listArchivedSessionWorktrees` (8285), `buildArchivedWorktreeGroups` (8514),
`buildArchivedWorktreeScanContext` (8636), `archivedSessionWorktreeItems`
(8746) / `archivedSessionWorktreeItem` (8764), `readGitWorktreeRefs`
(8951)/`readGitWorktreeRefsUncached` (8961), `localBranchExists`
(8978)/`localBranchExistsUncached` (8990), `purgeOneSession` (8997),
`cleanupSearchForSession` (9168), `cleanupOrphanedSessionWorktrees` (9267),
`listOrphanedSessionWorktrees` (9319), `listOrphanedNonInteractiveSessions`
(9364), `terminateOrphanedSessions` (9382), `getExpiredArchiveStats` (9424),
`purgeExpiredArchives` (8267). Operates on `PersistedSession`, `SessionStore`,
filesystem, and `git` subprocess calls (`git worktree list --porcelain`,
`git show-ref`, `git branch -D`). See §2 for exactly how non-isolated this
cluster actually is (less than initial appearance suggests, but still the
best candidate — details matter for the cohort-1 seam in §4).

**H — Prompt assembly / model resolution.** `assemblePrompt`/`_assemblePrompt`
(2818/2822), `computeSkillsCatalog` (2854), `buildDelegateTaskSpec`/
`buildDelegatePromptParts` (2903/2914), role/model resolution helpers
(6559–6687), `tryAutoSelectModel` (6697, 250 lines, owns `_aigwModelCache`),
`tryApplyDefaultThinkingLevel` (6950). Touches `toolManager`,
`preferencesStore`, `roleManager`, `configCascade`, `projectConfigStore`.

**I — Messages/termination/orphan sweeps (grab-bag).** `terminateSession`
(180 lines — cascade-reap, extension-channel close, bg-process
`abortAllWaits`+`cleanup` at 8021–8023, MCP scope cleanup via
`cleanupScopedMcpManagersForSessionScope` at 8085), `cascadeReapOwner`
(7907), `archiveWithCascade`, title generation, `waitForIdle`/`waitForStreaming`,
`registerExternalSession`, sandbox-network helpers
(`ensureSandboxNetwork`/`cleanupSandboxNetwork`/`recoverSandboxSessions`,
1375, ~100 lines).

---

## 2. Coupling analysis

### 2.1 Fields touched by 3+ clusters (the real blockers)

| Field | Touched by | Why it resists extraction |
|---|---|---|
| `sessions` | A, B, C, E, G (read-only), I | The universal shared mutable state. Any extracted module needs either a live reference/getter, or to go through existing accessors (`getSession`, `getAllSessionsRaw`) rather than a raw field. |
| `mcpManager` / `scopedMcpManagers` | A (restoreSession, createSession), B (forceAbort, grantToolPermission), D (owns them), F (buildToolActivationArgs), I (terminateSession cleanup) | Every bring-up/teardown path needs a scoped MCP manager — genuinely cross-cutting, not just historically entangled. |
| `toolManager` | A, B, D, F, H | Read-only from `SessionManager`'s point of view (an injected collaborator, never mutated here) — a shared *read* dependency, not a shared *mutable-state* blocker; safe to hand to extracted modules by reference. |
| `_sessionRespawnGenerations` / `_restoreCoordinators` | A, B | Both concern rebuild coalescing/fencing — a legitimately shared but narrow (~60-line) unit: `_coalesceRestore`/`_nextRespawnGeneration`/`_sessionWriterIsCurrent`/`_fenceReplacedSession`. Worth its own tiny module eventually, but not attempted in cohort 1. |
| `(this as any).bgProcessManager` | A, B, I, shutdown | Untyped, cross-cutting, but every call site already defensively optional-chains (`bgMgr?.restoreSession`, `?.flush()`) — already treated as pluggable in practice, just not in the type system. |

### 2.2 Clusters extractable behind a delegate seam today

- **D (MCP wiring)** touches only its own 5 fields plus read-only
  already-injected collaborators (`toolManager`, `projectConfigStore`,
  `projectContextManager`). 6 external call sites
  (`restoreSession`, `createSession`, `forceAbort`, `grantToolPermission`,
  `terminateSession`, `assignRole`) all just need to call the new module
  instead of `this.ensureMcpManagerForContext(...)` — mechanical, not
  conceptually hard.
- **G (archived-worktree bookkeeping)** is close to pure over
  `PersistedSession`/`SessionStore`/filesystem/git, **with two real coupling
  edges, both narrow and already visible**:
  1. `buildArchivedWorktreeScanContext` (8636, ~110 lines) reads
     `this.sessions.values()` **read-only** to build a guard context that
     protects worktrees still referenced by a live (non-archived) session.
  2. `purgeOneSession` (8997) calls **`this.cascadeReapOwner(ps.id)`** (8997
     → 9042; `cascadeReapOwner` itself lives at 7907, in cluster I) as a
     "reap children before destroying the parent's data" safety net, and
     also reads `this.projectContextManager` directly (9017–9036, the
     team-lead purge guard) and `this.sandboxManager` (9055, file deletion
     inside a possible sandbox).
  Both edges are satisfiable as **injected callbacks on a ctx object**
  (exactly the "ctx is data, not imports" rule from route-registry.md §Why
  ctx is data, not imports) rather than requiring `ArchivedWorktreeManager`
  to import from or subclass `SessionManager`. See §4.
- **C (persistence/store resolution)** is already close to a set of pure
  functions over `projectContextManager`/`_testStore`.
- **H (prompt assembly/model resolution)** is self-contained over
  `toolManager`/`preferencesStore`/`roleManager`/`configCascade`/
  `_aigwModelCache` (the cache field would move with it).

### 2.3 `forceAbort` → MCP wiring call chain (confirmed, exact lines)

```
forceAbort (9521)
  → 9607: await this._coalesceRestore(id, async (generation) => { ... })
      → _coalesceRestore (1264) → 1271: this._nextRespawnGeneration(sessionId)
  → [inside the coalesce callback] 9668: await this.ensureMcpManagerForContext(session.projectId, session.cwd)
      → ensureMcpManagerForContext (2347) → delegates to ensureMcpManager({projectId, cwd})
          → ensureMcpManager (2322):
              - "default" scope → returns cached this.mcpManager, no connect (2324)
              - cached scoped manager exists → returns it, no reconnect (2326)
              - otherwise → 2335: this.createMcpManager(cwd, {projectId, scopeKey})
                  → createMcpManager (2304) → 2308: new McpManager(cwd, projectConfigStore, bobbitStateDir(), {...})
                    (class defined src/server/mcp/mcp-manager.ts:245)
              - 2336: this.scopedMcpManagers.set(key, mgr)
              - 2337: await mgr.connectAll()
                  (McpManager.connectAll defined src/server/mcp/mcp-manager.ts:669)
```

`forceAbort` never calls `_respawnAgentInPlace`/`restoreSession` — this is
literally a third, hand-duplicated rebuild path. This is exactly the shape
that produced the bug the D5/PR #105 line in
`~/Documents/dev/bobbit-fable-refactor/TRACKER.md:351` diagnosed: a unit test
that exercises `forceAbort` on a session without a pre-cached
`scopedMcpManagers` entry hits `createMcpManager` → `new McpManager(...)` →
`connectAll()` against **real ambient `~/.claude` MCP config** (real
Hindsight HTTP + a real `npx` nano-banana spawn), because nothing in the
call chain is aware it's running under test. All three `.connectAll(` sites
in the file: 2337 (`ensureMcpManager`, reachable from
forceAbort/restoreSession/createSession/grantToolPermission), 2553 and 2562
(both inside `initMcp`, startup-only).

### 2.4 `SessionManager.shutdown()` — current state (verified live, this worktree)

`shutdown()` spans **9776–9871**. Confirmed by direct read: it clears
`purgeInterval`/`_statusHeartbeatTimer` (9777–9784), flushes session/cost
stores and `bgProcessManager?.flush()` before and after a per-session
teardown loop (9796–9859) that calls `session.rpcClient.stop()` per session,
and closes the search index (9861–9870). **It never calls `.disconnectAll()`
on `mcpManager` or any entry of `scopedMcpManagers`.** The only
`.disconnectAll(` call site in the entire file remains
`removeScopedMcpManagerByKey` at line 2269, which `shutdown()` never invokes
— confirmed by `grep -n "disconnectAll" session-manager.ts` returning exactly
one hit. `~/Documents/dev/bobbit-fable-refactor/TRACKER.md:351`'s note that
"SessionManager.shutdown() never disconnectAll()'d default/scoped MCP
managers... now does, best-effort" describes a fix from PR #105, which per
`TRACKER.md:354` ("MERGE QUEUE unblocked pending #105 gate") had **not yet
landed on `aj-current`** as of this worktree's base commit (confirmed:
`git merge-base --is-ancestor` shows this worktree is downstream of
`809888c8`, the commit referenced in the repo's git log, but the PR #105 fix
itself is queued behind other gates, not yet merged). **Any cohort-1 work on
MCP wiring should re-check this against current `aj-current` before landing**
— if #105 has merged by then, `shutdown()`'s disconnect call is new
production behavior the decomposition must preserve, not reintroduce as a
regression.

---

## 3. Cohort plan

Mirrors the protocol in [route-registry.md §Migration protocol for future
cohorts](route-registry.md#migration-protocol-for-future-cohorts): pick a
lexically-contiguous, low-blast-radius, already-tested cohort first; defer
hot paths; one cohort's move + legacy-delete lands in the same commit so the
route/method surface is never double-handled or silently dropped.

| Order | Cohort | Cluster | Size | Risk | Why this order |
|---|---|---|---|---|---|
| 1 | Archived-worktree bookkeeping | G | ~35 methods, lines 8195–9424 | **Low** | Near-pure over `PersistedSession`/filesystem/git; only two coupling edges, both satisfiable as injected callbacks (§2.2, §4). Has partial existing test coverage (`tests/worktree-inventory.test.ts`, `tests/shared-worktree-guard-repro.test.ts`, `tests/session-recovery-agent-dir.test.ts`) to pin against. No MCP, no RpcBridge, no respawn coupling. |
| 2 | MCP wiring | D | ~15 methods, lines 2224–2562 | **Low-medium** | Touches only its own 5 fields + read-only injected collaborators. Risk is entirely in getting the 6 external call sites (A, B, F, I) redirected identically — mechanical but must be done atomically per call site to avoid a window where two managers exist for the same scope. This is also the cluster PR #105 already patched once (shutdown-disconnect gap) — landing this cohort is the natural place to also verify/re-fix that gap under a single seam instead of a scattered fix. |
| 3 | Lifecycle-generation fence | (sub-slice of A+B) | ~6 methods, lines 1237–1281 | **Low** | Tiny, self-contained (`_coalesceRestore`, `_nextRespawnGeneration`, `_sessionWriterIsCurrent`, `_fenceReplacedSession`, `_currentRespawnGeneration`). Extracting this before cohort 4 gives cohort 4 a single already-tested fencing primitive to call from all four rebuild paths instead of duplicating fencing logic during the merge. |
| 4 | Unify session bring-up onto `session-setup.ts`'s pipeline | A + B's rebuild paths | `restoreSession` (457 lines), `forceAbort`'s inline rebuild (~150 of its 255 lines), `assignRole`'s inline rebuild (~220 lines), reconciled against `createSession`'s existing `executePlan`/`ctx` use | **High** | This is the actual payoff: today there are 3–4 independent hand-maintained copies of "construct bridge, wire tools, wire MCP, replay switch_session." Collapsing them onto the one pipeline `session-setup.ts` already exports removes the root cause of both the file's size and the concrete ambient-MCP-reach bug class (§2.3). Deliberately last: needs cohorts 2 and 3 landed first so there's one MCP seam and one fencing primitive for the unified pipeline to call, and it touches the highest-traffic session lifecycle code — matches STR-01's own "staged/high-risk, defer session/steer/WS hot paths" guidance, cited in route-registry.md itself. |
| (deferred, no cohort assigned yet) | Persistence routing (C), prompt/model resolution (H), status/broadcast thinning (E), tool-grant/activation (F) | — | — | Lower payoff (C, H are already thin), or already substantially addressed by an existing extraction (E — `session-status.ts` already owns the actual status-mutation invariant; what's left in `session-manager.ts` is broadcast plumbing around it, not core logic). F is entangled with cohort 4 (both `restoreSession` and `forceAbort` call `buildToolActivationArgs`) and should be revisited once cohort 4 exists as one call site instead of three. |

---

## 4. Seam design for cohort 1 (archived-worktree bookkeeping)

Goal: extract cluster G into `src/server/agent/archived-worktree-manager.ts`
with **zero behavior change** and **zero external call-site changes** —
`SessionManager`'s own public methods (`listArchivedSessions`,
`purgeArchivedSession` [public wrapper around `purgeOneSession`],
`listArchivedSessionWorktrees`, `cleanupArchivedSessionWorktrees`,
`purgeExpiredArchives`, `updateArchivedMeta`, `cleanupOrphanedSessionWorktrees`,
`listOrphanedSessionWorktrees`, `listOrphanedNonInteractiveSessions`,
`terminateOrphanedSessions`, `getExpiredArchiveStats`) keep their exact
current signatures and become one-line delegations. This matches
route-registry.md's own discipline: the move and the delegation swap land in
the same commit, so the method surface is never double-defined or dropped.
Confirmed existing external callers that must see no signature change:
`src/server/server.ts:11510, 11661, 11683, 11690, 14007, 14073, 15873` (and
any route module already calling through `sessionManager.*`).

### 4.1 The two coupling edges, and how to sever them

1. **`buildArchivedWorktreeScanContext` reads `this.sessions.values()`
   read-only** (guard: "is this worktree still referenced by a live,
   non-archived session"). Fix: pass a **narrow snapshot function**, not the
   live `Map` and not full `SessionInfo` objects — mirrors route-registry's
   rule that a ctx carries data, not a reference to the god-object's
   internals. Define:

   ```ts
   // archived-worktree-manager.ts
   export interface LiveSessionWorktreeRef {
     id: string;
     cwd: string;
     projectId?: string;
     goalId?: string;
     teamGoalId?: string;
     archived: boolean; // dormant/placeholder sessions read as archived: true
   }

   export interface ArchivedWorktreeCtx {
     listLiveSessionWorktreeRefs(): LiveSessionWorktreeRef[];
     // ...see below
   }
   ```

   `SessionManager` supplies this at construction (or lazily, since
   `sessions` mutates after construction — see 4.2) as
   `() => Array.from(this.sessions.values()).map(s => ({ id: s.id, cwd: s.cwd,
   projectId: s.projectId, goalId: s.goalId, teamGoalId: s.teamGoalId,
   archived: s.status === "terminated" }))` — read `buildArchivedWorktreeScanContext`
   (8636–8745) first to confirm the exact fields it currently reads off each
   live session before finalizing this interface; do not guess the field
   list, copy it from the current implementation verbatim.

2. **`purgeOneSession` calls `this.cascadeReapOwner(ps.id)`,
   `this.projectContextManager` (team-lead purge guard), and
   `this.sandboxManager` (sidecar/jsonl deletion path).** Fix: thread all
   three through the ctx as data/callbacks, exactly as
   route-registry.md's `CoreRouteCtx` threads `isHeadquartersOwnedPath` etc.
   — these are existing `handleApiRoute`-local closures reused verbatim, not
   reimplemented:

   ```ts
   export interface ArchivedWorktreeCtx {
     listLiveSessionWorktreeRefs(): LiveSessionWorktreeRef[];
     cascadeReapOwner(sessionId: string): Promise<void>;
     projectContextManager: ProjectContextManager | null; // already a plain reference, no cycle
     sandboxManager: SandboxManager | null;               // same
     cleanupSearchForSession(sessionId: string, projectId?: string): void; // moves INTO this module (see 4.3) — no longer needs threading once cluster G owns it outright
     resolveStoreForSession(id: string): SessionStore | null; // Cluster C, already a thin resolver — thread it rather than duplicate
   }
   ```

   `projectContextManager` and `sandboxManager` are plain object references
   already injected into `SessionManager` at construction — passing them
   into `ArchivedWorktreeManager`'s constructor is not a new import cycle
   (same rule route-registry.md's "why ctx is data, not imports" section
   establishes: these are leaf-module types already imported directly by
   session-manager.ts, not something that would need to import back from
   `session-manager.ts`).

### 4.2 Construction: instance held once, not per-call ctx

Unlike `CoreRouteCtx` (built fresh per HTTP request, because `RouteTable` is
a single module-level instance serving multiple gateway instances in tests),
`ArchivedWorktreeManager` should be **one instance per `SessionManager`
instance**, constructed once inside `SessionManager`'s own constructor and
held as a private field:

```ts
// session-manager.ts constructor, alongside existing collaborator wiring
this.archivedWorktrees = new ArchivedWorktreeManager({
  listLiveSessionWorktreeRefs: () => Array.from(this.sessions.values()).map(toLiveSessionWorktreeRef),
  cascadeReapOwner: (id) => this.cascadeReapOwner(id),
  projectContextManager: this.projectContextManager,
  sandboxManager: this.sandboxManager,   // NOTE: sandboxManager is set post-construction via setSandboxManager (no line-declared setter found in cluster G's read window — verify call order before landing; if setSandboxManager can run after this constructor, the ctx needs a getter (`() => this.sandboxManager`) instead of a value capture)
  resolveStoreForSession: (id) => this.resolveStoreForSession(id),
});
```

This is why the closures matter: `sessions` is mutated continuously after
construction, and (per the note above) `sandboxManager` may be assigned
*after* the constructor runs. Any field captured by value at construction
time instead of by reference/getter would silently go stale — this is the
one place cohort 1 must NOT copy `CoreRouteCtx`'s per-request-value pattern
verbatim; it must use late-bound getters/closures for anything mutated after
construction, exactly as shown above (`() => this.sessions...` and
`() => this.sandboxManager`, not captured values).

### 4.3 What moves outright vs. what stays threaded

- **Moves into `archived-worktree-manager.ts` outright** (per
  route-registry.md's rule: "anything used ONLY by the routes/methods being
  migrated moves into the new file, not threaded"): `updateArchivedMeta`,
  `listArchivedSessions`, `listArchivedSessionWorktrees`,
  `buildArchivedWorktreeGroups`, `buildArchivedWorktreeScanContext`,
  `archivedSessionWorktreeItems`/`archivedSessionWorktreeItem`,
  `readGitWorktreeRefs(Uncached)`, `localBranchExists(Uncached)`,
  `purgeOneSession`, `cleanupOrphanedSessionWorktrees`,
  `listOrphanedSessionWorktrees`, `listOrphanedNonInteractiveSessions`,
  `terminateOrphanedSessions`, `getExpiredArchiveStats`,
  `purgeExpiredArchives`. **Verify before moving**: grep each for callers
  outside cluster G's own methods (some, like `updateArchivedMeta`, are
  called from `terminateSession`/`archiveWithCascade` in cluster I at line
  7423 — those callers become `this.archivedWorktrees.updateArchivedMeta(...)`,
  not a signature change, just a call-site prefix change).
- **`cleanupSearchForSession` (9168)** is used only inside cluster G today
  (`purgeOneSession` at 9045) per the read in §2.2 — moves in outright too,
  removing it from the threaded-ctx list above once confirmed no other
  caller exists (`grep -n "cleanupSearchForSession" session-manager.ts` before
  landing, to be certain).
- **Stays as threaded ctx callbacks** (owned by other clusters, reused not
  duplicated): `cascadeReapOwner` (cluster I), `resolveStoreForSession`
  (cluster C), `projectContextManager`/`sandboxManager` (already-injected
  collaborators).

### 4.4 Pinning strategy

- Existing tests that already exercise this surface —
  `tests/worktree-inventory.test.ts`, `tests/shared-worktree-guard-repro.test.ts`,
  `tests/session-recovery-agent-dir.test.ts` — must pass unchanged (parity
  evidence, same discipline as route-registry.md's cohort 1).
- Add a **new unit test file** `tests/archived-worktree-manager.test.ts`
  exercising `ArchivedWorktreeManager` directly against a fake
  `ArchivedWorktreeCtx` (no `SessionManager`, no MCP, no RpcBridge, no
  sandbox) — this is the actual payoff of the extraction: cluster G's git/fs
  logic becomes testable without dragging in the rest of the dependency
  graph, the same stated purpose `session-status.ts`'s header comment gives
  for its own extraction (§5).
- `npm run check`, `npm run test:unit`, `npm run test:e2e` (API phase) must
  show no new failures against the current baseline, per
  route-registry.md's own protocol step 6.

---

## 5. Precedent already in the codebase

- **`session-setup.ts`** (80,936 bytes, imported at session-manager.ts:117)
  already implements a `SessionSetupPlan` + `PipelineContext` "plan+ctx"
  pipeline — pure exported functions (`resolveBridgeOptions`,
  `resolveGoalExtensions`, `resolveTools`, `resolvePrompt`,
  `resolveToolActivation`, `subscribeToEvents`, `persistOnce`,
  `handleSetupFailure`), culminating in `executePlan(plan, ctx)` (line 1098).
  `buildPipelineContext` (session-manager.ts:1799) constructs the `ctx`,
  bundling collaborators **and bound closures back into SessionManager
  methods** (`assemblePrompt`, `applySandboxWiring`, `handleAgentLifecycle`,
  `trackCostFromEvent`, `broadcast`). This is the direct structural analog
  of `CoreRouteCtx` from route-registry.md — same shape of solution, already
  half-built — but today it's wired up for `createSession`/
  `createDelegateSession` only, not `restoreSession`/`forceAbort`/
  `assignRole`. Cohort 4 (§3) is precisely "extend this existing seam to the
  other three bring-up paths," not invent a new one.
- **`session-runtime.ts`** (155 lines) already exports
  `createSessionBridge(options): IRpcBridge` (line 94) as the one factory
  that picks `RpcBridge` vs. `LazyClaudeCodeBridge` — this name is not to be
  reinvented; all four bring-up paths already call it (session-manager.ts:5597,
  ~7570s inside `assignRole`, 9697 inside `forceAbort`, plus session-setup.ts:1391/1536).
- **`session-status.ts`** (2,326 bytes) is the clearest existing precedent
  for the "small pure module, narrow typed interface, tests decoupled from
  the god-class" pattern this doc proposes for cluster G: its own header
  comment states it lives in its own file specifically so unit tests can
  exercise `broadcastStatus<S extends BroadcastableSession>` "without
  dragging in the rest of the SessionManager dependency graph (search,
  flexstore, sandbox, mcp, …)." Cite this file directly as the template.
- **`McpManager`** (`src/server/mcp/mcp-manager.ts:245`, `connectAll` at 669,
  `disconnectAll` at 831) is already its own class outside session-manager.ts
  — cohort 2's job is only to give `SessionManager` a narrower seam onto it
  (an `McpWiring`-style wrapper owning `mcpManager`/`scopedMcpManagers`), not
  to touch `McpManager` itself.
- **`RpcBridge`** (`rpc-bridge.ts:298`) already owns all child-process/wire
  state; `SessionInfo.rpcClient` is a field per session, not a map
  `SessionManager` holds directly — confirms the existing direction of
  dependency (`SessionInfo` owns its bridge; `SessionManager` owns the map of
  `SessionInfo`) that any new seam should preserve.

---

## 6. Hazards (grounded in this repo's history)

1. **Restart persistence / the "mirrors session-setup.ts::X" duplication is
   exactly where a merge-drop would land invisibly.** `restoreSession`
   (5333) and `session-setup.ts`'s pipeline are two independently-maintained
   implementations of the same intent, cross-referenced only by source
   comments (2684, 2697, 2764, 2788), not by shared code. Per
   `~/Documents/dev/bobbit-fable-refactor/INSIGHTS.md`'s "merge-drop class"
   finding (≥8 features silently destroyed by wholesale conflict resolution,
   always "server-side hunks lost while clients/tests survived as orphans"),
   a conflict that touches one copy but not the other during cohort 4's
   unification would be invisible unless both paths are covered by the same
   pinning test *before* the merge starts, not added after. Any cohort-4 PR
   must open with a snapshot test comparing `restoreSession`'s and
   `createSession`'s (post-unification) output side by side, run against
   `master`/`aj-current` pre-change, to make divergence loud rather than
   silent.

2. **bg_process re-attach is a real, load-bearing, untyped coupling point
   that cohort 1/2/4 must not accidentally sever.** `restoreSession` calls
   `bgMgr.restoreSession(ps.id)` at 5755–5759 through the untyped `(this as
   any).bgProcessManager` cast — this is the exact call site
   `docs/bg-process-persistence.md` and
   `~/Documents/dev/bobbit-fable-refactor/FINDINGS.md`'s bg-process-manager
   finding (describing `restoreOne`/`restoreLoadOutput` at
   bg-process-manager.ts:1028–1105 and the debounce-mismatch dedup bug) are
   written against. Cohort 4's unification of `restoreSession` onto
   `session-setup.ts`'s pipeline must carry this call forward exactly once
   (not zero times, not duplicated into a second path) — `createSession`'s
   existing pipeline has **no** equivalent bg-process-reattach call today
   (new sessions have no bg processes to restore), so naively merging
   `restoreSession`'s logic into `createSession`'s shape must not accidentally
   drop this session_id-conditional branch. This is also the same
   `bgProcessManager` field that has zero type declaration anywhere — any
   cohort touching it should consider (but is not required to, out of scope
   for this spike) giving it a proper typed optional field instead of
   perpetuating the `as any` cast into new modules.

3. **The ambient-MCP reach (PR #105's own finding, TRACKER.md:351) is the
   headline hazard for cohorts 2 and 4.** `forceAbort`'s independent
   `ensureMcpManagerForContext` call (9668) is exactly how a unit test
   reached real `~/.claude` MCP config (real Hindsight HTTP, real `npx`
   nano-banana spawn) with no teardown, hanging test runs. §2.3/§2.4 above
   confirm this call chain still exists and that `shutdown()` still never
   disconnects MCP managers in this worktree's base. **Any MCP-wiring
   extraction (cohort 2) must (a) preserve or add a test-seam so
   `ensureMcpManagerForContext` can be stubbed without every call site
   individually mocking `McpManager`, and (b) fix (or confirm already-fixed
   upstream) that `shutdown()` disconnects every scoped manager** — a
   decomposition that makes MCP wiring one seam instead of four scattered
   call sites is the natural place to close this gap once, rather than
   patch it four times as PR #105 evidently had to consider.

4. **The merge-drop class's root enabler is exactly the god-class pattern
   this spike targets** — `INSIGHTS.md`: "Root enabler: server.ts as a
   16k-line conflict magnet → the pulled-forward STR-03 + delegate-module
   extractions attack the cause, not just symptoms." `session-manager.ts` at
   10,034 lines is the same shape of conflict magnet for anything touching
   session lifecycle. Every cohort in §3 reduces simultaneous-PR conflict
   surface on this file — but until cohort 4 lands, PRs touching `forceAbort`,
   `restoreSession`, and `assignRole` concurrently remain a live merge-drop
   risk exactly like the `b687d93d`/`eef210f3`/`a34f27e6` casualties
   documented in `INSIGHTS.md`. Sequencing (cohort 1 → 2 → 3 → 4, not
   parallel) is a deliberate hazard mitigation, not just an implementation
   convenience — running cohort 4 concurrently with any other in-flight
   session-lifecycle PR is the single riskiest way to execute this plan.

5. **The `sandboxManager`/`configCascade` no-modifier (effectively public)
   fields (1171, 1183) are set post-construction** — confirmed:
   `setSandboxManager(manager)` at session-manager.ts:1335, called from
   `server.ts`; `configCascade` has no setter method at all and is assigned
   directly as a bare field (`sessionManager.configCascade = configCascade;`
   at `src/server/server.ts:1435`, also self-assigned in
   `verification-harness.ts:2596` for a different instance). Confirm the
   exact call order relative to `SessionManager`'s own constructor in
   `server.ts`'s `createGateway`/bootstrap sequence before cohort 1 lands,
   per §4.2's note.
   Any extracted module that captures these by value at construction time
   instead of via a live getter will silently freeze on `null`/undefined if
   construction order ever changes — a class of bug this repo's own
   `docs/internals.md` config-cascade section and the CQ-01 finding (untyped
   `as any` property bags causing silent fail-closed/fail-open drift) both
   warn about in spirit. §4.2 addresses this directly for cohort 1; cohorts
   2–4 should apply the same rule (getters/closures, not captured values,
   for anything set after construction).

6. **No cohort in this plan touches `handleApiRoute` or any route file** —
   confirmed by construction (all four cohorts are internal to
   `session-manager.ts` and one new sibling module per cohort), so this
   spike does not create the STR-01/route-registry class of risk. The only
   overlap with route-registry.md's existing work is that
   `sessionManager.*` methods are *called from* migrated and unmigrated
   routes alike (§4, confirmed call sites in `server.ts`); cohort 1/2's
   "keep exact same public signatures" discipline is what keeps that overlap
   inert.

---

## 7. What's explicitly NOT decided by this spike

- The exact shape of a typed `bgProcessManager` field (hazard 2) — flagged,
  not designed; out of scope for STR-06.
- Whether `_sessionRespawnGenerations`/`_restoreCoordinators` (cohort 3)
  become a class or stay a set of free functions taking `Map`s as
  parameters — either works; deferred to the cohort-3 implementation PR.
- The final shape of cohort 4's unified pipeline (whether `restoreSession`
  is rewritten to call `executePlan`, or `executePlan` grows a `mode:
  "restore"` branch, or a new `executeRestorePlan` sibling is added) — this
  needs its own design pass once cohorts 1–3 exist and reduce the surface
  area enough to reason about precisely; asserting a specific shape now,
  before cohort 2/3 land and change what `restoreSession` even needs to
  call, would be premature.
