# The Lifecycle Hub

> **Status — all five hooks wired (Extension Platform G1.3 + G1.4).**
> New sessions dispatch `sessionSetup` through the `LifecycleHub`, and the blocks it returns
> render as a **Dynamic Context** prompt section — see
> [Session-setup wiring (G1.3)](#session-setup-wiring-g13). The per-turn `beforePrompt` /
> `beforeCompact` hooks fire from a generated **provider-bridge** pi extension, and `afterTurn` /
> `sessionShutdown` fire from the gateway's own agent-event stream — see
> [Per-turn + lifecycle wiring (G1.4)](#per-turn--lifecycle-wiring-g14). Built-in production
> providers include the [Hindsight memory pack](hindsight-memory.md) and PR Walkthrough durable
> progress provider; both are scoped so an out-of-the-box normal session receives no unrelated
> Dynamic Context. This page documents the Hub core and its
> session wiring.
## What it is, and why

The Lifecycle Hub is the server-side seam that lets **pack-contributed providers** inject
*ambient context* into an agent session at well-defined moments — when a session starts, before
each prompt, after a turn, before a compaction, and at shutdown. A provider is trusted,
pack-shipped code (see [provider contributions](marketplace.md#provider-contributions-providersidyaml)
and the [authoring guide](extension-host-authoring.md)); the Hub is what eventually *runs* that
code and folds its output into the prompt.

The design problem the Hub solves: ambient context is powerful but dangerous. Untrusted *output*
and slow/looping *code* can both wreck a session. So the Hub is built around a single principle —

> **The provider code is trusted; its output is not, and its runtime is bounded.**

Concretely that means every dispatch is:

- **Isolated** — each provider runs on the Extension Host worker tier (`ModuleHost.invoke`),
  the same confined-worker seam that backs pack routes/actions. The worker is terminated on
  settle or timeout, so a runaway provider cannot block the gateway.
- **Budgeted** — each provider has a token budget and a wall-clock timeout; a global token cap
  bounds the whole dispatch. Over-budget content is truncated/dropped, never silently inflated.
- **Fenced** — accepted content is wrapped in a `<context-block …>` envelope with provenance
  attributes, so the model can tell ambient provider text apart from the user's own words.
- **Validated + provenance-forced** — the Hub re-checks the shape of every returned block,
  forces the `providerId`, and recomputes the token estimate host-side. A provider cannot
  claim to be another provider or under-report its size.
- **Traced** — one trace row per dispatch records which providers ran, how long they took, how
  many blocks they contributed, and any error — for debugging and budget tuning.
- **Fault-isolated** — a provider that throws, times out, or returns malformed blocks becomes a
  *diagnostic* and the dispatch **continues**; one bad provider never fails the others or the
  session.

The three core modules live under `src/server/agent/`:

| Module | Responsibility |
|---|---|
| `context-blocks.ts` | The `ContextBlock` shape, token estimation, fencing, and the budget algorithm. |
| `lifecycle-hub.ts` | The `LifecycleHub` class: resolve providers, dispatch a hook, collect/validate/budget, write a trace row. |
| `context-trace-store.ts` | Append-only JSONL trace per session, size-capped. |

## Hooks

A **lifecycle hook** is a named moment in a session's life. The hook set is:

| Hook | Dispatch point | How it fires | Wiring goal | Status |
|---|---|---|---|---|
| `sessionSetup` | Once, when a session is created — seed durable context. | Server-side, in the session-setup pipeline. | G1.3 | **wired** |
| `beforePrompt` | Before each turn's prompt reaches the model. | In-process **provider-bridge** extension → `before-prompt` endpoint. | G1.4 | **wired** |
| `beforeCompact` | Before transcript compaction. | In-process **provider-bridge** extension → `before-compact` endpoint. | G1.4 | **wired** |
| `afterTurn` | After a turn completes. | Server-side, from the gateway's `agent_end` event. | G1.4 | **wired** |
| `sessionShutdown` | When a session is torn down. | Server-side, from the session archive path. | G1.4 | **wired** |
| `goalProvisioned` | Every time a worktree in a goal's subtree is provisioned (goal worktree, team-member / delegate worktree, pooled worktree, sandbox worktree). | Server-side `dispatchGoalProvisioned`; fire-and-forget, returns no `ContextBlock`s. | — | **wired** |

A provider declares which hooks it wants in its YAML `hooks:` list; the Hub only dispatches a
hook to providers that declared it. The hooks split by **where** they fire:

- **Server-side hooks** (`sessionSetup`, `afterTurn`, `sessionShutdown`) dispatch directly from
  the gateway with no agent round-trip — they observe lifecycle moments but cannot amend the
  outgoing turn.
- **Per-turn hooks** (`beforePrompt`, `beforeCompact`) must run *inside* the agent process so
  they can observe/amend the turn, so they fire via a Bobbit-generated
  [provider-bridge pi extension](#the-provider-bridge-extension) that calls back into the
  gateway.

- **The filesystem-treatment hook** (`goalProvisioned`) is distinct from the context hooks: it
  returns no context blocks. It exists to let a provider apply a per-goal filesystem treatment
  (e.g. build a content-addressed index directory) to **every** worktree in a goal's subtree, so
  treatments are symmetric across the team lead, members, delegates, and nested sub-goals. It is
  dispatched with the goal's resolved (ancestry-merged) metadata, must be cheap and **idempotent**
  (it can fire on overlapping worktrees and re-enter on respawn/restore), and is non-fatal — a
  provider error is logged and swallowed so it never blocks goal/session start. For sandboxed
  sessions it is dispatched with **host** worktree coordinates, not the container path. See
  [Hierarchical goal metadata → Extension goal-lifecycle hook](design/goal-metadata.md#6-extension-goal-lifecycle-hook).

**Per-goal provider filtering.** When a goal sets `bobbit.disabledProviders: ["<id>"]` in its
metadata, the Hub drops those providers from `dispatch`, `hasProvidersForHooks`, and
`dispatchGoalProvisioned` for that goal's whole subtree — no bridge install, no per-turn hook
calls, no network. This is the clean way to disable a provider (e.g. Hindsight) for an experiment
without mutating project/global config. See
[Hierarchical goal metadata → Providers / bridge](design/goal-metadata.md#51-providers--bridge-clean-hindsight-disable).

The selector hooks `beforeGoalCreate` / `beforeSessionSpawn` remain a separate, later goal (G8).

## Scheduled advisors

Scheduled advisors are the Hub's separate post-turn observation path for eligible hook metadata;
they do not use provider `ContextBlock`s. They solve the narrow case where installed pack code
needs a periodic, bounded lifecycle observation without delaying or changing the agent turn.
Author declarations and module shape are specified in the [Extension Host authoring guide](extension-host-authoring.md#every-n-turn-schedules).

A hook is advisor-eligible only when it is active, declares `mode: decide`, exactly
`events: [afterTurn]`, a bounded `schedule.everyNTurns`, omitted `schedule.kind` or
`kind: advisor`, and has its exact active `decide` grant. `kind: decision` hooks are excluded from
this path: their due persisted cadence is handled by the normal decision dispatcher, which does
not call `dispatchScheduledAdvisors`. The Session Manager increments and persists one completed-turn
index at its final terminal event, then starts ordinary `afterTurn` provider dispatch followed by
advisor dispatch without awaiting either. Consequently:

- Due turns are exactly N, 2N, and so on; compaction, restore, and respawn preserve the index.
  A crash or interruption does not replay a former due turn.
- Invocation is fire-and-forget: advisor latency, timeout, failure, and trace persistence never
  block idle status, queue draining, or the next turn.
- One invocation is allowed per `(sessionId, packId, hookId)`. A due overlap is dropped rather
  than queued or retried.
- Authorization is checked at launch and completion. Pack disable/removal or exact-grant
  revocation aborts matching work and discards a result that settles after the change.
- Advisors receive only narrow server-derived data and can return only a safe trace identifier.
  They cannot inject context, change prompts, mutate sessions or goals, call a Host API, or
  supply token/dollar cost data. The trace attributes parent-measured duration to the
  server-derived pack and hook identifiers.

Wall-clock schedule metadata is deliberately inert: the Hub creates no timers, deadlines,
catch-up jobs, or retries.

## The `ContextBlock` contract

A provider hook returns blocks the Hub will consider injecting. The shape
(`context-blocks.ts`):

```ts
type ContextBlockAuthority = "memory" | "skill" | "tool" | "workflow" | "role" | "generic";

interface ContextBlock {
  id: string;            // provider-local block id (used in the fence envelope)
  title: string;         // human/source label → fence `source="…"`
  providerId: string;    // FORCED host-side to the dispatching provider's id
  authority: ContextBlockAuthority;
  content: string;       // the actual text injected into the prompt
  reason: string;        // why this block is here → fence `reason="…"`
  priority: number;      // higher = kept first under budget pressure
  tokenEstimate: number; // RECOMPUTED host-side from content
}
```

### Host-forced provenance — what a provider cannot fake

When a hook returns, the Hub validates each candidate block and **rewrites two fields**:

- **`providerId` is forced** to the id of the provider that actually ran. A block cannot
  attribute itself to another provider.
- **`tokenEstimate` is recomputed** host-side via `estimateTokens(content)` — a provider cannot
  under-report its size to dodge the budget.

`estimateTokens` is `Math.ceil(content.length / 4)`. This deliberately matches
`PromptSection.tokens` in `system-prompt.ts` so the Hub's accounting lines up with how the rest
of the prompt is measured.

### Validation — malformed blocks are dropped

A returned value is accepted as a block list if it is either an array of blocks or an object
with a `blocks` array. Each candidate must be a plain object with string `id`, `title`,
`content`, and `reason`; an `authority` in the allowed set; and a finite numeric `priority`.
Anything else is **dropped** and counted as malformed (one diagnostic per provider that
produced malformed blocks). The provider is not failed for it — valid blocks from the same
return still flow through.

## Fencing

Accepted blocks are wrapped so the model can distinguish ambient provider text from the
conversation. `fenceBlock(block)` produces:

```
<context-block id="…" source="…" authority="…" reason="…">
{content}
</context-block>
```

- `source` is the block's `title`; `id`, `authority`, and `reason` map straight across.
- **Attribute values are sanitised**: newlines are collapsed to spaces and `"` becomes
  `&quot;`, so a crafted `title`/`reason` cannot break out of the attribute or inject a fake
  tag. The `content` itself is placed between the tags verbatim (on its own lines).

## The budget algorithm

`applyBudgets(blocks, perProviderMax, globalMax)` decides which blocks survive. It returns
`{ kept, omitted }`, where each omitted entry carries a `why`. The rules, in order:

1. **Sort by `priority` descending**, ties broken by original collection order (which follows
   provider order). High-priority context wins scarce budget.
2. **Walk the sorted list, accumulating usage.** For each block the available *headroom* is the
   smaller of the remaining global budget and the remaining per-provider budget —
   `headroom = min(globalMax − globalUsed, providerMax − providerUsed)`. **The global cap binds
   before any per-provider headroom**: a provider can never spend budget the global cap has
   already exhausted, even if its own allowance remains.
3. **A block that fits is kept** and its tokens are charged to both the global and per-provider
   tallies.
4. **The first block that does *not* fit triggers single-shot truncation.** If the remaining
   headroom is at least 32 tokens, that one block's `content` is truncated to fit (with a
   trailing `…[truncated]` marker) and kept; its `tokenEstimate` is recomputed. If the headroom
   is below 32 tokens — or truncation would leave a remainder under 32 tokens — the block is
   **dropped instead of truncated** (never emit a uselessly tiny fragment).
5. **Every block after the truncation point is omitted** (`why: "after-truncation"`). The
   algorithm truncates at most one block, then stops keeping.

The `why` reasons you'll see in `omitted`: `after-truncation`, `truncated-below-min`,
`below-min`.

A `perProviderMax` entry comes from each provider's clamped `budget.maxTokens`; a provider with
no entry falls back to the global cap. `globalMax` defaults to **4000 tokens** (the Hub's
`globalMaxTokens` constructor option).

## The `LifecycleHub` class

```ts
class LifecycleHub {
  constructor(deps: {
    registry: PackContributionRegistry;
    moduleHost: ModuleHost;
    trace: ContextTraceStore;
    gatewayInfo: () => { baseUrl: string; token: string };
    globalMaxTokens?: number; // default 4000
  });

  dispatch(
    hook: LifecycleHook,
    base: HookDispatchBase,
  ): Promise<{ blocks: ContextBlock[]; diagnostics: HubDiagnostic[] }>;
}
```

### What `dispatch` does

1. **Resolve providers.** It asks `registry.listProviders(base.projectId)` (G1.1's resolver —
   installed, active, enabled providers for the project scope) and keeps only those whose
   `hooks` include the requested hook.
2. **Resolve the optional scope snapshot once.** At the lifecycle dispatch boundary, the Hub
   asks its project-safe resolver for `scopeContext` using only the dispatched session's own
   project and goal coordinates. A resolver failure is non-fatal and leaves the field absent.
   The result is one detached, deeply frozen snapshot shared by every provider invoked for that
   event; the Hub never resolves it per provider.
3. **Build a `HookCtx` per provider** by merging the caller's `base` context, that one optional
   snapshot, the provider's YAML `config`, the provider's clamped `budget.maxTokens`, and the
   gateway coordinates from `gatewayInfo()`. The full `HookCtx` shape is:

   ```ts
   interface HookScopeAncestryEntry {
     readonly id: string;
     readonly title?: string;
   }

   interface HookScopeGoal {
     readonly id: string;
     readonly title?: string;
     readonly ancestry?: readonly HookScopeAncestryEntry[];
     readonly depth?: number;
     readonly metadata?: Readonly<Record<string, unknown>>;
   }

   interface HookScopeContext {
     readonly project?: { readonly id: string; readonly name?: string };
     readonly goal?: HookScopeGoal;
     readonly role?: string;
     readonly component?: {
       readonly name: string;
       readonly repo: string;
       readonly relativePath?: string;
     };
   }

   export type HookScopeKind = "project" | "global";
   export const DEFAULT_HOOK_SCOPE: HookScopeKind = "project";

   export type TurnUsageSnapshot =
     | {
         telemetry: "known";
         inputTokens?: number;
         outputTokens?: number;
         cacheReadTokens?: number;
         cacheWriteTokens?: number;
         cost?: number;
         provider?: string;
         modelId?: string;
       }
     | { telemetry: "unknown" };

   interface HookCtx {
     sessionId: string; projectId?: string; scope: HookScopeKind; cwd: string;
     goalId?: string; roleName?: string; prompt?: string; turn?: { index: number };
     /** Present for gateway-dispatched afterTurn only. */
     usage?: TurnUsageSnapshot;
     budget: { maxTokens: number };
     config: Record<string, unknown>;
     runtime?: { baseUrl: string; headers: Record<string, string>; status: string };
     gateway: { baseUrl: string; token: string };
     readonly scopeContext?: HookScopeContext;
   }
   ```
4. **Invoke each provider on the worker tier.** It calls `moduleHost.invoke({ exportKind:
   "providers", member: hook, url, packRoot, epoch, ctx, arg })` with the provider's
   `budget.timeoutMs` as the per-provider timeout. The worker resolves the module's hook from
   the **default-export object** (see [provider module contract](#provider-module-contract)).
5. **Collect + validate + force provenance** on the returned blocks (per the rules above).
6. **Apply budgets** across all collected blocks — per-provider maxima from each provider's
   budget, global from `globalMaxTokens`.
7. **Write one trace row** for the dispatch.
8. **Return** the kept blocks plus a list of diagnostics. `dispatch` **never throws** because
   of a provider — provider faults become diagnostics.

### Scope vocabulary and compatibility

`HookScopeKind` is the exported lifecycle-provider vocabulary: `"project" | "global"`.
`DEFAULT_HOOK_SCOPE` is `"project"`, so project-bearing sessions retain the established default;
projectless sessions use `"global"`. Use these exports rather than duplicating scope strings in
provider-facing TypeScript.

`scopeContext` is an optional, additive, read-only `HookCtx` field. Providers that do not need
rich scope can ignore it safely: the Hub preserves their invocation, ordering, configuration,
budgets, diagnostics, and block behavior. It is absent when the resolver is unavailable, fails,
or cannot safely produce a snapshot.

### `afterTurn` usage telemetry

`HookCtx.usage` is an optional additive field supplied only to gateway-dispatched `afterTurn`
hooks. It exposes direct telemetry for the just-finished assistant turn so a provider can observe
usage without reading or reconstructing the cost ledger. It is not supplied to `sessionSetup`,
`beforePrompt`, `beforeCompact`, or `sessionShutdown`.

```ts
export type TurnUsageSnapshot =
  | {
      telemetry: "known";
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cost?: number;
      provider?: string;
      modelId?: string;
    }
  | { telemetry: "unknown" };
```

`telemetry: "known"` means the final assistant `message_end` carried a usage object. It does
not mean every field is known. Numeric fields are retained only when Pi reported a finite,
non-negative value; zero remains a reported value. Supported wire aliases are `inputTokens` /
`input`, `outputTokens` / `output`, `cacheReadTokens` / `cacheRead`, and `cacheWriteTokens` /
`cacheWrite`; `cost` accepts either a numeric value or `cost.total`. Omitted cache fields remain
absent (unknown), rather than being converted to zero. Invalid, negative, non-finite, and
object-shaped token fields are omitted; no token or cost value is estimated.

`provider` and `modelId` appear together only when the runtime supplies a complete observed or
verified model pair. A partial pair is omitted. `telemetry: "unknown"` has no numeric or
attribution fields and means the completed turn had no usable terminal assistant usage object.

The gateway normalizes this data once from the same terminal event consumed by
`SessionManager.trackCostFromEvent()`. The snapshot is an ephemeral live-turn value, not a
`CostTracker` readback, cost ledger, persisted session field, trace entry, or API response. This
keeps cache-unknown and missing-cost semantics aligned with the terminal wire data.

At the final non-retry `agent_end`, the gateway copies the snapshot (or `{ telemetry: "unknown" }`)
and fire-and-forget dispatches `afterTurn`. The existing terminal guard makes that dispatch
exactly once: duplicate or late terminal events cannot create another hook call. Retryable ends
do not dispatch; the final attempt supplies the snapshot. Error and abort terminals retain their
reported usage when available, otherwise they are unknown. The copied value prevents a slow hook
from observing a later turn. When no Lifecycle Hub is installed, no usage slot is allocated and
the existing cost and terminal lifecycle paths remain unchanged.

### `scopeContext`: bounded advisory scope

When present, `scopeContext` is read-only context for lifecycle providers. Its sections are emitted
only when independently resolvable; an identifier is required only when its enclosing section is
present. It helps a provider label or tailor its own advisory output, but grants **no** capability:
it does not authorize filesystem, session, agent, store, or cross-project access. The Host API
version and schema, provider activation, hook scheduling, invocation counts, ordering, budgets,
and context blocks are unchanged for providers that ignore the field.

The resolver has a strict trust and privacy boundary: it reads from the session's declared project
only, through that project's context and goal store. It never searches another project for a goal
with the same id or falls back to a different project. Headquarters, system, hidden, unknown, and
non-project sessions yield no `scopeContext`; a normal goal-less session can still yield its
project, role, and an unambiguous component.

When a live goal can be resolved, `goal.ancestry` is ordered **root to leaf**, including the leaf.
`goal.depth` is the root-based number of entries, so a root has depth `1`; it is present only when
that complete contiguous lineage was verified. `goal.metadata` is likewise present only for a
complete lineage and is the established ancestry-merged effective metadata (ancestors first,
descendant values winning). It is cloned before freezing, so providers cannot mutate goal-store
state or another provider's view.

Component coordinates are configured identifiers only: `name`, repository-relative `repo`, and
optional configured `relativePath`. No absolute project, worktree, repository, or component path
is exposed. The component is omitted when no unique match can be established — including a
multi-repository branch-container worktree and equal-depth matches.

Missing or archived goal records leave goal context absent. Missing or archived ancestors, cycles,
and bounded-walk caps degrade to a safe partial leaf/ancestry view rather than throwing or
inventing a root; in those cases `depth` and effective `metadata` are omitted. The snapshot is
deeply frozen once at dispatch and the same object reference is passed to every provider for that
event. Providers must treat absent fields and partial ancestry as normal conditions.

### Diagnostics — one bad provider never breaks the rest

`dispatch` returns a `HubDiagnostic[]` alongside the kept blocks:

```ts
interface HubDiagnostic {
  providerId: string;
  hook: LifecycleHook;
  error?: string;    // thrown-error message, or "malformed block(s) dropped"
  timeout?: boolean; // true when the per-provider timeout fired
  ms: number;        // how long the provider's invocation took
}
```

- **Timeout** — a provider that exceeds its `budget.timeoutMs` is terminated by the worker host;
  the Hub records `{ timeout: true }` and moves on. The other providers are unaffected, and the
  whole dispatch stays fast (the timeout bounds it).
- **Throw** — an exception in provider code becomes `{ error: message }`; no crash.
- **Malformed** — invalid blocks are dropped and the provider gets `{ error: "malformed
  block(s) dropped" }` while its valid blocks still flow through.

### Provider module contract

A provider module is authored as a **default-export object** whose members are the hook
handlers — *not* a named `providers` export. Each handler is `async (ctx) => { blocks: [...] }`
(it may also return a bare `ContextBlock[]`):

```js
// providers/memory.mjs
export default {
  async sessionSetup(ctx) {
    return {
      blocks: [
        {
          id: "recent-decisions",
          title: "Project memory",
          authority: "memory",
          content: "…",
          reason: "surfacing recent decisions for continuity",
          priority: 10,
          // tokenEstimate is recomputed host-side; providerId is forced.
        },
      ],
    };
  },
  async beforePrompt(ctx) { /* … */ },
};
```

This is why the worker's member-resolution has an explicit `providers` branch: for
`exportKind: "providers"` the hook *group* is the **default export object itself**
(`mod.default ?? mod`), and the hook name is one of its members. For `actions`/`routes` the
group is still `mod[exportKind] ?? mod.default?.[exportKind]` — that path is unchanged, so the
existing route/action dispatchers are unaffected.

## Session-setup wiring (G1.3)

This is the **first** place the Hub is actually called from a live session path. The wiring has
three moving parts; the goal was to add session behaviour without changing the prompt for any
session that has no active provider.

### Where the Hub is constructed

Exactly **one** `LifecycleHub` instance lives for the gateway's lifetime. It is built in the
server bootstrap (`src/server/server.ts`) right after the `PackContributionRegistry`, because the
Hub's dependencies (`registry`, `moduleHost`) only exist at that point, and assigned to the
already-constructed `SessionManager` via a public `lifecycleHub` field (the same
assigned-post-construction pattern as `sandboxTokenStore` / `configCascade`). Its `gatewayInfo`
callback reads the gateway base URL and admin token the same way the tool-guard does
(`BOBBIT_GATEWAY_URL` env or `state/gateway-url`; token from `state/token`), guarded so a missing
file never throws.

### Where the hook is dispatched

The session-setup pipeline (`src/server/agent/session-setup.ts`) gains one new async step,
`resolveDynamicContext`, dispatched immediately **before** `resolvePrompt` in both the synchronous
(`executePlan`) and worktree-async (`executeWorktreeAsync`) paths. It:

1. **Short-circuits to zero cost when no Hub is configured** (`if (!ctx.lifecycleHub) return;`).
   A session with no providers therefore pays nothing — this is what keeps spawn latency unchanged
   and the prompt byte-identical for the no-provider / schema-1 case.
2. Otherwise calls `lifecycleHub.dispatch("sessionSetup", { sessionId, projectId, scope, cwd,
   goalId, roleName, prompt })` (scope is `"project"` when the plan has a `projectId`, else
   `"global"`; `prompt` is the delegate task prompt when present, best-effort otherwise) and
   stashes the returned `blocks` on the plan as `dynamicContextBlocks`.
3. **Wraps the whole step in try/catch — a provider fault is logged and the spawn proceeds.**
   Dynamic context is ambient and optional; a throwing or slow provider must never block a session
   from starting. (The Hub already fault-isolates *individual* providers into diagnostics; this
   outer guard covers the dispatch call itself.)

The blocks are stashed on the **plan**, not applied directly, because `resolvePrompt` is
re-invoked on the cwd-rebind path. `_resolvePrompt` copies `plan.dynamicContextBlocks` into
`PromptParts.dynamicContext` on **every** invocation, so the blocks survive the re-calls —
dispatch once, re-apply many.

### How the blocks reach the prompt and the inspector

`system-prompt.ts` renders `PromptParts.dynamicContext` (when non-empty) as a **final** section,
after every existing section. It is placed last deliberately: provider-supplied ambient context is
the freshest, **lowest-authority** content, so it sits at the tail where it least disturbs the
cache-friendly stable prefix. Each block is wrapped with `fenceBlock` (the `<context-block …>`
envelope carrying `source` / `authority` / `reason` provenance) and the blocks are joined with
`\n\n`.

The section is added in **both** prompt builders, mirroring the skills-catalog duality:

- `_assembleSystemPrompt` (the actual system prompt) prepends a `## Dynamic Context` header.
- `getPromptSections` (the source for the prompt-sections inspector) emits
  `{ label: "Dynamic Context", source: "providers", content, tokens }`, where `content` is exactly
  the fenced blocks (no header) and `tokens` is the host-side estimate. Because
  `persistPromptSections` consumes `getPromptSections`, the section appears in the inspector
  (`GET /api/sessions/:id/prompt-sections`) **for free**, with `source: "providers"` provenance and
  a token count; per-block `provider` / `reason` / token live inside the fence attributes.

This `sessionSetup` Dynamic Context remains a **spawn-time system-prompt section**. It is
cache-safe because it is assembled once for the session instead of changing on every turn. Per-turn
`beforePrompt` Dynamic Context uses the custom-message path described below and is not appended to
`systemPrompt`.

**Empty / absent `dynamicContext` adds zero sections**, so a session with no contributing provider
produces a byte-identical prompt to before this wiring — the invariant a unit test pins.

### What ships out of the box

The [Hindsight memory pack](hindsight-memory.md) ships in the built-in band as the first production
provider, but it is **dormant until a Hindsight URL is configured** — so a fresh install contributes
no Dynamic Context until you opt in. The wiring itself is also exercised by a
deterministic fixture pack, `tests/fixtures/packs/provider-demo/`, whose `sessionSetup` returns a
`DEMO_SETUP_BLOCK` and a throwing variant proves the failure path still spawns the session. The
E2E test (`tests/e2e/provider-session-setup.spec.ts`) **copies that fixture into the per-gateway
server-scope market-packs dir** (`.bobbit/config/market-packs/provider-demo/`) and toggles it via
pack activation (`PUT /api/marketplace/pack-activation`), which invalidates the resolver caches.
This layers the fixture *on top of* the real built-in band rather than replacing it — the earlier
approach of pointing `BOBBIT_BUILTIN_PACKS_DIR` at the fixtures dir wiped the built-in band for
the whole worker-scoped gateway and broke sibling specs. Installing any schema-2 pack that ships a
`sessionSetup` provider will likewise contribute a Dynamic Context section.

## Per-turn + lifecycle wiring (G1.4)

G1.4 wires the remaining four hooks. They divide cleanly by **where they have to run**, and that
division dictates the mechanism:

| Hook | Mechanism | Why |
|---|---|---|
| `afterTurn` | Gateway-internal, fire-and-forget. | A turn-complete signal; nothing to inject, so no agent round-trip is needed. |
| `sessionShutdown` | Gateway-internal, awaited-with-timeout. | Lets providers flush durable state before teardown; the gateway already owns the archive path. |
| `beforePrompt` | In-process provider-bridge extension. | Must inject ambient recall into *this turn's* prompt, which only the agent process can see. |
| `beforeCompact` | In-process provider-bridge extension. | Must fire at the agent's compaction moment, which the gateway does not observe directly. |

### Server-side hooks: `afterTurn` and `sessionShutdown`

These fire from the gateway's existing agent-event stream — no agent round-trip and no public
endpoint (they are not reachable over REST by design; only the gateway dispatches them):

- **`afterTurn`** — dispatched from `handleAgentLifecycle`'s `agent_end` branch in
  `session-manager.ts`. pi does not surface a granular `turn_end` in the gateway's event stream,
  so `agent_end` (turn complete) is the dispatch point. It is **fire-and-forget**: the dispatch
  is `void`-ed (never awaited into the event path) and its rejection is caught and logged, so a
  slow or throwing provider can never stall the lifecycle. The `turn.index` passed is the
  session's running completed-turn count. Per-provider timeouts are still enforced inside the
  Hub.
- **`sessionShutdown`** — dispatched from the session archive path (`archiveWithCascade` and the
  `terminateSession` archive path) in `session-manager.ts`, **awaited with a timeout** so
  providers get a bounded window to flush before teardown proceeds. Failures are caught and
  logged; archive always proceeds.

### Per-turn hooks: the provider-bridge extension

The per-turn hooks need to run *inside* the agent process so they can amend the outgoing turn.
The gateway can't reach into that process, so Bobbit **generates a pi-coding-agent extension**
that subscribes to pi's per-turn events and calls back into the gateway. See
[The provider-bridge extension](#the-provider-bridge-extension) below for the codegen, transport,
and the non-negotiable injection invariant.

### The REST surface

Three endpoints back the per-turn hooks and diagnostics. They live in one contiguous block in
`server.ts`, modeled on `POST /api/sessions/:id/tool-grant-request`, and **inherit the
admin-bearer auth gate enforced before `handleApiRoute`** — no extra auth code. All are keyed by
session id and `404` when the session is unknown (neither live nor persisted).

| Method + path | Caller | Behaviour |
|---|---|---|
| `POST /api/sessions/:id/provider-hooks/before-prompt` | provider-bridge extension | Body `{ prompt?, turn?: { index } }`. Dispatches `beforePrompt`; responds `{ content, blocks, tail }` while `tail` remains as temporary legacy back-compat for old bridges. |
| `POST /api/sessions/:id/provider-hooks/before-compact` | provider-bridge extension | Dispatches `beforeCompact` and responds `{}` once provider flushes settle (bounded by per-provider timeouts). |
| `GET /api/sessions/:id/context-trace?limit=N` | inspector / diagnostics | Returns lifecycle-dispatch metadata `{ entries }` from the [trace store](#the-trace-store), oldest→newest; a positive `limit` keeps the most recent N (capped at 1000). The [Context Trace Inspector](#context-trace-inspector) starts at 100 and uses bounded expansion. |

**`before-prompt` response shape.** `content` is the accepted blocks joined as fenced
`<context-block …>` envelopes, or `""` when no block survived budgeting:

```
<context-block …>…</context-block>

<context-block …>…</context-block>
```

`blocks` is **metadata-only** — each entry is `{ id, providerId, title, tokenEstimate }`. The
full block text lives in `content`; the metadata array exists for the inspector and diagnostics
without parsing the body. `tail` is a temporary legacy system-prompt-tail wrapper for old generated
bridges; current generated bridges ignore it and consume `content` only. After dispatch the endpoint also refreshes the persisted
prompt-sections snapshot **best-effort** (non-fatal: a failure is logged and the response still
returns) so `GET /api/sessions/:id/prompt-sections` shows the turn's latest Dynamic Context
snapshot even though that context is delivered through a hidden message rather than the system
prompt.

When no `LifecycleHub` is configured, `before-prompt` returns `{ content: "", tail: "", blocks: [] }` and
`before-compact` returns `{}` — the turn proceeds unchanged.

## The provider-bridge extension

`provider-bridge-extension.ts` generates a small pi-coding-agent extension
(`generateProviderBridgeExtension(sessionId): string` → TS source;
`writeProviderBridgeExtension(sessionId): string | undefined` → file path). It mirrors
`tool-guard-extension.ts`'s codegen, caching, and content-addressed file handling — the file is
written under `.bobbit/state/provider-bridge/<contentHash>/bridge.ts` and de-duplicated by
hash.

The generated extension subscribes to three pi events:

- **`before_agent_start`** (per turn) → POST `…/provider-hooks/before-prompt` with
  `{ prompt: event.prompt }`, with an `AbortController` timeout of **2500 ms**. On success, if the
  response contains non-empty `content`, it returns a hidden custom message:
  `{ message: { customType: "bobbit:dynamic-context", content, display: false } }`. On empty
  content or **any** failure (transport, timeout/abort, non-2xx, parse error), it returns
  `undefined` and the turn proceeds with the unmodified prompt and system prompt.
- **`context`** → filters hidden `bobbit:dynamic-context` custom messages from future LLM
  contexts. It removes stale dynamic-context messages before the latest real `user` message and
  preserves current-turn dynamic context appended after that latest user.
- **`session_before_compact`** → POST `…/provider-hooks/before-compact`, with a timeout of
  **5000 ms**. The compacted span ignores `bobbit:dynamic-context` custom messages so summaries do
  not retain stale recall. The result is ignored (compaction output is not amended here); all
  failures are swallowed. This `beforeCompact` behavior is unchanged.

Transport and auth are identical to the tool-guard: read `BOBBIT_GATEWAY_URL` / `BOBBIT_TOKEN`
from the environment, falling back to `<BOBBIT_DIR || ~/.bobbit>/state/{gateway-url,token}`, and
`fetch` the gateway with a bearer token. A missing gateway URL short-circuits to "proceed
unchanged".

### The injection invariant (non-negotiable)

> **The user's message text is NEVER mutated, and per-turn Dynamic Context is never appended to
> `systemPrompt`.**

This is a hard correctness boundary, not a style preference. Mutating the user prompt would
corrupt the transcript echo and re-open the comms-stack optimistic-reconciliation **duplicate**
class. Mutating `systemPrompt` on every `beforePrompt` turn would also churn provider prompt
caches: Anthropic-style caching treats the system prompt as a strict byte prefix, so a changing
Dynamic Context tail can force repeated cache writes for the full cached system block.

The bridge therefore forwards `event.prompt` to the gateway **read-only** and, when the gateway
returns non-empty Dynamic Context, returns a hidden pi custom message with
`customType: "bobbit:dynamic-context"`. pi appends extension messages on the user-side message
channel, so the model still receives the fenced context for that turn, but `context.systemPrompt`
stays byte-identical across turns even when the Dynamic Context content changes.

If the gateway returns empty content, or the callback fails or times out, the bridge returns
`undefined`. No prompt text, user text, or system prompt bytes are changed.

### System-prompt stability

The old per-turn system-prompt tail path is intentionally retired for the generated bridge; the
`before-prompt` endpoint still returns a temporary legacy `tail` field only for old bridges. The
only Dynamic Context that belongs in `systemPrompt` is `sessionSetup` output, assembled once at
spawn time. Per-turn blocks are delivered as hidden `bobbit:dynamic-context` custom/user-side
messages, and stale persisted copies are filtered from future LLM contexts; `beforeCompact` still
only notifies providers before compaction and does not amend compaction output.

### Activation — generated only when a provider wants it

The bridge is generated and pushed onto the agent's `--extension` spawn args **only when at least
one enabled provider for the session's project declares `beforePrompt` or `beforeCompact`**
(`hasProviderBridgeHooks(hub, projectId)`, which delegates to `hub.hasProvidersForHooks(...)` so
activation filtering stays centralized in the registry). Disabled providers are dropped by the
registry before this check, so toggling a provider off is a working kill switch — the next spawn
omits the bridge entirely.

When no provider is interested, nothing is generated or pushed: **zero overhead and spawn args
byte-identical to the no-provider baseline** (pinned by the codegen test). The activation check
lives in two places that both spawn agents — `session-setup.ts::resolveToolActivation` (initial
spawn, after the tool-guard `--extension` push) and the respawn/restore path in
`session-manager.ts`. **Both** re-run the check so the bridge is **restored on respawn and
gateway restart**; otherwise per-turn hooks would silently stop firing after a restart. The
`.bobbit/state/provider-bridge/` directory is on the archive allowlist so the generated bridge
survives session archive/restore.

### Security note — TLS

The generated bridge **does not touch TLS verification**. It relies on the spawner's inherited
environment: the local gateway's CA cert is pinned via `NODE_EXTRA_CA_CERTS` when present (with
the spawner's existing fallback only when no CA cert exists). An earlier revision set a
process-wide TLS downgrade in the generated code; that was removed because it would defeat the
pinned-CA path and disable verification for **all** of the agent's outbound HTTPS — not just the
gateway callback. Never reintroduce a global TLS downgrade in the bridge.

## The trace store

`ContextTraceStore` records one bounded metadata row for each lifecycle dispatch. The trace explains
*that* provider work ran and its budget outcome, plus optional core-owned extension activity, without
retaining context-block bodies or prompt fields. This supports diagnosis and future decision/advisory/
audit visibility without becoming a prompt viewer or searchable audit archive.

- **Location:** `<stateDir>/session-context-trace/<sessionId>.jsonl` (the directory is created
  lazily; the session id is reduced to a safe basename). This mirrors the `bg-process` state
  layout under the state dir.
- **Entry shape** (`appendTrace(sessionId, entry)`):

  ```ts
  type TraceOutcome = "advised" | "applied" | "denied" | "dropped" | "error" | "superseded";
  type TraceOutcomeKind = "decision" | "advisory" | "audit";
  type TraceOutcomeEvent = "sessionSetup" | "beforePrompt" | "afterTurn"
    | "beforeCompact" | "sessionShutdown" | "decisionResolved";
  type TraceOutcomeReason = "Grant required" | "User pin" | "Unavailable value"
    | "Malformed result" | "Timed out" | "Overlapping invocation" | "Cancelled"
    | "Disabled or revoked" | "Budget exhausted" | "Deadline elapsed"
    | "Headless default" | "Invalid answer" | "Duplicate" | "Capability revoked"
    | "Proposal failed" | "Lower-priority selection";
  type TraceSelectionKind = "model" | "thinking" | "role" | "workflow";
  type TraceOutcomeActor = "extension" | "user" | "deadline" | "headless";

  interface TraceOutcomeRow {
    kind: TraceOutcomeKind;
    packId?: string;            // server-derived; required for advisory afterTurn rows
    hookId: string;             // safe, stable declared identifier
    event: TraceOutcomeEvent;
    outcome: TraceOutcome;
    reason?: TraceOutcomeReason;
    value?: string;             // legacy EP-5 safe identifier field
    ms?: number;                // parent-measured duration
    requestId?: string;
    questionId?: string;        // SHA-256 hex/base32 fingerprint, not prose
    answer?: string;            // safe option id or literal "other", not Other text
    defaultApplied?: boolean;
    actor?: TraceOutcomeActor;
    selectionKind?: TraceSelectionKind;
    selectionValue?: string;
  }

  interface TraceEntry {
    ts: number;                 // epoch ms
    hook: string;                // dispatched lifecycle hook
    sessionId: string;
    providers: Array<{
      id: string;
      ms: number;               // invocation duration
      blocks: number;           // kept after budgeting
      omitted: number;          // budget-omitted + malformed-dropped count
      error?: string;           // normalized diagnostic category
    }>;
    outcomes?: TraceOutcomeRow[];
  }
  ```

  `outcomes` is optional, so old rows remain valid. It is nested in its lifecycle entry: pagination
  can never separate an event from its extension activity. Only the core validation, grant, or
  application owner may append an outcome; extension code cannot claim that a value was applied.
  The [REST context-trace endpoint](rest-api.md#context-trace-endpoint) is the canonical public
  projection of this persisted schema.
  Scheduled-advisor rows are `kind: "advisory"`, `event: "afterTurn"`, and include the
  server-derived `packId`. `advised` records a valid observed suggestion, `applied` a
  core-validated application, `denied` a grant/policy/user-pin refusal, `dropped`
  malformed/timeout/unavailable/overlap-drop behavior, `error` a core-classified failure, and
  `superseded` deterministic precedence loss.

  Before JSONL persistence and again on reads, provider rows are limited to **100** and outcomes
  to **50** per entry. Provider and outcome identifiers must match
  `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`; invalid provider ids become `Unknown provider`, while
  malformed outcome rows are omitted. Durations and counts must be finite, non-negative integers
  and are capped at **1,000,000,000**. Provider errors become only `Timed out`, `Malformed blocks
  omitted`, or `Provider error`. Outcome `kind`, `event`, `outcome`, and `reason` are exact
  allow-list values above. `value` is the legacy EP-5 field, retained only for `advised`,
  `applied`, or `superseded` and only when it is a safe identifier; new decision-resolution rows
  use `answer` instead. For decision/advisory activity, optional `packId` and `requestId` are safe
  identifiers, `questionId` is a SHA-256 hexadecimal or base32 fingerprint rather than question
  prose, and `answer` is a safe selected option id or the literal `other` rather than Other text.
  `answer` and `defaultApplied` survive only for `applied` or `superseded` resolutions; `actor`,
  when present, is one of the fixed actor labels above. `selectionKind` is one of the fixed
  advisory-selection categories. `selectionValue` survives only for an `advised` or `applied`
  selection: a model uses its verified `provider/modelId` tuple, while the other kinds use a safe
  identifier. Denied, dropped, errored, and superseded selections retain no selection value.
  These rules prevent extension prose, arbitrary errors, and unsafe values from becoming durable
  or REST-visible diagnostics.

  The schema intentionally excludes context-block bodies, prompts, question prose and labels,
  answer/Other text, rationale, raw availability data, usage telemetry, tokens, credentials,
  provider config, role prompts, workflow bodies, raw provider errors, stacks, paths, tool
  arguments, patches, and arbitrary configuration values. `reason` is a small core-owned catalog,
  not provider prose.
- **Reads:** `readTrace(sessionId, limit?)` returns entries oldest→newest; `limit` keeps the
  most recent N. Corrupt/partial lines are skipped rather than failing the read.
- **Retention:** each per-session JSONL file is capped at exactly **2 MiB**. After an append that
  exceeds the cap, the store retains the newest complete rows that fit and rotates out the oldest
  complete rows, using a temporary-file rename so readers do not observe a partial rewrite. This
  is bounded diagnostic retention, not an audit archive.

## Context Trace Inspector

The **Context trace** inspector is the user-facing, read-only view of this metadata. It makes
provider activity debuggable and budget outcomes visible while preserving the boundary between
observability and the private context supplied to the model.

### Open, persistence, and accessibility

From the active session, choose **Session actions → View context trace**. This opens a **Context**
tab in the shared right-side workspace rather than replacing the transcript. The tab is persisted
with that session's workspace, so returning to or cold-reloading a historical persisted session
rehydrates the open inspector and reloads its trace. Closing the tab remains authoritative; it is
not recreated merely because trace data exists.

The inspector uses the shared side-panel layout, including narrow-screen behavior. It is keyboard
accessible: opening the non-modal tab moves focus to its heading, refreshes retain the current
focus, and closing it restores focus to the action that opened it when possible (with a safe
session-actions/composer fallback). Its controls have screen-reader names and loading/error states.

### What it shows — and what it never shows

The newest lifecycle event appears first. For each event, the inspector shows:

- lifecycle event and local time;
- provider id, latency, and kept/omitted block counts;
- a sanitized provider status, when applicable: **Timed out**, **Malformed blocks omitted**, or
  **Provider error**; and
- an **Extension activity** list after provider rows when the entry has valid outcomes. It shows
  fixed labels for Decision, Advisory, or Audit; the outcome (including distinct visible **Denied**
  and **Dropped** statuses); and only allow-listed hook, event, reason, safe value, and duration.

Provider order and outcome order within an event are preserved. All endpoint values are treated as
untrusted and normalized before reaching the component: unrecognized hooks/providers become safe
fallback labels, invalid numbers are bounded, arbitrary provider error text becomes a fixed status,
and malformed or unknown outcome rows are ignored. The inspector never renders context-block
contents, prompts, gateway tokens, secrets, raw provider errors, raw outcome rationale/value,
stack traces, or filesystem paths. It is deliberately not a prompt, configuration, or error-detail
inspector.

### Loading and updates

Requests run only while the Context tab belongs to the active session. The initial read asks for
100 recent rows. **Load 100 earlier** increases the bounded recent-history window by 100 rows at a
time, up to 1,000; it is not an unbounded poll or cursor walk. The API supplies that window in
oldest→newest order, while the inspector reverses only the events for newest-first display and
leaves every event's provider order untouched.

The panel shows loading, empty, and retryable error states. A refresh failure after rows have
loaded keeps those rows visible with a non-sensitive refresh warning. Requests are aborted on a
session switch, disconnect, or Context-tab close, and stale responses cannot update another
session's inspector.

A successful durable trace append sends the session WebSocket a metadata-only
`context_trace_updated` invalidation (`sessionId` and timestamp only). An open active inspector
then re-reads its bounded REST window; no trace row, provider diagnostic, outcome, prompt, or
secret is sent over WebSocket. An inactive session remembers the invalidation and revalidates once
when its persisted inspector is next opened or synchronized. There is no polling loop.

## Status / wiring roadmap

- **G1.2** delivered the **server core**: the modules above plus the `"providers"` `exportKind`
  branch on the Extension Host worker seam.
- **G1.3 (done)** constructs the single Hub at gateway bootstrap and calls
  `dispatch("sessionSetup", …)` during session setup, rendering kept blocks as the
  `PromptParts.dynamicContext` → **Dynamic Context** system-prompt section — see
  [Session-setup wiring (G1.3)](#session-setup-wiring-g13).
- **G1.4 (done)** wires the remaining four hooks: the per-turn `beforePrompt` / `beforeCompact`
  via the generated [provider-bridge extension](#the-provider-bridge-extension), and the
  server-side `afterTurn` / `sessionShutdown` from the gateway's agent-event stream; plus the
  REST surface (`/provider-hooks/*`, `/context-trace`) — see
  [Per-turn + lifecycle wiring (G1.4)](#per-turn--lifecycle-wiring-g14).
- **G2** ships the first built-in production provider, the [Hindsight memory pack](hindsight-memory.md).
  It is dormant until a Hindsight URL is configured, so out of the box behaviour is unchanged —
  with no active provider, no Dynamic Context section is added and the per-turn bridge is never
  spawned.
- Selector hooks (`beforeGoalCreate` / `beforeSessionSpawn`) are a separate, later goal (G8).

## See also

- [Hindsight memory pack](hindsight-memory.md) — the first production provider, a built-in
  (dormant-by-default) memory provider that recalls/retains across sessions.
- [Extension Host authoring guide](extension-host-authoring.md) — how to write a provider pack.
- [Marketplace → Provider contributions](marketplace.md#provider-contributions-providersidyaml) —
  the provider YAML schema, defaults, and clamps.
- [Extension Host internals](extension-host-authoring.md) and `module-host-worker.ts` —
  the confined-worker `ModuleHost.invoke` seam the Hub dispatches through.
