# Rich Git diff viewer for `GitStatusWidget`

## 1. Goal and scope

Replace the Git status widget's current `#git-diff-modal` body (`<diff-block .content=...>`) with a richer raw unified-diff viewer that feels close to the PR Walkthrough diff UX while keeping the two surfaces architecturally independent.

The implementation should preserve the existing REST contract:

```ts
GET /api/sessions/:id/git-diff?file=<path>[&repo=<repo>][&commit=<sha>]
GET /api/goals/:id/git-diff?file=<path>[&repo=<repo>][&commit=<sha>]
// response: { diff: string }
```

No server-side structured diff response is required for this iteration. The client should parse the raw unified diff and render it.

Non-goals:

- No PR Walkthrough line comments, suggested comments, review decisions, export, or persistence in Git status diffs.
- No imports from `market-packs/pr-walkthrough` into `src/ui`.
- No imports from `src/ui`, `src/app`, or `src/server` into the PR Walkthrough pack.
- Do not replace the generic chat/tool `<diff-block>` used by `BashRenderer`; that can remain lightweight.

## 2. Current code map

### 2.1 Git status widget modal

File: `src/ui/components/GitStatusWidget.ts`

Important members:

- import: `import './DiffBlock.js';`
- state:
  - `_modalFile: string | null`
  - `_loadingDiff: string | null`
  - `_diffRequestKey: string | null`
  - `_diffContent: string | null`
  - `_diffError: string | null`
  - `_modalEl: HTMLElement | null`
- endpoint builder: `_openDiffModal(file: string, repo?: string, options: { commit?: string } = {})`
  - chooses `/api/sessions/${this.sessionId}/git-diff` vs `/api/goals/${this.goalId}/git-diff`
  - always sends `file=`
  - sends `commit=` for commit-file modal diffs
  - sends `repo=` when `repo && repo !== '.'`
- modal portal:
  - `_showModal()` creates `#git-diff-modal` under `document.body`
  - `_renderModal()` renders loading/error/content/no-diff states
  - `_closeModal()` clears diff state
  - `_removeModal()` removes portal and unregisters Escape listener when the commits modal is not open
- current content branch:

```ts
} else if (this._diffContent) {
  body = html`<diff-block .content=${this._diffContent}></diff-block>`;
}
```

Changed-file entry points that must keep working:

- flat dirty file rows call `_openDiffModal(f.file)`.
- multi-repo dirty file rows call `_openDiffModal(f.file, repoName)` from `_renderMultiRepoSections()`.
- commit-file rows call `_openCommitDiffModal(commit, file)`, which currently calls `_openDiffModal(file.path, undefined, { commit: commit.sha })`.

Rename preservation:

- commit file display uses `_commitFileDisplay(file)` to show `oldPath → path`.
- `_openCommitDiffModal()` sends the new path (`file.path`) to the API.
- The server handles rename lookup in `getGitDiff()`, so the client must not change this request shape.

### 2.2 Existing generic diff renderer

File: `src/ui/components/DiffBlock.ts`

Capabilities:

- parses raw `diff --git` unified diffs into local `DiffFile`, `DiffHunk`, `DiffLine` types;
- inline and side-by-side modes;
- auto default: side-by-side at `window.innerWidth >= 768`, inline below;
- copy action;
- falls back to `<console-block>` when parse fails.

Limitations for this goal:

- file sections are not collapsible;
- header only shows a path, not rename metadata or `+/-` counts;
- no hunk context folding/expansion;
- line rendering scrolls at line/content level rather than a richer file-level diff area;
- controls are a single toggle button, not a radiogroup-style split/inline selector.

Keep `<diff-block>` as-is for chat/tool output unless a follow-up explicitly scopes a shared replacement.

### 2.3 Server diff semantics

File: `src/server/server.ts`

Important functions/routes:

- `getGitDiff(cwd, file?, containerId?, commit?)` around `server.ts:1108`
  - validates unsafe paths;
  - handles `commit` by validating SHA and using `git show --format= --find-renames <commit> -- <pathspecs>`;
  - for renamed commit files, finds `status === "R"` and passes both old and new paths;
  - for worktree file diffs, uses `git diff HEAD -- <file>` and falls back to `git diff --no-index` for untracked host files;
  - truncates over `DIFF_MAX_BYTES` by appending `--- Diff truncated (exceeded 500KB) ---`.
