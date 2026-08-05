# EP-11 — Extension decision requests

**Status:** implementation design. **Depends on:** EP-5 Context trace, EP-6 extension grants, schema-2 hook metadata, the non-blocking `ask_user_choices` widget, staff inbox, and editable proposals.

## Decision

Add a server-owned, durable decision coordinator for active `mode: "decide"` hooks. A hook may non-blockingly return either one typed decision request or one non-interrupting advisory. It never receives a promise for a human response and does not park, wake, or depend on an agent turn.

A decision request is rendered by the existing `AskUserChoicesWidget`, including its existing **Other** free-text escape hatch, keyboard behavior, accessibility semantics, drafts, and multi-tab behavior. The only new UI is an adapter which provides the widget's answer callback and draws pending server-owned decision cards in the existing transcript surface. There is no second question component, question protocol, or configuration-apply UI.

The server validates every declaration, selection, default, deadline, capability grant, budget, dedupe identity, and scope before persistence. Its durable record is the authority; the extension return value is only an untrusted proposal. A deadline or headless mode resolves a request with its already validated default. Configuration-affecting choices create a normal proposal draft and are never applied directly.

## Alternatives considered

### A. Selected: project-owned decision mediation

`LifecycleHub` dispatches a bounded `DecisionHookDispatcher` to a project-owned `DecisionRequestManager`, which owns the typed `DecisionRequestStore`, deadlines, dedupe, budgets, scope memories, resolution, and continuation isolation. Pending records project through two additive session REST routes and a metadata-only WebSocket invalidation to a conversation-surface adapter over `AskUserChoicesWidget`. Advisories remain ordinary inbox entries, and configuration effects call an extracted proposal seeding service. This intentionally reuses the existing surfaces rather than their incompatible state ownership: `src/server/agent/inbox-store.ts` and `src/server/agent/inbox-manager.ts` for advisory persistence/lifecycle; `src/ui/components/AskUserChoicesWidget.ts` and `src/ui/tools/renderers/AskUserChoicesRenderer.ts` for the question rendering contract; and `src/server/server.ts`'s existing proposal seed route with `src/server/proposals/proposal-files.ts` and `src/server/side-panel-workspace-routes.ts` for proposal creation. Those contracts are protected today by `tests2/core/inbox-store.test.ts`, `tests2/core/inbox-manager.test.ts`, `tests2/core/inbox-nudger.test.ts`, `tests2/dom/ask-user-choices-renderer.test.ts`, `tests2/browser/fixtures/ask-user-choices-widget.spec.ts`, `tests2/integration/ask-user-choices.test.ts`, `tests2/core/proposal-files.test.ts`, `tests2/core/proposal-rehydrate.test.ts`, and `tests2/integration/proposal-edit-api.test.ts`.

### B. Rejected: inbox-entry-backed decisions

A minimal-composition alternative would model each decision as a typed `InboxEntry` payload variant. `DecisionHookDispatcher` would call `InboxManager.enqueue()`, reuse its per-staff `InboxStore` JSON persistence, broadcasts, and `pending → completed | failed | cancelled` lifecycle, render the entry in the existing inbox panel using the same ask widget, and add only an answer route plus a deadline sweeper. It would reuse the exact files and protecting tests named for A. This is materially different from A: the inbox would own request persistence, state transition, and user projection rather than serving only the non-interrupting advisory path.

| Dimension | A: project-owned store and manager | B: inbox-entry-backed decision |
|---|---|---|
| Data and control flow | Lifecycle dispatch → dispatcher → `DecisionRequestManager` → project `DecisionRequestStore` → decision REST/WS projection → conversation widget adapter. Advisories separately use `InboxManager`. | Lifecycle dispatch → `InboxManager` → per-staff `InboxStore` → inbox panel/widget → answer route; a sweeper must synthesize defaults and translate them into inbox terminal transitions. |
| Expected files | New `decision-request-store.ts`, `decision-request-manager.ts`, and decision adapter/controller; narrow lifecycle, server, project-context, WS, and widget-prop changes. Existing inbox/proposal code is reused at its current boundary. | Payload/state variants and deadline/dedupe/scope-memory branches through `inbox-store.ts`, `inbox-manager.ts`, inbox UI/panel, and terminal lifecycle APIs, plus sweeper, answer route, and widget integration. The existing staff-only contract expands across all of its callers. |
| Failure modes | A corrupt decision file fails closed for decisions only; decision timer, resolution, and memory bugs cannot corrupt or wake staff work. REST/WS projection failure leaves the durable pending record for deadline recovery. | Staff-scoped entries have no deadline/default, session/goal/project memory, semantic dedupe, or per-session/per-goal budget contract. Mixing those concerns risks decision bugs in staff inbox persistence/lifecycle, accidental `InboxNudger` wakes, and a panel mismatch because a decision must appear in the active conversation rather than only a staff inbox. |
| Test seams | Store and manager have direct fake-clock/memfs seams, so persistence, terminal races, budgets, dedupe, and scope isolation are tested without staff fixtures; existing inbox/widget/proposal suites continue to pin reused boundaries. | Each decision case must construct staff ownership and inbox fixtures, then assert against shared terminal states and nudger behavior; new semantics risk destabilizing the existing inbox suite and obscure deadline/default races behind staff queue setup. |

