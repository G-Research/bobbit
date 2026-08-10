# Review Pane Sign-Off

The review pane is Bobbit's shared human decision surface for markdown reviews and gate sign-offs. It lets reviewers read the submitted content at full pane size, add inline annotations, add a final decision note, and then approve or reject from one consistent action bar.

This keeps compact surfaces, including the goal status widget and gate tool cards, focused on alerting and handoff instead of duplicating submitted-content rendering or decision validation.

## Review hierarchy and identity

A review is the decision unit. It has a stable `reviewId`, an ordered non-empty set of files, one `activeFileId`, and a routing `source`. Each file has its own stable `fileId`, display title, and Markdown. The separate identities matter because review titles and file titles are display labels and may be duplicated.

Each review owns exactly one closable primary side-panel workspace tab. Selecting that tab activates the review. The selected review's files are navigation-only secondary tabs inside the review pane; selecting one changes only `activeFileId`. Secondary tabs never have close controls, and a one-file review omits the secondary row. This hierarchy prevents one logical decision from becoming several unrelated workspace tabs and makes the primary close action an atomic close of the review, its files, and its comments.

The server-backed side-panel workspace remains authoritative. A persisted review is hydrated only when its primary workspace tab is still present. Closing the primary tab therefore means absence until a new explicit live open, even if old tool output remains in chat history.

### `review_open` contract

`review_open` accepts exactly one top-level source mode:

```ts
type ReviewOpenInput =
  | { title?: string; replace?: boolean; markdown: string }
  | { title?: string; replace?: boolean; file: string }
  | {
      title?: string;
      replace?: boolean;
      files: Array<
        | { title?: string; markdown: string }
        | { title?: string; file: string }
      >;
    };
```

The `files` array must be non-empty, and each entry must contain exactly one of `markdown` or `file`. Mixing top-level single-document input with `files`, mixing both sources in one entry, empty arrays, and unknown properties are rejected. Existing `markdown` and `file` calls remain compatible by becoming one-file reviews.

Defaults are deterministic:

- the review title is the single file's basename for a top-level `file` call, otherwise `Review`;
- a one-file review uses the review title as its file title; and
- a `files` entry uses its explicit title, its file basename, or `File N`, in that order.

All file paths are resolved and read before the tool emits `review_open`. If any entry is missing, not a regular file, binary, or unreadable, the call returns an error and no partial review payload. The successful canonical payload contains one opaque review identity and one opaque identity per file, including when display titles repeat.

Replacement applies to the whole review:

- `replace` defaults to `true`. The first existing review with the same display title is replaced in place, preserving its review identity and workspace position. File identities survive when the same title occurrence survives, so annotations remain attached through content updates and reordering; the incoming file order is authoritative.
- `replace: false` appends a distinct review even when its title duplicates another. Each live tool call has fresh opaque identities.
- Replaying the same canonical `replace: false` result is idempotent by exact `reviewId`; it does not append another copy.

These rules deliberately use stable identities for ownership while retaining title-based replacement for backward compatibility.

## Launch sources

Review groups carry a `source` payload. The source identifies where the review came from and how an approve/reject decision should be routed, while the pane itself only needs the shared decision contract.

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

The shared event handler models this legacy document event as a one-file review, opens or focuses its primary workspace tab, and selects it. Keeping all four launcher surfaces on this event contract ensures approve/reject decisions retain the exact goal, gate, signal, and step routing identifiers.

A launch remains bound to the target and card that started it. If the target changes, the sign-off resolves, or the card disconnects while content is loading, the request is cancelled and its late result cannot open a stale review or surface an irrelevant error. This prevents recycled or removed cards from handing off content for an obsolete sign-off.

If the request fails or the matching signal no longer exists, the launcher re-enables **Start Review** and shows `Couldn’t open review. Try again.` beside the action. A completion event received during loading also clears the loading/error state and removes the resolved launcher.

### Launcher-only constraint

Gate tool cards do not render the submitted sign-off markdown, substituted prompt, annotations, or approve/reject controls inline. Existing verification-output displays are separate from the pending sign-off reader. The goal status widget may show the short sign-off prompt for context, but it also leaves submitted content and all decisions to the review pane. This keeps compact cards readable and leaves sanitization, comments, validation, and submission in one authoritative surface.

## Review-wide decisions and comments

