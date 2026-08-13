# Built-in file explorer

The file explorer is a read-only side panel for inspecting the files used by an agent session. It ships as the first-party `file-explorer` Extension Host pack rather than core UI. This makes a production feature use the same panel, route, activation, session-event, and pack-store contracts available to other trusted packs.

## Open the explorer

Open the explorer from either surface in an active session:

- choose **Open File Explorer** from the session actions menu; or
- run `/files` from the composer slash menu.

Both launchers target the same singleton panel. Opening it again focuses the existing explorer for that session. The panel workspace restores the panel after a page reload.

The pack is enabled by default. It appears in Market under **Built-in (shipped)** and cannot be uninstalled or updated independently of Bobbit. Disabling it removes both launchers; re-enabling it restores them.

## Session root, path safety, and trust

The explorer opens at the bound session's server-derived working directory: the session worktree when present, otherwise the session cwd. Users can then navigate read-only to any filesystem directory accessible to the Bobbit server process. Its canonical absolute path and current relative location share one clickable breadcrumb row, with adjacent up-one-level and edit controls. Once a root is selected, path-bearing list/read/search/diff requests accept only canonical relative paths with `/` separators; they reject absolute paths, drive paths, backslashes, NUL, empty or dot segments, `..`, duplicate separators, and repository metadata segments named `.git`. Absolute paths are accepted only by explicit root navigation. The current root itself is represented by an empty relative path.

The route layer fails closed if the server does not supply an initial working directory. For each filesystem operation it canonicalizes the root and binds it to stable device/inode identity when the filesystem provides one. If root identity is unavailable, it instead rechecks the root's directory kind, exact canonical path, and containment around operations; child and opened-file identity checks remain strict. It verifies canonical containment throughout and closes acquired handles after success, failure, or late completion. Search classifies candidates with `lstat` before traversing them. Regular-file reads use a no-follow open where the platform exposes one, then verify descriptor identity and containment before reading bytes. A detected namespace change returns a safe retryable error; an outside-root resolution is rejected without exposing its absolute path.

These checks are pack-local defense in depth, not a formal hostile-concurrency containment guarantee. Portable Node.js does not provide one cross-platform equivalent of Linux `openat2`-style, descriptor-relative traversal, particularly across Windows reparse-point behavior. A process able to replace filesystem namespaces concurrently may still create races between portable path checks. A strict guarantee would require a server-owned, OS-native rooted filesystem broker, which the explorer does not add.

The Extension Host worker is resource- and crash-isolated, but its first-party server module remains trusted code with ambient Node.js filesystem and child-process access. Module imports stay within the pack root, while the browser panel uses only mediated Host APIs (`host.callRoute`, `host.store`, and `host.session`).

Symlinks and special entries are visible, non-traversable leaves. They can be revealed and have their paths copied, but cannot be expanded or previewed. Dotfiles remain visible. `.git` is omitted from listings and recursive search and rejected by direct path operations.

