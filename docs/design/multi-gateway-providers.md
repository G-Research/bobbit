# Multi-gateway providers

Status: in-progress · Tracked in goal `goal/multi-gateway-8e973d9d`.

## Problem

Bobbit's AI-Gateway integration is hardcoded to a **single** gateway stored
under the literal provider key `"aigw"`:

- `preferences-store.ts` holds one URL (`aigw.url`) and one exclusivity toggle
  (`aigw.exclusive`).
- `aigw-manager.ts::writeAigwModelsJson()` writes exactly one
  `providers.aigw` block into `~/.bobbit/agent/models.json`, and bakes in a
  **global heuristic**: "model id contains `claude` ⇒ route through Bedrock
  Converse + attach `x-opencode-session`/User-Agent headers + set Bedrock env".
- `model-registry.ts` pushes gateway models with `provider: "aigw"` and gates
  built-ins on the `aigw.exclusive` pref.
- `session-manager.ts`, `title-generator.ts`, and `server.ts` all branch on the
  string `"aigw"`.

This blocks adding local OpenAI-compatible gateways (ollama, llama-swap /
llama-server) **alongside** — or, for an enterprise `aigw`, **exclusively
instead of** — the built-in cloud providers. It also carries a latent bug: the
Claude→Bedrock heuristic is global, so a *local* gateway exposing a model
literally named `claude-*` would be wrongly Bedrock-routed.

ollama and llama-swap are already OpenAI-compatible gateways. The existing
`aigw` consumer path (discovery → `models.json` → bindable `set_model`) already
does everything we need — it is just single-instance and `claude`-heuristic
bound. **This design generalizes that one proven path into an ordered list of
named, typed gateways.** No new daemon. No repair of the custom-provider path
(`model-registry.ts::discoverCustomProviderModels` / `mapManualModels`). Image
generation is explicitly out of scope.

> **Prerequisite (separate housekeeping task, not a slice here):** PR #6
> (squash `bc7b83dd`) is reverted on the goal branch before implementation
> starts. That restores the custom-provider path to its pre-#6 state — fine,
> because this goal does not use it.

## Glossary

| Term | Meaning |
|---|---|
| **Gateway** | One OpenAI-compatible endpoint Bobbit talks to, identified by a user-chosen `name`. |
| **Provider key** | The string that appears as `provider` in the picker, as the `models.json` block key, and in `set_model(provider, id)`. For a gateway it equals `gateway.name`. |
| **`aigw` type** | Enterprise AI-Gateway: Bedrock-routes Claude ids, sends special headers, is **exclusive**. |
| **`openai-compatible` type** | Plain OpenAI gateway (ollama/llama-swap/vLLM/…): no Bedrock, no special headers, never exclusive. |
| **Exclusive mode** | Built-in cloud providers (and `openai-compatible` gateways) are suppressed; only `aigw`-type gateways contribute models. |
| **Merged mode** | Built-ins + all enabled `openai-compatible` gateways all contribute. |

---

## 1. The `ModelGateway` contract

Declared and **exported from `src/server/agent/aigw-manager.ts`** (it is the
foundation module every other slice imports):

```ts
export type GatewayType = "aigw" | "openai-compatible";

export interface ModelGateway {
	/** Stable identity (crypto.randomUUID()); never shown, used only as a UI row key. */
	id: string;
	/** Provider key used EVERYWHERE: picker `provider`, models.json block key, set_model(name, id). */
	name: string;
	/** Base URL as the user entered it (may or may not end with /v1). */
	url: string;
	type: GatewayType;
	enabled: boolean;
}
```

Persisted under the **new pref key `modelGateways`** (a JSON array) in
`preferences-store.ts`. Conceptual shorthand the user described: `<name>:<url>`.

`name` constraints (validated server-side on write, §6):

- non-empty after trim, `^[a-zA-Z0-9._-]+$` (so it is a safe `models.json` key
  and `provider/modelId` token),
- unique within the list (case-sensitive),
- must not collide with a pi-ai built-in provider id (`anthropic`, `openai`,
  `google`, `xai`, `amazon-bedrock`, `groq`, `mistral`, …) — see
  `model-registry.ts::ENV_MAP` for the canonical list; reject with 400.

### `aigw`-type naming constraint (singleton enterprise gateway)

An **`aigw`-type** gateway MUST be named exactly **`"aigw"`**, and at most one
`aigw`-type gateway may exist. `saveGateways` rejects (400) any `aigw`-type row
whose `name !== "aigw"`, and any list containing more than one `aigw`-type row.
`openai-compatible` gateways may use any valid `name` (per the rules above).

Rationale: exclusivity already makes the enterprise gateway a singleton (one
enabled `aigw` shadows all built-ins **and** every `openai-compatible`
gateway, §4), and **three behavior-bearing guards key on the literal provider
string `"aigw"`** and cannot be generalized cheaply:

- `src/server/agent/pi-ai-bedrock-headers-patch.ts` (`model?.provider !== "aigw"`)
  — Bedrock SDK middleware that injects the `x-opencode-session` / User-Agent
  request headers at the AWS client layer.
- `src/server/agent/model-completion.ts::resolveProviderHeaders`
  (`provider !== "aigw"`) — resolves the provider-level `headers` block from
  `models.json` for completion / title-gen requests.
- `src/shared/thinking-levels.ts::providerMatches` (`provider === "aigw"`) —
  **client-side** guard (provider **string only**, no prefs access) that lets
  an `aigw`-routed `claude-opus`/`claude-*` light up the `xhigh` thinking
  capability.

