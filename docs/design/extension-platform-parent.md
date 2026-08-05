# Extension Platform — Parent Integration Design

## Decision

Finish the platform on the parent integration branch as **declared, observable, advisory extensions first; core-applied and explicitly granted changes second**. Reuse the existing pack registry, lifecycle hub, trace store, Marketplace configuration, and typed Host API. Do not add a parallel loader, scheduler, permission system, trace store, or runtime-specific hook path.

The worker/module host remains resource/crash isolation for *trusted* pack code; hook grants constrain only what **core will apply**. They do not claim to sandbox a malicious pack's ambient host process access.

## Scope ledger

| In scope | Explicitly out of scope |
|---|---|
| Schema-2 hook metadata, lifecycle context, extension advice, cadence, core-applied decisions/mutations, per-project grants/audit, settings, staff proposals, skill/MCP adoption, dynamic capability selection, and the service-extension lifecycle contract. | A pack schema bump; a raw gateway/host escape hatch; auto-applying staff proposals; wall-clock scheduling; dynamic creation of skills/MCPs/tools; a new agent runtime; a LangFlow implementation; moving Hindsight's existing provider implementation; a general OS capability sandbox. |
| Parent integration of #1105 and #1107, retaining their tests. | Merging individual slices to `main`, or deleting the source PR branches before their tested commits are absorbed. |

## Baseline and composition

Already present and not rebuilt:

- `src/server/agent/pack-contributions.ts` parses and validates schema-2 `hooks/*.yaml`; `src/server/extension-host/pack-contribution-registry.ts::listHooks()` activation-filters and exposes **inert** metadata.
- `src/server/agent/lifecycle-hub.ts` dispatches providers through `ModuleHost`, applies block budgets, and writes `ContextTraceStore` rows. `HookCtx.scopeContext` is the bounded, project-safe lifecycle context.
- `src/server/agent/session-setup.ts`, `src/server/server.ts`, and `src/server/agent/session-manager.ts` are the existing session-setup, pre-prompt/pre-compaction, and post-turn/shutdown dispatch boundaries.
- `src/server/agent/project-config-store.ts` owns `pack_order` and `pack_activation`; per-project priority is therefore configuration, not a new resolver.
- `src/shared/extension-host/host-api.ts` is additive-only and has no raw gateway fetch surface.

The selected design extends these owners. A new hook runner or a second trace/grant store would duplicate activation, timeout, persistence, ordering, and authorization semantics; direct extension mutation would bypass the single audit/apply point. Neither is acceptable.

## Slice DAG and delivery order

`EP-2b` is the eleventh named slice in the EP-1…EP-11 programme, despite its historical suffix.

| Slice | Deliverable | Depends on | Parent handling |
|---|---|---|---|
| EP-1 | Hook declarations, validation, filtering, existing lifecycle events/budgets. | — | Landed baseline; audit only. |
| EP-2b | Rich, project-safe hook scope context. | EP-1 | Landed baseline; retain its compatibility tests. |
| EP-5 | Read-only Context inspector and persisted/live trace visibility. | EP-1 | Absorb #1107 first; preserve all tests. |
| EP-6 | Per-project capability grants, revoke audit, and inert ungranted decide hooks. | EP-1, EP-5 | Required before core applies extension decisions or mutations. |
| EP-2 | Typed model/thinking/role/workflow proposals; advisory display before granted application. | EP-5, EP-6 | Thinking level is the first extracted consumer. |
| EP-3 | Every-N-turn, fire-and-forget advisory helpers. | EP-5, EP-6 | No clock timers. |
| EP-9 | Adopt stock MCP and Claude-style skills. | EP-1 | Absorb #1105; may proceed in parallel with EP-5/6. |
| EP-4 | Granted request shaping and tool-call safety proposals. | EP-2, EP-5, EP-6 | Core validates/applies; prompt shaping defaults off. |
| EP-10 | Query-selected capabilities: `selectSkills`, then `selectMcp`. | EP-6, EP-9 | Activate installed/permitted assets only; pin a selection per session. |
| EP-7 | Marketplace settings, config schema rendering, project enable/disable, grant UI. | EP-6 | Secret values are write-only. |
| EP-8 | Staff proposals plus the separately committed service-extension lifecycle contract. | EP-3, EP-6, EP-7 | All proposals require approval; publish the service commit for Hindsight cherry-pick. |

