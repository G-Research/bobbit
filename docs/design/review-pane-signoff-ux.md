# Review Pane Sign-Off UX Guidance

## Intent

Use the review pane as the single decision surface for gate sign-off content. The goal status widget should only alert, orient, and hand off; it should not become a markdown reader or a second approval flow.

## Layout

Order the bottom review controls to match how a reviewer works:

1. Read the markdown document and add inline comments where needed.
2. Write an optional final comment in a dedicated section.
3. Choose **Approve** or **Reject**.

Place the final comment section directly above the decision buttons so the reviewer sees their last chance to summarize before committing the decision.

Recommended structure:

```text
[review document with inline comments]

Final comment
[textarea]
Helper text / validation message

[Dismiss]                         [Approve] [Reject]
```

Guidance:
- Label: **Final comment**.
- Placeholder: `Add an optional summary or decision note...`.
- Helper text: `Inline comments and the final comment will be sent with your decision.`
- Keep the textarea visually connected to the action bar, not buried inside the document body.
- Preserve existing inline comment affordances and annotation counts; the final comment supplements them, not replaces them.

## Decision button order

Use this button order:

1. **Approve**
2. **Reject**

Rationale: sign-off is usually a confirmation task after review, so the primary forward action should appear first. Rejection remains adjacent and explicit, but must not be the first decision control the user reaches.

Button treatment:
- **Approve**: primary action styling.
- **Reject**: destructive/negative styling, but not visually louder than Approve unless validation has failed.
- **Dismiss**: secondary/quiet action, separated from the decision pair.

## Validation copy

Approval may submit with no comments.

Rejection must include at least one comment: either an inline comment or a non-empty final comment.

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
2. Final comment.
3. Inline comments grouped with quoted context.

Approval with no comments should still produce a concise positive signal for arbitrary markdown reviews, e.g. `Approved with no comments.` Verification sign-off approvals may omit feedback if the endpoint allows it.

## Goal status widget handoff

The widget is a launcher, not a reading surface.

When the user clicks **View content** on a pending sign-off:

1. Fetch the submitted gate signal content.
2. Open or focus a review-pane document titled with goal, gate, and sign-off step context.
3. Close the popover after a successful handoff.
4. Show a compact row-level error if content cannot be loaded.

Do not render markdown inline in the widget popover. Keeping the popover compact avoids cramped reading, duplicated decision logic, and inconsistent validation.

Recommended title pattern:

```text
Sign-off: <goal title> / <gate name> / <step label-or-name>
```

Only add a signal suffix when needed to disambiguate repeated submissions.

## Persistence and closure

A review opened from the widget should survive reload/navigation until the user submits a decision or closes the document. Closing without submitting should keep the existing unsent-comment warning behavior when inline comments exist.

After successful submission, clear the document, its persisted review context, and its annotations for that title.
