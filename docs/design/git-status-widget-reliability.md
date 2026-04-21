# Git status widget reliability — design doc

Goal spec: the session and goal-dashboard git-status widgets disappear on first-fetch failure, have no safety poll, and the server re-scans the whole working tree on every call with no caching. Make the widget always visible when a repo might exist, resilient to transient failure, and fast on warm cache.

---

## 1. Tri-state repo detection

### 1.1 `AgentInterface` (session widget)

File: `src/ui/components/AgentInterface.ts`.

Add one property:

```ts
@property({ attribute: false })
gitRepoKnown: 'yes' | 'no' | 'unknown' = 'unknown';
```

**Defaults:**
- On `connectedCallback` / first render after session attach: `'unknown'`.
- Reset to `'unknown'` whenever the session changes (in `onSessionChanged` / the place that currently clears `gitStatus`).

**Render gate (replaces current `this.gitStatus || this.gitStatusLoading`):**

```ts
const showWidget = this.gitRepoKnown !== 'no';
```

Apply this to both the pill-strip render branch (line ~973) and the glow-placeholder branch (line ~1197). The widget renders whenever `showWidget` is true — even with zero data — so the skeleton state is visible.

**Transitions (owned by `refreshGitStatusForSession` in `src/app/session-manager.ts`):**

| Event | New value |
| --- | --- |
| Session connect / switch | `'unknown'` (reset) |
| Fetch returns 200 with data | `'yes'` |
| Fetch returns **400** with body `{ error: "Not a git repository" }` | `'no'` |
| Fetch returns any other non-2xx (404, 5xx, network error, timeout, abort) | unchanged — stays `'unknown'` (or stays `'yes'` if previously known) |
| Fetch throws / rejects | unchanged |

Only an explicit server confirmation flips to `'no'`. Every other failure keeps the widget visible.

### 1.2 Goal dashboard

File: `src/app/goal-dashboard.ts`.

Add a module-level variable mirroring the session case:

```ts
let gitRepoKnown: 'yes' | 'no' | 'unknown' = 'unknown';
```

Reset to `'unknown'` in `resetDashboardState()` (around line 345, next to `gitStatus = null`).

In `renderMetaRows()` (line ~1187), replace `${branch || gs ? html\`...\` : nothing}` with `${gitRepoKnown !== 'no' ? html\`...\` : nothing}`. The widget renders in loading skeleton state when `gs === null && gitRepoKnown !== 'no'`.

Same transition rules as above, applied in `loadDashboard()`, `startGitStatusPolling()`, `handleGitFetch()`, and `handleMergeAction()` — every site that reads `gitStatusRes`.

### 1.3 API helper contract change

File: `src/app/api.ts`, function `fetchGitStatus`.

Current signature returns `GitStatusData | null` — this collapses "not a repo" and "transient failure" into the same outcome. Change to a discriminated result:

```ts
export type GitStatusResult =
  | { kind: 'ok'; data: GitStatusData }
  | { kind: 'not-a-repo' }
  | { kind: 'error'; status?: number; message: string };

export async function fetchGitStatus(
  sessionId: string,
  opts?: { fetch?: boolean; untracked?: boolean; signal?: AbortSignal },
): Promise<GitStatusResult>;
```

Implementation: 200 → `ok`, 400 with `error === "Not a git repository"` → `not-a-repo`, everything else → `error` (never resolves to `null`; never throws). All callers updated. Also add a `fetchGoalGitStatus(goalId, opts)` helper in `goal-dashboard.ts` (or `api.ts`) using the same `GitStatusResult` shape, to replace the inline `gatewayFetch` calls.

---

## 2. Retry-with-backoff contract

File: `src/app/session-manager.ts`, function `refreshGitStatusForSession` (line 1883).

New signature:

```ts
async function refreshGitStatusForSession(
  sessionId: string,
  opts?: { fetch?: boolean; source?: 'event' | 'poll' | 'user' },
): Promise<void>;
```

### 2.1 Behaviour

