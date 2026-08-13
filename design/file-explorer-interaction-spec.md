# File explorer interaction specification

Status: design handoff  
Scope: editable path bar, recursive filename search, tree controls, read-only path actions  
Baseline inspected: `market-packs/file-explorer/src/file-explorer-panel.ts`, its model/routes, current DOM and browser tests, and `docs/file-explorer.md`

<!--
This is an interaction specification, not an API design. Limits named in UI copy must come
from server response metadata so the interface does not invent a second source of truth.
-->

## 1. Design intent

Keep the explorer a compact, read-only inspection surface. Add discovery without turning it into an IDE sidebar full of unlabeled icons.

The controls form three levels:

1. **Panel header** — identity and Refresh.
2. **Path bar** — the current explorer location; spans the whole panel because it relates the tree and preview.
3. **Tree toolbar** — Search, Changed files only, and Collapse all; belongs inside the Files pane because these controls affect tree discovery.

The existing tree/preview split, Git badges, lazy-loading rows, preview tabs, and narrow Back-to-files flow remain intact.

## 2. Current behavior to preserve

- The panel is labelled **File explorer** and has a title, **Session files** subtitle, and Refresh action.
- Lazy rows use `tree` / `treeitem` / `group`, roving `tabindex`, `aria-selected`, `aria-expanded`, `aria-level`, and local `aria-busy`.
- Arrow, Home/End, Enter, and Space interactions follow the standard tree pattern.
- File selection opens the current read-only preview; directory activation expands/collapses it.
- At a panel width below 680 px, Files and Preview become separate panes. **Back to files** restores the row focus.
- Expanded paths, selected path, focused path, and File/Diff mode are persisted as canonical relative paths.
- Refresh, root/folder loading, empty, truncated, timeout, retry, binary, unsupported, deleted, and oversized states are explicit.
- Symlinks and special entries are visible leaves, never traversed or previewed. `.git` stays excluded.

## 3. Information architecture and visual layout

### 3.1 Panel header

Keep the existing 44 px (`2.75rem`) header and current typography:

- left: **Explorer**, with **Session files** as muted secondary text;
- right: existing **Refresh explorer** icon button.

Do not put Search or Changed files only into the panel header. They affect only the Files pane and would appear available while the narrow Preview pane is active.

### 3.2 Path bar

Place one 36 px row immediately below the panel header, above the tree/preview content split. It contains:

- a horizontally scrollable breadcrumb region;
- a trailing **Edit path** icon button with tooltip `Edit path (Ctrl+L)`.

Use the current `--card`, `--border`, `--foreground`, `--muted-foreground`, and `--primary` tokens. Use the explorer's current 13 px base type and the preview path's monospace stack only in text-entry mode. Segment buttons use the normal UI font.

### 3.3 Files toolbar

Replace the passive **Files** section label with a labelled toolbar (`aria-label="File explorer controls"`) at the top of the Files pane:

- Search occupies remaining width and never shrinks below 120 px.
- **Changed files only** is a toggle button.
- **Collapse all** is a command button.

At a Files-pane width of 360 px or greater, show icon + text on the two buttons. Below 360 px, show icon only while retaining the full accessible name and native tooltip. Buttons are 32 × 32 px; the search field is 32 px high. This compact toolbar is a desktop side-panel exception to 44 px touch targets, but remains above the WCAG 2.5.8 minimum of 24 px.

## 4. Editable path bar

### 4.1 Location model

The displayed location is the explorer's current target:

- selected file when a preview is open;
- otherwise the focused directory or leaf;
- session root when there is no row target.

Arrowing through the tree updates breadcrumbs to the focused row without selecting or previewing it. Opening a file makes that file the current target. A successful direct path navigation becomes the current target.

The root is never shown as an absolute folder name. The first breadcrumb is a home/folder icon with visible label **Session files** when space permits and accessible name **Session root**. Its target is the empty canonical relative path.

