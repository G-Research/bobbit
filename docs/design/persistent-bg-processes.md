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
- Keep disk usage bounded by the existing caps (`MAX_LOG_LINES` 5000 / `MAX_LOG_BYTES` 512KB,
  **combined per-process** across stdout+stderr, matching the in-memory trim) **at all times** —
  while the process is running, across a restart, and after exit (§8).
- Preserve sandbox parity and the `sandboxed && !containerId` host-execution guard
  (`bg-process-manager.ts` `create()` ~L118).

## 2. The crux: durable log/status files instead of in-memory pipes

You **cannot** re-attach to a dead parent's stdout/stderr pipes. The spawn model must change so
that output and exit status live on disk, owned by the *child*, independent of the gateway. The
files split into transient per-stream **spools** and a single durable **combined projection** (see
§8 for the cap mechanics):

- At spawn time, **redirect the command's stdout/stderr into transient per-stream spool files**
  (`<bgId>.out.spool` / `<bgId>.err.spool`) that the child appends to. The spools are explicitly
  **transient, gateway-managed rings** (bounded by a wrapper-owned trimmer + gateway copytruncate,
  §8) — they are *not* "the persisted log".
- The gateway tails both spool deltas, interleaves them by arrival into the existing in-memory
  capped `log[]` buffer, and continuously rewrites a **single durable combined projection** it owns
  exclusively (`<bgId>.log`, atomic tmp+rename, always ≤ 512KB / 5000 lines **combined across both
  streams**). Each line is tagged `<ts>\t<stream>\t<text>` so restore rebuilds the interleaved
  `log[]` plus `stdout[]`/`stderr[]` faithfully. Restore and the REST readers read the **combined
  projection**, never the raw spools.
- **Capture the real exit code durably**: wrap the command in an **isolated subshell**
  (`( <command> ) ; code=$? ; printf '%s\n' "$code" > <statusfile>`, §4.1) so that even a user
  `exit N` only exits the subshell and the wrapper still records the real `code=$?` to a per-process
  status file, and write the wrapper's own `processPid` **plus a per-spawn nonce** to a pidfile
  (§5.1, §7.1 — the nonce detects pid reuse on restore).
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
| On-disk cap held while running | n/a | Gateway-owned combined capped projection (§8) |
| stdout/stderr interleaving survives restart | n/a | Combined timestamped projection rebuilds order |
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
      <bgId>.out.spool                   # TRANSIENT: child appends stdout; bounded by wrapper-owned trimmer
                                         #   (restart-independent) + gateway copytruncate (secondary)
      <bgId>.err.spool                   # TRANSIENT: child appends stderr; bounded the same way
      <bgId>.log                         # DURABLE COMBINED PROJECTION: gateway-owned, atomic rewrite,
                                         #   ≤512KB/5000 lines COMBINED; lines tagged <ts>\t<stream>\t<text>
      <bgId>.status                      # final exit code, written once by the wrapper
      <bgId>.pid                         # wrapper processPid + spawn nonce — liveness + pid-reuse probe
```

The **spools** are the only files the child writes; the gateway never lets the child write the
**combined projection** (`<bgId>.log`). Restore and every REST reader
(`getLogs`/`grep`/`head`/`slice`) read the combined projection exclusively — the spools are
implementation-internal rings, never served to clients. grep/head/slice operate on the combined
interleaved view exactly as they do today against the in-memory `log[]`.

### 3.1 Stream files: per-stream spools vs combined projection

The wrapper redirects each stream to its **own transient spool file** — keeping two files
(`.out.spool`, `.err.spool`) is fully portable across Git Bash and `/bin/sh` (the persistent path
is POSIX-only — §4.1). The child only ever appends to the spools.

The gateway tails both spool deltas, feeds them into the existing in-memory capped buffer
(`appendLog()` interleaves `stdout`/`stderr` by arrival, exactly as today's pipe `data` events),
and from that single capped `log[]` buffer atomically rewrites **one durable combined projection**
(`<bgId>.log`). Persisting only per-stream `.out.log`/`.err.log` files could **not** reconstruct
the stdout/stderr interleaving, breaking pill/log ordering and `grep`/`head`/`slice` consistency
after restart — so the durable projection is a **single combined file** instead.

**Combined projection line format** (one line per `log[]` entry):

```
<ts>\t<stream>\t<text>          # stream ∈ {out, err}; <ts> = ms epoch of the entry
```

On restore the gateway parses each line back into a `log[]` entry (and the per-stream `stdout[]`/
`stderr[]` arrays), preserving the exact interleaving and ordering that was live before the restart.
The projection is always within caps (§8). The status file remains a single `<bgId>.status`.

Final naming (used throughout this doc):

```
<stateDir>/bg-processes/<sessionId>/<bgId>.out.spool   # transient, child-written (stdout)
<stateDir>/bg-processes/<sessionId>/<bgId>.err.spool   # transient, child-written (stderr)
<stateDir>/bg-processes/<sessionId>/<bgId>.log         # durable COMBINED projection, gateway-written
<stateDir>/bg-processes/<sessionId>/<bgId>.status
<stateDir>/bg-processes/<sessionId>/<bgId>.pid         # processPid + nonce (host: written by wrapper;
                                                       #   docker: in-container pidfile read post-spawn)
