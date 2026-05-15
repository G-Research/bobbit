# Goal-proposal spec rehydrate fix — design

## Root cause

In `connectToSession`'s **fast path** (`src/app/session-manager.ts` lines
~846-848), `state.previewSpec` is unconditionally cleared to `""`. Two
fire-and-forget repopulation operations then race:

1. `rehydrateProposalsForSession(sessionId)` at line 919
   (`session-manager.ts:2300`) — REST-fetches `/api/sessions/<sid>/proposals`
   and dispatches through `remote.onProposal` (the **unified** callback at
   line 1333). The unified callback sets `state.activeProposals.goal` and
   calls `renderApp()` — but it **never touches `state.previewSpec`**
   (form-mirror state is owned by the legacy per-type callbacks).
2. `restoreGoalDraft(sessionId)` at line 929 → `goalDraft.restore`
   (lines 264-309) — REST-fetches the draft and sets
   `state.previewSpec = draft.previewSpec ?? ""`. It does **not** call
   `renderApp()`. `createDraftManager.restore` (lines 222-228) likewise
   doesn't render.

The goal-assistant proposal panel renders `state.previewSpec` **directly**
(`renderGoalForm({ spec: state.previewSpec, ... })` in
`src/app/render.ts:1181`, inside `goalPreviewPanel()` at line 1045). The
non-assistant proposal panel uses the `_proposalSpec` module-mirror gated by
`syncProposalFormState` — a separate code path the E2E reproducer does not
exercise.

When `rehydrateProposalsForSession` resolves **before** `restoreGoalDraft`:
- `onProposal` fires → repopulates `state.activeProposals.goal` → calls
  `renderApp()` → panel reads `state.previewSpec === ""` → renders
  `_No spec content yet_` (`src/app/render.ts:1003`,
  `config.spec || "_No spec content yet_"`).
- `restoreGoalDraft` finishes later → sets `state.previewSpec` correctly →
  but no render is scheduled. The panel stays stuck on the empty render
  until a user input / unrelated event triggers another `renderApp()`.

The slow path (`connectToSession` from line ~948 onwards) does **not** hit
this bug because `await draftRestorePromise` is awaited and a `renderApp()`
runs in the outer `finally` (line 1882). Only the cached-panel fast-path
omits the render after the draft restore.

## Hypothesis verdict

