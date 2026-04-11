# Sidebar — User Stories

The sidebar is the primary navigation and monitoring surface. It is how users find sessions, monitor agent activity, assess goal progress, and start new work. These stories are organized by user task.

---

## Session hierarchy and visibility rules

The sidebar renders a tree. Every session belongs at exactly one level. The hierarchy determines where sessions appear, how they nest, and how archiving cascades.

### Hierarchy

```
Project
├── Goal
│   ├── Team Lead (session with role=team-lead, teamGoalId=goal.id)
│   │   ├── Team Member (session with teamGoalId=goal.id, teamLeadSessionId=lead.id)
│   │   │   └── Delegate (session with delegateOf=member.id)
│   │   └── Delegate (session with delegateOf=lead.id)
│   └── Non-team session (session with goalId=goal.id, no team role)
│       └── Delegate (session with delegateOf=session.id)
├── Ungrouped session (no goalId, no teamGoalId, no delegateOf)
│   └── Delegate (session with delegateOf=session.id)
└── Staff session (matched by staffId)
```

### Placement rules

- A session with `teamGoalId` appears under that goal, never in the ungrouped section.
- A session with `goalId` (but no `teamGoalId`) appears under that goal.
- A session with `delegateOf` appears nested under its parent session, never at the top level of any group.
- A session with none of the above appears in the project's "Sessions" section.
- Staff sessions appear in the "Staff" section, matched by `staffId`.

### Visibility rules ("Show archived" toggle)

The tree has two rendering zones: **live** (always visible) and **archived** (visible only when "Show archived" is on). A node's zone is determined by its own archived status, with the following constraints:

1. **Children follow their parent's zone.** If a team lead is live, its live team members and their delegates appear in the live zone. Archived members of a live team lead also appear in the live zone (with greyscale styling) when "Show archived" is on — they do not move to the archived section.
2. **Archiving cascades downward.** Terminating a session archives it and all its delegates (recursively). Tearing down a team archives the team lead and all members. Archiving a goal first tears down its team, then archives the goal.
3. **A parent cannot be archived while it has live children.** A goal cannot be archived while it has an active team. A team lead is terminated (and archived) only via team teardown, which first dismisses all members.
4. **An archived goal moves its entire tree to the archived section.** When "Show archived" is off, the goal and all its sessions (archived or not) are hidden. When on, the full tree renders in the archived section with greyscale styling.
5. **Delegates render recursively.** A delegate can have its own delegates. Each level renders nested and indented under its parent, gated by the parent's expand/collapse state.

### Summary: what shows when

| "Show archived" | Goal live, lead live | Goal live, lead archived | Goal archived |
|---|---|---|---|
| **Off** | Lead + live members + live delegates | Nothing (lead and children hidden) | Nothing (entire goal hidden) |
| **On** | Lead + all members (live normal, archived greyscale) + all delegates | Lead (greyscale) + archived members + archived delegates, in live goal section | Entire tree in archived section, all greyscale |

---

## SB-00: Session hierarchy and nesting

**Preconditions:** A project with: a team goal (team lead + 2 live members + 1 archived member), a non-team goal with one session that has a delegate, and 2 ungrouped sessions (one of which has a delegate).

**Steps and expectations:**
1. Look at the sidebar with "Show archived" off.
   - The team goal group shows the team lead, with 2 live members nested under it. The archived member is not visible.
   - The non-team goal group shows its session, with the delegate nested underneath.
   - The ungrouped "Sessions" section shows 2 sessions. The one with a delegate shows its delegate nested underneath.
   - No session appears in more than one place.
   - No delegate appears at the top level of any section.
2. Toggle "Show archived" on.
   - The archived team member now appears under the team lead (greyscale styling), alongside the 2 live members.
   - The archived member is in the live goal section, NOT in the archived section — it follows its live parent.
3. Terminate the team lead (via "End team").
   - All team members are archived (cascading termination).
   - The team lead is archived.
   - With "Show archived" off: the goal group shows the empty state ("No agents — Start Team").
   - With "Show archived" on: the archived team lead appears under the goal with its archived members nested inside.
