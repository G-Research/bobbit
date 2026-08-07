# Extension Platform — Parent Integration Design

## Decision

Finish the platform on the parent integration branch as **declared, observable, advisory extensions first; core-applied and explicitly granted changes second**. Reuse the existing pack registry, lifecycle hub, trace store, Marketplace configuration, and typed Host API. Do not add a parallel loader, scheduler, permission system, trace store, or runtime-specific hook path.

The worker/module host remains resource/crash isolation for *trusted* pack code; hook grants constrain only what **core will apply**. They do not claim to sandbox a malicious pack's ambient host process access.

## Scope ledger

| In scope | Explicitly out of scope |
|---|---|
| Schema-2 hook metadata, lifecycle context, extension advice, cadence, core-applied decisions/mutations, per-project grants/audit, settings, staff proposals, skill/MCP adoption, dynamic capability selection, service-extension lifecycle, user decision requests, static extension system-prompt contributions, post-tool-result filtering, and the first core-feature migration (thinking-level selection). | A pack schema bump; a raw gateway/host escape hatch; auto-applying staff proposals; wall-clock **helper** scheduling; dynamic creation of skills/MCPs/tools; a new agent runtime; a LangFlow implementation; moving Hindsight's existing provider implementation; a general OS capability sandbox; a real credential-detection/classification policy (explicitly deferred from EP-14). |
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
| EP-11 | Extension decision requests: typed advisory/deferrable/consent choices, advisory inbox entries, interruption budgets, durable scoped answers, and Context audit. | EP-5, EP-6 | Must land before EP-2/EP-4 so hooks ask rather than guess. |
| EP-13 | Static, named extension system-prompt sections, protected cache boundary, byte budgets, proposal-only agent authorship, and attributable inspection/audit. | EP-5, EP-6 | A static enable/configuration surface; coordinate its boundary contract with Prompt Cache before implementation. It is not EP-4 per-turn shaping. |
| EP-2 | Typed model/thinking/role/workflow proposals; advisory display before granted application. | EP-5, EP-6, EP-11 | Thinking extraction follows EP-2. |
| EP-3 | Every-N-turn, fire-and-forget advisory helpers. | EP-5, EP-6 | No clock timers. |
| EP-9 | Adopt stock MCP and Claude-style skills. | EP-1 | Absorb #1105; may proceed in parallel with EP-5/6. |
| EP-4 | Granted request shaping and tool-call safety proposals. | EP-2, EP-5, EP-6, EP-11 | Core validates/applies; prompt shaping defaults off. |
| EP-14 | Granted, pre-fan-out post-tool-result filtering: pass, replace/redact, or safe reject before Pi persists, feeds the model, or emits a result. | EP-4, EP-5, EP-6 | Reuses EP-4 deny-wins/grant resolution and EP-5 metadata audit; credential policy is deferred. |
| EP-10 | Query-selected capabilities: `selectSkills`, then `selectMcp`. | EP-6, EP-9 | Activate installed/permitted assets only; pin a selection per session. |
| EP-7 | Marketplace settings, config schema rendering, project enable/disable, grant UI. | EP-6 | Secret values are write-only. |
| EP-8 | Staff proposals plus the separately committed service-extension lifecycle contract. | EP-3, EP-6, EP-7 | All proposals require approval; publish the service commit for Hindsight cherry-pick. |
| EP-12 | Migrate core thinking-level selection onto EP-2's decision contract; retain `thinking-level-clamp.ts` as the final operator/model ceiling and delete the replaced core heuristic path. | EP-2, EP-11 | First proof that optional capability left core; separately committed and measured. |

```text
EP-1 → EP-2b
EP-1 → EP-5 → EP-6 → EP-11 → EP-2 → EP-4 → EP-14 (post-tool filter)
                 ├──────────────→ EP-13 (static prompt sections)
                 ├──────────────→ EP-3 ───→ EP-8
                 ├──────────────→ EP-7 ───→ EP-8
                 └──────────────→ EP-10
                           EP-2 ──────────→ EP-12 (thinking migration)
EP-1 → EP-9 ─────────────────────────────→ EP-10
```

EP-5 and EP-6 intentionally precede every applied behavioural change and user interruption. EP-11 is deliberately before EP-2/EP-4; EP-13 is independently static and can proceed after EP-6, but its cache-boundary contract is agreed with the Prompt Cache parent first. EP-14 follows EP-4/EP-5/EP-6 because it reuses the tool-safety decision reducer, grant owner, and activity audit, but it is a distinct pre-persistence runtime boundary. EP-9 is independent adoption work, but its product UI is reconciled with EP-7 before the parent scenario.

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

This slice reuses the **visual** question widget, not its agent-only delivery protocol.
`defaults/tools/ask/extension.ts` registers `ask_user_choices`; `src/ui/tools/renderers/AskUserChoicesRenderer.ts` and
`src/ui/components/AskUserChoicesWidget.ts` own its choice/Other UI. Its current
`POST /api/internal/user-question/submit` handler in `src/server/server.ts` cross-validates against a transcript
tool-use, appends `src/shared/ask-envelope.ts`'s response envelope, and wakes a live agent. A lifecycle hook has
neither a tool-use nor an agent turn. It must never synthesize either: that would forge a transcript and cannot
represent expiry, defaulting, or fail-closed consent.

Refactor the existing widget only to accept a typed submit adapter; preserve its choices, Other field, keyboard
behaviour, min/max validation, and answered read-only view. A new `ExtensionDecisionRequestCard` is mounted in the
existing `ContextTraceInspector`, rather than introducing a second question UI. Its answer route is server-owned and
loads the canonical request before validating the submitted answer.

