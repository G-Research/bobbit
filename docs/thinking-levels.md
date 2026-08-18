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

## UI behavior

Every thinking selector derives its options from `getSupportedThinkingLevels` and clamps through the shared helper.

## Clamping, not rejection

`clampThinkingLevel(level, model, opts?)` is the validate-or-degrade entry
point. If the requested level is supported it is returned unchanged.
Otherwise the walk is **up-then-down** — first step **up** by rank to the
nearest supported level, and only if none exists above it, step **down**:

```
1. up:   token → … → max     (nearest higher supported level)
2. down: token → … → off     (only if nothing supported above)
```

This mirrors pi-ai's own `clampThinkingLevel` direction exactly — again so
Bobbit and the runtime never disagree. Upward-first matters in two cases the
old pure-down walk got wrong:

- **A map drops a *middle* level while keeping lower ones.** gpt-5.5's
  `minimal: null` yields supported `off, low, medium, high, xhigh`. A request
  for `minimal` now clamps **up to `low`**, not down to `off` — valid
  reasoning intent is never silently disabled.
- **A map drops `off` itself.** Fable's `off: null` yields supported
  `minimal, low, medium, high, xhigh, max`. A request for `off` clamps **up to
  `minimal`** (the lowest supported level) rather than returning an
  unsupported `off`.

For every family that still supports `off` (all the map-absent heuristic
cases, opus/sonnet/haiku), the up-then-down walk lands on the same result the
old down-only walk did — the fix is strictly additive for the
`off`-unsupported case. Concretely:

- `xhigh` on Sonnet 4.6 (no xhigh) clamps to `high`.
- `max` on Opus 4.8 clamps to `xhigh`; `max` on a Pi `0.84.1` Opus 5 catalog
  row stays `max` because that exact row advertises it.
- `xhigh` on a non-reasoning model (e.g. Haiku) clamps to `off`.
- `off` on Fable (`off` unsupported) clamps **up** to `minimal`; `high` and
  `max` stay unchanged when the Fable map includes them.
- Unknown strings (`"weird"`, stale tokens from old prefs) are normalised to
  `off` first, then clamped — which yields the lowest supported level.
- An empty/undefined level with `opts.allowEmpty: true` returns `undefined`
  (the "inherit" sentinel used by role overrides and prefs).

Clamping rather than rejecting was a deliberate choice. The same preference
key (`default.sessionThinkingLevel`) is consulted across many sessions; a
user might set `xhigh` or `max` while a capable model is their default, then
later change the role's model to one that doesn't support it. Rejecting would
either:

- silently drop the preference (lose the user's intent the moment they
  switch models), or
- error out and block the session from starting (refuse to run a session
  because of a stored preference).

Clamping does neither — the user's `xhigh`/`max` preference is preserved in
storage, and at session start it is degraded to the best level the resolved
model can actually run. If they switch back to a capable model, the original
preference is honoured again. The behaviour mirrors pi-mono's "Fixed adaptive
thinking … clamped unsupported effort values to supported levels" fix.

## The `thinkingLevelMap` has to reach the client to be useful

Everything above only works if the client's `state.model` frame actually
carries the model's real metadata — `reasoning`, `contextWindow`, and, now,
`thinkingLevelMap`. That frame used to be derived from
[`aigw-manager.inferMeta()`](../src/server/agent/aigw-manager.ts) alone, a
regex heuristic that knows nothing about `thinkingLevelMap` and reports any
unrecognised `claude-*` id as a 200k-context, `reasoning: false` model. So
selecting Claude Fable 5 (a 1M-context adaptive-thinking model) hid the
thinking selector entirely and showed the wrong context window — even though
the ModelSelector *dropdown* rendered it correctly (the dropdown is built from
the merged pi-ai catalog). Selecting the model clobbered the good data with
the `inferMeta`-only frame.

### `resolveModelStateMeta` — single source of truth for live frames

`resolveModelStateMeta(provider, id)` in
[`src/server/agent/model-registry.ts`](../src/server/agent/model-registry.ts)
is now the one function every live `state.model` broadcast routes through, so
the values the client renders **after** selecting a model match what the
dropdown showed **before**. It returns `{ contextWindow, maxTokens,
reasoning, thinkingLevelMap?, input }`, resolved first-hit-wins:

1. **Registry cache** (`cachedModels`, the same merged list
   `getAvailableModels` returns), keyed by exact `provider` + `id`. The 5s
   cache TTL is deliberately ignored here — model metadata is static per id,
   so a stale entry is strictly better than dropping to `inferMeta`, and the
   synchronous lookup serves the sync broadcast sites (e.g.
   `sendFallbackModelState`).
2. **pi-ai catalog** via `getModel(provider, id)` for known upstream
   providers (skipping empty / `aigw` / `custom`). Any missing numeric is
   backfilled from `inferMeta`.
3. **`inferMeta(id)`** — last resort for genuinely-unknown models. It carries
   no `thinkingLevelMap`, so the client falls back to the family heuristic.

The frame now includes `thinkingLevelMap` whenever the resolver has it
(omitted otherwise), so `getSupportedThinkingLevels` on the client derives the
exact set upstream declares rather than guessing from the family. Every
broadcast site was migrated:

- runtime model select — `src/server/ws/runtime-model-selection.ts`
- fallback + archived rehydration — `sendFallbackModelState` /
  `buildArchivedStateData` in `src/server/ws/handler.ts`
- spawn-pinned / role / default / aigw auto-select — the `buildModelStateData`
  helper in `src/server/agent/session-manager.ts`

### aigw is a documented fallback gap

AI-Gateway discovery strips the Claude prefix from ids and does **not** merge
`thinkingLevelMap` into the catalog, and `resolveModelStateMeta` skips the
pi-ai catalog for `provider === "aigw"`. So an aigw-routed Fable id
legitimately falls through to `inferMeta` and gets the family-heuristic
level set (no map). The direct `anthropic` / `amazon-bedrock` paths — where
the pi-ai catalog entry exists — are fully covered. This is an accepted
limitation for gateway-only deployments, not a bug: closing it would require
the aigw discovery path to carry per-model thinking maps.

## Server-side clamping at every boundary

The UI also clamps reactively (see below), but trusting the client would be
wrong — extensions, MCP clients, stale prefs, and direct REST callers all
bypass the UI. The server clamps at every entry point:

| Boundary | Site | What it clamps |
|---|---|---|
| WS `set_model` | `src/server/ws/runtime-model-selection.ts` | The optional requested thinking level, or the previous effective level for an older frame, against the exact selected catalog model before either value becomes durable. |
| WS `set_thinking_level` | `src/server/ws/handler.ts` | The level the client sent, against the session's currently-bound model. |
| REST role create/update | `clampRoleThinking` in `src/server/server.ts` | The role's `thinkingLevel` field, against the role's `model` if set (or returned as-is if the role inherits, since the per-session clamp will run at spawn). |
| REST project/system prefs PUT | `/api/preferences` | Stored as-is (no write-time clamp): defaults can apply to many models and the resolved model is not yet known. `resolveInitialThinkingLevel` later resolves a configured role/default candidate and clamps it for setup. |
| Session start | `resolveInitialThinkingLevel`, `resolveDynamicContext`, and `tryAutoSelectModel` | Setup first accepts explicit caller, role/default, or matching durable authority. Only when that authority is absent may the lifecycle decision path return an enabled, exactly granted selector candidate; that candidate is exact-model clamped. `tryAutoSelectModel` then verifies and persists the complete tuple. No path synthesizes an optional level when there is no candidate. |
| Verification harness | `clampReviewThinking` in `src/server/agent/verification-harness.ts` | Reviewer/QA/sub-session levels at six call sites, against the resolved reviewer or role model. |

Both server helpers (`clampRoleThinking`, `clampReviewThinking`) parse the
canonical `<provider>/<modelId>` model string, ask
[`aigw-manager.inferMeta()`](../src/server/agent/aigw-manager.ts) for the
model's `reasoning` flag, and hand the resulting `ModelLike` to
`clampThinkingLevel`. When no model is resolvable yet (e.g. a role saved
without `model`), the helper returns the validated token unchanged — the
per-session clamp at spawn time will run with full model context.

### aigw `INFER_RULES` ordering pin

`INFER_RULES` in `src/server/agent/aigw-manager.ts` is a regex table that
maps an aigw-routed model id to its capability metadata, including
`reasoning: true|false`. The order matters: rules are matched first-wins, so
**specific xhigh-capable rules must come before the generic catch-all**.

