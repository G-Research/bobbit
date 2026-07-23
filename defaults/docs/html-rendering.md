# HTML rendering in Bobbit — canonical guide

This is the single source of truth for how an agent produces HTML output
(reports, dashboards, mockups, comparison tables, charts, ad-hoc visualisations)
inside a Bobbit session. The system prompt and the `/html` and `/mockup`
skills all defer to this document.

## TL;DR — decision tree

```
                ┌──────────────────────────────────────────────────┐
                │ Does the user want to LOOK at a visual artefact? │
                └──────────────────────────────────────────────────┘
                                    │
      ┌─────────────────────────────┼──────────────────────────────┐
      │                             │                              │
      ▼                             ▼                              ▼
Ephemeral / one-off        Reusable file-backed           Persisted deliverable
(report, mockup,           live preview                   (committed asset,
 comparison, chart,        (existing report,              doc site, long-lived
 iteration)                local demo with assets)         report)
      │                             │                              │
      ▼                             ▼                              ▼
preview_open(html=...)     preview_open(file="/abs/...")  write file.html
• single live panel        • single live panel             • single inline render
• no chat-history clutter  • absolute entry path           • lives in repo / commit
• atomic refresh           • declare assets/manifest       • user opens file directly
• no file write needed     • no inline file render         • DO NOT call preview_open
```

**One artefact, one surface.** Never both. The inline file-render surface and
the live preview panel have independent state machines and will drift out of
sync.

When unsure, default to `preview_open(html=...)`. Most asks are ephemeral
reports, mockups, charts, or iteration loops.

## Why one surface, not both

- Inline `.html` file render lives in chat history forever; every edit creates
  a new render with the file's tool-result snapshot, and the "Open" button on
  past tool cards becomes ambiguous because the underlying file may have moved
  on.
- The preview panel is a live workspace driven by SSE hot reload and the
  `preview_open` tool. It reflects the latest mounted preview and can reopen
  historical preview snapshots from chat.
- If both surfaces are live, "refresh the preview" becomes ambiguous: which
  one? The user shouldn't have to know.

## Content identity and tab dedupe

Each preview mount has a `contentHash`, a SHA-256 identity for the mounted
preview tree. The workspace uses that hash to collapse duplicate preview tabs:
identical live and historical artifacts select the same live preview tab, while
different artifacts remain separately restorable.

This means repeated `preview_open` calls with the same bytes may update or
select the existing live preview instead of creating another historical tab.
That is intentional; change the content when you need a distinct restorable
preview.

## `html=` vs `file=` — the same surface

Both `preview_open(html=...)` and `preview_open(file=...)` populate the same
per-session preview mount served at `/preview/<sid>/`. User-visible
behaviour is identical — same iframe, same theme bridge, same SSE-driven
refresh.

Use `html=` for one-shot generated content: reports, mockups, charts,
comparison views, and fast iteration. The tool result is a constant ≤250-byte
snapshot regardless of HTML size, so iterating on a 5000-line report does not
blow up your context window.

Use `file=` only when the HTML intentionally lives on disk already or must be a
reusable file-backed live preview. Relative paths are resolved from the agent's
current working directory, but reusable previews should pass an absolute entry
path so the snapshot is unambiguous across later turns.

**Sibling assets are explicit, not automatic.** Bare
`preview_open(file="/abs/path/report.html")` copies *only* the entry file into
the mount — sibling CSS, images, and videos referenced from the HTML will 404
unless you declare them. Two opt-in mechanisms:

```
# Inline asset list (paths relative to the entry file's directory; supports
# single-segment * and ? globs — `**` / `[...]` / `{a,b}` are rejected):
preview_open(file="/abs/path/report.html", assets=["styles.css", "img/*.png"])

# Or a sibling JSON manifest with the same `assets` array shape, also relative
# to the entry file's directory:
preview_open(file="/abs/path/report.html", manifest="preview-manifest.json")
```

Why: bare `file=` used to BFS-walk the parent directory and silently expose any
sibling drafts, secrets, or other agents' WIP. The explicit opt-in makes asset
inclusion intentional. See
[docs/preview-architecture.md](../../docs/preview-architecture.md) for the full
contract.

Full architecture: [docs/preview-architecture.md](../../docs/preview-architecture.md).

## Theme integration is mandatory

Bobbit injects the shared theme bridge (`src/shared/preview-bridge-scripts.ts`)
into both side-panel previews and inline `.html` / `.htm` chat cards produced by
`write` or `edit`. The bridge mirrors:

