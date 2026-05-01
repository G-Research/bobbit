# Nested Goals — Cleanup Review

Cleanup audit for the goal branch implementing nested goals (workflow-as-DAG with `subgoal` verify steps, `parent.yaml` workflow, custom inline workflows/roles, mutation classifier, `Children` tool group, Plan/Children tabs).

**This is a report, not a patch.** No code or doc was deleted/refactored as part of this audit. Every finding is a candidate for a *follow-up* tidy-up goal.

## Summary

- LoC delta: ~21K insertions across 357 files vs `master`.
- Audited: 6 new server modules, 12 modified server modules, 7 new tool YAMLs + extension, 2 docs, ~30 test files, ~6 modified client modules, 1 stylesheet.
- Findings: **15** (Critical: 0, Major: 4, Minor: 8, Note: 3).
- Phase 1 consistency sweep: **no edits applied** — `Children: allow` in `defaults/roles/team-lead.yaml` is consistent with the established TitleCase-group convention already in `defaults/roles/general.yaml` (`Gates: ask`, `Tasks: ask`). Adding a clarifying comment only to `team-lead.yaml` would itself be inconsistent.

## Findings

### [Major] `resolveWorkflowForGoal` has zero production callers
**Files**: `src/server/agent/workflow-resolution.ts` (~85 lines), `tests/workflow-resolution.test.ts` (174 lines)
**Category**: dead-code / over-engineering

The walk-up resolver for inline workflow overrides is imported only by its unit test. All other workflow lookups in production go through `goalStore.get(...).workflow` (the snapshotted goal workflow) or `cascade.resolveWorkflows(projectId)`. The design doc §7.1 prescribes this resolver, but the goal-creation path snapshots `inlineWorkflow` directly onto the new goal's `workflow` field, so the recursive walk is currently dead.

**Suggested action**: Either (a) wire the resolver into a real call site (e.g. when a child goal is spawned without an inline override, walk ancestors before falling back to project cascade), or (b) delete `workflow-resolution.ts` + its test until needed and keep only `role-resolution.ts` (which IS used).

---

### [Major] Doc duplication between `docs/nested-goals.md` and `docs/design/nested-goals.md`
**Files**: `docs/nested-goals.md` (850 lines), `docs/design/nested-goals.md` (3195 lines)
**Category**: doc-duplication

The user-facing doc duplicates substantial chunks of the design doc: data model (§2 user vs §1 design), branching topology (§3 vs §3), subgoal verify steps (§4 vs §2), the `parent` workflow (§5 vs §6), mutation classification (§6 vs §4), custom workflows + roles (§7 vs §7), recovery scenarios (§8 vs §13). Section numbering even mirrors. A reader doesn't know which is authoritative.

**Suggested action**: Demote `docs/design/nested-goals.md` to a **historical design doc** (add an "as-shipped vs as-designed" header + freeze further edits). Make `docs/nested-goals.md` the live reference. Move §12 "Per-phase task breakdown" (~610 lines of phase-by-phase task lists) out — it belongs in the goal spec / PR description, not in living docs.

---

### [Major] §12 "Per-phase task breakdown" in `docs/design/nested-goals.md`
**Files**: `docs/design/nested-goals.md:1918-2528` (~610 lines)
**Category**: doc-duplication / boilerplate

The phase-by-phase task list is a pre-implementation planning artifact. Now that the feature has shipped, it adds noise to the design doc — every reader has to scroll past 7 phases of `### Phase X — title` and bullet lists describing tasks that were either done, dropped, or merged.

**Suggested action**: Excise §12 wholesale; if anyone needs it, the goal-spec has it. Keep only §13 (Risks & open questions — has shipping value).

---

### [Major] `tests/sidebar-hierarchy.spec.ts` (399 lines) overlaps with `tests/sidebar-nesting.spec.ts` (316 lines)
**Files**: `tests/sidebar-hierarchy.spec.ts`, `tests/sidebar-nesting.spec.ts`
**Category**: test-redundancy

Both target the recursive-children rendering path; the names are near-synonyms. Without reading the bodies in detail, the file-size + topic overlap is the kind of thing a tidy-up goal should pull apart: keep one (probably `sidebar-nesting.spec.ts` — the newer, narrower one) and merge any unique cases from the other.

**Suggested action**: Diff the two; consolidate any non-overlapping assertions into `sidebar-nesting.spec.ts`; delete `sidebar-hierarchy.spec.ts`.

