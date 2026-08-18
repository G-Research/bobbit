# EP-8 — Staff proposals and service-extension lifecycle

**Status:** implementation design. **Depends on:** EP-3 scheduled advisors, EP-5 Context trace, EP-6 exact grants, EP-7 project extension settings, EP-11 decision requests/consent, and editable proposals. **Scope:** a cadence-driven, fixture-pack proof that an extension can ask a user to create an ordinary proposal draft for an improvement. It also publishes the generic service-extension lifecycle contract in a separately cherry-pickable commit for the Hindsight runtime.

## Decision

EP-8 does not give extensions an apply API, a proposal store, a staff wake path, or a new approval panel. A scheduled `mode: "decide"` hook is an untrusted candidate producer. Core uses the existing active-pack registry, exact `decide` grant, worker isolation, `DecisionHookDispatcher`, durable consent request, `ProposalSeedService`, proposal workspace, and proposal acceptance routes.

The fixture observes a bounded, core-derived summary of recent session patterns on a due `afterTurn`. It may return one `consent-required` request whose accepted option seeds an existing proposal type. The user must explicitly choose the create-draft option, then explicitly accept the normal editable proposal before any persistent product change can occur. Rejecting, dismissing, timing out, headless operation, revocation, malformed output, and proposal-seed failure all produce no change; terminal request state plus the existing safe Context trace are the audit.

The service surface is independent: a generic core lifecycle runner owns processes, readiness, status, port/data ownership, graceful stopping, and restart policy. A pack supplies only a declarative service spec and receives a redacted core-resolved endpoint. Hindsight keeps its existing external provider unchanged until its runtime pack elects to consume this interface.

## Existing owners to reuse

| Owner | Existing contract | EP-8 use |
|---|---|---|
| `src/server/agent/session-manager.ts` | Persists `scheduledAdvisorTurnCount` at the sole completed-turn boundary before detached after-turn work. | Supplies the durable `turn.index`; no timer, duplicate counter, or scheduler state. |
| `src/server/agent/lifecycle-hub.ts::LifecycleHub` | Starts EP-3 advisors after `afterTurn`; owns overlap cancellation and lifecycle dispatch. | Pass the persisted turn index to the existing decision branch; retain advisor behavior for advisor schedules. |
| `src/server/agent/pack-contributions.ts` and `src/server/extension-host/pack-contribution-registry.ts` | Strict schema-2 hook parsing, winner/activation filtering, pack identity, and `list(projectId)`. | Make scheduled-decision eligibility a filtered projection of these rows; never load a second hook catalogue. |
| `src/server/agent/extension-grant-policy.ts::resolveExtensionGrant` | Exact active `(packId, hookId, capability)` authorization. | Check `decide` immediately before invocation and immediately before durable request creation/seed routing. |
| `src/server/agent/decision-request-manager.ts::DecisionHookDispatcher` | Validates hook output, creates durable requests, handles consent, and invokes `ProposalSeedService`. | Accept only due scheduled-decision hooks; preserve all existing request, budget, consent, and grant fences. |
| `src/server/proposals/proposal-seed-service.ts::ProposalSeedService` | Writes/revisions/parses a draft, focuses its side-panel tab, and broadcasts `proposal_update`; it cannot accept/apply a proposal. | The only proposal-creation operation used after consent. |
| `src/server/proposals/proposal-files.ts`, `src/server/ws/protocol.ts`, and existing proposal renderers | Durable editable draft, rehydration, revisioning, existing approval UI. | No EP-8 proposal endpoint, WebSocket event, or panel. |
| `src/server/agent/decision-request-store.ts` and `src/server/agent/context-trace-store.ts` | Terminal decisions are retained; traces persist fixed metadata only. | Durable rejection audit and safe outcome visibility; no new audit log containing transcript/proposal bodies. |
| `src/server/agent/project-config-store.ts` and EP-7 settings routes/UI | Project-scoped enablement and secret-redacted configuration. | Settings decide whether a fixture/runtime is active; an enabled setting is not a capability grant or approval. |