- the parent's `dark` class
- the parent's `data-palette` attribute
- the parent's font stack
- **every** `--*` CSS custom property defined by the app stylesheet

It also re-syncs on every theme/palette change via a `MutationObserver`, so a
correctly-authored document responds live to user theme changes.

### Therefore

**Never hardcode hex/rgb colours and never define your own `:root` palette or
`prefers-color-scheme` rules.** Always reference the theme variables. Values
are full `oklch(...)` expressions — use them as-is, do **not** wrap them in
another `oklch()` call.

### Theme tokens you can rely on

#### Surfaces and chrome

| Variable | Purpose |
|---|---|
| `--background` / `--foreground` | Page background and primary text |
| `--card` / `--card-foreground` | Card surfaces and their text |
| `--popover` / `--popover-foreground` | Popover surfaces |
| `--secondary` / `--secondary-foreground` | Secondary surfaces |
| `--muted` / `--muted-foreground` | Subdued backgrounds and text |
| `--accent` / `--accent-foreground` | Subtle highlights |
| `--border` / `--input` | Dividers, input borders |
| `--ring` | Focus rings |
| `--primary` / `--primary-foreground` | Primary action colour |
| `--sidebar*` | Sidebar surfaces |

These are intentionally **monochromatic** within any given palette — each
`data-palette` (`forest`, `ocean`, `dusk`, `ember`, `rose`, `slate`, `sand`,
`teal`, `copper`, `mono`) picks a single hue and modulates only lightness.
This makes app chrome calm but is a poor fit for categorical data.

#### Categorical (data-viz) palette — for striking visual content

| Variable | Purpose |
|---|---|
| `--chart-1` … `--chart-6` | Six categorical hues spaced ~60° apart on the colour wheel |
| `--chart-1-foreground` … `--chart-6-foreground` | Legible text colour on the matching fill |

**Stable across `data-palette` switches** — series 1 always means the same hue,
so categorical meaning never shifts when the user changes the app's accent.
Lightness is tuned per theme so contrast against `--card` stays WCAG-safe in
both light and dark mode.

Reach for these whenever you need visually distinct categories — comparison
table columns, chart series, dashboard sections, multi-product cards.

#### Semantic status palette — fixed across themes

| Variable | Purpose |
|---|---|
| `--positive` / `--positive-foreground` | Success, pass, green-tick |
| `--negative` / `--negative-foreground` | Failure, destructive, red-cross |
| `--warning` / `--warning-foreground` | Caution, amber |
| `--info` / `--info-foreground` | Informational, neutral-blue |

These do **not** shift with palette — a green tick stays green regardless of
the user's chosen accent. Use for status icons, validation states, alerts.

#### Tints and translucent fills

Use `color-mix` with theme variables, not fixed `rgba()`:

```css
background: color-mix(in oklch, var(--chart-1) 10%, transparent);
border-color: color-mix(in oklch, var(--primary) 35%, var(--border));
```

## Defensive fallbacks for the bridge race

The theme bridge enumerates the parent stylesheet *at iframe load*. Two
known-race conditions can leave a freshly-loaded iframe missing some `--*`
properties:

1. **Mid-HMR.** Vite is updating the stylesheet; the bridge sees a partial set.
2. **Older builds / sandboxed previews** where stylesheet enumeration is blocked.

If your document collapses to a single hue or loses contrast in these races,
you'll only notice if the user reports it. Make documents self-correcting by
shipping a `:root` block of fallback values for any token you depend on:

```css
:root {
  /* These are overridden by the bridge whenever the parent has them.
     They protect against the race window only. */
  --chart-1: oklch(0.52 0.18 250);
  --chart-2: oklch(0.55 0.16 60);
  --chart-3: oklch(0.50 0.16 145);
  --positive: oklch(0.55 0.15 145);
  --negative: oklch(0.55 0.18 25);
  --warning: oklch(0.62 0.15 75);
}
```

The bridge's `setProperty` calls always win when the parent does have the
token, so this is purely a safety net. Always include fallbacks for chart and
semantic tokens you reference — never for surface tokens (`--background`,
`--foreground`, `--card`, etc.) which the bridge ships universally and which
need to track theme switches exactly.

## The #1 contrast bug: invisible muted text

