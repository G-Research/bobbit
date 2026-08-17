# Claude Agent SDK sessions

Bobbit can run an agent session through the official
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
instead of the Pi agent process. This is a runtime boundary for session lifecycle,
not a second chat protocol, model catalogue, permission system, or tool integration.
It lets Bobbit use the SDK while retaining its established session queues, events,
persistence, and recovery rules.

## Selecting the runtime

The Agent SDK runtime is opt-in through Bobbit's built-in model catalog. Its
only selectable models are the stable aliases:

```text
claude-agent-sdk/sonnet
claude-agent-sdk/opus
claude-agent-sdk/fable
claude-agent-sdk/haiku
```

Select one as the default session model or a role's `model`. Bobbit sends the
alias to the SDK and derives its display, capability, and pricing metadata from
the matching pinned Anthropic catalog row. The alias stays the configured and
persisted public model identity even if the SDK reports a resolved model behind
it. This keeps SDK routing stable without exposing dated Pi Anthropic IDs as SDK
selections.

A complete, usable Anthropic OAuth subscription credential is the only way an
SDK alias becomes authenticated and runnable. Without it, the picker marks the
alias as requiring Anthropic subscription OAuth. An Anthropic API key, a partial
or rejected OAuth row, and a native Claude CLI login do not satisfy that
requirement. All other providers, including `anthropic/*` and `aigw/*`, remain
Pi-backed. This explicit split prevents an existing Anthropic session from
changing runtime merely because an SDK is installed.

The `claude-agent-sdk` provider namespace is reserved case-insensitively. A
custom provider whose id **or name** claims it is ignored, including a legacy
saved provider; it cannot add arbitrary SDK models or impersonate the runtime.
Remove that obsolete custom-provider entry rather than attempting to repair it.

An AI Gateway is separate from this runtime. With the default
`aigw.exclusive` setting, a configured gateway hides all direct built-in rows,
including SDK aliases; the gateway's own models remain selectable and Pi-backed.
Set `aigw.exclusive` to `false` only when direct upstream access is intentional
to show the built-ins alongside AIGW. AIGW never routes or authenticates the SDK
runtime.

`MANUAL_CLAUDE_AGENT_SDK_MODEL` and `MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR` are
only opt-in manual-smoke-test inputs. The model value is an unprefixed built-in
alias (for example, `sonnet`). The auth-directory value identifies the
owner-only, temporary `BOBBIT_AGENT_DIR` used by the isolated smoke gateway.
The lifecycle spec maps it to `BOBBIT_AGENT_DIR` before resetting agent-directory
state or importing auth-sensitive server modules, because those modules can cache
startup-derived directory state. The smoke uses the built-in alias catalog and a temporary default session
model. Neither variable changes a developer's production gateway; use the
configuration above for production selection.

### Manual OAuth isolation

For an opt-in smoke, create a fresh owner-only temporary agent directory and
connect Anthropic OAuth through a separate Bobbit gateway bound only to loopback
with that directory as `BOBBIT_AGENT_DIR`. Export the same directory to the
Playwright process as `MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR` before it starts. This
keeps the test's OAuth state separate while letting Bobbit's normal locked OAuth
resolver supply the current access token; never copy or paste tokens, auth files,
or credential values.

Do not place subscription OAuth alongside enterprise Anthropic OAuth in one
normal Bobbit instance for this run. Keep the temporary directory until the
sanitized run evidence has been reviewed and the user has signed off, then remove
it through the normal cleanup process. Do not clean it early merely because a
smoke process ended.

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

## Docker sandbox sessions

When a project's sandbox is set to Docker, an SDK session runs its SDK-owned
Claude Code subprocess in that project's existing pooled `ProjectSandbox`
container. `SandboxManager` remains the only owner of container creation,
reuse, health, and recovery; the SDK does not create a second container runtime.
Its custom spawn hook executes the image-pinned launcher with `docker exec -i
-w <container-cwd>`.

