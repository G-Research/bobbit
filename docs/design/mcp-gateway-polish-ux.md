# MCP Gateway Polish UX Guidance

Status: design guidance for `design-doc` gate  
Scope: Marketplace and Tools UI behavior for multi-source MCP Gateway browsing, install activation, operation selection, and policy controls. This document is UI guidance only; it does not require changes to the external MCP Gateway wire protocol.

## Goals

- Keep Marketplace navigation predictable: user-selected tabs stay put.
- Make Browse a true all-sources marketplace with explicit source filtering and search.
- Let users enable or disable individual installed gateway operations without losing the ability to re-enable them.
- Let Tools policy apply cleanly at MCP server, package/subnamespace, and operation level.
- Preserve Bobbit's current visual grammar: cards, chips, lozenges, selects, toggles, inline errors, and progressive disclosure.

## Existing primitives to reuse

Use the current Marketplace and Tools components rather than introducing a new gateway-only UI language.

- Marketplace containers: `market-panel`, `market-pack-card`, `market-source-row`.
- Marketplace inputs/actions: `market-input`, `market-btn`, `market-icon-btn`.
- Marketplace markers: `market-entity-chip`, `market-lozenge`, `market-error`, `market-corrupt` warning treatment.
- Marketplace activation: `market-activation`, `market-activation-group`, `market-activation-toggle`, `market-toggle-switch`.
- Tools list: `tool-group`, `tool-group-header`, `tool-group-items`, `tool-row`, `tool-group-select`, `tool-group-policy-label`.

Only add new classes when these primitives cannot express the state; prefer modifier classes such as `market-source-chip--off` or `mcp-operation-row--disabled` over a new component family.

## Marketplace tab behavior

### Rule: no implicit tab switching

Marketplace has three user-owned tabs: `Installed`, `Browse`, `Sources`. Once the user chooses a tab, background work and source actions must not move them.

| Action | Current/tempting behavior | Required behavior |
|---|---|---|
| Add source from Sources | Switch to Browse and select source | Stay on Sources. Show inline success on the new/updated source row. |
| Sync source from Sources | Possibly refresh Browse or select source | Stay on Sources. Update that row's sync state/count/error. |
| Remove source from Sources | Possibly clear Browse/route elsewhere | Stay on Sources. Remove row; show source-scoped error if removal fails. |
| Click source row | Navigate to Browse | Do not auto-navigate. Either keep row non-navigational or expose an explicit `Browse` button/link in the row. |
| Install/update from Browse | Jump to Installed | Stay on Browse. Update card state to `Installed` or `Update available` as applicable. |
| Toggle operation from Installed | Refresh Installed in place | Stay on Installed. Preserve expanded package and operation filter state. |

Recommended source row actions:

- `Browse` button: explicit navigation to Browse with only that source chip enabled.
- `Sync` icon button: row-local busy state.
- `Remove` icon button: destructive confirmation, no tab switch.

This keeps Sources as source management, Browse as package discovery, and Installed as local activation/state.

## Browse model

### Union of all sources

Browse should show a combined result set from all applicable sources:

- Built-in source.
- Pack/git/local sources.
- MCP Gateway sources.

Each browse card must retain provenance metadata:

- `sourceId`
- `sourceName` using normalized readable source name, e.g. `mcp-local.t3.zone/readonly/mcp`
- `sourceType`: `builtin`, `pack`, or `mcp-gateway`
- source fetch state: `loading`, `ok`, `error`, `empty`
- install/update state for the currently selected install scope

If duplicate source readable names exist, render the server-persisted `displayName` verbatim, including its deterministic suffix, for example `mcp.example.com/mcp (2)`. The server is the source of truth for duplicate suffixing so Sources, Browse provenance, installs, persisted ids, and tests stay aligned. Use the raw normalized authority/path and URL in `title` or secondary metadata so provenance remains inspectable.

### Browse header layout

Place filtering controls at the top of the Browse panel, above cards and below the panel title/scope picker.

Recommended structure:

```text
Browse                                      Install to [Project: Bobbit]
[Search packages, providers, operations…                         ]
[All 27] [Built-in 4] [mcp-local.t3.zone/readonly/mcp 12] [acme/packs 11]
```

#### Search field

- Placeholder: `Search packages, descriptions, sources, operations…`
- Filters by package/provider name, description, source name, MCP operation name, operation label, and provider label where available.
- Search is additive with chips: visible cards match search **and** enabled source chips.
- Clear affordance: small `×` button inside/right of the input when non-empty.
- Empty search result copy: `No packages match “confluence”. Try another search or enable more sources.`

#### Source chips

Chips independently include/exclude each source.

- Default: all sources enabled.
- Chip label: readable source name and result count, e.g. `mcp-local.t3.zone/readonly/mcp 12`.
- Active chip: primary-tinted border/background.
- Excluded chip: muted text/background, count remains visible.
- `All` chip toggles all sources on; if all are on, clicking `All` should leave them on rather than producing a confusing zero-source Browse.
- If all individual source chips are off, show empty state: `No sources selected. Enable a source chip to browse packages.`

### Card provenance

