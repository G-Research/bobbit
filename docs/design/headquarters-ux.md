# Headquarters UX guidance

Status: design artifact for `goal/dae9130e`  
Scope: sidebar, project lists, project pickers, settings, and config-scope UI only.

## Core model

Headquarters is the user-facing name for Bobbit's server-level workspace.

- Display name: **Headquarters**.
- Stable project id: `headquarters`.
- Root/default cwd: the physical Headquarters directory (`BOBBIT_DIR`, legacy `BOBBIT_PI_DIR`, or `<server-run-dir>/.bobbit/headquarters`).
- Icon: Lucide `TowerControl` everywhere a normal project would use the folder/project icon.
- Mental model: **server-level == Headquarters**. Do not show both "System" and "Headquarters" as separate user-facing scopes.
- Existing hidden `system` persistence may continue internally, but the UI should not expose it as a second global scope.

Use this language consistently:

| Concept | User-facing label | Avoid |
|---|---|---|
| Server/global config scope | Headquarters | System, Global, Server project |
| Normal registered project | Project | Workspace, repo when not exact |
| Headquarters visibility setting | Show Headquarters in project lists | Delete, archive, disable Headquarters |
| Inheritance source | Inherited from Headquarters | Inherited from system/server |

### Storage invariant exception: live server secrets

Except for the live secrets below, all server-level state lives under the physical Headquarters directory (`state/` and `config/`): preferences, project registry, proposals, preview/runtime state, hidden `system` compatibility data, and Headquarters sessions/goals/staff. Normal projects, including a same-root project at the server run directory, keep their own `<project-root>/.bobbit/state` and `<project-root>/.bobbit/config`.

Live server secrets are the explicit exception. The admin bearer `token`, TLS material (`tls/`), and sandbox-agent auth (`sandbox-agent-auth/`) live in `serverSecretsDir()`, outside any project root. `BOBBIT_SECRETS_DIR` overrides that directory.

This prevents same-root privilege escalation: if the token lived under `<server-run-dir>/.bobbit/headquarters`, a normal project agent whose cwd is `<server-run-dir>` could read it and gain gateway-wide API access. Migration relocates pre-existing reachable secrets into `serverSecretsDir()` and fails closed if it cannot prove the secret was copied and removed safely.

## Icon placement

Use `TowerControl` for Headquarters in every project identity slot:

- Sidebar project header, desktop and mobile.
- Collapsed/sidebar compact project affordance if present.
- Splash Quick Session project picker.
- Shared `<project-picker-popover>` rows.
- Settings scope row.
- Config scope rows on Roles, Tools, Skills, Marketplace/config pages, and any workflow scope row if Headquarters appears there.
- Session/staff/goal creation pickers that list projects.

Match existing icon sizing exactly:

| Surface | Existing project icon | Headquarters icon |
|---|---|---|
| Desktop sidebar project header | `FolderOpen`, `xs` | `TowerControl`, `xs` |
| Mobile sidebar project header | `FolderOpen`, `sm` | `TowerControl`, `sm` |
| Splash picker row | `FolderOpen`, `sm` | `TowerControl`, `sm` |
| Project picker popover | accent dot/folder surrogate | `TowerControl`, `sm` or same row height |
| Settings/config scope pill | color dot | `TowerControl`, `xs` |

Do not render the normal project color dot for Headquarters. Let the icon carry the identity. Use the same color treatment as the project label in that surface, normally `var(--primary)` when active and `var(--muted-foreground)` or inherited text color when inactive.

## Sidebar behavior

### First run: Headquarters only

A fresh server should feel ready, not blocked.

- The sidebar shows a **Headquarters** project section by default.
- The section is expanded on first run.
- The header uses `TowerControl`, not `FolderOpen`.
- The top-level **New Goal** action is enabled only if Headquarters goal support is confirmed for the current git/no-git state. If not confirmed, gate it with clear copy instead of falling through to a late error.
- **Add Project** remains available as a secondary action below the list.
- No "No projects configured" empty state should appear while Headquarters is visible.

Recommended empty content inside Headquarters:

> No goals or sessions yet. Start a Quick Session in Headquarters or add a project when you want repo-specific work.

### Project header actions

Headquarters keeps the familiar project-section affordances but removes destructive normal-project actions.

Show:

- Expand/collapse.
- Settings shortcut.
- New session under the Sessions subsection.
- New staff under the Staff subsection.
- New goal if supported, or a disabled affordance with no-git guidance.

Do not show:

- Project reorder handle.
- Delete/remove/archive project actions.
- Add-project preflight/archive actions for the server run directory.

### Adding another project

When another project is added:

1. Headquarters remains first in the sidebar.
2. Add a subtle divider before user projects if it helps scanability.
3. User projects keep normal folder icons, palette colors, reordering, and project settings.
4. Quick Session now opens a project picker because there is more than one visible target.

Do not let user project reordering move Headquarters. It is an anchored server workspace, not a sortable project.

## Quick Session behavior

### Only Headquarters visible