```

### 3.2 Docker reachability

For sandboxed sessions the worktree is **container-internal** (cloned into `/workspace` or
`/workspace-wt/...`), **not** bind-mounted from the host (see
`src/server/agent/sandbox-clone-source.ts`, `MOUNTED_SRC_PATH`, and
`session-manager.ts::isSandboxContainerPath` ~L96). The host cannot read a file written inside the
container by path.

Therefore docker-exec processes keep **both spool files plus the combined projection, status, and
pidfile inside the container** (under `/tmp/bobbit-bg/<sessionId>/<bgId>.*`), and the host reaches
them via `docker exec`. The same spool→combined-projection split applies: the child appends to the
two in-container spools; the gateway tails both and rewrites the single in-container combined
projection via `docker exec <cid> /bin/sh -c 'cat > <log>.tmp && mv <log>.tmp <log>'` from the
capped buffer (atomic rename inside the container). The single `inContainer` flag therefore covers
every file uniformly.

- **Tail live / re-attach:** `docker exec <cid> tail -c +<offset+1> -F <containerSpoolPath>` per
  spool (the `-F` keeps following across truncation; `-c +<offset+1>` resumes from a byte offset).
- **Read projection / final on restore-after-downtime:** `docker exec <cid> cat <containerLogPath>`
  (the single combined `<bgId>.log`) and `docker exec <cid> cat <containerStatusPath>`.
- **Resolve `processPid` post-spawn / liveness:** `docker exec <cid> cat <containerPidfile>` reads
  the in-container wrapper pid (`processPid`) **and** the spawn nonce (§4/§7.1); liveness is
  `docker inspect -f '{{.State.Running}}' <cid>` for the container plus
  `docker exec <cid> kill -0 <processPid>` for the in-container wrapper.

The metadata records the **container paths** (host paths empty for docker), plus the `containerId`.
The in-container pidfile holds the `processPid` **and** nonce, read via `docker exec cat`.

> The container path lives under the worktree (host-unreadable but container-writable) which is
> the only guaranteed-writable, restart-stable location for a sandboxed session. `/tmp` is also
> acceptable and avoids polluting the worktree; **chosen: `/tmp/bobbit-bg/<sessionId>/<bgId>.*`**
> inside the container, created with `mkdir -p` by the wrapper. `/tmp` survives for the container's
> lifetime, which is exactly the process's lifetime.

## 4. Spawn model (concrete commands)

`SpawnFn` keeps its signature so tests can override it. `defaultSpawn` changes to: (a) compute the
spool/combined-projection/status/pid paths, (b) build a wrapper command that redirects output to the
**spool** files and writes the status file + pidfile (`processPid` + nonce), (c) spawn the wrapper.

```ts
// bg-process-manager.ts
export interface BgPaths {
  outSpool: string; // TRANSIENT child-written stdout spool (host path OR container path)
  errSpool: string; // TRANSIENT child-written stderr spool
  logFile: string;  // DURABLE gateway-written COMBINED projection (<bgId>.log; <ts>\t<stream>\t<text>)
  status: string;
  pid: string;      // pidfile path: host wrapper writes processPid+nonce; docker in-container pidfile
  nonce: string;    // per-spawn random token written into the pidfile (pid-reuse guard, §7.1)
  /** true when paths are container-internal and must be read/written via `docker exec` */
  inContainer: boolean;
}

export type SpawnFn = (
  command: string,
  cwd: string,
  containerId: string | undefined,
  paths: BgPaths,            // NEW — spools to redirect into / status + pid(+nonce) to write
) => ChildProcess;
```

### 4.0 Required post-spawn pidfile read (resolve `processPid`)

Immediately after `spawnFn` returns, and **before the process is reported as created**, the manager
resolves the signalable wrapper pid (`processPid`) and sync-flushes it to disk — this is
recovery-critical because restore, liveness, and post-restart kill all target `processPid`:

- **Host:** read the `<pid>` pidfile written by the wrapper (`$$`/pid-write), or fall back to
  `child.pid`; for host these coincide. `hostPid = child.pid`.
- **Docker:** the in-container wrapper pid is **not** `child.pid` (that is the host-side `docker
  exec` handle, valid only while the original gateway lives). Read it via
  `docker exec <cid> cat <containerPidfile>`, **retrying briefly** (the wrapper writes the pidfile
  asynchronously) until a pid+nonce line appears. `hostPid = child.pid` (the docker-exec handle).

The manager then **synchronously flushes** `processPid` (and `hostPid`, `nonce`) into
`bg-processes.json` before broadcasting `bg_process_created`. Until `processPid` is known the record
persists `processPid: 0` (pending) and is reconciled the moment the pidfile read succeeds.

### 4.1 Host wrapper — POSIX only (Git Bash on Windows / `/bin/sh`)

`getShellConfig()` (`src/server/agent/shell-util.ts`) returns Git Bash (`bash -c`) on Windows when
`GIT_BASH` is found (the **strongly-preferred** Windows default), `/bin/sh -c` on Linux/macOS, and
only falls back to `cmd.exe /d /s /c` on a Windows host with no Git for Windows installed. The
**persistent, re-attachable bg-process path requires a POSIX shell** — Git Bash on Windows or
`/bin/sh` on Linux/macOS (and `/bin/sh` inside docker, §4.2). cmd.exe is **not** part of the
persistent path (see "Legacy fallback" below).

The wrapper is a single POSIX `-c` string. It (1) writes the pidfile (`processPid` + per-spawn
nonce, two lines); (2) launches a **wrapper-owned background trimmer** that bounds each spool
independently of the gateway — restart-independent, so spools stay capped even while the gateway is
down (§8); (3) runs the user command in an **isolated subshell** `( <command> )` so a user `exit N`
only exits the subshell and the wrapper still captures the real `code=$?`; (4) appends (`>>`) output
to the spools; (5) stops the trimmer and writes the real exit code to the status file:

```sh
printf '%s\n%s\n' "$$" "<nonce>" > "<pid>"
# wrapper-owned trimmer: bounds each spool to <KEEP> bytes, restart-independent
( while kill -0 "$$" 2>/dev/null; do
    for f in "<outSpool>" "<errSpool>"; do
      if [ -f "$f" ] && [ "$(wc -c < "$f" 2>/dev/null || echo 0)" -gt <MAX_LOG_BYTES> ]; then
        tail -c <KEEP> "$f" > "$f.trim" 2>/dev/null && cat "$f.trim" > "$f" && rm -f "$f.trim"
      fi
    done
    sleep 5
  done ) &
