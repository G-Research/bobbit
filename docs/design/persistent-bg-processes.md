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
- Keep disk usage bounded by the existing caps (`MAX_LOG_LINES` 5000 / `MAX_LOG_BYTES` 512KB)
  **at all times** — while the process is running, across a restart, and after exit (§8).
- Preserve sandbox parity and the `sandboxed && !containerId` host-execution guard
  (`bg-process-manager.ts` `create()` ~L118).

## 2. The crux: durable log/status files instead of in-memory pipes

You **cannot** re-attach to a dead parent's stdout/stderr pipes. The spawn model must change so
that output and exit status live on disk, owned by the *child*, independent of the gateway. Two
kinds of file per stream (see §8 for the cap mechanics):

- At spawn time, **redirect the command's stdout/stderr into a transient per-stream spool file**
  (`<bgId>.out.spool` / `<bgId>.err.spool`) that the child appends to. The spool is an explicitly
  **transient, gateway-managed ring** (copytruncated, §8) — it is *not* "the persisted log".
- The gateway tails each spool delta into the existing in-memory capped buffer and continuously
  rewrites a **durable capped projection** it owns exclusively (`<bgId>.out.log` /
  `<bgId>.err.log`, atomic tmp+rename, always ≤ 512KB / 5000 lines). Restore and the REST readers
  read the **projection**, never the raw spool.
- **Capture the real exit code durably**: wrap the command so that when it finishes it writes its
  exit status to a per-process status file (`echo $? > <statusfile>`), and write the wrapper's own
  pid **plus a per-spawn nonce** to a pidfile (§5.1, §7.1 — the nonce detects pid reuse on restore).
- The gateway streams output to clients by **tailing the spool from a byte offset** and projecting
  it — the same mechanism serves both the live case and the post-restart re-attach case.

This is a fundamental change to `defaultSpawn` and to how `create()` wires output capture. The
existing in-memory `log`/`stdout`/`stderr` arrays and WS broadcasts are *kept* (the API and pill
read from them), but they are now **fed by tailing the spool file** rather than by listening on the
child's pipes directly, and the durable projection is rewritten from that same capped buffer.

### 2.1 Why a log/status file and not the live pipe

| Concern | Live pipe (today) | Spool + projection (proposed) |
|---|---|---|
| Survives gateway restart | No | Yes (child keeps appending to spool) |
| Re-attach output after restart | Impossible | Tail spool from saved offset → projection |
| Real exit code after restart | Lost | Read from status file |
| Docker-exec, gateway down | Lost | Container keeps writing spool; read on restore |
| On-disk cap held while running | n/a | Gateway-owned capped projection (§8) |
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
  bg-processes/                          # NEW: per-process files
    <sessionId>/
      <bgId>.out.spool                   # TRANSIENT: child appends stdout (gateway-managed ring, copytruncated)
      <bgId>.err.spool                   # TRANSIENT: child appends stderr
      <bgId>.out.log                     # DURABLE PROJECTION: gateway-owned, atomic rewrite, ≤512KB/5000 lines
      <bgId>.err.log                     # DURABLE PROJECTION: gateway-owned, atomic rewrite, ≤512KB/5000 lines
      <bgId>.status                      # final exit code, written once by the wrapper
      <bgId>.pid                         # wrapper pid + spawn nonce (host) — liveness + pid-reuse probe
