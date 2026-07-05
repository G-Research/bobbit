# Development Workflow

How to run, develop, and deploy Bobbit. For project architecture and concepts see [README.md](../README.md). For agent-facing context (repo layout, key abstractions, common tasks) see [AGENTS.md](../AGENTS.md).

---

## Running modes

Bobbit has three runtime modes: **production**, **dev**, and **dev with harness**. The difference is how server-side TypeScript is compiled and how the UI is served.

### Production

```bash
npm run build   # compile server + bundle UI
npm start       # serve everything from dist/
```

The gateway serves the bundled UI from `dist/ui/` as static files. Everything runs from a single process (plus agent child processes). No hot reload — you must rebuild and restart to pick up changes.

### Dev (no harness)

```bash
npm run build:server   # required once before first run
npm run dev            # gateway + vite dev server
```

Runs two processes concurrently:

1. **Gateway** (`node dist/server/cli.js --cwd . --no-ui`) on port 3001 — handles REST API, WebSocket, and agent subprocesses.
2. **Vite** on port 5173 — serves the UI with hot module replacement. Proxies `/api` and `/ws` to the gateway.

UI changes (`src/ui/`, `src/app/`) hot-reload instantly in the browser. Server changes (`src/server/`) require manually rebuilding (`npm run build:server`) and restarting the gateway.

### Dev with harness (recommended)

```bash
npm run dev:harness
```

Same two-process setup, but the gateway is wrapped in a **restart harness** (`src/server/harness.ts`). The harness:

- Watches a sentinel file at `.bobbit/state/gateway-restart`
- On signal: kills the server, waits for the port to free, **self-heals `node_modules`** (see below), runs `npm run build:server`, relaunches
- Auto-restarts on unexpected crashes
- On every boot/restart it checks that each declared dependency is physically present in `node_modules` and, only if some are missing, runs a non-destructive `npm install` to restore them (a healthy tree is a no-op)
- Sessions survive restarts (persisted to `.bobbit/state/sessions.json`)

To trigger a restart:

```bash
npm run restart-server
```

This touches the sentinel file. The harness picks it up within ~500ms (polled on Windows, `fs.watch` elsewhere) and begins the restart cycle.

When the gateway was launched by this harness, the Settings page also shows a top-right **Restart Server** button. The button is hidden in production and in `npm run dev` because those modes do not set `BOBBIT_DEV_HARNESS=1` and cannot be restarted safely by the harness. Clicking it calls `POST /api/harness/restart`, which is server-gated and touches the same `.bobbit/state/gateway-restart` sentinel as `npm run restart-server`.

---

## What changes require what

| What you changed | What to do |
|---|---|
| `src/ui/**` or `src/app/**` | Nothing — Vite hot-reloads automatically |
| `src/server/**` | Run `npm run restart-server` (if using harness) or manually `npm run build:server` + restart |
| `package.json` (new dependency) | `npm install`, then restart server |
| `vite.config.ts` | Restart Vite (kill and re-run `npm run dev:harness`) |
| `tsconfig.*.json` | Restart server; may need to restart Vite for web config changes |
| `.bobbit/config/system-prompt.md` | Restart server (the path is resolved at startup and passed to agents) |

**Rule of thumb**: UI is hot. Server is compiled. If you touched anything under `src/server/`, you need a rebuild + restart.

---

## `node_modules` gets wiped while the dev server is running

**Symptom**: the app suddenly stops functioning and the gateway logs
`ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/pi-ai'` (or another
core dependency) — even though `package.json` and `package-lock.json` still list
it. Often appears right after running `npm audit fix --force`, `npm ci`, or
`npm install --force`.

**Cause**: a running dev stack (vite, the gateway) loads native `.node` addons
into memory — e.g. `lightningcss.win32-x64-msvc.node`,
`@mariozechner/clipboard-*`, `photon-node`. On Windows you cannot `unlink` a
native module file while a process has it loaded. A *destructive* npm operation
wipes and rewrites `node_modules`; it removes additive deps as planned, then
aborts with `EPERM` the instant it tries to unlink the locked native binary —
leaving `node_modules` half-wiped with core runtime packages missing.

**Avoid**: never run `npm ci`, `npm install --force`, or `npm audit fix --force`
while the dev stack (`npm run dev:harness` / vite) is up. Stop it first, run the
destructive command, then restart.

