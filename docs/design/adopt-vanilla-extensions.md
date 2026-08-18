# EP-9 — Adopt Vanilla Extensions

**Status:** implemented
**Goal:** adopt an unmodified stock MCP transport or Claude-style skill directory without creating a publisher-authored Bobbit pack.

## Decision

Use a **durable adoption ledger plus in-memory synthetic contributions**. The ledger is configuration, not a second extension loader. At resolution time it materializes:

- a synthetic `PackEntry` with `preloaded.skills` for each adopted skill directory, consumed by the existing `PackResolver` and `SkillLoader` path; and
- `ResolvedMcpContribution` records consumed by the existing `MarketplaceMcpResolver → McpManager` path.

The ledger is the source of lifecycle/restart/removal truth. The synthetic entries are recomputed from it on every resolver/reload boundary; they are never written as generated packs.

### Designs compared against identical acceptance criteria

| Criterion | In-memory contribution + persisted ledger | Persisted generated pack/config entry |
|---|---|---|
| No edits to the stock asset | Yes: references canonical source path/transport only. | A generated wrapper must copy, symlink, or rewrite the asset; a symlink leaks path/lifecycle assumptions and a copy drifts. |
| Existing loaders/parsers | Yes: `scanSkillDir`/frontmatter, `PackResolver`, `normalizeMcpContribution`, `McpManager`, meta proxies and policy all remain owners. | Mostly, but a generated `pack.yaml`, `mcp/*.yaml`, metadata and external-skill projection introduce a materializer and reconciliation loader. |
| Idempotence, removal, restart | One normalized ledger key; delete one record; load config then rematerialize on boot. | Must reconcile ledger, generated directory, `.pack-meta.yaml`, `pack_order`, activation refs, stale copies and source availability. |
| Project scope and precedence | The resolver receives scope-tagged synthetic entries at a defined band. | Can reuse market-pack bands, but falsely represents adoption as a marketplace install and needs synthetic source provenance. |
| Safe conformance/status | Status is derived from the manager and shared scanner, stored as sanitized last-known diagnostics. | Also possible, but requires stale generated files to be distinguished from the original asset. |
| Runtime complexity | One small config store/adapter at existing composition seams. | A second install/update/uninstall materialization lifecycle plus an external-directory bridge. |

**Selected design:** the first column. Persisting a generated pack is rejected because it creates more persistent state than the product owns, makes removal non-local, and turns adoption into a second Marketplace installer. Persisted configuration is still mandatory: “in-memory” describes the resolved contribution, not the user’s choice.

## Acceptance contract

1. A user can add a stdio command plus arguments or an `http(s)` MCP endpoint; a user can add an absolute directory containing ordinary Claude-style `SKILL.md` folders. The source remains untouched.
2. An adoption has a deterministic generated namespace. Its external MCP tools appear under `mcp__adopt_<id>__*` / model-facing `mcp_adopt_<id>` and skill commands under `adopt-<id>--<skill>`. This prevents an adopted asset from silently shadowing a first-party, market, project, or manually configured asset.
3. A record is idempotent by normalized scope + kind + canonical source identity. Repeating the same request returns that record, does not start a duplicate client, and does not add another skill entry.
4. Removing the record makes its MCP routes and namespaced skills disappear after normal cache invalidation/reload; it removes no source directory, no manual MCP configuration, and no user policy rows.
5. On restart the ledger is loaded before resolver/manager construction. Unreachable or malformed records remain visible with sanitized conformance, but cannot block unrelated skills, packs, MCP servers, or startup.
6. Discovery never grants mutation. Only a positively reported `annotations.readOnlyHint === true` operation is initially selected; unknown, absent, contradictory, or write/destructive hints are excluded. Existing role/group `allow | ask | never` policy further controls selected operations and is never bypassed.

## Durable schema and scoping

