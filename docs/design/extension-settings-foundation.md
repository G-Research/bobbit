# EP-7 — Extension settings foundation

**Status:** implementation design. **Depends on:** schema-2 contribution loading, EP-6 exact capability grants, EP-9 project-owned configuration, and the existing Marketplace activation catalogue. **Scope:** a project-scoped, declarative settings contract for schema-2 providers and hooks. It deliberately does not add an EP-4/EP-10 dispatcher, hook proposal type, or provider-specific settings UI.

## Decision

Add one server-owned `ExtensionSettingsStore` per `ProjectContext`. It persists safe setting values and per-project extension enablement in the existing project configuration, keeps secret bytes in a project-state secret store, and projects only declaration metadata, non-secret effective values, and `secretSet` booleans to Market.

The implementation composes existing owners rather than creating a second pack resolver:

- `loadPackContributions()` remains the declaration parser. Providers use their existing `ProviderContribution.configSchema`; hook `config` maps become editable only when they validate as a settings schema. Existing opaque hook config stays opaque and inert.
- `PackContributionRegistry` remains the sole active/winning contribution resolver. After ordinary `pack_activation` filtering, it removes project-disabled schema-2 providers and hooks, resolves their effective project settings, and evaluates each contribution's `activation.requiresConfig` before exposing it to runtime consumers.
- `ProjectConfigStore` atomically publishes the non-secret native YAML field. `ExtensionSettingsSecretStore` coalesces every secret change in one settings mutation into one owner-only file replacement below the owning `ProjectContext.stateDir`. An opaque commit identity binds the two durable records before either is consumed; values never enter `project.yaml`, an audit, a trace, a WebSocket frame, or a diff.
- `server.ts` owns authenticated REST, validation, cache invalidation, redaction, and broadcasts. `marketplace-page.ts` is a typed client of that projection only.
- EP-6 remains the sole authority owner. A setting never grants a hook capability, and a grant never enables, configures, or resurrects a disabled contribution.

The old `provider-config:<providerId>` PackStore value is a compatibility **read fallback** for a provider with no project settings record. It is never returned by the new API and is not modified by it. The first generic save creates a project-owned override and thereafter wins. Pack routes using the old key must be changed in the Hindsight reconciliation to direct users to the generic settings route; no new generic implementation may write that global key. This preserves old Hindsight installations while preventing a legacy global key from being copied into every project.

## Declaration contract

Schema-2 provider config already preserves both a flat defaults map and raw descriptors:

```ts
// src/server/agent/pack-contributions.ts
interface ProviderContribution {
  config?: Record<string, unknown>;       // resolved defaults for runtime
  configSchema?: Record<string, unknown>; // raw declarative descriptors
  activation?: { requiresConfig: string[] };
}
```

Add the following exported settings types and normalizer in that file (or a small sibling `extension-settings-schema.ts` imported by it). They are deliberately flat; nested paths, arbitrary JSON, file paths, and environment maps are not part of this public contract.

```ts
type ExtensionSettingKind = "string" | "secret" | "enum" | "boolean" | "number";
type ExtensionSettingValue = string | boolean | number;

type ExtensionSettingDefinition = {
  key: string;                         // /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
  type: ExtensionSettingKind;
  label?: string;                      // bounded display metadata
  description?: string;                // bounded display metadata
  optional?: boolean;
  default?: ExtensionSettingValue;     // never valid for secret
  values?: string[];                   // required, unique, non-empty for enum
  min?: number;                        // number only
  max?: number;                        // number only; min <= max
};

type ExtensionSettingsSchema = {
  fields: ExtensionSettingDefinition[];
  requiresConfig: string[];            // declared field keys only
};

type ExtensionSettingsTargetKind = "provider" | "hook";
type ExtensionSettingsTargetRef = {
  packId: string;                      // server-derived winning contribution id
  kind: ExtensionSettingsTargetKind;
  id: string;                          // ProviderContribution.id or HookContribution.id
};
```

A declaration map is accepted only when every field is a valid descriptor. It supports the five types above:

| Type | Stored/wire value | Rules |
|---|---|---|
| `string` | string | UTF-8 well-formed, trimmed only for `requiresConfig`, at most 4 KiB; `null` clears only an optional field. |
| `secret` | never on a GET or persisted public record | Write accepts a string up to 16 KiB; `null` clears; no default is permitted; GET renders `{ secretSet: boolean }` only. |
| `enum` | string | `values` is a non-empty unique list; the default/value must be an exact member. |
| `boolean` | boolean | Default/value must be boolean. |
| `number` | finite number | `min`/`max` are finite and inclusive; default/value obey them. |

`config` in `providers/<id>.yaml` uses the existing descriptors directly. `config` in `hooks/<id>.yaml` is retained as its current opaque static map unless it passes this complete descriptor validation; that avoids changing existing hook semantics. A malformed declared settings map is not partially editable: the target stays visible with `configuration.state: "invalid-schema"`, its raw map is never exposed as values, and it cannot be saved. A provider loader continues to load a valid contribution without a Market form when it has no config schema.

`activation.requiresConfig` may name only a declared non-secret or secret field. The schema normalizer reports a declaration diagnostic for an unknown name rather than guessing. A requirement is satisfied only by a present effective value; strings must remain non-empty after trimming. For a secret, presence is established by the secret store, never by an echoed value.

## Durable model, revision, and evolution

### Public project configuration

`src/server/agent/project-config-store.ts` adds a native YAML field and the matching draft/accessor methods:

```ts
type ExtensionSettingsRecord = {
  enabled?: boolean;                  // absent = inherit ordinary activation
  values: Record<string, ExtensionSettingValue>; // never contains secret keys
};

type ExtensionSettingsMap = Record<string, ExtensionSettingsRecord>;

type ExtensionSettingsState = {
  schema: 1;                          // storage schema, not pack schema
  revision: number;                   // monotonically increasing optimistic revision
  commitId?: string;                  // opaque paired-record identity; absent only for legacy state
  targets: ExtensionSettingsMap;
};

interface ProjectConfigDraft {
  setExtensionSettings(state: ExtensionSettingsState): void;
}

class ProjectConfigStore {
  getExtensionSettings(): ExtensionSettingsState;
  setExtensionSettings(state: ExtensionSettingsState): void;
}
```

The target map key is server-created and unambiguous:

```ts
function extensionSettingsTargetKey(ref: ExtensionSettingsTargetRef): string {
  return `${ref.packId}\u0000${ref.kind}\u0000${ref.id}`;
}
```

Example, deliberately with no `apiKey` byte:

```yaml
extension_settings:
  schema: 1
  revision: 4
  targets:
    "hindsight\u0000provider\u0000memory":
      enabled: true
      values:
        externalUrl: https://hindsight.example.test
        bank: bobbit
        autoRecall: true
        recallBudget: 1200
```

`normalizeExtensionSettings()` validates the root, including the optional bounded opaque commit identity, bounds target count and field counts, rejects non-primitive values, drops malformed target rows independently, returns defensive copies, and never logs either a bad row or a request body. `MIGRATED_KEYS`, `PresentFields`, snapshots, serialization, and `ProjectConfigDraft` must be updated together so `mutate()` retains its one-publication guarantee. A malformed public state is a safe unavailable state for runtime use, not a reason to activate a provider with defaults.

The settings record is intentionally an overlay, not a copy of pack defaults. Effective values are resolved as:

```text
schema defaults → legacy PackStore fallback (only if no target record) →
project non-secret values + project secret values
```

Before either public projection or runtime use, current declared values are reconciled with the
current descriptor. Removed keys are ignored without mutating storage. An incompatible current
non-secret value is omitted, produces `configuration.state: "invalid-values"`, and makes the
target fail closed until repaired. A runtime-only secret value is validated by the same descriptor
and also fails closed when incompatible, but it does not produce public validation state or
diagnostics: a public secret field remains `secretSet`-only.

A target record is authoritative even when its `values` object is empty. This is how a project can intentionally stop inheriting an old global provider configuration.

### Secret bytes

Add `src/server/agent/extension-settings-secret-store.ts`, constructed with each project state directory. Its only on-disk location is:

