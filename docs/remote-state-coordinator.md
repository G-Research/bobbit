# Remote-state coordinator

## Purpose

The server-owned remote-state coordinator is the authority for automatic Git remote-ref refreshes and GitHub pull-request fast-state reads. It prevents every browser, tab, and UI surface from running equivalent external commands while keeping active sessions, goal dashboards, sidebar badges, and staff Git triggers consistent.

The coordinator owns **remote freshness**, not all Git state. Worktree-local status collection still owns dirty files, untracked files, branch comparisons, and multi-repository aggregation. This separation lets sibling worktrees share one remote-ref refresh without sharing their local working-tree state.

The coordinator is process-owned and intentionally not persisted. After a server restart, records are cold and the next eligible read establishes a new last-good snapshot. This avoids turning credentials, remote identities, or stale remote observations into durable state.

## Canonical identity

Remote work is keyed by the resource being observed, never by the requesting browser, `cwd + branch`, goal, or session.

### Repositories

A repository identity combines:

- the Git common directory, so sibling worktrees collapse onto one record;
- a normalized, credential-free origin identity, or a stable local-only marker when no origin exists; and
- an execution namespace when coincident paths belong to different environments, such as separate sandbox containers.

HTTP(S), SSH, scp-style, local-path, host alias, default-port, and Windows path forms are normalized before the identity is hashed into an opaque process-private key. Repository identity probes are time-bounded and separately concurrency-limited so slow Git discovery cannot starve refresh work. Older Git versions fall back from the absolute common-directory probe to the compatible form.

A repository without `origin` remains valid local state. Its refresh path does not fetch. A multi-repository project receives one canonical record per component repository and combines only the public metadata needed by its aggregate status.

### Pull requests

A pull-request identity combines normalized host, owner, repository, and either a resolved head identity or PR number. Once a head lookup returns a PR number, both selectors alias the same record.

PR lookup separates structural remote parsing from host trust. The structural parser still rejects incomplete or unsafe remotes, including malformed paths, encoded separators, query strings, fragments, and trusted-looking substrings embedded in another URL. A valid candidate becomes eligible only through the listed-host rules below or the narrow PR-status credential check. The Git transport identity remains port-sensitive, but PR/API authority is derived separately: SSH transport ports are dropped, while explicit HTTP(S) web/API ports remain part of the PR identity and every host-scoped `gh` call. Rejection never falls back to an independent lookup.

A repository-scoped head lookup validates every candidate against the exact server-owned head and head repository. It selects the unique open PR when present; otherwise it selects the uniquely newest terminal PR, allowing safe branch reuse without a second external read. Ambiguous, malformed, or cross-repository results fail closed and retain any last-good snapshot. Candidate refs, repository ownership, and ordering fields are validation inputs only and are never published.

### Listed GitHub host trust

One server-side resolver supplies the listed-host trust decision to PR status polling,
merge and permission checks, PR Walkthrough, and the browser's trust-prompt preflight.
The effective set combines Bobbit's built-in GitHub hosts, managed
`githubTrustedHosts`, and normalized host keys explicitly configured in the local `gh`
`hosts.yml`. This lets an existing host-specific `gh` login enable an enterprise host
without a duplicate Bobbit preference, while preventing individual consumers from
drifting onto different allowlists.

Discovery reads only host keys from the local `gh` configuration; it does not run an
authentication-status or API probe, request tokens, or contact the configured hosts.
Token data is never returned, persisted, or logged, and environment-only authorization
cannot add a host to this set. Results are briefly cached and concurrent callers share
the lookup. If `gh` configuration cannot be read, discovery contributes nothing and
trust falls back to the built-in plus managed set.

