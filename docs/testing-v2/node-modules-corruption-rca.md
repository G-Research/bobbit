# RCA: primary `node_modules` half-wipe (general / dev-time)

> **Scope.** This doc has **two** parts:
> 1. **The general / dev-time half-wipe** (§1–§12) — the primary checkout's
>    `node_modules` intermittently gets half-wiped while the dev stack is live, bricking
>    every direct host-side agent and verification spawn. Sections §1–§10 record the
>    confirmed experiments and refined RCA from the original investigation.
> 2. **The distinct chaos.mjs test-only vector** (§13) — fixed by PR #956
>    (`goal/fix-chaos-node-10b9c9aa`). Preserved verbatim below. **It is a DIFFERENT
>    mechanism and must NOT be reverted or weakened.**
>
> **Implementation status.** Automatic dependency healing and the direct-spawn runtime
> ring-fence are retired. The harness now validates dependencies without writes or
> subprocesses before build/launch, leaving repair to the operator. Direct host spawns use
> Bobbit's installed Pi package through Node's normal resolution semantics. The old recursive
> snapshot traversal was the NFS startup-hang mechanism; ordinary `npm install` was not.
> Legacy `<stateDir>/runtime` snapshots and partial trees are never probed and are removable
> manually only while Bobbit is fully stopped. Sections §11–§12 describe the current policy
> and its focused regression coverage. The chaos.mjs vector in §13 remains a distinct,
> already-fixed mechanism.

---

## 1. TL;DR (symptom vs. confirmed cause)

**Symptom.** Mid-session the gateway starts logging
`ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/pi-ai'` (or another core
runtime dep) even though `package.json` still declares it. From that instant, **every
new agent and every verification spawn fails server-wide** on the direct (non-Docker)
spawn path. The tree is *half*-wiped: some packages present, core runtime packages gone.

**Confirmed cause (refined from the pre-investigation hypothesis).** The half-wipe is
produced by a **destructive or interrupted npm reify against the primary tree while the
dev stack holds native `.node` files locked** — specifically:

- a **destructive** op (`npm ci`, `npm install --force`, `npm audit fix --force`) that
  **bulk-removes / prunes** the tree, then either aborts on a locked native file or is
  **interrupted mid-reify** (crash / resource exhaustion), leaving the tree
  half-populated; **or**
- more rarely, a plain `npm install` that must **re-extract a version-drifted package**
  whose native file is locked — but modern npm (10+/11) **rolls this back cleanly**
  (see §5, experiment F), so the graceful case does *not* half-wipe.

**What the investigation DISPROVED** (do not repeat these claims):

- ❌ "Plain `npm install` under `package-lock=false` recomputes the ideal tree and
  **prunes extraneous** packages." — **False** on npm 11.8.0 (experiments A, B).
- ❌ "The former `ensureDeps()` self-heal `npm install` was the **prime trigger** of new
  half-wipes." — **Downgraded.** Its `npm install` was *additive* and did **not** prune;
  in the actual repair scenario (some deps missing) it added the missing packages and
  left healthy ones untouched (experiment D). It was the **repair**, not the primary
  trigger. The path is now retired by operator-ownership policy; its historical residual
  risks are recorded in §8.
- ❌ "npm unlinks the other packages first, then aborts with EPERM on the locked file,
  leaving a half-wiped tree." — **Not how modern npm behaves on a graceful lock error**:
  it retires-then-rolls-back and leaves the tree intact (experiment F). The half-wipe
  needs the reify to be **destructive** (npm ci / prune) **or interrupted** (experiment H).

The gateway remains exposed to an installed-runtime half-wipe because automatic direct host
spawns resolve Bobbit's installed Pi package in place. The current harness reduces startup
risk by validating declared dependencies before build or launch; it does not create a second
runtime tree or conceal a damaged installation.

---

## 2. The runtime-dependency exposure (direct-spawn path)

