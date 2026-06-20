# Hindsight UX Polish — design doc

Status: design / UX spec. Owner gate: `design-doc`. Scope is the **UX** of the
Hindsight memory extension across two surfaces — the **Marketplace installed
row** (primary setup path) and the **native Hindsight panel** (config / status /
search) — plus a **guided setup walkthrough** for both Bobbit-managed and
self-managed/external deployments. It fixes the panel **stale-form** regression
and adds the missing state/action vocabulary the goal calls out.

Companion interactive prototype: [`hindsight-ux-polish.prototype.html`](./hindsight-ux-polish.prototype.html)
(self-contained; open in a browser, or via the preview panel). The prototype IS
the visual spec — it demonstrates every row state, the wizard flow, and all
interaction states with Bobbit theme tokens.

This doc changes **no production code or tests**. It is the implementation
contract for the follow-on `implementation` gate. It builds on and must preserve:

- [hindsight-pack-external.md](./hindsight-pack-external.md) — external client/provider, dormancy gate, config schema.
- [hindsight-panel-p4-implementation.md](./hindsight-panel-p4-implementation.md) — the native panel (P4), `config`/`status`/`recall` routes.
- [pack-based-marketplace.md](./pack-based-marketplace.md) — installed rows, activation toggles, the managed-runtime consent enable-card (§8).
- `market-packs/hindsight/runtimes/hindsight.yaml` — `startPolicy: on-enable` (Docker never auto-starts).

---

## 0. Problem statement (observed)

1. **Stale form (the headline bug).** After Hindsight is configured externally
   (`http://localhost:9177`, bank `hermes`, timeout `15000`, auto-retain on) the
   panel's **status card** correctly shows `Connected` + `hermes` after Refresh,
   but the **configuration form** still shows empty External URL, bank `bobbit`,
   timeout `1500`. Pressing **Save** would diff those stale defaults against the
   persisted config and **overwrite the good config**.

   Root cause (panel.js): `loadConfig` runs **once** behind the `mountKicked`
   guard; the **Refresh** button calls only `loadStatus`. If config is persisted
   by any path after the panel mounted (the marketplace, a deep-link in another
   view, the API), the form never re-hydrates, and `buildSaveBody` diffs the
   user's draft against the stale `entry.config` baseline — so Save ships
   stale values as "changes".

2. **Flat Marketplace state.** The built-in `hindsight` installed row collapses
   to a single `Enabled` lozenge (the generic master toggle). It hides the six
   distinctions that actually matter for memory: Disabled, Dormant/unconfigured,
   External connected, External unreachable, Managed stopped/starting/running/
   unhealthy.

3. **Setup is undiscoverable and unguided.** The Marketplace is meant to be the
   primary setup path but offers no Configure / Test / Open-UI / Start / Stop /
   Logs actions and no guided walkthrough. Users fall back to the command palette
   and hand-edit fields with no explanation of API-URL vs UI-URL, recommended
   defaults, or what "managed" will actually start.

---

## 1. Design principles for this surface

- **The Marketplace row is the front door; the panel is the workbench.** The row
  tells you *what state Hindsight is in* and offers the next safe action. The
  panel is where you do detailed config, search, and read logs.
- **State is never ambiguous.** Every row resolves to exactly one badge with a
  semantic colour, an icon (colour is never the only signal), and a one-line
  plain-language explanation.
- **No surprise side effects.** Selecting "managed" must never start Docker.
  Starting Docker is always a separate, explicit, consented action with a
  disclosure of exactly what will run.
- **Persisted config is the source of truth.** The UI shows what is actually
  stored, refreshes both config and status together, and never lets a stale
  draft silently overwrite a good config.
- **Reuse the existing grammar.** Match the marketplace toggle/badge/card
  primitives, the panel's `hs-*` classes, and Bobbit theme tokens exactly — no
  new palette, no `prefers-color-scheme`.

---

## 2. State model — the single source of truth