**Recover**: a plain `npm install` is *additive* — it does not pre-wipe, so it
restores the missing packages around any locked file. The harness now does this
automatically on every boot/restart (`ensureDeps()` in `src/server/harness.ts`,
backed by the pure `missingDependencies()` helper in
`src/server/harness-deps.ts`); if the install itself fails because a native file
is still locked, stop vite/the gateway and run `npm install` by hand.

## For agents making changes

If you are an AI agent running inside a Bobbit session and you are modifying Bobbit itself:

### UI changes — no action needed

Edit files under `src/ui/` or `src/app/`. Vite picks up the changes and hot-reloads the browser. The user sees updates within seconds. No restart, no build command.

### Server changes — trigger a restart

After editing files under `src/server/`:

```bash
npm run restart-server
```

This signals the harness to rebuild and restart the server. Your current session will survive — the harness persists session metadata to disk, and on relaunch the server restores all sessions from `.bobbit/state/sessions.json`.

**Do not skip this step.** The gateway runs from compiled JavaScript in `dist/server/`. Your TypeScript edits under `src/server/` have no effect until the server is rebuilt.

### Verify your changes compiled

After `npm run restart-server`, watch for the harness output:

```
[harness] ======== RESTART TRIGGERED ========
[harness] Waiting for port 3001 to be free...
[harness] Building server...
[harness] Build complete.
[harness] Launching server (port 3001)...
```

If the build fails, the harness logs the error and attempts to launch the old build anyway. Fix the compilation error and run `npm run restart-server` again.

### Type-checking without restarting

To check both server and UI types without emitting or restarting:

```bash
npm run check
```

This runs `tsc --noEmit` against both `tsconfig.server.json` and `tsconfig.web.json`. Useful to catch errors before triggering a restart.

### Adding new files

New files under `src/server/` are automatically picked up by the next `npm run build:server` (triggered by the harness). No extra configuration needed — the TypeScript config includes all `.ts` files under `src/server/`.

New UI files need to be imported somewhere in the dependency graph (from `src/app/main.ts` or an existing component). Vite handles the rest.

---

## Build outputs

```
dist/
├── server/         # tsc output from src/server/ (Node16 ESM)
│   ├── cli.js      # gateway entry point
│   ├── harness.js  # dev server harness
│   └── agent/      # session manager, RPC bridge, stores
└── ui/             # vite bundle from src/ui/ + src/app/
    ├── index.html  # SPA entry
    └── assets/     # JS, CSS, fonts
```

Two independent build pipelines:

- **Server**: `tsc -p tsconfig.server.json` → `dist/server/`. Plain TypeScript compilation, no bundling.
- **UI**: `vite build` → `dist/ui/`. Bundles, minifies, tree-shakes. In dev mode, Vite serves directly from source with HMR.

---

## Networking architecture

Bobbit is designed for **remote access over a NordVPN mesh network**. The user runs the server on a dev machine and connects from other devices (laptop, tablet) via a mesh IP or a custom domain.

### Port topology (dev mode)

```
Browser (ProArt / phone / etc.)
  │
  │  https://yourname.dedyn.io:5173   ← user-facing URL
  │
  ▼
Vite dev server (:5173)             ← serves UI with HMR, HTTPS using gateway cert
  │  proxy /api/* ──────────────►  Gateway (:3001)  ← REST API + agent management
  │  proxy /ws/*  ──────────────►  Gateway (:3001)  ← WebSocket (session streaming)
  │
  └─ HMR websocket (:5173)         ← Vite's own hot-reload channel (same port)
```

In **production mode** (`npm start`), there is no Vite — the gateway serves the bundled UI directly on port 3001.

### Host binding

Both the gateway and Vite auto-detect the **NordLynx** (NordVPN mesh) interface IP and bind to it.

- **Gateway**: exits with an error if NordLynx isn't found, unless you pass `--host <addr>`
- **Vite**: falls back to `localhost` with a warning, or uses `VITE_HOST` env var

The detected mesh IP (e.g. `<mesh-ip>`) is what other mesh devices use to reach the server.

### deSEC dynamic DNS

On startup, the gateway updates a **deSEC** (dedyn.io) DNS A record so that `yourname.dedyn.io` points to the current mesh IP. Config lives at `.bobbit/state/desec.json`:

```json
{ "domain": "yourname.dedyn.io", "token": "<deSEC API token>" }
```

This means the user can always access `https://yourname.dedyn.io:5173` (dev) or `https://yourname.dedyn.io:3001` (prod) without memorizing mesh IPs, even when the IP changes across NordVPN reconnects.

**Important**: The deSEC update is skipped for loopback addresses (`127.0.0.1`, `::1`, `localhost`) to prevent E2E tests or local-only runs from clobbering the DNS record. If DNS points to `127.0.0.1`, a prior server start with `--host 127.0.0.1` likely caused it — restart the server normally (without `--host`) to push the correct mesh IP.

### TLS certificates

TLS is **on by default**. The server generates certificates on first run and stores them at:

| File | Purpose |
|---|---|
| `.bobbit/state/tls/cert.pem` | Server certificate (covers the host IP + `localhost`) |
| `.bobbit/state/tls/key.pem` | Server private key |
| `.bobbit/state/tls/ca.crt` | Local CA certificate (install on other devices to trust) |
| `.bobbit/state/tls/ca.key` | Local CA private key |

The cert is generated via **mkcert** (npm package) signed by the local CA, with fallback to openssl self-signed. Vite reuses the same cert/key for its HTTPS server (`vite.config.ts` reads them from disk).

To trust the cert on a remote device, install `.bobbit/state/tls/ca.crt` as a trusted CA.

If the cert doesn't cover the current host (e.g. the mesh IP changed), it is regenerated automatically on next startup.

### Troubleshooting connectivity

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERR_CONNECTION_REFUSED` on `:5173` | Vite not running, or not bound to mesh IP | Check `npm run dev:harness` output; verify NordVPN is connected |
| `ERR_CONNECTION_REFUSED` on `:3001` | Gateway not running | Same as above |
| WebSocket connects but session fails | Browser has wrong gateway URL in `localStorage` | Open DevTools console: `localStorage.getItem("gw-url")` — should match the gateway's actual address. Fix with `localStorage.setItem("gw-url", "<correct URL>")` and reload |
| DNS resolves to `127.0.0.1` | A prior `--host 127.0.0.1` run (e.g. E2E tests) pushed loopback to deSEC | Restart the server normally — it will push the mesh IP to deSEC. Flush DNS on the client device if cached |
| Vite HMR WebSocket error in console | Normal when accessing via domain/mesh IP — Vite's HMR can't always connect back | Harmless. Vite falls back to polling. The "Direct websocket connection fallback" message confirms this |
| `ERR_CERT_AUTHORITY_INVALID` | Remote device doesn't trust the local CA | Install `.bobbit/state/tls/ca.crt` on the device, or click through the browser warning |

### Local-only development (no NordVPN)

```bash
# Terminal 1: gateway on localhost
node dist/server/cli.js --host localhost --port 3001 --cwd . --no-ui --no-tls

