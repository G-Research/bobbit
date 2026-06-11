# Persistent `bash_bg` processes — survive gateway restart + re-attach to live processes

Status: design (implementation pending)
Owner: bg-process feature
Related goal: "Persistent bash_bg processes"

## 1. Problem & current state

`BgProcessManager` (`src/server/agent/bg-process-manager.ts`) is **in-memory only**: a
`Map<sessionId, Map<bgId, BgProcess>>`. Each `BgProcess` holds a live `ChildProcess` handle,
captured `stdout`/`stderr`/`log` arrays, and a `status`/`exitCode`. Nothing is written to disk.

On gateway restart we lose:

- every process record (id, name, command, pid, status, exit code, timings);
- all captured output;
- the live child handle and its stdout/stderr pipes.

Two distinct failure modes follow:

1. **Host spawns** — `defaultSpawn` spawns with `detached: true` + `child.unref()`
   (`bg-process-manager.ts` `create()` ~L121), so on gateway exit the process keeps running as
   an orphan. But its stdout/stderr pipes were owned by the now-dead parent and **cannot be
   re-attached** from a new process. The new gateway has no record it ever existed.
2. **Docker-exec spawns** — `defaultSpawn` runs `docker exec ... <shell> -c <cmd>`
   (`bg-process-manager.ts` ~L30). The command keeps running inside the still-alive container,
   but the **host-side `docker exec` handle dies with the gateway**, so output streaming and exit
   capture stop.

### Goal

Make bg processes behave as if the server never restarted:

- Persist each process's metadata + captured output to disk (atomic writes, mirroring
  `SessionStore`).
- Restore records on boot alongside `restoreSessions()`
  (`src/server/agent/session-manager.ts` ~L3169) so `GET /api/sessions/:id/bg-processes` and the
  WS-driven pills show them after a restart with output intact.
- **Re-attach to still-running processes** — resume streaming live output and capture the
  eventual **real** exit code. Never fabricate exit codes.
- Cleanly distinguish **kill** (terminate a running proc, keep the exited record until dismissed)
  from **dismiss** (remove the record + delete persisted files).
- Keep disk usage bounded by the existing caps (`MAX_LOG_LINES` 5000 / `MAX_LOG_BYTES` 512KB).
- Preserve sandbox parity and the `sandboxed && !containerId` host-execution guard
  (`bg-process-manager.ts` `create()` ~L118).

## 2. The crux: durable log/status files instead of in-memory pipes

You **cannot** re-attach to a dead parent's stdout/stderr pipes. The spawn model must change so
that output and exit status live on disk, owned by the *child*, independent of the gateway:

- At spawn time, **redirect the command's stdout/stderr into a durable per-process log file**.
  The running process keeps appending to that file even while the gateway is down.
- **Capture the real exit code durably**: wrap the command so that when it finishes it writes its
  exit status to a per-process status file (`echo $? > <statusfile>`), and write the wrapper's own
  pid to a pidfile.
- The gateway streams output to clients by **tailing the log file from a byte offset** — the same
  mechanism serves both the live case and the post-restart re-attach case.

This is a fundamental change to `defaultSpawn` and to how `create()` wires output capture. The
existing in-memory `log`/`stdout`/`stderr` arrays and WS broadcasts are *kept* (the API and pill
read from them), but they are now **fed by tailing the log file** rather than by listening on the
child's pipes directly.

### 2.1 Why a log/status file and not the live pipe

| Concern | Live pipe (today) | Durable file (proposed) |
|---|---|---|
| Survives gateway restart | No | Yes (process keeps writing) |
| Re-attach output after restart | Impossible | Tail file from saved offset |
| Real exit code after restart | Lost | Read from status file |
| Docker-exec, gateway down | Lost | Container keeps writing; read on restore |
| Unit-testable without OS | Fake child EventEmitter | Fake file paths + fake `Tailer` |

## 3. On-disk layout

All files live under the **project state dir** (`ProjectContext.stateDir` =
`<project.rootPath>/.bobbit/state`, see `src/server/agent/project-context.ts` ~L72). This is the
same dir `SessionStore` writes `sessions.json` into, so per-project isolation and the isolated
test state dir (`tests/e2e/e2e-setup.ts`) are inherited for free.

```
<stateDir>/
  sessions.json                          # existing
  bg-processes.json                      # NEW: metadata index (all sessions for this project)
  bg-processes.json.bak.1 .. .bak.5      # NEW: rotated backups (mirrors SessionStore)
  bg-processes/                          # NEW: per-process durable files
    <sessionId>/
      <bgId>.log                         # combined stdout+stderr, line-prefixed by stream
      <bgId>.status                      # final exit code, written once by the wrapper
      <bgId>.pid                         # wrapper pid (host) — liveness probe
```

### 3.1 Log file format

