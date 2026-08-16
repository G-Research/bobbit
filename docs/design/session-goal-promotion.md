# Promote Session to Goal — implementation design

## Scope and invariants

A goal proposal may choose one of two worktree modes:

- `new-worktree` is the default. It keeps the existing `POST /api/goals` path and serialization unchanged.
- `current-session` promotes the proposal-owning regular session in place. It adopts that session's exact checkout and makes the same Bobbit session the goal's lead.

Promotion changes graph metadata and the agent's canonical goal/team context only. It does not copy, move, rename, reset, checkout, commit, provision, run setup, or create/transfer a sandbox worktree. The source session remains the checkout and sandbox lifecycle owner. `PersistedGoal.worktreeOwnerSessionId` records provenance and links retries/recovery; it does **not** transfer ownership from the session to the goal.

The accepted scope is limited to the proposal owner in the same registered project. Arbitrary session IDs, branches, worktree paths, repository coordinates, cross-project adoption, busy-session promotion, demotion, and a second team lead are out of scope.

```ts
type GoalWorktreeMode = "new-worktree" | "current-session";

interface PersistedGoal {
  /** Adoption provenance/idempotency link; the referenced session still owns the checkout. */
  worktreeOwnerSessionId?: string;
}
```

`worktreeMode` is a human proposal-review choice, not a `propose_goal` tool argument. When it is absent, parsing resolves it as `new-worktree`, but serialization leaves it absent. Therefore existing drafts and ordinary acceptance request bodies remain byte-for-byte unchanged.

## Comparative design

### A/B comparison

| Approach | Control/data flow | New state owner and persisted state | Expected files/APIs | Failure and restart recovery | Test seams | Why rejected/selected |
|---|---|---|---|---|---|---|
| **A — compose existing managers** | Proposal-owner route derives the source from its path and draft; locked recheck → normal `GoalManager.createGoal` with an internal adopted-workspace input → normal gate initialization → `TeamManager.adoptExistingLead` reservation → `SessionManager.promoteToGoalLead` staged replacement → commit or attempt-owned compensation. | No new durable transaction owner. One optional proposal enum and one optional goal provenance field. Existing session attachment fields and existing `PersistedTeamEntry.teamLeadSessionId` remain canonical. A per-owner in-memory single-flight lock is only concurrency control. | Extend owner-scoped proposal routes in `src/server/server.ts`; add pure eligibility/composition helpers in `src/server/agent/session-goal-promotion.ts`; narrow manager methods in `goal-manager.ts`, `team-manager.ts`, and `session-manager.ts`; existing proposal, goal, session, team, gate, UI, and cleanup stores remain owners of their current data. | Candidate runtime is verified before the old bridge stops. Pre-commit failure removes only the matching adopted team reservation, gates, and goal, and leaves the old session/runtime intact. A crash is recognized by `worktreeOwnerSessionId` during pre-session boot reconciliation: complete the exact attachment or compensate the incomplete attempt. Repeats return the one existing goal/lead. | Existing proposal-file, goal creation, staged replacement, sandbox-realm, team-restore, and shared-worktree tests listed below; new focused proposal/eligibility/manager/integration/browser tests cover the new branches. | **Selected.** It adds the minimum state and composes already-tested creation, persistence, staged replacement, restore, and reference guards. No requirement needs a second transaction journal or hidden-goal lifecycle. |
| **B — dedicated promotion transaction service** | An `InPlacePromotionService` would create a pending transaction, hide a provisional goal, journal each phase (goal, gates, lead, runtime, commit), then publish it. Every read path would need to interpret pending visibility. | New durable promotion transaction/journal store, phase state machine, hidden/pending goal status, recovery owner, retention/cleanup policy, and transaction-to-goal/session indexes. | New service and store modules; journal schema/migration; pending-aware goal/session/team APIs and broadcasts; boot journal replay; administration/diagnostic cleanup; UI pending/failure states in addition to every file required by A. | Explicit phase replay is possible, but every crash boundary needs journal durability, visibility, rollback, stale-transaction, and journal-corruption handling. The service would still call the same manager seams to replace the runtime and reserve the lead. | A full fault matrix for every persisted phase, corrupt/missing journal entries, pending visibility, journal cleanup, and restart replay, in addition to A's tests. | **Rejected.** It introduces several state owners and recovery semantics without satisfying an unmet requirement. The optional goal provenance relation plus conditional compensation already supplies idempotency and crash recognition. Reconsider only if implementation proves the existing stores cannot conditionally compensate or reconcile. |

