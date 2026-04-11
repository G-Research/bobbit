# Projects — User Stories

Adding, configuring, and managing projects. These stories cover the Add Project flow (three paths), project removal, per-project settings, the directory browser, multi-project sidebar layout, and provisional cleanup.

---

## PR-01: Add project (existing config)

**Preconditions:** A directory exists on disk that already contains a `.bobbit/` config folder (i.e. a previously configured project).

**Steps and expectations:**
1. Click "Add Project" in the sidebar.
   - The Add Project dialog opens with a path input field and a Browse button.
2. Enter (or paste) the absolute path to the directory with existing `.bobbit/` config.
   - The path input accepts the text.
3. Click Continue (or press Enter).
   - The dialog closes.
   - The project is auto-imported — no assistant session opens.
   - The project appears immediately in the sidebar with its detected name (from `project.yaml`).
   - No "(setting up)" badge is shown.
4. Click the project name in the sidebar.
   - The project's session list is visible. The project is fully functional.
5. Enter the same path again via Add Project → Continue.
   - The project is not duplicated. An error or no-op prevents re-adding.

**Coverage:** covered (add-project-flow.spec.ts)

---

## PR-02: Add project (detection)

**Preconditions:** A directory exists on disk with source files (e.g. `package.json`, `src/`) but no `.bobbit/` config folder.

**Steps and expectations:**
1. Click "Add Project" in the sidebar.
   - The Add Project dialog opens.
2. Enter the path to the directory without `.bobbit/` config. Click Continue.
   - A project assistant session opens automatically.
   - The sidebar shows the project with a "(setting up)" badge.
3. The assistant agent explores the directory structure.
   - The agent examines files, detects frameworks, languages, and build tools.
   - Chat messages stream as the agent works.
4. The agent proposes a configuration via a `propose_project` tool call.
   - A preview form appears in the chat showing editable fields (name, build command, test command, etc.).
   - Fields are pre-filled with the agent's detected values.
5. Review the proposed fields and click Accept.
   - Project is finalized — `.bobbit/` config directory is created with `project.yaml`.
   - The "(setting up)" badge disappears from the sidebar.
   - The project name updates to the finalized name.
   - Worktree pool is initialized for the project.
6. The project is now fully usable — new sessions and goals can be created under it.

**Coverage:** covered (project-assistant.spec.ts — 15 tests)

---

## PR-03: Add project (scaffolding)

**Preconditions:** An empty directory exists on disk (or a path to a directory that does not yet exist).

**Steps and expectations:**
1. Click "Add Project" in the sidebar.
   - The Add Project dialog opens.
2. Enter the path to the empty/nonexistent directory. Click Continue.
   - A scaffolding assistant session opens (distinct from the detection assistant).
   - The sidebar shows the project with a "(setting up)" badge.
3. The scaffolding assistant guides through tech stack selection.
   - The agent asks questions about language, framework, and project structure.
   - Chat messages stream as the conversation progresses.
4. After gathering requirements, the agent creates the project structure.
   - Files and directories are created on disk.
   - A `propose_project` tool call proposes the configuration.
5. Accept the proposed configuration.
   - `.bobbit/` config is written. The project finalizes in the sidebar.
   - The created files are visible in the project directory.
6. The project is ready for development — sessions and goals can be created.

**Coverage:** partial

---

## PR-04: Remove project

**Preconditions:** At least two projects registered (one is the default project).

**Steps and expectations:**
1. Open project settings for a non-default project (gear icon in sidebar, or Settings → project tab).
   - Settings panel opens showing the project's configuration tabs.
2. Navigate to the General (or Danger Zone) section.
   - A "Remove Project" button is visible, styled as a destructive action.
3. Click "Remove Project".
   - A confirmation prompt appears.
4. Confirm the removal.
   - The project disappears from the sidebar immediately.
   - The `DELETE /api/projects/:id` endpoint is called.
   - Files on disk are NOT deleted — only the registration is removed.
   - Sessions and goals associated with the project are no longer listed.
5. Navigate to the directory on disk.
   - The `.bobbit/` folder and all project files still exist.
6. Attempt to remove the default project.
   - The "Remove Project" button is disabled or not shown.
   - The default project cannot be removed.

**Coverage:** covered (project-removal.spec.ts)

---

## PR-05: Project commands

**Preconditions:** A project is registered and its settings are accessible.

**Steps and expectations:**
1. Open project settings → Commands tab.
   - Input fields for build, test, typecheck, unit test, and E2E test commands are visible.
   - Fields show current values (or placeholders if not set).
2. Enter a build command (e.g. `npm run build`).
   - The input accepts the text.
3. Enter a test command (e.g. `npm test`).
   - The input accepts the text.
4. Click Save (or the equivalent confirmation action).
   - A success indicator appears (toast or inline confirmation).
   - The commands are persisted to `project.yaml` via `PUT /api/projects/:id/config`.
