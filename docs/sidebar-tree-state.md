# Sidebar tree state

Bobbit's sidebar uses a shared tree model for projects, goals, sessions, staff, team leads, child/delegate sessions, and archived sections. The model exists so desktop, mobile, and collapsed sidebar render paths agree about hierarchy, expand/collapse state, search pruning, and indentation instead of re-implementing those rules in each renderer.

## Source map

| Area | Source | Responsibility |
|---|---|---|
| Tree builder | `src/app/sidebar-tree-builder.ts` | Builds the canonical hierarchy, node keys, default expansion metadata, child-session groups, spawned child-goal placement, and indentation metadata. |
| Expansion state | `src/app/sidebar-tree-state.ts` | Owns durable disclosure preferences, legacy migration, default policies, and compatibility wrappers. |
| Indentation layout | `src/app/sidebar-tree-layout.ts` | Owns the per-browser indentation preference, clamping, CSS variables, and renderer style helpers. |
| Desktop/collapsed render | `src/app/sidebar.ts` | Builds the shared model, applies search-only pruning, and renders expanded/collapsed sidebar rows. |
| Shared rows | `src/app/render-helpers.ts` | Renders goals, sessions, team leads, archived rows, and child/delegate controls from tree nodes. |
| Mobile render | `src/app/render.ts` | Builds the same model for mobile sidebar/landing views. |
| Keyboard expansion | `src/app/sidebar-nav.ts` | Maps visible rows and `data-tree-key` attributes back to canonical tree keys for `Ctrl+←` / `Ctrl+→`. |
| Refresh/create flows | `src/app/api.ts` | Applies minimal automatic expansion for newly discovered top-level goals without overwriting user choices. |

## Tree builder model

`buildSidebarTree(input)` returns a `SidebarTreeModel` with one `SidebarProjectTree` per project plus lookup maps for renderer convenience:

- `flatByKey` for canonical key lookup and duplicate-key diagnostics.
- `claimedSpawnedGoalIds` so child goals spawned under a team lead are not duplicated in the project forest.
- `spawnedGoalNodesByLeadSessionId` for team-lead render paths.
- `sessionChildrenNodesBySessionId` for first-class children, live delegates, and archived delegate groups.
- `diagnostics` for duplicate IDs, goal/session cycles, cross-project parents, and duplicate node keys.

Every `SidebarTreeNode` includes:

- `key` / `canonicalKey` and typed `nodeKey`.
- `kind`, `entityId`, `parentKey`, `children`.
- `logicalDepth` / `depth` and `indentDepth` / `indentLevel` / `indentPx`.
- `expandable`, `expansionClass`, `defaultExpanded`, and resolved `expanded`.
- A typed `context` object for row-specific data.

Renderers still own markup and row actions. They should consume the model's hierarchy, expansion, and layout metadata rather than recomputing parent/child relationships or multiplying depth values inline.

## Canonical keys

Expansion preferences use `sidebarTreeKey(nodeKey)`, which prefixes keys with `sidebar-tree/v1/` and keeps identical raw IDs separate by node kind.

| UI node | Node key |
|---|---|
| Project header | `{ kind: "project", projectId }` |
| Ungrouped sessions section | `{ kind: "project-sessions", projectId }` |
| Staff section | `{ kind: "project-staff", projectId }` |
| Archived section | `{ kind: "project-archived", projectId }` |
| Goal or sub-goal | `{ kind: "goal", goalId }` |
| Team lead | `{ kind: "team-lead", sessionId }` |
| Child/delegate session group | `{ kind: "session-children", sessionId, childClass }` |
| Leaf session row | `{ kind: "session", sessionId }` |

`childClass` is one of `first-class`, `delegate`, or `archived-delegate`. Leaf session rows are addressable for DOM/navigation metadata, but they are not persistently expandable.

## Expansion defaults and persistence

Expansion preferences are stored as explicit choices only under:

```ts
bobbit-sidebar-tree-state:v1
```

Shape:

```ts
{
  "version": 1,
  "expansion": {
    "sidebar-tree/v1/goal/example": "expanded"
  }
}
```

Defaults apply only when no explicit preference exists:

| Node kind | Default |
|---|---|
| Project, project sessions, project staff, project archived | Expanded |
| Goal and sub-goal | Collapsed |
| Team lead | Expanded |
| First-class child-session group | Expanded |
| Live delegate group | Collapsed |
| Archived delegate group | Collapsed |
| Leaf session | Collapsed fallback; not persisted |

`setSidebarTreeExpanded()`, `toggleSidebarTreeExpanded()`, and `collapseSidebarTreeNode()` persist explicit user/application choices. `expandSidebarTreeNode(key, { explicit: false })` is the safe automatic path: it no-ops when a preference already exists and also avoids writing expansion for nodes whose default is already expanded.

This distinction is the reason user intent survives polling, hard refresh, and gateway restart.

## Legacy migration

On module load, `sidebar-tree-state.ts` reads the new namespace first, then merges legacy localStorage keys only for canonical keys that do not already have a new preference. Legacy keys are left in place for compatibility; new writes go through `bobbit-sidebar-tree-state:v1`.

