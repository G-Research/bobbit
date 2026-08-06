# EP-11 Consent Hardening

**Status:** implementation-ready delta design  
**Baseline:** merged `docs/design/ep-11-decision-requests.md` decision store, manager, widget adapter, advisory inbox path, proposal seed service, dedupe, quotas, and safe Context trace.

## Decision

Harden the existing default/deadline decision baseline into three server-enforced classes without replacing its owners:

- `advisory` is a durable, non-waking inbox item only. It has no question, deadline, default, interrupt, continuation, or protected-operation permit.
- `deferrable` has questions, a deadline, and one schema-valid **safe default**. Deadline or headless settlement applies that default, records `defaulted`, and only releases the pre-declared safe continuation.
- `consent-required` has questions and a deadline but **never** a default. Silence, headless mode, expiration, revocation, or a race can only deny the current protected operation or pause its goal. They cannot create a grant, execute protected work, or permit a later operation.

The platform computes the effective class from trusted operation facts and the extension's requested class. An extension may request a stricter class, but it can never lower a platform floor or choose the consent fail-closed action. Existing `DecisionRequestStore`, `DecisionRequestManager`, `AskUserChoicesWidget`, `InboxManager`, `ProposalSeedService`, validation, semantic dedupe, interruption budgets, and `ContextTraceStore` remain the respective owners.

## Baseline seams to retain

| Owner | Existing seam | Hardening responsibility |
|---|---|---|
| `src/server/agent/decision-hook-contract.ts` | Strict untrusted hook-output validator for a single-choice request with required `default`, ISO deadline, proposal effect, and advisory. | Version the request shape additively to express class/intent; enforce the three class-specific declarations before persistence. Reuse its bounded text, option/Other, JSON, and regex validation rather than creating another validator. |
| `src/server/agent/decision-request-store.ts` | Project-owned atomic JSON state at `.bobbit/state/extension-decision-requests.json`; first-terminal-write and exact scope memory. | Persist class, terminal cause, protected-operation identity, and durable pause intent/recovery fields in the same store; do not create a consent store. |
| `src/server/agent/decision-request-manager.ts` | Sole mutation facade: create, answer, deadline/headless reconciliation, dedupe, existing budgets, proposal route, continuation replay, metadata invalidation. | Own classification application, consent terminalization, operation settlement, pause recovery, and matching answer-and-resume. It remains the only answer/expiry writer. |
| `src/server/agent/nested-goal-routes.ts` | Closure-local `executePauseForGoals()` is the current single pause cascade owner; it sets `paused`, cancels verifications, broadcasts, and aborts other streaming sessions. | Extract its reusable internal behavior into a narrow goal-pause lifecycle service. Consent must call that service, never write `goal.paused` directly. |
| `src/server/agent/goal-resume.ts::resumeOperatorPausedGoal()` | Durable primitive that clears `paused`, stale merge-conflict state, and broadcasts. | Add an exact-reason conditional resume primitive; the operator route continues to use ordinary resume semantics. |
| `src/server/agent/budget-enforcement.ts` | Trusted pre-dispatch request exposes `hardCapOverride: "core-hard-cap"`; result labels consent as `hard-cap-override`. | Pass this trusted tag to the classifier at the consumer choke point; never derive it from a hook payload, cost display, or post-turn tracker. |
| `src/server/agent/tool-guard-extension.ts` and `src/server/agent/session-manager.ts` | Existing ask-policy tool long-poll and deny path. | Add/compose a guarded consent decision at the actual tool safety/permission application point. On silence it returns the existing fail-closed blocked shape and creates no one-time/session/persistent grant. |
| `src/server/proposals/proposal-seed-service.ts` | Answer effects seed editable proposal drafts. | Configuration/capability answers stay proposal-only. No decision code calls `ProjectConfigStore.setExtensionGrants()` or another config writer. |
| `src/server/agent/inbox-manager.ts` | `enqueue(..., { wake: false })` persists/broadcasts advisory entries without `InboxNudger.poke()`. | Retain this exactly for advisory projection; no advisory becomes an interactive decision. |
| `src/ui/components/AskUserChoicesWidget.ts` and `src/ui/tools/renderers/DecisionRequestRenderer.ts` | Existing question/Other UI with decision POST transport adapter. | Extend only data projection/status handling. Do not create consent-specific choice controls or an agent ask envelope. |
| `src/server/agent/context-trace-store.ts` | Bounded EP-5 allow-listed decision/advisory rows. | Record safe class/status/reason/default/resume outcome identifiers only; retain audit limits/redaction. |

