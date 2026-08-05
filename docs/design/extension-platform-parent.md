# Extension Platform — Parent Integration Design

## Decision

Finish the platform on the parent integration branch as **declared, observable, advisory extensions first; core-applied and explicitly granted changes second**. Reuse the existing pack registry, lifecycle hub, trace store, Marketplace configuration, and typed Host API. Do not add a parallel loader, scheduler, permission system, trace store, or runtime-specific hook path.

The worker/module host remains resource/crash isolation for *trusted* pack code; hook grants constrain only what **core will apply**. They do not claim to sandbox a malicious pack's ambient host process access.

## Scope ledger

| In scope | Explicitly out of scope |
|---|---|
| Schema-2 hook metadata, lifecycle context, extension advice, cadence, core-applied decisions/mutations, per-project grants/audit, settings, staff proposals, skill/MCP adoption, dynamic capability selection, service-extension lifecycle, user decision requests, and the first core-feature migration (thinking-level selection). | A pack schema bump; a raw gateway/host escape hatch; auto-applying staff proposals; wall-clock **helper** scheduling; dynamic creation of skills/MCPs/tools; a new agent runtime; a LangFlow implementation; moving Hindsight's existing provider implementation; a general OS capability sandbox. |
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

`EP-2b` retains its historical suffix. `EP-11` is the additional decision-request slice; `EP-12` is the newly scheduled thinking migration, not optional follow-on work.

| Slice | Deliverable | Depends on | Parent handling |
|---|---|---|---|
| EP-1 | Hook declarations, validation, filtering, existing lifecycle events/budgets. | — | Landed baseline; audit only. |
| EP-2b | Rich, project-safe hook scope context. | EP-1 | Landed baseline; retain its compatibility tests. |
| EP-5 | Read-only Context inspector and persisted/live trace visibility. | EP-1 | Absorb #1107 first; preserve all tests. |
| EP-6 | Per-project capability grants, revoke audit, and inert ungranted decide hooks. | EP-1, EP-5 | Required before a hook can interrupt a user or core can apply a proposal. |
| EP-11 | Extension decision requests: typed/defaulted user choices, advisory inbox entries, budgets, durable scoped answers, and Context audit. | EP-5, EP-6 | Must land before EP-2/EP-4 so hooks ask rather than guess. |
| EP-2 | Typed model/thinking/role/workflow proposals; advisory display before granted application. | EP-5, EP-6, EP-11 | Thinking extraction follows EP-2. |
| EP-3 | Every-N-turn, fire-and-forget advisory helpers. | EP-5, EP-6 | No clock timers. |
| EP-9 | Adopt stock MCP and Claude-style skills. | EP-1 | Absorb #1105; may proceed in parallel with EP-5/6. |
| EP-4 | Granted request shaping and tool-call safety proposals. | EP-2, EP-5, EP-6, EP-11 | Core validates/applies; prompt shaping defaults off. |
| EP-10 | Query-selected capabilities: `selectSkills`, then `selectMcp`. | EP-6, EP-9 | Activate installed/permitted assets only; pin a selection per session. |
| EP-7 | Marketplace settings, config schema rendering, project enable/disable, grant UI. | EP-6 | Secret values are write-only. |
| EP-8 | Staff proposals plus the separately committed service-extension lifecycle contract. | EP-3, EP-6, EP-7 | All proposals require approval; publish the service commit for Hindsight cherry-pick. |
| EP-12 | Migrate core thinking-level selection onto EP-2's decision contract; retain `thinking-level-clamp.ts` as the final operator/model ceiling and delete the replaced core heuristic path. | EP-2, EP-11 | First proof that optional capability left core; separately committed and measured. |

```text
EP-1 → EP-2b
EP-1 → EP-5 → EP-6 → EP-11 → EP-2 → EP-4
                 ├──────────────→ EP-3 ───→ EP-8
                 ├──────────────→ EP-7 ───→ EP-8
                 └──────────────→ EP-10
                           EP-2 ──────────→ EP-12 (thinking migration)
EP-1 → EP-9 ─────────────────────────────→ EP-10
```

EP-5 and EP-6 intentionally precede every applied behavioural change and user interruption. EP-11 is deliberately before EP-2/EP-4; EP-9 is independent adoption work, but its product UI is reconciled with EP-7 before the parent scenario.

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

### EP-11 — extension decision requests

