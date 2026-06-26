# Archived Session Worktree Maintenance UX

**Surface:** Settings → Maintenance → Archived Session Worktrees  
**Owner:** UX design only. Production implementation remains in `src/app/settings-page.ts`.  
**Related docs:** [Archived session worktree cleanup](./archived-session-worktree-cleanup.md), [Maintenance](../maintenance.md#archived-session-worktrees)

## Problem to solve

The current card exposes technically correct scan data, but the hierarchy makes the wrong question feel primary. A count such as **With worktrees: 162** can be read as “162 things I can clean”, even when **Removable: 0**. The redesigned card must answer, in order:

1. **Can I clean anything right now?**
2. **What is the safest one-click action?**
3. **If nothing is removable, why not?**
4. **How can I inspect representative examples without scrolling through hundreds of skipped rows?**

## UX principles

- **Actionable first:** default view shows removable candidates only.
- **Safety visible, not noisy:** skipped/ineligible data is available, but hidden behind explicit troubleshooting disclosure.
- **Server remains source of truth:** UI selection is convenience only; cleanup still re-scans and guards on the server.
- **Counts use user intent language:** avoid primary labels that describe implementation state instead of actionability.
- **Small samples before full lists:** every non-actionable group defaults to first 5 examples with a Show all affordance.

## Recommended layout

Keep the existing maintenance card structure and visual language:

- container: `flex flex-col gap-2 rounded-md border border-border p-4`
- title: `text-sm font-semibold text-foreground`
- description/help text: `text-xs text-muted-foreground`
- buttons: reuse existing scan/action button classes and disabled opacity behaviour
- rows: compact `text-xs`, monospaced technical fields, `bg-secondary/20` or `bg-background/70` cards

### Card header

```text
Archived Session Worktrees
Reclaim git worktrees from archived sessions while keeping transcripts, proposals, and archive visibility intact.
```

Header actions, right-aligned on wider screens and stacked below on narrow screens:

1. **Scan** / **Rescan**
2. **Clean all safe candidates** — primary when `readyToClean > 0`
3. **Clean selected** — secondary or primary-outline when selection is non-empty

If no scan has run, show only Scan plus disabled cleanup buttons with helper text.

## Action-oriented summary labels

Replace the current primary count chips with a two-tier summary.

### Primary summary row

Use larger, action-oriented summary cards/chips:

| Label | Source | Purpose |
|---|---:|---|
| **Ready to clean** | `counts.removableWorktrees` | Main answer: how many safe candidates exist now. |
| **Selected** | selected removable row count | Shows what Clean selected will affect. |
| **Already cleaned** | `counts.alreadyCleanedWorktrees` | Reassures user that old archive metadata is not still actionable. |
| **Needs attention** | skipped + failed result count | Secondary troubleshooting count. |

Copy examples:

- `Ready to clean: 0`
- `Selected: 0`
- `Already cleaned: 148`
- `Needs attention: 14`

Do **not** show `With worktrees` as a primary chip. If useful in troubleshooting, relabel as:

```text
Has worktree metadata: 162 — historical records, not necessarily removable
```

### Secondary scan metadata

Place in muted text below the primary row or inside troubleshooting details:

```text
Scanned 167 archived sessions. 162 have historical worktree metadata.
```

## Zero-removable empty state

When a scan has completed and `Ready to clean` is 0, the default body should be an empty state, not a long skipped list.

### Empty state copy

```text
Nothing safe to clean right now
Archived sessions were scanned, but no removable host worktrees are currently safe to delete.

Common reasons: the worktree is already gone, the archived record has no host worktree path, the path belongs to a sandbox/container, or another live session, goal, team member, or staff agent still references it.
```

Primary action: **Rescan**  
Secondary action/disclosure: **Show why not removable**

Disabled cleanup helper:

```text
Cleanup is disabled because there are 0 safe candidates.
```

Accessibility: the empty-state heading should be a real text node announced after scan; if practical, wrap summary/empty state in `aria-live="polite"`.

## Cleanup actions

### Clean all safe candidates

Visible after scan. Enabled only when `Ready to clean > 0`.

- Label: `Clean all safe candidates (N)`
- Request: `POST /api/maintenance/cleanup-archived-session-worktrees` with `{ "mode": "all" }`
- Confirmation text:

```text
Clean N archived-session worktree(s)?
This removes only git worktrees and eligible branches. Archived sessions, transcripts, proposals, and archive visibility are preserved.
```

### Clean selected

Enabled only when selected removable count > 0.

- Label: `Clean selected (N)`
- Request: selected worktree keys as currently implemented
- Helper when disabled:
  - no scan: `Scan first to find safe candidates.`
  - zero ready: `No safe candidates are available.`
  - zero selected: `Select at least one safe candidate.`

### Selection presets

Show as small secondary buttons immediately above the actionable list when `Ready to clean > 0`:

| Preset | Behaviour |
|---|---|
| **Select all removable** | selects every `status: "removable"` item |
| **Archived sessions only** | selects removable items where `delegateOf`, `teamGoalId`, and team/delegate category fields are absent |
| **Current project only** | selects removable items whose `projectId` matches active project, if scan data supports comparison; hide if not supported |
| **Goal/team/delegate worktrees** | selects removable items with `goalId`, `teamGoalId`, `delegateOf`, `parentSessionId`, or `childKind`; hide if count is 0 |
| **Clear selection** | clears all selections |

Preset buttons should display resulting counts when possible, e.g. `Current project (3)`. Hide unsupported presets rather than showing disabled clutter, except **Clear selection**, which may be disabled when selection is already 0.

## Default actionable list

When `Ready to clean > 0`, show removable rows only by default. Rows are grouped by archived session, but the group header must not dominate the row action.

### Group header

```text
<session title>
<short session id> · <project/repo> · archived <relative date>
```

If the title is empty: `Untitled archived session`.

### Row default copy

Each removable row should include only useful default details:

```text
Ready to clean
Safe to remove: archived session worktree is not referenced by any live session, goal, team member, staff agent, or multi-repo sibling.

Repo: .
Branch: goal/b45d2643/ux-designer-1227
Worktree: C:\Users\jsubr\w\bobbit-wt\goal-b45d2643-ux-designer-1227
Branch: will be deleted / branch will be kept — <blocked reason>
```

Recommended status wording:

| Raw status/reason | User-facing label | Detail copy |
|---|---|---|
| `removable` / `safe-archived-session-worktree` | `Ready to clean` | `Safe to remove: no live session, goal, team, staff, or sibling worktree references this path.` |
| branch delete allowed | `Branch will be deleted` | `The matching local branch is not referenced elsewhere.` |
| branch delete blocked | `Branch will be kept` | Use `branchDeleteBlockedReason`; prefix with `Branch kept:`. |

Use a checkbox per removable row. The label must include session title + repo + path so screen readers announce meaningful context.

## Hidden skipped/ineligible disclosure

Skipped and already-cleaned details are hidden by default. Add a disclosure below the actionable list or empty state:

```text
Show skipped / ineligible items
```

Expanded label:

```text
Hide skipped / ineligible items
```

Expanded content starts with a compact explanation:

```text
These records are not cleanup actions. They are shown for troubleshooting and audit only.
```

The disclosure should include skipped, already-cleaned, and failed cleanup-result examples grouped by category. It must not auto-expand after scan unless cleanup produces failures.

## Grouped examples by status/reason

Provide filters or grouped sections. Each group shows the first 5 rows by default and a **Show all (N)** button when `N > 5`. The Show all state is per group, so expanding one noisy reason does not flood the whole card.

### Group set

Minimum groups:

1. **Ready to clean** — shown in main list; also available as a filter target from summary.
2. **Already cleaned** — `status: "already-cleaned"`.
3. **Missing worktree path** — `reason: "no-worktree-path"`.
4. **Missing repo path** — `reason: "missing-repo-path"`.
5. **Sandbox/container path** — `reason: "sandbox-container-path"`.
6. **Referenced by live session/goal/team/staff** — split into subgroups when counts are non-zero:
   - `referenced-by-live-session`
   - `referenced-by-live-goal`
   - `referenced-by-live-team`
   - `referenced-by-staff`
7. **Delegate/shared worktree** — `reason: "delegate-shared-worktree"`.
8. **Invalid selection** — cleanup result `reason: "invalid-selection"`.
9. **Cleanup failed** — cleanup result `status: "failed"`; auto-focus/announce after cleanup.

### Example group header copy

```text
Missing worktree path (94)
These archived sessions have no host worktree path recorded, so there is nothing for this tool to remove.
```

```text
Referenced by live goal (2)
Protected because another durable goal record still points at this path or branch.
```

```text
Already cleaned (148)
The archive still remembers the old path, but the worktree and git metadata are already gone.
```

### Example row copy

Rows in troubleshooting groups are disabled and compact:

```text
Skipped — missing worktree path
Untitled archived session · ses_abc12345 · Bobbit
No host worktree path is recorded for this archived session.
```

```text
Skipped — sandbox/container path
Fix login retry · ses_def67890 · repo: .
Path /workspace-wt/session/fix-login exists only inside a sandbox container, not as a host worktree.
```

```text
Already cleaned
Refactor API client · ses_ghi23456 · branch: session/refactor-api-client
The worktree path and git worktree metadata are gone; no cleanup is needed.
```

```text
Cleanup failed
Build dashboard · ses_jkl34567 · C:\...\bobbit-wt\session\build-dashboard
Git refused to remove the worktree: <error>
```

## Summary-to-examples navigation

Summary chips should be interactive when they have relevant rows:

- **Ready to clean** scrolls/focuses the actionable list.
- **Already cleaned** expands troubleshooting and focuses the Already cleaned group.
- **Needs attention** expands troubleshooting and focuses the first skipped/failed group.

Use buttons styled as chips rather than inert spans when they trigger navigation. Provide `aria-controls` pointing to the group panel.

## Cleanup result summary

After cleanup, show a compact result panel above the scan results and then rescan.

Default success copy:

```text
Cleanup complete
Cleaned 6 worktrees. Deleted 4 branches. 2 branches were kept because they are referenced elsewhere.
```

Mixed result copy:

```text
Cleanup finished with attention needed
Cleaned 5, skipped 2, already cleaned 1, failed 1.
```

Only failed/skipped result rows should be shown by default after cleanup; successful rows can be summarized. Provide **Show cleanup details** for per-item results.

## Accessibility requirements

- Card section: `role="region"`, labelled by the card heading.
- Scan and cleanup result updates: `aria-live="polite"`.
- Cleanup failures: use `aria-live="assertive"` or move focus to the failure summary after action completes.
- Disabled cleanup buttons must have visible helper text, not only a disabled state or tooltip.
- Summary chips that navigate/filter are `<button>` elements with visible focus rings.
- Row checkboxes include accessible names containing action, session title/id, repo, and path.
- Disclosure uses a native `<details>/<summary>` or a button with `aria-expanded` and `aria-controls`.
- Do not rely on color alone: every state chip includes text (`Ready to clean`, `Skipped`, `Already cleaned`, `Failed`).
- Path text remains selectable and wraps with `break-all`; avoid horizontal-only scrolling for critical details.
- Keyboard order: Scan → Clean all → selection presets → row checkboxes → Clean selected → troubleshooting disclosure/groups.

## Test selectors

Preserve existing selectors and add stable selectors for the new interactions. Prefer `data-testid` for tests and `data-action` for existing maintenance action consistency.

### Section and actions

| Element | Selector |
|---|---|
| Section | `data-section="archived-session-worktrees"` |
| Scan/rescan | `data-action="scan-archived-session-worktrees"` |
| Clean all | `data-action="cleanup-all-archived-session-worktrees"` |
| Clean selected | `data-action="cleanup-archived-session-worktrees"` |
| Empty state | `data-testid="archived-worktrees-empty"` |
| Cleanup helper | `data-testid="archived-worktrees-cleanup-helper"` |
| Result summary | `data-testid="archived-worktrees-cleanup-result"` |

### Summary counts

| Count | Selector |
|---|---|
| Ready to clean | `data-testid="archived-worktrees-ready-count"` |
| Selected | `data-testid="archived-worktrees-selected-count"` |
| Already cleaned | `data-testid="archived-worktrees-already-cleaned-count"` |
| Needs attention | `data-testid="archived-worktrees-needs-attention-count"` |
| Historical metadata detail | `data-testid="archived-worktrees-metadata-count"` |

### Selection presets

| Preset | Selector |
|---|---|
| Select all removable | `data-action="select-all-removable-archived-worktrees"` |
| Archived sessions only | `data-action="select-archived-session-worktrees-only"` |
| Current project only | `data-action="select-current-project-archived-worktrees"` |
| Goal/team/delegate | `data-action="select-goal-team-delegate-archived-worktrees"` |
| Clear selection | `data-action="clear-archived-worktree-selection"` |

### Rows and groups

| Element | Selector |
|---|---|
| Worktree row | `data-archived-worktree-key="<key>"` |
| Row status | `data-archived-worktree-status="removable|skipped|already-cleaned|failed"` |
| Row reason | `data-archived-worktree-reason="<reason>"` |
| Troubleshooting disclosure | `data-testid="archived-worktrees-troubleshooting-toggle"` |
| Troubleshooting panel | `data-testid="archived-worktrees-troubleshooting"` |
| Example group | `data-testid="archived-worktree-example-group" data-reason="<reason>"` |
| Show all in group | `data-action="show-all-archived-worktree-examples" data-reason="<reason>"` |

## UI test coverage checklist

Browser/fixture tests should cover:

1. Default card before scan: cleanup disabled, helper explains Scan first.
2. Zero-removable scan: shows `Ready to clean: 0`, empty state, cleanup disabled, skipped details hidden.
3. Hidden disclosure: opening it reveals grouped first-5 examples and Show all for noisy groups.
4. Removable scan: removable rows selected by default; skipped rows absent from default list.
5. Selection presets: each preset updates Selected count and selected row checkboxes.
6. Clean all: posts `{ "mode": "all" }` after confirmation and displays cleanup result.
7. Clean selected: posts selected worktree keys only; disabled when selection is empty.
8. Summary navigation: Already cleaned / Needs attention chips expand and focus the correct group.
9. Accessibility smoke: buttons have accessible names, disabled state has visible helper text, disclosure is keyboard operable.

## Consistency rationale

This design intentionally reuses the existing Settings → Maintenance primitives: bordered cards, compact `text-xs` metadata, chip-like summary labels, small rounded buttons, and row cards with monospaced technical fields. The only new pattern is grouped troubleshooting examples, but it is an extension of existing progressive disclosure (`details`-style diagnostics) rather than a new visual system. The hierarchy changes, not the component language: primary counts now describe actionability, and noisy technical rows move behind an explicit disclosure.
