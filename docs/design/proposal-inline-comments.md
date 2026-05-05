# Inline Comments on Proposals — Design

## Summary

Extend the existing review-pane inline-comment UX to the markdown body of
**goal**, **role**, and **staff** proposal panels. Today, only documents
opened via the `review_open` tool support text-selection → comment popover →
"Send feedback as chat". Proposal panels render their main spec/prompt with
`<markdown-block>`, with no way to leave inline comments — users have to copy
quotes by hand into the chat input.

The MVP reuses everything possible from `src/ui/components/review/`:
selection-anchoring, popover, re-anchoring on content change. We change
**three** things:

1. Add a **`<commentable-markdown>`** thin wrapper around the existing
   `<review-document>`, parameterised by a stable annotation **key** and a
   pluggable **store backend**.
2. Add a small **ephemeral, in-memory** annotation store
   (`proposal-annotations.ts`) that mimics `AnnotationStore`'s read/write API
   but never hits the server.
3. Wire the wrapper into the three proposal preview panes, gated by a
   `commentable` config flag so the goal-dashboard view of the same form
   stays read-only.

No server changes. No persistence. No changes to the existing review-pane
tab UX or its REST-backed annotations.

## 1. New component shape

### Decision: thin wrapper around `<review-document>`, NOT a fork

`<review-document>` already does selection capture, mobile bottom-sheet,
re-anchoring, popover positioning, and detached-comment rendering. Forking
it would duplicate ~600 lines of fragile DOM-coupled code.

The minimum viable extraction is to **make `<review-document>`'s store
backend pluggable** (the only thing tying it to the review-pane today is
its hard-coded import of `AnnotationStore`). Everything else — selection,
popover, re-anchoring — is store-agnostic.

### Step 1 — extract a `StoreBackend` interface (in `AnnotationStore.ts`)

```ts
// New export in src/ui/components/review/AnnotationStore.ts
export interface AnnotationBackend {
  add(key: AnnotationKey, ann: ReviewAnnotation): void;
  remove(key: AnnotationKey, id: string): void;
  get(key: AnnotationKey): ReviewAnnotation[];
}
export type AnnotationKey = { sessionId: string; bucket: string };

// Default backend that wraps the existing module-level functions.
export const reviewBackend: AnnotationBackend = {
  add: (k, a) => addAnnotation(k.sessionId, k.bucket, a),
  remove: (k, id) => removeAnnotation(k.sessionId, k.bucket, id),
  get: (k) => getAnnotations(k.sessionId, k.bucket),
};
```

The existing per-`docTitle` review API is preserved unchanged
(server-persisted reviews keep working). `bucket` is just the existing
`docTitle` parameter, renamed at the abstraction boundary.

### Step 2 — `<review-document>` accepts an optional `backend` prop

Add one new property:

```ts
@property({ attribute: false }) backend: AnnotationBackend = reviewBackend;
```

Replace the four call sites that currently call `addAnnotation(...)`,
`removeAnnotation(...)`, `getAnnotations(...)` with
`this.backend.add({ sessionId: this.sessionId, bucket: this.docTitle }, ...)`
etc. Pure refactor — default behaviour identical.

### Step 3 — `<commentable-markdown>` (new file)

`src/ui/components/CommentableMarkdown.ts` — ~60 lines, no DOM logic of its
own:

```ts
@customElement("commentable-markdown")
export class CommentableMarkdown extends LitElement {
  @property({ type: String }) markdown = "";
  @property({ type: String }) sessionId = "";
  /** Stable bucket key, e.g. "proposal:goal". */
  @property({ type: String }) bucket = "";

  createRenderRoot() { return this; }   // light DOM passthrough

  render() {
    return html`<review-document
      .markdown=${this.markdown}
      .sessionId=${this.sessionId}
      .docTitle=${this.bucket}
      .backend=${proposalBackend}
      @annotation-change=${this._onChange}
    ></review-document>`;
  }

  private _onChange = () => {
    const count = proposalBackend.get({ sessionId: this.sessionId, bucket: this.bucket }).length;
    this.dispatchEvent(new CustomEvent("annotation-change", {
      detail: { count }, bubbles: true, composed: true,
    }));
  };

  /** Build & dispatch the composed feedback message, then clear local annotations. */
  sendFeedback(): string {
    const text = composeProposalFeedback(this.sessionId, this.bucket, this.markdown);
    proposalBackend.clear?.({ sessionId: this.sessionId, bucket: this.bucket });
    this.dispatchEvent(new CustomEvent("composed-feedback", {
      detail: { text }, bubbles: true, composed: true,
    }));
    return text;
  }
}
```

**Props**: `markdown`, `sessionId`, `bucket`.
**Events**: `annotation-change` (forwarded with `{count}`),
`composed-feedback` (raised by `sendFeedback()`).

`sendFeedback()` is exposed as an imperative method so the existing
"Create Goal" / "Save Role" primary buttons can call it _before_ submitting,
without an event-listener round-trip.

### Why a wrapper, not a fork

- All selection/anchoring/mobile bug fixes flow to both surfaces.
- `<review-document>` only needs **two** changes: an optional `backend` prop
  and one extra method (`clear`) on the backend interface.
- Light DOM is preserved (annotator needs direct DOM access — confirmed by
  the existing `createRenderRoot() { return this; }`).
- No CSS duplication: we keep `review-pane.css` as the single stylesheet.

## 2. Ephemeral annotation store

New file: `src/ui/components/review/proposal-annotations.ts`

```ts
import type { AnnotationBackend, AnnotationKey, ReviewAnnotation } from "./AnnotationStore.js";

// (sessionId → bucket → annotations[])
const _cache = new Map<string, Map<string, ReviewAnnotation[]>>();

function _bucketArr(k: AnnotationKey): ReviewAnnotation[] {
  let s = _cache.get(k.sessionId);
  if (!s) { s = new Map(); _cache.set(k.sessionId, s); }
  let b = s.get(k.bucket);
  if (!b) { b = []; s.set(k.bucket, b); }
  return b;
}

export const proposalBackend: AnnotationBackend & {
  clear(k: AnnotationKey): void;
  count(k: AnnotationKey): number;
} = {
  add(k, ann)    { _bucketArr(k).push(ann); },
  remove(k, id)  {
    const arr = _bucketArr(k);
    const idx = arr.findIndex(a => a.id === id);
    if (idx >= 0) arr.splice(idx, 1);
  },
  get(k)         { return [..._bucketArr(k)]; },
  clear(k)       { _cache.get(k.sessionId)?.delete(k.bucket); },
  count(k)       { return _cache.get(k.sessionId)?.get(k.bucket)?.length ?? 0; },
};

export function clearProposalAnnotations(sessionId: string, type: "goal" | "role" | "staff"): void {
  proposalBackend.clear({ sessionId, bucket: `proposal:${type}` });
}

export function composeProposalFeedback(sessionId: string, bucket: string, markdown: string): string {
  // Reuse the same shape as composeReviewFeedback but with a single bucket
  // and a friendlier section header.
  const anns = proposalBackend.get({ sessionId, bucket });
  if (anns.length === 0) return "";
  const lines: string[] = [
    `## Feedback on proposal`,
    "",
    ...anns.map(a => {
      const q = a.isCode ? `\`${a.quote}\`` : `"${a.quote}"`;
      const ln = a.start != null
        ? ` (line ${markdown.substring(0, a.start).split("\n").length})`
        : "";
      return `> ${q}${ln}\n${a.comment}`;
    }),
  ];
  return lines.join("\n\n");
}
```

### Differences vs. `AnnotationStore.ts`

| | `AnnotationStore` (existing)             | `proposalBackend` (new)         |
|-|------------------------------------------|----------------------------------|
| Persistence | REST + `sendBeacon` on unload      | None — in-memory only            |
| Hydration   | `initAnnotationStore()` on connect  | None                             |
| Submitted flag | yes (server-tracked)              | no                               |
| Keying      | `(sessionId, docTitle)`             | `(sessionId, "proposal:<type>")` |
| Lifecycle   | survives reloads until cleared      | dies with the panel / reload     |

This matches the spec: proposal annotations are ephemeral; the proposal
itself (in `state.activeProposals.<type>`) is the durable artifact.

## 3. Render integration

### 3a. Goal proposal — `renderGoalForm()` (render.ts:577)

`renderGoalForm()` is shared between the proposal panel (line 858) and the
goal dashboard view (line 1986). Comments must work **only** in the
proposal-panel call path.

Add a flag to `GoalFormConfig`:

```ts
interface GoalFormConfig {
  // …existing fields…
  /** Mount <commentable-markdown> instead of <markdown-block> in Preview mode. */
  commentable?: boolean;
}
```

Replace line 737:

```ts
${config.commentable
  ? html`<commentable-markdown
      .markdown=${config.spec || "_No spec content yet_"}
      .sessionId=${activeSessionId() || ""}
      .bucket=${"proposal:goal"}
      ${ref(goalCommentableRef)}
      @annotation-change=${(e: CustomEvent) => { _goalAnnCount = e.detail.count; renderApp(); }}
    ></commentable-markdown>`
  : html`<markdown-block .content=${config.spec || "_No spec content yet_"}></markdown-block>`
}
```

Set `commentable: true` only at the proposal-panel call site (~line 858);
leave the goal-dashboard call site (~line 1986) at the default (false).

### 3b. Role proposal — `rolePreviewPanel()` (render.ts:939)

Replace line 1122 directly (this function is only used for the active
proposal panel — no shared dashboard view):

```ts
<commentable-markdown
  .markdown=${state.rolePreviewPrompt || "_No prompt content yet_"}
  .sessionId=${activeSessionId() || ""}
  .bucket=${"proposal:role"}
  ${ref(rolePromptCommentableRef)}
  @annotation-change=${(e: CustomEvent) => { _roleAnnCount = e.detail.count; renderApp(); }}
