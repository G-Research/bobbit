# Settings — User Stories

The Settings page is the primary configuration surface for system-wide and per-project options. It covers keyboard shortcuts, models, maintenance, color palettes, config directories, and project-specific overrides. These stories cover every interactive element across all tabs and scopes.

---

## SET-01: Open settings via keyboard shortcut

**Preconditions:** App is loaded, any view active.

**Steps and expectations:**
1. Press Ctrl+, (Cmd+, on Mac).
   - The URL updates to `#/settings/system/shortcuts`.
   - The page heading reads "Settings" (`<h1>`).
   - The scope row shows a "System" button with active styling (`bg-background text-foreground shadow-sm border border-border`).
   - The Shortcuts tab is selected by default (first in the system tab list).
2. Press Ctrl+, again.
   - Settings view closes. Navigation returns to the previous route (e.g. session or dashboard).
3. Click the Settings button in the sidebar (with `title='Settings (Ctrl+,)'`).
   - Same result as step 1 — settings opens at `#/settings/system/shortcuts`.

**Coverage:** covered (settings.spec.ts — open settings and switch tabs)

---

## SET-02: Switch tabs with URL verification

**Preconditions:** Settings open at `#/settings/system/shortcuts`.

**Steps and expectations:**
1. Click the "General" tab button.
   - URL updates to `#/settings/system/general`.
   - The "Show message timestamps" checkbox is visible in the tab content.
   - The General tab button has active styling; Shortcuts does not.
2. Click the "Models" tab button.
   - URL updates to `#/settings/system/models`.
   - "Default Models" section is visible with Session, Review, and Naming model rows.
3. Click the "Config Directories" tab button.
   - URL updates to `#/settings/system/directories`.
   - Tab content shows directory configuration UI.
4. Click the "Color Palette" tab button.
   - URL updates to `#/settings/system/palette`.
   - A grid of palette cards appears (Forest, Ocean, Dusk, Ember, Rose, Slate, Sand, Teal, Copper, Mono).
   - The currently active palette card shows "Active" label and a highlighted border (`border-primary`).
5. Click the "Account" tab button.
   - URL updates to `#/settings/system/account`.
6. Click the "Maintenance" tab button.
   - URL updates to `#/settings/system/maintenance`.
   - Three section headings are visible: "Orphaned Worktrees", "Orphaned Sessions", "Expired Archives".
7. Navigate directly to `#/settings/system/models` via the browser address bar.
   - Settings open with the Models tab active. No extra clicks needed.
8. Navigate to `#/settings/system/nonexistent` (invalid tab ID).
   - Falls back to the first tab for the scope (Shortcuts for system scope).

**Coverage:** covered (settings.spec.ts — open settings and switch tabs)

---

## SET-03: Edit a general preference and verify persistence

**Preconditions:** Settings open at `#/settings/system/general`.

**Steps and expectations:**
1. Observe the "Show message timestamps" checkbox.
   - Checkbox is visible with its current state (checked or unchecked).
2. Toggle the checkbox (click it).
   - Checkbox state flips immediately in the UI.
   - A `PUT /api/preferences` request fires with the updated value.
   - Server responds 200.
3. Reload the page (F5).
   - App reloads. Navigate back to `#/settings/system/general`.
   - The "Show message timestamps" checkbox retains the state you set in step 2.
   - The preference was persisted server-side, not just in local state.
4. Toggle the checkbox back to its original state.
   - Another `PUT /api/preferences` fires. Preference is restored.

**Coverage:** covered (settings.spec.ts — setting persists after reload)

---

## SET-04: Project scope switching

**Preconditions:** At least one project is registered (e.g. "My Project").

**Steps and expectations:**
1. Open settings at `#/settings/system/general`.
   - Scope row shows "System" button (active) and one button per registered project (with colored dots).
2. Click the project button ("My Project") in the scope row.
   - URL updates to `#/settings/<projectId>/general`.
   - Tab bar changes to project tabs: General, Commands, Models, Config Directories, Appearance.
   - The "System" button loses active styling; the project button gains it.
