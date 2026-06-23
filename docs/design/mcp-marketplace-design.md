# Marketplace MCP support — research and implementation design

Status: research artifact / implementation plan  
Scope: add Marketplace support for installable MCP server definitions and MCP registry/discovery sources without changing the existing manual MCP config cascade.

## 1. Current architecture summary

### Marketplace and packs

Relevant files:

- `src/server/agent/pack-types.ts`
  - `PackManifest.contents` already has optional schema-2 keys including `mcp?: string[]`.
  - `EntityType` is currently only `"roles" | "tools" | "skills"`; MCP is not a resolver entity yet.
  - `scopePaths(scope, base)` is the single source of truth for `<base>/.bobbit/config/market-packs`.
- `src/server/agent/pack-manifest.ts`
  - `validateManifest()` accepts `contents.mcp` only when `schema >= 2` and validates entries via `isSafeBasename()`.
  - Schema 1 still rejects `contents.mcp` with the old MVP-boundary message.
- `src/server/agent/pack-list.ts`
  - `scopeMarketPackEntries(scope, base, packOrder)` scans installed market packs and orders them low→high by `pack_order`.
  - `buildPackList()` appends installed market packs in scope order and preserves legacy role/tool/skill precedence.
- `src/server/agent/marketplace-source-store.ts`
  - `MarketplaceSource` is only `{ id, url, ref?, addedAt, lastSyncedAt?, lastCommit? }`; no source type exists.
  - Sources are persisted at `<server-cwd>/.bobbit/config/marketplace-sources.yaml`.
- `src/server/agent/marketplace-install.ts`
  - `MarketplaceInstaller.syncSource()` supports local directory and git sources.
  - `browsePacks()` only scans one-level directories containing `pack.yaml`.
  - `installPack()`, `updatePack()`, `uninstallPack()`, `listInstalled()` are directory-based; no per-entity ledger.
- `src/server/server.ts`
  - Marketplace REST lives in `handleApiRoute()` around `/api/marketplace/*`.
  - `buildActivationCatalogue()` already round-trips schema-2 `catalogue.mcp` and `DisabledRefs.mcp` as metadata.
  - `invalidateResolverCaches()` currently invalidates slash skills, tool scan cache, action dispatcher, route dispatcher, route registry, and pack contribution registry.
- `src/app/api.ts` and `src/app/marketplace-page.ts`
  - Client types currently expose activation rows for roles/tools/skills/entrypoints only, even though the server can return schema-2 arrays.
  - `entityChips()`, `renderActivationControls()`, `activationEntityTotal()`, `handleToggleAllActivation()` need MCP support.

### MCP runtime

Relevant files:

- `src/server/mcp/mcp-types.ts`
  - `McpServerConfig` supports stdio (`command`, `args`, `env`, `cwd`) and HTTP (`url`, `headers`).
- `src/server/mcp/mcp-client.ts`
  - `McpClient.connect()` chooses stdio when `command` is present, HTTP when `url` is present.
  - HTTP URL is validated via `new URL(config.url)`.
  - Stdio inherits environment and overlays `env` with `${VAR}` expansion.
- `src/server/mcp/mcp-manager.ts`
  - `discoverServers()` returns merged `Record<string, McpServerConfig>`.
  - Current precedence, later overrides earlier:
    1. project `config_directories` with type `mcp`
    2. additional registered projects: custom dirs, `.mcp.json`, `.claude/.mcp.json`, `.bobbit/config/mcp.json`
    3. `~/.claude.json` global `mcpServers`
    4. `~/.claude.json` project entry for current cwd
    5. `~/.claude/.mcp.json`
    6. `~/.bobbit/.mcp.json`
    7. `<cwd>/.mcp.json`
    8. `<cwd>/.claude/.mcp.json`
    9. `<cwd>/.bobbit/config/mcp.json`
  - `connectAll()`, `connectServer()`, `disconnectServer()`, `disconnectAll()` own lifecycle.
  - `getToolInfos()` emits per-operation internal tool ids (`mcp__<server>__<op>`); model-facing meta-tools are generated later.
- `src/server/mcp/mcp-meta.ts`
  - `makeMetaToolName(server, sub?)` creates model-facing `mcp_<server>` / `mcp_<server>__<sub>` names.
  - `parseMcpToolName()` is the single source of truth for internal per-op name parsing.
- `src/server/agent/tool-activation.ts`
  - `computeEffectiveAllowedTools()` collapses per-op MCP infos into meta-tools.
  - `writeMcpProxyExtensions()` emits one model-facing meta extension per server/sub-namespace.
  - Policy keys remain `mcp__<server>` / `mcp__<server>__<sub>`; Layer B per-op `never` is enforced in `/api/internal/mcp-call`.
- `src/server/agent/session-manager.ts`
  - `initMcp(cwd)` constructs `McpManager`, calls `connectAll()`, assigns `this.mcpManager`, then registers external MCP tools with `ToolManager`.
  - There is no general reload method; only `/api/mcp-servers/:name/restart` has local re-registration logic.
- `src/server/server.ts`
  - `GET /api/mcp-servers` returns runtime status and operation rows.
  - `POST /api/mcp-servers/:name/restart` rediscover/reconnects one server and re-registers all external MCP tools with `ToolManager`.
  - `POST /api/internal/mcp-call` and `/api/internal/mcp-describe` dispatch via `McpManager`.

### Tests and docs already pinning behavior

- Marketplace backend/unit:
  - `tests/pack-marketplace.test.ts`
  - `tests/marketplace-install.test.ts`
  - `tests/marketplace-activation-tool-catalogue.test.ts`
  - `tests/market-tool-runtime.test.ts`
  - `tests/market-tool-activation-runtime.test.ts`
  - `tests/marketplace-source-builtin.test.ts`
- Marketplace API/browser:
  - `tests/e2e/marketplace-provider-activation.spec.ts` already proves schema-2 `catalogue.mcp` and `disabled.mcp` round-trip.
  - `tests/e2e/ui/market-activation.spec.ts`
  - `tests/e2e/ui/marketplace.spec.ts`
- MCP:
  - `tests/mcp-unit.spec.ts`
  - `tests/mcp-failure-isolation.test.ts`
  - `tests/mcp-meta-*.test.ts`
  - `tests/mcp-write-extensions-isolation.test.ts`
  - `tests/e2e/mcp-integration.spec.ts`
  - `tests/e2e/mcp-meta-call.spec.ts`
  - `tests/e2e/mcp-tool-permission.spec.ts`
- Reference docs updated with implementation behavior:
  - `docs/marketplace.md` documents the MCP contribution schema, registry sources, activation/status split, trust model, and manual-over-Marketplace precedence.
  - `docs/extension-host-authoring.md` points `contents.mcp` authors to Marketplace MCP because it is schema-2-only and not an Extension-Host surface.
  - `docs/design/pack-based-marketplace.md` includes an MCP addendum that revises the original MVP boundary.
  - `docs/mcp-meta-tools.md` documents Marketplace activation vs Tools policy and scoped manager behavior.