See [Extension Host authoring](extension-host-authoring.md#worked-example-the-file-explorer-first-party-pack) for the reusable pack pattern and [Marketplace](marketplace.md#built-in-first-party-packs) for built-in activation and shipping.

## Path bar

The full-width breadcrumb row is the panel's only path chrome and remains visible beside either Files or Preview. It stays on one line, scrolls horizontally, and ellipsizes long segments with the complete absolute path available as a tooltip.

### Breadcrumb navigation

The breadcrumb region is a `nav` labelled **Current path**. **Session files** represents the session root, every segment is a native button, and the final segment has `aria-current="location"`. Activate any segment to resolve and reveal that root, directory, or file. `Arrow Left` and `Arrow Right` move between focused breadcrumb buttons; normal `Tab`, `Enter`, and `Space` behavior remains available.

The displayed location changes when a file is selected, a directory is activated, a breadcrumb is used, or a path/search result is opened. Merely moving roving focus with tree arrows does not rewrite the location. Navigating to a directory focuses it without discarding an already-open file preview. Navigating to a file selects it and uses the existing preview flow.

Direct resolution returns an ancestor chain rather than enumerating siblings. It can therefore reveal an initially unloaded nested target, including one hidden beyond a directory listing's entry cap. The confirmed chain is merged into the lazy tree; normal directory listings remain authoritative when they later load.

### Enter a relative path

Enter text mode by:

- choosing **Edit path**;
- clicking unused space in the path row; or
- pressing `Ctrl+L` or `Cmd+L` while focus is inside the explorer.

The shortcut is handled only inside the explorer, so it does not globally replace the browser address-bar shortcut. The labelled **Relative path** input contains and selects the exact current canonical value. An empty value means the session root. Values are submitted exactly as entered so spaces can be valid filename characters; separators, dot segments, case, and surrounding whitespace are not silently rewritten.

- `Enter` resolves the draft. Repeat submission is blocked while the input is busy.
- `Escape` cancels editing or an in-flight resolve, ignores its late response, restores the prior location, and returns focus to the invoking Edit control.
- Blur neither submits nor cancels.

A successful directory navigation expands its ancestors, reveals and focuses the directory, and does not implicitly expand an unloaded destination; an already-expanded destination stays expanded. A regular file is revealed, selected, and previewed. A symlink or special entry is revealed as an unsupported leaf. In narrow mode, directory/leaf navigation shows Files and file navigation shows Preview.

Invalid, missing, wrong-kind, timeout, changed-path, outside-root, and read failures stay inline under the input and are announced without changing the current selection or preview. The typed draft remains available. Retry appears only for retryable failures such as a timeout. Editing the value clears the prior error. A newer navigation, selection, refresh, cancel, or panel deactivation fences older responses so they cannot steal focus or repaint state.

## Recursive filename search

**Search files and folders** performs a fresh bounded traversal beneath the server-derived session root, not a filter over currently loaded tree rows. Requests start after a 200 ms debounce. Changing or clearing the query increments a client generation, so an older response cannot replace newer results. The Host API has no route-call cancellation; obsolete server work may finish, but remains bounded and its response is ignored.

The server trims outer query whitespace, rejects empty, NUL-containing, and overlong queries, then compares ordinary Unicode `toLowerCase()` values. Matching is a case-insensitive **substring** of each entry's complete canonical relative path:

```ts
stableLowercase(entry.path).includes(stableLowercase(query))
```

It is not exact, prefix-only, basename-only, or token matching. For example, `report` matches `docs/Report.md`, `index` can return both `api/index.ts` and `web/index.ts`, and `web/ind` matches `web/index.ts`. Matching directories, files, symlinks, and special entries can appear, but only real directories are traversed. `.git` is skipped.

Results are sorted deterministically by full case-insensitive relative path with a case-sensitive tie. Each result shows its name and parent path so duplicate basenames are distinguishable; its title and accessible name provide the relative-path context without exposing the absolute root.

### Search interaction

While a query is active, a `listbox` replaces only the tree body. Keyboard focus stays on the search `combobox` and the active result is exposed through `aria-activedescendant`.

| Key | Behavior |
|---|---|
| `Arrow Down` / `Arrow Up` | Select the next/previous result and wrap at either end. With no active result, select the first/last. |
| `Ctrl/Cmd+Home` / `Ctrl/Cmd+End` | Select the first/last result. Unmodified Home/End retain text-input behavior. |
| `Enter` | Activate the selected result, or the first result when none is selected. |
| `Escape` | Clear search, restore the pre-search browse state, and keep focus in the empty search field. |
| `Tab` | Move through the normal toolbar controls without activating a result. |

Activating a file opens its read-only preview while the query and results remain active. On the active file result, **Reveal in tree** instead clears search and reveals that file in the lazy tree. Activating a directory, symlink, or special result restores the pre-search snapshot, clears search, then reveals the destination. In narrow mode a file result opens Preview; **Back to files** returns to the still-active query and search focus.

The first transition from an empty to non-empty query snapshots expansion, roving focus, selection, current path, File/Diff mode, previews, and the narrow pane. Explicit Clear or `Escape` restores that snapshot exactly. Server-confirmed discovered nodes may remain cached, but they do not change the restored visible expansion, selection, preview, or location. Search is independent of **Changed files only** and says that it includes all files when the filter is active. Revealing a clean result turns the filter off so the destination is visible.

The panel shows explicit searching, settled count, empty, truncated, timeout, retryable error, and non-retryable error states. A new query removes old options. Retry repeats the current query immediately. Timeout and other retryable failures do not present partial traversal as complete. Refresh keeps an active query but clears its old results and runs it again after refreshing the tree and Git data.

## Tree controls

### Changed files only

**Changed files only** is an `aria-pressed` toggle built from the fresh root Git status; it does not add another Git route. The filtered tree contains every changed path, virtual deleted paths, and the parent chains required to reach them, including changes not present in a capped directory listing. Existing Git badges and ancestor indicators remain visible.

Filtering changes only the projection of the tree. It does not discard loaded directories, the base expansion set, selection, or preview. If the roving-focus row becomes hidden, focus is repaired to its nearest visible ancestor and then the first visible row. Search still covers the whole session root. Direct navigation or reveal to a clean target turns the filter off and announces why.

Outside a Git worktree the control is disabled with an accessible reason and normal browsing continues. A transient Git failure also disables it and shows the normal tree, but preserves the stored preference so a later successful refresh can reapply it. An empty filtered tree says that there are no changed files.

### Collapse all

**Collapse all** clears the expansion set in one action and announces completion once. It is unavailable when no folder is expanded and while search replaces the tree. The logical selected file and its preview remain intact; roving tree focus is repaired to the nearest visible ancestor or first top-level row. When invoked from the toolbar, the button retains focus and the next tree tab stop remains valid.

## Row path actions

Right-click any tree row, or press `Shift+F10` or the Context Menu key on a focused row, to open **Path actions**. The menu targets files, directories, symlinks, special entries, and virtual deleted paths without changing selection, roving focus, expansion, or preview. Pointer menus open at the pointer; keyboard menus open next to the row. The menu is clamped to the viewport.

For real directories, the menu starts with **Set root**, which makes that directory the explorer root and refreshes the path breadcrumb and tree. Virtual deleted directories cannot be selected as roots.

The menu also contains:

- **Copy relative path** — the complete canonical `/`-separated relative path; and
- **Copy filename** (or **Copy folder name**) — the final path segment, including its extension when present.

Copy actions never use an absolute path, display ellipsis, or rename source path.

| Key | Behavior |
|---|---|
| `Arrow Down` / `Arrow Up` | Move between the two actions and wrap. |
| `Home` / `End` | Move to the first/last action. |
| `Enter` / `Space` | Run the focused native-button action. |
| `Escape` | Close and restore invocation focus. |
| `Tab` / `Shift+Tab` | Close while preserving predictable invocation focus. |

A normal click outside also closes the menu. Successful clipboard writes close the menu, restore invocation focus, and show and announce **Relative path copied** or **Filename copied** for about two seconds. Missing or rejected Clipboard API access is never reported as success: a persistent inline alert says **Couldn’t copy. Clipboard access is unavailable.** and offers **Dismiss**.

## Tree and preview behavior

Directories load only when expanded. Each listing puts directories first, then uses stable case-insensitive alphabetical ordering with deterministic ties. Loading, empty, truncated, and retryable error states remain local to the affected directory.

The tree exposes `tree`, `treeitem`, and `group` semantics, roving focus, selected and expanded state, and busy state while loading.

| Key | Behavior |
|---|---|
| `Arrow Up` / `Arrow Down` | Move through visible rows without changing the path-bar location. |
| `Arrow Right` | Expand a directory, or move to its first child when already expanded. |
| `Arrow Left` | Collapse a directory, or move to its parent. |
| `Home` / `End` | Move to the first/last visible row. |
| `Enter` / `Space` | Expand/collapse a directory or open a file preview. |
| `Shift+F10` / Context Menu | Open Path actions for the focused row. |

Selecting a regular text file opens working-tree contents with its relative path, a **Read only** label, line numbers, and syntax highlighting for common source and data formats. Empty, binary, unsupported, deleted, oversized, loading, and read-error states are explicit.

A changed file adds `File` and `Diff` tabs. `File` shows the working-tree file. Deleted files default to `Diff`. `Diff` is one complete working-tree-versus-`HEAD` comparison, so staged and unstaged changes appear together rather than as concatenated partial diffs. Rename/copy metadata and deleted, binary, metadata-only, empty, and oversized states are preserved.

Untracked files and files in a repository with an unborn `HEAD` have no tracked baseline. Text files receive a standard new-file unified diff from `/dev/null`; empty and binary files receive their own states. The panel parses unified output through the shared Git diff parser.

The explorer has no editing, create, rename, move, delete, drag/drop, download, or external-editor action. Search, breadcrumbs, filters, collapse, previews, diffs, and path copying do not weaken this read-only product model.

## Git decorations

At root refresh, the pack reads Git status relative to `HEAD`. Outside a Git repository it shows no Git decoration or Git failure state. In a repository it supports:

| Badge | Meaning |
|---|---|
| `M` | Modified or type-changed. |
| `A` | Added. |
| `D` | Deleted. |
| `R` | Renamed. |
| `C` | Copied. |
| `?` | Untracked. |
| `!` | Conflicted. |

Tracked files may show separate accessible staged and unstaged badges, including mixed states. Rename and copy destinations identify their old/source path. Copy detection includes a staged, retained-source copy even when the user's `status.renames` configuration is disabled. Only the destination receives `C`. Directories containing changes receive an ancestor indicator.

Deleted paths no longer present on disk are represented by virtual tree entries and any missing parent chain, so their `HEAD` diff and path actions remain available. If bounded Git status or copy discovery fails, browsing continues without decorations for that refresh rather than replacing the filesystem tree with a Git error.

## Refresh and restored state

**Refresh panel** in the containing tab controls recomputes the root listing, Git status, expanded directory listings, selected preview, and any active search. It preserves valid expansion and selection where possible and prunes paths that disappeared. Generation checks prevent old list, path, search, and preview responses from repainting newer state.

The panel also subscribes to the bound session's status. The first observed `idle` triggers one refresh; later non-idle-to-`idle` transitions do the same, making agent-created changes visible without a filesystem watcher. Consecutive `idle` events do not repeatedly refresh.

The versioned pack-store record contains canonical relative expanded paths, selected and focused paths, File/Diff mode, and the **Changed files only** preference. The Git filter is applied only after a fresh status confirms Git is available. Search queries/results/snapshots, path-bar location/drafts/errors, context menus, and copy feedback are transient and are not restored after reload. Persistence is best-effort; malformed, out-of-version, or non-canonical values do not block browsing.

Within the current page, the singleton panel instance is cached per session. Reopening it reuses the current browse state and path-bar location, while an unfinished path edit, active search, context menu, and copy feedback are cleared when the panel detaches. Persisted state is hydrated only once per cached instance; if detachment interrupts that initial read, reopening retries it. A browse action made while hydration is pending takes precedence, so a late stored value cannot replace newer navigation.

## Responsive and accessibility behavior

Below a 680 px panel width, Files and Preview become separate panes. Opening a file shows Preview; **Back to files** restores the originating tree row or active search input. The unified breadcrumb row stays visible in both panes.

Below 480 px, the breadcrumb collapses to its final directory segment. Below 360 px, Changed and Collapse become icon-only but retain full accessible names and tooltips. Below 300 px, Search takes its own toolbar row rather than shrinking below 120 px. The toolbar has no fixed height, so wrapped controls and 200% zoom are not clipped.

Native breadcrumb and toolbar buttons remain keyboard accessible. Search owns composite focus while results are active. Polite live output announces counts and successful actions; actionable path, search, and clipboard failures use assertive alerts. The canonical session root is the only absolute path placed in visible or accessible UI; file operations, search results, previews, and copy actions remain relative to it.

## Bounded work

The current product bounds are exported from the explorer model so routes and tests share one source of truth:

| Operation | Limit |
|---|---|
| Directory list | 1,000 returned entries per directory; additional entries set `truncated`. |
| Search query | 256 characters after outer whitespace is trimmed. |
| Search results | 200 returned results. |
| Search traversal | 20,000 inspected entries, 5,000 claimed directories including root, maximum depth 100, and at most 4 directory scans concurrently. |
| Search deadline | One shared 3-second deadline. |
| File preview | 1 MiB. |
| Text diff | 500 KiB. |
| Git status and staged copy-discovery output | Each command is capped at 2 MiB and 20,000 parsed records. |
| Other filesystem operations | One shared 3-second deadline per request. |
| Git commands | 5-second deadline per command. |

Search traverses breadth-first. Reaching the result, entry, directory, or depth cap returns a deterministic sorted prefix with an explicit truncation reason; the UI says more matches may exist. A deadline or inaccessible/transient subtree returns a retryable failure rather than a falsely complete partial result. Symlinks and special entries consume inspection budget but are never traversed.

Filesystem handles are closed after success, failure, or late completion. Git runs with argv arrays, `shell: false`, the canonical server-derived session cwd, and a `--` separator before pathspecs. Binary, too-large, and truncated results are explicit and are never presented as complete text.

## Implementation and verification

The pack manifest declares a singleton panel, two launcher entrypoints, and five allowlisted routes: `list`, `resolve`, `search`, `read`, and `diff`. `resolve` confirms a direct target and ancestor chain; `search` performs bounded whole-root discovery; the original routes retain lazy listing and preview/diff ownership. Built bundles ship from the explicit first-party allowlist; TypeScript under `market-packs/file-explorer/src/` is build input and is not copied into the distribution.

Focused coverage lives in the registered Test Suite v2 file-explorer tests:

- model tests pin canonical paths, deterministic tree/search ordering, search constants, Git parsing/decorations, and added-file diff synthesis;
- route tests pin direct resolution, substring search and every bound, root binding and namespace-swap failures, handle closure, filesystem/Git deadlines, Git states, and packaged parity;
- DOM tests cover breadcrumbs and path editing, stale-response fencing, search states and snapshot restoration, Git filtering, collapse focus, mouse/keyboard path menus, clipboard outcomes, accessibility, narrow layout, previews, and persisted versus transient state; and
- the browser journey covers built-in activation, launchers, direct unloaded-path navigation, breadcrumbs, recursive search, filtering, collapse, both copy forms, narrow layout, reload behavior, Git/non-Git previews and diffs, refresh behavior, and cleanup.