3. Click the "Commands" tab.
   - URL updates to `#/settings/<projectId>/project`.
   - Tab content shows project command configuration (build, test, typecheck commands, etc.).
4. Click the "Appearance" tab.
   - URL updates to `#/settings/<projectId>/appearance`.
   - Tab content shows palette/color controls scoped to this project.
5. Click the "System" button in the scope row.
   - URL updates to `#/settings/system/shortcuts` (system scope, first system tab).
   - Tab bar reverts to system tabs: Shortcuts, General, Models, Config Directories, Color Palette, Account, Maintenance.
6. Navigate directly to `#/settings/<projectId>/appearance` via the address bar.
   - Settings open with the correct project scope and Appearance tab active.
   - The project button in the scope row has active styling.

**Coverage:** covered (settings.spec.ts — per-project settings scope switching)

---

## SET-05: Per-project config override and inheritance

**Preconditions:** A project is registered. Settings open at `#/settings/<projectId>/general`.

**Steps and expectations:**
1. Observe a config field (e.g. build command in Commands tab).
   - Field shows the resolved value. If inherited from system, the source badge shows "system".
   - If the project has its own override, the source badge shows the project name.
2. Enter a project-specific value in the field.
   - The input accepts the new value.
3. Click Save (or the form auto-saves on blur).
   - A `PUT /api/projects/<projectId>/config` request fires.
   - Server responds 200. Save status indicator shows "saved" briefly.
4. Navigate to another project's settings (or system settings) and back.
   - The project-specific value you set in step 2 is still present.
   - Other projects still show their own or inherited values — they are unaffected.
5. Reset the field (clear it or click a reset button if available).
   - The field reverts to the system-inherited value.
   - Source badge changes back to "system".

**Coverage:** partial (settings.spec.ts covers scope switching; API integration via project config REST endpoints)

---

## SET-06: Keyboard shortcut customization

**Preconditions:** Settings open at `#/settings/system/shortcuts`.

**Steps and expectations:**
1. Observe the shortcut list.
   - Shortcuts are grouped by category: Sessions, Navigation, Goals, UI.
   - Each row shows: label, current key binding(s) in monospace, and action buttons (remove, add, reset).
2. Click a binding button on a shortcut (e.g. the "Ctrl+N" badge on "New Session").
   - The badge enters rebind mode: `bg-primary/20 text-primary border-primary animate-pulse`.
   - Badge text changes to "Press a key combo...".
3. Press a new key combination (e.g. Ctrl+Shift+N).
   - If no conflict: the binding updates immediately. Badge shows the new combo.
   - Bindings are saved via `saveBindings()`.
4. Press a key combo that conflicts with another shortcut.
   - A destructive alert appears below the row: "'Ctrl+Shift+N' is already bound to 'Other Action'".
   - Two buttons: "Unbind & Assign" and "Cancel".
   - Click "Unbind & Assign" — the conflicting shortcut loses its binding, the new one is assigned.
5. Press a key combo reserved by the browser (e.g. Ctrl+T).
   - A yellow warning appears: "'Ctrl+T' may be intercepted by the browser."
   - Two buttons: "Assign Anyway" and "Cancel".
6. Press Escape during rebind mode.
   - Rebind is cancelled. Original binding is preserved.
7. Click the X button next to a binding.
   - That binding is removed. The shortcut may have zero bindings.
8. Click the "+" button to add an additional binding.
   - Rebind mode activates for a new (additional) binding slot.
   - After pressing a key combo, the shortcut now has two bindings.
9. Click the reset icon (↺) on a customized shortcut.
   - That shortcut reverts to its default binding(s).
10. Click "Reset All Defaults" at the bottom.
    - All shortcuts revert to factory defaults.
11. A tip box on the right reads: "When running Bobbit as a browser tab, some shortcut combinations are intercepted by the browser. Install Bobbit as a PWA app to regain complete control."

**Coverage:** covered (shortcuts are tested via the shortcut-registry; UI interaction via settings.spec.ts tab switching)

---

## SET-07: Color palette selection

**Preconditions:** Settings open at `#/settings/system/palette`.

