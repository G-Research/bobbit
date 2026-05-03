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

Per goal spec §7 / §non-requirements: worktree, cwd, and branch are still
fresh per the existing logic. The cloned JSONL will reference paths from the
old worktree — that's expected and matches restart-resume conceptually.
`restoreSession`, live-session restart, and the agent CLI's JSONL reader are
unchanged.

## Endpoint flow (post-change)

`POST /api/sessions/:archivedId/continue` (`src/server/server.ts:5435`):

1. Resolve `ps = sessionManager.getPersistedSession(archivedId)`. Same
   guards as today: 404 if missing, 409 if not archived, 422 if
   goal/delegate/team/assistant, 410 if project unregistered.
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
6. **Build createSession opts** — same `worktreeOpts`, `role`,
   `projectId`, `sandboxed`, `skipAutoModel` shape as today, but
   **without** `seedContext` and `seedContextSourceId`. Add a new
   `preExistingAgentSessionFile?: string` opt (see §"createSession
   plumbing" below).
7. **Create the session.** `sessionManager.createSession(...)` runs the
   normal pipeline. The pipeline persists `agentSessionFile = ""`
   (`session-setup.ts:461`), then on first `spawnAgent` either creates a
   new JSONL or — when `preExistingAgentSessionFile` is set — issues
   `{type: "switch_session", sessionPath}` so the CLI loads the cloned
   transcript before the user's first prompt. (Alternative: persist
   `agentSessionFile` directly *before* spawn, see §"createSession
   plumbing".)
8. **Title.** Unchanged: `Continued: <source title>` with
   `markGenerated: true` (`server.ts:5519`).
9. **Model restore.** Unchanged best-effort fire-and-forget at
   `server.ts:5522-5544`.
10. **Cleanup on failure.** If `createSession` throws after the JSONL was
    copied, unlink the destination JSONL (and the tool-content dir if
    copied). The persisted-session-row half-state cannot occur because
    `persistOnce` runs inside `executePlan` *after* spawn succeeds — so
    failures before that leave no row.
11. Return `{id, cwd, status, title}` with `201`. Same shape as today.

## New JSONL path computation

`recoverSessionFile` confirms the format (`session-manager.ts:4170-4194`):

- Directory: `<globalAgentDir()>/sessions/--<slug(cwd)>--/`
  - `slug(cwd) = cwd.replace(/[^a-zA-Z0-9]/g, "-")`
- File: `<isoTs>_<uuid>.jsonl`
  - `isoTs = new Date(ms).toISOString().replace(/[:.]/g, "-")` →
    `2026-04-03T15-15-12-009Z`
  - The parser uses `^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)`.

The new session's `cwd` is `proj.rootPath` (or worktree path once
allocated). For worktree-backed sessions, the cwd is finalised inside the
pipeline; we use the **planned** cwd that `createSession` will end up with —
which is `proj.rootPath` for non-worktree, or the per-branch container path
the pool will produce. Simpler: defer path computation until *inside*
`createSession`, by passing the source path through opts and letting
`session-setup.ts` compute the destination after `plan.cwd` is final
(see §"createSession plumbing").

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

Today `createSession` accepts `seedContext` and `seedContextSourceId`
opts (`session-manager.ts:2587`, threaded through to
`session-setup.ts:117-118` and `system-prompt.ts:201-203`). After this
change Continue-Archived no longer sets them. Grep for other callers:

```bash
grep -rn "seedContext" src/
```

Confirmed callers: only `server.ts:5491-5492` (the continue endpoint).
The fields are therefore safe to **delete entirely** from
`createSession` opts, `SessionSetupPlan`, `PromptParts`, and the
prompt-section logic in `system-prompt.ts:358-363, 484-492`.

In their place we add **one new opt** to `createSession`:

```ts
preExistingAgentSessionFile?: string;
```

Plumbed through `SessionSetupPlan` to `spawnAgent` in
`session-setup.ts`. When set:

1. Before spawn, the destination path is finalised (using `plan.cwd`)
   and the source `.jsonl` is copied via `sessionFileCopy`. This is
   **inside** `executePlan` so cleanup-on-throw can unlink the
   destination cleanly.
2. After `rpcClient.start()` succeeds and *before* the existing
   `persistSessionMetadata` call (`session-setup.ts:790`), we issue
   `{type: "switch_session", sessionPath: <newPath>}` against the new
   bridge — same RPC the restart path uses
   (`session-manager.ts:2545-2551`). On failure: `rpcClient.stop()`,
   unlink the cloned JSONL, throw — caller in `server.ts` translates
   to 500.
3. `persistSessionMetadata` then writes the `agentSessionFile` field
   from `getState()` as usual — which by now points at the cloned
   path the agent CLI just adopted.

This keeps the new session in lockstep with the restart-resume flow:
no special "seeded session" code path, no system-prompt injection.

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

