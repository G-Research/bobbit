#!/bin/sh
# Opt in to this repo's committed git hooks (.githooks/).
#
# Currently just the graphify code-graph auto-refresh (post-merge,
# post-checkout on branch switch, post-commit) — see
# docs/dev-workflow.md#code-graph-graphify.
#
# All three are guarded (via scripts/graphify-refresh.sh): they only run in
# the PRIMARY checkout (git-dir == git-common-dir). Lane worktrees share the
# primary's graph via a symlink (src/graphify-out -> <primary>/src/graphify-out),
# so a refresh from a worktree — including the post-checkout fired by
# `git worktree add` — would rebuild the SHARED graph from worktree file
# state; the guard makes that a fast no-op instead. Concurrent triggers
# coalesce through a stale-lock-tolerant lock so a burst of git operations
# doesn't stack rebuilds.
#
# Run once per clone:
#
#   ./scripts/setup-githooks.sh
#
# Not run automatically (no postinstall) — this repoints git's hooksPath for
# the whole repo, which is a workflow decision, not a package-manager side
# effect. Note: plain `git config` here is shared across all worktrees of
# this repo; that is safe because the hooks self-guard to the primary.
# Undo with: git config --unset core.hooksPath

set -e
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
echo "core.hooksPath -> .githooks"
echo "(undo with: git config --unset core.hooksPath)"
