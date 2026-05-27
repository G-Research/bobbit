# Chat scroll controls

The chat transcript has floating buttons at the top and bottom of the viewport that help users navigate long, streaming conversations without having to fish through the scrollback by hand. The top button walks backwards through earlier user prompts; the bottom button returns to the tail (or, while walking history, also walks forwards one prompt at a time).

| Button | Position | Appears when | Click action |
|---|---|---|---|
| **Jump to bottom** (`↓`) | bottom-centre | viewport has drifted more than half a screen above the bottom, **or** the user is parked on a historical prompt | spring-animates to the tail; clears any history-nav state and re-pins follow-mode |
| **Jump to last prompt** (`↑`) | top-centre | at least one user prompt exists, the most recent one has scrolled fully above the viewport, **and** the user is not already walking history | spring-animates the last user message to ~16 px below the top of the viewport, and begins history-nav |
| **Jump to previous prompt** (`↑`) | top-centre — same slot as above | the user is walking history and there is an older prompt above the parked one | spring-animates the next-older user message to the same top position; advances one step deeper into history |
| **Next prompt** \| **Bottom** (split pill) | bottom-centre — replaces single bottom button | history-nav is at least two steps deep (the parked prompt is not the most recent one) | left half walks forward one prompt; right half jumps to the tail and exits history-nav |

## Why these controls

The transcript is a streaming conversation that can grow indefinitely while the user reads earlier content. The controls cover the three "where am I?" recoveries the user actually needs:

- **"Take me back to live."** Jump-to-bottom returns the viewport to the tail so streaming tool output is visible again, and re-engages the tail-chat lock so the page tracks new content.
- **"Take me back to what I just asked."** A long agent response — model thinking, multiple tool calls with expanded output, generated code — can easily push the prompt that started the turn many screens above the viewport. Scroll-fishing for the original question is fiddly, especially on mobile. Jump-to-last-prompt is a one-tap fix that re-anchors the reader at the start of the *current* turn.
- **"Show me the previous turn… and the one before that."** Once the user has jumped back to the most recent prompt, repeated clicks should walk further back through the conversation one turn at a time — without forcing them to scroll-fish past long agent responses they've already read. This is what makes the up button a *navigator* rather than a single shortcut. The split bottom button is its mirror: once you've stepped back, you need a symmetric way to step forward again, plus a fast way back to live.

## History-nav state

Progressive history walking is driven by a single piece of derived state on the chat surface: the index of the user prompt the up button currently "points at" — the prompt the user is parked on. `null` means "not walking history"; an integer `N` means "the Nth user-message is at the top of the viewport, and the next ↑ click goes to N-1".

This index is intentionally derived, not persisted — it doesn't survive a session navigate, a reload, or any return to the tail. Three reasons:

- A new prompt invalidates any "depth from the end" interpretation; persisting it would either mean re-anchoring against the new last prompt (surprising) or pointing at a now-stale absolute index (also surprising).
- The contract "return to the tail and you're back in live-follow mode" is simpler to reason about if there is no hidden walk-cursor that survives.
- Cross-session walking has no obvious meaning — different transcripts, different prompts.

## Visibility rules

All three controls are pure functions of scroll geometry plus the history-nav index, recomputed on every scroll event, resize, and transcript mutation. They never linger after the condition that justifies them goes away.

