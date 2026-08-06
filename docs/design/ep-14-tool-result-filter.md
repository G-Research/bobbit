# EP-14 — Tool-result filter seam

**Status:** implementation design. **Scope:** a core-owned, fail-closed post-tool-result gate that is invoked after a tool finishes but before *any* result byte can enter Pi's model history, its transcript JSONL, Bobbit's RPC event path, WebSocket/event buffer, snapshots, search, logs, traces, audit, compaction, or renderer. This is a platform seam, not credential-containment policy.

## Decision

Install exactly one core-generated Pi result-gate extension per eligible session. It is the canonical interception owner. It receives the normalized complete tool result from a required Pi result-gate API, asks the gateway to inspect it, and returns only core-validated output to Pi. No server-side `message_end`, WebSocket, transcript reader, renderer, truncator, search indexer, audit store, or extension hook may be an alternative interception point: all are downstream and therefore too late.

The current Pi 0.82.1 `tool_result` hook is useful evidence but **not sufficient**. Its `AgentSession._installAgentToolHooks()` calls `agent.afterToolCall` for the final result, but `tool_execution_update` can emit `partialResult` first and is not transformable. `src/server/agent/session-manager.ts::handleAgentLifecycle()` can subsequently index every `message_end`; `emitAgentEvent()` truncates only on the outbound path. Both are after exposure. EP-14 therefore requires the bounded Pi result-gate API described below before enabling this capability. It must not claim coverage by adding a late `message_end` scrubber.

When no active eligible filter exists, no gate extension is generated and current tool behavior remains byte-compatible. Once a session is generated with an eligible gate, gateway/transport/filter failure produces the fixed synthetic rejected result, not the original result. A stale gate after every eligible filter has been explicitly revoked/deactivated returns pass-through; revocation removes the feature rather than creating a permanent policy.

## Existing owners consumed

| Owner | EP-14 use; do not replace it |
|---|---|
| `PackContributionRegistry.list(projectId)` | The sole activation-filtered, winning-pack declaration snapshot and deterministic pack precedence. |
| `ProjectConfigStore` and `resolveExtensionGrant()` | Exact live EP-6 authority. Add a closed capability, `filter:tool-result`; resolve immediately before worker invocation and after all workers settle. |
| `ModuleHost.invoke()` | Per-hook worker timeout/crash isolation. Filter modules have no Host API or apply callback. |
| `request-mutation-contract.ts` / `request-mutation-dispatcher.ts` | Reuse its closed-object/UTF-8 validation, stable source identity, active snapshot, final grant fence, `Promise.all` concurrency pattern, and severity reduction. Do not route result filtering through the request-mutation endpoints or `mutate` grant. |
| `ContextTraceStore` | The sole EP-5 metadata-only visibility path. Extend its allow-lists, never add a result trace or raw-event WebSocket payload. |
| `SessionManager` canonical listeners | Keep `prepareVisibleAgentEvent()` → `handleAgentLifecycle()` → `emitAgentEvent()` → `trackCostFromEvent()` downstream of Pi's result gate. Its `message_end` index path and `getMessages` snapshots must observe only filtered output. |
| `transcript-reader.ts`, `truncate-large-content.ts`, `search/content-policy.ts` | Consumers only. They must never receive rejected/replaced originals; truncation is not redaction. |
| `tool-activation.ts` / `session-setup.ts` / `session-manager.ts` | Resolve and install the same server-derived activation on initial spawn, restore, role replacement, and force-abort respawn. |

## Required Pi capability

Before Bobbit enables `filter:tool-result`, the pinned Pi release must expose one atomic interception point in `@earendil-works/pi-agent-core`, used by coding-agent's `AgentSession._installAgentToolHooks()`:

```ts
interface ToolResultGateInput {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>; // available to Pi only; Bobbit never sends it
  result: AgentToolResult<unknown>; // content, details, isError, usage
}
type ToolResultGate = (input: ToolResultGateInput) => Promise<AgentToolResult<unknown>>;

// Agent-owned: receives every update privately, buffers bounded data, then calls
// exactly once before either tool_execution_update, tool_execution_end, message_end,
// transcript append, or next model context observes result content.
agent.setToolResultGate(gate: ToolResultGate | undefined): void;
```

