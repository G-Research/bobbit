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

## Safe pattern (the fix)
- **Never let a recursive delete touch the junction.** Unlink the `node_modules` reparse point
  *first* (`fs.rmSync(link,{recursive:false})` / `fs.unlinkSync` / `fs.rmdirSync` on the link
  only), then remove the worktree dir. Also unlink before `git worktree remove`.
- Prefer not to junction a shared tree at all: use a dedicated/copied `node_modules`, or set
  `NODE_PATH` / `--preserve-symlinks` so tests resolve without a physical link inside a
  force-deleted dir.
- Add a **guard**: assert the junction target is never inside any removal path; fail loud otherwise.
- **Defensive layer:** a runtime `node_modules` self-heal so a mid-session half-wipe can never
  block agent/verification spawning (today the harness only self-heals on restart).

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