```text
<project stateDir>/extension-settings-secrets.json
```

It uses the same temp-file, `0o600`, rename-before-memory-publication pattern as `SecretsStore`, but exposes only `has(ref, field)`, `getForRuntime(ref, field)`, and owner-only `updateMany(...)`; there is no `getAll()` public path. Secret record keys are derived from the server-created target key plus field name, not a browser-provided filename. Read failures map to `EXTENSION_SETTINGS_SECRET_READ_FAILED`; persistence failures are redacted before the HTTP boundary, with no filesystem path, raw parser error, field value, or request body.

### Commit binding, legacy data, and repair

The two files are individually atomically replaced, but they are not one cross-file transaction. The
security invariant is that public values, secret presence, and runtime secret reads may be combined
only after the public `commitId` equals the owner-only record's identity. This blocks a mixed state
where a crash or ambiguous rename leaves a newly persisted public candidate alongside an older secret
record.

The public record stores a fresh opaque `commitId` for every successful mutation. The owner-only file
uses a versioned envelope with a schema marker, that same identifier, and its private value map. The
secret owner rewrites that envelope even for a public-only mutation, so a retained private value is
always paired with the new public generation. The secret-store API accepts the identity from the public
settings owner; it does not mint a later identity that could make an uncertain pair appear valid.

A public state with no `commitId` and a flat, unversioned secret record form a compatible complete
legacy pair. The first successful mutation upgrades both sides to the bound format. A versioned
secret envelope with a missing or invalid identity is still versioned, never a legacy flat record.
Likewise, a versioned/legacy combination or unequal identities is a mismatch. The resolver rejects a
mismatch before it returns public overlays, `secretSet` metadata, or private runtime bytes. A mutation
also checks this invariant before its CAS work, including for public-only patches; a stale or ambiguous
secret generation therefore cannot be laundered into a fresh identifier by a follow-up save.

A mismatch is an unavailable project settings state, not a conflict the service resolves by choosing a
side. Recovery must restore a matching pair from the same known-good project state before settings can
be read or changed. No automatic repair copies, derives, or exposes a private value. This is deliberate:
commit binding detects inconsistent durable state, but does not claim to make two files crash-atomic.

A mutation validates the complete request before publishing. It first persists the value-free `extension_settings` candidate, then coalesces all changed secrets into one owner-only file save under the candidate's identity. If the secret save fails, the store synchronously compensates before responding: it persists the exact prior public snapshot, including its original revision and identity. The HTTP route then returns the generic sanitized `503 EXTENSION_SETTINGS_PERSIST_FAILED`, not a partial-success response or retry projection. The caller can retry using the original revision, while prior public and runtime values remain authoritative and the attempted secret is never reported as written. If the compensating public save fails, or a secret replacement has an ambiguous durable outcome, commit binding leaves the settings unavailable until repaired; the service must not claim success or a determinate setting state. Runtime validation of an existing secret remains internal: it can fail the resolver closed but never changes the public `secretSet` representation into a validation diagnostic.

Secret values are prohibited from:

- `ProjectConfigStore` snapshots, YAML serialization, generic `/config` responses, `.pack-meta.yaml`, source metadata, and git diffs;
- `ExtensionGrantAuditStore`, Context Trace, diagnostics, exception text, WebSocket broadcasts, console logs, client error state, and test failure snapshots;
- request/response logging and the Market DOM. The DOM only contains `data-testid` based on the safe target/field identity and the text **Set** / **Not set**.

## Enablement, grants, and dormant projections

The settings state supports `enabled` on a provider or hook target. A pack-level Market switch is a convenience that writes the same `enabled` value to every declared schema-2 provider/hook target in that pack in one `ProjectConfigStore.mutate()`; it is not a second pack activation store. `enabled: false` is a project kill switch. `enabled: true` opts back into the project setting but **cannot** override an install-scope `pack_activation` disable, a missing/shadowed pack, or an EP-6 denial.

Wire a new optional `ProjectExtensionSettingsLookup` into `PackContributionRegistry`. After its existing `DisabledRefs` filtering, it:

1. drops every project-disabled provider/hook;
2. reads the effective project overlay, including runtime-only secrets, for each declared provider or hook (or uses declared non-secret defaults when no project target exists);
3. validates current values, applies the shared `activationSatisfied()` presence rule to each contribution's `requiresConfig`; and
4. fails closed if public or secret settings cannot be read or reconciled.

The registry is the activation boundary for both contribution kinds. A dormant provider is omitted
before bridge/network work; a dormant hook is omitted before request-mutation, dynamic-selector,
scheduled-advisor, grant-resolution, or lifecycle dispatch consumers enumerate it. Settings do not
confer EP-6 authority: grant evaluation remains separate after the registry's enablement and
configuration filtering. Hindsight’s `memory` provider, for example, remains omitted until its
project-specific `externalUrl` is non-blank.

`server.ts` builds a settings catalogue from the same winning pack entries plus `loadPackContributions()` **before runtime filtering**, so disabled and dormant declarations remain visible and can be repaired. It must not use only `PackContributionRegistry.listProviders()`, which intentionally omits the very provider the UI needs to re-enable/configure.

Each returned target exposes independent state:

```ts
type ExtensionSettingsFieldWire = Omit<ExtensionSettingDefinition, "default"> & {
  value?: ExtensionSettingValue;       // never for secret
  secretSet?: boolean;                 // only for secret
  source: "default" | "legacy" | "project";
};

type ExtensionSettingsTargetWire = {
  ref: ExtensionSettingsTargetRef;
  packName: string;
  listName: string;
  enabled: {
    effective: boolean;
    projectOverride?: boolean;
    blockedBy?: "pack-activation" | "missing-or-shadowed";
  };
  configuration: {
    state: "ready" | "requires-config" | "disabled" | "invalid-schema" | "invalid-values" | "unavailable";
    missing: string[];                 // safe field names only
  };
  fields: ExtensionSettingsFieldWire[];
  // Existing EP-6 requestedCapabilities, grants, runnable, and status are preserved.
  // runtimeAuthorized is additive and describes the applicable hook capability.
  hookGrant?: HookGrantStatusWire & { runtimeAuthorized?: boolean };
};

type ExtensionSettingsResponse = {
  schema: 2;                           // public API revision
  revision: number;
  targets: ExtensionSettingsTargetWire[];
};
```

This makes the otherwise confusing states explicit:

| Effective result | `enabled` | `configuration` | Grant projection |
|---|---|---|---|
| Hindsight freshly installed | true | `requires-config: [externalUrl]` | n/a; provider is dormant |
| URL set in project A | true | `ready` | n/a; A provider is active |
| Project A memory switch off | false | `disabled` | n/a; provider is omitted |
| Project B has its own URL | true | `ready` | n/a; B remains active |
| Active decide hook, no grant | true | `ready` or `requires-config` | `grant-required`; never runnable |
| EP-4 request-mutation hook with exact `mutate`, no `decide` | true | `ready` | `runtimeAuthorized: true`; exact `mutate` is sufficient |
| Hook has exact durable grant but is disabled, dormant, unavailable, or awaiting review | varies | non-`ready` or disabled | grant remains visible as **Granted · inactive**; no runtime declaration |

A settings mutation calls the existing `invalidateResolverCaches()` and then broadcasts a new metadata-only `extension_settings_updated` frame:

```ts
{ type: "extension_settings_updated", projectId: string, revision: number, ts: number }
```

No target, field, value, secret status, grant, actor, diagnostic, or request body appears in that frame. `src/server/ws/protocol.ts` and the client protocol union add it additively; Market re-fetches its redacted REST projection. Existing `extension_grants_updated` remains unchanged.

## REST contract and authorization

All endpoints are authenticated by the normal gateway API guard. Mutations additionally require the verified signed `bobbit_session` prompt-operator principal via `requireVerifiedPromptOperator()`: bearer/sandbox/session credentials receive `403 PROMPT_EXTENSION_OPERATOR_REQUIRED`. This prevents an agent, a pack route, or an ambient bearer from depositing a project secret or enabling an extension. The authenticated principal is not accepted in a body and settings writes have no audit payload.

```
GET /api/projects/:projectId/extension-settings
```

