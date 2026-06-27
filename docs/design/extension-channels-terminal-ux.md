# Extension Channels terminal panel UX

**Status:** design input for the `host.channels` design-doc gate  
**Scope:** built-in first-party terminal pack, side-panel UX, launcher semantics, and browser-test acceptance criteria.

## Existing UI patterns to preserve

Research targets: `src/app/pack-panels.ts`, `src/app/pack-entrypoints.ts`, `src/app/side-panel-workspace.ts`, `src/app/session-actions.ts`, `src/ui/components/MessageEditor.ts`, `market-packs/pr-walkthrough/entrypoints/*.yaml`, `market-packs/artifacts/src/ArtifactViewerPanel.ts`.

- **Panels are pack-scoped side-panel tabs.** A pack panel is opened through `host.ui.openPanel({ panelId, params, sessionId? })`, mounted as a `kind:"pack"` side-panel tab, and restored from per-session panel workspace state. Terminal must follow this model, not add a bespoke core panel path.
- **Entrypoints are explicit user launchers.** `session-menu` launchers render in the session actions overflow; `composer-slash` launchers render as synthetic slash menu rows and dispatch only after send. Selecting/clicking the launcher is the trusted user gesture.
- **Open means focus.** Existing `openPackPanel` mounts/focuses the tab and, when `sessionId` is supplied, switches through the canonical session switcher. Terminal should reuse that open/focus behavior.
- **Panels rehydrate by stable identity.** Existing pack panels receive small typed params and rehydrate via Host APIs/stores. Terminal should rehydrate by `{ protocol:"terminal", channelName:"terminal", sessionId }`/channel id, never by raw URL or token.
- **Styling should match pack panels.** Use compact header rows, `border-border`, `bg-background`, `text-foreground`, `text-muted-foreground`, and small rounded action buttons, matching the artifact viewer and side-panel shell.

## Product model

The terminal is a **session-persistent side-panel channel** owned by a built-in first-party pack:

- Pack declares `channels/terminal.yaml`, `panels/terminal.yaml`, and at least one `entrypoints/open-terminal-session-menu.yaml`.
- Optional `entrypoints/terminal.yaml` contributes composer slash `/terminal`.
- The panel uses `host.channels` to open/attach the pack-owned `terminal` protocol. There is no `host.terminal` API and no raw WebSocket/fetch surface.
- The backend PTY lifetime is tied to the session channel, not to the DOM panel instance.

User mental model: **closing the panel is like hiding a terminal tab; Kill is what stops the shell.** This distinction must be explicit in labels and status copy.

## Layout

Desktop split panel:

1. **Header bar**
   - Left: terminal icon/name, current state chip, compact cwd/session label.
   - Right: `Restart`, `Kill`, overflow or secondary `Close panel`.
   - Header remains visible while terminal output scrolls.
2. **Status/notice strip** below header when not simply attached.
   - One-line summary plus action where useful, e.g. `Terminal exited with code 0` + `Restart`.
   - Errors/quota denials use semantic state styling and remain readable without color.
3. **Terminal viewport**
   - xterm.js fills the remaining panel area.
   - Bounded scrollback, no nested page scroll; output scrolls inside xterm.
   - Empty/loading states reserve the same viewport area to avoid layout jump.
4. **Mobile/fullscreen**
   - Prefer side-panel fullscreen mode for the terminal. If the side panel is overlayed, focus must remain inside the terminal panel until closed/hidden.

Header control rules:

- `Kill` is destructive and enabled only for running/attached/reconnecting PTYs. It terminates the PTY/channel and moves to killed/exited state.
- `Restart` is primary recovery action when exited/killed/disconnected/error; while running it may be present but should confirm or be disabled to avoid accidental shell loss.
- `Close panel` always hides/detaches UI only. It must not kill by default.
- Tooltips/ARIA labels must spell out the distinction: `Close panel; terminal keeps running` vs `Kill terminal process`.

## Launchers and open/focus semantics

### Session menu: `Open Terminal`

- Render as a normal session-menu entry in the existing session actions overflow, near other session-level actions.
- Label: `Open Terminal`.
- On click:
  1. Treat the click as the trusted user gesture.
  2. Resolve/open the session-persistent terminal channel for the selected session.
  3. Open or focus the terminal side-panel tab for that same session.
  4. If a terminal already exists, attach/focus it instead of creating a second session terminal.

### Optional composer slash: `/terminal`

- Appears in the existing slash autocomplete with label/description such as `Open Terminal`.
- Dispatch only on send, matching pack composer-slash semantics.
- Should not create a chat user message with terminal output; it is a launcher side effect. The composer may clear the slash command and show header toast/launcher feedback if opening fails.

### Channel identity

- Default terminal identity is one session-persistent channel per session, e.g. key `terminal:default` under the owning pack and session.
- The UI must store only stable typed identifiers in panel params/workspace state, such as `{ channelName:"terminal", instance:"default" }`; it must never persist bearer URLs, surface tokens, or socket handles.
- Re-clicking `Open Terminal` focuses the existing tab and reattaches to the same live channel.

## Lifecycle and status states

| State | Visual treatment | User actions | Copy guidance |
|---|---|---|---|
| Connecting | Header chip + inline spinner; terminal viewport disabled | `Close panel` | `Connecting terminal…` |
| Attached | Calm success/neutral chip; terminal focused | `Kill`, `Close panel`; `Restart` disabled or guarded | Show cwd/session in header, no persistent banner |
| Detached / reconnecting | Warning/info chip; keep last scrollback visible but mark input paused | `Close panel`, optional `Kill` if server still owns PTY | `Reconnecting to terminal… input is paused.` |
| Exited | Terminal remains readable; status strip | `Restart`, `Close panel` | `Terminal exited with code N.` or `Terminal exited.` |
| Killed | Terminal remains readable; status strip | `Restart`, `Close panel` | `Terminal killed by user.` |
| Disconnected after gateway restart | Clear non-recoverable state; no fake live terminal | `Restart`, `Close panel` | `Terminal disconnected after gateway restart. Start a new terminal.` |
| Error / quota denied | Error strip with reason and quota-aware wording | `Close panel`; `Restart` only if retryable | `Terminal unavailable: channel limit reached.` |

