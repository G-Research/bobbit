# EP-4 — Gated Request Mutation

**Status:** historical implementation design. The implemented operator and extension contract, including the signed-operator grant requirement and post-settle authorization fence, is [Gated request mutation](../request-mutation.md). **Depends on:** EP-5 Context trace, EP-6 exact extension grants, and the existing `DecisionHookDispatcher`/`ModuleHost` isolation path. **Scope:** typed, core-applied per-turn request shaping and pre-execution tool-call safety only. This is not EP-13 static prompt composition or EP-14 post-tool-result filtering.

## Decision

Extensions may return narrow proposals; only Bobbit core validates, reduces, applies, and audits them. A declaration, activation, or `mode: decide` grant alone is not permission to mutate. EP-4 makes the already-reserved exact `mutate` grant usable **only** for a `mode: "decide"` hook that declares `capabilities: [mutate]`. Missing, inactive, malformed, or revoked grants make the proposal inert.

Per-turn prompt shaping is additionally opt-in at the project boundary: an active exact `mutate` grant for the source hook is the enablement record. With no active matching grant, the generated bridge is absent (where no normal role guard is needed), `before_agent_start` returns `undefined`, and existing request/system-prompt bytes and turn behavior are unchanged. There is no global enable flag, implicit built-in exemption, or activation-derived authority.

The only mutable prompt target is the transient request text delivered to the current model turn. A proposal cannot name a target, change a system prompt, append a provider tail, alter transcript history, set tool policy, or mutate a future turn. Static system text remains exclusively EP-13's `system-prompt.ts` layout and proposal flow. The provider bridge's existing dynamic-context rule remains intact: provider output never mutates `event.prompt` or `systemPrompt`.

Tool safety is pre-execution only. It can return `warn` or `deny`; `deny` always wins. It cannot allow a tool denied by the existing role/group/tool guard, mint a tool grant, or transform tool arguments/results. EP-14 remains the only post-result interception point.

## Existing owners and constraints

| Existing surface | EP-4 composition |
|---|---|
| `src/server/agent/pack-contributions.ts::HookContribution` and `src/server/extension-host/pack-contribution-registry.ts::list()` | Sole active, activation-filtered, winning-pack hook list and deterministic priority source. No second hook loader/resolver. |
| `src/server/agent/project-config-store.ts::ExtensionGrant` and `src/server/agent/extension-grant-policy.ts::resolveExtensionGrant()` | Exact per-project grant and live revocation boundary. EP-4 enables the existing reserved `mutate` capability only for a declared decide hook. |
| `src/server/extension-host/module-host-worker.ts::ModuleHost.invoke()` | Worker timeout/crash boundary. Hook code receives a frozen, minimal context and no Host API/apply callback. |
| `src/server/agent/decision-hook-contract.ts` | Existing strict unknown-field/depth/string validation patterns. EP-4 adds its proposal discriminants rather than accepting a generic object. |
| `src/server/agent/provider-bridge-extension.ts` and `src/server/server.ts` `POST /api/sessions/:id/provider-hooks/before-prompt` | Existing per-turn bridge and authenticated session route. Extend the generated bridge/route additively; retain the 2.5-second bridge deadline and all-failure-is-no-turn-failure behavior. |
| `src/server/agent/tool-guard-extension.ts` and `src/server/agent/tool-activation.ts::writeToolGuardExtension()` | The only current Pi `tool_call` pre-execution seam. Extend this one generated guard; do not add a competing Pi extension. Existing `never`/`ask` policy remains a ceiling. |
| `src/server/agent/context-trace-store.ts::ContextTraceStore` | Existing bounded, sanitized activity visibility. It receives fixed result/reason metadata only, never prompt text, tool arguments, patches, or extension prose. |
| `src/server/auth/redact.ts::redactAuditDiffSecrets()` | Existing high-confidence audit redactor. Use it independently on captured before/after diagnostics before persistence or response. |

The current `provider-bridge-extension.ts` deliberately forwards `event.prompt` read-only and returns hidden `bobbit:dynamic-context` messages. EP-4 must not broaden that provider contract. Its separate generated request-mutation handler is only installed after live project/hook/grant resolution and is a core-owned request path, not a provider response path.

