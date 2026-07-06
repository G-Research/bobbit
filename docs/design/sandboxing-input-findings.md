# Sandboxing workstream: consolidated isolation findings (input, not a fix plan)

> **REPORT-ONLY by AJ's standing decision (ADDENDUM #29, 2026-07-05).** A separate, robust
> sandboxing solution is being built outside the Fable refactor program; eventually every
> session runs inside it. Findings in the class "a non-sandboxed agent can reach shared host
> state" are documented here for that workstream to consume — **no product guards were shipped
> against any of them** ahead of that work (no auto-revert hooks, no cwd fencing, no header
> hardening). Forensics/diagnostics additions in tests remain fine and are noted where they
> exist. Docker-sandbox-mode *correctness* bugs are real bugs and out of scope for this
> document — it covers only the fencing gaps of the trusted, non-sandboxed execution mode.
>
> AJ has separately decided sandbox granularity will be **per-project or per-bobbit, not
> per-session** — agents within a project (e.g. a reviewer and the builder it's reviewing)
> will continue to share one contained environment even after the workstream lands. Each
> finding below states what that granularity would and wouldn't change.
>
> Sources: `~/Documents/dev/bobbit-fable-refactor/TRACKER.md`, `FINDINGS.md`,
> `RECONCILIATION-2026-07-05.md`, `FABLE-PROMPT.md` (ADDENDUM #29), and PR #147 / #192 on
> `ajonkisz/bobbit`. Every file:line citation below was re-verified against the live
> `aj-current` tree as of this writing.

## 1. Internal MCP routes trust `X-Bobbit-Session-Id` with no secret check

**Statement.** `POST /api/internal/mcp-call` and `POST /api/internal/mcp-describe` resolve
the acting session purely from a client-supplied `X-Bobbit-Session-Id` header. Every other
internal-authority path in the codebase (children-mutation authz, swarm routes, nested-goal
routes, pr-walkthrough routes) instead resolves the caller through
`SessionSecretStore.resolveSessionIdBySecret()`, which requires an unguessable per-session
secret rather than the session's own (often log-visible) id.

**Code evidence.**
- `src/server/routes/staff-mcp-operator-routes.ts:353-355` (mcp-call) and `:431-434`
  (mcp-describe): both read `req.headers["x-bobbit-session-id"]` directly and treat any
  string that maps to a known session (live or persisted) as authenticated — no secret,
  no signature, just a session-id string match via `sessionManager.getSession(...)` /
  `projectContextManager.getContextForSession(...).sessionStore.get(...)`.
- Contrast: `src/server/auth/session-secret.ts:77` (`resolveSessionIdBySecret`) is the
  pattern used everywhere else that needs to authenticate "which session is really calling
  this" — confirmed call sites at `src/server/server.ts:5454,5887,9187,10086,10230`,
  `src/server/agent/swarm-routes.ts:66,297`, `src/server/agent/nested-goal-routes.ts:249`,
  and `src/server/pr-walkthrough/routes.ts:1199`. The two mcp-call/mcp-describe routes never
  call it.

**Exploit/impact sketch.** Any caller with network access to the gateway's internal API
surface who can guess or observe a valid session id (session ids are not treated as secret
elsewhere in the product — they appear in URLs, logs, and UI state) can invoke MCP tools or
enumerate connected MCP server/tool metadata *as* that session, including tool-policy
resolution scoped to that session's role/project, without possessing that session's actual
capability secret.

**Sandbox granularity fit.** A per-project or per-bobbit sandbox does not mitigate this —
it's an authn/authz gap in the gateway's own route logic, not a host-escape the sandbox
boundary would contain. It matters regardless of where the calling process physically runs,
since the header is trusted at the HTTP layer before any process/container boundary is
consulted.

**Interim observability suggestion (non-fix).** Log a warning (session id, remote peer, tool
name) whenever `mcp-call`/`mcp-describe` resolves a session that does *not* match the
secret the same request would resolve via `resolveSessionIdBySecret` on its
`x-bobbit-session-secret` header, if present — cheap, additive, and would surface real
cross-session probing without changing trust behavior.

---

## 2. E-1: no enforced boundary keeps a non-sandboxed agent inside its own worktree

**Statement.** A non-sandboxed session's `bash` tool has no `cwd` parameter and no
enforcement preventing a `cd` out of its assigned worktree; the worktree root is a plain,
predictably-named filesystem sibling of the primary checkout. A real agent that leaves its
assigned directory and runs `git checkout -b <name>` in the sibling primary checkout can move
the primary checkout's HEAD to a stray branch — this reproduced twice against
`session-resilience.spec.ts`'s E-1 assertion (`feature-y`, `main`).

**Code evidence.**
- `defaults/tools/shell/bash.yaml:204-206`: "commands run in the session's working
  directory. Use `cd path && ...` within the command if you need to run from a different
  directory" — the tool's own documented affordance for leaving the assigned cwd, with no
  enforced fence.
- `src/server/skills/worktree-paths.ts:43-53` (`worktreeRoot`): when `project.worktreeRoot`
  is unset, worktrees default to `<rootPath>-wt/`, a discoverable sibling of the primary
  checkout root (`path.dirname(rootPath)` + `path.basename(rootPath) + "-wt"` — trivially
  found with `ls ..`).
- PR #147 (`ajonkisz/bobbit`, merged) independently re-swept the server-side surface and
  confirmed no server code path itself moves the primary checkout's HEAD: the only
  `git checkout -b`/`-B` in `src/` runs in a disposable staging dir
  (`sandbox-clone-source.ts`), never `repoPath`; `git worktree add -b` calls only
  create/checkout the *new* branch into the *new* worktree path (git's normal, non-mutating
  form); goal/child merges run in the parent's own worktree
  (`goal-manager.ts::mergeChild`), never the primary checkout; Docker-sandboxed sessions
  clone into an isolated named volume from a read-only snapshot, never a live mount of the
  primary checkout by default. PR #147's actual diff is test-only: 17 lines in
  `tests/manual-integration/session-resilience.spec.ts` that dump the primary checkout's
  `git reflog` (ISO timestamps) before the E-1 assertion throws, for forensics on the next
  natural reproduction — it changes no pass/fail behavior and touches no product code.

**Exploit/impact sketch.** A real coding agent doing ordinary, even tool-doc-encouraged
exploration can wander into the primary checkout (or another session's worktree) and mutate
shared git state — moving HEAD, leaving stray branches, or observing/altering another
session's in-progress work. This is agent-caused collateral damage from an unenforced
boundary, not an external attacker scenario; Docker-sandboxed sessions are structurally
immune (separate mount namespace).

**Sandbox granularity fit.** Per-project/per-bobbit sandboxing (agents in the same project
sharing one contained environment) *would* close the sibling-checkout attack surface for
the primary host checkout, because a project's whole worktree tree would live inside its own
container/namespace rather than as host-filesystem siblings — but it would **not** stop one
agent from wandering into a *sibling worktree of the same project* inside that shared
container, since granularity is per-project, not per-session. That residual (agent A `cd`s
into agent B's worktree within the same project's container) is the same class of problem at
one level down and isn't addressed by this decision.

**Interim observability suggestion (non-fix).** The reflog-forensics pattern from PR #147 is
itself the right non-fix data-gathering tool — consider extending it (still test/diagnostic
only) to log the cwd of every `bash` call whose command begins with `cd ` and a path
resolving outside the session's assigned worktree, to build an incidence rate before the
sandboxing workstream lands.

---

## 3. Warm-pool identity: baked env identity requires post-claim alias/rebind plumbing

**Statement.** The warm pi-process pool (wave 1, dark behind `BOBBIT_WARM_POOL`, PR #192)
pre-spawns idle non-sandboxed `exec`-class processes to skip ~0.6-1.5s of post-spawn
tool/extension-graph load. Several identity values are baked into a pooled child process at
spawn time with no RPC to change them post-claim: `BOBBIT_SESSION_ID`/
`BOBBIT_SESSION_SECRET`, and — found live via E2E trace, not anticipated by the design doc —
three generated extension files that embed the *pool's own placeholder* session id as a
`JSON.stringify(sessionId)` string literal at generation time. When a real session claims a
pooled entry, that entry is still running under the placeholder's baked identity, so any code
path that resolves "which session is this" from environment/embedded-literal state (rather
than from the pool's own bookkeeping) resolves to the wrong session unless explicitly
patched.

**Code evidence.**
- `src/server/agent/pi-process-pool.ts` — the pool implementation (claim/miss/replenish,
  mirrors `WorktreePool`'s shape).
- Id-baking at generation time: `src/server/agent/tool-guard-extension.ts:78`,
  `src/server/agent/provider-bridge-extension.ts:199`,
  `src/server/agent/google-code-assist-provider-extension.ts:102` — each writes
  `const sessionId = ${JSON.stringify(sessionId)};` (or `SESSION_ID = ...`) into generated
  extension code that runs inside the spawned child, under a content-hashed directory name,
  so the path differs per session even for identical role/tool-policy.
- Fix-side plumbing: `src/server/auth/session-secret.ts:109-116` (`SessionSecretStore.rebind`)
  re-points a capability secret from the placeholder id to the real claiming session's id so
  `resolveSessionIdBySecret` (used by orchestration authz, see Finding 1's citations) reports
  the live session, not the placeholder. `src/server/agent/session-manager.ts:4800-4808`
  documents `getSession()` itself resolving a placeholder→real-session alias map so the
  tool-guard extension's long-poll grant-request callback (which still carries the
  placeholder id baked into its generated code) reaches the correct session instead of
  404ing or resolving to the wrong one.
- PR #192's own body and its cross-referencing comment from the parallel "session-identity
  investigation" fork explicitly flag Finding 1 above as the concrete, live-reachable
  consequence of *not* rebinding: "`/api/internal/mcp-call` resolving policy by
  `X-Bobbit-Session-Id`... those internal mcp routes trust the session-id header with no
  secret check... [this is a] REPORT-ONLY note for the record... Logged for the sandboxing
  workstream per the standing report-only rule."

**Exploit/impact sketch.** This is primarily a correctness/isolation hazard rather than an
external attacker path: without the alias/rebind handling, a claimed pool entry could apply
tool-approval decisions, capability-secret authz, or grant-request routing against the wrong
(placeholder) session identity, effectively letting one session's request be evaluated under
a different session's context. PR #192 explicitly built the rebind/alias mechanism *because*
of this; the residual risk is any future code path added to the pool-eligible surface that
resolves identity from env/baked-literal state and forgets to consult the alias/rebind
layer — there's no structural guard preventing that omission today, only the two known call
sites patched.

**Sandbox granularity fit.** Per-project/per-bobbit granularity is orthogonal to this — the
identity-baking problem is about which *session* a pooled OS process is currently claimed by,
not which *project's* container it runs in. It would persist unchanged: a warm pool inside a
per-project sandbox still needs the same rebind/alias handling for any newly-claimed entry.

**Interim observability suggestion (non-fix).** PR #192 already logs pool hit/miss and key
computation; consider adding a one-line warning log whenever `rebind()` is called with a
`newSessionId` that already had a *different* prior secret (the "dead weight" case the
docstring calls out), since that specific transition is the shape most likely to indicate a
missed rebind elsewhere in a future change.

---

## 4. Reviewer sessions share the same worktree as the command track they're reviewing

**Statement.** Under the parallel-early-review optimization (`BOBBIT_PARALLEL_REVIEWS`,
measured in `RECONCILIATION-2026-07-05.md` §VER-07), reviewer sessions (`reviewer`,
`code-reviewer`, `bug-hunter` roles) spawn into the **same worktree directory** the command
track (build/check/unit/e2e) is concurrently writing to and executing in, because both
resolve `cwd` from the same goal fields.

**Code evidence.**
- `src/server/agent/verification-harness.ts:2044`: `const cwd = goal.worktreePath ||
  goal.cwd;` — the same resolution used for both the command track and reviewer spawns
  within one goal's verification phase.
- `defaults/roles/reviewer.yaml:4-17`: `toolPolicies` denies `edit`, `bash_bg`,
  `team_delegate`, `gate_signal`, and the `goal_*` mutation tools — but does **not** deny
  plain `bash`, `read`, or `grep`, and the role's own prompt template (line 49) explicitly
  instructs reviewers to `rg` the codebase for duplicated symbols. The same shape holds for
  `code-reviewer.yaml` and `bug-hunter.yaml` (not separately re-quoted here, but confirmed
  present in `defaults/roles/`).
- `src/server/agent/verification-logic.ts:704` (`isParallelReviewsEnabled`) and
  `verification-harness.ts:4182-4196` (`alreadyDoomed` gate) are the flag/gating code the
  measurement in `RECONCILIATION-2026-07-05.md:220-234` analyzed.

**Exploit/impact sketch.** A reviewer's own live `bash`/`rg`/`read` calls can observe
mid-build transient filesystem state (partially-written files, in-progress build artifacts)
in the shared worktree while the command track is still running. The precomputed VER-04 diff
artifact that reviewers are steered toward reading is immune to this (it's a static snapshot
computed once), so this is a **review-quality noise risk** — a reviewer might comment on
transient state that isn't part of the final diff — not a correctness or verdict-ordering
violation: read-only tool policy already prevents a reviewer from *corrupting* the command
track, and verdicts only commit on command-pass regardless of what a reviewer observed.

**Sandbox granularity fit.** This is the class AJ's per-project/per-bobbit decision directly
addresses and accepts: "reviewers/builders share the contained env... contamination =
quality-noise only, verdicts commit on command-pass" (`TRACKER.md:633`). A per-session
sandbox would eliminate the shared-worktree visibility entirely (reviewer gets an isolated
snapshot); the chosen per-project granularity deliberately does **not** — this finding is
the concrete, already-measured instance of the tradeoff AJ accepted, not a gap the
sandboxing workstream is expected to close.

**Interim observability suggestion (non-fix).** None needed beyond what already exists — the
measurement in `RECONCILIATION-2026-07-05.md` already quantifies and the pinned end-to-end
tests already cover the verdict-ordering guarantee that makes this acceptable.

---

## Ordering rationale

Findings are ordered by the concreteness and reachability of impact: (1) is a live,
network-reachable authn gap independent of any sandbox boundary; (2) is a confirmed,
reproduced instance of agent-caused shared-state mutation with a real forensic trail; (3) is
a correctness/isolation hazard that has already required one round of purpose-built
mitigation code and could recur in an unaudited future call site; (4) is a measured,
already-accepted quality-noise tradeoff with no correctness exposure.