**Jump to bottom** appears when `distance-from-bottom > 0.5 × clientHeight` **and** either `!_isAtBottom` (the user has escaped the tail) or history-nav is active. The half-viewport threshold is deliberately wider than the 70 px near-bottom band that auto-relocks the tail, so the button only shows when the user has clearly committed to scrolling away. See [internals.md — Chat scroll lock invariant](internals.md#chat-scroll-lock-invariant) for the full state machine and the rules around `_isAtBottom` / `_escapedFromLock`.

The history-nav clause is a deliberate spec change from PR #639: walking back through prompts now reveals the bottom button so the user can return to live with one click, even though the click that started history-nav was programmatic and did *not* flip `_escapedFromLock`. This matches the user's mental model — "I deliberately scrolled away from live, give me a way back".

**Up button (last / previous prompt)** appears when there is at least one `<user-message>` in the transcript, **and** at least one of:

- We are *not* walking history yet, **and** the bottom edge of the most-recent `<user-message>` is above the top edge of the scroll viewport (a 1 px epsilon avoids sub-pixel flicker). Label reads **"Jump to last prompt"**.
- We *are* walking history **and** the parked prompt is not the oldest one (`index > 0`). Label reads **"Jump to previous prompt"**.

It is hidden when:

- No user messages exist yet (a freshly opened session).
- The user is not walking history and the most-recent prompt is partially or fully in view, **or** has been scrolled past so that it is below the viewport (e.g. browsing earlier history) — in that case the prompt is "in front of" the user already; jumping back to it would be disorienting.
- The user is walking history and is parked on the oldest prompt (no older prompt to go to).

**Split bottom pill ("Next prompt | Bottom")** replaces the single jump-to-bottom button when history-nav is at depth ≥ 2 — i.e. the parked prompt is not the most recent one. The visibility of the split pill as a whole follows the same `geoFar` test as the single bottom button. At depth 1 (parked on the most-recent prompt) the bottom button reverts to the unsplit jump-to-bottom — there is nothing to walk forward to, so the split would be a dead half. Sending a new prompt also collapses the split back, because the new last prompt becomes the natural "forward" target and the user immediately exits history-nav (see reset rules below).

Sending a new prompt synchronously clears history-nav state and re-runs the visibility computation: the new `<user-message>` is now the last one and lives at the bottom of the transcript, so the up button hides and the bottom button collapses to its single form (and itself hides once `_isAtBottom` re-engages).

## Reset rules for history-nav

The history-nav index returns to `null` (exiting history-nav and reverting all controls to their default labels and layout) whenever any of the following happens:

- **A new user prompt is sent.** The transcript's user-message count grows, the next visibility recompute notices, and clears the index.
- **The user reaches the tail by any means.** That includes a jump-to-bottom click (single or the split's right half), a programmatic scroll-to-bottom, or the near-bottom auto-relock band kicking in after the user wheels down into the bottom 70 px.
- **Session navigate / respawn / transcript reset.** Mirrors the existing cleanup of `_showJumpToBottom` and `_showJumpToLastPrompt` so a freshly loaded transcript never inherits a stale walk-cursor.
- **The user wheels / touches / arrow-keys away from the parked prompt** such that it is either scrolled fully above the viewport, or more than 200 px below the top of the scroll container. The 200 px tolerance prevents the spring-landing itself from looking like "the user scrolled away" while still releasing nav promptly once a real gesture moves the viewport.

The gesture-driven reset is gated on the deferred scroll handler's gesture-freshness classification and on the programmatic-scroll echo latch being clear, so the spring animation that just landed the user on the parked prompt cannot trigger its own reset.

## Click behaviour

**Jump to bottom** (single or split-right) runs the spring rAF loop (`damping 0.7, stiffness 0.05, mass 1.25`) until the viewport lands within sub-pixel tolerance of `scrollHeight - clientHeight`. The target is re-read every tick so content that arrives during the animation moves the goalpost. The click clears `_escapedFromLock` and re-pins `_isAtBottom = true`, and clears history-nav, so subsequent content keeps the viewport at the tail.

**Up button (Jump to last / previous prompt)** computes a target `scrollTop` such that the top of the target `<user-message>` lands ~16 px below the top of the scroll container (matching the button's own top offset, so the button is "replaced" by the prompt it points at). It then drives the same spring animation as jump-to-bottom for visual parity. The target prompt depends on history-nav state:

- If not walking history yet, the target is the most-recent user message; history-nav begins with the index set to that prompt.
- If already walking history, the target is one prompt older (`index - 1`); the index is decremented before the spring starts.

Unlike jump-to-bottom, the click is a programmatic scroll — it does **not** mutate `_isAtBottom` or `_escapedFromLock`, so the user remains "escaped" from the tail; they asked to read their own prompt, not to follow new output. The programmatic write is routed through the scroll-lock echo latch so the resulting browser scroll event isn't misclassified as user intent.

If a second click lands while a previous spring is still animating (rapid history-walking), the in-flight spring is cancelled before the new one starts, so only one rAF loop is ever writing `scrollTop` at a time.

**Next prompt (split-left)** is the mirror of the up button: target is `index + 1`, spring animation, history-nav index incremented. If the increment would land on the most-recent prompt, the split collapses back to the single jump-to-bottom on the next visibility recompute (depth is now 1).

## Background-growth gating while walking history

While the user is parked on a historical prompt, the transcript almost always continues to grow in the background — the agent is still streaming, tool results are still expanding, images are still decoding and reflowing. Without intervention, every one of those mutations would re-fire the tail-chat re-pin path and yank the viewport back to the bottom, defeating the point of history-nav.

All programmatic re-pin sites therefore consult history-nav state before scrolling:

- **ResizeObserver positive-delta path** (content grew) skips the auto-pin while history-nav is active.
- **ResizeObserver negative-delta path** (content shrank) skips the near-bottom auto-relock while history-nav is active.
- **Image / iframe `load` handler** skips its synchronous bottom-pin while history-nav is active.
- **No-gesture re-pin branch in the deferred scroll handler** (a non-user scroll while we're sticky and drifted) skips the rAF re-pin while history-nav is active.

Returning to the tail by any means clears history-nav, so as soon as the user comes back to live the regular tail-chat contract resumes unchanged.

## Accessibility

All controls share the same affordance contract:

- Visible label text alongside the icon (`Jump to bottom`, `Jump to last prompt` / `Jump to previous prompt`, `Next prompt`, `Bottom`) — no icon-only ambiguity.
- `aria-label` matches the visible label and tracks the label transition on the up button.
- `data-testid`s used by the browser E2E suite: `jump-to-bottom` (single or split-right half), `jump-to-last-prompt` (up button — its current label is also surfaced as `data-label="last"|"previous"`), `jump-to-next-prompt` (split-left half), `jump-to-bottom-split` (the split pill container).
- **Keyboard-focusable only when visible.** The `tabindex` flips between `0` (visible) and `-1` (hidden) so the buttons are skipped by tab order while their fade-out is in flight or when they don't apply. Pointer events are also gated so they cannot be clicked while invisible. In the split layout each half carries its own tabindex / pointer-events / opacity so the two are independent focus targets.
- Fade-in / fade-out is a 150 ms opacity transition; pointer-events and tabindex flip atomically so there is no "ghost clickable" window after they fade out.

## Layering

All controls sit at `z-10` inside the messages region. The bottom button (single or split) lifts above the pill strip when one is rendered (`_pillStripHeight + 8 px` breathing gap) so wrapped or stacked pills never obscure it; the split pill uses the same offset math so the transition between single and split forms doesn't shift the bottom edge. The top button uses a fixed 16 px offset — nothing renders above the transcript top that could conflict.

## Where to look in code

All controls live in [`src/ui/components/AgentInterface.ts`](../src/ui/components/AgentInterface.ts). Search for `_renderJumpToBottom` (which conditionally emits either the single jump-to-bottom or the split pill) and `_renderJumpToLastPrompt` for the render functions; `_refreshJumpButton` / `_refreshJumpToLastPromptButton` for the visibility / label / split-state recomputers; and `_handleJumpToBottomClick`, `_handleJumpToLastPromptClick`, `_handleJumpToNextPromptClick` for the click handlers. The shared scroll target helper is `_scrollUserMessageIntoView(index)`. Visibility is refreshed alongside the scroll-lock recompute, so any future scroll event or transcript mutation that already updates jump-to-bottom will automatically update the up button and split state.

State lifecycle — `_showJumpToBottom`, `_showJumpToLastPrompt`, `_showSplitBottom`, `_jumpToPromptLabel`, `_viewedPromptIdx`, `_lastSeenUserCount` — is cleared together on session navigate / respawn so a freshly loaded transcript never inherits stale walk-cursor state or a stale button from the previous session.

## Tests

- [`tests/e2e/ui/jump-to-bottom.spec.ts`](../tests/e2e/ui/jump-to-bottom.spec.ts) — visibility threshold and click for the bottom button.
- [`tests/e2e/ui/jump-to-last-prompt.spec.ts`](../tests/e2e/ui/jump-to-last-prompt.spec.ts) — top-button base states: hidden initially, hidden when the last prompt is in view, shown after the prompt scrolls above the viewport, click scrolls back, sending a new prompt resets the button. Per the spec change, the click now also reveals jump-to-bottom and leaves the up button visible with `data-label="previous"` when older prompts exist.
- [`tests/e2e/ui/jump-to-prompt-navigation.spec.ts`](../tests/e2e/ui/jump-to-prompt-navigation.spec.ts) — the prompt-by-prompt walking suite: backward stepping through multiple prompts, label transition `last → previous`, up button hiding on the oldest prompt, jump-to-bottom revealing after the first nav click, split pill appearing at depth ≥ 2, the `Next prompt` half walking forward, the `Bottom` half jumping to the tail and clearing nav, reset on new prompt sent, reset on manual scroll past the parked prompt.
- The broader `tests/e2e/ui/tail-chat-*.spec.ts` suite exercises the scroll-lock invariants all three controls share.