Also rejected:

- adding caller-supplied `promoteSessionId`, branch, or paths to general `POST /api/goals`;
- creating a no-worktree goal and later mutating it from arbitrary client coordinates;
- copying/spawning a second lead and moving transcript state;
- inferring adoption from equal paths, branch shape, or a `team-lead` role;
- provisioning or transferring a sandbox worktree during promotion.

## Proposal contract and owner-scoped API

`src/server/proposals/proposal-types.ts` adds `worktreeMode` to `GOAL_FRONTMATTER_KEYS` and validates only the two enum values in `validateGoalInlineFields`. The serializer's existing skip-undefined behavior is retained. No default is written into old or untouched drafts.

The existing session proposal namespace gains three goal-only operations:

| Method and route | Contract |
|---|---|
| `GET /api/sessions/:ownerId/proposal/goal/worktree-mode` | Parse the owner's draft and return `{ mode, eligibility }`. `mode` defaults in the response only. `eligibility` is recomputed from the owner session and authoritative project/session records; the active browser tab is irrelevant. |
| `PUT /api/sessions/:ownerId/proposal/goal/worktree-mode` | Accept only `{ mode: "new-worktree" | "current-session" }`. Re-read the owner's goal draft, replace only `worktreeMode`, write through `writeProposalFile`, and emit the normal stamped `proposal_update`. It accepts no coordinates or source-session field. |
| `POST /api/sessions/:ownerId/proposal/goal/accept` | Used only when the persisted mode is `current-session`. It may carry the same human-editable goal definition fields used by the panel, but rejects source/session/worktree/branch/repository/sandbox authority fields. It derives the source, project, mode, and adoption coordinates from `ownerId`, the draft, and canonical server records. |

When mode is absent or `new-worktree`, the panel continues to call the existing `createGoal()` client helper and `POST /api/goals`; it does not call the new accept route. This keeps ordinary goal creation unchanged.

`writeProposalFile`, `parseProposalFile`, `latestRev`, snapshot restoration, WebSocket rehydrate, proposal-directory archive retention, and `copyProposalDirIfPresent` continue to carry the enum without a second draft store. An archived owner remains ineligible; a continued session owns its byte-identical copied draft and is evaluated as the new proposal owner.

## Eligibility

A new pure `evaluateSessionGoalPromotion(...)` in `src/server/agent/session-goal-promotion.ts` returns:

```ts
type SessionGoalPromotionEligibility = {
  eligible: boolean;
  code: string;
  reason?: string;
  branch?: string;
  worktreePath?: string;
  repoWorktreeCount?: number;
  sandboxed?: boolean;
};
```

Both the GET projection and the final locked accept recheck call this same helper. Eligibility requires all of the following:

1. The route owner is an existing, non-archived, live `idle` regular interactive session with a durable transcript.
2. It has no `assistantType`/legacy assistant marker, `goalId`, `teamGoalId`, `teamLeadSessionId`, `staffId`, `delegateOf`, `parentSessionId`, or `childKind`; it is not `readOnly`, `nonInteractive`, compacting, streaming, starting, aborting, terminated, or already claimed by another promotion.
3. The proposal's stamped target project equals the source session's registered project.
4. The session owns rather than borrows the checkout: `borrowsWorktree !== true`, and the exact durable `cwd`, `worktreePath`, `branch`, and `repoPath` exist and agree with the live projection.
5. For multi-repo projects, `repoWorktrees` contains every configured Git repository exactly once and every component coordinate is present. A partial set is unsafe.
6. For sandboxed sessions, the existing project container/realm and owned sandbox worktree coordinate are reachable. Eligibility never creates either one.
7. No existing live goal provenance, team reservation, or conflicting lead/session attachment claims this owner, except the exact idempotent promotion relation returned on retry.

Reasons are stable, concise UI text (for example, `Current session is unavailable while the session is working`, `Current session does not own a dedicated worktree`, or `Current session targets a different project`). The UI is advisory; acceptance always performs the locked recheck.

## Selected control flow

