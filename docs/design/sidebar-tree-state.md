# Unified sidebar tree state design

Status: partially implemented. The shared sidebar tree builder and sidebar tree indentation preference have shipped. Desktop, mobile, collapsed-sidebar, and render-helper paths now consume builder-derived hierarchy/layout data and shared indentation helpers. The storage/state migration described later remains future work: production expansion state still comes from the legacy sets and localStorage keys inventoried below.

## Context

The sidebar renders one navigation tree through several modules. Before this refactor, each renderer made parts of the hierarchy decision itself, while expansion state was split across unrelated module-level sets and localStorage keys. That made refreshes, goal creation, keyboard navigation, and renderer-specific defaults easy to drift.

The builder now centralizes rendered hierarchy, stable canonical keys, node kind/entity/context, parent/child ownership, depth/indent metadata, expansion metadata, and spawned-child placement. The shipped indentation preference uses that metadata plus shared CSS variables so spacing stays consistent across sidebar surfaces. The remaining design introduces a safe-storage-backed disclosure-state layer so renderers, keyboard navigation, refresh polling, and create-goal flows can eventually ask one state API whether a node is expandable or expanded.

## Source map

Maintainers and future storage-migration implementers should start with these files and functions:

| Area | Source references | Why it matters |
|---|---|---|
| Shared tree builder | `src/app/sidebar-tree-builder.ts::buildSidebarTree`, `sidebarTreeKey`, `parseSidebarTreeKey`, `SidebarTreeNode` | Centralizes rendered hierarchy, stable keys, node context, depth/indent metadata, expansion metadata, and spawned-child placement. |
| Desktop sidebar shell and project sections | `src/app/sidebar.ts::renderSidebar`, `renderProjectHeader`, `renderProjectContent`, `renderNestedNode`, `isProjectExpanded`, `toggleProjectExpanded`, `_expandedNestedDepthByProject` | Owns project headers, nested goal rendering, project reorder overrides, and the render-local “Show more child goals” depth cap. |
| Shared goal/session rows and archived subsections | `src/app/render-helpers.ts::renderGoalGroup`, nested `renderTeamGroup`, `renderProjectArchivedSection`, `renderArchivedSessionRow`, `renderArchivedDelegates`, `sidebarTreeBaseIndentStyle`, `sidebarTreeNodeIndentStyle` | Owns goal disclosure, team-lead disclosure, archived rows, delegate rows, and consumes shared indentation helpers. |
| Sidebar indentation preference | `src/app/sidebar-tree-layout.ts`, `src/app/settings-page.ts::renderSidebarTreeIndentControl`, `src/app/state.ts` re-exports/startup application | Owns the shipped per-browser indentation setting, storage key, clamping, CSS variables, and template style helpers. |
| Refresh and goal creation | `src/app/api.ts::refreshSessions`, `createGoal` | Currently mutates `expandedGoals` directly when new goals arrive or are created. |
| Keyboard navigation | `src/app/sidebar-nav.ts::NavKind`, `navIdFor`, `parseNavId`, `isNavItemExpanded`, `setNavItemExpanded`, `getVisibleNavOrder`, `navIdToHash`, `getActiveNavId` | Currently uses string `data-nav-id` values such as `goal:<id>` and switches on legacy nav kinds. |
| Nested goal forest | `src/app/sidebar-nesting.ts::buildNestedGoalForest`, `NestedGoalNode` | Produces depth, parent/child structure, descendant counts, and truncation metadata for nested goals. |
| Spawned child ownership | `src/app/sidebar-spawned-children.ts::selectSpawnedChildren`, `computeSpawnedClaim` | Determines which spawned subgoals render under team leads instead of the project-level nested forest. |
| Current persisted sidebar state | `src/app/state.ts` exported sets/helpers around `expandedGoals`, collapsed project subsections, collapsed team leads, first-class parents, and archived delegate parents | Defines all legacy keys that must migrate. |
| Plan tab disclosure | `src/app/goal-dashboard-plan-tab.ts::_planCollapsedGoals`, `_isPlanExpanded`, `_togglePlanExpanded`, `computePlanStepsForGoal` | Similar-looking tree state that is explicitly out of scope. |

## Goals

1. Stable typed node keys that survive reordering, filtering, refreshes, nesting path changes, and archived/live relocation.
2. Explicit preference precedence so user choices are not undone by polling or create/refresh side effects.
3. Versioned safe-storage namespace with deterministic migration from every legacy sidebar expansion key.
4. Public API small enough for renderers and navigation to consume without knowing storage details.

## Non-goals

- Do not use the remaining storage migration to expand the sidebar feature scope beyond tree hierarchy and disclosure state.
- Do not include chat side panels, goal-dashboard gate rows, live verification rows, artifact rows, tree-cost disclosure, or marketplace/proposal disclosures.
- Do not include goal-dashboard Plan tab nested disclosure state; rationale is below.

## Current state inventory

