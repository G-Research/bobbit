---
name: html
description: Build an interactive HTML UI in the live preview panel using Bobbit's design system
argument-hint: <description of what to build>
allowed-tools: read, grep, find, ls, write, edit, preview_open, bash
---

# Interactive HTML UI

Build an interactive HTML interface in the live preview panel for: **$ARGUMENTS**

## Surface

Use `preview_open(html=...)`. Do **not** also write a `.html` file for the
same artefact — the two surfaces drift on every edit. See
[`defaults/docs/html-rendering.md`](../../docs/html-rendering.md) for the
full surface-selection rule and complete token reference.

## Skeleton — start here

```html
<link rel="stylesheet" href="/src/ui/app.css">
<style>
  /* Defensive fallbacks for the bridge / HMR race — overridden by the
     bridge whenever the parent has these tokens. Include the chart and
     semantic ones if you reference them.
     NEVER add surface tokens (--background, --foreground, --muted-foreground,
     --card, --border) here, NEVER alias them with a single-mode fallback like
     `--muted: var(--muted-foreground, #9aa0ad)`, and NEVER name a custom prop
     after a real token (`--muted` is a real surface-bg token — the live bridge
     mirrors it inline and overwrites your alias, making text light-on-light in
     the preview pane). Reference surface tokens directly, or alias only with a
     non-colliding name (--bg, --fg, --c1). */
  :root {
    --chart-1: oklch(0.52 0.18 250);
    --chart-2: oklch(0.55 0.16 60);
    --chart-3: oklch(0.50 0.16 145);
    --chart-4: oklch(0.50 0.20 305);
    --chart-5: oklch(0.55 0.20 15);
    --chart-6: oklch(0.52 0.13 190);
    --positive: oklch(0.55 0.15 145);
    --negative: oklch(0.55 0.18 25);
    --warning:  oklch(0.62 0.15 75);
  }
  body {
    font-family: var(--font-sans, system-ui, sans-serif);
    background: var(--background);
    color: var(--foreground);
    margin: 0;
    padding: 16px;
  }
</style>

<!-- Your UI here -->

<script>
  // Your interactivity here
</script>
```

The `<link>` gives you Tailwind 4 plus every theme variable for pixel-accurate
fidelity with the real app. The preview iframe is same-origin with the Vite
dev server, so this works out of the box.

## Theme tokens at a glance

| Group | Tokens | Use for |
|---|---|---|
| Surfaces | `--background`, `--foreground`, `--card`, `--card-foreground`, `--muted`, `--muted-foreground`, `--border`, `--popover`, `--secondary`, `--accent`, `--ring`, `--input`, `--sidebar*` | Page chrome, layout, text |
| Brand | `--primary`, `--primary-foreground` | Single accented action |
| **Categorical** | `--chart-1` … `--chart-6` (+ `-foreground`) | Distinct categories: chart series, comparison columns, multi-product cards. **Stable across `data-palette` switches.** |
| **Semantic** | `--positive`, `--negative`, `--warning`, `--info` (+ `-foreground`) | Status icons, validation, alerts. **Fixed across palettes** — green tick stays green. |

**For striking visual / categorical content always reach for `--chart-*` and
the semantic slots, not `--primary`/`--accent`/`--ring`.** The core palette is
intentionally monochromatic and will look flat for charts and comparisons.

For tints / translucent fills use `color-mix`:

```css
background: color-mix(in oklch, var(--chart-1) 10%, transparent);
```

## Tailwind CSS 4

Full Tailwind is available. Use utility classes directly:

```html
<div class="flex flex-col gap-4 p-4 rounded-lg border border-border bg-card">
  <h2 class="text-lg font-semibold text-foreground">Title</h2>
  <p class="text-sm text-muted-foreground">Description</p>
  <button class="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90">
    Action
  </button>
</div>
```

## Patterns

### Card with categorical accent

```html
<div class="card" style="--c: var(--chart-1)">
  <span class="badge"
        style="color: var(--c); background: color-mix(in oklch, var(--c) 18%, transparent);
               border: 1px solid color-mix(in oklch, var(--c) 45%, transparent);">
    Tag
  </span>
  <h3>Title</h3>
</div>
```

### Score bar

```html
<div class="bar"
     style="height: 8px; background: var(--muted); border-radius: 999px; overflow: hidden;">
  <span style="display:block; height:100%; width:78%;
               background: var(--chart-1); border-radius: 999px;"></span>
</div>
```

### Status icons

```html
<span style="color: var(--positive)">✓ Pass</span>
<span style="color: var(--negative)">✗ Fail</span>
<span style="color: var(--warning)">! Caution</span>
```

### Form controls

```html
<input type="text"
       class="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm
              focus:outline-none focus:ring-2 focus:ring-ring"
       placeholder="Type here…">

<select class="px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm">
  <option>Option 1</option>
</select>
```

### Tabs

```html
<div class="flex border-b border-border gap-1">
  <button class="px-3 py-1.5 text-sm border-b-2 border-primary text-foreground">Tab 1</button>
  <button class="px-3 py-1.5 text-sm border-b-2 border-transparent text-muted-foreground hover:text-foreground">Tab 2</button>
</div>
```

### Data table

```html
<table class="w-full text-sm">
  <thead>
    <tr class="border-b border-border">
      <th class="text-left p-2 font-medium text-muted-foreground">Header</th>
    </tr>
  </thead>
  <tbody>
    <tr class="border-b border-border hover:bg-accent/50">
      <td class="p-2">Value</td>
    </tr>
  </tbody>
</table>
```

## Iteration loop

1. **Ship something complete on first call** — real data, real layout, real
   theme tokens. Not a placeholder.
2. **Call out design defaults you picked**, so the user can correct course
   before you over-invest.
3. **One-liner status updates between calls**, not paragraphs.
4. **Refresh = single `preview_open` call** with the latest HTML.
5. **Trust user-reported visual bugs** — they're looking at the pixels.

## Rules

1. **Always use `preview_open(html=...)`** — never write a standalone HTML
   file alongside it. One artefact, one surface.
2. **Always include `<link rel="stylesheet" href="/src/ui/app.css">`** for the
   design system.
3. **Use CSS variables for all colours.** Never hardcode hex/rgb. Never
   define your own `:root` palette beyond the chart/semantic fallback block
   above. **Never alias a surface token with a single-mode fallback** (e.g.
   `--muted: var(--muted-foreground, #9aa0ad)`) — reference
   `var(--muted-foreground)` directly, or muted text goes invisible when the
   theme bridge can't run. Keep muted text on `--background`/`--card`, never on
   a tinted/coloured surface.
4. **Make it interactive.** Add event handlers, state, filtering, sorting.
   The user should *explore*, not just look.
5. **Iterate atomically.** Re-call `preview_open` with the full new HTML;
   don't try to patch in place.
6. **Describe changes in chat tersely.** The user sees the panel; just say
   what changed.
