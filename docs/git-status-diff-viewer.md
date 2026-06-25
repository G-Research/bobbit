# Git status rich diff viewer

The Git status widget uses a rich client-side viewer for raw unified diffs returned by the existing session and goal `git-diff` endpoints. The feature improves the modal used from dirty-file rows and commit-file rows while keeping the server contract and PR Walkthrough extension boundary unchanged.

## Where it fits

- `GitStatusWidget` owns the status dropdowns, commit modal, and `#git-diff-modal` portal.
- `RichGitDiffViewer` is the Git-status-specific body renderer for successful diff responses.
- `src/shared/git-diff/unified.ts` is the framework-neutral parser seam between raw `{ diff }` API payloads and the viewer.
- `DiffBlock` remains the generic chat/tool diff renderer used by surfaces such as `BashRenderer`.
- PR Walkthrough keeps its own pack-bundled panel and review state. Git status intentionally adapts similar diff UX patterns without importing pack UI code.

The split keeps a better diff UX in core while preserving extension portability: reusable parsing can live under `src/shared/**`, but UI and Host API assumptions stay in their owning surface.

## User behavior

Opening a dirty file or committed file from the Git status widget opens the existing `#git-diff-modal`. Successful diff responses render `<rich-git-diff-viewer>` with:

- one collapsible section per parsed file;
- rename display as `oldPath → path` when the unified diff includes rename metadata;
- per-file and summary `+N` / `-N` counts;
- split and inline icon mode buttons using `role="radiogroup"` / `role="radio"` and `aria-checked`;
- automatic split mode on wide screens and inline mode on narrow screens;
- a user-selected mode override that persists until the component unmounts or receives new content;
- folded hunk context around changes with native buttons to reveal more hidden lines;
- binary/meta-only file bodies when Git reports non-text diffs;
- a local raw `<pre>` fallback when content is not parseable as a unified diff;
- a visible `role="status"` warning when the server truncation marker is present;
- a copy button for the raw unified diff when `show-copy` is enabled.

The modal shell keeps the previous close behavior: backdrop click and `Escape` close the portal, and disconnect cleanup removes the portal/listener. The dialog panel exposes `role="dialog"`, `aria-modal="true"`, `aria-labelledby="git-diff-modal-title"`, and the close button has `aria-label="Close diff modal"`.

Loading, non-OK error, and empty/no-diff states remain separate from the viewer. The viewer is only rendered when the API returns a non-empty successful `diff` string.

## Endpoint contract stays raw

The viewer consumes the existing raw unified diff payloads:

```http
GET /api/sessions/:id/git-diff?file=<path>[&repo=<repo>][&commit=<sha>]
GET /api/goals/:id/git-diff?file=<path>[&repo=<repo>][&commit=<sha>]
```

Response shape remains:

```json
{ "diff": "...unified diff..." }
```

No structured server diff format is required. The server may append this marker when the payload exceeds the diff size limit:

```text
--- Diff truncated (exceeded 500KB) ---
```

The parser detects that marker and the viewer renders a truncation warning while still showing the available diff.

## Parser seam: `src/shared/git-diff/unified.ts`

`src/shared/git-diff/unified.ts` is the only shared seam introduced by the rich viewer. It has no DOM, Lit, app state, server, or Extension Host dependency, so it can be consumed by core UI and future pack code without coupling either side to the other's runtime.

Exports:

- `parseUnifiedDiff(raw): UnifiedDiffParseResult`
- `buildSplitPairs(lines): SplitDiffPair[]`
- typed structures for files, hunks, lines, parse results, and split pairs
- `DIFF_TRUNCATED_MARKER`

`parseUnifiedDiff` handles:

- `diff --git` file blocks;
- raw hunk-only diffs via a synthetic file;
- `rename from` / `rename to` and `copy from` / `copy to` metadata;
- `/dev/null` added/deleted file headers;
- binary metadata such as `Binary files ... differ` and `GIT binary patch`;
- hunk headers and old/new line cursors;
- additions/deletions counted from content lines only;
- `\ No newline at end of file` by annotating the preceding line;
- unknown metadata by preserving it in `file.meta`;
- global and per-file truncation flags.

`buildSplitPairs` is the split-view helper. It pairs consecutive removed lines with following added lines, renders lone additions/deletions against an empty placeholder, and mirrors context/meta rows on both sides.

## `RichGitDiffViewer`

`src/ui/components/RichGitDiffViewer.ts` registers `<rich-git-diff-viewer>`. It is a Lit custom element that renders into light DOM to match the app's component styling approach.

Public properties:

| Property | Purpose |
|---|---|
| `content` | Raw unified diff string to parse and render. |
| `title` | Toolbar title, usually the clicked file path or `Diff`. |
| `filePath` / `file-path` | Source file path metadata exposed on the root for tests/diagnostics. |
| `showCopy` / `show-copy` | Enables the raw diff copy button. |
| `defaultMode` / `default-mode` | `auto`, `split`, or `inline`. `auto` uses split at wide widths and inline on narrow widths. |

