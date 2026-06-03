# Marketplace MVP — Design Document

Status: **Design** (implementation-ready). Author: coder-3c24. Goal: *Marketplace MVP*.

This document is the single source of truth for the Marketplace MVP. It resolves every "Design-doc must resolve" item from the goal spec and gives a file-by-file implementation plan a coder can follow without further design work.

---

## 1. Overview & goals

### What the MVP delivers

A **Market** surface, reached from a new sidebar button (between **Workflows** and **New Goal**), that lets a user:

1. Register **sources** — git repos or local directories that contain Extension Packs.
2. **Sync** those sources (git clone/pull into a state cache; local dirs read in place).
3. **Browse** the **Extension Packs** each source contains, with name, description, version, contained entities, and an installed/up-to-date status.
4. **Install** a whole pack — copying each contained entity (roles, tools, skills) into a config layer the existing `ConfigCascade` / skill-discovery already reads, so the entities resolve exactly like hand-authored ones (same origin badges, same scope semantics).
5. See **provenance** for installed packs (which pack + source + commit), and **update** (re-sync + re-copy) or **uninstall** (symmetric removal of exactly what install added).

The headline unit of distribution is the **pack**, not the loose entity. A source contains one or more packs; a pack bundles several entity types around a theme.

### In scope (entity types a pack can install)

- **Roles** — `roles/<name>.yaml` → installed into a `RoleStore` config layer.
- **Tools** — `tools/<group>/` directory bundles (YAML descriptors + `extension.ts` + `_shared/`) → installed into a `ToolManager` config layer.
- **Skills** — `skills/<name>/SKILL.md` (+ optional `references/`, `scripts/`, `assets/`) → installed so `discoverSlashSkills` resolves them (see §6.3 for the definitive path).

### Non-goals (deferred to later phases — seams designed, nothing built)

These are intentionally excluded from the MVP but the architecture must leave explicit seams (see §8) so each is *additive* later, not a redesign:

- **UI Panels / plugins** (PR-Walkthrough-style, generalised to an installable plugin with its own tools) — the eventual headline use case.
- **Workflows** — currently project-scoped and bound to project-specific `(component, command)` pairs, so not portable today.
- **Staff definitions** — runtime state, not config today.
- **Trust / sandboxing / signing** of code-bearing bundles — MVP copies tool code as-is and surfaces a clear "installs executable code" warning, but no enforcement.
- **Hosted / remote registry** with search/discovery — MVP sources are git repos + local dirs only.

The unifying requirement: **entity-type set, bundle/source format, and install pipeline must all be extensible.**

### Key architectural anchors (verified against the codebase)

| Concern | Existing mechanism | File |
|---|---|---|
| Three-layer config resolution (builtin → server → project) | `ConfigCascade.resolveRoles/resolveTools(projectId)` | `src/server/agent/config-cascade.ts` |
| Role persistence | `RoleStore` → `roles/<name>.yaml` (one YAML/role) | `src/server/agent/role-store.ts`, `yaml-store.ts` |
| Tool persistence + cascade | `ToolManager`; group-level overlay; `tools/<group>/*.yaml` + `extension.ts` | `src/server/agent/tool-manager.ts` |
| Recursive dir copy | `copyDirRecursive(src, dest)` (exported) | `src/server/agent/tool-manager.ts` |
| Skill discovery | `discoverSlashSkills(cwd, projectConfigStore)` scans `.claude/skills`, `.bobbit/skills`, `~/.claude/skills`, `~/.bobbit/skills`, and **custom dirs** from `config_directories` | `src/server/skills/slash-skills.ts`, `agent/config-directories.ts` |
| Server config/state dirs | `bobbitConfigDir()` = `<server-root>/.bobbit/config`; `bobbitStateDir()` = `<server-root>/.bobbit/state` | `src/server/bobbit-dir.ts` |
| Per-project config/state dirs | `ProjectContext.configDir` / `.stateDir` = `<project-root>/.bobbit/{config,state}` | `src/server/agent/project-context.ts` |
| Server-global JSON store pattern (atomic write) | `ProjectRegistry` → `<stateDir>/projects.json` | `src/server/agent/project-registry.ts` |
| Config page UI conventions (origin badges, scope tabs) | `config-scope.ts` (`getConfigScope`, `renderConfigScopeRow`, `renderOriginBadge`) | `src/app/config-scope.ts` |
| Sidebar config buttons | Workflows + New Goal row | `src/app/sidebar.ts` (~1382–1403) |
| Hash routing | `RouteView`, `getRouteFromHash`, `setHashRoute`, `toggleConfigPage` | `src/app/routing.ts` |
| Page mount switch | `mainArea()` route dispatch via `lazyPage(...)` | `src/app/render.ts` (~2400) |

**Scope vocabulary.** The UI calls the server layer **"system"** (config-scope `"system"`, `projectId` omitted) and project layers by project id. The REST `customize`/`override` endpoints use `scope=server|project` + `projectId`. The marketplace reuses this exact vocabulary: install scope is **`system`** (server layer) or **`project`** (a specific project).

---

## 2. Source & pack layout

### 2.1 Source layout convention

A **source** is a git repo or a local directory. Its **top level is a collection of pack directories** — never a flat `defaults/` mirror. A directory is a **pack iff it contains a `pack.yaml`**; directories without one are ignored (so a source repo may carry a README, CI config, etc. at the top level without confusing the scanner). Pack scanning is **one level deep** — only immediate children of the source root are considered.

