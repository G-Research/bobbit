# The Lifecycle Hub

> **Status — server core, not yet wired (Extension Platform G1.2).** The `LifecycleHub`
> exists and is fully tested, but **nothing in any session path calls it yet**. Authoring a
> provider has **no runtime effect in production today**. Session-setup wiring lands in G1.3
> and per-turn (`beforePrompt`) wiring in G1.4. See [Status / not-yet-wired](#status--not-yet-wired)
> at the end of this doc. This page documents the core so the wiring goals (and provider
> authors) have a stable contract to build against.

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

| Hook | Intended dispatch point | Wiring goal |
|---|---|---|
| `sessionSetup` | Once, when a session is created — seed durable context. | G1.3 |
| `beforePrompt` | Before each user prompt is sent to the model. | G1.4 |
| `afterTurn` | After a turn completes. | later |
| `beforeCompact` | Before transcript compaction. | later |
| `sessionShutdown` | When a session is torn down. | later |

A provider declares which hooks it wants in its YAML `hooks:` list; the Hub only dispatches a
hook to providers that declared it. **None of these dispatch points are wired into the session
runtime yet** — the table records *intent*, not current behaviour.

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
    base: Omit<HookCtx, "budget" | "config" | "gateway">,
  ): Promise<{ blocks: ContextBlock[]; diagnostics: HubDiagnostic[] }>;
}
```

### What `dispatch` does

1. **Resolve providers.** It asks `registry.listProviders(base.projectId)` (G1.1's resolver —
   installed, active, enabled providers for the project scope) and keeps only those whose
   `hooks` include the requested hook.
2. **Build a `HookCtx` per provider** by merging the caller's `base` context with the
   provider's YAML `config`, the provider's clamped `budget.maxTokens`, and the gateway
   coordinates from `gatewayInfo()`. The full `HookCtx` shape:

   ```ts
   interface HookCtx {
     sessionId: string; projectId?: string; scope: "project" | "global"; cwd: string;
     goalId?: string; roleName?: string; prompt?: string; turn?: { index: number };
     budget: { maxTokens: number };
     config: Record<string, unknown>;
     runtime?: { baseUrl: string; headers: Record<string, string>; status: string };
     gateway: { baseUrl: string; token: string };
   }
   ```
3. **Invoke each provider on the worker tier.** It calls `moduleHost.invoke({ exportKind:
   "providers", member: hook, url, packRoot, epoch, ctx, arg })` with the provider's
   `budget.timeoutMs` as the per-provider timeout. The worker resolves the module's hook from
   the **default-export object** (see [provider module contract](#provider-module-contract)).
4. **Collect + validate + force provenance** on the returned blocks (per the rules above).
5. **Apply budgets** across all collected blocks — per-provider maxima from each provider's
   budget, global from `globalMaxTokens`.
6. **Write one trace row** for the dispatch.
7. **Return** the kept blocks plus a list of diagnostics. `dispatch` **never throws** because
   of a provider — provider faults become diagnostics.

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

## The trace store

`ContextTraceStore` records each dispatch as one JSON line, so you can reconstruct exactly what
ambient context a session received and why blocks were dropped.

- **Location:** `<stateDir>/session-context-trace/<sessionId>.jsonl` (the directory is created
  lazily; the session id is sanitised to a safe basename). This mirrors the `bg-process` state
  layout under the state dir.
- **Entry shape** (`appendTrace(sessionId, entry)`):

  ```ts
  interface TraceEntry {
    ts: number;          // epoch ms
    hook: string;        // the dispatched hook
    sessionId: string;
    providers: {
      id: string;        // provider id
      ms: number;        // invocation duration
      blocks: number;    // blocks KEPT after budgeting
      omitted: number;   // budget-omitted + malformed-dropped count
      error?: string;    // error / "timeout" / "malformed block(s) dropped"
    }[];
  }
  ```
- **Reads:** `readTrace(sessionId, limit?)` returns entries oldest→newest; `limit` keeps the
  most recent N. Corrupt/partial lines are skipped rather than failing the read.
- **Size cap:** the file is capped at **2 MB**. On append, if the file exceeds the cap it is
  rewritten keeping only the newest lines that fit (drop-oldest), via a temp-file rename so a
  reader never sees a half-written file.

## Status / not-yet-wired

This goal (G1.2) delivers **pure server core**: the modules above plus the `"providers"`
`exportKind` branch on the Extension Host worker seam. It is intentionally **inert in
production** — no session lifecycle path constructs or calls the `LifecycleHub`, so installing
or authoring a provider changes nothing at runtime today.

The wiring is sequenced in later goals:

- **G1.3** constructs the Hub and calls `dispatch("sessionSetup", …)` during session setup,
  and integrates kept blocks into the system prompt (`PromptParts.dynamicContext`).
- **G1.4** adds the per-turn `beforePrompt` dispatch and the REST/provider-bridge surface.
- Selector hooks (`beforeGoalCreate` / `beforeSessionSpawn`) are a separate, later goal (G8).

Until then, treat this page as the contract those goals build against, and treat provider
authoring as "validated and catalogued, but not yet executed."

## See also

- [Extension Host authoring guide](extension-host-authoring.md) — how to write a provider pack.
- [Marketplace → Provider contributions](marketplace.md#provider-contributions-providersidyaml) —
  the provider YAML schema, defaults, and clamps.
- [Extension Host internals](extension-host-authoring.md) and `module-host-worker.ts` —
  the confined-worker `ModuleHost.invoke` seam the Hub dispatches through.
