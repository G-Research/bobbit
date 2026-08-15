# Multi-enum extension settings

**Status:** implementation design. **Baseline:** `abaa642bc`. **Companion:** [Extension settings foundation](extension-settings-foundation.md), [Market settings UX](extension-settings-market-ux.md), and [Project extension settings](../extension-settings.md).

## Decision and boundary

Add exactly one public non-secret setting kind, `multi-enum`. It is a bounded, ordered string set selected from the descriptor's declared `values` allowlist. It is intended for choices such as selected languages; it is **not** an arbitrary array/JSON setting type.

```yaml
config:
  languages:
    type: multi-enum
    label: Languages
    description: Languages this provider should use.
    values: [typescript, javascript, python, rust]
    optional: true
    default: [typescript, python]
```

A field value is persisted and returned as an array of unique declared strings, sorted using JavaScript's default `Array.prototype.sort()` order (UTF-16 code-unit order). The descriptor `values` list stays in publisher declaration order for the Market control; only a selected set is sorted. The server always creates a fresh normalized array and never retains or returns a caller-owned array.

`string`, `secret`, `enum`, `boolean`, and `number` retain their exact existing declaration, validation, persistence, request, and response behavior. Secrets remain strings in the owner-only secret store; `multi-enum` is never a secret kind. This slice does not add service, decision, sandbox, hook-dispatch, or Code Intelligence consumer behavior.

## Exact contract and limits

Add these exported constants to `src/server/agent/extension-settings-schema.ts` beside the current enum bounds:

```ts
export const MAX_EXTENSION_SETTING_MULTI_ENUM_SELECTED_VALUES = 64;
export const MAX_EXTENSION_SETTING_MULTI_ENUM_SELECTED_BYTES = 16 * 1024;
export const MAX_EXTENSION_SETTINGS_MULTI_ENUM_SELECTED_VALUES_PER_TARGET = 256;
export const MAX_EXTENSION_SETTINGS_MULTI_ENUM_SELECTED_BYTES_PER_TARGET = 64 * 1024;
```

Existing `MAX_EXTENSION_SETTING_ENUM_VALUES = 128` and `MAX_EXTENSION_SETTING_ENUM_VALUE_BYTES = 256` remain the descriptor allowlist bounds. Consequently a valid selected member is a non-empty, well-formed UTF-8 string of at most 256 bytes; the selected-set byte total is the sum of member UTF-8 byte lengths, not YAML syntax bytes.

`ExtensionSettingKind` becomes:

```ts
type ExtensionSettingKind =
  | "string" | "secret" | "enum" | "multi-enum" | "boolean" | "number";
type ExtensionSettingScalar = string | boolean | number;
type ExtensionSettingValue = ExtensionSettingScalar | string[];
```

`multi-enum` has these strict rules.

| Location | Accepted form | Result / rejection |
|---|---|---|
| Descriptor `values` | Existing enum allowlist: non-empty `string[]`, 1–128 unique non-empty well-formed strings, each ≤256 UTF-8 bytes | Preserve declaration order. It is required for `enum` and `multi-enum`, and forbidden for every other kind. |
| Descriptor `default` | A `string[]` containing 1–64 unique allowlisted strings, total ≤16 KiB; `[]` is permitted only when `optional: true` | Copy and code-unit sort before storing in the normalized definition. No default for `secret`; scalar defaults retain current rules. |
| PATCH/runtime value | A `string[]` under the same member/count/byte/allowlist rules | Normalize to a copied, code-unit-sorted array. Reject an object, a `Set`, tuple/nested array, duplicate, non-string, unknown member, malformed string, excessive count, or excessive bytes. |
| Requiredness | A non-optional `multi-enum` with no default must contain at least one member; clearing with `null` remains rejected like other required non-default fields | `[]` is a valid explicit value only for optional fields. For `requiresConfig`, an empty set is not present. |
| Storage target aggregate | At most 64 field keys (the existing `MAX_EXTENSION_SETTINGS_VALUES_PER_TARGET`), at most 256 selected strings across all multi-enum fields, and at most 64 KiB combined selected bytes | A malformed row is isolated/dropped by project-config normalization; an oversized root remains unavailable as today. |

The aggregate limits apply independently of scalar fields. A single selected set cannot evade its own 64/16 KiB limits by being the only field, and many otherwise-valid sets cannot exceed the 256/64 KiB target total. Only arrays associated with an actual current `multi-enum` field may reach descriptor-aware runtime/API use; no array is accepted as a legacy scalar fallback.