**Steps and expectations:**
1. Observe the palette grid.
   - 10 palette cards displayed: Forest, Ocean, Dusk, Ember, Rose, Slate, Sand, Teal, Copper, Mono.
   - Each card has a miniature app preview showing sidebar, chat area, and input bar in that palette's colors.
   - The active palette card has `border-primary bg-primary/5 ring-1 ring-primary/30` and shows "Active" label.
2. Click a different palette card (e.g. "Ocean").
   - The entire app theme updates immediately — sidebar, background, text, borders all change.
   - `document.documentElement.dataset.palette` updates to "ocean".
   - `localStorage` stores the palette choice.
   - A `PUT /api/preferences` fires with `{ palette: "ocean" }`.
   - The Ocean card now shows "Active"; the previous card loses its highlight.
3. Reload the page.
   - The Ocean palette persists (restored from localStorage on page load, confirmed by server preference).
4. Select "Forest" (the default palette).
   - Theme reverts. `dataset.palette` is removed. `localStorage` item is removed.

**Coverage:** covered (settings.spec.ts — tab switching to palette; visual verification manual)

---

## SET-08: Models tab — default model configuration

**Preconditions:** Settings open at `#/settings/system/models`.

**Steps and expectations:**
1. Observe the "Default Models" section.
   - Three model rows: Session, Review, Naming.
   - Each row has: a model picker button (showing current model or "Auto (best available)"), a thinking level selector (Off/Minimal/Low/Medium/High), and a hint description.
2. Click the model picker button on the "Session" row.
   - A `ModelSelector` dialog opens showing available models grouped by provider.
   - The currently selected model (if any) is highlighted.
3. Select a model (e.g. "claude-sonnet-4-6").
   - Dialog closes. The Session row now shows the selected model name.
   - A `PUT /api/preferences` fires with `{ "default.sessionModel": "anthropic/claude-sonnet-4-6" }`.
4. Click the X button next to the model name.
   - Model resets to "Auto (best available)".
   - Preference is cleared (set to null).
5. Change the thinking level on the Session row from "Medium" to "High".
   - The dropdown updates. A `PUT /api/preferences` fires with `{ "default.sessionThinkingLevel": "high" }`.
6. Select a model that does not support reasoning.
   - The thinking level selector becomes disabled (`opacity-40 pointer-events-none`).
   - Title shows "Selected model does not support thinking".
7. Reload the page. Navigate back to `#/settings/system/models`.
   - All model and thinking selections persist as set.

**Coverage:** covered (model persistence tested in prompt-stats-e2e.spec.ts; models tab rendering in settings.spec.ts)

---

## SET-09: Maintenance — orphaned worktrees cleanup

**Preconditions:** Settings open at `#/settings/system/maintenance`.

**Steps and expectations:**
1. Observe the "Orphaned Worktrees" section.
   - A "Scan" button is visible and enabled.
   - The "Clean Up" action button is disabled (greyed out) — no scan has been performed yet.
2. Click "Scan".
   - A `GET /api/maintenance/orphaned-worktrees` request fires.
   - While loading, the UI may show a spinner or loading state.
3. Scan completes with no orphans found.
   - Message reads "No orphaned worktrees found".
   - "Clean Up" button remains disabled.
4. Scan completes with orphans found (e.g. 3 worktrees).
   - A list of orphaned worktree paths is displayed as a preview.
   - "Clean Up (3)" button becomes enabled with a count.
5. Click "Clean Up (3)".
   - A `POST /api/maintenance/cleanup-worktrees` request fires.
   - After cleanup, an automatic re-scan fires (`GET /api/maintenance/orphaned-worktrees`).
   - The list updates — either empty ("No orphaned worktrees found") or shows remaining items.

**Coverage:** covered (maintenance.spec.ts — scan buttons call API, action button state, cleanup POST)

---

## SET-10: Maintenance — orphaned sessions cleanup

**Preconditions:** Settings open at `#/settings/system/maintenance`.

**Steps and expectations:**
1. Observe the "Orphaned Sessions" section.
   - A "Scan" button is visible. The "Terminate" action button is disabled.
