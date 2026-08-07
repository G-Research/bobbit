# EP-14 — Tool-result filter seam

**Status:** implemented platform capability. **Scope:** a core-owned post-tool-result gate that
runs after tool execution and before result bytes reach Pi's model history, transcript JSONL, RPC,
SessionManager, EventBuffer/WebSocket, UI, snapshots, search, traces, logs, audit, compaction, or
persisted result artifacts. It is a seam for a later policy product, **not** credential
containment, secret detection, or a general extension-result API.

## Why this owner exists

Filtering in `SessionManager`, transcript readers, renderers, search, or a normal Pi extension
would be too late: those consumers can observe a result after Pi has persisted or forwarded it.
EP-14 therefore uses a patched Pi result gate as the one canonical interception owner. Pi holds
protected updates privately, calls the generated core gate once for the terminal result, and
applies only the value returned by core before ordinary Pi fan-out resumes.

```text
Tool execution
  -> patched Pi private protected-update handling
  -> core-generated Pi result gate
  -> authenticated gateway result-filter route
  -> dispatcher / granted hook workers / final authority fence
  -> pass, validated replacement, or synthetic rejection
  -> ordinary Pi transcript, model context, RPC and Bobbit consumers
```

No downstream consumer is an alternate filter. Truncation, transcript redaction, and search
content policy are not result filtering and cannot repair an earlier exposure.

## Authority and declaration

The closed EP-6 capability is `filter:tool-result`. A hook is eligible only when all of these are
true:

- its winning, activation-filtered schema-2 declaration has `mode: decide`;
- its **only** event is `afterToolResult`;
- it declares `capabilities: [filter:tool-result]`; and
- the project has the exact live `(packId, hookId, "filter:tool-result")` grant.

`decide`, `mutate`, pack activation, built-in provenance, and any other grant do not imply this
capability. The dispatcher checks the live declaration and grant immediately before every worker
invocation and again after all workers settle. A declaration or grant revoked during execution
cannot apply a late candidate. If every selected candidate loses authority at that final fence, the
feature has been explicitly turned off and the original result passes unchanged; otherwise an
active-filter failure is fail-closed.

```yaml
# hooks/result-filter.yaml
id: result-filter
module: ../lib/result-filter.mjs
events: [afterToolResult]
mode: decide
capabilities: [filter:tool-result]
budget: { timeoutMs: 1000, maxTokens: 64 }
```

Hooks remain metadata-first. The result-filter dispatcher is the only consumer that imports this
module; `LifecycleHub` does not treat `afterToolResult` as a normal post-persistence event. Filter
hooks receive no Host API, credentials, session object, tool arguments, policy object, callback,
or persistence/transport handle.

