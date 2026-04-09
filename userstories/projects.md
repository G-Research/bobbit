# Projects User Stories

## PR-01: Add project (existing config)
**Steps:** Click Add Project, enter path to a directory with existing `.bobbit/` config, click Continue.
**Expected:** Project auto-imported with detected name. Appears in sidebar immediately.
**Coverage:** covered.

## PR-02: Add project (detection)
**Steps:** Enter path to a directory with content but no `.bobbit/` config.
**Expected:** Project assistant session opens. Sidebar shows the project with a "(setting up)" badge. Agent explores the directory and proposes configuration. A preview form appears with editable fields. On Accept: project finalized, config saved, worktree pool initialized.
**Coverage:** covered (15 tests).

## PR-03: Add project (scaffolding)
**Steps:** Enter path to an empty or nonexistent directory.
**Expected:** Scaffolding assistant opens. Guides through tech stack selection. Creates project structure and configuration.
**Coverage:** partial.

## PR-04: Remove project
**Steps:** Project settings → Danger Zone → Remove Project.
**Expected:** Project removed from sidebar. Files on disk not deleted. Cannot remove the default project.
**Coverage:** covered.

## PR-05: Project commands
**Steps:** Project settings → Commands tab, edit build/test/typecheck commands, save.
**Expected:** Commands saved. Used by new sessions and goals in this project.
**Coverage:** partial.

## PR-06: Project models
**Steps:** Project settings → Models tab, set model preferences.
**Expected:** Project-specific model preferences applied. Override system defaults for this project only.
**Coverage:** API only.

## PR-07: Project appearance
**Steps:** Project settings → Appearance tab.
**Expected:** Choose a palette and accent colors. Sessions in this project use the selected theme. Other projects unaffected.
**Coverage:** partial.

## PR-08: Browse directory
**Steps:** In Add Project dialog, click Browse.
**Expected:** Directory browser shows the real filesystem. Can navigate folders. Selection fills the path input.
**Coverage:** covered.

## PR-09: Multi-project sidebar
**Pre:** Multiple projects registered.
**Expected:** Each project has its own section with sessions and goals grouped underneath. Collapse/expand per project. Gear icon navigates to that project's settings.
**Coverage:** covered.

## PR-10: Provisional cleanup
**Steps:** Close the project assistant session without accepting the proposal.
**Expected:** Provisional project deleted. Sidebar cleaned up.
**Coverage:** covered.