trimmer=$!
( <command> ) >> "<outSpool>" 2>> "<errSpool>"
code=$?
kill "$trimmer" 2>/dev/null
printf '%s\n' "$code" > "<status>"
exit "$code"
```

(The manager builds this single-string form by joining the lines with `;`/`&` as needed; it is
shown multi-line for readability. `<KEEP>` = `MAX_LOG_BYTES` = 512KB is the retained tail; the
`-gt <MAX_LOG_BYTES>` test is the trim trigger.)

Key correctness points:

- `$$` is the wrapper shell pid (`processPid`); `<nonce>` is the random token the manager generated
  for this spawn (pid-reuse guard, §7.1).
- The `( <command> )` subshell means a user `exit N` exits only the subshell, so `code=$?` reliably
  captures the command's real exit code in the **wrapper** before it writes `<status>`.
- **Wrapper-owned trimmer (restart-independent spool cap).** The background loop runs as part of the
  detached/orphaned wrapper, **not** the gateway. While the wrapper is alive (`kill -0 "$$"`) it
  trims each spool whenever it exceeds `<MAX_LOG_BYTES>`, retaining the last `<KEEP>` bytes. The trim
  `tail -c <KEEP> "$f" > "$f.trim" && cat "$f.trim" > "$f"` truncates the spool **in place (same
  inode)** then rewrites the retained tail; the command's `>>` (`O_APPEND`) fd keeps appending at
  EOF of the **same inode** — standard logrotate **copytruncate**. A few bytes written during the
  trim window may be lost, which is acceptable because the spool is already a lossy last-N cap. We
  **must not** use `mv`/rename for the trim (that would orphan the writer's append fd onto the old
  inode). This bounds each spool **at all times** — during the normal run AND during gateway
  downtime.
- POSIX `>>` honours `O_APPEND`, so after either the wrapper trimmer or a gateway copytruncate the
  next child write lands at EOF of the (now-smaller) same inode — the property §8 relies on.

> **Why the subshell matters.** An earlier `{ <command> ; } ... ; echo $? > <status>` group did
> **not** isolate `exit`: a user command running `exit 0/1` exited the *wrapper* shell before the
> trailing status write, so no real code was persisted and the process wrongly fell into
> killed/unrecoverable. Running `( <command> )` in a child subshell fixes this — `exit N` is
> contained, `code=$?` is captured, `<status>` is always written.

**Legacy fallback (Windows host with no Git Bash — rare).** When `GIT_BASH` is `null` (no Git for
Windows) `getShellConfig()` yields `cmd.exe`, which cannot run the POSIX wrapper (no `$$`/`$?`, no
portable trimmer) and offers no nonce. On that narrow platform exception `bash_bg` **falls back to
the legacy in-memory, non-persistent behaviour** — the current pipe-based `defaultSpawn` capture.
The process works for the gateway's lifetime but is **not** persisted, **not** restored after a
restart, and gets **no** spool/status/pid files or nonce. Its record is flagged `persistent: false`
(§5.1) so the UI/log never implies durability. Persistence, re-attach, the nonce guard, and the
wrapper trimmer all assume a POSIX shell; there is no cmd.exe persistent path.

> The manager decides persistent (POSIX) vs legacy (no Git Bash) at spawn time from
> `getShellConfig()`: a POSIX shell (Git Bash or `/bin/sh`) → build the wrapper via
> `buildHostWrapper(command, paths)` and persist; cmd.exe → legacy pipe capture, `persistent:false`.
> `buildHostWrapper` only ever emits the POSIX wrapper — there is no cmd branch (§12).

### 4.2 Docker wrapper (`/bin/sh` inside the container, run under `setsid`)

Always POSIX `/bin/sh` inside the container. The wrapper mirrors the host POSIX wrapper — pidfile
(`processPid` + nonce), the **wrapper-owned trimmer**, the isolated subshell `( <command> )`, `>>`
append to both spools, and the real `code=$?` written to the status file — and prepends
`mkdir -p <dir>` to create the container-internal `/tmp/bobbit-bg/...` path:

```sh
mkdir -p "<dir>"
printf '%s\n%s\n' "$$" "<nonce>" > "<pid>"
( while kill -0 "$$" 2>/dev/null; do
    for f in "<outSpool>" "<errSpool>"; do
      if [ -f "$f" ] && [ "$(wc -c < "$f" 2>/dev/null || echo 0)" -gt <MAX_LOG_BYTES> ]; then
        tail -c <KEEP> "$f" > "$f.trim" 2>/dev/null && cat "$f.trim" > "$f" && rm -f "$f.trim"
      fi
    done
    sleep 5
  done ) &
