# Session-hosted PR walkthrough agent UX

> **Superseded behaviour:** the "automatically switch the child to fullscreen
> review configuration" steps below describe the original design. Auto-fullscreen
> on ready has since been **removed** — the walkthrough panel now shares the HTML
> preview panel's resize logic and fullscreen is strictly user-initiated. See
> [walkthrough-panel-resize-fix.md](walkthrough-panel-resize-fix.md).

## Context from the current UI

- Today `/walkthrough-pr <url|number>` is intercepted client-side and opens a `walkthrough:<changeset-id>` side-panel tab in the launching session.
- The walkthrough panel already supports side-panel, fullscreen, and standalone review surfaces; state is keyed by the walkthrough tab id.
- Existing tab behavior deduplicates by canonical changeset id and restores active panel tabs on reload.
- Sidebar nesting exists in two forms: delegate rows nested under their launcher via `delegateOf`, and team members nested under the team lead inside goal groups. The desired walkthrough behavior should visually match those patterns while using a first-class child-session relationship rather than delegate-session semantics.

## UX principle

Launching a walkthrough should feel like inviting a senior reviewer into the current workspace. The new agent is visible, read-only, progress-bearing, and remains available for follow-up questions after it has populated the review panel.

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
3. Automatically switch the child session to fullscreen review configuration.
4. Keep chat available in the fullscreen compact prompt area so the user can ask follow-up questions with PR context still loaded.
5. Add a concise success message in chat: `Walkthrough published. I can answer follow-up questions about any card or hunk.`
6. Do not terminate or archive the walkthrough agent.

The fullscreen transition should be a focus shift, not a modal trap: Escape/collapse returns to the normal split layout.

## Reload persistence

Reload should restore the user to the same mental state:

- Launcher session still shows the nested walkthrough child.
- Child session restores its transcript and read-only status.
- Waiting state persists if no valid YAML has been submitted.
- Latest validation-failure summary persists if the last attempt failed.
- Successful walkthrough payload restores the populated panel, active card, comments, decisions, and fullscreen state when it was active before reload.
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
- No automatic cleanup of the walkthrough agent after successful submission.
