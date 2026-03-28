#!/usr/bin/env bash
# Reproducing test: proves that `run` and `run.cmd` do NOT detect stale builds.
# Expected result: EXIT 1 with "STALE_BUILD_NOT_DETECTED" when staleness detection is missing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXIT_CODE=0

# --- Check bash `run` script for staleness detection ---
# The fix should use `find ... -newer ...` to detect source files newer than build outputs.
if ! grep -q '\-newer' "$REPO_ROOT/run"; then
  echo "STALE_BUILD_NOT_DETECTED: run script has no staleness detection for source files newer than build outputs" >&2
  EXIT_CODE=1
fi

# --- Check Windows `run.cmd` for timestamp comparison logic ---
# The fix should use PowerShell LastWriteTime, forfiles, or xcopy /D to compare timestamps.
if ! grep -qiE '(LastWriteTime|forfiles|xcopy.*/D|Get-ChildItem.*Recurse|-newer)' "$REPO_ROOT/run.cmd"; then
  echo "STALE_BUILD_NOT_DETECTED: run.cmd has no staleness detection (no timestamp comparison logic found)" >&2
  EXIT_CODE=1
fi

exit $EXIT_CODE
