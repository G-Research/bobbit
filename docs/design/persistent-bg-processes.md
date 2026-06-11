# Persistent `bash_bg` processes — survive gateway restart + re-attach to live processes

Status: implemented
Owner: bg-process feature

> This is the durable architecture record for the persistent `bash_bg` feature. The
> behaviour described below is implemented; see [docs/bg-process-persistence.md](../bg-process-persistence.md)
> for the operational reference and [docs/internals.md](../internals.md) for the runtime contract.
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
   (`BgProcessManager.create()` in `bg-process-manager.ts`), so on gateway exit the process keeps running as
   an orphan. But its stdout/stderr pipes were owned by the now-dead parent and **cannot be
   re-attached** from a new process. The new gateway has no record it ever existed.
2. **Docker-exec spawns** — `defaultSpawn` runs `docker exec ... <shell> -c <cmd>`
   (the `defaultSpawn` helper in `bg-process-manager.ts`). The command keeps running inside the still-alive container,
   but the **host-side `docker exec` handle dies with the gateway**, so output streaming and exit
   capture stop.

### Goal

Make bg processes behave as if the server never restarted:

- Persist each process's metadata + captured output to disk (atomic writes, mirroring
  `SessionStore`).
- Restore records on boot alongside `restoreSessions()`
  (`restoreSessions()` in `src/server/agent/session-manager.ts`) so `GET /api/sessions/:id/bg-processes` and the
  WS-driven pills show them after a restart with output intact.
- **Re-attach to still-running processes** — resume streaming live output and capture the
  eventual **real** exit code. Never fabricate exit codes.
- Cleanly distinguish **kill** (terminate a running proc, keep the exited record until dismissed)
  from **dismiss** (remove the record + delete persisted files).
- Keep disk usage bounded by the existing caps (`MAX_LOG_LINES` 5000 / `MAX_LOG_BYTES` 512KB,
  **combined per-process** across stdout+stderr, matching the in-memory trim) **at all times** —
  while the process is running, across a restart, and after exit (§8).
- Preserve sandbox parity and the `sandboxed && !containerId` host-execution guard
  (the guard at the top of `BgProcessManager.create()` in `bg-process-manager.ts`).

## 2. The crux: durable log/status files instead of in-memory pipes

You **cannot** re-attach to a dead parent's stdout/stderr pipes. The spawn model must change so
that output and exit status live on disk, independent of the gateway lifetime. The files split into
transient per-stream **spools** (written by the child — on the host, or container-internal for
docker) and a single durable **combined projection** plus a terminal **status snapshot** that the
**gateway owns as HOST files** (for BOTH host and docker spawns — see §3.2/§8 for the cap mechanics):

- At spawn time, **redirect the command's stdout/stderr into transient per-stream spool files**
  (`<bgId>.out.spool` / `<bgId>.err.spool`) that the child appends to. The spools are explicitly
  **transient, gateway-managed rings** (bounded by a wrapper-owned trimmer + gateway copytruncate,
  §8) — they are *not* "the persisted log".
- The gateway tails both spool deltas, interleaves them by arrival into the existing in-memory
  capped `log[]` buffer, and continuously rewrites a **single durable combined projection** it owns
  exclusively (`<bgId>.log`, **always a HOST file** for both host and docker spawns, atomic
  tmp+rename, always ≤ 512KB / 5000 lines **combined across both streams**). For docker the gateway
  mirrors the container-internal spool bytes into this host projection (§3.2). Each line is tagged
  `<ts>\t<stream>\t<text>` so restore rebuilds the interleaved
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
| Docker-exec, gateway down | Lost | Container keeps writing spool; gateway mirrors to HOST projection on restore; survives container churn |
| On-disk cap held while running | n/a | Gateway-owned combined capped projection (§8) |
| stdout/stderr interleaving survives restart | n/a | Combined timestamped projection rebuilds order |
| Unit-testable without OS | Fake child EventEmitter | Fake file paths + fake `Tailer` |

## 3. On-disk layout

All files live under the **project state dir** (`ProjectContext.stateDir` =
`<project.rootPath>/.bobbit/state`, see `ProjectContext` in `src/server/agent/project-context.ts`). This is the
same dir `SessionStore` writes `sessions.json` into, so per-project isolation and the isolated
test state dir (`tests/e2e/e2e-setup.ts`) are inherited for free.

```
<stateDir>/
  sessions.json                          # existing
  bg-processes.json                      # NEW: metadata index (all sessions for this project)
  bg-processes.json.bak.1 .. .bak.5      # NEW: rotated backups (mirrors SessionStore)
  bg-processes/                          # NEW: per-process files — HOST, gateway-owned (BOTH host & docker)
    <sessionId>/
      <bgId>.log                         # DURABLE COMBINED PROJECTION: HOST, gateway-owned, atomic rewrite,
                                         #   ≤512KB/5000 lines COMBINED; lines tagged <ts>\t<stream>\t<text>.
                                         #   ALWAYS host for BOTH host and docker spawns — the authoritative
                                         #   retained log; survives container recreation/removal.
      <bgId>.status                      # HOST terminal status snapshot (real exit code). Host spawns: the
                                         #   wrapper/helper writes it directly. Docker: the gateway MIRRORS the
                                         #   real code here once it reads the container status. Survives churn.
      # --- host spawns ONLY: live source files written on the host by the wrapper or Node helper ---
      <bgId>.out.spool                   # TRANSIENT: child appends stdout; bounded by wrapper/helper ring
                                         #   (restart-independent) + gateway copytruncate (secondary)
      <bgId>.err.spool                   # TRANSIENT: child appends stderr; bounded the same way
      <bgId>.pid                         # wrapper/helper processPid + spawn nonce — liveness + pid-reuse probe
      # --- docker spawns keep their LIVE SOURCE spool/status/pid container-internal (/tmp/bobbit-bg/...),
      #     tailed/read via `docker exec` and MIRRORED by the gateway into the host <bgId>.log + <bgId>.status (§3.2) ---
```

The **combined projection** (`<bgId>.log`) and the **terminal status snapshot** (`<bgId>.status`)
are **always HOST files the gateway owns exclusively**, for BOTH host and docker spawns — the child
never writes the projection. For host spawns the child appends only to the host spools; for docker
the child appends to container-internal spools that the gateway tails and mirrors into the host
projection (§3.2). Restore and every REST reader (`getLogs`/`grep`/`head`/`slice`) read the host
combined projection exclusively — the spools are implementation-internal rings, never served to
clients. grep/head/slice operate on the combined interleaved view exactly as they do today against
the in-memory `log[]`.

### 3.1 Stream files: per-stream spools vs combined projection

