# Sidebar Archive-Rendering Unification

## Problem

When a project has nested teams — a parent goal whose team-lead (e.g. Bugs Bunny) spawns sub-goals each with their own team-leads (e.g. Otis, Zoidberg) — expanding the sidebar tree produced multiple stacked "ARCHIVED" dividers at similar indentation levels. One divider belonged to Otis's archived workers, one to Zoidberg's, one to Bugs Bunny's own archived workers. All three looked identical. The user had no way to tell which archived rows belonged to which team-lead.

Root cause: each render path independently filtered active/archived rows and emitted its own divider, producing duplicates with no ownership information.

## Solution

Two changes work together:

1. **`bucketActiveArchived` helper** — a single pure function that every render path calls to split any list into active and archived buckets. Eliminates redundant, inconsistent inline bucketing.
2. **Labeled archive dividers** — `archivedDivider(owner?)` accepts an optional owner name. Team-lead groups pass the lead's title, producing "ARCHIVED · Bugs Bunny", "ARCHIVED · Otis", "ARCHIVED · Zoidberg" — unambiguous ownership at a glance.

## `bucketActiveArchived` helper

**Location:** `src/app/render-helpers.ts` (exported)

```ts
function bucketActiveArchived<T>(
  rows: T[],
  isArchived: (r: T) => boolean,
): { active: T[]; archived: T[]; needsDivider: boolean }
```

- Splits `rows` into `active` and `archived` buckets using the caller-supplied predicate.
- `needsDivider` is `true` iff both buckets are non-empty — the canonical gate for emitting `archivedDivider()` between them.
- Generic over `T` so it works for goals, sessions, nested-goal nodes, and any future type.
- Pure function — no side effects, no DOM access — unit-testable in isolation.

## `archivedDivider` component

**Location:** `src/app/render-helpers.ts` (exported)

```ts
const archivedDivider = (owner?: string) => TemplateResult
```

- Without `owner`: renders a plain muted "Archived" label with flanking horizontal rules. Used at project-root and nested-goal-forest level where a single divider serves the whole group.
- With `owner`: renders "ARCHIVED · \<name\>" where the owner name is in normal case alongside the uppercase "Archived ·" prefix. The owner is also set as `data-owner` on the container element for test selectors.

## Render paths that use `bucketActiveArchived`

### Path A — team-lead group (`renderTeamGroup` in `render-helpers.ts`)

Handles the sessions and spawned sub-goals belonging to a single team-lead.

1. `bucketActiveArchived(spawnedChildren, g => !!g.archived)` splits spawned sub-goals into active and archived.
2. `bucketTeamChildren(teamChildren, archivedForLiveLead, showArchived)` (in `team-archived-bucket.ts`) splits team-member sessions, merging recently-terminated members from `gatewaySessions` with fully-purged members from `archivedSessions`, deduped by id.
3. Emits `archivedDivider(teamLead.title)` when `hasActiveAbove && hasArchivedBelow` — exactly one divider per team-lead group, labeled with the lead's name.

### Path B — nested goal forest (`renderNestedNode` in `sidebar.ts`)

Handles the recursive tree of child goals within a project.

```ts
const { active, archived, needsDivider } =
  bucketActiveArchived(node.children, c => !!c.goal.archived);
```

Emits `archivedDivider()` (no owner) between active and archived child nodes. A divider only appears when a parent goal has both live and archived direct children — it does not label the parent because nesting indentation already conveys ownership.

### Path C — project-root forest (`renderProjectContent` in `sidebar.ts`)

Handles the top-level list of goals within a project panel.

```ts
const { active, archived, needsDivider } =
  bucketActiveArchived(forest, n => !!n.goal.archived);
```

Emits `archivedDivider()` (no owner) between the last live top-level goal and the first archived top-level goal. Ownership is unambiguous here because every item at this level belongs to the same project.

## Paths intentionally excluded

- **`renderProjectArchivedSection`** (`render-helpers.ts`) — renders the collapsible "Archived" subsection at the bottom of each project panel. This section contains only archived items by definition; a within-section active/archived split would never fire. No change needed.
- **`renderArchivedGoalsForest`** (`render-helpers.ts`) — renders the archived-goals-only forest inside that collapsible section. Same reason: all items are already archived.
- **Mobile landing** (`render.ts::renderMobileLanding`) — uses `bucketArchivedByProject` for its own bucketing loop, which pre-separates items by project before rendering. No duplicate bucketing was present.

## `state.showArchived === false` invariant

When the user has the "See Archived" toggle off (`state.showArchived === false`):

- `archivedForLiveLead` in `renderTeamGroup` returns `[]` (explicitly gated).
- `bucketTeamChildren` returns an empty `archivedBelow` list (the recently-terminated filter is gated on `showArchived`).
- `selectSpawnedChildren` excludes archived goals (gated at the call site via `showArchived` parameter).
- `buildNestedGoalForest` is called with `{ includeArchived: state.showArchived }` so archived goals never enter the forest.
- `renderProjectContent` only adds archived goals to its forest input when `state.showArchived` is true.

Result: when the toggle is off, `bucketActiveArchived` receives only active rows in every path, `needsDivider` is always `false`, and no archived rows or dividers render. The toggle being on is a prerequisite for any archived content to appear at all.

One exception: search auto-enables `state.showArchived` temporarily via `_ensureArchivedForSearch()` and reverts it when the query is cleared, so archived items surface in search results even when the toggle is off.

## Visual before/after

**Before:** expanding "Bugs Bunny" → "WP 3.3 Otis" + "WP 3.6 Zoidberg" rendered:

```
  ── ARCHIVED ──     ← Otis's workers (no label)
  ── ARCHIVED ──     ← Zoidberg's workers (no label)
  ── ARCHIVED ──     ← Bugs Bunny's workers (no label)
```

**After:**

```
  ── ARCHIVED · Otis ──
  ── ARCHIVED · Zoidberg ──
  ── ARCHIVED · Bugs Bunny ──
```

Each divider is emitted by its team-lead's own `renderTeamGroup` call and carries the lead's title. Indentation is unchanged.

## Testing

- **Unit tests for `bucketActiveArchived`**: `tests/bucket-active-archived.test.ts` — empty inputs, all-active, all-archived, mixed.
- **Unit tests for `archivedDivider` ownership label**: `tests/render-helpers-archive-divider.test.ts`.
- **Browser E2E**: `tests/e2e/ui/sidebar-archive-render.spec.ts` — project with nested team-leads, asserts at most one divider per team-lead group and that divider text reflects the owner.
- **Existing tests** cover the `showArchived === false` invariant via `sidebar-archived-per-project.spec.ts` and `sidebar-child-loading.spec.ts`.