```
<source-root>/
  research-pack/
    pack.yaml                       # REQUIRED — makes this dir a pack
    roles/
      researcher.yaml
      lit-reviewer.yaml
    tools/
      research/
        web_dig.yaml
        extension.ts
        _shared/
          http.ts
    skills/
      deep-research/
        SKILL.md
        references/
          methodology.md
  qa-pack/
    pack.yaml
    roles/qa-lead.yaml
    tools/qa/ ...
  README.md                         # ignored (no pack.yaml)
  .github/                          # ignored
```

The entity payload layout *inside* each pack mirrors Bobbit's `defaults/` tree exactly:

- `roles/<name>.yaml` — same shape as `defaults/roles/<name>.yaml` (see `RoleStore.serializeRole`).
- `tools/<group>/` — same shape as `defaults/tools/<group>/` (YAML descriptors + `extension.ts` + `_shared/`).
- `skills/<name>/SKILL.md` — same shape as `defaults/skills/<name>/SKILL.md` (YAML frontmatter + markdown body + optional `references/`, `scripts/`, `assets/`).

### 2.2 `pack.yaml` schema (exact)

`pack.yaml` is the pack's identity and a **declaration** of its contents. The declaration is the contract the scanner validates against the on-disk payload — a declared entity that is missing on disk is a pack error; an on-disk entity that is *not* declared is ignored (declaration is authoritative). This keeps install deterministic and lets a pack author intentionally ship example/unsupported files without them being installed.

```yaml
# pack.yaml
apiVersion: 1                 # REQUIRED (int). Schema version. MVP accepts only 1.
id: research-pack             # REQUIRED (string). Stable pack id, unique within the source.
                              #   Pattern: ^[a-z0-9][a-z0-9-]*$ . Used in provenance + dir name.
name: Research Pack           # REQUIRED (string). Human display name.
description: >                # REQUIRED (string). One–three sentences shown in the browse list.
  Research-focused roles, a web-digging tool, and a deep-research skill.
version: 1.2.0                # REQUIRED (string). Author-declared semver-ish label. Surfaced in UI
                              #   and provenance. NOT used for ordering logic in the MVP (commit SHA
                              #   is the real freshness signal for git sources).
author: jane@example.com      # OPTIONAL (string).
homepage: https://...         # OPTIONAL (string, URL).
license: MIT                  # OPTIONAL (string).
minBobbit: "0.80.0"           # OPTIONAL (string). Advisory only in MVP (shown, not enforced).

contents:                     # REQUIRED (object). Declares what the pack installs, per entity type.
                              #   Every key is OPTIONAL but at least one non-empty list is REQUIRED.
  roles:                      # list of role names (file basenames, no .yaml). Must match roles/<name>.yaml.
    - researcher
    - lit-reviewer
  tools:                      # list of tool GROUP dirs (matches tools/<group>/). Group-level, like the
                              #   ToolManager cascade (a group is replaced wholesale).
    - research
  skills:                     # list of skill names (matches skills/<name>/ containing SKILL.md).
    - deep-research
```

#### Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `apiVersion` | int | yes | MVP accepts `1` only. Forward-compat gate; unknown versions → pack flagged "unsupported", not installed. |
| `id` | string | yes | `^[a-z0-9][a-z0-9-]*$`. Unique within a source. Identity key in provenance. |
| `name` | string | yes | Display name. |
| `description` | string | yes | Shown in browse list + drill-down. |
| `version` | string | yes | Display + provenance. Not used for comparison logic (commit SHA is). |
| `author` / `homepage` / `license` / `minBobbit` | string | no | Metadata, displayed; `minBobbit` advisory only. |
| `contents.roles` | string[] | no* | Role file basenames (no extension). |
| `contents.tools` | string[] | no* | Tool **group** directory names. |
| `contents.skills` | string[] | no* | Skill directory names (each must contain `SKILL.md`). |

\* At least one of `contents.{roles,tools,skills}` must be a non-empty list, else the pack is invalid (it installs nothing).

#### Validation rules (scanner)

A pack is **valid** when: `pack.yaml` parses; `apiVersion === 1`; `id`/`name`/`description`/`version` are non-empty strings; `id` matches the pattern; `contents` has ≥1 non-empty supported list; and **every declared entity exists on disk** with the right shape:

- role `r` → `roles/<r>.yaml` exists and parses via the same `parseRole` logic.
- tool group `g` → `tools/<g>/` is a directory containing ≥1 `*.yaml` with a `name:` field.
- skill `s` → `skills/<s>/SKILL.md` exists.

Validation failures are **non-fatal at the source level**: an invalid pack is surfaced in the browse list with an `error` string and is **not installable**; sibling valid packs in the same source remain usable.

#### Unknown-key forward-compat

Unknown top-level keys and unknown keys under `contents` (e.g. a future `contents.panels`) are **preserved and ignored** by the MVP scanner (not an error). This is what lets a future entity type ship in a pack today and be installed once a handler exists — see §8.

---

## 3. Source registry

### 3.1 Persistence scope — **server-global** (recommended)

The list of configured sources persists **server-globally**, not per project.

**Rationale.** A source answers "where do I fetch packs from?" — a machine/user-level concern, independent of any project. The same source typically serves many projects. Git credentials are the user's ambient git creds (one identity per machine). Per-project source lists would force re-registering the same repos for every project and complicate the zero-project (system-only) install flow that the cascade already supports. Install *scope* is still chosen per-install (system vs project) — only the *source list* is global.

This mirrors `ProjectRegistry`, which is itself a server-global JSON store under `bobbitStateDir()`.

### 3.2 On-disk shape & location