The staff inbox is the delivery/lifecycle precedent, not a synthetic staff member. `src/server/agent/inbox-store.ts`
persists FIFO entries; `inbox-manager.ts` owns atomic pending-to-terminal transitions and WS broadcasts;
`src/server/server.ts` owns routes; `src/app/inbox-panel.ts` applies `inbox.entry.*`; and
`src/ui/inbox/InboxEntry.ts` renders status/history. Extend the source/key contracts additively so project-scoped
extension advisories use the same pending/terminal/history/WS mechanics without entering a staff work queue or
changing staff routes/tools.

Create a durable `src/server/agent/extension-decision-store.ts` and a resolver/classifier/expiry/quota owner
`src/server/agent/extension-decision-manager.ts`, wired in `src/server/server.ts` beside `InboxManager` and
`ContextTraceStore`. `ProjectContextManager` supplies the authoritative session and goal stores; scope identity,
headless state, and the operation being protected are server-derived. `ProjectConfigStore` is the EP-6 grant and
quota configuration owner. `LifecycleHub` is the sole hook caller and passes a narrow typed request/read facade in
`HookCtx`. `src/shared/extension-host/host-api.ts` remains unchanged: this is a server-hook contract, not a renderer
host capability.

Consent pauses must compose the existing durable goal lifecycle, not write `goal.paused` themselves. Today
`PersistedGoal`/`GoalStore` own `paused`; `nested-goal-routes.ts::executePauseForGoals()` is the single pause entry
point (updates the goal, cancels verification, broadcasts, and aborts other streaming sessions), and
`resumeOperatorPausedGoal()` is the canonical durable resume primitive used by `POST /api/goals/:id/resume`.
EP-11 extracts or parameterizes those primitives as an internal Goal Pause service before calling them. It adds an
optional, structured, non-free-form `pauseReason` owned by core (request id, kind `awaiting-extension-consent`,
created time). `src/app/state.ts`, `src/app/render.ts`, and `src/app/goal-dashboard.ts` derive “Awaiting consent”
from that reason while retaining the existing pause/resume controls. It must not set `state: "blocked"`, emit a failed
gate, or feed the team-manager stall/nudge paths: an explicitly paused goal remains paused, not failed or stalled.

The existing tool denial seam is different. `tool-guard-extension.ts` blocks an ask-policy tool call on
`SessionManager.requestToolGrant()`; `SessionManager.denyToolPermission()` and the five-minute timeout resolve its
long-poll with `{ granted: false }`, leaving the guard to return `block: true`. A consent request protecting a tool
call uses the same fail-closed result shape at the guard/application choke point: the current call is denied and no
one-time/session/persistent tool grant is created. A later retry after valid consent is still re-checked by the
normal tool policy and safety classifier. EP-11 does not make a stored answer a raw execution permit.

#### Classification and shared contracts

The platform, not the extension, determines strictness from the protected operation and trusted core facts. An
extension declares an `intent` only so core can route its request; it may request a stricter class but never a lower
one. The classification function receives the actual tool-policy/safety verdict, budget-enforcement result, and
configuration mutation type at their existing choke points. It has these non-negotiable floors:

- an override that would spend beyond a core hard cap is `consent-required`;
- approval of a tool call that a core analyser marked unsafe is `consent-required`;
- any capability escalation or grant/configuration change is `consent-required`.

For an escalation/change, the answer produces an existing `src/server/proposals/` draft; normal proposal approval is
the only configuration mutator. Neither an extension string such as `"deferrable"` nor a saved answer can turn a
proposal or a denied tool into an applied mutation. There is no current general spend hard-cap gate:
`SessionManager.trackCostFromEvent()` records authoritative terminal usage into `CostTracker` *after* a turn, which is
an observation seam, not a permission to start or override work. The early Budget Enforcement commit must add the
core pre-dispatch/override choke point and invoke this classifier there. A cost display, trace row, or raw
`CostTracker` read is never an enforcement/classification input.

Put serializable contracts in `src/shared/extension-host/decision-request-contract.ts`. Reuse `UserQuestion`,
`UserQuestionAnswer`, `validateQuestions`, and `crossValidate` from
`src/server/agent/ask-user-choices-validation.ts`; strengthen that canonical validator to reject selections outside
declared options and duplicate multi-select values, for both existing agent asks and extension decisions.

```ts
type DecisionScope = "session" | "goal" | "project";
type DecisionClass = "advisory" | "deferrable" | "consent-required";
type DecisionRequestState =
  | "pending" | "answered" | "defaulted" | "denied" | "paused-awaiting-consent";
type DecisionAnswerSource = "user" | "safe-default";
type ConsentTimeoutAction = "deny-operation" | "pause-goal";

interface ExtensionDecisionRequest {
  key: string;                    // pack-local safe id, stable across retries
  scope: DecisionScope;
  intent: string;                 // bounded, recognized routing intent; never authority
  requestedClass: DecisionClass;  // platform computes max(requested, required floor)
  questions?: readonly UserQuestion[];
  safeDefaultAnswers?: readonly UserQuestionAnswer[];
  deadlineAt?: number;            // required for deferrable/consent, server caps horizon
  title: string;                  // bounded display label, not an apply instruction
}
interface StoredDecisionRequest {
  id: string; projectId: string; sessionId: string; goalId?: string;
  packId: string; hookId: string; scope: DecisionScope; scopeId: string;
  key: string; fingerprint: string; decisionClass: DecisionClass;
  state: DecisionRequestState; questions?: readonly UserQuestion[];
  safeDefaultAnswers?: readonly UserQuestionAnswer[]; deadlineAt?: number;
  timeoutAction?: ConsentTimeoutAction; createdAt: number; resolvedAt?: number;
  answer?: readonly UserQuestionAnswer[]; answerSource?: DecisionAnswerSource;
  pausedGoalId?: string;
}
type DecisionRequestResult =
  | { state: "advisory-published"; id: string }
  | { state: "pending"; id: string; deadlineAt: number }
  | { state: "answered" | "defaulted"; id: string; answers: readonly UserQuestionAnswer[]; source: DecisionAnswerSource }
  | { state: "denied" | "paused-awaiting-consent"; id: string }
  | { state: "rejected"; code: "CAPABILITY_DENIED" | "BUDGET_EXCEEDED" | "KEY_CONFLICT" | "INVALID_REQUEST" };
```

