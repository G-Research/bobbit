# Mission Control — Implementation Plan (hand-off)

Status: ready for execution, not started. Workstream **MC** in
[fable-program-execution-plan.md](fable-program-execution-plan.md).

Companion to [mission-control.md](mission-control.md) (the WHAT/WHY — read its §1–§8 and
**Appendix A contracts** before implementing anything). This document is the HOW: goals
written so an implementer agent that has not seen any other goal can execute its goal from
this text plus the cited contracts alone.

> **Anchor baseline:** fable-docs @ 2026-06-11 (master parent `6ec8c8f9`). Line numbers WILL
> drift — locate by **symbol name**; if a named symbol does not exist where described, STOP
> and re-derive from the cited pattern file; do not improvise a parallel mechanism.
>
> **Precision policy:** MC-P0…P3 are specified to file/function level. MC-P4/P5 are
> contract level (their substrate is created by P0–P3); re-verify every anchor first.
>
> **Universal rules:** [extension-platform-implementation-plan.md §0](extension-platform-implementation-plan.md)
> (definition of done, patterns library) + [fable-program-execution-plan.md §1](fable-program-execution-plan.md)
> (doc-is-the-spec deviation protocol, shared-seam serialization) bind every goal below.

---

## Goal map

```
MC-P0 global scope ──→ MC-P1 sessions+sidebar ──┬─→ MC-P2a registry ─→ MC-P2b tool group
                                                └─→ MC-P3 flight recorder
MC-P2b + MC-P3 + GA-R2 ──→ MC-P4a pack ─→ MC-P4b crew ──→ MC-P5 briefing/onboarding/budgets
```

---

## MC-P0 — Global scope legitimization

**Outcome:** `projectId: "system"` + `global: true` is a valid, first-class home for staff;
zero orphan-banner noise; nothing user-visible yet.

**Owned files:** `src/server/agent/project-registry.ts`, `staff-store.ts`,
`staff-manager.ts`, `server.ts` (orphaned-staff route only), `docs/staff-agents.md`;
NEW `tests/global-staff-scope.test.ts`.

**Steps**

1. `project-registry.ts`: next to `SYSTEM_PROJECT_ID` (top of file), add
   `export function isSystemScope(id: string): boolean` and
   `export function missionControlDir(): string` per mission-control.md Appendix A.1
   (`path.join(stateDir, "mission-control")`, `mkdirSync` recursive, lazily). Do NOT touch
   `participatesInVisibleOrder()` — the system project stays out of the visible order;
   add a one-line pinning test for that instead.
2. `staff-store.ts`: extend `interface PersistedStaff` (symbol at `:60`) with
   `global?: boolean`; in the store's load path (inside `class StaffStore`, the same
   normalisation pass that runs `normalizeStaffAccessory`), normalise missing/non-boolean
   `global` → `false`. Persist round-trip unchanged otherwise.
3. `staff-manager.ts`: in the create/edit validation that currently resolves a real project
   (the path documented in `docs/staff-agents.md` §"Project and cwd anchoring"), add the
   explicit branch from Appendix A.2: `global === true` ⇒ require
   `projectId === SYSTEM_PROJECT_ID`, cwd inside `missionControlDir()` (default to it when
   blank), force worktree off (ignore `worktree` flag; never set `branch`/`worktreePath`),
   leave `sandboxed` semantics untouched. `global === false` ⇒ existing rules byte-for-byte.
4. Orphan route: in `server.ts`, locate the `GET /api/staff/orphaned` handler; exclude
   records with `global === true`. Legacy records (no `projectId`, or system-project
   without `global`) remain orphans — **no migration**.
5. Update `docs/staff-agents.md` §"Legacy staff records" with one paragraph distinguishing
   intentionally-global staff (and a pointer to mission-control.md).

**Tests (author first; RED on unmodified tree where marked)**

- `tests/global-staff-scope.test.ts` (node:test, store + manager level — follow
  `tests/staff-orphan-reassign.test.ts` for fixtures):
  (a) load normalisation `global` missing → `false`;
  (b) create global staff with blank cwd → cwd = missionControlDir() *(RED)*;
  (c) global staff with cwd outside missionControlDir → rejected *(RED)*;
  (d) global + real projectId → rejected *(RED)*;
  (e) worktree flag ignored for global staff *(RED)*;
  (f) orphan listing excludes `global: true`, still includes legacy orphan *(RED)*;
  (g) pinning: system project never appears in visible order (GREEN today — pins step 1).

**Acceptance:** all new tests green; full staff suites
(`tests/staff-*.test.ts`, `tests/e2e/staff*.spec.ts`) green unmodified.

---

## MC-P1 — Mission Control sessions + sidebar entry

**Outcome:** a pinned Mission Control entry at the very top of the sidebar (desktop +
mobile); the user can create/use/archive a global chat session that survives reload and
gateway restart.

**Owned files:** session-create path (`server.ts` + `src/server/agent/session-setup.ts` —
**confine to the project-resolution branch**; this file is a §1.4 shared seam),
`src/app/sidebar.ts`, `src/app/render.ts` (mobile shell), `src/app/state.ts` (nav id only);
NEW `tests/e2e/ui/mission-control.spec.ts`.