Returns `404 PROJECT_NOT_FOUND` for an unknown project and `200 ExtensionSettingsResponse`. It returns only current winning schema-2 declarations plus redacted project state. Missing, malformed, disabled, dormant, and ungranted targets remain visible. No secret values are returned, including on a settings read made by a prompt operator.

```
PATCH /api/projects/:projectId/extension-settings/:packId/:kind/:id
Content-Type: application/json

{
  "expectedRevision": 4,
  "enabled": true,
  "values": {
    "externalUrl": "https://hindsight.example.test",
    "apiKey": "write-only-token",
    "autoRecall": false,
    "recallBudget": 900
  }
}
```

`kind` is `provider` or `hook`; all path segments are decoded once and validated against server-derived safe identifiers. `enabled` is optional. `values` is a partial map of declared fields; `null` clears an optional or secret field. Empty requests, unknown keys, invalid types/ranges/enums, clear of required fields, stale `expectedRevision`, inactive/missing target, and invalid declaration receive controlled `400`, `422`, `409 EXTENSION_SETTINGS_REVISION_CONFLICT`, or `404` responses. The server validates against the winning declaration before touching either store; it never lets a body establish pack or contribution identity.

Success is `200` with `{ revision, target }`, where `target` is exactly the redacted `ExtensionSettingsTargetWire`. The response is also redacted for a secret-only write. A public-config persistence failure follows `PROJECT_CONFIG_PERSIST_FAILED`; a secret second-phase failure is compensated before the generic `503 EXTENSION_SETTINGS_PERSIST_FAILED` described above. A failed compensation instead returns `503 EXTENSION_SETTINGS_UNAVAILABLE`.

```
PATCH /api/projects/:projectId/extension-settings/:packId

{ "expectedRevision": 4, "enabled": false }
```

This pack switch expands server-side to all schema-2 provider/hook targets declared by that winning pack, increments once, and returns `{ revision, targets }`. It does not mutate `pack_activation`, grant records, roles, tools, MCP, Pi extensions, or another project.

The generic `GET/PUT /api/projects/:id/config` and `GET /api/project-config` routes must continue to omit `extension_settings`, exactly as they already reserve `extension_grants` and prompt-extension fields. This prevents broad settings forms from accidentally serializing safe metadata alongside a write-only secret operation.

## Market integration

`src/app/api.ts` gains the wire interfaces above and `getExtensionSettings()`, `patchExtensionSettingsTarget()`, and `patchExtensionSettingsPack()` helpers. Its existing `DisabledRefs` and `PackActivationCatalogue` types gain `providers` and `hooks` so the current ordinary activation state remains visible alongside the project override; do not infer it from `/api/ext/contributions`.

`src/app/marketplace-page.ts` loads settings after installed packs and activation catalogues. On every installed/built-in pack card it renders a **Project settings** disclosure for that project’s declared provider/hook targets:

- a pack switch, then target switches, with inherited/blocked state stated in text rather than color alone;
- native string/number inputs, enum select, and checkbox controls with `<label>` bindings, descriptions, field errors, and a Save action carrying the current revision;
- a password input for secrets that starts empty, never receives a value from the API, offers an explicit Clear action, and labels state as **Set** / **Not set**;
- visible **Requires configuration** / **Dormant** status for missing `requiresConfig` keys and existing EP-6 exact-capability grant rows. `runtimeAuthorized` determines target-level grant-required state, so an applicable EP-4 `mutate` grant does not require a second `decide` grant; every exact grant remains independently visible as **Granted · inactive** while its target is disabled, dormant, unavailable, or awaiting review, without offering a grant write from a settings field.

Extend `src/app/marketplace.css` only for these controls. Use the existing Market busy/error/reload path: after a successful mutation, replace the returned redacted projection, call `refreshConfigPages()`, and run `reconcileRenderersForActiveSession()`; on `extension_settings_updated`, re-fetch only if the viewed project matches. Do not retain typed secret text after success, failure, navigation, or reload.

## Implementation partition