Both surfaces derive their badge from the **same** function of three inputs:
`mode`, `configured`, and `healthy` (+ a managed `runtimeStatus` when present).
This must be one shared helper so the row and the panel can never disagree.

```
deriveHindsightState({ disabled, mode, configured, healthy, runtimeStatus }) → State
```

| # | State | Trigger | Badge | Token | Icon | One-liner |
|---|---|---|---|---|---|---|
| 1 | **Disabled** | pack/provider toggled off | `Disabled` | `--muted-foreground` | `power-off` | "Hindsight memory is turned off." |
| 2 | **Dormant** | enabled, external mode, no `externalUrl` (or managed not yet configured) | `Not configured` | `--muted-foreground` | `circle-dashed` | "No memory backend configured yet." |
| 3 | **External · Connected** | external, `externalUrl` set, `healthy` | `Connected` | `--positive` | `check-circle` | "Connected to your Hindsight at {host}." |
| 4 | **External · Unreachable** | external, `externalUrl` set, `!healthy` | `Unreachable` | `--negative` | `alert-triangle` | "Can't reach Hindsight at {host}." |
| 5 | **Managed · Stopped** | managed, configured, runtime `stopped` | `Stopped` | `--muted-foreground` | `square` | "Managed runtime is stopped." |
| 6 | **Managed · Starting** | managed, runtime `starting` (or `configured && !healthy` while poll runs) | `Starting…` | `--warning` | `loader` (spin) | "Managed runtime is starting…" |
| 7 | **Managed · Running** | managed, runtime `running` + `healthy` | `Running` | `--positive` | `check-circle` | "Managed runtime is running." |
| 8 | **Managed · Unhealthy** | managed, runtime up but health probe failing | `Unhealthy` | `--negative` | `alert-triangle` | "Managed runtime is up but not healthy." |

Notes:
- States 5–8 require runtime context. The Marketplace row has it via
  `GET /api/pack-runtimes?projectId=` (`PackRuntimeStatus`); the panel infers
  `starting` vs `running` from `status.healthy` + its bounded managed-mode poll.
- The panel's existing `deriveBadge` collapses 5/6/8 into one "Starting" badge.
  This spec **splits** them using the runtime status the marketplace already
  fetches; the panel gets the same via a new `runtimeStatus` field on the
  `status` route response (additive, see §7) **or** by reading
  `GET /api/pack-runtimes` directly (it already does for logs). Prefer the
  additive `status` field to keep the panel a pure Host-API client.

The mapping is captured visually in the prototype's "State gallery".

---

## 3. Marketplace installed row — redesign

### 3.1 Anatomy

The built-in `hindsight` row keeps the existing card chrome (`market-pack-card`,
built-in badge, version, description) and the master enable toggle, and **adds a
Hindsight status strip** between the description and the activation controls:

```
┌ hindsight  [Built-in] v1.0.0                              [ Enabled ⃝ ]│  ← master toggle (unchanged)
│ Persistent agent memory backed by Hindsight…                          │
│ ─────────────────────────────────────────────────────────────────── │
│ ◍ Connected   External · http://localhost:9177                        │  ← NEW status strip (state §2)
│ Bank hermes · ns default · recall all · auto-recall on · auto-retain on│  ← active config summary (§4)
│ [ Configure ] [ Test connection ] [ Open Hindsight UI ↗ ]             │  ← action row (§5), state-aware
└───────────────────────────────────────────────────────────────────── ┘
```

The strip renders only for the built-in `hindsight` pack (generic packs keep the
plain activation list). It is driven by a small adapter that reads the pack's
`status` route + `pack-runtimes` status, so it is **Hindsight-specific UI hung
off a generic seam**, not a change to every pack's row.

### 3.2 Badge placement & semantics

- The badge sits left of the strip, using the §2 token + icon. It replaces the
  ambiguous reliance on the generic `Enabled` master lozenge for *memory* state.
- The master toggle still means "is the pack/provider active at all" (State 1 vs
  the rest). When **off**, the strip shows only State 1 and the action row
  collapses to a single muted "Enable to configure" hint.
