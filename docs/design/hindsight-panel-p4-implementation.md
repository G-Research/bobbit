# P4 — Hindsight native config/status panel & entrypoints (implementation design)

Status: design. Owner gate: `design-doc`. Builds on P1 (runtime descriptor), P2
(pack routes: `config`/`status`/`recall`/`retain`/`reflect`/`banks`), and P3
(deployment modes + managed-runtime linkage). This document is the implementation
contract for the **only** remaining G2.3 deliverable in the Hindsight pack: a
first-party **native panel** that replaces store-seeding as the configuration path,
plus its **command-palette** and **deep-link** entrypoints.

It introduces **no new server routes** — the panel is a pure client of the existing
P2 routes through the versioned Host API. No production code/tests are written by
this doc; it scopes them.

---

## 1. Goal & non-goals

**Goal.** Give a user a native, theme-compatible panel to:

- pick the **deployment mode** (`external` / `managed` / `managed-external-postgres`);
- configure **external URL**, **API key**, **bank**, **namespace**, **managed
  data-dir**, **external Postgres URL**, and the recall/retain toggles & budgets,
  where relevant to the chosen mode;
- see a **runtime status card** (configured / healthy / mode / bank / namespace +
  a logs link) driven by the P2 `status` route;
- **search memory** via the existing `recall` route and render results;
- see **recent retains / retry-queue counter** via the `status` route;
- **persist** config through the existing `config` route (replacing the
  E2E-only store-seeding configuration path).

Two entrypoints expose it: a **command-palette** launcher (owner-session panel,
`action`-less `PanelTarget`) and a **deep link** (`kind:"route"`, `routeId:"hindsight"`).

**Non-goals (out of scope for P4).**

- New server routes or changes to `src/routes.ts` / `src/shared.ts` route logic
  (the panel consumes the **frozen** P2 surface as-is).
- The explicit `hindsight_*` agent tools / reflect UI (separate work; the panel
  does not call `reflect`).
- Starting/stopping the managed Docker runtime from the panel. The panel writes
  **config** only; runtime enable/start stays in the marketplace/runtime UI
  (`runtimes/hindsight.yaml` `startPolicy: on-enable`). The status card surfaces
  health read-only.
- Opening a GitHub PR.

---

## 2. Files to add / change

### 2.1 Add — pack panel source (client, bundled)

| Path | What |
|---|---|
| `market-packs/hindsight/src/panel.js` | Panel source. Default-export factory `createPanel({ html, nothing, renderHeader })` returning `{ render(params, host) }`. Built to `lib/HindsightPanel.js`. **No `lit` import** (host-injected). |

> Naming: source stays `src/panel.js` (mirrors `pr-walkthrough/src/panel.js`); the
> **built** artifact is `lib/HindsightPanel.js` per the goal. Authoring in `.js`
> (not `.ts`) matches pr-walkthrough's client panel and avoids a typecheck entry
> for browser-only code. If TS is preferred, `src/HindsightPanel.ts` is acceptable
> so long as `out` stays `lib/HindsightPanel.js`.

### 2.2 Add — panel descriptor

| Path | What |
|---|---|
| `market-packs/hindsight/panels/hindsight-memory.yaml` | Auto-discovered panel manifest. `id: hindsight.panel`, `title: Hindsight Memory`, `entry: ../lib/HindsightPanel.js`. **Singleton** instance mode (no `instanceParam`) — one config panel per session view. |

### 2.3 Add — entrypoints

| Path | What |
|---|---|
| `market-packs/hindsight/entrypoints/hindsight-palette.yaml` | `kind: command-palette`, `label: Hindsight Memory`, `target: { panelId: hindsight.panel }` — a **PanelTarget** launcher (no `action: spawn`), opens the panel in the active/owner session via `openPackPanel`. |
| `market-packs/hindsight/entrypoints/hindsight-route.yaml` | `kind: route`, `routeId: hindsight`, `target: { panelId: hindsight.panel }`, `paramKeys: []`. Deep link `#/ext/hindsight` reopens the panel rehydrated from the routes. |

