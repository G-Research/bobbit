# Claude Agent SDK sessions

Bobbit can run an agent session through the official
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
instead of the Pi agent process. This is a runtime boundary for session lifecycle,
not a second chat protocol, model catalogue, permission system, or tool integration.
It lets Bobbit use the SDK while retaining its established session queues, events,
persistence, and recovery rules.

## Selecting the runtime

The Agent SDK runtime is opt-in. Select a model as:

```
claude-agent-sdk/<model-id>
```

Only the exact `claude-agent-sdk` provider selects this runtime. All other providers,
including every existing `anthropic/*` selection, remain Pi-backed. This explicit
split prevents an existing Anthropic session from changing runtime merely because
an SDK is installed.

Bobbit persists the selected runtime. A persisted SDK session also carries the
opaque UUID supplied by the SDK, along with the normal model and thinking settings.
A restored or replacement session passes that UUID to SDK `resume`; it does not
read a Pi transcript or send Pi's `switch_session` command. A missing or invalid
opaque ID makes an SDK restore fail rather than starting unrelated history.

## Runtime architecture

`SessionManager` continues to own durable prompt queues, steer recovery, status,
and bridge replacement. It talks to either runtime through `IRpcBridge`:

- Pi sessions use the existing `RpcBridge` and its child-process RPC protocol.
- SDK sessions use an in-process `ClaudeAgentSdkBridge` and the official SDK
  `query()` API.

An SDK bridge creates one long-lived SDK `Query` for its lifetime. It feeds that
query a single async input stream and consumes its event stream. It never creates
one query per prompt. SDK events pass through the existing Claude SDK event
translator into Bobbit's normal agent-event stream; after a root turn ends, the
bridge resets only its per-turn translator state. This preserves existing event
ordering and makes turn completion a SessionManager concern.

The bridge deliberately does not implement the old CLI `stream-json` protocol or
manage a `claude` executable. The official SDK owns transport, streaming,
interruption, initialization, and resume; retaining one bridge boundary avoids a
second lifecycle protocol to maintain.

## Lifecycle and input delivery

Starting an SDK session creates the query, begins event consumption, and waits for
SDK initialization before the session is ready. Readiness is bounded (90 seconds)
and startup, iterator, import, authentication, or provider failures settle pending
calls with a sanitized `CLAUDE_AGENT_SDK_UNAVAILABLE` error. A provider that is not
installed or cannot authenticate therefore fails when an SDK session is started,
without delaying Pi sessions or leaving a session hung.

A prompt resolves only after its exact input row is accepted by the SDK input
stream. Delivery has a deadline, so a row that the SDK does not pull fails instead
of being silently accepted. SessionManager keeps ownership of its durable queue
until that acknowledgement, allowing its existing recovery path to retry the row
correctly.

A steer is the same ordered input stream with SDK priority `now`. It is delivered
after already accepted input and ahead of later queued input. Bobbit's existing
in-flight steer ledger remains the recovery authority, so an unacknowledged steer
can be restored once after restart or bridge replacement.

### Interrupting and stopping

These operations have different scopes:

- **Soft interrupt** calls the SDK query's interrupt operation. It leaves the
  query and input stream usable for a later prompt.
- **Forced abort** follows SessionManager's existing grace-and-replacement path.
  If graceful interruption cannot settle, the old bridge is stopped and a ready
  replacement resumes the persisted SDK session.
- **Stop or termination** closes input, rejects unsent acknowledgements, aborts
  the query, and closes it once. A stopped bridge is terminal and cannot restart.

## Model, thinking, and compaction

An SDK session can change model only within `claude-agent-sdk`; switching providers
requires a new session. The bridge updates its persisted model state only after the
SDK accepts the change.

Bobbit thinking levels map to fixed SDK maximum-thinking-token budgets (`off` maps
to no budget). As with models, a failed SDK call does not update the bridge's
reported setting.

The SDK does not expose a manual compact operation, so Bobbit reports manual
compaction as unsupported rather than inventing Pi compaction events. SDK-managed
compaction still dispatches the existing Extension Platform `beforeCompact`
lifecycle hook through the SDK `PreCompact` hook. This keeps extension lifecycle
behavior additive without introducing a provider-specific hook.

## Security and supported surface

The SDK receives a fresh, allowlisted environment for every session. It contains
only home, path, temporary-directory, locale, and required per-session Bobbit
variables. Gateway credentials, arbitrary project environment values, and generic
credential variables are not forwarded. The SDK may discover a locally authenticated
Claude subscription through the user's normal home-directory store; credentials are
not copied into the environment, session store, logs, or another session.

SDK options set `settingSources: []` and `tools: []` deliberately. Local Claude
settings and SDK tools are disabled until they have an explicitly designed and
reviewed Bobbit integration. This runtime does **not** claim SDK tool support.

The SDK's default launcher is host-local. To avoid escaping a project container,
SDK sessions fail closed in Docker sandboxes rather than launching on the host.

## Validation

Deterministic bridge tests cover readiness, stream delivery, steering, controls,
environment isolation, persistence, and resumed gateway sessions through the
production bridge seam. The gateway-restart coverage also verifies that an SDK
session resumes without Pi `switch_session`, while a co-resident Pi session still
uses its unchanged restore path.

A real-subscription smoke test is opt-in because it uses the local user's existing
Claude subscription. Supply an SDK model ID **without** the provider prefix:

```bash
BOBBIT_RUN_CLAUDE_AGENT_SDK_SMOKE=1 \
MANUAL_CLAUDE_AGENT_SDK_MODEL=claude-sonnet-4-5 \
npm run test:manual -- --grep "Claude Agent SDK lifecycle"
```

The smoke verifies bounded readiness, a prompt, steering, soft interruption,
termination, and allowlisted-environment subscription discovery. It must not be
used to copy or inspect subscription credentials.

For the original implementation rationale and acceptance plan, see
[Claude Agent SDK session lifecycle design](design/claude-agent-sdk-session-lifecycle.md).
