# Rationalise Pack Schema V1

**Status:** design locked · **Scope:** pre-release fix to pack schema V1 · **No backwards compatibility.**

This document is the implementation contract for the "Rationalise pack schema V1" goal. It is precise
enough that three coders — **(A) server core**, **(B) client + UI**, **(C) packs + build** — can work
concurrently. The integration seam between the three lanes is the **wire contract** in §6 plus the
**TypeScript interfaces** scattered through §1, §4, §5. Treat those as frozen; everything else is
implementation latitude.

The goal: move pack contribution declarations to where their runtime scope already is.

- **Tool-scoped** (`renderer`, `actions`) stay on the tool YAML — they need a tool call / `toolUseId`.
- **Pack-scoped** (`panels`, `entrypoints`, `routes`) move off arbitrary tool YAMLs:
  - `entrypoints/*.yaml` — user-facing activation points (toggleable).
  - `panels/*.yaml` — support-surface declarations (auto-discovered, not toggleable).
  - `pack.yaml.routes` — a single module + allowlist (support surface).
- **Shared implementation** lives in `lib/`.
- **Stores are implicit** — the namespace is already the server-derived `packId`.

External semantics are preserved where the old schema could express them (same precedence, same
pack-scoped namespaces, same Host API surface, same guards, same worker confinement, same
reload/uninstall reconciliation). Internal addressing changes because panels/entrypoints/routes are no
longer anchored to a carrier tool.

> **Assumed dependency:** goal `e8fcf298-9215-4c7e-8b8e-57631128e390` has already removed `permissions:`.
> Do **not** reintroduce it. There is no `permissions` schema today (confirmed: no `permissions` key in
> `pack-manifest.ts::validateManifest` or `tool-contributions.ts::parseContributions`).

---

## 0. Current state (what we are changing)

All Extension Host contribution keys are parsed off `tools/<group>/<tool>.yaml` by
`src/server/agent/tool-contributions.ts::parseContributions()` — `renderer`, `actions`, **and** the
pack-scoped `stores` / `panels` / `routes` / `entrypoints`. These flow:

- `tool-manager.ts::scanToolsDir()` (`src/server/agent/tool-manager.ts:160`) parses each tool YAML →
  `BaseToolInfo.contributions: ToolContributions`.
- `contributionFields()` (`tool-manager.ts:96`) maps them onto the wire `ToolInfo`
  (`storeIds`/`panels`/`routeNames`/`entrypoints`/`rendererKind`/`hasActions`/`actionNames`).
- `/api/tools` (`server.ts:5106`) emits the full `ToolInfo` per tool.
- The client registries (`pack-panels.ts`, `pack-entrypoints.ts`, `pack-renderers.ts`) all reconcile from
  `/api/tools` via `fetchTools(projectId)`.
- `ToolManager.resolveToolLocation()` (`tool-manager.ts:~470`) returns
  `{ baseDir, groupDir, rendererFile, actionsModule, panels, routesModule, routeNames }`.
- `RouteRegistry.buildPackMap()` (`route-dispatcher.ts`) **scans every tool** in the pack for
  `routeNames`.
- Panel module bytes are served by `GET /api/tools/:tool/panel/:panelId` (`server.ts:5243`), keyed by a
  **tool**.
- Pack identity is derived from the winning tool's `baseDir` (`pack-identity.ts::derivePackId`), and a
  surface token always binds a non-empty `tool` (`surface-binding.ts::SurfaceBinding`).
- Path-bearing fields are validated against the **group dir** by
  `path-guard.ts::isPackPathWithinGroup`, and the confined worker confines imports to the **group dir**
  (`module-host-bootstrap.ts`, `confinement-loader.ts`).

We move the pack-scoped declarations off tools, generalise identity/surface-binding to tool-OR-pack,
widen the containment root from group dir to pack root, and add a project-scoped pack-contribution
registry + a Market UI activation feature.

---

## 1. Target on-disk schema

### 1.1 Directory layout

```text
<pack>/
  pack.yaml
  roles/<name>.yaml
  skills/<name>/SKILL.md

  tools/<group>/
    <tool>.yaml             # tool definition + renderer/actions ONLY
    actions.mjs             # optional, co-located tool action module
    ToolRenderer.js         # optional, co-located tool renderer

  panels/<panel>.yaml       # pack-scoped panel definitions, one file each (auto-discovered)
  entrypoints/<ep>.yaml     # pack-scoped launcher/deep-link definitions, one file each

  lib/                      # shared implementation modules, NOT entities
    SharedRenderer.js
    ArtifactViewerPanel.js
    routes.mjs
    helpers.mjs
```

The pack **root** is `market-packs/<name>/` (the dir holding `pack.yaml`). All path-bearing fields are
contained within the pack root (§2), so `tools/<group>/<tool>.yaml` may reference `../../lib/X.js`.

### 1.2 `pack.yaml`

`pack.yaml` is a table of contents of user-facing/configurable things, plus the pack-level `routes`
reference. Panels are **not** listed (auto-discovered from `panels/*.yaml`). The full schema:

```yaml
name: artifacts
description: "Search tool + artifact viewer."
version: 1.0.0
contents:
  roles:       []
  tools:       [artifact_demo]          # tools/<group> dir names (unchanged)
  skills:      []
  entrypoints: [artifacts-deeplink]     # NEW — entrypoints/<name>.yaml basenames; toggleable
routes:                                 # NEW optional top-level block
  module: lib/routes.mjs                # relative to pack.yaml; contained in pack root
  names:  [bundle, publish]             # allowlist (unchanged semantics)
```

Rules:

- `contents.entrypoints: string[]` — **ADD**. Each entry is the basename (no extension) of an
  `entrypoints/<name>.yaml` file. This is the activation catalogue the Market UI toggles and the
  registry keys by. Default-enabled.
- `contents.panels` — **DO NOT ADD.** Panels are auto-discovered from `panels/*.yaml`; they are support
  surfaces, not activation points.
- `routes: { module?: string; names?: string[] }` — **ADD** (optional top-level). When present, the
  pack contributes server routes from `module` (default unset ⇒ no routes), gated by the `names`
  allowlist (preserved semantics from the old per-tool `routes.names`).
- `contents.mcp` — **keep rejecting** (`pack-manifest.ts:78`).
- `stores` — **removed everywhere**. No schema, no wire field. Stores are implicit, created on first
  `host.store.put`, namespaced by the server-derived `packId`.
- `permissions` — absent (dependency goal). Do not reintroduce.

Unknown top-level keys remain ignored (`validateManifest` already ignores unknown keys — forward-compat).

### 1.3 Tool YAML — tool-scoped only

```yaml
name: artifact_demo
group: Demo
description: "Demo artifact tool."
renderer: ../../lib/SharedRenderer.js  # relative to THIS yaml, contained in pack root
actions:
  module: actions.mjs                  # relative to THIS yaml, contained in pack root
  names: [retry]
```