```
<server-root>/.bobbit/state/marketplace/
  sources.json                      # the source registry
  <source-id>/                      # per-source sync cache (git clone or symlink marker; see §4)
```

`sources.json` (atomic write: temp file + rename, like `ProjectRegistry.save()`):

```jsonc
{
  "version": 1,
  "sources": [
    {
      "id": "a1b2c3d4",              // randomUUID().slice(0,8) — stable, used as cache dir name
      "kind": "git",                 // "git" | "local"
      "url": "https://github.com/acme/bobbit-packs.git",  // git sources only
      "ref": "main",                 // OPTIONAL git ref/branch/tag; default = remote HEAD
      "path": null,                  // local sources only: absolute dir path
      "label": "Acme Packs",         // OPTIONAL display label; defaults to repo/dir basename
      "addedAt": 1780000000000,
      "lastSyncedAt": 1780000050000, // null until first successful sync
      "lastSyncCommit": "9f8e7d6…",  // git sources: HEAD SHA after last sync; null for local
      "lastSyncError": null          // string when the last sync failed, else null
    }
  ]
}
```

### 3.3 Registry API (server-global, no `projectId`)

| Method | Route | Body / params | Effect |
|---|---|---|---|
| GET | `/api/marketplace/sources` | — | List sources with sync status. |
| POST | `/api/marketplace/sources` | `{ kind, url?, ref?, path?, label? }` | Validate + add; assign `id`; kick a first sync (async); return the record. |
| DELETE | `/api/marketplace/sources/:id` | — | Remove from registry + delete the sync cache dir. Does **not** uninstall packs that came from it (installed entities are independent copies). |
| POST | `/api/marketplace/sources/:id/sync` | — | Re-sync (clone/pull) the source; return updated status. |

Validation on POST: `kind` ∈ {git, local}; git requires a non-empty `url`; local requires an existing absolute `path` (reject relative paths and non-existent dirs with 400, mirroring project preflight rigor). `ref` is optional.

---

## 4. Sync mechanism

`MarketplaceSyncService` owns clone/pull and cache layout. Cache root: `path.join(bobbitStateDir(), "marketplace")`.

### 4.1 Git sources

- **First sync** → **shallow clone**: `git clone --depth 1 [--branch <ref>] <url> <cacheDir>/<id>`. Shallow keeps the cache small (packs are small text trees).
- **Re-sync** → **fetch + hard reset** to the tracked ref, not a plain `pull`, to avoid merge conflicts in a cache the user never edits:
  `git -C <dir> fetch --depth 1 origin <ref>` then `git -C <dir> reset --hard FETCH_HEAD` then `git -C <dir> clean -fdx`.
  If the cache dir is missing or corrupt (no `.git`), fall back to a fresh clone (reclone).
- **Commit capture**: after sync, record `lastSyncCommit = git -C <dir> rev-parse HEAD`. This SHA is the real freshness signal used by update detection (§7).
- **Auth**: rely entirely on the user's ambient git credentials (credential helper / SSH agent / `GIT_*` env). The MVP does **not** store or prompt for credentials. A failed auth surfaces as `lastSyncError`. Tokens embedded in URLs are accepted but stripped from any surfaced/logged URL using the existing `strip-token-git-url` helper (see `tests/strip-token-git-url.test.ts`).
- **Timeouts / errors**: run git via a child process with a bounded timeout (e.g. 120s). On failure, set `lastSyncError`, leave any previous good cache intact, and return a structured error to the client.

### 4.2 Local-dir sources

Read **in place** — no copy, no clone. The "cache dir" for a local source is the source `path` itself; `lastSyncCommit` is `null`. A "sync" for a local source is a no-op that simply re-validates that `path` still exists (and refreshes `lastSyncError`). The scanner always reads the live directory, so local sources reflect on-disk edits immediately (good for pack authors iterating locally).

### 4.3 Resolving a source's scan root

```
syncRoot(source):
  git   → <bobbitStateDir>/marketplace/<id>     (the clone)
  local → source.path                            (read in place)
```

---

## 5. Browse model

`MarketplacePackScanner` turns a synced source root into a list of `ScannedPack`. The browse API composes scanner output across all sources and annotates install status from provenance (§7).

### 5.1 Scanner

```ts
interface ScannedEntity {
  type: "role" | "tool" | "skill";
  name: string;            // role/skill name, or tool GROUP name
  // resolved absolute source path of the payload (file for role, dir for tool group/skill)
  sourcePath: string;
}

interface ScannedPack {
  sourceId: string;
  packId: string;          // pack.yaml id
  dir: string;             // absolute pack dir within syncRoot
  manifest: PackManifest;  // parsed pack.yaml
  entities: ScannedEntity[];
  hasTools: boolean;       // any tool entity → drives the "executable code" warning (§9)
  valid: boolean;
  error?: string;          // populated when !valid
}
```

`scanSource(source)`:
1. `root = syncRoot(source)`; if missing → return `[]` (and surface `lastSyncError`).
2. `readdirSync(root, { withFileTypes: true })`, one level deep, dirs only.
3. For each dir containing `pack.yaml`: parse + validate (§2.2); build `ScannedPack` (valid or with `error`).
4. Dirs without `pack.yaml` → ignored.

### 5.2 Browse API

| Method | Route | Effect |
|---|---|---|
| GET | `/api/marketplace/packs?scope=system\|project&projectId=…` | List packs across all sources, each annotated with install status **for the requested scope**. |
| GET | `/api/marketplace/packs/:sourceId/:packId?scope=…&projectId=…` | Drill-down: full manifest + per-entity detail + per-entity install status. |