Each line is written by the wrapper as it is produced. To preserve the stdout/stderr distinction
the wrapper tags streams. Two viable encodings — **chosen: option A** (stream-tagged lines), which
keeps the file greppable and lets the tailer reconstruct `stdout[]`/`stderr[]`:

- **Option A (chosen):** redirect stdout and stderr to the same file but tag each via separate fds
  is not portable. Instead the wrapper writes a single combined stream and the tailer treats all
  lines as `log` entries; `stdout`/`stderr` separation is preserved by writing two files:
  `<bgId>.out.log` and `<bgId>.err.log`. See §4 for the concrete redirect. The metadata records
  both paths; the combined `log[]` is reconstructed by merging on a per-line monotonic counter is
  unnecessary — we interleave by append order within each file and merge by arrival when tailing.

> Implementation note: keeping **two files** (`.out.log`, `.err.log`) is simpler and fully
> portable across Git Bash, cmd, and `/bin/sh` than trying to interleave a tagged single stream.
> The in-memory `log[]` (interleaved) is rebuilt by the tailer as chunks arrive, exactly as the
> current `appendLog()` interleaves pipe `data` events. The status file remains a single
> `<bgId>.status`.

Final naming (used throughout this doc):

```
<stateDir>/bg-processes/<sessionId>/<bgId>.out.log
<stateDir>/bg-processes/<sessionId>/<bgId>.err.log
<stateDir>/bg-processes/<sessionId>/<bgId>.status
<stateDir>/bg-processes/<sessionId>/<bgId>.pid      # host spawns only
```

### 3.2 Docker reachability

For sandboxed sessions the worktree is **container-internal** (cloned into `/workspace` or
`/workspace-wt/...`), **not** bind-mounted from the host (see
`src/server/agent/sandbox-clone-source.ts`, `MOUNTED_SRC_PATH`, and
`session-manager.ts::isSandboxContainerPath` ~L96). The host cannot read a file written inside the
container by path.

Therefore docker-exec processes write their log/status files **inside the container** (under the
container-internal worktree, e.g. `<cwd>/.bobbit-bg/<bgId>.out.log`, or `/tmp/bobbit-bg/...`), and
the host reads them via `docker exec`:

- **Tail live / re-attach:** `docker exec <cid> tail -c +<offset> -F <containerLogPath>` (the
  `-F` keeps following across truncation; `-c +<offset>` resumes from a byte offset).
- **Read final on restore-after-downtime:** `docker exec <cid> cat <containerStatusPath>`.
- **Liveness:** `docker inspect -f '{{.State.Running}}' <cid>` for the container, plus
  `docker exec <cid> kill -0 <pid>` for the in-container wrapper pid.

The metadata records both the host path (empty for docker) and the **container path**, plus the
`containerId`. The pidfile is unnecessary for docker — liveness is `docker exec kill -0`.

> The container path lives under the worktree (host-unreadable but container-writable) which is
> the only guaranteed-writable, restart-stable location for a sandboxed session. `/tmp` is also
> acceptable and avoids polluting the worktree; **chosen: `/tmp/bobbit-bg/<sessionId>/<bgId>.*`**
> inside the container, created with `mkdir -p` by the wrapper. `/tmp` survives for the container's
> lifetime, which is exactly the process's lifetime.

## 4. Spawn model (concrete commands)

`SpawnFn` keeps its signature so tests can override it. `defaultSpawn` changes to: (a) compute the
log/status/pid paths, (b) build a wrapper command that redirects output and writes the status
file, (c) spawn the wrapper.

```ts
// bg-process-manager.ts
export interface BgPaths {
  outLog: string;   // host path (host spawn) OR container path (docker)
  errLog: string;
  status: string;
  pid: string;      // host spawn only; "" for docker
  /** true when paths are container-internal and must be read via `docker exec` */
  inContainer: boolean;
}

export type SpawnFn = (
  command: string,
  cwd: string,
  containerId: string | undefined,
  paths: BgPaths,            // NEW — where to redirect output / write status
) => ChildProcess;
```

### 4.1 Host wrapper (Windows Git Bash / `/bin/sh`)

`getShellConfig()` (`src/server/agent/shell-util.ts`) returns Git Bash (`bash -c`) on Windows when
present, else `cmd.exe /d /s /c`, and `/bin/sh -c` on Linux/macOS. The wrapper must work for **both
shell families**. Git Bash and `/bin/sh` share POSIX syntax; cmd.exe does not.

**POSIX shell (Git Bash on Windows + /bin/sh on Linux/macOS):** the wrapper is a single `-c`
string:

```sh
{ <command> ; } > "<outLog>" 2> "<errLog>" ; echo $? > "<status>"
```

