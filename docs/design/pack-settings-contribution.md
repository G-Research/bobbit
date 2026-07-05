# Pack-contributed Settings sections — seam design (S5 prerequisite)

Status: **design only, no code moved**. Written to unblock EXTENSION-SEAM-AUDIT.md
S5 (trusted-GitHub-hosts widget → pr-walkthrough pack) after the S5 row's premise
was found wrong on the live tree (see "S5 CORRECTION" appended to that audit).
This doc proposes the seam S5 needs and does not implement it.

## 1. Problem

`settings-page.ts` embeds a full pr-walkthrough feature — the trusted-GitHub-hosts
list used to gate PR-walkthrough fetches — inside the core General settings tab:

- State + handlers: `settingsGithubTrustedHosts`/`settingsGithubTrustedHostInput`
  (`src/app/settings-page.ts:158-159`), `persistGithubTrustedHosts`/`addTrustedHost`/
  `removeTrustedHost` (`:2768-2805`).
- A **duplicated** validator, `normalizeTrustedHost` (`:180-202`), that must track
  `src/shared/pr-walkthrough/url-safety.ts:37` byte-for-byte — the comment at
  `:173-179` says this is intentional (avoids a chunk-splitting cycle: pulling
  `pr-walkthrough` code into the settings chunk), not an oversight.
- Render: the "Trusted GitHub hosts" block in `renderGeneralTab()` (`:3175-3210`).

This is product policy (a pr-walkthrough feature) living in core UI, justified only
by a build-pipeline workaround. The audit's S5 row proposed moving it into a
pr-walkthrough **pack panel** via the existing `registerPackPanels`/`openPackPanel`
mechanism (`src/app/pack-panels.ts:214,417`), on the premise that seam "already
exists."

### 1.1 Why that premise is wrong

`pack-panels.ts` is **session-scoped end to end**, not just at one call site:

- `openPackPanel` → `mountPackPanelTab` resolves the target session as
  `sessionId || state.selectedSessionId || state.remoteAgent?.gatewaySessionId`
  and **returns without mounting a tab when all three are undefined**
  (`pack-panels.ts:469-470`, `if (!sid) return;`).
- The router (`src/app/main.ts`) nulls `state.selectedSessionId` on every
  non-session view — confirmed at the `goal` route (`:346`) and repeated at seven
  more view branches (`:409,429,446,460,474,488,511,...`), and Settings is reached
  through exactly this kind of non-session route.
- It's not only the null-out: side-panel **tabs are stored per session**
  (`getSidePanelWorkspace(sessionId)`, referenced from `pack-panels.ts:492`
  `panelTabsBySession`) and **rendered only inside the session/chat shell** —
  `renderSidePanelWorkspace()` is called exclusively from the session-view render
  branches in `src/app/render.ts` (`:2990,3013,3028`), always beside
  `state.chatPanel` or inside the session-scoped fullscreen route. `renderSettingsPage()`
  (`settings-page.ts:6041-6110`) has no side-panel-workspace concept at all — no
  docked region, no tab bar, nothing to mount into.
- Underneath both of those: the data itself isn't session data. `githubTrustedHosts`
  is stored in the single global `PreferencesStore` (`src/server/agent/preferences-store.ts`,
  one flat JSON file per gateway instance — `preferences.json` under `stateDir`), read
  through `PUT`/`GET /api/preferences` (`server.ts:7559` special-cases the key) and
  consumed server-side by `src/server/pr-walkthrough/routes.ts:298,1233,1334` via
  `deps.preferencesStore.get("githubTrustedHosts")`. There is no session, and no
  project, in this picture at all.

So a trusted-hosts panel would be structurally unreachable from Settings (no
session ⇒ silent no-op), and even fixing the null-out would leave a mechanism built
for **persistent, per-session, tab-shaped, closable** side content wrapping a global
singleton settings form — the wrong vocabulary for pack authors, not just a routing
bug.

## 2. What exists to build on

`market-packs/*/pack.yaml` + `src/server/agent/pack-contributions.ts` already run an
**auto-discovery contribution-kind pattern**: a pack directory owns one file per
declared contribution, the loader globs the directory into a typed array, and the
array rides inside `/api/ext/contributions` (client type `PackContributionsWire`,
`src/app/api.ts:2692-2700`) for the client registry to reconcile against. Panels are
the reference instance:

- Declaration: `panels/<panel>.yaml` (`{ id, title?, entry, instanceMode?,
  instanceParam? }`), loaded by `loadPanels()` (`pack-contributions.ts:369-414`).
- Client registry: `src/app/pack-panels.ts` — compound `{packId, panelId}` key,
  lazy Blob-URL ESM import of pre-built bytes served from
  `GET /api/ext/packs/:packId/panels/:panelId`, generation-guarded cache
  (`loadPanelModule`), reconciled from contribution metadata on session/project
  switch and pack install/uninstall (`registerPackPanels`, `reconcilePackPanelsForProject`).
- Host binding: a panel's `render(params, host)` gets a `HostApi` scoped to the
  active session **and** the panel's pack-bound surface token
  (`{kind:"pack", packId, contributionKind:"panel", contributionId:panelId}`,
  minted server-side per `docs/marketplace.md` §"Pack IDENTITY..."). `host.store.*`
  is pack-namespaced KV; `host.callRoute` reaches only that pack's own declared
  routes; `host.session.*` reads the bound session.

The existing production pack (`market-packs/pr-walkthrough/`) already has exactly
one panel declared (`panels/pr-walkthrough-panel.yaml`, entry `../lib/panel.js`),
so it is a live example of the pattern this doc reuses.

**Trust model, already documented** (`docs/marketplace.md` §"Pack IDENTITY..."):
pack UI-thread code (renderers, panels) is **not sandboxed at the JS level** — it
runs in the main frame with the same DOM/fetch access as core UI code. The
sanctioned Host API is the *only blessed* path for reaching server state (so
routes/tools/audit-ability stay coherent), but "Model A" explicitly de-scopes
true cross-pack/cross-core isolation: a malicious *installed* pack could already
make raw `fetch` calls with the page's bearer. Putting a first-party pack's code
inside the Settings page adds **no new capability class** beyond what any
installed panel or renderer already has — the trust boundary a pack-settings
contribution needs is the same one panels already live inside: which specific
server capabilities does the mediated Host API expose, not "can the pack's JS run
in this page at all."

## 3. Candidate A — session-less / global pack-panel surface

Extend the existing panel mechanism to support panels with no session:

- `mountPackPanelTab` gets a synthetic scope (e.g. `"__global__"`) instead of
  bailing when `sid` is undefined; `panelTabsBySession` grows a matching bucket.
- `renderSettingsPage()` grows a **new docked-panel region** (its own tab bar +
  content slot, or reuse a subset of `side-panel-workspace.ts`) since it currently
  has zero side-panel affordance — General/Models/etc. are a flat tab switch with
  no split-pane concept.
- `PackPanel.render(params, host)`'s `host` argument is already documented as
  optionally `undefined` when no session is active, so the *contract* half of
  "session-less" is already tolerated; the gap is entirely in the mount/render
  plumbing, not the panel author's contract.
- The trusted-hosts pack module would still be authored as a **panel**: it inherits
  `instanceMode`/`instanceParam`, a tab title, open/close/focus semantics, and
  session-workspace persistence-across-reload — none of which the actual feature
  (an always-visible, singleton, global settings form) needs. Every future
  pack-owned settings widget pays this same tax: author a panel, wire an
  `instanceMode: "singleton"`, discover imperatively why the tab needs a `sessionId`
  parameter that is always undefined for this class of panel.

**Effort** (rough, code-review-inclusive): extend `mountPackPanelTab`/
`panelTabsBySession` for a global scope (~0.5–1 day), design + build a docked-panel
region inside `renderSettingsPage()` from scratch (~1.5–2 days — no reusable
layout exists today), thread the `openPackPanel`/`resolveOpenPanel` no-`sid` path
end to end and re-verify every other panel caller still requires a session where it
should (~0.5 day; this mechanism is currently relied on by session-only call sites,
so loosening it needs a regression sweep), migrate the trusted-hosts widget onto it,
browser e2e. **~4–5 days**, and the *next* pack-owned settings section still starts
from "author a panel + fight the session-shaped API," not from a template built for
the job.

## 4. Candidate B — new `settings-section` contribution kind (recommended)

