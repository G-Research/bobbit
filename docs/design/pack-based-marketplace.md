# Pack-Based Marketplace — Design Document

Status: **implemented baseline + MCP extension**
Owner: Pack-Based Marketplace goal (`goal/pack-based-mar-6828576e`) plus Marketplace MCP goal
Scope: unify installable pack entities into one pack model, add the Market surface, and extend schema-2 packs/Marketplace sources to install MCP server contributions without replacing manual MCP config.

> This document is implementable on its own. It encodes the goal's *locked decisions verbatim* and is deliberately precise about the **legacy → unified-list mapping** (§6), which is the highest regression risk.

---

## 0. TL;DR / mental model

- A **pack is a directory** laid out like `defaults/`: `roles/`, `tools/`, `skills/`, plus schema-2 pack-scoped contributions such as `mcp/`, `providers/`, `entrypoints/`, and panels/routes.
- There is **ONE resolver** that walks **ONE ordered list of packs** low→high priority and produces resolved entities, each tagged with the pack it came from. **Precedence = position in the list.**
- **Everything is a pack** in that list:
  - **Builtin pack** — shipped `dist/server/defaults/` (read-only, lowest priority).
  - **User packs** — each scope's existing `roles/ tools/ skills/` dir; where create/customize writes, revert deletes.
  - **Market packs** — installed from a source into a scope's `market-packs/<pack-name>/`.
  - **Legacy-implicit packs** — the hard-coded skill scan dirs and user-registered `config_directories` mapped into list entries (back-compat).
- **Install** = copy a pack dir into a scope's `market-packs/` + write `.pack-meta.yaml`. **Uninstall** = delete the dir. **Update** = re-copy/re-pull.
- **MCP is now additive:** schema-2 packs may ship `mcp/<name>.yaml|yml|json`, and MCP Gateway sources (`type: "mcp-gateway"`) browse provider namespaces as virtual packs that materialize to the same layout. New `mcp-registry` source creation is rejected; persisted legacy registry rows are tolerated only as unsupported/removable compatibility rows. Manual `.mcp.json` and Claude-compatible MCP config remain supported and override Marketplace by runtime server name. AGENTS/CLAUDE.md prompt assembly remains out of scope.

The reframe must produce **byte-for-byte identical resolution** for roles/tools/skills versus today's `ConfigCascade` + `slash-skills.ts` + `config_directories`. The existing tests pin this.

---

## 1. Pack model & layout

### 1.1 What a pack is

A pack is a directory containing a **required `pack.yaml`** manifest plus an entity-payload subtree laid out exactly like Bobbit's `defaults/`:

```
<pack-dir>/
  pack.yaml                       # REQUIRED — a dir is a pack IFF this exists
  roles/<name>.yaml
  tools/<group>/{*.yaml, extension.ts, _shared/...}
  skills/<name>/SKILL.md
  mcp/<name>.yaml                 # schema-2 MCP server contributions listed in contents.mcp
  providers/<name>.yaml           # schema-2 provider contributions
  entrypoints/<name>.yaml         # pack-scoped launchers/deep-links
  panels/<name>.yaml              # auto-discovered support surfaces
```

