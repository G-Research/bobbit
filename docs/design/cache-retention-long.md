# Anthropic prompt-cache retention for spawned agent sessions

## Problem

pi (`@earendil-works/pi-coding-agent`, hard-pinned `0.79.6`) spawns as a
long-lived RPC subprocess per session (`src/server/agent/rpc-bridge.ts`). The
system prompt is written once at spawn/respawn time and never rewritten
per-turn (`--system-prompt <path>`, `rpc-bridge.ts:261`); Bobbit's own context
stratification keeps per-turn volatile content (recall, etc.) out of the
system prompt entirely, diverted to a hidden `custom` message instead
(`provider-bridge-extension.ts:236-252`). Within a session this makes the
whole ~30-60KB system+tool-docs prefix byte-stable turn to turn — a strong
foundation for Anthropic prompt caching.

But pi-ai's Anthropic provider defaults every cache breakpoint to a 5-minute
ephemeral TTL:

```js
// node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js:12-24
/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention, env) {
    if (cacheRetention) {
        return cacheRetention;
    }
    if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
        return "long";
    }
    return "short";
}
```

Bobbit's core team-lead pattern is *spawn, end turn, go idle, wake on
notification* (`defaults/roles/team-lead.yaml:403`). Inter-turn gaps
routinely exceed 5 minutes, so the cache expires between turns and the full
prefix gets re-billed as a cache **write** (not even a plain miss — pi-ai
caches by default) on every wake.

## Seam found: pi-native env var (no monkeypatch needed)

`resolveCacheRetention` reads `PI_CACHE_RETENTION` straight off the process
env via `getProviderEnvValue` (`node_modules/@earendil-works/pi-ai/dist/
utils/provider-env.js:38`, falls back to `process.env[name]`). Setting
`PI_CACHE_RETENTION=long` on the spawned pi-coding-agent subprocess's env
flips every ephemeral `cache_control` block pi-ai attaches — system prompt,
last tool def, last user-message block (`anthropic.js:666-943`) — to a 1h TTL
via `getCacheControl`:

```js
// anthropic.js:25-35
function getCacheControl(model, cacheRetention, env) {
    const retention = resolveCacheRetention(cacheRetention, env);
    if (retention === "none") {
        return { retention };
    }
    const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
    return {
        retention,
        cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
    };
}
```

The 1h ttl is only attached when `getAnthropicCompat(model)
.supportsLongCacheRetention` is true for the active model, so setting the env
var unconditionally is safe — pi-ai itself gates the TTL by model support.

Verified nothing in Bobbit or pi-coding-agent already sets `cacheRetention`
explicitly on the agent-turn path (only override anywhere in `src/` is
`model-completion.ts:177`'s `cacheRetention: "none"` for one-shot utility
completions — correctly scoped, and unaffected because `resolveCacheRetention`
always prefers an explicit param over the env var — see the first `if
(cacheRetention) return cacheRetention;` branch above). `pi-coding-agent`'s own
`dist/*.js` never references `cacheRetention` at all, so the value flows
through untouched from env var to the Anthropic request.

## What shipped