The action area follows the reviewer flow: navigate the review's files, add inline comments, add one optional review-level **Final comment**, then choose **Approve** or **Reject**. Switching files or primary review tabs does not turn a decision or final-comment draft into file-local state.

Validation is shared across arbitrary Markdown reviews and verification sign-offs:

- **Approve** may submit with no comments.
- **Reject** requires at least one inline comment on any file or a non-empty final comment.
- A comment on an inactive file satisfies rejection validation.
- If feedback is absent, the pane shows `Add a final comment or at least one inline comment before rejecting.` The submission router enforces the same rule at its boundary.

Each inline payload retains the stable file identity and display title together with its quote, comment, context, offsets, and code-selection flag. Feedback is composed once in review file order: an **Inline comments** section contains one file-titled subsection for every commented file, including separate subsections for duplicate file titles, followed by the single **Final comment** section when present. This deterministic ordering makes agent and sign-off feedback readable without losing identity at the annotation layer.

The routing remains shared:

- arbitrary `markdown-review` decisions become one agent-chat feedback message, with an approval fallback when there are no comments;
- `verification-signoff-markdown` decisions post the same composed feedback to the exact goal, gate, signal, and step; an uncommented approval may omit feedback; and
- the reserved PR source still rejects submission because that route is not implemented.

Decision submission is coalesced by the exact `(sessionId, reviewId)` key. The first accepted approve or reject owns the pending external effect; repeated or conflicting clicks return that same promise and outcome, so one review-wide feedback message or sign-off request is sent at most once. Other review keys remain independent.

The lifecycle checks for supersession before the agent prompt or sign-off request, then checks again before each destructive local effect. A close or explicit live reopen that becomes newer before the external effect suppresses the decision entirely. If replacement content arrives after the effect, exact snapshot matching prevents the old completion from tombstoning or removing the replacement.

The outcome reports the exact session, review, submitted state, and final comment accepted by the first decision. The UI discards a final-comment draft only when that outcome says submission completed, no replacement with the same identity exists, and the current draft still equals the submitted draft. A failed or superseded decision, a replacement, or a draft edited while submission was pending therefore keeps its draft. A successful route closes only the decided review; an external routing failure leaves it available for retry.

## Persistence, session ownership, replay, and cleanup

Review groups persist per owning session in browser storage; annotations and exact replay tombstones persist through the server-backed review annotation store. The owner key is never inferred from whichever session happens to be visible when an asynchronous tool result finishes. This separation lets sessions continue producing durable reviews in the background without navigating the user away or overwriting the foreground review model.

### Exact lifecycle ordering

Lifecycle effects are serialized by exact `(sessionId, reviewId)` key. A newer intent increments that key's generation, waits for the previous effect to settle, and can test whether it still owns the key before each irreversible step. A failure does not poison the queue, and unrelated reviews run independently. This ordering makes the latest explicit live intent authoritative without globally blocking review work.

An explicit live `review_open` first persists the complete group and selected file synchronously for its emitting session. Its ordered effect then:

1. clears the target review's replay tombstone and the unowned legacy submitted flag;
2. stops if a newer exact-key intent has superseded it;
3. creates or focuses the exact primary tab in that owner's server-backed workspace; and
4. at completion time, hydrates and selects the review only if that owner is now visible and the exact primary tab is authoritative.

Completion-time hydration matters when the user switches sessions while the tombstone or workspace request is in flight: the newly visible owner receives the requested review without retargeting the operation. A background owner still receives a focused workspace tab, but the selected session, foreground review model, and foreground user-selection guard remain unchanged. A focused open clears a selection guard only when the guard belongs to the same owner session, so delayed foreground workspace responses cannot undo the user's foreground choice.

Close, dismiss, submission cleanup, and live reopen share the same exact-key sequence. Workspace close retries one revision conflict once, using the newer authoritative revision only when the tab still exists. If a live reopen supersedes an in-flight close, stale cleanup stops and the explicit open reasserts the primary after any already-dispatched close settles; the last live intent therefore wins. If an unsuperseded cleanup still cannot close the primary after reconciliation, it rejects with an actionable retry-or-reload error instead of reporting silent success. The review content may already be removed at that point, while an obsolete failure from a superseded intent is suppressed.

