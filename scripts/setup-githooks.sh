#!/bin/sh
# Opt in to this repo's committed git hooks (.githooks/).
#
# Currently just the graphify code-graph auto-refresh (post-merge,
# post-checkout on branch switch) — see docs/dev-workflow.md#code-graph-graphify.
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