The wrapper (or Node bg-runner helper) redirects each stream to its **own transient spool file** —
keeping two files (`.out.spool`, `.err.spool`) is fully portable across Git Bash, `/bin/sh`, and the
Node helper (the helper covers Windows without Git Bash — §4.1). The child only ever appends to the
spools.

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
# HOST-owned, gateway-written — ALWAYS host for BOTH host and docker spawns:
<stateDir>/bg-processes/<sessionId>/<bgId>.log         # durable COMBINED projection (authoritative retained log)
<stateDir>/bg-processes/<sessionId>/<bgId>.status      # HOST terminal status snapshot (host: wrapper/helper-written; docker: gateway-mirrored)
# host spawns ONLY — live source, host paths:
<stateDir>/bg-processes/<sessionId>/<bgId>.out.spool   # transient, child-written (stdout)
<stateDir>/bg-processes/<sessionId>/<bgId>.err.spool   # transient, child-written (stderr)
<stateDir>/bg-processes/<sessionId>/<bgId>.pid         # processPid + nonce, wrapper/helper-written
# docker spawns ONLY — live source, container-internal (read/mirrored via docker exec, §3.2):
/tmp/bobbit-bg/<sessionId>/<bgId>.out.spool            # containerOutSpool
/tmp/bobbit-bg/<sessionId>/<bgId>.err.spool            # containerErrSpool
/tmp/bobbit-bg/<sessionId>/<bgId>.status               # containerStatus (gateway mirrors into HOST <bgId>.status)
/tmp/bobbit-bg/<sessionId>/<bgId>.pid                  # containerPid (processPid + nonce, read via docker exec cat)
```

### 3.2 Docker reachability — container-internal live source, HOST-owned projection

For sandboxed sessions the worktree is **container-internal** (cloned into `/workspace` or
`/workspace-wt/...`), **not** bind-mounted from the host (see
`src/server/agent/sandbox-clone-source.ts`, `MOUNTED_SRC_PATH`, and
`session-manager.ts::isSandboxContainerPath`). The host cannot read a file written inside the
container by path, and a container can be **recreated or removed** at any time — taking its
filesystem with it.

So the durable artefacts must be **host-owned even for docker**:

- **Live source files stay container-internal.** Because the wrapper runs *inside* the container,
  the two spools, the status file, and the pidfile are written under
  `/tmp/bobbit-bg/<sessionId>/<bgId>.*` in the container (fields `containerOutSpool`,
  `containerErrSpool`, `containerStatus`, `containerPid`). The host reaches them via `docker exec`.
- **The durable combined projection (`<bgId>.log`) and the terminal status snapshot
  (`<bgId>.status`) are HOST files the gateway owns** — same host path as for host spawns
  (`<stateDir>/bg-processes/<sessionId>/<bgId>.{log,status}`). The gateway tails the container
  spools and **mirrors observed bytes into the host projection**, and when it reads the container
  status it **mirrors the real exit code into the host status snapshot**. Captured output + final
  outcome therefore survive container recreation/removal — satisfying "output retained until
  dismissed" and sandbox parity.

Mechanics (all container access via `docker exec`):

- **Tail live / re-attach:** `docker exec <cid> tail -c +<offset+1> -F <containerOutSpool>` /
  `<containerErrSpool>` (the `-F` keeps following across truncation; `-c +<offset+1>` resumes from a
  byte offset). The gateway feeds the bytes into the in-memory capped `log[]` and atomically
  rewrites the **host** `<bgId>.log` projection from it (exactly as for host spawns).
- **Read final status / mirror:** `docker exec <cid> cat <containerStatus>`; on a complete read the
  gateway writes the real exit code into the **host** `<bgId>.status` snapshot (atomic tmp+rename).
- **Resolve `processPid` post-spawn / liveness:** `docker exec <cid> cat <containerPid>` reads the
  in-container wrapper pid (`processPid`) **and** the spawn nonce (§4/§7.1); liveness is
  `docker inspect -f '{{.State.Running}}' <cid>` for the container plus
  `docker exec <cid> kill -0 <processPid>` for the in-container wrapper.

The metadata records BOTH the host projection/snapshot paths (`logFile`, `statusSnapshot`) **and**
the container source paths (`containerOutSpool`/`containerErrSpool`/`containerStatus`/
`containerPid`), plus the `containerId`. `inContainer=true` selects the docker tail/cat/mirror path;
the host `logFile`/`statusSnapshot` are written by the gateway regardless.

> The container source path `/tmp/bobbit-bg/<sessionId>/<bgId>.*` is created with `mkdir -p` by the
> wrapper; `/tmp` survives for the container's lifetime. Because the authoritative retained log +
> status now live on the **host**, losing the container (recreation/removal) loses only the *live
> source* — never the already-captured output or an already-mirrored exit code (§7.2).

## 4. Spawn model (concrete commands)

`SpawnFn` keeps its signature so tests can override it. `defaultSpawn` changes to: (a) compute the
host projection/status-snapshot paths plus the spool/status/pid source paths, (b) build a wrapper
command that redirects output to the **spool** files and writes the status file + pidfile
(`processPid` + nonce), (c) spawn the wrapper. For docker the spool/status/pid live in the container
and the host combined projection + status snapshot are **gateway-mirrored** (§3.2). On a Windows host
**without Git Bash**, `defaultSpawn` instead launches the detached **Node bg-runner helper**, which
produces the same files + full persistence parity (§4.1).

```ts
// bg-process-manager.ts
export interface BgPaths {
  // HOST-owned, gateway-written — ALWAYS host for BOTH host and docker spawns:
  logFile: string;        // DURABLE COMBINED projection <bgId>.log (<ts>\t<stream>\t<text>); authoritative retained log
  statusSnapshot: string; // HOST <bgId>.status terminal snapshot (host: wrapper/helper-written; docker: gateway-mirrored)
  // LIVE SOURCE — host spawns: host paths; docker spawns: empty (see container* below):
  outSpool: string;       // TRANSIENT child-written stdout spool
  errSpool: string;       // TRANSIENT child-written stderr spool
  pidFile: string;        // host wrapper/helper writes processPid+nonce
  // LIVE SOURCE — docker spawns only, container-internal (/tmp/bobbit-bg/...), read via docker exec:
  containerOutSpool?: string;
  containerErrSpool?: string;
  containerStatus?: string;
  containerPid?: string;  // in-container pidfile: processPid + nonce
  nonce: string;          // per-spawn random token written into the pidfile (pid-reuse guard, §7.1)
  /** true => docker: live source is the container* paths; gateway mirrors into logFile + statusSnapshot */
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
  `docker exec <cid> cat <containerPid>`, **retrying briefly** (the wrapper writes the pidfile
  asynchronously) until a pid+nonce line appears. `hostPid = child.pid` (the docker-exec handle).

The manager then **synchronously flushes** `processPid` (and `hostPid`, `nonce`) into
`bg-processes.json` before broadcasting `bg_process_created`. Until `processPid` is known the record
persists `processPid: 0` (pending) and is reconciled the moment the pidfile read succeeds.

### 4.1 Host wrapper — POSIX only (Git Bash on Windows / `/bin/sh`)

`getShellConfig()` (`src/server/agent/shell-util.ts`) returns Git Bash (`bash -c`) on Windows when
`GIT_BASH` is found (the **strongly-preferred** Windows default), `/bin/sh -c` on Linux/macOS, and
resolves `cmd.exe /d /s /c` on a Windows host with no Git for Windows installed. The **primary**
bg-process mechanism is a **POSIX shell wrapper** — Git Bash on Windows or `/bin/sh` on Linux/macOS
(and `/bin/sh` inside docker, §4.2) — which provides full persistence + re-attach. On the rare
Windows host where `GIT_BASH` is `null`, the manager does **not** fall back to a non-persistent mode;
instead it spawns a detached **Node bg-runner helper** that provides full persistence parity (see
§4.1.1). **Every** host platform is therefore persistent + re-attachable.

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
`-gt <MAX_LOG_BYTES>` test is the trim trigger. For host spawns `<outSpool>`/`<errSpool>` = the host
spools, `<status>` = the host `<bgId>.status` snapshot, `<pid>` = the host pidfile — all under
`<stateDir>/bg-processes/...`; the gateway needs no mirroring on the host because the wrapper writes
the host-owned files directly.)

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