| Condition | Status | Body |
| --- | --- | --- |
| Source session not found | 404 | `{error:"session not found"}` (existing) |
| Source not archived | 409 | (existing) |
| goal/delegate/team/assistant source | 422 | (existing) |
| Project unregistered | 410 | (existing) |
| Source `.jsonl` missing AND `recoverSessionFile` returns null | 404 | `{error:"archived transcript missing or empty"}` |
| Sandbox cross-realm copy | 422 | `{error:"cross-realm continue not supported"}` |
| JSONL copy failure | 500 | `{error:"failed to clone session file: <msg>"}` — destination unlinked, no session row created |
| `switch_session` failure post-spawn | 500 | `{error:"failed to load source transcript: <msg>"}` — destination unlinked, agent stopped, partial session row removed via `sessionStore.delete(id)` |
| `createSession` failure pre-spawn | 500 | `{error:"failed to create session: <msg>"}` — destination unlinked |

Cleanup helper: `cleanupFailedContinue(destPath, newSessionId, stateDir)`
unlinks dest JSONL + tool-content dir. Wrap the new endpoint body in
try/catch around step 4-onwards.

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
- Add a `tests/manual-integration/continue-archived-sandboxed.spec.ts`
  smoke test that continues an archived sandboxed session and asserts
  the cloned `.jsonl` is reachable inside the container.

## File-by-file change summary

| File | Change |
| --- | --- |
| `src/server/agent/continue-archived.ts` | Replace contents: delete `buildSeedContext`, `formatFullTranscript`, `summarizeTranscript`, `truncateStringToBudget`, `renderBlock`, `renderMessagesAsText`, `callNamingModel`, `NamingModelOptions`, `SEED_TOTAL_BUDGET`, `SUMMARY_INPUT_BUDGET`. Export `copyToolContentDirIfPresent`. |
| `src/server/agent/agent-session-path.ts` (new) | Export `formatAgentSessionFilePath(cwd, createdAtMs, sessionId): string` and refactor `recoverSessionFile` to import its parser side. |
| `src/server/agent/session-manager.ts` | Promote `recoverSessionFile` to public (or expose `resolveAgentSessionFile`). Drop `seedContext` / `seedContextSourceId` from `createSession` opts (line 2587), `store.put` calls (lines 2682-2683, 2736-2737). Add `preExistingAgentSessionFile?: string` opt. Optionally remove `getNamingModelOptions` if no other caller. |
| `src/server/agent/session-fs.ts` | Add `sessionFileCopy(srcCtx, srcPath, dstCtx, dstPath, mgr)` with the four-row dispatch matrix; cross-realm rows throw a typed `CrossRealmCopyError`. |
| `src/server/agent/session-setup.ts` | Drop `seedContext` / `seedContextSourceId` from `SessionSetupPlan` (lines 117-118) and the `assemblePrompt` call (lines 384-385). Add `preExistingAgentSessionFile?: string` to `SessionSetupPlan`. In `executePlan`/`spawnAgent`: if set, copy via `sessionFileCopy` before spawn (with cleanup on throw), then issue `switch_session` after `rpcClient.start()` succeeds, *before* `persistSessionMetadata`. |
| `src/server/agent/system-prompt.ts` | Delete `seedContext` / `seedContextSource` from `PromptParts` (lines 201-203). Remove the prompt-section emission at lines 358-363 and 484-492. |
| `src/server/server.ts` | Rewrite `POST /api/sessions/:archivedId/continue` (lines 5435-5547): remove `mode` body parsing, remove `getArchivedMessages` + `buildSeedContext` calls, remove `seedContext` / `seedContextSourceId` from `createOpts`. Resolve source path via `recoverSessionFile`, compute dest path, set `preExistingAgentSessionFile` in `createOpts`, call `copyToolContentDirIfPresent` after `createSession` returns. Wrap in try/catch with cleanup helper. Map `CrossRealmCopyError` → 422. |
| `src/ui/components/ContinueSessionChooser.ts` | Collapse to confirm-only: drop `_mode`, `transcriptBytes`, the radiogroup, the warning block. Drop `estimateTranscriptBytes` export. `_confirm` emits empty `detail`. |
| `src/ui/components/AgentInterface.ts` (and any chooser caller) | Drop `transcriptBytes` binding and `mode` from the POST body. |
| `tests/e2e/continue-archived.spec.ts` | See §"Modified existing tests". |
| `tests/e2e/ui/continue-archived.spec.ts` | See §"Modified existing tests". |
| `tests/continue-archived-clone.test.ts` (new) | Path formatter + non-sandboxed copy unit tests. |
| `tests/sandbox-manager-copy.test.ts` (new, Docker-gated) | Same-project sandboxed copy + cross-realm rejection. |
| `tests/manual-integration/continue-archived-sandboxed.spec.ts` (new) | Smoke test for sandboxed lossless continue. |
| `tests/e2e/test-utils/no-new-sleeps.baseline.json` | Recompute baseline after the test rewrites land. |

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
