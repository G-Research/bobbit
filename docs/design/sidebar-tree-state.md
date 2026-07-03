# Sidebar tree expansion state

Status: implemented for sidebar expansion preferences. Indentation layout seams exist in the tree builder, but no indentation preference UI is implemented.

## Context

The sidebar renders projects, goal trees, sessions, staff, team leads, spawned children, and archived rows through one shared tree model. Expansion state used to be split across several `Set`s and localStorage keys, so polling, goal creation, keyboard navigation, and renderer-specific paths could disagree about what should be open.

The current implementation centralizes sidebar disclosure preferences in `src/app/sidebar-tree-state.ts` and feeds them into `src/app/sidebar-tree-builder.ts` through the `SidebarTreeExpansionInput` seam. Renderers still own markup and row actions, but they should ask the shared API for expansion state rather than reading or writing storage directly.

## Source map

| Area | Source | Role |
|---|---|---|
| Expansion storage/API | `src/app/sidebar-tree-state.ts` | Single source of truth for durable sidebar tree expansion preferences and legacy migration. |
| Tree keys and builder seam | `src/app/sidebar-tree-builder.ts` | Defines `SidebarTreeNodeKey`, `sidebarTreeKey()`, `parseSidebarTreeKey()`, defaults, expandability, tree nodes, and layout metadata. |
| Desktop sidebar/search pruning | `src/app/sidebar.ts` | Builds the desktop tree with `sidebarTreeExpansionInput()` and applies search-only pruning/ephemeral ancestor expansion. |
| Shared row rendering | `src/app/render-helpers.ts` | Renders goal/session/team/delegate rows from builder nodes and shared expansion helpers. |
| Mobile/collapsed sidebar | `src/app/render.ts` | Builds mobile/collapsed views with the same tree expansion input. |
| Keyboard navigation | `src/app/sidebar-nav.ts` | Maps nav rows to canonical tree keys and calls `isSidebarTreeExpanded()` / `setSidebarTreeExpanded()`. |
| Refresh/create flows | `src/app/api.ts` | Uses `expandSidebarTreeNode()` for minimal top-level goal expansion and no longer mutates legacy goal sets. |

## Storage namespace

Expansion preferences are stored in one versioned safe-storage namespace:

```ts
export const SIDEBAR_TREE_STATE_STORAGE_KEY = "bobbit-sidebar-tree-state:v1";
```

Stored JSON shape:

```ts
type SidebarTreePreference = "expanded" | "collapsed";

interface SidebarTreeExpansionStateV1 {
  version: 1;
  expansion: Record<string, SidebarTreePreference>;
}
```

Only concrete preferences are stored, not inferred defaults. Absence from `expansion` means “resolve from the node-kind default or caller fallback.” Corrupted JSON, wrong versions, invalid canonical keys, missing storage, and unavailable/throwing storage are ignored without breaking boot; the sidebar falls back to defaults plus any readable legacy migration.

## Canonical keys and node separation

`sidebarTreeKey()` serializes typed `SidebarTreeNodeKey` values to stable strings:

```text
sidebar-tree/v1/<kind>/<url-encoded-id>[?childClass=...]
```

Entity IDs are URL-encoded, so callers should never split raw IDs with ad-hoc delimiters. The node kind is part of identity, which keeps otherwise identical raw IDs separate across project sections, goals, sessions, and child groups.

Important expandable keys:

| Node | Key shape | Why it is separate |
|---|---|---|
| Project header | `{ kind: "project", projectId }` | Collapses the whole project body. |
| Sessions section | `{ kind: "project-sessions", projectId }` | Independent from the project header. |
| Staff section | `{ kind: "project-staff", projectId }` | Independent from Sessions and the project header. |
| Archived section | `{ kind: "project-archived", projectId }` | Controlled by Show Archived but has its own disclosure state. |
| Goal/sub-goal | `{ kind: "goal", goalId }` | One preference follows the goal whether it renders in the project forest, archived forest, or under a team lead. |
| Team lead | `{ kind: "team-lead", sessionId }` | Controls team/member rows for one lead session. |
| First-class child-session parent | `{ kind: "session-children", sessionId, childClass: "first-class" }` | Used for live first-class child sessions and live delegates grouped under the parent. |
| Archived delegate parent | `{ kind: "session-children", sessionId, childClass: "archived-delegate" }` | Separate from first-class children because archived delegate parents default collapsed. |

`{ kind: "session", sessionId }` is a leaf key used for DOM/nav identity. It is not expandable and is not persisted by the expansion API.

## Defaults

Defaults apply only when no stored preference exists.

| Node kind | Default |
|---|---:|
| Project headers | expanded |
| Project Sessions sections | expanded |
| Project Staff sections | expanded |
| Project Archived sections | expanded when shown |
| Goals and sub-goals | collapsed |
| Team leads | expanded |
| First-class/live delegate child-session parents | expanded |
| Archived delegate parents | collapsed, but user-expandable |
| Leaf sessions | non-expandable; use caller fallback |

Explicit preferences always win over these defaults.