#### Existing seams and ownership

This slice reuses the **visual** question widget but not its agent-only delivery protocol. `defaults/tools/ask/extension.ts` registers `ask_user_choices`; `src/ui/tools/renderers/AskUserChoicesRenderer.ts` and `src/ui/components/AskUserChoicesWidget.ts` render it. Its current `POST /api/internal/user-question/submit` in `src/server/server.ts` cross-validates against a transcript tool-use, appends `src/shared/ask-envelope.ts`'s response envelope, and wakes a live agent. A lifecycle hook has neither a tool-use nor an agent turn, so synthesizing one would create a forged transcript and cannot meet deadline/default semantics.

Refactor the existing widget only to accept a typed submit callback/adapter; its choices, Other field, keyboard behavior, min/max validation, and answered read-only view stay shared. The new adapter is an `ExtensionDecisionRequestCard` mounted by the existing `src/ui/components/ContextTraceInspector.ts`, not a second question UI. It posts to a dedicated server-owned route and disables on a terminal response.

The staff inbox provides the lifecycle precedent, not a fake staff agent: `src/server/agent/inbox-store.ts` persists FIFO entries; `inbox-manager.ts` owns atomic pending → terminal transitions and WS broadcasts; `src/server/server.ts` owns the REST routes; `src/app/inbox-panel.ts` bootstraps and applies `inbox.entry.*`; and `src/ui/inbox/InboxEntry.ts` renders status/history. Generalize those owner/key and source contracts additively so a project-scoped extension-advisory inbox has the same pending/terminal/history/WS behavior while staff URLs and staff-tool behavior remain unchanged. Do not enqueue advisories to an arbitrary staff member.

Create the authoritative durable answer owner at `src/server/agent/extension-decision-store.ts` and the resolver/expiry/budget owner at `src/server/agent/extension-decision-manager.ts`; wire both in `src/server/server.ts` beside `InboxManager` and `ContextTraceStore`. The manager receives the project `SessionStore` and `GoalStore` through `ProjectContextManager`, so scope identity is resolved server-side rather than trusted from an extension. `ProjectConfigStore` is the EP-6 grant/quota configuration owner. `LifecycleHub` is the only hook caller and passes a narrow typed read/request facade in `HookCtx`; `src/shared/extension-host/host-api.ts` remains unchanged because this is a server-hook contract, not a renderer's host API.

#### Typed contracts

Put the shared serializable contracts in new `src/shared/extension-host/decision-request-contract.ts`; use the existing `UserQuestion`, `UserQuestionAnswer`, `validateQuestions`, and `crossValidate` from `src/server/agent/ask-user-choices-validation.ts` rather than copy their rules.

```ts
type DecisionScope = "session" | "goal" | "project";
type DecisionRequestState = "pending" | "answered" | "defaulted";
type DecisionAnswerSource = "user" | "default";

interface ExtensionDecisionRequest {
  key: string;                     // pack-local safe id, stable across retries
  scope: DecisionScope;
  questions: readonly UserQuestion[]; // existing 1..5 choice/Other contract
  defaultAnswers: readonly UserQuestionAnswer[]; // cross-validates with questions
  deadlineAt: number;               // finite epoch ms, server caps horizon
  title: string;                    // bounded display label, not an apply instruction
}
interface StoredDecisionRequest {
  id: string; projectId: string; sessionId: string; goalId?: string;
  packId: string; hookId: string; scope: DecisionScope; scopeId: string;
  key: string; fingerprint: string; state: DecisionRequestState;
  questions: readonly UserQuestion[]; defaultAnswers: readonly UserQuestionAnswer[];
  deadlineAt: number; createdAt: number; resolvedAt?: number;
  answer?: readonly UserQuestionAnswer[]; answerSource?: DecisionAnswerSource;
}
type DecisionRequestResult =
  | { state: "pending"; id: string; deadlineAt: number }
  | { state: "answered" | "defaulted"; id: string; answers: readonly UserQuestionAnswer[]; source: DecisionAnswerSource }
  | { state: "rejected"; code: "CAPABILITY_DENIED" | "BUDGET_EXCEEDED" | "KEY_CONFLICT" | "INVALID_REQUEST" };
```

