# Bobbit Extension Platform — pack-first providers, hooks, runtimes, and ecosystem compat

Status: design / implementation blueprint. Each phase in §13 is written to convert 1:1 into a
mission goal with acceptance criteria.

> **Execution authority:** implement from
> [extension-platform-implementation-plan.md](extension-platform-implementation-plan.md)
> (goal map, owned files, RED→GREEN tests) — including its **§0.2 refinement** (new entity
> types load via the pack-contributions path, NOT new `EntityLoader` entities; that
> supersedes the §4 sketch below). Program-wide sequencing + master checklist:
> [fable-program-execution-plan.md](fable-program-execution-plan.md).

---

## 1. Mission & principles

Bobbit should stop growing core features and become an **extension platform**: memory, context
providers, skills, roles/personas, workflow templates, MCP servers, lifecycle hooks, managed
services, and UI panels all arrive as **marketplace packs** — installable, updatable,
per-entity toggleable, and uninstallable — instead of as core code.

Principles (binding on every phase):

1. **Pack-first from day one.** New machinery (providers, hooks, runtimes, capabilities) ships
   as pack entity types immediately. The reference implementations — `session-memory` and
   `hindsight` — are real packs in `market-packs/`, with zero feature code in core. Core grows
   only *platform* code: loaders, dispatchers, supervisors, policy.
2. **Host-controlled compilation.** Packs and selector LLMs *propose*; Bobbit validates,
   budgets, fences, records provenance, and applies at safe lifecycle boundaries. No pack gets
   raw system-prompt rewrites or unbounded injection.
3. **Everything inspectable.** Every injected context block carries source, provider, reason,
   and token estimate, and is visible in the existing prompt-sections inspector. Invisible
   context selection cannot be trusted or debugged.
4. **Failures are non-fatal.** A dead memory service, a hung provider, a crashed worker — the
   session always proceeds; the degradation is surfaced, never silent.
5. **Great defaults, changeable settings.** A pack that needs a service (Hindsight + Postgres)
   must work from a single Enable click with generated secrets, a preconfigured cheap model,
   and sane budgets — while exposing every knob for power users.
6. **One UX for memory.** The agent "just remembers". Which engine produced a memory (built-in
   session search vs Hindsight) is provenance detail, not user burden.
