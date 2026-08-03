# EP-9 — Adopt Vanilla Extensions

**Status:** proposed implementation design  
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

Add `adopted_extensions` as a native YAML field in `ProjectConfigStore`, alongside `config_directories`, `pack_order`, and `pack_activation`. Do not store it in a Marketplace source, a pack directory, preferences, or a new ad-hoc JSON file.

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
  kind: AdoptionKind;
  scope: AdoptionScope;
  projectId?: string;                 // required iff scope === "project"
  namespace: string;                  // `adopt_<id>` / `adopt-<id>` as appropriate
  source: AdoptionMcpSource | AdoptionSkillSource;
  enabled: boolean;                   // default true; retained for future disable without deletion
  operations?: AdoptionOperation[];   // MCP only: durable hard allow-list
  provenance: {
    class: "adopted";
    sourceType: "stdio" | "http" | "claude-skills-directory";
    sourceLocation: string;           // canonical path or credential/query-free URL
    createdAt: string;
    updatedAt: string;
  };
  conformance: AdoptionConformance;   // only sanitized, derived data
};

type AdoptedExtensionsMap = Partial<Record<AdoptionScope, Record<string, AdoptedExtension>>>;
```

The server `ProjectConfigStore` owns `server` and `global-user` map sections, exactly as it owns those sections of `pack_order`/`pack_activation`; a project context’s store owns only its `project` section. `headquarters` is normalized to server scope through `normalizeConfigProjectId()`. The REST layer rejects a project adoption without a registered project and removes any supplied `projectId` from server/global records.

`id` is generated from a stable hash of the **non-secret** normalized identity and collision-suffixed (`docs`, `docs-2`); it is not supplied by the browser. Identity uses scope, kind, canonical realpath for skills, and for MCP either normalized command+args or an HTTP URL stripped of query/fragment/credentials. Endpoint URLs with credentials, query, or fragment are rejected rather than persisted. Stdio accepts only a non-empty command and string arguments; it accepts no `env`, `headers`, or `cwd`. HTTP accepts no headers. This prevents the adoption wire/config/status surface from becoming a secret channel. Existing `McpClient` ambient process environment behavior is unchanged and is not exposed in this feature.

The record must preserve the raw runtime endpoint internally only after the above validation; every response, log, Market row, and conformance snapshot uses `sourceLocation` (sanitized URL) and redacts command arguments. Do not serialize command environment values, headers, token-like URL components, or spawned-process errors.

## Composition and data flow

### 1. Store and validation

Add `AdoptedExtensionStore` helpers to `src/server/agent/project-config-store.ts` rather than a second file-backed store:

- native-field parse/normalize/write for `adopted_extensions`;
- `getAdoptedExtensions(scope)`, `upsertAdoptedExtension(scope, record)`, `removeAdoptedExtension(scope, id)`, and a transactional `updateAdoptionConformance`;
- strict normalization that discards malformed persisted records one at a time and records a sanitized store warning. It must never make `ProjectConfigStore.load()` fail.

Add a small pure module `src/server/agent/adopted-extensions.ts` for identity normalization, presentation redaction, namespace generation, per-scope aggregation, and adapters below. It owns no filesystem loading, client connection, policy decision, or custom parser.

### 2. Skills: shared scanner → synthetic `PackEntry` → existing resolver

`slash-skills.ts::discoverSlashSkillsResolved()` already builds the ordered list and calls `new PackResolver(entries, [new SkillLoader()], filter)`. Extend `SkillMarketContext` with an injected `adoptedEntries(scope)` callback. `buildSkillPackList()` adds its returned entries immediately **below** the existing legacy-implicit skill band and above no existing user/custom/project skill directory. The order is:

```text
builtin static → builtins/market/user bands → adopted server → adopted global-user
→ adopted project → custom config_directories → .claude/commands
→ personal legacy dirs → project legacy dirs
```

Thus an adoption cannot shadow an existing manual/Claude/project skill, while a user can still invoke it under its unique namespace. Within each adoption band, records sort by `id`; this is the same deterministic low-to-high rule `PackResolver` already applies.

`adopted-extensions.ts::adoptedSkillEntries()` calls the existing `scanSkillDir(realDirectory, "custom")`; it does not parse Markdown or YAML itself. It maps only successful scanner results into `PackEntry.preloaded.skills`, changing the public skill `name` to `adopt-<id>--<original-safe-name>` and retaining the original `filePath`, `allowedTools`, content and source. The existing `SkillLoader` consumes `preloaded.skills`, then `PackResolver` performs normal precedence/conflict resolution. A malformed frontmatter diagnostic must be made observable by extending the shared `parseFrontmatter`/`scanSkillDir` result with an optional diagnostic—not by duplicating its parser. Adopted mapping drops a malformed/unusable candidate and records `malformed_frontmatter`, `missing_skill_file`, `duplicate_name`, or `unreadable_directory`; it leaves sibling skills loadable.

The existing slash invocation regex permits the generated dash-delimited name, so no command grammar expansion is necessary. The `/api/slash-skills`, `GET /api/slash-skills/details`, session prompt, `resolveSkillExpansions`, frontmatter `allowed-tools`, progressive-disclosure header, activation, and cache behavior remain unchanged. Extend `SlashSkill` provenance additively with `originKind?: "adopted"` and `adoptionId?: string`; retain market fields unchanged. This lets UI/reporting say **Adopted**, never “first-party pack.”

### 3. MCP: normalized record → existing Marketplace resolver seam → manager

Do not add `mcp` to `EntityType`: MCP intentionally is not a `PackResolver` entity today. Instead extend the closure in `server.ts::marketplaceMcpResolver` (or rename it only if doing so is mechanically safe) to append `adoptedMcpContributions(scope)` after ordered pack contributions and before `McpManager`’s existing manual overlay. It returns standard `ResolvedMcpContribution` values:

```ts
{
  listName: `adopt-${id}`,
  serverName: `adopt_${id}`,
  runtimeServerKey: `adopt:${scope}:${id}`,
  contributionId: `adopt:${scope}:${id}`,
  selectedOperations: record.operations?.filter(x => x.selected).map(x => x.name),
  config: { command, args } | { url },
  origin: { scope, packName: undefined, packId: `adopt:${id}`, path: sourceLocation }
}
```

The adapter uses the existing strict `normalizeMcpContribution()` transport rules by creating an in-memory contribution-shaped object; it does not accept a looser adoption-only transport parser. Existing `McpManager` grouping, `McpClient` initialize/tools-list, route map collision logic, `writeMcpProxyExtensions`, meta-tools, `/api/internal/mcp-call`, generated docs, and `computeEffectiveAllowedTools()` therefore remain the only runtime path.

A manual config with the same public server name still wins by the current `McpManager.discoverConnectionGroups()` overlay. Adopted names are generated, so this is only possible through a deliberately matching manual entry. If two records somehow produce an identical public route, the existing first-kept deterministic route rules and route diagnostic apply; the adoption API additionally rejects duplicate namespace identities before persistence. No adopted contribution is permitted to use an arbitrary `serverName`, `runtimeServerKey`, `subNamespace`, or operation name as a way to escape its namespace.

### 4. Lifecycle

`server.ts::invalidateResolverCaches()` also invalidates the adopted skill-entry/conformance cache. Every create/update/remove/refresh follows one transaction boundary:

1. validate and persist the ledger mutation with `pending` conformance;
2. invalidate slash/tool/pi/pack caches through the existing invalidator;
3. call `reloadMcpAfterMarketplaceMutation(scope, projectId)` for MCP records; this reuses manager reconnect/disconnect, route rebuild, and `refreshExternalMcpToolRegistrations()`;
4. derive a sanitized conformance snapshot from manager statuses, route snapshots, and shared skill diagnostics, then persist it best-effort; and
5. return the record plus `mcpReload` (`ok | partial | error | pending`).

If persistence fails, no reload happens. If reload fails or is pending, the durable record remains and reports sanitized `unreachable`/`partial`; unrelated contributions stay active. `SessionManager.initMcp()` already receives the resolver before its initial connection, so restart reconstructs the same selected contribution set. On remove, delete the record first in the same transactional store mutation, invalidate, reload, and return `204`; a failed reload is observable but cannot resurrect the record on next restart.

For accurate protocol reporting, add a narrow `McpClient` read-only handshake snapshot populated from the existing `initialize` response (`protocolVersion`, `serverInfo.name`, `serverInfo.version`) and carried through `McpManager` status only for the owning adopted contribution. Do not alter transport negotiation. Capture a sanitized failure category (`invalid_command`, `connection_failed`, `initialize_failed`, `tools_list_failed`, `invalid_operation_schema`, `missing_directory`, `malformed_frontmatter`) rather than raw process/network error text.

## Conservative permissions

MCP protocol annotations are evidence, not authority. During initial discovery and explicit refresh:

| Server-declared condition | Initial operation selection | Why |
|---|---|---|
| `annotations.readOnlyHint === true`, and no contradictory/destructive hint | selected | Positive read-only evidence permits initial exposure. |
| Missing/unknown annotations or an unrecognized schema | omitted | Least privilege; name/description keyword inference is forbidden. |
| `readOnlyHint === false`, `destructiveHint === true`, or contradictory hints | omitted | Mutation is never automatically granted. |
| malformed operation schema/name | omitted and reported | Existing `isValidOperationSchema` remains the runtime guard. |

The selected list is a durable hard allow-list passed as `ResolvedMcpContribution.selectedOperations`; it filters operations before policy/meta-tool resolution. Newly discovered operations default omitted, including newly reported read-only operations, until a user deliberately selects them. A small adopted-MCP detail control may explicitly select a listed omitted operation, but must label it **Enable operation** and require a confirmation for a mutation/unknown classification. This writes the same adoption record and reloads the manager. It does not write an automatic `allow` policy.

Once selected, normal `tool-group-policies` and role `toolPolicies` decide `allow`, `ask`, or `never` using existing `mcp__adopt_<id>__<operation>` keys. `never` still wins where the existing policy cascade says it wins; `ask` remains guarded. Skill `allowed-tools` stays frontmatter metadata as it is today; adoption does not treat it as permission escalation or rewrite it.

## Provenance and conformance wire contract

Add these endpoints beside Marketplace routes in `src/server/server.ts` and matching typed client helpers in `src/app/api.ts`:

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

MCP `loadedTools` are public generated tool names and `rejectedTools` name only plus a controlled reason. Skill `loadedSkills` are namespaced command names. First-party and installed pack APIs continue to use their current `.pack-meta.yaml` provenance; UI/API types gain an explicit `provenance.class: "first-party-pack" | "market-pack" | "adopted"` rather than inferring from a missing pack name.

Pi is not an adoption input in EP-9. Do not add an “adopt pi extension” route, copy a pi source, or change `RpcBridge` runtime behavior. The bounded reporting improvement is to add `harnessVersion: PI_EXTENSION_PROBE_HARNESS_VERSION` where existing `pi-extension-discovery.ts` returns discovery diagnostics and display it in existing pack Pi conformance rows when available. This satisfies accurate version reporting without asserting that a stock Pi extension is adopted or sandboxed differently.

## Market/settings integration

Keep the existing `#/market` surface and components (`marketplace-page.ts`, Market API helpers, scope picker, busy/error states, cards, and existing cache reconciliation). Add an **Adopt** section to the Installed tab (or compact Settings subsection reached from it), not a fourth loader or a source type.

