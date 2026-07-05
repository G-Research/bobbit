#!/bin/sh
# Opt in to this repo's committed git hooks (.githooks/).
#
# Currently just the graphify code-graph auto-refresh (post-merge,
# post-checkout on branch switch, post-commit) — see
# docs/dev-workflow.md#code-graph-graphify.
#
# All three are guarded (via scripts/graphify-refresh.sh): they no-op unless
# this checkout already has src/graphify-out/graph.json — so `git worktree
# add` (which fires post-checkout) never kicks off a full graph build in a
# fresh lane worktree — and they coalesce concurrent triggers through a
# stale-lock-tolerant lock so a burst of git operations doesn't stack
# rebuilds.
#
# Run once per clone/worktree:
#
#   ./scripts/setup-githooks.sh
#
# Not run automatically (no postinstall) — this repoints git's hooksPath for
# the whole repo, which is a workflow decision, not a package-manager side
# effect. Undo with: git config --unset core.hooksPath

set -e
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
echo "core.hooksPath -> .githooks"
echo "(undo with: git config --unset core.hooksPath)"