By pinning the `aigw` name to `"aigw"`, these three guards stay correct
**unchanged**: the migrated default (which already keeps `name:"aigw"`, §2) and
any user-created `aigw` gateway both retain header injection, Bedrock routing,
and `xhigh`. **This is why no slice owns `pi-ai-bedrock-headers-patch.ts`,
`model-completion.ts`, or `shared/thinking-levels.ts` — they require no change.**
Generalizing them to "any enabled `aigw`-type gateway name" was considered and
rejected: `shared/thinking-levels.ts` runs client-side with only a provider
string and cannot look up gateway types, so it would need a separate
canonical-family-hint mechanism — disproportionate for a singleton enterprise
gateway. (If a future requirement truly needs multiple differently-named
enterprise gateways, revisit this by emitting a canonical-family hint on the
`ApiModel` record and switching all three guards to consume it.)

### Accessor helpers (Slice A, exported from `aigw-manager.ts`)

```ts
export function listGateways(prefs: PreferencesStore): ModelGateway[];          // [] when unset
export function getEnabledGateways(prefs: PreferencesStore): ModelGateway[];
export function getGatewayByName(prefs: PreferencesStore, name: string): ModelGateway | undefined;
export function saveGateways(prefs: PreferencesStore, gateways: ModelGateway[]): void; // validates + persists
export function isExclusiveMode(gateways: ModelGateway[]): boolean;             // §4
```

`listGateways` is defensive: it parses `prefs.get("modelGateways")`, drops
malformed rows, and returns `[]` for any non-array value.

---

## 2. Pref migration (`aigw.url` + `aigw.exclusive` → `modelGateways`)

A fresh, idempotent, pure-ish function in `aigw-manager.ts`, called **once at
server boot** from `server.ts::start()` immediately **before**
`startupAigwCheck(...)` (so the rest of boot sees only the new schema):

```ts
export function migrateGatewayPrefs(prefs: PreferencesStore): {
	migrated: boolean;
	gateways: ModelGateway[];
};
```

Rules:

1. If `modelGateways` is already present (even `[]`) → **no-op**; defensively
   strip any leftover `aigw.url` / `aigw.exclusive`; return `{ migrated:false }`.
2. Else if `aigw.url` is a non-empty string → create
   `[{ id: randomUUID(), name: "aigw", url: <aigw.url>, type: "aigw",
   enabled: true }]`, persist as `modelGateways`, **remove** `aigw.url` and
   `aigw.exclusive`, return `{ migrated:true, gateways }`.
   - `aigw.exclusive` is intentionally dropped: exclusivity is now derived
     (§4). The migrated single `aigw`-type gateway is exclusive by derivation,
     which matches the **default** (`aigw.exclusive` defaulted to `true`). The
     rare user who had set `aigw.exclusive=false` loses merged mode for an
     `aigw`-type gateway — documented behavior change, surfaced by the UI
     warning banner (§7).
3. Else (no `aigw.url`, no `modelGateways`) → leave prefs untouched (readers
   treat absent as `[]`). Return `{ migrated:false, gateways:[] }`.

Because the migrated gateway keeps `name:"aigw"`, the **provider key stays
`"aigw"`**, so existing `default.sessionModel = "aigw/<id>"` (and
`default.namingModel`, role/review prefs) continue to resolve unchanged.

### Unit-test assertions (Slice A, `tests/multi-gateway-migration.test.ts`)

Use a `PreferencesStore` rooted in a `mkdtempSync` dir.

- **Migrates a configured single URL:** seed `{ "aigw.url":"http://gw/v1",
  "aigw.exclusive":false, "default.sessionModel":"aigw/claude-sonnet-4-6" }`.
  After `migrateGatewayPrefs`:
  - `listGateways(prefs)` deep-equals `[{ id:<string>, name:"aigw",
    url:"http://gw/v1", type:"aigw", enabled:true }]` (assert `id` is a
    non-empty string separately).
  - `prefs.get("aigw.url") === undefined` and `prefs.get("aigw.exclusive") === undefined`.
  - `prefs.get("default.sessionModel") === "aigw/claude-sonnet-4-6"` (untouched).
- **Idempotent:** running `migrateGatewayPrefs` a second time returns
  `migrated:false` and leaves `modelGateways` byte-identical.
- **No-op when nothing to migrate:** empty prefs → `modelGateways` stays
  `undefined`, `listGateways` returns `[]`.
- **Defensive cleanup:** seed both `modelGateways:[...]` and a stale
  `aigw.url` → after migrate, `aigw.url` removed, `modelGateways` unchanged.

---

## 3. Type-driven `models.json` writers

Replace the single `writeAigwModelsJson` with a **dispatch table** plus a
sync orchestrator. All in `aigw-manager.ts` (Slice A).

```ts
type ProviderBlock = Record<string, unknown>;
type GatewayWriter = (gateway: ModelGateway, models: AigwModel[]) => ProviderBlock;

const PROVIDER_WRITERS: Record<GatewayType, GatewayWriter> = {
	"aigw": buildAigwProviderBlock,
	"openai-compatible": buildOpenAiCompatibleProviderBlock,
};

const DISCOVERY: Record<GatewayType, (url: string) => Promise<AigwModel[]>> = {
	"aigw": discoverAigwModels,
	"openai-compatible": discoverAigwModels, // same GET /v1/models for now (see §5)
};
```

### 3a. `aigw` writer — `buildAigwProviderBlock(gateway, models)`

**Byte-for-byte the behavior of today's `writeAigwModelsJson`**, just keyed by
`gateway.name` instead of the literal `aigw` and reading the URL from
`gateway.url`:

- `baseUrl` = `gateway.url` with trailing slashes stripped.
- `apiKey: "none"`, `api: "openai-completions"`.
- Provider-level `headers`: `{ "User-Agent": BOBBIT_AIGW_USER_AGENT,
  "x-opencode-session": "!node -e \"process.stdout.write(process.env.BOBBIT_SESSION_ID || '')\"" }`.
- Claude ids (`id.toLowerCase().includes("claude")`) → strip provider prefix,
  `api: "bedrock-converse-stream"`, per-model `baseUrl = <url without /v1>/aws`.
