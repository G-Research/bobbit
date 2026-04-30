# Design — Proposal Panel Streaming UX

Goal: while a `propose_*` tool call is being delta-streamed, every proposal panel must (1) disable its primary submit button, (2) show a clear streaming indicator, (3) preserve the user's scroll position across re-renders, and (4) preserve `<textarea>` scroll/selection across Lit `.value=` rewrites. Apply uniformly to the seven panels: `goal`, `project`, `role`, `tool`, `staff`, `workflow`, `setup`.

This document is implementation-ready. A coder can follow it without further investigation.

---

## 1. Streaming flag plumbing

### 1.1 Source of truth and ownership

**`src/app/state.ts` owns the flag.** A new field is added to the global `state` object:

```ts
/** Per-proposal-tag streaming flag. True between the first message_update
 *  delta carrying a propose_<tag> block and the matching block-finish event
 *  (described in §1.4). Keyed by the `tag` from PROPOSAL_PARSERS — i.e.
 *  "goal_proposal", "project_proposal", "role_proposal", "tool_proposal",
 *  "staff_proposal", "workflow_proposal", "setup_proposal". */
proposalStreamingByTag: {} as Record<string, boolean>,
```

**Writers** (one and only one): `RemoteAgent` (in `src/app/remote-agent.ts`) — both inside `_checkToolProposals` and inside the `case "agent_end"` / `reset()` branches.

**Readers** (passive): the seven panel render functions in `src/app/render.ts`. They use a small read-only accessor exported from `state.ts`:

```ts
// state.ts (new export)
export function isProposalStreaming(tag: string): boolean {
  return !!state.proposalStreamingByTag[tag];
}
```

Why a per-tag map rather than a single boolean:

- The seven panels can be in independent lifecycle states (e.g. a non-assistant session can hold both an active `goal_proposal` and an active `project_proposal` simultaneously — `state.activeProjectProposal` and `state.activeGoalProposal` are independent fields). A scalar would force them to share a flag.
- Lookups in render are O(1).
- Easy bulk-clear on `agent_end` / reconnect.

The complete write/read path:

```
RemoteAgent.dispatchEvent("message_update")
   └─ _checkToolProposals(message, streaming=true)
        └─ state.proposalStreamingByTag["<tag>_proposal"] = true     (writer)
        └─ callback(input, /* streaming */ true)                     (per-tag fan-out)
             └─ session-manager.ts: remote.onGoalProposal = (proposal, streaming) => {…; renderApp();}
                  └─ render.ts: renderGoalForm({ … streaming: isProposalStreaming("goal_proposal") })
                                                                      (reader)
```

### 1.2 Callback signature change

Each `on*Proposal` callback declared on `RemoteAgent` (lines ~193–205 of `remote-agent.ts`) gains an optional second parameter:

```ts
onGoalProposal?: (proposal: { … }, streaming: boolean) => void;
onRoleProposal?: (proposal: { … }, streaming: boolean) => void;
onToolProposal?: (proposal: { … }, streaming: boolean) => void;
onStaffProposal?: (proposal: { … }, streaming: boolean) => void;
onSetupProposal?: (proposal: { … }, streaming: boolean) => void;
onWorkflowProposal?: (proposal: { … }, streaming: boolean) => void;
onProjectProposal?: (fields: Record<string, unknown>, streaming: boolean) => void;
```

`src/app/proposal-parsers.ts` is updated only with a doc comment near `PROPOSAL_PARSERS`:

> Each `on*Proposal` callback now accepts a second `streaming: boolean` argument. `streaming === true` means input is still arriving; consumers must keep their `*Edited` gating intact and must not commit destructive actions on streaming-mode fires.

### 1.3 Wiring in `session-manager.ts`

Each handler signature in `session-manager.ts` (lines ~991, 1041, 1058, 1089, 1124, 1152, 1167) gains a second optional parameter:

```ts
remote.onGoalProposal = (proposal, _streaming = false) => {
  // existing body unchanged
};
```

The handler bodies do **not** change. The flag is already authoritative in `state.proposalStreamingByTag`; they just call `renderApp()` as today and the panels read from state directly. We accept the arg only so future logic (e.g. suppressing toast notifications for in-flight proposals) has a hook.

