# Design: Replace bobbit sprite with text (chat blob)

## Goal

Add a General-settings toggle **"Replace bobbit sprite with text"** (default OFF). When ON,
the large animated bobbit sprite in the **chat view** (the "chat blob") is hidden and replaced
by an animated status-text label that reflects the blob's current `_blobState`. Out of scope:
sidebar / team-list / goal-dashboard sprites (`renderSidebarBobbitCanvas` / `statusBobbit`) —
those stay as sprites and must not change.

## Preference plumbing

New boolean preference key: **`replaceBobbitWithText`**, default **OFF** (only explicit `true`
enables). This follows the existing `subgoalsEnabled` pattern exactly (default-off boolean).

### Server (no code change required)
`getSafePreferences()` in `src/server/server.ts` already passes through every key that is not
prefixed `providerKey.`, and `PUT /api/preferences` already accepts arbitrary keys. So the new
key is persisted and broadcast automatically. **Do not** add server-side special-casing.
(Confirm via the existing preferences E2E coverage; no new server logic.)

### Client dataset mirroring (3 sites — mirror `subgoalsEnabled`/`playAgentFinishSound`)
The preference is mirrored to `document.documentElement.dataset.replaceBobbitWithText` as the
string `"true"` / `"false"` so it survives load and updates live. Three sites:

1. **`src/app/main.ts`** — initial load block (~line 657, alongside `showTimestamps` /
   `playAgentFinishSound` / `subgoalsEnabled`) **and** the reconnect block (~line 1007). Add:
   ```ts
   // Apply replaceBobbitWithText — default OFF (only explicit true opts in).
   document.documentElement.dataset.replaceBobbitWithText =
       prefs.replaceBobbitWithText === true ? "true" : "false";
   ```
   Add the same line in both the initial-load and reconnect locations.

2. **`src/app/remote-agent.ts`** — `preferences_changed` WS handler (~line 2300, after the
   `playAgentFinishSound` block):
   ```ts
   // Apply replaceBobbitWithText — default OFF.
   if ("replaceBobbitWithText" in prefs) {
       document.documentElement.dataset.replaceBobbitWithText =
           prefs.replaceBobbitWithText === true ? "true" : "false";
   }
   ```

3. **`src/app/settings-page.ts`** — synchronously in the toggle handler (mirrors
   `togglePlayFinishSound` / `toggleSubgoalsEnabled` which set the dataset before the PUT).

## Settings UI (`src/app/settings-page.ts`, `renderGeneralTab`)

- New module-level state var: `let settingsReplaceBobbitWithText = false;` (near line 108,
  alongside `settingsShowTimestamps` / `settingsPlayFinishSound` / `settingsSubgoalsEnabled`).
- In `loadGeneralSettings()` (~line 2178): `settingsReplaceBobbitWithText = prefs.replaceBobbitWithText === true;`
- New async toggle handler `toggleReplaceBobbitWithText()` mirroring `togglePlayFinishSound`
  exactly: flip the var, set `document.documentElement.dataset.replaceBobbitWithText`
  synchronously, `renderApp()`, then `PUT /api/preferences` with
  `{ replaceBobbitWithText: settingsReplaceBobbitWithText }`.
- New checkbox row in `renderGeneralTab`, inserted **immediately below** the
  "Show message timestamps" row (which is at ~line 2404-2417) and **above** the
  "Play agent finish sound" row. Match the existing markup exactly: a `<label>` with the
  checkbox + `<span class="text-sm font-medium text-foreground">Replace bobbit sprite with text</span>`
  and a helper `<p class="text-xs text-muted-foreground ml-6">` explaining it replaces the
  animated chat avatar with a status-text label. Checkbox classes:
  `w-4 h-4 rounded border-input accent-primary cursor-pointer`. Add
  `data-testid="general-replace-bobbit-with-text"`, `.checked=${settingsReplaceBobbitWithText}`,
  `@change=${toggleReplaceBobbitWithText}`.

