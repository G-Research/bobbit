# Per-model thinking-level capabilities

The "thinking level" picker controls how much reasoning effort the underlying
model spends before answering. Not every model supports every level — Opus 4.8
exposes an extra `xhigh` step, plain `gpt-4` exposes none — and the set of
levels has to stay consistent across UI selectors, REST endpoints, the
WebSocket boundary, and the verification harness.

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

Adding `xhigh` upstream would have meant editing all of them. Worse, the
duplication had already drifted: picking an xhigh-capable Opus model in
Bobbit silently capped the user at `high` because the server's value table
never knew `xhigh` existed, and the settings page offered `minimal` on models
that don't support it.

The shared module collapses every capability decision to one function and
one clamping rule. When upstream model metadata includes a per-model
`thinkingLevelMap`, Bobbit now consumes that directly for `xhigh` support;
only sparse payloads still rely on the fallback family regex.

## The canonical set

```ts
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
```

Ranked low→high. `off` is always supported (the model just doesn't reason).
`xhigh` is the recent addition for Opus 4.6+ (including Opus 4.8) and certain
gpt-5.1/5.2 models.

The canonical `ThinkingLevel` type, the `ModelLike` shape consumed by
capability detection, and the helpers below all live in
`src/shared/thinking-levels.ts` and are imported by both the server
(`src/server/`) and the UI (`src/app/`, `src/ui/`).

## Capability rules

`getSupportedThinkingLevels(model)` returns the subset valid for the given
model:

| Model trait | Returned levels |
|---|---|
| `reasoning === false` | `["off"]` |
| `reasoning !== false` and `supportsXHigh(model)` | `off, minimal, low, medium, high, xhigh` |
| `reasoning !== false` otherwise | `off, minimal, low, medium, high` |

`supportsXHigh(model)` now resolves in two stages:

1. **Metadata first**: if the model carries upstream `thinkingLevelMap`,
   `xhigh` is supported iff that map has a non-null `xhigh` entry. This lets
   newly-added families (for example GPT-5.4 / GPT-5.5) light up
   automatically without a Bobbit code change.
2. **Fallback heuristic** for sparse payloads: when `thinkingLevelMap` is
   absent, Bobbit falls back to family matching.

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
the cross-provider-collision case in `tests/thinking-levels.test.ts`.

## Clamping, not rejection

`clampThinkingLevel(level, model, opts?)` is the validate-or-degrade entry
point. Unsupported levels step **down** by rank until a supported level is
found:

```
xhigh → high → medium → low → minimal → off
```

`off` is always supported, so the walk always terminates. Concretely:

- `xhigh` on Sonnet 4.6 (no xhigh) clamps to `high`.
- `xhigh` on a non-reasoning model (e.g. Haiku) clamps all the way to `off`.
- Unknown strings (`"weird"`, stale tokens from old prefs) are normalised to
  `off` first, then clamped — which yields `off` on any model.
- An empty/undefined level with `opts.allowEmpty: true` returns `undefined`
  (the "inherit" sentinel used by role overrides and prefs).

Clamping rather than rejecting was a deliberate choice. The same preference
key (`default.sessionThinkingLevel`) is consulted across many sessions; a
user might set `xhigh` while Opus 4.7 is their default, then later change
the role's model to one that doesn't support it. Rejecting would either:

- silently drop the preference (lose the user's intent the moment they
  switch models), or
- error out and block the session from starting (refuse to run a session
  because of a stored preference).

Clamping does neither — the user's `xhigh` preference is preserved in
storage, and at session start it is degraded to the best level the resolved
model can actually run. If they switch back to Opus 4.7, `xhigh` is honoured
again. The behaviour mirrors pi-mono's "Fixed adaptive thinking … clamped
unsupported xhigh effort values to supported levels" fix.

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
high".

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

Three layers pin the behaviour:

| Test | What it pins |
|---|---|
| `tests/thinking-levels.test.ts` | Capability matrix for Opus 4.5/4.6/4.7/4.8, dotted Opus ids, AIGW-routed Opus ids, Sonnet 4.6, gpt-5/5.1/5.1-codex-max/5.2, non-reasoning models, clamping behaviour, and the cross-provider-collision pin (an `openai`-provider model with a `claude-*` id does not light up xhigh). |
| `tests/thinking-levels-per-model.{html,spec.ts}` | Fixture-based browser tests that exercise a minimal HTML page mirroring the selector logic. The HTML mirror is annotated to stay in sync with the canonical module. |
| `tests/e2e/ui/thinking-levels.spec.ts` | Gateway-connected E2E specs that switch model in the footer, assert dropdown options change, persist `xhigh` across reload on xhigh-capable Opus, and verify the clamp-on-model-switch flow end to end. |

The unit suite is the authoritative spec — if a behaviour isn't pinned
there, the rule isn't real. The fixture and E2E layers prevent regressions
in the wiring between the shared module and the UI / server boundary.

## Out of scope

- **Adding levels beyond `off|minimal|low|medium|high|xhigh`** is upstream's
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
