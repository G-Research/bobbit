# LSP product tool group — design (F6 / F6-diagnostics)

**Status**: design only, no implementation in this PR. This document is the deliverable.

Finding F6 (Fable audit program): Bobbit's spawned agents have no LSP-backed code
navigation — there is no `defaults/tools/lsp/` (or `code/`) tool group and no
`src/server/lsp/`. Finding F6-diagnostics is the companion gap: no productized
per-file diagnostics either. Meanwhile real prior art already exists in-repo:
`scripts/lsp-cli.mjs` is a working, documented, one-shot JSON-RPC client for
`typescript-language-server --stdio` with `symbols`/`workspace`/`refs`/`def`/`hover`
subcommands (see [`../dev-workflow.md`](../dev-workflow.md) and
[`.claude/skills/orient/SKILL.md`](../../.claude/skills/orient/SKILL.md)) — but it is
meta-development tooling only (a Bash-only fallback for subagents that lack the
interactive `LSP` tool), has no `diagnostics` subcommand, and was never productized
as a tool group any shipped agent role can use.

**This is not a green field.** [`code-intelligence.md`](code-intelligence.md) (status:
"design accepted, not started", workstream **CI** in
[`fable-program-execution-plan.md`](fable-program-execution-plan.md)) already commits
to a much larger version of this: CI-3, an "LSP supervisor" built on
`vscode-jsonrpc` + `vscode-languageserver-protocol`, multi-language via per-language
descriptor packs (vtsls, basedpyright, gopls, rust-analyzer, …), idle-shutdown,
post-edit diagnostics push, exposed as a `code_*` tool group under capability
`code.symbol-nav`. Two things are worth stating plainly before going further:

- CI-3 is unchecked in the program tracker (`fable-program-execution-plan.md`'s
  own checklist: "CI: [ ] CI-1 · [ ] CI-2 · [ ] CI-3 · …"), and the two docs it
  names as its own execution authority —
  `code-intelligence-implementation-plan.md` and `code-intelligence-alternatives.md`
  — do not exist in this checkout. CI-3 today is a named intent inside a large
  program design, not an executable plan.
- `code-intelligence.md` §2 designs the *destination* (multi-language, a real
  supervisor library, post-edit diagnostics, a services chip). It does not answer
  the concrete lifecycle/reuse/rollout questions a first PR needs — that's this
  document's job.

**This document is the narrowest possible wave 0 of CI-3**: TS-only, built by
extracting `scripts/lsp-cli.mjs`'s already-proven tsserver client (not the
vscode-jsonrpc multi-language supervisor CI-3 eventually wants), productized as a
first-party tool group so coder/architect/reviewer agents get `code_definition`/
`code_references`/`code_hover`/`code_symbols` now, without waiting on CI-3's
multi-language pack ecosystem. Every recommendation below is shaped so CI-3's later
multi-language/diagnostics/repo-map expansion is a strict superset addition, not a
rewrite — naming and tool shapes deliberately match `code-intelligence.md` §2 so a
future backend swap doesn't require a second tool-rename migration.

---

## Recommendation

1. **Lifecycle** (§1): one tsserver instance per `(worktreeRoot, languageId)`,
   owned by the gateway, lazily spawned on first call, idle-shutdown after a
   short TTL. Not per-session (too many, too much redundant project-load cost),
   not per-project (wrong for a codebase that runs 10+ concurrent worktrees per
   project with independent tsconfig/branch state).
2. **Tool surface** (§2): wave 1 ships `code_definition`, `code_references`,
   `code_hover`, `code_symbols` — the four operations `lsp-cli.mjs` already
   proves reliable. Diagnostics is out (§5). All four get a hard result cap +
   spill marker; LSP responses (especially `references` on a hot symbol) can be
   large.
3. **Language scope** (§3): TS-only in wave 1 via tsserver. The wave-1
   implementation isolates TS-specific spawn/init behind a narrow client
   interface so CI-3's pluggable multi-language layer is an additive swap
   later, not a rewrite.