## Contracts and classification

### Shared request contract

Add a serializable shared contract at **new** `src/shared/extension-host/decision-request-contract.ts`; `src/server/agent/decision-hook-contract.ts` imports/re-exports its validated types as appropriate. Keeping serializable request vocabulary in `shared` lets server and UI project the same fixed enums without making the UI authoritative.

```ts
type DecisionClass = "advisory" | "deferrable" | "consent-required";
type ConsentTimeoutAction = "deny-operation" | "pause-goal";
type DecisionState =
  | "pending" | "answered" | "defaulted"
  | "denied" | "paused-awaiting-consent";
type DecisionAnswerSource = "user" | "safe-default";

type TrustedConsentReason =
  | "extension-requested"
  | "hard-cap-override"
  | "unsafe-tool"
  | "capability-escalation"
  | "grant-change"
  | "configuration-change";

interface ExtensionDecisionRequest {
  version: 2;
  key: string;
  scope: "session" | "goal" | "project";
  intent: string;                         // bounded routing label; never authority
  requestedClass: DecisionClass;
  title: string;
  questions?: readonly UserQuestion[];
  safeDefaultAnswers?: readonly UserQuestionAnswer[];
  deadlineAt?: string;
  effect?: { kind: "none" } | { kind: "proposal"; proposals: Record<string, ProposalSeed> };
}

interface TrustedDecisionClassificationInput {
  intent: string;
  requestedClass: DecisionClass;
  hardCapOverride?: "core-hard-cap";
  toolSafety?: "safe" | "unsafe";
  change?: "none" | "capability-escalation" | "grant-change" | "configuration-change";
  /** Core selects this from the protected operation, never the extension. */
  consentTimeoutAction?: ConsentTimeoutAction;
}

interface EffectiveDecisionClassification {
  decisionClass: DecisionClass;
  reason: TrustedConsentReason;
  timeoutAction?: ConsentTimeoutAction;
}
```

Use existing `UserQuestion`, `UserQuestionAnswer`, `validateQuestions`, `validateAnswers`, and `crossValidate` from `src/server/agent/ask-user-choices-validation.ts`. The baseline's one-question `DecisionValue` adapter may remain internal while the contract supports the existing question validator; implementation must choose one canonical persisted representation and translate at the current renderer boundary, not duplicate validation. Preserve the baseline limits and unknown-key rejection. `intent` is a bounded allow-listed routing identifier, not a free-form tool name, config key, action, or classification tag.

`version: 1` stored baseline records remain readable as `deferrable` only after validating their already-persisted default/deadline. New hook declarations use `version: 2`. A malformed old record, an unknown enum, or a v1 record without a valid default makes that record unavailable and fails closed; it never receives a fabricated safe default.

### Class validation

`validateDecisionHookOutput()` becomes a discriminated validator with these non-negotiable rules:

| Effective class | Required | Forbidden | Settlement |
|---|---|---|---|
| `advisory` | bounded advisory title/body/key and target inbox identity | questions, answers/default, deadline, interactive effect, continuation, interruption budget | ordinary `InboxManager.enqueue(..., { wake: false })`; no card, timer, or protected-operation permit |
| `deferrable` | questions, deadline within current 30-second to 7-day server window, and `safeDefaultAnswers` passing `validateAnswers` + `crossValidate` | no missing/partial/invalid default | user answer → `answered`; deadline/headless → `defaulted` with `safe-default` |
| `consent-required` | questions and bounded deadline | `safeDefaultAnswers`, legacy `default`, or an extension timeout action | user answer → `answered`; deadline/headless/revocation → `denied` or `paused-awaiting-consent` according to trusted core action |

Class-specific validation happens twice: before a new record is persisted and when a persisted record is reloaded/reconciled. The answer route loads the persisted questions/class and accepts only answers valid for them; it never accepts class, timeout action, actor, timestamps, scope, operation identity, proposal arguments, or classification facts from the browser.