A is the smallest robust architecture despite its new owner. Decisions are session/goal/project-scoped user mediation with mandatory defaults, deadlines, memories, budgets, and a conversation-surface projection; inbox entries are staff-scoped work items with a worker wake lifecycle. Reusing the inbox contract would force unrelated ownership and lifecycle semantics together, contrary to the project principle of composing existing code only when its contract, ownership, and lifecycle fit. A confines the new semantics to a fail-closed project store/manager while retaining the well-tested inbox, question widget, and proposal paths at their natural boundaries.

### Defect-surface inventory

- **`DecisionRequestStore`** — a new atomic project owner isolates decision corruption, retention, dedupe, and exact-scope memory from staff inbox and pack-opaque state; it is necessary because neither existing store has this ownership contract.
- **`DecisionRequestManager`** — one mutating facade and earliest-deadline timer serialize answer/default races, apply headless behavior, and isolate proposal/continuation failures instead of scattering mutation across route, timer, and dispatcher code.
- **`DecisionHookDispatcher`** — keeps the new lifecycle branch bounded and per-hook isolated, derives active identity, and rechecks EP-6 immediately before imports without changing provider dispatch.
- **`hooks` ModuleHost invocation kind** — a narrow additive export kind permits only `decide`/optional `onDecision` in the existing capped-worker model; it avoids a generic hook engine or new Host API surface.
- **Two decision REST routes** — a pending projection route and typed answer route make the durable server record authoritative across reloads and multi-tab races; neither can use the agent ask envelope/apply path.
- **Metadata-only WS invalidation** — one session-scoped frame refreshes visible projections without polling or carrying question, answer, memory, or proposal data; REST remains the authority.
- **Widget `submitAnswers` and `draftKey` props** — the smallest adapter seam that preserves the tested Other, validation, keyboard, ARIA, and draft behavior while keeping the current ask-user transport byte-for-byte when props are absent.
- **`ProposalSeedService` extraction** — lifts the existing validated seed route into a server-only reusable operation so a configuration answer creates the same editable proposal, side-panel event, and broadcast without a second apply path or direct mutation.
- **`InboxManager.enqueue({ wake: false })`** — a single explicit mode preserves durable inbox persistence and broadcasts for advisories while preventing `InboxNudger.poke()` and staff interruption.
- **Single earliest-deadline timer and injected `isHeadless`** — avoid per-request timer leakage and browser-presence heuristics; both are deterministic through a fake clock and explicit CI/headless dependency.

## Current integration points

