# Claude Agent SDK sessions

Bobbit can run an agent session through the official
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
instead of the Pi agent process. This is a runtime boundary for session lifecycle,
not a second chat protocol, model catalogue, permission system, or tool integration.
It lets Bobbit use the SDK while retaining its established session queues, events,
persistence, and recovery rules.

## Selecting the runtime

The Agent SDK runtime is opt-in. It is not added to Bobbit's model catalog and
session creation does not accept a per-request `initialModel` selector. First,
register a **Custom Provider** whose exact id is `claude-agent-sdk` and add the
SDK model id you intend to use. Then select it through existing configuration:
set the default session model or a role's `model` to:

```
claude-agent-sdk/<model-id>
```

The custom-provider display name must also leave `claude-agent-sdk` as the
provider prefix exposed to selection. Only that exact provider selects this
runtime. All other providers, including every existing `anthropic/*` selection,
remain Pi-backed. This explicit split prevents an existing Anthropic session
from changing runtime merely because an SDK is installed.

`MANUAL_CLAUDE_AGENT_SDK_MODEL` is only the opt-in manual-smoke-test input. Its
value is the unprefixed model id (for example, `claude-sonnet-4-5`); it neither
registers the provider nor configures a gateway or default session model.

Bobbit derives and persists runtime from the selected provider; the runtime is
not a separate preference. Replacement cannot change an existing session between
Pi and SDK; create a new session for a cross-runtime model choice.

## Review workflow selection

Workflow choice is separate from runtime selection. The registered
`claude-runtime` workflow is for changes whose correctness depends on the Claude
Agent SDK contract or its subscription-only boundary; it does not make a session
use the SDK. The selected `claude-agent-sdk/<model-id>` provider still decides
that.

| Scope | Select | Required evidence |
| --- | --- | --- |
| A narrow empirical SDK or fixture question | A protocol-only, goal-specific snapshot using the `protocol-spike` gate | Version-tagged, sanitized observed setup and SDK evidence; record unresolved questions rather than inferring behavior. |
| Setup or provider-selection work with no end-to-end SDK session claim | A reduced, goal-specific `claude-runtime` snapshot | Retain the applicable protocol/design, parity, and billing checks; state which gates are omitted and why. It cannot claim real-session coverage. |
| Session lifecycle, tools, persistence, transcript/usage, rendering, auth, billing, or any user-visible SDK behavior | The full registered `claude-runtime` workflow | All workflow gates, including real-subscription dogfood evidence. |
| Work with no Claude-runtime safety contract, such as unrelated documentation | `general` | The ordinary workflow evidence. |

