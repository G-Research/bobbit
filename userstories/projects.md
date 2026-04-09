# Projects User Stories

## PR-01: Add project (existing .bobbit)
**Action:** Click Add Project, enter/browse path, Continue.
**Expected:** POST /api/projects/detect. Path A: `.bobbit/` exists → auto-import, name from package.json or directory basename, project appears in sidebar.
**Coverage:** covered.

## PR-02: Add project (detection mode)
**Action:** Directory has content, no `.bobbit/`.
**Expected:** Path B: provisional project created (provisional:true), project assistant session opens with assistant type "project", sidebar shows "(setting up)" badge, auto-sends initial prompt with directory path, agent explores and calls propose_project, preview form appears. On Accept: POST /api/projects/:id/promote clears provisional flag, config written atomically via PUT /api/projects/:id/config, worktree pool initialized if git repo.
**Coverage:** covered (15 tests).

## PR-03: Add project (scaffolding)
**Action:** Empty directory.
**Expected:** Path C: assistant type "project-scaffolding", guides through tech stack, scaffolds, configures.
**Coverage:** partial.

## PR-04: Remove project
**Action:** Project settings → General → Danger Zone → Remove Project.
**Expected:** DELETE /api/projects/:id, worktree pool drained, unregistered from server, files on disk NOT deleted, hidden for default project (server CWD), navigates to system settings, sidebar refreshes.
**Coverage:** covered.

## PR-05: Project settings commands
**Action:** Gear icon → Commands & Sandbox tab.
**Expected:** Edit build_command, test_command, typecheck_command, test_unit_command, test_e2e_command, worktree_setup_command. Persisted to project.yaml via PUT /api/projects/:id/config. New sessions/goals use updated commands. GET /api/projects/:id/config/resolved shows {value, source} annotations.
**Coverage:** partial.

## PR-06: Project settings models
**Action:** Models tab.
**Expected:** Project-specific model preferences. New sessions use project models, other projects use system defaults.
**Coverage:** API only.

## PR-07: Project settings appearance
**Action:** Appearance tab.
**Expected:** Palette picker (10 built-in palettes), dual accent color inputs (colorLight/colorDark). Project sessions use selected palette. data-palette attribute set on root. Palette applied on session connect (twice: immediately and after refreshSessions for recently-spawned sessions).
**Coverage:** partial.

## PR-08: Browse directory
**Action:** Add Project dialog, click Browse.
**Expected:** GET /api/browse?path=<dir> returns directory listing, navigate up/down, select populates input.
**Coverage:** covered.

## PR-09: Multi-project sidebar
**Action:** Multiple projects registered.
**Expected:** Project headers with name+palette color. Collapse/expand per project (localStorage `bobbit-collapsed-ungrouped`). Gear icon navigates to #/settings/<projectId>/project. Add Goal and Add Staff scoped to project. Sessions and goals grouped under projects.
**Coverage:** covered.

## PR-10: Provisional cleanup
**Action:** Terminate assistant without accepting.
**Expected:** Provisional project deleted via DELETE /api/projects/:id, sidebar updated, no orphaned state.
**Coverage:** covered.
