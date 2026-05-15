# Hierarchical Cascade Framework

This document describes `src/server/agent/goal-subtree.ts` — the shared
BFS walk and async cascade runner that backs every goal-tree operation
in the server.

## Background

Before this module existed, each cascade operation (archive, pause,
resume, teardown, tree-cost rollup, in-flight-child check) contained its
own reimplementation of "walk the goal tree". The reimplementations
differed in subtle ways:

- Some forgot to walk through archived nodes to reach live grandchildren.
- Some had no cycle defence.
- Some hardcoded top-down order where bottom-up was required.
- None had unit tests for the walk itself.

The framework consolidates all walks into two tested, pure helpers so
there is one place to fix correctness bugs and one place where ordering
decisions are documented and enforced.

---

## `walkGoalSubtree` — pure BFS

```ts
export function walkGoalSubtree(
  rootId: string,
  allGoals: PersistedGoal[],
  opts?: SubtreeWalkOpts,
): PersistedGoal[]
```

BFS over the `parentGoalId` chain, starting at `rootId`. Pure — no I/O,
no mutation. Safe to call on any `allGoals` snapshot.

### Options

```ts
interface SubtreeWalkOpts {
  includeRoot?: boolean;       // default true
  includeArchived?: boolean;   // default false (see walk-through semantics below)
  maxDepth?: number;           // default 32 (cycle defence)
  filter?: (g: PersistedGoal) => boolean;
}
```

### Walk-through semantics

`includeArchived: false` (the default) **excludes archived nodes from the
output** but **still walks into their children**. This is intentional: a
live grandchild nested under an archived parent must remain reachable for
cascades that target live nodes in the whole tree.

The same rule applies to the `filter` predicate: a node that fails the
filter is omitted from the output but its subtree is still walked.

### Cycle defence

Two guards prevent pathological persisted state from hanging the server:

1. A `seen` set — once a goal ID has been visited it is never enqueued
   again, so no cycle can be traversed twice.
2. A depth cap (`maxDepth`, default 32) — the BFS frontier terminates
   after this many levels regardless of graph shape. Direct self-cycles
   (a goal whose `parentGoalId === id`) are pre-filtered when building
   the adjacency map.

### Usage

```ts
import { walkGoalSubtree } from "./goal-subtree.js";

// All live (non-archived) descendants of a root, excluding the root:
const descendants = walkGoalSubtree(rootId, goalStore.getAll(), {
  includeRoot: false,
});

// Everything, including archived nodes in the output:
const allNodes = walkGoalSubtree(rootId, goalStore.getAll(), {
  includeArchived: true,
});

// Only paused nodes (but walk their subtrees too):
const pausedNodes = walkGoalSubtree(rootId, goalStore.getAll(), {
  filter: (g) => g.paused === true,
});
```

---

## `cascadeSubtree` — async walk + action

```ts
export async function cascadeSubtree<T>(
  rootId: string,
  allGoals: PersistedGoal[],
  walkOpts: SubtreeWalkOpts,
  cascadeOpts: CascadeOpts<T>,
): Promise<CascadeResult<T>>
```

Calls `walkGoalSubtree`, optionally reverses the list for bottom-up
order, then applies an async action to each node sequentially.

### Options

```ts
interface CascadeOpts<T> {
  apply: (g: PersistedGoal) => Promise<T>;
  order: "top-down" | "bottom-up"; // REQUIRED — no default
  stopOnError?: boolean;           // default false
}
```