## 2. Target model

Marketplace MCP should add two install paths that converge to the same installed pack format:

1. **Authored schema-2 packs** in existing git/local Marketplace sources:
   - `pack.yaml` declares `schema: 2` and `contents.mcp: [<name>]`.
   - Each listed basename maps to `mcp/<name>.yaml` or `mcp/<name>.json`.
2. **MCP registry/discovery URL sources**:
   - A source URL points at an MCP registry/discovery endpoint.
   - Browse maps each discovered server entry into a virtual pack row.
   - Install materializes a normal schema-2 pack directory under `market-packs/<pack-name>/` with `pack.yaml`, `mcp/<name>.yaml`, and `.pack-meta.yaml`.

After installation, both paths are identical: MCP discovery reads installed market packs, applies `DisabledRefs.mcp`, merges them with manual MCP config, then reconnects affected runtime servers and refreshes external MCP tools.

## 3. Pack-owned MCP schema

### `pack.yaml`

MCP contributions require `schema: 2`:

```yaml
schema: 2
name: context7-mcp
description: Context7 MCP server
version: 1.0.0
contents:
  roles: []
  tools: []
  skills: []
  entrypoints: []
  mcp: [context7]
```

`contents.mcp[]` remains a safe basename list. One entry corresponds to one file under `mcp/`.

### `mcp/<name>.yaml` contribution

Recommended strict YAML/JSON shape:

```yaml
# mcp/context7.yaml
server: context7                    # optional; defaults to list basename
label: Context7                     # optional UI label
description: Fetch library docs     # optional UI/status copy
transport:
  type: stdio
  command: npx
  args: ["-y", "@upstash/context7-mcp"]
  env:
    CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}"
  cwd: "."                         # optional; relative to pack root or absolute only if explicitly allowed
```

HTTP form:

```yaml
server: docs-remote
transport:
  type: http
  url: "https://mcp.example.com/mcp"
  headers:
    Authorization: "Bearer ${DOCS_MCP_TOKEN}"
```

Normalize both authored shapes to the existing runtime config:

```ts
export interface McpPackContribution {
  listName: string;              // contents.mcp basename, activation key
  serverName: string;            // runtime `mcpServers` key
  label?: string;
  description?: string;
  config: McpServerConfig;
  sourceFile: string;
  packRoot: string;
}
```

Validation rules:

- `listName` uses existing `isSafeBasename()`.
- `server` defaults to `listName`; it must match a new MCP server-name guard. Recommended: `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/`, no `/`, `\`, NUL, `..`, or `__` segments. Rationale: current runtime can technically accept arbitrary object keys, but tool-name generation/policy keys are saner with stable display-safe names.
- Exactly one transport type:
  - stdio: `transport.type: "stdio"`, non-empty `command`; optional `args: string[]`, `env: Record<string,string>`, `cwd: string`.
  - http: `transport.type: "http"`, valid `http:` or `https:` URL; optional `headers: Record<string,string>`.
- Reject unknown transport types and mixed `command`/`url` declarations.
- For pack-authored `cwd`:
  - Prefer relative paths resolved against pack root, with realpath containment via `isPackPathWithinRoot()`.
  - Allow absolute `cwd` only if we explicitly accept host-specific configs. Safer default: reject absolute paths for pack-owned MCP and ask authors to use environment variables if needed.
- Preserve `${VAR}` string interpolation behavior for `env`/headers by letting `McpClient` expand env values for stdio; add equivalent expansion for HTTP headers only if needed and documented.
- Drop malformed contribution files with a warning for browse/install descriptions; reject whole install only if the source pack declares `contents.mcp` but no valid corresponding contribution can be materialized. Prefer strict install failure for registry-generated packs, tolerant skip for unrelated malformed authored files.

Implementation files/functions:

- Add to `src/server/agent/pack-contributions.ts`:
  - `export interface McpPackContribution`.
  - `export function loadMcpContributions(packRoot: string, manifest: PackManifest): McpPackContribution[]`.
  - Include `mcp: McpPackContribution[]` on `PackContributions` only if useful for shared catalogue/status metadata; MCP runtime discovery can also call `loadMcpContributions()` directly.
- Add tests in a new `tests/marketplace-mcp-contributions.test.ts` for YAML and JSON happy paths, unsafe basename, invalid server names, mixed transport, invalid HTTP URL, and `cwd` containment.

## 4. Registry/discovery source support

### Source typing

Extend `MarketplaceSource` in `src/server/agent/marketplace-source-store.ts`:

```ts
export type MarketplaceSourceType = "pack" | "mcp-registry";

export interface MarketplaceSource {
  id: string;
  url: string;
  ref?: string;                  // pack/git only
  type?: MarketplaceSourceType;  // absent => "pack" for back-compat
  addedAt: string;
  lastSyncedAt?: string;
  lastCommit?: string;
  builtin?: boolean;
}
```

Source add behavior:

- Back-compat default: if `type` is absent, infer `pack` for local dirs, `file://`, git URLs, and existing rows.
- For registry URLs, add either:
  - explicit `type: "mcp-registry"` in `POST /api/marketplace/sources`, and a UI source-type selector; or
  - auto-detect only for well-known registry content types. Prefer explicit type to avoid treating an HTTPS git URL as a registry.
- `ref` is invalid for `mcp-registry`.
- Persist `type` only when not `"pack"` so old files remain clean.

### Registry fetch contract

Add a small registry client module rather than overloading git sync:

- New file: `src/server/agent/mcp-registry-source.ts`
- Functions:
  - `isMcpRegistrySource(source: MarketplaceSource): boolean`
  - `fetchMcpRegistry(source: MarketplaceSource): Promise<McpRegistryServer[]>`
  - `registryServerToVirtualPack(server): BrowsePack`
  - `materializeRegistryPack(server, destOrStagingDir): PackManifest`

Accept a conservative registry response shape first. This is the same normative contract restated in §13.2; do not support legacy examples without `schemaVersion` or `id`.

```json
{
  "schemaVersion": 1,
  "servers": [
    {
      "id": "context7",
      "name": "context7",
      "description": "Fetch library docs",
      "version": "1.0.0",
      "transport": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@upstash/context7-mcp"],
        "env": { "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}" }
      }
    },
    {
      "id": "docs-remote",
      "name": "docs-remote",
      "description": "Remote docs MCP",
      "version": "1.0.0",
      "transport": {
        "type": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": { "Authorization": "Bearer ${DOCS_MCP_TOKEN}" }
      }
    }
  ]
}
```

Virtual browse row:

```ts
BrowsePackWire & {
  virtual?: true;
  sourceType?: "mcp-registry";
  contents: { roles: []; tools: []; skills: []; entrypoints: []; mcp: [registryId] };
  hasTools: false;
}
```

Pack materialization on install:

```text
<staging>/
  pack.yaml
  mcp/<registry-id>.yaml
  .pack-meta.yaml
```

Generated `pack.yaml`:

```yaml
schema: 2
name: mcp-<registry-id>
description: <registry description>
version: <registry version or 0.0.0>
contents:
  roles: []
  tools: []
  skills: []
  entrypoints: []
  mcp: [<registry-id>]
```

Naming:

- Registry `id` is the stable pack-local `listName`, materialized file basename, `contents.mcp` ref, and default pack suffix.
- Registry `name` is the runtime MCP `serverName` after validation.
- Pack name is `mcp-<id>`; if it collides with an unrelated installed pack in the target scope, install returns `409` like normal packs.
- `dirName` in browse is `mcp-<id>`, never a raw URL or runtime server name.

Implementation files/functions:

- `src/server/agent/marketplace-source-store.ts`
  - Parse/serialize `type`.
  - Validate `type` and `ref` combination.
- `src/server/agent/marketplace-install.ts`
  - In `syncSource()` / `browsePacks()` branch by source type. Do not put registry responses into git cache.
  - Add `browseRegistryPacks(sourceId)` or fold into `browsePacks()` based on source type.
  - Add an install path that materializes virtual registry packs before the existing atomic rename/meta flow. Keep final install directory identical to normal packs.
  - Consider `sourceUrl` in `.pack-meta.yaml` remains the registry URL; `commit` empty; `sourceRef` empty.
- `src/server/server.ts`
  - `POST /api/marketplace/sources` accepts `type`.
  - Existing `/sources/:id/packs` remains the browse endpoint; returns virtual rows for registry sources.
- `src/app/api.ts`
  - Add `type?: "pack" | "mcp-registry"` to `MarketplaceSource` and `addMarketplaceSource(url, ref?, type?)`.
- `src/app/marketplace-page.ts`
  - Add source type UI.
  - Adjust placeholder/trust copy for registry URLs.

## 5. MCP discovery layering and precedence

### Recommended precedence

Marketplace MCP should be additive and lower than all existing manual config. Keep current manual override behavior unchanged by merging marketplace servers before manual sources.

Proposed `McpManager.discoverServers()` order, later overrides earlier:

0. **Marketplace MCP contributions** from installed, active market packs:
   - server-scope market packs
   - global-user market packs
   - project-scope market packs
   - plus additional registered projects if needed
1. Existing custom directories with type `mcp`
2. Existing additional registered projects
3. Existing `~/.claude.json` global
4. Existing `~/.claude.json` matching project
5. Existing `~/.claude/.mcp.json`
6. Existing `~/.bobbit/.mcp.json`
7. Existing `<cwd>/.mcp.json`
8. Existing `<cwd>/.claude/.mcp.json`
9. Existing `<cwd>/.bobbit/config/mcp.json`

Rationale:

- Manual config files are the escape hatch and should continue to override Marketplace installs by server name.
- Activation controls decide whether a Marketplace server exists at all, but they should not block manual config for the same server name.
- This minimizes breakage: installing a Marketplace `playwright` cannot override a user's existing `.mcp.json` `playwright` definition.

Alternative if product wants pack precedence parity: place Marketplace per scope at the matching config layer (`server < global-user < project`) just below each scope's user config. This is more complex and less compatible; not recommended for first implementation.

### Discovery implementation

Add a provider seam to `McpManager` instead of importing marketplace stores directly:

```ts
export type MarketplaceMcpProvider = () => Record<string, McpServerConfig>;

class McpManager {
  private marketplaceMcpProvider?: MarketplaceMcpProvider;
  setMarketplaceMcpProvider(provider: MarketplaceMcpProvider): void;
}
```

In `discoverServers()`:

```ts
const merged: Record<string, McpServerConfig> = {};
if (this.marketplaceMcpProvider) Object.assign(merged, this.marketplaceMcpProvider());
// existing manual merge order follows unchanged
```

Build the provider in `server.ts`, near the existing market pack providers:

- Enumerate market packs using `scopeMarketPackEntries()` exactly as activation catalogue does.
- For server/global-user, use `projectConfigStore`; for project use the relevant project context store.
- For each market pack:
  - Load `loadMcpContributions(entry.path, entry.manifest)`.
  - Get disabled refs via `getPackActivation(scope, packName).mcp`.
  - Drop contributions whose `listName` is disabled.
- Collapse by `serverName` in deterministic low→high scope/pack order; later Marketplace packs override earlier Marketplace packs before manual config overrides all Marketplace definitions.
- Skip malformed contributions with loud warnings, but do not crash all MCP discovery.

Be careful with the current self-managed project dedup behavior. `marketToolRoots()` dedups path collisions keeping the first/lowest scope; `buildPackList()` intentionally does not dedupe for ordering in some cases. For MCP, duplicate same physical pack through server/project should not connect twice; use a `seenPath` set unless tests prove parity requires self-shadowing.

Files/functions:

- `src/server/mcp/mcp-manager.ts`
  - Add `setMarketplaceMcpProvider()`.
  - Call provider first in `discoverServers()`.
- `src/server/server.ts`
  - Add `marketMcpServers(projectId?: string): Record<string, McpServerConfig>` helper.
  - Wire provider into the singleton `McpManager` after construction, and refresh it as project contexts change.
- `src/server/agent/session-manager.ts`
  - Either accept a preconfigured `McpManager` provider from server, or expose `reloadMcp()` (see next section) that can set the provider and reconnect.

## 6. Runtime reload flow

Current problem: Marketplace mutations only invalidate pack/entity caches. MCP runtime connects once in `SessionManager.initMcp()` and one-off `/api/mcp-servers/:name/restart` re-registers tools manually.

Add a focused reload method and reuse it from both Marketplace mutations and the restart endpoint.

### `McpManager.reloadDiscoveredServers()`

Add to `src/server/mcp/mcp-manager.ts`:

```ts
async reloadDiscoveredServers(): Promise<{
  added: string[];
  removed: string[];
  restarted: string[];
  unchanged: string[];
}>;
```

Algorithm:

1. `const next = discoverServers()`.
2. Compare with current `configs` by stable JSON stringification of `McpServerConfig`.
3. For names in current not in next: `disconnectServer(name)` and clear config/tool state.
4. For names in next not current: `connectServer(name, next[name])`.
5. For names in both with config changed: `connectServer(name, next[name])` (it disconnects first).
6. For names unchanged but currently disconnected/error? Prefer reconnect on explicit reload after marketplace changes; otherwise unchanged can remain. Recommended: reconnect errored servers only on explicit `restart`/`reload` flag to avoid repeated failed spawns on every UI toggle.