A live `review_close` follows the same owner rule. Its public form accepts an optional review title: every matching whole review and all its files close, while omitting the title closes all reviews in the calling session. Duplicate titles therefore close together; callers that need later selective close should use distinct titles. Internally, canonical results may be normalized to an exact `reviewId`, which takes precedence over title matching without exposing identity-based close as a public tool input. Either form is scoped to the owner session; when that owner is in the background, it never changes the foreground or any sibling session.

### Authoritative absence and exact tombstones

Historical tool-result replay is content history, not an instruction to mutate review or workspace state. Hydration restores only persisted groups whose authoritative primary tabs remain open and whose exact identities are not tombstoned. This prevents reload or reconnect from resurrecting a submitted, dismissed, tool-closed, or primary-tab-closed review.

Tombstones are per `(sessionId, reviewId)`, with separate `submitted` and `closed` states. A Markdown decision writes `submitted`; close, dismiss, and `review_close` write `closed`. Exact IDs prevent one completed review from suppressing a sibling or a duplicate-title review. The legacy session-wide submitted boolean is read only as a one-review migration fallback and is never written by grouped-review decisions.

A fresh explicit live open is allowed to reopen its exact review. It clears that target's exact tombstone and retires the unowned session-wide legacy submitted boolean, including when annotation hydration was already in flight. Other exact tombstones remain intact, so migration cannot revive submitted or closed siblings. Historical replay clears neither form of suppression.

### Cleanup boundary

Inline annotations are owned by stable file identity. A title-keyed annotation from the legacy one-document model is considered only when that title identifies exactly one file in the review; a duplicate-title match is rejected as ambiguous rather than assigned to the first file. Exact and migrated annotations are deduplicated before review-wide feedback is composed. Cleanup removes a legacy title bucket only after no sibling review owns that title, including when the closing review itself repeats it.

Final comments have one shared in-memory owner per `(sessionId, reviewId)`, outside any individual pane instance. Desktop and eager mobile panes, responsive remounts, and primary-tab switches therefore see the same exact draft without letting one review overwrite another. The draft remains intentionally reload-ephemeral.

Closing or dismissing a primary asks once before discarding the target review's aggregate inline comments plus non-empty final draft. The count and confirmation are resolved from the tab's exact owner even when another primary is selected. Cancelling preserves that review, annotations, active file, and draft. Confirming cleanup, or successfully submitting a decision:

- removes only that review group from owner-session persistence and the visible model;
- closes only primary workspace tabs that resolve to that review identity;
- clears annotations keyed by each current stable file ID and by the review ID;
- clears an unowned legacy title-keyed annotation bucket;
- flushes pending annotation writes; and
- discards only that exact review's in-memory final-comment draft.

Other reviews, their workspace tabs, active files, annotations, and drafts remain intact. Verification sign-off success also refreshes the relevant gate status. Submit before leaving the page when the final comment is the only rejection feedback.

## Responsive tabs and accessibility

The secondary row measures its available width and each file tab's bounded natural width, including annotation badges. It exposes the largest fitting prefix and reserves room for **More tabs** rather than relying on a fixed file count. Resize observation repeats the measurement when the pane changes size.

The overflow menu is a sibling of the clipped row and uses the native Popover API to enter the browser top layer. Its fixed coordinates are derived from the trigger and clamped to the viewport, which keeps it visible at desktop and narrow widths. The trigger exposes `aria-haspopup`, `aria-expanded`, and `aria-controls`; the popup uses menu/menuitem semantics, moves focus to the active or first item, supports arrow keys plus Home/End, closes after selection, and dismisses on outside click or Escape. Escape restores trigger focus. Items are navigation only.

Primary workspace tabs use a shrinking, ellipsized label next to a fixed-size close target inside an overflow-contained pill. The close target therefore stays visually and interactively inside long-title tabs at narrow widths instead of being pushed beyond the tab geometry.

## Security and Markdown rendering

### Authenticated review controls

Live `review_open` and `review_close` results are control messages, not ordinary chat content. The session adapter records single-use provenance when the matching review tool execution starts: exact tool-call ID, exact review action, and a bounded timestamp. Provenance survives `tool_execution_end` because the persisted result can arrive afterward, but stale entries expire.

