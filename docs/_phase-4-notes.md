# Phase 4 — Children tool group + REST endpoints

Working notes for **Phase 8 documentation**. Phase 4 lands the
agent-facing surface for nested-goal lifecycle: nine team-lead-only
`goal_*` tools plus the REST endpoints they call. The verification
harness's `runSubgoalStep` (Phase 3) talks to the same REST endpoints
internally for the spawn / merge primitives.

## REST endpoint table

All routes live in `src/server/server.ts::handleApiRoute()`. Auth: same
bearer-token contract as the rest of `/api/`. **Cascade-affecting routes
require an explicit `cascade` parameter — server returns 422 when the
client omits it (UI is the cascade-policy authority).**

| Method | Path | Body / query | Responses |
|---|---|---|---|
| POST | `/api/goals/:id/spawn-child` | `{ planId, title, spec, workflowId?, suggestedRole? }` | 201 `{ id }` (new), 200 `{ id, alreadyExists: true }` (idempotent), 400 (missing field / cycle), 404 (parent missing) |
| PATCH | `/api/goals/:id/plan` | `{ proposedSteps: ClassifierPlanStep[] }` | 200 `{ kind, applied: true }` (noop / fix-up under balanced/autonomous), 200 `{ kind, requestId, requiresApproval: true }` (queued), 409 `{ kind: "criteria-drop", uncoveredCriteria }`, 409 `{ kind: "restructure", code: "RESTRUCTURE_REQUIRES_PAUSE" }` |
| GET | `/api/goals/:id/plan?gateId=execution` | (query) | 200 `{ steps: PlanStep[], gateState, frozen, replanCount }` |
| POST | `/api/goals/:id/integrate-child/:childId` | `{}` | 200 `{ merged: true, alreadyMerged?, pushed? }`, 409 `{ conflict: true, output }`, 400 `{ code: "PARENT_MISMATCH" }` |
| POST | `/api/goals/:id/pause` | `{ cascade: boolean }` | 200 `{ paused: <count> }`, **422 `{ code: "CASCADE_REQUIRED" }`** |
| POST | `/api/goals/:id/resume` | `{ cascade: boolean }` | 200 `{ resumed: <count> }`, **422 `{ code: "CASCADE_REQUIRED" }`** |
| POST | `/api/goals/:id/mutation/:requestId/decision` | `{ decision: "approve" \| "reject" }` | 200 `{ applied, replanCount?, autoPaused? }`, 404 `{ code: "REQUEST_NOT_FOUND" }`, 400 (bad decision) |
| PATCH | `/api/goals/:id/policy` | `{ divergencePolicy?, maxConcurrentChildren? }` | 200 `{ ok: true }`, 400 (validation) |
| DELETE | `/api/goals/:id?cascade=true\|false` | (query) | 200 `{ ok: true, archived: <count> }`, **422 `{ code: "CASCADE_REQUIRED" }`**, 409 `{ code: "HAS_DESCENDANTS", count }` (when cascade=false and descendants exist) |

WS broadcasts emitted:

- `goal_created` (with `parentGoalId`) on spawn-child success.
- `goal_state_changed` on plan apply, pause/resume, mutation approve, integrate-child, cascade-archive (one per affected goal).
- `mutation_pending` when `PATCH /plan` queues a request.
- `mutation_decided` when a request resolves (approve or reject).

## Mutation decision matrix (binding)

From SUBGOALS-SPEC §3.6. The classifier (`src/server/agent/plan-mutation.ts`)
reports the **kind**; the REST handler (`PATCH /api/goals/:id/plan`)
applies the matrix.

| Kind | strict | balanced | autonomous |
|---|---|---|---|
| `noop` | applied | applied | applied |
| `fix-up` | requires approval | **applied** | **applied** |
| `expansion` | requires approval | requires approval | requires approval |
| `restructure` (paused goal) | requires approval | requires approval | requires approval |
| `restructure` (non-paused) | 409 `RESTRUCTURE_REQUIRES_PAUSE` | 409 | 409 |
| `criteria-drop` | 409 `CRITERIA_DROP` | 409 | 409 |

### Classifier severity order

`noop < fix-up < expansion < restructure`. The classifier reports the
**most severe** structural kind. After the structural pass, the
criteria-coverage check OVERRIDES the kind to `criteria-drop` if any
root acceptance criterion is uncovered. Coverage is
**whitespace-normalised, case-insensitive substring** match against the
union of `{rootSpec, every proposed step's spec}`. SUBGOALS-SPEC §3.6
mandates this comparison so the team-lead can paraphrase
capitalisation/whitespace without tripping the classifier — but
acceptance criteria MUST be quoted verbatim in subgoal specs (a
`## Covers` heading is the convention).

### Auto-pause guard

Every `applied` or approved mutation increments `replanCount`. When
`replanCount > 5`, the handler flips `paused: true` so a human is
forced to inspect the plan churn before more replans land. Resume via
`POST /api/goals/:id/resume`.

## Persistence

