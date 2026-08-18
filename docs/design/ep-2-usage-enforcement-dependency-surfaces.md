# EP-2 — Usage and enforcement dependency surfaces

**Status:** approved implementation design. **Scope:** two independently cherry-pickable, additive commits which precede EP-2 selectors and do not depend on EP-11. They expose authoritative post-turn telemetry and a generic budget-enforcement result reducer; neither selects a model, changes a prompt, spends money, nor alters a no-hook session.

## Decision and boundaries

`SessionManager.trackCostFromEvent()` is the sole existing authority for observed terminal usage. It consumes only a completed assistant `message_end` (or a completed compaction event, which is not a user turn) and reads Pi's `usage` object directly. The first commit reuses that event-local source; it does **not** read `CostTracker` back, estimate missing fields, or write a second cost ledger.

The second commit is a typed core reducer and application choke point for future budget consumers. A pack may advise a result only when its active decision hook has the existing exact EP-6 `decide` grant. The core, not the extension, validates, ranks, records, and applies the result. This is not a private Prompt Cache API and does not implement a budget/spending policy.

Out of scope for both commits:

- a private Prompt Cache API, cache policy, request shaping, or prompt mutation;
- a new cost/usage ledger, aggregate-cost readback, inferred tokens, inferred cost, or synthesized cache values;
- a spending limit, pricing table, hard-cap calculation, quota policy, or automatic retry policy;
- an EP-2 selector, model/thinking/workflow mutation, or direct extension apply callback;
- an EP-11 decision-request import, user-interruption implementation, or pause service;
- a change to the existing no-hook lifecycle, event ordering, terminal settlement, or provider failure behavior.

## Alternatives considered

### Commit 1

**CostTracker aggregate deltas (rejected).** Reading ledger totals before and after a turn is not an authoritative per-turn representation: CostTracker has no record when terminal cost is unknown, and its compaction entries (including retry-time compaction) can be attributed to a user turn incorrectly. A delta cannot preserve `telemetry: "known" | "unknown"` or distinguish omitted cache telemetry from reported zero. It also requires ledger fixtures rather than direct terminal-event tests.

**Inline parsing at `afterTurn` (rejected).** Parsing the terminal event again at the dispatch site duplicates alias and validation rules that `trackCostFromEvent()` needs, allowing cost and hook cache semantics to drift. The selected minimal composition instead reuses the `SessionManager.trackCostFromEvent()` seam through one pure `readTerminalAssistantUsage()` normalizer, the existing `turnTerminalHandled` exact-once guard, and `LifecycleHub.dispatch`. `cost-update-cache-hit.test.ts`, `pi-rpc-agent-end-retry.test.ts`, and `session-manager-lifecycle-dispatch.test.ts` protect those reused seams.

### Commit 2

**Per-consumer reducers (rejected).** Having every future consumer call `resolveExtensionGrant()` and implement fallback, severity, tie, and audit behavior would multiply denial and allow-on-silence defects. A core reducer is the single application contract and keeps every consumer's protected-operation outcome comparable.

**Capability-bearing Host API (rejected).** A `host.budget.enforce()`-style API or extension `apply()` callback would let a pack apply the result, invert the trust boundary, and make an in-flight revocation difficult to fail closed. It also trends toward the excluded private Prompt Cache API. The selected composition reuses `resolveExtensionGrant()` for exact `decide` authorization and `ContextTraceStore` for bounded/redacted audit, protected by `extension-capability-grants.test.ts` and `context-trace-store.test.ts`.

### Defect surfaces and selection

| Surface | Ownership and containment |
|---|---|
| `turn-usage.ts` | New pure, stateless normalizer; no dependency, persistence, or worker. |
| `SessionInfo.terminalTurnUsage` | SessionManager-owned ephemeral state, cleared on `agent_start`, copied at final `agent_end`, and never persisted. It exists only when a `lifecycleHub` is present. |
| `TurnUsageSnapshot` / optional `HookCtx.usage` | Additive public API; compatibility is preserved by omission outside gateway `afterTurn`. |
| `budget-enforcement.ts` | New pure, stateless reducer; no dependency, persistence, or worker. |
| Fixed trace reason | One bounded metadata constant through existing trace storage and sanitization. |

There are zero new dependencies, persistence formats, workers, ledgers, or extension Host APIs. This is the smallest design that satisfies the required same-terminal-data snapshot and core-owned choke point: aggregate deltas lose telemetry fidelity, inline/per-consumer logic duplicates correctness-sensitive behavior, and a Host API weakens the application-time authorization boundary.

