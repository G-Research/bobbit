# Git empty widget terminal state analysis

## Observation

A real request against the live gateway for HQ session `0cdf548d-408e-44f8-89c8-31814c61380d` returned:

```text
GET /api/sessions/0cdf548d-408e-44f8-89c8-31814c61380d/git-status
status: 409 Conflict
body: {
  "error": "Git status is unavailable. This Headquarters session runs in the Headquarters directory without a git worktree. Git branch, merge, and PR actions are unavailable.",
  "code": "GOAL_GIT_UNAVAILABLE",
  "sessionId": "0cdf548d-408e-44f8-89c8-31814c61380d",
  "projectId": "headquarters",
  "branch": null,
  "worktreePath": null
}
```

The terminal state is therefore not a parent-repo `200` and not an explicit `400 Not a git repository`. HQ sessions now short-circuit on the server as `409 GOAL_GIT_UNAVAILABLE` because Headquarters runs from Bobbit state, not from a session worktree. That server behavior is unchanged by the client cache fix.

## Client state outcome before the fix

`fetchGitStatus` maps session git-status responses as:

- `2xx` -> `{ kind: 'ok', data }`
- `400` with `error === 'Not a git repository'` -> `{ kind: 'not-a-repo' }`
- everything else -> `{ kind: 'error', status, message }`

The HQ `409` therefore becomes `{ kind: 'error', status: 409, message: 'HTTP 409' }`. For an uncached HQ session, `runWidgetGitRefresh` used a normal refresh: it set `gitStatusLoading = true`, retried the error path through the full backoff schedule, then cleared loading after exhausting retries. No `onOk` or `onNotARepo` callback ran, so no cache entry was written.

Final widget state was:

```text
gitRepoKnown = 'unknown'
gitStatusLoading = false
gitStatus = undefined
branch = undefined
cache write = none
```

## Why the widget showed nothing after the flash

Two render rules combined:

1. `AgentInterface` mounted the git widget because it hides only when `gitRepoKnown === 'no'`.
2. `GitStatusWidget.render()` shows the skeleton while `loading && !branch`, then returns `nothing` when loading is false and no branch exists.

The visible sequence was: `Checking git…` during retries, then an empty/hidden widget after give-up. Because the terminal empty state was never cached, every later connect repeated the same skeleton flash.

## Implemented client-only behavior

The client cache now has three terminal hints in `localStorage` under `bobbit.gitRepoCache`:

- `'yes'` — a real git-status payload with showable content was seen.
- `'no'` — the server explicitly returned `400 Not a git repository`.
- `'hidden'` — the widget reached a terminal state that renders nothing, such as HQ `409 GOAL_GIT_UNAVAILABLE` exhausting retries with no branch/status data, or a clean `ok` payload with no showable branch.

`computeConnectGitState()` treats cached `'hidden'` like cached `'no'` for UX purposes: the session connects hidden, does not flip `gitStatusLoading = true`, and schedules a quiet background recheck. It remains semantically separate from `'no'` so the UI can distinguish “explicit non-repo” from “empty/unavailable/no showable widget state”.

A cached hidden reconnect performs exactly one quiet recheck:

- If the recheck returns showable git content, `runWidgetGitRefresh` applies the payload, flips `gitRepoKnown = 'yes'`, writes `'yes'`, and the widget appears.
- If the recheck returns another empty/error outcome, it writes or keeps `'hidden'` and the widget remains hidden without a skeleton.

A genuine first-ever check still has no cache entry, so it starts `gitRepoKnown = 'unknown'`, runs a normal refresh, and may show the `Checking git…` skeleton. The fix is client render/UX only; it does not change server git-status responses, server caching, single-flight, or `?untracked=1` behavior.

## Tests that pin the contract

- `tests2/core/git-empty-widget-cache.test.ts` covers the HQ `409 GOAL_GIT_UNAVAILABLE` error path, hidden cache persistence, no-loading cached-hidden reconnect, one quiet recheck, and reveal when content later appears.
- `tests2/core/git-widget-quiet-refresh.test.ts` keeps the existing cached-`'no'` quiet-refresh behavior pinned.
- `tests2/core/git-repo-cache.test.ts` pins cache parsing, bounded persistence, pruning, broken-storage tolerance, and connect-state mapping.

All three are registered in `tests2/tests-map.json`.
