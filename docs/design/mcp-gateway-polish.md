# MCP Gateway Polish

Status: design artifact for `design-doc` gate  
Scope: Marketplace MCP gateway source identity, all-source Browse, installed gateway package operation selection, MCP Tools policy hierarchy, and runtime union/conflict behavior.

## Goals

- Preserve the external MCP gateway wire protocol and response shape. Bobbit adapts locally; gateway endpoints do not change.
- Make MCP gateway source names user-readable from URL authority + path and deterministic for duplicates.
- Browse all available package/provider rows across built-in, pack, and MCP gateway sources with per-row source provenance, source filters, and text search.
- Let installed MCP gateway packages opt operations in/out individually, with disabled operations remaining visible and persisted.
- Make Tools policy apply at server, package/subnamespace, and individual operation levels.
- Allow multiple installed gateway packages/sources to expose a union of selected operations, with deterministic precedence for model-facing name clashes.
- Keep manual JSON MCP configuration behavior compatible.

## Current architecture summary

Relevant current code:

- Source storage: `src/server/agent/marketplace-source-store.ts`
  - `MarketplaceSource.type` supports `"pack" | "mcp-gateway"`; legacy `"mcp-registry"` rows are surfaced as unsupported.
  - `deriveSourceId()` currently derives an id from the last URL/path segment, not the normalized gateway authority/path.
  - `MarketplaceSource` has no persisted display name.
- Gateway parsing/materialization: `src/server/agent/mcp-gateway-source.ts`
  - `fetchMcpGatewayWithDiagnostics()` discovers via MCP protocol or catalogue mode and returns providers + skipped diagnostics.
  - `gatewayProviderToVirtualPack()` produces virtual schema-2 packs.
  - `materializeGatewayProviderPack()` writes `pack.yaml`, `mcp/<provider>.yaml`, optional write YAML, and `.pack-meta.yaml`.
  - Gateway provider packs currently materialize runtime servers like `gr` / `gr-write` with `subNamespace: <providerId>`.
- Marketplace install/browse: `src/server/agent/marketplace-install.ts`
  - `browseSourcePacks(sourceId)` browses exactly one source.
  - `BrowsePack` has gateway metadata, but no canonical source metadata on every row.
  - `listInstalled()` returns installed rows by scope; update detection still assumes installed `packName` is unique inside a source/scope.
- Marketplace routes: `src/server/server.ts`
  - `GET /api/marketplace/sources/:id/packs` browses one source.
  - `GET/PUT /api/marketplace/pack-activation` persists disabled pack entities, including whole MCP contribution refs in `disabled.mcp`.
  - `buildActivationCatalogue()` enriches MCP entries from `loadPackContributions()` + `GET /api/mcp-servers` status.
- Pack activation persistence: `src/server/agent/project-config-store.ts`
  - `DisabledRefs` supports arrays by entity kind, including `mcp?: string[]`, but not nested operation selections.
- MCP contributions/runtime: `src/server/agent/pack-contributions.ts`, `src/server/mcp/mcp-manager.ts`
  - `McpPackContribution` has `listName`, `serverName`, optional `subNamespace`, and `config`.
  - `McpManager.groupMarketplaceContributions()` groups by `serverName`; same server with different config overrides prior contributions.
  - `getToolInfos()` exposes connected operation names as `mcp__<server>__<op>` or `mcp__<server>__<sub>__<op>` and filters inactive subnamespaces.
- Tool policy/runtime registration: `src/server/agent/tool-activation.ts`, `src/app/tool-manager-page.ts`
  - Server-level `mcp__<server>` and package/subnamespace-level `mcp__<server>__<sub>` policies are supported.
  - Exact per-operation role policy works only as an exact `role.toolPolicies[toolName]` match; group-policy defaults do not currently check a full operation key before sub/server keys.
  - `/api/internal/mcp-call` enforces `never` via `resolveGrantPolicy()` before dispatch.