`adopted_extensions` is a native `ProjectConfigStore` field alongside `config_directories`, `pack_order`, and `pack_activation`. It is not stored in a Marketplace source, pack directory, preferences, or an ad-hoc JSON file.

```ts
type AdoptionScope = "server" | "global-user" | "project";
type AdoptionKind = "mcp" | "skills";

type AdoptionMcpSource = {
  transport: "stdio" | "http";
  // stdio
  command?: string;
  args?: string[];
  // http
  url?: string;
};

type AdoptionSkillSource = { directory: string };

type AdoptionOperation = {
  name: string;
  // `read-only-hint`, `unknown`, `mutation-or-contradictory`; no heuristic inference.
  classification: "read-only-hint" | "unknown" | "mutation-or-contradictory";
  selected: boolean;
  // Durable internal provenance. Omitted from the public wire shape.
  selection: "auto" | "explicit";
};

type AdoptionConformance = {
  state: "pending" | "loaded" | "partial" | "rejected" | "unreachable";
  checkedAt?: string;
  mcp?: {
    requestedProtocol?: string;
    negotiatedProtocol?: string;
    serverName?: string;
    serverVersion?: string;
    loadedTools: string[];
    rejectedTools: Array<{ name?: string; reason: string }>;
  };
  skills?: {
    loadedSkills: string[];
    rejectedSkills: Array<{ path: string; reason: string }>;
  };
  failures: Array<{ code: string; message: string }>;
};

type AdoptedExtension = {
  id: string;                         // generated lowercase safe token, immutable
  revision: number;                   // guards against stale async refreshes
  kind: AdoptionKind;
  scope: AdoptionScope;
  projectId?: string;                 // required iff scope === "project"
  namespace: string;                  // `adopt_<id>` / `adopt-<id>` as appropriate
  source: AdoptionMcpSource | AdoptionSkillSource;
  enabled: boolean;                   // default true; supports durable disablement
  operations?: AdoptionOperation[];   // MCP only: durable hard allow-list
  provenance: {
    class: "adopted";
    sourceType: "stdio" | "http" | "claude-skills-directory";
    sourceLocation: string;           // normalized path, command, or credential/query-free URL
    createdAt: string;
    updatedAt: string;
  };
  conformance: AdoptionConformance;   // only sanitized, derived data
};

type AdoptedExtensionsMap = Partial<Record<AdoptionScope, Record<string, AdoptedExtension>>>;
```

The server `ProjectConfigStore` owns `server` and `global-user` map sections, exactly as it owns those sections of `pack_order`/`pack_activation`; a project context’s store owns only its `project` section. `headquarters` is normalized to server scope through `normalizeConfigProjectId()`. The REST layer rejects a project adoption without a registered project and removes any supplied `projectId` from server/global records.

`id` and namespace are generated only from a **secret-free public identity**: scope, project owner when applicable, kind, and the normalized directory, credential/query/fragment-free HTTP URL, or stdio command. The browser never supplies either value. The private exact identity additionally includes stdio arguments, so retrying the exact command-and-argument configuration is idempotent while two configurations with the same public command receive deterministic collision suffixes (`<base>`, `<base>-2`, `<base>-3`). The public digest and suffix therefore reveal neither argument contents nor an argument-derived hash.

Endpoint URLs with credentials, query, or fragment are rejected rather than persisted. Stdio accepts only a non-empty command and string arguments; it accepts no `env`, `headers`, or `cwd`. HTTP accepts no headers. This keeps secret-bearing transport channels out of adoption. Arguments remain private runtime configuration for exact matching and execution, but every response, Market row, status snapshot, and legacy config view omits them; `sourceLocation` is the sanitized presentation value. Do not expose command environment values, headers, token-like URL components, spawned-process errors, or argument text. Existing `McpClient` ambient process-environment behavior is unchanged and is not configured by this feature.

## Composition and data flow

### 1. Store and validation

