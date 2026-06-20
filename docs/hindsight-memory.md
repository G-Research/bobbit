# Hindsight memory pack (external mode)

Bobbit ships a built-in [first-party pack](marketplace.md#built-in-first-party-packs) named
**`hindsight`** that gives agents persistent, cross-session **memory** backed by a running
Hindsight instance (an external memory/recall service you host yourself). It is the first production
[lifecycle provider](lifecycle-hub.md): instead of every session starting cold, the provider
**recalls** relevant past memories into the prompt and **retains** a compact summary of each turn,
so knowledge accrues across goals, sessions, and (optionally) projects.

This page documents how the pack behaves and how to turn it on. The implementation blueprint —
exact request/response body mapping, the test plan, and the host-side seams it depends on — lives
in [docs/design/hindsight-pack-external.md](design/hindsight-pack-external.md), whose §7 also
covers the topology rationale (one shared bank, tag-scoped) summarised under
[Bank & tag taxonomy](#bank--tag-taxonomy) below.

> **Scope.** This page documents the **external mode** data plane — you point the pack at a
> Hindsight URL you already run. The **managed Docker/Postgres runtime** (deployment modes
> `managed` and `managed-external-postgres`, explicit-consent start, disable/uninstall/purge, and
> `ctx.runtime` injection) now ships as **P3** and is documented in
> [managed-runtimes.md — P3](managed-runtimes.md#p3--deployment-modes-consent--lifecycle). The
> explicit `hindsight_recall/retain/reflect` agent tools now ship as **P5** — see
> [Agent tools](#agent-tools). The current **setup and dashboard UX** (Marketplace configuration,
> guided setup walkthrough, the stale-form fix, `uiUrl`, and embedded dashboard entrypoints) ships
> as the **UX polish** pass — see [Setup UX](#setup-ux--marketplace-front-door-state-model--guided-setup),
> [Embedded Dashboard Tab](#embedded-dashboard-tab), and the design spec
> [docs/design/hindsight-ux-polish.md](design/hindsight-ux-polish.md). The reflect UI and
> cross-engine dedupe remain **out of scope** — see [Non-goals](#non-goals).

## Installed but dormant by default

The pack is in the built-in band, so it is **present and active by default** on a fresh install —
but it does **nothing** until a Hindsight URL is configured. This is a hard, tested guarantee, not
a soft default:

- The provider declares `activation.requiresConfig: [externalUrl]` in
  `providers/memory.yaml`. The host omits the provider entirely from
  `listProviders(projectId)` until the effective config has a **non-empty `externalUrl`**.
- Consequently, on an unconfigured install there is **no active provider**: no provider-bridge
  pi extension is spawned, no per-turn `/provider-hooks/*` calls are made, the assembled
  system-prompt text is **byte-identical** to a no-pack baseline, and **no Hindsight network is
  touched**.
- The provider also re-checks the same gate defensively at runtime (`isActive(cfg)` in
  `market-packs/hindsight/src/shared.ts`): unless `mode === "external"` **and** `externalUrl` is a
  non-empty string, every hook returns immediately (`{ blocks: [] }` for recall hooks, a no-op for
  retain hooks) and constructs no client.

**Why dormant-by-default?** Memory is only useful if a backing store exists, and Bobbit must never
make outbound calls or change prompts for users who have not opted in. Shipping the pack dormant
means the feature is one config field away without imposing any cost — latency, network, or prompt
drift — on everyone else.

Like any first-party pack, you can also fully **disable** it from the Market UI; disabling is the
only opt-out (there is no uninstall for built-in packs). See
[built-in first-party packs](marketplace.md#built-in-first-party-packs).

## Turning it on

The **Marketplace** is the single, authoritative home for configuring Hindsight. Setting up or reconfiguring the memory pack (deployment mode, URLs, bank, scope, and toggles) happens strictly through the inline **Configure** form or the guided wizard in the Marketplace's `hindsight` pack row.

The configuration form is simple: set the deployment mode and the required URLs (such as `externalUrl` for external mode) and Save. Under the hood, the Marketplace configuration writes through the `config` pack route (see [Pack routes](#pack-routes)), so it can also be driven programmatically. Once the effective configuration is valid, the provider activates on the next session spawn to start automatically recalling and retaining.

In contrast, the session-menu entry (**Hindsight Memory**) and the `#/ext/hindsight` deep link (route) are used for **using, viewing, and querying** memory within the app (see [Embedded Dashboard Tab](#embedded-dashboard-tab)), not for configuration.

> Earlier the only non-test way to configure the pack was seeding the pack store directly. With P4
> the panel + `config` route are the user-facing path; **store-seeding is now a test-only seam**
> (used by the E2E `seedConfig` helper), not a documented configuration mechanism.

### Configuration keys

The config surface is declared in `market-packs/hindsight/providers/memory.yaml` and mirrored as
flat defaults in `market-packs/hindsight/src/shared.ts` (`CONFIG_DEFAULTS`). Store overrides are
overlaid on these defaults by the loader, so `ctx.config` is the single source of truth the
provider reads.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mode` | enum `external` \| `managed` \| `managed-external-postgres` | `external` | Deployment mode. `external` is documented here; the two managed modes start a Docker runtime — see [managed-runtimes.md — P3](managed-runtimes.md#p3--deployment-modes-consent--lifecycle). Only `external` activates via `externalUrl`; managed modes activate via `activeWhenConfig`. |
| `externalUrl` | string (optional) | — | Base URL of your running Hindsight **data-plane API** (external mode) — where Bobbit reads and writes memory. **Empty ⇒ dormant** in external mode. This is the single field that switches the external pack on. AJ's local example: `http://localhost:9177`. See [API URL vs UI/dashboard URL](#api-url-vs-uidashboard-url). |
| `uiUrl` | string (optional) | — | Optional, **non-secret** human-facing Hindsight **dashboard** URL. Display-only — it is used for the in-app embedded dashboard and is **never dialed by the client** and **never** influences activation/dormancy (those stay keyed on `externalUrl`). Never fabricated from `externalUrl` (different port/path). AJ's local example: `http://localhost:19177/banks/hermes?view=data`. Validated as an http(s) URL; `""` clears it. |
| `apiKey` | secret (optional) | — | Bearer token. Sent as `Authorization: Bearer <apiKey>` **only when set**; never echoed back (the `config` GET surface collapses it to a boolean `apiKeySet`). Also forms `ctx.runtime.headers` for the managed API. |
| `llmApiKey` / `externalDatabaseUrl` / `dataDir` | secret / secret / string | — / — / `~/.hindsight` | **Managed-mode only.** `llmApiKey` → `HINDSIGHT_API_LLM_API_KEY`, `externalDatabaseUrl` → `HINDSIGHT_API_DATABASE_URL` (redacted to `*Set` booleans on the GET surface), `dataDir` is the managed-Postgres bind path. See [managed-runtimes.md — P3](managed-runtimes.md#secrets--config-mapping). |
| `bank` | string | `bobbit` | The shared memory bank id (see [Bank & tag taxonomy](#bank--tag-taxonomy)). |
| `namespace` | string | `default` | Hindsight namespace path segment. |
| `recallScope` | enum `project` \| `all` | `project` | Default recall scope. `project` adds a `project:<id>` tag filter with `tagsMatch` (project + global memories); `all` recalls across the whole bank (cross-project). |
| `tagsMatch` | enum `any` \| `any_strict` | `any` | Scope filter strategy for `project` scope. `any` includes both project-specific AND global/shared memories. `any_strict` excludes global memories, enforcing hard project-only isolation. |
| `autoRecall` | boolean | `true` | When false, the recall hooks contribute no blocks. |
| `autoRetain` | boolean | `true` | When false, the retain hooks store nothing. |
| `retainEveryNTurns` | number | `5` | Cadence for background memory extraction. Bobbit runs an expensive LLM extraction once every N turns to optimize cost. |
| `retainMaxDelayMs` | number | `1800000` | Hook-observed timeout in milliseconds (30m) to flush buffered turns, preventing memories from staling in long-running or inactive sessions. `0` disables time-based flush. |
| `retainOverlapTurns` | number | `2` | Number of previous turn summaries to carry forward as bounded context/overlap into the next batch. |
| `recallBudget` | number | `1200` | Token budget passed as `max_tokens` to recall (bounds the upstream payload; host-side budgeting still applies). |
| `recallTypes` | array of `observation` \| `world` \| `experience` | `["observation", "world", "experience"]` | Filters memory recall to bias toward consolidated/stable knowledge over Turn chatter. |
| `retainMission` | string | (Defaults to detailed guideline) | Prompt mission guiding Hindsight's extraction logic on what durable knowledge to keep and what noise to ignore. |
| `observationsMission` | string | (Defaults to detailed guideline) | Prompt mission guiding Hindsight on how to consolidate observations. |
| `reflectMission` | string | (Defaults to detailed guideline) | Prompt mission guiding Hindsight's synthesis/reflection logic. |
| `recallMaxInputChars` | number | `3000` | Truncates recall query text to prevent Hindsight backend 400 "Query too long" errors (max 500 tokens). |
| `timeoutMs` | number | `1500` | Per-request abort budget for the REST client. |

The `config` route validates overrides against this schema before persisting; an empty string
clears an optional string (`externalUrl`/`apiKey`), and numeric keys must be positive.

#### Per-Project Config Overrides & Precedence

To balance unified global knowledge with project-specific control, Bobbit supports cascading configuration. Overrides resolve with the following precedence (highest to lowest):

1. **Per-Project Config Overlay** (persisted in the pack store under a per-project key)
2. **Server-Global Config** (configured globally via panel / store)
3. **Defaults** (`CONFIG_DEFAULTS` / YAML definition)

Only safe, **memory-quality** keys are overrideable per-project:
- `recallScope`
- `bank`
- `tagsMatch`
- `recallBudget`
- `recallTypes`

**Hard Server-Global Lock:** A project overlay can *never* override system-level or infrastructure config keys. The deployment `mode`, `externalUrl`, `uiUrl`, and secrets (`apiKey`, `llmApiKey`, `externalDatabaseUrl`, `dataDir`) are strictly locked to the server-global config to prevent security and configuration drift.

**Inherit & Clear Behavior:** Any overridden key set to an empty value (`null` or `""`) is omitted from the project overlay, causing it to transparently inherit from the server-global config.

**Marketplace Config Hydration:** The Marketplace global config form hydrates strictly from `globalConfig` (the un-overlaid, server-global settings). This ensures that any active per-project override does not masquerade as a global setting, preventing it from being accidentally written back globally during save. The effective, overlaid configuration is reserved exclusively for the runtime status/summary rendering and session execution.

## Bank & tag taxonomy

**One shared, tag-scoped bank.** All Bobbit memory lives in a single Hindsight bank, id from
`config.bank` (default **`bobbit`**) in namespace `config.namespace` (default **`default`**).
Multiple Bobbit instances pointed at one Hindsight **share** the `bobbit` bank by default; isolate
them only by configuring a different bank id.

**Why one bank instead of per-project banks?** Hindsight banks are isolated and cross-bank search
is unsupported — you can only recall within a single bank. A per-project bank fan-out would make
the headline value prop ("have we solved this anywhere before?") impossible as one native query.
So Bobbit uses **one bank + tags**: scope is expressed as recall-time tag filters, not as separate
banks. Full rationale: [docs/design/hindsight-pack-external.md §7](design/hindsight-pack-external.md).

**Auto-tags on retain.** The agent never hand-tags; the provider derives tags from the hook
context and flattens them to Hindsight's `string[]` item tags as `"<key>:<value>"`:

| Tag | Source | Notes |
|---|---|---|
| `project:<projectId>` | `ctx.projectId` | Omitted when there is no project (global/server-scope session). |
| `goal:<goalId>` | `ctx.goalId` | |
| `agent:<roleName>` | `ctx.roleName` | The contributing agent's role. |
| `session:<sessionId>` | `ctx.sessionId` | |
| `kind:turn` / `kind:compaction` | derived | `turn` for `afterTurn`, `compaction` for `beforeCompact`. The `retain` pack route tags manual writes `kind:manual`. |

**Recall scope.**

- `project` (default) — add a `project:<projectId>` tag filter. Under default project scope with no extra tags, the query continues to use the configured `tagsMatch` (which defaults to `"any"`).
  - Under `"any"`, the query fetches project-tagged **plus** untagged/global memories, excluding only memories tagged for other projects.
  - Under `"any_strict"`, untagged/global memories are excluded, enforcing hard project isolation.
  The filter is applied only when the session is associated with a real project ID; a global/server-scope session continues to recall globally.
- `all` — recall across the entire bank with no project filter. This allows cross-project semantic queries like "how did we set up the database in project X?" to surface knowledge across the entire installation.

Recall, `reflect`, and the agent tools all route this scope→tag decision through one shared
`recallTagFilter(scope, projectId, tagsMatch, extraTags)` helper (`market-packs/hindsight/src/shared.ts`),
so every read path resolves project scope identically.

**Extra tags and narrowing semantics:**
When optional flat `extraTags` are supplied to the helper (e.g., via the agent tools under project scope), they **narrow** results rather than broadening them. The helper overrides `tagsMatch` to `"all_strict"` (requiring all specified tags). Thus, the query matches the current project tag **plus** every extra tag, while strictly excluding untagged/global memories and other-project memories that happen to share that extra tag.
Furthermore, the route-derived project ID is authoritative: any caller-supplied `project` key inside the `extraTags` is completely ignored and dropped under project scope to prevent callers from overriding the active project scope.

The provider calls the idempotent `client.ensureBank(bank)` before each retain path, so
correctness never depends on once-per-session in-memory state (provider workers are per-hook and
stateless).

## Retain Hygiene & Cost Levers

Memory extraction is highly valuable but historically expensive, as running LLM-based fact-extraction on every turn drives up token consumption and host load. Bobbit implements several robust levers to keep memory high-signal and extremely cost-efficient:

### 1. Bank Missions (Durable Knowledge Steering)
Hindsight uses explicit prompts to guide memory extraction, observation consolidation, and reflection. Bobbit configures these to actively filter out transient developer noise and steer the engine toward lasting, reusable engineering knowledge:
- **`retainMission`**: Directs extraction to capture user and team preferences, architecture choices, standards, conventions, and stable project decisions. It explicitly discards ephemeral chatter, greetings, timestamps, PIDs, stack traces, and failed CLI runs.
- **`observationsMission`**: Tells Hindsight to consolidate recurring facts into general, stable, reusable statements rather than maintaining a noisy timeline of turn histories.
- **`reflectMission`**: Directs the reflection synthesizer to ground its answers in consolidated observations and documented decisions, ignoring short-term conversational noise.

These are applied idempotently to the Hindsight bank config API. A signature of the current missions is cached in the pack store, avoiding redundant PATCH calls on every turn.

### 2. Batched Retain Cadence
- **Durable Per-Session Pending Buffer**: Instead of running an expensive LLM extraction request on *every* turn, Bobbit holds turn summaries in a durable `PendingBuffer` JSON structure inside the pack-scoped store. Because provider workers terminate after every hook invocation, this state is saved to disk per session, ensuring that all conversations are processed linearly without memory loss (never randomly sampled).
- **`retainEveryNTurns` (default: 5)**: A full LLM extraction is run only once every `N` primary turns. At the default of $N=5$, this yields an immediate **80% reduction in routine extraction LLM calls** and associated token costs.
- **`retainMaxDelayMs` (default: 1,800,000 ms / 30 minutes)**: To prevent memories from staling in long-running or inactive sessions, this threshold acts as a max delay timeout to trigger an aggregate flush.
  - *Hook-Observed evaluation*: This timer is **not** an exact system-level idle sweeper or background thread interval. Instead, it is evaluated defensively per session on the invocation of provider hooks (such as `afterTurn`), by checking whether the oldest pending turn in the buffer has aged past `retainMaxDelayMs` relative to the current timestamp.
- **Aggregate Flush Semantics**:
  - *Triggering*: An aggregate flush occurs when the count of pending primary turns reaches `retainEveryNTurns` OR the age of the oldest pending turn exceeds `retainMaxDelayMs`.
  - *Content Composition*: The aggregate content joins any carried-forward overlap context from the previous flush (`Earlier context (overlap):` followed by the summaries) with the pending primary turns, separated by the aggregate separator.
  - *Durable Queueing on Failure*: If the aggregate retain request fails (e.g. network timeout or backend unavailability), the entire built aggregate is enqueued to the durable retry queue so it is never dropped, and a non-fatal error is logged.
  - *Buffer Advancement*: In both success and failure cases, the buffer is immediately advanced: the primary turns are cleared (so the turn count resets and advances), and the last `retainOverlapTurns` summaries of the primary turns are carried forward as a bounded `overlap` context for the next batch. Carrying forward only the primary summaries prevents previous overlaps from accumulating indefinitely.
- **`retainOverlapTurns` (default: 2)**: Preserves overlapping turn context at batch boundaries, carrying forward the last `K` summaries of the primary turns as bounded context to maintain thread continuity.
- **Compaction Safety (`beforeCompact`)**: Before the gateway compacts a session's history and discards the oldest context, the provider intercepts this event via `beforeCompact` to guarantee zero context loss:
  - *Synchronous Flush*: It first performs a **synchronous flush/retain** (`sync: true`) of any pending turns currently held in the session buffer to ensure they land in Hindsight before context is pruned.
  - *Synchronous Retain*: It then performs a **synchronous, batch-exempt retain** (`sync: true`, "compaction" kind) of the compaction summary itself, ensuring the about-to-be-lost history span is durably written to Hindsight.
- **Session Shutdown**: On `sessionShutdown`, Bobbit performs a best-effort best-practice:
  - First, it flushes any remaining buffered turns (`flushPending`, `sync: false`) to Hindsight.
  - Then, it triggers a **one-pass full drain** (`drainQueueAll`) of the durable retry queue to flush any remaining unsaved items.

## Provider lifecycle behaviour

The provider implements the five [Lifecycle Hub](lifecycle-hub.md) hooks. It runs on the Extension
Host worker tier, reads merged config from `ctx.config`, builds a REST client per hook, and keeps
all durable state in the pack-scoped `ctx.host.store`. Every Hindsight condition is **non-fatal**:
a slow or unhealthy backend never blocks or fails a session — recalls skip and retains queue.

| Hook | Behaviour |
|---|---|
| `sessionSetup` | If `autoRecall`: recall against the goal/task spec (`ctx.prompt`) and inject the results as a **"Relevant memory"** context block (`authority: "memory"`). On error/timeout ⇒ no block + a diagnostic. |
| `beforePrompt` | If `autoRecall`: recall against the current user turn (`ctx.prompt`) under the provider `timeoutMs` deadline; skip on timeout (non-fatal). Same block mapping. |
| `afterTurn` | If `autoRetain`: build a compact turn summary (user + final assistant text, capped ~2000 chars), append to the pending buffer, and trigger a batched flush as an async aggregate retain if the turn count or max delay limits are exceeded. Also drains one [retry-queue](#retry-queue--diagnostics) head per call. |
| `beforeCompact` | If `autoRetain`: synchronously flush any pending buffered turns. Then, build and synchronously retain a compaction summary of the about-to-be-lost span (batch-exempt) so all memory lands in Hindsight before context is pruned. Failure ⇒ enqueue. |
| `sessionShutdown` | If `autoRetain`: flush any remaining buffered turns, then perform a best-effort **one-pass** drain of the retry queue. Never throws. |

The recall hooks return `ContextBlock[]` only — **fencing and `providerId` are the host's job**
(see [Lifecycle Hub → fencing](lifecycle-hub.md#fencing)). Each block is titled "Relevant memory",
`authority: "memory"`, `priority: 50`, with `content` a bulleted list of recalled memory text. An
empty recall produces no block.

### Retry queue & diagnostics

A retain that fails (network/timeout/HTTP) is **not lost**. The provider appends
`{ content, tags, ts, bank, namespace }` to a durable queue in the pack store (key `retain-queue`):

- **Cap 100** — appending past 100 entries drops the oldest (FIFO eviction).
- **Target Routing** — queue entries include the original target `bank` and `namespace` at the time of the failure, ensuring that retry attempts are routed back to their correct destination even if the current session config has since changed. Legacy queue entries that lack these fields transparently fall back to using the active, currently-configured bank and namespace.
- **Drain on `afterTurn`** — each turn retries the **queue head** (one entry) before doing the
  turn's own retain; success removes it, failure leaves it.
- **Drain on `sessionShutdown`** — one best-effort full pass.

The queue is durable (not in-memory) precisely because provider workers terminate after every hook
invocation, so an in-memory queue would lose everything between turns. Recall skips, retain
failures, and health flips are recorded as non-fatal diagnostics (`last-error` in the store and the
Hub's [context-trace](lifecycle-hub.md#the-trace-store)), and the queue depth is surfaced by the
`status` route.

## Pack routes

The pack ships server routes (`market-packs/hindsight/src/routes.ts`, declared in `pack.yaml`
under `routes.names`) for diagnostics and config persistence, reached via
`host.callRoute(<name>)` and executed in the confined worker. They share the **same pack-scoped
store** as the provider, so `status` observes the provider's real queue and last error. When the
pack is not configured, every route returns a clean structured signal (`configured: false` / empty
list) rather than erroring.

| Route | Contract |
|---|---|
| `config` | GET → merged effective config with secrets redacted (`apiKey` collapsed to `apiKeySet`). SET (with body) → validate against the schema, persist overrides to the pack store, return the new effective config. |
| `status` | `{ configured, mode, healthy, bank, namespace, recallScope, autoRecall, autoRetain, queueDepth, externalUrl, uiUrl, timeoutMs, recallBudget, lastError? }`. `healthy` is a fresh `client.health()` probe when configured (short timeout), else `false`. `queueDepth` is the retry-queue length. The trailing `externalUrl`/`uiUrl`/`timeoutMs`/`recallBudget` fields are **additive** (UX-polish) so the panel and Marketplace can render the [active configured values](#active-configured-values-surfaced) without a second round-trip; both URLs are **non-secret** and secrets are still never echoed. `lastError` is persisted as a `{ message, ts }` object, so consumers must read `.message` (rendering the object raw yields `[object Object]`). |
| `recall` | `{ query, scope?, tags? }` → resolves bank + tags (via `recallTagFilter(scope, projectId, tagsMatch, tags)`) and calls `client.recall`; returns `{ memories }`. Manual/diagnostic surface. |
| `retain` | `{ content, tags?, sync?, scope? }` → `ensureBank` + `client.retain` with merged auto-tags; `scope: project` (with a real project id) adds a `project:<id>` tag. The `kind:manual` marker is spread **last** so user/scope tags can't override it. Returns `{ ok }`. |
| `reflect` | `{ prompt, scope?, tags? }` → `client.reflect` with the same `recallTagFilter(scope, projectId, tagsMatch, tags)` scope mapping as `recall`; returns `{ text }`. |
| `banks` | Diagnostic: `client.listBanks()` → `{ banks }`. The pack itself uses one bank. |

## Agent tools

The pack ships three **agent tools** (Extension Platform **P5**) that give an agent explicit,
on-demand access to memory — complementing the automatic recall/retain the [provider](#provider-lifecycle-behaviour)
does every turn. Where the provider is implicit ("inject relevant memory into the prompt"), these
tools are deliberate: the agent decides *when* to look something up, write something down, or ask
for a synthesized answer.

| Tool | Purpose | Parameters | Output |
|---|---|---|---|
| `hindsight_recall` | Fetch durable memories matching a query before acting. | `query` (required), `scope?` (`project`\|`all`), `tags?` (simple map) | A numbered list of memory texts, plus the structured route result (`memories`, `count`, `configured`) under `details`. Empty recall ⇒ "No relevant memories found." |
| `hindsight_retain` | Durably record a decision, preference, or fact. | `content` (required), `scope?`, `tags?` (extra key/value, additive), `sync?` (wait for durability; default `false`) | "Memory retained." on success; an error result otherwise. The route auto-applies a `kind:manual` tag. |
| `hindsight_reflect` | Get a synthesized answer drawing on accumulated memory, not a raw list. | `prompt` (required), `scope?`, `tags?` (simple map) | The synthesized text. Empty reflection ⇒ "(no reflection produced)". |

These tools live in `market-packs/hindsight/tools/hindsight/` (`extension.ts` plus one descriptor
YAML per tool); each descriptor declares `provider: { type: bobbit-extension, extension: extension.ts }`.

**Pack-owned — disabling the pack removes them.** The tools are contributed by the pack
(`pack.yaml` `contents.tools: [hindsight]`), so they appear in a session's tool list only while the
pack is enabled. Disabling the pack (or just its tools) at any scope removes them from tool
resolution for sessions created afterward, and the activation gate is closed end-to-end: a disabled
tool no longer resolves as a market-pack tool, so it cannot even mint a surface token. This is the
same disable mechanism as any [first-party pack](marketplace.md#built-in-first-party-packs).

**They never call Hindsight directly — they go through the pack routes.** The agent surface is
deliberately thin. Each tool invocation does exactly two authenticated gateway calls:

1. `POST /api/ext/surface-token` `{ sessionId, tool }` — mint a **tool-bound** surface token
   (the [tool-guard](#pack-routes) checks the tool is in `allowedTools`, belongs to the calling
   session, and resolves to a market pack). The server derives `{ packId, tool }` from the minted
   token, so the route body never carries a pack id.
2. `POST /api/ext/route/<recall|retain|reflect>` with the minted `surfaceToken` — dispatch the
   pack's own [route](#pack-routes) in the confined worker.

The route — not the tool — owns config merge, bank resolution (the single shared bank, default
`bobbit`), external/managed-mode handling, dormancy, and the scope→tag mapping. **Why route the
tools through the pack routes instead of letting them talk to Hindsight?** It keeps a single
authorization path (surface-token + tool-guard) and a single source of truth for bank/scope/config
behaviour, so the agent tools, the panel's manual search, and the provider all resolve memory the
same way. A dormant (unconfigured) Hindsight yields a clean signal — recall/reflect return empty,
retain returns a not-configured error — never a crash.

### `scope` & `tags` → tags on the shared bank

All three tools accept `scope: project | all` (defaulting to the configured `recallScope`, which is now `project`) and an optional flat `tags` map parameter (e.g., `{goal: "implement-auth"}`).

**Scope is a tag filter on the single shared bank (`config.bank`, default `bobbit`) — never a different bank.**

- `recall` / `reflect` — under `project` scope with no extra tags, this adds a `project:<id>` tag filter and resolves using the configured `tagsMatch` (default `"any"`, fetching project-tagged **plus** untagged/global memories, excluding other projects — see [Recall scope](#bank--tag-taxonomy)). When optional extra `tags` are supplied under `project` scope, they **narrow** results with strict `all_strict` semantics (matching the current project tag AND every extra tag, while excluding untagged/global and other-project memories sharing that extra tag). Any caller-supplied `tags.project` value is completely ignored and dropped; the route-derived current project ID is authoritative and cannot be overridden. Under `all` scope, no project tag filter is added, but optional extra `tags` are still applied additively (matching via `"any"`).
- `retain` — `project` adds a `project:<id>` tag (again only with a real project id) alongside the auto `kind:manual` tag; `all` leaves the memory unscoped on the shared bank. User-supplied `tags` are additive and never change the bank. The `kind:manual` provenance marker is spread **last**, so a user-supplied `tags: { kind: "..." }` can never override it.

A configured custom `bank` (or `namespace`) flows through every tool to Hindsight unchanged — the scope→tag mapping is orthogonal to which bank is configured. This mirrors the provider's [bank & tag taxonomy](#bank--tag-taxonomy): scope is *always* expressed as tags on one bank, never as bank fan-out.

**No `tag_groups` DSL in Tools:** To keep the tool descriptions compact, budget-compliant, and simple for agents to use reliably, the complex `tag_groups` Boolean tree (AND/OR query tree) is **never** exposed to agent tools.

**Power-User Escape Hatch (Direct API):** For complex, compound Boolean filters (e.g. searching memories matching `(project:A OR project:B) AND kind:decision`), clients should bypass the agent tools and call the direct Hindsight data-plane API (`POST /v1/{namespace}/banks/{bank}/memories/recall` with the full `tag_groups` body).

API E2E coverage lives in `tests/e2e/hindsight-agent-tools.spec.ts` (reusing the shared
`tests/e2e/hindsight-stub.mjs`): it drives the real surface-token + route round-trip for each tool,
asserts the scope→tag mapping and default/custom bank routing on the stub, confirms the three tools
resolve for a project session, and that disabling the pack tools removes them from a newly-created
session's tool list (and closes the surface-token mint with a 403).

## Embedded Dashboard Tab

The **Hindsight** extension entrypoints are designed for **using, viewing, and querying** memory within the app. Clicking the session-menu entry (**Hindsight Memory**) or navigating to the `#/ext/hindsight` route opens the **live Hindsight dashboard embedded directly as an in-app Bobbit tab/panel** so the user can inspect and search the memory bank without leaving Bobbit.

This is implemented by rendering the configured `uiUrl` in a **sandboxed iframe** inside a first-class side-panel/tab, reusing Bobbit's pack-panel or iframe infrastructure. Because the local Hindsight dashboard runs without frame-protection headers (no local `X-Frame-Options` or Content Security Policy blocking), it embeds cleanly and securely.

### Entrypoints & Navigation

Two entrypoints open this **embedded dashboard tab**, declared under `market-packs/hindsight/entrypoints/` and listed in `pack.yaml` under `contents.entrypoints`:

| Entrypoint | Kind | How to reach it |
|---|---|---|
| `hindsight-session-menu` | `session-menu` | A launcher labelled **Hindsight Memory** in the session actions overflow menu, sitting next to **PR Walkthrough**. Its target is a `PanelTarget` (no `action: spawn`), which loads the embedded dashboard iframe for the configured `uiUrl` within the active/owner session. |
| `hindsight-route` | `route` (`routeId: hindsight`) | Deep link **`#/ext/hindsight`**. Opens the embedded dashboard tab directly, rehydrating the view from the routes. |

### Failure Paths & Safe Fallbacks

The embedded dashboard tab is robust against misconfiguration or environment failures:
- **Unset `uiUrl`**: If the `uiUrl` setting is empty, the tab does not dead-end. It displays a helpful Call-to-Action (CTA) pointing the user to configure Hindsight in the Marketplace, alongside any available API-only or external status context.
- **Blocked or Unreachable iframe**: If a remote or secured Hindsight deployment serves frame protection headers (blocking the iframe) or is network-unreachable, the tab detects this and renders a clear warning.
- **Secondary Fallback**: The primary **"Open Hindsight UI"** action opens the embedded in-app dashboard; an external-browser fallback link is provided as a secondary option when `uiUrl` is configured, while an unset `uiUrl` displays helpful Marketplace guidance.

### Move configuration out of the entry, into the Marketplace

To streamline the user experience, configuration has been completely moved out of the session entry point and consolidated inside the **Marketplace**. The standalone config/status form that the entry used to open is no longer the entry's job, leaving the entry focused entirely on utilizing the embedded dashboard.
- **Marketplace inline form/wizard**: All settings (deployment mode, URLs, bank, scope, and auto-toggles) and write-only secrets management are performed strictly within the Marketplace row's inline form.
- **Read-only status card**: Genuine runtime status metrics (such as mode, health, and retry-queue depth) are visible in the Marketplace row itself.

The panel uses only Bobbit theme tokens (`--background`, `--foreground`, `--card`, `--border`,
`--primary`, `--muted-foreground`, the `--chart-*` palette, and the `--positive`/`--negative`/
`--warning` semantic slots via `color-mix`) — no hardcoded palette. Browser coverage lives in
`tests/e2e/ui/hindsight-pack.spec.ts` (reusing the shared `tests/e2e/hindsight-stub.mjs`): open
from the session menu or `#/ext/hindsight`, verify the iframe uses the configured `uiUrl`, assert
that the entry is not a configuration form, cover unset/blocked iframe fallback states, and verify
persistence across reload via the `#/ext/hindsight` deep link.

## Setup UX — Marketplace front door, state model & guided setup

The UX-polish pass makes the **Marketplace installed row** the primary setup path and gives both
surfaces a single, unambiguous state vocabulary. The full UX spec (with an interactive prototype)
is [docs/design/hindsight-ux-polish.md](design/hindsight-ux-polish.md); this section documents the
shipped behaviour.

**Why a richer row?** Before this pass the built-in `hindsight` row collapsed to a single generic
`Enabled` lozenge, hiding the distinctions that actually matter for a memory backend (configured vs
dormant, external connected vs unreachable, managed stopped vs running). The row is now the *front
door* (what state is memory in, what's the next safe action); the [panel](#native-config--status-panel)
is the *workbench* (detailed config, search, logs).

### State model — one source, two surfaces

Both the Marketplace row and the panel derive their badge from the **same** inputs (`mode`,
`configured`, `healthy`, and a managed `runtimeStatus` from the supervisor) so they can never
disagree. The marketplace helper is `deriveHindsightState(...)` in
`src/app/marketplace-page.ts`; the managed runtime status comes from `GET /api/pack-runtimes`.

| State | Trigger | Badge | Token |
|---|---|---|---|
| **Disabled** | pack/provider toggled off | `Disabled` | `--muted-foreground` |
| **Dormant / not configured** | enabled, external mode, no `externalUrl` (or managed not yet configured) | `Not configured` | `--warning` |
| **External · Connected** | external, `externalUrl` set, `healthy` | `Connected (external)` | `--positive` |
| **External · Unreachable** | external, `externalUrl` set, `!healthy` | `Unreachable (external)` | `--negative` |
| **Managed · Stopped** | managed, configured, runtime `stopped` (or `docker-unavailable`) | `Stopped (managed)` | `--muted-foreground` |
| **Managed · Starting** | managed, runtime `starting` | `Starting (managed)` | `--info` |
| **Managed · Running** | managed, runtime `running` + `healthy` | `Running (managed)` | `--positive` |
| **Managed · Unhealthy** | managed, runtime up but health probe failing | `Unhealthy (managed)` | `--negative` |

Colour is **never** the only signal — each state pairs the semantic token with a distinct icon and
a plain-language one-liner. A transient **Checking…** state renders until the first `status` load
resolves.

**Sessionless status read.** After navigating to `#/market` there is no active chat session, so the
normal surface-token route path (`/api/ext/surface-token` → `/api/ext/route`) would 403. The row
reads the built-in pack's read-only routes through an additive, narrowly scoped seam
`GET /api/ext/pack-route/:packId/:routeName`: **admin-bearer only**, **GET only** (it can never
persist), and **built-in first-party packs only**. Managed-runtime context is resolved **without
starting Docker**, preserving the no-auto-start invariant.

### Active configured values surfaced

Both surfaces show the live, persisted config (a read-only projection of the `status` route — no
secrets, only `*Set` chips): **data-plane API URL**, **UI/dashboard URL**, **bank**, **namespace**,
**recall scope**, **auto-recall / auto-retain** toggles, **timeout**, **recall budget**, and the
retry-**queue depth** (plus `lastError` as a muted diagnostic when present). The marketplace row
renders these compactly; the panel renders them in its status card.

### API URL vs UI/dashboard URL

Users conflate the two URLs, so the UI distinguishes them everywhere:

- **API URL** (`externalUrl`) — the Hindsight **data-plane API**, where Bobbit reads and writes
  memory. This is the only URL the client ever dials, and the field that switches external mode on.
  AJ's local example: `http://localhost:9177`.
- **UI / dashboard URL** (`uiUrl`) — the human **web dashboard** for browsing memory. Bobbit **never** reads through it. The primary **Open Hindsight UI** action opens the embedded in-app dashboard route (`#/ext/hindsight`). A secondary link to open in an external browser is provided when `uiUrl` is configured. If `uiUrl` is unset, the interface directs the user with helpful Marketplace configuration guidance. It is optional, non-secret, and **never fabricated** from the API URL (different port/path). AJ's local example: `http://localhost:19177/banks/hermes?view=data` (Tailscale equivalent: `http://<tailscale-host>:19177/banks/hermes?view=data`).

### Actions (state-aware)

Each action appears only where it is meaningful; all map to existing routes (plus the sessionless
read seam above). At most a few buttons render inline.

| Action | Where shown | Effect | Backing call |
|---|---|---|---|
| **Configure** | always (primary) | Opens the guided setup wizard / inline configuration form inside the Marketplace | opens Marketplace inline configure form / wizard |
| **Test connection** | when configured | Re-reads the `status` route (pure health probe, no Docker) and shows an inline ok/fail lozenge | sessionless `status` read |
| **Open Hindsight UI** | always | Opens the embedded dashboard tab inside Bobbit (displays helpful Marketplace guidance if uiUrl is unset; includes a secondary link to open externally if uiUrl is configured) | in-app navigation (iframe target) |
| **Start runtime** | managed + stopped | **Explicit** consented Docker start (gated by the consent disclosure) | `POST /api/pack-runtimes/:id/start` |
| **Stop runtime** | managed + running/starting/unhealthy | Stops containers, keeps data | `POST /api/pack-runtimes/:id/stop` |
| **View logs** | managed modes | Inline read-only log tail | `GET /api/pack-runtimes/:id/logs?tail=` |

External mode never shows Start/Stop/View-logs (there is no Bobbit-managed process). **Test
connection** never starts Docker — it is a pure read.

### Guided setup walkthrough

**Configure** opens the guided setup wizard inside the Marketplace. This walkthrough explains the configuration choices, recommends safe defaults, validates settings, and guides you through the setup process. It is a user-friendly wrapper over the underlying `config` + `pack-runtimes` routes. 

Step 0 is a four-card deployment chooser that specifies exactly what Bobbit manages vs what you manage. All cards are fully selectable, and selecting any mode cleanly advances the wizard to the appropriate next step:

| Choice | `mode` | Bobbit manages | You manage |
|---|---|---|---|
| **Bobbit-managed (recommended)** | `managed` | Docker: Hindsight API + Postgres | An LLM API key; a data dir |
| **Bobbit-managed + your Postgres** | `managed-external-postgres` | Docker: Hindsight API | A Postgres URL; an LLM key |
| **Connect existing Hindsight** | `external` | Nothing (client only) | The whole Hindsight deployment |
| **Hermes-local / embedded** | `external` (preset) | Nothing | Hermes runs Hindsight for you |

The **Hermes-local** card is a preset that bakes AJ's local development values. Selecting any preset or mode only edits your local setup draft — **it never starts Docker**. 

#### Per-Mode Actionable Steps & Guidance
To ensure the setup experience matches what is actually happening under the hood, the steps and actions in the wizard dynamically adjust based on the selected mode:
- **Managed Modes (`managed` and `managed-external-postgres`)**: Because Bobbit manages the Docker containers, the wizard displays the consent disclosure and requires you to input necessary secrets (like the LLM API key). It culminates in an explicit, consent-gated **Start Runtime** step and button. This triggers the Docker compose workflow (pull → create → start → health check → smoke test) and is the only path that launches the managed Docker process.
- **External Mode (`external`)**: In this mode, Hindsight is managed entirely by you externally. Because there is no Bobbit-managed runtime to boot, the wizard **does not promise or show a Start Runtime button**. Instead, the final step presents a **Test Connection** button, which performs a non-blocking reachability and recall smoke test (retaining is never auto-fired during smoke tests) to verify Bobbit can successfully communicate with your external Hindsight data-plane API.

### Recommended defaults

The walkthrough surfaces an opinionated, safe defaults explainer (rationale shown inline):

| Setting | Default | Rationale |
|---|---|---|
| Data locality | local / private | Your memory stays on your machine unless you point at a shared deployment. |
| Bank | `bobbit` (shared) | One shared, tag-scoped bank. Use an existing bank like `hermes` only when connecting to one. |
| Namespace | `default` | Leave as `default` unless your Hindsight uses namespaces. |
| Auto-retain | on (async) | Memories are saved in the background after each turn — no latency cost. |
| Auto-recall | on | Relevant memories are pulled in automatically at session start and each turn. |
| Recall scope | `project` | This project + shared/global memories — "have we solved this before in this project, or globally?" |
| Timeout | `1500 ms` | Conservative: a slow Hindsight never stalls a turn; recall skips and retains queue. |
| LLM key (managed) | none (user-supplied) | Hindsight uses your LLM key for extraction. Bobbit forwards it to the local runtime only; it never hardcodes a provider secret. |

### Managed mode never auto-starts Docker

A hard, tested invariant (preserving the runtime's `startPolicy: on-enable`): **selecting a managed
mode never starts Docker.** The UI enforces this in three places:

1. **Mode selection writes config only.** Picking a managed card/preset persists `mode` and shows
   the runtime as **Stopped** — no `compose up`.
2. **Explicit Start.** Docker starts only from the **Start runtime** button, gated by the consent
   disclosure (services, ports, volume path, trust copy) and labelled unambiguously
   ("Start (starts Docker)"). Start also **requires saved config first** — it is not enabled from an
   unsaved draft.
3. **Required-inputs gate.** Start is disabled until the mode's required inputs are present
   (`llmApiKey` for `managed`; `+ externalDatabaseUrl` for `managed-external-postgres`).

### Stale-form & Save safety

The headline regression this pass fixes: after a config was persisted by any path while the panel
was open, the status card refreshed but the **form** kept showing stale defaults — so a Save would
diff the stale draft against the persisted config and **overwrite the good config**. The fix:

- **Refresh re-hydrates both config and status.** `Refresh` (and the post-Save reload) now call
  `loadConfig` **and** `loadStatus`, so the form and the status card always reflect the same load.
- **Dirty-aware hydration.** On every `loadConfig`, the diff base (`entry.config`) is always
  refreshed. If the user has **no unsaved edits**, the editable draft is re-seeded from the freshly
  loaded config (this alone fixes the repro). If the user **has** unsaved edits, their draft is
  preserved.
- **Touched-field Save body.** Save POSTs **only fields the user actually touched** (non-secrets via
  `touched`, secrets via `secretTouched`) — never a diff of the whole draft — so a stale, untouched
  field can never be sent as a "change".
- **Fail-fast pre-save refresh.** Before building the body, Save re-reads the live config to refresh
  the diff base; if that refresh fails it **fails fast** rather than proceeding from a stale
  snapshot and clobbering a memory-backend URL.

Browser E2E coverage for the whole UX pass lives in `tests/e2e/ui/hindsight-marketplace.spec.ts`
and `tests/e2e/ui/hindsight-pack.spec.ts` (both reuse the shared `tests/e2e/hindsight-stub.mjs`):
first-run Configure, guided-setup defaults/explanations, external connected/unreachable states, the
stale-form refresh regression, the Open-Hindsight-UI action, managed no-auto-start behaviour, and
progress/status rendering against mocked runtime events.

## REST client

`market-packs/hindsight/src/hindsight-client.ts` is a thin, faithful mapping over the Hindsight
HTTP API (`/v1/{namespace}/banks/{bank}/…`). Body shapes are mapped per the upstream `openapi.json`
(Hindsight 0.8.x); see [the design doc §3](design/hindsight-pack-external.md) for the exact request
and response mapping. Behaviour pinned by `tests/hindsight-client.test.ts`:

- Every method arms an `AbortController` with `timeoutMs` (default 1500); an abort surfaces as
  `HindsightError{ kind: "timeout" }` thrown **within budget**.
- Non-2xx ⇒ `HindsightError{ kind: "http", status }`; DNS/connection/socket failure ⇒
  `HindsightError{ kind: "network" }`.
- The `Authorization: Bearer` header is sent **only when `apiKey` is set**.
- `health()` is the sole exception that swallows errors — it is a pure reachability probe mapping
  every failure to `{ ok: false }`. Dormancy and skip-on-failure are the **provider's** job, so the
  client surface stays a faithful mapping.

## Testing

| Test | Phase | What it pins |
|---|---|---|
| `tests/hindsight-client.test.ts` | unit | Client round-trips, typed errors, timeout-within-budget, auth-header-only-when-set, namespace path-building (vs the in-process stub). |
| `tests/hindsight-provider.test.ts` | unit | Dormancy (no URL ⇒ no client constructed), auto-tag taxonomy, `recallScope` filter, retry-queue retry + cap, block shape. |
| `tests/e2e/hindsight-external.spec.ts` | E2E | sessionSetup + beforePrompt blocks appear; a turn retains on the stub with bank `bobbit` + correct tags; unhealthy ⇒ session unaffected + diagnostic + `status` unhealthy; recovery flushes the queue; per-project disable ⇒ no injection; persists across reload. |
| `tests/e2e/hindsight-agent-tools.spec.ts` | E2E | The three P5 agent tools round-trip through the real surface-token + route path to the stub; `scope`→tag mapping on the default/custom bank; tools resolve for a project session; per-project pack disable removes them (and 403s the surface-token mint). |
| `tests/e2e/ui/hindsight-pack.spec.ts` | E2E (browser) | The native panel: open from the palette, Save, status flips to connected, search; **plus** the UX-polish [stale-form refresh regression](#stale-form--save-safety) and guided-setup behaviour. |
| `tests/e2e/ui/hindsight-marketplace.spec.ts` | E2E (browser) | The Marketplace [state model](#state-model--one-source-two-surfaces) and [actions](#actions-state-aware): first-run Configure, connected/unreachable badges, Open-Hindsight-UI action, managed no-auto-start, and progress/status rendering against mocked runtime events. |
| `tests/manual-integration/hindsight-external.test.ts` | manual | Real local Hindsight round-trip. |

The shared in-process stub `tests/e2e/hindsight-stub.mjs` (`startHindsightStub`) backs the
automated tests deterministically — no network. It records every call, serves seeded memories
filtered by request tags, records retained items, and `setHealthy(false)` flips `/health` to 503 so
the provider's skip/queue paths are exercised.

### Manual integration against a real Hindsight

`tests/manual-integration/hindsight-external.test.ts` talks directly to a running Hindsight over
HTTP (no Bobbit gateway) and exercises `ensureBank → retain → recall`, polling up to ~30 s to
tolerate Hindsight's asynchronous fact-extraction pipeline. It **skips cleanly** (never fails) when
the health probe shows Hindsight is unreachable, so the manual suite stays green on machines
without a local Hindsight.

Environment:

| Var | Default | Purpose |
|---|---|---|
| `HINDSIGHT_URL` | `http://localhost:8888` | Base URL of the running Hindsight. |
| `HINDSIGHT_NS` | `default` | Namespace path segment. |
| `HINDSIGHT_BANK` | `bobbit-it` | **Dedicated** bank id so the test never pollutes the shared production `bobbit` bank. |
| `HINDSIGHT_API_KEY` | — | Optional bearer token; sent only when set. |

```bash
npm run build && node --import tsx --test tests/manual-integration/hindsight-external.test.ts
```

## Build & packaging

The pack is built like any [first-party pack](marketplace.md#built-in-first-party-packs): the three
server modules (`hindsight-client`, `provider`, `routes`) are hand-authored TS bundled to
confined-worker Node ESM under `lib/*.mjs` by `scripts/build-market-packs.mjs` (the `hindsight`
entry in `PACKS`, `platform: "node"`), and `scripts/copy-builtin-packs.mjs` lists `"hindsight"` in
`FIRST_PARTY_PACKS` so it ships in the built-in band. The shared `src/shared.ts` is inlined into
both `provider.mjs` and `routes.mjs`; only `lib/` ships, never `src/`.

## Cost & Signal Model (Before vs. After)

By tuning the default scoping and retention cadence, Bobbit substantially lowers LLM and token overhead while increasing the signal-to-noise ratio:

| Dimension | Before (Legacy) | After (Optimized) | Impact / Benefit |
|---|---|---|---|
| **Routine Retain Cost** | LLM extraction run on **every turn** (100% cost overhead). | Batched LLM extraction runs **every 5 turns** by default. | **80% reduction** in routine extraction LLM calls and associated API charges. |
| **Context Protection** | No special compaction handling. | **Compaction-exempt sync flush** (`beforeCompact`) always runs. | 100% of context is preserved before pruning; zero loss of crucial architectural decisions. |
| **Recall Signal** | Scope defaulted to `all` (cross-project noise and other-project clutter). | Scope defaulted to `project` (this project + shared/global memories). | Eliminates cross-project pollution, keeping the prompt focused only on relevant context. |
| **Recall Efficiency** | Raw turn summaries returned. | Configured `recallTypes` biased toward consolidated `observation` facts. | Prompts are injected with high-density consolidated facts instead of redundant chat logs. |
| **Token Budgeting** | Default budget was high and loose. | Modest `recallBudget` (default 1200 tokens) with `recallMaxInputChars` (3000 chars) clamping. | Controls total token count per prompt and eliminates Hindsight's 500-token query limit errors. |

## Non-goals

Tracked in later Extension Platform goals, **not** in this release:

- Mental-models / reflect UI / cross-engine dedupe / cost surfacing — **G4**.

> **Now shipped (were non-goals):**
> - The **setup UX** — Marketplace as the primary setup path, the eight-state badge model, the
>   guided setup walkthrough, the API-vs-UI-URL distinction (`uiUrl`), and the stale-form fix —
>   landed in the UX-polish pass; see
>   [Setup UX](#setup-ux--marketplace-front-door-state-model--guided-setup).
> - The explicit **agent tools** `hindsight_recall/retain/reflect` landed in **P5** — see
>   [Agent tools](#agent-tools).
> - The original native config/status panel landed in **P4**, but the current entrypoint model is
>   Marketplace for configuration and `#/ext/hindsight` / session-menu for the embedded dashboard.
>   Store-seeding is no longer the user-facing configuration path (test-only now).
> - The managed Docker runtime + Postgres + `~/.hindsight` bind-mount + deployment-mode selection
>   (`mode: managed` / `managed-external-postgres`) landed in **P3** — see
>   [managed-runtimes.md — P3](managed-runtimes.md#p3--deployment-modes-consent--lifecycle).

## See also

- [Lifecycle Hub](lifecycle-hub.md) — the seam that runs the provider's hooks and fences its
  blocks.
- [Marketplace → built-in first-party packs](marketplace.md#built-in-first-party-packs) and
  [provider contributions](marketplace.md#provider-contributions-providersidyaml).
- [docs/design/hindsight-pack-external.md](design/hindsight-pack-external.md) — implementation
  blueprint (REST body mapping, host seams, full test plan, and the bank-topology rationale in §7).