```

The **spool** is the only file the child writes; the gateway never lets the child write the
**projection** (`.log`). Restore and every REST reader (`getLogs`/`grep`/`head`/`slice`) read the
projection exclusively — the spool is an implementation-internal ring, never served to clients.

### 3.1 Stream files: spool vs projection

To preserve the stdout/stderr distinction the wrapper redirects each stream to its **own spool
file** — keeping two files (`.out.spool`, `.err.spool`) is fully portable across Git Bash, cmd, and
`/bin/sh`, far simpler than interleaving a tagged single stream. The child only ever appends to the
spool.

The gateway tails each spool delta, feeds it into the existing in-memory capped buffer
(`appendLog()` interleaves `stdout`/`stderr` by arrival, exactly as today's pipe `data` events),
and from that capped buffer atomically rewrites a per-stream **durable projection**
(`.out.log`, `.err.log`). The projection is therefore always within caps (§8), and the in-memory
`log[]` (interleaved) is rebuilt by the tailer as chunks arrive. The status file remains a single
`<bgId>.status`.

Final naming (used throughout this doc):

```
<stateDir>/bg-processes/<sessionId>/<bgId>.out.spool   # transient, child-written
<stateDir>/bg-processes/<sessionId>/<bgId>.err.spool   # transient, child-written
<stateDir>/bg-processes/<sessionId>/<bgId>.out.log     # durable projection, gateway-written
<stateDir>/bg-processes/<sessionId>/<bgId>.err.log     # durable projection, gateway-written
<stateDir>/bg-processes/<sessionId>/<bgId>.status
<stateDir>/bg-processes/<sessionId>/<bgId>.pid         # host spawns only (pid + nonce)
```

### 3.2 Docker reachability

For sandboxed sessions the worktree is **container-internal** (cloned into `/workspace` or
`/workspace-wt/...`), **not** bind-mounted from the host (see
`src/server/agent/sandbox-clone-source.ts`, `MOUNTED_SRC_PATH`, and
`session-manager.ts::isSandboxContainerPath` ~L96). The host cannot read a file written inside the
container by path.

Therefore docker-exec processes keep **all four stream files plus status and pidfile inside the
container** (under `/tmp/bobbit-bg/<sessionId>/<bgId>.*`), and the host reaches them via
`docker exec`. The same spool→projection split applies: the child appends to the in-container
spool; the gateway tails it and rewrites the in-container projection via
`docker exec <cid> /bin/sh -c 'cat > <log>.tmp && mv <log>.tmp <log>'` from the capped buffer
(atomic rename inside the container). The single `inContainer` flag therefore covers every file
uniformly.

- **Tail live / re-attach:** `docker exec <cid> tail -c +<offset+1> -F <containerSpoolPath>` (the
  `-F` keeps following across truncation; `-c +<offset+1>` resumes from a byte offset).
- **Read projection / final on restore-after-downtime:** `docker exec <cid> cat <containerLogPath>`
  and `docker exec <cid> cat <containerStatusPath>`.
- **Liveness:** `docker inspect -f '{{.State.Running}}' <cid>` for the container, plus
  `docker exec <cid> kill -0 <pid>` for the in-container wrapper pid, plus
  `docker exec <cid> cat <containerPidfile>` to re-check the spawn nonce (§7.1).

The metadata records the **container paths** (host paths empty for docker), plus the `containerId`.
The in-container pidfile holds the pid **and** nonce, read via `docker exec cat`.

> The container path lives under the worktree (host-unreadable but container-writable) which is
> the only guaranteed-writable, restart-stable location for a sandboxed session. `/tmp` is also
> acceptable and avoids polluting the worktree; **chosen: `/tmp/bobbit-bg/<sessionId>/<bgId>.*`**
> inside the container, created with `mkdir -p` by the wrapper. `/tmp` survives for the container's
> lifetime, which is exactly the process's lifetime.

## 4. Spawn model (concrete commands)

`SpawnFn` keeps its signature so tests can override it. `defaultSpawn` changes to: (a) compute the
spool/projection/status/pid paths, (b) build a wrapper command that redirects output to the
**spool** files and writes the status file + pidfile (pid + nonce), (c) spawn the wrapper.

```ts
// bg-process-manager.ts
export interface BgPaths {
  outSpool: string; // TRANSIENT child-written stdout spool (host path OR container path)
  errSpool: string; // TRANSIENT child-written stderr spool
  outLog: string;   // DURABLE gateway-written stdout projection
  errLog: string;   // DURABLE gateway-written stderr projection
  status: string;
  pid: string;      // host spawn only; "" for docker (in-container pidfile path used instead)
  nonce: string;    // per-spawn random token written into the pidfile (pid-reuse guard, §7.1)
  /** true when paths are container-internal and must be read/written via `docker exec` */
  inContainer: boolean;
}

