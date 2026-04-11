# Config Cascade — User Stories

The config cascade resolves configuration items (roles, personalities, workflows, tools) across three layers: builtin → server → project. Most-specific wins. These stories cover scope switching, origin badges, inherited-item dimming, customize/revert flows, and downstream effects on sessions and goals.

**Config pages using cascade:** Roles (`#/roles`), Personalities (`#/personalities`), Workflows (`#/workflows`), Tools (`#/tools`).

**Key source files:** `src/app/config-scope.ts` (scope row, origin badges, customize/revert API helpers), `src/server/config-cascade.ts` (resolution logic), `src/server/builtin-config.ts` (builtin layer).

**Existing tests:** `tests/e2e/config-cascade-api.spec.ts` (API), `tests/e2e/ui/config-scope.spec.ts` (browser).

---

## CC-01: Three-layer resolution display

**Preconditions:** A builtin role "coder" exists. A server-level override of "coder" exists. A project-level override of "coder" exists. At least one project is registered.

**Steps and expectations:**
1. Navigate to `#/roles`. Click the "System" scope button.
   - System button has active styling: `bg-background text-foreground shadow-sm border border-border`.
   - The "coder" role row shows a blue origin badge (`config-origin-server`) because server overrides builtin at system scope.
   - Badge text reads "server". Next to it: `overrides builtin` text (rendered by `config-origin-overrides` span).
2. Click the project scope button (the button with the colored dot and project name).
   - Project button gains active styling. System button reverts to `text-muted-foreground hover:text-foreground hover:bg-secondary/50`.
   - The "coder" role row now shows a green origin badge (`config-origin-project`).
   - Badge text reads "project". Next to it: `overrides server` text.
3. The item is NOT dimmed in project scope (it is locally defined).
   - `isInherited()` returns `false` when origin is `"project"` and scope is a project.
4. Switch back to System scope.
   - The "coder" row shows the server badge again. No project badge is visible — project overrides do not leak into system scope.

**Coverage:** covered (config-cascade-api.spec.ts, config-scope.spec.ts)

---

## CC-02: Scope switching shows correct items per scope

**Preconditions:** Two projects registered (Project A and Project B). Project A has a custom personality "formal". Project B does not.

**Steps and expectations:**
1. Navigate to `#/personalities`. The scope row appears (because projects exist).
   - Scope row is a horizontal bar with "System" button + one button per project, each with a colored dot (`w-2 h-2 rounded-full`).
   - Buttons overflow horizontally with `overflow-x: auto; scrollbar-width: thin`.
2. Click the Project A scope button.
   - "formal" personality appears with a green badge (`config-origin-project`). It is not dimmed.
   - Builtin personalities appear dimmed (inherited — `isInherited()` returns `true` for origin `"builtin"` or `"server"` in project scope).
3. Click the Project B scope button.
   - "formal" personality does NOT appear (it is not defined at builtin, server, or Project B level).
   - No stale "formal" row lingers from Project A's view.
   - Builtin personalities still appear, dimmed, with grey badges (`bg-muted text-muted-foreground`).
4. Click "System" scope button.
   - Only builtin and server-level personalities appear.
   - No project-specific items from either project are shown.
5. Rapidly click between Project A → System → Project B.
   - Each click fully replaces the item list. No flicker of stale data between transitions.

**Coverage:** covered (config-scope.spec.ts)

---

## CC-03: Origin badges display correct colors and override text

**Preconditions:** Active session. Roles page open. Items exist at all three layers.

**Steps and expectations:**
1. In System scope, find a role with origin `"builtin"` (e.g. a default role with no server override).
   - Badge has classes `bg-muted text-muted-foreground` (grey).
   - Badge text reads "builtin".
   - No "overrides" text next to it (nothing to override).
2. Find a role with origin `"server"` that overrides a builtin.
   - Badge has class `config-origin-server` (blue).
   - Badge text reads "server".
   - Adjacent span with class `config-origin-overrides` reads "overrides builtin".
3. Switch to a project scope. Find a role with origin `"project"` that overrides a server-level role.
   - Badge has class `config-origin-project` (green).
   - Badge text reads "project".
   - Overrides text reads "overrides server".
4. Find a role with origin `"project"` that overrides a builtin directly (no server layer).
   - Badge is green. Overrides text reads "overrides builtin".
5. Inherited items (origin is `"builtin"` or `"server"` in project scope) appear visually dimmed compared to locally-defined project items.

**Coverage:** covered (config-scope.spec.ts)

---

## CC-04: Customize an inherited item

**Preconditions:** Project scope selected. A builtin personality "concise" is visible, dimmed, with a grey "builtin" badge. A "Customize" button is available on the row.

**Steps and expectations:**
1. Click "Customize" on the "concise" personality row.
   - A `POST /api/personalities/concise/customize?scope=project&projectId=<id>` request fires.
   - The item list reloads.