### 2.4 Change — `market-packs/hindsight/pack.yaml`

```yaml
contents:
  roles: []
  tools: []
  skills: []
  entrypoints: [hindsight-palette, hindsight-route]   # was []
  providers: [memory]
  hooks: []
  mcp: []
  pi-extensions: []
  runtimes: [hindsight]
  workflows: []
```

Update the trailing `# panel + deep link land in G2.3` comment to reflect that
they have landed. The `routes:` block is unchanged (the panel reuses
`config`/`status`/`recall`).

### 2.5 Change — `scripts/build-market-packs.mjs`

Add a **client** panel entry to the `hindsight` pack's `entries` array (alongside
the three existing `platform:"node"` server bundles). It is browser-platform
(default), so `lit` stays external and the bundle is self-contained:

```js
{ in: "panel.js", out: "lib/HindsightPanel.js" }   // CLIENT panel (browser)
```

Drop/adjust the existing `// (panel + tools land in G2.3)` comment.

### 2.6 Add — E2E fixtures & spec (owned by the tester; scoped here)

| Path | What |
|---|---|
| `tests/e2e/ui/hindsight-pack.spec.ts` | Browser E2E (see §7). |
| (reuse) `tests/e2e/hindsight-stub.mjs` | Existing in-process Hindsight stub; reused to back `status.healthy` + `recall` results. |

No change to `tests/e2e/hindsight-external.spec.ts` (API spec); its `seedConfig`
seam stays for the API tests. The **panel** becomes the user-facing config path;
store-seeding remains a test-only mechanism.

---

## 3. Entrypoint YAML shape (exact)

`panels/hindsight-memory.yaml`:

```yaml
id: hindsight.panel
title: Hindsight Memory
# Singleton config/status panel — one per session view (no instanceParam). `entry`
# resolves relative to THIS yaml (panels/) and stays inside the pack root; the
# built bundle lives in the shared lib/ dir and is lazy-imported by the client
# pack-panels registry, opened via host.ui.openPanel({ panelId }). It reads/writes
# ONLY through the Host API (host.callRoute config|status|recall, host.store) —
# never a raw fetch.
entry: ../lib/HindsightPanel.js
```

`entrypoints/hindsight-palette.yaml`:

```yaml
id: hindsight.palette
kind: command-palette
label: Hindsight Memory
# A command-palette LAUNCHER whose target is a PanelTarget (NO action:"spawn"):
# its click opens hindsight.panel in the ACTIVE (owner) session via openPackPanel.
# This is the config/status surface — there is no sub-agent to mint, unlike the
# pr-walkthrough spawn launchers.
target:
  panelId: hindsight.panel
```

`entrypoints/hindsight-route.yaml`:

```yaml
id: hindsight.route
kind: route
routeId: hindsight
target:
  panelId: hindsight.panel
# Deep-link: #/ext/hindsight resolves through the client pack-route registry and
# reopens the singleton panel. No params are carried — the panel rehydrates its
# state entirely from the config/status routes on mount, so paramKeys is empty.
paramKeys: []
```

> **Why a `PanelTarget` launcher, not `action:"spawn"`.** The pr-walkthrough
> launchers spawn a read-only reviewer child and open the panel in *that* child
> session. The Hindsight panel is a **config/status** surface bound to the
> owner/active session — `runLauncherEntrypoint` routes a bare `PanelTarget`
> straight to `openPackPanel(target, packId)` (see
> `src/app/pack-entrypoints.ts`), exactly like the artifacts deep-link panel.

---

## 4. Panel module contract & Host API usage

### 4.1 Factory shape (mirrors artifacts / pr-walkthrough)

```js
export default function createPanel({ html, nothing, renderHeader }) {
  // module-closure caches survive repaints (config snapshot, status snapshot,
  // search results, in-flight flags), keyed by the bound session id.
  return {
    render(params, host) { /* PURE projection; kicks async fetches ONCE */ }
  };
}
```