## Commit 1 — authoritative `afterTurn` usage snapshot

### Public contract

Add these exported types in `src/server/agent/lifecycle-hub.ts` and add `usage?: TurnUsageSnapshot` to `HookCtx`.

```ts
/** Direct, per-turn terminal telemetry; never a derived CostTracker value. */
export type TurnUsageSnapshot =
  | {
      telemetry: "known";
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cost?: number;
      /** Present only when the active runtime provides a verified pair. */
      provider?: string;
      modelId?: string;
    }
  | { telemetry: "unknown" };

export interface HookCtx {
  // Existing fields unchanged.
  /** Present for gateway-dispatched afterTurn only. */
  usage?: TurnUsageSnapshot;
}
```

`telemetry: "known"` means a terminal assistant usage object was observed for this turn. It does **not** claim every field was supplied. Each optional numeric field is an authoritative value only when Pi supplied a finite, non-negative number under either supported spelling:

| Snapshot field | Pi source, in order |
|---|---|
| `inputTokens` | `usage.inputTokens`, `usage.input` |
| `outputTokens` | `usage.outputTokens`, `usage.output` |
| `cacheReadTokens` | `usage.cacheReadTokens`, `usage.cacheRead` |
| `cacheWriteTokens` | `usage.cacheWriteTokens`, `usage.cacheWrite` |
| `cost` | numeric `usage.cost`, numeric `usage.cost.total` |

An absent field remains absent. In particular, absent cache telemetry is **unknown**, not `0`; omitted cost is unknown, not free; and an explicitly reported `0` remains `0`. Invalid, negative, non-finite, or object-shaped token values are absent. `provider` and `modelId` appear only as a complete, verified pair from the active runtime/session model state at the terminal event; a configured default, a guessed provider, or a partial pair is omitted. `telemetry: "unknown"` carries no numeric or attribution fields.

The property is optional for compatibility and is never populated for `sessionSetup`, `beforePrompt`, `beforeCompact`, or `sessionShutdown`. Every gateway `afterTurn` dispatch receives it: `known` if the final assistant terminal emitted a usable `usage` container, otherwise `unknown`. Existing provider source that ignores it remains valid.

### Single source of truth and event flow

Add `src/server/agent/turn-usage.ts` as a small pure normalizer, exported only to server code:

```ts
export function readTerminalAssistantUsage(
  event: unknown,
  attribution?: { provider?: string; modelId?: string },
): TurnUsageSnapshot | undefined;
```

It returns `undefined` unless `event` is an assistant `message_end` with a `usage` container. It owns the field aliases and validation above. `SessionManager.trackCostFromEvent()` calls this normalizer for its assistant-message path, records usage only when `telemetry === "known"` and `cost` is present, and keeps its existing compaction branch on the same normalizer with no `afterTurn` exposure. Thus the cost tracker and hook snapshot consume the same terminal wire data and cannot drift over aliases or cache semantics.

`src/server/agent/session-manager.ts` adds a **non-persistent per-live-turn slot** to `SessionInfo`, for example `terminalTurnUsage?: TurnUsageSnapshot`. It is not a ledger, is never written to `SessionStore`, `CostTracker`, WebSocket frames, JSONL, traces, or API responses, and holds only the normalized snapshot for the current final assistant turn.

The event order remains:

```text
assistant message_end with usage
  → existing lifecycle/error classification
  → readTerminalAssistantUsage() shared with trackCostFromEvent()
  → record CostTracker only if authoritative cost exists
  → retain normalized snapshot in the current live turn
final agent_end (willRetry !== true)
  → existing exact-once terminal guard and completed-turn increment
  → copy/freeze snapshot or { telemetry: "unknown" }
  → void LifecycleHub.dispatch("afterTurn", { ..., usage })
  → existing idle/queue settlement
```

The current `subscribeToEvents()` pipeline calls `handleAgentLifecycle()` before `trackCostFromEvent()`. The snapshot slot is therefore populated on the preceding terminal assistant event and read only at the final `agent_end`. Restore, external-session, role-replacement, and abort-replacement listeners already route through the same `trackCostFromEvent()` seam; all must use the shared normalizer and the same live-turn slot rather than duplicating parsing.