| Existing owner | Current behavior | EP-11 integration |
|---|---|---|
| `src/server/agent/pack-contributions.ts::loadHooks()` | Loads schema-2 `hooks/<name>.yaml` as inert `HookContribution` metadata. A hook has `id`, `module`, `events`, `mode`, `capabilities`, `budget`, `config`, and `activation`; `HookEvent` includes the five session lifecycle events plus `goalProvisioned`. | Do not change schema-2 YAML shape or activation semantics. Only active, `mode: "decide"` declarations with a declared session lifecycle event are candidates. `goalProvisioned` is not a decision event in EP-11. |
| `src/server/extension-host/pack-contribution-registry.ts::PackContributionRegistry` | Collapses winning packs, filters activation, and exposes active hook metadata through `list(projectId)` / `listHooks(projectId)`. | Build server-derived `ResolvedHook` values from `list(projectId)` immediately before each invocation; never trust a pack id supplied by a module. |
| `src/server/agent/extension-grant-policy.ts::resolveExtensionGrant()` | Pure exact `(packId, hookId, capability)` grant check. | Check `decide` immediately before `decide()` and again immediately before `onDecision()`. Missing/revoked/inactive grants never import the hook. |
| `src/server/agent/lifecycle-hub.ts::LifecycleHub.dispatch()` | Selects active providers, invokes them through `ModuleHost`, budgets context blocks, then appends a `ContextTraceStore` entry. | Inject a `DecisionHookDispatcher`; after provider collection and before final trace append, let it make bounded, non-blocking decision/advisory proposals for the same lifecycle event and return sanitized EP-5 outcome rows. Provider behavior remains unchanged. |
| `src/server/extension-host/module-host-worker.ts::ModuleHost` and `module-host-bootstrap.ts::handleInvoke()` | Invokes only `actions`, `routes`, or `providers`; providers use the direct/default export object and a worker proxy. | Add the additive `hooks` export kind, using the provider-style direct/default export object. It invokes only own `decide` and optional `onDecision` functions in a fresh, capped worker. The hook context reports all current `host` capabilities false; no new `host.*` namespace is introduced. |
| `src/server/agent/project-context.ts::ProjectContext` | Owns project state stores under `<project>/.bobbit/state`. | Own one `DecisionRequestStore` per project context. |
| `src/server/server.ts::createGateway()` | Builds `LifecycleHub`, `InboxManager`, trace observer, project broadcasts, and API routes. | Builds/starts one `DecisionRequestManager`; supplies its dispatcher to `LifecycleHub`; adds REST projection/answer routes and a metadata-only WebSocket invalidation. Shutdown stops its single deadline timer. |
| `src/server/agent/context-trace-store.ts::ContextTraceStore` | Persists capped session JSONL, including EP-5 `TraceOutcomeRow`s. | Add bounded decision/advisory outcome fields and an `appendOutcome()` helper that writes a separate metadata-only trace entry for delayed answers/defaults. |
| `defaults/tools/ask/extension.ts`, `src/ui/components/AskUserChoicesWidget.ts` | Tool card returns immediately; widget validates then posts answers to `/api/internal/user-question/submit`, which appends a hidden transcript envelope and wakes the agent. | Preserve this path byte-for-byte for agent asks. Extract the widget submit transport behind a callback so a decision card POSTs to the decision endpoint instead. It never appends a transcript envelope or calls `SessionManager.enqueuePrompt()`. |
| `src/server/agent/inbox-manager.ts`, `inbox-store.ts` | Durable staff queue; ordinary enqueue broadcasts and calls `InboxNudger.poke()`. | Add an explicit advisory enqueue mode that persists/broadcasts but does **not** poke/nudge. Advisory terminal lifecycle remains existing `pending → completed | failed | cancelled`. |
| `src/server/proposals/proposal-files.ts` and `server.ts` proposal seed route | Proposal drafts are durable, revisioned, and rendered through the existing proposal side-panel workspace. | Extract the existing validated seed path into a shared server-only `ProposalSeedService`. A configuration-changing decision can request only this service; it produces the same proposal draft/revision/UI event as `propose_*`, never applies configuration. |

## Hook contract

### Eligibility and lifecycle

For each `LifecycleHub.dispatch(event, base, scopeInput)` of `sessionSetup`, `beforePrompt`, `afterTurn`, `beforeCompact`, or `sessionShutdown`, `DecisionHookDispatcher` considers active hooks whose `events` includes that event and whose `mode` is `decide`.

For each candidate, it obtains the current project `DecisionRequestStore` and calls:

```ts
resolveExtensionGrant(activeHooks, projectConfigStore.getExtensionGrants(), ref, "decide")
```

immediately before `ModuleHost.invoke`. `activeHooks` is rebuilt from the current activation-filtered registry. The `ProjectConfigStore` snapshot is read fresh. This makes a revocation effective without a restart. A denied/inactive hook has no module import and emits only a safe `denied` trace outcome.

The per-hook timeout is its existing normalized `hook.budget.timeoutMs`. Hook module failure, timeout, malformed output, store failure, or a single hook's budget rejection is caught per hook; it cannot alter provider blocks, delay an agent beyond that bounded worker call, or stop other hooks. The dispatcher returns its outcomes to `LifecycleHub`, which appends them in the already-owned trace write.

`goalProvisioned` is deliberately excluded: it has no session-owned decision surface and `ContextTraceStore`'s current decision event vocabulary is session-lifecycle-only. A future goal decision design must add an explicit surface, not silently reuse a random session.

### Module exports and context

A hook module uses a direct/default export object, matching providers:

```ts
export interface DecisionHookModule {
  decide(ctx: DecisionHookContext): Promise<DecisionHookOutput> | DecisionHookOutput;
  /** Optional continuation; invoked after a durable resolution/default. */
  onDecision?(ctx: DecisionResolutionContext): Promise<void> | void;
}

export interface DecisionHookContext {
  readonly event: DecisionLifecycleEvent;
  readonly sessionId: string;
  readonly projectId: string;
  readonly goalId?: string;
  readonly roleName?: string;
  readonly cwd: string;
  readonly scopeContext?: HookScopeContext;
  readonly config?: Readonly<Record<string, unknown>>;
  /** Exact prior validated memory only; never a broad store read. */
  readonly priorDecision?: DecisionValue;
}

export interface DecisionResolutionContext extends DecisionHookContext {
  readonly requestId: string;
  readonly resolution: ValidatedDecisionResolution;
}
```