# Terminal 2: vite on localhost
GATEWAY_NO_TLS=1 VITE_HOST=localhost npx vite
```

Or use the E2E test config which does this automatically:

```bash
npx playwright test --config playwright-e2e.config.ts
```

---

## Testing

```bash
npm test              # All tests (unit + E2E)
npm run test:unit     # Unit tests — Node test runner + Playwright file:// fixtures
npm run test:e2e      # E2E tests — API (in-process) + browser (spawned gateway)
```

Running fleet-parallel (another lane may be testing concurrently, e.g. a merge-gate conveyor)? Use `npm run test:unit:queued` instead of `npm run test:unit` — see [docs/testing-strategy.md § Cross-lane test mutex](testing-strategy.md#cross-lane-test-mutex-fleet-parallel-machines).

E2E tests use `playwright-e2e.config.ts` which defines two projects:

- **`api`** (4 workers): API-only tests import from `in-process-harness.js` — the gateway runs in the same Node process, eliminating child process spawn overhead. Covers HTTP/WS API tests, CRUD, agent protocol.
- **`browser`** (2 workers): Browser and process-level tests import from `gateway-harness.js` — spawns a real gateway child process. Used for UI E2E tests (`tests/e2e/ui/`), MCP integration, and tests needing process-level behavior (port allocation, auth bypass).

See [AGENTS.md](../AGENTS.md#testing) for harness selection guidance and test recipes.

### Integration-merge discipline

Merging a goal branch into `aj-current` (or any other multi-branch integration merge) must run the **full gate suite** (`npm run check`, `npm run test:unit`, `npm run test:e2e`) on the merged tree, not just on each branch independently — conflict resolution can silently drop code that no branch's own tests would ever catch.

This is a real incident class, not a hypothetical: a forensic review of three back-to-back integration merges (`b687d93d`, `eef210f3`, `a34f27e6`) found at least 6 shipped features where a merge's conflict resolution dropped the **server route** while the **client caller and its tests survived** — e.g. `src/app/settings-page.ts` kept calling `/api/claude-code/status` and `tests/e2e/pack-runtimes-api.spec.ts` kept exercising `/api/pack-runtimes` after both routes had vanished from `src/server/server.ts`. Nothing failed at merge time: the client still built, its own unit tests still passed (they mock the network), and the break was only visible as a runtime 404.

**Always run `tests/client-api-orphan-pinning.test.ts`** (part of `npm run test:unit`) after an integration merge — it asserts every `/api/...` path referenced from `src/app/`/`src/ui/` resolves to a real route in `src/server/server.ts` (or its delegate route modules), with a `KNOWN_ORPHANS` burn-down list for orphans that are genuinely pending restoration on an open PR. If the merge introduced a *new* orphan not on that list, the test fails — that's the signal a route was just dropped. See the test file header for the full design (extraction approach, scope decision, allowlist).

---

## Worktree branch namespaces

When you list `git branch` in a Bobbit-managed repo you'll see several namespaces:

| Prefix | Owner | Purpose | Publication policy |
|---|---|---|---|
| `pool/_pool-<id>` | Worktree pool | Pre-built worktrees waiting to be claimed by a session or goal. Renamed atomically on claim. (Pre-Phase 3 these used `session/_pool-*`; both prefixes are recognised on startup for back-compat.) | Local-only implementation detail. |
| `session/<id8>` | Live regular session | A session worktree, named immediately on pool claim (no first-prompt rename). Cleaned up on session archive. See [internals.md — Session worktrees](internals.md#session-worktrees) and [design/remove-session-worktree-rename.md](design/remove-session-worktree-rename.md). | Regular sessions keep legacy/explicit publication behavior. |
| `goal/<slug>-<id>` | Live goal/integration branch | Spans every component repo in multi-repo projects. | Published intentionally for PR and Ready-to-Merge flows. |
| `goal/<goalId8>/<role>-<short4>` | Team-member agent | Per-role worktree under a live goal. Created on `team_spawn`, cleaned up on goal archive (alongside the goal branch) or agent dismiss. Legacy `goal-goal-<slug>-<id>-<role>-<short>` from before the `pithier-te` rename is recognised by the same cleanup path. | Local-only by default. |
| `staff-<name>-<id>` | Staff agent worktree | Long-lived when the staff uses a worktree; rebased onto the primary branch/base ref on each wake. No-worktree staff have no staff branch. | Long-lived staff branches keep legacy/explicit publication behavior. |

The boot sweeper (`worktree-sweeper.ts`) reconciles these against persisted state on every server start — orphaned pool entries and renamed-but-unpersisted worktrees are cleaned up automatically. See [internals.md — Session worktrees](internals.md#session-worktrees) for the full lifecycle.

**Worktree setup (per-component).** When a goal worktree is provisioned (whether freshly created or claimed from the pool), Bobbit runs each component's project-level `worktree_setup_command` on the host before the team starts. Failures are **non-fatal** — they are logged and the worktree is still used. The per-command timeout resolves project `worktree_setup_timeout_ms` → 120000 ms default. These commands run **non-sandboxed on the host** — set them only for trusted commands.

For **goal-scoped** variation (one goal differing from another — enable a feature, seed an index, disable a tool/provider), use **hierarchical goal metadata** and the `goalProvisioned` extension hook rather than a per-goal command. Metadata is inherited down the goal tree and the hook fires at every worktree provisioning in the subtree, so treatments apply symmetrically to every agent and sub-goal. See [goals-workflows-tasks.md — Per-goal worktree provisioning](goals-workflows-tasks.md#per-goal-worktree-provisioning) and [design/goal-metadata.md](design/goal-metadata.md). (The earlier bespoke per-goal `worktreeSetupCommand` field from PR #816 has been removed and is ignored if posted.)

**Base ref for new worktrees.** New worktrees (session, goal, staff, pool) branch off the project's configured `base_ref` when set, otherwise off the remote primary (`origin/master`/`origin/main`) or, for local-only repos with commits, local `HEAD`. Fresh `git init` repos with unborn `HEAD` fall back to no-worktree until an initial commit is made; pool prefill skips them with the same actionable warning. A configured `base_ref` is still honored in unborn repos, while a stale configured ref fails loudly rather than silently falling back. The same value drives the `{{baseBranch}}` workflow variable and the `aheadOfPrimary`/`behindPrimary` git-status comparator. Some worktrees also use it as `@{u}` for local status, but Bobbit-owned branch publication never relies on upstream tracking: when a branch is intentionally published, it uses explicit destination refspecs such as `<branch>:refs/heads/<branch>` or `HEAD:refs/heads/<branch>`. `{{master}}` keeps resolving to the project primary independently. Team-member worktrees branch off the goal branch by hierarchical design and are not affected. Full semantics, validation rules, and error inventory: [design/base-ref.md](design/base-ref.md).

### Short-lived sub-agent branch publication

Team-member branches and delegated helper/session sub-agent branches are **local-only by default**. Bobbit creates the local branch and persistent worktree, but does not publish the branch on creation, after commit, or during git-status polling. The persistent host worktree (or persistent sandbox worktree volume) is the durability mechanism; Bobbit no longer performs default safety-net remote pushes for these scoped short-lived branches.

This policy also applies in sandbox mode. Sandboxed sub-agent worktrees do not install post-commit auto-push hooks, so commits inside the container follow the same local-by-default behavior as host commits.

Team leads merge or cherry-pick from local refs/worktrees when available. Publish only when there is an intentional need:

- the user clicks or invokes an explicit push action;
- a workflow, cross-machine handoff, or container handoff requires a remote branch;
- the final Ready-to-Merge / PR flow publishes the goal integration branch.

Cleanup and status treat missing remote branches for scoped sub-agent branches as expected. The git-status widget may show `Local-only by policy` to distinguish an intentional local-only branch from a failed push. Gate verification uses the same distinction for goal worktrees: an unpublished goal branch skips remote goal-branch sync quietly and verifies the local worktree, while published goal branches still fetch/reset from `origin/<branch>`; see [Gate verification baselines](goals-workflows-tasks.md#gate-verification-baselines).

### Worktree-stash hazard — never `git stash` inside a session worktree

**The hazard.** All worktrees of one repo share a single `.git` directory — including its stash stack. `git stash` in worktree A pushes onto the same stack that `git stash pop` in worktree B reads from. When multiple agents work on the same project in parallel (the normal team-goal case), an unscoped `stash` / `stash pop` pair in one worktree silently drags another worktree's uncommitted changes into the wrong branch. The receiving agent ends up with files it never wrote (and tests it wasn't expecting to pass), and the originating agent loses its work to a dangling stash entry that the next `stash pop` somewhere will accidentally apply.

This is not a Bobbit bug — it's a git behaviour. There is no per-worktree stash stack. **Treat `git stash` as unsafe inside any goal / session / team-member / staff worktree.**

**What hit us.** During the *Human Sign-Off Gates* goal, three parallel coder agents ran in sibling worktrees (`coder-abe0`, `coder-b42b`, `coder-933c`). One agent ran `git stash` to test a clean tree, another ran `git stash pop` shortly afterwards — and Track C's WIP landed on Track A's branch. The team lead had to inventory all three worktrees by hand, swap files back to their rightful branches, and restart two of the three tracks. Several hours lost.

**Safe alternatives.**

- **Commit instead of stash.** Make a throwaway WIP commit (`git commit -am wip`), do the experiment, then `git reset HEAD~1` (or amend) to restore the working state. The commit object stays scoped to the branch you're on.
- **`git worktree add` a fresh temporary worktree** if you genuinely need a clean copy of the tree at a specific ref. Each worktree gets its own working copy with no stash interaction.
- **`git diff > patch && git checkout .`** to save changes to a file, then `git apply patch` later. The patch file is a local artefact — no shared `.git` state involved.

**If you must stash anyway**, pass `--include-untracked` and immediately pop in the same worktree before any other operation — do not leave entries on the stack that another agent could later pop by accident. The first `git stash list` from any sibling worktree will show the entries you created.

**Diagnostic when this regresses.** `git status` in a worktree shows files you never edited, often touching paths that match another in-progress task. `git reflog show stash` lists every entry on the shared stack with its `WIP on <branch>` annotation — entries from a different branch than the worktree you're in are the smoking gun. Reconstruct by walking `git stash show -p stash@{N}` for each entry and applying to the correct worktree manually.

---

## Maintaining a fork

Bobbit can be run as a downstream **fork** that carries local customisations while tracking this repository for upstream changes. The conventions below keep that sustainable in both directions. Set up two remotes in your fork's clone:

| Remote | Points at | Role |
|---|---|---|
| `origin` | your fork (e.g. `<you>/bobbit`) | Your fork. Day-to-day PRs target its `master`. |
| `upstream` | the repository you forked from | The source you track for new commits. |

Add it once with `git remote add upstream <url>`; confirm with `git remote -v`. Targeting the wrong base sends review traffic to a repo you may not control — always verify the PR base before creating it.

### Syncing changes *from* upstream

Pull new `upstream/master` commits into your fork through a single review-ready PR (some forks automate this with a scheduled job, titled e.g. `[upstream-sync] …`):

1. `git fetch upstream && git fetch origin`.
2. Stop if `git rev-list --count origin/master..upstream/master` is `0` — nothing new.
3. `git switch -c sync/upstream-<date> origin/master`.
4. `git merge --no-ff upstream/master`, resolve conflicts so your fork-specific behaviour is preserved, validate (`npm run check` + tests), push, open the PR.

**⚠️ Merge-commit rule.** **Merge upstream-sync PRs with a real merge commit — never squash, never rebase.**

- Squash/rebase **discards the merge's second parent**, so git loses all record that upstream's commits already live in your `master`. After that, `git merge-base master upstream/master` stays pinned at an ancient commit, `origin/master..upstream/master` re-counts every already-merged commit as "ahead", and the next sync re-litigates conflicts you already resolved.
- A merge commit keeps `upstream/master` as a true parent, so future syncs surface **only** genuinely-new commits.
- Enable merge commits on your fork (`allow_merge_commit = true`) and don't require linear history; then use "Create a merge commit" / `gh pr merge <n> --merge`. (If the GitHub UI hides the option right after you change the setting, hard-refresh the PR page — the merge dropdown is cached at load time.)

**If a sync PR was squashed by mistake.** You can't rewrite a protected `master`, so heal the ancestry *forward*: branch off the current `master`, build a commit that records `upstream/master` as a second parent while keeping `master`'s tree, then merge that PR with a merge commit:

```bash
git switch -c sync/heal origin/master
git cherry-pick <new-upstream-commits>          # land any new upstream content cleanly
TREE=$(git write-tree)
HEAL=$(git commit-tree "$TREE" -p origin/master -p upstream/master -m "Merge upstream/master (heal ancestry)")
git reset --hard "$HEAL"                         # branch tip = merge commit, tree = master + new content
# push, open PR, then: gh pr merge <n> --merge   (NEVER squash)
```

### Contributing changes back upstream

To get a fork change accepted into the upstream project:

1. **Develop upstreamable work on a branch cut from `upstream/master`, not your fork's `master`.** A branch based on upstream produces a PR containing *only* your change — no fork-specific commits (CI tweaks, local config, …) leak in.
   ```bash
   git fetch upstream
   git switch -c feature/<name> upstream/master
   # build the change in focused, self-contained commits
   git push origin feature/<name>
   gh pr create --repo <upstream-owner>/bobbit --base master --head <you>:feature/<name>
   ```
2. **Land it in both places.** Merge the branch into your fork (fork PR) and submit it upstream. Once upstream accepts it, the next sync brings it back as a normal ancestor — no duplication, no conflict.
3. **Extracting a change that currently lives only in your fork.** Cherry-pick just its commits onto a fresh `upstream/master`-based branch, dropping fork-only adaptations, and open the upstream PR from there.
4. **Keep fork divergence minimal.** Every file your fork edits that upstream also maintains becomes a recurring merge conflict. Prefer additive, isolated changes (new files, local config) over editing files upstream actively changes. The smaller and more separable the divergence, the cheaper both syncing-down and contributing-up become.

---

## Code graph (graphify)

graphify (installed as a CLI + optional MCP server) extracts an AST/import graph of `src/` into `src/graphify-out/graph.json` — a ~10k-node, ~26k-edge structural map of the codebase. It answers questions that `rg`/LSP can't cheaply: "what's coupled to X", "what would break if I change Y" (`graphify affected`), god-object decomposition planning, and PR blast-radius. See [`.claude/skills/orient/SKILL.md`](../.claude/skills/orient/SKILL.md) for how it fits into the broader "where is X" lookup order (LSP first, then graphify, then the codemap/audit docs).

**When it's valuable**: structural/cross-file questions (coupling, fan-in/out, call chains spanning many files), planning a refactor of a god-object (`server.ts` is 16k lines), estimating the blast radius of a change before touching it. It is not a substitute for LSP `goToDefinition`/`findReferences` on a known symbol — those are cheaper and exact.

**It is not installed on PATH by default.** Install the CLI yourself (`pipx install graphify` or `uv tool install graphify`, see graphify's own docs) — this repo only wires the *result* of having it installed.

The `LSP` tool itself is interactive-session-only; subagents run the same queries via `scripts/lsp-cli.mjs` (`workspace`/`symbols`/`refs`/`def`/`hover`) — see [`.claude/skills/orient/SKILL.md`](../.claude/skills/orient/SKILL.md). The `workspace <file> <query>` command warms the anchor file before polling workspace symbols and emits repo-relative file suffixes, which avoids treating primary/worktree absolute path prefixes as different symbols.

### The graph is a snapshot, not live

`src/graphify-out/` is gitignored (an 11MB+ generated artifact) and does **not** auto-update as code changes.

**One shared graph, refreshed only from the primary checkout.** The primary checkout owns `src/graphify-out/`; lane worktrees share it via a symlink (`src/graphify-out -> <primary>/src/graphify-out`). New worktrees should get the same symlink: `ln -sfn <primary>/src/graphify-out "$WORKTREE/src/graphify-out"` (on the dev machine the primary is `~/Documents/dev/bobbit-aj`). Wiring this into the code paths that create worktrees (`src/server/agent/worktree-pool.ts` / `worktree-support.ts`) is a follow-up — until then it's a manual step. Preserve the symlinks (never delete/recreate them as real directories), and **never run `graphify update` from a worktree** — it would rebuild the shared graph from that worktree's file state, possibly during heavy e2e load. `scripts/graphify-refresh.sh` enforces this.

Two ways the graph gets refreshed:

1. **Manual**: `npm run graph:refresh` from the **primary** repo root. This runs `scripts/graphify-refresh.sh --force` (via `graphify update src --force`; no LLM call — pure AST re-extraction; `--force` is required whenever files were deleted, otherwise graphify refuses to shrink the graph). From a linked worktree it refuses with an explanatory error instead of rebuilding the shared graph.
2. **Committed git hooks** (`.githooks/post-merge`, `.githooks/post-checkout` on branch switches, `.githooks/post-commit`): refresh the graph in the background after a merge/pull, a branch switch, or a local commit. **Not active by default** — opt in once per clone with `./scripts/setup-githooks.sh` (sets `core.hooksPath=.githooks`; nothing is enabled automatically on `npm install`). All three delegate to `scripts/graphify-refresh.sh --hook`, which:
   - no-ops silently if `graphify` isn't on PATH, so machines/CI without it are unaffected;
   - **no-ops unless run from the primary checkout** (`git rev-parse --git-dir` equals `git rev-parse --git-common-dir`) — this is the critical guard for worktrees (see below);
   - additionally no-ops if `src/graphify-out/graph.json` doesn't exist yet, so a fresh clone that never built a graph doesn't start one as a hook side effect;
   - coalesces concurrent triggers through a mkdir-based lock under `src/graphify-out/`, with a 30-minute stale-lock reclaim (`STALE_LOCK_SECONDS` env override) so a crashed refresh can't wedge future ones;
   - runs detached at low `nice` priority so `git merge`/`git pull`/`git checkout`/`git commit` never block on a rebuild;
   - logs to `src/graphify-out/graphify-update.log` instead of the terminal.

   `graphify` also ships its own native hook installer (`graphify hook install`), which writes hooks straight into `.git/hooks/` (uncommitted, machine-local, not shared via this repo). We deliberately did **not** use that path — `.git/hooks/` isn't checked in, so it wouldn't propagate to other clones the way `.githooks/` + `core.hooksPath` does.

   Note for the dev machine: a machine-local dispatcher may already live in `.git/hooks/` (`graphify-refresh-primary` + thin post-merge/post-checkout/post-commit wrappers, with its own primary-only guard, min-interval throttle, and debounce). `.git/hooks/` applies to **all** worktrees while `core.hooksPath` is unset; setting `core.hooksPath` (this script) overrides and disables it. Don't run both — pick one mechanism per machine.

**Worktree hazard — read before changing these hooks**: `git worktree add` fires `post-checkout` (git treats worktree creation as a checkout with the branch-switch flag set) in the *new* worktree, and `core.hooksPath` set via plain `git config` is shared across all worktrees of the repo. We routinely run 10+ concurrent lane worktrees; without the primary-only guard, merges/checkouts in worktrees could each kick off a rebuild of the **shared** (symlinked) graph from worktree file state — many concurrent rebuilds on one machine. A graph-file-presence check is **not** a sufficient guard: the symlinks make `graph.json` look present in every worktree. The primary-only guard makes worktree triggers a fast, side-effect-free no-op. A worktree without the symlink simply has no graph; `/orient` degrades gracefully in that case — LSP + `rg` still work (steps 1/3/4 in that skill), just without the structural graph step.

### MCP wiring

`.mcp.json` (committed) wires graphify as an MCP server so its `query_graph`/`get_neighbors`/`shortest_path`/`get_pr_impact` tools are available directly, instead of shelling out to the `graphify` CLI. Its `command` is the committed `scripts/graphify-mcp.sh` wrapper (`${CLAUDE_PROJECT_DIR:-.}/scripts/graphify-mcp.sh`) rather than a hardcoded interpreter path, so the file is portable across machines and worktrees:
- **Interpreter**: prefers `graphify` on PATH (reads its shebang to find the `uv`-managed venv python that has the package importable — the CLI has no `serve` subcommand, MCP is only exposed via `python -m graphify.serve`), else `$GRAPHIFY_PYTHON` as an explicit override. If neither resolves, the wrapper prints one line to stderr and exits 0 so Claude Code shows a dead/unavailable server instead of a crash loop.
- **Graph path**: prefers this checkout's own `src/graphify-out/graph.json`, else falls back to the primary checkout's graph (first entry of `git worktree list`) so a fresh worktree still gets the shared graph before its first local refresh.

Without a working `.mcp.json` entry, fall back to the `graphify query "<question>"` / `graphify path` / `graphify explain` CLI subcommands from the repo root.

### `graph.json` and merge conflicts

`graph.json` is gitignored, so it never enters a commit and can never produce a git merge conflict — graphify's `merge-driver` subcommand (a union-merge for two `graph.json` files, meant to be wired via `.gitattributes` + `git config merge.<name>.driver`) is **not applicable** to this repo as currently configured. It would only become relevant if a future decision started tracking `graph.json` in git.

### Keeping the skill current

The `/orient` and `graphify` skills bundle a version-pinned copy of graphify's own `SKILL.md`. When the CLI prints `skill is from graphify X, package is Y` on startup, run `graphify install` (or `graphify install --platform claude`) to refresh it — by default this writes to your **home** skill dir (e.g. `~/.claude/skills/graphify/SKILL.md`), not into the repo; pass `--project` if you specifically want a repo-local copy instead.

---

## Related docs

- **[README.md](../README.md)** — Architecture overview, quick start, CLI flags
- **[REST API](rest-api.md)** — Full REST API reference
- **[Security Model](security.md)** — Auth, TLS, and security details
- **[Networking](networking.md)** — Bind addresses, TLS, deSEC, QR codes
- **[Bundle profile workflow](perf/bundle-profile.md)** — Diagnose UI bundle-size regressions; budget guard at `tests/bundle-size.test.ts`
- **[AGENTS.md](../AGENTS.md)** — Agent context: repo layout, key concepts, common tasks, debugging tips