Add helper:

```ts
function registerMcpExternalTools(toolManager: ToolManager, mcpManager: McpManager): void {
  toolManager.removeExternalTools("mcp__");
  toolManager.registerExternalTools(mcpManager.getToolInfos().map(...));
}
```

Put this helper in `src/server/agent/mcp-tool-registration.ts` or `src/server/mcp/mcp-tool-registration.ts` to remove duplication between `SessionManager.initMcp()` and `/api/mcp-servers/:name/restart`.

### Server mutation flow

In `src/server/server.ts`, extend `invalidateResolverCaches()` or add `reloadMarketplaceMcp(reason)`:

1. Run existing cache invalidation.
2. If `sessionManager.getMcpManager()` exists:
   - call `await mcpManager.reloadDiscoveredServers()`.
   - re-register external tools on the server `toolManager` and each project context's `toolManager` if project-specific tool managers exist.
3. Broadcast or let UI poll `GET /api/mcp-servers` after mutation.

Use this after:

- `POST /api/marketplace/install`
- `POST /api/marketplace/update`
- `DELETE /api/marketplace/installed`
- `PUT /api/marketplace/pack-activation` when `disabled.mcp` may have changed
- Possibly `PUT /api/marketplace/pack-order` if Marketplace MCP precedence changes by reordering.

Do not restart live agents automatically. Existing agents will see changed MCP tools on next refresh/restart because the model-facing tool inventory is fixed at agent spawn. Runtime status and `/api/mcp-servers` should update immediately; new sessions and refreshed agents get the new meta-tools.

### Existing restart endpoint

Refactor `/api/mcp-servers/:name/restart` to:

- If a specific server is requested, keep per-server semantics.
- Use shared `registerMcpExternalTools()` after reconnect.
- Optionally add `POST /api/mcp-servers/reload` for full rediscovery and use it internally from Marketplace mutations.

## 7. Activation and UI behavior

### Activation catalogue

Server already returns `catalogue.mcp` for schema-2 packs in `buildActivationCatalogue()`. Enhance it from string-only to include display/status metadata while preserving existing array compatibility if necessary.

Minimal compatible option:

```ts
mcp: string[];
mcpStatus?: Record<string, { serverName: string; status?: "connected" | "disconnected" | "error"; toolCount?: number; error?: string }>;
```

Cleaner but breaking option:

```ts
mcp: Array<{ listName: string; serverName: string; label?: string; status?: ... }>;
```

Recommended: keep `mcp: string[]` for `DisabledRefs` normalization and add `mcpDetails` keyed by listName.

`GET /api/mcp-servers` is runtime status only; use it to annotate, never as the toggle source of truth. Disabled MCP entries must remain visible through `GET /api/marketplace/pack-activation`.

### Client changes

Files/functions:

- `src/app/api.ts`
  - Extend `DisabledRefs` with schema-2 keys already supported server-side: `providers`, `hooks`, `mcp`, `piExtensions`, `runtimes`, `workflows`.
  - Extend `PackActivationCatalogue` with optional arrays and MCP detail/status metadata.
  - Extend `PackManifest.contents` and `BrowsePackWire` to include schema-2 keys.
- `src/app/marketplace-page.ts`
  - `entityChips()` should render `mcp` chips.
  - `activationEntityTotal()` and `activationEntityEnabledCount()` include MCP.
  - `handleToggleAllActivation()` includes `mcp: cat.mcp`.
  - `ACTIVATION_KIND_KEY` adds `mcp` if not already there.
  - `renderActivationControls()` adds an MCP group.
  - Show runtime status pill next to MCP toggle when `mcpDetails` has status.
  - Update source trust warning to mention MCP servers as trusted host-tier code or remote endpoints.

MCP toggle granularity:

- Toggle `contents.mcp` list entries, which represent one MCP server/sub-namespace contribution.
- Do **not** toggle raw per-operation rows. Operation availability remains governed by MCP server `tools/list` plus Tools policy (`mcp__<server>` / `mcp__<server>__<sub>` and Layer B per-op `never`).

## 8. API contracts

### Add source

`POST /api/marketplace/sources`

```json
{ "url": "https://registry.example.com/mcp.json", "type": "mcp-registry" }
```

Response unchanged plus `type`:

```json
{ "source": { "id": "mcp-registry", "url": "...", "type": "mcp-registry", "addedAt": "...", "lastSyncedAt": "..." } }
```

### Browse source packs

`GET /api/marketplace/sources/:id/packs`

For registry sources:

```json
{
  "packs": [
    {
      "schema": 2,
      "name": "mcp-context7",
      "dirName": "mcp-context7",
      "description": "Fetch library docs",
      "version": "1.0.0",
      "contents": { "roles": [], "tools": [], "skills": [], "entrypoints": [], "mcp": ["context7"] },
      "hasTools": false,
      "virtual": true,
      "sourceType": "mcp-registry"
    }
  ]
}
```

### Install

`POST /api/marketplace/install` unchanged:

```json
{ "sourceId": "mcp-registry", "dirName": "mcp-context7", "scope": "server" }
```

Installer branches internally based on source type and materializes a normal pack.

### Activation

`GET/PUT /api/marketplace/pack-activation` continues to use `DisabledRefs.mcp`:

```json
{
  "scope": "server",
  "packName": "mcp-context7",
  "catalogue": {
    "roles": [],
    "tools": [],
    "skills": [],
    "entrypoints": [],
    "mcp": ["context7"],
    "mcpDetails": {
      "context7": { "serverName": "context7", "status": "connected", "toolCount": 3 }
    }
  },
  "disabled": { "mcp": [] }
}
```

Disabling:

```json
{ "scope": "server", "packName": "mcp-context7", "disabled": { "mcp": ["context7"] } }
```

Expected effect after PUT returns:

- `GET /api/marketplace/pack-activation` still shows `catalogue.mcp: ["context7"]` and `disabled.mcp: ["context7"]`.
- `GET /api/mcp-servers` no longer includes `context7` unless a manual config source defines it.
- `ToolManager` external MCP tools are re-registered without that server's operations.

## 9. Exact implementation sequence

1. **Schema and loader**
   - `src/server/agent/pack-contributions.ts`: add `McpPackContribution` and `loadMcpContributions()`.
   - `src/server/agent/marketplace-install.ts`: extend `readPackEntityDescriptions()` or add MCP-specific descriptions for browse/activation.
   - Tests: `tests/marketplace-mcp-contributions.test.ts`.
2. **Marketplace source type and registry browse**
   - `marketplace-source-store.ts`: source `type` persistence.
   - New `mcp-registry-source.ts`: fetch/validate/map/materialize.
   - `marketplace-install.ts`: branch `browsePacks()` and `installPack()` for registry sources.
   - `server.ts`: accept `type` in source POST.
   - Tests: unit/API for source persistence, registry browse, registry install.