Core computes the effective class as the stricter of the extension request and the platform floor, records any
elevation with a core-owned classification reason, and rejects only malformed or unsupported intents. Thus an
extension may raise strictness but cannot lower it. `advisory` has no question/default/deadline and calls
`publishAdvisory()`; it makes a project inbox/history entry and
trace reference only, never opens/focuses a card, consumes no interruption budget, and never blocks progression.

A `deferrable` request must provide questions, deadline, and a **validated safe default**. Its default passes
`validateAnswers` and `crossValidate(questions, safeDefaultAnswers)` before persistence. On deadline—or immediately
for a durable non-interactive/CI session—the manager transitions it to `defaulted`, records `safe-default`, and
allows only the documented safe continuation. It is invalid to create a deferrable request without a default.

A `consent-required` request must provide questions and deadline but **must not provide a default**. On silence it
never permits the protected operation. The core owner declares, from its operation type, either `deny-operation`
(for the current unsafe tool/override path) or `pause-goal` (for work that cannot safely continue without a human).
Extensions cannot select this timeout action. The request may be surfaced while pending; whether it is an interrupt
requires the explicit grant and cap below. Headless/CI never substitutes an answer: it immediately takes the same
deny or pause path. This replaces the earlier, conflicting “default required for every decision” model.

`POST /api/extension-decisions/:id/answer` receives only answers. It loads stored questions and class, validates
against those questions, re-checks the request is pending, and atomically accepts only the first valid answer.
Malformed/out-of-range/Other-without-text submissions stay pending and never reach hook code; terminal or racing
submissions return 409. `HookCtx.decisionRequests.request()` stamps project/session/goal/pack/hook identity;
`get(key, scope)` resolves only that same pack, hook, and server-derived scope. No extension-supplied project, goal,
actor, deadline resolution, answer source, or dangerous-category classification is authoritative.

#### State machine, pausing, restart, and quotas

The manager owns a single persisted compare-and-set transition for each request:

```text
new → advisory-published
new → pending → answered
              → defaulted                  (deferrable only; validated safe default)
              → denied                     (consent timeout/headless; deny-operation)
              → paused-awaiting-consent → answered  (answer-and-resume side effect)
                                     └────→ answered  (resume already won the race)
```

A durable identity is `(projectId, packId, hookId, scope, scopeId, key)`. The same fingerprint returns the existing
pending or terminal record without charging quota. A changed payload under the same key returns `KEY_CONFLICT`; no
asker may overwrite a settled answer. Session scope does not migrate with a session; project and goal answers survive
session end. Goal scope requires a goal. New records and counters are committed atomically so concurrent hooks and a
restart cannot exceed a cap.

Expiry reconciles at creation, read, answer, server startup, and an injected-clock sweep against the durable absolute
deadline. The terminal compare-and-set decides answer-versus-expiry exactly once. A restarted process rereads a
pending record, reconciles it before any protected operation, and re-publishes its current card/invalidation; it never
replays a default or resume. A stale browser card disables on 409/reload and refreshes the terminal record.

For a consent timeout whose platform action is `pause-goal`, the same durable transaction records
`paused-awaiting-consent` and a pause intent. The idempotent Pause service applies the existing pause cascade exactly
once and stores the request-bound `pauseReason`; recovery completes an unfinished intent before allowing work. It
never reports the pause as an error/stall. Answering that card invokes a server-owned **answer-and-resume** operation:
validate and settle the answer, verify the goal is paused for this exact request, clear that exact reason through the
canonical resume primitive, broadcast state change, and retry idempotently. It is one UI action; it must not resume a
manually paused or differently-paused goal. If a concurrent operator resume wins, the answer still settles and returns
an idempotent “already resumed” result. If a later/manual pause replaces the reason, answer remains durable but the
route leaves that pause intact and tells the user it requires normal resume. No automatic session turn is resurrected;
the resumed goal/session proceeds through its ordinary queue/next-turn path.

EP-11 requires its own reviewed, typed decision-authorization contract if it needs to gate record creation or
interruption. It must not add `ask:*` strings, quota fields, or another principal shape to EP-6's implemented closed
grant vocabulary. Its manager checks its approved authorization and cap before creating interrupting UI, counts only a
newly persisted, deduplicated request, and rechecks at the answer/terminal transition so revocation cannot turn a
pending unsafe operation into an allow. Exceeding a cap returns `BUDGET_EXCEEDED`, writes a loud audit result, and
creates no card—never a silent drop. Advisory inbox publication is not an interrupt and needs no interruption
authorization or cap.

`ContextTraceStore` remains the sole activity audit stream. Extend its exact allow-lists with core-owned decision
status/reason identifiers and a bounded request id; do not put question prose, answers, options, tool arguments, or
budget values in JSONL. The authorized Context API joins the durable decision record by id to show who asked, its
classification, question/options, answer/default/deny/pause status, timestamps, and resume result in the same
Context surface. This preserves EP-5's bounded trace, redaction, and WebSocket invalidation owners.

#### Alternatives and added defect surface

| Rejected approach | Why it is rejected |
|---|---|
| Invoke `ask_user_choices` or append its envelope from a hook. | It requires a live agent tool-use/transcript wake, would forge history, and has no safe expiry contract. |
| Require a default for every decision. | A default allow is fabricated consent for unsafe tools, hard-cap spend, and grant escalation. |
| Let the extension classify/choose the timeout action. | It could downgrade consent to deferrable or manufacture a default allow. |
| Block the hook until an answer. | It deadlocks headless/overnight work and consumes worker capacity. |
| Store answers in extension `HostStore`. | It cannot enforce platform classification, atomic cap/dedupe, expiry, pause recovery, or audit. |
| Directly write `goal.paused` or resume from the card. | It bypasses cancellation, broadcasts, cascade semantics, and the existing operator-pause guards. |
| Treat every advisory as a modal decision. | It makes advisory-first a spam channel. |