### Canonical helper

Implement one internal/exported schema helper, used by descriptor defaults, API mutation validation, persistence normalization, reconciliation, and cloning:

```ts
function normalizeMultiEnumValue(
  definition: ExtensionSettingDefinition,
  value: unknown,
  options?: { allowEmpty?: boolean },
): string[] | undefined;
```

It must first require `definition.type === "multi-enum"`, `Array.isArray(value)`, the exact bounds above, well-formed text, membership in `definition.values`, and no duplicate. It then returns `[...value].sort()`; it never sorts the supplied array. `isValidExtensionSettingValue()` may call this helper and return a boolean, but callers that retain a valid value must use the helper's returned array rather than the original input.

Add a separate schema-agnostic persistence predicate/helper for already-normalized selected sets. It validates strings/count/bytes/uniqueness and returns a sorted copy, but cannot check the current descriptor allowlist. That narrow exception exists only while parsing durable YAML; `reconcileExtensionSettingsValues()` applies the descriptor-aware helper before a value becomes effective, runtime-visible, or public.

`reconcileExtensionSettingsValues()` returns cloned canonical arrays in `values`, reports an invalid current `multi-enum` public key in `invalidKeys`, and continues to omit it from the projection. Unknown/removed arrays remain ignored exactly like unknown scalar keys. A runtime-only secret reconciliation remains unchanged.

## Native YAML, migration, and generation binding

Bump only the **public storage** schema to `2`; the extension declaration/API schema remains `2` and the secret-envelope schema remains `1`.

```yaml
extension_settings:
  schema: 2
  revision: 7
  commitId: 9f1b20c0-... # existing opaque paired generation
  targets:
    "language-pack\u0000provider\u0000analyzer":
      values:
        languages: [python, typescript]
```

The YAML array is native YAML, not a JSON-encoded string. It is always emitted in sorted order. No secret file, secret key format, secret field semantics, or `commitId` format changes.

Update `src/server/agent/project-config-store.ts` as follows:

1. Change `ExtensionSettingsState.schema` to `1 | 2` and `EMPTY_EXTENSION_SETTINGS_STATE.schema` to `2`. Make `cloneExtensionSettings()` preserve the source schema during a failed-save rollback and deep-clone every selected array.
2. Make `normalizeExtensionSettings()` explicitly parse both versions. A durable `schema: 1` record permits only the original primitives; any array in a schema-1 row invalidates that row. Never reinterpret an old malformed array as a selected set and never coerce an old scalar enum/string into `[value]`.
3. Retain a valid schema-1 record as schema 1 in memory until a successful mutation. `ExtensionSettingsStore.compareAndSwapMany()` changes only its candidate to schema 2 before publication, retaining revision, targets, and optional `commitId`; that successful publication is the migration. A schema-2 record may contain only bounded canonicalizable string arrays or existing valid primitives. It normalizes arrays to copied sorted arrays and enforces the per-target aggregate limits.
4. A malformed schema-2 array (including duplicates, nested/object entries, bad UTF-16, over-limit member/count/bytes) drops only its target row, matching malformed-row isolation. An invalid root/schema/revision/commit identity continues to return unavailable empty state. Neither path logs values.
5. `ProjectConfigStore` snapshots, draft mutation, `getExtensionSettings()`, native serialization, and reload must each deep-clone arrays. Mutating a returned snapshot, mutation input, or prior raw YAML object must not mutate internal state or a later snapshot.

This version boundary is the safe legacy rejection rule: schema 1 has the old primitive-only grammar, while schema 2 has the explicit bounded array grammar. It prevents a hand-edited or previously invalid schema-1 value from gaining semantics merely because the new reader supports arrays.

`src/server/agent/extension-settings-store.ts` must adopt the shared value union and normalized copies in `cloneRecord()`, `cloneState()`, `assertState()`, `assertMutation()`, `getEffective()`, `getForRuntime()`, and `redactedTargets()`. `assertMutation()` may enforce only the schema-agnostic set shape/caps; server declaration validation is still authoritative for allowlist membership and requiredness. The selected arrays in defaults, public overlays, effective values, update results, and runtime values must all be newly allocated.

