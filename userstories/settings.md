# Settings User Stories

## SET-01: System settings
**Action:** Click system gear.
**Expected:** #/settings/system. All tabs visible (shortcuts, general, project, models, palette, directories, account, appearance, maintenance).
**Coverage:** covered.

## SET-02: Project settings
**Action:** Click project gear.
**Expected:** #/settings/<projectId>/project. Project-specific tabs only (Commands & Sandbox, Models, Config Directories, Appearance). Scope row shows System + per-project tabs.
**Coverage:** partial.

## SET-03: Edit system settings
**Action:** Modify setting, save.
**Expected:** Persisted, affects all projects without overrides.
**Coverage:** covered.

## SET-04: Per-project override
**Action:** Set project value, save, check resolved.
**Expected:** Project overrides system. GET /api/projects/:id/config/resolved shows {value, source:"project"}. Other projects unaffected.
**Coverage:** partial.

## SET-05: Maintenance orphaned worktrees
**Action:** Scan button → preview → Clean Up.
**Expected:** GET /api/maintenance/orphaned-worktrees lists worktrees with no matching session. POST /api/maintenance/cleanup-worktrees removes them.
**Coverage:** covered (7 tests).

## SET-06: Maintenance orphaned sessions
**Action:** Same pattern as worktrees.
**Expected:** Non-interactive sessions with no tracking listed, cleanup removes them.
**Coverage:** covered.

## SET-07: Maintenance expired archives
**Action:** Same pattern.
**Expected:** Archived sessions past retention period listed. POST /api/maintenance/purge-archives removes them.
**Coverage:** covered.

## SET-08: Config directories
**Action:** Config Directories tab.
**Expected:** config_directories in project.yaml. Per-project scoped. Affects skills, MCP servers, agent files discovery for that project's sessions only.
**Coverage:** API only.

## SET-09: Settings persist across navigation
**Action:** Change setting, save, navigate away, come back.
**Expected:** URL hash preserves scope+tab (#/settings/<scope>/<tab>). Changed values persist.
**Coverage:** none.
