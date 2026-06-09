# Extension Host — Isolation-Model Simplification (delete the capability sandbox)

**Status:** design for goal `simplify-pack-e8fcf298`. Pivot from Extension Host Phase 2
(merged PR #731), which landed a per-capability permission sandbox over pack **server**
modules. This goal **deletes that sandbox** and keeps only the isolation that is honest.

## 1. Problem & principle

Pack **server** modules (`actions:` / `routes:`) are **trusted code, tool/MCP tier** —
installed from a source the user chose to trust, run **in-process as the user**. Phase 2
nonetheless shipped a per-capability permission sandbox: a default-deny of
`child_process`/`fs`/`net` built-ins, outbound-network-global stripping, env
minimization, and an inert `process` shim — all gated by a `permissions:` manifest key
(`git`/`fs`/`net`). The design doc itself states *"a per-capability sandbox over
in-process worker code gives a false sense of security"* — yet the code shipped exactly
that (a native `.node` addon or the shared process trivially defeats it).

This goal removes the contradiction. **A trusted pack server module gets full ambient
parity with the tool/MCP tier**: normal `node:` built-ins, normal network globals, the
normal `process` with full env. The only isolation kept is the kind that is genuine:

- **Layer 2 — resource/crash isolation** (KEEP, unchanged): terminate-on-timeout,
  `resourceLimits` mem/stack caps, SIGKILL of spawned children on terminate.
- **Layer 3 — pack-root module-import confinement** (KEEP, reframed): the pack module
  graph can only resolve `file:` URLs within the pack root. Documented honestly as cheap
  **import hygiene / loader-stability**, NOT a security boundary (it is near-cosmetic now
  that `fs` is ambient).

Everything that constituted **layer 1** (the per-capability OS gating) and the
`permissions:` concept is **deleted with no backward-compat shim** (intra-release
removal). A stray `permissions:` key in some external YAML is silently dropped by the
**pre-existing generic "unknown top-level keys are ignored"** rule — there is no
`permissions`-named code path left anywhere.

## 2. The one forced design decision: `process.cwd()` parity is preserved

A tool / MCP server runs as a child process whose `cwd` is the **session working dir**.
Pack server modules run as **worker threads inside the gateway**, and worker threads
**cannot `process.chdir()`** (it throws). The Phase-2 inert `process` shim provided the
session-dir cwd via `cwd: () => workingDir`, plus convenience wraps that defaulted async
spawn `cwd` and rebased leading bare-relative `fs` paths onto the session dir, because
libuv's real cwd cannot be redirected in a worker.

**This cwd behavior MUST survive**, for two reasons:

1. **Tool/MCP parity.** A tool runs rooted at the session worktree; the pack worker
   should too. This is parity, not a security shim.
2. **The pr-walkthrough pack depends on it.** `market-packs/pr-walkthrough/.../routes.mjs`
   derives the git repo root from `process.cwd()` (its `repoRoot()` helper) and passes it
   as an explicit `cwd` to `execFile("git", …)`. The browser E2E
   (`tests/e2e/ui/pr-walkthrough-pack.spec.ts`) `git init`s the **session worktree** and
   asserts the `bundle` route shells `git diff` against it. If `process.cwd()` returned
   the gateway's cwd, the pack would diff the wrong repo and the E2E would fail
   (acceptance #5). Passing `workingDir` into the handler `ctx` instead is a **Host-API
   change — explicitly a non-goal**.

**Therefore:** keep threading `workingDir` into the worker and keep the session-dir
behavior, but make it **UNCONDITIONAL** (no longer grant-gated) and reframe it as
"the worker behaves like a tool process rooted at the session working dir" — *not* a
capability or a containment boundary. Concretely we retain three workingDir-driven,
now-unconditional mechanisms, all framed as parity-convenience + resource hygiene:

- **`process.cwd()` → `workingDir`.** We do **not** install an inert/denying shim. The
  worker keeps the **real `process`** (full env, real `argv`/`execPath`/`exit`/`kill`/…);
  the ONLY adjustment is `process.cwd` is overridden to return `workingDir` when present
  (worker threads can't `chdir`). This hides nothing.
- **Async-spawn default `cwd` + child pid tracking** (the layer-2 SIGKILL net) and
  **sync-child timeout bounding** — retained verbatim from Phase 2's
  `installChildProcessTracking`, but now installed **unconditionally** (any pack may
  spawn children now that `child_process` is ambient, so the kill-on-terminate net must
  always be armed). An explicit caller `cwd` is still respected verbatim.
- **Leading bare-relative `fs` path rebasing onto `workingDir`** — retained from Phase 2's
  `installFsRebase`, now unconditional, so relative `fs` resolves under the session dir
  consistently with `process.cwd()` (libuv's real cwd is the gateway's). Absolute /
  Buffer / URL paths pass through unchanged; **no rejection** (fs is fully ambient).

> Naming: every retained symbol/comment must drop the words `grant`/`permission`. Rename
> `applyGrantedModuleWraps` → `applySessionDirWraps` (or similar). The retained child
> tracking/fs-rebase code is reframed as "session-working-dir parity + spawned-child
> resource tracking", never "the git/fs grant".

### 2.1 Retained-wrapper contract (exact list)

These are the ONLY behavioral adjustments the worker bootstrap makes to otherwise-ambient
Node. All are **unconditional** (no `permissions:` gate), **driven by `workingDir`**, and
are **tool-parity convenience + layer-2 resource hygiene — never a containment boundary**:

| Wrapped surface | What the wrap does | Why (parity / resource) |
|---|---|---|
| `process.cwd` | Overridden to return `workingDir` when it is a non-empty string; otherwise left as the real cwd. Nothing else on `process` is changed. | Worker threads cannot `process.chdir()`; a tool process is rooted at the session worktree. Required by `pr-walkthrough` `routes.mjs::repoRoot()`. |
| `node:child_process` async spawners (`spawn`/`exec`/`execFile`/`fork`) | Default the `cwd` option to `workingDir` when the caller omits it; an explicit `cwd` (relative or absolute) is respected verbatim, no rebasing, no rejection. Report each spawned child's pid to the parent (`child-spawn`/`child-exit`) so layer-2 SIGKILLs survivors on terminate. | Relative spawns resolve under the session dir (parity); the pid net is the layer-2 child-kill guarantee, now armed for every pack since `child_process` is ambient. |
| `node:child_process` sync spawners (`spawnSync`/`execSync`/`execFileSync`) | Same default-cwd, plus inject a `timeout` clamped below the wall-cap (`boundedSyncTimeout`) + `killSignal: "SIGKILL"`; an explicit caller `timeout` is clamped (`min(explicit, bound)`), never raised. | A blocking sync child can't report its pid (thread frozen), so Node must SIGKILL it before terminate-on-timeout reaps the thread — else the OS child (a child of the MAIN process) orphans. |
| `node:fs` + `node:fs/promises` path-accepting methods (sync + async; both first-arg and the two-path ops `rename`/`copyFile`/`cp`/`link`/`symlink`) | A **leading bare-relative string** path is rebased onto `workingDir` (`path.resolve(workingDir, p)`); absolute strings, `Buffer`, `file:` URL, and fd args pass through unchanged. No path is ever rejected. | libuv's real cwd stays the gateway's even after the `process.cwd` override, so relative fs must be rebased to match `process.cwd()`. Parity only — fs is fully ambient. |

**Known non-parity inherited from worker threads** (documented, not worked around):
`process.chdir()` still throws inside a worker (so the override above is read-only — code
that *calls* `chdir` to change cwd will fail, exactly as in Phase 2); a `.node` native addon
or `process.binding` is reachable (full ambient — this is the whole point: trusted code).
The CJS-wrap-before-ESM-facade ordering in `confinementReady` (apply wraps → import
`path-guard` which creates the `node:fs` facade) is preserved so the pack's `node:fs`
module object reflects the rebasing.

## 3. Server changes — `src/server/extension-host/`

### 3.1 DELETE `permission-grants.ts`
Remove the whole file: `PACK_PERMISSION_VALUES`, `PackPermission`, `GRANT_DENIED_REMOVALS`,
`normalizeGrants`, `hasGrant`, `deniedForGrants`, `keepNetworkGlobals`, `needsRealProcess`.

### 3.2 `module-host-worker.ts`
- Drop the `import { deniedForGrants, needsRealProcess } from "./permission-grants.js"`.
- **Delete the exported `DENIED_BUILTINS` array.**
- `InvokeRequest`: **remove `permissions?`**. **Keep `packRoot`, `workingDir`, `epoch`,
  `exportKind`, `member`, `ctx`, `arg`, `url`.**
- In `invoke(...)`:
  - Delete `grants`, `denied = deniedForGrants(...)`, and the `env = needsRealProcess(...)`
    computation.
  - `new Worker(...)`: **remove the `env` option entirely** so the worker inherits a full
    copy of the gateway env (full-env parity). **Keep `resourceLimits` (mem/stack caps),
    `execArgv: workerSafeExecArgv(...)`, and the `wallCapMs` timer.**
  - `workerData`: send `{ packRoot: req.packRoot, workingDir: req.workingDir, wallCapMs: limit }`
    — **drop `denied` and `permissions`.**
  - **Keep unchanged**: the `live` worker→children map, `child-spawn`/`child-exit` message
    handling, `killChildren`, terminate-on-timeout, crash isolation, the host-call proxy
    allowlist (`PROXYABLE`), `dispose()`. Update the comments that mention
    "declared-permission `git`" / "deny-all" to the new framing (resource isolation +
    module-root hygiene).

### 3.3 `module-host-bootstrap.ts`
- Drop the `permission-grants` import (`keepNetworkGlobals`, `needsRealProcess`, `hasGrant`).
- `BootstrapData`: **remove `denied` and `permissions`**; keep `packRoot?`, `workingDir?`,
  `wallCapMs?`.
- Delete `const grants = …`. Delete the `realProcess` capture used only for the shim env.
- **Delete `removeAmbientGlobals`** (no network-global stripping, no inert/denying process
  shim, no env minimization). Replace it with a small `setSessionCwd(workingDir)` that, when
  `workingDir` is a non-empty string, overrides **only** `process.cwd` on the real process
  global: `process.cwd = () => workingDir`. Nothing else about `process` is touched (full
  env, real `exit`/`kill`/`argv`/`binding`/… all present).
- `confinementReady` sequence (KEEP the ordering + the gate):
  1. `applySessionDirWraps(workingDir, wallCapMs)` — unconditionally install the child-process
     tracking/default-cwd/sync-bounding wrap **and** the fs bare-relative rebasing wrap
     (when `workingDir` present). These are the renamed, de-gated `installChildProcessTracking`
     + `installFsRebase`. The ordering rationale stays: apply the CJS `child_process`/`fs`
     wraps **before** the `node:fs` ESM facade is created (i.e. before `path-guard` is
     imported in step 2).
  2. `const { isPackPathWithinGroup } = await import("./path-guard.js");` then
     `configureConfinement({ packRoot: data.packRoot, isWithin: isPackPathWithinGroup })`
     (no `denied`), then `registerHooks({ resolve: confinementResolve })`.
  3. `setSessionCwd(data.workingDir)`.
- Keep `withDefaultCwd`, `withBoundedSyncChild`, `boundedSyncTimeout`,
  `installChildProcessTracking` (renamed-free of grant language), `installFsRebase`
  (now always called when `workingDir` set). Keep `handleInvoke`, the host-API proxy,
  export-map validation, the `port.on("message")` gating on `confinementReady`.

### 3.4 `confinement-loader.ts`
- `ConfinementConfig`: **remove `denied`**; keep `packRoot?` + `isWithin?`.
- Delete `deniedSegments` state, the `firstSegment` helper, and the deny-list branch in
  `resolve` (`if (deniedSegments.has(seg) …) throw`). `resolve` now just calls
  `nextResolve` then `enforceContainment` (when `packRoot` set).
- **Keep `enforceContainment`** (pack-root realpath containment via the shared path-guard)
  and the fail-closed "no guard injected while packRoot set" behavior.
- Rewrite the file header: two layers → "this is module-IMPORT containment (loader/stability
  hygiene), not a security boundary". Remove the deny-list description.

### 3.5 `action-dispatcher.ts` + `route-dispatcher.ts`
- Remove `permissions?` from the resolver-location return type (`ActionToolLocationResolver`
  / `RouteToolLocation`), from `resolveModulePath`/`resolveModuleUrl` return shapes and the
  destructuring, the cache-hit return, and the `ModuleHost.invoke({ … })` call (drop the
  `permissions: resolved.permissions` field). **Keep `workingDir: ctx.workingDir`** in the
  invoke request and **keep `ActionHandlerCtx.workingDir`** (reframe its comment from
  "declared-permission" to "session working dir — the worker's `process.cwd()` for tool
  parity"). Update all "Slice C3 / declared-permission grant" comments accordingly.

## 4. Manifest / wire — `src/server/agent/`

### 4.1 `tool-contributions.ts`
- Remove `import { PACK_PERMISSION_VALUES, type PackPermission } …` and the
  `export type { PackPermission }`.
- Remove the `permissions?: PackPermission[]` field on `ToolContributions`.
- Remove the `if (obj.permissions !== undefined) { … }` parse branch in
  `parseContributions`.
- **Delete `parsePermissions`** entirely.
- Remove every comment mention of `permissions` (the file-header comment, the
  reserved-keys comment). **Do NOT add a `permissions`-named branch or tolerance** — a stray
  key falls through the existing generic behavior (unknown top-level keys are simply not
  read; `RESERVED_KEYS` stays `[]`).

### 4.2 `tool-manager.ts`
- Remove `permissions?: string[]` from `resolveToolLocation`'s return type and the
  `permissions: c.permissions` line.

### 4.3 `server.ts`
- Remove `import { normalizeGrants } from "./extension-host/permission-grants.js"`.
- In the `/api/ext/action` endpoint handler (the `[ext-action]` audit block): delete the
  `actionGrants`/`actionPerms` locals and remove the `${actionPerms}` field from the
  `[ext-action]` `console.log`. **Keep the `actionWorkingDir` resolution** and its threading
  into `dispatcher.dispatch(... workingDir: actionWorkingDir ...)`.
- In the `/api/ext/route/:name` endpoint handler (the `[ext-route]` audit block): delete the
  `routeGrants`/`routePerms` locals and remove the `${routePerms}` field from the
  `[ext-route]` `console.log`. **Keep the `routeWorkingDir` resolution**.
- Leave all unrelated `grant`/`permission` code untouched (tool grant-policy
  `resolveGrantPolicy`, `tool-grant-request`, `viewerPermission`, `permission_denied` JSON,
  storage permission, OAuth grants).

### 4.4 `/api/tools` wire
There is currently **no** `permissions` field on the `/api/tools` `ToolInfo` payload
(verified by grep). The coder must confirm none is emitted; if one exists, remove it.

## 5. Packs — `market-packs/pr-walkthrough/tools/pr-walkthrough/pr_walkthrough.yaml`
- Delete the `permissions: [git, fs]` line **and** the comment block above it that describes
  the grant model. Reword any remaining comment in `pr_walkthrough.yaml` / `routes.mjs`
  that references "grant" / "permission" / "deny" (e.g. `routes.mjs` header lines 6-11,
  the `repoRoot()` comment lines ~181-187) to the new model: child_process/fs are ambient;
  `process.cwd()` is the server-derived session worktree; spawned git is SIGKILLed on
  terminate. **Behavior is unchanged** — git/fs were already fully un-gated under the grant;
  they are now ambient. Verify `routes.mjs` still works (it uses `execFile` with an explicit
  `cwd = process.cwd()`).

## 6. Tests — `tests/`

### 6.1 DELETE `extension-host-permissions.test.ts`
The entire declared-permission model is gone; the file has no replacement.

### 6.2 `extension-host-module-isolation.test.ts` (rewrite the capability parts)
- Drop the `DENIED_BUILTINS` import.
- **DELETE** the deny-hook assertions: the "module-load deny-hook (no ambient
  fs/network/exec)" describe, the top-level static-import-of-builtin denied loop, the
  "deny-list covers every dangerous built-in" test, the "ambient globals removed" describe
  (fetch/process-shim/empty-env/process.exit-inert), and the "empty env (no host secrets)"
  describe.
- **ADD** an "ambient parity" describe pinning **acceptance #1**: a pack module may
  `import("node:child_process")` and `import("node:fs")` (no throw), `typeof fetch ===
  "function"`, and `process.env` is non-empty (read a known env var with no declaration).
  Also assert `process.cwd()` returns the supplied `workingDir` (the parity override) when
  one is passed.
- **KEEP** (layer 2 + layer 3 + proxy): happy-path/identity, unknown-member 404,
  no-`actions`-export 500, `while(1)` top-level + handler terminate→504, memory cap→error,
  crash isolation, host-API proxy round-trip + rejection, and the **file-resolution
  confinement** describe (sibling-ok, `../` reject, absolute-`file:` reject, symlink reject).
  The "built-ins remain denied with a pack root set" test → replace with "a `node:fs` import
  is **allowed** with a pack root set, but a `../` file-escape import is still **rejected**"
  (proving deny-list is gone, containment remains).

### 6.3 `extension-host-isolation-config-invariant.test.ts` (update model)
- Keep the **unconditional-worker** invariant: a dispatcher with no injected `ModuleHost`
  still routes through a worker; `while(1)` is terminated→504 regardless of any
  `BYPASS_ENV_KEYS`; `ActionDispatcherOptions` exposes no bypass switch (structural test
  stays).
- The two tests that assert `node:fs` import stays **denied** must be **flipped**: the
  invariant is no longer "node:fs is denied" (it's ambient now). Re-point them at what IS
  still unconditional: with every bypass env set, a **pack-root `../` escape import is still
  rejected** AND a `while(1)` is still terminated→504. Update the file header to: isolation
  = resource/crash + module-root import hygiene; no capability sandbox; the worker is
  unconditional.

### 6.4 ADD a guard test — `extension-host-no-capability-sandbox-residual.test.ts` (acceptance #2)

> **The test filename and its own contents must contain neither the literal word
> `permission` nor `grant`.** (The goal forbids any "permissions-named test", and the file
> lives in `tests/` which is inside the scanned roots — a literal token in it would be a
> self-inflicted residual hit / exception hole.) Therefore: name it
> `extension-host-no-capability-sandbox-residual.test.ts`, and **build every forbidden-token
> search needle from concatenated fragments at runtime** (e.g. `"permis" + "sion"`,
> `"gr" + "ant"`, `"Pack" + "Permission"`, `"denied" + "ForGrants"`, `"permission" `
> assembled as `["permis","sion"].join("")`) so no complete forbidden token appears as a
> literal anywhere in the test source. Add a one-line comment explaining the fragment trick.

A node:test that walks the working tree (via `fs` + a manual substring scan — no `rg`
dependency) and asserts **zero residual references**. The scan must be scoped to avoid the
many legitimate unrelated `grant`/`permission` hits (tool grant-policy
`GrantPolicy`/`resolveGrantPolicy`, `tool_permission_needed` cards, OAuth device grants,
`viewerPermission`, storage-permission, `permission_denied` HTTP).

**Explicit EXCLUDE set (never scanned — they describe the removal and would self-match):**
`tests/extension-host-no-capability-sandbox-residual.test.ts` (the guard itself) and
`docs/design/extension-host-isolation-simplification.md` (this planning doc). Also skip
`node_modules/`, `dist/`, `.git/`.

The assertions:

1. **Unique sandbox identifiers — zero anywhere** in `src/`, `tests/`, `docs/`,
   `market-packs/` (minus the EXCLUDE set): the fragment-assembled needles for
   `PackPermission`, `deniedForGrants`, `normalizeGrants`, `keepNetworkGlobals`,
   `needsRealProcess`, `GRANT_DENIED_REMOVALS`, `parsePermissions`, `permission-grants`,
   `PACK_PERMISSION_VALUES`. These names are unique to the deleted sandbox so they cannot
   false-positive.
2. **Extension-host source/test/pack surface — zero `permission` or `grant`** (case-
   insensitive, fragment-assembled needles) in this exact file set: every file under
   `src/server/extension-host/`, `src/server/agent/tool-contributions.ts`,
   `tests/extension-host-module-isolation.test.ts`,
   `tests/extension-host-isolation-config-invariant.test.ts`, and every file under
   `market-packs/pr-walkthrough/`. (After the rewrite these legitimately contain neither
   word.)
3. **`permission-grants.ts` no longer exists** on disk (build the path from fragments too).
4. **Extension-host docs — zero sandbox-framing terms** in `docs/design/extension-host.md`,
   `docs/design/extension-host-phase2.md`, `docs/marketplace.md`,
   `docs/extension-host-authoring.md`: the fragment needles for `PackPermission`,
   `deniedForGrants`, `permission-grants`, `per-capability`, `capability sandbox`,
   `declared-permission`, `deny-all`, and the manifest key token `permissions:`. (Bare
   `grant`/`permission` is NOT asserted here — `docs/marketplace.md` may legitimately
   discuss tool grant policy.)

**Do NOT** add any forbidden-token-named positive test.

### 6.5 pr-walkthrough E2E
`tests/e2e/ui/pr-walkthrough-pack.spec.ts` must still pass unchanged behaviorally. Its
prose mentions `permissions: ["git","fs"]`; update those comments to the ambient model
(this file is **not** in the guard-test surface set, so comment wording is free, but keep
it accurate). The test itself drives the same live `git diff` against the session worktree.

## 7. Docs — `docs/`
Delegated to the documentation gate (docs-writer):
- `docs/design/extension-host.md` §3.4 and `docs/design/extension-host-phase2.md` §9/C3:
  restate isolation as **resource/crash isolation + module-root import hygiene only**.
  Remove the permissions-as-disclosure framing, the PATH-only-env claim, and the dependent
  *"no `host.model.*` because the worker holds no credentials"* rationale (note a trusted
  pack could do its own inference — same as a tool).
- `docs/marketplace.md`: update the "Why?" risk disclosure, drop the `permissions:` row from
  the extension-contributions table, and rewrite Limitations to the honest model.
- `docs/extension-host-authoring.md`: remove the `permissions:` authoring section, the
  contributions-table row, the bundling-note permission references, and the
  `permission-grants.ts` mention in the "where it lives" list.

## 8. Acceptance checklist (must hold IN CODE)
1. Pack module imports `node:child_process`/`node:fs`, calls `fetch`, reads `process.env`
   with no declaration — pinned (6.2).
2. Zero residual references — pinned (6.4).
3. Layer-2 resource/crash isolation intact (terminate-on-timeout, mem/stack caps, child
   SIGKILL) — existing tests green (6.2/6.3 keep them).
4. Layer-3 pack-root import containment still rejects an escaping import — pinned (6.2/6.3);
   documented as hygiene (§7).
5. `pr-walkthrough` pack still functions with `permissions:` removed — E2E green (6.5).
6. `HOST_API_VERSION` stays `1`; v1 host-api types compile unchanged (no Host-API change).
7. `npm run check`, `test:unit`, `test:e2e` green.

## 9. Constraints
Primary branch `master`, LF, commit co-author trailer. Preserve the `buildPackList`
byte-identical invariant + tool-description + AGENTS.md byte budgets (unaffected — this is a
manifest-key removal). Reuse the existing epoch-guarded module cache, per-session guard, and
generation-guarded registry chokepoint. Keep tolerant per-tool parsing via the EXISTING
generic unknown-key handling only — never a `permissions`-named branch.
