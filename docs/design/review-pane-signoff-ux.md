# Review Pane Sign-Off UX Guidance

This design note captures UX intent. For the shipped source model, routing, persistence, cleanup, and sanitization contract, see [Review Pane Sign-Off](../review-pane-signoff.md).

## Intent

Use the review pane as the single decision surface for gate sign-off content. The goal status widget should only alert, orient, and hand off; it should not become a markdown reader or a second approval flow.

## Layout

Order the bottom review controls to match how a reviewer works:

1. Navigate the review's files and add inline comments where needed.
2. Write one optional review-level final comment in a dedicated section.
3. Choose **Approve** or **Reject** for the whole review.

Place the final comment section directly above the decision buttons so the reviewer sees their last chance to summarize before committing the decision.

Recommended structure:

```text
[secondary file navigation, for multi-file reviews]
[selected file with inline comments]

Final comment
[textarea]
Helper text / validation message

[Dismiss]                         [Reject] [Approve]
```

Guidance:
- Label: **Final comment**.
- Placeholder: `Add an optional summary or decision note...`.
- Helper text: `Inline comments and the final comment will be sent with your decision.`
- Keep the textarea visually connected to the action bar, not buried inside the document body.
- Preserve existing inline comment affordances and annotation counts; the final comment supplements them, not replaces them.

## Decision button order

Keep **Reject** adjacent to **Approve**, with **Approve** as the rightmost primary forward action. **Dismiss** remains separated as the quiet action.

Rationale: sign-off is usually a confirmation task after review. Putting the primary action at the end of the action row preserves that forward progression while keeping rejection explicit without making it visually louder.

Button treatment:
- **Approve**: primary action styling.
- **Reject**: destructive/negative styling, but not visually louder than Approve unless validation has failed.
- **Dismiss**: secondary/quiet action, separated from the decision pair.

## Validation copy

Approval may submit with no comments.

Rejection must include at least one comment: either an inline comment on any file or a non-empty review-level final comment.

Use this inline validation message below the final comment field when the user clicks **Reject** without any comments:

> Add a final comment or at least one inline comment before rejecting.

Keep the message local to the final comment/decision area. Do not use a modal for this validation; the fix is already in view.

## Feedback composition

Decision submissions should include:

- Decision: approve or reject.
- Final comment, when present.
- Inline comments, when present.

For human-readable feedback, order the content as:

1. Decision summary.
2. Inline comments grouped by file in review order, with quoted context.
3. The single review-level final comment.

Approval with no comments should still produce a concise positive signal for arbitrary markdown reviews, e.g. `Approved with no comments.` Verification sign-off approvals may omit feedback if the endpoint allows it.

## Goal status widget handoff

The widget is a launcher, not a reading surface.

When the user clicks **Start Review** on a pending sign-off:

1. Fetch the submitted gate signal content.
2. Open or focus a one-file review titled with goal, gate, and sign-off step context.
3. Close the popover after a successful handoff.
4. Show a compact row-level error if content cannot be loaded.

Do not render markdown inline in the widget popover. Keeping the popover compact avoids cramped reading, duplicated decision logic, and inconsistent validation.

Recommended title pattern:

```text
Sign-off: <goal title> / <gate name> / <step label-or-name>
```

Only add a signal suffix when needed to disambiguate repeated submissions.

## Persistence and closure

A review opened from the widget should survive reload/navigation until its decision cleanup completes or its primary workspace tab is successfully closed. Closing without submitting should warn once when any file has an inline comment or the review has a non-empty final draft.

After feedback succeeds, first close and confirm absence of every primary workspace tab for that review. Only then remove its persisted group, clear annotations by stable review/file identity, discard its final draft, and write the applicable tombstone. If workspace close fails, preserve that state and show a retry error; a decision retry may repeat feedback that was already delivered. Duplicate titles and sibling reviews must remain intact. See the main reference for the exact tombstone and cleanup rules.