1. `POST .../accept` enters a single-flight lock keyed by proposal owner ID.
2. It looks up a non-archived goal with `worktreeOwnerSessionId === ownerId`. If the relation is complete, return that goal. If it is incomplete, reconcile it; never create another goal.
3. Re-read the goal draft, source session, source project, workflow, form definition, and eligibility. Reject any submitted authority fields.
4. Call normal `GoalManager.createGoal` with an **internal-only** `adoptedWorkspace` input built from the canonical source record. The adopted branch copies exact `cwd`, `worktreePath`, `branch`, `repoPath`, `repoWorktrees`, and `sandboxed`, stamps `worktreeOwnerSessionId`, and writes `setupStatus: "ready"`. It bypasses only `resolveWorktreeSupport`, pool claim/fill, worktree creation/rename, setup commands, and `goalProvisioned`; normal ID, nesting, metadata, workflow snapshot, goal-store validation, and timestamps remain unchanged.
5. Initialize gates with the existing `GateStore.initGatesForGoal`, then flush the goal and gate stores at the same external creation boundary used by ordinary goal creation.
6. `TeamManager.adoptExistingLead(goalId, ownerId)` installs the empty existing `PersistedTeamEntry` (`agents: []`) and `sessionToGoal` mapping before awaited runtime work. Exact repeats return the reservation; a different goal/lead claim conflicts. `startTeam` sees this reservation and cannot spawn a second lead.
7. Resolve the canonical `team-lead` role from the new goal, then call `SessionManager.promoteToGoalLead`. It uses `_coordinateSessionReplacement` and a generalized `_assignRoleStaged` target projection. Every prompt/tool/extension/env/model decision reads the **prospective** `goalId`, `teamGoalId`, role, project, sandbox, and coordinates, not the old session fields.
8. The candidate uses the same Bobbit ID, transcript/JSONL, `cwd`, worktree/repository coordinates, sandbox realm, clients, event frame, queued intents/background-process owner, model tuple, and title. It adds goal/team-lead prompt context, `BOBBIT_GOAL_ID`, goal and team extensions/tools, and the canonical role/accessory. It sends no duplicate kickoff prompt.
9. Start, switch the existing transcript, and validate the exact model/thinking tuple and sandbox realm. Write all attachment fields (`goalId`, `teamGoalId`, role/accessory and unchanged coordinates) in one **tentative** store update immediately before stopping the old bridge, matching the existing staged-replacement ordering. If old stop rejects, restore the exact prior presence/value of every field and retain the old listener/runtime.
10. Once old stop succeeds, synchronously install the already-verified candidate on the existing `SessionInfo`; this canonical bridge installation is the commit point. There is no fallible/awaited operation between successful old stop and the swap. The Bobbit session ID and clients do not change.
11. Subscribe team-lead events, transition a `todo` goal to `in-progress`, clear the proposal, and return the goal. Failures after canonical installation are repaired idempotently and do not roll back a working graph; a retry returns the committed relation.

### Commit and compensation boundary

Until the verified candidate becomes canonical after successful old-bridge stop, the attachment is uncommitted. The original session stays canonical and usable for every failure through a rejected old stop. A caught pre-commit failure conditionally performs, in order:

1. dispose only the staged replacement;
2. call `TeamManager.releaseAdoptedLead(goalId, ownerId)` only if the reservation still has that exact empty lead relation;
3. call `GateStore.removeGoalGates(goalId)` only for the attempt-created goal;
4. call `GoalManager.deleteGoal(goalId)` only if `worktreeOwnerSessionId` still equals `ownerId` and the source was not committed;
5. flush affected stores.

Compensation never calls Git, sandbox removal, worktree cleanup, session archive, or transcript cleanup. It does not remove a team entry that gained agents or changed lead, and does not remove an unrelated/reconciled goal. Fault injection must cover failure after goal creation, gate initialization, lead reservation, candidate start, transcript switch, tuple verification, durable session update, and old-bridge stop.

The relation is committed only after the tentative attachment remains durable, old-bridge stop succeeds, and the verified candidate is synchronously installed as canonical. A process crash after the tentative update but before canonical installation is recognized from the provenance/reservation/session tuple at boot and is completed or compensated before session restore. Failures after canonical installation are recovered idempotently rather than compensated.

## Restart and lifecycle

### Boot restoration

`TeamManager.restoreTeams` gains a first pass for goals carrying `worktreeOwnerSessionId`, before orphan-team cleanup. For each relation it uses the owning project stores to:

- verify same-project source identity and exact adopted coordinates;
- ensure exactly one `PersistedTeamEntry` reserves that source as lead;
- repair the source's durable `goalId`, `teamGoalId`, role/accessory fields when the relation is unambiguous;
- initialize any missing workflow gates caused by a crash before the normal creation flush;
- remove only an uncommitted attempt-owned goal/gates/reservation when repair cannot safely complete.

This pass runs inside the existing `restore-teams` boot phase. Then `SessionManager.restoreSessions` reconstructs the runtime from canonical goal/team metadata, and `resubscribeTeamEvents` restores subscriptions. It never invokes `startTeam`, creates a session, provisions a checkout, or creates a sandbox realm. Conflicting/multiple provenance claims fail closed and remain diagnostic rather than guessing.

### Archive, teardown, purge, and cleanup

- Direct archive/termination/purge of a live promoted source conflicts while its non-archived goal or team reservation references it.
- Direct `team/teardown` of a live promoted goal conflicts because keeping the session alive would require out-of-scope demotion.
- Goal archive is the allowed ordered path: publish goal archival intent, remove worker agents, remove the promoted reservation/subscriptions, then archive the source session through its existing lifecycle owner. The goal is never treated as having provisioned the source checkout.
- Sandbox cleanup remains session-owned. Promotion does not set `borrowsWorktree`, change the owner ID, call `SandboxManager.createWorktree`, or transfer the project container.
- `SessionManager.purgeOneSession`, `GoalManager.archiveGoal`, archived-worktree inventory, and the boot sweeper protect every component path while either endpoint or the team relation is live. Final cleanup is allowed once only after all three references are gone.
- A promoted host worktree is preserved through ordinary session archive retention; sandbox/container cleanup follows the source session's existing lifecycle. No cleanup path infers authority from `worktreeOwnerSessionId` alone.

The key distinction tested at every cleanup seam is:

- **source ownership:** the session created and still owns the checkout/sandbox lifecycle;
- **goal provenance:** `worktreeOwnerSessionId` says which session was adopted and enables idempotency/recovery, but does not authorize the goal to delete that checkout.

## UI

`renderGoalForm` in `src/app/proposal-panels.ts` changes the existing **Worktree** row into an accessible native radio group:

- **New worktree** — selected by default for absent/old proposals; shows the existing predicted goal path/component summary.
- **Current session** — shows the server-projected exact branch, worktree path, and component count. It is disabled with the server reason when ineligible.

The proposal owner comes from `state.activeProposals.goal.sessionId` (or the historical override owner), never `activeSessionId()` after a tab switch. `GoalProposalFormSnapshot`, its identity key, and `GoalFormConfig` carry the parsed mode/projection so edit, rehydrate, reload, snapshot restore, and continued-draft flows redraw consistently. Selecting a radio persists through `setGoalProposalWorktreeMode`; the returned stamped `proposal_update` remains the UI source of truth.

If a restored `current-session` selection becomes ineligible, it stays visibly selected, shows the reason, and disables Create until the user selects New worktree. In current-session mode the sandbox display is read-only from the source and the Auto-start control is disabled with copy explaining that the current session becomes lead immediately.

Acceptance branches only at the API call: new mode uses existing `createGoal`; current mode uses `acceptGoalProposalInCurrentSession`. A successful promotion navigates to the goal while the current session/transcript remains the same lead.

## Implementation map and test seams

### Expected changed and new files

