# Pack-Based Marketplace — Design Document

Status: **design** (MVP implementation to follow)
Owner: Pack-Based Marketplace goal (`goal/pack-based-mar-6828576e`)
Scope: unify the **installable-entity resolvers** (roles, tools, skills) into **one pack resolver over one ordered list of packs**, and add a **Market** surface to register sources and install/uninstall/update packs.

> This document is implementable on its own. It encodes the goal's *locked decisions verbatim* and is deliberately precise about the **legacy → unified-list mapping** (§6), which is the highest regression risk.

---

## 0. TL;DR / mental model

- A **pack is a directory** laid out like `defaults/`: `roles/`, `tools/`, `skills/` (and a future `mcp/`).
- There is **ONE resolver** that walks **ONE ordered list of packs** low→high priority and produces resolved entities, each tagged with the pack it came from. **Precedence = position in the list.**
- **Everything is a pack** in that list:
  - **Builtin pack** — shipped `dist/server/defaults/` (read-only, lowest priority).
  - **User packs** — each scope's existing `roles/ tools/ skills/` dir; where create/customize writes, revert deletes.
  - **Market packs** — installed from a source into a scope's `market-packs/<pack-name>/`.
  - **Legacy-implicit packs** — the hard-coded skill scan dirs and user-registered `config_directories` mapped into list entries (back-compat).
- **Install** = copy a pack dir into a scope's `market-packs/` + write `.pack-meta.yaml`. **Uninstall** = delete the dir. **Update** = re-copy/re-pull.
- **Out of scope, untouched:** `mcp-manager.ts` (MCP servers) and `system-prompt.ts` (AGENTS.md). Leave loader seams only.

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
  (mcp/ ...)                      # future — loader seam reserved, not loaded in MVP
```

**Discovery rule (single source of truth):** a directory is a pack **iff** it contains `pack.yaml`. Directories without one are ignored (e.g. a source repo's `README.md`, a `docs/` folder). The **builtin pack** and **legacy-implicit packs** are the only exceptions — they have an *implicit* manifest synthesised in code (no file on disk).

### 1.2 Marketplace source repo layout

A source is a git repo (or local dir) whose **top level is a collection of pack directories** — never a flat `defaults/` mirror. One repo may hold many packs.

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

```
dist/server/defaults/               # BUILTIN PACK (read-only, lowest priority)
  roles/  tools/  skills/

~/.bobbit/                          # GLOBAL-USER scope
  roles/  tools/  skills/            #   ← user pack (created/customized entities)
  market-packs/<pack-name>/...       #   ← installed market packs

<server-cwd>/.bobbit/               # SERVER scope
  roles/  tools/  skills/            #   ← user pack
  market-packs/<pack-name>/...

<project>/.bobbit/config/           # PROJECT scope (highest priority)
  roles/  tools/  skills/            #   ← user pack
  market-packs/<pack-name>/...
```

> NOTE: today, `RoleStore` / `ToolManager` write to `<scope>/.bobbit/config/{roles,tools}` for project scope, and the server-scope stores write to `<server-cwd>/.bobbit/config/...`. The "user pack" for a scope is exactly the directory those stores already use. The pack model **does not move any files** — it points the resolver at the same dirs.

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
# Declared contents — what the pack ADVERTISES it ships. Used for the browse
# UI and the "installs executable code" warning. The resolver still loads
# whatever is physically present; `contents` is advisory + drives UX badges.
contents:
  roles:  [researcher]
  tools:  [research]             # tool GROUP names (dir names under tools/)
  skills: [lit-review]
```

TypeScript shape (parser output):

```ts
export interface PackManifest {
  name: string;
  description: string;
  version: string;
  author?: string;
  homepage?: string;
  contents?: {
    roles?: string[];
    tools?: string[];   // tool group dir names
    skills?: string[];
    mcp?: string[];     // reserved; ignored in MVP
  };
}
```