Pack listing shape (browse list):

```jsonc
{
  "packs": [{
    "sourceId": "a1b2c3d4", "packId": "research-pack",
    "name": "Research Pack", "description": "…", "version": "1.2.0",
    "sourceLabel": "Acme Packs",
    "entities": [
      { "type": "role",  "name": "researcher" },
      { "type": "tool",  "name": "research" },
      { "type": "skill", "name": "deep-research" }
    ],
    "hasTools": true,
    "valid": true,
    "installStatus": "not-installed",   // "not-installed" | "installed" | "update-available" | "drifted"
    "installedVersion": null,
    "installedCommit": null
  }]
}
```

`installStatus` is computed by comparing provenance (§7) for the requested scope against the scanned pack:
- `not-installed` — no provenance record for `(sourceId, packId)` at this scope.
- `installed` — provenance exists; `lastSyncCommit` (git) or content hash matches what was installed.
- `update-available` — provenance exists but the source's current `lastSyncCommit` differs from the installed commit (git), or content hash differs (local).
- `drifted` — provenance exists but an installed entity file is missing/edited locally (best-effort; surfaced so the user knows uninstall/update may be partial).

---

## 6. Install pipeline

### 6.1 Whole-pack install (primary) + individual-entity install (allowed)

**Decision: installing the whole pack is the primary action; installing an individual entity from a pack IS allowed** (drill-down view exposes a per-entity install button). Rationale: the install primitive is naturally per-entity (each entity copies independently), whole-pack install is just "install every declared entity," and per-entity install costs nothing extra while giving users a clean way to take, e.g., only the role from a pack. Provenance (§7) records exactly which entities were installed, so uninstall is symmetric whether the user installed the whole pack or a subset.

Both flows go through one engine: `installEntities(scope, projectId, source, pack, entities[])`.

### 6.2 Install scope model & interaction with the cascade

Install scope is **`system`** or **`project`**, reusing the existing config-scope vocabulary:

| Scope | Roles target | Tools target | Skills target |
|---|---|---|---|
| `system` (server layer) | `<server-root>/.bobbit/config/roles/<name>.yaml` | `<server-root>/.bobbit/config/tools/<group>/` | `~/.bobbit/skills/<name>/` (see §6.3) |
| `project` | `<project-root>/.bobbit/config/roles/<name>.yaml` | `<project-root>/.bobbit/config/tools/<group>/` | `<project-root>/.bobbit/config/skills/<name>/` + register custom dir (see §6.3) |

These are exactly the directories the `ConfigCascade` already reads:
- **Roles** — system writes resolve as `origin: "server"`; project writes as `origin: "project"`. They shadow lower layers per the existing cascade merge (`ConfigCascade.resolveRoles`). The origin badge and "overrides" indicator come for free.
- **Tools** — the `ToolManager` overlay is **group-level**: a group present in a higher layer replaces the entire builtin group. Installing a tool group at project scope therefore shadows any builtin/server group of the same name. This is the same semantics as the existing `/api/tools/:name/customize` copy.

**Default scope.** The Market page reuses `config-scope.ts`: the page's scope tabs default to **System** when no project is active and otherwise to the active project (matching role/tool pages). The install button label reflects the active scope ("Install to System" / "Install to <Project>").

### 6.3 Skills install path — **definitively resolved**

There is **no `.bobbit/config/skills/` cascade** today; `discoverSlashSkills` resolves skills from the **session cwd** (a worktree), not from the project root the server reads roles/tools from. A naive `<project-root>/.bobbit/config/skills` would *not* be scanned, because sessions run in sibling worktrees whose cwd is not the project root, and `.bobbit/config/` is committed-but-not-necessarily-present-in-a-fresh-worktree-branch.

The discovery code **does** scan **custom directories** registered in project config (`config_directories`, type `"skills"`), and those are resolved as **absolute paths** (`expandPath` → `path.resolve`) regardless of session cwd (`src/server/agent/config-directories.ts`, `parseCustomDirectories`). It also always scans `~/.bobbit/skills` (user scope, global).

**Therefore:**

- **Project scope** → install skills to **`<project-root>/.bobbit/config/skills/<name>/`** AND ensure the project's `config_directories` contains `{ path: "<project-root>/.bobbit/config/skills", types: ["skills"] }` (idempotent add via `saveCustomDirectories`). Because the custom dir is an absolute path, every session of that project — in any worktree — resolves the skill. This co-locates skills with roles/tools under `.bobbit/config/` (committed, team-shared) and reuses the existing custom-dir plumbing with zero changes to skill discovery.
- **System scope** → install skills to **`~/.bobbit/skills/<name>/`**, which `discoverSlashSkills` already scans unconditionally for every session on the machine. No registration needed.

This is the definitive resolution. (Rejected alternative: writing into the repo's `.claude/skills/` — that requires a git commit to propagate to worktrees and pollutes the user's tracked tree; the custom-dir approach needs neither.)

### 6.4 Install algorithm (per entity)

```
installEntity(scope, projectId, syncRoot, entity):
  switch entity.type:
    role:
      src  = <packDir>/roles/<name>.yaml
      dest = <roleConfigDir(scope, projectId)>/<name>.yaml
      conflict-check(dest); copyFile(src, dest)
      installedPaths = [dest]
    tool:                                   # group-level
      src  = <packDir>/tools/<group>/       # directory
      dest = <toolConfigDir(scope, projectId)>/<group>/
      conflict-check(dest); copyDirRecursive(src, dest)   # reuse tool-manager.copyDirRecursive
      installedPaths = [dest]               # whole group dir
    skill:
      src  = <packDir>/skills/<name>/       # directory incl. SKILL.md + resources
      dest = <skillInstallDir(scope, projectId)>/<name>/
      conflict-check(dest); copyDirRecursive(src, dest)
      if scope == project: ensureCustomSkillDir(projectId, skillInstallDir)
      installedPaths = [dest]
  return { type, name, installedPaths }
```