Every Browse card should show source provenance near the title, not hidden in details.

```text
Confluence                         Installed
mcp: confluence    HTTP    source: mcp-local.t3.zone/readonly/mcp
Search spaces, pages, comments, and attachments.
12 operations · 9 selected when installed
```

For gateway packages, operation summary should be package-scoped, not gateway-wide:

- `12 operations`
- `9 selected when installed`
- `3 disabled after install` when an installed package has operation opt-outs

### Browse states

Use per-source-aware state messaging.

| State | UI treatment |
|---|---|
| Initial loading | Skeleton or muted row: `Loading marketplace…` while sources and installed state load. |
| Source loading | Keep already loaded cards visible. Show chip spinner or chip suffix `loading…` for that source. |
| All sources loading | Panel body: `Loading packages from 3 sources…` |
| One source error | Keep other cards visible. Source chip shows warning style; top compact warning: `1 source failed to load.` Details disclose message. |
| All selected sources errored | Error block: `Could not load selected sources.` Include per-source messages and `Retry` actions. |
| Source empty | Source chip count `0`; if selected alone, body: `mcp-local.t3.zone/readonly/mcp returned no supported packages.` |
| Search empty | `No packages match “query” across selected sources.` |
| No sources configured | `No marketplace sources yet. Add a source in Sources, then return to Browse.` with `Go to Sources` button. |

Invalid gateway entries should not fail the whole source. Show valid cards and a compact source warning:

> `3 entries from mcp-local.t3.zone/readonly/mcp were skipped because they were unsupported.`

Disclosure details can list skipped provider names and server-provided diagnostics.

## Installed package operation opt-in/out

### Mental model

Marketplace controls whether an operation exists for Bobbit. Tools controls what happens when an enabled operation is called.

For gateway packages, package cards need a new operation activation section inside the existing installed card. This is not a separate page.

### Installed card summary

At the top of each installed gateway package card show package-scoped operation status:

```text
Confluence                         Project · mcp-local.t3.zone/readonly/mcp
mcp: confluence    HTTP    Connected · 9/12 ops enabled    Policy in Tools
```

Counts must come from the installed package's own selected operations, not gateway/server-wide totals:

- `9/12 ops enabled` means this package declares 12 operations and 9 are selected.
- `0/12 ops enabled` is valid and should render as `All operations disabled` rather than implying the package vanished.
- Runtime status can add `Connected`, `Error`, `Reconnecting…`, or `Not loaded`, but must not replace selected/total counts.

### Operation section layout

Use progressive disclosure to avoid overwhelming cards with many operations.

```text
Operations                                      [Search operations…]
[All] [Enabled 9] [Disabled 3]                 [Enable all] [Disable all]

[on ] confluence_search_pages        Search pages by title/content         Ask in Tools
[off] confluence_add_comment         Add a comment to a page               Disabled
[on ] confluence_get_page            Read page body and metadata           Allow in Tools
```

Recommended behavior:

- Section is collapsed by default when more than 8 operations exist; expanded state persists while on the page.
- Show the first 5 operations plus `Show all 12 operations` when collapsed.
- Search filters operation name and description within this package only.
- `All`, `Enabled`, and `Disabled` chips filter operation rows.
- Operation rows remain visible when disabled so users can re-enable them.
- Bulk actions are optional but helpful for large packages; if implemented, confirm `Disable all` when it would leave zero enabled operations.

### Operation row details

Each operation row should include:

- Toggle using existing `market-toggle-switch`.
- Operation label/name in monospace or code-styled text only for the raw identifier.
- One-line description when available.
- Policy summary link/text from Tools, e.g. `Ask in Tools`, `Never in Tools`, `Inherited from mcp__gr__confluence`.
- Optional risk marker for write/destructive operations if the gateway metadata provides it; do not infer risk from names alone.

States:

| State | Row behavior |
|---|---|
| Enabled | Toggle on; normal text; policy summary visible. |
| Disabled | Toggle off; row remains in list; operation name visible; description muted; status `Disabled`. |
| Saving | Toggle disabled; row shows `Saving…`; retain last confirmed state until success. |
| Save error | Revert toggle to last confirmed state; inline `market-error` under row. |
| Runtime error | Keep activation toggle available; show package/server runtime error separately from activation. |
| Operation removed by source update | Show disabled/retired row until user updates or removes package: `No longer provided by source`. |

### Empty and edge cases

- No operations returned for installed gateway package: `No operations are available for this package. Sync the source or check gateway diagnostics.`
- All operations disabled: card remains installed and visible with `All operations disabled`; runtime tools for that package should not be exposed.
- Operation name collision: card may show `Shadowed by package order` on affected operation rows if the operation is selected but not exposed due to precedence.
- Package update adds operations: new operations default enabled because Bobbit persists disabled operation names rather than an enabled-only allowlist. Label newly discovered rows as `New` until the user next reviews or toggles them, but expose them unless they are explicitly disabled or denied by Tools policy.

Recommended test ids:

- `market-installed-operation-section-${packName}`
- `market-operation-search-${packName}`
- `market-operation-filter-enabled-${packName}`
- `market-operation-row-${operationName}`
- `market-toggle-operation-${operationName}`
- `market-operation-policy-link-${operationName}`

## Tools policy controls

### Hierarchy

The Tools page should show MCP policy as a three-level tree using the existing `tool-group` grammar:

```text
MCP
  gr                                  28 operations     Server Policy: [Ask]
    confluence                        12 operations     Package Policy: [Use server default]
      confluence_search_pages          Operation Policy: [Use package default]
      confluence_add_comment           Operation Policy: [Never]
    jira                              16 operations     Package Policy: [Never]
      jira_search_issues               Operation Policy: [Use package default]
```

Policy keys map directly to the most specific supported prefixes:

| Level | Example key | UI label |
|---|---|---|
| Server | `mcp__gr` | Server Policy |
| Package/subnamespace | `mcp__gr__confluence` | Package Policy |
| Operation | `mcp__gr__confluence__confluence_add_comment` | Operation Policy |

Use `Package Policy` for gateway provider/subnamespace rows because that matches the Marketplace install unit. If a non-gateway MCP uses subnamespace-like grouping, label may be `Namespace Policy`; gateway rows should prefer `Package Policy`.

### Policy select labels

Reuse the existing select values: empty/default, `allow`, `ask`, `never`.

Recommended labels by level:

- Server row empty option: `Allow (default)` or `Use system default`.
- Package row empty option: `Use server default`.
- Operation row empty option: `Use package default`.

Each row should show the effective result and source after the select:

- `→ Ask [from mcp__gr]`
- `→ Never [operation override]`
- `→ Allow [system default]`

### Interaction behavior

- Expand/collapse server and package rows with the current chevron interaction.
- Policy select clicks must not toggle expansion.
- Changing a policy saves immediately, then refreshes group policies and effective labels.
- While saving, disable only the changed select and show `Saving…` inline or via subdued row state.
- On save error, restore previous select value and show an inline error on that row.

### Disabled operations in Tools

Marketplace-disabled operations are not available to agents and should not appear as normal callable tools. To preserve policy visibility without implying availability:

- Default Tools view lists enabled/exposed operations.
- If an installed package has disabled operations, show a small disclosure under the package row: `3 operations disabled in Marketplace`.
- Expanding that disclosure can show disabled operation names with policy selects disabled and a `Enable in Marketplace` link.
- Existing saved policies for disabled operations must not be deleted; they apply again if the operation is re-enabled.

### Policy precedence clarity

The UI should communicate that more specific settings win:

1. Operation policy (`mcp__gr__confluence__confluence_add_comment`)
2. Package/subnamespace policy (`mcp__gr__confluence`)
3. Server policy (`mcp__gr`)
4. Existing broader/default policy
5. System default

Add one short helper line at the top of MCP Tools section:

> More specific MCP policies override broader ones. Marketplace operation toggles decide availability; policy decides allow, ask, or never when enabled.

### Conflict and precedence states

When two installed packages expose the same model-facing operation name:

- Show only the winning operation as callable in the normal tree.
- Add a provenance lozenge, e.g. `from mcp-local.t3.zone/readonly/mcp`.
- If shadowed operations are known, show a muted disclosure: `1 shadowed provider with the same operation name`.
- Policy applies to the exposed model-facing key. Shadowed operations are governed if they become winners later, but are not callable now.

## Copy recommendations

Use direct labels that separate existence from policy.

- Marketplace helper: `Turn operations on or off for this installed package. Disabled operations stay listed so you can re-enable them later.`
- Tools helper: `Set allow, ask, or never. These policies do not install or remove operations.`
- Disabled operation tooltip: `Disabled in Marketplace. Agents cannot call this operation until it is re-enabled.`
- `never` tooltip: `Blocked by policy. The operation can stay installed, but calls are refused.`

## Accessibility

- All chips and toggles need keyboard focus states using existing ring treatment.
- Source chips must expose pressed state with `aria-pressed`.
- Operation filters use buttons with clear text, not color-only state.
- Toggle labels must include operation names; screen readers should announce `Enable confluence_add_comment` / `Disable confluence_add_comment`.
- Loading/error states should be text-visible, not spinner-only.
- Counts must not be color-only; include numbers and labels.

## Responsive behavior

- Browse search and source chips wrap below 640px.
- Source chip row should horizontally scroll only if wrapping would make the header excessively tall; wrapping is preferred.
- Installed operation rows become two-line on narrow screens: toggle/name/description first, policy summary second.
- Tools MCP rows should keep the policy select reachable on mobile by wrapping it beneath the row label instead of overflowing.

## Consistency rationale

- Browse filters reuse chip/button/input patterns already present in Marketplace.
- Installed operation controls reuse activation toggles because they control existence, matching roles/tools/skills/MCP activation semantics.
- Policy controls remain in Tools and reuse existing `tool-group-select` controls because policy is already managed there for normal tools and MCP groups.
- Status uses `market-lozenge` rather than new badges, preserving the current card rhythm.
- Inline errors remain scoped to the row/card where the failure happened, matching existing Marketplace source and install errors.