The API is enabled only for the core-generated EP-14 extension. It must buffer/suppress streaming updates and final data in Pi until the gate settles. It must not invoke normal extension `tool_execution_update` listeners, renderers, RPC event listeners, or persistence with raw chunks. The gate is called once per `toolCallId`, including a normal return, throw-normalized error, text, structured JSON in `details`, and image/binary content. It receives the complete normalized result; it has no raw tool argument sink in Bobbit.

Pi applies exactly the returned `AgentToolResult` and only then resumes its usual `tool_execution_end`, `tool_result`, message, model-context, JSONL, and RPC flow. The supporting Pi release needs focused upstream tests for normal result, error, final result after N chunks, a chunk that crosses the byte cap, image content, a rejected gate, and a gate throw. Bobbit must pin that release and add a small compatibility assertion that fails session setup rather than silently disabling the gate when the API is absent.

This is deliberately a prerequisite rather than a local monkey-patch of `afterToolCall`: the latter cannot retract a raw partial update already fanned out.

## Authority and hook contract

Add `filter:tool-result` to `ExtensionCapability`, `HookCapability`, and the strict contribution capability parser. It is eligible **only** for an active `mode: "decide"` hook that declares both `events: [afterToolResult]` and `capabilities: [filter:tool-result]`. A project must have the exact EP-6 grant `(packId, hookId, "filter:tool-result")`. `decide`, `mutate`, activation, built-in provenance, or any other capability never imply it.

`afterToolResult` means *after execution, before result fan-out*; it is not a normal post-persistence lifecycle event. `HookContribution` continues to be metadata only. Add the event only to the decision-hook filter dispatcher; do not make `LifecycleHub` import every hook.

Create `src/server/agent/tool-result-filter-contract.ts`:

```ts
export type ToolResultFilterEvent = "afterToolResult";
export type ToolResultFilterAction = "pass" | "replace" | "redact" | "reject";

export interface ToolResultInspection {
  event: "afterToolResult";
  sessionId: string;
  projectId: string;
  toolCallId: string;
  toolName: string;
  result: Readonly<CanonicalToolResult>;
}
export interface CanonicalToolResult {
  content: readonly SafeToolResultContent[]; // text/image normal form
  details?: JsonValue;                       // strict bounded JSON only
  isError: boolean;
  usage?: SafeUsage;
}
export type SafeToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp"; data: string };

export interface ToolResultFilterProposal {
  kind: "tool-result-filter";
  version: 1;
  action: ToolResultFilterAction;
  ruleId: string;       // safe identifier, at most 128 bytes
  reasonCode: string;   // safe identifier, at most 128 bytes; no prose
  replacement?: { content: readonly SafeToolResultContent[]; isError?: boolean };
}
```

`pass` and `reject` forbid `replacement`; `replace` and `redact` require a complete replacement and may not carry original `details`, `usage`, image metadata beyond the closed content schema, a patch, URL, callback, arguments, free-form explanation, or arbitrary metadata. `redact` is an auditable semantic distinction from `replace`, not a patch language. Core validates the full replacement with the same byte/type limits as the input, so it cannot become an unbounded secondary result channel.

Validation rejects unknown fields; arrays/prototypes; malformed UTF-16; control bytes; credential-bearing URLs; unknown block/media types; invalid base64; non-finite JSON; excess depth/properties; empty fields; duplicate/unsafe identifiers; and every invalid discriminant-specific field. Caps are core constants: 256 KiB total canonical input, 64 KiB text per block, 128 KiB decoded image per block, 32 blocks, 16 KiB JSON `details`, 64 KiB replacement total, 16 candidate hooks, and one return per hook. The Pi gate accumulates the same 256 KiB maximum across chunks before posting; it does not emit a raw prefix.

A filter receives a frozen inspection containing result bytes but never tool arguments, a session object, system prompt, policy map, credential, token, or apply API. Only core creates source identity, applies a decision, and emits diagnostics. The fixture uses deterministic matching only and is not a real secret detector.

## Dispatcher, reduction, and synthetic result

Create `src/server/agent/tool-result-filter-dispatcher.ts` with the request-mutation dispatcher as its direct composition template:

```ts
class ToolResultFilterDispatcher {
  hasEligibleFilters(projectId: string): boolean;
  async filter(input: ToolResultInspection): Promise<ToolResultFilterResolution>;
}
```

For one result, snapshot active registry rows in `list(projectId)` order; select at most 16 declared `afterToolResult` filter hooks; resolve the exact `filter:tool-result` grant immediately before each `ModuleHost.invoke()`; validate one closed return per worker; wait for every eligible worker; then resnapshot declaration/grant state and discard every candidate that lost authority. Per-hook error/timeout/malformed results are retained only as fixed core outcome metadata.

Reduction is deterministic and reuses EP-4's ordering: `reject > redact > replace > pass`; priority then stable `extension:<packId>:<hookId>` select attribution within one severity. This is deny-wins for a post-result action: one valid reject defeats every pass/replace/redact. A losing valid candidate is `superseded`. Pass candidates do not suppress a more protective decision.

A no-filter set returns the original canonical result only when no eligible filter existed at the gate's current invocation. If an eligible filter was selected but any required invocation/validation/transport/gateway failure prevents a complete reduction, return a core rejection. The result never falls open because one active filter crashed. Fresh revocation/deactivation of **all** candidates before the final fence is the explicit authority-off exception and passes unchanged; if one currently eligible filter remains but another fails, the remaining valid decision applies, otherwise failure rejects.

For rejection, core returns this fixed synthesized result (with a fresh opaque correlation id that is not derived from raw data):

```ts
{
  content: [{ type: "text", text: "Tool result withheld by project result policy [ref: <opaque-id>]." }],
  details: undefined,
  isError: true,
  usage: undefined,
}
```

`replace`/`redact` return only their validated replacement and fixed/safe `isError`; original `content`, `details`, image bytes, and usage-derived payloads are dropped. The dispatcher response never serializes raw input, a raw proposal error, or extension prose.

## Gateway bridge and fan-out

Create `src/server/agent/tool-result-filter-extension.ts`. The generated Pi extension registers the required Pi gate; it serializes the complete bounded canonical result to:

```text
POST /api/sessions/:id/tool-result-filter
{ toolCallId, toolName, result }
```

The generated source contains no grant, hook id, rule id, or policy. It has a fixed deadline no greater than 2.5 seconds and strict response parsing. On transport failure, malformed/non-2xx response, bad output, or local aggregate overflow it returns the same fixed synthetic rejection locally. It must not log response bodies, caught errors, or result values. Its HTTP client and gateway body reader are configured with explicit size caps and no body logging.

`src/server/server.ts::handleApiRoute()` owns this authenticated route. It resolves live/persisted session ownership, validates the closed wire input before dispatch, calls `ToolResultFilterDispatcher.filter()`, appends only safe metadata, and returns the full validated result selected by core. It must not use `jsonError()` with raw exceptions. `readBody()` parse/size errors return the synthetic rejection to a recognized gate request; malformed identity is a safe 400 with no echo.

The canonical data flow is:

```text
Tool execution / private streaming chunks
  -> Pi result-gate buffer (no update/persistence/fan-out)
  -> generated core gate extension
  -> authenticated gateway route
  -> ToolResultFilterDispatcher / ModuleHost workers / fresh EP-6 fence / reducer
  -> safe pass, replacement/redaction, or core synthetic rejection
  -> Pi applies safe result once
  -> Pi transcript/model context/RPC events
  -> SessionManager prepareVisibleAgentEvent -> lifecycle/index -> EventBuffer/WS/UI/snapshots
```

Existing `SessionManager` listeners must stay in that order on every creation, restore, role replacement, and force-abort replacement path. A generated filter extension install/write failure while filters are eligible fails setup/respawn cleanly; it must not launch a raw-result session. On restart, compute activation afresh. On abort, discard buffered raw bytes, resolve the gate with the fixed synthetic result only if Pi needs a result to settle, and never replay a raw pre-abort chunk from JSONL/EventBuffer.

## Metadata-only observability