## Scheduling a decision hook

EP-3 currently treats every `schedule.everyNTurns` declaration as an `advisors` export with a deliberately narrow, trace-only result. That result cannot create a proposal, and must stay that way. EP-8 extends the *declaration*, not the worker with an apply callback:

```ts
// src/server/agent/pack-contributions.ts
export type ScheduledHookKind = "advisor" | "decision";

export interface HookSchedule {
  everyNTurns?: number;
  wallClockMs?: number; // existing inert reserved metadata
  /** Omitted means the compatible EP-3 advisor behavior. */
  kind?: ScheduledHookKind;
}
```

`parseHookSchedule()` accepts only `everyNTurns`, `wallClockMs`, and `kind`; unknown keys still drop the declaration. `kind: "decision"` is valid only when `mode: "decide"`, `events: ["afterTurn"]`, and `everyNTurns` is a bounded integer. `kind` defaults to `"advisor"`, preserving all installed EP-3 fixtures and packs. A wall-clock-only declaration remains inert for either kind.

`PackContributionRegistry.listScheduledAdvisorHooks()` changes only its predicate to require `schedule.kind !== "decision"`. Add:

```ts
listScheduledDecisionHooks(projectId: string | undefined, turnIndex: number): HookContribution[];
```

It returns the already active, winning-pack rows where `schedule.kind === "decision"` and `turnIndex % everyNTurns === 0`; it does not authorize, import, cache a grant, queue missed work, or inspect a module. Keeping modulo selection in this projection prevents a schedule from being evaluated from a pack-provided counter.

Extend the existing dispatcher input additively:

```ts
// src/server/agent/lifecycle-hub.ts
export interface DecisionLifecycleDispatcher {
  dispatch(event: LifecycleHook, context: {
    projectId: string; sessionId: string; goalId?: string; roleName?: string;
    cwd: string; usage?: TurnUsageSnapshot;
    turnIndex?: number;
  }): Promise<TraceOutcomeRow[]>;
}

// src/server/agent/decision-request-manager.ts
private dispatchHooks(
  event: DecisionLifecycleEvent,
  context: DecisionDispatchContext & { turnIndex?: number },
): Array<{ hook: HookContribution; origin: DecisionRequestOrigin; priority: number }>;
```

For `afterTurn`, `LifecycleHub.dispatch()` forwards `base.turn?.index`. `DecisionHookDispatcher.dispatchHooks()` retains unscheduled decide hooks and includes scheduled-decision rows only if the index is present and due. It derives the row from `registry.list(projectId)` (not a module claim), keeps current low-to-high pack precedence and stable hook sorting, and applies the existing grant checks both before worker import and before result application. It must never select a scheduled-decision hook in `dispatchScheduledAdvisors()`.

The flow is therefore:

```text
final agent_end
  -> SessionManager increments + persists scheduledAdvisorTurnCount once
  -> LifecycleHub.dispatch("afterTurn", { turn.index }) [existing detached decision branch]
     -> DecisionHookDispatcher selects ordinary hooks plus due kind:"decision" hooks
     -> active registry + exact decide grant -> ModuleHost hooks.decide()
     -> strict request validation -> DecisionRequestManager durable consent request
  -> LifecycleHub.dispatchScheduledAdvisors(...) [EP-3 advisor-only schedules]
```

Neither branch waits for staff work or creates a queue. A crash drops in-flight work; the next due event is computed only from the persisted monotonic turn index. Revoking a grant, disabling the pack/hook/settings target, or terminating the session uses the existing resolver invalidation/cancellation behavior and makes late results ineligible.

## Staff-improvement hook contract

The decision-hook export remains the existing direct/default `hooks` module and `DecisionHookModule.decide()`. No `host.*` capability is added. The new *optional* context field is a safe, core-owned summary, not transcript access:

```ts
// src/server/agent/decision-hook-contract.ts
export type StaffTranscriptPattern =
  | "repeated-user-correction"
  | "repeated-tool-failure"
  | "repeated-goal-blocker";

export interface StaffImprovementSignals {
  readonly windowTurns: number;       // 1..20
  readonly patterns: readonly Readonly<{
    kind: StaffTranscriptPattern;
    count: number;                    // 1..20
  }>[];
}

export interface DecisionHookContext {
  // existing fields unchanged
  readonly staffImprovementSignals?: StaffImprovementSignals;
}
```

Add `src/server/agent/staff-improvement-signals.ts` with:

```ts
export function summarizeStaffImprovementSignals(
  session: Readonly<SessionInfo>,
  maxTurns?: number,
): StaffImprovementSignals | undefined;
```

It is called only for a due `kind: "decision"` hook, and only after the normal project/session lookup succeeds. It receives the existing in-memory session record but returns a frozen, capped histogram of fixed labels. It never returns raw user or assistant text, tool arguments/results, filenames, URLs, credentials, prompt/system-prompt content, free-form reasons, or the matching message ids. The initial implementation has deterministic core predicates for the three labels; it must return `undefined` rather than guessing if the last 20 turns are unavailable. The fixture tests inject this summary directly, so classification rules can evolve without making a pack test depend on live transcript parsing.

A fixture hook may produce only the existing request shape. Its intended result is:

```ts
{
  kind: "request",
  request: {
    version: 1,
    key: "staff-improvement-v1",
    title: "Suggested workflow improvement",
    question: "Recent session patterns suggest an improvement. Create an editable draft?",
    options: [
      { value: "create", label: "Create draft" },
      { value: "decline", label: "Not now" },
    ],
    other: { maxLength: 280 },
    scope: "session",
    deadlineAt: "<server-valid ISO instant>",
    requestedClass: "consent-required",
    intent: "staff-improvement",
    effect: {
      kind: "proposal",
      proposals: {
        create: { proposalType: "goal", args: { title: "…", spec: "…" } },
        decline: { proposalType: "goal", args: { title: "", spec: "" } },
        other: { proposalType: "goal", args: { title: "", spec: "" } },
      },
    },
  },
}
```

The implementation must refine the existing decision-effect validator so a consent request can declare proposal seeds only for affirmative option values. `decline` and `other` are validated options but have **no effect**; do not use invalid placeholder proposal arguments. The fixed fixture request is therefore represented by a small additive `DecisionEffect` form:

```ts
export type DecisionEffect =
  | { kind: "none" }
  | { kind: "proposal"; proposals: Record<string, ProposalSeed>; noEffectValues?: readonly string[] };
```

`noEffectValues` is accepted only for declared option values or `"other"`; it is mutually exclusive with a seed for the same value. `DecisionRequestManager.routeProposal()` returns without a seed for those values. This preserves the existing `ProposalSeedService` behavior and prevents a negative answer from manufacturing a draft.

The fixture maps categories to **existing** proposal types only:

| Suggested change | Existing proposal created after explicit `create` | Why |
|---|---|---|
| New skill or AGENTS.md guidance | `goal` proposal describing the implementation work | There is no `skill` or file-edit proposal type; accepting a goal creates work, not an edit. |
| Workflow tuning | `project` proposal containing the existing `workflows` fields, or a `goal` when a code/process investigation is needed | Reuses project/goal validation and acceptance. |
| New staff role | `staff` proposal | Reuses the normal staff proposal panel and its explicit acceptance. |

EP-8 must not add `ProposalType: "skill"`, a staff-proposal endpoint, a direct AGENTS.md writer, a task creator, or an agent/Inbox wake. A proposal draft is not an applied change.

### Approval and rejection audit semantics