After install, **invalidate caches** so the new entities resolve immediately:
- Roles: `RoleStore` reloads on read (`getAll` calls `reload()`), so no action needed; but call `ctx.roleStore.reload()` defensively.
- Tools: the `ToolManager` scan cache is mtime-keyed and Windows mtime is coarse — call the existing `__resetToolScanCache()` (already used after tool writes) for the affected tools dir.
- Skills: `discoverSlashSkills` has a 5s TTL cache keyed on cwd+config; registering the custom dir bumps the config value and naturally invalidates it.

### 6.5 Conflict handling

A **conflict** is: the destination already exists *at the target scope* (role file, tool group dir, or skill dir present).

The install API accepts a `conflict` mode (query param or body field), defaulting to **`fail`**:

- `fail` (default) — abort the whole install transactionally if any entity conflicts; return `409` with the conflicting entity list. Nothing is written. The UI then offers the user a choice.
- `overwrite` — replace the existing entity at this scope. Because the install may be overwriting a *previously marketplace-installed* entity, the new provenance supersedes the old record for that entity.
- `skip` — install only the non-conflicting entities; report which were skipped.

Conflicts are evaluated against the **same scope only** — installing at project scope when a builtin/server role of the same name exists is **not** a conflict (it is the normal cascade-shadow behavior, surfaced via the origin "overrides" badge). The UI explains this.

**Transactionality.** Install computes the full plan, runs all conflict checks first, then copies. If a copy fails midway, already-copied entities for that install are rolled back (delete `installedPaths`) so the system is never left half-installed; the provenance record is written only after all copies succeed.

### 6.6 Install API

| Method | Route | Body | Effect |
|---|---|---|---|
| POST | `/api/marketplace/install` | `{ sourceId, packId, scope, projectId?, entities?, conflict? }` | Install. `entities` omitted ⇒ whole pack (all declared). `entities` = array of `{type,name}` ⇒ subset. Returns provenance record + per-entity result. |
| POST | `/api/marketplace/update` | `{ sourceId, packId, scope, projectId? }` | Re-sync source, then re-copy exactly the entities in the existing provenance record (overwrite), updating commit/version. |
| POST | `/api/marketplace/uninstall` | `{ sourceId, packId, scope, projectId? }` | Remove exactly the `installedPaths` from provenance; deregister the custom skill dir if it becomes empty; delete provenance record. |

---

## 7. Provenance

### 7.1 Record shape

Provenance is what makes update/uninstall symmetric: it records the **exact paths** install wrote, so uninstall removes exactly those and nothing else.

```jsonc
{
  "version": 1,
  "installs": [
    {
      "scope": "project",              // "system" | "project"
      "projectId": "f1e2…",            // null for system scope
      "sourceId": "a1b2c3d4",
      "packId": "research-pack",
      "packName": "Research Pack",
      "packVersion": "1.2.0",          // pack.yaml version at install time
      "sourceKind": "git",
      "sourceUrl": "https://…",        // token-stripped; null for local
      "sourceCommit": "9f8e7d6…",      // lastSyncCommit at install time; null for local
      "sourceContentHash": null,       // local sources: hash of installed payloads (freshness signal)
      "installedAt": 1780000100000,
      "entities": [
        { "type": "role",  "name": "researcher",
          "installedPaths": ["/abs/.bobbit/config/roles/researcher.yaml"] },
        { "type": "tool",  "name": "research",
          "installedPaths": ["/abs/.bobbit/config/tools/research"] },
        { "type": "skill", "name": "deep-research",
          "installedPaths": ["/abs/.bobbit/config/skills/deep-research"],
          "customDirRegistered": "/abs/.bobbit/config/skills" }
      ]
    }
  ]
}
```

The record key is the tuple **`(scope, projectId, sourceId, packId)`** — unique; re-installing the same pack at the same scope supersedes its record.

### 7.2 Where provenance lives

Provenance is **committed alongside the entities it tracks**, per scope, so uninstall is symmetric on any machine that has the entities:

- **System scope** → `<server-root>/.bobbit/config/marketplace/installed.json`
- **Project scope** → `<project-root>/.bobbit/config/marketplace/installed.json`

Rationale: installed entities live in committed `.bobbit/config/`; provenance must travel with them so a teammate who pulls the repo can cleanly uninstall/update. (The **source registry** by contrast is per-machine runtime state in `.bobbit/state/` — see §3.2 — because it is about fetch locations + credentials, not installed artifacts.)

A small `ProvenanceStore` (JSON, atomic write, mirrors `ProjectRegistry`) wraps each file; the server resolves the right file from `(scope, projectId)`.

### 7.3 Update & uninstall using provenance

- **Update**: `sync(source)` → read provenance entities → re-run `installEntities(..., conflict=overwrite)` for exactly those entities → rewrite the record with the new `sourceCommit`/`packVersion`. Entities that the new pack version *no longer declares* are removed (so update never leaves orphans); entities newly declared are **not** auto-added (update is "refresh what I have," matching whole-pack/subset install intent) — the UI shows "N new entities available; re-install pack to add."
- **Uninstall**: for each entity, delete its `installedPaths` (recursive for dirs). For skills at project scope, if the custom skill dir is now empty, deregister it from `config_directories` (and remove the empty dir). Delete the provenance record. Invalidate the same caches as install (§6.4).

