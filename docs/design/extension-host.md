# Bobbit Extension Host — Durable v1 Contract

**Status:** design (v1, durable) — **Phase 2 IMPLEMENTED**. Phase 1 built the inner slice
(renderers + actions); Phase 2 made the rest of the reserved shape REAL, **purely
additively** — no v1 signature changed, `HOST_API_VERSION` is still `1`, and every
capability flipped its `host.capabilities` flag `false → true` as it landed. The whole VS
Code-shaped contribution model + Host API was committed here as a **durable v1 contract** —
TypeScript interfaces and a validated manifest schema — so Phase 2 never had to re-open a
v1 shape. The §3/§6 prose **status notes** below are flipped to "IMPLEMENTED" accordingly
(a status edit, never a contract change); the v1 interfaces in
`src/shared/extension-host/host-api.ts` are byte-identical to Phase 1. The Phase-2 build
plan a coder executed lives in [extension-host-phase2.md](extension-host-phase2.md); this
doc remains the contract + the *why*.

This is the authoritative design for the *Extension Host* goal. It is the source of
truth a coder implements Phase 1 from with no further architectural decisions. It also
freezes the contribution-point manifest, the full Host API, and proves (on paper) that
`artifacts` and the PR-walkthrough collapse onto the v1 shape with **zero** changes to v1
types.

**Durability principle (the whole point of v1).** Every host capability is a **typed,
named, versioned, capability-scoped method**. There is **no raw transport and no escape
hatch**: the Host API is a contract Bobbit *serves*, not a window into Bobbit internals.
Consequences encoded throughout this doc:

- **No `gateway.fetch`.** A raw authenticated fetch against the live REST surface would
  couple every pack to today's endpoints and re-open a token-leak surface. It is removed.
  `invokeAction` (tool-authorized) is the ONLY Phase-1 pack→server path; a pack-scoped,
  typed `callRoute` (Phase 2) is the durable replacement for "a pack needs its own dynamic
  server data" — scoped to the pack's OWN contributed `routes:` namespace, never arbitrary
  gateway paths.
- **Host-API-owned data contracts.** Transcript/message/event shapes are stable types this
  contract OWNS (`HostMessage`, `HostContentBlock`, `ToolCallRecord`, typed event
  payloads) — never `unknown[]` mirrors of Bobbit's internal wire format. Bobbit maps its
  internal types onto these via a documented **internal→contract adapter layer**, so
  internals can be refactored freely without breaking packs.
- **Structured addressing.** `ui.openPanel` / `ui.navigate` take typed `{ panelId|route,
  params }` objects, never hash strings that bake in today's router.
- **The invariant:** *one un-typed passthrough makes the whole abstraction a fiction.* No
  member of the Host API is a raw passthrough.

Prereqs read: [pack-based-marketplace.md](pack-based-marketplace.md) (PackResolver,
`buildPackList`, scopes/precedence, the byte-identical invariant) and
[../marketplace.md](../marketplace.md).

---

## 0. TL;DR — the three Phase-1 decisions (v1 contract)