By far the most common rendered-output defect is **muted text that disappears**
(`--muted-foreground`, captions, `.sub`, table headers). The real theme values
are WCAG-safe in both modes — so when text vanishes, *your CSS caused it*, not
the theme. Three root causes, one rule each:

### ❌ Never reuse a real theme-token name for your own alias

The single most insidious version of this bug. `--muted` is a **real Bobbit
token** — a muted *surface background* (a light ~0.9-lightness colour in light
mode), **not** a text colour. If you alias it to a foreground:

```css
/* WRONG — --muted is already a real token (a surface bg). */
:root { --muted: var(--muted-foreground); }
.sub  { color: var(--muted); }   /* you THINK this is grey text… */
```

the live bridge mirrors the real `--muted` (the light surface) as an **inline**
style on the iframe root, and inline styles **beat your `:root` alias**. So
`color: var(--muted)` resolves to the light surface colour → light-on-light →
invisible. This manifests in both embedded surfaces—the side-panel iframe and
inline chat-card render—because both use the live bridge. A standalone
side-panel tab uses the server snapshot instead.

**Rule: never name a custom property after a real token** (`--muted`,
`--card`, `--border`, `--accent`, `--ring`, `--primary`, `--secondary`,
`--popover`, …). Either reference the real token directly
(`color: var(--muted-foreground)`) or, for a genuine alias, pick a name that
cannot collide (`--c1`, `--bg`, `--fg`, `--mut-fg`). The bridge mirrors *every*
real `--*`, so any collision is silently overwritten.

### ❌ Never alias a surface token with a single-mode fallback

This is the trap that produces invisible text:

```css
/* WRONG — freezes one mode. The fallback hexes are picked for DARK mode,
   but nothing guarantees the page renders in dark mode. */
:root {
  --bg:    var(--background, #14151a);   /* dark fallback */
  --muted: var(--muted-foreground, #9aa0ad); /* dark-grey fallback */
}
body { background: var(--bg); }
.sub  { color: var(--muted); }
```

When the live bridge can't run — **"open in new tab" standalone previews**
(the bridge early-returns because `parent === window`) or the **HMR/sandbox
race** — those fallbacks are used verbatim. A dark-grey fallback on a light
surface (or vice-versa) is invisible, because the bg fallback and the fg
fallback were chosen for *different* modes.

**Rule: reference surface tokens directly. Do not create aliases like
`--muted: var(--muted-foreground, #hex)`.** Write `color: var(--muted-foreground)`
and let the bridge + the server-injected `:root`/`.dark` snapshot supply a
mode-correct, contrast-safe value:

```css
/* RIGHT — no alias, no single-mode hex. */
body { background: var(--background); color: var(--foreground); }
.sub  { color: var(--muted-foreground); }
```

**Do not add a surface-token fallback at all for anything rendered inside
Bobbit** (`preview_open`, inline `.html` render). The live bridge supplies the
host's complete computed token set to embedded surfaces; a standalone
side-panel URL receives the server's contrast-safe `:root` / `.dark` snapshot.
A standalone fallback can only make things worse here—see the next rule. The
single exception is an HTML file that will *only ever* be opened directly from
disk **outside** Bobbit (never via `preview_open` or inline render); only then
supply a **matched `:root` + `.dark` pair** so light and dark stay internally
consistent (never a lone single-mode hex). If there is any chance the file is
previewed in Bobbit, omit it.

### ❌ Never override Bobbit surface tokens in `:root{}`

In embedded side-panel and inline chat-card iframes, the live bridge sets theme
variables as inline root styles, which beat authored `:root` declarations. A
standalone side-panel URL instead receives the server snapshot before authored
styles, so a later authored declaration can replace its value. Either behaviour
makes a custom `--background`, `--foreground`, or other Bobbit token inconsistent
across surfaces. Keep your `:root` block limited to **chart and semantic fallback
tokens only** (see the previous section); never put `--background`,
`--foreground`, `--card`, `--muted-foreground`, or `--border` in `:root` / `.dark`.
Reference them directly with `var(--…)` and let the live bridge or standalone
snapshot supply the values.

### Self-check before you ship

You cannot see the rendered pixels. Before each `preview_open`, mentally
verify: every text colour resolves to a `*-foreground` token whose background
is the *matching* surface token (`--muted-foreground` on `--background`/`--card`,
`--card-foreground` on `--card`, `--chart-N-foreground` on a `--chart-N` fill).
Never put a muted/low-contrast colour on a tinted or coloured background, and
never stack `opacity` or `color-mix(... transparent)` on already-muted text.