with the wrapper pid recorded by the *manager* (the spawned child's `child.pid` is the shell pid,
which is the wrapper) into `<pid>` immediately after spawn — no separate pidfile write needed in
the script, but we also write it from the script for robustness:

```sh
echo $$ > "<pid>" ; { <command> ; } > "<outLog>" 2> "<errLog>" ; echo $? > "<status>"
```

`$$` is the shell pid; `$?` is the command's exit code. This is the **primary path** (Git Bash is
preferred on the Windows host per `GIT_BASH` in `shell-util.ts`).

**cmd.exe fallback (Windows without Git Bash):** POSIX `$$`/`$?` do not exist. Use:

```bat
echo %errorlevel%
```

Wrapper string passed after `/d /s /c`:

```bat
(<command>) > "<outLog>" 2> "<errLog>" & echo %errorlevel% > "<status>"
```

cmd has no portable pidfile-from-script idiom; for cmd we rely solely on `child.pid` (the cmd.exe
process pid) recorded by the manager into `<pid>`. `%errorlevel%` after `&` captures the inner
command's exit code. Note `&` (not `&&`) so the status is written even on failure.

> Because the wrapper string differs by shell family, the manager picks it via a new helper
> `buildHostWrapper(command, paths, shellKind)` where `shellKind` is derived from
> `getShellConfig()` (Git Bash / sh → "posix"; cmd.exe → "cmd"). This keeps the platform branching
> in one tested function.

### 4.2 Docker wrapper (`/bin/sh -c` inside the container)

Always POSIX `/bin/sh` inside the container. Paths are container-internal (`/tmp/bobbit-bg/...`):

```sh
mkdir -p "<dir>" ; echo $$ > "<pid>" ; { <command> ; } > "<outLog>" 2> "<errLog>" ; echo $? > "<status>"
```

spawned as:

```
docker exec -w <containerCwd> <containerId> /bin/sh -c '<wrapper>'
```

(unchanged `docker exec` shape from `defaultSpawn`; only the inner string gains the redirect +
status write). `MSYS_NO_PATHCONV=1` / `MSYS2_ARG_CONV_EXCL=*` env stays so Git Bash on the host
does not mangle container paths.

### 4.3 stdio for the spawned wrapper

Because output now goes to files, the child's stdio can be `["ignore", "ignore", "ignore"]` for
host spawns — we no longer read pipes. (Keep `"pipe"` for docker is unnecessary; the docker-exec
host handle is only used for liveness/kill while alive.) Host spawns keep `detached: true` +
`child.unref()` so the orphan survives gateway exit.

> Edge: a tiny window exists between spawn and the wrapper creating the log files. The tailer must
> treat "file not yet present" as "0 bytes, retry" rather than an error (see §6).

## 5. Persistence layer

### 5.1 Metadata schema

```ts
// NEW: src/server/agent/bg-process-store.ts
export interface PersistedBgProcess {
  sessionId: string;
  id: string;                 // bgId, e.g. "bg-3"
  name: string;
  command: string;
  pid: number;                // wrapper pid (host shell) or docker-exec host pid
  cwd: string;
  containerId?: string;       // present for sandboxed/docker spawns
  status: "running" | "exited" | "unrecoverable";
  exitCode: number | null;    // null while running OR when unrecoverable
  startTime: number;
  endTime: number | null;
  // durable file locations
  outLog: string;
  errLog: string;
  statusFile: string;
  pidFile: string;            // "" for docker
  /** true when the files are container-internal (read via docker exec) */
  inContainer: boolean;
  /** bytes of each log already consumed by the tailer — lets re-attach resume */
  outOffset: number;
  errOffset: number;
}
```

`status` gains a third value **`"unrecoverable"`** (the §7 fallback). This requires widening the
union in `BgProcess`, `BgProcessInfo` (`bg-process-manager.ts`), the WS event types
(`src/server/ws/protocol.ts`), and the client/UI types (§9).

### 5.2 Store class — mirror `SessionStore`

`BgProcessStore` reuses the exact persistence pattern from
`src/server/agent/session-store.ts`: debounced + immediate `saveNow()`, **atomic tmp+fsync+rename**,
5-deep backup rotation (`rotateBackups`), version-2 envelope `{ version, epoch, processes }`, and
the **epoch stale-snapshot guard** (`peekDiskEpoch` / `staleGuardTripped`). Do **not** build a
parallel persistence subsystem — copy the proven helpers.

```ts
export class BgProcessStore {
  constructor(stateDir: string);                       // <stateDir>/bg-processes.json
  getAll(): PersistedBgProcess[];
  getForSession(sessionId: string): PersistedBgProcess[];
  put(p: PersistedBgProcess): void;                    // immediate saveNow (structural)
  update(sessionId: string, id: string,
         updates: Partial<Pick<PersistedBgProcess,
           "status"|"exitCode"|"endTime"|"outOffset"|"errOffset"|"pid">>): void;
  remove(sessionId: string, id: string): void;         // index entry only
  removeForSession(sessionId: string): void;
  flush(): void;
  /** dir holding the per-process files for a session */
  filesDir(sessionId: string): string;                 // <stateDir>/bg-processes/<sessionId>
}
```