- Keep one in-flight refresh per session. If a refresh is already in flight for this session, return the existing promise (de-dupe).
- Attach an `AbortController` to the in-flight refresh. Store it on a module-level `Map<sessionId, AbortController>`.
- Backoff schedule on failure: attempt 1 immediate, then wait **500ms**, **2000ms**, **5000ms** before attempts 2–4. Stop after 4 total attempts.
- Retry only on `kind: 'error'` — do not retry on `kind: 'not-a-repo'` (flip to `'no'` and return).
- `ai.gitStatusLoading = true` is set at entry, cleared **only in the final `finally`** after the last attempt completes (success, give-up, or abort). It stays `true` across all retries — the widget shows loading throughout.
- Abort conditions (check between attempts and before each sleep):
  - `activeSessionId() !== sessionId` — user switched session. Abort controller's `abort()`, do not update state.
  - Session destroyed / agentInterface gone.
- `source: 'poll'` is written to `lastRefreshAt` (see §3) so event-driven refreshes can skip redundant ticks.
- On final give-up after 4 failures: leave last known `gitStatus` in place, clear loading, leave `gitRepoKnown` unchanged, log `console.warn("git-status refresh failed after retries", { sessionId })`.

### 2.2 Timing utility

Small sleep helper with abort support:

```ts
function abortableSleep(ms: number, signal: AbortSignal): Promise<void>;
```

Rejects with `DOMException('aborted', 'AbortError')` when the signal fires. The main loop catches `AbortError` and bails without state updates.

### 2.3 Goal dashboard equivalent

`goal-dashboard.ts` gets a parallel `refreshGoalGitStatus(goalId, opts)` with the same backoff and abort semantics. The 60s poll (`startGitStatusPolling`) and all on-demand call sites (`handleGitFetch`, `handleMergeAction`, `loadDashboard`) route through it. Abort condition is `currentGoalId !== goalId`.

---

## 3. 30s safety poll (session widget)

File: `src/app/session-manager.ts`.

### 3.1 State

```ts
let gitStatusPollTimer: ReturnType<typeof setInterval> | null = null;
let gitStatusLastRefreshAt = 0; // performance.now() of last *started* refresh
```

### 3.2 Start / stop

Start the poll inside the existing "session connected & active" handler (line ~908) — the same place that currently calls `refreshGitStatusForSession` on `connected`:

```ts
startGitStatusPoll(sessionId);
```

Stop on:
- Session switch (in the same code path that changes `activeSessionId`). Always stop before starting a new one.
- WebSocket `disconnected`.
- Session terminate / remove.

Only one poll timer exists globally — it's tied to the active session.

### 3.3 Tick logic

```ts
function startGitStatusPoll(sessionId: string): void {
  stopGitStatusPoll();
  gitStatusPollTimer = setInterval(() => {
    if (activeSessionId() !== sessionId) { stopGitStatusPoll(); return; }
    if (document.visibilityState !== 'visible') return; // pause when hidden
    const ai = state.chatPanel?.agentInterface;
    if (!ai || ai.gitRepoKnown === 'no') { stopGitStatusPoll(); return; }
    const elapsed = performance.now() - gitStatusLastRefreshAt;
    if (elapsed < 10_000) return; // coalesce: event-driven fired recently
    refreshGitStatusForSession(sessionId, { source: 'poll' });
  }, 30_000);
}
```

`gitStatusLastRefreshAt` is set at the top of `refreshGitStatusForSession` (regardless of `source`) so event-driven refreshes count as "recent" for the poll's coalesce window.

### 3.4 Visibility transition

On `visibilitychange` → `visible`: if there's an active session with `gitRepoKnown !== 'no'`, fire an immediate refresh (not a full poll restart). This covers the case where the tab slept past multiple intervals.

### 3.5 Goal dashboard

Existing 60s poll already checks `visibilityState`. Add:
- `gitRepoKnown !== 'no'` gate (skip poll if server confirmed no repo).
- 10s coalesce window shared with on-demand fetches via a similar `gitStatusLastRefreshAt` module variable.
- **Do not change** the 60s cadence (explicit out-of-scope).

---

## 4. GitStatusWidget render states

File: `src/ui/components/GitStatusWidget.ts`, method `render()` (line 756).

Replace the early-return `if (!this.branch && !this.loading) return nothing;` with the three explicit states.

### 4.1 State: `loading && !branch` — skeleton

No data yet. Render a fixed-width pill (~120px) with animated shimmer and "Checking git…" text. Skeleton must not call `_toggle` on click (dropdown disabled when no data).

```html
<button class="git-status-pill skeleton" disabled aria-busy="true">
  <span class="skeleton-shimmer"></span>
  <span class="text-muted-foreground">Checking git…</span>
</button>
```