### 4.2 Breadcrumb mode

- Breadcrumbs form a `nav` labelled **Current path**.
- Every segment is a real button and participates in normal Tab order.
- Separators are decorative (`aria-hidden="true"`).
- The final segment has `aria-current="location"`.
- Each segment's accessible name includes context, for example `Go to src` or `Current file, server.ts`.
- Activating a root/directory segment lazily reveals and focuses that directory in the tree. Activating the final file segment reveals and opens it.
- Keyboard activation uses Enter or Space through native button behavior.
- A focused breadcrumb may use Left/Right to move to the previous/next breadcrumb button; this is an enhancement, not the only means of navigation.
- Clicking unused breadcrumb-row space or the trailing Edit button enters text-entry mode.

Long paths stay on one line. The breadcrumb strip scrolls horizontally rather than wrapping. On location changes, scroll the final segment into view. Keep the root reachable by manual horizontal scrolling and show subtle token-based edge fades only when content is clipped. Do not truncate individual segment labels below 48 px; apply ellipsis and expose the full segment in `title`.

### 4.3 Entering text-entry mode

The following enter edit mode:

- Edit path button;
- click on unused breadcrumb-row space;
- `Ctrl+L` on Windows/Linux or `Cmd+L` on macOS while focus is anywhere inside the explorer panel.

The shortcut must call `preventDefault()` only when the explorer panel owns focus, so it does not steal the browser address-bar shortcut globally.

In edit mode:

- replace the breadcrumbs and Edit button with one input;
- label it **Relative path**;
- populate it with the current canonical relative path (empty string at root);
- select all text on entry;
- show a leading non-editable **Session files /** affordance only visually; it must not be part of the submitted value;
- use placeholder `e.g. src/server/server.ts`;
- set `aria-describedby` to concise help: `Enter a path relative to the session root.`

Do not persist the draft.

### 4.4 Submit, cancel, and validation

**Enter** submits. Trim outer whitespace, but do not silently rewrite separators, dot segments, duplicated slashes, absolute paths, or case. The value must already be a canonical relative path. Empty input targets session root.

While resolving:

- keep the input value visible;
- disable repeat submission;
- show an inline spinner and `aria-busy="true"` on the path control;
- announce `Opening <path>…` politely.

On success:

- directory: expand every ancestor, load missing lazy levels in order, reveal and focus the directory row; do not open a preview;
- regular file: expand/load ancestors, reveal and select the file, then open the existing preview;
- symlink/special leaf: reveal and focus it, but do not preview it; announce that it cannot be opened;
- switch back to breadcrumb mode only after the target is resolved;
- in the narrow layout, directory navigation ends in Files; file navigation ends in Preview.

**Escape** cancels edit mode, restores the pre-edit breadcrumbs/location, and returns focus to the Edit path button. Blur does not submit or cancel; this prevents accidental loss when users inspect an error or use another control.

On failure, stay in edit mode, preserve the typed value and current tree selection/preview, set `aria-invalid="true"`, and show one inline error below the input. Move no focus. Announce the error assertively once.

Use these user-facing distinctions:

| Condition | Inline copy | Retry |
|---|---|---|
| non-canonical, absolute, `..`, backslash, duplicated slash, `.git` | `Enter a canonical path relative to Session files.` | No |
| missing | `No file or folder exists at this path.` | No |
| expected directory but resolved file mismatch | `This path is not a folder.` | No |
| unsupported/special target | `This item cannot be opened. It can still be revealed in the tree.` | No |
| timeout | `Path lookup timed out.` | Yes, keep value |
| temporary read failure | `Could not open this path.` | According to route metadata |

A retry is a small **Retry** button next to the error and repeats the exact draft. Errors clear as soon as the user edits the value.

## 5. Recursive filename search

### 5.1 Field and request behavior

Use an input labelled **Search files and folders**, with visible placeholder `Search files and folders…`, leading Search icon, and trailing **Clear search** button whenever non-empty. Match the existing sidebar `SearchBox` visual grammar: 32 px field, border-input token, transparent background, primary/ring focus, leading icon, trailing clear action.

- Debounce input by 200 ms, matching the current `SearchBox` primitive.
- Empty value makes no request and shows the normal tree.
- Every non-empty value is valid, including one character.
- Match case-insensitively against server-returned canonical relative paths.
- Give each request a monotonically increasing generation; only the newest generation may alter loading, results, count, errors, or announcements.
- A late response after clear must also be ignored.
- Search is never persisted.

### 5.2 Results presentation

While a query is active, replace only the scrollable tree body with results. Keep the toolbar and preview visible. Snapshot expanded paths, focused path, selected path, and preview mode before the first query so clear can restore them.

The search input is a `combobox` with `aria-autocomplete="list"`, `aria-controls` pointing to a `listbox`, and `aria-expanded="true"` while query UI is shown. Use `aria-activedescendant` for the active result so typing focus remains in the field.

Each result is an `option` with:

- file/folder/symlink/special icon;
- matching filename as the primary line;
- parent relative path as a muted, ellipsized secondary line (`Session files` for root children);
- existing Git badges when available;
- full relative path in `title` and the accessible name, e.g. `server.ts, in src/server`.

Duplicate names are therefore distinguishable without exposing absolute paths. Search result rows are at least 40 px high.

### 5.3 Search keyboard and pointer behavior

| Input | Behavior |
|---|---|
| `ArrowDown` | Activate the first/next result; wrap from the last to first. |
| `ArrowUp` | Activate the last/previous result; wrap from first to last. |
| `Home` / `End` | Normal text editing unless `Ctrl/Cmd` is also held; `Ctrl/Cmd+Home/End` selects first/last result. |
| `Enter` | Open/reveal the active result. With no active result, activate the first result. |
| `Escape` | Clear search and restore the pre-search tree state; keep focus in the now-empty Search field. A second Escape may blur it. |
| `Tab` | Move normally to Clear/Changed/Collapse controls; it does not select a result. |

Pointer click opens/reveals the clicked result. Focus remains in Search for keyboard activation; pointer activation may move focus to the revealed tree row in the Files pane.

Selecting a file result opens its existing read-only preview while results and query remain visible. Selecting a directory result reveals it in the lazy tree, expands ancestors, and then clears search because the requested destination is the tree itself. Symlinks/special results reveal as non-traversable leaves.

For file results, explicit Clear/Escape returns to the exact pre-search tree expansion, selection, preview, and path-bar location. This makes Search a reversible inspection mode. If the user wants the searched file anchored in the tree, a secondary **Reveal in tree** action appears on the active result; it expands ancestors, promotes that file to the normal tree selection, clears the query, and focuses its row.

Direct path navigation while Search is active first cancels Search, restores its snapshot, and then resolves the submitted path.

### 5.4 Search status states

Use one polite live region for settled counts/status and avoid announcing each keystroke.

| State | Visible treatment | Announcement |
|---|---|---|
| debounce | No spinner for the first 200 ms | None |
| loading | spinner + `Searching…`; listbox `aria-busy=true` | `Searching Session files.` after debounce |
| results | count beside/under field, e.g. `23 results`; list of options | `23 results for config.` |
| empty | Search icon + `No files or folders match “config”.` | same |
| truncated | `Showing the first <cap> results` plus `More matches exist. Refine your search.` | include `Results truncated.` |
| timeout | inline error `Search timed out.` + **Retry** | assertive once |
| retryable error | `Couldn’t search Session files.` + **Retry** | assertive once |
| non-retryable error | same without Retry | assertive once |

The cap shown in copy comes from route metadata. Never hard-code a different cap in the panel. Loading a new query removes old options so stale results cannot be mistaken for matches to the new text.

## 6. Changed files only

Use a toggle button labelled **Changed files only**, with a Git/change-filter icon and `aria-pressed`. An active state uses primary-tinted background, primary border/text, and a visible check indicator; color is not the only cue. Tooltip repeats the label in icon-only mode.

Behavior:

- Filters the normal tree to changed files, changed directories, Git virtual deleted paths, and all parent chains required to reach them.
- Directories with descendant changes remain navigable even if they are unchanged themselves.
- Existing Git badges and ancestor dots remain unchanged.
- If Git data is unavailable/non-repository, disable the control and expose reason `Changed files are unavailable because this folder is not a Git worktree.` Do not display a Git error in the tree.
- Enabling the filter snapshots the unfiltered expansion/focus/selection. Preserve expansions that still exist in the filtered tree.
- If the focused row is hidden, move focus to its nearest visible ancestor, then first visible row. The selected preview may remain open even when its unchanged row is hidden; it reappears selected when the filter is turned off.
- Selecting a changed file while filtered promotes it as the current selection when the filter is later turned off.
- Empty state: `No changed files.` followed by muted text `Working tree changes will appear here.`
- Announce `Showing changed files only, <n> changed files.` or `Showing all files.`

Recursive Search always searches the whole session root as promised by its label, independent of this tree filter. While results are shown, keep the filter visually active but add `Search includes all files` to the count/status line. Revealing an unchanged search result in the tree turns Changed files only off and announces why.

Persist the boolean preference because it is a durable view choice. Restore it only after fresh Git status arrives; never render stale filtered paths from storage.

## 7. Collapse all

Use one command button labelled **Collapse all** in the Files toolbar.

- Disable it when no directory is expanded; expose the native disabled state and tooltip.
- On activation, collapse every directory in one render and retain the selected file/preview as the logical selection. If the selected row becomes hidden, it must regain `aria-selected=true` when its ancestors are later expanded.
- Keep keyboard focus in the tree when Collapse all was invoked with a shortcut/context; for toolbar activation, return focus to the nearest visible ancestor of the previously focused row, or the first top-level row. Do this after rendering.
- If the previously focused row is top-level, keep focus on it.
- Announce `All folders collapsed.` Do not announce every collapsed directory.
- Do not erase the user's stored selected file or preview mode.

The action intentionally changes the persisted expansion set to empty.

## 8. Row context menu and copy feedback

### 8.1 Invocation and target

Every file, directory, symlink, special, and virtual-deleted row supports:

- pointer `contextmenu` (right click);
- `Shift+F10`;
- the Context Menu key (`event.key === "ContextMenu"`).

Prevent the browser menu only when invoked on an explorer row. The invoked row becomes a temporary visual context target but does **not** change the tree's selected path, focused path, expansion, or preview. Keyboard invocation targets the focused row. Pointer invocation targets the row under the pointer while preserving the previously focused element.

Position pointer menus at the pointer. Position keyboard menus against the invoking row's lower start edge. Clamp within the panel/viewport with 8 px clearance.

### 8.2 Menu semantics and keyboard behavior

Render a popover surface using `--popover`/`--background`, `--border`, 8 px radius, and the same 4 px padding / 2 px gap / 13 px menu typography as `SidebarActionsPopover`.

The menu is labelled **Path actions** and contains only:

1. **Copy relative path**
2. **Copy filename**

No separators, disabled mutation items, download, or external-editor actions.

Use `role="menu"`, `role="menuitem"`, and roving focus. On open, focus the first item.

| Key | Behavior |
|---|---|
| Up/Down | Move and wrap between items. |
| Home/End | First/last item. |
| Enter/Space | Run focused action. |
| Escape | Close without action and restore focus. |
| Tab/Shift+Tab | Close, restore the invocation focus, then allow normal tab movement. |
| `c`, then `r`/`f` typeahead | Optional; do not replace arrow navigation. |

Outside pointer-down, panel deactivation, resize that detaches the target, or another context invocation closes the menu. Closing removes the temporary context-target style.

Keyboard close/action returns focus to the invoking row. Pointer close/action returns focus to whichever explorer element had focus before invocation; it must never select the right-clicked row as a side effect.

### 8.3 Copied values

- **Copy relative path** copies the row's canonical relative `path`, with `/` separators.
- **Copy filename** copies the final canonical path segment, including its extension.
- Virtual deleted rows behave exactly like present rows.
- Never copy an absolute root, native separator path, display ellipsis, rename source path, or breadcrumb label.

### 8.4 Success and failure feedback

After activation, close the menu.

Success:

- show a compact non-modal status above the tree for about 2 seconds: `Relative path copied` or `Filename copied`;
- announce the same text through the existing polite live region;
- do not move selection or preview.

Failure:

- show a persistent inline error above the tree: `Couldn’t copy. Clipboard access is unavailable.` with a dismiss button;
- announce it assertively;
- preserve the value only in memory; do not expose a new editable path field or alter the read-only product model;
- closing/dismissing the message returns focus to the prior row/control if dismissal was keyboard-triggered.

Do not report success until the clipboard operation resolves successfully. A legacy safe copy fallback may be used, but a false return is failure, not success.

## 9. Narrow and constrained layouts

### 9.1 Existing responsive breakpoint

Retain the current root-width breakpoint at 680 px:

- **Files pane** shows path bar + Files toolbar + tree/search.
- Opening a file switches to **Preview pane**.
- The panel header and path bar remain visible in both panes.
- **Back to files** remains the first preview control and restores focus to the originating row/search result as applicable.

Search result file activation switches to Preview. Back returns to the still-active query and active result. Clearing Search after Back restores the pre-search tree snapshot.

### 9.2 Width adaptations

- Below 480 px root width, hide the visible **Session files** subtitle in the header; its meaning remains in the path root breadcrumb.
- Below 360 px Files-pane width, Changed and Collapse use icon-only visual treatment with full `aria-label` and tooltip.
- Below 300 px, Search stays on the first row and the two action buttons wrap to a second right-aligned row. Do not shrink the input below 120 px.
- Breadcrumbs never wrap. Entry mode uses the full row and moves the visual `Session files /` prefix into a compact root icon if necessary.
- Context menus size to `min(240px, viewport width - 16px)` and never overflow either axis.
- Result parent paths and tree names use ellipsis; badges and disclosure affordances never shrink away.

At 200% zoom, controls may wrap vertically. Do not clip toolbar rows with fixed heights.

## 10. Focus order and screen-reader contract

Normal Files-pane Tab order:

1. Refresh explorer
2. breadcrumb segment buttons, then Edit path (or Relative path input)
3. Search files and folders
4. Clear search, when present
5. Changed files only
6. Collapse all
7. tree roving-focus item (or Search remains the composite focus owner while results are active)
8. preview controls/content as currently implemented

In narrow Preview, hidden Files controls are removed from sequential focus with the hidden pane. Back to files comes before preview tabs/content.

Use the existing polite live region for routine completion/count/copy messages. Add a separate assertive region or temporarily switch semantics for validation, search, and clipboard failures. Clear then set repeated text so identical later actions are announced. Do not announce focus changes already conveyed by native tree/listbox semantics.

Accessible names must not include absolute paths. Full canonical relative paths are appropriate and necessary.

## 11. Persistence and restoration

Persist:

- expanded canonical directory paths;
- selected canonical file path;
- focused canonical row path;
- File/Diff mode;
- Changed files only boolean.

Never persist:

- path-entry mode or its draft/error;
- Search query, results, active result, count, loading/error state;
- context-menu open state/target;
- copy success/failure message.

On reload:

1. render a neutral loading tree, breadcrumb root, and empty Search;
2. fetch current root + Git state;
3. validate/restitch stored expansions and selected/focused paths through lazy loads;
4. apply Changed files only only against current Git data;
5. restore preview and narrow pane using current behavior.

A stale selected path is pruned as today. A stale expanded path is removed. Never show a stored path-edit or query even for one frame.

## 12. State interaction rules

These rules avoid ambiguous combinations:

- Refresh cancels any in-flight Search response generation but keeps the query and immediately reruns it after root status refresh. Path lookup generations are also fenced.
- Entering path edit while Search is active cancels Search and restores its snapshot before editing.
- Opening Search while path edit is active cancels the draft exactly like Escape.
- Changed files only may be toggled while Search is active, but affects the restored tree only; status text says Search includes all files.
- Collapse all is disabled while Search results replace the tree because the action would have no visible effect. Its stored expansion state is unchanged until Search clears.
- Context menu closes before any tree rerender, Refresh, Search transition, path navigation, filter change, or Collapse all.
- Root/folder local loading and retry behavior remains local; Search route errors never replace the normal tree snapshot.

## 13. Consistency rationale

| Existing primitive | Decision |
|---|---|
| `.bb-explorer-toolbar`, 44 px, `--card` + bottom border | Keep exactly for panel identity and Refresh. |
| `.bb-explorer-refresh` icon-button grammar | Reuse dimensions, transparent border, hover tint, primary focus outline, disabled opacity, tooltip/accessibility pattern for Edit/Changed/Collapse/Clear where applicable; increase tree-toolbar commands to a consistent 32 px. |
| `.bb-explorer-button` bordered text button | Reuse for Retry and dismiss actions. |
| Current tree rows | Preserve height, indentation, disclosure/icon/name/badges ordering, selected/focus visuals, and all ARIA tree semantics. Context targeting adds only a non-selection outline. |
| `SearchBox` | Match its 200 ms debounce, leading Search icon, trailing Clear, input border/ring tokens, Escape clear behavior, and 12 px input type. The explorer cannot directly reuse the Lit element inside the pack, so visual/interaction parity is the requirement. |
| `SidebarActionsPopover` | Match role semantics, 4 px menu padding, 2 px gap, 8 px radius, 13 px type, popover tokens, hover/focus accent, and roving keyboard model. |
| `.bb-explorer-live` | Reuse for polite completion/status messages; add an assertive equivalent only for actionable failures. |
| Narrow Back-to-files flow | Extend rather than replace; Search and path navigation remember the correct origin focus. |

New rows are justified only where no current peer fits: the full-width path bar is a location/navigation primitive shared by tree and preview; the Files toolbar groups all tree-scoped discovery controls rather than scattering them into the global header.

## 14. Acceptance checklist for implementation review

- Breadcrumb root never leaks an absolute path; every segment is keyboard reachable.
- `Ctrl/Cmd+L` is scoped to explorer focus, selects canonical relative text, and Escape fully restores prior state.
- Invalid path errors preserve selection/preview and draft.
- Direct navigation loads initially unloaded ancestors and ends with deterministic focus/pane.
- Search covers server-root names rather than loaded DOM nodes, debounces at 200 ms, and fences stale/cleared responses.
- Search exposes loading, count, empty, truncated, timeout, retryable error, and clear behavior without stale options.
- Duplicate results include parent context; symlinks/specials remain leaves.
- Changed files only includes virtual deletions and parent chains, has `aria-pressed`, persists, and handles non-Git/empty states.
- Collapse all returns a valid focus target and retains the logical selected preview.
- Mouse and keyboard context menus do not mutate selection/focus; menu keyboard behavior and focus return are complete.
- Both copy actions copy canonical values, announce actual success, and show a persistent failure state.
- At <680 px, file activation/Back/search restoration work as a coherent two-pane journey.
- At 200% zoom and 300 px width, controls wrap instead of clipping; paths remain horizontally usable.
- Only durable view preferences restore; no query, edit draft, error, menu, or toast flashes after reload.
- No mutation, download, drag/drop, or external-editor affordance is introduced.
