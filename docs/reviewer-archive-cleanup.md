# Reviewer Archive Cleanup

`llm-review` and `agent-qa` verification steps run as visible, non-interactive sessions so their transcript can be inspected and restart recovery can re-drive them. Those sessions are not standalone user chats: they are owned by the gate's goal and, when team mode is active, by the team lead that triggered verification.

This document defines how Bobbit keeps archived verifier sessions out of the top-level Archived → Sessions list without losing real review or QA transcripts.

## Session identity and ownership

Verifier-owned sessions are recognized by their generated IDs:

- `llm-review-*`
- `agent-qa-*`

The verification harness stamps reviewer metadata before agent startup by building a shared reviewer metadata payload and passing it into `SessionManager.createSession()`. That payload includes:

- `teamGoalId` — the owning goal, even though `goalId` may also be present for compatibility;
- `teamLeadSessionId` — the triggering team lead when known;
- `role` and reviewer accessory;
- `nonInteractive: true`.

Pre-startup stamping matters because setup can fail after the persisted session row is created but before the agent produces a transcript or receives a title. A failed-startup placeholder must already carry enough goal/team metadata to avoid becoming a generic archived session row.

After startup, the harness still sets the generated review title and rewrites the same metadata as a belt-and-suspenders update. It also registers the session in team state as a reviewer, not a worker, so restart resume can rebind it while worker-capacity and team-lead nudges ignore it.

## Legacy SessionStore backfill

Older persisted rows may have only `goalId`, a generic title such as `New session`, and no `teamGoalId` / `teamLeadSessionId`. `SessionStore` normalizes these rows when it loads `sessions.json`:

1. Only recognized verifier IDs are considered. Ordinary archived sessions with `goalId` remain unchanged.
2. If a verifier has `goalId` but no `teamGoalId`, the store sets `teamGoalId = goalId`.
3. If exactly one team-lead session can be inferred for that goal, the store fills `teamLeadSessionId`.
4. The store stamps `nonInteractive: true` and a default verifier accessory when missing.
5. Existing transcript paths, titles, archive timestamps, project IDs, and other metadata are preserved.

The backfill is intentionally conservative: it repairs ownership/display metadata only. It does not delete transcript-bearing rows or reinterpret unrelated user sessions.

## Archived sidebar bucketing

The sidebar uses an effective archived team-goal relationship for archived rows:

```text
effectiveArchivedTeamGoalId = session.teamGoalId
  ?? (is verifier session ? session.goalId : undefined)
```

That effective relationship drives both desktop and mobile archived render paths:

- goal-affiliated verifiers nest under their owning archived/live goal;
- when a matching team lead is available, they nest with that lead's members;
- verifier rows with only legacy `goalId` no longer qualify as project-level standalone archived sessions;
- normal standalone archived user sessions still render in the project Archived → Sessions bucket.

Search follows the same affiliation rule, so archived-goal matches can include legacy verifier titles/roles without promoting those verifier rows to standalone sessions.

## Placeholder vs transcript fallback

Bobbit treats empty failed-startup placeholders differently from real review output.

A verifier placeholder with no readable or recoverable transcript and only a generic title should not appear as a top-level archived session. If it has an owning goal, it is bucketed under that goal instead of the standalone list. If the owning goal is unavailable and the row has no useful content, the sidebar hides it.

A transcript-bearing verifier must remain reachable even when ownership inference is incomplete. Fallback visibility is:

1. Prefer nesting under the owning goal/team lead when `teamGoalId`, backfilled `goalId`, or an inferred lead makes that possible.
2. If the owning goal is renderable but no lead can be inferred, show it under the goal's archived/member bucket rather than the top-level sessions bucket.
3. If no owning goal is renderable but the row has a transcript path or meaningful title, keep it visible as a last-resort standalone archived session.
4. Hide only verifier rows that are both ownership-orphaned and content-empty.

This preserves access to real reviewer/QA transcripts while removing empty `New session` placeholders from the archived-session flood.

## Regression coverage

Relevant tests:

- `tests/reviewer-archive-metadata.test.ts` — verifier metadata is built before `createSession()`, and legacy `SessionStore` rows are backfilled.
- `tests/ui-fixtures/sidebar-archived-fixture.spec.ts` — legacy verifier rows stay out of standalone archive buckets, nest near live/archived team leads when possible, preserve transcript fallback visibility, and keep ordinary standalone sessions visible.
- `tests/ui-fixtures/sidebar-archived-fixture-entry.ts` — shared desktop/mobile fixture data for archived bucketing cases.

Focused checks while changing this area:

```bash
npx tsx --test tests/reviewer-archive-metadata.test.ts
npx playwright test tests/ui-fixtures/sidebar-archived-fixture.spec.ts
```

Run the broader checks required by the code touched: UI-only changes need `npm run test:unit`; server lifecycle changes need `npm run check` plus the relevant unit/E2E coverage.