`ProjectConfigStore` owns native `adopted_extensions` parsing, normalization, and persistence rather than using a second file-backed store. Its scoped get/upsert/remove and compare-and-swap helpers let a delayed refresh update conformance without overwriting a newer selection, disablement, or deletion. Strict normalization drops each malformed persisted record independently and records a sanitized warning, so a bad row cannot make the store fail or hide healthy records.

`src/server/agent/adopted-extensions.ts` owns identity normalization, presentation redaction, namespace generation, scope aggregation, the standard MCP-contribution adapter, and operation reconciliation. `src/server/skills/adopted-skill-entries.ts` owns the small skill-entry adapter. Neither module loads a client, decides policy, or implements a second skill parser.

### 2. Skills: shared scanner → synthetic `PackEntry` → existing resolver

`slash-skills.ts::discoverSlashSkillsResolved()` builds the ordered list and calls `new PackResolver(entries, [new SkillLoader()], filter)`. `SkillMarketContext` supplies an `adoptedEntries(scope)` callback, and `buildSkillPackList()` inserts its entries immediately **below** the existing legacy-implicit skill band and above no existing user/custom/project skill directory. The order is:

```text
builtin static → builtins/market/user bands → adopted server → adopted global-user
→ adopted project → custom config_directories → .claude/commands
→ personal legacy dirs → project legacy dirs
```

Thus an adoption cannot shadow an existing manual/Claude/project skill, while a user can still invoke it under its unique namespace. Within each adoption band, records sort by `id`; this is the same deterministic low-to-high rule `PackResolver` already applies.

`adopted-skill-entries.ts::adoptedSkillEntries()` calls the shared `scanSkillDirResolved(directory, "custom")`; it does not parse Markdown or YAML itself. It maps successful scanner results into `PackEntry.preloaded.skills`, changing the public skill `name` to `adopt-<id>--<original-safe-name>` and retaining the original `filePath`, `allowedTools`, content, and source. `SkillLoader` consumes `preloaded.skills`, then `PackResolver` performs normal precedence/conflict resolution. Shared scanner diagnostics let adoption report `malformed_frontmatter`, `missing_skill_file`, `duplicate_name`, or `unreadable_directory` without duplicating the parser; a malformed candidate does not prevent valid siblings from loading.

The existing slash invocation grammar accepts the generated dash-delimited name. `/api/slash-skills`, `GET /api/slash-skills/details`, session prompts, `resolveSkillExpansions`, frontmatter `allowed-tools`, progressive disclosure, activation, and cache behavior remain on their existing paths. `SlashSkill` has additive `originKind: "adopted"` and `adoptionId` provenance, so UI/reporting can say **Adopted**, never “first-party pack.”

### 3. MCP: normalized record → existing Marketplace resolver seam → manager

MCP is intentionally not a `PackResolver` entity. `server.ts::marketplaceMcpResolver` appends `adoptedMcpContributions()` after ordered pack contributions and before `McpManager`’s manual overlay. The adapter returns standard `ResolvedMcpContribution` values:

```ts
{
  listName: `adopt-${id}`,
  serverName: `adopt_${id}`,
  runtimeServerKey: `adopt_${id}`,
  contributionId: `adopt:${scope}:${id}`,
  selectedOperations: record.operations?.filter(x => x.selected).map(x => x.name),
  config: { command, args } | { url },
  origin: { scope, packId: `adopt:${id}`, path: sourceLocation }
}
```

The adapter uses the existing strict `normalizeMcpContribution()` transport rules by creating an in-memory contribution-shaped object; it does not accept a looser adoption-only transport parser. Existing `McpManager` grouping, `McpClient` initialize/tools-list, route map collision logic, `writeMcpProxyExtensions`, meta-tools, `/api/internal/mcp-call`, generated docs, and `computeEffectiveAllowedTools()` therefore remain the only runtime path.

