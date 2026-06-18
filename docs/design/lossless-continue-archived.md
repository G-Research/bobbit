# Lossless Continue-Archived

## Problem

`POST /api/sessions/:archivedId/continue` currently rebuilds the archived
transcript by parsing the `.jsonl`, rendering it back to plain text via
`renderMessagesAsText` / `formatFullTranscript`, optionally summarising it
through the naming model, and injecting the resulting string into the new
session's system prompt as `seedContext`. The string is hard-capped at
`SEED_TOTAL_BUDGET = 4 * LARGE_CONTENT_THRESHOLD = 128 KB`
(`src/server/agent/continue-archived.ts:15`). Any non-trivial session is
truncated, hence the "This transcript is large (~N KB) and will be truncated"
warning in `ContinueSessionChooser` (`src/ui/components/ContinueSessionChooser.ts:170-178`).

Restart-resume already does the right thing for live sessions: it re-spawns the
agent CLI pointing at the existing `agentSessionFile` and issues
`switch_session` (`src/server/agent/session-manager.ts:2542-2551`) to make the
CLI rehydrate from the JSONL itself — full fidelity, no byte budget.

**Goal:** Continue-Archived behaves as if the user never archived. Clone the
source `.jsonl` into the new session's slot, persist it as the new session's
`agentSessionFile` *before* the agent CLI is spawned, and let the CLI rehydrate
from it the same way `restoreSession()` does.

## Out of scope

Per goal spec §7 / §non-requirements: worktree, cwd, and branch remain
fresh runtime state. The archived `worktreePath` and `branch` are provenance
only: Continue uses them to know the source was worktree-backed, but never
stats, repairs, revives, reuses, or checks them out. The cloned JSONL may
still reference paths from the old worktree — that's expected and matches
restart-resume conceptually. `restoreSession`, live-session restart, and the
agent CLI's JSONL reader are unchanged.

## Endpoint flow (current)

`POST /api/sessions/:archivedId/continue` (`src/server/server.ts`):

1. Resolve `ps = sessionManager.getPersistedSession(archivedId)`. Same
   guards as today: 404 if missing, 409 if not archived, 422 if
   goal/delegate/team, 410 if project unregistered. Assistant sessions are
   allowed and carry over `assistantType`, role, accessory, and proposal
   drafts.
2. **Resolve source JSONL path.** Use `ps.agentSessionFile`. If empty
   (legacy persisted sessions), fall through to
   `sessionManager.recoverSessionFile(ps)` — the same private helper
   `restoreSession` already calls (`session-manager.ts:2240`); promote it
   to public (`recoverSessionFile`) or expose a thin wrapper
   `resolveAgentSessionFile(ps): string | null` on `SessionManager`.
   Return **404 `{error: "archived transcript missing or empty"}`** if
   neither lookup succeeds.
3. **Compute new JSONL path.** Format must match what the agent CLI itself
   produces (see `recoverSessionFile`, `session-manager.ts:4170-4185`):
   ```
   <globalAgentDir()>/sessions/--<cwd-slug>--/<timestamp>_<newUuid>.jsonl
   ```
   where:
   - `globalAgentDir()` from `src/server/bobbit-dir.ts:42`.
   - `<cwd-slug>` = the new session's cwd (resolved via the same project
     `rootPath` logic the existing endpoint uses) with `/[^a-zA-Z0-9]/g`
     replaced by `-`. Wrapping is `--<slug>--` per `recoverSessionFile`.
   - `<timestamp>` = `new Date().toISOString().replace(/[:.]/g, "-")` to
     match the `2026-04-03T15-15-12-009Z` shape parsed at line 4187.
   - `<newUuid>` = `randomUUID()` from `node:crypto`.

   Helper: factor `formatAgentSessionFilePath(cwd, createdAt, sessionId)`
   into a new `src/server/agent/agent-session-path.ts` and have
   `recoverSessionFile` consume the parser side as a sibling. (Avoid
   duplicating slugification in two places.)