CSS: `.skeleton-shimmer` is a 1.2s linear gradient sweep matching the existing `animate-pulse` feel but spanning the pill width. Define inline in the widget's `<style>` block to stay self-contained.

### 4.2 State: `loading && branch` — refresh

Existing content with a subtle pulsing dot next to the branch glyph. Replace the current `${this.loading ? html\`<span class="animate-pulse shrink-0">⎇</span>\` : html\`<span class="shrink-0">⎇</span>\`}` with:

```html
<span class="shrink-0 relative">
  ⎇
  ${this.loading
    ? html`<span class="git-refresh-dot" aria-label="Refreshing"></span>`
    : nothing}
</span>
```

Where `.git-refresh-dot` is a 6px circle, positioned absolute top-right of the branch glyph, background `var(--primary)`, 1s opacity pulse. Non-intrusive — does not shift layout.

### 4.3 State: `!loading && branch` — normal

Unchanged from today.

### 4.4 State: `!loading && !branch`

Returns `nothing` — lets the parent's `gitRepoKnown === 'no'` gate handle hiding. Safety fallback in case the widget is mounted with no data and not loading.

### 4.5 Reactivity

`loading` is already a `@property({ type: Boolean })`, so Lit re-renders on change. No extra work needed; just ensure the parent writes `this.loading = this.gitStatusLoading` (already the case in `AgentInterface.ts` line 998).

---

## 5. Server response cache + single-flight

File: `src/server/server.ts`.

### 5.1 Placement

Add a module-level cache above `batchGitStatus` (near line 189). Cache both the resolved result and the in-flight promise so concurrent callers share a single git invocation.

```ts
type GitStatusResult = NonNullable<Awaited<ReturnType<typeof runBatchGitStatus>>>;

interface GitStatusCacheEntry {
  promise: Promise<GitStatusResult | null>;
  resolvedAt: number; // 0 while in flight
  result: GitStatusResult | null | undefined; // undefined while in flight
}

const GIT_STATUS_TTL_MS = 750;
const gitStatusCache = new Map<string, GitStatusCacheEntry>();
```

### 5.2 Key

```ts
function gitStatusCacheKey(cwd: string, containerId?: string, untracked?: boolean): string {
  return `${containerId ?? 'host'}::${cwd}::${untracked ? 'u' : 's'}`;
}
```

The `untracked` flag is part of the key because summary vs full responses are different payloads (see §6). Prevents a summary response from being served to a dropdown open-handler that requested the full variant.

### 5.3 Lookup flow

Rename the current `batchGitStatus` to `runBatchGitStatus` (the raw worker). Add a new cached wrapper that's exported/used by the HTTP handlers:

```ts
async function batchGitStatus(
  cwd: string,
  containerId?: string,
  opts?: { untracked?: boolean },
): Promise<GitStatusResult | null> {
  const key = gitStatusCacheKey(cwd, containerId, opts?.untracked);
  const now = Date.now();
  const existing = gitStatusCache.get(key);

  if (existing) {
    // In flight — share the promise
    if (existing.result === undefined) return existing.promise;
    // Resolved and fresh — return cached
    if (now - existing.resolvedAt < GIT_STATUS_TTL_MS) return existing.result;
    // Stale — fall through
  }

  const promise = runBatchGitStatus(cwd, containerId, opts).then(
    (result) => {
      const entry = gitStatusCache.get(key);
      if (entry && entry.promise === promise) {
        entry.result = result;
        entry.resolvedAt = Date.now();
      }
      return result;
    },
    (err) => {
      // Negative cache: short-circuit failure storm for 200ms only
      const entry = gitStatusCache.get(key);
      if (entry && entry.promise === promise) {
        gitStatusCache.delete(key); // don't cache errors long
      }
      throw err;
    },
  );

  gitStatusCache.set(key, { promise, resolvedAt: 0, result: undefined });
  return promise;
}
```

### 5.4 Eviction

Opportunistic: on lookup, if `gitStatusCache.size > 200`, drop all entries with `now - resolvedAt > 5_000`. Bounded memory; no timer needed. (Realistic steady-state size is ≤ number of active sessions × 2.)

### 5.5 Cache bust

The `?fetch=true` branch in both HTTP handlers must bypass cache. After `git fetch`, any cached status is stale anyway. Explicit bust:

```ts
if (url.searchParams.get('fetch') === 'true') {
  try { await execGit('git fetch --quiet', cwd, 15000, cid); } catch {}
  gitStatusCache.delete(gitStatusCacheKey(cwd, cid, /*untracked*/ true));
  gitStatusCache.delete(gitStatusCacheKey(cwd, cid, /*untracked*/ false));
}
```

Local git actions (commit/pull/push endpoints already in `server.ts`) should also bust both keys after success — add a tiny helper:

```ts
function invalidateGitStatusCache(cwd: string, containerId?: string): void {
  gitStatusCache.delete(gitStatusCacheKey(cwd, containerId, true));
  gitStatusCache.delete(gitStatusCacheKey(cwd, containerId, false));
}
```

Call from: `/git-commit`, `/git-pull`, `/git-push`, any merge endpoint, and `shutdownSession` cleanup.

---

## 6. Porcelain perf: opt-in `?untracked=1`

### 6.1 Choice

**Single endpoint, opt-in query param.** Simpler than a second endpoint — one handler, one wrapper, one cache. The widget's default pill-strip render wants speed; the dropdown-open handler wants the full list.

### 6.2 Server change

In `runBatchGitStatus(cwd, containerId, opts)`, swap the porcelain command based on `opts?.untracked`:

```ts
// Summary (fast path — skips untracked walk)
'git -c core.filemode=false status --porcelain=v1 -uno 2>/dev/null',

// Full (expanded dropdown — includes untracked)
'git -c core.filemode=false status --porcelain=v1 -uall 2>/dev/null',
```

When `-uno` is used, the response carries a new flag so the client can avoid claiming "clean" incorrectly:

```ts
untrackedIncluded: boolean; // true only when ?untracked=1 was passed
```

If `untrackedIncluded === false`, `clean` is computed from tracked changes only. The client must not treat it as authoritatively clean. The dropdown fetch (which sends `?untracked=1`) yields `untrackedIncluded: true` and fully-accurate `clean`.

### 6.3 Endpoints

Both endpoints accept `?untracked=1`:

- `GET /api/sessions/:id/git-status?untracked=1`
- `GET /api/goals/:id/git-status?untracked=1`

Default (no param) → summary, fast path. `?fetch=true` is orthogonal and composes.

### 6.4 Client behaviour

- Session widget: initial load and safety poll fetch **summary** (no `untracked`). First-paint target < 300ms.
- `GitStatusWidget._toggle` (dropdown open): fire a refetch with `untracked=1`. Add `ai.onGitFetchFull?.()` hook or extend `refreshGitStatusForSession` to accept `{ untracked: true }`. Dropdown already has a "refetch on open" pathway — extend it.
- Goal dashboard: 60s poll uses summary; on dropdown open it triggers the same full-variant refetch.

### 6.5 `unpushed` / `summary` semantics

`summary` string is still built from whatever `status` lines were returned. With `-uno`, untracked files contribute zero to the summary — acceptable since the dropdown immediately re-fetches the full variant when the user expands.

---

## 7. Timeouts + partial response

### 7.1 Bump

In `runBatchGitStatus`, change `timeout: 10000` → `timeout: 15000` on both branches (host `execAsync` and `docker exec execFileAsync`).

### 7.2 Per-step budget (partial response)

The porcelain sub-step is the long tail. Budget it independently so we can return branch/ahead/behind even when porcelain is slow.

Split the single script into two sequential phases:

1. **Phase A (fast metadata, 3s budget):** branch, remote HEAD, master/main exists, upstream, ahead, behind, aheadOfPrimary, behindPrimary. All rev-parse / rev-list calls — these are typically <100ms.
2. **Phase B (porcelain, 12s budget):** the `git status --porcelain` call.

Implementation: two shell invocations. Phase A must succeed for the response to be meaningful (otherwise we return 400 / 500 as today). Phase B runs with its own `AbortController`; on timeout, we catch and return Phase A data with:

```ts
partial: true;     // new field
clean: false;      // conservative — we don't know
summary: 'unknown';
status: [];
```

### 7.3 Response shape

Add two optional fields to the existing response (non-breaking — old clients ignore):

```ts
{
  branch: string;
  primaryBranch: string;
  isOnPrimary: boolean;
  status: Array<{ file: string; status: string }>;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
  aheadOfPrimary: number;
  behindPrimary: number;
  mergedIntoPrimary: boolean;
  clean: boolean;
  summary: string;
  unpushed: boolean;

  // NEW
  partial?: boolean;              // true if porcelain was skipped/timed-out
  untrackedIncluded?: boolean;    // true only when ?untracked=1 was passed
}
```