A manual config with the same public server name still wins by the current `McpManager.discoverConnectionGroups()` overlay. Adopted names are generated, so this is only possible through a deliberately matching manual entry. If two records somehow produce an identical public route, the existing first-kept deterministic route rules and route diagnostic apply; the adoption API additionally rejects duplicate namespace identities before persistence. No adopted contribution is permitted to use an arbitrary `serverName`, `runtimeServerKey`, `subNamespace`, or operation name as a way to escape its namespace.

### 4. Lifecycle

`server.ts::invalidateResolverCaches()` invalidates the resolver paths that compose adoptions. Create persists the ledger record before it scans/reloads; refresh and removal similarly mutate durable state before the affected MCP manager reloads. The existing reload path reconnects/disconnects, rebuilds routes, and refreshes external MCP registrations. If persistence fails, no reload happens. If reload fails or remains pending, the durable record remains visible with sanitized conformance and unrelated contributions remain active. `SessionManager.initMcp()` receives the resolver before its initial connection, so restart reconstructs the selected contribution set. Removal persists first and returns `204`; a reload failure cannot resurrect the record on restart.

A refresh reconciles the durable MCP operation list only from an authoritative, connected `tools/list` result. Disabled records, pending reloads, unavailable endpoints, and failed initialization or tool listing preserve the last durable operations and their selection provenance. This avoids an outage silently deleting a user's exposure choices or replacing known state with an empty list.

For accurate protocol reporting, `McpClient` retains a narrow read-only handshake snapshot from the existing `initialize` response (`protocolVersion`, `serverInfo.name`, `serverInfo.version`) and `McpManager` carries it in status for the owning adopted contribution. Transport negotiation is unchanged. Conformance uses a sanitized failure category (`invalid_command`, `connection_failed`, `initialize_failed`, `tools_list_failed`, `invalid_operation_schema`, `missing_directory`, `malformed_frontmatter`) rather than raw process/network error text.

## Conservative permissions

MCP protocol annotations are evidence, not authority. During initial discovery and explicit refresh:

| Server-declared condition | Initial operation selection | Why |
|---|---|---|
| `annotations.readOnlyHint === true`, and no contradictory/destructive hint | selected | Positive read-only evidence permits initial exposure. |
| Missing/unknown annotations or an unrecognized schema | omitted | Least privilege; name/description keyword inference is forbidden. |
| `readOnlyHint === false`, `destructiveHint === true`, or contradictory hints | omitted | Mutation is never automatically granted. |
| malformed operation schema/name | omitted and reported | Existing `isValidOperationSchema` remains the runtime guard. |

The selected list is a durable hard allow-list passed as `ResolvedMcpContribution.selectedOperations`; it filters operations before policy/meta-tool resolution. Initial read-only selections are tagged `auto`. Newly discovered operations default omitted, including newly reported read-only operations, until a user deliberately selects them. On a later authoritative live tool list, an `auto` selection is revoked when its operation loses positive read-only evidence — including missing, unknown, malformed, contradictory, or mutation hints. Explicit selections remain explicit choices and are still subject to normal policy.

The adopted-MCP detail control labels a non-read-only choice **Enable operation** and requires confirmation. A PATCH can contain the UI's whole operation list, but only an operation whose `selected` value actually changes is marked `explicit`; unchanged values retain their prior provenance. This prevents a routine full-list submission from turning an automatic read-only baseline into a permanent mutation-capable grant. The update reloads the standard manager and never writes an automatic `allow` policy.

Once selected, normal `tool-group-policies` and role `toolPolicies` decide `allow`, `ask`, or `never` using existing `mcp__adopt_<id>__<operation>` keys. `never` still wins where the existing policy cascade says it wins; `ask` remains guarded. Skill `allowed-tools` stays frontmatter metadata as it is today; adoption does not treat it as permission escalation or rewrite it.

## Provenance and conformance wire contract

These endpoints live beside Marketplace routes in `src/server/server.ts`, with matching typed client helpers in `src/app/api.ts`:

- `GET /api/marketplace/adoptions?projectId=` — aggregate visible server/global/project records with sanitized provenance, selected/loaded/rejected assets, and last-known conformance.
- `POST /api/marketplace/adoptions` — `{ kind, scope, projectId?, source }`; returns `200` for an identity match and `201` for a new record. It never returns secret fields.
- `POST /api/marketplace/adoptions/:id/refresh` — re-scans/reloads and returns conformance; available only in the owning scope.
- `PATCH /api/marketplace/adoptions/:id` — limited to `enabled` and an explicit normalized operation selection; no arbitrary transport mutation. Changing a source is remove + adopt so identity/provenance stay honest.
- `DELETE /api/marketplace/adoptions/:id?scope=&projectId=` — removal contract above.

Every list/mutation result has:

```ts
{
  id, kind, scope, namespace, enabled,
  provenance: { class: "adopted", sourceType, sourceLocation, createdAt, updatedAt },
  conformance: {
    state, checkedAt,
    mcp?: { requestedProtocol, negotiatedProtocol?, serverName?, serverVersion?, loadedTools, rejectedTools },
    skills?: { loadedSkills, rejectedSkills },
    failures
  }
}
```

MCP `loadedTools` and `rejectedTools` use controlled server operation names and reasons; the model-facing route remains namespaced as `mcp__adopt_<id>__<operation>`. Skill `loadedSkills` are namespaced command names. First-party and installed pack APIs continue to use their current `.pack-meta.yaml` provenance; UI/API types use explicit `provenance.class: "first-party-pack" | "market-pack" | "adopted"` rather than inferring it from a missing pack name.

Pi is not an adoption input in EP-9. There is no “adopt pi extension” route, copied Pi source, or `RpcBridge` runtime change. Existing Pi discovery diagnostics report `harnessVersion: PI_EXTENSION_PROBE_HARNESS_VERSION` where available, which provides accurate version reporting without asserting that a stock Pi extension is adopted or sandboxed differently.

## Market/settings integration

The existing `#/market` surface keeps its components, scope picker, busy/error states, cards, and cache reconciliation. Its Installed tab contains an **Adopt** section, not a fourth loader or a source type.

- A segmented choice: **MCP command**, **MCP endpoint**, **Skills directory**.
- It reuses the existing scope picker and requires a project target for project scope.
- MCP command fields are command and arguments only; endpoint field accepts an `https://`/`http://` URL with secrets visibly disallowed. The UI never renders, retains, or logs input headers/env values.
- Skills directory uses a local absolute path field and clearly states it is read in place and not copied.
- A result row uses existing Market lozenges for `Loaded`, `Partial`, `Unreachable`, and `Rejected`, shows source type/location, namespace, loaded/rejected summary, and **Refresh** / **Remove** actions. Operation details use the existing activation-toggle styling, but selection is described as a hard exposure boundary and policy remains linked to Tools.
- Existing packs keep their existing “Installed from pack” UI. Adopted tools/skills display an **Adopted** origin chip and a link back to the adoption row; they are never offered as editable local tools/skills.

After a mutation, the Market page reloads Marketplace data and refreshes configuration pages through the existing client paths rather than introducing an adoption-only reconciliation flow.

## Implementation footprint

| File | Role |
|---|---|
| `src/server/agent/project-config-store.ts` | Native `adopted_extensions` schema, normalization, persistence, and compare-and-swap helpers. |
| `src/server/agent/adopted-extensions.ts` | Public/private identity, redaction, namespace, MCP adapter, and operation reconciliation. |
| `src/server/skills/adopted-skill-entries.ts`, `slash-skills.ts` | Shared scanner-backed synthetic skill entries and additive adopted provenance. |
| `src/server/agent/pack-types.ts` | Additive provenance metadata for synthetic adopted entries; no second resolver. |
| `src/server/mcp/mcp-client.ts`, `mcp-manager.ts` | Read-only initialize negotiation snapshot and status propagation; no transport redesign. |
| `src/server/server.ts` | Scoped resolver/store wiring, mutation lifecycle/reload, conformance routes, and redacted output. |
| `src/app/api.ts`, `src/app/marketplace-page.ts`, `src/app/marketplace.css` | Typed adoption calls and the Market adoption/status flow. |
| `src/server/agent/pi-extension-discovery.ts` and existing Pi wire types | Probe harness-version reporting where available. |