### Trusted floor and precedence

Add **new** `src/server/agent/decision-classifier.ts`:

```ts
export const DECISION_CLASS_SEVERITY = {
  advisory: 0, deferrable: 1, "consent-required": 2,
} as const;

export function classifyDecision(
  input: TrustedDecisionClassificationInput,
): EffectiveDecisionClassification;
```

`classifyDecision()` derives its floor only from the supplied trusted facts, then takes `maxSeverity(requestedClass, floor)`. It returns a core-owned reason and, for consent only, the core-owned timeout action.

Mandatory floors, in descending non-bypassable precedence:

1. `hardCapOverride === "core-hard-cap"` is `consent-required` with reason `hard-cap-override`. The tag originates exclusively from `resolveBudgetEnforcement()`/its pre-dispatch consumer, not from extension output.
2. `toolSafety === "unsafe"` is `consent-required` with reason `unsafe-tool`. The fact comes from the core tool-call analyzer at the operation choke point, not a pack assertion.
3. `change` of `capability-escalation`, `grant-change`, or `configuration-change` is `consent-required` with its matching core reason. Configuration/capability proposal effects do not lower this floor.
4. Otherwise, the requested class is effective. A requested `consent-required` remains strict even with no floor; a requested `deferrable` can never make one of the first three cases deferrable.

An extension may therefore raise an ordinary request from advisory to deferrable/consent, but cannot lower strictness, provide a consent default, select `deny-operation`/`pause-goal`, claim an unsafe tool is safe, or supply a hard-cap/config fact. Unsupported intents are rejected. For platform-forced consent that began as a requested `deferrable`, validation is evaluated **after** classification: its proposed default is discarded/rejected before persistence, no default is serialized, and no default can be applied. This is critical: retaining it as an unused field risks a future accidental allow.

The trusted operation owner selects action: immediate tool/safety/hard-cap work uses `deny-operation`; goal-scoped work whose normal queue must not continue uses `pause-goal`. `decision-classifier.ts` asserts a `consent-required` result has exactly one trusted action and no other class has one.

## Persistence, atomicity, and recovery

### Store changes

Extend `src/server/agent/decision-request-store.ts` from version 1 to version 2 with a lazy migration loader. Preserve its temp-write + rename and clone-before-publish discipline. Replace baseline terminal vocabulary (`resolved`/`expired`) only through an explicit migration mapping; public projections use the new semantic states.

```ts
interface AwaitingConsentPauseReason {
  kind: "awaiting-extension-consent";
  requestId: string;
  createdAt: string;
}

interface StoredDecisionRequestV2 {
  // Existing stable ids, origin, dedupe, request payload, question fingerprint,
  // continuation/proposal bookkeeping, timestamps, and scope fields.
  decisionClass: DecisionClass;
  classificationReason: TrustedConsentReason;
  timeoutAction?: ConsentTimeoutAction;
  state: DecisionState;
  answer?: readonly UserQuestionAnswer[];
  answerSource?: DecisionAnswerSource;
  protectedOperation: {
    id: string;             // opaque server-generated/choke-point identity
    kind: "tool-call" | "budget-override" | "goal-work" | "configuration";
  };
  pause?: {
    goalId: string;
    reason: AwaitingConsentPauseReason;
    state: "intent-recorded" | "paused" | "resume-requested" | "resumed" | "not-matching";
  };
}
```

`protectedOperation.id` is opaque and bounded; it is never an executable payload, tool arguments, config arguments, cost, prompt, safety explanation, or secret. It prevents a consent answer from becoming a general grant. The current operation receives the manager's settle result and only the original core owner may decide whether to retry/continue a safe predeclared path.

Add atomic store methods rather than scattered `put()`/`writeTerminalFirst()` calls:

```ts
createClassified(record, counters): CreateResult;
settleFirst(id, terminal, memory?, pauseIntent?): FirstSettlement;
markPauseApplied(id, expectedReason): boolean;
claimMatchingResume(id, goalId, expectedReason): ResumeClaim;
completeMatchingResume(id, result): boolean;
```

