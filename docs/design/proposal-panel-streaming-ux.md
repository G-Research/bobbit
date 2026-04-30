# Design — Proposal Panel Streaming UX

Goal: while a `propose_*` tool call is being delta-streamed, every proposal panel must (1) disable its primary submit button, (2) show a clear streaming indicator, (3) preserve the user's scroll position across re-renders, and (4) preserve `<textarea>` scroll/selection across Lit `.value=` rewrites. Apply uniformly to the seven panels: `goal`, `project`, `role`, `tool`, `staff`, `workflow`, `setup`.

This document is implementation-ready. A coder can follow it without further investigation.

---

## 1. Streaming flag plumbing

### 1.1 Source of truth: `RemoteAgent._checkToolProposals`

Today (`src/app/remote-agent.ts`) the method is called from two places:

- `message_update` — passes `streaming = true`. Fires the callback on every delta, does NOT mark the block as processed.
- `message_end` (and full re-scans) — passes `streaming = false`. Fires the callback once with the final input and marks the block as processed via `_processedProposalIds`.

We extend the callback signature with the streaming flag. The flag flows from `_checkToolProposals` straight into the per-type `on*Proposal` callbacks; each callback writes a single state field that all proposal panels read.

### 1.2 New state field

`src/app/state.ts`, alongside the other proposal-panel preview fields:

```ts
/** Per-proposal-tag streaming flag. True between the first message_update
 *  delta carrying a propose_<tag> block and the matching message_end /
 *  agent_end / processed-mark. Keyed by the proposal `tag` from
 *  PROPOSAL_PARSERS (e.g. "goal_proposal", "project_proposal"). */
proposalStreamingByTag: {} as Record<string, boolean>,
```

Why a per-tag map rather than a single boolean:

- The seven panels can theoretically be in different lifecycle states (e.g. a non-assistant session can hold both an active `goal_proposal` and an `active_project_proposal` simultaneously — `state.activeProjectProposal` and `state.activeGoalProposal` are independent). A scalar would force them to share a flag.
- Lookups in render are O(1): `state.proposalStreamingByTag["goal_proposal"]`.
- Easy to clear in bulk: on `agent_end` we reset the whole map.

A small accessor helper makes panels read cleaner:

```ts
// state.ts (new export)
export function isProposalStreaming(tag: string): boolean {
  return !!state.proposalStreamingByTag[tag];
}
```

### 1.3 Callback signature change

