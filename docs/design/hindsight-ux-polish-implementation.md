# Hindsight UX Polish — implementation design

Status: design. Owner gate: `design-doc`. Builds on the shipped Hindsight pack
(external mode — [hindsight-pack-external.md](hindsight-pack-external.md); managed
runtime P3; native panel P4 — [hindsight-panel-p4-implementation.md](hindsight-panel-p4-implementation.md))
and PR #820. This document scopes — but does not write — production code/tests.

It exists to fix the UX gaps found while testing PR #820:

1. **Stale config form** — the panel's status card refreshes to the live config
   (Connected + bank `hermes`) while the configuration form keeps showing the
   mount-time defaults (empty External URL, bank `bobbit`, timeout `4000`). Save
   can then silently clobber a good server config.
2. **Opaque Marketplace state** — the built-in `hindsight` row only ever says
   "Enabled", hiding the distinctions between disabled, dormant/unconfigured,
   external connected/unreachable, and managed stopped/starting/running/unhealthy.
3. **Missing setup guidance** — no guided walkthrough, no API-vs-UI-URL
   explanation, no "Open Hindsight UI", no recommended-defaults explainer, no
   explicit managed-mode Start with consent + progress.

The hard invariant that frames every change: **built-in Hindsight NEVER auto-starts
Docker on install/boot/selection** (`runtimes/hindsight.yaml: startPolicy: on-enable`).
Every "start" path stays an explicit user gesture; every status/capability read is a
pure read.

---

## 1. Root-cause analysis

### 1.1 Stale form (the reproduction)

`market-packs/hindsight/src/panel.js` keeps two cached snapshots per session view
(closure `STATE` keyed by `__sessionId`):

- `entry.config` — the last redacted `config` GET response.
- `entry.draft` — the editable form values, seeded by `draftFromConfig(entry.config)`.

The lifecycle today:

- **Mount** (`mountKicked`): kicks `loadConfig` + `loadStatus` once. `loadConfig`
  sets `entry.config` and re-seeds `entry.draft` (when `!dirty` is *not* checked —
  it always overwrites).
- **Refresh button** (`hindsight-refresh`): calls `loadStatus` **only**.
- **Save**: `buildSaveBody` diffs `entry.draft` against `entry.config` and POSTs
  only changed keys; on success re-seeds both from the response.

The defect: **`status` and `config` re-hydrate on different triggers.** `status`
re-reads on every Refresh / poll and reflects the *live* server config (the route
calls `loadEffectiveConfig` fresh each time — `routes.ts::status`). `config` only
re-reads at mount and post-Save. So once the persisted config changes after mount
(configured via the route, by another session/agent, or simply queried before the
record landed), the status card moves to `Connected + hermes` while the form stays
frozen on the mount-time projection.

Two distinct bugs fall out of that single divergence:

- **B1 — stale display**: the form does not reflect the persisted config after a
  Refresh.
- **B2 — silent clobber on Save**: `buildSaveBody` diffs the draft against the
  *stale* `entry.config` base, not the live server config. Any field the user
  touched — or any field whose stale base differs from the live value — is sent and
  overwrites the good record. (`{...prev, ...overrides}` server merge only protects
  keys that are **omitted**; a stale base makes the panel send keys it should not.)

### 1.2 Marketplace state opacity

`renderPackActivationSummary` (`src/app/marketplace-page.ts`) labels the built-in
row purely from the activation catalogue: `enabled === total ? "Enabled" : …`.
It never consults the Hindsight `config`/`status` routes or `GET /api/pack-runtimes`,
so it cannot distinguish dormant-unconfigured from external-connected from
managed-running. The runtime consent card (`renderRuntimeConsentCardView`) discloses
*pre-start* capability but shows no *live* runtime status and offers no Start / Stop /
Test / Open-UI / View-logs actions.

