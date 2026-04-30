# PR #387 closure annotation + stale-`mission` reference audit

This note records (a) the supersedes annotation prepended to PR #387 by task 7.4, and (b) the `rg -i 'mission'` audit of the nested-goals branch confirming no Mission-entity carry-over.

## Closure annotation applied to PR #387

The following block was prepended to the description of [PR #387](https://github.com/SuuBro/bobbit/pull/387) via `gh pr edit 387 --body-file …`:

> **Superseded:** This work was replaced by the nested-goals design on branch `goal/nested-goa-802c9dae`. The Mission entity has been removed; nested goals provide the same capability via workflow-as-DAG. See `docs/nested-goals.md` and `docs/design/nested-goals.md` for details.

The original PR body is preserved verbatim below the `---` separator. PR #387 stays in `OPEN` state — no merge, no close — exactly as the spec demands. If the user later wants to close it, they can do so manually with `gh pr close 387` once they've reviewed the supersedes note.

If `gh` is ever unavailable on a future replay of this task, paste the block above into PR #387's description by hand.

## Audit summary

Ran `rg -i 'mission' src/ docs/ defaults/ tests/` then filtered out the noise classes (`permission`, `submission`, `commission`, `admission`, `emission`, `transmission`, `omission`, `dismission`). After that filter, every remaining hit on this branch was classified as **intentional**, none as unintentional carry-over from PR #387. The branch did not cherry-pick from PR #387, which the absence of any `Mission`/`mission-*` entity references confirms — there is no `mission-store.ts`, no `mission-manager.ts`, no `mission-scheduler.ts`, no `defaults/workflows/mission.yaml`, no `defaults/roles/commander.yaml`, no `defaults/tools/mission/`, no `/mission/:id` route, and no `Missions` sidebar group anywhere in the tree. Concretely the surviving hits are: four lines in `docs/design/nested-goals.md` (the spec text describing this very supersedes work — lines 4, 2481, 2483, 2485, all referring to PR #387 by design); three prose uses of the word "mission" in `defaults/roles/assistant/staff.yaml` and the matching `src/server/agent/staff-assistant.ts` (the staff-agent assistant uses the English word "mission" colloquially in copy like "define its persona, mission, and triggers" — pre-existing, unrelated to PR #387, kept); one wake-prompt fallback string `"You have been woken. Review your memory and carry out your mission."` in `src/server/agent/staff-manager.ts:285` (pre-existing staff-agent copy, kept). Every other `rg` hit across `src/`, `docs/`, `defaults/`, and `tests/` is a substring inside `permission(s)`, `submission`, `transmission`, etc., not a Mission reference. **Verdict: no source files modified, no tests modified, no unintentional Mission-entity references survive on this branch.**

## Reproduction

```bash
rg -i 'mission' src/ docs/ defaults/ tests/ -n \
  | grep -iv -E 'permission|submission|commission|admission|emission|transmission|omission|dismission'
```

Expected output: 10 lines, all from `docs/design/nested-goals.md`, `defaults/roles/assistant/staff.yaml`, `src/server/agent/staff-assistant.ts`, and `src/server/agent/staff-manager.ts`. All intentional.