The added defect surface is deliberately confined to the shared contract, durable decision store/manager, classifier
at hard-cap/tool-safety/grant choke points, extracted Goal Pause service, widget adapter, advisory inbox source,
answer route, and Context join. Focused tests must cover malformed persisted records; scope/pack isolation; key
conflict; quota atomicity/restart; grant revoke; trace bounds/redaction; inbox WS ordering; stale cards; answer/expiry
and pause/restart races; and an extension trying to downgrade a core-classified consent request.

### EP-13 — static extension system-prompt contributions

#### Existing seams and boundary ownership

The sole prompt assembler remains `src/server/agent/system-prompt.ts`:
`_assembleSystemPrompt()` writes the actual prompt and `getPromptSections()` is its inspector projection.
`SessionManager._assemblePrompt()` caches the same `PromptParts` and persists the inspector snapshot;
`GET /api/sessions/:id/prompt-sections` serves that snapshot first. EP-13 changes these owners
rather than adding a second prompt renderer, effective-prompt endpoint, or an extension-side string splice.

The current bridge is deliberately **not** the insertion path. Its
`DYNAMIC_CONTEXT_START` / `DYNAMIC_CONTEXT_END` delimit a legacy per-turn tail, while
`provider-bridge-extension.ts` now forwards `beforePrompt` recall as a hidden
`bobbit:dynamic-context` message precisely because its comment pins the system prompt as unamended for cache
stability. `Dynamic Context` stays the final, lowest-authority section; EP-13 never calls
`stripDelimitedTail()` and never changes bridge output.

The default stable-core order is fixed: `System Prompt` → `Project AGENTS.md` →
`Working Directory` → `Tools` → `Available Skills`. A dedicated, contiguous extension region is emitted
immediately after the last *present* stable-core section (normally Available Skills; Tools when skills are absent),
and before `Goal`, `Role`, `Goal Nesting`, `Task`, `Workflow Context`, and `Dynamic Context`. Use these new
core-owned delimiters, emitted only when at least one granted, resolved section exists:

```ts
const EXTENSION_PROMPT_REGION_START = "<!-- bobbit:extension-prompt-region:start -->";
const EXTENSION_PROMPT_REGION_END = "<!-- bobbit:extension-prompt-region:end -->";
function extensionPromptSectionStart(packId: string, sectionId: string): string;
function extensionPromptSectionEnd(packId: string, sectionId: string): string;
// e.g. <!-- bobbit:extension-prompt-section:start pack="market:project:lint" section="review-rules" -->
```

`packId` and `sectionId` are safe identifiers, not labels; dynamic data is escaped before entering a delimiter.
The section text rejects either region/section delimiter token, preventing a contribution from forging a close or
another pack's attribution. The region markers and section wrappers count toward byte budgets and are shown as
assembly structure, not extension-authored prose. The region start—or, when disabled, the same post-core insertion
offset—is the cache breakpoint: the exact UTF-8 byte prefix ending there is the stable-core identity. Enabling,
disabling, reordering, or editing a contribution may change bytes **at or after** that boundary only; it must never
change the bytes or digest before it. With no resolved sections the prompt has no extension markers and is
byte-identical to the pre-EP-13 prompt; disabling restores that original byte sequence.

`bobbit.promptSectionOrder` remains the existing explicit cache-changing A/B metadata; absent metadata retains
today's byte-identical order. EP-13 itself never moves Tools, Available Skills, or Dynamic Context, and cannot use
an extension contribution to select a different region position. Existing caller-supplied section-order semantics
remain an intentional cache experiment, not an extension escape hatch. `_assembleSystemPrompt()` and
`getPromptSections()` share one internal layout helper so this protected partition, markers, and order cannot drift.
The existing `reorderLabeledSections` tests, session restore tests, and prompt persistence path remain regression
owners.

#### Contribution, grants, and resolution contract

Keep schema 2. Add an optional manifest catalogue `contents.systemPrompts` (YAML `system-prompts`) and load only
its safe basenames from `system-prompts/<listName>.yaml`, alongside `loadHooks()` in
`pack-contributions.ts`. Add the corresponding optional `DisabledRefs.systemPrompts` activation list so the existing
Market pack/entity toggle is the enable/disable source of truth. This is an additive schema-2 catalogue; it is not a
schema bump and it does not overload a hook declaration.

```ts
interface SystemPromptSectionContribution {
  id: string;                 // pack-local /^[a-z0-9][a-z0-9_.-]{0,127}$/i
  title: string;              // bounded display text, not used for ordering
  content: string;            // literal static markdown; no template or per-turn interpolation
  maxBytes?: number;          // declaration may lower, never raise the project hard cap
  listName: string; sourceFile: string; packRoot: string;
}
interface ResolvedSystemPromptSection {
  packId: string; packName: string; sectionId: string; title: string;
  content: string; contentBytes: number; renderedBytes: number;
  source: "manifest" | "project-override";
}
interface PromptExtensionBudget {
  maxBytesPerSection: number;
  maxBytesTotal: number;
}
```

`PackContributionRegistry` remains the activation and pack-precedence owner. Resolve active, non-shadowed pack
contributions from its same project-scoped, low→high `PackEntry` list (`pack-list.ts` / `PackResolver`): scope order
is built-in → server → global-user → project and `ProjectConfigStore.pack_order` puts the highest priority last.
Render resolved sections in that list order, then stable `packId`, then stable `sectionId`; never depend on discovery,
filesystem, load, or async completion order. A pack shadowed by a higher-precedence instance and a contribution
disabled by `pack_activation` are absent, not empty placeholders. This retains the platform's agreed per-project pack
priority tiebreak without inventing another ranking system.