Validation: `name` must match `/^[a-z0-9][a-z0-9-]*$/` (used as a directory name; reject path separators, `..`, leading dot — reuse `isSafeRelPath`-style guarding). `description` and `version` non-empty. Unknown keys ignored (forward-compat). A pack whose `pack.yaml` is missing/invalid is **skipped with a warning**, not fatal.

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
- This is the **single** resolver. `ConfigCascade.resolve*` and `discoverSlashSkills` become thin adapters over it (§6), then are removed once callers migrate.

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
[ user pack ]  <  [ market packs, in source-registry install order ]
```

Rationale and rules:
- **User pack is the LOWEST within its scope** so an explicitly installed market pack can shadow the scope's baseline — but a higher *scope* still wins overall (project user pack beats a server market pack, because the whole project segment is above the whole server segment).

  > This preserves the customize/revert UX: customizing writes to the scope's user pack; within that scope a market pack could still shadow it, surfaced as a conflict. Cross-scope, project customizations always win (project segment is top).
- **Market vs market within a scope:** ordered by the scope's **pack order list** (§3.3) — default is install order (oldest first ⇒ lowest priority; newest install shadows older). The order is user-configurable.
- **Legacy-implicit entries** slot into the scope segment that matches their physical location (§6.2): project-scoped legacy dirs into the project segment, personal/home dirs into global-user. Within that segment they are placed **above the user pack and above market packs** for skills only, to preserve today's "project/personal skills beat everything" precedence (see the exact placement table in §6.2).

### 3.3 Precedence-config persistence

Two mechanisms, both persisted in **project config (`project.yaml`) for project scope**, and in **server config (`<server-cwd>/.bobbit/config/project.yaml`)** for server/global scope (reusing the existing `ProjectConfigStore` surface):

```yaml
# project.yaml additions (native YAML; see ProjectConfigStore migrated-fields pattern)
pack_order:                       # per-scope ordering of MARKET packs (highest last)
  - research-pack
  - qa-pack
pack_conflicts:                   # OPTIONAL per-conflict explicit winner overrides
  - type: roles
    name: researcher
    winner: market:project:research-pack   # PackEntry.id
```

- `pack_order` is the primary mechanism: reorder market packs within a scope (mirrors the existing project drag-reorder pattern). Implemented as a new migrated field on `ProjectConfigStore` (follow the `config_directories` native-YAML side-table precedent — see `project-config-store.ts`).
- `pack_conflicts` is the escape hatch: pin a specific entity name to a specific pack regardless of order. Applied as a post-pass in `PackResolver.resolve` (after the ordered merge, re-point `byName.get(name)` to the pinned entry if present).
- MVP may ship `pack_order` only and defer `pack_conflicts` to a follow-up; the schema slot is reserved so it's additive.

---

## 4. Same-name conflict handling

A **conflict** exists for `(type, name)` whenever `resolve(type)` returns a `ResolvedEntity` with non-empty `shadows[]`.

- The marketplace manager renders a **warning icon** next to any installed pack that participates in a conflict (it either shadows, or is shadowed by, another pack). Hover/expand shows: entity type + name, winner pack, shadowed pack(s).
- The config pages (Roles/Tools/Skills) already show `origin`/`overrides` badges; the same data drives a conflict affordance there (the `overrides` badge already communicates a shadow).
- Resolution mechanism: the user adjusts `pack_order` (drag-reorder market packs within a scope) or sets a `pack_conflicts` pin. After either, re-resolve and the warning clears or moves.
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

- Each scope's existing config dir is its user pack:
  - project: `<project>/.bobbit/config/` (path used by `ProjectContext`'s `roleStore`/`toolManager`).
  - server: `<server-cwd>/.bobbit/config/`.
  - global-user: `~/.bobbit/` (NEW for roles/tools — see §3.1 note; harmless because nothing reads it today).
- **Create/customize** = write the entity file into the scope's user-pack dir (exactly what `RoleStore.put` / `ToolManager` / the `customize` endpoints do today). **Revert** = delete it (`RoleStore.remove` / the `override` DELETE endpoints). No new file operations — the customize/override endpoints keep their current bodies (see `server.ts` `/api/roles/:name/customize` and `/override`).
- `origin`/`overrides` badge mapping: the API maps `ResolvedEntity.origin.scope` → the existing `ConfigOrigin` wire value, and the topmost shadowed scope → `overrides`:

  | `origin.scope` (winner) | wire `origin` |
  |---|---|
  | `builtin` | `builtin` |
  | `server` | `server` |
  | `global-user` | `server` *(see note)* or new `user` value |
  | `project` | `project` |

  > The current UI only knows `builtin | server | project` (see `config-scope.ts::ConfigOrigin`). MVP options: (a) collapse `global-user` onto `server` for the badge to avoid UI churn, or (b) extend the badge enum with `user` and add a badge class. **Recommended: (b)** — add a `user` origin + badge so global-user installs are distinguishable; it's a small additive UI change and the config pages already render badges generically. Pin the chosen mapping with a test (§12).

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

When a path appears in `disabled_config_directories` (read via the legacy key, see `removeBuiltinDirectory`), the matching legacy-implicit `PackEntry` is **omitted** from the ordered list before resolution. Path comparison uses the same normalization (`expandPath` / `path.resolve`) as today. Effect: nothing from that dir resolves — identical to `slash-skills.ts` skipping it. (Note: today the *scanning* code doesn't actually consult `disabled_config_directories` for skills — only `getAllConfigDirectories` reports it; the unified list makes disablement actually take effect uniformly, which is a superset that the per-project-config-dirs tests must continue to accept. Verify against `per-project-config-dirs.spec.ts` and add a test if disablement-of-skills wasn't previously pinned.)

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
  builtinsDir: string;
  serverConfigDir: string;          // <server-cwd>/.bobbit/config
  globalUserDir: string;            // ~/.bobbit
  projectConfigDir?: string;        // <project>/.bobbit/config
  cwd: string;                      // project rootPath (for .claude/* skill dirs)
  configStore: ProjectConfigReader; // reads config_directories + disabled_config_directories (legacy keys)
}): PackEntry[];
```

