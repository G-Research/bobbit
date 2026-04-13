# Cross-Feature Contracts

This document defines guarantees that one feature provides to others. Each contract describes a user-visible invariant — what the user can rely on — independent of implementation.

---

## CT-01: Streaming lifecycle drives prompt controls, preserves partial work, and updates cost

**Guarantee:**
While an agent is responding, the send button becomes a stop button and the message queue accepts new messages. When the agent finishes or is aborted, the stop button reverts to send and any queued messages are dispatched in order. The textarea remains editable at all times — users can always type their next message.

**Abort preserves partial work:**
When the user clicks Stop, the agent's partial response is kept in the conversation. The interface returns to its idle state — send button restored, textarea re-enabled — and the conversation is ready for the next message. No content is lost.

**Cost and token display update in real time:**
While an agent is responding, the cost and token usage displayed in the context bar update continuously to reflect tokens consumed so far. When streaming completes, the final totals are shown. Switching sessions shows that session's accumulated totals.

**Survives:**
- Multiple rapid sends while agent is mid-response
- Aborting a response mid-stream
- Switching away from and back to the session
- Immediate re-send after abort
- Page reload (partial response and totals restored from server)
- Multiple concurrent agent sessions

**Does not survive:**
- Session termination (queue is discarded, counters removed)

**Timing:**
Button state changes within the same frame as the streaming state transition. Queued messages dispatch sequentially — each waits for the agent to become idle before sending the next. UI returns to idle state immediately on abort. Cost and token updates arrive with each streaming chunk — no batching delay visible to the user.

**Consumers:**
Message editor (PI-01, PI-11, PI-21), message queue (PI-11, PI-25), message display (PI-01, PI-21b), context bar (PI-23)

**Provider stories:** PI-01, PI-11, PI-21, PI-21b, PI-23, PI-25
**Related contracts:** CT-05, CT-02

---

## CT-02: Session switch preserves drafts and context

**Guarantee:**
When the user switches sessions, any unsent text and file attachments in the message editor are saved. Returning to that session restores the draft exactly — text content, cursor position, and attached files. The context bar (cost, token usage, model, git status) updates atomically to reflect the newly selected session. Command history (arrow-up recall) is scoped per session.

**Survives:**
- Rapid switching between multiple sessions
- Page reload (drafts persist)
- Switching to a goal dashboard and back

**Does not survive:**
- Session termination (draft is discarded with the session)

**Timing:**
Draft save happens before navigation begins. Context bar and command history update before the new session's messages are rendered.

**Consumers:**
Message editor (PI-04, PI-04b, PI-04c), context bar (PI-23), command history (PI-03)

**Provider stories:** PI-03, PI-04, PI-04b, PI-04c, PI-23
**Related contracts:** CT-03, CT-05

---

## CT-03: Session switch updates the sidebar

**Guarantee:**
When the user navigates to a session, the sidebar highlights that session's row and removes the highlight from the previous one. Only one row is highlighted at a time. If the session is nested inside a collapsed goal or project, the tree expands to reveal it.

**Survives:**
- Deep-link navigation (direct URL)
- Back/forward browser navigation
- Page reload

**Does not survive:**
- Nothing — this is a stateless derivation of the current route

**Timing:**
Highlight changes synchronously with the route change. Tree expansion completes before the highlight is applied.

**Consumers:**
Sidebar navigation (SB-03, SB-04), deep links (N-03)

**Provider stories:** SB-03, SB-04, N-03
**Related contracts:** CT-02, CT-05

---

## CT-04: Sidebar reflects live session and agent status

**Guarantee:**
The sidebar shows real-time status for every session: a pulsing indicator while an agent is responding, a solid indicator when idle, and a blue activity dot when a non-active session receives a new response. New sessions appear in the sidebar when created; terminated sessions disappear (with child sessions cascading for team terminations). Goal rows show workflow status badges, gate progress, and PR status.

**Survives:**
- Page reload (status reconstructed from server state)
- Agent crash and restart (status re-syncs)
- Multiple agents responding simultaneously

**Does not survive:**
- Nothing — sidebar always reflects current server state

