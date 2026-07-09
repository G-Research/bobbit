# RCA: node_modules corruption from chaos.mjs (dev-host, no sandbox)

Source: root-cause session `38f2bfb3-e159-4e8a-92e7-c7feafa0db98` + confirmation against
`scripts/testing-v2/chaos.mjs` on the `goal/sub-3-min-test-6c956ecf` branch.

## Symptom
Mid-session, `node_modules` gets half-wiped; afterwards new agents / verification agents
cannot spawn. Root cause: the gateway resolves `@earendil-works/pi-coding-agent` (and peers
like `@earendil-works/pi-ai`) from the **gateway process's install** via `import.meta.resolve`
(`resolveAgentModulesDir()` in `src/server/agent/rpc-bridge.ts`). The instant that tree is
missing a package, **every** spawn fails instantly. Same class also breaks the v2 chaos run
(`Cannot find package '@earendil-works/pi-ai/oauth'` load-errors) and legacy `.bin` shims.

## Mechanism (Windows-specific footgun)
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

## Blast radius depends on which tree the junction targets
- **Before** the resolver fix, `TOOLCHAIN.nm` = the **primary repo** `node_modules`
  (`C:\Users\jsubr\w\bobbit\node_modules`) — the exact tree the running gateway imports from.
  A single bad traversal **bricks all agent/verification spawning** server-wide. This is what
  the user observed.
- **After** the resolver fix (commit `0f10c725`, "complete node_modules" preference),
  `TOOLCHAIN.nm` = the **goal worktree** `node_modules`. A bad traversal now corrupts only the
  goal worktree's tree (recoverable, not gateway-bricking) — but the underlying delete-through-
  junction bug is **still present**.

## The fix (IMPLEMENTED)

The fix has two layers. The **primary** fix removes the footgun by design (nothing resolvable
lives inside any deletion root); the **defensive** layer is belt-and-braces for the per-worktree
removal path.

### Primary fix — parent-directory resolution via a campaign-scoped "chaos root"

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

### Defensive layer (retained, belt-and-braces)

Even though no junction now lives inside a worktree, `removeEphemeralWorktree()` still calls
`unlinkNodeModulesJunction()` to remove any `node_modules` reparse point *before* `git worktree
remove` / the recursive `fs.rmSync` fallback, and keeps the fail-loud guard that refuses to
delete when a junction target resolves inside the removal path.

### Regression test

`tests2/core/chaos-worktree-safety.test.ts` (temp-FS only, no git/network — stays in the
external-free core tier) pins the invariant: `unlinkReparsePoint` / `cleanupChaosRoot` remove a
`node_modules` junction pointing at an external sentinel dir while the sentinel and its marker
file **survive**, and asserts `ensureNodeModulesJunction` is no longer defined (so the
in-worktree junction can never be reintroduced). It fails against the pre-fix HEAD and passes
after.

### Options considered and rejected
- **Pure `NODE_PATH` / `--preserve-symlinks` with no link at all** — tier-1 is vitest, which
  resolves through Vite's resolver; **Vite ignores `NODE_PATH`**, and `--preserve-symlinks` only
  changes how an already-linked dep resolves *its* children. Bare / `exports`-mapped /
  `@earendil-works/*` workspace imports would not resolve.
- **Per-mutant copy of `node_modules`** — a full copy on Defender-scanned NTFS is minutes /
  hundreds of MB × 53+ mutants — prohibitive. The reparse-point-first teardown + sibling
  placement already make it impossible for cleanup to reach the primary tree, so a copy buys
  nothing.

## Related latent issues found while fixing chaos-proof
- `tsx` is **undeclared** in package.json yet the legacy suite runs it via `npx tsx`
  (`npm ci` prunes it). chaos.mjs now falls back to `npx --no-install tsx`.
- Registry `@earendil-works/pi-ai@0.79.6` in the goal worktree lacked the built `./oauth`
  subpath; the primary worktree's copy has `dist/oauth.js`. Copied it in to complete the tree.
- Infra: the goal worktree is periodically hard-reset to `origin/<goal-branch>` (local merges
  must be **pushed**, not just merged), and gate verification **caches command steps by commit
  sha** (a fresh commit is needed to bust a stale/poisoned cached result).

## Update: the pi-ai "reproducibility" issue was corruption collateral, not a bad package

Confirmed via `npm view @earendil-works/pi-ai@0.79.6`: the registry package **does** declare
`"./oauth": { "import": "./dist/oauth.js" }` and ships it. The primary worktree's normally-installed
copy has `dist/oauth.js` and works. A clean `npm ci` (no concurrent chaos run) yields a COMPLETE,
loadable tree — `npm ci`/reproducibility is fine.

Therefore the earlier "goal worktree pi-ai missing dist/oauth.js" and "test-engineer worktree has
vitest but no pi-ai" were **the same chaos.mjs junction-delete-through bug** deleting individual
files out of whichever `node_modules` the chaos resolver junctioned (it searches sibling worktrees
for a "complete" tree, junctions it, then a worktree-removal traversal deletes through it). This is
one unified root cause behind every node_modules-corruption symptom in this goal, including the
original primary-worktree agent-spawn brick the user reported.

**Implication:** fixing the chaos.mjs junction/removal safety (unlink the reparse point before any
recursive delete; never junction a shared tree that a force-delete can traverse) resolves the entire
class. No package.json/lock change is needed for pi-ai. Concurrency Option A (per-run worktrees via
`npm ci`) will produce stable complete trees once chaos can no longer corrupt sibling node_modules.
