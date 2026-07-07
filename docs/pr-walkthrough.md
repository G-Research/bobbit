# PR Walkthrough — Agent Schema Reference

Reference for the reviewer agent's submission schema and hunk ID semantics, plus how a
finalized review reaches the real PR (posting via local `gh`), the launch-time trust
prompt for unknown remote hosts, and the `resolveAndReadBindingBundle` race-condition
fix. This complements the higher-level docs:

- [PR Walkthrough Panel](pr-walkthrough-panel.md) — launch flow, panel behavior, reviewer lifecycle.
- [PR Walkthrough Durable Reviews](pr-walkthrough-durable-reviews.md) — chunk submission, store layout, finalization, coverage model.
- [Post via local `gh` + trust-prompt (design)](design/pr-walkthrough-gh-posting.md) — deep architecture behind the two sections below.

---

## Posting reviews to GitHub via local `gh`

Once a reviewer finalizes a walkthrough, the human can post the assembled review — body
plus per-line comments — straight to the real PR from the panel's **Post to GitHub**
action (`data-testid="pr-walkthrough-post-github"` in the export-preview dialog). Bobbit
posts by shelling out to the **local `gh` CLI on the gateway host**, so it works for
whatever host and account the user authenticated with `gh auth login`, including GitHub
Enterprise.

### Availability

The post action is shown whenever posting is possible. The underlying credential is
resolved with a single cascade (`resolveGithubExportAuth` in `github-adapter.ts`):

1. an explicit token passed by the caller, then
2. `GITHUB_TOKEN` / `GH_TOKEN` from the environment — **github.com only**, an optional
   override, and never forwarded to an enterprise host, then
3. `gh auth token [--hostname <host>]` — the canonical path.

If any of these yields a credential, `export.available` is `true`. When none do, the
action stays visible but explains itself with an actionable reason: **"No GitHub
credentials found. Run `gh auth login` (or set GITHUB_TOKEN/GH_TOKEN) to post a
review."** This replaced the older, misleading "Set GITHUB_TOKEN or GH_TOKEN" message
that never mentioned `gh`.

**Why availability is gh-aware, not just token-presence:** previously `export.available`
was `Boolean(env token)`, and the pack's normal with-SHA launch path hardcoded
`available: false, previewOnly: true` — so a real GitHub PR reviewed through the pack
could never be posted even with a working `gh` login. Availability is now derived from
real auth on both the no-SHA and with-SHA resolution paths, so a normally-launched
walkthrough offers posting whenever `gh` can authenticate to the PR's host.

**Enterprise hosts** work via `gh auth login` to that host; posting adds
`--hostname <host>` so `gh` uses the host-scoped credential (the github.com env token is
never sent to an enterprise host). `BOBBIT_GH_COMMAND` overrides the `gh` binary and is
used by tests to stub it.

### Flow and why it is server-side

Posting must satisfy two orthogonal checks that live in different places:

- **Auth availability** — "is `gh` (or a token) authenticated for this host?" needs no
  gateway prefs, so it can be computed anywhere `gh` is on `PATH` (the server route or
  the confined pack worker).
- **Host trust** — "is this host allowed to be contacted at all?" reads the
  `githubTrustedHosts` preference, which **only the server** can access.

The end-to-end path:

```text
panel "Post to GitHub"
  → pack worker `submitReview` route (proxies with the gateway bearer token)
    → POST /api/pr-walkthrough/submit-review   (bearer-gated public route, routed by jobId)
      → assertTrustedBindingTarget            (server-side, prefs-backed trust gate)
      → submitGithubReview → gh api …/pulls/<n>/reviews --method POST
```

The `gh` invocation and the trust check stay **server-side** for two reasons: the
confined pack worker cannot read `githubTrustedHosts`, and the pack route worker inherits
the *gateway* process environment — not the reviewer session's — so it holds no session
secret to authenticate the internal tool endpoints. The worker therefore proxies to a
**bearer-authenticated public route** (`POST /api/pr-walkthrough/submit-review`, the same
auth tier as the existing export/submit route) routed by the `jobId` it holds from its
own binding. The server resolves the authoritative binding + target from that `jobId`,
enforces the trust gate, and only then posts.

Posting is a real external write, so it is double-gated: `submitGithubReview` requires
`confirm: true`, and the trusted-host check must pass. Local-only (non-GitHub)
changesets remain non-postable with their existing reason.

For the full architecture and rationale (temp-file `gh api --input`, the jobId-routed
binding resolution, and why no session secret is needed), see
[PR Walkthrough — Post via local `gh`](design/pr-walkthrough-gh-posting.md).

---

## Trusting an unknown remote host at launch