`key`, ids, labels, question/options/Other text, deadline, and request byte size are bounded before persistence. `deadlineAt` is required, after creation, and capped to a documented maximum. Strengthen the canonical `crossValidate` owner to reject selections outside the declared options and duplicate multi-select values; both the current agent tool and this slice then share the correction. `defaultAnswers` must pass `validateAnswers` and `crossValidate(questions, defaultAnswers)` before a request exists. `POST /api/extension-decisions/:id/answer` receives only `answers`; it loads the stored questions, runs those same validators, atomically accepts the first valid response, and returns 409 for terminal/racing submissions. Invalid UI input remains pending and never reaches hook code.

`HookCtx.decisionRequests.request()` stamps project/session/goal/pack/hook identity from the invocation and returns `DecisionRequestResult`; `get(key, scope)` resolves the same pack+hook+server-derived scope only. An extension therefore cannot read another pack's answers or claim another project/goal/session. Configuration-changing requests do **not** use this result as an apply command: the hook creates an existing `src/server/proposals/` draft and the normal proposal UI/approval route remains the sole mutator.

#### State sequence, defaulting, and advisory separation

1. `LifecycleHub` validates the hook's typed request, resolves its server-derived scope, and checks the EP-6 `ask:decision` grant and quotas **before** creating UI work. Rejected/budget-exceeded calls are loud return values and sanitized trace outcomes, never silent drops.
2. The manager looks up `(projectId, packId, hookId, scope, scopeId, key)`. Same fingerprint returns the existing pending or terminal result without consuming budget; a different fingerprint for that key returns `KEY_CONFLICT` so a pack cannot overwrite a settled question.
3. A new decision atomically persists as pending, increments session and goal request counters, records a metadata-only Context outcome, and publishes it to the decision adapter. It never parks a hook promise; the hook continues and polls/reads its durable result on a later invocation.
4. A human answer is atomically validated and transitions `pending → answered`; only then does `get()` expose it. A default is just as strictly validated before creation.
5. Expiry is reconciled at creation, answer/read, server start, and by the manager's injected-clock sweep. If `PersistedSession.nonInteractive` is true (the current durable headless/CI signal), the manager resolves the validated default immediately. Otherwise the sweep resolves at `deadlineAt`. Restart downtime is harmless because each sweep compares the durable absolute deadline. The resulting `defaulted` state, timestamp, and source are visible.
6. **Advisory** hooks never call `request()`: they call `publishAdvisory()`, which adds a project-scoped inbox entry and trace reference, never opens/focuses a question card, never consumes a decision budget, and cannot block progression. A decision is the only class permitted to render the shared widget.

The request state is durable answer data, not a parallel trace/audit stream: `ContextTraceStore` continues to hold a small safe reference row (`kind: "audit"`, hook id, request id, state/defaulted reason). Extend its server and client allow-lists in `src/server/agent/context-trace-store.ts` and `src/app/context-trace.ts`; `ContextTraceInspector` joins the bounded project-authorized decision records by id to show who asked, the question/options, response/default, and timestamps in the same Context surface. Full question text never enters JSONL trace rows.

#### Capability, quota, dedupe, validation, and migration rules

EP-6 adds an explicit `ask:decision` grant for `(hookId, capability)` and immutable per-grant maxima `maxPerSession` and `maxPerGoal`; absence denies. The manager counts only newly persisted unique requests, after dedupe, in durable request records so restart and repeated hook calls cannot bypass a cap. Exceeding either cap returns `BUDGET_EXCEEDED`, writes an audit row, and is surfaced to the extension and Context UI.

A scope key is `sessionId`, resolved `goalId` (goal scope requires one), or `projectId`; session scope may not outlive/migrate with the session. Project/goal answers remain available after a session ends. No extension-supplied project, goal, actor, deadline resolution, or answer source is authoritative. Existing inbox entries, staff REST endpoints/tools, ask envelopes, proposal files, session JSON, and goal JSON remain readable; all new fields/files are additive.

#### Alternatives and defect surface

| Rejected approach | Why it is rejected |
|---|---|
| Invoke `ask_user_choices` or append its envelope from a hook. | That contract needs a live agent tool-use and transcript wake; it cannot timeout/default safely and would forge chat history. |
| Make every advisory a modal decision. | It interrupts users and turns advisory-first into a spam channel. |
| Store answers in extension-owned `HostStore`. | Server hooks need a core-enforced deadline, dedupe, scope, quota, and audit; no extension-owned store can enforce them. |
| Reuse a staff inbox under a synthetic/arbitrary staff id. | It leaks project advisories into staff work queues and breaks staff ownership/authz. |
| Block a hook until the user answers. | Overnight/headless runs deadlock and consume worker capacity. |

