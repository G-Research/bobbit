# Marketplace Browse source filter technical design

## Scope

Replace the Browse tab source chip row in `src/app/marketplace-page.ts` with an explicit `Sources` checkbox menu. Keep the existing Browse search input, pack filtering semantics, source discovery semantics, and warning behavior.

This design is based on:

- `src/app/marketplace-page.ts`
- `src/app/marketplace.css`
- `tests/e2e/ui/marketplace.spec.ts`
- `tests/e2e/ui/marketplace-mcp.spec.ts`

## Current implementation

### State

`src/app/marketplace-page.ts` owns Browse state as module globals:

```ts
let browseSources: MarketplaceBrowseSourceState[] = [];
let browsePacks: BrowsePackWire[] = [];
let enabledBrowseSourceIds = new Set<string>();
let browseSearch = "";
let browseError = "";
let browseLoading = false;
```

`MarketplaceBrowseSourceState` is declared in `src/app/api.ts`:

```ts
interface MarketplaceBrowseSourceState {
  sourceId: string;
  sourceName: string;
  sourceType: "builtin" | StoredMarketplaceSourceType;
  builtin?: boolean;
  status: "ok" | "loading" | "error" | "unsupported";
  error?: string;
  lastSyncedAt?: string;
}
```

`BrowsePackWire.source.id` is the pack-to-source join key used by Browse filtering.

### Source discovery and default selection

`loadBrowse()` fetches `/api/marketplace/browse?projectId=...` through `browseMarketplace(currentProjectId())`.

On success it replaces `browseSources` and `browsePacks`, then rebuilds `enabledBrowseSourceIds`:

```ts
const before = new Set(enabledBrowseSourceIds);
const knownBefore = new Set(browseSources.map((src) => src.sourceId));
const hadPriorSelection = before.size > 0;
for (const src of browseSources) {
  if (src.status === "unsupported") continue;
  if (!hadPriorSelection || before.has(src.sourceId) || !knownBefore.has(src.sourceId)) enabled.add(src.sourceId);
}
enabledBrowseSourceIds = enabled;
```

Important semantics to preserve:

- First Browse load enables every non-unsupported source by default.
- After a user has at least one selected source, refresh preserves selected known sources.
- Newly discovered supported sources are enabled by default.
- Unsupported sources are excluded from automatic selection and bulk select.
- Error sources are still selectable and selected errored sources drive warnings.
- A completely cleared selection (`before.size === 0`) currently looks the same as “no prior selection” on the next `loadBrowse()`, so a full Browse reload re-enables supported sources. Within normal re-renders, Clear persists because no fetch occurs.

Server-side source status is produced by `src/server/server.ts` in `GET /api/marketplace/browse`:

- Built-in source is always included first with `status: "ok"`.
- Stored sources are browsed sequentially.
- Legacy `mcp-registry` sources are returned as `status: "unsupported"` and no packs.
- Browse failures are returned as `status: "error"` and no packs for that source.
- The type includes `"loading"`, but the current endpoint returns only after the full browse finishes; retain UI support for future/optimistic loading states.

### Current functions/data flow

#### `filteredBrowsePacks()`

Filters by selected source first, then query text:

```ts
const sourceId = browsePackSourceId(pack);
if (!sourceId || !enabledBrowseSourceIds.has(sourceId)) return false;
return !query || browsePackSearchText(pack).includes(query);
```

The search text includes pack metadata, source metadata, contents, descriptions, and MCP operation metadata.

#### `toggleBrowseSource(sourceId)`

Clones `enabledBrowseSourceIds`, toggles the provided id, assigns the clone, then calls `renderApp()`.

Current caveat: the function does not validate unsupported state. Today unsupported chip buttons are disabled, so callers cannot toggle them from the UI. Preserve that guard either in the UI or add a defensive check.

#### `setAllBrowseSources(enabled)`

When `enabled` is true, selects every source with `status !== "unsupported"`; when false, clears the set; then calls `renderApp()`.

#### `renderBrowseControls()`

Currently:

1. Builds `countBySource` from `browsePacks`.
2. Computes `allEnabled` across non-unsupported sources.
3. Renders:
   - search input: `data-testid="market-browse-search"`
   - search clear button: `data-testid="market-browse-search-clear"`
   - chip row: `data-testid="market-browse-source-chips"`
   - `All` button: `data-testid="market-source-chip-all"`
   - `None` button: `data-testid="market-source-chip-none"`
   - one chip per source: `data-testid="market-source-chip"`, `data-source-id=...`

### Warnings and empty states

`renderBrowseWarnings()` filters selected sources and displays warnings for `status === "error" || status === "unsupported"`. Because unsupported sources are not selectable, the unsupported branch is mostly defensive. Keep selected errored source warnings unchanged.