Pending mutation requests live in
`<stateDir>/plan-mutations/<goalId>.json` as JSON arrays of
`PendingMutation` records. One file per goal; cleaned up on
approve/reject and best-effort pruned by `pruneExpired()`. 24-hour TTL
(`DEFAULT_MUTATION_TTL_MS`). Survives restart — clients re-emit
`mutation_pending` events on WS attach via the same handshake the
proposal-drafts system uses (see `src/server/proposals/`).

## Tool group `Children` — wire-through

- `defaults/tools/children/{goal_*.yaml,extension.ts}` — nine YAML tool
  schemas + the extension that registers them. The extension reads
  `BOBBIT_TOKEN` / `BOBBIT_GATEWAY_URL` (or the dev-loop equivalents)
  and routes each tool through `fetch()` to the corresponding REST
  endpoint.
- `defaults/tool-group-policies.yaml` — `Children: ask` (default).
- `defaults/roles/team-lead.yaml` — declares `always-allow` for all nine
  tools.
- All nine contributor roles (`coder`, `test-engineer`, `reviewer`,
  `code-reviewer`, `security-reviewer`, `architect`, `spec-auditor`,
  `qa-tester`, `docs-writer`) declare `never` for all nine tools.

The invariant is enforced by `tests/role-children-tools-policy.test.ts`
(mirrors `role-gate-signal-policy.test.ts`). The tool-guard extension
(see `src/server/agent/tool-guard-extension.ts`) hard-blocks the call at
runtime so a contributor agent that tries `goal_spawn_child` gets an
explicit refusal — same pattern as `gate_signal: never` (Lesson 4.17).

## Suggested AGENTS.md additions for Phase 8

A single recipe entry in **Recipes**:

> - **Drive nested-goal lifecycle from the team-lead** → nine
>   team-lead-only tools in group `Children`: `goal_spawn_child`,
>   `goal_plan_propose`, `goal_plan_status`, `goal_merge_child`,
>   `goal_pause`, `goal_resume`, `goal_archive_child`,
>   `goal_decide_mutation`, `goal_set_policy`. Every cascade-affecting
>   call (`pause`, `resume`, `archive`) requires explicit
>   `cascade: boolean` — server returns 422 when omitted. UI is the
>   cascade-policy authority. See [docs/_phase-4-notes.md](docs/_phase-4-notes.md).

A debugging keyword index entry:

> - **`PATCH /api/goals/:id/plan` returns 409** — diagnostic order: (1)
>   confirm goal's `workflowId === "parent"`, (2) check the response
>   body's `code`. `CRITERIA_DROP` means an acceptance criterion is
>   missing from the union of `{rootSpec, proposed step specs}` —
>   inspect `uncoveredCriteria` and quote the criterion verbatim into
>   the relevant subgoal's spec. `RESTRUCTURE_REQUIRES_PAUSE` means a
>   step was removed (or an existing step's phase decreased) on a
>   non-paused goal — pause the goal first via
>   `POST /api/goals/:id/pause` `{ cascade }` and re-PATCH. (3) If
>   neither applies, this is a malformed `proposedSteps[]` payload (400
>   from the array validator).

## Concerns / handoff for Phase 5b (UI)

- The UI is the cascade-policy authority. The cancel-confirm dialog for
  `DELETE /api/goals/:id` should call `cascade=false` first and, on 409
  `HAS_DESCENDANTS`, show "This goal has N descendants. Cascade?" with
  buttons → `cascade=true` or cancel.
- The mutation-approval flow needs a chat-card entry on the
  `mutation_pending` WS event so the team-lead's session shows the
  diff (added/removed/modified plan-step ids) and the user can call
  `goal_decide_mutation` (or a `POST /mutation/:requestId/decision`
  REST call directly) without re-emitting the proposed steps.
- `GET /api/goals/:id/plan` is the single source of truth for the
  Plan tab's child-state projection. It implements the same tier
  preference (Lesson 4.19) the harness uses — `live-active >
  archived-complete > live-other > archived-other`.
- The auto-pause-on-replan>5 trip should surface as a banner with
  "Resume" / "View plan history" CTAs.

## Tests added

- `tests/plan-mutation.test.ts` (~12 cases — classifier matrix +
  criteria-coverage edge cases).
- `tests/plan-mutation-store.test.ts` (~7 cases — round-trip, prune,
  isolation, persistence).
- `tests/role-children-tools-policy.test.ts` (~90 cases —
  team-lead allow + 9 tools × 9 roles never).
- `tests/api-goals-spawn-child.test.ts` (~5 cases — idempotency,
  Lesson 4.1 stamping, distinct planIds).
- `tests/api-goals-cascade-archive.test.ts` (~5 cases — BFS
  descendants, deepest-first archive, isolation).
- `tests/api-goals-pause-resume.test.ts` (~6 cases — cascade=true/false,
  idempotent, contract).
- `tests/api-goals-plan-mutation.test.ts` (~9 cases — full decision
  matrix + auto-pause).
- `tests/api-goals-integrate-child.test.ts` (~4 cases — PARENT_MISMATCH,
  missing-branch, missing parent/child).

Net: ~140 new tests (suite was 1631; total 1772).
