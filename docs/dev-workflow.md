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

- Watches a sentinel file at `.bobbit/state/gateway-restart`.
- Validates installed dependencies before initial build/launch, sentinel-triggered rebuild/launch, and automatic crash relaunch. Validation only reads package manifests; it never runs a package manager or repairs `node_modules`.
- On a healthy sentinel restart: kills the server, waits for the port to free, validates dependencies, runs `npm run build:server`, and relaunches.
- On a healthy unexpected-crash relaunch: validates dependencies and relaunches without rebuilding, preserving the existing crash-relaunch policy.
- On initial validation failure: reports the missing dependencies or invalid root manifest, gives manual recovery instructions, and exits non-zero before build or launch.
- On restart/relaunch validation failure: reports the same diagnostics, skips build and launch, and keeps the harness available for a later operator-triggered retry.
- Preserves sessions across restarts in `.bobbit/state/sessions.json`.

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
| `package.json` (new dependency) | Stop Bobbit and the development stack, run `npm install` manually, then restart |
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
native module file while a process has it loaded. The confirmed half-wipe is **not**
caused by a normal `npm install`: under the repo's `shrinkwrap=false` /
`package-lock=false` setting, plain install does not prune the tree and modern npm
rolls back cleanly on a locked-file `EBUSY` in the tested case.

The half-wipe needs either:

- a destructive npm operation against the primary tree, such as `npm ci`,
  `npm install --force`, or `npm audit fix --force`; or
- an interrupted reify — for example a crash, kill, or resource exhaustion during
  npm's bulk-remove/retire window.

Those paths can leave `node_modules` partially repopulated with core runtime
packages missing.

**Why it bricks direct spawns**: automatic direct host-side agent and verification
spawns resolve Bobbit's installed `@earendil-works/pi-coding-agent` package in place
using Node's normal package-resolution semantics. If that installation is half-wiped,
direct spawns fail with guidance to install the package or supply an explicit
`--agent-cli` path. Docker spawns are not exposed because the sandbox image contains
its own Pi runtime and does not bind-mount host `node_modules` for it.

**Current policy**: the runtime ring-fence and automatic dependency healing are
retired on every platform. The harness performs read-only validation of declared
`dependencies` and `devDependencies` by checking their installed package manifests;
`optionalDependencies` remain optional. An unreadable, malformed, or structurally
invalid root `package.json` also fails validation. The harness never runs `npm install`
or another package manager. Invalid dependencies prevent build and gateway launch;
a failed restart or crash relaunch leaves the harness available so the operator can
repair the installation and trigger another restart.

Direct host Pi resolution never probes or modifies `<stateDir>/runtime`. Legacy
snapshots and partial trees there are ignored and left untouched. They may be removed
manually to reclaim space, but only while Bobbit and the development harness are fully
stopped.

**Avoid**: never run `npm ci`, `npm install --force`, or `npm audit fix --force`
while the dev stack (`npm run dev:harness` / vite) is up. Stop it first, run the
destructive command, then restart.

**Recover**: dependency repair is operator-owned. Stop Bobbit and the entire
development stack first, run plain `npm install` manually, then start or restart the
harness. Plain install was confirmed to be additive in the missing-dependency case and
preserves the `.npmrc` `shrinkwrap=false` lockfile-freeze invariant, so it restores
missing packages without regenerating `package-lock.json`. It was not the NFS startup
hang or the primary half-wipe trigger.

For the full RCA, experiments, and regression coverage, see
[docs/testing-v2/node-modules-corruption-rca.md](testing-v2/node-modules-corruption-rca.md).

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

E2E tests use `playwright-e2e.config.ts` which defines two projects:

- **`api`** (4 workers): API-only tests import from `in-process-harness.js` — the gateway runs in the same Node process, eliminating child process spawn overhead. Covers HTTP/WS API tests, CRUD, agent protocol.
- **`browser`** (2 workers): Browser and process-level tests import from `gateway-harness.js` — spawns a real gateway child process. Used for UI E2E tests (`tests/e2e/ui/`), MCP integration, and tests needing process-level behavior (port allocation, auth bypass).