A pack must be active **and** have the EP-6 per-project `prompt:system-static` grant for its sections to reach the
prompt. Missing/revoked grant is deny-by-default: no bytes are emitted and EP-5 records core-owned `denied` /
`Grant required` activity. The Market UI keeps activation and grant visibly distinct. Grant/activation/configuration
changes invalidate the registry/prompt-layout cache and cause affected sessions to rebuild their static prompt parts
before their next turn; no turn is modified in flight. A user-authored project override uses the same grant. A
separate `prompt:system-author` grant is required before an extension can request agent authorship, but it grants
only creation of a proposal—never an implicit configuration write.

Validate every manifest/override before replacing the currently effective layout: safe ids, literal UTF-8 text,
no reserved delimiters, exact byte counts (`Buffer.byteLength`), and no duplicate `(packId, sectionId)`. Enforce the
smaller of contribution/project per-section cap and the project total *after wrappers*. A malformed, duplicate,
over-budget, unreadable, or grant-revoked candidate fails loudly for that extension with a sanitized EP-5 audit
outcome and leaves the previous valid project configuration and prompt layout intact. There is no truncation: silently
truncating recurring instructions changes behaviour and conceals cost. A malformed installed contribution is simply
not emitted; it must not fail an agent turn or silently consume another pack's budget.

#### Authoring, proposal, audit, and inspection flow

Manifest text is static pack content. An extension or agent that wants to change project-effective text submits a
structured `project` proposal through the existing `src/server/proposals/proposal-files.ts` /
`proposal-types.ts` lifecycle and its existing accept flow; it does not receive a direct apply endpoint or a HostStore
write. Add a validated `extensionPromptSections` project-proposal field carrying the pack/section identity, exact
replacement text, and expected prior revision. Acceptance atomically revalidates the current grant, identity,
delimiter and byte budgets, then writes the project override through `ProjectConfigStore`; stale revisions, revoked
grants, and an over-budget acceptance leave the active prompt unchanged. The normal proposal diff is the authoritative
human review of exact text. Human edits use the same validated proposal path for consistency; an agent-authored edit
is always proposal-only.

Agent authoring is an ordinary, attributable agent turn—not extension code returning a prompt mutation. At request
creation, a server-owned authoring record stamps the requesting pack/hook/event, target section, requester/session/
goal, trigger, and baseline content digest. On the terminal `message_end`, `SessionManager.trackCostFromEvent()` is
the existing authoritative usage seam (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, cost);
record that terminal usage delta, model/provider/id, effective thinking level, start/end/duration, proposal id, and
exact unified diff in a durable prompt-contribution audit record. Do not derive an attributed authoring cost from the
aggregate `CostTracker`: it is session cumulative and cannot identify a single authoring turn. A failed/cancelled
turn records its terminal status and available metadata but creates no applied change.

EP-5 remains the activity/audit surface. `ContextTraceStore` receives only bounded safe ids and core statuses—for
example `audit`, `advised`, `applied`, `denied`, `dropped`, `error`, `superseded` plus a new fixed reason such as
`Over budget`; its JSONL must not duplicate markdown, a diff, usage bodies, model response, paths, or secrets. The
authorized Context detail joins the durable contribution/audit record to show contributor, trigger/on-whose-behalf,
proposal and acceptance status, exact diff, model and thinking level, input/output/cache tokens, cost, duration,
section byte count, and total-prompt byte share. This extends the existing Context REST + metadata-only
`context_trace_updated` invalidation rather than creating an extension activity stream.

Extend `PromptSection` / the persisted prompt snapshot and `SystemPromptDialog` with optional core-owned
attribution (`kind: "extension"`, pack id/name, section id/title, `contentBytes`, `renderedBytes`, `totalPromptBytes`)
and render each contribution as its own inspectable section. The dialog therefore shows the effective text and byte
cost by contributor; the structural region is attributed to the extension region, never Tools or Available Skills.
Existing non-extension snapshots stay readable. The inspector’s aggregate token estimate is informational; UTF-8
byte counts are the authoritative recurring-cost budget.

```text
install/enable → registry activation filter → EP-6 static grant check
  → deterministic resolve + validate/budget → shared prompt layout
  → [stable core][cache breakpoint][named extension sections][volatile suffix]
  → persist snapshot / serve inspector / trace safe activity

agent wants edit → authoring turn + terminal usage record → project proposal + exact diff
  → human accepts → revalidate CAS + ProjectConfigStore write → invalidate/rebuild
  → audit + attributed inspector update
```

This is deliberately distinct from EP-4. EP-13 text is resolved only when an extension is installed, enabled,
granted, configured, or proposal-approved and is static across turns; its fixed post-core placement preserves the
cacheable core prefix. EP-4 is a bounded **per-turn** `beforePrompt` request-shaping proposal, off by default and
separately granted; it neither owns static section state nor may append to this region. A per-turn writer must not
masquerade as a static contribution.

#### Prompt Cache handoff, alternatives, and defect surface

Coordinate the shared contract with Prompt Cache before either side implements it: `system-prompt.ts` exports the
region-start byte offset and stable-prefix SHA-256 from the same layout result used for the written prompt and
inspector snapshot. Prompt Cache consumes those fields as an **attributed expected prefix boundary**, not a private
hook. Its provider telemetry joins the current `CostTracker` cache read/write counters with that layout identity.
The parent pins the boundary evidence supplied at `c89d8bae5`, `fe5f23828`, `fd94d9b21`, `09ccb1907`, and
`7230c5915`: enable/disable may produce an expected post-boundary cache write, while identical pre-boundary digest
continues to receive cache reads. EP-13 must not report an extension toggle as an anonymous cache regression.

