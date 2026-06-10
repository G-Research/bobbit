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
  panels/<panel>.yaml             # Extension-Host pack-scoped panels (auto-discovered)
  entrypoints/<ep>.yaml           # Extension-Host pack-scoped launchers/deep-links
  lib/                            # shared pack implementation modules (renderers, panels, routes)
```

The `panels/`, `entrypoints/`, and `lib/` directories belong to the [Extension
Host](#extension-contributions-tool-renderers--server-actions). A pack may ship any subset —
including **no `tools/` at all** (a UI-only pack). See the
[Extension Host authoring guide](extension-host-authoring.md) and the
[V1 schema design](design/pack-schema-v1-rationalisation.md).

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

- **Tools** — ship code that runs **on the host**, deterministically, with no LLM in the loop and only worker-level resource/crash isolation (not a security sandbox against the pack's own code). This is the highest, most immediate risk. Three distinct code surfaces ship in a tool pack:
  - **`extension.ts` / `_shared/`** — the tool implementation, run in the gateway process.
  - **Server action handlers** (tool-YAML `actions:` contribution, [Extension Host](#extension-contributions-tool-renderers--server-actions)) — `actions.mjs` modules invoked when a renderer calls an action via the sole pack→server path, `host.invokeAction`. The action endpoint (`POST /api/tools/:tool/actions/:action`) is same-origin and **authorized like a tool call** — it requires `:tool` to be in the calling session's `allowedTools` and verifies the supplied `toolUseId` actually exists in that session and was a call of `:tool` (because the LLM can `curl` it directly, this guard, not the agent layer, is the real gate). The handler does **not** run in the gateway process: like a pack's route and store handlers, it executes in a confined `worker_threads` worker — the parent process only resolves + validates the module path and never imports pack code. The worker gives **resource + crash isolation** (terminate-on-timeout, which is also the CPU control; memory/stack caps; spawned-child kill; module-import containment to the **pack root**) on top of the dispatcher's blast-radius controls (per-call timeout spanning module load+eval *and* execution, global concurrency cap, per-session rate limit, audit logging). This is a **stability** boundary, **not** a security sandbox against the pack's own code — the handler is still trusted host code, run from a source you chose to trust. Handler inputs (`args`, `sessionId`, `toolUseId`) are **LLM-influenced and forgeable** — handlers must validate/whitelist them and never `eval`/`exec` them.
  - **UI-thread renderers** (tool-YAML `renderer:` contribution) **and panels** (`panels/<panel>.yaml`, auto-discovered) — pre-built ESM modules the browser lazily imports and runs **on the main UI thread**, over LLM-influenced tool data. They render tool blocks / side panels and reach the server only through the mediated Host API (`host.invokeAction` / `host.callRoute` / `host.store.*` / `host.session.*`). Renderers/panels must not auto-invoke actions or navigate on mount (writes require a genuine user gesture), must preserve iframe `sandbox` attributes for any embedded content, and use theme tokens only. A pack may **vendor npm dependencies** by bundling them into its served module ahead of time (esbuild, `npm run build:packs`; see the [authoring guide](extension-host-authoring.md#bundling-npm-dependencies-into-a-pack-vendoring)) — e.g. the artifacts pack inlines `highlight.js`/`pdfjs-dist`/`docx-preview` to reach built-in parity. This does NOT widen the trust model: bundled code is **the same trusted UI-thread code** as the rest of the renderer (source-level trust decision), and untrusted model-derived content (HTML artifacts) still renders inside a `sandbox`ed iframe — the trust boundary is content-origin, not which library drew the pixels.
  - **Pack IDENTITY on the scoped capabilities is a SERVER-MINTED surface binding token, never a caller-supplied id.** The scoped Host-API calls (`host.store.*`, `host.session.*`, `host.callRoute`, and the WS session-write mint/post) all act AS a specific pack — store keys are namespaced by `packId`, `callRoute` is confined to the calling pack's own namespace, session reads are own-session. Identity must therefore not be forgeable. When the trusted app first constructs a surface's Host API it asks the server to mint a token (`POST /api/ext/surface-token`) for either a **tool-bound** surface (renderer/action, ref `{ tool }`) or a **pack-bound** surface (panel/entrypoint/route, ref `{ contributionKind, contributionId, packId }`). The server resolves the winning contribution and mints an opaque, HMAC-signed token bound to `{sessionId, packId, contributionId, tool?}`. The token is captured in the Host API **closure** (pack module code never sees or sets it) and echoed on every scoped call; the server **derives `{packId, tool?}` from the validated token and ignores any caller-supplied id**, re-resolving the pack identity on each call (so a token gone stale after an uninstall, or a session mismatch, is rejected). **Trust boundary differs by surface kind.** A tool-bound token still layers `:tool ∈ allowedTools`. A **pack-bound** token has no carrier tool, so its gate is **pack installed + active in the session's scope + caller's own session** — `allowedTools` no longer narrows which pack a session may reach. This is the deliberate authorization change that lets **orphan / UI-only packs** (no `tools/`) use the scoped surfaces; it grants no capability a tool-bound surface did not already have, because it stays bounded by the pack-scoped guarantees (store is `packId`-namespaced, `callRoute` reaches only the pack's own routes, session reads are own-session, session writes keep the user-gesture + one-time permit gate). This closes the **accidental + non-pack-reachable** identity-confusion path. **Residual:** in the shared main UI realm (Model A) a deliberately MALICIOUS pack can still mint its own token for a contribution it knows, or read another surface's token out of a shared closure / monkey-patch `fetch` — TRUE cross-pack isolation needs **per-pack realm isolation**, which Model A de-scopes for UI. The token makes the Host API the only *sanctioned* identity path and is **not** claimed as a defense against a same-realm adversary; full UI-thread realm isolation is the documented future hardening.
  - **Session write (`host.session.postMessage`) drives the agent, so it is the highest-risk Host-API surface.** Because pack UI runs in the main realm and *can* monkey-patch globals like `window.fetch` **and `WebSocket.prototype.send`**, the surface is defended in depth: (1) the SEND does **not** ride a `fetch` — it goes over the app's already-authenticated **session WebSocket**, which pack code has no handle to, so there is no capturable session secret on any request; (2) every post must carry a **server-minted, one-time, content-bound write permit** — the client mints a nonce over the trusted WS (bound to `{session, packId, tool, sha256(role+text)}`, short TTL) and the server **single-use consumes** it on the post, so a **captured/replayed** `ext_session_post` frame (permit already consumed), a **forged** frame (no valid nonce), or a **tampered** role/text (hash mismatch) are all rejected with no post; (3) the server authorizes it (the pack's tool ∈ the session's `allowedTools`, server-derived packId), targets only the WS connection's own session (cross-session posting is structurally impossible), enforces role-aware delivery (a `"system"` message is framed as an explicit system directive, never silently delivered as user text), and **audits every post**; (4) the client adds a `navigator.userActivation` "no post on mount" check before minting. **Residual:** a pack forging the permit MINT *during a genuine user gesture* is inherent to the same-realm model — **FULL realm isolation of pack UI logic (a separate iframe/worker realm) is out of scope** for now and is what would close it; the source-level trust decision plus the server-side authorization/permit/audit are the durable boundary, and UI-thread realm isolation is the documented future hardening.
- **Skills** — free-form instructions an agent tends to follow literally. An agent with shell access can be directed to do damage.
- **Roles** — persona/behavior steering; influential but more diffuse. Still drives an LLM with tool access.

There is no signing, and the worker isolation around pack server modules is **stability-only** (resource + crash isolation — terminate-on-timeout, memory/CPU caps, child kill, import-containment), not a security sandbox against trusted pack code. So the source-level trust decision remains the primary safeguard. The full extension-host threat model — the allowlist-bypass fix, input validation, `toolUseId` ownership verification, the worker isolation, and the blast-radius controls — is in [docs/design/extension-host.md §5](design/extension-host.md).

### Viewing provenance

The **Installed** panel lists installed packs grouped by scope, each with the provenance from its `.pack-meta.yaml`: origin source URL, version, commit short SHA, and install/updated dates. A partially-copied or corrupt install (missing/invalid `.pack-meta.yaml`) is surfaced with a `corrupt` status so you can re-install or clean it up; corrupt packs are ignored by the resolver.

### Updating and uninstalling

- **Update** re-syncs the originating source, re-resolves the commit, and atomically replaces the installed directory (preserving the original `installedAt`, bumping `updatedAt`). Re-syncing a source then updating reflects upstream changes.
- **Uninstall** deletes the pack directory and removes it from the scope's `pack_order`. Because the directory is the unit of truth, uninstall removes exactly what install added — no orphans.

### Resolving same-name conflicts

When two packs define the same entity name, the higher-priority one wins and the lower one is *shadowed*. The marketplace flags any market-pack-involved shadow with a **warning icon**; expand it to see the entity type, name, winner, and shadowed pack(s).

> A plain builtin→user customize/override is **not** flagged — that's the normal override flow. Only conflicts involving a market pack raise the warning, to avoid noise on every customized role.

The MVP ships exactly one configured resolution mechanism: **`pack_order`**, the per-scope ordering of market packs. Drag-reorder market packs within a scope (mirroring the existing project drag-reorder UI); the last entry has highest priority within that scope's market band. Reordering calls `PUT /api/marketplace/pack-order` and re-resolves synchronously, so the winner flips immediately and persists across reload. Alternatively, **customizing** the entity writes into the scope's user pack, which sits above all market packs in that scope and so always wins locally.

### Activation controls

Each installed pack exposes per-entity **activation toggles** on the Market installed-pack
surface, so you can disable individual entities without uninstalling the pack. **Only
user-facing entities are toggleable:** roles, tools, skills, and entrypoints. Support surfaces
— panels, routes, stores, renderers, actions, `lib/` — are **not** independently toggleable
(panels may be shown read-only as "support surfaces").

What disabling does:

- **Disable a tool / role / skill** — it is dropped from its resolved list (in the cascade
  resolver, *before* precedence merge), so a lower-priority shadowed entity of the same name
  may reappear.
- **Disable an entrypoint** — its launcher + deep-link registration is omitted from
  `/api/ext/contributions`, so the launcher/deep-link disappears. **A panel the entrypoint
  targets stays available** to any enabled tool/entrypoint that opens it — disabling an
  entrypoint never disables a panel.

**Why a catalogue/runtime split.** Toggles persist in `pack_activation` (per scope/project,
keyed by pack name + entity kind + name; entrypoints keyed by their `contents.entrypoints`
basename, so one toggle covers both the launcher id and the deep-link `routeId` from that
file). The toggle UI must render from the **unfiltered catalogue** — read straight from the
installed pack's `pack.yaml` manifest via `GET /api/marketplace/pack-activation` — *not* from
the runtime-filtered `/api/tools` / `/api/ext/contributions`. If the UI read the filtered
runtime endpoints, a disabled entity would vanish from the list and become impossible to
re-enable. So the catalogue stays complete (every toggle visible, `checked = name ∉
disabled[kind]`) while the runtime registries stay filtered (a disabled entity does not
register/resolve). The `PUT` returns the refreshed catalogue alongside the normalized
`disabled`, then invalidates resolver caches so the effect is live without a reload. Scope
split mirrors `pack_order`: project activation lives in the project config, server +
global-user in the server config.

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
contents:                        # REQUIRED. roles/tools/skills required; each MAY be empty.
  roles:       [researcher]      #   Drives the browse-UI declared-entity chips.
  tools:       [research]        #   tools[] are tool GROUP dir names under tools/.
  skills:      [lit-review]      #   (No per-pack gate keys off tools[]; trust is
  entrypoints: [open-review]      #    decided once when adding a source.)
                                 #   OPTIONAL — entrypoints/<name>.yaml basenames (toggleable).
routes:                          # OPTIONAL top-level block — Extension-Host pack routes.
  module: lib/routes.mjs         #   relative to pack.yaml, contained in the pack root.
  names:  [bundle, publish]       #   exported route-name allowlist.
```

