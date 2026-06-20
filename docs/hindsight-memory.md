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
> **native config/status panel** and its launch entrypoints now ship as **P4** — see
> [Native config & status panel](#native-config--status-panel). The explicit
> `hindsight_recall/retain/reflect` agent tools now ship as **P5** — see
> [Agent tools](#agent-tools). The **setup UX** (Marketplace front door, the eight-state badge
> model, guided setup walkthrough, the stale-form fix, and `uiUrl`) ships as the **UX polish**
> pass — see [Setup UX](#setup-ux--marketplace-front-door-state-model--guided-setup) and the
> design spec [docs/design/hindsight-ux-polish.md](design/hindsight-ux-polish.md). The reflect UI
> and cross-engine dedupe remain **out of scope** — see [Non-goals](#non-goals).

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

The **primary** setup path is the **Marketplace** installed row for the built-in `hindsight` pack:
it shows the current memory state, surfaces the active config, and its **Configure** button opens a
[guided setup walkthrough](#guided-setup-walkthrough). The **session menu** entry (**Hindsight
Memory**) and the `#/ext/hindsight` deep link remain available as a **secondary**, discoverable way
to open the same native panel directly. Both paths lead to the same surface; see
[Setup UX](#setup-ux--marketplace-front-door-state-model--guided-setup).

Whichever path you use, configuration is one screen: set at least `externalUrl` (external mode) and
Save. Under the hood every surface writes through the `config` pack route (see
[Pack routes](#pack-routes)), so you can also drive it programmatically: set at least `externalUrl`
pointing at your Hindsight base URL (default Hindsight port is `8888`). Once the effective config
has a non-empty URL, the provider activates on the next session spawn and starts recalling and
retaining.

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
| `uiUrl` | string (optional) | — | Optional, **non-secret** human-facing Hindsight **dashboard** URL. Display/open-only — it backs the **Open Hindsight UI** action and is **never dialed by the client** and **never** influences activation/dormancy (those stay keyed on `externalUrl`). Never fabricated from `externalUrl` (different port/path). AJ's local example: `http://localhost:19177/banks/hermes?view=data`. Validated as an http(s) URL; `""` clears it. |
| `apiKey` | secret (optional) | — | Bearer token. Sent as `Authorization: Bearer <apiKey>` **only when set**; never echoed back (the `config` GET surface collapses it to a boolean `apiKeySet`). Also forms `ctx.runtime.headers` for the managed API. |
| `llmApiKey` / `externalDatabaseUrl` / `dataDir` | secret / secret / string | — / — / `~/.hindsight` | **Managed-mode only.** `llmApiKey` → `HINDSIGHT_API_LLM_API_KEY`, `externalDatabaseUrl` → `HINDSIGHT_API_DATABASE_URL` (redacted to `*Set` booleans on the GET surface), `dataDir` is the managed-Postgres bind path. See [managed-runtimes.md — P3](managed-runtimes.md#secrets--config-mapping). |
| `bank` | string | `bobbit` | The shared memory bank id (see [Bank & tag taxonomy](#bank--tag-taxonomy)). |
| `namespace` | string | `default` | Hindsight namespace path segment. |
| `recallScope` | enum `project` \| `all` | `project` | Default recall scope. `project` adds a `project:<id>` tag filter with `tagsMatch` (project + global memories); `all` recalls across the whole bank (cross-project). |
| `tagsMatch` | enum `any` \| `any_strict` | `any` | Scope filter strategy for `project` scope. `any` includes both project-specific AND global/shared memories. `any_strict` excludes global memories, enforcing hard project-only isolation. |
| `autoRecall` | boolean | `true` | When false, the recall hooks contribute no blocks. |
| `autoRetain` | boolean | `true` | When false, the retain hooks store nothing. |
| `retainEveryNTurns` | number | `5` | Cadence for background memory extraction. Bobbit runs an expensive LLM extraction once every N turns to optimize cost. |
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

- `project` (default) — add a `project:<projectId>` tag filter with `tags_match` mapped from `config.tagsMatch` (default `"any"`).
  - Under `"any"`, the query fetches project-tagged **plus** untagged/global memories, excluding only memories tagged for other projects.
  - Under `"any_strict"`, untagged/global memories are excluded, enforcing hard project isolation.
  The filter is applied only when the session is associated with a real project ID; a global/server-scope session continues to recall globally.
- `all` — recall across the entire bank with no project filter. This allows cross-project semantic queries like "how did we set up the database in project X?" to surface knowledge across the entire installation.

Recall, `reflect`, and the agent tools all route this scope→tag decision through one shared
`recallTagFilter(scope, projectId, tagsMatch)` helper (`market-packs/hindsight/src/shared.ts`),
so every read path resolves project scope identically.

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
- **`retainEveryNTurns` (default: 5)**: Instead of dispatching an extraction request on *every* turn, Bobbit holds turn summaries in a durable per-session buffer. A full LLM extraction is run only once every `N` turns. At $N=5$, this yields an immediate **80% reduction in routine extraction LLM calls**.
- **Buffering vs. Sampling**: This is a deterministic sequence count buffer per session, not random sampling, guaranteeing that all conversations are processed linearly.
- **`retainMaxDelayMs` (default: 30 minutes)**: To prevent memories from staling in extremely long-running or inactive sessions, this threshold acts as a hook-observed timeout to flush buffered turns.
- **`retainOverlapTurns` (default: 2)**: Preserves overlapping turn context at the boundaries of compactions to maintain thread continuity across batches.
- **Compaction Safety (`beforeCompact`)**: Before the gateway compacts a session's history (discarding the oldest context), the provider intercepts the event via `beforeCompact` and performs a **synchronous flush/retain** of the about-to-be-lost history span, bypassing the `retainEveryNTurns` cadence to guarantee zero context loss.
- **Session Shutdown**: On `sessionShutdown`, Bobbit performs a best-effort best-practice queue drain to flush remaining unsaved turns.

## Provider lifecycle behaviour

The provider implements the five [Lifecycle Hub](lifecycle-hub.md) hooks. It runs on the Extension
Host worker tier, reads merged config from `ctx.config`, builds a REST client per hook, and keeps
all durable state in the pack-scoped `ctx.host.store`. Every Hindsight condition is **non-fatal**:
a slow or unhealthy backend never blocks or fails a session — recalls skip and retains queue.

| Hook | Behaviour |
|---|---|
| `sessionSetup` | If `autoRecall`: recall against the goal/task spec (`ctx.prompt`) and inject the results as a **"Relevant memory"** context block (`authority: "memory"`). On error/timeout ⇒ no block + a diagnostic. |
| `beforePrompt` | If `autoRecall`: recall against the current user turn (`ctx.prompt`) under the provider `timeoutMs` deadline; skip on timeout (non-fatal). Same block mapping. |
| `afterTurn` | If `autoRetain`: build a compact turn summary (user + final assistant text, capped ~2000 chars) and **async** retain it (fire-and-forget). On failure, enqueue for retry. Also drains one [retry-queue](#retry-queue--diagnostics) head per call. |
| `beforeCompact` | If `autoRetain`: **synchronously** retain a summary of the about-to-be-lost span, so the memory lands before context is dropped. Failure ⇒ enqueue. |
| `sessionShutdown` | Best-effort **one-pass** drain of the retry queue. Never throws. |

The recall hooks return `ContextBlock[]` only — **fencing and `providerId` are the host's job**
(see [Lifecycle Hub → fencing](lifecycle-hub.md#fencing)). Each block is titled "Relevant memory",
`authority: "memory"`, `priority: 50`, with `content` a bulleted list of recalled memory text. An
empty recall produces no block.

### Retry queue & diagnostics

A retain that fails (network/timeout/HTTP) is **not lost**. The provider appends
`{ content, tags, ts }` to a durable queue in the pack store (key `retain-queue`):

- **Cap 100** — appending past 100 entries drops the oldest (FIFO eviction).
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
| `recall` | `{ query, scope? }` → resolves bank + tags (via `recallTagFilter`) and calls `client.recall`; returns `{ memories }`. Manual/diagnostic surface. |
| `retain` | `{ content, tags?, sync?, scope? }` → `ensureBank` + `client.retain` with merged auto-tags; `scope: project` (with a real project id) adds a `project:<id>` tag. The `kind:manual` marker is spread **last** so user/scope tags can't override it. Returns `{ ok }`. |
| `reflect` | `{ prompt, scope? }` → `client.reflect` with the same `recallTagFilter` scope mapping as `recall`; returns `{ text }`. |
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

- `recall` — `project` adds a `project:<id>` tag filter with `tagsMatch` (project-tagged **plus** untagged/global, excluding other projects — see [Recall scope](#bank--tag-taxonomy)); `all` adds no project filter. The project tag is only added when the session has a **real project id** — a global/server-scope session fabricates no placeholder tag.
- `retain` — `project` adds a `project:<id>` tag (again only with a real project id) alongside the auto `kind:manual` tag; `all` leaves the memory unscoped on the shared bank. User-supplied `tags` are additive and never change the bank. The `kind:manual` provenance marker is spread **last**, so a user-supplied `tags: { kind: "..." }` can never override it.
- `reflect` — `scope` maps to the **same** `recallTagFilter` as `recall`: `project` (with a real project id) reflects over project-tagged plus untagged/global memories; `all` (or no project id) reflects over the whole shared bank. It still creates no extra banks.

A configured custom `bank` (or `namespace`) flows through every tool to Hindsight unchanged — the scope→tag mapping is orthogonal to which bank is configured. This mirrors the provider's [bank & tag taxonomy](#bank--tag-taxonomy): scope is *always* expressed as tags on one bank, never as bank fan-out.

**No `tag_groups` DSL in Tools:** To keep the tool descriptions compact, budget-compliant, and simple for agents to use reliably, the complex `tag_groups` Boolean tree (AND/OR query tree) is **never** exposed to agent tools.

**Power-User Escape Hatch (Direct API):** For complex, compound Boolean filters (e.g. searching memories matching `(project:A OR project:B) AND kind:decision`), clients should bypass the agent tools and call the direct Hindsight data-plane API (`POST /v1/{namespace}/banks/{bank}/memories/recall` with the full `tag_groups` body).

API E2E coverage lives in `tests/e2e/hindsight-agent-tools.spec.ts` (reusing the shared
`tests/e2e/hindsight-stub.mjs`): it drives the real surface-token + route round-trip for each tool,
asserts the scope→tag mapping and default/custom bank routing on the stub, confirms the three tools
resolve for a project session, and that disabling the pack tools removes them from a newly-created
session's tool list (and closes the surface-token mint with a 403).

## Native config & status panel

The pack ships a **native, theme-compatible panel** (Extension Platform **P4**) that is the
user-facing configuration surface and a live status/search view. It is a pure client of the
existing P2 [pack routes](#pack-routes) through the versioned Host API — it adds **no new server
routes**, never makes a raw `fetch`, and never writes pack-store config keys directly (so the
`config` route's validation + secret redaction always apply). Source is
`market-packs/hindsight/src/panel.js`, built to `lib/HindsightPanel.js`; the panel descriptor is
`panels/hindsight-memory.yaml` (`id: hindsight.panel`). Full implementation contract:
[docs/design/hindsight-panel-p4-implementation.md](design/hindsight-panel-p4-implementation.md).

**Why a native panel?** Before P4 the only non-test way to configure the pack was seeding the
pack store directly. The panel makes configuration a one-screen task, surfaces runtime health
and the retry-queue depth where the operator can act on them, and keeps secrets write-only — the
store-seeding path is now a test-only seam.

### Entrypoints

Two entrypoints open the same **singleton** panel (one per session view), declared under
`market-packs/hindsight/entrypoints/` and listed in `pack.yaml` `contents.entrypoints`. Both are
the **secondary** discovery surface — the [Marketplace row](#setup-ux--marketplace-front-door-state-model--guided-setup)
is the primary setup path:

| Entrypoint | Kind | How to reach it |
|---|---|---|
| `hindsight-session-menu` | `session-menu` | A launcher labelled **Hindsight Memory** in the session actions overflow menu, sitting next to **PR Walkthrough** so memory is reachable from the same place. Its target is a bare `PanelTarget` (no `action: spawn`), so it opens `hindsight.panel` in the **active/owner session** — there is no sub-agent, unlike the pr-walkthrough spawn launcher. Replaces the legacy `command-palette` + `git-widget-button` entrypoints removed in #829. Visibility is deliberately **not** gated on `status` (no per-render pack-route call): the entry is registered whenever the pack is active and the panel itself renders the dormant/configure state, keeping the widget pack-agnostic and never a dead affordance. |
| `hindsight-route` | `route` (`routeId: hindsight`) | Deep link **`#/ext/hindsight`**. Carries no params (`paramKeys: []`); the panel rehydrates entirely from the `config`/`status` routes on mount, so a reload or shared link restores the same view. |

### What the panel does

The panel reads and writes only through `host.callRoute` and feature-detects
`host.capabilities.callRoute` (degrading to an "unavailable on this host" message on a host that
predates the capability). Its state is cached per `params.__sessionId` so reopening or reloading
rehydrates cleanly. It never mutates config on mount — mount kicks read-only `config` GET +
`status` GET; only **Save** and **Search** write.

- **Configuration card.** Picks the deployment `mode` (`external` / `managed` /
  `managed-external-postgres`) and progressively discloses the fields relevant to that mode:
  `externalUrl` (external), `dataDir` (managed), `externalDatabaseUrl` (managed-external-postgres),
  `llmApiKey` (managed modes), plus the optional `uiUrl` ([dashboard URL](#api-url-vs-uidashboard-url)),
  `apiKey`, `bank`, `namespace`, `recallScope`, the `autoRecall`/`autoRetain` toggles, and
  `recallBudget`/`timeoutMs`. Save POSTs **only touched** keys to the `config` route (not a diff of
  the whole draft) — an untouched-but-stale field can never clobber a config that changed on the
  server, and an empty optional string clears that value. Validation is the route's job —
  `{ ok: false, errors }` renders inline next to Save without mutating the panel snapshot. See
  [Stale-form & Save safety](#stale-form--save-safety) for the dirty-aware hydration contract.
- **Secrets are write-only.** The `config` GET surface returns only `*Set` booleans
  (`apiKeySet`/`externalDatabaseUrlSet`/`llmApiKeySet`), so the panel shows a "set" placeholder and
  never echoes a stored secret. An untouched secret field is omitted from the Save body (preserving
  it); an explicit clear sends `""`.
- **Runtime status card.** Driven by the `status` route. A state badge derives from
  `{ configured, healthy, mode }` (and, for managed modes, the supervisor runtime status) through
  the shared [eight-state model](#state-model--one-source-two-surfaces) so the panel and the
  Marketplace row can never disagree. It shows mode/bank/namespace/recallScope/auto-toggles, the
  [active configured values](#active-configured-values-surfaced), the **retry-queue counter**
  (`queueDepth`), `lastError` as a muted diagnostic when present, and a **real inline logs view**
  (managed modes only). The logs affordance toggles an inline panel that fetches `GET
  /api/pack-runtimes/:id/logs?tail=` — the **server admin runtime-logs route**, not a pack route
  (the same surface the built-in background-process pill reads). It is strictly **read-only** (only
  ever a GET); the panel never starts/stops Docker — all config/status/recall data still flows
  through the pack routes. A **Refresh** button re-polls `status`; while a managed mode is configured-but-not-yet
  healthy the panel runs a bounded health poll so the badge flips to Connected when the runtime
  comes up. Recent-retains data is **not** invented — P2 `status` exposes only `queueDepth` +
  `lastError`, so that is what the card shows.
- **Memory search.** A query input + scope (`all`/`project`) toggle POSTs to the `recall` route
  and renders the returned memory cards (text plus optional `score`/`id`), with loading / empty /
  dormant / error states. It never calls `retain` or `reflect`.

The panel uses only Bobbit theme tokens (`--background`, `--foreground`, `--card`, `--border`,
`--primary`, `--muted-foreground`, the `--chart-*` palette, and the `--positive`/`--negative`/
`--warning` semantic slots via `color-mix`) — no hardcoded palette. Browser coverage lives in
`tests/e2e/ui/hindsight-pack.spec.ts` (reusing the shared `tests/e2e/hindsight-stub.mjs`): open
from the palette, Save external URL + bank, stub status flips to connected, search renders seeded
memories, and persistence across reload via the `#/ext/hindsight` deep link.

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
- **UI / dashboard URL** (`uiUrl`) — the human **web dashboard** for browsing memory. Bobbit
  **never** reads through it; it only backs the **Open Hindsight UI** link (opened in a new tab).
  Optional, non-secret, and **never fabricated** from the API URL (different port/path). AJ's local
  example: `http://localhost:19177/banks/hermes?view=data` (Tailscale equivalent:
  `http://<tailscale-host>:19177/banks/hermes?view=data`). When unset, the action is hidden.

### Actions (state-aware)

Each action appears only where it is meaningful; all map to existing routes (plus the sessionless
read seam above). At most a few buttons render inline.

| Action | Where shown | Effect | Backing call |
|---|---|---|---|
| **Configure** | always (primary) | Opens the native panel / guided setup seeded with current config | `openPackPanel` → `config` POST |
| **Test connection** | when configured | Re-reads the `status` route (pure health probe, no Docker) and shows an inline ok/fail lozenge | sessionless `status` read |
| **Open Hindsight UI** | when a `uiUrl` is known | Opens the dashboard in a new tab | anchor to `uiUrl` |
| **Start runtime** | managed + stopped | **Explicit** consented Docker start (gated by the consent disclosure) | `POST /api/pack-runtimes/:id/start` |
| **Stop runtime** | managed + running/starting/unhealthy | Stops containers, keeps data | `POST /api/pack-runtimes/:id/stop` |
| **View logs** | managed modes | Inline read-only log tail | `GET /api/pack-runtimes/:id/logs?tail=` |

External mode never shows Start/Stop/View-logs (there is no Bobbit-managed process). **Test
connection** never starts Docker — it is a pure read.

### Guided setup walkthrough

**Configure** opens a guided walkthrough (the native panel's setup flow) that explains the choices,
recommends safe defaults, validates each step, and shows live progress for runtime actions. It
writes through the **same** `config` + `pack-runtimes` routes — it is a guided wrapper, not a new
config store. Step 0 is a four-card deployment chooser that maps exactly what Bobbit manages vs
what you manage:

| Choice | `mode` | Bobbit manages | You manage |
|---|---|---|---|
| **Bobbit-managed (recommended)** | `managed` | Docker: Hindsight API + Postgres | An LLM API key; a data dir |
| **Bobbit-managed + your Postgres** | `managed-external-postgres` | Docker: Hindsight API | A Postgres URL; an LLM key |
| **Connect existing Hindsight** | `external` | Nothing (client only) | The whole Hindsight deployment |
| **Hermes-local / embedded** | `external` (preset) | Nothing | Hermes runs Hindsight for you |

The **Hermes-local** card is a preset that bakes AJ's values (API `http://localhost:9177`, bank
`hermes`, UI `http://localhost:19177/banks/hermes?view=data`). Selecting a preset only edits the
local draft — **it never starts Docker**. The external branch collects API URL → optional dashboard
URL → bank/namespace → API key → recall/retain & limits, then runs a non-blocking connection +
recall **smoke test** (retain is never auto-fired) rendered as a per-step progress list. The
managed branch shows the consent disclosure, required secrets, data dir / Postgres URL, then an
explicit **Start** with a progress timeline (pull → create → start → health check → smoke test) —
in normal E2E these runtime events are **mocked/stubbed** (real Docker only in manual integration).

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
> - The **native config/status panel** + command-palette and `#/ext/hindsight` deep-link
>   entrypoints landed in **P4** — see [Native config & status panel](#native-config--status-panel).
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