- The client lazy-imports the Blob-URL module and calls the default export with
  the app's own lit instance (`{ html, nothing, renderHeader }`) — the pack never
  bare-imports `lit` (`pack-panels.ts::loadPanelModule`).
- `render(params, host)` is a **pure projection**: it must not auto-invoke
  capabilities on every repaint. The documented pattern (artifacts) is to kick a
  fetch **once** (guarded by a closure cache), call `host.requestRender()` when it
  resolves, and re-render from cache thereafter.
- `params.__sessionId` is injected by the host (`pack-panels.ts`); use it as the
  closure cache key so each session view keeps its own snapshot.
- Feature-detect Phase-2 capabilities via `host.capabilities.callRoute` /
  `host.capabilities.store` before use (they are present-but-throwing stubs on a
  Phase-1 host). Degrade to a "memory unavailable on this host" message.

### 4.2 Route calls (all via `host.callRoute`, never raw fetch)

The pack declares routes `[status, recall, retain, reflect, banks, config]`
(`pack.yaml`). P4 uses **three**:

| Call | When | Request | Response (P2 contract) |
|---|---|---|---|
| `host.callRoute("config", { method:"GET" })` | on mount (once per session) | — | `{ ok, configured, config }` where `config` is **redacted** (`apiKeySet`/`externalDatabaseUrlSet`/`llmApiKeySet` booleans, never raw secrets). |
| `host.callRoute("config", { method:"POST", body })` | Save clicked | partial overrides (only changed keys) | `{ ok:true, configured, config }` (new redacted effective config) or `{ ok:false, error:"CONFIG_INVALID", errors:[…] }`. |
| `host.callRoute("status", { method:"GET" })` | on mount + after Save + manual Refresh + a bounded poll while a managed mode is "configured but not yet healthy" | — | `{ configured, mode, bank, namespace, recallScope, autoRecall, autoRetain, queueDepth, healthy, lastError? }`. |
| `host.callRoute("recall", { method:"POST", body:{ query, scope? } })` | Search submitted | `{ query, scope?: "project"\|"all" }` | `{ configured, memories:[{ text, score?, id? }], error? }`. Dormant ⇒ `{ configured:false, memories:[] }`. |

`scope` defaults to the configured `recallScope`; the search UI offers an explicit
project/all toggle that maps to the route `scope` param (the route resolves the
real `projectId` from its server ctx for `project` scope).

### 4.3 `host.store` usage (optional, UI-only)

The **authoritative** config store is the pack route's `provider-config:memory`
key (written server-side by the `config` route). The panel **must not** write that
key directly — it goes through the route so validation + redaction apply. The
panel **may** use `host.store` for **UI-only** ephemera (e.g. last search query,
panel section collapse state) under distinct keys; this is best-effort and never
holds secrets.

### 4.4 No `host.session` use

The config panel reads/writes config + status only. It does not read the
transcript or post messages, so `host.session` is unused (keeps the surface
minimal and the security story simple).

---

## 5. Config data model (panel ↔ `config` route)

Single source of truth: `market-packs/hindsight/src/shared.ts`
(`EffectiveConfig`, `CONFIG_DEFAULTS`, `validateConfigOverrides`, `redactConfig`)
mirrored by `providers/memory.yaml`. The panel mirrors this shape; it does **not**
re-derive defaults — it renders the `config` GET response and only POSTs **changed**
keys.

### 5.1 Fields, by mode

| Field | Type | Modes | Notes |
|---|---|---|---|
| `mode` | enum `external` \| `managed` \| `managed-external-postgres` | all | Drives which fields below are shown/required. |
| `externalUrl` | string (optional) | **external** | The single switch that activates external mode (dormant when empty). |
| `apiKey` | secret (optional) | external + managed | Client `Authorization`. GET surface exposes only `apiKeySet:boolean`. |
| `externalDatabaseUrl` | secret (optional) | **managed-external-postgres** | → runtime `HINDSIGHT_API_DATABASE_URL`. GET: `externalDatabaseUrlSet`. |
| `llmApiKey` | secret (optional) | **managed** + managed-external-postgres | → runtime `HINDSIGHT_API_LLM_API_KEY`. GET: `llmApiKeySet`. |
| `dataDir` | string (default `~/.hindsight`) | **managed** | Host bind-mount path for managed Postgres data. |
| `bank` | string (default `bobbit`) | all | Shared tag-scoped bank id. |
| `namespace` | string (default `default`) | all | Hindsight namespace path segment. |
| `recallScope` | enum `project` \| `all` (default `all`) | all | |
| `autoRecall` / `autoRetain` | boolean (default `true`) | all | |
| `recallBudget` | number (default `1200`) | all | positive. |
| `timeoutMs` | number (default `4000`) | all | positive. |

