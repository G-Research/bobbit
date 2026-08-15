# Claude Agent SDK tool-surface reconciliation (D1)

## Decision

The `claude-agent-sdk` runtime will expose Bobbit tools through **one official,
in-process SDK MCP server**:

```ts
createSdkMcpServer({
  name: "bobbit",
  alwaysLoad: true,
  tools: definitions.map(({ name, description, schema, invoke }) =>
    tool(name, description, schema, invoke, { alwaysLoad: true }),
  ),
});
```

The session passes that live instance as its only MCP configuration and uses the
SDK's documented `Options.tools`, `allowedTools`, `canUseTool`, `hooks.PreToolUse`,
`settingSources`, `strictMcpConfig`, and managed settings controls. Bobbit remains
the authority for catalogue resolution, grants, rendering, and execution.

This is deliberately an adapter, not a second tool platform. It reuses:

- `ToolManager` for the scoped, cascade-resolved YAML tool catalogue;
- `computeEffectiveAllowedTools`, `computeToolPolicies`, and
  `resolveGrantPolicy` in `tool-activation.ts` for grants;
- the existing builtin/extension handlers, `ActionDispatcher`, and extension-host
  surfaces for execution; and
- `McpManager` for Bobbit-managed external MCP routing.

The current `ClaudeAgentSdkBridge` already has the correct runtime boundary and
starts an SDK query with `settingSources: []`. This slice replaces its empty
`tools: []` setup with the derived surface below. It does not add a gateway
callback protocol, an HTTP proxy endpoint, a private extension hook, another
catalogue, or a new permission store.

> **Superseded D3/D4 posture.** The original D1 proposal's Skill-only,
> `Agent`-denied, `agents: {}` posture is superseded for this runtime by
> [Claude Agent SDK skills and subagents](claude-agent-sdk-skills-subagents.md).
> D1 remains the canonical MCP, grant, canonical-name, `PreToolUse`, isolation,
> and G7 design. D3/D4 adds only the bounded native `Skill`/`Agent` surface and
> immutable subagent projections described below.

## Evidence and chosen official composition

The pinned package is `@anthropic-ai/claude-agent-sdk@0.3.222`
(`package.json` and `package-lock.json`). Its shipped `sdk.d.ts` declares:

- `createSdkMcpServer({ name, version?, instructions?, tools?, alwaysLoad? })`
  returning a live `{ type: "sdk", name, instance }` server config;
- `tool(name, description, zodShape, handler, extras?)` for in-process tool
  definitions;
- `Options.mcpServers`, `tools`, `allowedTools`, `disallowedTools`,
  `canUseTool`, `hooks`, `settingSources`, `strictMcpConfig`,
  `managedSettings`, and `agents`;
- `PreToolUse` with `permissionDecision: "allow" | "deny" | "ask" | "defer"`;
  and
- `CanUseTool(toolName, input, { signal, toolUseID, requestId, ... })`, returning
  a `PermissionResult` or `null` only after an out-of-band control response.

The installed package was inspected from the cached `0.3.222` tarball because
this worktree does not have `node_modules` populated. The declaration and
runtime package version are a compile/runtime pin, not a guessed SDK contract.

| Option                                                                                        | Result     | Why                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A. `createSdkMcpServer` + `tool` adapters**                                                 | **Chosen** | Official, in-process API. It carries structured schemas and results without network credentials, serialisation, a subprocess, or duplicated lifecycle. It composes with the existing ToolManager and dispatchers.                          |
| B. SDK callback to a gateway HTTP endpoint                                                    | Rejected   | Adds a bearer/capability protocol, request replay and cancellation semantics, extra endpoint authorization, result serialisation, and an unnecessary network failure domain. `createSdkMcpServer` already provides the transport boundary. |
| C. Make SDK load Bobbit `.mcp.json`/external config                                           | Rejected   | Bypasses scoped `McpManager`, activation, route selection, policy, diagnostics, and secret redaction. It also allows a second MCP owner.                                                                                                   |
| D. Patch Claude runtime, monkey-patch private SDK objects, or invent a private extension hook | Rejected   | Unsupported version-coupled behavior. It cannot be compile-pinned and would duplicate the established extension platform.                                                                                                                  |
| E. Keep overlapping Claude native tools beside Bobbit tools                                   | Rejected   | Produces duplicate owners, bypasses Bobbit output/rendering and grants, and gives the model ambiguous choices. Native overlap is suppressed rather than aliased.                                                                           |