4. **Copy source JSONL to new path.** Sandbox-aware. See §"Sandbox copy
   strategy" below. Fail loudly: any copy error returns
   **500 `{error: "failed to clone session file: <msg>"}`** and we do
   *not* create the persisted session row.
5. **Copy lazy tool-content directory if present** — see §"Tool-content
   directory copy" below. **Important finding:** there is currently no
   on-disk `<stateDir>/tool-content/<sessionId>/` directory in the repo.
   Truncation is wire-only (`truncate-large-content.ts`), and
   `GET /api/sessions/:id/tool-content/:mi/:bi` reads via
   `session.rpcClient.getMessages()` which pulls from the live JSONL
   (`server.ts:6049-6055`). Cloning the `.jsonl` is therefore *sufficient*
   for full tool-content fidelity — the GET endpoint will resolve from the
   cloned JSONL once the new agent CLI is up. Step 5 is therefore a no-op
   *today*, but we add it as a defensive forward-compat copy guarded by
   `fs.existsSync` so a future on-disk cache lands lossless without code
   changes.
6. **Resolve fresh worktree intent from current project state.** If the
   source has `ps.worktreePath`, treat it only as provenance that the source
   was worktree-backed. Do **not** stat, repair, revive, reuse, or check out
   the archived `worktreePath` or `branch`. Instead, verify the current
   registered project root is a git repo and derive `worktreeOpts.repoPath`
   from `getRepoRoot(proj.rootPath)`. Failures here return a current-project
   fresh-worktree error, not a source archived-worktree error.
7. **Build createSession opts** — `sessionId`, `projectId`, `sandboxed`,
   `worktreeOpts`, `role`, `assistantType`, `preExistingAgentSessionFile`,
   and model pinning, but **without** `seedContext` or
   `seedContextSourceId`. For worktree-backed continues, set
   `awaitWorktreeSetup: true` and `bypassWorktreePool: true` so the POST
   waits for a new on-demand worktree and reports invalid current repo/base
   ref failures synchronously.
8. **Create the session.** `sessionManager.createSession(...)` runs the
   session setup pipeline. Non-worktree continues spawn directly from the
   project root. Worktree-backed continues create a fresh
   `session/<new-id8>` branch/worktree from the current project repo/base ref
   — never from the archived source branch. `executeWorktreeAsync` rebases
   the cloned JSONL to the final worktree-cwd slug path, persists that path,
   then issues `{type: "switch_session", sessionPath}` so the CLI loads the
   cloned transcript before the user's first prompt.
9. **Title.** Unchanged: `Continued: <source title>` with
   `markGenerated: true`.
10. **Model restore.** The model is pinned at spawn time when the source
    persisted a provider/model, then persisted on the new session for future
    restore.
11. **Cleanup on failure.** If `createSession` or fresh worktree setup throws
    after the JSONL, proposal drafts, or tool-content cache were copied, call
    `cleanupFailedContinue(...)` for the original clone path and, if setup
    already rebased `agentSessionFile`, the rebased path too. Cleanup removes
    the cloned transcript plus copied proposal/tool-content directories. A
    worktree setup failure may leave an archived failure row for evidence via
    `handleSetupFailure`, but it must not leave copied continue artifacts.
12. Return `{id, cwd, status, title, assistantType}` with `201` only after
    fresh setup succeeds. For worktree-backed continues, `cwd` is the new
    worktree path.

## New JSONL path computation

`recoverSessionFile` confirms the format (`session-manager.ts:4170-4194`):

- Directory: `<globalAgentDir()>/sessions/--<slug(cwd)>--/`
  - `slug(cwd) = cwd.replace(/[^a-zA-Z0-9]/g, "-")`
- File: `<isoTs>_<uuid>.jsonl`
  - `isoTs = new Date(ms).toISOString().replace(/[:.]/g, "-")` →
    `2026-04-03T15-15-12-009Z`
  - The parser uses `^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)`.