></commentable-markdown>
```

Same gate considerations: only swap when in the **Preview** branch — Edit
mode keeps its `<textarea>`.

### 3c. Staff proposal — `staffPreviewPanel()` (render.ts:1450)

Same as role, at line 1598 with `bucket: "proposal:staff"`.

### Tool / project proposals — out of scope

Tool proposals render YAML, not markdown — no swap.
Project proposals don't have a single markdown body — no swap.
Title / name / cwd / accessory / triggers are short single-line fields —
no swap.

## 4. Send-feedback UI

### Count badge

Place it next to the Edit/Preview toggle (currently at render.ts:721 for
goal, equivalent for role/staff). Only render when count > 0 **and** mode
is Preview:

```ts
${!config.specEditMode && _goalAnnCount > 0 ? html`
  <span class="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary"
        data-testid="proposal-comment-count">
    ${_goalAnnCount} comment${_goalAnnCount === 1 ? "" : "s"}
  </span>
` : ""}
```

### "Send feedback" button

Visible only when `_goalAnnCount > 0`. Place in the same footer row as the
existing primary action ("Create Goal" / "Save Role" / etc.), to its
**left**, separated by `gap-2`:

```ts
${_goalAnnCount > 0 ? Button({
  variant: "secondary",
  onClick: () => {
    const el = goalCommentableRef.value;
    if (!el) return;
    const text = el.sendFeedback();          // composes + clears local cache
    if (text && state.remoteAgent) {
      state.remoteAgent.prompt(text);
      _goalAnnCount = 0;
      renderApp();
    }
  },
  children: html`Send feedback (${_goalAnnCount})`,
}) : ""}
```

Behaviour:

- Clicking **Send feedback** alone → submits annotations as a chat message,
  clears the local bucket, leaves the proposal panel intact (unlike the
  primary "Create Goal" which closes the panel and starts a session).
- Clicking the primary action ("Create Goal") with annotations pending →
  current behaviour is unchanged. The user is choosing to commit the
  proposal as-is; we deliberately do **NOT** auto-flush the comments. This
  matches the spec ("batch until the user explicitly sends").

### Chat-message format

`composeProposalFeedback()` produces the same shape as
`composeReviewFeedback()` minus the per-tab grouping (single bucket) and
with a `## Feedback on proposal` header. Sent via the same path the chat
input uses: `state.remoteAgent.prompt(text)` (already used by the
review-pane submit at render.ts:2515).