### 7.4 Client handling of `partial`

In `GitStatusWidget`:
- When `partial === true`: render the pill with a faint yellow dot (distinct from the blue refresh dot) next to the branch. Tooltip "Status scan timed out — showing partial data." Dropdown shows branch/ahead/behind fields but hides the file list with a "Re-scan" button that triggers an `?untracked=1` refetch.

Add `@property({ type: Boolean }) partial = false;` to `GitStatusWidget`. Wired from `AgentInterface.ts` as `.partial=${this.gitStatus?.partial ?? false}`.

---

## 8. Test plan

### 8.1 Unit — `tests/git-status-widget.spec.ts` (new)

Playwright file:// fixture rendering the widget.

| Test | Setup | Assert |
| --- | --- | --- |
| Skeleton state | `loading=true`, no branch | Pill renders, contains "Checking git…", `aria-busy="true"`, disabled |
| Refresh state | `loading=true`, `branch="foo"` | Pill shows branch, has `.git-refresh-dot` element |
| Normal state | `loading=false`, `branch="foo"` | No dot, normal rendering |
| Hidden when no data + not loading | `loading=false`, no branch | `render()` returns `nothing` |
| Partial flag renders warning | `partial=true`, `branch="foo"` | Warning dot present, dropdown on open shows "Re-scan" button |

### 8.2 Unit — `tests/git-status-refresh.spec.ts` (new)

Test `refreshGitStatusForSession` in isolation. Mock `fetchGitStatus`:

| Test | Setup | Assert |
| --- | --- | --- |
| Tri-state `unknown` → `yes` on success | Mock returns `{ kind: 'ok', ... }` | `gitRepoKnown === 'yes'`, `gitStatus` populated, `gitStatusLoading === false` |
| Tri-state → `no` on 400 not-a-repo | Mock returns `{ kind: 'not-a-repo' }` | `gitRepoKnown === 'no'`, no retries fired |
| Stays `unknown` on 500 after all retries | Mock returns `{ kind: 'error', status: 500 }` always | 4 calls made, total elapsed ~7500ms (500+2000+5000), `gitRepoKnown` unchanged, loading cleared |
| Retry succeeds on 3rd attempt | Mock fails twice, then succeeds | 3 calls, loading stays true throughout, final state `'yes'` |
| Abort on session switch | Start refresh, switch active session during backoff | No further `fetchGitStatus` calls, no state writes to old session's `ai` |
| De-dupe concurrent refreshes | Call `refresh(sessionId)` twice in quick succession | Only one `fetchGitStatus` invocation |

Use fake timers for backoff assertions.

### 8.3 Unit — `tests/git-status-poll.spec.ts` (new)

| Test | Setup | Assert |
| --- | --- | --- |
| Poll fires every 30s | Start poll, advance 30s ×3 | 3 refresh calls |
| Coalesced with recent event-driven refresh | Fire event-driven refresh at t=0, poll tick at t=30s | Skip — `fetchGitStatus` called once |
| Stops when `gitRepoKnown === 'no'` | Set `'no'`, tick | Timer cleared, no refresh |
| Pauses when `visibilityState === 'hidden'` | Mock hidden, tick | No refresh call |
| Immediate refresh on visibility → visible | Mock hidden, then visible | Refresh fires without waiting 30s |

### 8.4 Browser E2E — `tests/e2e/ui/git-status-resilience.spec.ts` (new)

Using `gateway-harness.js` + route interception (Playwright `page.route`):

| Test | Setup | Assert |
| --- | --- | --- |
| 500-then-recover | Intercept `/git-status` to return 500 on first call, pass-through after | Widget visible throughout (skeleton then content), final state shows branch. No reload needed. |
| Not-a-repo hides widget | Fresh session in `/tmp` (non-git dir) | Widget absent from DOM after first response |
| Network abort mid-fetch | Abort first request, allow subsequent | Widget stays in loading state, recovers on retry |
| Dropdown triggers `?untracked=1` refetch | Open session with git, click widget pill | Network log shows second `/git-status?untracked=1` request, response has `untrackedIncluded: true` |

### 8.5 API E2E — `tests/e2e/git-status-coalesce.spec.ts` (new)

Using `in-process-harness.js`:

| Test | Setup | Assert |
| --- | --- | --- |
| 5 concurrent calls → 1 git invocation | Spy-wrap `execAsync` / `execFileAsync` via a counter; fire `Promise.all` of 5 `/api/sessions/:id/git-status` | `runBatchGitStatus` counter increments exactly once; all 5 responses match |
| TTL expires after 750ms | Fire one call, wait 800ms, fire another | Counter = 2 |
| `?fetch=true` busts cache | Fire summary, then `?fetch=true` within TTL | Counter = 2 (plus the `git fetch` call) |
| Summary and `?untracked=1` are separate cache entries | Fire both concurrently | Counter = 2 (different keys) |
| 400 not-a-repo not coalesced long-term | Non-git dir, fire twice | Either no coalesce or short coalesce — behaviour documented: errors are NOT cached |

Spy pattern: module-level counter exported from a test-only hook, or wrap `runBatchGitStatus` with a test injection point.

### 8.6 CI

- `npm run check`
- `npm run test:unit`
- `npm run test:e2e`

All green before signaling `implementation`.

---

## 9. File-by-file change list

| File | Change |
| --- | --- |
| `src/app/api.ts` | `fetchGitStatus` → `GitStatusResult` discriminated return. Add `untracked` and `signal` to opts. |
| `src/app/session-manager.ts` | Rewrite `refreshGitStatusForSession` with retry + abort + source. Add `gitStatusLastRefreshAt`. Add `startGitStatusPoll` / `stopGitStatusPoll`. Wire visibility listener. |
| `src/app/goal-dashboard.ts` | Add `gitRepoKnown`. Wrap git-status fetches with retry+tri-state. Apply 10s coalesce to 60s poll. |
| `src/ui/components/AgentInterface.ts` | Add `gitRepoKnown` property. Replace render gates. Reset on session change. Pass `.partial` to widget. |
| `src/ui/components/GitStatusWidget.ts` | Skeleton render state. Refresh-dot overlay. `partial` property. Dropdown-open triggers full refetch. |
| `src/server/server.ts` | Rename `batchGitStatus` → `runBatchGitStatus`. Add cached `batchGitStatus` wrapper with TTL + single-flight. Add `opts.untracked`. Split into Phase A / B. Return `partial` / `untrackedIncluded`. Invalidate cache on `?fetch=true` and from commit/push/pull endpoints. Bump timeout to 15s. |
| `tests/git-status-widget.spec.ts` | NEW — render states. |
| `tests/git-status-refresh.spec.ts` | NEW — retry/abort/tri-state. |
| `tests/git-status-poll.spec.ts` | NEW — poll + coalesce + visibility. |
| `tests/e2e/ui/git-status-resilience.spec.ts` | NEW — browser E2E. |
| `tests/e2e/git-status-coalesce.spec.ts` | NEW — API E2E. |

---

## 10. Acceptance mapping

| Goal spec criterion | Covered by |
| --- | --- |
| Widget always visible under CPU load | §1 tri-state + §2 retry + §3 poll |
| Network-drop mid-fetch recovers without reload | §2 retry + 8.4 E2E |
| Non-git dir hides widget cleanly | §1 `'no'` transition |
| First-paint < 300ms on warm cwd | §5 TTL cache + §6 `-uno` fast path |
| Cold large repo: summary < 500ms, dropdown full list | §6 `?untracked=1` split |

---

## 11. Non-goals / out of scope

- Changing 60s dashboard poll cadence (explicit).
- File-watcher push model (future).
- Dropdown UI rework.
- Cache invalidation on external (non-Bobbit) git operations — covered only by the 30s poll + dropdown open refetch.

---

## 12. Parallelizable implementation slices

Independent work streams for the implementer team:

1. **Server** — §5 cache, §6 `?untracked=1`, §7 timeouts. Self-contained in `src/server/server.ts`. Ships with API E2E tests (§8.5).
2. **API helper** — §1.3 `fetchGitStatus` signature. Blocker for streams 3 & 4.
3. **Session refresh + poll** — §2, §3. Depends on stream 2. Ships with unit tests (§8.2, §8.3).
4. **Goal dashboard refresh** — §1.2, §2 (goal variant), §3.5. Depends on stream 2.
5. **Widget render** — §4. No dependencies beyond adding `partial` property wiring. Ships with unit tests (§8.1).
6. **Browser E2E** — §8.4. Depends on streams 1 + 3 + 5.

Sensible parallelism: 1+2+5 in parallel → 3+4 → 6.