`parseContributions()` must parse **only** `renderer` + `actions` from a tool YAML. Drop
`stores`/`panels`/`routes`/`entrypoints` parsing from the tool path entirely. A tool YAML carrying any of
those keys: the keys are simply ignored (unknown keys are not fatal — keep the tolerant scan), but the
**migrated packs must not ship them** and tests pin that the tool path no longer parses them.

### 1.4 Panel file `panels/<panel>.yaml`

```yaml
id: artifacts.viewer                   # unique WITHIN the owning pack (dotted ids allowed)
title: Artifact                        # optional
entry: ../lib/ArtifactViewerPanel.js   # relative to THIS yaml, contained in pack root
```

### 1.5 Entrypoint file `entrypoints/<ep>.yaml`

Two shapes, mirroring the current `EntrypointContribution` union (`tool-contributions.ts:44`):

**Deep-link route kind** (no clickable surface):

```yaml
# entrypoints/artifacts-deeplink.yaml
id: artifacts.deeplink                 # unique within the owning pack
kind: route
routeId: artifacts                     # host-global deep-link route id; duplicate = hard conflict
target:
  panelId: artifacts.viewer            # resolved within the same pack
paramKeys: [artifactId]
```

**Launcher kinds** (`composer-slash` / `git-widget-button` / `command-palette`):

```yaml
# entrypoints/pr-walkthrough-open.yaml
id: pr-walkthrough.open
kind: composer-slash
label: PR Walkthrough                  # required for launcher kinds
target:
  route: pr-walkthrough                # OR { panelId: ... }
  params:
    jobId: job-litmus-1
```

Field validity is identical to the existing `parseEntrypoints` (`tool-contributions.ts:289`): `route`
kind needs `routeId` + `target.panelId` + optional `paramKeys`; launcher kinds need `label` + a
structured `target` (`{panelId}` or `{route}`). The only change is **one entry per file** instead of an
array embedded in a tool YAML.

---

## 2. Path resolution + containment

**Rule:** every path-bearing field resolves **relative to the YAML file that declares it**, then the
resolved absolute path must stay inside the **pack root** (not the group dir).

| Declaration site | Field(s) | Resolve base | Containment root |
|---|---|---|---|
| `tools/<group>/<tool>.yaml` | `renderer`, `actions.module` | the tool YAML's dir | pack root |
| `panels/<panel>.yaml` | `entry` | the panel YAML's dir (`panels/`) | pack root |
| `pack.yaml` | `routes.module` | pack root | pack root |

### 2.1 `isSafeRelativePath` change

`tool-contributions.ts::isSafeRelativePath` (`tool-contributions.ts:114`) currently rejects any `..`
segment. **Relax it** so a relative path *may* contain `..` (co-location ergonomics: a tool YAML pointing
at `../../lib/X.js`). It must still reject absolute paths, Windows drive-absolute, and leading `/`/`\`.
The escape protection moves to the realpath containment check below — `..` is allowed at parse time and
rejected only if the resolved path escapes the pack root. Keep null-byte rejection.

> Rationale: parse-time `..` rejection was the old escape guard *because* the old root was the group dir
> and there was no need to walk up. Now that shared modules live in `lib/` (a sibling of `tools/`), the
> parse-time rule would forbid every legitimate `../lib/...` reference. Containment is enforced at
> resolve time against the pack root, which is strictly stronger (realpath + symlink aware).

### 2.2 Rename `isPackPathWithinGroup` → `isPackPathWithinRoot`

`path-guard.ts::isPackPathWithinGroup` (`path-guard.ts:38`) is unchanged in behaviour (lexical +
realpath containment, ENOENT tolerated) but renamed to `isPackPathWithinRoot` to reflect that the
containment root is now the pack root. Update **all** call sites:

- `action-dispatcher.ts::resolveModulePath` (`action-dispatcher.ts:~210`)
- `route-dispatcher.ts::resolveModulePath`
- `confinement-loader.ts::enforceContainment` (the injected `isWithin`) + its import in
  `module-host-bootstrap.ts::confinementReady`
- `server.ts` renderer endpoint (`server.ts:5232`), panel endpoint replacement (§6.3)

The function signature stays `(rootAbs: string, fileAbs: string) => boolean`. Only the name and the
argument *meaning* (pack root vs group dir) change.

### 2.3 Deriving the pack root per declaration site

The pack root is `market-packs/<name>/`, i.e. the dir **two levels up** from a `tools/<group>/`
location, or the dir holding `pack.yaml`. Add a single helper (server lane):

```ts
// pack-identity.ts (or a small new helper module)
/** The pack root dir for a winning contribution's baseDir (= the tools/ parent).
 *  baseDir is `<...>/market-packs/<name>/tools`; the pack root is its parent. */
export function packRootFromToolsBaseDir(baseDir: string): string; // path.dirname(baseDir)
```

For tool contributions, `resolveToolLocation()` returns `baseDir = <packRoot>/tools`, so
`packRoot = path.dirname(baseDir)`. The tool-YAML dir is `path.join(baseDir, groupDir)`, and
`renderer`/`actions.module` resolve relative to *that* dir, then are checked against `packRoot`.

For pack contributions (panels/routes), the loader knows the pack root directly (it scanned
`<packRoot>/panels/*.yaml` and `<packRoot>/pack.yaml`), so it stores `packRoot` + `sourceFile` on each
contribution (§5).

---

## 3. Confinement root widening

Today `action-dispatcher.ts::resolveModulePath` and `route-dispatcher.ts::resolveModulePath` return
`packRoot = path.join(loc.baseDir, loc.groupDir)` (the **group dir**), and the worker bootstrap confines
imports to that group dir. A server module importing `../lib/helper.mjs` would be **rejected** by
`confinement-loader.ts::enforceContainment`.

**Change:** `resolveModulePath` returns the **actual pack root** (`path.dirname(loc.baseDir)`), so:

- the entry module is still resolved relative to its declaring YAML's dir and checked against the pack
  root (§2);
- the `{ abs, packRoot }` result carries the real pack root;
- `ModuleHost.invoke({ packRoot, ... })` forwards the pack root into the worker;
- `confinement-loader.ts` confines the pack module graph to the pack root, so `../lib/*.mjs` loads while
  an import resolving outside the pack root is still rejected.

The containment invariant is unchanged ("imports may not escape the pack root"); only the root widens
from group dir to pack root. Keep the `enforceContainment` fail-closed behaviour (set root + missing
guard ⇒ reject).

**Pin (server lane):** `tests/extension-host-confinement.test.ts` (extend or add) — a pack
`actions.mjs`/`routes.mjs` importing `../lib/<helper>.mjs` loads successfully; an import that resolves
outside the pack root (e.g. `../../other-pack/x.mjs`, an absolute path, or a symlink escape) is rejected
with the `[confinement]` error.

---

## 4. Identity + surface binding (tool-only → tool-OR-pack)

### 4.1 `SurfaceBinding` — `tool` becomes optional

`surface-binding.ts::SurfaceBinding` (`surface-binding.ts:54`) currently requires a non-empty `tool`.
Generalise:

```ts
export interface SurfaceBinding {
  /** The session the surface's Host API is bound to. */
  sessionId: string;
  /** SERVER-derived pack id (the winning contribution's pack dir). */
  packId: string;
  /** SERVER-derived contribution id (see scheme below). */
  contributionId: string;
  /** The pack's contributing tool name — PRESENT only for tool-bound surfaces
   *  (renderer/action). ABSENT for pack-bound surfaces (panel/entrypoint/route). */
  tool?: string;
}
```

`validateSurfaceToken` must stop requiring `payload.tool` to be a non-empty string. It must instead
require `packId` non-empty + `contributionId` present (string) + `sessionId` non-empty + `iat` number,
and accept `tool` as `string | undefined`.

### 4.2 `contributionId` scheme

| Surface kind | `contributionId` | `tool` field |
|---|---|---|
| tool renderer / action | `${groupDir}/${tool}` (unchanged) | the tool name |
| pack panel | `panel:<panelId>` | absent |
| pack entrypoint | `entrypoint:<entrypointId>` | absent |
| pack route | `route:<routeName>` | absent |

`pack-identity.ts::resolvePackIdentity` (`pack-identity.ts:60`) keeps the tool form. Add a pack-bound
identity resolver that does not need a tool:

```ts
export interface PackIdentity {
  packId: string;
  contributionId: string;
  isPack: boolean;
}