The continue handler can only know `proj.rootPath` at request time, so it
pre-computes the initial clone path with the project-root cwd and passes it as
`preExistingAgentSessionFile`. Non-worktree sessions keep that path.
Worktree-backed sessions get a fresh `session/<new-id8>` worktree from the
current project repo/base ref; once `plan.cwd` is final, `executeWorktreeAsync`
rebases the clone into the worktree-cwd slug directory before `switch_session`.

## Worktree-cwd slug invariant (follow-up correction)

The original design above proposed deferring path computation until inside
`createSession` so `plan.cwd` could be honoured. The shipped implementation
did the simpler thing instead — the continue handler in `server.ts`
pre-computes `destJsonl` against `proj.rootPath` and threads it via
`preExistingAgentSessionFile` — which is correct for non-worktree sessions
but wrong for worktree-backed ones: the agent CLI for those boots with
`cwd = offsetCwd` (the per-branch worktree container, e.g.
`<rootPath>-wt/session-<id8>/`), and `formatAgentSessionFilePath` embeds a
`slugify(cwd)` segment in the directory name. A clone left under the
project-root slug-dir is invisible to the agent CLI's JSONL reader, so
`switch_session` fails, `handleSetupFailure` archives the new session, and
the UI presents it as read-only with no editor.

Fix: `executeWorktreeAsync` in `src/server/agent/session-setup.ts` performs a
rebase after `plan.cwd` is finalised to the worktree path and before issuing
`switch_session`:

1. Re-derive the correct path via
   `formatAgentSessionFilePath(plan.cwd, Date.now(), session.id)`.
2. `mkdir { recursive: true }` the new slug-dir.
3. Move the cloned `.jsonl` from the old (project-root-slug) location to the
   new (worktree-cwd-slug) location:
   - Non-sandboxed: `fs.promises.rename`, with `copyFile + unlink` cross-device
     fallback (`EXDEV`).
   - Sandboxed: container-side `sessionFileCopy + sessionFileDelete` (the same
     pair already used for the initial host→sandbox / sandbox→sandbox copy in
     the continue handler).
4. Update `plan.preExistingAgentSessionFile` and the persisted
   `agentSessionFile` field on the session row, so a hard kill in the
   post-spawn window restores the correct path.

The rebase only fires on the worktree branch when `plan.preExistingAgentSessionFile`
is set, so the non-worktree continue path is unchanged. The lossless
contract is preserved — still a JSONL clone, no transcript stringification,
no `seedContext`, no byte budget; `formatAgentSessionFilePath` itself is
untouched, only the caller is now correct. `CrossRealmCopyError → 422`
remains the only cross-realm rejection. Regression test:
`tests/e2e/continue-archived-worktree.spec.ts`.

## Sandbox copy strategy

`session-fs.ts` already implements `sessionFileExists/Read/Delete` with the
exact two-tier dispatch we need (`session-fs.ts`):

- **Non-sandboxed:** host-side direct `fs` call.
- **Sandboxed (preferred):** `docker exec` against the container.
- **Sandboxed fallback:** `containerPathToHost()` translation
  (`rpc-bridge.ts:633`) when the container is unreachable (archived).

We add a sibling `sessionFileCopy(srcCtx, srcPath, dstCtx, dstPath, mgr)`
in `src/server/agent/session-fs.ts` with the same dispatch table.

Decision matrix on `(srcCtx.sandboxed, dstCtx.sandboxed)`:

| src | dst | strategy |
| --- | --- | --- |
| no  | no  | `fs.copyFileSync(src, dst)` (after `mkdirSync({recursive:true})`) |
| yes | yes | **same project:** `docker exec cp src dst` (cheap, in-container). **different projects:** stage via host bind-mount: read with `sandbox.exec(["cat", src])` → write to dst container with `sandbox.exec(["sh","-c","cat > "+dst])`, or simpler, translate both sides through `containerPathToHost()`. Reject with **422** if either translation fails. |
| no  | yes | host → container: `mkdirSync` host stage path, host `fs.copyFileSync`, then `docker cp` into dst container. **Or simpler: reject 422 `{error: "cross-realm continue not supported"}`.** |
| yes | no  | container → host: `fs.copyFileSync(containerPathToHost(src), dst)` if mapping resolves; else **422**. |