| Current storage/state | Source reference | Meaning | Default |
|---|---|---|---|
| `bobbit-expanded-projects` | `src/app/sidebar.ts::EXPANDED_PROJECTS_KEY`, `isProjectExpanded`, `toggleProjectExpanded` | Set values are `collapsed:<projectId>`; absence means project expanded. | expanded |
| `bobbit-expanded-goals` | `src/app/state.ts::EXPANDED_GOALS_KEY`, `expandedGoals`, `saveExpandedGoals` | Set of expanded `goalId`s. | collapsed, except auto rules |
| `bobbit-collapsed-ungrouped` | `src/app/state.ts::COLLAPSED_UNGROUPED_KEY`, `isUngroupedExpanded`, `setUngroupedExpanded` | Collapsed project IDs for Sessions sections. | expanded |
| `bobbit-collapsed-staff` | `src/app/state.ts::COLLAPSED_STAFF_KEY`, `isStaffExpanded`, `setStaffSectionExpanded` | Collapsed project IDs for Staff sections. | expanded |
| `bobbit-archived-collapsed-projects` | `src/app/state.ts::COLLAPSED_ARCHIVED_KEY`, `isArchivedSectionExpanded`, `setArchivedSectionExpanded`; `src/app/render-helpers.ts::renderProjectArchivedSection` | Collapsed project IDs for per-project Archived sections. | expanded when Show Archived is on |
| `bobbit-collapsed-team-leads` | `src/app/state.ts::COLLAPSED_TEAM_LEADS_KEY`, `isTeamLeadExpanded`, `setTeamLeadExpanded`, `toggleTeamLeadExpanded` | Collapsed team-lead session IDs. | expanded |
| `bobbit-collapsed-first-class-parents` | `src/app/state.ts::COLLAPSED_FIRST_CLASS_PARENTS_KEY`, `isFirstClassParentExpanded`, `setFirstClassParentExpanded`, `toggleFirstClassParentExpanded` | Collapsed first-class parent session IDs. | expanded |
| `bobbit-expanded-delegate-parents` | `src/app/state.ts::EXPANDED_DELEGATE_PARENTS_KEY`, `isArchivedParentExpanded`, `setArchivedParentExpanded`, `toggleArchivedParentExpanded` | Expanded archived delegate parent session IDs. | collapsed |
| `_expandedNestedDepthByProject` | `src/app/sidebar.ts::_expandedNestedDepthByProject` | In-memory depth cap for “Show N more child goals”. | 5, not persisted |
| `bobbit-sidebar-collapsed` | `src/app/state.ts::state.sidebarCollapsed`, `src/app/sidebar.ts::toggleSidebar`, `renderCollapsedSidebar` | Shell width mode, not tree node expansion. | expanded shell |
| `bobbit:sidebar-tree-indent` | `src/app/sidebar-tree-layout.ts::SIDEBAR_TREE_INDENT_KEY`, `loadSidebarTreeIndentPx`, `saveSidebarTreeIndentPx`, `resetSidebarTreeIndentPreference` | Per-browser nested sidebar tree indentation. This is shipped layout state, not tree node expansion state. | `16` px, clamped to `8`–`28` for finite values; invalid values default |

## Node-key model

Use a typed object internally and a canonical serialized string for DOM attributes and storage. Entity identity must not include volatile render location unless the same entity intentionally needs multiple independent disclosure states.

```ts
export type SidebarTreeNodeKey =
  | { kind: "project"; projectId: string }
  | { kind: "project-sessions"; projectId: string }
  | { kind: "project-staff"; projectId: string }
  | { kind: "project-archived"; projectId: string }
  | { kind: "goal"; goalId: string }
  | { kind: "team-lead"; sessionId: string }
  | { kind: "session-children"; sessionId: string; childClass: "first-class" | "archived-delegate" }
  | { kind: "session"; sessionId: string };
```

Canonical string form:

```ts
sidebar-tree/v1/<kind>/<url-encoded-id>[?childClass=...]
```

Examples:

- `sidebar-tree/v1/project/proj_123`
- `sidebar-tree/v1/goal/goal_abc`
- `sidebar-tree/v1/session-children/sess_1?childClass=archived-delegate`

Rules:

- Use `encodeURIComponent` for every entity ID. Never split raw IDs on `:` because existing IDs are not guaranteed to avoid punctuation.
- `goal` is keyed by `goalId` only. A goal may render in the nested forest (`sidebar.ts::renderNestedNode`) or under a team lead (`render-helpers.ts::renderTeamGroup` via `selectSpawnedChildren`); it should have one disclosure preference.
- `project-archived` is separate from `project` because it is a subsection controlled by the global Show Archived toggle and currently has its own persisted collapsed set.
- `session-children` includes `childClass` because first-class live child sessions and archived delegate children have different legacy defaults and opposite legacy storage directions.
- `session` is included as a leaf key for `data-nav-id` and active-row unification, but `isExpandable(session)` returns false.

## Node kinds and entity/context fields

| Kind | Entity fields | Optional render context | Expandable | Current call sites |
|---|---|---|---|---|
| `project` | `projectId` | project name/color for labels only | yes | `sidebar.ts::renderProjectHeader`, `renderSidebar` project loop |
| `project-sessions` | `projectId` | project root/provisional status | yes | `sidebar.ts::renderProjectContent` Sessions header |
| `project-staff` | `projectId` | staff count/filter state | yes | `sidebar.ts::renderStaffSidebarSection` |
| `project-archived` | `projectId` | `state.showArchived`, archived counts | yes | `render-helpers.ts::renderProjectArchivedSection` |
| `goal` | `goalId` | projectId, parentGoalId, depth, archived flag, descendantCount | yes | `render-helpers.ts::renderGoalGroup`, `sidebar.ts::renderNestedNode` |
| `team-lead` | `sessionId` | goalId/teamGoalId, live/archived row context | yes | `render-helpers.ts` nested `renderTeamGroup`, archived lead/member rendering, collapsed sidebar team rows |
| `session-children` | `sessionId`, `childClass` | parent session role/status | yes | `renderArchivedSessionRow`, `renderArchivedDelegates`, first-class child rows |
| `session` | `sessionId` | goalId/teamGoalId/projectId | no | `renderSessionRow`, `renderArchivedSessionRow`, keyboard navigation |