- Non-Claude ids → `openai-completions` with the conservative `openaiCompat`
  flags merged with any `m.compat`.
- **No per-model `headers`** (pinned by `tests/aigw-headers.test.ts`).

Example (`name:"aigw"`, `url:"http://gw/v1"`):

```json
"aigw": {
  "baseUrl": "http://gw/v1",
  "apiKey": "none",
  "api": "openai-completions",
  "headers": {
    "User-Agent": "Bobbit/1.2.3",
    "x-opencode-session": "!node -e \"process.stdout.write(process.env.BOBBIT_SESSION_ID || '')\""
  },
  "models": [
    { "id": "us.anthropic.claude-sonnet-4-6", "name": "Claude Sonnet 4.6 (aws)",
      "api": "bedrock-converse-stream", "baseUrl": "http://gw/aws",
      "contextWindow": 1000000, "maxTokens": 16384, "reasoning": true,
      "input": ["text","image"], "cost": { "input":0,"output":0,"cacheRead":0,"cacheWrite":0 } },
    { "id": "openai/gpt-5.2", "name": "Gpt 5.2 (openai)",
      "contextWindow": 400000, "maxTokens": 128000, "reasoning": true,
      "input": ["text","image"], "cost": {…},
      "compat": { "supportsDeveloperRole": false, "supportsStore": false,
                  "supportsUsageInStreaming": false, "supportsReasoningEffort": false,
                  "supportsStrictMode": false, "maxTokensField": "max_tokens" } }
  ]
}
```

Bedrock env: only an `aigw`-type gateway calls `setBedrockEnvVars(gateway.url)`
— driven from the sync orchestrator (§3c), **not** from the writer, so merged
mode never hijacks a real `amazon-bedrock` provider.

### 3b. `openai-compatible` writer — `buildOpenAiCompatibleProviderBlock(gateway, models)`

Plain OpenAI for **every** model — including a model literally named
`claude-*`. This is the key fix to the latent multi-gateway bug.

- `baseUrl` = `normalizeOpenAiBaseUrl(gateway.url)` — strip trailing slashes,
  append `/v1` if not already ending in `/v1`.
- `apiKey: "none"`, `api: "openai-completions"`.
- **No `headers` block at all** (no `x-opencode-session`, no User-Agent
  override). The browser proxy still adds a User-Agent at the HTTP layer (§6);
  the agent subprocess config carries none.
- Every model: `api: "openai-completions"`, id **unchanged** (no prefix strip),
  `compat` = conservative `GATEWAY_COMPAT` flags merged with any `m.compat`.
- **Never** `bedrock-converse-stream`, **never** a per-model `/aws` baseUrl,
  **never** Bedrock env.

Example (`name:"llama-swap"`, `url:"http://host:9292"`):

```json
"llama-swap": {
  "baseUrl": "http://host:9292/v1",
  "apiKey": "none",
  "api": "openai-completions",
  "models": [
    { "id": "qwen-coder-medium", "name": "Qwen Coder Medium",
      "contextWindow": 1000000, "maxTokens": 32768, "reasoning": false,
      "input": ["text"], "cost": {…}, "compat": { …conservative flags… } },
    { "id": "claude-local", "name": "Claude Local",
      "contextWindow": 200000, "maxTokens": 16384, "reasoning": false,
      "input": ["text"], "cost": {…}, "compat": { …conservative flags… } }
  ]
}
```

Note `claude-local`: **`openai-completions`, no `baseUrl` override, no Bedrock**.

### 3c. Sync orchestrator — `syncGatewaysModelsJson(prefs)`

```ts
export async function syncGatewaysModelsJson(
	prefs: PreferencesStore,
): Promise<Record<string, AigwModel[]>>; // discovered models keyed by gateway name
```

Semantics (writes the enabled gateways, prunes everything it previously managed,
never clobbers unrelated providers like `anthropic`/`amazon-bedrock`/custom):

1. `gateways = listGateways(prefs)`; `enabled = gateways.filter(g => g.enabled)`;
   `enabledNames = new Set(enabled.map(g => g.name))`.
2. `data = readModelsJson()`; snapshot `existingBlocks = { ...data.providers }`.
3. **Prune:** the set of keys we own = `prefs.get("_managedGatewayProviders")`
   (`string[]`, written in step 6) **∪ `{"aigw"}`** (legacy single-URL block).
   For each owned key not in `enabledNames`, `delete data.providers[key]`.
   This handles disabled, removed, and renamed gateways without needing the
   previous full list.
4. **Discover + write** each enabled gateway:
   - `models = await DISCOVERY[g.type](g.url)` (per-gateway try/catch).
   - On success: `data.providers[g.name] = PROVIDER_WRITERS[g.type](g, models)`;
     record `discovered[g.name] = models`.
   - On failure: if `existingBlocks[g.name]` exists, **keep it** (preserves the
     current "gateway unreachable on startup ⇒ keep existing models.json"
     behavior); else skip. `discovered[g.name] = []`.
5. **Bedrock env:** `applyAigwBedrockEnv(enabled.find(g => g.type === "aigw"))`
   — sets the four `AWS_*` vars from that gateway's URL when present, **clears
   them when absent** (so disabling the `aigw` gateway restores a real Bedrock
   provider in the same process).
6. `writeModelsJson(data)`; `prefs.set("_managedGatewayProviders", [...enabledNames])`.

`removeAigwModelsJson()` and the single-URL `writeAigwModelsJson()` are removed;
their callers move to `syncGatewaysModelsJson`. (Legacy REST shims, §6, still
expose configure/DELETE semantics by mutating the list then syncing — so
`tests/aigw-headers.test.ts` and `tests/e2e/aigw-session-header.spec.ts` stay
green.)

`_managedGatewayProviders` is an internal bookkeeping pref (leading underscore),
never surfaced in the UI or `/api/preferences` editing.