| File | Existing/new symbol | Exact responsibility |
|---|---|---|
| `src/server/proposals/proposal-types.ts` | `GOAL_FRONTMATTER_KEYS`, `validateGoalInlineFields` | Preserve/validate optional `worktreeMode`; skip absent mode so old serialized bytes do not change. |
| `src/server/agent/session-goal-promotion.ts` **(new)** | `GoalWorktreeMode`, `evaluateSessionGoalPromotion`, `findExistingSessionPromotion` | Pure eligibility/reason projection and exact provenance lookup shared by GET and final recheck. No paths from a request are inputs. |
| `src/server/server.ts` | `handleApiRoute()` editable-proposal route block and goal archive/team teardown blocks | Add owner-scoped GET/PUT/accept operations, per-owner single flight, normal goal+gate composition, conditional compensation, and promoted lifecycle conflicts/order. Keep general `POST /api/goals` unchanged. |
| `src/server/agent/goal-store.ts` | `PersistedGoal`, canonical validation (`STRING_FIELDS`) | Persist/validate optional `worktreeOwnerSessionId`; absence remains the legacy shape. |
| `src/server/agent/goal-manager.ts` | `GoalManager.createGoal`, `GoalManager.archiveGoal`, internal `AdoptedGoalWorkspace` | Add internal adoption branch that copies exact canonical coordinates and starts ready without provisioning/setup/hook; guard archive cleanup by live source ownership; expose conditional attempt deletion through existing `deleteGoal`. |
| `src/server/agent/team-manager.ts` | `TeamManager.adoptExistingLead` **(new)**, `releaseAdoptedLead` **(new)**, `restoreTeams`, `startTeam`, `teardownTeam` | Persist one existing-lead reservation, maintain `sessionToGoal`, make repeat/conflict behavior explicit, reconcile before orphan cleanup, prevent second lead and direct teardown. |
| `src/server/agent/session-manager.ts` | `SessionManager.promoteToGoalLead` **(new)**, `_coordinateSessionReplacement`, generalized `_assignRoleStaged`, `terminateSession`, `storeArchive`, `purgeOneSession`, `buildArchivedWorktreeScanContext` | Stage/verify/rollback prospective goal-lead context on the same runtime identity and realm; block source destruction while live references remain; keep all component paths protected. |
| `src/app/state.ts` | `GatewaySession`, `Goal` | Carry the existing authoritative eligibility inputs and new goal provenance projection needed by UI/reload diagnostics. No independent durable client state. |
| `src/app/api.ts` | `getGoalProposalWorktreeMode` **(new)**, `setGoalProposalWorktreeMode` **(new)**, `acceptGoalProposalInCurrentSession` **(new)**, existing `createGoal` | Add owner-scoped calls; reject/omit coordinate authority client-side; leave existing new-worktree request construction byte-compatible. |
| `src/app/proposal-panels.ts` | `GoalFormConfig`, `renderGoalForm`, `GoalProposalFormSnapshot`, `goalProposalFormIdentityKey`, `syncProposalFormState`, goal accept handler | Render/persist the radio choice and exact projection, bind to proposal owner, block invalid restored mode, and choose only the acceptance API path. |
| `tests2/core/session-goal-promotion-proposal.test.ts` **(new)** | Cases below | Proposal default/bytes, enum, edit/snapshot/reopen persistence, and owner-scoped route authority. |
| `tests2/core/session-goal-promotion-eligibility.test.ts` **(new)** | Cases below | Pure single/multi-repo/sandbox eligibility matrix and stable reasons. |
| `tests2/core/session-goal-promotion-managers.test.ts` **(new)** | Cases below | Adopted goal creation, reservation/idempotency, staged continuity/rollback, restore, and cleanup ownership guards. |
| `tests2/integration/session-goal-promotion.test.ts` **(new)** | Cases below | Real API/Git/runtime retry, dirty checkout, multi-repo, sandbox preservation, restart, and cleanup behavior. |
| `tests2/browser/journeys/session-goal-promotion.journey.spec.ts` **(new)** | `Journey: Current-session goal promotion` | Registered visible selection/acceptance/continuity/reload/archive journey plus disabled and new-worktree controls. |
| `tests2/tests-map.json` | browser/unit registration rows | Register every new v2 test, including the browser file as `smoke-journey`. |

No change is expected in `src/server/agent/team-store.ts`: `PersistedTeamEntry.teamLeadSessionId` already persists an empty lead reservation. No new session ownership field is expected in `session-store.ts`: `goalId`, `teamGoalId`, role, coordinates, sandbox flags, and transcript identity already have the required durable owners.

### Existing composition anchors

Every reused contract below has an existing exact `tests2` anchor. These tests remain unchanged; the new tests cover only promotion-specific branches.

