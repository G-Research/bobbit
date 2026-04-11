# Roles — User Stories

The Roles page (`#/roles`) manages agent roles — their system prompts, accessories, and per-tool access policies. Roles follow the config cascade (builtin → server → project) with origin badges, dimming, and customize/revert controls.

---

## RL-01: View roles list with origin badges and dimming

**Preconditions:** At least one project registered. Builtin roles exist (team-lead, coder, reviewer, test-engineer). No server or project overrides.

**Steps and expectations:**
1. Navigate to `#/roles`.
   - Page loads with a spinner, then shows a list of role rows.
   - Each row shows: an idle blob avatar (with accessory), label text, slug name, and an origin badge.
2. Inspect the builtin roles (e.g. "Team Lead", "Coder").
   - Each has a grey `builtin` origin badge.
   - All rows appear dimmed (`.config-item-inherited` styling — reduced opacity).
3. Each role row has an edit (pencil) icon button and a delete (trash) icon button on the right.
4. Click the "Coder" role row.
   - Navigates to the edit view for that role (breadcrumb shows "Roles / Coder").
5. Press the browser back button or click the "Roles" breadcrumb.
   - Returns to the list view. All roles still visible with correct badges.
6. Verify role count matches the known builtins (team-lead, coder, reviewer, test-engineer, plus assistant).
   - No duplicate entries. No missing entries.

**Edge cases:**
- If no roles exist at all (fresh install before scaffolding), the empty state shows: a centered idle blob, "No roles yet" title, description text, and a "Create your first role" button.
- If the API returns an error, roles list shows empty (no crash or unhandled error).

**Coverage:** partial — API tests confirm GET /api/roles returns expected roles. No browser E2E validates badge colors, dimming, or empty-state rendering.

---

## RL-02: Create a custom role

**Preconditions:** On `#/roles` list view.

**Steps and expectations:**
1. Click the "New Role" button in the nav bar.
   - A role assistant session is created (POST to `/api/sessions` with `assistantType: "role"`).
   - The UI navigates to the new assistant session.
2. Interact with the role assistant to define a new role (name: `doc-writer`, label: "Documentation Writer", prompt, accessory).
   - The assistant calls `propose_role` with the provided fields.
   - A proposal card renders in chat. Click "Accept".
3. Navigate back to `#/roles`.
   - "Documentation Writer" appears in the list with a green `project` origin badge (or blue `server` depending on scope).
   - The row is NOT dimmed (it is a direct-scope item, not inherited).
4. Click the new role to open its edit view.
   - Label field shows "Documentation Writer".
   - Prompt textarea shows the prompt defined during creation.
   - Accessory grid shows the selected accessory highlighted.
5. Navigate to `#/roles`. Click the delete (trash) button on the new role row.
   - A confirmation dialog appears: "Are you sure you want to delete 'Documentation Writer'? This cannot be undone."
   - Click "Delete". The role disappears from the list.

**Edge cases:**
- Role name validation: uppercase letters, spaces, and special characters are rejected by the API (400). Only lowercase alphanumeric with hyphens allowed.
- Duplicate names are rejected (400, "already exists").
- Missing name or label is rejected (400).

**Coverage:** partial (API only) — `roles-api.spec.ts` covers POST validation and creation. No browser E2E for the assistant flow or the proposal accept interaction.

---

## RL-03: Edit a role

**Preconditions:** A custom role `doc-writer` exists. On `#/roles` list view.

**Steps and expectations:**
1. Click the `doc-writer` role row (or its pencil icon).
   - Edit view opens. Breadcrumb shows "Roles / Documentation Writer".
   - Nav bar shows a "Delete" button (red) and a "Save" button (disabled — no changes yet).
2. Change the label from "Documentation Writer" to "Docs Author".
   - Save button enables (full opacity, clickable).
