# Terminal panel xterm layout

Bobbit's first-party terminal pack renders an xterm.js instance inside a side panel over the generic `host.channels` API. The panel owns browser rendering, fit/resize, input forwarding, and reconnect behavior; the channel handler owns the PTY and bounded replay.

## Layout contract

xterm.js requires more than the visible rows and canvas styles. Its internal helper DOM must keep the same layout model as xterm's stylesheet:

- `.xterm-viewport` is absolutely positioned and inset to the xterm host.
- `.xterm-screen` and canvas layers are positioned so rendered rows and decorations clip correctly.
- `.xterm-helpers`, `.xterm-helper-textarea`, `.xterm-accessibility`, `.live-region`, and `.xterm-char-measure-element` are hidden, transparent, off-screen, or otherwise removed from normal visible layout.

The terminal panel must install those xterm-required layout/hiding rules before any Bobbit-specific styling. Bobbit theme rules are overrides only: panel sizing, background, focus outline, toolbar/buttons, and token-based colors. Do not replace the required xterm rules with a small handcrafted subset; missing helper/accessibility styles can make xterm internals participate in layout and appear as repeated or partial glyphs at the top of the viewport.

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

Use the targeted reproducer first when changing terminal rendering:

```bash
npm run test:e2e -- tests/e2e/ui/terminal-pack.spec.ts --grep @terminal-repro
```

Then run the usual project checks for the touched area:

```bash
npm run check
npm run test:unit
npm run test:e2e -- tests/e2e/ui/terminal-pack.spec.ts
```

Relevant context:

- `tests/e2e/ui/terminal-pack.spec.ts` covers the browser panel, xterm layout, prompt visibility, resize, reattach, lifecycle, and screenshot/debug artifacts.
- `tests/extension-host-terminal.test.ts` covers channel replay behavior, bounded replay, ANSI/OSC boundary trimming, frame bridging, and PTY policy.