### 4.1.1 Windows without Git Bash → Node bg-runner helper

When `GIT_BASH` is `null` (no Git for Windows) `cmd.exe` cannot run the POSIX wrapper (no `$$`/`$?`,
no portable trimmer, no nonce). Rather than degrade to a non-persistent mode, the manager spawns a
bundled **Node bg-runner helper** that provides **full persistence parity** with the POSIX wrapper.
Node is always available — it is the gateway runtime (`process.execPath`) — and the helper script
ships with the gateway package, resolved **relative to the gateway module** (e.g.
`new URL('./bg-runner.js', import.meta.url)` / `path.join(__dirname, 'bg-runner.js')`) so it is
present after a restart regardless of cwd.

The helper (a small standalone Node script) is given the user command, the resolved shell
(`getShellConfig()`), the `BgPaths`, the `nonce`, and the caps. It:

- runs the user command via the resolved shell (`spawn(shell, [...args, command])`);
- **owns the spool with a bounded ring** — it appends child stdout/stderr to `<bgId>.out.spool` /
  `<bgId>.err.spool` and trims each to the last `<KEEP>` = `MAX_LOG_BYTES` whenever it exceeds the
  cap (the same combined caps as everywhere else). Because the helper is itself a **detached process
  that survives gateway exit**, this ring is **restart-independent** — it keeps the spools bounded
  even while the gateway is down, exactly like the POSIX wrapper-owned trimmer;
- writes `processPid` (the helper's pid, which roots the child tree) **and** the per-spawn `nonce`
  to the pidfile;
- writes the **real child exit code** to the status file on the child's `exit` event;
- is spawned `detached: true` + `unref()` so it **survives gateway restart**. The gateway re-attaches
  by tailing the spool + reading the status **exactly as for the shell wrapper** — the helper path
  is indistinguishable downstream.

Because the helper writes the same spool/status/pid (with nonce) the pid-reuse guard (§7.1), the
bounded-log cap (§8), restore, and re-attach (§6/§7) all work **unchanged** on this path.

> The manager selects the host mechanism at spawn time from `getShellConfig()`: a POSIX shell (Git
> Bash or `/bin/sh`) → build the wrapper via `buildHostWrapper(command, paths)` and spawn it; a
> non-POSIX shell (cmd.exe, i.e. Windows without Git Bash) → spawn the detached Node bg-runner
> helper instead. **Both paths are fully persistent + re-attachable**; there is no non-persistent
> host path. `buildHostWrapper` only ever emits the POSIX wrapper — there is no cmd branch (§12).
> The injectable `SpawnFn` abstracts both choices, so unit tests exercise wrapper-vs-helper
> selection without touching the OS.

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
`MAX_LOG_BYTES` = 512KB. For docker `<outSpool>`/`<errSpool>` = `containerOutSpool`/
`containerErrSpool`, `<status>` = `containerStatus`, `<pid>` = `containerPid` — all container-internal
under `/tmp/bobbit-bg/...`. The gateway tails these via `docker exec` and **mirrors** observed bytes
into the HOST `<bgId>.log` projection and the real exit code into the HOST `<bgId>.status` snapshot,
so captured output + outcome survive container recreation/removal — §3.2/§6.)

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
(docker resolves `processPid` via `docker exec <cid> cat <containerPid>` instead; the docker-exec
host handle is only used for liveness/kill while alive). Host spawns keep `detached: true` +
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
  // HOST-owned, gateway-written — ALWAYS host for BOTH host and docker spawns:
  // durable COMBINED capped projection (atomic tmp+rename; ≤512KB/5000 lines COMBINED across both
  // streams; lines tagged <ts>\t<stream>\t<text>) — <bgId>.log; authoritative retained log.
  logFile: string;
  // HOST terminal status snapshot — <bgId>.status (host spawns: wrapper/helper-written; docker:
  // gateway mirrors the real exit code here once read from the container). Survives container churn.
  statusSnapshot: string;
  // LIVE SOURCE — host spawns: host paths (child appends; bounded by wrapper/helper ring +
  // gateway copytruncate — §8). For docker these are empty; use the container* fields.
  outSpool: string;
  errSpool: string;
  pidFile: string;            // host wrapper/helper-written processPid+nonce
  // LIVE SOURCE — docker spawns only, container-internal (/tmp/bobbit-bg/...), via docker exec:
  containerOutSpool?: string;
  containerErrSpool?: string;
  containerStatus?: string;
  containerPid?: string;
  /** per-spawn random token; written into the pidfile, re-checked on restore to detect pid reuse (§7.1) */
  nonce: string;
  /** true => docker: live source is container-internal; gateway mirrors into logFile + statusSnapshot */
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

**Every host process is persisted** — there is no non-persistent path. The POSIX wrapper and the
Node bg-runner helper (§4.1/§4.1.1) both write the durable host projection + status snapshot and a
full `bg-processes.json` record, so every process survives restart and re-attaches. There is **no**
`persistent` flag anywhere.

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