Session setup translates the ordinary project cwd to `/workspace`, or to the
matching `/workspace-wt/...` path for a sandbox worktree, before the bridge is
built. The process still sees the normal scoped Bobbit tool surface through the
Bobbit MCP server, so tools, permissions, queues, model/thinking controls,
steers, interrupts, and stop retain their established owners. SDK arguments are
opaque to Bobbit and do not use Pi command remapping.

The sandbox image prerequisites are exact: Agent SDK `0.3.222`, bundled Claude
`2.1.222`, Pi `0.84.1`, Bobbit runtime schema `2`, the architecture-appropriate
SDK binary, and the fixed executable `/usr/local/bin/bobbit-claude-agent-sdk`
wrapper running as the image-owned `bobbit-sdk` identity. The image, rather than
the host, owns these dependencies. Bobbit verifies the SDK label, wrapper
identity/version, SDK module, separate UID, and runtime schema before launch.
It also prepares node-owned workspace roots, requires the selected workspace to
be owned/readable/executable as appropriate, and translates the scoped gateway
callback to the container-reachable address. These checks prevent a host binary,
a stale image, or an untrusted workspace/callback from receiving SDK authority.

Rebuild the `bobbit-agent` image after an SDK, Claude, Pi, schema, UID, or
launcher change. A host/global `claude`, a bind-mounted dependency tree, or a
manually rewritten callback is never a substitute.

Each Bobbit project uses a deterministic private Docker named volume at
`/bobbit-state/claude-agent-sdk`, separate from the host project state bind
mount. The volume survives ordinary container replacement and restart, while an
explicit sandbox destroy removes it. The SDK process runs as fixed UID 1001
(`bobbit-sdk`), distinct from the model-invocable `node` UID 1000. This prevents
same-UID process inspection from exposing the SDK process environment to model
invocable tools.

Before node, Pi, or tool processes are exposed, Bobbit's root-only sandbox setup
locks and attests the SDK-state root. Its permanent intent and migration `flock`
files prevent a verifier from overtaking either an active migration or a queued
writer. The matching `bobbit-agent` image therefore needs `flock` as well as the
SDK, binary, and launcher. A stopped/new replacement may retire only validated
predecessor migration artifacts, then performs a bounded physical migration that
rejects links and aliases and applies SDK-private ownership and modes. A running
container never retrofits or deletes these artifacts: it is reported busy or
invalid and fails closed.

For a busy migration, wait and retry through Bobbit; do not delete lock files or
use `docker exec` to alter SDK state. If it remains invalid after normal
replacement, rebuild the matching image and use Bobbit's sandbox lifecycle to
recreate it. An explicit sandbox destroy also removes this private volume and
its archived SDK history. A pre-volume host bind is intentionally not reused or
archived as sandbox SDK state. SDK history remains SDK-owned: Bobbit reads it
with bounded, read-only SDK calls in the same pooled container, without requiring
a terminated worktree to still exist. Those history calls have no OAuth or
Bobbit gateway authority, and Bobbit does not create a Pi JSONL fallback or a
second transcript store.

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
the established visible-snapshot pipeline. Consequently, live snapshots,
archived SDK history, `GET /api/sessions/:id/transcript`, `read_session`, and
identity-addressed SDK tool-content reads use one official-history projection;
none creates or falls back to a Pi transcript. Pi history remains JSONL-backed.

### Partial streaming and durable history

Bobbit opts into the SDK's pinned partial stream so the active turn can render
assistant deltas. Once the input is accepted, its user row is emitted before
those deltas; the final SDK assistant frame supplies the single finalized
assistant message. Partial frames are live UI transport only: they are not
transcript rows, restart state, or accounting input. Official history is
projected from finalized messages, so reload and resume do not reconstruct a
conversation from transient deltas or duplicate a streamed response.