The running gateway resolves the pi-coding-agent runtime from **its own install** for
**every** automatic direct (non-sandbox) agent and verification spawn. The direct-host
runtime resolver delegates package lookup to `import.meta.resolve`, converts the resolved
entry URL to a filesystem path, and derives the package's `node_modules` root and `dist/cli.js`.
This preserves Node's package and subpath semantics. An explicit `--agent-cli` / `cliPath`
override takes precedence and does not invoke automatic resolution.

If the installed tree loses `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, or a
transitive dependency, package resolution or the spawned CLI's imports fail. A missing Pi
package produces actionable guidance to install it or pass `--agent-cli /path/to/cli.js`.
Because automatic resolution uses the shared installed tree in place, a half-wipe can brick
all direct spawns at once. It never consults `<stateDir>/runtime`.

### The Docker path is NOT exposed

The Docker sandbox path does **not** mount the host `node_modules`. Its Pi runtime and CLI
are baked into the image, so a half-wiped host tree cannot break sandboxed spawns. The
Docker behavior is unchanged; the live gateway-bricking exposure is exclusively the
direct-spawn path.

---

## 3. Historical automatic writer (now retired)

At the time of the experiments, `ensureDeps()` ran on harness boot and restart. It checked
declared package-manifest presence and invoked plain `npm install` only after dependencies
were already missing. This is important to the RCA: experiment D confirmed that invocation
was additive repair, not the NFS hang or the primary cause of a fresh half-wipe.

That writer has been removed. The harness now performs pure, read-only validation of
`dependencies` and `devDependencies`; `optionalDependencies` remain optional. It fails an
unreadable, malformed, or structurally invalid root `package.json`. Validation neither
writes to the filesystem nor spawns a subprocess or package manager. Initial boot,
sentinel restart, and automatic crash relaunch all validate before any applicable build or
launch step.

---

## 4. `.npmrc` invariant (must be preserved)

`.npmrc` sets `shrinkwrap=false`. On npm ≥ 10 that maps to `package-lock=false` — confirmed
live: every npm invocation in the experiments emitted
`npm warn config shrinkwrap Use the --package-lock setting instead.`, and no
`package-lock.json` was written after `npm install` (experiment A). This **freezes the
committed lockfile during routine installs**, preventing an incidental `npm install` from
regenerating it from dependency-owned shrinkwraps. The `ws@8.20.1` and
`protobufjs@7.5.9` versions cited in the original experiment are historical context, not a
claim about the current dependency tree.

Preserve this routine-install protection. Intentional dependency updates may regenerate the
lock only through the repository's current controlled `.npmrc` procedure, including restoring
`.npmrc` before verification and proving an ordinary install leaves the lock unchanged. See
[Pi runtime compatibility — Lockfile invariant](../pi-runtime-compatibility.md#lockfile-invariant)
for the current procedure and consumer-tree rationale.

---

## 5. Experiments & evidence

Environment: **npm 11.8.0, node v24.13.1**, Windows. All experiments ran in isolated
`os.tmpdir()/nm-rca-*` dirs (never the real primary tree or `.bobbit/`), each with a local
`.npmrc` containing `shrinkwrap=false` to mirror production. Temp dirs cleaned up after.

| # | Setup | Command | Observed | Conclusion |
|---|---|---|---|---|
| **A** | declare `is-number`; install; plant an **extraneous** top-level pkg | `npm install` | `up to date`; extraneous **PRESENT** | plain install does **not** prune extraneous |
| **B** | install `is-odd` (pulls transitive `is-number`); then empty `dependencies` | `npm install` | `up to date`; both `is-odd` + `is-number` **PRESENT** | plain install does **not** prune orphaned deps |
| **C** | install `is-number@7`; overwrite on-disk to fake `v6` + `SENTINEL.txt` | `npm install` | `changed 1 package`; on-disk now `7.0.0`; **SENTINEL gone** | plain install **re-extracts** a version-drifted pkg (retire-rename) |
| **D** | install `is-number@7` + `is-odd`; `rm -rf` `is-number` (simulate half-wipe); mark `is-odd` | `npm install` | `added 1 package`; `is-number` **RESTORED**; `is-odd` sentinel **survived** | the **historical ensureDeps repair scenario** was additive and left healthy packages untouched |
| **E** | install with lockfile; plant extraneous pkg | `npm ci` | extraneous **PRUNED** | `npm ci` is destructive (wipe + prune) |
| **F** | force `is-number` rewrite (v6→v7) while an **exclusive no-share Windows handle** is held on `is-number/locked.node` | `npm install` | `npm error code EBUSY … syscall rename … errno -4082` on `locked.node`; **`is-number` fully intact at v6, `is-odd` intact** | modern npm reify **retires-then-rolls-back**; a locked file → **clean rollback, NO half-wipe** |
| **H** | install 120-pkg tree with lockfile; tight 10 ms Node poll of top-level count during `npm ci` | `npm ci` | count dipped **120 → 2** then back to 120 | `npm ci` **bulk-removes first**; an interrupt in that window = **half-wipe** |

Key raw evidence for **F** (the EPERM/EBUSY-mid-reify test — the crux the hypothesis got
wrong):

```
npm error code EBUSY
npm error syscall rename
npm error path    …\node_modules\is-number\locked.node
npm error dest    …\node_modules\.is-number-8nvWEOAZ\locked.node
npm error errno -4082
```

npm's reify **retires** the existing package by renaming it into a hidden
`.<name>-<hash>` sidecar *before* extracting the replacement. The locked native file made
the retire-rename fail with `EBUSY`, and npm **rolled the whole operation back** — the
package dir was left complete and unchanged (`LICENSE README.md index.js index.js.bak
locked.node package.json`, still `v6`), and the unrelated `is-odd` was untouched. So on a
**graceful** lock error the tree is **not** half-wiped.

Key raw evidence for **H** (the real half-wipe mechanism):

```
steady-state top-level pkgs: 120
MIN observed during npm ci:  2
dipped below steady? YES — bulk-remove window confirmed
```

`npm ci` empties `node_modules` down to a near-empty state and refills it. Kill the process
(crash, `SIGKILL`, resource exhaustion, box OOM) anywhere in that ~1–2 s window and the tree
is left with as few as 2 packages — a textbook half-wipe. This matches the field incident
recorded in `docs/testing-v2/LEAD-STATE.md` (2026-07-08): a heavy `e2e:v2` run exhausted the
box and **interrupted an `npm ci` mid-op → gutted `.bin`**.

---

## 6. Confirmed cause (refined)

A primary-tree half-wipe requires a **destructive-or-interrupted reify against the primary
tree**, i.e. one of:

1. **Human/agent destructive op in the primary checkout while the stack is live** —
   `npm ci`, `npm install --force`, or `npm audit fix --force`. These **prune/bulk-remove**
   (experiment E) and either (a) abort on a locked native file mid-rewrite, or (b) are
   **interrupted mid-reify** (experiment H). Either leaves a half-wiped tree.
2. **Any npm reify interrupted mid-flight** (crash, `restart-server` kill, box resource
   exhaustion) during its bulk-remove/retire window (experiment H). This is the dominant
   field-observed mechanism.

A plain, uninterrupted `npm install` on a **healthy** tree does **not** half-wipe it
(experiments A, B: no prune) and **rolls back** on a locked-file rewrite (experiment F).
The former automatic `ensureDeps` install was therefore not a primary trigger of new
half-wipes. It has since been removed as an operator-ownership decision, not because the
experiments implicated it as the NFS hang or primary half-wipe cause.

---

## 7. Ruled-in / ruled-out triggers

**Ruled IN (primary tree):**
- Human/agent running `npm ci` / `npm install --force` / `npm audit fix --force` in the
  primary checkout while `npm run dev:harness` / vite is live. (The `release` skill
  explicitly warns never to do this in the primary worktree, confirming it is a known
  footgun rather than an automated path.)
- Any reify (including a worktree `npm ci`) **interrupted by resource exhaustion / a box
  crash** — the mechanism the testing-v2 lead-state and head-to-head records attribute to
  the 2026-07-08 incident.

**Ruled OUT / downgraded:**
- The former `ensureDeps()` automatic `npm install` as a **primary trigger** — it was
  additive, did not prune (experiments A, B, D), and rolled back on locks (F). It was repair,
  not the trigger, and is now retired. Historical residual risk is recorded in §8.
- The "`npm install` prunes/rewrites the whole tree under `package-lock=false`" theory —
  disproved (A, B).
- The "npm unlinks siblings first, then EPERMs, leaving a half-wipe" mechanism for the
  **graceful** case — disproved (F: clean rollback).
- The **chaos.mjs junction-delete-through** vector — real but **distinct and test-only**,
  already fixed by PR #956 (§13). Not the general/dev-time cause.

**Grep of the repo** for destructive npm invocations (`rg "npm ci|--force|audit fix"`) found
them only in: per-worktree `worktree_setup_command` (separate trees, not primary), the
`release` skill (with an explicit "not in primary" warning), `e2e:v2`/chaos test scripts
(separate worktrees), and docs. This confirmed the observed trigger was human/agent action
or an interrupted reify, not gateway code. The current harness goes further: it invokes no
package manager at all.

---

## 8. Why the additive repair was retired

The former `ensureDeps` path fired only after dependencies were already missing. Its plain
`npm install` restored missing packages without touching healthy ones in experiment D, so it
was fundamentally **recovery**, not the origin of a fresh half-wipe on a healthy tree.

It still had secondary operational risks:

1. **Rewrite under lock.** Version drift can make plain install re-extract a package
   (experiment C). A locked native file makes that repair fail, even though modern npm rolls
   back cleanly (experiment F).
2. **Interrupted repair.** Interrupting any reify can expose experiment H's incomplete-tree
   window.
3. **Automatic timing.** Running repair during a restart leaves the operator unable to
   guarantee that every process holding native files is stopped.

The harness therefore no longer repairs dependencies automatically. It reports validation
failures and manual recovery instructions instead. The operator must stop Bobbit and the
entire development stack, run plain `npm install` manually, and then retry or restart. This
keeps mutation and lock coordination under operator control without changing the confirmed
additive-install conclusion.

---

## 9. Retired instrumentation proposal

The investigation originally proposed before/after logging around the harness's automatic
`npm install`. That proposal is obsolete because the harness no longer invokes npm or any
other package manager. Current diagnostics report the invalid root manifest or every missing
declared dependency and include the stopped-stack manual recovery procedure. The isolated
experiments in §5 remain the evidence for the historical additive-repair conclusion.

---

## 10. Reproduction steps

**A. Prove the general half-wipe mechanism (isolated, safe — no real primary tree):**
1. `mkdir` a temp dir; add `.npmrc` with `shrinkwrap=false`; `package.json` with a handful of
   deps (include one with a native addon, e.g. `lightningcss`, to mirror the real lock).
2. `npm install` to get a healthy tree.
3. In another process, hold an **exclusive, no-share** OS handle on a native `.node` file
   inside one package (PowerShell:
   `[System.IO.File]::Open($f,'Open','ReadWrite','None')`).
4. Force that package to need a rewrite (fake its on-disk version) and run `npm install` →
   observe `EBUSY rename` and a **clean rollback** (no half-wipe) — the graceful case.
5. Separately, run `npm ci` while polling the top-level package count every ~10 ms →
   observe the dip toward empty. `SIGKILL` npm during the dip → observe a **half-wiped**
   tree (the destructive/interrupted case).

**B. Verify the gateway exposure without touching the installed tree:**
1. Create a temporary fake Pi package and inject an `import.meta.resolve`-compatible seam
   into the direct-host resolver.
2. Resolve the healthy fixture, then make the injected resolver report Pi as missing. The
   direct path must return actionable install/`--agent-cli` guidance; no real dependency is
   removed.
3. Place a sentinel under a temporary `<stateDir>/runtime` and assert both healthy and
   missing-package resolution perform zero access beneath it. Docker remains outside this
   resolver because its runtime is baked into the image.

---

## 11. Implemented startup policy

The current policy removes both automatic dependency mutation and runtime snapshotting.
This avoids synchronous recursive filesystem work during direct-session restoration and
keeps dependency repair under operator control on every platform and filesystem.

### Read-only dependency validation

The harness validates the root manifest and installed package manifests before all lifecycle
entries:

- `dependencies` and `devDependencies` must each be valid dependency maps, and every declared
  package must have a manifest under `node_modules`;
- `optionalDependencies` remain optional;
- unreadable, malformed, or structurally invalid root manifests fail validation; and
- validation performs reads only, with no repair callback, filesystem writes, subprocesses,
  or package-manager invocation.

A validation failure reports its cause and tells the operator to stop Bobbit and the
development stack, run `npm install` manually, then retry or restart. Initial startup exits
non-zero before build or launch. Sentinel restart and automatic crash relaunch skip build and
launch but keep the harness alive for a later operator-triggered retry. Healthy initial and
sentinel paths validate, build, and launch; a healthy crash relaunch validates and launches
without rebuilding. A failed sentinel build never launches stale output and remains retryable.

### Installed direct-host Pi runtime

Automatic direct host resolution uses Bobbit's installed
`@earendil-works/pi-coding-agent` package in place through `import.meta.resolve`. The explicit
CLI override remains first choice. Missing Pi produces an actionable install or `--agent-cli`
error. Docker sandbox behavior remains unchanged because its Pi runtime is baked into the
image.

The retired ring-fence previously copied or hardlinked the installed tree recursively into
`<stateDir>/runtime`; on high-latency NFS that synchronous traversal could delay gateway port
binding for minutes. Resolution now performs no probe, traversal, creation, update, or cleanup
under `<stateDir>/runtime`. Existing snapshots and partial `.tmp-*` trees are ignored and left
untouched. They may be deleted manually to reclaim space, but only while Bobbit is fully
stopped.

---

## 12. Focused regression coverage

`tests2/core/node-modules-ring-fence.test.ts` retains its historical filename but now pins the
NFS-safe startup policy with temporary fixtures and injected seams. It does not simulate NFS,
run real npm, access the network, or mutate the repository's installed dependencies.

Coverage verifies:

- automatic direct-host resolution uses the installed Pi entry and never accesses a sentinel
  legacy `<stateDir>/runtime` tree;
- an explicit CLI override takes precedence and missing Pi produces actionable guidance;
- validation checks production and development dependency manifests, ignores optional
  dependencies, rejects invalid root manifests, and performs no writes or subprocess calls;
- unhealthy initial boot, sentinel restart, and crash relaunch do not build or launch; and
- the still-running harness can validate and proceed after a later manual repair and retry.

---

## 13. DISTINCT vector: chaos.mjs junction-delete-through (PR #956 — do NOT revert)

> The section below is the original RCA for a **separate, test-only** corruption vector,
> fixed by PR #956 (`goal/fix-chaos-node-10b9c9aa`). It is **not** the general/dev-time
> cause analysed above, and the fix (junction-safe teardown in `scripts/testing-v2/chaos.mjs`)
> **must not be reverted or weakened**.

Source: root-cause session `38f2bfb3-e159-4e8a-92e7-c7feafa0db98` + confirmation against
`scripts/testing-v2/chaos.mjs` on the `goal/sub-3-min-test-6c956ecf` branch.

### Symptom
Mid-session, `node_modules` gets half-wiped; afterwards new agents / verification agents
cannot spawn. Root cause: the gateway resolves `@earendil-works/pi-coding-agent` (and peers
like `@earendil-works/pi-ai`) from the **gateway process's install** via `import.meta.resolve`
(`resolveAgentModulesDir()` in `src/server/agent/rpc-bridge.ts`). The instant that tree is
missing a package, **every** spawn fails instantly. Same class also breaks the v2 chaos run
(`Cannot find package '@earendil-works/pi-ai/oauth'` load-errors) and legacy `.bin` shims.

### Mechanism (Windows-specific footgun)
For every mutant (53+ per campaign, plus baseline + per-mutant full-v2 samples) `chaos.mjs`:
1. `createEphemeralWorktree()` → `git worktree add --detach <os.tmpdir()/bobbit-chaos-…> HEAD`.
2. `ensureNodeModulesJunction()` → `fs.symlinkSync(TOOLCHAIN.nm, <wt>/node_modules, "junction")`
   — a Windows **directory junction** pointing at a real, shared `node_modules` tree.
3. runs targeted tests.
4. `removeEphemeralWorktree()` → `git worktree remove --force` then fallback
   `fs.rmSync(worktreePath, { recursive: true, force: true })`.

**The bug:** on Windows both `git worktree remove --force` and Node's recursive `fs.rmSync`
can **descend through the `node_modules` junction and delete the target's contents** instead of
just unlinking the reparse point. Run dozens of times per campaign → one bad traversal
half-wipes the shared tree.

### Blast radius depends on which tree the junction targets
- **Before** the resolver fix, `TOOLCHAIN.nm` = the **primary repo** `node_modules`
  (`C:\Users\jsubr\w\bobbit\node_modules`) — the exact tree the running gateway imports from.
  A single bad traversal **bricks all agent/verification spawning** server-wide. This is what
  the user observed.
- **After** the resolver fix (commit `0f10c725`, "complete node_modules" preference),
  `TOOLCHAIN.nm` = the **goal worktree** `node_modules`. A bad traversal now corrupts only the
  goal worktree's tree (recoverable, not gateway-bricking) — but the underlying delete-through-
  junction bug is **still present**.

### The fix (IMPLEMENTED)

The fix has two layers. The **primary** fix removes the footgun by design (nothing resolvable
lives inside any deletion root); the **defensive** layer is belt-and-braces for the per-worktree
removal path.

#### Primary fix — parent-directory resolution via a campaign-scoped "chaos root"

*Why this shape:* the delete-through-junction bug can only wipe a shared tree if a `node_modules`
link lives *inside* a directory that gets force-deleted. So the fix is to stop putting any
`node_modules` link inside a throwaway worktree at all. Instead, `chaos.mjs` creates ONE
campaign-scoped container dir under `os.tmpdir()` — the "chaos root" — holding a single shared
`node_modules` link plus every per-mutant worktree as a *sibling*:

```
<CHAOS_ROOT> = os.tmpdir()/bobbit-chaos-root-<pid>-<ts>
  node_modules/           ← ONE junction (win) / dir symlink (posix) → complete toolchain nm
  wt-<mutantId>/          ← ephemeral git worktree — NO node_modules inside it
  wt-fullv2-baseline/, wt-fullv2-<mutantId>/