The named `claude-runtime` definition is the full workflow. A protocol-only or
reduced scope must be proposed as a valid inline workflow snapshot before goal
creation, not obtained by silently skipping gates on an active goal. Bobbit uses
the same validation and verification engine for these snapshots. Every goal
stores its own frozen workflow copy, so later edits to the project template do
not change work already in progress; use the explicit goal-workflow replacement
flow when a live goal genuinely needs a different contract. See
[Goals, Workflows, Tasks & Gates](goals-workflows-tasks.md#workflows).

The full workflow assigns three narrow specialists in addition to ordinary
reviewers:

- **Claude Protocol Scout** gathers version-tagged, sanitized empirical evidence
  for a protocol spike. It is an evidence producer, not a gate verifier.
- **Backend Parity Reviewer** checks SDK fixture drift, Pi-default routing,
  canonical tool-policy names, and transcript/usage fidelity at shared seams.
- **Billing Safety Auditor** checks that subscription-only operation cannot
  inherit API, cloud, or alternate-auth fallback and that billed and notional
  usage remain distinct.

The dogfood gate is a content review by `spec-auditor`. Deterministic tests do
not replace it: the submitted matrix must record the opt-in real-subscription
command, installed SDK/Claude version, unprefixed model ID, sanitized
`apiKeySource`/subscription proof, lifecycle results, transcript and usage
observations, and any exercised browser-rendering screenshots. The specialist
roles do not pin a provider or model; they inherit the goal's resolved model, so
review coverage does not introduce an API-provider selection. See the
[Claude runtime review workflow design](design/claude-runtime-review-workflow.md)
for the gate layout and evidence rules.

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

## Persistence, history, and recovery

A Bobbit session still has one `SessionStore` record. For SDK recovery, that
record holds only the derived runtime, the SDK's opaque session UUID, and the
existing verified model/provider/thinking tuple. The UUID is persisted before
the session becomes idle. Bobbit does not write SDK history, create a second
transcript database, or use a Pi JSONL as an SDK fallback.

The SDK remains the transcript authority. Bobbit reads its official
`getSessionInfo` and `getSessionMessages` APIs using the persisted session cwd.
The information lookup establishes that the source exists, which distinguishes a
valid empty conversation from an unavailable source. A pure adapter then feeds
the established visible-snapshot pipeline. Consequently, live snapshots and
archived SDK history have the same rendered shape without making a Pi transcript
or a new history protocol. Pi history remains JSONL-backed.

The lifecycle split is intentional:

- The bridge owns its SDK query, readiness, input stream, event translation, and
  observed UUID for one bridge lifetime.
- `SessionManager` owns status, the durable prompt queue, the in-flight steer
  ledger, replacement fencing, sidecars, and client broadcasts. A queued prompt
  or unacknowledged steer therefore remains Bobbit-owned during recovery rather
  than becoming SDK transcript state.

Every SDK startup that reconstructs a bridge uses the same persisted UUID as SDK
`resume`: ordinary restore after a gateway restart, role-driven replacement, and
force-abort replacement all follow that rule. A stopped bridge itself is terminal;
a later restore creates a new bridge and resumes the same SDK conversation. SDK
`PreCompact` invokes Bobbit's existing `beforeCompact` lifecycle hook and does
not replace the UUID. Manual SDK compaction remains unsupported.

A missing, malformed, or no-longer-accessible UUID/source never starts a new
conversation. On restore it leaves a dormant terminated session with a clear
`SDK_SESSION_UNAVAILABLE` restore error while retaining the durable queue and
in-flight steers. Check that the configured SDK runtime can access the original
conversation from the session's project context, then retry restoration; do not
copy transcripts, inspect SDK storage, or add credentials to logs. This status
also covers unavailable history reads, with sensitive error details sanitized.

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

## Restart, fork, and archived sessions

Runtime recovery deliberately uses different history sources. Pi restores its
JSONL transcript with `switch_session`. The SDK instead reconstructs its
in-process query with the persisted opaque SDK resume UUID and never sends
`switch_session`. This is true for normal restart and gateway restore as well as
role and force-abort replacement. Pi restart, history, Fork, and Continue
behavior is unchanged.

**Continue in New Session** preserves this boundary. Before allocating a
destination, creating a worktree, or writing a new `SessionStore` row, an
archived SDK source must have a valid UUID and exact SDK model tuple, and Bobbit
preflights it through official `getSessionInfo`. A missing or expired source
returns `404 SDK_SESSION_UNAVAILABLE` and leaves no destination or copied Pi
artifacts. Invalid stored metadata returns `422 RUNTIME_CONTINUE_UNSUPPORTED`.
A confirmed source with zero messages is valid: Bobbit creates a fresh wrapper
that uses the exact tuple and the same resume UUID. It does not copy Pi JSONL or
sidecar data; the archived source remains archived.

**Fork** remains a Pi-only JSONL operation. Although the SDK exports
`forkSession`, Bobbit has no atomic lifecycle contract that joins an SDK fork to
an active-query snapshot, destination/worktree creation, sidecar ownership, and
rollback. An SDK source therefore returns `422 RUNTIME_FORK_UNSUPPORTED` before
any destination allocation, Pi transcript handling, worktree setup, or sidecar
work. See [Session runtime identity](design/session-runtime-identity.md) and the
[REST endpoint contract](rest-api.md#fork-session-endpoint).

## Live model and thinking controls

An SDK session can change model only within `claude-agent-sdk`; switching providers
requires a new session. Live controls use the existing session WebSocket model-tuple
transaction, not a second SDK-specific persistence or broadcast path. In particular,
Bobbit does not replace a healthy SDK session merely to simulate a model or thinking
control. A replacement is recovery for an unverified partial mutation, not the way a
supported SDK control is implemented.

### Capability authority and model identity

Configured custom-provider rows remain the picker's source of available session
models. After the query initializes, however, the live `Query` is the authority for
whether an SDK model and its reasoning controls can actually run. The bridge reads
its initialization `models` and prefers `supportedModels()` when that method is
available. It converts those SDK rows into capability records owned by that one
bridge; it does not seed a process-wide catalog or mutate `model-registry` caches.
This matters because an SDK query replacement can expose different capabilities, and
stale process-global metadata would outlive the query that proved it.

A capability record uses the SDK's `value`, optional `resolvedModel`,
`supportsEffort`, `supportedEffortLevels`, and `supportsAdaptiveThinking` fields.
It matches a requested id against both `value` and `resolvedModel`, but preserves the
SDK `value` as the private wire value passed to `Query.setModel()`. The requested
configured identity remains the public identity in live state and the durable tuple.
For example, a picker can retain `sonnet` while the SDK receives that alias as its
wire value, or it can retain `claude-sonnet-5` while resolving it to the SDK wire
alias. Bobbit never silently rewrites either form to the other during verified
read-back.

The bridge publishes `reasoning` and `thinkingLevelMap` with its live model state.
Reasoning is true only when SDK metadata proves effort or adaptive-thinking support.
The map marks `off` and each canonical control as advertised or unavailable; it
never borrows Pi family heuristics or invents `minimal`. This live metadata overrides the
conservative manual provider row for an active SDK session, so clients see the
capabilities that the query, rather than the registry, has verified.

### Applying controls

The bridge resolves a thinking request against the active model's live capability.
It uses the appropriate SDK control instead of translating one control family into
another:

| Proven capability / request | SDK operation |
| --- | --- |
| Advertised effort level | Clear any fixed budget with `setMaxThinkingTokens(null)`, then call `applyFlagSettings({ effortLevel })`. |
| Adaptive-thinking fixed-token level | If available, clear prior effort with `applyFlagSettings({ effortLevel: null })`, then call `setMaxThinkingTokens()` with Bobbit's fixed budget for that level. |
| `off` | If available, clear prior effort, then explicitly call `setMaxThinkingTokens(null)`. |

Clearing the other control family prevents a prior effort setting or fixed budget
from surviving a model or level transition. The bridge changes its locally reported
model or thinking value only after the corresponding SDK call succeeds; SDK errors
propagate to the session transaction.

For **interactive live requests**, unsupported input is explicit, never a clamp. A
configured model that the live SDK advertised-model list does not contain is rejected
without calling `Query.setModel()`. Likewise, a non-`off` level absent from the
active live map is rejected without a thinking mutation. If an older SDK provides no
model data, Bobbit keeps a conservative compatibility path: a configured SDK model
may still be selected, but only `off` is available. If the SDK advertises effort but
lacks `applyFlagSettings()`, advertised effort is rejected rather than emulated;
`off` continues to clear the token budget. These cases let the UI make unavailable
controls visible while keeping a direct or stale client request safe.

Initial SDK thinking is not an interactive rejection path. Before Query
initialization, Bobbit retains the role/default candidate because the configured
manual provider row is deliberately conservative. After initialization, it
normalizes that candidate only from the bridge's live `reasoning` and
`thinkingLevelMap` metadata. A missing map, missing reasoning proof, or otherwise
insufficient SDK metadata yields the conservative effective value `off`; Bobbit never
falls back to Pi model-family heuristics or invents an SDK effort level.

`SessionManager` then applies the effective initial level through the bridge and
reads back the exact `(provider, modelId, thinkingLevel)` tuple. It persists only
that verified effective tuple, not the raw preference, attempted request, or SDK
capability record. The bridge capability itself is not persisted: it is re-derived
whenever a query starts.

### Verified tuple transaction and recovery

`SessionManager` and the runtime model selector own the transaction. The bridge
only mutates its `Query` and reports live state; it never persists a request,
capability record, SDK `ModelInfo`, or broadcast. For a model-plus-thinking request,
the selector follows this order:

1. Read the durable and live tuple, validate the configured model and live SDK
   capability, and fence the current bridge owner.
2. Mutate the model, then require an exact model read-back.
3. Validate and mutate thinking, then require an exact final
   `(provider, modelId, thinkingLevel)` read-back and recheck ownership.
4. Only then persist the normal tuple, update the model-name mirror, and broadcast
   the verified model metadata and thinking level.

A standalone interactive thinking request uses the same validation, exact read-back,
commit, and broadcast rule. Therefore neither an interactive request nor an initial
preference becomes durable merely because an SDK call was attempted or returned: the
final effective state must match exactly. This also preserves alias identity—an
accepted alias is persisted and broadcast as that alias, not as an unrequested
resolved id.

On a rejection, SDK error, mismatch, or ownership change, the selector broadcasts a
correction from live or durable truth and performs the established bounded rollback.
If rollback cannot be verified, it uses normal bridge-replacement recovery from the
unchanged durable tuple; if that recovery is unsafe, it quarantines the affected
canonical session. Owner fencing prevents a delayed detached bridge from rolling
back, stopping, archiving, persisting over, or broadcasting over a newer canonical
replacement. A verified replacement instead remains authoritative and is the only
state that may be broadcast.

This contract is provider-scoped. Pi continues to use its registry-derived metadata
and existing thinking-level clamping behavior; SDK live capability checks neither
populate Pi metadata nor change Pi controls.

The SDK does not expose a manual compact operation, so Bobbit reports manual
compaction as unsupported rather than inventing Pi compaction events. SDK-managed
compaction still dispatches the existing Extension Platform `beforeCompact`
lifecycle hook through the SDK `PreCompact` hook. This keeps extension lifecycle
behavior additive without introducing a provider-specific hook.

### Composer slash commands

The composer, not the SDK, owns current Bobbit slash controls, discovered skills,
and active Extension Platform launchers. It builds its inventory from the scoped
skill catalogue, server collision claims, active `composer-slash` pack entries,
and the explicit session runtime. This prevents a Bobbit command from colliding
with a bundled Claude command while preserving the existing server skill
expansion pipeline.

In an SDK session, `/compact` is deliberately absent from autocomplete but exact
trimmed, case-insensitive input is consumed locally. The editor shows an inline
unsupported-command alert and retains the text, attachments, and focus; it never
calls the SDK. This avoids accidentally invoking Claude's bundled `/compact`.
Pi sessions instead show `/compact` and run Bobbit's existing local compaction;
attachments block that action without being discarded. While runtime identity is
still loading, `/compact` is also consumed with an unavailable-until-ready alert
rather than assuming Pi.

A current Bobbit skill named `/goal` or `/review` wins over a Claude command with
the same name. The editor only completes the token; normal send still reaches the
server, where the skill is expanded before `ClaudeAgentSdkBridge` receives the
final text. Without that exact Bobbit skill, `/goal`, `/review`, unknown slashes,
and near-prefixes pass through as raw runtime prompts. Hidden recognized skills
also mask same-named pack launchers, and ambiguous launcher ids never dispatch.

Pack launchers run only for an exact full-line command with no attachments and
use the existing compound entrypoint key. On reload or a project/session change,
Bobbit refetches scoped skills and reconciles active pack entries; launcher and
menu state are not persisted in drafts. Ctrl/Cmd+Enter normally steers text, but
refuses an exact Bobbit-owned command so an unexpanded skill or launcher cannot
reach the SDK raw. An open autocomplete menu owns Enter, Ctrl+Enter, and
Cmd+Enter to complete its selection before send or steer behavior applies.

These composer rules do not configure Claude commands or loosen SDK isolation:
query options still use `settingSources: []`, `strictMcpConfig: true`, and only
the live Bobbit MCP server. See the
[composer slash interception design](design/claude-sdk-composer-slash-intercept.md)
for the full ownership, collision, reload, and failure behavior.

## Tool ownership and permissions

SDK sessions expose the Bobbit tool catalogue through one live, in-process SDK
MCP server named `bobbit`. The SDK adapter is deliberately not a second tool
registry or an HTTP callback: session setup resolves the ordinary scoped
`ToolManager` catalogue, policies, grants, goal-disabled tools, and managed MCP
routes first. It then adapts that immutable selection to the official SDK
`createSdkMcpServer()` / `tool()` APIs. Existing Bobbit builtin and extension
handlers remain the execution owners.

This gives the model one owner for each capability. Claude native `Bash`, file
and search/editor tools, web tools, question and plan tools, task/subagent,
worktree, background/scheduler/control tools, `NotebookEdit`, and `ToolSearch`
are suppressed. `Skill` is the only retained native tool. `Agent` is reserved
and disallowed, and the SDK receives `agents: {}`. Bobbit replacements such as
`bash`, `read`, `find`, `grep`, `web_fetch`, `web_search`, and
`ask_user_choices` are separate Bobbit MCP tools rather than aliases of native
ones. This prevents ambiguous tool choices and preserves Bobbit's sandbox,
rendering, policy, and UI ownership.

The native inventory is intentionally version-pinned to the installed Claude
Agent SDK and bundled Claude binary. A dependency upgrade is not routine for
this runtime: review the observed inventory and update the declarative policy
and literal inventory test together before accepting the upgrade.

### Canonical and SDK names

A Bobbit tool has two identities:

| Identity | Example | Authority |
| --- | --- | --- |
| Canonical Bobbit name | `read` | catalogue lookup, policy and grant matching, dispatch, audit, persisted allowlists, and rendering |
| SDK raw name | `mcp__bobbit__read` | the SDK's `allowedTools`, permission callback, and `PreToolUse` hook |

The session-local surface is the sole normalizer. It accepts only a registered,
reversible `mcp__bobbit__<name>` identity (case-insensitively for lookup), then
returns the original canonical spelling. Native names, foreign MCP names,
malformed names, and unknown suffixes are not Bobbit tools. Raw identities may
appear in bounded diagnostics, but are never persisted or used as a grant or
renderer identity.

Construction fails closed when a catalogue name is invalid, reserved, or
case-collides after normalization. It also rejects an aggregate MCP server/sub
collision or duplicate operation. The startup error identifies the SDK session
and conflicting tool identity without exposing schemas, arguments, results, or
credentials. Operators should correct the selected pack/catalogue or MCP route;
Bobbit never chooses a last-writer-wins owner.

### Scoped surface and managed MCP operations

The surface begins after role/group cascade resolution and applies the explicit
session allowlist, goal-disabled set, and resolved policy. An unrestricted
allowlist is distinct from an explicitly empty restricted allowlist: the latter
registers no Bobbit MCP tools and denies all attempted Bobbit calls. `never`
tools stay in the policy snapshot so defensive checks can reject them, but are
not registered. `allow` tools are registered and pre-allowed; `ask` tools are
registered so they can request the established Bobbit permission decision.

Managed external MCP servers are not passed to Claude as SDK MCP connections.
Instead, Bobbit exposes its existing meta-tool form. One selected server/subtool
aggregate carries a schema whose `operation` enum is the exact permitted
operation snapshot. The handler keeps each original managed route and rejects a
forged, unknown, or `never` operation before it reaches `McpManager`. This keeps
managed MCP routing, policy, and credentials inside Bobbit while preventing a
second MCP owner.

Builtins and Bobbit extensions execute through a trusted, manifest-limited
worker. Before SDK registration, that worker loads only ToolManager-derived
extension paths and returns the actual handler schemas. A missing builtin schema
is a startup failure; a conditional extension tool that did not register is
omitted rather than assigned a permissive placeholder.

### Permission ceiling and grants

The same immutable surface is enforced three times because SDK convenience
allowlists alone are not an execution boundary:

1. **Registration and `allowedTools`.** Only selected non-`never` tools are
   adapted. `allowedTools` contains only raw names for `allow` tools; `ask`
   tools are absent. The SDK gets only native `Skill`, the complete native
   disallow list, and no tool aliases.
2. **`canUseTool`.** Each raw SDK call is normalized and rechecked. An `allow`
   tool is approved. An `ask` tool calls the existing
   `SessionManager.requestToolGrant()` path with its canonical Bobbit name,
   resolved group, SDK tool-use id, and abort signal. That path emits the normal
   `tool_permission_needed` and `tool_permission_settled` UI events; it is not a
   second SDK permission service. A successful resolution is accepted only when
   it covers the current canonical tool and, when supplied, the resolved group.
   Cancellation, timeout, supersession, stale or mismatched decisions, denial,
   expiry, and grant errors deny that invocation and settle the existing card.
3. **`PreToolUse`.** The hook normalizes and checks again immediately before
   execution. It rejects native, foreign, malformed, unselected, `never`, and
   subagent-origin calls even if another SDK permission path says allow. An
   `ask` approval is bound to the exact SDK tool-use id and canonical name, then
   consumed by the hook; a direct callback bypass without that approval remains
   `ask`.

An SDK one-time approval is never added to the query's `allowedTools` or a
surface callback cache; it permits one exact `PreToolUse` consumption. The
surface clears unconsumed approvals when disposed, so a late grant cannot pass a
replacement boundary. SessionManager retains its normal one-time grant
bookkeeping and revokes that grant at the end of the agent turn. Session-only
and persistent grants retain their existing SessionManager semantics; any bridge
rebuild derives a fresh canonical surface from that current state. Permission
mode remains `default`; permission bypass options are never set.

## Isolation and credential boundary

The query options are assembled in one place with `settingSources: []`,
`strictMcpConfig: true`, only the live `bobbit` MCP server,
`managedSettings.autoMemoryEnabled: false`, the native policy above, and the
three permission layers. No project/user/local Claude settings, `.mcp.json`,
plugin configuration, unmanaged MCP server, or auto-memory state is merged into
the Bobbit surface.

Each bridge creates a fresh restrictive `CLAUDE_CONFIG_DIR` under Bobbit state
and removes it during terminal cleanup. The SDK subprocess receives a closed
environment: platform home/path/temp/locale values plus the required session
identity variables. It does not receive gateway bearer tokens, provider keys,
arbitrary project environment values, or copied subscription credentials. The
normal home-directory subscription discovery remains available without placing
its credential in Bobbit state or logs.

This isolation does not imply that the bundled Claude runtime reports no built-in
skills, agents, or slash commands. The real initialization inventory pins the
exact version-specific built-ins that the SDK reports. `agents: {}` and the
reserved `Agent` tool prevent Bobbit from configuring or exposing a native
subagent execution surface; hostile user, project, plugin, MCP, and memory
fixtures must still be absent from the inventory.

The trusted extension worker is intentionally a different boundary. It may
receive the gateway URL and credential needed to run already trusted,
manifest-selected Bobbit handlers. It is launched by the gateway with a replaced,
minimal environment; the Agent SDK subprocess never receives that credential.
Do not add an SDK environment pass-through or a config-loaded MCP integration to
make a handler work.

The SDK launcher is host-local. SDK sessions therefore fail closed in Docker
sandboxes instead of escaping the project container boundary.

## Restore, replacement, and cleanup

The tool surface is session-local, immutable, and never persisted. Session
persistence retains only the SDK's opaque resume id and normal Bobbit session
state. On restore, role or grant-driven restart, or forced-abort replacement,
SessionManager runs normal SDK setup again and builds a new surface from the
current scoped canonical policy; it does not reuse raw SDK names or mutate an
old MCP server in place. Pi's proxy/guard-extension path remains separate and
is not generated for SDK sessions.

Stopping or failed startup aborts pending input and permission work, closes the
SDK query, disposes the MCP surface and trusted worker, clears one-time approval
state, and removes the isolated config directory. This prevents old handlers,
grant approvals, or config state from surviving into a replacement bridge.

## Validation

Persistence and resume coverage is deterministic and does not require an SDK
account or credentials:

- `tests2/core/claude-agent-sdk-session-access.test.ts` covers official info and
  history access, cwd scoping, sanitized unavailable errors, valid empty history,
  and snapshot adaptation without Pi transcript access.
- `tests2/core/claude-agent-sdk-bridge.test.ts` covers initialization UUID
  validation, unavailable startup settlement, live official-history reads, and
  session-local SDK capability discovery, alias wire selection, effort/fixed/off
  transitions, unsupported controls, and failure-safe read-back state.
- `tests2/integration/claude-agent-sdk-runtime-persistence.test.ts` covers the
  minimal SessionStore tuple, strict metadata persistence, and dormant recovery
  that retains queued prompts and in-flight steers.
- `tests2/integration/session-runtime-route-boundary.test.ts` covers Continue
  preflight ordering, valid empty SDK sources, unavailable/no-destination
  behavior, and early SDK Fork rejection.
- `tests/e2e/claude-agent-sdk-session-restart.spec.ts` runs a fake official SDK
  through prompt/history, `PreCompact`, gateway crash/restart, snapshot equality,
  resumed append, and co-resident Pi recovery.
- `tests2/core/controlled-model-fallback.test.ts` pins exact tuple read-back,
  verified-only persistence, live SDK capability metadata, explicit unsupported
  levels, and rollback behavior; `tests2/core/runtime-model-recovery-ownership.test.ts`
  pins replacement fencing.
- `tests2/browser/journeys/claude-live-controls.journey.spec.ts` verifies a
  production SDK bridge with mixed advertised controls, wire-model selection,
  verified persistence across reload, and rollback of a failed model request.

Run the focused deterministic coverage with:

```bash
npx vitest run --config vitest.config.ts --silent=passed-only \
  tests2/core/claude-agent-sdk-session-access.test.ts \
  tests2/core/claude-agent-sdk-bridge.test.ts \
  tests2/core/controlled-model-fallback.test.ts \
  tests2/core/runtime-model-recovery-ownership.test.ts \
  tests2/integration/claude-agent-sdk-runtime-persistence.test.ts \
  tests2/integration/session-runtime-route-boundary.test.ts
npm run check
```

The following regressions document the tool-surface contracts:

- `tests2/core/claude-agent-sdk-tool-surface.test.ts` pins the native policy,
  naming, collision failure, explicit-empty allowlist, three ceilings, and SDK
  option isolation.
- `tests2/integration/claude-agent-sdk-tool-permissions.test.ts` covers
  canonical dispatch/rendering, existing permission events, cancellation,
  one-time grants, trusted-worker schema preflight, managed MCP operation
  snapshots, credential separation, and cleanup behavior.
- `tests2/integration/claude-agent-sdk-permission-card-journey.test.ts` drives
  the real `SessionManager` grant seam through the SDK surface. It covers the
  canonical tool/group card request and settlement, one-time/session/persistent
  ownership, exact one-use `PreToolUse` consumption, deny, abort, timeout,
  stale and mismatched responses, disposal, and callback-bypass/native/foreign/
  `never`/subagent defenses.
- `tests/e2e/claude-agent-sdk-real-init-inventory.spec.ts` starts the official
  SDK/bundled Claude in a process-isolated hostile-settings fixture and compares
  a literal initialization inventory: version, tools, reported built-ins,
  managed MCP server, plugins, settings, and auto-memory posture.

Run the focused deterministic coverage with:

```bash
npx vitest run --config vitest.config.ts --silent=passed-only \
  tests2/core/claude-agent-sdk-tool-surface.test.ts \
  tests2/integration/claude-agent-sdk-tool-permissions.test.ts \
  tests2/integration/claude-agent-sdk-permission-card-journey.test.ts
npm run check
```

The real inventory uses built output and should be run explicitly after a build:

```bash
npm run build
npx playwright test --config playwright-e2e.config.ts \
  tests/e2e/claude-agent-sdk-real-init-inventory.spec.ts
```

A real-subscription lifecycle smoke remains opt-in. Supply an SDK model ID
**without** the provider prefix; this environment variable is test-only and does
not configure the gateway:

```bash
BOBBIT_RUN_CLAUDE_AGENT_SDK_SMOKE=1 \
MANUAL_CLAUDE_AGENT_SDK_MODEL=claude-sonnet-4-5 \
npm run test:manual -- --grep "Claude Agent SDK lifecycle"
```

For the original implementation rationale and acceptance plan, see
[Claude Agent SDK session lifecycle design](design/claude-agent-sdk-session-lifecycle.md)
and [Claude Agent SDK tool-surface design](design/claude-agent-sdk-tool-surface.md).
