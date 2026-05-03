# Priority 7 — Concurrency Safety

## Verdict summary

| goal | claim | verdict | confidence |
|---|---|---|---|
| 7.1 | Bobbit has no cross-session file-state registry; needs `FileStateRegistry` like Hermes `tools/file_state.py` | **real** | high |
| 7.2 | No per-path locks on write/edit/patch; concurrent edits can race | **real** | high |
| 7.3 | When a delegate writes a file the parent read, the parent has no awareness | **real** | high |
| 7.4 | Need four distinct staleness error cases (sibling_wrote / mtime_drift / partial_read / no_prior_read) | **real** | high |

Phase-A audits already converge on this conclusion: Bobbit has zero file-state coordination at the edit layer (audits/bobbit.md:17, 207, 213–215, 253), Hermes has the full reference implementation (audits/hermes.md:35, 49–51, 102, 225–245), and Claude Code has a strong single-process subset (audits/claude-code.md:23, 52, 214–216, 247–261). Every Priority-7 goal is therefore a real gap with a concrete reference implementation. The only nuance is per-goal scoping vs Claude Code: CC has read-before-edit + stale-mtime within one process, but no cross-session registry — so for a multi-session orchestrator like Bobbit, Hermes is the correct reference.

---

## Goal 7.1: Process-wide file-state registry

**Doc claim.** Bobbit has no cross-session file-state coordination; parallel delegates can clobber each other's edits. Implement `FileStateRegistry` modeled on Hermes `tools/file_state.py`.

**Bobbit reality.**
- No `FileStateRegistry`, `file-state.ts`, mtime tracking, or read-stamp store anywhere in the server. Confirmed by Phase-A audit (`audits/bobbit.md:17`: "no read-before-edit / loop-guard / stale-mtime checks anywhere in `src/server/`"; `:207`: "Searched `grep -rn 'mtime|stat|fs.statSync' node_modules/@mariozechner/pi-coding-agent/dist/core/tools/{edit,write}.js` — no mtime tracking.").
- Direct re-check: `grep -rn "mtime\|stale" /Users/aj/Documents/dev/bobbit/src/server/` returns only unrelated hits (`harness-signal.ts:22`, `task-manager.ts:295` referring to *task* staleness, not file staleness).
- The underlying coding library `pi-coding-agent` has no edit-time mtime/lock either: `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/edit.js` and `write.js` contain no `mtime`/`stat`/`lock`/`stale` references (`grep` returned nothing).
- Bobbit's only concurrency story is git-worktree isolation between team agents (`audits/bobbit.md:213-215`: "Coordination is at git-merge time, not at edit time. No file lock, no mtime gossip, no shared state.").

**Claude Code reality.** Has an in-process equivalent but **only single-session**:
- `src/utils/fileStateCache.ts:18-30` — `FileStateCache` LRU (100 entries / 25 MB), keyed by normalized absolute path, stores `{content, timestamp, offset, limit, isPartialView}`.
- `src/tools/FileEditTool/FileEditTool.ts:275-309` — read-before-edit + mtime stale check (`FILE_UNEXPECTEDLY_MODIFIED_ERROR`).
- No cross-session/cross-subagent registry — fork-subagents `cloneFileStateCache` (`fileStateCache.ts:122`) get a snapshot, not a shared coordinator. So CC covers parts of 7.4 (mtime_drift, partial_read, no_prior_read) but not 7.3 (sibling_wrote across siblings).

**Hermes reality.** Full reference implementation:
- `tools/file_state.py:60-83` — class `FileStateRegistry` with `_reads: Dict[task_id, Dict[path, (mtime, read_ts, partial)]]`, `_last_writer: Dict[path, (task_id, ts)]`, `_path_locks: Dict[path, threading.Lock]`.
- Bounds: `_MAX_PATHS_PER_AGENT = 4096` (`:53`), `_MAX_GLOBAL_WRITERS = 4096` (`:56`).
- Methods `record_read`, `note_write`, `check_stale`, `lock_path`, `writes_since`, `known_reads` all defined `:93–220`.
- Process-wide singleton (`audits/hermes.md:227`).

**Verdict.** **real** (high confidence).

**Reasoning.** The gap exists exactly as described, the reference impl exists in the cited file, and the doc's interface sketch maps 1:1 onto Hermes's public API. Claude Code provides only a partial single-session analogue; for Bobbit's multi-session/team-delegation model, the Hermes shape is the right target.

**Minimal proof of gap.**

Bobbit (no registry; no edit-layer coordination):
```ts
// src/server/agent/  → no file-state.ts file exists
// node_modules/@mariozechner/pi-coding-agent/dist/core/tools/edit.js
//   — no mtime/stat/lock references at all (grep returns nothing)
```