## Contracts

Add `"mutate"` to `HookCapability` in `src/server/agent/pack-contributions.ts`. Change `supportsCapability()` in `src/server/agent/extension-grant-policy.ts` so `mutate` is eligible exactly when `hook.mode === "decide" && hook.capabilities.includes("mutate")`; all other existing capability behavior stays unchanged. This lets the existing authenticated grant route validate/persist the exact tuple without a wildcard or a new authorization store.

Create `src/server/agent/request-mutation-contract.ts` for the serializable, closed proposal schemas and pure validation/reduction. Hook identity, active priority, request/session/project identity, and final reason are always attached by core.

```ts
export type RequestMutationEvent = "beforePrompt" | "beforeToolCall";
export type PromptShapeIntent = "clarify" | "compress" | "redact" | "augment";
export type ToolSafetyDecision = "warn" | "deny";

export interface PromptShapeProposal {
  kind: "prompt-shape";
  version: 1;
  intent: PromptShapeIntent;
  /** Complete replacement of this turn's transient user request only. */
  text: string;
  /** Bounded identifier; never extension-controlled display prose. */
  reasonId: string;
}

export interface ToolSafetyProposal {
  kind: "tool-safety";
  version: 1;
  decision: ToolSafetyDecision;
  /** Optional exact tool id; omission means only the inspected current tool. */
  tool?: string;
  reasonId: string;
}

export type RequestMutationProposal = PromptShapeProposal | ToolSafetyProposal;
export type RequestMutationHookOutput =
  | { kind: "request-mutation"; proposal: RequestMutationProposal }
  | null | undefined;

export interface RequestMutationSource {
  packId: string;
  hookId: string;
  priority: number;
}
export interface PromptShapeRequest {
  sessionId: string;
  projectId: string;
  text: string;
}
export interface ToolSafetyRequest {
  sessionId: string;
  projectId: string;
  toolName: string;
}

/** Core-internal only; it is not a pack contribution or Host API contract. */
export type PromptShapeOutcome =
  | { action: "pass"; reason: RequestMutationReason }
  | { action: "replace"; text: string; reason: RequestMutationReason };
export type ToolSafetyOutcome =
  | { action: "pass"; reason: RequestMutationReason }
  | { action: "warn"; reason: RequestMutationReason }
  | { action: "deny"; reason: RequestMutationReason };

/** An orderable core consumer, registered only in dispatcher construction. */
export interface RequestShaper {
  /** Safe, core-owned identifier; it is never supplied by an extension. */
  id: string;
  priority: number;
  shapePrompt?(request: PromptShapeRequest):
    | PromptShapeOutcome | Promise<PromptShapeOutcome>;
  inspectTool?(request: ToolSafetyRequest):
    | ToolSafetyOutcome | Promise<ToolSafetyOutcome>;
}
```

