# EP-11 Consent Hardening

**Status:** implementation-ready delta
**Baseline retained:** the merged EP-11 `DecisionRequestStore`/`DecisionRequestManager`, `AskUserChoicesWidget` adapter, advisory `InboxManager` path, single-choice option/Other validator, semantic dedupe, existing request/interruption budgets, `ProposalSeedService`, and EP-5 Context trace.

## Decision and boundary

Harden the existing decision flow in place. This is **not** a replacement of the store, widget, inbox, validation, dedupe, budgets, or audit.

- `advisory` remains the already separate validated `ExtensionAdvisory` output. It is durable inbox history only (`InboxManager.enqueue(..., { wake: false })`), never a card, deadline, default, continuation, or interruption.
- `deferrable` remains the existing `ExtensionDecisionRequest` flow, now named explicitly. It requires the existing schema-valid single `DecisionValue` safe default; deadline/headless applies it and records `defaulted`.
- `consent-required` is an additive form of that same request/store/manager flow. It requires the existing options/Other question and deadline, forbids a default, and can never authorize protected work on silence.

The platform calculates the effective strictness from trusted operation facts. An extension can request stricter handling but cannot downgrade the platform floor, retain a default after consent is forced, or choose whether silence denies or pauses. Configuration/capability answers still create only the existing editable proposal draft.

## Comparative review

### A. Selected — add fields and transitions to existing decision owners

**Data/control flow:** active granted hook → existing `DecisionHookDispatcher` → existing `validateDecisionHookOutput()` → existing `DecisionRequestManager.create()` receives server-derived protected-operation facts → same project `DecisionRequestStore` → current GET/WS projection → current `DecisionRequestRenderer` over `AskUserChoicesWidget` → existing typed answer POST → manager first-writer settlement → existing safe trace/proposal/advisory boundaries. A consent pause detours only through the extracted canonical goal-pause lifecycle described below.

**Exact seams:**

- `src/server/agent/decision-hook-contract.ts`: add class/intent validation around its present option/Other/default/deadline validator; retain `validateDecisionValue()`.
- `src/server/agent/decision-request-store.ts`: add fields and compare-and-set transitions to its one project JSON snapshot and `writeTerminalFirst()` discipline.
- `src/server/agent/decision-request-manager.ts`: classify, normalize forced consent, settle default/deny/pause, recheck grants, and coordinate recovery using its existing timer, dedupe, budgets, proposal routing, and invalidation.
- `src/server/agent/inbox-manager.ts`: unchanged `wake: false` advisory enqueue.
- `src/ui/components/AskUserChoicesWidget.ts`, `src/ui/tools/renderers/DecisionRequestRenderer.ts`, and `src/app/extension-decisions.ts`: retain the single question UI/transport; only project actionable consent-pause state.
- `src/server/agent/context-trace-store.ts`: extend its allow-list with fixed class/state/reason values.

**Failure modes:** a bad class/default is rejected before persistence; a corrupt store remains fail-closed as today; a deadline/answer/restart race uses the existing first-terminal write; a pause service failure leaves a durable recoverable intent and a blocked protected operation; a revoked grant makes settlement deny/pause; renderer/WS failure leaves durable state and the deadline/reconciliation owner intact. No failure creates a direct config write, tool grant, or raw audit payload.

**Defect surface:** additive request/store fields, manager settlement branches, a small extracted pause service, existing route projection status handling, and exact new trace enums. It does not add a second persistence owner, question renderer, inbox state machine, validation language, quota model, or audit pipeline.

**Protecting baseline tests reused/extended:** `tests2/core/decision-hook-contract.test.ts`, `tests2/core/decision-request-store.test.ts`, `tests2/core/decision-request-manager.test.ts`, `tests2/integration/extension-decision-requests.test.ts`, `tests2/integration/decision-proposal-routing.test.ts`, `tests2/dom/decision-request-renderer.test.ts`, `tests2/browser/e2e/extension-decision-request.spec.ts`, plus existing pause/resume tests such as `tests2/dom/goal-pause-resume-feedback.test.ts` and `tests2/browser/journeys/goal-paused-banner.journey.spec.ts`.