| Reused symbol/contract | Existing exact tests2 anchor |
|---|---|
| `GOAL_FRONTMATTER_KEYS` / goal plugin parse-write compatibility | `tests2/core/proposal-files.test.ts` — `describe("goal proposal round-trip")`, tests `"writes, reads, parses with frontmatter"` and `"round-trips the Sub-goals tab fields (subgoalsAllowed, maxNestingDepth, divergencePolicy, maxConcurrentChildren)"`; `tests2/core/proposal-rehydrate.test.ts` — `describe("goal proposal rehydrate — spec round-trip")`, test `"is idempotent on a body that already ends with a single newline (write→parse→write byte-stable)"`. |
| `writeProposalFile` / `editProposalFile` / snapshot restore | `tests2/core/proposal-files.test.ts` — `describe("editProposalFile semantics")`, test `"malformed edit rolls back on YAML_PARSE_ERROR; on-disk file unchanged"`; `describe("snapshot history")`, test `"restoreSnapshot round-trip: rev1 fields A, rev2 fields B, restore rev1 -> rev3 with fields A"`; `tests2/integration/proposal-edit-api.test.ts` — `test.describe("editable proposals — REST API")`, test `"seed → edit → GET reflects new content"`. |
| Archived/reopened proposal byte preservation via `copyProposalDirIfPresent` | `tests2/core/continue-archived-clone.test.ts` — `describe("copyProposalDirIfPresent")`, tests `"clones the live file plus every history snapshot byte-identical"` and `"is idempotent — running twice does not throw and leaves the clone intact"`; `tests2/integration/continue-archived-assistant.test.ts` — `test.describe("Continue-Archived (assistant) — Path B")`, test `"goal-assistant: clones live file + history snapshots byte-identical"`. |
| `GoalManager.createGoal` workflow snapshot/default framework | `tests2/core/goal-manager-default-workflow.test.ts` — `describe("GoalManager workflow defaulting")`, tests `"falls back to the first workflow in store order when no id is supplied"` and `"throws 'Workflow not found' when an explicit unknown id is supplied to a non-empty store"`. |
| Existing setup single-flight/ready transition, which adoption bypasses rather than changes | `tests2/core/parallel-goal-setup-repro.test.ts` — `describe("parallel goal setup reproductions")`, tests `"GOAL_SETUP_SINGLE_FLIGHT_EARLY_START_REGRESSION: a duplicate auto-start must await the authoritative setup"` and `"GOAL_SETUP_STALE_ERROR_ATOMIC_CLEAR_REGRESSION: ready must remove the active setupError in the same transition"`. |
| Existing multi-repo goal provisioning control | `tests2/integration/multi-repo-goal.test.ts` — test `"multi-repo goal creates per-repo worktrees"`. The new adoption test asserts this provisioning does **not** run for current-session mode. |
| `_coordinateSessionReplacement` + `_assignRoleStaged` transcript/bridge continuity | `tests2/core/orphan-tool-result-rehydration-boundaries.test.ts` — `describe("executable SessionManager rehydration boundaries")`, tests `"repairs assignRole history and replaces the old bridge cursor projection"`, `"durably queues prompts during assignRole staging and dispatches them only after commit"`, and `"preserves prompt acceptance order before and after replacement installation"`. |
| Staged rollback and candidate-before-old-stop safety | Same file/describe — tests `"rolls staged prompts back durably and dispatches them on the original bridge after assignment failure"`, `"cancels an active staged role on Stop and restores the untouched canonical bridge"`, and the parameterized test `"does not install an assignRole replacement when the $realm history switch fails"`. |
| Replacement serialization/idempotent lifecycle | Same file/describe — tests `"serializes concurrent assignRole replacements and leaves only the final bridge live"` and `"serializes assignRole then restart across the old-stop await and commits only the restart bridge"`. |
| Sandbox realm reuse/fail-closed replacement | Same file/describe — tests `"assignRole wires a real sandbox replacement before rehydrating container history"` and `"assignRole leaves the original sandbox bridge usable when realm wiring is unavailable"`; `tests2/integration/sandbox-restore.test.ts` — `test.describe("sandbox session restore")`, test `"restores sandboxed session with projectId and goalId"`. |
| Existing `PersistedTeamEntry` restoration and reverse indexes | `tests2/core/team-manager.test.ts` — `describe("TeamManager")` → `describe("persistence")`, test `"should persist team state and restore on new TeamManager instance"`; `tests2/core/team-manager-async-recovery.test.ts` — `describe("TeamManager awaited async recovery")`, test `"supports an explicit boot boundary: team restore completes before session restore and event resubscription"`. |
| `startTeam` duplicate-lead guard | `tests2/core/team-manager.test.ts` — `describe("TeamManager")` → `describe("startTeam")`, test `"should throw if team is already active for the goal"`; `tests2/core/paused-team-start-repro.test.ts` — `describe("TeamManager paused team start")`, test `"PAUSED_TEAM_START_AUTO_RESUME resumes once through the lifecycle before creating one lead"` (including its repeated explicit-start assertion). |
| Session/team durable attachment fields | `tests2/core/session-store.test.ts` — `describe("SessionStore")` → `describe("update()")`, tests `"updates role and teamGoalId"` and `"updates goalId and taskId"`; `describe("persistence")`, test `"persists sessions to disk and reloads"`. |
| Live session reference guard in goal/session cleanup | `tests2/core/shared-worktree-guard-repro.test.ts` — `describe("shared worktree guard reproductions")`, tests `"purging an archived session must not remove a worktree referenced by a live session cwd"`, `"purging an archived multi-repo session must keep shared repoWorktrees and may clean unshared ones"`, and `"goal archive must not remove a multi-repo worktree referenced by a live session resolver"`. |
| Sandbox worktree lifecycle ownership | `tests2/core/borrowed-sandbox-worktree-ownership.test.ts` — `describe("borrowed sandbox worktree ownership")`, tests `"round-trips borrowed ownership across persistence and never verifies or removes the source worktree"`, `"keeps owned sandbox cleanup as the control and removes its registered worktree coordinate exactly once"`, and `"persists flattened ownership and rejects owner termination before mutation until its nested-cwd borrower is archived"`. |
| Inventory and sweeper reference safety | `tests2/core/worktree-inventory.test.ts` — `describe("worktree inventory classifier")`, tests `"protects an exact live worktree but not a branch-only match"`, `"protects durable multi-repo team-agent component worktrees"`, and `"revalidates session and pool claims arriving during a deferred cleanup scan"`; `tests2/core/worktree-sweeper-multi.test.ts` — `describe("worktree-sweeper — bounded asynchronous sweep")`, tests `"preserves a worktree claimed after the initial diagnostic snapshot"` and `"preserves every ownership, pool, container, detached, archive, and branch-drift guard"`. |