`src/app/proposal-parsers.ts` — types-only callout (the parser table itself doesn't change). Document the new signature in a comment near `PROPOSAL_PARSERS`:

> Each `on*Proposal` callback now accepts a second `streaming: boolean` argument. Implementations should treat `streaming === true` as "input is still arriving — do not commit destructive actions, but DO update preview state subject to `*Edited` flags".

`src/app/remote-agent.ts` — update the `on*Proposal` declared types from

```ts
onGoalProposal?: (proposal: { ... }) => void;
```

to

```ts
onGoalProposal?: (proposal: { ... }, streaming: boolean) => void;
```

…and identically for `onRoleProposal`, `onToolProposal`, `onStaffProposal`, `onSetupProposal`, `onWorkflowProposal`, `onProjectProposal`.

### 1.4 Where the flag is set / cleared

All transitions live inside `RemoteAgent` so panels never have to subscribe to lifecycle events directly.

**Set to `true`:** in `_checkToolProposals(message, streaming)`, when `streaming === true` and we are about to fire a callback for `proposalType`:

```ts
if (streaming) {
  const tagKey = `${proposalType}_proposal`; // matches PROPOSAL_PARSERS.tag
  if (!state.proposalStreamingByTag[tagKey]) {
    state.proposalStreamingByTag[tagKey] = true;
  }
}
callback(input, streaming);
```

(Use the imported `state` from `./state.js` — `RemoteAgent` already imports from app state for other purposes; if not, add the import. We deliberately mutate the global state field rather than thread the flag through `state_update` events, because all consumers already re-render on the existing `renderApp()` call inside each `on*Proposal` callback.)

**Set to `false`:** in three places, using a single helper `_clearProposalStreaming(tag)`:

1. **Block-level finish** — in `_checkToolProposals`, when `streaming === false` AND the block was just marked processed (`!streaming && blockId` branch):

   ```ts
   if (!streaming && blockId) {
     this._processedProposalIds.add(blockId);
     state.proposalStreamingByTag[`${proposalType}_proposal`] = false;
     // ... existing sessionStorage persist ...
   }
   ```

2. **`agent_end`** — in the `case "agent_end"` block of the event dispatcher, after the existing `flushDeferredMessage()` / cleanup, clear *all* tags:

   ```ts
   for (const k of Object.keys(state.proposalStreamingByTag)) {
     state.proposalStreamingByTag[k] = false;
   }
   ```

   This is the safety net for an aborted turn that never reaches `message_end`.

3. **`reset()` / session disconnect** — same bulk-clear.

We do NOT additionally key on `block.id`. The `_processedProposalIds` set already gives us per-block dedupe; tag-level streaming is enough for UX because two concurrent `propose_goal` blocks in one turn is not a real-world case (and if it ever happens, the flag stays `true` until the last one finishes — correct).

### 1.5 Wiring in `session-manager.ts`

Each `on*Proposal` callback (lines ~991, 1041, 1058, 1089, 1124, 1152, 1167) takes the new `streaming` argument and forwards `renderApp()` regardless. Existing `*Edited`-gated assignments still happen on every fire so the preview keeps updating mid-stream. No semantic change beyond the new arg — the callbacks already run on every delta.

The redirected callback in the `proposal-open` event handler (`callbackMap[type]`, ~line 1214) also forwards the flag (or passes `false` for direct invocation):

```ts
const cb = callbackMap[type];
if (cb) cb(fields, /* streaming */ false);
```

---

## 2. Render layer

### 2.1 New shared streaming-indicator helper

Add to `src/app/render.ts` (top, near other shared helpers):

```ts
/** Pulsing dot + "Streaming…" label rendered to the left of submit buttons. */
function streamingBadge() {
  return html`
    <span class="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground" data-testid="proposal-streaming-badge">
      <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>
      Streaming…
    </span>
  `;
}

/** Tailwind class fragment applied to the spec/preview container while streaming.
 *  Pulsing left border. */
const STREAMING_BORDER = "border-l-2 border-l-primary/70 animate-pulse";
```

`animate-pulse` is part of the existing Tailwind config (used elsewhere in `render.ts` line ~1015).

### 2.2 `renderGoalForm` — adapted

Add `streaming?: boolean` to `GoalFormConfig`. Inside the function:

- The spec preview/textarea container already has `class="flex-1 min-h-[200px] p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm"`. Append `${config.streaming ? STREAMING_BORDER : ""}` to that class string. Apply identically to the edit-mode `<textarea>` class.
- Footer: insert `${config.streaming ? streamingBadge() : ""}` immediately before the Create Goal `Button(...)`.
- Submit button: change

  ```ts
  disabled: config.createDisabled ?? !config.title.trim(),
  ```

  to

  ```ts
  disabled: (config.createDisabled ?? !config.title.trim()) || !!config.streaming,
  ```

- Caller `goalPreviewPanel()` passes `streaming: isProposalStreaming("goal_proposal")`. The other call site (`renderGoalForm` for non-assistant inline panels around line 1995) does the same.

### 2.3 Sibling proposal panels

For each of the six other panels, the change is mechanical: read the streaming flag once at the top, decorate spec/prompt container with `STREAMING_BORDER`, render `streamingBadge()` next to the primary submit, OR-merge `|| streaming` into the submit's `disabled`. The Dismiss/Done/Close ghost button is NOT disabled.

| Panel | File location | Tag key | Submit button | Preview container |
|---|---|---|---|---|
| `rolePreviewPanel` | render.ts ~795 | `role_proposal` | Create Role (~975) | System Prompt textarea/preview (~944, ~969) |
| `toolPreviewPanel` | render.ts ~989 | `tool_proposal` | View Tool (~1076) | docs preview / renderer preview (~1058, ~1067) |
| `staffPreviewPanel` | render.ts ~1286 | `staff_proposal` | Create Staff (~1431) | System Prompt textarea/preview (~1414, ~1418) |
| `setupPreviewPanel` | render.ts ~1498 | `setup_proposal` | Save Setup (~1618) | system-prompt textarea (search inside fn) |
| `workflowPreviewPanel` | render.ts ~1637 | `workflow_proposal` | Create Workflow (~1681) | workflow editor wrapper (~1678) |
| `projectProposalPanel` | render.ts ~1713 | `project_proposal` | Apply Changes / Accept Project (~1871) | the inputs scroll container (~1851 `overflow-y-auto p-5`) |

For `projectProposalPanel`, decorate the outer scroll container with `STREAMING_BORDER`, and OR-merge `|| streaming` into `acceptDisabled`.

For `workflowPreviewPanel`, the editor body is rendered by `renderWorkflowEditPanel()` (separate module). Apply the streaming border to its wrapping `<div class="flex-1 overflow-y-auto p-4">` only.

### 2.4 Tailwind / accessibility notes

- `animate-pulse` is the canonical pulse animation already used by the tool-checklist in-progress indicator (`render.ts` line 1015) — no new keyframes needed.
- The badge uses `text-[11px]` to match the small-meta type scale already in panels.
- Add `aria-live="polite"` to the badge wrapper if accessibility is a follow-up; not required for this fix.

---

## 3. Scroll preservation

Two distinct cases share one helper.

### 3.1 The shared helper: `src/app/follow-tail.ts`

Decision: **factor it out**. The textarea and the markdown preview have similar invariants (preserve scrollTop, follow the tail when at the bottom), and the chat-scroll-lock pattern has already proven that lock-state lives outside the rendered tree. A standalone module hangs lock state on the element via a `WeakMap`, so Lit re-renders that swap children inside the wrapper don't reset it.

```ts
// src/app/follow-tail.ts
//
// Scroll-preservation for elements whose content is rewritten by Lit on every
// render (proposal-panel spec preview, edit-mode textarea, etc).
//
// Mirrors the chat-scroll-lock invariant from AgentInterface
// (docs/internals.md "Chat scroll lock invariant"):
//   - 5px stick-to-bottom tail.
//   - User intent is observed (wheel/touchstart/keydown) — never inferred
//     from geometry.
//   - Programmatic scrolls are filtered via a (scrollTop, scrollHeight) latch
//     consumed exactly once by the next scroll event.
//   - delta < 0  → update cached height, do nothing.
//   - delta == 0 → no-op (the canonical vibration-loop fix).
//   - delta > 0  → if stickToBottom, scroll to bottom; else just update cache.

interface LockState {
  stickToBottom: boolean;
  lastScrollHeight: number;
  lastProgScrollTop: number | null;
  lastProgScrollHeight: number | null;
  // For textareas: preserved across .value= rewrites.
  selectionStart: number;
  selectionEnd: number;
}

const locks = new WeakMap<HTMLElement, LockState>();
const TAIL_PX = 5;

function ensureLock(el: HTMLElement): LockState {
  let s = locks.get(el);
  if (!s) {
    s = { stickToBottom: true, lastScrollHeight: el.scrollHeight,
          lastProgScrollTop: null, lastProgScrollHeight: null,
          selectionStart: 0, selectionEnd: 0 };
    locks.set(el, s);
    attachListeners(el, s);
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
  el.addEventListener("scroll", onScroll, { passive: true });
  el.addEventListener("wheel", onUserIntent, { passive: true });
  el.addEventListener("touchstart", onUserIntent, { passive: true });
  el.addEventListener("keydown", onKeydown);
  // Also capture selection for textareas so .value= rewrite doesn't reset it.
  el.addEventListener("select", () => {
    if (el instanceof HTMLTextAreaElement) {
      s.selectionStart = el.selectionStart;
      s.selectionEnd = el.selectionEnd;
    }
  });
  el.addEventListener("keyup", () => {
    if (el instanceof HTMLTextAreaElement) {
      s.selectionStart = el.selectionStart;
      s.selectionEnd = el.selectionEnd;
    }
  });
  el.addEventListener("click", () => {
    if (el instanceof HTMLTextAreaElement) {
      s.selectionStart = el.selectionStart;
      s.selectionEnd = el.selectionEnd;
    }
  });
}

/** Call from a Lit `${ref(...)}` directive or from `firstUpdated`/`updated`.
 *  Run AFTER content is rewritten (i.e. after Lit has flushed the new value).
 *  Restores scrollTop/selection if we were tracking the tail; otherwise leaves
 *  them alone. */
export function reconcileFollowTail(el: HTMLElement | null | undefined) {
  if (!el) return;
  const s = ensureLock(el);
  const newHeight = el.scrollHeight;
  const delta = newHeight - s.lastScrollHeight;

  if (delta < 0) { s.lastScrollHeight = newHeight; return; }
  if (delta === 0) { return; } // critical: no-op (vibration fix)

  // delta > 0
  s.lastScrollHeight = newHeight;
  if (s.stickToBottom) {
    const target = newHeight - el.clientHeight;
    s.lastProgScrollTop = target;
    s.lastProgScrollHeight = newHeight;
    el.scrollTop = newHeight; // clamps to target
  }

  // Restore textarea selection across .value= rewrites.
  if (el instanceof HTMLTextAreaElement) {
    try { el.setSelectionRange(s.selectionStart, s.selectionEnd); } catch {}
  }
}

/** Reset on disconnect. Optional — WeakMap will GC when the element is
 *  removed, but tests may want explicit cleanup. */
export function resetFollowTail(el: HTMLElement) {
  locks.delete(el);
}
```

### 3.2 Wiring into `renderGoalForm` and siblings

Lit's `ref` directive is the cleanest hook. Import `ref, createRef` from `lit/directives/ref.js`. Each panel that has a streaming-affected scrollable region declares a module-scoped ref:

```ts
// near top of render.ts
import { ref, createRef } from "lit/directives/ref.js";
import { reconcileFollowTail } from "./follow-tail.js";

const goalSpecPreviewRef = createRef<HTMLDivElement>();
const goalSpecTextareaRef = createRef<HTMLTextAreaElement>();
// ... one pair per panel as needed ...
```

Applied in the template:

```ts
${config.specEditMode
  ? html`<textarea
      ${ref(goalSpecTextareaRef)}
      class="... ${config.streaming ? STREAMING_BORDER : ''}"
      .value=${config.spec}
      @input=${config.onSpecChange}
    ></textarea>`
  : html`<div ${ref(goalSpecPreviewRef)} class="... ${config.streaming ? STREAMING_BORDER : ''}">
      <markdown-block .content=${config.spec || "_No spec content yet_"}></markdown-block>
    </div>`
}
```

Then, after each render, call the helper. The simplest way (no Lit lifecycle hooks at the function-template level) is to schedule reconciliation via `queueMicrotask` from inside `renderGoalForm`:

```ts
queueMicrotask(() => {
  reconcileFollowTail(goalSpecPreviewRef.value);
  reconcileFollowTail(goalSpecTextareaRef.value);
});
```

`queueMicrotask` runs after Lit has committed the DOM update for the synchronous render, before the next paint, so `scrollHeight` reflects the new content.

Refs are module-scoped (singletons): there is at most one of each panel mounted at a time, so a singleton ref per scroll-target is correct and avoids accumulating WeakMap entries on detached elements (the `resetFollowTail` is therefore optional).

### 3.3 Apply to all 7 panels

Each preview-form panel needs:

- One ref for the preview/markdown container (always present).
- One ref for the edit-mode textarea (only `goal`, `role`, `staff`, `setup` have edit-mode toggles; `tool` and `workflow` have rich editors managed elsewhere; `project` is plain inputs — no large rolling content there, but the outer scroll div IS reconciled because it scrolls when many fields stream in).

Per panel:

| Panel | Refs |
|---|---|
| Goal | spec preview div, spec textarea |
| Role | prompt preview div, prompt textarea |
| Tool | docs preview div, renderer preview div |
| Staff | prompt preview div, prompt textarea |
| Setup | system-prompt preview div, system-prompt textarea (whatever exists) |
| Workflow | the `flex-1 overflow-y-auto p-4` wrapper of `renderWorkflowEditPanel()` |
| Project | the outer `flex-1 overflow-y-auto p-5` div |

Each panel calls `queueMicrotask(() => { reconcileFollowTail(refA.value); reconcileFollowTail(refB.value); })` at the end of the function, before `return html\`...\``.

### 3.4 Why this satisfies the chat-scroll-lock invariant

The helper duplicates the exact three rules from `docs/internals.md` "Chat scroll lock invariant":

1. Auto-scroll only on positive delta — the `delta < 0` branch returns early; `delta === 0` is a no-op (the vibration fix).
2. Programmatic scrolls are filtered via a `(scrollTop, scrollHeight)` latch — consumed exactly once, no timers.
3. User intent is observed via `wheel` / `touchstart` / `keydown` — never inferred from geometry. 5px tail is tolerance only.

This is intentionally a copy rather than abstracted: `AgentInterface`'s scroll path has subtle invariants and we don't want to risk regressing it. We will add a brief paragraph to `docs/internals.md` cross-referencing the new module.

---

## 4. Test plan

### 4.1 Unit — `tests/follow-tail.spec.ts` (new, Playwright file:// fixture)

Verifies the helper in isolation against a synthetic scroll container. Cases:

- **delta == 0 is a no-op** — call helper twice with no content change; assert no programmatic scroll happened (track via `Object.defineProperty(el, "scrollTop", { set })` spy).
- **Stick-to-bottom on positive delta** — start at bottom, append content, helper moves `scrollTop` to bottom.
- **User intent unsticks** — dispatch `wheel`, append content, helper does NOT move `scrollTop`.
- **5px tail tolerance** — at `scrollHeight - scrollTop - clientHeight === 4`, still considered at-tail.
- **Programmatic-scroll echo filter** — after a programmatic write, the synthetic `scroll` event with matching geometry must NOT flip `stickToBottom`.
- **Textarea selection preservation** — set `selectionStart/End`, rewrite `.value`, call helper, selection restored.
- **`PageUp` keydown** unsticks; arrow keys, Home, End unstick.

### 4.2 Browser E2E — `tests/e2e/ui/proposal-panel-streaming.spec.ts` (new)

Patterns: `tests/e2e/ui/settings.spec.ts` for navigation/persistence; `tests/e2e/ui/stories-streaming.spec.ts` for streaming simulation via the `replay-buffered-events` test endpoint.

We need a deterministic streamed `propose_goal` block. Two viable options — pick the simpler:

1. **Mock-agent-driven** — extend the mock agent (under `tests/mock-agents/`) with a prompt keyword (e.g. `STAY_BUSY:propose_goal`) that emits N `message_update` events, each with an incrementally-larger `propose_goal` `tool_use` block (input arg `spec` growing one paragraph per delta), then a final `message_end`. Recommended; mirrors the existing `STAY_BUSY:` pattern in `tests/e2e/ui/stories-streaming.spec.ts`.

2. **Replay-based** — capture the buffered events for a real run, then re-broadcast via the `replay-buffered-events` endpoint. Less deterministic.

Test cases in the spec file:

- **PPS-01: button disabled while streaming** — start the streamed-proposal flow, assert the goal-preview panel's Create Goal button is `disabled`. After `agent_end` arrives, assert it becomes enabled (and `streamingBadge` disappears).
- **PPS-02: streaming badge visible** — `[data-testid="proposal-streaming-badge"]` is visible during streaming, removed after `agent_end`.
- **PPS-03: scrollTop preserved on user scroll-up** — between deltas, simulate a `wheel` scroll up by 100px on the spec preview, then keep streaming; assert `scrollTop` does not snap back.
- **PPS-04: follow-tail when at bottom** — start at bottom of preview; on each delta `scrollTop` re-pegs to `scrollHeight - clientHeight` (within 5px).
- **PPS-05: textarea selection preserved across deltas** — switch to Edit mode, place caret at offset 50, drive a delta; assert `selectionStart === 50`.
- **PPS-06: dismiss button stays clickable during streaming** — click Dismiss while streaming, panel closes.
- **PPS-07: `previewSpecEdited` still wins over deltas** — type into the textarea (sets `previewSpecEdited=true`), drive more deltas, assert the textarea content reflects the user's edit, not the streamed value.

We add the spec to all 7 proposal types only at the smoke level: PPS-01 + PPS-02 are parameterized over `[goal, project, role, tool, staff, workflow, setup]` driven by their respective `propose_*` mock-agent prompts. PPS-03 through PPS-07 run only against `goal` (canonical, biggest spec field).

### 4.3 Existing test invariants preserved

- `tests/agent-interface-scroll.spec.ts` — untouched (we did not modify `AgentInterface`).
- The `delta === 0 no-op` test for `AgentInterface` is the canonical regression for the chat surface; we add the analogous case in `follow-tail.spec.ts` for proposal panels.

---

## 5. Files touched

| File | Change |
|---|---|
| `src/app/follow-tail.ts` | **NEW.** `reconcileFollowTail()` helper, `resetFollowTail()`, lock state in module-private `WeakMap`. Mirrors chat-scroll-lock invariant. |
| `src/app/state.ts` | Add `proposalStreamingByTag: {} as Record<string, boolean>`. Export `isProposalStreaming(tag)` helper. |
| `src/app/remote-agent.ts` | (a) Update `on*Proposal` callback type signatures to `(p, streaming) => void`. (b) In `_checkToolProposals`, set `state.proposalStreamingByTag[tagKey] = true` on streaming fires; clear on the `_processedProposalIds.add(blockId)` branch. (c) In `case "agent_end"` (and `reset()`), clear all entries in the map. (d) Pass `streaming` arg through to every callback invocation. |
| `src/app/proposal-parsers.ts` | Doc-comment only: callbacks now accept a second `streaming` arg. |
| `src/app/session-manager.ts` | Each `remote.on*Proposal = (proposal, streaming?) => { ... }` adds the optional second parameter; handlers don't change behaviour but forward through `renderApp()`. The redirect in the `proposal-open` event handler passes `false`. |
| `src/app/render.ts` | (a) Add `streamingBadge()` and `STREAMING_BORDER` constant. (b) Add module-scoped `createRef`/`ref` imports and per-panel refs. (c) Extend `GoalFormConfig` with `streaming?: boolean`. (d) In each of the 7 panel functions (`renderGoalForm`, `rolePreviewPanel`, `toolPreviewPanel`, `staffPreviewPanel`, `setupPreviewPanel`, `workflowPreviewPanel`, `projectProposalPanel`): read `isProposalStreaming(tag)`; OR-merge `|| streaming` into submit `disabled`; render `streamingBadge()` next to submit; append `STREAMING_BORDER` to scrollable preview/textarea class; emit `queueMicrotask(() => reconcileFollowTail(ref.value))` before return. |
| `docs/internals.md` | Append a short subsection under "Chat surface UI invariants" titled **Proposal panel scroll-lock invariant**, cross-referencing `follow-tail.ts` and noting the same three rules apply. |
| `docs/debugging.md` | Add a one-line entry: "Proposal panel button stuck disabled / streaming badge stuck on — verify `agent_end` is firing; the bulk-clear in `RemoteAgent` is the safety net". |
| `tests/follow-tail.spec.ts` | **NEW.** Unit tests for the helper (see §4.1). |
| `tests/e2e/ui/proposal-panel-streaming.spec.ts` | **NEW.** Browser E2E (see §4.2). |
| `tests/mock-agents/<existing>` | Extend mock agent to recognise a `STAY_BUSY:propose_<type>` keyword that emits incrementally-growing `propose_*` `tool_use` blocks across N `message_update` events. (Specific file to be picked by the implementer; pattern documented in `tests/e2e/ui/stories-streaming.spec.ts` for `STAY_BUSY:`.) |

---

## 6. Backward compatibility

- **`previewTitleEdited` / `previewSpecEdited` (and equivalents for role, staff, etc.)** — unchanged. Each `on*Proposal` callback in `session-manager.ts` already gates assignments behind these flags. Streaming deltas fire the callback exactly the same way they do today; the only addition is setting/clearing `proposalStreamingByTag`. User edits during streaming therefore continue to win.
- **Dismiss button** — explicitly NOT included in the `disabled` OR-merge. Each panel's Dismiss/Done/Close button is rendered with `variant: "ghost"` and no streaming check, so it stays clickable throughout the stream.
- **Old sessions / replayed events** — `_checkToolProposals` is the single chokepoint for proposal parsing. The streaming flag's lifecycle is bounded by `agent_end` and the bulk-clear in `reset()`, so a navigation away from a session always starts fresh.
- **Callback signature** — adding an optional second arg is source-compatible with any existing caller that ignores it. Consumers that destructure (none today) would still match.
- **Sandbox / E2E mode** — no server changes. The mock-agent extension is gated under `BOBBIT_E2E=1` consistent with existing `STAY_BUSY:` machinery.

---

## 7. Implementation order (suggested)

1. Land `src/app/follow-tail.ts` + `tests/follow-tail.spec.ts` (no UI wiring yet).
2. Land state field + `RemoteAgent` flag plumbing + callback signature changes (no panel render changes yet — UI behaviour is identical).
3. Wire `streamingBadge` + `STREAMING_BORDER` + disabled-merge + refs into `renderGoalForm`. Smoke-test manually.
4. Repeat (3) for the six sibling panels.
5. Add E2E spec, including the mock-agent `STAY_BUSY:propose_*` extension.
6. Update `docs/internals.md` and `docs/debugging.md`.

Each step is independently revertable.