Config-only, no monkeypatch (this is squarely case 1 from the audit's "seam
preference order" — a native pi setting exists):

- `src/server/agent/cache-retention.ts` — `resolveCacheRetentionEnv(env)`
  resolves the `PI_CACHE_RETENTION` value for the spawned process with this
  precedence (highest first):
  1. `BOBBIT_CACHE_RETENTION` (Bobbit's knob, case-insensitive, trimmed):
     `short`/`none` → explicit `PI_CACHE_RETENTION=short` (pi-ai's env var
     only recognizes `"long"`, so any other value yields pi's short default;
     there is no env-level "none" tier — that only exists as an explicit
     per-request param, e.g. model-completion.ts). `long` → forces `long`.
     Unrecognized values are ignored and fall through.
  2. An operator-set `PI_CACHE_RETENTION` already present in the gateway's
     environment — propagated verbatim, never clobbered by the Bobbit
     default. (A gateway launched with `PI_CACHE_RETENTION=short` spawns
     agents with `short`.)
  3. Bobbit's default: `long`.

  Every branch returns an **explicit** value (never `{}`), for two reasons:
  the direct-spawn path in `rpc-bridge.ts` merges `process.env` first and
  `options.env` second, so an unconditional entry here would otherwise
  clobber the operator's inherited value; and the docker-exec sandbox path
  does *not* inherit the gateway's `process.env` at all — it only forwards
  allowlisted vars from `RpcBridgeOptions.env`, so inherited-value
  propagation must be explicit for both paths to behave identically.
- `src/server/agent/session-setup.ts` (`_resolveBridgeOptions`) spreads
  `resolveCacheRetentionEnv()` as the **lowest-precedence** entry in the
  bridge env, before caller `plan.env` and the gateway identity keys — so a
  caller (e.g. the verification harness, or a future per-session A/B
  toggle) can still override it per session.
- `src/server/agent/rpc-bridge.ts` (`spawnDockerExec`) forwards
  `PI_CACHE_RETENTION` via `docker exec -e`, mirroring the existing
  `BOBBIT_GOAL_ID` forwarding, so sandboxed sessions get the same default as
  host sessions.

Default is **ON** (opt-out via `BOBBIT_CACHE_RETENTION=short`, or by
launching the gateway with `PI_CACHE_RETENTION=short` — the operator-set
value flows through per the precedence rule above). Justification:
the mechanism is a pi-native, officially-documented-in-source env var (not a
patch), the blast radius is a pricing tradeoff rather than a correctness
change, and it is already scoped so it can never silently override an
explicit `cacheRetention` call site.

## Tradeoff / why it's not unconditionally beneficial

A 1h-retention cache **write** costs roughly 2x a 5-min write on Anthropic's
pricing (charged once, on the turn that (re)establishes the cache); reads are
priced the same regardless of TTL. The long TTL only nets a win once a
session takes more than roughly 2 turns/hour — for sessions that turn over
faster than every 5 minutes, the win is smaller (still non-negative, since a
5-min-fresh cache is unaffected either way) and for a session that's spawned
once and never revisited, the long-TTL write is pure added cost with no
matching read to amortize it against.

## A/B measurement gap (correction to the parent brief)

The parent brief for this work states "Bobbit already records
cacheWrite1h/cost telemetry ... so A/B is possible later." That is **only
partially true** as verified on `aj-current`:

- pi-ai's own `AssistantMessageEventStream` usage object does compute a
  `cacheWrite1h` field per assistant message
  (`node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js:352`:
  `output.usage.cacheWrite1h = event.message.usage.cache_creation
  ?.ephemeral_1h_input_tokens || 0;`).
- But Bobbit's own persisted usage/cost shapes
  (`src/server/agent/cost-tracker.ts`'s `UsageData`/`RawSessionCost`,
  `src/server/agent/session-manager.ts:4706-4707`) only carry the aggregate
  `cacheReadTokens` / `cacheWriteTokens` fields — there is no `cacheWrite1h`
  (or any 1h-specific) field threaded through Bobbit's cost ledger today. `rg
  cacheWrite1h src/` returns no hits outside `node_modules`.

So A/B'ing this change by TTL-write-cost alone isn't turnkey yet. To do the
A/B properly, a follow-up would need to either (a) thread `cacheWrite1h`
(and, ideally, the plain `cache_creation_input_tokens` vs
`ephemeral_1h_input_tokens` split) through the usage/cost pipeline into
`UsageData`, or (b) compare aggregate `cacheWriteTokens` cost trends across
sessions with `BOBBIT_CACHE_RETENTION=short` vs the new default, which is
noisier but requires no code changes. This doc flags the gap rather than
filling it — out of scope for this PR.

## Gap closed (W3.17): `cacheWrite1hTokens` now threaded through the cost ledger

Follow-up to the gap above. `RawSessionCost` / `UsageData`
(`src/server/agent/cost-tracker.ts`) now carry an additive
`cacheWrite1hTokens: number` counter, accumulated in `recordUsage` alongside
the existing `cacheReadTokens` / `cacheWriteTokens` totals, persisted to
`session-costs.json`, and included in every existing aggregation path
(`getGoalCost`, `getUnattributableLegacyCost`, `getAllCosts`). A derived
(NOT persisted — same pattern as `cacheHitRate`) `cacheWrite5mTokens` field
is exposed on `SessionCost` as `cacheWriteTokens - cacheWrite1hTokens`
(floored at 0).

**Field-name correction vs the parent brief's "cacheWrite5m" example**: re-
verifying `node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js`
(lines 350-352 and 489-514) shows pi-ai's Anthropic provider reads
`event.message.usage.cache_creation?.ephemeral_1h_input_tokens` into
`output.usage.cacheWrite1h` at `message_start` — but there is **no**
corresponding `ephemeral_5m_input_tokens` read anywhere in the file, and
`message_delta` never updates `cacheWrite1h` either (only `cacheWrite`/
`cacheRead`/`input`/`output` get delta updates). So `cacheWrite1h` is a real,
verified field on the wire; a literal "cacheWrite5m" is not — Anthropic's 5m
write cost is only recoverable as the complement of the total write minus
the 1h subset. Bobbit's new `cacheWrite5mTokens` is therefore modeled as a
derived field, not a persisted counter, to avoid implying a fidelity that
doesn't exist upstream.

This field flows automatically to every existing cost surface because those
surfaces already spread the full `SessionCost`/`RawSessionCost` object
rather than picking fields: `GET /api/sessions/:id/cost`,
`GET /api/sessions/:id/cost/breakdown`, `GET /api/goals/:id/cost`,
`GET /api/goals/:id/cost/breakdown` (`src/server/server.ts`), and the
`cost_update` WebSocket broadcast (`session-manager.ts`'s
`trackCostFromEvent` → `broadcast(session.clients, { ..., cost: cumulativeCost })`).
`src/server/ws/protocol.ts`'s `SessionCostSnapshot` type gained matching
optional fields, and `src/ui/components/CostPopover.ts`'s cost-breakdown
popover now renders a "1h TTL" / "5m TTL" sub-split under "Cache write" when
the server reports `cacheWrite1hTokens` (omitted entirely — no `0` row — on
older servers/persisted data that predate the field).

### How to run the A/B

1. Pick two comparable sessions/goals (similar task shape, similar total
   turns) — one that ran under the new `PI_CACHE_RETENTION=long` default,
   one launched with `BOBBIT_CACHE_RETENTION=short` (or from before this
   feature shipped).
2. Fetch `/api/goals/:id/cost/breakdown` (or `/api/sessions/:id/cost`) for
   each and compare `cacheWrite1hTokens` vs `cacheWrite5mTokens`:
   - The `short` session should show `cacheWrite1hTokens` at/near 0 (no long-
     TTL breakpoints requested) and its cache-write cost all attributed to
     `cacheWrite5mTokens`.
   - The `long` session's `cacheWrite1hTokens` share of `cacheWriteTokens`
     tells you how much write volume is riding the ~2x-cost 1h tier.
3. Compute the write-cost delta directly: 1h writes cost ~2x a 5m write at
   the same input-token rate, so the *added* cost from the long-TTL default
   is approximately `cacheWrite1hTokens * (per-token cache-write price)` (the
   extra half of the 2x sits entirely on the 1h-tagged tokens — the 5m-
   equivalent tokens would have cost the same either way).
4. Weigh that added write cost against the **read** savings the long TTL
   enabled: sum `cacheReadTokens` across the session's turns and compare
   against what a 5-min-TTL session's read count would likely have been
   (turns spaced >5 min apart would have missed the cache entirely under
   `short`, paying a fresh write instead of a read on every such turn — see
   "Tradeoff" section above for the >2-turns/hour breakeven heuristic).

## Verification performed

- Read `node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js` (pi-ai
  bundled inside the pinned `pi-coding-agent@0.79.6`) directly — confirmed
  `resolveCacheRetention`, `getCacheControl`, and all three `cache_control`
  attachment points (system block, last tool def, last user-message block)
  as quoted above.
- Read `node_modules/@earendil-works/pi-ai/dist/utils/provider-env.js` —
  confirmed `getProviderEnvValue` falls back to `process.env[name]` when no
  scoped `env` map is passed, so a plain subprocess env var works.
- Read `node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.js`
  and `proxy.js` — confirmed the harness also threads an explicit
  `cacheRetention` field through `applyStreamOptionsPatch` and a
  `before_provider_request` hook, i.e. there's a second, per-turn-patchable
  seam available for a future more granular (per-session/per-role) control
  if the blunt env var proves too coarse.
- `rg cacheRetention src/` (outside `node_modules`) — only hit is
  `model-completion.ts:177`'s `cacheRetention: "none"`, confirmed unaffected.
- `rg cacheWrite1h src/ tests/` — no hits, confirming the A/B gap noted above.
- Added `tests/cache-retention-env.test.ts`: config-plumbing tests pinning
  the full precedence rule (BOBBIT_CACHE_RETENTION > inherited
  PI_CACHE_RETENTION > default "long", all three cases plus both-set
  conflicts), source-anchored wiring checks for
  `session-setup.ts` / `rpc-bridge.ts` / `model-completion.ts`, and a
  patch-application-style guard that re-reads the installed pi-ai source and
  fails loudly if a future pi-ai bump changes the `PI_CACHE_RETENTION`
  contract this feature depends on.

## Gap note: 0.79.6 → later pi versions

This analysis and the shipped test are pinned against the exact
`@earendil-works/pi-coding-agent@0.79.6` bundled in `node_modules` (per
`package.json`). No newer version was inspected as part of this work — the
"patch-application" test in `tests/cache-retention-env.test.ts` will fail on
a version bump if the `resolveCacheRetention` contract changes shape, which
is the intended tripwire (re-verify this doc + the test before relaxing the
pin).