### 3d. Writer unit tests (Slice A, `tests/multi-gateway-writer.test.ts`)

Use `BOBBIT_AGENT_DIR=<tmp>` like `tests/aigw-headers.test.ts`.

- **`aigw` type, Claude id ⇒ Bedrock block + headers + env:**
  `buildAigwProviderBlock`/sync for a gateway `{name:"aigw",type:"aigw"}` with a
  `claude` model → block has provider-level `headers["x-opencode-session"]`
  literal + `User-Agent`; the Claude model entry has
  `api:"bedrock-converse-stream"` and `baseUrl` ending `/aws`; after sync,
  `process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME` is set.
- **`openai-compatible`, claude-named id stays OpenAI:** gateway
  `{name:"llama-swap",type:"openai-compatible"}` exposing `claude-local` →
  block has **no `headers`**, the `claude-local` entry has
  `api:"openai-completions"`, **no** `baseUrl` override, and `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`
  is **not** set by this gateway.
- **Provider key = gateway name:** block lives under `providers["llama-swap"]`,
  not `providers["aigw"]`.
- **Multiple gateways ⇒ multiple blocks:** two enabled gateways → both
  `providers.aigw` and `providers["llama-swap"]` present after one sync.
- **Pruning:** sync with `[aigw(enabled), llama-swap(enabled)]`, then sync with
  `llama-swap` disabled → `providers["llama-swap"]` gone, `providers.aigw`
  intact. Removing all gateways → both gone; a pre-seeded `anthropic` block
  survives untouched.
- **baseUrl normalization (openai-compatible):** `url:"http://host:9292"` →
  block `baseUrl:"http://host:9292/v1"`; `url:"http://host:9292/v1/"` →
  `"http://host:9292/v1"` (no double `/v1`).
- **Bedrock env cleared:** sync with one enabled `aigw` (env set), then sync
  with it disabled → the four `AWS_*` vars deleted.

---

## 4. Exclusivity (derived, not a manual toggle)

```ts
export function isExclusiveMode(gateways: ModelGateway[]): boolean {
	return gateways.some(g => g.enabled && g.type === "aigw");
}
```

Consumed by `model-registry.ts::assembleModels` (Slice B). Replace the old
`aigw.url` + `aigw.exclusive` logic with:

```ts
const gateways = listGateways(prefs);
const enabled = getEnabledGateways(prefs);
const exclusive = isExclusiveMode(gateways);

// 1. Built-in providers — ONLY in merged mode.
if (!exclusive) { /* existing pi-ai getProviders()/getModels() loop, unchanged */ }

// 2. Gateways.
for (const g of enabled) {
	if (exclusive && g.type !== "aigw") continue;   // suppress openai-compatible in exclusive mode
	try {
		const discovered = await discoverGatewayModels(g);   // see §5
		for (const m of discovered) {
			const bedrock = bedrockRoutesForType(g.type) && isClaudeId(m.id);
			const id = bedrock ? stripProviderPrefix(m.id) : m.id;
			const meta = inferMeta(id);
			results.push({
				id,
				name: m.name,
				provider: g.name,                                // ← de-hardcoded
				api: bedrock ? "bedrock-converse-stream" : (m.api || "openai-completions"),
				baseUrl: g.url,
				contextWindow: Math.max(meta.contextWindow, m.contextWindow || 0),
				maxTokens: Math.max(meta.maxTokens, m.maxTokens || 0),
				reasoning: meta.reasoning || m.reasoning || false,
				input: meta.input || ["text"],
				cost: m.cost ?? { input:0, output:0, cacheRead:0, cacheWrite:0 },
				authenticated: true,                             // gateways are always authenticated
			});
		}
	} catch (err) { /* log, continue with next gateway */ }
}

// 3. Custom local providers — unchanged (only when !exclusive, to mirror today;
//    keep current behavior: custom providers were always shown. Keep them shown
//    in BOTH modes as today, since they are not gateways. Verify with a test.)
```

Truth table (the exclusivity unit test must cover every row):

| Gateways enabled | Mode | Contributes |
|---|---|---|
| one `aigw` | exclusive | that `aigw` only (built-ins + openai-compatible suppressed) |
| `aigw` + `openai-compatible` | exclusive | `aigw` only (openai-compatible suppressed) |
| only `openai-compatible`(s) | merged | built-ins + all enabled openai-compatible |
| `aigw` **disabled** + `openai-compatible` enabled | merged | built-ins + openai-compatible (disabled aigw ⇒ NOT exclusive) |
| none enabled | merged | built-ins only |

Small predicates A exports for B (avoid a `model-registry`↔`aigw-manager`
type cycle on `ApiModel`):

```ts
export function isClaudeId(id: string): boolean;            // id.toLowerCase().includes("claude")
export function stripProviderPrefix(id: string): string;   // "aws/x" → "x"
export function bedrockRoutesForType(t: GatewayType): boolean; // t === "aigw"
export function discoverGatewayModels(g: ModelGateway): Promise<AigwModel[]>; // DISCOVERY[g.type](g.url)
```

### `getPrefsVersion` (Slice B, `model-registry.ts`)

Replace the `aigw.url` / `aigw.exclusive` hash inputs with `modelGateways`:

```ts
const str = JSON.stringify([
	all["modelGateways"],
	all["customProviders"],
	...Object.keys(all).filter(k => k.startsWith("providerKey.")).sort(),
]);
```

### Exclusivity unit test (Slice A or B — assigned to A's helper, exercised in B's `model-registry` test)

`isExclusiveMode` is pure → unit-test it directly in
`tests/multi-gateway-exclusivity.test.ts` (Slice A) for all five rows above.
The end-to-end "built-ins suppressed" assertion lives in the API E2E (§10,
Slice C) against a stub gateway, since `assembleModels` calls live discovery.

---

## 5. De-hardcoding `provider:"aigw"` in consumers (Slice B)