3. **MCP discovery provider**
   - `mcp-manager.ts`: add marketplace provider seam and merge first.
   - `server.ts`: build provider from installed market packs + activation store.
   - Tests: manual config overrides marketplace; disabled marketplace omitted; project/server/global ordering.
4. **Reload and external tool re-registration**
   - `mcp-manager.ts`: add `reloadDiscoveredServers()`.
   - New helper for `ToolManager` registration.
   - `session-manager.ts` and `/api/mcp-servers/:name/restart`: use helper.
   - Marketplace mutation handlers: call MCP reload after install/update/uninstall/activation/order.
   - Tests: install connects, disable disconnects/unregisters, re-enable reconnects, uninstall cleans stale tools.
5. **Market UI**
   - `api.ts`: schema-2 type extensions.
   - `marketplace-page.ts`: source type selector, MCP chips/toggles/status, trust warning.
   - Browser E2E for add registry URL → browse → install → status → disable/re-enable → reload persistence → uninstall cleanup.
6. **Docs**
   - Update `docs/marketplace.md`, `docs/extension-host-authoring.md`, MCP docs, and old design docs to replace out-of-scope text with the final schema/precedence/reload model.

## 10. Test plan

### Unit tests

- `tests/marketplace-mcp-contributions.test.ts`
  - Parses stdio contribution.
  - Parses HTTP contribution.
  - Rejects unsafe `contents.mcp` basename.
  - Rejects invalid server name.
  - Rejects mixed/missing transport.
  - Rejects bad HTTP URL.
  - Rejects or normalizes unsafe `cwd`.
- `tests/marketplace-source-store.test.ts` or extend `tests/marketplace-install.test.ts`
  - `MarketplaceSource.type` persists and defaults to `pack` for legacy rows.
  - `ref` rejected/ignored for `mcp-registry`.
- `tests/marketplace-mcp-registry.test.ts`
  - Mock fetch registry response with multiple servers.
  - Browse returns virtual pack records with `contents.mcp` chips.
  - Install materializes normal schema-2 pack with `.pack-meta.yaml`.
- `tests/mcp-manager-marketplace-discovery.test.ts`
  - Marketplace server discovered before manual sources.
  - Manual `.bobbit/config/mcp.json` overrides same-name marketplace config.
  - Disabled `DisabledRefs.mcp` entry omitted.
  - Marketplace pack order determines same-name marketplace winner.

### API E2E

- Extend or add `tests/e2e/marketplace-mcp.spec.ts`:
  - Add registry source.
  - Browse two MCP virtual packs.
  - Install one to server scope.
  - `GET /api/marketplace/installed` includes schema-2 MCP pack.
  - `GET /api/marketplace/pack-activation` includes `catalogue.mcp` and status metadata.
  - Disable via PUT; `GET /api/mcp-servers` omits it.
  - Re-enable; `GET /api/mcp-servers` includes it.
  - Uninstall; no stale runtime server/tool remains.
- Use `tests/fixtures/mock-mcp-server.mjs` or `fake-mcp-server.ts` for stdio happy path.
- Add an HTTP MCP fixture server in-process for HTTP happy path.

### Browser E2E

- New `tests/e2e/ui/marketplace-mcp.spec.ts`:
  1. Open Market.
  2. Add MCP registry/discovery URL using the new source type.
  3. Browse multiple servers as cards with MCP chips.
  4. Install one.
  5. Installed tab shows MCP chip/toggle/status.
  6. Disable toggle; runtime status disappears/disabled state visible.
  7. Reload page; disabled MCP toggle remains visible and unchecked.
  8. Re-enable; status returns.
  9. Uninstall; installed row and runtime status disappear.

### Existing regression suite

Run:

```bash
npm run check
npm run test:unit
npm run test:e2e
```

Pay special attention to existing MCP tests:

- `tests/e2e/mcp-integration.spec.ts`
- `tests/e2e/mcp-meta-call.spec.ts`
- `tests/e2e/mcp-tool-permission.spec.ts`
- `tests/grant-policy.test.ts`

## 11. Risks and decisions

1. **Manual vs Marketplace precedence**
   - Risk: users expect installed Marketplace MCP to override manual `.mcp.json`.
   - Decision: manual wins initially. It is safer and preserves existing behavior.
2. **Registry spec ambiguity**
   - Risk: external MCP registries may not share one response format.
   - Decision: implement a strict Bobbit-supported discovery JSON first; adapters for known registries can be added behind the same `fetchMcpRegistry()` seam.
3. **Secrets and environment variables**
   - Risk: registry/pack entries may require secrets. Marketplace must not store secret values casually.
   - Decision: support env-var placeholders in contribution files; document that users configure environment/secrets outside Marketplace. Future work can add scoped secret prompts.
4. **Stdio host-tier risk**
   - Risk: installing MCP stdio can execute arbitrary host commands.
   - Decision: update trust messaging to explicitly call MCP host-tier code / remote endpoints; no per-server sandbox is claimed.
5. **Reload side effects**
   - Risk: reconnecting MCP servers on every pack toggle may spawn/kill processes unexpectedly.
   - Decision: reload only after Marketplace MCP-affecting mutations; compare configs to avoid needless restarts. Do not restart live agents automatically.
6. **Disabled Marketplace vs manual same-name server**
   - Risk: disabling a Marketplace MCP entry may not remove `GET /api/mcp-servers` if manual config defines the same server.
   - Decision: document and test this as precedence behavior: disable removes Marketplace contribution only; manual config remains active.
7. **Per-operation toggles**
   - Risk: users may ask to disable one operation from Market.
   - Decision: not in first pass. Market toggles server/sub-namespace contribution existence; Tools policy remains the operation/security layer.
8. **Type drift between server and client**
   - Risk: server already supports schema-2 activation keys but `src/app/api.ts` does not. UI changes must update the wire types first to avoid implicit `any`/missing toggle bugs.

## 12. Non-goals for first implementation

- No raw per-operation Marketplace activation.
- No Marketplace-managed secret store UI.
- No automatic live-agent restart after MCP install/disable.
- No hosted/searchable registry UX beyond adding a registry URL and browsing returned entries.
- No change to existing manual `.mcp.json`, Claude config, or custom config directory discovery support.

## 13. Review clarifications required before implementation

This section resolves design-review gaps and is normative for implementation.

### 13.1 Normalized MCP contribution records

Authored pack files use `transport` for readability, but runtime receives only the existing `McpServerConfig` shape. Loaders normalize into two records:

```ts
interface McpContributionRuntimeRecord {
  listName: string;        // contents.mcp basename and DisabledRefs.mcp key
  serverName: string;      // mcpServers object key and runtime status key
  config: McpServerConfig; // exact object merged into McpManager.discoverServers()
  origin: ResolvedMcpOrigin;
}

interface McpContributionCatalogueRecord {
  listName: string;
  serverName: string;
  label?: string;
  description?: string;
  transportType: "stdio" | "http";
  commandPreview?: string;
  endpointPreview?: string;
  envKeys?: string[];
  headerKeys?: string[];
  origin: ResolvedMcpOrigin;
}
```

Mapping table:

| Contribution field | Runtime `McpServerConfig` | Catalogue metadata | Rule |
|---|---|---|---|
| `server` | object key only | `serverName` | Defaults to `listName`; not copied into config. |
| `label` | none | `label` | UI/status only. |
| `description` | none | `description` | UI/status only. |
| `transport.type: stdio` | chooses stdio mapping | `transportType` | Requires `command`, forbids `url`/`headers`. |
| `transport.command` | `command` | `commandPreview` | Non-empty string. |
| `transport.args` | `args` | `commandPreview` | Optional string array; default omitted. |
| `transport.env` | `env` | `envKeys` only | Values remain literal strings such as `${TOKEN}`; existing stdio env expansion remains in `McpClient`. |
| `transport.cwd` | `cwd` | none | Relative path resolved to an absolute path within pack root before runtime merge. |
| `transport.type: http` | chooses HTTP mapping | `transportType` | Requires `url`, forbids `command`/`args`/`cwd`. |
| `transport.url` | `url` | `endpointPreview` | Must parse as `http:` or `https:`. |
| `transport.headers` | `headers` | `headerKeys` only | Values remain literal strings; no secret values are displayed. |

Unknown top-level keys and unknown transport keys are validation errors. A malformed MCP contribution is skipped during catalogue scans with a warning for authored multi-entity packs, but registry materialization fails the selected install because a registry virtual pack represents one MCP server.

Tests must assert exact normalized `McpServerConfig` output, not only UI metadata.

### 13.2 Registry/discovery URL contract

Bobbit registry sources use a strict versioned JSON document:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-06-23T00:00:00.000Z",
  "servers": [
    {
      "id": "context7",
      "name": "context7",
      "label": "Context7",
      "description": "Fetch library docs",
      "version": "1.0.0",
      "homepage": "https://example.com/context7",
      "transport": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@upstash/context7-mcp"],
        "env": { "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}" }
      }
    },
    {
      "id": "docs-remote",
      "name": "docs-remote",
      "description": "Remote docs MCP",
      "version": "1.0.0",
      "transport": {
        "type": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": { "Authorization": "Bearer ${DOCS_MCP_TOKEN}" }
      }
    }
  ]
}
```

Required fields: `schemaVersion: 1`, `servers[]`, per-server `id`, `name`, and `transport`. `id` is the stable registry package identity and must be a safe basename. `name` is the runtime MCP server name and must pass the MCP server-name guard. Optional metadata is preserved only in `.pack-meta.yaml` and activation catalogue details.

Virtual pack identity:

- `dirName` and installed `pack.yaml.name` default to `mcp-${id}`.
- If `mcp-${id}` collides with an existing installed pack in the target scope, install returns `409` unless the installed pack has matching source URL and registry `id`, in which case `update` semantics apply.
- Refresh/update detection compares source URL, registry `id`, `version`, and a stable fingerprint of the normalized runtime config plus catalogue metadata.
- `.pack-meta.yaml` records `sourceType: mcp-registry`, `sourceUrl`, `registryId`, `registryVersion`, `registryFingerprint`, and `materializedAt`.

Failure behavior:

- Invalid HTTP response, non-JSON body, unsupported `schemaVersion`, or missing `servers` fails browse for that source with a registry error.
- Invalid individual server entries are skipped; browse returns valid virtual packs plus `skippedCount` and concise validation messages for UI warnings.
- Duplicate `id` values in one registry keep the first valid entry and report later duplicates as skipped. Duplicate runtime `name` values across different ids are skipped unless their normalized configs are identical.
- Registry source `ref` is rejected at source creation and ignored for legacy malformed rows.

### 13.3 Scoped marketplace MCP resolver contract

Use an explicit scoped resolver:

```ts
interface ResolveMarketplaceMcpOptions {
  cwd: string;
  projectId?: string;
}

interface ResolvedMcpOrigin {
  scope: "server" | "global-user" | "project";
  packName: string;
  packRoot: string;
  sourceId?: string;
  listName: string;
}

interface ResolvedMcpContribution extends McpContributionRuntimeRecord {
  catalogue: McpContributionCatalogueRecord;
}