---

## 8. Extensibility seams

The MVP must make new entity types and new distribution backends **additive**. Three abstraction boundaries deliver that.

### 8.1 Entity-type registry + install-handler-per-type

Define a single registry mapping an entity type to its behavior:

```ts
interface EntityTypeHandler {
  type: string;                                   // "role" | "tool" | "skill" | future: "panel" | "workflow" | "staff"
  /** key under pack.yaml `contents` */
  manifestKey: string;                            // "roles" | "tools" | "skills" | "panels" | …
  /** verify the declared entity exists/parses in a pack dir */
  validate(packDir: string, name: string): { ok: boolean; error?: string };
  /** resolve the destination for a scope and copy; returns installedPaths + side-effects */
  install(ctx: InstallCtx, packDir: string, name: string): InstalledEntity;
  /** remove exactly what install wrote (given the provenance entity) */
  uninstall(ctx: InstallCtx, entity: InstalledEntity): void;
  /** does this type carry executable code? drives the §9 warning */
  carriesCode: boolean;
}

const ENTITY_HANDLERS: Record<string, EntityTypeHandler> = {
  role:  roleHandler,
  tool:  toolHandler,     // carriesCode: true
  skill: skillHandler,
};
```

The scanner, browse annotator, install/update/uninstall engine, and the "installs executable code" check all iterate `ENTITY_HANDLERS` rather than hardcoding role/tool/skill. **Adding a new entity type is one new handler + one registry entry** — no changes to the scan/install/uninstall control flow. Unknown `contents` keys are already preserved by the scanner (§2.2), so a pack can ship a `panels:` list today and become installable the moment a `panelHandler` is registered.

#### How each deferred type slots in (no redesign)

- **UI Panels / plugins** — add `panelHandler` with `manifestKey: "panels"`, `carriesCode: true`. A panel bundle is a directory (`panels/<id>/` with a manifest declaring its tools + a renderer entry, à la PR-Walkthrough). `install` copies the bundle into a panel config dir and registers it the way panels are discovered (a future panel-registry, analogous to the tools overlay). The pack/source layout already supports a `panels/` payload dir; nothing about §2 changes.
- **Portable workflows** — add `workflowHandler` with `manifestKey: "workflows"`. The hard part is **not** the marketplace — it is that workflows today bind to project-specific `(component, command)` pairs and live inline in `project.yaml` (`ConfigCascade.resolveWorkflows` is project-only, no builtin/server layer). The seam: when portable/parameterised workflows exist, `workflowHandler.install` writes into the project's workflow store and maps declared parameters to project components. The doc-level note for that future phase: a portable workflow must declare its required component *roles* abstractly and the install step must prompt the user to bind them — that binding step is the only new UI.
- **Staff templates** — add `staffHandler` with `manifestKey: "staff"`. Staff are runtime state (`StaffStore` under `.bobbit/state`), not config, so the future phase first needs an exportable *template* shape; once that exists, `install` instantiates a staff record from the template. No marketplace-core change.
- **Trust / permission model** — `EntityTypeHandler.carriesCode` already marks code-bearing types. The seam for enforcement: insert a `TrustPolicy.check(pack, source)` gate in the install engine *before* `handler.install` runs. MVP's implementation is a no-op that only drives the §9 warning; a future phase makes it consult a signature/allowlist and can block. The call site exists from day one.

### 8.2 Source backend interface (registry-ready)

Sync + scan talk to sources through one interface so a hosted registry is a new backend, not a rewrite:

```ts
interface SourceBackend {
  kind: string;                       // "git" | "local" | future: "registry"
  sync(source): Promise<SyncResult>;  // returns { root, commit?, contentHash?, error? }
  // scanning always operates on the returned `root`, so it is backend-agnostic
}
```

MVP ships `GitSourceBackend` and `LocalSourceBackend`. A future **`RegistrySourceBackend`** implements `sync` by fetching a pack index + downloading pack tarballs into the same cache layout (`<stateDir>/marketplace/<id>/`), after which the *identical* scanner/install pipeline runs. The browse API would gain optional search params, but the install path is unchanged. `sources.json` already carries a `kind` discriminator (§3.2) so adding `"registry"` is additive.

### 8.3 Summary of boundaries

| Future addition | Touches | Does NOT touch |
|---|---|---|
| New entity type (panel/workflow/staff) | one `EntityTypeHandler` + registry entry + pack `contents` key | scan/install/uninstall control flow, source backends, REST routes |
| Trust/signing enforcement | `TrustPolicy.check` body (call site pre-exists) | handlers, scanner, UI (warning already present) |
| Hosted registry | one `SourceBackend` + `kind: "registry"` | scanner, install engine, provenance |

---

## 9. "Installs executable code" warning

A pack that contains **any tool entity** (and, in future, any `carriesCode` entity such as a panel) ships executable `extension.ts`. The MVP performs **no sandboxing or signing** of this code, so the UI must make the risk explicit.

- **Browse list**: packs with `hasTools === true` show a small "code" badge (e.g. a warning-tinted chip "executable code") next to the pack name.
- **Drill-down**: a prominent inline notice: *"This pack installs executable code (tools) that runs with your agent's privileges. Bobbit does not sandbox or verify pack code. Only install packs from sources you trust."*
- **Install confirmation**: when the install target includes ≥1 code-bearing entity, the confirm dialog repeats the warning and requires explicit confirmation before the POST. (`confirmAction(...)` from `src/app/dialogs.ts`, used elsewhere for destructive confirms.)