**Discovery rule (single source of truth):** a directory is a pack **iff** it contains `pack.yaml`. Directories without one are ignored (e.g. a source repo's `README.md`, a `docs/` folder). The **builtin pack** and **legacy-implicit packs** are the only exceptions — they have an *implicit* manifest synthesised in code (no file on disk).

### 1.2 Marketplace source repo layout

A pack source is a git repo (or local dir) whose **top level is a collection of pack directories** — never a flat `defaults/` mirror. One repo may hold many packs. MCP Gateway sources are the supported non-pack source type: they discover provider namespaces from a streamable-HTTP MCP endpoint and materialize selected providers into normal installed pack directories. Official MCP Registry API URLs are legacy-only in Bobbit; new `mcp-registry` sources are rejected.

```
<source-repo-root>/
  research-pack/
    pack.yaml
    roles/researcher.yaml
    tools/research/{web-deep.yaml, extension.ts}
    skills/lit-review/SKILL.md
  qa-pack/
    pack.yaml
    roles/qa-runner.yaml
    tools/qa/...
  README.md                       # ignored (no pack.yaml)
```

### 1.3 Installation layout (per scope)

Installing copies a pack subtree verbatim into the chosen scope's `market-packs/<pack-name>/`, adding a generated `.pack-meta.yaml`. Each scope's own `roles/ tools/ skills/` IS that scope's **user pack**.

Every scope's **user-pack root is `<base>/.bobbit/config/`** and its **market-packs root is the sibling `<base>/.bobbit/config/market-packs/`**, where `base` is the homedir / server cwd / project root. This is *normalized across all three scopes* so install and resolution always derive the same root (see §1.3.1). `base` per scope: global-user = `~`, server = `<server-cwd>`, project = `<project>`.

```
dist/server/defaults/                       # BUILTIN PACK (read-only, lowest priority)
  roles/  tools/  skills/

~/.bobbit/config/                           # GLOBAL-USER scope
  roles/  tools/  skills/                    #   ← user pack (created/customized entities)
  market-packs/<pack-name>/...               #   ← installed market packs

<server-cwd>/.bobbit/config/                # SERVER scope
  roles/  tools/  skills/                    #   ← user pack
  market-packs/<pack-name>/...

<project>/.bobbit/config/                   # PROJECT scope (highest priority)
  roles/  tools/  skills/                    #   ← user pack
  market-packs/<pack-name>/...
```

#### 1.3.1 `scopeRoot` vs `userPackRoot` (resolved consistently)

To avoid install/resolution scanning different roots, the data model defines two derived paths **per scope** from a single `base`:

```ts
function scopePaths(scope, base): { userPackRoot: string; marketPacksRoot: string } {
  const cfg = path.join(base, ".bobbit", "config");      // = bobbit-dir.ts configDir(base)
  return { userPackRoot: cfg, marketPacksRoot: path.join(cfg, "market-packs") };
}
// global-user base = os.homedir(); server base = <server-cwd>; project base = <project root>
```

- `userPackRoot` is **exactly** the dir `RoleStore`/`ToolManager` already use today (`<base>/.bobbit/config`) for project and server scopes — so byte-identical roles/tools resolution holds (global-user is empty today). `buildPackList()` and `installPack()` both derive paths via `scopePaths`, never independently.
- **Reconciliation with the goal spec's illustrative layout:** the goal spec sketched server/global-user roots without the `/config` segment (`<server-cwd>/.bobbit/`, `~/.bobbit/`). We deliberately normalize to `<base>/.bobbit/config/` for all scopes because that is where the existing stores read/write; using the spec's bare paths would split install vs resolution roots and break byte-identical resolution. The Claude-compatible **skill** dirs (`~/.bobbit/skills`, `~/.claude/skills`, `<project>/.bobbit/skills`, `<project>/.claude/skills`, `<project>/.claude/commands`) are unaffected — they remain referenced in place as legacy-implicit entries (§6.2), not under `config/`.

### 1.4 `pack.yaml` schema

Authored by a pack publisher; copied verbatim on install.

```yaml
# pack.yaml — REQUIRED in every pack directory
name: research-pack              # REQUIRED. Unique pack id within a scope's market-packs/.
                                 #   [a-z0-9-]+; used as the install dir name.
description: >                   # REQUIRED. One-paragraph human summary (shown in browse UI).
  Deep-research role, web tools, and a literature-review skill.
version: 1.2.0                   # REQUIRED. Semver string. Informational + shown in provenance.
author: jane@example.com         # OPTIONAL.
homepage: https://...            # OPTIONAL.
# Declared contents — what the pack ships. REQUIRED. Drives the browse UI
# (declared-entity chips). All three keys MUST be present; each is an array
# that MAY be empty. The resolver loads whatever is physically present, but
# `contents` is the authoritative advertised manifest the UI renders.
# (No per-pack "executable code" gate keys off tools[]: trust is handled
#  once at the source-add boundary — see §10.2.)
contents:
  roles:  [researcher]
  tools:  [research]             # tool GROUP names (dir names under tools/)
  skills: [lit-review]
```

> **Pack-schema V1 addition.** `contents` also accepts an optional **`entrypoints: string[]`**
> key (basenames of `entrypoints/<name>.yaml` files), and `pack.yaml` accepts an optional
> top-level **`routes: { module, names }`** block. Both belong to the
> [Extension Host](extension-host-authoring.md); they extend (do not replace) the resolver
> schema below. Extension-Host **panels** are auto-discovered from `panels/*.yaml` and are not
> listed in `contents`; **stores** are implicit (no key); there is **no `permissions` key**.
> The authoritative schema is
> [pack-schema-v1-rationalisation.md](pack-schema-v1-rationalisation.md). The
> roles/tools/skills resolver semantics in this doc are unchanged.

TypeScript shape (parser output):

```ts
export interface PackManifest {
  name: string;
  description: string;
  version: string;
  author?: string;
  homepage?: string;
  schema?: number;            // absent/1 = baseline schema; 2 enables pack-scoped contribution keys
  contents: {
    roles: string[];
    tools: string[];          // tool group dir names
    skills: string[];
    entrypoints?: string[];   // Extension-Host entrypoints/<name>.yaml basenames
    providers?: string[];     // schema 2: providers/<name>.yaml
    mcp?: string[];           // schema 2: mcp/<name>.yaml|yml|json
    hooks?: string[];
    piExtensions?: string[];
    runtimes?: string[];
    workflows?: string[];
  };
  // V1: optional Extension-Host pack-level routes (see pack-schema-v1-rationalisation.md).
  routes?: { module?: string; names?: string[] };
}
```

Validation: `name` must match `/^[a-z0-9][a-z0-9-]*$/` (used as a directory name; reject path separators, `..`, leading dot — reuse `isSafeRelPath`-style guarding). `description` and `version` non-empty. `contents` REQUIRED with the `roles`/`tools`/`skills` array keys present (each may be empty); `contents.entrypoints` and the top-level `routes:` block are optional. Schema 1 disallows `contents.mcp`; schema 2 accepts it and each basename loads `mcp/<name>.yaml|yml|json` through strict Marketplace MCP validation. Other unknown top-level keys ignored (forward-compat). A pack whose `pack.yaml` is missing or fails validation is **skipped with a warning**, not fatal.

### 1.4.1 Marketplace MCP addendum

Marketplace MCP extends this design without changing the pack-as-directory invariant:

- Authored pack sources declare `schema: 2`, `contents.mcp: [<listName>]`, and one contribution file at `mcp/<listName>.yaml|yml|json`.
- MCP Gateway sources (`type: "mcp-gateway"`) browse provider namespaces discovered from the fixed streamable-HTTP MCP protocol shape (`initialize` + `tools/list`). Legacy `mcp-registry` rows are tolerated only as unsupported/removable persisted rows.
- Gateway provider packs are source-qualified (`mcp-<provider>-<source-slug>`) so the same provider id can be installed from multiple gateway sources in one scope. `.pack-meta.yaml` persists source id/name, provider id, gateway fingerprint, and operation metadata.
- Authored pack `listName` remains the activation identity for authored MCP packs. Gateway installs derive a stable contribution id from source/install/provider/list/runtime identity for `DisabledRefs.mcp` and `DisabledRefs.mcpOperations`, so activation never leaks across sources with the same list name.
- Marketplace MCP is lower priority than manual config for route conflicts. Existing custom config directories, Claude-compatible files, project `.mcp.json`, and project `.bobbit/config/mcp.json` are still read by `McpManager`; manual routes win when the public operation name collides.
- Activation is contribution and operation level. `DisabledRefs.mcp` omits the contribution before connection. `DisabledRefs.mcpOperations[contributionId]` omits selected gateway operations while keeping disabled/stale rows visible in the unfiltered activation catalogue.
- Runtime managers are scoped by default/project/cwd context. Gateway contributions keep readable public server/sub-namespace policy names but group clients by source-qualified runtime keys, exposing the union of selected operations across sources. Marketplace mutations reload affected managers, disconnect removed servers, keep unchanged connections, rebuild route maps, refresh ToolManager external MCP registrations, and return contextual `mcpReload` status. `GET /api/mcp-servers` is status/policy-key data only; toggle state comes from the unfiltered activation catalogue.
- Trust remains source-level: stdio MCP is host-tier code, HTTP MCP is a trusted remote endpoint, and status payloads redact secret values.

See [Marketplace MCP](../marketplace.md#marketplace-mcp) and [MCP meta-tool aggregation](../mcp-meta-tools.md#marketplace-mcp-and-scoped-managers) for the current user/developer reference.

### 1.5 `.pack-meta.yaml` schema

Generated at install time **inside the installed pack dir**. Records provenance. Never authored by publishers.

```yaml
# .pack-meta.yaml — generated at install (do not hand-edit)
sourceUrl: https://github.com/acme/bobbit-packs.git  # origin source (git URL or local path)
sourceRef: main                  # branch/tag requested
commit: 9f3c1a8                  # resolved commit SHA at install/update (empty for local-dir sources)
packName: research-pack          # echoes pack.yaml name (sanity / rename detection)
version: 1.2.0                   # echoes pack.yaml version at install time
installedAt: 2026-06-03T10:21:00Z
updatedAt: 2026-06-03T10:21:00Z  # equals installedAt until first update
scope: project                   # "global-user" | "server" | "project"
```

```ts
export interface PackMeta {
  sourceUrl: string;
  sourceRef: string;
  commit: string;
  packName: string;
  version: string;
  installedAt: string;  // ISO-8601
  updatedAt: string;    // ISO-8601
  scope: PackScope;
}
```

> The pack dir + its `.pack-meta.yaml` IS the install record. **No separate per-entity provenance ledger.** Uninstall = delete the dir.

---

## 2. The single resolver — one pipeline, pluggable loaders

### 2.1 Ordered list data structure

```ts
export type PackScope = "builtin" | "global-user" | "server" | "project";
export type PackKind  = "builtin" | "user" | "market" | "legacy-implicit";

/** One entry in the single ordered pack list. */
export interface PackEntry {
  id: string;                 // stable id: builtin | user:<scope> | market:<scope>:<name> | legacy:<hash>
  kind: PackKind;
  scope: PackScope;
  path: string;               // absolute dir whose roles/ tools/ skills/ subtree is loaded
  readOnly: boolean;          // builtin + legacy-implicit + claude-compat dirs ⇒ true
  manifest?: PackManifest;    // present for market packs (+ synthesised for builtin)
  meta?: PackMeta;            // present for installed market packs
  /** For legacy-implicit skill dirs: restrict which entity types this entry contributes. */
  onlyTypes?: EntityType[];   // e.g. ["skills"] for .claude/skills
  /** Layout flavour: how to read this dir. */
  layout: "defaults-tree" | "skills-flat" | "commands-flat";
}
```

`layout` distinguishes the three physical shapes the resolver must read:
- `defaults-tree` — the canonical pack/`defaults/` shape (`roles/`, `tools/<group>/`, `skills/<name>/SKILL.md`). Used by builtin, user packs, market packs, and the `.bobbit/skills` / `~/.bobbit/skills` / `.claude/skills` / `~/.claude/skills` skill dirs *(see note below)*.
- `skills-flat` — a directory that is itself a `skills/` root, i.e. `<dir>/<name>/SKILL.md` (the hard-coded skill scan dirs and user `config_directories` skill entries point directly at a skills root, not a pack root).
- `commands-flat` — `.claude/commands/*.md` (legacy slash commands).

> Most legacy skill dirs are `skills-flat`: the path *is* the skills root. A pack's `skills/` is one level deeper. This is why `layout` exists rather than forcing every legacy dir to look like a full pack.

### 2.2 Loader interface (pluggable, type-specific)

The pipeline owns ordering/precedence/origin. Each entity type plugs in a loader that knows how to read its files from a pack entry. Adding `mcp/` or a future `panels/` type is **adding a loader**, not touching the ordering core.

```ts
export type EntityType = "roles" | "tools" | "skills"; // + "mcp" | "panels" later

/** A loaded entity before precedence merge. */
export interface LoadedEntity<T> {
  name: string;          // merge key (unique within a type)
  item: T;               // the parsed entity (Role | ToolInfo | SlashSkill | ...)
}

/** Type-specific reader. Pure: (entry) → entities. No precedence logic here. */
export interface EntityLoader<T> {
  type: EntityType;
  /** Does this loader run for this entry's layout? e.g. skills loader handles all
   *  three layouts; roles/tools loaders only handle defaults-tree. */
  supports(entry: PackEntry): boolean;
  load(entry: PackEntry): LoadedEntity<T>[];
}
```

> **Non-installable `ConfigCascade` types stay on the existing path.** `ConfigCascade` today resolves four things: roles, tools, **workflows**, and **tool-group policies**. Only **roles and tools** are migrated to route through `PackResolver` (via the loaders below). `ConfigCascade.resolveWorkflows` and `ConfigCascade.resolveToolGroupPolicies` are **left untouched** — they keep their current implementations and are NOT routed through the pack resolver (there are no workflow/policy loaders). Practically, `ConfigCascade` retains those two methods unchanged while `resolveRoles`/`resolveTools` become adapters over `PackResolver`. This prevents accidentally routing a type that has no loader into the resolver, and preserves byte-identical workflow/policy resolution.

Concrete loaders (MVP):
- `RoleLoader` — reads `<path>/roles/*.yaml` (only `defaults-tree`). Parsing reuses the YAML→`Role` logic currently in `BuiltinConfigProvider.loadRoles` / `RoleStore` (factor into a shared `parseRoleYaml`).
- `ToolLoader` — reads `<path>/tools/<group>/*.yaml` + flat `<path>/tools/*.yaml` (only `defaults-tree`). Reuses `BuiltinConfigProvider.loadTools` grouped+flat two-pass logic into a shared `parseToolsDir`. Tool **extension.ts / _shared** code travels with the dir on install but is loaded by the existing tool-execution machinery, not the resolver.
- `SkillLoader` — reads SKILL.md/commands. Handles all three layouts:
  - `defaults-tree` → scan `<path>/skills/` (each subdir's `SKILL.md`).
  - `skills-flat` → scan `<path>/` directly (each subdir's `SKILL.md`).
  - `commands-flat` → scan `<path>/*.md`.
  Reuses `scanSkillDir` / `scanCommandsDir` / `parseFrontmatter` from `slash-skills.ts`.

### 2.3 The pipeline (one resolver, not several)

```ts
export interface ResolvedEntity<T> {
  item: T;
  origin: PackEntry;          // the winning pack
  shadows: PackEntry[];       // lower-priority packs that defined the same name (for conflict UI)
}

export class PackResolver {
  constructor(private entries: PackEntry[], private loaders: EntityLoader<any>[]) {}

  /** entries are ordered low→high priority. */
  resolve<T>(type: EntityType): ResolvedEntity<T>[] {
    const byName = new Map<string, ResolvedEntity<T>>();
    for (const entry of this.entries) {                 // low → high
      if (entry.onlyTypes && !entry.onlyTypes.includes(type)) continue;
      for (const loader of this.loaders) {
        if (loader.type !== type || !loader.supports(entry)) continue;
        for (const { name, item } of loader.load(entry)) {
          const prev = byName.get(name);
          byName.set(name, {
            item,
            origin: entry,
            shadows: prev ? [...prev.shadows, prev.origin] : [],
          });
        }
      }
    }
    return [...byName.values()];
  }
}
```

Key properties:
- **One traversal, all types.** Same ordered list, same shadow rule, for roles/tools/skills (and future types).
- A later (higher-priority) entry **shadows** an earlier same-name entry. The shadowed entries are retained in `shadows[]` so the marketplace manager can render conflict warnings (§4) and the config pages can render `origin`/`overrides` badges (§5).
- This is the **single** resolver. `ConfigCascade.resolveRoles`/`resolveTools` and `discoverSlashSkills` become thin adapters over it (§6). `ConfigCascade.resolveWorkflows`/`resolveToolGroupPolicies` are **not** adapted — those non-installable types keep their existing implementations (§2.2 note); there are no workflow/policy loaders.

---

## 3. Scope order & within-scope ordering

### 3.1 Base scope order (LOCKED)

```
builtin  <  server  <  global-user  <  project
```

Lowest → highest priority. Project wins; a user's machine-wide (global-user) packs beat a shared server install; builtin is lowest.

> ⚠️ Naming reconciliation: today's `ConfigResolver`/`ConfigCascade` uses the order **builtin < server < project** and treats "global" as a *tier* (`~/.bobbit`). The locked order inserts **global-user between server and project**. This matches `config-resolver.ts`'s documented intent (`global → server → project` for entities) **except** the cascade currently only wires builtin/server/project for roles+tools. The unified list makes global-user a first-class segment. **Back-compat is preserved because today no roles/tools are resolved from `~/.bobbit/{roles,tools}` at all** (the cascade never reads them) — so adding the global-user segment below project and above server cannot change any *currently-resolved* role/tool. For skills, `~/.claude/skills` and `~/.bobbit/skills` are personal (global-user) and today sit *below* project skills — preserved (see §6).

### 3.2 Within-scope ordering

Within a single scope segment, entries are ordered low→high as:

```
[ market packs, in pack_order ]  <  [ user pack ]  <  [ legacy-implicit skill dirs (skills only) ]
```

Rationale and rules:
- **User-authored content is the HIGHEST writable layer within its scope.** The user pack sits **above** market packs in the same scope. This is required to keep customize/revert reliable: customizing an entity writes into the scope's user pack, which then shadows any market pack in that scope; reverting deletes the user-pack file and the market entity reappears. (Cross-scope, a higher scope still wins overall — a project user pack beats a server market pack because the whole project segment is above the whole server segment.)

  > Worked: a project-scope market pack ships role `researcher`. The user customizes it → a file is written to `<project>/.bobbit/config/roles/researcher.yaml` (the project user pack), which is above the market pack in the project segment → the customization wins. Revert deletes that file → the market pack's `researcher` resolves again. No precedence ambiguity.
- **Market vs market within a scope:** ordered by the scope's **`pack_order`** list (§3.3) — default is install order (oldest first ⇒ lowest priority; newest install shadows older). User-reorderable; this is the sole configured conflict-resolution mechanism in MVP.
- **Legacy-implicit entries** slot into the scope segment that matches their physical location (§6.2): project-scoped legacy dirs into the project segment, personal/home dirs into global-user. They are skills-only (`onlyTypes:["skills"]`) and placed **above** the user pack within their segment, exactly reproducing today's "project/personal skills beat everything" precedence (see the exact placement table in §6.2). For skills there is no separate writable "user pack" today — the legacy skill dirs *are* the user-authored skill content, so their §6.2 order is authoritative and unchanged.

### 3.3 Precedence-config persistence

**MVP ships exactly ONE configured conflict-resolution mechanism: `pack_order`** — per-scope ordering of market packs. Persisted in **project config (`project.yaml`) for project scope**, and in **server config (`<server-cwd>/.bobbit/config/project.yaml`)** for server/global scope (reusing the existing `ProjectConfigStore` surface):

**Persistence shape (scoped, not flat).** `pack_order` is a map keyed by scope so independent scopes never collide — critical because **server and global-user both persist in the server config file** and could otherwise not be represented separately:

```yaml
# Persisted as a migrated native-YAML field (mirror config_directories side-table).
# Each scope's market-pack order, highest priority LAST. Unknown/uninstalled names ignored.
pack_order:
  server:      [shared-pack]
  global-user: [research-pack, qa-pack]
  project:     [research-pack]
```

- **Where each scope's order lives:** the `project` key persists in `<project>/.bobbit/config/project.yaml`; the `server` and `global-user` keys persist in the **server config** (`<server-cwd>/.bobbit/config/project.yaml`) under the same `pack_order` map but distinct keys, so the two share a file yet stay independent. `buildPackList()` reads each scope's order from the correct store.
- `pack_order[scope]` is the **sole** conflict mechanism: reorder market packs within a scope (mirrors the existing project drag-reorder pattern). Implemented as a new migrated field on `ProjectConfigStore` (follow the `config_directories` native-YAML side-table precedent — see `project-config-store.ts`). The last entry has highest priority within the scope's market-pack band. A name present in `market-packs/` but absent from `pack_order[scope]` defaults to lowest priority (sorted before listed entries, by install order); a name in `pack_order[scope]` not on disk is ignored.
- Read/write over REST via `GET/PUT /api/marketplace/pack-order` (§9.2).
- Resolution of a same-name conflict is therefore deterministic from the ordered list alone — no per-conflict override pass exists in MVP. The UI's only conflict-resolution affordance is **reorder** (drag market packs). Customizing (writing into the user pack, which sits above market packs — §3.2) is the other way a user can force a winner.
- **Per-conflict pinning (`pack_conflicts`) is explicitly DEFERRED** (see §11 Deferred). It is NOT in the MVP schema, resolver, API, UI, or tests. The `PackResolver` performs no pin post-pass. The deferred section sketches the future schema so it is additive.

---

## 4. Same-name conflict handling

A **conflict** exists for `(type, name)` whenever `resolve(type)` returns a `ResolvedEntity` with non-empty `shadows[]`.

- The marketplace manager renders a **warning icon** next to any installed pack that participates in a conflict (it either shadows, or is shadowed by, another pack). Hover/expand shows: entity type + name, winner pack, shadowed pack(s).
- The config pages (Roles/Tools/Skills) already show `origin`/`overrides` badges; the same data drives a conflict affordance there (the `overrides` badge already communicates a shadow).
- Resolution mechanism (MVP): the user adjusts `pack_order` (drag-reorder market packs within a scope), or customizes the entity (writes into the scope's user pack, which sits above market packs — §3.2). After either, re-resolve and the warning clears or moves. Per-conflict pinning is deferred (§11).
- A new endpoint `GET /api/packs/conflicts?projectId=` returns the conflict list for the UI (§9).

> Builtin-vs-user "conflicts" are NOT flagged as warnings — that's the normal customize/override flow (a user pack intentionally shadowing builtin). Only **market-pack-involved** shadows raise the warning icon, to avoid noise on every customized role.

---

## 5. Builtin & user-pack mechanics

### 5.1 Builtin pack

- The shipped `dist/server/defaults/` tree becomes the read-only builtin `PackEntry`:
  ```ts
  { id: "builtin", kind: "builtin", scope: "builtin", readOnly: true,
    path: <BuiltinConfigProvider.builtinsDir>, layout: "defaults-tree",
    manifest: { name: "builtin", description: "Bobbit built-ins", version: <app version>, contents: {...} } }
  ```
- `BuiltinConfigProvider` is retained as the *reader* the `RoleLoader`/`ToolLoader` delegate to for this entry (or its parse helpers are extracted; either way the byte-identical parse logic is reused). Builtin skills (`defaults/skills/`) load via `SkillLoader` with `layout: "defaults-tree"`.

### 5.2 User packs

- Each scope's user pack is its `userPackRoot` (§1.3.1): project `<project>/.bobbit/config/`, server `<server-cwd>/.bobbit/config/`, global-user `~/.bobbit/config/` (NEW for roles/tools — §3.1 note; harmless because nothing reads it today).
- **Create/customize** = write the entity file into the scope's user-pack dir (exactly what `RoleStore.put` / `ToolManager` / the `customize` endpoints do today). **Revert** = delete it (`RoleStore.remove` / the `override` DELETE endpoints). No new file operations — the customize/override endpoints keep their current bodies (see `server.ts` `/api/roles/:name/customize` and `/override`).
- **Origin wire contract (LOCKED — option (b)).** The `ConfigOrigin` enum gains a `user` value. The API maps `ResolvedEntity.origin.scope` → wire `origin`, and the topmost shadowed scope → `overrides`:

  | `origin.scope` (winner) | wire `origin` |
  |---|---|
  | `builtin` | `builtin` |
  | `server` | `server` |
  | `global-user` | `user` |
  | `project` | `project` |

  > `config-scope.ts::ConfigOrigin` is extended to `"builtin" | "server" | "user" | "project"` with a matching badge class. This is a small additive UI change (config pages render badges generically). A test pins the mapping (§12). Because global-user is empty for roles/tools today, no *existing* response value changes — `user` only ever appears for newly-installed global-user packs.
- **Pack-origin tagging (acceptance: entities tagged with the *specific pack*).** Beyond the scope badge, `/api/roles|tools|skills` responses carry, for market-pack-originated entities, `originPackId` (`PackEntry.id`, e.g. `market:project:research-pack`) and `originPackName` (the pack's `name`). For builtin/user-pack entities these are `null`. The config pages render `originPackName` as a chip/tooltip next to the scope badge so an installed entity is visibly and contractually tied to its pack (not just its scope). Pinned by an E2E assertion (§12.3 #4).

---

## 6. THE CRUX — legacy → unified-list mapping

This section defines exactly how today's two installable-type resolvers collapse into the single ordered list while preserving **byte-identical resolution**. `mcp-manager.ts` and `system-prompt.ts` are **NOT** part of this mapping.

### 6.1 Roles & tools (from `ConfigCascade`)

Today `ConfigCascade.resolve<T>` merges three layers by name: builtins → server stores → project store, tagging `origin` and `overrides`. Map to list entries (low→high):

| Order | PackEntry | path | layout | readOnly |
|---|---|---|---|---|
| 1 | `builtin` | `dist/server/defaults/` | defaults-tree | yes |
| 2 | `user:server` | `<server-cwd>/.bobbit/config/` | defaults-tree | no |
| 3 | `user:global-user` | `~/.bobbit/` | defaults-tree | no *(empty today)* |
| 4 | `user:project` | `<project>/.bobbit/config/` | defaults-tree | no |

- Resolution is identical because: builtin lowest, server next, project highest — exactly the cascade's three layers. The new global-user entry (3) is **empty today** for roles/tools (no code writes there), so it cannot change current output.
- Market packs (when present) interleave **within** each scope segment, user-pack-below-market (§3.2). With zero market packs installed (the only state the existing tests exercise), the list is exactly the four rows above ⇒ identical merge ⇒ `config-cascade.test.ts` passes unchanged.
- `origin`/`overrides`: derive from `origin.scope` + top of `shadows[]` per §5.2 mapping. For the existing builtin/server/project cases this yields exactly today's values, so `config-cascade-api.spec.ts` and `config-scope.spec.ts` pass.

### 6.2 Skills (from `slash-skills.ts`)

Today `discoverSlashSkills` merges, lowest→highest:

```
BUILTIN_SKILLS (the in-code "compact" entry)
→ builtin-file (defaults/skills/)
→ custom (config_directories skills entries)
→ legacy (.claude/commands/)
→ bobbit personal (~/.bobbit/skills)
→ claude personal (~/.claude/skills)
→ bobbit project (.bobbit/skills)
→ claude project (.claude/skills)
```

Map to PackEntries (low→high) — **the order above is preserved exactly**:

| Order | PackEntry id | path | layout | scope | onlyTypes | readOnly |
|---|---|---|---|---|---|---|
| 1 | `builtin-skills-static` | (in-code) | — | builtin | skills | yes |
| 2 | `builtin` (skills) | `dist/server/defaults/skills` | defaults-tree* | builtin | skills | yes |
| 3 | `legacy:custom:<path>` (per `config_directories` skills entry) | user dir | skills-flat | (by location) | skills | yes |
| 4 | `legacy:.claude/commands` | `<cwd>/.claude/commands` | commands-flat | project | skills | yes |
| 5 | `legacy:~/.bobbit/skills` | `~/.bobbit/skills` | skills-flat | global-user | skills | yes |
| 6 | `legacy:~/.claude/skills` | `~/.claude/skills` | skills-flat | global-user | skills | yes |
| 7 | `legacy:.bobbit/skills` | `<cwd>/.bobbit/skills` | skills-flat | project | skills | yes |
| 8 | `legacy:.claude/skills` | `<cwd>/.claude/skills` | skills-flat | project | skills | yes |

\* The builtin pack's own `skills/` subtree is loaded via the shared builtin entry (row 2 in §6.1) restricted to skills; listed separately here for clarity of order.

Critical correctness notes:
- **`onlyTypes: ["skills"]`** on every legacy-implicit entry means the role/tool loaders never run on them — they only ever contributed skills, and that must not change.
- **Claude-compatible dirs stay where they are.** `.claude/skills`, `~/.claude/skills`, `.bobbit/skills`, `~/.bobbit/skills`, `.claude/commands` are *referenced* as `readOnly` legacy-implicit packs, **never moved or copied**. Cross-tool compatibility (Claude Code reading the same files) is preserved.
- The relative order of these 8 entries is **identical** to today's insertion order in `discoverSlashSkills`, so `Map`-overwrite precedence is byte-identical ⇒ `skill-resolve.test.ts`, `validate-skill-discovery.test.ts`, `skill-manifest.test.ts`, `slash-skill-e2e.spec.ts` pass.
- The TTL cache, `userInvocable` filtering, and alphabetical sort in `discoverSlashSkills` move into the skills adapter (§6.4), unchanged.

### 6.3 `disabled_config_directories`

**Status of `disabled_config_directories` today (verified in source):** it is only *written* (`removeBuiltinDirectory`) and *cleared* (`resetConfigDirectories`); **no resolution code path reads it to omit a directory.** `discoverSlashSkills`, `getSkillDirectories`, and `getAllConfigDirectories` do **not** filter by it — so disabling a built-in skill dir today is an **inert no-op for resolution** (the dir still resolves). The goal spec's worked example #3 ("`slash-skills.ts` skips it") describes *intended* behavior, not current behavior.

**Decision (explicit — NOT framed as byte-identical):** the unified resolver **honors** `disabled_config_directories` — a matching legacy-implicit `PackEntry` is **omitted** from the ordered list before resolution (path comparison via the same `expandPath`/`path.resolve` normalization). This is a **deliberate, documented fix** of a currently-inert setting, scoped to skills' legacy dirs.

- **Why this does not break the byte-identical invariant:** that invariant covers all *currently-resolved* inputs. No existing test pins "a disabled dir still resolves" (it can't — disablement was inert and the dir resolved regardless). The only behavior that changes is the previously-impossible case where a dir is *both* disabled *and* present — not exercised by any existing test — so `skill-resolve.test.ts` / `validate-skill-discovery.test.ts` / `per-project-config-dirs.spec.ts` continue to pass unchanged.
- **New coverage required:** add a unit test asserting a disabled skill dir is now omitted from resolution (unit #6), and a compatibility note in the changelog/docs. The acceptance/tests do **not** claim byte-identical for this case — they claim "deliberate enforcement, newly tested."

### 6.4 Refactor of `slash-skills.ts`

- `discoverSlashSkills(cwd, projectConfigStore)` is reimplemented as a thin adapter:
  1. Build the skills segment of the ordered list (rows 1–8 above + any market packs' `skills/`) via a shared `buildPackList(cwd, store, scope)` (§6.5).
  2. `packResolver.resolve<SlashSkill>("skills")`.
  3. Apply `userInvocable !== false` filter + alphabetical sort + TTL cache (unchanged).
  4. Return `SlashSkill[]` — the `source` field is derived from `origin.kind`/`origin.id` to keep the existing `"project"|"personal"|"legacy"|"built-in"|"custom"` values for API/UI back-compat.
- `getSkillDirectories(cwd, store)` returns the same shape as today, now computed from the list entries (so `/api/skills` `directories` payload is unchanged).
- **No skills code path scans directories independently of the resolver afterward.**

### 6.5 Building the unified list (single entry point)

```ts
/** Build the one ordered list for a given resolution context, low→high priority. */
export function buildPackList(opts: {
  builtinsDir: string;              // dist/server/defaults
  // Per-scope roots derived via scopePaths() (§1.3.1). Each yields
  // { userPackRoot=<base>/.bobbit/config, marketPacksRoot=<base>/.bobbit/config/market-packs }.
  serverBase: string;               // <server-cwd>
  globalUserBase: string;           // os.homedir()
  projectBase?: string;             // <project root>  (omitted in system scope)
  cwd: string;                      // project rootPath (for legacy .claude/*, .bobbit/* skill dirs)
  serverConfigStore: ProjectConfigReader;   // reads pack_order.{server,global-user} + legacy keys
  projectConfigStore?: ProjectConfigReader; // reads pack_order.project + legacy keys (project scope)
}): PackEntry[];
```

Steps (low→high):
1. Push `builtin` (`builtinsDir`).
2. For each scope in `[server, global-user, project]` (in that order), using `scopePaths(scope, base)`:
   a. push the scope's `market-packs/*` entries — each `<marketPacksRoot>/*` dir that has **both** a valid `pack.yaml` and a valid `.pack-meta.yaml` (§8.1 corrupt-guard; `.tmp-*` skipped) — ordered by that scope's `pack_order[scope]`.
   b. push the scope's user-pack entry (`userPackRoot`).
   c. push the scope's legacy-implicit skill entries (rows from §6.2 that belong to this scope).
3. Apply within-scope ordering rules (§3.2): market packs lowest, then user pack, then legacy skill entries — reproducing §6.2's exact order for skills.
4. Remove any entry whose path is in `disabled_config_directories` (§6.3, deliberate enforcement).
5. Read `config_directories` (legacy key, via `parseCustomDirectories`) and insert skills entries as `legacy:custom:<path>` at the position from §6.2 row 3.

> **Back-compat invariant:** the legacy keys `config_directories`, `skill_directories`, `disabled_config_directories` keep being **read** (via the existing `config-directories.ts` helpers) **only** to construct this list. After construction, no roles/tools/skills code path scans dirs on its own.

### 6.6 Worked examples (must resolve identically)

**1. Project override of a builtin role.**
- Today: builtin `coder` at `dist/server/defaults/roles/coder.yaml`; project override at `<project>/.bobbit/config/roles/coder.yaml`; cascade → project wins, `origin=project, overrides=builtin`.
- Unified: list = `[builtin, …, user:project]`. Resolver: builtin loads `coder`, `user:project` loads `coder` and shadows it. `origin.scope=project`, `shadows=[builtin]` ⇒ badge `origin=project, overrides=builtin`. Revert = delete project user-pack file. ✅ identical.

**2. User-registered custom skills directory (`config_directories`).**
- Today: `config_directories: [{ path: "~/dev/my-skills", types: ["skills"] }]`; `slash-skills.ts` scans it at the `custom` precedence slot.
- Unified: on `buildPackList`, that entry → `legacy:custom:/home/u/dev/my-skills`, `layout: skills-flat`, `onlyTypes:["skills"]`, inserted at §6.2 row 3. Its `SKILL.md`s load via `SkillLoader`. Same skills, same precedence (above builtin-file, below legacy/personal/project). ✅ identical.

**3. Disabled built-in scan location.** *(Deliberate behavior fix — see §6.3; not byte-identical.)*
- Today: `disabled_config_directories` contains `<project>/.claude/skills`. This is currently **inert for resolution** — the dir's skills still resolve (no code reads the disable list to omit it).
- Unified: the `legacy:.claude/skills` entry is omitted from the list (§6.3) ⇒ nothing from it resolves. This **matches the goal spec's intended behavior** and is the one place the reframe deliberately changes (previously-inert) behavior, covered by new unit test #6. All currently-pinned skill resolution is unchanged.

**4. Claude-compatible personal skills (`~/.claude/skills`, `~/.bobbit/skills`).**
- Today: scanned at personal scope by `slash-skills.ts`.
- Unified: pre-registered as `legacy:~/.claude/skills` / `legacy:~/.bobbit/skills` at the global-user position; still discovered; files stay in place (referenced, not moved) so Claude Code still sees them. MCP's own Claude-compatible locations are untouched (still read by `mcp-manager.ts`). ✅ identical.

---

## 7. Source registry

### 7.1 Persistence

Marketplace **source URLs** are a small registry. Sources are **global** to the server (not per-project): a registered source can be browsed and installed into any scope. A source is either a pack source (git/local pack collection) or an MCP Gateway endpoint. Persisted legacy `mcp-registry` rows are loaded only so old config files remain removable; they are unsupported for sync/browse/install/update.

```
<server-cwd>/.bobbit/config/marketplace-sources.yaml
```

```yaml
# marketplace-sources.yaml
sources:
  - id: acme                       # stable id ([a-z0-9-]+), unique
    type: pack                     # default when omitted
    url: https://github.com/acme/bobbit-packs.git   # git URL OR absolute local dir path
    ref: main                      # branch/tag (pack sources only; default: remote HEAD)
    addedAt: 2026-06-03T10:00:00Z
    lastSyncedAt: 2026-06-03T10:05:00Z
    lastCommit: 9f3c1a8            # pack git sources only
  - id: mcp-local-t3-zone-readonly-mcp
    type: mcp-gateway
    url: http://mcp-local.t3.zone/readonly/mcp
    displayName: mcp-local.t3.zone/readonly/mcp
    normalizedName: mcp-local.t3.zone/readonly/mcp
    addedAt: 2026-06-03T10:10:00Z
    lastSyncedAt: 2026-06-03T10:11:00Z
```

```ts
export type MarketplaceSourceType = "pack" | "mcp-gateway";
export type StoredMarketplaceSourceType = MarketplaceSourceType | "mcp-registry"; // legacy unsupported rows only
export interface MarketplaceSource {
  id: string;
  type?: StoredMarketplaceSourceType; // omitted = "pack" for backward compatibility
  url: string;                       // pack: git/local; gateway: HTTP(S) MCP endpoint
  displayName?: string;              // MCP Gateway readable name, with deterministic duplicate suffix
  normalizedName?: string;           // MCP Gateway authority/path before duplicate suffixing
  ref?: string;                      // pack sources only
  addedAt: string;
  trustedAt?: string;
  lastSyncedAt?: string;
  lastCommit?: string;               // pack git sources only
  unsupportedReason?: string;        // response-only for legacy mcp-registry rows
  lastError?: string;
}
export class MarketplaceSourceStore { /* CRUD + load/save YAML, mirrors RoleStore patterns */ }
```

### 7.2 Source sync

- Pack sources are synced into a server-local cache before browse/install:
  ```
  <server-cwd>/.bobbit/state/marketplace-cache/<source-id>/
  ```
- **Local-dir pack sources** (`type: "pack"`, `url` is an absolute path): no clone; read directly. `commit` recorded as empty.
- **Git pack sources:** **shallow clone** (`git clone --depth 1 --branch <ref> <url> <cache-dir>`); re-sync via `git fetch --depth 1 && git reset --hard origin/<ref>` (or re-clone if the cache is dirty/missing). Resolve and record `lastCommit` via `git rev-parse HEAD`.
- **MCP Gateway sources:** bounded HTTP(S) streamable-MCP discovery (`initialize` + `tools/list`) against the configured endpoint; compute/store source sync state and materialization fingerprints from discovered provider/operation metadata. Gateway URLs are named from normalized authority + path, excluding protocol/query/hash and trimming trailing slashes. Invalid gateways fail sync/browse for that source only.
- **Legacy `mcp-registry` rows:** new creation is rejected. Persisted rows may be listed with `unsupportedReason`, but sync/browse/install/update fail safely with an unsupported-source error.
- **Private repos:** rely on the user's ambient git credentials (credential helper / SSH agent) exactly as Bobbit's worktree/clone code does today. No credential storage in the marketplace. Gateway sources must not persist secrets in diagnostics.
- Sync is invoked on: add-source, explicit "re-sync", and implicitly before browse if the cache/fingerprint is missing. Surface source-specific errors to the UI (`git` stderr for pack git sources; gateway discovery errors for MCP Gateway sources).

### 7.3 Browsing

`browsePacks(sourceId)`: sync (if needed), then branch by source type:

- **Pack sources:** scan the cache/source root one level deep → for each subdir with a `pack.yaml`, parse the manifest → return `BrowsePackWire[]` with `dirName` equal to the source directory name. Directories without `pack.yaml` are ignored.
- **MCP Gateway sources:** map each supported provider namespace to a virtual `BrowsePackWire` with a source-qualified `dirName`, generated schema-2 manifest entries in `contents.mcp`, and gateway diagnostics/provenance attached to the row/source response. Installing that row materializes a normal pack directory before copying it into the target scope.
- **Legacy `mcp-registry` rows:** return an unsupported-source error/status rather than virtual packs.

---

## 8. Install / uninstall / update file operations

All operations are plain directory copies/deletes (no per-entity bookkeeping).

### 8.1 Install

`installPack(sourceId, dirName, scope)` — **atomic**: build a complete staged dir, then a single rename publishes it. The client sends the `dirName` returned by browse; for gateway rows this is the source-qualified virtual pack name.
1. Sync source (§7.2).
2. Resolve install input by source type:
   - Pack source: `src = <cache-or-local-source>/<dirName>` (must contain a valid `pack.yaml` — else 422).
   - MCP Gateway source: `dirName` must match a valid browsed provider virtual pack; materialize a temporary schema-2 pack containing `pack.yaml`, `mcp/<listName>.yaml`, and gateway provenance/operation metadata.
3. Resolve `dest = <marketPacksRoot>/<dirName>` where `marketPacksRoot = scopePaths(scope, base).marketPacksRoot` (§1.3.1) — i.e. `<base>/.bobbit/config/market-packs` with `base` = `~` | `<server-cwd>` | `<project root>`. Same derivation `buildPackList` uses, so install and resolution never diverge. Reject unsafe `dirName` (path-traversal guard) before any fs op.
4. Reject if `dest` already exists (require explicit update/uninstall) → 409.
5. **Copy `src` / materialized pack → a staging dir** `<marketPacksRoot>/.tmp-<dirName>-<rand>` verbatim (entire subtree: `pack.yaml`, `roles/`, `tools/` incl. `extension.ts` + `_shared`, `skills/`, `mcp/`, and other schema-2 contribution dirs). Skip `.git`.
6. Write `<staging>/.pack-meta.yaml` (§1.5) with `sourceUrl`, `sourceRef`, resolved `commit` or gateway fingerprint, `packName`/`version` from manifest, `installedAt = updatedAt = now`, `scope`, and gateway provider/operation metadata when applicable.
7. **Atomically rename** staging → `dest` (`fs.rename`). Only after the meta is written does the pack become visible at its final path. On any failure before the rename, `fs.rm` the staging dir and surface the error — `dest` never half-exists.
8. Append `dirName` to that scope's `pack_order`.
9. Trigger a resolver/MCP reload for the affected scope so entities appear immediately.

> **Partial-install / corruption guard.** The resolver treats a `market-packs/<name>/` dir as an installed market pack **only if** it contains BOTH a valid `pack.yaml` and a valid `.pack-meta.yaml`. A dir missing/with-invalid `.pack-meta.yaml` (e.g. a crash mid-copy, or a stray `.tmp-*` staging dir) is **ignored for resolution** and reported as `corrupt` in `GET /api/marketplace/installed` so the UI can offer re-install/cleanup. `.tmp-*` staging dirs are never scanned as packs.

### 8.2 Uninstall

`uninstallPack(scope, packName)`:
1. `dest = scopePaths(scope, base).marketPacksRoot + "/" + packName` (§1.3.1).
2. **`fs.rm(dest, { recursive: true })`** — deletes exactly what install added.
3. Remove `packName` from that scope's `pack_order`.
4. Reload resolver. Uninstalling removes precisely the installed entities (no orphan ledger to reconcile).

### 8.3 Update

`updatePack(scope, packName)`:
1. Read `dest/.pack-meta.yaml` for `sourceUrl`/`sourceRef` and source type/provenance.
2. Re-sync the source (§7.2); re-resolve the pack source `commit` or gateway fingerprint/materialized entry.
3. **Replace** `dest` atomically: copy the fresh `src` subtree or materialized gateway pack into a `.tmp-*` staging dir, write the updated `.pack-meta.yaml` into staging, then swap (rename old `dest` aside → rename staging → `dest` → `fs.rm` the old). Preserve nothing stale; on failure the original `dest` is left intact.
4. Updated `.pack-meta.yaml` carries new `commit`/gateway fingerprint, `version`, and `updatedAt = now` (keep original `installedAt`, copied from the old meta).
5. Reload resolver/MCP state. Re-syncing + re-installing reflects upstream changes.

> Implement copy via a shared recursive copy helper (reuse/extend whatever `continue-archived.ts`'s copy utilities or a `fs.cp(src, dest, {recursive:true})` wrapper provides). Guard all destination paths with `isSafeRelPath`-style checks against `..`/absolute/UNC.

---

## 9. REST API surface

New endpoints (added in `server.ts::handleApiRoute`). Responses reuse existing config-page conventions where overlapping.

| Method & path | Purpose |
|---|---|
| `GET /api/marketplace/sources` | List registered sources (`MarketplaceSource[]`) including `type`, pack sync metadata, gateway display metadata, and unsupported legacy registry rows where applicable. |
| `POST /api/marketplace/sources` | Add a source `{ url, ref?, type? }` → syncs + returns the created source. Omitted/`"pack"` means git/local pack source; `"mcp-gateway"` means URL-only MCP Gateway endpoint. New `"mcp-registry"` requests are rejected as legacy/unsupported. |
| `DELETE /api/marketplace/sources/:id` | Remove a source (and its cache dir). |
| `POST /api/marketplace/sources/:id/sync` | Re-sync (clone/fetch/read for pack sources; MCP Gateway discovery/fingerprint update for gateways); returns updated source metadata. |
| `GET /api/marketplace/sources/:id/packs` | Compatibility browse: `{ packs: BrowsePackWire[], diagnostics? }`. Pack sources return authored pack dirs; MCP Gateway sources return provider virtual packs. `hasTools` is informational (declared-entity rendering); it no longer drives a per-pack install gate. `descriptions?` carries optional one-line per-entity copy (§9.1/§10.4 R3). |
| `GET /api/marketplace/browse?projectId=` | Browse the all-source union with per-source status plus pack rows that retain source provenance and stable `browseKey`. |
| `POST /api/marketplace/install` | Body `{ sourceId, dirName, scope, projectId? }` → installs an authored pack or materializes a gateway virtual pack; returns `.pack-meta.yaml`. |
| `POST /api/marketplace/update` | Body `{ scope, packName, projectId? }` → updates; returns new meta. |
| `DELETE /api/marketplace/installed` | Body `{ scope, packName, projectId? }` → uninstall. |
| `GET /api/marketplace/installed?projectId=` | List installed packs across all scopes with provenance (`PackMeta` + manifest + scope), plus `updateAvailable` + `sourceStatus` (sync-free update gating) per row (§9.1/§10.4 R2). |
| `GET /api/packs/conflicts?projectId=` | List `(type, name, winner, shadowed[])` conflicts for the resolved list. |

- `scope` ∈ `"global-user" | "server" | "project"`; `projectId` required when `scope === "project"`.
| `GET /api/marketplace/pack-order?scope=&projectId=` | — → read a scope's market-pack order (§9.2). |
| `PUT /api/marketplace/pack-order` | Body `{ scope, projectId?, order: string[] }` → replace a scope's order (§9.2). |

- Existing endpoints unchanged in shape: `/api/roles`, `/api/tools`, `/api/skills` keep returning `origin`/`overrides` — now sourced from `PackResolver` instead of `ConfigCascade`/`discoverSlashSkills` (§6). The `origin` field gains the locked `user` value (§5.2, option (b)) and entities carry `originPackId`/`originPackName` (null for builtin/user).
- `/api/config-directories` (GET/DELETE/reset) is retained for back-compat (it still reports the legacy dirs + disablement), now reflecting the unified list's legacy entries. Its tests (`per-project-config-dirs.spec.ts`) must still pass.

### 9.1 Request/response contracts

All responses are JSON. `scope` values use the wire form `"global-user" | "server" | "project"`. **Installed-pack addressing** is the tuple `(scope, packName)` — there is no separate install id; `packName` is the installed directory name and is unique within a scope's `market-packs/`. **Source install addressing** uses the browsed `dirName`; for MCP Gateway virtual packs this is a source-qualified provider pack name and becomes the installed `packName` after materialization.

```ts
// Shared wire types
type SourceType = "pack" | "mcp-gateway";
type StoredSourceType = SourceType | "mcp-registry"; // legacy unsupported rows only
interface SourceWire {
  id: string;
  type?: StoredSourceType;        // omitted = "pack"
  url: string;
  displayName?: string;           // gateway readable name after duplicate suffixing
  normalizedName?: string;        // gateway authority/path before suffixing
  ref?: string;                   // pack sources only
  addedAt: string;
  trustedAt?: string;
  lastSyncedAt?: string;
  lastCommit?: string;            // pack git sources only
  unsupportedReason?: string;     // legacy mcp-registry rows only
  lastError?: string;
}
// One-line, per-entity descriptions sourced from the pack DIR (not the runtime
// APIs), keyed by the same identity the toggles/chips use: roles/skills by name,
// tools by GROUP name, entrypoints by `listName`. Best-effort — a kind is
// omitted when no entity in it has a usable description, an entity is omitted
// when its description is missing/empty. Carried on BOTH wire shapes so the
// "Show details" disclosure works for installed AND not-yet-installed packs.
interface PackEntityDescriptions {
  roles?:       Record<string, string>;
  tools?:       Record<string, string>;
  skills?:      Record<string, string>;
  entrypoints?: Record<string, string>;
}
interface BrowsePackWire extends PackManifest {
  dirName: string;                // source dir for pack sources; source-qualified name for gateway virtual packs
  sourceType?: StoredSourceType;
  virtual?: boolean;              // true for gateway rows materialized on install
  source?: { id: string; name: string; type: "builtin" | SourceType; builtin?: boolean };
  browseKey?: string;
  hasTools: boolean;
  descriptions?: PackEntityDescriptions;   // §10.4 R3
}
interface InstalledPackWire {
  scope: "global-user" | "server" | "project";
  packName: string;
  manifest: PackManifest;          // from pack.yaml
  meta: PackMeta;                  // from .pack-meta.yaml
  status: "ok" | "corrupt";        // corrupt = missing/invalid meta (§8.1 guard)
  // §10.4 R2 — update gating, computed WITHOUT a network sync (reads the
  // existing local cache only; see `MarketplaceInstaller.listInstalled`).
  updateAvailable: boolean;        // true iff source's latest manifest version
                                   //   differs from installed meta.version AND
                                   //   the source could be checked.
  sourceStatus: "ok" | "unknown";  // "unknown" = source removed / never-synced /
                                   //   no version data ⇒ render "Source not found".
}
interface ConflictWire {
  type: "roles" | "tools" | "skills";
  name: string;
  winner:   { packEntryId: string; scope: string; label: string };
  shadowed: { packEntryId: string; scope: string; label: string }[];
}
```

| Endpoint | Request body | Success | Errors |
|---|---|---|---|
| `GET /api/marketplace/sources` | — | `200 { sources: SourceWire[] }` | — |
| `POST /api/marketplace/sources` | `{ url: string, ref?: string, type?: SourceType }` | `201 { source: SourceWire }` (sync runs; `lastCommit` for pack git sources or gateway metadata for MCP Gateway sources populated) | `400` missing/invalid url/type/ref, including new `mcp-registry` requests; `409` duplicate `(type,url,ref)`; `502 { error }` pack sync or gateway discovery failed |
| `DELETE /api/marketplace/sources/:id` | — | `204` (also removes cache dir) | `404` unknown id |
| `POST /api/marketplace/sources/:id/sync` | — | `200 { source: SourceWire }` | `404` unknown id; `502 { error }` source-specific sync failure; unsupported for legacy registry rows |
| `GET /api/marketplace/sources/:id/packs` | — | `200 { packs: BrowsePackWire[], diagnostics?: string[] }` (pack dirs without valid `pack.yaml` omitted; gateway providers returned as virtual packs) | `404` unknown id; `502` sync/discovery failure; unsupported for legacy registry rows |
| `GET /api/marketplace/browse?projectId=` | — | `200 { sources: MarketplaceBrowseSourceState[], packs: BrowsePackWire[] }` | Per-source errors appear in `sources[]`; the union keeps rows from other sources. |
| `POST /api/marketplace/install` | `{ sourceId, dirName, scope, projectId? }` | `201 { installed: InstalledPackWire }` | `400` bad scope / missing `projectId` for project scope / unsafe `dirName`; `404` unknown source or browsed pack/virtual pack; `409` already installed at that scope; `422` invalid `pack.yaml`, schema-2 MCP contribution, or gateway entry materialization; `502` source sync failure |
| `POST /api/marketplace/update` | `{ scope, packName, projectId? }` | `200 { installed: InstalledPackWire }` | `400`/`404` as above; `409` not installed; `502` sync failure |
| `DELETE /api/marketplace/installed` | `{ scope, packName, projectId? }` | `204` | `400` bad scope/missing projectId; `404` not installed |
| `GET /api/marketplace/installed?projectId=` | — | `200 { installed: InstalledPackWire[] }` (all scopes; `corrupt` entries included) | `400` project scope requested without projectId |
| `GET /api/packs/conflicts?projectId=` | — | `200 { conflicts: ConflictWire[] }` | `400` as above |

- **No per-pack install gate.** Trust is handled once at the source-add boundary via a blanket warning + "Why?" disclosure (§10.2); the client POSTs `install` directly with no executable-code confirmation. The server never required a confirmation flag, and install of any pack is unrestricted. `hasTools` in the browse payload is now informational only.
- **Reload/cache behavior:** install/update/uninstall invalidate the affected scope's resolver cache (and the `slash-skills.ts` TTL cache) synchronously before returning, so a subsequent `GET /api/roles|tools|skills` reflects the change immediately (no client reload required). `pack_order` mutations do the same.
- **Update detection is sync-free (§10.4 R2).** `GET /api/marketplace/installed` enriches each row with `updateAvailable` + `sourceStatus`, but **never triggers a network sync** — it reads only existing local source state (a pack git source's already-cloned cache dir, a local-dir source read in place, or an MCP Gateway's last discovery/materialization metadata). The list endpoint is hit on every Market-page open, so a network sync per pack would be slow and could fail offline; the cheap local-state read is good enough because explicit "Re-sync" / Update already refresh the source when the user wants live data. A miss (source unregistered, never synced, cache absent, pack/gateway entry not found, or no source version/fingerprint) yields `sourceStatus: "unknown"` rather than a false "up to date", letting the UI disambiguate the two.
- **Browse descriptions:** `GET /api/marketplace/sources/:id/packs` adds an optional `descriptions` map per pack (§10.4 R3), read from the synced source's pack dir or generated from gateway provider display metadata for MCP virtual packs.
- **Idempotency / concurrency:** install is rejected (`409`) if `dest` exists; the atomic-rename (§8.1) makes concurrent installs of the same `(scope, dirName)` safe — the loser sees `EEXIST`/`409`.

### 9.2 `pack-order` contract (the sole conflict-resolution wire path)

```ts
// GET /api/marketplace/pack-order?scope=project&projectId=p1
// 200 → { scope, order: string[] }   // order = current pack_order[scope], highest LAST
// PUT /api/marketplace/pack-order
// body: { scope: "global-user"|"server"|"project", projectId?: string, order: string[] }
// 200 → { scope, order: string[] }   // normalized: unknown names dropped, on-disk-but-absent appended lowest
```

- **Routing of persistence:** `project` reads/writes `pack_order.project` in `<project>/.bobbit/config/project.yaml`; `server` / `global-user` read/write `pack_order.server` / `pack_order["global-user"]` in the **server** config store (§3.3). The handler picks the store from `scope`.
- **Errors:** `400` unknown scope, missing `projectId` for `scope=project`, or `order` not a string array; `404` project not found. Names in `order` that aren't installed at that scope are **dropped** (not an error) and the normalized result is returned.
- **Cache invalidation:** a successful `PUT` invalidates the affected scope's resolver cache + the `slash-skills.ts` TTL cache synchronously, so the next `GET /api/roles|tools|skills` and `/api/packs/conflicts` reflect the new order. This is the mechanism the marketplace UI's drag-reorder calls; covered by E2E #9.
- The drag-reorder UI mirrors the existing project drag-reorder component; reordering is the only conflict-resolution affordance in MVP (no pin).

---

## 10. UI

### 10.1 Market button (sidebar)

Add a **Market** button in the config-nav row, **between Workflows and New Goal**, in `src/app/sidebar.ts` (the `<div class="flex items-center">` block that currently holds Workflows then New Goal — see lines ~1382–1404). Follow the exact pattern of the Workflows button:

```ts
import { ShoppingBag /* or Store */ } from "lucide";
// ...
<button
  class="flex-1 flex items-center justify-center gap-1 px-1 py-1 whitespace-nowrap ${isMarketActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'} rounded-md transition-colors"
  @click=${() => toggleConfigPage(["market"], () => {
    import("./marketplace-page.js").then((m) => m.loadMarketplaceData());
    import("./routing.js").then((m) => m.setHashRoute("market"));
  })}
  title="Marketplace"
>${icon(ShoppingBag, "xs", "!w-3.5 !h-3.5")}<span>Market</span></button>
```

- Register the `market` route in `routing.ts` (mirror `workflows`) and add `isMarketActive = isRouteActive("market")`.
- The Workflows and New Goal buttons currently share one flex row; insert Market between them (it becomes a 3-button row, or restructure to keep alignment — match the existing two-row grouping visually).

### 10.2 Marketplace page (`src/app/marketplace-page.js`)

Reuse config-page conventions (`config-scope.ts`: `renderConfigScopeRow`, `renderOriginBadge`, scope state):

- **Sources panel:** list registered sources with `type`; "Add source" includes source type (`pack` or `mcp-gateway`), URL, and optional ref for pack sources only; per-source "Re-sync" and "Remove". The Add-source controls carry a persistent **blanket trust warning** (only add sources you trust — installing any pack can run code, connect trusted remote endpoints, or instruct agents on your machine) plus an expandable, keyboard-accessible **"Why?"** disclosure (collapsed by default) explaining the per-entity-type risk spectrum: **Tools** ship `extension.ts` / `_shared/` code that runs directly in the Bobbit server process on the host with no LLM/sandbox in the loop (highest risk); **MCP** stdio servers are host-tier code and HTTP servers are trusted remote endpoints; **Skills** are free-form instructions an agent follows literally (agent has shell access); **Roles** steer persona/behavior (more diffuse, but still drive an LLM with tool access). Trust is decided here, once, at the source boundary.
- **Browse panel:** show the all-source union (built-in, pack, and MCP gateway rows), with source chips, search, per-source loading/error/unsupported state, and source provenance on every card. Each installable pack has an **Install** button with a **scope picker** (System/server, Global-user, or a project — reuse `renderConfigScopeRow` semantics).
- **Installed panel:** list installed packs grouped by scope with provenance (source URL, version, commit short SHA, install/updated dates from `.pack-meta.yaml`); per-pack **Update** and **Uninstall**.
- **Conflict warnings:** packs participating in a same-name conflict show a warning icon (from `GET /api/packs/conflicts`); expand to see entity/type/winner/shadowed; the only resolution affordance is **reorder** (adjust `pack_order` via drag) — no per-conflict pin in MVP.
- After install/uninstall/update, refresh the Roles/Tools/Skills page data so installed entities appear with the pack as `origin` and the existing badge styling.

### 10.3 Config-page integration

Roles (`#/roles`), Tools (`#/tools`), Skills (`#/skills`) pages need no structural change — they already render `origin`/`overrides` badges and scope rows. They will now show market-pack-originated entities with the pack as origin (badge value per §5.2). Optionally show the pack name in a tooltip on the badge.

### 10.4 Marketplace UI polish

A follow-up pass (`goal/marketplace-ui-b94dadf1`) tightened the Market surface for readability and to surface install/update state honestly. Theme tokens only — no hardcoded palette, no `:root` overrides (see the `marketplace.css` header). All affordances preserve the existing data-testids and add new ones for the new controls. The four requirement areas (R1–R4):

**R1 — Standalone activation help removed.** The explanatory paragraph that used to render below the activation toggles (`.market-activation-help`) was deleted. *Why:* the toggles are self-explanatory once the per-entity descriptions (R3) are available; the paragraph was noise that competed with the pack provenance and action buttons for vertical space.

**R2 — Update button gating + "Source not found" lozenge.** `renderInstalledPackCard()` previously always rendered an **Update** button. It is now gated on `updateAvailable`:
- `updateAvailable: true` → render **Update** (`data-testid="market-update-pack"`).
- else `sourceStatus: "unknown"` → render a muted/warning **"Source not found"** lozenge (`data-testid="market-source-unknown"`) in place of Update, with a tooltip explaining the source is unregistered or unsynced so updates can't be checked.
- else (up to date, source ok) → render neither.
- **Uninstall stays always available** regardless of source state — a user must always be able to remove an installed pack even if its source is gone.

  *Why the `updateAvailable` / `sourceStatus` split:* a single boolean can't distinguish "confirmed up to date" from "we couldn't check". Showing nothing in the unknown case would imply the pack is current; showing a stale Update button would be misleading. The two-field contract (§9.1) lets the UI render the honest third state. **Change detection is version-based:** the source's latest **manifest version** is compared (string inequality) against the installed `meta.version` — not commit SHAs or file diffs — which is cheap, deterministic, and matches the semver the publisher advertises. Computed server-side in `MarketplaceInstaller.listInstalled()` via `computeSourceState()`, reading the local cache only (no `git fetch`; see §9.1).

**R3 — Per-entity one-line descriptions in a collapsed disclosure.** Each declared role / tool / skill / entry point can now show a one-line description, sourced from the pack dir by `readPackEntityDescriptions()`:
- Roles: `roles/<name>.yaml` `description` (falling back to `label` when it differs from the name).
- Tools: a representative `tools/<group>/*.yaml` `description` (keyed by **group** name — the manifest declares tools at group granularity).
- Skills: `skills/<name>/SKILL.md` frontmatter `description`.
- Entry points: the entrypoint YAML `description` (falling back to its `label`), keyed by `listName`.

Descriptions are carried on **both** `PackActivationCatalogue` (Installed list) and `BrowsePackWire` (Browse card) and rendered identically by a shared `renderEntityDetails()` helper inside a `<details>` disclosure labelled **"Show details"** (`data-testid="market-entity-details-<packName>"`), **collapsed by default**. *Why collapsed:* the entity-name chips and toggles stay the at-a-glance default; descriptions are progressive disclosure for users who want detail, so a pack with many entities doesn't produce a wall of text. Rows with no description are omitted; the disclosure is omitted entirely when no row would render (graceful degradation).

This is read from the **same authoritative pack dir** the activation catalogue reads from — never `/api/tools` or `/api/ext/contributions` — preserving the invariant that the catalogue is the UNFILTERED source for toggles (§9, pack-schema-v1 §9). **Path-traversal safety:** `validateManifest` does not guard `contents.roles/tools/skills` names against `..` or path separators, and this helper runs on **Browse** (before any install), so every manifest-declared name is validated with `isSafeBasename` + a realpath-aware containment check (`isPackPathWithinRoot`) before any filesystem read. A rejected name simply yields no description row.

**R4 — Browse install-state indicators.** `renderBrowsePackCard()` now cross-references the installed list to reflect what's already installed *at the currently-selected install scope* (including project identity — see finding #2):
- not installed → **Install** button (`data-testid="market-install-pack"`, unchanged).
- installed but behind the source's latest (same version comparison as R2) → **Update** button.
- installed and current → an **"Installed"** lozenge (`data-testid="market-browse-installed"`).

`installedMatchForBrowse()` resolves the match by pack name within the selected scope; for project scope it only matches when the Installed list was loaded for that same project, avoiding a wrong-project false positive. *Why:* without this, Browse always offered "Install" even for packs already present, leading to confusing `409 already installed` errors; surfacing state up front guides the user to the correct action.

**Scope/project-focus discipline (finding #2, unchanged):** install/update/uninstall and the Installed-list query all address the **same project** the install targeted (`focusProjectId`), so the indicators and actions never drift to the active/first project.

---

## 11. Extensibility seams

The design is additive along three axes:
- **Entity-type set:** add a loader/registry path for each contribution type while keeping ordering and activation centralized. `mcp/` now loads through the Marketplace MCP resolver rather than the role/tool/skill name-merging resolver; panels/providers/entrypoints load through pack-scoped contribution registries.
- **Pack/source format:** `pack.yaml`/`.pack-meta.yaml` parsers ignore unknown keys; new layouts add a `PackEntry.layout` variant + loader support.
- **Install pipeline:** install/update/uninstall remain directory-based. Git/local sources copy authored pack dirs; MCP Gateway sources materialize virtual provider rows into normal pack dirs before the same install semantics apply.

**Future UI-panel/plugin bundle (the headline future use case):** a panel pack would ship a `panels/<name>/` subtree (manifest + entry HTML/JS + a panel descriptor). The seam: (a) a `PanelLoader` plugged into the resolver, (b) `PackManifest.contents.panels`, (c) a panel host that mounts resolved panels (PR-Walkthrough generalised). Nothing is built now, but the resolver and pack format already accommodate it without redesign.

### Deferred (explicit seams left)

- **MCP Gateway auth and secret parameterization** — Gateway URLs are supported as trusted streamable-HTTP MCP endpoints, but there is no first-class secret-binding UI for gateway credentials. MCP contribution files may reference environment/header placeholders; users must still manage the actual secrets out of band.
- **AGENTS/CLAUDE.md installs** — not installable; `system-prompt.ts::readAllAgentFiles` untouched. Existing AGENTS.md resolution preserved.
- **Portable/parameterised workflow bundles** — workflows stay project-scoped inline in `project.yaml`; note what'd change (decouple from component/command pairs) but build nothing.
- **Staff templates** as exportable packs — gap noted.
- **Trust / sandboxing / signing** of code-bearing packs — MVP copies tool code as-is with a UI warning; sketch where a permission/trust gate slots into `installPack`.
- **Hosted pack registry with search** — generic pack sources remain git/local. MCP Gateway sources are provider discovery endpoints, not a general hosted pack marketplace.
- **Per-conflict pinning (`pack_conflicts`)** — deferred; MVP resolves same-name conflicts solely via `pack_order` (§3.3) plus user-pack customization (§3.2). The future schema (additive, no migration needed) would be a `pack_conflicts` list in `project.yaml`/server config:
  ```yaml
  pack_conflicts:
    - type: roles
      name: researcher
      winner: market:project:research-pack   # PackEntry.id
  ```
  applied as a post-pass in `PackResolver.resolve` (after the ordered merge, re-point `byName.get(name)` to the pinned entry). Not implemented, surfaced, or tested in MVP.

---

## 12. Test plan

### 12.1 Existing tests that MUST keep passing (the regression contract)

| Test | Pins | Preserved by |
|---|---|---|
| `tests/config-cascade.test.ts` | role model/thinkingLevel project>server>builtin; `origin`/`overrides` | §6.1 list = builtin<server<project with zero market packs |
| `tests/e2e/config-cascade-api.spec.ts` | `/api/roles` `/api/tools` origin/overrides over HTTP | §6.1 + §5.2 badge mapping |
| `tests/e2e/ui/config-scope.spec.ts` | scope rows, customize/revert UX, badges | §5.2 customize/override endpoints unchanged |
| `tests/config-directories.test.ts` | `parseCustomDirectories`, `getAllConfigDirectories` (13 builtin), `saveCustomDirectories` | legacy helpers retained, only consumed by `buildPackList` |
| `tests/e2e/per-project-config-dirs.spec.ts` | per-project config_directories behaviour | §6.5 step 5 (config_directories still read to build list). NB: disablement was inert for resolution (§6.3) — this suite does not pin "disabled dir still resolves", so the new enforcement (unit #6) doesn't conflict with it. |
| `tests/e2e/tools-cascade.spec.ts` | tool group customize/override cascade | §6.1 tool loader + endpoints |
| `tests/skill-resolve.test.ts` | byte-equal slash expansion + precedence | §6.2 order identical, adapter reuses parse/sort/cache |
| `tests/validate-skill-discovery.test.ts` | skill discovery across dirs | §6.2 + §6.4 |
| `tests/skill-manifest.test.ts` | activation header/manifest | §6.4 (unchanged) |
| `tests/e2e/slash-skill-e2e.spec.ts` | end-to-end slash skills | §6.2 + §6.4 |

> Rule: if any of these fail, fix the mapping, not the test. If a behavior the reframe must preserve isn't currently pinned (e.g. skills disablement via `disabled_config_directories`), **add the test before refactoring**.

### 12.2 New unit tests (file:// fixtures)

Point at fixture pack trees under a tmp dir.

1. **Pack discovery & manifest parsing** — dir with/without `pack.yaml`; valid/invalid/forward-compat `pack.yaml`; `.pack-meta.yaml` round-trip.
2. **PackResolver core** — ordered list low→high; same-name shadow; `shadows[]` accumulation; `onlyTypes` filtering. (No `pack_conflicts` pin — deferred.)
3. **Per-type loaders** — RoleLoader/ToolLoader (`defaults-tree`, grouped+flat tools), SkillLoader (all three layouts).
4. **Three-scope resolution** — builtin/user/market across builtin<server<global-user<project; verify project wins, global-user beats server, **within-scope user pack > market packs** (customize wins locally), and `pack_order` reordering of market-vs-market.
5. **Legacy→unified mapping equivalence** — build the list from fixtures mirroring §6.1/§6.2 and assert resolution **equals** the legacy `ConfigCascade`/`discoverSlashSkills` output for the same inputs (a direct A/B harness, like `skill-resolve.test.ts`'s `legacy()` fixture).
6. **`disabled_config_directories` enforcement (new behavior, §6.3)** — assert a present-AND-disabled skill dir is now **omitted** from resolution (was inert before). Also assert a present-but-not-disabled dir still resolves (guards against over-omission).
7. **File ops** — `installPack` copies subtree + writes meta + appends `pack_order`; `uninstallPack` deletes exactly the added dir + cleans order; `updatePack` replaces contents + rewrites meta (preserves `installedAt`). Path-traversal guards reject unsafe names.
8. **Source store** — `MarketplaceSourceStore` CRUD + YAML persistence; local-dir vs git-url branching (mock git or use a local bare repo fixture).

### 12.3 Browser E2E (mandatory — pattern after `settings.spec.ts` + reuse `config-scope.spec.ts`)

`tests/e2e/ui/marketplace.spec.ts`:
1. **Market button** visible and positioned **between Workflows and New Goal**; opens the marketplace surface.
2. **Register source** (use a local-dir or fixture-repo source) → it appears in the sources list.
3. **Browse packs** → packs show description + declared entities.
4. **Install** a pack to a scope → its entities appear and resolve on `#/roles` / `#/tools` / `#/skills`, each tagged with the **specific pack**: scope badge present (`user` for global-user) AND `originPackName` chip/tooltip matches the installed pack (§5.2).
5. **Persists across reload.**
6. **Provenance** shown (source + version/commit + date).
7. **Update** (re-sync after upstream change reflected) and **Uninstall** (entities disappear; exactly what install added is removed).
8. **Source-level trust warning** is shown in the Add-source panel, with a "Why?" disclosure (collapsed by default) that expands to the per-entity-type threat model; no per-pack confirmation appears before install.
9. **Conflict warning icon** appears when two installed packs define the same entity name; **drag-reorder** (which calls `PUT /api/marketplace/pack-order`) flips the winner and the warning/`origin` updates after re-resolve. Persists across reload.

### 12.4 Acceptance-criterion → test map

| Acceptance criterion | Test |
|---|---|
| Market button between Workflows and New Goal | E2E #1 |
| Register source + browse packs | E2E #2–3 |
| Install copies dir; entities resolve via single resolver tagged with pack origin | E2E #4 + unit #4,#7 |
| Existing overrides resolve identically | §12.1 suite + unit #5 |
| Provenance + update + uninstall (removes exactly what was added) | E2E #6–7 + unit #7 |
| Same-name conflicts → warning + configured precedence (`pack_order` reorder) | E2E #9 + unit #2,#4 (pack_order reordering) |
| Entities tagged with the specific pack as origin | E2E #4 (originPackName) |
| `disabled_config_directories` now enforced for skills | unit #6 |
| Source-level trust warning + "Why?" disclosure in Add-source panel | E2E #8 |
| Re-sync + re-install reflects upstream | E2E #7 + unit #8 |

---

## 12.5 File / module change list

Concrete ownership boundaries for the high-blast-radius refactor. **New** modules vs **edited** modules:

**New (server):**
- `src/server/agent/pack-types.ts` — `PackManifest`, `PackMeta`, `PackEntry`, `EntityType`, `EntityLoader<T>`, `LoadedEntity<T>`, `ResolvedEntity<T>` interfaces.
- `src/server/agent/pack-manifest.ts` — `pack.yaml` / `.pack-meta.yaml` read + write + validation (schema-aware `contents.mcp` support/rejection, name guard).
- `src/server/agent/pack-resolver.ts` — `PackResolver` pipeline + the Role/Tool/Skill `EntityLoader`s (delegating parse to extracted helpers below).
- `src/server/agent/pack-list.ts` — `buildPackList(opts)` (§6.5): the legacy→unified mapping (cascade layers + skill scan dirs + `config_directories` + `disabled_config_directories`).
- `src/server/agent/marketplace-source-store.ts` — `MarketplaceSourceStore` (sources YAML CRUD).
- `src/server/agent/mcp-gateway-source.ts` — MCP Gateway discovery, provider-row shaping, diagnostics, and materialization helpers.
- `src/server/agent/marketplace-install.ts` — pack-source sync, MCP Gateway materialization, `installPack`/`uninstallPack`/`updatePack`, atomic staging, recursive copy helper.

**Edited (server):**
- `src/server/agent/config-cascade.ts` — `resolveRoles`/`resolveTools` become adapters over `PackResolver`; **`resolveWorkflows`/`resolveToolGroupPolicies` untouched** (§2.2 note).
- `src/server/skills/slash-skills.ts` — `discoverSlashSkills`/`getSkillDirectories` become adapters over `PackResolver` (§6.4); keep TTL cache, `userInvocable` filter, sort, `source` derivation.
- `src/server/agent/builtin-config.ts` — extract shared `parseRoleYaml` / `parseToolsDir` (used by builtin entry + loaders); builtin pack entry creation.
- `src/server/agent/project-config-store.ts` — add scoped `pack_order` map migrated native-YAML field (mirror `config_directories`); project store holds `pack_order.project`, server store holds `pack_order.{server,global-user}` (§3.3); keep reading legacy keys.
- `src/server/server.ts` — add `/api/marketplace/*`, `/api/marketplace/pack-order` (GET/PUT, §9.2), and `/api/packs/conflicts` routes (§9); wire resolver-cache + slash-skills TTL invalidation on install/uninstall/update/reorder; `/api/roles|tools|skills` now read from `PackResolver` and emit `originPackId`/`originPackName` + `user` origin.
- `src/server/agent/config-directories.ts` — **unchanged behaviour**; its helpers are now consumed by `buildPackList` (legacy keys still read).

**Explicit non-goal still untouched:** `src/server/agent/system-prompt.ts` (AGENTS/CLAUDE.md prompt assembly). MCP is now integrated through `McpManager` as an additive Marketplace layer; manual config loaders remain.

**New (UI):**
- `src/app/marketplace-page.ts` — the Market surface (sources / browse / installed / conflicts), reusing `config-scope.ts` helpers.

**Edited (UI):**
- `src/app/sidebar.ts` — Market button between Workflows and New Goal.
- `src/app/routing.ts` — register `market` route + `isMarketActive`.
- `src/app/api.ts` — marketplace fetch wrappers (incl. pack-order GET/PUT).
- `src/app/config-scope.ts` — extend `ConfigOrigin` to include `user` + badge class; render `originPackName` chip/tooltip.
- Roles/Tools/Skills pages — no structural change beyond the pack chip (badges already generic; §10.3).

**Tests:** new unit specs (§12.2), new `tests/e2e/ui/marketplace.spec.ts` (§12.3); existing regression suite (§12.1) must stay green.

## 13. Implementation order (suggested)

1. **Types + parsers** — `PackManifest`/`PackMeta`/`PackEntry`/loader interfaces; `pack.yaml`/`.pack-meta.yaml` read-write; unit tests #1.
2. **PackResolver + loaders** — pipeline + Role/Tool/Skill loaders; unit tests #2–3.
3. **`buildPackList`** — the legacy mapping (§6); A/B equivalence tests #5; keep `ConfigCascade`/`discoverSlashSkills` as adapters delegating to the resolver; run full §12.1 suite green.
4. **Source store + source sync + file ops** — pack-source sync, MCP Gateway discovery/materialization, install/uninstall/update; unit tests #7–8.
5. **REST endpoints** (§9).
6. **UI** — Market button + marketplace page reusing config-scope conventions; E2E suite #12.3.
7. **Conflict surfacing + `pack_order`** persistence (per-conflict pinning deferred).

Each step lands behind passing tests; step 3 is the high-blast-radius gate — do not proceed to UI until the full existing suite is green on the resolver swap.
