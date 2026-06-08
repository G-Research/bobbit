---
name: client-debug
description: Pull diagnostics out of the running web client (env, viewport/safe-area, performance, app state) and debug hard-to-inspect mobile / installed-PWA layout bugs
argument-hint: [what you're trying to diagnose]
---

# Client debug & mobile/PWA layout playbook

Use this when you need information back from the **running web client** but can't
get it the usual way — most often an **installed mobile PWA** (iOS "Add to Home
Screen"), where there is no DevTools console and things like
`env(safe-area-inset-*)`, the iOS viewport "lie", connection state, or *which
build is actually live* can only be observed on the real device.

## The tool: Client debug

A flag-gated diagnostic lives in `src/app/client-debug.ts`.

- **Enable it:** Settings → the **Debug** toggle next to *Restart Server* in the
  footer. It's the unified dev switch (it flips the `bobbit-client-debug`
  localStorage flag AND arms boot-timing perf). **Dev-harness only** — it's gated
  on the *server's* harness status (`harnessRestartAvailable`), so it appears
  whenever the gateway runs under the dev harness, including on a phone pointed
  at that dev gateway (which is the whole point); it's hidden on production
  gateways.
- **Use it:** a small floating **DBG** button appears in the chat view (desktop
  *and* mobile). Tapping it dumps a fenced, copy-pasteable report **into the
  message composer** so the user can read it or send it to you.
- **Report sections:** `Environment` (incl. `build=` id), `Viewport / layout`,
  `Performance`, plus any registered via `registerDebugSection(name, fn)` (e.g.
  `App state`, wired from `render.ts`). Add new sections there or via the
  registry — keep `client-debug.ts` generic, not bug-specific.
- **Build id:** the DBG button shows a short build id and the report's
  `Environment` section prints `build=…`. Use it to confirm the device is
  running the build you just shipped (the #1 gotcha when iterating on a hard-to-
  reload installed PWA).

**Getting a dump from the user:** ask them to enable the flag, tap **DBG**, and
send the message. On desktop you can instead run `collectClientDebug()` logic
mentally from `browser_eval`, but the button is the mobile-friendly path.

**Version/identity:** the report includes `buildId` (via the boot waterfall when
present) and live viewport numbers. If you change client code while iterating,
have the user confirm the change took effect by re-dumping — the network-first
service worker means a cold relaunch (while online) pulls the latest; no reinstall
needed.

## Reading the dump

Key fields and what they tell you:

- `standalone=true` / `navigator.standalone` — confirms it's an installed PWA
  (vs a Safari tab). Layout bugs are almost always standalone-only.
- `screen=WxH` vs `window.inner=WxH` vs `visualViewport=WxH` — **if `inner`/`vv`
  are SHORTER than `screen`, iOS is lying about the viewport** (see below).
- `safe-area insets: top/right/bottom/left` — the raw hardware insets. The
  difference between `screen` and `window.inner` usually equals one of these.
- `unit probes (px): 100vh / 100dvh / 100svh / 100lvh / fill-avail` — what each
  CSS height unit actually resolves to. **This is the single most useful signal.**
  When they disagree, you've found a viewport bug.
- `app-shell` / `app-header` / `app-main` / `message-editor` rects — where the
  layout actually landed; compare `app-shell.bottom` to the screen height.
- `GAP below app-shell` = `innerHeight - shell.bottom` — non-zero means the shell
  doesn't fill the layout viewport.

## The iOS standalone "viewport lie" (the bug we hit)

Reference: `github.com/spm1001/gueridon` → `docs/ios-standalone-viewport.md`.

Symptoms & root cause:

- In an installed iOS PWA, the **layout viewport is shorter than the screen** by
  `safe-area-inset-top`, and content is **pinned to the top** — leaving a dead
  band at the *bottom* of the screen.
- `100dvh`, `100svh`, `100%`, and `-webkit-fill-available` all resolve to the
  **short** (lying) value. `100vh` and `100lvh` resolve to the **true** screen
  height. (This split is device/iOS-version dependent — always confirm with the
  unit probes, don't assume.)
- `@media (display-mode: standalone)` *usually* matches for us (confirm via the
  dump's `standalone=true`), but the gueridon doc notes it can report `browser`
  on some iOS versions — if a standalone-scoped rule mysteriously doesn't apply,
  suspect this and consider applying the rule unconditionally (it's typically
  neutral in real browsers).

The fix (implemented — see below): make `html`/`body` **1px taller than the
lying viewport** (`height: calc(100vh + 1px)`). That 1px overflow forces iOS to
**recalculate** the viewport to the true screen height; afterwards `inner`/`dvh`
read the full height and the band disappears. iOS *animates* that expansion
("slides into place"), so trigger it **inline at first paint** (in `index.html`'s
boot `<style>`) to hide the slide behind the launch animation. Use **`100vh`**
(static large viewport) **not `100dvh`** (dynamic) for the trigger — `dvh` grows
when the on-screen keyboard closes and re-fires the slide animation every time.

Things that DON'T work (confirmed on-device, don't waste time):
`-webkit-fill-available` (still lies), `overflow:hidden` (iOS ignores it for
viewport scrolling), `calc(100dvh + safe-area-inset-top)` (feedback loop).

## Where the fix lives

- `index.html` inline `<style>`: `@media (display-mode: standalone) { html, body
  { height: calc(100vh + 1px) } }` — early trigger, hides the slide.
- `src/ui/app.css` `@media (display-mode: standalone)` block:
  - `html, body { height: calc(100vh + 1px) }` + `.app-shell { height: 100vh }`
  - `.app-shell` reserves all four `env(safe-area-inset-*)` (browser tabs keep
    the base `100dvh` rule for dynamic-toolbar tracking).
  - The connected chat layout (`[data-mobile-header]`) zeroes the shell's
    top/bottom insets; the **fixed** `#app-header` carries the top inset itself
    (a `position: fixed` header ignores the shell's padding → "top cut off"); the
    composer (`.agent-input-area`) carries the bottom inset (only **half** of it,
    so it sits flush with the home-indicator line instead of wasting the strip).
- Pinned by `tests/safe-area-css.test.ts` and `tests/index-html-meta.test.ts`
  (source assertions — iOS insets can't be emulated headlessly).

## General method for "I need info from the client"

1. Add a section via `registerDebugSection("My thing", () => "...")` (or extend a
   built-in section in `client-debug.ts`).
2. Have the user enable **Client debug**, tap **DBG**, send the dump.
3. Iterate. Prefer **measuring** (probe elements, `getBoundingClientRect`,
   `getComputedStyle`) over reasoning about layout — on-device behaviour
   (especially iOS) routinely contradicts first-principles guesses.