### B. Rejected — parallel consent coordinator/UI and consent inbox entries

**Data/control flow:** hook → new consent validator/store/manager → new consent-specific REST/WS projection → new card or inbox payload variant → new answer/resume endpoint → adapters back to proposal, trace, and goal routes.

**Candidate seams it would disturb:** it would duplicate or overload `DecisionRequestStore`, `DecisionRequestManager`, `AskUserChoicesWidget`, `DecisionRequestRenderer`, `InboxManager`/`InboxStore`, `ContextTraceStore`, and proposal routing. It would require separate tests beside the exact baseline tests named above and make their rules diverge.

**Failure modes:** two deadline owners can default and deny differently; two cards can answer the same operation; inbox lifecycle and staff-nudge semantics can leak into consent; two audit/dedupe/quota models can disagree after restart; configuration can accidentally acquire a second application route. A separate UI risks losing tested Other, keyboard, ARIA, draft, and multi-tab behavior.

**Defect surface:** a new state file, timer, renderer, transport, inbox variants, migration, test fixture family, and audit/reconciliation path. This is strictly larger than A without a lifecycle/ownership benefit.

**Selection:** A is the smallest robust option. The only new owner is a narrow pause-lifecycle extraction, required because current `nested-goal-routes.ts::executePauseForGoals()` is closure-local and consent must use—not bypass—the canonical durable pause/cancel/broadcast/abort behavior.

## Additive contracts and validation

Keep the existing single-choice `ExtensionDecisionRequest`, `DecisionOption`, `DecisionOtherSchema`, and `DecisionValue` contract in `src/server/agent/decision-hook-contract.ts`. Do **not** add a shared request module or replace it with a multi-question `UserQuestion` representation.

```ts
type DecisionClass = "advisory" | "deferrable" | "consent-required";
type ConsentTimeoutAction = "deny-operation" | "pause-goal";
type TrustedConsentReason =
  | "extension-requested"
  | "hard-cap-override"
  | "unsafe-tool"
  | "capability-escalation"
  | "grant-change"
  | "configuration-change";

// Additive fields on the existing request. Advisory remains ExtensionAdvisory.
interface ExtensionDecisionRequest {
  version: 1;
  key: string;
  title: string;
  question: string;
  options: readonly DecisionOption[];
  other: DecisionOtherSchema;
  default?: DecisionValue;
  scope: DecisionScope;
  deadlineAt: string;
  effect?: DecisionEffect;
  requestedClass?: "deferrable" | "consent-required"; // absent means deferrable compatibility
  intent?: string; // bounded known routing id, never authority
}

interface TrustedDecisionOperation {
  id: string; // server-owned opaque operation identity
  kind: "tool-call" | "budget-override" | "goal-work" | "configuration";
  hardCapOverride?: "core-hard-cap";
  toolSafety?: "safe" | "unsafe";
  change?: "none" | "capability-escalation" | "grant-change" | "configuration-change";
  timeoutAction?: ConsentTimeoutAction; // core-selected only
}
```

`validateDecisionHookOutput()` retains all current bounds, unknown-key rejection, option uniqueness, Other safe-regex validation, `validateDecisionValue()`, ISO deadline checks, and proposal JSON validation. It validates `requestedClass`/`intent` as bounded enums/identifiers. It produces a candidate request; `DecisionRequestManager.create()` combines it with `TrustedDecisionOperation` at the actual core choke point and creates the normalized persisted request:

| Effective class | Required before persistence | Forbidden before persistence | Existing surface reused |
|---|---|---|---|
| `advisory` | current `ExtensionAdvisory` validation | decision request/card/default/deadline | existing `InboxManager.enqueue(..., { wake: false })` |
| `deferrable` | current question/options/Other/deadline and `default` that passes current `validateDecisionValue()` | missing or invalid default | current request/store/widget/default timer |
| `consent-required` | current question/options/Other/deadline | `default` in normalized persisted request; extension timeout action | current request/store/widget/answer route, with fail-closed settlement |

A directly requested `consent-required` declaration containing `default` is invalid. When trusted platform classification forces an otherwise valid requested deferrable/default request to consent, the manager removes the candidate default while normalizing; it is never persisted, returned by REST, defaulted, memoized, or delivered to a continuation. This permits core hardening of an untrusted request without manufacturing a new question shape.

