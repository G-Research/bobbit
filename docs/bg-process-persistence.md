# Persistent + re-attachable `bash_bg` background processes

`bash_bg` background processes now **survive a gateway restart**. A process that
was running when the gateway went down keeps streaming live output afterward and
its real exit code is captured — as if the server never restarted. A process
that finished while the gateway was down comes back showing its real exit code
and full captured output.

This page explains the behaviour and the reasoning. For the full architectural
record (every edge case, the exact wrapper scripts, the test matrix) see the
design doc: [docs/design/persistent-bg-processes.md](design/persistent-bg-processes.md).
Implementation: `src/server/agent/bg-process-manager.ts`,
`bg-process-store.ts`, `bg-runner.ts`; client/UI in `src/app/session-manager.ts`
and `src/ui/components/BgProcessPill.ts`.

## Why this exists

Before this rework `BgProcessManager` was **in-memory only** — a
`Map<sessionId, Map<bgId, BgProcess>>` holding a live `ChildProcess` handle and
captured output arrays. A gateway restart lost every process record, all
captured output, and the live handle. Two failure modes followed, and neither
was recoverable by simply persisting the record:

- **Host spawns** were detached (`detached: true` + `unref()`), so the process
  kept running as an orphan after the gateway exited — but its stdout/stderr
  pipes were owned by the dead parent and **cannot be re-attached** from a new
  process. The restarted gateway had no idea it existed.
- **Docker-exec spawns** kept running inside the still-alive container, but the
  host-side `docker exec` handle died with the gateway, so output streaming and
  exit capture stopped.

You cannot re-attach to a dead parent's pipes. The fix is therefore not just
"persist the record" — it is a change to **where output and exit status live**:
on disk, in durable files the running process keeps writing to even while the
gateway is down.

## How it works (high level)

Each process gets a set of durable per-process files under the project state dir
(`<stateDir>/bg-processes/`, the same dir `SessionStore` writes `sessions.json`
into — so per-project isolation and the isolated test state dir are inherited):

```
<stateDir>/
  bg-processes.json                 # metadata index (BgProcessStore; atomic write + 5 backups + epoch guard)
  bg-processes.json.bak.1 .. .bak.5
  bg-processes/<sessionId>/
    <bgId>.log                      # DURABLE COMBINED projection — HOST file, gateway-owned, always ≤ caps
    <bgId>.status                   # terminal status snapshot (real exit code) — HOST file
    <bgId>.out.spool                # transient stdout spool (host spawns)   — child appends, bounded ring
    <bgId>.err.spool                # transient stderr spool (host spawns)   — child appends, bounded ring
    <bgId>.pid                      # processPid + per-spawn nonce (host spawns)
```

The moving parts:

- **Transient per-stream spools** (`<bgId>.out.spool` / `<bgId>.err.spool`) — the
  child appends raw stdout/stderr here. They are explicitly transient, bounded
  rings, *not* the persisted log. For docker the spools live container-internal
  under `/tmp/bobbit-bg/<sessionId>/...` and are read via `docker exec`.
