# Bobbit Extension Host — Phase 1 (frozen shape)

**Status:** design (frozen). Phase 1 builds the inner slice; the whole VS Code-shaped
contribution model + Host API is frozen here as committed TypeScript interfaces and a
validated manifest schema, so Phase 2 is purely additive.

This is the authoritative design for goal *Extension Host Phase 1*. It is the source of
truth a coder implements Phase 1 from with no further architectural decisions. It also
freezes the contribution-point manifest, the full Host API, and proves (on paper) that
`artifacts` and the PR-walkthrough collapse onto the frozen shape with **zero** changes
to Phase-1 types.

Prereqs read: [pack-based-marketplace.md](pack-based-marketplace.md) (PackResolver,
`buildPackList`, scopes/precedence, the byte-identical invariant) and
[../marketplace.md](../marketplace.md).

---

## 0. TL;DR — the three Phase-1 decisions

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

3. **Host API (Phase-1 surface).** `host.gateway.fetch(path, init)` and
   `host.invokeAction(tool, action, args)` only, exposed to renderers via a new optional
   `ToolRenderContext.host?: HostApi`. Built-in renderers are unchanged (they ignore it).
   The full `host.session.*` / `host.ui.*` / `host.store.*` namespace is frozen as
   interfaces but **not** implemented.

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
  │     .host: HostApi│   │     └── ctx: ServerHostApi (gateway-scoped fetch, audit, timeout)         │
  └───────────────────┘   │                                                                          │
        ▲   host.gateway.fetch / host.invokeAction (the ONLY way extension code touches internals)   │
        └───────────────────────────────────────────────────────────────────────────────────────────┘
```

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
files `ToolManager` already scans. Two keys are Phase-1 **load-bearing**; the rest are
**parsed-and-reserved** (accepted, validated for shape, then ignored — never rejected),
so a Phase-2 pack authored today installs and resolves cleanly on a Phase-1 server.

| Key | Phase | Meaning |
|---|---|---|
| `renderer:` | **1 (load-bearing)** | Already exists. Repurposed: for **pack** tools it is the on-disk path (relative to the tool's group dir) of a pre-built ESM renderer module. For builtins it stays display-only metadata. |
| `actions:` | **1 (load-bearing)** | Relative path to the server actions module (default `actions.js`) **and/or** an inline allowlist of action names. |
| `panels:` | 2 (reserved) | Persistent side-panel component contributions (artifacts / PR-walkthrough viewer). |
| `entrypoints:` | 2 (reserved) | Non-chat launchers (composer slash-commands, git-widget buttons, command palette). |
| `routes:` | 2 (reserved) | Namespaced `/api/ext/<pack>/*` gateway endpoints. |
| `stores:` | 2 (reserved) | Ownership-scoped server-side persistence. |

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

/** Phase-1 load-bearing contributions parsed from a tool YAML. */
export interface ToolContributions {
	/** Renderer ESM module path, relative to the tool's group dir. Phase-1 load-bearing
	 *  for PACK tools only; for builtins this is display-only metadata (a src/ path). */
	renderer?: string;
	/** Server actions module + optional declared action allowlist. */
	actions?: ToolActionsContribution;
	/** Phase-2 keys: parsed for shape, retained verbatim, NOT acted on. */
	reserved: ReservedContributions;
}

export interface ToolActionsContribution {
	/** Module path relative to the group dir. Default "actions.js". */
	module?: string;
	/** Optional explicit action-name allowlist. When present, the endpoint
	 *  rejects any :action not in this list BEFORE loading the module. */
	names?: string[];
}