---

### [Minor] `src/server/agent/acceptance-criteria.ts` is a 10-line re-export shim
**Files**: `src/server/agent/acceptance-criteria.ts`, `src/shared/acceptance-criteria.ts`
**Category**: single-caller / boilerplate

The shim has exactly one production importer (`goal-manager.ts`) and one test importer (`tests/acceptance-criteria.test.ts`). The original motivation in the doc comment ("so existing server-side import paths continue to work") is moot because the import path was new in this branch — there are no legacy callers to preserve.

**Suggested action**: Delete the shim. Update `goal-manager.ts` to `import { parseAcceptanceCriteria } from "../../shared/acceptance-criteria.js";` and the test to import from `src/shared/`.

---

### [Minor] `goal-manager.ts::listBufferedMutationIds` is documented as "Test/diagnostic helper. Not used by production code paths."
**Files**: `src/server/agent/goal-manager.ts:931-938`
**Category**: dead-code

The author marked it explicitly. The map is private; if a test wants to inspect it, it can do so via `getBufferedMutation` or by exposing the map under a `_test_` prefix when needed.

**Suggested action**: Delete `listBufferedMutationIds`. If any test depends on it, switch to `getBufferedMutation(requestId)` for assertion.

---

### [Minor] `applyBufferedMutation` returns `{}` for `child-spawn` — half-implemented stub left from Phase 4
**Files**: `src/server/agent/goal-manager.ts:980-994` and the ~15 lines of comment explaining "5.2 will fill this in"
**Category**: over-engineering / dead-code

Comments tell us "Phase 5.2 will perform the spawn here". Phase 5 has shipped. The branch returns an empty object and relies on the REST decision endpoint to do the spawn elsewhere. Either the spawn was wired in via a different path (likely — check `server.ts:5965`) and this branch is dead, or it is genuinely stubbed and should be removed since the spawn happens via `goal_spawn_child` directly.

**Suggested action**: Walk the runtime: if `applyBufferedMutation` is never called with a `child-spawn` payload at runtime, narrow `BufferedMutation` to `plan-replace` only and delete the dead branch + the speculative comments. Otherwise wire it.

---

### [Minor] `plan-mutation.ts::classifyMutation`'s `noop` class is structurally clean but never user-visible
**Files**: `src/server/agent/plan-mutation.ts:23-29`, `:235-242`
**Category**: over-engineering

`noop` is one of five `MutationClass` values, but the only production caller (`goal-manager.ts::classifyAndProposeReplace`) returns 200 immediately when there are no changes. The `noop` value never surfaces to the dashboard banner or the 409 body. Internally it's a clean precondition; externally it's noise in the type.

**Suggested action**: Keep — the cost is one enum member and a switch arm. Note only.

---

### [Minor] `Semaphore` class — 30 LoC for one feature, but it has 87 LoC of tests
**Files**: `src/server/agent/semaphore.ts`, `tests/semaphore.test.ts`
**Category**: over-engineering / test-redundancy

The class is fine. The test file is 3× the implementation and includes basic sanity checks (acquire/release reciprocity, over-release error) that read like they were written defensively for a primitive that has only one consumer. Verification-harness exercises the semaphore through the real subgoal-step path; a couple of focused tests would suffice.

**Suggested action**: Trim `tests/semaphore.test.ts` to ~30 LoC covering: acquire-blocks-on-zero, release-wakes-waiter, over-release-throws, capacity-readback. Skip — note only — unless cleanup goal explicitly asks.

---

### [Minor] `dialog-helpers.ts` — 4 helpers, one of which (`multiPhaseBannerDismissedKey`) is exported for tests only
**Files**: `src/app/dialog-helpers.ts:38-40`
**Category**: single-caller

`multiPhaseBannerDismissedKey` is an internal key-formatter used only by the two siblings (`isMultiPhaseBannerDismissed`, `dismissMultiPhaseBanner`) within the same file. Exporting it widens the surface for no reason.

**Suggested action**: Remove the `export` keyword. Trivial.

---

### [Minor] `parent.yaml` workflow lives inline in TS, not as a YAML file alongside the others
**Files**: `src/server/state-migration/seed-default-workflows.ts:393-491`
**Category**: boilerplate / consistency

`feature.yaml`, `bug-fix.yaml`, `general.yaml`, `quick-fix.yaml`, `test-fast.yaml` were all in `defaults/workflows/*.yaml` until this branch deleted them and inlined them into `seed-default-workflows.ts`. The `parent` workflow follows that pattern. Note: the design doc § references "`parent.yaml`" repeatedly, which is now misleading — there is no such file.

