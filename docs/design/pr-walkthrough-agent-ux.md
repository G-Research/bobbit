# Session-hosted PR walkthrough agent UX

> **⚠️ SUPERSEDED — launch + lifecycle model.** Two parts below no longer reflect
> the shipped system:
> 1. Auto-fullscreen-on-ready was **removed** — the walkthrough panel shares the HTML
>    preview panel's resize logic and fullscreen is user-initiated (see
>    [walkthrough-panel-resize-fix.md](walkthrough-panel-resize-fix.md)).
> 2. The launch flow (a `/walkthrough-pr` command / side-panel tab in the launching
>    session, auto-switching the child to a fullscreen review configuration) is
>    replaced by the spawn-on-click model in
>    [pr-walkthrough-launch-ux.md](pr-walkthrough-launch-ux.md): a launcher click
>    spawns a fresh read-only reviewer sub-agent and auto-switches the view to it;
>    the panel lives only inside that child session; on submit the reviewer is NOT
>    terminated (it stays live + selectable, survives restart, user-terminated).
>    Read [pr-walkthrough-launch-ux.md](pr-walkthrough-launch-ux.md) +
>    [../pr-walkthrough-panel.md](../pr-walkthrough-panel.md) for the current model.

## Context from the current UI

- Today `/walkthrough-pr <url|number>` is intercepted client-side and opens a `walkthrough:<changeset-id>` side-panel tab in the launching session.
- The walkthrough panel already supports side-panel, fullscreen, and standalone review surfaces; state is keyed by the walkthrough tab id.
- Existing tab behavior deduplicates by canonical changeset id and restores active panel tabs on reload.
- Sidebar nesting exists in two forms: delegate rows nested under their launcher via `delegateOf`, and team members nested under the team lead inside goal groups. The desired walkthrough behavior should visually match those patterns while using a first-class child-session relationship rather than delegate-session semantics.

## UX principle