Do **not** alter hook scope/trace UI, hook decisions/grants, Hindsight, prompt caching, project command environments, build caching, Marketplace install/source semantics, `McpClient` transport protocol behavior, or Pi runtime activation.

## Verification coverage

EP-9 coverage lives in `tests2/` and is registered in `tests2/tests-map.json`; it is not legacy-only coverage.

### Core/integration fixtures

Fixture assets under `tests2/fixtures/adoptions/` include stock-like stdio and streamable-HTTP MCP servers plus a plain skills directory with valid and malformed `SKILL.md` candidates. Focused coverage verifies:

1. native ledger normalization, identity/idempotence, scope ownership, restart serialization, and secret-free wire/log snapshots;
2. stdio and HTTP adoption using the real existing MCP manager: negotiated protocol, namespaced route/meta-tool, selected read-only operation, omitted unknown/mutation/malformed operations, policy `never`, and manager failure isolation;
3. adopted skill scanner uses real shared parsing/frontmatter/`allowed-tools`, namespaces names, leaves project/custom skills as winners, and records malformed/partial assets without hiding valid siblings;
4. manual MCP same-public-name precedence and deterministic adopted collision diagnostics;
5. project isolation: project A adoption never appears in B/default; server/global behavior matches existing scope order;
6. remove while connected, manager reload/route cleanup/external-tool refresh, cache invalidation, restart reconstruction, and a missing directory/unreachable endpoint remaining non-fatal;
7. pi report includes actual probe harness version without changing pi arguments or runtime discovery.

### Browser journey

`tests2/browser/journeys/adopt-vanilla-extensions.journey.spec.ts` covers the Market flow:

1. adopt a project-scoped skills directory and verify adopted provenance and namespaced commands without replacing a project skill;
2. adopt a stdio MCP server and verify only the initially read-only operation is exposed, with no environment/header data in UI or responses;
3. reload to verify durable rows/conformance;
4. remove records and verify only namespaced contributions disappear; and
5. repeat in a second project to verify isolation.

The browser test owns fixture-server/process cleanup and uses an isolated harness root.

## Scope ledger

### Delivered

- Durable, scope-aware MCP and Claude-skills adoption records; in-memory contribution composition; idempotent create/remove/restart behavior.
- Generated collision-safe namespaces, existing parser/manager/meta/proxy/policy composition, and conservative read-only-only initial MCP selection.
- Sanitized provenance/conformance with loaded/rejected assets, MCP protocol information when negotiated, failure isolation, Market flow, and fixture/browser coverage.
- Accurate existing Pi discovery/harness-version reporting only.

### Supporting improvements

- Shared skill parsing exposes sanitized malformed-frontmatter diagnostics rather than silently treating it as an opaque raw body for adoption reporting.
- `McpClient` retains the existing initialize response’s protocol/server identity as read-only diagnostics.
- Existing pack/adopted origin labels become explicit wire metadata so the UI never mislabels provenance.

### Deferred / out of scope

- Adopting arbitrary Pi extensions, marketplace source changes, pack materialization, signing/trust sandboxing, secret/header editors, command environment management, automatic capability inference from names/descriptions, or automatic approval of later-discovered operations.
- New permission engines, changes to role policy semantics, custom MCP transports, modifying stock skill files, copying/symlinking external assets, and redesigning the Pi runtime.
- Changes outside the stated parallel boundary: hooks, Hindsight, prompt caching, project command environments, or build caching.
