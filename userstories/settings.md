# Settings User Stories

## SET-01: System settings
**Steps:** Click system gear icon.
**Expected:** Settings page opens with all tabs (General, Models, Shortcuts, Maintenance, etc.).
**Coverage:** covered.

## SET-02: Project settings
**Steps:** Click a project's gear icon.
**Expected:** Project-specific tabs only (Commands, Models, Config Directories, Appearance). Scope row shows System and per-project tabs.
**Coverage:** partial.

## SET-03: Edit system settings
**Steps:** Change a setting, save.
**Expected:** Setting saved. Affects all projects that don't have their own override.
**Coverage:** covered.

## SET-04: Project override
**Steps:** Set a project-level value, save.
**Expected:** Project value overrides the system default. Other projects unaffected.
**Coverage:** partial.

## SET-05: Orphaned worktrees cleanup
**Steps:** Maintenance tab → Scan → Clean Up.
**Expected:** Shows worktrees with no matching active session. Clean up removes them.
**Coverage:** covered.

## SET-06: Orphaned sessions cleanup
**Steps:** Same pattern as worktrees.
**Expected:** Shows non-interactive sessions with no tracking. Clean up removes them.
**Coverage:** covered.

## SET-07: Expired archives cleanup
**Steps:** Same pattern.
**Expected:** Shows archived sessions past the retention period. Purge removes them.
**Coverage:** covered.

## SET-08: Config directories
**Steps:** Config Directories tab, add a path.
**Expected:** Skills, MCP servers, and agent files discovered from the added directory. Scoped to this project only.
**Coverage:** API only.

## SET-09: Settings persist across navigation
**Steps:** Change a setting, navigate away, come back.
**Expected:** Setting still shows the saved value. Selected tab preserved in the URL.
**Coverage:** none.