- Tools UI: `src/app/tool-manager-page.ts`
  - MCP section renders server rows, subnamespace rows, and operation rows, but operation rows use normal `renderToolRow()` editing rather than a dedicated operation policy selector.

## 1. Normalized MCP gateway source naming

### Name normalization

Add a pure helper in `src/server/agent/marketplace-source-store.ts`:

```ts
export interface NormalizedMcpGatewaySourceName {
  baseName: string;       // e.g. "mcp-local.t3.zone/readonly/mcp"
  slugBase: string;       // e.g. "mcp-local-t3-zone-readonly-mcp"
}

export function normalizeMcpGatewaySourceName(url: string): NormalizedMcpGatewaySourceName;
```

Rules:

1. Parse with `new URL(url)` and require `http:` or `https:` for `type: "mcp-gateway"`.
2. Use `url.host` plus `url.pathname`.
   - `host` preserves a non-default port and omits protocol.
   - `pathname` is preserved after URL parser normalization.
3. Drop query and hash unconditionally.
4. Trim all trailing slashes from the combined value.
5. If the resulting path is empty/root, display just `host`.
6. Lowercase host via URL parsing; do not lowercase the path.

Examples:

| Input | Base display name |
| --- | --- |
| `http://mcp-local.t3.zone/readonly/mcp` | `mcp-local.t3.zone/readonly/mcp` |
| `https://mcp.example.com:8443/mcp/?token=x#frag` | `mcp.example.com:8443/mcp` |
| `https://mcp.example.com/` | `mcp.example.com` |

### Persisted identity and duplicates

Extend `MarketplaceSource` for gateway sources:

```ts
interface MarketplaceSource {
  id: string;
  type?: "pack" | "mcp-gateway" | "mcp-registry";
  url: string;
  displayName?: string;       // response + persisted for MCP gateway sources
  normalizedName?: string;    // baseName before duplicate suffix
  // existing fields...
}
```

On add for `type: "mcp-gateway"`:

1. Compute `normalizedName` from URL.
2. Compute `displayName` by applying a stable duplicate suffix against already persisted gateway sources:
   - first matching base: `mcp-local.t3.zone/readonly/mcp`
   - second: `mcp-local.t3.zone/readonly/mcp (2)`
   - third: `mcp-local.t3.zone/readonly/mcp (3)`
3. Persist the chosen `displayName` so later removal of an earlier duplicate does not rename existing rows.
4. Derive `id` from `displayName` slug with the existing numeric suffix guard against all source ids.
5. Continue rejecting exact duplicate URL strings with `getByUrl()`. Equivalent readable names with different full URLs are allowed and disambiguated by suffix.

Pack source ids continue to use existing `deriveSourceId()` behavior. Legacy `mcp-registry` rows are not migrated; they remain removable unsupported rows.

UI should show `source.displayName ?? source.id` as the primary source label for gateway sources and keep the raw URL as secondary metadata.

## 2. Browse union API/model with source metadata, filters, and search

### Server API

Keep `GET /api/marketplace/sources/:id/packs` for compatibility, but add an all-source browse route:

```http
GET /api/marketplace/browse?projectId=<optional>
```

Response:

```ts
type MarketplaceBrowseSourceState = {
  sourceId: string;
  sourceName: string;
  sourceType: "builtin" | "pack" | "mcp-gateway" | "mcp-registry";
  builtin?: boolean;
  status: "ok" | "loading" | "error" | "unsupported";
  error?: string;
  lastSyncedAt?: string;
};

type BrowsePackWithSource = BrowsePack & {
  source: {
    id: string;
    name: string;
    type: "builtin" | "pack" | "mcp-gateway";
    builtin?: boolean;
  };
  browseKey: string; // `${source.id}:${dirName}`; stable UI key
};

interface MarketplaceBrowseResponse {
  sources: MarketplaceBrowseSourceState[];
  packs: BrowsePackWithSource[];
}
```

Behavior:

- Include synthetic built-in first-party packs as source `builtin`.
- Include every registered pack/local source by calling existing `installer.browseSourcePacks(source.id)`.
- Include every registered MCP gateway source by calling the same helper; do not change gateway wire parsing.
- Do not fail the entire union if one source fails. Add a `sources[]` entry with `status: "error"` and keep packs from other sources.
- Legacy `mcp-registry` rows return `status: "unsupported"` and no packs.
- Each pack row must include source metadata even if the pack manifest has the same `name` as a row from another source.
- Preserve existing gateway diagnostics as structured row diagnostics. Fix the current client type mismatch so `mcpGatewayDiagnostics` is `{ skippedEntries }`, not `string[]`.

Recommended server helpers:

- `sourceDisplayName(source)` in `server.ts` or source-store helper.
- `browseBuiltinPacks()` near existing built-in source special case.
- `MarketplaceInstaller.browseAllSources(sources, builtinEntries)` or route-local fan-out that reuses `browseSourcePacks()`.

### Client API/types

In `src/app/api.ts`:

- Add `MarketplaceBrowseSourceState`, `BrowsePackSource`, and `BrowsePackWire.source` / `browseKey` types.
- Add `browseMarketplace(): Promise<MarketResult<MarketplaceBrowseResponse>>`.
- Keep `browseMarketplacePacks(id)` for old call sites/tests until the UI is fully migrated.

### Marketplace UI state

In `src/app/marketplace-page.ts`, replace source-selected Browse state with union state:

```ts
let browseSources: MarketplaceBrowseSourceState[] = [];
let browsePacks: BrowsePackWire[] = [];
let enabledBrowseSourceIds = new Set<string>();
let browseSearch = "";
```

Rules:

- Adding a source leaves `activeTab = "sources"` and refreshes sources + union browse data in the background.
- Clicking, syncing, or removing a source never switches tabs.
- Browse tab no longer has `selectedSourceId` as navigation state.
- Installing a row uses `pack.source.id` rather than a selected source.
- If a selected source concept is kept internally during migration, it must not drive tab changes.

### Source chips

At the top of Browse render:

- A chip per source from `browseSources`, including built-in.
- Chips independently include/exclude each source id.
- Default after load: all non-unsupported sources included.
- Chip label uses `source.name`; status adornment shows error/unsupported/count where available.
- Provide an `All` / `None` affordance only if cheap; not required for first implementation.

### Search

Add a text input above cards. Client-side filtering is sufficient because the union payload is already local.

Search should match lowercased text from:

- pack `name`, `description`, `version`
- `source.name`, `source.id`, `source.type`
- manifest contents: roles/tools/skills/entrypoints/mcp/pi extensions
- MCP gateway/provider metadata: `gatewayProviderId`, MCP refs/list names/server/subNamespace, labels, descriptions, operation names/descriptions when available

If the server later adds `searchText` on rows, the client can use it, but do not require a second search endpoint.

### Empty/loading/error states

- Global initial load: `Loading sources…` / `Loading browse catalogue…`.
- If all selected sources are excluded: `No sources selected.`
- If selected sources are ok but no cards match search: `No packages match your filters.`
- If one or more sources errored and others loaded: show a compact per-source warning block above cards, not a global failure.
- If every selected source failed/unsupported: show the per-source failures as the main empty state.

## 3. Installed gateway package operation toggles and persistence

### Data model

Extend pack activation persistence in `src/server/agent/project-config-store.ts`:

```ts
export interface DisabledRefs {
  roles?: string[];
  tools?: string[];
  skills?: string[];
  entrypoints?: string[];
  mcp?: string[]; // whole MCP contribution/listName disabled
  mcpOperations?: Record<string, string[]>; // listName -> disabled op names
  // existing fields...
}
```

Normalization:

- `mcpOperations` is optional.
- Keys are MCP `listName` values declared by the pack.
- Values are operation names as returned by gateway/MCP tools/list after stripping provider prefix into the package operation identity.
- Drop unknown listNames and unknown operation names on PUT, just like current activation normalization drops unknown entity refs.

### Operation metadata source