## Scope and non-goals

This design applies only when `SessionRuntime === "claude-agent-sdk"`. Pi
activation, generated Pi proxy extensions, and the existing tool guard stay
unchanged. The source of truth remains Bobbit tool YAML and the current role /
group / MCP policy cascade.

It does not make Claude Code configuration, native tasks, worktrees, cron,
notifications, background agents, user-specific auto-memory, plugins, or
unmanaged MCP servers available. It does not make a new user-facing grant UI;
G4 wires the existing `SessionManager.requestToolGrant` events to the SDK
permission callback.

## Canonical names and one normalizer

The adapter has two identities for every exposed tool:

| Identity              | Form                                           | Use                                                                                                                    |
| --------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Bobbit canonical name | `read`, `team_spawn`, `mcp_describe`           | ToolManager lookup, policy/grant matching, dispatcher invocation, persisted session allowlist, and UI renderer lookup. |
| SDK raw name          | `mcp__bobbit__read`, `mcp__bobbit__team_spawn` | SDK `allowedTools`, `canUseTool`, `PreToolUse`, and raw diagnostics.                                                   |

`src/server/agent/claude-agent-sdk-tool-surface.ts` will be the sole conversion
owner. It exports a pure, case-normalizing `normalizeClaudeSdkMcpToolName(raw)`
which:

1. folds only for lookup and accepts exactly `mcp__bobbit__<registered-name>`;
2. rejects empty, malformed, foreign-server, unknown, duplicate, or ambiguous
   suffixes; and
3. returns `{ rawName, canonicalName, definition }` where `canonicalName` is the
   original ToolManager spelling.

Registration names are lower-case ASCII MCP-safe Bobbit names
`[a-z][a-z0-9_]*`, must be unique after case-folding, and are constructed only
from the filtered ToolManager snapshot. A catalogue name which cannot satisfy
that reversible mapping is not silently rewritten: session setup fails with a
sanitized collision/invalid-name diagnostic. No call site may split
`mcp__bobbit__` itself or compare raw names to `SessionInfo.allowedTools`.

The translator/render path calls the same normalizer before emitting
`tool_execution_start` / tool-result identities. It retains the raw SDK name in
bounded diagnostic metadata, but supplies the canonical Bobbit name to existing
renderers and policy checks. Foreign native/MCP names remain raw and are marked
unowned; they are never made equivalent to a Bobbit tool.

### Collision rules

Build a case-folded map of all potential SDK raw identities before constructing
the server. Fail the startup (rather than choose a winner) for:

- two ToolManager entries that normalize to the same registered name;
- a registered name that would be the SDK native identity or reserved
  `mcp__bobbit__` prefix form;
- a Bobbit `mcp__...` external route whose resulting raw SDK identity collides
  with another Bobbit adapter definition; or
- any attempted policy/permission request that has no exact mapping.

Diagnostics include the session id, scoped ToolManager source paths/pack ids,
raw name, canonical candidates, and policy decision, but never schemas,
arguments, secrets, or tool results. They are emitted once per surface build
and exposed through the existing bounded bridge diagnostic channel. Collision
is an initialization error, not a warning and not a last-writer-wins rule.

## Declarative native suppression/replacement policy