The decision of *whether* an entity is code-bearing comes from `EntityTypeHandler.carriesCode`, so the warning automatically covers future code-bearing types.

---

## 10. File-by-file implementation plan

### 10.1 New server files

```
src/server/marketplace/
  types.ts                  # PackManifest, ScannedPack, ScannedEntity, SourceRecord,
                            #   ProvenanceRecord, InstalledEntity, InstallCtx, scope types.
  source-registry.ts        # SourceRegistry: load/save sources.json (atomic write, mirrors
                            #   ProjectRegistry). add/remove/list/get; id assignment.
  sync-service.ts           # MarketplaceSyncService + SourceBackend interface +
                            #   GitSourceBackend (shallow clone / fetch+reset+clean / rev-parse)
                            #   + LocalSourceBackend (read in place). Token-strip URLs.
  pack-scanner.ts           # parsePackManifest(), validatePack(), scanSource(root) → ScannedPack[].
  entity-handlers.ts        # ENTITY_HANDLERS registry + roleHandler/toolHandler/skillHandler
                            #   (validate/install/uninstall/carriesCode). Uses copyDirRecursive,
                            #   RoleStore paths, ToolManager dirs, config-directories helpers.
  install-service.ts        # installEntities(), update(), uninstall(); conflict detection +
                            #   transactional copy/rollback; cache invalidation; TrustPolicy.check
                            #   no-op seam.
  provenance-store.ts       # ProvenanceStore per (scope, projectId): load/save installed.json
                            #   (atomic write); upsert/remove/find by (scope,projectId,sourceId,packId).
```

Path-resolution helpers these modules need (all derivable from existing exports):
- role config dir: `path.join(scopeConfigDir, "roles")` where `scopeConfigDir = bobbitConfigDir()` (system) or `ctx.configDir` (project).
- tool config dir: `path.join(scopeConfigDir, "tools")`.
- skill install dir: project → `path.join(ctx.configDir, "skills")` + `saveCustomDirectories`; system → `path.join(os.homedir(), ".bobbit", "skills")`.
- sync cache root: `path.join(bobbitStateDir(), "marketplace")`.

### 10.2 Edited server files

- **`src/server/server.ts`** — add the `/api/marketplace/*` routes inside `handleApiRoute()`, modeled on the existing `/api/tools/:name/customize` block (~4443) for scope/projectId handling. Wire singletons: construct `SourceRegistry`, `MarketplaceSyncService`, `MarketplacePackScanner`, `InstallService` near where `toolManager`/`roleStore` are built (~834), and pass what the routes need (they already have `projectContextManager`, `toolManager`, `configCascade` in scope). Reuse `__resetToolScanCache` import for tool-install cache invalidation.
- **`src/server/agent/config-directories.ts`** — no change required (reuse `parseCustomDirectories` / `saveCustomDirectories`). Note in code comments that the marketplace registers the project skills dir here.

### 10.3 New UI files

```
src/app/market-page.ts        # renderMarketPage(...) + loadMarketPageData(); list view (sources +
                              #   packs) and pack drill-down view. Reuses config-scope.ts:
                              #   getConfigScope/renderConfigScopeRow/renderOriginBadge. Install/
                              #   update/uninstall actions via gatewayFetch. "executable code" badge
                              #   + confirm via dialogs.confirmAction.
src/app/market-source-dialog.ts  # add-source modal (kind = git|local, url/ref/path/label), POST
                              #   /api/marketplace/sources, optimistic sync status.
src/app/market-page.css       # page styles (mirror workflow-page.css conventions / .config-* classes).
```

Add API helpers to **`src/app/api.ts`**: `fetchMarketSources`, `addMarketSource`, `removeMarketSource`, `syncMarketSource`, `fetchMarketPacks(scope, projectId)`, `fetchMarketPack(...)`, `installPack(...)`, `updatePack(...)`, `uninstallPack(...)`.

### 10.4 Edited UI files

- **`src/app/sidebar.ts`** (~1382–1403) — insert a **Market** button in the second config-button row, **between** the Workflows button and the New Goal button. Pattern-match the Workflows button exactly:
  ```ts
  // after the Workflows <button>, before the New Goal <button>
  <button class="… ${isMarketActive ? '…active…' : '…'}"
    @click=${() => toggleConfigPage(["market", "market-pack"], () => {
      import("./market-page.js").then(m => m.loadMarketPageData());
      import("./routing.js").then(m => m.setHashRoute("market"));
    })}
    title="Browse extension marketplace">
    ${icon(Store, "xs", "!w-3.5 !h-3.5")}<span>Market</span>
  </button>
  ```
  Add `const isMarketActive = isRouteActive("market", "market-pack");` next to the other `is*Active` flags. Import a `Store`/`ShoppingBag` icon from `lucide`.
- **`src/app/routing.ts`** — add `"market"` and `"market-pack"` to `RouteView`; add to `CONFIG_VIEWS`; add `getRouteFromHash` cases (`#/market`, `#/market/:sourceId/:packId`); add `setHashRoute` cases.
- **`src/app/render.ts`** (~2400 `mainArea()`) — add:
  ```ts
  if (route.view === "market" || route.view === "market-pack") {
    return lazyPage("market", () => import("./market-page.js"), "renderMarketPage");
  }
  ```
- **`src/app/main.ts`** — add `import "./market-page.css";` (eager CSS, mirroring `workflow-page.css`); add the route-load branches alongside the existing `route.view === "workflows"` handlers (~270, ~491) to call `loadMarketPageData()` on direct navigation/reload.