### 5.2 Secret handling (panel rules)

- The GET response never returns raw secrets — only `*Set` booleans. The panel
  renders a secret input with placeholder "•••• set" when `*Set` is true, empty
  otherwise.
- An **untouched** secret field is **omitted** from the POST body (so the stored
  value is preserved — the route merges `{ ...prev, ...overrides }`).
- A field the user **clears** sends `""` (the route's `validateConfigOverrides`
  treats `""`/`null` as "clear this optional secret").
- A field the user **edits** sends the new string.

### 5.3 Validation parity

The panel does light client-side gating (mode-required fields), but the route's
`validateConfigOverrides` is authoritative: on `{ ok:false, errors }` the panel
renders the `errors[]` inline next to Save and does not mutate its snapshot. This
keeps a single validation source of truth.

### 5.4 Mode-conditional required fields (client gate, mirrors `isConfigured`)

- `external`: Save is meaningful only with a non-empty `externalUrl` (else the
  provider stays dormant — surface a hint, do not block).
- `managed`: requires `llmApiKey` to actually start (per `runtimes/hindsight.yaml`
  + `memory.yaml`); the panel surfaces this as a "required to start" hint, but
  `isConfigured` is true on mode select alone, so Save still persists.
- `managed-external-postgres`: requires `externalDatabaseUrl` + `llmApiKey` hints.

---

## 6. Status & search rendering

### 6.1 Layout (theme-compatible)

A single scrollable panel with three sections, each a `card`-class block:

1. **Status card** (top). Driven by `status`:
   - **State badge**: derive from `{ configured, healthy, mode }`:
     - not `configured` → `Dormant` (muted) — "Not configured".
     - `configured` + `healthy` → `Connected` (`--positive`).
     - `configured` + `!healthy` → external: `Unreachable` (`--negative`);
       managed: `Starting / not running` (`--warning`) (managed health is
       runtime-gated and may lag config).
   - Rows: mode, bank, namespace, recallScope, autoRecall/autoRetain.
   - **Retry-queue counter**: `queueDepth` rendered as a chip ("N queued retains").
   - **Recent retains**: P2 `status` exposes `queueDepth` + `lastError` only (not a
     retains list). P4 surfaces `queueDepth` as the retry-queue counter and, when
     present, `lastError.{message,ts}` as a muted diagnostic line. A richer "recent
     retains" list is **not** added in P4 (no route exists); the section header
     reads "Retry queue" to match the available data. *(If a future route adds a
     retains feed, this section extends without layout change.)*
   - **Logs link**: a `host.ui.navigate`/anchor to the managed runtime logs surface
     for managed modes (the marketplace/runtime logs view); for external mode the
     "logs" affordance is hidden (no Bobbit-managed process). The link target is the
     runtime/marketplace route, not a raw URL the panel constructs.
   - **Refresh** button → re-calls `status`.

2. **Config card** (middle). The form from §5, mode-conditional. A **Save** button
   POSTs changed keys to `config`, then re-fetches `status`. Inline validation
   errors render here.

3. **Search card** (bottom). A query input + scope toggle (project/all) + Search
   button → `recall`. Results render as a list of memory cards:
   - each shows `memory.text` (escaped via the lit toolkit), optional `score` chip,
     optional `id` (muted, monospace).
   - empty result → "No memories matched." ; `configured:false` → "Configure
     Hindsight to search memory." ; route `error` → muted error line.

