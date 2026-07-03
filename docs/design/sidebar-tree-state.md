# Sidebar tree expansion state

Status: implemented for sidebar expansion preferences. The shared tree builder and indentation layout seams are integrated; indentation preferences remain separate from expansion preferences.

## Context

The sidebar renders projects, goal trees, sessions, staff, team leads, spawned children, and archived rows through one shared tree model. Expansion state used to be split across several `Set`s and localStorage keys, which let polling, goal creation, keyboard navigation, desktop/mobile renderers, and archived delegate paths disagree about what should be open.

The current implementation centralizes durable disclosure preferences in `src/app/sidebar-tree-state.ts` and feeds them into `src/app/sidebar-tree-builder.ts` through `SidebarTreeExpansionInput`. Renderers still own markup and row actions, but they read `SidebarTreeNode.expanded` when a tree node is available and call the shared API for explicit toggles.

## Source map

| Area | Source | Role |
|---|---|---|
| Expansion storage/API | `src/app/sidebar-tree-state.ts` | Single source of truth for durable sidebar tree expansion preferences and legacy migration. |
| Tree keys and builder seam | `src/app/sidebar-tree-builder.ts` | Defines canonical keys, defaults, expansion metadata, hierarchy, and layout metadata. |
| Tree indentation | `src/app/sidebar-tree-layout.ts` | Owns indentation preference storage and shared CSS style helpers. It is separate from expansion state. |
| Desktop sidebar/search pruning | `src/app/sidebar.ts` | Builds the desktop/collapsed tree with shared expansion and layout inputs; applies search-only pruning/ephemeral ancestor expansion. |
| Shared rows/archived sections | `src/app/render-helpers.ts` | Renders goals, teams, sessions, archived delegate controls, and consumes tree node expansion/layout metadata. |
| Mobile sidebar | `src/app/render.ts` | Builds mobile tree views with the same expansion and layout inputs. |
| Keyboard navigation | `src/app/sidebar-nav.ts` | Maps nav rows to canonical tree keys and calls the shared expansion API. |
| Refresh/create flows | `src/app/api.ts` | Uses `expandSidebarTreeNode()` for minimal top-level goal expansion and does not mutate legacy goal sets. |
| Compatibility re-exports | `src/app/state.ts` | Keeps existing imports working while delegating tree expansion helpers to `sidebar-tree-state.ts`. |

## Storage namespace

Expansion preferences are stored in one versioned safe-storage namespace:

```ts
export const SIDEBAR_TREE_STATE_STORAGE_KEY = "bobbit-sidebar-tree-state:v1";
```

The persisted shape stores explicit preferences only:

```ts
type SidebarTreePreference = "expanded" | "collapsed";
interface SidebarTreeExpansionStateV1 {
  version: 1;
  expansion: Record<string, SidebarTreePreference>;
}
```

Corrupted, missing, wrong-version, or unavailable storage is ignored without throwing. The app falls back to builder defaults plus any readable legacy migration.

## Node-key model

Every durable preference uses the canonical `sidebarTreeKey()` string for a `SidebarTreeNodeKey`. That keeps identical raw IDs separated across node kinds.

| UI node | Canonical key object |
|---|---|
| Project header | `{ kind: "project", projectId }` |
| Ungrouped sessions section | `{ kind: "project-sessions", projectId }` |
| Staff section | `{ kind: "project-staff", projectId }` |
| Archived section | `{ kind: "project-archived", projectId }` |
| Goal/sub-goal | `{ kind: "goal", goalId }` |
| Team lead | `{ kind: "team-lead", sessionId }` |
| Live first-class/delegate children group | `{ kind: "session-children", sessionId, childClass: "first-class" }` |
| Archived delegate children group | `{ kind: "session-children", sessionId, childClass: "archived-delegate" }` |

`{ kind: "session", sessionId }` is a leaf identity for DOM/nav use. It is not persistently expandable.

## Defaults

Defaults apply only when no stored preference exists:

- Projects: expanded.
- Ungrouped sessions: expanded.
- Staff: expanded.
- Archived sections: expanded once shown.
- Goals and sub-goals: collapsed.
- Team leads: expanded.
- Live first-class child-session parents and live delegates: expanded through the first-class group.
- Archived delegate parents: collapsed.
- Leaf session nodes: use the supplied fallback/default and do not persist.

Explicit preferences always win over defaults. An explicit collapsed preference also wins over stale legacy expansion data and automatic application expansion.

