---
name: html
description: Build an interactive HTML UI in the live preview panel using Bobbit's design system
argument-hint: <description of what to build>
allowed-tools: read, grep, find, ls, write, edit, preview_open, bash
---

# Interactive HTML UI

Build an interactive HTML interface in the live preview panel for: **$ARGUMENTS**

## How it works

Use `preview_open(html="...")` to render ephemeral reports, mockups, charts, and interactive UI in a split-pane alongside the chat. The panel auto-updates on each call. The user can expand it fullscreen via the maximize icon (Escape to exit).

The preview workspace dedupes identical artifacts by content hash. Reopening or regenerating the same bytes may select/update the existing live preview tab instead of creating a second historical tab; different content remains separately restorable.

Use `preview_open(file="/absolute/path/to/file.html")` only for an existing or reusable file-backed preview. Declare sibling CSS, images, and other assets explicitly with `assets` or `manifest`; undeclared siblings will 404. Do not write and preview the same artifact through both the inline file-render surface and the live preview panel.

For the full contract, follow `defaults/docs/html-rendering.md`.

## Setup — always start with this skeleton

```html
<link rel="stylesheet" href="/src/ui/app.css">
<style>
  /* Your custom styles here — use CSS variables from app.css.
     NEVER alias a surface token with a single-mode fallback like
     `--muted: var(--muted-foreground, #9aa0ad)`, and never put surface
     tokens in your own :root{} — both freeze one mode and make muted text
     INVISIBLE in standalone tabs / the bridge race. Reference
     var(--muted-foreground) directly; the injected snapshot supplies it. */
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

The `<link>` gives you the full Bobbit design system: Tailwind CSS 4, theme variables, and component styles. The preview iframe is same-origin with the Vite dev server, so this works out of the box.

## Design system reference

### Theme variables (use via `var(--name)`)

All values are full `oklch(...)` expressions — use directly, never wrap in `oklch()`.

| Variable | Purpose |
|----------|---------|
| `--background` | Page background |
| `--foreground` | Primary text |
| `--card` / `--card-foreground` | Card surfaces |
| `--primary` / `--primary-foreground` | Primary actions, links |
| `--secondary` / `--secondary-foreground` | Secondary elements |
| `--muted` / `--muted-foreground` | Subdued text, disabled states |
| `--accent` / `--accent-foreground` | Highlights, hover states |
| `--border` | Borders, dividers |
| `--input` | Form input borders |
| `--ring` | Focus rings |
| `--sidebar` / `--sidebar-foreground` | Sidebar surfaces |

For transparency/alpha, use `color-mix`:
```css
background: color-mix(in oklch, var(--primary) 10%, transparent);
```

### Tailwind CSS 4

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

### Dark/light mode

Handled automatically — the preview bridge syncs the app's theme. Your UI adapts if you use CSS variables and Tailwind classes. No manual dark mode handling needed.

## Patterns

### Card layout
```html
<div class="bg-card rounded-lg border border-border p-4 shadow-sm">
  <div class="flex items-center justify-between mb-3">
    <h3 class="font-semibold">Title</h3>
    <span class="text-xs text-muted-foreground">Subtitle</span>
  </div>
  <p class="text-sm text-muted-foreground">Content here</p>
</div>
```

### Form controls
```html
<input type="text" class="w-full px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring" placeholder="Type here...">

<select class="px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm">
  <option>Option 1</option>
</select>
```

### Tabs
```html
<div class="flex border-b border-border gap-1">
  <button class="px-3 py-1.5 text-sm border-b-2 border-primary text-foreground" onclick="switchTab(0)">Tab 1</button>
  <button class="px-3 py-1.5 text-sm border-b-2 border-transparent text-muted-foreground hover:text-foreground" onclick="switchTab(1)">Tab 2</button>
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

## Rules

1. **Use `preview_open(html=...)` by default** — the live preview panel is the delivery mechanism for this skill.
2. **Write standalone `.html` only when the user asks for a committed file deliverable** — then do not also call `preview_open` for the same artifact.
3. **Use `preview_open(file=...)` only for existing/reusable file-backed previews** — pass an absolute entry path and declare sibling assets with `assets` or `manifest`.
4. **Always include `<link rel="stylesheet" href="/src/ui/app.css">`** — this gives you the design system.
5. **Use CSS variables for all colors** — never hardcode hex/rgb values. This ensures dark/light mode works. **Never alias a surface token with a single-mode fallback** (`--muted: var(--muted-foreground, #9aa0ad)`) and never redeclare surface tokens in your own `:root{}` — both make muted text invisible when the theme bridge can't run. Reference `var(--muted-foreground)` directly and keep muted text on `--background`/`--card`, never on a tinted surface.
6. **Make it interactive** — add event handlers, state management, filtering, sorting. The user should be able to explore and interact, not just look.
7. **Iterate** — call `preview_open` repeatedly as you build. Start with structure, add styling, then interactivity. The panel updates in-place and identical content may dedupe by content hash.
8. **Describe changes in chat** — don't dump HTML in chat. Just say what you changed; the user sees it in the panel.