`DecisionHookContext` intentionally excludes `gateway.token`, prompt/user/assistant text, transcript bodies, arbitrary request headers, and a working `host` API. The worker receives `capabilities: { store: false, session: false, agents: false }`; extending a grant must not broaden `host.capabilities`.

`decide()` returns one of the following, or `null`/`undefined`:

```ts
type DecisionHookOutput =
  | { kind: "request"; request: ExtensionDecisionRequest }
  | { kind: "advisory"; advisory: ExtensionAdvisory };

type DecisionLifecycleEvent =
  | "sessionSetup" | "beforePrompt" | "afterTurn"
  | "beforeCompact" | "sessionShutdown";

type DecisionScope = "session" | "goal" | "project";
type DecisionValue =
  | { kind: "option"; value: string }
  | { kind: "other"; text: string };

interface DecisionOption { value: string; label: string; }
interface DecisionOtherSchema { minLength?: number; maxLength: number; pattern?: string; }

interface ExtensionDecisionRequest {
  version: 1;
  key: string;                 // extension-stable memory/dedupe key
  title: string;
  question: string;
  options: readonly DecisionOption[]; // 2..8, unique safe values
  other: DecisionOtherSchema;  // required: widget always exposes Other
  default: DecisionValue;      // must validate against options/other
  scope: DecisionScope;
  deadlineAt: string;          // canonical ISO instant, 30 s..7 d from server now
  effect?: { kind: "none" } | {
    kind: "proposal";
    /** Maps each option value and `other` to its normal proposal seed. */
    proposals: Record<string, {
      proposalType: "goal" | "project" | "workflow" | "role" | "tool" | "staff";
      args: Record<string, unknown>;
    }>;
  };
}

interface ExtensionAdvisory {
  version: 1;
  staffId: string;
  title: string;
  body: string;
  key: string;
}
```

The core validates every string length, identifier, option uniqueness, ISO instant, anchored regular expression, and JSON-only proposal arguments. `title`, `question`, labels, body, and Other text are bounded (120, 320, 120, 1,000, and 280 UTF-16 code units respectively); no binary, secret reference, URL credential, token, or unbounded object field is accepted. The `other` schema is required because the existing widget always provides the free-text escape hatch. Its maximum is 1..280 and its pattern is length-bounded before compilation. A default is accepted only if it is an option value or passes the same Other validation. The dispatcher rejects unknown keys rather than preserving pack-controlled fields.

The initial `decide()` call has no waiting continuation. The manager durably resolves the request and then best-effort invokes `onDecision()` if exported. The second invocation repeats the EP-6 check immediately before import. A revoked hook receives no callback. A hook without `onDecision()` can read the final answer on a later normal lifecycle call through the declared scope memory; it has not blocked an agent turn.

## Durable state and restart behavior

### Project-owned store

Add `src/server/agent/decision-request-store.ts`; `ProjectContext` constructs it at `stateDir`. Its one atomic JSON file is:

```text
<project>/.bobbit/state/extension-decision-requests.json
```

It uses the established write-temp + rename publication discipline: a write failure leaves the prior in-memory and on-disk snapshot authoritative. It does not use `PackStore`: decisions are project-owned mediation state, not pack-owned opaque data.

```ts
interface DecisionRequestStoreState {
  version: 1;
  requests: Record<string, StoredDecisionRequest>;
  memories: Record<string, DecisionMemory>;
}

interface StoredDecisionRequest {
  id: string;
  projectId: string;
  sessionId: string;
  goalId?: string;
  asker: { packId: string; hookId: string; event: DecisionLifecycleEvent };
  dedupeId: string;
  questionId: string;
  request: ValidatedExtensionDecisionRequest;
  status: "pending" | "resolved" | "rejected" | "expired" | "superseded";
  createdAt: string;
  deadlineAt: string;
  resolvedAt?: string;
  resolution?: ValidatedDecisionResolution;
  proposal?: { status: "created" | "failed"; type: ProposalType; rev?: number; code?: "PROPOSAL_SEED_FAILED" };
  continuationState: "pending" | "delivered" | "skipped";
  continuationAttempts: number;
}

interface ValidatedDecisionResolution {
  value: DecisionValue;
  actor: "user" | "deadline" | "headless";
  reason: "answered" | "deadline_elapsed" | "headless_default";
}

interface DecisionMemory {
  scope: DecisionScope;
  scopeId: string;              // sessionId, goalId, or projectId
  packId: string;
  hookId: string;
  key: string;
  value: DecisionValue;
  validatedAt: string;
  sourceRequestId: string;
}
```

