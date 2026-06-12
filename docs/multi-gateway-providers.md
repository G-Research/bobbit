# Multi-gateway providers

Bobbit can route model traffic through an arbitrary list of **named, typed,
OpenAI-compatible gateways**. This lets you add local providers (ollama,
llama-swap / llama-server) alongside — or, for an enterprise AI Gateway,
exclusively instead of — the built-in cloud providers (Anthropic, OpenAI,
Google, …).

> This page documents how the feature behaves and how to use it. For the design
> record and rationale (slices, test plan, alternatives considered), see
> [docs/design/multi-gateway-providers.md](design/multi-gateway-providers.md).

## Big picture — where it fits

Bobbit talks to LLMs in two ways:

1. **Built-in cloud providers** discovered from pi-ai using whatever API keys
   the host has configured. These appear in the model picker automatically.
2. **Gateways** — OpenAI-compatible HTTP endpoints Bobbit discovers, writes into
   the agent's `~/.bobbit/agent/models.json`, and proxies for the browser. The
   agent then binds models from those endpoints via `set_model`.

Historically the gateway tier was a **single** endpoint, hardcoded under the
literal provider key `"aigw"`. That single, proven path already did everything
multiple gateways need — discovery, `models.json` writes, browser proxying,
startup re-discovery, title-gen routing — it was just one instance and carried a
fragile global heuristic ("model id contains `claude` ⇒ route through Bedrock").

Multi-gateway generalizes that one path into an ordered list. ollama and
llama-swap are *already* OpenAI-compatible gateways, so no new daemon was built
— Bobbit just treats each configured endpoint as a gateway with a `name`, a
`url`, and a `type`. **Why this shape:** reusing the working aigw consumer path
(rather than the never-bindable custom-provider path) means selecting a local
model actually binds instead of silently falling back to Claude.

## The core concept: named, typed gateways

Each gateway is one record:

```ts
{ id: string; name: string; url: string; type: "aigw" | "openai-compatible"; enabled: boolean }
```

The whole list is persisted under the **`modelGateways`** preference (a JSON
array). The mental model the feature was designed around is `<name>:<url>` — a
human-chosen label bound to an endpoint.

**`name` is the provider key, used everywhere:**

- the `provider` field of each model in the picker (`<name>/<modelId>`),
- the `providers.<name>` block key in `~/.bobbit/agent/models.json`,
- `set_model(<name>, <modelId>)` when the agent binds a model.

`name` is validated server-side on save (`saveGateways` in
`src/server/agent/aigw-manager.ts`): non-empty, matching `^[a-zA-Z0-9._-]+$`
(so it is a safe `models.json` key and `provider/modelId` token), unique within
the list, and not colliding with a built-in pi-ai provider id (`anthropic`,
`openai`, `google`, `xai`, `amazon-bedrock`, …).

`id` is an opaque UUID used only as a UI row key; it is never shown and never
appears in a provider string.

## The two gateway types

The `type` drives discovery, request shaping, and exclusivity. Only `aigw` and
`openai-compatible` are implemented today.

| | `aigw` | `openai-compatible` |
|---|---|---|
| **For** | Enterprise AI Gateway | Local / generic OpenAI gateways (ollama, llama-swap, vLLM, …) |
| **Discovery** | `GET /v1/models` → `inferMeta` | `GET /v1/models` → `inferMeta` |
| **Claude ids** | Routed through **Bedrock Converse** (`api: "bedrock-converse-stream"`, per-model `/aws` baseUrl) | Plain OpenAI — **never** Bedrock, even for an id literally named `claude-*` |
| **Request headers** | Sends `User-Agent: Bobbit/<version>` + `x-opencode-session` (provider-level `headers` block) | **No special headers** — no `x-opencode-session`, no User-Agent override |
| **Bedrock env** | Sets `AWS_*` env for subprocesses | Never touches Bedrock env |
| **`models.json` `api`** | `openai-completions` (+ `bedrock-converse-stream` for Claude ids) | `openai-completions` only |
| **baseUrl** | `url` as entered (trailing slashes stripped) | `url` normalized: trailing slashes stripped, `/v1` appended if missing |
| **Name** | **Pinned to `"aigw"`** (singleton) | Any valid name |
| **Exclusive?** | **Yes** (see below) | No (merged) |

