# EP-14 — Tool-result filter seam

**Status:** implemented platform capability. **Scope:** a narrowly authorized, core-owned filter
for a completed tool result. It protects result disclosure after the tool has executed and before
Pi persists, sends, or exposes the result. It is not a credential detector, a general policy
language, a tool-call authorization path, or a way to undo a tool's side effects.

For the operator lifecycle, see [Extension Platform](../extension-platform.md). For exact grants,
see [Extension capability grants](../extension-capability-grants.md); authors use the [post-tool-result
filter declaration](../extension-host-authoring.md#post-tool-result-filter).

## The canonical boundary

The filter runs at Pi's protected-result gate, before Pi releases a result to its model history,
JSONL transcript, RPC, SessionManager, EventBuffer/WebSocket, UI, snapshots, search, compaction,
or durable result artifacts.

```text
completed tool handler
  → patched Pi privately buffers protected updates and terminal result
  → generated core result gate
  → authenticated, attempt-bound gateway callback
  → core dispatcher and eligible filter workers
  → one core-owned result
  → ordinary Pi persistence and fan-out
```

This placement is essential. Filtering in SessionManager, a renderer, transcript/search cleanup,
or an ordinary Pi extension is too late because Pi may already have persisted or shown the
original bytes. Protected streaming updates are held until the terminal decision; a malformed,
unholdable, or over-cap result releases no prefix. The peak protected-update limit is applied to
one cumulative Pi snapshot, not summed across successive snapshots.

## Authority and filter contract

The exact project capability is **`filter:tool-result`**. A hook is eligible only when it is all
of the following:

- from the winning, active schema-2 pack;
- `mode: decide` with **only** `events: [afterToolResult]`;
- declared with `capabilities: [filter:tool-result]`; and
- granted that exact live `(packId, hookId, capability)` tuple by the project operator.

Activation, `decide`, `mutate`, pack provenance, and a grant for another hook do not imply this
authority. A hook worker receives a frozen canonical result inspection and server-derived
session/project/tool identity. It receives no Host API, gateway bearer, signing key, session
object, tool arguments, policy object, callback, transport handle, or persistence API.

A filter returns one strict proposal: `pass`, `replace`, `redact`, or `reject`. `replace` and
`redact` provide a complete bounded safe replacement; they cannot patch original text, preserve
`details`/usage, provide a callback/URL, or carry free-form explanation. Core validates every
proposal and emits any synthetic withheld result itself.

## Ordered decision and live fences

Core takes one ordered active-policy snapshot, invokes all eligible workers within fixed admission
and timeout bounds, then reads the complete ordered policy again before applying anything. The
ordered identity includes pack precedence and hook identity, so a pack-priority change is treated
as a policy change, not as an arbitrary tie break.

The reducer is deterministic:

```text
reject > redact > replace > pass
```

A valid reject always wins. Within an action level, project pack priority and stable hook identity
choose attribution; worker completion time never does. Core records losing valid candidates as
superseded metadata only.

Each worker checks its exact grant before invocation and after it returns. The final snapshot
revalidates the complete active ordered set immediately before reduction. A malformed proposal,
timeout, abort, worker failure, admission failure, unavailable authority, or a partial policy
rotation/replacement/removal fails closed to the fixed core synthetic result. A replacement
session/runtime cannot reuse the predecessor's callback authority or apply its late work.

There is one intentional inert path: if no eligible filter exists when a result is handled, it
passes unchanged. If every previously eligible filter is fully revoked or disabled by the final
fence, core also returns the original result unchanged. That is a complete removal of the feature,
not a partial failure. Any other authority change fails closed rather than guessing which stale
policy should win.

## Callback authentication and key containment

The ordinary Bobbit bearer authenticates transport and session scope, but **a bearer alone is not
enough** to submit a protected result. The result-gate callback must also present a short-lived,
one-use attempt credential. The gateway consumes it synchronously before validation, worker
admission, or audit, so replay, a wrong tool call, a wrong runtime, expiry, or a duplicate request
gets only the fixed synthetic result.

The credential is bound to the live session, runtime generation, tool-call id, unique attempt,
and issuance time. Its signing authority is a fresh runtime key held by SessionManager. The key is
handed to the core Pi loader through a sealed, one-shot stdin bootstrap **before** normal RPC
begins. The loader consumes and closes that bootstrap channel before Pi becomes ready.

The signing key is deliberately absent from:

- the generated/mounted gate source;
- process environment and ordinary spawn arguments;
- Marketplace pack code and filter-worker context;
- transcript, trace, audit, logs, crash diagnostics, REST responses, WebSocket frames, and client state.

The generated gate derives only a per-attempt callback credential and sends that credential with
the normal bearer. A missing, malformed, or failed bootstrap, callback failure, bad response,
timeout, abort, or gate/Pi compatibility failure fails closed locally with the same synthetic
result. Runtime replacement, termination, and session removal invalidate the prior credential
state, so an old gate cannot authenticate a later runtime.

The final spawn boundary also rejects ordinary untrusted Marketplace Pi extensions from a
protected Pi realm. Every permitted ordinary `--extension` path is realpath-checked against the
shipped tools root or a closed list of core-owned state roots; symlink escapes and missing paths
fail setup. Docker additionally verifies the patched Pi seam and a read-only core-gate mount. This
is required because same-realm untrusted code could otherwise tamper with Pi internals before the
protected gate runs.

## Failure result and observability

Whenever filtering is active and core cannot safely produce an authorized result, it returns only:

```text
Tool result withheld by project result policy [ref: opaque-id].
```

The result is marked as an error and contains no original bytes, paths, worker prose, policy
rationale, `details`, or usage. Valid replacement/redaction likewise drops original `details` and
usage. Raw result bytes are transient callback/worker data only; they are not intentionally stored
in trace, audit, logs, sidecars, or recovery state.

The operator-only result-filter audit and the Context trace retain safe metadata such as identity,
selected action/outcome, fixed reason/rule identifier, size bucket/count, and latency. They never
retain result/replacement text, blobs, tool arguments, hashes, URLs, exceptions, or policy prose.

## Verification and limits

Focused tests cover contract validation, deterministic reject-wins reduction, grant and
activation fences, attempt-credential replay/binding/expiry, bootstrap failure, policy rotation,
runtime replacement, worker timeout/throw/malformed output, abort/admission failure, protected
streaming, Docker trust/mount checks, restart/respawn, and metadata redaction. Browser coverage
uses the fixture pack to grant a filter, inspect a redacted/replaced result and safe metadata,
revoke it, and prove the full revocation path is inert.

The fixture is transport coverage only. A real credential-containment policy—detector corpus,
credential taxonomy, false-positive handling, policy configuration/UI, and remediation—is
explicitly deferred to a later top-level goal.