## Iteration loop — collaborate, don't soliloquise

Visual work is iterative by nature. Optimise the loop:

1. **First call: ship something complete.** A scaffolded skeleton with real
   data, real layout, real theme tokens. Not a placeholder. The user should
   immediately see whether the structure is right.

2. **Watch for ambiguity early.** If the user's request implies a design
   decision (chart style, column ordering, level of detail), pick a sensible
   default *and call it out in chat* so they can correct course before you
   over-invest. Do not silently re-strategise mid-thread.

3. **One-liner status updates between calls.** "Switched cards to
   `--chart-1..3`, fixed amber contrast on light cards." Not paragraphs.

4. **Refresh = single tool call.** When the user says "refresh", call
   `preview_open(html=...)` once with the latest HTML. Don't argue about
   whether it should already have refreshed.

5. **If the user reports a visual bug, trust them.** They are looking at the
   pixels you cannot see. Reproduce in your head, fix, ship — don't ask "are
   you sure?" or explain why it should look right.

6. **Don't apologise for failure modes that are upstream context limits.**
   Diagnose the gap, fix the upstream guidance (this doc, the system prompt,
   skills), and move on.

## Patterns

### Card grid with categorical accents

```html
<style>
  .card { --c: var(--chart-1); border-top: 4px solid var(--c); }
  .card.b { --c: var(--chart-2); }
  .card.c { --c: var(--chart-3); }
  .card .badge { color: var(--c); background: color-mix(in oklch, var(--c) 18%, transparent); }
</style>
```

### Comparison table with column tints

```html
<style>
  .col-a { --c: var(--chart-1); }
  .col-b { --c: var(--chart-2); }
  th[class^="col-"], td[class^="col-"] {
    background: color-mix(in oklch, var(--c) 8%, transparent);
  }
  thead th[class^="col-"] {
    color: var(--c);
    border-bottom: 2px solid color-mix(in oklch, var(--c) 60%, var(--border));
  }
</style>
```

### Score bar

```html
<style>
  .bar { height: 8px; background: var(--muted); border-radius: 999px; }
  .bar > span { display: block; height: 100%; background: var(--c, var(--primary)); border-radius: 999px; }
</style>
<div class="bar"><span style="width:78%"></span></div>
```

### Status icons

```html
<span style="color: var(--positive)">✓</span>
<span style="color: var(--negative)">✗</span>
<span style="color: var(--warning)">!</span>
```

## Tailwind

Do not link `/src/ui/app.css` from authored HTML. That source URL is a Vite
development detail and is not part of the compiled or packaged UI contract.
The bridge supplies theme variables, not Bobbit's generated utility classes;
write local CSS that consumes `var(--…)` so the same document works in source,
built, and `npx bobbit` runtimes.

## Anti-patterns — do not do these

- ❌ Write `report.html` *and* call `preview_open(file="report.html")` for the same artifact.
- ❌ Rely on undeclared sibling assets; declare them with `assets` or `manifest`.
- ❌ Use a relative `preview_open(file=...)` path for a reusable file-backed preview.
- ❌ Define `:root { --background: ... }` to "lock the palette".
- ❌ Alias a surface token with a single-mode fallback:
  `--muted: var(--muted-foreground, #9aa0ad)` — invisible text when the bridge
  can't run. Reference the token directly instead.
- ❌ Name a custom property after a real token (`--muted: var(--muted-foreground)`).
  `--muted` is a real surface-bg token; the live bridge mirrors it inline and
  overwrites your alias, so the text becomes light-on-light in the preview pane
  (yet looks fine inline). Use a non-colliding name or reference directly.
- ❌ Put `--background`/`--foreground`/`--muted-foreground`/`--card`/`--border`
  in your own `:root{}` block — it overrides the server's contrast-safe snapshot.
- ❌ Use `@media (prefers-color-scheme: dark)` — read the OS, not Bobbit.
- ❌ Hardcode `#ffffff`, `rgba(0,0,0,0.5)`, `oklch(0.21 0.008 145)`.
- ❌ Wrap a theme variable: `oklch(var(--primary))` — the variable already is one.
- ❌ Style three categorical things with `--primary`, `--accent`, `--ring` and
  expect them to look distinct. They don't, by design.
- ❌ Apologise for HMR races; ship the fallback `:root` block instead.