### 6.2 State machine (per session, closure-cached)

`status ∈ loading | ready | error` for config + status snapshots; `search ∈
idle | searching | results | empty | error`. Saves flip a transient `saving`
flag. A bounded poll (e.g. 1.5s interval, capped) runs **only** while a managed
mode is `configured && !healthy`, to flip the badge to Connected when the runtime
comes up; it stops on healthy/terminal and on unmount. External mode does not poll
(health is immediate).

### 6.3 Test hooks

Stable `data-testid`s for the E2E (names indicative):
`hindsight-panel`, `hindsight-status-card`, `hindsight-status-badge`
(+ `data-state`), `hindsight-queue-depth`, `hindsight-mode-select`,
`hindsight-external-url`, `hindsight-api-key`, `hindsight-bank`,
`hindsight-namespace`, `hindsight-data-dir`, `hindsight-external-db-url`,
`hindsight-llm-api-key`, `hindsight-save`, `hindsight-config-error`,
`hindsight-search-input`, `hindsight-search-scope`, `hindsight-search-submit`,
`hindsight-memory-result` (+ `data-memory-id`), `hindsight-search-empty`,
`hindsight-refresh`.

---

## 7. E2E fixture / test plan

New browser spec `tests/e2e/ui/hindsight-pack.spec.ts`, modelled on
`tests/e2e/ui/pr-walkthrough-pack.spec.ts` (built-in band, no install) and the
config/stub seam of `tests/e2e/hindsight-external.spec.ts`.

### 7.1 Harness & fixtures

- The Hindsight pack resolves **active-by-default** via the built-in band (no
  install) — assert it in `/api/ext/contributions` (panel `hindsight.panel` +
  entrypoints `hindsight-palette`, `hindsight-route` + routes incl.
  `config`/`status`/`recall`).
- Back `status.healthy` + `recall` with the existing in-process
  `tests/e2e/hindsight-stub.mjs` (`startHindsightStub`, `seedMemories`,
  `setHealthy`). The gateway shares the in-process pack-store singleton, so the
  panel's `config` POST and the stub URL line up the same way the API spec's
  `seedConfig` does — except here config flows **through the panel**, proving the
  panel replaces store-seeding as the config path.
- Seed memories on the stub for the search assertion
  (`seedMemories("bobbit", [{ text: "feature flag rollouts", id: "m1" }])`).

### 7.2 Scenarios (the required coverage)

1. **Open panel — command palette.** Run the palette launcher
   (`__bobbitRunPackLauncher` hook → `hindsight.palette`, or the command-palette
   UI); assert `hindsight.panel` mounts in the active session
   (`[data-testid=hindsight-panel]`), status badge shows `Dormant` initially.
2. **Set external URL + bank → Save.** Select mode `external`, type the stub URL
   into `hindsight-external-url`, set `hindsight-bank` to `bobbit`, click
   `hindsight-save`. Assert the `config` POST fired and returned `ok:true`, and the
   panel reflects the persisted values.
3. **Stub status flips to connected.** With the stub healthy, after Save (which
   re-fetches `status`), assert `hindsight-status-badge` `data-state="connected"`
   (`Connected`). Toggle `stub.setHealthy(false)` + Refresh → badge `unreachable`;
   restore → `connected` again.
4. **Search renders seeded memories.** Type a query into `hindsight-search-input`,
   submit; assert a `hindsight-memory-result` with the seeded text renders
   (escaped). Assert the stub recorded a `recall` against bank `bobbit`.
5. **Persistence across reload.** Reload the page, re-open via the **deep link**
   `#/ext/hindsight` (`navigateToHash`); assert the panel rehydrates `config` from
   the route (external URL persisted, bank `bobbit`) and status badge is
   `connected` — proving config persisted server-side via the route, not via a
   client-only store.

### 7.3 Secret-redaction assertion (security)

After saving an `apiKey`, reload and assert the `hindsight-api-key` field shows the
"set" placeholder and the raw key is **never** present in the DOM or the `config`
GET payload (only `apiKeySet:true`).