Launching a walkthrough against a host that is **not** already trusted now **prompts**
the user to add it, instead of silently failing later with a 403.

- `github.com` / `www.github.com` are always trusted and never prompt.
- The `run` route resolves the PR's host before spawning; for a non-default host with no
  acknowledgement it returns `HOST_NOT_TRUSTED` (carrying the resolved host + `prUrl`)
  **without spawning** anything.
- The client checks the host against the managed trusted list. If already trusted it
  re-invokes silently. Otherwise it prompts: on **accept** it persists the normalized
  host to the `githubTrustedHosts` preference (via `PUT /api/preferences`, the same write
  path Settings uses) and re-invokes the launch; on **decline** it aborts with a readable
  cancel message and nothing is spawned or persisted.

**Why prompt at launch rather than fail later:** the target host is only known after
`run` resolves the current-branch PR, and only the server can read the trusted list — so
the client cannot pre-check it. Returning `HOST_NOT_TRUSTED` from `run` hands the
resolved host back to the client (which owns the trusted-hosts UI) to make the decision.
The acknowledgement only governs whether the *harmless, read-only reviewer child* is
spawned; the real security boundary stays the server-side, prefs-backed trust check
applied when the diff is read and the review is posted, so a stale or forged ack cannot
widen data access.

Extra trusted hosts are managed in **System → General → Trusted GitHub hosts** (persisted
under `githubTrustedHosts`). See
[Trusted GitHub hosts](pr-walkthrough-panel.md#trusted-github-hosts) for the allowlist
model and [the design doc](design/pr-walkthrough-gh-posting.md) for the launch
trust-prompt mechanism.

---

## Hunk IDs — copy verbatim, never construct

Every hunk in the analysis bundle has a stable `hunk_id`. The compact manifest
format surfaces these IDs in the `hunk_manifest` for each file:

```text
h0  block:4:src__auth__session.ts:h0  @@ -42,7 +42,10 @@  (+3/-0)
h1  block:4:src__auth__session.ts:h1  @@ -88,5 +89,5 @@  (+1/-1)
```

**Always copy the `hunk_id` verbatim from the manifest or file-read output.** Never
construct or guess one.

Hunk IDs in the compact format follow the pattern `block:N:path__slug:hM`, where:

- `N` is the file's position in the **git diff output** — not the order you
  happen to read the files in during review. The block index is determined by git,
  not by the agent.
- `path__slug` is the file path with `/` and `.` replaced by `__`.
- `M` is the zero-based hunk index within that file.

**Why constructing IDs fails:** If you infer N from the order you read files, you
will get the wrong number for any file that is not first in the diff. The actual N
is only knowable from the manifest — `hunk_manifest[*].hunk_id` in the JSON
response, or the `hM  block:N:...` lines in compact text output. A constructed ID
that guesses the wrong N will fail resolution at finalization with
`PRW_HUNK_REF_UNRESOLVED`.

### Correct usage

```yaml
narrative:
  - id: session-expiry-diff
    type: diff
    hunks:
      - hunk_id: block:4:src__auth__session.ts:h0   # copied from manifest
        placement: primary
        why_relevant: Expiry guard added before persistence.
```

### What goes wrong when IDs are constructed

If the agent submits `block:1:src__auth__session.ts:h0` for a file that is
actually at position 4 in the diff, finalization cannot resolve the reference and
returns `PRW_HUNK_REF_UNRESOLVED`. The reviewer must correct the chunk and
finalize again.

---

## Severity enum for `suggested_comment` entries

Narrative entries of type `suggested_comment` require a `severity` field. The
valid values are:

| Value | Meaning |
|---|---|
| `blocking` | Must be addressed before merge. |
| `non_blocking` | Recommended fix, but does not block merge. |
| `question` | A clarification question for the author. |
| `nit` | A minor style or polish remark. |

`"info"` and any other value are **not valid** and will fail schema validation at
finalization (`PRW_SCHEMA_INVALID`).

```yaml
- id: clock-skew-concern
  type: suggested_comment
  severity: question          # one of: blocking | non_blocking | question | nit
  intent: inline
  anchor: { hunk_id: block:4:src__auth__session.ts:h0, line_range: "+15..+22" }
  body: Should this tolerate bounded clock skew before rejecting the token?
```

---

## Required field shapes

These three structures are the most frequently submitted incorrectly. Finalization
validates them; a wrong shape returns a retryable `PRW_SCHEMA_INVALID` error.

### `suggested_concerns[]` items

Every item in `suggested_concerns` at the card or decision level must have exactly
four fields:

```yaml
suggested_concerns:
  - severity: blocking           # blocking | non_blocking | question | nit
    concern: Short description of the concern.
    suggested_comment: The text of the comment to add to the PR.
    anchors: []                  # required; empty array is valid
```

**Common mistake:** sending plain strings or objects missing one or more fields.
All four fields — `severity`, `concern`, `suggested_comment`, and `anchors` —
are required. `anchors: []` (empty array) is valid when the concern is not tied
to a specific diff location.

### `diff_breakdown`

`diff_breakdown` is a mapping, not an array. Each key holds a sub-object with
optional stat fields:

```yaml
diff_breakdown:
  prod_executable_code:
    files: 3
    additions: 42
    deletions: 8
    note: Core session logic.
  test_code:
    files: 2
    additions: 65
    deletions: 12
  code_and_comments:
    files: 0
    additions: 0
    deletions: 0
  docs_only:
    files: 1
    additions: 5
    deletions: 0
```

Valid top-level keys are `prod_executable_code`, `test_code`, `code_and_comments`,
and `docs_only`. Each value is a mapping; `files`, `additions`, `deletions`, and
`note` are optional. Submitting `diff_breakdown` as an array of `{category, files,
…}` objects is invalid.

### `remaining_changed_areas`

`remaining_changed_areas` must be a **flat list of strings**, not a list of
objects:

```yaml
# Correct
remaining_changed_areas:
  - "src/server/agent/ — session respawn logic (plumbing)"
  - "tests/e2e/ — new E2E for session lifecycle"

# Wrong — objects are not allowed
remaining_changed_areas:
  - area: "src/server/agent/"
    description: "session respawn logic"
```

---

## `resolveAndReadBindingBundle` race condition fix

### What it is

`resolveAndReadBindingBundle` lazily resolves the git diff for a PR walkthrough
job the first time the reviewer calls `read_pr_walkthrough_bundle`. On the first
call it runs `git diff`, builds an analysis bundle, and saves it to
`WalkthroughAnalysisBundleStore` keyed by `jobId`. Subsequent calls load from
that cached file.

### The race

Without a guard, three concurrent `read_pr_walkthrough_bundle` calls for the same
`jobId` (which can happen when the reviewer starts and issues several tool calls in
parallel) all pass the `!bundleStore.load()` check before any one of them has
written the bundle. Each then independently runs `git diff` and saves — last write
wins. If git returns files in a different order on different runs (unlikely but
possible) the saved bundle's block indices diverge from what the first-call
response reported to the agent. The agent would then submit hunk IDs from the
first response while the cached bundle reflects a different ordering — causing
`PRW_HUNK_REF_UNRESOLVED` at finalization.

### The fix

`resolvingBundlePromises` is a module-level `Map<string, Promise<void>>` in
`src/server/pr-walkthrough/routes.ts`. The resolution path follows a
check-then-act pattern:

```ts
if (!bundleStore.load(binding.jobId)) {
    if (!resolvingBundlePromises.has(binding.jobId)) {
        const p = (async () => {
            if (bundleStore.load(binding.jobId)) return; // double-check after acquiring
            // ... resolve diff, build bundle, save ...
        })().finally(() => resolvingBundlePromises.delete(binding.jobId));
        resolvingBundlePromises.set(binding.jobId, p);
    }
    await resolvingBundlePromises.get(binding.jobId)!;
}
```

- The first concurrent caller creates the promise and adds it to the map.
- Every subsequent caller for the same `jobId` awaits the same promise instead of
  starting its own resolution.
- The double-check inside the promise guards against the window between the outer
  `!bundleStore.load()` and the inner start.
- `.finally()` removes the entry so the map does not grow unboundedly; once the
  bundle is on disk, `bundleStore.load()` succeeds and no new promise is created.

The result: the expensive `git diff` + bundle-build + disk-write path runs
**exactly once per `jobId`**, regardless of how many concurrent reads arrive at
launch time.

### Test coverage

`tests/pr-walkthrough-hunk-id-roundtrip.test.ts` covers both behaviors:

**Test 1 — Hunk ID round-trip:** creates a bundle from a minimal parsed diff with
an explicit hunk ID, reads that ID from the compact manifest, submits a review
chunk referencing it, and verifies that `finalize_pr_walkthrough_submission`
succeeds and the resolved card contains the correct hunk. This confirms that
`hunk_manifest[*].hunk_id` in the manifest is the same value the finalizer uses
for resolution — no format divergence.

**Test 2 — Concurrent resolution deduplication:** re-implements the
`resolvingBundlePromises` mutex pattern in isolation and launches three concurrent
resolutions for the same `jobId`. Asserts that the underlying "work" (the
equivalent of `git diff` + bundle build) runs exactly once, that all three
callers receive the same result, and that a cached second wave of concurrent calls
runs no work at all.
