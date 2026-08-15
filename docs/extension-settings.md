# Project extension settings

Project extension settings give schema-2 pack contributions a typed, project-local configuration
surface. They let a pack author declare the values a provider, hook, or declarative runtime needs without giving a
pack its own settings API or exposing credentials through ordinary project configuration.

The boundary is deliberately narrow: declarations are flat, values are primitives or one
bounded allowlisted string-set kind (`multi-enum`), and secrets are write-only. This keeps
configuration reviewable in Market while ensuring an extension in one project cannot inherit
another project's configuration. It is separate from install-scope pack activation and from
[extension capability grants](extension-capability-grants.md): settings can make an installed
contribution eligible to run, but never install a pack or confer authority.

## For pack authors

A provider, hook, or runtime in a schema-2 pack opts into typed settings by declaring descriptor-shaped
entries under its contribution `config` mapping. The contribution loader remains the declaration
owner; the gateway resolves the target identity from the installed winning pack and contribution,
never from a browser-supplied record key.

```yaml
# providers/example.yaml
id: example
kind: generic
module: ../lib/provider.mjs
hooks: [beforePrompt]
config:
  endpoint:
    type: string
    label: Service URL
    description: Base URL for the service.
  apiKey:
    type: secret
    label: API key
    optional: true
  mode:
    type: enum
    values: [safe, fast]
    default: safe
  languages:
    type: multi-enum
    label: Languages
    description: Languages this provider should use.
    values: [typescript, javascript, python, rust]
    optional: true
    default: [typescript, python]
  enabled:
    type: boolean
    default: true
  timeoutMs:
    type: number
    min: 100
    max: 10000
    default: 1500
activation:
  requiresConfig: [endpoint]
```

### Descriptor contract

The settings schema is a flat map of field keys to descriptors. A key starts with a letter and
may then contain letters, digits, `_`, or `-`. It is bounded in size so a pack cannot create an
unbounded settings form.

| Property | Applies to | Meaning |
|---|---|---|
| `type` | all | Required: `string`, `secret`, `enum`, `multi-enum`, `boolean`, or `number`. |
| `label`, `description` | all | Optional bounded text for Market's labelled, accessible control. |
| `optional` | all | Optional boolean. Omitted means the field is required when no usable declared default remains. |
| `default` | string, enum, multi-enum, boolean, number | Optional value satisfying the field's type and bounds. A `multi-enum` default is a valid selected set; a secret cannot have a default. |
| `values` | enum, multi-enum | Required, non-empty, declaration-order-preserving unique string allowlist. |
| `min`, `max` | number | Optional finite inclusive bounds; `min` cannot exceed `max`. |

`string` and `secret` accept bounded, well-formed UTF-8 text. `enum` accepts only a listed value;
`multi-enum` accepts a selected set of listed values; `boolean` accepts only a boolean; and
`number` accepts only a finite number inside any declared bounds. Nested values, objects, and
unknown descriptor properties are not supported. Arrays are reserved for `multi-enum`; they do
not make arbitrary array or JSON settings available.

Existing contributions can still use `config` as an opaque static mapping. A mapping opts into
this strict contract only when it contains a descriptor; once it does, every entry must be a
valid descriptor. This preserves existing static configuration while preventing a partly
interpreted settings schema. Legal field names that happen to match inherited JavaScript property
names, such as `constructor` or `prototype`, are handled as own fields rather than by prototype
lookup.

### Multi-enum selected-set rules

`values` is required for `multi-enum` (as it is for `enum`) and may contain 1–128 unique,
non-empty, well-formed strings, with each member no larger than 256 UTF-8 bytes. Its order is
publisher-owned and is the order Market presents to operators.

A `multi-enum` default, project value, API value, and runtime value must be an actual string array
of unique members from that allowlist. The server returns and persists a fresh canonical copy of
every accepted set, sorted with JavaScript's default UTF-16 code-unit ordering. It never locale
sorts, mutates, or retains a caller's array. A selected set has at most 64 members and at most
16 KiB summed UTF-8 member bytes. A required field cannot use an empty set; an optional field may
explicitly use `[]`. These rules reject scalars, objects, nested arrays, duplicates, unknown
members, malformed UTF-16, and count or byte overflows. `string`, `secret`, `enum`, `boolean`,
and `number` retain their existing primitive contracts; `multi-enum` is public-only and never
changes write-only secret storage or redaction.

