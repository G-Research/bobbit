# Browse Source Filter UX

Status: proposed  
Owner: Browse Filter Menu goal  
Scope: Marketplace Browse tab source filtering only. Replace source chips with a clearer checkbox menu while preserving existing browse search and selection semantics.

## Proposal

Replace the current `All` / `None` / per-source chip row with a compact **Sources** dropdown placed in the same `market-browse-controls` group as search.

Recommended layout:

```text
[ Search packages, descriptions, sources, operations…          × ]
[ Sources ▾ ]  Showing 12 packs from 3 sources
```

- The search input remains first and full-width.
- The source control sits below search in the existing controls block, matching current vertical rhythm.
- The summary text is always visible, so users can understand the active filter without opening the menu.

## Menu trigger

Trigger label:

- Default: `Sources`
- Optional count suffix when helpful: `Sources (3)` where `3` is selected selectable sources.
- Use the existing button styling foundation (`market-btn` shape, border, hover, focus) rather than chip styling.

Accessible name:

- `aria-label="Filter packages by source"`
- `aria-haspopup="menu"` or `aria-haspopup="dialog"` depending on implementation pattern
- `aria-expanded="true|false"`
- `aria-controls="market-browse-source-menu"`

## Summary text

Place summary text immediately next to the trigger, using muted helper text styling.

Suggested wording:

- `Showing 12 packs from 3 sources`
- `Showing 4 packs from 1 source`
- `No sources selected`
- `No packages match the current filters`
- While initial browse data is loading: `Loading sources…`

Counts should reflect the currently visible browse result after source filtering and search when possible. If implementation separates source and search counts, prefer clarity: `12 packs from 3 selected sources`.

## Menu content

Menu structure:

```text
Sources
Select all    Clear
────────────────────
☑ Built-in packs        8
☑ MCP Gateway           4   Warning
☐ Team packs            0   Loading…
☐ Legacy registry       Unsupported
```

### Bulk actions

- `Select all`: selects every source where `status !== "unsupported"`.
- `Clear`: clears all selected sources.
- Keep both actions visible at the top of the menu.
- Disable `Select all` only when all supported sources are already selected or no supported sources exist.
- Disable `Clear` only when no sources are selected.

Stable test ids:

- `market-browse-source-menu-trigger`
- `market-browse-source-summary`
- `market-browse-source-menu`
- `market-browse-source-select-all`
- `market-browse-source-clear`

## Checkbox row layout

Each source row is a real checkbox row, not a pill button.

Row content:

1. Checkbox control
2. Source display name
3. Package count
4. Status indicator when applicable

Recommended DOM/test hooks:

- `data-testid="market-browse-source-option"`
- `data-source-id="<sourceId>"`
- Checkbox: `data-testid="market-browse-source-checkbox"`
- Count: `data-testid="market-browse-source-count"`
- Status: `data-testid="market-browse-source-status"`

Behavior:

- Clicking the row toggles the checkbox, except disabled unsupported rows.
- Unsupported rows are visible but disabled, with `aria-disabled="true"` and native checkbox `disabled`.
- Errored rows remain selectable; if selected, existing warning behavior remains visible outside the menu.
- Loading rows remain selectable if supported, but show `Loading…` so users understand counts may change.

Status labels:

- Loading: `Loading…`
- Error: `Warning` or `Load failed`
- Unsupported: `Unsupported`

Do not rely on color alone. Pair status color with text and, if icons are used, include accessible labels.

## Keyboard behavior

Minimum behavior:

- `Tab` focuses the Sources trigger after the search input.
- `Enter` or `Space` opens the menu.
- `Escape` closes the menu and returns focus to the trigger.
- `Tab` moves through bulk actions and checkboxes in natural DOM order.
- `Space` toggles the focused checkbox.
- `Enter` activates bulk action buttons.
- Closing the menu must not reset search or source selections.

Preferred enhancement:

- Arrow keys move between checkbox rows while the menu is open.
- `Home` / `End` move to first / last row.

## Screen-reader behavior

- The trigger announces current state: collapsed/expanded.
- The menu has a visible title `Sources` and an accessible label, e.g. `aria-label="Browse source filters"`.
- Each checkbox label includes source name and count, e.g. `Built-in packs, 8 packages`.
- Status is included in the accessible label or description, e.g. `MCP Gateway, 4 packages, load warning`.
- Summary text should be available as normal text and may use `aria-live="polite"` if counts update after a refresh.
- Keep source warnings outside the menu as persistent content so selected errored sources remain discoverable after the menu closes.

## Empty states

Replace chip-specific language.

- No marketplace sources configured: `No marketplace sources yet. Add a source in Sources, then return to Browse.`
- No selected sources: `No sources selected. Open Sources and select at least one source to browse packages.`
- All selected sources failed: `Could not load the selected sources. Check the source warnings above.`
- Selected sources returned no packages: `Selected sources returned no supported packages.`
- Single selected source returned no packages: `<Source name> returned no supported packages.`
- Search has no matches: `No packages match “<query>” in the selected sources.`
- Generic no matches: `No packages match the current filters.`

## Edge cases

- **Newly discovered supported sources**: keep current semantics. They become selected by default on refresh when they were not previously known.
- **Unsupported sources**: show in the menu as disabled unchecked rows with `Unsupported`; exclude from `Select all`.
- **Errored selected sources**: keep selected, show row status, and preserve the existing warning block outside the menu.
- **Loading sources**: show `Loading…` in the row and `Loading sources…` in the summary when appropriate. Preserve current selection until refreshed data resolves.
- **Zero supported sources**: keep menu usable for inspection; disable `Select all`, keep `Clear` enabled only if any stale selected source exists.
- **Long source names**: truncate the visual name with tooltip/title, but keep the full name in the accessible label.

## E2E coverage targets

Recommended stable selectors:

- `market-browse-controls`
- `market-browse-search`
- `market-browse-search-clear`
- `market-browse-source-menu-trigger`
- `market-browse-source-summary`
- `market-browse-source-menu`
- `market-browse-source-select-all`
- `market-browse-source-clear`
- `market-browse-source-option`
- `market-browse-source-checkbox`
- `market-browse-source-count`
- `market-browse-source-status`
- Existing warnings/error ids may remain: `market-browse-source-warnings`, `market-browse-error`.

Test scenarios:

1. Open the Sources menu and verify checkbox rows render with names, counts, and statuses.
2. Toggle an individual source and verify package list and summary update.
3. Use `Select all` and `Clear` and verify unsupported sources are not selected.
4. Type in search while sources are selected and verify filtering behavior is unchanged.
5. Refresh/re-render Browse and verify existing selected sources persist while newly discovered supported sources become selected by default.
6. Verify selected errored sources show warnings outside the menu.
7. Verify keyboard open, toggle, bulk action activation, and Escape close behavior.

## Consistency rationale

- Reuse the existing Browse controls container instead of introducing a new section.
- Reuse existing button/input visual language (`market-input`, `market-btn`) and muted helper text patterns.
- Replace only the ambiguous chip pattern; do not alter package cards, install scope picker, search behavior, or warning placement.
- The menu makes selection state explicit, separates filter state from bulk actions, and keeps source health visible without increasing default screen noise.
