#!/usr/bin/env bash
# MCP entrypoint for graphify, wired from the committed .mcp.json.
#
# .mcp.json used to hardcode an absolute path to AJ's uv-managed graphify
# python interpreter and his primary checkout's graph.json. Both are
# machine-specific and broke on any other machine/worktree. This script
# resolves both dynamically so .mcp.json itself stays portable — every
# agent worktree still inherits the graphify MCP (that inheritance is the
# whole point; only the previously-hardcoded paths were the problem).
#
# Interpreter resolution (first match wins):
#   1. `graphify` on PATH. The graphify CLI has no `serve` subcommand — MCP
#      is only exposed via `python -m graphify.serve`. But `graphify` itself
#      is a script whose shebang names the exact uv-managed venv python that
#      has the `graphify` package importable, so we read that shebang
#      instead of hardcoding a path.
#   2. $GRAPHIFY_PYTHON — an explicit override for machines where a
#      graphify-enabled python exists but isn't the interpreter behind a
#      `graphify` on PATH (e.g. `graphify` not installed, only the module).
# If neither resolves, print one line to stderr and exit 0 so Claude Code
# shows a dead/unavailable MCP server rather than a crash loop.
#
# Graph path resolution (first match wins):
#   1. <repo-root>/src/graphify-out/graph.json — repo-root is one level up
#      from this script's own location, so it works in any worktree that has
#      already run its own graph refresh (npm run graph:refresh).
#   2. The primary checkout's graph, found via the first entry of
#      `git worktree list` (git always lists the main worktree first) — so a
#      fresh worktree still gets the shared graph before its first refresh.
#   3. Omitted — let `graphify.serve` fall back to its own default
#      (graphify-out/graph.json under cwd).

set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

resolve_python() {
  local graphify_bin shebang interp
  graphify_bin="$(command -v graphify 2>/dev/null || true)"
  if [ -n "$graphify_bin" ]; then
    shebang="$(head -n1 "$graphify_bin" 2>/dev/null || true)"
    case "$shebang" in
      '#!'*)
        interp="${shebang#\#!}"
        if [ -x "$interp" ]; then
          printf '%s\n' "$interp"
          return 0
        fi
        ;;
    esac
  fi
  if [ -n "${GRAPHIFY_PYTHON:-}" ] && [ -x "${GRAPHIFY_PYTHON:-}" ]; then
    printf '%s\n' "$GRAPHIFY_PYTHON"
    return 0
  fi
  return 1
}

resolve_graph() {
  local candidate primary
  candidate="$repo_root/src/graphify-out/graph.json"
  if [ -f "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  primary="$(git -C "$repo_root" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')"
  if [ -n "$primary" ] && [ -f "$primary/src/graphify-out/graph.json" ]; then
    printf '%s\n' "$primary/src/graphify-out/graph.json"
    return 0
  fi
  return 1
}

python_bin="$(resolve_python)" || {
  echo "graphify-mcp: no graphify python found ('graphify' not on PATH and \$GRAPHIFY_PYTHON is unset/invalid) — graphify MCP server unavailable." >&2
  exit 0
}

graph_path="$(resolve_graph || true)"

if [ -n "$graph_path" ]; then
  exec "$python_bin" -m graphify.serve "$graph_path"
else
  exec "$python_bin" -m graphify.serve
fi
