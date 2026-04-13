# Feature Interaction Matrix

When building a new feature, find the section(s) below that match what your
feature does. Honor the listed contracts and verify against the listed stories.

---

## Features that create or destroy sessions

**Contracts:** CT-01, CT-02, CT-04, CT-06, CT-09, CT-10

**Story files:** [sessions.md](sessions.md), [sidebar.md](sidebar.md), [resilience.md](resilience.md), [navigation.md](navigation.md)

**Checklist:**

- [ ] New session appears in the sidebar immediately under the correct project and group (ungrouped, goal, or staff)
- [ ] New session is highlighted as the active session; previously active session loses highlight
- [ ] URL updates to `#/session/<id>` and textarea is focused on creation
- [ ] If the project is a git repo, a dedicated worktree branch is created (not `master` or the goal branch)
- [ ] `worktree_setup_command` runs before the session accepts input (if configured)
- [ ] Terminating a session archives it and recursively archives all its delegates
- [ ] Archived sessions disappear from the sidebar when "Show archived" is off
- [ ] Session state (title, messages, worktree) survives a server crash and restart
- [ ] Destroying a session does not affect the draft text in other sessions
- [ ] Rapid create-then-switch does not leave orphaned sessions or blank content areas

---

## Features that modify the input area or editor

**Contracts:** CT-01, CT-02, CT-06

**Story files:** [prompt-interactions.md](prompt-interactions.md), [sessions.md](sessions.md)

**Checklist:**

- [ ] Draft text is preserved when switching away from a session and back
- [ ] Drafts are isolated per-session — typing in session A does not affect session B's draft
- [ ] Enter sends the message; Shift+Enter inserts a newline (message is not sent)
- [ ] Empty or whitespace-only messages are never sent (Enter is a no-op)
- [ ] Textarea clears and re-focuses after a message is sent and the agent finishes responding
- [ ] Send button transitions to Stop button during agent streaming, and back when done
- [ ] File attachments persist in the draft across session switches until explicitly removed
- [ ] Cmd/Ctrl+K focuses the search input, not the editor (keyboard shortcut scoping)
- [ ] Up/Down arrow in an empty textarea navigates command history without side effects
- [ ] Textarea grows vertically for multiline input (up to max height) and shrinks back after send

---

## Features that change what's visible in the sidebar

**Contracts:** CT-03, CT-04, CT-11, CT-16

**Story files:** [sidebar.md](sidebar.md), [goals.md](goals.md), [staff.md](staff.md), [search.md](search.md)

**Checklist:**

- [ ] Sessions nest under their parent: goal → team lead → team member → delegate (never at the wrong level)
- [ ] Unseen activity indicator (dot or badge) appears on sessions that received messages while not selected
- [ ] Unseen indicator clears when the session is selected (opened)
- [ ] Goal badge shows the goal's status (active, complete, archived) with correct color
- [ ] Filter mode (Ctrl+K → type) hides non-matching entries instantly; clearing restores all
- [ ] "Show archived" toggle controls visibility of archived goals, sessions, and their trees
- [ ] Collapsing a project hides all its children; expanding restores them
- [ ] Staff section shows staff agents with their state (active/paused) and trigger summary
- [ ] Sidebar width and collapse state persist across page reloads
- [ ] Adding/removing a project updates the sidebar project list without a full page reload

---

## Features that affect agent streaming or status

**Contracts:** CT-01, CT-03, CT-04, CT-06

**Story files:** [prompt-interactions.md](prompt-interactions.md), [sessions.md](sessions.md), [resilience.md](resilience.md)

**Checklist:**

- [ ] Agent response streams token-by-token — user sees incremental text, not a single block
- [ ] Send button becomes Stop button during streaming; clicking Stop aborts the stream
- [ ] After abort, partial response remains visible in chat (not discarded)
- [ ] Textarea re-enables and re-focuses after streaming completes or is aborted
- [ ] Context bar updates cost and token usage as the response streams
- [ ] Switching to another session while one is streaming does not disrupt the background stream
- [ ] Background session with active streaming shows unseen activity indicator in the sidebar
- [ ] If the server crashes mid-stream, the partial response is preserved on restart
- [ ] Tool calls render their tool-specific UI (file diffs, proposals, etc.) as they arrive
- [ ] Multiple concurrent streaming sessions do not cross-contaminate messages

---

## Features that add or modify navigation routes

**Contracts:** CT-03, CT-06, CT-13

