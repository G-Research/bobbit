#!/usr/bin/env bash
# Refresh the shared graphify graph without blocking git operations.
#
# Shared by .githooks/post-merge, .githooks/post-checkout (branch switches),
# .githooks/post-commit, and `npm run graph:refresh`
# (see docs/dev-workflow.md#code-graph-graphify).
#
# Guarded by design:
#   - no-ops silently if `graphify` isn't on PATH (other machines/CI unaffected)
#   - `--hook` (used by the git hooks) only refreshes a checkout that ALREADY
#     has src/graphify-out/graph.json. A fresh `git worktree add` has none, so
#     this is a fast, side-effect-free no-op there — it must NEVER trigger a
#     full graph build per worktree (we routinely run 10+ concurrent lane
#     worktrees; a full build per worktree would be a machine-wide hazard).
#   - `--force` (used by `npm run graph:refresh`) always refreshes, building
#     the graph from scratch if it doesn't exist yet.
#   - a mkdir-based lock under src/graphify-out/ means back-to-back git
#     operations (e.g. a burst of merges) coalesce instead of stacking
#     concurrent rebuilds. A lock older than $STALE_LOCK_SECONDS is treated as
#     abandoned (the owning process crashed/was killed without cleanup) and
#     reclaimed, rather than blocking refreshes forever.
#   - runs detached in the background at low `nice` priority so the calling
#     git command (or `npm run graph:refresh`) never blocks on the rebuild.
#   - logs to src/graphify-out/graphify-update.log

set -u

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
graph_dir="$repo_root/src/graphify-out"
graph_path="$graph_dir/graph.json"
lock_dir="$graph_dir/.graphify-update.lock"
log="$graph_dir/graphify-update.log"
stale_lock_seconds="${STALE_LOCK_SECONDS:-1800}" # 30 min — a healthy refresh finishes in seconds to low minutes

mode="${1:-}"
case "$mode" in
  --force|--hook|"") ;;
  *)
    echo "usage: $0 [--force|--hook]" >&2
    exit 2
    ;;
esac

command -v graphify >/dev/null 2>&1 || exit 0

# --hook (default when called from a git hook): only refresh a checkout that
# already opted into a graph. A brand-new worktree/clone has no
# src/graphify-out/ at all — leave it alone until someone runs
# `npm run graph:refresh` there deliberately.
if [ "$mode" != "--force" ] && [ ! -f "$graph_path" ]; then
  exit 0
fi

mkdir -p "$graph_dir" 2>/dev/null || exit 0

lock_age_seconds() {
  # BSD stat (macOS) then GNU stat (Linux); fall back to "not stale" (0) if
  # neither is available so we never busy-loop reclaiming a live lock.
  local mtime
  mtime="$(stat -f %m "$lock_dir" 2>/dev/null || stat -c %Y "$lock_dir" 2>/dev/null || echo "")"
  if [ -z "$mtime" ]; then
    echo 0
    return
  fi
  echo $(( $(date +%s) - mtime ))
}

acquire_lock() {
  mkdir "$lock_dir" 2>/dev/null && return 0

  # Lock already held. If it's older than the staleness threshold, assume the
  # owning process crashed (killed -9, machine slept, etc.) without running
  # its EXIT trap, and reclaim it — otherwise a single crashed refresh would
  # wedge every future refresh on this checkout forever.
  if [ -d "$lock_dir" ]; then
    age="$(lock_age_seconds)"
    if [ "$age" -gt "$stale_lock_seconds" ]; then
      printf '[%s] reclaiming stale lock (age %ss): %s\n' \
        "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$age" "$lock_dir" >>"$log" 2>/dev/null || true
      rmdir "$lock_dir" 2>/dev/null || true
      mkdir "$lock_dir" 2>/dev/null && return 0
    fi
  fi
  return 1
}

if ! acquire_lock; then
  printf '[%s] graphify refresh skipped: another refresh is already running\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$log" 2>/dev/null || true
  exit 0
fi

(
  cleanup() { rmdir "$lock_dir" 2>/dev/null || true; }
  trap cleanup EXIT INT TERM

  cd "$repo_root" || exit 0
  printf '[%s] graphify refresh start: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$repo_root" >>"$log" 2>&1
  if command -v nice >/dev/null 2>&1 && nice -n 10 true >/dev/null 2>&1; then
    nice -n 10 graphify update src --force >>"$log" 2>&1
  else
    graphify update src --force >>"$log" 2>&1
  fi
  printf '[%s] graphify refresh done: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$repo_root" >>"$log" 2>&1
) &
disown >/dev/null 2>&1 || true

exit 0