## Shared API seams

Use `src/app/sidebar-tree-state.ts` rather than direct storage or legacy sets.

Core helpers:

- `sidebarTreeDefaultExpanded(key)` — returns the default for a node kind.
- `getSidebarTreePreference(key)` — returns only durable explicit state, if present.
- `isSidebarTreeExpanded(key, defaultExpanded?)` — resolves explicit preference, then supplied/default state.
- `setSidebarTreeExpanded(key, expanded)` / `toggleSidebarTreeExpanded(key)` / `collapseSidebarTreeNode(key)` — explicit writes for user actions.
- `expandSidebarTreeNode(key, { explicit: false })` — application-driven expansion that must not overwrite existing preferences.
- `clearSidebarTreePreference(key)` — removes the durable preference so defaults apply again.
- `sidebarTreeExpansionInput()` — adapter passed to `buildSidebarTree()`.
- `resetArchivedSidebarTreeExpansion({ archivedGoalIds, archivedSessionIds })` — clears archived goal/session-related expansion preferences when archived state is reset.

Compatibility wrappers such as `isGoalExpanded()`, `setGoalExpanded()`, `isTeamLeadExpanded()`, and `setArchivedParentExpanded()` exist so render paths can stay semantic while sharing the same backing store.

## Explicit vs automatic expansion

User toggles and keyboard expansion are explicit. They persist an `expanded` or `collapsed` preference for expandable nodes, including values that match the default. This matters because an explicit collapse must act as a tombstone: later polling or creation flows must not reopen it.

Application-driven expansion is narrower:

- Search-driven and default-open automatic expansion is ephemeral/non-persistent; it affects only the current render pass or falls back to the default.
- `expandSidebarTreeNode(key, { explicit: false })` does nothing when the node already has any explicit preference.
- It also does nothing for nodes that are already expanded by default, avoiding unnecessary durable entries.
- It may create an `expanded` preference only for an unset, default-collapsed node. Today that durable automatic exception is used by `refreshSessions()` for newly discovered top-level goals with a live owning session.
- `refreshSessions()` does not auto-expand sub-goals and does not auto-expand parents just because a child was discovered.
- `createGoal()` explicitly expands only newly created top-level goals. Child goals/sub-goals do not expand themselves or their parents.

This preserves collapsed-by-default sub-goals and prevents new child discovery from reopening a parent the user collapsed.

## Search behavior

Sidebar search is an ephemeral view over the tree. When a query is active, the sidebar may retain matching goals/sessions and expand retained ancestors in the pruned in-memory model so matches are visible. That search-only expansion changes `SidebarTreeNode.expanded` for the render pass but does not call the tree-state persistence API and does not write preferences.

Search can also temporarily show archived results through the archived search flow. That visibility state is separate from tree-node expansion preferences.

## Legacy migration

On module load, `sidebar-tree-state.ts` reads the new namespace first, then idempotently merges readable legacy keys into missing canonical node keys. Existing new-state preferences take precedence over stale or conflicting legacy data. Legacy keys are not removed, which keeps rollback safe and makes repeated migration non-destructive.

Legacy mapping:

| Legacy key | Migrated canonical node | Migrated preference |
|---|---|---|
| `bobbit-expanded-projects` entry `collapsed:<projectId>` | `project(projectId)` | `collapsed` |
| `bobbit-expanded-projects` bare project ID | `project(projectId)` | `expanded` |
| `bobbit-expanded-goals` | `goal(goalId)` | `expanded` |
| `bobbit-collapsed-ungrouped` | `project-sessions(projectId)` | `collapsed` |
| `bobbit-collapsed-staff` | `project-staff(projectId)` | `collapsed` |
| `bobbit-archived-collapsed-projects` | `project-archived(projectId)` | `collapsed` |
| `bobbit-collapsed-team-leads` | `team-lead(sessionId)` | `collapsed` |
| `bobbit-collapsed-first-class-parents` | `session-children(sessionId, "first-class")` | `collapsed` |
| `bobbit-expanded-delegate-parents` | `session-children(sessionId, "archived-delegate")` | `expanded` |

Malformed/non-array legacy values are ignored via safe-storage fallback behavior.

## Indentation scope

`sidebar-tree-builder.ts` exposes layout metadata and `resolveSidebarTreeLayoutPreference()` so renderers can share indentation calculations. This goal did not add an indentation preference UI or persist indentation settings in `bobbit-sidebar-tree-state:v1`; expansion preferences and layout preferences remain separate concerns.

## Verification coverage

Relevant tests include:

- `tests/sidebar-tree-state.test.ts` — defaults, explicit precedence, key separation, legacy migration, corrupted/missing storage, automatic expansion safeguards, archived delegate defaults, and archived reset behavior.
- `tests/api-sidebar-expansion-regression.test.ts` — refresh/create flows use the unified API, auto-expand only eligible top-level goals, and do not reopen collapsed parents for new child/sub-goals.
- Sidebar search tests cover search filtering/retention behavior without turning search expansion into durable preferences.