Create `src/server/agent/tool-result-filter-audit-store.ts`, project-owned capped JSONL. It records only `{ id, at, sessionId, toolCallId, toolName, packId?, hookId?, action, outcome, reasonCode, ruleId?, inputBytes, outputBytes, latencyMs }`. `reasonCode` and `ruleId` must be safe identifiers; `inputBytes`/`outputBytes` are bounded integers. There is no `before`, `after`, text, JSON, image, MIME blob, argument, hash/fingerprint of content, error stack, URL, or extension prose. A rejected/replaced original is never written to audit, trace, or server/client log. Store/read/rotation failures are swallowed after a fixed safe server log label with no dynamic result material.

Extend only EP-5 allow-lists in `context-trace-store.ts`: event `afterToolResult` and fixed filter outcome/reason labels. Emit one metadata-only `kind: "audit"` row per worker/final decision and use existing `context_trace_updated` invalidation. The normal trace REST response, WebSocket, browser normalizer, and component remain data firewalls. Add an operator-authorized bounded audit read route only if needed for platform diagnostics; it returns normalized metadata and no content.

## Failure matrix

| Condition | Deterministic returned result | Raw-byte rule |
|---|---|---|
| No active eligible declaration/grant at gate start | Original canonical result | Feature is off; no bridge is generated for new sessions. |
| Normal/error result, valid pass | Original canonical result | Final value is released once. |
| Valid replace/redact | Validated complete replacement | Original content/details/image/usage never leaves gate. |
| Valid reject or any reject among candidates | Fixed synthetic error | Original never leaves gate. |
| Stream/chunks | Private bounded aggregate, then normal reduction | No raw `tool_execution_update`; cap overflow synthesizes rejection. |
| JSON/binary/image | Strict canonical decode and cap, then normal reduction | Invalid/unknown/oversize encoding synthesizes rejection; no preview. |
| Input over a cap | Fixed synthetic error | Do not send or persist a prefix. |
| Hook timeout, throw, bad return, worker crash | Fixed synthetic error if any eligible filter remains | Fixed outcome/reason only. |
| Gateway route/response/extension deadline/write failure | Local fixed synthetic error; setup fails if no gate can be installed | No raw error/body interpolation. |
| Grant revoked/declaration disappears while workers run | Drop that candidate at fresh post-settle fence | If none remains, explicit authority-off pass; otherwise reduce remaining/fail closed. |
| Concurrent calls | Independently keyed by `sessionId/toolCallId`; no shared mutable result buffer | Per-call isolation; completion order cannot alter reduction. |
| Gateway restart/respawn | Buffered state is volatile and discarded; activation recomputed | Never recover/replay a raw buffer. |
| Abort/process exit | Cancel dispatch, drop buffer, emit no raw partial/event | Pi may receive only the fixed synthetic settle result. |

## File ownership and additive commit boundary

| Path | Responsibility |
|---|---|
| External pinned Pi agent/coding-agent release | Atomic buffered result-gate API before all result update/fan-out/persistence. This is a hard prerequisite. |
| `src/server/agent/project-config-store.ts`, `pack-contributions.ts`, `extension-grant-policy.ts` | Closed `filter:tool-result` capability and `afterToolResult` declaration/event validation. |
| `src/server/agent/tool-result-filter-contract.ts` | Pure canonicalization, strict filter proposal/result validation, limits, reducer, synthetic result constructor. |
| `src/server/agent/tool-result-filter-dispatcher.ts` | Registry snapshot, EP-6 pre/post fences, ModuleHost invocation, failure classification, deterministic reduction. |
| `src/server/agent/tool-result-filter-extension.ts` | Generated Pi gate transport and local fixed fail-closed fallback. |
| `src/server/agent/session-setup.ts`, `tool-activation.ts`, `session-manager.ts` | Fresh activation and generated-gate installation on spawn/restart/abort paths; no alternate result path. |
| `src/server/server.ts` | Dispatcher construction, authenticated bounded route, safe diagnostics integration. |
| `src/server/agent/tool-result-filter-audit-store.ts`, `context-trace-store.ts` | Bounded metadata-only audit and EP-5 allow-list additions. |
| `src/server/search/content-policy.ts`, transcript/snapshot/client files | No feature logic expected; focused tests assert they consume only gated output. |