Compaction `result.usage` remains observable by the cost tracker exactly as it is today, including when `willRetry: true`; it must never overwrite or become an `afterTurn` usage snapshot. This prevents summarizer spend from being misattributed to the surrounding user turn.

### Terminal, retry, error, abort, and no-hook semantics

- `agent_start` clears the live-turn slot before a new turn can produce telemetry.
- A retryable `agent_end` (`willRetry: true`) neither dispatches `afterTurn` nor clears/settles the final-turn snapshot. A later final terminal dispatches once with the final attempt's snapshot.
- `turnTerminalHandled` remains the one exact-once guard. A duplicate or late final `agent_end` cannot dispatch another hook, emit another snapshot, or consume the next turn's slot.
- A terminal error or abort follows the existing `afterTurn` behavior: it still dispatches once, with `known` only if its final assistant terminal supplied usage; otherwise `unknown`. This commit does not redefine what counts as a completed turn.
- During restore/replay (`restoring === true`) events remain excluded from normal lifecycle and cost tracking, so replay cannot manufacture an `afterTurn` snapshot or double-account usage.
- If `lifecycleHub` is absent, no hook dispatch occurs and the pre-existing cost path, client events, queue/idle behavior, and persisted state stay unchanged. Slot clear/write/read logic is conditional on a lifecycle hub; no slot is allocated merely to expose a public API with no hook consumer, so this case has no externally observable behavior change.
- Dispatch remains fire-and-forget and error-swallowing. The usage addition must not await a hook, alter provider timeouts, or delay final terminal settlement.

### Files and focused tests

| Path | Change |
|---|---|
| `src/server/agent/turn-usage.ts` | New shared pure terminal-usage normalizer. |
| `src/server/agent/lifecycle-hub.ts` | Export `TurnUsageSnapshot`; add optional `HookCtx.usage`. |
| `src/server/agent/session-manager.ts` | Current-turn ephemeral snapshot, final dispatch copy, and shared cost extraction. |
| `src/server/agent/session-setup.ts` | Use the same `trackCostFromEvent()`/normalizer path; no new hook behavior. |
| `tests2/core/turn-usage.test.ts` | Alias mapping, finite validation, known/unknown state, omitted cache vs reported zero, cost aliases, and complete-only attribution. |
| `tests2/core/session-manager-lifecycle-dispatch.test.ts` | Known snapshot reaches one final `afterTurn`; duplicate terminal, error, abort, retry, and no-hub paths preserve exact-once/no-op behavior. |
| `tests2/core/pi-rpc-agent-end-retry.test.ts` | Compaction usage remains cost-only and never becomes the final user-turn snapshot. |
| `tests2/integration/cost-update-cache-hit.test.ts` | Existing cost wire semantics still map explicit cache tokens without treating absent cache fields as zero. |

Register added tests in `tests2/tests-map.json`. The focused command is:

```bash
npx vitest run tests2/core/turn-usage.test.ts tests2/core/session-manager-lifecycle-dispatch.test.ts tests2/core/pi-rpc-agent-end-retry.test.ts tests2/integration/cost-update-cache-hit.test.ts --config vitest.config.ts --retry=0
```

### End-to-end validation

Add a real scripted `afterTurn` hook pack in the established E2E/manual-integration tier, run a session turn with terminal usage, and assert that the pack observes `ctx.usage.telemetry === "known"` and the reported terminal token fields through the live LifecycleHub/worker path. Run a no-hook control session and assert its existing events and cost row remain unchanged. This catches wiring failures that pure normalizer or direct-dispatch tests cannot.

## Commit 2 — grant-gated budget enforcement result choke point

### Public contracts

Add `src/server/agent/budget-enforcement.ts`. It is a core-only contract: it accepts server-derived hook identity and trusted core operation facts; no pack receives a direct `apply()` callback or a capability-bearing Host API method.