Hermes reference (`tools/file_state.py:60-83`):
```python
class FileStateRegistry:
    def __init__(self) -> None:
        self._reads: Dict[str, Dict[str, ReadStamp]] = defaultdict(dict)
        self._last_writer: Dict[str, Tuple[str, float]] = {}
        self._path_locks: Dict[str, threading.Lock] = {}
        self._meta_lock = threading.Lock()
        self._state_lock = threading.Lock()
```

**Scope-down notes.** None — adopt the Hermes shape directly. Implementation lives at the Bobbit-server layer (not pi-coding-agent) so all sessions in one gateway process share it.

---

## Goal 7.2: Per-path locks for write/edit

**Doc claim.** No locks → two concurrent edits to the same file can race. Wrap edit/write/patch with `registry.lockPath(absPath)`; multi-file patches acquire locks in sorted order.

**Bobbit reality.** No locks of any kind on edit/write paths.
- `audits/bobbit.md:215`: "Concurrency safety: only `proper-lockfile` on `settings.json` (pi-coding-agent's settings store, `settings-manager.js`). Tool execution itself has no locks."
- Re-checked: pi-coding-agent's `edit.js`/`write.js` have no lock primitives. Bobbit doesn't wrap them with any either.

**Claude Code reality.** Doesn't use per-path locks; instead uses `Tool.isConcurrencySafe(input)` (`src/Tool.ts:402, 560, 759`) so the harness simply **serialises** non-concurrency-safe tools (Edit/Write/Bash) within a turn (`audits/claude-code.md:258-261`). This is single-agent serialisation, not cross-session. No per-path-locks because all edits go through one `readFileState` in one process.

**Hermes reality.** Per-path `threading.Lock`:
- `tools/file_state.py:64-83` — `_path_locks: Dict[resolved_path, threading.Lock]`; `lock_path()` is a `@contextmanager` that wraps the read→modify→write region. Different paths run in parallel; same path serialises across threads/subagents.
- Multi-file V4A patch acquires locks in **sorted order** under one `ExitStack` to avoid deadlock (`tools/file_tools.py:818-826`, audited at `audits/hermes.md:58, 237`).

**Verdict.** **real** (high confidence).

**Reasoning.** Bobbit has no locks and runs multiple sessions in one gateway process; the race is real. Hermes's per-path-lock + sorted-order acquisition for multi-file patches is the canonical solution. CC's `isConcurrencySafe` flag is insufficient for cross-session work because the gateway can dispatch to different sessions concurrently.

**Minimal proof of gap.**

Bobbit (no locks): no `lock`/`mutex`/`Lock` references in `src/server/agent/` for file operations (verified by grep).

Hermes (`tools/file_state.py:79-90`):
```python
@contextmanager
def lock_path(self, resolved: str):
    lock = self._lock_for(resolved)
    lock.acquire()
    try:
        yield
    finally:
        lock.release()
```

Hermes multi-file sorted lock acquisition (`tools/file_tools.py:818-826`, per `audits/hermes.md:58`):
```python
# paths sorted ascending, locked in order via ExitStack to prevent deadlock
# when two agents patch overlapping multi-file V4A blocks
```

**Scope-down notes.** Locks must be JS-level `Promise`-based (Node single-threaded but multi-session), not native mutexes — the registry returns an unlock fn as the doc sketch shows.

---

## Goal 7.3: Sibling-agent stale warnings

**Doc claim.** When a delegate writes a file the parent read, the parent should be warned on delegate-completion. Use `registry.writesSince(parentSessionId, path, parentDelegateStartTs)`; append warnings to the delegate result.

**Bobbit reality.**
- No mechanism exists. The delegate tool extension at `.bobbit/config/tools/agent/extension.ts` does not read or write any file-state; it just spawns a child Bobbit session and returns its result.
- `audits/bobbit.md:213-214` confirms cross-agent coordination is purely at git-merge time, not in tool results.

**Claude Code reality.** No sibling warnings — fork-subagents get a *cloned* (snapshotted) `FileStateCache` (`src/utils/fileStateCache.ts:122` — `cloneFileStateCache`), and there is no merge-back path from child to parent. CC simply doesn't run multiple parallel agents that all write the same workspace, so the problem doesn't apply.

**Hermes reality.** Full implementation, exactly as the doc describes:
- `tools/delegate_tool.py:1407` snapshots `parent_reads = list(file_state.known_reads(parent_task_id))` at spawn.
- `tools/delegate_tool.py:1651-1656` calls `file_state.writes_since(parent_task_id, since_ts, parent_reads)` on completion and appends a sibling-write notice to the delegation result (`audits/hermes.md:102, 244`).
- `tools/file_state.py:218` defines `writes_since(...)`.