## Trusted platform classification

Implement `classifyEffectiveClass()` as a private helper in `src/server/agent/decision-request-manager.ts` (export it only from that file if the focused manager test needs direct coverage). It accepts only the validated candidate request plus server-derived `TrustedDecisionOperation`, returns `{ decisionClass, classificationReason, timeoutAction? }`, and uses the existing manager rather than a new classifier service.

The result is the stricter of extension request and trusted floor. Mandatory consent floors are:

1. `hardCapOverride === "core-hard-cap"`, supplied only by the pre-dispatch/override consumer of `src/server/agent/budget-enforcement.ts`.
2. `toolSafety === "unsafe"`, supplied only by the core tool-call safety analyzer at the tool application choke point.
3. `change` equal to capability escalation, grant change, or configuration change, supplied only by the core mutation/proposal owner.

The first matching trusted reason is recorded as a fixed safe enum. Otherwise a requested consent remains consent and a requested/implicit deferrable remains deferrable. The extension cannot provide any trusted field, set `timeoutAction`, claim a safety verdict, or downgrade strictness. Core selects `deny-operation` for a current unsafe tool/budget override and `pause-goal` for work whose goal cannot safely progress without the decision; both values are invalid for non-consent records.

`src/server/agent/budget-enforcement.ts` continues to expose its existing `hardCapOverride` tag; no cost display or post-turn `CostTracker` observation becomes a classification input. `src/server/agent/tool-guard-extension.ts` and `src/server/agent/session-manager.ts` use the manager's denied settlement result to retain the existing `block: true` behavior. Silence never creates a one-time, session, or persistent tool grant.

## Store, settlement, and restart

Extend—not replace—`src/server/agent/decision-request-store.ts` and its `StoredDecisionRequest`:

```ts
type DecisionStatus =
  | "pending" | "resolved" | "defaulted" | "denied"
  | "paused-awaiting-consent" | "rejected" | "expired" | "superseded";

interface AwaitingConsentPauseReason {
  kind: "awaiting-extension-consent";
  requestId: string;
  createdAt: string;
}

interface StoredDecisionRequest {
  // Existing ids, origin, dedupeId, questionId, request, scope, timestamps,
  // resolution, proposal, continuation fields remain authoritative.
  decisionClass?: "deferrable" | "consent-required";
  classificationReason?: TrustedConsentReason;
  timeoutAction?: ConsentTimeoutAction;
  protectedOperation?: { id: string; kind: TrustedDecisionOperation["kind"] };
  pause?: {
    goalId: string;
    reason: AwaitingConsentPauseReason;
    state: "intent-recorded" | "paused" | "resume-requested" | "resumed" | "already-resumed" | "not-matching";
  };
}
```

Keep the current state file, temp-write/rename publication, defensive clones, exact memory identity, dedupe fingerprint, retention, and request budgets. Add narrow store methods beside `writeTerminalFirst()` rather than a second transaction layer:

```ts
writeConsentPauseFirst(id, resolvedAt, pause): FirstTerminalWrite;
claimConsentResume(id, goalId, reason): "claimed" | "already-claimed" | "not-matching";
completeConsentResume(id, result): boolean;
```

`writeTerminalFirst()` is extended so deferrable deadline/headless records write `status: "defaulted"` with their already-validated default; an on-time user answer writes `resolved`. `writeConsentPauseFirst()` atomically writes `status: "paused-awaiting-consent"` and the exact pause intent. Consent deny writes `status: "denied"` with no default, no decision memory permit, and no protected-operation continuation. Existing historical `resolved`/`expired` records remain readable; the loader treats them as baseline deferrable terminal history without rewriting them solely for this delta.

### First writer, timeout, and recovery

The existing manager remains the sole mutator and its single earliest-deadline timer remains the only timer.