- goal route around `server.ts:9692`
  - reads `file`, `commit`, and `repo` query params;
  - resolves `repo` through `goal.repoWorktrees` when present;
  - returns `{ diff }` or JSON errors: `Invalid file path`, `Invalid commit`, `No diff found`.
- session route around `server.ts:11889`
  - reads `file`, `commit`, and `repo` query params;
  - resolves `repo` through `session.repoWorktrees?.find(w => w.repo === repoParam)` when present;
  - falls back to `session.cwd` for missing/unknown repo.

Implementation should not change these semantics.

### 2.4 Existing coverage to preserve/update

Relevant tests:

- `tests/git-status-widget-states.spec.ts`
  - commit modal changed-file list;
  - renamed file display;
  - clicking renamed file requests `/api/sessions/:id/git-diff?file=src%2Fnew-name.ts&commit=<sha>`;
  - currently asserts `#git-diff-modal diff-block` exists.
- `tests/e2e/ui/session-git-status-multi-repo.spec.ts`
  - route-mocks session `git-status` and `git-diff`;
  - clicks a file under a repo section;
  - asserts the modal opens and `repo=api` was sent;
  - currently asserts `#git-diff-modal diff-block` is visible.
- `tests/e2e/commit-file-diffs-api.spec.ts`
  - API-level commit diff and rename behavior.
- `tests/e2e/session-git-status-multi-repo.spec.ts`
  - API-level `?repo=` routing.
- `tests/pr-walkthrough-panel-parity.spec.ts`
  - PR Walkthrough split/inline, file collapse, hunk context, syntax tokens, comments.
  - This should keep passing unchanged; do not couple Git status implementation to it.

## 3. Proposed architecture

### 3.1 Add a raw unified diff parser shared seam

Add a framework-neutral parser under `src/shared`:

```text
src/shared/git-diff/unified.ts
```

This is the only shared seam introduced by this feature. It should contain no DOM, Lit, browser globals, Bobbit app state, or pack APIs.

Exports:

```ts
export type UnifiedDiffLineKind = 'context' | 'add' | 'remove' | 'meta';

export interface UnifiedDiffLine {
  kind: UnifiedDiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
  raw: string;
  noNewline?: boolean;
}

export interface UnifiedDiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section?: string;
  lines: UnifiedDiffLine[];
}

export interface UnifiedDiffFile {
  id: string;              // stable key, e.g. `${oldPath || ''}->${path || header}`
  header: string;          // original `diff --git ...` line or fallback label
  oldPath?: string;        // from `--- a/...`, `rename from`, or diff header
  path: string;            // new path when known; otherwise display path/header
  displayPath: string;     // `oldPath → path` for renames, otherwise `path`
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'unknown';
  additions: number;
  deletions: number;
  isBinary: boolean;
  isTruncated: boolean;
  meta: string[];          // index, mode, similarity, rename from/to, binary messages, etc.
  hunks: UnifiedDiffHunk[];
}

export interface UnifiedDiffParseResult {
  files: UnifiedDiffFile[];
  warnings: string[];
  isTruncated: boolean;
  trailingText?: string;
}

export interface SplitDiffPair {
  left: UnifiedDiffLine | null;
  right: UnifiedDiffLine | null;
}

export function parseUnifiedDiff(raw: string): UnifiedDiffParseResult;
export function buildSplitPairs(lines: readonly UnifiedDiffLine[]): SplitDiffPair[];
```

Parsing requirements:

1. Split files at `diff --git ` boundaries.
2. Capture file metadata before hunks:
   - `rename from <path>` and `rename to <path>`;
   - `copy from` / `copy to`;
   - `new file mode`, `deleted file mode`;
   - `Binary files ... differ`;
   - `index ...`, `similarity index ...`, `dissimilarity index ...`.
3. Prefer explicit rename metadata over the `diff --git a/... b/...` paths.
4. Parse `---` and `+++` paths for `/dev/null` new/deleted files.
5. Parse hunk headers with:

```ts
/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s?(.*))?$/
```

6. Count additions/deletions from parsed `+` and `-` content lines only; do not count `+++`, `---`, or metadata.
7. Attach `\ No newline at end of file` to the previous line via `noNewline = true` or represent it as `kind: 'meta'`; rendering should preserve the note.
8. Detect truncation by the server marker `--- Diff truncated (exceeded 500KB) ---`; expose `isTruncated` on the result and on the final file if the marker appears inside it.
9. If no `diff --git` headers are present but the text contains one hunk, allow a single synthetic file with `path: 'Diff'` rather than blanking the modal. If parsing still fails, return `files: []` and let the component show a raw fallback.

Why extract this instead of importing from PR Walkthrough:

- PR Walkthrough consumes structured card `diffBlocks` generated from YAML and has review/comment-specific line IDs.
- Git status consumes raw unified diff strings from the existing API.
- The parser is a portable, stable data seam. UI remains intentionally duplicated/adapted, avoiding pack/core coupling.

### 3.2 Add a Git-status-specific Lit component

Add:

```text
src/ui/components/RichGitDiffViewer.ts
```

Custom element:

```ts
@customElement('rich-git-diff-viewer')
export class RichGitDiffViewer extends LitElement {
  @property() content = '';
  @property() title = 'Diff';
  @property() filePath = '';
  @property({ type: Boolean, attribute: 'show-copy' }) showCopy = true;

  /** `auto` = split on wide screens, inline on narrow screens. */
  @property({ attribute: 'default-mode' }) defaultMode: 'auto' | 'split' | 'inline' = 'auto';

  @state() private modeOverride: 'split' | 'inline' | null = null;
  @state() private viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
  @state() private collapsedFiles = new Set<string>();
  @state() private contextExpansions: Record<string, { above?: number; below?: number }> = {};
  @state() private copied = false;

  // createRenderRoot() should return this, matching existing app/Tailwind component style.
}
```

Use `parseUnifiedDiff(this.content)` during render. If parsing becomes expensive on large diffs, memoize by `content` string identity:

```ts
private _parsedContent: string | null = null;
private _parsed: UnifiedDiffParseResult | null = null;
```

Public DOM/test contract:

- root wrapper: `[data-testid="rich-git-diff-viewer"]`
- toolbar: `[data-testid="rich-git-diff-toolbar"]`
- mode radiogroup: `[data-testid="rich-git-diff-mode"]`
- split button: `[data-testid="rich-git-diff-mode-split"]`
- inline button: `[data-testid="rich-git-diff-mode-inline"]`
- file section: `[data-testid="rich-git-diff-file"]` with `data-file-path` and `data-expanded`
- file toggle: `[data-testid="rich-git-diff-file-toggle"]`
- counts: `[data-testid="rich-git-diff-counts"]`
- context expand button: `[data-testid="rich-git-diff-context-toggle"]`
- rendered line: `[data-testid="rich-git-diff-line"]`
- raw fallback: `[data-testid="rich-git-diff-raw"]`
- truncation warning: `[data-testid="rich-git-diff-truncated"]`

Do not use `diff-block` class names as a primary test contract; they collide with PR Walkthrough selectors.

### 3.3 Mode behavior

Mode state:

```ts
const MOBILE_BREAKPOINT = 768;
const effectiveMode = this.modeOverride
  ?? (this.defaultMode === 'split' ? 'split'
    : this.defaultMode === 'inline' ? 'inline'
    : this.viewportWidth >= MOBILE_BREAKPOINT ? 'split' : 'inline');
```

Toolbar controls should mirror PR Walkthrough's UX shape:

```html
<span role="radiogroup" aria-label="Diff display mode">
  <button role="radio" aria-label="Split diff" aria-checked="true|false">...</button>
  <button role="radio" aria-label="Inline diff" aria-checked="true|false">...</button>
</span>
```

Keyboard behavior:

- `Tab` reaches both mode buttons.
- `Enter`/`Space` activates either button through native button behavior.
- Optional roving-arrow behavior is acceptable but not required if both buttons are normal tabbable buttons.
- `aria-checked` must reflect the rendered mode.
- The user override should survive viewport resizes while the component stays mounted.