The browser queries the server for a normalized boolean decision rather than receiving
or rebuilding the effective list. A host configured only in `gh` is therefore accepted
consistently by status and action routes and by the PR Walkthrough launch flow. See
[Trusted GitHub hosts](pr-walkthrough-panel.md#trusted-github-hosts) for discovery and
prompt details.

### Credential-derived PR-status eligibility

PR status has one additional, process-local path for a structurally valid enterprise
remote absent from the effective set. Bobbit asks the operator's local Git credential
configuration about the exact normalized host with `git credential fill`. It accepts
the host only when the bounded reply echoes that exact host authority and contains a
password-bearing credential. The resulting `gh` reads remain bound to that host and the
validated owner/repository; the credential result cannot authorize an unqualified or
different target.

This is **PR-status-only eligibility**, not an addition to the effective host set. It
does not persist trust, modify `githubTrustedHosts`, widen merge or permission actions,
or authorize PR Walkthrough launch, fetch, or posting. Built-in, managed, and
`hosts.yml`-discovered hosts keep their existing behavior.

The probe runs only through the injected command-runner spawn seam, from a neutral
temporary directory so repository-local helpers cannot grant process-wide host trust.
Terminal, GUI, and askpass prompting are disabled. Missing spawn support, subprocess or
input errors, timeout, malformed or mismatched output, and output beyond the inspection
bounds all fail closed. Output inspection is byte-bounded, and a timed-out process is
terminated with escalation so a wedged helper cannot accumulate across polls.
Credential values and helper errors are never returned, persisted, or logged. The
security boundary is narrower than "no network access": credential helpers are
operator-configured code and may themselves contact the queried host.

Credential-derived trust is refused before probing when `gh` would prefer a set
host-class-wide ambient token for the target: `GH_TOKEN` or `GITHUB_TOKEN` for
`github.com` and `*.ghe.com`, and `GH_ENTERPRISE_TOKEN` or
`GITHUB_ENTERPRISE_TOKEN` for other enterprise hosts. This prevents admission based on
a host-specific credential from causing `gh` to send a different class-wide token.
Bobbit warns once per host, naming the applicable variable but never its value. This
refusal does not alter trust or ambient-token behavior for listed hosts. Uniform
ambient-token scrubbing for `gh` calls admitted by existing trust sources is a separate
follow-up concern.

Verdicts are cached by normalized host with one in-flight probe per host. Positive
verdicts remain for the gateway process lifetime. Negative verdicts remain until an
explicit PR-status refresh; that refresh clears negatives and stops callers from joining
older-generation in-flight probes, while preserving positives. Automatic, visibility,
and sidebar reads do not re-probe a cached negative.

Trust verdicts are not persisted, but a successful lookup may still populate the
separate persistent PR-status cache used for startup hydration. Revalidating that cache
immediately after credential revocation is a follow-up concern; startup hydration can
therefore display stale PR status before later live processing updates it.

Published PR URLs are reconstructed from the validated server-derived HTTPS authority, owner, repository, and positive PR number. Upstream URLs containing credentials, query strings, fragments, mismatched authorities, non-HTTPS schemes, or non-canonical paths are rejected. Clients apply the same safe-link shape defensively before assigning a URL to a navigation sink.

## Snapshot contract

The shared [REST status contract](rest-api.md#coordinated-remote-state-status) defines query intent, Git flat-field compatibility, PR absence, and endpoint error behavior. Its copied public snapshot body is:

```ts
{
  data?: GitStatusProjection | PullRequestFastState | null;
  observedAt: number;
  refreshedAt?: number;
  ageMs: number;
  stale: boolean;
  source: "repository" | "pr";
  lastError?: "offline" | "auth" | "rate_limited" | "unavailable";
}
```

Git-status REST routes preserve their established flat status fields for compatibility and attach the same coordinator metadata; their nested `data` projection represents that entity's local status. PR-status routes return the snapshot envelope directly. A WebSocket completion wraps the body rather than sending it as the complete frame:

```ts
{
  type: "remote_state_snapshot";
  resource: "git" | "pr";
  sessionId?: string;
  goalId?: string;
  snapshot: RemoteStateSnapshot;
}
```

`resource` routes the message while `snapshot.source` identifies repository or PR state. Clients apply the addressed completion without starting an equivalent follow-up read.

Metadata has these meanings:

- `observedAt` is when this response or broadcast was projected. It changes on every observation.
- `refreshedAt` is when the last successful external refresh completed. It is absent before the first success and does not move on failure.
- `ageMs` is the non-negative age of the last successful refresh. A cold public envelope reports zero while `refreshedAt` remains absent; consumers must not treat zero as proof of freshness.
- `stale` means no successful value exists, the freshness window expired, or the record was invalidated.
- `source` distinguishes repository-ref state from PR fast state.
- `lastError` is a safe category for the latest failed refresh. Absence means there is no retained coordinator error, not that every adjacent Git operation succeeded.
- `data` is omitted when the coordinator is cold or has failed without a last-good value. For PR state, `data: null` instead means an eligible lookup succeeded and definitively found no pull request.

Consumers must use the metadata together. In particular, `refreshedAt` and `stale` determine freshness; `observedAt` only timestamps the projection.

## Read and refresh behavior

Normal reads are stale-while-revalidate:

1. A fresh record returns immediately without external work.
2. A stale record returns retained last-good data immediately and starts or joins one eligible refresh.
3. Completion installs the new snapshot atomically and performs one addressed fanout. Each bound goal, session, or sidebar address receives at most one completion frame for that refresh.
4. Clients apply that frame directly. They must not turn it into another equivalent REST or external read.

A visibility-return read uses the same path. It can start revalidation when stale, but it still observes freshness, call budgets, backoff, bounded concurrency, and per-key single-flight.

An explicit refresh bypasses freshness and automatic backoff, but it does not bypass single-flight: concurrent automatic, visibility, and explicit callers for the same key join the installed promise. Route-level burst coalescing also prevents near-simultaneous explicit requests from starting successive refreshes after a very fast completion.

Invalidation marks retained data stale without discarding it. A normal Git mutation does not erase the repository's automatic-attempt budget; an explicit refresh can revalidate immediately. PR cache-bust invalidation makes the next automatic read cadence-eligible, while failure backoff still applies. An invalidation that races an in-flight refresh remains pending after that refresh completes.

Different canonical keys pass through a bounded queue. Repository identity probes use a separate bound. This prevents a high-cardinality project or slow execution environment from creating unbounded Git and GitHub subprocess concurrency.

## Automatic call budget

The budget is owned by the canonical record, so adding tabs, clients, sibling worktrees, dashboards, or sidebar badges does not multiply external calls.

| Resource and demand | Minimum automatic freshness window |
|---|---:|
| Repository remote refs | 30 seconds per canonical repository |
| PR fast state for active session or goal surfaces | 20 seconds per canonical PR |
| PR fast state for sidebar-only demand | 60 seconds per canonical PR |

A failed attempt consumes the automatic window. Automatic recovery is admitted only when both the window and adaptive backoff allow it. Backoff starts at 5 seconds, doubles after consecutive failures, and caps at 5 minutes; a successful refresh clears it. Explicit user refresh is exempt from freshness and backoff limits but remains single-flight.

These are **external-call budgets**, not browser polling intervals. A REST request that returns `fresh`, `joined`, `budget`, or `backoff` does not issue another `git fetch` or PR fast-state command. Active demand can refresh a PR record at the shorter window even if sidebar readers share that record.

Opening Git status requests visibility revalidation and full untracked status. It returns or joins fresh/in-flight remote work rather than forcing another fetch; the explicit refresh control is the forced path. After a canonical fetch, each bound worktree recomputes local status independently. This preserves per-worktree dirty and untracked files while making fetched refs consistent.

Staff Git triggers run on their existing 60-second tick. Before comparing a configured ref, they await the same repository record's eligible refresh. A stale or failed result suppresses the trigger rather than comparing in an uncertain order. Remote changes are therefore visible on the next tick without creating a staff-only fetch stream, and commit subjects are not copied into staff prompts.

## Failure and offline behavior

The coordinator retains the last successful `data` and `refreshedAt` across transient failures. The next response and completion frame expose that data with `stale: true`, its increasing age, and one safe error category. The UI can preserve useful status and offer explicit refresh instead of clearing the widget or PR badge.

Cold failures have no data to retain. They produce a stale snapshot with no `refreshedAt`; the UI should render its unknown/loading or unavailable state rather than inventing an empty repository or "no PR" result.

Error categories are intentionally coarse:

- `offline` — network, name-resolution, timeout, or unreachable failures;
- `auth` — authentication, credentials, or permission failures;
- `rate_limited` — primary or secondary GitHub throttling;
- `unavailable` — all other refresh failures.

Automatic reads do not run timer-driven retries. Later eligible demand retries after the call budget and backoff permit it. Explicit refresh can attempt recovery sooner. Local-only repositories stay fetch-free, and non-GitHub repositories do not acquire a PR record.

## Security and redaction boundary

Canonical keys and aliases never cross the coordinator boundary. REST, WebSocket, and telemetry output must not contain:

- tokens, usernames/passwords, or credential-bearing remote URLs;
- Git common directories, worktree paths, commands, or subprocess stderr;
- internal head selectors, raw/private refs, or canonical record keys;
- PR review bodies or raw GitHub responses; or
- raw exception text.

Public `data` is limited to the existing entity-authorized Git status or PR fast-state projection. A safe PR URL may be present, but never its credential-bearing remote form.

The structured server log line prefixed with `[remote-state]` uses a closed telemetry shape. Normal logs emit only actual `failure` and `identity_failure` outcomes; successful and routine lifecycle outcomes are suppressed. Setting `BOBBIT_DEBUG=1` temporarily restores the full lifecycle stream for diagnosis. Logged events contain only source, outcome, timestamps, cadence/intent, queue and duration measurements, age/staleness, a one-way record digest, and a safe error category. Telemetry sinks are best-effort: failure or exception in diagnostics cannot strand a refresh or queue permit.

Broadcasts are entity-addressed. Session and goal completions go only to their authorized sockets. Sidebar completions use the UI viewer channel; restricted sandbox credentials do not receive unrelated global sidebar state. A client must never receive the private canonical identity needed to address coordinator state directly.

## Troubleshooting

### Status stays stale

1. Inspect snapshot metadata. No `refreshedAt` means the record has never succeeded; an old `refreshedAt` with `lastError` means last-good retention is working.
2. Check the default `[remote-state]` failure or `identity_failure` line for the same one-way `record` digest. For deeper diagnosis, temporarily set `BOBBIT_DEBUG=1` to expose the complete outcome stream:
   - `fresh` — no refresh was needed;
   - `joined` or `coalesced` — another caller owns the equivalent work;
   - `budget` — an automatic attempt already consumed the freshness window;
   - `backoff` — recent failures are delaying automatic recovery;
   - `queued` — another canonical key holds a concurrency permit;
   - `started` followed by `success` or `failure` — an external attempt ran;
   - `identity_failure` — repository identity could not be resolved safely.
3. Use the explicit refresh affordance when immediate recovery is required. Do not add a client-side `git fetch` or `gh` fallback.
4. Diagnose credentials or connectivity using the snapshot category and host-scoped configuration. Do not add raw error or remote logging to make diagnosis easier.

A stale response immediately after a successful Git mutation can be expected: invalidation retains the 30-second automatic budget. Explicit refresh bypasses that budget.

### External call count is too high

Temporarily set `BOBBIT_DEBUG=1`, then count `started` events by `source` and record digest rather than REST requests. Multiple clients should produce `fresh` or `joined`, not extra `started` events. Separate explicit user actions from automatic traffic, because explicit refresh is intentionally outside the automatic budget. Remove debug mode after diagnosis so routine lifecycle events remain out of normal server logs. Also account for the deferred lifecycle and verification paths below; they remain outside this coordinator.

### Surfaces disagree after completion

Confirm the server emitted one addressed `remote_state_snapshot` completion and that each client applied it without issuing a follow-up read. For sibling worktrees, verify the canonical fetch is shared but the entity-local status projection is recomputed per worktree. Sharing the complete Git status payload would leak dirty/untracked state between siblings.

### Staff trigger misses a remote change

Check whether the repository snapshot returned stale or with `lastError`; either condition intentionally suppresses comparison and firing. Then verify the configured ref resolves after fetch. Do not fall back to commit-subject text or fire from a stale comparison.

## Deliberately deferred paths

This focused coordinator does not change:

- worktree or sandbox lifecycle and recovery;
- default-branch detection;
- verification fetches or `ls-remote` checks;
- publication, archive, session cleanup, or explicit Git/PR action semantics;
- permission and ruleset caches;
- marketplace caching;
- PR Walkthrough data-fetch and review lifecycle (it shares the effective-host resolver, but not coordinator records); or
- other broad lifecycle and secondary GitHub surfaces.

Those paths may still perform their established remote calls and are not evidence that the automatic status budget was violated. Do not route them through this coordinator without a separate lifecycle and security design.

## Verification seams

The contract is pinned with deterministic clock and injected command/GitHub fixtures rather than real network access. Coverage includes canonical identity and redaction, timestamps and stale-while-revalidate behavior, force and invalidation races, last-good retention and backoff, bounded concurrency, sibling worktrees, route and WebSocket fanout, staff ordering, multiple clients, visibility return, explicit recovery, local-only repositories, trusted enterprise hosts, multi-repository projects, and sandbox isolation.
