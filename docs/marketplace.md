# Pack-Based Marketplace

The marketplace lets you distribute and install Bobbit configuration — **roles**, **tools**, and **skills** — as self-contained directories called **packs**. Register a git repo (or a local directory) as a source, browse the packs it ships, and install any of them into a scope on your machine. Installed entities then resolve through Bobbit's normal config pages exactly like built-ins or hand-written overrides.

This document is the user + developer guide. The authoritative design — schemas, the full REST contract, the legacy→unified-list mapping, and the test plan — lives in [docs/design/pack-based-marketplace.md](design/pack-based-marketplace.md). This page summarises and points there for depth.

## Why packs

The earlier marketplace attempt tracked every installed entity individually (a per-entity install ledger), and collapsed under the bookkeeping: knowing which role/tool/skill came from where, how to cleanly uninstall, and how to reconcile orphans became its own hard problem.

This version makes **the pack directory itself the unit of truth**:

- **Install** = copy a pack directory into a scope.
- **Uninstall** = delete that directory.
- **Update** = re-pull and replace it.
- **Resolve** = walk one ordered list of packs and let later packs shadow earlier ones.

There is no separate ledger. The pack directory plus its generated `.pack-meta.yaml` *is* the install record. Uninstall removes exactly what install added, because they are the same directory.

## Core concept: one resolver over one ordered list

A **pack is just a directory** laid out like Bobbit's shipped `defaults/` tree:

```
<pack-dir>/
  pack.yaml                       # REQUIRED — a dir is a pack IFF this exists
  roles/<name>.yaml
  tools/<group>/{*.yaml, extension.ts, _shared/...}
  skills/<name>/SKILL.md
```

A single `PackResolver` walks **one ordered list of packs**, low→high priority, and produces resolved entities — each tagged with the pack it came from. **Precedence is position in the list**: a name defined by a higher-priority pack shadows the same name in a lower one. That shadow is exactly what the marketplace flags as a conflict.

Everything Bobbit resolves for these three entity types is a pack in that one list:

- **Builtin pack** — what Bobbit ships (`dist/server/defaults/`), lowest priority, read-only.
- **User packs** — each scope's existing `roles/ tools/ skills/` config dir. This is where *creating* or *customizing* an entity writes, and *reverting* deletes. Back-compat is automatic because these are the same directories the config stores already used.
- **Market packs** — installed from a source into a scope's `market-packs/<pack-name>/`.
- **Legacy-implicit packs** — the hard-coded skill scan dirs (`.claude/skills`, `~/.bobbit/skills`, etc.) and any skills directories registered via the legacy `config_directories` key, mapped into entries in the same list so existing overrides resolve identically.