`src/app/api.ts` currently wires only `getPackRuntimeCapabilities`, `downPackRuntime`,
`purgePackRuntime` — there is **no** `listPackRuntimes` / `PackRuntimeStatus` /
`startPackRuntime` / `stopPackRuntime` client binding, even though the server serves
`GET /api/pack-runtimes` and `POST /api/pack-runtimes/:id/{start,stop,restart}`.

### 1.3 API URL vs UI URL

`EffectiveConfig` (`market-packs/hindsight/src/shared.ts`) has `externalUrl` (the
**data-plane API**, what the provider/client dials) but no concept of a human
**dashboard URL**. AJ's setup: API `http://localhost:9177`; UI
`http://localhost:19177/banks/hermes?view=data` (or the Tailscale equivalent). The
UX must explain the two and offer "Open Hindsight UI" — which needs a new optional
`uiUrl` config field.

---

## 2. Implementation partitions (non-overlapping)

Partitions are carved by **file ownership** so parallel coders never touch the same
file. `panel.js` is large and stateful, so ALL panel work is a single partition.

| # | Partition | Files owned (exclusive) | Depends on |
|---|---|---|---|
| **A** | Hindsight panel UX | `market-packs/hindsight/src/panel.js` (+ rebuilt `lib/HindsightPanel.js`) | C (for `uiUrl`/status fields — additive, can stub) |
| **B** | Marketplace state + runtime actions | `src/app/marketplace-page.ts`, `src/app/api.ts` (additive only) | C (status field names) |
| **C** | Pack config schema, routes, entrypoints, manifest | `market-packs/hindsight/src/shared.ts`, `market-packs/hindsight/src/routes.ts`, `market-packs/hindsight/providers/memory.yaml`, `market-packs/hindsight/pack.yaml`, `market-packs/hindsight/entrypoints/*.yaml` | — (lands first) |
| **E** | Browser E2E + stub | `tests/e2e/ui/hindsight-pack.spec.ts` (extend), `tests/e2e/ui/hindsight-marketplace.spec.ts` (new), `tests/e2e/hindsight-stub.mjs` (extend) | A, B, C |

> No partition edits `src/ui/components/GitStatusWidget.ts`: it already renders ALL
> `git-widget-button` launchers generically (`_renderPackLaunchers` →
> `listLauncherEntrypoints('git-widget-button')`). Surfacing a Hindsight affordance
> next to PR Walkthrough is therefore a pure **pack manifest** change (Partition C
> adds a `git-widget-button` entrypoint), not a widget-code change.

**Merge order:** C → (A ∥ B) → E. C is additive and contract-only, so A and B can
develop against the documented field names before C merges.

---

## 3. Partition C — pack config schema, routes, entrypoints (lands first)

All changes are **additive** and preserve PR #820 / P2 route contracts.

### 3.1 `src/shared.ts` — add optional `uiUrl`

- `EffectiveConfig`: add `uiUrl?: string` (human dashboard URL; **never** dialed by
  the client — display/open-only).
- `resolveConfig`: parse `uiUrl` like `externalUrl`
  (`const uiUrl = asString(flat(raw, "uiUrl")); … ...(uiUrl ? { uiUrl } : {})`).
- `validateConfigOverrides`: add `uiUrl` to the optional-string clear list
  (the `["externalUrl", "apiKey", "externalDatabaseUrl", "llmApiKey"]` loop → add
  `"uiUrl"`; it is **not** a secret, so it lives in the plain-string branch, not the
  secret branch). Light validation: if non-empty, must parse as an `http(s)` URL.
- `redactConfig`: echo `uiUrl` verbatim (not a secret).

`uiUrl` is purely informational: it is omitted from `clientConfig` and never
influences `isActive`/`isConfigured` — dormancy and the data-plane stay keyed on
`externalUrl` / runtime base exactly as today.

### 3.2 `providers/memory.yaml` — declare `uiUrl`

Add to the `config:` block: `uiUrl: { type: string, optional: true }`. No
`activation` change (dormancy still gates on `externalUrl`).

### 3.3 `src/routes.ts::status` — surface the values the UX needs prominently