Render-only context such as `depth`, `projectId` for a goal, or `archived` status must not be part of stable identity unless two disclosure states are intentionally independent.

## Shared tree-builder contract

`src/app/sidebar-tree-builder.ts` is now the source of truth for sidebar hierarchy. It consumes normalized app data and returns a render-neutral tree. Renderers still own markup, row components, toggles, and viewport-specific affordances, but should not independently decide parent/child ownership, logical depth, expandability, or child ordering.

### As-built public builder API

The module exports key helpers and builder types used by desktop, mobile, collapsed-sidebar, and render-helper paths:

```ts
function sidebarTreeKey(input: SidebarTreeNodeKey): string;
function parseSidebarTreeKey(raw: string): SidebarTreeNodeKey | null;
function isSidebarTreeExpandable(key: SidebarTreeNodeKey): boolean;
function resolveSidebarTreeLayoutPreference(input?: SidebarTreeLayoutPreferenceV1): ResolvedSidebarTreeLayoutPreference;
function buildSidebarTree(input: BuildSidebarTreeInput): SidebarTreeModel;
```

`BuildSidebarTreeInput` is state-adapter friendly. Current renderers pass legacy expansion helpers through the `expansion` adapter until the storage migration exists.

```ts
interface BuildSidebarTreeInput {
  projects: readonly ProjectLike[];
  goals: readonly GoalLike[];
  sessions: readonly SessionLike[];
  archivedSessions: readonly SessionLike[];
  staff?: readonly StaffLike[];
  showArchived: boolean;
  viewport?: "desktop" | "mobile" | "collapsed";
  projectOrder?: readonly string[];
  nestedDepthByProject?: ReadonlyMap<string, number> | Record<string, number>;
  defaultNestedDepth?: number;
  expansion?: SidebarTreeExpansionInput;
  layout?: SidebarTreeLayoutPreferenceV1;
  filters?: SidebarTreeFilters;
}

interface SidebarTreeFilters {
  activeSessionId?: string;
  includeArchived?: boolean;
  searchQuery?: string;
  bypassBusyReadFilters?: boolean;
  passesSessionFilters?: (session: SessionLike, active: boolean, bypass: boolean) => boolean;
}

interface SidebarTreeExpansionInput {
  isExpanded?: (key: SidebarTreeNodeKey, defaultExpanded: boolean) => boolean;
  defaultExpanded?: (key: SidebarTreeNodeKey, defaultExpanded: boolean) => boolean;
}
```

Every emitted `SidebarTreeNode` carries structural and render context, but not row markup:

```ts
interface SidebarTreeNode<TContext = unknown> {
  key: string;
  canonicalKey: string;
  nodeKey: SidebarTreeNodeKey;
  kind: SidebarTreeNodeKind;
  entityId: string;
  parentKey: string | null;
  children: SidebarTreeNode[];
  logicalDepth: number;
  depth: number;
  indentDepth: number;
  indentLevel: number;
  indentPx: number;
  expandable: boolean;
  expansionClass?: "project" | "section" | "goal" | "team-lead" | "session-children";
  defaultExpanded: boolean;
  expanded: boolean;
  hiddenByFilter?: boolean;
  context: TContext;
}
```

`SidebarTreeModel` groups per-project output and lookup/diagnostic helpers:

- `projects`: ordered `SidebarProjectTree[]` with project, goal forest, Sessions/Staff/Archived section nodes, ungrouped sessions, archived nodes, and staff rows.
- `flatByKey`: all registered nodes by canonical string key.
- `claimedSpawnedGoalIds`: goals claimed for team-lead placement and omitted from the project forest.
- `spawnedGoalNodesByLeadSessionId` and `sessionChildrenNodesBySessionId`: lookup maps for render helpers.
- `diagnostics`: non-fatal cycle, duplicate ID/key, and cross-project-parent findings.

Context payloads are typed by node role: `ProjectContext`, `ProjectSectionContext`, `GoalContext`, `TeamLeadContext`, `SessionChildrenContext`, and `SessionContext`. They carry source entities and render-neutral metadata such as descendant counts, archived flags, owner lead session IDs, child key lists, search matches, and active-session candidacy.

### Ownership and ordering invariants

- Each expandable row that shows a chevron appears exactly once in the built tree and has `expanded`/`defaultExpanded` resolved through builder expansion metadata. Until `sidebar-tree-state.ts` exists, those values come from legacy adapter callbacks.
- A goal is rendered either in the project nested goal forest, the archived section forest, or under the owning team lead selected by `selectSpawnedChildren()`, never more than once. The builder tracks `claimedSpawnedGoalIds`, `spawnedRootGoalIds`, and emitted goal IDs to prevent duplicates.
- `parentKey` and `children` describe the rendered sidebar hierarchy, not only domain parentage. A sub-goal shown under a team lead has the team-lead row as its rendered parent even though its domain `parentGoalId` remains goal metadata.
- `logicalDepth`/`depth` are rendered tree depth. `indentDepth`/`indentLevel` and `indentPx` are layout metadata; renderers should consume them rather than recomputing hierarchy from raw state.
- Search/filtering may set `hiddenByFilter` or omit whole subtrees, but must not write expansion preferences.
- Desktop, mobile, and collapsed-sidebar paths call the same builder with a `viewport` value. Viewport-specific rendering can omit labels or containers, but it should preserve canonical keys, active state, ordering, expandability, and indentation semantics for rows it renders.
- `_expandedNestedDepthByProject` remains a render-local truncation cap passed into `nestedDepthByProject`; it must not change node identity or persisted expansion state.