1. All create, GET/answer, timer, and startup reconciliation paths reconcile the absolute deadline and use the store's first-terminal write. The durable winner of answer vs expiry/headless wins; retries/multi-tab/restart return it.
2. Deferrable deadline/headless applies only the validated stored default and records `defaulted`/safe-default actor. Missing default never reaches persistence.
3. Consent deadline/headless selects the core timeout action. `deny-operation` terminalizes `denied`; `pause-goal` terminalizes `paused-awaiting-consent` with a durable pause intent before any external pause call. Neither permits the current operation, creates a grant, invokes a protected continuation, or applies a default.
4. Startup reconciliation completes a durable pause intent before allowing related work. A crash after pause but before bookkeeping is safe because reapplying a pause with the same structured reason is idempotent. A crash after answer but before matching resume finishes the stored resume claim only; it never re-answers, defaults, or resumes an unrelated goal.
5. No expected consent timeout path reports failed/stalled/blocked, fails a gate, or emits a failed verification. The goal is canonically `paused: true` until the exact consent pause is resolved.

### Settlement grant recheck

The baseline dispatcher keeps its fresh `decide` grant checks immediately before `decide()` and `onDecision()`. Before a user consent answer is used for any protected continuation, `DecisionRequestManager` rebuilds active hook identity from `PackContributionRegistry`, re-reads `ProjectConfigStore.getExtensionGrants()`, and re-reads trusted core safety/hard-cap/change facts where the operation is still live.

If any check is missing, revoked, inactive, changed to unsafe, or fails to read, protected work remains blocked. For consent, the manager records the corresponding deny/pause settlement and does not invoke the operation continuation; an already durable user answer is history, never an execution permit. It repeats that recheck immediately before an eventual protected continuation so a revoke racing the answer cannot become an allow. A later tool retry always passes normal policy/analyzer/classification again. Configuration answers call only `ProposalSeedService.seedFromDecision()`; no answer calls a `ProjectConfigStore` setter or applies a grant/config directly.

## Canonical consent pause and exact resume

### Required narrow extraction

Create `src/server/agent/goal-pause-service.ts` and move the reusable mechanics currently closure-local in `src/server/agent/nested-goal-routes.ts`:

- `executePauseForGoals()`'s top-down selected target pause;
- `GoalManager.updateGoal()` durability;
- cancellation of in-flight verification;
- `goal_state_changed` broadcast;
- aborting other streaming sessions.

The existing pause REST route retains authorization, request validation, target/cascade selection, and its public contract. Replan-overflow uses the same service. This is a behavior-preserving extraction, not a pause redesign.

Add only the required structured field to `PersistedGoal` in `src/server/agent/goal-store.ts`:

```ts
pauseReason?: { kind: "awaiting-extension-consent"; requestId: string; createdAt: string };
```

The pause service accepts this optional core-generated reason. Existing manual/replan paths clear it when they establish a later pause, so an old consent card cannot clear the new pause. It contains no question, answer, prose, tool argument, config, or secret.

Add `resumeOnlyAwaitingConsentGoal()` in `src/server/agent/goal-resume.ts`. It re-reads the goal and calls the existing durable resume/update/broadcast path only when `paused === true` and `pauseReason.kind`, `requestId`, and `createdAt` exactly match. It returns `resumed`, `already-resumed`, or `not-matching`; it must not call the ordinary broad `resumeOperatorPausedGoal()` for a consent card.

### One answer-and-resume endpoint action

Keep `POST /api/sessions/:sessionId/decision-requests/:requestId/answer` in `src/server/server.ts`. It is the only client action; do not issue a follow-up client `POST /goals/:id/resume`.

For `paused-awaiting-consent`, the route/manager validates the current stored single question, claims the exact stored pause, and calls `resumeOnlyAwaitingConsentGoal()` with that request's reason. The manager persists `resumed`, `already-resumed`, or `not-matching` under the request, then emits the current decision invalidation and `goal_state_changed` projection. Duplicate requests return the stored result.

If an operator resume won, `already-resumed` is harmless. If a manual/replan/different consent pause replaced the reason, `not-matching` leaves that goal paused and exposes only its normal resume control. Answering a pause card therefore never resumes a manually paused or different paused goal.

## Exact file map and projections