Disabled operations must remain visible when disabled, so the UI cannot use runtime-exposed tools as its only source.

For MCP gateway materialization:

- Extend `McpGatewayProvider.operations` use in `materializeGatewayProviderPack()`.
- Write operation metadata into the materialized MCP YAML or `.pack-meta.yaml`; recommended in `mcp/<listName>.yaml`:

```yaml
operations:
  - name: confluence_add_comment
    label: Add comment
    description: Add a comment to a Confluence page
    inputSchema: {...} # optional, if the gateway provided it
```

- Extend `McpPackContribution` with `operations?: GatewayOperation[]` and parse/validate that field in `normalizeMcpContribution()`.
- For gateway responses without operation metadata, fall back to runtime `tools/list` for display while connected, and persist disabled operation names even if temporarily unknown so they can be re-applied after reconnect.

### Activation API

Extend `PackActivationMcpEntry` wire shape:

```ts
interface PackActivationMcpOperationEntry {
  name: string;
  label?: string;
  description?: string;
  toolName?: string;       // model/internal policy key, if known
  selected: boolean;       // true when not disabled
  disabledByActivation: boolean;
  policyKey: string;       // e.g. mcp__gr__confluence__confluence_add_comment
  policy?: "allow" | "ask" | "never";
}

interface PackActivationMcpEntry {
  ref: string;
  listName?: string;
  serverName?: string;
  subNamespace?: string;
  selectedOperationCount?: number;
  totalOperationCount?: number;
  operations?: PackActivationMcpOperationEntry[];
  disabledOperations?: string[];
  // existing fields...
}
```

`GET /api/marketplace/pack-activation` should derive `selectedOperationCount` and `totalOperationCount` from the package entry's own operation list and disabled operations, not from server-wide `status.toolCount`.

`PUT /api/marketplace/pack-activation` continues to accept whole-pack disabled arrays and additionally accepts `disabled.mcpOperations`. A whole MCP contribution disabled in `disabled.mcp` does not erase its `mcpOperations`; re-enabling the contribution restores the previous operation subset.

### UI

Installed pack view:

- Keep current MCP contribution toggle for whole listName enable/disable.
- Add an expandable operation list under each MCP contribution with one switch per operation.
- Disabled operations remain visible and unchecked because they are rendered from activation catalogue metadata.
- Counts should read from `selectedOperationCount / totalOperationCount` for the package contribution.
- If operation metadata is unavailable, show `Operation list unavailable until the server connects` and keep already-disabled operation refs in a small `Disabled by name` list so users can re-enable stale refs.

Runtime reload:

- After whole MCP or operation toggles, call the same MCP reload path used by current activation changes.
- Operation-only changes must refresh MCP tool registration/Tools page data even if the underlying MCP client connection does not need reconnecting.

## 4. Tools policy hierarchy

### Policy key levels

Canonical keys:

| Level | Key example | Meaning |
| --- | --- | --- |
| MCP wildcard | `mcp__` | all MCP servers |
| Server prefix | `mcp__gr` | every package/subnamespace/operation exposed under public server `gr` |
| Package/subnamespace prefix | `mcp__gr__confluence` | every operation for the `confluence` package/subnamespace |
| Operation | `mcp__gr__confluence__confluence_add_comment` | one operation |
| Flat server operation | `mcp__playwright__browser_click` | one operation on a non-gateway flat MCP server |

### Server resolution

In `src/server/agent/tool-activation.ts`:

- Replace `McpPolicyKeys { group, tool }` with a richer shape:

```ts
interface McpPolicyKeys {
  wildcard: "mcp__";
  server: string;       // mcp__gr
  package?: string;     // mcp__gr__confluence
  operation?: string;   // mcp__gr__confluence__op or mcp__server__op for flat
}
```