Icons can be inline SVG copied/adapted from `market-packs/pr-walkthrough/src/panel.js` (`renderDiffModeControls`) or use existing app icon dependencies if already available in `src/ui`. Inline SVG keeps this component self-contained.

### 3.4 File sections

Render one collapsible `<section>` per `UnifiedDiffFile`:

```html
<section data-testid="rich-git-diff-file" data-file-path="..." data-expanded="true|false">
  <div class="git-diff-file-header-row">
    <button
      type="button"
      data-testid="rich-git-diff-file-toggle"
      aria-expanded="true|false"
      aria-controls="rich-git-diff-file-body-<safe-id>">
      <span class="caret" aria-hidden="true">▸</span>
      <span class="path">old.ts → new.ts</span>
      <span class="status">renamed</span>
      <span data-testid="rich-git-diff-counts" aria-label="12 additions, 3 deletions">
        <span>+12</span><span>-3</span>
      </span>
    </button>
  </div>
  <div id="rich-git-diff-file-body-<safe-id>">...</div>
</section>
```

State rules:

- Default all files expanded.
- Toggling stores collapsed file IDs in `collapsedFiles`.
- On `content` change, clear `collapsedFiles` and `contextExpansions` so stale file IDs do not affect a new diff.
- If there are many files, still default expanded for this requirement; a follow-up can add "collapse all" if needed.

Header display:

- `displayPath`: `oldPath → path` for renames/copies; `path` otherwise.
- Status badge: show `renamed`, `added`, `deleted`, `binary`, or omit/`modified` for ordinary modifications.
- Counts: always show `+N` and `-N`, including zeros for stable layout.
- For binary files with no hunks, render metadata and a clear note (`Binary file changed`) rather than a blank body.

### 3.5 Hunk context folding and expansion

PR Walkthrough folds long unchanged context around changed lines. Reuse the concept, not its review-specific state.

Constants:

```ts
const DEFAULT_CONTEXT_LINES = 3;
const CONTEXT_EXPAND_LINES = 10;
```

Data shape for render parts:

```ts
type HunkRenderPart =
  | { kind: 'lines'; start: number; end: number; lines: UnifiedDiffLine[] }
  | {
      kind: 'context';
      start: number;
      end: number;
      gapStart: number;
      gapEnd: number;
      hiddenCount: number;
      canExpandAbove: boolean;
      canExpandBelow: boolean;
    };
```

Algorithm:

1. Important lines are all `add` and `remove` lines.
2. If a hunk has no important lines, show the whole hunk.
3. Build `baseVisible` as every important line index plus `DEFAULT_CONTEXT_LINES` before/after it.
4. Compute hidden ranges not in `baseVisible`.
5. For each hidden range, apply expansion state keyed by file ID, hunk index, `gapStart`, and `gapEnd`:

```ts
const key = `${file.id}::${hunkIndex}::${gapStart}-${gapEnd}`;
```

6. `below` reveals lines from the top of the hidden range; `above` reveals lines from the bottom of the hidden range, matching PR Walkthrough's mental model.
7. Render hidden ranges only as controls adjacent to visible chunks; do not render an inert `...` row if neither side can expand.
8. A context button click increases the relevant direction by `CONTEXT_EXPAND_LINES`.

Context controls:

```html
<button
  type="button"
  class="context-toggle"
  data-testid="rich-git-diff-context-toggle"
  data-context-direction="above|below"
  aria-label="Show 10 more lines above in src/file.ts">
  <!-- up/down icon -->
</button>
```

For accessibility and clarity, include hidden count in title or surrounding text where space permits. The button label should use the actual min of `CONTEXT_EXPAND_LINES` and remaining hidden lines.

### 3.6 Inline rendering

For inline mode, each line row should expose both old and new line numbers:

```html
<div class="git-diff-line add" data-testid="rich-git-diff-line" data-line-kind="add">
  <span class="line-no old"></span>
  <span class="line-no new">42</span>
  <span class="prefix">+</span>
  <span class="line-text">...</span>
</div>
```

Line styling:

- additions: `background: color-mix(in oklch, var(--positive) 15%, transparent)`;
- deletions: `background: color-mix(in oklch, var(--negative) 13%, transparent)`;
- context: transparent;
- hunk headers: `color-mix(in oklch, var(--info) 10%, transparent)` background.

Text should use `white-space: pre` or `pre-wrap` depending on final UX. Prefer a single file-level horizontal scroll container to per-line scrollbars:

```css
.git-diff-overflow { overflow-x: auto; overflow-y: hidden; }
.git-diff-inline-lines { min-width: 640px; }
.line-text { white-space: pre; }
```

### 3.7 Split rendering

Use the parser's `buildSplitPairs(lines)` for changed chunks. Pair consecutive deletes with following adds; context lines appear on both sides.

Structure:

```html
<div class="git-diff-overflow">
  <div class="git-diff-split-grid">
    <div class="split-row">
      <div class="diff-line remove">old side...</div>
      <div class="diff-line add">new side...</div>
    </div>
  </div>
</div>
```

Rules:

- Split grid min-width around `980px`, matching PR Walkthrough's wide-diff affordance.
- Left and right halves each use `minmax(0, 1fr)`.
- Empty side rows render an `.empty` placeholder with `aria-hidden="true"`.
- No comment buttons or line focus behavior in Git status diffs.

### 3.8 Raw fallback

If `parseUnifiedDiff(content).files.length === 0`, render a raw fallback instead of failing:

```html
<pre data-testid="rich-git-diff-raw">...</pre>
```

Importing `<console-block>` is optional but not necessary. A local `<pre>` avoids adding another dependency to the modal path and keeps the component self-contained.

## 4. `GitStatusWidget` integration

### 4.1 Imports

In `src/ui/components/GitStatusWidget.ts`, replace or supplement:

```ts
import './DiffBlock.js';
```

with:

```ts
import './RichGitDiffViewer.js';
```

If no remaining `diff-block` usage exists in this file, remove the `DiffBlock` import. Leave `DiffBlock.ts` for `BashRenderer` and other generic diff users.

### 4.2 Modal content branch

Change only the content branch in `_renderModal()`:

```ts
} else if (this._diffContent) {
  body = html`
    <rich-git-diff-viewer
      .content=${this._diffContent}
      .filePath=${this._modalFile}
      .title=${this._modalFile ?? 'Diff'}
      default-mode="auto"
    ></rich-git-diff-viewer>
  `;
}
```

Loading, error, and no-diff branches should remain semantically unchanged:

- loading: spinner + `Loading diff…`;
- error: destructive text with API error;
- no content: `No diff available`.

A `404 { error: "No diff found" }` should continue to render the error branch because `_openDiffModal()` currently sets `_diffError` on non-OK responses. Do not silently convert it to no-diff unless product explicitly asks.

### 4.3 Modal shell ARIA/keyboard refinements

While touching `_renderModal()`, improve the modal shell without changing its portal lifecycle:

- outer dialog container:

```html
<div role="dialog" aria-modal="true" aria-labelledby="git-diff-modal-title" ...>
```

- title span:

```html
<span id="git-diff-modal-title" ...>${this._modalFile}</span>
```

- close button:

```html
<button type="button" aria-label="Close diff modal" title="Close">×</button>
```

Preserve:

- backdrop click closes;
- `Escape` closes via `_onEscapeKey`;
- `_removeModal()` unregisters the key listener when the commits modal is not present;
- `disconnectedCallback()` calls `_removeModal()`.

Focus trapping is not currently implemented. For this iteration, at minimum make all controls native buttons with labels. If a lightweight focus improvement is added, focus the close button or first toolbar button after render with `requestAnimationFrame`, and return focus to the clicked file row only if doing so can be implemented without brittle cross-portal references.

### 4.4 Commit-file and rename preservation

Do not change:

```ts
private _openCommitDiffModal(commit: CommitInfo, file: CommitChangedFile) {
  if (!this.sessionId && !this.goalId) return;
  this._openDiffModal(file.path, undefined, { commit: commit.sha });
}
```

Rationale:

- The commit modal already displays the rename as `oldPath → path`.
- The server's `getGitDiff()` maps the new path back to both old/new pathspecs for renamed files.
- Sending `oldPath` or a combined display string would break existing API tests.
- The rich viewer will display rename metadata from the returned diff (`rename from`, `rename to`, `---`, `+++`).

### 4.5 Multi-repo preservation

Do not change dirty-file click call sites:

- flat: `_openDiffModal(f.file)`;
- multi-repo: `_openDiffModal(f.file, repoName)`.

Do not change URL construction:

```ts
if (repo && repo !== '.') url += `&repo=${encodeURIComponent(repo)}`;
```

The rich viewer is only a body renderer. It must not know about Bobbit repo routing.

### 4.6 Truncated diff state

The server truncates by embedding a marker in the raw diff. The parser/component should render a visible warning when `parseResult.isTruncated` is true:

```html
<div data-testid="rich-git-diff-truncated" role="status">
  Diff truncated at 500KB; showing the available portion.
</div>
```

This preserves endpoint compatibility while improving clarity.

## 5. Architecture boundary rationale

### 5.1 Core must not import the PR Walkthrough pack

`market-packs/pr-walkthrough/src/panel.js` is a portable extension panel. It owns review-specific state:

- card/comment persistence through `patchEntry()` / pack host state;
- `lineComments`, `lineCommentOpen`, `lineCommentDraft`;
- `suggestions`, decisions, review completion;
- route/polling/recovery behavior;
- Host API assumptions.

Importing that file or its render helpers into `src/ui/components/GitStatusWidget.ts` would pull pack-only assumptions into core and make marketplace code part of the app bundle boundary.

### 5.2 PR Walkthrough must not import arbitrary core UI

The pack currently imports only stable shared modules such as:

- `../../../src/shared/pr-walkthrough/ids.ts`
- `../../../src/shared/pr-walkthrough/yaml-to-cards.ts`

That is an acceptable shared seam. It should not import:

- `src/ui/components/RichGitDiffViewer.ts`
- `src/ui/components/DiffBlock.ts`
- `src/app/*`
- `src/server/*`

The pack should remain portable and host-API based. If it later wants the raw unified parser, it may import `src/shared/git-diff/unified.ts` because that module is framework-neutral and has no Bobbit UI/runtime dependencies.

### 5.3 Intentional UI adaptation is acceptable

Git status and PR Walkthrough can intentionally share UX patterns while duplicating render code:

- mode radiogroup shape;
- file section header/caret/counts;
- context expansion algorithm;
- theme-token styling.

Duplication is preferable here because the Git status viewer has no comments, suggestions, card state, external links, or review workflow. A forced shared component would either leak unused PR review concepts into Git status or make the pack depend on core UI internals.

### 5.4 Architecture regression test

Add a unit regression test such as:

```text
tests/pr-walkthrough-pack-boundary.test.ts
```

Test intent:

- scan `market-packs/pr-walkthrough/src/**/*.{js,ts}`;
- collect static `import ... from "..."` and dynamic `import("...")` specifiers;
- fail if a relative import resolves into `src/ui`, `src/app`, or `src/server`;
- allow imports that resolve into `src/shared/**`;
- allow package imports (`lit`, `yaml`, etc.) and pack-local relative imports.

This pins the boundary without preventing the new parser seam.

## 6. Styling and theme tokens

Use Bobbit theme variables directly; do not define a custom `:root` palette and do not use `prefers-color-scheme`.

Recommended classes/selectors inside `RichGitDiffViewer.ts` style injection:

```css
.rich-git-diff {
  color: var(--foreground);
  background: var(--card);
}
.rich-git-diff-toolbar,
.git-diff-file-header {
  border-color: var(--border);
  background: color-mix(in oklch, var(--muted-foreground) 8%, transparent);
}
.git-diff-add,
.git-diff-add-count { color: var(--positive); }
.git-diff-del,
.git-diff-del-count { color: var(--negative); }
.git-diff-line.add { background: color-mix(in oklch, var(--positive) 15%, transparent); }
.git-diff-line.remove { background: color-mix(in oklch, var(--negative) 13%, transparent); }
.git-diff-hunk-header { background: color-mix(in oklch, var(--info) 10%, transparent); color: var(--muted-foreground); }
.git-diff-context-toggle:hover { background: color-mix(in oklch, var(--primary) 18%, transparent); color: var(--foreground); }
```