- **Durable combined projection** (`<bgId>.log`) — a **HOST file the gateway owns
  exclusively** (for both host and docker spawns). The gateway tails the spools,
  interleaves stdout/stderr by arrival into the capped in-memory `log[]` buffer,
  and continuously rewrites this single combined file atomically (tmp + rename).
  Each line is tagged `<ts>\t<stream>\t<text>` so restore rebuilds the exact
  interleaving. This is the **authoritative retained log** — every REST reader
  (`getLogs`/`grep`/`head`/`slice`) and restore read it, never the raw spools.
  Because it is rewritten from the already-capped buffer, it is bounded at every
  instant (see [Bounded on-disk growth](#bounded-on-disk-growth)).
- **Status snapshot** (`<bgId>.status`) — the real exit code. On host spawns the
  wrapper/helper writes it directly; for docker the gateway mirrors the
  container-internal status into this host file so the outcome survives the
  container being recreated/removed.
- **`BgProcessStore`** (`bg-process-store.ts`) — the metadata index, persisted to
  `bg-processes.json`. It mirrors `SessionStore` verbatim: atomic
  tmp+fsync+rename writes, 5-deep backup rotation, the version-2
  `{ version, epoch, processes }` envelope, and the epoch stale-snapshot guard.
  Recovery-critical fields (`status`/`exitCode`/`terminalReason`/`endTime`/
  `processPid`) flush synchronously; high-frequency offset advances are
  debounced. One store per project, hung off `ProjectContext.bgProcessStore` and
  resolved via `SessionManager.getBgProcessStore(projectId)`.
- **Restore** is per-session: `BgProcessManager.restoreSession(sessionId)` is
  called from `SessionManager.restoreSession()` (inside the boot-time
  `restoreSessions()` loop) right after the session's `containerId` has been
  re-resolved, so liveness/re-attach can target the live process.

### Capturing the real exit code

A user command can call `exit N` itself, so the wrapper runs the command in an
**isolated subshell** — `( <command> ) ; code=$? ; ... ; printf '%s\n' "$code" >
<status>`. The `exit N` only exits the subshell; the wrapper still records the
real `code=$?`. This is why a command that exits non-zero (or `exit 0`) is
reported as a **normal** exit with the real code, never as killed/unrecoverable.

### Spawn mechanisms

The manager picks the spawn mechanism at create time. All three write the same
durable files (spools + status + pidfile-with-nonce) and are fully persistent +
re-attachable — there is no non-persistent host path:

- **POSIX shell wrapper (primary)** — Git Bash on Windows, `/bin/sh` on
  Linux/macOS, and `/bin/sh` inside docker. A single `sh -c` string that writes
  the pidfile (a **Windows-usable pid** + nonce — see below), launches a
  wrapper-owned background trimmer that bounds both spools, runs the isolated
  subshell appending (`>>`) to the spools, then writes the real exit code to the
  status file. Built by `buildHostWrapper` / `buildDockerWrapper`.

  **Windows-usable pid in the pidfile.** The pidfile's pid line is
  `$(cat /proc/$$/winpid 2>/dev/null || echo $$)`, not bare `$$`. On MSYS / Git
  Bash `$$` is the **MSYS-internal** pid, which is *not* a Windows pid the
  gateway can signal (empirically `$$`=1105 while `/proc/$$/winpid`=17172 for the
  same shell); `/proc/$$/winpid` yields the real Windows pid. Off Windows
  (Linux/macOS) `/proc/$$/winpid` does not exist, so `cat` fails and the line
  falls back to `$$` — which already *is* the real pid there, making the pidfile
  content byte-for-byte identical off-Windows (no behaviour change). This matters
  because the host restore path reconciles `processPid` from this pidfile (see
  [`processPid` vs `hostPid`](#processpid-vs-hostpid)) so liveness checks and
  kills target the signalable pid.
- **Node `bg-runner` helper (Windows without Git Bash)** — `bg-runner.ts`, spawned
  detached via `process.execPath`. On a Windows host with no Git for Windows,
  `cmd.exe` can't run the POSIX wrapper, so rather than degrade to a
  non-persistent mode the manager runs this helper. It gives **full persistence
  parity**: appends child stdout/stderr to the spools with a bounded ring,
  writes `processPid` (its own pid, which roots the child tree) + the nonce to
  the pidfile, and writes the real child exit code to the status file on the
  child's `exit`. The gateway re-attaches to it identically — the path is
  indistinguishable downstream. The helper script is resolved relative to the
  gateway module (`import.meta.url`) so it is present after a restart regardless
  of cwd.
- **Docker (`setsid`)** — the POSIX wrapper run inside the container via
  `docker exec ... setsid /bin/sh -c '<wrapper>'`. `setsid` makes the in-container
  wrapper pid the **process-group leader**, so a kill can take down the whole
  command tree with a negative pid (`docker exec <cid> kill -TERM -<processPid>`),
  not just the wrapper shell. The gateway tails the container spools via
  `docker exec tail -F` and **mirrors** the bytes into the host combined
  projection, and mirrors the container status into the host status snapshot — so
  the captured output and outcome survive container recreation/removal.

### `processPid` vs `hostPid`

Two pids are persisted because they differ for docker:

- **`hostPid`** — the host-side `child.pid`. For docker this is the `docker exec`
  handle, valid only while the original gateway lives; **never** used for
  liveness or kill after a restart.
- **`processPid`** — the signalable wrapper pid in its own namespace. For docker
  it is the in-container wrapper pid, read back from the pidfile after spawn (via
  `docker exec cat <containerPid>`). On host the spawn-time value is `child.pid`
  (the top-level wrapper pid), but **on restore the host path re-reads the
  pidfile and adopts the pid the wrapper published** — see below. Liveness checks
  and kills always target `processPid`. It is `0` until resolved (docker resolves
  it synchronously at create time with a bounded retry, and again on restore if
  needed).

**Host `processPid` reconciliation (Windows + Git Bash).** On Windows the
spawn-time `child.pid` is the OS pid of the top-level `bash.exe`, which can
*differ* from the Windows pid the wrapper publishes via `/proc/$$/winpid` (the
wrapper resolves its own winpid from inside MSYS). So `restoreSession` reconciles
the host `processPid` the same way the docker path does: for a non-container
record it re-reads the nonce-checked pidfile **before** the liveness check, and
if the pidfile pid is valid, its nonce matches the record, and it differs from
the persisted `processPid`, it adopts the pidfile pid (and persists it). This
runs before `isHostPidAlive` / `taskkill` so both target the correct signalable
pid. On Linux/macOS the pidfile pid equals `child.pid`, so the reconciliation is
a no-op. The nonce pid-reuse guard is unchanged — a *mismatched* nonce is never
adopted (it still resolves to unrecoverable/killed) and no pid is ever
fabricated.

## Restore reconciliation — the three cases

On restore, for each persisted record the gateway **always loads the host
combined projection first** (captured output is shown regardless of outcome),
then for a `running` record reconciles liveness:

1. **Alive → re-attach.** The process group is still alive and the pidfile nonce
   matches the persisted nonce. The gateway resumes tailing the spools from the
   persisted (or rebased) offsets, so live output keeps streaming, and restarts
   the status watcher so the eventual **real exit code** is captured. From the
   user's perspective the pill keeps streaming as if nothing happened. If a kill
   had been requested before the restart and the process is still alive, the
   kill is re-issued (escalation re-armed).
2. **Completed during downtime → read the real exit code.** Not alive, but a
   status file is present with a real exit code. The gateway reads it, does a
   final flush of remaining spool bytes into the projection, and presents an
   exited pill with `terminalReason="normal"` and the real code.
3. **Unrecoverable → labelled terminal state, never a fabricated exit code.**
   The process is genuinely gone with no recoverable outcome: pid gone with no
   status file; or the live pid's nonce **mismatches** (pid reuse); or the docker
   container was recreated/removed with no mirrored status. The record becomes
   `status="unrecoverable"`, `exitCode=null`, `terminalReason="unrecoverable"`.
   The retained host output is **still shown** — only the live *outcome* is
   unknown. The gateway never invents an exit code.

A terminal record (`exited` / `unrecoverable`) found on restore is simply
rehydrated from the projection tail; the client re-fetches via `GET` on
reconnect.

**Pid-reuse guard (nonce).** A status file is authoritative — a reused pid can't
un-write it, so its presence means the process finished. When there is no status
file and the persisted `processPid` is alive, the gateway re-reads the pidfile
and compares its per-spawn `nonce` against the record. Match → genuinely our
process → re-attach. Missing/mismatched nonce → the live pid is foreign
(reused) → unrecoverable. This is why every spawn mechanism writes a nonce.

### Dev restart harness must not tree-kill (Windows)

Re-attach only works if the detached bg children **outlive the gateway** across
a restart. The dev restart harness (`src/server/harness.ts`) used to force-kill
the gateway on Windows with `taskkill /pid <pid> /T /F`. The `/T` walks the
gateway's child-process tree by parent→child pid linkage and kills *every*
descendant — including the detached `bash.exe` wrappers running `bash_bg`
commands. On Windows `detached: true` only creates a new process *group*; it does
**not** sever the parent-pid linkage, so `/T` still found and euthanized those
wrappers, and `/F` denied them the chance to flush their `.status`. The next
boot then found a dead `processPid` and no status snapshot, so restore correctly
classified the record `unrecoverable` — the persistence layer reporting the
truth while the harness quietly killed the children it was meant to let survive.

The fix lives in `src/server/harness-kill.ts`: `windowsGatewayKillArgs(pid)`
returns `taskkill /pid <pid> /F` — **no `/T`**. Force-killing only the gateway
process still reliably frees the port, while the detached + unref'd wrappers
survive, keep writing their spools while the gateway is down, and write
`.status` on natural exit — so restore re-attaches a still-running process or
reads the real exit code of one that finished during downtime. This was a
harness-local defect: a normal (non-harness) gateway shutdown already let bg
children survive, because it does not tree-kill.

## Kill vs dismiss

These were historically the same DELETE; they are now explicit, disambiguated by
a query param. The two actions are deliberately distinct:

| Action | REST | Effect | Survives restart? |
|---|---|---|---|
| **Kill** | `DELETE …/bg-processes/:pid?action=kill` | Terminate the running process (whole tree / process group), then keep the now-terminal record until dismissed | Yes — `killRequested` is persisted, so a re-attached process is re-killed and a dead-with-no-status process resolves to `killed`, not `unrecoverable` |
| **Dismiss** | `DELETE …/bg-processes/:pid?action=dismiss` | Remove the record **and delete the persisted files** (projection, status, spools, pidfile; docker source files best-effort), then emit `bg_process_dismissed` | n/a — the record and files are gone, so it never reappears |
| *(legacy)* | `DELETE …/bg-processes/:pid` | kill-if-running else dismiss | — |

`action=kill` returns `{ ok: true, killed: true }` (404 if not found/not
running). `action=dismiss` returns `{ ok: true }`, or **409** if the process is
still running — there is no force option. The required sequence for a running
process is **kill first, then dismiss** the resulting terminal record.

**Kill mechanics** always target the persisted `processPid` (never the dead
`hostPid`): on host, `taskkill /pid <processPid> /T /F` (Windows) or
`process.kill(-processPid, SIGTERM→SIGKILL)` (POSIX); for docker,
`docker exec <cid> kill -TERM/-KILL -<processPid>` against the `setsid` group
leader, so the wrapper, the subshell, and any grandchildren all die. A graceful
SIGTERM that lets the wrapper write `$?` yields `terminalReason="normal"` with
the real code; a hard kill before the status write yields
`terminalReason="killed"` with `exitCode=null` (a *known* kill, not a
fabrication — distinct from `unrecoverable`).

### Pill states

`BgProcessPill` renders the terminal state from `terminalReason` (the single
authoritative field):

- **`exit N`** (green for `0`, red otherwise) — `terminalReason="normal"`, real code.
- **`killed`** — `terminalReason="killed"`, `exitCode` null.
- **`exit status unknown`** (amber, title "Process was lost across a restart") —
  `terminalReason="unrecoverable"`, `exitCode` null, output still retained.

The **Kill** button shows only for `running` pills; **Remove** (dismiss) shows for
all terminal states. The client sends `?action=kill` / `?action=dismiss`
accordingly and drops the pill on `bg_process_dismissed`.

## Bounded on-disk growth

The durable log must stay within `MAX_LOG_LINES` (5000) / `MAX_LOG_BYTES`
(512KB) **combined across stdout+stderr**, at all times — while running, across
a restart, and after exit — matching the in-memory per-process cap. Three
independent mechanisms guarantee this:

- **Combined projection** — rewritten as a full atomic rewrite from the already-
  capped in-memory `log[]` buffer, so it can never exceed the per-process cap,
  even mid-run. The serialised line size (`<ts>\t<stream>\t<text>\n`, counted in
  bytes via `Buffer.byteLength` so multibyte output can't blow the byte cap) is
  what the cap is measured against.
- **Child-owned spool ring (restart-independent)** — the POSIX wrapper's
  background trimmer (and the Node helper's bounded ring) run *in the detached
  child*, so they keep each spool bounded to ~512KB even **while the gateway is
  down**. They copytruncate in place (same inode, `tail -c <keep> > f.trim && cat
  f.trim > f` — never `mv`/rename) so the command's `>>` (`O_APPEND`) keeps
  landing at EOF. A final synchronous trim on exit guarantees the spool is
  bounded the instant the command finishes (a fast chatty burst can outrun the
  periodic trimmer).
- **Gateway copytruncate (secondary)** — once the gateway has consumed a spool up
  to its offset and the spool exceeds the cap, it truncates it to 0 and resets
  its offset.

**Bounded reads.** Every spool read (live tail tick, restore, final flush) caps
its allocation at `MAX_LOG_BYTES` — a high-volume burst (e.g. a sandboxed command
trying to DoS the host) can never make the gateway allocate an unbounded buffer.

**Copytruncate offset rebase (no-stall guarantee).** Because the spool is
copytruncated in place while the gateway is up *or* down, a persisted read offset
can end up larger than the current spool size. A naive "read only when size >
offset" would then miss the retained tail and stall the stream. So on every tail
tick and once at restore, the gateway checks the spool size; if it dropped below
the offset (copytruncated) it **rebases the offset to 0** and reads the bounded
current spool from the start. The projection is a full rewrite from the capped
buffer, so re-feeding already-seen bytes persists **no duplicates**. This is what
keeps a chatty process streaming continuously across a restart.

## Sandbox / docker parity

Sandboxed sessions keep running inside their container across a restart. The
`sandboxed && !containerId` host-execution guard in `create()` is preserved — a
sandboxed session without a resolved container refuses host-side execution rather
than leaking the command onto the host.

For docker the live source (spools, status, pidfile) is container-internal, but
the **authoritative retained log and status snapshot are host files** the gateway
mirrors into. Losing the container (recreation/removal) therefore loses only the
*live source* — never the already-captured output or an already-mirrored exit
code. Re-attach, liveness, and kill all go through `docker exec` against the
in-container `processPid`; the dead `hostPid` (docker-exec handle) is never used
after a restart.

## Related

- [docs/design/persistent-bg-processes.md](design/persistent-bg-processes.md) — full design record (wrapper scripts, every edge case, test matrix).
- [docs/internals.md — Background process runtime snapshots](internals.md#background-process-runtime-snapshots) — `endTime`/runtime contract for the pill.
- [docs/internals.md — Steer-interruptible bash_bg wait](internals.md#steer-interruptible-bash_bg-wait) — the `wait` long-poll + abort registry (orthogonal to persistence).
- [docs/rest-api.md — Background processes](rest-api.md#background-processes) — REST surface.