| Legacy key | Migration target |
|---|---|
| `bobbit-expanded-projects` | `collapsed:<projectId>` becomes project collapsed; bare project IDs become project expanded. |
| `bobbit-expanded-goals` | Goal expanded. |
| `bobbit-collapsed-ungrouped` | Project sessions collapsed. |
| `bobbit-collapsed-staff` | Project staff collapsed. |
| `bobbit-archived-collapsed-projects` | Project archived section collapsed. |
| `bobbit-collapsed-team-leads` | Team lead collapsed. |
| `bobbit-collapsed-first-class-parents` | First-class child-session group collapsed. |
| `bobbit-expanded-delegate-parents` | Live delegate and archived-delegate groups expanded. |

Malformed, unavailable, wrong-version, or corrupted storage is ignored through the safe-storage helpers so sidebar boot cannot fail because of preference data.

## Collapsed-by-default sub-goals

All goal nodes default collapsed, including top-level goals and sub-goals. The refresh/create paths preserve the sub-goal default:

- `refreshSessions()` may auto-expand only newly discovered top-level goals that have an owning live session.
- `refreshSessions()` does not auto-expand parent goals just because a child/sub-goal appeared.
- `createGoal()` walks the created goal and ancestors through `expandSidebarTreeNode(..., { explicit: false })`, so it reveals an explicitly created path without overwriting any existing collapsed preference.

Because automatic expansion is non-explicit, an explicit collapsed parent remains collapsed across later polling and restart.

Route navigation reuses the same non-explicit path to reveal a target row's ancestors on deep-links and in-app route changes. See [Sidebar reveal on nav](sidebar-reveal-on-nav.md).

## Archived and search behavior

Archived visibility and tree expansion are separate preferences:

- `bobbit-show-archived` is the global visibility filter from the Sidebar Filters popover.
- `project-archived` tree keys store per-project Archived section disclosure.
- Archived delegate rows use `session-children` keys with `childClass: "archived-delegate"` and default collapsed.
- `resetArchivedSidebarTreeExpansion()` clears archived goal/session disclosure choices when the user invokes archive-reset behavior, but hiding archived rows does not delete preferences.

Search is an ephemeral view over the tree:

- Typing a sidebar query can temporarily show archived rows and schedule server-backed archived search.
- Search pruning expands retained ancestors in the in-memory model so matching descendants are visible.
- Search-only expansion does not call the persistence API and does not write `bobbit-sidebar-tree-state:v1`.
- If search auto-opened archived visibility, clearing the query closes it again and clears fetched archive state without deleting explicit tree expansion choices.
- A manual Show Archived toggle takes precedence over search auto-open and persists through `bobbit-show-archived`.

See [Sidebar Archived Search](sidebar-archived-search.md) for the archived query and pagination contract.

## Indentation customization

Sidebar tree indentation is a separate per-browser appearance preference stored at `bobbit:sidebar-tree-indent`. It is intentionally not part of expansion state because changing spacing should not change hierarchy or disclosure choices.

The setting lives at **System Settings → General → Appearance → Sidebar tree indentation** and is applied through `sidebar-tree-layout.ts`:

- Default: `16` px.
- Range: `8`–`28` px.
- Step: `1` px.
- Reset writes the default and reapplies CSS variables immediately.
- Runtime CSS variables: `--sidebar-tree-base-indent`, `--sidebar-tree-nested-goal-indent`, and `--sidebar-tree-collapsed-indent`.

Expanded desktop and mobile renderers use the configured indentation for nested sidebar levels. Collapsed sidebar uses a capped derived value so compact labels do not overflow. See [Sidebar tree indentation](sidebar-tree-indentation.md) for details.

## Verification

Focused checks for tree-state work:

```bash
npm run check
npm run test:unit
npx playwright test tests/e2e/ui/sidebar-unified-tree.spec.ts tests/e2e/ui/sidebar-tree-restart.spec.ts --reporter=line
npx playwright test tests/e2e/ui/sidebar-indent.spec.ts tests/e2e/ui/sidebar-archived-delegates-e2e.spec.ts --reporter=line
```

Relevant coverage:

- `tests/sidebar-tree-state.test.ts` — defaults, explicit preference precedence, legacy migration, corrupted storage, automatic expansion safeguards, and archived reset behavior.
- `tests/sidebar-tree-builder.test.ts` — stable keys, hierarchy, session-child classes, duplicate spawned-child prevention, and layout metadata.
- `tests/sidebar-tree-layout.test.ts` — indentation clamping, save/reset, throwing storage, CSS variable application, and collapsed-indent derivation.
- `tests/api-sidebar-expansion-regression.test.ts` — refresh/create auto-expansion and collapsed parent/sub-goal regressions.
- `tests/e2e/ui/sidebar-unified-tree.spec.ts` — representative desktop tree behavior, canonical key attributes, and keyboard expansion.
- `tests/e2e/ui/sidebar-tree-restart.spec.ts` — persistence across gateway restart and reload.
- `tests/e2e/ui/sidebar-indent.spec.ts` — settings UI, persistence, reset, clamping, and overflow checks.
- `tests/ui-fixtures/sidebar-filter-search-fixture.spec.ts` — search retention and ephemeral expansion behavior.