**Recommendation: implement same-realm only (rows 1 + 2), reject the two
cross-realm rows with 422.** Justification:

- The `sandboxed` flag is copied verbatim from the source onto the new
  session (`server.ts:5489`: `sandboxed: !!ps.sandboxed`). Cross-realm only
  arises if a future endpoint lets the user override sandboxing during
  continue — not a current feature.
- Host-staging adds a new third filesystem location to track, leak, and
  test, for a flow that doesn't exist.
- 422 is recoverable: the user can re-register the project with matching
  sandbox config and retry.

Ship the matrix as four explicit branches in `sessionFileCopy` so adding
the cross-realm rows later is a localised change.

## Tool-content directory copy

`<stateDir>/tool-content/<sessionId>/` does not exist on disk in the
current codebase — confirmed by `grep -rn "tool-content" src/server/`
(`src/server/server.ts:6032` is the only hit, and the GET handler reads via
`rpcClient.getMessages()` which pulls from the JSONL). Block IDs in the
JSONL *are* message-index/block-index pairs:
`tool-content/(\d+)/(\d+)$` → `messages[messageIndex].content[blockIndex]`
(`server.ts:6045-6055`). A straight directory copy would be sufficient — no
ID rewriting — *if* such a directory existed.

Implementation: define
`copyToolContentDirIfPresent(srcId: string, dstId: string, stateDir: string)`
in a new `src/server/agent/continue-archived.ts` (the file shrinks
dramatically — see §"Code to delete"). Body:

```ts
const src = path.join(stateDir, "tool-content", srcId);
if (!fs.existsSync(src)) return;
const dst = path.join(stateDir, "tool-content", dstId);
fs.mkdirSync(dst, { recursive: true });
fs.cpSync(src, dst, { recursive: true });
```

For sandboxed sessions we still read tool-content from the host
`stateDir` — sessions don't write tool-content into the container — so
host-side `fs.cpSync` is fine for both.

## `createSession` plumbing

The old `seedContext` / `seedContextSourceId` path has been removed from
Continue-Archived. The endpoint now passes one transcript-adoption option to
`createSession`:

```ts
preExistingAgentSessionFile?: string;
```

Plumbed through `SessionSetupPlan` to `spawnAgent` and
`executeWorktreeAsync` in `session-setup.ts`. When set:

1. The continue handler has already copied the source `.jsonl` to the initial
   destination path. `persistOnce` writes that path to the new
   `PersistedSession.agentSessionFile` before spawn, so a hard kill before
   spawn does not lose the clone.
2. For non-worktree sessions, `spawnAgent` starts in `proj.rootPath`,
   sanitizes the cloned transcript best-effort, and issues
   `{type: "switch_session", sessionPath}` immediately after
   `rpcClient.start()`.
3. For worktree-backed continues, `createSession` creates branch
   `session/<new-id8>` from the current project repo/base ref. The continue
   endpoint sets `awaitWorktreeSetup` and `bypassWorktreePool`, so this is an
   on-demand fresh setup and failures are thrown back to the POST. After the
   worktree cwd is known, `executeWorktreeAsync` rebases the cloned JSONL from
   the project-root slug path to the final worktree-cwd slug path, updates
   `agentSessionFile`, sanitizes, and issues `switch_session`.
4. On `switch_session` or setup failure, the RPC client is stopped or setup
   failure handling archives the failed row for evidence; the endpoint cleanup
   removes the cloned JSONL plus copied proposal/tool-content directories.

This keeps the new session in lockstep with the restart-resume flow: no
special "seeded session" code path, no system-prompt injection, no dependency
on the archived source worktree or branch.

## Code to delete vs keep in `continue-archived.ts`

**Delete:**
- `SEED_TOTAL_BUDGET`, `SUMMARY_INPUT_BUDGET`
- `truncateStringToBudget`
- `renderBlock`, `renderMessagesAsText`
- `formatFullTranscript`
- `callNamingModel` (Continue-Archived was its only caller — verified
  by grep; the title-generator has its own path)