**Timing:**
Status indicators update within one second of the underlying event. New session rows appear only after server confirmation, not optimistically. The unseen activity dot clears when the user navigates to that session.

**Consumers:**
Session monitoring (SB-05, SB-06, SB-07), session lifecycle (SB-14, SB-16), goal tracking (SB-09, SB-10, SB-11)

**Provider stories:** SB-05, SB-06, SB-07, SB-09, SB-10, SB-11, SB-14, SB-16
**Related contracts:** CT-03, CT-09

---

## CT-05: Page reload and reconnect restore full state

**Guarantee:**
After a page reload, browser crash, or server restart, the user returns to the same view with the same state: the correct session or dashboard is displayed, the sidebar shows all sessions in their proper hierarchy with correct highlights, the selected model is preserved, queued messages are re-sent, and the search index is intact. No user action is required to recover.

**Survives:**
- Browser refresh
- Browser crash and reopen
- Server crash and restart
- Network disconnection and reconnection

**Does not survive:**
- Clearing browser storage (local preferences lost, but server state still recovers)
- Session termination during the outage

**Timing:**
Server state (sessions, goals, gates) recovers on server startup before accepting connections. Client state (model selection, view) recovers on reconnect. Queued messages re-send automatically on WebSocket reconnection.

**Consumers:**
All features — this is the foundational durability guarantee (PI-11b, PI-15, RE-01 through RE-08, S-14)

**Provider stories:** PI-11b, PI-15, RE-01, RE-02, RE-03, RE-04, RE-05, RE-06, RE-07, RE-08, S-14
**Related contracts:** CT-01, CT-02, CT-03, CT-04

---

## CT-06: Focus follows the user's intent

**Guarantee:**
When the user navigates to a session (via sidebar click, deep link, or session creation), the message textarea automatically receives focus so they can start typing immediately. When a dialog, modal, or overlay is open, focus is scoped to that element — the textarea does not steal focus back.

**Survives:**
- Rapid session switching
- Closing a dialog (focus returns to textarea)

**Does not survive:**
- Opening a dialog (focus moves to the dialog)

**Timing:**
Focus moves after the navigation animation completes and the new session's content is rendered.

**Consumers:**
Message editor (PI-24), dialogs and modals (PI-24)

**Provider stories:** PI-24
**Related contracts:** CT-02

---

## CT-07: Goal creation sets up the full workspace

**Guarantee:**
When a user creates a goal, the system performs a complete setup sequence: the goal appears in the sidebar, the browser navigates to the goal dashboard, an isolated worktree is created for the goal's code, and the team lead agent is spawned — in that order. The user does not need to manually trigger any of these steps. The selected workflow and optional steps determine which gates the goal requires.

**Survives:**
- Server restart after goal creation (goal and worktree persist)

**Does not survive:**
- Goal abort (everything is cleaned up)

**Timing:**
Sidebar row and dashboard appear immediately. Worktree setup completes before the team lead is spawned — agents never start in a partially configured workspace.

**Consumers:**
Sidebar (G-01, SB-21), dashboard (G-02, D-02), team agents (T-01, T-10), workflow gates (W-03)

**Provider stories:** G-01, G-02, G-03, G-04, T-10, W-03
**Related contracts:** CT-08, CT-09

---

## CT-08: Team agents appear nested under their goal

**Guarantee:**
When a team agent is spawned for a goal, it appears as a child row under that goal in the sidebar. The nesting visually communicates which agents belong to which goal. Dismissing an agent removes its row; completing or aborting the goal removes all agent rows.

**Survives:**
- Page reload
- Agent crash and restart
- Server restart

