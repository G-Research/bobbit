# Per-model thinking-level capabilities

The "thinking level" picker controls how much reasoning effort the underlying
model spends before answering. Not every model supports every level — Opus 4.8
exposes an extra `xhigh` step, GPT 5.6 models expose `max`, plain `gpt-4`
exposes none — and the set of levels has to stay consistent across UI
selectors, REST endpoints, the WebSocket boundary, and the verification
harness.

Rather than scattering hardcoded `["off","minimal","low","medium","high"]`
arrays around the codebase, all capability questions go through one shared
module: [`src/shared/thinking-levels.ts`](../src/shared/thinking-levels.ts).

This page documents the rules that module enforces, where it is consulted,
and why the design clamps rather than rejects.

## Why a single source of truth

Bobbit talks to many model families across many providers (Anthropic direct,
OpenAI direct, AI-Gateway-routed, Google, local) and the set of levels a
particular model accepts is a property of the model — not the provider, not
the UI, not the user's preference. Before this module landed, the same enum
was duplicated in roughly ten places:

- server boundary validation (role POST/PUT, project & system prefs, WS
  `set_thinking_level`, CLI flag whitelist for the spawned agent),
- the verification harness (six reviewer/QA/legacy sub-session sites),
- UI selectors (per-session footer, settings page, role manager, message
  editor callback type).

Adding `xhigh` or `max` upstream would have meant editing all of them. Worse,
the duplication had already drifted: picking an xhigh-capable Opus model in
Bobbit silently capped the user at `high` because the server's value table
never knew `xhigh` existed, and the settings page offered `minimal` on models
that don't support it.

