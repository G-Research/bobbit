#!/usr/bin/env bash
# gpt55-review.sh — GPT-5.5 review step for the GLM worker pipeline.
#
# Given a git diff (uncommitted changes, a single commit, or a branch vs a
# base ref), runs `codex exec -m gpt-5.5` (ChatGPT-subscription auth via the
# codex CLI, no per-call API billing) with a tight review prompt and a
# --output-schema so the verdict comes back as parseable JSON.
#
# NOTE: this deliberately does NOT use the codex-native `codex exec review`
# subcommand. That subcommand routes through codex's own fixed
# app-server review prompt/format and silently ignores --output-schema
# (verified empirically: it always returns a free-text paragraph, never the
# requested JSON) — see gpt55-review-schema.json below for the shape this
# script actually enforces via a generic `codex exec` turn instead.
#
# Usage:
#   gpt55-review.sh <workdir>                     # review uncommitted changes (git diff HEAD)
#   gpt55-review.sh <workdir> --commit <sha>       # review one commit (git show <sha>)
#   gpt55-review.sh <workdir> --base <ref>         # review <ref>...HEAD
#
# Prints a machine-readable line `VERDICT: <approve|needs-attention|no-changes|error>`
# followed by the full review JSON (schema: gpt55-review-schema.json).
#
# Reasoning effort: passed explicitly via `-c model_reasoning_effort="high"` below
# (belt-and-suspenders on top of the `model_reasoning_effort = "high"` set globally
# in ~/.codex/config.toml) so this script stays correct even on a machine without
# that global default. Verified valid effort levels for gpt-5.5 (low/medium/high/
# xhigh, default medium) via codex's models_cache.json; verified the flag actually
# takes effect via the session rollout JSONL (`collaboration_mode.settings.
# reasoning_effort` / top-level `effort` both read "high").
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA="$SCRIPT_DIR/gpt55-review-schema.json"

if [[ $# -lt 1 ]]; then
  echo "usage: gpt55-review.sh <workdir> [--base <ref> | --commit <sha>]" >&2
  exit 2
fi

WORKDIR="$1"
shift

if [[ ! -d "$WORKDIR" ]]; then
  echo "VERDICT: error"
  echo "gpt55-review: workdir not found: $WORKDIR" >&2
  exit 2
fi

MODE="uncommitted"
REF=""
if [[ $# -gt 0 ]]; then
  case "$1" in
    --base)
      MODE="base"
      REF="${2:?--base requires a ref}"
      ;;
    --commit)
      MODE="commit"
      REF="${2:?--commit requires a sha}"
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
fi

case "$MODE" in
  base) DIFF="$(git -C "$WORKDIR" diff "$REF...HEAD")" ;;
  commit) DIFF="$(git -C "$WORKDIR" show "$REF")" ;;
  uncommitted) DIFF="$(git -C "$WORKDIR" diff HEAD)" ;;
esac

if [[ -z "$DIFF" ]]; then
  echo "VERDICT: no-changes"
  exit 0
fi

PROMPT="You are reviewing a code change before it is merged. Focus on: correctness bugs, whether the diff is minimal and targeted at the stated task, whether tests were modified unintentionally (test-gaming), and any contract/security concerns. Do not just restate the diff — call out concrete problems or confirm there are none. Report your findings using the required JSON schema.

=== GIT DIFF (mode: ${MODE}${REF:+, ref: ${REF}}) ===
${DIFF}"

OUTFILE="$(mktemp)"
STDOUTFILE="$(mktemp)"
cleanup() { rm -f "$OUTFILE" "$STDOUTFILE"; }
trap cleanup EXIT

set +e
printf '%s' "$PROMPT" | codex exec \
  -m gpt-5.5 \
  -c model_reasoning_effort="high" \
  --sandbox read-only \
  -C "$WORKDIR" \
  --output-schema "$SCHEMA" \
  -o "$OUTFILE" \
  - \
  > "$STDOUTFILE" 2>&1
CODEX_STATUS=$?
set -e

if [[ $CODEX_STATUS -ne 0 || ! -s "$OUTFILE" ]]; then
  echo "VERDICT: error"
  echo "codex exec review failed (exit $CODEX_STATUS)" >&2
  cat "$STDOUTFILE" >&2
  exit 1
fi

VERDICT=$(node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
process.stdout.write(d.verdict || 'unknown');
" "$OUTFILE")

echo "VERDICT: $VERDICT"
echo "--- review JSON ---"
cat "$OUTFILE"