**Suggested action**: Either restore the YAML form for all workflows (revert the move) or update the design/user docs to say "the `parent` workflow (seeded inline by `seed-default-workflows.ts`)" — the latter is one-line edits.

---

### [Minor] Children tool YAMLs duplicate boilerplate across 6 files
**Files**: `defaults/tools/children/{goal_*}.yaml`
**Category**: boilerplate

Each yaml repeats `provider: { type: bobbit-extension, extension: extension.ts }` and `group: Children`. This matches the pattern in `defaults/tools/tasks/`, so it's consistent — but if a future tidy-up adds inheritance / templating, this is the cluster to target.

**Suggested action**: Note only. Don't fix piecemeal.

---

### [Minor] Children `extension.ts` has both `requestJson` AND three thin wrappers (`getJson`, `postJson`, `patchJson`)
**Files**: `defaults/tools/children/extension.ts:51-71`
**Category**: over-engineering

`getJson`/`postJson`/`patchJson` each do `return requestJson("METHOD", urlPath, body);` — one-line passthroughs. The local `requestJson(method, urlPath, body)` is already the minimal API.

**Suggested action**: Inline calls — `await postJson(x)` becomes `await requestJson("POST", x)`. Or keep — three trivial wrappers vs one parameterised call is a wash.

---

### [Note] Three `nesting`/`tabs` test files cover overlapping dashboard surface
**Files**: `tests/goal-dashboard-tabs.spec.ts`, `tests/plan-tab-render.spec.ts`, `tests/plan-tab-approve-button.spec.ts`, `tests/children-tab-render.spec.ts`, `tests/goal-dashboard-breadcrumb.spec.ts` (~863 LoC total)
**Category**: test-redundancy (potential)

The split-by-feature is reasonable, but each file boots the same Lit fixture and re-renders the dashboard. Worth checking whether a single `goal-dashboard.spec.ts` with describe-blocks would reduce per-test setup cost. **Not a clear violation** — Playwright file-fixtures intentionally split by surface for test isolation.

**Suggested action**: Note only — leave alone unless test runtime becomes a problem.

---

### [Note] `verification-harness.ts::resolveRoleForGoal` (private method) wraps `resolveRoleForGoalImpl` with three fallback layers
**Files**: `src/server/agent/verification-harness.ts:1080-1100`
**Category**: over-engineering (perceived)

Three fallback layers (PCM-aware → cascade-only → no-context server-level) mirror the design doc spec but are very defensive. Real failure modes for "no PCM" are vanishingly rare in production. Hard to prove dead without coverage data, so leaving as-is.

**Suggested action**: Note only.

---

### [Note] `inlineRoles?: Record<string, Role>` snapshotted on goals
**Files**: `src/server/agent/goal-store.ts:113-119`
**Category**: forward-compat

The data model field exists, the resolver exists, and the test exists. UI surface for **authoring** inline roles in the New Goal dialog is partial (the dialog has a textarea but no validator on par with `inline-workflow-validation.spec.ts`). Either the v1 plan was always to ship the data path before the editor, or the editor is incomplete.

**Suggested action**: Note only — confirm against the goal spec acceptance criteria; out-of-scope for cleanup.

---

## Bottom line

~21K LoC for a feature spanning data model + verification harness + 6 tools + new workflow + Plan/Children/breadcrumb UI tabs + classifier + recursive sidebar + extensive prompt-stanza work + thorough tests is **plausible**, especially given the 7-phase delivery model and the explicit acceptance-criteria-adherence requirement.

The clearest waste is **doc duplication** (Major 2 + 3 — ~600 lines of phase-task breakdown plus broad design/user-doc overlap) and the **`workflow-resolution.ts` module with no production callers** (Major 1). After those, what remains is mostly minor — a re-export shim, a documented diagnostic helper, a half-stubbed switch arm, and over-tested primitives.

**Recommended follow-up**: a small "nested-goals tidy-up" goal that (a) deletes `workflow-resolution.ts` or wires it in, (b) freezes/trims `docs/design/nested-goals.md`, (c) deletes the `acceptance-criteria.ts` shim and the `listBufferedMutationIds` helper, (d) consolidates the two sidebar test files. Estimated ~700 LoC reduction, no behaviour change.