- Keep `mcpPolicyPrefix(toolName)` returning the server key for backward compatibility.
- Add `mcpPolicyKeys()` support for both internal per-op names and meta-tool names.
- `resolveGrantPolicy()` precedence should be:
  1. exact `role.toolPolicies[toolName]`
  2. role operation key
  3. role package/subnamespace key
  4. role server key
  5. role wildcard `mcp__`
  6. non-MCP role group key
  7. tool YAML default
  8. group policy operation key
  9. group policy package/subnamespace key
  10. group policy server key
  11. normal group default
  12. system fallback `allow`

`computeToolPolicies()`, `computeEffectiveAllowedTools()`, and `writeMcpProxyExtensions()` should continue to use `resolveGrantPolicy()` so registration and guard behavior stay aligned.

### Runtime enforcement

`POST /api/internal/mcp-call` already performs Layer B `never` enforcement. After `resolveGrantPolicy()` gains operation-level group-policy precedence, the dispatcher will reject operation-level `never` even if the server/package meta-tool is allowed or already granted.

Also enforce activation-disabled operations in `McpManager.callTool()` or immediately before dispatch:

- If the routed operation is not selected for its installed package owner, return 403/structured error.
- This must be independent from policy: activation disabled means not installed/selected; policy `never` means installed but denied.

### Tools UI

In `src/app/tool-manager-page.ts`:

- Keep server-level selector on MCP server rows (`mcp__gr`).
- Keep package/subnamespace selector on sub rows (`mcp__gr__confluence`).
- Add an operation-level policy selector on operation rows with key `op.name` for the canonical full `mcp__...` operation name.
- The empty option label should show inherited policy and source, e.g. `Ask (inherited from mcp__gr__confluence)`.
- Use the server's policy key parser shape as the documented source of truth; ideally expose policy keys on `GET /api/mcp-servers` operation rows to avoid duplicating parser drift in the client.

## 5. MCP runtime union and conflict precedence across gateway packages

### Problem with current model

Current gateway packages materialize MCP contributions with shared runtime server names like `gr` and a package `subNamespace`. `McpManager.groupMarketplaceContributions()` groups by `serverName`; if two installed gateway sources both provide `serverName: "gr"` but with different gateway URLs/configs, the later config replaces the earlier one. This loses operations from the first gateway even when their package/subnamespace names are distinct.

### New internal model

Separate three identities:

```ts
type PublicMcpServerName = string;   // policy/model prefix, e.g. "gr"
type RuntimeMcpServerKey = string;   // unique client connection, e.g. "gr@gw-abc123"
type McpPackageKey = string;         // package/subnamespace, e.g. "confluence"
```

Extend runtime contribution types in `src/server/mcp/mcp-manager.ts`:

```ts
interface ResolvedMcpContribution {
  listName: string;
  serverName: PublicMcpServerName;       // existing public key
  runtimeServerKey?: RuntimeMcpServerKey; // new; defaults to serverName for manual MCPs
  subNamespace?: string;
  selectedOperations?: Set<string>;      // undefined => all listed operations selected
  config: McpServerConfig;
  origin: ResolvedMcpOrigin;
}

interface ResolvedMcpConnectionGroup {
  runtimeServerKey: RuntimeMcpServerKey;
  serverName: PublicMcpServerName;
  config: McpServerConfig;
  ownerContributions: ResolvedMcpContribution[];
}
```

For manual JSON MCPs:

- `runtimeServerKey === serverName`.
- Tool names, docs paths, statuses, and policies remain compatible.

For MCP gateway packages:

- Generate a stable runtime key from public server + source/install identity, e.g. `gr@<shortHash(sourceUrl or sourceId)>` or `gr@<packId>`.
- Keep public `serverName` as `gr` / `gr-write` so policy keys stay readable (`mcp__gr`, `mcp__gr__confluence`).
- Group connections by `runtimeServerKey`, not public `serverName`.

### Tool exposure and routing

Add an explicit route map inside `McpManager`:

```ts
interface McpToolRoute {
  modelName: string;          // canonical public name: mcp__gr__confluence__op
  runtimeServerKey: string;   // client to call
  mcpToolName: string;        // operation name sent to MCP server
  owner: ResolvedMcpContribution;
}
```