`renderBrowseEmptyState(visible)` currently distinguishes:

- initial loading
- browse endpoint error
- no marketplace sources
- no selected sources: “Enable a source chip...”
- selected sources all failed
- selected sources returned no supported packages
- search/filter no matches

Update only the chip-specific wording.

## Proposed UI structure

Add one small module state flag:

```ts
let browseSourceMenuOpen = false;
```

Reset it in `clearMarketplaceState()`. Optionally set it to `false` after source selection bulk actions if the product wants a one-shot dropdown; recommended behavior is to keep it open for multi-select checkbox work.

Add helpers near current Browse helpers:

```ts
function supportedBrowseSources(): MarketplaceBrowseSourceState[];
function selectedBrowseSources(): MarketplaceBrowseSourceState[];
function browseSourceCountById(): Map<string, number>;
function browseSourceSummary(countBySource: Map<string, number>): string;
function browseSourceStatusLabel(src: MarketplaceBrowseSourceState): string;
function browseSourceStatusClass(src: MarketplaceBrowseSourceState): string;
function toggleBrowseSourceMenu(): void;
function closeBrowseSourceMenu(): void;
```

Recommended summary text:

- No sources: `No sources available`
- None selected: `Showing 0 packs from 0 sources`
- All supported selected: `Showing ${visibleSelectedPackCount} packs from all ${selectedSupportedCount} sources`
- Partial selection: `Showing ${visibleSelectedPackCount} packs from ${selectedCount} of ${supportedCount} sources`

Use source package counts from raw `browsePacks`, not `filteredBrowsePacks()`, so the summary describes source selection independent of search. If desired, include search state in a separate results count later, not in this filter control.

### DOM skeleton

Replace `.market-source-chips` with a menu block inside `renderBrowseControls()`:

```ts
<div class="market-browse-controls" data-testid="market-browse-controls">
  <div class="market-search-wrap">...</div>

  <div class="market-source-filter" data-testid="market-browse-source-filter">
    <button
      type="button"
      class="market-source-menu-trigger"
      data-testid="market-source-menu-trigger"
      aria-haspopup="menu"
      aria-expanded=${browseSourceMenuOpen ? "true" : "false"}
      aria-controls="market-source-menu"
      @click=${toggleBrowseSourceMenu}
    >
      <span>Sources</span>
      <span class="market-source-summary" data-testid="market-source-summary">${summary}</span>
      ${icon(ChevronDown, "sm")}
    </button>

    ${browseSourceMenuOpen ? html`
      <div
        id="market-source-menu"
        class="market-source-menu"
        data-testid="market-source-menu"
        role="menu"
        aria-label="Browse package sources"
        @keydown=${handleBrowseSourceMenuKeydown}
      >
        <div class="market-source-menu-actions" role="group" aria-label="Source filter actions">
          <button type="button" class="market-source-menu-action" data-testid="market-source-select-all" @click=${() => setAllBrowseSources(true)}>Select all</button>
          <button type="button" class="market-source-menu-action" data-testid="market-source-clear" @click=${() => setAllBrowseSources(false)}>Clear</button>
        </div>

        <div class="market-source-menu-list">
          ${browseSources.map((src) => html`
            <label
              class="market-source-option ${enabled ? "market-source-option--selected" : ""} ${src.status === "error" ? "market-source-option--error" : ""} ${src.status === "unsupported" ? "market-source-option--disabled" : ""}"
              data-testid="market-source-option"
              data-source-id=${src.sourceId}
              title=${src.error || src.sourceId}
            >
              <input
                type="checkbox"
                data-testid="market-source-checkbox"
                data-source-id=${src.sourceId}
                .checked=${enabled}
                ?disabled=${src.status === "unsupported"}
                aria-describedby=${`market-source-meta-${safeId(src.sourceId)}`}
                @change=${() => toggleBrowseSource(src.sourceId)}
              />
              <span class="market-source-option-main">
                <span class="market-source-option-name">${src.sourceName}</span>
                <span id=${`market-source-meta-${safeId(src.sourceId)}`} class="market-source-option-meta">
                  ${count} package${count === 1 ? "" : "s"}${statusText}
                </span>
              </span>
              ${statusBadge}
            </label>
          `)}
        </div>
      </div>
    ` : ""}
  </div>
</div>
```

Notes:

- Prefer native checkbox inputs for accessibility rather than custom `role="menuitemcheckbox"` unless roving tabindex is implemented. A button with `aria-haspopup="menu"` plus a popup containing labelled checkboxes is understandable to screen readers and keyboard users.
- If strict ARIA menu semantics are desired, use `role="menuitemcheckbox"`, `aria-checked`, roving tabindex, and keyboard handling for ArrowUp/ArrowDown/Home/End. Native checkboxes are lower risk here.
- `safeId()` can reuse an existing ID sanitization utility if one exists; otherwise avoid `aria-describedby` IDs and keep all label text inside the `<label>`.
- Import and use existing `ChevronDown` already present in `marketplace-page.ts` imports.

### Event handling

Recommended minimal handlers:

```ts
function toggleBrowseSourceMenu(): void {
  browseSourceMenuOpen = !browseSourceMenuOpen;
  renderApp();
}

function closeBrowseSourceMenu(): void {
  browseSourceMenuOpen = false;
  renderApp();
}

function handleBrowseSourceMenuKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    browseSourceMenuOpen = false;
    renderApp();
  }
}
```

Use a global click-outside listener only if there is already a page-level pattern for popovers. Otherwise keep the implementation simple:

- Trigger opens/closes the menu.
- Escape closes the menu.
- Re-render/navigation naturally closes if `browseSourceMenuOpen` is reset when appropriate.

Recommended hardening for unsupported sources:

```ts
function toggleBrowseSource(sourceId: string): void {
  const src = browseSources.find((s) => s.sourceId === sourceId);
  if (src?.status === "unsupported") return;
  ...existing logic...
}
```

Bulk actions should keep current semantics:

- `Select all` calls `setAllBrowseSources(true)` and selects all non-unsupported sources, including errored sources.
- `Clear` calls `setAllBrowseSources(false)`.

Search behavior stays unchanged: `@input` mutates `browseSearch` and calls `renderApp()`.

### Accessibility requirements

- Trigger button has visible label `Sources` and compact summary text.
- Trigger exposes `aria-expanded` and `aria-controls`.
- Menu has `aria-label="Browse package sources"`.
- Every source row is a real checkbox with source name in the label.
- Package count and status text are visible and included in the checkbox accessible name/description.
- Unsupported rows are disabled with `disabled` on the input and muted styling.
- Escape closes the menu.
- Tab order should be: search input, search clear if present, Sources trigger, Select all, Clear, source checkboxes.
- Avoid using color alone for errors/loading/unsupported; include text such as `Error`, `Loading`, `Unsupported`.

## Stable test IDs

Remove/update chip IDs from Browse tests:

- Remove: `market-browse-source-chips`
- Remove: `market-source-chip-all`
- Remove: `market-source-chip-none`
- Remove: `market-source-chip`

Add:

- `market-browse-source-filter` — wrapper
- `market-source-menu-trigger` — button that opens/closes menu
- `market-source-summary` — compact summary outside menu
- `market-source-menu` — popup/menu body
- `market-source-select-all` — bulk action
- `market-source-clear` — bulk action
- `market-source-option` — row wrapper with `data-source-id`
- `market-source-checkbox` — checkbox with `data-source-id`
- Optional: `market-source-status` — status badge/text inside each row
- Optional: `market-source-count` — package count if tests need precise count assertions

Keep existing search IDs:

- `market-browse-controls`
- `market-browse-search`
- `market-browse-search-clear`

## CSS plan

Current CSS around line 426:

- Keep `.market-browse-controls`, `.market-search-wrap`, `.market-search-input`, `.market-search-clear`.
- Keep `.market-browse-provenance` behavior.
- Replace Browse-specific chip usage:
  - remove `.market-source-chips` from the grouped selector with `.market-browse-provenance`
  - remove or leave unused `.market-source-chip*` only if no other page uses them; otherwise keep for compatibility and stop rendering them in Browse.

Add classes:

```css
.market-source-filter {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.market-source-menu-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-height: 2rem;
  max-width: 100%;
  padding: 0.375rem 0.625rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--card);
  color: var(--foreground);
  font-size: 0.75rem;
  font-weight: 600;
}

.market-source-summary {
  color: var(--muted-foreground);
  font-weight: 500;
}

.market-source-menu {
  position: absolute;
  top: calc(100% + 0.25rem);
  left: 0;
  z-index: 20;
  width: min(24rem, calc(100vw - 2rem));
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--popover, var(--card));
  color: var(--popover-foreground, var(--foreground));
  box-shadow: 0 1rem 2rem color-mix(in oklch, var(--foreground) 12%, transparent);
}

.market-source-menu-actions {
  display: flex;
  gap: 0.375rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
}

.market-source-menu-action {
  font-size: 0.75rem;
  color: var(--primary);
}

.market-source-menu-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  max-height: 18rem;
  overflow: auto;
  padding-top: 0.5rem;
}

.market-source-option {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  border-radius: 0.5rem;
  cursor: pointer;
}

.market-source-option:hover {
  background: var(--muted);
}

.market-source-option--disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.market-source-option-main {
  min-width: 0;
}

.market-source-option-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.75rem;
  font-weight: 600;
}

.market-source-option-meta,
.market-source-status {
  font-size: 0.6875rem;
  color: var(--muted-foreground);
}

.market-source-status--error {
  color: var(--warning, var(--chart-4));
}
```