- When the pack is enabled but dormant (State 2), the badge is muted and the
  **primary** action is `Configure` (opens the guided setup, §6).

### 3.3 Managed runtime rows stay consent-gated

The existing managed-runtime consent enable-card (`renderRuntimeConsentCard`,
§8 of pack-based-marketplace) is unchanged in contract: the runtime toggle is the
explicit on-enable start, and the disclosure (services, ports, volume path,
trust copy) renders inline before it. The new status strip **adds** Start / Stop
/ Restart / View-logs actions (§5) that drive the existing
`/api/pack-runtimes/:id/{start,stop,restart,logs}` routes — it does not bypass
the consent card. Selecting managed mode in Configure writes config only; the
runtime stays Stopped (State 5) until the user explicitly starts it.

---

## 4. Active configuration summary

Surface the live, persisted config compactly on both surfaces (goal requirement).
Source: the `config` GET (redacted) + `status` GET. Render as a single muted line
on the marketplace strip and as the existing `hs-rows` dl in the panel, extended
to include every value:

| Field | Marketplace strip | Panel status card |
|---|---|---|
| Data-plane API URL | `External · {externalUrl}` / `Managed · 127.0.0.1:{port}` | dedicated row, monospace |
| UI / dashboard URL | link chip "Open Hindsight UI ↗" (see §8) | row with the resolved UI URL + copy button |
| Bank | `Bank {bank}` | row |
| Namespace | `ns {namespace}` | row |
| Recall scope | `recall {all\|project}` | row |
| Auto-recall / auto-retain | `auto-recall on · auto-retain on` | row (existing) |
| Timeout | (omitted on strip) | row `{timeoutMs} ms` |
| Queue depth | chip when `>0` | existing `queueDepth` chip |
| Last error | — | existing muted `lastError` line |

Secrets are never shown — only `apiKeySet` etc. as a "key set" chip.

---

## 5. Action inventory (state-aware)

Each action is shown **only** in states where it is meaningful. All actions map
to existing routes; none requires new server endpoints except the optional
`status.runtimeStatus`/`uiUrl` additive fields (§7).

| Action | Visible in states | Effect | Backing call |
|---|---|---|---|
| **Configure** | 1(disabled-hint only)·2·3·4·5·7·8 | Opens guided setup (§6) seeded with current config | opens panel / wizard; persists via `config` POST |
| **Test connection** | 3·4·5·6·7·8 | Runs a one-shot health + recall smoke test, shows inline result | `status` GET (health) + `recall` POST (smoke) |
| **Open Hindsight UI ↗** | 3·7·8 (any time a UI URL is known) | Opens the operator dashboard in a new tab | anchor to resolved `uiUrl` (§8) |
| **Start runtime** | 5 (managed stopped) | Explicit consented start | `POST /api/pack-runtimes/:id/start` |
| **Stop runtime** | 6·7·8 (managed up) | Stops containers, keeps data | `POST /api/pack-runtimes/:id/stop` |
| **Restart runtime** | 7·8 (managed up) | Restart containers | `POST /api/pack-runtimes/:id/restart` |
| **View logs** | 5·6·7·8 (managed) | Inline log tail (existing panel affordance) | `GET /api/pack-runtimes/:id/logs?tail=` |

Layout rules:
- At most **three** buttons inline; overflow into a "⋯ More" menu (matches the
  mobile-action-menus pattern). External mode never shows Start/Stop/Logs (no
  Bobbit-managed process — mirror the existing `RUNTIME_EXTERNAL_GUIDANCE`).
- Destructive/heavy actions (Start a Docker runtime, Stop) get a confirm step
  reusing `confirmAction`; Start additionally routes through the consent card.
- Busy state per action (spinner on the button, disabled siblings) reusing the
  existing `busy` set keyed `hs-action:{id}`.

---

## 6. Guided setup walkthrough