### `session-manager.ts` auto-select (~line 4371)

Replace the single-URL fallback with a gateway-aware one:

- Drop `_aigwModelCache` keyed on a single URL; key it on gateway `name`
  (`Map<string, {models, ts}>`) or just discover per enabled gateway.
- Iterate `getEnabledGateways(prefs)` (respecting exclusive mode the same way as
  the registry: in exclusive mode only `aigw`-type), pick the best-ranked model
  across the contributing gateways via `modelRecencyRank`, then:
  ```ts
  await session.rpcClient.setModel(gateway.name, model.id);   // ← was setModel("aigw", id)
  store.update(session.id, { modelProvider: gateway.name, modelId: model.id });
  broadcast(..., { model: { provider: gateway.name, id: model.id, ... } });
  ```
- This is what directly fixes the #13/#14 root cause: the agent binds against
  the `providers[gateway.name]` block that `syncGatewaysModelsJson` wrote, so
  `set_model(name, id)` succeeds instead of silently falling back to Claude.

### `title-generator.ts`

- Extend `TitleGenOptions`:
  ```ts
  /** Enabled gateways, for resolving a naming-model's provider → URL. */
  gateways?: ModelGateway[];
  /** Implicit-fallback gateway URL (first enabled aigw-type), preserves the
   *  "auto-pick cheapest Claude" behavior. Replaces the old single aigwUrl. */
  aigwUrl?: string;
  ```
- In `generateSessionTitle` / `generateGoalSummaryTitle`, after
  `findConfiguredModel(pref)` resolves `{provider, modelId}`:
  - If `provider` matches an enabled gateway name (`options.gateways?.find(g =>
    g.name === provider)`), route via `generateViaGateway(gateway.url, modelId,
    …)` — works for **both** types because title-gen always uses the gateway's
    `/v1/chat/completions` (OpenAI path); the Bedrock distinction is irrelevant
    here. (Remove the `configured.provider === "aigw"` literal check.)
  - Else existing direct/anthropic paths.
- The implicit fallback (`pickFallbackAigwNamingModel`) stays but is gated on
  `options.aigwUrl`, which `getTitleGenOptions` now sets to the **first enabled
  `aigw`-type gateway's URL** (or `undefined`). For a merged/local-only setup
  there is no Claude fallback — title-gen then falls through to
  `default.sessionModel` / legacy Anthropic, exactly as it does today when no
  gateway is configured.

### `session-manager.ts::getTitleGenOptions` (~line 5088)

```ts
const gateways = getEnabledGateways(this.preferencesStore);
const aigwGateway = gateways.find(g => g.type === "aigw");
return {
	namingModel: namingModel || undefined,
	fallbackModel: sessionModel || undefined,
	gateways,
	aigwUrl: aigwGateway?.url,            // first enabled aigw-type, else undefined
	thinkingLevel: "off",
	preferencesStore: this.preferencesStore,
};
```

---

## 6. REST contract (Slice C, `server.ts`)

**Canonical list-management surface** (the new UI uses these):

| Method · Path | Body | Returns | Notes |
|---|---|---|---|
| `GET /api/aigw/gateways` | — | `{ gateways: ModelGateway[] }` | full list incl. disabled |
| `PUT /api/aigw/gateways` | `{ gateways: ModelGateway[] }` | `{ gateways, modelsByGateway: Record<string, AigwModel[]> }` | **replace whole list**; validates (§1); fills missing `id` with `randomUUID()`; `saveGateways`; `await syncGatewaysModelsJson`; `invalidateModelCache`; `broadcastPreferencesChanged` |
| `POST /api/aigw/test` | `{ url: string; type?: GatewayType }` | `{ ok:true, models }` or 502 | discover without saving (unchanged shape; `type` reserved for future per-type discovery) |
| `POST /api/aigw/gateways/:name/refresh` | — | `{ models }` or 404/502 | re-discover one gateway, re-run sync |
| `GET /api/aigw/gateways/:name/status` | — | `{ configured, name, url, type, enabled, models }` | per-gateway "view models" affordance |

**Proxy by name:** `/api/aigw/:name/v1/*` → `<gateway.url>/v1/*` for the named
enabled gateway (404 when no such enabled gateway). Implementation: parse
`:name`, `getGatewayByName`, build `targetUrl = gateway.url + "/v1/" + rest +
search`, call `proxyRequest`. Keep the **legacy** `/api/aigw/v1/*` mapping to
the gateway named `aigw` (or, if none, the first enabled gateway) for
back-compat.

**`/api/models/test`** (~line 5990): replace `if (provider !== "aigw")` with a
gateway-name check:

```ts
const gw = getGatewayByName(preferencesStore, provider);
if (!gw) { /* existing non-gateway path: testModelPreference(...) */ }
else { /* gateway path: POST <gw.url>/v1/chat/completions with the (prefix-
          resolved for aigw) model id, exactly as the current aigw branch but
          using gw.url instead of getAigwUrl(...) */ }
```

**Backward-compatible shims** (keep so existing E2E + any old clients survive):

- `GET /api/aigw/status` → returns `{configured,url,models}` for the gateway
  named `aigw` (or first `aigw`-type), else `{configured:false}`.
- `POST /api/aigw/configure {url}` → upsert a gateway `{name:"aigw",
  type:"aigw", enabled:true, url}` into the list, `saveGateways`, sync, return
  `{ok:true, models}`.
- `DELETE /api/aigw/configure` → remove the gateway named `aigw`, sync, return
  `{ok:true}`.
- `POST /api/aigw/refresh` → `:name="aigw"` refresh.

These shims keep `tests/e2e/aigw-api.spec.ts`, `aigw-configure.spec.ts`, and
`aigw-session-header.spec.ts` passing untouched.