4. Archive the goal.
   - The goal disappears from the live section.
   - With "Show archived" on: the entire goal tree (goal + archived lead + archived members + delegates) appears in the archived section at the bottom.
5. A delegate session is spawned by a live team member.
   - The delegate appears nested under that team member, indented one level deeper.
   - The delegate does NOT appear in the ungrouped sessions section.
6. The team member with a delegate is terminated (archived).
   - The delegate is also archived (cascade).
   - Both disappear when "Show archived" is off.

**Coverage:** none.

---

### SB-00b: Archived delegates not visible under parent sessions

**Bug:** Archived delegates are only discoverable if they happen to be in the paginated archived sessions that have been fetched (first 50, sorted by `archivedAt` DESC). Delegates of older sessions are buried deep in pagination and never loaded, so the parent session row never shows a chevron or nested children.

**Root cause:** `renderSessionRow` looks for archived delegates in `state.archivedSessions`, which only contains the first page of paginated results. There is no mechanism to fetch delegates of a specific parent session on demand. The server has the data (`delegateOf` is persisted correctly in `sessions.json`), but the client never requests it.

**Preconditions:** A session (live or archived) that previously spawned delegate sub-sessions. Those delegates were archived. "Show archived" is on.

**Steps and expectations:**
1. Look at the parent session row.
   - **Expected:** A chevron appears indicating expandable children. Expanding shows the archived delegates with greyscale styling.
   - **Actual:** No chevron. No delegates visible. The parent row looks like it never had children.
2. Click "Load more" in the archived section repeatedly until the delegates' page is fetched.
   - **Expected (workaround):** Eventually the delegates appear. But this is not viable — users have 2000+ archived sessions.
3. The same bug affects delegates of archived team members inside goal groups.

**Fix approach:** Lazy-fetch archived delegates when a session row is expanded, or when "Show archived" is toggled on. A server endpoint like `GET /api/sessions/:id/delegates` that returns all archived sessions with `delegateOf=:id` would keep the initial load small while making delegates discoverable.

**Coverage:** none.

---

## SB-01: Find and switch to a session by project

**Preconditions:** 2+ projects registered, each with sessions and goals.

**Steps and expectations:**
1. Look at the sidebar.
   - Each project has its own section with a colored header (project name + accent color).
   - Goals appear under their project, followed by an "Sessions" sub-section, followed by "Staff".
   - Separators visually divide projects.
2. Click a project header to collapse it.
   - All goals, sessions, and staff under that project are hidden.
   - The chevron changes from ▾ to ▸.
3. Reload the page.
   - The collapsed project is still collapsed (state persisted in localStorage).
   - Collapsing one project does not affect others.
4. Expand the project. Click a session row.
   - Session connects and loads in the main content area.
   - The clicked row gets a distinct background highlight.
   - Only one session row is highlighted at a time.
   - URL updates to reflect the session.

**Coverage:** `tests/sidebar-collapse.spec.ts` (collapse per-project persistence); navigation: partial via N-01.

---

## SB-02: Find a session inside a goal's team

**Preconditions:** Goal exists with an active team (team lead + child agents).

**Steps and expectations:**
1. Look at the goal row in the sidebar.
   - Goal shows as a collapsible header with a chevron, goal icon, and uppercase title.
   - A badge next to the title shows gate progress (e.g. "3/5") or PR status (see SB-09, SB-10).
2. Click the goal header to expand it.
   - Team lead row appears with a count badge showing how many child agents it has.
   - Child agents are nested under the team lead (indented).
3. Click a child agent row.
   - Session connects and loads. Row is highlighted.
4. Double-click the goal header.
   - Connects directly to the team lead session.
5. Click the goal header again to collapse.
   - All sessions under the goal are hidden.
6. Reload the page.
   - Goal expand/collapse state is preserved.

**Coverage:** `tests/goal-card-back-nav.spec.ts` (click session in goal, back nav); team nesting: none.

---

## SB-03: Active session auto-expands its parent group

