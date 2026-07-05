#!/bin/sh
# scripts/test-mutex.sh — cross-lane test mutex.
#
# This machine runs multiple independent test lanes concurrently (a
# dev/agent loop plus a merge-gate conveyor, scripts/gate-pr.sh, in the
# sibling bobbit-fable-refactor checkout). Two full test suites racing for
# the same cores at once causes contention-induced flakes (see
# scripts/run-unit.mjs's half-core-split comment and
# scripts/lib/adaptive-concurrency.mjs) that are indistinguishable from real
# regressions unless something serializes the lanes. This wrapper runs an
# arbitrary command behind a single machine-wide lock so at most one
# fleet-parallel test run has the machine at a time.
#
# Usage:
#   scripts/test-mutex.sh <command> [args...]
#   npm run test:unit:queued        (wraps `npm run test:unit`)
#
# Lock: a directory, not a file — `mkdir` is atomic on every POSIX
# filesystem, so acquisition needs no separate lockfile race:
#   ${TMPDIR:-/tmp}/bobbit-test-mutex/
#     pid    — holder's PID
#     start  — holder's lock-acquire time (epoch seconds)
#
# Stale reclaim: if the lock dir is older than 90 minutes, the holder is
# assumed to have died without running its EXIT trap (killed -9, crashed
# machine, etc.) and the lock is reclaimed rather than waited on forever.
#
# POSIX sh only — no bashisms (arrays, [[, local) — so it runs under dash,
# ash, or bash's POSIX mode without a shebang change.

set -u

LOCK_DIR="${TMPDIR:-/tmp}/bobbit-test-mutex"
STALE_SECS=$((90 * 60))
WAIT_INTERVAL_SECS=60

if [ "$#" -eq 0 ]; then
	echo "usage: $0 <command> [args...]" >&2
	exit 2
fi

now_epoch() {
	date +%s
}

# Portable mtime: BSD `stat -f %m` (macOS) or GNU `stat -c %Y` (Linux).
lock_mtime() {
	stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0
}

reclaim_if_stale() {
	[ -d "$LOCK_DIR" ] || return 0
	mtime=$(lock_mtime)
	age=$(( $(now_epoch) - mtime ))
	if [ "$age" -ge "$STALE_SECS" ]; then
		holder_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "?")
		echo "[test-mutex] lock held by pid ${holder_pid} is ${age}s old (>= ${STALE_SECS}s stale threshold) — reclaiming" >&2
		rm -rf "$LOCK_DIR"
	fi
}

release() {
	# Best-effort: only remove the lock if we still appear to own it, so a
	# process that lost a stale-reclaim race doesn't delete someone else's
	# fresh lock out from under them.
	if [ -f "$LOCK_DIR/pid" ]; then
		owner=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")
		if [ "$owner" = "$$" ]; then
			rm -rf "$LOCK_DIR"
		fi
	fi
}
trap release EXIT INT TERM

waited=0
while true; do
	reclaim_if_stale
	if mkdir "$LOCK_DIR" 2>/dev/null; then
		echo "$$" > "$LOCK_DIR/pid"
		now_epoch > "$LOCK_DIR/start"
		break
	fi
	holder_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "?")
	echo "[test-mutex] waiting on lock held by pid ${holder_pid} (${waited}s elapsed)..." >&2
	sleep "$WAIT_INTERVAL_SECS"
	waited=$((waited + WAIT_INTERVAL_SECS))
done

echo "[test-mutex] lock acquired (pid $$); running: $*" >&2
"$@"
status=$?
exit "$status"