Each method clones, validates the current expected state/identity, writes one snapshot, renames it, and only then publishes memory. A write failure changes neither memory nor status and reports a fixed store failure. Quota/counter accounting remains in that same publication as record creation so concurrent requests cannot overrun a cap.

### First-writer and restart rules

`DecisionRequestManager` remains the only caller of terminal/settlment methods. Its single earliest-deadline timer, creation, answer, route reads, and boot reconciliation all call `reconcileOne()` before acting.

1. The first durable `pending → terminal` CAS wins. Answer-versus-expiry, headless-versus-answer, repeated POST, reload, and two gateway recovery attempts observe that winner and return its stored result.
2. For a deferrable record, only an on-time valid user answer can write `answered`; deadline/headless writes `defaulted` with the prevalidated safe default.
3. For consent, expiry/headless/revocation can write only `denied` or `paused-awaiting-consent`; neither writes answers/defaults/memory permits. A race with a user answer returns the first stored terminal state. If an answer wins, settlement still rechecks the grant/facts before allowing the protected operation.
4. If a crash occurs after a consent `pause` intent is durable but before canonical pause completes, startup reconciliation applies it idempotently. If a crash follows the actual pause but precedes `markPauseApplied`, reapplying sees the matching persisted reason and is a no-op.
5. If a crash happens after an answer is durable but before matching resume completes, reconciliation continues the stored resume claim. It never invokes a new answer/default or resumes a goal not carrying that exact reason.
6. A stale card after any terminal state reloads/returns its terminal projection; it cannot start a fresh protected operation.

No timeout/pause path reports the goal as failed, stalled, blocked, a failed gate, or a failed verification. The request's durable state is an expected waiting condition, and `paused: true` continues to be the canonical goal lifecycle representation.

### Revocation at settlement

The dispatcher retains its baseline fresh `decide` grant check before `decide()` and `onDecision()`. Add a fresh authorization/classification recheck in `DecisionRequestManager.settleProtectedOperation()` immediately before any answer could be used:

- Rebuild active hook identity from `PackContributionRegistry` and re-read `ProjectConfigStore.getExtensionGrants()`.
- Re-read the trusted core operation result (tool safety/hard-cap/change classification); do not trust the record alone if the operation still exists.
- A missing/revoked/inactive grant or a recheck failure cannot deliver a continuation or permit work. For consent it routes through that record's fail-closed action; for deferrable it does not turn an invalid/revoked result into an allow.
- A later retry of a tool call independently re-enters normal policy, analyzer, and classifier checks. No answer mints a tool grant or bypasses a newly revoked policy.

This closes answer/expiry/restart/revoke races without trying to retroactively cancel already-durable proposal drafts or completed side effects.

## Canonical consent pause and matching resume

### Extract the lifecycle owner

Create **new** `src/server/agent/goal-pause-service.ts`. Move the reusable implementation now closure-local to `src/server/agent/nested-goal-routes.ts` into this service, preserving behavior and route authorization at the route layer.

```ts
export type GoalPauseReason =
  | { kind: "manual" }
  | { kind: "replan-overflow" }
  | { kind: "awaiting-extension-consent"; requestId: string; createdAt: string };

export interface GoalPauseService {
  pause(targets: PersistedGoal[], options: {
    callerSessionId?: string;
    reason: GoalPauseReason;
  }): Promise<{ paused: number }>;
  resumeOnlyAwaitingConsent(goalId: string, reason: Extract<GoalPauseReason, {
    kind: "awaiting-extension-consent";
  }>): Promise<"resumed" | "already-resumed" | "not-matching">;
}
```

Move `cancelAllVerifications()`, top-down cascade effects, `GoalManager.updateGoal()`, `broadcastToAll({ type: "goal_state_changed" })`, and streaming session abort behavior behind this service. `nested-goal-routes.ts` remains responsible for HTTP auth, body validation, target selection, and uses `reason: { kind: "manual" }`; its replan overflow caller uses `replan-overflow`. This refactor must be behavior-preserving for existing pause/resume tests.

Extend `PersistedGoal` in `src/server/agent/goal-store.ts` with:

```ts
pauseReason?: GoalPauseReason;
```