`getMemory()` returns a defensive copy only after the requested `(scope, scopeId, packId, hookId, key)` is exact. There is no project fallback for a goal/session read, no goal ancestor inheritance, and no wildcard pack/hook/key lookup. A `session` request requires its current session id; `goal` requires `base.goalId`; project uses `base.projectId`. This pins scope isolation even when two hooks reuse the same key.

Records remain after resolution so dedupe and memories survive a process restart. Retention is bounded: keep terminal requests for 30 days and pending requests until resolution; prune only during successful store mutations/startup reconciliation, never before overdue defaults have been applied. Pruning does not remove a memory referenced by a retained request. Scoped memories intentionally outlive pruned source requests; their declared session, goal, or project scope—not source-request retention—governs their lifetime.

### Manager and deadlines

`DecisionRequestManager` is the sole mutating facade. It receives `ProjectContextManager`, `PackContributionRegistry`, `ModuleHost`, `InboxManager`, `ProposalSeedService`, trace writer, clock, `isHeadless`, and metadata-only session broadcaster. It owns a single timer for the earliest pending deadline, rather than one timer per request.

On gateway boot it opens every registered project context, reads each store, and synchronously reconciles requests before arming the timer:

1. Any `pending` request whose deadline is at or before `clock.now()` resolves with its validated default and actor `deadline`.
2. In headless mode every pending request resolves immediately with actor `headless`, regardless of its future deadline.
3. Each durable resolution is published before proposal routing or `onDecision()`; an interrupted callback is retried only through the normal best-effort replay described below, never by re-answering the request.
4. It emits a safe outcome entry and metadata invalidation after publication.

`isHeadless` is an explicit gateway dependency. Production configuration sets it for headless operation; the default factory also treats `process.env.CI === "true"` as headless. Tests inject it explicitly and use a fake clock. This avoids browser-presence heuristics and makes CI behavior deterministic.

For a new request in headless mode, the manager persists a terminal defaulted record atomically in the same operation that would create `pending`, produces no interactive card, and queues no timer. For an interactive request the deadline must be at least 30 seconds and at most seven days after the server clock; the server rejects extension-supplied historical, unbounded, or noncanonical deadlines.

A resolution is idempotent by request id and first terminal write wins. User answer vs timer races are serialized through the store mutation: the answer wins only if persisted before the deadline transaction; otherwise the endpoint returns the stored defaulted resolution. Browser retry and multi-tab clicks therefore cannot create a second callback, memory, proposal, or trace outcome.

### Continuation replay

The store records `continuationState: "pending" | "delivered" | "skipped"` internally. After a terminal resolution is durable, the manager attempts `onDecision()` once. A callback timeout/failure marks it pending for bounded boot/reconciliation retry (maximum three attempts, with stored safe attempt count); it does not roll back the answer, scope memory, or proposal. Missing export is `skipped`. Current grant denial/revocation is `skipped` and is never retried unless a future explicit request is created. This makes extension failure isolated from the user's resolution while still allowing normal restart recovery.

## Dedupe, budgets, and memories

### Identity

The manager computes `dedupeId` as SHA-256 of canonical JSON containing:

```ts
{
  version: 1,
  projectId,
  target: { scope, scopeId },
  asker: { packId, hookId },
  key,
  question, options, other, default, effect
}
```

`deadlineAt`, event occurrence, title, and rendered labels are not enough to make a new question. Semantic question data, scope target, effect, and default are. Canonical JSON sorts object keys and preserves ordered options. This gives an identical request exactly one active card and one durable answer/default across repeats and restarts. `dedupeId` is project-store-only mediation state and is never emitted to EP-5 traces or WebSocket clients.

If an identical pending request exists, the manager returns `{ status: "deduplicated", requestId }` without changing its deadline. If a terminal request exists within retention, it returns the stored resolution and does not invoke `onDecision()` again. A changed key, scope target, options/default/effect, or pack/hook identity is distinct.

### Loud budgets

Use fixed, server-owned limits:

| Limit | Value | Counted state |
|---|---:|---|
| Concurrent pending requests per session | 2 | `pending` requests for exact `sessionId` |
| Requests created per session, rolling 24 hours | 6 | accepted new (not deduplicated) requests |
| Concurrent pending requests per goal | 4 | `pending` requests for exact `goalId` |
| Requests created per goal, rolling 24 hours | 12 | accepted new requests with exact `goalId` |