1. **Renderer delivery.** A pack ships a **pre-built ES module** at
   `tools/<group>/<renderer>.js`. The gateway serves it as `text/javascript` from
   `GET /api/tools/:tool/renderer`. On cold load the UI reads `/api/tools`, and for every
   tool with `rendererKind: "pack"` calls
   `registerLazyToolRenderer(name, loader, { override: true })` where `loader` does
   `import(/* @vite-ignore */ url)` and hands the module a **host toolkit**
   (the app's own `lit` `html`/`nothing` + `renderHeader`) via a factory export — so pack
   renderers never bare-import `lit` and the lit singleton is never duplicated. Existing
   placeholder + load-failure fallbacks are reused verbatim. Survives reload because
   registration is re-driven from tool metadata, not from a one-shot install event.
   Because `rendererKind` is computed from the resolved **winning** provider, a pack that
   shadows a built-in interactive tool wins the renderer too: the `{ override: true }`
   registration shadows any eager built-in renderer of the same name (the litmus parity
   case). A built-in not shadowed by any pack keeps its eager renderer unchanged.

2. **Server actions.** A pack tool ships `tools/<group>/actions.js` exporting
   `export const actions = { retry: async (ctx, args) => {…} }`. The gateway resolves the
   winning module through the **same precedence** `ToolManager` already uses
   (`resolveToolLocation()` → `{baseDir, groupDir, actionsModule}`, provider-independent),
   caches it keyed by resolved path+mtime,
   and invalidates synchronously inside the existing `invalidateResolverCaches()`. Endpoint
   `POST /api/tools/:tool/actions/:action` with body `{ sessionId, toolUseId, args }`.

3. **Host API (Phase-1 surface).** `host.invokeAction(tool, action, args)` (plus the
   client-only `host.requestRender()`) — exposed to renderers via a new optional
   `ToolRenderContext.host?: HostApi`. **There is no `gateway.fetch`:** `invokeAction` is
   the sole pack→server path and is authorized exactly like a tool call. Built-in
   renderers are unchanged (they ignore the field). The full `host.session.*` /
   `host.ui.*` / `host.store.*` namespace — plus the pack-scoped, typed `host.callRoute`
   (the durable replacement for raw fetch) — is frozen as interfaces but **not**
   implemented. Removing `gateway.fetch` also deletes the Host-header trusted-base-URL
   token-leak surface (the whole `resolveTrustedGatewayBaseUrl` concern) — a net security
   simplification, and behavior-neutral for Phase 1 (the retry-demo litmus uses only
   `invokeAction`).

---

## 1. Overview & two-host architecture

VS Code-shaped: declarative **contribution points** in the tool/pack manifest, two
**extension hosts**, one **Host API** that is the single security choke point.

```
                          ┌───────────────────────────── Bobbit gateway (server host) ─────────────┐
  Browser (client host)   │                                                                          │
  ┌───────────────────┐   │  GET /api/tools                      → tool metadata (hasRenderer, …)    │
  │ renderer-registry │◀──┼──GET /api/tools/:tool/renderer       → pack ESM renderer (text/javascript)│
  │  (lazy import)    │   │                                                                          │
  │                   │   │  POST /api/tools/:tool/actions/:action→ ActionDispatcher                  │
  │  ToolRenderContext│──▶┼──   │  guard (allowedTools) ─ verify toolUseId ─ load actions.js ─ run    │
  │     .host: HostApi│   │     └── ctx: ServerHostApi (scoped, audited, timeout)                     │
  └───────────────────┘   │                                                                          │
        ▲   host.invokeAction (Phase 1, the ONLY pack→server path; tool-authorized)                  │
        ┄   host.callRoute / host.session.* / host.ui.* / host.store.* (Phase 2, typed + scoped)     │
        └───────────────────────────────────────────────────────────────────────────────────────────┘
```

There is no raw-fetch arrow: every sanctioned arrow is a typed, named, authorized method.
The Phase-1 arrow is `host.invokeAction`; the Phase-2 arrows (`host.callRoute` against the
pack's OWN `routes:` namespace, `host.session.*`, `host.ui.*`, `host.store.*`) are all
typed and scoped, never a raw passthrough.

- **Client host** (browser, this app's Vite bundle): lazy-loads a pack's UI module and
  registers it as a tool renderer. Lives in `src/ui/tools/` + a new bootstrap in
  `src/app/`.
- **Server host** (gateway, the long-lived Node process): loads a pack's server module
  (the `actions` map) on demand and dispatches calls. Lives in `src/server/`.
- **One Host API**: a single typed, versioned, capability-scoped object. It is the ONLY
  surface extension code uses to touch Bobbit internals, and therefore the single place
  every capability is authorized.

**Why the Host API is the boundary, not the network.** The LLM already holds the admin
bearer token (extensions read `.bobbit/state/token`) and has shell — so "can reach the
gateway" is not the threat. The threat is *new typed entry points executing in the
gateway process* and *the action endpoint bypassing the per-session `allowedTools` guard*
that gates tool calls at the agent layer. §5 closes both.

---

## 2. Contribution-point manifest schema

### 2.1 Where it lives

Contributions are declared in the **tool YAML** (`tools/<group>/<tool>.yaml`) — the same
files `ToolManager` already scans. Phase 1 made `renderer:`/`actions:` load-bearing and
parsed the rest as **shape-only-and-reserved**; **Phase 2 made every reserved key
load-bearing** — `tool-contributions.ts` now parses each into a typed contribution and
surfaces it on `/api/tools`. Per-tool parsing stays tolerant (a malformed block degrades,
never rejects) exactly as in Phase 1.

| Key | Status | Meaning |
|---|---|---|
| `renderer:` | **load-bearing (P1)** | For **pack** tools it is the on-disk path (relative to the tool's group dir) of a pre-built ESM renderer module. For builtins it stays display-only metadata. |
| `actions:` | **load-bearing (P1)** | Relative path to the server actions module (default `actions.js`) **and/or** an inline allowlist of action names. |
| `panels:` | **IMPLEMENTED (P2)** | Persistent side-panel component contributions (artifacts / PR-walkthrough viewer). Parsed by `parsePanels` → `{ id; title?; entry }[]`; served bearer-only by `GET /api/tools/:tool/panel/:panelId`; mounted via `host.ui.openPanel`. |
| `entrypoints:` | **IMPLEMENTED (P2)** | Non-chat launchers (composer slash-commands, git-widget buttons, command palette) **and** `kind:"route"` deep-link routes. Parsed by `parseEntrypoints`; launchers click → `host.ui.openPanel`/`navigate`; routes populate the client pack-route registry. |
| `routes:` | **IMPLEMENTED (P2)** | The pack's OWN gateway endpoints, reached via `host.callRoute`. Parsed by `parseRoutes` → `{ module?; names? }`; dispatched by `RouteDispatcher` keyed off the server-resolved `packId` (see §3.2). |
| `stores:` | **IMPLEMENTED (P2)** | Ownership-scoped server-side persistence behind `host.store.*`; keys namespaced by the server-resolved `packId` (cross-pack reads rejected). Parsed by `parseStores`. |


`toolRenderers` and `actions` from the goal's contribution-point list map to the
per-tool `renderer:`/`actions:` keys (one tool = one renderer + one actions map). A
pack-level aggregate is **not** introduced in Phase 1; each tool YAML is self-describing,
matching today's `ToolManager` scan model.

### 2.2 Validated schema

Parsed by a new `parseContributions(data, filePath)` in
`src/server/agent/tool-contributions.ts`, called from the existing YAML scan in
`tool-manager.ts::scanToolsDir()` (and mirrored in `builtin-config.ts::toolInfoFrom()`).

```ts
// src/server/agent/tool-contributions.ts (NEW)

/** Contributions parsed from a tool YAML. Phase 1 keys (`renderer`/`actions`)
 *  and every Phase-2 key are now load-bearing — each is parsed into a typed
 *  contribution and acted on. */
export interface ToolContributions {
	/** Renderer ESM module path, relative to the tool's group dir. Load-bearing
	 *  for PACK tools only; for builtins this is display-only metadata (a src/ path). */
	renderer?: string;
	/** Server actions module + optional declared action allowlist. */
	actions?: ToolActionsContribution;
	/** `stores:` (Slice B1) — declared pack stores; the runtime backend is keyed
	 *  by the server-derived packId, so this is a declaration/validation aid. */
	stores?: StoreContribution[];
	/** `panels:` (Slice B4) — pack-contributed side panels; each `entry` is a
	 *  pre-built ESM module served bearer-only and lazy-imported by the client. */
	panels?: PanelContribution[];
	/** `routes:` (Slice B3) — server routes module + the declared route-name
	 *  allowlist the pack-level RouteRegistry indexes by. */
	routes?: RouteContribution;
	/** `entrypoints:` (Slice C1) — launcher surfaces + deep-link client routes. */
	entrypoints?: EntrypointContribution[];
	/** Forward-compat only: FUTURE unknown keys parsed-for-shape, retained
	 *  verbatim, NOT acted on (the reserved-key list is currently EMPTY). */
	reserved: ReservedContributions;
}

export interface ToolActionsContribution {
	/** Module path relative to the group dir. Default "actions.js". */
	module?: string;
	/** Optional explicit action-name allowlist. When present, the endpoint
	 *  rejects any :action not in this list BEFORE loading the module. */
	names?: string[];
}

/** FUTURE-contract contribution keys (none currently — every Phase-2 key has
 *  graduated to a typed parser). Validated for *shape* only, retained verbatim,
 *  then ignored. Never rejected. The fallback machinery is retained so a future
 *  unknown key gets the same treatment without re-deriving it. */
export interface ReservedContributions {
	[key: string]: unknown[] | undefined;
}
```

### 2.3 Validation rules

- `renderer`: optional string; must be a relative path with no `..` segments and no
  leading `/` (reject path traversal at parse time). Extension must be `.js` for pack
  tools (pre-built ESM); a `.ts` value is treated as display-only (builtin convention) and
  produces `rendererKind: "builtin"`.
- `actions.module`: optional string; same path-safety rules; defaults to `"actions.js"`
  when `actions:` is present without an explicit module.
- `actions.names`: optional `string[]`; each must match `/^[a-z0-9][a-z0-9_-]*$/`.
- `panels`/`entrypoints`/`routes`/`stores`: **Phase 2 parses each into a
  typed contribution** (`parsePanels`/`parseEntrypoints`/`parseRoutes`/`parseStores`
  in `tool-contributions.ts`) and surfaces it on `ToolInfo`. Per-tool
  parsing stays tolerant: a malformed block degrades to "absent" with a `console.warn`,
  never a hard rejection (mirrors Phase-1 `renderer`/`actions`). Path-bearing values
  (`panels[].entry`, `routes.module`) get the same `..`/absolute traversal guard as
  `renderer`/`actions.module`. The **two** real-conflict rejections happen later, at
  pack-level **registry build**, not per-tool parse: a pack declaring the same `routes:`
  name on two tools (§B3), or two packs/tools declaring the same `entrypoints:` `routeId`
  (§C1) — each names the conflict and is the rare case a pack IS rejected.
- **Unknown top-level keys are ignored** (forward-compat), matching `pack.yaml`'s rule.
- A malformed contributions block degrades gracefully: the tool still loads with no
  renderer/actions, and a `console.warn` is emitted — never fatal (mirrors the existing
  per-tool try/catch in `scanToolsDir`).

### 2.4 Example pack tool YAML

```yaml
# market-packs/retry-demo/tools/demo/sample_action.yaml
name: sample_action
description: A demo tool with a Retry button wired to a server action handler.
group: Demo
summary: Demo tool — renders a Retry button.
# NOTE: a pack tool needs NO `provider:` — the renderer endpoint and the
# ActionDispatcher resolve the renderer/actions on-disk location via
# `ToolManager.resolveToolLocation()`, which is provider-independent (§4b).
renderer: SampleActionRenderer.js          # pre-built ESM, beside this YAML
actions:
  module: actions.js                         # exports { retry: async (ctx, args) => {…} }
  names: [retry]                             # endpoint allowlist (defense in depth)
# ── Phase-2 keys below are accepted + ignored on a Phase-1 server ──
panels:
  - id: demo.sidebar
    title: Demo
    entry: panel.js
```

### 2.5 New tool-metadata wire fields

`ToolInfo` (`tool-manager.ts`) + the `/api/tools` payload (`api.ts::ToolInfo`) gain:

```ts
hasRenderer: boolean;          // unchanged
rendererFile?: string;         // unchanged (path string)
rendererKind?: "builtin" | "pack";   // NEW — "pack" ⇒ serve+lazy-import at runtime
hasActions?: boolean;          // NEW — drives nothing client-side; informational
actionNames?: string[];        // NEW — optional declared allowlist (from actions.names)
```

`rendererKind` is computed at scan time: `"pack"` when the tool's winning `baseDir` is a
market-pack root **and** `renderer` ends in `.js`; otherwise `"builtin"`. This is the
single signal the client bootstrap keys off (§4a).

**Phase-2 additive wire fields.** Activating the reserved keys added more (purely
additive) optional `ToolInfo`/`/api/tools` fields, each populated from its typed
contribution: `panels?: { id; title? }[]`, `entrypoints?: EntrypointContribution[]`,
`routeNames?: string[]`, and `storeIds?: string[]`. The client `pack-panels.ts` /
`pack-entrypoints.ts` registries are re-driven from these on every `/api/tools` fetch
(reload-safe, reconcile-on-uninstall), exactly as `pack-renderers.ts` is re-driven from
`rendererKind`. Being additive preserves the `buildPackList` byte-identical invariant.

---

## 3. Frozen Host API (durable v1 contract) — now fully IMPLEMENTED

Committed as interfaces in a shared module `src/shared/extension-host/host-api.ts`
(importable by both `src/ui` and `src/server`). Phase 1 implemented only `invokeAction`
and the client-only `requestRender`; **Phase 2 implemented every remaining member to its
exact v1 signature** — `callRoute`, `session.{readTranscript,readToolCall,postMessage,
subscribe}`, `ui.{openPanel,navigate}`, `store.{get,put,list}`. The additive-only promise
held: the interfaces below are byte-identical, `HOST_API_VERSION` is still `1`, and a
client `host.capabilities` now reports **all flags `true`** (`src/app/host-api.ts`). The
inline `PHASE 2` notes in the interface block below now read **IMPLEMENTED**; the
per-method status is summarized here:

| Member | Status | Where the body lives |
|---|---|---|
| `invokeAction` / `requestRender` | P1 | `src/app/host-api.ts`, `action-dispatcher.ts` |
| `callRoute` | **P2 implemented** | client `host-api.ts` → `POST /api/ext/route/:name`; server `route-dispatcher.ts` + `RouteRegistry` |
| `session.readTranscript` / `readToolCall` | **P2 implemented** | client GETs `/api/ext/session/*`; server `contract-adapter.ts` (own-session) |
| `session.postMessage` | **P2 implemented** | client mints a permit + posts over the session WebSocket (`session-write-bridge.ts`); server `session-write.ts` + `session-write-permit.ts` |
| `session.subscribe` | **P2 implemented** | client `session-event-bus.ts` bridged onto `HostSessionEventMap` via the adapter |
| `ui.openPanel` | **P2 implemented** | client `pack-panels.ts` (lazy Blob-URL panel module) |
| `ui.navigate` | **P2 implemented** | client `pack-entrypoints.ts` → `#/ext/<routeId>` router view |
| `store.get/put/list` | **P2 implemented** | client → `POST /api/ext/store/:op`; server `pack-store.ts` (pack-namespaced) |

The interfaces below are the literal spec the implementation executed to; they remain the
durable contract.

**This is the contract Bobbit serves, not a window into Bobbit.** Every member is a typed,
named, capability-scoped method. There is **no `gateway.fetch`** and no other raw
passthrough. The data shapes (`HostMessage`, `HostContentBlock`, `ToolCallRecord`, event
payloads) are **owned by this contract** and versioned by `HOST_CONTRACT_VERSION`; Bobbit
maps its INTERNAL session/message types onto them through a documented
**internal→contract adapter layer** (`src/server/extension-host/contract-adapter.ts`,
implemented in Phase 2), so Bobbit can refactor its internals freely without breaking
packs. The interfaces below are the literal spec the implementation wave executes to and
must compile as written.

```ts
// src/shared/extension-host/host-api.ts (NEW)

/** Bumped only on a BREAKING change to any member below. Additive-only after v1: adding a
 *  new method/namespace does NOT bump this. Renderers feature-detect AVAILABILITY via
 *  `host.capabilities` (the single source of truth for what is IMPLEMENTED on this host) —
 *  NOT via member-presence checks: `capabilities` is authoritative, and a namespace can
 *  be present on the object yet gated off on a given host (see HostCapabilities).
 *  `host.version` only identifies the contract
 *  revision; it never implies a member is implemented. */
export const HOST_API_VERSION = 1 as const;

/** Versions the Host-API-OWNED data contracts (HostMessage / HostContentBlock /
 *  ToolCallRecord / event payloads). Bumped only on a BREAKING change to those shapes.
 *  Kept distinct from HOST_API_VERSION so the surface and the data model can evolve
 *  independently; packs may read it to feature-detect contract-shape additions. The
 *  internal→contract adapter (§3, Phase 2) is the single place Bobbit's internal types
 *  are mapped onto these versioned shapes. */
export const HOST_CONTRACT_VERSION = 1 as const;

/**
 * The single, versioned, capability-scoped object through which ALL extension code
 * (client renderers and, in Phase 2, panels/entrypoints) touches Bobbit. Every member is
 * a typed, named, authorized method, mediated in one place (the gateway action/route
 * guards and the client wrappers). There are NO raw passthroughs and NO privileged escape
 * hatches — that invariant is what makes v1 durable (one un-typed passthrough would make
 * the whole abstraction a fiction).
 */
export interface HostApi {
	/** Frozen API version. See HOST_API_VERSION. */
	readonly version: number;

	/** Version of the Host-API-owned data contracts. See HOST_CONTRACT_VERSION. */
	readonly contractVersion: number;

	/**
	 * The SINGLE SOURCE OF TRUTH for which capabilities are actually IMPLEMENTED on this
	 * host. Authors MUST feature-detect via `host.capabilities.<name>` (or
	 * `host.capabilities.has(name)`), NOT via member-presence checks: every namespace
	 * (`callRoute`/`session`/`ui`/`store`) is ALWAYS present on the object for type
	 * stability, so `if (host.callRoute)` / `if (host.store)` would succeed even on a host
	 * that has the capability gated off. On a current host every flag is
	 * `true`: `{ invokeAction: true, requestRender: true,
	 * callRoute: true, session: true, ui: true, store: true }`. The flags exist so a host
	 * can additively gate a capability on/off without signature or version churn. */
	readonly capabilities: HostCapabilities;

	/**
	 * Force the active tool block(s) to repaint. PHASE 1: implemented by dispatching a
	 * dedicated `TOOL_RENDER_REQUESTED_EVENT` (renderer-registry.ts) that mounted
	 * <tool-message>/<tool-group> elements listen for and `requestUpdate()` on — the
	 * SAME mechanism the lazy-load path uses (`TOOL_RENDERER_LOADED_EVENT`). A bare
	 * `renderApp()` is NOT sufficient: the memoized tool components have unchanged
	 * reactive props, so their renderer would not re-run. A renderer calls this AFTER
	 * an action resolves so its locally-held result (renderer-local state, §4a) is
	 * painted. Client-only — touches no server state, no-op in non-DOM contexts.
	 * Renderers that mount their own LitElement use native reactivity and ignore this.
	 */
	requestRender(): void;

	/**
	 * Invoke a server action handler contributed by a tool.
	 * PHASE 1: implemented. POSTs /api/tools/:tool/actions/:action.
	 *
	 * `sessionId` and `toolUseId` are NOT parameters: they come from the render
	 * context the Host API was bound to (getHostApi(sessionId, toolUseId), §4c) and
	 * are supplied to the endpoint internally. `args` is therefore PURE action-domain
	 * input — it is whitelisted/validated by the handler and never carries identity
	 * fields like toolUseId. The bound toolUseId is always the renderer's OWN tool
	 * call; acting on a different tool call is not in scope (the host is bound to it).
	 * Resolves with the handler's JSON result; rejects on guard/handler failure.
	 */
	invokeAction<TArgs = unknown, TResult = unknown>(
		tool: string,
		action: string,
		args: TArgs,
	): Promise<TResult>;

	/**
	 * Call one of the CONTRIBUTING PACK'S OWN typed routes (the durable replacement for a
	 * raw gateway fetch). PHASE 2 (IMPLEMENTED). `name` resolves ONLY within
	 * the calling pack's `/api/ext/<thisPack>/*` namespace — it is impossible to address
	 * an arbitrary gateway path. Authorized through the same per-session `allowedTools`
	 * guard as `invokeAction` (§5). This is how a pack's renderer/panel fetches its OWN
	 * dynamic server data (e.g. the PR-walkthrough viewer reading its changeset bundle).
	 */
	callRoute<TResult = unknown>(name: string, init?: HostRouteInit): Promise<TResult>;

	/** Transcript + message capabilities. PHASE 2 (IMPLEMENTED). */
	readonly session: HostSessionApi;

	/** UI surface capabilities. PHASE 2 (IMPLEMENTED). */
	readonly ui: HostUiApi;

	/** Ownership-scoped persistence. PHASE 2 (IMPLEMENTED). */
	readonly store: HostStoreApi;
}

/**
 * Readonly capability map — the SINGLE SOURCE OF TRUTH for availability (`host.capabilities`).
 * Each named capability flag is `true` only when that capability is IMPLEMENTED on the
 * running host. Every namespace is ALWAYS present on the HostApi for type stability
 * (even when a host gates the capability off), so member-presence checks are unreliable;
 * this map is authoritative. Additive-only: a host flips a flag from `false` to `true`
 * (no version bump). On a current host every flag is `true`. The `has(name)` helper is a
 * string-keyed convenience over the same flags. */
export interface HostCapabilities {
	/** Phase-1 — always true on any v1 host. */
	readonly invokeAction: boolean;
	/** Phase-1 client-only — true in a DOM/renderer context. */
	readonly requestRender: boolean;
	/** Phase-2 — pack-scoped typed route calls. False on a Phase-1 host. */
	readonly callRoute: boolean;
	/** Phase-2 — transcript/message/event surface. False on a Phase-1 host. */
	readonly session: boolean;
	/** Phase-2 — panel/navigation surface. False on a Phase-1 host. */
	readonly ui: boolean;
	/** Phase-2 — ownership-scoped persistence. False on a Phase-1 host. */
	readonly store: boolean;
	/** Convenience: feature-detect by name; returns the flag, or false for unknown names. */
	has(name: string): boolean;
}

/** PHASE 2 — IMPLEMENTED. Typed request to a pack's OWN contributed route.
 *  No `path`/URL field exists by design: the route is addressed by its declared `name`
 *  within the pack's namespace, never by a gateway-relative path. */
export interface HostRouteInit {
	/** HTTP method for the route. Default "GET". */
	method?: "GET" | "POST" | "PUT" | "DELETE";
	/** JSON body (POST/PUT). Serialized by the host; never a raw string/stream. */
	body?: unknown;
	/** Typed query params appended to the route. */
	query?: Record<string, string | number | boolean>;
}

/** PHASE 2 — IMPLEMENTED. Read/post the current session's transcript.
 *  All shapes returned/accepted here are Host-API-OWNED contract types (below), produced
 *  by the internal→contract adapter — never Bobbit's internal wire format. */
export interface HostSessionApi {
	/** Read the current session's transcript (paginated envelope of HostMessages). */
	readTranscript(opts?: ReadTranscriptOpts): Promise<TranscriptEnvelope>;
	/** Read a single tool call (input + output) by tool_use id from this session. */
	readToolCall(toolUseId: string): Promise<ToolCallRecord | null>;
	/** Post a user/system message into the current session (may resume the agent turn). */
	postMessage(msg: PostMessageInput): Promise<void>;
	/** Subscribe to live, TYPED session events. Returns an unsubscribe fn. The callback
	 *  payload is discriminated on the event name (see HostSessionEventMap). */
	subscribe<E extends HostSessionEventName>(
		event: E,
		cb: (payload: HostSessionEventMap[E]) => void,
	): () => void;
}

/** PHASE 2 — IMPLEMENTED. Drive non-chat UI surfaces. Targets are STRUCTURED
 *  typed objects, never hash strings — so the contract never bakes in today's router. */
export interface HostUiApi {
	/** Open (or focus) a contributed panel, handing it typed params. */
	openPanel(target: PanelTarget): void;
	/** Navigate the SPA to a contributed route, by structured target. The host maps the
	 *  target onto whatever URL scheme the router uses; packs never construct URLs. */
	navigate(target: RouteTarget): void;
}

/** PHASE 2 — IMPLEMENTED. Ownership-scoped server persistence.
 *  Keys are namespaced to the contributing pack server-side; one pack cannot read
 *  another pack's store. Maps onto the `stores:` contribution. */
export interface HostStoreApi {
	get<T = unknown>(key: string): Promise<T | null>;
	put<T = unknown>(key: string, value: T): Promise<void>;
	list(prefix?: string): Promise<string[]>;
}

// ── Structured UI addressing (frozen; no hash strings) ──
export interface PanelTarget { panelId: string; params?: Record<string, unknown>; }
export interface RouteTarget { route: string; params?: Record<string, unknown>; }

// ── Host-API-OWNED data contracts (versioned by HOST_CONTRACT_VERSION) ──
// These are STABLE shapes the contract owns. Bobbit's internal session/message types are
// mapped onto them by the internal→contract adapter (Phase 2), decoupling packs from any
// internal refactor. They are deliberately NOT `unknown` mirrors of the internal wire.

/** A single transcript message in contract form. */
export interface HostMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: HostContentBlock[];
	/** Unix epoch milliseconds. */
	ts: number;
}

/** Discriminated union of message content blocks. Additive: new `type`s may be added in
 *  later contract versions; consumers must tolerate unknown types (render nothing). */
export type HostContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; toolUseId: string; tool: string; input: unknown }
	| { type: "tool_result"; toolUseId: string; output: unknown; isError: boolean };

/** A single tool call's input + output, in contract form. */
export interface ToolCallRecord {
	toolUseId: string;
	tool: string;
	input: unknown;
	output: unknown;
	isError: boolean;
}

export interface ReadTranscriptOpts { offset?: number; limit?: number; pattern?: string; }
export interface TranscriptEnvelope { total: number; returned: number; messages: HostMessage[]; }
export interface PostMessageInput { role: "user" | "system"; text: string; resumeTurn?: boolean; }

// ── Typed session events (frozen; payloads are discriminated, never bare `unknown`) ──
export interface HostSessionEventMap {
	/** A tool call produced (or updated) its result. */
	tool_result: { record: ToolCallRecord };
	/** The session's run status changed. */
	status: { status: "idle" | "running" | "error"; detail?: string };
	/** A new message was appended to the transcript. */
	message: { message: HostMessage };
}
export type HostSessionEventName = keyof HostSessionEventMap;
```

### 3.1 Exposure to renderers (`ToolRenderContext` extension)

`src/ui/tools/types.ts` gains one optional field. Built-in renderers ignore it and are
**unchanged**:

```ts
export interface ToolRenderContext {
	toolUseId?: string;
	toolCallInput?: unknown;
	sessionId?: string;
	goalId?: string;
	getAskResponseAnswers?: (toolUseId: string) => /* …unchanged… */ null;

	/** NEW: Phase-1 Host API. Present for ALL renderers (built-in + pack). Built-in
	 *  renderers ignore it; pack renderers use it for invokeAction / requestRender
	 *  (there is no gateway.fetch — invokeAction is the sole pack→server path).
	 *  Optional so unit fixtures that construct a bare ctx keep compiling. */
	host?: HostApi;
}
```

`Messages.ts` (≈ line 691) and `ToolGroup.ts` (≈ line 165) construct the ctx; they add
`host: getHostApi(sessionIdCtx, toolUseIdCtx)` (the client Host API impl, §4c) — binding
the Host API to BOTH the session id and the renderer's own `toolUseId`, so
`invokeAction(tool, action, args)` keeps its clean frozen signature while still supplying a
verified `toolUseId` to the endpoint internally. No other renderer call sites change.

### 3.2 Pack-identity binding (TRUSTED, server-derived — never caller-supplied)

The durability + isolation claims for the scoped Phase-2 capabilities — `callRoute`
addressing only the pack's OWN `/api/ext/<thisPack>/*` namespace, and `store.*` keys
namespaced to the owning pack — rest on the Host API knowing **which pack** it belongs to.
A Host API instance is therefore bound not only to `sessionId`/`toolUseId` but to a
**TRUSTED pack identity** that extension code can never set or forge.

**Internal construction contract.** Beyond the Phase-1 client `getHostApi(sessionId,
toolUseId)`, the durable construction shape is:

```ts
// internal — NOT a pack-callable API; identity fields are host-derived, never caller-supplied.
createHostApi({ sessionId, toolUseId, packId, contributionId }): HostApi
```

`packId` and `contributionId` are derived from the **RESOLVED WINNING contribution /
module-load context** — the very same pack-precedence resolution that served the renderer
or loaded the actions module — NOT from any caller-supplied name, query param, or `args`
field. There is no parameter through which a renderer/handler can name a different pack.

**How the binding is established per surface:**

- **Renderers (Phase 1):** the identity comes from the resolved pack tool whose renderer
  Blob was served — `GET /api/tools/:tool/renderer` resolved the winning
  `{baseDir, groupDir, rendererFile}` via `resolveToolLocation(tool)`; that winning
  `baseDir` (the market-pack root) IS the pack identity. The client loader closes over the
  tool name + project scope it fetched the Blob for, so a renderer is structurally tied to
  the pack that won that tool name.
- **Server action handlers (Phase 1):** the dispatcher already resolves the winning
  provider / on-disk location via `ToolManager.resolveToolLocation` before loading
  `actions.js`. **That resolution IS the pack identity** — the `baseDir`/`groupDir` of the
  loaded module determine `packId`; the handler's `ctx` carries it as a host-derived field,
  never read from `args`/body.
- **Panels + entrypoints (Phase 2):** identity comes from the contribution that registered
  them — the resolved `panels:`/`entrypoints:` entry's owning pack — established at
  contribution-load time exactly as renderers/actions are, and threaded into the panel's
  `createHostApi` call.

**How `callRoute`/`store` authorization USES it (server-side).** The gateway keys
`/api/ext/<pack>/*` route dispatch and store-namespace ownership off the **SERVER-RESOLVED**
pack identity (derived from the session + tool/contribution resolution above), never off a
client-claimed pack/name in the request. So:

- `callRoute(name, init)` resolves `name` ONLY within the bound pack's own `routes:`
  namespace; the gateway computes the `<pack>` segment from the server-resolved identity, so
  one pack physically cannot address another pack's routes or an arbitrary gateway path.
- `store.get/put/list` prefixes every key with the bound pack's namespace server-side, so
  one pack cannot read or write another pack's store.

This server-derived-identity rule is exactly what makes the Phase-2 scoping **durable and
secure**: because the pack segment is never client-influenced, no Phase-2 implementation can
widen it without re-opening the contract — and the LLM (which can forge `args`/`sessionId`/
`toolUseId`) has no field through which to impersonate another pack.

**Phase-2 hardening — the server-minted surface-binding token (implemented).** §3.2's
"identity is a host-derived closure field" was the client-trust half; the wire half needed
hardening. Threading the contributing `tool` through the client closure stops a
*well-behaved* pack from naming another pack, but on the wire that identity was still a
plain `tool` field a raw request could set to *another* pack's tool. Phase 2 closes this
with `src/server/extension-host/surface-binding.ts`: when the trusted app first constructs a
surface's Host API it calls `POST /api/ext/surface-token` with the surface's `tool`; the
server authorizes it, resolves the winning contribution (the same resolution that *is* the
pack identity), and mints an opaque **HMAC-signed token bound to
`{sessionId, packId, contributionId, tool}`**. The client holds the token in the Host API
**closure** (pack module code never sees it) and echoes it on every scoped call; each scoped
endpoint re-validates the signature + TTL, re-resolves the identity (rejecting a token gone
stale after an uninstall/precedence change), and uses the **derived** `{packId, tool}`,
ignoring any caller-supplied value. See the Model-A residual in §3.4 and `marketplace.md`.

### 3.3 Internal→contract adapter layer (`contract-adapter.ts`)

The Host-API-owned data shapes (`HostMessage`, `HostContentBlock`, `ToolCallRecord`, the
typed `HostSessionEventMap` payloads) are deliberately **not** mirrors of Bobbit's internal
transcript wire format. The decoupling layer that maps one onto the other is
`src/server/extension-host/contract-adapter.ts`, implemented in Phase 2:

- `transcriptToHostMessages(jsonl)` parses a session's transcript JSONL rows into
  `HostMessage[]`, and `transcriptToToolCall(jsonl, toolUseId)` extracts a single
  `ToolCallRecord`. The mapping **generalizes the row-walk already proven in
  `action-guard.ts::transcriptHasToolUse`** — it tolerates both the Anthropic
  (`{type:"tool_use", id, name}`) and the pi-coding-agent (`{toolCallId, toolName}`) row
  shapes, emitting contract blocks instead of a boolean.
- It re-exports `CONTRACT_VERSION === HOST_CONTRACT_VERSION`, so a pack can feature-detect
  contract-shape additions independently of `HOST_API_VERSION`.

**Why a separate layer.** This is the seam that lets Bobbit refactor its internal
session/message representation freely without breaking any installed pack — packs only ever
see the versioned contract shapes. Both `host.session.readTranscript`/`readToolCall`
(server-side) and `host.session.subscribe` (the client event bridge maps live WS events
through the same contract shapes) route through this adapter. A practical hardening rides
here too: the `pattern` filter on `readTranscript` is a **literal, case-insensitive
substring** match, never compiled with `new RegExp(...)`, so a caller-controlled pattern
cannot trigger catastrophic-backtracking ReDoS — the frozen `pattern?: string` type is
satisfied either way.

### 3.4 Isolation model (Model A) — code ORIGIN is the boundary

Phase 2's security posture rests on one distinction: **the trust boundary is code ORIGIN,
not the thread the code runs on.** A pack installed from the market is *trusted* — the same
tier as a tool or an MCP server the user chose to install; content produced by the agent/LLM
at runtime is *untrusted*. The surfaces split accordingly:

- **Pack UI code** (renderers, panels, entrypoints) is TRUSTED and runs in the **main UI
  thread**; it may touch app globals (it shares the realm). Its blast radius is bounded by
  the Host API being its only privileged surface.
- **Agent/LLM-influenced CONTENT** (model output, transcript text, artifact HTML) is ALWAYS
  rendered in a `sandbox`-attributed iframe (theme tokens only, no auto-invoke/navigation on
  mount) — so a prompt-injected artifact cannot reach app globals even though the trusted
  panel framing it can.
- **Pack SERVER modules** (`actions:` / `routes:`) are TRUSTED code — the same tier as a
  tool or MCP server — and run with **FULL ambient parity**: normal `node:` built-ins
  (`fs`/`child_process`/`net`/`http`…), normal network globals (`fetch`/`WebSocket`), and the
  normal `process` with full env. They run in a `worker_threads` worker
  (`src/server/extension-host/module-host-worker.ts`) purely for **RESOURCE + CRASH
  isolation** — terminate-on-timeout (the CPU control: a runaway `while(1)` is killed via
  `worker.terminate()`), memory caps via `resourceLimits`, and spawned-child SIGKILL on
  terminate. There is **no in-worker capability gate**: gating ambient OS access for trusted
  in-process code is false security (a native `.node` addon or the shared process trivially
  defeats it), so the worker neither claims nor relies on one. Separately, the pack module
  graph's `import`/`require` resolution is contained to the pack root
  (`confinement-loader.ts` + `path-guard.ts`) — but this is **cheap import hygiene /
  loader-stability, NOT a security boundary** (it is near-cosmetic now that `fs` is ambient:
  a pack can read any file the gateway can). The worker isolation is **unconditional in
  shipped builds** — there is no config/env toggle that runs a pack server module in-process
  (such a path would defeat terminate-on-timeout / crash containment), pinned by a
  config-invariant test.

**There is no capability concept — trusted pack server code gets ambient parity.** A pack's
server modules reach `node:child_process`, `node:fs`, outbound network, and `process.env`
exactly as a tool or MCP server would; nothing is gated or disclosed via a manifest key. The
only `workingDir`-driven adjustment is **tool parity**: the worker's `process.cwd()` returns
the server-derived session working dir (worker threads cannot `chdir`, so `process.cwd` is
overridden) — a convenience required by e.g. the pr-walkthrough pack's `git diff`, not a
capability. The Host API stays the single ENFORCED boundary for everything CROSS-pack,
cross-session, or UI-driving (`store`/`session`/`callRoute`/`ui.*`); a pack's OWN ambient
capability is not one of those boundaries.

**Model-A residual (the documented future hardening).** In the shared main UI realm a
*deliberately malicious* pack could still mint its own surface token for any tool name it
knows, read another surface's token out of a shared closure, or monkey-patch `fetch` /
`WebSocket.prototype.send`. The surface-binding token (§3.2) and the session-write permit
(§5) close the *accidental* and *non-pack-reachable* paths and make the Host API the only
*sanctioned* identity path — they are NOT claimed as a defense against a same-realm
adversary. TRUE cross-pack UI isolation needs **per-pack realm isolation** (running pack UI
in a separate iframe/worker realm), which Model A de-scopes; the server-side authorization +
audit are the durable boundary regardless of client realm.

---

## 4. Phase-1 build plan

### 4a. Renderer module serving + runtime lazy registration

**Problem.** The UI is a Vite bundle; pack renderers live on disk under
`market-packs/<pack>/tools/<group>/`. Today the `renderer:` YAML field points at a
`src/…` source path and is **display-only** — registration is hardcoded in
`src/ui/tools/index.ts`. So for built-ins the field is not load-bearing. For packs we must
(1) ship the renderer to the browser and (2) register it at runtime so it survives reload.

**Decision: serve a pre-built ESM module + factory toolkit (no bare imports).**

- A pack renderer is authored as a **pre-built ES module** (the pack ships the compiled
  `.js`, not `.ts` — Bobbit does not compile pack UI). Its default export is a **factory**
  that receives a host-supplied toolkit and returns a `ToolRenderer`:

  ```js
  // market-packs/retry-demo/tools/demo/SampleActionRenderer.js  (authored by pack)
  // A module-level Map keyed by toolUseId holds the latest action result, so the
  // renderer survives re-mounts (transcript re-render) without mutating the transcript —
  // exactly the children-mutation-approval pattern (src/ui/lazy/children-mutation-approval.ts).
  export default function createRenderer({ html, nothing, renderHeader }) {
    const lastResult = new Map(); // toolUseId → handler JSON
    return {
      render(params, result, isStreaming, ctx) {
        const shown = lastResult.get(ctx?.toolUseId);
        const onRetry = async () => {
          const data = await ctx.host?.invokeAction("sample_action", "retry", {});
          lastResult.set(ctx.toolUseId, data);   // store handler result locally
          ctx.host?.requestRender?.();           // ask the host to re-render this block
        };
        return {
          isCustom: false,
          content: html`
            <div class="flex items-center justify-between gap-2">
              <!-- renderHeader tolerates a null icon (skips the icon span), so a
                   toolkit-only pack renderer needn't ship a lucide icon node. -->
              ${renderHeader(result?.isError ? "error" : "complete", null, "Sample")}
              ${shown ? html`<span data-testid="pack-result">${shown.message}</span>` : nothing}
              <button data-testid="pack-retry" @click=${onRetry}>Retry</button>
            </div>`,
        };
      },
    };
  }
  ```

  **Action-result propagation contract (Phase 1) — renderer-local state, no transcript
  mutation.** `host.invokeAction` resolves with the handler's JSON result. The renderer
  owns that result: it stores it in **local component state** (a module-level `Map` keyed by
  `toolUseId`, or a mounted `LitElement` with `@state` — both survive transcript re-render)
  and re-renders its own DOM. This is byte-for-byte the existing
  `children-mutation-approval` mechanism (a `LitElement` with `@state` + a module-level
  `decisionMemory` map keyed by `requestId` — it never mutates the transcript). Phase 1
  adds one small host hook, `ctx.host.requestRender()`, which dispatches a dedicated
  `TOOL_RENDER_REQUESTED_EVENT` (renderer-registry.ts) that mounted
  `<tool-message>`/`<tool-group>` elements listen for and `requestUpdate()` on — the SAME
  force-repaint mechanism the lazy-load path uses (`TOOL_RENDERER_LOADED_EVENT`). A bare
  `renderApp()` is NOT enough: the memoized tool components have unchanged reactive props,
  so their renderer would not re-run and the post-action local state would never paint.
  Renderers that mount their own `LitElement` use its native reactivity instead and ignore
  `requestRender`. The tool-call
  `result` passed to `render()` is **unchanged** by an action — actions do NOT rewrite the
  transcript or the persisted tool result (renderers that genuinely need to resume the
  agent turn or post a message use the separate, user-gesture-gated `host.session.*`
  capability — implemented in Phase 2). The
  E2E (§8.2) asserts the renderer's OWN DOM updates (the `pack-result` element reflects the
  handler's returned value) after the click.

  Passing `html`/`nothing`/`renderHeader` from the **host's own `lit` instance** sidesteps
  bare-import resolution and the dual-lit-singleton hazard entirely. (Rejected alternative:
  shipping an import map mapping `lit` → the app's bundled chunk — fragile across builds
  because chunk names are content-hashed, and a second lit instance breaks reactive
  directives. Documented here so Phase 2 doesn't reopen it.)

- **Gateway endpoint** `GET /api/tools/:tool/renderer?projectId=<id>` (`server.ts::handleApiRoute`):
  resolve the tool's winning `{baseDir, groupDir, rendererFile, rendererKind}` via
  `resolveToolLocation(tool)` on the PROJECT-scoped tool manager when a `projectId` query
  param is present (`(projectId ? projectContextManager.getOrCreate(projectId)?.toolManager : undefined) ?? toolManager`
  — the same `?? toolManager` fallback as `GET /api/tools`, via the shared
  `resolveActionToolManager` helper). This avoids a split-brain where a project-scope pack
  (or a project pack shadowing a same-named global tool) would serve the wrong global
  renderer; the client threads its active `projectId` into the renderer Blob fetch so it
  resolves the SAME winner the `/api/tools` metadata reported. Resolution is a
  provider-INDEPENDENT lookup sourced from `loadToolDefinitions` (a pack renderer needs NO
  `provider:`); require
  `rendererKind === "pack"`; read the file at
  `path.join(baseDir, groupDir, rendererFile)` (re-validate the path stays within
  `baseDir/groupDir` — reject traversal); respond `200 text/javascript` with
  `Cache-Control: no-cache` (renderers change on pack update). 404 if no pack renderer.
  **This endpoint requires the admin bearer like every `/api/*` route, but NOT a
  per-session `allowedTools` check.** Serving the renderer MODULE BYTES is not a server
  capability invocation — it is equivalent to serving a static UI asset, and the renderer
  JS is trusted pack source (trust decided at source-add time). The allowedTools guard
  applies to the *action* endpoint (capability invocation), not to module delivery; the
  UI-thread risk (§5 control v) is handled client-side and is unchanged. Path-traversal
  re-validation on the renderer file path stays.

- **Client bootstrap** `src/app/pack-renderers.ts` (NEW), called once on cold load from
  the app init path (after `/api/tools` is first fetched, alongside existing tool-manager
  data flow):

  ```ts
  // src/app/pack-renderers.ts (NEW)
  import { registerLazyToolRenderer } from "../ui/tools/renderer-registry.js";
  import { html, nothing } from "lit";
  import { renderHeader } from "../ui/tools/renderer-registry.js";
  import { gatewayFetch } from "./gateway-fetch.js";

  const HOST_TOOLKIT = { html, nothing, renderHeader };

  /** Idempotent + RECONCILING: registers a lazy loader for every pack tool that ships a
   *  renderer, and tears down any name it previously pack-registered that is no longer
   *  `rendererKind:"pack"` in the fresh metadata (uninstall / precedence change — §4a
   *  uninstall reconciliation). Re-driven on every cold load AND after marketplace
   *  install/uninstall (which re-fetches /api/tools). The active `projectId` is threaded
   *  in so the renderer Blob fetch resolves the SAME winner the metadata fetch saw (no
   *  split-brain). `{ override: true }` makes the pack loader the EFFECTIVE renderer even
   *  when an eager builtin of the same name is already registered — because
   *  `rendererKind === "pack"` means the pack is the resolved WINNING provider for that
   *  tool name (it shadowed the builtin tool), so its renderer must win too. */
  export function registerPackRenderers(tools: Array<{ name: string; rendererKind?: string }>, projectId?: string): void {
    const next = new Set<string>();
    for (const t of tools) {
      if (t.rendererKind !== "pack") continue;
      next.add(t.name);
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      registerLazyToolRenderer(t.name, async () => {
        const url = `/api/tools/${encodeURIComponent(t.name)}/renderer${qs}`;
        const resp = await gatewayFetch(url);              // authed (admin bearer); no session binding needed
        if (!resp.ok) throw new Error(`renderer ${t.name} HTTP ${resp.status}`);
        const blob = await resp.blob();
        const objUrl = URL.createObjectURL(blob.slice(0, blob.size, "text/javascript"));
        try {
          const mod = await import(/* @vite-ignore */ objUrl);
          const factory = (mod as any).default ?? (mod as any).createRenderer;
          if (typeof factory !== "function") throw new Error("renderer module has no factory export");
          return factory(HOST_TOOLKIT);                     // → ToolRenderer
        } finally {
          URL.revokeObjectURL(objUrl);
        }
      }, { override: true });
    }
    // RECONCILE: unregister any previously pack-owned name absent from `next`.
    for (const name of packRegistered) if (!next.has(name)) unregisterPackRenderer(name);
    packRegistered = next;
  }
  ```

  **Uninstall reconciliation (no reload, §4a).** `registerLazyToolRenderer(name, loader,
  { override: true })` STASHES whichever built-in it displaces in a `displacedBuiltins`
  map as a discriminated value — `{ kind: "eager", renderer }` for an eager `toolRenderers`
  entry OR `{ kind: "lazy", loader }` for a `pendingLazy` loader that has not loaded yet
  (many builtins are registered lazily, e.g. `team_*`/`task_*`/`gate_*` in
  `tools/index.ts`). The new `unregisterPackRenderer(name)` drops the name from every
  registry map (`toolRenderers`, `pendingLazy`, `inFlight`, `packOwned`) and RESTORES the
  stashed built-in accordingly — re-`set`ting the eager renderer, or re-arming the
  `pendingLazy` loader so the next `getToolRenderer` lazy-loads the REAL builtin (under the
  bumped generation, so the prior pack load cannot resurrect) — else it leaves the tool to
  default rendering. It then dispatches the standard renderer-loaded event so mounted
  `<tool-message>`/`<tool-group>` blocks repaint immediately. `registerPackRenderers` calls
  it for any name it previously registered that the fresh `/api/tools` no longer reports as
  a pack renderer — so a marketplace uninstall (which re-drives
  `registerPackRenderers(await fetchTools(projectId), projectId)`) removes the pack
  renderer from the RUNNING UI without a page reload.

  **Registration follows the active session's project (§4c).** The lazy loader closes over
  `projectId` (it fetches the project-scoped renderer Blob). Boot registers with the boot
  active/default project, but a page reload or deep-link into a session whose project
  differs must re-resolve: `reconcilePackRenderersForProject(projectId)` (pack-renderers.ts)
  fetches `/api/tools` scoped to that project and re-drives `registerPackRenderers` with the
  CURRENT project id. It is called at boot AND whenever the ACTIVE session's project is
  established/changes (session-manager.ts, alongside `applyProjectPalette(...projectId)`),
  fire-and-forget + try/catch so it never blocks the session switch. A cheap dedupe guard
  skips a redundant re-drive when the project is unchanged; on a REAL change
  `registerPackRenderers` re-registers (override) every pack tool with the new project id —
  the Wave-6 generation guard drops any stale in-flight/loaded module so the loader is
  SWAPPED to the new project's renderer — and unregisters names absent for the new project.

  **The reconcile is generation-guarded against out-of-order fetch completion (Wave-9B).**
  `reconcilePackRenderersForProject` is async (it `await`s `/api/tools`), so two reconciles
  can be in flight at once (e.g. a slow `reconcile(A)` from a boot/session-switch followed by
  a fast `reconcile(B)`). The registry is GLOBAL, so a late `A` response must NOT overwrite
  loaders already applied for `B`. Each call captures a module-scoped `++reconcileGeneration`
  token BEFORE the await and, after the fetch resolves, applies ONLY if its token still
  equals the live counter — a newer reconcile supersedes it and the stale response is
  dropped (no `registerPackRenderers`, no dedupe mutation). The dedupe marker
  (`lastReconciledProject`) is set ONLY after a successful, non-superseded apply (never
  before the await): a failed or superseded attempt does not poison the dedupe, so a
  retry/re-drive still works and the registry always ends matching the LAST REQUESTED
  project — never whichever fetch happened to resolve last.

  **Marketplace mutations reconcile to the active session's project, never the marketplace's
  focused project (Wave-9B).** The marketplace page tracks a `focusProjectId` for the
  *install scope* segment (which project an install/update/uninstall targets). Because the
  renderer registry is GLOBAL, refreshing it after a mutation must follow the ACTIVE CHAT
  SESSION's project (`marketplace-page.ts::activeSessionProjectId()` — the active session's
  own `projectId`, falling back to `state.activeProjectId`, mirroring what session-manager
  threads on connect), NOT `currentProjectId()` (the focused project). Otherwise a
  project-scope install/uninstall for a NON-active project would immediately clobber the
  renderers the still-active session uses, and returning from settings without a session
  switch would never reconcile back. `reconcileRenderersForActiveSession()` FORCES a
  re-fetch + re-register (the mutation changed the pack set, so the dedupe-guarded reconcile
  alone would skip it) but ALWAYS scopes it to the active session's project — reconciling the
  global registry back to that project.

  `registerLazyToolRenderer` already returns the **placeholder** on first
  `getToolRenderer` and installs the **load-failure** fallback on loader rejection
  (`renderer-registry.ts::startLoad`) — both reused unchanged. Registration is re-driven
  from metadata on every cold load, so it **survives page reload** with no install-time
  state.

  **All registry mutations route through ONE generation-guarded chokepoint
  (`applyRegistration`); stale deferred applies are structurally dropped (Wave 10C).** The
  recurring TOCTOU class was per-call-site: each writer path independently had to remember
  to bump/check the `loadGeneration` token, and a writer that forgot (e.g. the eager
  `registerToolRenderer`, which did NOT bump the generation) reopened the race — a non-pack
  lazy load already in flight could resolve later and overwrite a newer eager registration.
  The fix is structural: EVERY change to what a tool name resolves to — eager
  `registerToolRenderer`, `registerLazyToolRenderer` (incl. `{override}`),
  `unregisterPackRenderer`, and the deferred `startLoad` success/failure applies — now
  passes through a single internal `applyRegistration(toolName, capturedGen, mutate, opts)`
  helper, and `toolRenderers`/`pendingLazy` are ONLY ever written from inside its `mutate()`
  callback. The helper has two modes:

  - **Immediate intent** (`capturedGen === null`): a registration/removal that supersedes
    prior intent. It FIRST bumps `loadGeneration[toolName]` (and drops the shared `inFlight`
    promise), so any in-flight lazy load for the name can no longer resurrect over the write,
    then applies `mutate()` unconditionally. `registerToolRenderer` now uses this path —
    closing the eager gap with the same guard every other writer already used.
  - **Deferred apply** (`capturedGen` is the token `startLoad` captured before awaiting,
    with `opts.ownPromise` set): it cleans up ONLY this load's own `inFlight` entry
    (identity-checked, so a fresh load's newer promise is never clobbered), then applies
    `mutate()` ONLY if the captured generation is still current — else the load resolves to a
    **no-op** (no `toolRenderers` write, no resurrecting repaint). The load-failure path is
    guarded identically (a superseded failure also skips the fallback install + the
    `console.error`).

  So whether a stale in-flight load is superseded by an uninstall, a pack `{override}`, OR a
  newer eager registration, the late resolve cannot defeat the reconciliation — the
  invariant lives in exactly one place instead of being re-derived (and forgotten) per
  writer. A writer-ordering matrix in `tests/lazy-renderer-placeholder.spec.ts` pins each
  ordering and asserts both the winning renderer AND that no resurrecting repaint event
  fired for the superseded resolve.

  **Renderer precedence honors the winning-provider decision (no split-brain).** A pack
  that shadows a built-in interactive tool resolves to `rendererKind: "pack"` (its
  `baseDir` is the market-pack root that won the tool name in `ToolManager`'s cascade), so
  it must serve the PACK renderer, not the eager builtin — otherwise it would get pack
  *actions* but the built-in *renderer*, breaking the litmus parity goal. The concrete
  mechanism: `registerLazyToolRenderer(name, loader, { override?: boolean })` gains an
  `override` option. When `override` is true the registry **deletes any eager
  `toolRenderers` entry** for `name` and records the name as pack-owned, so the lazy pack
  loader becomes the effective renderer; a later eager registration for a pack-owned name
  is ignored. Pack registration always runs after the synchronous eager registrations in
  `tools/index.ts` (it is driven from the `/api/tools` fetch), so override reliably wins.
  `getToolRenderer` stays eager-first and unchanged — override guarantees no eager entry
  survives for pack-owned names. A built-in NOT shadowed by any pack keeps its eager
  renderer (unchanged).

  > **Serving via Blob URL vs direct URL.** `import(objUrl)` from a Blob avoids
  > cross-origin/module-MIME edge cases and works identically in dev (Vite) and prod
  > (static `dist/`). The `/* @vite-ignore */` stops Vite from trying to pre-bundle a
  > runtime URL. The fetch is authed (the bare module URL would not carry the bearer).

**Renderer authoring constraints (a pack renderer MUST honor these).**

- **Theme tokens ONLY.** No hardcoded colours (no hex/`rgb()`/named colours). Reference the
  design-system CSS custom properties (`var(--background)`, `var(--foreground)`,
  `var(--card)`, `var(--muted-foreground)`, `var(--border)`, `var(--primary)`, the
  `--chart-1..6` categorical palette, and the `--positive`/`--negative`/`--warning`/`--info`
  semantic slots) or the project's Tailwind utility classes that map onto them, so the
  renderer tracks dark/light/palette switches like every built-in renderer. Do not define a
  private `:root{}` palette and do not use `prefers-color-scheme`.
- **Preserve iframe `sandbox` attributes.** A renderer that embeds an `<iframe>` (preview /
  artifact-style surfaces) MUST keep the existing `sandbox` attribute set — it is a security
  control, not styling; never widen or drop it. Renderers run on the main UI thread over
  LLM-influenced data (§5 control v), so the sandbox is load-bearing.
- **`isCustom` / card-wrapper contract.** `render()` returns `{ content, isCustom }`.
  `isCustom: false` (the default for the litmus sample) means the host WRAPS `content` in
  the standard tool card (border, padding, header alignment) — emit only the inner content
  and use `renderHeader(state, icon, label)` for the header row, matching every built-in.
  `isCustom: true` means the host applies NO card wrapper and the renderer owns its entire
  visual frame (the artifact-pill / full-surface pattern) — it must then supply its own
  spacing/border so it sits correctly among carded blocks. Pack renderers SHOULD prefer
  `isCustom: false` unless they intentionally own the whole surface. The placeholder and
  load-failure fallbacks both use `isCustom: false`, so a wrapped renderer swaps in without
  layout shift.

**Files touched (4a):** `src/server/server.ts` (+1 route), `src/server/agent/tool-manager.ts`
+ `builtin-config.ts` (`rendererKind`), `src/app/api.ts` (`ToolInfo` wire fields),
`src/app/pack-renderers.ts` (NEW), one app-init call site, `src/ui/tools/types.ts`.

### 4b. Actions module resolution + endpoint + dispatch

**Module resolution (mirror ToolManager precedence).** A new
`src/server/extension-host/action-dispatcher.ts`:

```ts
// src/server/extension-host/action-dispatcher.ts (NEW)
export interface ActionHandlerCtx {
	/** Phase-1 server Host API surface (scoped, audited). No raw fetch/process/fs. */
	host: ServerHostApi;
	/** The verified calling session id. */
	sessionId: string;
	/** The verified tool_use id this action is acting on. */
	toolUseId: string;
	/** The tool name (== :tool). */
	tool: string;
}
export type ActionHandler = (ctx: ActionHandlerCtx, args: unknown) => Promise<unknown>;
export type ActionsModule = { actions: Record<string, ActionHandler> };

export class ActionDispatcher {
	constructor(private toolManager: ToolManager) {}

	/** Resolve {baseDir, groupDir, actionsModule} for the WINNING tool via
	 *  resolveToolLocation (full cascade incl. market roots, provider-independent) and
	 *  load <baseDir>/<groupDir>/<module>. Cached by abs-path + mtime. */
	private async loadModule(tool: string): Promise<ActionsModule | null> { /* … */ }

	/** Phase-1 entry point. Throws ActionError with a status code on any failure. */
	async dispatch(tool: string, action: string, ctx: ActionHandlerCtx, args: unknown): Promise<unknown> { /* … */ }

	/** Drop cached modules. Called from invalidateResolverCaches(). */
	invalidate(): void { this.cache.clear(); }
}
```

Resolution uses `resolveToolLocation(tool)` (a provider-INDEPENDENT lookup that
resolves through the full builtin < market < user cascade in `loadToolDefinitions`) to
obtain `baseDir` + `groupDir` + the `actions.module` path (default `"actions.js"`) in one
call — a pack actions module needs NO `provider:`. **The resolver is the SESSION's**
**project-scoped tool manager**, not the server-level one: the endpoint derives the project
from the session (`sessionManager.getSession(sid)?.projectId ?? getPersistedSession(sid)?.projectId`)
and resolves `(projectId ? projectContextManager.getOrCreate(projectId)?.toolManager : undefined) ?? toolManager`
(the shared `resolveActionToolManager` helper). The SAME session-project manager is used
for BOTH the `getToolByName` metadata (allowlist / `hasActions` / `actionNames`) AND the
location the `ActionDispatcher` consumes (passed as `dispatch(..., resolver)`), so the
winning provider the dispatcher loads matches what the session's tool resolution sees — no
split-brain, and a project-scope pack (or a project pack shadowing a global tool) dispatches
its OWN handler. With no project (server/global scope) the `?? toolManager` fallback keeps
the path byte-identical. Load via
`await import(pathToFileURL(abs).href)`. **Cache** is a
`Map<absPath, { mtimeMs; epoch; module }>`; a stale mtime reloads (mirrors `scanToolsDirCached`),
and an `epoch` counter (bumped by `invalidate()`) cache-busts the import URL so a
post-invalidate load is fresh even under coarse (Windows) mtime resolution. **In-flight loads
are epoch-guarded** (analog of the renderer `loadGeneration` guard, §4a): `loadModule`
snapshots the epoch before `await import(...)` and only caches the result if the epoch is
unchanged on resolve — otherwise it re-loads under the advanced epoch (bounded retry), so an
`invalidate()` racing an in-flight import can never cache a stale module under the fresh epoch.

**Endpoint** `POST /api/tools/:tool/actions/:action` in `server.ts::handleApiRoute`,
modeled on the `/api/internal/mcp-call` handler. Body `{ sessionId, toolUseId, args }`.
Flow (full guard sequence in §5):

```
1. require x-bobbit-session-id header  → else 403      (HEADER is the canonical identity)
2. require body.sessionId === headerSessionId          → else 403 (reject cross-session)
3. resolve session (live or persisted via projectContextManager) → else 403
4. require :tool ∈ session.allowedTools (same check as mcp-call:10974) → else 403
5. if actions.names present, require :action ∈ names → else 404
6. verify toolUseId exists in THE HEADER-BOUND session AND was a call of :tool → else 409 (§5 iii)
7. rate-limit + concurrency-cap check → else 429
8. dispatcher.dispatch(...) under per-call timeout + try/catch
9. audit-log {tool, action, sessionId, toolUseId, caller, outcome, ms}
10. json(result)   |   json({error}, 4xx/500) on failure

# Session identity is single-sourced from the x-bobbit-session-id HEADER. The body
# sessionId is accepted only to fail fast on a mismatch (step 2); ALL downstream checks
# (allowedTools, toolUseId ownership, transcript scan) use the header-bound session, so an
# action can never authorize with one session and inspect/act on another's transcript.
```

**Cache invalidation (synchronous).** `invalidateResolverCaches()` in `server.ts`
already runs on install/update/uninstall and on the pack-order PUT. Add
`actionDispatcher.invalidate()` to it:

```ts
const invalidateResolverCaches = (): void => {
	invalidateSlashSkillsCache();
	__resetToolScanCache();
	actionDispatcher.invalidate();   // NEW — drop loaded actions modules
};
```

That single chokepoint guarantees a freshly installed/updated/removed pack's handlers are
picked up (or dropped) on the very next call, with no client reload.

**Files touched (4b):** `src/server/extension-host/action-dispatcher.ts` (NEW),
`src/server/extension-host/server-host-api.ts` (NEW, `ServerHostApi`),
`src/server/server.ts` (+1 route, +1 line in `invalidateResolverCaches`, construct the
dispatcher near `toolManager`).

### 4c. Client Host API impl + ctx wiring

```ts
// src/app/host-api.ts (NEW)
import { gatewayFetch } from "./gateway-fetch.js";
import { renderApp } from "./state.js";   // existing top-down re-render entry point
import { HOST_API_VERSION, HOST_CONTRACT_VERSION, type HostApi } from "../shared/extension-host/host-api.js";

/** Build the client Host API bound to a given session AND the renderer's own
 *  toolUseId. invokeAction supplies BOTH to the endpoint internally, so packs never put
 *  identity fields in `args`. Every Phase-2 namespace is now IMPLEMENTED, so
 *  `capabilities` reports them all `true`; authors still feature-detect via
 *  `capabilities.has(name)` rather than member presence. There is NO gateway member
 *  — invokeAction is the only pack→server action path; the scoped capabilities
 *  (`callRoute`/`store`/`session`) ride server-minted surface tokens (§3.2).
 *
 *  This is the CLIENT-side construction; the server analogue is the internal
 *  `createHostApi({ sessionId, toolUseId, packId, contributionId })` contract (§3.2),
 *  where packId/contributionId are SERVER-DERIVED from the resolved winning contribution
 *  — never passed by extension code. */
export function getHostApi(sessionId: string | undefined, toolUseId: string | undefined): HostApi {
	// Every capability is implemented. `capabilities` is the single source of truth;
	// authors feature-detect with `capabilities.has(name)`, never member presence.
	const flags = { invokeAction: true, requestRender: true, callRoute: true, session: true, ui: true, store: true };
	return {
		version: HOST_API_VERSION,
		contractVersion: HOST_CONTRACT_VERSION,
		capabilities: { ...flags, has: (name: string) => (flags as Record<string, boolean>)[name] === true },
		requestRender: () => {
			// renderApp() alone won't re-run the memoized tool components (props
			// unchanged); requestToolRender() dispatches TOOL_RENDER_REQUESTED_EVENT
			// so mounted <tool-message>/<tool-group> requestUpdate() and repaint (§4a).
			try { renderApp(); } catch { /* non-DOM (unit) — no-op */ }
			requestToolRender();
		},
		async invokeAction(tool, action, args) {
			// sessionId + toolUseId come from the bound render context, NOT from args.
			// args is pure action-domain input, validated/whitelisted by the handler.
			const resp = await gatewayFetch(
				`/api/tools/${encodeURIComponent(tool)}/actions/${encodeURIComponent(action)}`,
				withSession({ method: "POST", body: JSON.stringify({ sessionId, toolUseId, args }) }, sessionId),
			);
			if (!resp.ok) throw new Error(`invokeAction ${tool}/${action} HTTP ${resp.status}`);
			return resp.json();
		},
		// Scoped capabilities ride a server-minted surface token (§3.2); the server
		// derives {packId, tool} from it and ignores any caller-supplied identity.
		callRoute: async (name, init) => { /* POST /api/ext/route/:name with the surface token */ },
		session: { /* readTranscript/readToolCall (own-session); postMessage (WS permit + gesture); subscribe (event bus) */ } as HostApi["session"],
		ui: { openPanel: (target) => openPackPanel(target), navigate: (target) => navigateToTarget(target) },
		store: { /* get/put/list — pack-namespaced */ } as HostApi["store"],
	};
}
```

> The capability bodies above are elided for brevity — see `src/app/host-api.ts` for
> the full implementation (scoped `fetch` over the surface token, the WS
> session-write permit, and the live event-bus subscription).

`withSession(init, sid)` adds the `x-bobbit-session-id` header (same propagation
`extension.ts` uses; the server reads it in `handleApiRoute` and the mcp-call guard).
`gatewayFetch` supplies the bearer for the action endpoint
(`POST /api/tools/:tool/actions/:action`); the scoped capabilities use the namespaced
`/api/ext/*` endpoints with their surface token. `Messages.ts`/`ToolGroup.ts` set
`ctx.host = getHostApi(sessionIdCtx, toolUseIdCtx)` — the bound `toolUseId` is the
renderer's own tool call.

**The `ServerHostApi` (handler `ctx.host`)** is the server-side analogue. It exposes the
verified identity fields plus the implemented `store` (pack-namespaced) and `session`
read surface (`readTranscript`/`readToolCall`, own-session, via the internal→contract
adapter); `session.postMessage` is intentionally omitted server-side (server modules have
no user gesture). Every capability is a typed method, never raw `process`/`fs`/`exec`;
nothing in it is a raw passthrough.

---

## 5. Security model — the Host API as the single boundary

Threat model (from the goal): **Bobbit + pack source are trusted; the LLM is not** — it is
prompt-injectable and can `curl` the gateway directly with the admin token. The new risks
are the **typed entry points** and the **allowlist bypass**. Each capability is authorized
in exactly one place.

| # | Control | Mechanism | Acceptance-blocking? |
|---|---|---|---|
| i | **Allowlist-bypass fix** | The **action** endpoint (`POST /api/tools/:tool/actions/:action`) requires `:tool` ∈ the calling session's `allowedTools`, via the **same guard** as the `/api/internal/mcp-call` handler: require `x-bobbit-session-id`, resolve the session (live or persisted), reject if `:tool` not in `allowedTools`. The LLM can curl the endpoint, so this guard — not the agent layer's `allowedTools` — is the real gate. The **renderer** endpoint (`GET /api/tools/:tool/renderer`) is EXEMPT from the allowedTools check: it serves trusted pack module bytes (a static-asset-equivalent, not a capability invocation), so it needs only the admin bearer (see §5.1). The reserved Phase-2 `routes:`/`stores:` inherit the action endpoint's allowedTools-gated rule by design. | **Yes — unit** |
| ii | **Input validation / no traversal** | `:tool`/`:action` matched against resolved tool + `actions.names`; `module`/`renderer` paths re-validated to stay within `baseDir/groupDir` (no `..`, no abs); `args` passed to the handler as opaque JSON — never `eval`/`exec`/`require`-d; `sessionId`/`toolUseId` treated as untrusted strings, never used to build filesystem/session paths beyond a store `get`. | **Yes — unit** |
| iii | **toolUseId existence + ownership (anti-replay/forgery)** | Resolve the **header-bound** session's transcript via `projectContextManager.getContextForSession(headerSessionId)?.sessionStore.get(headerSessionId)` and scan its messages for a `tool_use`/`toolCall` block whose `id === toolUseId` **and** whose tool name `=== :tool`. Reject (409) if absent — blocks replays and forged ids referencing another tool. | **Yes — unit** |
| iii-b | **Single-sourced session identity** | The `x-bobbit-session-id` HEADER is the canonical identity. The request body's `sessionId` is accepted only to fail fast on a mismatch — `body.sessionId === headerSessionId` is required (403 otherwise) BEFORE any allowedTools/toolUseId check; every downstream check uses the header-bound session. Prevents authorizing with one session and inspecting/acting on another's transcript. | **Yes — unit** |
| iii-c | **Action-result propagation (no privileged mutation)** | An action's result flows back ONLY as the `invokeAction` promise's JSON; the renderer applies it to **its own local state** (module-level Map / `LitElement` `@state`) and re-renders via `ctx.host.requestRender()` or native reactivity (§4a). Action handlers do NOT rewrite the transcript or persisted tool result — so a pack action cannot silently mutate session history. Turn-resume/message-post is the separate, user-gesture-gated `host.session.*` capability (§3.2 / Slice C2). | **Yes — E2E** |
| iv | **Blast radius** | Pack server modules (actions + routes) run in a confined `worker_threads` **worker**, NOT the gateway process — the parent only resolves + validates the module path and never imports pack code. The worker is **terminate-on-timeout** (true cancellation of a runaway handler — also the CPU-exhaustion control, since `worker_threads` has no per-core throttle), with **memory/stack caps**, **spawned-child SIGKILL**, **empty env** (no gateway token/secret), and **module-import containment to the pack root**. On top of it the dispatcher keeps its controls: per-call **timeout** (default 30s) spanning BOTH module load+eval AND handler execution; global **concurrency cap** (semaphore, default 8 in-flight, permit held until the work settles); **error isolation** so a throw or worker crash becomes a 500, never process death; per-session **rate-limit** (token bucket). This is Model A — **stability/resource/crash isolation, NOT a security sandbox against trusted pack code** (§3.4 / [phase-2 design §9](extension-host-phase2.md)); isolation is unconditional (no in-process fallback to gate). | **Yes — unit (worker terminate-on-timeout + resource caps; dispatcher timeout, concurrency cap, isolation, rate-limit)** |
| v | **UI thread** | Renderers run on the main thread over LLM-influenced data. Preserve existing iframe `sandbox` attributes (artifacts/preview unchanged). Pack renderers **must NOT auto-invoke actions on render** — `invokeAction` is only called from a user gesture (click). The litmus sample's Retry button enforces this; reviewers reject render-time invocation. | **Yes — E2E asserts no call before click** |
| vi | **Audit** | Every action invocation logs `{ tool, action, sessionId, toolUseId, caller, outcome, durationMs }` via the existing logger. | recommended |

**What is NOT a new risk:** arbitrary gateway access / code execution — the LLM already
has the token + shell. We are not widening that; we are adding *typed* entry points and
**closing** the allowlist bypass they would otherwise open.

**Attack surface REMOVED by dropping `gateway.fetch`.** Earlier drafts exposed a raw
`host.gateway.fetch`. To let a renderer reach the gateway from an arbitrary embedding it
had to resolve a *trusted base URL* (the `resolveTrustedGatewayBaseUrl` machinery,
Host-header–derived), which is itself a token-leak surface — a forged/poisoned Host header
could steer the injected admin bearer at an attacker-chosen origin. Removing `gateway.fetch`
deletes that entire concern: the only endpoint the client Host API calls in Phase 1 is the
same-origin action endpoint, and the durable Phase-2 replacement (`host.callRoute`) is
scoped to the pack's OWN `/api/ext/<pack>/*` namespace and authorized like a tool call.
There is no raw-fetch capability to misdirect, so the trusted-base-URL surface is gone.

### 5.1 The single choke point — `invokeAction` + scoped Phase-2 capabilities

The boundary is now exactly the set of NEW typed entry points the extension host
introduces; there is no raw escape hatch to reason around.

- **`invokeAction` is the only Phase-1 pack→server path, and it is authorized like a tool
  call.** The action endpoint (`POST /api/tools/:tool/actions/:action`) requires `:tool` ∈
  the calling session's `allowedTools`, via the **same guard** as `/api/internal/mcp-call`
  (control i). The LLM can `curl` the endpoint, so this guard — not the agent layer's
  `allowedTools` — is the real gate.
- **Phase-2 capabilities inherit the same rule by construction.** `host.callRoute` (the
  pack-scoped route capability), `host.store.*`, and `host.session.*` all route through the
  one `allowedTools`-gated guard. `callRoute` additionally constrains the target to the
  calling pack's OWN `/api/ext/<thisPack>/*` namespace — a pack can never address another
  pack's routes or an arbitrary gateway path. This is the durable replacement for the
  removed raw fetch: dynamic pack data comes from typed, pack-owned, authorized routes.
- **The renderer-module endpoint is not a capability entry point.** `GET
  /api/tools/:tool/renderer` serves trusted pack module bytes (a static-asset-equivalent),
  so it is bearer-only — EXEMPT from the `allowedTools` check (§4a, control i). Path
  traversal on the renderer file is still re-validated.
- **The injected bearer never leaves same-origin.** With no `gateway.fetch`, there is no
  caller-supplied URL or `Authorization` header to sanitize on the client: `host-api.ts`
  builds the single action-endpoint request itself (same-origin, `withSession` adds only
  `x-bobbit-session-id`; `gatewayFetch` adds the bearer). The previous
  `stripAuthorizationHeaders` / trusted-base-URL defenses are unnecessary because the
  capability that required them no longer exists.
- **The single choke point, stated accurately:** every capability entry point created by
  the extension host (the action endpoint today; `callRoute`/`stores`/`session` in Phase 2)
  routes through one `allowedTools`-gated guard; the renderer-module endpoint serves
  trusted bytes and is bearer-only. There is exactly one un-typed surface in the whole
  design — none — which is the property that makes v1 durable.

---

## 6. Migration — artifacts & PR-walkthrough as shipped packs

Originally a *sketch* proving both built-ins collapse onto the v1 shape with **zero**
changes to v1 types and **no** raw `gateway.fetch`. **Phase 2 realized it:** both now ship
as installable market packs under `market-packs/` (the acceptance litmus), each at
behavioral parity with the built-in it replaces. The "reserved primitive" column below is
now the *live* primitive. The two case studies — including the concrete pack layouts,
bundling/vendoring, and the live-git/store-rehydration split — are documented for authors in
[../extension-host-authoring.md](../extension-host-authoring.md); the tables below stay as
the contract-level mapping. The key durability result held: PR-walkthrough's dynamic data,
which an earlier draft reached via `host.gateway.fetch`, maps cleanly onto the pack's OWN
typed `routes:` via `host.callRoute` — removing the escape hatch cost no parity.

### 6.1 `artifacts` (`src/ui/tools/artifacts/`, `preview/artifacts.ts`)

| Existing behavior | Frozen primitive |
|---|---|
| `artifacts-tool-renderer.ts` renders an inline pill + opens the artifact viewer | `renderer:` (P1) for the inline pill; **`panels:`** (live) for the viewer surface |
| `ArtifactPill` "open" click mounts `ArtifactElement` in a panel | `host.ui.openPanel({ panelId: "artifacts.viewer", params: { artifactId } })` (structured target) |
| `persistPreviewArtifact` / `restorePreviewArtifact` server-side | **`stores:`** (live) → `host.store.put/get(artifactId)`; ownership-scoped to the artifacts pack |
| Restore-by-id across reload (the old bespoke restore route) | `host.store.get` + `host.ui.openPanel({ panelId, params })` — no bespoke route, no raw fetch |
| Deep-link a viewer by id (parity acceptance) | an `entrypoints:` `kind:"route"` (`routeId:"artifacts"`) + `host.ui.navigate({ route, params:{ artifactId } })` → `#/ext/artifacts?artifactId=…` → store-rehydrated panel |

**Shipped** as `market-packs/artifacts/` — `renderer:` + `panels:` + `stores:` + a
`kind:"route"` deep-link entrypoint. The Blob-URL renderer-delivery decision (§4a) is
exactly how the `artifacts.viewer` panel module is delivered (panels reuse the
serve+lazy-import mechanism keyed off `panels[].entry`). Heavyweight deps (`highlight.js`,
`pdfjs-dist`, `docx-preview`) are **vendored** — esbuild-bundled into the served module at
publish time, not installed (`npm run build:packs`); the host toolkit stays factory-injected,
never bundled.

### 6.2 PR-walkthrough (`src/ui/components/pr-walkthrough/`, `defaults/tools/pr-walkthrough/`, `server/pr-walkthrough/routes.ts`)

| Existing behavior | Frozen primitive |
|---|---|
| `submit.yaml` / `read_pr_walkthrough_bundle.yaml` / `readonly_bash.yaml` tools | tool YAMLs + `renderer:` for any inline tool blocks |
| `PrWalkthroughPanel.ts` full-surface viewer | **`panels:`** → `host.ui.openPanel({ panelId: "pr-walkthrough.panel", params: { jobId } })` |
| Deep-link to a walkthrough (`#/...`) | **`entrypoints:`** (composer-slash / git-widget button / command palette launchers + a `kind:"route"` deep-link) + `host.ui.navigate({ route: "pr-walkthrough", params: { jobId } })` (structured — the host maps it to `#/ext/pr-walkthrough?jobId=…`; the pack never builds a hash string) |
| `handlePrWalkthroughApiRoute` bespoke endpoints | **`routes:`** → the pack's OWN namespace, reached via the typed, pack-scoped `host.callRoute(name, init)` — **never** a raw gateway fetch |
| Loading the changeset/diff bundle for the viewer | `host.callRoute("bundle", { query: { jobId } })` against the pack's own route — dynamic data without an escape hatch |
| Persisted walkthrough store (`WALKTHROUGH_STORE_SCHEMA_VERSION`, job/changeset state) | **`stores:`** → `host.store.*`, pack-scoped |
| Reading the `submit_pr_walkthrough_yaml` tool call | `host.session.readToolCall(toolUseId)` (own-session, via the adapter) instead of bespoke transcript access |
| Live `git diff` recompute for the changeset | the `bundle` route runs **real `git`** LIVE in the confined worker (`child_process`/`fs` are ambient; resource-capped + killable; `process.cwd()` is the session worktree) — covering PRs created after install |

**Shipped** as `market-packs/pr-walkthrough/` — the maximal case using **all** reserved
keys: `routes` + `stores` + `panels` + `entrypoints` + `host.session.readToolCall`. Every
dynamic behavior routes through a TYPED, scoped capability — `host.callRoute` (the pack's
own routes, resolved by a pack-level `RouteRegistry` so a panel opened from one tool reaches
a route declared on another tool in the SAME pack), `host.ui.*` (structured targets),
`host.store.*` (pack-scoped), `host.session.readToolCall` — **with no raw `gateway.fetch`**.
The **synthesis-credential split** (the one non-obvious decision): the worker has a
PATH-only env and no model credentials, so LLM card synthesis stays AGENT-tool-side at submit
time (persisted to the store keyed by changeset id), and the `bundle` route only *computes*
the deterministic diff/fallback cards live + *reads* the stored LLM cards — it never calls
the model. Parity holds without an escape hatch.

> **Shape fixes applied during this exercise.** (1) The initial `HostUiApi` had only
> `openPanel`; PR-walkthrough's deep-link/launcher need forced adding `navigate(target)` and
> the `entrypoints:` reserved key (both now in §2/§3). (2) The initial draft routed
> PR-walkthrough's dynamic data through a raw `host.gateway.fetch`; the durability review
> replaced that with the pack-scoped, typed `host.callRoute` against the pack's OWN
> `routes:` namespace, and removed `gateway.fetch` entirely. (3) `openPanel`/`navigate`
> were re-typed from `(id, payload)` / `(hashString)` to structured `{ panelId|route,
> params }` targets so the contract never bakes in today's router. This is the litmus test
> doing its job — the shape was corrected here, while v1 is unmerged, so Phase 2 is additive.

---

## 7. Phasing & non-goals

**Built in Phase 1:** pack renderer serving + runtime lazy registration (§4a); actions
module resolution + endpoint + dispatch + cache invalidation (§4b); `ToolRenderContext.host`
+ client/server Host API for `invokeAction` + the client-only `requestRender` (§4c) — there
is **no `gateway.fetch`** to build; the allowlist-bypass fix + input validation +
toolUseId verification + blast-radius controls (§5); the frozen v1 interfaces + manifest
schema committed (§2/§3); this doc.

**Built in Phase 2 (IMPLEMENTED):** `panels`, `stores`, `routes`, `entrypoints`,
`permissions`; `host.callRoute`, `host.session.*` (reads + writes + subscribe),
`host.ui.*` (openPanel + navigate), `host.store.*`; the internal→contract adapter
(`contract-adapter.ts`, §3.3); server-module RESOURCE + CRASH isolation in a
`worker_threads` worker (`module-host-worker.ts`, §3.4). `host.capabilities` now reports all
flags `true` and `HOST_API_VERSION` is still `1` (additive-only — proven by the v1 type
compiling unchanged). The two litmus built-ins (artifacts, PR-walkthrough) ship as packs
under `market-packs/`. See [extension-host-phase2.md](extension-host-phase2.md) for the
build plan and slice DAG. MCP + AGENTS remain non-installable (unchanged from marketplace
MVP).

**Durability invariant (governs all post-v1 change).** v1 is **additive-only**: a Phase-2
capability adds a method body + wires it through the one `allowedTools`-gated guard — no v1
signature changes, no `HOST_API_VERSION` bump, and the implementing host flips the matching
`host.capabilities` flag from `false` to `true`. Packs feature-detect AVAILABILITY via
`host.capabilities.<name>` / `host.capabilities.has(name)` (the single source of truth —
NOT member-presence checks, since every namespace is always present on the object even
when a host gates the capability off), and
read `host.version` / `host.contractVersion` only to identify the contract revision.
Deprecation policy: a member may be
marked `@deprecated` (kept working) for at least one MAJOR `HOST_API_VERSION` before
removal, and removal is the ONLY thing that bumps the major. The load-bearing rule: **no
member may ever become (or be replaced by) a raw transport / untyped passthrough** — one
un-typed passthrough makes the abstraction a fiction, which is exactly why `gateway.fetch`
was removed rather than retained "just in case."

---

## 8. Test plan

### 8.1 Unit (prefer `file://` fixtures)

| Area | Assertion | Blocking |
|---|---|---|
| Action-handler resolution + precedence | A market-pack `actions.js` shadows a builtin same-name tool's actions; with zero market packs resolution is unchanged (mirrors `tool-manager` precedence). | yes |
| Endpoint happy-path | Valid session + allowed tool + existing toolUseId → handler result returned. | yes |
| **Allowlist-bypass guard** | `:tool` ∉ session `allowedTools` → 403; missing `x-bobbit-session-id` → 403; unknown session → 403. Mirrors mcp-call guard. | **yes** |
| **Input validation** | `..`/abs `module`/`renderer` path → rejected at parse; `:action` ∉ `actions.names` → 404; `args` never eval'd (handler receives opaque object). | **yes** |
| **toolUseId verification** | Forged/absent toolUseId → 409; toolUseId belonging to a *different* tool → 409. | **yes** |
| **Blast-radius controls (all four required)** | Handler throws → 500, process survives (**isolation**); handler exceeds **timeout** → 504/500, slot released; >cap concurrent handlers queue/reject (**concurrency cap**); burst beyond the per-session budget → 429 (**rate-limit**). | **yes** |
| Cache invalidation | Install → handler available next call; update → new handler picked up; uninstall → 404; all without restart (drive `invalidateResolverCaches`). | yes |
| Renderer/actions loader | `rendererKind` computed `"pack"` only for market `.js`; `GET /renderer` serves bytes as `text/javascript` with bearer-only auth (NO `allowedTools` check); factory missing → loader rejects → load-failure fallback registered. | yes |
| **Renderer precedence (litmus parity)** | A pack that shadows a built-in interactive tool registers with `{ override: true }` and renders with the **PACK** renderer, not the eager builtin (`getToolRenderer(name)` resolves to the pack loader); a built-in NOT shadowed keeps its eager renderer. | **yes** |
| Manifest schema | Phase-2 keys (`panels`/`routes`/`stores`/`entrypoints`) accepted + ignored, NOT rejected; malformed block degrades (tool still loads). | yes |
| **Tool-description budget** | `tests/tool-description-budget.test.ts` still passes after the new tool-metadata wire fields (`rendererKind`/`hasActions`/`actionNames`) + contributions parsing — no tool description exceeds its pinned budget. | yes |
| **`buildPackList` byte-identical** | With zero market packs, resolution is unchanged (renderers/actions add nothing), per the existing `buildPackList` byte-identical invariant test. | yes |
| **Single-sourced session identity** | `body.sessionId !== x-bobbit-session-id` header → 403 BEFORE allowedTools/toolUseId checks; toolUseId is verified against the header-bound session only (a valid toolUseId from a *different* session → 409). | **yes** |
| **Action-result contract** | `invokeAction` resolves with the handler's JSON; no transcript/persisted-tool-result mutation occurs (assert the stored session record is byte-identical before/after a successful action). | yes |

### 8.2 Browser E2E (mandatory) — `tests/e2e/ui/extension-host.spec.ts`

Pattern: `tests/e2e/ui/settings.spec.ts`. With a `file://`/local-dir market source
fixture shipping the `retry-demo` pack (§2.4):

1. Install the sample pack (marketplace install) → `/api/tools` now lists `sample_action`
   with `rendererKind: "pack"`.
2. Open a session whose transcript contains a `sample_action` tool call → it **renders
   with the pack renderer** (placeholder → real renderer; assert the Retry button, and
   assert **no** action POST fired before any click — control v).
3. Click **Retry** → action POST → the renderer's OWN DOM updates from the handler result
   (assert the `pack-result` element appears/reflects the handler's returned value; the
   transcript/persisted tool result is unchanged — renderer-local state per §4a).
4. Reload the page → renderer still loads (registration re-driven from metadata; control
   §4a survives-reload).
5. Uninstall the pack → renderer + actions gone (`/api/tools` drops it; subsequent action
   POST → 404).

Run `npm run check`, `npm run test:unit`, `npm run test:e2e` before merge.

---

## 9. File manifest (Phase 1)

**New:** `src/shared/extension-host/host-api.ts`,
`src/server/extension-host/action-dispatcher.ts`,
`src/server/extension-host/server-host-api.ts`, `src/app/host-api.ts`,
`src/app/pack-renderers.ts`, `src/server/agent/tool-contributions.ts`,
`tests/e2e/ui/extension-host.spec.ts` (+ unit fixtures).

**Edited:** `src/server/server.ts` (2 routes + `invalidateResolverCaches` + dispatcher
construction), `src/server/agent/tool-manager.ts` + `builtin-config.ts` (`rendererKind`,
`hasActions`, `actionNames`, contributions parse), `src/app/api.ts` (`ToolInfo` wire
fields + bootstrap call), `src/ui/tools/types.ts` (`host?` field),
`src/ui/components/Messages.ts` + `ToolGroup.ts` (set `ctx.host`),
`docs/marketplace.md` (renderers + actions packable; expanded threat model),
authoring guide.

**Phase-2 targets — studied, NOT modified:** `src/ui/tools/artifacts/`,
`src/ui/components/pr-walkthrough/`, `defaults/tools/pr-walkthrough/`.