The secret generation check remains mandatory before public projection, presence projection, runtime reads, and all mutations. A schema-1 public record and its matching legacy flat or matching versioned secret side remain readable under the existing pairing rules. The first successful mutation writes the schema-2 public record and refreshes the same secret envelope with a fresh `commitId`; a public-only `multi-enum` update still advances the private envelope. If the secret write fails, rollback restores the exact pre-mutation record, including its original **storage schema**, revision, arrays, and `commitId`. Never repair or reinterpret a public/secret generation mismatch.

Legacy provider `PackStore` fallback remains `Record<string, ExtensionSettingScalar>` only. It is read only while no target row exists and cannot provide a multi-enum value. This avoids treating an old opaque array as a reviewed declared selection and leaves all primitive fallback behavior unchanged.

## Server and public API changes

Use the shared schema types instead of duplicating the union. The relevant changes are intentionally additive:

| File | Exact change |
|---|---|
| `src/server/agent/extension-settings-schema.ts` | Add `multi-enum`, scalar/value types, the four constants, descriptor default normalization, selected-set helpers, cloned reconciliation, and the `requiresConfig` empty-set presence behavior. Permit `values` for `enum` and `multi-enum` only. |
| `src/server/agent/project-config-store.ts` | Implement the schema-1→2 persistence parsing/migration and deep-cloned bounded selected arrays described above. |
| `src/server/agent/extension-settings-store.ts` | Replace primitive-only checks and shallow `values` spreads with shared value normalization/deep cloning; preserve the secret pairing/compensation sequence. |
| `src/server/server.ts` | Update defaults/effective/public records to the value union, keep legacy PackStore scalar-only, validate/normalize selected arrays by the target field before CAS, and project cloned canonical arrays. |
| `src/app/api.ts` | Add `"multi-enum"` and `string[]` to `ExtensionSettingKind`/`ExtensionSettingValue`; `ExtensionSettingsFieldWire.default`, `.value`, and `PatchExtensionSettingsTargetRequest.values` use that union. |
| `src/app/marketplace-page.ts` | Add the typed multi-select draft/control/validation/save/restore behavior below. |

For a target PATCH, `values.languages` accepts a JSON string array, while `null` still clears an optional/defaulted override. The controlled server sequence is:

1. resolve the winning declared target and field;
2. reject unknown keys, malformed non-array values, unknown/duplicate selections, invalid ordering inputs only after canonicalizing them, caps, and an empty required set with existing `422` fixed error codes (`EXTENSION_SETTINGS_INVALID_FIELD_VALUE` or `EXTENSION_SETTINGS_REQUIRED_FIELD`);
3. pass the fresh canonical array into `compareAndSwap()`;
4. persist native YAML, bind the fresh generation, invalidate caches, and respond with a redacted/public cloned target.

Unordered input is valid but is sorted before compare-and-swap, so callers receive `["python", "typescript"]` regardless of submitted selection order. The response, GET catalogue, and `extension_settings_updated` behavior remain redacted: multi-enum values are public by design; secret bytes remain absent. The metadata-only WebSocket frame must not gain values or arrays.

`extensionSettingsProjection()` and the earlier runtime effective-settings path near `src/server/server.ts:3062` must treat a declared `multi-enum` default/overlay as a value union, clone it, reconcile it against the current allowlist, and fail closed on an invalid stored value. `requiresConfig` treats `[]` as missing, just as it treats a blank string as missing. No service or Code Intelligence consumer is added in this change.

## Market interaction

`src/app/marketplace-page.ts` adds `string[]` to its local non-secret draft/wire value type. Every state boundary (`normalizeExtensionSettings()`, `draftFor()`, `setDraft()`, request assembly, clear/reset, successful replacement) clones arrays and normalizes a selected array with `const normalized = [...selected].sort()`. Draft comparison is element-by-element after canonicalization, not reference equality.

For `field.type === "multi-enum"`, `renderSettingsField()` renders a native control:

```html
<select multiple class="market-input" data-testid="market-settings-input"
  data-field-key="languages" aria-describedby="…">
  <!-- descriptor values in declaration order -->
</select>
```

Retain the existing generic input test id and distinguish the kind through its wrapper. The concrete selector contract is:

```text
[data-testid="market-settings-field"][data-field-type="multi-enum"]
[data-testid="market-settings-input"][data-field-key="languages"]
```

The native `<select multiple>` has the existing visible `<label for>`, description/error `aria-describedby`, `aria-invalid`, disabled/busy state, and a visible instruction such as “Select one or more languages.” It exposes declaration values in declaration order, applies the normalized selected values with Lit's selected-option handling (not a string `.value`), and on `change` reads `Array.from(select.selectedOptions, option => option.value)`, clones/sorts it, validates it, and marks that owner dirty. Do not invent a custom checkbox/listbox widget.