**Separately cherry-pickable additive seam commit:** the external Pi gate API/pin plus `tool-result-filter-contract.ts`, `tool-result-filter-dispatcher.ts`, the closed capability vocabulary, and dispatcher/core tests. It has no session installation, route, audit, UI, fixture, or policy behavior. A second commit wires the generated extension, server route, activation/respawn, and metadata stores. A third commit adds fixture and end-to-end canary coverage. No credential policy is bundled into any commit.

## Fixture and canary verification plan

Add an inert fixture pack under `tests2/_fixtures/` with one `afterToolResult` decide hook declaring `filter:tool-result`. It matches only unique deterministic test canaries and returns pass, redact replacement, or reject; a second fixture hook proves reject beats redact/replace regardless of resolution order. Tests grant the exact capability through the production EP-6 route and prove activation/revocation/restart behavior.

Register focused tests in `tests2/tests-map.json`:

- `tests2/core/tool-result-filter-contract.test.ts`: unknown-field/prototype/depth/UTF-8/base64/JSON/image limits; pass/replace/redact/reject shape; fixed synthetic output; reject-wins, priority/tie ordering, no patch/argument/free text fields.
- `tests2/core/tool-result-filter-dispatcher.test.ts`: exact grant and activation fences, live revoke, timeout/throw/malformed isolation, fail-closed active-filter failure, all-revoked pass, concurrency, rule/reason metadata only, and zero module import without grant.
- `tests2/core/tool-result-filter-extension.test.ts`: Pi gate input serialization, strict response acceptance, local fallback for timeout/malformed/non-2xx/oversize, no dynamic console/error interpolation, and buffered chunks never call an update emitter.
- `tests2/core/tool-result-filter-audit-store.test.ts`: row schema/rotation/corrupt-line skip and canary absence from disk/read response/log spy.
- `tests2/integration/tool-result-filter-routes.test.ts`: authenticated session/project ownership, body caps, exact grant, route/worker failures, stale generated gate after revoke, and trace/EP-5 response has metadata but no canary.
- `tests2/integration/tool-result-filter-pi-gate.test.ts`: normal/error, structured JSON, image/binary, N chunks, cap crossing, abort, and restart against the pinned Pi gate compatibility fixture; assert no raw update before final safe result.
- `tests2/browser/e2e/tool-result-filter.spec.ts`: production fixture journey: inert → exact grant → reject/redact/pass → revoke/reload/respawn. Use distinct canaries per assertion and verify DOM, browser snapshots, websocket frames/EventBuffer/replay, `/api/sessions/:id/messages`, transcript JSONL/read APIs (including `include_tool_results`), Context trace, filter audit, search queries/index backing records, server/client log capture, compaction/recovery transcript, tool-result artifacts, and image renderer all exclude rejected and replaced originals. Verify safe replacement/synthetic text is visible and a reject wins a competing replacement.

Focused command after implementation:

```bash
npx vitest run \
  tests2/core/tool-result-filter-contract.test.ts \
  tests2/core/tool-result-filter-dispatcher.test.ts \
  tests2/core/tool-result-filter-extension.test.ts \
  tests2/core/tool-result-filter-audit-store.test.ts \
  tests2/integration/tool-result-filter-routes.test.ts \
  tests2/integration/tool-result-filter-pi-gate.test.ts \
  --config vitest.config.ts --retry=0
BOBBIT_V2_RETRY_FREE=1 npm run test:browser -- \
  tests2/browser/e2e/tool-result-filter.spec.ts --retries=0
```

## Scope ledger

| Must | Allowed | Deferred / prohibited |
|---|---|---|
| One pre-fan-out result owner; exact EP-6 grant; typed closed decisions; reject-wins; bounded safe synthetic rejection; no original rejected/replaced bytes in stated paths; restart/abort/concurrency behavior; metadata-only EP-5 visibility; fixture/canary proof. | Reuse EP-4 validation/reduction/fencing patterns; add a narrow capability/event; a Pi version prerequisite; safe replacement text/image outputs; an operator-only metadata audit. | Real gateway credential-containment policy, detector, credential taxonomy, secret scanning guarantee, allow-list product, policy UI, generic redaction language, tool-argument mutation, prompt mutation, Host API expansion, raw-result archive/export, raw diagnostic content, or a second result event stream. |

EP-14 provides the controlled seam only. A real credential-containment policy/extension is explicitly deferred to a later top-level goal.