A modal/inline wizard launched from **Configure** (Marketplace) or the panel's
"Set up Hindsight" CTA when dormant. It explains choices, recommends safe
defaults, validates each step, and shows live progress for runtime actions. It
writes through the **same** `config` route + `pack-runtimes` routes — it is a
guided wrapper over the existing surface, not a new config store.

### 6.1 Step 0 — Choose a deployment

A single decision screen with four cards mapping to what Bobbit manages vs what
the user manages (goal requirement):

| Card | mode | Bobbit manages | You manage | When |
|---|---|---|---|---|
| **Bobbit-managed (recommended)** | `managed` | Docker: Hindsight API + Postgres | An LLM API key; a data dir | "I just want memory to work locally." |
| **Bobbit-managed + your Postgres** | `managed-external-postgres` | Docker: Hindsight API | Postgres URL; LLM key | "I have a Postgres I want to use." |
| **Connect existing Hindsight** | `external` | Nothing (client only) | The whole Hindsight deployment | "I already run Hindsight (e.g. Hermes)." |
| **Hermes-local / embedded** | `external` (preset) | Nothing | Hermes runs Hindsight for you | AJ's setup — preset URL `http://localhost:9177`, bank `hermes`. |

Each card states the consent up-front: the two managed cards carry a "Starts
local Docker containers when you press Start" note; the external cards say "No
Docker — Bobbit only talks to a URL you provide."

### 6.2 Self-managed / external branch

Steps:
1. **API URL** — `externalUrl`. Help text: *"The Hindsight data-plane API. This
   is where Bobbit reads and writes memory."* AJ example placeholder
   `http://localhost:9177`. Validation: must be a URL; live "Checking…" → green
   check on a successful `/health`, red on failure (does not block Save).
2. **Optional dashboard / UI URL** — `uiUrl` (new optional config field, §7).
   Help: *"The Hindsight web UI for browsing memory. Optional — used only for the
   'Open Hindsight UI' link."* AJ example
   `http://localhost:19177/banks/hermes?view=data` (and Tailscale equivalent).
   Explicit copy distinguishing **API URL vs UI URL** (§8).
3. **Bank & namespace** — `bank` (default `bobbit`; AJ → `hermes`), `namespace`
   (default `default`). Help explains the shared-bank model (one tag-scoped bank).
4. **API key** (optional) — write-only secret.
5. **Recall/retain & limits** — auto-recall, auto-retain toggles, recall scope,
   timeout. Recommended defaults pre-filled (§9) with inline rationale.
6. **Smoke test** — a single "Test & finish" that runs health → recall → retain →
   recall round-trip, rendering each as a progress row (✓/✗). Failure is
   non-blocking; the wizard still saves and explains what's degraded.

### 6.3 Bobbit-managed branch

Steps:
1. **Consent & what-will-run** — the existing capability disclosure (services
   `api`,`db`; allocated loopback ports; volume path; trust copy). Explicit:
   *"Nothing starts yet. Bobbit will start these containers only when you press
   Start at the end."*
2. **LLM API key** (required to start) — write-only secret → runtime
   `HINDSIGHT_API_LLM_API_KEY`. Inline note that it never leaves the host config.
3. **Data dir** (`managed`) or **Postgres URL** (`managed-external-postgres`,
   required) — with the AJ-safe default `~/.hindsight`.
4. **Bank & namespace / limits** — as external, recommended defaults.
5. **Start runtime** — the explicit Start button. Renders a **progress
   timeline** driven by the runtime status transitions + logs poll:
   `Pull image → Create containers → Start → Health check → First recall/retain
   smoke test`. Each step is a row with pending/active(spinner)/done/failed
   states. The timeline reads `GET /api/pack-runtimes?…` status + `/logs` (no new
   route); in normal E2E these events are **mocked/stubbed** (no real Docker).

### 6.4 Progress & validation contract

- Every step has a **validate-on-advance** gate (URL well-formed, required
  secret present for the chosen mode) surfaced inline; the wizard never advances
  past an invalid required field but **never blocks** on a failing health probe
  (degraded-but-saved is valid).