/** Pack-bound identity from a pack root + an explicit contribution id. Used when
 *  the surface is a panel/entrypoint/route (no carrier tool). */
export function resolvePackContributionIdentity(
  packRoot: string,            // absolute market-packs/<name> dir
  contributionId: string,      // "panel:..." | "entrypoint:..." | "route:..."
): PackIdentity;
```

`packId` is still derived structurally from the `market-packs/<name>` path segment (reuse
`derivePackId`, which currently splits a `baseDir`; give it a variant that accepts a pack root whose
**last** segment is the pack name, or simply take `path.basename(packRoot)` after asserting the parent
segment is `market-packs`). **Never** read a trusted `packId` from request input.

### 4.3 Mint validation for pack-bound surfaces

`POST /api/ext/surface-token` (§6.5) must accept both shapes. The pack-bound validation, performed
server-side against the session's project-scoped pack-contribution registry (§5):

1. The pack named by the client ref is **installed** in the resolved scope for the session's project.
2. The pack is **active** — installed in the resolved scope and not disabled by an activation override
   (default enabled). See §7 for "active".
3. The referenced **contribution exists** in that winning pack's contribution registry:
   - `panel` → a `PanelContribution` with `id === contributionId-without-prefix` in that pack;
   - `entrypoint` → an `EntrypointContribution` with that `id` in that pack;
   - `route` → a route `name` present in the pack's `routes.names` (registered route).
4. The requested session is the caller's own session (header-canonical session match).

On success mint `{ sessionId, packId, contributionId }` (no `tool`). On any failure, **403**.

### 4.4 `resolveSurfaceIdentity` for both shapes

`surface-binding.ts::resolveSurfaceIdentity` (`surface-binding.ts:~150`) currently re-resolves the pack
identity via `resolvePackIdentityForTool(resolver, binding.tool)` and asserts `ident.packId ===
binding.packId`. Generalise so a missing `tool` takes the pack-bound branch:

```ts
export type SurfaceIdentityResult =
  | { ok: true; sessionId: string; packId: string; contributionId: string; tool?: string }
  | { ok: false; status: number; error: string };

export function resolveSurfaceIdentity(input: {
  token: unknown;
  headerSessionId: string | undefined;
  resolver: ActionToolLocationResolver;     // tool-bound re-resolution (unchanged)
  contributions: PackContributionResolver;  // NEW — pack-bound re-resolution (§5)
  now?: () => number;
}): SurfaceIdentityResult;
```

- Validate signature + TTL (unchanged).
- Assert `binding.sessionId === headerSessionId` (own-session — unchanged).
- **Tool-bound** (`binding.tool` present): re-resolve via `resolvePackIdentityForTool` and assert
  `packId` match (unchanged path — covers a token that went stale after uninstall/precedence change).
- **Pack-bound** (`binding.tool` absent): re-resolve via the pack-contribution registry — the pack must
  still be installed + active in scope AND still expose `binding.contributionId`. Assert the
  re-resolved `packId` matches `binding.packId`. A token for an uninstalled or now-disabled
  pack/contribution is rejected (403).

### 4.5 New trust boundary (state it explicitly)

Today every scoped path is tool-anchored: the surface token requires a non-empty `tool`, and the mint +
scoped endpoints layer `tool ∈ allowedTools` (`authorizeScopedRequest`). A **pack-bound surface has no
tool**, so its gate becomes:

> **pack installed + active in the resolved scope + caller's own session.**

`allowedTools` **no longer narrows which packs a session may reach** for pack-bound surfaces. This is the
deliberate, central authorization change that enables orphan / UI-only packs. It is bounded by the
existing pack-scoped guarantees, which are unchanged:

- store is `packId`-namespaced (cross-pack reads/writes impossible through sanctioned APIs);
- `host.callRoute` reaches only the caller pack's own routes;
- session reads are own-session only;
- session writes keep the user-activation + one-time content-bound permit gate.

So a pack-bound surface grants no capability a tool-bound surface did not already have — but an
installed+active UI-only pack **can** use those scoped surfaces on the active session without a tool in
`allowedTools`. No new Host API *method* is added.

For **tool-bound** surfaces (renderer/action), the `allowedTools` + `toolUseId` gates are **unchanged**.
Actions remain impossible without a real tool call.

**Pin (server lane):** a pack-bound surface token for an uninstalled or disabled pack/contribution is
rejected; a pack-bound token minted for session A is rejected when presented on session B.

---

## 5. Pack-contribution registry (new)

### 5.1 Loaders — `src/server/agent/pack-contributions.ts`

A new module parses the pack-scoped declarations from a pack root. It mirrors the tolerance of
`tool-contributions.ts` (warn + drop malformed, never crash the scan), except for the hard conflicts in
§5.4.

```ts
// src/server/agent/pack-contributions.ts

/** A pack-scoped panel (panels/<file>.yaml). */
export interface PanelContribution {
  id: string;                 // unique within the pack (dotted allowed)
  title?: string;
  entry: string;              // path relative to sourceFile, contained in packRoot
  /** Absolute path of the declaring YAML (panels/<file>.yaml). */
  sourceFile: string;
  /** Absolute pack root (market-packs/<name>). */
  packRoot: string;
}