Launching a walkthrough should feel like inviting a senior reviewer into the current workspace. The new agent is visible, read-only, and progress-bearing while it works; once it publishes the review panel (or hits a non-recoverable error) the walkthrough reaches a terminal state and the child session is terminated. (Superseded — the original UX kept the agent available for follow-up questions after publishing; see [Child session lifecycle and teardown](pr-walkthrough-agent-session.md#child-session-lifecycle-and-teardown).)

## Launcher experience

1. User launches from `/walkthrough-pr <url|number>`, Git Status **Walkthrough**, or PR-link action.
2. The launching session keeps its transcript; it does not receive the walkthrough panel.
3. Bobbit resolves the PR target, metadata, and diff, then persists the launch-time analysis bundle before creating any child session.
4. If launch-time resolution fails, the launcher shows the structured error and retry guidance; no walkthrough child row is created.
5. If resolution succeeds, Bobbit creates or focuses a dedicated walkthrough child session for the resolved PR target.
6. The launcher shows a short system/chat notice: `PR walkthrough started in “PR #123 Walkthrough”.` Include a primary inline action: `Open walkthrough`.
7. If child creation takes more than a moment after bundle resolution, show the target child row in `starting/preparing` state so the user sees that work began.
8. If the user stays in the launcher, the sidebar child row should show activity/unread state as the walkthrough agent posts progress.

## Sidebar placement and identity

- The walkthrough session appears directly beneath the launching session, indented like existing child rows.
- The parent row expands automatically on first creation so the child is discoverable.
- Title format: `PR #123 Walkthrough` when a number is known; otherwise `PR Walkthrough` or `Changeset Walkthrough`.
- The row should use a distinct review/walkthrough accessory and a read-only affordance in tooltip or secondary metadata: `Read-only PR walkthrough agent`.
- The session is selectable like any other session and remains listed until explicitly terminated/archived.
- Terminated or archived walkthrough children are hidden when **Show Archived** is off and reappear nested under their parent when **Show Archived** is on.

## Child session initial layout

When opened, the child session uses the same split ergonomics as a goal assistant:

- Left/primary area: normal agent chat transcript.
- Right/secondary area: PR walkthrough panel owned by this child session.
- The panel starts empty in a waiting state, not as a resolver progress bar.

Waiting panel copy:

- Heading: `Waiting for walkthrough`
- Body: `The walkthrough agent is reading the PR. Cards will appear here after it submits validated walkthrough YAML.`
- Secondary line: `Progress appears in chat; the panel only populates after validation succeeds.`
- Show lightweight skeleton card outlines only as placeholders; avoid implying a determinate progress bar.

## Agent chat progress

The agent should report rough investigation progress in chat at meaningful milestones, for example:

- `10% — read the launch-time bundle manifest and PR description.`
- `35% — grouped bundled changed files into review areas.`
- `70% — checking omissions and follow-up risks against bundle hunks.`
- `90% — validating walkthrough YAML before publishing.`

The server has already resolved the authoritative input at launch. The agent starts from `read_pr_walkthrough_bundle` and uses `readonly_bash` only for extra read-only investigation, not to fetch a second authoritative PR diff.

Progress is intentionally approximate. It should help the user trust the process without introducing a second panel-level loader.

## Compact navigation labels (`nav_label`)

The review rail is narrow (~240px). Full descriptive card titles overflow and truncate there, so every rail entry uses a short label distinct from the title. The agent communicates that label through an optional `nav_label` field on each `design_decisions[]` and `review_chunks[]` entry in the submitted YAML.

Contract (also stated in the schema prompt the agent receives):

- `nav_label` is **optional**. Keep it **≤3 words and ≤24 characters** so it never truncates in the rail.
- The full descriptive title stays in `title` (it is used for the card `<h2>` header).
- **Omit it to auto-derive** a compact label from the title. The server derives one (text before the first `:`/`—`/` - ` separator, first ≤3 words, hard-truncated to 23 chars + `…` if needed).

Server behaviour (`navLabelError` / `deriveNavLabel` in `src/shared/pr-walkthrough/nav-label.ts`, enforced in `walkthrough-yaml-schema.ts`):

- A present `nav_label` that violates the ≤3-word / ≤24-char rule fails validation with `nav_label must be ≤3 words and ≤24 characters.`, so the agent gets actionable retry feedback.
- An empty or whitespace-only `nav_label` is treated as omitted (it falls back to the derived label rather than failing), so the agent never produces a blank rail entry.
- `nav_label` is optional and the fallback is graceful, so the `submit_pr_walkthrough_yaml` contract is unbroken for existing clients and partial/legacy YAML still renders.

The orientation card does not take a `nav_label` from the agent — its rail label and per-beat labels are server-defined (see [Structured orientation beats](#structured-orientation-beats)).

## Structured orientation beats

The orientation card is rendered as a guided six-beat step-through (see [pr-walkthrough-panel.md](pr-walkthrough-panel.md) for the panel-side design). The beats are **server-derived from the existing YAML** — the agent does **not** author them and no new orientation fields are required. The server maps `walkthrough.context` + `merge_assessment` into the structured `sections` (At a glance, Why it exists, What it changes, Should it be merged?, What to scrutinise, Where to look). The merge beat is reframed to **"Should it be merged?"** with an answer-first line derived from `merge_assessment.recommendation` + `confidence`.

Because the beats are derived server-side, the agent's job is unchanged: populate the existing `walkthrough.context` and `merge_assessment` fields accurately and the guided step-through follows automatically.

## YAML validation retry state

Validation failures are part of the child session experience, not hidden infrastructure errors.

- Failed `submit_pr_walkthrough_yaml` calls render as tool results in chat with actionable field-level errors.
- The panel remains in the waiting state and adds an inline warning banner: `Walkthrough YAML needs correction`.
- The banner lists a compact summary such as `3 schema errors; latest attempt at 14:32` and offers `View details in chat`.
- Do not preserve partial cards from invalid YAML in the review panel.
- Repeated failures should remain calm and retryable; do not mark the whole walkthrough as failed unless the agent/session fails or the user cancels.
- If the agent goes idle without a successful submission, show a gentle reminder in chat and panel: `Submit validated walkthrough YAML to populate the review panel.`

## Successful submission and transition

After a valid YAML submission:

1. Persist the YAML-derived walkthrough payload under the child session/walkthrough id.
2. Replace the waiting panel with the populated PR walkthrough cards.
3. Leave the panel in the normal split view. The walkthrough panel does **not** automatically switch to fullscreen (superseded — was: "automatically switch the child session to fullscreen review configuration"); it shares the HTML preview panel's resize logic and fullscreen is strictly user-initiated.
4. Add a concise success message in chat: `PR walkthrough YAML accepted and published. This walkthrough session is now complete.`
5. **Terminate the child session** — `ready` is a terminal state, so the process exits and the persisted record is archived (the stored payload remains reviewable by `changesetId` in the side panel, fullscreen, or standalone route). There is no follow-up chat in the walkthrough session.

(Superseded — steps 4–6 originally kept chat available for follow-up questions and said "Do not terminate or archive the walkthrough agent"; leaving the child alive leaked its node process and respawned it on every restart. See [Child session lifecycle and teardown](pr-walkthrough-agent-session.md#child-session-lifecycle-and-teardown).)

Fullscreen is entered only when the user explicitly requests it (toolbar button or keyboard shortcut); Escape/collapse returns to the normal split layout. There is no automatic fullscreen transition on ready.

## Reload persistence

Reload should restore the user to the same mental state:

- Launcher session still shows the nested walkthrough child.
- Child session restores its transcript and read-only status.
- Waiting state persists if no valid YAML has been submitted.
- Latest validation-failure summary persists if the last attempt failed.
- Successful walkthrough payload restores the populated panel, active card, comments, decisions, and any user-initiated fullscreen state when it was active before reload (reload never forces fullscreen on its own).
- Standalone walkthrough route continues to open the same persisted review surface for the child session.

## Duplicate prevention

Deduplicate by canonical target within the launching session:

- Same parent + same PR URL/owner/repo/number should focus the existing child session.
- Same parent + same local `base..head` should focus the existing child session.
- If the target is still resolving, focus the in-progress child rather than creating another one.
- If the same PR is launched from a different parent session, create a separate child because cwd, auth, and PR context may differ.
- On duplicate focus, show `Existing walkthrough opened` rather than replaying startup messages.

## Failure states

Failure should be visible and actionable from the launcher or child, depending on when it occurs.

- **Launch metadata/diff resolution failure:** return the structured launch error before child creation; the launcher shows retry guidance and no child row is created.
- **Creation/model failure after bundle resolution:** create the child if possible, show an error panel and chat explanation. Launcher notice links to the failed child.
- **GitHub auth/permission/rate limit during launch:** return a structured launch error with retry guidance before creating a waiting child.
- **Read-only policy violation blocked:** tool result explains the blocked action; panel remains waiting unless the agent can continue safely.
- **Large/truncated PR:** walkthrough can still publish with visible warnings and prioritized chunks; warnings appear in Orientation and Audit.
- **Agent timeout/idle:** keep the child session alive, mark panel as waiting with reminder, and let the user prompt the agent again.
- **User terminates child before success:** launcher row becomes archived/terminated according to normal session rules; no panel is populated.

## Non-goals for this UX note

- No changes to GitHub review submission flow; export remains explicit and user-confirmed.
- No scraping final chat messages into cards.
- No determinate panel progress bar during analysis.
- ~~No automatic cleanup of the walkthrough agent after successful submission.~~ (Superseded — the child is now terminated on terminal job states; see [Child session lifecycle and teardown](pr-walkthrough-agent-session.md#child-session-lifecycle-and-teardown).)