Avoid single-mode fallbacks like `var(--muted-foreground, #888)` for important text; reference `var(--muted-foreground)` directly so the theme bridge supplies contrast-safe values.

The existing modal shell uses `var(--card)`, `var(--foreground)`, and `var(--border)` and can remain visually consistent.

## 7. Accessibility and keyboard behavior

### 7.1 Modal

- `role="dialog"`, `aria-modal="true"`, and `aria-labelledby` on the modal panel.
- Close button is a native `<button type="button">` with `aria-label="Close diff modal"`.
- `Escape` closes, preserving current behavior.
- Backdrop click closes, preserving current behavior.
- Portal cleanup remains in `disconnectedCallback()` and `_removeModal()`.

### 7.2 Viewer controls

- Mode control uses `role="radiogroup"` and two `role="radio"` buttons with `aria-checked`.
- File headers are native buttons with `aria-expanded` and `aria-controls`.
- Context expansion controls are native buttons with file/path-specific `aria-label`s.
- Icons must be `aria-hidden="true"`; accessible names come from labels/titles/text.
- Counts should have an `aria-label`, e.g. `"12 additions, 3 deletions"`.
- Truncation warning should use `role="status"` or visible text.

### 7.3 Responsive behavior

- `defaultMode="auto"` chooses split at `>= 768px`, inline below.
- Once a user clicks a mode, that explicit mode remains active across resize until the component unmounts or content changes.
- On narrow screens, split mode remains available and horizontally scrolls as one unit.
- Modal already sizes to `max-width: calc(100vw - 48px)` and `height: calc(100vh - 48px)`; consider reducing padding at small widths with inline style or CSS if visual QA shows cramped mobile layout.

## 8. Test plan

### 8.1 Parser unit tests

Add `tests/git-diff-unified-parser.test.ts`.

Cover:

1. Multi-file diff parses into two `UnifiedDiffFile`s with correct paths, hunks, additions, deletions.
2. Rename diff with `rename from` / `rename to` exposes `oldPath`, `path`, `displayPath`, `status: 'renamed'`.
3. New file and deleted file paths from `/dev/null` are classified correctly.
4. Binary diff records `isBinary` and metadata without hunks.
5. `\ No newline at end of file` is preserved.
6. Truncation marker sets `isTruncated`.
7. `buildSplitPairs()` pairs delete/add runs and preserves context rows.

### 8.2 Component/browser unit tests

Add a file:// fixture for `RichGitDiffViewer`, or extend an existing component fixture pattern under `tests/fixtures`.

Cover:

1. Raw multi-file unified diff renders collapsible file sections with counts.
   - Assert `[data-testid="rich-git-diff-file"]` count.
   - Assert first header contains path and `+/-` counts.
2. File header toggle updates:
   - `aria-expanded`;
   - `data-expanded`;
   - body visibility.
3. Split/inline toggle updates:
   - `data-mode` or rendered mode marker;
   - `aria-checked` on both buttons;
   - split rows disappear/inline rows appear, or equivalent stable selectors.
4. Hidden context expansion reveals more lines.
   - Use a hunk with >10 context lines around one change.
   - Assert fewer context lines before click, more after click.
5. Narrow default mode.
   - Set viewport below 768 before mounting and assert inline is active.
   - Resize wider without user override and assert split activates.
   - Click inline override, resize wider, assert inline remains active.
6. Raw fallback for unparseable content.
7. Truncation warning appears for server marker.

### 8.3 Git status widget tests

Update existing tests that assert `<diff-block>`:

- `tests/git-status-widget-states.spec.ts`
  - replace `#git-diff-modal diff-block` assertion with `#git-diff-modal rich-git-diff-viewer` or `[data-testid="rich-git-diff-viewer"]`;
  - keep renamed-file URL assertions unchanged.
  - add an assertion that the modal title still displays `src/new-name.ts` and the viewer renders rename metadata/counts if the mocked diff includes `rename from` / `rename to`.