/** A pack-scoped entrypoint (entrypoints/<file>.yaml). */
export interface EntrypointContribution {
  id: string;                 // unique within the pack
  kind: "composer-slash" | "git-widget-button" | "command-palette" | "route";
  label?: string;             // required for launcher kinds
  routeId?: string;           // required for kind:"route"; host-global
  target?: { panelId?: string; route?: string; params?: Record<string, unknown> };
  paramKeys?: string[];
  /** The contents.entrypoints[] basename that lists this file — the SINGLE activation
   *  toggle key. Carried so filtering maps one toggle onto BOTH the launcher id AND
   *  the deep-link routeId the client registry keys by. */
  listName: string;
  sourceFile: string;
  packRoot: string;
}

/** The pack-level routes ref (pack.yaml `routes`). */
export interface RouteContribution {
  module: string;             // path relative to pack.yaml, contained in packRoot
  names: string[];            // allowlist
  sourceFile: string;         // = <packRoot>/pack.yaml
  packRoot: string;
}

/** All pack-scoped contributions for ONE installed pack. */
export interface PackContributions {
  packId: string;             // structural, from the pack root dir name
  packName: string;
  packRoot: string;
  panels: PanelContribution[];
  entrypoints: EntrypointContribution[];
  routes?: RouteContribution;
}

export function loadPackContributions(packRoot: string, manifest: PackManifest): PackContributions;
```

Loader behaviour:

- `panels/*.yaml` → each file parsed to a `PanelContribution`. Auto-discovered (not from `contents`).
  Malformed file (bad id, missing/unsafe `entry`) → warn + drop. `entry` path-safety uses the relaxed
  `isSafeRelativePath` (§2.1); full containment is enforced at serve/import time.
- `entrypoints/*.yaml` → only files whose basename is in `manifest.contents.entrypoints[]` are loaded
  (the `contents` list is the catalogue). `listName` = basename. Reuse the existing `parseEntrypoints`
  field validation, adapted to a single object instead of an array element.
- `pack.yaml.routes` → `RouteContribution` with `sourceFile = <packRoot>/pack.yaml`. Absent `routes` ⇒
  `routes: undefined`.

### 5.2 Registry — `src/server/extension-host/pack-contribution-registry.ts`

A project-scoped registry indexing panels/entrypoints/routes by **installed + active** pack. It is the
pack-scoped analogue of `RouteRegistry`.

```ts
// src/server/extension-host/pack-contribution-registry.ts

export interface PackContributionResolver {
  /** All active packs' contributions for a project scope (low→high precedence). */
  list(projectId: string | undefined): PackContributions[];
  /** A single pack's contributions, or undefined when not installed/active. */
  getPack(projectId: string | undefined, packId: string): PackContributions | undefined;
  /** Resolve a panel within a pack. */
  getPanel(projectId: string | undefined, packId: string, panelId: string): PanelContribution | undefined;
  /** Resolve an entrypoint within a pack. */
  getEntrypoint(projectId: string | undefined, packId: string, entrypointId: string): EntrypointContribution | undefined;
  /** True when the pack declares routeName in its routes.names allowlist. */
  hasRoute(projectId: string | undefined, packId: string, routeName: string): boolean;
}