trimmer=$!
( <command> ) >> "<outSpool>" 2>> "<errSpool>"
code=$?
kill "$trimmer" 2>/dev/null
printf '%s\n' "$code" > "<status>"
exit "$code"
```

(joined into the single `-c` string by the builder; shown multi-line for readability. `<KEEP>` =
`MAX_LOG_BYTES` = 512KB.)

**Run the wrapper in its own process group/session so the WHOLE command tree is killable.** A bare
`docker exec <cid> kill -TERM <processPid>` would signal only the wrapper shell, leaving the
`( <command> )` subshell and any grandchildren orphaned inside the container (still appending to the
spools after the pill goes terminal). To mirror the host path (detached process group +
`process.kill(-pid, ...)`), spawn the wrapper under `setsid` so `processPid` (`$$`, read back
post-spawn) is the **process-group leader**:

```
docker exec -w <containerCwd> <containerId> setsid /bin/sh -c '<wrapper>'
```

With `setsid` the in-container `processPid` == the process-group id, so kill targets the whole group
with a negative pid: `docker exec <cid> kill -TERM -<processPid>` → escalate to
`kill -KILL -<processPid>` (§7.1/§9). `setsid` ships with util-linux/busybox and is present in
effectively all images.

> **Image without `setsid` (fallback).** If a target image lacks `setsid`, plain
> `docker exec ... /bin/sh -c '<wrapper>'` cannot make `processPid` a group leader, so a
> negative-pid group kill is unavailable. Fall back to a best-effort tree kill:
> `docker exec <cid> kill -TERM <processPid>` **plus** `docker exec <cid> pkill -TERM -P
> <processPid>` (and/or `kill -- -<processPid>` if a group happens to exist), escalating to `-KILL`.
> This is best-effort only and documented as the degraded path; the `setsid` group kill is the
> primary mechanism.

`$$` is the **in-container wrapper pid** (`processPid` / group leader), read back post-spawn via
`docker exec <cid> cat <pid>` (§4.0) since the host-side `child.pid` is only the docker-exec handle.
The `docker exec` shape is otherwise unchanged from `defaultSpawn` (the inner string gains the
pidfile, trimmer, redirect, and status write; the outer command gains `setsid`).
`MSYS_NO_PATHCONV=1` / `MSYS2_ARG_CONV_EXCL=*` env stays so Git Bash on the host does not mangle
container paths.

### 4.3 stdio for the spawned wrapper

Because output now goes to the spool files, the child's stdio can be `["ignore", "ignore",
"ignore"]` for host spawns — we no longer read pipes. The wrapper-written pidfile, read back in the
required post-spawn step §4.0, supplies `processPid`, so we never depend on a stdout pipe for it
(docker resolves `processPid` via `docker exec <cid> cat <pidfile>` instead; the docker-exec host
handle is only used for liveness/kill while alive). Host spawns keep `detached: true` +
`child.unref()` so the orphan survives gateway exit.

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
  /** host-side child.pid; for docker this is the `docker exec` handle pid — valid ONLY while the
   *  original gateway lives, NOT usable after restart. Liveness/kill must NOT use this. */
  hostPid: number;
  /** the signalable wrapper pid in its OWN namespace — host: equals child.pid; docker: the
   *  in-container wrapper pid read from the pidfile post-spawn. Liveness/kill use THIS. 0 = pending. */
  processPid: number;
  cwd: string;
  containerId?: string;       // present for sandboxed/docker spawns
  status: "running" | "exited" | "unrecoverable";
  exitCode: number | null;    // null while running, when killed-without-status, OR unrecoverable
  /** why the process reached a terminal state; null while running. Authoritative source of truth. */
  terminalReason: "normal" | "killed" | "unrecoverable" | null;
  startTime: number;
  endTime: number | null;
  // transient spool files (child appends; bounded by wrapper trimmer + gateway copytruncate — §8)
  outSpool: string;
  errSpool: string;
  // durable COMBINED capped projection (gateway-owned; atomic tmp+rename; ≤512KB/5000 lines
  // COMBINED across both streams; lines tagged <ts>\t<stream>\t<text>) — <bgId>.log
  logFile: string;
  statusFile: string;
  pidFile: string;            // host: wrapper-written processPid+nonce; docker: in-container pidfile path
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

**Legacy non-persistent processes are never written to `bg-processes.json`.** The cmd.exe fallback
(§4.1) keeps the current in-memory record only; the in-memory `BgProcess`/`BgProcessInfo` and the
`bg_process_created` WS event carry a `persistent: boolean` flag (`true` on the POSIX path, `false`
for the legacy fallback) so the UI/log never implies durability for a process that will not survive
a restart.

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
           "status"|"exitCode"|"terminalReason"|"endTime"|"outOffset"|"errOffset"|"hostPid"|"processPid">>): void;
  remove(sessionId: string, id: string): void;         // index entry only
  removeForSession(sessionId: string): void;
  flush(): void;
  /** dir holding the per-process files for a session */
  filesDir(sessionId: string): string;                 // <stateDir>/bg-processes/<sessionId>
}
```

**Write cadence:** `put` on create (structural → `saveNow`); `update` on exit and on
offset-advance. Offsets advance frequently, so `outOffset`/`errOffset` updates use the **debounced**
path (like `lastActivity`), while `status`/`exitCode`/`terminalReason`/`endTime` **and the
post-spawn `processPid`** (§4.0) are **recovery-critical** → flush synchronously (mirror
`SessionStore.RECOVERY_CRITICAL_FIELDS`). Losing a few KB of replayed offset
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
feeds each chunk into the capped in-memory `log[]` buffer (interleaving stdout/stderr by arrival)
and (debounced ~500ms) rewrites the **single durable combined projection** `<bgId>.log` from that
buffer, tagging each line `<ts>\t<stream>\t<text>` (§8).

```ts
export interface Tailer {
  /** Begin tailing from `startOffset`; calls onChunk for each new slice. */
  start(startOffset: number): void;
  stop(): void;
}
export interface TailerSpec {
  outSpool: string; errSpool: string;   // the tailer watches the SPOOLS, never the projection
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
capped, interleaved into `log[]`) and the existing `bg_process_output` WS broadcast — so the API
(`getLogs`, `grep`, `head`, `slice`) and the pill work unchanged on the combined interleaved view —
and triggers the debounced atomic rewrite of the single combined durable projection from that
capped buffer (§8). The only change to `create()` is that the chunk source is the two spool tailers,
not `child.stdout.on("data")`. Readers always consume the combined projection, never the spools.

### 6.1 Detecting exit via the status file

Independently of the tailer, a **status watcher** polls `<bgId>.status` (host: `fs.existsSync` +
read; docker: `docker exec <cid> cat <statusFile>` returning non-empty). When the status file
appears with content:

1. parse the integer exit code (trim; tolerate partial write — see §11, retry until a full integer
   line is present or a short grace timeout elapses);
2. set `status="exited"`, `exitCode=<n>`, `terminalReason="normal"`, `endTime=Date.now()`;
3. do a **final tail flush** (read any remaining bytes of both spools past their offsets → capped
   `log[]` buffer → final atomic combined-projection rewrite) so no trailing output is lost and the
   `<bgId>.log` projection is current;
4. resolve `bg.exited`, persist (recovery-critical → sync), broadcast `bg_process_exited` (with
   `terminalReason`), stop the tailers and status watcher, then delete the now-consumed spool
   files (the durable combined projection is what survives — §8).

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
    rehydrate in-memory record; load tail of the COMBINED projection <bgId>.log into
      log[]/stdout[]/stderr[] (parse <ts>\t<stream>\t<text>, last MAX_LOG_LINES/MAX_LOG_BYTES,
      interleaving preserved); broadcast nothing (client re-fetches via GET on reconnect). Done.

if status == "running":
    liveness = checkAlive(record)        # processPid/container probe + nonce re-check (§7.1)
    case ALIVE (nonce matches):
        # re-attach
        rehydrate record (status stays "running", terminalReason stays null)
        read bounded tail (last 512KB/5000 lines) of BOTH spools from persistedOffsets -> capped
          log[] buffer -> rewrite combined projection; then copytruncate both spools (§8)
        start tailers from new offsets       -> resumes live streaming
        start status watcher                 -> captures eventual real exit code (-> terminalReason="normal")
    case COMPLETED_DURING_DOWNTIME:   # not alive, but status file present & parseable
        read exitCode from status file; read bounded spool tails -> combined projection
        status="exited"; exitCode=<n>; terminalReason="normal"
        endTime = status file mtime (best-effort) or Date.now()
        broadcast bg_process_exited{ exitCode, terminalReason:"normal" }
    case UNRECOVERABLE:               # not alive AND (no status file | projection+spools missing | pid reused)
        status="unrecoverable"; exitCode stays null; terminalReason="unrecoverable"
        load whatever combined-projection tail exists
        broadcast bg_process_exited{ exitCode:null, terminalReason:"unrecoverable" }
        # NEVER fabricate an exit code
```