**Story files:** [navigation.md](navigation.md), [sidebar.md](sidebar.md)

**Checklist:**

- [ ] Every navigable view has a unique hash URL (`#/session/<id>`, `#/goal/<id>`, `#/settings`, etc.)
- [ ] Browser Back/Forward buttons work correctly between all views
- [ ] Deep-linking to a URL loads the correct view on initial page load
- [ ] Navigating to a non-existent resource (deleted session, missing goal) shows a graceful fallback — no crash or blank screen
- [ ] Sidebar highlight stays in sync with the current URL at all times
- [ ] Page title updates to reflect the current view (session title, goal name, or page name)
- [ ] Navigating away from a session preserves its scroll position; returning restores it
- [ ] Keyboard shortcuts (Ctrl+K for search, etc.) are scoped to the current view and do not fire in text inputs
- [ ] Route changes clear any modal overlays or transient UI (dialogs, dropdowns)
- [ ] Settings sub-tabs update the URL fragment and survive page reload

---

## Features that change session or goal configuration

**Contracts:** CT-15, CT-16

**Story files:** [config-cascade.md](config-cascade.md), [settings.md](settings.md), [goals.md](goals.md), [projects.md](projects.md)

**Checklist:**

- [ ] Config changes resolve through the three-layer cascade: builtin → server → project (most-specific wins)
- [ ] Origin badges (builtin/server/project) display correctly on each config item
- [ ] Inherited items appear dimmed; locally-defined items appear at full opacity
- [ ] Scope switcher (System / Project A / Project B) updates the list without stale rows from previous scope
- [ ] Changing a model or role at the project level takes effect in new sessions immediately
- [ ] Active sessions are not disrupted by config changes (changes apply to new sessions only, unless specified)
- [ ] "Customize" creates a project-level override; "Revert" removes it and falls back to parent layer
- [ ] Removing a project cleans up its config overrides and unregisters it — no orphaned config
- [ ] Per-project settings (build command, test command, etc.) persist across server restarts
- [ ] Goal configuration (workflow, optional steps) is frozen at creation time — later workflow edits don't retroactively change active goals

---

## Features that persist state (must survive crash/reload)

**Contracts:** CT-01, CT-05, CT-10

**Story files:** [resilience.md](resilience.md), [sessions.md](sessions.md), [goals.md](goals.md)

**Checklist:**

- [ ] Sessions survive server crash: title, messages, worktree, and branch are all restored on restart
- [ ] Goals survive server crash: title, status, gate states, task states, and team list are restored
- [ ] Queued messages are persisted and re-dispatched after restart (queue is durable)
- [ ] Draft text in the editor survives a page reload (stored client-side)
- [ ] Sidebar collapse state, "Show archived" toggle, and search query persist across reload
- [ ] Config changes (project settings, roles, workflows) persist to disk immediately — no "save" delay
- [ ] The search index rebuilds from stores on startup if `search.db` is missing or schema-mismatched
- [ ] Annotations on review documents survive browser close, server restart, and are shared across clients
- [ ] Session `.jsonl` files exist for every session in `sessions.json` — missing `.jsonl` = session skipped on restore
- [ ] Container state (sandbox) is reconciled on restart — stale containers are detected, not blindly reused

---

## Features that modify search-indexable content

**Contracts:** CT-14, CT-16

**Story files:** [search.md](search.md), [sidebar.md](sidebar.md)

**Checklist:**

- [ ] New messages are incrementally indexed as they stream in (no manual rebuild needed)
- [ ] Goal title and spec are indexed at creation and updated on edit
- [ ] Session title changes update the search index (auto-generated titles and manual renames)
- [ ] Archiving a session or goal does not remove it from the search index — archived results appear with appropriate styling
- [ ] Deleting content removes it from search results (no stale entries)
- [ ] Full search mode (`#/search?q=...`) returns results grouped by type: Goals, Sessions, Messages
- [ ] Filter mode (sidebar) matches goal names, session titles, staff names, and agent names client-side
- [ ] Clicking a search result navigates to the correct session or goal
- [ ] Rebuilding the index (delete `search.db` + restart) restores all searchable content from stores
- [ ] Staff name and description are indexed and searchable

---

## Features that involve goal lifecycle (create/setup/complete/archive)

**Contracts:** CT-01, CT-07, CT-08, CT-09, CT-10

**Story files:** [goals.md](goals.md), [team.md](team.md), [workflows.md](workflows.md), [dashboard.md](dashboard.md)