1. The hook cannot create a draft directly. It has only the granted `decide` invocation path and returns an untrusted request.
2. `DecisionRequestManager` validates the request, derives the effective `consent-required` class, strips any default, and writes the durable request before displaying it. The existing consent UI is the first approval.
3. Only an explicit user answer `create` may call `ProposalSeedService.seedFromDecision(originSessionId, type, args)`. Deadline/headless behavior and a negative/Other answer terminalize without a seed. A consent answer may not be replayed into a second seed.
4. `ProposalSeedService` writes the normal revisioned draft, opens the standard proposal workspace, and broadcasts the standard `proposal_update`. Its contract still has no acceptance/mutation capability.
5. The user can edit, reject, or accept that normal proposal using the current proposal UI/API. Existing proposal acceptance is the second, change-authorizing approval.
6. A user decline, consent timeout, headless resolution, invalid answer, revoked authorization, failed seed, or disabled fixture is retained in `DecisionRequestStore` under its server-derived pack/hook identity and produces only fixed `ContextTraceStore` metadata (`denied`, `dropped`, or `error`). Store retention and trace sanitization remain EP-11/EP-5 owned. No free-form transcript signal, draft body, or extension rationale reaches the audit.

This reuses durable request records for rejection evidence instead of duplicating an audit store. The decision record is the source for terminal actor/status; Context trace is a bounded diagnostic projection, not sole administrative history.

## Fixture pack

Create test-only files:

```text
market-packs/_fixtures/staff-proposal-advisor/pack.yaml
market-packs/_fixtures/staff-proposal-advisor/hooks/staff-improvement.yaml
market-packs/_fixtures/staff-proposal-advisor/lib/staff-improvement.mjs
```

`pack.yaml` is schema 2, lists `hooks: [staff-improvement]`, and is test-installed/default-disabled so normal users never receive suggestions merely because the repository contains it. The hook declaration is:

```yaml
id: staff-improvement
module: ../lib/staff-improvement.mjs
events: [afterTurn]
mode: decide
capabilities: []
schedule: { everyNTurns: 3, kind: decision }
budget: { maxTokens: 64, timeoutMs: 1000 }
```

The module deterministically returns no value unless the injected `staffImprovementSignals` contain a fixture-recognized label. It returns the consent request above for a test-provided clock/deadline. It neither imports files, uses `host`, reads environment variables, starts staff, or inspects raw transcript strings. This is an end-to-end pack-shape proof, not a heuristic product recommender.

## Generic service-extension lifecycle contract — standalone commit

The first EP-8 implementation commit is **only** the additive service contract and its focused tests. It must compile and pass independently, and be suitable for `goal/hindsight-serv-35f56c0e` to cherry-pick without staff-proposal files, hook scheduling changes, or proposal UI changes.

### Files and public interfaces

| Path | Change |
|---|---|
| `src/server/extension-host/service-extension-contract.ts` (new) | Closed declarative spec, normalized status, safe diagnostics, and pure validation. |
| `src/server/extension-host/service-extension-runtime.ts` (new) | Core-owned start/readiness/stop/restart state machine with injected process, clock, probe, port, and filesystem seams. |
| `src/server/extension-host/service-extension-registry.ts` (new) | Resolves active service declarations from winning/activation-filtered packs; no process work and no secret projection. |
| `src/server/extension-host/pack-contribution-registry.ts` | Add optional `listServiceExtensions(projectId)` projection from the same active pack index. |
| `src/server/agent/pack-contributions.ts` | Strictly load `runtimes/<listName>.yaml` only when listed by schema-2 `contents.runtimes`; preserve existing empty-runtime behavior. |
| `src/server/agent/project-config-store.ts` and existing extension-settings resolver | Add only a typed runtime settings target/read path; resolve secret references internally and never expose their values. |
| `src/server/server.ts` | Construct/start/stop the singleton runtime manager, invalidate it after settings/pack activation changes, and expose a bounded authenticated status projection. |
| `tests2/core/service-extension-contract.test.ts` (new) | Pure spec/status/redaction tests. |
| `tests2/core/service-extension-runtime.test.ts` (new) | State-machine and failure/restart tests using fakes. |
| `tests2/integration/service-extension-registry.test.ts` (new) | Active-pack/settings/secret isolation integration. |