export type SpawnFn = (
  command: string,
  cwd: string,
  containerId: string | undefined,
  paths: BgPaths,            // NEW — spool to redirect into / status + pid(+nonce) to write
) => ChildProcess;
```

### 4.1 Host wrapper (Windows Git Bash / `/bin/sh`)

`getShellConfig()` (`src/server/agent/shell-util.ts`) returns Git Bash (`bash -c`) on Windows when
present, else `cmd.exe /d /s /c`, and `/bin/sh -c` on Linux/macOS. The wrapper must work for **both
shell families**. Git Bash and `/bin/sh` share POSIX syntax; cmd.exe does not.

**POSIX shell (Git Bash on Windows + /bin/sh on Linux/macOS):** the wrapper is a single `-c`
string. Output is **appended** (`>>`) to the spool so the gateway can copytruncate it (§8), and the
pidfile gets the shell pid **and** the per-spawn nonce on two lines:

```sh
printf '%s\n%s\n' "$$" "<nonce>" > "<pid>" ; { <command> ; } >> "<outSpool>" 2>> "<errSpool>" ; echo $? > "<status>"
```

`$$` is the shell pid; `$?` is the command's exit code; `<nonce>` is the random token the manager
generated for this spawn. This is the **primary path** (Git Bash is preferred on the Windows host
per `GIT_BASH` in `shell-util.ts`). POSIX `>>` honours `O_APPEND`, so after a gateway copytruncate
the next child write lands at offset 0 — the property §8 relies on.

**cmd.exe fallback (Windows without Git Bash):** POSIX `$$`/`$?` do not exist. Use:

```bat
echo %errorlevel%
```

Wrapper string passed after `/d /s /c`:

```bat
(<command>) > "<outSpool>" 2> "<errSpool>" & echo %errorlevel% > "<status>"
```

cmd.exe does **not** honour `O_APPEND`, so copytruncate of the spool would not reset the child's
write position. The cmd fallback therefore uses `>` (not `>>`) and relies **solely on the durable
projection cap** (§8) — its spool may grow unbounded for the lifetime of a single chatty process
(rare path, documented). cmd also has no portable pidfile-from-script idiom: it writes the **pid
only** (`child.pid`, recorded by the manager into `<pid>`), with **no nonce** — a documented weaker
pid-reuse guard (§7.1). `%errorlevel%` after `&` captures the inner command's exit code; `&` (not
`&&`) ensures the status is written even on failure.

> Because the wrapper string differs by shell family, the manager picks it via a new helper
> `buildHostWrapper(command, paths, shellKind)` where `shellKind` is derived from
> `getShellConfig()` (Git Bash / sh → "posix"; cmd.exe → "cmd"). This keeps the platform branching
> in one tested function.

### 4.2 Docker wrapper (`/bin/sh -c` inside the container)

Always POSIX `/bin/sh` inside the container. Paths are container-internal (`/tmp/bobbit-bg/...`),
output appended to the spool, pidfile gets pid + nonce:

```sh
mkdir -p "<dir>" ; printf '%s\n%s\n' "$$" "<nonce>" > "<pid>" ; { <command> ; } >> "<outSpool>" 2>> "<errSpool>" ; echo $? > "<status>"
```

spawned as:

```
docker exec -w <containerCwd> <containerId> /bin/sh -c '<wrapper>'
```

(unchanged `docker exec` shape from `defaultSpawn`; only the inner string gains the redirect +
status write). `MSYS_NO_PATHCONV=1` / `MSYS2_ARG_CONV_EXCL=*` env stays so Git Bash on the host
does not mangle container paths.

### 4.3 stdio for the spawned wrapper

Because output now goes to the spool files, the child's stdio can be `["ignore", "ignore",
"ignore"]` for host spawns — we no longer read pipes. (Keep `"pipe"` for docker is unnecessary; the
docker-exec host handle is only used for liveness/kill while alive.) Host spawns keep
`detached: true` + `child.unref()` so the orphan survives gateway exit.

> Edge: a tiny window exists between spawn and the wrapper creating the spool files. The tailer
> must treat "file not yet present" as "0 bytes, retry" rather than an error (see §6).

## 5. Persistence layer

### 5.1 Metadata schema

```ts
// NEW: src/server/agent/bg-process-store.ts
export interface PersistedBgProcess {
  sessionId: string;
  id: string;                 // bgId, e.g. "bg-3"
  name: string;
  command: string;
  pid: number;                // wrapper pid (host shell) or docker-exec host pid (in-container pid for docker)
  cwd: string;
  containerId?: string;       // present for sandboxed/docker spawns
  status: "running" | "exited" | "unrecoverable";
  exitCode: number | null;    // null while running, when killed-without-status, OR unrecoverable
  /** why the process reached a terminal state; null while running. Authoritative source of truth. */
  terminalReason: "normal" | "killed" | "unrecoverable" | null;
  startTime: number;
  endTime: number | null;
  // transient spool files (child appends; gateway-managed ring, copytruncated — §8)
  outSpool: string;
  errSpool: string;
  // durable capped projections (gateway-owned; atomic tmp+rename; ≤512KB/5000 lines)
  outLog: string;
  errLog: string;
  statusFile: string;
  pidFile: string;            // "" for docker (pid+nonce live in the in-container pidfile)
  /** per-spawn random token; written into the pidfile, re-checked on restore to detect pid reuse (§7.1) */
  nonce: string;
  /** true when the files are container-internal (read/written via docker exec) */
  inContainer: boolean;
  /** bytes of each spool already consumed by the tailer — lets re-attach resume */
  outOffset: number;
  errOffset: number;
}
```

`status` gains a third value **`"unrecoverable"`** (the §7 fallback), and **`terminalReason`** makes
the three terminal outcomes distinguishable: `"normal"` (status file read), `"killed"` (explicitly
killed, may have no status file), `"unrecoverable"` (lost across restart / pid reused). It is the
single authoritative field — there is **no** separate `unrecoverable` boolean anywhere. This
requires widening the union in `BgProcess`, `BgProcessInfo` (`bg-process-manager.ts`), the WS event
types (`src/server/ws/protocol.ts`), and the client/UI types (§9). `exitCode` is never fabricated;
it stays `null` for `killed`-without-status and `unrecoverable`.

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
           "status"|"exitCode"|"terminalReason"|"endTime"|"outOffset"|"errOffset"|"pid">>): void;
  remove(sessionId: string, id: string): void;         // index entry only
  removeForSession(sessionId: string): void;
  flush(): void;
  /** dir holding the per-process files for a session */
  filesDir(sessionId: string): string;                 // <stateDir>/bg-processes/<sessionId>
}
```

**Write cadence:** `put` on create (structural → `saveNow`); `update` on exit and on
offset-advance. Offsets advance frequently, so `outOffset`/`errOffset` updates use the **debounced**
path (like `lastActivity`), while `status`/`exitCode`/`terminalReason`/`endTime` are
**recovery-critical** → flush synchronously (mirror `SessionStore.RECOVERY_CRITICAL_FIELDS`). Losing a few KB of replayed offset
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

A `Tailer` watches a **spool** file and emits new bytes from a starting offset. It is injectable
(`tailerFactory`) so unit tests can drive it with fake content and never touch the OS. The manager
feeds each chunk into the capped in-memory buffer and (debounced ~500ms) rewrites the durable
projection from that buffer (§8).

```ts
export interface Tailer {
  /** Begin tailing from `startOffset`; calls onChunk for each new slice. */
  start(startOffset: number): void;
  stop(): void;
}
export interface TailerSpec {
  outSpool: string; errSpool: string;   // the tailer watches the SPOOL, never the projection
  inContainer: boolean; containerId?: string;
  onChunk: (stream: "stdout" | "stderr", text: string, newOffset: number) => void;
}
export type TailerFactory = (spec: TailerSpec) => { out: Tailer; err: Tailer };
```