**Steps**

1. Server: allow session creation with `projectId: "system"`. Find where session creation
   resolves the project (the same resolution the projectless path in
   `tests/e2e/sessions-projectless.spec.ts` pins — read that spec first); when
   `isSystemScope(projectId)`, set cwd = `missionControlDir()`, skip worktree/git setup
   entirely (same code path as non-git projects), and tag the session record so the client
   can group it (reuse the existing `projectId` field — no new field).
2. Sidebar: in `renderSidebar()` (`src/app/sidebar.ts`, symbol `renderSidebar`), render a
   Mission Control block **before** the project loop: header row (nav id
   `mission-control-header`), expandable; lists sessions with
   `projectId === SYSTEM_PROJECT_ID` and staff with `global === true` (staff sub-grouped
   System/Global by a `roleId`-independent flag — for now: pack-roster names, see MC-P4;
   until then one flat Staff group). Add "+ New chat" button posting a system-scope
   session. Reuse `renderStaffSidebarSection(filteredList, projectId)` with the system
   scope rather than forking it.
3. Mobile: mirror in `render.ts::renderSidebarShellMobile` (same data, existing mobile
   row components).
4. Exclusions: Mission Control does not participate in project reorder
   (`renderProjectReorderHandle` must not render for it) and is not draggable; keyboard
   nav follows `docs/sidebar-keyboard-navigation.md` (its nav id participates in the
   ordered nav list).

**Tests (author first)**

- `tests/e2e/ui/mission-control.spec.ts` (browser E2E, pattern
  `tests/e2e/ui/settings.spec.ts`): entry visible at top (strictly above first project);
  create chat → session opens; reload → entry + session persist; archive session →
  disappears; keyboard navigation reaches the header. *(all RED)*
- Extend `tests/e2e/sessions-projectless.spec.ts` with one system-scope creation case
  asserting cwd = missionControlDir and no worktree. *(RED)*

**Acceptance:** E2E green incl. restart-persistence (sessions.json round-trip — assert via
reload case); existing sidebar suites (`tests/e2e/ui/side-panel-tabs.spec.ts`,
project-reorder specs) green unmodified.

---

## MC-P2a — `bobbit` meta-tool registry (server only)

**Outcome:** the operation registry exists, is pinned by tests, and dispatches in-process —
no tool exposed to any model yet.

**Owned files:** NEW `src/server/agent/bobbit-meta-tool.ts`; NEW
`tests/bobbit-meta-tool.test.ts`.

**Steps**

1. Implement `BobbitOp`/`OpTier` and the **complete catalog v1 table** from
   mission-control.md Appendix A.3 — every row, no additions, no omissions. For each row,
   resolve the cited REST route to its `server.ts` handler **by reading
   `docs/rest-api.md` + the handler source now**; record the resolved path template in the
   registry entry.
2. `export async function dispatchBobbitOp(op, args, ctx)`: validates `args` against the
   row's `argsSchema`, then invokes the same internal handler function REST uses (extract a
   shared function where the route body is inline — smallest possible extraction, no
   behavior change). `sensitive` rows: return a structured `requiresConfirmation` marker —
   the ask-flow wiring is MC-P2b's job. `mutate`/`sensitive`: call `recordActivity()` —
   until MC-P3 lands, a no-op stub exported from the same module (one TODO referencing
   MC-P3).
3. `export function describeBobbitOp(op?)` returning `{op, tier, doc, argsSchema}` rows.

**Tests (author first)**

- `tests/bobbit-meta-tool.test.ts`: (a) **catalog pinning** — every registry row resolves
  to a callable handler (no 404-shaped dispatch), and the exported op enum equals the
  registry keys exactly *(RED)*; (b) schema validation rejects malformed args per op
  *(RED)*; (c) `sensitive` ops return the confirmation marker, never execute directly
  *(RED)*; (d) read ops do not invoke `recordActivity`, mutate ops do (spy on the stub)
  *(RED)*.

**Acceptance:** new tests green; `npm run check` clean; zero diff outside owned files
except minimal handler extractions.

## MC-P2b — `bobbit` tool group + tiers + policy

**Outcome:** Mission Control sessions/staff can call `bobbit`/`bobbit_describe`
end-to-end with ask-gating on sensitive ops.

**Owned files:** NEW `defaults/tools/bobbit/{bobbit.yaml,bobbit_describe.yaml,extension.ts}`;
tool-policy default for system scope (locate where role/tool policies resolve per scope —
`docs/staff-agents.md` §roleId notes `session-setup.ts` applies them); extend
`tests/tool-description-budget.test.ts`; NEW `tests/e2e/bobbit-meta-tool.spec.ts`.

**Steps**

1. Copy `defaults/tools/team/` anatomy exactly (YAML fields: `name`, `description`,
   `summary`, `params`, `provider: {type: bobbit-extension, extension: extension.ts}`,
   `group: Bobbit`, `docs`, `detail_docs`). `extension.ts` bridges to the gateway via the
   `tool-guard-extension.ts` HTTP long-poll pattern (§0.1 patterns library) and calls
   `dispatchBobbitOp`.