- The wizard's "Save" writes only **changed** keys (same diff discipline as the
  panel) so it can't clobber unrelated config.
- The progress timeline is a pure projection of runtime status/log events; on
  failure it shows the failing step + the relevant log tail + a Retry that
  re-issues the same start call.

---

## 7. Stale-form fix (the regression)

This is a UX + state-machine fix in `market-packs/hindsight/src/panel.js`. No
route changes are required for the core fix.

### 7.1 Refresh re-hydrates BOTH config and status

`Refresh` (and the post-Save refresh, and the marketplace strip's reload) must
call `loadConfig` **and** `loadStatus`. The status card and the form must always
reflect the same load generation.

### 7.2 Reconcile draft against freshly-loaded config (dirty-aware)

On every `loadConfig` resolution:

- If the user has **no unsaved edits** (`dirty === false`): **reseed the draft**
  from the freshly-loaded redacted config (current behaviour only runs at mount;
  extend it to every load). This alone fixes the observed repro.
- If the user **has unsaved edits** (`dirty === true`) **and** the loaded config
  differs from the baseline the draft was seeded from: **do not silently
  overwrite**. Show a non-destructive banner in the config card:

  > "Configuration changed on the server since you started editing.
  > [Reload] discards your edits · [Keep editing] keeps them."

  `Reload` reseeds the draft + clears dirty; `Keep editing` keeps the draft and
  pins the baseline to the newly-loaded config so a later Save diffs correctly.

### 7.3 Save never diffs against a stale baseline

`buildSaveBody` must diff against the **last loaded** config, and a Save must
first ensure `entry.config` is fresh:

- Before sending, re-`GET config`; if it changed since the draft baseline and the
  user hasn't acknowledged, show the §7.2 banner instead of saving (optimistic
  concurrency, last-load-wins is unacceptable for a memory backend URL).
- After a successful Save, reseed draft + clear dirty (existing) **and** reload
  status (existing). Add: reload config too so the redacted `*Set` chips refresh.

### 7.4 Regression test (for the tester gate)

Browser E2E: mount panel (dormant) → persist a config to `hermes`/`15000`/
`http://localhost:9177` via the `config` route out-of-band → click **Refresh** →
assert the **form** fields (`hindsight-external-url`, `hindsight-bank`,
`hindsight-timeout`) now reflect the persisted values, not the defaults → assert
a subsequent **Save** with no edits sends an **empty** diff body (no clobber).
Plus the dirty-aware path: edit a field, push an out-of-band change, Refresh →
assert the "changed on server" banner renders and the user's edit is preserved.

### 7.5 Optional additive route fields

To let the panel split managed states (§2) and render the UI-URL link without a
raw `pack-runtimes` read, add **optional** fields to the `status`/`config`
contracts (additive, backward-compatible):

- `status.runtimeStatus?: "stopped"|"starting"|"running"|"unhealthy"` — mirrors
  the supervisor status for managed modes (absent in external mode).
- `config.uiUrl?: string` — operator dashboard URL (external/managed); redacted
  surface unchanged (not a secret). Drives "Open Hindsight UI" (§8).

These are the **only** contract additions and both are optional; the core
stale-form fix does not depend on them.

---

## 8. API URL vs UI/dashboard URL — copy & examples

Users conflate the data-plane API (what Bobbit talks to) with the human web UI.
Make the distinction explicit everywhere a URL appears.

- **API URL** (`externalUrl`): *"The Hindsight data-plane API — where Bobbit
  reads and writes memory. Usually port 9177 locally."*
  AJ example: `http://localhost:9177`.
- **UI / dashboard URL** (`uiUrl`, optional): *"The Hindsight web dashboard for
  browsing your memory. Bobbit never reads through this — it's just a convenience
  link."*
  AJ examples:
  - Local: `http://localhost:19177/banks/hermes?view=data`
  - Tailscale: `http://<tailscale-host>:19177/banks/hermes?view=data`