```text
EP-1 → EP-2b
EP-1 → EP-5 → EP-6 → EP-2 → EP-4
                 ├──────→ EP-3 ───→ EP-8
                 ├──────→ EP-7 ───→ EP-8
                 └──────→ EP-10
EP-1 → EP-9 ─────────────→ EP-10
```

EP-5 and EP-6 intentionally precede any applied behavioural change. EP-9 is independent adoption work, but its product UI is reconciled with EP-7 before the parent scenario.

## Contracts and data flow

### Hook execution and traces

Extend the normalized `HookContribution` in `src/server/agent/pack-contributions.ts` only as each event needs fields; preserve its existing `id`, `events`, `mode`, `capabilities`, `budget`, `config`, `activation`, `listName`, `sourceFile`, and `packRoot` fields. `PackContributionRegistry` remains the sole activation/precedence lookup.

`LifecycleHub` owns all execution. For an event it must resolve the active pack list once, form an immutable `HookCtx`, invoke with the existing `ModuleHost` deadline, validate the returned typed proposal, record an outcome, and return control to core. A hook never receives a mutable `SessionInfo`, raw request object, or an apply callback.

Additive trace shape, owned by `src/server/agent/context-trace-store.ts`:

```ts
type TraceOutcome = "advised" | "applied" | "denied" | "dropped" | "error" | "superseded";
type TraceOutcomeKind = "decision" | "advisory" | "audit";
type TraceOutcomeEvent = "sessionSetup" | "beforePrompt" | "afterTurn"
  | "beforeCompact" | "sessionShutdown";
type TraceOutcomeReason = "Grant required" | "User pin" | "Unavailable value"
  | "Malformed result" | "Timed out";

interface TraceOutcomeRow {
  kind: TraceOutcomeKind;
  hookId: string;
  event: TraceOutcomeEvent;
  outcome: TraceOutcome;
  reason?: TraceOutcomeReason;
  value?: string;
  ms?: number;
}
interface TraceEntry {
  // existing fields unchanged
  outcomes?: TraceOutcomeRow[];
}
```

`outcomes` is optional and remains nested in its lifecycle entry, so legacy rows remain readable and
pagination cannot separate activity from the event that produced it. Only the core validation,
grant, or application owner emits an outcome row after validation or resolution; extension code may
propose but cannot claim that a value was applied. EP-2 through EP-4 append to this existing
`outcomes` envelope, never to `TraceProviderRow` and never to a second audit stream.

Before persistence, and again when reading/normalizing, the store retains at most 50 valid outcome
rows per entry. `hookId` and an eligible `value` must be bounded safe identifiers
(`/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`); `kind`, `event`, `outcome`, and `reason` must be exact
members of the enums above; and `ms` must be a finite, non-negative integer capped at
1,000,000,000. Invalid outcome rows are omitted. `value` is retained only for `advised`, `applied`,
or `superseded`, and only after core has selected a safe identifier; it is omitted for denied,
dropped, error, unsafe, or unavailable proposals.