Internal state tracks the explicit mode override, viewport width, collapsed file IDs, context expansion amounts, copied state, and memoized parse result. On `content` changes it clears collapsed files, context expansion, mode override, copy state, and parse cache so old diff state does not leak into the next selection.

Stable selectors used by tests and diagnostics include:

- `[data-testid="rich-git-diff-viewer"]`
- `[data-testid="rich-git-diff-toolbar"]`
- `[data-testid="rich-git-diff-mode"]`
- `[data-testid="rich-git-diff-mode-split"]`
- `[data-testid="rich-git-diff-mode-inline"]`
- `[data-testid="rich-git-diff-file"]`
- `[data-testid="rich-git-diff-file-toggle"]`
- `[data-testid="rich-git-diff-counts"]`
- `[data-testid="rich-git-diff-context-toggle"]`
- `[data-testid="rich-git-diff-line"]`
- `[data-testid="rich-git-diff-raw"]`
- `[data-testid="rich-git-diff-truncated"]`

Styles use Bobbit theme tokens directly, including `var(--card)`, `var(--border)`, `var(--foreground)`, `var(--muted-foreground)`, `var(--primary)`, `var(--positive)`, `var(--negative)`, and `var(--info)`. The component should not introduce a standalone palette or `prefers-color-scheme` branch.

## `GitStatusWidget` integration

`GitStatusWidget` imports `./RichGitDiffViewer.js` and uses it only in the successful body branch of `_renderModal()`:

```ts
<rich-git-diff-viewer
  .content=${this._diffContent}
  .filePath=${this._modalFile}
  .title=${this._modalFile ?? 'Diff'}
  default-mode="auto"
></rich-git-diff-viewer>
```

The widget still owns:

- endpoint selection between session and goal routes;
- request-key stale response protection;
- loading/error/empty modal body states;
- portal creation/removal;
- Escape and backdrop close behavior;
- commit modal layering behind the diff modal.

### Commit-file rename behavior

Commit rows continue to display renamed files as `oldPath → path`, but clicking the file requests the destination path:

```http
/api/sessions/:id/git-diff?file=<newPath>&commit=<sha>
```

The server uses the commit SHA plus destination path to find rename metadata and include the correct old/new pathspecs in the `git show` call. The client must not send `oldPath` or a display string. The rich viewer then displays rename metadata from the returned unified diff.

### Multi-repo behavior

Multi-repo dirty-file rows continue to call the same diff opener with the repo name. URL construction still appends `repo=<repoName>` only when the repo is not `.`. The rich viewer is only a renderer and does not know about repo routing.

## PR Walkthrough portability boundary

The Git status viewer and PR Walkthrough can share UX ideas, not runtime UI code.

Allowed sharing:

- framework-neutral modules under `src/shared/**`, such as the raw unified diff parser;
- intentionally duplicated/adapted visual patterns such as split/inline controls, file sections, counts, and context expansion.

Not allowed:

- importing `market-packs/pr-walkthrough/src/panel.js` or pack-only Host API/review/comment state into core UI;
- importing `src/ui`, `src/app`, or `src/server` from the PR Walkthrough pack;
- moving PR Walkthrough review features such as comments, suggestions, export, review decisions, or durable state into Git status diffs.

This boundary matters because PR Walkthrough is a built-in first-party Extension Host pack. It must remain portable and Host-API based, while Git status is core app UI with a different data source and no review workflow.

`tests/pr-walkthrough-pack-boundary.test.ts` pins the rule by scanning PR Walkthrough pack imports. It allows package imports, pack-local imports, and relative imports resolving into `src/shared/**`; it fails imports that resolve into core UI/app/server internals or other non-shared repo code.

## Test coverage

Coverage for this area is split by responsibility:

- `tests/git-diff-unified-parser.test.ts` covers multi-file parsing, renames, added/deleted files, binary diffs, no-newline markers, truncation, synthetic hunk-only files, and split pairing.
- `tests/rich-git-diff-viewer.spec.ts` covers collapsible file sections/counts/rename paths, file toggle `aria-expanded`, split/inline `aria-checked`, context expansion, responsive auto mode and explicit override, raw fallback, and truncation warning.
- `tests/git-status-widget-states.spec.ts` covers the widget modal integration, commit-file rename URL shape, modal ARIA, and preserved modal behavior.
- `tests/e2e/ui/session-git-status-multi-repo.spec.ts` covers the browser path for multi-repo `repo=` routing and new viewer rendering.
- `tests/e2e/commit-file-diffs-api.spec.ts` and `tests/e2e/session-git-status-multi-repo.spec.ts` keep server rename and repo routing semantics pinned.
- `tests/pr-walkthrough-pack-boundary.test.ts` keeps the pack/core boundary explicit.
- Existing PR Walkthrough parity tests should keep passing because the pack viewer is not reused by Git status.

For UI/parser changes in this area, run:

```bash
npm run check
npm run test:unit
```

Run E2E tests when endpoint semantics or multi-repo routing code changes.
