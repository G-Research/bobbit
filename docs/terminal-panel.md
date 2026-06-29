# Terminal panel xterm layout

Bobbit's first-party terminal pack renders an xterm.js instance inside a side panel over the generic `host.channels` API. The panel owns browser rendering, fit/resize, input forwarding, and reconnect behavior; the channel handler owns the PTY and bounded replay.

## Layout contract

xterm.js requires more than the visible rows and canvas styles. Its internal helper DOM must keep the same layout model as xterm's stylesheet:

- `.xterm-viewport` is absolutely positioned and inset to the xterm host.
- `.xterm-screen` and canvas layers are positioned so rendered rows and decorations clip correctly.
- `.xterm-helpers`, `.xterm-helper-textarea`, `.xterm-accessibility`, `.live-region`, and `.xterm-char-measure-element` are hidden, transparent, off-screen, or otherwise removed from normal visible layout.

The terminal panel must install those xterm-required layout/hiding rules before any Bobbit-specific styling. Bobbit theme rules are overrides only: panel sizing, background, focus outline, toolbar/buttons, and token-based colors. Do not replace the required xterm rules with a small handcrafted subset; missing helper/accessibility styles can make xterm internals participate in layout and appear as repeated or partial glyphs at the top of the viewport.

## Scrollback and touch pan

Scrollback stays inside xterm's own viewport semantics. `.xterm-viewport` remains the scroll container, xterm's buffer owns the scrollback, and Bobbit does not create a separate outer scroller or mirrored output buffer.

On touch/coarse-pointer devices, a vertical pan that starts over terminal output (`.xterm-screen`, rows, or the viewport) scrolls the xterm scrollback when scrollback exists. Horizontal gestures are ignored by the terminal scroll bridge so selection, input focus, and surrounding panel behavior are not treated as vertical scroll intent.

Follow-output uses the same bottom-state contract for touch and desktop scrolling:

- when the user touch-scrolls upward, follow-output pauses so newly arriving output does not force the viewport back to the bottom;
- when the user returns to the bottom, follow-output resumes and later output is kept visible.

This preserves xterm layout, selection, keyboard input, resize/fit, and reload/reattach replay behavior while making touch scrollback match mouse wheel scrollback.

## Touch-scroll E2E invariant

`tests/e2e/ui/terminal-pack.spec.ts` contains the touch-scroll regression test:

`touch pan over xterm-screen scrolls the xterm viewport; reproduces ambiguous marker assertion before touch pan hides the terminal tail @terminal-repro`

What changed:

- The test injects deterministic terminal channel frames instead of depending on live shell timing.
- It proves the injected burst created scrollback before any pan assertion.
- It performs a CDP touch drag over `.xterm-screen`, then waits for a stable detached viewport before injecting output that should remain hidden.
- It treats marker visibility as meaningful only after the terminal tail is already hidden.

The previous assertion asked whether a newly injected marker was absent immediately after one touch gesture. That was ambiguous under load: the marker could arrive while the terminal was still at, or settling near, the tail, making a test failure indistinguishable from real follow-output breakage. Detached now means the user has intentionally left the bottom, not merely that a transient render frame happens not to show the tail.

The decisive detached-state metrics are:

- `scroll.atBottom === false`.
- `distanceFromBottom = maxScrollTop - scrollTop` is at least `minDetachPx` (`max(48px, 3 * rowHeight)`).
- `firstLine` is older than the pre-pan `firstLine`, proving visible content moved up into scrollback.
- The burst tail marker and prompt-like tail rows are hidden (`tailMarkerVisible === false`, `promptLikeTailVisible === false`).
- Two samples separated by animation frames are stable: `scrollTop` changes by at most 2 px and `firstLine` by at most one indexed line.

Only after that predicate passes does the test inject `*_WHILE_SCROLLED_UP`. The follow-output assertion then checks that the viewport did not jump to bottom: `firstLine` remains within two lines of the detached sample, `scrollTop` remains within 2 px, and the live marker is still hidden. Finally, touch-panning back down must reveal that marker, and later output must follow again.

## Diagnosing touch-scroll failures

Touch-scroll failures include structured diagnostics in the assertion message. Start with the prefix:

- `TERMINAL_TOUCH_SCROLL_DETACHED_STATE` — setup or touch panning never reached a stable hidden-tail detached state before live output was injected.
- `TERMINAL_TOUCH_SCROLL` — the detached predicate passed, but output arriving while detached either force-followed or became visible.

Use the reported metrics to narrow the cause:

- `maxScrollTop` too small: the deterministic burst did not create enough scrollback, or xterm layout/fit is broken.
- `olderFirstLine === false`: the touch drag did not move the xterm viewport; inspect the `.xterm-screen` target, touch emulation, and pan direction.
- `scroll.atBottom === true` or low `distanceFromBottom`: the viewport is still in the follow band, so marker visibility is not a valid detached-state signal.
- `stableScrollTop === false` or `stableFirstLine === false`: the renderer is still settling; look for rAF/layout races rather than product follow-output behavior.
- `tailMarkerVisible === true` or `promptLikeTailVisible === true`: the pan did not hide the terminal tail, so injecting the live marker would reintroduce the old ambiguous assertion.
- After-output `scrollTop` or `firstLine` jumps, or `whileScrolledUpMarkerVisible === true`: follow-output resumed while the user was still scrolled up.

If the test flakes only in the full suite, preserve these outcome predicates instead of adding retries or larger sleeps. The invariant is that output injected after a stable, hidden-tail detached state must not force-follow until the user returns to bottom.

## Windows ConPTY reproducer

`tests/e2e/ui/terminal-pack.spec.ts` includes a targeted browser E2E test tagged `@terminal-repro` for the Windows `cmd.exe`/ConPTY startup artifact. It injects a deterministic synthetic startup stream shaped like the observed Windows PTY output:

- private-mode enables such as `ESC[?9001h` and `ESC[?1004h`;
- cursor hide/show;
- clear-screen and cursor-home (`ESC[2J`, `ESC[H`);
- OSC title update;
- Windows banner text and `C:\Users\bobbit>` prompt.

The stream is escaped in source so every platform feeds the same bytes through the browser panel. The test then adds a large output burst, a follow-up prompt, reload/reattach replay, smaller/larger resize passes, and cursor-home output. This keeps the regression focused on browser layout and xterm state rather than the host OS running the test.

## Debug feedback loop

The `@terminal-repro` test attaches per-phase debug artifacts for initial startup, burst/follow-up, reload replay, resize, cursor-control output, and failure:

- JSON snapshots of xterm-adjacent DOM rectangles and computed styles for the host, viewport, screen, helper textarea, helpers, accessibility/live-region, and char-measure elements.
- Top, banner-adjacent, bottom, and full visible row text.
- Viewport scroll metrics: `scrollTop`, `scrollHeight`, `clientHeight`, max scroll, and bottom-follow state.
- Recent injected/received frame data in escaped and hex form.
- Screenshot crops of the terminal host so visual artifacts not represented in `.xterm-rows` text are inspectable.

Assertions check both CSS/layout invariants and visible behavior: no repeated top-row glyph artifact, helper DOM not consuming visible layout, viewport still at the bottom after follow-up output, latest prompt text near the bottom, and row count not corrupted by cursor-control output.

## Validation commands

Use the focused touch regression when changing terminal scrollback or follow-output behavior:

```bash
npx playwright test tests/e2e/ui/terminal-pack.spec.ts -g "touch pan over xterm-screen scrolls the xterm viewport" --reporter=line
```

Run the full terminal-pack browser E2E file before handing off terminal panel changes:

```bash
npx playwright test tests/e2e/ui/terminal-pack.spec.ts --reporter=line
```

Use the broader targeted reproducer when changing terminal rendering:

```bash
npm run test:e2e -- tests/e2e/ui/terminal-pack.spec.ts --grep @terminal-repro
```

Then run the usual project checks for the touched area:

```bash
npm run check
npm run test:unit
```

Relevant context:

- `tests/e2e/ui/terminal-pack.spec.ts` covers the browser panel, xterm layout, prompt visibility, resize, reattach, lifecycle, and screenshot/debug artifacts.
- `tests/extension-host-terminal.test.ts` covers channel replay behavior, bounded replay, ANSI/OSC boundary trimming, frame bridging, and PTY policy.