Renderer responsibilities:

- Read `node.key`/`node.canonicalKey` for stable identity and `node.expanded` for disclosure state; pass node indentation metadata through `src/app/sidebar-tree-layout.ts` helpers instead of recomputing padding.
- Keep row-specific visuals such as chevrons, active classes, descendant badges, live/archived ordering, and session status badges, but source structural decisions from `SidebarTreeNode`.
- Avoid adding new hierarchy logic in renderers. Legacy expansion/storage calls are acceptable only as temporary adapters until the future storage-state module replaces them.

## Default expansion policies

Defaults apply only when no stored preference exists.

| Kind | Default | Reason/current behavior |
|---|---:|---|
| `project` | expanded | `isProjectExpanded()` returns true unless `collapsed:<projectId>` is stored. |
| `project-sessions` | expanded | `isUngroupedExpanded()` returns true unless project is in `bobbit-collapsed-ungrouped`. |
| `project-staff` | expanded | `isStaffExpanded()` mirrors Sessions. |
| `project-archived` | expanded when Show Archived is on | Preserves “Show Archived on means items appear immediately”; current `isArchivedSectionExpanded()` defaults true. |
| `goal` | collapsed | Existing `expandedGoals` stores positive expansions only. Auto-expansion rules below may create a system preference. |
| `team-lead` | expanded | Existing `isTeamLeadExpanded()` defaults true. |
| `session-children:first-class` | expanded | Existing `isFirstClassParentExpanded()` defaults true. |
| `session-children:archived-delegate` | collapsed | Existing `isArchivedParentExpanded()` defaults false unless the session ID is in `bobbit-expanded-delegate-parents`. |
| `session` | not expandable | Leaf row. |

`_expandedNestedDepthByProject` remains render-local and in-memory. The unified state API should not persist “Show N more” depth unless a later UX explicitly asks for it.

## Preference precedence

Resolution order for `isExpanded(key, context)`:

1. **Render-forced transient state**, never persisted. Example: project reorder in `sidebar.ts::renderSidebar` computes an `effectiveExpanded` value that collapses project bodies while dragging. This must stay a render override, not a saved preference.
2. **Explicit user preference** in the new v1 store, including preferences migrated from legacy keys. User toggles always write `source: "user"`; migration writes `source: "migration"` but resolves with the same priority.
3. **System preference** written by create/refresh auto-expansion rules. These writes are allowed only when no explicit user or migrated preference exists for that key.
4. **Kind default** from the table above.

Consequences:

- Polling must not re-expand a goal the user has collapsed. This preserves the invariant documented near `api.ts::refreshSessions`: “never re-expand a goal the user has already seen”.
- A system auto-expansion can be overwritten by the next user toggle.
- Search and filtering changes do not write preferences.
- The collapsed sidebar shell (`bobbit-sidebar-collapsed`) is outside this precedence chain.

## Versioned safe-storage namespace

Use `safeGetJSON`, `safeSetItem`, and `safeRemoveItem` from `src/app/safe-storage.ts`. Persistence must remain best-effort and never break boot or `refreshSessions()`.

Recommended keys:

```ts
const SIDEBAR_TREE_STATE_KEY = "bobbit.sidebarTree.v1";
const SIDEBAR_TREE_MIGRATION_KEY = "bobbit.sidebarTree.migrated.v1";
```

Stored shape:

```ts
interface SidebarTreeStateV1 {
  version: 1;
  updatedAt: number;
  nodes: Record<string, {
    expanded: boolean;
    source: "user" | "migration" | "system";
    updatedAt: number;
  }>;
}
```

Storage rules:

- Store every explicit user preference and every migrated legacy preference as a durable node entry, even when `expanded` equals that kind's default. These entries are tombstones as well as preferences; for example, `goal(<id>)` defaults collapsed, but a user collapse still stores `expanded:false` so create/refresh system expansion cannot reopen it later.
- Store system entries only for auto-expansions needed to preserve create/refresh behavior. System writes must not overwrite an existing `source:"user"` or `source:"migration"` entry.
- Absence from `nodes` means “no stored preference”; it does not mean “default deviation absent for this node after comparing to the default table”.
- Drop entries for entities that no longer exist during opportunistic cleanup, but cleanup must be bounded and best-effort.
- If JSON is corrupt, ignore it and fall back to migration/defaults; do not delete it synchronously during module import.
- Keep indentation outside this node store. The shipped layout preference remains under `bobbit:sidebar-tree-indent` and is owned by `src/app/sidebar-tree-layout.ts`.
- Keep all safe-storage reads/writes for expansion state inside the new `src/app/sidebar-tree-state.ts` module. Renderers and `src/app/api.ts` may call only its exported tree-state API helpers; they must not access expansion storage directly.

## Migration behavior

Migration is idempotent and runs on load whenever `bobbit.sidebarTree.migrated.v1` is absent or whenever the v1 state cannot be verified. It reads legacy keys, merges equivalent v1 node preferences into the existing `bobbit.sidebarTree.v1` state, verifies the v1 write, then sets `bobbit.sidebarTree.migrated.v1 = "true"`. It should not remove legacy keys in the first implementation; leaving them is safer for rollback. Once release confidence is high, a later cleanup can remove them.