- **Host (default factory):** `fs.watch` + read from offset, or a simple poll loop
  (`fs.read` from offset every ~200ms) for portability on Windows where `fs.watch` is flaky.
  **Chosen: poll loop** (200ms) reading `fs.statSync(spool).size`; if larger than offset, read the
  delta, split into lines, invoke `onChunk`, advance offset. Treat ENOENT as "not yet created".
  The same loop performs spool copytruncate when the spool exceeds the cap (§8).
- **Docker:** spawn `docker exec <cid> tail -c +<offset+1> -F <containerSpoolPath>` and read its
  stdout pipe; `onChunk` advances offset by bytes received. `stop()` kills the `tail` exec. On
  restart this same mechanism resumes from the persisted offset — that **is** the re-attach.

The tailer feeds the existing in-memory `appendLog()` / `bg.stdout`/`bg.stderr` arrays (already
capped) and the existing `bg_process_output` WS broadcast — so the API (`getLogs`, `grep`, `head`,
`slice`) and the pill work unchanged — and triggers the debounced atomic rewrite of the durable
projection from that capped buffer (§8). The only change to `create()` is that the chunk source is
the spool tailer, not `child.stdout.on("data")`. Readers always consume the projection, never the
spool.

### 6.1 Detecting exit via the status file

Independently of the tailer, a **status watcher** polls `<bgId>.status` (host: `fs.existsSync` +
read; docker: `docker exec <cid> cat <statusFile>` returning non-empty). When the status file
appears with content:

1. parse the integer exit code (trim; tolerate partial write — see §11, retry until a full integer
   line is present or a short grace timeout elapses);
2. set `status="exited"`, `exitCode=<n>`, `terminalReason="normal"`, `endTime=Date.now()`;
3. do a **final tail flush** (read any remaining spool bytes past the offset → capped buffer → final
   atomic projection rewrite) so no trailing output is lost and the projection is current;
4. resolve `bg.exited`, persist (recovery-critical → sync), broadcast `bg_process_exited` (with
   `terminalReason`), stop the tailers and status watcher, then delete the now-consumed spool
   files (the durable projection is what survives — §8).