Steps:
1. Push `builtin`.
2. For each scope in `[server, global-user, project]` (in that order):
   a. push the scope's `market-packs/*` (each dir with a `pack.yaml`), ordered by that scope's `pack_order`.
   b. push the scope's user-pack entry.
   c. push the scope's legacy-implicit skill entries (rows from §6.2 that belong to this scope).
3. Apply within-scope ordering rules (§3.2): user pack below market packs; legacy skill entries placed to reproduce §6.2's exact order.
4. Remove any entry whose path is in `disabled_config_directories`.
5. Read `config_directories` (legacy key, via `parseCustomDirectories`) and insert skills entries as `legacy:custom:<path>` at the position from §6.2 row 3.

> **Back-compat invariant:** the legacy keys `config_directories`, `skill_directories`, `disabled_config_directories` keep being **read** (via the existing `config-directories.ts` helpers) **only** to construct this list. After construction, no roles/tools/skills code path scans dirs on its own.

### 6.6 Worked examples (must resolve identically)

**1. Project override of a builtin role.**
- Today: builtin `coder` at `dist/server/defaults/roles/coder.yaml`; project override at `<project>/.bobbit/config/roles/coder.yaml`; cascade → project wins, `origin=project, overrides=builtin`.
- Unified: list = `[builtin, …, user:project]`. Resolver: builtin loads `coder`, `user:project` loads `coder` and shadows it. `origin.scope=project`, `shadows=[builtin]` ⇒ badge `origin=project, overrides=builtin`. Revert = delete project user-pack file. ✅ identical.

**2. User-registered custom skills directory (`config_directories`).**
- Today: `config_directories: [{ path: "~/dev/my-skills", types: ["skills"] }]`; `slash-skills.ts` scans it at the `custom` precedence slot.
- Unified: on `buildPackList`, that entry → `legacy:custom:/home/u/dev/my-skills`, `layout: skills-flat`, `onlyTypes:["skills"]`, inserted at §6.2 row 3. Its `SKILL.md`s load via `SkillLoader`. Same skills, same precedence (above builtin-file, below legacy/personal/project). ✅ identical.

**3. Disabled built-in scan location.**
- Today: `disabled_config_directories` contains `<project>/.claude/skills`; reported as disabled.
- Unified: the `legacy:.claude/skills` entry is omitted from the list (§6.3) ⇒ nothing from it resolves. ✅ same effect (and now uniformly enforced for skills).