export class PackContributionRegistry implements PackContributionResolver {
  constructor(private readonly enumerate: (projectId: string | undefined) => PackEntry[]) {}
  invalidate(): void;   // drop the per-project cache
  // ...implements the interface, applying ACTIVATION FILTERING (§7) before returning.
}
```

The registry's pack enumeration reuses the **same** market-pack enumeration the tool cascade uses:
`scopeMarketPackEntries(scope, base, packOrder)` (`pack-list.ts:123`), interleaved server <
global-user < project, dedup-on-path (mirroring `marketToolRoots` in `server.ts:975`). For each
`PackEntry` it calls `loadPackContributions(entry.path, entry.manifest)`. **Activation filtering**
(§7) drops disabled entrypoints before they reach `list()`/`getEntrypoint()`; panels/routes are always
present when the pack is installed + active. The registry caches per project and is dropped on
`invalidate()`.

### 5.3 RouteRegistry rebuild

`RouteRegistry.buildPackMap()` (`route-dispatcher.ts`) currently **scans every tool** in a pack for
`routeNames`. Rebuild it from the pack-level `RouteContribution`:

- For a `(packId, routeName)`, look up the pack's `RouteContribution` via the
  `PackContributionRegistry`. If `routeName ∈ routes.names`, resolve the module path
  (`path.resolve(path.dirname(routes.sourceFile), routes.module)`, contained in pack root) and return
  `{ modulePath }`. There is no longer a `declaringTool` — the route is pack-level.
- `RouteDispatcher.dispatch()` is keyed by module path, not by a tool. Adjust its `resolveModulePath`
  to accept a resolved module path (or keep a thin resolver that maps packId+route → module path via the
  registry). The dispatch ctx's `tool` field becomes the `contributionId` (`route:<name>`) for audit;
  the confined worker only needs `{ url, packRoot, exportKind: "routes", member: name }`.

`RouteRegistry` is constructed against the `PackContributionRegistry` instead of the `ToolManager`
enumerator. It keeps its WeakMap cache + `invalidate()`.

### 5.4 Hard conflicts (preserved)

The loaders are tolerant **except** these, which remain hard rejections (`ActionError` / build-time
error naming the conflict):

1. **Duplicate route name within a pack** — `routes.names` containing the same name twice (dedupe or
   reject; reject is simplest and matches today's intent).
2. **Duplicate host-global `routeId`** — two entrypoints (any pack) claiming the same `routeId`.
   Detected at client registry build (`pack-entrypoints.ts` already does this) AND server-side when the
   `PackContributionRegistry` builds the cross-pack routeId index. Register **neither** + loud error.
3. **Duplicate panel id within a pack** — two `panels/*.yaml` with the same `id`.
4. **Duplicate entrypoint id within a pack** — two `entrypoints/*.yaml` with the same `id`.

### 5.5 Wiring + cache invalidation

`server.ts` constructs `routeDispatcher`/`routeRegistry` near `toolManager` (`server.ts:880`). Add the
`PackContributionRegistry` there, enumerating via the same `marketPackProvider`. Extend
`invalidateResolverCaches()` (`server.ts:2274`) to also call `packContributionRegistry.invalidate()`:

```ts
const invalidateResolverCaches = (): void => {
  invalidateSlashSkillsCache();
  __resetToolScanCache();
  dispatcher.invalidate();
  routeDispatcher.invalidate();
  routeRegistry.invalidate();
  packContributionRegistry.invalidate();   // NEW
};
```

All install/update/uninstall/pack-order endpoints already call `invalidateResolverCaches()`
(`server.ts:6113`, `6128`, `6143`, `6182`). The activation-override PUT (§6.7) must call it too.

---

## 6. Endpoints / wire contract (the parallelism seam)

This section is **frozen**. Lanes A/B/C integrate against exactly these shapes.

### 6.1 `GET /api/tools` — strip pack-scoped fields

`/api/tools` (`server.ts:5106`) emits `ToolInfo` per resolved tool. **Remove** the pack-scoped fields
from `ToolInfo` (`tool-manager.ts:38`) and from `contributionFields()` (`tool-manager.ts:96`):
drop `storeIds`, `panels`, `routeNames`, `entrypoints`. **Keep** only the tool-scoped contribution
fields:

```jsonc
// one element of { "tools": [ ... ] }
{
  "name": "artifact_demo",
  "description": "...",
  "group": "Demo",
  "docs": "...",
  "detail_docs": "...",
  "hasRenderer": true,
  "rendererFile": "../../lib/SharedRenderer.js",
  "rendererKind": "pack",        // "pack" | "builtin"
  "hasActions": true,
  "actionNames": ["retry"],
  // existing cascade origin metadata (unchanged):
  "origin": "market", "originPackId": "...", "originPackName": "..."
}
```

`resolveToolLocation()` (`tool-manager.ts:~470`) likewise drops `panels`/`routesModule`/`routeNames`
from its return shape (it keeps `rendererFile`/`actionsModule`/`rendererKind`/`actionNames`).

### 6.2 Tool renderer + action endpoints — UNCHANGED

- `GET /api/tools/:tool/renderer?projectId=` (`server.ts:5197`) — unchanged, except the containment
  check uses `isPackPathWithinRoot(packRoot, fileAbs)` where `packRoot = path.dirname(loc.baseDir)` and
  the renderer resolves relative to the tool YAML's dir (`path.join(loc.baseDir, loc.groupDir)`). This
  is what lets `renderer: ../../lib/SharedRenderer.js` serve.
- `POST /api/tools/:tool/actions/:action` (`server.ts:5294`) — **fully unchanged** authorization: session
  match, `tool ∈ allowedTools`, `action ∈ actionNames`, and `toolUseId` exists in the session and was a
  call of that tool. Only the internal module-path containment widens to the pack root.

### 6.3 REPLACE the panel endpoint — pack-addressed

**Remove** `GET /api/tools/:tool/panel/:panelId` (`server.ts:5243`).

**Add** `GET /api/ext/packs/:packId/panels/:panelId?projectId=...`:

- Admin-bearer only / static-asset-equivalent (same as the renderer endpoint — **no** `allowedTools`
  check; serving bytes is not a capability invocation).
- Resolve the project-scoped `PackContributionRegistry`; `getPanel(projectId, packId, panelId)`. 404 if
  the pack is not installed/active or the panel id is unknown in that pack.
- Resolve `fileAbs = path.resolve(path.dirname(panel.sourceFile), panel.entry)` and require
  `isPackPathWithinRoot(panel.packRoot, fileAbs)`; else 404.
- `readFileSync` the bytes; serve `Content-Type: text/javascript`, `Cache-Control: no-cache`. Missing
  file ⇒ 404 (the existing missing-panel fallback path).

Response: raw ESM bytes (not JSON), identical delivery to the renderer endpoint.

### 6.4 NEW `GET /api/ext/contributions?projectId=...`

Project-scoped pack-contribution metadata for the client registries. **Activation filtering applied**:
disabled entrypoints omitted; panels/routes always present when the pack is installed + active.

```jsonc
{
  "packs": [
    {
      "packId": "artifacts",
      "packName": "artifacts",
      "panels": [
        { "id": "artifacts.viewer", "title": "Artifact" }
      ],
      "entrypoints": [
        {
          "id": "artifacts.deeplink",
          "kind": "route",
          "routeId": "artifacts",
          "target": { "panelId": "artifacts.viewer" },
          "paramKeys": ["artifactId"],
          "listName": "artifacts-deeplink"
        }
      ],
      "routeNames": ["bundle", "publish"]
    }
  ]
}
```

Notes:

- `panels[]` carries only `{ id, title? }` — the `entry` path stays server-side (the client addresses
  panels by `{packId, panelId}` against §6.3).
- `entrypoints[]` carries the full client-needed shape (`id`, `kind`, `label?`, `routeId?`, `target`,
  `paramKeys?`, `listName`). `listName` lets the client/server map one activation toggle onto both the
  launcher id and the deep-link routeId.
- `routeNames[]` is the allowlist (so a client could feature-detect route availability; primarily for
  completeness/tests).
- Packs with no panels/entrypoints/routes still appear (empty arrays) when installed + active, so the
  client can reconcile-on-uninstall. (Implementation may omit a pack with all-empty arrays; the client
  reconcile handles both — but emitting the row is preferred for deterministic reconcile.)

### 6.5 `POST /api/ext/surface-token` — tool OR pack ref

Accept both ref shapes. Request body (one of):

```jsonc
// tool-bound (renderer / action surfaces) — UNCHANGED shape
{ "sessionId": "<sid>", "tool": "artifact_demo" }

// pack-bound (panel / entrypoint / route surfaces) — NEW
{
  "sessionId": "<sid>",
  "contributionKind": "panel",        // "panel" | "entrypoint" | "route"
  "contributionId": "artifacts.viewer", // bare id (panelId / entrypointId / routeName)
  "packId": "artifacts"
}
```

Response (unchanged): `{ "token": "<opaque>" }`.

Server logic:

- **tool-bound** (`tool` present): unchanged — `authorizeScopedRequest` (session + `tool ∈
  allowedTools`), `resolvePackIdentityForTool`, reject non-pack, mint `{ sessionId, packId,
  contributionId: "${groupDir}/${tool}", tool }`.
- **pack-bound** (`contributionKind` present): header-canonical session + `sessionId` body===header;
  validate per §4.3 against the `PackContributionRegistry` (installed + active + contribution exists);
  build `contributionId` = `${contributionKind}:${contributionId}`; mint `{ sessionId, packId,
  contributionId }` (no `tool`). No `allowedTools` gate (new trust boundary, §4.5).

### 6.6 Scoped endpoints resolve by token `packId`

- `POST /api/ext/store/:op` (`server.ts:5460`), `GET /api/ext/session/{transcript,tool-call}`
  (`server.ts:5552`), `POST /api/ext/route/:name` (`server.ts:5625`), and the WS
  `ext_session_write_permit` / `ext_session_post` (`handler.ts:~1024`/`~1059`) all call
  `resolveSurfaceIdentity(...)` and derive `{ packId, tool? }` from the validated token.
- They must pass the new `contributions: PackContributionResolver` arg into `resolveSurfaceIdentity`
  (§4.4) so a pack-bound token re-validates against the registry.
- **`authorizeScopedRequest` is only applied for tool-bound tokens.** For a pack-bound token (no
  `tool`), skip the `allowedTools` gate — the §4.5 boundary (installed + active + own-session) is the
  authorization. Concretely: branch on `surf.tool` — when present, layer the existing
  `authorizeScopedRequest({ tool: surf.tool, ... })`; when absent, the token validation already proved
  installed+active+own-session, so proceed with `surf.packId`.
- `POST /api/ext/route/:name` already resolves the route MODULE via the pack-level registry using
  `ident.packId` (`server.ts:5682`). With the RouteRegistry rebuilt off pack-level routes (§5.3), the
  resolution becomes `routeRegistry.resolve(ident.packId, routeName, projectId)` → `{ modulePath }`.
  Confirm the change is from a tool-derived packId to a token-derived packId — which **already happens**
  (the endpoint derives packId from the surface token, not from a tool location). The only change here
  is that pack-bound tokens (no `tool`) now reach this path, and the route module comes from pack-level
  routes instead of a declaring tool.

### 6.7 Activation override persistence — extend `project-config-store`

Add a new migrated native-YAML field `pack_activation` alongside `pack_order`
(`project-config-store.ts`). Shape:

```ts
// project-config-store.ts
/** scope → packName → disabled entity refs by kind. Default (absent) = all enabled. */
export type PackActivationMap = Partial<Record<PackOrderScope, Record<string, DisabledRefs>>>;