**`/api/health` + `/api/status`** `aigw:` flag (lines 2435 / ~2435 region) →
`aigw: getEnabledGateways(preferencesStore).length > 0` (any enabled gateway
means the gateway tier handles LLM egress, so the browser OAuth prompt is
skipped — see `src/app/session-manager.ts::672`).

**Boot wiring** (`server.ts::start`, ~1604): call `migrateGatewayPrefs(prefs)`
**before** `startupAigwCheck(prefs)`. `startupAigwCheck` keeps its
offline-probe + localhost auto-discovery role but now (a) reads the list, (b)
on "already configured" re-runs `syncGatewaysModelsJson(prefs)` instead of the
single-URL refresh, and (c) auto-discovery creates a `{type:"aigw"}` gateway
(unchanged offline behavior). Slice A owns the `startupAigwCheck` rewrite (it
lives in `aigw-manager.ts`); Slice C only changes the boot call order +
endpoints.

---

## 7. Settings UI — gateway list editor (Slice D, `settings-page.ts`)

Replace the single-URL "AI Gateway" block (state vars `aigwUrl`,
`aigwConfigured`, `aigwExclusive`, fns `testAigwConnection`/`saveAigwConfig`/
`setAigwExclusive`/`refreshAigwModels`/`removeAigwConfig`) with a list editor.

State:

```ts
let gateways: ModelGateway[] = [];                 // loaded from GET /api/aigw/gateways
let gatewayRowStatus: Record<string, "idle"|"testing"> = {};   // keyed by row id
let gatewayRowError: Record<string, string> = {};
let gatewayModelsByName: Record<string, AigwModelEntry[]> = {}; // for "view models"
```

Each row renders: **enable checkbox**, **name** text input, **url** text input,
**type** `<select>` (`aigw` | `openai-compatible`), per-row **Test** button
(calls `POST /api/aigw/test {url,type}`), and a **Remove** button. A **＋ Add
gateway** button appends a blank row (`id: randomUUID(), name:"", url:"",
type:"openai-compatible", enabled:true`). A **Save** action issues
`PUT /api/aigw/gateways {gateways}` and reloads the canonical list from the
response.

**Exclusivity warning banner** — shown whenever any **enabled** row has
`type==="aigw"` (compute with the same predicate as `isExclusiveMode`):

> ⚠️ An AI Gateway (`aigw`) provider is enabled. While active, built-in cloud
> providers and other OpenAI-compatible gateways are **ignored** — only `aigw`
> models are available. Disable it to use local/built-in providers.

`data-testid`s for the browser E2E: `gateways-editor`, `gateway-row` (one per
row, with `data-gateway-id`), `gateway-name-input`, `gateway-url-input`,
`gateway-type-select`, `gateway-enabled-checkbox`, `gateway-test-btn`,
`gateway-remove-btn`, `gateways-add-btn`, `gateways-save-btn`,
`gateway-exclusivity-warning`.

`AigwModelsDialog.ts` (Slice D) stays as the read-only "view models" modal,
opened per-gateway from `gatewayModelsByName[name]` (populated from the
`PUT`/`status` responses). Its `strippedId` footnote stays relevant only for
`aigw`-type gateways; pass the gateway `type` in and hide the `aws/`-prefix
footnote for `openai-compatible`.

---

## 8. Vision passthrough (confirm — no new code)

Image input already works: `rpc-bridge.prompt()` dispatches attached images
unconditionally over standard multimodal `/v1/chat/completions`. No change.
**Metadata (incl. vision labeling) is deferred to `inferMeta`** for v1 — a bare
local VLM id on an `openai-compatible` gateway may not be *labeled*
vision-capable (no `image` in `input`) until the future `ollama` native type
lands (§9). Document this limitation; do not build metadata overrides.

---

## 9. Hide-unconfigured-models filter (goal §9, Slice E, `ModelSelector.ts`)

A persisted, **default-OFF**, display-only toggle that hides built-in models
with no API key from the picker.

- **localStorage key:** `bobbit.modelPicker.hideUnauthed` (value `"1"` / `"0"`).
- **Where:** a third filter button in `ModelSelector`'s filter row, alongside
  the existing Vision/Thinking buttons (~line 316–342). Label `i18n("Has key")`,
  icon `KeyRound`. State `@state() filterHideUnauthed = false`, initialised from
  localStorage in `open()`/`firstUpdated`; toggling writes localStorage and
  resets `selectedIndex`/scroll like the other filters.