2. After reload:
   - "concise" row is no longer dimmed — it is now a local project override.
   - Origin badge changes from grey "builtin" (`bg-muted text-muted-foreground`) to green "project" (`config-origin-project`).
   - "overrides builtin" text appears next to the badge.
   - A "Revert" button (or equivalent undo action) appears on the row.
3. Open the item for editing.
   - Form fields are pre-populated with the inherited values (copied from builtin).
   - User can modify the prompt fragment, label, or other fields.
4. Save changes.
   - Green badge persists. Item remains non-dimmed.
   - The modified values are served when this project's sessions resolve the "concise" personality.

**Coverage:** partial (config-cascade-api.spec.ts covers API; config-scope.spec.ts covers badge update)

---

## CC-05: Revert a project override

**Preconditions:** Project scope selected. A project-level override of "concise" personality exists (green badge, not dimmed, "Revert" button visible).

**Steps and expectations:**
1. Click "Revert" on the "concise" personality row.
   - A `DELETE /api/personalities/concise/override?scope=project&projectId=<id>` request fires.
   - The item list reloads.
2. After reload:
   - "concise" row reverts to dimmed (inherited) appearance.
   - Origin badge changes from green "project" (`config-origin-project`) back to grey "builtin" (`bg-muted text-muted-foreground`).
   - "overrides builtin" text disappears.
   - "Revert" button is gone. "Customize" button reappears.
3. Switch to System scope and back to the project scope.
   - "concise" still shows as inherited/dimmed — the revert persisted, it is not just a UI state change.
4. The project-level override file on disk is deleted (`.bobbit/config/personalities/concise.yaml` is removed for this project).

**Coverage:** partial (config-cascade-api.spec.ts covers API; config-scope.spec.ts covers badge revert)

---

## CC-06: Cascade affects new sessions

**Preconditions:** Project "Alpha" has a project-level role override for "coder" with a custom system prompt containing "You are a specialized Alpha coder".

**Steps and expectations:**
1. Create a new session in project "Alpha".
   - Session setup resolves the "coder" role via `ConfigCascade.resolveRoles()`.
   - The project-level override wins over builtin and server layers.
2. The agent's system prompt includes "You are a specialized Alpha coder" (the project override content).
   - This can be verified via the session's resolved config or agent behavior.
3. Create a new session in a different project "Beta" (no role overrides).
   - The "coder" role resolves to the builtin (or server) version — not Alpha's override.
   - Alpha's custom prompt does NOT leak into Beta's sessions.
4. Remove the project override for "coder" in Alpha (revert). Create another session in Alpha.
   - The new session uses the builtin/server "coder" role again.
   - Previously created sessions are unaffected (they captured the config at creation time).

**Coverage:** none (needs E2E test verifying session config resolution per project)

---

## CC-07: Cascade affects goal creation

**Preconditions:** Project "Alpha" has a project-level workflow override for "feature" with an additional gate "security-review".

**Steps and expectations:**
1. Create a new goal in project "Alpha" using the "feature" workflow.
   - Goal creation resolves the workflow via `ConfigCascade.resolveWorkflows()`.
   - The project-level "feature" workflow (with the extra "security-review" gate) is used.
2. The goal's gate list includes "security-review" in addition to the standard gates.
   - Verify via `GET /api/goals/:id` — gates array includes the custom gate.
3. Create a goal in project "Beta" using the same "feature" workflow name.
   - Beta has no workflow override, so the builtin/server "feature" workflow is used.
   - The "security-review" gate does NOT appear in Beta's goal gates.
4. The workflow override badge in Alpha's `#/workflows` page shows green "project" for "feature".
   - In Beta's scope, "feature" shows as inherited (dimmed, grey/blue badge).

**Coverage:** none (needs E2E test verifying goal gate resolution per project)

---

## CC-08: No stale data on rapid scope switching

**Preconditions:** Two projects registered. Network latency is present (or simulated). Config pages load items via async API calls.

**Steps and expectations:**
1. Navigate to `#/roles`. Click Project A scope button.
   - API call fires: `GET /api/roles?projectId=<A>`.
   - Items render for Project A.
2. Immediately click Project B scope button before Project A's response completes (or just after).
   - API call fires: `GET /api/roles?projectId=<B>`.
3. When both responses arrive:
   - Only Project B's items are displayed (the most recent scope selection wins).
   - No Project A items flash or intermix with Project B items.
4. Click "System" immediately after.
   - System-scoped items render. No project-specific items linger.
5. The scope row correctly highlights only the last-clicked button at all times.
   - Active button: `bg-background text-foreground shadow-sm border border-border`.
   - All others: `text-muted-foreground hover:text-foreground hover:bg-secondary/50`.
6. If the scope row has many projects (5+), the row scrolls horizontally.
   - `overflow-x: auto` and `scrollbar-width: thin` allow horizontal scrolling without breaking layout.
   - All project buttons remain clickable.

**Coverage:** partial (config-scope.spec.ts covers basic switching; race condition edge case needs targeted test)