**4. Claude-compatible personal skills (`~/.claude/skills`, `~/.bobbit/skills`).**
- Today: scanned at personal scope by `slash-skills.ts`.
- Unified: pre-registered as `legacy:~/.claude/skills` / `legacy:~/.bobbit/skills` at the global-user position; still discovered; files stay in place (referenced, not moved) so Claude Code still sees them. MCP's own Claude-compatible locations are untouched (still read by `mcp-manager.ts`). ✅ identical.

---

## 7. Source registry

### 7.1 Persistence

Marketplace **source URLs** are a small registry. Sources are **global** to the server (not per-project): a registered source can be browsed and installed into any scope. Persist in a new store file:

```
<server-cwd>/.bobbit/config/marketplace-sources.yaml
```

```yaml
# marketplace-sources.yaml
sources:
  - id: acme                       # stable id ([a-z0-9-]+), unique
    url: https://github.com/acme/bobbit-packs.git   # git URL OR absolute local dir path
    ref: main                      # branch/tag (default: remote HEAD)
    addedAt: 2026-06-03T10:00:00Z
    lastSyncedAt: 2026-06-03T10:05:00Z
    lastCommit: 9f3c1a8
```

```ts
export interface MarketplaceSource {
  id: string;
  url: string;          // git remote URL or absolute local directory
  ref?: string;
  addedAt: string;
  lastSyncedAt?: string;
  lastCommit?: string;
}
export class MarketplaceSourceStore { /* CRUD + load/save YAML, mirrors RoleStore patterns */ }
```

### 7.2 Git sync

- A source is synced into a server-local cache before browse/install:
  ```
  <server-cwd>/.bobbit/state/marketplace-cache/<source-id>/
  ```
- **Local-dir sources** (`url` is an absolute path): no clone; read directly. `commit` recorded as empty.
- **Git sources:** **shallow clone** (`git clone --depth 1 --branch <ref> <url> <cache-dir>`); re-sync via `git fetch --depth 1 && git reset --hard origin/<ref>` (or re-clone if the cache is dirty/missing). Resolve and record `lastCommit` via `git rev-parse HEAD`.
- **Private repos:** rely on the user's ambient git credentials (credential helper / SSH agent) exactly as Bobbit's worktree/clone code does today. No credential storage in the marketplace.
- Sync is invoked on: add-source, explicit "re-sync", and implicitly before browse if the cache is missing. Surface git errors to the UI verbatim.

### 7.3 Browsing

`browsePacks(sourceId)`: sync (if needed) → scan the cache root one level deep → for each subdir with a `pack.yaml`, parse the manifest → return `PackManifest[] + dirName`. Directories without `pack.yaml` ignored.

---

## 8. Install / uninstall / update file operations

All operations are plain directory copies/deletes (no per-entity bookkeeping).

### 8.1 Install

`installPack(sourceId, packName, scope)`:
1. Sync source cache (§7.2).
2. Resolve `src = <cache>/<packName>` (must contain `pack.yaml`).
3. Resolve `dest = <scopeRoot>/market-packs/<packName>` where `scopeRoot` is `~/.bobbit` | `<server-cwd>/.bobbit` | `<project>/.bobbit/config`.
4. Reject if `dest` already exists (require explicit update/uninstall). Reject unsafe `packName` (path traversal guard).
5. **Copy `src` → `dest` verbatim** (entire subtree: `pack.yaml`, `roles/`, `tools/` incl. `extension.ts` + `_shared`, `skills/`). Skip `.git`.
6. Write `dest/.pack-meta.yaml` (§1.5) with `sourceUrl`, `sourceRef`, resolved `commit`, `version` from manifest, `installedAt = updatedAt = now`, `scope`.
7. Append `packName` to that scope's `pack_order`.
8. Trigger a resolver reload for the affected scope so entities appear immediately.

### 8.2 Uninstall

`uninstallPack(scope, packName)`:
1. `dest = <scopeRoot>/market-packs/<packName>`.
2. **`fs.rm(dest, { recursive: true })`** — deletes exactly what install added.
3. Remove `packName` from `pack_order` and drop any `pack_conflicts` referencing it.
4. Reload resolver. Uninstalling removes precisely the installed entities (no orphan ledger to reconcile).