The `proposal-open` event redirect (`callbackMap[type]`, line ~1214) calls the handler with `false`:

```ts
const cb = callbackMap[type];
if (cb) cb(fields, /* streaming */ false);
```

### 1.4 When the flag flips

**Set to `true`:** inside `_checkToolProposals(message, streaming)` on the streaming-mode branch, immediately before `callback(input)` fires. Specifically:

```ts
const tagKey = `${proposalType}_proposal`;
if (streaming) {
  state.proposalStreamingByTag[tagKey] = true;
}
callback(input, streaming);
```

**Set to `false`** in three places (the union of these triggers is the lifecycle end of the streaming flag):

1. **Block-level finish — the canonical trigger.** This is the existing branch in `_checkToolProposals` where the block has been observed in non-streaming mode and is being marked processed:

   ```ts
   if (!streaming && blockId) {
     this._processedProposalIds.add(blockId);
     state.proposalStreamingByTag[`${proposalType}_proposal`] = false;
     // existing sessionStorage persist…
   }
   ```

   Wording note: this branch is reached on `case "message_end"` and on full re-scans after reconnect. Conceptually "the propose_* tool_use block's `input` is fully parsed and stable", which is exactly the design-doc requirement. Naming it the `_processedProposalIds.add(blockId)` trigger ties it to the existing dedup primitive instead of inventing a parallel concept.

2. **`agent_end` bulk-clear (safety net).** A turn that errors out, is aborted, or otherwise never reaches `message_end` for a streamed block must not leave the flag stuck on:

   ```ts
   case "agent_end": {
     this.flushDeferredMessage();
     this._state.isStreaming = false;
     this._isAborting = false;
     this._state.streamingMessage = null;
     this._state.pendingToolCalls = new Set();
     // NEW:
     for (const k of Object.keys(state.proposalStreamingByTag)) {
       state.proposalStreamingByTag[k] = false;
     }
     // … existing notification code …
   }
   ```

3. **`reset()` and session disconnect** — same bulk-clear. Required for navigation between sessions; without it, the flag from a previous session would leak into a new mount.

### 1.5 WebSocket reconnect behaviour

There are two reconnect paths in `RemoteAgent`:

- **Resume path (`{type:"resume", fromSeq}`).** Server replays missed events and dispatches them through the same event handler. If a `message_update` for an in-flight `propose_*` block is replayed, it sets the flag again — exactly the desired behaviour. If a `message_end` is replayed, the block-finish branch clears the flag. No extra logic needed.
- **Resume-gap fallback (`get_messages`).** The handler calls `_checkToolProposals(m, /* streaming */ false)` for every assistant message in the snapshot (lines ~977–981). On the server, the snapshot is taken at a stable point, so any propose_* block in it is fully parsed. Calling `_checkToolProposals` with `streaming = false` over the snapshot will hit the block-finish branch and clear any stale flag, which is the right outcome — after a snapshot resync the panel must reflect the post-stream state.

In both cases the flag converges within one event loop. The bulk-clear in §1.4(3) provides a final guarantee on hard disconnect / session change. There is no risk of a permanently-stuck `true`.

### 1.6 Cross-session isolation

`state.proposalStreamingByTag` is a singleton on the global `state` object — it is not session-scoped. Cleared on `reset()` (which fires on session switch), so navigating to another session always starts with all flags `false`. The seven proposal panels never display content from a different session than the one bound to `state.remoteAgent`, so this is correct.

---

## 2. Render layer

### 2.1 Shared helpers (new in `src/app/render.ts`)

```ts
/** Pulsing dot + "Streaming…" label rendered to the left of submit buttons. */
function streamingBadge() {
  return html`
    <span class="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
          data-testid="proposal-streaming-badge"
          aria-live="polite">
      <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>
      Streaming…
    </span>
  `;
}

/** Tailwind class fragment applied to scrollable preview/textarea regions
 *  while streaming. Pulsing left border. */
const STREAMING_BORDER = "border-l-2 border-l-primary/70 animate-pulse";
```