## 5. `proposal_update` clearing

### Hook point

In `src/app/session-manager.ts`, inside the `remote.onProposal` callback at
line 1279, just before the `state.activeProposals[type] = slot;` assignment:

```ts
// Inline-comments: a new proposal body invalidates any pending annotations
// because character offsets won't survive a rewrite. Only fires for the
// three commentable types and only on a true content change (not the
// idempotent shallow-merge re-emit).
if ((type === "goal" || type === "role" || type === "staff") && !isFirstEmit) {
  const oldBody = extractProposalBody(prev?.fields, type);
  const newBody = extractProposalBody(merged, type);
  if (oldBody !== newBody) {
    const { clearProposalAnnotations } = await import("../ui/components/review/proposal-annotations.js");
    clearProposalAnnotations(sessionId, type);
    showProposalToast("Proposal updated — comments cleared");
  }
}
```

`extractProposalBody` is a 6-line helper: returns `fields.spec` for goal,
`fields.prompt` for role/staff.

The `isFirstEmit` guard ensures we don't fire on the initial proposal
emission; the body diff suppresses the second-of-pair shallow-merge replay
(see the comment at session-manager.ts:1273 — "guarantees the second
invocation per propose_* tool-use is idempotent").

### Toast surfacing

There is **no general-purpose** toast utility in the codebase today —
`showConnectionError` is a modal, and the search-page stale-result toast is
DOM-local. Two options:

- **Option A (recommended)** — reuse the existing `<div class="review-toast">`
  CSS already in `review-pane.css:475` (auto-fade animation). Mount a
  shared `<proposal-toast>` Lit element (~30 lines) in `render.ts` near the
  proposal panel container. Trigger via a module-level
  `showProposalToast(text)` function that flips a `state.proposalToastText`
  field and clears it after 2.5s (`window.setTimeout`).
- Option B — extract a generic `<bobbit-toast>` for cross-app use. Out of
  scope for MVP; defer to follow-up.

Going with A.

## 6. Edit/Preview toggle interaction

When the user toggles Edit → the `<commentable-markdown>` is unmounted
(replaced by `<textarea>`). Highlights disappear visually. The annotation
data lives in the module-level `_cache` keyed by `(sessionId, "proposal:<type>")`,
so it survives the unmount.

When the user toggles Preview → `<commentable-markdown>` re-mounts.
`<review-document>._reanchorAnnotations()` runs on the next markdown render
and replays existing annotations from the backend. Because the underlying
markdown text didn't change between Edit→Preview (the textarea's `.value`
is two-way bound), all anchors should resolve via the
`textAtPosition === ann.quote` fast path. **No spec change needed** — this
is already how `<review-document>` handles tab switches in `<review-pane>`.

Edge case: if the user types into the textarea and then toggles back to
Preview, the markdown will have changed and re-anchoring may detach some
annotations. That's already the existing review-pane behaviour (banner
shown). Acceptable.

## 7. Dismiss clearing