`getToolInfos()` should:

1. Iterate connection groups in precedence order.
2. Build public model names from `serverName`, optional `subNamespace`, and operation name.
3. Drop operations not selected by package activation.
4. Insert into `routeMap` by public `modelName`.
5. If a later contribution produces the same public `modelName`, it replaces the earlier route. The losing operation is hidden from model/tool registration but should be reported in diagnostics/status.
6. Return the union of visible `modelName`s.

`callTool(modelName, args)` should resolve through `routeMap` before falling back to legacy parsing. Legacy fallback is needed for manual MCP compatibility and for tests that manually populate tool maps.

### Precedence order

Use existing pack resolution order as the source of truth:

1. Built-in first-party pack band, lowest.
2. Server market packs.
3. Global-user market packs.
4. Project market packs.
5. Within a scope, `pack_order` determines order; later entries are higher precedence.
6. Manual JSON MCP config overlays Marketplace for the same public model names/server names, preserving current compatibility.

For name clashes:

- Distinct public model names from different packages/sources are all exposed.
- Identical public model names expose only the winner by precedence.
- Status/activation UI should show hidden conflicts as `Overridden` with the winning source/package when possible.

### Installed package names across sources

Current gateway pack name `mcp-${providerId}` prevents installing the same provider id from two gateways in one scope. To support multi-source coexistence:

- Include source identity in materialized gateway pack names, e.g. `mcp-${providerId}-${sourceSlugOrHash}`.
- Keep display title/provider label separate from packName.
- `.pack-meta.yaml` should persist `sourceId`, `sourceDisplayName`, `gatewayProviderId`, and `gatewayFingerprint`.
- Update install/update matching to use `(sourceId, gatewayProviderId)` for gateway virtual rows, not just `packName`, while still supporting normal pack sources by `packName`.

## 6. Compatibility for manual JSON MCPs

Manual MCPs from existing JSON settings must keep working unchanged:

- Do not change `_discoverManualServers()` cascade or JSON formats.
- Manual `mcpServers` produce `ResolvedMcpContribution` with `origin.scope = "manual"`, `runtimeServerKey = serverName`, no `subNamespace`, and all operations selected.
- Manual tool names stay `mcp__<server>__<operation>`.
- Manual meta-tool names stay `mcp_<server>`.
- Existing group policies like `mcp__playwright: never` and operation policies like `mcp__playwright__browser_click: never` remain valid.
- Manual config continues to win over Marketplace when the public model-facing operation names collide.
- `/api/mcp-servers`, `/api/internal/mcp-call`, `mcp_describe`, generated docs, and restart behavior must continue to support manual-only setups with no Marketplace source store.

Backwards compatibility is not required for previous experimental MCP gateway source/install storage. It is acceptable to require re-adding gateway sources or reinstalling gateway packs if the implementation changes their persisted pack names/runtime keys.

## 7. Detailed file/function change plan

### `src/server/agent/marketplace-source-store.ts`

- Add `displayName?: string` and `normalizedName?: string` to `MarketplaceSource`.
- Add `normalizeMcpGatewaySourceName(url)` and tests.
- Update `parseSource()` / `serializeSource()` to persist the new fields.
- Update `add()`:
  - validate gateway URL via URL parser;
  - compute normalized/display names for gateway sources;
  - derive id from displayName slug for gateway sources;
  - preserve pack source behavior.
- Add duplicate display-name allocation helper.

### `src/server/agent/mcp-gateway-source.ts`

- Preserve fixed gateway fetch/parsing behavior.
- Extend `GatewayOperation` with optional `label` if present in response.
- Include provider operations in `gatewayProviderToVirtualPack()` row metadata.
- Include `sourceId/sourceDisplayName` in materialization options.
- Change gateway pack naming to include source identity for coexistence.
- Write operation metadata to materialized MCP YAML or `.pack-meta.yaml`.
- Keep diagnostics tolerant: unsupported entries are skipped, not source-fatal unless no providers remain and the response is malformed.

