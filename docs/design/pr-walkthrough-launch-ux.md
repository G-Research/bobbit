# PR Walkthrough launch UX — the correction

**Status:** design — implementation-ready
**Supersedes the launch/lifecycle model in:** [`pr-walkthrough-restore-ux.md`](pr-walkthrough-restore-ux.md) (PR #750, commit `4145abc`).
**Builds on (unchanged foundation):** the `host.agents`-minted, role-granted, no-secret, binding-routed reviewer + the Host-API `PanelTarget.sessionId` (contract **v2**, already shipped) + the `setSessionSwitcher` full-switch path.

This doc finalises the **mechanism** for the four locked requirements. The product decisions in the goal spec are requirements, not options — this document designs only the *how*. Every behaviour stated here is an acceptance criterion.

---

## 1. Summary & the corrected user journey

PR #750 wired the launcher to *navigate the owner session* to `#/ext/pr-walkthrough?autorun=true`, which transiently mounts the panel **in the owner session**, autoruns `run` on mount, re-keys the pane to the child, and navigates to the child. On submit the reviewer is **server-dismissed**. That journey is wrong on four counts. The corrected journey:

1. **Click "PR Walkthrough" in the GitStatusWidget** → spawns a fresh read-only reviewer sub-agent and **auto-switches** the view to it. **No panel/tab is ever mounted in the owner session.** Session title exactly `PR Walkthrough`; role `label: PR Walkthrough`; accessory `magnifier`.
2. **In the sub-agent session the panel auto-opens** as the visible tab, showing exactly `PR Walkthrough: In Progress` + a spinner (no %), with **no manual Run/Load buttons anywhere**.
3. **On submit** the child panel flips pending → rendered cards (the existing `publishing`→`rendered` seam). The reviewer is **NOT dismissed**: it posts a one-line "walkthrough ready" note, goes idle, stays read-only + selectable.
4. **The user terminates** the session via the existing session dismiss/terminate control when done.

No-PR / spawn-failure: an **inline error in the git-widget dropdown**; nothing spawned, no view switch. Always-fresh: every click is a NEW reviewer (no target dedup). Restart-survival: the post-submit reviewer survives a gateway restart, reaped only by the standard owner-gone rule.

---

## 2. Gap analysis (PR #750 → desired), with exact citations

| # | Current (PR #750) | Desired | Exact change site |
|---|---|---|---|
| G-1 | git-widget entrypoint navigates to a deep-link route with `autorun:true`; `_runPackLauncher` → `runLauncherEntrypoint` → `navigateToTarget` mounts the panel in the **owner** session. | Click invokes the pack `run` route, then opens the panel in the returned `childSessionId`; **no owner panel**. | `market-packs/pr-walkthrough/entrypoints/pr-walkthrough-git-widget.yaml` (target shape); `src/app/pack-entrypoints.ts::runLauncherEntrypoint` + new dispatch; `src/ui/components/GitStatusWidget.ts::_runPackLauncher`. |
| G-2 | Role `label: PR Walkthrough Reviewer`, `accessory: review` (not a real sprite — `src/ui/bobbit-sprite-data.ts` only defines `magnifier`). Session title not set by spawn → `createSession` defaults `plan.title` to `"New session"` (`session-setup.ts`). | `label: PR Walkthrough`, `accessory: magnifier`; **session title `PR Walkthrough`** threaded through spawn. | `market-packs/pr-walkthrough/roles/pr-reviewer.yaml`; `src/server/extension-host/server-host-api.ts` spawn wrapper; `market-packs/pr-walkthrough/lib/routes.mjs::launchReviewer`. |
| G-3 | Panel autoruns on mount via `autorun` param + `maybeAutorun` (`src/panel.js`); owner pane shows `Run PR walkthrough` / `Load walkthrough` buttons (`showActions`). Pending label `Reviewing the PR…`. | No autorun machinery; no manual buttons; the **child** pane self-drives the poll; pending label exactly `PR Walkthrough: In Progress`. | `market-packs/pr-walkthrough/src/panel.js` (rebuild `lib/panel.js`); `entrypoints/pr-walkthrough-route.yaml` (drop `autorun` paramKey). |
| G-4 | Submit reaps the reviewer: `orchestrationCore.dismiss(...)` + `sessionManager.updateSessionMeta({childTerminal:true,terminalAt})` + `last/<owner>` pointer write (`src/server/pr-walkthrough/routes.ts`, submit-yaml handler). `status` route also `dismiss`es on both branches (`lib/routes.mjs::status`). `run` dedups by `reviewerKey` (`lib/routes.mjs::launchReviewer`, the `existing` block + index write + post-claim reconcile). | No submit-time dismiss / no `childTerminal` stamp / no `last/<owner>` write; no status-poll dismiss; **no `reviewerKey` dedup** (always fresh). | `src/server/pr-walkthrough/routes.ts`; `market-packs/pr-walkthrough/lib/routes.mjs`. |

---

## 3. The launcher → spawn → select-child mechanism (the central question)

### 3.1 Where the logic lives — a new launcher target shape

Today `runLauncherEntrypoint` (`pack-entrypoints.ts`) dispatches a launcher's `target` two ways: a `PanelTarget` (`openPackPanel`) or a `RouteTarget` (`navigateToTarget`). Neither calls a pack route. We add a **third, declarative target shape** — a *spawn launcher* — that means "call this pack route on click; on `ok:true` open the returned child's panel; on `ok:false` surface the structured error inline".

**Contract (add to `src/app/pack-entrypoints.ts`):**

```ts
/** A launcher that, on click, calls the owning pack's `route` (POST, empty body),
 *  then opens `panelId` in the returned `childSessionId` (auto-switching to it).
 *  Discriminated by `action: "spawn"`. Pack purity: the pack declares ONLY this
 *  data; the route call + navigation go through the versioned Host API. */
export interface SpawnLaunchTarget {
	action: "spawn";
	route: string;        // pack route name, e.g. "run"
	panelId: string;      // panel to open in the returned childSessionId
}
```

`SpawnLaunchTarget` carries a `panelId`, so detection MUST check `action` **first** in `isPanelTarget`/dispatch:

```ts
function isSpawnLaunchTarget(t: unknown): t is SpawnLaunchTarget {
	return !!t && (t as SpawnLaunchTarget).action === "spawn"
		&& typeof (t as SpawnLaunchTarget).route === "string"
		&& typeof (t as SpawnLaunchTarget).panelId === "string";
}
```

`LauncherEntrypoint.target` becomes `PanelTarget | RouteTarget | SpawnLaunchTarget`. `entrypointInfosFromContributions` passes the target through unchanged for launcher kinds (it already does — it does not validate target internals for launchers), so a `{action,route,panelId}` target survives the contributions wire. `registerPackEntrypoints`'s launcher branch already accepts any non-panel/non-route target shape only if `isPanelTarget || target.route` — **extend that guard** to also accept `isSpawnLaunchTarget(target)`.

**Entrypoint YAML (the git-widget launcher):**

```yaml
id: pr-walkthrough.git-widget
kind: git-widget-button
label: PR Walkthrough
target:
  action: spawn
  route: run
  panelId: pr-walkthrough.panel
```

The composer-slash (`pr-walkthrough-open.yaml`) and command-palette (`pr-walkthrough-palette.yaml`) launchers get the **same** `target` (Q3: all launch surfaces spawn). The `kind:"route"` deep-link entrypoint (`pr-walkthrough-route.yaml`) **stays** (it registers the panel so a child-session reload restores `#/ext/pr-walkthrough`), but drops `autorun` from `paramKeys` → `paramKeys: [jobId, baseSha, headSha]`.

### 3.2 The launcher-bound Host API

Today only panels get a Host API (via `panelHostFactory`, `pack-panels.ts`). Launchers don't. A spawn launcher needs `callRoute` (to call `run`) + `ui.openPanel` (to open the child pane) bound to **the pack** and **the active (owner) session** — `run`'s `ctx.sessionId` must be the owner so it resolves the owner branch's PR. Add a sibling factory, mirroring `panelHostFactory` exactly:

```ts
// pack-panels.ts (next to panelHostFactory)
let launcherHostFactory: ((sessionId: string | undefined, packId: string) => HostApi) | undefined;
export function setLauncherHostFactory(fn: (sessionId: string | undefined, packId: string) => HostApi): void {
	launcherHostFactory = fn;
}
export function getLauncherHost(packId: string): HostApi | undefined {
	return launcherHostFactory?.(currentSessionIdForPanel(), packId);
}
```

`src/app/host-api.ts` self-registers it at bootstrap (same place it registers `panelHostFactory`), binding the pack-scoped surface `{kind:"pack", packId, contributionKind:"entrypoint", contributionId}` to the active session. `callRoute` is authorized through the owner session's `allowedTools` guard exactly as a panel's `callRoute` is — the owner already has the pack installed, so `/api/ext/pr-walkthrough/run` is reachable. **Pack purity holds:** the pack provides declarative target + route + panel; the route call and navigation are versioned-Host-API only; the dispatch logic lives in platform `pack-entrypoints.ts`.

### 3.3 Dispatch + inline-error contract to GitStatusWidget

`runLauncherEntrypoint` gains an optional result callback so the surface can render `NO_PR`/failure inline:

```ts
export interface LauncherDispatchResult { ok: boolean; error?: string; code?: string; }

export function runLauncherEntrypoint(keyOrId: string, onResult?: (r: LauncherDispatchResult) => void): void {
	// …resolve `l` exactly as today…
	if (isSpawnLaunchTarget(l.target)) { void runSpawnLauncher(l, l.target, onResult); return; }
	if (isPanelTarget(l.target)) { openPackPanel(l.target, l.packId); onResult?.({ ok: true }); return; }
	navigateToTarget(l.target as RouteTarget); onResult?.({ ok: true });
}

// Within-gesture guard: a single click cannot double-spawn (replaces the removed
// server-side reviewerKey dedup). Keyed by compound launcher key.
const inFlightSpawnLaunch = new Set<string>();

async function runSpawnLauncher(l: RegisteredLauncher, target: SpawnLaunchTarget, onResult?) {
	if (inFlightSpawnLaunch.has(l.key)) return;      // ignore re-entrant click
	inFlightSpawnLaunch.add(l.key);
	try {
		const host = getLauncherHost(l.packId);
		if (!host?.capabilities?.callRoute) { onResult?.({ ok: false, error: "PR Walkthrough is unavailable." }); return; }
		let res: any;
		try { res = await host.callRoute(target.route, { method: "POST", body: {} }); }
		catch (e: any) { onResult?.({ ok: false, error: e?.message ? String(e.message) : String(e) }); return; }
		if (!res || res.ok === false) { onResult?.({ ok: false, error: res?.error, code: res?.code }); return; }
		// ok:true → open the panel in the returned child session (selects + switches).
		if (res.childSessionId && host.ui?.openPanel) {
			host.ui.openPanel({ panelId: target.panelId, sessionId: res.childSessionId, params: {} });
		}
		onResult?.({ ok: true });
	} finally {
		inFlightSpawnLaunch.delete(l.key);
	}
}
```

**`run` already returns** `{ ok:true, childSessionId, jobId, … }` or `{ ok:false, code:"NO_PR" | …, error }` from the bare-body resolve-current-branch path (`lib/routes.mjs::run` → `resolveCurrentBranchTarget`). No `run` signature change is needed — its `ok:false` surfaces as the inline error; its `ok:true.childSessionId` drives the open.

**GitStatusWidget** (`_runPackLauncher`): currently it `_closeDropdown()` then `runLauncherEntrypoint(id)`. New behaviour — keep the dropdown open until we know the result, and render the error inline on failure:

```ts
@state private _launcherError: { id: string; message: string } | null = null;

private _runPackLauncher(id: string): void {
	this._launcherError = null;
	try {
		runLauncherEntrypoint(id, (r) => {
			if (r.ok) { this._closeDropdown(); return; }            // view switches to the child
			this._launcherError = { id, message: r.error || "Could not start the PR walkthrough." };
			if (this._dropdownEl) render(this._renderDropdownContent(), this._dropdownEl);  // re-render portal inline
		});
	} catch { /* non-fatal */ }
}
```

`_renderPackLaunchers` renders `this._launcherError?.id === b.id` as an inline `<div data-testid="git-widget-launcher-error" style="color:var(--negative)">${message}</div>` beneath the button. The dropdown stays open on error; nothing is spawned; no view switch (the `run` route returns before any spawn on `NO_PR`).

Note: `runLauncherEntrypoint` is called from three surfaces — GitStatusWidget (`_runPackLauncher`), CommandPalette (`CommandPalette.ts`), MessageEditor slash (`MessageEditor.ts`). The `onResult` arg is optional; the palette/composer callers may pass it to toast the error, but at minimum must not regress (calling without a callback still spawns + switches on success).

---

## 4. The child-session panel (req 2 & 3)

The owner pane is gone; the panel renders **only** inside a sub-agent session. `renderPackPanelContent` (`pack-panels.ts`) injects `__sessionId` = the bound session; in a reviewer child that is the child's own id, which has a `binding/<self>` in the pack store.

### 4.1 Auto-open carve-out + pending state

When the panel renders and its `__sessionId` is a **bound reviewer child** (`host.store.get("binding/" + sessionId)` resolves), the pane is in one of two states:

- **No submitted YAML yet** → show pending `PR Walkthrough: In Progress` + spinner and **self-drive the poll** (below). This is the documented carve-out from the pack "no auto-invoke on mount" invariant (`pack-panels.ts::PackPanel` doc), **scoped to a child-session reviewer pane**: it does NOT spawn or mutate — it only polls its own job's `status` (read-only) and renders. Document this exception in `docs/pr-walkthrough-panel.md` and `docs/extension-host-authoring.md`.
- **Submitted** → recover + render the cards (§4.3).

The pending render replaces the old `statusText`/`Reviewing the PR…` with exactly:

```js
// pending render — no progress %
html`<div data-testid="prw-pending" class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
  <span class="prw-spinner" …spinner styles…></span> PR Walkthrough: In Progress
</div>`
```

There is **no `showActions` block** — the Run/Load buttons are removed entirely.

### 4.2 Poll ownership (who polls now that the owner `onRun` is gone)

**The child-session pane self-drives the poll**, keyed off its own `binding/<self>`. On mount, when `__sessionId` has a binding and there is no rendered bundle and no submitted marker, a guarded one-shot starts a poll loop:

```js
// child-pane self-poll (carve-out). Single-flight per (childKey) entry.
const selfBinding = await host.store.get("binding/" + boundSessionId);   // jobId lives here
if (selfBinding && !entry.bundle && status !== "rendered" && !entry.polling) {
	byJob.set(boundSessionId, { ...entry, status: "running", polling: true, jobId: selfBinding.jobId });
	queueMicrotask(() => void pollChild(boundSessionId, selfBinding.jobId));
}
```

`pollChild` is the existing poll loop, reduced to the child path: `host.callRoute("status", { method:"POST", body:{ childSessionId: boundSessionId, jobId } })`. The child-self `status` path already returns `phase:"running"` until the submitted marker appears, **without** calling `host.agents.status` (Finding 2, already in `routes.mjs`). On `phase:"submitted"` it calls `publishAndLoad` under the child key → `rendered`. Keep `HARD_CAP_MS`/`SLOW_HINT_MS` but the slow hint reuses the same pending copy (no error while alive). **There is no owner-session poll** — the only poller is the child pane itself; this preserves "no owner-session poll" and the no-dismiss lifecycle (status never dismisses; §5).

Rationale for self-drive over "the launcher's post-spawn flow polls": the launcher fire-and-forgets after `openPanel` (the click gesture ends, the view switches); a launcher-owned poll would be orphaned if the user navigates. The child pane is the durable home of the poll and re-arms correctly on reload.

### 4.3 Submitted → rendered, and reload recover

`publishAndLoad` (unchanged seam) writes the `rendered` entry under the child key. On reload of the sub-agent session the pane finds `byJob` empty, reads `binding/<self>` → resolves the submitted YAML via the **child-self `recover` branch** (already in `routes.mjs::recover`, keyed by `binding/<me>`), and re-publishes the cards. **Keep** the child-self `recover` branch; **remove** the owner branch (§5).

---

## 5. Lifecycle — no auto-dismiss, restart survival, terminate

### 5.1 Server: `src/server/pr-walkthrough/routes.ts` (submit-yaml handler)

In the `isInternalSubmitRoute` POST handler, **after** persisting `submitted/<jobId>` and `binding.status="submitted"` (both **stay**):

- **REMOVE** the `last/<owner>` pointer write (the `if (binding.parentSessionId) { store.put(PRW_PACK_ID, prwLastKey(...)) }` block) and the `prwLastKey` constant if now unused. No owner-side recover surface exists.
- **REMOVE** the `sessionManager.updateSessionMeta(authSessionId, { childTerminal: true, terminalAt })` stamp.
- **REMOVE** the `orchestrationCore.dismiss(binding.parentSessionId, authSessionId)` reap.

The handler still returns `{ ok:true, status:"submitted", jobId }`. Without the `childTerminal` stamp, `shouldReapChildOnBoot` (`orchestration-core.ts`) reaps the reviewer **only** on owner-gone/archived — never on a terminal marker (restart survival, Q5). The `orchestrationCore`/`sessionManager` deps may become unused in this handler; leave the `PrWalkthroughRouteDeps` fields (other code/tests reference them) but drop the now-dead calls.

### 5.2 Pack: `market-packs/pr-walkthrough/lib/routes.mjs`

- **`status`** — REMOVE the `ctx.host.agents.dismiss(childSessionId)` on the submitted branch AND on the terminated-without-submit (owner) branch. The submitted branch still returns `{ phase:"submitted", yaml, … }`; the owner branch still returns `{ phase:"error", … }` for a genuinely terminated child but **does not dismiss**. A live reviewer is never reaped by status polling.
- **`recover`** — REMOVE the owner branch (the `last/<owner>` pointer read). **KEEP** the child-self branch (`binding/<me>` → `submitted/<jobId>`).
- **`run`/`launchReviewer`** — REMOVE the `reviewerKey` idempotency entirely: the `existing` reuse block, the `store.put(reviewerKey(...))` index write, the post-claim reconcile, and the `inFlightLaunches` module map + the `pending` await in `run`. Each `run` calls `launchReviewer` which **always spawns a fresh** child (Q4). Drop the `reviewerKey` helper. The kickoff/binding writes + compensation-on-failure stay. The client within-gesture guard (§3.3) is the only double-spawn protection; multiple reviewers per PR are allowed.

### 5.3 Naming/visuals + title threading

- `roles/pr-reviewer.yaml`: `label: PR Walkthrough`, `accessory: magnifier`. (Tool policies unchanged — security model intact.) Fix the now-stale `// …review accessory…` comment in `session-setup.ts` to say `magnifier`.
- **Title derivation conclusion — both:** the sidebar shows `session.title` (`render.ts`, `state.remoteAgent.title || "New session"`), and `host.agents.spawn` currently passes **no** title → `createSession` defaults to `"New session"`. So the role `label` alone does NOT set the session title. Therefore: set the role `label: PR Walkthrough` (governs role display + the generic accessory application in `session-setup.ts`) **and** thread an explicit spawn title:
  - `src/server/extension-host/server-host-api.ts` — add `title?: string` to the `agents.spawn(opts)` type and pass `title: spawnOpts.title` into `c.spawn({...})`. This is an additive optional field on the server-side `host.agents` capability — NOT the frozen versioned `PanelTarget`/`HostApi` data contract, so **no `HOST_CONTRACT_VERSION` bump**. `OrchestrationCore.SpawnOpts.title` already exists and flows to `createSession` and the handle.
  - `lib/routes.mjs::launchReviewer` — pass `title: "PR Walkthrough"` in the `spawnReviewerWithRetry` opts.

### 5.4 Terminate control (req 4)

The reviewer is a normal selectable `host-agents` child session post-submit. **Verify** the per-session terminate/dismiss affordance (the sidebar `SidebarActionsPopover` archive action / session dismiss control) is exposed for a `host.agents` child and dismisses it via the session archive path (`getSessionStore(projectId).archive(id)` / the `/api/sessions/:id` archive route). If a child session does not currently show that control, the minimal exposure is to render the existing archive action for selectable `childKind:"host-agents"` sessions (they are already shown in the sidebar as owner-scoped children). Terminating discards the session — the walkthrough is not preserved elsewhere (cheap to re-run). Pin with an API E2E (§7).

---

## 6. Removals checklist

- `market-packs/pr-walkthrough/src/panel.js`: `maybeAutorun`, `markAutorunConsumed`, `autorunMarkerKey`, `wantsAutorun`, the `autorunConsumed` flag, the owner `onRun`/`onLoad` closures, the `showActions` Run/Load buttons, `readSubmittedToolCall` (owner transcript scan). Keep `publishAndLoad`, `renderBundle`/cards, the child-self poll (§4.2), recover-on-mount for the child pane.
- `entrypoints/pr-walkthrough-git-widget.yaml` + `pr-walkthrough-open.yaml` + `pr-walkthrough-palette.yaml`: replace `target.route`/`autorun` with the `{action:spawn, route:run, panelId}` target.
- `entrypoints/pr-walkthrough-route.yaml`: `paramKeys: [jobId, baseSha, headSha]` (drop `autorun`).
- `lib/routes.mjs`: `reviewerKey` dedup, `inFlightLaunches`, post-claim reconcile, `status` dismisses, `recover` owner branch.
- `src/server/pr-walkthrough/routes.ts`: submit-time `dismiss`, `childTerminal` stamp, `last/<owner>` write (+ `prwLastKey` if unused).

---

## 7. File-by-file change list (disjoint groups for parallel coders)

The pack surface (`src/panel.js`, `lib/routes.mjs`, `entrypoints/*`, `roles/*`) is tightly coupled (one panel + one route module + the launcher targets must agree) — **one coder owns the whole pack surface (G-A)**. The platform-client launcher (G-B) and the server lifecycle (G-C) are file-disjoint from each other and from G-A. Tests (G-E) are split per file.

| Group | Files (disjoint) | Work |
|---|---|---|
| **G-A** (pack surface) | `market-packs/pr-walkthrough/src/panel.js` → rebuild `lib/panel.js` via `npm run build:packs`; `lib/routes.mjs`; `entrypoints/pr-walkthrough-{git-widget,open,palette,route}.yaml`; `roles/pr-reviewer.yaml` | §3.1 targets; §4 child pane (pending + self-poll + submitted→rendered + recover); §5.2 routes.mjs removals + `title:"PR Walkthrough"` spawn; §5.3 role label/accessory; §6 removals. |
| **G-B** (platform client launcher) | `src/app/pack-entrypoints.ts`; `src/app/pack-panels.ts`; `src/app/host-api.ts`; `src/ui/components/GitStatusWidget.ts` | §3.1 `SpawnLaunchTarget` + register guard + dispatch; §3.2 `setLauncherHostFactory`/`getLauncherHost` + self-register; §3.3 `runLauncherEntrypoint(onResult)` + `runSpawnLauncher` + within-gesture guard + GitStatusWidget inline error. Optional: `CommandPalette.ts`/`MessageEditor.ts` pass-through `onResult`. |
| **G-C** (server lifecycle + title) | `src/server/pr-walkthrough/routes.ts`; `src/server/extension-host/server-host-api.ts`; `src/server/agent/session-setup.ts` (comment only) | §5.1 submit-handler removals; §5.3 `title` passthrough; comment fix. |
| **G-D** (terminate) | the session terminate-control site (verify; minimal exposure only if missing) | §5.4. May be a no-op if the control already covers host-agents children. |
| **G-E** (tests) | `tests/e2e/ui/pr-walkthrough-pack.spec.ts`; `tests/e2e/pr-walkthrough-host-agents.spec.ts`; `tests/pr-walkthrough-role-tools-policy.test.ts`; new unit for the launcher dispatch | §8. |
| **G-F** (docs) | `docs/pr-walkthrough-panel.md`; `docs/extension-host-authoring.md`; `docs/design/pr-walkthrough-restore-ux.md` (mark superseded); this doc | launch model, auto-open carve-out, no-dismiss lifecycle, the new `SpawnLaunchTarget` entrypoint shape (docs gate). |

**Conflict note:** G-A owns the entire pack; G-B owns only `src/app/*` + `GitStatusWidget.ts`; G-C owns only `src/server/*`. `src/app/host-api.ts` (client) and `src/server/extension-host/server-host-api.ts` (server) are **different files** — no overlap. `src/shared/extension-host/host-api.ts` is **not** edited (the `PanelTarget.sessionId` v2 field already shipped).

**Build/commit constraints:** `lib/panel.js` is esbuild-bundled from `src/panel.js` via `npm run build:packs` — edit source, rebuild, **commit both**. `lib/routes.mjs` is hand-authored (no `src/routes.mjs`) — edit directly. Primary branch `master`; LF endings; co-author trailer on every commit.

---

## 8. Test plan (acceptance criterion → test; ALL via the e2e mock agent, never `test:manual`)

**Harness constraint (carried from the existing spec):** the browser harness has no real GitHub PR and `execFile("gh")` resolves the real binary, so a *click-driven* `run` resolves `NO_PR` and mints no reviewer in-browser. Reviewer-spawn / lifecycle assertions therefore live in the **API E2E** (`pr-walkthrough-host-agents.spec.ts`), which calls `run` with an explicit github target; the auto-switch + inline-error UI is pinned by a **unit test of the launcher dispatch** plus the browser `NO_PR` path.

| # | Acceptance criterion (req / Q) | Test | Phase |
|---|---|---|---|
| T-1 | Click spawns a child; **no owner panel/tab is mounted**; UI auto-switches to the child. (req 1, Q1) | **Unit** (new, `pack-entrypoints`/`pack-panels` fixture): a mocked launcher host whose `callRoute("run")` returns `{ok:true, childSessionId:"c1"}` → assert `runSpawnLauncher` calls `host.ui.openPanel({panelId, sessionId:"c1"})` (which selects + switches), and that **no** `openPackPanel`/tab mount targets the owner session. | unit·node |
| T-2 | No-PR / failure → inline git-widget error; **no session, no switch**. (Q2) | **Browser E2E** (`pr-walkthrough-pack.spec.ts`): click the git-widget launcher on a branch with no PR → `[data-testid="git-widget-launcher-error"]` shows "No open GitHub PR…", dropdown stays open, `getAllSessionsRaw` has **no** new `pr-reviewer` child, `selectedSessionId` unchanged. (Reuses the existing NO_PR harness.) | E2E·browser |
| T-3 | Child session auto-shows pending `PR Walkthrough: In Progress` + spinner; **no Run/Load buttons**. (req 2, Q3) | **Browser E2E**: render the panel in a bound-child fixture (seed `binding/<self>` in the in-process pack store, open `#/ext/pr-walkthrough` in that child session) → `[data-testid="prw-pending"]` contains exactly `PR Walkthrough: In Progress`; `[data-testid="prw-run"]`/`prw-load` have count 0. | E2E·browser |
| T-4 | Submit → child pane flips to cards; reload re-renders via child-self `recover`. (req 3) | **Browser E2E**: with `binding/<self>` + then a `submitted/<jobId>` seeded, the pane polls `status` → `submitted` → renders `[data-testid="prw-navrail"]`/`prw-title`; reload → cards re-render via `recover` (no owner transcript). | E2E·browser |
| T-5 | Always-fresh: two clicks for the SAME PR → TWO distinct reviewer sessions (no dedup). (Q4) | **API E2E**: call `run` with the same explicit github target twice → two distinct `childSessionId`s, both `created:true`, both live bindings. Regression-guards the removed `reviewerKey`. | E2E·api |
| T-6 | Submit never dismisses; reviewer stays alive + selectable; `status` returns `submitted` without dismissing. (req 3/4; guards Decision E) | **API E2E** (extend): after submit, assert `host.agents.status(child) !== "terminated"` and the persisted session is not archived; call `status` → `phase:"submitted"` and the child is STILL alive afterwards. Assert no `childTerminal` marker was stamped. | E2E·api |
| T-7 | Restart survival: a post-submit reviewer survives a simulated gateway restart (not boot-reaped), stays selectable. (Q5) | **API E2E** (extend): submit → simulate restart → `shouldReapChildOnBoot` does NOT reap (owner alive, no `childTerminal`); the child session is restored + selectable. | E2E·api |
| T-8 | User terminate dismisses the reviewer. (req 4) | **API E2E**: invoke the session terminate/archive control on the child → it is archived/dismissed. | E2E·api |
| T-9 | Role `accessory: magnifier`, `label: PR Walkthrough`; session title `PR Walkthrough`. (req 1/2) | **Unit** (extend `pr-walkthrough-role-tools-policy.test.ts`): `loadRole(PR_REVIEWER_ROLE_FILE)` → `accessory==="magnifier"`, `label==="PR Walkthrough"`. **API E2E** (update existing `accessory` assertion from `"review"` → `"magnifier"`; add `getPersistedSession(child).title === "PR Walkthrough"`). | unit·node + E2E·api |
| T-10 | The new launcher dispatch + entrypoint shape. | **Unit**: `SpawnLaunchTarget` registers (the launcher-branch guard accepts it), `runLauncherEntrypoint` routes it to `runSpawnLauncher`, the within-gesture guard suppresses a second concurrent click. | unit·node |
| — | Security model unchanged. | **Kept**: `pr-walkthrough-role-tools-policy.test.ts` (group default-deny; only `pr-reviewer` grants) + the no-submit-proof grep test (`pr-walkthrough-no-submit-proof.test.ts`) stay green. | unit·node |

The existing `pr-walkthrough-pack.spec.ts` Area-B autorun assertions (`runPosts.length === 1`, deep-link manual-Run) are **deleted** — autorun and the manual buttons are gone.

---

## 9. Risks

- **R1 — launcher host authorization.** The launcher-bound `callRoute` must be authorized for the owner session exactly like a panel's. *Mitigation:* `setLauncherHostFactory` reuses the same per-session pack surface + guard as `panelHostFactory`; pinned by T-1/T-10. If `callRoute`/`ui` are not available on the launcher host (older host, no session), `runSpawnLauncher` surfaces an inline error and spawns nothing.
- **R2 — browser harness cannot spawn via `gh`.** Auto-switch + pending + cards can't be exercised through a real click in-browser. *Mitigation:* the spawn/lifecycle path is pinned in the API spec (explicit target) + the launcher-dispatch unit (mock host); the child-pane render is pinned by seeding `binding/<self>` in the in-process pack store (T-3/T-4). This is the same split the existing spec already uses.
- **R3 — `SpawnLaunchTarget` vs `PanelTarget` detection.** Both carry `panelId`; mis-ordered detection would route a spawn launcher to `openPackPanel`. *Mitigation:* dispatch checks `action:"spawn"` FIRST; pinned by T-10.
- **R4 — title not applied.** If `host.agents.spawn` title passthrough is missed, the session shows `New session`. *Mitigation:* T-9 asserts `persisted.title === "PR Walkthrough"`; the role `label` is the secondary surface for role display.
- **R5 — terminate control absent for host-agents children.** If the session UI never exposed an archive control for a child session, the user can't terminate. *Mitigation:* §5.4 verification + T-8; minimal exposure only if missing.
- **R6 — `lib/panel.js` drift.** `src/panel.js` is edited but `lib/panel.js` is served. *Mitigation:* `npm run build:packs` in `build` catches it; commit both artifacts.
- **R7 — child-pane self-poll re-arm on reload.** The self-poll one-shot must not stack multiple loops on re-render. *Mitigation:* the `polling` flag on the `byJob` entry single-flights it; a `rendered`/`submitted` entry never re-polls.
- **R8 — pack purity regression.** Temptation to navigate from the pack by touching `state`/router. *Mitigation:* the pack uses only `host.ui.openPanel({sessionId})`; selection/switch live in `pack-panels.ts` (platform). Reviewers reject any pack edit importing platform navigation.