For optional fields, **Use default** stages `undefined`; an explicit empty selection is a project-owned empty set and remains distinguishable from fallback/default. For required fields the client reports “Select at least one option.” before Save. Client validation also reports a fixed safe error for a selection no longer declared; server validation remains authoritative. Source/default text states a count and list of selected display values without exposing any secret (for example, `Default: python, typescript`).

On success, navigation, project switch, reload, conflict reload, reset, and form close, discard drafts and hydrate selections solely from the returned canonical projection. A reload must show the persisted selected options and no stale selection from the preceding project/owner. Keep existing secret input clearing unchanged.

Add narrow `src/app/marketplace.css` rules for the native multi-select only: match `.market-input` sizing/focus/disabled styles, give it a usable minimum height for several rows, and preserve the existing 36 px desktop/44 px narrow-screen targets. Do not change existing primitive controls or create a new palette.

## Focused verification

Extend existing registered tests; add a `tests2/tests-map.json` entry only if a genuinely new file is created.

| Layer | File | Required assertions |
|---|---|---|
| Core | `tests2/core/extension-settings-schema.test.ts` | Valid descriptor/default/runtime multi-enum values normalize to code-unit order; reject missing/non-array/default secret, duplicate/unknown/ill-formed/over-member/over-count/over-byte values, empty required set, `values` on a non-enum kind, and invalid `requiresConfig`. Assert enum and all primitive outcomes stay unchanged. Test defaults, reconciliation outputs, and input arrays cannot be mutated through aliases. |
| Core | `tests2/core/extension-settings-store.test.ts` | Native YAML schema-2 round trip uses sorted arrays; a schema-1 primitive record migrates only on save; schema-1 array is rejected rather than upgraded; schema-2 malformed array row isolation; all per-field/aggregate limits; snapshots/effective/update/runtime result arrays are independent copies; a secret-save failure restores the original schema/revision/commitId/array snapshot; generation mismatch remains unavailable. |
| Integration | `tests2/integration/extension-settings-api.test.ts` | Fixture declares `languages: { type: multi-enum, values: [typescript, python, rust], optional: true }`. PATCH accepts an unordered valid selection and GET/PATCH/reload return sorted `['python', 'typescript']`; reject duplicate, undeclared, scalar/object/nested arrays, required empty set, and caps with safe fixed errors. Assert YAML native sequence, legacy PackStore arrays do not supply a value, cache-invalidated runtime sees a valid selected set, and primitive/secret API contracts are unchanged. |
| DOM | `tests2/dom/marketplace-active-project.test.ts` (or a focused new `tests2/dom/marketplace-extension-settings-multi-enum.test.ts`) | Stub wire field and assert native `select[multiple]`, labelled/error/busy attributes, declared-order options, canonical multi-selection draft PATCH body, optional default reset versus explicit empty selection, and replacement on project switch/reload without cross-project draft leakage. |
| Browser | `tests2/browser/e2e/extension-settings.spec.ts` | Extend the isolated Hindsight fixture with `languages`; keyboard-select two entries from the labelled native select, save, assert the redacted PATCH/GET response and re-opened/reloaded control contain the sorted values, switch projects and verify no flash/leak, then return/reload and restore A's choices. Include an invalid required fixture case or API-assisted setup proving the visible error/blocked Save behavior. Preserve the existing no-secret-sentinel assertions. |

Run after implementation:

```bash
npx vitest run tests2/core/extension-settings-schema.test.ts tests2/core/extension-settings-store.test.ts tests2/integration/extension-settings-api.test.ts tests2/dom/marketplace-active-project.test.ts --config vitest.config.ts --retry=0
BOBBIT_V2_RETRY_FREE=1 npm run test:browser -- tests2/browser/e2e/extension-settings.spec.ts --retries=0
```

## Non-goals

- Arbitrary JSON/object/array settings, free-form tags, nested paths, per-element metadata, option labels, or a secret string set.
- Automatic migration of an old scalar or opaque legacy array into selected values.
- Relaxing primitive kinds, altering secret persistence/redaction, changing commit-binding recovery, or exposing values in WebSocket invalidations.
- New runtime consumers, provider/service lifecycle work, decision/hook/sandbox behavior, or Code Intelligence language selection logic.