A control is accepted only from a protocol-typed tool-result envelope, correlated to that recorded call ID, containing exactly one review action that matches the recorded tool. Authorization is consumed before the first asynchronous mutation, so concurrent delivery or replay cannot reuse it. Missing, unrelated, stale, mismatched, multiply actionable, historical, or ordinary text output fails closed. This boundary prevents JSON resembling `review_close` in another tool's output from mutating either foreground or background review state.

### Markdown content

Review Markdown is untrusted because it can come from agents, gate submissions, or future external sources. The renderer uses an isolated Marked instance whose raw-HTML token renderer escapes only tokens the Markdown parser classified as HTML. This token-aware boundary replaces regex protection: Marked's normal code renderers escape inline, fenced, indented, nested-list, and blockquote code exactly once, so a genuine `<` remains the literal glyph instead of becoming visible `&lt;` text. Raw HTML outside code remains inert text.

Generated Markdown HTML then passes through a defense-in-depth DOM sanitizer before insertion:

- scriptable or document-mutating elements such as `script`, `iframe`, `object`, `embed`, forms and controls, `style`, `link`, `meta`, `base`, `svg`, `math`, and `template` are removed;
- event handlers, `srcdoc`, and inline `style` are stripped;
- URL-bearing attributes allow only `http:`, `https:`, `mailto:`, and `tel:`; safe image MIME types are the only permitted `data:` URLs;
- every `srcset` candidate is checked, and one unsafe candidate removes the full attribute; and
- links open in a new tab with `rel="noopener noreferrer"`.

Review-source browser payloads are normalized before opening, and only supported source kinds are persisted. Browser storage is not a security boundary. Authorization remains the gate sign-off endpoint's responsibility: browser users authenticate through the gateway, while sandboxed sub-agents cannot post to `/signoff` and self-approve their work.

## Implementation and verification map

| Concern | Primary implementation | Focused coverage |
|---|---|---|
| Tool schema, validation, file loading, and canonical payload | `defaults/tools/review/extension.ts` and the review tool definition under `defaults/tools/review/` | `tests2/core/review-extension.test.ts` |
| Group persistence, exact-key lifecycle ordering, decision coalescing, tombstones, and cleanup | `src/app/review-sources.ts` | `tests2/dom/review-group-model.test.ts` |
| Live control provenance and owner-session isolation | `src/app/remote-agent.ts` | `tests2/dom/review-tool-active-guard.test.ts` |
| Primary workspace authority, background focus guards, and review/file selection | side-panel workspace and app render modules under `src/app/` | `tests2/dom/side-panel-workspace-review-normalize.test.ts` and grouped review DOM/browser coverage |
| Secondary tabs, shared draft ownership, measured overflow, accessibility, and decision UI | review components and styles under `src/ui/components/review/` | `tests2/dom/review-pane-groups.test.ts` and the grouped review browser fixture |
| Annotation migration, persistence, and exact tombstones | client and server review annotation stores | grouped review lifecycle tests and review annotation API integration tests |
| Token-aware HTML handling and sanitizer policy | `src/ui/components/review/ReviewDocument.ts` | `tests2/dom/review-document-sanitize.test.ts` |
| End-to-end multi-review and background-session lifecycle | shared review surface plus gateway/session workspace paths | `tests2/browser/journeys/review-groups.journey.spec.ts` |

For a review change, run `npm run check` and `npm run test:unit`, then the targeted grouped-review browser fixture and journey through the normal `npm run test:browser` workflow. Also rerun the existing mobile commenting, human-signoff, and side-panel workspace journeys when touching their shared routing or chrome. The suite entries and ownership reasons are registered in `tests2/tests-map.json`; use those entries rather than introducing an unregistered ad hoc test path.

Manual browser verification should cover multiple same-session reviews, duplicate titles, one-file row suppression, enough files to overflow at both desktop and narrow widths, keyboard dismissal/focus, close-target geometry, sibling survival after close/decision, reload hydration, and a live background owner open/close while another session remains selected.

## Related docs

- [Goals, Workflows, and Tasks — Human sign-off steps](goals-workflows-tasks.md#human-sign-off-steps)
- [REST API — Sign-off endpoint](rest-api.md#sign-off-endpoint)
- [Human Sign-Off Gates design](design/human-signoff-gates.md)
- [Review Pane Sign-Off UX Guidance](design/review-pane-signoff-ux.md)
- [Mobile Inline Commenting — Review Pane](review-pane-mobile.md)