Unifying these into one resolver replaced two separate mechanisms — `ConfigCascade` (roles/tools) and `slash-skills.ts` (skills) — that each had their own precedence rules. See [Architecture](#architecture-developer) below.

> **Out of scope, by design.** MCP servers (`mcp-manager.ts`, `.mcp.json`) and AGENTS/CLAUDE.md prompt assembly (`system-prompt.ts`) keep their own loaders and resolve exactly as before. A market pack may **not** ship `mcp/` or AGENTS content in the MVP. See [Limitations & deferred work](#limitations--deferred-work).

## Using the marketplace

### Opening it

A **Market** button sits in the sidebar config-nav row, between **Workflows** and **New Goal**. It opens the marketplace surface (route `#/market`, implemented in `src/app/marketplace-page.ts`).

### Registering a source

A **source** is a git remote URL or an absolute local directory path whose top level is a collection of pack directories (never a flat `defaults/` mirror). Sources are **global to the server** — once registered, a source can be browsed and installed into any scope.

In the **Sources** panel, click "Add source", paste a git URL (or a local/`file://` path) and optionally a branch/tag `ref`. Adding a source immediately syncs it (shallow clone for git, read-in-place for local dirs). Per-source "Re-sync" and "Remove" actions are available.

Private repos rely on your ambient git credentials (credential helper / SSH agent) — the marketplace stores no credentials of its own.

### Browsing packs

Select a source to list its packs. Each pack shows its name, version, description, and declared entities (the `contents` from `pack.yaml`, rendered as chips). A directory in the source is only treated as a pack if it contains a valid `pack.yaml`; anything else (a `README.md`, a `docs/` folder) is ignored.

### Installing to a scope

Each pack has an **Install** button with a scope picker. Installing copies the pack's directory verbatim into the chosen scope's `market-packs/<pack-name>/` and writes a generated `.pack-meta.yaml` recording provenance. Every contained role/tool/skill then resolves through the single resolver, tagged with that pack as its `origin`.

**Trust lives at the source boundary, not per pack.** There is no per-pack confirmation dialog and no "executable code" chip. The trust decision is made once, when you **add a source**: the Add-source panel carries a persistent warning that you should only add sources you trust, because installing *any* pack from a source can run code or instruct agents on your machine. Install then proceeds without a further gate.

Why a blanket warning rather than a tool-pack-only one? The old model implied a false binary — tool packs dangerous, role/skill packs safe. In reality every pack is risky once installed, because roles and skills become instructions to an LLM that has shell access. The Add-source panel includes an expandable **"Why?"** disclosure (collapsed by default) explaining the risk spectrum across the three entity types, highest to lowest:

- **Tools** — ship code that runs **directly in the Bobbit server process on the host**, deterministically, with no LLM and no sandbox in the loop. This is the highest, most immediate risk. Three distinct code surfaces ship in a tool pack:
  - **`extension.ts` / `_shared/`** — the tool implementation, run in the gateway process.
  - **Server action handlers** (`actions:` contribution, [Extension Host](#extension-contributions-tool-renderers--server-actions)) — `actions.mjs` modules the gateway dynamically imports and runs **in the long-lived gateway process** when a renderer invokes an action. Unlike subprocess-isolated tool extensions, a crashing or hung handler runs in-process; Bobbit caps blast radius (per-call timeout, global concurrency cap, per-session rate limit, try/catch isolation, audit logging) but the handler code is still trusted host code. Handler inputs (`args`, `sessionId`, `toolUseId`) are **LLM-influenced and forgeable** — handlers must validate/whitelist them and never `eval`/`exec` them.
  - **UI-thread renderers** (`renderer:` contribution) — pre-built ESM modules the browser lazily imports and runs **on the main UI thread**, over LLM-influenced tool data. They render tool blocks and can call server actions. Renderers must not auto-invoke actions on render (action calls require a user gesture), must preserve iframe `sandbox` attributes, and use theme tokens only.
- **Skills** — free-form instructions an agent tends to follow literally. An agent with shell access can be directed to do damage.
- **Roles** — persona/behavior steering; influential but more diffuse. Still drives an LLM with tool access.

There is no signing or sandboxing yet, so the source-level trust decision is the only safeguard. The full extension-host threat model — the allowlist-bypass fix, input validation, `toolUseId` ownership verification, and the blast-radius controls — is in [docs/design/extension-host.md §5](design/extension-host.md).

### Viewing provenance

The **Installed** panel lists installed packs grouped by scope, each with the provenance from its `.pack-meta.yaml`: origin source URL, version, commit short SHA, and install/updated dates. A partially-copied or corrupt install (missing/invalid `.pack-meta.yaml`) is surfaced with a `corrupt` status so you can re-install or clean it up; corrupt packs are ignored by the resolver.

### Updating and uninstalling

- **Update** re-syncs the originating source, re-resolves the commit, and atomically replaces the installed directory (preserving the original `installedAt`, bumping `updatedAt`). Re-syncing a source then updating reflects upstream changes.
- **Uninstall** deletes the pack directory and removes it from the scope's `pack_order`. Because the directory is the unit of truth, uninstall removes exactly what install added — no orphans.

### Resolving same-name conflicts

When two packs define the same entity name, the higher-priority one wins and the lower one is *shadowed*. The marketplace flags any market-pack-involved shadow with a **warning icon**; expand it to see the entity type, name, winner, and shadowed pack(s).

> A plain builtin→user customize/override is **not** flagged — that's the normal override flow. Only conflicts involving a market pack raise the warning, to avoid noise on every customized role.

The MVP ships exactly one configured resolution mechanism: **`pack_order`**, the per-scope ordering of market packs. Drag-reorder market packs within a scope (mirroring the existing project drag-reorder UI); the last entry has highest priority within that scope's market band. Reordering calls `PUT /api/marketplace/pack-order` and re-resolves synchronously, so the winner flips immediately and persists across reload. Alternatively, **customizing** the entity writes into the scope's user pack, which sits above all market packs in that scope and so always wins locally.

### Config-page integration

The Roles (`#/roles`), Tools (`#/tools`), and Skills (`#/skills`) pages need no structural change — they already render `origin`/`overrides` scope badges. Market-pack entities now appear there with:

- the scope badge (`builtin` / `server` / `user` / `project`), and
- an **origin pack chip** (`originPackName`) identifying the specific pack the entity came from.

Market-pack entities are read-only on those pages (manage them from the Market surface, not by editing the config page).

## Scopes & precedence

The base scope order is **fixed**, lowest→highest priority:

```
builtin  <  server  <  global-user  <  project
```

Project wins; a user's machine-wide (global-user) packs beat a shared server install; builtin is lowest. Within a single scope, entries order as:

```
[ market packs, in pack_order ]  <  [ user pack ]  <  [ legacy skill dirs (skills only) ]
```

The user pack sits **above** market packs in the same scope so that customizing an entity reliably shadows a market pack and reverting brings the market entity back. Legacy skill dirs sit above the user pack and preserve today's "project/personal skills beat everything" precedence.

### Where files live

Every scope normalizes to `<base>/.bobbit/config/` as its user-pack root and `<base>/.bobbit/config/market-packs/` for installed market packs, where `base` is:

| Scope | `base` | User pack root | Market packs root |
|---|---|---|---|
| global-user | `~` (home dir) | `~/.bobbit/config/` | `~/.bobbit/config/market-packs/` |
| server | `<server-cwd>` | `<server-cwd>/.bobbit/config/` | `<server-cwd>/.bobbit/config/market-packs/` |
| project | `<project root>` | `<project>/.bobbit/config/` | `<project>/.bobbit/config/market-packs/` |
| builtin | — | `dist/server/defaults/` (read-only) | — |

Both install and resolution derive these paths from one helper (`scopePaths()` in `pack-types.ts`), so they can never diverge — the directory install writes into is exactly the directory the resolver scans. (Note: the user-pack root is `<base>/.bobbit/config`, matching the existing `RoleStore`/`ToolManager` directories — *not* the bare `<base>/.bobbit/` the goal spec sketched. This is deliberate and is what preserves byte-identical resolution.)

The source registry persists separately to `<server-cwd>/.bobbit/config/marketplace-sources.yaml`, and git clones are cached under `<server-cwd>/.bobbit/state/marketplace-cache/<source-id>/`.

## Authoring a pack

### Source-repo layout

A source repo's top level is a collection of pack directories. Each pack is one subdirectory with a required `pack.yaml` plus an entity payload laid out like `defaults/`. One repo can hold many packs.

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

### `pack.yaml` schema

Authored by the publisher; copied verbatim on install. Parsed and validated by `pack-manifest.ts`.

```yaml
name: research-pack              # REQUIRED. /^[a-z0-9][a-z0-9-]*$/ — used as the install dir name.
description: >                   # REQUIRED. One-paragraph summary shown in the browse UI.
  Deep-research role, web tools, and a literature-review skill.
version: 1.2.0                   # REQUIRED. Semver-ish string; shown in provenance.
author: jane@example.com         # OPTIONAL.
homepage: https://...            # OPTIONAL.
contents:                        # REQUIRED. All three keys required; each MAY be empty.
  roles:  [researcher]           #   Drives the browse-UI declared-entity chips.
  tools:  [research]             #   tools[] are tool GROUP dir names under tools/.
  skills: [lit-review]           #   (No per-pack gate keys off tools[]; trust is
                                 #    decided once when adding a source.)
```

Validation rules: `name`, `description`, `version` must be non-empty; `name` must match the pattern (rejects path separators, `..`, leading dots); `contents` is required with all three array keys present (each may be empty). A `contents.mcp` key is **rejected** — MCP installs are out of scope in the MVP. Unknown top-level keys are ignored (forward-compat). A pack whose `pack.yaml` is missing or invalid is skipped with a warning, never fatal.

### Generated `.pack-meta.yaml`

Written *inside* the installed pack dir at install time — never authored by publishers. It records provenance and is what makes the pack dir self-describing:

```yaml
sourceUrl: https://github.com/acme/bobbit-packs.git
sourceRef: main
commit: 9f3c1a8                  # resolved SHA at install/update (empty for local-dir sources)
packName: research-pack
version: 1.2.0
installedAt: 2026-06-03T10:21:00Z
updatedAt: 2026-06-03T10:21:00Z  # equals installedAt until first update
scope: project                   # global-user | server | project
```

The canonical installed identity is `pack.yaml`'s `name` (not the source subdir name): the pack installs into `market-packs/<manifest-name>/`, and the `pack_order` key and resolver `PackEntry.id` all use that name.

## Extension contributions: tool renderers & server actions

A tool pack can ship more than a tool implementation — it can contribute **how its tool blocks look in the chat** (a renderer) and **interactive server-side behavior** (action handlers). This is the **Extension Host**: the same VS Code-shaped contribution model that will eventually let packs ship side panels, routes, and persistent stores. **Phase 1** (shipped) covers the inner slice — tool renderers and server actions — and freezes the rest of the shape as reserved manifest keys + typed interfaces. See [docs/design/extension-host.md](design/extension-host.md) for the full design and the artifacts / PR-walkthrough migration sketch, and the [Extension Host authoring guide](extension-host-authoring.md) for a step-by-step walkthrough.

**Why this lives in packs.** Before the extension host, tool renderers were hardcoded into the UI bundle and there was no way for a tool to run interactive server logic on a button click. Making both packable means a pack can re-express any built-in interactive tool (the litmus test: a pack tool with a **Retry** button wired to a handler) with no privileged escape hatch — every capability flows through one mediated Host API, which is also the single security choke point.

### The two load-bearing tool-YAML keys

Contributions are declared **per tool**, in the tool's YAML (`tools/<group>/<tool>.yaml`) — the same files `ToolManager` already scans. Two keys are load-bearing in Phase 1:

```yaml
# market-packs/<pack>/tools/<group>/<tool>.yaml
name: sample_action
description: A demo tool with a Retry button wired to a server action handler.
group: Demo
renderer: SampleActionRenderer.js   # pre-built ESM renderer, beside this YAML
actions:
  module: actions.mjs               # server actions module (default: actions.js)
  names: [retry]                    # optional action-name allowlist (defense in depth)
```

- **`renderer:`** — path (relative to the tool's group dir) to a **pre-built ESM** renderer module. For built-in tools this field is display-only metadata; for **pack** tools it becomes load-bearing — the gateway serves the module and the browser lazily imports it.
- **`actions:`** — the server actions module plus an optional explicit allowlist of action names. `actions.module` defaults to `actions.js`; `actions.names`, when present, is enforced by the endpoint *before* the module loads.

A pack tool needs **no `provider:`** — the renderer endpoint and the action dispatcher resolve the tool's on-disk location via `ToolManager.resolveToolLocation()`, which is provider-independent.

The Phase-2 keys `panels:`, `entrypoints:`, `routes:`, and `stores:` are **parsed-and-reserved**: validated for shape, retained verbatim, and never rejected — so a pack authored against the full future shape installs and resolves cleanly on a Phase-1 server. Path-bearing values (`renderer`, `actions.module`) are rejected at parse time if they contain `..` segments or are absolute (traversal guard); a malformed contributions block degrades gracefully (the tool still loads, with a `console.warn`) and is never fatal.

### `.mjs` vs `.js` — ESM-loadability of the actions module

The renderer module is imported by the **browser** (via a Blob URL) where `.js` ESM is fine. The actions module is imported by the **gateway** under plain Node, where a bare `.js` file containing `export` resolves as **CommonJS** (because the surrounding project has no `package.json` `"type": "module"`) and throws. Ship the actions module as **`.mjs`** so Node loads it as ESM, and point `actions.module` at it:

```js
// tools/<group>/actions.mjs
export const actions = {
  retry: async (ctx, args) => ({ message: "retried", at: Date.now() }),
};
```

The renderer module, served to the browser and imported as ESM regardless of extension, stays `.js` (the `rendererKind` computation recognizes a pack renderer by a `.js` extension under a `market-packs/` path).

### Where the files live in an installed pack

```
<scope>/.bobbit/config/market-packs/<pack>/
  pack.yaml
  tools/<group>/
    <tool>.yaml                 # renderer: + actions: contributions
    SampleActionRenderer.js     # pre-built ESM renderer (browser-imported)
    actions.mjs                 # server action handlers (gateway-imported)
```

### Precedence, project scoping, and cache invalidation

- **Pack precedence / shadowing** — renderers and actions resolve through the **same precedence** as every other tool (`buildPackList` / `PackResolver` / `ToolManager`: builtin < market packs in `pack_order` < user pack, per scope). A pack that shadows a same-named built-in interactive tool wins the **renderer too** (the UI registers it with `{ override: true }`), so it gets behavioral parity — pack actions *and* pack renderer, never a split-brain mix.
- **Project scoping** — both the renderer endpoint and the action endpoint resolve through the **session's project-scoped** tool manager (falling back to the server-level one when there is no project), so a project-scope pack — or a project pack shadowing a global tool — serves and dispatches its own winner. The client threads the active `projectId` into the renderer fetch so the browser loads the same winner the `/api/tools` metadata reported.
- **Cache invalidation (synchronous)** — install, update, uninstall, and pack-order changes all call `invalidateResolverCaches()`, which drops the loaded-actions-module cache and the tool-scan cache synchronously. The next action call picks up (or 404s) the freshly installed/updated/removed handler with **no server restart and no client reload** — the UI re-fetches `/api/tools` and reconciles its renderer registry (re-registering pack renderers, restoring displaced built-ins on uninstall) live.

## REST API

All marketplace routes live in `server.ts::handleApiRoute()`. Full request/response contracts and the error matrix are in [design §9 / §9.1 / §9.2](design/pack-based-marketplace.md#9-rest-api-surface).

| Method & path | Purpose |
|---|---|
| `GET /api/marketplace/sources` | List registered sources. |
| `POST /api/marketplace/sources` | Add a source `{ url, ref? }` (syncs immediately). |
| `DELETE /api/marketplace/sources/:id` | Remove a source and its cache dir. |
| `POST /api/marketplace/sources/:id/sync` | Re-sync (re-clone/fetch). |
| `GET /api/marketplace/sources/:id/packs` | Browse a source's packs (`hasTools` reflects whether the pack ships tools; informational only — it no longer drives a per-pack gate). |
| `POST /api/marketplace/install` | `{ sourceId, dirName, scope, projectId? }` — install a pack. |
| `POST /api/marketplace/update` | `{ scope, packName, projectId? }` — re-pull + replace. |
| `DELETE /api/marketplace/installed` | `{ scope, packName, projectId? }` — uninstall. |
| `GET /api/marketplace/installed?projectId=` | List installed packs across scopes with provenance. |
| `GET /api/marketplace/pack-order?scope=&projectId=` | Read a scope's market-pack order. |
| `PUT /api/marketplace/pack-order` | `{ scope, projectId?, order }` — replace a scope's order. |
| `GET /api/packs/conflicts?projectId=` | List same-name conflicts `(type, name, winner, shadowed[])`. |

`scope` ∈ `"global-user" | "server" | "project"`; `projectId` is required when `scope === "project"`. Install/update/uninstall and pack-order changes invalidate the resolver cache and the slash-skills TTL cache synchronously, so a subsequent `GET /api/roles|tools|skills` reflects the change without a client reload.

The existing `/api/roles`, `/api/tools`, `/api/skills` endpoints keep their shape but now source data from `PackResolver`. The `origin` field gained a `user` value (for global-user packs) and every entity carries `originPackId` / `originPackName` (both `null` for builtin/user entities). The `/api/tools` `ToolInfo` payload additionally carries the extension-host wire fields `rendererKind` (`"builtin" | "pack"`), `hasActions`, and `actionNames`.

### Extension-host endpoints

Two routes serve the extension-host contributions (full contract + the security guard sequence in [docs/design/extension-host.md §4](design/extension-host.md)):

| Method & path | Purpose |
|---|---|
| `GET /api/tools/:tool/renderer?projectId=` | Serve a **pack** tool's pre-built ESM renderer module bytes as `text/javascript`. Admin-bearer only (serving module bytes is static-asset-equivalent, not a capability invocation); 404 when the tool has no pack renderer. |
| `POST /api/tools/:tool/actions/:action` | Invoke a pack tool's server action handler. Body `{ sessionId, toolUseId, args }`. **Authorized like a tool call** (the LLM can `curl` it directly): requires `x-bobbit-session-id`, `body.sessionId === header`, `:tool ∈ session.allowedTools`, `:action ∈ actions.names` (when declared), and a `toolUseId` that exists in the header-bound session and was a call of `:tool`. Returns the handler's JSON result. |

## Architecture (developer)

### One pipeline, pluggable loaders

The resolver is a single, type-agnostic pipeline (`src/server/agent/pack-resolver.ts`):

- `PackResolver.resolve<T>(type)` walks the ordered `PackEntry[]` low→high and merges by name. A later entry shadows an earlier same-name entry; shadowed entries are retained in `ResolvedEntity.shadows[]` to drive conflict UI.
- Type-specific reading is delegated to **`EntityLoader<T>`** plugins — `RoleLoader`, `ToolLoader`, `SkillLoader`. Loaders are pure `(entry) → entities`; they contain **no** precedence logic. Roles/tools read the `defaults-tree` layout; the skill loader additionally handles `skills-flat` (a directory that is itself a skills root) and `commands-flat` (`.claude/commands/*.md`).
- Adding a future entity type (`mcp/`, UI `panels/`) is *adding a loader*, not touching the ordering core. `EntityType` already reserves `mcp` for that seam.

Key types are in `src/server/agent/pack-types.ts`: `PackManifest`, `PackMeta`, `PackEntry`, `EntityLoader<T>`, `ResolvedEntity<T>`, and the `scopePaths()` helper that both resolution and install derive paths from.

### `buildPackList` — the legacy→unified mapping

`src/server/agent/pack-list.ts::buildPackList()` is the crux: it constructs the one ordered list from today's inputs so that, with zero market packs installed, resolution is **byte-for-byte identical** to the old `ConfigCascade` + `slash-skills.ts` + `config_directories` behavior. It:

- pushes the builtin pack (lowest);
- for each scope (`server`, `global-user`, `project`) pushes that scope's market packs (ordered by `pack_order[scope]`) then its user pack;
- appends the legacy-implicit skill band (custom `config_directories` skill dirs, `.claude/commands`, `~/.bobbit/skills`, `~/.claude/skills`, `.bobbit/skills`, `.claude/skills`) in the exact legacy precedence order, all above market packs so a market-pack skill can never shadow a user/legacy skill;
- reads the legacy `config_directories` / `disabled_config_directories` keys **only** to build this list — after construction, no roles/tools/skills code path scans directories independently of the resolver.

> **One deliberate behavior change:** `disabled_config_directories` was previously inert for resolution (only written, never read on the resolve path). The unified resolver now honors it — a disabled skill dir is omitted from the list. This is a documented fix, covered by a new unit test, not a byte-identical claim.

### Adapters

The two old resolvers became thin adapters over `PackResolver`, preserving their public API:

- `config-cascade.ts` — `resolveRoles()` / `resolveTools()` now build the pack list and resolve through it (interleaving installed market packs). `resolveWorkflows()` and `resolveToolGroupPolicies()` are **untouched** — those non-installable types keep their existing implementations (there are no workflow/policy loaders).
- `slash-skills.ts` — `discoverSlashSkills()` / `getSkillDirectories()` build the skills segment and resolve through `PackResolver`, then apply the unchanged `userInvocable` filter, alphabetical sort, and TTL cache. The `source` field (`project|personal|legacy|built-in|custom`) is derived from the winning entry for API/UI back-compat.

### Runtime tool resolution

The resolver tags tool *metadata* with its origin pack, but tools are also loaded at agent runtime by `ToolManager`. `tool-manager.ts` mirrors the same precedence: builtin (lowest) < market-pack `tool/` roots (low→high) < the scope's own user `toolsDir` (highest). Market-pack tool roots are pure **by-name overlays** — they add tools and may override by name but neither own nor are shadowed as a whole group. With zero market roots this collapses to the original two-layer cascade, so runtime resolution matches the API. Market tools are read-only (writes never land in `market-packs/`).

### Install engine

`src/server/agent/marketplace-install.ts` (`MarketplaceInstaller`) handles git sync and file ops:

- **Git sync** — shallow clone (`--depth 1`), re-synced via `fetch`+`reset --hard` (re-clone on failure); local-dir sources are read in place. Errors surface verbatim.
- **Install** is atomic: copy the source subtree into a `.tmp-*` staging dir, write `.pack-meta.yaml`, then a single `rename` publishes it. On any pre-rename failure the staging dir is removed and `dest` never half-exists.
- **Update** copies fresh into staging, swaps the old dir aside, publishes, and removes the backup — rolling back if the swap fails, so the original is never lost.
- **Corrupt guard** — a `market-packs/<name>/` dir counts as an installed pack only if it has *both* a valid `pack.yaml` and a valid `.pack-meta.yaml`; `.tmp-*` dirs are never scanned.

Source persistence is `marketplace-source-store.ts` (`MarketplaceSourceStore`); the scoped `pack_order` map persists via `project-config-store.ts` (project order in the project's `project.yaml`, server + global-user order in the server config under distinct keys).

See [docs/design/pack-based-marketplace.md](design/pack-based-marketplace.md) for the full design, worked examples of override preservation, and the test plan.

## Limitations & deferred work

- **MCP and AGENTS are not installable.** `.mcp.json` and AGENTS/CLAUDE.md keep their own loaders and resolve as before; a pack may not ship `mcp/` or AGENTS content. MCP configs reference local binaries, absolute paths, and secrets that mostly won't run on the installer's machine; AGENTS.md describes one specific project. The resolver leaves an `mcp/` loader seam for when a parameterization/secrets model exists.
- **Per-conflict pinning is deferred.** The only conflict-resolution mechanism is `pack_order` (plus user-pack customization). A future `pack_conflicts` schema is sketched in the design doc but not implemented, surfaced, or tested.
- **No trust, signing, or sandboxing.** Installing any pack copies its contents as-is — tool packs copy executable code that runs in the Bobbit server process, and role/skill packs copy instructions for an LLM with shell access. The only safeguard is the blanket trust warning shown when adding a source (see the "Why?" disclosure for the per-entity-type threat model). A per-pack permission/signing gate would slot into the install pipeline later.
- **Git sync is synchronous.** Add-source, re-sync, and install run git inline and block until done.
- **No hosted registry yet.** Sources are git repos or local dirs; the `MarketplaceSource` abstraction is kept open to a future hosted/searchable registry backend.
- **Portable workflows and staff templates are not packable.** Workflows stay project-scoped inline in `project.yaml`; staff templates are noted as a gap. UI panels/plugins are the intended future headline entity type — the pack/loader format is designed to accommodate a `panels/` type additively.