The projection preserves SDK UUID row identity, tool-use IDs,
`parentToolUseId`, and `parentAgentId`. It applies the same server-side Bobbit
MCP-name resolver to live events and history: for example,
`mcp__bobbit__read` is presented as `read` in both paths. Foreign MCP and native
names remain unchanged. A constrained SDK child remains an audit partition of
its root session; it never creates a child session, task, worktree, or cost
account. The browser receives this server projection and must not repair raw
tool names or reconstruct transcript attribution.

### Embedded SDK helper work

A constrained SDK helper is shown only inside the real root `Agent` tool card
that admitted it. The only attachment key is the child's non-empty
`parent_tool_use_id` / `parentToolUseId`; child id, type, timing, and nearby
Agent calls are never fallback joins. This preserves root transcript order and
prevents interleaved child text or tools from leaking into root assistant prose.

`SubagentStart`/`SubagentStop` identify a child but do not provide that parent
key. Bobbit therefore correlates them only through the bridge-local verified
admission registry, then carries semantic child-work frames outside root
lifecycle, queue, status, transcript, and accounting handling. Root `Agent`
results remain the root-turn and durable-history terminal authority. Child
failures use safe bounded detail rather than provider error bodies and cannot
settle root session state.

Reload, archive, resume, and compaction snapshots keep nested activity in a
separate `subagentWork` envelope while root messages alone enter root ordering.
When child history is incomplete, Bobbit calls the official bounded
`listSubagents` and `getSubagentMessages` APIs. A returned row is renderable
only when its own exact parent id names a real root Agent/Task call; a listed
child id proves neither a parent nor lifecycle completion. This conservative
rule favors an auditable unknown/diagnostic state over misplaced prose.

See [embedded Claude Agent SDK subagent work (G10b)](design/claude-agent-sdk-subagent-rendering-g10b.md)
for the complete projection, recovery, renderer, and debugging contract.

### Root-result usage and cost

A finalized root SDK `result` is the only SDK accounting authority. Bobbit
normalizes its usage, model usage, context, SDK session/result identity, and
notional cost into a non-rendering internal record. It does not count assistant
`message_end` frames, partial stream updates, child partitions, replayed
snapshots, or `agent_end` without that record. If the root result omits a value,
Bobbit preserves it as unknown rather than deriving it from streamed text or
child metadata.

`CostTracker` durably records the opaque source-result ID and the resulting
aggregate in one atomic mutation. That mutation includes root totals, exact
SDK-model buckets, current and high-water context, and cost-basis state. The
private applied-ID ledger makes a repeated root result a no-op even after a
bridge replacement or gateway restart; it is not part of the public transcript,
REST, or WebSocket payload. See [Session usage and cost](session-cost.md) for
the public snapshot shape and billed/notional semantics.

The closed SDK environment reports subscription usage. Its SDK dollar estimate
is `notionalCostUsd` with `costBasis: "subscription-notional"` and
`totalCost: null`; it is not a billed API charge. A missing cost/basis remains
unknown rather than `$0`. G10b does not aggregate or interpret child
usage/cost metadata; accounting semantics remain outside its embedded-work
projection. This runtime contract only publishes the durable REST, WebSocket,
and state projection.

### SDK compaction checkpoints

The SDK owns compaction; Bobbit neither sends Pi `switch_session` nor exposes a
manual SDK compact operation. When the SDK invokes `PreCompact`, Bobbit captures
an SDK-specific pending checkpoint from the official normalized history and
emits one canonical `compaction_start` marker. The checkpoint stores the
pre-compaction root rows separately from Pi JSONL sidecars so the retained
pre-history remains available through
`GET /api/sessions/:id/transcript/before-compaction`.

`PreCompact` alone does not prove completion. Bobbit marks the checkpoint
complete, emits `compaction_end`, refreshes the message/state snapshot, and
keeps the pre-history only after official SDK history has changed. On restart
or reload it resumes with the same SDK UUID, hydrates the durable usage snapshot
before messages, and reconciles any pending checkpoint from official history.
That preserves stable transcript IDs, usage high-water marks, and audit
attribution without replaying usage or relying on browser state.

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
also covers unavailable history reads.