A target still has the existing 64-field limit. Across all its multi-enum fields, it may contain at
most 256 selected members and 64 KiB of summed UTF-8 member bytes. The aggregate limits prevent a
collection of individually valid selections from creating an unbounded project record.

### Configuration gates and invalid declarations

`activation.requiresConfig` is an optional array of unique, declared field keys. Each required
value must be present in the effective configuration, and required strings must be non-blank after
trimming. An empty multi-enum set is also not present for this gate. Typed contributions use their
declaration defaults and project settings (including runtime-only secrets); an opaque static
`config` mapping remains its compatible static runtime configuration.

Until a provider satisfies the gate, it is omitted from runtime resolution, so no provider bridge,
hook invocation, or provider network work is started. The same gate applies to hooks and declarative
runtimes at the central contribution registry boundary. A dormant hook is omitted before EP-4
request-mutation or EP-10 dynamic selector dispatch can see it; a dormant runtime is omitted before
any future service lifecycle consumer can see it. Configuration alone never grants a hook capability;
the hook must still satisfy its exact activation and grant rules. Runtimes remain dormant until a core
consumer wires the lifecycle manager; see [Managed service-extension contract](service-extension-runtime.md).

Malformed descriptor schemas, an unknown activation property, or a `requiresConfig` key that is
not declared are surfaced as `invalid-schema` in the settings catalogue and fail closed at
runtime. The disabled/invalid item stays visible in Market so an operator can diagnose it, but
it cannot be enabled through the settings API. Avoid placing sensitive text in a declaration or
its diagnostic: pack declarations are publisher-controlled metadata, not secret storage.

## Project persistence and effective values

The public project YAML holds an `extension_settings` record with storage `schema: 2`, a monotonic
`revision`, and server-created target rows. A target row contains only an optional `enabled`
override and non-secret `values`, including canonical multi-enum arrays. Its internal key is
derived from the pack id, `provider`, `hook`, or `runtime` kind, and contribution id; clients never
create or choose that storage key.

Secret bytes are kept separately in the project's state directory. The secret owner coalesces every
secret-field change in one settings mutation into one owner-only, atomic file replacement. It exposes
only a per-target presence check and a runtime-only single-field read; it has no bulk or public getter.
Thus a project YAML file, project-config endpoint, settings projection, WebSocket invalidation, log,
trace, audit record, diff, or Market-rendered state/attributes do not contain a secret value. A password
input temporarily holds the value only while an operator enters it for a save, then is cleared. Public
responses represent a secret only as `secretSet: true` or `false`.

### Commit binding and recovery

The public record and the owner-only secret record are separate files, so they cannot be made one
filesystem transaction. The security invariant is therefore that the runtime may combine public settings
with secret presence or secret bytes **only when both durable records identify the same settings commit**.
This prevents a crash or an ambiguous file replacement from pairing a newer public override with an
older secret record.

Every successful settings mutation creates a fresh opaque `commitId` in the public
`extension_settings` record. The owner-only secret file is written as a versioned envelope containing
its own schema marker, the same opaque identifier, and its private values. The envelope is refreshed
for every mutation, including a public-only one, so retained secret values remain bound to the current
public generation. The identifier is correlation metadata, not a credential, and the public API does
not expose the secret envelope or its contents.

Older projects may have a public record without `commitId` and a legacy flat secret file. That complete
legacy pair remains readable for compatibility. The first successful settings mutation upgrades both
records to the bound format. A versioned record paired with a legacy record, an invalid versioned
envelope, or unequal identifiers is not treated as legacy or repaired by guessing. Settings resolution,
including redacted `secretSet` state, fails closed and new settings mutations are blocked so a later
save cannot relabel stale secret data as current.

If storage recovery leaves the pair mismatched, repair the project state to a matching pair from the
same known-good state before retrying. The service does not claim cross-file crash atomicity, infer which
side is authoritative, or expose a secret to make that repair. At request time it still compensates a
known secret-save failure by restoring the previous public snapshot when possible; that compensation
reduces ordinary write failures but does not replace the durable pairing check.

The effective non-secret value order is:

1. the declaration default;
2. a legacy provider PackStore override, only while this project has no target row for that
   provider; then
3. the project's target values.

Legacy PackStore fallback remains scalar-only. It cannot supply a multi-enum array, which avoids
turning an opaque legacy value into a reviewed selection.

A project row, including an empty row created by clearing a value, ends legacy fallback. This is
important for migration: clearing a project override must not silently revive an old global
setting. Runtime resolution additionally merges a secret only through the secret owner's
runtime-only read.