Validation rejects unknown fields, non-plain objects/prototypes, non-canonical version, unsafe identifiers, control bytes, credential-bearing URLs, empty strings, and all fields outside the discriminant-specific allow-list. It uses the existing identifier rule (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`), the existing bounded JSON strategy from `decision-hook-contract.ts`, and UTF-8 accounting.

Hard limits are core constants in the new contract:

- prompt input and replacement: 32 KiB UTF-8 each;
- one proposal result: 40 KiB serialized;
- at most 16 candidate hooks per event and one proposal per hook;
- tool name/reason id: safe identifier, at most 128 characters;
- no tool arguments, JSON patch, system-prompt field, prompt region, callback, URL, free-form explanation, or arbitrary metadata field.

For a tool-safety proposal, an omitted `tool` means the inspected tool; a present `tool` must exactly equal `ToolSafetyRequest.toolName`. A mismatch invalidates the entire proposal rather than being ignored or retargeted.

A replacement must be a complete bounded string, not an unbounded patch. This permits one validation and one redacted before/after diagnostic. It also prevents overlapping text edits and avoids a generic mutation language. Tool argument patching is explicitly deferred: Pi's current `tool_call` guard contract only blocks/permits, and accepting a patch before a canonical per-tool schema validation/replacement seam exists would create an unsafe partial mutator.

`reducePromptShape()` accepts only valid, fresh-granted extension candidates and valid core-shaper candidates. Higher priority wins; equal priorities use the stable namespaced source id. A losing valid proposal is `superseded`; malformed/ungranted/inactive/timeout proposals do not participate. `reduceToolSafety()` validates all candidates and uses severity first: `deny > warn > no proposal`; equal-severity attribution uses the same priority/source ordering. A denied or malformed candidate cannot become an allow. An empty, unavailable, or ungranted candidate set is pass-through to the pre-existing core policy—not an implicit extension allow.

## Dispatcher and application fences

Create `src/server/agent/request-mutation-dispatcher.ts`:

```ts
export interface RequestMutationDispatcherDeps {
  registry: PackContributionRegistry;
  moduleHost: ModuleHost;
  grantsForProject(projectId: string): readonly ExtensionGrant[];
  /** Core-owned consumers; never serialized, contributed by a pack, or exposed to ModuleHost. */
  coreShapers: readonly RequestShaper[];
  trace: Pick<ContextTraceStore, "appendTrace">;
  auditForProject(projectId: string): RequestMutationAuditStore;
}

export class RequestMutationDispatcher {
  /** True when a live eligible extension source or installed core shaper can shape prompts. */
  hasPromptHooks(projectId: string): boolean;
  /** True when a live eligible extension source or installed core shaper can inspect tools. */
  hasToolSafetyHooks(projectId: string): boolean;
  async shapePrompt(request: PromptShapeRequest): Promise<PromptMutationResult>;
  async inspectTool(request: ToolSafetyRequest): Promise<ToolSafetyResult>;
}
```

For either call it takes one active registry snapshot in `PackContributionRegistry.list(projectId)` order, filters only `mode: "decide"` hooks declaring the matching event and `mutate`, and checks the exact grant immediately before `ModuleHost.invoke()`. The invocation context is frozen and contains only `{ event, sessionId, projectId, cwd, prompt? }` for `beforePrompt`, or `{ event, sessionId, projectId, cwd, tool: { name } }` for `beforeToolCall`. It never contains a `SessionInfo`, system prompt, tool arguments, tool result, policy map, credentials, gateway token, or an apply function.

Invoke the module's existing `decide` member with `hook.budget.timeoutMs`; extend `DecisionHookModule.decide` and `validateDecisionHookOutput()` additively to admit `kind: "request-mutation"` only for these event contexts. The dispatcher catches timeout, abort, module throw, and validation failures per hook, records a fixed outcome, and proceeds with independently eligible hooks. It checks the active declaration and exact grant **again** after all workers settle and immediately before applying the selected result. Revocation during execution therefore cannot shape a request or deny a tool after the worker returns.

Core applies a prompt result once, by returning a replacement string only after this second fence. The bridge never applies a hook response itself. Core applies a tool result only by returning its current-guard decision: `undefined` for no result/warn after recording visibility, or `{ block: true, reason: SAFE_TOOL_DENIAL }` for the winning deny. `SAFE_TOOL_DENIAL` is fixed text such as `Tool call denied by project safety policy [ref: <opaque-id>]`; it never contains an extension reason, prompt, arguments, rule value, error, or secret. A warning is visible in the audit/Context trace with a fixed reason but does not alter the call.

The old role/group `never` decision is evaluated first and returns exactly as it does today. It wins without dispatching an extension. For an `ask` tool, EP-4 safety runs before the permission long poll; a safety deny blocks the current call and cannot create a one-time/session grant. A normal grant response is still verified against the currently blocked tool. A later retry re-enters both existing policy and EP-4 safety checks.

## Bridge, route, and data flow

Add a small request-mutation bridge section to the generated source in `src/server/agent/provider-bridge-extension.ts`, retaining the existing provider handler unchanged. Add a shared authenticated `postCoreDecision()` helper with `AbortController`, fixed response schema, and no response/error interpolation. It is activated only if `RequestMutationDispatcher.hasPromptHooks(projectId)` is true after resolving live eligible extension sources and installed core shapers.

```text
Pi before_agent_start(event.prompt)
  -> generated request-mutation bridge POST
       /api/sessions/:id/request-mutations/prompt
       { prompt: event.prompt }             // bounded and read once
  -> server resolves session/project; RequestMutationDispatcher.shapePrompt()
  -> active registry snapshot + exact mutate grant -> ModuleHost.decide()
  -> strict proposal validation -> deterministic reducer
  -> fresh registry/grant fence -> redacted audit + Context trace
  -> { action: "replace", text } | { action: "pass" }
  -> bridge returns { prompt: text } only for a valid selected replacement;
     otherwise undefined; Pi proceeds with its original request.
```

The `prompt` returned by this path is a transient Pi request value, not a write to the user transcript or system prompt. The server route rejects a malformed/oversize request body with `400`; a missing/terminated session returns `404`; it never returns an extension exception. A `500`, timeout, non-2xx, malformed response, network failure, or bridge generation/write failure is treated by the bridge as `undefined`, preserving the original user request and turn. The route must complete within the bridge's existing 2.5-second total deadline; each hook's lower `budget.timeoutMs` is bounded by it.

Extend the existing `tool-guard-extension.ts` rather than emitting another `tool_call` extension:

```text
Pi tool_call(event.toolName)
  -> existing role/group `never` ceiling
  -> generated guard POST /api/sessions/:id/request-mutations/tool-safety
       { toolName }                         // no args/result
  -> dispatcher.inspectTool() + fresh mutate fences
  -> deny wins reducer + fixed trace/audit reason
  -> deny: { block: true, reason: SAFE_TOOL_DENIAL }
     warn/pass/error/timeout: continue existing ask/allow flow unchanged
```

`writeToolGuardExtension()` gains a server-derived `requestMutation` activation descriptor and writes a guard when either existing ask/never policy **or** `RequestMutationDispatcher.hasToolSafetyHooks(projectId)` requires interception. Thread the same descriptor through both `session-setup.ts::resolveToolActivation()` and `session-manager.ts`'s respawn/restore activation builder, so a restart cannot silently drop safety. Session setup and restore must recalculate from the live registry/grant state; no grant is embedded in generated source. The server route repeats every eligibility check, so a stale generated guard cannot confer authority.

## Consumer enforcement seam (Prompt Cache / Budgets)

`RequestShaper` is the small core-internal enforcement seam for later Prompt Cache and Budgets work. Core passes a fixed, validated `coreShapers` list into `RequestMutationDispatcher` at construction; packs cannot register a shaper, `ModuleHost` never receives one, and no Host API or extension schema changes. Prompt Cache may register a prompt shaper to preserve a stable prefix, while Budgets may register a tool shaper to warn or deny on a core-computed budget condition. Neither feature is implemented by EP-4.

The dispatcher invokes eligible extension proposals and installed core shapers independently, normalizes their typed outcomes into the existing reducers, and retains only fixed core-owned `RequestMutationReason` values. Prompt replacements use the existing higher-priority-wins rule across all candidates; equal priorities sort by the stable namespaced source id (`core:<id>` or `extension:<packId>:<hookId>`). Tool results use `deny > warn > pass` across all candidates, then the same priority/source ordering for attribution. Thus a core Budget deny defeats every warning, and a selected extension deny defeats a core warning; existing role/group `never` still short-circuits before either source. A core shaper is called directly by the dispatcher and needs neither an extension declaration nor a grant, so the seam remains functional with zero extension hooks.

The separately cherry-pickable additive commit is exactly the `request-mutation-contract.ts` core-shaper types and `request-mutation-dispatcher.ts` constructor/composition hooks, plus its focused dispatcher test. It must land before, and separately from, provider bridge, tool guard, route, audit, UI, Prompt Cache, or Budgets wiring. This boundary adds no consumer behavior by itself.

## Diagnostics, redaction, and visibility

Create `src/server/agent/request-mutation-audit-store.ts`, a project-owned append-only JSONL store at `<project-state>/request-mutation-audit.jsonl`. It is an authorized diagnostic record, not a second event stream and not a source of authority:

```ts
interface RequestMutationAuditEntry {
  id: string; at: string; sessionId: string;
  event: "beforePrompt" | "beforeToolCall";
  packId?: string; hookId?: string;
  outcome: "applied" | "warned" | "denied" | "dropped" | "error" | "superseded";
  reason: RequestMutationReason;
  before?: string; after?: string; // prompt only, already redacted and capped
  beforeBytes?: number; afterBytes?: number;
  toolName?: string;
}
```

`RequestMutationReason` is a fixed core-owned enum, including `Grant required`, `Prompt mutation disabled`, `Malformed result`, `Over budget`, `Timed out`, `Lower-priority proposal`, `Tool warning`, `Tool denied`, and `Unavailable`. No pack prose/reason text is persisted. Before/after are each passed through `redactAuditDiffSecrets()` **before** they enter the entry, then clipped to 16 KiB UTF-8 with an explicit clipping marker. Byte counts describe original bounded payload sizes but never expose raw content. The audit store validates every read row, skips corrupt/truncated lines, and does not write requests, system prompts, tool arguments/results, raw errors, paths, credentials, or module data.

Add an operator-authenticated bounded `GET /api/sessions/:id/request-mutation-audit?limit=N` route in `src/server/server.ts`, using the existing prompt-operator authorization convention. It returns newest valid rows (1..200) only for a session owned by the selected project. It never returns raw input or worker errors. No public route accepts a mutation or grants a capability.

Every hook outcome and final resolution also appends a `ContextTraceStore` outcome. Extend only its allow-lists (`TraceOutcomeEvent`, `TraceOutcomeReason`) for `beforeToolCall` and the fixed EP-4 reasons. The trace records source ids, event, `advised`/`applied`/`denied`/`dropped`/`error`/`superseded`, parent-measured duration, and a fixed reason. It never records `before`, `after`, tool arguments, tool result, request text, extension `reasonId`, or extension error. Existing `context_trace_updated` stays metadata-only. Thus every result has a safe visible reason while authorized diagnostics have only redacted before/after evidence.

## Failure and compatibility rules

- No active `mutate` grant means no hook import or invocation. Existing no-hook and no-grant sessions retain their current prompt, tool policy, spawn arguments, and event ordering.
- A timeout, worker throw, malformed proposal, audit/trace failure, bad route response, unavailable session, or revocation does not fail a user turn. Prompt handling passes the original request; tool handling defers to the pre-existing policy except a successfully validated selected deny.
- A matching active tool-safety hook that times out/throws is not treated as an extension allow. It contributes no safety permission; existing role/group policy remains authoritative. A project that requires fail-closed availability must use an existing core `never` policy until a separately designed availability policy exists.
- A successfully validated, freshly granted `deny` is fail-closed for its one current tool call and defeats all warnings. It cannot target another tool, broaden policy, or persist a permission.
- The user transcript is never edited, and `systemPrompt`, `DYNAMIC_CONTEXT_*`, EP-13 prompt region delimiters, static prompt overrides, compaction summaries, and future turns are outside the proposal schema.
- EP-14 remains responsible for result redaction/replacement after a handler completes. EP-4 sees neither tool result nor raw args, so it cannot claim result filtering or argument sanitization.

## Files and focused tests

| Path | Change |
|---|---|
| `src/server/agent/pack-contributions.ts` | Add `mutate` declaration capability and `beforeToolCall` hook event validation. |
| `src/server/agent/project-config-store.ts`, `src/server/agent/extension-grant-policy.ts` | Reuse exact persisted `mutate` grant; make it eligible only for declared decide hooks. |
| `src/server/agent/decision-hook-contract.ts` | Add discriminated request-mutation output/context validation; no untyped system mutation. |
| `src/server/agent/request-mutation-contract.ts` | New pure proposal validation, caps, deterministic reductions, safe result types, and core-only `RequestShaper` seam types. This file's seam additions belong in the separately cherry-pickable additive commit. |
| `src/server/agent/request-mutation-dispatcher.ts` | New worker invocation, live grant fences, core-only application, trace/audit production, and core-shaper composition hooks. Its seam hooks and focused test form the same separately cherry-pickable additive commit. |
| `src/server/agent/request-mutation-audit-store.ts` | New bounded redacted append/read diagnostic owner. |
| `src/server/agent/provider-bridge-extension.ts`, `src/server/agent/tool-guard-extension.ts`, `src/server/agent/tool-activation.ts` | Extend the two existing generated Pi bridges without a parallel extension; retain timeouts and pass-through semantics. |
| `src/server/agent/session-setup.ts`, `src/server/agent/session-manager.ts` | Resolve/install the same server-derived guard paths on initial spawn and respawn. |
| `src/server/server.ts` | Construct dispatcher/audit owner; authenticated prompt/tool routes and operator audit read. |
| `src/server/agent/context-trace-store.ts` | Add only fixed EP-4 event/reason allow-list values. |

Register new tests in `tests2/tests-map.json`:

- `tests2/core/request-mutation-contract.test.ts`: strict discriminants/unknown fields; UTF-8/depth/size/scope rejection; no `systemPrompt`/argument patch; stable priority; `deny > warn`; deny cannot target a different tool; no candidate/default path.
- `tests2/core/request-mutation-dispatcher.test.ts`: missing/inactive/revoked grant means no import; pre- and post-worker grant fences; per-hook timeout/throw/schema isolation; conflict/supersession; parent-measured safe outcomes; trace/audit failure isolation; a stub core shaper is invoked without any extension hooks or grants, and its typed prompt/tool outcomes compose with extension candidates under stable prompt ordering and `deny > warn`.
- `tests2/core/request-mutation-audit-store.test.ts`: secret-shaped before/after values are redacted before disk/read response; clipping; safe fixed reasons; corrupt-row skip; no raw prompt, tool args, or error leakage.
- `tests2/core/provider-bridge-extension.test.ts` (extend): an eligible prompt mutation emits only a transient `{ prompt }` result; ungranted/timeout/non-2xx/malformed responses return `undefined`; it never returns `systemPrompt` or changes the original event.
- `tests2/core/tool-guard-extension.test.ts` (extend): existing `never` short-circuits; warning allows normal ask flow; hard deny blocks with fixed text; response mismatch/timeout cannot release a call; normal no-mutation source remains byte-compatible.
- `tests2/integration/request-mutation-routes.test.ts`: session/project ownership, request-body bounds, grant denial, live revoke during worker execution, audit authorization/redaction, and original-turn pass-through on every route/worker failure.
- `tests2/browser/journeys/request-mutation-safety.journey.spec.ts`: fixture pack starts inert; grant enables a redacted prompt-shaping audit and Context fixed reason; revoke restores original request; two hooks prove hard deny wins warning; restart/respawn retains the guard decision path; a secret-shaped canary is absent from Context, audit responses, bridge errors, and rendered diagnostics (the pre-existing user transcript is not rewritten).

Focused verification:

```bash
npx vitest run \
  tests2/core/request-mutation-contract.test.ts \
  tests2/core/request-mutation-dispatcher.test.ts \
  tests2/core/request-mutation-audit-store.test.ts \
  tests2/core/provider-bridge-extension.test.ts \
  tests2/core/tool-guard-extension.test.ts \
  tests2/integration/request-mutation-routes.test.ts \
  --config vitest.config.ts --retry=0
BOBBIT_V2_RETRY_FREE=1 npm run test:browser -- \
  tests2/browser/journeys/request-mutation-safety.journey.spec.ts --retries=0
```

## Non-goals

No static prompt contribution or cache-prefix layout change; no raw system-prompt mutation; no generic request/JSON patch language; no tool argument mutation; no tool-result filtering/redaction; no new Host API; no automatic secret classification guarantee; no policy/grant UI; no new trace transport/store; and no extension-owned apply callback.