3. Click the "Tool Access" tab.
   - Tool groups appear in collapsible sections (all collapsed by default).
   - Each group header shows: group name, tool count, a "Group Policy" dropdown (default: "Use tool default"), and a system-default hint (e.g. "→ Allow [system default]").
4. Expand a group (e.g. "File System"). Set the group policy to "Ask".
   - All tools in the group show "→ Ask [from File System role override]" as their effective policy hint.
5. Override a single tool within the group (e.g. set `read` to "Allow").
   - That tool's hint updates to "→ Allow [role override]". Other tools in the group still show the group-level policy.
6. Click the "Prompt" tab. Edit the prompt text.
   - Save button remains enabled.
7. Select a different accessory from the grid (e.g. click "Glasses").
   - The accessory option highlights. Save button stays enabled.
8. Click "Save".
   - Button shows "Saving…" briefly, then returns to disabled (no unsaved changes).
   - Breadcrumb updates to show new label "Docs Author".
9. Navigate back to the list view.
   - The role row shows "Docs Author" as its label.
10. Reload the page. Navigate to `#/roles`.
    - "Docs Author" still appears with the updated label, confirming persistence.

**Edge cases:**
- Clicking Save with no changes: button stays disabled, nothing happens.
- Editing a builtin role directly (without customizing first): changes are saved as an override. Origin badge updates accordingly.

**Coverage:** partial (API only) — `roles-api.spec.ts` covers PUT for label, prompt, toolPolicies, and accessory. No browser E2E for the form interaction, tool access tab, or persistence across reload.

---

## RL-04: Delete a custom role

**Preconditions:** A custom role `doc-writer` exists. On its edit view.

**Steps and expectations:**
1. Click the "Delete" button in the nav bar.
   - A confirmation dialog appears: "Are you sure you want to delete 'Documentation Writer'? This cannot be undone."
2. Click "Cancel" (or press Escape).
   - Dialog closes. Role is still present. Edit view unchanged.
3. Click "Delete" again. This time, click "Delete" in the dialog to confirm.
   - Button shows "Deleting…". Role is removed.
   - View navigates back to the list. The role is gone from the list.
4. Navigate to `#/roles` and verify the role is no longer listed.

**Edge cases:**
- Attempting to delete a builtin role via the API: DELETE returns 200 but the builtin role remains accessible via the cascade (API test confirms this). The list still shows the builtin with its grey badge.
- Deleting a role from the list view (via the trash icon on the row): same confirmation dialog, same behavior.
- If deletion fails (network error), the role remains and the view stays on the edit page.

**Coverage:** partial (API only) — `roles-api.spec.ts` covers DELETE for custom roles and builtin cascade behavior. No browser E2E for the confirmation dialog or visual removal from the list.

---

## RL-05: Customize a builtin role (project override)

**Preconditions:** A project is registered and selected in the scope row. Builtin roles exist. No project overrides yet.

**Steps and expectations:**
1. Navigate to `#/roles`. Ensure the scope row shows the project selected (green project button active).
   - Builtin roles appear dimmed with grey `builtin` badges.
2. Click a builtin role (e.g. "Coder") to open its edit view.
   - Identity section shows a grey `builtin` badge and a "Customize for [Project Name]" button.
3. Click "Customize for [Project Name]".
   - The page reloads the role data. Origin badge changes to green `project`.
   - The "Customize" button is replaced by a "Revert to Inherited" button.
   - All fields become editable with the builtin values pre-filled.
4. Modify the prompt (e.g. append "Always use TypeScript."). Click Save.
   - Changes are saved as a project-level override.
5. Navigate back to the list.
   - "Coder" now shows a green `project` badge instead of grey `builtin`.
   - The row is no longer dimmed (it is a direct project-level item now).
6. Switch scope to "System" (click the System button in the scope row).
   - "Coder" reverts to grey `builtin` badge and dimmed styling (the project override is not visible at system scope).

**Edge cases:**
- At system scope, the button reads "Customize at Server Level" instead. Clicking it creates a server-level (blue) override.
- If the API call to customize fails, no badge change occurs and the button remains.