Validation rules: `name`, `description`, `version` must be non-empty; `name` must match the pattern (rejects path separators, `..`, leading dots); `contents` is required with the `roles`/`tools`/`skills` array keys present (each may be empty). `contents.entrypoints` is optional and lists the basenames of `entrypoints/<name>.yaml` files (the Extension-Host activation catalogue — see [authoring guide](extension-host-authoring.md#entrypoints--non-chat-launchers--deep-link-routes-hostuinavigate)). The optional top-level `routes:` block declares pack-level Extension-Host routes. Panels are **auto-discovered** from `panels/*.yaml` and are not listed here. A `contents.mcp` key is **rejected** — MCP installs are out of scope in the MVP. There is **no `stores` key** (Extension-Host stores are implicit, namespaced by the server-derived `packId`) and **no `permissions` key** (trusted pack code has ambient OS access — there is no permission system). Unknown top-level keys are ignored (forward-compat). A pack whose `pack.yaml` is missing or invalid is skipped with a warning, never fatal.

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

A pack can ship more than a tool implementation — it can contribute **how tool blocks look in the chat** (a renderer), **interactive server-side behavior** (action handlers), persistent **side panels**, the pack's own **server routes**, non-chat **entrypoints**, implicit pack-scoped **stores**, and **session** access. This is the **Extension Host**: a contribution model where every capability flows through one mediated Host API. Everything is shipped — `HOST_API_VERSION` is `1` and `host.capabilities` reports all flags `true`. The two built-ins re-expressed as packs are the acceptance litmus: `market-packs/artifacts/` (a tool + panel + deep-link pack) and `market-packs/pr-walkthrough/` (a **no-tools / UI-only** pack).

**Where each contribution lives (V1 schema).** Contributions are declared where their runtime scope already is: tool-scoped `renderer`/`actions` on the tool YAML; pack-scoped panels in `panels/<panel>.yaml` (auto-discovered), entrypoints in `entrypoints/<ep>.yaml` (listed in `contents.entrypoints`), and routes in the top-level `routes:` block of `pack.yaml`; shared modules in `lib/`. Stores are implicit. The authoritative schema + addressing contract is [docs/design/pack-schema-v1-rationalisation.md](design/pack-schema-v1-rationalisation.md). See also [docs/design/extension-host.md](design/extension-host.md) for the design (contract adapter, isolation model), [extension-host-phase2.md](design/extension-host-phase2.md) for the build history, and the [Extension Host authoring guide](extension-host-authoring.md) for the step-by-step walkthrough.

**Why this lives in packs.** Before the extension host, tool renderers were hardcoded into the UI bundle and there was no way for a tool to run interactive server logic on a button click. Making both packable means a pack can re-express any built-in interactive tool (the litmus test: a pack tool with a **Retry** button wired to a handler) with no privileged escape hatch — every capability flows through one mediated Host API, which is also the single security choke point.

**The durability invariant: no raw escape hatch.** A pack reaches the server only through typed, named, authorized Host-API methods — `host.invokeAction` (actions), `host.callRoute` (the pack's OWN routes), `host.store.*`, `host.session.*`. There is **no `host.gateway.fetch`** and no other raw transport. This is deliberate: Bobbit *serves* a typed, versioned contract rather than handing extensions a window into internals, so the abstraction stays durable (one un-typed passthrough would make it a fiction) and Phase-2 capabilities landed purely additively (no v1 signature changed, `HOST_API_VERSION` still `1`). Removing the raw-fetch capability also eliminates the trusted-base-URL / `Host:`-header token-leak surface a raw fetch would have required — endpoints are same-origin and the client builds the request itself, so there is no caller-supplied URL or `Authorization` header to misdirect. `host.callRoute(name, init)` is the typed, pack-scoped way to reach dynamic server data: it reaches only the calling pack's OWN routes (the server derives `<pack>` from the proven `tool` — no forgeable URL segment). See the [Extension Host authoring guide](extension-host-authoring.md) and [design doc](design/extension-host.md) for the full Host API.

### The two tool-scoped keys (renderer + actions)

The tool YAML (`tools/<group>/<tool>.yaml`) carries **only** the tool-scoped contributions — `renderer` and `actions`, the two that depend on a tool call / `toolUseId`. Pack-scoped contributions (panels, entrypoints, routes) live in their own files (see [below](#the-pack-scoped-contributions-panels-entrypoints-routes)). The two tool-scoped keys:

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

- **`renderer:`** — path (relative to the tool YAML's dir, contained in the pack root) to a **pre-built ESM** renderer module. For built-in tools this field is display-only metadata; for **pack** tools it becomes load-bearing — the gateway serves the module and the browser lazily imports it. May point at a shared module (`../../lib/SharedRenderer.js`).
- **`actions:`** — the server actions module plus an optional explicit allowlist of action names. `actions.module` defaults to `actions.js`; `actions.names`, when present, is enforced by the endpoint *before* the module loads.

A pack tool needs **no `provider:`** — the renderer endpoint and the action dispatcher resolve the tool's on-disk location via `ToolManager.resolveToolLocation()`, which is provider-independent. A tool YAML carries no other contribution keys; the tool-scoped `/api/tools` payload exposes only `rendererKind`/`hasActions`/`actionNames` (plus origin metadata).

### The pack-scoped contributions (panels, entrypoints, routes)

Panels, entrypoints, and routes are **pack-scoped** — they are not anchored to a carrier tool, which is what lets a pack ship them with no `tools/` dir at all:

- **Panels** — one `panels/<panel>.yaml` per panel (`{ id, title?, entry }`), **auto-discovered** (not listed in `contents`). Panel ids are pack-local; the client keys its registry by `{packId, panelId}` and serves bytes from the pack-addressed `GET /api/ext/packs/:packId/panels/:panelId`.
- **Entrypoints** — one `entrypoints/<ep>.yaml` per entrypoint, with the basename listed in `contents.entrypoints`. Launchers (composer-slash / git-widget-button / command-palette) and `kind:"route"` deep-links. Entrypoint `id` is pack-local; a `kind:"route"` `routeId` is **host-global**.
- **Routes** — the top-level `routes: { module, names }` block on `pack.yaml`. The `RouteRegistry` builds from these pack-level refs (keyed by `packId`), so `host.callRoute` is opener-independent within a pack.

Path-bearing values (`renderer`, `actions.module`, panel `entry`, `routes.module`) resolve **relative to their declaring file** and must stay inside the **pack root** — a `..` that escapes the pack root is rejected (realpath aware) at serve/import time; absolute paths are rejected at parse time. A malformed contribution file degrades gracefully (warned + dropped) and is never fatal. The hard-conflict rejections happen at pack-level registry build: a duplicate route name within a pack, a duplicate `routeId` across packs, a duplicate panel id within a pack, or a duplicate entrypoint id within a pack. **Stores are implicit** — created on first `host.store.put`, namespaced by the server-derived `packId`; there is no `stores` declaration.

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
  pack.yaml                     # contents (incl. entrypoints[]) + optional routes:
  tools/<group>/
    <tool>.yaml                 # renderer: + actions: (tool-scoped only)
    SampleActionRenderer.js     # pre-built ESM renderer (browser-imported)
    actions.mjs                 # server action handlers (gateway-imported)
  panels/<panel>.yaml           # auto-discovered pack panels
  entrypoints/<ep>.yaml         # launchers + deep-link routes (listed in contents.entrypoints)
  lib/                          # shared modules (panels, routes.mjs, helpers)
```

A **no-tools pack** (e.g. `market-packs/pr-walkthrough/`) omits `tools/` entirely and ships only `pack.yaml` + `panels/` + `entrypoints/` + `lib/` — its surfaces obtain a pack-scoped Host API through pack-bound surface tokens, with no tool in `allowedTools`.

### Precedence, project scoping, and cache invalidation

- **Pack precedence / shadowing** — renderers and actions resolve through the **same precedence** as every other tool (`buildPackList` / `PackResolver` / `ToolManager`: builtin < market packs in `pack_order` < user pack, per scope). A pack that shadows a same-named built-in interactive tool wins the **renderer too** (the UI registers it with `{ override: true }`), so it gets behavioral parity — pack actions *and* pack renderer, never a split-brain mix.
- **Project scoping** — both the renderer endpoint and the action endpoint resolve through the **session's project-scoped** tool manager (falling back to the server-level one when there is no project), so a project-scope pack — or a project pack shadowing a global tool — serves and dispatches its own winner. The client threads the active `projectId` into the renderer fetch so the browser loads the same winner the `/api/tools` metadata reported.
- **Cache invalidation (synchronous)** — install, update, uninstall, pack-order changes, and activation-toggle PUTs all call `invalidateResolverCaches()`, which drops the loaded-actions/routes-module caches, the route registry, the **pack-contribution registry**, and the tool-scan cache synchronously. The next action/route call picks up (or 404s) the freshly installed/updated/removed/toggled handler with **no server restart and no client reload** — the UI re-fetches `/api/tools` (renderers) and `/api/ext/contributions` (panels + entrypoints) and reconciles its registries (re-registering pack contributions, restoring displaced built-ins on uninstall) live.

### What is (and isn't) pack-expressible in v1

The Host API is deliberately the *only* surface a pack uses, so what a pack can express is exactly the set of typed, scoped capabilities the contract exposes. Two boundaries are worth stating explicitly, because they shape what re-expressing a built-in as a pack can and cannot cover:

- **Privilege-minting operations are NOT pack-expressible — on purpose.** A pack cannot drive `team_spawn` (or any operation that mints a *new* privilege principal — a fresh agent/session with its own `allowedTools` and credentials). Every Host-API capability acts within the calling session's already-granted authority (own-session reads, allowedTools-gated writes, pack-namespaced stores); spawning a new principal would let a pack escalate beyond the session it was invoked in, which the boundary explicitly forbids. Such operations stay agent-tool-side, where the agent's own authority gates them.
- **Typed `host.model.*` inference is the most impactful missing capability.** There is no Host-API method for a pack's server code to run LLM inference. This is not a credential boundary — a trusted pack could do its own inference exactly as a tool can (it has full ambient env + network) — but a *typed* `host.model.*` is simply out of scope for the durable v1 contract. This is *why* PR-walkthrough's LLM card synthesis stays in the `submit_pr_walkthrough_yaml` **agent tool** (which already has the agent's credentials and loop) and is read back from the pack store, rather than re-deriving inference in the pack's `bundle` route. A future parent-side `host.model.*` capability — running inference in the gateway process behind the same authorized proxy as `store`/`session` — is the highest-value additive extension; it would let packs synthesize live without an agent-tool round-trip, with provider/credential selection mediated by the gateway.

These are not gaps in the *implementation* — they are properties of the trust model: a pack runs within the authority it was invoked under, and any GATEWAY-mediated capability (e.g. a future `host.model.*`) would be exposed through a typed host method rather than a raw transport. Ambient OS / env / network access is available to trusted pack server code exactly as it is to a tool or MCP server.

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
| `GET /api/marketplace/pack-activation?scope=&projectId=&packName=` | Read a pack's activation state for a scope — returns the **unfiltered** `catalogue` (all toggleable entities the installed pack declares) + the current `disabled` refs. |
| `PUT /api/marketplace/pack-activation` | `{ scope, projectId?, packName, disabled }` — replace a pack's activation overrides; returns the refreshed `catalogue` + normalized `disabled`, then invalidates caches. |
| `GET /api/packs/conflicts?projectId=` | List same-name conflicts `(type, name, winner, shadowed[])`. |

`scope` ∈ `"global-user" | "server" | "project"`; `projectId` is required when `scope === "project"`. Install/update/uninstall and pack-order changes invalidate the resolver cache and the slash-skills TTL cache synchronously, so a subsequent `GET /api/roles|tools|skills` reflects the change without a client reload.

The existing `/api/roles`, `/api/tools`, `/api/skills` endpoints keep their shape but now source data from `PackResolver`. The `origin` field gained a `user` value (for global-user packs) and every entity carries `originPackId` / `originPackName` (both `null` for builtin/user entities). The `/api/tools` `ToolInfo` payload additionally carries the extension-host wire fields `rendererKind` (`"builtin" | "pack"`), `hasActions`, and `actionNames`.

### Extension-host endpoints

Two routes serve the extension-host contributions (full contract + the security guard sequence in [docs/design/extension-host.md §4](design/extension-host.md)):

| Method & path | Purpose |
|---|---|
| `GET /api/tools/:tool/renderer?projectId=` | Serve a **pack** tool's pre-built ESM renderer module bytes as `text/javascript`. Admin-bearer only (serving module bytes is static-asset-equivalent, not a capability invocation); 404 when the tool has no pack renderer. The internal containment check uses the **pack root**, so a `renderer: ../../lib/X.js` serves. |
| `GET /api/ext/packs/:packId/panels/:panelId?projectId=` | Serve a **pack-scoped panel's** pre-built ESM module bytes. Pack-addressed because panel ids are only pack-unique. Bearer-only (static-asset-equivalent); 404 when the pack is not installed/active or the panel id is unknown in that pack. Replaces the old tool-keyed panel endpoint. |
| `GET /api/ext/contributions?projectId=` | Project-scoped pack-contribution metadata for the client registries: one row per installed+active pack `{ packId, packName, panels, entrypoints, routeNames }` (empty arrays allowed — the always-emit contract keeps reconcile deterministic). **Activation-filtered** (disabled entrypoints omitted; panels/routes always present). |
| `POST /api/tools/:tool/actions/:action` | Invoke a pack tool's server action handler. Body `{ sessionId, toolUseId, args }`. **Authorized like a tool call** (the LLM can `curl` it directly): requires `x-bobbit-session-id`, `body.sessionId === header`, `:tool ∈ session.allowedTools`, `:action ∈ actions.names` (when declared), and a `toolUseId` that exists in the header-bound session and was a call of `:tool`. Runs the handler in the confined worker; returns its JSON result. |
| `POST /api/ext/surface-token` | Mint the **server-minted surface-binding token** (used internally by the trusted app). Accepts a **tool-bound** ref `{ sessionId, tool }` (gated by `allowedTools`) **or** a **pack-bound** ref `{ sessionId, contributionKind, contributionId, packId }` (gated by installed+active+own-session). The token binds `{sessionId, packId, contributionId, tool?}`; pack code never sees it. |
| `POST /api/ext/store/:op` | `host.store.{get,put,list}`. Scoped via the surface token; keys namespaced by the server-derived `packId` (cross-pack reads rejected). For a tool-bound token `authorizeScopedRequest` also layers `allowedTools`; a pack-bound token skips it (the token already proved installed+active+own-session). |
| `POST /api/ext/route/:name` | `host.callRoute(name, init)`. Derives `packId` from the surface token and resolves the route module via the pack-level `RouteRegistry` (`packId`-keyed), then dispatches it in the confined worker. No `<pack>` URL segment to forge; pack-bound (no-tool) tokens reach this path too. |
| `GET /api/ext/session/transcript` · `GET /api/ext/session/tool-call` | `host.session.readTranscript` / `readToolCall`. Own-session reads (scoped to the header-bound session) mapped through the internal→contract adapter. |

Session **writes** (`host.session.postMessage`) do **not** use a REST endpoint — they ride the app's authenticated session WebSocket (frames `ext_session_write_permit` → `ext_session_post`) so there is no capturable session secret on any `fetch`. The scoped endpoints (`store`/`route`/`session`-read) authorize through the surface token: a **tool-bound** token layers `authorizeScopedRequest` (the action guard **minus** the `toolUseId`-ownership step, so a panel/entrypoint surface with no owned tool call can still call them), while a **pack-bound** token (orphan/UI-only packs) skips the `allowedTools` gate entirely — its boundary is *installed + active in scope + own-session*. `invokeAction` keeps the full `authorizeActionRequest` (tool + `toolUseId` ownership).

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
- **No signing; isolation is stability-only, not a security sandbox.** Installing any pack copies its contents as-is — tool packs copy executable code, and role/skill packs copy instructions for an LLM with shell access. Pack source is **trusted** (the trust decision is the source-level warning when adding a source). Phase 2 runs pack server modules in a `worker_threads` worker, but that is **RESOURCE + CRASH isolation only** (terminate-on-timeout, memory/CPU caps, spawned-child kill) — explicitly **not** a security sandbox against a pack's own trusted code. Trusted pack server code runs with full ambient parity (normal `node:` built-ins, network globals, full `process` env), exactly like a tool or MCP server; there is no capability concept. Module-import resolution is contained to the pack root, but that is cheap loader/stability hygiene, not a security boundary (see the "Why?" disclosure and `extension-host.md §3.4`). The remaining gap is **per-pack realm isolation for UI** — pack UI shares the main thread's realm, so a deliberately malicious pack could monkey-patch globals; the surface-binding token and session-write permit close the accidental/non-pack-reachable paths but not a same-realm adversary. Per-pack signing and UI realm isolation are documented future hardenings.
- **Git sync is synchronous.** Add-source, re-sync, and install run git inline and block until done.
- **No hosted registry yet.** Sources are git repos or local dirs; the `MarketplaceSource` abstraction is kept open to a future hosted/searchable registry backend.
- **Portable workflows and staff templates are not packable.** Workflows stay project-scoped inline in `project.yaml`; staff templates are noted as a gap. (UI panels are now shipped as auto-discovered `panels/<panel>.yaml` pack contributions — see the [Extension Host](#extension-contributions-tool-renderers--server-actions) section.)
- **Privilege-minting is not pack-expressible; typed inference is out of scope for v1.** A pack acts within the calling session's authority; it cannot `team_spawn` (mint a new principal). There is no *typed* `host.model.*` inference method — not because the worker lacks credentials (a trusted pack has full ambient env + network, like any tool), but because a gateway-mediated inference contract is deferred. A parent-side `host.model.*` is the highest-value future additive capability — see [What is (and isn't) pack-expressible in v1](#what-is-and-isnt-pack-expressible-in-v1).