- `summarizeTranscript`
- `buildSeedContext`
- `NamingModelOptions` interface

**Keep:** nothing of the existing module. Replace the file with the
two new helpers from this design:
- `copyToolContentDirIfPresent(srcId, dstId, stateDir)`
- (optionally) `formatAgentSessionFilePath(cwd, createdAt, sessionId)`
  — though that arguably belongs in `agent-session-path.ts` next to
  the parser side of `recoverSessionFile`.

**Also delete:**
- `sessionManager.getNamingModelOptions()` if Continue-Archived was
  its only caller. Quick grep before deletion. If used by
  title-generator, leave it.
- `seedContext` / `seedContextSourceId` fields on
  `createSession` opts (`session-manager.ts:2587`),
  `SessionSetupPlan` (`session-setup.ts:117-118`), `PromptParts` /
  prompt-section emission in `system-prompt.ts:201-203, 358-363,
  484-492`. After grepping there are no other callers.
- `getArchivedMessages` call site in `server.ts:5458` — no longer
  needed in the continue endpoint. The method itself
  (`session-manager.ts:3978-3996`) stays — it's used by the
  archived-session messages WS handshake.

## `mode` parameter removal

**Server:** `server.ts:5440-5444` — drop the `mode` body field, the
`if (mode !== "summary" && mode !== "full")` guard, and the
`buildSeedContext(messages, mode, ps, namingOpts)` call. Endpoint takes
an empty (or absent) body.

**Client:** `ContinueSessionChooser.ts` collapses to a confirm-only
modal. Specifically:

- Remove `_mode` `@state`, the radio `card()` helper, the radiogroup
  div, the `_selectMode` method.
- Remove `transcriptBytes` `@property` and the
  `data-large-transcript-warning` block (lines 167-178).
- Remove `estimateTranscriptBytes` export (and any caller in
  `AgentInterface.ts` — grep first, almost certainly the
  `data-action='continue-archived'` button handler).
- `_confirm` dispatches `new CustomEvent("continue", {bubbles: false})`
  with no `detail`.
- `messageCount` may stay for chrome ("This session has N messages")
  or be removed.

**Caller of the chooser** (search for `<continue-session-chooser>` in
`AgentInterface.ts`): drop the mode property binding and the
`mode`-bearing fetch payload — POST with empty body or omit
Content-Type entirely.

## Error paths

| Condition | Status | Body / cleanup |
| --- | --- | --- |
| Source session not found | 404 | `{error:"session not found"}` (existing) |
| Source not archived | 409 | (existing) |
| goal/delegate/team source | 422 | (existing); assistant sources are accepted |
| Project unregistered | 410 | `{error:"source project no longer registered"}` |
| Source `.jsonl` missing, empty, and `recoverSessionFile` cannot resolve it | 404 | `{error:"archived transcript missing or empty"}` |
| Source was worktree-backed, but the current project root cannot be inspected or is not a git repo | 500 | `{error:"failed to resolve current project repository for fresh continue worktree creation: <msg>"}`. This is a current-project error; the archived `worktreePath`/`branch` are not checked. |
| Sandbox cross-realm copy | 422 | `{error:"cross-realm continue not supported"}` |
| JSONL copy failure | 500 | `{error:"failed to clone session file: <msg>"}` — `cleanupFailedContinue` unlinks the destination clone and removes copied proposal/tool-content dirs if any were created; no new session row has been created yet. |
| Fresh worktree/base-ref/create-session failure | 500 | `{error:"failed to create session: <msg>"}` — reports the current project/base/worktree setup failure synchronously because worktree-backed continues set `awaitWorktreeSetup` and `bypassWorktreePool`. Cleanup removes the original cloned JSONL, any rebased `agentSessionFile`, and copied proposal/tool-content dirs. The archived source worktree/branch are not repaired or reused. |
| `switch_session` failure after spawn | 500 | `{error:"failed to create session: switch_session failed: <msg>"}` — agent startup is stopped/failed by setup handling; cleanup removes the cloned transcript plus copied proposal/tool-content dirs. |

