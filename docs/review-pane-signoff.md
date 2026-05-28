# Review Pane Sign-Off

The review pane is Bobbit's shared human decision surface for markdown reviews and gate sign-offs. It lets reviewers read the submitted content at full pane size, add inline annotations, add a final decision note, and then approve or reject from one consistent action bar.

This keeps compact surfaces, such as the goal status widget, focused on alerting and handoff instead of duplicating markdown rendering or decision validation.

## Launch sources

Review documents carry an optional `source` payload. The source identifies where the review came from and how an approve/reject decision should be routed, while the pane itself only needs the shared decision contract.

```ts
type ReviewSource =
  | { kind: "markdown-review"; sessionId: string }
  | {
      kind: "verification-signoff-markdown";
      goalId: string;
      gateId: string;
      signalId: string;
      stepName: string;
      goalTitle?: string;
      gateName?: string;
      stepLabel?: string;
    }
  | {
      kind: "verification-signoff-pr";
      goalId: string;
      gateId: string;
      signalId: string;
      stepName: string;
      prUrl: string;
      goalTitle?: string;
      gateName?: string;
      stepLabel?: string;
    };
```

Current source behavior:

- **`markdown-review`** — opened by the existing `review_open` tool or arbitrary markdown review flow. Decisions are converted into agent-chat feedback so existing review behavior stays compatible.
- **`verification-signoff-markdown`** — opened from a pending `human-signoff` step. Decisions resolve the parked verification step through the gate sign-off endpoint.
- **`verification-signoff-pr`** — reserved for future PR review panes. It uses the same decision target fields plus `prUrl`, but submitting this source is not implemented yet.

The shared decision payload is:

```ts
type ReviewDecisionPayload = {
  decision: "approve" | "reject";
  finalComment: string;
  inlineComments: ReviewInlineCommentPayload[];
  feedback: string;
};
```

The `feedback` field is a human-readable fallback for the agent-chat path. Verification sign-off submissions compose `finalComment` and `inlineComments` into markdown feedback and send it as the sign-off endpoint's `feedback` value when any feedback exists.

## Goal status widget handoff

The goal status widget is only the launcher for pending sign-off content.

When a `human-signoff` verification step is awaiting input, the widget shows an awaiting indicator and an **Awaiting sign-off** card. The card's **View content** action:

1. Fetches the gate's signal history and finds the pending `signalId`.
2. Opens or focuses a review-pane document with `source.kind: "verification-signoff-markdown"`.
3. Titles the tab as `Sign-off: <goal> / <gate> / <step label-or-name>`, adding a signal suffix only when repeated titles need disambiguation.
4. Closes the popover after a successful handoff.
5. Shows a compact row-level error if the signal content cannot be loaded.

The widget must not expand or render the submitted markdown inline. That constraint avoids a cramped reader, duplicated approve/reject flows, and validation drift between the widget and review pane.

## Decision controls and validation

The review pane action area is ordered around the reviewer flow:

1. Read the document and add inline comments.
2. Add an optional **Final comment**.
3. Choose **Approve** or **Reject**.

Validation rules are shared across markdown reviews and verification sign-offs:

- **Approve** may submit with no inline comments and an empty final comment.
- **Reject** requires at least one comment: either a non-empty final comment or one or more inline comments.
- If reject is attempted without comments, the pane shows: `Add a final comment or at least one inline comment before rejecting.`

The client validates before dispatching and the submission router enforces the same rule before sending feedback to an agent or resolving a sign-off.

## Comment handling

Review decisions preserve both comment channels:

- **Inline comments** are captured from annotations on the active review document. Each payload includes the selected quote, comment text, optional prefix/suffix, offsets, and whether the selection was inside code.
- **Final comment** is a pane-local decision note for the active document.

Feedback composition is deterministic:

1. Final comment, when present.
2. Inline comments grouped under an **Inline comments** section, with quoted context and offsets where available.
3. A concise approval fallback for arbitrary markdown reviews when approval has no comments.

Verification sign-off approvals with no comments may omit `feedback`; the endpoint only needs `signalId`, `stepName`, and `decision: "pass"` to resolve the step.

## Persistence and cleanup

Sign-off review contexts persist per session in browser storage so a widget-opened sign-off review survives reloads and navigation until the user submits, dismisses, or closes it. The persisted context includes the review document, markdown, title, and source payload.

Inline annotations persist through the review annotation store and are scoped by session and document title. Final comments are local drafts in the pane; submit before leaving the page if the final comment is the only rejection feedback.

Cleanup expectations:

- Successful approve/reject removes the review document, clears persisted sign-off context, clears annotations for that document, and refreshes gate status for verification sign-offs.
- Dismiss closes the current review surface and clears persisted sign-off contexts without submitting a decision.
- Closing a tab or dismissing with unsent inline/final comments prompts before discarding them.
- Arbitrary markdown reviews keep the existing submitted-review behavior so replayed `review_open` tool results do not reopen a review the user already submitted or dismissed.

## Security and sanitization

Review markdown is untrusted because it can come from agents, gate submissions, or future external review sources. The review document renderer must sanitize before inserting content into the DOM.

Current constraints:

- Raw HTML outside code spans/blocks is escaped before markdown parsing.
- Generated markdown HTML is sanitized after parsing.
- Dangerous elements are removed, including scriptable or document-mutating tags such as `script`, `iframe`, `object`, `embed`, `form`, `input`, `button`, `style`, `link`, `meta`, `base`, `svg`, `math`, and `template`.
- Event-handler attributes and unsafe attributes such as `srcdoc` and inline `style` are stripped.
- URL-bearing attributes allow only safe protocols: `http:`, `https:`, `mailto:`, and `tel:`. `data:` URLs are allowed only for image attributes with safe image MIME types.
- `srcset` candidates are validated individually; an unsafe candidate removes the whole `srcset`.
- Links open in a new tab with `rel="noopener noreferrer"`.
- Review-source payloads received from browser events are normalized before opening. Persisted review contexts are only written for supported sign-off source kinds; local storage is not a security boundary.

Authorization remains the gate sign-off endpoint's responsibility. The endpoint trusts the gateway token for browser users, while sandboxed sub-agents are blocked from posting to `/signoff` so they cannot self-approve work they produced.

## Related docs

- [Goals, Workflows, and Tasks — Human sign-off steps](goals-workflows-tasks.md#human-sign-off-steps)
- [REST API — Sign-off endpoint](rest-api.md#sign-off-endpoint)
- [Human Sign-Off Gates design](design/human-signoff-gates.md)
- [Review Pane Sign-Off UX Guidance](design/review-pane-signoff-ux.md)
- [Mobile Inline Commenting — Review Pane](review-pane-mobile.md)
