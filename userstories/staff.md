# Staff — User Stories

Staff agents are persistent, project-scoped agents that can be triggered manually or automatically. These stories cover the staff list page, sidebar section, CRUD operations, wake flow, and pause/resume lifecycle.

---

## ST-01: View the staff list page

**Preconditions:** At least two staff agents exist for the current project — one active ("Deploy Bot") and one paused ("Nightly Linter"). Navigate to `#/staff`.

**Steps and expectations:**
1. The staff list page renders a table with columns: Name, State, Triggers, Last Active.
   - "Deploy Bot" row shows state badge **active** (green).
   - "Nightly Linter" row shows state badge **paused** (yellow).
   - Trigger column shows summary text (e.g. "Cron: 0 3 * * *", "Git: push", or "No triggers").
   - Last Active column shows a relative timestamp (e.g. "2 hours ago").
2. Click the "Deploy Bot" row.
   - The edit view for "Deploy Bot" opens (see ST-03 for edit details).
3. Navigate to `#/staff` for a project with zero staff agents.
   - Empty state appears: "No staff agents yet" with a UserCheck icon.
   - No table headers are rendered.

**Coverage:** none — needs browser E2E for list rendering, state badges, empty state

---

## ST-02: Create a staff agent via assistant

**Preconditions:** At least one project exists. Sidebar is visible.

**Steps and expectations:**
1. In the sidebar, locate the Staff section under the project. Click the `+` button in the Staff section header.
   - A new staff assistant session opens.
   - The session is scoped to the current project.
2. Interact with the assistant to define a staff agent (name: "PR Reviewer", description, system prompt, triggers).
   - The assistant calls `propose_staff` with the provided configuration.
   - A proposal card renders in the chat showing name, prompt summary, and trigger config.
3. Approve the proposal.
   - The new staff agent "PR Reviewer" appears in the sidebar Staff section.
   - The staff list page (`#/staff`) includes "PR Reviewer" with state **active** (green badge).
   - The Triggers column shows the configured trigger summary.
4. Reject the proposal instead.
   - No staff agent is created. Sidebar Staff section is unchanged.

**Coverage:** none — needs browser E2E for assistant + propose_staff flow

---

## ST-03: Edit a staff agent

**Preconditions:** A staff agent "Deploy Bot" exists. Navigate to `#/staff`.

**Steps and expectations:**
1. Click the "Deploy Bot" row to open the edit view.
   - Edit form shows: name field (populated with "Deploy Bot"), description field, system prompt textarea, CWD field, triggers config, accessory picker, and hue selector.
2. Change the name to "Release Bot". Modify the system prompt text.
   - Fields accept input. No save happens yet.
3. Save the changes.
   - The API call `PUT /api/staff/:id` fires with updated fields.
   - Sidebar updates to show "Release Bot" instead of "Deploy Bot".
   - Navigating back to the staff list page shows "Release Bot" in the Name column.
4. In the sidebar, hover over a staff entry.
   - An edit (pencil) button appears on the row.
5. Click the pencil button.
   - The edit view for that staff agent opens (same form as step 1).

**Coverage:** none — needs browser E2E for edit form, save, sidebar update

---

## ST-04: Delete a staff agent

**Preconditions:** A staff agent "Stale Bot" exists. Navigate to `#/staff`, open the edit view for "Stale Bot".

**Steps and expectations:**
1. Click the Delete button (trash icon).
   - A confirmation dialog appears (not an immediate delete).
2. Confirm the deletion.
   - `DELETE /api/staff/:id` fires.
   - The edit view closes and the staff list page re-renders.
   - "Stale Bot" no longer appears in the table.
   - "Stale Bot" no longer appears in the sidebar Staff section.
3. If "Stale Bot" had an active session, that session is terminated on delete.
4. Repeat steps 1–2 but cancel the confirmation dialog instead.
   - "Stale Bot" remains in the list and sidebar. No API call is made.

**Coverage:** none — needs browser E2E for delete confirmation flow

---

## ST-05: Sidebar staff display and interaction

**Preconditions:** A project has three staff agents: "Active Bot" (active, with a recent session), "Paused Bot" (paused), and "Retired Bot" (retired). Sidebar is visible.