`BgProcessManager` currently has one global instance constructed in `server.ts`. Per-project
state dirs mean the manager must resolve the **right** store per session. Two options:

- **Chosen:** give `BgProcessManager` a `storeProvider: (sessionId) => BgProcessStore | undefined`
  callback (symmetric with the existing `clientsProvider`). The manager resolves the store from the
  session's `projectId` via `sessionManager.getSessionStore`'s sibling — add
  `SessionManager.getBgProcessStore(projectId?)` that returns `ProjectContext.bgProcessStore` (a
  new field on `ProjectContext`, constructed next to the other stores in
  the other stores in `project-context.ts`). For the test/no-PCM path, fall back to a single store over the test
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
and (debounced ~500ms) rewrites the **single durable combined projection** `<bgId>.log` — **always a
HOST file** — from that buffer, tagging each line `<ts>\t<stream>\t<text>` (§8). For docker the tailer
reads the **container** spools via `docker exec` and the gateway thereby **mirrors** the container
output into the host projection (§3.2).

```ts
export interface Tailer {
  /** Begin tailing from `startOffset`; calls onChunk for each new slice. */
  start(startOffset: number): void;
  stop(): void;
}
export interface TailerSpec {
  // the tailer watches the SPOOLS, never the projection. host spawns: host spool paths;
  // docker spawns: the container-internal containerOutSpool/containerErrSpool paths (via docker exec).
  outSpool: string; errSpool: string;
  inContainer: boolean; containerId?: string;
  onChunk: (stream: "stdout" | "stderr", text: string, newOffset: number) => void;
}
export type TailerFactory = (spec: TailerSpec) => { out: Tailer; err: Tailer };
```

- **Host (default factory):** `fs.watch` + read from offset, or a simple poll loop
  (`fs.read` from offset every ~200ms) for portability on Windows where `fs.watch` is flaky.
  **Chosen: poll loop** (200ms) reading `fs.statSync(spool).size`. Apply the **truncation
  detection / offset rebase** rule (§6.2) on every tick: if `size < offset` (the child-owned
  trimmer or a gateway copytruncate shrank the spool below the persisted offset) → **rebase the
  read offset to `0`** and read the current bounded spool from the start; else if `size > offset`
  → read the delta; else no-op. Split into lines, invoke `onChunk`, advance offset. Treat ENOENT as
  "not yet created". The same loop performs spool copytruncate when the spool exceeds the cap (§8),
  resetting its own offset to `0` after truncating.
- **Docker:** do **not** blindly launch `tail -c +<offset+1> -F` with a possibly-stale offset.
  First **probe the container spool size** — `docker exec <cid> wc -c < <containerOutSpool>` (or
  `stat`) — and apply the §6.2 rebase rule: if the probed size `< persistedOffset` (the
  in-container trimmer copytruncated the spool below the offset) → **normalize the offset to `0`**
  so the bounded current file is read from the beginning. Then launch the follower from the
  **normalized** offset: `docker exec <cid> tail -c +<normalizedOffset+1> -F <containerOutSpool>` /
  `<containerErrSpool>` (so a normalized `0` becomes `tail -c +1 -F`, i.e. the whole current file)
  and read its stdout pipe; `onChunk` advances offset by bytes received and the gateway **mirrors**
  the bytes into the HOST `<bgId>.log` projection. `stop()` kills the `tail` exec. The `-F` flag
  additionally keeps the follower attached across any *subsequent* in-container copytruncate. On
  restart this same probe-then-rebase-then-follow mechanism resumes correctly from the persisted
  (or normalized) offset — that **is** the re-attach.

### 6.2 Truncation detection / offset rebase (every tail tick + restore)

The persisted `outOffset`/`errOffset` are byte positions into the **spools**, but the spools are
copytruncated in place by the child-owned trimmer (POSIX wrapper or Node helper ring, §4.1/§4.1.1/§8)
and by the gateway's secondary copytruncate — **while the gateway is up OR down**. After a truncation
the spool shrinks, so a persisted offset can end up **greater than the current spool size**. A naive
"read only when `size > offset`" host poll, or a docker `tail -c +<offset+1> -F` launched with the
stale offset, would then **miss the retained tail** and stall — streaming nothing until the spool
organically grows back past the stale offset — breaking the "continues streaming after restart"
criterion.