**Write cadence:** `put` on create (structural → `saveNow`); `update` on exit and on
offset-advance. Offsets advance frequently, so `outOffset`/`errOffset` updates use the **debounced**
path (like `lastActivity`), while `status`/`exitCode`/`endTime` are **recovery-critical** → flush
synchronously (mirror `SessionStore.RECOVERY_CRITICAL_FIELDS`). Losing a few KB of replayed offset
on a hard kill is harmless — the tailer re-reads from the persisted offset and the dedupe in the
pill (`_fetchedUpTo`) and manager handle the small overlap.

### 5.3 Wiring per project

`BgProcessManager` currently has one global instance constructed in `server.ts` ~L1210. Per-project
state dirs mean the manager must resolve the **right** store per session. Two options:

- **Chosen:** give `BgProcessManager` a `storeProvider: (sessionId) => BgProcessStore | undefined`
  callback (symmetric with the existing `clientsProvider`). The manager resolves the store from the
  session's `projectId` via `sessionManager.getSessionStore`'s sibling — add
  `SessionManager.getBgProcessStore(projectId?)` that returns `ProjectContext.bgProcessStore` (a
  new field on `ProjectContext`, constructed next to the other stores in
  `project-context.ts` ~L77). For the test/no-PCM path, fall back to a single store over the test
  state dir.

```ts
constructor(
  clientsProvider: (sessionId: string) => Set<WebSocket> | undefined,
  spawnFn: SpawnFn = defaultSpawn,
  storeProvider?: (sessionId: string) => BgProcessStore | undefined,   // NEW
  tailerFactory: TailerFactory = defaultTailerFactory,                  // NEW, §6
)
```

`ProjectContext` gains `readonly bgProcessStore = new BgProcessStore(this.stateDir)`.

## 6. Tailing

A `Tailer` watches a log file and emits new bytes from a starting offset. It is injectable
(`tailerFactory`) so unit tests can drive it with fake content and never touch the OS.

```ts
export interface Tailer {
  /** Begin tailing from `startOffset`; calls onChunk for each new slice. */
  start(startOffset: number): void;
  stop(): void;
}
export interface TailerSpec {
  outLog: string; errLog: string;
  inContainer: boolean; containerId?: string;
  onChunk: (stream: "stdout" | "stderr", text: string, newOffset: number) => void;
}
export type TailerFactory = (spec: TailerSpec) => { out: Tailer; err: Tailer };
```

- **Host (default factory):** `fs.watch` + read from offset, or a simple poll loop
  (`fs.read` from offset every ~200ms) for portability on Windows where `fs.watch` is flaky.
  **Chosen: poll loop** (200ms) reading `fs.statSync(path).size`; if larger than offset, read the
  delta, split into lines, invoke `onChunk`, advance offset. Treat ENOENT as "not yet created".
- **Docker:** spawn `docker exec <cid> tail -c +<offset+1> -F <containerLogPath>` and read its
  stdout pipe; `onChunk` advances offset by bytes received. `stop()` kills the `tail` exec. On
  restart this same mechanism resumes from the persisted offset — that **is** the re-attach.

The tailer feeds the existing in-memory `appendLog()` / `bg.stdout`/`bg.stderr` arrays and the
existing `bg_process_output` WS broadcast — so the API (`getLogs`, `grep`, `head`, `slice`) and the
pill work unchanged. The only change to `create()` is that the chunk source is the tailer, not
`child.stdout.on("data")`.

### 6.1 Detecting exit via the status file

Independently of the tailer, a **status watcher** polls `<bgId>.status` (host: `fs.existsSync` +
read; docker: `docker exec <cid> cat <statusFile>` returning non-empty). When the status file
appears with content:

1. parse the integer exit code (trim; tolerate partial write — see §11, retry until a full integer
   line is present or a short grace timeout elapses);
2. set `status="exited"`, `exitCode=<n>`, `endTime=Date.now()`;
3. do a **final tail flush** (read any remaining bytes past the offset) so no trailing output is
   lost;
4. resolve `bg.exited`, persist (recovery-critical → sync), broadcast `bg_process_exited`, stop the
   tailers and status watcher.

