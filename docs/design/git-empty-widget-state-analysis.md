# Git empty widget terminal state analysis

## Observation

Real request against the live gateway for HQ session `0cdf548d-408e-44f8-89c8-31814c61380d`:

```text
GET /api/sessions/0cdf548d-408e-44f8-89c8-31814c61380d/git-status
status: 409 Conflict
elapsed: 35 ms
body: {
  "error": "Git status is unavailable. This Headquarters session runs in the Headquarters directory without a git worktree. Git branch, merge, and PR actions are unavailable.",
  "code": "GOAL_GIT_UNAVAILABLE",
  "sessionId": "0cdf548d-408e-44f8-89c8-31814c61380d",
  "projectId": "headquarters",
  "branch": null,
  "worktreePath": null
}
```

So the current terminal state is **not** `200` with a parent-repo branch and not `400 Not a git repository`. It is a fast, intentional HQ short-circuit: `src/server/server.ts:13524` returns `409` for `isHeadquartersSession(session)`, using `sessionGitUnavailablePayload()` from `src/server/server.ts:1001`.

## Client state outcome

`src/app/api.ts:1540-1564` maps session git-status responses as:

- `2xx` -> `{ kind: 'ok', data }`
- `400` with `error === 'Not a git repository'` -> `{ kind: 'not-a-repo' }`
- everything else -> `{ kind: 'error', status, message: 'HTTP <status>' }`

Therefore the observed `409` becomes `{ kind: 'error', status: 409, message: 'HTTP 409' }`; the response body is not inspected.

`runGitStatusRefresh()` (`src/app/git-status-refresh.ts:39-75`) retries only the `error` case for the full backoff schedule `[0, 500, 2000, 5000]`, then exits without `onOk` or `onNotARepo`.

`runWidgetGitRefresh()` (`src/app/git-status-refresh.ts:139-171`) starts non-quiet for an uncached HQ session because `computeConnectGitState()` (`src/app/git-repo-cache.ts:107-112`) only treats cached `'no'` as quiet. It sets `gitStatusLoading = true` at line 144, then after the four `409` errors clears loading at line 169. Since neither success nor not-a-repo ran, final state is:

```text
gitRepoKnown = 'unknown'
gitStatusLoading = false
gitStatus = undefined
branch = ''
cache write = none
```

`src/app/session-manager.ts:3381-3385` then logs the give-up warning when active, unknown, and no data.

## Why the widget shows nothing

Two render paths combine:

1. `AgentInterface` still mounts the git widget because it gates only on `gitRepoKnown !== 'no'`:
   - pill strip outer gate: `src/ui/components/AgentInterface.ts:2145`
   - widget gate: `src/ui/components/AgentInterface.ts:2178`
2. `GitStatusWidget.render()` hides once loading is false and there is no branch:
   - skeleton while `loading && !branch`: `src/ui/components/GitStatusWidget.ts:1112`
   - hidden fallback on `!branch`: `src/ui/components/GitStatusWidget.ts:1130`

So the visible sequence is: skeleton during retries, then empty/nothing after give-up. Because no cache entry is written, every later connect repeats `computeConnectGitState()` -> `{ gitRepoKnown: 'unknown', quietRecheck: false }`, flips `gitStatusLoading = true`, flashes `Checking git…`, then gives up to hidden again.

## Recommended client-only fix

Keep the server behaviour unchanged. Treat this as an empty terminal client outcome.

Recommended implementation shape:

1. Extend `RepoState` in `src/app/git-repo-cache.ts` from `'yes' | 'no'` to `'yes' | 'no' | 'hidden'` (or `'empty'`). Parse and persist the new value.
2. Make `computeConnectGitState()` return a hidden-equivalent state with `quietRecheck: true` for cached `'hidden'`, just like cached `'no'`. This likely means extending `GitRepoKnown` / `ConnectGitState.gitRepoKnown` to include `'hidden'`, because reusing `'no'` would make a later quiet recheck reveal only for `ok` but would also semantically conflate explicit non-repo with empty/unavailable.
3. Update `runWidgetGitRefresh()` so quiet mode is effective for cached hidden as well as cached no. It must never write `gitStatusLoading = true` for that quiet hidden recheck.
4. Add a terminal hook for “all retries exhausted with no data” (or otherwise return an outcome from `runGitStatusRefresh`) so `session-manager.ts::refreshGitStatusForSession()` can cache `'hidden'` when the final state is no branch/no data. The current post-refresh warning block at `src/app/session-manager.ts:3381-3385` is the exact detection point, but the cache write belongs in the refresh state machine if tests need to pin the DI seam.
5. Also cache `'hidden'` from any clean `ok` payload that would render nothing (for example `ok` with no `branch`), and cache `'yes'` only when the applied state has showable content.
6. On a quiet hidden recheck that later returns showable `ok` data, apply the payload, flip `gitRepoKnown = 'yes'`, cache `'yes'`, and reveal the widget.

This preserves the first-ever skeleton: no cache entry still maps to `{ gitRepoKnown: 'unknown', quietRecheck: false }`. It also preserves explicit `400 Not a git repository` behaviour while covering the observed HQ `409` give-up-with-no-data path.