Reasons are fixed core-owned labels, not extension prose. The schema excludes context blocks,
prompts, tokens, secrets, raw provider errors, stacks, paths, provider configuration, tool
arguments or patches, request/response bodies, and free-form rationale. The canonical wire contract
and endpoint behavior are documented in [Context trace endpoint](../rest-api.md#context-trace-endpoint).
#1107 supplies the persisted inspector, bounded REST read, and metadata-only WebSocket invalidation.

### Advisory decisions and application

EP-2 introduces a typed proposal, not an extension-owned selection:

```ts
type DecisionEvent = "selectModel" | "selectThinking" | "selectRole" | "selectWorkflow";
interface DecisionProposal {
  value: string;                 // must be in core-provided available values
  confidence: number;            // 0..1, compared only within one pack
  reason: string;
}
```

Core supplies current/available values and validates the response. In advisory mode, it writes `advised` and changes nothing. With the matching EP-6 grant, core resolves one proposal, clamps/validates it at the existing owner (notably `src/server/agent/thinking-level-clamp.ts` for thinking), applies it at the existing session/goal selection boundary, and writes `applied`. Explicit user/operator pins always win.

### Cadence and staff

EP-3 persists/recovers a monotonic per-session completed-turn count using the existing session state, then schedules a due `everyNTurns` invocation immediately after the existing non-blocking `afterTurn` dispatch in `src/server/agent/session-manager.ts`. It is fire-and-forget, has one in-flight invocation per `(session, hook)`, and drops rather than queues overlap. Compaction does not reset it; a resumed session continues from its persisted count. An advisor may return an advisory/trace row only.

EP-8 consumes this path and existing proposal owners under `src/server/proposals/` and their UI. It may create a proposal record only; approval/rejection remains the existing user flow and each disposition is trace/audit-visible.

### Grants, precedence, and hard denial

EP-6 adds a native, per-project configuration record through `ProjectConfigStore`:

```ts
interface ExtensionGrant {
  hookId: string;
  capability: string;
  grantedAt: string;
  grantedBy: string;
}
```

The server owns write validation, audit rows, revoke, and cache invalidation; the Market UI only requests them. A missing grant is deny-by-default. Revocation takes effect for the next resolution without process restart. The grant surface gates core application only and must be visibly distinct from pack activation.

Resolution is deterministic:

1. Inactive pack/entity, malformed result, unavailable value, ungranted capability, or user/operator pin: no application; record why.
2. Within a pack, highest valid confidence wins; ties use stable hook id order.
3. Across packs, configured project `pack_order` priority breaks the tie; the highest-priority pack wins deterministically.
4. For tool safety, validate all granted verdicts and apply the most restrictive result: `deny > warn > allow`. A granted hard deny wins over every allow, cannot alter unrelated tools, and records its reason.
5. Existing role/group/tool policy remains a ceiling. An extension cannot activate an asset or allow a tool the owner policy denies.

EP-4 proposals are similarly core-applied:

```ts
interface PromptShapeProposal { text: string; reason: string; intent: "clarify" | "compress" | "redact" | "augment"; }
interface ToolSafetyProposal { decision: "allow" | "warn" | "deny"; reason: string; argumentPatch?: Record<string, unknown>; }
```

Core rejects over-size/invalid prompt replacements, schema-invalid argument patches, and secret-bearing trace values. Prompt shaping is disabled unless the project explicitly grants and enables it. This is also the request-shaping surface used by Prompt Cache/Budgets; it remains additive and separately committed.

### Dynamic capabilities and vanilla adoption

EP-9 must be absorbed from `goal/adopt-vanilla-31dc10da` / #1105, preserving its durable adoption ledger and adapters at `src/server/agent/adopted-extensions.ts`, `src/server/skills/adopted-skill-entries.ts`, `src/server/skills/slash-skills.ts`, and the existing MCP manager path. It adds no pack-authored wrapper and no implicit mutation permission.

EP-10 adds `selectSkills` first, then `selectMcp`:

```ts
interface CapabilityProposal { add: string[]; omit?: string[]; reason: string; confidence: number; }
```

Core intersects `add` with installed, active, permitted assets; intersects `omit` only with optional assets; records the result; and persists the selected set against the session for reproducibility. It invokes selection before `resolveSkillExpansions` / skill activation, and only later before the existing MCP proxy/activation path. It cannot invent an id, defeat a denial, or broaden `computeEffectiveAllowedTools()`.

### Service-extension lifecycle surface

EP-8 publishes this as an **early, standalone additive commit** immediately after its dependencies, so `goal/hindsight-serv-35f56c0e` can cherry-pick it without taking staff proposals. The generic record is extension configuration, not a Hindsight-specific manager:

```ts
type ServiceRunMode = "local" | "docker" | "compose";
interface ServiceExtensionSpec {
  id: string; runMode: ServiceRunMode;
  readiness: { url?: string; command?: string; timeoutMs: number };
  stopGraceMs: number; restart: "never" | "on-failure";
  ports?: readonly number[]; dataDir?: string;
}
interface ServiceStatus { state: "stopped" | "starting" | "ready" | "unhealthy" | "failed"; detail?: string; }
```

The runtime adapter owns start → readiness/health → status → graceful stop/restart; Hindsight and a future LangFlow implementation supply only their spec/config. Mode selection must not change extension code. Secret references are resolved by the existing secret/config owner and never serialized into status, logs, images, or traces. Port ownership/conflicts, volume/data ownership, bounded diagnostics, and crash policy are core runtime responsibilities. Hindsight proves equivalent local/Docker/Compose behaviour and clean degradation when unavailable; LangFlow is not implemented here.

## Compatibility and failure rules

- Schema remains 2. Omitted hooks/grants/settings are inactive and preserve existing provider/session behavior.
- New `HookCtx`, trace, usage, and service fields are optional/additive. Existing JSONL trace rows remain readable.
- Hook timeout, throw, malformed response, unresolved service, unreadable config, or trace observer error never fails the user turn. Core records a sanitized outcome where possible.
- Existing Hindsight provider lifecycle (`market-packs/hindsight/`) remains the regression canary; it continues to use its provider contract until it elects to consume the service runtime.
- Metadata disabling remains compatible with `bobbit.disabledProviders`; any broader extension-disabled alias must retain that key indefinitely.

## Early consumer commits

The parent branch exposes and documents these independently cherry-pickable commits as soon as their prerequisites land:

1. **After-turn usage:** additive `HookCtx.usage` for `afterTurn`, populated from the authoritative terminal usage already read by `SessionManager.trackCostFromEvent()` (input/output/cache read/cache write, cost, and telemetry-known state). It is a snapshot, not a new cost ledger.
2. **Budget enforcement result:** a core-owned, grant-gated enforcement proposal/result path with deterministic warn/pause/halt outcomes, trace/audit rows, and no private Prompt Cache hook.
3. **Request shaping:** EP-4's bounded, grant-gated prompt proposal/application choke point.
4. **Service lifecycle:** EP-8's separate commit described above.

Each commit must be additive, compile/test independently, identify its public interfaces in its commit message, and be named in the parent PR for the dependent parents to cherry-pick.

## Integration and merge strategy

The parent branch is `goal/extension-plat-03a877d8`; every child targets it, never `main`. The lead merges a child only after its focused tests, review findings, and clean branch are present. Rebase/merge children in DAG order, rerun the affected focused tests after each merge, and retain a small parent-only reconciliation commit if interfaces meet there.

For #1105 and #1107: cherry-pick/squash their complete tested series onto the parent; resolve any current-main or review issue there; run their registered tests; then close the PR and delete its branch. Do not partially transplant either series. Keep externally consumable usage/request-shaping/service commits separate from UI/reconciliation commits.

Before the parent PR requests merge: rebase on current `origin/main`, run `npm run check`, `npm run test:unit`, and `npm run test:browser`, complete the parent browser journey below, and wait for user testing. The sole parent PR body ends with the required Bobbit footer.

## Parent browser journey

Add `tests2/browser/journeys/extension-platform-parent.journey.spec.ts`, registered in `tests2/tests-map.json`, using a deterministic local Marketplace fixture pack `extension-platform-demo` and mock agent. It must exercise the real UI/API path, not seed a grant or call a hook endpoint directly:

1. Open Market for fixture project `extension-platform-e2e`; install the fixture extension and verify its declared advisory hook, requested `decide:selectThinking` capability, and disabled grant state are visible.
2. Create a mock-agent session and send the fixture prompt. Open **Context** from that session; verify an `advised` decision with the fixture reason appears, while the session's thinking value remains the operator default.
3. In Market, grant the displayed capability for that project. Start the next fixture session and send the same prompt; verify Context records `applied`, and the session UI reports the allowed fixture thinking level. Reload the page and re-open Context to prove persisted trace/state.
4. Revoke the grant; a subsequent fixture session returns to advisory-only. Re-grant, then remove the extension from Market. Verify the Market row is gone, the next session has no fixture selection/bridge effect, and the existing session's historical trace remains readable as history.

The fixture must use only an allowed value, produce a sanitized reason, and make no network/process call. Its test additionally proves install → observe → grant → act → revoke/remove, project scoping, reload, and cleanup.