## Chat blob: text vs sprite (`src/ui/components/StreamingMessageContainer.ts`)

The component already tracks `_blobState` ('hidden' | 'active' | 'entering' | 'exiting' | 'idle'
| 'compact-shake' | 'compacting' | 'compact-pop') plus an `archived` property. All blob-state
transition logic stays unchanged — only the **render output** branches on the preference.

### Reading the preference reactively
The dataset value is not a Lit property, so the component must re-read it on each render and
re-render when it changes. Implement with a small reactive mirror:
- Add `@state() private _replaceWithText = false;`
- A module-private helper `readReplacePref()` returns
  `document.documentElement.dataset.replaceBobbitWithText === "true"`.
- In `connectedCallback`, set `this._replaceWithText = readReplacePref()` and register a
  `MutationObserver` on `document.documentElement` (attributeFilter:
  `["data-replace-bobbit-with-text"]`) that updates `this._replaceWithText` (triggering a Lit
  re-render). Disconnect the observer in `disconnectedCallback`.
  This makes the text update both when the state changes (existing `_blobState` `@state`
  re-renders) and when the preference is toggled live.

### Render branch
In `render()`, where the blob `<div class="${this._blobClass}">…sprite…</div>` is produced:
- When `this._replaceWithText` is **true**: render the status-text element **instead of** the
  entire sprite block (no `<canvas>`, no accessory divs, no shadow). Because the canvas is never
  created, `ensureCanvasEyeAnimation` never runs — sprite fully suppressed, no hidden eye loop.
- When **false**: unchanged — render exactly today's sprite block via `renderBlobSpriteImg(...)`.

`_blobVisible` gating stays the same (text shows whenever the sprite would have shown,
including `archived`).

### State → text + animation-class mapping
A pure helper maps `_blobState` + `archived` → `{ text, motionClass }`:

| condition | text | style/animation |
|---|---|---|
| `archived` | `Ended` | muted, desaturated, static |
| `_blobState === 'idle'` (and `exiting`) | `Idle` | muted grey, no/minimal animation |
| `_blobState === 'compacting'` / `compact-shake` / `compact-pop` | `Compacting` | muted, reverse (right-to-left) pulse sweep |
| `active` / `entering` (default streaming) | `Busy` | sprite-colour, Mexican-wave letter rise/fall |

The text element renders each letter in its own `<span>` so the wave / pulse can target letters
sequentially via `animation-delay` (nth-child). Use `aria-label` on the container with the full
word and `aria-hidden` on the per-letter spans for accessibility. Markup shape:
```html
<div class="bobbit-blob-text bobbit-blob-text--busy" aria-label="Busy">
  <span aria-hidden="true">B</span><span aria-hidden="true">u</span>…
</div>
```
The modifier class (`--idle` / `--busy` / `--compacting` / `--ended`) drives colour + animation.

## CSS (`src/ui/app.css`, alongside the blob keyframes ~line 3199+)

Add a `.bobbit-blob-text` block and keyframes. Requirements:
- **Layout parity**: the text container occupies roughly the same vertical footprint as the
  sprite block so toggling / state changes don't shift the chat layout. The sprite block renders
  in a fixed-ish box (canvas ~40×36 CSS px inside padded blob). Give `.bobbit-blob-text` a
  `min-height` / padding matching the blob's effective height (inspect the rendered blob box;
  the blob wrapper uses `padding:8px 20px 40px 20px` in the preview renderer — match the chat
  blob's actual box). Center the text vertically.