See [Extension capability grants](../extension-capability-grants.md) and the
[Extension Host authoring guide](../extension-host-authoring.md#post-tool-result-filter) for the
operator and author contracts.

## Closed result and proposal contract

Core accepts one strict canonical terminal result:

```ts
type SafeToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp"; data: string };

type CanonicalToolResult = {
  content: readonly SafeToolResultContent[];
  details?: JsonValue;
  isError: boolean;
  usage?: SafeUsage;
};

type ToolResultFilterProposal = {
  kind: "tool-result-filter";
  version: 1;
  action: "pass" | "replace" | "redact" | "reject";
  ruleId: string;
  reasonCode: string;
  replacement?: {
    content: readonly SafeToolResultContent[];
    isError?: boolean;
  };
};
```

The inspection also carries the server-derived `event`, session/project IDs, and tool call/name.
All objects are closed and validated: unknown fields, accessors/prototypes, malformed text or
base64, unsafe identifiers, unsupported media, malformed JSON, and excess size/depth are rejected.
The relevant core ceilings are 256 KiB canonical input, 64 KiB text block, 128 KiB decoded image
block, 32 blocks, 16 KiB `details`, 64 KiB complete replacement, 16 selected hooks, and 128-byte
identifiers.

`pass` and `reject` forbid `replacement`; `replace` and `redact` require a complete replacement.
A replacement cannot preserve original `details` or `usage`, or introduce a patch/range, URL,
callback, argument, free-form explanation, or arbitrary metadata. `redact` is an auditable action,
not a generic redaction language. `ruleId` must equal the declaring hook ID. `reasonCode` is a
bounded identifier; core maps it to its own fixed observability vocabulary rather than persisting
worker prose.

### Deterministic reduction and rejection

The dispatcher runs up to 16 eligible hooks concurrently, then reduces valid still-authorized
proposals in this order:

```text
reject > redact > replace > pass
```

This is EP-4-style deny-wins behavior: one valid `reject` beats every pass or transform. Within an
action severity, active pack precedence and stable `extension:<packId>:<hookId>` identity choose
attribution, never completion order. Losing valid proposals are recorded as `superseded` metadata.

A rejection, malformed proposal, timeout, worker crash, authority failure, abort, gateway failure,
or admission refusal produces only this core-owned synthetic result (with a fresh opaque reference):

```ts
{
  content: [{ type: "text", text: "Tool result withheld by project result policy [ref: <opaque-id>]." }],
  isError: true,
}
```

The original content, `details`, image bytes, and usage are absent. A valid replacement/redaction
also drops original `details` and usage. No filter selected at invocation is normal pass-through.

## Pi gate and route

Bobbit installs one generated gate for a protected session through Pi's private loader input. The
gate is installed before ordinary extensions and is checked at setup; a missing patched Pi API or a
failed gate write fails protected-session setup rather than silently starting a raw-result session.
The gate snapshots intrinsics, accepts only own-data canonical containers, caps its request at 256
KiB, waits no more than 2.5 seconds, strictly validates the response, and never logs a body or
caught error. A bad local value, timeout, non-success response, malformed response, or transport
failure returns the synthetic result locally.

The gate makes exactly this internal bridge call:

```text
POST /api/sessions/:id/tool-result-filter
{ toolCallId, toolName, result }
```

The server derives the session project and dispatches the canonical inspection. This is not an
extension or public policy endpoint. It accepts a bounded body, attaches a disconnect abort signal,
and returns a synthetic result for a recognized malformed request or dispatch failure without
echoing any raw input. The companion operator-only audit read is:

```text
GET /api/sessions/:id/tool-result-filter-audit?limit=1..200
```

See [REST API — Tool-result filter bridge and audit](../rest-api.md#tool-result-filter-bridge-and-audit).

### Streaming and peak cap

The patched Pi core suppresses protected `tool_execution_update` events before ordinary event
fan-out. Pi updates are cumulative snapshots, so the 256 KiB protected-update limit is the **peak
size of one snapshot**, not the sum of all chunks. This corrects the earlier chunk-sum wording:
multiple smaller cumulative snapshots do not consume a cumulative byte allowance. If the largest
snapshot exceeds the cap, Pi emits no raw update and replaces the terminal result with a fixed
protected-overflow synthetic error before the gateway route is called.

The terminal canonical result is separately capped before the generated gate posts it. Structured
JSON, text, image, binary-like content, and errors all use the same strict terminal path; invalid
or oversized values never release a prefix or preview.

## Protected-session trust boundary

A result-gate session shares Pi's private realm with `--extension` code. That is not a safe place
for untrusted Marketplace Pi extensions or non-built-in Bobbit tool-extension providers: either
could alter Pi internals before result handling. Protected-session activation therefore rejects
those combinations with `TOOL_RESULT_FILTER_UNTRUSTED_EXTENSION_CONFLICT`.

The `RpcBridge` repeats the authoritative check immediately before direct or Docker spawn. It
canonicalizes every final ordinary `--extension` path by realpath and permits it only below the
shipped built-in tools root or a closed list of core-owned generated-extension state roots. It
rejects missing files and symlink escapes. Earlier provenance checks provide useful setup errors,
but this final spawn-time fence is the security boundary.

For Docker sessions, the generated gate is a content-addressed regular file under the server-owned
state root. The gate subtree is bind-mounted at `/bobbit-state/tool-result-filter` read-only; Docker
preflight verifies both that read-only mount and the patched Pi markers. The sandbox cannot rewrite
a gate reused by another session. The gateway verifies cached content before reuse and rejects
symlinked roots/files. On POSIX, the generated root and digest directory are traversable (`0755`)
and the gate is read-only (`0444`); Windows must not rely on POSIX mode bits, so path identity,
regular-file/symlink checks, content validation, and the Docker read-only mount remain the
portable enforcement points.

## Admission, cancellation, and lifecycle

The dispatcher takes synchronous all-or-nothing admission for the whole selected worker set. It
does not queue a protected raw result. The platform caps global workers at 64 and in-flight calls
per session at 64; worker execution is capped below the gate deadline (2 seconds). An admission
failure fails closed.

A request disconnect aborts the dispatch. An abort during Pi result handling discards the pending
raw result and settles only with the fixed aborted synthetic result if Pi must settle; late workers
cannot restore a pass. Buffered result state is volatile. Gateway restart, process exit, or
respawn recomputes activation and never replays a raw pending result. Session creation, restore,
role replacement, and force-abort replacement all use the same activation/setup path, so a session
with an eligible live filter either installs the gate or fails to start safely.

Concurrent calls are isolated by session/tool-call identity and independent admission state.
Completion timing cannot change reduction order or cross-settle another call.

## Metadata-only observability

The project-owned capped JSONL audit and EP-5 Context trace record only core-normalized metadata:
identity, selected action/outcome, fixed reason/rule identity, input/output byte counts, and
latency. They never include result text, replacement text, `details`, usage, MIME/blob data,
arguments, hashes/fingerprints, URLs, exception text, policy prose, or raw request/response
bodies. Audit storage and trace failures are non-fatal and use fixed log labels only.

The regular trace REST, WebSocket, browser normalizer, and component remain data firewalls. The
operator audit route is likewise metadata-only. This makes observability useful for diagnosing a
decision without becoming an escape path for withheld or replaced data.

## Verification and scope

The deterministic fixture pack in `tests2/_fixtures/tool-result-filter/` exists solely to prove
interception. It matches unique test canaries and returns pass, replace, redact, or reject; its
competing hook proves reject-wins ordering. It is not installed production policy and is not a
credential detector.

Focused core, integration, patched-Pi, and browser tests cover closed contract validation,
pre/post-grant fences, live revocation, timeout/malformed/abort/admission failure, private update
suppression, peak-cap overflow, trusted-extension and Docker mount checks, restart/respawn, and
metadata-only audit. Canary assertions prove rejected and replaced originals do not reach model
input, Pi/transcript persistence, RPC/EventBuffer/WebSocket/browser output, search, traces/audit,
logs, compaction/recovery, or result artifacts.

EP-14 filters disclosure after a tool has already run; it cannot undo side effects or authorize a
tool call. Real gateway credential-containment policy — detector corpus, credential taxonomy,
false-positive handling, policy configuration/UI, and remediation — is explicitly deferred to a
later top-level goal.