**Coverage:** partial — API customization is tested. No browser E2E validates the Customize button flow, badge transition, or dimming change.

---

## RL-06: Revert a project override

**Preconditions:** "Coder" has a project-level override (from RL-05). Project scope is selected.

**Steps and expectations:**
1. Navigate to `#/roles`. Click "Coder" to open its edit view.
   - Origin badge is green `project`. A "Revert to Inherited" button is visible.
2. Click "Revert to Inherited".
   - The role data reloads. Origin badge changes back to grey `builtin`.
   - The "Revert" button is replaced by "Customize for [Project Name]".
   - Prompt reverts to the original builtin text (the "Always use TypeScript." addition is gone).
3. Navigate back to the list.
   - "Coder" shows grey `builtin` badge again. Row is dimmed.
4. Verify that sessions in other projects were never affected by the override or revert.

**Edge cases:**
- Reverting a server-level override (at system scope): button reads "Revert to Builtin". After revert, the role falls back to builtin.
- If the revert removes the last local definition and no builtin exists (custom role created at project level), the role disappears from the list entirely and the view navigates to the list.

**Coverage:** partial (API only) — No browser E2E for the Revert button interaction, badge transition, or prompt revert verification.

---

## RL-07: Scope switching

**Preconditions:** Two projects registered (Project A and Project B). Project A has a project-level override for "Coder". Project B has no overrides.

**Steps and expectations:**
1. Navigate to `#/roles`.
   - The scope row appears with buttons: "System", "Project A", "Project B".
   - Currently selected scope is highlighted.
2. Click "Project A".
   - Role list reloads (loading spinner appears briefly).
   - "Coder" shows a green `project` badge (Project A's override). Row is not dimmed.
   - Other builtin roles show grey badges and are dimmed.
3. Click "Project B".
   - Role list reloads.
   - "Coder" shows a grey `builtin` badge. Row is dimmed (no override in Project B).
4. Click "System".
   - Role list reloads.
   - All roles show their system-level origin. Project overrides are not visible.
5. Switch rapidly between scopes (click Project A → Project B → System in quick succession).
   - Each switch triggers a reload. The final state reflects the last selected scope.
   - No stale data from a previous scope is shown.

**Edge cases:**
- With only one project registered, the scope row still shows "System" and the single project button.
- With no projects registered, scope row may show only "System".
- Scope selection persists across page navigation (leave `#/roles`, come back — same scope is active).

**Coverage:** none — No E2E test validates scope switching behavior, role list refresh, or badge updates across scopes.

---

## RL-08: Role used in session creation

**Preconditions:** A custom role `doc-writer` exists for the current project. On the session list / landing page.

**Steps and expectations:**
1. Create a new session (click "New Session" or equivalent).
   - The session creation flow includes a role picker or the session is created with a default role.
2. If a role picker is present, observe available options.
   - All roles for the current project are listed: builtins (coder, reviewer, test-engineer, team-lead) plus the custom `doc-writer`.
   - Each option shows the role label and accessory icon.
3. Select `doc-writer` and create the session.
   - The session is created with the `doc-writer` role.
   - The agent in this session uses `doc-writer`'s system prompt and tool policies.
4. In the session, ask the agent to identify its role.
   - The agent's behavior reflects the `doc-writer` prompt (e.g. it identifies as a documentation writer).
5. Create another session with the default "Coder" role.
   - The agent behaves differently, reflecting the coder prompt.

**Edge cases:**
- If a role is deleted after a session was created with it, existing sessions continue using the role's prompt (snapshot at creation time). New sessions cannot select the deleted role.
- Team agents spawned via `team_spawn` in a goal respect project-level role overrides — the spawned agent uses the overridden prompt, not the builtin default.

**Coverage:** none — No E2E test validates role picker in session creation, role selection effect, or team agent role cascade.