| Rejected approach | Why it is rejected |
|---|---|
| Let `beforePrompt` append instructions or use the provider bridge tail. | Per-turn mutation destroys cache reuse and violates the bridge’s immutable-system-prompt invariant. |
| Put extension text before Tools/Skills or let section-order metadata move it there. | An enable/disable would rewrite the expensive stable core and falsely attribute its cache miss. |
| Read pack directories asynchronously and render discovery order. | Filesystem/load order is nondeterministic and makes the same installation byte-different. |
| Treat activation as consent or let an extension write `ProjectConfigStore`/HostStore directly. | Enabling is not a grant, and direct mutation bypasses proposal review, revision checks, and audit. |
| Truncate over-budget text. | It silently changes persistent instructions and hides recurring cost. |
| Store diff/usage/model output directly in Context JSONL. | EP-5 trace is a bounded, redacted activity index; detailed authorized audit has different retention and disclosure needs. |

The new defect surface is bounded to manifest/catalogue validation, registry activation resolution, grant and budget
validation, the one shared system-prompt layout helper/markers, project proposal field + accepted override store,
authoring-turn audit correlation, prompt snapshot/API/dialog attribution, Context detail join, and the Prompt Cache
boundary telemetry seam. It does not alter provider bridge transport, dynamic-context delivery, tool docs/skills
resolution, or EP-4.

#### Focused and browser acceptance

Register focused tests in `tests2/tests-map.json` (new core/integration tests, not a widened existing suite):

1. `system-prompt-extension-sections` extends `tests2/core/system-prompt-order.test.ts` with default, no-tools,
   and no-skills layouts. It proves the exact default core order; extension region sits after the last present core
   section and before every volatile section; dynamic context remains last; `_assembleSystemPrompt()` and
   `getPromptSections()` have identical section/wrapper order; absent metadata stays byte-identical; and EP-13 does
   not move Tools, Skills, or Dynamic Context.
2. `prompt-extension-cache-boundary` extends the Prompt Cache parent’s prompt-prefix-attribution and runtime
   attribution coverage. It compares UTF-8 prefixes/digests before the exported region marker across disabled →
   enabled → disabled and reordered-extension cycles. It proves only named extension-region bytes differ, toggle-off
   restores original bytes, no-tools/no-skills remains correct, and the Prompt Cache fixture observes cache reads for
   the unchanged prefix with an attributed expected suffix change; no-extension output remains byte-identical to the
   pre-EP-13 prompt.
3. `prompt-extension-registry` exercises cross-scope/project `pack_order`, shadowing, disabled entity, stable
   `(packId, sectionId)` tie order, malformed delimiter attempts, duplicate ids, and restart/snapshot reconstruction.
4. `prompt-extension-grants-budgets` proves missing/revoked `prompt:system-static` denies without bytes, per-section
   and aggregate UTF-8 wrapper-inclusive caps reject loudly without truncation or replacing the prior valid layout,
   and grant/activation invalidation affects the next prompt only.
5. `prompt-extension-proposal-audit` proves an agent author request cannot apply text; proposal accept uses revision
   compare-and-set and rechecks grants/budgets; rejected/stale proposals preserve the prompt; terminal authoring usage
   is attributed from the one completed event (not aggregate CostTracker); and Context JSONL remains redacted while
   authorized detail contains diff, model/thinking, tokens, cost, duration, trigger and byte share.

Add `tests2/browser/journeys/extension-platform-parent.journey.spec.ts` to the parent journey. With deterministic
fixture packs and a mock provider/cache telemetry, install and enable two static-section packs, grant only one, then
open **View System Prompt** to verify its named content, pack attribution, per-section/total bytes, stable order, and
unchanged Tools/Skills attribution. Grant the second and reorder the packs; verify deterministic effective order and
expected cache-boundary activity in **Context**. Disable/remove one and prove its section disappears, the stable
prefix cache evidence remains, and historical Context audit persists. Finally request an agent-authored change, inspect
its exact proposal diff and authoring model/thinking/tokens/cost/duration/trigger, accept it, reload the prompt
inspector, and verify the new static text and audit—without exercising an EP-4 per-turn mutation.

### EP-14 — post-tool-result filtering

**Implemented.** EP-14 is now a core-owned pre-fan-out result gate, not the proposed
handler-registration wrapper described in this historical parent plan. The patched Pi core
suppresses protected result updates, invokes one generated core gate for the terminal result, and
releases only the core-selected value to Pi's transcript, model context, RPC, and downstream
Bobbit consumers.

Eligibility requires an active `mode: decide` hook with exactly `events: [afterToolResult]`, a
`filter:tool-result` declaration, and the exact EP-6 project grant. Reduction is deterministic:
`reject > redact > replace > pass`. Active filter failures reject with the fixed synthetic result;
when all selected filters are revoked/deactivated at the final authority fence, the feature is
explicitly off and the original passes unchanged. The fixture extension proves the seam only; it
is not a credential detector or policy.

The authoritative contract, protected Pi-extension/Docker trust boundary, peak-snapshot streaming
cap, cancellation/admission/restart behavior, metadata-only observability, and canary coverage are
in [EP-14 — Tool-result filter seam](ep-14-tool-result-filter.md). Real credential-containment
policy remains a later top-level goal.

### EP-12 — thinking-level migration

`src/server/agent/session-manager.ts` currently resolves and persists `effectiveThinkingLevel`; `src/server/ws/runtime-model-selection.ts` applies a selected runtime tuple; and `src/server/agent/thinking-level-clamp.ts` / `src/shared/thinking-levels.ts` enforce model support. EP-12 replaces only the optional selection heuristic with EP-2's granted `selectThinking` proposal: user/role/operator pins remain higher precedence, the final candidate is clamped at these existing owners, and the verified tuple still persists through `SessionStore`.