**Checklist:**

- [ ] Goal creation (via assistant or API) adds the goal to the sidebar immediately
- [ ] After creation, browser navigates to the goal dashboard; assistant session closes automatically
- [ ] Team auto-start spawns the team lead with an isolated git worktree branched from the goal branch
- [ ] Gates enforce dependency ordering — upstream gates must pass before downstream gates accept signals (409 if not)
- [ ] Signaling a gate triggers async verification; verification results update the dashboard in real time
- [ ] `team_complete` requires the review gate to have passed — server rejects premature completion
- [ ] Completing a goal archives it and tears down all team agents and their worktrees
- [ ] Archived goals and their entire session tree move to the archived sidebar section
- [ ] Goal status, gate states, and task states survive a server crash and restart
- [ ] The dashboard shows gates, tasks, and team agents with correct statuses — no stale or phantom entries

---

## Features that run in or depend on sandbox isolation

**Contracts:** CT-10, CT-15, CT-17

**Story files:** [sandbox.md](sandbox.md), [resilience.md](resilience.md), [projects.md](projects.md)

**Checklist:**

- [ ] Enabling `sandbox: "docker"` causes all agent commands to execute inside a Docker container, not on the host
- [ ] Only one container exists per project, regardless of how many sessions are active
- [ ] `GET /api/sandbox-status` returns the running container's state for the project
- [ ] Agent `bash` commands reflect the container's filesystem (e.g., `whoami` returns container user)
- [ ] Git operations inside the sandbox work on the mounted repository with correct branch state
- [ ] Staff agents in sandbox mode use container-internal worktrees via `sandboxBranch`
- [ ] If Docker is unavailable, container creation fails with a clear error — no silent fallback to host execution
- [ ] Disabling sandbox for a project makes new sessions run on the host; existing container is not auto-removed
- [ ] Container state is reconciled on server restart — stale containers are detected via labels
- [ ] Long-running commands inside the container respect the same timeout as host commands

---

## Features that add or modify workflow gates

**Contracts:** CT-01, CT-08, CT-09, CT-10

**Story files:** [workflows.md](workflows.md), [goals.md](goals.md), [dashboard.md](dashboard.md)

**Checklist:**

- [ ] New gates appear in the workflow editor with correct dependency wiring (expand to see dependencies)
- [ ] Gate dependency arrows render correctly — no cycles allowed, server rejects invalid dependency graphs
- [ ] Verification steps grouped under phase headers (Phase 0, Phase 1, etc.) execute in order
- [ ] Optional steps can be toggled off during goal creation — they do not appear in the created goal's gate list
- [ ] Gate status on the dashboard updates in real time: pending → passed/failed, with timestamp
- [ ] Stuck verification can be cancelled via the dashboard Cancel button or `POST .../cancel-verification`
- [ ] Editing a workflow does not retroactively change gates on active goals (frozen at creation)
- [ ] Gate content, verification output, and signal history are inspectable via `gate_inspect`
- [ ] Workflow CRUD (create, edit, delete) respects the config cascade — builtin workflows cannot be deleted, only overridden
- [ ] Gate states survive server crash and restart — passed gates stay passed, pending stay pending

---

## Features that create or configure staff agents

**Contracts:** CT-01, CT-10, CT-12, CT-16

**Story files:** [staff.md](staff.md), [sidebar.md](sidebar.md), [sandbox.md](sandbox.md)

**Checklist:**

- [ ] Creating a staff agent (via assistant `propose_staff` or API) adds it to the sidebar Staff section immediately
- [ ] Staff list page shows name, state (active/paused badge), trigger summary, and last active timestamp
- [ ] Trigger conditions (cron, git push, manual) fire correctly and create a new session for the staff agent
- [ ] Staff session appears under the Staff sidebar section, not in the ungrouped sessions area
- [ ] Pausing a staff agent prevents triggers from firing; resuming re-enables them
- [ ] Staff worktrees are refreshed on each wake cycle — branch rebased, `worktree_setup_command` re-run
- [ ] Sandboxed staff skip host-side worktree refresh (their worktrees live inside the container)
- [ ] Staff agent configuration (name, prompt, triggers, CWD) persists across server restarts
- [ ] Deleting a staff agent removes it from the sidebar and stops all future triggers
- [ ] Auto-nudge does not flood the team lead with duplicate messages after sleep/wake cycles