The splash primary CTA should be **Quick Session**, not **New Project**.

Click behavior:

- Create a regular session with `projectId: "headquarters"`.
- Use the Headquarters root as `cwd`.
- Skip the project picker.
- Keep **Add Project** as the secondary route for repo onboarding.

Suggested splash copy:

> Start in Headquarters to configure Bobbit, coordinate work, or explore the server workspace.

### Headquarters plus projects

The picker title remains:

> New session in…

Rows:

1. Headquarters, `TowerControl`, optional helper text `Server workspace`.
2. User projects, normal folder/project styling.

Search should match `Headquarters`, `server`, and `workspace` for the Headquarters row.

### Headquarters hidden and no user projects

Do not dead-end the user.

Show an empty state that acknowledges the preference:

> Headquarters is hidden from project lists.

Actions:

- Primary: **Quick Session in Headquarters**.
- Secondary: **Show Headquarters**.
- Tertiary/link: **Add Project**.

This fallback is not a normal project list row; it is an escape hatch so the hidden built-in workspace remains usable.

## Project picker and project lists

Rules:

- If Headquarters is visible and it is the only visible project, skip pickers.
- If Headquarters is visible with other projects, list it first.
- If Headquarters is hidden, omit it from normal project pickers and normal project lists.
- Never show the internal `system` project.
- Never show both `System` and `Headquarters` in the same picker.

For picker row layout, reuse existing row height, padding, hover, active, focus, and keyboard behavior. Only swap the identity glyph and optional helper text.

Suggested Headquarters row:

```text
[TowerControl] Headquarters
               Server workspace
```

Use helper text only in roomy picker/list surfaces. In dense sidebar headers, the label alone is enough.

## Hide/show Headquarters control

Place the persistent control in **Settings → Headquarters/General → Appearance** or the existing system **Settings → General → Appearance** section after the sidebar appearance controls. It should use the same checkbox primitive as nearby preferences.

Label:

> Show Headquarters in project lists

Help text:

> Displays Headquarters in the sidebar, project pickers, and project lists. Hiding it only removes the shortcut; Headquarters sessions, staff, goals, and server configuration are kept.

Default: checked.

When toggled off:

- Immediately remove Headquarters from normal project lists/sidebar/project pickers.
- Keep any active Headquarters session connected.
- Keep existing Headquarters sessions, staff, goals, config, and persisted state.
- Keep Headquarters visible in settings/config scope rows because it is the only server-level config scope.
- Show a short toast: `Headquarters hidden from project lists.`

When toggled on:

- Restore Headquarters to the anchored first position.
- Restore prior expanded/collapsed state if available; otherwise default expanded.
- Show a short toast: `Headquarters shown in project lists.`

If Headquarters has existing goals/staff/sessions when the user hides it, do not warn as if data will be deleted. The help text is enough; optional toast copy can be:

> Headquarters hidden. Existing work is still available and can be shown again from Settings.

## Settings and config-scope clarity

The settings/config UI is where duplicate-global-scope confusion is most likely. The rule is strict: **Headquarters replaces the user-facing System scope.**

### Settings scope row

Current pattern:

```text
System | Project A | Project B
```

Target pattern:

```text
[TowerControl] Headquarters | Project A | Project B
```

- The Headquarters tab opens server-level settings: shortcuts, general preferences, models, config directories, palette, account, maintenance.
- Do not add a separate `System` tab.
- If Headquarters is hidden from project lists, the Settings scope row still shows Headquarters because it is the server-level configuration entry point.
- Headquarters settings should not expose normal project removal/archive controls.
- If a workspace-root field is shown, make it read-only with copy: `Server run directory. Headquarters always uses this directory.`

### Roles, tools, skills, marketplace/config pages

Where a page currently exposes server-level config, relabel it as Headquarters.

Use:

- Scope tab: **Headquarters** with `TowerControl`.
- Origin badge text: **Headquarters** or tooltip `Server-level default inherited by projects`.
- Project override copy: `Customize for this project` and `Revert to Headquarters`.

Avoid:

- `System` as a visible tab label.
- A `server` origin badge without explanation beside a Headquarters tab.
- A second global row named `Global`, `Server`, or `System`.

### Workflows

Workflows must not introduce a duplicate global scope.

- If workflows remain project-scoped, show Headquarters once as the Headquarters workspace when it is a valid workflow owner; otherwise show only project workflow scopes and explain that global defaults live under Headquarters config.
- If server-level workflows are introduced later, the user-facing scope name is still Headquarters.
- Empty copy should not say `No projects yet` when Headquarters exists. Use: `No workflow scopes yet` or `No workflows in this scope` depending on the actual state.

## Staff affordances

Headquarters must support staff flows when it is the only visible project.

- **New Staff** from the sidebar should create the staff assistant in Headquarters directly; do not bounce to Add Project.
- Staff rows appear under the Headquarters Staff subsection while Headquarters is visible.
- Staff creation pickers skip when Headquarters is the only visible target.
- If Headquarters is hidden, existing Headquarters staff are not deleted. They remain resolvable by route/search/inbox, and showing Headquarters restores normal sidebar management.