`safeSetItem()` currently returns `void` and swallows storage errors, so the migration marker must not rely on its return value. The tree-state module should use a small verified-write helper: write the candidate v1 object, immediately read `bobbit.sidebarTree.v1` back with `safeGetJSON`, compare `version`, `updatedAt`, and representative node content (or a stored migration nonce), and set the marker only after that readback succeeds. If readback fails, leave the marker absent so the next boot retries. An implementation may instead omit the marker entirely and rely on idempotent per-boot merge, but it must not mark migration complete after an unverified write.

If both v1 state and legacy keys exist, existing v1 node entries win per node. Migration fills only missing canonical node keys with `source:"migration"`, preserving existing v1 `nodes`. This avoids skipping legacy migration for partial v1 state while ensuring a failed or retried migration is safe and non-destructive.

If `bobbit.sidebarTree.v1` is corrupt, treat it as unreadable and fall back to defaults plus legacy recovery. Because the first implementation retains legacy keys, corruption should ignore the migration marker for that boot and attempt the idempotent legacy merge into a fresh v1 object. If the fresh write verifies, keep or rewrite `bobbit.sidebarTree.migrated.v1`; if it does not verify, leave the marker state unchanged so the next boot can retry.

Legacy mapping:

| Legacy key | Legacy value | New key | New value |
|---|---|---|---|
| `bobbit-expanded-projects` | array entries `collapsed:<projectId>` | `project(projectId)` | `expanded:false` |
| `bobbit-expanded-goals` | array of `goalId` | `goal(goalId)` | `expanded:true` |
| `bobbit-collapsed-ungrouped` | array of `projectId` | `project-sessions(projectId)` | `expanded:false` |
| `bobbit-collapsed-staff` | array of `projectId` | `project-staff(projectId)` | `expanded:false` |
| `bobbit-archived-collapsed-projects` | array of `projectId` | `project-archived(projectId)` | `expanded:false` |
| `bobbit-collapsed-team-leads` | array of `sessionId` | `team-lead(sessionId)` | `expanded:false` |
| `bobbit-collapsed-first-class-parents` | array of `sessionId` | `session-children(sessionId, "first-class")` | `expanded:false` |
| `bobbit-expanded-delegate-parents` | array of `sessionId` | `session-children(sessionId, "archived-delegate")` | `expanded:true` |

Special cases:

- `bobbit-sidebar-collapsed` is a shell preference, not a tree-node preference. Do not migrate it into `bobbit.sidebarTree.v1`.
- `bobbit-show-archived` is a visibility filter, not a disclosure preference. Do not migrate it.
- `bobbit:sidebar-tree-indent` is the shipped indentation preference, not a disclosure preference. Do not migrate it into `bobbit.sidebarTree.v1`.
- `_expandedNestedDepthByProject` is in-memory render state. Do not migrate it.
- For `bobbit-expanded-projects`, ignore malformed entries that do not start with `collapsed:` unless a compatibility test demonstrates older plain project IDs exist.
- Ignore non-array legacy values via `safeGetJSON(key, [])` semantics.

### Legacy goal collapsed-tombstone recovery

`bobbit-expanded-goals` cannot distinguish “never expanded” from “explicitly collapsed after auto-expansion.” Migration must therefore prevent the first post-migration `/api/goals` hydration from treating every legacy-absent goal as a fresh unseen goal eligible for system expansion.

Add a hydration-completion helper, e.g. `completeLegacyGoalExpansionMigration(goals, sessions)`, called by `refreshSessions()` after the first successful goals/sessions payload when legacy migration is pending or just completed. It should:

1. Read the legacy `bobbit-expanded-goals` set.
2. For every goal present in the initial payload that is absent from that legacy expanded set, write a missing v1 `goal(goalId)` entry with `expanded:false`, `source:"migration"`.
3. Preserve any existing v1 user/migration/system entry for that goal.
4. Mark the goal-hydration migration complete only after the v1 write verifies, using the same verified-write strategy as the base migration.
5. Suppress `refreshSessions()` system auto-expansion for the same initial payload.

This intentionally treats legacy-absent existing goals as collapsed tombstones. It preserves explicit legacy collapse intent and aligns with the new default that goal and sub-goal branches are collapsed unless the user expands them or the current tab creates them. Newly discovered goals after the hydration-completion marker is verified may still use the narrower system rules below.

## Future tree-state API shape

Create a focused storage/state module, e.g. `src/app/sidebar-tree-state.ts`, consumed by `sidebar.ts`, `render-helpers.ts`, `sidebar-nav.ts`, and `api.ts`. This module is not implemented in the current builder-integration branch.