The key correctness fix here is that Claude→Bedrock routing is a property of the
**`aigw` type only** (`bedrockRoutesForType(t) === (t === "aigw")`). An
`openai-compatible` gateway exposing a model literally named `claude-*` is served
as plain OpenAI — removing the latent bug in the old global heuristic where any
gateway's `claude-*` model would be wrongly Bedrock-routed.

### Why the `aigw` type's name is pinned to `"aigw"`

An `aigw`-type gateway **must** be named exactly `"aigw"`, and at most one may
exist (`saveGateways` rejects any other name and any second `aigw` row with a
400). This is not arbitrary: three behavior-bearing guards key on the literal
provider string `"aigw"` and cannot be generalized cheaply:

- `src/server/agent/pi-ai-bedrock-headers-patch.ts` — `model?.provider !== "aigw"`
  short-circuits the Bedrock SDK middleware that injects the
  `x-opencode-session` / `User-Agent` headers at the AWS client layer.
- `src/server/agent/model-completion.ts::resolveProviderHeaders` —
  `provider !== "aigw"` gates whether the provider `headers` block from
  `models.json` is attached to completion / title-gen requests.
- `src/shared/thinking-levels.ts::providerMatches` — `provider === "aigw"` is a
  **client-side** guard (it sees only the provider string, with no prefs access)
  that lets an aigw-routed `claude-opus-*` light up the `xhigh` thinking level.