Cleanup helper: `cleanupFailedContinue(destPath, newSessionId, stateDir)`
unlinks the cloned JSONL and removes both `<stateDir>/tool-content/<newId>/`
and `<stateDir>/proposal-drafts/<newId>/`. The continue handler calls it for
the precomputed clone path and, when worktree setup has already rebased the
session file, the persisted rebased `agentSessionFile` path as well.

## Title behavior

Unchanged. Server sets `Continued: <source title>` with
`markGenerated: true` (`server.ts:5517-5519`).

## Sandboxed-session note

Goal §8: the source `.jsonl` lives inside the project's sandbox volume.
`sessionFileCopy` dispatches the same way `sessionFileDelete` already does
(`session-fs.ts:140-189`). Same-project sandboxed → same-project sandboxed
is the common case and uses `docker exec cp` — fast, no host roundtrip.

## Test plan

### New unit tests

`tests/continue-archived-clone.test.ts` (new file):

- `formatAgentSessionFilePath(cwd, createdAt, "abc-uuid")` produces a
  path that round-trips through the regex in
  `recoverSessionFile` (`session-manager.ts:4187`). Test both POSIX
  and Windows-style cwds.
- `sessionFileCopy` non-sandboxed: copies bytes verbatim including a
  random binary payload; creates parent dirs.
- `sessionFileCopy` non-sandboxed: returns rejection on missing source.
- `copyToolContentDirIfPresent`: no-op when source dir absent;
  recursive copy when present.

`tests/sandbox-manager-copy.test.ts` (new file, Docker-gated, skip if
no Docker):

- Same-project sandboxed copy uses `docker exec cp` and produces the
  expected file in the destination container path.
- Cross-realm dispatch returns the documented rejection.

### Modified existing tests

`tests/e2e/continue-archived.spec.ts`:

- Drop tests that exercise `mode === "summary"` vs `"full"` — replace
  with a single happy-path test asserting the new behaviour:
  - Archive a source session with a marker prompt.
  - POST to continue with empty body.
  - Verify 201.
  - The new session's `agentSessionFile` (via
    `GET /api/sessions/:id`) points at a fresh path under
    `<globalAgentDir()>/sessions/`.
  - Bytes of dest equal bytes of source.
  - The new session's `getMessages` RPC includes the marker text from
    the original transcript (full fidelity, no summarisation).
- Drop tests asserting "Prior Session Transcript" in the system
  prompt — that section is gone.
- Drop the `large transcript total-budget cap` test — there is no cap.
- Drop the `summary LLM unavailable falls back` test — no summary mode.
- Keep all rejection-path tests; replace `mode: "full"` body with
  empty body and add an assertion that
  `{mode: "summary"}` no longer 400s — the field is ignored.
- Also keep the partial-flow regression: archive a session with no
  `.jsonl` on disk → 404 with the new error message.

`tests/e2e/ui/continue-archived.spec.ts`:

- Update the chooser interaction: there is no mode radio; the
  modal just has Cancel + Continue. Update Playwright selectors
  accordingly.
- Add: archive a session with a >128 KB transcript (use repeat-prompt
  to inflate, or a fixture JSONL ≥ 200 KB written before the test
  archives the session). Verify (a) no large-transcript warning is
  shown, (b) the new session opens with the long-transcript marker
  visible, (c) reload — marker still visible (rehydrated by the
  agent CLI on reconnect), (d) a tool_use block from the source >
  32 KB stays openable via the
  `GET /tool-content/:mi/:bi` lazy-load button.

### Regression coverage

- `tests/manual-integration/restart-minimal.spec.ts` (and any sibling
  resume tests): no changes expected. Lossless continue is a *new*
  call site that exercises the same `switch_session` path
  restart-resume already covers.
- `tests/e2e/continue-archived-worktree-stale-source.spec.ts`: archived
  `worktreePath`/`branch` may be missing; Continue still creates a fresh
  `session/<new-id8>` branch/worktree from the current project repo/base ref.