```ts
export type SidebarTreeNodeKind = SidebarTreeNodeKey["kind"];

export function sidebarTreeKey(input: SidebarTreeNodeKey): string;
export function parseSidebarTreeKey(raw: string): SidebarTreeNodeKey | null;
export function isSidebarTreeExpandable(key: SidebarTreeNodeKey): boolean;

export function isSidebarTreeExpanded(
  key: SidebarTreeNodeKey,
  context?: { transientCollapsed?: boolean }
): boolean;

export function setSidebarTreeExpanded(
  key: SidebarTreeNodeKey,
  expanded: boolean,
  opts?: { source?: "user" | "system"; render?: boolean }
): void;

export function toggleSidebarTreeExpanded(
  key: SidebarTreeNodeKey,
  opts?: { source?: "user"; render?: boolean }
): boolean;

export function setSidebarTreeSystemExpandedIfUnset(
  key: SidebarTreeNodeKey,
  expanded: boolean
): boolean;

export function getSidebarTreePreferenceSource(
  key: SidebarTreeNodeKey
): "user" | "migration" | "system" | "default";

export function migrateLegacySidebarTreeState(): void;
export function completeLegacyGoalExpansionMigration(
  goals: readonly Goal[],
  sessions: readonly Session[]
): "already-complete" | "completed-this-payload" | "retry-needed";
export function pruneSidebarTreeState(liveIds: {
  projectIds?: ReadonlySet<string>;
  goalIds?: ReadonlySet<string>;
  sessionIds?: ReadonlySet<string>;
}): void;
```

The indentation preference is already implemented separately in `src/app/sidebar-tree-layout.ts` and re-exported from app state where needed. The future disclosure-state module should import or re-export those helpers only as a facade; it should not create a second indentation storage path.

API semantics:

- `setSidebarTreeExpanded(..., { source:"user" })` always writes a node entry for expandable keys, including values that equal the kind default.
- `setSidebarTreeSystemExpandedIfUnset` treats a node as unset only when no stored user/migration preference exists. It must check stored node source, not whether the requested value differs from the default. It returns `false` and writes nothing for `source:"user"` or `source:"migration"` entries; it may create or update `source:"system"` entries and return `true`.
- `isSidebarTreeExpanded` resolves by precedence: transient render override, stored user/migration entry, stored system entry, then kind default.

Compatibility adapters can keep existing imports stable during incremental rollout:

- `isProjectExpanded(projectId)` and `toggleProjectExpanded(projectId)` in `sidebar.ts` delegate to `project(projectId)`.
- `expandedGoals` direct mutation should be replaced by `goal(goalId)` helpers. During transition, avoid exporting mutable `Set`s for new code.
- `isUngroupedExpanded`, `setUngroupedExpanded`, `isStaffExpanded`, `setStaffSectionExpanded`, `isArchivedSectionExpanded`, `setArchivedSectionExpanded`, `isTeamLeadExpanded`, `setTeamLeadExpanded`, `isFirstClassParentExpanded`, and `isArchivedParentExpanded` become wrappers or are inlined into call sites.

## Refresh and `createGoal()` interaction rules

### `refreshSessions()`

Current behavior in `api.ts::refreshSessions`: when `/api/goals` returns newly discovered goals, it expands goals that have sessions and also expands their parent so nested child rows become visible.

New rule:

1. On the first successful post-migration goals/sessions payload, call `completeLegacyGoalExpansionMigration(goals, sessions)` and do not perform system auto-expansion for that payload.
2. On later refreshes, system auto-expand only newly discovered **top-level** goals that have sessions and have no user/migration preference. Do not auto-expand newly discovered sub-goals and do not auto-expand their parents.
3. Never write a system expansion if the goal has any stored user/migration preference.

```ts
const legacyHydration = completeLegacyGoalExpansionMigration(goals, sessions);

if (legacyHydration !== "completed-this-payload") {
  for each newly discovered goal g:
    if !g.parentGoalId && goal has at least one session:
      setSidebarTreeSystemExpandedIfUnset(goal(g.id), true)
}
```

This preserves legacy top-level live-goal visibility without reopening collapsed migrated goals. It also makes sub-goal branches collapsed by default on polling/discovery; a child row appears only after the user expands its parent or after an explicit creation flow below expands the necessary ancestors.

### `createGoal()`

Current behavior in `api.ts::createGoal`: after POST and `refreshSessions()`, it unconditionally adds the returned goal to `expandedGoals`.

New rule:

- The newly created goal should be visible and expanded as a system action.
- If the goal has `parentGoalId`, expand its parent chain far enough for the row to be visible. At minimum expand `parentGoalId`; if ancestors are present in `state.goals`, expand all ancestors until root.
- Because the goal is new, user preference normally does not exist. Still call `setSidebarTreeSystemExpandedIfUnset` to avoid clobbering a rare race where another tab already wrote a preference.

```ts
setSidebarTreeSystemExpandedIfUnset(goal(newGoal.id), true)
for ancestor of newGoal in current goal tree:
  setSidebarTreeSystemExpandedIfUnset(goal(ancestor.id), true)
```

`createGoal()` should not modify project, staff, sessions, team-lead, or archived delegate preferences.

## Keyboard navigation implications

`src/app/sidebar-nav.ts` currently defines `NavKind`, `navIdFor`, `parseNavId`, `isNavItemExpanded`, and `setNavItemExpanded`. The new tree key should become the DOM/nav ID for sidebar rows:

- Renderers set `data-nav-id=${sidebarTreeKey(nodeKey)}` and `data-nav-active` as today.
- `getVisibleNavOrder()` remains DOM-driven; search filters, Show Archived, collapsed sections, and project reordering continue to affect visible navigation naturally.
- `Ctrl+↑` / `Ctrl+↓` keep using visible DOM order and `openForNavItem` semantics.
- `Ctrl+→` / `Ctrl+←` call `isSidebarTreeExpandable`, `isSidebarTreeExpanded`, and `setSidebarTreeExpanded` rather than switching on legacy nav kinds.
- `navIdToHash` keeps mapping leaves/headers to routes: `session` to session route, `goal` to goal dashboard, `project` to settings, staff header to staff route, and project-sessions/project-archived to landing. Headers without direct routes continue using the keyboard override to retain highlight.
- Rows with children should set `aria-expanded` from `isSidebarTreeExpanded(key)`; leaves should omit it.