Because exclusivity already makes the enterprise gateway a singleton (one
enabled `aigw` shadows everything else), pinning its name to `"aigw"` keeps all
three guards correct **with zero changes** — the migrated default and any
user-created `aigw` gateway both retain header injection, Bedrock routing, and
`xhigh`. Generalizing the guards to "any `aigw`-type gateway name" was rejected
as disproportionate: `shared/thinking-levels.ts` runs client-side and would need
a separate canonical-family-hint mechanism. See
[docs/thinking-levels.md](thinking-levels.md#provider-guard--fail-closed-on-id-collisions)
for the `xhigh` guard detail.

## Derived exclusivity

Exclusivity is **derived from type, not a manual toggle**
(`isExclusiveMode(gateways)` = "is any enabled gateway of type `aigw`?"). There
is no `aigw.exclusive` preference anymore.

- **Exclusive mode** (any enabled `aigw`-type gateway): only `aigw`-type
  gateways contribute models. Built-in cloud providers **and** every
  `openai-compatible` gateway are suppressed.
- **Merged mode** (otherwise): built-in cloud providers plus all enabled
  `openai-compatible` gateways all contribute and merge together.

**Why derived:** an enabled enterprise `aigw` is intentionally the *only* egress
in that deployment, so showing built-ins or local gateways alongside it would be
misleading. Disabling the `aigw` gateway (without deleting it) flips the whole
setup back to merged mode — which is how you temporarily switch to local
providers.

| Gateways enabled | Mode | Contributes |
|---|---|---|
| one `aigw` | exclusive | that `aigw` only (built-ins + openai-compatible suppressed) |
| `aigw` + `openai-compatible` | exclusive | `aigw` only (openai-compatible suppressed) |
| only `openai-compatible`(s) | merged | built-ins + all enabled openai-compatible |
| `aigw` **disabled** + `openai-compatible` enabled | merged | built-ins + openai-compatible (disabled aigw ⇒ NOT exclusive) |
| none enabled | merged | built-ins only |

The Settings editor surfaces this with an **exclusivity warning banner**
whenever an enabled row has `type === "aigw"`:

> ⚠️ An AI Gateway (`aigw`) provider is enabled. While active, built-in cloud
> providers and other OpenAI-compatible gateways are **ignored** — only `aigw`
> models are available. Disable it to use local/built-in providers.

## Configuring gateways

### Settings → Models → AI Gateways

The **AI Gateway** block on the Models settings tab is a list editor. Each row
has:

- an **enable** checkbox (flip a gateway on/off without deleting it),
- a **name** text input (the provider key),
- a **url** text input,
- a **type** dropdown (`openai-compatible` | `aigw`),
- a per-row **Test** button (discovers the URL's models without saving),
- a **Remove** button.

**＋ Add gateway** appends a blank `openai-compatible` row; **Save** persists the
whole list. The exclusivity warning banner appears above the rows whenever an
enabled `aigw` row is present. Saving validates server-side — a misnamed `aigw`
row, a duplicate name, or a built-in-provider-id collision is rejected and the
error is shown inline.

The configuration survives reload (it is reloaded from `GET /api/aigw/gateways`),
and removing a row + Save prunes that gateway's `providers.<name>` block from
`models.json` so its models disappear from the picker.

### REST endpoints

The canonical list-management surface lives in `src/server/server.ts`:

| Method · Path | Purpose |
|---|---|
| `GET /api/aigw/gateways` | Full list including disabled rows. |
| `PUT /api/aigw/gateways` | Replace the whole list — validates, fills missing `id`, persists, re-syncs `models.json`, invalidates the model cache. Returns the list + discovered `modelsByGateway`. |
| `POST /api/aigw/test` | Discover a URL's models without saving (body `{ url, type? }`). |
| `POST /api/aigw/gateways/:name/refresh` | Re-discover one gateway and re-sync. |
| `GET /api/aigw/gateways/:name/status` | Per-gateway `{ configured, name, url, type, enabled, models }`. |
| `/api/aigw/:name/v1/*` | **Proxy** to `<gateway.url>/v1/*` for the named enabled gateway (404 if none). The browser may not reach the gateway host directly, so model discovery / completions route through here. |

**Backward-compatible shims** (single-URL era) remain so older clients keep
working: `GET /api/aigw/status`, `POST`/`DELETE /api/aigw/configure`,
`POST /api/aigw/refresh`, and the legacy `/api/aigw/v1/*` proxy — all operate on
the gateway named `aigw` (or the first enabled gateway).

`/api/models/test` accepts any configured gateway name as a `provider`, not just
`"aigw"`; `/api/health` and `/api/status` report `aigw: true` whenever **any**
gateway is enabled (the gateway tier handles LLM egress, so the browser OAuth
prompt is skipped).

## Migration from the single `aigw` gateway

On the first server boot after upgrading, `migrateGatewayPrefs` runs once
(before the startup gateway check) and converts the legacy single-URL prefs:

- An existing non-empty `aigw.url` becomes one gateway
  `{ name: "aigw", url, type: "aigw", enabled: true }` in `modelGateways`, and
  the old `aigw.url` / `aigw.exclusive` keys are removed.
- If `modelGateways` is already present (even `[]`), migration is a no-op (it
  just strips any leftover legacy keys).
- If there was no `aigw.url`, prefs are left untouched (readers treat absent as
  `[]`).

**Behavior is identical to before.** A migrated single `aigw` gateway is
exclusive by derivation, matching the old default (`aigw.exclusive` defaulted to
`true`). Because the migrated gateway keeps `name: "aigw"`, the provider key
stays `"aigw"`, so existing `default.sessionModel = "aigw/..."` (and
`default.namingModel`, role / review model prefs) keep resolving unchanged.

> **One documented behavior change:** the rare user who had explicitly set
> `aigw.exclusive = false` loses merged mode for an `aigw`-type gateway —
> exclusivity is now derived, and the UI warning banner explains it.

## `models.json` synchronization

`syncGatewaysModelsJson` is the orchestrator that keeps
`~/.bobbit/agent/models.json` in step with the gateway list. It runs on every
relevant change (save, refresh, startup re-discovery) and:

1. Discovers each **enabled** gateway and writes its `providers.<name>` block via
   the type-specific writer (`buildAigwProviderBlock` /
   `buildOpenAiCompatibleProviderBlock`).
2. **Prunes** the blocks it previously managed (tracked in the internal
   `_managedGatewayProviders` pref, plus the legacy `"aigw"` key) that are no
   longer enabled — so disabled, removed, and renamed gateways are cleaned up.
   Unrelated providers (`anthropic`, `amazon-bedrock`, custom) are never touched.
3. Preserves the last-good block for a gateway unreachable on this run (the
   "gateway offline on startup ⇒ keep existing `models.json`" behavior).
4. Sets the `AWS_*` Bedrock env from the enabled `aigw`-type gateway, **or clears
   it** when none is enabled — so disabling the `aigw` gateway restores a real
   `amazon-bedrock` provider in the same process.

`BOBBIT_SKIP_AIGW_DISCOVERY=1` still skips only the network discovery call at
startup; Bedrock env is still applied and the existing `models.json` is kept
as-is.

## The "Has key" model-picker filter

A separate, smaller addition: a default-OFF picker filter that hides built-in
models with no API key, so the list isn't cluttered by providers you never
configured.

- It is the third filter button in the model picker's filter row (alongside
  Vision and Thinking), labelled **Has key**.
- **Display-only.** The toggle lives entirely in the browser, persisted in
  `localStorage` under `bobbit.modelPicker.hideUnauthed` (`"1"` / `"0"`). It is
  never sent to `/api/models`, never affects server-side model resolution, and
  never touches `default.sessionModel` validation.
- **Scoped to built-ins by construction.** Gateway models and custom-provider
  rows are always emitted with `authenticated: true`, so only built-in cloud
  models can ever be `authenticated: false` and thus hidden. The currently
  selected model is never hidden, even if unauthenticated.

Toggling persists across reload. Why a filter and not a hard removal: discovery
noise is useful when you're starting out and exploring providers, but pure
clutter once your setup has solidified — so it's an opt-in display preference,
not a behavior change.

## Vision (image input)

Image input works unchanged. `rpc-bridge.prompt()` dispatches attached images
unconditionally over the standard multimodal `/v1/chat/completions` path, so a
vision-capable model behind any gateway receives images with no extra code.

**Limitation:** per-model metadata (including vision labeling) is inferred by
`inferMeta` for v1. A bare local VLM id on an `openai-compatible` gateway may not
be *labeled* vision-capable (no `image` in its `input`) in the picker until a
future native `ollama` type lands — even though images still pass through. This
is a labeling gap, not a functional one.

## Extending: the future-type seam

Adding a new gateway type later is deliberately localized to two dispatch tables
in `src/server/agent/aigw-manager.ts`:

```ts
const DISCOVERY: Record<GatewayType, (url) => Promise<AigwModel[]>>;
const PROVIDER_WRITERS: Record<GatewayType, GatewayWriter>;
```

To add a native type (for example `ollama` via `/api/tags` + `/api/show` for
real context window / capabilities / vision, or a native `llama-server` /
`llama-swap` protocol):

1. Add the literal to the `GatewayType` union.
2. Register a discovery function in `DISCOVERY`.
3. Register a writer in `PROVIDER_WRITERS` (its own `api` / baseUrl / headers
   shape).
4. Add the type to the Settings `<select>`, and to `bedrockRoutesForType` if it
   should Bedrock-route.

No consumer (registry, session-manager, title-gen, server) needs changing for a
new type beyond the union — they all route through `name`, `type`,
`discoverGatewayModels`, and the dispatch tables.

## Out of scope (future work)

- **Native `ollama` / `llama-server` discovery types** — only the seam exists
  today; discovery is `GET /v1/models` for both implemented types.
- **Accurate per-model metadata / manual overrides for bare ids** — deferred to
  the future native types (which expose real capability metadata).
- **Image generation** — not addressed by this feature.
- **The custom-provider path** (`model-registry.ts` manual models) — explicitly
  not reused or repaired; gateways replace it for local providers.

## Where the code lives

| Concern | Location |
|---|---|
| Gateway contract, list helpers, migration, writers, discovery, sync | `src/server/agent/aigw-manager.ts` |
| Provider-name surfacing, exclusivity rule, auto-select, title-gen | `src/server/agent/model-registry.ts`, `session-manager.ts`, `title-generator.ts` |
| REST CRUD + proxy + health flag | `src/server/server.ts` (AI-Gateway region) |
| Settings list editor + exclusivity warning | `src/app/settings-page.ts`, `src/ui/dialogs/AigwModelsDialog.ts` |
| "Has key" picker filter | `src/ui/dialogs/ModelSelector.ts` (`HIDE_UNAUTHED_KEY`) |

## Related docs

- [docs/design/multi-gateway-providers.md](design/multi-gateway-providers.md) —
  the design record (slices, full test plan, alternatives).
- [docs/internals.md — AI Gateway request headers](internals.md#ai-gateway-request-headers-user-agent-x-opencode-session)
  — header generation and the Bedrock SDK patch for the `aigw` type.
- [docs/thinking-levels.md](thinking-levels.md) — why the `aigw` provider string
  matters for the `xhigh` capability guard.
- [docs/debugging.md](debugging.md) — gateway `models.json` / naming-model
  troubleshooting.
</content>
</invoke>