It is core-owned structured JSON: no arbitrary strings, user prose, request answer, question, tool arguments, or config. `GoalStore` validates/migrates it defensively. `goal-pause-service.ts` writes `paused: true, pauseReason` in the same goal-store update; regular operator pauses replace an old consent reason with `manual`.

Extend `src/server/agent/goal-resume.ts` with `resumeOnlyAwaitingConsentGoal(...)`, which re-reads the goal and clears pause only if **both** `paused === true` and `pauseReason.kind/requestId/goalId` match. It uses the existing durable update/broadcast mechanism, clears `pauseReason`, and retains the existing merge-conflict cleanup behavior. Ordinary `resumeOperatorPausedGoal()` clears any operator pause as it does today, including `pauseReason`; it is not used by a consent answer.

### One answer-and-resume action

`POST /api/sessions/:sessionId/decision-requests/:requestId/answer` remains the single UI answer endpoint. Do not add a client-side `POST /goals/:id/resume` follow-up. For a pending matching consent-pause request, the manager performs:

1. authenticate/session-match and validate answer against stored questions;
2. use the request CAS to write `answered` and a durable `resume-requested` claim;
3. re-read the goal through `GoalPauseService.resumeOnlyAwaitingConsent()` using `{ kind: "awaiting-extension-consent", requestId, createdAt }` from the durable record;
4. mark `resumed`, `already-resumed`, or `not-matching` in the decision record and publish both decision and goal invalidations.

Repeated POSTs return the stored terminal/resume result. If an operator resumed first, return `already-resumed` without resurrecting a session turn. If an operator/manual/replan pause replaced the reason first, return a durable answered request with `not-matching`; leave the goal paused and expose its normal Resume control. This protects manually paused or differently paused goals from a stale consent card.

For a timed-out `pause-goal` consent, `settleFirst()` writes `paused-awaiting-consent` plus the pause intent before calling `GoalPauseService.pause()`. The service pauses precisely the affected goal/cascade selected by the core operation—not an extension-provided goal id—and exposes the request reason. The answer endpoint operates only on that stored `pausedGoalId` and exact reason.

## Server integration map

| File | Change |
|---|---|
| **new** `src/shared/extension-host/decision-request-contract.ts` | Serializable class/state/intent/classification types and version-2 request shape. |
| `src/server/agent/decision-hook-contract.ts` | Validate advisory/deferrable/consent declarations with current bounded primitives. Reject defaults on effective consent before store persistence. |
| **new** `src/server/agent/decision-classifier.ts` | Pure precedence function and trusted class/action input. Unit-testable with no manager/server. |
| `src/server/agent/decision-request-store.ts` | Version-2 migration, state/CAS/pause intent/resume bookkeeping, defensive persisted validation. Retain one state file and existing dedupe/memory/retention discipline. |
| `src/server/agent/decision-request-manager.ts` | Classify before create; settlement state machine; fresh grant/fact recheck; deny/pause dispatch; startup recovery; one action answer-and-matching-resume. Reuse timers, quotas, dedupe, advisory/proposal/trace seams. |
| **new** `src/server/agent/goal-pause-service.ts` | Extract canonical pause cascade and exact consent resume composition. |
| `src/server/agent/nested-goal-routes.ts` | Delegate existing manual/replan pause behavior to `GoalPauseService`; no consent-specific route. |
| `src/server/agent/goal-store.ts` | Add validated `pauseReason` to `PersistedGoal`. |
| `src/server/agent/goal-resume.ts` | Add exact-reason conditional resume primitive; preserve general resume behavior. |
| `src/server/agent/budget-enforcement.ts` | Preserve its result; make trusted `hard-cap-override` handoff explicit to the classifier consumer. |
| `src/server/agent/tool-guard-extension.ts`, `src/server/agent/session-manager.ts` | At the core tool permission/safety choke point, map an unapproved consent to existing `block: true`; ensure no tool grant is saved on silence. The eventual core unsafe analyzer seam must feed `toolSafety: "unsafe"` here. |
| `src/server/agent/project-config-store.ts`, `src/server/agent/extension-grant-policy.ts` | Reuse fresh exact-grant reads. Do not add a direct configuration mutation capability; if an interrupt grant/cap has to be represented, validate it in project config as server-owned policy. |
| `src/server/server.ts` | Construct `GoalPauseService`, pass trusted project/goal/session lookup and invalidators into the manager, and preserve the existing decision GET/POST routes. Project only safe new class/status/pause fields. |
| `src/server/agent/lifecycle-hub.ts` | Continue detached bounded dispatcher invocation. Its request context may carry only server-derived classification input for known intents, never arbitrary prompt/tool payload. |
| `src/server/agent/context-trace-store.ts` | Extend allow-lists for class, classification reason, terminal status, `defaultApplied`, timeout disposition, and matching-resume result. |
| `src/server/proposals/proposal-seed-service.ts` | No new apply behavior. Enforce proposal-only routing for any capability/grant/config request. |
| `src/server/ws/protocol.ts`, `src/server/ws/handler.ts` | Keep metadata-only `decision_requests_updated`; use existing `goal_state_changed` for pause/resume. No answer/question payload in WS. |
| `src/app/extension-decisions.ts` | Parse bounded class/status/timeout/resume projections and refresh after current WS invalidation. Never infer authority client-side. |
| `src/ui/tools/renderers/DecisionRequestRenderer.ts` | Reuse widget. Render terminal/pause state read-only and allow the existing answer POST to own resume. |
| `src/ui/components/AgentInterface.ts` | Continue mounting existing decision adapters after messages; no new interruption component. |
| `src/app/state.ts`, `src/app/render.ts`, `src/app/goal-dashboard.ts`, `src/app/goal-dashboard-children-tab.ts`, `src/app/plan-node-state.ts` | Carry/project `pauseReason`; label an exact matching reason as “Awaiting consent.” Preserve paused styling/status and normal pause/resume controls; never map it to failed/stalled/blocked. |