The existing active override behavior in `getActiveNavId()` and the rapid-keypress guard around authored hashes should remain; only the ID format and expansion API should change.

## Indentation preference model

Indentation is shipped layout state, not node expansion state. Node keys do not encode indentation, and the future expansion-state migration must not move indentation into the node preference store.

Historical context: the builder integration originally found several ad-hoc render offsets, including shared `INDENT` containers, `node.depth * 16` nested-goal padding, direct `node.indentPx` strings, and collapsed-sidebar `padding-left:6px` wrappers. Those paths now consume `src/app/sidebar-tree-layout.ts` helpers and builder metadata instead of recomputing hierarchy-specific padding in renderers.

Implemented model:

```ts
interface SidebarTreeLayoutPreferenceV1 {
  version: 1;
  indentMode?: "compact" | "comfortable" | "spacious";
  baseIndentPx?: number;
  nestedGoalIndentPx?: number;
}
```

Rules:

- The user-facing setting is **Sidebar tree indentation** under Settings → General → Appearance.
- The setting is stored per browser in `localStorage` under `bobbit:sidebar-tree-indent`.
- The only user-controlled value is `nestedGoalIndentPx`; `baseIndentPx` remains fixed at `5` px so compact non-goal child spacing does not drift.
- Default spacing is `indentMode:"comfortable"`, `baseIndentPx:5`, and `nestedGoalIndentPx:16`.
- Finite custom values are rounded to the `1` px step and clamped to `8`–`28` px before storage and DOM application.
- Missing, empty, unavailable, throwing, non-numeric, `NaN`, or infinite values default to `16` px.
- Reset writes the default value, reapplies CSS variables, and triggers the normal sidebar rerender path.
- Collapsed-sidebar spacing is derived as `min(6, max(2, round(nestedGoalIndentPx / 3)))` so nesting remains visible without creating collapsed-mode overflow.
- Font scale and indentation remain independent accessibility controls. Do not migrate sidebar font-size preferences into indentation.
- Do not persist per-project or per-depth indentation.

Runtime CSS variables are written on `document.documentElement` by `applySidebarTreeLayoutVars()`:

| Variable | Meaning |
|---|---|
| `--sidebar-tree-base-indent` | Fixed compact child spacing, `5px`. |
| `--sidebar-tree-nested-goal-indent` | User-configured nested goal spacing. |
| `--sidebar-tree-collapsed-indent` | Derived capped spacing for collapsed sidebar nesting. |

`.sidebar-root` owns only fallback/default variables with distinct names, including `--sidebar-tree-base-indent-default`, `--sidebar-tree-nested-goal-indent-default`, `--sidebar-tree-collapsed-indent-default`, and `--sidebar-tree-half-indent`. Row-internal chevron slots remain governed by existing chevron variables such as `--sidebar-chevron-w` and `--sidebar-header-chevron-w`.

Renderer contract:

- Desktop, mobile, and collapsed sidebar builders pass `loadSidebarTreeLayoutPreference()` into `buildSidebarTree()`.
- Renderers use helper-generated `padding-inline-start` styles such as `sidebarTreeBaseIndentStyle()`, `sidebarTreeHalfIndentStyle()`, `sidebarTreeNodeIndentStyle(node)`, `sidebarTreeLegacyGoalIndentStyle(depth)`, `sidebarTreeTruncationIndentStyle(depth)`, and `sidebarTreeCollapsedIndentStyle(depth?)`.
- Keep `min-w-0`, `truncate`, overflow gradients, active row classes, and chevron slot padding independent from the indent preference.

See [../sidebar-tree-indentation.md](../sidebar-tree-indentation.md) for the durable feature contract and current test coverage.

## Goal-dashboard Plan tab disclosure is out of scope

Goal-dashboard Plan tab disclosure state is out of scope for this sidebar tree-state migration.

Rationale:

- Plan tab disclosure state lives in `src/app/goal-dashboard-plan-tab.ts`, not in the sidebar. It uses `_planCollapsedGoals`, `_isPlanExpanded`, and `_togglePlanExpanded` for recursive plan rendering.
- The Plan tab tree is a plan graph/view of child goals, not the sidebar navigation tree. It can synthesize formal plan nodes and child-goal plan steps through `computePlanStepsForGoal`, while the sidebar is an entity navigation tree.
- The Plan tab state is currently in-memory and defaults expanded. Persisting it would require separate UX decisions about dashboard-local state, not a sidebar storage migration.
- Keeping it separate prevents a sidebar collapse of `goal(<id>)` from unexpectedly hiding plan details inside a dashboard tab, and vice versa.

If persisted Plan tab disclosure is later desired, define a separate `goalDashboard.planTree.v1` namespace and do not reuse sidebar node keys except as entity references.

## Implementation status and remaining work

Completed so far:

- Added `src/app/sidebar-tree-builder.ts` with stable canonical keys, typed node keys, render-neutral node/context output, layout metadata, viewport input, spawned-child ownership, duplicate diagnostics, and focused unit coverage for builder shape and invariants.
- Routed desktop sidebar construction through the builder while preserving legacy expansion adapters, project ordering, nested-depth caps, filtering, active highlighting, archived placement, and descendant badges.
- Routed mobile landing and collapsed-sidebar/render-helper paths through builder-derived nodes or lookup maps so they share hierarchy and spawned-child placement instead of recomputing it from raw state.
- Shipped the sidebar tree indentation preference in `src/app/sidebar-tree-layout.ts`, including `bobbit:sidebar-tree-indent` storage, `8`–`28` px clamping, reset behavior, document-level CSS variables, shared renderer helpers, and unit/browser coverage.
- Kept legacy expansion storage and toggle helpers in place as temporary adapters; this avoids mixing hierarchy refactor risk with disclosure-state migration risk.

Deferred future work:

1. Add `src/app/sidebar-tree-state.ts` with expansion storage helpers, defaults, verified-write migration, legacy goal collapsed-tombstone recovery, and compatibility adapters.
2. Call expansion-state migration during app bootstrap before first sidebar render, and call the goal hydration-completion helper from the first successful `refreshSessions()` payload before any system auto-expansion.
3. Replace remaining direct legacy expansion reads/writes in `sidebar.ts`, `render-helpers.ts`, `sidebar-nav.ts`, and `api.ts` with the new state API, then remove legacy-key adapters after migration confidence is high.
4. Migrate keyboard navigation IDs from legacy strings to `parseSidebarTreeKey`/`sidebarTreeKey`, while retaining route mapping and active override behavior.
5. Replace `api.ts` direct `expandedGoals.add()` / `saveExpandedGoals()` calls with narrowed system-expansion helpers: top-level polling only, explicit create flow for newly created goals and ancestors.
6. Add focused tests for migration, default resolution, user-over-system precedence, refresh/createGoal auto-expansion, keyboard `Ctrl+←/→` expansion, malformed canonical key parsing, corrupt v1 JSON fallback, migration marker write-failure retry, malformed legacy entries, and bounded prune behavior.

## Required verification plan

Unit coverage:

- Tree-state helper: defaults for every node kind, explicit user/migration precedence over system/defaults, source tracking, key serialization/parsing with encoded IDs, key separation for first-class vs archived delegates, corrupt/missing storage fallback, verified-write migration retry behavior, malformed legacy values, legacy collapsed-goal tombstone recovery, and bounded pruning.
- Tree builder: stable canonical keys, parent/children shape, `depth` and `indentLevel`, active-session context metadata, desktop/mobile/collapsed parity for emitted rows, archived/live ordering, staff/sessions/archived section placement, team-lead ownership, first-class child sessions, delegate/archive delegate children, and no duplicate spawned child-goals.
- Refresh/create integration: initial hydration does not system-expand migrated legacy-absent goals, later polling auto-expands only eligible top-level goals, newly discovered sub-goals do not auto-open parents, and `createGoal()` expands only the newly created goal plus ancestors when unset.
- Existing indentation coverage: `tests/sidebar-tree-layout.test.ts`, `tests/sidebar-tree-builder.test.ts`, and `tests/e2e/ui/sidebar-indent.spec.ts` cover clamping, invalid value fallback, reset, persistence, CSS variable values, fixed base spacing, visible offset changes, and supported-value overflow behavior.

Browser E2E coverage:

- Representative sidebar disclosures: project, project Sessions, Staff, Archived, parent goal with sub-goal collapsed by default, team lead, first-class child session parent, live delegate parent, archived delegate parent, and keyboard `Ctrl+←/→` for every row type that presents a chevron.
- Indentation customization: visible offset changes at min/default/max, hard refresh persistence, reset behavior, seeded out-of-range storage clamping, and no horizontal overflow at supported values.
- Mobile and collapsed sidebar parity for rows that are visible in those surfaces.

Restart/manual coverage:

- Explicit collapse/expand choices for project, goal/sub-goal, team-lead, first-class child parent, archived delegate parent, and archived section survive a hard browser refresh and gateway/server restart.
- Indentation preference survives hard refresh and gateway/server restart.
- A collapsed parent goal remains collapsed when a new child/sub-goal is discovered by polling after restart.

Final commands:

- Run `npm run check`.
- Run `npm run test:unit`.
- Run relevant sidebar browser E2E, including `tests/e2e/ui/sidebar-indent.spec.ts` when indentation behavior changes.

## Focused verification performed for this design

- Inspected required sources: `src/app/sidebar.ts`, `src/app/render-helpers.ts`, `src/app/api.ts`, `src/app/sidebar-nav.ts`, `src/app/sidebar-nesting.ts`, and `src/app/sidebar-spawned-children.ts`.
- Ran a legacy-key search with:

```bash
git grep -n -E "bobbit-(expanded-goals|expanded-projects|collapsed-ungrouped|collapsed-staff|archived-collapsed-projects|collapsed-team-leads|collapsed-first-class-parents|expanded-delegate-parents|sidebar-collapsed)|_planCollapsedGoals|expandedGateIds|treeCostExpanded|expandedLiveStepKeys|expandedArtifactKeys" -- src/app docs tests
```

- Confirmed Plan tab disclosure state is separate by checking `goal-dashboard-plan-tab.ts` for `_planCollapsedGoals`, `_isPlanExpanded`, and `_togglePlanExpanded`.
- Confirmed refresh/createGoal still directly mutate `expandedGoals` in `api.ts::refreshSessions` and `api.ts::createGoal`.
- Reran `git diff --check -- docs/design/sidebar-tree-state.md` after polishing.
- Confirmed the design artifact references existing source files with a focused Node sanity check.