export interface DisabledRefs {
  roles?: string[];        // disabled role names
  tools?: string[];        // disabled tool names
  skills?: string[];       // disabled skill names
  entrypoints?: string[];  // disabled entrypoint listName values (contents.entrypoints[] basenames)
}
```

- Mirror `pack_order` exactly: add `"pack_activation"` to `MIGRATED_KEYS`, a `normalizePackActivation`,
  `getPackActivation(scope)` / `setPackActivation(scope, map)` / `getPackActivationMap()`, native-YAML
  emit in `save()`, JSON-string back-compat in `flatLegacyView()`. `project` scope lives in the project
  config; `server` + `global-user` live in the server config (same split as `pack_order`).
- Entrypoint refs are keyed by **`listName`** (the `contents.entrypoints[]` basename), so one toggle
  disables both the launcher id and the deep-link routeId derived from that file.

New REST endpoints (mirror `/api/marketplace/pack-order` at `server.ts:6156`/`6165`):

```text
GET  /api/marketplace/pack-activation?scope=<scope>&projectId=<id>&packName=<name>
     → { scope, packName, disabled: DisabledRefs }

PUT  /api/marketplace/pack-activation
     body: { scope, projectId?, packName, disabled: DisabledRefs }
     → { scope, packName, disabled: <normalized> }   ; then invalidateResolverCaches()
```

Normalisation on PUT: drop refs for entities the pack does not declare (best-effort, like pack-order
normalisation), persist, invalidate caches.

---

## 7. Resolver activation filtering

"Active" is defined against the pack-contribution registry: **a contribution is active when its pack is
installed in the resolved scope and not disabled by an activation override (default enabled).**

Filtering is applied per entity kind:

- **Tools / roles / skills** — disabled entities are removed from the **resolver's resolved entity
  lists**, so a lower-priority shadowed entity may reappear per existing resolver semantics. Apply this
  in the cascade resolution path (`config-cascade.ts` resolve* methods) — read `pack_activation` for the
  winning entity's pack/scope and drop disabled names **before** precedence merge picks a winner, so the
  shadow can win. This keeps `/api/tools`, `/api/roles`, and the skills list all honouring activation
  without per-endpoint logic.
- **Entrypoints** — filtered in the `PackContributionRegistry` (§5.2) so disabled entrypoints are
  omitted from `/api/ext/contributions`. The client never sees them, so launcher + deep-link
  registration is skipped.
- **Panels / routes / stores / renderers / actions / lib** — **not toggleable.** Always present when the
  pack is installed + active. A panel targeted by a disabled entrypoint stays available to any enabled
  tool/entrypoint that opens it.

> Single source of truth: filtering for tools/roles/skills lives in the cascade resolver; filtering for
> entrypoints lives in the pack-contribution registry. Endpoints do not re-filter.

---

## 8. Client model

### 8.1 Panels keyed by `{packId, panelId}`

Panel ids are only pack-unique now, so `pack-panels.ts` must key its registry by `{packId, panelId}`
(compound key, e.g. `` `${packId}\u0000${panelId}` ``). Changes:

- `PackPanelInfo` (`pack-panels.ts:~95`) gains `packId` and drops the `tool` requirement.
- `RegisteredPanel` carries `{ packId, panelId, title?, projectId? }` (no `tool`).
- The lazy loader fetches from `/api/ext/packs/${packId}/panels/${panelId}?projectId=` instead of
  `/api/tools/:tool/panel/:panelId`.
- `reconcilePackPanelsForProject` consumes the **new** `/api/ext/contributions` endpoint (not
  `/api/tools`). Add `fetchContributions(projectId)` to `src/app/api.ts` returning the §6.4 shape.
- `panelInfosFromTools` → `panelInfosFromContributions(packs)`.
- `host.ui.openPanel({ panelId })` stays **pack-relative**: the caller surface's bound `packId` (held in
  the host-api closure, §8.4) resolves `panelId` → `{packId, panelId}` before fetching bytes. The
  `openPackPanel(target)` chokepoint gains the caller's `packId` (threaded from the host factory).

### 8.2 Entrypoints from `/api/ext/contributions`

`pack-entrypoints.ts` reconcile consumes `/api/ext/contributions` instead of `/api/tools`. The
registered launcher/route entries carry `packId` instead of `tool` (used to mint the pack-bound surface
token + address panel bytes). `entrypointInfosFromTools` → `entrypointInfosFromContributions(packs)`.
The duplicate-`routeId` hard conflict logic (`pack-entrypoints.ts:~110`) is unchanged.

### 8.3 Renderers stay on `/api/tools`

`pack-renderers.ts` is **unchanged** — tool renderers stay tool-scoped and reconcile from `/api/tools`
via `rendererKind === "pack"`.

### 8.4 `getHostApi` — tool-bound vs pack-bound mint

`host-api.ts::getHostApi(sessionId, toolUseId, packTool?)` (`host-api.ts:~80`) mints a surface token
keyed on `{ tool: packTool }`. Generalise the mint input:

```ts
// One of these is supplied by the trusted app loader:
type SurfaceRef =
  | { kind: "tool"; tool: string }                              // renderer/action
  | { kind: "pack"; packId: string; contributionKind: "panel" | "entrypoint" | "route"; contributionId: string };