## UI, inbox, effects, and audit

- A pending `deferrable` or `consent-required` card continues to use `AskUserChoicesWidget`, including Other, keyboard, ARIA, drafts, and read-only answers. The renderer calls only the typed decision-answer POST—never the `ask_user_choices` transcript envelope or `SessionManager.enqueuePrompt()`.
- A consent-paused goal shows “Awaiting consent” in the existing chat paused banner, dashboard, and descendant/plan projections when, and only when, `pauseReason.kind === "awaiting-extension-consent"`. It remains visibly paused rather than failed. A generic/manual pause stays “This goal is paused.”
- `advisory` writes one bounded normal inbox item through the current no-wake path. It does not create an interactive card, deadline timer, scope memory, continuation, interruption quota use, or agent nudge.
- Existing decision dedupe and budgets remain authoritative. Advisory does not consume interrupt budgets; deferrable/consent checks the existing server-owned cap before display. Budget refusal is loud in safe audit but never silently converts to default/allow.
- `effect.kind: "proposal"` retains its existing server-only `ProposalSeedService.seedFromDecision()` route. Consent answers can seed an editable proposal, but cannot apply grants/config/capabilities directly; proposal acceptance remains the sole mutation path.
- Context trace records only fixed identifiers: class, core classification reason, status, whether a safe default applied, timeout action, resume outcome, opaque request fingerprint/id, safe option id/`other`, and current allowed actor/reason enums. It excludes question/label/Other prose, answers, operation payload, tool arguments, cost/cap amounts, config/proposal args, credentials, and prompt/transcript content. Existing trace size/row caps and sanitizer remain authoritative.

## Test plan

Register all new tests in `tests2/tests-map.json`; extend existing tests rather than creating a parallel test harness.