The "Dismiss" button on the goal proposal is wired at render.ts ~754
(`config.onDismiss`). The role/staff equivalents are wired in their
respective `*PreviewPanel()` functions and ultimately call
`dismissProposal(sessionId, type)` (or set `state.activeProposals[type]`
to deleted, depending on path).

Add a one-liner inside whichever shared dismiss code path lives in
`session-manager.ts` (search for `dismissProposal` / "Dismiss" handlers in
the goal/role/staff dismiss flows):

```ts
clearProposalAnnotations(sessionId, type);
```

Also clear on `proposal_cleared` (already handled in the same
`onProposal` callback when `fields === null` — add the same call there).

## 8. Test plan

### Browser E2E — `tests/e2e/ui/proposal-inline-comments.spec.ts`

Pattern: import from `../gateway-harness.js`, follow the canonical
`tests/e2e/ui/settings.spec.ts` shape. Use mock-agent fixture to inject a
goal proposal.

```ts
test("inline comments on goal proposal — happy path", async ({ page, gateway }) => {
  // 1. Navigate: open a session and trigger a goal proposal via mock agent.
  await page.goto(gateway.url);
  await openMockGoalProposal(page, { spec: "First line.\nSecond line.\nThird line." });

  // 2. Switch to Preview mode (it's the default for streamed proposals).
  await page.locator('[data-testid="proposal-panel-rev"]').waitFor();

  // 3. Select "Second line" inside the spec.
  const target = page.locator("commentable-markdown .review-document-content").getByText("Second line");
  await target.evaluate((el: HTMLElement) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  // Trigger annotator's selection handler (desktop path uses createAnnotation).
  await page.dispatchEvent("commentable-markdown", "mouseup");

  // 4. Popover opens — type a comment and save.
  await page.locator("annotation-popover textarea").fill("Make this clearer");
  await page.locator("annotation-popover button[type=submit]").click();

  // 5. Count badge appears.
  await expect(page.locator('[data-testid="proposal-comment-count"]')).toHaveText("1 comment");

  // 6. Click "Send feedback".
  await page.getByRole("button", { name: /Send feedback/ }).click();

  // 7. Assert the chat transcript contains a user message with the quote + comment.
  const lastUserMsg = page.locator('message-list [data-role="user"]').last();
  await expect(lastUserMsg).toContainText('"Second line"');
  await expect(lastUserMsg).toContainText("Make this clearer");

  // 8. Badge cleared.
  await expect(page.locator('[data-testid="proposal-comment-count"]')).toHaveCount(0);
});
```

Persistence sub-test (per E2E coverage requirement):

```ts
test("annotations cleared on proposal_update", async ({ page, gateway }) => {
  // …add an annotation as above…
  // Trigger a proposal_update via mock agent (edit_proposal that rewrites spec).
  await mockEditProposal(page, { newSpec: "Completely new spec." });
  await expect(page.locator(".review-toast")).toContainText("comments cleared");
  await expect(page.locator('[data-testid="proposal-comment-count"]')).toHaveCount(0);
});
```

Reload sub-test:

```ts
test("annotations are ephemeral across reload", async ({ page, gateway }) => {
  // Add annotation, reload, assert count is 0.
  await page.reload();
  await expect(page.locator('[data-testid="proposal-comment-count"]')).toHaveCount(0);
});
```

### Unit — `tests/proposal-annotations.test.ts`

Node test runner, no DOM:

```ts
test("keying — separate buckets per (sessionId, type)", () => {
  proposalBackend.add({ sessionId: "s1", bucket: "proposal:goal" }, makeAnn());
  proposalBackend.add({ sessionId: "s1", bucket: "proposal:role" }, makeAnn());
  proposalBackend.add({ sessionId: "s2", bucket: "proposal:goal" }, makeAnn());
  assert.equal(proposalBackend.count({ sessionId: "s1", bucket: "proposal:goal" }), 1);
  assert.equal(proposalBackend.count({ sessionId: "s1", bucket: "proposal:role" }), 1);
  assert.equal(proposalBackend.count({ sessionId: "s2", bucket: "proposal:goal" }), 1);
});

test("clearProposalAnnotations targets only the named bucket", () => { … });

test("composeProposalFeedback emits a quoted-comment block per annotation", () => { … });
```