The shared module collapses every capability decision to one function and
one clamping rule. When upstream model metadata includes a per-model
`thinkingLevelMap`, Bobbit now consumes it **as the full source of truth**
(not just for `xhigh` detection) — mirroring pi-ai's own
`getSupportedThinkingLevels` / `clampThinkingLevel`, which is what the agent
runtime actually enforces. Only sparse payloads with no map still rely on the
fallback family regex. See [Mirroring pi-ai when a `thinkingLevelMap` is
present](#mirroring-pi-ai-when-a-thinkinglevelmap-is-present) below.

## The canonical set

```ts
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
```

Ranked low→high. `off` is available unless upstream explicitly disables it
with `off: null` (forced adaptive thinking). `xhigh` is supported by Opus
4.6+ and some GPT 5.x families. `max` is exposed by the Pi `0.81.1` catalog
for models whose upstream `thinkingLevelMap` explicitly includes it.

The canonical `ThinkingLevel` type, the `ModelLike` shape consumed by
capability detection, and the helpers below all live in
`src/shared/thinking-levels.ts` and are imported by both the server
(`src/server/`) and the UI (`src/app/`, `src/ui/`).

## Capability rules

`getSupportedThinkingLevels(model)` returns the subset valid for the given
model. The first branch that applies wins:

| Model trait | Returned levels |
|---|---|
| `reasoning === false` | `["off"]` |
| `thinkingLevelMap` **present** | map-filtered ladder — see below |
| `thinkingLevelMap` **absent** and `supportsXHigh(model)` | `off, minimal, low, medium, high, xhigh` |
| `thinkingLevelMap` **absent** otherwise | `off, minimal, low, medium, high` |

`max` is intentionally absent from all map-less fallback rows. Bobbit only
offers `max` when Pi's catalog explicitly advertises it.

### Mirroring pi-ai when a `thinkingLevelMap` is present

When the model carries a `thinkingLevelMap`, Bobbit trusts it **completely**
and filters the canonical ladder exactly the way pi-ai's own
`getSupportedThinkingLevels` does (the map is upstream's per-model declaration
of which efforts the model accepts). The rule per level is:

- **Map value is exactly `null`** → the level is **dropped** (explicitly
  unsupported). Crucially, `off: null` means *forced adaptive thinking* — the
  model cannot have reasoning disabled — so `off` itself is removed.
- **Level absent from the map** → **kept** (the provider applies its default
  for that effort). The extended levels `xhigh` and `max` are exceptions:
  they are kept only when present with a non-null value.

Why trust the map fully rather than only reading `xhigh`/`max` from it?
Because the map is what the agent runtime obeys. If Bobbit offered a level the
model rejects (or hid one it accepts), the picker and the runtime would
disagree — exactly the drift this module exists to prevent. Reading only the
extended levels from the map while assuming the full `off→high` ladder was
wrong the moment a model started dropping `off` (Fable) or a middle level
(gpt-5.5's `minimal: null`).

**Worked outcomes (verified against the live pi-ai catalog):**

| Model | `thinkingLevelMap` | Supported levels |
|---|---|---|
| Claude Fable 5 | `{ off: null, xhigh: "xhigh", max: "max" }` | `minimal, low, medium, high, xhigh, max` — **no `off`** |
| Claude Opus 4.8 | `{ xhigh: "xhigh" }` | `off, minimal, low, medium, high, xhigh` |
| gpt-5.2 | `{ off: "none", xhigh: "xhigh" }` | `off, minimal, low, medium, high, xhigh` |
| gpt-5.5 | `{ off: "none", xhigh: "xhigh", minimal: null }` | `off, low, medium, high, xhigh` — **no `minimal`** |
| gpt-5.6 Luna/Sol/Terra | non-null `xhigh` and `max` entries | `off, minimal, low, medium, high, xhigh, max` |

Fable is the headline case: `off: null` forces adaptive thinking, so the
thinking selector appears **without an Off option** offering
minimal/low/medium/high/xhigh/max — not the old full `off→high` ladder, and
not "only Off + Extra high".

### Family heuristic when the map is absent

Sparse payloads (AI-Gateway discovery, persisted-fallback state) carry no
`thinkingLevelMap`. For those, `supportsXHigh(model)` decides the top step via
family matching:

When the map is present, `supportsXHigh` is irrelevant to
`getSupportedThinkingLevels` — the map alone decides. `supportsXHigh` still
resolves metadata-first (non-null `xhigh` map entry) so callers that ask it
directly stay correct, then falls back to family matching. There is no
`supportsMax` family heuristic: `max` requires explicit metadata.

The fallback families currently qualify:

- **Anthropic Claude Opus 4.6 and later** — matched by
  `/claude-opus-4(?:-|\.)(?:[6-9]|\d{2,})\b/i`, so `claude-opus-4-6`,
  `claude-opus-4-8`, dotted `claude-opus-4.8`, and any future `-4-10`+
  light up without a code change.
- **OpenAI gpt-5.1-codex-max and any gpt-5.2\* / gpt-5.4\* / gpt-5.5\*** —
  matched by `/^gpt-5\.1-codex-max\b/i` and
  `/^gpt-5\.(?:2|4|5)(?:\b|[-.])/i`. `gpt-5.2-codex`, `gpt-5.4-mini`, and
  `gpt-5.5-pro` are covered by the second regex.

### Why the regex tolerates 4-10+ but not 4-5

The `[6-9]|\d{2,}` branch lets the matcher accept `4-6` through `4-9` and
anything with two or more digits (`4-10`, `4-11`, …). Both hyphenated and
dotted separators are accepted because providers and gateways may expose
`claude-opus-4-8` or `claude-opus-4.8`. `4-5` and earlier are deliberately
excluded — Anthropic's earlier Opus 4 generations did not support `xhigh` and
we don't want a false positive on them.

### Provider guard — fail closed on id collisions

A model id alone is not a reliable signal. AI-Gateway-routed deployments
preserve the canonical id (`claude-opus-4-7`) but report `provider: "aigw"`;
some custom OpenAI-compatible gateways have served Claude-shaped ids; future
providers may collide intentionally.

`providerMatches(provider, canonical)` is the guard:

- `provider === canonical` (e.g. `anthropic` for a `claude-*` id) → accept.
- `provider === "aigw"` → accept; aigw routes from many upstreams but keeps
  the canonical id, so the regex still discriminates correctly.
- `provider === ""` (legacy client state with the field unset) → accept.
- Anything else (e.g. `openai` with a `claude-*` id) → **reject**.

The default is closed: an unknown or mismatched provider does **not** light
up `xhigh`, even if the id matches the family regex. This pin is covered by
the cross-provider-collision case in `tests2/core/thinking-levels.test.ts`.

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
| WS `set_thinking_level` | `src/server/ws/handler.ts` | The level the client sent, against the session's currently-bound model. |
| REST role create/update | `clampRoleThinking` in `src/server/server.ts` | The role's `thinkingLevel` field, against the role's `model` if set (or returned as-is if the role inherits, since the per-session clamp will run at spawn). |
| REST project/system prefs PUT | `/api/preferences` | Stored as-is (no write-time clamp): the defaults apply to many models and the resolved model may not be known yet. Clamping happens at use-time — see `resolveInitialThinkingLevel` / `tryApplyDefaultThinkingLevel` for sessions and `clampReviewThinking` for verification reviewers. |
| Session start | `resolveInitialThinkingLevel` + `tryApplyDefaultThinkingLevel` in `src/server/agent/session-manager.ts` | The role-or-default level, against the model resolved for that session (role override → global default → aigw fallback). |
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

## UI: reactive clamping when the model changes

The UI never invents its own rules — every selector imports
`getSupportedThinkingLevels` and `clampThinkingLevel` from
`src/shared/thinking-levels.ts`.

### Per-session footer (`src/ui/components/AgentInterface.ts`)

The footer dropdown computes its options from `state.model` every render,
so switching the session's model immediately reshapes the menu. The
ModelSelector callback also clamps `state.thinkingLevel` against the new
model and pushes the clamped value through `session.setThinkingLevel(...)`
— which round-trips through the WS `set_thinking_level` handler so the
server agrees with the client. The full-name label map in this file is the
single place to extend if a new level is added; `xhigh` is labelled "Extra
high" and `max` is labelled "Max".

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
  <level>` CLI flag at spawn (`src/server/agent/rpc-bridge.ts`) and the
  `set_thinking_level` WS message thereafter. The shared module changes the
  set of accepted values, not the transport.
- **Per-provider thinking-budget tuning** (`thinkingBudgets` in
  pi-agent-core) — a separate concern.

## Related docs

- [Per-role model & thinking-level overrides](internals.md#per-role-model--thinking-level-overrides)
  — how roles can pin model + level overrides, and how the cascade resolves
  them.
- [Spawn-time model pinning](internals.md#spawn-time-model-pinning) — how
  `resolveInitialThinkingLevel` injects the level into the agent CLI args at
  spawn so there's no boot-time race.
- [Pi 0.77 / Claude Opus 4.8 compatibility](pi-0.77-opus-4.8.md) — package,
  ranking, xhigh, spawn, transcript, and regression-test notes for the Pi
  upgrade.