**Preconditions:** A session exists inside a collapsed goal or collapsed project section.

**Steps and expectations:**
1. Navigate to a session via direct URL (e.g. deep link or browser back).
   - If the session's parent goal group was collapsed, it auto-expands.
   - If the session's parent project section was collapsed, it auto-expands.
   - The session row is visible and highlighted without manual expanding.
2. Navigate to a different session in a different goal.
   - The new goal auto-expands. The previous goal remains expanded (no auto-collapse).

**Coverage:** none.

---

## SB-04: Rapid session switching

**Preconditions:** 4+ sessions across different goals/projects.

**Steps and expectations:**
1. Click session A. Immediately click session B. Immediately click session C.
2. Wait for C to load.
   - Session C loads with its own messages. No stale content from A or B.
   - Sidebar highlights only C.
   - Any intermediate connection attempts are cancelled cleanly.
   - No errors in the console.

**Coverage:** none (see also S-06 in sessions.md).

---

## SB-05: See which agents are actively working

**Preconditions:** Multiple sessions exist — some streaming, some idle, some compacting.

**Steps and expectations:**
1. Look at session rows in the sidebar.
   - **Streaming/busy** sessions show animated pulsing dots instead of an idle time. Dots are staggered so multiple active agents don't pulse in sync.
   - The session title text animates with a wave effect while the agent is actively streaming.
   - **Compacting** sessions show a compacting indicator.
   - **Idle** sessions show a terse relative time (see SB-06).
   - **Connecting** sessions show a spinner icon instead of the status bobbit.
2. An agent finishes streaming.
   - The pulsing dot is replaced by a time indicator (initially "now").
   - The title wave animation stops.
3. An agent starts streaming in the background.
   - Its row transitions from idle time to a pulsing dot without a page refresh.

**Coverage:** none.

---

## SB-06: See how long agents have been idle

**Preconditions:** Sessions exist in idle state with varying last-activity times.

**Steps and expectations:**
1. Look at idle session rows.
   - Each shows a terse relative time: "now", "3m", "2h", "1d".
   - Terminated sessions also show their last activity time.
2. Hover over the time display.
   - Tooltip shows a more detailed format (e.g. "49m ago").
3. Wait a few minutes without interacting.
   - Times update as the sidebar re-renders on each poll cycle.

**Coverage:** none.

---

## SB-07: Spot sessions with unseen activity

**Preconditions:** Multiple sessions. Background sessions receive responses while you're viewing a different session.

**Steps and expectations:**
1. Be connected to session A. Session B receives a response in the background.
   - An audio beep plays when session B finishes streaming.
   - The browser favicon shows an activity badge.
2. Look at session B's row in the sidebar.
   - A small blue dot appears next to the time display.
3. Click session B to connect.
   - The blue dot disappears (activity is now "seen").
4. A team sub-agent receives a response while its goal is still in progress.
   - The unseen dot is suppressed for sub-agents during active goal work.
   - The dot only appears for sub-agents after the goal reaches a terminal state (complete, shelved).

**Coverage:** none.

---

## SB-08: Spot an aborting agent

**Preconditions:** An agent is mid-response.

**Steps and expectations:**
1. Trigger abort (Escape or Stop button) on the streaming agent.
2. Look at the sidebar.
   - The session shows an aborting state indicator while the abort is in progress.
3. Abort completes.
   - The session transitions to idle with a time display.

**Coverage:** none.

---

## SB-09: See goal gate progress at a glance

**Preconditions:** Goals exist with workflows. Gates are in various states (some passed, some pending, some verifying).

**Steps and expectations:**
1. Look at goal rows in the sidebar without expanding them.
   - Each goal shows a small badge next to the title.
   - The badge shows gate progress as "N/M" (passed count / total count).
2. An agent is actively working on the goal.
   - The gate badge animates with a wave effect.
3. A gate is being verified.
   - The badge blinks to indicate verification in progress.
4. All gates pass.
   - Badge shows full completion (e.g. "5/5") with a passed color.
5. A goal with no workflow shows no gate badge.

**Coverage:** none.