2. Click "Scan".
   - A `GET /api/maintenance/orphaned-sessions` request fires.
3. Scan completes with no orphans.
   - Message reads "No orphaned sessions found".
   - "Terminate" button remains disabled.
4. Scan completes with orphans found.
   - A list of orphaned sessions is displayed.
   - "Terminate (N)" button becomes enabled.
5. Click "Terminate (N)".
   - Orphaned sessions are removed. Re-scan fires automatically.

**Coverage:** covered (maintenance.spec.ts — scan buttons call API, action button state)

---

## SET-11: Maintenance — expired archives cleanup

**Preconditions:** Settings open at `#/settings/system/maintenance`.

**Steps and expectations:**
1. Observe the "Expired Archives" section.
   - A "Scan" button is visible. The "Purge" action button is disabled.
2. Click "Scan".
   - A `GET /api/maintenance/expired-archives` request fires.
3. Scan completes with no expired archives.
   - Message reads "No expired archives found".
   - "Purge" button remains disabled.
4. Scan completes with expired archives found.
   - A list of archived sessions past the retention period is displayed.
   - "Purge (N)" button becomes enabled.
5. Click "Purge (N)".
   - Expired archives are deleted. Re-scan fires automatically.

**Coverage:** covered (maintenance.spec.ts — scan buttons call API, action button state)

---

## SET-12: Maintenance scan state persists across tab switches

**Preconditions:** Settings open at `#/settings/system/maintenance`. A worktree scan has been performed.

**Steps and expectations:**
1. Scan orphaned worktrees — observe results (either "No orphaned worktrees found" or a list).
2. Switch to the "General" tab.
   - URL updates to `#/settings/system/general`. General tab content is visible.
3. Switch back to the "Maintenance" tab.
   - URL updates to `#/settings/system/maintenance`.
   - Previous scan results are still visible (module-level state persists across tab switches).
   - No need to re-scan — the results survive tab navigation.
4. Reload the page. Navigate back to `#/settings/system/maintenance`.
   - Scan results are gone (module-level state is cleared on reload).
   - Action buttons are disabled again. User must re-scan.

**Coverage:** covered (maintenance.spec.ts — scan state persists when switching tabs and back)

---

## SET-13: Config directories

**Preconditions:** A project is registered. Settings open at `#/settings/<projectId>/directories` (or `#/settings/system/directories` for system scope).

**Steps and expectations:**
1. Observe the Config Directories tab.
   - Displays a list of configured directories (or empty state if none).
   - Each directory entry enables discovery of skills, MCP servers, and agent configuration files from that path.
2. Add a new directory path.
   - Input accepts a filesystem path.
   - After saving, the directory appears in the list.
3. The directory is scoped to this project — other projects do not see it.
4. Remove a directory entry.
   - The entry disappears from the list.
   - Skills and MCP servers from that directory are no longer discovered.
5. Navigate to system-scope Config Directories (`#/settings/system/directories`).
   - System-level directories apply to all projects that don't override them.

**Coverage:** API only (config directories tested via REST; UI rendering verified via tab switching)

---

## SET-14: Settings URL deep-linking and navigation

**Preconditions:** App is loaded.

**Steps and expectations:**
1. Navigate directly to `#/settings/system/palette` via the browser address bar.
   - Settings open with system scope active and Color Palette tab selected.
   - No intermediate navigation steps needed.
2. Navigate to `#/settings/<projectId>/models`.
   - Settings open with the project scope active and Models tab selected.
   - The project button in the scope row has active styling.
3. Navigate to `#/settings` (no scope or tab).
   - Defaults to `#/settings/system/shortcuts` (system scope, first tab).
4. Change a setting, then use the browser Back button.
   - Browser navigates to the previous route (e.g. a session or dashboard).
   - Settings close.
5. Use the browser Forward button.
   - Returns to the settings route with the correct scope and tab.
6. Bookmark a settings URL (e.g. `#/settings/system/maintenance`) and open it later.
   - Settings open directly at that tab — deep links are stable.

**Coverage:** covered (settings.spec.ts — URL verification on tab switch; routing.ts handles `#/settings/<scope>/<tab>`)