| Layer | Files | Coverage |
|---|---|---|
| Core | **new** `tests2/core/decision-classifier.test.ts` | Severity precedence; extension may raise but not lower; each platform floor; requested deferrable/default is forced to consent with no persisted default; only core selects deny/pause. |
| Core | `tests2/core/decision-hook-contract.test.ts` | Class-specific required/forbidden fields, `validateAnswers`/`crossValidate` safe default validation, default-free consent, invalid persisted/default v1 migration, advisory no-question contract. |
| Core | `tests2/core/decision-request-store.test.ts` | V2 migration, atomic first settlement, quota/dedupe preservation, no default persisted for consent, pause intent/claim transitions, defensive/corrupt-state failure, first-writer races. |
| Core | **new** `tests2/core/goal-pause-service.test.ts` | Extracted pause preserves cancel/broadcast/stream abort semantics; exact reason resume works; manual/different/replan pauses do not resume. |
| Core | `tests2/core/decision-request-manager.test.ts` | Deferrable deadline/headless defaults; consent deny and consent pause timeout paths; denied protected operation has no continuation/grant/side effect; expiry/answer/revoke race; recheck revocation; interruption cap and advisory non-interruption; idempotent answer-and-resume. |
| Core | `tests2/core/context-trace-store.test.ts` | Safe class/status/reason/resume allow-list; reject prose, operation data, answers and cap values; preserve EP-5 bounded retention. |
| Integration | `tests2/integration/extension-decision-requests.test.ts` | Platform forces consent despite requested deferrable/default-allow at hard-cap, unsafe-tool, and change inputs; current protected tool operation is blocked on silence; no persisted tool grant; direct retry rechecks. |
| Integration | **new** `tests2/integration/consent-pause-recovery.test.ts` | Consent pause persists structured exact reason, goal projects paused-not-failed, restart completes an intent without duplicate pause/default/action, answer-and-resume recovers after crash, and manual/different pause protection. |
| Integration | `tests2/integration/decision-proposal-routing.test.ts` | Capability/grant/config answer seeds existing editable proposal only; no `ProjectConfigStore` mutation before normal proposal acceptance. |
| Integration | existing decision/inbox suites | Advisory persists/broadcasts through `wake: false`, does not nudge/interrupt, has no deadline/default/card; budget/audit semantics remain bounded. |
| DOM | `tests2/dom/decision-request-renderer.test.ts` | Existing widget adapter POSTs once; terminal `denied`/`paused-awaiting-consent` is read-only; no transcript envelope/agent wake; correct Awaiting consent textual projection. |
| Browser | `tests2/browser/e2e/extension-decision-request.spec.ts` plus **new** `tests2/browser/e2e/consent-pause-recovery.spec.ts` | Forced consent UI with no default option, advisory never interrupts, denied protected work absent on silence, paused banner/dashboard show Awaiting consent not failure, reload/restart preserves it, and answering once resumes only the exact matching pause. |

Required race fixtures use the existing injected `Clock`, memfs, store write barrier, and fake pause service dependencies. Do not use real sleeps. Explicit scenarios:

1. answer wins before expiry; expiry wins before answer; duplicated answer returns the same terminal record;
2. deadline `deny-operation` blocks the original tool/override and records no grant/side effect;
3. deadline `pause-goal` creates exactly one pause intent/reason, pauses instead of failing/stalling, and recovery after restart completes it once;
4. answer/restart race resumes once; an operator resume reports already-resumed; manual or different reason leaves the goal paused;
5. grant revocation immediately before settlement never permits consent-protected work and follows fail-closed action;
6. requested `deferrable` plus default allow on every required platform floor yields `consent-required`, has no default in durable/REST projection, and no protected operation on silence.

Focused verification command after implementation:

```bash
npx vitest run \
  tests2/core/decision-classifier.test.ts \
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
| **Must deliver** | Three-class server validation; trusted platform floors and extension-only escalation; consent default prohibition; deny/pause silence behavior; durable structured consent pause; atomic/idempotent answer-and-exact-resume; settlement revocation recheck; restart/race recovery; proposal-only configuration effects; existing audit/budget/inbox/widget integration; focused core/integration/browser coverage. |
| **Allowed bounded improvements** | Extract the canonical goal pause service from the existing nested route; add a defensive v1→v2 decision-state migration; improve existing paused labels by deriving Awaiting consent from structured reason; add narrowly required safe trace enums/projections. |
| **Deferred / out of scope** | New generic hook runtime/Host API; rebuild of decision store/widget/inbox/dedupe/budgets/audit; arbitrary consent policies or extension-selected timeout action; direct configuration/grant application; persistent execution permits/tool grants from answers; a second consent UI or transcript protocol; redefining general manual pause/resume/cascade semantics; changing EP-5 retention/redaction or EP-6 grant model beyond the narrow existing authorization rechecks. |