---

## SB-10: See goal PR status at a glance

**Preconditions:** Goal has a branch pushed with a pull request.

**Steps and expectations:**
1. Look at goal rows in the sidebar.
   - When a PR exists, a PR status icon replaces the gate badge.
   - Color coding: green for merged, purple for open, orange for changes requested, red for closed.
2. The PR has a merge conflict.
   - The PR icon shows a pulsing animation to draw attention.
3. The PR has review status (approved, changes requested, review required).
   - The icon or its color reflects the review state.
4. PR status updates without page reload (polled periodically).

**Coverage:** none.

---

## SB-11: See goal setup status

**Preconditions:** A new goal is being created.

**Steps and expectations:**
1. Create a new goal.
   - The goal row appears in the sidebar immediately.
   - A spinner appears next to the title while worktree setup is "preparing".
2. Worktree setup completes.
   - Spinner disappears. Team starts automatically (if auto-start enabled).
3. Worktree setup fails.
   - A warning icon (⚠) replaces the spinner.
   - Clicking the goal dashboard shows the error and a retry option.

**Coverage:** none.

---

## SB-12: Completed goal with archived team

**Preconditions:** A goal completed — team was dismissed, all sessions archived. "Show archived" is off.

**Steps and expectations:**
1. Expand the completed goal.
   - The goal group does NOT appear blank/empty with no explanation.
   - For completed goals with a merged PR, an "Archive" call-to-action is shown: "Work merged — Archive".
   - For completed goals without a PR, an "Archived" label is shown.
2. Click the "Archive" button.
   - Goal moves from the live section to the archived section.
3. Toggle "Show archived" on.
   - The archived team lead and child agents appear under the goal, with greyscale styling.

**Coverage:** `tests/sidebar-archive-cta.spec.ts` (archive CTA rendering); archived team visibility: none.

---

## SB-13: Goal shelved state

**Preconditions:** A goal is in "shelved" state.

**Steps and expectations:**
1. Look at the sidebar.
   - The shelved goal renders with reduced opacity, visually distinct from active goals.
   - The goal is still expandable and its dashboard is still accessible.
2. Other goals at normal opacity are clearly more prominent.

**Coverage:** none.

---

## SB-14: Start a new session in a project

**Preconditions:** Project registered.

**Steps and expectations:**
1. Find the project's "Sessions" sub-section header.
   - A "+" button and a dropdown chevron are visible.
2. Click the "+" button.
   - A new session is created scoped to that project.
   - The "+" button is disabled/dimmed while creation is in progress.
   - The new session appears under that project's Sessions section.
   - You are connected to the new session automatically.
   - Textarea is focused.
3. The session gets its own worktree and branch (same expectations as S-01).

**Coverage:** none (S-01 covers generic session creation but not the project-scoped entry point).

---

## SB-15: Start a new session with a specific role

**Preconditions:** Roles are defined. Project registered.

**Steps and expectations:**
1. Click the dropdown chevron next to the "+" button in a project's Sessions section.
   - A role picker dropdown appears listing available roles.
2. Select a role.
   - A new session is created with that role, scoped to the project.
   - The session appears under the project and you are connected.
3. Click elsewhere or press Escape.
   - The role picker closes without creating a session.

**Coverage:** none.

---

## SB-16: Start a new goal in a project

**Preconditions:** Project registered.

**Steps and expectations:**
1. Hover over the project header (desktop) or look at it (mobile).
   - A "New Goal" button is visible (goal icon with a small + overlay).
2. Click "New Goal".
   - A goal assistant session opens, scoped to that project.
   - The assistant guides you through goal creation (same flow as G-01).
   - The resulting goal is created under the correct project.

**Coverage:** none (G-01 covers the assistant flow but not the project-scoped entry point).

---

## SB-17: Start a team on an empty goal

**Preconditions:** Team goal exists with no agents running (team was never started, or was torn down).

**Steps and expectations:**
1. Expand the goal.
   - Empty state shows "No agents — Start Team" with a crown icon button.
