# Claude Agent SDK skills and subagents (D3/D4)

## Decision

Use **A: programmatic, allowlisted SDK `agents` definitions**. Retain the
bundled Claude skills through the SDK `Skill` surface, enable the native `Agent`
tool only for three Bobbit-owned role projections, and continue to deny the
legacy native `Task` ownership path. Bobbit's existing team/task orchestration
remains the normal durable-work mechanism; SDK subagents are short-lived,
query-local reviewers/evidence helpers only.

This is the smallest option consistent with D4. It adds no session, task,
worktree, goal, transcript store, queue, cost ledger, REST route, WebSocket
message, or user-facing role configuration.

### Alternatives considered

| Option | Result | Reason |
| --- | --- | --- |
| **A. Strict custom Bobbit roles through `Options.agents`** | **Chosen** | The official SDK API provides named definitions, tool subsets, model/effort, permissions, and `maxTurns`. It permits the approved D4 helper cases without creating a second Bobbit orchestration system. |
| B. Disable all SDK subagents and use Bobbit team orchestration exclusively | Rejected | Safest baseline, but it does not satisfy approved D4's bounded native-helper path. It remains the fallback if the pinned SDK cannot enforce the admission and lifecycle assertions below. |
| Filesystem `.claude/agents` definitions | Rejected | They are configuration-discovered and may be changed outside Bobbit's role/policy cascade. `settingSources: []` is not an execution authorization boundary for bundled agents. |
| Built-in `general-purpose`/`Explore`/`Plan` or arbitrary user roles | Rejected | Their prompt, tools, model, turn, and nesting policy are not owned by this design. Reported availability is not permission to run them. |