- `tests/e2e/continue-archived-worktree-invalid-base.spec.ts`: invalid
  current project repo/base-ref failures are returned synchronously as fresh
  worktree creation errors, not archived source worktree errors.
- `tests/e2e/continue-archived-worktree.spec.ts`: worktree-backed continues
  rebase the cloned JSONL to the final worktree-cwd slug path before
  `switch_session`.

## File-by-file change summary

| File | Change |
| --- | --- |
| `src/server/agent/continue-archived.ts` | Replace contents: delete transcript-stringification helpers and export `copyToolContentDirIfPresent`, `copyProposalDirIfPresent`, and `cleanupFailedContinue`. Cleanup removes cloned transcript artefacts plus copied proposal/tool-content directories. |
| `src/server/agent/agent-session-path.ts` | Export `formatAgentSessionFilePath(cwd, createdAtMs, sessionId): string` and keep it aligned with `recoverSessionFile`'s parser. |
| `src/server/agent/session-manager.ts` | Expose `recoverSessionFile`, drop `seedContext` / `seedContextSourceId` from create-session plumbing, add `preExistingAgentSessionFile`, `awaitWorktreeSetup`, and `bypassWorktreePool` opts. Worktree sessions use fresh `session/<id8>` branches; awaited setup throws failures back to the caller. |
| `src/server/agent/session-fs.ts` | Add `sessionFileCopy(srcCtx, srcPath, dstCtx, dstPath, mgr)` with the four-row dispatch matrix; cross-realm rows throw a typed `CrossRealmCopyError`. |
| `src/server/agent/session-setup.ts` | Add `preExistingAgentSessionFile` to `SessionSetupPlan`; persist the clone path before spawn; for worktree-backed continues, rebase the clone to the final worktree-cwd slug path, update `agentSessionFile`, then issue `switch_session`. |
| `src/server/agent/system-prompt.ts` | Delete `seedContext` / `seedContextSource` from `PromptParts` and remove the prior-transcript prompt section. |
| `src/server/server.ts` | Rewrite `POST /api/sessions/:archivedId/continue`: ignore legacy `mode`, resolve/copy the source JSONL, copy proposal/tool-content caches, derive worktree support from the current project repo, set `preExistingAgentSessionFile`, and for worktree-backed continues set `awaitWorktreeSetup`/`bypassWorktreePool`. Map `CrossRealmCopyError` to 422 and cleanup cloned artefacts on create-session or fresh-worktree failure. |
| `src/ui/components/ContinueSessionChooser.ts` | Collapse to confirm-only: drop `_mode`, `transcriptBytes`, the radiogroup, the warning block. Drop `estimateTranscriptBytes` export. `_confirm` emits empty `detail`. |
| `src/ui/components/AgentInterface.ts` (and any chooser caller) | Drop `transcriptBytes` binding and `mode` from the POST body. |
| `tests/e2e/continue-archived.spec.ts` | See §"Modified existing tests". |
| `tests/e2e/ui/continue-archived.spec.ts` | See §"Modified existing tests". |
| `tests/continue-archived-clone.test.ts` (new) | Path formatter + non-sandboxed copy unit tests. |
| `tests/e2e/continue-archived-worktree-stale-source.spec.ts` | Stale archived `worktreePath`/`branch` regression. |
| `tests/e2e/continue-archived-worktree-invalid-base.spec.ts` | Invalid current project repo/base-ref synchronous failure regression. |
| `tests/e2e/continue-archived-worktree.spec.ts` | Worktree-cwd JSONL rebase regression. |

## Open questions

None blocking. Two judgement calls flagged inline:

1. **Cross-realm copy:** recommended 422-reject (§"Sandbox copy
   strategy"). If the reviewer prefers we support host-staging now,
   add rows 3-4 of the matrix; the helper is structured so this is
   localised.
2. **`copyToolContentDirIfPresent` defensive copy:** recommended to
   ship even though the source dir doesn't exist today, so any future
   on-disk cache is automatically lossless. If the reviewer prefers
   YAGNI, drop the helper and re-add when the cache lands.
