# Built-in file explorer

The file explorer is a read-only side panel for inspecting the files used by an agent session. It ships as the first-party `file-explorer` Extension Host pack rather than core UI, so the same panel, route, activation, and persistence contracts available to other trusted packs support a production feature.

## Open and restore the explorer

Open the explorer from either surface in an active session:

- choose **Open File Explorer** from the session actions menu; or
- run `/files` from the composer slash menu.

Both launchers target the same singleton panel. Opening it again focuses the existing explorer for that session rather than creating another panel. The panel workspace restores it after a page reload. The pack separately stores a versioned, relative-only UI record containing valid expanded directories, the selected and focused paths, and the active `File` or `Diff` view.

The pack is enabled by default. It appears in Market under **Built-in (shipped)** and cannot be uninstalled or updated independently of Bobbit. Disabling it removes both launchers; re-enabling it restores them.

## Session root and trust model

The explorer root is always the bound session's server-derived working directory. For worktree sessions this is the worktree; otherwise it is the session cwd. Route requests contain only canonical relative paths and never accept a root, cwd, repository id, or absolute path.

This protocol rule prevents accidentally browsing a caller-selected root, but it is not a new filesystem security boundary. The first-party route module runs in the same trusted, confined Extension Host worker tier as other pack server modules:

- the worker provides resource and crash isolation, including termination on its host deadline;
- trusted server code still has ambient Node.js filesystem and child-process access;
- module imports must remain within the pack root; and
- the browser panel uses only the mediated Host API (`host.callRoute`, `host.store`, and `host.session`).

The pack adds no filesystem capability layer or path-confinement mechanism. It treats symlinks and special entries as leaves: they can appear in the tree but cannot be expanded or previewed. Dotfiles remain visible. Repository metadata named `.git` is omitted from listings and rejected by direct list, read, and diff requests.

See [Extension Host authoring](extension-host-authoring.md#worked-example-the-file-explorer-first-party-pack) for the reusable pack pattern and [Marketplace](marketplace.md#built-in-first-party-packs) for built-in activation and shipping.

## Tree behavior

Directories load only when expanded. Each directory listing is ordered with directories first, then by a stable case-insensitive alphabetical comparison with deterministic ties.

The tree exposes `tree`, `treeitem`, and `group` semantics, roving focus, selected and expanded state, and busy state while loading. Keyboard controls are:

| Key | Behavior |
|---|---|
| `Arrow Up` / `Arrow Down` | Move through visible rows. |
| `Arrow Right` | Expand a directory, or move to its first child when already expanded. |
| `Arrow Left` | Collapse a directory, or move to its parent. |
| `Home` / `End` | Move to the first or last visible row. |
| `Enter` / `Space` | Expand or collapse a directory, or open a file preview. |

On narrow panels, choosing a file switches from the tree to the preview. **Back to files** restores the tree and its focus. Loading, empty, truncated, and retryable error states remain local to the affected directory.

## Git decorations

At root refresh, the pack reads Git status relative to `HEAD`. It displays no decorations or Git failure state outside a Git repository, so the panel remains a normal file browser. In a repository, it supports:

| Badge | Meaning |
|---|---|
| `M` | Modified or type-changed. |
| `A` | Added. |
| `D` | Deleted. |
| `R` | Renamed. |
| `C` | Copied. |
| `?` | Untracked. |
| `!` | Conflicted. |

Tracked files may show separate accessible staged and unstaged badges, including mixed states. Rename and copy destinations identify their old/source path. Copy detection includes a staged, retained-source copy even when the user's `status.renames` configuration is disabled. The unchanged source remains unchanged in the tree; only the destination receives `C`. Directories containing changes receive an ancestor indicator.

Deleted paths no longer present on disk are represented as virtual tree entries, including any missing parent chain, so their `HEAD` diff remains selectable. If bounded Git status or copy discovery fails, browsing continues without decorations for that refresh rather than replacing the filesystem tree with a Git error.

## Read-only file and diff preview

Selecting a regular text file opens its working-tree contents with a relative path, **Read only** label, line numbers, and syntax highlighting for common source and data formats. There is no editor, create, rename, delete, drag-and-drop, or other mutation surface. Empty, binary, unsupported, deleted, oversized, loading, and read-error states are explicit.

A changed file adds `File` and `Diff` tabs. `File` shows the working-tree file; deleted files default to `Diff`. `Diff` is one complete working-tree-versus-`HEAD` comparison, so staged and unstaged changes appear together rather than as concatenated partial diffs. The view preserves rename and copy metadata and handles deleted, binary, metadata-only, empty, and oversized results explicitly.

Untracked files and files in a repository with an unborn `HEAD` have no tracked baseline. For text files, the route synthesizes a standard new-file unified diff from `/dev/null`; empty and binary files receive their own states. The panel parses unified output through the shared Git diff parser rather than maintaining another parser.

## Refresh lifecycle

Use **Refresh explorer** to recompute the root listing, Git status, expanded directory listings, and the selected preview. A refresh preserves the selected file and valid expanded directories where possible and discards paths that disappeared.

The panel also subscribes to the bound session's status. The first observed `idle` event triggers one refresh; later transitions from a non-idle state back to `idle` do the same, which makes agent-created changes visible without a filesystem watcher. Consecutive `idle` events do not repeatedly refresh. Generation checks prevent older list or preview responses from repainting newer selections or refreshes.

## Responsiveness limits

The routes bound work so an unusually large or slow tree cannot monopolize the worker or panel:

| Operation | Limit |
|---|---|
| Directory list | 1,000 returned entries per directory; additional entries set `truncated`. |
| File preview | 1 MiB. |
| Text diff | 500 KiB. |
| Git status and staged copy-discovery output | Each command is capped at 2 MiB and 20,000 parsed records. |
| Filesystem operations | 3-second shared deadline per request. |
| Git commands | 5-second deadline per command. |

Filesystem handles are closed after success, failure, or late completion. Git runs with argv arrays, `shell: false`, the server-derived session cwd, and a `--` separator before pathspecs. Timeout responses are retryable; binary, too-large, and truncated results are explicit and are never presented as complete text.

## Implementation and verification

The pack manifest declares a singleton panel, the two launcher entrypoints, and three allowlisted routes: `list`, `read`, and `diff`. Built bundles ship from the explicit first-party allowlist; the TypeScript under `market-packs/file-explorer/src/` is build input and is not copied into the distribution.

Focused coverage lives in the registered Test Suite v2 file-explorer tests:

- core model tests cover relative paths, ordering, Git parsing and decoration, and added-file diff synthesis;
- route tests cover session-root behavior, filesystem/Git limits and deadlines, non-Git and unborn repositories, Git states, and diff output kinds;
- DOM tests cover accessibility, mouse and keyboard navigation, local errors, preview modes, stale-response fencing, responsive behavior, and restoration; and
- the browser journey covers built-in activation, both launchers, singleton/reload behavior, Git and non-Git projects, preview/diff states, manual refresh, idle refresh, and cleanup.