The authoritative external contract is the installed
`@anthropic-ai/claude-agent-sdk@0.3.222` declaration (`sdk.d.ts`) and the
[SDK subagents guide](https://platform.claude.com/docs/en/agent-sdk/subagents):
`agents` is `Record<string, AgentDefinition>`; definitions support `tools`,
`disallowedTools`, `prompt`, `model`, `skills`, `maxTurns`, `background`,
optional `effort`, and `permissionMode`; native delegation is performed through `Agent`.
The guide also records the version compatibility hazard: current Claude Code
emits `Agent` in tool-use blocks but can report `Task` in initialization and
permission-denial inventories. Consequently inventory labels never bypass the
explicit `Task` execution denial.

## D3: bundled skills, Bobbit commands

D3 does **not** load Bobbit `SKILL.md` files into SDK configuration. Bobbit
continues to discover, collision-resolve, expand, sidecar-persist, and render
those skills before the SDK receives prompt text. D2 remains the only composer
owner: exact Bobbit skills and controls win, `/compact` is consumed locally for
SDK sessions, and unowned text is ordinary runtime input. This slice does not
change slash interception, tool names, session runtime selection, resume, or
cost handling.

The SDK process already uses `settingSources: []`, `strictMcpConfig: true`, an
isolated `CLAUDE_CONFIG_DIR`, no plugins, and the one live `bobbit` MCP server.
Those controls prevent hostile user/project/local/plugin skill and command
configuration, but intentionally do **not** remove skills shipped with the
pinned Claude binary. Preserve those bundled skills explicitly:

```ts
const CLAUDE_BUNDLED_SKILLS_0_3_222 = [
  "batch", "claude-api", "code-review", "dataviz", "debug", "deep-research",
  "design-sync", "doctor", "fewer-permission-prompts", "loop", "run",
  "run-skill-generator", "simplify", "update-config", "verify",
] as const;

// Root query options, in addition to D1's isolated MCP surface:
tools: ["Skill", "Agent"],
skills: [...CLAUDE_BUNDLED_SKILLS_0_3_222],
```

`skills` is an SDK context filter, not a filesystem sandbox. The literal list
is therefore both an enablement decision and a version pin: a new bundled skill
is unavailable until its contents/commands are reviewed and the literal
inventory is intentionally updated. `Skill` remains native because no Bobbit
tool aliases it. Do not put `Skill` in `allowedTools`; the pinned declaration
requires `skills` to enable it. Do not use `toolAliases` to turn a native skill
instruction into Bobbit `read`, `bash`, or another tool.

Bundled slash commands can still appear in the SDK's diagnostic initialization
inventory. They are not Bobbit commands and are never added to autocomplete,
launchers, skill resolution, or durable command state. D2's exact composer
registry controls every Bobbit-owned command before the bridge sees input. This
is command ownership, not an unsupported attempt to rewrite the Claude binary's
built-in command catalogue.

## D4: constrained SDK agent projection

### Root native policy

Replace D1's `agents: {}` / reserved-`Agent` posture only for this SDK runtime:

```ts
const rootNativeTools = ["Skill", "Agent"] as const;
const nativeDisallowed = [
  // D1 suppressed inventory, except Skill and private Task alias target:
  "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch",
  "WebSearch", "NotebookEdit", "AskUserQuestion", "EnterPlanMode",
  "ExitPlanMode", "EnterWorktree", "ExitWorktree", "Monitor",
  "ScheduleWakeup", "PushNotification", "RemoteTrigger", "CronCreate",
  "CronDelete", "CronList", "TaskCreate", "TaskGet", "TaskList",
  "TaskOutput", "TaskStop", "TaskUpdate", "ToolSearch",
] as const;

{
  tools: rootNativeTools,
  disallowedTools: nativeDisallowed,
  allowedTools: ["Agent", ...rootAllowMcpRawNames],
  toolAliases: { Agent: "Task" },
  agents: approvedAgentDefinitions,
  skills: [...CLAUDE_BUNDLED_SKILLS_0_3_222],
  settingSources: [], strictMcpConfig: true,
  managedSettings: { autoMemoryEnabled: false },
  permissionMode: "default",
}
```

The pinned declaration applies `toolAliases` before native name resolution, so
public `Agent` resolves to `Task`. `Task` is omitted from `disallowedTools` only
for that private resolver target and is never in `tools` or `allowedTools`.
`canUseTool` denies raw `Task`; `PreToolUse` treats its resolved transport name
as public `Agent`, preserving the same tool-use id and strict admission grammar.
`TaskCreate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, and `TaskUpdate`
remain denied. UI/history projects the resolved root call back to `Agent`; no
native task state is read, written, persisted, or rendered.

`Agent` is allowed only as an admission point. It is not a general native tool:
root `canUseTool` and `PreToolUse` validate its input before it can execute, and
child `Agent`/`Task` calls are always denied. Set
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH="1"` only in the SDK process's existing
closed environment, so no child can create a grandchild. The root's `Agent`
call must be foreground (`run_in_background === false`); omitted, true, or any
non-boolean value is denied because the pinned SDK otherwise backgrounds
subagents by default. A per-bridge registry permits at most **one** live SDK
subagent; a second root Agent call is denied until the `SubagentStop` hook for
the first id arrives.

### The only permitted projections

These are internal static definitions, not new persisted roles. Each source
role is resolved through the existing scoped `PackResolver`/role cascade at
session setup, then checked against this table. The projection uses its resolved
`promptTemplate`, expands only the existing `{{GOAL_BRANCH}}` and `{{AGENT_ID}}`
values, and never accepts a model/prompt/tool override in the Agent request.

| SDK agent type | Source Bobbit role | Model | Max turns | Native/Bobbit tools | Permissions |
| --- | --- | --- | ---: | --- | --- |
| `bobbit-protocol-scout` | `claude-protocol-scout` | `inherit` | 6 | `Skill`; `mcp__bobbit__read`, `mcp__bobbit__find`, `mcp__bobbit__grep` | `default`; each MCP call must also pass the per-child surface and D1 grant ceiling |
| `bobbit-backend-parity-reviewer` | `backend-parity-reviewer` | `inherit` | 4 | `Skill`; `mcp__bobbit__read`, `mcp__bobbit__find`, `mcp__bobbit__grep` | `default`; same ceiling |
| `bobbit-billing-safety-auditor` | `billing-safety-auditor` | `inherit` | 4 | `Skill`; `mcp__bobbit__read`, `mcp__bobbit__find`, `mcp__bobbit__grep` | `default`; same ceiling |

Every definition additionally has:

```ts
{
  description: /* static, role-specific routing description */,
  prompt: resolvedAndExpandedRolePrompt,
  model: "inherit",
  maxTurns: /* table value */,
  background: false,
  permissionMode: "default",
  tools: ["Skill", ...exactChildMcpRawNames],
  disallowedTools: ["Agent", "Task", ...nativeDisallowed,
                    ...allRootMcpRawNamesExceptExactChildMcpRawNames],
  skills: [...CLAUDE_BUNDLED_SKILLS_0_3_222],
  memory: undefined,
  mcpServers: undefined,
  initialPrompt: undefined,
  observer: undefined,
  observerMessage: undefined,
}
```

The fixed projections deliberately omit optional `effort`: `model: "inherit"`
keeps child thinking governed by the active root tuple and its SDK-advertised
capabilities, rather than sending a possibly unsupported child effort. The
explicit `Skill` entry follows the installed declaration's backwards-compatible
`tools` contract; the same literal `skills` list is the current preferred
enablement surface. Re-evaluate this duplicate only during a pinned
SDK upgrade, with a real initialization test. The definitions never include
`bash`, edit/write, web, question, Bobbit team/task/gate/verification tools,
managed MCP aggregates, extension-host tools, or foreign MCP servers. An
allowed child MCP raw name maps back through the existing reversible
`mcp__bobbit__<canonical>` normalizer before dispatch; no raw identity is
persisted.

The source roles' broader normal Bobbit-session policy does not widen this
projection. In particular, the scout's ordinary role may ask for an evidence
write, but this query-local SDK helper is read-only. Work requiring a write,
verification result, task assignment, worktree, team member, or gate action
must be performed by a normal Bobbit session using existing orchestration.

### Admission, selection, and rejection

Add a pure `buildClaudeSdkSubagentPolicy(...)` helper near the existing SDK
tool-surface builder. It receives the role-cascade snapshot, canonical
role-policy result, selected root MCP entries, session id, and resolved model;
it returns immutable `agents`, root Agent admission, child-tool authorization,
and lifecycle registry callbacks. `session-setup.ts::resolveToolActivation()`
constructs it after the existing tool preflight and attaches it to the same
`ClaudeSdkToolSurface`; it does not create a second resolver or use the SDK
filesystem.

At each root `Agent` invocation, accept only when all conditions hold:

1. the SDK raw tool name is exactly `Agent` (case-normalized only for comparison),
   the invocation has no `agentID`, and all required input is a plain bounded
   object;
2. `subagent_type` is one of the three literal names above; no built-in name,
   alias, display label, role file name, case collision, filesystem agent, or
   unknown future type is accepted;
3. `prompt` is a non-empty UTF-8 string at most 8 KiB; `run_in_background` is
   exactly `false`; no resume/fork/team/task/worktree/permission override or
   extra unrecognized input key is present;
4. no live registry entry exists, the selected definition is present in the
   immutable surface, and its source role still resolves to the exact approved
   scoped role; and
5. the root call's permission mode is `default` and no bypass/dangerous option
   is set.

All other Agent inputs are denied with one bounded generic reason, never an
inventory dump. `Task`, a child-origin `Agent`, a child-origin `Task`, a
non-foreground call, a second live child, malformed arguments, an unapproved
built-in (`general-purpose`, `Explore`, `Plan`, `claude`,
`statusline-setup`), and an unregistered/changed role are rejection cases.
`canUseTool` performs the same root/child classification as `PreToolUse`; the
hook is final enforcement immediately before execution. Permission grants never
turn an Agent or Task rejection into an approval.

`SubagentStart` must carry a non-empty `agent_id` and one of the approved
`agent_type` strings. It atomically records `{ agentId, agentType, startedAt }`
only after checking the one-live-child cap. `SubagentStop` removes that exact
entry; an unknown, duplicate, mismatched, or late stop is diagnostic-only and
never releases another id. Child `PreToolUse` receives `agent_id` and
`agent_type`; it must match that live registry entry and the corresponding
literal raw MCP subset. `canUseTool` only exposes the child subset once the id
has been registered. An absent lifecycle registration fails closed. This closes
the current D1 behavior, which denies every `context.agentID` / `agent_id` call:
it becomes an allowlisted child surface rather than a blanket bypass.

## Lifecycle, transcript, audit, and state

An SDK child is **not** a Bobbit session or team member. It receives its SDK
agent prompt plus the Agent call prompt, and returns only through the root
query. Do not allocate an id in `SessionStore`, set `delegateOf`, create a
worktree/branch, create/assign a `TaskManager` task, publish a team event, or
open a separate cost account.

Existing `claude-sdk-event-translator.ts` already structurally partitions
forwarded child frames by `parent_tool_use_id`; `claude-agent-sdk-history-adapter.ts`
also preserves `parentToolUseId` and `parentAgentId`. Retain those annotations
on all child message/tool events. A child terminal drains only its partition;
it cannot emit a root `agent_end`, alter root queue state, or make
`SessionManager` treat the root turn as complete. The root Agent tool call and
its result remain the parent-facing lifecycle boundary.

Add only immutable per-bridge policy plus ephemeral active-child data:

```ts
interface ClaudeSdkSubagentPolicy {
  readonly definitions: Readonly<Record<string, AgentDefinition>>;
  readonly byType: ReadonlyMap<string, ClaudeSdkSubagentDefinition>;
  readonly maxConcurrent: 1;
  readonly audit: (event: ClaudeSdkSubagentAuditEvent) => void;
}
interface ClaudeSdkSubagentRegistryEntry {
  readonly agentId: string;
  readonly agentType: string;
  readonly startedAt: number;
}
```

The registry is held by `ClaudeSdkToolSurface`/bridge generation, is cleared on
root terminal reset, stop, failed initialization, replacement, and surface
disposal, and is never serialized. Audit rows use the existing bounded bridge
diagnostic/event channel and include only root session id, Agent tool-use id,
agent id/type, parent-tool-use partition, outcome, and duration. They never
contain the child prompt, response, arguments, transcript path, environment,
or credentials. Existing root transcript/history and usage accounting remain
the only source of truth; partition annotations let renderers and audits show
attribution without double-counting child usage as a second session.

## Exact file/function plan

| File | Required D3/D4 change |
| --- | --- |
| `src/server/agent/claude-agent-sdk-tool-surface.ts` | Extend the declarative native policy for retained `Agent`/denied `Task`; add the literal bundled-skill inventory, `ClaudeSdkSubagentPolicy`, role projection factory, Agent input parser, registry-aware root/child checks, and `SubagentStart`/`SubagentStop` hook matchers. Keep canonical MCP normalization and the three existing D1 tool ceilings as the sole Bobbit-tool authority. |
| `src/server/agent/session-setup.ts::resolveToolActivation` | After the existing role/policy/tool preflight, resolve only the three allowed roles through the existing cascade and build the immutable subagent policy. Attach it to `claudeSdkToolSurface`. Do not change Pi's extension/guard branch or construct a second role/tool resolver. |
| `src/server/agent/claude-agent-sdk-bridge.ts::startInternal` | Compose existing `PreCompact`, D1 `PreToolUse`, and the two subagent hooks in the one query options builder; set only the closed-environment depth variable. On terminal cleanup/dispose clear the policy registry. Preserve input queue, translation, runtime selection, resume, and cost behavior. |
| `src/server/agent/claude-sdk-event-translator.ts` | No semantic rewrite. Retain `parent_tool_use_id` partitioning; add only a narrowly typed test/audit annotation if necessary to join a registered child id/type without changing ordering, terminal, or usage translation. |
| `tests2/core/claude-agent-sdk-tool-surface.test.ts` | Extend literal native/skill/agent option and rejection coverage. |
| `tests2/integration/claude-agent-sdk-tool-permissions.test.ts` | Add registry/lifecycle and child execution defense-in-depth coverage. |
| `tests/e2e/claude-agent-sdk-real-init-inventory.spec.ts` | Update the literal pinned SDK/binary initialization inventory and execute the real runtime admission journey below. |
| `tests2/tests-map.json` | Register any new core/integration/runtime test only; no new test framework or gate. |

No slash/composer file, tool dispatcher/worker, runtime selector, session store,
resume/fork path, transcript store, cost code, role schema, REST route, or UI
file changes for D3/D4. G5's existing real inventory harness is reused rather
than replaced: its hostile config fixture and isolated SDK process are already
the correct surface. D2 remains the command owner.

## Failure behavior

| Failure | Required outcome |
| --- | --- |
| Missing/invalid/colliding approved role or malformed prompt expansion | Fail SDK bridge setup before readiness; dispose the preflight worker/surface; do not omit or substitute a definition. |
| SDK initialization inventory differs from the literal pin | Fail the real inventory test and block upgrade/release review; never regenerate the snapshot automatically. |
| Built-in/unknown/filesystem agent or native Task attempt | Deny in `canUseTool` and `PreToolUse`; no handler, child, task record, or registry entry. |
| Child id/type absent, mismatch, late, duplicate, nested, or over concurrency cap | Deny the tool call or terminate only the untrusted child path; preserve the root query/session. |
| Child asks for unselected MCP/native tool or a grant is stale/aborted | Deny the call; never widen the child definition or root allowlist. |
| Hook, dispatch, or registry error | Fail closed with a bounded diagnostic; no default SDK agent/tool fallback. |
| Root stop/replacement/init failure | Abort pending child permission work, clear registry and one-time approvals, dispose surface, and remove isolated config directory. New bridge builds a fresh policy from the current role/tool snapshot. |

## Acceptance and regression tests

1. **Literal D3/D4 options (core).** Assert exactly: `tools` is
   `["Skill", "Agent"]`; `skills` equals the 15-name literal list;
   `agents` has exactly the three `bobbit-*` definitions; each definition has
   exact `inherit` model, omitted effort, max turns, foreground/default permissions,
   literal skills, MCP subset, no memory/MCP-server/observer/initial prompt,
   no Agent/Task, and no omitted-tool inheritance. Assert `Task` plus all D1
   suppressions stay disallowed for children, root `Agent` is the sole public
   native allow, and root `toolAliases.Agent === "Task"` is the only alias.
   Pi still builds no SDK surface.
2. **Admission and tool ceiling (core + integration).** Exercise valid each-role
   foreground Agent input through resolved Task hook transport; unknown/built-in/
   case-collision names; raw Task callback; child Agent/Task; missing/extra
   input; background/omitted background; prompt over 8 KiB; duplicate live child;
   lifecycle id/type mismatch; child native and foreign/MCP tool calls;
   denied/aborted grants; and a malicious pre-allowed path. `canUseTool` must
   reject every unavailable public path, while `PreToolUse` admits only the
   exact foreground Agent grammar under either public or resolved alias name.
3. **Partition and audit (core).** Feed interleaved root/two-child frames plus
   `SubagentStart`/`SubagentStop`; assert parent partitions, local child drain,
   one root terminal, bounded audit fields, no raw prompt/path/credential, and
   registry disposal. Existing translator fixture semantics must remain intact.
4. **Exact real initialization inventory (G5 reuse).** In
   `tests/e2e/claude-agent-sdk-real-init-inventory.spec.ts`, keep a handwritten,
   sorted expected object for SDK `0.3.222` / Claude `2.1.222`: the 15 bundled
   skills above; the five observed built-ins
   `["Explore", "Plan", "claude", "general-purpose", "statusline-setup"]`;
   the three `bobbit-*` projections; the existing literal bundled
   `slash_commands` array; only MCP server `bobbit`; no plugins; empty setting
   sources; strict MCP; and disabled auto-memory. The tool assertion separately
   records the observed compatibility `Task` initialization label, `Skill`,
   `Agent` when reported by the pin, and exactly selected
   `mcp__bobbit__<name>` tools, while asserting `toolAliases.Agent === "Task"`,
   `Task ∉ allowedTools`, `Task ∉ disallowedTools` only as that alias target,
   and no raw Task execution. Hostile user/project/local
   skills, agents, commands, plugins, MCP, memory, and credentials remain
   absent. Any SDK/binary drift requires human review of the literal fixture.
5. **Deterministic runtime/E2E journey.** Extend that process-isolated real-SDK
   test (or a sibling registered E2E) with a fake local Bobbit MCP handler and
   no model subscription turn: initialize production query options; invoke a
   valid `bobbit-backend-parity-reviewer` Agent call with
   `run_in_background:false`; observe `SubagentStart`, a child read/grep that
   passes the child subset, child frames carrying the parent-tool-use partition,
   `SubagentStop`, and one root Agent result. Then attempt `general-purpose`,
   `Task`, child `Agent`, background true, and child `mcp__bobbit__bash`; assert
   all are denied before dispatch and no Bobbit session/task/worktree/cost row
   is created. Use the existing fake SDK/query dependency seam for deterministic
   tool/lifecycle control; the real binary initialization remains the separate
   inventory proof.

Focused deterministic command after implementation:

```bash
npx vitest run --config vitest.config.ts --silent=passed-only \
  tests2/core/claude-agent-sdk-tool-surface.test.ts \
  tests2/core/claude-sdk-event-translator.test.ts \
  tests2/integration/claude-agent-sdk-tool-permissions.test.ts
npm run check
npm run build
npx playwright test --config playwright-e2e.config.ts \
  tests/e2e/claude-agent-sdk-real-init-inventory.spec.ts
```

These tests are acceptance gates for D3/D4; they do not create a new task,
goal, worktree, cost-accounting, or orchestration system.