export function getHostApi(
  sessionId: string | undefined,
  toolUseId: string | undefined,
  surface?: SurfaceRef,
): HostApi;
```

- **Renderer surfaces** (`pack-renderers.ts` / `renderer-registry`) mint via `{ kind: "tool", tool }`
  (existing behaviour; the renderer's tool name).
- **Panel surfaces** (`pack-panels.ts` factory) mint via `{ kind: "pack", packId, contributionKind:
  "panel", contributionId: panelId }`. The panel host factory (`setPanelHostFactory`, `host-api.ts:73`)
  is updated to pass the panel's `{packId, panelId}` (from the registered panel) instead of a `packTool`.
- The `getSurfaceToken()` closure (`host-api.ts:~95`) posts the matching body shape to
  `/api/ext/surface-token` (§6.5). The token stays opaque + closure-held; pack code never sees it.
- `host.ui.openPanel` / `host.callRoute` / `host.store.*` / `host.session.*` are otherwise unchanged —
  they thread the closure token via `scopedFetch`.

The client learns its `packId` from the contribution metadata it registered (`/api/ext/contributions`):
a panel/entrypoint registration carries `packId`, which is exactly what the host factory binds.

---

## 9. Market UI activation controls

On the Market installed-pack surface (`marketplace-page.ts`), add per-pack activation controls.

- **Toggles for user-facing entities only:** roles, tools, skills, entrypoints. No toggles for panels /
  routes / stores / renderers / actions / lib (panels MAY be shown as read-only "support surfaces"
  detail).
- **Persistence:** per scope/project via the §6.7 endpoints, keyed by pack name + entity kind + name
  (entrypoints keyed by `listName`). Default enabled.
- **Semantics shown to the user:** disabling a tool/role/skill removes it from its resolved list (and a
  shadowed lower-priority entity may reappear). Disabling an entrypoint removes its launcher + deep-link;
  a panel that an enabled tool opens stays available.
- **Copy requirement:** the entrypoint toggle help text must explain that disabling an entrypoint hides
  that launcher/deep-link, while a tool that opens the same panel is unaffected unless the tool itself is
  disabled.

Data source for the toggle lists per pack: roles/tools/skills from the existing config endpoints +
origin metadata (which already carries `originPackName`); entrypoints from `/api/ext/contributions`
(`entrypoints[].listName` + a display label).

**testids (browser E2E):**

- container: `data-testid="market-activation-<packName>"`
- per-entity toggle: `data-testid="market-toggle-<kind>-<name>"` (kind ∈ `role|tool|skill|entrypoint`;
  for entrypoints `<name>` = `listName`).
- the explanatory copy: `data-testid="market-activation-help"`.

After a toggle PUT, re-run the same reconcile the marketplace mutation path already triggers (it
re-fetches tool/contribution metadata and re-registers renderers/panels/entrypoints — see
`marketplace-page.ts:157`), so a disabled entrypoint disappears from launchers/deep-links without a
reload.

---

## 10. Migration of shipped packs + build

### 10.1 `market-packs/artifacts/`

- Keep `renderer:` on `tools/artifact_demo/artifact_demo.yaml` (point it at the built renderer; may stay
  tool-local or move to `lib/` — see §10.3).
- Move the panel declaration to `panels/artifacts-viewer.yaml`:
  ```yaml
  id: artifacts.viewer
  title: Artifact
  entry: ../lib/ArtifactViewerPanel.js
  ```
- Move the entrypoint declaration to `entrypoints/artifacts-deeplink.yaml` (the `kind:"route"` block).
- Add `contents.entrypoints: [artifacts-deeplink]` to `pack.yaml`. Drop `stores:` (it is gone).
- Move `ArtifactViewerPanel.js` (built) to `lib/`. Move `src/ArtifactViewerPanel.ts` source stays under
  `src/` (build output goes to `lib/`).
- Result: `tools/artifact_demo/artifact_demo.yaml` declares `renderer` (+ no actions in this pack);
  pack-scoped surfaces live in `panels/` + `entrypoints/`.

### 10.2 `market-packs/pr-walkthrough/` — becomes a no-tools pack

- **Remove the dummy carrier tool** `tools/pr-walkthrough/pr_walkthrough.yaml`. No `tools/` dir needed
  (`contents.tools: []`).
- Declare the panel in `panels/pr-walkthrough-panel.yaml`:
  ```yaml
  id: pr-walkthrough.panel
  title: PR Walkthrough
  entry: ../lib/panel.js
  ```
- Declare the four entrypoints as `entrypoints/<name>.yaml` files (3 launchers + 1 `kind:"route"`), and
  list their basenames in `pack.yaml.contents.entrypoints`.
- Declare routes at pack level in `pack.yaml`:
  ```yaml
  routes:
    module: lib/routes.mjs
    names: [bundle, publish]
  ```
- Move `panel.js` + `routes.mjs` into `lib/`. Drop `stores:`. No `permissions:`.
- This pack is the **orphan / UI-only** litmus: it installs, registers entrypoints, opens a panel, calls
  routes, and uses store/session APIs through pack-bound surface auth with **no tool in `allowedTools`**.

### 10.3 `scripts/build-market-packs.mjs`

- Tool **renderer** outputs may stay tool-local (`tools/<group>/<entry>.js`) OR emit to `lib/`. Panel /
  other shared bundles emit to `lib/`.
- Change the `PACKS` manifest so each entry declares its `out` path relative to the pack root, allowing
  `lib/ArtifactViewerPanel.js` and `lib/panel.js` outputs. Add a `pr-walkthrough` entry that bundles its
  panel source to `lib/panel.js` (its `routes.mjs` is hand-authored `.mjs`, not bundled — keep as-is,
  just relocated to `lib/`).
- Keep the two hard rules (lit external; single self-contained file per entry).

---

## 11. Test plan

### 11.1 Unit (lane A unless noted)

| Test | Asserts |
|---|---|
| manifest validation | `contents.entrypoints` accepted (string[]); `routes:{module,names}` accepted; `contents.mcp` still rejected; no `stores`/`permissions` schema |
| pack-contribution parsing | `panels/*.yaml` + `entrypoints/*.yaml` (single-file) + `pack.yaml.routes` parse to the §5.1 shapes; malformed file warned + dropped; `listName` carried |
| tool-contribution parsing | tool YAML parses ONLY `renderer`+`actions`; `panels`/`routes`/`entrypoints`/`stores` keys on a tool YAML are ignored (not parsed into contributions) |
| path containment to pack root | `renderer: ../../lib/x.js`, `entry: ../lib/x.js`, `routes.module: lib/x.mjs` resolve + pass `isPackPathWithinRoot`; an escaping path is rejected |
| registry conflict ×4 | dup route name in pack; dup global routeId; dup panel id in pack; dup entrypoint id in pack — each rejected |
| activation filtering | disabled tool/role/skill dropped from resolved list (shadow reappears); disabled entrypoint omitted from registry/`/api/ext/contributions`; panel/route stay present |
| no-tools pack | a pack with `contents.tools: []` loads, registers panels/entrypoints/routes |
| confinement `../lib` import (§3) | `actions.mjs`/`routes.mjs` importing `../lib/helper.mjs` loads; outside-root import rejected |
| surface-token pack-bound (§4) | pack-bound token for uninstalled/disabled pack/contribution rejected; cross-session token rejected |

### 11.2 E2E

- **renderer + action pack still works** (API E2E — tool renderer + action endpoints unchanged).
- **artifacts** (browser E2E): renderer renders inline pill → opens pack-scoped panel
  (`/api/ext/packs/artifacts/panels/artifacts.viewer`) → deep-link reload restores the panel via the
  `kind:"route"` entrypoint.
- **pr-walkthrough / no-tools pack** (browser E2E): installs with no `tools/`; an entrypoint launches a
  panel; the panel calls a route (`bundle`) and uses store/session APIs — all via pack-bound surface
  auth with no tool in `allowedTools`.
- **Market UI disable-entrypoint** (browser E2E): toggling an entrypoint off removes the launcher +
  deep-link registration while the underlying panel stays available to an enabled tool;
  re-enable restores it; persists across reload.

### 11.3 Invariant → test map (from the goal's "Behaviour/security invariants")

| Invariant | Pinned by |
|---|---|
| Precedence unchanged | existing `tests/e2e/tools-cascade.spec.ts` + pack-order tests (unchanged) |
| Tool guard (allowedTools + toolUseId) | existing action-endpoint guard tests (unchanged) |
| Pack scope (panel/entrypoint ids pack-local; routeId host-global; route names pack-local + allowlisted) | registry conflict ×4 + parsing tests (§11.1) |
| Identity server-derived; caller never supplies trusted packId | surface-token pack-bound test (§4) |
| Surface tokens server-minted/opaque/session-bound/contribution-bound/rejected-when-stale | surface-binding unit tests (extend for pack-bound) |
| Stores `packId`-namespaced; cross-pack impossible | existing store-scope tests (unchanged) + no-tools-pack store E2E |
| Session reads own-session; writes user-gesture + one-time permit | existing C2 session-write tests (unchanged) |
| Worker confinement deny-all; no `permissions` opt-in | confinement `../lib` test (§3) + manifest "no permissions" test |
| Cache invalidation on install/update/uninstall/pack-order/activation | extend the resolver-cache invalidation tests to cover `packContributionRegistry.invalidate()` + activation PUT |

---

## 12. Work partition (three non-overlapping lanes)

The agreed **wire contract (§6) + TS interfaces (§1/§4/§5)** is the integration seam. Lanes own
disjoint directories.

### Lane A — Server core

Owns all of `src/server/**`:

- `agent/pack-types.ts`, `agent/pack-manifest.ts` — schema (`contents.entrypoints`, top-level `routes`,
  keep `mcp` rejection, no `stores`/`permissions`).
- `agent/tool-contributions.ts` — shrink to `renderer`+`actions`; relax `isSafeRelativePath` (§2.1).
- `agent/tool-manager.ts` — drop pack-scoped fields from `ToolInfo`/`contributionFields`/
  `resolveToolLocation`.
- `agent/pack-contributions.ts` (**new**) — loaders (§5.1).
- `extension-host/pack-contribution-registry.ts` (**new**) — registry (§5.2).
- `extension-host/pack-identity.ts`, `surface-binding.ts` — tool-OR-pack identity + binding (§4).
- `extension-host/path-guard.ts` — rename `isPackPathWithinGroup` → `isPackPathWithinRoot` + all call
  sites.
- `extension-host/action-dispatcher.ts`, `route-dispatcher.ts`, `module-host-bootstrap.ts`,
  `confinement-loader.ts` — widen confinement root to pack root (§3); rebuild `RouteRegistry` off
  pack-level routes (§5.3).
- `server.ts` — `/api/tools` strip (§6.1); replace panel endpoint (§6.3); add `/api/ext/contributions`
  (§6.4); extend `/api/ext/surface-token` (§6.5); pack-bound scoped-endpoint auth (§6.6); activation
  REST (§6.7); wire `PackContributionRegistry` + `invalidateResolverCaches` (§5.5).
- `ws/handler.ts` — pass `contributions` resolver into `resolveSurfaceIdentity`; pack-bound auth.
- `agent/project-config-store.ts` — `pack_activation` migrated field + accessors (§6.7).
- Server unit tests in `tests/*.test.ts`.

### Lane B — Client + UI

Owns `src/app/**`, `src/ui/**`:

- `src/app/api.ts` — add `fetchContributions(projectId)` (§6.4) + pack-activation GET/PUT clients.
- `pack-panels.ts` — key by `{packId, panelId}`; consume `/api/ext/contributions`; fetch panel bytes
  from `/api/ext/packs/:packId/panels/:panelId` (§8.1).
- `pack-entrypoints.ts` — consume `/api/ext/contributions`; carry `packId` (§8.2).
- `pack-renderers.ts` — unchanged (verify it still reads `/api/tools`).
- `host-api.ts` — `SurfaceRef` mint (tool vs pack) (§8.4); update `setPanelHostFactory`.
- `panel-workspace.ts` — panel tab source carries `{packId, panelId}` instead of `{tool, panelId}`.
- `marketplace-page.ts` — activation controls UI (§9) + testids.
- Client browser fixtures/specs + `tests/e2e/ui/*`.

### Lane C — Packs + build

Owns `market-packs/**`, `scripts/build-market-packs.mjs`, `tests/fixtures/**`:

- Migrate `artifacts` (§10.1) and `pr-walkthrough` to a no-tools pack (§10.2).
- Update `build-market-packs.mjs` (renderer tool-local, panel/shared → `lib/`) (§10.3).
- Update all marketplace/extension-host fixtures under `tests/fixtures/**` to the new schema (new-layout
  fixtures: a renderer+action tool pack, a no-tools pack, a panel-only pack, conflict fixtures for the
  ×4 hard conflicts).

### Docs (any lane, coordinate)

Update `docs/marketplace.md`, `docs/extension-host-authoring.md`, `docs/design/extension-host.md`,
`docs/design/extension-host-phase2.md`, `docs/design/pack-based-marketplace.md` to the final schema with
worked examples + the activation-control rules.

---

## Definition of done

- New schema implemented; old per-tool pack-scoped contribution parsing removed.
- Orphan / no-tool pack works through pack-bound surface auth.
- Market installed-pack UI exposes activation controls for roles/tools/skills/entrypoints only;
  entrypoint disabling persists and filters launcher/deep-link registration without disabling panels.
- Litmus packs migrated and green.
- `npm run check`, `npm run build` (incl. `build:packs`), `npm run test:unit`, `npm run test:e2e` pass.
- Docs + authoring guide reflect the final schema with worked examples + activation-control rules.