`claude-agent-sdk-tool-surface.ts` owns one immutable
`CLAUDE_NATIVE_TOOL_POLICY` table. It is the single input for native
`tools`, `disallowedTools`, `agents`, tool aliases (none), canonical-name
normalization, collision reservation, diagnostics, and inventory tests. Do not
scatter SDK names through bridge setup or permission callbacks.

The measured native floor for SDK/binary pin `0.3.222` is exactly:

```
Task, Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, Skill,
NotebookEdit, AskUserQuestion, EnterPlanMode, ExitPlanMode, EnterWorktree,
ExitWorktree, Monitor, ScheduleWakeup, PushNotification, RemoteTrigger,
CronCreate, CronDelete, CronList, TaskCreate, TaskGet, TaskList, TaskOutput,
TaskStop, TaskUpdate, ToolSearch
```

The required table is:

| Native tool(s)                                                                                           | Policy                         | Bobbit canonical replacement / rationale                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Bash`                                                                                                   | suppress                       | `bash`; Bobbit owns command execution, output bounds, rendering, and sandbox behavior.                                                                                                                                                                                                                                                                    |
| `Read`                                                                                                   | suppress                       | `read`.                                                                                                                                                                                                                                                                                                                                                   |
| `Write`                                                                                                  | suppress                       | `write`.                                                                                                                                                                                                                                                                                                                                                  |
| `Edit`                                                                                                   | suppress                       | `edit`.                                                                                                                                                                                                                                                                                                                                                   |
| `Glob`                                                                                                   | suppress                       | `find`.                                                                                                                                                                                                                                                                                                                                                   |
| `Grep`                                                                                                   | suppress                       | `grep`.                                                                                                                                                                                                                                                                                                                                                   |
| `NotebookEdit`                                                                                           | suppress                       | No separate owner: Bobbit's tracked file editing surface is the supported editing path.                                                                                                                                                                                                                                                                   |
| `WebFetch`                                                                                               | suppress                       | `web_fetch`.                                                                                                                                                                                                                                                                                                                                              |
| `WebSearch`                                                                                              | suppress                       | `web_search`.                                                                                                                                                                                                                                                                                                                                             |
| `AskUserQuestion`                                                                                        | suppress                       | `ask_user_choices`; preserves Bobbit UI/question ownership.                                                                                                                                                                                                                                                                                               |
| `EnterPlanMode`, `ExitPlanMode`                                                                          | suppress                       | No Claude plan-mode state. Bobbit goals/gates and normal prompts remain authoritative.                                                                                                                                                                                                                                                                    |
| `Task`                                                                                                    | private `Agent` alias target    | Pinned SDK `toolAliases` resolves public `Agent` to `Task`; it is never model-visible or auto-allowed. |
| `TaskCreate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskUpdate`                              | suppress                       | Bobbit owns durable task/team lifecycle; no Claude task/subagent store may be created. |
| `EnterWorktree`, `ExitWorktree`                                                                          | suppress                       | Bobbit worktree/session manager owns worktrees.                                                                                                                                                                                                                                                                                                           |
| `Monitor`, `ScheduleWakeup`, `PushNotification`, `RemoteTrigger`, `CronCreate`, `CronDelete`, `CronList` | suppress                       | No Bobbit analogue is exposed in this runtime; unavailable is safer than a second scheduler/notification owner.                                                                                                                                                                                                                                           |
| `Skill`                                                                                                  | retain (D3)                    | Listed in `Options.tools` with the reviewed literal bundled-skill inventory. No Bobbit alias is invented.                                                                                                                                                                                                                                                 |
| `Agent`                                                                                                  | retain (D4), admission-only    | Permits only exact foreground root admission for one of three immutable Bobbit role projections. One live child maximum means it is not a general native subagent surface.                                                                                                                                                                                 |
| `ToolSearch`                                                                                             | suppress for the `0.3.222` pin | The Bobbit server and every adapter tool set `alwaysLoad: true`; all SDK MCP definitions are already role-filtered, so deferred tool search is not required. If a future SDK pin demonstrably requires it, the policy table—not an ad-hoc option—may change to retain it only for this filtered server, with a new real-SDK snapshot and security review. |

`Agent` is not in the measured floor but is explicitly retained by D4, rather
than reserved and disallowed. `tools` is exactly `["Skill", "Agent"]`, and
pinned SDK `toolAliases: { Agent: "Task" }` resolves that public name before
native name resolution. `allowedTools` contains `Agent` plus eligible Bobbit
MCP raw names—never `Task`. `agents` contains only the immutable policy
definitions for `bobbit-protocol-scout`, `bobbit-backend-parity-reviewer`, and
`bobbit-billing-safety-auditor`; it never discovers filesystem, built-in, or
user-defined agents. `Task` is omitted from `disallowedTools` only so the alias
target resolves; all `Task*` operations remain suppressed, and both public
callback and UI/history projection deny or normalize raw Task away from the
model surface. See the [D3/D4 design](claude-agent-sdk-skills-subagents.md) for
the literal definitions and admission grammar.

A suppressed tool must not be replaced by an SDK alias. A replacement means the
model receives the distinct Bobbit MCP raw name and one Bobbit owner, not two
names for the same owner.

## Surface construction and data flow

### Inputs

At session setup, after `resolveTools` and after goal-disabled filtering, build
one immutable `ClaudeSdkToolSurface` from:

- the scoped `ToolManager.getAvailableTools(scopedToolContext(...))` snapshot;
- `McpManager.getToolInfos()` only through the existing Bobbit meta-tool /
  `mcp_describe` dispatcher surface, never as SDK-managed MCP connections;
- `computeEffectiveAllowedTools` plus the explicit session constraint;
- `computeToolPolicies` / `resolveGrantPolicy`; and
- `SessionInfo` identity, role, project, cwd, and existing grant callbacks.

The surface records `mode: "unrestricted" | "restricted"` separately from its
ordered canonical names. `undefined` remains unrestricted and `[]` remains an
explicit empty restriction. This fixes the current unsafe `length > 0` shortcut
for this runtime: an empty restricted allowlist registers no Bobbit MCP tools
and admits no calls.

For each candidate, apply the exact session allowlist first, then goal-disabled
filter, then resolved policy. `never` is absent. `allow` and `ask` are
registered, so an ask tool can request a user decision. The generated adapters
carry the selected ToolManager schema, description, and handler; they do not
read tool YAML independently after the snapshot has been selected.

### Invocation path

```
role/group/session grants + ToolManager/McpManager snapshot
  -> buildClaudeSdkToolSurface (canonical map, policies, collision check)
  -> createSdkMcpServer("bobbit", tool(...))
  -> SDK emits mcp__bobbit__<name>
  -> normalizeClaudeSdkMcpToolName (raw -> canonical)
  -> canUseTool + PreToolUse ceiling
  -> existing builtin / ActionDispatcher / MCP-meta handler
  -> existing renderer receives canonical Bobbit tool identity