`order` is a required field, not optional with a silent default. Every
call site must declare the ordering at code-review time so the intent is
auditable. See [Walk order rationale](#walk-order-rationale) below.

### Result

```ts
interface CascadeResult<T> {
  processed: Array<{ goalId: string; result: T }>;
  errors: Array<{ goalId: string; error: Error }>;
}
```

By default errors are collected and the walk continues (`stopOnError:
false`). A failure on one node does not block the remaining nodes. Set
`stopOnError: true` to abort after the first failure.

### Snapshot semantics

`allGoals` is captured once at call time. The cascade itself does not
re-read the store during the walk. Callers concerned about concurrent
mutations should call `goalStore.getAll()` immediately before invoking
`cascadeSubtree`.

---

## Walk order rationale

Different operations require different traversal orders:

| Operation | Order | Reason |
|---|---|---|
| Archive | bottom-up | Children archived before parents; prevents parent's archived-sweep from seeing live descendants |
| Teardown | bottom-up | Child resources freed first; parent teardown doesn't race child sessions |
| Pause | top-down | Parent paused first; prevents its supervisor loop from respawning workers during child pauses |
| Resume | top-down | Parent reactivated first; it can re-supervise children once live again |
| Tree-cost rollup | N/A (read-only) | Uses `walkGoalSubtree` directly, no `cascadeSubtree` |

---

## Archive cascade — server contract

`DELETE /api/goals/:id` requires an explicit `?cascade=` parameter.

| `?cascade=` | Behaviour |
|---|---|
| absent | `422 { code: "CASCADE_REQUIRED" }` |
| `false` | `409 { code: "HAS_DESCENDANTS", count: N }` if any non-archived descendants exist |
| `true` | Archives descendants bottom-up, then the root; returns `{ ok: true, archived: N, errors?: [...] }` |

The optional `?mergedManually=true` flag reconciles the root's `state`
to `"complete"` before archiving (used by `goal_archive_child` when a
team-lead manually merged a child whose `ready-to-merge` gate failed).
This flag applies to the target only, not to cascaded descendants.

---

## Teardown cascade — server contract

`POST /api/goals/:id/team/teardown` also requires an explicit `?cascade=`
parameter.

| `?cascade=` | Behaviour |
|---|---|
| absent | `422 { code: "CASCADE_REQUIRED" }` |
| `false` | `409 { code: "HAS_DESCENDANT_TEAMS", count, descendants: [{id, title}] }` if any non-archived descendant has a live team |
| `true` | Tears down each descendant's team bottom-up (best-effort per-goal); returns `{ ok, toreDown, errors[] }` |

---

## Migrated call sites

Every cascade operation in `src/server/` was migrated to use the shared
helpers. To verify coverage, `grep parentGoalId src/server/` — every
match is either a call to a helper in `goal-subtree.ts`, a data-model
field read (assignment to `parentGoalId`), or carries a one-line comment
explaining why it is intentionally bespoke.

| Former site | Helper used | Order |
|---|---|---|
| Archive (`DELETE /api/goals/:id?cascade=true`) | `cascadeSubtree` | bottom-up |
| Pause (`POST /api/goals/:id/pause { cascade }`) | `cascadeSubtree` | top-down |
| Resume (`POST /api/goals/:id/resume { cascade }`) | `cascadeSubtree` | top-down |
| Teardown (`POST /api/goals/:id/team/teardown?cascade=true`) | `cascadeSubtree` | bottom-up |
| Tree-cost rollup (`GET /api/goals/:id/tree-cost`) | `walkGoalSubtree` | BFS order |
| `anyInFlightChild` (team manager) | `walkGoalSubtree` + filter | BFS order |
| `listDescendants` (`GET /api/goals/:id/descendants`) | `walkGoalSubtree` | BFS order |

---

## UI archive cascade

The sidebar "Archive" action on a goal with descendants used to return a
`409 HAS_DESCENDANTS` error and surface it to the user without offering a
resolution path. After the fix, `deleteGoal()` / `showArchiveGoalDialog`
in `src/app/dialogs.ts`:

1. Detects any non-archived descendants (via `GET /api/goals/:id/descendants`).
2. If descendants exist, shows a confirm dialog listing the count.
3. Passes `cascade: true` to `DELETE /api/goals/:id?cascade=true` when
   the user confirms.

The user is never shown a raw `409 HAS_DESCENDANTS` response; the dialog
gives them an explicit choice.

---

## Testing

Unit tests in `tests/goal-subtree.test.ts` cover:

- Empty subtree (root has no children).
- Linear chain (root → A → B → C).
- Branching tree (root → {A, B}; A → {C, D}).
- Archived descendants excluded by default, included with `includeArchived: true`.
- Walk-through: live grandchild under archived parent is still returned.
- Cycle defence (depth cap; bad parent pointers do not hang).
- Bottom-up vs top-down order asserted.
- Error in one node does not stop the walk; errors are collected.
- `stopOnError: true` stops after the first failure.
- `includeRoot: false` excludes the root from the output.
- `filter` omits a node but still walks its children.

Browser E2E tests in `tests/e2e/ui/` cover the archive-cascade UI flow:
creating a parent + child goal, archiving the parent via the sidebar, and
asserting the child becomes archived.

---

## Reference

| Symbol | File |
|---|---|
| `walkGoalSubtree` | `src/server/agent/goal-subtree.ts` |
| `cascadeSubtree` | `src/server/agent/goal-subtree.ts` |
| `SUBTREE_WALK_DEFAULT_DEPTH_CAP` | `src/server/agent/goal-subtree.ts` |
| `SubtreeWalkOpts` | `src/server/agent/goal-subtree.ts` |
| `CascadeOpts` | `src/server/agent/goal-subtree.ts` |
| `CascadeResult` | `src/server/agent/goal-subtree.ts` |
| Archive handler | `src/server/agent/nested-goal-routes.ts` |
| Teardown handler | `src/server/agent/nested-goal-routes.ts` |
| Pause/resume handler | `src/server/agent/nested-goal-routes.ts` |
| Tree-cost handler | `src/server/server.ts` |
| Unit tests | `tests/goal-subtree.test.ts` |
| Pause semantics | [docs/design/pause-cascade.md](pause-cascade.md) |
