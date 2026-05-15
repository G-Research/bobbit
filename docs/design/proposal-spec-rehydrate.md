# Goal-proposal spec body lost on navigate-away/back

Status: tracking. No owner — bug pre-dates [PR #599](https://github.com/SuuBro/bobbit/pull/599) (auto-retry).
Quarantines:
- E2E reproducer `tests/e2e/ui/proposal-spec-survives-navigate.spec.ts` (`test.fixme`).
- Server-side rehydrate parsing is pinned by `tests/proposal-rehydrate.test.ts`,
  so this bug is **client-side**.

## Why this doc exists

PR #599's only job is the auto-retry feature. The reproducer for this bug landed
on the same branch because the test was already written when the regression
surfaced, but the fix is out of scope. This note is the durable link the
`test.fixme` comment points to — when someone picks this up, start here.

## Symptom

1. Open a goal-assistant session; the agent streams a `propose_goal` and the
   goal-proposal panel renders the spec body.
2. Add an inline comment on the spec (or just observe the body — the comment
   isn't load-bearing for the bug, only for the user complaint).
3. Navigate away (sidebar click to another session, browser back, etc.).
4. Navigate back to the original session.
5. **Bug**: the panel is still visible, but the spec body renders as
   `_No spec content yet_` and "orphaned annotations" UI appears because the
   in-memory annotation cache survived but its anchored text didn't.

The reproducer in `tests/e2e/ui/proposal-spec-survives-navigate.spec.ts`
captures the pre-nav rendered markdown and asserts it equals the post-nav
rendered markdown. On master HEAD this fails every run.

## What's already verified

The **server-side** rehydrate path is locked by `tests/proposal-rehydrate.test.ts`.
That suite asserts:

- `writeProposalFile` → `parseProposalFile` round-trips the full goal-proposal
  shape (`title`, `cwd`, `workflow`, `options`, `spec`) byte-stably.
- The `spec` field survives a markdown body with headings, blockquotes, code
  fences, and tables.
- Idempotent write→parse→write byte-stability on bodies ending with `\n`.
- Empty / whitespace-only `spec` fails parsing with `MISSING_REQUIRED_FIELD`
  (i.e. the server never rehydrates a goal proposal with `spec=""` as a
  success).

So the `proposal_update {source:"rehydrate"}` event broadcast by
`src/server/ws/handler.ts` (lines ~340–360) carries the spec in
`fields.spec` correctly. The drop happens between receipt of that event on
the client and what `<commentable-markdown>.markdown` ends up bound to.

## Hypotheses (verbatim from the E2E spec comment)

A. **`connectToSession` fast-path delete-then-event.** On switch-back,
   `src/app/render.ts`'s `connectToSession` unconditionally does
   `delete state.activeProposals.goal`. The rehydrate `proposal_update`
   event then arrives but its fields don't include the spec — or arrive
   in a shape the reducer doesn't merge with the just-deleted slot.

B. **`syncProposalFormState` identity-key guard.** The form-mirror in
   `render.ts` (around the `_proposalInitializedFrom` key) keeps
   `_proposalSpec` stale at `""` because the identity key matches a
   degenerate empty key on re-entry, so re-initialisation is skipped.

C. **On-disk draft missing the spec.** The `propose_goal` tool extension
   wrote the draft without the spec, so the rehydrate brings back fields
   with `spec=""`. **Verified false** by `tests/proposal-rehydrate.test.ts`
   (empty spec fails parse, so the rehydrate event would not have been
   sent at all). Keep this hypothesis listed for diagnostic completeness
   — eliminating it cheap is half the point of the unit test.

## Diagnostic plan

For each hypothesis, the one-line probe a future investigator should run:

- **A** — log `state.activeProposals.goal` immediately before and after
  the `delete` in `connectToSession`, then log the next received
  `proposal_update` event payload. Look for: slot deleted; rehydrate event
  arrives with `fields.spec` non-empty; reducer fails to repopulate.
- **B** — log `_proposalSpec` + `_proposalInitializedFrom` on every entry
  to `syncProposalFormState`. Look for: rehydrate event raised the event-
  bus, `_proposalSpec` got the new spec briefly, then was overwritten
  back to `""` because the identity key matched.
- **C** — `stat` the `<stateDir>/proposal-drafts/<sid>/goal.md` file at
  the moment of nav-away and dump its contents. Should always show the
  spec body intact; if it doesn't, server-side write path is broken (but
  the unit suite says it isn't).

Hypothesis A is the working theory — the fast-path delete-then-event was
introduced for a different bug (avoid stale proposal slot when switching
between sessions of different shapes) and is the only place where the
order of operations changed recently.

## Closing the loop

When the bug is fixed:

1. Remove `test.fixme(` → `test(` in
   `tests/e2e/ui/proposal-spec-survives-navigate.spec.ts`.
2. Delete this design note.
3. Update the reducer test in `tests/proposal-rehydrate.test.ts` only if
   the fix lives on the server side (it almost certainly won't).

## Cross-references

- `src/server/ws/handler.ts` — rehydrate broadcast site.
- `src/server/proposals/proposal-files.ts` — `parseProposalFile`.
- `src/server/proposals/proposal-types.ts::goalPlugin` — `spec` body
  serialisation contract.
- `src/app/render.ts` — `connectToSession`, `syncProposalFormState`,
  `_proposalSpec` form mirror.
- `docs/design/editable-proposals.md` — overall proposal lifecycle.
- `docs/design/proposal-revision-snapshots.md` — adjacent on-disk layout.