- A segmented choice: **MCP command**, **MCP endpoint**, **Skills directory**.
- It reuses `renderScopePicker()` and requires a project target for project scope.
- MCP command fields are command and arguments only; endpoint field accepts an `https://`/`http://` URL with secrets visibly disallowed. The UI never renders, retains, or logs input headers/env values.
- Skills directory uses a local absolute path field and clearly states it is read in place and not copied.
- A result row uses existing Market lozenges for `Loaded`, `Partial`, `Unreachable`, and `Rejected`, shows source type/location, namespace, loaded/rejected summary, and **Refresh** / **Remove** actions. Operation details use the existing activation-toggle styling, but selection is described as a hard exposure boundary and policy remains linked to Tools.
- Existing packs keep their existing “Installed from pack” UI. Adopted tools/skills display an **Adopted** origin chip and a link back to the adoption row; they are never offered as editable local tools/skills.

After any mutation, reuse `loadMarketplaceData(false)` plus `refreshConfigPages()` and `reconcileRenderersForActiveSession()`. The latter is harmless for an adoption and avoids creating a special client reconciliation branch.

## Files and bounded changes

| File | Change |
|---|---|
| `src/server/agent/project-config-store.ts` | Native `adopted_extensions` schema, normalization, transactional helpers. |
| `src/server/agent/adopted-extensions.ts` (new) | Pure identity/redaction/namespace helpers; synthetic skill entries; standard MCP contribution adapter; conformance shaping. |
| `src/server/skills/slash-skills.ts` | Expose shared scanner diagnostics and inject adopted entries in the established skill list; additive adopted provenance. |
| `src/server/agent/pack-types.ts` | Only additive provenance metadata needed for synthetic adopted entries; do not add a second resolver. |
| `src/server/mcp/mcp-client.ts`, `mcp-manager.ts` | Read-only initialize negotiation snapshot and status propagation; no transport redesign. |
| `src/server/server.ts` | Wire scoped adoption resolver/store, mutation lifecycle/reload, conformance routes, and redacted output. |
| `src/app/api.ts`, `src/app/marketplace-page.ts`, `src/app/marketplace.css` | Typed adoption calls and small Market adoption/status flow using current components. |
| `src/server/agent/pi-extension-discovery.ts` and existing pi wire types | Add only probe harness-version reporting where available. |