### 7.1 Liveness checks

- **Host:** `process.kill(processPid, 0)` — throws ESRCH if gone, returns if alive (host
  `processPid` equals `child.pid`). **Pid-reuse guard (nonce):** if the status file exists, the
  process already finished → treat as COMPLETED regardless of pid liveness (a reused pid can't
  retroactively un-write the status file). If the status file is absent and `kill(processPid,0)`
  succeeds, **re-read the pidfile and compare its nonce** against the persisted `nonce`:
  - **match** → genuinely the same process → ALIVE, re-attach.
  - **pidfile missing, unreadable, or nonce mismatched** → the live pid is a **reused/foreign**
    pid → if no status file, **UNRECOVERABLE** (`terminalReason="unrecoverable"`, `exitCode=null`,
    never fabricated).
- **Docker:** container alive via `docker inspect -f '{{.State.Running}}' <cid>` (and the
  containerId must still resolve from `SandboxManager`; if the project's container was recreated,
  the old container/exec is gone → not alive). Then `docker exec <cid> kill -0 <processPid>` for the
  in-container wrapper (the `processPid` read from the in-container pidfile, **not** `hostPid`/the
  dead docker-exec handle), **plus `docker exec <cid> cat <pidfile>` to re-check the nonce** exactly
  as the host path. If the container is gone, the in-container `/tmp` files are gone too → if no
  status was ever read, **unrecoverable** (`terminalReason="unrecoverable"`); if we had already
  recorded an exit, it stays exited.

### 7.2 Container recreated

Container recreation (new `containerId`) means the process and its `/tmp` files are gone. Such a
record is **unrecoverable** (`terminalReason="unrecoverable"`, `exitCode=null`) unless its
status/exit was captured before the restart. This is correct and honest — we do not invent an exit
code.

## 8. Log caps on disk — transient spools + gateway-owned combined capped projection

**Requirement:** the durable on-disk log must stay within `MAX_LOG_LINES` 5000 / `MAX_LOG_BYTES`
512KB **at all times** — while running, across a restart, and after exit — not just post-exit. The
cap is defined **COMBINED per-process**: ≤ 512KB / 5000 lines **total across stdout+stderr**,
exactly matching the existing in-memory per-process cap and the `512KB per process` comment in
`bg-process-manager.ts`. There is **no** per-stream 1MB / 10000-line total — the durable artefact is
a single combined file capped at the per-process limit. The problem is that on a host the *child*
holds the spool open and keeps appending; the gateway cannot safely truncate-from-front a file the
child has open (especially on Windows). The solution separates transient spools from one durable
combined projection:

- **Transient per-stream spools** (`<bgId>.out.spool` / `<bgId>.err.spool`) — the child appends here
  (`>>`, §4). These are explicitly transient, **gateway-managed rings**, *not* "the persisted log".
  Each spool is independently copytruncated at ≤ 512KB; it may exceed that only transiently (between
  gateway consume cycles) and is reclaimed (deleted) on exit. Spools are never read by clients.
- **Durable combined projection** (`<bgId>.log`) — the **gateway owns this file exclusively** and
  rewrites it **atomically (tmp + rename)** from the single in-memory capped `log[]` buffer, tagging
  each line `<ts>\t<stream>\t<text>`. It is therefore **always ≤ 512KB / 5000 lines COMBINED across
  both streams**, fully consistent with the in-memory trim. Restore and every REST reader
  (`getLogs`/`grep`/`head`/`slice`) read this combined projection, never the spools.

### Keeping the combined projection capped while running

The tailers read both spool deltas → feed the existing in-memory `appendLog()` (which interleaves
stdout/stderr into one `log[]` already trimmed to the combined `MAX_LOG_LINES`/`MAX_LOG_BYTES`) → a
**debounced (~500ms) atomic rewrite** serialises that capped buffer to `<bgId>.log.tmp` and
`rename`s it over `<bgId>.log`. Because the source buffer is already capped, the durable combined
projection is bounded **continuously** — it can never exceed the combined per-process cap, even
mid-run, on any shell.

### Bounding the transient spools — wrapper-owned trimmer (primary) + gateway copytruncate (secondary)

The spools are bounded by **two independent mechanisms**, so neither the gateway nor the wrapper is
the sole guard:

1. **Wrapper-owned trimmer (primary, restart-independent).** The detached/orphaned wrapper runs a
   background loop (§4.1/§4.2) that, while alive, trims each spool to the last `<KEEP>` = 512KB
   whenever it exceeds `MAX_LOG_BYTES`, via `tail -c <KEEP> "$f" > "$f.trim" && cat "$f.trim" > "$f"`
   (in-place same-inode copytruncate). Because the loop is part of the **wrapper, not the gateway**,
   it bounds each spool **at all times — during the normal run AND while the gateway is down.** This
   is what holds the "on-disk logs stay within caps at all times" requirement during a long outage.
2. **Gateway copytruncate (secondary).** When the gateway has consumed a spool up to its read offset
   **and** the spool exceeds `MAX_LOG_BYTES`, it also does `fs.truncateSync(spool, 0)` and resets its
   read offset to `0`. The next child write lands at offset 0 (POSIX `>>`/`O_APPEND`). This is a
   redundant bound that catches the brief windows between trimmer passes while the gateway is up; it
   is no longer the sole mechanism.

Both paths require a POSIX shell (the persistent path is POSIX-only, §4.1); the legacy cmd.exe
fallback is in-memory/non-persistent and writes no spools at all, so it has no on-disk spool to
bound.

