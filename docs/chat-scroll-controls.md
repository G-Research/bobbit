# Chat scroll controls

The chat transcript has two floating buttons that help users navigate long, streaming conversations without having to fish through the scrollback by hand. They are symmetric in look and behaviour but serve opposite ends of the transcript.

| Button | Position | Appears when | Click action |
|---|---|---|---|
| **Jump to bottom** (`↓`) | bottom-centre of the transcript | the viewport has drifted more than half a screen above the bottom of the conversation | spring-animates back to the tail and re-pins follow-mode |
| **Jump to last prompt** (`↑`) | top-centre of the transcript | at least one user prompt exists *and* the most recent one has scrolled fully above the viewport | spring-animates the last user message to ~16 px below the top of the viewport |

## Why two buttons

The transcript is a streaming conversation that can grow indefinitely while the user reads earlier content. The two buttons cover the two "where am I?" recoveries the user actually needs:

- **"Take me back to live."** Jump-to-bottom returns the viewport to the tail so streaming tool output is visible again, and re-engages the tail-chat lock so the page tracks new content.
- **"Take me back to what I just asked."** A long agent response — model thinking, multiple tool calls with expanded output, generated code — can easily push the prompt that started the turn many screens above the viewport. Scroll-fishing for the original question is fiddly, especially on mobile. Jump-to-last-prompt is a one-tap fix that re-anchors the reader at the start of the *current* turn.

Together they bracket the conversation: one button gets you to the most recent output, the other to the most recent input. Neither does anything you couldn't do with the scrollbar; both make a frequent navigation cheap.

## Visibility rules

Both buttons are pure functions of scroll geometry, recomputed on every scroll event, resize, and transcript mutation. They never linger after the condition that justifies them goes away, and neither tracks user intent — there is no "dismiss" state.

**Jump to bottom** appears when `!_isAtBottom && distance-from-bottom > 0.5 × clientHeight`. The half-viewport threshold is deliberately wider than the 70 px near-bottom band that auto-relocks the tail, so the button only shows when the user has clearly committed to scrolling away. See [internals.md — Chat scroll lock invariant](internals.md#chat-scroll-lock-invariant) for the full state machine and the rules around `_isAtBottom` / `_escapedFromLock`.

**Jump to last prompt** appears when:

1. There is at least one `<user-message>` in the current transcript, **and**
2. The bottom edge of the *last* `<user-message>` element is above the top edge of the scroll viewport (a 1 px epsilon avoids sub-pixel flicker).

It is hidden when:

- No user messages exist yet (a freshly opened session).
- The last user message is partially or fully in view.
- The user has scrolled past the last prompt and it is below the viewport (e.g. browsing earlier history) — in that case the prompt is "in front of" the user already; jumping back to it would be disorienting.

Sending a new prompt synchronously hides the button: the new `<user-message>` is now the last one and lives at the bottom of the transcript, so by definition it is in view.

## Click behaviour

**Jump to bottom** runs the spring rAF loop (`damping 0.7, stiffness 0.05, mass 1.25`) until the viewport lands within sub-pixel tolerance of `scrollHeight - clientHeight`. The target is re-read every tick so content that arrives during the animation moves the goalpost. The click clears `_escapedFromLock` and re-pins `_isAtBottom = true` so subsequent content keeps the viewport at the tail.

**Jump to last prompt** computes a target `scrollTop` such that the top of the last `<user-message>` lands ~16 px below the top of the scroll container (matching the button's own top offset, so the button is "replaced" by the prompt it points at). It then drives the same spring animation as jump-to-bottom for visual parity. Unlike jump-to-bottom, the click is a programmatic scroll — it does **not** mutate `_isAtBottom` or `_escapedFromLock`, so the user remains "escaped" from the tail; they asked to read their own prompt, not to follow new output. The programmatic write is routed through the scroll-lock echo latch so the resulting browser scroll event isn't misclassified as user intent.

## Accessibility

Both buttons share the same affordance contract:

- Visible label text alongside the icon (`Jump to bottom`, `Jump to last prompt`) — no icon-only ambiguity.
- `aria-label` matches the visible label.
- `data-testid` is `jump-to-bottom` and `jump-to-last-prompt` respectively, used by the browser E2E suite.
- **Keyboard-focusable only when visible.** The `tabindex` flips between `0` (visible) and `-1` (hidden) so the buttons are skipped by tab order while their fade-out is in flight or when they don't apply. Pointer events are also gated so they cannot be clicked while invisible.
- Fade-in / fade-out is a 150 ms opacity transition; pointer-events and tabindex flip atomically so there is no "ghost clickable" window after they fade out.

## Layering

Both buttons sit at `z-10` inside the messages region. The bottom button lifts above the pill strip when one is rendered (`_pillStripHeight + 8 px` breathing gap) so wrapped or stacked pills never obscure it. The top button uses a fixed 16 px offset — nothing renders above the transcript top that could conflict.

## Where to look in code

Both buttons live in [`src/ui/components/AgentInterface.ts`](../src/ui/components/AgentInterface.ts). Search for `_renderJumpToBottom` and `_renderJumpToLastPrompt` for the render functions, `_refreshJumpButton` / `_refreshJumpToLastPromptButton` for the visibility recomputers, and `_handleJumpToBottomClick` / `_handleJumpToLastPromptClick` for the click handlers. Visibility is refreshed alongside the scroll-lock recompute, so any future scroll event or transcript mutation that already updates jump-to-bottom will automatically update jump-to-last-prompt.

State lifecycle (`_showJumpToBottom`, `_showJumpToLastPrompt`) is cleared together on session navigate / respawn so a freshly loaded transcript never inherits a stale "jump" button from the previous session.

## Tests

- [`tests/e2e/ui/jump-to-bottom.spec.ts`](../tests/e2e/ui/jump-to-bottom.spec.ts) — visibility threshold and click for the bottom button.
- [`tests/e2e/ui/jump-to-last-prompt.spec.ts`](../tests/e2e/ui/jump-to-last-prompt.spec.ts) — covers the five top-button states: hidden initially, hidden when the last prompt is in view, shown after the prompt scrolls above the viewport, click scrolls back and re-hides, sending a new prompt hides the button.
- The broader `tests/e2e/ui/tail-chat-*.spec.ts` suite exercises the scroll-lock invariants the buttons share.