Extend the `status` response `base` (additive — existing keys unchanged) so both the
panel and the marketplace can render the active configured values without a second
round-trip:

```js
const base = {
  configured, mode, bank, namespace, recallScope, autoRecall, autoRetain, queueDepth,
  // additive:
  externalUrl: cfg.externalUrl ?? "",   // data-plane API URL (non-secret)
  uiUrl: cfg.uiUrl ?? "",               // human dashboard URL (non-secret)
  timeoutMs: cfg.timeoutMs,
  recallBudget: cfg.recallBudget,
  ...(err ? { lastError: err } : {}),
};
```

`status` stays dormancy-safe (returns `healthy:false` without dialing an empty base)
and never echoes secrets (only `externalUrl`/`uiUrl`, both non-secret).

### 3.4 Entrypoints — discoverability

- **Keep** `entrypoints/hindsight-palette.yaml` (command-palette) and
  `hindsight-route.yaml` (deep link) — command-palette discoverability requirement
  is already met.
- **Add** `entrypoints/hindsight-git.yaml`:
  ```yaml
  id: hindsight.git
  kind: git-widget-button
  label: Hindsight Memory
  target: { panelId: hindsight.panel }
  ```
  This makes the affordance appear in the git-widget "Extensions" group alongside
  PR Walkthrough. It is a bare `PanelTarget` (opens the panel in the active session
  via `openPackPanel`), **no `action:"spawn"`** — nothing is minted, nothing starts.
- `pack.yaml`: append `hindsight-git` to `contents.entrypoints`
  (`[hindsight-palette, hindsight-route, hindsight-git]`).

> "Show only when relevant/configured" is intentionally **not** gated in the widget:
> the entrypoint is registered while the pack is active, and the panel itself renders
> the dormant/configure state. Gating the launcher on live config would require the
> widget to call pack routes per render (rejected — keeps the widget pack-agnostic).
> The marketplace remains the primary setup path (requirement satisfied); the
> git-widget button is a secondary discoverability surface.

### 3.5 No new pack routes

The panel/marketplace use the existing `config` (GET/POST), `status` (GET),
`recall` (POST) routes plus the server admin runtime routes
(`/api/pack-runtimes/*`). "Test connection" == `status` GET. "Open Hindsight UI" ==
open `uiUrl` (client-side). No `retain`/`reflect` is ever called from any UI.

---

## 4. Partition A — Hindsight panel UX (`market-packs/hindsight/src/panel.js`)

All edits are confined to `panel.js`. Security/theme invariants from the P4 doc §8
are preserved verbatim (no raw fetch except the existing read-only logs affordance;
secrets write-only; no auto-mutation on mount; theme tokens only).

### 4.1 Fix B1+B2 — unified refresh + dirty-aware hydration + safe Save

**4.1.1 Combined refresh.** Add `refreshAll(host, key)` that calls **both**
`loadStatus` and `loadConfig`. Rewire the Refresh button
(`renderStatusCard` → `hindsight-refresh`) to call `refreshAll` instead of
`loadStatus`. Mount continues to kick both (already does).

**4.1.2 Dirty-aware hydration.** `loadConfig` must **not** clobber an in-progress
edit. Change its hydration step:

```js
entry.config = res?.config ?? null;
entry.configured = !!res?.configured;
if (!entry.dirty) {                       // only re-seed when the user has no unsaved edits
  entry.draft = draftFromConfig(entry.config);
  entry.secretTouched = { apiKey:false, externalDatabaseUrl:false, llmApiKey:false };
}
entry.configState = "ready";
```

When `dirty`, the user's draft is preserved AND `entry.config` is still updated to
the fresh server snapshot — which fixes B2 because Save now diffs against the live
base (see 4.1.3). This satisfies the requirement: *"form fields must reflect the
persisted config, unless the user has unsaved edits."*

**4.1.3 Safe Save (no silent clobber).** Before building the POST body, re-read the
live config so the diff base is never stale:

```js
async function save(host, key) {
  const entry = get(key);
  if (!entry?.draft || entry.saving) return;
  entry.saving = true; entry.saveErrors = []; repaint(host);
  // Refresh the diff base from the server so a stale snapshot cannot send keys that
  // overwrite a good config (B2). Does NOT touch the draft (dirty-aware loadConfig).
  await loadConfig(host, key);
  const body = buildSaveBody(get(key));   // diffs draft against the JUST-fetched config
  …POST as today…
}
```

`buildSaveBody` is unchanged — it already sends only keys where `draft !== config`.
With a fresh base, an untouched field that equals the live value is omitted (server
preserves it); only genuinely user-changed fields are sent.

**4.1.4 Unsaved-changes banner + Discard.** In `renderConfigCard`, when
`entry.dirty`, render an inline banner (`data-testid="hindsight-unsaved"`) with a
**Discard** button (`hindsight-discard`) that re-seeds the draft from `entry.config`
and clears `dirty`/`secretTouched`. This makes the "unless the user has unsaved
edits" rule visible and reversible.

`freshEntry()` already initialises `dirty:false`; no shape change needed beyond the
above behaviour.

### 4.2 Surface the active configured values prominently

Extend `renderStatusCard`'s `<dl class="hs-rows">` to include the values now returned
by `status` (§3.3), reading status-first with config fallback:

- **Data-plane URL** — `s.externalUrl` (label "API URL"), with the API-vs-UI
  explainer (4.3). For managed modes show "managed runtime (loopback)".
- **UI URL** — `s.uiUrl` rendered as an **Open Hindsight UI** link
  (`data-testid="hindsight-open-ui"`, `target=_blank rel=noopener`) when non-empty.
- **Timeout** — `s.timeoutMs`. **Recall budget** — `s.recallBudget`.
- Already present: mode, bank, namespace, recallScope, auto recall/retain,
  `queueDepth` chip, `lastError`.

These are read-only projections — no new writes.

### 4.3 API URL vs UI URL explainer

In `renderConfigCard`, the `externalUrl` field hint already exists; extend it and add
a sibling `uiUrl` field:

- `hindsight-external-url` hint: *"API / data-plane URL Bobbit calls to recall &
  retain (e.g. http://localhost:9177). Activates external mode; empty keeps it
  dormant."*
- New `renderField("Dashboard UI URL", "hindsight-ui-url", d.uiUrl, …, { hint:
  "Optional human dashboard opened by 'Open Hindsight UI' — never called by Bobbit
  (e.g. http://localhost:19177/banks/hermes?view=data)." })`.

Add `uiUrl: asText(c.uiUrl, "")` to `draftFromConfig` and `"uiUrl"` to the
non-secret loop in `buildSaveBody`.

### 4.4 Guided setup walkthrough

Add a **Setup** section rendered above the config card when
`!entry.configured` (first-run) OR when the user clicks a "Setup guide" toggle. It is
a small step machine in panel state (`entry.setup = { step, … }`), not a new route.
All steps are pure projection + user-gesture writes.

**Mode chooser (step 1)** with recommended-defaults explainer
(`data-testid="hindsight-setup"`):

- **External** *(recommended when you already run Hindsight, e.g. Hermes-local)* —
  fields: API URL, optional UI URL, namespace, bank, optional API key, recall/retain
  toggles, timeout. Validate-on-next: API URL parses as `http(s)`.
- **Managed (Bobbit-run, managed Postgres)** — required: LLM API key, data dir.
- **Managed + external Postgres** — required: external Postgres URL, LLM API key.

**Recommended-defaults explainer** (`data-testid="hindsight-defaults-explainer"`):
local/private data by default; shared `bobbit` bank unless connecting to an existing
bank like `hermes`; async retain on; auto-recall on; conservative `4000ms` timeout;
"bring your own LLM key for managed extraction — never hardcoded".

**Clear "who manages what" matrix** (`data-testid="hindsight-ownership"`): four rows —
(1) Bobbit-managed Docker runtime, (2) Bobbit-managed Hindsight + external Postgres,
(3) existing external Hindsight data-plane, (4) Hermes-local embedded — each naming
what Bobbit manages vs what the user manages.

**Step validation + progress (external).** Next/validate per step; final step runs a
**connection test** (`status` GET → healthy) then a **first recall/retain smoke
test** (`recall` GET with a probe query; retain is **not** auto-fired — display "auto
retain happens on your next turn" to honour no-unsolicited-writes). Render a progress
list with `data-testid="hindsight-setup-progress"` and per-step states
(pending/running/ok/fail).

### 4.5 Managed mode — explicit Start, consent, progress (NO auto-start)

The P4 panel writes **config only** and never starts Docker. This is preserved and
made explicit:

- **Selecting `managed` / `managed-external-postgres` does NOT start anything.** Mode
  is a local draft change; Save persists config only.
- Add an explicit **Start runtime** button (`hindsight-start-runtime`) shown for
  managed modes once `configured`, gated behind a **consent disclosure**
  (`hindsight-managed-consent`) that lists: required inputs present? (LLM key /
  external PG URL / data dir), images/services, loopback ports, data path, and "this
  starts local Docker containers". The button is enabled only when required inputs
  are set; clicking it is the explicit start gesture.
- Start dispatches `POST /api/pack-runtimes/:id/start` via the existing authed
  gateway fetch the panel already uses for logs (`gatewayBase()`/`gatewayToken()`,
  `RUNTIME_API_ID`) — the only raw-gateway seam, confined to runtime admin actions.
  After start, the existing bounded health poll (`maybePoll`) flips the badge to
  Connected; render a **progress list** (`hindsight-runtime-progress`) driven by
  status transitions (image pull / container start / health) using the runtime
  status + logs the panel already reads.
- A **Stop runtime** button (`hindsight-stop-runtime`) → `POST …/stop`.

> Invariant enforcement in this partition: there is **no** `start`/`compose up` call
> on mount, on mode-select, or inside Save. The only start path is the
> `hindsight-start-runtime` click handler. The E2E (§6) asserts this.

### 4.6 Test hooks added

`hindsight-unsaved`, `hindsight-discard`, `hindsight-ui-url`, `hindsight-open-ui`,
`hindsight-setup`, `hindsight-defaults-explainer`, `hindsight-ownership`,
`hindsight-setup-progress`, `hindsight-managed-consent`, `hindsight-start-runtime`,
`hindsight-stop-runtime`, `hindsight-runtime-progress`. Existing hooks unchanged.

---

## 5. Partition B — Marketplace state + runtime actions

### 5.1 `src/app/api.ts` — additive runtime bindings

Add (mirroring the existing `getPackRuntimeCapabilities` style and
`encodeRuntimeApiId`):

```ts
export interface PackRuntimeStatus {
  packId: string; runtimeId: string;
  state: "running" | "starting" | "stopped" | "unhealthy" | "unknown";
  healthy?: boolean; startPolicy?: string; mode?: string;
  ports?: PackRuntimePortInfo[]; lastError?: string;
}
export function listPackRuntimes(projectId?: string): Promise<MarketResult<{ runtimes: PackRuntimeStatus[] }>>;
export function startPackRuntime(opts: { packId; runtimeId; projectId? }): Promise<MarketResult<PackRuntimeStatus>>; // POST …/start
export function stopPackRuntime(opts:  { packId; runtimeId; projectId? }): Promise<MarketResult<PackRuntimeStatus>>; // POST …/stop
```

> Confirm the exact server `PackRuntimeStatus` shape against
> `GET /api/pack-runtimes` (`pack-runtime-supervisor.ts`) and mirror it — do not
> invent fields. Adjust the union to the server's literal `state`/`status` values.

Also add a tiny pack-route reader so the marketplace can read Hindsight config/status
the same way the panel does (the marketplace is app-realm, not a panel host, so it
uses the REST surface directly):

```ts
// POST /api/ext/route/:name on the active session/pack scope; GET-style routes use {method:"GET"}.
export function callHindsightRoute(name: "config"|"status", init): Promise<MarketResult<any>>;
```

(Resolve the precise `/api/ext/route/:name` request shape from `server.ts` §"POST
/api/ext/route/:name" — it is pack-scoped via headers; reuse the same auth the other
`marketFetch` calls use.)

### 5.2 `src/app/marketplace-page.ts` — derived state label + actions

**5.2.1 State derivation.** Replace the built-in Hindsight row's label logic (only)
with a derivation that combines:

- activation (`activationByPack`) → **Disabled** when the pack/runtime toggle is off;
- `status` route (`configured`, `mode`, `healthy`) → **Dormant** (configured:false),
  **External connected** / **External unreachable** (external mode), and
- `listPackRuntimes` for the `hindsight` runtime → **Managed stopped / starting /
  running / unhealthy**.

Add a module cache `hindsightStatus` + `hindsightRuntimes`, fetched best-effort in
`loadMarketplaceData` (alongside the existing background loads) and invalidated the
same way `invalidateRuntimeCapabilities` is. Render the derived state as a badge
(`data-testid="market-hindsight-state"`, `data-state=…`) on the built-in row. This
is **read-only** — fetching status/runtime list never starts Docker.

> Scope the derivation to the built-in `hindsight` pack row only; generic packs keep
> the existing `Enabled/Disabled/Partially enabled` summary. Implement as a small
> branch in `renderBuiltinPackCard` that, when `pack.packName === "hindsight"`,
> renders the richer state header + action bar in addition to the activation toggles.

**5.2.2 Actions.** Add an action bar on the built-in Hindsight row
(`data-testid="market-hindsight-actions"`):

- **Configure** → open the panel (`runLauncherEntrypoint(launcherKey("hindsight","hindsight.palette"))`
  or `openPackPanel`). Primary setup path.
- **Test connection** → `status` GET; show a transient ok/fail lozenge.
- **Open Hindsight UI** → open `status.uiUrl` in a new tab (hidden when empty).
- **Start runtime** / **Stop runtime** → `startPackRuntime`/`stopPackRuntime`
  (managed modes only; Start reuses the existing consent card
  `renderRuntimeConsentCardView` as the disclosure, and remains an explicit click).
- **View logs** → reuse the runtime logs route (managed only) — link to the existing
  logs surface or open the panel's logs view.

All actions are explicit clicks. The consent card already gates managed-runtime
disclosure; Start stays the only Docker-starting path and is never auto-invoked.

### 5.3 No regression to activation semantics

The existing master toggle / per-entity toggles and the `runtimes` consent card are
untouched in behaviour. The derived state + action bar are **additive** UI on the
built-in row. `handleToggleAllActivation` already covers the `runtimes` array so the
master OFF still stops the managed runtime.

---

## 6. Partition E — Browser E2E + stub

Extend `tests/e2e/hindsight-stub.mjs` minimally (config-snapshot helper) and the
runtime supervisor mock seam (`registerPackRuntimeSupervisorFactory`, already used by
runtime E2E) so runtime status/events are **mocked/stubbed** — *no real Docker in
the e2e phase* (real Docker stays in `tests/manual-integration/`).

New/extended specs:

| Spec | Scenario | Key asserts |
|---|---|---|
| `hindsight-pack.spec.ts` (extend) | **Stale-form refresh regression (B1/B2)** | Mount dormant → seed config server-side out-of-band → click **Refresh** → form reflects persisted external URL + bank + timeout (not defaults). Then with an unsaved edit, Refresh keeps the edit; Save diffs against the live base and does not clobber untouched keys. |
| `hindsight-pack.spec.ts` (extend) | **Open Hindsight UI** | Save `uiUrl` → `hindsight-open-ui` visible with correct `href`; absent when empty. |
| `hindsight-pack.spec.ts` (extend) | **Guided setup defaults/explanations** | First-run shows `hindsight-setup` + `hindsight-defaults-explainer` + `hindsight-ownership`; external step validates URL; connection-test progress reaches ok against the healthy stub. |
| `hindsight-pack.spec.ts` (extend) | **Managed no-auto-start** | Select `managed`, fill LLM key, Save → assert **no** `POST /api/pack-runtimes/:id/start` fired. Click `hindsight-start-runtime` → exactly one `/start` request; progress + badge advance via mocked runtime status. |
| `hindsight-marketplace.spec.ts` (new) | **First-run Marketplace configure path** | Built-in row shows `market-hindsight-state` = Dormant; **Configure** opens the panel. |
| `hindsight-marketplace.spec.ts` (new) | **External connected state** | With healthy stub configured, row state = External connected; **Test connection** ok; **Open Hindsight UI** href = `uiUrl`. |
| `hindsight-marketplace.spec.ts` (new) | **Managed status rendering (mocked runtime events)** | Mocked supervisor reports stopped→starting→running; row state tracks it; **Start**/**Stop** call the right routes; selecting managed / loading the page never fires `/start` (no-auto-start). |

Skip-guards mirror the existing `DEPS_READY` + `resolveHindsightContribution`
pattern so the e2e phase stays green before the branches merge.

---

## 7. Invariant & contract checklist

- **No-Docker-auto-start (hard):** the ONLY start paths are the panel
  `hindsight-start-runtime` click (Partition A §4.5) and the marketplace **Start**
  button (Partition B §5.2.2). Mount, mode-select, Save, status/capability reads, and
  marketplace load never call `/start` or `compose up`. Pinned by E2E §6
  (managed-no-auto-start) and preserved `startPolicy: on-enable`.
- **Secrets write-only:** `uiUrl`/`externalUrl` are non-secret and echoed; `apiKey`/
  `externalDatabaseUrl`/`llmApiKey` stay `*Set`-only. No new field is a secret.
- **PR #820 / P2 contracts preserved:** all route changes are additive
  (`status` gains non-secret fields; new optional `uiUrl`). No route removed/renamed.
- **Data-plane target unchanged:** Bobbit dials the API (`externalUrl` / runtime
  base) only; `uiUrl` is open-only and never dialed.
- **Theme/security:** panel keeps theme-token-only styling and the single read-only
  raw-gateway seam (now also used for explicit start/stop admin actions); all data
  still flows through the Host API / documented REST routes.

## 8. Build & verification

1. `node scripts/build-market-packs.mjs` (via `npm run build`) re-emits
   `lib/HindsightPanel.js` after Partition A.
2. `npm run check`.
3. `npm run test:unit` then `npm run test:e2e` (new/extended browser specs run in the
   e2e phase, runtime mocked).
4. `tests/manual-integration/hindsight-*` remains the only real-Docker path.

## 9. Decision log

- **D1 — One partition owns `panel.js`.** It is large and stateful; splitting it
  across coders would conflict. Marketplace, pack-config, and tests live in disjoint
  files and parallelise cleanly.
- **D2 — Fix the stale form by unifying refresh + dirty-aware hydration + fresh Save
  base**, not by re-architecting. Refresh already re-reads status; making it also
  re-read config (gated on `!dirty`) and diffing Save against the just-fetched config
  closes both B1 and B2 with minimal surface.
- **D3 — `uiUrl` is a new optional, non-secret config field** — the cleanest way to
  separate the API/data-plane URL from the human dashboard and power "Open Hindsight
  UI", without touching dormancy or the client dial path.
- **D4 — Git-widget affordance via a pack entrypoint, not widget code.** The widget
  already renders `git-widget-button` launchers generically; a manifest entry is the
  whole change. Marketplace stays the primary setup path.
- **D5 — Marketplace runtime status is read-only derivation;** Start/Stop are
  explicit additive actions reusing the existing consent card. No change to
  activation semantics or the no-auto-start guarantee.
</content>
</invoke>