4. **Reuse** (§4): **extract** `scripts/lsp-cli.mjs`'s JSON-RPC client and
   formatting helpers into `src/server/lsp/`; do **not** wrap-and-spawn the CLI
   per call (defeats the whole point of a warm instance) and do not build
   fresh (the file already paid for non-obvious tsserver gotchas worth
   keeping).
5. **Diagnostics** (§5): **not in wave 1.** `lsp-cli.mjs` deliberately has no
   diagnostics subcommand, `code-intelligence.md` §5 already designs a better
   answer to "did my change work" (`code_check` over real project checkers,
   not LSP push-diagnostics), and a second, sometimes-disagreeing diagnostics
   story is a correctness-trust risk not worth taking before `code_check`
   exists.
6. **Failure/fencing** (§6): fail open, always. Missing tsconfig, giant repos,
   tsserver crashes, and (for now) sandboxed sessions all degrade to a fast,
   typed "unavailable" tool result — never a hang, never a crash, never a
   silently-stale answer.
7. **Rollout** (§7): three waves — (1) supervisor + 4 nav tools, TS-only, host
   sessions only; (2) sandboxed-session support + TTL/ceiling hardening; (3)
   diagnostics decision + multi-language pack seam, revisited jointly with
   `code_check`'s design. Each wave ships with unit tests for the extracted
   pure functions plus an API/browser E2E driving a real tool call through a
   real session.

---

## 1. Server lifecycle

Three shapes, evaluated against how Bobbit actually runs TS projects:

**(a) One tsserver per project.** Cheapest — one instance total. Wrong for this
codebase: Bobbit routinely runs many concurrent worktrees per project (the
`orient` skill's own graphify section: "we run 10+ worktrees concurrently"),
each with independent on-disk state and potentially a different branch's
`tsconfig.json`. A single per-project instance would serve one worktree's
results to sessions working in a different worktree entirely. `lsp-cli.mjs`
already made this call explicitly: it resolves the workspace root as "the git
toplevel of the target file (worktree-safe: a file in a worktree gets that
worktree's own tsconfig, not the primary checkout's)" — reusing its client
without reusing that design decision would be a regression.

**(b) One per session.** Matches session/worktree cwd, but sessions are cheap
and numerous — a role spawn, a delegate, a team member all get their own
session, and several of them commonly share the same worktree (e.g. a coder
and its own delegate). tsserver project load is genuinely expensive:
`lsp-cli.mjs`'s own comment states cold semantic queries can take "~30s" under
load, and its default poll timeout is 60s. Paying that once per session
instead of once per worktree multiplies the cost by however many sessions
touch that worktree, for zero benefit (they'd all load the identical project).

**(c) One per `(worktreeRoot, languageId)`.** Matches the actual invalidation
unit: a worktree is one checked-out tree; tsserver's project model is keyed on
tsconfig + on-disk file contents, which *is* the worktree's state. Sessions
sharing a worktree share the instance for free. This is also the granularity
`WorktreePool` already uses for its own expensive-resource pooling (per
[`warm-pi-process-pool.md`](warm-pi-process-pool.md) §2.3's analogous
per-project map-of-pools shape), and it's a direct generalization of
`lsp-cli.mjs`'s existing git-toplevel resolution.

**Recommendation: (c).** For wave 1 (TS-only, §3) this collapses to a single
`Map<worktreeRoot, TsServerInstance>` owned by the gateway.

**Startup cost vs. staleness.** With per-worktree keying, the ~30s cold-load
cost is paid once per worktree lifetime (worktrees persist for a whole goal,
not a single tool call), not once per session or call. An idle-shutdown TTL
(recommend ~10 minutes, matching the idle-shutdown default `code-intelligence.md`
§2 already names for its own future supervisor) bounds resident memory —
otherwise `worktreeCount × languageCount` idle tsserver processes accumulate
with no eviction, the same "pool-key explosion" risk
[`warm-pi-process-pool.md`](warm-pi-process-pool.md) §7 flags for pi processes
(TS-only wave 1 means `languageCount = 1`, so this is a single dimension for
now). Staleness of file *contents* is not Bobbit's problem to solve — tsserver
watches the filesystem itself and picks up edits automatically. The one
staleness case Bobbit must own is a `WorktreePool.claim()` rename/move
(`warm-pi-process-pool.md` §3: claim renames the pool entry's branch and moves
its directory *before* returning it): a tsserver pre-warmed against a pool
entry before claim would be watching the wrong (soon-to-be-renamed) path
afterward. Recommendation: never pre-warm against pool worktrees; spawn
tsserver lazily on the **first** `code_*` call for a given `worktreeRoot`,
which by construction happens after claim/rename. This accepts the same
first-call latency `lsp-cli.mjs` already accepts today, in exchange for zero
new staleness surface in wave 1.

**Sandboxing interaction.** Sandboxing is being redesigned separately at
per-project/per-Bobbit granularity. Sandboxed sessions run inside a Docker
container via `docker exec` (`rpc-bridge.ts`, cited in
`warm-pi-process-pool.md` §6) — tsserver needs to see the *same* filesystem
view as the agent, so a host-side tsserver cannot serve a sandboxed session
without a mount-path translation layer that doesn't exist. The lowest-risk
answer, once this is tackled (wave 2, §7), mirrors
`warm-pi-process-pool.md` §6(a)'s already-confirmed pattern for pi processes:
run tsserver *inside* the same long-lived per-project pool container the
sandboxed session already execs into, keyed by `(worktreeRoot, containerId)`
— no new container lifecycle, just another idle process inside infrastructure
that already exists for this reuse pattern. Wave 1 does not need this: per
§6's fail-open discipline, "no LSP for sandboxed sessions yet" is an
acceptable, explicit gap, not a blocker.

---

## 2. Tool surface & token economy

`lsp-cli.mjs` proves five operations work reliably against tsserver: `symbols`
(single-file `documentSymbol`), `workspace` (project-wide `workspace/symbol`,
pre-warmed against the anchor file), `refs` (`textDocument/references`), `def`
(`textDocument/definition`), `hover` (`textDocument/hover`). No `diagnostics`.

**Recommend wave-1 tool set**, named to match `code-intelligence.md` §2's
already-chosen tool names so a later backend swap to the CI-3 supervisor is not
also a tool-rename migration for every role prompt/guideline that references
them:

| Tool | Backing LSP method | Notes |
|---|---|---|
| `code_definition` | `textDocument/definition` | 1:many locations |
| `code_references` | `textDocument/references` | can be large on hot symbols |
| `code_hover` | `textDocument/hover` | type/doc text, can be large on complex generics |
| `code_symbols` | `textDocument/documentSymbol` (+ optional `query` → `workspace/symbol`) | single tool, query param picks project-wide mode, matching `lsp-cli.mjs`'s own `workspace` warm-then-poll two-step |

**Token economy.** LSP responses are not bounded — `code_references` on a
symbol from a high-coupling file (`server.ts` alone has a documented coupling
score of 144 in the fable-refactor codemap) can return hundreds of locations;
`code_hover` on a deeply generic type can return multi-KB of expanded type
text. Recommend the same cap-and-spill convention `code-intelligence.md` §8
already commits the wider workstream to: a hard cap per result list (order of
50 locations for `code_references`/`code_symbols`, an order-of-KB cap on
`code_hover` contents), with an explicit `{ truncated: true, totalCount }`
marker rather than silent truncation — never drop the count. Render relative,
worktree-safe paths, reusing `lsp-cli.mjs`'s existing
`formatLocationWithWorkspace` verbatim (it already strips the worktree root
and falls back to an absolute path only when the result genuinely lives
outside the workspace). The closest in-repo precedent for "compact
one-line-per-result, cap the list, keep the total" is the `search` tool in
[`defaults/tools/harness/extension.ts`](../../defaults/tools/harness/extension.ts):
`${hits.length} of ${total} result(s):` followed by compact lines — the new
`code_*` tools should follow the same shape.

---

## 3. Language scope

**TS-only in wave 1**, via tsserver as `lsp-cli.mjs` already uses it.
`code-intelligence.md` §2 designs the multi-language future in real detail: a
generic `vscode-jsonrpc`/`vscode-languageserver-protocol` client, per-language
descriptor packs (`lsp-typescript`, `lsp-python`, …), manifest-based
autodiscovery, and a UI path for "install the missing language pack." That is
real, non-trivial work — a client abstraction, a registry, and an acquisition
story per language — with no current evidence inside this program of Python/
Go/Rust demand from Bobbit's own agent workflows (Bobbit is itself a TS
project; the F6 finding is specifically about TS navigation for a TS
codebase's own coder/architect/reviewer agents).

Recommend structuring wave 1 so the seam CI-3 eventually needs stays cheap to
add: keep the TS-specific pieces — the `typescript-language-server` spawn
command, the `useSyntaxServer: never` initialization option (§4 explains why
this one line matters), `languageIdFor()`'s extension mapping — behind the same
narrow interface `lsp-cli.mjs`'s own `LspClient` class already is (spawn,
`request`, `notify`, nothing TS-specific in the class itself). Swapping the
concrete language server later is then a different spawn command + init
payload behind the same interface, not a rewrite of the tool-facing code.

For non-TS projects (or a TS project with no resolvable `tsconfig.json`): the
tool group must detect this and report a clear, structured "unavailable" — see
§6 — rather than spawning tsserver into a project it can't meaningfully serve.

---

## 4. Reuse: wrap the CLI, extract its guts, or start fresh

**(a) Wrap `scripts/lsp-cli.mjs` as-is, spawning it as a subprocess per tool
call.** Cost per call: a fresh `typescript-language-server` process, a fresh
`initialize` handshake, and — critically — a fresh tsserver project load,
because `lsp-cli.mjs`'s `main()` spawns, queries, and tears down
(`shutdown`/`exit`/`proc.kill()`) inside a single invocation with nothing
persisted across calls. That is the ~30s-under-load cost from §1, paid on
**every single tool call** instead of once per worktree lifetime — it defeats
the entire reason for a warm per-worktree instance. This is the right shape
for what the CLI is actually used for today (a rare, one-shot query from a
Bash-only subagent session), and wrong for a chat-turn-latency product tool.
Rejected for the product surface.

**(b) Extract `lsp-cli.mjs`'s guts into `src/server/lsp/` as a persistent,
gateway-owned service.** Reading the file end to end, almost none of it is
CLI-specific: `LspClient` (JSON-RPC-over-stdio framing, `request`/`notify`,
pending-map, notification handling) has zero dependency on being a one-shot
process; `flattenSymbols`, `symbolKindName`/`SYMBOL_KIND_NAMES`,
`formatLocation`, `formatLocationWithWorkspace`, `formatWorkspaceSymbol`,
`languageIdFor`, `isEmptyResult`, and `pollQuery` are all pure functions that
work identically against a long-lived client as a one-shot one. What changes
in the extraction: replace `main()`'s spawn-per-call-then-shutdown with a
supervisor (§1) that keeps one `LspClient` + process alive per worktree,
issues `didOpen` once and `didChange` incrementally instead of `didOpen` once
per process lifetime, and exposes `def`/`refs`/`hover`/`symbols` as callable
methods instead of argv-parsed subcommands. Two non-obvious things the
extraction must **keep**, not rediscover:
- The `useSyntaxServer: never` initialization option
  (`lsp-cli.mjs`'s own comment: "Critical: without this, a partialSemantic
  sidecar answers requests with single-file results while the full project is
  still loading") — a real bug the CLI already paid to find.
- The empty-result polling semantics (`isEmptyResult`/`pollQuery`) — tsserver
  can accept a request and answer `[]`/`null` while the project is still
  indexing, before genuinely returning nothing; a naive single-shot request
  would misreport "no references" during warmup.

**(c) Fresh implementation.** Rejected — every advantage of (b) (JSON-RPC
framing, worktree-safe root resolution, the two gotchas above) would have to
be rediscovered for no benefit.

**Recommendation: (b).** `scripts/lsp-cli.mjs` is not deleted or replaced — it
remains the documented Bash-only subagent fallback exactly as
[`../dev-workflow.md`](../dev-workflow.md) describes today. The cleanest split
avoiding drift between the two: move `LspClient` and the formatting helpers
into a shared module under `src/server/lsp/` (e.g. `src/server/lsp/client.ts`),
have both the new gateway supervisor and `scripts/lsp-cli.mjs` import from it,
and layer the one-shot CLI behavior (spawn → query → shutdown) and the
persistent supervisor behavior (spawn once → serve many queries → idle-shut
down) as two thin callers of the same core.

---

## 5. Diagnostics half (F6-diagnostics)

`lsp-cli.mjs` deliberately ships no `diagnostics` subcommand. Its own comment
on `_onMessage` is explicit about why: *"Notifications (diagnostics, logs,
etc.) are ignored — this CLI runs one query and exits; it does not surface
server-side diagnostics."* This is a real structural mismatch, not an
oversight: tsserver pushes diagnostics asynchronously via
`textDocument/publishDiagnostics` notifications on its own schedule after
`didOpen`, not as a request/response pair — there is no "diagnostics are done
computing" signal to poll the way `pollQuery` polls a request's response.

**Recommend not shipping this in wave 1**, for three reasons:

1. `code-intelligence.md` §5 already designs a different, arguably better
   answer to the same underlying need ("did my change work"): `code_check(scope)`
   runs the project's *actual* checkers (`tsc --noEmit`, eslint, etc.) and
   returns typed, parser-normalized results — not LSP push-diagnostics, which
   reflect the language server's live in-memory model and can disagree with
   the real compiler invocation at the edges (config resolution, project
   references). Building a second, competing diagnostics story ahead of that
   design risks giving agents two different answers to "is this broken."
2. AGENTS.md already establishes `npm run check` as the canonical
   whole-project verification gate every session runs before restart/commit.
   A per-file LSP-diagnostics tool that sometimes disagrees with it is a
   correctness-trust risk not worth taking for a wave-1 nice-to-have.
3. Implementation risk is materially higher than `def`/`refs`/`hover`/`symbols`:
   those are plain request/response; diagnostics require subscribing to async
   notifications, keeping per-file diagnostic state, and deciding when it's
   "settled" enough to answer a tool call — a different, harder shape than
   anything `lsp-cli.mjs` already proved.

The genuine appeal of per-file incremental diagnostics — fast feedback on an
in-progress edit before running the full project check — is real, but its
value is already substantially covered today by the existing whole-project
gate. Recommend deferring the diagnostics decision to wave 3 (§7), made
jointly with `code_check`'s own design once that is closer to landing, rather
than building two diagnostics stories in parallel now.

---

## 6. Failure / fencing

Fail-open, unconditionally: an LSP problem must degrade a session's tool
surface, never break the turn.

- **Missing `tsconfig.json` / non-TS project.** tsserver can still start with
  no project context, but `workspace/symbol` and cross-file `refs`/`def`
  degrade silently to poor or empty results — a bad failure mode because it
  looks like a real (negative) answer. Recommend detecting this up front
  (search for a `tsconfig.json` from the target file's directory up to the
  worktree root — the same style of resolution `lsp-cli.mjs`'s `gitToplevel`
  already does for the workspace root) and returning a structured
  `{ available: false, reason: "no tsconfig.json found under <worktreeRoot>" }`
  before ever spawning tsserver, rather than spawning it and returning a
  confusing empty result. This also matches a caveat the `orient` skill
  already documents: "most of `tests/**` isn't covered by any
  `tsconfig.json`, so project-wide `refs`/`def` won't resolve there" — that's
  an existing, known gap this tool group inherits, not a new one.
- **Giant repos / cold-start latency.** Keep `lsp-cli.mjs`'s existing bounded-
  timeout-with-internal-polling discipline (its default is 60s). A warm
  per-worktree instance (§1) only pays the full cold cost on the first call
  after worktree creation, so a shorter default timeout is defensible for
  every call after the first. On timeout, return a typed, retryable error
  (tsserver is very likely done loading by the next call) rather than hanging
  the tool call indefinitely.
- **tsserver crash mid-session.** The supervisor's process `exit`/`error`
  handlers must mark that worktree's instance dead immediately and respawn
  lazily on the next call — mirroring the discipline
  `warm-pi-process-pool.md` §7 already applies to pi processes ("an exited
  process is never silently reused"). Never serve a result from, or silently
  retry against, a dead handle.
- **Sandboxed sessions, before §1's wave-2 support lands.** Detect the session
  is sandboxed and return `{ available: false, reason: "LSP not yet supported
  for sandboxed sessions" }` — an explicit, documented gap, never a hang.
- **General shape.** Every failure path returns a fast, typed, non-throwing
  tool result (`isError: true` + a short message), matching the existing
  `orient`/`search` tool error shape in
  [`defaults/tools/harness/extension.ts`](../../defaults/tools/harness/extension.ts).
  A broken or unavailable LSP setup should read to the agent as "no `code_*`
  tools available right now, use grep instead," never as a session-breaking
  error.

---

## 7. Staged rollout

**Wave 1 — minimal, this design's actual proposal:**
- `src/server/lsp/` extracted from `scripts/lsp-cli.mjs` (§4): shared
  `LspClient` + formatters, one `TsServerSupervisor` keyed by worktree root
  (§1), lazy spawn on first call, idle-shutdown TTL.
- `defaults/tools/code/` tool group: `code_definition`, `code_references`,
  `code_hover`, `code_symbols` (§2), following the `harness`/`images` group's
  YAML + `extension.ts` shape (tool YAML for prompt/docs metadata, a proxying
  `extension.ts` that talks to a gateway-owned service — here `TsServerSupervisor`
  instead of an HTTP round trip, since the supervisor lives in-process on the
  gateway).
- **No role-file changes needed.** `coder.yaml`/`architect.yaml`/
  `reviewer.yaml`/`code-reviewer.yaml`/`security-reviewer.yaml` only deny
  specific state-mutating tools (`gate_signal`, `goal_*`, `edit` for
  architect) — they do not allowlist tool groups, so a new default-allow group
  becomes usable by every shipped role the moment it merges, with zero role
  changes. (`pr-reviewer.yaml`'s group-deny-by-default pattern is the
  documented exception for a locked-down reviewer role, not the norm — it
  would need an explicit deny added if `code_*` should stay out of that one
  role, a one-line follow-up, not part of this design.)
- TS-only, host sessions only. No diagnostics.
- **Verification:** unit tests (`file://` fixtures per repo convention) for
  the extracted pure functions in `src/server/lsp/` (formatters, symbol
  flattening, empty-result detection) plus at least one API E2E
  (`tests/e2e/*.spec.ts`) driving a real `code_definition`/`code_references`
  call through a real session against a small fixture TS project inside a
  spawned gateway. A browser E2E is not required for wave 1's plain-text tool
  output (no renderer is added yet); add one if/when a `code_*` renderer
  ships, per AGENTS.md's "every user-facing feature MUST have a browser E2E"
  rule for whatever surface actually renders.

**Wave 2 — hardening:**
- Sandboxed-session support: tsserver inside the same long-lived pool
  container the sandboxed session already execs into (§1), keyed by
  `(worktreeRoot, containerId)`.
- TTL tuning and a resident-instance ceiling once real idle/claim patterns are
  observable — the same "pool-key explosion" risk class
  `warm-pi-process-pool.md` §7 names for pi processes, one dimension only
  while TS-only.
- Measure real cap/spill frequency against actual agent usage (CE ledger, per
  `code-intelligence.md` §8's own stated success metric) before assuming the
  wave-1 cap sizes are right.

**Wave 3 — expansion, only after waves 1–2 prove out:**
- Diagnostics decision (§5), revisited jointly with `code_check`'s design —
  most likely folded into `code_check` rather than shipped as a separate
  LSP-diagnostics tool.
- Pluggable multi-language layer per `code-intelligence.md` §2's already-
  designed descriptor-pack model (`lsp-typescript`, `lsp-python`, …) — at this
  point `src/server/lsp/`'s TS client becomes the TS-specific pack behind
  CI-3's generic supervisor, not something replaced by it.

Each wave is independently shippable and revertible, matching
`warm-pi-process-pool.md` §8's own staged-design discipline in this repo:
wave 1 alone, with a single TS-only worktree-keyed instance and a short TTL,
is a complete, low-risk first PR that proves the mechanism end-to-end before
any sandbox or multi-language question is touched.