### 10.5 Defaults / fixtures (not production, but shipped)

- Optionally ship a tiny **example source** under `tests/fixtures/marketplace/` (a 2-pack tree) used by both unit and E2E tests (see §11). No production `defaults/` change is required for the MVP.

---

## 11. Test plan

Follows AGENTS.md: unit via `file://` fixtures; one mandatory browser E2E for the user-facing flow, patterned after the config-page UI E2Es (`tests/e2e/ui/workflow-page-scope.spec.ts`, `tests/e2e/ui/tool-assistant-system-scope.spec.ts`).

### 11.1 Unit tests (`tests/marketplace-*.test.ts`, fixture trees)

Build a fixture source tree under `tests/fixtures/marketplace/source-a/` with: a valid `research-pack` (role + tool group + skill), a valid `roles-only-pack`, an **invalid** pack (declares a role that doesn't exist), and a non-pack dir (no `pack.yaml`).

1. **`marketplace-pack-scanner.test.ts`**
   - Scans only dirs with `pack.yaml`; ignores the non-pack dir.
   - Parses `pack.yaml` fields; rejects `apiVersion !== 1` (unsupported, not crash).
   - Validates declared-vs-on-disk: invalid pack surfaces `error`, valid siblings still returned.
   - `hasTools` true iff a tool entity is declared.
2. **`marketplace-install.test.ts`** (point config dirs at a temp dir)
   - Whole-pack install copies role yaml, tool group dir (recursive, incl. `extension.ts` + `_shared/`), and skill dir to the correct scope paths.
   - Project-scope skill install also registers the custom skills dir in project config (`config_directories`), and the path is absolute.
   - Subset install copies only the requested entities.
   - Installed role resolves through `ConfigCascade.resolveRoles(projectId)` with the expected `origin` (server vs project) — reuses `config-cascade.test.ts` harness style.
3. **`marketplace-conflict.test.ts`**
   - `fail` mode: pre-existing dest at same scope → 409-equivalent, nothing written.
   - `overwrite` / `skip` behave as specified.
   - Same-name builtin at a *lower* layer is **not** a conflict (cascade shadow).
   - Mid-copy failure rolls back partial writes.
4. **`marketplace-provenance.test.ts`**
   - Install writes a provenance record with exact `installedPaths` at the right file (system vs project).
   - Uninstall removes exactly those paths and the record; deregisters an emptied custom skill dir.
   - Update re-copies recorded entities, refreshes commit/version, and drops entities the new version no longer declares.
5. **`marketplace-source-registry.test.ts`**
   - add/remove/list round-trips through `sources.json` (atomic write); id assignment; local-path validation rejects relative/missing paths.
   - (Git sync covered at integration level; unit test uses a `LocalSourceBackend` source to keep it hermetic.)

### 11.2 Browser E2E (`tests/e2e/ui/marketplace.spec.ts`) — mandatory

Pattern after `workflow-page-scope.spec.ts`: create a temp project, point a **local** marketplace source at the fixture tree, drive the UI.

1. **Market button** is visible in the sidebar **between Workflows and New Goal**, and clicking it opens the Market surface (`#/market`).
2. **Add source** — open the add-source dialog, add a `local` source pointing at the fixture tree; the source appears with sync status.
3. **Browse packs** — the fixture packs list with name/description/version/contained entities; a tool-bearing pack shows the "executable code" badge; the invalid pack shows its error and is not installable.
4. **Install a pack** (project scope) — confirm the executable-code warning dialog, install; assert success.
5. **Entities resolve** — navigate to Roles page (project scope): the installed role appears with `project` origin badge. (Tool similarly on Tools page.) This proves cascade integration end-to-end.
6. **Persists across reload** — reload; installed status + provenance survive (records are on disk); the role still resolves.
7. **Uninstall** — uninstall the pack; the role disappears from the Roles page; installed status returns to `not-installed`; the role file is gone from `<project>/.bobbit/config/roles/`.

### 11.3 Out-of-scope for tests

Real private-repo git auth, registry backend, and trust enforcement are deferred features — no tests in the MVP beyond asserting the seam interfaces compile and the warning renders.

---

## 12. Open-question resolutions (index)

| Goal "must resolve" item | Resolution | Section |
|---|---|---|
| Exact `pack.yaml` schema | Defined (apiVersion/id/name/description/version + `contents.{roles,tools,skills}`) | §2.2 |
| Individual-entity install allowed? | **Yes** — drill-down per-entity install, same engine | §6.1 |
| Source-registry persistence scope/shape | **Server-global** JSON `<stateDir>/marketplace/sources.json` | §3 |
| Git sync mechanism | Shallow clone; fetch+reset+clean re-sync; reclone on corruption; ambient git creds | §4 |
| Install-scope model + cascade interaction | `system`/`project`; writes land in the exact dirs `ConfigCascade` reads; group-level tool overlay | §6.2 |
| Conflict/override rules | `fail`(default)/`overwrite`/`skip`; same-scope only; transactional | §6.5 |
| Provenance record shape + location | Defined; committed per-scope `.bobbit/config/marketplace/installed.json` | §7 |
| Skills install path (key open question) | Project → `.bobbit/config/skills/` + custom-dir registration; System → `~/.bobbit/skills/` | §6.3 |
| Seams for panels/workflows/staff/trust/registry | Entity-handler registry + source-backend interface + trust gate call site | §8 |
| "Installs executable code" warning | Badge + drill-down notice + install-confirm gate, driven by `carriesCode` | §9 |
```