- **A: partial — confirmed in spirit, refuted as literally written.** The
  fast-path no longer does an unconditional `delete state.activeProposals.goal`
  for the current session (lines 833-840 only drop slots belonging to
  *other* sessions, per the existing review comment "Drop proposal slots
  that belong to OTHER sessions only"). But the underlying ordering issue
  the hypothesis described is real: the fast-path mutates global mirror
  state synchronously (line 847: `state.previewSpec = ""`) and then relies
  on two fire-and-forget async repopulations (lines 919 + 929), one of
  which (`restoreGoalDraft`) silently mutates state without rendering.
  Evidence: `src/app/session-manager.ts:846-848` (sync clear) +
  `src/app/session-manager.ts:929-931` (fire-and-forget `.catch` only) +
  `src/app/session-manager.ts:222-228` (`createDraftManager.restore` has
  no render call) + `src/app/render.ts:1181` (panel reads
  `state.previewSpec` directly).
- **B: refuted.** `syncProposalFormState` / `_proposalInitializedFrom` /
  `_proposalSpec` govern only the **non-assistant** goal-proposal panel
  (the `goalProposalPanel` defined around `render.ts:2316`). The E2E
  reproducer creates a **goal-assistant** session (`+ New Goal` button),
  whose panel is rendered by `goalPreviewPanel()` at `render.ts:1045` and
  feeds `state.previewSpec` directly into `renderGoalForm`. The identity-
  key guard is not on this code path. Evidence: search for `_proposalSpec`
  in `render.ts` — only used in `renderGoalForm` config invoked from the
  non-assistant render at line 2433.
- **C: refuted** — already proven by `tests/proposal-rehydrate.test.ts`
  (server-side write→parse round-trip is byte-stable, and empty `spec`
  fails parse loudly).

## Fix plan

Single-file production change in **`src/app/session-manager.ts`**.

### Primary fix — render after draft restore

In `createDraftManager.restore` (lines 222-228), call `renderApp()` after a
successful `config.restore(...)`. This makes draft restores self-rendering
for **all** assistant types (goal/role/project) — symmetric with the slow
path's terminal `renderApp()` in the `finally` block.

Diff sketch:
```ts
async restore(sessionId: string): Promise<boolean> {
    try {
        const draft = await loadDraftFromServer(sessionId, config.type);
        if (!draft) return false;
        config.restore(sessionId, draft as T);
        renderApp();                  // ← NEW: pin the contract.
        return true;
    } catch (err) { ... }
},
```

Rationale: the slow path already renders implicitly at the end of
`connectToSession` (`session-manager.ts:1882`). The fast path doesn't —
because `restoreGoalDraft` / `restoreRoleDraft` are explicitly
fire-and-forget (line 929-933, see also the inline comment that the slow
path "runs these inside its draft-restore promise; the fast path skipped
them"). Putting `renderApp()` at the bottom of `createDraftManager.restore`
gives the fast path the same render guarantee without touching every call
site, and it matches the design intent stated by the comment at
`session-manager.ts:923-928` ("Restore goal/role/project assistant draft
state. The slow path runs these inside its draft-restore promise; the fast
path skipped them which left `state.previewSpec` … empty after
switch-away/back").

### Optional belt-and-braces (do not add unless implementer chooses)

In `rehydrateProposalsForSession` (lines 2300-2320), after calling the
unified `onProposal` for each proposal, also fire the legacy per-type
callback (`remote.onGoalProposal`, `remote.onRoleProposal`, etc.) so the
form-mirror state (`state.previewSpec` etc.) is repopulated from the
*proposal* — not just the draft. This guards against a missing/corrupted
draft while the on-disk proposal file is intact. Strictly additive; safe
to defer.

### Invariants the fix establishes

1. After any successful `loadDraftFromServer(...)` → `config.restore(...)`,
   a `renderApp()` is scheduled before the promise resolves.
2. The fast-path proposal/draft repopulation no longer depends on which of
   the two REST calls (`/proposals` vs `/draft`) lands first.

### Target footprint

- ≤ 1 production file (`src/app/session-manager.ts`).

## Test plan

### Client-side unit test (new file)

- **Filename**: `tests/proposal-rehydrate-client.test.ts`.
- **What it pins**: the `createDraftManager.restore` render contract —
  after a successful restore, `renderApp` must be invoked. Pinning at the
  `createDraftManager` layer (not at `connectToSession`) keeps the test
  isolated from the WS / REST plumbing and immune to fast-path refactors.
- **Shape (file:// fixture, no gateway)**:
  - Stub `loadDraftFromServer` (from `./api.js`) to return a fake goal
    draft `{ activeGoalProposal: { spec: "BODY", title: "T" }, previewSpec:
    "BODY", previewTitle: "T", ... }`.
  - Stub `renderApp` (`./render.js`) with a spy.
  - Drive `goalDraft.restore("sess-X")` (exported via a thin test-only
    accessor, or replicate the createDraftManager wiring inline against
    fresh state).
  - Assert: `state.previewSpec === "BODY"` AND `renderApp` was called at
    least once AFTER `state.previewSpec` was assigned.
  - Also pin the **race**: spy on `state.previewSpec` assignments, dispatch
    a synthetic `onProposal("goal", { spec: "BODY", ... }, false, 1)` call
    BEFORE the draft restore completes, then resolve the draft load.
    Assert the post-restore render sees `state.previewSpec === "BODY"` and
    the rendered call count is ≥ 2 (one from the simulated `onProposal`
    via the unified callback's terminal `renderApp`, one from the draft
    restore's new `renderApp`).
- **Why this prevents regression**: any future refactor that drops the
  trailing `renderApp()` inside `createDraftManager.restore`, or that
  reverts to silently mutating state in `goalDraft.restore`, will fail
  this pin. The pin lives at the layer where the contract is defined,
  not at the call site, so it survives reshuffles of `connectToSession`'s
  fast/slow paths.

### Un-quarantine

- In `tests/e2e/ui/proposal-spec-survives-navigate.spec.ts`:
  - Flip `test.fixme(` → `test(` (line ~95).
  - Remove the multi-line FIXME comment block (lines ~87-94) — the
    `docs/design/proposal-spec-rehydrate.md` reference is stale and the
    tracking doc itself is being deleted.
  - Keep the body of the test unchanged; it already polls the rendered
    `commentable-markdown.markdown` property until it matches the pre-nav
    spec body.

### E2E test plan (mandatory section)

The un-quarantined E2E `tests/e2e/ui/proposal-spec-survives-navigate.spec.ts`
exercises the full user journey end-to-end:

- **Navigation**: opens a goal-assistant session via the `+ New goal` button
  (`openGoalAssistantWithProposal`), drives a `propose_goal` tool-call,
  captures the active session id (`sidA`), creates a second session
  (`sidB`) via `createSession()` to navigate *away* to, then navigates
  back to `sidA` via `navigateToHash`. This is the exact sidebar-click
  flow the manual repro describes and the only path that exercises the
  cached-panel fast-path in `connectToSession` (slow path is not affected
  by the bug; the fast path is).
- **Happy path (pre-nav)**: the test asserts the proposal panel is visible
  and the spec body is non-empty before navigating away
  (`expect(originalSpec.length).toBeGreaterThan(20)`). This pins that the
  initial `propose_goal` → `onGoalProposal` → `state.previewSpec` =
  `proposal.spec` → render pipeline still works (no regression on the
  legacy callback path).
- **Persistence (post-nav, the bug)**: after navigating to `sidB` and back
  to `sidA`, the test polls the live
  `document.querySelector("commentable-markdown").markdown` property
  (which reflects `config.spec` from `renderGoalForm`, fed directly from
  `state.previewSpec` in `goalPreviewPanel`). It asserts byte-identity
  with the pre-nav `originalSpec` for up to 15 s
  (`.toPass({ timeout: 15_000 })`). On the fix branch this converges
  within one render tick after `restoreGoalDraft` completes, because
  `createDraftManager.restore` now schedules a render. On master HEAD it
  stays stuck on `"_No spec content yet_"` (or a truncated body) for the
  full 15 s and the test fails — which is exactly what the
  `test.fixme` quarantine is recording today.
- **Cleanup / dismissal**: the dismiss path
  (`handleDismiss` in `render.ts:2411`) is already covered by
  `tests/e2e/ui/goal-proposal-dismiss.spec.ts`, which verifies the panel
  closes and the in-memory annotations clear on dismiss. The fix does
  not change the dismiss code path, so that suite serves as the existing
  dismissal regression guard — no new dismiss-cleanup test is needed
  here.
- **Diff-on-edit (related coverage)**:
  `tests/e2e/ui/proposal-panel-subsection-diff.spec.ts` already pins the
  panel diff rendering across edits; running the fix branch through the
  full E2E suite confirms no regression on those proposal-panel render
  paths.

## Acceptance criteria

- [ ] Manual repro from the original
      `docs/design/proposal-spec-rehydrate.md` no longer reproduces.
- [ ] `tests/e2e/ui/proposal-spec-survives-navigate.spec.ts` is `test()`
      not `test.fixme()` and passes.
- [ ] New client-side unit test (`tests/proposal-rehydrate-client.test.ts`)
      pins the `createDraftManager.restore` render contract and passes.
- [ ] `docs/design/proposal-spec-rehydrate.md` deleted as part of the
      implementation task (not this design task).
- [ ] No regression in: `tests/proposal-files.test.ts`,
      `tests/proposal-helpers.test.ts`, `tests/proposal-registry.test.ts`,
      `tests/e2e/ui/goal-proposal-dismiss.spec.ts`,
      `tests/e2e/ui/proposal-panel-subsection-diff.spec.ts`,
      `tests/proposal-rehydrate.test.ts`, and the project-proposal
      counterparts.
- [ ] `npm run check`, `npm run test:unit`, `npm run test:e2e` all clean.

## Files that change (final list)

- `src/app/session-manager.ts` — 1 line added (`renderApp()`) inside
  `createDraftManager.restore` (lines ~222-228). Single production file
  touched.
- `tests/proposal-rehydrate-client.test.ts` — new client-side unit pin.
- `tests/e2e/ui/proposal-spec-survives-navigate.spec.ts` — un-quarantine
  (`test.fixme` → `test`, drop the stale FIXME comment block).
- `docs/design/proposal-spec-rehydrate.md` — delete.
- `docs/design/proposal-spec-rehydrate-fix.md` — delete (this doc, once
  the fix lands; tombstone semantics same as the predecessor).