**Rule (applied on every tail tick and once at restore, for BOTH host and docker):** before reading,
`stat`/`wc -c` the spool size. **If `size < persistedOffset` (or the spool's inode/identity changed),
treat the spool as having been copytruncated:**

1. **reset the read offset to `0`** and read the current bounded spool from the beginning (it is
   ≤ the cap by construction, §8);
2. feed those bytes through the normal projection/append path (`appendLog()` → capped `log[]` →
   atomic projection rewrite) — the in-memory cap + the projection's full-rewrite dedupe absorb any
   overlap with already-projected content (see the note below);
3. **persist the reset offset** (`store.update(outOffset/errOffset = newPosition)`);
4. continue tailing from the new position.

If `size == offset` → no-op; if `size > offset` → read the delta as normal.

> **Interaction with the projection (no duplication persisted).** The gateway rewrites the HOST
> projection `<bgId>.log` as a **full rewrite** (tmp + rename) from the capped in-memory `log[]`
> buffer — it never *appends* to the projection. So even though a rebased read from offset `0`
> re-feeds bytes that were already projected before the truncation, the in-memory cap trims the
> combined buffer to the last 512KB / 5000 lines and the subsequent full rewrite simply serialises
> that capped buffer. No duplicate lines are persisted to disk; at worst a small, already-seen tail
> is re-projected in memory and harmlessly re-broadcast (the pill's `_fetchedUpTo` dedupe absorbs
> it). This is why reading a rebased spool from the beginning is always safe.

The tailer feeds the existing in-memory `appendLog()` / `bg.stdout`/`bg.stderr` arrays (already
capped, interleaved into `log[]`) and the existing `bg_process_output` WS broadcast — so the API
(`getLogs`, `grep`, `head`, `slice`) and the pill work unchanged on the combined interleaved view —
and triggers the debounced atomic rewrite of the single combined durable projection (the HOST
`<bgId>.log`) from that capped buffer (§8). The only change to `create()` is that the chunk source is
the two spool tailers, not `child.stdout.on("data")`. Readers always consume the host combined
projection, never the spools.

### 6.1 Detecting exit via the status file

Independently of the tailer, a **status watcher** polls the status file (host: `fs.existsSync` +
read the host `<bgId>.status`; docker: `docker exec <cid> cat <containerStatus>` returning
non-empty). When the status file appears with content:

1. parse the integer exit code (trim; tolerate partial write — see §11, retry until a full integer
   line is present or a short grace timeout elapses);
2. set `status="exited"`, `exitCode=<n>`, `terminalReason="normal"`, `endTime=Date.now()`; for docker
   **mirror** the real exit code into the HOST `<bgId>.status` snapshot (atomic tmp+rename) so the
   outcome survives container removal;
3. do a **final tail flush** (read any remaining bytes of both spools past their offsets → capped
   `log[]` buffer → final atomic combined-projection rewrite) so no trailing output is lost and the
   `<bgId>.log` projection is current;
4. resolve `bg.exited`, persist (recovery-critical → sync), broadcast `bg_process_exited` (with
   `terminalReason`), stop the tailers and status watcher, then delete the now-consumed spool
   files (host spawns: unlink the host spools; docker: best-effort `docker exec <cid> rm -f` the
   container spools — the durable HOST combined projection + status snapshot are what survive, §8).

This **replaces** the current reliance on `child.on("exit")`. The child `exit` event (when we still
have a handle, i.e. while live) is used only as a *hint* to check the status file promptly rather
than waiting for the next poll; the **authoritative** exit code always comes from the status file,
never from `child.exitCode` (which, post-restart, we don't have).

## 7. Restore + re-attach reconciliation

Hook into boot right where sessions restore. Restore is **per-session**:
`BgProcessManager.restoreSession(sessionId)` is called from
`session-manager.ts::restoreSessions()` inside its existing per-session loop (after the live-restore
step) — at which point the session exists and (for sandboxed sessions) `session.containerId`
has been re-resolved via `SandboxManager.getContainerId()` (in `session-manager.ts`). Because
stores are per-project, `restoreSession(sessionId)` deterministically resolves *that* session's
store via `storeProvider(sessionId)` and iterates only that session's `PersistedBgProcess` records
— no cross-store enumeration is needed.

For each persisted record:

```
# the HOST combined projection <bgId>.log + HOST status snapshot <bgId>.status are ALWAYS read
# first — they survive container recreation/removal. The host projection is NEVER discarded.

if status == "exited" or "unrecoverable":
    rehydrate in-memory record; load tail of the HOST COMBINED projection <bgId>.log into
      log[]/stdout[]/stderr[] (parse <ts>\t<stream>\t<text>, last MAX_LOG_LINES/MAX_LOG_BYTES,
      interleaving preserved); broadcast nothing (client re-fetches via GET on reconnect). Done.

if status == "running":
    always load the HOST projection tail first   # output is retained regardless of the outcome below
    liveness = checkAlive(record)        # processPid/container probe + nonce re-check (§7.1)
    case ALIVE (nonce matches):
        # re-attach (host spawn, or docker whose container still resolves + wrapper alive)
        rehydrate record (status stays "running", terminalReason stays null)
        # (1) host projection tail ALREADY loaded above -> retained output shown immediately
        # (2) REBASE each spool offset per §6.2 BEFORE reading: stat/wc -c the spool size; if it is
        #     < persistedOffset (or inode/identity changed) the child-owned trimmer copytruncated it
        #     during downtime -> reset that offset to 0 and read the bounded current spool from the
        #     start (it is <= cap); else read the delta from persistedOffset.
        read bounded tail (last 512KB/5000 lines) of BOTH spools from the REBASED offsets -> capped
          log[] buffer -> rewrite HOST combined projection (full rewrite, so re-fed bytes after a
          rebase persist no duplicates — §6.2); persist the rebased offsets; then copytruncate both
          spools (§8) (docker: probe + rebase via docker exec wc -c, read the container spools,
          mirror into the HOST projection)
        start tailers from the rebased offsets -> resumes live streaming (no stall even if the spool
                                                was truncated below the old offset; docker: mirror to host)
        start status watcher                 -> captures eventual real exit code (-> terminalReason="normal",
                                                mirrored to the HOST status snapshot for docker)
    case COMPLETED_DURING_DOWNTIME:   # not alive, but a real exit code is available
        # status source: the HOST status snapshot if already mirrored; else, if the container is
        # still alive, docker exec cat <containerStatus> (then mirror to host); else host snapshot only
        read exitCode from the available status; final bounded tail -> HOST combined projection
        status="exited"; exitCode=<n>; terminalReason="normal"
        endTime = status mtime (best-effort) or Date.now()
        broadcast bg_process_exited{ exitCode, terminalReason:"normal" }
    case UNRECOVERABLE:               # not alive AND no real exit code anywhere (no host snapshot,
                                      #   container gone / no containerStatus, or pid reused)
        status="unrecoverable"; exitCode stays null; terminalReason="unrecoverable"
        # the HOST projection tail (already loaded) is RETAINED and shown — only the LIVE outcome
        # is unknown; NEVER discard the retained output, NEVER fabricate an exit code
        broadcast bg_process_exited{ exitCode:null, terminalReason:"unrecoverable" }
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
  in-container wrapper (the `processPid` read from the in-container pidfile `containerPid`, **not**
  `hostPid`/the dead docker-exec handle), **plus `docker exec <cid> cat <containerPid>` to re-check
  the nonce** exactly as the host path. If the container is gone, the in-container `/tmp` source
  files are gone too — **but the HOST projection + any mirrored HOST status snapshot survive** (§7.2):
  if a real exit code was already mirrored to the host snapshot it stays exited; if no status was
  ever mirrored, **unrecoverable** for the unknown live outcome (`terminalReason="unrecoverable"`),
  with the retained host output still shown.

### 7.2 Container recreated

Container recreation/removal (new or absent `containerId`) means the process and its
container-internal `/tmp` source files are gone — but the **host-owned projection `<bgId>.log` and
host status snapshot `<bgId>.status` survive**. Reconcile from the host files:

- The host projection tail is **always loaded and shown** — captured output is never lost to
  container churn (satisfies "output retained until dismissed").
- If a **terminal status was already mirrored** to the host snapshot before the restart → present
  that **real exit code** (`status="exited"`, `terminalReason="normal"`).
- Only if **no** status was ever mirrored **and** the container/process is gone → mark
  `status="unrecoverable"` (`terminalReason="unrecoverable"`, `exitCode=null`) for the **unknown live
  outcome** — but the retained host output is **still shown**. We never invent an exit code and never
  discard the retained output.

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
  (`>>`, §4; host spawns: host paths; docker spawns: container-internal `/tmp/bobbit-bg/...`). These
  are explicitly transient, **child-owned rings** bounded restart-independently (wrapper trimmer or
  Node helper ring) plus gateway copytruncate, *not* "the persisted log". Each spool is independently
  trimmed at ≤ 512KB; it may exceed that only transiently (between trim cycles) and is reclaimed
  (deleted) on exit. Spools are never read by clients.
- **Durable combined projection** (`<bgId>.log`) — a **HOST file the gateway owns exclusively** (for
  BOTH host and docker spawns; for docker the gateway mirrors the container spool bytes into it) and
  rewrites **atomically (tmp + rename)** from the single in-memory capped `log[]` buffer, tagging
  each line `<ts>\t<stream>\t<text>`. It is therefore **always ≤ 512KB / 5000 lines COMBINED across
  both streams**, fully consistent with the in-memory trim. Restore and every REST reader
  (`getLogs`/`grep`/`head`/`slice`) read this host combined projection, never the spools.

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

1. **Child-owned ring (primary, restart-independent).** The detached/orphaned child bounds each
   spool itself, independent of the gateway: on the POSIX path a **wrapper-owned trimmer** background
   loop (§4.1/§4.2) and on Windows-without-Git-Bash the **Node bg-runner helper ring** (§4.1.1). It
   trims each spool to the last `<KEEP>` = 512KB whenever it exceeds `MAX_LOG_BYTES`; the POSIX form
   is `tail -c <KEEP> "$f" > "$f.trim" && cat "$f.trim" > "$f"` (in-place same-inode copytruncate) and
   the Node helper does the equivalent in-place truncate. Because this runs in the **child, not the
   gateway**, it bounds each spool **at all times — during the normal run AND while the gateway is
   down.** This is what holds the "on-disk logs stay within caps at all times" requirement during a
   long outage.
2. **Gateway copytruncate (secondary).** When the gateway has consumed a spool up to its read offset
   **and** the spool exceeds `MAX_LOG_BYTES`, it also does `fs.truncateSync(spool, 0)` and resets its
   read offset to `0`. The next child write lands at offset 0 (POSIX `>>`/`O_APPEND`). This is a
   redundant bound that catches the brief windows between trimmer passes while the gateway is up; it
   is no longer the sole mechanism.

On the POSIX path the wrapper-owned trimmer bounds the spools; on the Windows-without-Git-Bash path
the **Node bg-runner helper's bounded ring** does the same (§4.1.1) — both are restart-independent
because they run in the detached child, not the gateway. Every host path therefore has a
restart-independent spool bound; there is no unbounded or non-persistent host path.

> **copytruncate race (acknowledged):** a few bytes written between a read/trim and the
> `cat "$f.trim" > "$f"` / `truncate(0)` can be lost. This is the standard logrotate copytruncate
> caveat and is **acceptable here** because the on-disk log is already an explicitly lossy last-N
> cap, not an audit log. Both the wrapper trimmer and the gateway use copytruncate (same inode,
> never `mv`/rename) so the command's append fd is never orphaned.
>
> **Belt-and-braces:** the child (wrapper trimmer or Node helper ring) bounds each spool
> independently of the gateway (even during downtime), the gateway re-bounds on consume, and the
> durable HOST combined projection is independently capped from the in-memory buffer — so neither
> the spools nor the durable log can grow without bound on any host platform (or docker).

### Downtime window

While the gateway is down, the **child-owned ring keeps each spool bounded** (≤ ~512KB) — the child
keeps appending but the wrapper trimmer (POSIX) or Node helper ring (Windows-without-Git-Bash) keeps
truncating, so the spools do **not** grow unbounded during an arbitrarily long outage. Only the
combined projection goes stale (nothing projects while the gateway is down). On `restoreSession()`
the gateway reads only the **bounded tail** (last 512KB / 5000 lines combined) of the spools to
rebuild the in-memory `log[]` buffer, immediately rewrites the HOST combined projection, **then
copytruncates both spools** as a secondary bound. So both the spools (child ring) and the durable
host projection (restore rewrite) are capped throughout.

There is no separate "post-exit trim" and no multi-megabyte "safety ceiling": the combined
projection is the durable artefact and is bounded at every instant by construction, and the spools
are bounded continuously by the child-owned ring.

## 9. Kill vs dismiss

Today both UI buttons issue the same `DELETE /api/sessions/:id/bg-processes/:pid`, and the route
(the `DELETE /api/sessions/:id/bg-processes/:pid` route in `server.ts`) "tries kill first, then remove". This conflates the two. Make them explicit.

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
  **delete the per-process files** — always the **HOST** combined projection `<bgId>.log` and HOST
  status snapshot `<bgId>.status`, plus (host spawns) the host spools + pidfile
  `.out.spool`/`.err.spool`/`.pid`; and (docker) the container-internal source files best-effort via
  `docker exec <cid> rm -f <containerOutSpool> <containerErrSpool> <containerStatus> <containerPid>`
  (they may already be gone with the container). Broadcast a new `bg_process_dismissed` WS event so
  other clients drop the pill. Returns `{ ok: true }`.

### 9.2 New manager methods

```ts
// bg-process-manager.ts
kill(sessionId, processId): boolean;                 // existing — keep; signals processPid; exit code from status file, else terminalReason="killed"
dismiss(sessionId, processId, opts?: { force?: boolean }): boolean;   // NEW: remove record + purge HOST projection+status snapshot (+host spools/pid; docker: best-effort container files)
restoreSession(sessionId): Promise<void>;            // NEW: §7 per-session reconciliation (called from restoreSessions loop)
```

**Kill mechanics** (signalling the right process pre- vs post-restart) — always target the persisted
`processPid`, never `hostPid`:
- **Host:** `taskkill /pid <processPid> /T /F` (Windows — covers both Git Bash and the Node bg-runner
  helper, whose `processPid` roots the child tree so `/T` takes the tree down) or
  `process.kill(-processPid, SIGTERM)` then `SIGKILL` (POSIX) against the persisted `processPid`
  (= `child.pid` on host). A live `child` handle, when one still exists (pre-restart), is used as an
  optimisation but is not required.
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
terminate, `cleanup()` in `session-manager.ts`) keeps killing running children but now also leaves durable
files in place only if the session is merely restarting — on real terminate it should
`removeForSession` + delete files (a terminated session's pills are gone).

### 9.3 WS protocol

The `bg_process_*` events in `src/server/ws/protocol.ts`:

- `bg_process_created` / `bg_process_output` — unchanged.
- `bg_process_exited` — gains `terminalReason: "normal" | "killed" | "unrecoverable"` as the
  **single authoritative field**. There is **no** standalone `unrecoverable?` boolean (dropped to
  avoid two overlapping fields). `exitCode` is `number | null` and is `null` for `"killed"`-without-
  status and `"unrecoverable"`.
- **NEW** `bg_process_dismissed` — `{ type: "bg_process_dismissed"; processId: string }`.

### 9.4 Client + UI

- `src/app/session-manager.ts`: `killBgProcess` → DELETE `?action=kill`; `dismissBgProcess` →
  DELETE `?action=dismiss`. Add a WS handler for `bg_process_dismissed` (in `src/app/session-manager.ts`) that removes the
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
  store.remove(); delete HOST <bgId>.log + HOST <bgId>.status (always)
                  host spawns: + <bgId>.out.spool,<bgId>.err.spool,<bgId>.pid
  docker: docker exec <cid> rm -f <containerOutSpool> <containerErrSpool> <containerStatus> <containerPid>  (best-effort)
  broadcast bg_process_dismissed -> all clients drop pill
record never reappears after subsequent restart (files + index entry gone)
```

### Docker deltas (Create / Live / Restore / Exit / Dismiss)
```
Create : wrapper writes spool/status/pid CONTAINER-INTERNAL (/tmp/bobbit-bg/...); host logFile+statusSnapshot allocated
         processPid resolved via docker exec cat <containerPid> (+nonce); HOST record persisted (sync)
Live   : tailers = docker exec tail -F <containerOutSpool>/<containerErrSpool> -> appendLog (combined capped)
         -> MIRROR bytes into HOST <bgId>.log projection (atomic rewrite); copytruncate handled by in-container ring
Exit   : statusWatcher = docker exec cat <containerStatus> -> parse real code
         -> MIRROR real exit code into HOST <bgId>.status snapshot (atomic) -> broadcast exited{code,normal}
Restore: HOST <bgId>.log projection ALWAYS loaded+shown (survives container churn)
         container resolves + wrapper alive (nonce match) -> re-attach (docker exec tail) + mirror
         container/process gone, HOST status mirrored      -> exited with REAL code
         container/process gone, NO status mirrored        -> unrecoverable (output still shown; no fabricated code)
Dismiss: delete HOST <bgId>.log + <bgId>.status; best-effort docker exec rm -f the container source files
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
  `exitCode=null` — never fabricated. (Every host path — POSIX wrapper or Node bg-runner helper —
  writes the nonce, so the guard applies uniformly.)
- **Log rotation racing the tailer.** The durable **combined projection** (`<bgId>.log`) is
  rewritten atomically (tmp + rename) by the gateway alone and the child never writes it, so readers
  never see a torn projection. The **spool** copytruncate (§8) may lose a few bytes between
  last-read and `truncate(0)` — the standard logrotate copytruncate caveat, acceptable because the
  log is already a lossy last-N cap. Each spool is bounded by a restart-independent ring in the
  detached child — the **wrapper-owned trimmer** on the POSIX path or the **Node bg-runner helper
  ring** on Windows-without-Git-Bash — plus the **gateway copytruncate** (secondary). Every host path
  writes a bounded spool; none is ever unbounded.
- **copytruncate offset rebase (no-stall guarantee).** Because the child-owned trimmer (and the
  gateway's secondary copytruncate) shrink the spool **while the gateway is up OR down**, a
  persisted `outOffset`/`errOffset` can become **greater than the current spool size**. A naive
  "read only when `size > offset`" host poll, or a docker `tail -c +<offset+1> -F` launched with the
  stale offset, would then **miss the retained tail and stall** — never streaming until the spool
  organically grew back past the stale offset — breaking the "continues streaming after restart"
  criterion. Mitigation (§6.2, applied on **every** host/docker tail tick **and** at restore):
  before reading, `stat`/`wc -c` the spool; if `size < persistedOffset` (or the inode/identity
  changed) **rebase the offset to `0`** and read the bounded current spool from the beginning
  (host: read-from-0; docker: probe with `wc -c` then launch `tail -c +1 -F`), persist the reset
  offset, then continue. The HOST projection is loaded first so the retained tail is shown
  immediately regardless; the full-rewrite projection (never append) means re-feeding already-seen
  bytes after a rebase persists **no duplicates**. Net guarantee: a copytruncate during downtime or
  mid-run can never stall the stream nor lose the retained tail.
- **Windows process-group kill.** `taskkill /pid <processPid> /T /F` kills the wrapper shell **and** its
  child tree (`/T`), so a force-killed host process **may not write a status file**. Handling:
  `kill()` records an intent-to-kill timestamp; the watcher, seeing the `processPid` gone with no
  status within a grace window **after an explicit kill**, marks `status="exited"`, `exitCode=null`,
  **`terminalReason="killed"`** — we *know* it was killed, which is not fabrication. This is
  distinct from the restart-loss case (`terminalReason="unrecoverable"`). If the wrapper *did* get
  to write the status file, `terminalReason="normal"` with the real code instead.
- **Docker container gone.** The container-internal `/tmp` source files vanish with the container,
  **but the HOST projection + HOST status snapshot survive**. The retained host output is always
  shown; if a real exit code was already mirrored to the host snapshot → exited with that code; else
  → unrecoverable for the unknown live outcome (output still shown). Never invent a code (§7.2).
- **Node bg-runner helper availability.** The helper ships with the gateway package and is resolved
  relative to the gateway module (`import.meta.url` / `__dirname`), so it is present after a restart
  regardless of cwd. Node itself is guaranteed (it is the gateway runtime, `process.execPath`). If
  the helper script is somehow missing, `create()` fails loudly rather than silently degrading to a
  non-persistent mode — there is no non-persistent host path.
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
export interface BgPaths { logFile; statusSnapshot; outSpool; errSpool; pidFile; containerOutSpool?; containerErrSpool?; containerStatus?; containerPid?; nonce; inContainer }  // logFile + statusSnapshot are HOST, always (BOTH host & docker)
export type SpawnFn = (command, cwd, containerId, paths: BgPaths) => ChildProcess;
export interface TailerSpec { outSpool; errSpool; inContainer; containerId?; onChunk }  // watches the SPOOLS (docker: container* paths)
export type TailerFactory = (spec: TailerSpec) => { out: Tailer; err: Tailer };
function buildHostWrapper(command, paths): string;   // POSIX wrapper only (Git Bash / /bin/sh); no cmd branch
function buildDockerWrapper(command, paths): string; // POSIX /bin/sh wrapper, spawned under setsid
// Node bg-runner helper (NEW): standalone script shipped with the gateway, spawned detached on a
// Windows host without Git Bash. Full persistence parity (bounded spool ring, nonce pidfile, real
// exit code to status). Entry e.g. src/server/agent/bg-runner.ts -> dist bg-runner.js; resolved via
// import.meta.url/__dirname so it survives restart.
function bgRunnerHelperPath(): string;               // resolve helper script relative to gateway module
// host-mechanism selection (in defaultSpawn): POSIX shell -> buildHostWrapper + spawn; cmd.exe
//   (no Git Bash) -> spawn(process.execPath, [bgRunnerHelperPath(), ...args]) detached+unref
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
// (no `persistent` flag — every host path is persistent + re-attachable: POSIX wrapper or Node helper)
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

> Two host mechanisms are both fully persistent: the **POSIX shell wrapper** (Git Bash on Windows,
> `/bin/sh` elsewhere/docker) and the **Node bg-runner helper** (Windows without Git Bash). Both are
> exercised via the injectable `SpawnFn` / fake child + fake files — no real OS processes. There is
> no non-persistent path to test.

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
- **Docker container recreated/removed — host projection retained:** persisted docker record whose
  container no longer resolves (or has a new `containerId`). `restoreSession()` **always** loads +
  shows the **HOST** `<bgId>.log` projection tail (output retained). If the **host status snapshot**
  was already mirrored → `status=exited` with the **real** exit code; if **no** status was ever
  mirrored → `status=unrecoverable`, `exitCode=null`, `terminalReason="unrecoverable"` **but the
  retained host output is still present** (assert the projection lines survive and **no** exit code
  is fabricated).
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
- **copytruncate offset rebase — restore + tail, no stall (§6.2):** with a fake spool file and a
  persisted `outOffset` **greater than** the current (child-trimmer-copytruncated) spool size,
  `restoreSession()` (and a subsequent live tail tick) must **rebase the offset to `0`**, read the
  **retained tail** of the bounded current spool from the beginning, and then stream **new** bytes
  appended afterward — assert no stall (the retained tail and the new bytes are both projected /
  broadcast) and that the persisted offset is reset to the new position. Cover **both** the host
  poll path (`size < offset` branch) and the docker path (fake `wc -c` smaller than the persisted
  offset → `tail -c +1 -F` launched from the normalized `0`). Assert the projection full-rewrite
  persists **no duplicate** lines despite re-feeding already-seen bytes from offset 0.
- **Wrapper builders (POSIX only):** `buildHostWrapper` and `buildDockerWrapper` produce the exact
  POSIX strings — pidfile (`printf '%s\n%s\n' "$$" "<nonce>"`), the wrapper-owned trimmer loop, the
  user command in an **isolated subshell** `( <command> )`, **append** (`>>`) to both spools, the
  trimmer stop (`kill "$trimmer"`), and `code=$? ; printf code > status ; exit code`; the docker
  builder is otherwise identical and is spawned under `setsid`. Assert there is **no** cmd branch and
  **no** `%errorlevel%`. String assertions — pure, fast.
- **Host-mechanism selection (wrapper vs Node helper):** with `getShellConfig()` returning a POSIX
  shell, `create()` builds the POSIX wrapper via `buildHostWrapper`; with cmd.exe (no Git Bash),
  `create()` spawns the **Node bg-runner helper** (`process.execPath` + resolved helper path,
  `detached:true`+`unref()`), **not** a non-persistent fallback. Both write a full
  `bg-processes.json` record + spool/status/pid and restore after a simulated restart. Drive via the
  injectable `SpawnFn`; assert the chosen argv (wrapper string vs helper script) and that **both**
  persist + re-attach.
- **Node bg-runner helper ring + exit capture (Node, fake child):** unit-test the helper's logic
  directly with a **fake injected child** (an EventEmitter, no real OS process): feed > cap bytes of
  stdout/stderr and assert each spool is trimmed to the last `<KEEP>` (bounded ring, in-place,
  restart-independent); emit an `exit` with code 7 and assert the helper writes `7` to the status
  file and `processPid`+`nonce` to the pidfile. No real processes.

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

6. **copytruncate + restart streaming (§6.2):** start a **chatty** long-runner that emits enough
   output to trigger the child-owned trimmer copytruncate (spool shrinks below the persisted
   offset), confirm the pill is streaming, **restart the spawned gateway**, and assert the pill is
   restored and **still streaming** afterward — i.e. the stale offset does not stall the stream
   (offset rebases to `0`, the retained tail shows, new lines keep arriving). (Docker variant noted
   for `test:manual` below.)

Keep `tests/e2e/bg-process-sandbox-guard.spec.ts` green (the `sandboxed && !containerId` guard is
unchanged). Docker re-attach — including the **copytruncate offset rebase after restart** (a chatty
in-container process whose spool the in-container trimmer copytruncated, then a gateway restart still
resumes streaming via probe + `tail -c +1 -F` from the normalized offset) — is covered by
`test:manual` (extend `sandbox-recovery-docker.spec.ts`).

### Commands

`npm run check`, `npm run test:unit`, `npm run test:e2e`, and (session-lifecycle/restart/sandbox)
`npm run test:manual` per AGENTS.md.

## 14. Implementation order (suggested)

1. `BgProcessStore` + `PersistedBgProcess` (copy `SessionStore` helpers) + unit round-trip test.
2. `BgPaths`, POSIX wrapper builders (isolated subshell `( <command> )` so `exit N` is contained;
   wrapper-owned trimmer bounding both spools; `>>` append; `code=$?` status write;
   `processPid`+nonce pidfile; docker spawned under `setsid`), the **Node bg-runner helper** (bounded
   spool ring, nonce pidfile, real exit code to status; detached+unref) selected when Git Bash is
   absent on Windows, change `defaultSpawn` + `create()` to redirect output to the **spools**,
   perform the **required post-spawn pidfile read** to resolve `processPid` (sync flush), and feed
   the combined capped buffer + single durable **HOST** combined projection from a `Tailer` (default
   poll tailer; docker tailer mirrors into the host projection); status watcher for exit (docker
   mirrors the real code into the host status snapshot).
3. `restoreSession(sessionId)` reconciliation (alive / completed / pid-reused / lost) + wire into
   the `restoreSessions()` per-session loop; `ProjectContext.bgProcessStore`.
4. `dismiss()` + split DELETE route + `bg_process_dismissed` WS event + `terminalReason`
   (`normal`/`killed`/`unrecoverable`) plumbing through protocol/client/pill; Docker kill via
   persisted in-container group leader (`docker exec kill -TERM/-KILL -<processPid>`).
5. Disk caps: continuous **HOST** combined-projection rewrite (≤512KB/5000 lines combined; mirrored
   for docker) + child-owned spool ring (POSIX wrapper trimmer or Node helper ring,
   restart-independent) + gateway copytruncate (secondary); no post-exit trim, no unbounded spool,
   every host path persistent.
6. Tests: unit persistence/re-attach/dismiss/caps; browser E2E; keep guard test green; `check`.