```

Adapter handlers receive the normalized canonical entry and the original SDK
call context only. They call the current local handler/extension dispatcher in
process; they do not loop back through `fetch`, invoke a private host hook, or
reconnect an MCP client. Arguments are schema-validated at the existing handler
boundary and errors return a normal MCP error result with a sanitized message.
`AbortSignal` is threaded to cancellable handlers where the existing handler
supports it; an aborted call never becomes a successful grant or cached result.

## Permission ceiling: three independent layers

The SDK can bypass `canUseTool` for a pre-allowed tool or permission-mode path.
Therefore no one layer is sufficient. The single surface policy is applied in
all three places below; a mismatch fails closed and logs the raw and canonical
identity.

1. **Registration and `allowedTools` (visibility / convenience).** Only
   non-`never`, allowlist-eligible Bobbit tools are registered. `Options.allowedTools`
   contains exactly the SDK raw names for policy `allow`, plus `Agent`; `Skill`
   is enabled by the literal bundled `skills` inventory rather than this list.
   It never contains a `never`, malformed, foreign, or `ask` raw tool name.
   `tools: ["Skill", "Agent"]`, the full `disallowedTools` inventory, the
   bundled-skill list, and immutable policy-built `agents` definitions provide
   the native ceiling.
2. **`canUseTool` (interactive permission).** The callback normalizes the SDK
   name and rechecks the surface snapshot. Unknown/foreign/suppressed/native
   names return `{ behavior: "deny", message }`. `allow` returns allow.
   `ask` calls the existing `SessionManager.requestToolGrant(sessionId,
canonicalName, group)` seam. It listens to `options.signal`: abort settles
   the pending SDK request as deny/cancel and does not leave an orphaned UI
   request. A returned grant must list the normalized current canonical tool
   (and, for group scope, the same resolved group); otherwise deny. `one-time`
   authorizes only this callback result and is never inserted into the surface,
   `allowedTools`, or a callback cache. `session-only`/persistent grants use the
   existing SessionManager recompute/restart path. Any policy marked
   `requiresUserInteraction` must take this callback path; it can never be
   auto-allowed by an SDK permission mode.
3. **`PreToolUse` (non-bypassable defence in depth).** A hook with no broad
   matcher receives every candidate execution, normalizes again, checks the
   same allowlist and current policy/grant state, and returns
   `permissionDecision: "deny"` with a bounded reason unless the call is still
   eligible. Root `Agent` calls must satisfy the exact foreground admission for
   one immutable projection; a child may use only its registered `read`/`find`/
   `grep` MCP subset. It denies `Task`/`Task*`, malformed or built-in Agent
   input, nested or child-origin `Agent` calls, and every other native or
   subagent-originated call outside that subset. It permits an already-authorized
   `allow`, callback-approved current `ask`, or admitted Agent call only. This
   hook is required even when `allowedTools` or the SDK permission resolver says
   allow.

Use `permissionMode: "default"`; never set `bypassPermissions` or
`allowDangerouslySkipPermissions`. SDK permission updates/suggestions are not
persisted to Claude settings: the SessionManager grant result is the only
Bobbit authority.

G4 owns UI dispatch of the existing `tool_permission_needed` /
`tool_permission_settled` events. This slice supplies the cancellable callback
adapter and the exact normalized coverage check; it does not create parallel
permission cards or an HTTP long-poll.

## Strict configuration and state isolation

The SDK query options are built by one pure
`buildClaudeAgentSdkQueryOptions(surface, bridgeOptions)` helper. Its required
security posture is:

```ts
{
  tools: ["Skill", "Agent"],
  skills: [...CLAUDE_BUNDLED_SKILLS_0_3_222],
  disallowedTools: CLAUDE_NATIVE_TOOL_POLICY.disallowed,
  allowedTools: ["Agent", ...surface.sdkAllowNames],
  agents: surface.subagentPolicy.definitions,
  mcpServers: { bobbit: surface.server },
  settingSources: [],
  strictMcpConfig: true,
  managedSettings: { autoMemoryEnabled: false },
  permissionMode: "default",
  canUseTool: surface.canUseTool,
  hooks: {
    PreToolUse: [surface.preToolUseMatcher],
    SubagentStart: [surface.subagentStartMatcher],
    SubagentStop: [surface.subagentStopMatcher],
    PreCompact: existingHook,
  },
  env: buildClaudeAgentSdkEnv({ CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" }),
}
```

The actual `mcpServers` container must use the type/shape required by the
installed declaration (`Record<string, McpServerConfig>` with the live SDK
server config); it must contain only `bobbit`. `settingSources: []` is
mandatory, not optional: the SDK must not load user/project/local Claude
settings, `.mcp.json`, plugin config, `CLAUDE.md`, filesystem skills, agents,
or commands. The only enabled skills and agents are the literal bundled-skill
inventory and policy-built definitions passed directly in query options.
`strictMcpConfig: true` additionally rejects any unmanaged MCP discovery.

`managedSettings.autoMemoryEnabled = false` suppresses SDK auto-memory reads,
writes, and consolidation. The SDK process gets a fresh isolated
`CLAUDE_CONFIG_DIR` under Bobbit session state, never the user's config path.
It is created with restrictive permissions, contains no copied settings or
credentials, and is removed by the existing session cleanup path. The current
closed `buildClaudeAgentSdkEnv` allowlist remains the only environment source:
no `process.env` spread, generic credentials, `BOBBIT_TOKEN`, or project env is
introduced. The isolated config directory and auto-memory setting are tested
as a pair; one without the other is insufficient.

Unmanaged MCP config, setting source, native tool, undisclosed bundled skill,
agent definition, slash-command, plugin, and auto-memory drift are startup
failures in the exact real-SDK snapshot test. Do not downgrade these to
warnings or permit a broad fallback.

## Files, APIs, and branches

| File                                                                    | Change / ownership                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/agent/claude-agent-sdk-tool-surface.ts` (new)               | Pure policy table, name normalizer, collision reporting, `ClaudeSdkToolSurface`, SDK tool-definition factory, query-options helper, permission adapters, and test-only handler/declaration seams. The one new surface owner.                                |
| `src/server/agent/claude-agent-sdk-bridge.ts`                           | Accept a constructed surface/options factory; use it during `startInternal`; preserve input queue, event translator, lifecycle, environment, and PreCompact behavior. Close the surface/server on bridge stop/failure.                                      |
| `src/server/agent/session-setup.ts`                                     | After existing effective allowlist/policy resolution, construct the SDK surface only for the SDK runtime and attach it to `SessionBridgeOptions`; do not generate Pi proxy/guard extensions for that runtime. Preserve Pi code byte-for-byte in its branch. |
| `src/server/agent/session-runtime.ts`                                   | Thread the typed SDK surface/factory into `ClaudeAgentSdkBridge`; retain explicit runtime selection and test deps seam.                                                                                                                                     |
| `src/server/agent/rpc-bridge.ts`                                        | Only widen shared option types if necessary; no SDK imports or Claude-specific branches.                                                                                                                                                                    |
| `src/server/agent/session-manager.ts`                                   | Expose a narrow existing-grant adapter to the surface builder and make runtime-side allowed-tool checks use canonical normalization rather than raw SDK names. Preserve current `requestToolGrant`, cancellation, restart, and persistence ownership.       |
| `src/server/agent/tool-activation.ts`                                   | Export/reuse a small policy snapshot helper only if the surface cannot consume `computeEffectiveAllowedTools`/`computeToolPolicies` directly. Do not make SDK names part of the global Pi activation cache.                                                 |
| `src/server/agent/claude-sdk-event-translator.ts`                       | Add an optional canonical-name callback at the SDK runtime boundary, or normalize immediately before SessionManager/rendering; preserve raw name diagnostic data and existing standalone translator contracts.                                              |
| `tests2/core/claude-agent-sdk-tool-surface.test.ts` (new)               | Pure table, derivation, naming, collision, isolation options, and permission-ceiling tests.                                                                                                                                                                 |
| `tests2/integration/claude-agent-sdk-tool-permissions.test.ts` (new)    | SessionManager grant lifecycle, cancellation, one-time behavior, handler dispatch, and normalized rendering/policy integration.                                                                                                                             |
| `tests2/integration/claude-agent-sdk-real-init-inventory.test.ts` (new) | Exact `0.3.222` real SDK initialization snapshot described below.                                                                                                                                                                                           |
| `tests2/tests-map.json`                                                 | Register each new v2 suite in its correct tier.                                                                                                                                                                                                             |

No server REST route, websocket message, callback HTTP protocol, extension-host
contribution type, persisted secret, separate MCP client, or new settings file
is added.

New state is intentionally bounded:

```ts
interface ClaudeSdkToolSurface {
  readonly runtime: "claude-agent-sdk";
  readonly restriction: "unrestricted" | "restricted";
  readonly entriesBySdkRawLower: ReadonlyMap<string, ClaudeSdkToolEntry>;
  readonly entriesByCanonicalLower: ReadonlyMap<string, ClaudeSdkToolEntry>;
  readonly sdkAllowNames: readonly string[];
  readonly sdkDisallowNames: readonly string[];
  readonly server: McpSdkServerConfigWithInstance;
  readonly policyFingerprint: string;
}
```

It is immutable per bridge generation, session-local, never persisted, and is
discarded on stop/replacement. Live session grants intentionally trigger the
existing controlled restart/rebuild rather than mutating an MCP server in
place. Durable `SessionInfo.allowedTools` remains canonical Bobbit strings;
raw SDK names are ephemeral only.

New branches are limited to: runtime is SDK vs Pi; unrestricted vs explicitly
restricted allowlist; policy allow/ask/never; valid vs invalid normalized raw
identity; grant/deny/cancel; exact root Agent admission versus denial; registered
child lifecycle/subset versus denial; and collision/init failure. A bridge has
one foreground child maximum and the closed SDK environment fixes subagent spawn
depth at one. There is no fallback branch that loads SDK defaults or unmanaged
configuration.

## Failure behavior

| Failure                                                            | Required result                                                                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Invalid/colliding ToolManager name or raw SDK identity             | Fail SDK session start before query readiness; sanitized collision diagnostic; no winner selected.                                |
| SDK server construction/schema conversion error                    | Fail start and close partial bridge/server; do not omit the bad tool and widen the rest silently.                                 |
| Suppressed native, foreign, malformed, or unknown tool invocation  | `canUseTool` and `PreToolUse` deny; no dispatcher invocation.                                                                     |
| `Task`/`Task*`, built-in/unknown Agent, malformed or background Agent input, nested/child Agent, or a second live child | Deny before dispatch; create no task, child, or lifecycle entry.                                                                  |
| Child native call or MCP call outside `read`/`find`/`grep`          | Deny through the child registry and `PreToolUse`; never widen the root or child surface.                                           |
| `never` / explicitly empty role surface                            | Tool absent and denied defensively if invoked.                                                                                    |
| Grant denied, stale, wrong group/tool, expired, or aborted         | Deny only that call; leave one-time grant uncached; cancel/settle existing request.                                               |
| Existing handler throws/times out                                  | Return sanitized MCP error result; preserve Bobbit error/render semantics and session liveness.                                   |
| SDK may attempt unmanaged MCP/settings/filesystem-agent/plugin/memory surface | Exact inventory assertion fails initialization/tests; production init fails closed rather than enabling it.                       |
| Bridge replacement/stop                                            | Abort pending callback work, clear active-child state, close the in-process SDK server, discard surface; new bridge rebuilds from current canonical policy. |

## Verification plan and exact inventory regression

### Pure/core seams

Inject a fake `tool`, `createSdkMcpServer`, and handler dispatcher into the
surface factory. Pin:

1. all 30 measured native names exactly once, their policy/replacement column,
   retained `Skill`/admission-only `Agent`, continued `Task`/`Task*` denial, and
   `ToolSearch` suppression;
2. `tools === ["Skill", "Agent"]`, the literal bundled-skill inventory,
   `allowedTools` containing `Agent`, no aliases, the complete disallow list,
   and exactly the three immutable `bobbit-*` policy definitions with their
   model, effort, foreground/default-permission, max-turn, and `read`/`find`/
   `grep` child-tool bounds; only `bobbit` MCP config, `alwaysLoad` on
   server/tools, and no native preset;
3. raw/canonical round trips, case normalization, renderer canonicalization,
   malformed/foreign rejection, and no raw name comparison against Bobbit
   `allowedTools`;
4. deterministic duplicate/case/prefix/external-MCP collision diagnostics and
   startup failure; and
5. unrestricted, restricted non-empty, and explicit-empty allowlist behavior;
   policy `allow`/`ask`/`never`; goal-disabled filtering; scoped pack overrides;
   only selected schemas/handlers being registered; exact Agent admission;
   one-live-child/depth-one lifecycle; and rejection of built-in, malformed,
   background, nested, child-origin, and Task ownership paths.

### Permission integration seams

Use the current `SessionManager.requestToolGrant` fake/real seam and abort
signal. Pin that `allowedTools`, `canUseTool`, and `PreToolUse` all reject a
`never`, foreign, suppressed-native, or explicitly-empty call; `allow` works;
`ask` opens exactly the existing request; a returned grant covers the normalized
current name and group; denial/timeout/abort settles; and one-time approval does
not authorize a second invocation. Test an SDK-preallowed / default-mode path to
prove `PreToolUse` remains the final ceiling. Exercise valid foreground root
admission for each projection and reject `Task`/`Task*`, built-in or malformed
Agent input, background and nested/child Agent calls, duplicate live children,
and child bash or other MCP calls outside `read`/`find`/`grep`. No test may use
bypass permissions.

### Real SDK initialization snapshot (G5/G12)

Add a process-isolated, real `@anthropic-ai/claude-agent-sdk@0.3.222`
initialization test. It may use a deterministic local/fake model transport only
where the SDK supports it; it must construct the production options and inspect
the SDK initialization/status surface rather than a hand-made options object.
The committed snapshot is sorted and asserts **exactly**:

```ts
{
  sdkPackageVersion: "0.3.222",
  claudeCodeVersion: "2.1.222",
  tools: [/* exact raw native + mcp__bobbit__ names */],
  skills: [/* D3-approved only */],
  agents: [/* exact built-in diagnostics and three bobbit-* projections */],
  slash_commands: [/* exact bundled diagnostic inventory */],
  mcp_servers: ["bobbit"],
  plugins: [],
  settingSources: [],
  strictMcpConfig: true,
  autoMemoryEnabled: false,
}
```

The expected options inventory contains retained `Skill`, admission-only
`Agent`, and the exact selected `mcp__bobbit__<canonical>` entries. It contains
none of every other suppressed native name, no `ToolSearch`, no external
SDK-owned MCP tool, and no unmanaged configuration-derived tool. The expected
agent inventory contains only the reviewed diagnostic built-ins plus the three
policy projections; the expected skills inventory is the literal D3 bundled
list. A legacy `Task` initialization label is diagnostic only: `Task` and every
`Task*` operation remain absent from `allowedTools`, present in
`disallowedTools`, and denied at execution. Snapshot setup seeds hostile user,
project, local, `.mcp.json`, plugin, memory, filesystem-agent, slash-command,
and `CLAUDE_CONFIG_DIR` inputs, proving every unowned source is absent. It also
asserts the closed environment excludes gateway/project credentials and that no
auto-memory path is read or written.

The snapshot deliberately fails on SDK or bundled Claude binary drift. Updating
it requires reviewing the changed native inventory against the declarative table
and explicitly deciding the `ToolSearch` policy; it is never regenerated as a
blind approval. The test’s expected arrays are literal, sorted inventories—not
computed from the implementation under test.

Run focused suites with:

```bash
npx vitest run --config vitest.config.ts --silent=passed-only \
  tests2/core/claude-agent-sdk-tool-surface.test.ts \
  tests2/integration/claude-agent-sdk-tool-permissions.test.ts \
  tests2/integration/claude-agent-sdk-real-init-inventory.test.ts
npm run check
```

The existing bridge and translator tests remain required. Pi regression tests
must prove Pi still receives generated proxy/guard extensions and does not
import, construct, or normalize the SDK tool surface.