type MarketplaceMcpResolver = (options: ResolveMarketplaceMcpOptions) => ResolvedMcpContribution[];
```

Resolution order is deterministic low to high within Marketplace before manual config overrides all Marketplace entries:

1. Server-scope installed packs in `pack_order` order.
2. Global-user installed packs in `pack_order` order.
3. Project-scope installed packs for `projectId`/`cwd` only, in that project's `pack_order` order.

For each pack, load `contents.mcp` in manifest order and drop entries listed in `getPackActivation(scope, packName).mcp` before same-name collision resolution. Same `serverName` collisions within Marketplace are resolved by later entries overriding earlier entries; the resolver logs origin replacement. A `seenPath` guard avoids resolving the same physical market-pack directory twice for one `cwd`.

`McpManager` receives a bound resolver and calls it as:

```ts
for (const contribution of resolver({ cwd: this.cwd, projectId: this.projectId })) {
  merged[contribution.serverName] = contribution.config;
}
// existing manual config discovery follows unchanged and may override these keys
```

Tests must cover server/global-user/project ordering, pack-order changes, project isolation, disabled refs before merge, Marketplace same-name override, and manual same-name override.

### 13.4 Runtime boundary, reload scoping, status APIs, and internal call routing

MCP runtime state must be scoped to the same project/cwd context used by discovery. Do not use one context-dependent singleton state for all projects.

Implementation contract:

- `SessionManager` owns one default/system `McpManager` for the server cwd as today, plus a per-project/per-cwd manager map for project contexts that need project-scoped marketplace MCP.
- Manager key: normalized `projectId` when available, otherwise normalized cwd.
- Each `McpManager` stores its own `cwd`, optional `projectId`, marketplace resolver binding, clients, error/status map, and registered tool infos.
- Manager creation points are explicit: session/project-context creation, project-scoped Market install/update/activation, and first tool-registration request for a known project. Plain status reads do **not** instantiate managers unless `ensure=true` is supplied by an authenticated UI action that already selected a known project.
- Managers are reused while their project/session context is active. On project removal, session teardown, or worktree cleanup, the corresponding manager runs `disconnectAll()`, unregisters scoped external MCP tools, removes scoped tool-doc cache directories, and is deleted from the map.
- Idle managers with no live sessions and no in-flight reload are evicted after a bounded TTL (for example 30 minutes), disconnecting clients first. Server/global-user mutations only reload currently active managers; evicted managers pick up changes on next creation.
- `GET /api/mcp-servers` accepts optional `projectId` or `cwd` query parameters. Without parameters it returns the default/system manager for backward compatibility. By default this endpoint is read-only and returns `404`/empty scoped status for unknown inactive projects rather than spawning processes.
- Marketplace mutation reload chooses affected managers: server/global-user mutations reload all active managers; project-scope mutations reload only that project/cwd manager plus the default manager if the edited project is the current cwd.
- Tool registration is per manager/tool-manager context. A project manager refreshes only its project `ToolManager`; the default manager refreshes only the default server `ToolManager`.
- Runtime status responses include `scopeKey`, `projectId?`, and `cwd` so UI/tests can verify no cross-project leakage.

Internal execution routing must use the same manager as tool registration:

- `writeMcpProxyExtensions()` embeds or sidecars a server-trusted `scopeKey` for each generated MCP meta-tool extension. The scope key is derived from the session/project context on the server, not from model-controlled arguments.
- Generated `mcp_<server>` and `mcp_<server>__<sub>` extensions include `scopeKey` in `/api/internal/mcp-call` and `/api/internal/mcp-describe` requests. This field is accepted only on internal authenticated extension calls, not public/user-authored payloads.
- `/api/internal/mcp-call` and `/api/internal/mcp-describe` resolve `McpManager` by `scopeKey` first, then fall back to the session-bound manager, then the default manager for backward compatibility.
- Server-side routing validates that the requested tool/server exists in the resolved manager's current tool infos before dispatch. A same-name server in another manager is never considered.
- Tool docs paths remain per manager: default manager keeps the current `<stateDir>/mcp-tool-docs/`; project managers write to `<stateDir>/mcp-tool-docs/<scopeKey>/` or another deterministic scoped subdirectory to avoid same-name doc collisions.

Tests must create two project contexts with different project-scope MCP packs using the same runtime server name, trigger reloads concurrently, and assert each `GET /api/mcp-servers?projectId=...`, generated tool registration, `mcp_describe`, and operation call route only to that project's manager plus shared server/global-user MCP.

### 13.5 Runtime reload consistency and concurrency

Marketplace-triggered MCP reloads are serialized per manager with a single-flight queue/lock:

```ts
private reloadChain: Promise<McpReloadResult> = Promise.resolve(initialResult);
reloadDiscoveredServers(reason: string): Promise<McpReloadResult> {
  this.reloadChain = this.reloadChain.catch(() => initialResult).then(() => this.performReload(reason));
  return this.reloadChain;
}
```

`performReload()` semantics:

1. Build `next` via `discoverServers()` and compute deterministic config fingerprints by stable JSON stringify with sorted object keys.
2. Disconnect removed servers first and remove their tool docs/tool-info cache entries.
3. For added/changed servers, attempt connect into a temporary client/result slot.
4. A failed added server is recorded in MCP runtime status as error and contributes no external tools.
5. A failed changed-server reconnect replaces the old config/status with the new error state and removes old tools. This avoids stale tools for a now-disabled or changed command.
6. Unchanged connected servers keep their clients; unchanged errored servers are not retried unless the caller uses explicit restart/retry.
7. After all connect/disconnect attempts settle, refresh that manager's `ToolManager` external MCP tools once, from `mcpManager.getToolInfos()` for currently connected clients only.

Tool registration is atomic from the `ToolManager` perspective: build the complete next MCP external-tool array first, then call `removeExternalTools("mcp__")` and `registerExternalTools(nextTools)` synchronously in one helper. Marketplace mutation handlers await bounded reload and registration before responding, but pack state persistence remains successful even if runtime reload reports errors.

Tests must include overlapping activation/uninstall requests, failed reconnect removing stale tools, disabled server removal, re-enable reconnect, and unchanged server not restarted unnecessarily.

### 13.6 Canonical `DisabledRefs.mcp` identity

The canonical activation ref is always the pack-local manifest `contents.mcp` list name (`listName`). It is not the runtime `serverName`, not a generated meta-tool name, and not an operation id.

Rules:

- `DisabledRefs.mcp` stores `listName` strings per installed pack: `pack_activation[scope][packName].mcp = [listName]`.
- Activation catalogue rows are keyed by `listName` and include `serverName`, `label`, `transportType`, optional `subNamespace`, and runtime status metadata.
- `listName !== serverName` is supported and must be tested.
- Registry materialization uses registry `id` as `listName`; registry `name` is the runtime `serverName`.
- Duplicate runtime server names across packs do not change ref identity because activation is per pack and per listName.
- Disabling a contribution removes that pack-local Marketplace contribution before same-name resolution; it does not disable another pack's same-name contribution or any manual config.
- Registry updates preserve disabled state as long as registry `id`/materialized `listName` is unchanged, even if runtime `name` or transport config changes.

### 13.7 Mutation response timeout and partial-failure semantics

Marketplace install/update/uninstall/activation persistence is not rolled back because an MCP server is slow or fails to connect.

- Persist pack/activation state first.
- Trigger affected-manager reloads with bounded connect/list timeouts using existing MCP connect/tool-list timeout constants where possible; add an overall per-manager marketplace reload budget of 30 seconds for API response latency.
- If reload completes within budget, mutation responses include `{ mcpReload: { status: "ok" | "partial" | "error", added, removed, restarted, failed } }`.
- If reload exceeds budget, response still succeeds for the pack mutation with `{ mcpReload: { status: "pending" } }`; the queued reload continues in the background and `GET /api/mcp-servers?projectId=...` exposes `reloadStatus: "running"` until it settles.
- Failed or timed-out servers remain represented in runtime status with `status: "error"`, `error`, and `lastAttemptAt`; they contribute no external tools.
- UI copy distinguishes pack mutation success from runtime connection failure: the toggle stays in the saved state, while the status lozenge shows `Error` or `Reconnecting`.

### 13.8 Strict validation rules

Validation must be centralized in shared helpers so authored packs, registry browse, registry materialization, and activation catalogue construction agree.

Name/path rules:

- `listName` / `contents.mcp[]` / registry `id`: existing `isSafeBasename()` plus length 1-64; reject `.`, `..`, path separators, NUL, leading dot, whitespace-only, and Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`).
- Runtime `serverName` / registry `name`: `/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/`; reject `__`, path separators, NUL, `.`/`..`, and names that normalize to an empty MCP meta-tool name.
- Generated pack name `mcp-${id}`: validate with the same pack-name guard used by Marketplace installs after prefixing; reject if the final install path's realpath escapes the target `market-packs` root.
- Materialized file path: exactly `mcp/${id}.yaml`; never use runtime `serverName` for paths. Ensure realpath containment for staging and final install directories.
- Contribution `cwd`: if absent, omit from runtime config; if present, it must be a relative path without drive letter, URL scheme, leading slash, NUL, or `..` segment after normalization, and final realpath must stay inside pack root.
- HTTP URL: parse with `new URL`; allow only `http:` and `https:`; reject credentials in URL (`username`/`password`) and fragments; headers must carry auth.
- Header/env keys: non-empty strings without NUL or newline. Values must be strings; UI displays keys only.
- Args: string array only; reject objects/numbers/null.