Design notes:

- Do not infer failure from lack of output. State comes from channel close/status frames.
- Gateway restart survival is not required for v1; the UX must make the old PTY clearly gone and offer `Restart`.
- `Close panel` causes a detach/hide only. Reopening attaches to the same channel if it still exists.
- Browser reload/remount should restore the side-panel tab from workspace state, call `host.channels.attach(id)` or find the session terminal via `list`, and show attached/reconnecting/disconnected accordingly.

## Resize and channel protocol UX

- xterm should fit to the panel using a resize observer on the terminal viewport, not window size alone.
- Debounce resize frames enough to avoid flooding during panel drags, but the final size must be sent promptly.
- Protocol frames:
  - Client input: `{ kind:"text", data:"…" }` to PTY stdin.
  - Server output: `{ kind:"text", data:"…" }` from PTY stdout/stderr stream.
  - Resize: `{ kind:"json", data:{ op:"resize", cols, rows } }`.
  - Exit/status: `{ kind:"json", data:{ op:"exit", code, signal, reason } }`.
- The header or hidden live region should announce meaningful state changes, not every resize/output frame.

## Scrollback, keyboard, copy/paste

- Default bounded scrollback should be large enough for real work but finite. Recommend starting at 10,000 lines, with server/client quotas documented in the channel design.
- Keyboard focus:
  - Opening/focusing the terminal panel places focus in xterm once attached.
  - `Tab`, arrows, Ctrl/Meta combinations, and shell shortcuts go to xterm while it is focused.
  - App-level shortcuts should not steal keys from the terminal except a documented escape/focus escape pattern.
- Copy/paste:
  - Browser selection copy should work inside terminal output.
  - Paste should use xterm/browser paste handling and send text frames only after the user paste gesture.
  - Never silently transform line endings beyond PTY-safe normalization.
- Accessibility:
  - Panel title: `Terminal for <session title>`.
  - Controls have explicit labels: `Kill terminal process`, `Restart terminal`, `Close terminal panel`.
  - Add an `aria-live="polite"` region for lifecycle changes: connected, reconnected, exited, killed, disconnected, quota denied.
  - Status must be text + icon/shape, not color-only.

## Theme-token styling

Use Bobbit tokens directly; do not hardcode palettes in the panel or pack CSS.

- Shell surface: `background: var(--background)`, `color: var(--foreground)` or xterm theme values derived from these tokens.
- Header: `bg-background`, `border-border`, `text-foreground`, secondary text `text-muted-foreground`.
- Statuses:
  - Attached/healthy: neutral or `--positive` accent sparingly.
  - Reconnecting/disconnected/quota: `--warning` or `--info` with text label.
  - Error/destructive/kill: `--negative` and `--negative-foreground`.
- ANSI colors should use the existing `--ansi-*` theme variables from `src/ui/app.css` so light/dark modes remain legible.
- Focus rings use `--ring`; do not rely on xterm’s default hardcoded focus styling if it conflicts with Bobbit theme.

## Empty, error, and quota states

- **No channel yet:** shown only before launcher completes; prefer `Connecting terminal…` rather than a manual `Start` button because launch is already the user gesture.
- **Quota denied:** explain the limit and next step: `Terminal limit reached for this session. Close or kill another terminal, then retry.` If v1 supports only one terminal per session, say so directly.
- **Read-only/sandbox constraints:** show a non-blocking note only when behavior differs from a normal shell. The PTY itself should already run in the correct session/worktree/sandbox context.
- **Channel closed remotely:** keep scrollback visible; replace prompt interaction with a status strip and `Restart`.

## Browser E2E scenarios

Minimum browser coverage:

1. Session actions menu contains `Open Terminal`; clicking it opens/focuses the terminal side-panel tab.
2. `/terminal` appears in slash autocomplete; sending it opens/focuses the same terminal without posting terminal output into chat.
3. Run a simple command and assert output appears in xterm.
4. Resize the side panel and assert a resize frame with updated `cols`/`rows` reaches the handler.
5. Close panel, reopen via `Open Terminal`, and assert previous live terminal/output reattaches.
6. Reload the browser while gateway stays alive and assert the terminal tab/channel reattaches cleanly.
7. Type `exit` and assert exited state, disabled input, preserved scrollback, and enabled `Restart`.
8. Click `Kill` and assert killed state; click `Restart` and assert a fresh attached terminal.
9. Simulate gateway restart/non-recoverable channel and assert clear disconnected state plus `Restart`.
10. Force quota denial and assert accessible error text, no blank panel, and no duplicate channel.
11. Keyboard/copy smoke: focus enters xterm, typed input reaches PTY, selecting/copying output does not trigger app shortcuts.
12. Theme smoke in light and dark modes: header, status chips, ANSI output, and focus rings use tokens and remain legible.

## Consistency rationale

This design deliberately reuses the current Extension Host launcher and side-panel grammar: `session-menu` and `composer-slash` are the only trusted launchers; `host.ui.openPanel` owns focus and session switching; panel workspace state owns remount/reload restoration; and the pack panel rehydrates from a small typed identity through Host APIs. The only new user-facing pattern is the terminal-specific distinction between hiding the panel and killing the PTY, made explicit through labels, status copy, and separate `Close panel`, `Kill`, and `Restart` controls.
