# Per-model thinking-level capabilities

Thinking level controls how much reasoning effort a model uses. Support is a property of an exact model row, not a provider name or model-family pattern. Bobbit shares one capability implementation between the server and UI so selectors, runtime changes, restore, and spawn use the same rules.

The canonical definitions live in [`src/shared/thinking-levels.ts`](../src/shared/thinking-levels.ts).

## Metadata authority

Bobbit consumes capability metadata from the model's authoritative source:

- direct built-ins use the exact Pi catalog row;
- well-known AIGW models use the gateway's advertised `reasoning` and `variants` fields;
- custom and user-owned AIGW models use the exact row composed for the active target realm.

Model IDs and provider names never grant reasoning capability or extended thinking tiers. The only model-name inference retained in production is `inferLegacyAigwMeta`, used exclusively while translating the legacy AIGW `/v1/models` fallback. Its result does not enter direct-Pi, well-known, custom-composed, live-state, or thinking-clamp paths.

This separation matters because a plausible family match can still be wrong: chat variants can be non-reasoning, different Claude rows can advertise different context and thinking support, and unrelated IDs can contain strings such as `o1`.

## Canonical levels

```ts
export const THINKING_LEVELS = [
  "off", "minimal", "low", "medium", "high", "xhigh", "max"
] as const;
```

`getSupportedThinkingLevels(model)` applies these rules:

| Exact metadata | Supported levels |
|---|---|
| `reasoning === false` | `off` only |
| `thinkingLevelMap` present | The canonical ladder filtered by the map rules below |
| `reasoning === true`, no map | `off` through `high` |
| reasoning unavailable, no map | `off` only |

For a present `thinkingLevelMap`:

- a `null` value explicitly removes that level;
- an absent base level (`off` through `high`) uses the provider default and remains available;
- `xhigh` and `max` require an explicit non-null map entry.

For example, `off: null` means adaptive thinking cannot be disabled, while an absent `max` means Bobbit must not offer `max`. A well-known AIGW document contributes only variants it advertises; advertised `none` also maps Bobbit's `off` level to the wire value `none`.

## Clamping

`clampThinkingLevel(level, model)` keeps a supported request unchanged. Otherwise it searches upward for the nearest supported level, then downward if none exists above. This mirrors Pi and preserves reasoning intent when a model removes a low or middle tier.

Examples:

- if `minimal` is explicitly unsupported but `low` is supported, `minimal` clamps to `low`;
- if `off` is explicitly unsupported, `off` clamps to the lowest available reasoning tier;
- `max` clamps to `xhigh` when only `xhigh` is advertised;
- any reasoning request clamps to `off` for an exact non-reasoning row.

Stored role and preference values may outlive the model that originally supported them. Bobbit therefore preserves the stored intent and clamps at use time against the selected exact row rather than deleting the preference.

## Live-state metadata

`resolveModelStateMeta(provider, id)` supplies capability fields for live and rehydrated `state.model` frames:

1. the last exact assembled registry row, keyed by provider and ID;
2. the exact Pi built-in row for a direct provider;
3. an explicit unavailable result with no fabricated capability fields.

The assembled row is retained beyond the normal registry cache TTL. For an unchanged AIGW/custom source, a transient discovery failure therefore does not erase trustworthy context, output, reasoning, modalities, or thinking-map metadata. Reconnect, restore, role changes, and thinking controls continue to display and clamp from the last exact row.

A successful discovery result remains authoritative. If it omits a row, the previous row is not merged back. When exact composed metadata is unavailable and Pi supplies identity-matching live state, Bobbit may preserve capability fields from that live state; missing fields remain missing rather than becoming guessed defaults.

This fail-closed behavior prevents a reconnect or fallback frame from silently changing a context window, hiding an advertised tier, or enabling reasoning on the wrong model.

## Server boundaries

The UI clamps eagerly for immediate feedback, but the server repeats validation because API clients, extensions, stale preferences, and raw spawn arguments can bypass the UI.

- Live `set_model` validates the exact session-selectable row, clamps the requested level, applies the model, and verifies the complete tuple before persistence.
- Live `set_thinking_level` resolves exact metadata for the currently bound tuple and refuses the change when thinking metadata is unavailable.
- Session, delegate, review, QA, restore, role-replacement, and force-abort spawns pass through the final spawn tuple validator. It clamps the effective thinking level against the exact effective provider/model after all raw arguments are assembled.
- State frames use the same exact registry metadata, so the selector after selection or reload matches the catalog row shown before selection.

Only a verified provider, model, and effective-thinking tuple becomes durable. An unrequested Pi fallback or a family-derived capability is not accepted as success.

## Gateway provider boundary

Thinking capability is keyed by the exact provider/model tuple. The singleton `aigw` provider may retain AIGW capability metadata, but a named OpenAI-compatible gateway with a `claude-*` ID must not inherit Anthropic or AIGW thinking tiers merely from its name. Unknown or mismatched providers fail closed.

## UI behavior

Every thinking selector derives its options from `getSupportedThinkingLevels` and clamps through the shared helper.

A model-picker change sends one combined frame:

```json
{
  "type": "set_model",
  "provider": "anthropic",
  "modelId": "claude-opus-5",
  "thinkingLevel": "xhigh"
}
```

The client updates optimistically, then replaces both model and thinking fields with the server's authoritative state. Standalone thinking changes use `set_thinking_level`. On failure, the client requests state again so an optimistic value cannot remain displayed.

A session in `MODEL_SELECTION_REQUIRED` keeps its unavailable requested tuple visible until an exact replacement starts, restores, clamps, and verifies successfully. See [Controlled session model fallback](session-model-fallback.md).

## Related documentation

- [Metadata-shim retirement decision](design/openai-model-additions-retirement.md)
- [AI Gateway routing](ai-gateway-routing.md)
- [Spawn-time model pinning](internals.md#spawn-time-model-pinning)
- [Pi runtime compatibility](pi-runtime-compatibility.md)
