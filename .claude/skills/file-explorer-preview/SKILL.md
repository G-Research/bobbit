---
name: file-explorer-preview
description: Bring up a like-for-like File Explorer panel preview using the exact pack source and Bobbit theme bridge
argument-hint: [layout or interaction to iterate]
allowed-tools: read, write, edit, bash, preview_open, browser_navigate, browser_wait, browser_screenshot, browser_eval
---

# File Explorer Like-for-Like Preview

Create a live preview of the File Explorer panel that is faithful enough for layout and interaction iteration.

## Non-negotiables

- Import the exact source: `market-packs/file-explorer/src/file-explorer-panel.ts`.
- Do **not** copy panel HTML or CSS by hand.
- Do **not** define Bobbit theme variables in preview HTML.
- Use `preview_open(file=..., assets=["bundle.js"])` so the iframe receives the real theme bridge.
- Keep route/store/session behavior in the harness only; production panel logic stays untouched.
- The default fixture must exercise a selected changed file, expanded folders, Git badges, File/Diff tabs, search, direct paths, filtering, and responsive narrow mode.

## Bring up the preview

1. Create a temporary output directory and copy the stable HTML shell:

```bash
mkdir -p .bobbit/tmp/file-explorer-preview
cp .claude/skills/file-explorer-preview/index.html .bobbit/tmp/file-explorer-preview/index.html
```

2. Bundle the harness. It imports the exact panel source and supplies realistic mediated Host API fixtures:

```bash
npx esbuild .claude/skills/file-explorer-preview/entry.ts --bundle --format=esm --platform=browser --target=es2022 --outfile=.bobbit/tmp/file-explorer-preview/bundle.js --tsconfig=tsconfig.web.json
```

3. Open the file-backed preview:

```ts
preview_open({
  file: ".bobbit/tmp/file-explorer-preview/index.html",
  assets: ["bundle.js"],
})
```

## Iterate

Edit the real panel source, rebuild only the preview bundle, then refresh the same preview slot:

```bash
npx esbuild .claude/skills/file-explorer-preview/entry.ts --bundle --format=esm --platform=browser --target=es2022 --outfile=.bobbit/tmp/file-explorer-preview/bundle.js --tsconfig=tsconfig.web.json
```

Call `preview_open` again with the same file and asset. This avoids `build:packs`, gateway restart, the production `dist` copy, and the runtime panel-module cache.

Use the harness fixture in `entry.ts` when a different visual state is needed. Do not add preview-only branches to the production panel.

## Validation checklist

- The panel fills the iframe and inherits Bobbit's active light/dark palette.
- `src/app/file-explorer.ts` is selected initially and shows syntax-highlighted contents.
- The modified badge and File/Diff tabs are visible; Diff renders a parsed unified diff.
- Expanding folders, search, Changed, Collapse, path editing, refresh, and row context menus remain interactive.
- Resize the preview below 680 px to verify the real narrow Files/Preview flow.
- Prefer screenshots of the in-app preview iframe; standalone pages do not prove theme parity.
- After visual iteration, still run the focused DOM/browser tests because this harness validates appearance and interaction shape, not gateway routing or production mounting.