2. Click "Start Team".
   - Button text changes to "Starting…" with a spinner. Button is disabled.
   - A team lead session is created and appears under the goal.
   - You are connected to the team lead.
3. While the goal's worktree is still being set up ("preparing" state):
   - The button shows "Setting up…" with a spinner and is disabled.
   - The team cannot be started until setup completes.

**Coverage:** none.

---

## SB-18: Start a session on a non-team goal

**Preconditions:** Non-team goal exists with no sessions.

**Steps and expectations:**
1. Expand the goal.
   - Empty state shows "No sessions — start one" with a play icon link.
2. Click "start one".
   - A new session is created linked to the goal.
   - The session appears under the goal group.
   - You are connected to the new session.

**Coverage:** none.

---

## SB-19: Rename a session from the sidebar

**Preconditions:** Session exists.

**Steps and expectations:**
1. **Desktop:** Hover over a session row. Action buttons appear on the right via a gradient overlay.
   **Mobile:** Action buttons are always visible (no hover needed).
2. Click the pencil (rename) button.
   - A rename dialog appears with the current title pre-filled.
   - Input is focused.
3. Edit the title. Confirm (Enter or OK button).
   - Dialog closes. The sidebar row updates to show the new title immediately.
4. Reload the page.
   - The renamed title persists.
5. Click rename, then press Escape or Cancel.
   - Dialog closes. Title unchanged.

**Coverage:** none.

---

## SB-20: Terminate a session from the sidebar

**Preconditions:** Session exists.

**Steps and expectations:**
1. Hover over a session row (desktop). Click the terminate (trash) button.
   - The session disappears from the sidebar.
   - If it was the active session, the view switches to the landing page or another session.
2. Terminate a team lead session.
   - Tooltip says "End team (Ctrl+Shift+D)" instead of "Terminate".
   - Clicking it dismisses the entire team (team lead + all child agents).
   - All team sessions disappear from the sidebar.

**Coverage:** partial (S-04 covers the lifecycle; team termination: none).

---

## SB-21: Navigate to goal dashboard from sidebar

**Preconditions:** Goal exists.

**Steps and expectations:**
1. **Desktop:** Hover over a goal header row. A dashboard button (grid icon) appears in the action overlay.
   **Mobile:** Dashboard button is always visible.
2. Click the dashboard button.
   - The goal dashboard loads in the main content area.
   - The sidebar remains visible.
3. Click the button on a different goal.
   - Dashboard switches to the new goal.

**Coverage:** partial (N-02 covers basic navigation).

---

## SB-22: Re-attempt a completed or archived goal

**Preconditions:** Goal is archived, or has a merged PR and is eligible for archiving.

**Steps and expectations:**
1. Hover over the goal row. Click the re-attempt button (rotate icon).
   - A new goal assistant session opens.
   - The assistant is pre-seeded with context from the previous attempt (title, spec, outcome).
2. The new goal assistant guides you through creating a follow-up goal.

**Coverage:** none.

---

## SB-23: Archive a completed goal

**Preconditions:** Goal has a merged PR and no active team.

**Steps and expectations:**
1. Expand the goal.
   - The empty state shows "Work merged — Archive" with an archive button.
2. Click the archive button (either in the empty state or in the hover actions on the goal header).
   - Goal moves from the live goals section to the archived goals section.
   - If "Show archived" is off, the goal simply disappears from the live section.

**Coverage:** `tests/sidebar-archive-cta.spec.ts` (CTA rendering); archive lifecycle: none.

---

## SB-24: Filter sidebar by typing

**Preconditions:** Multiple goals, sessions, and staff exist with distinct titles.

**Steps and expectations:**
1. Click the search input in the sidebar (or press Ctrl+K / Cmd+K).
   - Search input focuses. Placeholder shows "Search... (Ctrl+K)" or "Search... (⌘K)".
2. Type a partial name (e.g. "deploy").
   - Sidebar filters instantly (client-side, no API call, no spinner).
   - A controls row appears below the input with a "Full Search" link.
   - Items remain visible if the query matches (case-insensitive) any of: goal title, session title, staff name.
   - A goal remains visible if it matches OR if any of its child sessions match.
   - A session remains visible if it matches OR if its parent goal matches.