### `src/server/agent/pack-contributions.ts`

- Extend `McpPackContribution` with `operations?: GatewayOperation[]` or local equivalent.
- Parse/validate optional `operations` in `normalizeMcpContribution()`.
- Keep malformed operation entries as warnings/dropped entries, not contribution-fatal unless the whole contribution is invalid.
- Continue preserving manual/authored schema-2 MCP behavior when no operations are declared.

### `src/server/agent/project-config-store.ts`

- Add `mcpOperations?: Record<string, string[]>` to `DisabledRefs`.
- Update `ACTIVATION_KINDS` handling to normalize nested `mcpOperations` separately.
- Ensure native YAML round-trip preserves nested operation arrays.
- Keep `getPackActivation()` defaulting missing fields to empty selections.

### `src/server/agent/marketplace-install.ts`

- Add source metadata to `BrowsePack` rows or ensure the server route wraps rows consistently.
- Add helper for all-source browse if not route-local.
- Update gateway install/update lookup for source-qualified gateway pack names.
- Preserve normal pack-source update detection by existing `sourceUrl`/`packName` behavior.

### `src/server/server.ts`

- Add `GET /api/marketplace/browse` union route.
- Update source response to include gateway `displayName`.
- Stop Marketplace UI assumptions that source row click means browse navigation; server route can remain neutral.
- Update `buildActivationCatalogue()`:
  - include MCP operation entries;
  - compute selected/total counts from package contribution + disabled operations;
  - include policy keys and current policy where cheap;
  - include conflict/overridden diagnostics from new route map/status.
- Update `PUT /api/marketplace/pack-activation` normalization for `disabled.mcpOperations`.
- Ensure operation changes call MCP reload/refresh logic.
- Update `/api/mcp-servers` payload with policy/model names and owner metadata needed by Tools UI.
- Update `/api/internal/mcp-call` to enforce operation-level policy and activation-selected operation routing through `McpManager`.

### `src/server/mcp/mcp-manager.ts`

- Introduce public server vs runtime key separation.
- Add `runtimeServerKey` to marketplace contributions/groups.
- Group clients by runtime key.
- Maintain a `routeMap` from public model-facing operation names to runtime client/tool owner.
- Update `getToolInfos()`, `callTool()`, `getServerStatuses()`, docs cache paths, and reload fingerprinting to use runtime key where needed and public names where shown to users.
- Preserve manual behavior by defaulting runtime key to public server name.
- Add conflict diagnostics for hidden public operation names.

### `src/server/agent/tool-activation.ts`

- Extend `mcpPolicyKeys()` for operation-level keys.
- Keep `mcpPolicyPrefix()` backward compatible.
- Update `resolveGrantPolicy()` precedence to operation > package > server > wildcard for both role and group-policy store layers.
- Ensure `computeToolPolicies()`, `computeEffectiveAllowedTools()`, and `writeMcpProxyExtensions()` naturally respect selected operations and `never` policies from `McpManager.getToolInfos()`.

### `src/app/api.ts`

- Add all-source browse response types and `browseMarketplace()`.
- Extend `MarketplaceSource` with `displayName` / `normalizedName`.
- Extend `BrowsePackWire` with source metadata, browse key, operation metadata, and structured gateway diagnostics.
- Extend `DisabledRefs` and `PackActivationMcpEntry` for `mcpOperations` and operation entries.
- Extend `McpOperationInfo` with `policyKey`, `serverPolicyKey`, `packagePolicyKey`, `owner` where provided.

### `src/app/marketplace-page.ts`

- Replace selected-source Browse model with all-source union state.
- Add source filter chips and search input at top of Browse.
- Ensure add/sync/remove source does not mutate `activeTab` to Browse.
- Render source provenance on each card.
- Install/update cards using `pack.source.id` and `pack.browseKey`.
- Render per-source errors/warnings.
- Render installed MCP operation toggles under each MCP contribution and persist via `disabled.mcpOperations`.

### `src/app/tool-manager-page.ts`