## API contract

`sidebar-tree-state.ts` exposes semantic helpers rather than storage primitives:

- `sidebarTreeDefaultExpanded(key)`
- `getSidebarTreePreference(key)`
- `isSidebarTreeExpanded(key, defaultExpanded?)`
- `setSidebarTreeExpanded(key, expanded)`
- `toggleSidebarTreeExpanded(key)`
- `expandSidebarTreeNode(key, opts?)`
- `collapseSidebarTreeNode(key)`
- `clearSidebarTreePreference(key)`
- `sidebarTreeExpansionInput()`
- `resetArchivedSidebarTreeExpansion(opts)`

Compatibility wrappers cover projects, ungrouped sessions, staff, archived sections, goals, team leads, first-class child parents, and archived delegate parents.

`set*`, `toggle*`, and `collapse*` are explicit user/application preferences and persist. `expandSidebarTreeNode(key, { explicit: false })` is reserved for automatic expansion and must not overwrite an existing explicit preference.

## Refresh and create behavior

`refreshSessions()` tracks new goal IDs and may auto-expand only newly discovered top-level goals with a live owning session. It does not auto-expand parent goals when a child/sub-goal appears, and it does not persist an expanded preference for newly discovered sub-goals.

`createGoal()` explicitly expands only newly created top-level goals because the user directly created/opened that root item. Child goals/sub-goals do not expand themselves and do not expand their parent.

This preserves collapsed-by-default sub-goals and prevents new child discovery from reopening a parent the user collapsed.

## Search behavior

Sidebar search is an ephemeral view over the tree. When a query is active, desktop and mobile search may retain matching goals/sessions and expand retained ancestors in the pruned in-memory model so matches are visible. That search-only expansion changes `SidebarTreeNode.expanded` for the render pass only; it does not call the tree-state persistence API and does not write preferences.

Archived search visibility is also separate from tree-node expansion preferences.

## Archived delegate controls

Archived delegate parent groups use the canonical archived-delegate session-children key and default collapsed. Renderers show an "Archived delegates" disclosure row when archived delegates need an independent control next to live first-class children. The toggle persists through `toggleArchivedParentExpanded()` and respects `SidebarTreeNode.expanded` when rendering builder-derived trees.

## Legacy migration

On module load, `sidebar-tree-state.ts` reads the new namespace first, then idempotently merges readable legacy keys into missing canonical node keys. Existing new-state preferences take precedence over stale or conflicting legacy data. Legacy keys are not removed.

Legacy mapping:

| Legacy key | Migration |
|---|---|
| `bobbit-expanded-projects` | `collapsed:<projectId>` -> project collapsed; bare project IDs -> project expanded defensively. |
| `bobbit-expanded-goals` | goal expanded. |
| `bobbit-collapsed-ungrouped` | project-sessions collapsed. |
| `bobbit-collapsed-staff` | project-staff collapsed. |
| `bobbit-archived-collapsed-projects` | project-archived collapsed. |
| `bobbit-collapsed-team-leads` | team-lead collapsed. |
| `bobbit-collapsed-first-class-parents` | session-children/first-class collapsed. |
| `bobbit-expanded-delegate-parents` | session-children/archived-delegate expanded. |

Malformed or non-array legacy values are ignored through safe-storage fallback behavior.

## Out of scope

- `bobbit-sidebar-collapsed` is a shell preference, not a tree-node preference.
- `bobbit-show-archived` is a visibility filter, not a disclosure preference.
- `bobbit:sidebar-tree-indent` is the indentation preference, not a disclosure preference.
- `_expandedNestedDepthByProject` is in-memory render state.
- Plan-tab disclosure is separate from sidebar tree disclosure.

## Tests

Relevant tests include:

- `tests/sidebar-tree-state.test.ts` — defaults, explicit precedence, key separation, legacy migration, corrupted/missing storage, automatic expansion safeguards, archived delegate defaults, and archived reset behavior.
- `tests/api-sidebar-expansion-regression.test.ts` — refresh/create flows use the unified API, auto-expand only eligible top-level goals, and do not reopen collapsed parents for new child/sub-goals.
- `tests/sidebar-tree-builder.test.ts` — canonical keys, builder defaults, session-child classes, and layout metadata.
- `tests/sidebar-archived-delegates.spec.ts` — archived delegate disclosure controls.
- `tests/ui-fixtures/sidebar-filter-search-fixture.spec.ts` — search retention/ephemeral expansion behavior.