Do **not** alter hook scope/trace UI, hook decisions/grants, Hindsight, prompt caching, project command environments, build caching, Marketplace install/source semantics, `McpClient` transport protocol behavior, or Pi runtime activation.

## Verification plan

New tests belong in `tests2/` and are registered in `tests2/tests-map.json`; do not move this feature into legacy-only coverage.

### Core/integration fixtures

Create fixture assets under `tests2/fixtures/adoptions/`:

- `stdio-server.mjs`: stock-like stdio server, initialize result with protocol/server version, one `readOnlyHint:true` operation, one unknown operation, one explicit mutation, and one malformed tool schema.
- `http-server.ts`: ephemeral streamable-HTTP fixture with equivalent initialize/tools-list response.
- `skills/`: plain directory containing multiple `SKILL.md` folders, frontmatter `allowed-tools`, a malformed-frontmatter file, a duplicate frontmatter name, and a valid sibling.
- `collision-skills/`: names that collide with built-in, project, custom-dir, and a second adoption before namespacing.

Add focused tests for:

1. native ledger normalization, identity/idempotence, scope ownership, restart serialization, and secret-free wire/log snapshots;
2. stdio and HTTP adoption using the real existing MCP manager: negotiated protocol, namespaced route/meta-tool, selected read-only operation, omitted unknown/mutation/malformed operations, policy `never`, and manager failure isolation;
3. adopted skill scanner uses real shared parsing/frontmatter/`allowed-tools`, namespaces names, leaves project/custom skills as winners, and records malformed/partial assets without hiding valid siblings;
4. manual MCP same-public-name precedence and deterministic adopted collision diagnostics;
5. project isolation: project A adoption never appears in B/default; server/global behavior matches existing scope order;
6. remove while connected, manager reload/route cleanup/external-tool refresh, cache invalidation, restart reconstruction, and a missing directory/unreachable endpoint remaining non-fatal;
7. pi report includes actual probe harness version without changing pi arguments or runtime discovery.