See [AGENTS.md](../AGENTS.md#testing) for harness selection guidance and test recipes.

---

## Worktree branch namespaces

When you list `git branch` in a Bobbit-managed repo you'll see several namespaces:

| Prefix | Owner | Purpose | Publication policy |
|---|---|---|---|
| `pool/_pool-<id>` | Worktree pool | Pre-built worktrees waiting to be claimed by a session or goal. Renamed atomically on claim. (Pre-Phase 3 these used `session/_pool-*`; both prefixes are recognised on startup for back-compat.) | Local-only implementation detail. |
| `session/<id8>` | Live regular session | A session worktree, named immediately on pool claim (no first-prompt rename). Cleaned up on session archive. See [internals.md — Session worktrees](internals.md#session-worktrees) and [design/remove-session-worktree-rename.md](design/remove-session-worktree-rename.md). | Local-only on creation, reuse, and recovery. |
| `goal/<slug>-<id>` | Live goal/integration branch | Spans every component repo in multi-repo projects. | Local-only until an explicit push, Ready-to-Merge command, or PR flow publishes it. |
| `goal/<goalId8>/<role>-<short4>` | Team-member agent | Per-role worktree under a live goal. Created on `team_spawn`, cleaned up on goal archive (alongside the goal branch) or agent dismiss. Legacy `goal-goal-<slug>-<id>-<role>-<short>` from before the `pithier-te` rename is recognised by the same cleanup path. | Local-only on creation, reuse, and recovery. |
| `staff-<name>-<id>` | Staff agent worktree | Long-lived when the staff uses a worktree; rebased onto the primary branch/base ref on each wake. No-worktree staff have no staff branch. | Local-only on creation and wake refresh. |

The boot sweeper (`worktree-sweeper.ts`) reconciles these against persisted state on every server start — orphaned pool entries and renamed-but-unpersisted worktrees are cleaned up automatically. See [internals.md — Session worktrees](internals.md#session-worktrees) for the full lifecycle.

**Worktree setup (per-component).** When a goal worktree is provisioned (whether freshly created or claimed from the pool), Bobbit runs each component's project-level `worktree_setup_command` on the host before the team starts. Failures are **non-fatal** — they are logged and the worktree is still used. The per-command timeout resolves project `worktree_setup_timeout_ms` → 120000 ms default, and timeout-aware runners wait for subprocess cleanup before returning the worktree or adding it to the pool. These commands run **non-sandboxed on the host** — set them only for trusted commands.

For **goal-scoped** variation (one goal differing from another — enable a feature, seed an index, disable a tool/provider), use **hierarchical goal metadata** and the `goalProvisioned` extension hook rather than a per-goal command. Metadata is inherited down the goal tree and the hook fires at every worktree provisioning in the subtree, so treatments apply symmetrically to every agent and sub-goal. See [goals-workflows-tasks.md — Per-goal worktree provisioning](goals-workflows-tasks.md#per-goal-worktree-provisioning) and [design/goal-metadata.md](design/goal-metadata.md). (The earlier bespoke per-goal `worktreeSetupCommand` field from PR #816 has been removed and is ignored if posted.)

**Base ref for new worktrees.** New worktrees (session, goal, staff, pool) branch off the project's configured `base_ref` when set, otherwise off the remote primary (`origin/master`/`origin/main`) or, for local-only repos with commits, local `HEAD`. Fresh `git init` repos with unborn `HEAD` fall back to no-worktree until an initial commit is made; pool prefill skips them with the same actionable warning. A configured `base_ref` is still honored in unborn repos, while a stale configured ref fails loudly rather than silently falling back. The same value drives the `{{baseBranch}}` workflow variable and the `aheadOfPrimary`/`behindPrimary` git-status comparator. Some worktrees also use it as `@{u}` for local status, but Bobbit-owned branch publication never relies on upstream tracking: when a branch is intentionally published, it uses explicit destination refspecs such as `<branch>:refs/heads/<branch>` or `HEAD:refs/heads/<branch>`. `{{master}}` keeps resolving to the project primary independently. Team-member worktrees branch off the goal branch by hierarchical design and are not affected. Full semantics, validation rules, and error inventory: [design/base-ref.md](design/base-ref.md).

### Local-only Git lifecycle

Bobbit creates session, goal, child-goal, team-member, staff, and pool branches **locally**. Cold provisioning, pool claims, multi-repo worktree sets, sandbox provisioning, worktree repair, and restart recovery may fetch refs to select or refresh a start point, but they do not publish the work branch. A configured `base_ref` selects the start point and comparison/upstream baseline; it is not a publication request.

Git status is read-only. Connection, idle, reconnect, dropdown refresh, visibility refresh, and periodic polling report `ahead`, `hasUpstream`, and base-ref comparisons without pushing. If a remote work branch is deleted while its local branch survives, status and lifecycle recovery leave the remote branch absent.

Persistent host worktrees and sandbox worktree volumes are the normal collaboration and durability layer. Sandboxed worktrees do not install post-commit auto-push hooks. Team leads merge or cherry-pick from local refs/worktrees, and child-goal integration merges into the parent locally without pushing the parent.

Publish only when there is an intentional need:

- the user invokes the explicit push action or an agent runs `git push`;
- a workflow, cross-machine handoff, or container handoff requires a remote branch;
- the Ready-to-Merge / PR flow publishes the goal integration branch.

Cleanup treats a missing remote branch as an idempotent no-op. Gate verification also supports unpublished goal branches: it verifies the local worktree rather than requiring a remote work branch. When a remote work branch already exists, verification sync is non-destructive — it keeps a local-ahead or diverged tree and only fast-forwards a local-behind tree. See [Gate verification baselines](goals-workflows-tasks.md#gate-verification-baselines).

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

## Related docs

- **[README.md](../README.md)** — Architecture overview, quick start, CLI flags
- **[REST API](rest-api.md)** — Full REST API reference
- **[Security Model](security.md)** — Auth, TLS, and security details
- **[Networking](networking.md)** — Bind addresses, TLS, deSEC, QR codes
- **[Bundle profile workflow](perf/bundle-profile.md)** — Diagnose UI bundle-size regressions; budget guard at `tests/bundle-size.test.ts`
- **[AGENTS.md](../AGENTS.md)** — Agent context: repo layout, key concepts, common tasks, debugging tips