The public storage schema is intentionally distinct from the pack declaration schema and stores
valid public values rather than serializing a declaration into project YAML. That lets packs add
fields and defaults without a declaration-storage migration and prevents an old client from
rewriting secret material. Consumers should always validate mutations against the current
server-resolved declaration; unknown or no-longer-declared public values are not an API contract.

### Multi-enum storage compatibility

Schema 2 writes multi-enum selections as native YAML sequences, never JSON encoded strings:

```yaml
extension_settings:
  schema: 2
  revision: 7
  targets:
    "language-pack\u0000provider\u0000analyzer":
      values:
        languages: [python, typescript]
```

Schema 1 remains primitive-only. An array in a schema-1 target invalidates that target row; it is
not coerced to a selected set or upgraded just because a newer server can read schema 2. A valid
schema-1 record remains schema 1 until a successful settings mutation. That mutation publishes
schema 2, preserving the row data and normal revision behavior. This explicit boundary makes
hand-edited legacy data fail safely rather than acquiring unintended meaning.

Malformed schema-2 arrays similarly isolate the affected target row under the existing durable
settings recovery behavior, while an invalid root remains unavailable. Snapshots, mutation
candidates, persistence/reload state, effective/runtime values, and public results use independent
array copies. If a secret write requires compensation, rollback restores the exact prior public
snapshot, including its storage schema, revision, selected arrays, and `commitId`.

### Schema evolution and review

A declaration can evolve without rewriting project storage. Removed fields are ignored. A current
stored or legacy **non-secret** value that no longer matches its current type, enum, or bounds is
not projected or used at runtime; the public configuration state is `invalid-values` and Market
shows **Settings need review**. The target and its controls remain visible so the operator can
repair it, but the incompatible value is omitted. New optional fields and valid new defaults need
no migration.

Runtime-only secret reads are validated against the current descriptor too. An incompatible secret
fails the runtime lookup closed, but does not add a public `invalid-values` state or validation
detail: the redacted projection continues to expose that field only as `secretSet`. This preserves
write-only diagnostics as well as write-only values.

### Enablement, activation, and grants

Project settings add a local runtime switch after the normal winning-pack and install activation
selection:

- A project pack switch disables every declared provider, hook, and runtime in that pack for that project.
  Enabling it enables those declared targets together.
- A provider, hook, or runtime switch disables only that target. Settings and grants are retained while it
  is off, so it can be repaired and re-enabled.
- Install-scope `pack_activation` filtering happens first. Project settings cannot revive an
  uninstalled, shadowed, or install-disabled contribution.
- A provider, hook, or runtime still needs a satisfied `requiresConfig` gate. A project settings read or
  secret read failure is not treated as absent values or defaults; the resolver fails closed.
- Extension grants remain exact, project-owned EP-6 records. A settings switch neither creates
  nor bypasses one. This includes the active pack principal's six platform-owned non-hook values:
  `service.manage`, `memory.read`, `memory.write`, `memory.reflect`, `memory.invalidate`, and
  `memory.read.all`. Exact grants persist while their target is disabled, dormant, awaiting review,
  or unavailable; Market labels each such granted capability **Granted · inactive** until the
  target is eligible again.

Every successful settings mutation invalidates resolver and related runtime caches before
notifying the project. Newly spawned or resolved work therefore uses the new project state rather
than a stale contribution list.

## HTTP API

All routes are project-scoped. A normal authenticated gateway request may read the redacted
catalogue. Every mutation additionally requires a verified signed `bobbit_session`
prompt-operator cookie; bearer-only, sandbox, and agent-session credentials receive
`403 PROMPT_EXTENSION_OPERATOR_REQUIRED`.

| Method | Path | Contract |
|---|---|---|
| `GET` | `/api/projects/:projectId/extension-settings` | Returns the redacted catalogue: `{ schema: 2, revision, targets }`. A target includes its server-resolved reference, effective enablement, configuration status, declared fields and non-secret effective values/default source, plus hook grant status where applicable and the active Pack row's non-hook grant status. |
| `PATCH` | `/api/projects/:projectId/extension-settings/:packId/:kind/:id` | Changes one server-resolved `provider`, `hook`, or `runtime` target. Body is `{ expectedRevision, enabled?, values? }`. `values` maps declared keys to a valid primitive, a valid multi-enum string array, or `null` to clear. Returns `{ revision, target }`, with the target redacted. |
| `PATCH` | `/api/projects/:projectId/extension-settings/:packId` | Changes a pack's project runtime switch. Body is exactly `{ expectedRevision, enabled }`. Returns `{ revision, targets }` for the affected declared targets. |

