# Review Pane Sign-Off

The review pane is Bobbit's shared human decision surface for markdown reviews and gate sign-offs. It lets reviewers read the submitted content at full pane size, add inline annotations, add a final decision note, and then approve or reject from one consistent action bar.

Opening a pending sign-off review does not resolve the gate; the reviewer must explicitly select **Approve** or **Reject**.

This keeps compact surfaces, including the goal status widget and gate tool cards, focused on alerting and handoff instead of duplicating submitted-content rendering or decision validation.

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

## Pending sign-off launchers

Pending sign-off launchers are notifications and handoffs, not alternate review surfaces. They all use the same launch helper and review-document event so content lookup, titles, fallbacks, and decision routing cannot drift between UI locations.

### Eligibility

`awaitingHuman: true` on the authoritative active step is the actionability marker. A launcher must not infer eligibility from a `human-signoff` type, a `running` status, prompt or label metadata, status text, or verification output.

This strict rule excludes:

- a `human-signoff` step queued for a later phase;
- a completed or cancelled step;
- a stale verification;
- a historical signal that is no longer awaiting input; and
- persisted output that merely describes a past sign-off.

The active `gate_inspect(section="verification")` snapshot applies `awaitingHuman`, `humanLabel`, and `humanPrompt` as an active-state overlay only when the current verification and exact live `human-signoff` step are both running and the step is parked for human input. Inactive and historical snapshots omit the marker, so their cards are not actionable.

### Supported surfaces

| Surface | Launcher behavior |
|---|---|
| Goal status widget | Shows the pending label and substituted prompt in an **Awaiting sign-off** card. **Start Review** launches the submitted content and closes the widget popover after a successful handoff. |
| Live `gate_signal` card | `GateVerificationLive` adds **Start Review** to the exact active step. It reacts to `gate_verification_awaiting_human`, removes the action on step/sign-off/verification completion, and reconciles with REST so dropped events do not require a reload. |
| Shared `gate_status` card | Uses the same `GateVerificationLive` component for its latest active verification, so it follows the same event and reconciliation lifecycle as `gate_signal`. |
| Active `gate_inspect(section="verification")` card | Shows **Start Review** only when the server snapshot carries the active step's explicit `awaitingHuman: true` marker. Inspecting an older signal does not revive its action. |

Live reconciliation treats the active-verifications endpoint as authoritative for whether a matching verification still exists. A successful response with no matching entry marks persisted running state stale and removes sign-off actionability. A matching active entry with an empty `steps` array still confirms that the verification is alive, but carries no replacement step data, so it does not erase event-seeded or already rendered rows. Failed REST requests also leave current live state intact, because a network failure is not evidence that the verification or sign-off ended.

Completion events are scoped to the mounted card's gate and signal, plus the step when the event represents one step. A present `goalId` must match the launch target; document-scoped events may omit it because the mounted card already supplies the goal scope. This lets scoped completion events remove a resolved launcher without allowing an event from another goal to do so.

### Shared handoff contract

On **Start Review**, the shared launcher:

1. Disables the button, marks it busy, and changes its label to **Opening…**.
2. Fetches `/api/goals/:goalId/gates/:gateId/signals` and selects the signal whose `id` exactly matches `signalId`. The response may also include `goalTitle` and `gateName` display metadata.
3. Uses the signal's submitted `content` as the review markdown. Missing or whitespace-only content becomes `No content was attached to this sign-off signal.`
4. Builds `Sign-off: <goal> / <gate> / <step>`. Display metadata already supplied by the launcher takes precedence; otherwise the helper uses `goalTitle` and `gateName` from the signal-history response, then falls back to stable goal and gate identifiers. The step uses its human label when supplied, then its step name. The goal widget adds the first eight characters of the signal id only when otherwise-identical pending titles need disambiguation.
5. Dispatches `bobbit-open-review-document` with the title, markdown, and this source:

   ```ts
   {
     kind: "verification-signoff-markdown",
     goalId,
     gateId,
     signalId,
     stepName,
     goalTitle?,
     gateName?,
     stepLabel?,
   }
   ```

The shared event handler opens or focuses the matching review document and selects the review workspace. Keeping all four launch sources on this event contract ensures approve/reject decisions retain the exact goal, gate, signal, and step routing identifiers.

A launch remains bound to the target and card that started it. If the target changes, the sign-off resolves, or the card disconnects while content is loading, the request is cancelled and its late result cannot open a stale review or surface an irrelevant error. This prevents recycled or removed cards from handing off content for an obsolete sign-off.

If the request fails or the matching signal no longer exists, the launcher re-enables **Start Review** and shows `Couldn’t open review. Try again.` beside the action. A completion event received during loading also clears the loading/error state and removes the resolved launcher.

### Launcher-only constraint

Gate tool cards do not render the submitted sign-off markdown, substituted prompt, annotations, or approve/reject controls inline. Existing verification-output displays are separate from the pending sign-off reader. The goal status widget may show the short sign-off prompt for context, but it also leaves submitted content and all decisions to the review pane. This keeps compact cards readable and leaves sanitization, comments, validation, and submission in one authoritative surface.

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

## Persistence, replay, and cleanup

Sign-off review contexts persist per session in browser storage so a widget-opened sign-off review survives reloads and navigation until the user submits, dismisses, or closes it. The persisted context includes the review document, markdown, title, and source payload.

Inline annotations persist through the review annotation store and are scoped by session and document title. Final comments are local drafts in the pane; submit before leaving the page if the final comment is the only rejection feedback.

### Live reopen vs historical replay

A `review_open` result can arrive through two paths: a fresh live event from the active agent, or historical replay/hydration while restoring chat state. The review pane intentionally treats those paths differently.

- A fresh live `review_open` from the active session always opens or selects the review workspace tab, even after the previous review was approved, rejected, or otherwise submitted. The live path clears the session's submitted-review marker before opening the document so the revised review is visible immediately.
- Historical replay and hydration still suppress submitted reviews. This prevents a page reload or reconnect from resurrecting a review the user already completed.
- Background, cached, or non-selected sessions must not mutate active review state. Their replayed or live tool results are ignored until the session becomes active.

Document opening still goes through the shared review document helpers, preserving `replace: false`, same-title replacement, persisted review documents, and side-panel workspace tab behavior.

Regression coverage for this invariant lives in `tests/e2e/ui/review-pane.spec.ts`: it opens a review, rejects with feedback, verifies the tab closes, emits a revised live `review_open`, and asserts the `Review: Test Document` tab reopens with revised markdown. Fixture and unit coverage continue to own reload suppression and active-session guard behavior.

Cleanup expectations:

- Successful approve/reject removes the review document, clears persisted sign-off context, clears annotations for that document, and refreshes gate status for verification sign-offs.
- Dismiss closes the current review surface and clears persisted sign-off contexts without submitting a decision.
- Closing a tab or dismissing with unsent inline/final comments prompts before discarding them.
- Arbitrary markdown reviews keep submitted-review replay suppression so historical `review_open` tool results do not reopen a review the user already submitted or dismissed.

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