The migration removes the superseded core heuristic/call path rather than adding a second selector. It is separately committed with a no-extension parity test, user-pin and model-cap tests, and a fixture extension test proving advisory-before-grant then applied-after-grant. Its trace outcome identifies the selected safe level but never an extension reason; `thinking-level-clamp.ts` remains core policy, not an extracted feature.

### Grants, precedence, and hard denial

EP-6 uses one native, per-project `ProjectConfigStore.extension_grants` union and one compatible
audit/outbox owner:

```ts
type ExtensionGrant =
  | {
      packId: string; hookId: string; capability: ExtensionCapability;
      grantedAt: string; grantedBy: string;
    }
  | {
      packId: string; principal: "pack"; capability: ExtensionCapability;
      grantedAt: string; grantedBy: string;
    };
```

The closed vocabulary is `decide`, `mutate`, `filter:tool-result`, `store`, `session`, `agents`,
`prompt:system-static`, `prompt:system-author`, `service.manage`, `memory.read`, `memory.write`,
`memory.reflect`, `memory.invalidate`, and `memory.read.all`. The last six are pack-only; hook
eligibility remains declaration-owned and is not broadened. The exact keys are `(packId, "hook",
hookId, capability)` and `(packId, "pack", capability)`. There are no wildcards, inherited
permissions, extension-defined capabilities, or quota fields in a grant row.

Legacy hook rows stay discriminator-free. For backward compatibility their loader tolerates
unrelated extra fields, canonicalizing a valid row to the durable hook shape on a later write.
Those fields never add authority. `principal` is intentionally not tolerated on a hook row:
`principal: "hook"` and unknown principal values are invalid, while a pack row must have exactly
`principal: "pack"` and no `hookId`.

The server owns write validation, audit rows, revoke, and cache invalidation; Market uses the
existing grant controls. A missing grant is deny-by-default. Revocation is visible to the shared
live resolver on its next application-fence call without a process restart. The grant surface
gates core application only and remains visibly distinct from pack activation.

Resolution and core application remain deterministic:

1. A malformed request, inactive server-resolved pack/hook, unsupported principal/capability
   pairing, unavailable value, ungranted capability, or user/operator pin permits no application;
   record the applicable reason.
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

Core intersects `add` with installed, active, permitted assets; intersects `omit` only with optional assets; and makes a stage authoritative only when a valid, still-authorized proposal wins. An authoritative empty set explicitly removes that stage's optional surface. If neither stage is authoritative, the session keeps the legacy optional surface and no selection snapshot is persisted; otherwise the immutable per-stage selection is persisted for reproducibility. It invokes selection before `resolveSkillExpansions` / skill activation, and only later before the existing MCP proxy/activation path. It cannot invent an id, defeat a denial, or broaden `computeEffectiveAllowedTools()`.

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

### Generic non-hook grant handoff

EP-6 extends its single project-owned `extension_grants` and audit/outbox owner with a compatible
principal union. Legacy hook rows remain discriminator-free; their loader tolerates unrelated
extra fields but canonicalizes them on write, while treating any `principal` field as invalid. A
new pack row is exactly `{ packId, principal: "pack", capability, grantedAt, grantedBy }`. The six
pack-only closed values are `service.manage`, `memory.read`, `memory.write`, `memory.reflect`,
`memory.invalidate`, and `memory.read.all`. No hook receives those values, and no pack declaration
can mint another one.

The public Hindsight seam is `ExtensionGrantPrincipal`, `ExtensionGrantDecision`,
`ExtensionCapabilityGrantResolver`, and `createExtensionCapabilityGrantResolver()` from the
extension-grant policy module. A consumer retains the resolver, passes server-derived
`{ kind: "pack", packId }`, and calls it at every application fence; it never reads a grant
snapshot or accepts a panel/tool-supplied principal. The resolver re-resolves active winning pack
identity and reads current durable state, so revoke wins over stale work. The generic service
manager consumes the same seam for `service.manage`.

This handoff intentionally does not implement Hindsight memory or service behavior, private
Hindsight configuration, a Hindsight endpoint/store, extension-defined capabilities, or another
permissions UI/state owner. Existing hook REST paths, audit rows, activation ceilings, and
operator-auth requirements remain compatible; pack mutations use the generalized authenticated
surface and audit/outbox recovery.

## Compatibility and failure rules

- Schema remains 2. Omitted hooks/grants/settings/system-prompt catalogues are inactive and preserve existing provider/session behavior; no enabled static section means byte-identical existing prompt output.
- New `HookCtx`, trace, usage, service, prompt-section attribution, and cache-boundary fields are optional/additive. Existing JSONL trace rows and prompt snapshots remain readable.
- Hook timeout, throw, malformed response, unresolved service, unreadable config, or trace observer error never fails the user turn. Core records a sanitized outcome where possible.
- Existing Hindsight provider lifecycle (`market-packs/hindsight/`) remains the regression canary; it continues to use its provider contract until it elects to consume the service runtime.
- Metadata disabling remains compatible with `bobbit.disabledProviders`; any broader extension-disabled alias must retain that key indefinitely.

## Early consumer commits

The parent branch exposes and documents these independently cherry-pickable commits as soon as their prerequisites land:

1. **After-turn usage:** additive `HookCtx.usage` for `afterTurn`, populated from the authoritative terminal usage already read by `SessionManager.trackCostFromEvent()` (input/output/cache read/cache write, cost, and telemetry-known state). It is a snapshot, not a new cost ledger.
2. **Budget enforcement result:** a core-owned, grant-gated pre-dispatch/override enforcement path (not the post-turn `trackCostFromEvent()` observer), with deterministic warn/pause/halt outcomes, hard-cap consent classification, trace/audit rows, and no private Prompt Cache hook.
3. **Request shaping:** EP-4's bounded, grant-gated prompt proposal/application choke point.
4. **Service lifecycle:** EP-8's separate commit described above.

Each commit must be additive, compile/test independently, identify its public interfaces in its commit message, and be named in the parent PR for the dependent parents to cherry-pick.