A `GET` response uses the following field distinction:

```json
{
  "key": "apiKey",
  "type": "secret",
  "secretSet": true,
  "source": "default"
}
```

The secret value and a secret default are never present. A secret field remains `secretSet`-only
even if its runtime-only read is incompatible with a newer descriptor; the response exposes no
secret validation detail. For a non-secret field, `value` is the effective public value, `default`
is declared only when present, and `source` is `default`, `legacy`, or `project`. A hook grant
retains its requested exact capabilities and grants. Its additive `runtimeAuthorized` boolean
reports whether the hook's applicable capability is authorized: ordinary decision paths use exact
`decide`, while applicable EP-4 request mutation uses exact `mutate` and does not need a second
`decide` grant. Enablement and configuration remain separate eligibility gates.

Mutations are compare-and-swap operations. The caller must send the revision it read; a stale
revision returns `409 EXTENSION_SETTINGS_REVISION_CONFLICT` and must be reloaded and reviewed,
not overwritten. A successful public update increments the revision once and advances the paired opaque
commit identity described above. Public YAML is persisted before the one coalesced secret-file save,
because the two files cannot be one filesystem transaction. If that secret save fails, the server first
compensates by restoring the exact prior public settings snapshot and revision, then returns the generic
sanitized `503 EXTENSION_SETTINGS_PERSIST_FAILED`. The original revision is therefore retryable, and
the prior public projection and runtime values remain authoritative; the attempted secret is never
reported as stored. If that compensating public save also fails, or durable records cannot be paired,
the server reports settings as unavailable rather than claiming a determinate result or success. This
request-time compensation does not provide crash-level atomicity across the two files.

Other useful mutation outcomes include:

| Status | Code | Meaning |
|---|---|---|
| 400 | `EXTENSION_SETTINGS_EXPECTED_REVISION_REQUIRED`, `EXTENSION_SETTINGS_INVALID_REQUEST`, `EXTENSION_SETTINGS_INVALID_IDENTITY` | The CAS precondition, route identity, or request shape is invalid. |
| 400 | `EXTENSION_SETTINGS_INVALID_PACK_MUTATION`, `EXTENSION_SETTINGS_EMPTY_MUTATION`, `EXTENSION_SETTINGS_INVALID_VALUES` | The chosen patch form is not valid for a pack or target. |
| 404 | `EXTENSION_SETTINGS_TARGET_NOT_FOUND`, `EXTENSION_SETTINGS_PACK_NOT_FOUND` | The server cannot resolve the requested installed declaration. |
| 422 | `EXTENSION_SETTINGS_INVALID_SCHEMA`, `EXTENSION_SETTINGS_UNKNOWN_FIELD`, `EXTENSION_SETTINGS_INVALID_FIELD_VALUE`, `EXTENSION_SETTINGS_REQUIRED_FIELD` | The declaration cannot be used, the key/value is invalid, or a required non-defaulted public field was cleared. |
| 503 | `EXTENSION_SETTINGS_UNAVAILABLE`, `EXTENSION_SETTINGS_SECRET_READ_FAILED`, `EXTENSION_SETTINGS_PERSIST_FAILED` | Project public/secret state cannot safely be read or published. Repair or retry; the resolver remains fail-closed. |

For `multi-enum`, a PATCH accepts an unordered valid string array and returns the canonical
code-unit-sorted array. `[]` is an explicit empty project override for an optional field; it is
not the same as `null`. `null` removes an optional or defaulted non-secret override so its declared
default can take effect again, and clears a secret. It cannot clear a required non-secret field
that has no declared default, and it cannot create an empty required selected set. Omitting a field
leaves it unchanged.

Multi-enum values are public configuration: canonical copied arrays may appear in the target PATCH
response, catalogue, and runtime effective configuration after current-declaration reconciliation.
They never relax secret handling. Secret bytes remain absent from YAML, redacted API responses,
logs, attributes, and metadata-only WebSocket invalidations; those frames continue to carry only
refresh metadata.