### Browser journey

Add `tests2/browser/journeys/adopt-vanilla-extensions.journey.spec.ts`:

1. navigate to `#/market`, choose **Skills directory**, project scope, adopt the fixture; verify the adopted row/provenance and `/adopt-<id>--valid` in Skills while the unnamespaced collision does not replace the project skill;
2. adopt fixture stdio MCP; verify an `mcp_adopt_<id>` tool/meta row, only read-only operation selected, and unknown/mutation visibly omitted/rejected; assert no environment/header value appears in page text or relevant response bodies;
3. reload the page and verify both adoption rows/conformance survive;
4. remove each row, wait for refresh, reload, and verify namespaced skills and MCP routes are gone while unrelated fixture/manual assets remain;
5. repeat in a second project and assert project isolation.

Run `npm run check`, the targeted `v2-core`/integration suites, the new browser journey, and the canonical feature gates. The browser test owns its fixture server/process cleanup and uses an isolated harness root.

## Scope ledger

### Must deliver

- Durable, scope-aware MCP and Claude-skills adoption records; in-memory contribution composition; idempotent create/remove/restart behavior.
- Generated collision-safe namespaces, existing parser/manager/meta/proxy/policy composition, and conservative read-only-only initial MCP selection.
- Sanitized provenance/conformance with loaded/rejected assets, MCP protocol information when negotiated, failure isolation, Market flow, and fixture/browser coverage.
- Accurate existing Pi discovery/harness-version reporting only.

### Bounded improvements

- Shared skill parsing exposes sanitized malformed-frontmatter diagnostics rather than silently treating it as an opaque raw body for adoption reporting.
- `McpClient` retains the existing initialize response’s protocol/server identity as read-only diagnostics.
- Existing pack/adopted origin labels become explicit wire metadata so the UI never mislabels provenance.

### Deferred / out of scope

- Adopting arbitrary Pi extensions, marketplace source changes, pack materialization, signing/trust sandboxing, secret/header editors, command environment management, automatic capability inference from names/descriptions, or automatic approval of later-discovered operations.
- New permission engines, changes to role policy semantics, custom MCP transports, modifying stock skill files, copying/symlinking external assets, and redesigning the Pi runtime.
- Changes outside the stated parallel boundary: hooks, Hindsight, prompt caching, project command environments, or build caching.