In particular, `gpt-5.2` and `gpt-5.1-codex-max` rules must precede the
generic `/gpt-5/` rule. The generic rule sets `reasoning: false` (matching
plain `gpt-5`/`gpt-5o`/etc.); if it matched first, `gpt-5.2` would inherit
`reasoning: false`, `getSupportedThinkingLevels` would collapse to `["off"]`
on the server boundary, and any user request for `xhigh` (or even `medium`)
would be clamped all the way to `off` for aigw-routed users.

This is purely a server-side concern — the UI also calls `inferMeta` via the
shared module path, but the bug surfaces as "thinking level mysteriously
resets to off for aigw users on gpt-5.2" if the rule order regresses.

## Optional first-party selector

The optional `thinking-selector` built-in pack can propose `medium`, the level
formerly chosen by a core fallback. It is not a hidden default: the pack ships
default-disabled and requires both Market activation and an exact project grant
for the `default-thinking` hook's `decide` capability. If it is absent,
disabled, shadowed, ungranted, or revoked, Bobbit neither imports the hook nor
synthesizes a thinking selection.

Setup has a deliberately narrow boundary. `resolveInitialThinkingLevel` first
supplies only configured role/default authority; explicit caller-provided
startup choices and a matching verified durable tuple are authority as well.
`resolveDynamicContext` may consume the decision dispatcher's reduced thinking
candidate only when that explicit authority is absent. The dispatcher admits a
candidate only from an enabled hook with its exact grant. Every candidate is
clamped against the exact selected model before it enters spawn or live tuple
handling. When neither core authority nor an admitted candidate exists, Bobbit
leaves the optional selection unset rather than manufacturing `medium` or any
other fallback.

With both opt-ins, the pure hook can make a proposal during session setup and
after a turn. The dispatcher admits and reduces that proposal; setup awaits its
reduced result before spawn, while after-turn work remains detached. The pack
never controls the final level: `tryAutoSelectModel` and the live advisory path
verify the complete provider/model/thinking tuple with Pi, persist only the
verified tuple, and broadcast authoritative state.

This boundary preserves operator authority. Authenticated user selections,
caller-provided startup choices, role or global defaults, and a matching
verified tuple on recovery are explicit choices, not extension advice. They
suppress the selector; core rechecks that fence and the exact grant immediately
before a live mutation, so a late proposal cannot override a user or operator
change. The selector never writes `HumanSelectionPins`.