Rules:
- The panel and the marketplace strip show the **API URL** as the primary
  identity ("External · http://localhost:9177").
- "Open Hindsight UI ↗" appears only when a `uiUrl` is known (or, for managed
  mode, can be derived from the allocated web port). It opens in a new tab; it is
  never used for data calls.
- If `uiUrl` is unset, the action is hidden and the wizard step explains it is
  optional. Never fabricate a UI URL from the API URL (different port/path).

---

## 9. Recommended defaults (explainer)

Surface a "Recommended defaults" explainer in the wizard (and as a `?` popover on
the panel) stating Bobbit's opinionated, safe defaults and the rationale:

| Setting | Default | Rationale (shown) |
|---|---|---|
| Data locality | local / private | "Your memory stays on your machine unless you point at a shared deployment." |
| Bank | `bobbit` (shared) | "One shared, tag-scoped bank. Use an existing bank like `hermes` only when connecting to one." |
| Namespace | `default` | "Leave as `default` unless your Hindsight uses namespaces." |
| Auto-retain | on (async) | "Memories are saved in the background after each turn — no latency cost." |
| Auto-recall | on | "Relevant memories are pulled in automatically at session start and each turn." |
| Recall scope | `all` | "Search across everything you've done — 'have we solved this before, anywhere?'" |
| Timeout | `1500 ms` | "Conservative: Hindsight calls never stall a turn; on timeout, recall skips and retains queue." |
| LLM key (managed) | none (user-supplied) | "Hindsight uses your LLM key for extraction. Bobbit forwards it to the local runtime only; it never hardcodes a provider secret." |

The explainer must avoid hardcoding provider-specific secrets and must frame the
shared `bobbit` bank as the default with `hermes` as the "connect to existing"
case — matching AJ's setup.

---

## 10. No-auto-start managed mode (consent)

Hard invariant (preserve `startPolicy: on-enable`): **selecting managed must not
start Docker.** The UX enforces this in three places:

1. **Mode selection writes config only.** Picking a managed card in the wizard or
   the panel `mode` select persists `mode` and shows the runtime as **Stopped**
   (State 5). No `compose up`.
2. **Explicit Start.** Docker starts only from the Start button (wizard step 6.3
   or the marketplace runtime row), which is gated by the consent disclosure
   (services/ports/volume/trust). The button label is unambiguous: "Start runtime
   (starts Docker)".
3. **Required-inputs gate.** Start is disabled until the mode's required inputs
   are present (`llmApiKey` for managed; `+ externalDatabaseUrl` for
   managed-external-postgres), with an inline "required to start" hint — matching
   the panel's existing hints. Expected behaviour ("this will pull an image and
   run two containers; it may take ~1–2 min the first time") is shown before the
   first start.

The existing dormancy/no-auto-start E2E coverage must be preserved; add a UI
assertion that selecting managed mode + Save leaves `runtimeStatus: stopped` and
issues no start call.

---

## 11. Discoverability — command palette & git widget

- **Command palette** stays (`Hindsight Memory` launcher → opens the panel) and is
  the secondary entry; the Marketplace row's **Configure** is the primary,
  documented setup path. The palette item's description should read "Configure &
  search agent memory" so it's findable by intent.