3. Modify the query to something with no matches (e.g. "xyzzy").
   - All items are hidden. No explicit "no results" message — items are simply absent.
4. Clear the input (click X button, or select all + delete).
   - All items reappear. Controls row hides.
5. Press Escape while search is focused.
   - Input clears. Focus leaves the input. Sidebar restores to unfiltered state.
6. Type a query, then click a filtered session.
   - Session opens. Query remains in the input (not cleared on navigation).
   - Sidebar continues to show filtered results.

**Coverage:** `tests/search-box.spec.ts` (Ctrl+K, escape, clear, controls visibility). See also SR-01 in search.md.

---

## SB-25: Search auto-opens archived section

**Preconditions:** Archived sessions/goals exist. "Show archived" is off.

**Steps and expectations:**
1. Type a search query that matches an archived item's title.
   - The archived section auto-opens to include matches in the filter.
   - Archived sessions/goals that match are visible with their usual greyscale styling.
2. Clear the search query.
   - The archived section auto-closes (reverts to the user's previous toggle state).
3. Manually toggle "Show archived" on, then type a search query and clear it.
   - The archived section remains open after clearing (it was manually opened, not search-opened).

**Coverage:** none.

---

## SB-26: Launch full search from sidebar

**Preconditions:** Search box has a query typed.

**Steps and expectations:**
1. Click the "Full Search" link in the controls row below the input.
   - Navigation switches to the full search results page at `#/search?q=<query>`.
   - The query carries over and results include content matches (messages, specs, etc.).
2. See SR-02 in search.md for the full search page behavior.

**Coverage:** none.

---

## SB-27: Toggle "Show archived"

**Preconditions:** Archived sessions and goals exist.

**Steps and expectations:**
1. Click the "Show archived" toggle in the sidebar footer area.
   - A loading indicator may appear briefly (archived data is lazy-fetched on first toggle).
   - An "Archived" section appears at the bottom of the sidebar.
   - Archived goals are listed with their archived sessions nested inside.
   - Standalone archived sessions (not linked to any goal) appear in their own group.
   - Archived items have greyscale styling and reduced opacity.
2. Reload the page.
   - "Show archived" is still on (toggle state persisted).
   - Archived items are still visible (data re-fetched on load when toggle was persisted on).
3. Toggle "Show archived" off.
   - Archived section disappears. Live items are unaffected.

**Coverage:** none.

---

## SB-28: Navigate archived team structure

**Preconditions:** A completed goal with an archived team lead and several archived agents. "Show archived" is on.

**Steps and expectations:**
1. Expand the completed goal in the sidebar.
   - Archived team lead rows appear with greyscale styling.
   - Each archived team lead is expandable (chevron) with a count of child agents.
2. Expand an archived team lead.
   - Archived child agents appear nested and indented underneath.
   - Agents are grouped under the correct team lead (matched by `teamLeadSessionId`).
   - Delegate sub-sessions appear nested under their parent agent.
3. Click an archived session row.
   - The session connects and loads (replay/read-only mode — previous messages visible).

**Coverage:** none.

---

## SB-29: Paginated archived goals

**Preconditions:** Many archived goals exist (more than the initial fetch page size).

**Steps and expectations:**
1. Toggle "Show archived" on.
   - First page of archived goals loads.
2. Scroll to the bottom of the archived section.
   - A "Load more" button is visible if more archived goals exist.
3. Click "Load more".
   - Additional archived goals append to the list.
   - Previously loaded goals remain visible.
   - If no more pages exist, the "Load more" button disappears.

**Coverage:** none.

---

## SB-30: Provisional project indicator

**Preconditions:** A project is being set up (e.g. via goal assistant creating a new project).

**Steps and expectations:**
1. Look at the sidebar.
   - The provisional project header shows the project name with "(setting up)" in italic.
   - No "New Goal" or "+" session buttons are shown on the provisional project.
2. Project setup completes.
   - "(setting up)" disappears. Action buttons appear.

**Coverage:** none.

---

## SB-31: Staff section — status and wake

**Preconditions:** Staff agents configured for a project. Some active, some idle, some retired.

**Steps and expectations:**
1. Expand the "Staff" section under a project.
   - Each staff member shows their name and an icon.
   - Active staff with a running session show the session's status indicators (streaming dot or idle time).
   - Retired staff are visually dimmed.
2. Click the play/wake button on an idle staff member.
   - A session is created for the staff agent.
   - The staff row updates to show the active session with its status.
3. Click the staff row.
   - Connects to the staff's active session.

**Coverage:** none (ST-02 in staff.md covers the wake lifecycle).

---

## SB-32: Collapsed sidebar (icon-only mode)

**Preconditions:** Sidebar is expanded.

**Steps and expectations:**
1. Click the collapse button at the bottom of the sidebar (or press Ctrl+[).
   - Sidebar shrinks to a narrow strip (~56px).
   - Sessions and goals show as small icon buttons with 2-3 letter acronym labels.
   - Full text labels are hidden.
2. Click a session icon in the collapsed sidebar.
   - Session connects and loads in the main area.
3. Press Ctrl+[ again.
   - Sidebar expands to full width with all labels restored.
4. Reload the page.
   - Collapse state persists.

**Coverage:** none.

---

## SB-33: Mobile sidebar

**Preconditions:** Mobile viewport (narrow screen or touch-primary device).

**Steps and expectations:**
1. The sidebar is not visible by default.
2. Tap the hamburger menu button.
   - Sidebar opens as a full-height overlay.
   - Action buttons (rename, terminate, dashboard) are always visible on each row (no hover-reveal).
   - Tap targets are larger than desktop (more padding).
3. Tap a session row.
   - Session connects. Sidebar overlay closes automatically.
4. Tap outside the sidebar (or swipe to dismiss, if supported).
   - Sidebar closes without navigation.

**Coverage:** none (N-05 in navigation.md describes the expectation).

---

## SB-34: Sidebar keyboard shortcuts

**Steps and expectations:**
1. Press Ctrl+K (Cmd+K on Mac).
   - Search input in the sidebar focuses immediately.
2. Press Escape while search is focused.
   - Search clears and blurs.
3. Press Ctrl+[ (or Ctrl+]).
   - Sidebar toggles between collapsed and expanded.
4. Press Alt+G.
   - Goal creation dialog/assistant opens.
5. Shortcuts do not fire when a text input or textarea elsewhere has focus.

**Coverage:** `tests/search-box.spec.ts` (Ctrl+K); others: none.

---

## SB-35: Session personality badges

**Preconditions:** Sessions exist with one or more personalities assigned.

**Steps and expectations:**
1. Look at a session row that has personalities assigned.
   - Tiny rounded pill badges appear below the session title, one per personality name.
   - Badges are small (~9px text) and do not interfere with the session title or action buttons.
2. A session with no personalities shows no badges.

**Coverage:** none.

---

## SB-36: Sandbox indicator

**Preconditions:** A project with Docker sandbox enabled. Sessions exist for that project.

**Steps and expectations:**
1. Look at session rows for the sandboxed project.
   - A small box/package icon appears indicating sandbox mode.
   - A colored dot on the icon indicates container status (green = active, grey = inactive).

**Coverage:** none.

---

## SB-37: Sidebar survives gateway restart

**Preconditions:** Sidebar has expanded/collapsed goals, projects, and active sessions.

**Steps and expectations:**
1. Note the current sidebar state: which projects are expanded, which goals are expanded, which session is active.
2. Gateway restarts (e.g. `npm run restart-server`).
3. Page reconnects automatically.
   - All sessions reappear in the sidebar.
   - Expand/collapse state for projects and goals is preserved (stored client-side).
   - The previously active session reconnects and is highlighted.
   - Goal badges refresh with current gate/PR status.

**Coverage:** none (G-12 in goals.md covers goal survival; sidebar-specific state preservation: none).