## Exact new tests

### `tests2/core/session-goal-promotion-proposal.test.ts`

`describe("session-goal promotion proposal mode")`

- `it("keeps an absent worktreeMode byte-identical and resolves it as new-worktree")`
- `it("round-trips current-session through write, edit, reload, snapshot restore, and archive-copy")`
- `it("rejects every worktreeMode other than new-worktree and current-session")`
- `it("updates only the proposal owner's mode and emits the stamped proposal_update")`
- `it("accepts no session, branch, worktree, repo, or sandbox authority in the selector body")`

### `tests2/core/session-goal-promotion-eligibility.test.ts`

`describe("evaluateSessionGoalPromotion")`

- `it("accepts an idle regular owner with one complete dedicated worktree")`
- `it("accepts complete multi-repo coordinates and reports the exact component count")`
- `it("accepts an owned reachable sandbox realm without creating it")`
- `it.each(...)` named `"rejects forbidden relation or lifecycle state: $label"` covering assistant/legacy assistant, goal, team lead/member, staff, delegate, first-class child, archived, read-only, noninteractive, borrowed, streaming, compacting, starting, aborting, terminated, and already claimed states
- `it.each(...)` named `"rejects unsafe coordinates: $label"` covering missing/stale live-vs-durable `cwd`, `worktreePath`, `branch`, `repoPath`, incomplete/duplicate multi-repo entries, unavailable sandbox owner/container, and project mismatch
- `it("returns stable concise reason codes and never reads a caller-supplied coordinate")`

### `tests2/core/session-goal-promotion-managers.test.ts`

`describe("GoalManager adopted workspace")`

- `it("copies exact single-repo coordinates, provenance, and sandbox flag and starts ready")`
- `it("copies exact multi-repo coordinates without calling support, pool, git, setup, or goalProvisioned")`
- `it("leaves ordinary createGoal output and setup behavior unchanged when adoption is absent")`

`describe("TeamManager adopted existing lead")`

- `it("persists one empty reservation and maps the existing session as lead")`
- `it("returns the exact reservation on repeat and rejects a different goal or lead")`
- `it("blocks startTeam from spawning a second lead")`
- `it("releases only an unchanged attempt-owned empty reservation")`
- `it("reconciles provenance before orphan cleanup and restores exactly one reverse index")`

`describe("SessionManager promoteToGoalLead")`