Defect surfaces requiring focused tests: duplicate submit/expiry races; expiry during restart; invalid default and invalid user answers; stale UI answer after a default; same key with different payload; quota counting after restart; session/goal/project scope isolation; grant revoke between render and submit; headless immediate default; malformed persisted record; inbox WS ordering; trace redaction/bounds; and a hook attempting to query another pack's answer.

### EP-12 — thinking-level migration

`src/server/agent/session-manager.ts` currently resolves and persists `effectiveThinkingLevel`; `src/server/ws/runtime-model-selection.ts` applies a selected runtime tuple; and `src/server/agent/thinking-level-clamp.ts` / `src/shared/thinking-levels.ts` enforce model support. EP-12 replaces only the optional selection heuristic with EP-2's granted `selectThinking` proposal: user/role/operator pins remain higher precedence, the final candidate is clamped at these existing owners, and the verified tuple still persists through `SessionStore`.

The migration removes the superseded core heuristic/call path rather than adding a second selector. It is separately committed with a no-extension parity test, user-pin and model-cap tests, and a fixture extension test proving advisory-before-grant then applied-after-grant. Its trace outcome identifies the selected safe level but never an extension reason; `thinking-level-clamp.ts` remains core policy, not an extracted feature.

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

## Focused and browser acceptance

EP-11 focused tests belong in `tests2/core`/`tests2/integration` and are registered in `tests2/tests-map.json`. They must use an injected clock and real persistence boundary to prove: (1) missing `ask:decision` grant rejects loudly; (2) a valid answer is cross-validated before `get()` returns it, while malformed/out-of-range/Other-without-text input is rejected; (3) same fingerprint dedupes pending and answered records without charging budget, while a changed payload returns `KEY_CONFLICT`; (4) session, goal, and project answers cannot cross scopes/packs; (5) session/goal caps reject the next unique request and survive reload; (6) expiry and a racing answer yield exactly one terminal state; (7) a cold restart resolves an overdue request to its default; (8) `nonInteractive` resolves the default immediately; (9) advisory publication creates an inbox/history item but never an interrupt; and (10) trace/UI normalizers receive only safe ids/statuses, while the Context decision record exposes the validated audit data.

Add `tests2/browser/journeys/extension-platform-parent.journey.spec.ts`, registered in `tests2/tests-map.json`, using deterministic local Marketplace fixture packs and mock agents. It must exercise real UI/API paths, not seed a grant, answer record, or hook endpoint directly:

1. Open Market for fixture project `extension-platform-e2e`; install the fixture extension and verify its advisory hook, requested `decide:selectThinking` and `ask:decision` capabilities, quotas, and disabled grants are visible.
2. Start a mock-agent session and send the fixture prompt. Open **Context**; verify the advisory decision and an advisory inbox item appear, while the session thinking value remains the operator default and no question interrupts.
3. Grant `ask:decision`. Send the fixture's ambiguous prompt; the existing multiple-choice widget appears in Context. Select a valid option and submit. Verify it becomes read-only/answered, Context records who asked/answered/when, and the next fixture turn observes the chosen result.
4. Send the same prompt again; verify it collapses to the answered request with no second card and no extra quota. Submit malformed input through the browser request interception or widget state and verify it is rejected while the card remains pending; then answer correctly.
5. Leave a second fixture question unanswered, advance the injected clock/reload, and verify it becomes **defaulted**, the follow-up turn continues with the declared default, and Context shows defaulted rather than answered. In the headless fixture, verify the default occurs immediately.
6. Configure a one-question cap, answer/create one unique question, then trigger another; verify the extension receives a loud budget failure, Context records it, and no second widget appears.
7. Grant `decide:selectThinking`, start the next fixture session, and verify the allowed thinking value is applied. Reload and re-open Context to prove persisted trace, decision audit, and selected state. Revoke both grants; a subsequent session returns to advisory-only. Re-grant, remove the extension, and verify no later bridge effect while historical trace/decision audit remains readable.

The fixtures use only allowed values, sanitized labels, and no network/process call. Together they prove install → observe → grant → ask → answer/default → act → quota/revoke/remove, project scoping, reload, audit, and cleanup.