```ts
// service-extension-contract.ts
export type ServiceRunMode = "local" | "docker" | "compose";
export type ServiceState = "stopped" | "starting" | "ready" | "unhealthy" | "failed";
export type ServiceRestartPolicy = "never" | "on-failure";

export interface ServiceReadiness {
  url?: string;          // core validates a local/declared endpoint template
  command?: string;      // core-owned probe execution, never a pack shell callback
  timeoutMs: number;     // 100..60_000
}
export interface ServiceExtensionSpec {
  id: string;
  runMode: ServiceRunMode;
  readiness: ServiceReadiness;
  stopGraceMs: number;   // 100..60_000
  restart: ServiceRestartPolicy;
  ports?: readonly number[];
  dataDir?: string;      // pack-relative declaration; runtime resolves owned location
}
export interface ServiceStatus {
  id: string;
  state: ServiceState;
  updatedAt: string;
  detail?: "starting" | "readiness-timeout" | "port-conflict" | "process-exited" | "configuration-unavailable";
}
```

The declaration file carries an `id`, service spec, and existing settings-schema/activation metadata. The loader rejects unknown keys, unsafe ids/paths, duplicate IDs within a winning pack, non-local/invalid port values, unsupported command shapes, and unbounded timing. It is an activation-filtered declaration like providers: being installed, configured, or listed is not a running process.

```ts
// service-extension-runtime.ts
export interface ServiceExtensionRuntime {
  reconcile(projectId: string): Promise<void>;
  status(projectId: string, id: string): ServiceStatus | undefined;
  stop(projectId?: string): Promise<void>;
}

export class ServiceExtensionRuntimeManager implements ServiceExtensionRuntime {
  constructor(deps: ServiceExtensionRuntimeDeps) {}
  reconcile(projectId: string): Promise<void>;
  status(projectId: string, id: string): ServiceStatus | undefined;
  stop(projectId?: string): Promise<void>;
}
```

The runtime manager alone maps a server-derived `(projectId, packId, serviceId)` to a process/container/compose invocation. It leases requested ports before start, allocates/checks the project-owned data directory, resolves runtime-only setting/secret references, starts the selected mode, polls the bounded readiness probe, publishes redacted transitions, stops with the declared grace period, and restarts once only when `restart: "on-failure"` and the declaration remains active. It serializes reconcile/stop per identity; start/stop races cannot leave two live instances or release another run's port. `stop()` is invoked on gateway shutdown, and settings/activation invalidation calls `reconcile()` rather than leaving a stale process running.

Packs do not receive a `ServiceStatus` callback, a child-process handle, a Docker client, environment values, a mounted path, a port allocator, or a raw command channel. `ServiceStatus.detail` is the closed enum above. Logs are captured by the core adapter, clipped/redacted for local diagnostics, and are absent from REST, WebSocket, Context trace, images, and pack context. Secret bytes are resolved by the existing settings owner only at launch and never stored in the spec/status/log projection.

### Hindsight boundary

The standalone contract includes no behavior change to `market-packs/hindsight/src/provider.ts`, `providers/memory.yaml`, or the existing external URL flow. It adds the runtime declaration shape and generic manager so the Hindsight runtime branch can cherry-pick it, provide its `runtimes/hindsight.yaml`, and choose local/Docker/Compose without changing provider source. Until that consumer lands, the shipped Hindsight provider remains external-service-only, retains its `activation.requiresConfig: [externalUrl]` dormancy, and is the regression canary for ordinary lifecycle hooks.

## Test plan

All new tests are registered in `tests2/tests-map.json`; all clocks, worker responses, process exits, readiness responses, and settings are injected. No real service, Docker daemon, polling sleep, LLM, or user filesystem is required for core/integration tests.

