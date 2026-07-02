# Unified sidebar tree state design

Status: design only. No production code is implemented here.

## Problem

Sidebar expansion state is currently split across several module-level sets and localStorage keys. The same visual tree is rendered through multiple paths:

- Desktop sidebar shell and project sections: [`src/app/sidebar.ts::renderSidebar`](../../src/app/sidebar.ts#L1468), [`renderProjectHeader`](../../src/app/sidebar.ts#L1211), [`renderProjectContent`](../../src/app/sidebar.ts#L1356), [`renderNestedNode`](../../src/app/sidebar.ts#L1320).
- Shared goal/session rows and archived subsections: [`src/app/render-helpers.ts::renderGoalGroup`](../../src/app/render-helpers.ts#L1314), nested `renderTeamGroup` inside it, [`renderProjectArchivedSection`](../../src/app/render-helpers.ts#L878), `renderArchivedSessionRow`, and `renderArchivedDelegates`.
- Keyboard navigation: [`src/app/sidebar-nav.ts`](../../src/app/sidebar-nav.ts) currently uses string `data-nav-id` values like `goal:<id>` and maps them back to expansion functions.
- Data refresh and goal creation: [`src/app/api.ts::refreshSessions`](../../src/app/api.ts#L435) and [`createGoal`](../../src/app/api.ts#L1605) mutate `expandedGoals` directly.
- Tree shape helpers: [`src/app/sidebar-nesting.ts::buildNestedGoalForest`](../../src/app/sidebar-nesting.ts#L145) and [`src/app/sidebar-spawned-children.ts::computeSpawnedClaim`](../../src/app/sidebar-spawned-children.ts#L116).

The implementation should introduce one typed node-key model and one safe-storage-backed preference layer used by renderers, keyboard navigation, refresh, and create-goal flows.

## Goals

1. Stable typed node keys that survive reordering, filtering, refreshes, nesting path changes, and archived/live relocation.
2. Explicit expansion preference precedence so user choices are not undone by polling or create/refresh side effects.
3. Versioned safe-storage namespace with deterministic migration from every legacy sidebar expansion key.
4. Public API small enough for renderers and navigation to consume without knowing storage details.

## Non-goals

- Do not change production code in this design task.
- Do not include chat side panels, goal-dashboard gate rows, live verification rows, artifact rows, tree-cost disclosure, or marketplace/proposal disclosures.
- Do not include goal-dashboard Plan tab nested disclosure state; rationale is below.

## Current state inventory

| Current storage/state | File reference | Meaning | Default |
|---|---|---|---|
| `bobbit-expanded-projects` | [`sidebar.ts` lines 53-67](../../src/app/sidebar.ts#L53) | Set values are `collapsed:<projectId>`; absence means project expanded. | expanded |
| `bobbit-expanded-goals` | [`state.ts` lines 570-574](../../src/app/state.ts#L570) | Set of expanded `goalId`s. | collapsed, except auto rules |
| `bobbit-collapsed-ungrouped` | [`state.ts` lines 578-595](../../src/app/state.ts#L578) | Collapsed project IDs for Sessions sections. | expanded |
| `bobbit-collapsed-staff` | [`state.ts` lines 579-605](../../src/app/state.ts#L579) | Collapsed project IDs for Staff sections. | expanded |
| `bobbit-archived-collapsed-projects` | [`state.ts` lines 608-624](../../src/app/state.ts#L608), [`render-helpers.ts` lines 780-784](../../src/app/render-helpers.ts#L780) | Collapsed project IDs for per-project Archived sections. | expanded when Show Archived is on |
| `bobbit-collapsed-team-leads` | [`state.ts` lines 627-648](../../src/app/state.ts#L627) | Collapsed team-lead session IDs. | expanded |
| `bobbit-collapsed-first-class-parents` | [`state.ts` lines 651-667](../../src/app/state.ts#L651) | Collapsed first-class parent session IDs. | expanded |
| `bobbit-expanded-delegate-parents` | [`state.ts` lines 670-686](../../src/app/state.ts#L670) | Expanded archived delegate parent session IDs. | collapsed |
| `_expandedNestedDepthByProject` | [`sidebar.ts` lines 1280-1295](../../src/app/sidebar.ts#L1280) | In-memory depth cap for “Show N more child goals”. | 5, not persisted |
| `bobbit-sidebar-collapsed` | [`state.ts` line 363](../../src/app/state.ts#L363), [`sidebar.ts` lines 831-833](../../src/app/sidebar.ts#L831) | Shell width mode, not tree node expansion. | expanded shell |

## Node-key model

Use a typed object internally and a canonical serialized string for DOM attributes and storage. Entity identity must not include volatile render location unless the same entity can have multiple independent disclosure states.

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
- `session-children` includes `childClass` because first-class live child sessions and archived delegate children have different legacy defaults and legacy storage directions.
- `session` is included as a leaf key for `data-nav-id`/active-row unification, but `isExpandable(session)` returns false.

## Node kinds and entity/context fields

| Kind | Entity fields | Optional render context | Expandable | Current call sites |
|---|---|---|---|---|
| `project` | `projectId` | project name/color for labels only | yes | `sidebar.ts::renderProjectHeader`, `renderSidebar` project loop |
| `project-sessions` | `projectId` | project root/provisional status | yes | `sidebar.ts::renderProjectContent` Sessions header |
| `project-staff` | `projectId` | staff count/filter state | yes | `sidebar.ts::renderStaffSidebarSection` |
| `project-archived` | `projectId` | `state.showArchived`, archived counts | yes | `render-helpers.ts::renderProjectArchivedSection` |
| `goal` | `goalId` | projectId, parentGoalId, depth, archived flag, descendantCount | yes | `render-helpers.ts::renderGoalGroup`, `sidebar.ts::renderNestedNode` |
| `team-lead` | `sessionId` | goalId/teamGoalId, live/archived row context | yes | `render-helpers.ts` nested `renderTeamGroup`, archived `renderLeadWithMembers`, collapsed sidebar team rows |
| `session-children` | `sessionId`, `childClass` | parent session role/status | yes | `renderArchivedSessionRow`, `renderArchivedDelegates`, first-class child rows |
| `session` | `sessionId` | goalId/teamGoalId/projectId | no | `renderSessionRow`, `renderArchivedSessionRow`, keyboard navigation |

Render-only context such as `depth`, `projectId` for a goal, or `archived` status must not be part of stable identity unless two disclosure states are intentionally independent.

## Default expansion policies

Defaults apply only when no stored preference exists.

| Kind | Default | Reason/current behavior |
|---|---:|---|
| `project` | expanded | `isProjectExpanded()` returns true unless `collapsed:<projectId>` is stored. |
| `project-sessions` | expanded | `isUngroupedExpanded()` returns true unless project is in `bobbit-collapsed-ungrouped`. |
| `project-staff` | expanded | `isStaffExpanded()` mirrors Sessions. |
| `project-archived` | expanded when Show Archived is on | Preserves “See Archived on means items appear immediately”; current `isArchivedSectionExpanded()` defaults true. |
| `goal` | collapsed | Existing `expandedGoals` stores positive expansions only. Auto-expansion rules below may create a system preference. |
| `team-lead` | expanded | Existing `isTeamLeadExpanded()` defaults true. |
| `session-children:first-class` | expanded | Existing `isFirstClassParentExpanded()` defaults true. |
| `session-children:archived-delegate` | collapsed | Existing `isArchivedParentExpanded()` defaults false unless session ID is in `bobbit-expanded-delegate-parents`. |
| `session` | not expandable | Leaf row. |

`_expandedNestedDepthByProject` remains render-local and in-memory. The unified state API should not persist “Show N more” depth unless a later UX explicitly asks for it.

## Preference precedence

Resolution order for `isExpanded(key, context)`:

1. **Render-forced transient state**, never persisted. Example: project reorder currently renders all project bodies collapsed via `effectiveExpanded = isProjectReordering() ? false : expanded` in [`sidebar.ts` lines 1665-1672](../../src/app/sidebar.ts#L1665). This must stay a render override, not a saved preference.
2. **Explicit user preference** in the new v1 store, including preferences migrated from legacy keys. User toggles always write `source: "user"`; migration writes `source: "migration"` but resolves with the same priority.
3. **System preference** written by create/refresh auto-expansion rules. These are allowed only when no explicit/migrated preference exists for that key.
4. **Kind default** from the table above.

Consequences:

- Polling must not re-expand a goal the user has collapsed. This preserves the current comment in [`api.ts::refreshSessions`](../../src/app/api.ts#L562): “never re-expand a goal the user has already seen”.
- A system auto-expansion can be overwritten by the next user toggle.
- Search/filtering changes do not write preferences.
- The collapsed sidebar shell (`bobbit-sidebar-collapsed`) is outside this precedence chain.

## Versioned safe-storage namespace

Use `safeGetJSON`, `safeSetItem`, and `safeRemoveItem` from [`src/app/safe-storage.ts`](../../src/app/safe-storage.ts). Persistence must remain best-effort and never break boot or `refreshSessions()`.

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
  layout?: SidebarTreeLayoutPreferenceV1;
}

interface SidebarTreeLayoutPreferenceV1 {
  version: 1;
  baseIndentPx?: number;
  nestedGoalIndentPx?: number;
}
```

Storage rules:

- Store every explicit user preference and every migrated legacy preference as a durable node entry, even when `expanded` equals that kind's default. These entries are tombstones as well as preferences; for example, `goal(<id>)` defaults collapsed, but a user collapse still stores `expanded:false` so create/refresh system expansion cannot re-open it later.
- Store system entries only for auto-expansions needed to preserve create/refresh behavior. System writes must not overwrite an existing `source:"user"` or `source:"migration"` entry.
- Absence from `nodes` means “no stored preference”; it does not mean “default deviation absent for this node after comparing to the default table”.
- Drop entries for entities that no longer exist during opportunistic cleanup, but cleanup must be bounded and best-effort.
- If JSON is corrupt, ignore it and fall back to migration/defaults; do not delete it synchronously during module import.
- Keep all safe-storage reads/writes inside the new `src/app/sidebar-tree-state.ts` module. Renderers and `src/app/api.ts` may call only its exported tree-state API helpers; they must not access storage directly.

## Migration behavior

Migration is idempotent and runs on load whenever `bobbit.sidebarTree.migrated.v1` is absent. It reads legacy keys, merges equivalent v1 node preferences into the existing `bobbit.sidebarTree.v1` state, then sets `bobbit.sidebarTree.migrated.v1 = "true"` only after the merged v1 write succeeds. It should not remove legacy keys in the first implementation; leaving them is safer for rollback. Once release confidence is high, a later cleanup can remove them.

If both v1 state and legacy keys exist, existing v1 node entries win per node. Migration fills only missing canonical node keys with `source:"migration"`, preserving existing v1 `nodes` and `layout` fields. This avoids skipping legacy migration for partial v1 state while ensuring a failed/retried migration is safe and non-destructive.

If `bobbit.sidebarTree.v1` is corrupt, treat it as unreadable and fall back to defaults plus legacy recovery. Because the first implementation retains legacy keys, corruption should ignore the migration marker for that boot and attempt the idempotent legacy merge into a fresh v1 object. If the fresh write succeeds, keep or rewrite `bobbit.sidebarTree.migrated.v1`; if it fails, leave the marker state unchanged so the next boot can retry.

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
- `_expandedNestedDepthByProject` is in-memory render state. Do not migrate it.
- For `bobbit-expanded-projects`, ignore malformed entries that do not start with `collapsed:` unless a compatibility test demonstrates older plain project IDs exist.
- Ignore non-array legacy values via `safeGetJSON(key, [])` semantics.

## Public API shape

Create a focused module, e.g. `src/app/sidebar-tree-state.ts`, consumed by `sidebar.ts`, `render-helpers.ts`, `sidebar-nav.ts`, and `api.ts`.

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

export function migrateLegacySidebarTreeState(): void;
export function pruneSidebarTreeState(liveIds: {
  projectIds?: ReadonlySet<string>;
  goalIds?: ReadonlySet<string>;
  sessionIds?: ReadonlySet<string>;
}): void;
```

API semantics:

- `setSidebarTreeExpanded(..., { source:"user" })` always writes a node entry for expandable keys, including values that equal the kind default.
- `setSidebarTreeSystemExpandedIfUnset` treats a node as unset only when no stored user/migration preference exists. It must check stored node source, not whether the requested value differs from the default. It returns `false` and writes nothing for `source:"user"` or `source:"migration"` entries; it may create or update `source:"system"` entries and return `true`.
- `isSidebarTreeExpanded` resolves by precedence: transient render override, stored user/migration entry, stored system entry, then kind default.

Compatibility adapters can keep existing imports stable during incremental rollout:

- `isProjectExpanded(projectId)` and `toggleProjectExpanded(projectId)` in `sidebar.ts` delegate to `project(projectId)`.
- `expandedGoals` direct mutation should be replaced by `goal(goalId)` helpers. During transition, avoid exporting mutable `Set`s for new code.
- `isUngroupedExpanded`, `setUngroupedExpanded`, `isStaffExpanded`, `setStaffSectionExpanded`, `isArchivedSectionExpanded`, `setArchivedSectionExpanded`, `isTeamLeadExpanded`, `setTeamLeadExpanded`, `isFirstClassParentExpanded`, and `isArchivedParentExpanded` become wrappers or are inlined into call sites.

## Refresh and createGoal interaction rules

### `refreshSessions()`

Current behavior in [`api.ts::refreshSessions`](../../src/app/api.ts#L435): when `/api/goals` returns newly discovered goals, it expands goals that have sessions and also expands their parent (`api.ts` lines 562-571).

New rule:

```ts
for each newly discovered goal g:
  if goal has at least one session and no explicit/migrated preference exists:
    setSidebarTreeSystemExpandedIfUnset(goal(g.id), true)
    if g.parentGoalId exists:
      setSidebarTreeSystemExpandedIfUnset(goal(g.parentGoalId), true)
```

Do not write a system expansion if the goal has any stored user/migration preference. This preserves the “do not re-expand seen collapsed goals” invariant even across reloads.

### `createGoal()`

Current behavior in [`api.ts::createGoal`](../../src/app/api.ts#L1605): after POST and `refreshSessions()`, it unconditionally adds the returned goal to `expandedGoals`.

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

[`src/app/sidebar-nav.ts`](../../src/app/sidebar-nav.ts) currently defines `NavKind`, `navIdFor`, `parseNavId`, `isNavItemExpanded`, and `setNavItemExpanded`. The new tree key should become the DOM/nav ID for sidebar rows:

- Renderers set `data-nav-id=${sidebarTreeKey(nodeKey)}` and `data-nav-active` as today.
- `getVisibleNavOrder()` remains DOM-driven; search filters, Show Archived, collapsed sections, and project reordering continue to affect visible navigation naturally.
- `Ctrl+↑` / `Ctrl+↓` keep using visible DOM order and `openForNavItem` semantics.
- `Ctrl+→` / `Ctrl+←` call `isSidebarTreeExpandable`, `isSidebarTreeExpanded`, and `setSidebarTreeExpanded` rather than switching on legacy nav kinds.
- `navIdToHash` keeps mapping leaves/headers to routes: `session` -> session route, `goal` -> goal dashboard, `project` -> settings, staff header -> staff route, project-sessions/project-archived -> landing. Headers without direct routes continue using the keyboard override to retain highlight.
- Rows with children should set `aria-expanded` from `isSidebarTreeExpanded(key)`; leaves should omit it.

The existing active override behavior in `getActiveNavId()` and the rapid-keypress guard around authored hashes should remain; only the ID format and expansion API should change.

## Indentation preference model

Indentation is layout, not node expansion. The tree-state module may expose layout preferences, but node keys should not encode indentation.

Current render references:

- Child containers use shared `INDENT` from [`render-helpers.ts`](../../src/app/render-helpers.ts) and imported in `sidebar.ts`.
- Nested goal rows add `node.depth * 16` in [`sidebar.ts::renderNestedNode`](../../src/app/sidebar.ts#L1320).
- Header chevron alignment uses `HEADER_CHEVRON_W` / `--sidebar-header-chevron-w`.

Recommended model:

```ts
type SidebarIndentMode = "compact" | "comfortable" | "spacious";

interface SidebarTreeLayoutPreferenceV1 {
  version: 1;
  indentMode?: SidebarIndentMode; // default "comfortable"
  baseIndentPx?: number;          // default existing INDENT
  nestedGoalIndentPx?: number;    // default 16
}
```

Rules:

- Store layout preferences alongside v1 state or under a sibling versioned key, but keep them separate from `nodes`.
- Apply indentation through CSS custom properties (`--sidebar-indent`, `--sidebar-nested-goal-indent`) so desktop/mobile renderers share values.
- Do not migrate existing sidebar font-size preferences into indentation. Font scale and indentation are independent accessibility controls.
- Do not persist per-project or per-depth indentation.

## Goal-dashboard Plan tab disclosure is out of scope

Out of scope for this sidebar tree state migration.

Rationale:

- Plan tab disclosure state lives in [`src/app/goal-dashboard-plan-tab.ts`](../../src/app/goal-dashboard-plan-tab.ts), not in the sidebar. It uses `_planCollapsedGoals`, `_isPlanExpanded`, and `_togglePlanExpanded` for recursive plan rendering.
- The Plan tab tree is a plan graph/view of child goals, not the sidebar navigation tree. It can synthesize formal plan nodes and child-goal plan steps through `computePlanStepsForGoal`, while the sidebar is an entity navigation tree.
- The Plan tab state is currently in-memory and defaults expanded. Persisting it would require separate UX decisions about dashboard-local state, not a sidebar storage migration.
- Keeping it separate prevents a sidebar collapse of `goal(<id>)` from unexpectedly hiding plan details inside a dashboard tab, and vice versa.

If persisted Plan tab disclosure is later desired, define a separate `goalDashboard.planTree.v1` namespace and do not reuse sidebar node keys except as entity references.

## Implementation sequence for later work

1. Add `src/app/sidebar-tree-state.ts` with typed keys, storage helpers, defaults, migration, and adapters.
2. Call migration during app bootstrap before first sidebar render.
3. Replace direct project/goal/section/team-lead expansion reads in `sidebar.ts` and `render-helpers.ts` with the new API.
4. Replace `sidebar-nav.ts` nav kind parsing with `parseSidebarTreeKey`, while retaining route mapping and active override behavior.
5. Replace `api.ts` direct `expandedGoals.add()` / `saveExpandedGoals()` calls with system-expansion helpers.
6. Keep legacy wrapper exports temporarily for tests and out-of-tree imports; mark mutable `expandedGoals` as deprecated and stop adding new call sites.
7. Add focused tests for migration, default resolution, user-over-system precedence, refresh/createGoal auto-expansion, keyboard `Ctrl+←/→` expansion, malformed canonical key parsing, corrupt v1 JSON fallback, migration marker write-failure retry, malformed legacy entries, and bounded prune behavior.

## Focused verification performed for this design

- Inspected required sources: `src/app/sidebar.ts`, `src/app/render-helpers.ts`, `src/app/api.ts`, `src/app/sidebar-nav.ts`, `src/app/sidebar-nesting.ts`, and `src/app/sidebar-spawned-children.ts`.
- Ran a legacy-key search with:

```bash
git grep -n -E "bobbit-(expanded-goals|expanded-projects|collapsed-ungrouped|collapsed-staff|archived-collapsed-projects|collapsed-team-leads|collapsed-first-class-parents|expanded-delegate-parents|sidebar-collapsed)|_planCollapsedGoals|expandedGateIds|treeCostExpanded|expandedLiveStepKeys|expandedArtifactKeys" -- src/app docs tests
```

- Confirmed Plan tab disclosure state is separate by checking `goal-dashboard-plan-tab.ts` for `_planCollapsedGoals`, `_isPlanExpanded`, and `_togglePlanExpanded`.
- Confirmed refresh/createGoal direct expansion mutations in `api.ts` lines 562-571 and 1636-1638.
- For the design-review fix, reran `git diff --check -- docs/design/sidebar-tree-state.md`.
- Confirmed the design artifact exists and still references existing source files with a focused Node sanity check.