Use theme variables only; do not add a `:root` palette or hardcoded colors.

## Empty state copy changes

Change chip-specific wording:

Current:

```txt
No sources selected. Enable a source chip to browse packages.
```

Proposed:

```txt
No sources selected. Open Sources and select at least one source to browse packages.
```

Current no-match copy is acceptable, but can be clearer:

- With search: `No packages match “${query}” in the selected sources.`
- Without search: `No packages match the current source filter.`

Keep existing messages for no sources, source load errors, and selected sources returning no supported packages.

## E2E coverage plan

Primary file: `tests/e2e/ui/marketplace.spec.ts`

Add a focused Browse source filter test using two local-dir sources:

1. Create `repoA` with `source-a-pack` and `repoB` with `source-b-pack`.
2. Open Marketplace and register both sources.
3. Go to Browse.
4. Assert `market-source-menu-trigger` is visible and `market-source-summary` indicates selected sources/packs.
5. Open menu.
6. Assert each `market-source-checkbox` row shows source display name and package count.
7. Uncheck source A.
8. Assert source A pack disappears and source B pack remains.
9. Use search while source A is unchecked:
   - search for source A pack; assert no matching packages and clearer empty state.
   - search for source B pack; assert source B pack remains.
10. Clear search.
11. Click `market-source-clear`; assert no Browse packs and no selected sources empty state.
12. Click `market-source-select-all`; assert both packs return.
13. Close/reopen menu or switch Browse tab away/back to force re-render; assert checkbox selections persist across render.
14. Keyboard check: focus trigger, press Enter or Space to open, press Escape in menu to close, assert `aria-expanded="false"`.

Update existing `tests/e2e/ui/marketplace-mcp.spec.ts` assertions currently tied to chips:

Current flow:

```ts
await expect(page.locator('[data-testid="market-browse-source-chips"]')).toBeVisible();
await expect(page.locator('[data-testid="market-source-chip"]').filter({ hasText: "..." })).toBeVisible();
await page.locator('[data-testid="market-source-chip-none"]').click();
await expect(page.locator('[data-testid="market-browse-pack"]')).toHaveCount(0);
await page.locator('[data-testid="market-source-chip"]').filter({ hasText: "..." }).click();
```

Replace with:

```ts
await page.locator('[data-testid="market-source-menu-trigger"]').click();
const gatewayCheckbox = page.locator('[data-testid="market-source-option"][data-source-id="..."] [data-testid="market-source-checkbox"]');
await expect(gatewayCheckbox).toBeVisible();
await page.locator('[data-testid="market-source-clear"]').click();
await expect(page.locator('[data-testid="market-browse-pack"]')).toHaveCount(0);
await gatewayCheckbox.check();
```

If exact source id is inconvenient in MCP mocks, keep filtering by source display text on `market-source-option`.

Unsupported/error coverage can be unit-light but valuable in E2E if route mocking is already used:

- In `marketplace-mcp.spec.ts`, the browse route is mocked. Add one unsupported source and assert its checkbox is disabled and row shows `Unsupported`.
- Add one errored source selected by default and assert row shows `Error` and `market-browse-source-warnings` remains visible when selected.

## Risks and compatibility notes

- `enabledBrowseSourceIds` has no separate “user intentionally cleared all” flag. A real `loadBrowse()` after Clear re-enables all supported sources because `before.size === 0` is treated as no prior selection. This is existing behavior; preserving it meets current semantics, but it may surprise users if a future refresh button is added.
- `toggleBrowseSource()` currently trusts the UI to prevent unsupported toggles. Add a defensive unsupported guard to avoid accidental selection through tests or future handlers.
- Do not change `filteredBrowsePacks()` unless summary counts require helper extraction; search semantics are already broad and should remain intact.
- The current server endpoint is synchronous, so `src.status === "loading"` is unlikely in normal responses. Still render loading status because the API type includes it.
- Avoid strict ARIA menu roles unless implementing full menu keyboard behavior. Native checkboxes inside a labelled popup are simpler and more robust.
- Existing E2E tests using chip test IDs will fail until updated, especially `tests/e2e/ui/marketplace-mcp.spec.ts`.
- Keep source warnings outside the menu so selected errored sources remain visible even when the menu is closed.