| File | Bounded change |
|---|---|
| `src/server/agent/decision-hook-contract.ts` | Add request class/intent fields and class-specific presence rules while retaining current one-choice option/Other/default validation. |
| `src/server/agent/decision-request-store.ts` | Add additive class/status/operation/pause fields and three narrow CAS helpers in the existing JSON store. |
| `src/server/agent/decision-request-manager.ts` | Add private trusted classification, normalize forced consent without default, timeout deny/pause, settlement recheck, recovery, exact-resume coordination. Reuse current timer/dedupe/budgets/advisory/proposal/trace methods. |
| **new** `src/server/agent/goal-pause-service.ts` | Extract existing pause cascade mechanics so consent uses the canonical owner. |
| `src/server/agent/nested-goal-routes.ts` | Delegate its existing manual/replan pause execution to the extracted service; retain route ownership. |
| `src/server/agent/goal-store.ts`, `src/server/agent/goal-resume.ts` | Persist/validate exact structured reason and conditionally resume it. |
| `src/server/agent/budget-enforcement.ts`, `src/server/agent/tool-guard-extension.ts`, `src/server/agent/session-manager.ts` | Feed trusted core hard-cap/unsafe facts at existing application choke points and preserve fail-closed tool denial/no-grant behavior. |
| `src/server/server.ts` | Wire pause service into manager and extend the current decision projection/answer route. No new decision route or direct config route. |
| `src/server/agent/context-trace-store.ts` | Allow-list fixed class/status/reason/default/resume fields; retain EP-5 caps/redaction. |
| `src/server/proposals/proposal-seed-service.ts` | Reuse unchanged proposal-only configuration effect. |
| `src/server/ws/protocol.ts`, `src/server/ws/handler.ts` | Retain metadata-only `decision_requests_updated`; reuse `goal_state_changed`. |
| `src/app/extension-decisions.ts`, `src/ui/tools/renderers/DecisionRequestRenderer.ts`, `src/ui/components/AgentInterface.ts` | Keep existing widget/card; treat `paused-awaiting-consent` as actionable for the same answer POST, terminal deny/default as read-only. |
| `src/app/state.ts`, `src/app/render.ts`, `src/app/goal-dashboard.ts`, `src/app/goal-dashboard-children-tab.ts`, `src/app/plan-node-state.ts` | Project `pauseReason`; render “Awaiting consent” only for its exact kind, otherwise existing paused UI. Never project it as failed/stalled/blocked. |

Advisory needs no new renderer, state machine, inbox type, or deadline work: its current validated output, non-waking inbox source, broadcast, and existing inbox lifecycle remain authoritative.

## Safe audit, UI, and effects

- Existing `AskUserChoicesWidget` retains Other, validation, keyboard, accessibility, drafts, and multi-tab behavior. `DecisionRequestRenderer` keeps posting only to the typed decision route—never an ask envelope or agent prompt.
- The existing pending decision GET projection becomes an **actionable** projection: it includes `pending` plus matching `paused-awaiting-consent` records for its session. Other terminal records are read-only route results, not a second transcript history. This keeps the paused question answerable after timeout.
- Advisory remains inbox-only and non-interrupting. It consumes no decision interruption budget and never wakes/nudges staff.
- Current dedupe and server-owned request/interruption limits remain untouched. Budget refusal remains loud in safe trace and never becomes a default/allow.
- Context trace records only safe enum/id fields: class, trusted classification reason, terminal status, default-applied flag, timeout action, exact-resume result, opaque request/question identity, and safe selected option id/`other`. It excludes question/option/Other prose, operation data, tool arguments, cost/cap values, proposal/config args, credentials, and transcript text. Existing EP-5 retention/redaction limits remain authoritative.

## Focused test plan

All tests are registered in `tests2/tests-map.json`; extend baseline suites rather than introducing parallel infrastructure.