- `it("keeps the Bobbit id, transcript, title, clients, event frame, queue, background owner, model tuple, cwd, and coordinates while loading goal/team tools")`
- `it("uses the prospective team-lead role and goal metadata at every candidate setup edge")`
- `it("reuses the exact sandbox container and never creates or transfers a sandbox worktree")`
- `it("restores every prior field and the old usable bridge for failures through a rejected old stop")`
- `it("treats canonical bridge installation as commit and repairs later failures idempotently")`
- `it("serializes concurrent retries and commits only one promoted bridge")`
- `it("restores the promoted association and tools from durable state after restart")`

`describe("promoted source lifecycle guards")`

- `it("blocks direct source archive, purge, and direct team teardown while the goal is live")`
- `it("archives goal first, then reservation and source, without treating provenance as checkout ownership")`
- `it("protects single and multi-repo paths while session, goal, or team still references them")`
- `it("allows final cleanup exactly once after every live reference is gone")`

### `tests2/integration/session-goal-promotion.test.ts`

`test.describe("current-session goal promotion API")`

- `test("promotes the proposal owner with the same id, transcript, branch, worktree, dirty index, unstaged and untracked files")`
- `test("creates normal workflow gates and enables goal, gate, task, and team tools on the original session")`
- `test("concurrent accepts and retries produce one goal, one lead, and no new worktree or session")`
- `test("faults after goal, gates, reservation, candidate start, switch, verification, tentative durable update, and rejected old stop compensate only attempt-owned state")`
- `test("a failure after canonical bridge installation keeps the committed relation and retry returns it")`
- `test("restart restores one provenance relation, lead reservation, original transcript, and runtime context")`
- `test("adopts exact multi-repo coordinates without changing git worktree list or component status")`
- `test("sandbox promotion retains the same container and worktree owner and makes zero create/remove calls")`
- `test("cleanup refuses every live endpoint and removes the adopted checkout only after ordered goal archive")`
- `test("absent and explicit new-worktree proposals retain the existing goal creation behavior")`

The first integration case snapshots before/after: session ID, transcript path and content hash, `git rev-parse HEAD`, branch, `git worktree list --porcelain`, staged diff, unstaged diff, untracked file list/content, worktree/repository coordinates, and session count. Every value except goal/team/runtime metadata must remain equal.

### Registered browser journey

Add `tests2/browser/journeys/session-goal-promotion.journey.spec.ts` to `tests2/tests-map.json` as `smoke-journey`.

`test.describe("Journey: Current-session goal promotion")`

1. `test("selects Current session, promotes the original lead, survives reload, and archives safely")`
   - create an eligible regular session and record its URL/session ID, transcript sentinel, branch, and worktree path;
   - open its goal proposal and assert **New worktree** is initially selected;
   - select **Current session** and assert the exact authoritative branch/path/component count are shown;
   - reload before acceptance and assert Current session remains selected;
   - accept and assert the goal shows the original session ID as lead, the transcript sentinel remains visible, and no second lead/session appears;
   - exercise visible workflow gate, task, and team controls from the promoted session;
   - reload the gateway/page and assert the same session remains the sole lead with the same transcript;
   - assert worktree cleanup is blocked while the live goal/session references it, archive through the goal UI, then assert ordered cleanup completes without a dangling goal/team row.
2. `test("shows the authoritative reason when Current session is unavailable")`
   - open a proposal owned by an ineligible regular-session fixture (missing/borrowed worktree);
   - assert Current session is disabled, its concise server reason is visible, no editable coordinate is rendered, and New worktree remains actionable.
3. `test("keeps New worktree goal creation unchanged")`
   - leave the default selected, accept, and assert a distinct goal branch/worktree and distinct team-lead session are created while the proposal owner is not attached as lead.

These are real-app journeys, not fixture-only rendering tests: they cover navigation, selection, acceptance, same-session continuity, reload/restart restoration, archive, and cleanup.

## Acceptance proof

A successful `current-session` acceptance has exactly one goal, one existing-lead reservation, and the original session. The goal and session expose identical pre-promotion branch/worktree/repository coordinates; Git status/content, HEAD, transcript, Bobbit ID, sandbox/container, and lifecycle ownership are unchanged. The refreshed runtime has canonical goal/team context and tools. Restart reconstructs the same graph. Cleanup cannot remove the checkout while the live source, goal, or team relation references it. An absent or `new-worktree` mode never enters this flow.