### 7.4 Skip-guard

Gate the suite on the built panel + stub being present (mirror
`hindsight-external.spec.ts`'s `DEPS_READY`), so the e2e phase stays green before
this branch merges:

```js
const DEPS_READY = fs.existsSync(path.join(PACK_SRC, "lib", "HindsightPanel.js"))
  && fs.existsSync(path.join(PACK_SRC, "panels", "hindsight-memory.yaml"))
  && fs.existsSync(STUB_PATH);
```

---

## 8. Security & theme constraints

**Security.**

- **No raw fetch / no escape hatch.** All dynamic data flows through the versioned
  Host API: `host.callRoute` (pack-scoped to `/api/ext/hindsight/*`) and
  `host.store`. The panel never constructs gateway URLs and never reaches another
  pack's routes/store. This mirrors the pr-walkthrough/artifacts invariant.
- **Secrets are write-only from the client.** The `config` GET surface returns only
  `*Set` booleans (`redactConfig`); the panel never displays a stored secret value.
  Untouched secret fields are omitted from POST so they are preserved; explicit
  clear sends `""`. The route validates + persists; the panel trusts the route's
  redaction.
- **No auto-mutation on mount.** Mount triggers only **read** calls
  (`config` GET, `status` GET) and an optional bounded health poll for managed
  modes. Writes (`config` POST, `recall` POST) are user gestures (Save / Search).
  No `retain`/`reflect` is ever called by the panel.
- **Logs link** points at the existing runtime/marketplace logs surface via
  `host.ui.navigate` — the panel does not embed or proxy log content, and the link
  is shown only for managed modes (no managed process exists in external mode).
- **Dormancy preserved.** A dormant pack returns clean structured signals
  (`configured:false`, empty lists) from every route, so the panel renders a safe
  "not configured" state with no network touched — the panel does not change the
  provider's dormancy gate.

**Theme.**

- Use **only** Bobbit theme tokens / the injected lit toolkit — never hardcode
  colours, never define a `:root` palette, never use `prefers-color-scheme`.
- Status semantics use the semantic slots: `--positive` (connected), `--negative`
  (unreachable), `--warning` (starting/managed-not-running), `--muted-foreground`
  (dormant / secondary text). Reference `var(--muted-foreground)` directly (never
  alias a surface token with a single-mode fallback).
- All structured/recall data is rendered through the escaping lit toolkit
  (`html`/`nothing`) — memory text, error strings, and ids are never injected as
  raw HTML.
- Scope all DOM/styles to the panel root; the change set touches **only** the
  Hindsight pack panel + entrypoints + build entry + the new E2E fixture/spec — no
  app-shell or built-in UI files.

---

## 9. Build & verification

1. `node scripts/build-market-packs.mjs` (via `npm run build`) emits
   `market-packs/hindsight/lib/HindsightPanel.js` (browser bundle, `lit` external).
2. `npm run check` — typecheck (panel is `.js`, but the YAML/contribution wiring is
   typed server-side).
3. `npm run test:unit` then `npm run test:e2e` — the new browser spec
   (§7) runs in the e2e phase.

---

## 10. Decision log

- **D1 — Owner-session panel, not spawn.** The config/status surface belongs to the
  active session; a `PanelTarget` command-palette launcher + `kind:"route"` deep
  link match the artifacts pattern. Spawn launchers are for minting sub-agents
  (pr-walkthrough), which this feature has none of.
- **D2 — No new routes.** P2's `config`/`status`/`recall` are sufficient; the panel
  is a pure client. "Recent retains" is surfaced as the `queueDepth` retry counter
  + `lastError` because no retains-feed route exists — adding one is out of P4
  scope.
- **D3 — Config goes through the route, never `host.store` directly.** Validation
  (`validateConfigOverrides`) + redaction (`redactConfig`) live server-side; a
  direct store write would bypass both. Store-seeding stays a test-only seam.
- **D4 — Singleton panel.** One config/status panel per session view
  (no `instanceParam`), so the deep link needs no params and rehydrates entirely
  from the routes.