This **replaces** the current reliance on `child.on("exit")`. The child `exit` event (when we still
have a handle, i.e. while live) is used only as a *hint* to check the status file promptly rather
than waiting for the next poll; the **authoritative** exit code always comes from the status file,
never from `child.exitCode` (which, post-restart, we don't have).

## 7. Restore + re-attach reconciliation

Hook into boot right where sessions restore. Restore is **per-session**:
`BgProcessManager.restoreSession(sessionId)` is called from
`session-manager.ts::restoreSessions()` inside its existing per-session loop (after the live-restore
step, ~L3260) — at which point the session exists and (for sandboxed sessions) `session.containerId`
has been re-resolved via `SandboxManager.getContainerId()` (`session-manager.ts` ~L3858). Because
stores are per-project, `restoreSession(sessionId)` deterministically resolves *that* session's
store via `storeProvider(sessionId)` and iterates only that session's `PersistedBgProcess` records
— no cross-store enumeration is needed.

For each persisted record:

```
if status == "exited" or "unrecoverable":
    rehydrate in-memory record; load tail of PROJECTION files into log[]/stdout[]/stderr[]
      (read last MAX_LOG_LINES/MAX_LOG_BYTES from .out.log/.err.log); broadcast nothing
      (client re-fetches via GET on reconnect). Done.

if status == "running":
    liveness = checkAlive(record)        # pid/container probe + nonce re-check (§7.1)
    case ALIVE (nonce matches):
        # re-attach
        rehydrate record (status stays "running", terminalReason stays null)
        read bounded tail (last 512KB/5000 lines) of the spool from persistedOffset -> capped buffer
          -> rewrite projection; then copytruncate the spool (§8)
        start tailers from new offset        -> resumes live streaming
        start status watcher                 -> captures eventual real exit code (-> terminalReason="normal")
    case COMPLETED_DURING_DOWNTIME:   # not alive, but status file present & parseable
        read exitCode from status file; read bounded spool tail -> projection
        status="exited"; exitCode=<n>; terminalReason="normal"
        endTime = status file mtime (best-effort) or Date.now()
        broadcast bg_process_exited{ exitCode, terminalReason:"normal" }
    case UNRECOVERABLE:               # not alive AND (no status file | projection+spool missing | pid reused)
        status="unrecoverable"; exitCode stays null; terminalReason="unrecoverable"
        load whatever projection tail exists
        broadcast bg_process_exited{ exitCode:null, terminalReason:"unrecoverable" }
        # NEVER fabricate an exit code
```

### 7.1 Liveness checks

- **Host:** `process.kill(pid, 0)` — throws ESRCH if gone, returns if alive. **Pid-reuse guard
  (nonce):** if the status file exists, the process already finished → treat as COMPLETED
  regardless of pid liveness (a reused pid can't retroactively un-write the status file). If the
  status file is absent and `kill(pid,0)` succeeds, **re-read the pidfile and compare its nonce**
  against the persisted `nonce`:
  - **match** → genuinely the same process → ALIVE, re-attach.
  - **pidfile missing, unreadable, or nonce mismatched** → the live pid is a **reused/foreign**
    pid → if no status file, **UNRECOVERABLE** (`terminalReason="unrecoverable"`, `exitCode=null`,
    never fabricated).
  The cmd.exe fallback writes a pid-only pidfile (no nonce, §4.1); there the guard degrades to
  status-file-presence + `kill(pid,0)` only — a documented weaker guard for that rare path.
- **Docker:** container alive via `docker inspect -f '{{.State.Running}}' <cid>` (and the
  containerId must still resolve from `SandboxManager`; if the project's container was recreated,
  the old container/exec is gone → not alive). Then `docker exec <cid> kill -0 <pid>` for the
  in-container wrapper, **plus `docker exec <cid> cat <pidfile>` to re-check the nonce** exactly as
  the host path. If the container is gone, the in-container `/tmp` files are gone too → if no
  status was ever read, **unrecoverable** (`terminalReason="unrecoverable"`); if we had already
  recorded an exit, it stays exited.

### 7.2 Container recreated

Container recreation (new `containerId`) means the process and its `/tmp` files are gone. Such a
record is **unrecoverable** (`terminalReason="unrecoverable"`, `exitCode=null`) unless its
status/exit was captured before the restart. This is correct and honest — we do not invent an exit
code.

## 8. Log caps on disk — transient spool + gateway-owned capped projection

**Requirement:** the durable on-disk log must stay within `MAX_LOG_LINES` 5000 / `MAX_LOG_BYTES`
512KB **at all times** — while running, across a restart, and after exit — not just post-exit. The
problem is that on a host the *child* holds the output file open and keeps appending; the gateway
cannot safely truncate-from-front a file the child has open (especially on Windows). The solution
splits each stream into two files:

- **Transient spool** (`<bgId>.out.spool` / `<bgId>.err.spool`) — the child appends here (`>>`,
  §4). This is an explicitly transient, **gateway-managed ring**, *not* "the persisted log". It is
  allowed to be larger than the cap only transiently (between gateway consume cycles); it is never
  read by clients.
- **Durable capped projection** (`<bgId>.out.log` / `<bgId>.err.log`) — the **gateway owns this
  file exclusively** and rewrites it **atomically (tmp + rename)** from the in-memory capped buffer.
  It is therefore **always ≤ 512KB / 5000 lines per stream**. Restore and every REST reader
  (`getLogs`/`grep`/`head`/`slice`) read the projection, never the spool.

### Keeping the projection capped while running

The tailer reads spool deltas → feeds the existing in-memory `appendLog()` (already trimmed to
`MAX_LOG_LINES`/`MAX_LOG_BYTES`) → a **debounced (~500ms) atomic rewrite** of the `.log` projection
serialises that capped buffer to `<bgId>.out.log.tmp` and `rename`s it over the projection. Because
the source buffer is already capped, the durable projection is bounded **continuously** — it can
never exceed the cap, even mid-run.

### Bounding the transient spool — copytruncate

The child writes the spool with append semantics (`>>`), so the kernel keeps the write position at
EOF (O_APPEND). When the gateway has consumed the spool up to its read offset **and** the spool
exceeds `MAX_LOG_BYTES`, the gateway does `fs.truncateSync(spool, 0)` and resets its read offset to
`0`. POSIX `/bin/sh`, Git Bash (MSYS), and the docker `/bin/sh` all honour O_APPEND, so the next
child write lands at offset 0 — a classic logrotate **copytruncate**.

> **copytruncate race (acknowledged):** a few bytes written between the gateway's last read and the
> `truncate(0)` can be lost. This is the standard logrotate copytruncate caveat and is **acceptable
> here** because the on-disk log is already an explicitly lossy last-N cap, not an audit log.
>
> **cmd.exe exception:** cmd does **not** honour O_APPEND (§4.1), so its spool is opened with `>`
> and copytruncate would not reset the write position. On the cmd fallback the gateway does **not**
> truncate the spool; it relies **solely on the projection cap** to bound durable storage, and the
> spool may grow for the lifetime of a single process. Rare, documented path.

### Downtime window

While the gateway is down only the spool grows (the child keeps appending; nothing projects). On
`restoreSession()` the gateway reads only the **bounded tail** (last 512KB / 5000 lines) of the
spool to rebuild the in-memory buffer and immediately rewrite the projection, **then copytruncates
the spool**. So even after an arbitrarily long downtime the durable projection is capped the moment
restore runs, and the spool is reset to a bounded size.

There is no separate "post-exit trim" and no multi-megabyte "safety ceiling": the projection is the
durable artefact and is bounded at every instant by construction.

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

- `action=kill` → `bgProcessManager.kill(...)`. Process is signalled (see kill mechanics below). If
  the wrapper still gets to write `$?` (graceful SIGTERM), the status watcher captures the **real**
  exit code and sets `terminalReason="normal"`. If the wrapper is hard-killed before it can write
  the status file, the record becomes `exited` with `exitCode=null`, `terminalReason="killed"` (we
  *know* it was killed — not a fabrication). Either way the record transitions to a terminal state
  and **persists**. Returns `{ ok: true, killed: true }`.
- `action=dismiss` → new `bgProcessManager.dismiss(sessionId, pid)`: refuse if still running
  (must kill first) unless `force`; remove the in-memory record, `BgProcessStore.remove`, and
  **delete the per-process files** — spool **and** projection plus status/pid:
  `.out.spool`, `.err.spool`, `.out.log`, `.err.log`, `.status`, `.pid` (for docker also
  `docker exec <cid> rm -f <containerPaths>` best-effort). Broadcast a new
  `bg_process_dismissed` WS event so other clients drop the pill. Returns `{ ok: true }`.

### 9.2 New manager methods

```ts
// bg-process-manager.ts
kill(sessionId, processId): boolean;                 // existing — keep; exit code from status file, else terminalReason="killed"
dismiss(sessionId, processId, opts?: { force?: boolean }): boolean;   // NEW: remove record + purge spool+projection+status+pid
restoreSession(sessionId): Promise<void>;            // NEW: §7 per-session reconciliation (called from restoreSessions loop)
```

**Kill mechanics** (signalling the right process pre- vs post-restart):
- **Host:** `taskkill /pid <pid> /T /F` (Windows) or `process.kill(-pid, SIGTERM)` then `SIGKILL`
  (POSIX) against the persisted wrapper pid. A live `child` handle, when one still exists
  (pre-restart), is used as an optimisation but is not required.
- **Docker:** after a restart there is **no host `child` handle** for a re-attached process, so kill
  via the **persisted in-container pid**: `docker exec <cid> kill -TERM <pid>`, escalating to
  `docker exec <cid> kill -KILL <pid>` if it does not exit within a grace window. `child.kill(...)`
  on a still-live docker-exec handle is only an optimisation when the gateway never restarted.

`remove()` (existing, index-only) is folded into `dismiss()`. `cleanup(sessionId)` (on session
terminate, `session-manager.ts` ~L5601) keeps killing running children but now also leaves durable
files in place only if the session is merely restarting — on real terminate it should
`removeForSession` + delete files (a terminated session's pills are gone).

### 9.3 WS protocol

`src/server/ws/protocol.ts` (~L158):

- `bg_process_created` / `bg_process_output` — unchanged.
- `bg_process_exited` — gains `terminalReason: "normal" | "killed" | "unrecoverable"` as the
  **single authoritative field**. There is **no** standalone `unrecoverable?` boolean (dropped to
  avoid two overlapping fields). `exitCode` is `number | null` and is `null` for `"killed"`-without-
  status and `"unrecoverable"`.
- **NEW** `bg_process_dismissed` — `{ type: "bg_process_dismissed"; processId: string }`.

### 9.4 Client + UI

- `src/app/session-manager.ts`: `killBgProcess` → DELETE `?action=kill`; `dismissBgProcess` →
  DELETE `?action=dismiss`. Add a WS handler for `bg_process_dismissed` (~L1422) that removes the
  process from `ai.bgProcesses`. `bg_process_exited` handler maps `exitCode` **and** `terminalReason`
  into the local record.
- `src/ui/components/BgProcessPill.ts`: extend `BgProcessInfo.status` to include `"unrecoverable"`
  and add `terminalReason`. `_statusIndicator()` / exit-code span render by `terminalReason`:
  - `"normal"` → `exit N` (from `exitCode`);
  - `"killed"` (exitCode `null`) → **"killed"**;
  - `"unrecoverable"` → **"exit status unknown"** with a distinct amber marker (title "process was
    lost across a restart").
  Kill button only for `running`; Remove (dismiss) for **all** terminal states (`exited` and
  `unrecoverable`).

## 10. Data-flow diagrams (text)

### Create (host)
```
agent -> POST /bg-processes -> bgMgr.create()
  generate nonce; compute BgPaths under <stateDir>/bg-processes/<sid>/
  spawnFn(cmd, cwd, undefined, paths)            # wrapper: printf pid\nnonce > pid; {cmd} >> out.spool 2>> err.spool; echo $? > status
  child.unref()
  store.put(record status=running, terminalReason=null, nonce)   # atomic write
  tailerFactory({outSpool,errSpool}).start(0)    # poll SPOOL -> appendLog (capped) -> bg_process_output WS
                                                 #   -> debounced atomic rewrite of .out.log/.err.log projection
                                                 #   -> copytruncate spool when > cap
  statusWatcher.start()                          # poll <status>
  broadcast bg_process_created
```

### Live output
```
wrapper appends -> <bgId>.out.spool grows
tailer poll detects delta -> read spool bytes -> appendLog() [capped buffer]
  -> debounced(~500ms) atomic rewrite <bgId>.out.log projection (<=512KB/5000 lines)  [ALWAYS capped]
  -> if spool > cap && consumed: fs.truncateSync(spool,0); offset=0                   [copytruncate]
  -> store.update(outOffset) [debounced] -> broadcast bg_process_output -> pill.appendOutput()
```

### Restart -> restore -> re-attach
```
boot: restoreSessions() loops sessions; per session containerId re-resolved
  -> bgMgr.restoreSession(sessionId):            # store = storeProvider(sessionId) (this session's store)
  for each PersistedBgProcess of that session:
    running + alive(nonce matches) -> rehydrate; read bounded spool tail -> projection; copytruncate;
                                      tailer.start(newOffset); statusWatcher.start()  (terminalReason stays null)
    running + completed            -> read <status> exitCode; bounded spool tail -> projection;
                                      status=exited; terminalReason=normal; broadcast exited{exitCode,normal}
    running + pid-reused/lost       -> status=unrecoverable; terminalReason=unrecoverable;
                                      broadcast exited{exitCode:null, terminalReason:unrecoverable}  # NEVER fabricate
    exited/unrecoverable            -> rehydrate from PROJECTION tail (no broadcast; client GETs on reconnect)
client reconnects -> GET /bg-processes -> sees restored pills; WS resumes streaming
```

### Exit
```
wrapper finishes -> echo $? > <status>
statusWatcher sees <status> with content -> parse exitCode (retry on partial)
  -> final spool flush -> capped buffer -> final atomic projection rewrite
  -> status=exited, exitCode=N, terminalReason=normal, endTime -> store.update(sync) -> resolveExited()
  -> broadcast bg_process_exited{exitCode, terminalReason} -> stop tailers+watcher -> delete spool files
(projection already within caps at every instant; no post-exit trim needed)
```

### Kill
```
UI Kill -> DELETE ?action=kill -> bgMgr.kill()
  host:   taskkill /pid <pid> /T /F (win) | process.kill(-pid,SIGTERM)->SIGKILL (posix)  [persisted pid]
  docker: docker exec <cid> kill -TERM <pid>  ->escalate-> kill -KILL <pid>               [persisted in-container pid]
          (child.kill only as optimisation when a live host handle still exists, pre-restart)
if wrapper wrote <status> -> statusWatcher -> status=exited, terminalReason=normal (real code)
else hard-killed before status -> status=exited, exitCode=null, terminalReason=killed   # known kill, not fabricated
pill stays as a terminal pill until dismissed
```

### Dismiss
```
UI Remove -> DELETE ?action=dismiss -> bgMgr.dismiss()
  refuse if running (unless force)
  store.remove(); delete <out>.spool,<err>.spool,<out>.log,<err>.log,<status>,<pid>
  docker: docker exec <cid> rm -f <containerPaths>  (best-effort)
  broadcast bg_process_dismissed -> all clients drop pill
record never reappears after subsequent restart (files + index entry gone)
```

## 11. Risks & edge cases

- **Partial status-file write.** `echo $? > f` is a single small write but the watcher may read
  mid-write. Mitigation: require a parseable integer **followed by newline**; if absent, retry for
  up to ~2s before treating as still-writing. The wrapper writes exactly one line, so a complete
  read yields a clean integer.
- **Pid reuse (host) — detected, not just documented.** §7.1: status-file presence is authoritative
  (a reused pid can't un-write a status file); when status is absent and the pid is alive, the
  gateway re-reads the pidfile and compares the **per-spawn nonce** (`printf '%s\n%s\n' "$$"
  "<nonce>"` in the wrapper, §4.1/§4.2). Match → same process, re-attach. Missing/mismatched nonce
  (or pidfile gone) with no status file → **pid reused** → `terminalReason="unrecoverable"`,
  `exitCode=null` — never fabricated. The only weaker path is the cmd.exe fallback (pid-only
  pidfile, no nonce), documented in §4.1/§7.1.
- **Log rotation racing the tailer.** The durable **projection** is rewritten atomically (tmp +
  rename) by the gateway alone and the child never writes it, so readers never see a torn
  projection. The **spool** copytruncate (§8) may lose a few bytes between last-read and
  `truncate(0)` — the standard logrotate copytruncate caveat, acceptable because the log is already
  a lossy last-N cap. cmd.exe skips spool truncation (no O_APPEND) and relies on the projection cap.
- **Windows process-group kill.** `taskkill /pid <pid> /T /F` kills the wrapper shell **and** its
  child tree (`/T`), so a force-killed host process **may not write a status file**. Handling:
  `kill()` records an intent-to-kill timestamp; the watcher, seeing the pid gone with no status
  within a grace window **after an explicit kill**, marks `status="exited"`, `exitCode=null`,
  **`terminalReason="killed"`** — we *know* it was killed, which is not fabrication. This is
  distinct from the restart-loss case (`terminalReason="unrecoverable"`). If the wrapper *did* get
  to write the status file, `terminalReason="normal"` with the real code instead.
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
export interface BgPaths { outSpool; errSpool; outLog; errLog; status; pid; nonce; inContainer: boolean }
export type SpawnFn = (command, cwd, containerId, paths: BgPaths) => ChildProcess;
export interface TailerSpec { outSpool; errSpool; inContainer; containerId?; onChunk }  // watches the SPOOL
export type TailerFactory = (spec: TailerSpec) => { out: Tailer; err: Tailer };
function buildHostWrapper(command, paths, shellKind: "posix" | "cmd"): string;
function buildDockerWrapper(command, paths): string;
class BgProcessManager {
  constructor(clientsProvider, spawnFn?, storeProvider?, tailerFactory?);
  create(sessionId, command, cwd, containerId?, sandboxed?, name?): BgProcessInfo;  // wires spool+tailer+projection
  kill(sessionId, processId): boolean;
  dismiss(sessionId, processId, opts?: { force?: boolean }): boolean;               // NEW
  restoreSession(sessionId): Promise<void>;                                         // NEW: per-session §7 reconciliation
  // getLogs/grep/head/slice/waitForExit/list unchanged (read the PROJECTION)
}
// BgProcess / BgProcessInfo.status widened to "running" | "exited" | "unrecoverable";
// + terminalReason: "normal" | "killed" | "unrecoverable" | null  (authoritative; null while running)
```

`src/server/agent/bg-process-store.ts` (NEW) — `BgProcessStore`, `PersistedBgProcess` (§5).

`src/server/agent/project-context.ts` — add `readonly bgProcessStore = new BgProcessStore(this.stateDir)`.

`src/server/agent/session-manager.ts` — `getBgProcessStore(projectId?): BgProcessStore`; call
`bgProcessManager.restoreSession(sessionId)` for each session inside the existing `restoreSessions()`
loop (after containerId re-resolution); update `cleanup` call site to purge files on real terminate.

`src/server/server.ts` — construct `BgProcessManager` with `storeProvider`
(`(sid) => sessionManager.getBgProcessStore(sessionManager.getSession(sid)?.projectId)`); split the
DELETE route on `?action=`.

`src/server/ws/protocol.ts` — `bg_process_exited` gains `terminalReason` (single authoritative
field, no standalone `unrecoverable?`); add `bg_process_dismissed`.

`src/app/session-manager.ts` — `killBgProcess`/`dismissBgProcess` use `?action=`; handle
`bg_process_dismissed`; map `exitCode` + `terminalReason`.

`src/ui/components/BgProcessPill.ts` — render by `terminalReason` (`normal`→`exit N`,
`killed`→"killed", `unrecoverable`→"exit status unknown"); dismiss for all terminal states.

## 13. Test plan

### Unit (`tests/`, `node:test`, no real OS processes)

Extend/replace `tests/bg-process-manager.test.ts` and add **`tests/bg-process-persistence.test.ts`**:

- **Persistence round-trip:** create with a fake `SpawnFn` + fake `TailerFactory` that writes to a
  temp `stateDir`; assert `bg-processes.json` written atomically and the durable **projection**
  (`.out.log`/`.err.log`) present; construct a *fresh* `BgProcessManager` over the same dir;
  `restoreSession(sessionId)`; assert records + projection tail restored.
- **Re-attach — alive (nonce matches):** persisted `status=running`, fake liveness=alive, fake
  pidfile whose nonce **matches** the record, fake spool with extra bytes past `outOffset`;
  `restoreSession()` resumes tailing the spool and emits the new bytes; later the fake status file
  gains `0` → `bg_process_exited` with `exitCode=0`, `terminalReason="normal"`.
- **Re-attach — completed-during-downtime:** liveness=dead, status file contains `137`;
  `restoreSession()` → `status=exited`, `exitCode=137`, `terminalReason="normal"`, no fabricated code.
- **Re-attach — pid reused (nonce mismatch):** liveness=alive but pidfile nonce **mismatches** (or
  pidfile gone), no status file → `status=unrecoverable`, `exitCode=null`,
  `terminalReason="unrecoverable"`; assert **no** numeric exit code.
- **Re-attach — unrecoverable (lost):** liveness=dead, **no** status file (and projection+spool
  missing) → `status=unrecoverable`, `exitCode=null`, `terminalReason="unrecoverable"` broadcast;
  assert **no** numeric exit code.
- **Kill writes real code vs killed:** graceful kill → `status=exited` once status file appears,
  `terminalReason="normal"`; hard-killed-no-status path → `exitCode=null`,
  `terminalReason="killed"` (distinct from `"unrecoverable"`).
- **Dismiss purges files:** `dismiss()` deletes `.out.spool/.err.spool/.out.log/.err.log/.status/
  .pid` and the index entry; a subsequent `restoreSession()` finds nothing.
- **Disk caps — WHILE RUNNING:** feed > cap via the fake tailer **without** exiting; assert the
  durable projection file on disk is ≤ 512KB / 5000 lines **before** any exit (the gateway-owned
  capped rewrite). Then also assert it stays ≤ caps after exit. (No separate post-exit trim exists;
  the projection is bounded continuously.) Also assert spool copytruncate fires past the cap.
- **Wrapper builders:** `buildHostWrapper` (posix vs cmd) and `buildDockerWrapper` produce the exact
  strings — posix/docker **append** (`>>`) to the spool and write `printf '%s\n%s\n' "$$" "<nonce>"`
  to the pidfile; cmd uses `>` and writes pid only (string assertions — pure, fast).

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
2. `BgPaths`, wrapper builders (spool append + pid+nonce pidfile), change `defaultSpawn` +
   `create()` to redirect output to the **spool** and feed the capped buffer + durable projection
   from a `Tailer` (default poll tailer); status watcher for exit.
3. `restoreSession(sessionId)` reconciliation (alive / completed / pid-reused / lost) + wire into
   the `restoreSessions()` per-session loop; `ProjectContext.bgProcessStore`.
4. `dismiss()` + split DELETE route + `bg_process_dismissed` WS event + `terminalReason`
   (`normal`/`killed`/`unrecoverable`) plumbing through protocol/client/pill; Docker kill via
   persisted in-container pid (`docker exec kill -TERM/-KILL`).
5. Disk caps: continuous capped-projection rewrite + spool copytruncate (no post-exit trim).
6. Tests: unit persistence/re-attach/dismiss/caps; browser E2E; keep guard test green; `check`.