Add a **fourth auto-discovered pack-scoped contribution kind**, sibling to
`panels/`, `channels/`, `entrypoints/`:

### 4.1 Declaration

```
# market-packs/pr-walkthrough/settings/trusted-hosts.yaml
id: pr-walkthrough.trusted-hosts
title: Trusted GitHub hosts
scope: system          # v1: "system" only (maps to the existing "system" Settings scope)
tab: general            # which existing Settings tab hosts it; omit → new "Extensions" tab
order: 100              # optional; stable sort within a tab, ties broken by packId
entry: ../lib/TrustedHostsSection.js
```

Loaded by a new `loadSettingsSections(packRoot)` in `pack-contributions.ts`,
copy-shaped from `loadPanels()` (same malformed-file/duplicate-id/unsafe-entry
guards, same `sourceFile`/`packRoot` bookkeeping). `PackContribution.settingsSections:
SettingsSectionContribution[]` is additive on the existing contribution record —
no schema version bump needed (mirrors how `panels[]` was added). `scope` is
restricted to `"system"` for v1 deliberately: `githubTrustedHosts` is a
gateway-global preference, and generalizing to `project`-scoped sections is a
separate, later decision once a second, project-scoped consumer exists (YAGNI —
don't design the second case before it's real).

### 4.2 Client registry + rendering

New `src/app/pack-settings-sections.ts`, structurally identical to
`pack-panels.ts` minus everything session/tab-lifecycle-shaped:

- Compound key `{packId, sectionId}`; reconciled from `/api/ext/contributions`
  (extend `PackContributionsWire` with `settingsSections?: PackSettingsSectionWire[]`,
  additive per `docs/marketplace.md`'s forward-compat convention).
- Lazy Blob-URL ESM load from a new pack-addressed endpoint,
  `GET /api/ext/packs/:packId/settings-sections/:sectionId`, mirroring the panel
  serving route (`pack-panels.ts:320`) — same bearer-gated fetch, same
  generation-guarded cache so a superseded load never resurrects stale bytes.
- Contract: `interface PackSettingsSection { render(host: SettingsHostApi):
  TemplateResult }` — **no `params`, no `instanceKey`, no tab lifecycle.** A
  settings section is not a workspace tab; it renders once, inline, wherever its
  declared `tab`/`order` places it.
- `renderSettingsPage()` gains one call per rendered tab:
  `renderPackSettingsSections(scope: "system", tab: currentTab)`, appended after
  the tab's existing built-in content (e.g. `renderGeneralTab()` in
  `settings-page.ts:6097`) as `${renderGeneralTab()}${renderPackSettingsSections("system","general")}`.
  Zero change to the existing tab-switch structure at `:6087-6104` — this is
  additive, not a rewrite of the render switch. A pack that declares no `tab`
  needs an `"extensions"` tab added to `getTabsForScope()`'s system tab list —
  out of scope for the trusted-hosts migration itself (it declares `tab: general`)
  but the fallback should exist before a second pack wants an unplaced section.

### 4.3 Host API for a settings section

Not the full session-bound `HostApi` — there is no session and no `toolUseId`.
A narrower `SettingsHostApi`:

- `host.preferences.get(key)` / `host.preferences.set(key, value)` — **the new
  surface**, key-allowlisted per pack. The pack manifest declares which
  preference keys the section may touch (e.g. an added
  `contents.settingsPreferenceKeys: [githubTrustedHosts]` list, or inline on the
  section YAML); the server mints the pack-bound surface token
  (`{kind:"pack", contributionKind:"settings-section", contributionId}`, same
  minting path as panels/entrypoints per `docs/marketplace.md` §"Pack IDENTITY...")
  and the `/api/preferences` PUT handler checks the token's declared allowlist
  before honoring a pack-attributed write.
- **Defense in depth, non-negotiable regardless of declaration**: keys already
  gated behind `blockedAgentDirKeys` / `isClaudeCodePreferenceKey` /
  operator-confirmation (`server.ts:7500-7551`) are hard-rejected for *any* pack
  token, even one that declared them — a pack settings-section must never become
  a side channel around the Claude-Code-runtime operator-confirmation gate. This
  is a one-line server-side check, but it is the one security-relevant line in
  this whole design and should be reviewed as such.