Suggested empty Staff copy under Headquarters:

> Create staff in Headquarters for server-level coordination, maintenance, and cross-project orchestration.

## Goal affordances and no-git behavior

Do not promise full Headquarters goals until the no-git path is verified.

### If Headquarters goals are supported

- **New Goal** is enabled for Headquarters.
- Goal creation uses `projectId: "headquarters"` and the Headquarters root.
- Goal dashboard/status should omit branch, worktree, and merge actions when no worktree exists.
- Use explicit no-git copy where needed:

> This Headquarters goal runs in the Headquarters directory without a git worktree. Git branch and merge actions are unavailable.

### If Headquarters goals are not fully supported

- Disable New Goal for Headquarters when the run directory has no supported git/worktree setup.
- Tooltip/button copy:

> Headquarters goals need git support before they can be created here.

- Dialog/banner copy:

> Goal creation for Headquarters is unavailable on this server because the Headquarters directory is not a supported git repository. Add a project for repo-backed goals, or start a Quick Session in Headquarters.

Do not allow a goal flow to proceed and fail late with branch/worktree/merge errors.

## Cross-project orchestration cues

Headquarters is the right place to coordinate across registered projects.

Surface this in empty states and session starters, not as a new heavy feature:

- Splash helper: `Use Headquarters to coordinate projects, manage server-level config, or start a general Bobbit session.`
- Staff helper: `Headquarters staff can coordinate across registered projects where tools and APIs permit it.`
- Session picker helper: `Server workspace`.

Avoid implying unrestricted filesystem or project access beyond existing tool/API permissions.

## Hidden-state expectations

Hidden means visually de-emphasized, not disabled.

| Surface | Headquarters visible | Headquarters hidden |
|---|---|---|
| Sidebar project list | First anchored section | Omitted from normal list |
| Project picker | First row | Omitted |
| Splash with no user projects | Quick Session in Headquarters | Empty-state fallback with Quick Session in Headquarters + Show Headquarters |
| Settings/config scopes | Shown as server scope | Still shown as server scope |
| Existing sessions/goals/staff | Listed under Headquarters | Preserved; active routes/search/inbox still resolve |
| API/internal resolution | `headquarters` works | `headquarters` still works |
| Add Project | Secondary action | Still available |

## Copy reference

| Situation | Copy |
|---|---|
| Sidebar header | `Headquarters` |
| Picker helper | `Server workspace` |
| First-run splash | `Start in Headquarters to configure Bobbit, coordinate work, or explore the server workspace.` |
| Hide setting label | `Show Headquarters in project lists` |
| Hide setting help | `Displays Headquarters in the sidebar, project pickers, and project lists. Hiding it only removes the shortcut; Headquarters sessions, staff, goals, and server configuration are kept.` |
| Hidden empty title | `Headquarters is hidden from project lists.` |
| Hidden fallback CTA | `Quick Session in Headquarters` |
| Show CTA | `Show Headquarters` |
| Config inheritance | `Inherited from Headquarters` |
| Revert override | `Revert to Headquarters` |
| No-git goal notice | `This Headquarters goal runs in the Headquarters directory without a git worktree. Git branch and merge actions are unavailable.` |

## Consistency rationale

This design intentionally reuses existing primitives:

- Sidebar project headers keep the current chevron, row height, typography, hover, active, and settings/new-goal affordances; Headquarters only swaps identity icon and removes reorder/destructive behavior.
- Project pickers keep current keyboard, search, row padding, hover, active, focus, Escape, and click-outside behavior.
- Settings uses the existing checkbox preference pattern: `w-4 h-4 rounded border-input accent-primary cursor-pointer`, label at `text-sm font-medium`, helper copy at `text-xs text-muted-foreground ml-6`.
- Config scope rows keep existing pill spacing and selected/inactive styles; `System` is relabeled to `Headquarters` and receives `TowerControl`.
- No new color palette is required. Use existing theme tokens and inherited project/scope state.

## UX verification scenarios

1. Fresh server with no user projects: Headquarters appears; splash **Quick Session** creates a Headquarters session without Add Project.
2. Fresh server: sidebar does not show `No projects configured` while Headquarters is visible.
3. TowerControl appears in sidebar, splash picker, shared project picker, Settings scope, and config scope rows.
4. Hide Headquarters: it disappears from normal project lists/pickers, active Headquarters work remains accessible, Settings/config still show Headquarters as server scope.
5. Show Headquarters: it returns as the first anchored sidebar section.
6. Add another project: Headquarters remains first; the new project uses normal folder styling; Quick Session picker lists Headquarters first.
7. Staff creation with only Headquarters visible creates a Headquarters staff assistant without Add Project.
8. Goal creation in Headquarters either works cleanly in no-worktree mode or is gated before creation with the no-git copy above.
9. Config pages never show both `System` and `Headquarters` as separate scopes.