```ts
import type { ExtensionHookRef, ExtensionGrant } from "./project-config-store.js";
import type { ResolvedHook } from "./extension-grant-policy.js";

export const BUDGET_ENFORCEMENT_DISPOSITIONS = [
  "allow", "warn", "pause", "halt",
] as const;
export type BudgetEnforcementDisposition =
  typeof BUDGET_ENFORCEMENT_DISPOSITIONS[number];

/** A normalized candidate; source identity is attached by core, not trusted input. */
export interface BudgetEnforcementProposal {
  disposition: BudgetEnforcementDisposition;
  ruleId: string;       // safe identifier, 1..128 chars
  reasonId?: string;    // safe identifier, 1..128 chars; never free-form prose
}

export interface BudgetEnforcementCandidate {
  source: ExtensionHookRef;
  proposal: unknown;
}

/** Trusted core facts about an operation already at an application choke point. */
export interface BudgetEnforcementRequest {
  sessionId: string;
  projectId?: string;
  goalId?: string;
  consumerId: string;   // safe core-owned operation family id
  operationId: string;  // safe per-attempt correlation id, not a secret
  /** Mandatory: silence cannot become an implicit allow. */
  fallback: BudgetEnforcementDisposition;
  /** A classification tag only; no amount, limit, or pricing input is accepted. */
  hardCapOverride?: "core-hard-cap";
}

export interface BudgetEnforcementAudit {
  hookId?: string;
  disposition: BudgetEnforcementDisposition;
  ruleId?: string;
  reasonId?: string;
  grantDenied: number;
  malformed: number;
}

export interface BudgetEnforcementResult {
  disposition: BudgetEnforcementDisposition;
  /** `halt` always means deny the current protected operation. */
  permitsOperation: boolean;
  /** EP-11 can consume this later without an EP-11 import today. */
  consent: "not-required" | "hard-cap-override";
  audit: BudgetEnforcementAudit;
}

export function resolveBudgetEnforcement(
  request: BudgetEnforcementRequest,
  activeHooks: readonly ResolvedHook[],
  grants: readonly ExtensionGrant[],
  candidates: readonly BudgetEnforcementCandidate[],
): BudgetEnforcementResult;
```

`fallback` is mandatory and validated. It is selected explicitly by the existing core consumer; `resolveBudgetEnforcement()` has no default argument and never turns no candidates, a worker failure, an inactive hook, a revoked/missing grant, or a malformed proposal into `allow`. A consumer that has a pre-existing safe continuation may deliberately pass `fallback: "allow"`; a hard-cap/override choke point passes `fallback: "halt"` until an authorized future consent result exists. That makes compatibility policy visible at the call site rather than implicit in a reducer.

`halt` is the generic terminal outcome: `permitsOperation` is false and the caller must deny the current operation. `pause` is also non-permissive until the consumer has invoked its own core-owned pause mechanism; this commit neither writes `goal.paused` nor resumes work. `warn` and `allow` permit only an operation whose existing core ceilings already allow it. No proposal may broaden tool policy, role policy, grants, or an independently enforced hard cap.

### Authorization, validation, and deterministic resolution

For each candidate, the core must:

1. validate `source.packId`/`source.hookId`, `consumerId`, `operationId`, `ruleId`, and `reasonId` against the EP-6 safe-identifier bound (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`); drop all free-form reason text, amounts, prompts, model output, credentials, and request payloads;
2. call the existing pure `resolveExtensionGrant(activeHooks, grants, source, "decide")` immediately before accepting the proposal; inactive, malformed, missing, or revoked grants cannot supply an outcome;
3. validate the exact disposition vocabulary; and
4. rank only accepted candidates by severity: `halt > pause > warn > allow`.

The highest severity always wins; therefore a granted halt/deny wins every allow. Ties choose the audit identity deterministically by configured active-pack priority (higher priority first), then lexical `packId`, lexical `hookId`, lexical `ruleId`, then lexical `reasonId` with absent sorted last. Pack priority only determines attribution among equal dispositions; it can never override a more restrictive result. The resolver returns a fresh, immutable result and does not retain candidates or grants.

No accepted proposal uses the extension's reason text. The bounded `ruleId`/`reasonId` are stable metadata labels, not a human explanation. If a candidate is denied at the grant boundary, its proposal is not considered; the aggregate audit retains only the bounded count, not a source, body, or raw error.

### Application choke point and future EP-11 composition

A future budget consumer owns invocation of its applicable active decision hooks through the existing `LifecycleHub`/`ModuleHost` worker path, attaches server-derived `ExtensionHookRef`, and calls `resolveBudgetEnforcement()` at its one pre-dispatch or override application point. It resolves the EP-6 grant immediately before invocation and again immediately before core applies the returned result. A revocation while a worker is in flight therefore fails closed at application time.

This commit adds no general hook executor and invokes no declared hook by itself. It supplies the shared proposal validation/resolution/apply boundary that concrete consumers must use. It must not expose a `host.budget`, `host.promptCache`, raw gateway fetch, or arbitrary extension route.

A trusted existing cap evaluator may set `hardCapOverride: "core-hard-cap"`; this surface neither computes that fact nor sees the cap, price, token count, or user answer. The resolver returns `consent: "hard-cap-override"` independent of the extension outcome. Before EP-11 exists, the calling hard-cap override path maps that state to its explicit `fallback: "halt"` and denies. Once EP-11 lands, its classifier may consume the tag and obtain consent, then retry the same core choke point; it still rechecks grants, policy, and cap facts. This preserves EP-11's hard-cap-consent floor without importing EP-11 or creating an allow-on-silence path.

### EP-5 metadata-only audit

`ContextTraceStore` remains the only activity trace. Do not add a budget audit database, a cost ledger, or a raw proposal record. The consumer appends a bounded core-owned `TraceOutcomeRow` after resolution, using the existing trace sanitizer:

- granted `allow`/`warn` resolved as a core action: `kind: "decision"`, `outcome: "applied"` or `"advised"` as appropriate, and only the selected safe `ruleId` as `value`;
- `pause`/`halt`: `kind: "decision"`, `outcome: "denied"`, with a fixed core reason label added to `TRACE_OUTCOME_REASONS` (for example `"Budget enforcement"`), never the extension reason;
- grant rejection: `outcome: "denied"`, `reason: "Grant required"`;
- malformed/unavailable result: `outcome: "dropped"`, `reason: "Malformed result"` or `"Unavailable value"`.

The trace receives the hook id only when that hook's accepted proposal was selected; rejected sources are represented by counts internal to the reducer, not durable identities. It contains no token quantities, costs, cap values, prompt/cache contents, operation payload, free-form rule/reason, provider credential, model transcript, or consent answer. Existing 50-row/2 MiB trace bounds and read-time sanitization remain authoritative.

### Files and focused tests

| Path | Change |
|---|---|
| `src/server/agent/budget-enforcement.ts` | New pure proposal validation, EP-6 grant check composition, restrictive reducer, explicit fallback, and audit projection. |
| `src/server/agent/lifecycle-hub.ts` | Export only any narrow server-side dispatch helper needed by a future consumer; do not change provider/no-hook dispatch behavior. |
| `src/server/agent/context-trace-store.ts` | Add only the fixed core metadata reason needed for budget enforcement, retaining bounds/redaction. |
| `src/server/agent/extension-grant-policy.ts` | Reuse as-is for exact `decide` resolution unless a type-only export is required. |
| `tests2/core/budget-enforcement.test.ts` | Missing/revoked/inactive grants; malformed candidates; explicit fallback; conflict matrix; deterministic ties; halt and pause fail closed; hard-cap tag with no EP-11 import; immutable/secret-free results. |
| `tests2/core/context-trace-store.test.ts` | New fixed reason stays bounded and strips raw rules/reasons, cap values, and secrets. |
| `tests2/integration/extension-capability-grants.test.ts` | Live grant then revocation around a simulated worker result denies re-application; no restart and no hidden allow. |

Register added tests in `tests2/tests-map.json`. The focused command is:

```bash
npx vitest run tests2/core/budget-enforcement.test.ts tests2/core/context-trace-store.test.ts tests2/integration/extension-capability-grants.test.ts --config vitest.config.ts --retry=0
```

### End-to-end validation

This commit intentionally has no live consumer and invokes no hook itself. Its current end-to-end journey proxy is `tests2/integration/extension-capability-grants.test.ts`: a live grant permits a simulated worker result, mid-flight revocation denies core re-application without restart, and no hidden allow is introduced. The full real worker-to-consumer journey is deferred to the first concrete budget consumer; this dependency surface must not invent one merely for validation.

## Delivery and compatibility

Delivered separately, in this order:

1. `feat: expose authoritative after-turn usage snapshot` — public interface: `TurnUsageSnapshot` and optional `HookCtx.usage`; goal-branch commit `50402da048756e05f2da119782f9b3b293a71486`.
2. `feat: add grant-gated budget enforcement reducer` — public interface: `BudgetEnforcementProposal`, `BudgetEnforcementRequest`, `BudgetEnforcementResult`, and `resolveBudgetEnforcement()`; goal-branch commit `eacd5b7b9b644415ba7e15ab6639a33a6d3e5c2b`.

Each commit compiles and passes its listed tests independently; commit 2 does not require commit 1. The recorded SHAs support clean cross-parent cherry-picks in this order. Neither commit opens a PR to `main`.