| Slice | Files | Responsibility |
|---|---|---|
| A — schema and public state | `src/server/agent/extension-settings-schema.ts` (new), `src/server/agent/project-config-store.ts` | Strict declaration normalization, native `extension_settings` model, revisioned defensive snapshots and atomic public publication. |
| B — secrets and effective resolver | `src/server/agent/extension-settings-secret-store.ts` (new), `src/server/agent/extension-settings-store.ts` (new), `src/server/extension-host/pack-contribution-registry.ts`, `src/server/server.ts` wiring | Owner-only secrets, compatibility fallback, effective values, project enablement filter, provider dormancy and fail-closed reads. |
| C — authenticated public API | `src/server/server.ts`, `src/server/ws/protocol.ts`, `src/app/api.ts` | Catalogue/projection, exact PATCH validation/CAS, principal requirement, invalidation and metadata-only broadcast. |
| D — Market | `src/app/marketplace-page.ts`, `src/app/marketplace.css` | Accessible declared-field form, statuses, secret lifecycle, reload/event reconciliation. |
| E — Hindsight reconciliation | `market-packs/hindsight/providers/memory.yaml`, `market-packs/hindsight/src/shared.ts`, `market-packs/hindsight/src/routes.ts`, `docs/hindsight-memory.md` | Consume the generic effective project configuration; retain old route data only as read fallback, remove the old mutable config surface after compatibility coverage. |

## Focused verification plan

New tests belong in `tests2/` and are registered in `tests2/tests-map.json`.

| Layer | File | Assertions |
|---|---|---|
| Core | `tests2/core/extension-settings-schema.test.ts` | All five field kinds, descriptor/default/range/enum validation, required/optional clearing, invalid hook opaque config, no secret defaults, requires-config field validation. |
| Core | `tests2/core/extension-settings-store.test.ts` | YAML round-trip and defensive copies, revision CAS, unknown future public keys preserved, malformed-row isolation, public publication failure, one owner-only coalesced secret save, secret-save compensation restoring the exact prior public state/revision and runtime values, legacy-pair upgrade, mismatch rejection before redacted or runtime reads, no stale-generation laundering after an ambiguous replacement, unavailable result when compensation fails, and no secret in YAML/error/log snapshots. |
| Core | `tests2/core/pack-contributions.test.ts` (extend) | Project disabled provider/hook filtering, project config overlay before `requiresConfig`, unreadable settings fail closed, install-scope activation still wins. |
| Integration | `tests2/integration/extension-settings-api.test.ts` | Authenticated read versus operator-only mutation, exact target identity, schema/type/enum/range/CAS failures, value redaction in GET/PATCH/WebSocket/console capture, invalidation of a previously built registry, and ordinary EP-6 grants remain unchanged. |
| Integration | same | Two project contexts: configure Hindsight URL in both, disable `hindsight/memory` only in A, assert A has no active provider while B does; reload contexts and assert isolation persists. Test legacy PackStore fallback is read-only and first project write shadows it. |
| Browser | `tests2/browser/e2e/extension-settings.spec.ts` | Market form labels and keyboard traversal, set Hindsight URL/key, assert the returned/UI DOM never contain the key, reload and see only **Set**, disable A while B remains active, reload again, clear secret, and clean up both project state directories/fixture packs. Use an accessibility scan or explicit names/roles for switch, input, select, status, save, and clear controls. |

Focused commands after implementation:

```bash
npx vitest run tests2/core/extension-settings-schema.test.ts tests2/core/extension-settings-store.test.ts tests2/integration/extension-settings-api.test.ts --config vitest.config.ts --retry=0
BOBBIT_V2_RETRY_FREE=1 npm run test:browser -- tests2/browser/e2e/extension-settings.spec.ts --retries=0
```

## Non-goals

- No new hook executor, EP-4/EP-10 option, proposal type, generic host capability, or automatic grant.
- No nested/object/array/editor field type, arbitrary environment/header editor, secret export, secret history, audit payload, or settings diff viewer.
- No mutation of global `pack_activation` from a per-project settings switch, and no ability for a project setting to bypass a higher-scope disable.
- No automatic copy of old global Hindsight credentials into another project, and no cross-project secret fallback after a project creates its own target record.