- `tests/e2e/ui/session-git-status-multi-repo.spec.ts`
  - replace `#git-diff-modal diff-block` with the new viewer selector;
  - keep `mock.diffRepos` assertion unchanged.

Add/extend Git status modal behavior coverage:

1. Loading state remains visible before mocked diff resolves.
2. Error state remains visible on non-OK response.
3. No-diff/empty body state remains visible when response is OK with empty `diff` or missing content, matching current branch behavior.
4. `Escape` closes the diff modal and does not wedge the commits modal listener.

### 8.4 API tests to keep unchanged

Do not rewrite these unless production behavior changes unexpectedly:

- `tests/e2e/commit-file-diffs-api.spec.ts`
- `tests/e2e/session-git-status-multi-repo.spec.ts`

They pin server rename and repo routing semantics that the rich viewer should consume, not alter.

### 8.5 Architecture test

Add the PR Walkthrough boundary test described in §5.4. This should pass with current allowed imports to `src/shared/pr-walkthrough/**` and continue to pass if a future pack import uses `src/shared/git-diff/**`.

### 8.6 PR Walkthrough parity

Run existing parity coverage unchanged:

```bash
npm run test:unit -- --grep pr-walkthrough-panel-parity
```

If the project test runner does not support that grep form, rely on full `npm run test:unit`.

### 8.7 Required validation commands

For the UI/parser implementation branch:

```bash
npm run check
npm run test:unit
```

No server changes are expected, so `npm run test:e2e` is optional unless implementation touches endpoint code or existing E2E failures indicate a regression.

## 9. Implementation sequence

1. Add `src/shared/git-diff/unified.ts` parser and parser unit tests.
2. Add `src/ui/components/RichGitDiffViewer.ts` using the parser.
3. Add component/browser tests for viewer rendering, mode toggles, collapse, context expansion, responsive default, raw fallback, and truncation warning.
4. Integrate `RichGitDiffViewer` into `GitStatusWidget._renderModal()` only in the successful content branch.
5. Add modal ARIA labels while preserving portal/escape cleanup behavior.
6. Update existing Git status widget tests from `diff-block` selectors to new viewer selectors; keep URL assertions unchanged.
7. Add architecture boundary regression for PR Walkthrough pack imports.
8. Run `npm run check` and `npm run test:unit`.

## 10. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Parser misses unusual git headers | Preserve `meta[]`, tolerate unknown lines, and provide raw fallback. Add parser tests for rename/new/delete/binary/truncation. |
| Large diffs render slowly | Memoize parse results by `content`; context folding reduces DOM rows around large hunks; server already truncates over 500KB. |
| Mode auto changes unexpectedly on resize | Track `modeOverride`; only auto follows viewport before explicit user selection. |
| Existing commit rename URL breaks | Do not change `_openCommitDiffModal()`; keep tests asserting `file=<newPath>&commit=<sha>`. |
| Multi-repo routing breaks | Do not change `_openDiffModal()` URL construction or multi-repo row call sites; keep E2E assertions for `repo=api`. |
| Pack/core boundary erodes | Add import-boundary test allowing `src/shared/**` only. |
| Theme contrast issues | Use Bobbit CSS variables directly and `color-mix`; avoid hardcoded light/dark palettes. |

## 11. Acceptance checklist

- `GitStatusWidget` successful diff modal renders `<rich-git-diff-viewer>` instead of `<diff-block>`.
- Multi-file raw unified diff shows one collapsible section per file.
- File headers show path/rename display and accurate `+/-` counts.
- Split/inline icon controls are keyboard reachable and expose `aria-checked`.
- Wide modal defaults split; narrow modal defaults inline; explicit user mode wins over resize.
- Long hunk context is folded with accessible controls to reveal more lines.
- Commit-file diff viewing still sends `commit=<sha>` and `file=<newPath>` for renamed files.
- Multi-repo dirty-file diff viewing still sends `repo=<repoName>`.
- Loading, error, empty/no-diff, truncation, and modal Escape-close states remain clear.
- PR Walkthrough pack imports only pack-local modules, packages, and `src/shared/**` seams.
- Existing PR Walkthrough parity tests still pass.
- `npm run check` and `npm run test:unit` pass on the implementation branch.