## 9. Risks / open questions

### Selection events while streaming

The proposal panel is shown live as the assistant streams. While
`state.proposalStreamingByTag[<tag>_proposal]` is true, the markdown body
mutates frequently and the user might select transiently-rendered text.
`<review-document>` already destroys+rebuilds the annotator on every
markdown change, so a mid-stream selection would simply be lost on the
next chunk.

**Mitigation**: hide the **Send feedback** button (and badge) while the
proposal is streaming. Gate via `state.proposalStreamingByTag`. The
selection itself we leave alone — annotations created mid-stream are
cleared on the next `proposal_update` anyway.

### Reuse of `<review-document>` vs. fork

Forking is tempting (the wrapper introduces a thin coupling) but rejected:
- `<review-document>` is mature; its bug-fix history would have to be
  duplicated.
- The only project-specific behaviour we need is store backend selection
  and a `clear()` op. Both are clean property/method extensions.

### Light DOM contamination

`<review-document>` uses light DOM — its CSS classes (`.review-document-content`,
`.r6o-annotation`, `.review-toast`) leak into the proposal panel's DOM tree.
The `review-pane.css` rules are scoped via these classes, so visually this
is fine, but a future selector like `[data-testid="proposal-panel"] .review-toast`
could be fragile. Acceptable for MVP.

### Edit-mode textarea

By design, comments are unavailable in Edit mode (textarea = no anchored
ranges). The badge stays visible but the **Send feedback** button is the
only action; we explicitly do **not** disable Send in Edit mode — the user
might want to send the previously-saved comments while in textarea.

### Mobile selection

Inherited as-is from `<review-document>`. The bottom-sheet popover already
works on mobile (review-pane.css defines `.review-floating-btn` etc.). Test
plan covers desktop only for MVP; manual mobile spot-check post-merge.

### Out-of-band tool-card "Open proposal"

Clicking "Open proposal" on an old tool card swaps `state.activeProposals[type]`
to an older revision (server-restore via `restoreProposalSnapshot`). This
emits a `proposal_update` event with new fields → our hook in §5 fires, body
diff is true (different text), annotations are cleared. Correct behaviour.

### Dismissed-then-restored proposals

`isProposalDismissedTyped` short-circuits the first emit when the user
dismissed an identical-fingerprint proposal. Our hook only fires on the
"second emit and onwards" branch. If a user dismisses, then re-opens via
the tool card, the slot rebuilds at `isFirstEmit = true` — annotations
were already cleared on dismiss (§7), so the panel re-mounts with an empty
bucket. Consistent.

## File changes summary

**New files:**

- `src/ui/components/CommentableMarkdown.ts` — wrapper Lit element (~60 lines).
- `src/ui/components/review/proposal-annotations.ts` — ephemeral store (~40 lines).
- `tests/e2e/ui/proposal-inline-comments.spec.ts` — happy path + clearing.
- `tests/proposal-annotations.test.ts` — keying + clearing unit tests.

**Touched files (minimal):**

- `src/ui/components/review/AnnotationStore.ts` — add `AnnotationBackend`
  interface + `reviewBackend` adapter (no behaviour change).
- `src/ui/components/review/ReviewDocument.ts` — accept optional `backend`
  prop, route ~4 store calls through it (defaults preserve existing
  behaviour).
- `src/app/render.ts` — three call-site swaps (goal/role/staff Preview),
  badge + Send-feedback button per panel, toast container.
- `src/app/session-manager.ts` — `proposal_update` clearing hook + dismiss
  clearing.
- `src/ui/index.ts` — export `<commentable-markdown>`.

No server-side changes. No new REST endpoints. No schema migration.