A request without a goal receives session limits only. A request with a goal must pass both scopes. Headless/defaulted and terminal dedupe hits do not consume a new creation budget. The manager never lets the extension choose a budget.

Budget refusal is deliberately loud, not a silent `null`: the dispatcher classifies the hook output as `{ status: "rejected", code: "DECISION_BUDGET_EXHAUSTED" }` for its server-side result/diagnostic; the server writes `dropped / Budget exhausted` to EP-5 and logs the pack/hook/session safe identifiers. It does not create a card, wake an agent, or affect another hook.

### Validated scope memories

On every terminal user/default resolution, the manager writes the exact validated value to the declared scope memory in the same atomic store mutation. It replaces only the identical memory identity. The manager does not store malformed answers, raw widget drafts, extension output, or unvalidated defaults as a memory.

A subsequent request may receive a `memoryHit` before invoking `decide()` only when its computed dedupe identity and scope memory identity exactly match. The manager resolves that request immediately as an existing validated answer with actor `user` only if the original resolution actor was user; deadline/headless values retain their original actor/reason in the record. No UI is shown and no agent is woken. A later hook can also be given a narrow `priorDecision` field in `DecisionHookContext`, containing only the same exact validated memory; it does not gain broad store access.

## User surface and answer transport

### Reuse, not a second question system

Refactor `AskUserChoicesWidget` to accept an optional typed submit callback and opaque draft key:

```ts
submitAnswers?: (answers: AskAnswer[]) => Promise<void>;
draftKey?: string;
```

When absent, its current `/api/internal/user-question/submit` behavior remains unchanged. The existing `AskUserChoicesRenderer` supplies that default callback. A new `DecisionRequestRenderer` is only a data adapter: it maps the stored one-question schema to the existing `AskQuestion`/`AskAnswer` shape, uses `requestId` as its opaque `draftKey`, and supplies `POST /api/sessions/:sessionId/decision-requests/:requestId/answer`. It must not duplicate option rendering, Other handling, keyboard handlers, ARIA roles, styling, or validation.

`src/app/extension-decisions.ts` owns active-session projection state. It loads pending requests only when the active session is visible, drops state on session switch, and re-fetches after its metadata invalidation. `src/ui/components/AgentInterface.ts` mounts pending decision adapters in the existing conversation surface after messages; cards are absent when none exist. The widget becomes read-only from the server response, not a transcript message.

Add additive routes:

```text
GET  /api/sessions/:sessionId/decision-requests?state=pending
POST /api/sessions/:sessionId/decision-requests/:requestId/answer
```

The answer body is `{ value: DecisionValue }`, not an agent tool-use id and not a free-form extension payload. The route verifies session ownership, request/session match, status `pending`, deadline, selected option/Other rule, and request schema. It derives actor `user`; clients cannot set actor, reason, scope, effect, proposal arguments, or timestamps. It returns the terminal stored request on a duplicate/race.

Add one metadata-only WebSocket frame:

```ts
{ type: "decision_requests_updated"; sessionId: string; ts: number }
```

The frame contains no question, answer, option, memory, proposal data, actor, reason, or secret. REST is the projection authority. An old client ignoring the frame continues normally; a cold reload loads durable pending requests. No decision answer uses `buildAskResponseEnvelope()`, `findAskResponseAnswers()`, or `SessionManager.enqueuePrompt()`. Thus it does not wake an agent or create an agent-turn dependency.

### Configuration mutation routes to proposals

A request with `effect.kind === "proposal"` is valid only with an origin `sessionId`; otherwise it is rejected before display. Its `proposals` map must contain every declared option value and `other`; each mapped seed is independently JSON/schema validated at request creation. After a terminal answer/default is durably written, `DecisionRequestManager` selects that value's stored seed and calls `ProposalSeedService.seedFromDecision()` with its `proposalType`, server-owned origin session, and JSON arguments. The service reuses the proposal type parser, target-project resolution, goal workflow preparation, `writeProposalFile()`, revision snapshot, `openSidePanelWorkspaceTab()`, and `proposal_update` broadcast currently in `server.ts`'s `/proposal/:type/seed` path.

The service performs no acceptance or configuration write. It creates the same editable proposal a user/agent would create and labels its provenance as `extension-decision` in internal diagnostics only. Existing proposal acceptance is the only path that mutates configuration. Proposal seed failure is recorded as a fixed safe code, does not invalidate the decision answer/memory, and does not run an implicit direct fallback.

## Advisories and inbox

An advisory is not a decision request: it has no default, deadline, user question card, scope memory, or agent continuation. A valid advisory is written as an ordinary durable staff `InboxEntry` with additive source `{ type: "extension_advisory", packId, hookId }` and title/body bounds. `InboxManager.enqueue()` gains `{ wake: false }`; that path still persists and broadcasts `inbox.entry.added`, but never calls `InboxNudger.poke()`.