**Verdict.** **real** (high confidence).

**Reasoning.** Bobbit's delegate tool spawns real parallel sessions on shared worktrees (when working in the same goal worktree) or via git merge, but provides no warning to the parent that a delegate touched files the parent had read. Hermes solves this at the registry layer with `writes_since`, and the doc's interface lifts the Hermes API.

**Minimal proof of gap.**

Bobbit (`/Users/aj/Documents/dev/bobbit/.bobbit/config/tools/agent/extension.ts`): the extension returns the delegate's last assistant message verbatim — no file-state inspection or sibling-write reminder is appended.

Hermes (`tools/delegate_tool.py:1651-1656`):
```python
sibling_writes = file_state.writes_since(
    parent_task_id, since_ts, parent_reads
)
if sibling_writes:
    paths = sorted({p for paths in sibling_writes.values() for p in paths})
    # appended to delegation result reminder
```

**Scope-down notes.** Goal 7.3 specifies "delegate result"; in Bobbit that's the team-spawn / delegate / `team_prompt` return path. Also worth applying on `team_complete` so the parent sees writes from any sibling, not just the just-finished delegate. Otherwise scope is correct.

---

## Goal 7.4: Four-case staleness detection

**Doc claim.** Each staleness cause needs a distinct error code: `sibling_wrote`, `mtime_drift`, `partial_read`, `no_prior_read`. On every edit/write call `registry.checkStale(...)` and refuse with the structured error.

**Bobbit reality.** None of the four cases are detected.
- No mtime check, no read-stamp, no partial-read tracking, no sibling-writer registry. (`audits/bobbit.md:207, 215, 253`).

**Claude Code reality.** Implements **three of four** cases but not as discrete error codes:
- `no_prior_read` — `FileEditTool.ts:275-287` (`errorCode: 6`, "File has not been read yet").
- `partial_read` — same block, `!readTimestamp || readTimestamp.isPartialView` (`:276`).
- `mtime_drift` — `FileEditTool.ts:290-309` (`errorCode: 7`, "File has been modified since read").
- **No `sibling_wrote`** — single-process, single-session; `lastWriteTime > readTimestamp.timestamp` is treated as one undifferentiated case.

**Hermes reality.** All four cases, distinguished:
- `tools/file_state.py:142-200` `check_stale(task_id, resolved)`:
  - Case 1: sibling subagent wrote (`:172-186`)
  - Case 2: external/unknown mtime drift (`:192-200`)
  - Case 3: partial read before overwrite (`partial=True` flag on `ReadStamp`, audited at `audits/hermes.md:50`)
  - Case 4: never-read (`audits/hermes.md:50`: "three classes ranked — sibling subagent wrote, external mtime drift, never-read"; partial-read tracked via `ReadStamp.partial` so it surfaces on the next write).
- Hermes returns these as model-facing `_warning` strings with distinct text per case (`file_state.py:178-200`); the doc proposes promoting them to structured error codes — a strict superset.

**Verdict.** **real** (high confidence).

**Reasoning.** Bobbit has none of the four cases. CC has three (no sibling). Hermes has all four but as warnings rather than refusals — the doc's "structured error code with distinct case" is a sensible step beyond Hermes that gives the model deterministic recovery hooks. Bobbit's per-session/per-delegate model needs case 1 (sibling_wrote) which CC's design intentionally doesn't model.

**Minimal proof of gap.**

Bobbit (no `checkStale`): `grep -rn "checkStale\|stale" /Users/aj/Documents/dev/bobbit/src/server/` returns only task-staleness hits unrelated to files.

Hermes (`tools/file_state.py:142-200`, abridged):
```python
def check_stale(self, task_id: str, resolved: str) -> Optional[str]:
    # Case 1: sibling subagent modified after our last read.
    if writer != task_id and write_ts > read_ts:
        return f"{resolved} was modified by sibling subagent {writer} ..."
    # Case 2: external/unknown modification (mtime drifted).
    if current_mtime != read_mtime:
        return f"{resolved} mtime drifted; partial={partial}"
    # (case 3 partial-read warning surfaces from ReadStamp.partial)
    # (case 4 never-read handled by absence of stamp)
```

Claude Code partial coverage (`src/tools/FileEditTool/FileEditTool.ts:275-309`):
```ts
if (!readTimestamp || readTimestamp.isPartialView) { /* errorCode 6 */ }
if (lastWriteTime > readTimestamp.timestamp) { /* errorCode 7 */ }
```

**Scope-down notes.** Worth adding a fifth case-discrimination in the error message: distinguish "external (non-Bobbit) mtime drift" from "sibling Bobbit session wrote" even when both happen — Hermes already does this at `:172-200`. The doc's four cases are the correct minimum.
