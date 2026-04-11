# Personalities — User Stories

The personality manager page (`#/personalities`) lets users browse, create, edit, and delete personalities — prompt fragments that modify agent behavior. Personalities follow the config cascade (builtin → server → project) with scope switching, origin badges, and customize/revert overrides.

---

## P-01: View personalities list with origin badges

**Preconditions:** At least one project registered. Builtin seed personalities exist (10 defaults). No project-level overrides.

**Steps and expectations:**
1. Navigate to `#/personalities`.
   - Page shows "Personalities" heading with a "New Personality" button (Plus icon) in the nav bar.
   - A scope row appears below the nav: "System" button + one button per project (with colored dot).
   - "System" scope is active by default (`bg-background text-foreground shadow-sm border border-border`).
2. Observe the personality list.
   - Each row shows: label (primary text), name slug below it (muted), and description if present.
   - Each row has an origin badge: `builtin` (grey, `bg-muted text-muted-foreground`), `server` (`config-origin-server`), or `project` (`config-origin-project`).
   - All 10 seed personalities are listed.
   - Each row has a pencil (Edit) and trash (Delete) action button on the right.
3. Under System scope, builtin items appear dimmed (`config-item-inherited` class).
   - They are clickable but visually distinct from server-level overrides.
4. Click a personality row.
   - Edit view opens (see P-03). Breadcrumb shows "Personalities / {label}".
5. While loading, a spinner and "Loading personalities…" text are visible.
   - After data loads, the spinner is replaced by the list.
6. If all personalities are deleted (empty state):
   - "No personalities yet" message appears with a description and a "Create your first personality" button.

**Coverage:** API E2E (tests/e2e/personalities.spec.ts — GET returns 10 seeds). No browser E2E for list rendering, badges, or empty state.

---

## P-02: Create a new personality

**Preconditions:** On `#/personalities` list view.

**Steps and expectations:**
1. Click "New Personality" button in the nav bar.
   - View switches to create form. Breadcrumb: "Personalities / New Personality".
   - Nav shows a "Create" button (disabled until required fields are filled).
2. Fill in the "Name" field with `test-verbose`.
   - Name field is an editable input (only editable during creation, read-only on edit).
3. Fill in "Label" with `Verbose Explainer`.
   - "Create" button enables (both name and label are non-empty).
4. Fill in "Prompt Fragment" textarea with `Always explain your reasoning in detail before giving answers.`.
5. Fill in "Description" with `Makes agents more thorough in explanations`.
6. Click "Create".
   - Button text changes to "Creating…" and disables during save.
   - On success, view returns to the list.
   - `test-verbose` appears in the list with the label "Verbose Explainer" and origin badge matching the current scope.
7. Leave Name or Label empty and click Create.
   - Nothing happens. Save is blocked (both fields required).
8. Click the back arrow (ArrowLeft icon) without saving.
   - Returns to list. No personality is created.

**Coverage:** API E2E (tests/e2e/personalities.spec.ts — POST create). No browser E2E for form interaction.

---

## P-03: Edit an existing personality

**Preconditions:** At least one personality exists (e.g. a builtin or custom one). On `#/personalities` list view.

**Steps and expectations:**
1. Click the pencil icon on a personality row (or click the row itself).
   - Edit view opens. Breadcrumb: "Personalities / {label}".
   - Fields are pre-filled: Name (read-only), Label, Description, Prompt Fragment.
   - Origin badge is visible next to the section title.
   - Nav bar shows "Save" (disabled — no changes yet) and a red "Delete" button (Trash2 icon).
2. Change the Label from "Verbose Explainer" to "Very Verbose".
   - "Save" button enables (change detected via field comparison).
3. Modify the Prompt Fragment text.
   - "Save" remains enabled.
4. Click "Save".
   - Button text changes to "Saving…" and disables.
   - On success, the edit view refreshes with updated values.
   - Returning to the list shows the updated label.
5. Make no changes and click "Save".
   - "Save" is disabled. Nothing happens.
6. Click the back arrow without saving.
   - Returns to list. Unsaved edits are discarded.

**Coverage:** API E2E (tests/e2e/personalities.spec.ts — PUT update). No browser E2E for edit form interaction.

---

## P-04: Delete a personality

**Preconditions:** A custom personality exists (e.g. `test-verbose` from P-02).

**Steps and expectations:**
1. From the list view, click the trash icon on the `test-verbose` row.
   - A confirmation dialog appears: "Delete Personality — Are you sure you want to delete "Verbose Explainer"? This cannot be undone." with a destructive "Delete" button.
2. Click "Delete" in the dialog.
   - The personality is removed from the list immediately.
   - It is no longer returned by `GET /api/personalities`.
3. Alternatively, open the edit view for a personality and click the red "Delete" button in the nav.
   - Same confirmation dialog appears.
   - On confirm, personality is deleted and view returns to the list.
4. Click "Cancel" (or dismiss) the confirmation dialog.
   - Nothing is deleted. Edit view or list remains unchanged.
5. Attempt to delete a builtin personality under System scope.
   - Delete is available in the UI (trash icon), but the server may reject it if the item has no local override to remove.
6. Existing agents currently using this personality are unaffected — deletion only prevents future use.