7. **Trusted code, honest framing.** Packs are trusted code with resource/crash isolation only
   (the deliberate stance of the Extension Host — see `docs/design/extension-host.md` and the
   isolation simplification in #732). We disclose capabilities at install/enable; we do not
   pretend to sandbox.

Compatibility targets in scope: **Claude Code plugin format** (plugin marketplaces install as
packs), **MCP servers as pack content**, **pi extensions as pack content**, and
**Claude-style lifecycle hooks**.

---

## 2. Substrate inventory (what we build on — verified anchors)

| Substrate | Where | What we reuse |
|---|---|---|
| Pack resolver | `src/server/agent/pack-types.ts:26` (`EntityType`, `EntityLoader<T>` at `:138`), `pack-resolver.ts`, `pack-list.ts` | One ordered pack list, scope order `builtin < server < global-user < project`, `pack_order`, `pack_activation` per-entity disable, conflict reporting, synchronous cache invalidation. New entity type = new loader. |
| Manifest validation | `src/server/agent/pack-manifest.ts:71-138` | Schema V1; unknown top-level keys ignored (forward compat); `contents.mcp` hard-rejected at `:95-97` (lifted for `schema: 2`). |
| Marketplace install | `src/server/agent/marketplace-install.ts`, `marketplace-source-store.ts`, REST in `server.ts` (§ marketplace routes) | Git/local/builtin sources, atomic staging install, `.pack-meta.yaml` provenance, update/uninstall. The staging step is the seam for the Claude-plugin format adapter. |
| Built-in first-party band | `src/server/agent/builtin-packs.ts`, `scripts/copy-builtin-packs.mjs`, `BOBBIT_BUILTIN_PACKS_DIR` | Pre-installed, resolve-in-place packs (e.g. `pr-walkthrough`): the delivery vehicle for `session-memory` and `hindsight`, and the test seam for fixture packs. |
| Extension Host execution tier | `src/server/extension-host/module-host-worker.ts`, `route-dispatcher.ts`, `action-dispatcher.ts`; contract in `src/shared/extension-host/host-api.ts` | Confined `worker_threads` execution of trusted pack server modules: per-call timeout (terminate-on-timeout), concurrency cap, per-session rate limit, import containment, pack-scoped stores, surface-binding tokens. Providers run on this tier. |
| Generated pi extensions | `src/server/agent/tool-guard-extension.ts:31` (codegen, `pi.on("tool_call")` + HTTP long-poll via `BOBBIT_GATEWAY_URL`/`BOBBIT_TOKEN`), `tool-activation.ts` (`writeMcpProxyExtensions`, `resolveExtensionPath`) | The proven gateway⇄agent bridge pattern. The provider-bridge extension (§5.4) and hook bridge (§13 P6) are new instances of it. |
| pi extension surface | `node_modules/@…/pi-coding-agent/dist/core/extensions/types.d.ts`, `system-prompt.d.ts` | Events: `before_agent_start` (systemPrompt replace), `context`, `tool_call`/`tool_result`, `turn_start/end`, `agent_start/end`, `session_before_compact`, `session_shutdown`, `input`; `pi.registerTool`; `BuildSystemPromptOptions`. |
| Prompt assembly + inspector | `src/server/agent/system-prompt.ts:294-448` (`PromptParts` → `assembleSystemPrompt`), `persistPromptSections` `:654`, `GET /api/sessions/:id/prompt-sections` (`server.ts:11354`) | Ordered prompt sections with byte budgets (`skillsCatalogBudget` pattern) and a shipping inspector. Provider blocks land here. |
| Session search | `src/server/search/flex-store.ts:155` (`FlexSearchStore`, BM25 + recency boost, chunking), `search-service.ts`, `indexer.ts`, `GET /api/search`; `transcript-reader.ts` + the `read_session` tool | Goals/sessions/messages/staff indexed per project; transcripts kept indefinitely in `.bobbit/state/sessions/<id>.jsonl`. This is the `session-memory` provider's substrate. Missing today: automatic prompt-time recall — exactly the gap providers fill. |
| Docker supervision patterns | `src/server/agent/project-sandbox.ts` (DOCKER_BIN/execFile discipline, MSYS env handling), `sandbox-manager.ts` (idempotent ensure + in-flight dedupe), `aigw-manager.ts` (supervise external HTTP service) | The shapes the pack-runtime supervisor mirrors (not reuses — sandboxes are per-project repo isolation; runtimes are server-scoped services). |
| Secrets | `SecretsStore` (state-dir, gitignored) | At-rest storage for runtime secrets. |
| Stores | `RoleStore`/`RoleManager` (`Role{promptTemplate, accessory, toolPolicies, model, thinkingLevel}`), `WorkflowStore`/`WorkflowManager` (project.yaml-scoped, goal snapshots), `McpManager` (9 discovery locations incl. Claude's), `slash-skills.ts` (incl. `.claude/skills`/`.claude/commands`), `model-registry.ts` | Selectors and workflow templates operate **through** these stores, never around them. |
| Exemplar packs | `market-packs/artifacts` (tool+renderer+panel litmus), `market-packs/pr-walkthrough` (routes/panels/entrypoints, built-in band) | The authoring patterns and the test-litmus convention every new entity type follows. |

---

## 3. Entity model

Six new pack entity types, plus a capability registry. They stay distinct because they have
three genuinely different execution substrates and two authoring models:

| Entity | Declared at | Code runs | Purpose |
|---|---|---|---|
| `providers` | `providers/<id>.yaml` + module | **Gateway**, Extension Host worker tier | Typed lifecycle participants: contribute context blocks, react to turns/compaction/shutdown, make proposals (selector kind). |
| `hooks` | `hooks/<id>.yaml` (or Claude `hooks/hooks.json`) | Gateway-spawned child processes | Claude-style declarative command hooks (JSON stdin/stdout); adapt onto the same dispatcher as providers. |
| `mcp` | `mcp/<name>.yaml` | n/a (config) | MCP server configs merged into `McpManager` discovery with pack provenance. |
| `pi-extensions` | `pi-extensions/<name>.yaml` → module | **Agent subprocess** (`--extension`) | Escape hatch + pi-ecosystem compat. Hooks pi events without registering tools. |
| `runtimes` | `runtimes/<id>.yaml` + compose file | **Docker**, gateway-supervised | Managed services (health, ports, volumes, secrets) a pack depends on. |
| `workflows` | `workflows/<id>.yaml` | n/a (templates) | Workflow **templates** instantiated into the project store at project/goal setup. `project.yaml` remains the source of truth; goal snapshotting is unchanged. |

Notes on the boundaries:

- **A provider is host-side, not a pi extension.** Prompt assembly happens in the gateway, so
  before-prompt contribution with provenance is only possible host-side; recall/retain then
  costs no per-call subprocess hop (the gateway already sees every prompt and every
  `turn_end`); secrets (e.g. Hindsight keys) never enter the agent process; and the worker
  tier's timeout/terminate machinery gives failure isolation for free. The agent-side reach a
  provider occasionally needs is delivered by one Bobbit-generated bridge extension (§5.4),
  not by pack code in the agent.
- **Provider tools are just tools.** `hindsight_recall` ships as a normal pack tool group with
  the existing `bobbit-extension` provider type (the `defaults/tools/shell/` pattern), whose
  pi extension calls back to the pack's own routes. No new "provider tool" concept; role
  `toolPolicies`, the tool guard, and `pack_activation` apply unchanged.
- **`pi-extensions` is not a new trust tier.** Pack tools already run arbitrary code in the
  agent process; this entity just admits it for event-only extensions. Both are gated by the
  same acknowledgment (§8).

### 3.1 Capability registry (inter-pack composition)

Packs can publish and consume named capabilities:

```yaml
# pack.yaml fragments
provides: [model-selector]      # this pack implements the capability
requires: [model-selector]      # this pack calls it (install-time check: warn + suggest)
```

A capability is implemented by a pack route or provider method registered under the
capability name. Consumers call it through the host:

```ts
const res = await ctx.capabilities.call("model-selector", {
  task: "implementation", spec, candidates, constraints: { maxCostTier: 2 },
});
```

The call is host-mediated: routed to the providing pack's module on the worker tier, budgeted
(timeout, payload caps), and recorded in the trace. This is how a persona selector consults a
"best model selector", how a workflow template asks for stage-model assignment, and how future
packs compose without importing each other's code. Conflicts (two packs providing the same
capability) resolve by pack precedence, same as entities.

---

## 4. pack.yaml schema v2

Additive; `schema: 2` marks packs using the new keys. v1 validators ignore unknown keys, so a
v2 pack on an old server degrades to its v1 subset (roles/tools/skills/entrypoints load; the
rest is ignored). v2 servers warn when `schema` is newer than supported.

```yaml
schema: 2
name: hindsight
description: Persistent agent memory backed by Hindsight (recall/retain/reflect, shared tag-scoped bank — see docs/design/agent-memory.md).
version: 1.0.0
contents:
  roles: []
  tools: [hindsight]            # existing: tool GROUP dirs under tools/
  skills: []
  entrypoints: [hindsight-open, hindsight-route]
  providers: [memory]           # NEW → providers/memory.yaml
  hooks: []                     # NEW → hooks/<id>.yaml (or hooks/hooks.json, Claude layout)
  mcp: []                       # NEW → mcp/<name>.yaml   (v1 rejection lifted when schema >= 2)
  pi-extensions: []             # NEW → pi-extensions/<name>.yaml
  runtimes: [hindsight]         # NEW → runtimes/hindsight.yaml
  workflows: []                 # NEW → workflows/<id>.yaml (templates)
provides: []                    # NEW: capability names this pack implements
requires: []                    # NEW: capability names this pack consumes
routes:                         # existing (pack-level routes)
  module: lib/routes.mjs
  names: [status, recall, retain, reflect, banks, config]
```

Per-entity declaration files:

```yaml
# providers/memory.yaml
id: hindsight-memory
kind: memory                    # memory | selector | generic
module: ../lib/provider.mjs     # contained in pack root (existing path-guard discipline)
hooks: [sessionSetup, beforePrompt, afterTurn, beforeCompact, sessionShutdown]
runtime: hindsight              # optional: binds to runtimes/<id>; host injects {baseUrl, headers}
budget: { maxTokens: 1200, timeoutMs: 1500 }
defaultEnabled: true
config:                         # typed settings surface, rendered in the pack's settings UI
  mode:        { type: enum, values: [managed, external], default: managed }
  externalUrl: { type: string, optional: true }
  apiKey:      { type: secret, optional: true }
  autoRecall:  { type: boolean, default: true }
  autoRetain:  { type: boolean, default: true }
  recallBudget:{ type: number, default: 1200 }
```

```yaml
# runtimes/hindsight.yaml
id: hindsight
kind: docker-compose
compose: ../runtime/compose.yaml      # images pinned by digest in the compose file
services: [hindsight, postgres]
healthcheck: { service: hindsight, path: /health, intervalMs: 5000, startupTimeoutMs: 120000 }
ports:
  hindsight: { container: 8888, host: auto }   # host port allocated + persisted by supervisor
volumes: [pg-data]                              # named volumes; survive pack update
secrets:
  POSTGRES_PASSWORD: { generate: true }         # crypto-random at first start
startPolicy: on-enable                          # never auto-start without a user action
```

```yaml
# workflows/multi-model-delivery.yaml (template)
id: multi-model-delivery
name: Multi-model delivery
description: Plan with a frontier model, implement cheap+precise, QA and review with independent models.
gates: [...]                    # same shape WorkflowStore validates today
```

Validator deltas (`pack-manifest.ts`): accept the six new `contents` keys (string arrays,
`isSafeBasename`-guarded), accept `provides`/`requires` (string arrays), lift the
`contents.mcp` rejection when `schema >= 2` (keep rejecting for v1 manifests). New
`EntityType` members + one `EntityLoader<T>` per type (`pack-types.ts:26/:138` — the seam was
designed for this). `pack_activation` extends to all six types so per-entity disable works on
day one.

---

## 5. The Lifecycle Hub

One new gateway component — `src/server/agent/lifecycle-hub.ts` — the minimal host-controlled
orchestrator. It resolves enabled providers/hooks via the PackResolver, dispatches lifecycle
events to them on the Extension Host worker tier, validates and budgets their output, and
records provenance.

### 5.1 Hook points

| Hook | Fires from | May contribute | On failure/timeout |
|---|---|---|---|
| `sessionSetup` | New pipeline step in session setup, between tool resolution and `resolvePrompt` (`session-setup.ts`) | `ContextBlock[]` → new `PromptParts.dynamicContext` → rendered as a **"Dynamic Context"** prompt section, persisted by `persistPromptSections` (visible in the existing inspector) | Provider skipped; diagnostic recorded; session proceeds |
| `beforePrompt` | Gateway prompt-submit path, before `RpcBridge.prompt()` (and per-turn via the bridge, §5.4) | `ContextBlock[]` → fenced `<context-block …>` blocks prepended to the outgoing prompt | Hard timeout (default 1500ms) ⇒ prompt sent without blocks; diagnostic recorded |
| `afterTurn` | Existing event subscription (`turn_end`/`agent_end` in the session manager's lifecycle handler) | Nothing (fire-and-forget; receives the turn transcript slice) | Logged |
| `beforeCompact` | Compaction detection (`session_before_compact` via the bridge) | Nothing in P1 (notification: flush/retain before context loss) | Logged |
| `sessionShutdown` | Session archive/stop path | Nothing (flush) | Logged |
| `beforeGoalCreate` / `beforeSessionSpawn` | Goal-creation and session-spawn paths (P8) | Typed **proposals** (§12) — never direct mutation | Proposal dropped; deterministic defaults |

Deferred deliberately: mid-turn `context` message mutation, compact-output mutation,
`tool_call`/`tool_result` interception for packs (P6 generalizes the existing tool-guard
long-poll for hooks), `before_provider_request` telemetry.

### 5.2 Context blocks, budgets, provenance

```ts
export interface ContextBlock {
  id: string;            // "<providerId>:<local-id>"
  title: string;         // "Relevant past work"
  providerId: string;
  authority: "memory" | "skill" | "tool" | "workflow" | "role" | "generic";
  content: string;       // fenced by the HOST, never raw-injected
  reason: string;        // why this was included — shown in the inspector
  priority: number;
  tokenEstimate: number; // host-computed (~4 chars/token heuristic, as PromptSection.tokens)
}
```

Budgets: per-provider `budget.maxTokens` (default 1200–1600) and a global dynamic-context cap
(default 4000), enforced by priority-ordered truncation — the same approach as
`SKILLS_CATALOG_BUDGET` (`system-prompt.ts`). All blocks are wrapped by the host:

```xml
<context-block id="hindsight-memory:abc" source="hindsight" authority="memory"
               reason="Recall for: refactor the queue dispatcher">
...
</context-block>
```

Trace: `sessionSetup` blocks appear in prompt-sections (free inspector win). Per-turn
`beforePrompt` blocks and all diagnostics (timeouts, skips, budget omissions) append to
`.bobbit/state/session-context-trace/<sessionId>.jsonl`, exposed at
`GET /api/sessions/:id/context-trace`.

### 5.3 Provider module contract

```ts
// lib/provider.mjs — runs on the Extension Host worker tier (trusted, confined)
export default {
  async sessionSetup(ctx)   { return { blocks: [...] }; },
  async beforePrompt(ctx)   { return { blocks: [...] }; },     // ctx.prompt, ctx.budget
  async afterTurn(ctx)      { /* fire-and-forget */ },
  async beforeCompact(ctx)  { /* flush */ },
  async sessionShutdown(ctx){ /* flush */ },
};
// ctx: { sessionId, projectId?, scope: "project" | "global", cwd, goalId?, roleName?,
//        prompt?, turn?, budget, config,            // values from providers/<id>.yaml config
//        runtime?: { baseUrl, headers, status },    // when bound to a runtime
//        store,                                     // pack-scoped KV (existing pack-store)
//        capabilities: { call(name, input) },       // §3.1
//        log }
```

Providers are trusted ambient code (fetch/fs available — consistent with routes.mjs). The host
validates *output* (schema, budget, fencing), not the code.

### 5.4 The provider-bridge pi extension

One Bobbit-generated extension per session (codegen modeled on
`generateToolGuardExtension`, `tool-guard-extension.ts:31`), wired in the same session-setup
step that writes the tool guard:

- `before_agent_start` → `POST /api/sessions/:id/provider-hooks/before-prompt` with the
  pending user input; the gateway runs `beforePrompt` across enabled providers (bounded), and
  the extension appends the returned fenced text via pi's systemPrompt/append mechanism. The
  gateway also refreshes the persisted prompt-sections snapshot so the inspector stays
  truthful per turn.
- `turn_end` → fire-and-forget `POST …/after-turn`.
- `session_before_compact` → blocking-with-timeout `POST …/before-compact`.
- `session_shutdown` → `POST …/shutdown`.

Auth and transport identical to the tool guard (`BOBBIT_GATEWAY_URL` + `BOBBIT_TOKEN`).

### 5.5 Claude-hook adapter mapping

The `hooks` entity registers command hooks onto the same Hub:

| Claude hook | Hub point | Semantics |
|---|---|---|
| `SessionStart` | `sessionSetup` | stdout `additionalContext` → ContextBlock |
| `UserPromptSubmit` | `beforePrompt` | stdout-injected context (matches Claude semantics) |
| `Stop` | `afterTurn` | notification |
| `PreCompact` | `beforeCompact` | notification |
| `SessionEnd` | `sessionShutdown` | notification |
| `PreToolUse` / `PostToolUse` | tool-guard generalization (P6) | block/mutate via the existing long-poll endpoint |

Spawned via `execFile`, JSON on stdin, timeout-bound, non-fatal.

---

## 6. Memory architecture — two tiers, one UX

The promise: **Bobbit gives the impression of infinite memory.** Two engines deliver it behind
one surface; neither is special-cased in core.

- **Tier 1 — `session-memory` (built-in pack, default-on, zero dependencies).** Uses the
  existing FlexSearch index and transcripts: `beforePrompt` queries BM25+recency over past
  sessions/goals/messages in the project and contributes top-K bounded "Relevant past work"
  blocks (each linking its source sessionId); `sessionSetup` recalls against the goal/task
  spec. Every Bobbit user gets automatic recall with no Docker, no service, no setup — and
  this pack is the litmus implementation that proves the provider API (P1).
- **Tier 2 — `hindsight` (pack, pre-installed dormant).** Semantic memory: consolidation,
  reflect, mental models, cross-session synthesis — the upgrade. Detailed in §11.
- **One UX.** Both emit the same ContextBlocks under one budget; provenance disambiguates in
  the inspector. Default priority: `hindsight > session-memory`; cross-engine dedupe is a P4
  refinement. The agent-facing story is simply: the agent remembers.

**Scope-awareness (designed in from day one).** Provider contexts carry
`scope: "project" | "global"`. Memory bank routing:

- Project sessions → bank `bobbit-proj-<projectId>` **and** a shared `bobbit-global` bank,
  recalled in parallel under one budget.
- The `hindsight_recall` tool and the panel accept `bank: current | global | all`
  (`all` = fan-out across banks).
- A future gateway-level "Mission Control" surface (global sessions/staff above projects —
  see §14) slots into `scope: "global"` without rework.

Retains are tagged `sessionId` / `goalId` / `roleName` so the panel can filter per
session/goal.

---

## 7. Managed runtimes

New core: `src/server/runtimes/pack-runtime-supervisor.ts`, mirroring the discipline of
`project-sandbox.ts` (DOCKER_BIN, execFile wrapper, MSYS env handling) and `sandbox-manager.ts`
(lazy idempotent `ensureRuntime(id)` with in-flight dedupe), plus the
supervise-an-HTTP-service flavor of `aigw-manager.ts`.

- **Compose project** `bobbit-pack-<name>` — stable across pack updates, so named volumes (and
  therefore data) survive updates; image digests pinned in the pack's compose file mean an
  update recreates the app container against the same volume.
- **Env/secrets**: generated `.env` (mode 0600) under `~/.bobbit/state/pack-runtimes/<pack>/`;
  `generate: true` secrets created with `crypto.randomBytes` on first start; values stored via
  `SecretsStore`; secrets never sent to panels (status only).
- **Ports**: `host: auto` allocates an ephemeral host port, persists it, re-validates on boot;
  the bound provider reads the resolved `baseUrl` from its ctx — never hardcodes.
- **Status machine**: `docker-unavailable | stopped | starting | running | unhealthy`, driven
  by the declared HTTP healthcheck.
- **REST**: `GET /api/pack-runtimes`, `POST /api/pack-runtimes/:id/{start|stop|restart}`,
  `GET /api/pack-runtimes/:id/logs?tail=`.
- **Lifecycle**: `startPolicy: on-enable` — and a pinned platform rule: **a pre-installed pack
  never starts containers without a deliberate user action.** Disable ⇒ `compose stop` (data
  kept). Uninstall ⇒ `compose down` with **volumes preserved by default**; an explicit
  "Delete data" confirmation runs `down -v` and removes the state dir. Reinstall reattaches
  existing volumes.
- **Fallback**: when Docker is unavailable, the runtime reports `docker-unavailable` and the
  consuming provider's `external` mode (user-supplied URL/key) is the first-class path, not an
  error state.

---

## 8. Trust & consent

Packs are **trusted code**. The platform inherits the Extension Host stance: worker confinement
is resource/crash isolation and import hygiene, not a security sandbox; pack tools and
pi-extensions run with ambient access in the agent process, as tools always have. What v2 adds
is **disclosure granularity and deliberate activation**:

1. **Capability summary at install/enable**, computed from the manifest: "runs code in the
   gateway" (providers/hooks), "runs code in the agent" (tools/pi-extensions — already true
   today, now stated), "connects MCP servers" (command/URL listed per server), "runs Docker
   services" (images, ports, volumes), "requests secrets" (names + prompts), "provides/requires
   capabilities". Shown inline on the install/enable card; no separate consent ceremony.
2. **Per-entity activation** — `pack_activation` covers all six new entity types. Disabling a
   provider unregisters its hooks synchronously (`invalidateResolverCaches()` + Hub
   re-resolve); disabling a runtime stops its containers.
3. **Hooks and pi-extensions need a one-time per-pack acknowledgment** (arbitrary commands on
   the gateway host / arbitrary code in the agent process), default-deny until acknowledged.
   Claude-converted packs additionally show the exact hook command lines.
4. **Memory consent posture** (owner decision): enabling a memory pack is the consent —
   auto-recall and auto-retain start at Enable, with the enable card disclosing inline what is
   stored (per-project bank), which model forms memories, and a cost note. Switching to
   `external` mode (content leaves the machine) shows a one-line notice. Per-project opt-out
   rides `pack_activation`.

---

## 9. Claude Code plugin compatibility

A **format adapter at install time**, not a parallel install system. The atomic-staging step in
`marketplace-install.ts` is the seam:

- `MarketplaceSourceStore` sources gain `format: "bobbit" | "claude-plugin"`, auto-detected at
  sync (presence of `.claude-plugin/marketplace.json`); browse lists plugins as packs.
- Install conversion into the staging dir:

| Claude plugin piece | Bobbit pack entity |
|---|---|
| `commands/*.md` | skills (the `commands-flat` layout already exists, `pack-list.ts`) |
| `skills/` | skills |
| `agents/*.md` | roles (frontmatter name/description/model → `Role{name, promptTemplate, model}`; tool restrictions best-effort → `toolPolicies`) |
| `hooks/hooks.json` | `hooks` entities (§5.5 mapping) |
| `.mcp.json` | `mcp` entities |
| `scripts/`, assets | copied verbatim; `${CLAUDE_PLUGIN_ROOT}` rewritten to the pack root |

- A `pack.yaml` (`schema: 2`) is synthesized; `.pack-meta.yaml` records
  `sourceFormat: claude-plugin`.
- **Unsupported features are reported, never silently dropped**: statusline, output styles,
  permission/sandbox settings, MCP transports `McpManager` can't handle → structured
  `skipped: [{feature, reason}]` in the install response, rendered in the UI.
- Full fidelity depends on the `mcp` (P5) and `hooks` (P6) phases; the adapter phase (P7) is
  sequenced after them to avoid shipping a degraded story.

---

## 10. Reference pack: `session-memory`

```
market-packs/session-memory/
  pack.yaml                # schema 2; contents.providers: [recall]
  providers/recall.yaml    # kind: memory; hooks: [sessionSetup, beforePrompt]; budget 1200/800ms
  lib/provider.mjs         # queries GET /api/search (or the search service via a host route)
  panels/ + entrypoints/   # optional: small "what was recalled" panel (can defer to inspector)
```

Behavior: `beforePrompt` → FlexSearch query from the user prompt (BM25 + recency, project
scope, archived included) → top-K results formatted as compact blocks with session links;
`sessionSetup` → recall keyed on goal/task spec. Deterministic, no LLM, no network beyond the
gateway. Ships in the built-in band, **default-on** (it only reads data Bobbit already has).
Config: K, budget, source types (sessions/goals/messages), include-archived.

This pack is also the platform's litmus: its tests pin the provider loader, Hub dispatch,
budget clamp, timeout-skip, provenance, and activation toggles against a real pack.

## 11. Reference pack: `hindsight`

```
market-packs/hindsight/
  pack.yaml                      # §4 example
  providers/memory.yaml          # hooks: sessionSetup, beforePrompt, afterTurn, beforeCompact, sessionShutdown
  runtimes/hindsight.yaml        # §4 example
  runtime/compose.yaml           # hindsight + pgvector postgres, digest-pinned
  tools/hindsight/
    hindsight_recall.yaml        # provider: { type: bobbit-extension, extension: extension.ts }
    hindsight_reflect.yaml
    hindsight_retain.yaml
    extension.ts                 # pi.registerTool ×3 → POST pack routes (tool-guard auth pattern)
  panels/hindsight-memory.yaml   # native panel
  entrypoints/hindsight-open.yaml, hindsight-route.yaml
  lib/provider.mjs, routes.mjs, HindsightPanel.js, hindsight-client.mjs   # one shared REST client
  src/                           # TS sources, built like the other market packs
```

- **Provider flow**: `sessionSetup` → recall vs goal/task spec → "Relevant memory" section;
  `beforePrompt` → recall vs user prompt (project-scoped + org-wide tag filters in one
  query, 1500ms timeout ⇒ skip); `afterTurn` → **async** retain of the turn, auto-tagged
  `project:/agent:/goal:/kind:` from session context (failures queue in the pack store,
  retried next turn); `beforeCompact` → synchronous retain of salient facts before context
  loss; `sessionShutdown` → flush.
- **Tools**: explicit `hindsight_recall` / `hindsight_reflect` / `hindsight_retain` for the
  model, with `scope: project | global | all` mapped to tag filters on the shared bank —
  NOT bank switching; Hindsight has no cross-bank search, which is why the topology is one
  shared tag-scoped bank (decision + verified facts:
  [agent-memory.md §3](agent-memory.md)). (Hindsight's own MCP server remains usable via
  normal MCP discovery, orthogonally.)
- **Panel** (native, same-origin): status + mode setup (managed vs external), memory search,
  recent retains, retain-queue/operations view, runtime health/logs links, settings (model for
  memory formation, budgets, toggles).
- **Modes**: `managed` (default when Docker present — Enable → supervisor up → healthy →
  works) | `external` (URL + API key). **Great defaults**: cheap memory-formation model
  preconfigured (reusing the user's existing configured key by default), generated Postgres
  password, sane recall budget — power users can change all of it, but nobody has to.
- **Distribution**: built-in first-party band, **dormant** until enabled (no containers, no
  hooks active).
- **Failure modes (all non-fatal)**: Docker absent → setup card offers external mode; service
  unhealthy/timeout → recall skipped + diagnostic in trace + status badge; retain failure →
  queued with counter in panel; provider crash → worker isolation, provider marked errored for
  the session.

---

## 12. Selectors & composition

The "something clever": after each prompt — or before creating a goal / spawning a session — a
selector decides which personas, workflows, skills, MCP servers, and models fit best. In this
platform, **selectors are themselves provider packs** (`kind: selector`), and the things they
select over are the existing stores.

- **Decision points**: `beforeGoalCreate`, `beforeSessionSpawn`, `beforePrompt` (selector
  flavor). The Hub hands selectors typed summaries — available roles (`RoleManager`), workflow
  templates + project workflows (`WorkflowManager`), skills catalog (`slash-skills`), MCP
  servers (`McpManager`), models (`model-registry`) — within an input budget.
- **Typed proposals, never mutation**:

```ts
interface SelectorProposal {
  role?:     { roleName: string; model?: string; thinkingLevel?: string;
               personaPatch?: string /* bounded, additive */; confidence: number; reason: string };
  workflow?: { action: "reuse" | "instantiate-template" | "ask-project-assistant";
               workflowId?: string; templateId?: string; confidence: number; reason: string };
  skills?:   { include: string[]; reason: string };
  mcp?:      { servers: string[]; reason: string };
  model?:    { model: string; thinkingLevel?: string; reason: string };
}
```

- **Approval policy (host-enforced)** — auto-apply when: the decision is pre-session/pre-goal,
  the selected role does not expand tool grants beyond the default, the model is
  available/not-more-expensive than policy allows, persona/AGENTS.md changes are additive and
  bounded, and confidence clears threshold. Otherwise ask the user (mid-session role/model
  change, tool expansion, new/cloned workflows, expensive optional steps, low confidence).
  Workflow *creation* always goes through the existing WorkflowManager APIs and user approval.
- **LLM-backed selectors**: strict-JSON schema output, hard timeout, deterministic fallback
  (invalid output ignored). The selector may call models via its own config or via the
  `model-selector` capability.
- **Capability composition (the model-selector example)**: a `model-selector` pack
  `provides: [model-selector]` — input `{task, spec, candidates, constraints}` → output
  `{model, thinkingLevel, reason}`. The persona selector, workflow templates, and verification
  steps all `requires: [model-selector]` and call it via `ctx.capabilities.call`.
- **Flagship composition — the `multi-model-delivery` pack**: roles
  (`planner` pinned to a frontier model at high thinking, `implementer` pinned to a cheap
  precise model, `qa` and `reviewer` pinned to independent strong models — each gate carrying
  the initial spec) + a workflow template wiring plan → implement → QA → review with a
  ralph-loop (re-run until green) step + `requires: [model-selector]` so stage models can be
  chosen dynamically per goal. Installing one pack gives a project a complete multi-model
  delivery pipeline; the selector offers it when a goal's prompt fits.

---

## 13. Phases

Each phase is one mission goal: independently shippable, master-green
(`npm run check`, `test:unit`, `test:e2e` at/above baseline), test-first per AGENTS.md (every
user-facing feature gets unit + browser E2E; real Docker only in `tests/manual-integration/`).

### P1 — Schema v2 + providers entity + Lifecycle Hub + `session-memory` pack
- **Outcome**: packs can ship lifecycle providers; Bobbit dispatches
  `sessionSetup/beforePrompt/afterTurn/beforeCompact/sessionShutdown` with budgets, fencing,
  and provenance; the built-in `session-memory` pack gives every user automatic recall of past
  work (the infinite-memory impression) with zero dependencies.
- **Scope**: `pack-types.ts` (+`"providers"`), `pack-manifest.ts` (schema 2 keys), new
  provider loader (pattern: `pack-contributions.ts`), `src/server/agent/lifecycle-hub.ts`,
  provider dispatch on the worker tier (pattern: `route-dispatcher.ts`), session-setup
  pipeline step + provider-bridge codegen (pattern: `tool-guard-extension.ts`),
  `system-prompt.ts` (`PromptParts.dynamicContext`), `server.ts`
  (`/api/sessions/:id/provider-hooks/*`, `/api/sessions/:id/context-trace`), Market UI
  provider listing + activation toggle, `market-packs/session-memory/`, plus a deterministic
  `provider-demo` fixture pack (loaded via `BOBBIT_BUILTIN_PACKS_DIR`) recording hook
  invocations to its pack store.
- **Acceptance**: manifest validation accepts/round-trips schema-2 `contents.providers`;
  budget clamp + timeout-skip + non-fatal failure pinned by unit tests; bridge codegen
  snapshot test; API E2E — session with provider-demo shows its block in prompt-sections with
  provenance, afterTurn recorded, disabled-via-activation ⇒ no block; session-memory E2E — a
  second session in a project recalls content from the first (block visible in inspector and
  in the outgoing prompt), toggle off ⇒ none; browser E2E — inspector renders the Dynamic
  Context section; Market UI toggle persists across reload.
- **Non-goals**: runtimes/Docker; Hindsight; selectors; mid-turn `context` mutation;
  hooks/mcp/pi-extensions/workflows entities.
- **Dependencies**: none.

### P2 — `hindsight` pack v1 (external-URL mode)
- **Outcome**: the Hindsight pack works end-to-end against a user-supplied Hindsight URL:
  scope-aware banks (project + global), auto-recall, async auto-retain with retry queue,
  the three tools, routes, and the native panel.
- **Scope**: `market-packs/hindsight/` (everything in §11 except the runtime),
  build-script entry, provider config surface.
- **Acceptance**: unit — bank-id derivation incl. global fan-out, block formatting/fencing,
  retain-queue retry (REST client mocked); API E2E against an **in-process stub Hindsight
  server** — sessionSetup + beforePrompt blocks injected, turn_end retains with correct bank +
  tags, stub down ⇒ session unaffected + diagnostic, `hindsight_recall` tool round-trips with
  `bank: all`; browser E2E — panel configures external URL, shows status, search returns stub
  results; per-project disable ⇒ no injection; persists across reload.
- **Non-goals**: managed Docker; mental-models UI; cross-engine dedupe.
- **Dependencies**: P1.

### P3 — Managed runtimes + Hindsight zero-step enable
- **Outcome**: `contents.runtimes` supported; the supervisor brings up Hindsight + Postgres
  with generated secrets, allocated port, and healthcheck; **Enable → working memory with no
  manual steps**; uninstall preserves data unless explicitly purged.
- **Scope**: runtimes entity (manifest/loader), `src/server/runtimes/pack-runtime-supervisor.ts`
  + runtime-manifest parser, REST endpoints, `.env`/secrets handling, uninstall hook in
  `marketplace-install.ts`, panel status/logs/start-stop wiring, `runtime/compose.yaml` in the
  pack.
- **Acceptance**: unit — manifest validation, port allocation/persistence, secret-generation
  idempotence, compose arg construction (execFile mocked), keep-vs-purge; API E2E — mocked
  docker binary walks stopped→starting→running on health 200; docker-unavailable surfaces the
  external-mode setup card path; browser E2E — runtime status card states + logs view
  (mocked); **manual-integration** (real Docker) — enable → compose up → healthy →
  recall/retain round-trip → disable stops; volume survives a pack update. Pinned platform
  rule: pre-installed band never auto-starts containers.
- **Non-goals**: arbitrary third-party runtime marketplace policy; Kubernetes; remote Docker.
- **Dependencies**: P1, P2.

### P4 — Memory depth & polish
- **Outcome**: compaction never loses memory-worthy content; users can browse/manage memories;
  the two memory tiers compose cleanly.
- **Scope**: beforeCompact sync-retain ordering (bridge + pack), memory-browser panel v2
  (browse/filter by session/goal, delete, retain-queue + operations view, reflect surface),
  hindsight↔session-memory priority/dedupe under the shared budget, cost surfacing for memory
  formation.
- **Acceptance**: API E2E — forced compaction triggers retain *before* compaction completes
  (stub asserts ordering); browser E2E — memory browser lists/filters/deletes and survives
  reload; unit — dedupe/priority under budget.
- **Non-goals**: mental-model auto-refresh scheduling; multi-bank admin UI.
- **Dependencies**: P2 (P3 for managed-mode paths).

### P5 — MCP as pack content
- **Outcome**: packs ship MCP server configs that flow into existing discovery, meta-tools,
  proxy extensions, and policy — with pack provenance and per-entity activation.
- **Scope**: lift `pack-manifest.ts:95-97` rejection for schema 2; `mcp` loader; a pack-sourced
  discovery band in `mcp-manager.ts` (below user configs — a pack must never shadow a user's
  own MCP config); conflict reporting; Market UI provenance badge; capability summary entry.
- **Acceptance**: unit — manifest + loader + precedence-vs-user-config; API E2E — pack-shipped
  MCP server produces meta-tools via the existing `writeMcpProxyExtensions` path and is
  removed on uninstall; browser E2E — pack-provenance badge in the tools UI.
- **Non-goals**: packs shipping MCP server *binaries*; new secret mechanisms for MCP.
- **Dependencies**: P1 (manifest plumbing precedent).

### P6 — Hooks + pi-extensions entities
- **Outcome**: packs ship Claude-style command hooks (mapped per §5.5, including
  PreToolUse/PostToolUse via a generalized tool-guard long-poll) and raw pi extension modules
  (added to the session `--extension` list) — both behind a one-time per-pack trust
  acknowledgment.
- **Scope**: `hooks` + `pi-extensions` loaders; hook dispatcher (execFile, JSON protocol,
  timeouts); tool-guard endpoint generalization; extension-list assembly in session setup;
  trust-grant store + consent UI.
- **Acceptance**: unit — hook mapping table, default-deny gate; API E2E — fixture pack's
  PreToolUse hook blocks a tool call; un-acknowledged pack contributes no hooks/extensions;
  browser E2E — acknowledgment flow, revoke works after reload.
- **Non-goals**: sandboxing claims; hook-driven prompt rewrites beyond the fenced path.
- **Dependencies**: P1.

### P7 — Claude Code plugin marketplace adapter
- **Outcome**: a Claude plugin marketplace adds as a source; its plugins browse and install as
  packs with full mapping (skills/commands/agents/hooks/mcp) and an explicit skipped-features
  report.
- **Scope**: format detection in source sync; `claude-plugin-adapter.ts` conversion at the
  staging seam; `${CLAUDE_PLUGIN_ROOT}` rewrite; UI source badge + skipped report rendering.
- **Acceptance**: unit — conversion mapping table incl. skip cases; API E2E — fixture plugin
  repo installs, skills resolve with correct precedence, hooks/mcp entities materialize;
  browser E2E — install a real public Claude marketplace plugin from the Market UI, slash
  command appears in the composer, skipped report shown.
- **Non-goals**: bidirectional export (Bobbit packs → Claude plugins).
- **Dependencies**: P5, P6 (full fidelity).

### P8 — Capability registry + selector framework
- **Outcome**: packs compose via `provides`/`requires` + `ctx.capabilities.call`; selector
  providers make validated, policy-gated proposals at `beforeGoalCreate` /
  `beforeSessionSpawn` / `beforePrompt`.
- **Scope**: manifest `provides`/`requires` + install-time dependency check; capability
  dispatch on the worker tier; Hub decision points wired into goal-creation and session-spawn
  paths; proposal types + approval policy (§12); proposal UI (accept/decline affordance);
  fixture selector pack.
- **Acceptance**: unit — registry resolution incl. precedence + missing-dependency warning;
  proposal validation (over-grant ⇒ requiresApproval; invalid JSON ⇒ deterministic fallback);
  API E2E — fixture selector proposes role+workflow at goal creation, auto-applies under safe
  policy, asks otherwise; browser E2E — proposal surfaced at goal creation, accept/decline
  round-trips.
- **Non-goals**: codegraph provider; mid-session automatic role changes.
- **Dependencies**: P1.

### P9 — Workflow-template entity + flagship selector packs
- **Outcome**: packs ship workflow templates; first-party `model-selector` capability pack and
  `multi-model-delivery` pack deliver the multi-model pipeline (frontier-model planning →
  cheap precise implementation → independent QA → independent review, ralph-loop) as a single
  install.
- **Scope**: `workflows` loader (templates → instantiation through existing
  `WorkflowManager`/`WorkflowStore` APIs at project setup or goal creation; project.yaml stays
  the source of truth; goal snapshotting unchanged); `market-packs/model-selector/`;
  `market-packs/multi-model-delivery/` (roles + template + `requires: [model-selector]`).
- **Acceptance**: unit — template instantiation + validation reuse (`workflow-validator`);
  API E2E — installing the pack offers the template, instantiation creates a valid project
  workflow, goal snapshot carries stage roles with pinned models, selector swaps a stage model
  via the capability; browser E2E — template offered in goal-creation UI; per-gate role/model
  visible.
- **Non-goals**: workflow auto-creation by LLM without approval; cross-project workflow sync.
- **Dependencies**: P8.

---

## 14. Later (recorded, not goals)

- **Mission Control as an extension** — global sessions/staff above projects ("talk to the
  gateway before/instead of a project"). Needs one core enabler: a gateway-level pseudo-scope
  for sessions/staff plus cross-project service APIs (search-all-projects, spawn-goal-in-
  project). The memory architecture is already global-ready (`scope: "global"`, the
  `bobbit-global` bank, `bank: all` fan-out); the surface itself (panel + routes + tools) fits
  the Extension Host. Sketch only; not a phase.
- Codegraph/LSP context provider; `POST /api/context/compile-preview`; mid-turn pi `context`
  message mutation; dynamic `setActiveTools` selection; `before_provider_request` telemetry;
  per-conflict capability pinning. The ContextBlock schema keeps
  `reason/priority/authority/tokenEstimate` so these slot in without breaking changes.

## 15. Risks & open questions

1. **Docker availability/Windows**: Docker Desktop/WSL2; `docker compose` v2 vs legacy
   binary detection; MSYS path handling (reuse `project-sandbox.ts` discipline). External mode
   must remain a first-class path, not an error state.
2. **Hindsight OCI images**: confirm a pullable, digest-pinned image (amd64+arm64). If none is
   published, the pack needs a build step — decide before P3.
3. **Memory-formation LLM key**: default = reuse the user's configured key with a cheap model
   (zero-step), documented on the enable card with a cost note. A separate-key option exists
   in settings. Trade-off: memory ops bill to the main key.
4. **beforePrompt latency**: up to `timeoutMs` (1500ms default) added per turn when memory is
   enabled. Mitigations: timeout-skip (pinned), prompt-hash recall cache, prefetch-at-turn-end
   for the next turn. Measure in P2 and record the budget.
5. **Ports & multi-server**: persisted auto-allocated ports must re-validate on boot; two
   Bobbit servers on one machine sharing a compose project name need a server-identity suffix —
   decide in P3.
6. **Postgres migrations on pack update**: minor updates ride volume persistence + app-run
   migrations; a schema-breaking Hindsight update needs a documented path (backup-before-
   update?). Open.
7. **Secrets at rest**: 0600 `.env` + `SecretsStore`; no OS keychain in v1. Threat model:
   localhost-bound ports + bearer keys; document it.
8. **Bank lifecycle**: project deletion → prompt to delete the bank (default keep); projectId
   reuse across servers sharing one Hindsight could collide — consider a server-salt in the
   bank id.
9. **CI has no Docker**: the stub-Hindsight E2E is the real gate; managed-mode regressions
   surface only in `tests/manual-integration/` — consider a scheduled weekly manual run.
10. **Schema-v2 on v1 servers**: silent degradation (new keys ignored). v2 servers warn on
    newer-than-supported `schema`; packs requiring v2 should say so in `description`.
11. **Selector trust creep**: selectors must stay proposal-only; the approval policy is the
    single enforcement point — pin it with tests (over-grant ⇒ approval required) before any
    selector pack ships.
12. **Token estimation**: the ~4 chars/token heuristic (already used by `PromptSection.tokens`)
    is approximate; fine for budgeting, recorded as a known approximation.