| Layer | File | Required coverage |
|---|---|---|
| Core | `tests2/core/decision-hook-contract.test.ts` | Advisory stays separate/no deadline; deferrable demands a current-valid default; consent forbids default; forced consent strips requested deferrable/default before persistence; malformed class/intent/default fails closed. |
| Core | `tests2/core/decision-request-store.test.ts` | Additive persisted fields, no consent default, first-writer terminal race, pause intent and resume claim persistence, corrupt store fail-closed, existing dedupe/memory/retention unaffected. |
| Core | `tests2/core/decision-request-manager.test.ts` | Trusted floor precedence; every requested deferrable/default-allow forced to consent at hard cap/unsafe/change; deferrable deadline/headless default; both consent timeout actions; no protected work/grant/side effect on silence; revoke/answer/expiry races; restart reconciliation. |
| Core | **new** `tests2/core/goal-pause-service.test.ts` | Extracted pause still cancels/broadcasts/aborts; matching reason resumes exactly once; manual/replan/different consent reason cannot be cleared by an answer. |
| Core | `tests2/core/context-trace-store.test.ts` | New safe enums accepted; answer/question/operation/cap/config prose rejected; EP-5 caps unchanged. |
| Integration | `tests2/integration/extension-decision-requests.test.ts` | End-to-end platform forced consent despite requested deferrable/default; revocation recheck; active projection of actionable paused consent; advisory remains durable/no wake/no interruption; existing budgets/dedupe still govern. |
| Integration | **new** `tests2/integration/consent-pause-recovery.test.ts` | Deny timeout blocks exact current operation with no grant; pause timeout persists reason and goal is paused-not-failed; restart completes one pause intent; answer/restart resumes once; operator already-resumed and manual-pause protection. |
| Integration | `tests2/integration/decision-proposal-routing.test.ts` | Capability/grant/config answers seed existing proposal only; no config/grant write before ordinary proposal acceptance. |
| DOM | `tests2/dom/decision-request-renderer.test.ts` | Existing widget/Other path and typed POST retained; paused consent remains answerable; terminal deny/default read-only; no transcript envelope/wake. |
| Browser | `tests2/browser/e2e/extension-decision-request.spec.ts` and **new** `tests2/browser/e2e/consent-pause-recovery.spec.ts` | Advisory does not interrupt; forced consent displays no default; silence leaves protected work absent; pause shows Awaiting consent rather than failure; reload/restart persists; one answer resumes exact pause only. |

Race tests use the existing injected `Clock`, memfs, manager dependencies, and a pause-service fake; no wall-clock sleeps. Required explicit assertions:

1. answer-before-expiry and expiry-before-answer have one durable winner;
2. `deny-operation` produces no operation side effect or tool grant;
3. `pause-goal` is paused, not failed/stalled, and recovery does not duplicate pause/default/action;
4. one answer performs matching resume once; manual/different pauses remain intact;
5. revoked grants at settlement cannot permit work across answer/expiry/restart races;
6. advisory remains noninterrupting and protected work is absent on silence.

```bash
npx vitest run \
  tests2/core/decision-hook-contract.test.ts \
  tests2/core/decision-request-store.test.ts \
  tests2/core/decision-request-manager.test.ts \
  tests2/core/goal-pause-service.test.ts \
  tests2/integration/extension-decision-requests.test.ts \
  tests2/integration/consent-pause-recovery.test.ts \
  tests2/integration/decision-proposal-routing.test.ts \
  --config vitest.config.ts --retry=0
BOBBIT_V2_RETRY_FREE=1 npm run test:browser -- \
  tests2/browser/e2e/extension-decision-request.spec.ts \
  tests2/browser/e2e/consent-pause-recovery.spec.ts --retries=0
```

## Scope ledger

| Category | Items |
|---|---|
| **Must deliver** | Additive three-class validation, trusted platform floors, consent no-default guarantee, deny/pause timeout behavior, exact durable pause/resume, settlement grant recheck, restart/race recovery, proposal-only config effects, existing UI/inbox/budget/audit reuse, and focused test coverage. |
| **Allowed bounded improvements** | Extract the current canonical pause mechanics into one internal service; add structured core-owned `pauseReason`; add safe status/projection/trace enums needed for consent. |
| **Deferred / out of scope** | Rebuilding or parallelizing decision store/widget/inbox/validation/dedupe/budgets/audit; shared contract abstraction; multi-question decision model; new Host API/generic hook engine; a second consent UI/route/protocol; extension-selected timeout policy; direct config/grant application; answer-derived execution permits; changes to general manual pause/resume semantics or EP-5/EP-6 ownership. |