> **copytruncate race (acknowledged):** a few bytes written between a read/trim and the
> `cat "$f.trim" > "$f"` / `truncate(0)` can be lost. This is the standard logrotate copytruncate
> caveat and is **acceptable here** because the on-disk log is already an explicitly lossy last-N
> cap, not an audit log. Both the wrapper trimmer and the gateway use copytruncate (same inode,
> never `mv`/rename) so the command's append fd is never orphaned.
>
> **Belt-and-braces:** the wrapper bounds each spool independently of the gateway (even during
> downtime), the gateway re-bounds on consume, and the durable combined projection is independently
> capped from the in-memory buffer — so neither the spools nor the durable log can grow without
> bound on any POSIX platform.

### Downtime window

While the gateway is down, the **wrapper-owned trimmer keeps each spool bounded** (≤ ~512KB) — the
child keeps appending but the trimmer (part of the orphaned wrapper) keeps copytruncating, so the
spools do **not** grow unbounded during an arbitrarily long outage. Only the combined projection
goes stale (nothing projects while the gateway is down). On `restoreSession()` the gateway reads only
the **bounded tail** (last 512KB / 5000 lines combined) of the spools to rebuild the in-memory
`log[]` buffer, immediately rewrites the combined projection, **then copytruncates both spools** as a
secondary bound. So both the spools (wrapper trimmer) and the durable projection (restore rewrite)
are capped throughout.

There is no separate "post-exit trim" and no multi-megabyte "safety ceiling": the combined
projection is the durable artefact and is bounded at every instant by construction, and the spools
are bounded continuously by the wrapper trimmer.

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
  **delete the per-process files** — both spools **and** the combined projection plus status/pid:
  `.out.spool`, `.err.spool`, `<bgId>.log`, `.status`, `.pid` (for docker also
  `docker exec <cid> rm -f <containerPaths>` best-effort). Broadcast a new
  `bg_process_dismissed` WS event so other clients drop the pill. Returns `{ ok: true }`.

### 9.2 New manager methods

```ts
// bg-process-manager.ts
kill(sessionId, processId): boolean;                 // existing — keep; signals processPid; exit code from status file, else terminalReason="killed"
dismiss(sessionId, processId, opts?: { force?: boolean }): boolean;   // NEW: remove record + purge spools+combined projection+status+pid
restoreSession(sessionId): Promise<void>;            // NEW: §7 per-session reconciliation (called from restoreSessions loop)
```

**Kill mechanics** (signalling the right process pre- vs post-restart) — always target the persisted
`processPid`, never `hostPid`:
- **Host:** `taskkill /pid <processPid> /T /F` (Windows) or `process.kill(-processPid, SIGTERM)` then
  `SIGKILL` (POSIX) against the persisted wrapper `processPid` (= `child.pid` on host). A live
  `child` handle, when one still exists (pre-restart), is used as an optimisation but is not
  required.
- **Docker:** after a restart there is **no host `child` handle** for a re-attached process, and
  `hostPid` (the dead docker-exec handle) is useless, so kill via the **persisted in-container
  `processPid`**, which is the process-group leader (spawned under `setsid`, §4.2). Signal the
  **whole group** with a negative pid: `docker exec <cid> kill -TERM -<processPid>`, escalating to
  `docker exec <cid> kill -KILL -<processPid>` if it does not exit within a grace window — this
  terminates the wrapper, the `( <command> )` subshell, and any grandchildren, not just the wrapper
  shell. (Image without `setsid`: best-effort `kill -TERM <processPid>` + `pkill -TERM -P
  <processPid>`, §4.2.) `child.kill(...)` on a still-live docker-exec handle is only an optimisation
  when the gateway never restarted.

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
  spawnFn(cmd, cwd, undefined, paths)            # POSIX wrapper: pidfile($$+nonce); bg trimmer bounds both spools; ( cmd ) >> out.spool 2>> err.spool; code=$?; kill trimmer; printf code > status
  child.unref();  hostPid = child.pid
  REQUIRED post-spawn: read pidfile -> processPid (host: <pid> file/child.pid)
  store.put(record status=running, terminalReason=null, nonce, hostPid, processPid)   # SYNC flush before created
  tailerFactory({outSpool,errSpool}).start(0,0) # poll BOTH SPOOLS -> appendLog (combined capped log[]) -> bg_process_output WS
                                                 #   -> debounced atomic rewrite of single <bgId>.log combined projection
                                                 #   -> copytruncate each spool when > cap (gateway secondary; wrapper trimmer is primary)
  statusWatcher.start()                          # poll <status>
  broadcast bg_process_created
```

### Live output
```
wrapper appends -> <bgId>.out.spool / <bgId>.err.spool grow
tailers poll detect delta -> read spool bytes -> appendLog() [combined interleaved capped log[]]
  -> debounced(~500ms) atomic rewrite single <bgId>.log combined projection (<=512KB/5000 COMBINED) [ALWAYS capped]
     each line tagged <ts>\t<stream>\t<text>
  -> if a spool > cap && consumed: fs.truncateSync(spool,0); offset=0                 [copytruncate, gateway secondary; wrapper trimmer primary]
  -> store.update(outOffset/errOffset) [debounced] -> broadcast bg_process_output -> pill.appendOutput()
```

### Restart -> restore -> re-attach
```
boot: restoreSessions() loops sessions; per session containerId re-resolved
  -> bgMgr.restoreSession(sessionId):            # store = storeProvider(sessionId) (this session's store)
  for each PersistedBgProcess of that session:                       # liveness/kill target processPid (NOT hostPid)
    running + alive(processPid + nonce match) -> rehydrate; read bounded tail of BOTH spools -> combined projection;
                                      copytruncate spools; tailers.start(newOffsets); statusWatcher.start()  (terminalReason stays null)
    running + completed            -> read <status> exitCode; bounded spool tails -> combined projection;
                                      status=exited; terminalReason=normal; broadcast exited{exitCode,normal}
    running + pid-reused/lost       -> status=unrecoverable; terminalReason=unrecoverable;
                                      broadcast exited{exitCode:null, terminalReason:unrecoverable}  # NEVER fabricate
    exited/unrecoverable            -> rehydrate from COMBINED projection tail (parse <ts>\t<stream>\t<text>;
                                      no broadcast; client GETs on reconnect)