2. Sensitive ops: wire the `requiresConfirmation` marker into the existing blocking-ask
   flow (`docs/blocking-tools.md` / `docs/non-blocking-ask.md` — find the tool that
   currently blocks on user confirmation and copy its server round-trip).
3. Default availability: system-scope sessions/staff get the group enabled; project
   sessions get it only via explicit role tool-policy opt-in. Pin both directions.

**Tests:** budget rows for both YAML descriptions; API E2E (`tests/e2e/`, in-process
gateway): a system-scope session calls `projects.list`, creates a temp project
(`projects.add` behind a scripted confirm), creates a nested goal in it, sends a message to
a second session, enqueues a staff inbox entry; asserts a project session WITHOUT opt-in
gets a tool-not-available error. *(all RED)*

**Acceptance:** E2E green; `tool-description-budget` green; tool-guard/policy suites green
unmodified.

---

## MC-P3 — Flight recorder

**Outcome:** `recordActivity()` is real; `GET /api/activity` + WS live tail + Activity
panel under the Mission Control sidebar entry.

**Owned files:** NEW `src/server/agent/activity-store.ts`; `server.ts` (one GET route + WS
subscribe handling in `src/server/ws/`); NEW `src/app/activity-panel.ts`; `sidebar.ts`
(Activity nav row); NEW `tests/activity-store.test.ts`, `tests/e2e/ui/activity-panel.spec.ts`.

**Steps**

1. Implement `ActivityEntry` + `recordActivity()` exactly per mission-control.md Appendix
   A.4 (JSONL append, crash-safe pattern from
   [session-store-crash-safety.md](session-store-crash-safety.md); rotate at 8 MB to
   `activity-YYYY-MM-DD.jsonl`). Replace the MC-P2a stub (delete the TODO).
2. REST: `GET /api/activity` with `since/actor/tier/projectId/limit` filters (default 100,
   max 500, newest-first).
3. WS: `subscribe_activity` opt-in frame; fan out `activity_entry` ONLY to subscribed
   sockets (goal-fanout precedent —
   [reduce-server-cpu-experiment-goal-fanout.md](reduce-server-cpu-experiment-goal-fanout.md)).
4. UI: Activity nav row in the Mission Control block → panel listing entries (actor chip,
   action, target link, evidence link, revert button only when `revert` present —
   revert wiring itself lands with AI-P5; render disabled with tooltip until then), filter
   controls, live-tail via the subscription.

**Tests:** unit — rotation boundary, filter math, crash-safe append (kill mid-write
fixture); browser E2E — meta-tool mutate call appears in panel without reload (live tail),
filters narrow, read ops absent. *(RED)*

**Acceptance:** every `mutate`/`sensitive` call from MC-P2b's E2E visible with correct
actor attribution; WS fanout test proves non-subscribed sockets receive nothing.

---

## MC-P4a/P4b — mission-control pack + crew *(contract level — re-verify anchors)*

Contracts: mission-control.md §5 (roster + trigger table + disabled-by-default rule),
Appendix A.5 (pack layout), A.6 (owned files). Depends on GA-R2's push triggers (shared
seam — if GA-R2 hasn't landed, land the triggers there first, never here).

- **P4a:** pack skeleton copying `market-packs/pr-walkthrough/` (build wiring:
  `scripts/build-market-packs.mjs` + `copy-builtin-packs.mjs` `FIRST_PARTY_PACKS`); roles
  written in the standing-orders format (GA-R3); panel route `#/ext/mission-control`.
  Litmus tests per the `market-packs/artifacts` convention.
- **P4b:** idempotent `POST /api/mission-control/crew` instantiating staff records from
  `staff-templates/crew.yaml` (idempotency key: staff name + global flag); Observer
  triggers enabled, others disabled (§5); panel "Create crew" button. E2E: create crew ⇒
  4 global staff with correct triggers; re-POST ⇒ no duplicates; Caretaker manual wake
  dry-run sweep ⇒ flight-recorder entry; panel deep-link survives reload.

**Acceptance:** pack installs/uninstalls cleanly; crew E2E green; activity panel shows the
dry-run entry.

## MC-P5 — Briefing, onboarding, budgets *(contract level; 3 separable PRs)*

Contracts: mission-control.md §7. (1) Observer briefing = inbox digest assembled from:
flight recorder window, cost routes (`docs/session-cost.md`), notification-policy stuck
predicate, AI calibration endpoint when present (omit section when absent). (2) First-run:
zero registered projects ⇒ client routes to a Mission Control chat seeded with the
onboarding prompt (drives the existing add-project proposal flow — do not build a new
wizard). (3) Budgets: `budgets.{project,staff}.monthlyUsd` config keys; Observer breach
escalation entry + briefing line. Browser E2E per feature (first-run on a fresh state dir;
briefing digest renders; budget breach escalates).

**Acceptance:** mission-control.md §1's small-business-owner sentence works on a clean
install: project created + Friday `schedule` trigger attached via chat alone.