/** Phase-2 contribution keys. Validated for *shape* only, then ignored. Never rejected. */
export interface ReservedContributions {
	panels?: unknown[];
	entrypoints?: unknown[];
	routes?: unknown[];
	stores?: unknown[];
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
- `panels`/`entrypoints`/`routes`/`stores`: if present must be arrays (else a parse
  *warning*, not a hard error); contents are retained verbatim and otherwise ignored.
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

---

## 3. Frozen Host API

Committed as interfaces in a new shared module `src/shared/extension-host/host-api.ts`
(importable by both `src/ui` and `src/server`). **Phase 1 implements only `gateway` and
`invokeAction`.** Everything else is frozen-not-implemented: the interfaces are real and
doc-commented so Phase-2 implementations are purely additive (add the method body + wire
the capability through the same authorization path — no signature churn).

```ts
// src/shared/extension-host/host-api.ts (NEW)

/** Bumped only on a breaking change to any member below. Phase-2 additions that only
 *  ADD members do NOT bump this. Renderers may read host.version to feature-detect. */
export const HOST_API_VERSION = 1 as const;

/**
 * The single, versioned, capability-scoped object through which ALL extension code
 * (client renderers and, in Phase 2, panels/entrypoints) touches Bobbit internals.
 * Every member is mediated + authorized in one place (the gateway action/route guards
 * and the client wrappers). There are no privileged escape hatches.
 */
export interface HostApi {
	/** Frozen API version. See HOST_API_VERSION. */
	readonly version: number;

	/** Gateway access, scoped + audited. PHASE 1: implemented. */
	readonly gateway: HostGatewayApi;

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
	 * call; acting on a different tool call is out of Phase-1 scope.
	 * Resolves with the handler's JSON result; rejects on guard/handler failure.
	 */
	invokeAction<TArgs = unknown, TResult = unknown>(
		tool: string,
		action: string,
		args: TArgs,
	): Promise<TResult>;

	/** Transcript + message capabilities. PHASE 2 (frozen, not implemented). */
	readonly session: HostSessionApi;

	/** UI surface capabilities. PHASE 2 (frozen, not implemented). */
	readonly ui: HostUiApi;

	/** Ownership-scoped persistence. PHASE 2 (frozen, not implemented). */
	readonly store: HostStoreApi;
}

export interface HostGatewayApi {
	/**
	 * Authenticated fetch against the gateway, same credentials/headers as the app.
	 * PHASE 1: implemented as a thin wrapper over src/app/gateway-fetch.ts::gatewayFetch.
	 * `path` is a gateway-relative path (e.g. "/api/goals/:id"). The wrapper injects the
	 * Authorization bearer + the caller's session id header; callers must NOT pass their
	 * own Authorization header.
	 *
	 * AUTHORIZATION BOUNDARY (see §5.1): this is deliberately NO MORE privileged than the
	 * app's existing gatewayFetch. It reaches PRE-EXISTING gateway endpoints, each of which
	 * enforces its own authorization; it creates no new server capability and no new
	 * bypass (the LLM/UI can already call these endpoints with the admin token). It is the
	 * lower-level interop seam for renderers that re-express built-ins which today POST to
	 * existing endpoints directly. The PRIMARY, recommended pack→server path is
	 * `invokeAction` (tool-authorized through the action endpoint guard).
	 */
	fetch(path: string, init?: RequestInit): Promise<Response>;
}

/** PHASE 2 — frozen, not implemented. Read/post the current session's transcript. */
export interface HostSessionApi {
	/** Read the current session's transcript (paginated envelope), mirroring
	 *  GET /api/sessions/:id/transcript. */
	readTranscript(opts?: ReadTranscriptOpts): Promise<TranscriptEnvelope>;
	/** Read a single tool call (params + result) by tool_use id from this session. */
	readToolCall(toolUseId: string): Promise<ToolCallRecord | null>;
	/** Post a user/system message into the current session (may resume the agent turn). */
	postMessage(msg: PostMessageInput): Promise<void>;
	/** Subscribe to live session events (tool results, status). Returns an unsubscribe fn. */
	subscribe(event: SessionEvent, cb: (payload: unknown) => void): () => void;
}

/** PHASE 2 — frozen, not implemented. Drive non-chat UI surfaces. */
export interface HostUiApi {
	/** Open (or focus) a contributed panel, handing it an opaque payload. */
	openPanel(panelId: string, payload?: unknown): void;
	/** Navigate the SPA to a contributed route (e.g. "#/ext/pr-walkthrough/123"). */
	navigate(route: string): void;
}

/** PHASE 2 — frozen, not implemented. Ownership-scoped server persistence.
 *  Keys are namespaced to the contributing pack server-side; one pack cannot read
 *  another pack's store. Maps onto the reserved `stores:` contribution. */
export interface HostStoreApi {
	get<T = unknown>(key: string): Promise<T | null>;
	put<T = unknown>(key: string, value: T): Promise<void>;
	list(prefix?: string): Promise<string[]>;
}

// ── Phase-2 payload shapes (frozen so impls are additive) ──
export interface ReadTranscriptOpts { offset?: number; limit?: number; pattern?: string; }
export interface TranscriptEnvelope { total: number; returned: number; messages: unknown[]; }
export interface ToolCallRecord { toolUseId: string; tool: string; params: unknown; result: unknown; isError: boolean; }
export interface PostMessageInput { role: "user" | "system"; text: string; resumeTurn?: boolean; }
export type SessionEvent = "tool_result" | "status" | "message";
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
	 *  renderers ignore it; pack renderers use it for gateway.fetch / invokeAction.
	 *  Optional so unit fixtures that construct a bare ctx keep compiling. */
	host?: HostApi;
}
```

`Messages.ts` (≈ line 691) and `ToolGroup.ts` (≈ line 165) construct the ctx; they add
`host: getHostApi(sessionIdCtx, toolUseIdCtx)` (the client Host API impl, §4c) — binding
the Host API to BOTH the session id and the renderer's own `toolUseId`, so
`invokeAction(tool, action, args)` keeps its clean frozen signature while still supplying a
verified `toolUseId` to the endpoint internally. No other renderer call sites change.

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
  transcript or the persisted tool result in Phase 1 (handlers that genuinely need to
  resume the agent turn or post a message use the frozen-for-Phase-2 `host.session.*`). The
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
  { override: true })` STASHES any eager built-in it displaces in a `displacedBuiltins`
  map. The new `unregisterPackRenderer(name)` drops the name from every registry map
  (`toolRenderers`, `pendingLazy`, `inFlight`, `packOwned`), RESTORES the stashed built-in
  if one existed (else leaves the tool to default rendering), and dispatches the standard
  renderer-loaded event so mounted `<tool-message>`/`<tool-group>` blocks repaint
  immediately. `registerPackRenderers` calls it for any name it previously registered that
  the fresh `/api/tools` no longer reports as a pack renderer — so a marketplace uninstall
  (which re-drives `registerPackRenderers(await fetchTools(projectId), projectId)`) removes
  the pack renderer from the RUNNING UI without a page reload.

  `registerLazyToolRenderer` already returns the **placeholder** on first
  `getToolRenderer` and installs the **load-failure** fallback on loader rejection
  (`renderer-registry.ts::startLoad`) — both reused unchanged. Registration is re-driven
  from metadata on every cold load, so it **survives page reload** with no install-time
  state. A **superseded in-flight load is generation-guarded**: `startLoad` captures a
  per-name `loadGeneration` token before awaiting the loader, and
  `unregisterPackRenderer` / re-registration bump it — so if a pack is uninstalled or a
  different renderer is registered for the same name while its lazy import is in flight, the
  stale promise resolves to a **no-op** (no `toolRenderers` write, no resurrecting repaint),
  preserving the uninstall reconciliation above (the load-failure path is guarded the same
  way).

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

**Files touched (4a):** `src/server/server.ts` (+1 route), `src/server/agent/tool-manager.ts`
+ `builtin-config.ts` (`rendererKind`), `src/app/api.ts` (`ToolInfo` wire fields),
`src/app/pack-renderers.ts` (NEW), one app-init call site, `src/ui/tools/types.ts`.

### 4b. Actions module resolution + endpoint + dispatch

**Module resolution (mirror ToolManager precedence).** A new
`src/server/extension-host/action-dispatcher.ts`:

```ts
// src/server/extension-host/action-dispatcher.ts (NEW)
export interface ActionHandlerCtx {
	/** Phase-1 server Host API surface (audited gateway fetch, scoped). */
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
`Map<absPath, { mtimeMs; module }>`; a stale mtime reloads (mirrors `scanToolsDirCached`).

**Endpoint** `POST /api/tools/:tool/actions/:action` in `server.ts::handleApiRoute`,
modeled on `/api/internal/mcp-call` (server.ts:10930). Body `{ sessionId, toolUseId, args }`.
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

**Cache invalidation (synchronous).** `invalidateResolverCaches()` (server.ts:2238)
already runs on install/update/uninstall (server.ts:5522/5537/5552) and pack-order PUT
(5591). Add `actionDispatcher.invalidate()` to it:

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
import { HOST_API_VERSION, type HostApi } from "../shared/extension-host/host-api.js";

/** Build the Phase-1 client Host API bound to a given session AND the renderer's own
 *  toolUseId. invokeAction supplies BOTH to the endpoint internally, so packs never put
 *  identity fields in `args`. Phase-2 namespaces throw a clear "not implemented in
 *  Phase 1" error so misuse is loud, not silent. */
export function getHostApi(sessionId: string | undefined, toolUseId: string | undefined): HostApi {
	const notImpl = (m: string) => { throw new Error(`host.${m} is reserved for Phase 2`); };
	return {
		version: HOST_API_VERSION,
		gateway: {
			fetch: (path, init) => gatewayFetch(path, withSession(init, sessionId)),
		},
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
		session: { readTranscript: () => notImpl("session.readTranscript"), /* …all Phase-2… */ } as any,
		ui: { openPanel: () => notImpl("ui.openPanel"), navigate: () => notImpl("ui.navigate") },
		store: { get: () => notImpl("store.get"), put: () => notImpl("store.put"), list: () => notImpl("store.list") },
	};
}
```

`withSession(init, sid)` adds the `x-bobbit-session-id` header (same propagation
`extension.ts` uses, server reads at server.ts:9030/10953). `gatewayFetch` supplies the
bearer. `Messages.ts`/`ToolGroup.ts` set `ctx.host = getHostApi(sessionIdCtx, toolUseIdCtx)`
— the bound `toolUseId` is the renderer's own tool call (acting on a different tool call is
out of Phase-1 scope).

**The `ServerHostApi` (handler `ctx.host`)** is the server-side analogue exposing only an
**audited, scoped** gateway fetch in Phase 1 (no raw `process`/`fs`/`exec` handed to
handlers; handlers that need those import them directly, but the doc'd convention is to go
through `ctx.host`). Frozen `ServerHostApi` mirrors `HostApi.gateway`/`store`/`session`
server-side, with only `gateway` live in Phase 1.

---

## 5. Security model — the Host API as the single boundary

Threat model (from the goal): **Bobbit + pack source are trusted; the LLM is not** — it is
prompt-injectable and can `curl` the gateway directly with the admin token. The new risks
are the **typed entry points** and the **allowlist bypass**. Each capability is authorized
in exactly one place.

| # | Control | Mechanism | Acceptance-blocking? |
|---|---|---|---|
| i | **Allowlist-bypass fix** | The **action** endpoint (`POST /api/tools/:tool/actions/:action`) requires `:tool` ∈ the calling session's `allowedTools`, via the **same guard** as `/api/internal/mcp-call` (server.ts:10953–10976): require `x-bobbit-session-id`, resolve the session (live or persisted), reject if `:tool` not in `allowedTools`. The LLM can curl the endpoint, so this guard — not the agent layer's `allowedTools` — is the real gate. The **renderer** endpoint (`GET /api/tools/:tool/renderer`) is EXEMPT from the allowedTools check: it serves trusted pack module bytes (a static-asset-equivalent, not a capability invocation), so it needs only the admin bearer (see §5.1). The reserved Phase-2 `routes:`/`stores:` inherit the action endpoint's allowedTools-gated rule by design. | **Yes — unit** |
| ii | **Input validation / no traversal** | `:tool`/`:action` matched against resolved tool + `actions.names`; `module`/`renderer` paths re-validated to stay within `baseDir/groupDir` (no `..`, no abs); `args` passed to the handler as opaque JSON — never `eval`/`exec`/`require`-d; `sessionId`/`toolUseId` treated as untrusted strings, never used to build filesystem/session paths beyond a store `get`. | **Yes — unit** |
| iii | **toolUseId existence + ownership (anti-replay/forgery)** | Resolve the **header-bound** session's transcript via `projectContextManager.getContextForSession(headerSessionId)?.sessionStore.get(headerSessionId)` and scan its messages for a `tool_use`/`toolCall` block whose `id === toolUseId` **and** whose tool name `=== :tool`. Reject (409) if absent — blocks replays and forged ids referencing another tool. | **Yes — unit** |
| iii-b | **Single-sourced session identity** | The `x-bobbit-session-id` HEADER is the canonical identity. The request body's `sessionId` is accepted only to fail fast on a mismatch — `body.sessionId === headerSessionId` is required (403 otherwise) BEFORE any allowedTools/toolUseId check; every downstream check uses the header-bound session. Prevents authorizing with one session and inspecting/acting on another's transcript. | **Yes — unit** |
| iii-c | **Action-result propagation (no privileged mutation)** | An action's result flows back ONLY as the `invokeAction` promise's JSON; the renderer applies it to **its own local state** (module-level Map / `LitElement` `@state`) and re-renders via `ctx.host.requestRender()` or native reactivity (§4a). Phase-1 handlers do NOT rewrite the transcript or persisted tool result — so a pack action cannot silently mutate session history. Turn-resume/message-post is frozen-for-Phase-2 (`host.session.*`). | **Yes — E2E** |
| iv | **Blast radius** | Handlers run in the long-lived gateway process. Per-call **timeout** (`Promise.race`, default 30s); global **concurrency cap** (semaphore, default 8 in-flight); **try/catch isolation** so a thrown/handler-crash becomes a 500, never takes down the process; endpoint **rate-limit** (token bucket per session). A **seam** is left to run `actions.js` in a worker/`vm` later: the dispatcher only ever calls `module.actions[action](ctx, args)`, so swapping the execution strategy is local to `ActionDispatcher.dispatch`. | timeout+isolation **yes**; cap/rate-limit recommended |
| v | **UI thread** | Renderers run on the main thread over LLM-influenced data. Preserve existing iframe `sandbox` attributes (artifacts/preview unchanged). Pack renderers **must NOT auto-invoke actions on render** — `invokeAction` is only called from a user gesture (click). The litmus sample's Retry button enforces this; reviewers reject render-time invocation. | **Yes — E2E asserts no call before click** |
| vi | **Audit** | Every action invocation logs `{ tool, action, sessionId, toolUseId, caller, outcome, durationMs }` via the existing logger. | recommended |

**What is NOT a new risk:** arbitrary gateway access / code execution — the LLM already
has the token + shell. We are not widening that; we are adding *typed* entry points and
**closing** the allowlist bypass they would otherwise open.

### 5.1 `host.gateway.fetch` vs the single choke point

The "authorize gateway calls like tool calls" requirement could read as if every
`host.gateway.fetch` call must pass the `allowedTools` guard. It does not — and that does
not contradict the single-choke-point claim. The boundary is precise:

- **`host.gateway.fetch` is deliberately NO MORE privileged than the app's existing
  `gatewayFetch`.** It reaches **pre-existing** gateway endpoints, each of which already
  enforces its own authorization (e.g. the `goal_plan_propose` approval flow already POSTs
  to `/api/goals/:id/mutation/:requestId/decision` via `gatewayFetch`). It introduces NO
  new server capability and NO new bypass: the LLM/UI can already call these endpoints with
  the admin token. So pre-existing endpoints keep their own authz; `fetch` adds nothing to
  authorize.
- **The client host API is the choke point for the injected bearer.** `host-api.ts`
  `withSession` (which assembles headers for both `gateway.fetch` and `invokeAction`)
  STRIPS any caller-supplied `Authorization`/`authorization` header (case-insensitive, via
  the dependency-free `stripAuthorizationHeaders` in `gateway-fetch.ts`) BEFORE delegating
  to `gatewayFetch`, so a renderer cannot override the injected admin bearer by passing its
  own `Authorization` in `init.headers` (the shared `gatewayFetch` spreads `options.headers`
  AFTER setting `Authorization`, so the strip must happen at the host-api choke point). The
  server-side host API already sets `Authorization` after the spread, so it is unaffected.
- **The "authorize like tool calls" rule applies to the NEW typed entry points** the
  extension host introduces: the **action endpoint** (`/api/tools/:tool/actions/:action`,
  behind the `allowedTools` guard, control i) and the reserved Phase-2 **`routes:`** /
  **`stores:`** (which inherit the same `allowedTools`-gated rule by design). These are the
  new capability surfaces, and each routes through that one guard.
- **The single choke point, stated accurately:** every NEW capability entry point created
  by the extension host routes through one `allowedTools`-gated guard; pre-existing
  endpoints retain their own authorization. The renderer-module endpoint is not a
  capability entry point (it serves trusted bytes), so it is bearer-only (§4a, control i).
- **Recommended path.** The PRIMARY, recommended pack→server path is
  `host.invokeAction` (tool-authorized through the action endpoint). `host.gateway.fetch`
  is the lower-level interop seam, used by renderers re-expressing built-ins that today
  call existing endpoints directly — e.g. the `goal_plan_propose` approval re-expression.

---

## 6. Migration sketch — artifacts & PR-walkthrough onto the frozen shape

Goal: prove both collapse onto the frozen contribution points + Host API with **zero**
changes to Phase-1 shapes. Where something didn't map, the fix was applied to the frozen
shape above (noted inline), per the litmus rule.

### 6.1 `artifacts` (`src/ui/tools/artifacts/`, `preview/artifacts.ts`)

| Existing behavior | Frozen primitive |
|---|---|
| `artifacts-tool-renderer.ts` renders an inline pill + opens the artifact viewer | `renderer:` (Phase-1) for the inline pill; **`panels:`** (reserved) for the viewer surface |
| `ArtifactPill` "open" click mounts `ArtifactElement` in a panel | `host.ui.openPanel("artifacts.viewer", { artifactId })` |
| `persistPreviewArtifact` / `restorePreviewArtifact` server-side (server.ts:9890/9991) | **`stores:`** (reserved) → `host.store.put/get(artifactId)`; ownership-scoped to the artifacts pack |
| Restore-by-id across reload (`POST /api/preview/artifacts/:id/restore`) | `host.store.get` + `host.ui.openPanel` — no bespoke route needed |

Maps cleanly. Artifacts need `toolRenderers` + `panels` + `stores` — all frozen. **No
Phase-1 shape change required.** The Blob-URL renderer-delivery decision (§4a) is exactly
how the artifact viewer panel module would also be delivered in Phase 2 (panels reuse the
serve+lazy-import mechanism keyed off `panels[].entry`).

### 6.2 PR-walkthrough (`src/ui/components/pr-walkthrough/`, `defaults/tools/pr-walkthrough/`, `server/pr-walkthrough/routes.ts`)

| Existing behavior | Frozen primitive |
|---|---|
| `submit.yaml` / `read_pr_walkthrough_bundle.yaml` / `readonly_bash.yaml` tools | tool YAMLs + `renderer:` for any inline tool blocks |
| `PrWalkthroughPanel.ts` full-surface viewer | **`panels:`** → `host.ui.openPanel("pr-walkthrough.panel", { jobId })` |
| Deep-link to a walkthrough (`#/...`) | **`entrypoints:`** (git-widget button / command palette) + `host.ui.navigate("#/ext/pr-walkthrough/:jobId")` |
| `handlePrWalkthroughApiRoute` bespoke endpoints (server.ts:2259) | **`routes:`** → `/api/ext/pr-walkthrough/*` namespaced gateway endpoints, reached via `host.gateway.fetch` |
| Persisted walkthrough store (`STORE_SCHEMA_VERSION`, job/changeset state) | **`stores:`** → `host.store.*`, pack-scoped |
| `submit_pr_walkthrough_yaml` writing results back | `host.invokeAction("submit_pr_walkthrough", "publish", …)` (Phase-1 actions shape) **or** a `routes:` POST — both frozen |

PR-walkthrough is the maximal case: `routes` + `stores` + `panels` + `entrypoints`. All
four are reserved keys in §2; all the dynamic behaviors route through `host.gateway.fetch`
/ `host.ui.*` / `host.store.*` / `host.invokeAction`, all frozen in §3. **No Phase-1 shape
change required.**

> **Shape fix applied during this exercise.** The initial frozen `HostUiApi` had only
> `openPanel`; PR-walkthrough's deep-link/launcher need forced adding `navigate(route)` and
> the `entrypoints:` reserved key (both now in §2/§3). This is the litmus test doing its
> job — the shape was corrected here, before Phase 1 froze it, so Phase 2 is additive.

---

## 7. Phasing & non-goals

**Built in Phase 1:** pack renderer serving + runtime lazy registration (§4a); actions
module resolution + endpoint + dispatch + cache invalidation (§4b); `ToolRenderContext.host`
+ client/server Host API for `gateway.fetch` + `invokeAction` (§4c); the allowlist-bypass
fix + input validation + toolUseId verification + blast-radius controls (§5); the frozen
interfaces + manifest schema committed (§2/§3); this doc.

**Frozen, NOT built (Phase 2+):** `panels`, `stores`, `routes`, `entrypoints`;
`host.session.*` / `host.ui.*` / `host.store.*`; server-module worker/vm isolation. MCP +
AGENTS remain non-installable (unchanged from marketplace MVP). Phase-2 keys are
parsed-and-reserved today so packs authored against the full shape install cleanly now.

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
| Error isolation | Handler throws → 500, process survives; handler exceeds timeout → 504/500, slot released. | yes |
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
