# Restore PR Walkthrough UX

**Status:** design — implementation-ready
**Goal:** Restore the PR Walkthrough feature to its pre-pack-migration user journey
(a first-class reviewer child whose walkthrough pane lives *with that child's
session*), and fix the role-resolution bug that currently makes the reviewer child
unusable.

This doc **builds on** the locked decisions in
[`pr-walkthrough-host-agents-migration.md`](pr-walkthrough-host-agents-migration.md)
(Decisions A–F) and the current pack flow in
[`../pr-walkthrough-panel.md`](../pr-walkthrough-panel.md). It does **not**
relitigate those decisions — the `host.agents`-minted, role-granted, no-secret,
binding-routed reviewer is the foundation. It fixes how that reviewer's **role
resolves** at two code paths, adds **one-click auto-run**, hardens the **poll
loop**, and (the largest piece) **re-keys the pane to the reviewer child session**
plus the **Host-API addition** that makes that possible.

---

## 1. Summary & goals

### The target user journey

1. User clicks **PR Walkthrough** in the git status widget.
2. A read-only reviewer child agent **auto-spawns** off the session being viewed
   (no extra "Run" click). It is a first-class session in the sidebar with the
   `review` accessory.
3. The walkthrough **pane lives with the reviewer child session** (rendered beside
   that child's chat), showing a **pending** state while analysis runs.
4. The reviewer consumes the PR bundle, analyses it, and calls
   `submit_pr_walkthrough_yaml`.
5. On submit, the pane flips to the **ready** review (orientation beats, design
   choices, diffs, audit) in that same child-session pane.

### Four work areas

| Area | What | Risk |
|---|---|---|
| **A** | Role-resolution bug fix (root cause — **must land first**) | low–med |
| **B** | One-click auto-run from the git widget | low |
| **C** | Poll-loop timeout robustness | low |
| **D** | Child-session pane + the Host-API addition (largest piece) | med–high |

### Non-negotiable constraints (carried from the migration doc)

- Primary branch `master`; LF endings; co-author trailer on commits.
- **Build-artifact handling (reconciled with the goal spec's wording).** The goal
  spec calls `lib/panel.js` / `lib/routes.mjs` "hand-mirrored bundles of `src/` …
  (no esbuild)". That parenthetical is imprecise; the **source of truth is
  `scripts/build-market-packs.mjs`** (`PACKS["pr-walkthrough"]`), which shows two
  distinct cases:
  - **`lib/panel.js` IS esbuild-bundled** from `src/panel.js`
    (`{ in: "panel.js", out: "lib/panel.js" }`) by `npm run build:packs`. Edit
    `src/panel.js`, run `npm run build:packs`, and **commit both** `src/panel.js`
    and the regenerated `lib/panel.js`. Do **not** hand-edit `lib/panel.js`.
  - **`lib/routes.mjs` is HAND-AUTHORED, NOT bundled** — it is committed source
    served as-is (the build script only *relocates* it to `lib/`, with the comment
    "a pack's hand-authored `.mjs` server modules … are NOT bundled"). Edit
    `lib/routes.mjs` directly. There is no `src/routes.mjs`.
  So the spec's "hand-mirror" intuition is literally true for `routes.mjs` but NOT
  for `panel.js` (which must be regenerated via esbuild). CI runs `build:packs` in
  `build`, so a forgotten rebuild is caught, but the committed artifacts must match.
- Do **not** weaken the security model: the `PR Walkthrough` group stays
  default-deny for every other role; only `pr-reviewer` re-grants it; no
  submit-proof secret is reintroduced.
- **Pack purity is a gate criterion.** The pack uses only the **versioned Host
  API** and the sanctioned ambient git/fs in its confined worker. It must not
  import or invoke Bobbit platform/server internals. Any new platform capability
  is added to the versioned Host API and consumed through it.

---

## 2. Root-cause analysis (Area A)

### 2.1 The symptom (reproduced)

In session `efff0155-66c8-4fc3-af08-90d5fbe35de8` (PR #750) the reviewer child
spawned with the correct role/accessory/allowlist, yet **every walkthrough tool
call was rejected** with *"Tool X is not permitted for this role"*, and the agent
had no YAML schema so it tried to "learn the schema from validation feedback".

### 2.2 Three role-resolution paths — only one is cascade-aware

`pr-reviewer` is a **pack-shipped** role
(`market-packs/pr-walkthrough/roles/pr-reviewer.yaml`). Pack roles live in the
**config cascade** (`ConfigCascade.resolveRoles(projectId)` →
`RoleLoader` over `<packRoot>/roles/*.yaml`), **not** in the in-memory
`RoleManager`. So `roleManager.getRole("pr-reviewer")` returns `undefined`.

There are three places the reviewer's role is resolved. The table shows which are
cascade-aware today:

| Path | Function | File:line | Cascade-aware? | Consequence if not |
|---|---|---|---|---|
| Spawn-time **allowlist** | `resolveRoleAllowedTools` dep | `server.ts:1205` | **Yes** (cascade-first, then `roleManager`) | — (this is why the allowlist looked right) |
| Tool **guard** + MCP proxy | `_resolveToolActivation` | `session-setup.ts:630` | **No** (`roleManager.getRole` only) | `effectiveRole = undefined` → guard falls back to **group defaults** → `PR Walkthrough: never` → the three tools get `never` guard entries → **every call rejected** |
| Restore / force-respawn | `resolveSessionRole` | `session-manager.ts:1646` | **No** (`roleManager.getRole` only) | a reviewer surviving a gateway restart re-resolves to `undefined` → loses its tools again |
| Role **promptTemplate** (schema) | `resolveRolePromptTemplate` | `session-manager.ts:4453` | **Yes** (cascade-first via `configCascade.resolveRolePromptTemplate`, then `roleManager`) | — (verified; see §2.4) |

The **guard** is the smoking gun. `_resolveToolActivation` feeds `effectiveRole`
into **both** `writeMcpProxyExtensions` and `writeToolGuardExtension`. The guard
extension is emitted whenever any tool resolves to `ask`/`never`; with
`effectiveRole = undefined` the cascade falls through to `groupPolicyStore`
defaults, where `PR Walkthrough: never` (`defaults/tool-group-policies.yaml`)
stamps `never` on `readonly_bash`, `read_pr_walkthrough_bundle`, and
`submit_pr_walkthrough_yaml`. The agent holds the tools in its allowlist (spawn
path resolved them) but the guard rejects every call — exactly the reported
symptom.

### 2.3 The fix pattern is already in the file

`session-setup.ts` already has a **cascade-first role resolver**, `lookupRole`
(`session-setup.ts:461`):

```ts
function lookupRole(name: string, plan: SessionSetupPlan, ctx: PipelineContext): Role | undefined {
  if (plan.projectId && ctx.configCascade) {
    const resolved = ctx.configCascade.resolveRoles(plan.projectId);
    const match = resolved.find(r => r.item.name === name);
    if (match) return match.item;
  }
  return ctx.roleManager?.getRole(name);
}
```

`PipelineContext` exposes both `roleManager` (`session-setup.ts:217`) and
`configCascade` (`session-setup.ts:228`); the plan carries `projectId`
(`session-setup.ts:181`). The fix in `_resolveToolActivation` is a one-line swap to
`lookupRole`. The same cascade-first-then-`roleManager` shape is what
`server.ts:1205` and `resolveRolePromptTemplate` already use.

### 2.4 The promptTemplate (schema) path — verified OK

`resolveRolePromptTemplate` (`session-manager.ts:4453`) is already cascade-first
(`configCascade.resolveRolePromptTemplate(roleName, projectId)` →
`roleManager.getRole(roleName)?.promptTemplate`), so the pack role's
`promptTemplate` — which carries `REQUIRED_YAML_SCHEMA_PROMPT` — **does** reach a
restored reviewer's system prompt **provided** a `projectId` is in scope.

The **spawn-time** prompt arrives a different way and must be confirmed: the
reviewer child is minted by the `run` route via `host.agents.spawn({ role:
"pr-reviewer", … })`. `OrchestrationCore.spawn` uses the full lifecycle
(`createSession`), which resolves `roleName → role` and applies the role's
`promptTemplate` + `accessory`. **Action for the implementer:** confirm the
`createSession` rolePrompt path resolves the pack role's `promptTemplate` via the
cascade (it should, since `assemblePrompt` runs through the same `resolveRoles`
machinery for a `projectId`-scoped session). If the spawn path resolves the role
via `roleManager` only, thread the cascade lookup there too. The reviewer child's
`projectId` is inherited from the owner; verify it is non-empty for a project
session (the reproducing session was project-scoped, so the guard bug — not a
missing projectId — was the actual fault). Pin with the E2E schema-in-prompt
assertion (§5).

---

## 3. Per-area design

### Area A — role-resolution bug fix

**A1. `session-setup.ts::_resolveToolActivation` (`:630`).** Replace the
`roleManager`-only lookup with the existing cascade-first helper:

```ts
// before:
const effectiveRole = (plan.roleName && ctx.roleManager) ? ctx.roleManager.getRole(plan.roleName) : undefined;
// after:
const effectiveRole = plan.roleName ? lookupRole(plan.roleName, plan, ctx) : undefined;
```

`lookupRole` already lives at `session-setup.ts:461` and resolves
`configCascade.resolveRoles(plan.projectId)` first, falling back to
`roleManager.getRole`. `effectiveRole` flows unchanged into
`writeMcpProxyExtensions` and `writeToolGuardExtension`; with the real
`pr-reviewer` role resolved, its `toolPolicies: { "PR Walkthrough": allow }` beats
the group default, so the guard emits **no `never` entry** for the three tools.

**A2. `session-manager.ts::resolveSessionRole` (`:1646`).** Make it cascade-aware
and give it a `projectId`:

```ts
private resolveSessionRole(roleName?: string, assistantType?: string, projectId?: string): Role | undefined {
  const name = roleName || (assistantType ? "assistant" : "general");
  if (projectId && this.configCascade) {
    try {
      const match = this.configCascade.resolveRoles(projectId).find(r => r.item.name === name);
      if (match) return match.item;
    } catch { /* fall through */ }
  }
  return this.roleManager?.getRole(name);
}
```

Thread `projectId` from both call sites:
- **Restore path** (`session-manager.ts:3610`): `this.resolveSessionRole(ps.role, ps.assistantType, ps.projectId)` — `ps.projectId` is in scope (used at `:3626`, `:3631`).
- **Force-respawn path** (`session-manager.ts:6478`): `this.resolveSessionRole(session.role, session.assistantType, session.projectId)` — `session.projectId` is available (used immediately below at `:6491` `resolveInitialModel(session.role, session.projectId)`).

This keeps a reviewer's tools through a gateway restart and a force-abort respawn.

**A3. promptTemplate path.** No code change expected (already cascade-first, §2.4);
**verify** the spawn `createSession` rolePrompt path and, only if it resolves via
`roleManager` alone, apply the same cascade-first fix there. Document the finding
in the PR description either way.

**A4. Data-flow recap (after the fix):**

```
host.agents.spawn({role:"pr-reviewer"})  (run route)
  → OrchestrationCore.spawn → childAllowedTools(owner, readOnly, "pr-reviewer")
        → resolveRoleAllowedTools("pr-reviewer", ownerProjectId)         [server.ts:1205 — cascade-first ✓]
        → child allowlist = [readonly_bash, read_pr_walkthrough_bundle, submit_pr_walkthrough_yaml]
  → createSession (full lifecycle):
        roleName "pr-reviewer" → role (cascade) → accessory "review", promptTemplate (schema) ✓
        → session-setup.resolveToolActivation:
              effectiveRole = lookupRole("pr-reviewer")                  [FIX A1 — cascade-first ✓]
              → guard has NO `never` for the three tools                  ← was the bug
```

### Area B — one-click auto-run from the git widget

**Today.** The git-widget entrypoint
(`entrypoints/pr-walkthrough-git-widget.yaml`) has `target: { route:
pr-walkthrough }` with **no params**. `navigateToTarget` (`pack-entrypoints.ts:266`)
serializes `#/ext/pr-walkthrough` and `main.ts:198` opens the panel with only the
params named in the route's `paramKeys`. The route entrypoint
(`pr-walkthrough-route.yaml`) declares `paramKeys: [jobId, baseSha, headSha]`. The
panel then shows a **Run** button needing a second click.

**B1. Plumb an `autorun` param.** Two edits, both in the pack:
- `entrypoints/pr-walkthrough-route.yaml`: add `autorun` to `paramKeys` →
  `paramKeys: [jobId, baseSha, headSha, autorun]`. (paramKeys gate which query
  params survive both `navigateToTarget`'s filter at `pack-entrypoints.ts:277` and
  the reload-restore filter at `main.ts:199`.)
- `entrypoints/pr-walkthrough-git-widget.yaml`: add params to the target →
  ```yaml
  target:
    route: pr-walkthrough
    params:
      autorun: true
  ```
  `navigateToTarget` serializes `#/ext/pr-walkthrough?autorun=true`. The deep-link
  and the other launchers (open / palette) keep their bare target (no `autorun`),
  so they still land on the manual-Run panel.

Query params arrive as **strings** (`routing.ts` `extParams` is
`Record<string,string>`), so the panel reads `params.autorun === "true" ||
params.autorun === true`.

**B2. Panel: invoke `onRun` once on mount when `autorun`.** In
`src/panel.js::render`, after the existing param/`entry` setup and before the
returned template, add a guarded one-shot:

```js
const wantsAutorun = params && (params.autorun === true || params.autorun === "true");
// The git-widget CLICK is the user gesture; this is not an auto-invoke-on-mount of
// a passive panel. Consume once per (session) key so a reload / re-render never
// re-triggers; the `run` route's idempotency is the backstop if it somehow does.
if (wantsAutorun && status === "idle" && !entry.bundle && !entry.autorunConsumed && hasSession && !busy) {
  byJob.set(paramKey, { ...entry, autorunConsumed: true });
  queueMicrotask(() => { void onRun(); });   // after render; onRun sets status:"running"
}
```

- The **consumed flag** (`autorunConsumed`, stored in the `byJob` entry) prevents a
  re-render or a same-page navigation from re-triggering.
- A **browser reload** re-creates `byJob` empty, but: (a) the route's idempotency
  (`reviewerKey(parent, canonicalKey)`) returns the existing live reviewer rather
  than spawning a duplicate, and (b) after the first run the entry is no longer
  `idle`/bundle-less. Reload during the brief `idle` window is the only re-trigger
  path and the route dedupes it — exactly the "rely on `run` idempotency as the
  backstop" requirement.
- The **manual "Run" affordance stays** for the deep-link / no-autorun case
  (unchanged `showActions` branch).

**B3. Invariant reconciliation.** The pack-panel contract says a panel "MUST NOT
auto-invoke actions / navigate on mount" (`pack-panels.ts` `PackPanel` doc, v1 §5
v). That invariant guards against a *passive* panel firing server work the user
never asked for. Here the **git-widget selection IS the user gesture** — it is the
moral equivalent of clicking Run — and `autorun` only fires from the entrypoint
that carries it. The honesty is preserved by: (i) `autorun` is opt-in per
entrypoint (only the git widget sets it); (ii) the consumed flag makes it
strictly one-shot; (iii) the deep-link route never carries `autorun`, so a
reload-restored deep link still requires a manual click. Document this carve-out in
`docs/pr-walkthrough-panel.md` (the "Launch model" section) and in the panel source
comment.

### Area C — poll-loop timeout robustness

**Today.** `src/panel.js` sets `RUN_TIMEOUT_MS = 120_000`. The poll loop
(`onRun`) gives up with *"The reviewer didn't produce a walkthrough — try again"*
after 2 minutes even while the reviewer is still actively working a non-trivial PR.
The `status` route already distinguishes **alive-but-slow** from **terminal**: it
returns `phase:"error"` only when `host.agents.status(child) === "terminated"`
without a `submitted/<jobId>` marker; otherwise `phase:"running"`.

**C1. Poll while the child is alive; only the route's terminal verdict ends it.**
Change the loop so the deadline is **not** a hard error while the child is alive.
Concretely, in `src/panel.js::onRun`:

- Raise `RUN_TIMEOUT_MS` substantially (e.g. `30 * 60_000` = 30 min) as an absolute
  safety cap, **and**
- Treat crossing the soft deadline as a **"still running"** surface, not an error,
  as long as the latest `status` is `phase:"running"`. Only `phase:"error"`
  (route-confirmed terminal-without-submit) or `phase:"submitted"` end the loop.

Recommended shape (keeps the existing state machine; adds a `running`-with-elapsed
hint and a long hard cap):

```js
const HARD_CAP_MS = 30 * 60_000;          // absolute backstop
const SLOW_HINT_MS = 120_000;             // after this, show "still reviewing…"
const startedAt = Date.now();
while (Date.now() - startedAt < HARD_CAP_MS) {
  const cur = byJob.get(key);
  if (!cur || cur.status !== "running") return;      // user acted
  let st; try { st = await host.callRoute("status", { method:"POST", body:{ childSessionId, jobId } }); }
  catch { st = undefined; }
  if (st && st.phase === "submitted") { /* publishAndLoad … */ return; }
  if (st && st.phase === "error")     { /* status:"error" … */   return; }
  // phase:"running" (or a transient status fetch failure) — keep polling. After
  // SLOW_HINT_MS, surface a non-error "still reviewing" hint WITHOUT leaving the
  // running state (the child is alive; only the route's terminal verdict errors).
  if (Date.now() - startedAt > SLOW_HINT_MS) {
    byJob.set(key, { ...byJob.get(key), status:"running", slow:true });
    host.requestRender?.();
  }
  await sleep(POLL_INTERVAL_MS);
}
// Hit the absolute cap while STILL running — this is the only "ran too long"
// outcome, and it is rare. Surface a retry, not a silent failure.
byJob.set(key, { status:"error", error:"The reviewer is taking unusually long — check its session, or run again." });
host.requestRender?.();
```

`statusText` gains a `slow` branch ("Still reviewing the PR (this can take a few
minutes)…"). The key behaviour: a long-but-progressing reviewer is **never** turned
into an error by the 2-minute clock; only a route-confirmed terminal child, or the
30-minute hard cap, ends the loop. This is a `src/panel.js`-only change (rebuild
`lib/panel.js`).

### Area D — child-session pane (the largest piece; route/key re-keying reconciled here)

#### D.0 The problem

Today the pane renders in the **owner** session's view:
- The panel's per-session state key is `params.__sessionId`, injected by
  `renderPackPanelContent` (`pack-panels.ts`) as the **currently-selected** session
  — which, on launch, is the owner.
- `onRun`'s poll loop runs with the **owner's** `host` (so `ctx.sessionId =
  owner`).
- `status` authorizes via `binding.parentSessionId === ctx.sessionId` (owner-keyed)
  and `recover` reads `last/<ctx.sessionId>` (owner-scoped).

The target UX: the pane lives **with the reviewer child session** — pending while
analysing, ready cards after submit — beside that child's chat.

#### D.1 Strategy: write results under the CHILD key; navigate to the child; authorize status/recover from the child side

The cleanest reconciliation keeps the poll loop where it starts (owner's `onRun`
closure, owner host — so `status` stays **parent-authorized**, no new race) but:
1. **Re-keys the panel state to the child session.** `onRun`, once `run` returns
   `{ childSessionId }`, writes its `byJob` entries under the **child** session key
   (`childSessionId`) instead of the owner's `paramKey`. The panel's `__sessionId`
   is already the per-session key, so when the user is viewing the child session
   the pane reads `byJob[childSessionId]`.
2. **Navigates the UI to the child session** (D.3) so the child's pending pane is
   visible immediately.
3. **Authorizes `status`/`recover` from EITHER side of the binding** (D.2) so the
   child-session pane can poll/recover with `ctx.sessionId = childSessionId`.

This avoids moving the poll loop into a mount-time side effect (which would risk
double-starts), while still surfacing all state in the child pane.

#### D.2 Route + key re-keying (pack-only — `lib/routes.mjs`)

The binding is already keyed `binding/<childSessionId>` and carries
`parentSessionId`. The changes authorize the **child side**:

**`status` — accept the child self-lookup.** Today (`lib/routes.mjs` `status`):
```js
if (!binding || binding.jobId !== jobId || binding.parentSessionId !== ctx.sessionId)
  return { phase:"error", error:"unknown or mismatched binding" };
```
Change the authorization to accept **either** the bound owner **or** the bound
child as the caller:
```js
const isOwner = binding.parentSessionId === ctx.sessionId;
const isChild = childSessionId === ctx.sessionId;   // the reviewer child viewing its own pane
if (!binding || binding.jobId !== jobId || !(isOwner || isChild))
  return { phase:"error", error:"unknown or mismatched binding" };
```
Right-job routing is preserved: the caller must still match the binding's
`jobId` **and** be one of the two principals named in that binding. A foreign
session (neither owner nor the named child) is still rejected. The submitted-YAML
read stays keyed to the verified `binding.jobId`.

**`recover` — add a child self-lookup branch.** Today (`lib/routes.mjs` `recover`)
reads only the owner-scoped `last/<ctx.sessionId>` pointer. Add a child-scoped
branch **first**: if the caller is itself a bound reviewer child, resolve the
submitted YAML directly from its own binding (no new `last/<child>` key needed):
```js
recover: async (ctx) => {
  const me = strOf(ctx && ctx.sessionId);
  if (!me) return { found:false };
  const store = ctx.host.store;
  // CHILD self-recover: the reviewer child's pane re-renders from its OWN binding.
  const selfBinding = await store.get(bindingKey(me));
  if (selfBinding && typeof selfBinding === "object" && strOf(selfBinding.jobId)) {
    const submitted = await store.get(submittedKey(selfBinding.jobId));
    if (submitted && strOf(submitted.yaml)) {
      return { found:true, jobId:selfBinding.jobId, yaml:submitted.yaml,
               baseSha:submitted.baseSha ?? selfBinding.baseSha,
               headSha:submitted.headSha ?? selfBinding.headSha };
    }
  }
  // OWNER recover (unchanged): the owner-scoped last/<owner> pointer.
  const pointer = await store.get(lastKey(me));
  /* …unchanged… */
}
```
This is the `reviewerBinding/<childSessionId>` self-lookup the goal sketches,
realized on the **existing** `binding/<childSessionId>` key (no extra key, no
schema change). It is authorization-correct: only the bound child can resolve its
own `binding/<me>`, and the submitted YAML is keyed by that binding's jobId.

**`run` — no key change.** `run` still runs from the **owner** session (the
launch gesture happens in the owner's pane before navigation), so `ctx.sessionId =
owner` and `parentSessionId = owner` as today. The binding already records both
`parentSessionId` and is keyed by `childSessionId`, which is exactly what D.2's
status/recover branches need.

**Panel state re-key (`src/panel.js`).** In `onRun`, after `run` returns:
```js
const childKey = started.childSessionId;            // re-key to the CHILD session
byJob.set(childKey, { status:"running", jobId: started.jobId });
host.ui?.openPanel?.({ panelId: PANEL_ID, sessionId: childKey, params: {} }); // D.3
// …poll loop writes byJob[childKey] (publishing / rendered / error) and uses the
// owner host for status (parent-authorized). The owner's own paramKey is cleared
// to idle so the owner pane stops showing the launch state.
byJob.set(paramKey, { status:"idle" });
```
On reload, the child pane renders with `__sessionId = childKey`, finds `byJob`
empty, and its **Load** gesture (or an autorun-equivalent recover) calls `recover`,
which now self-resolves from `binding/<childKey>` (D.2) and re-publishes the cards.

#### D.3 Host-API addition — open a pack panel in a chosen session's view

There is **no** current Host-API way to open a pack panel in a *chosen* session's
view: `openPanel`/`mountPackPanelTab` bind to `currentSessionIdForPanel()`
(`pack-panels.ts`), i.e. `state.selectedSessionId`. The pack must **not** reach into
`state` or router internals (pack purity). So we add a **versioned, additive**
field to the structured panel target.

**Contract change (`src/shared/extension-host/host-api.ts`).** Extend `PanelTarget`
with an optional `sessionId`:
```ts
export interface PanelTarget {
  panelId: string;
  params?: Record<string, unknown>;
  /** CONTRACT v2: open/focus the panel in THIS session's view (selecting it if
   *  needed), instead of the currently-active session. Omitted ⇒ active session
   *  (v1 behaviour). Packs MUST feature-detect via `host.contractVersion >= 2`. */
  sessionId?: string;
}
```
Bump `HOST_CONTRACT_VERSION` from `1` to `2` (the data/addressing-contract version;
adding an optional field is additive — `HOST_API_VERSION` stays `1`). `openPanel`
is an existing `ui` capability, so no new capability flag is required; packs
feature-detect the **field** support via `host.contractVersion >= 2` and fall back
to opening in the current view (then the navigation in D.3 still selects the child,
so the pane is correct on the next render either way).

**Client plumbing (`src/app/pack-panels.ts` + `src/app/host-api.ts`).**
- `host-api.ts:324`: `openPanel: (target) => openPackPanel(target, surface?.packId)`
  — unchanged signature; `target.sessionId` now flows through.
- `pack-panels.ts::openPackPanel(target, callerPackId)`: thread
  `target.sessionId` to `mountPackPanelTab`.
- `pack-panels.ts::mountPackPanelTab(reg, params, sessionId?)`: when `sessionId`
  is provided, (a) **select that session** (`state.selectedSessionId = sessionId`,
  via the existing session-select path so the sidebar + main view update) and
  (b) mount/focus the pack tab under **that** `sessionId` (today it derives `sid`
  from `state.selectedSessionId`; use the explicit `sessionId` when given). Keep it
  guarded for non-DOM/unit contexts exactly as today.

This is the single sanctioned way the pack drives "show this pane in the child's
view"; it touches **no** platform navigation code from inside the pack.

**Docs gate follow-up.** Document the new `PanelTarget.sessionId` field and the
`HOST_CONTRACT_VERSION` bump in
[`../extension-host-authoring.md`](../extension-host-authoring.md) (the `host.ui`
surface section) and note the additive-but-bumped rationale. Flag this as a
docs-gate item.

#### D.4 The reviewer child must remain viewable after submit

The pane shows **ready cards in the child-session pane** *after* submit. The submit
path **server-dismisses** the reviewer (terminal-synchronous reap, migration
Decision E). **Reconciliation requirement:** dismissing the reviewer must reap its
orchestration handle + worktree **without removing the session from the sidebar /
making it unselectable** — otherwise the child pane has nowhere to render. Confirm
in implementation that a dismissed `host-agents` child remains a selectable
(terminal/archived) session whose pack-panel tab still renders; the pane's data
(binding + submitted YAML) persists in the pack store regardless of the agent
lifecycle, and `recover` (D.2 child branch) re-resolves it. If the current dismiss
removes the session from the sidebar, the minimal fix is to keep the session record
viewable on dismiss (reap worktree + mark terminal, do not delete the session view)
— a Group-1/Group-3 server consideration. **Risk R3** tracks this.

---

## 4. Host-API contract change (exact surface)

| File | Change | Version |
|---|---|---|
| `src/shared/extension-host/host-api.ts` | `PanelTarget.sessionId?: string` (optional) | `HOST_CONTRACT_VERSION 1 → 2`; `HOST_API_VERSION` unchanged (`1`) |
| `src/app/pack-panels.ts` | `openPackPanel` threads `target.sessionId` → `mountPackPanelTab(reg, params, sessionId?)`; when set, select that session + mount the tab under it | — |
| `src/app/host-api.ts` | none (signature unchanged; `target.sessionId` flows through) | — |
| `docs/extension-host-authoring.md` | document the new field + version bump (docs gate) | — |

Feature-detection contract: a pack relies on session-targeted open **only** when
`host.contractVersion >= 2`; otherwise it opens in the active view and relies on the
session-select side effect. No capability flag is added (`openPanel` already exists
under the `ui` capability).

---

## 5. Test plan (acceptance criterion → test)

| # | Acceptance criterion | Test (new / extended) | Phase |
|---|---|---|---|
| A1 | The generated tool **guard** for `pr-reviewer` contains **no `never`** entry for `readonly_bash` / `read_pr_walkthrough_bundle` / `submit_pr_walkthrough_yaml` | **New unit**: drive `writeToolGuardExtension` (or assert via `resolveGrantPolicy` over the cascade-resolved `pr-reviewer` role + `groupPolicyStore`) and assert none of the three resolve to `never`. Complements the existing `tests/pr-walkthrough-role-tools-policy.test.ts` (which proves the *role* policy; this proves the *guard generation* path that was bugged). | unit·node |
| A2 | A spawned reviewer child can actually **call** ALL THREE tools (not merely hold them) | **Extend** `tests/e2e/pr-walkthrough-host-agents.spec.ts`: after `run`, assert the child's guard does not block **any** of the three. Drive each through its real path with the child secret and assert **none** is rejected as "not permitted for this role": (i) `read_pr_walkthrough_bundle` (bundle endpoint); (ii) `readonly_bash` (a read-only `git`/`gh` command admitted by `walkthrough-readonly-policy.ts`); (iii) `submit_pr_walkthrough_yaml` (submit-yaml endpoint with a minimal valid YAML → routed to the bound job, not a role-permission rejection). Covering all three is mandatory: the reported failure class was that `readonly_bash`/`submit_pr_walkthrough_yaml` could stay blocked even when `read_pr_walkthrough_bundle` worked, so a one-tool E2E would not pin the regression. Where calling the real tool has side effects, the assertion is specifically that the failure (if any) is NOT a guard "not permitted for this role" rejection. | E2E·api |
| A3 | The YAML schema is present in the reviewer's prompt | **Extend** the same E2E: read the reviewer child's system prompt (prompt-sections API / persisted snapshot) and assert it contains `submit_pr_walkthrough_yaml` schema markers (`schema_version`, `merge_assessment`). | E2E·api |
| A4 | Reviewer survives a gateway restart with its tools | **New/extend** restart test: spawn reviewer → simulate restart → assert `resolveSessionRole(ps.role, …, ps.projectId)` resolves the cascade role and the restored allowlist + guard still grant the three tools. | E2E·api |
| B1 | git-widget click → child auto-spawns with **no** second click | **New browser E2E** (`tests/e2e/ui/pr-walkthrough-pack.spec.ts` extension): click the git-widget launcher → assert a reviewer child appears with the `review` accessory and `run` fired exactly once (no Run-button click). | E2E·browser |
| B2 | autorun is one-shot (reload does not double-spawn) | **New browser E2E**: after autorun, reload → assert no second reviewer (route idempotency); `created:false` on the dedup path. | E2E·browser |
| B3 | deep-link / non-autorun keeps the manual Run button | **Extend** browser E2E: open `#/ext/pr-walkthrough` (no `autorun`) → assert the Run button is present and nothing auto-runs. | E2E·browser |
| C1 | A long-but-progressing reviewer is **not** errored by the 2-min clock | **New** unit/browser: drive `status` returning `phase:"running"` past `SLOW_HINT_MS` → assert the panel shows the "still reviewing" hint and **stays** `running` (no error); a `phase:"error"` ends it. | unit·browser |
| D1 | Pane renders **pending** in the **child** session view | **New browser E2E**: autorun → UI navigates to the child session → assert the child's pane shows the pending/"reviewing" state (pane bound to `__sessionId = childSessionId`). | E2E·browser |
| D2 | `status`/`recover` authorize from the child side (right-job routing intact) | **Extend** `tests/e2e/pr-walkthrough-host-agents.spec.ts`: call `status` with `ctx.sessionId = childSessionId` (child self) → succeeds; a foreign session (neither owner nor child) → `phase:"error"`. `recover` from the child self-resolves `binding/<child>` → submitted YAML; from a foreign session → `found:false`. | E2E·api |
| D3 | Submit → **ready cards in the child-session pane**; reload persists | **New browser E2E**: submit (via the direct endpoint with the child secret, as the existing spec does) → assert the child pane flips to ready cards → reload → assert the child pane re-renders the cards via `recover`. | E2E·browser |
| D4 | `PanelTarget.sessionId` opens the panel in the chosen session's view | **New unit** (`pack-panels` fixture): `openPackPanel({panelId, sessionId})` selects that session and mounts the tab under it; `host.contractVersion === 2`. | unit·node |
| D5 | Dismissed reviewer remains viewable | **Extend** restart/cleanup test: after submit + server-dismiss, assert the child session is still selectable and its pane renders. | E2E·api |
| — | Security model unchanged | **Kept** `tests/pr-walkthrough-role-tools-policy.test.ts` (group default-deny; only `pr-reviewer` grants); **kept** the no-secret grep test. | unit·node |

Use the **e2e mock agent** (canned, non-flaky) for all spawn/poll E2E — never
`test:manual` — exactly as `tests/e2e/pr-walkthrough-host-agents.spec.ts` and
`tests/e2e/host-agents.spec.ts` do.

---

## 6. Sequencing & file partitioning for parallel coders

**Order:** A first (proves the reviewer works end-to-end), then B + C (independent,
small), then D (largest; depends on A landing so the reviewer is functional). A
design-doc gate reconciles the D route/key changes before D implementation — this
document is that reconciliation.

| Group | Area | Files (disjoint for parallelism) |
|---|---|---|
| **G1** | A — role resolution | `src/server/agent/session-setup.ts` (`_resolveToolActivation` → `lookupRole`); `src/server/agent/session-manager.ts` (`resolveSessionRole` + the two call sites `:3610`, `:6478`); verify spawn rolePrompt path |
| **G2** | A tests | `tests/pr-walkthrough-role-tools-policy.test.ts` (extend / add guard-generation assertion); `tests/e2e/pr-walkthrough-host-agents.spec.ts` (call-the-tools + schema-in-prompt) |
| **G3** | B + C — panel + entrypoints | `market-packs/pr-walkthrough/src/panel.js` (autorun one-shot + poll-loop change) → rebuild `lib/panel.js`; `entrypoints/pr-walkthrough-git-widget.yaml`; `entrypoints/pr-walkthrough-route.yaml`; `docs/pr-walkthrough-panel.md` |
| **G4** | D — routes + panel re-key | `market-packs/pr-walkthrough/lib/routes.mjs` (`status` child-auth, `recover` child branch); `market-packs/pr-walkthrough/src/panel.js` (child re-key + `openPanel({sessionId})`) → rebuild `lib/panel.js` |
| **G5** | D — Host API + client | `src/shared/extension-host/host-api.ts` (`PanelTarget.sessionId`, version bump); `src/app/pack-panels.ts` (`mountPackPanelTab` sessionId); `docs/extension-host-authoring.md` |
| **G6** | D — server viewability | confirm/keep dismissed reviewer selectable (R3); minimal session-manager change only if needed |
| **G7** | D tests | `tests/e2e/ui/pr-walkthrough-pack.spec.ts` (child-pane pending→ready→reload); api-spec extensions for child-side status/recover |

**Conflict note:** G3 and G4 both edit `src/panel.js`. Sequence them (B+C land
first, then D re-keys) or assign both to one coder — do **not** run two parallel
edits on `src/panel.js`. Everything else is file-disjoint.

---

## 7. Risks

- **R1 — promptTemplate spawn path.** §2.4 assumes `createSession` resolves the
  pack role's `promptTemplate` via the cascade for a project-scoped child. If a
  reviewer ever spawns with an empty `projectId`, the cascade lookup yields nothing
  and the schema is missing. *Mitigation:* the A3 E2E asserts the schema is in the
  child's prompt; if it fails, thread the cascade lookup into the spawn rolePrompt
  path and/or confirm the child inherits the owner's `projectId`.
- **R2 — autorun double-fire on reload.** The consumed flag is per-`byJob` entry,
  which is page-lived; a reload re-arms it during the brief `idle` window.
  *Mitigation:* the `run` route's `reviewerKey` idempotency returns the existing
  reviewer (`created:false`) — pinned by B2. Do not weaken that idempotency.
- **R3 — dismissed reviewer disappears from the sidebar.** D requires the child
  session to stay viewable after the server-synchronous dismiss. If dismiss removes
  it, the ready pane has no host view. *Mitigation:* §D.4 — reap worktree + mark
  terminal but keep the session selectable; pinned by D5.
- **R4 — `HOST_CONTRACT_VERSION` bump churn.** Bumping the contract version is
  observable to other packs. *Mitigation:* the change is purely additive (a new
  optional field); packs that don't read it are unaffected, and the pack
  feature-detects `>= 2` with a graceful fallback (D.3). Pin with D4.
- **R5 — `lib/panel.js` drift.** `src/panel.js` is edited in B/C/D but only the
  bundled `lib/panel.js` is served. Forgetting `npm run build:packs` ships the old
  panel. *Mitigation:* CI runs `build:packs` in `build`; commit both artifacts;
  call it out in the PR checklist (mirrors the migration doc's Risk #6).
- **R6 — pack purity regression in D.3.** The temptation is to navigate from the
  pack by touching `state`/router. *Mitigation:* the pack uses **only**
  `host.ui.openPanel({ sessionId })`; the navigation/selection lives in
  `pack-panels.ts` (platform). Reviewers should reject any pack edit that imports
  or calls platform navigation directly.
</content>
</invoke>