- **Predicate** in `getFilteredModels()`:
  ```ts
  if (this.filterHideUnauthed) {
  	filteredModels = filteredModels.filter(({ model }) =>
  		(model.authenticated ?? false)               // keep authenticated
  		|| modelsAreEqual(this.currentModel, model)); // never hide the current model
  }
  ```
  This is correct-by-construction scoped to built-ins: gateway models are
  always emitted with `authenticated:true` (§4, `model-registry.ts:201`), and
  custom-provider rows are likewise emitted `authenticated:true` in the
  post-#6-revert code path (`model-registry.ts:~342/379/413/440`), so only
  built-in cloud models can ever be `authenticated:false`. (NB: `mapManualModels`
  was removed by the PR #6 revert `01e701c4` — do not reference it.) Document this
  invariant in a code comment.
- **Display-only:** the toggle lives entirely in the browser; it must not be
  sent to `/api/models`, must not affect server-side resolution, and must not
  touch `default.sessionModel` validation. (Optionally mirror the same
  localStorage key from a Settings → Models toggle in a follow-up; the
  localStorage key is the single source of truth either way. v1 ships the
  picker button only.)

---

## 10. Future-type seam (architecture only)

The two dispatch tables in `aigw-manager.ts` are the documented extension point:

```ts
const DISCOVERY: Record<GatewayType, (url) => Promise<AigwModel[]>>;
const PROVIDER_WRITERS: Record<GatewayType, GatewayWriter>;
```

To add a native type later (e.g. `ollama` via `/api/tags` + `/api/show` for real
ctx/capabilities/vision, or `llama-server`/`llama-swap` native):

1. Add the literal to the `GatewayType` union.
2. Register a discovery fn (native protocol) in `DISCOVERY`.
3. Register a writer in `PROVIDER_WRITERS` (its own `api`/baseUrl/headers shape).
4. Add the type to the UI `<select>` and to `bedrockRoutesForType` if relevant.

No consumer (registry/session-manager/title-gen/server) needs changing for a new
type beyond the union — they all route through `name`, `type`,
`discoverGatewayModels`, and the dispatch tables. Only `aigw` +
`openai-compatible` are implemented now.

---

## 11. Test plan (NO NETWORK)

All tests use an **in-process stub gateway** (tiny `http.Server` serving
`GET /v1/models` → `{data:[…]}` and `POST /v1/chat/completions` → a canned
OpenAI completion), as in `tests/e2e/aigw-session-header.spec.ts`. Never the
LAN host `maciekm-z13.local`, never `tools/dummy-aigw` (it needs a real
Anthropic key). Stub-server snippet (reused by Slices C/D):

```ts
const srv = http.createServer((req, res) => {
	res.setHeader("Content-Type", "application/json");
	if (req.url?.endsWith("/v1/models")) {
		res.end(JSON.stringify({ data: [
			{ id: "qwen-coder-medium" }, { id: "claude-local" },
			{ id: "aws/us.anthropic.claude-sonnet-4-6" },
		]}));
	} else { res.end(JSON.stringify({ choices:[{ message:{ content:"<title>OK</title>" }}] })); }
});
await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
const port = (srv.address() as any).port;
```

### Unit (node, Slice A) — `tests/multi-gateway-*.test.ts`

- `multi-gateway-migration.test.ts` — §2 assertions.
- `multi-gateway-writer.test.ts` — §3d assertions (incl. the
  claude-named-id-on-openai-compatible-stays-openai case, multiple blocks,
  pruning, baseUrl normalization, Bedrock env set/clear). Plus: existing
  `tests/aigw-headers.test.ts` must stay green via the legacy shim path.
- `multi-gateway-exclusivity.test.ts` — `isExclusiveMode` truth table (§4).
- `multi-gateway-validation.test.ts` — `saveGateways` **accepts** an `aigw`-type
  gateway named exactly `"aigw"`; **rejects** (throws / 400) an `aigw`-type
  gateway named anything else and a list containing two `aigw`-type rows;
  accepts arbitrarily-named `openai-compatible` gateways; rejects names that
  collide with a built-in provider id or violate `^[a-zA-Z0-9._-]+$`. This pins
  the §1 naming constraint that keeps `pi-ai-bedrock-headers-patch.ts`,
  `model-completion.ts`, and `shared/thinking-levels.ts` correct **unchanged**
  (an `aigw` gateway therefore always retains header injection + Bedrock routing
  + `xhigh`, regardless of how it was created).

### API E2E (in-process gateway, Slice C) — `tests/e2e/multi-gateway-api.spec.ts`

Spin up **two** stub servers. Then:

- `PUT /api/aigw/gateways` with `[{name:"llama-swap",type:"openai-compatible",
  url:<stubA>,enabled:true}, {name:"aigw",type:"aigw",url:<stubB>,enabled:false}]`
  → `GET /api/models`: provider `"llama-swap"` present (models with that
  provider), built-ins present (merged mode), no provider `"aigw"`. On disk,
  `~/.bobbit/agent/models.json` has `providers["llama-swap"]` (openai-completions,
  no headers) and **no** `providers.aigw`.
- Enable the `aigw` gateway (`PUT` again with `aigw.enabled:true`) →
  `GET /api/models`: built-ins **suppressed**, `llama-swap` **suppressed**,
  only provider `"aigw"` present; on disk both blocks exist (the agent could
  bind either, but the registry surfaces only aigw — exclusive). Assert the
  `aigw` block carries the `x-opencode-session` header literal and the
  `claude-*` model routes to `bedrock-converse-stream`, while the `llama-swap`
  block's `claude-local` stays `openai-completions`.
- Disable everything (`PUT []`) → on disk both gateway blocks pruned; `anthropic`
  block (if any) untouched; `GET /api/models` shows built-ins only.
- `POST /api/aigw/test {url:<stubA>}` → `{ok:true, models}`; unreachable URL →
  502. Legacy `POST/DELETE /api/aigw/configure` still works (smoke).
- "Binding resolves" is asserted at the `models.json` layer (provider block +
  correct `api` per type), since `set_model` is agent-subprocess-side and not
  reachable from the in-process REST harness — same de-scope rationale as
  `tests/e2e/aigw-session-header.spec.ts`.

### Browser E2E (spawned gateway, Slice D) — `tests/e2e/ui/multi-gateway-settings.spec.ts`

Pattern: `tests/e2e/ui/*.spec.ts` + a self-hosted stub gateway (like
`aigw-session-header.spec.ts` starts its own `http.Server`). Cover:

- Add an `openai-compatible` row (name/url/type) and an `aigw` row; Save.
- Toggle the `aigw` row's **enable** checkbox → the
  `gateway-exclusivity-warning` banner appears; uncheck → it disappears.
- Open the model picker → models show with the correct `provider` (gateway
  name) badge; in exclusive mode built-ins are absent.
- **Persistence:** reload the page → both rows + enabled state survive
  (from `GET /api/aigw/gateways`).
- **Removal cleanup:** remove a row + Save → its provider disappears from the
  picker and its `providers.<name>` block is pruned from `models.json`.

### Browser E2E (spawned gateway, Slice E) — `tests/e2e/ui/model-picker-hide-filter.spec.ts`

- With at least one built-in provider lacking a key (`authenticated:false`
  naturally in the test env) and one authenticated provider/gateway present:
- Open picker, toggle **Has key** ON → `authenticated:false` built-ins are
  absent; authenticated built-ins and all gateway models remain; the currently
  selected model (even if unauthenticated) remains.
- Toggle OFF → the hidden built-ins reappear.
- **Persistence:** reload → toggle state restored from
  `localStorage["bobbit.modelPicker.hideUnauthed"]`.
- **No server impact:** capture `/api/models` responses (network) and assert the
  payload is identical with the toggle ON vs OFF (display-only).

---

## Implementation partition

Five non-overlapping file-ownership slices. **Slice A is the foundation; B/C/D
build against its locked exports; D builds against C's REST contract; E is
nearly independent (only reads existing `/api/models` `authenticated`).** No two
slices edit the same file.

### Slice A — Foundation (`aigw-manager.ts`)

- **Owns:** `src/server/agent/aigw-manager.ts`; new tests
  `tests/multi-gateway-migration.test.ts`,
  `tests/multi-gateway-writer.test.ts`,
  `tests/multi-gateway-exclusivity.test.ts`.
- **Public contract it must honor (imported by B/C/D):**
  `GatewayType`, `ModelGateway`, `listGateways`, `getEnabledGateways`,
  `getGatewayByName`, `saveGateways` (validates §1, **incl. the `aigw`-name=`"aigw"`
  singleton constraint**), `isExclusiveMode`,
  `migrateGatewayPrefs`, `discoverGatewayModels`, `syncGatewaysModelsJson`,
  `isClaudeId`, `stripProviderPrefix`, `bedrockRoutesForType`, and the rewritten
  `startupAigwCheck` (now list-aware). Keeps exporting `AigwModel`, `inferMeta`,
  `deriveName`, `discoverAigwModels`, `proxyRequest`, `writeContextWindowOverrides`,
  `applyPiOfflineEnv`. **Removes** `writeAigwModelsJson`/`removeAigwModelsJson`/
  `configureAigw`/`removeAigw`/`getAigwUrl` (callers move to the new API; the
  legacy REST shims in Slice C re-implement configure/remove via the list).
- **`aigw`-name constraint (§1):** `saveGateways` enforces the singleton
  `aigw`-name=`"aigw"` rule. Consequently **no file outside this slice changes**
  for the three literal `"aigw"` guards — `pi-ai-bedrock-headers-patch.ts`,
  `model-completion.ts`, and `shared/thinking-levels.ts` are intentionally left
  untouched and owned by no slice.
- **Depends on:** nothing (foundation). Must land/lock signatures first so
  B/C/D can compile against stubs.

### Slice B — Consumers (`model-registry.ts`, `session-manager.ts`, `title-generator.ts`)

- **Owns:** `src/server/agent/model-registry.ts`,
  `src/server/agent/session-manager.ts`,
  `src/server/agent/title-generator.ts`.
- **Contract:** registry surfaces `provider: gateway.name`, applies
  `isExclusiveMode`, loops `getEnabledGateways` (§4); `getPrefsVersion` hashes
  `modelGateways`; session auto-select calls `setModel(gateway.name, id)` and
  persists `modelProvider: gateway.name`; title-gen resolves a naming model's
  provider → gateway URL via `options.gateways`, sets implicit `aigwUrl` to the
  first enabled `aigw`-type gateway. No literal `"aigw"` left in these files.
- **Depends on:** Slice A exports (`listGateways`, `getEnabledGateways`,
  `isExclusiveMode`, `discoverGatewayModels`, `isClaudeId`, `stripProviderPrefix`,
  `bedrockRoutesForType`, `ModelGateway`).

### Slice C — Server (`server.ts` aigw section)

- **Owns:** the AI-Gateway region of `src/server/server.ts` (endpoints ~5885–6065,
  the boot call ~1604, the `aigw:` flag ~2435); new API E2E
  `tests/e2e/multi-gateway-api.spec.ts`.
- **Contract:** the §6 REST surface (`GET/PUT /api/aigw/gateways`, per-gateway
  `refresh`/`status`, `POST /api/aigw/test`, `/api/aigw/:name/v1/*` proxy,
  generalized `/api/models/test`), the backward-compat shims
  (`/api/aigw/status|configure|refresh`, legacy `/api/aigw/v1/*`), boot order
  (`migrateGatewayPrefs` before `startupAigwCheck`), and the
  `aigw:` health flag. Keeps `tests/e2e/aigw-*.spec.ts` green.
- **Depends on:** Slice A (all list helpers + `syncGatewaysModelsJson` +
  `migrateGatewayPrefs`); Slice B's `invalidateModelCache` (already exported).

### Slice D — Settings UI (`settings-page.ts`, `AigwModelsDialog.ts`)

- **Owns:** `src/app/settings-page.ts` (Models tab AI-Gateway block + state/fns),
  `src/ui/dialogs/AigwModelsDialog.ts`; new browser E2E
  `tests/e2e/ui/multi-gateway-settings.spec.ts`.
- **Contract:** the §7 list editor (rows, add/remove, per-row Test, Save,
  exclusivity warning), the listed `data-testid`s, persistence via `GET/PUT
  /api/aigw/gateways`, AigwModelsDialog as per-gateway view-models.
- **Depends on:** Slice C's REST contract (consumed over HTTP — no shared
  source file). May develop against the documented JSON shapes before C lands.

### Slice E — Picker hide-filter (`ModelSelector.ts`)

- **Owns:** `src/ui/dialogs/ModelSelector.ts`; new browser E2E
  `tests/e2e/ui/model-picker-hide-filter.spec.ts`.
- **Contract:** the §9 default-OFF "Has key" filter, localStorage key
  `bobbit.modelPicker.hideUnauthed`, predicate (keep authenticated OR current),
  display-only (no `/api/models` change), persistence across reload.
- **Depends on:** nothing new — relies only on the existing
  `model.authenticated` field already served by `/api/models`. Fully parallel
  with A–D.
</content>
</invoke>