**Does not survive:**
- Goal completion or abort (all child rows removed)
- Agent dismissal (that agent's row removed)

**Timing:**
The agent row appears in the sidebar after the server confirms the spawn, not before.

**Consumers:**
Sidebar hierarchy (T-01, SB-21), agent monitoring (T-04)

**Provider stories:** T-01, SB-21, T-04
**Related contracts:** CT-07, CT-04

---

## CT-09: Gates enforce workflow ordering and dashboard displays progress

**Guarantee:**
Workflow gates form a dependency chain — an upstream gate must pass before a downstream gate can be signaled. Gate verification runs automatically when a gate is signaled and streams results to the dashboard in real time. The review gate must pass before a goal can be marked complete. Users can see gate status, progress, and verification output on the dashboard at all times.

**Dashboard tabs show goal details on demand:**
The goal dashboard organizes information into tabs (overview, gates, tasks, team, etc.). Switching tabs loads the correct content for that tab. Switching to a different goal resets the tab to the default. PR status is displayed with freshness information when available.

**Survives:**
- Server restart (gate state persists)
- Verification failure (gate stays in failed state, can be re-signaled)
- Page reload (dashboard re-renders from current goal state)
- Gate verification completing while viewing (live update)

**Does not survive:**
- Goal abort (gates discarded with the goal)
- Goal termination (dashboard no longer accessible)

**Timing:**
Signaling an out-of-order gate is rejected immediately. Verification begins as soon as the signal is accepted. Dashboard updates stream in real time during verification. Tab content loads immediately on click. PR status updates propagate within seconds of a status change.

**Consumers:**
Dashboard (D-02, D-03, D-04, D-05), goal completion (T-05), team agents (G-06, W-06), goal monitoring (D-02, D-05)

**Provider stories:** G-06, W-06, D-02, D-03, D-04, D-05, T-05
**Related contracts:** CT-07, CT-10, CT-11

---

## CT-10: Task completion carries git handoff data

**Guarantee:**
When a team agent completes a task, the result includes the branch name and commit references needed for the team lead to merge the work. This enables the team lead to integrate contributions from multiple agents without manual coordination.

**Survives:**
- Server restart (task results persist)
- Agent dismissal after task completion (result already recorded)

**Does not survive:**
- Goal abort (tasks discarded)

**Timing:**
Git handoff data is available on the task immediately upon completion — the team lead can merge as soon as it sees the task marked complete.

**Consumers:**
Team lead merge flow (T-09)

**Provider stories:** T-09
**Related contracts:** CT-09, CT-11

---

## CT-11: Goal completion archives and cleans up

**Guarantee:**
When a goal is completed, all team agents are dismissed, their worktrees are cleaned up, and the goal moves from the active section to the archived section in the sidebar. Dismissed agents' worktrees are removed from disk. The archived goal remains viewable but no longer occupies active resources.

**Survives:**
- Page reload (archived state persists)

**Does not survive:**
- Nothing — archival is permanent (unless manually restored)

**Timing:**
Agent dismissal and worktree cleanup happen before the goal is marked archived. The sidebar move is visible immediately after completion.

**Consumers:**
Sidebar archive section (G-10, SB-28, SB-30), worktree management (T-04)

**Provider stories:** G-10, T-04, SB-28, SB-30
**Related contracts:** CT-08, CT-09

---

## CT-12: Staff agents trigger and pause on schedule

**Guarantee:**
Staff agents create new sessions when their trigger conditions are met. Pausing a staff agent prevents it from triggering — no new sessions are created while paused. Unpausing resumes normal trigger behavior.

**Survives:**
- Server restart (pause state persists)
- Page reload

**Does not survive:**
- Staff agent removal

**Timing:**
Pause takes effect immediately — a trigger arriving in the same moment as a pause will not fire. Session creation from a trigger is confirmed by the server before appearing in the sidebar.

**Consumers:**
Sidebar (ST-01, ST-02), session management (ST-03)

**Provider stories:** ST-01, ST-02, ST-03
**Related contracts:** CT-04, CT-07

---

## CT-13: URL routing determines the displayed view and scopes keyboard shortcuts

**Guarantee:**
The URL hash determines what the user sees: a session conversation, a goal dashboard, search results, or settings. Changing the URL (via sidebar click, link, or direct entry) loads the corresponding view. The browser's back and forward buttons navigate between previously visited views. A deep link to any view loads it directly with the sidebar expanded to show the relevant entry.

**Keyboard shortcuts are scoped to the active view:**
Keyboard shortcuts only affect the view the user is currently looking at. A shortcut that applies to a session conversation does nothing on the goal dashboard, and vice versa. This prevents accidental actions in background views. Shortcut scoping updates synchronously with view transitions — there is no window where a shortcut could fire against the wrong view.

**Survives:**
- Page reload (URL preserved, view restored)
- Browser back/forward navigation
- Bookmarking and sharing URLs
- View transitions (shortcuts re-scope immediately)

**Does not survive:**
- Session or goal termination (URL becomes invalid, redirects to a default view)

**Timing:**
View transitions begin immediately on URL change. Sidebar expansion for deep links completes before the content area renders.

**Consumers:**
All views (N-01, N-02, N-03, N-04), sidebar (SB-03), keyboard shortcuts (N-08)

**Provider stories:** N-01, N-02, N-03, N-04, N-08
**Related contracts:** CT-03, CT-05

---

## CT-14: Search indexes content and navigates to results

**Guarantee:**
The search feature finds matching sessions, goals, and messages across all projects. Results appear as the user types. Clicking a result navigates to that session or goal; pressing back returns to the search view with results preserved. The search index stays current — new content is indexed, deleted sessions are removed, and removing a project cleans its entries from the index.

**Survives:**
- Page reload (search index persists on disk)
- Server restart (index rebuilt if needed)
- Project addition or removal (index updated)

**Does not survive:**
- Nothing — search index is always eventually consistent with server state

**Timing:**
Results appear as the user types with minimal delay. Index updates happen in the background — newly created sessions may take a moment to appear in results.

**Consumers:**
Search UI (SR-01 through SR-06), content lifecycle (SR-08), project management (PR-07)

**Provider stories:** SR-01, SR-02, SR-03, SR-04, SR-05, SR-06, SR-08
**Related contracts:** CT-13, CT-16

---

## CT-15: Config changes apply without restart

**Guarantee:**
Changes to roles, personalities, tool policies, and other configuration take effect on new messages and sessions without requiring a server restart. The config cascade resolves settings in priority order — project-level overrides server-level, which overrides built-in defaults. The most specific setting always wins. Settings changed in the UI persist across page reloads.

**Survives:**
- Page reload (settings persisted)
- Server restart (config read from disk)
- Adding or removing projects (per-project config scoped correctly)

**Does not survive:**
- Nothing — config is always persistent

**Timing:**
Config changes affect the next message or session, not ones already in progress. A role change mid-stream does not alter the current response.

**Consumers:**
Agent behavior (CC-01 through CC-07), settings UI (SET-01 through SET-09)

**Provider stories:** CC-01, CC-02, CC-03, CC-04, CC-05, CC-06, CC-07, SET-01, SET-02, SET-03, SET-04, SET-05, SET-06, SET-07, SET-08, SET-09
**Related contracts:** CT-05, CT-16

---

## CT-16: Projects organize sessions and scope configuration

**Guarantee:**
Each registered project gets its own section in the sidebar containing its sessions and goals. Adding a project creates the section; removing a project removes the section, orphans its sessions, and cleans its entries from the search index. No files are deleted from disk when removing a project — only the registration is removed.

**Survives:**
- Page reload
- Server restart

**Does not survive:**
- Project removal (section removed, sessions orphaned)

**Timing:**
The sidebar section appears immediately after project registration completes. Removal is immediate — the section disappears as soon as the server confirms.

**Consumers:**
Sidebar (PR-01, PR-02, PR-07), search (SR-08), config cascade (CC-01)

**Provider stories:** PR-01, PR-02, PR-07
**Related contracts:** CT-14, CT-15

---

## CT-17: Sandbox isolates commands from the host

**Guarantee:**
When a project uses sandbox mode, all agent commands execute inside an isolated container, not on the host machine. The container persists across agent sessions for the same project. If the server crashes, both the container and server recover — work inside the container is not lost.

**Survives:**
- Server restart (container reconnected)
- Server crash (container survives independently)
- Agent session switch (same container reused)

**Does not survive:**
- Project removal (container cleaned up)
- Explicit container reset by the user

**Timing:**
The container is ready before the first command executes. Container recovery on server restart completes before agents resume work.

**Consumers:**
Agent command execution (SX-01), crash recovery (SX-06)

**Provider stories:** SX-01, SX-06
**Related contracts:** CT-05, CT-16
