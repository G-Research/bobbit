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
              ┌─────────────────────┴──────────────────────┐
              │                                            │
              ▼                                            ▼
   Iterating / one-off                       Persisting a deliverable
   (report, mockup,                          (committed asset, doc site,
    comparison, chart)                        long-lived report)
              │                                            │
              ▼                                            ▼
   preview_open(html=...)                       write file.html
   • single surface (panel)                     • single surface (inline render)
   • no chat-history clutter                    • lives in repo / commit
   • atomic refresh on each call                • user can open via file system
   • DO NOT also write file                     • DO NOT also call preview_open
```

**One artefact, one surface.** Never both. The two surfaces have independent
state machines and will drift out of sync.

When unsure, default to `preview_open(html=...)`. ~90% of asks fall into the
"iterating / one-off" bucket.

## Why one surface, not both

- Inline `.html` file render lives in chat history forever; every edit creates
  a new render with the file's tool-result snapshot, and the "Open" button on
  past tool cards becomes ambiguous because the underlying file may have moved
  on.
- The preview panel is a single live slot driven by SSE hot reload and the
  `preview_open` tool. It always reflects the latest call.
- If both surfaces are live, "refresh the preview" becomes ambiguous: which
  one? The user shouldn't have to know.

## `html=` vs `file=` — the same surface

Both `preview_open(html=...)` and `preview_open(file=...)` populate the same
per-session preview mount served at `/preview/<sid>/`. User-visible
behaviour is identical — same iframe, same theme bridge, same SSE-driven
refresh.

Use `file=` when the HTML lives on disk already. Use `html=` for one-shot
generated content. The tool result is a constant ≤250-byte snapshot
regardless of HTML size, so iterating on a 5000-line report does not blow
up your context window.

**Sibling assets are explicit, not automatic.** Bare `preview_open(file="report.html")`
copies *only* the entry file into the mount — sibling CSS, images, and
videos referenced from the HTML will 404 unless you declare them. Two
opt-in mechanisms:

```
# Inline asset list (paths relative to the entry file's directory; supports
# single-segment * and ? globs — `**` / `[...]` / `{a,b}` are rejected):
preview_open(file="report.html", assets=["styles.css", "img/*.png"])

# Or a sibling JSON manifest with the same `assets` array shape:
preview_open(file="report.html", manifest="preview-manifest.json")
```

Why: bare `file=` used to BFS-walk the parent directory and silently expose
any sibling drafts, secrets, or other agents' WIP. The explicit opt-in
makes asset inclusion intentional. See
[docs/preview-architecture.md](../../docs/preview-architecture.md) for the
full contract.

Full architecture: [docs/preview-architecture.md](../../docs/preview-architecture.md).

## Theme integration is mandatory

Bobbit injects a theme-bridge script (`src/shared/preview-bridge-scripts.ts`)
into every preview iframe. The bridge mirrors:

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

Full Tailwind 4 is available in the preview iframe via the same-origin Vite
dev server. Add `<link rel="stylesheet" href="/src/ui/app.css">` to use
component classes (`bg-card`, `text-foreground`, `border-border`, etc.).
This also pulls in every theme variable directly, useful when you'd rather
write `class="bg-card"` than `style="background: var(--card)"`.

## Anti-patterns — do not do these

- ❌ Write `report.html` *and* call `preview_open(file="report.html")`.
- ❌ Define `:root { --background: ... }` to "lock the palette".
- ❌ Use `@media (prefers-color-scheme: dark)` — read the OS, not Bobbit.
- ❌ Hardcode `#ffffff`, `rgba(0,0,0,0.5)`, `oklch(0.21 0.008 145)`.
- ❌ Wrap a theme variable: `oklch(var(--primary))` — the variable already is one.
- ❌ Style three categorical things with `--primary`, `--accent`, `--ring` and
  expect them to look distinct. They don't, by design.
- ❌ Apologise for HMR races; ship the fallback `:root` block instead.