**Coverage:** API E2E (tests/e2e/personalities.spec.ts — DELETE). No browser E2E for delete confirmation flow.

---

## P-05: Scope switching between System and project

**Preconditions:** Two projects registered (e.g. "ProjectA" and "ProjectB"). Builtin personalities exist.

**Steps and expectations:**
1. On `#/personalities`, observe the scope row.
   - "System" button is active (highlighted with shadow and border).
   - Project buttons are inactive (`text-muted-foreground hover:text-foreground hover:bg-secondary/50`).
   - Each project button has a colored dot (`w-2 h-2 rounded-full`) matching the project color.
2. Click "ProjectA".
   - "ProjectA" button becomes active (gets `bg-background text-foreground shadow-sm border border-border`).
   - "System" button becomes inactive.
   - List reloads with a loading spinner.
   - Personalities shown are scoped to ProjectA: builtin + server + project-level overrides for ProjectA.
   - Items not overridden at the project level appear dimmed (`config-item-inherited`).
3. Click "ProjectB".
   - List reloads showing ProjectB's scoped view.
   - ProjectA-specific overrides are not visible.
4. Click "System".
   - Returns to the system-wide view. All server-level and builtin personalities are shown.
5. Scope selection is preserved across list → edit → back navigation.
   - Edit a personality, go back to the list — scope stays on the previously selected project.
6. If no projects are registered, the scope row is hidden entirely.
   - Only the personality list is visible (no System/project toggle).

**Coverage:** No browser E2E for scope switching. API tests do not exercise scoped queries with projectId.

---

## P-06: Customize a builtin personality (project override)

**Preconditions:** A project scope is selected (e.g. "ProjectA"). A builtin personality (e.g. "concise") is visible in the list with a grey `builtin` badge and dimmed styling.

**Steps and expectations:**
1. Click the "concise" row to open the edit view.
   - Origin badge shows `builtin`.
   - A "Customize for ProjectA" button appears next to the badge.
   - Name field is read-only.
2. Click "Customize for ProjectA".
   - Server creates a project-level copy via `POST /api/personalities/concise/customize?scope=project&projectId=...`.
   - Edit view refreshes.
   - Origin badge changes from `builtin` to `project` (`config-origin-project`).
   - Fields are now editable for the project-level copy.
3. Modify the Prompt Fragment and click "Save".
   - Save succeeds. The override is persisted for ProjectA.
4. Switch scope to "System".
   - "concise" still shows as `builtin` (the system view is unaffected).
5. Switch scope to "ProjectB".
   - "concise" still shows as `builtin` (no override in ProjectB).
6. Switch back to "ProjectA".
   - "concise" shows as `project` with the customized prompt fragment.
7. Row is no longer dimmed — it is a local override.

**Coverage:** API E2E (tests/e2e/personalities.spec.ts — customize endpoint). No browser E2E for Customize button interaction.

---

## P-07: Revert a project override to inherited

**Preconditions:** A project-level override of "concise" exists for "ProjectA" (from P-06). Scope is set to "ProjectA".

**Steps and expectations:**
1. Click "concise" to open the edit view.
   - Origin badge shows `project`.
   - A "Revert to Inherited" button appears (styled with `config-action-btn--revert` class).
2. Click "Revert to Inherited".
   - Server deletes the project-level override via `DELETE /api/personalities/concise/override?scope=project&projectId=...`.
   - Edit view refreshes — or returns to the list if the personality is no longer locally present.
3. In the list, "concise" now shows the `builtin` badge again and is dimmed.
   - Prompt fragment is the original builtin value.
4. Under System scope, "concise" is unaffected (still shows `builtin` with original values).
5. Similarly, a server-level override can be reverted under System scope:
   - Open a personality with `server` origin badge.
   - Click "Revert to Builtin".
   - Badge reverts to `builtin`. Values restore to the builtin defaults.

**Coverage:** API E2E (tests/e2e/personalities.spec.ts — revert/delete override). No browser E2E for Revert button interaction.

---

## P-08: Personality applied to agent via selector

**Preconditions:** Active session. At least one personality exists (e.g. "concise"). Personality selector is visible in the session settings or context bar.

**Steps and expectations:**
1. Locate the personality selector in the session settings dialog.
   - Available personalities are shown as toggleable chips.
   - Currently applied personality (if any) is visually highlighted.
2. Click a personality chip (e.g. "concise").
   - Chip toggles to selected state.
   - The personality's prompt fragment will be appended to the agent's system prompt on the next message.
3. Click the same chip again.
   - Chip toggles off. Personality is removed.
4. Select multiple personalities.
   - Multiple chips are highlighted. Their prompt fragments combine.
5. Send a message after selecting a personality.
   - Agent response reflects the personality's influence (e.g. shorter responses for "concise").
6. Personality choice persists for the session (survives page reload).
   - Reload the page, navigate to the session — the same personality chips are still selected.
7. Personality resolution respects project-level overrides:
   - If "concise" has a project override with a different prompt fragment, the agent uses the project-level version.

**Coverage:** Browser E2E (tests/e2e/ui/personality-e2e.spec.ts — chip visibility and toggle). Unit (personality-selector.spec.ts — chip toggle, multi-select, visual state).