```

Node and Vite resolve modules by walking **up** from `<CHAOS_ROOT>/wt-*/…` to
`<CHAOS_ROOT>/node_modules` — full fidelity (`.bin`, `exports`, transitive + `@earendil-works/*`).
Because nothing resolvable lives inside a worktree, no force-delete of a worktree can descend
through a junction into the shared/primary tree.

Implemented in `scripts/testing-v2/chaos.mjs`:
- **`ensureChaosRoot(root, nmTarget)`** — called once at the top of `main()`. `mkdir -p` the
  chaos root and, if absent, create the single shared `node_modules` reparse point (Windows
  `junction`, POSIX `dir` symlink) → the complete toolchain `node_modules`. The "complete
  toolchain" fail-loud guard (must contain `vitest` AND `@earendil-works/pi-ai`) stays in `main()`.
- **`createEphemeralWorktree(label)`** — `git worktree add --detach <CHAOS_ROOT>/wt-<label> HEAD`.
  It creates **no** per-worktree `node_modules` link. `ensureNodeModulesJunction()` (the old
  in-worktree junction) was **deleted entirely**.
- **`unlinkReparsePoint(p)`** — removes ONLY the link, never follows it: `lstat`; a Windows
  directory junction (dir, not symlink) → `fs.rmdirSync`; a symlink → `fs.unlinkSync`; a real
  entry → **throw** (refuse to reparse-unlink a real dir).
- **`cleanupChaosRoot(root)`** — campaign teardown, run from `main()`'s `finally`. Unlinks the
  shared `node_modules` reparse point **first**, then recursively deletes the chaos root. If the
  reparse point is *still present* after the unlink attempt, it **refuses** the recursive delete
  and leaves the root in place — so `fs.rmSync` can never traverse a surviving junction.
- **`finally` + `process.exitCode`** — the null-mutant integrity-check failure path sets
  `process.exitCode = 1; return` instead of `process.exit(1)`, so the `finally` block (and thus
  `cleanupChaosRoot()`) always runs and never leaks a junction into `os.tmpdir()`. The CLI-only
  guard (`import.meta.url === pathToFileURL(process.argv[1]).href`) means importing the module
  from a test does not launch a campaign.

#### Defensive layer (retained, belt-and-braces)

Even though no junction now lives inside a worktree, `removeEphemeralWorktree()` still calls
`unlinkNodeModulesJunction()` to remove any `node_modules` reparse point *before* `git worktree
remove` / the recursive `fs.rmSync` fallback, and keeps the fail-loud guard that refuses to
delete when a junction target resolves inside the removal path.

#### Regression test

`tests2/core/chaos-worktree-safety.test.ts` (temp-FS only, no git/network — stays in the
external-free core tier) pins the invariant: `unlinkReparsePoint` / `cleanupChaosRoot` remove a
`node_modules` junction pointing at an external sentinel dir while the sentinel and its marker
file **survive**, and asserts `ensureNodeModulesJunction` is no longer defined (so the
in-worktree junction can never be reintroduced). It fails against the pre-fix HEAD and passes
after.

#### Options considered and rejected
- **Pure `NODE_PATH` / `--preserve-symlinks` with no link at all** — tier-1 is vitest, which
  resolves through Vite's resolver; **Vite ignores `NODE_PATH`**, and `--preserve-symlinks` only
  changes how an already-linked dep resolves *its* children. Bare / `exports`-mapped /
  `@earendil-works/*` workspace imports would not resolve.
- **Per-mutant copy of `node_modules`** — a full copy on Defender-scanned NTFS is minutes /
  hundreds of MB × 53+ mutants — prohibitive. The reparse-point-first teardown + sibling
  placement already make it impossible for cleanup to reach the primary tree, so a copy buys
  nothing.

### Related latent issues found while fixing chaos-proof
- `tsx` is **undeclared** in package.json yet the legacy suite runs it via `npx tsx`
  (`npm ci` prunes it). chaos.mjs now falls back to `npx --no-install tsx`.
- Registry `@earendil-works/pi-ai@0.79.6` in the goal worktree lacked the built `./oauth`
  subpath; the primary worktree's copy has `dist/oauth.js`. Copied it in to complete the tree.
- Infra: the goal worktree is periodically hard-reset to `origin/<goal-branch>` (local merges
  must be **pushed**, not just merged), and gate verification **caches command steps by commit
  sha** (a fresh commit is needed to bust a stale/poisoned cached result).

### Update: the pi-ai "reproducibility" issue was corruption collateral, not a bad package

Confirmed via `npm view @earendil-works/pi-ai@0.79.6`: the registry package **does** declare
`"./oauth": { "import": "./dist/oauth.js" }` and ships it. The primary worktree's normally-installed
copy has `dist/oauth.js` and works. A clean `npm ci` (no concurrent chaos run) yields a COMPLETE,
loadable tree — `npm ci`/reproducibility is fine.

Therefore the earlier "goal worktree pi-ai missing dist/oauth.js" and "test-engineer worktree has
vitest but no pi-ai" were **the same chaos.mjs junction-delete-through bug** deleting individual
files out of whichever `node_modules` the chaos resolver junctioned (it searches sibling worktrees
for a "complete" tree, junctions it, then a worktree-removal traversal deletes through it). This is
one unified root cause behind every node_modules-corruption symptom in **that** goal, including the
original primary-worktree agent-spawn brick.

**Implication:** fixing the chaos.mjs junction/removal safety (unlink the reparse point before any
recursive delete; never junction a shared tree that a force-delete can traverse) resolves that
test-only class. It is orthogonal to the general/dev-time half-wipe analysed in §1–§12.