- Use server-provided MCP policy keys where available.
- Add operation-level policy selector in MCP operation rows.
- Show inherited policy labels from operation -> package -> server -> wildcard/system.
- Refresh group policies and MCP server status after operation policy changes.

### `docs/marketplace.md` and `docs/mcp-meta-tools.md`

- After implementation, update reference docs with normalized source naming, Browse union, operation activation, and MCP policy hierarchy. This design artifact itself is the gate deliverable; reference docs can be part of the implementation/documentation gates.

## 8. Verification plan

### Unit tests

Add/update:

- `tests/marketplace-install.test.ts`
  - gateway source display name normalization strips protocol/query/hash/trailing slash;
  - duplicate readable names receive persisted deterministic suffixes;
  - exact duplicate URLs are rejected;
  - source-qualified gateway pack names allow same provider id from two gateway sources.
- `tests/marketplace-mcp-gateway.test.ts`
  - fixed gateway response parsing remains unchanged;
  - operation metadata is parsed and materialized;
  - virtual browse rows include operations and source-safe pack names.
- `tests/marketplace-mcp-contributions.test.ts`
  - optional `operations` parsing;
  - malformed operation metadata is dropped without hiding the MCP contribution.
- `tests/marketplace-browse-union.test.ts` (new or existing marketplace test)
  - union includes built-in, pack source, and MCP gateway rows;
  - one source failure produces per-source error while other rows remain;
  - every row has source metadata and stable browse key.
- `tests/project-config-store.test.ts` or existing config tests
  - `pack_activation.*.*.mcpOperations` native YAML round-trips and normalizes.
- `tests/mcp-manager-marketplace-discovery.test.ts`
  - two gateway sources with different runtime configs expose union of distinct public operation names;
  - identical public operation name collision resolves by pack order/precedence;
  - manual JSON MCP overrides Marketplace collision;
  - disabled operation is omitted from `getToolInfos()` and rejected by `callTool()`.
- `tests/mcp-meta-policy.test.ts` / `tests/grant-policy.test.ts`
  - group-policy store operation key beats package/server keys;
  - package key beats server key;
  - `mcpPolicyPrefix()` still returns server prefix for old callers.

### API E2E

Add/update:

- Multiple gateway sources can be registered, browsed through `GET /api/marketplace/browse`, and installed from separate source rows.
- Adding/syncing/removing sources does not require or imply Browse source selection server-side.
- Installing packages from two gateways exposes selected operation union through `/api/mcp-servers` and `/api/tools`.
- Operation collision precedence changes when `pack_order` changes.
- `PUT /api/marketplace/pack-activation` with `disabled.mcpOperations` hides only selected operations while preserving whole MCP contribution visibility.
- `/api/internal/mcp-call` rejects disabled operations and operation-level `never` policy.
- Existing manual `.mcp.json` config still loads, exposes tools, restarts, and honors old `mcp__server` policies unchanged.

### Browser E2E

Add/update:

- Marketplace Sources tab:
  - adding an MCP gateway source leaves the user on Sources;
  - source row click/sync/remove does not auto-switch tabs;
  - duplicate gateway display names are visible with suffixes.
- Marketplace Browse tab:
  - source filter chips include built-in, pack, and gateway sources;
  - chips independently include/exclude cards;
  - search filters by pack name, description, source name, MCP provider/operation labels;
  - per-source error state is visible without hiding healthy source cards.
- Installed package view:
  - gateway package operation toggles render;
  - disabling an operation persists across reload and remains visible unchecked;
  - re-enabling restores the operation.
- Tools page:
  - server-level, package/subnamespace-level, and operation-level policy selectors are visible;
  - operation policy persists and shows inherited labels correctly;
  - operation-level `never` blocks runtime call even when server/package policy allows.

### Full checks

Before implementation completion:

```bash
npm run check
npm run test:unit
npm run test:e2e
```

Manual `npm run test:manual` is not required unless implementation touches sandbox/session lifecycle beyond MCP runtime registration.