It therefore reuses the existing inbox open/complete/dismiss lifecycle and panel without interrupting a staff agent. Existing `inbox_complete` and `inbox_dismiss` remain the only terminal transitions; EP-11 adds no advisory reply tool or user-blocking card. Advisory dedupe uses the same canonical identity and a 24-hour terminal window, yielding `superseded` instead of duplicate inbox noise.

A malformed advisory, unknown staff, disabled hook, or inbox write failure is a safe dropped/error outcome. It must not make the decision dispatcher fail or turn into a user question.

## EP-5 observability

Extend, do not replace, `ContextTraceStore` and its sanitized outcome envelope. Decision state itself remains in the project store; traces are bounded diagnostic observations.

```ts
interface TraceDecisionOutcomeRow {
  kind: "decision" | "advisory";
  packId: string;
  hookId: string;
  event: DecisionLifecycleEvent | "decisionResolved";
  outcome: "advised" | "applied" | "denied" | "dropped" | "error" | "superseded";
  requestId?: string;
  questionId?: string; // deterministic SHA-256/base32 fingerprint, not prose
  answer?: string;     // safe selected option id or "other" only
  defaultApplied?: boolean;
  actor?: "extension" | "user" | "deadline" | "headless";
  reason?: "Grant required" | "Budget exhausted" | "Malformed result" |
    "Timed out" | "Deadline elapsed" | "Headless default" |
    "Invalid answer" | "Duplicate" | "Capability revoked" | "Proposal failed";
  ms?: number;
}
```

`asker` is the `packId`/`hookId` pair. The trace records the question as `questionId`, a non-reversible deterministic fingerprint, the safe selected option identifier or `other`, and whether the validated default was applied. It never records option labels, question prose, Other text, proposal args, configuration value, prompt, token, URL credential, error body, or stack. `TraceEntry.ts` is the timestamp for dispatch; delayed resolution uses `ContextTraceStore.appendOutcome(sessionId, row)` to append a new trace entry with its own server timestamp and no provider rows.

The trace sanitizer allow-lists each enum/identifier and caps entries exactly as existing outcomes do. The Context inspector normalizer gains a decision/advisory presenter with fixed labels; it must ignore unknown future fields. Trace append, observer, broadcast, renderer fetch, and inspector failures are swallowed/isolated exactly like current EP-5 failure rules.

## Compatibility and failure rules

- This is additive for schema-2: schema-1 packs and schema-2 packs with no hooks keep exact behavior. Existing hook YAML files remain inert unless active, `mode: decide`, granted, and listed for a supported session lifecycle event.
- Existing `HookContribution`, grant API, `ask_user_choices` envelope/parser, staff inbox entries, proposal drafts, provider dispatch, and old trace JSONL rows remain readable. Missing decision state file means empty state.
- A hook cannot use a grant to activate itself, access a new Host API, post an agent message, mutate config, write arbitrary project state, bypass role/session policy, or bypass proposal acceptance.
- Store corruption/load failure fails closed: do not invoke decision hooks, display stale cards, or apply defaults from an unreadable record. Surface a fixed `DECISION_STORE_UNAVAILABLE` diagnostic and preserve provider execution.
- UI/REST failure preserves an unexpired pending request; the deadline manager still resolves it. Network retry/multi-tab races are idempotent.
- Extension malformed output, throws, timeouts, callback failure, advisory failure, proposal seed failure, trace failure, and one project’s state failure never affect another hook/project/session or lifecycle provider block delivery.

## Implementation slices and file map

| Slice | Files | Responsibility |
|---|---|---|
| A: contracts and hook worker | `src/server/agent/pack-contributions.ts`, `src/server/extension-host/module-host-worker.ts`, `src/server/extension-host/module-host-bootstrap.ts`, new `src/server/agent/decision-hook-contract.ts` | Additive `hooks` invocation kind; strict output/schema validation; no Host API expansion. |
| B: durable manager | new `src/server/agent/decision-request-store.ts`, new `src/server/agent/decision-request-manager.ts`, `src/server/agent/project-context.ts`, `src/server/server.ts` | Atomic state, deadline reconciliation, budgets, dedupe, scope memory, grant rechecks, routes, metadata invalidation. |
| C: lifecycle and trace | `src/server/agent/lifecycle-hub.ts`, `src/server/agent/context-trace-store.ts`, context inspector normalizer/presenter | Bounded dispatcher integration and safe EP-5 outcomes. |
| D: existing-surface adapters | `src/ui/components/AskUserChoicesWidget.ts`, `src/ui/tools/renderers/AskUserChoicesRenderer.ts`, new decision adapter/controller, `AgentInterface`, `src/server/ws/protocol.ts` | Existing widget with injected submit transport; durable REST projection/reload; no transcript envelope or agent wake. |
| E: proposals and advisories | extracted `ProposalSeedService` from `server.ts`, `inbox-store.ts`, `inbox-manager.ts`, `server.ts` | Proposal-only config path; durable non-waking advisory inbox source. |