## Integration and merge strategy

The parent branch is `goal/extension-plat-03a877d8`; every child targets it, never `main`. The lead merges a child only after its focused tests, review findings, and clean branch are present. Rebase/merge children in DAG order, rerun the affected focused tests after each merge, and retain a small parent-only reconciliation commit if interfaces meet there.

For #1105 and #1107: cherry-pick/squash their complete tested series onto the parent; resolve any current-main or review issue there; run their registered tests; then close the PR and delete its branch. Do not partially transplant either series. Keep externally consumable usage/request-shaping/service commits separate from UI/reconciliation commits.

Before the parent PR requests merge: rebase on current `origin/main`, run `npm run check`, `npm run test:unit`, and `npm run test:browser`, complete the parent browser journey below, and wait for user testing. The sole parent PR body ends with the required Bobbit footer.

## Focused and browser acceptance

EP-11 focused tests belong in `tests2/core`/`tests2/integration` and are registered in
`tests2/tests-map.json`. They use an injected clock and real persistence boundary to prove:

1. An active decision hook without its exact `(packId, hookId, "decide")` grant rejects loudly. Separately,
   EP-11's typed decision authorization and interruption cap reject a chatty extension at the durable session/goal
   hard cap with `BUDGET_EXCEEDED`, audit activity, and no extra card.
2. A valid answer is cross-validated before `get()` exposes it; malformed, out-of-range, duplicate, or
   Other-without-text input remains pending and never reaches hook code.
3. Same fingerprints dedupe both pending and terminal records without a quota charge; changed payloads return
   `KEY_CONFLICT`; project/session/goal and pack scopes cannot cross-read.
4. A deferrable request without a valid safe default is rejected; an unanswered deferrable request defaults exactly
   once at deadline and immediately in non-interactive mode, with the trace saying `defaulted` rather than answered.
5. A core-classified hard-cap spend override, unsafe-tool approval, and grant escalation each remain
   `consent-required` when an extension asks for deferrable/default-allow. No default is persisted or applied.
6. An unanswered consent request denies a protected tool operation; separately, an unanswered goal-scoped consent
   request pauses the goal with the durable request-bound reason, creates neither a failed gate nor a stall/nudge,
   and performs no protected work.
7. Answer/expiry, pause/answer, and restart recovery races yield one terminal decision and at most one pause/resume
   effect. Answer-and-resume resumes only the matching consent pause; an operator/manual pause is not cleared.
8. Cold restart reconciles overdue deferrable and consent records without replaying action; grant revoke before
   settlement remains fail-closed; malformed persisted records fail safe.
9. Advisory publication creates an inbox/history item but never interrupts or consumes an interruption budget; inbox
   WS order and trace/UI normalizers expose only safe ids/statuses while the authorized Context detail has the
   validated audit data.

Add `tests2/browser/journeys/extension-platform-parent.journey.spec.ts`, registered in `tests2/tests-map.json`, using
deterministic local Marketplace fixture packs and mock agents. It exercises real UI/API paths—not seeded grants,
answers, or hook endpoints:

### EP-11 decision-request journey

1. Open Market for fixture project `extension-platform-e2e`; install the fixture and verify its advisory hook,
   decision hook, typed decision authorization/caps, and disabled exact `(packId, hookId, "decide")` grant.
2. Start a mock-agent session and send the fixture prompt. Open **Context**; verify the advisory and an advisory inbox
   item appear while thinking remains the operator default and no question interrupts.
3. Grant the fixture decision hook's exact `(packId, hookId, "decide")` tuple. Send an ambiguous deferrable prompt;
   use the shared multiple-choice widget, submit a valid answer, and verify the read-only/audited result affects only
   the later fixture turn. Repeat it and verify dedupe/no quota charge; submit malformed input and verify the pending
   card remains until a valid answer.
4. Leave a deferrable question unanswered; advance the injected clock and reload. Verify its validated safe default
   continues the later turn and Context says **defaulted**. Verify the non-interactive fixture defaults immediately.
5. Trigger an unsafe-tool fixture decision that asks for deferrable/default allow. Verify Context shows platform
   `consent-required`, no default option/result exists, expiry denies the current tool call, and the tool is not run.
6. Trigger goal-scoped consent and leave it unanswered. Verify the goal shows **Awaiting consent** as paused—not
   failed or stalled—and no protected operation proceeds. Answer the Context card once; verify the matching goal
   resumes, the normal queue continues, and reload preserves answer, pause reason/audit, and resume result.
7. Set a one-question interruption cap, consume it, then trigger another request. Verify the loud budget failure and
   absence of a second card. Revoke the fixture decision hook's exact `(packId, hookId, "decide")` tuple and verify
   advisory-only behaviour. Re-grant, remove the extension, and verify no later bridge effect while historical
   trace/decision audit remains readable.

### EP-12 thinking-migration journey

8. Enable the default-disabled thinking selector, grant its exact `(packId: "thinking-selector", hookId:
   "default-thinking", capability: "decide")` tuple, and verify a safe selected value after reload. Revoke that
   same tuple and verify the operator default remains in effect.

### EP-13 static-section journey

9. Enable a static-section fixture; grant `prompt:system-static`; inspect **View System Prompt** for its named,
   attributed text and per-section/total bytes; then enable/reorder a second fixture and inspect deterministic order
   plus cache-boundary activity in **Context**. Disable/remove it and verify the original prompt bytes/core cache
   evidence return while audit persists. Submit an agent-authored replacement, inspect its proposal diff and usage
   attribution, accept it, and reload the inspector without any EP-4 per-turn mutation.

The fixtures use only allowed values, sanitized labels, and no network/process call. Together they prove install →
observe → grant → ask → answer/default or fail-closed consent pause/deny → act → quota/revoke/remove, project
scoping, reload, audit, and cleanup.