- **Colours (design-system tokens / sprite value only)**:
  - muted states (`--idle`, `--compacting`, `--ended`): `color: var(--muted-foreground);`
  - `--busy`: the sprite's own main colour. The sprite body colour is the canonical green
    `#8ec63f` (`CANONICAL_PALETTE.main` in `src/ui/bobbit-render.ts`). To honour the per-session
    hue **and** keep a single source of truth, define **one** CSS custom property for the sprite
    main colour and reuse it — e.g. in `app.css` add `--bobbit-sprite-main: #8ec63f;` on the blob
    text scope (this is the *sprite's own* value, not a new palette colour), then
    `.bobbit-blob-text--busy { color: var(--bobbit-sprite-main); filter: hue-rotate(var(--bobbit-hue-rotate, 0deg)); }`
    so the per-session `--bobbit-hue-rotate` (already set on `document.documentElement`) rotates
    the text colour exactly as it rotates the sprite. Do **not** scatter the hex; define it once.
  - `--ended`: muted + `filter: saturate(0)` (or `opacity`) to read as desaturated/static.
- **Animations** (keyframes named consistently with existing `blob-*`):
  - **Busy — Mexican wave**: `@keyframes blob-text-wave { 0%,60%,100% { transform: translateY(0);} 30% { transform: translateY(-0.25em);} }`
    applied per-letter with staggered `animation-delay` (nth-child) so letters rise/fall in
    sequence, looping.
  - **Compacting — reverse pulse**: a highlight/opacity (or scale) sweep across letters from
    **right to left**. Either a per-letter `@keyframes blob-text-pulse` with `animation-delay`
    assigned in **reverse** order (last letter starts first), or a background-position sweep.
    Must loop and visibly move right→left.
  - Idle: no animation (or a very subtle one). Ended: static.
- **`prefers-reduced-motion: reduce`**: degrade all `.bobbit-blob-text` letter animations to
  `animation: none` (static text), consistent with the existing reduced-motion block (~line 3388).

## Testing

### Browser E2E (new) — pattern: `tests/e2e/ui/settings.spec.ts`
New spec (e.g. `tests/e2e/ui/replace-bobbit-text.spec.ts`) covering:
1. Toggle appears in General settings **immediately below** "Show message timestamps"
   (assert DOM order / position relative to the timestamps row).
2. Enabling it: the chat blob `<canvas class="bobbit-blob__sprite">` disappears and a
   `.bobbit-blob-text` status label is present.
3. **Persists across reload** — reload, the toggle is still checked and the text label still
   shows (sprite still gone).
4. Disabling restores the sprite canvas (text label gone).
5. If practical, assert the text content differs between idle (`Idle`) and busy (`Busy`) — e.g.
   by exercising a streaming state or by directly driving the container's `_blobState` in a test
   harness. Keep this assertion best-effort/robust; do not make the whole spec flaky on timing.

### Pinning / existing tests
- Run `npm run check`, `npm run test:unit`, `npm run test:e2e`.
- Tool-description budget and test-phase-invariant pinning tests must still pass. The new spec
  must be placed so `tests/test-phase-invariant.test.ts` classifies it correctly (browser E2E →
  `tests/e2e/ui/*.spec.ts`). Add the missing test rather than weakening any existing one.

## Files touched
- `src/app/settings-page.ts` — state var, load, toggle handler, checkbox row.
- `src/app/main.ts` — dataset mirror (initial load + reconnect).
- `src/app/remote-agent.ts` — dataset mirror (preferences_changed handler).
- `src/ui/components/StreamingMessageContainer.ts` — reactive pref read + render branch + text mapping.
- `src/ui/app.css` — `.bobbit-blob-text` styles, keyframes, reduced-motion, single sprite-colour var.
- `tests/e2e/ui/replace-bobbit-text.spec.ts` — new browser E2E.
- Docs: feature documentation (handled by documentation gate).

## Constraints honoured
- LF endings; branch `master`. No sidebar/team/dashboard sprite changes; `statusBobbit`
  untouched. Reuses existing preference transport (PUT + WS broadcast + dataset mirror). Colour
  via design-system tokens (`--muted-foreground`) and the single sprite-colour value + existing
  `--bobbit-hue-rotate`; no new `:root` palette, no `prefers-color-scheme`.
