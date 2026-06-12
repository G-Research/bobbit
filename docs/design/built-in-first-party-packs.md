# Built-in first-party packs

Status: **IMPLEMENTED (merged on `goal/built-in-first-313bf443`).** This document
specifies the architecture, file changes, and test plan that shipped a built-in,
auto-registered source of first-party packs and migrated `pr-walkthrough` into it
(deleting its built-in twin). It builds on the merged #734 schema
(`pack-schema-v1-rationalisation.md`) and the #732 isolation simplification.

The design landed substantially as written below — the synthetic `builtin` source
(`src/server/agent/builtin-packs.ts`, the composition + special-casing in
`server.ts`, the wire flag/guards in `marketplace-source-store.ts`), the
resolve-in-place band, the Market UI section (`src/app/marketplace-page.ts`), the
ship pipeline (`scripts/copy-builtin-packs.mjs` + `build:packs`), the
`pr-walkthrough` migration with its built-in twin deleted and the synthesis
extracted to the shared `src/shared/pr-walkthrough/yaml-to-cards.ts`. The
user-facing summary lives in [docs/marketplace.md](../marketplace.md#built-in-first-party-packs)
and [docs/extension-host-authoring.md](../extension-host-authoring.md#first-party-packs-dogfood-the-host-api);
the executed deletion is reconciled in
[`pr-walkthrough-pack-deletion.md`](./pr-walkthrough-pack-deletion.md).

Related docs:
[`pr-walkthrough-pack-deletion.md`](./pr-walkthrough-pack-deletion.md) (the staged
deletion plan — authoritative on the deletion scope and parity argument),
[`pack-schema-v1-rationalisation.md`](./pack-schema-v1-rationalisation.md),
[`extension-host.md`](./extension-host.md), [`../marketplace.md`](../marketplace.md).

---

## 1. Summary & goals

Add a **built-in, auto-registered source of first-party packs** that ship with
Bobbit and resolve as **active-by-default** market packs, so that:

1. the **core app dogfoods the Extension Host / pack API** — a real shipped
   feature is delivered through the same `PackResolver` + Host API + activation
   system as third-party packs; and
2. users can **disable selected shipped features** from the Market surface, using
   the #734 activation-override toggles.

The dogfood is proven by migrating **`pr-walkthrough`** from a litmus/test market
pack into the first-party built-in source and **deleting its built-in
implementation** so the pack is the sole provider of the viewer/route/store/
deep-link surface. The `submit_pr_walkthrough_yaml` (+ `read_pr_walkthrough_bundle`
/ `readonly_bash`) agent tools and their `WalkthroughAgentManager` stay as agent
tools — only the contribution surfaces move.

This is **pre-release**: no backwards-compatibility burden.

### Non-goals

- No hosted/searchable registry.
- No new Host API capabilities.
- No re-introduction of `permissions` / capability sandbox (#732).
- No migration of more than one feature (artifacts is a follow-up).

### Definition of done (mirrors the goal)

- A built-in source auto-registers (idempotent, non-removable) and ships ≥1
  first-party pack resolved active-by-default via a new resolver band.
- `pr-walkthrough` is delivered solely by the first-party pack; its built-in
  twin surfaces are deleted with no dead references.
- Market UI shows the built-in source/section with enable/disable toggles (no
  uninstall/remove); disabling removes the feature and persists across
  reload/restart; re-enabling restores it.
- #734 orphaned fixtures wired into tests or removed; fixtures README fixed.
- `npm run check`, `npm run build` (incl. `build:packs`), `npm run test:unit`,
  `npm run test:e2e` pass; new unit + E2E coverage as specified in §11.

---

## 2. D1 — Resolution model: resolve-in-place band, NOT copy-install

**Decision (D1): auto-register a non-removable built-in *source* pointing at a
shipped first-party packs directory, and resolve those packs *in place* as a
dedicated band in `buildPackList()`.** They are NOT copied into any scope's
`.bobbit/config/market-packs/`.

"Auto-installed" therefore means **present + active by default**: a built-in pack
is always resolvable; the only opt-out is **disable** via the #734 activation
overrides (default = enabled). Updates ride the app upgrade for free (the shipped
dir is replaced on install/upgrade).

### Rejected alternative — copy-install + opt-out ledger

A copy-install model (on startup, copy each shipped pack into a scope's
`market-packs/<name>/` as a normal install) was rejected because:

- **It fights the user.** Auto-install would re-create a pack the user removed,
  so we would need a persisted "opted-out" ledger to suppress re-creation —
  bespoke state with its own migration/repair concerns.
- **It needs bespoke update-on-upgrade logic.** A copied pack is a frozen
  snapshot with a `.pack-meta.yaml`; upgrading Bobbit would have to detect and
  overwrite stale copies (and not clobber a user edit), versus in-place
  resolution where the dist dir simply changes with the app.
- **It pollutes the user's scope dirs** with files the user did not install and
  cannot meaningfully reorder/uninstall.

In-place resolution makes **disable** the single opt-out path, keeps the user's
`market-packs/` dirs purely user-owned, and keeps the built-in source's contents
authoritative from the shipped dist tree.

---

## 3. Ship / locate pipeline

### 3.1 Repo home

First-party pack **sources** live at repo-root `market-packs/<name>/` — the
existing location. `pr-walkthrough` already lives at
`market-packs/pr-walkthrough/` (`pack.yaml`, `panels/`, `entrypoints/`, `lib/`,
`src/`). `market-packs/artifacts/` also lives there but is **not** a first-party
pack (it stays a test-only litmus installed via fixtures); the ship step uses an
explicit allowlist, not "everything under `market-packs/`".

### 3.2 Ship path + dist layout

Ship the allowlisted packs to **`dist/server/builtin-packs/market-packs/<name>/`**.

The intermediate `market-packs` segment is deliberate: the pack-identity
derivation keys structurally off a `market-packs` path segment (see §6). Shipping
under a path that contains that segment makes `derivePackId`,
`pack-contributions.ts::packIdFromRoot`, and `tool-contributions.ts::isMarketPackBaseDir`
all resolve a correct, stable `packId` with **zero changes to the
security-critical identity code**. (The `builtin-packs` parent disambiguates the
shipped tree from user installs under `<scope>/.bobbit/config/market-packs/`; the
absolute roots never collide.)

Resulting tree after build:

```
dist/server/
  defaults/                      # monolithic builtin pack (unchanged)
  builtin-packs/
    market-packs/
      pr-walkthrough/
        pack.yaml
        panels/pr-walkthrough-panel.yaml
        entrypoints/*.yaml
        lib/routes.mjs           # hand-authored server module (relocated, not bundled)
        lib/panel.js             # esbuild output of src/panel.js (built by build:packs)
```

### 3.3 Build-script changes

- **`scripts/build-market-packs.mjs`** — unchanged in responsibility (it bundles
  CLIENT entries in place under repo `market-packs/`, e.g. `pr-walkthrough/src/panel.js
  → pr-walkthrough/lib/panel.js`). It already runs first in `npm run build`.
- **New `scripts/copy-builtin-packs.mjs`** — mirrors `scripts/copy-defaults.mjs`.
  Copies an explicit allowlist of repo first-party packs into the dist tree:

  ```js
  const FIRST_PARTY_PACKS = ["pr-walkthrough"];     // explicit allowlist
  const SRC = "market-packs";
  const DEST = "dist/server/builtin-packs/market-packs";
  // for each name in FIRST_PARTY_PACKS: copyDir(`${SRC}/${name}`, `${DEST}/${name}`)
  // skip `src/` (source-only) and `node_modules`; copy pack.yaml, panels/,
  // entrypoints/, lib/ (the lib/ bundles must already exist → run AFTER build:packs).
  ```

- **`package.json` `build:server`** — append the new copy step so it runs after
  `copy-defaults.mjs`:

  ```jsonc
  "build:server": "tsc -p tsconfig.server.json && shx chmod +x dist/server/cli.js && shx rm -rf dist/server/defaults && node scripts/copy-defaults.mjs && shx rm -rf dist/server/builtin-packs && node scripts/copy-builtin-packs.mjs",
  ```

  `npm run build` already runs `build:packs` before `build:server`, so the
  `lib/*.js` bundles exist before the copy. (For `pretest:unit`, which lazily runs
  only `build:server`, the committed `lib/*.js` bundles under repo `market-packs/`
  are picked up directly — see §3.5.)

### 3.4 npm package inclusion

`package.json` `files` already ships `dist/`. The new `dist/server/builtin-packs/`
tree is inside `dist/`, so it is included in the tarball automatically once
`prepublishOnly` (`npm run build`) runs. No `files` change needed.

### 3.5 Committed build output

The pack `lib/` bundles under **repo** `market-packs/<name>/lib/*.js` stay
committed (as today), so `build:server`-only flows (CI `pretest:unit`) have the
artefacts to copy. The `dist/` tree itself remains a build artefact (gitignored);
it is reproduced by `npm run build` / `prepublishOnly`.

### 3.6 Runtime resolution

Mirror `builtin-config.ts`'s `__dirname`-relative resolution. Add to a new module
`src/server/agent/builtin-packs.ts`:

```ts
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // dist/server/agent/
/** dist/server/agent/ → ../builtin-packs/market-packs → the first-party pack band root. */
export function resolveBuiltinPacksDir(override?: string): string {
  return override ?? process.env.BOBBIT_BUILTIN_PACKS_DIR
    ?? path.join(__dirname, "..", "builtin-packs", "market-packs");
}
```

The `BOBBIT_BUILTIN_PACKS_DIR` env override (and the `override` param) let tests
point the band at a fixture dir without touching dist. (Tests may also point it at
the **repo** `market-packs/` dir, which already contains the built `lib/`
bundles.)

---

## 4. Built-in source registration

**Decision: a synthetic, reserved source surfaced through the sources API but
NOT persisted to `marketplace-sources.yaml`.**

### 4.1 Source identity

- **Stable id `"builtin"`** (matches `SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]*$/`).
- Synthetic wire shape (never written to disk):
  `{ id: "builtin", url: "builtin:", builtin: true, addedAt: <epoch-0 or build-time> }`.
- Add an optional `builtin?: boolean` flag to the `MarketplaceSource` wire type
  (`src/server/agent/marketplace-source-store.ts`) — **wire/response only**; it is
  never serialized (`serializeSource` ignores it) and `parseSource` rejects/strips
  any disk-authored `builtin` field. The disk file therefore can never duplicate
  or shadow the synthetic source.

### 4.2 Idempotency + non-persistence

The built-in source is **not added to `MarketplaceSourceStore`**. Instead, the
sources REST handler **composes** it into responses at read time:

- `GET /api/marketplace/sources` → `[{ builtin source }, ...sourceStore.list()]`.
  Because it is computed, it is automatically idempotent across restarts and never
  duplicated in `marketplace-sources.yaml` (the store never sees it).
- `MarketplaceSourceStore.add()` rejects `url: "builtin:"` (guard: reject the
  reserved url and the reserved id `"builtin"`), so a user cannot register a
  colliding source.

### 4.3 Non-removability + no-op resync

In the `/api/marketplace/sources/:id` handler (`src/server/server.ts`, the
`sourceMatch` branch):

- `id === "builtin"` must resolve as a known source (so 404 is not returned), but:
  - `DELETE` → **403** `{ error: "the built-in source cannot be removed" }`.
  - `POST .../sync` → **200 no-op** (returns the synthetic source; nothing to
    git-sync — the dir ships with the app). Optionally re-reads the shipped dir.
  - `GET .../packs` → list the shipped first-party packs (browse), each flagged
    `builtin: true`.

The store's `get("builtin")` returns `undefined`, so the handler must special-case
`id === "builtin"` **before** the `sourceStore.get(id)` existence check.

### 4.4 Install / update from the built-in source are rejected (resolve-in-place)

Because the model is resolve-in-place (D1), copy-installing or updating a pack
*from* the built-in source would violate it (it would create a frozen copy under a
scope's `market-packs/`, then shadow-collide with the in-place band). Both
mutating endpoints therefore **reject** a built-in-source target:

- `POST /api/marketplace/install` with `sourceId === "builtin"` → **400/403**
  `{ error: "built-in packs are provided in place and cannot be installed" }`.
- `POST /api/marketplace/update` with `scope: "server"` + a `packName` that is a
  built-in first-party pack **and has no real user install** at that scope →
  **400/403** `{ error: "built-in packs update with the app; nothing to update" }`.
  (A genuine user install of the same name at server scope — see §6.3 — is a real
  installed pack and updates normally; the rejection keys off "no install ledger
  entry for `(scope, packName)`", not off the name alone.)
- `GET /api/marketplace/sources/builtin/packs` browse rows are flagged
  `builtin: true` + `provided: true`; the Market UI renders them as **already
  provided / toggleable** (an enable/disable affordance), never with an **Install**
  button. An API/E2E assertion covers both rejections (§11.2).

---

## 5. Resolver band — exact `buildPackList()` change + ordering

### 5.1 New band builder

Add to `src/server/agent/builtin-packs.ts`:

```ts
import type { PackEntry } from "./pack-types.js";
import { readManifest } from "./pack-manifest.js";

/** Scope the built-in first-party pack entries carry. See §7 for why "server". */
export const BUILTIN_PACK_SCOPE = "server" as const;

/**
 * Resolve every shipped first-party pack as an in-place PackEntry (low→high
 * within the band; readdir order). No `.pack-meta.yaml` required — these are
 * resolved in place, not installed (D1). A synthetic meta marks provenance so
 * the Market UI can flag `builtin: true`.
 */
export function builtinFirstPartyPackEntries(builtinPacksDir: string): PackEntry[] {
  let dirents: fs.Dirent[];
  try { dirents = fs.readdirSync(builtinPacksDir, { withFileTypes: true }); }
  catch { return []; }
  const out: PackEntry[] = [];
  for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const dir = path.join(builtinPacksDir, d.name);
    const manifest = readManifest(dir);
    if (!manifest) continue;
    out.push({
      id: `builtin-pack:${manifest.name}`,
      kind: "market",                 // flows through the same resolver/contribution machinery
      scope: BUILTIN_PACK_SCOPE,      // §7: activation + ordering home
      path: dir,                      // contains a `market-packs` segment → §6 identity works unchanged
      readOnly: true,
      manifest,
      meta: {                         // synthetic provenance (NOT read from disk)
        sourceUrl: "builtin:", sourceRef: "", commit: "",
        packName: manifest.name, version: manifest.version,
        installedAt: "", updatedAt: "", scope: BUILTIN_PACK_SCOPE,
      },
      layout: "defaults-tree",
      skillSource: "project",
    });
  }
  return out;
}
```

The `id` prefix `builtin-pack:` keeps these entries distinguishable from
user-installed `market:server:<name>` entries in conflict reports and logs.

### 5.2 Insertion point in `buildPackList()`

Add `builtinPacksDir?: string` to `BuildPackListOptions`. Insert the band
**immediately after the monolithic builtin defaults entry push (step 1) and
before the server scope band (step 2)** in `src/server/agent/pack-list.ts`:

```ts
  // 1. Builtin pack (defaults-tree, lowest). [unchanged]
  entries.push({ id: "builtin", kind: "builtin", scope: "builtin", path: opts.builtinsDir, ... });

  // 1b. NEW — built-in first-party packs (resolve-in-place band). Above the
  //     monolithic defaults (they beat it by name), below every user scope band
  //     (a user-installed pack of the same name overrides them — §6.3).
  if (opts.builtinPacksDir) pushMarket(builtinFirstPartyPackEntries(opts.builtinPacksDir));

  // 2. Server scope: market packs, then the user pack. [unchanged]
  ...
```

Wire `builtinPacksDir: resolveBuiltinPacksDir()` at every `buildPackList(...)`
call site (the `buildPackList(...)` call in `src/server/skills/slash-skills.ts`
and the config-cascade adapter path). The simplest is to define a shared
`BUILTIN_PACKS_DIR` next to
`BUILTINS_DIR` and pass both.

### 5.3 Ordering table (low → high priority)

| # | Band | `kind` / `scope` | Inserted |
|---|---|---|---|
| 1 | Monolithic builtin defaults | `builtin` / `builtin` | unchanged |
| **1b** | **Built-in first-party packs** | **`market` / `server`** | **NEW (this design)** |
| 2 | Server market packs | `market` / `server` | unchanged |
| 2 | Server user pack | `user` / `server` | unchanged |
| 3 | Global-user market packs + user pack | `market`/`user` / `global-user` | unchanged |
| 4 | Project market packs + user pack | `market`/`user` / `project` | unchanged |
| 5 | Legacy-implicit skill band | `legacy-implicit` | unchanged |

Precedence consequence (higher wins): **builtin-defaults < built-in-first-party <
server-installed < global-user < project**. Everything from step 2 down is
**unchanged** in relative order, so `pack_order` semantics and all existing
precedence invariants hold. The legacy skill band still sits above all market
packs (finding #1 preserved).

---

## 6. Pack identity — derivation, stability, shadow behaviour

### 6.1 Strategy: ship under a `market-packs` segment (no identity-code change)

Because each built-in pack's absolute `path` is
`dist/server/builtin-packs/market-packs/<name>`, it contains a literal
`market-packs` segment. Therefore, **with no change to identity code**:

- `tool-contributions.ts::isMarketPackBaseDir(baseDir)` → `true` (segment present).
- `pack-identity.ts::derivePackId(baseDir)` → `<name>` (segment + next).
- `pack-contributions.ts::packIdFromRoot(packRoot)` → `<name>`.
- `computeRendererKind()` → `"pack"` for `.js` renderers (relevant to a future
  tool-bearing first-party pack; `pr-walkthrough` has no renderers).

`packId` is thus **stable** = the pack directory name = `manifest.name`, identical
for every contribution the pack makes, and never caller-supplied (the security
keystone of #734 §6.6 is preserved verbatim).

### 6.2 Rejected alternative: generalise the derivation

Generalising `derivePackId`/`isMarketPackBaseDir`/`packIdFromRoot` to recognise a
`builtin-packs` root was rejected: these three functions are the **server-derived
identity keystone** that store-namespacing (B1) and route-namespace (B3) bind to.
Touching them risks a security regression and forces three call sites to agree.
Shipping under a `market-packs` segment is a pure build-layout choice with zero
identity-logic risk.

### 6.3 User-pack override / shadow behaviour

If a user installs a pack named `pr-walkthrough` at server (or any user) scope,
both that entry and the built-in entry derive `packId = "pr-walkthrough"`.
Resolution is by list position, and the user entry is inserted **after** the
built-in band (step 2+ > step 1b), so:

- **The user pack wins** every role/tool/skill/contribution merge.
- The conflict detector (`buildConflictsFor`) flags the shadow as
  market-involved (both `kind: "market"`), surfaced via `/api/packs/conflicts`.
- **Surface tokens + activation bind to the WINNER.** The pack-contribution
  registry collapses to the winning pack per `packId` before indexing (the
  pack-contribution registry build in `server.ts` is "deduped-on-path … collapses
  to the winning pack per packId"),
  so only one `pr-walkthrough` contribution set is registered — the user pack's.
  The built-in pack's contributions are shadowed out, exactly like a server pack
  shadowing a global one. No token collision: there is one winner per `packId`.
- **Activation binds to the WINNER's OWN scope** (the existing
  `PackActivationProvider` contract — activation resolves by the winning entry's
  scope). The built-in pack's own activation entry is `(server, packName)`. A
  user override therefore behaves per its scope:
  - **server-scope override** → keyed `(server, packName)`, the SAME entry as the
    built-in. One activation entry governs the feature; the user pack is the
    winner. (This is the only same-name case where built-in + override share an
    activation key.)
  - **global-user / project-scope override** → keyed `(global-user|project,
    packName)` — its OWN normal per-scope activation, entirely separate from the
    built-in's `(server, packName)` entry. The winning row toggles its own scope's
    state; the built-in's server entry is irrelevant while shadowed.
  The unifying rule for the Market UI (§7.4): **the winning row always owns the
  toggle and writes activation to its actual scope; the built-in row's
  server-scoped toggle is suppressed (shadowed) whenever ANY higher-scope provider
  of the same name wins.** See §6.4 for the row model and §7.4 for the UI.

### 6.4 API identity / provenance disambiguation (same-name built-in + user install)

The resolver already collapses to one runtime winner per `packId` (§6.3). The
remaining ambiguity is purely at the **Market/installed API + UI** layer, where a
built-in row and a same-`(scope, packName)` user-installed row could otherwise
collide. Resolved by treating the built-in pack as a **distinct, non-install row
kind** rather than another entry in the install ledger:

- **Row identity key.** Built-in rows are keyed `builtin:<packName>`; real
  installed rows keep `<scope>:<packName>`. The two key spaces never collide, so a
  user-installed server `pr-walkthrough` and the built-in `pr-walkthrough` render
  as **two distinct rows** (the built-in one in the "Built-in" section, the
  installed one in its scope group), each with its own controls. `InstalledPackWire`
  gains `builtin?: boolean` (and the UI list key includes it) so row identity,
  status rendering, and React-style keying are unambiguous.
- **Uninstall.** `DELETE /api/marketplace/installed` operates **only on the
  install ledger** (`installer.listInstalled`). A built-in pack is not in the
  ledger, so: with NO user install of that name, the delete finds nothing → the
  handler returns **403** `{ error: "built-in packs cannot be uninstalled" }`
  (special-cased when `packName` is a built-in pack and no ledger entry matches);
  WITH a user install of the same name at the scope, the delete targets the
  **ledger entry** (the user install) and succeeds normally — it never touches the
  built-in band. So a server-scope override is fully uninstallable; deleting it
  simply re-exposes the built-in pack as the winner again (the intended revert).
  The UI shows an Uninstall button only on `!row.builtin` rows.
- **Update.** Same rule (§4.4): updates the ledger entry when one exists; rejects
  when the name resolves only to the built-in band.
- **Activation is row-specific, keyed by the winning row's OWN scope** (§6.3).
  Each row's toggle reads/writes `(row.scope, packName)`: the built-in row's is
  `(server, packName)`; an installed override row's is `(its-scope, packName)`.
  To avoid a leaky abstraction where toggling a *shadowed* built-in row appears to
  do nothing (its server entry is moot while a higher-scope override wins), the UI
  **suppresses the built-in row's toggle whenever any higher-scope provider of the
  same name wins** (rendered **shadowed**, toggle disabled, copy "Shadowed by an
  installed pack — manage activation on the installed copy"); the **live toggle is
  on the winning row**, writing its own scope's `pack_activation`. With no
  override, the built-in row owns the live `(server, packName)` toggle. So exactly
  one row ever owns a live toggle (the winner), each writes to its own scope's
  state (consistent with `PackActivationProvider`), and surface tokens bind to the
  single registered winner (§6.3). **Scope of same-name testing (this goal):** the
  E2E covers the **server-scope** override (the shared-key case, the highest-risk
  one); project/global-user same-name overrides follow normal per-scope activation
  and are documented here but not separately E2E-covered (they are ordinary
  per-scope packs that happen to share a name — no new mechanism).

---

## 7. Activation + Market UI

### 7.1 Activation scope: `server` (reuse #734 verbatim)

**Decision: built-in-pack activation is stored under the `server`
`PackOrderScope`**, keyed by pack name, reusing the #734 `pack_activation` store
unchanged.

Rationale:

- The built-in source is **server-global**, like marketplace sources (which live
  in the server-scope `marketplace-sources.yaml`). Disabling a shipped feature is
  a server-wide admin decision, not a per-project one.
- `PackActivationMap` is `Partial<Record<PackOrderScope, Record<string,
  DisabledRefs>>>` and the built-in pack **entries carry `scope: "server"`**
  (§5.1), so the existing config-cascade / slash-skills `PackActivationProvider`
  wiring in `server.ts` resolves `getPackActivation("server", packName)` with
  **no new code** and no widening of `PackOrderScope`.
- Avoids a 4th scope value rippling through `pack_order`, normalisation, and
  install-scope validation (you cannot install into a `builtin` scope).

Alternative considered — widen `PackOrderScope` to add `"builtin"` (clean,
collision-free namespace) — rejected for this goal because it touches
`project-config-store.ts` normalisation + the API scope validators for marginal
benefit; the `server` mapping is sufficient and pre-release-cheap. (Recorded here
so a future refactor can revisit.)

Default state: a built-in pack with no `pack_activation` entry is **fully
enabled** (the #734 default — absent kind ⇒ all enabled).

### 7.2 Disabling semantics

Disabling uses the #734 override system directly: `PUT
/api/marketplace/pack-activation { scope: "server", packName, disabled }` writes
`DisabledRefs` (`roles`/`tools`/`skills`/`entrypoints`). For `pr-walkthrough` the
toggleable surface is its **entrypoints** (the four `contents.entrypoints[]`
basenames). Disabling them:

- removes the launchers (composer-slash, git-widget-button, command-palette) and
  the `kind:"route"` deep-link (`routeId: "pr-walkthrough"`) from the
  pack-contribution registry (one toggle per `listName` disables both the launcher
  id AND the derived `routeId`, per `DisabledRefs.entrypoints` semantics);
- **panels + routes stay** as support surfaces for whatever remains enabled (they
  are not user-facing toggle entries) — but with all entrypoints disabled the
  panel is simply unreachable.

Because the built-in `pr-walkthrough` twin is deleted (§8), disabling the
first-party pack makes the feature **genuinely unavailable** — the intended
capability.

### 7.3 Disabled-state degradation (no crash, no dangling surface)

- The `/api/ext/contributions` registry omits disabled entrypoints (existing #734
  behaviour), so the client never registers the launcher or the
  `#/ext/pr-walkthrough` deep-link.
- The generic `ext` route (`routing.ts` `view: "ext"`, `extRouteId`) must render a
  **"feature unavailable" empty state** when an `#/ext/<routeId>` deep-link
  resolves to no registered route (e.g. a bookmarked `#/ext/pr-walkthrough` after
  disable) — never a crash or blank panel. Verify the existing unknown-routeId
  path already does this; if not, add the empty state.
- Surface tokens for a disabled contribution are rejected by the existing
  installed+active check in the surface-token validation path (`server.ts`): a
  stale token cannot drive a disabled pack.

### 7.4 Market UI (`src/app/marketplace-page.ts`)

- **Sources tab**: render the built-in source (`source.builtin === true`) as a
  distinct, labelled "Built-in" section. **No Remove button** for it (gate
  `handleRemoveSource` / the Remove control on `!source.builtin`). Add copy making
  clear these are shipped/core features.
- **Installed tab**: built-in packs appear flagged `builtin: true` with the #734
  enable/disable **toggle**, but **no Uninstall button** (gate `handleUninstall` /
  the Uninstall control on `!pack.builtin`).
- **Shadowed built-in row (same-name override, §6.4).** When a user-installed pack
  of the same name wins resolution, the built-in row is marked **shadowed**: its
  activation toggle is **disabled** with explanatory copy ("Shadowed by an
  installed pack — manage activation on the installed copy"), and the live toggle
  is shown on the winning installed row instead. The Market UI derives "is this row
  the winner?" from `/api/packs/conflicts` (the shadow already surfaced there) so
  exactly one row owns the `(server, packName)` toggle. With no override, the
  built-in row owns the toggle.
- Reuse the existing #734 activation toggle UI + `getPackActivation` /
  `setPackActivation` calls (`src/app/api.ts`).

### 7.5 Server wire changes for the Installed list

`GET /api/marketplace/installed` currently returns
`installer.listInstalled(allContexts(projectId))`. Extend the
`GET /api/marketplace/installed` handler (`server.ts`) to **prepend** built-in
pack rows:

```ts
const builtin = builtinFirstPartyPackEntries(resolveBuiltinPacksDir()).map((e) => ({
  scope: "server", packName: e.manifest!.name, version: e.manifest!.version,
  status: "ok", builtin: true, /* + the fields InstalledPackWire expects */
}));
json({ installed: [...builtin, ...installer.listInstalled(allContexts(projectId))] });
```

Add `builtin?: boolean` to the `InstalledPackWire` type (`src/app/api.ts`); the
client list key includes it (§6.4) so a built-in row and a same-name user-install
row are distinct. The `DELETE /api/marketplace/installed` handler (`server.ts`)
operates on the install ledger only: it **rejects** (`403`) when `packName` is a
built-in pack with **no** matching ledger entry, and otherwise uninstalls the real
ledger entry (a server-scope user override of the same name is fully uninstallable
— §6.4).

---

## 8. `pr-walkthrough` migration + built-in deletion

### 8.1 Migration

`pr-walkthrough` already exists as a complete pack at
`market-packs/pr-walkthrough/` (pack.yaml: no tools, one panel, pack-level
`routes: { module: lib/routes.mjs, names: [bundle, publish] }`, four entrypoints).
Migration = **add `"pr-walkthrough"` to the `FIRST_PARTY_PACKS` allowlist** in
`scripts/copy-builtin-packs.mjs` (§3.3). No manual install: the §5 band resolves it
active-by-default. The mandatory E2E (§11) drives it with **no install step**.

### 8.2 Parity argument (must be confirmed green before deletion)

Per [`pr-walkthrough-pack-deletion.md`](./pr-walkthrough-pack-deletion.md), the
pack re-expresses the viewer/route/store/deep-link surface using only public
contributions + the durable Host API:

| Surface | Built-in origin (deleted) | Pack re-expression (sole provider) |
|---|---|---|
| Viewer panel | `src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts` | `panels/pr-walkthrough-panel.yaml` → `lib/panel.js` |
| Changeset/diff bundle | `src/server/pr-walkthrough/routes.ts` viewer-feed routes | `routes: bundle` (`lib/routes.mjs`, LIVE git in the confined worker) |
| Persisted VIEWER cards | bespoke viewer feed reading `walkthrough-store.ts` | `routes: publish` → `host.store.*` (pack-namespaced), written by the panel's read→publish seam (§8.4). The agent-side `walkthrough-store.ts` stays as the submit pipeline's own store (§8.3/§8.5), never read by the viewer. |
| Launcher + deep-link | composer/git-widget launch + the `"walkthrough"` RouteView | `entrypoints:` (3 launchers + `kind:"route"` `routeId:"pr-walkthrough"`) → `#/ext/pr-walkthrough` |
| Submitted YAML read | bespoke transcript access | `host.session.readToolCall(submit_pr_walkthrough_yaml)` |

**Deletion is gated on the mandatory E2E (`tests/e2e/ui/pr-walkthrough-pack.spec.ts`)
passing while served ENTIRELY by the built-in pack** (no manual install). Do not
delete until that is green in CI.

### 8.3 Files to delete (cross-referenced with the deletion plan)

**Client UI**

- `src/ui/components/pr-walkthrough/` — entire dir (`PrWalkthroughPanel.ts`,
  `types.ts`, `fixtures.ts`, `index.ts`).
- `src/app/pr-walkthrough.ts` and `src/app/pr-walkthrough-lazy.ts`.
- `src/app/render.ts` — remove all walkthrough wiring: the imports from
  `pr-walkthrough.js` / `pr-walkthrough-lazy.js` / `types.js`, the
  `open-pr-walkthrough` listener, `handlePrWalkthroughJobUpdated` +
  `connectPrWalkthroughViewerEvents` + the `pr_walkthrough_job_updated` WS,
  `walkthroughPanelContent` / `walkthroughControlButtons` /
  `walkthroughChangesetFromTab` / `walkthroughTabButtonLabel` and the
  `standaloneUrl` `/walkthrough?...` builder, plus the `workspaceSessionId()`
  `route.view === "walkthrough"` branch.
- `src/app/panel-workspace.ts` — the `kind: "walkthrough"` tab handling.
- `src/app/routing.ts` — the `"walkthrough"` member of the `RouteView` union, the
  `walkthroughSessionId` / `walkthroughTabId` fields, and the `#/walkthrough`
  (and `/walkthrough` pathname) cases in `getRouteFromHash` + `setHashRoute`. The
  generic `ext` route replaces them.

**Server (viewer-feed routes only — agent toolchain stays)**

- `src/server/pr-walkthrough/routes.ts` — **split, not wholesale delete**. Remove
  ONLY the **viewer-feed** routes the deleted client consumed: `GET
  /api/pr-walkthrough/jobs/:id`, `GET /api/pr-walkthrough/session/:id`, `GET
  /api/pr-walkthrough/:id`. **Keep** every route the agent toolchain still uses:
  `POST /launch`, `POST /resolve`, `POST …/export/preview`, `POST …/export/submit`
  (network + GitHub auth), AND the internal `POST /api/internal/pr-walkthrough/bundle`
  / `/analysis-bundle` / `/submit-yaml` routes — these are consumed by the KEPT
  agent tools (`read_pr_walkthrough_bundle`, `submit_pr_walkthrough_yaml`; see
  `defaults/tools/pr-walkthrough/extension.ts`), NOT by the viewer. Adjust the
  `server.ts` `handlePrWalkthroughApiRoute(...)` dispatch accordingly (keep the
  import + call; narrow only the public viewer-feed matcher).
- **`walkthrough-store.ts` + `git-changeset.ts` + `diff-parser.ts` are KEPT — they
  are load-bearing for the agent toolchain (carve-out §8.5), NOT viewer surfaces.**
  `walkthrough-agent-manager.ts` imports `resolveLocalChangeset` (git-changeset) +
  `saveWalkthrough` (walkthrough-store); `walkthrough-agent-store.ts`,
  `walkthrough-analysis-bundle.ts`, `walkthrough-yaml-schema.ts` import
  `storageKeyForChangesetId` (walkthrough-store); `git-changeset` imports
  `diff-parser`. Deleting them would break `read_pr_walkthrough_bundle` / the
  submit pipeline / `resolve`. The pack re-expresses the changeset/diff logic
  **independently** in its own `lib/routes.mjs` (ambient `child_process`/`fs` in
  the confined worker) for the VIEWER path; the agent-side modules remain the
  agent path. (This corrects an earlier over-broad deletion claim: the goal
  migrates the **viewer/contribution/deep-link** surface only — §8.5 carve-out.)
  **Confirm the E2E green first** (see §8.4 for
  the persistence seam).

**Tool defs** — `defaults/tools/pr-walkthrough/` is **kept** (the agent-driving
tools `submit_pr_walkthrough_yaml` / `read_pr_walkthrough_bundle` / `readonly_bash`
stay — §8.5).

### 8.4 Persistence — the pack's `host.store` is the sole VIEWER-state provider

The migrated feature's **viewer state** (the changeset → LLM-enhanced cards the
*panel* reads) is owned **solely by the pack**, through the pack-scoped
`host.store` written by the pack's `publish` route and read by its `bundle` route.
No viewer surface reads a built-in store. (The agent-side `walkthrough-store.ts`
is NOT a viewer surface — it is the submit pipeline's own persistence, retained as
the §8.5 carve-out and never read by the panel; see §8.3.)

- **Delete the VIEWER-FEED routes only** (`GET /api/pr-walkthrough/jobs/:id`,
  `/session/:id`, `/:id`) — the bytes the deleted client consumed. The pack's
  `lib/routes.mjs` (`bundle` LIVE git recompute + `publish` persist to
  `host.store`) is the sole provider of the viewer surface (§8.2 parity table).
  `walkthrough-store.ts` + the internal `bundle`/`analysis-bundle`/`submit-yaml`
  routes STAY (agent toolchain, §8.3).
- **Persistence seam = CLIENT-side `host.callRoute` from the panel (no server-side
  bridge).** This respects the Host API boundary: there is **no** server-side
  `ctx.host.callRoute`, and `host.callRoute` is a **client-side, caller-pack-scoped**
  surface (`docs/extension-host-authoring.md`). So the persistence flow is exactly
  the litmus pack's existing model (and the deletion plan's): the agent tool
  `submit_pr_walkthrough_yaml` **stays completely unchanged** — it just emits its
  YAML as a normal tool call. The pack **panel** (`lib/panel.js`, running on the UI
  thread with a pack-bound surface token) then:
  1. reads the submitted YAML via `host.session.readToolCall(submit_pr_walkthrough_yaml)`;
  2. recomputes the structural changeset via `host.callRoute("bundle")` (LIVE git
     in the confined worker);
  3. persists the LLM-enhanced cards via `host.callRoute("publish")`, which writes
     to the **pack-scoped `host.store`** (the `publish` route runs in the confined
     worker under the pack identity derived from the panel's surface token).
  Persistence therefore happens **at view time, client-driven**, through the
  caller-pack-scoped Host API — no agent-tool route call, no new dispatcher API, no
  hidden built-in persistence path. `bundle` reads stored cards when present, else
  returns the deterministic in-worker structural fallback. This is what proves a
  first-party pack owns durable feature state through the Host API.
- **REAL LLM-card parity — production-schema synthesis migration (the key work; user-chosen: full faithful migration).** The litmus pack reads a SIMPLIFIED `{ cards }` YAML and uses a hard-coded `job-litmus-1`; that is NOT production parity. The unchanged `submit_pr_walkthrough_yaml` tool emits the RICH production schema (`pr` + `walkthrough.{context,merge_assessment,design_decisions,review_chunks,omissions_and_followups,audit,display}` — NO top-level `cards`), which the built-in mapped to `PrWalkthroughCard[]` via `validatePrWalkthroughYaml` + `mapYamlToWalkthroughPayload` + `DiffReferenceMapper` (`src/server/pr-walkthrough/walkthrough-yaml-schema.ts`). The pack must run that SAME synthesis. Plan:
    1. **Extract the synthesis to a PURE shared module** `src/shared/pr-walkthrough/yaml-to-cards.ts` (move `validatePrWalkthroughYaml`, `mapYamlToWalkthroughPayload`, `DiffReferenceMapper`, `flattenDiffBlocks` + helpers). It already imports ONLY from `src/shared/pr-walkthrough/{ids,nav-label,types}.js` (no `node:`/server deps — verified), so the move is clean. Re-export from `walkthrough-yaml-schema.ts` so the AGENT side (`walkthrough-agent-manager.ts`, `tests/pr-walkthrough-yaml-schema.test.ts`) keeps working with NO behavior change (`WalkthroughStorePayload` stays server-side; the shared fn returns the structural `{ changeset, cards, warnings }`).
    2. **Bundle the shared synthesis into the pack** via a new `build:packs` entry → `market-packs/pr-walkthrough/lib/yaml-to-cards.mjs` (esbuild, self-contained, committed). NO duplication — one source of truth in `src/shared/`, bundled into the pack served tree.
    3. **Pack `publish` route maps the REAL schema.** The panel passes the RAW submitted YAML text to `host.callRoute("publish", { yaml, jobId })`; the route (confined worker) validates + maps it against the LIVE-computed parsed diff (the same `git` recompute `bundle` does) via the bundled synthesis, and stores `PrWalkthroughCard[]` keyed by the REAL changeset id. `bundle` serves stored cards over the structural fallback (the parity proof).
    4. **Panel derives the REAL job/changeset from the session**, not `job-litmus-1`: read the `submit_pr_walkthrough_yaml` tool call (`host.session.readToolCall`), compute the changeset id from the submitted doc's `pr` (`changesetIdForGithub`), thread it as the jobId; per-changeset store keys (fixes the shared-literal `job/${jobId}` collision).
    5. **Launch = drive the CURRENT session's agent via `host.session.postMessage` (pack-expressible).** The built-in git-widget button launched a NEW dedicated child walkthrough agent (`POST /api/pr-walkthrough/launch` → `WalkthroughAgentManager`, a fresh child session) — that specific privilege-minting (spawning a new principal) is the ONLY non-pack-expressible bit, and is NOT needed. Re-express it: the git-widget/composer/palette entrypoints drop the hard-coded `jobId` and navigate to `#/ext/pr-walkthrough`; the panel resolves the job from the current session. When no walkthrough has been submitted for the session yet, the panel shows a **"Run PR walkthrough"** action that, on the user's click (gesture-gated), calls `host.session.postMessage` to direct the CURRENT agent to perform the walkthrough using the kept agent tools (`readonly_bash` / `read_pr_walkthrough_bundle` / `submit_pr_walkthrough_yaml`), optionally threading current branch/PR context. The agent submits the production YAML; the panel then reads that tool call (step 4) → `publish` → renders the synthesized cards. `host.session.postMessage` is a supported Host-API surface (one-time content-bound write permit + `allowedTools` gate + audit, §12); launchers only open the panel (they navigate; the PANEL posts). So the "click → walkthrough happens" UX is preserved, driven by the current session's agent rather than a spawned child.

    > **SUPERSEDED (twice).** (1) The claim that spawning a new principal is "the ONLY non-pack-expressible bit" no longer holds: child-agent launch is pack-expressible via the shipped ambient `host.agents` capability, and the PR-walkthrough pack **has shipped** onto `host.agents` (a real read-only child reviewer, not the `host.session.postMessage` gesture described in step 5 above). (2) The launch model itself has since changed: clicking any launcher now **spawns the reviewer child and auto-switches the view to it** (spawn-on-click) — there is **no owner-session panel**, **no "Run PR walkthrough" / "Load walkthrough" button**, and **no `host.session.postMessage`** in this feature. So the entire step-5 `postMessage` launch flow and the launch-flow state machine below (`no-submission` → `posting` → `waiting`, the Run button, the postMessage gating) are **historical and no longer reflect the shipped system**. See [docs/design/pr-walkthrough-launch-ux.md](pr-walkthrough-launch-ux.md) for the authoritative launch + lifecycle model, plus [docs/orchestration.md](../orchestration.md) and [docs/marketplace.md](../marketplace.md).

    **Panel launch-flow state machine + failure contract** (so the implementation is resilient, not just the happy path):
    - `no-submission` (idle) — no `submit_pr_walkthrough_yaml` tool call in the session yet → render the **"Run PR walkthrough"** button (+ structural `bundle` fallback if the user just wants the diff). No auto-post on mount (gesture rule).
    - `posting` — user clicked Run: mint the write permit + `postMessage`; disable the button and show "Asking the agent…". **Duplicate clicks** are ignored while in `posting`/`waiting` (guard a single in-flight request id).
    - `waiting` — posted; poll/observe the session transcript for a NEW `submit_pr_walkthrough_yaml` tool call (newer than the post). A **timeout** (e.g. a few minutes, no submission) → `error` with a "the agent didn't produce a walkthrough — try again" state + re-enabled Run button. Agent **refusal / non-response** surfaces the same way (no new tool call).
    - `publishing` — a new submit tool call appeared: read its YAML → `host.callRoute("publish", { yaml, jobId })` → on success transition to `rendered`; on `publish`/validation error → `error` (show the validation message; Run remains available to retry).
    - `rendered` — `bundle` serves the stored synthesized cards.
    - **No active session / pack-served context missing** (`host.session` unavailable) → the Run action is hidden and the panel shows the structural `bundle` fallback only (postMessage requires a session surface). **Missing required tool** (the session's agent lacks `submit_pr_walkthrough_yaml` in `allowedTools`) → the server rejects the post (allowedTools gate) → surface a clear "this session can't run a walkthrough" error rather than a silent no-op.
    6. **E2E uses the REAL production schema** (not the `{ cards }` test shape): the injected `submit_pr_walkthrough_yaml` tool call carries a valid production `pr`+`walkthrough` document, and the test asserts the synthesized cards (orientation/design/review/audit) render.
  Persistence stays view-time, client-driven, caller-pack-scoped (no server-side `callRoute`); `persistedAt` stamped once → stable across reloads.
- **What stays agent-side (unchanged carve-out, §8.5):** model-backed card
  synthesis itself, GitHub PR resolution, and `/export/*` (network + GitHub auth).
  Those are *producer/credential* concerns, not viewer state. The submit tool's
  responsibility ends at emitting the YAML tool call; it never reads or writes the
  viewer store.

**Exact target state (resolves the keep-vs-delete ambiguity — ONE answer).**
- **DELETE:** the client viewer (§8.3 client list) + the **viewer-feed routes**
  `GET /api/pr-walkthrough/jobs/:id`, `/session/:id`, `/:id`, and the client
  launch wiring (`open-pr-walkthrough` → `launchPrWalkthroughAgent`, the git-widget
  button). These are the built-in feature/viewer SURFACES the pack now provides.
- **KEEP (unchanged):** `walkthrough-store.ts`, `git-changeset.ts`,
  `diff-parser.ts`, `WalkthroughAgentManager`, and its `submitYaml` / `readBundle`
  routes + `/launch` + `/resolve` + `/export/*` — the agent-side toolchain
  (§8.5). The pack's viewer state lives in its OWN pack `host.store` (§8.4); the
  agent-side `walkthrough-store.ts` is a SEPARATE store the panel never reads. We
  do NOT delete or split `walkthrough-store.ts`.

**Gating.** Deleting the client viewer + viewer-feed routes is gated on the
mandatory E2E (`tests/e2e/ui/pr-walkthrough-pack.spec.ts`) being green while the
feature is served entirely by the pack — including the publish→reload→re-read cards
path that proves the PACK store is the durable viewer provider. Confirm that E2E
green **before** removing the viewer-feed routes.

### 8.5 Agent-tool carve-out

`defaults/tools/pr-walkthrough/` (the `submit_pr_walkthrough_yaml`,
`read_pr_walkthrough_bundle`, `readonly_bash` tools), `WalkthroughAgentManager`,
`github-adapter.ts`, `card-synthesis.ts`, `export-mapper.ts`,
`walkthrough-agent-manager.ts`, `walkthrough-agent-store.ts`,
`walkthrough-analysis-bundle.ts`, `walkthrough-yaml-schema.ts`,
`walkthrough-readonly-policy.ts` **all stay** — they are genuine agent capabilities
(model-backed synthesis + GitHub network/auth), not contribution surfaces. Only the
viewer/route/store/deep-link surfaces move to the pack.

**The YAML→cards synthesis is the one thing that MOVES OUT of the agent-only side**
(§8.4): it is extracted to a PURE `src/shared/pr-walkthrough/yaml-to-cards.ts`,
imported by the agent side AND bundled into the pack — one source of truth, used by
both. The `submit_pr_walkthrough_yaml` tool itself is UNCHANGED.

**Launch re-expression (§8.4 step 5) — what is deleted vs retained, unambiguously:**
- **DELETED (built-in UI feature surface):** the git-widget "PR Walkthrough" button
  + the client `open-pr-walkthrough` → `launchPrWalkthroughAgent` →
  `POST /api/pr-walkthrough/launch` wiring. This was the only UI caller of `/launch`.
- **RETAINED (agent-side walkthrough lifecycle, the §8.5 carve-out — NOT a built-in
  UI feature surface):** `WalkthroughAgentManager` and its routes
  `submitYaml` (`/api/internal/.../submit-yaml`) + `readBundle`
  (`/api/internal/.../bundle`,`/analysis-bundle`) + `/launch` + `/resolve` +
  `/export/*`. Justification (not "for any path that still needs them"):
  `WalkthroughAgentManager` is **load-bearing for the kept agent tools** —
  `read_pr_walkthrough_bundle` calls `readBundle` and `submit_pr_walkthrough_yaml`
  calls `submitYaml` (verified: `routes.ts` is the only caller of every manager
  method). `/launch` is part of the SAME manager and the SAME agent capability
  family (launch an isolated read-only child agent that runs the walkthrough tools
  + submits YAML) — a genuine *agent* capability, exactly the class the goal's §8.5
  keeps agent-side, distinct from the deleted UI entry. It mints a new principal,
  which is why it CANNOT be a pack surface; the pack instead drives the CURRENT
  agent via `host.session.postMessage` (an additional, pack-expressible launch
  gesture). "Sole provider" therefore holds for the migrated **viewer +
  contribution + user-facing launch-gesture** surface; the agent lifecycle is the
  explicit carve-out, kept agent-side just like synthesis / GitHub export.

---

## 9. Caches / lifecycle

- **No new cache.** The built-in band is rebuilt on every `buildPackList(...)`
  call (a cheap `readdirSync` + `readManifest`), so enable/disable takes effect on
  the next resolution.
- **Enable/disable** goes through `PUT /api/marketplace/pack-activation`, which
  already calls `invalidateResolverCaches()` (the activation-toggle handler in
  `server.ts`). That single
  synchronous call busts the slash-skill cache, the tool-scan cache, and the
  dispatcher / route-dispatcher / route-registry / pack-contribution-registry
  (`invalidateResolverCaches()` in `server.ts`), so the launcher/deep-link/tool
  appear or disappear with **no
  restart/reload**.
- **Reload-safety**: the synthetic source is computed per request (§4.2); the band
  is computed per resolution. There is no persisted state to drift across reload or
  restart. Activation overrides persist in `pack_activation` (server config) and
  survive restart.
- **Project scoping**: built-in pack entries carry `scope: "server"` and are
  server-global; they appear in every project's resolution. Activation is
  server-scoped (§7.1), so a disable applies across projects — the intended
  server-wide behaviour for a shipped feature.

---

## 10. Item 0 — #734 fixture cleanup

Findings from `tests/fixtures/market-sources/`:

- Only `retry-demo-src` is used (by `tests/e2e/ui/extension-host.spec.ts` and
  `artifacts-pack.spec.ts`).
- `conflict-dup-route-name-src`, `conflict-dup-panel-id-src`,
  `conflict-dup-entrypoint-id-src`, `conflict-dup-routeid-src`, `no-tools-pack-src`,
  `panel-only-src` are **orphaned** (no test installs them).
- The within-pack hard conflicts (dup route name / panel id / entrypoint id) are
  already unit-tested at the loader level in `tests/pack-contributions.test.ts`
  via inline temp dirs.
- The README references a **nonexistent** dir `tests/fixtures/pack-schema-v1/**`.

**Plan:**

1. **Wire the install-level fixtures into a new E2E**
   `tests/e2e/ui/marketplace-conflicts.spec.ts` (or an API E2E under
   `tests/e2e/`), asserting behaviour the loader-unit tests cannot:
   - `conflict-dup-routeid-src` (two packs claiming the same host-global
     `routeId`) — **install both, register neither** (cross-pack registry
     conflict, which the within-pack loader unit tests do NOT cover).
   - `no-tools-pack-src` — an ORPHAN/UI-only pack installs and its panel +
     entrypoints + pack-level route register (pack-bound surface auth, no tool in
     `allowedTools`).
   - `panel-only-src` — a single auto-discovered panel, all-empty `contents`,
     installs + registers.
2. **Keep `conflict-dup-route-name-src` / `conflict-dup-panel-id-src` /
   `conflict-dup-entrypoint-id-src`** ONLY if the new E2E also asserts the
   install-time surfacing of those conflicts (install succeeds, registration drops
   the pack with a loud error). If the E2E does not add value beyond the existing
   loader unit tests, **delete those three orphaned fixtures** (the unit tests
   already pin the behaviour). Recommended: keep them and assert install-level
   drop, since install + registry surfacing is a distinct layer.
3. **Fix `tests/fixtures/market-sources/README.md`**: correct the broken
   `tests/fixtures/pack-schema-v1/**` reference to the actual location of the
   loader fixtures (the inline temp dirs in `tests/pack-contributions.test.ts`), or
   drop the stale sentence.

---

## 11. Test plan

### 11.1 Unit (`tests/*.test.ts`, node:test)

- **`tests/builtin-packs.test.ts`** (new):
  - `resolveBuiltinPacksDir()` resolves relative to `__dirname` and honours the
    `override` / `BOBBIT_BUILTIN_PACKS_DIR` override.
  - `builtinFirstPartyPackEntries(dir)` returns one entry per shipped pack, with
    stable `id = "builtin-pack:<name>"`, `scope: "server"`, `path` containing a
    `market-packs` segment, synthetic meta, `manifest` populated.
  - **packId stable**: `packIdFromRoot(entry.path) === manifest.name` and
    `isMarketPackBaseDir(entry.path) === true` (point at a fixture dir).
  - **Idempotent across restart**: two independent `buildPackList(...)` calls (or
    two source-list compositions) produce identical band entries.
  - **Precedence**: in a `buildPackList(...)` result, the built-in band sits after
    the `builtin` defaults entry and before the server band; a user-installed
    server pack of the same name appears later (wins).
  - **Activation filtering**: with `pack_activation.server.<name>.entrypoints`
    listing the four basenames, the resolved/registered entrypoints for that pack
    are empty.
- **`tests/marketplace-source-builtin.test.ts`** (new):
  - The composed `GET /api/marketplace/sources` shape includes the synthetic
    `{ id: "builtin", builtin: true }` source and `MarketplaceSourceStore` does NOT
    contain it (not persisted to `marketplace-sources.yaml`; idempotent after a
    re-instantiated store = simulated restart).
  - `MarketplaceSourceStore.add({ url: "builtin:" })` / id `"builtin"` is rejected.
  - `parseSource` / a re-instantiated store rejects a disk-authored row with `id: "builtin"` or `url: "builtin:"`.
  - **Disabled-state survives RESTART (DoD: "reload/restart")**: write `pack_activation.server.<name>.entrypoints` via the store, **re-instantiate the server config store from disk** (simulated gateway restart), and assert the disabled refs persist and the contribution registry still filters them — covering the restart half of the DoD that the browser reload E2E does not (the E2E only proves client-reload persistence).
- **`tests/pr-walkthrough-yaml-schema.test.ts`** (existing, keep green after the extraction): the agent-side `validatePrWalkthroughYaml` + `mapYamlToWalkthroughPayload` re-exports behave identically post-move to `src/shared/pr-walkthrough/yaml-to-cards.ts` (the extraction is behavior-preserving). Optionally add a focused test that the shared module is import-clean (no `node:`/server deps) so the pack bundle stays loadable.

### 11.2 Browser E2E (`tests/e2e/ui/*.spec.ts`)

- **`tests/e2e/ui/pr-walkthrough-pack.spec.ts`** (the deletion plan's mandated
  E2E, updated):
  - The walkthrough works **end-to-end served entirely by the first-party pack**,
    with **NO manual install step** (it is resolved by the §5 band): git-widget
    launcher → panel → `bundle` recomputes the REAL changeset LIVE → diff renders →
    `publish` persists cards → reload re-reads the same persisted cards. The
    injected `submit_pr_walkthrough_yaml` tool call carries the **REAL production
    schema** (`pr` + `walkthrough.{design_decisions,review_chunks,audit,display,…}`,
    NOT a `{ cards }` shortcut), and the test asserts the **synthesized** cards
    (orientation / design / review / audit) render — proving the pack runs the same
    YAML→cards synthesis as the deleted built-in (§8.4). A panel **"Run PR
    walkthrough"** action (`host.session.postMessage` to the current agent) is also
    exercised for the launch-re-expression (§8.4 step 5).
  - **Disable** from the Market built-in section removes the launcher + the
    `#/ext/pr-walkthrough` deep-link + the contribution; the feature is
    unavailable and the deep-link shows the empty state (no crash).
  - **Re-enable** restores it; the state **survives reload**.
  - The built-in **source cannot be removed** (no Remove control; `DELETE` → 403)
    and built-in **packs cannot be uninstalled** (no Uninstall control; `DELETE
    /installed` → 403).
  - **Install/update from the built-in source are rejected** (§4.4): `POST
    /api/marketplace/install { sourceId: "builtin", ... }` → 400/403, and `POST
    /api/marketplace/update { scope: "server", packName: "pr-walkthrough" }` (no
    user install) → 400/403. The built-in browse rows render as provided/toggleable,
    never with an Install button.
  - **Same-name override (§6.4, §7.4):** installing a user pack named
    `pr-walkthrough` at server scope yields TWO distinct Market rows (built-in +
    installed); the installed row is uninstallable and owns the live activation
    toggle, while the built-in row is non-uninstallable and its toggle is disabled
    ("shadowed"); after uninstalling the override the built-in pack is the winner
    again and re-owns the toggle.
- **`tests/e2e/ui/marketplace-conflicts.spec.ts`** (new, item 0): the conflict /
  no-tools / panel-only fixture assertions from §10.

### 11.3 Phase invariant

All new tests land in exactly one of unit / e2e (pinned by
`tests/test-phase-invariant.test.ts`). The new browser specs go under
`tests/e2e/ui/`.

---

## 12. Invariants preserved (#734 + #732)

- **Precedence / `pack_order`** — unchanged from step 2 down; the new band only
  inserts between builtin-defaults and the server band (§5.3).
- **Server-derived pack identity** — derived structurally from the
  `market-packs/<name>` path segment, never caller-supplied (§6). Identity code
  untouched.
- **Action guard** (`allowedTools` + `toolUseId`) and **surface tokens
  re-validated per call** — unchanged; disabled contributions fail the
  installed+active check (§7.3).
- **Pack-scoped namespaces** (store + route) — the built-in pack uses the same
  `host.store` / route namespace keyed off `packId` as any market pack.
- **Worker confinement (#732)** — the pack `routes.mjs` runs in the confined
  worker with ambient `child_process`/`fs` (trusted tool/MCP tier), no
  `permissions` opt-in re-introduced.
- **Store/session scoping** — unchanged; the built-in pack is server-global with
  server-scoped activation, consistent with the server-global source model.
- **Built-in source is non-removable; built-in packs are not copy-installed /
  uninstalled** — only enabled/disabled (§4.3, §7).
- **User-source model unchanged** — git/local-dir sources behave exactly as today.

---

## 13. Implementation task breakdown (parallelizable partition)

Partitioned by module to minimise cross-touch conflicts. Tasks A–D can proceed in
parallel after Task A's type/signature additions land; E–F depend on A–C; G is
independent.

- **Task A — band + resolution core** (`src/server/agent/builtin-packs.ts` new;
  `pack-list.ts` `BuildPackListOptions` + insertion; `pack-types.ts`/manifest as
  needed): `resolveBuiltinPacksDir`, `builtinFirstPartyPackEntries`,
  `BUILTIN_PACK_SCOPE`, the step-1b insertion, and wiring `builtinPacksDir` at both
  `buildPackList(...)` call sites. **Unit: `tests/builtin-packs.test.ts`.**
- **Task B — ship pipeline** (`scripts/copy-builtin-packs.mjs` new;
  `package.json` `build:server`): the allowlist copy step + dist layout. Verify
  `npm run build` produces `dist/server/builtin-packs/market-packs/pr-walkthrough/`.
- **Task C — source registration + sources/installed API**
  (`marketplace-source-store.ts` `builtin?` wire flag + reserved-id/url guards;
  `server.ts` sources composition, `:id` DELETE/sync/packs special-casing,
  installed-list prepend, install/uninstall rejection; `src/app/api.ts`
  `InstalledPackWire.builtin` + `MarketplaceSource.builtin`). **Unit:
  `tests/marketplace-source-builtin.test.ts`.**
- **Task D — Market UI** (`src/app/marketplace-page.ts`): built-in source section
  (no Remove), built-in pack rows (toggle, no Uninstall), reuse #734 activation.
- **Task E — pr-walkthrough migration** (allowlist add): confirm the band resolves
  it active-by-default; the mandatory E2E runs with no install.
- **Task F — built-in twin deletion** (§8.3 file list; routes.ts split per §8.4):
  gated on Task E's E2E green. Includes `routing.ts` / `render.ts` /
  `panel-workspace.ts` cleanup and the `ext`-route empty-state check (§7.3).
- **Task F-syn — production-faithful synthesis migration (§8.4, the user-chosen
  full migration; the parity keystone).** (1) Extract `validatePrWalkthroughYaml` +
  `mapYamlToWalkthroughPayload` + `DiffReferenceMapper` + `flattenDiffBlocks` +
  helpers from `src/server/pr-walkthrough/walkthrough-yaml-schema.ts` into a PURE
  `src/shared/pr-walkthrough/yaml-to-cards.ts`; re-export so the agent side +
  `tests/pr-walkthrough-yaml-schema.test.ts` stay green unchanged. (2) New
  `build:packs` entry bundling it → `market-packs/pr-walkthrough/lib/yaml-to-cards.mjs`
  (committed). (3) Pack `lib/routes.mjs` `publish` validates+maps the RAW production
  YAML against the live diff via the bundled synthesis; per-real-changeset store
  keys. (4) `src/panel.js`: pass raw YAML to `publish`, derive the real jobId from
  the submit tool call, add the **"Run PR walkthrough"** `host.session.postMessage`
  action (§8.4 step 5). (5) Drop hard-coded `jobId` from the `entrypoints/*.yaml`.
  (6) Update `tests/e2e/ui/pr-walkthrough-pack.spec.ts` to the production schema +
  synthesized-card assertions. Depends on the pack existing (Task E) and pairs with
  Task F (do together — both touch the pack + the deletion).
- **Task G — item 0 fixture cleanup** (`tests/fixtures/market-sources/README.md`
  + `tests/e2e/ui/marketplace-conflicts.spec.ts`): independent of A–F.
- **Task H — docs**: update `docs/marketplace.md` (built-in source + disabling
  shipped features) and `docs/extension-host-authoring.md` (first-party packs
  dogfood the API); reconcile this doc with
  `docs/design/pr-walkthrough-pack-deletion.md`.