At public REST boundaries, an unavailable SDK source returns the stable opaque
response `503 { error: "SDK_SESSION_UNAVAILABLE", code:
"SDK_SESSION_UNAVAILABLE" }`. Provider errors, credential locations, SDK
session paths, and resume IDs remain private diagnostics. The same category
settles startup, readiness, and prompt delivery instead of hanging or falling
back to Pi. See [REST API — Transcript reader and `read_session`](rest-api.md#transcript-reader-and-read_session).

## Lifecycle and input delivery

Starting an SDK session creates an idle query handle and begins event consumption;
that lightweight readiness is bounded, but SDK query initialization is lazy. An
idle session can therefore be created before provider construction or OAuth is
exercised. The first accepted user input is the canonical startup boundary: it
causes initialization, identity/capability discovery, and any auth, import,
iterator, or provider failure. Those failures settle the input with
`SDK_SESSION_UNAVAILABLE` rather than hanging or falling back to Pi.

Operators may see only sanitized categories such as
`CLAUDE_AGENT_SDK_AUTH_UNAVAILABLE`, `CLAUDE_AGENT_SDK_SANDBOX_AUTH_UNAVAILABLE`,
`CLAUDE_AGENT_SDK_SANDBOX_UNAVAILABLE`, or `CLAUDE_AGENT_SDK_RATE_LIMITED`; public
REST remains opaque. Reconnect OAuth, repair the explicit sandbox policy or
matching image/workspace/callback prerequisite, and retry the existing session.
Do not expose diagnostics, start a replacement conversation, copy SDK state, or
add an API key.

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
returns `503 SDK_SESSION_UNAVAILABLE` and leaves no destination or copied Pi
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

The built-in SDK alias catalog remains the picker's source of available session
models. After the query initializes, however, the live `Query` is the authority for
whether a selected alias and its reasoning controls can actually run. The bridge reads
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
For example, the picker retains `sonnet` while the SDK receives that alias as
its wire value, even when the SDK resolves it to a concrete model. Bobbit never
adds a resolved model to the picker or silently rewrites the selected alias during
verified read-back.

The bridge publishes `reasoning` and `thinkingLevelMap` with its live model state.
Reasoning is true only when SDK metadata proves effort or adaptive-thinking support.
The map marks `off` and each canonical control as advertised or unavailable; it
never borrows Pi family heuristics or invents `minimal`. This live metadata overrides the
conservative built-in catalog row for an active SDK session, so clients see the
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
initialization, Bobbit retains the role/default candidate because the built-in
catalog row is deliberately conservative. After initialization, it normalizes
that candidate only from the bridge's live `reasoning` and
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

## Bundled skills and constrained SDK helpers

At the pinned Agent SDK `0.3.222` / Claude `2.1.222`, Bobbit enables only this
reviewed Claude-owned bundled-skill list:

```text
batch, claude-api, code-review, dataviz, debug, deep-research, design-sync,
doctor, fewer-permission-prompts, loop, run, run-skill-generator, simplify,
update-config, verify
```

The list is an SDK context filter and version pin, not discovery of Bobbit
`SKILL.md` files. Bobbit continues to own its commands and skill expansion as
described above; bundled slash commands are diagnostic only and never become
composer autocomplete, launchers, or durable command state. A new bundled skill
requires review and an intentional inventory update.

`Agent` is available only for three immutable, programmatic projections of
existing scoped Bobbit roles. They are query-local helpers, not Bobbit sessions,
team members, tasks, worktrees, or cost accounts.

| SDK type | Source role | Model | Max turns |
| --- | --- | --- | ---: |
| `bobbit-protocol-scout` | `claude-protocol-scout` | `inherit` | 6 |
| `bobbit-backend-parity-reviewer` | `backend-parity-reviewer` | `inherit` | 4 |
| `bobbit-billing-safety-auditor` | `billing-safety-auditor` | `inherit` | 4 |

For every bridge generation, session setup resolves the source prompt through
the existing role cascade and fixes the projection's prompt, `model: "inherit"`,
`maxTurns`, `background: false`, and `permissionMode: "default"`. It omits
optional child `effort`, so the inherited model uses the active root thinking
selection and only SDK-advertised capability rather than a fixed level that a
selected model may reject.
The reviewed bundled-skill pin belongs to the root query only. Child definitions
retain the native `Skill` capability for SDK compatibility, but deliberately omit
a `skills` list: strict isolated settings can otherwise make the SDK eagerly
resolve bundled skills while constructing a helper, before its read-only MCP
call. Each has no memory, observer, custom MCP server, or caller override. Its
read-only Bobbit-tool ceiling may include only root-selected and pre-allowed
`mcp__bobbit__read`, `mcp__bobbit__find`, and `mcp__bobbit__grep`; it has no
`bash`, write/edit, web, team, task, worktree, gate, or managed-MCP tool.

Root `Agent` admission accepts only one of those exact types, a bounded prompt,
and `run_in_background: false`. The call is correlated by its tool-use id with a
pending admission and must match the subsequent `SubagentStart` id/type before
the child gains its ceiling. Only one child can be live, the SDK process sets
spawn depth to one, and a child cannot invoke `Agent` or create a grandchild.
Native `Task` and every `Task*` operation remain disallowed at registration,
`canUseTool`, and `PreToolUse`; a legacy `Task` diagnostic label never grants a
native task store or lifecycle.

The active-child registry is bridge-local. A root result does not clear an
active entry because the SDK can publish its authoritative native
`task_notification` or `SubagentStop` afterward; the matching verified child
terminal then settles and removes the entry. Bridge stop, failure, replacement,
and disposal clear any remaining entry. Child frames retain their
`parent_tool_use_id` / `parentToolUseId` / `parentAgentId` partitioning, so a
child terminal cannot end the root turn. Bounded audit rows correlate the root
session and Agent tool-use id with child id/type, partition, outcome, and
duration; they deliberately exclude child prompts, responses, arguments, paths,
environment, and credentials.

All setup and admission failures fail closed. Missing, invalid, colliding, or
malformed approved-role inputs prevent SDK bridge readiness rather than omitting
or substituting a definition. Built-in, filesystem, unknown, nested,
background, override-bearing, unregistered, or over-limit requests, as well as
child tools outside the three-tool ceiling, are denied before dispatch.

The real initialization inventory has one version-specific reporting nuance:
in Claude `2.1.222`, the configured projections appear in both `init.agents`
and `initialization.agents`, while `Agent` is omitted from diagnostic
`init.tools`. This diagnostic omission does not change the configured `Agent`
admission path. The literal inventory remains the upgrade review boundary. See
[Claude Agent SDK skills and subagents (D3/D4)](design/claude-agent-sdk-skills-subagents.md)
for the complete failure matrix and acceptance coverage.

## Tool ownership and permissions

SDK sessions expose the Bobbit tool catalogue through one live, in-process SDK
MCP server named `bobbit`. The SDK adapter is deliberately not a second tool
registry or an HTTP callback: session setup resolves the ordinary scoped
`ToolManager` catalogue, policies, grants, goal-disabled tools, and managed MCP
routes first. It then adapts that immutable selection to the official SDK
`createSdkMcpServer()` / `tool()` APIs. Existing Bobbit builtin and extension
handlers remain the execution owners.

### Unified tool activation

Pi activation and the SDK surface consume the same resolved role and session
selection. A team tool such as `team_spawn` is available to an SDK session only
when its normal policy and goal/team authorization allow it; it is exposed as the
canonical Bobbit tool through `mcp__bobbit__team_spawn`, not as an SDK-native
team feature. The same rule applies to every scoped builtin, extension, gate,
and managed MCP operation. This avoids a runtime-specific role loophole while
leaving the established handler, grant card, audit, and team lifecycle in charge.

This gives the model one owner for each capability. Claude native `Bash`, file
and search/editor tools, web tools, question and plan tools, worktree,
background/scheduler/control tools, `NotebookEdit`, and `ToolSearch` are
suppressed. `Skill` and the constrained `Agent` admission point above are the
only retained native tools; `Task` and all `Task*` operations remain denied.
Bobbit replacements such as `bash`, `read`, `find`, `grep`, `web_fetch`,
`web_search`, and `ask_user_choices` are separate Bobbit MCP tools rather than
aliases of native ones. This prevents ambiguous tool choices and preserves
Bobbit's sandbox, rendering, policy, and UI ownership.

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
   tools are absent. The SDK gets native `Skill`, the constrained root `Agent`
   admission point, the complete native disallow list, and no tool aliases.
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
   any subagent-origin call outside the registered child's exact ceiling, even
   if another SDK permission path says allow. An `ask` approval is bound to the
   exact SDK tool-use id and canonical name, then consumed by the hook; a direct
   callback bypass without that approval remains `ask`.

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

Each bridge uses a restrictive Bobbit-owned `CLAUDE_CONFIG_DIR`. A direct
bridge uses a deterministic directory keyed by its Bobbit session, which survives
bridge replacement, restart, archive, and resume and is removed only when that
session is permanently purged. A sandbox bridge uses its deterministic
per-session directory in `/bobbit-state`. Both receive a closed environment
rather than inherited host or project settings.

Direct sessions require an active Anthropic OAuth connection in Bobbit. Bobbit
refreshes it under its existing lock and passes only the current access token to
the one SDK child process; it never copies a refresh token or native Claude CLI
configuration. A native Claude CLI login alone is insufficient. The same private
direct config root is used by the read-only official-history accessor, so a
replacement cannot silently switch to host CLI history.

### Sandbox subscription handoff

A sandboxed SDK session has one supported subscription path. The project must
explicitly enable an empty `ANTHROPIC_OAUTH_TOKEN` sandbox-token policy entry,
and Bobbit must have a usable Anthropic OAuth connection. Under the project auth
lock, Bobbit refreshes that connection if needed and passes only its current
short-lived access token to the SDK child as
`CLAUDE_CODE_OAUTH_TOKEN`. The token is in memory only for that `docker exec`;
it is not persisted, included in diagnostics, or passed to history reads.

This path fails closed. Bobbit never forwards the host refresh token, host
`.claude`/auth directory, provider settings, credential object, account
metadata, container PID 1 environment, generic sandbox credentials,
`ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN`. It does not run a host SDK query
or fall back to a global `claude` binary. An explicit project API-key or OAuth
credential is also rejected for this SDK sandbox path rather than treated as a
substitute. Existing Pi sessions retain their separate credential behavior.

Two sanitized startup errors are actionable:

- `CLAUDE_AGENT_SDK_SANDBOX_AUTH_UNAVAILABLE` means the explicit OAuth policy is
  absent or conflicts with a project credential, or the Bobbit OAuth connection
  is absent, expired, or cannot refresh. Enable the policy and connect Anthropic
  in Bobbit again; do not add an API key as a workaround. A native Claude CLI
  login is not a substitute.
- `CLAUDE_AGENT_SDK_SANDBOX_UNAVAILABLE` means the Docker launch prerequisites
  are incomplete, such as a stale/missing SDK image capability or launcher, an
  invalid container cwd, or unavailable scoped gateway authority. Rebuild the
  sandbox image and retry; restart the gateway if the error identifies scoped
  authority.

On restore, force-abort replacement, or pooled-container recovery, normal
sandbox wiring obtains the current container, translated cwd, scoped authority,
and fresh OAuth access token before rebuilding the bridge. The persisted SDK
UUID is passed as `resume`; secrets and launch descriptors are not persisted.

This isolation does not imply that the bundled Claude runtime reports no built-in
skills, agents, or slash commands. The real initialization inventory pins the
exact version-specific built-ins that the SDK reports, while Bobbit exposes only
the three programmatic projections described above. Hostile user, project,
plugin, MCP, and memory fixtures must still be absent from the inventory.

The trusted extension worker is intentionally a different boundary. It may
receive the scoped gateway URL and credential needed to run already trusted,
manifest-selected Bobbit handlers. It is launched by the gateway with a replaced,
minimal environment; the Agent SDK subprocess receives only its allowlisted
per-process authority. Do not add an SDK environment pass-through or a
config-loaded MCP integration to make a handler work.

## Restore, replacement, and cleanup

The tool surface is session-local, immutable, and never persisted. Session
persistence retains only the SDK's opaque resume id and normal Bobbit session
state. On restore, role or grant-driven restart, or forced-abort replacement,
SessionManager runs normal SDK setup again and builds a new surface from the
current scoped canonical policy; it does not reuse raw SDK names or mutate an
old MCP server in place. Pi's proxy/guard-extension path remains separate and
is not generated for SDK sessions.

Stopping or failed startup aborts pending input and permission work, closes the
SDK query, disposes the MCP surface and trusted worker, and clears one-time
approval state. Direct SDK config/history remains until the final session purge;
this preserves official history across replacement and resume without retaining
any OAuth token. This prevents old handlers or grant approvals from surviving
into a replacement bridge.

## Validation

Persistence and resume coverage is deterministic and does not require an SDK
account or credentials:

- `tests2/core/claude-agent-sdk-session-access.test.ts` covers official info and
  history access, cwd scoping, sanitized unavailable errors, valid empty history,
  and snapshot adaptation without Pi transcript access.
- `tests2/core/claude-agent-sdk-bridge.test.ts` covers initialization UUID
  validation, unavailable startup settlement, partial live streaming followed by
  one final assistant message, live official-history reads, and session-local SDK
  capability discovery, alias wire selection, effort/fixed/off transitions,
  unsupported controls, and failure-safe read-back state.
- `tests2/core/models-api.test.ts` covers the built-in SDK alias catalog,
  OAuth-only authentication, and the reserved custom-provider namespace.
- `tests2/integration/models-api.test.ts` covers AIGW-exclusive visibility and
  the separate AIGW routing boundary.
- `tests2/integration/claude-agent-sdk-runtime-persistence.test.ts` covers the
  minimal SessionStore tuple, strict metadata persistence, and dormant recovery
  that retains queued prompts and in-flight steers.
- `tests2/integration/session-runtime-route-boundary.test.ts` covers Continue
  preflight ordering, valid empty SDK sources, unavailable/no-destination
  behavior, and early SDK Fork rejection.
- `tests/e2e/claude-agent-sdk-session-restart.spec.ts` is the deterministic
  parent demonstration. It uses the production bridge's fake SDK seam to cover
  a canonical Bobbit `read` tool call, a real workflow-gate action, SDK-managed
  compaction and retained pre-history, crash/restart/resume, WebSocket reload,
  exactly-once root-result replay, opaque unavailable-provider failure, and a
  co-resident Pi control session.
- `tests2/core/controlled-model-fallback.test.ts` pins exact tuple read-back,
  verified-only persistence, live SDK capability metadata, explicit unsupported
  levels, and rollback behavior; `tests2/core/runtime-model-recovery-ownership.test.ts`
  pins replacement fencing.
- `tests2/browser/journeys/claude-live-controls.journey.spec.ts` verifies a
  production SDK bridge with mixed advertised controls, wire-model selection,
  verified persistence across reload, and rollback of a failed model request.

Run the deterministic parent demonstration directly from its fixed location:

```bash
npm run build
npm run test:e2e:run -- tests/e2e/claude-agent-sdk-session-restart.spec.ts
```

It does not need a Claude account or credentials. A real-subscription smoke is
additional evidence, not a replacement for this repeatable parent proof.

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
- `tests2/core/claude-agent-sdk-skills-subagents.test.ts` pins the bundled
  skill and programmatic-agent inventories, role bounds, foreground admission,
  one-child lifecycle registry, child read/find/grep ceiling, partitioned audit,
  and rejected unconstrained paths.
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
  a literal initialization inventory: version, tools, bundled skills, reported
  and programmatic agents, managed MCP server, plugins, settings, and auto-memory
  posture.

Run the focused deterministic coverage with:

```bash
npx vitest run --config vitest.config.ts --silent=passed-only \
  tests2/core/claude-agent-sdk-tool-surface.test.ts \
  tests2/core/claude-agent-sdk-skills-subagents.test.ts \
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

### Docker sandbox deterministic checks

The sandbox composition is covered without Docker credentials or a live
subscription. These checks pin the fixed image launcher, opaque SDK arguments,
closed/allowlisted environment, cwd validation, abort cleanup, full credential
redaction, OAuth-policy/API-key rejection, capability probing, container history
bounds, and replacement with the same SDK UUID in a new container:

```bash
npx vitest run --config vitest.config.ts --silent=passed-only \
  tests2/core/claude-agent-sdk-sandbox-spawn.test.ts \
  tests2/core/anthropic-sandbox-handoff-regression.test.ts \
  tests2/integration/claude-agent-sdk-sandbox-runtime.test.ts
npm run check
```

### Pending credentialed Docker dogfood

This preserved anchor names the credentialed Docker runbook and its completed
sanitized record in the [G11 dogfood design](design/claude-agent-sdk-g11-dogfood.md#completed-sanitized-agent-run-record).
For a repeat run, follow [Manual OAuth isolation](#manual-oauth-isolation) first:
authenticate through the separate loopback gateway and export its owner-only
temporary agent directory as `MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR` before Playwright
can reset directory state or import auth-sensitive modules. Run only with Docker,
a rebuilt `bobbit-agent` image satisfying the checks above, a local active
Anthropic OAuth subscription, and a built-in unprefixed alias. The no-override
path uses `haiku`; an explicit alias override remains available for a targeted
run. The scenario creates an isolated Docker project with the required enabled
empty `ANTHROPIC_OAUTH_TOKEN` policy, then verifies lifecycle and recovery without
using or logging API-key credentials.

```bash
BOBBIT_RUN_CLAUDE_AGENT_SDK_SANDBOX_SMOKE=1 \
MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR="$MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR" \
npm run test:manual -- --grep "Docker sandbox lifecycle"
```

The direct, non-Docker subscription smoke remains separately opt-in:

```bash
BOBBIT_RUN_CLAUDE_AGENT_SDK_SMOKE=1 \
MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR="$MANUAL_CLAUDE_AGENT_SDK_AUTH_DIR" \
npm run test:manual -- --grep "Claude Agent SDK lifecycle"
```

## Dogfood record and parent release boundary

Run the credential-free unavailable-provider case before a credentialed run. It
must settle with `SDK_SESSION_UNAVAILABLE`, not hang, create a replacement
conversation, or route the SDK session to Pi:

```bash
npm run test:manual -- --grep "provider-unavailable failure"
```

Then record the deterministic checks, restart E2E, and literal
initialization-inventory test before either opt-in command. They prove the
implementation boundary, but do not prove a local OAuth login, live capability,
or Docker credential handoff.

An agent-run Playwright/API signoff requires bounded direct and supported Docker
observations. It is evidence for G11, not a parent release decision. Use the
completed sanitized record and the empty reusable matrix in the
[G11 dogfood design](design/claude-agent-sdk-g11-dogfood.md#completed-sanitized-agent-run-record).
Automatic compaction remains observation-only: do not invoke or fabricate it.

For the original implementation rationale and acceptance plan, see
[Claude Agent SDK session lifecycle design](design/claude-agent-sdk-session-lifecycle.md)
and [Claude Agent SDK tool-surface design](design/claude-agent-sdk-tool-surface.md).