- **Git-widget affordance.** Mirror the PR-walkthrough git-widget pattern
  (`kind: git-widget-button`) with a **conditional** Hindsight entry that appears
  in the git status widget dropdown **only once configured and connected**
  (States 3/7). Selecting it opens the Hindsight panel (a `PanelTarget` launcher,
  not a spawn — there's no sub-agent). It sits next to "PR Walkthrough" so memory
  is reachable from the same place reviewers already look. When dormant/disabled
  it is hidden (no dead affordance). This requires the entrypoint to support a
  visibility predicate keyed on the pack `status` — if the entrypoint contract
  can't gate visibility yet, render it always but route a dormant click to
  Configure (never a broken panel).

---

## 12. Consistency rationale (for reviewers/coders)

Per the UX consistency checklist:

1. **Primitives reused.** Marketplace strip uses `market-pack-card`,
   `market-lozenge`, `market-toggle-switch`, `market-runtime-row`, and the
   existing consent card — no new card component. The panel keeps every `hs-*`
   class; new rows reuse `hs-row`/`hs-chip`/`hs-badge`/`hs-btn`.
2. **Badges match `--positive`/`--negative`/`--warning`/`--muted-foreground`** —
   the same tokens the panel's `deriveBadge` already uses; the row reuses them so
   the two surfaces are visually identical for the same state.
3. **Actions sit in the same row group** as the activation toggles, not a new
   floating bar; overflow uses the existing "More" menu pattern.
4. **Affordances** (tooltips, disabled+busy states, confirm dialogs via
   `confirmAction`) match the existing marketplace actions (Update/Uninstall) and
   panel buttons (Save/Refresh/logs).
5. **No new pattern introduced** beyond the status strip + wizard, both of which
   compose existing primitives. The wizard reuses the dialog shell and the
   existing input/toggle/secret field styles from the panel.

Theme: tokens only, no `:root` palette, no `prefers-color-scheme`; categorical
accents (wizard step states, progress timeline) use `--chart-1..3` with
`color-mix` tints, exactly as the panel's chips do.

---

## 13. Test plan (for the testing gate — browser E2E, mocked runtime)

All runtime status/log events are **mocked/stubbed**; real Docker only in
manual-integration. Required coverage (goal):

1. **First-run Configure from Marketplace** → dormant row, click Configure →
   wizard opens → external branch → Save → row flips to Connected (stubbed
   healthy).
2. **Guided setup defaults/explanations** render (recommended-defaults explainer
   present; API-vs-UI copy present; AJ example placeholders present).
3. **External connected** state (stub healthy) and **unreachable** (stub
   `setHealthy(false)`) render the right badge/token on both row and panel.
4. **Stale-form refresh regression** (§7.4) — the headline test.
5. **Open Hindsight UI** action present + opens `uiUrl` (assert anchor target,
   not a navigation).
6. **Managed no-auto-start** — select managed + Save → row shows Stopped, no
   start call issued; pressing Start (with required inputs) issues exactly one
   `start` call and the progress timeline advances through mocked status events.
7. **Progress/status rendering** with mocked runtime events
   (starting → running → healthy; and a failed-health path showing the failing
   step + log tail + Retry).

---

## 14. Decision log

- **D1 — One state function, two surfaces.** Row and panel both derive the badge
  from `deriveHindsightState(mode, configured, healthy, runtimeStatus)` so they
  can never disagree. The panel's current 3-way `deriveBadge` is widened to the
  8-state model.
- **D2 — Marketplace is the primary setup path; palette + git-widget are
  secondary.** Configure on the row launches the guided wizard; the wizard wraps
  the existing `config`/`pack-runtimes` routes (no new config store).
- **D3 — Stale-form fix is dirty-aware, not last-load-wins.** Refresh re-hydrates
  config; clean drafts reseed; dirty drafts get a non-destructive "changed on
  server" banner. Save re-checks freshness before clobbering a memory-backend URL.
- **D4 — No-auto-start is enforced in the UI, not just the backend.** Mode select
  writes config only; Start is the sole Docker trigger, gated by consent +
  required inputs, with an explicit "starts Docker" label.
- **D5 — API URL vs UI URL are distinct fields.** `uiUrl` is an optional,
  non-secret config addition used solely for the "Open Hindsight UI" link; the UI
  URL is never fabricated from the API URL.
- **D6 — Only additive route fields.** `status.runtimeStatus?` and `config.uiUrl?`
  are the sole (optional) contract additions; the core stale-form fix needs none.
- **D7 — Git-widget affordance is conditional.** It appears only when
  configured+connected and degrades to Configure rather than a dead panel when the
  entrypoint contract can't yet gate visibility.
</content>
</invoke>