client reconnects -> GET /bg-processes -> sees restored pills; WS resumes streaming
```

### Exit
```
wrapper finishes -> ( cmd ) subshell exit captured in code=$? -> printf code > <status>  (exit N inside cmd is contained)
statusWatcher sees <status> with content -> parse exitCode (retry on partial)
  -> final flush of BOTH spools -> combined capped buffer -> final atomic <bgId>.log rewrite
  -> status=exited, exitCode=N, terminalReason=normal, endTime -> store.update(sync) -> resolveExited()
  -> broadcast bg_process_exited{exitCode, terminalReason} -> stop tailers+watcher -> delete spool files
(combined projection already within caps at every instant; no post-exit trim needed)
```

### Kill
```
UI Kill -> DELETE ?action=kill -> bgMgr.kill()
  host:   taskkill /pid <processPid> /T /F (win) | process.kill(-processPid,SIGTERM)->SIGKILL (posix)  [persisted processPid]
  docker: docker exec <cid> kill -TERM -<processPid> ->escalate-> kill -KILL -<processPid>  [setsid group leader; whole tree]
          (child.kill only as optimisation when a live host handle still exists, pre-restart)
if wrapper wrote <status> -> statusWatcher -> status=exited, terminalReason=normal (real code)
else hard-killed before status -> status=exited, exitCode=null, terminalReason=killed   # known kill, not fabricated
pill stays as a terminal pill until dismissed
```

### Dismiss
```
UI Remove -> DELETE ?action=dismiss -> bgMgr.dismiss()
  refuse if running (unless force)
  store.remove(); delete <out>.spool,<err>.spool,<bgId>.log,<status>,<pid>
  docker: docker exec <cid> rm -f <containerPaths>  (best-effort)
  broadcast bg_process_dismissed -> all clients drop pill
