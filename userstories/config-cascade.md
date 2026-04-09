# Config Cascade User Stories

## CC-01: Three-layer resolution
**Action:** Builtin, server, and project overrides all exist for the same config item.
**Expected:** Project wins. Each item tagged with origin. Overrides field shows what it shadows. Generic resolve<T>() method shared across types.
**Coverage:** covered.

## CC-02: Cascade UI display
**Action:** Config page loaded.
**Expected:** Grey badge = builtin, blue badge = server, green badge = project. Inherited items at 70% opacity. Overridden items show overrides indicator.
**Coverage:** partial.

## CC-03: Customize action
**Action:** Click Customize on inherited item.
**Expected:** POST /api/<type>/:name/customize?scope=project&projectId=X copies resolved item to target scope. Form pre-populated. Origin changes. Opacity 100%. Revert button appears.
**Coverage:** partial.

## CC-04: Revert action
**Action:** Click Revert on overridden item.
**Expected:** DELETE /api/<type>/:name/override?scope=project&projectId=X. Reverts to inherited value. Badge and opacity update.
**Coverage:** partial.

## CC-05: Cascade affects sessions
**Action:** Role customized at project level, new session created.
**Expected:** Session setup pipeline uses ConfigCascade for role/tool resolution. Project override used for the session.
**Coverage:** none.

## CC-06: Cascade affects goal creation
**Action:** Workflow customized at project level, new goal created.
**Expected:** Goal creation resolves workflow via cascade. Gates match project override. Known bug path where builtin resolution broke.
**Coverage:** none.

## CC-07: Scope switching
**Action:** Multiple projects, switch scope tabs on config page.
**Expected:** Items update per scope. Badges change. No stale items. Scope reflected in URL.
**Coverage:** partial.