| Layer | File | Assertions |
|---|---|---|
| Core | `tests2/core/pack-contributions.test.ts` | `schedule.kind` defaults to advisor; decision requires exact after-turn/decide/every-N shape; malformed/unknown combinations drop; advisor projection excludes decision schedules. |
| Core | `tests2/core/decision-hook-dispatcher.test.ts` | Due index invokes the scheduled decision once; non-due/missing index does not import; ordinary unscheduled hooks retain current behavior; active/grant rechecks deny a late result. |
| Core | `tests2/core/staff-improvement-signals.test.ts` (new) | Empty/corrupt/oversized sessions return no summary; only fixed bounded labels/counts survive; raw text, paths, tokens, tool args/results, and message ids cannot enter the hook context. |
| Core | `tests2/core/decision-request-manager.test.ts` | Consent strips defaults; decline/other/deadline/headless creates no seed; one `create` answer seeds once; failure records `PROPOSAL_SEED_FAILED`; repeat/restart cannot create a second seed. |
| Integration | `tests2/integration/staff-proposal-fixture.test.ts` (new) | Install fixture, enable it and grant exact `decide`; turn 1/2 create nothing; due turn creates one consent request; decline leaves no draft; explicit create produces the normal revisioned goal/project/staff draft and `proposal_update`; revocation before settlement blocks it. Assert the durable terminal request and fixed trace outcome, never raw signals. |
| Browser | `tests2/browser/e2e/staff-proposal-fixture.spec.ts` (new) | Drive fixture through active project settings/grant, see the existing decision card, decline then reload and confirm no draft, explicitly create then open/edit/reject the existing proposal panel. Repeat with acceptance only where the existing proposal journey already proves it. No bespoke EP-8 panel. |
| Core | `tests2/core/service-extension-contract.test.ts` | Strict schema bounds, status transition validation, unsafe path/port/command rejection, and redaction of secret/error text. |
| Core | `tests2/core/service-extension-runtime.test.ts` | Local/Docker/Compose adapter selection, port lease collision, readiness success/timeout, stop grace, restart-on-failure limit, disable/reconcile stop, process generation race, and shutdown cleanup. |
| Integration | `tests2/integration/service-extension-registry.test.ts` | Winning-pack and EP-7 settings activation, project isolation, unreadable settings fail closed, runtime-only secret never appears in status/log/trace/response, and Hindsight external provider remains unchanged without a runtime declaration. |

Focused commands after each commit:

```bash
npx vitest run tests2/core/service-extension-contract.test.ts tests2/core/service-extension-runtime.test.ts tests2/integration/service-extension-registry.test.ts --config vitest.config.ts --retry=0
npx vitest run tests2/core/pack-contributions.test.ts tests2/core/decision-hook-dispatcher.test.ts tests2/core/staff-improvement-signals.test.ts tests2/core/decision-request-manager.test.ts tests2/integration/staff-proposal-fixture.test.ts --config vitest.config.ts --retry=0
npm run test:browser -- tests2/browser/e2e/staff-proposal-fixture.spec.ts --retries=0
```

## Commit partition and non-goals

1. **`feat(extension-host): add service extension lifecycle contract`** — only the generic service-contract/runtime/registry/settings seams and the three service-focused tests above. It is additive, independently type-checkable, and contains no staff fixture, proposal scheduling, Hindsight provider rewrite, or proposal UI change. This is the cherry-pick provenance commit for Hindsight.
2. **`feat(staff): seed consented scheduled improvement proposals`** — scheduled-decision declaration/dispatcher/signal changes, fixture pack, staff proposal tests, and test-map registrations. It depends on the first commit but contains no service implementation changes.

Out of scope: automatic application; an extension-controlled acceptance route; raw transcript access; a second proposal/audit/approval UI; a new skill proposal type; staff wake/agent spawning; wall-clock scheduling; cron; a new grant capability; direct AGENTS.md/project/workflow writes; migrating Hindsight's current external provider; a managed Hindsight implementation; and LangFlow.