**Steps and expectations:**
1. Locate the Staff section under the project in the sidebar.
   - Section header shows a Bot icon, uppercase **STAFF** label, a list button (links to `#/staff`), and a `+` button.
   - A `▸`/`▾` chevron allows expanding/collapsing the section.
2. Expand the Staff section.
   - "Active Bot" and "Paused Bot" are listed. "Retired Bot" is **not** shown (retired staff are filtered out).
   - Each entry shows: a colored status bobbit icon (colored by session status), agent name (truncated if long), relative time since last activity.
3. "Active Bot" has unseen activity.
   - A primary-color dot (`●`) appears on the "Active Bot" row.
4. Click the "Active Bot" entry.
   - Navigates to the existing session for "Active Bot" (calls `handleStaffClick`).
   - The row gets the active styling: `bg-secondary text-foreground sidebar-session-active`.
5. Click the list button in the Staff section header.
   - Navigates to `#/staff` (staff list page).
6. Collapse the Staff section by clicking the chevron.
   - All staff entries are hidden. Only the section header remains visible.
7. Expand again.
   - Entries reappear in the same order.

**Coverage:** unit (sidebar-staff-rendering.spec.ts — status indicators, wake button, retired dimming); needs browser E2E for full sidebar interaction

---

## ST-06: Wake a staff agent

**Preconditions:** A staff agent "Monitor Bot" exists with state **active** and no current session.

**Steps and expectations:**
1. In the sidebar, hover over the "Monitor Bot" entry.
   - A wake button (zap icon) appears alongside the edit (pencil) button.
2. Click the wake (zap) button.
   - `POST /api/staff/:id/wake` fires.
   - A new session is created for "Monitor Bot" (API returns `{ sessionId }`).
   - The sidebar updates: "Monitor Bot" now shows an active session status icon.
   - The app navigates to the newly created session.
3. Navigate to `#/staff`, open the edit view for "Monitor Bot".
   - A "Wake Now" button (Zap icon) is visible.
4. Click "Wake Now".
   - Same behavior as step 2: a new session is created and navigated to.
5. Click the "Monitor Bot" sidebar entry when it already has an active session.
   - Navigates to the existing session (no new session created).

**Coverage:** API (staff.spec.ts — POST wake, paused staff rejected); needs browser E2E for wake button UI flow

---

## ST-07: Pause and resume a staff agent

**Preconditions:** A staff agent "Cron Bot" exists with state **active**. Navigate to `#/staff`, open the edit view.

**Steps and expectations:**
1. The edit view shows a Pause button (since current state is active).
   - No Resume button is visible.
2. Click Pause.
   - `PUT /api/staff/:id` fires with state update to **paused**.
   - The state badge in the staff list changes from green (**active**) to yellow (**paused**).
   - The Pause button is replaced by a Resume button.
   - In the sidebar, "Cron Bot" remains visible (paused agents are not filtered out, only retired ones are).
3. Click Resume.
   - `PUT /api/staff/:id` fires with state update to **active**.
   - The state badge changes back to green (**active**).
   - The Resume button is replaced by a Pause button.
4. Verify triggers are suspended while paused:
   - While "Cron Bot" is paused, configured triggers do not fire (agent is not woken automatically).
   - After resuming, triggers are re-enabled and fire on schedule.

**Coverage:** API (staff.spec.ts — paused staff cannot be woken); needs browser E2E for pause/resume toggle UI

---

## ST-08: Staff triggers display and configuration

**Preconditions:** Navigate to `#/staff`, open the edit view for a staff agent.

**Steps and expectations:**
1. The edit form includes a triggers configuration section.
   - Triggers can be configured for cron schedules and/or git events.
2. Configure a cron trigger with expression `0 9 * * 1` (every Monday at 9am).
   - The triggers config field accepts the expression.
3. Save the staff agent.
   - In the staff list table, the Triggers column shows "Cron: 0 9 * * 1".
4. Configure a git push trigger instead.
   - Save. The Triggers column shows "Git: push".
5. Remove all triggers and save.
   - The Triggers column shows "No triggers".
6. Configure both a cron trigger and a git trigger, then save.
   - The Triggers column shows a combined summary (e.g. "Cron: 0 9 * * 1" and "Git: push").

**Coverage:** API (staff.spec.ts — trigger ID auto-generation); needs browser E2E for trigger config UI