The clamp stays in core because a pack can only nominate a host-known token;
it cannot determine a model's supported levels safely. The live model may have
changed after a hook ran, and Pi metadata remains the authoritative capability
source. Keeping the clamp/read-back boundary in core prevents an unavailable
or stale proposal from becoming a durable value. See [EP-12 — Thinking selector
extraction](design/ep-12-thinking-selector-extraction.md) for the package,
precedence, measurement, and test record, and [Extension decision requests](extension-decision-requests.md#advisory-selection-proposals)
for the generic proposal/grant contract.

## UI: reactive clamping when the model changes

The UI never invents its own rules — every selector imports
`getSupportedThinkingLevels` and `clampThinkingLevel` from
`src/shared/thinking-levels.ts`.

### Per-session picker and footer (`src/ui/components/AgentInterface.ts`)

The footer dropdown computes its options from `state.model` every render, so
switching the session's model immediately reshapes the menu. Both model-picker
entry points use the same selection helper: it clamps the current thinking
value against the newly chosen model's authoritative metadata, optimistically
stages both fields, and calls `session.setModel(model, effectiveLevel)` once.
`RemoteAgent` then sends one combined frame:

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

### Standalone thinking changes

For an ordinary live session, changing only the footer or message-editor
thinking control remains a separate operation. It calls
`session.setThinkingLevel(level)` and sends
`{ "type": "set_thinking_level", "level": "..." }`; it does not resend the
model picker request. The server clamps that level against the currently bound
exact model, verifies the resulting complete model/thinking tuple, persists it,
and broadcasts authoritative state. `SET_THINKING_LEVEL_FAILED` follows the
same correction, bounded rollback/restart, and `get_state` refresh behavior.

The full-name label map in `AgentInterface.ts` is the single place to extend if
a new level is added; `xhigh` is labelled "Extra high" and `max` is labelled
"Max".

### Settings page and role manager (`src/app/settings-page.ts`)

`renderModelRow` is the shared helper used by the global settings page and
by the role-manager's per-role override tab. It:

1. Looks up the selected model in the registry to get `reasoning` and
   `supportsXHigh` status.
2. Derives the dropdown options from `getSupportedThinkingLevels(model)`.
3. If the stored value is no longer supported by the currently selected
   model, **clamps for display** and **defers a persistence call** via
   `queueMicrotask` so the saved preference catches up on the next tick.
   This guarantees displayed and stored values match — the user is never
   shown one level while another is on disk.
4. When `selectedModel` is undefined (registry still loading, or the saved
   pref points at a model that has since disappeared), falls back to the
   full reasoning-capable set so the dropdown stays usable. The server
   clamps defensively when the actual model resolves.

## Test coverage

The behaviour is pinned across the shared module, the metadata resolver, and
the wire:

| Test | What it pins |
|---|---|
| `tests2/core/thinking-levels.test.ts` | Capability matrix for Opus 4.5/4.6/4.7/4.8, dotted Opus ids, AIGW-routed Opus ids, Sonnet 4.6, GPT 5.x, non-reasoning models, clamping behaviour, and the cross-provider-collision pin. It also covers map-present cases including Fable's `{off:null, xhigh:"xhigh", max:"max"}` and GPT 5.6 `max` exposure. |
| `tests2/core/model-utils.test.ts` and `tests2/core/models-api.test.ts` | Pi `0.84.1` direct Anthropic and supported Bedrock Opus 5 rows advertise exact `{xhigh, max}` metadata and the complete supported ladder. |
| `tests2/dom/client-combined-model-thinking-selection.test.ts` | The picker sends one clamped `set_model` tuple, authoritative state replaces both optimistic fields, and selection errors request `get_state`. |
| `tests2/core/controlled-model-fallback.test.ts` | Combined and standalone selections persist only verified complete tuples; failed or partial writes correct both fields and use bounded rollback/restart recovery. |
| `tests2/core/fable-thinking-levels-repro.test.ts` | Regression repro for the Fable-specific outcome — forced adaptive thinking (`off` dropped) with the selector present. |
| `tests2/core/model-state-meta-resolver.test.ts` | `resolveModelStateMeta` returns pi-ai values for `claude-fable-5` (1M ctx, `reasoning:true`, full `thinkingLevelMap`) and falls back to `inferMeta` for a genuinely-unknown id. |
| `tests2/dom/thinking-levels-per-model.test.ts` | Fixture-based browser tests that exercise selector logic, including the map-present cases. |
| `tests2/integration/fable-model-state-frame.test.ts` | Selecting Fable emits a `state.model` frame with 1M context, `reasoning:true`, and the map, then preserves it across reconnect/`get_state`. |
| `tests2/browser/journeys/pi-runtime-upgrade.journey.spec.ts` | Browser journey for model metadata through settings/model selection and transcript reload after a mock-agent exchange. |

The unit suite is the authoritative spec — if a behaviour isn't pinned
there, the rule isn't real. The fixture and E2E layers prevent regressions
in the wiring between the shared module and the UI / server boundary.

## Out of scope

- **Adding levels beyond `off|minimal|low|medium|high|xhigh|max`** is upstream's
  call (pi-mono / pi-coding-agent). Bobbit will accept new levels once they
  appear in the upstream enum.
- **How thinking levels are passed to the agent process** — `--thinking
  <level>` remains the spawn-time CLI flag. A live model pick carries the
  effective level in Bobbit's combined `set_model` frame and then uses Pi's
  existing model/thinking setters with exact read-back; an independent level
  change still uses the standalone `set_thinking_level` frame.
- **Per-provider thinking-budget tuning** (`thinkingBudgets` in
  pi-agent-core) — a separate concern.

## Related docs

- [Metadata-shim retirement decision](design/openai-model-additions-retirement.md)
- [AI Gateway routing](ai-gateway-routing.md)
- [Per-role model & thinking-level overrides](internals.md#per-role-model--thinking-level-overrides)
  — how roles can pin model + level overrides, and how the cascade resolves
  them.
- [Spawn-time model pinning](internals.md#spawn-time-model-pinning) — how
  setup passes a selected, clamped level into the agent CLI args so there is no
  boot-time race.
- [Pi runtime compatibility](pi-runtime-compatibility.md) — current Pi `0.84.1`
  package, Opus 5 catalog, exact tuple, spawn, audit, and verification status.
- [Pi 0.77 / Claude Opus 4.8 compatibility](pi-0.77-opus-4.8.md) — historical
  package, ranking, xhigh, spawn, transcript, and regression-test notes.