See [REST API — Project Config](rest-api.md#project-config) for authentication and common error
format, and [WebSocket Protocol](websocket-protocol.md) for refresh delivery.

## Market behavior

Market's Installed view uses its canonical project route as the sole settings context. It never
falls back to the active project or the first visible project. Project-owned requests, settings
forms, and the runtime block are cleared before another project can paint; this prevents a value
from one project briefly appearing under another.

Each installed pack card shows a project runtime block with separate pack, provider, hook, and runtime
switches, configuration state, and grant state. The existing **Review grants** disclosure on the
Pack row lists the six non-hook capabilities individually, requires a confirmation for each grant,
and offers exact revoke actions; it is not a second permissions screen. **Grant history** in the
same Installed surface shows both pack and legacy-hook audit records. A runtime setting controls
declaration eligibility only until a core service consumer is wired; it does not launch a process
today. Declared fields use native labelled controls and an explicit revisioned Save action. Status
distinguishes disabled, needs configuration, grant required, granted but inactive, **Settings need
review** for invalid schema or incompatible evolved non-secret values, unavailable, and active states.

A `multi-enum` field is a native checkbox group: a labelled `fieldset` and visible `legend` contain
one native checkbox per declared value in publisher order. Native label, Tab, and Space behavior,
existing description/error linkage, invalid state, and busy/disabled handling make the group
usable without an emulated ARIA listbox. Its summary distinguishes a selected count, `None selected`,
and `Using default`. A required empty group shows `Select at least one option.` and blocks Save.

For an optional multi-enum field, clearing every checkbox stages the explicit project value `[]`.
**Use default** instead stages removal and sends PATCH `null`, allowing the declared default to be
inherited. Save, reset, navigation, project switch, conflict reload, and page reload discard stale
drafts and hydrate the checked state only from the latest project projection, so a selection cannot
leak between projects.

Secret controls are password inputs that begin empty. They show only presence (`Stored for this
project` or `Not set`), offer an explicit removal action, and clear their DOM value after any
save outcome, reset, navigation, project switch, or reload. A stale save tells the operator to
reload the current projection; Market does not provide an overwrite action.

The projectless `#/market` compatibility surface remains usable for server-scoped source and
package onboarding, but it makes no project-owned settings request. Its Installed view explains
that a project must be selected or created before providers, hooks, and settings can be
configured.

## Focused verification

The selected-set contract is covered at boundaries where a shape or copy could otherwise drift:

- `tests2/core/extension-settings-schema.test.ts` covers descriptor/default normalization,
  canonical ordering, malformed and bounded selections, requiredness, primitive compatibility, and
  defensive copies.
- `tests2/core/extension-settings-store.test.ts` covers native schema-2 YAML, schema-1 rejection
  and migration-on-save, malformed-row isolation, aggregate caps, clone safety, rollback, and
  generation mismatch behavior.
- `tests2/integration/extension-settings-api.test.ts` covers unordered PATCH canonicalization,
  validation failures, reload/runtime projection, scalar-only legacy fallback, native persistence,
  and secret redaction.
- `tests2/dom/marketplace-extension-settings-multi-enum.test.ts` covers the labelled native group,
  canonical draft PATCH behavior, empty versus default semantics, and projection replacement.
- `tests2/browser/e2e/extension-settings.spec.ts` covers keyboard selection, save/reset/reload,
  project isolation, and the continued absence of secret values from UI-visible responses.

## Hindsight migration and isolation

The built-in Hindsight memory provider is a normal consumer of this contract. Configure it in the
Hindsight pack card for each project: `externalUrl` is the required non-secret URL and `apiKey`
is an optional secret; its other declared fields supply the memory defaults and behavior. Hindsight
is dormant until the selected project's effective `externalUrl` is non-blank.

For compatibility, an old Hindsight provider PackStore override is considered only before that
project gets a Hindsight target row. Before that boundary, undeclared primitive legacy runtime
settings, including the former `mode`, can remain in the provider's runtime overlay without being
project settings or public API fields. Generic settings never write the legacy record. Once a
project has a row, including one created to clear a value, every legacy value is excluded: there
is no cross-project or legacy secret fallback. The old pack `config` route is read-only migration
diagnostics; it cannot write configuration or expose legacy values.

Consequently, two projects can use different Hindsight URLs and keys. Disabling Hindsight in one
project removes only that project's resolved provider; it does not disable or alter a configured
provider in another project. This configuration isolation is separate from Hindsight's own
optional memory-recall scope, which governs remote bank query tags rather than Bobbit settings
ownership. See [Hindsight memory pack](hindsight-memory.md) for provider behavior.