record never reappears after subsequent restart (files + index entry gone)
```

## 11. Risks & edge cases

- **Partial status-file write.** `printf '%s\n' "$code" > f` is a single small write but the watcher
  may read mid-write. Mitigation: require a parseable integer
  **followed by newline**; if absent, retry for up to ~2s before treating as still-writing. The
  wrapper writes exactly one line, so a complete read yields a clean integer.
- **Pid reuse (host) — detected, not just documented.** §7.1: status-file presence is authoritative
  (a reused pid can't un-write a status file); when status is absent and the pid is alive, the
  gateway re-reads the pidfile and compares the **per-spawn nonce** (`printf '%s\n%s\n' "$$"
  "<nonce>"` in the wrapper, §4.1/§4.2; compared against the live `processPid` pidfile). Match → same process, re-attach. Missing/mismatched nonce
  (or pidfile gone) with no status file → **pid reused** → `terminalReason="unrecoverable"`,
  `exitCode=null` — never fabricated. (The legacy cmd.exe fallback is non-persistent (§4.1), so it
  is never restored and never reaches the nonce guard.)
- **Log rotation racing the tailer.** The durable **combined projection** (`<bgId>.log`) is
  rewritten atomically (tmp + rename) by the gateway alone and the child never writes it, so readers
  never see a torn projection. The **spool** copytruncate (§8) may lose a few bytes between
  last-read and `truncate(0)` — the standard logrotate copytruncate caveat, acceptable because the
  log is already a lossy last-N cap. Each spool is bounded by the **wrapper-owned trimmer** (primary,
  restart-independent) and the **gateway copytruncate** (secondary); both are POSIX-only (the legacy
  cmd.exe fallback writes no spool), so no spool is ever unbounded.
- **Windows process-group kill.** `taskkill /pid <processPid> /T /F` kills the wrapper shell **and** its
  child tree (`/T`), so a force-killed host process **may not write a status file**. Handling:
  `kill()` records an intent-to-kill timestamp; the watcher, seeing the `processPid` gone with no
  status within a grace window **after an explicit kill**, marks `status="exited"`, `exitCode=null`,
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
export interface BgPaths { outSpool; errSpool; logFile; status; pid; nonce; inContainer: boolean }  // logFile = single combined <bgId>.log
export type SpawnFn = (command, cwd, containerId, paths: BgPaths) => ChildProcess;
export interface TailerSpec { outSpool; errSpool; inContainer; containerId?; onChunk }  // watches the SPOOLS
export type TailerFactory = (spec: TailerSpec) => { out: Tailer; err: Tailer };
function buildHostWrapper(command, paths): string;   // POSIX wrapper only (Git Bash / /bin/sh); no cmd branch
function buildDockerWrapper(command, paths): string; // POSIX /bin/sh wrapper, spawned under setsid
class BgProcessManager {
  constructor(clientsProvider, spawnFn?, storeProvider?, tailerFactory?);
  create(sessionId, command, cwd, containerId?, sandboxed?, name?): BgProcessInfo;  // spawn + REQUIRED post-spawn pidfile read -> processPid (sync flush) + wires spools+tailers+combined projection
  kill(sessionId, processId): boolean;                                              // signals processPid (host or in-container)
  dismiss(sessionId, processId, opts?: { force?: boolean }): boolean;               // NEW
  restoreSession(sessionId): Promise<void>;                                         // NEW: per-session §7 reconciliation
  // getLogs/grep/head/slice/waitForExit/list unchanged (read the COMBINED PROJECTION's interleaved view)
}
// BgProcess / BgProcessInfo: pid -> { hostPid, processPid }; status widened to "running" | "exited" | "unrecoverable";
// + terminalReason: "normal" | "killed" | "unrecoverable" | null  (authoritative; null while running)
// + persistent: boolean (false only for the legacy cmd.exe in-memory fallback, §4.1)
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

> Persistence/re-attach/nonce/trimmer all assume a **POSIX shell** (Git Bash on Windows, `/bin/sh`
> elsewhere/docker). The cmd.exe path is the **legacy non-persistent fallback** and is not part of
> the persistence tests (covered only by the dedicated "legacy cmd.exe fallback" case below).

- **Persistence round-trip:** create with a fake `SpawnFn` + fake `TailerFactory` that writes to a
  temp `stateDir`; assert `bg-processes.json` written atomically and the durable **combined
  projection** (`<bgId>.log`) present; construct a *fresh* `BgProcessManager` over the same dir;
  `restoreSession(sessionId)`; assert records + combined-projection tail restored.
- **Combined-projection interleaving survives restart:** feed interleaved stdout/stderr chunks via
  the fake tailer (e.g. out,err,out,err) so the in-memory `log[]` has a known interleaved order;
  assert `<bgId>.log` serialises `<ts>\t<stream>\t<text>` in that order; reload a fresh manager and
  assert restored `log[]`/`stdout[]`/`stderr[]` reproduce the **exact interleaving/order** and that
  `grep`/`head`/`slice` return the same combined view as before the restart.
- **Post-spawn pidfile read resolves processPid:** host — assert `processPid` flushed (sync) from
  the pidfile/`child.pid` before `bg_process_created`; docker — fake `docker exec cat <pidfile>`
  (with a brief retry) yields the in-container wrapper pid, which is stored as `processPid` while
  `hostPid` stays the docker-exec handle pid; until read, `processPid` persists as `0`/pending.
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
- **`exit N` inside the user command is captured (behavioral):** a command containing `exit 3`,
  run through the wrapper, must still yield `terminalReason="normal"`, `exitCode=3` via the status
  file — **NOT** killed/unrecoverable. Drive via the fake `SpawnFn`/status file modelling the
  subshell semantics (`( <command> ) ; code=$? ; printf code > status`), asserting the wrapper still
  writes `3` even though the user command called `exit`.
- **Docker restore/kill targets the in-container `processPid`:** persisted docker record;
  `restoreSession()` liveness uses `docker exec <cid> kill -0 <processPid>` (not `hostPid`), and
  `kill()` issues `docker exec <cid> kill -TERM/-KILL -<processPid>` (**negative** pid = process
  group, `setsid` leader) against the in-container pid read from the pidfile — assert the dead
  `hostPid` is never signalled and the group form is used. **Manual/integration (needs Docker):**
  assert killing a docker bg process stops the actual long-running **child** command (e.g. a
  `sleep`/printing loop inside `( <command> )`), not just the wrapper shell — extend
  `tests/manual-integration/sandbox-recovery-docker.spec.ts`.
- **Dismiss purges files:** `dismiss()` deletes `.out.spool/.err.spool/<bgId>.log/.status/.pid` and
  the index entry; a subsequent `restoreSession()` finds nothing.
- **Disk caps — COMBINED, WHILE RUNNING, POSIX:** feed > cap of interleaved stdout+stderr via
  the fake tailer **without** exiting; assert the durable **combined** projection `<bgId>.log` on
  disk is ≤ 512KB / 5000 lines **combined across both streams**, **before** any exit (the
  gateway-owned capped rewrite), and stays ≤ caps after exit (no separate post-exit trim; bounded
  continuously). Assert gateway copytruncate fires past the cap on the posix + docker spool paths
  (`>>`/`truncate(0)`) as the secondary bound.
- **Wrapper-owned trimmer bounds spools (string + simulated):** assert `buildHostWrapper` /
  `buildDockerWrapper` emit the background trimmer loop (`while kill -0 "$$"`, `tail -c <KEEP>`,
  `cat "$f.trim" > "$f"`, **no** `mv`/rename) targeting both spools with the `<MAX_LOG_BYTES>`
  trigger / `<KEEP>` retain. Plus a unit test that **simulates the trimmer logic** in a temp dir
  (write > cap bytes to a fake spool, run the trim step) and asserts the spool ends ≤ `<KEEP>` and
  the **inode is unchanged** (in-place truncate, not rename) — i.e. spools stay capped independently
  of the gateway, modelling the downtime case.
- **Wrapper builders (POSIX only):** `buildHostWrapper` and `buildDockerWrapper` produce the exact
  POSIX strings — pidfile (`printf '%s\n%s\n' "$$" "<nonce>"`), the wrapper-owned trimmer loop, the
  user command in an **isolated subshell** `( <command> )`, **append** (`>>`) to both spools, the
  trimmer stop (`kill "$trimmer"`), and `code=$? ; printf code > status ; exit code`; the docker
  builder is otherwise identical and is spawned under `setsid`. Assert there is **no** cmd branch and
  **no** `%errorlevel%`. String assertions — pure, fast.
- **Legacy cmd.exe fallback is non-persistent:** when `getShellConfig()` yields cmd.exe (no Git
  Bash), `create()` uses the legacy in-memory pipe capture, flags the record `persistent: false`,
  writes **no** `bg-processes.json` entry and no spool/status/pid files, and the process is **not**
  restored after a simulated restart. (Persistence tests assume a POSIX shell; the cmd path is
  explicitly excluded from them.)

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
2. `BgPaths`, POSIX wrapper builders (isolated subshell `( <command> )` so `exit N` is contained;
   wrapper-owned trimmer bounding both spools; `>>` append; `code=$?` status write;
   `processPid`+nonce pidfile; docker spawned under `setsid`), the legacy cmd.exe in-memory fallback
   (`persistent:false`, no files) when Git Bash is absent, change `defaultSpawn` + `create()` to redirect output to the
   **spools**, perform the **required post-spawn pidfile read** to resolve `processPid` (sync
   flush), and feed the combined capped buffer + single durable combined projection from a `Tailer`
   (default poll tailer); status watcher for exit.
3. `restoreSession(sessionId)` reconciliation (alive / completed / pid-reused / lost) + wire into
   the `restoreSessions()` per-session loop; `ProjectContext.bgProcessStore`.
4. `dismiss()` + split DELETE route + `bg_process_dismissed` WS event + `terminalReason`
   (`normal`/`killed`/`unrecoverable`) plumbing through protocol/client/pill; Docker kill via
   persisted in-container group leader (`docker exec kill -TERM/-KILL -<processPid>`).
5. Disk caps: continuous combined-projection rewrite (≤512KB/5000 lines combined) + wrapper-owned
   spool trimmer (restart-independent) + gateway copytruncate (secondary); no post-exit trim, no
   unbounded spool, POSIX only.
6. Tests: unit persistence/re-attach/dismiss/caps; browser E2E; keep guard test green; `check`.