### 8.3 Update

`updatePack(scope, packName)`:
1. Read `dest/.pack-meta.yaml` for `sourceUrl`/`sourceRef`.
2. Re-sync the source cache; re-resolve `commit`.
3. **Replace** `dest` contents with the fresh `src` subtree (delete-then-copy, or copy to temp + atomic swap). Preserve nothing stale.
4. Rewrite `.pack-meta.yaml` with new `commit`/`version` and `updatedAt = now` (keep original `installedAt`).
5. Reload resolver. Re-syncing + re-installing reflects upstream changes.

> Implement copy via a shared recursive copy helper (reuse/extend whatever `continue-archived.ts`'s copy utilities or a `fs.cp(src, dest, {recursive:true})` wrapper provides). Guard all destination paths with `isSafeRelPath`-style checks against `..`/absolute/UNC.

---

## 9. REST API surface

New endpoints (added in `server.ts::handleApiRoute`). Responses reuse existing config-page conventions where overlapping.

| Method & path | Purpose |
|---|---|
| `GET /api/marketplace/sources` | List registered sources (`MarketplaceSource[]`). |
| `POST /api/marketplace/sources` | Add a source `{ url, ref? }` → syncs + returns the created source. |
| `DELETE /api/marketplace/sources/:id` | Remove a source (and its cache dir). |
| `POST /api/marketplace/sources/:id/sync` | Re-sync (re-clone/fetch); returns updated `lastCommit`. |
| `GET /api/marketplace/sources/:id/packs` | Browse: `{ packs: Array<PackManifest & { dirName, hasTools }> }`. `hasTools` drives the executable-code warning. |
| `POST /api/marketplace/install` | Body `{ sourceId, packName, scope, projectId? }` → installs; returns `.pack-meta.yaml`. |
| `POST /api/marketplace/update` | Body `{ scope, packName, projectId? }` → updates; returns new meta. |
| `DELETE /api/marketplace/installed` | Body `{ scope, packName, projectId? }` → uninstall. |
| `GET /api/marketplace/installed?projectId=` | List installed packs across all scopes with provenance (`PackMeta[]` + manifest + scope). |
| `GET /api/packs/conflicts?projectId=` | List `(type, name, winner, shadowed[])` conflicts for the resolved list. |

- `scope` ∈ `"global-user" | "server" | "project"`; `projectId` required when `scope === "project"`.
- Existing endpoints unchanged in shape: `/api/roles`, `/api/tools`, `/api/skills` keep returning `origin`/`overrides` — now sourced from `PackResolver` instead of `ConfigCascade`/`discoverSlashSkills` (§6). The `origin` field gains `user` if mapping (b) in §5.2 is chosen.
- `/api/config-directories` (GET/DELETE/reset) is retained for back-compat (it still reports the legacy dirs + disablement), now reflecting the unified list's legacy entries. Its tests (`per-project-config-dirs.spec.ts`) must still pass.

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

- **Sources panel:** list registered sources; "Add source" (URL + optional ref); per-source "Re-sync" and "Remove".
- **Browse panel:** select a source → list its packs (name, version, description, declared entities as chips). Each pack has an **Install** button with a **scope picker** (System/server, Global-user, or a project — reuse `renderConfigScopeRow` semantics).
- **Executable-code warning:** if a pack ships tools (`hasTools` / `contents.tools` non-empty), show an explicit confirm dialog **"This pack installs executable code that runs on your machine"** before install.
- **Installed panel:** list installed packs grouped by scope with provenance (source URL, version, commit short SHA, install/updated dates from `.pack-meta.yaml`); per-pack **Update** and **Uninstall**.
- **Conflict warnings:** packs participating in a same-name conflict show a warning icon (from `GET /api/packs/conflicts`); expand to see entity/type/winner; offer reorder (adjust `pack_order`) and/or pin.
- After install/uninstall/update, refresh the Roles/Tools/Skills page data so installed entities appear with the pack as `origin` and the existing badge styling.

### 10.3 Config-page integration

Roles (`#/roles`), Tools (`#/tools`), Skills (`#/skills`) pages need no structural change — they already render `origin`/`overrides` badges and scope rows. They will now show market-pack-originated entities with the pack as origin (badge value per §5.2). Optionally show the pack name in a tooltip on the badge.

---

## 11. Extensibility seams

The design is additive along three axes:
- **Entity-type set:** add an `EntityLoader<T>` and register it; the pipeline (`PackResolver`) is type-agnostic. `mcp/` and `panels/` slot in here. Reserve `mcp` in `EntityType` and `PackManifest.contents` (ignored in MVP).
- **Pack/source format:** `pack.yaml`/`.pack-meta.yaml` parsers ignore unknown keys; new layouts add a `PackEntry.layout` variant + loader support.
- **Install pipeline:** `installPack`/`updatePack` are source-backend-agnostic (git or local dir today); a hosted-registry backend implements the same sync→copy contract.

**Future UI-panel/plugin bundle (the headline future use case):** a panel pack would ship a `panels/<name>/` subtree (manifest + entry HTML/JS + a panel descriptor). The seam: (a) a `PanelLoader` plugged into the resolver, (b) `PackManifest.contents.panels`, (c) a panel host that mounts resolved panels (PR-Walkthrough generalised). Nothing is built now, but the resolver and pack format already accommodate it without redesign.

### Deferred (explicit seams left)

- **MCP server installs** — `mcp/` loader seam reserved; `mcp-manager.ts` untouched and still resolves existing `.mcp.json`. Revisit with a parameterization/secrets model. Packs may NOT install `mcp/` in MVP.
- **AGENTS/CLAUDE.md installs** — not installable; `system-prompt.ts::readAllAgentFiles` untouched. Existing AGENTS.md resolution preserved.
- **Portable/parameterised workflow bundles** — workflows stay project-scoped inline in `project.yaml`; note what'd change (decouple from component/command pairs) but build nothing.
- **Staff templates** as exportable packs — gap noted.
- **Trust / sandboxing / signing** of code-bearing packs — MVP copies tool code as-is with a UI warning; sketch where a permission/trust gate slots into `installPack`.
- **Hosted/remote registry with search** — `MarketplaceSource` abstraction kept open to a registry backend.

---

## 12. Test plan

### 12.1 Existing tests that MUST keep passing (the regression contract)

| Test | Pins | Preserved by |
|---|---|---|
| `tests/config-cascade.test.ts` | role model/thinkingLevel project>server>builtin; `origin`/`overrides` | §6.1 list = builtin<server<project with zero market packs |
| `tests/e2e/config-cascade-api.spec.ts` | `/api/roles` `/api/tools` origin/overrides over HTTP | §6.1 + §5.2 badge mapping |
| `tests/e2e/ui/config-scope.spec.ts` | scope rows, customize/revert UX, badges | §5.2 customize/override endpoints unchanged |
| `tests/config-directories.test.ts` | `parseCustomDirectories`, `getAllConfigDirectories` (13 builtin), `saveCustomDirectories` | legacy helpers retained, only consumed by `buildPackList` |
| `tests/e2e/per-project-config-dirs.spec.ts` | per-project config_directories behaviour incl. disablement | §6.3 (verify skills-disablement superset; add test if newly enforced) |
| `tests/e2e/tools-cascade.spec.ts` | tool group customize/override cascade | §6.1 tool loader + endpoints |
| `tests/skill-resolve.test.ts` | byte-equal slash expansion + precedence | §6.2 order identical, adapter reuses parse/sort/cache |
| `tests/validate-skill-discovery.test.ts` | skill discovery across dirs | §6.2 + §6.4 |
| `tests/skill-manifest.test.ts` | activation header/manifest | §6.4 (unchanged) |
| `tests/e2e/slash-skill-e2e.spec.ts` | end-to-end slash skills | §6.2 + §6.4 |

> Rule: if any of these fail, fix the mapping, not the test. If a behavior the reframe must preserve isn't currently pinned (e.g. skills disablement via `disabled_config_directories`), **add the test before refactoring**.

### 12.2 New unit tests (file:// fixtures)

Point at fixture pack trees under a tmp dir.

1. **Pack discovery & manifest parsing** — dir with/without `pack.yaml`; valid/invalid/forward-compat `pack.yaml`; `.pack-meta.yaml` round-trip.
2. **PackResolver core** — ordered list low→high; same-name shadow; `shadows[]` accumulation; `onlyTypes` filtering; `pack_conflicts` pin override.
3. **Per-type loaders** — RoleLoader/ToolLoader (`defaults-tree`, grouped+flat tools), SkillLoader (all three layouts).
4. **Three-scope resolution** — builtin/user/market across builtin<server<global-user<project; verify project wins, global-user beats server, within-scope user<market and `pack_order` reordering.
5. **Legacy→unified mapping equivalence** — build the list from fixtures mirroring §6.1/§6.2 and assert resolution **equals** the legacy `ConfigCascade`/`discoverSlashSkills` output for the same inputs (a direct A/B harness, like `skill-resolve.test.ts`'s `legacy()` fixture).
6. **`disabled_config_directories`** omits the matching entry.
7. **File ops** — `installPack` copies subtree + writes meta + appends `pack_order`; `uninstallPack` deletes exactly the added dir + cleans order; `updatePack` replaces contents + rewrites meta (preserves `installedAt`). Path-traversal guards reject unsafe names.
8. **Source store** — `MarketplaceSourceStore` CRUD + YAML persistence; local-dir vs git-url branching (mock git or use a local bare repo fixture).

### 12.3 Browser E2E (mandatory — pattern after `settings.spec.ts` + reuse `config-scope.spec.ts`)

`tests/e2e/ui/marketplace.spec.ts`:
1. **Market button** visible and positioned **between Workflows and New Goal**; opens the marketplace surface.
2. **Register source** (use a local-dir or fixture-repo source) → it appears in the sources list.
3. **Browse packs** → packs show description + declared entities.
4. **Install** a pack to a scope → its entities appear and resolve on `#/roles` / `#/tools` / `#/skills` with the pack as `origin` (badge present).
5. **Persists across reload.**
6. **Provenance** shown (source + version/commit + date).
7. **Update** (re-sync after upstream change reflected) and **Uninstall** (entities disappear; exactly what install added is removed).
8. **Executable-code warning** shown for a tool-bearing pack before install.
9. **Conflict warning icon** appears when two installed packs define the same entity name; reorder/pin resolves it.

### 12.4 Acceptance-criterion → test map

| Acceptance criterion | Test |
|---|---|
| Market button between Workflows and New Goal | E2E #1 |
| Register source + browse packs | E2E #2–3 |
| Install copies dir; entities resolve via single resolver tagged with pack origin | E2E #4 + unit #4,#7 |
| Existing overrides resolve identically | §12.1 suite + unit #5 |
| Provenance + update + uninstall (removes exactly what was added) | E2E #6–7 + unit #7 |
| Same-name conflicts → warning + configured precedence | E2E #9 + unit #2 |
| Tool-bearing packs show executable-code warning | E2E #8 |
| Re-sync + re-install reflects upstream | E2E #7 + unit #8 |

---

## 13. Implementation order (suggested)

1. **Types + parsers** — `PackManifest`/`PackMeta`/`PackEntry`/loader interfaces; `pack.yaml`/`.pack-meta.yaml` read-write; unit tests #1.
2. **PackResolver + loaders** — pipeline + Role/Tool/Skill loaders; unit tests #2–3.
3. **`buildPackList`** — the legacy mapping (§6); A/B equivalence tests #5; keep `ConfigCascade`/`discoverSlashSkills` as adapters delegating to the resolver; run full §12.1 suite green.
4. **Source store + git sync + file ops** — install/uninstall/update; unit tests #7–8.
5. **REST endpoints** (§9).
6. **UI** — Market button + marketplace page reusing config-scope conventions; E2E suite #12.3.
7. **Conflict surfacing + `pack_order`/`pack_conflicts`** persistence.

Each step lands behind passing tests; step 3 is the high-blast-radius gate — do not proceed to UI until the full existing suite is green on the resolver swap.