`animate-pulse` is already used elsewhere in `render.ts` (line ~1015 in `toolPreviewPanel`'s `statusIcon`), so no new keyframes are needed. The badge is rendered **only** when `streaming === true`, so it disappears immediately on flag clear with no transition needed.

### 2.2 `renderGoalForm` (canonical)

`GoalFormConfig` gains:

```ts
streaming?: boolean;
```

Inside the function:

- The spec **preview** container class (line ~625) — append `${config.streaming ? " " + STREAMING_BORDER : ""}` to its Tailwind class string.
- The spec **edit-mode `<textarea>`** class — same append.
- The footer button row (lines ~628–635):

  ```ts
  <div class="flex items-center justify-end gap-2">
    ${config.streaming ? streamingBadge() : ""}
    ${config.onDismiss ? Button({ variant: "ghost", onClick: config.onDismiss, children: "Dismiss" }) : ""}
    ${Button({
      variant: "default",
      onClick: config.onCreate,
      disabled: (config.createDisabled ?? !config.title.trim()) || !!config.streaming,
      children: config.saving ? "Creating…" : html`<span class="inline-flex items-center gap-1.5">${icon(GoalIcon, "sm")} Create Goal</span>`,
    })}
  </div>
  ```

Both call sites of `renderGoalForm` (`goalPreviewPanel()` ~line 715, and the inline panel at ~line 1995) read `streaming: isProposalStreaming("goal_proposal")`.

### 2.3 Panel-by-panel checklist

Each panel: read the streaming flag, decorate the scrollable container(s) with `STREAMING_BORDER`, render `streamingBadge()` immediately before the primary submit button, OR-merge `|| streaming` into the submit `disabled`. Dismiss / Done / Close ghost buttons are **not** disabled.

| # | Panel | File / line | Tag key | Submit button | Scrollable region(s) to decorate |
|---|---|---|---|---|---|
| 1 | `renderGoalForm` (`goalPreviewPanel`) | render.ts ~471 / ~715 | `goal_proposal` | Create Goal (~630) | spec preview `<div>` (~625) + spec textarea (~621) |
| 2 | `rolePreviewPanel` | render.ts ~795 | `role_proposal` | Create Role (~975) | prompt preview `<div>` (~969) + prompt textarea (~957) |
| 3 | `toolPreviewPanel` | render.ts ~989 | `tool_proposal` | View Tool (~1076) | docs preview (~1058) + renderer preview (~1067) + outer scroll wrapper (~1018) |
| 4 | `staffPreviewPanel` | render.ts ~1286 | `staff_proposal` | Create Staff (~1431) | prompt preview `<div>` (~1418) + prompt textarea (~1414) |
| 5 | `setupPreviewPanel` | render.ts ~1498 | `setup_proposal` | Save Setup (~1618) | system-prompt textarea / preview (search inside fn body for the `system_prompt` editor) |
| 6 | `workflowPreviewPanel` | render.ts ~1637 | `workflow_proposal` | Create Workflow (~1681) | the `flex-1 overflow-y-auto p-4` wrapper of `renderWorkflowEditPanel()` (~1678) |
| 7 | `projectProposalPanel` | render.ts ~1713 | `project_proposal` | Apply Changes / Accept Project (~1871) | outer `flex-1 overflow-y-auto p-5` div (~1851) |

Every panel calls the streaming flag accessor exactly once at the top:

```ts
const streaming = isProposalStreaming("<tag>_proposal");
```

### 2.4 Accessibility / theming

- `text-[11px]` matches the existing small-meta type scale.
- `aria-live="polite"` on the badge wrapper so screen readers announce the state change without interrupting.
- `bg-primary` and `border-l-primary/70` track the active theme automatically.

---

## 3. Scroll preservation

### 3.1 Where the logic lives — `src/app/follow-tail.ts` (NEW)

Decision: **factor the logic into a standalone module**. Both the markdown preview and the textarea need the same chat-scroll-lock-style invariants. Keeping the logic in one file (a) avoids subtle drift between two copies, (b) lets the unit test exercise it without DOM-attaching a Lit component, (c) hides the lock state on the element via a `WeakMap` so Lit re-renders cannot reset it.

```ts
// src/app/follow-tail.ts
//
// Scroll-preservation for elements whose content is rewritten by Lit on every
// render (proposal-panel spec preview, edit-mode textarea, etc).
//
// Mirrors docs/internals.md → "Chat scroll lock invariant":
//   - 5px stick-to-bottom tail.
//   - User intent is observed (wheel/touchstart/keydown), never inferred.
//   - Programmatic scrolls filtered via a (scrollTop, scrollHeight) latch
//     consumed exactly once.
//   - delta < 0  → update cached height, do nothing.
//   - delta == 0 → no-op (the canonical vibration-loop fix).
//   - delta > 0  → if stickToBottom, scroll to bottom; else just update cache.

interface LockState {
  stickToBottom: boolean;
  lastScrollHeight: number;
  lastProgScrollTop: number | null;
  lastProgScrollHeight: number | null;
  // Textarea-only: preserved across .value= rewrites.
  selectionStart: number;
  selectionEnd: number;
  attached: boolean;
}

// WeakMap keyed by the scroll element. When Lit detaches and re-attaches
// the same element across renders, the same WeakMap entry is reused — the
// lock state therefore persists across re-renders. When the element is
// permanently removed (panel unmounted), GC reclaims the entry: a fresh
// remount of the same panel starts with a clean {stickToBottom: true,
// lastScrollHeight: 0, …} state. This is the desired invariant.
const locks = new WeakMap<HTMLElement, LockState>();
const TAIL_PX = 5;

function ensureLock(el: HTMLElement): LockState {
  let s = locks.get(el);
  if (!s) {
    s = { stickToBottom: true, lastScrollHeight: el.scrollHeight,
          lastProgScrollTop: null, lastProgScrollHeight: null,
          selectionStart: 0, selectionEnd: 0, attached: false };
    locks.set(el, s);
  }
  if (!s.attached) {
    attachListeners(el, s);
    s.attached = true;
  }
  return s;
}

function attachListeners(el: HTMLElement, s: LockState) {
  const onScroll = () => {
    if (s.lastProgScrollTop !== null && s.lastProgScrollHeight !== null
        && el.scrollTop === s.lastProgScrollTop
        && el.scrollHeight === s.lastProgScrollHeight) {
      // Consume the programmatic-scroll echo exactly once.
      s.lastProgScrollTop = null;
      s.lastProgScrollHeight = null;
      return;
    }
    s.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_PX;
  };
  const onUserIntent = () => { s.stickToBottom = false; };
  const onKeydown = (e: KeyboardEvent) => {
    if (["PageUp","PageDown","Home","End","ArrowUp","ArrowDown"].includes(e.key)) {
      s.stickToBottom = false;
    }
  };
  const captureSelection = () => {
    if (el instanceof HTMLTextAreaElement) {
      s.selectionStart = el.selectionStart;
      s.selectionEnd = el.selectionEnd;
    }
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  el.addEventListener("wheel", onUserIntent, { passive: true });
  el.addEventListener("touchstart", onUserIntent, { passive: true });
  el.addEventListener("keydown", onKeydown);
  el.addEventListener("select", captureSelection);
  el.addEventListener("keyup", captureSelection);
  el.addEventListener("click", captureSelection);
}

/** Call AFTER content is rewritten (i.e. after Lit has flushed the new value
 *  for this element). Restores scrollTop/selection if we were tracking the
 *  tail; otherwise leaves them alone. */
export function reconcileFollowTail(el: HTMLElement | null | undefined) {
  if (!el) return;
  const s = ensureLock(el);
  const newHeight = el.scrollHeight;
  const delta = newHeight - s.lastScrollHeight;

  if (delta < 0) { s.lastScrollHeight = newHeight; return; }
  if (delta === 0) { return; } // critical: vibration-loop fix

  s.lastScrollHeight = newHeight;
  if (s.stickToBottom) {
    const target = newHeight - el.clientHeight;
    s.lastProgScrollTop = target;
    s.lastProgScrollHeight = newHeight;
    el.scrollTop = newHeight; // browser clamps to target
  }

  // Restore textarea selection across .value= rewrites.
  // Precondition: setSelectionRange only takes visible effect when the
  // textarea is the active element. We still call it unconditionally —
  // the WHATWG spec defines it as a state mutation regardless of focus,
  // so when focus returns the caret is in the right place. We swallow
  // the rare DOMException some browsers throw on detached/hidden inputs.
  if (el instanceof HTMLTextAreaElement) {
    try { el.setSelectionRange(s.selectionStart, s.selectionEnd); } catch { /* ignore */ }
  }
}

/** Optional explicit cleanup. WeakMap GC handles the common case. */
export function resetFollowTail(el: HTMLElement) {
  locks.delete(el);
}
```

### 3.2 Why `queueMicrotask` (and when `updateComplete` would be better)

The proposal panels are rendered by **plain functions returning `html\`\`` templates**, not by `LitElement` subclasses. There is no `updateComplete` Promise to await on these helpers — `updateComplete` only exists on `LitElement` instances. The seven panel functions are invoked from inside `render.ts`'s top-level render closure and the result is committed synchronously by the parent `LitElement`'s render cycle.

Two viable hook points:

1. **`queueMicrotask`** inside the panel function. Runs after the current synchronous render commits the new DOM, before paint. `scrollHeight` reflects the new content. Lightweight — no extra subscriptions.
2. **`updateComplete`** on the parent `LitElement` (the `ChatPanel` / preview-host element). Fires once per render cycle, batches all panels' reconciliations.

We pick **`queueMicrotask`** because:

- Co-locates the reconciliation with the panel that owns the ref, no plumbing through the parent.
- Runs strictly after the synchronous DOM commit (microtask queue is drained after the call stack but before the next macrotask / paint).
- Cheap — one closure per panel render.

A `ResizeObserver` would also work but adds an asynchronous tick before the first reconcile after stream-start, which is exactly the case where the user is likely to perceive a snap. Microtask is tighter.

If during implementation it turns out a panel renders inside a fragment whose `scrollHeight` isn't yet final at microtask time (some `<markdown-block>` rendering paths attach asynchronously), fall back to `requestAnimationFrame(() => reconcileFollowTail(ref.value))` for that one panel. Document the fallback in `docs/internals.md`.

### 3.3 Wiring into the seven panels

Imports at the top of `render.ts`:

```ts
import { ref, createRef } from "lit/directives/ref.js";
import { reconcileFollowTail } from "./follow-tail.js";
```

One module-scoped ref per scroll-target. Refs are singletons because at most one of each panel is mounted at a time (the assistant preview pane is not virtualised):

```ts
// Goal
const goalSpecPreviewRef = createRef<HTMLDivElement>();
const goalSpecTextareaRef = createRef<HTMLTextAreaElement>();
// Role
const rolePromptPreviewRef = createRef<HTMLDivElement>();
const rolePromptTextareaRef = createRef<HTMLTextAreaElement>();
// Tool
const toolDocsPreviewRef = createRef<HTMLDivElement>();
const toolRendererPreviewRef = createRef<HTMLDivElement>();
const toolOuterScrollRef = createRef<HTMLDivElement>();
// Staff
const staffPromptPreviewRef = createRef<HTMLDivElement>();
const staffPromptTextareaRef = createRef<HTMLTextAreaElement>();
// Setup
const setupSystemPromptRef = createRef<HTMLElement>();
// Workflow
const workflowEditWrapperRef = createRef<HTMLDivElement>();
// Project
const projectOuterScrollRef = createRef<HTMLDivElement>();
```

Per-panel template wiring (Goal shown as canonical):

```ts
${config.specEditMode
  ? html`<textarea
      ${ref(goalSpecTextareaRef)}
      class="… ${config.streaming ? STREAMING_BORDER : ''}"
      .value=${config.spec}
      @input=${config.onSpecChange}
    ></textarea>`
  : html`<div ${ref(goalSpecPreviewRef)}
              class="… ${config.streaming ? STREAMING_BORDER : ''}">
      <markdown-block .content=${config.spec || "_No spec content yet_"}></markdown-block>
    </div>`
}
```

Reconciliation, immediately before each panel function's `return`:

```ts
queueMicrotask(() => {
  reconcileFollowTail(goalSpecPreviewRef.value);
  reconcileFollowTail(goalSpecTextareaRef.value);
});
```

(With one `queueMicrotask` block per panel covering all of its refs.)

### 3.4 Compliance with the chat-scroll-lock invariant

The helper duplicates, line-for-line, the three rules from `docs/internals.md` → "Chat scroll lock invariant":

1. **Auto-scroll only on positive delta.** `delta < 0` updates cache and returns. `delta === 0` is a no-op (canonical vibration fix). `delta > 0` triggers programmatic scroll only when `stickToBottom`.
2. **Programmatic scrolls are filtered, not timed.** The `(lastProgScrollTop, lastProgScrollHeight)` latch is consumed exactly once on the matching browser-emitted echo, then cleared. No timers.
3. **User intent is observed, not inferred.** `wheel`, `touchstart`, and `keydown` listeners are the source of truth. The 5px tail is sub-pixel rounding tolerance only.

This is intentionally a duplicate of the AgentInterface logic rather than a refactor — the chat-scroll path has subtle invariants and an in-place rewrite carries unacceptable regression risk for this feature.

---

## 4. Test plan

### 4.1 Unit — `tests/follow-tail.spec.ts` (NEW)

Playwright `file://` fixture against a synthetic scroll container (a fixed-height `<div>` with overflowing children, or a mocked `HTMLElement` with `scrollTop`/`scrollHeight`/`clientHeight` getters/setters).

| Case | Setup | Assertion |
|---|---|---|
| `delta == 0 is a no-op` | Call `reconcileFollowTail` twice with no content change | `el.scrollTop` setter never called the second time (track via spy) |
| Stick-to-bottom on positive delta | Start at bottom, append content, reconcile | `scrollTop` re-pegs to `scrollHeight - clientHeight` |
| User wheel unsticks | Dispatch `wheel`, append content, reconcile | `scrollTop` unchanged |
| User touchstart unsticks | Dispatch `touchstart` | Same |
| Key-based unstick | Dispatch `keydown` for each of `PageUp/PageDown/Home/End/ArrowUp/ArrowDown` | Each unsticks |
| 5px tail tolerance | Set geometry so `scrollHeight - scrollTop - clientHeight === 4`, dispatch synthetic scroll | `stickToBottom` remains true |
| 5px tail miss | Same with `=== 6` | `stickToBottom` becomes false |
| Programmatic-scroll echo filter | Reconcile a positive delta (writes scrollTop), then dispatch a `scroll` event with matching geometry | `stickToBottom` does NOT flip |
| Programmatic latch consumed once | Same, then dispatch a second `scroll` event with the same geometry but at a non-tail position | `stickToBottom` flips correctly |
| Textarea selection preservation | Set `selectionStart=20, selectionEnd=30`, dispatch `keyup`, rewrite `.value`, reconcile | `selectionStart === 20 && selectionEnd === 30` |
| Selection capture on `select`/`keyup`/`click` | Dispatch each, with cursor at offset 50 | `selectionStart === 50` |

### 4.2 Browser E2E — `tests/e2e/ui/proposal-panel-streaming.spec.ts` (NEW)

Patterns: `tests/e2e/ui/settings.spec.ts` for navigation/persistence; `tests/e2e/ui/stories-streaming.spec.ts` for streaming simulation via mock-agent prompts.

**Mock-agent extension (in `tests/e2e/mock-agent-core.mjs`).** The existing `respondToPrompt` / `STAY_BUSY:` machinery in `tests/e2e/mock-agent-core.mjs` (around line 281) is extended to recognise a new prompt prefix `STAY_BUSY:propose_<type>:<n>` (e.g. `STAY_BUSY:propose_goal:8`). When matched, the mock emits:

1. `agent_start`.
2. `n` `message_update` events spaced 50ms apart, each carrying an assistant message whose `content` includes a single `tool_use` block with `name: "propose_<type>"` and an `input` object whose payload grows on each delta. For `propose_goal`, grow `spec` by appending one paragraph (~80 chars) per delta; keep `title` constant after the first non-trivial value to avoid spurious title-summarisation churn.
3. A final `message_end` event for the assistant message with the complete `tool_use` `input`.
4. `tool_execution_start` + `tool_execution_end` for the propose_* tool, with a synthetic success result.
5. `agent_end`.

The block `id` stays stable across all `n` `message_update` events so the existing `_processedProposalIds` dedup engages on the final `message_end`. Add the extension after the `STAY_BUSY:(\d+)` regex check; pattern: `text.match(/STAY_BUSY:propose_([a-z]+):(\d+)/)`.

**Test cases.** Sessions are created via `s.createTestSession()` like the existing streaming spec. PPS-01 / PPS-02 are parameterised over the seven proposal types; the rest target `goal` only.

| ID | Name | Steps |
|---|---|---|
| PPS-01 | Submit disabled while streaming | Send `STAY_BUSY:propose_<type>:5`. While streaming: `[data-action="primary-submit"]:disabled` is true. After `agent_end`: button enabled. |
| PPS-02 | Streaming badge visible | While streaming: `[data-testid="proposal-streaming-badge"]` visible. After `agent_end`: removed from DOM. |
| PPS-03 | scrollTop preserved on user scroll-up | Drive `propose_goal:10`. Mid-stream, `await page.locator(".goal-preview-panel [data-spec-preview]").evaluate(el => el.scrollTop = 50)` then dispatch a synthetic `wheel` event. Continue streaming. Assert `scrollTop` stays within ±2px of 50 across the next three deltas. |
| PPS-04 | Follow-tail when at bottom | Drive `propose_goal:10`. Don't scroll up. After each delta, assert `scrollHeight - scrollTop - clientHeight < 5`. |
| PPS-05 | Textarea selection preserved across deltas | Click "Edit" toggle to enter textarea mode. `el.setSelectionRange(50, 50); el.focus()`. Drive 3 more deltas. Assert `el.selectionStart === 50` after each. |
| PPS-06 | Dismiss button clickable during streaming | Drive `propose_goal:20`. Mid-stream, click Dismiss. Assert panel is removed (`[data-panel="goal-proposal"]` no longer in DOM) within 1s. |
| PPS-07 | `previewSpecEdited` wins over deltas | Click "Edit" toggle. Type "USER_EDIT_MARKER" into the textarea. Drive 3 more deltas. Assert textarea value still contains "USER_EDIT_MARKER" and does NOT match the streamed spec content. |

For PPS-01/02 across all 7 types, project's primary button is `Apply Changes / Accept Project`; tool's is `View Tool`; etc. Use a `data-testid="proposal-primary-submit"` attribute added to each panel's submit button as part of this work to make selectors uniform.

### 4.3 Existing tests preserved

- `tests/agent-interface-scroll.spec.ts` — untouched. We did not modify `AgentInterface`.
- The `delta === 0 no-op` is the canonical regression for the chat surface; `tests/follow-tail.spec.ts` adds the analogous case for proposal panels.

---

## 5. Files touched

Definitive list. Each entry is **NEW** or **MODIFIED** with no qualifiers.

| File | Status | Change |
|---|---|---|
| `src/app/follow-tail.ts` | **NEW** | `reconcileFollowTail()`, `resetFollowTail()`, module-private `WeakMap<HTMLElement, LockState>`. Mirrors chat-scroll-lock invariant. |
| `src/app/state.ts` | **MODIFIED** | Add `proposalStreamingByTag: {} as Record<string, boolean>` field. Export `isProposalStreaming(tag)` accessor. |
| `src/app/remote-agent.ts` | **MODIFIED** | (a) `on*Proposal` callback types gain `streaming: boolean` second arg. (b) `_checkToolProposals` sets `state.proposalStreamingByTag[tagKey] = true` on streaming fires; clears on the `_processedProposalIds.add(blockId)` branch. (c) `case "agent_end"` and `reset()` bulk-clear all entries. (d) Pass `streaming` through to every callback invocation. |
| `src/app/proposal-parsers.ts` | **MODIFIED** | Doc-comment only: callbacks now accept `streaming: boolean`. |
| `src/app/session-manager.ts` | **MODIFIED** | Each `remote.on*Proposal = (proposal, _streaming = false) => {…}` adds the optional second parameter; bodies unchanged. The `proposal-open` redirect at ~line 1214 passes `false` explicitly. |
| `src/app/render.ts` | **MODIFIED** | (a) Add `streamingBadge()` and `STREAMING_BORDER`. (b) Add `ref/createRef` + `reconcileFollowTail` imports and per-panel module-scoped refs. (c) Extend `GoalFormConfig` with `streaming?: boolean`. (d) In each of the 7 panel functions: read `isProposalStreaming(tag)`, OR-merge `|| streaming` into submit `disabled`, render `streamingBadge()` adjacent to submit, append `STREAMING_BORDER` to scrollable preview/textarea class, emit `queueMicrotask(() => reconcileFollowTail(ref.value))` before return. (e) Add `data-testid="proposal-primary-submit"` to each panel's primary submit button. |
| `docs/internals.md` | **MODIFIED** | Append a new subsection under the existing **"Chat surface UI invariants"** heading, titled exactly **`### Proposal panel scroll lock invariant`** (anchor: `#proposal-panel-scroll-lock-invariant`). Cross-references `src/app/follow-tail.ts` and notes the same three rules apply. Two-paragraph length. |
| `docs/debugging.md` | **MODIFIED** | Add one bullet to the keyword index: **"Proposal panel button stuck disabled / streaming badge stuck on"** — verify `agent_end` is firing for the session; the bulk-clear in `RemoteAgent`'s `agent_end` and `reset()` is the safety net. Anchor: `#proposal-panel-button-stuck-disabled--streaming-badge-stuck-on`. |
| `tests/follow-tail.spec.ts` | **NEW** | Unit tests per §4.1. |
| `tests/e2e/ui/proposal-panel-streaming.spec.ts` | **NEW** | Browser E2E per §4.2. |
| `tests/e2e/mock-agent-core.mjs` | **MODIFIED** | Extend `respondToPrompt` / streaming-driver block (around line 281) to recognise `STAY_BUSY:propose_<type>:<n>`; emit N delta-streamed `message_update` events with a single growing `propose_<type>` `tool_use` block, then `message_end` + `tool_execution_*` + `agent_end`. |

---

## 6. Backward compatibility

- **`previewTitleEdited` / `previewSpecEdited` / `rolePreviewPromptEdited` / `staffPreviewPromptEdited` / `setupFormCommandsEdited` / `setupFormSystemPromptEdited`**: unchanged. Each `on*Proposal` callback in `session-manager.ts` already gates assignments behind these flags. Streaming deltas fire the callback exactly the same way they do today; the only addition is setting/clearing `proposalStreamingByTag`. User edits during streaming therefore continue to win — verified by PPS-07.
- **Dismiss / Done / Close buttons**: explicitly NOT included in the `disabled` OR-merge. Each panel's secondary button is `variant: "ghost"` and remains clickable throughout the stream — verified by PPS-06.
- **Old / archived sessions**: `_checkToolProposals` is the single chokepoint for proposal parsing. The streaming flag's lifecycle is bounded by (a) the `_processedProposalIds.add(blockId)` branch, (b) `agent_end`, (c) `reset()`. Any of the three converges the flag to `false`; (b) and (c) are bulk-clears, so no stale entry survives a session change or hard turn-end.
- **Callback signature**: adding an optional second arg is source-compatible with every existing caller. Consumers that destructure don't exist today; if any are added later they must be aware of the new parameter (covered by the doc-comment in `proposal-parsers.ts`).
- **Server / sandbox**: no server changes. The mock-agent extension is gated behind the existing `BOBBIT_E2E=1` machinery used by `tests/e2e/mock-agent-core.mjs`.
- **WS reconnect**: handled in §1.5. Resume replays through the same handler; resume-gap fallback's snapshot re-scan calls `_checkToolProposals(m, false)` and clears any stale flag.

---

## 7. Implementation order (suggested)

Each step is independently mergeable and revertable.

1. **`src/app/follow-tail.ts` + `tests/follow-tail.spec.ts`.** No UI wiring yet. Behaviour is identical for users.
2. **State field + RemoteAgent flag plumbing + callback signature changes.** No panel render changes — UI behaviour is identical, but `state.proposalStreamingByTag` now reflects reality.
3. **Wire `streamingBadge` + `STREAMING_BORDER` + disabled-merge + refs into `renderGoalForm`.** Smoke-test manually with the goal-creation assistant flow.
4. **Repeat (3) for the six sibling panels** — `role`, `tool`, `staff`, `setup`, `workflow`, `project`.
5. **Add the mock-agent extension and the E2E spec** — `tests/e2e/mock-agent-core.mjs` then `tests/e2e/ui/proposal-panel-streaming.spec.ts`.
6. **Update `docs/internals.md` and `docs/debugging.md`** with the anchors specified in §5.