- No `host.store`, `host.session`, `host.channels` — a settings section isn't
  pack-content persistence or a chat surface; scoping the API down to exactly
  `preferences.{get,set}` is itself the safety property (a section literally
  cannot reach anything else through the mediated API, mirroring how panels
  cannot reach another pack's store).
- `host.callRoute` stays available, unchanged shape, for a pack that wants its own
  route rather than the shared preferences key — trusted-hosts doesn't need it.

### 4.4 Rendering isolation

Identical trust envelope to panels/renderers today (§2): main-frame ESM module,
`HOST_TOOLKIT`-style `{html, nothing}` handed to the factory, no iframe. This is
not a new risk class — it's the same first-party, reviewed, `market-packs/`-built
code that already runs unsandboxed panels; the isolation that matters
(preference-key allowlisting, defense-in-depth blocklist) lives in the *Host API
surface*, not in a JS sandbox that doesn't exist for this class of contribution
today either.

### 4.5 Migration path for trusted-hosts specifically

1. Add `settings/trusted-hosts.yaml` to `market-packs/pr-walkthrough/`, entry
   pointing at a new `lib/TrustedHostsSection.js` built from the *existing* render
   fragment (`settings-page.ts:3175-3210`) plus the existing handlers
   (`:2768-2805`), adapted to call `host.preferences.get/set("githubTrustedHosts")`
   instead of `gatewayFetch("/api/preferences", ...)` directly.
2. **Keep the duplicated `normalizeTrustedHost`** inside the pack module,
   unchanged in behavior — the audit's own note that the duplication defends a
   chunk-splitting workaround still applies; moving the widget into a pack module
   *removes* the reason core needed the copy (pr-walkthrough code no longer needs
   to avoid importing into the settings chunk, because it's not in that chunk
   anymore) — but the pack module can now import
   `src/shared/pr-walkthrough/url-safety.ts` directly instead of hand-duplicating
   it, if that import graph is confirmed clean from `market-packs/pr-walkthrough/lib/`
   (verify at implementation time; not re-verified here).
3. **No data migration**: the preference key (`githubTrustedHosts`), its
   normalization (`normalizeTrustedHosts` in `server.ts`'s PUT handler), and its
   *enforcement* (`src/shared/pr-walkthrough/url-safety.ts`, consumed by
   `src/server/pr-walkthrough/routes.ts` directly against the core
   `preferencesStore` — core code, not a pack module, unaffected by any of this)
   are all untouched. Only the **editing UI** moves.
4. Delete `settings-page.ts:156-202` (state/validator), `:2768-2805` (handlers),
   `:3175-3210` (render fragment) in the same commit that lands the pack module —
   no dead code window, same discipline as the STR-01 route-extraction cohorts
   (`docs/design/route-registry.md`).

### 4.6 Testing strategy

Browser E2E, pattern `tests/e2e/ui/settings-agent-dir.spec.ts` /
AGENTS.md's "every user-facing feature MUST have a browser E2E" rule:

- Navigate to `#/settings/system/general` (`navigateToHash`), assert the
  pr-walkthrough-owned section renders under a `data-testid` scoped by
  `{packId}-{sectionId}` (not a bare `"github-trusted-host-*"` id, so a future
  second pack section can't collide).
- Add a host, assert it persists via `GET /api/preferences` (direct API check,
  `apiFetch` helper) and across a page reload (contribution re-reconcile path,
  same as `reconcilePackPanelsForProject`'s existing reload contract).
- Remove a host, assert removal round-trips the same way.
- Uninstall the pr-walkthrough pack (or, if it's always-installed first-party,
  simulate via the pack-order/activation toggle) and assert the section
  disappears live with **no reload** — mirrors panel reconcile-on-uninstall
  (`pack-panels.ts:227-243`) and should reuse the identical registry-diff
  mechanics, so this is largely a "does the copy-shaped registry behave like its
  template" check, not new design.
- One unit/API test for the defense-in-depth blocklist: a synthetic pack token
  declaring a Claude-Code-gated key is rejected by `/api/preferences` regardless
  of manifest declaration.

### 4.7 Rough size estimate

- Manifest schema + `loadSettingsSections()` in `pack-contributions.ts`
  (mirrors `loadPanels`, small): **~0.5 day**.
- `settings/`-serving route (`GET /api/ext/packs/:packId/settings-sections/:id`,
  mirrors the panel-serving route): **~0.5 day**.
- Client registry `pack-settings-sections.ts` + `renderPackSettingsSections()`
  call sites in `settings-page.ts`: **~1 day** (mostly copy-adapt from
  `pack-panels.ts`, with the tab-lifecycle machinery stripped out).
- `SettingsHostApi` (`preferences.get/set`) + surface-token mint for
  `contributionKind: "settings-section"` + allowlist + defense-in-depth blocklist:
  **~1 day**, security-sensitive — budget extra review time, not extra build time.
- Trusted-hosts migration itself (pack module + delete old code + docs update):
  **~0.5–1 day**.
- Browser e2e + the blocklist unit test: **~1 day**.

**Total: ~4.5–5.5 days**, comparable to Candidate A, but the *marginal* cost of the
next pack-owned settings section drops to "add one YAML + one small render
module" — no new Settings layout work, no session-shaped API to route around.

## 5. Comparison

| | A: global pack panel | B: settings-section kind (recommended) |
|---|---|---|
| Settings layout work | New docked-panel region from scratch | None — additive call in the existing tab switch |
| Pack-author vocabulary | Panel (tabs, instanceMode, session param that's always empty) | Purpose-built `render(host)`, no session concept |
| Host API surface | Full session-bound `HostApi` with session undefined (awkward `undefined`-tolerance contract) | New narrow `SettingsHostApi` — `preferences.{get,set}` only, key-allowlisted |
| Blast radius of the change | `mountPackPanelTab`/`panelTabsBySession`/`resolveOpenPanel` used by every *existing* session-scoped panel caller — regression risk | New, isolated code paths; zero existing call sites touched |
| Marginal cost of the *next* pack settings widget | Same tax again (build a panel, ignore its tab semantics) | One YAML + one small module |
| Consistency with existing contribution-kind pattern (§3 audit consistency check) | Stretches an existing kind past its designed shape | Slots in identically to how `panels/` was added — same loader shape, same `/api/ext/contributions` extension pattern |

## 6. Decision

**Recommend Candidate B** — a new `settings-section` pack contribution kind.

Trusted-hosts is global preference data with no session or tab semantics; forcing
it through the panel/tab-workspace mechanism (Candidate A) would require
nontrivial, regression-risky changes to a mechanism *other* packs already depend
on, purely to make a session-shaped API tolerate "no session," and would leave
every future pack-owned settings widget authored against the wrong abstraction.
Candidate B costs about the same to build once, but it is a genuine, minimal new
contribution kind that mirrors the exact pattern (`panels/<id>.yaml`
auto-discovery → contribution-metadata → lazy client registry) already
established for panels/channels/entrypoints — which is precisely what the audit's
consistency check (task step 3) asked for: it makes the *next* pack-owned
settings section nearly free, not the trusted-hosts move specifically.

The one piece requiring real security attention, not just engineering time, is
§4.3's defense-in-depth blocklist: a pack-attributed preference write must never
be able to reach a Claude-Code-runtime key that core gates behind operator
confirmation, regardless of what the pack's manifest declares. That check should
get its own explicit review pass at implementation time, independent of the rest
of the contribution-kind plumbing (which is otherwise low-risk, additive, and
copy-shaped from a mechanism already in production).

## 7. Resequencing note for EXTENSION-SEAM-AUDIT.md

S5 ("Trusted-GitHub-hosts widget → pr-walkthrough pack panel") is currently
sequenced in the audit as "after upstream-sync." That is insufficient: S5's
target seam does not exist yet. Resequence S5 to:

```
after upstream-sync AND after this design (§4) is approved by the orchestrator:
    S5-design    this document — approve/revise the settings-section contribution kind
    S5-build     land the contribution kind (§4.1–4.4) + migrate trusted-hosts (§4.5) + e2e (§4.6)
```

S5-build should not start before S5-design is explicitly signed off — the Host
API surface in §4.3 is the kind of decision that is expensive to unwind once a
pack (pr-walkthrough) and its e2e coverage depend on its exact shape.