## Test ledger

All new tests live in `tests2/` and are registered in `tests2/tests-map.json`.

| Layer | File | Required coverage |
|---|---|---|
| Core | `tests2/core/decision-hook-contract.test.ts` | Reject malformed hook output, invalid defaults/deadlines/Other schema, unknown fields, unsafe text, and unsupported event; accept bounded canonical request. |
| Core | `tests2/core/decision-request-store.test.ts` | Atomic round-trip, defensive copies, pending/terminal state, exact session/goal/project scope isolation, durable memory, corrupt-file fail-closed, and restart loading. |
| Core | `tests2/core/decision-request-manager.test.ts` | Dedupe identity, first-terminal-write wins, deadline/default, injected headless mode, all four loud budget limits, no duplicate callback/proposal, and callback retry/failure isolation. |
| Core | `tests2/core/context-trace-store.test.ts` (extend) | Decision outcome sanitizer rejects prose/secrets/unbounded values and retains only safe fingerprint/actor/reason/option id. |
| Integration | `tests2/integration/extension-decision-requests.test.ts` | Active granted hook invokes; missing/revoked grant does not import; revoke between request and callback denies callback; module timeout/malformed result does not affect a provider; server restart expires an existing pending request exactly once. |
| Integration | same | Answer endpoint schema rejection, multi-tab/retry idempotency, session mismatch, dedupe across lifecycle repeats, scope-memory isolation, deadline race, CI/headless immediate default, and metadata-only WebSocket payload. |
| Integration | same | Advisory creates an inbox entry without `InboxNudger.poke`; complete/dismiss lifecycle stays existing; unknown staff/inbox failure is isolated. |
| Integration | `tests2/integration/decision-proposal-routing.test.ts` | Every `effect.kind: proposal` uses extracted normal proposal seed/side-panel/broadcast path; no direct config mutation; seed failure leaves answer durable and marks fixed failure code. |
| DOM | `tests2/dom/decision-request-renderer.test.ts` | Adapter uses `AskUserChoicesWidget` behavior (Other, keyboard, ARIA, validation), calls decision endpoint rather than ask endpoint, becomes read-only from server response, and has no transcript-envelope side effect. |
| Browser | `tests2/browser/e2e/extension-decision-request.spec.ts` | Install fixture schema-2 hook, grant `decide`, trigger a real extension question, select an option and observe its persisted effect/memory; reload while pending then answer; reload answered state; assert no agent prompt/wake and no raw answer/question data in Context trace. |

Focused commands after implementation:

```bash
npx vitest run tests2/core/decision-hook-contract.test.ts tests2/core/decision-request-store.test.ts tests2/core/decision-request-manager.test.ts tests2/integration/extension-decision-requests.test.ts tests2/integration/decision-proposal-routing.test.ts --config vitest.config.ts --retry=0
BOBBIT_V2_RETRY_FREE=1 npm run test:browser -- tests2/browser/e2e/extension-decision-request.spec.ts --retries=0
```

## Strict scope ledger

| In scope | Out of scope |
|---|---|
| Typed, server-validated extension decisions; exact EP-6 `decide` check; durable deadline/default resolution; session/goal/project memories; dedupe; loud budgets; EP-5 redacted outcomes. | A generic hook engine, new Host API capability, hook activation/config evaluation changes, direct extension configuration writes, or changing EP-6 grant semantics. |
| Existing ask widget/component with an injected decision submit transport; durable REST/WS projection; no agent wake/dependency. | A second question UI, a blocking human-wait promise, transcript answer envelopes for decisions, agent-turn orchestration, polling, or an agent tool for decisions. |
| Existing inbox lifecycle for non-waking advisories. | Advisory replies, advisory-to-decision conversion, advisory agent wakeups, or a new advisory panel. |
| Existing proposal draft/acceptance path for any configuration-affecting answer. | A new apply endpoint, automatic proposal acceptance, direct config mutation, or a new proposal UI. |
| Bounded, redacted observability; focused persistence/deadline/budget/dedupe/malformed/scope/restart/failure tests and one real browser journey. | Raw question/Other answer/config/prompt/secret trace data, unbounded audit retention, or changes to existing provider context-block semantics. |