5. Close settings and reopen them.
   - The saved commands are still present in the fields.
6. Create a new session or goal in this project.
   - The saved commands are available to the agent (visible in its system prompt or tool context).
7. Clear a command field and save.
   - The command is removed. Agents in new sessions no longer see it.

**Coverage:** partial

---

## PR-06: Project models

**Preconditions:** A project is registered. System-level model defaults are set.

**Steps and expectations:**
1. Open project settings → Models tab.
   - Model selection fields are visible (session model, review model, naming model).
   - Each field shows the current value or "System default" if not overridden.
2. Set a project-specific session model (e.g. select a different model from the dropdown).
   - The selection is accepted.
3. Click Save.
   - The model preference is persisted via `PUT /api/projects/:id/config`.
4. Create a new session in this project.
   - The session uses the project-specific model, not the system default.
5. Check a session in a different project.
   - That session still uses the system default (or its own project override). The change is scoped.
6. Clear the project model override (reset to "System default") and save.
   - New sessions in this project revert to the system-level default model.

**Coverage:** API only

---

## PR-07: Project appearance

**Preconditions:** A project is registered.

**Steps and expectations:**
1. Open project settings → Appearance tab.
   - Palette selector and accent color options are visible.
   - Current values reflect any previously saved settings (or defaults).
2. Select a different color palette.
   - The preview updates immediately to reflect the chosen palette.
3. Choose an accent color.
   - The accent color updates in the preview.
4. Save the appearance settings.
   - Settings are persisted via `PUT /api/projects/:id/config`.
5. Open a session in this project.
   - The session UI uses the selected palette and accent color.
6. Open a session in a different project.
   - That session uses its own appearance settings. The first project's theme does not leak.
7. Reset the appearance to defaults.
   - Sessions in this project revert to the system default theme.

**Coverage:** partial (settings.spec.ts — appearance tab)

---

## PR-08: Browse directory

**Preconditions:** The Add Project dialog is open.

**Steps and expectations:**
1. Click the Browse button in the Add Project dialog.
   - A directory browser overlay or panel opens, showing the real filesystem.
   - The browser starts at a sensible default location (e.g. home directory or last-used path).
2. Navigate into a subdirectory by clicking its name.
   - The browser shows the contents of the selected directory.
   - A breadcrumb or path indicator updates to reflect the current location.
3. Navigate back to the parent directory.
   - The parent directory's contents are shown.
4. Select a directory (click Select or double-click).
   - The directory browser closes.
   - The selected path fills the path input field in the Add Project dialog.
5. The path input now shows the absolute path to the chosen directory.
   - The user can proceed with Continue to add the project.
6. Open Browse again after a selection.
   - The browser remembers the last navigated location (or starts at the selected path).
7. Cancel the directory browser without selecting.
   - The browser closes. The path input remains unchanged (retains any previously entered value).

**Coverage:** covered (add-project-flow.spec.ts)

---

## PR-09: Multi-project sidebar

**Preconditions:** Two or more projects are registered (e.g. "Frontend" and "Backend").

**Steps and expectations:**
1. Observe the sidebar.
   - Each project has its own collapsible section.
   - Each section header shows the project name.
   - Sessions and goals are grouped under their respective project.
2. Click the collapse toggle on one project section.
   - That section collapses — its sessions and goals are hidden.
   - Other project sections remain expanded.
3. Click the collapse toggle again.
   - The section expands, showing its sessions and goals.
4. Locate the gear icon on a project section header.
   - Clicking the gear icon navigates to that project's settings.
5. Create a new session.
   - The session appears under the correct project section in the sidebar.
6. With only one project registered, the sidebar does not show per-project section headers.
   - Sessions are listed directly without a project grouping wrapper.
7. Add a second project.
   - The sidebar transitions to the multi-project layout with section headers for each project.

**Coverage:** covered (single-project-sidebar.spec.ts, project-management.spec.ts)

---

## PR-10: Provisional cleanup

**Preconditions:** Add Project was started for a detection path (PR-02), and the assistant session is active with a "(setting up)" badge in the sidebar.

**Steps and expectations:**
1. The project assistant session is open and the agent is proposing or has proposed configuration.
   - The provisional project is visible in the sidebar with the "(setting up)" badge.
2. Close the assistant session without accepting the proposal (e.g. click the X or navigate away and close).
   - The provisional project is deleted from the registry.
   - The sidebar no longer shows the project.
   - No `.bobbit/` config was written to disk (since the proposal was never accepted).
3. Confirm the sidebar is clean.
   - No orphaned entries remain. Only fully finalized projects are listed.
4. Attempt Add Project again with the same path.
   - The flow starts fresh — a new assistant session opens as if the project was never attempted.

**Coverage:** covered (project-assistant.spec.ts)