Schema rules:

- `pack.yaml` MCP is accepted only for `schema: 2`.
- Registry document requires `schemaVersion: 1`; unsupported versions fail browse for the source.
- Unknown keys are rejected at each level unless explicitly documented as metadata. Optional registry metadata allowed: `label`, `description`, `version`, `homepage`, `license`, `publisher`; it is preserved for UI/meta only.

Tests must include path traversal ids, unsafe server names, Windows device names, absolute/escaping cwd, URL credentials/fragments, invalid arg/env/header types, and schema-version failures.

### 13.9 Sub-namespace activation semantics

First implementation supports both flat server contributions and explicit declared sub-namespace contributions without collapsing the activation model to bare `serverName`.

Contribution identity and connection grouping are separate:

```ts
interface ResolvedMcpContribution {
  listName: string;                 // pack-local activation ref
  serverName: string;               // connection/runtime server key
  subNamespace?: string;            // optional declared meta-tool sub-namespace
  config: McpServerConfig;
  origin: ResolvedMcpOrigin;
  catalogue: McpContributionCatalogueRecord;
}

interface ResolvedMcpConnectionGroup {
  serverName: string;
  config: McpServerConfig;
  ownerContributions: ResolvedMcpContribution[];
  activeSubNamespaces?: Set<string>; // undefined means all namespaces for flat/server contribution
}
```

Default flat behavior:

- One `contents.mcp` `listName` without `subNamespace` represents one installed MCP server contribution.
- Disabling that `listName` omits the contribution from resolver output. If no other enabled contribution owns the same server/config, the server disconnects and all its model-facing meta-tools disappear.

Explicit sub-namespace behavior for gateway-style authored packs:

```yaml
server: gr
subNamespace: ai-adoption
transport: { type: http, url: "https://gateway.example.com/mcp" }
```

- `listName` remains the activation ref for that pack-local server/sub-namespace contribution.
- `serverName + subNamespace` maps to model-facing `mcp_<server>__<sub>` and policy key `mcp__<server>__<sub>`.
- Contributions with the same `serverName` and byte-identical normalized `config` are grouped into one MCP client connection. Their enabled `subNamespace` values become `activeSubNamespaces` for meta-tool registration.
- A flat contribution for a server (`subNamespace` absent) is an all-namespaces owner and cannot coexist with sub-namespace owners for the same `serverName`/config in one Marketplace precedence layer; later precedence wins and status marks earlier rows overridden.
- Same `serverName` with different configs still follows server config collision rules; later Marketplace/manual owner wins the connection group.
- `McpManager.getToolInfos()` can still list raw operations from the connected server, but `writeMcpProxyExtensions()` / meta-tool aggregation receives the active contribution metadata and filters model-facing meta-tools to enabled declared sub-namespaces. Per-operation dispatch remains Layer-B policy only.
- Disabling one explicit sub-namespace removes only that `mcp_<server>__<sub>` meta-tool while keeping the shared MCP client alive if other enabled contributions still require it. If no enabled contribution remains for the group, disconnect the server.
- Dynamic runtime sub-namespaces not declared by installed contributions are not surfaced as Market toggles; they remain read-only in Tools if a flat owner exposes the whole server.

Collision rules:

- Duplicate `serverName + subNamespace` contributions: later Marketplace precedence wins; earlier row state is `overridden-by-marketplace`.
- Duplicate `listName` inside one pack is invalid at manifest validation.
- Manual config with the same `serverName` overrides the whole Marketplace connection group; rows become `overridden-by-manual`.

Tests must cover flat server activation, two enabled sub-namespaces sharing one server config, disabling one while the other remains active, duplicate sub-namespace conflicts, flat-vs-subnamespace precedence, manual override, and no raw per-operation activation rows.

### 13.10 Runtime status ownership for duplicate names

Activation catalogue status must be keyed by pack-local `listName` plus origin, not by bare runtime `serverName` alone.

Catalogue/status states:

- `disabled`: `listName` is in `DisabledRefs.mcp`; runtime lookup is not used for that row except to show a note if a same-name manual server is active.
- `active-owner`: this contribution wins Marketplace resolution and is not overridden by manual config; runtime status comes from its manager/server.
- `overridden-by-marketplace`: another later Marketplace contribution with the same `serverName` wins; row remains enabled but status says `Overridden by <pack>`.
- `overridden-by-manual`: manual config overrides this Marketplace contribution; row remains enabled but status says `Manual config active`.
- `error` / `connected` / `reconnecting`: only for the active owner.

`GET /api/marketplace/pack-activation` should include enough `mcpDetails` origin/runtime-owner metadata for the UI to render these states without guessing from `GET /api/mcp-servers` by name. Tests must cover disabled same-name manual fallback and duplicate Marketplace server names.

### 13.11 Cache invalidation after Marketplace MCP mutations

After install/update/uninstall/activation/pack-order changes, reuse existing Marketplace cache invalidation and add MCP-specific invalidation:

- invalidate `PackResolver`/slash-skill/tool scan caches as current Marketplace mutations do;
- invalidate activation catalogue/status cache for the touched scope/pack;
- invalidate registry browse cache for updated registry sources;
- invalidate MCP contribution loader caches for touched pack roots;
- clear scoped MCP tool-doc cache entries for removed/changed servers;
- refresh pack contribution registry if pack server/actions/routes are present;
- broadcast Market/runtime status refresh events or ensure mutation responses include fresh `mcpReload` state.

### 13.12 Documentation deliverables

The documentation gate must update:

- `docs/marketplace.md`: final MCP contribution schema, registry source flow, activation/status behavior, trust model, and manual-over-Marketplace precedence.
- `docs/extension-host-authoring.md`: document that `contents.mcp` is schema-2-only and link authors to Marketplace MCP contribution rules.
- `docs/mcp-meta-tools.md`: explain Marketplace activation vs Tools policy and server/sub-namespace toggle granularity.
- `docs/design/pack-based-marketplace.md`: revise the old MVP/out-of-scope boundary or point to the new Marketplace MCP design.
- Any MCP/runtime docs that list discovery precedence: add Marketplace as the lowest-priority installed layer and document the disabled/manual same-name exception.