This **replaces** the current reliance on `child.on("exit")`. The child `exit` event (when we still
have a handle, i.e. while live) is used only as a *hint* to check the status file promptly rather
than waiting for the next poll; the **authoritative** exit code always comes from the status file,
never from `child.exitCode` (which, post-restart, we don't have).

## 7. Restore + re-attach reconciliation

Hook into boot right where sessions restore. Add `BgProcessManager.restore()` called from
`session-manager.ts::restoreSessions()` (after the live-restore loop, ~L3260) — at which point
sessions exist and (for sandboxed sessions) `session.containerId` has been re-resolved via
`SandboxManager.getContainerId()` (`session-manager.ts` ~L3858). The manager iterates every
`PersistedBgProcess` across all project stores (or, when called per-session, just that session's).

For each persisted record:

```
if status == "exited" or "unrecoverable":
    rehydrate in-memory record; load tail of log files into log[]/stdout[]/stderr[]
      (read last MAX_LOG_LINES/MAX_LOG_BYTES from the files); broadcast nothing
      (client re-fetches via GET on reconnect). Done.

if status == "running":
    liveness = checkAlive(record)
    case ALIVE:
        # re-attach
        rehydrate record (status stays "running")
        load existing log tail into memory from offset 0..persistedOffset
        start tailers from persistedOffset   -> resumes live streaming
        start status watcher                 -> captures eventual real exit code
    case COMPLETED_DURING_DOWNTIME:   # not alive, but status file present & parseable
        read exitCode from status file; read final log tail
        status="exited"; endTime = status file mtime (best-effort) or Date.now()
        broadcast bg_process_exited
    case UNRECOVERABLE:               # not alive AND (no status file | log missing | pid reuse)
        status="unrecoverable"; exitCode stays null
        load whatever log tail exists
        broadcast bg_process_exited with exitCode=null and a flag (see §9)
        # NEVER fabricate an exit code
```

### 7.1 Liveness checks

- **Host:** `process.kill(pid, 0)` — throws ESRCH if gone, returns if alive. **Pid-reuse guard:**
  compare the wrapper start time. We don't have a portable start-time probe on Windows cheaply, so
  the defensible guard is: a process is considered the *same* one only if the **status file is
  absent** (still running) **and** `kill(pid,0)` succeeds. If the status file exists, the process
  already finished → treat as COMPLETED regardless of pid liveness (a reused pid can't retroactively
  un-write the status file). This makes pid reuse safe: reuse only matters when status is absent,
  and a reused unrelated pid being alive is the only residual risk — accepted and documented, with
  the fallback that if its status file never appears the watcher simply keeps tailing an
  empty/foreign file and the user can dismiss it. (A stronger guard — persisting the OS boot id and
  re-checking — is deferred; noted in §11.)
- **Docker:** container alive via `docker inspect -f '{{.State.Running}}' <cid>` (and the
  containerId must still resolve from `SandboxManager`; if the project's container was recreated,
  the old container/exec is gone → not alive). Then `docker exec <cid> kill -0 <pid>` for the
  in-container wrapper. If the container is gone, the in-container `/tmp` files are gone too → if no
  status was ever read, **unrecoverable**; if we had already recorded an exit, it stays exited.

### 7.2 Container recreated

Container recreation (new `containerId`) means the process and its `/tmp` files are gone. Such a
record is **unrecoverable** unless its status/exit was captured before the restart. This is correct
and honest — we do not invent an exit code.

## 8. Log caps on disk

The in-memory trim (`MAX_LOG_LINES` 5000 / `MAX_LOG_BYTES` 512KB) already caps memory. On disk we
enforce the same ceiling per file via **size-triggered truncation-from-front rotation**:

- The tailer/manager tracks bytes written. When an `.out.log` (or `.err.log`) exceeds
  `MAX_LOG_BYTES` (512KB), perform a **rotation**: copy the last `MAX_LOG_BYTES` bytes to
  `<bgId>.out.log.tmp`, `rename` over the original, and reset the tailer offset to the new file
  size minus the retained window. Because the *child* keeps appending to the original fd
  (host detached) we cannot truncate the file the child holds open on Windows safely. Therefore:

> **Chosen disk-cap strategy:** the **wrapper** caps the file, not the gateway. Pipe the command
> through a bounded ring using `tail` is not available portably. Instead the wrapper limits output
> with a line cap is also not portable. The robust, portable choice: **the gateway does not
> truncate the child-held file**; instead it enforces the cap on the *in-memory* projection (as
> today) and rotates the on-disk file **only after the process exits** (when no writer holds it),
> trimming it to the last 512KB / 5000 lines for durable storage. While running, on-disk growth is
> bounded by a hard **safety ceiling** (e.g. 8× `MAX_LOG_BYTES` = 4MB): if the live file exceeds
> the safety ceiling, the gateway issues a one-time truncation by spawning a helper that rewrites
> the file (host: `tail -c <cap>`; docker: `docker exec <cid> sh -c 'tail -c <cap> f > f.tmp && mv
> f.tmp f'`) accepting the rare risk of a torn line. This keeps disk bounded without racing the
> writer in the common case.

The post-exit trim runs in the exit handler (§6.1) right before the record is marked exited, so the
durable file the user later inspects/dismisses is already within caps.

## 9. Kill vs dismiss

Today both UI buttons issue the same `DELETE /api/sessions/:id/bg-processes/:pid`, and the route
(`server.ts` ~L11762) "tries kill first, then remove". This conflates the two. Make them explicit.

### 9.1 REST

Add a query param to disambiguate (backward-compatible default = legacy behaviour):

```
DELETE /api/sessions/:id/bg-processes/:pid?action=kill      # terminate running proc; KEEP exited record
DELETE /api/sessions/:id/bg-processes/:pid?action=dismiss   # remove record + delete persisted files
DELETE /api/sessions/:id/bg-processes/:pid                  # legacy: kill-if-running else dismiss
```

- `action=kill` → `bgProcessManager.kill(...)`. Process is signalled; the status watcher captures
  the real exit code (the wrapper still writes `$?`, which will be 143/SIGTERM-ish or the killed
  code). The record transitions to `exited` and **persists**. Returns `{ ok: true, killed: true }`.
- `action=dismiss` → new `bgProcessManager.dismiss(sessionId, pid)`: refuse if still running
  (must kill first) unless `force`; remove the in-memory record, `BgProcessStore.remove`, and
  **delete the per-process files** (`.out.log`, `.err.log`, `.status`, `.pid`; for docker also
  `docker exec <cid> rm -f <containerPaths>` best-effort). Broadcast a new
  `bg_process_dismissed` WS event so other clients drop the pill. Returns `{ ok: true }`.

### 9.2 New manager methods

```ts
// bg-process-manager.ts
kill(sessionId, processId): boolean;                 // existing — keep; now also relies on status file for exit code
dismiss(sessionId, processId, opts?: { force?: boolean }): boolean;   // NEW: remove record + purge files
restore(): Promise<void>;                            // NEW: §7 reconciliation across stores
```

`remove()` (existing, index-only) is folded into `dismiss()`. `cleanup(sessionId)` (on session
terminate, `session-manager.ts` ~L5601) keeps killing running children but now also leaves durable
files in place only if the session is merely restarting — on real terminate it should
`removeForSession` + delete files (a terminated session's pills are gone).

### 9.3 WS protocol

`src/server/ws/protocol.ts` (~L158):

- `bg_process_created` / `bg_process_output` — unchanged.
- `bg_process_exited` — add optional `unrecoverable?: boolean` (true when exit could not be
  determined; `exitCode` is `null`).
- **NEW** `bg_process_dismissed` — `{ type: "bg_process_dismissed"; processId: string }`.

### 9.4 Client + UI

- `src/app/session-manager.ts`: `killBgProcess` → DELETE `?action=kill`; `dismissBgProcess` →
  DELETE `?action=dismiss`. Add a WS handler for `bg_process_dismissed` (~L1422) that removes the
  process from `ai.bgProcesses`. `bg_process_exited` handler maps `unrecoverable` into the local
  record.
- `src/ui/components/BgProcessPill.ts`: extend `BgProcessInfo.status` to include `"unrecoverable"`.
  `_statusIndicator()` renders a distinct marker (e.g. amber `?` with title "exit status unknown —
  process was lost across a restart"). The exit-code span shows `unknown` instead of `exit N` when
  `exitCode === null && status === "unrecoverable"`. Kill button only for `running`; Remove
  (dismiss) for `exited` **and** `unrecoverable`.

## 10. Data-flow diagrams (text)

### Create (host)
```
agent -> POST /bg-processes -> bgMgr.create()
  compute BgPaths under <stateDir>/bg-processes/<sid>/
  spawnFn(cmd, cwd, undefined, paths)            # wrapper: echo $$>pid; {cmd}>out 2>err; echo $?>status
  child.unref()
  store.put(record status=running)               # atomic write
  tailerFactory({out,err}).start(0)              # poll files -> appendLog -> bg_process_output WS
  statusWatcher.start()                          # poll <status>
  broadcast bg_process_created
```

### Live output
```
wrapper writes -> <bgId>.out.log grows
tailer poll detects delta -> read bytes -> appendLog() -> store.update(outOffset) [debounced]
  -> broadcast bg_process_output -> pill.appendOutput()
```

### Restart -> restore -> re-attach
```
boot: restoreSessions() ... containerId re-resolved
bgMgr.restore():
  for each PersistedBgProcess:
    running + alive       -> rehydrate; tailer.start(persistedOffset); statusWatcher.start()
    running + completed   -> read <status> exitCode; final tail; status=exited; broadcast exited
    running + unrecover.  -> status=unrecoverable; broadcast exited{exitCode:null,unrecoverable:true}
    exited/unrecoverable  -> rehydrate from files (no broadcast; client GETs on reconnect)
client reconnects -> GET /bg-processes -> sees restored pills; WS resumes streaming
```

### Exit
```
wrapper finishes -> echo $? > <status>
statusWatcher sees <status> with content -> parse exitCode (retry on partial)
  -> final tail flush -> status=exited,endTime -> store.update(sync) -> resolveExited()
  -> broadcast bg_process_exited -> stop tailers+watcher
  -> post-exit trim of <out/err>.log to caps
```

### Kill
```
UI Kill -> DELETE ?action=kill -> bgMgr.kill()
  host: taskkill /T /F <pid>  (win) | process.kill(-pid,SIGTERM)
  docker: child.kill(SIGTERM) on docker-exec handle (signals container proc)
wrapper still writes <status> (killed code) -> statusWatcher -> status=exited (persists)
pill stays as exited until dismissed
```

### Dismiss
```
UI Remove -> DELETE ?action=dismiss -> bgMgr.dismiss()
  refuse if running (unless force)
  store.remove(); delete <out>.log,<err>.log,<status>,<pid>
  docker: docker exec <cid> rm -f <containerPaths>  (best-effort)
  broadcast bg_process_dismissed -> all clients drop pill
record never reappears after subsequent restart (files + index entry gone)
```

## 11. Risks & edge cases

- **Partial status-file write.** `echo $? > f` is a single small write but the watcher may read
  mid-write. Mitigation: require a parseable integer **followed by newline**; if absent, retry for
  up to ~2s before treating as still-writing. The wrapper writes exactly one line, so a complete
  read yields a clean integer.
- **Pid reuse (host).** Addressed in §7.1: status-file presence is authoritative; pid liveness only
  consulted when status is absent. Residual risk (foreign reused pid alive, original gone, status
  never written) degrades to a stuck "running" pill the user can kill/dismiss — never a fabricated
  exit code. Future hardening: persist OS boot time / a per-spawn nonce written to the pidfile and
  re-verified.
- **Log rotation racing the tailer.** Avoided in the common case by only trimming the durable file
  **after** exit (no concurrent writer). The live safety-ceiling truncation is rare and may tear a
  single line — acceptable and documented.
- **Windows process-group kill.** `taskkill /pid <pid> /T /F` kills the wrapper shell **and** its
  child tree (`/T`). The wrapper's `echo $? > status` runs only if the command exits normally; a
  hard `/F` kill of the inner command still lets the shell continue to the `echo $?` only in the
  POSIX `;`-chained form if the shell itself survives — but `/T /F` kills the shell too. Therefore
  **a force-killed host process may not write a status file.** Handling: `kill()` records an
  intent-to-kill timestamp; the watcher, seeing the pid gone with no status within a grace window
  **after an explicit kill**, marks `exited` with `exitCode = null` but `unrecoverable = false` and
  a clear "killed" label (we *know* it was killed — that is not fabrication). Distinguish from the
  restart-loss case (`unrecoverable = true`).
- **Docker container gone.** `/tmp` files vanish with the container. If exit was already captured →
  exited; else → unrecoverable. Never invent a code.
- **File not yet created** between spawn and first wrapper write: tailer treats ENOENT as 0 bytes
  and retries.
- **Per-project store growth.** `bg-processes.json` only holds live records; dismiss/cleanup prune
  it. Bounded by the number of undismissed pills.
- **Backward compat.** Old gateways had no persisted bg processes; first boot after upgrade simply
  finds no `bg-processes.json` and starts empty — no migration needed. Processes spawned by an old
  binary and still running at upgrade are not persisted and behave as today (lost on restart) —
  acceptable one-time gap. No state-dir migration required.

## 12. Function signatures (summary of new/changed)

`src/server/agent/bg-process-manager.ts`
```ts
export interface BgPaths { outLog; errLog; status; pid; inContainer: boolean }
export type SpawnFn = (command, cwd, containerId, paths: BgPaths) => ChildProcess;
export type TailerFactory = (spec: TailerSpec) => { out: Tailer; err: Tailer };
function buildHostWrapper(command, paths, shellKind: "posix" | "cmd"): string;
function buildDockerWrapper(command, paths): string;
class BgProcessManager {
  constructor(clientsProvider, spawnFn?, storeProvider?, tailerFactory?);
  create(sessionId, command, cwd, containerId?, sandboxed?, name?): BgProcessInfo;  // now wires files+tailer
  kill(sessionId, processId): boolean;
  dismiss(sessionId, processId, opts?: { force?: boolean }): boolean;               // NEW
  restore(): Promise<void>;                                                          // NEW
  // getLogs/grep/head/slice/waitForExit/list unchanged
}
// BgProcess / BgProcessInfo.status widened to "running" | "exited" | "unrecoverable"
```

`src/server/agent/bg-process-store.ts` (NEW) — `BgProcessStore`, `PersistedBgProcess` (§5).

`src/server/agent/project-context.ts` — add `readonly bgProcessStore = new BgProcessStore(this.stateDir)`.

`src/server/agent/session-manager.ts` — `getBgProcessStore(projectId?): BgProcessStore`; call
`bgProcessManager.restore()` at the end of `restoreSessions()`; update `cleanup` call site to purge
files on real terminate.

`src/server/server.ts` — construct `BgProcessManager` with `storeProvider`
(`(sid) => sessionManager.getBgProcessStore(sessionManager.getSession(sid)?.projectId)`); split the
DELETE route on `?action=`.

`src/server/ws/protocol.ts` — `bg_process_exited` gains `unrecoverable?`; add `bg_process_dismissed`.

`src/app/session-manager.ts` — `killBgProcess`/`dismissBgProcess` use `?action=`; handle
`bg_process_dismissed`; map `unrecoverable`.

`src/ui/components/BgProcessPill.ts` — render `unrecoverable` status; dismiss for exited+unrecoverable.

## 13. Test plan

### Unit (`tests/`, `node:test`, no real OS processes)

Extend/replace `tests/bg-process-manager.test.ts` and add **`tests/bg-process-persistence.test.ts`**:

- **Persistence round-trip:** create with a fake `SpawnFn` + fake `TailerFactory` that writes to a
  temp `stateDir`; assert `bg-processes.json` written atomically; construct a *fresh*
  `BgProcessManager` over the same dir; `restore()`; assert records + log tail restored.
- **Re-attach — alive:** persisted record `status=running`, fake liveness=alive, fake log file with
  extra bytes past `outOffset`; `restore()` resumes tailing and emits the new bytes; later the fake
  status file gains `0` → `bg_process_exited` with `exitCode=0`.
- **Re-attach — completed-during-downtime:** liveness=dead, status file contains `137`; `restore()`
  → `status=exited`, `exitCode=137`, no fabricated code.
- **Re-attach — unrecoverable:** liveness=dead, **no** status file (or missing log) → `status=
  unrecoverable`, `exitCode=null`, `unrecoverable:true` broadcast; assert **no** numeric exit code.
- **Kill writes real code:** kill path leaves `status=exited` once status file appears; killed-no-
  status path → `exitCode=null`, killed label, `unrecoverable:false`.
- **Dismiss purges files:** `dismiss()` deletes `.out.log/.err.log/.status/.pid` and the index
  entry; a subsequent `restore()` finds nothing.
- **Disk caps:** feed > caps via fake tailer; assert in-memory trim and post-exit file trim keep
  the durable file ≤ 512KB / 5000 lines.
- **Wrapper builders:** `buildHostWrapper` (posix vs cmd) and `buildDockerWrapper` produce the exact
  redirect + status-write strings (string assertions — pure, fast).

### Browser E2E (required) — `tests/e2e/ui/bg-process-persistence.spec.ts`

Pattern from `tests/e2e/ui/settings.spec.ts`, spawned-gateway harness:

1. Create a long-running bg process (e.g. a script that prints a line every 200ms) via the API/UI;
   assert the pill appears and is **streaming** (log grows).
2. **Restart the spawned gateway** (harness restart); assert the pill is **restored** and **still
   streaming** new lines after restart.
3. Let it finish; assert the pill shows the **real exit code** (e.g. `exit 0`).
4. **Dismiss**; assert the pill disappears, then reload the page and restart again → it **stays
   gone**.
5. **Kill** flow: start another long-runner, Kill it, assert it becomes an **exited** pill that
   **survives a restart** until dismissed.

Keep `tests/e2e/bg-process-sandbox-guard.spec.ts` green (the `sandboxed && !containerId` guard is
unchanged). Docker re-attach is covered by `test:manual` (extend
`sandbox-recovery-docker.spec.ts`).

### Commands

`npm run check`, `npm run test:unit`, `npm run test:e2e`, and (session-lifecycle/restart/sandbox)
`npm run test:manual` per AGENTS.md.

## 14. Implementation order (suggested)

1. `BgProcessStore` + `PersistedBgProcess` (copy `SessionStore` helpers) + unit round-trip test.
2. `BgPaths`, wrapper builders, change `defaultSpawn` + `create()` to redirect to files and feed
   from a `Tailer` (default poll tailer); status watcher for exit.
3. `restore()` reconciliation (3 cases) + wire into `restoreSessions()`; `ProjectContext.bgProcessStore`.
4. `dismiss()` + split DELETE route + `bg_process_dismissed` WS event + `unrecoverable` status
   plumbing through protocol/client/pill.
5. Disk caps (post-exit trim + live safety ceiling).
6. Tests: unit persistence/re-attach/dismiss/caps; browser E2E; keep guard test green; `check`.
