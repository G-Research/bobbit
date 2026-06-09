# Authoring guide: Extension Host pack contributions

This guide walks through making a **marketplace pack** that contributes Extension Host
surfaces — a chat-block **renderer**, an interactive **server action handler**, and the
full Phase-2 surface set: side **panels**, pack-scoped **stores**, pack-owned **routes**,
non-chat **entrypoints**, and **session** access. By the end you will understand every
contribution point and the one mediated **Host API** they all flow through, with no
privileged escape hatch.

Start with the Phase-1 litmus (a **Retry** button wired to a server handler), then layer on
the Phase-2 surfaces. The two built-ins re-expressed as packs —
`market-packs/artifacts/` and `market-packs/pr-walkthrough/` — are the worked case studies
at the end.

**Read first:**

- [docs/marketplace.md](marketplace.md) — packs, sources, scopes/precedence, install/uninstall, and the full threat model. This guide assumes you can already author and install a pack.
- [docs/design/extension-host.md](design/extension-host.md) — the authoritative design: the contribution-point model, two-host architecture, the frozen (now fully implemented) Host API, the security guard sequence, the adapter layer (§3.3), and the isolation model (§3.4). This guide is the practical how-to; that doc is the *why* and the contract. The Phase-2 build plan is [extension-host-phase2.md](design/extension-host-phase2.md).

**Status:** Phase 1 (renderers + actions) and Phase 2 (panels, stores, routes, entrypoints, session, worker isolation) are both **implemented**. `HOST_API_VERSION` is `1`; `host.capabilities` reports all flags `true` on a current host.

The Phase-1 working example lives at `tests/fixtures/market-sources/retry-demo-src/retry-demo/` (exercised by the extension-host browser E2E); the Phase-2 surfaces are exercised by `market-packs/artifacts/` and `market-packs/pr-walkthrough/`.

## Big picture: what you are contributing, and where it runs

A tool pack can contribute several things beyond the tool itself, each declared as a key in the tool's YAML:

| Contribution | YAML key | Runs where | Host API surface |
|---|---|---|---|
| **Renderer** | `renderer:` | Browser, main UI thread | `host.invokeAction`, `host.requestRender` |
| **Server actions** | `actions:` | Gateway (confined worker) | the handler `ctx.host` |
| **Side panel** | `panels:` | Browser, main UI thread | opened via `host.ui.openPanel` |
| **Pack store** | `stores:` | Gateway | `host.store.{get,put,list}` (pack-namespaced) |
| **Pack routes** | `routes:` | Gateway (confined worker) | called via `host.callRoute` |
| **Entrypoints** | `entrypoints:` | Browser (launchers + deep-link routes) | `host.ui.navigate` / `openPanel` |
| **Permissions** | `permissions:` | Gateway worker (enable switch) | un-gates `git`/`fs`/`net` for server modules |

Plus the cross-cutting `host.session.*` (transcript reads, agent-driving posts, live events),
available to any surface that holds a `host`.

The halves talk through **one Host API**. The Phase-1 flow: a renderer calls
`host.invokeAction(tool, action, args)`; the gateway authorizes the call (like a tool call),
runs the matching handler, and returns its JSON; the renderer paints the result into its
**own local state**. Every Phase-2 capability routes through that same mediated, authorized
boundary — there is no raw escape hatch. Start with Phase 1 below, then see
[Phase-2 surfaces](#phase-2-surfaces-panels-stores-routes-entrypoints-session).

```
 Browser (renderer)                         Gateway (action handler)
 ┌──────────────────┐  host.invokeAction    ┌──────────────────────────┐
 │ Retry button     │ ───────────────────▶  │ POST /api/tools/:tool/   │
 │  @click          │   {sessionId,         │      actions/:action     │
 │                  │    toolUseId, args}   │   guard → load actions    │
 │ paints result ◀──┼───────────────────────┤   actions[action](ctx,…) │
 │ (local state)    │      JSON result      │   → JSON                  │
 └──────────────────┘                       └──────────────────────────┘
```

## Step 1 — pack skeleton

A pack is a directory with a `pack.yaml` and an entity payload laid out like Bobbit's `defaults/` tree. For a tool that ships a renderer + actions:

```
retry-demo/
  pack.yaml
  tools/
    demo/
      sample_action.yaml         # the tool + its contributions
      SampleActionRenderer.js    # pre-built ESM renderer (browser)
      actions.mjs                # server action handlers (gateway)
```

`pack.yaml` declares the pack and lists the tool **group** under `contents.tools`:

```yaml
# retry-demo/pack.yaml
name: retry-demo
description: A tool with a Retry button wired to a server action handler.
version: 1.0.0
contents:
  roles: []
  tools: [demo]      # the tools/<group> dir name
  skills: []
```

## Step 2 — the tool YAML with contributions

The tool YAML carries the two load-bearing keys. A pack tool needs **no `provider:`** — the renderer endpoint and the action dispatcher resolve the tool's on-disk location independently of `provider:`.

```yaml
# retry-demo/tools/demo/sample_action.yaml
name: sample_action
description: A demo tool with a Retry button wired to a server action handler.
group: Demo
summary: Demo tool — renders a Retry button wired to a server action.
renderer: SampleActionRenderer.js   # pre-built ESM renderer, beside this YAML
actions:
  module: actions.mjs               # default would be actions.js
  names: [retry]                    # endpoint allowlist (defense in depth)
```

- **`renderer:`** — path **relative to the tool's group dir** to the renderer ESM. Must have no `..` segments and not be absolute (rejected at parse time). For a pack tool it must end in `.js` to be recognized as a pack renderer.
- **`actions.module:`** — path (same safety rules) to the actions module. Defaults to `actions.js` when `actions:` is present without an explicit module.
- **`actions.names:`** — optional allowlist. When present, the endpoint rejects any `:action` not in the list **before loading the module** — author this to fail fast and shrink the attack surface.

> **The Phase-2 keys are live.** A tool may also declare `panels:`, `entrypoints:`, `routes:`, `stores:`, and `permissions:` — each is parsed into a typed contribution, surfaced on `/api/tools`, and acted on (see the [Phase-2 surfaces](#phase-2-surfaces-panels-stores-routes-entrypoints-session) section below). Per-tool parsing stays tolerant: a malformed block degrades to "absent" with a `console.warn`, never a hard rejection. (On an older Phase-1 server these keys are simply ignored, so a forward-authored pack still installs cleanly.)

## Step 3 — the renderer module

A pack renderer is a **pre-built ES module** — Bobbit does not compile pack UI, so ship the `.js`, not a `.ts`. Its default export is a **factory** that receives a host toolkit and returns a `ToolRenderer`.

### Why a factory + toolkit (not bare imports)

The factory is called with `{ html, nothing, renderHeader }` drawn from **the app's own `lit` instance**. Pack renderers must **never** bare-import `lit`: a second `lit` instance breaks reactive directives, and content-hashed chunk names make import-map mapping fragile. Take everything you need from the toolkit argument.

### The renderer contract

The factory returns an object with a single `render(params, result, isStreaming, ctx)` method returning:

```ts
{ content: TemplateResult, isCustom: boolean }
```

- `content` — a `lit` template built with the toolkit's `html`.
- `isCustom` — `false` wraps your output in the standard tool card; `true` opts out of the card wrapper.

The render context `ctx` carries `toolUseId`, `sessionId`, and the Phase-1 `ctx.host` (the Host API, bound to this render's session + tool-use id).

### Worked example

```js
// retry-demo/tools/demo/SampleActionRenderer.js
export default function createRenderer({ html, nothing, renderHeader }) {
  // toolUseId → latest handler result. Module-level so it survives re-mounts /
  // transcript re-renders WITHOUT mutating the transcript. This mirrors the
  // built-in children-mutation-approval pattern (src/ui/lazy/).
  const lastResult = new Map();

  return {
    render(_params, result, _isStreaming, ctx) {
      const toolUseId = ctx && ctx.toolUseId;
      const shown = toolUseId ? lastResult.get(toolUseId) : undefined;

      const onRetry = async () => {
        // sessionId + toolUseId are already bound into ctx.host; `args` carries
        // NO identity fields — it is pure action-domain input.
        const data = await ctx?.host?.invokeAction("sample_action", "retry", {});
        if (toolUseId) lastResult.set(toolUseId, data);
        // Ask the host to repaint so render() runs again and paints the result.
        ctx?.host?.requestRender?.();
      };

      return {
        isCustom: false,
        content: html`
          <div class="flex items-center justify-between gap-2" data-testid="pack-renderer-root">
            <span class="text-sm text-muted-foreground">Sample action</span>
            ${shown
              ? html`<span data-testid="pack-result">${shown.message}</span>`
              : nothing}
            <button
              class="text-xs px-2 py-0.5 rounded border border-border bg-transparent text-foreground"
              data-testid="pack-retry"
              @click=${onRetry}
            >
              Retry
            </button>
          </div>
        `,
      };
    },
  };
}
```

### Renderer rules (these are enforced / reviewed)

- **No auto-invoke on render.** `host.invokeAction` may only be called from a **user gesture** (the click handler). A renderer that fires an action during `render()` is rejected — it is the UI-thread security control, and the E2E asserts no action POST fires before a click.
- **Renderer-local result, no transcript mutation.** An action result flows back **only** as the `invokeAction` promise. Store it in local state — a module-level `Map` keyed by `toolUseId` (as above), or a mounted `LitElement` with `@state` — and repaint. Phase-1 handlers do **not** rewrite the transcript or the persisted tool result; the `result` argument to `render()` is unchanged by an action. (Turn-resume / message-post is frozen for Phase 2 via `host.session.*`.)
- **Repaint via `requestRender()`.** After a result resolves, call `ctx.host.requestRender()` so the memoized tool block re-runs `render()` and paints your local state. A renderer that mounts its own `LitElement` uses native reactivity instead and ignores this.
- **Theme tokens only.** Use Bobbit's CSS custom properties / utility classes (`text-muted-foreground`, `border-border`, etc.). Never hardcode colors.
- **Card contract.** Set `isCustom` deliberately — `false` for a standard card-wrapped block, `true` only when you render your own container.

### `requestRender()` placeholder + failure fallbacks (free)

You don't wire up loading or error UI. The client registers your renderer lazily: on first paint it shows the standard **placeholder**, and if the module fails to load (or has no factory export) it installs the standard **load-failure fallback**. Registration is re-driven from `/api/tools` metadata on every cold load, so your renderer **survives a page reload** with no install-time state, and an **uninstall** restores the displaced built-in (or default rendering) live, without a reload.

## Step 4 — the server actions module

The actions module exports `const actions`, a map of action name → handler. It is imported by the **gateway under plain Node**, so it must be ESM-loadable.

### Ship it as `.mjs`

A bare `.js` file containing `export` loads as **CommonJS** under Node (the surrounding project has no `package.json` `"type": "module"`) and throws. Name the module **`actions.mjs`** and point `actions.module` at it. (The renderer stays `.js` because the browser always imports it as ESM.)

### Handler signature

```ts
type ActionHandler = (ctx: ActionHandlerCtx, args: unknown) => Promise<unknown> | unknown;

interface ActionHandlerCtx {
  host: ServerHostApi;   // audited, scoped gateway access (see below)
  sessionId: string;     // the verified calling session
  toolUseId: string;     // the verified tool_use id being acted on
  tool: string;          // == :tool
}
```

The first argument `ctx` is **verified by the endpoint** — `sessionId` and `toolUseId` have already passed the guard (session resolved, `:tool` in `allowedTools`, `toolUseId` proven to exist in this session and to have been a call of `:tool`). The second argument `args` is **untrusted, LLM-influenced JSON** — validate / whitelist it; never `eval`, `exec`, `require`, or build filesystem/session paths from it.

### Worked example

```js
// retry-demo/tools/demo/actions.mjs
export const actions = {
  retry: async (_ctx, _args) => ({ message: "retried", at: Date.now() }),
};
```

The returned object is JSON-serialized back to the renderer as the `invokeAction` result. Here `message` flows into the renderer's `pack-result` element.

### What `ctx.host` exposes (and what it deliberately does NOT)

There is **no `host.gateway.fetch`** and no other raw passthrough. The durable v1 contract removes the escape hatch on purpose: Bobbit *serves* a typed contract rather than handing extensions a window into internals. The only sanctioned pack→server path is the action endpoint itself — which is exactly the call your renderer already made via `invokeAction` and which the gateway has already authorized and audited.

The server-side `ctx.host` carries:

- `ctx.host.version` / `ctx.host.contractVersion` — the frozen contract revisions.
- `ctx.host.capabilities` — the **single source of truth** for what is implemented.
- `ctx.host.store.{get,put,list}` — pack-namespaced persistence, scoped to the **server-derived** `packId` (you never pass an id). Same backend as the client `host.store.*`.
- `ctx.host.session.{readTranscript,readToolCall}` — own-session reads through the internal→contract adapter.

There is deliberately **no** `ctx.host.callRoute` or `ctx.host.ui` server-side: a server handler reaches its own pack's route by calling the function directly, and a server module has no UI to drive — so these are CLIENT-only surfaces, intentionally absent (not unimplemented gaps). There is still **no `host.gateway.fetch`** and no raw passthrough. **Feature-detect with `ctx.host.capabilities.<name>` / `ctx.host.capabilities.has(name)`, never with member-presence checks.**

A handler that genuinely needs raw `fs` / `child_process` / network must **declare it** via the manifest `permissions:` key (see *Server-module confinement* below) — server modules run in a confined worker, so they are *not* ambient-authority host code. Removing `gateway.fetch` keeps the *pack→server boundary* a typed, authorized contract with no raw transport to misdirect.

A renderer/panel reaching dynamic server data uses the client-side, pack-scoped, typed `host.callRoute(name, init)` — it reaches **only** the calling pack's OWN routes (the server derives `<pack>` from the proven `tool`, so an arbitrary gateway path is unaddressable), authorized through the same per-session guard. See the [routes section](#routes--the-packs-own-server-endpoints-hostcallroute).

### Blast-radius controls you get for free

Handlers run in the long-lived gateway process, so Bobbit bounds the damage a buggy or hostile handler can do: a **per-call timeout** (default 30s) that spans **both** the module load+evaluation *and* the handler execution — it returns 504 to the caller while the underlying promise keeps its concurrency permit until it actually settles; a **global concurrency cap** (default 8 in-flight); a **per-session token-bucket rate limit**; **try/catch isolation** (a throw becomes a 500, never a process crash); and **audit logging** of every invocation. You do not configure these from the pack; design your handlers to be fast and side-effect-careful regardless.

### Server-module confinement + declared permissions (Phase 2)

Pack server modules (`actions.mjs` / `routes.mjs`) no longer run with ambient host
authority. As of Phase 2 (design [§9](design/extension-host-phase2.md)) every handler
runs in a **confined worker**: the dangerous Node built-ins (`fs`, `child_process`,
`net`/`http(s)`, `process`, `worker_threads`, …) are **deny-listed at import**, the
outbound-network globals (`fetch`/`WebSocket`/…) are **stripped**, the ambient
`process` is replaced by an **inert shim** (empty env, `cwd()=>"/"`), the module graph
is **confined to the pack root**, and the worker is **terminated on timeout** with
memory caps. The only capability a handler gets by default is the `ctx.host` proxy.
**Default is deny-all** — a pack that declares nothing keeps exactly this confinement.

A *trusted* pack can OPT IN to a narrow set of host capabilities via a manifest
`permissions:` array. The grant is resolved **server-side from the winning
contribution** (never caller-supplied) and applied to the worker:

```yaml
name: my_pack_tool
actions: actions.mjs
permissions: ["git", "fs"]   # subset of git | fs | net; absent/empty ⇒ deny-all
```

| value | grants | notes |
|-------|--------|-------|
| `git` | imports `node:child_process` so the pack can spawn the `git` binary | a spawned child is tracked and **killed if the handler times out** (it cannot outlive the wall-time cap); the binary resolves via `PATH` |
| `fs`  | imports `node:fs` / `node:fs/promises` | reads/writes are NOT path-sandboxed — use `process.cwd()` (see below) to scope to the session dir |
| `net` | keeps `fetch`/`WebSocket`/… and un-denies `node:net`/`node:http(s)` | outbound network egress |

With `git`/`fs` granted the process shim exposes a **real `cwd()`** (the session
working dir) plus a **minimal env containing only `PATH`** — never the gateway's full
env or any token/secret. Because `process.chdir()` is unsupported in a worker, build
paths / spawn options explicitly from `process.cwd()`:

```js
import { spawn } from "node:child_process";   // requires permissions: ["git"]
import { join } from "node:path";              // node:path is never denied
export const actions = {
  log: async (ctx) => new Promise((resolve, reject) => {
    const c = spawn("git", ["log", "-1", "--format=%H"], { cwd: process.cwd() });
    let out = ""; c.stdout.on("data", (d) => out += d);
    c.on("error", reject); c.on("close", () => resolve(out.trim()));
  }),
};
```

Ungranted capabilities stay denied/stripped exactly as in the deny-all default, so a
pack only ever holds the capabilities its manifest declares.

## Step 5 — the client→server call (Host API recap)

From the renderer:

```js
const result = await ctx.host.invokeAction("sample_action", "retry", { /* args */ });
```

- `sessionId` and `toolUseId` are **not** parameters — they come from the bound render context and are supplied to the endpoint internally. Keep `args` free of identity fields.
- This POSTs `/api/tools/sample_action/actions/retry` with `{ sessionId, toolUseId, args }`. The endpoint authorizes the call **like a tool call**: it requires `x-bobbit-session-id`, `body.sessionId === header`, `:tool` in the session's `allowedTools`, `:action` in `actions.names` (when declared), and a `toolUseId` that exists in the header-bound session and was a call of `:tool`. Because the LLM can `curl` this endpoint directly with the admin token, *this* guard — not the agent layer — is the real gate.
- It resolves with the handler's JSON result, or rejects on a guard/handler failure.

`invokeAction` is the **only** Phase-1 pack→server path — there is no lower-level raw-fetch seam. The endpoint is built same-origin inside the client Host API ([`src/app/host-api.ts`](../src/app/host-api.ts)), so there is no caller-supplied URL or `Authorization` header anywhere in the flow.

### Feature-detection and the durable forward path

From a renderer or panel, check capabilities the same way the server side does — via `host.capabilities`, never member presence:

```js
if (host.capabilities.invokeAction) { /* always true on a v1 host */ }
if (host.capabilities.has("callRoute")) { /* Phase-2; true on a current host */ }
```

A current host (Phase 1 + Phase 2) reports **all client flags `true`** — `{ invokeAction, requestRender, callRoute, session, ui, store }`. Capabilities is still the single source of truth: an *older* Phase-1 host reports the Phase-2 flags `false` (with present-but-throwing stubs for type stability), so `if (host.store)` would wrongly succeed — always gate on `host.capabilities`. `host.version` (`HOST_API_VERSION`, still `1`) and `host.contractVersion` (`HOST_CONTRACT_VERSION`) identify the contract revision only.

The Phase-2 surfaces, all implemented to their frozen v1 signatures in [`src/shared/extension-host/host-api.ts`](../src/shared/extension-host/host-api.ts):

- **`host.callRoute(name, init)`** — the typed, pack-scoped replacement for raw fetch (see [routes](#routes--the-packs-own-server-endpoints-hostcallroute)). Reaches only your pack's OWN routes, addressed by declared `name` (no `path`/URL field).
- **`host.store.*` / `host.session.*` / `host.ui.*`** — pack-scoped persistence, own-session transcript access + agent-driving posts, and structured panel/route navigation (see [Phase-2 surfaces](#phase-2-surfaces-panels-stores-routes-entrypoints-session)).
- **Host-API-owned data contracts** — `HostMessage`, `HostContentBlock`, `ToolCallRecord`, and typed session-event payloads are stable shapes the contract *owns* and versions (`HOST_CONTRACT_VERSION`), mapped from Bobbit's internal wire by the internal→contract adapter (`contract-adapter.ts`). Packs read these instead of Bobbit internals, so internal refactors never break a pack.
- **Structured addressing** — `host.ui.openPanel(target)` / `host.ui.navigate(target)` take typed `{ panelId | route, params }` objects, never hash strings, so the contract never bakes in today's router.

Because every Phase-2 capability is purely additive (no signature churn, no `HOST_API_VERSION` bump), code written against `capabilities` stays forward- and backward-compatible.

## Step 6 — install, test, iterate

1. Register the source (the dir containing your pack), then **Install** the pack into a scope (see [docs/marketplace.md](marketplace.md)).
2. `/api/tools` now lists your tool with `rendererKind: "pack"` (and `hasActions: true`).
3. Open a session whose transcript contains a call of your tool → it renders with your pack renderer (placeholder → real renderer).
4. Click the action button → the handler runs → your renderer paints the result.
5. **Reload** the page → the renderer still loads (registration is re-driven from metadata).
6. **Update** the pack (edit + re-sync + Update) → caches invalidate synchronously; the next call uses the new code.
7. **Uninstall** → the renderer and actions disappear live (a subsequent action POST 404s); any displaced built-in is restored.

## Phase-2 surfaces: panels, stores, routes, entrypoints, session

Phase 2 makes the rest of the contribution shape load-bearing. Everything below is reached
through the **same** Host API your renderer already holds (`ctx.host`, or the `host`
argument a panel/entrypoint is handed) and authorized through the **same** per-session guard
— there is still no raw escape hatch. The four new manifest keys (`panels:`, `stores:`,
`routes:`, `entrypoints:`) and the `permissions:` key are all declared on the **tool YAML**,
alongside `renderer:`/`actions:`.

### How pack identity is bound (you never supply it)

The scoped capabilities (`host.store.*`, `host.callRoute`, `host.session.*`) all act **as a
specific pack** — store keys are namespaced by `packId`, `callRoute` reaches only your
pack's own routes, session reads are own-session. That identity must not be forgeable, so it
is **server-derived, never caller-supplied**:

- When the trusted app constructs a surface's Host API (a renderer, panel, or entrypoint) it
  asks the server to mint a **surface-binding token** (`POST /api/ext/surface-token`) for
  the *tool* the surface belongs to. The server resolves the **winning contribution** for
  that tool — the same resolution that *is* the pack identity — and returns an opaque,
  HMAC-signed token bound to `{sessionId, packId, contributionId, tool}`.
- The token is held in the Host API **closure** — **your pack code never sees it, sets it,
  or sends it.** It is echoed automatically on every scoped call; the server re-validates it
  and derives `{packId, tool}` from it, ignoring anything a caller tries to send.

**Practical consequence for you:** you just call `host.store.get(...)` / `host.callRoute(...)`
/ `host.session.readToolCall(...)`. You never pass a pack id, a `tool` name, or a token. The
"which pack am I" question is answered entirely server-side. (A same-realm malicious pack
could still forge its own token — the documented Model-A residual; see
[marketplace.md](marketplace.md). The token closes the *accidental* cross-pack path.)

### `stores:` — pack-scoped server persistence (`host.store.*`)

Declare a store, then read/write it from any of your surfaces. Keys are namespaced under
your server-resolved `packId`, so one pack **cannot** read another's keys.

```yaml
# tools/<group>/<tool>.yaml
stores:
  - id: artifacts        # advisory declaration; the backing namespace is keyed by packId
```

```js
// From a renderer, panel, or route handler that holds `host`:
await host.store.put(artifactId, { type: "html", html });   // value is JSON-serialized
const payload = await host.store.get(artifactId);            // null if absent
const keys = await host.store.list("draft-");                // optional prefix filter
```

- **Backend:** one JSON file per key under `<state>/ext-store/<packId>/<encodedKey>.json`. Keys are percent-encoded and the resolved path is re-validated to stay inside the `packId` dir, so a `../` key cannot traverse out.
- **Cross-pack reads are rejected by construction** — the `packId` comes from the surface token, never the request, so there is no path to form a key outside your own dir.
- **Non-pack callers are rejected** (`store` is pack-only). Deep-links carry only ids; the payload lives in the store, so a panel reopened from a URL rehydrates by `store.get(id)` and survives reload.

### `panels:` — persistent side panels (`host.ui.openPanel`)

A panel is a **pre-built ESM module** (same Blob-URL + factory-toolkit delivery as a
renderer) that mounts as a side-panel tab. Declare it, then open it by structured target.

```yaml
panels:
  - id: artifacts.viewer        # pack-unique panel id
    title: Artifact             # tab label
    entry: ArtifactViewerPanel.js   # pre-built ESM, path-safe, relative to the group dir
```

```js
// From a renderer's click handler:
host.ui.openPanel({ panelId: "artifacts.viewer", params: { artifactId } });
```

The panel module's factory is handed the host toolkit **plus a `host`** bound to the active
session and the panel's pack (`toolUseId` is `undefined` — a panel originates no tool call).
So a panel can call `host.store.*`, `host.callRoute`, and `host.session.*` — everything a
renderer can except `invokeAction` (which is tool-call-scoped). The panel is served
bearer-only by `GET /api/tools/:tool/panel/:panelId` (serving module bytes is
static-asset-equivalent), lazily imported, registered through the **same
generation-guarded chokepoint** as renderers (reload-safe, reconcile-on-uninstall,
project-scoped).

**Panel conventions (enforced — identical to renderer rules):** theme tokens only (no
hardcoded colors, no private `:root{}`, no `prefers-color-scheme`); preserve any embedded
iframe `sandbox` attribute (untrusted/LLM content goes in a `sandbox`ed iframe — the trust
boundary is content-origin, not which code drew it); **no auto-invoke / navigation on
mount** (a panel must not post, navigate, or fire an action just because it mounted).

### `routes:` — the pack's own server endpoints (`host.callRoute`)

When a surface needs **dynamic server data**, the pack ships a route module and the surface
calls it by name. This is the durable replacement for a raw fetch — `callRoute` can address
**only your own pack's routes**, never an arbitrary gateway path.

```yaml
routes:
  module: routes.mjs        # default routes.js; .mjs so Node loads it as ESM (like actions)
  names: [bundle, publish]  # the route names this module exports
```

```js
// routes.mjs — a map of route name → handler, mirroring actions.mjs
export const routes = {
  // ctx is verified server-side {host, sessionId, toolUseId?, tool}; req carries the HostRouteInit
  bundle: async (ctx, req) => {
    const jobId = req.query?.jobId;
    return await ctx.host.store.get(`job:${jobId}`);   // own-pack store, scoped
  },
  publish: async (ctx, req) => {
    await ctx.host.store.put(`job:${req.body.jobId}`, req.body.payload);
    return { ok: true };
  },
};
```

```js
// From a renderer or panel:
const data = await host.callRoute("bundle", { query: { jobId } });   // GET by default
await host.callRoute("publish", { method: "POST", body: { jobId, payload } });
```

- **Namespace by construction.** The client sends only the surface token; the server derives your `packId` and resolves the route **module** through a **pack-level `RouteRegistry`** — so a panel opened from tool *X* can reach a route declared on tool *Y* in the **same pack**. There is no `<pack>` URL segment to forge.
- **One route name per pack.** Declaring the same route name on two tools in one pack is a hard rejection at registry build (the rare real-conflict failure). Cross-pack names never collide (the registry is keyed by `packId`).
- **Server-side, route handlers run in the confined worker** (see *Server-module confinement* below) — so a route that needs `git`/`fs`/`net` must disclose it via `permissions:`.

#### Using a declared `permissions:` capability inside a route

A route (or action) handler that needs ambient OS access **discloses** it in the tool YAML;
the grant is resolved server-side from the winning contribution and applied to the worker
(see the full `permissions:` table under *Server-module confinement*). Example: the
PR-walkthrough `bundle` route recomputes a real `git diff` live —

```yaml
permissions: [git, fs]      # un-gates node:child_process + node:fs in this pack's worker
routes:
  module: routes.mjs
  names: [bundle, publish]
```

```js
// routes.mjs — requires permissions: ["git"]
import { spawn } from "node:child_process";   // denied unless `git` is disclosed
export const routes = {
  bundle: async (ctx, req) => {
    // process.cwd() is the session working dir (chdir is unavailable in a worker);
    // the git binary resolves via the PATH-only env the grant provides.
    const diff = await new Promise((resolve, reject) => {
      const c = spawn("git", ["diff", req.query.baseSha, req.query.headSha], { cwd: process.cwd() });
      let out = ""; c.stdout.on("data", (d) => (out += d));
      c.on("error", reject); c.on("close", () => resolve(out));
    });
    return { diff };
  },
};
```

`permissions:` is **disclosure + an enable switch, not a constrained runner**: disclosing
`git` un-gates `child_process` *fully* (you may run **any** command, exactly like a tool),
`fs` un-gates `node:fs` with **no** path containment, `net` restores outbound network. The
worker still terminates the handler on timeout and SIGKILLs any spawned child, but those are
**stability** guarantees, not a security boundary against your own trusted code. The worker
has **no** model credentials / gateway token (PATH-only env) — so credentialed work (e.g.
LLM synthesis) must happen agent-tool-side and be read back from the store, not done in the
route. See the PR-walkthrough case study.

### `entrypoints:` — non-chat launchers + deep-link routes (`host.ui.navigate`)

Entrypoints put your pack on surfaces outside the chat transcript, and register
deep-linkable SPA routes.

```yaml
entrypoints:
  # Launchers — a click is the user gesture; it opens a panel or navigates a route.
  - id: pr-walkthrough.open
    kind: composer-slash          # composer-slash | git-widget-button | command-palette
    label: PR Walkthrough
    target: { route: pr-walkthrough, params: { jobId: job-litmus-1 } }
  # A deep-linkable route — NO clickable surface; maps a routeId → panel + URL params.
  - id: pr-walkthrough.route
    kind: route
    routeId: pr-walkthrough
    target: { panelId: pr-walkthrough.panel }
    paramKeys: [jobId, baseSha, headSha]   # the only params serialized into / parsed from the URL
```

```js
// A launcher's click handler (or your own panel button):
host.ui.navigate({ route: "pr-walkthrough", params: { jobId } });
```

- **Launcher kinds** (`composer-slash`, `git-widget-button`, `command-palette`) register a label that, on click, calls `openPanel` or `navigate`. The click **is** the user gesture — never auto-invoke on mount.
- **`kind:"route"`** registers a deep-link in the client pack-route registry. `navigate({ route, params })` looks it up, filters `params` to the declared `paramKeys`, and serializes `#/ext/<routeId>?<params>` through the router — **you never build a URL string**. On load, that hash is parsed back, the panel is reopened, and it rehydrates from `host.store.*`. So a deep-link carries only ids and survives reload; an unknown route is a no-op (e.g. the owning pack was uninstalled).
- **One `routeId` per host.** Two packs/tools declaring the same `routeId` is a hard rejection at registry build (mirrors duplicate route names).

### `host.session.*` — transcript reads, posts, and live events

The session namespace lets a surface read its own transcript, drive the agent, and
subscribe to live events. All reads are **own-session-scoped** (there is no parameter for
another session); writes require a **genuine user gesture + a server-minted permit**.

```js
// READS (own session, mapped through the internal→contract adapter):
const env = await host.session.readTranscript({ offset: 0, limit: 50, pattern: "error" });
//   → { total, returned, messages: HostMessage[] }   (`pattern` is a literal substring, not a regex)
const call = await host.session.readToolCall(toolUseId);
//   → ToolCallRecord | null   ({ toolUseId, tool, input, output, isError })

// LIVE EVENTS (typed; returns an unsubscribe fn):
const off = host.session.subscribe("tool_result", ({ record }) => { /* … */ });
//   events: "tool_result" | "status" | "message"

// WRITE — drives the agent. MUST be called from a real user gesture (e.g. a button click):
await host.session.postMessage({ role: "user", text: "re-run the tests", resumeTurn: true });
```

- **Reads** return the Host-API-owned contract shapes (`HostMessage`, `ToolCallRecord`, …), produced by the internal→contract adapter — never Bobbit's internal wire — so internal refactors never break your pack.
- **`postMessage` is the highest-risk capability** (it drives the agent), so it is defended in depth and you must respect one rule: **only call it from a real user gesture.** It reads `navigator.userActivation` synchronously and **throws** if no gesture is active, so a post on mount fails loudly. Under the hood it rides the app's authenticated session WebSocket (pack code has no handle to it) and carries a one-time, content-bound, server-minted permit — a captured/replayed/forged frame is rejected server-side. A `role:"system"` message is delivered as an explicit system directive (not as raw user text); `resumeTurn` (default true) resumes the agent turn, `false` delivers a live steer.
- **Cross-session posting is impossible** — the target is the WS connection's own authenticated session, never a parameter.

## Bundling npm dependencies into a pack (vendoring)

A renderer/panel module is loaded by the client via a **Blob-URL `import()`** and handed the host toolkit (`{ html, nothing, renderHeader }`) as a FACTORY parameter — it must NOT bare-import `lit`. But it CAN use other npm libraries (syntax highlighters, PDF/DOCX renderers, charting, …) as long as they are **bundled into the served module** ahead of time. "Bundling" is therefore an author-side BUILD convention, not a runtime loader feature:

```
market-packs/<pack>/src/*.ts        ← SOURCE: imports npm deps freely (never `lit`)
        │  esbuild (scripts/build-market-packs.mjs)
        ▼
market-packs/<pack>/tools/<group>/<entry>.js   ← BUILT: self-contained ESM, committed
```

Run `npm run build:packs` (wired into `npm run build`, so CI/E2E always rebuild). The marketplace ships the **built** assets as-is, so commit the bundles.

Two hard rules keep a bundle loadable by the Blob-URL loader:

1. **Never bundle `lit`** — it is injected. `lit`/`lit/*` are marked `external`; pack source must not import them.
2. **One self-contained file per entry — NO code splitting / dynamic chunks.** A Blob-URL module has no resolvable base for `import("./chunk.js")`, so every dep is inlined eagerly (`splitting: false`). Don't lazy-`import()` a bundled dep.

**Web Workers (the pdfjs wrinkle).** A library that spins up a Web Worker can't resolve a sibling worker file from a `blob:` URL, and there is no pack-asset endpoint. Pre-bundle the worker SOURCE to a string (an esbuild virtual module) and create a Blob-URL `workerSrc` from it at runtime — see `market-packs/artifacts/src/binary-render.ts` + the `virtual:pdf-worker` plugin in `scripts/build-market-packs.mjs`.

**Node-safety for unit tests.** Keep pure logic (no DOM-at-import deps) in a node-safe `helpers.ts` the unit suite can import under tsx; libraries that touch DOM globals at module-eval (pdfjs, docx-preview) belong in a browser-only module the bundle pulls in but node never imports. Assert those in the browser E2E.

**Migration case study — artifacts pack.** `market-packs/artifacts/` is the built-in artifact viewer re-expressed as a pack at full behavioral parity: `highlight.js` for code highlighting, `pdfjs-dist` for real PDF page rendering, `docx-preview` for DOCX, and a postMessage console-capture shim — all vendored via this convention. HTML artifacts still render inside a `sandbox="allow-scripts"` iframe (the trust boundary is content-origin, not code). See `tests/artifacts-pack-viewer.test.ts` (node) + `tests/e2e/ui/artifacts-pack.spec.ts` (browser).

## Migration case studies — two built-ins re-expressed as packs

The acceptance proof for Phase 2 is that two bespoke built-ins were re-expressed as
installable market packs with **behavioral parity** — using only public contributions + the
Host API. They are the best end-to-end references for combining the surfaces above.

### `market-packs/artifacts/` — renderer + panels + stores + a deep-link route

The artifact viewer (inline pill + full viewer for HTML/Markdown/SVG/image/PDF/DOCX).
Contribution map:

| Built-in piece | Pack contribution |
|---|---|
| Inline artifact pill (`ArtifactPill` + the artifacts tool renderer) | `renderer:` (`ArtifactRenderer.js`, an `isCustom` full-surface pill) |
| Viewer surface (`ArtifactElement` + per-type components) | `panels:` `artifacts.viewer` (`ArtifactViewerPanel.js`), opened via `host.ui.openPanel({ panelId, params: { artifactId } })` |
| `persistPreviewArtifact` / `restorePreviewArtifact` | `stores:` → `host.store.put/get(artifactId)`, pack-namespaced |
| Reopen a viewer by id / deep-link parity | `entrypoints:` `kind:"route"` (`routeId:"artifacts"`, `paramKeys:["artifactId"]`) + `host.ui.navigate({ route:"artifacts", params:{ artifactId } })` → `#/ext/artifacts?artifactId=…` → store-rehydrated panel |

The canonical chain it proves: `renderer` persists to `store` → `openPanel` rehydrates from
`store` → `navigate` serializes a deep-link route → reload re-parses the hash → reopens the
panel rehydrated from `store.get`. Real parity needs the real libraries, so `highlight.js`,
`pdfjs-dist`, and `docx-preview` are **vendored** (esbuild-bundled at publish time; see
*Bundling* above), and HTML artifacts still render inside a `sandbox="allow-scripts"`
iframe — the trust boundary is content-origin, not which library drew the pixels. Tests:
`tests/artifacts-pack-viewer.test.ts` (node) + `tests/e2e/ui/artifacts-pack.spec.ts`
(browser).

### `market-packs/pr-walkthrough/` — the maximal case (all reserved keys)

The PR-walkthrough viewer uses **every** contribution key plus session reads and a disclosed
`git`/`fs` permission:

| Built-in piece | Pack contribution |
|---|---|
| `PrWalkthroughPanel` viewer | `panels:` `pr-walkthrough.panel` (`panel.js`), opened via `host.ui.openPanel({ panelId, params:{ jobId } })` |
| `handlePrWalkthroughApiRoute` bespoke endpoints | `routes:` (`routes.mjs`, names `bundle`/`publish`), reached via `host.callRoute("bundle", { query: { jobId } })` — **never** a raw fetch |
| `walkthrough-store.ts` (`WALKTHROUGH_STORE_SCHEMA_VERSION`, job/changeset state) | `stores:` → `host.store.*`, pack-scoped |
| Deep-link + launchers (`#/walkthrough`, git-widget) | `entrypoints:` — composer-slash + git-widget-button + command-palette launchers **and** a `kind:"route"` deep-link (`routeId:"pr-walkthrough"`) |
| Bespoke transcript access to `submit_pr_walkthrough_yaml` | `host.session.readToolCall(toolUseId)` (own-session, via the adapter) |
| Live `git diff` recompute | `permissions: [git, fs]` → the `bundle` route runs **real `git`** live in the C3 worker |

Two non-obvious decisions worth copying:

1. **Pack-level route resolution is opener-independent.** The panel (one tool) calls `host.callRoute("bundle", …)`, but the `bundle` route is declared on the routes-bearing tool. Because the server resolves the route **module** through the pack-level `RouteRegistry` (keyed by `packId`), the panel-originated call reliably reaches it — you do not need the route and the opener on the same tool, only in the same pack.
2. **The synthesis-credential split.** The worker has a PATH-only env and **no** model credentials, so LLM card synthesis cannot run inside the `bundle` route. The split: the `submit_pr_walkthrough_yaml` **agent tool** (with normal agent credentials) synthesizes the rich cards at submit time and the `publish` route persists them to `host.store` keyed by changeset id; the `bundle` route only *computes* the deterministic diff + fallback cards live (via the disclosed `git`/`fs`) and *reads* the stored LLM cards. So a credentialed capability stays agent-tool-side and the route is a live computer + store reader, never an in-worker model caller. (A future host-provided synthesis capability that runs in the parent — where credentials live — is a documented follow-up; see `docs/design/pr-walkthrough-pack-deletion.md`.)

Tests: `tests/e2e/ui/pr-walkthrough-pack.spec.ts` (install → launcher → panel renders from
`callRoute` + store → `readToolCall` → deep-link → uninstall).

## Security checklist

The Host API is the single security boundary. As an author, your obligations are:

- [ ] **Never auto-invoke an action on render** — only from a user gesture.
- [ ] **Validate / whitelist `args`** in every handler; never `eval`/`exec`/`require` it or derive paths from it.
- [ ] **Declare `actions.names`** so unknown actions are rejected before the module loads.
- [ ] **Keep `args` identity-free** — `sessionId`/`toolUseId` come from the verified context, not from args.
- [ ] **Don't bare-import `lit`** in a renderer — use the factory toolkit.
- [ ] **Use theme tokens**, preserve any iframe `sandbox` attributes, and never mutate the transcript from a renderer.
- [ ] **Go through the Host API** for every pack→server call — `host.invokeAction` (actions), `host.callRoute` (your own routes), `host.store.*`, `host.session.*`. Do not hand-roll a gateway request or reach for any raw fetch; there is none by design.
- [ ] **Never build a URL or hash string** — `host.ui.openPanel` / `host.ui.navigate` take structured `{ panelId | route, params }` targets; the host maps them onto the router.
- [ ] **No post / navigate / action on mount** — panels and entrypoints must act only from a real user gesture. `host.session.postMessage` is gesture-gated and will throw on mount.
- [ ] **Never supply a pack id, `tool`, or token to a scoped call** — pack identity is server-derived from the surface-binding token held in the Host API closure.
- [ ] **Disclose ambient OS access via `permissions:`** (`git`/`fs`/`net`) — and remember it un-gates the *full* capability; it is disclosure + an enable switch, not a constrained runner. Never expect model credentials / a gateway token inside a server module (PATH-only env).
- [ ] **Panels follow the renderer rules** — theme tokens only, preserve iframe `sandbox`, set `isCustom` deliberately.
- [ ] **Feature-detect via `host.capabilities`**, never member presence — the single source of truth for what a host implements.

The deeper model — the allowlist-bypass fix, `toolUseId` ownership verification, single-sourced session identity, the `authorizeScopedRequest` vs `authorizeActionRequest` split, the contract adapter (§3.3), and the worker isolation model (§3.4) — is documented in [docs/design/extension-host.md](design/extension-host.md) and [docs/marketplace.md](marketplace.md) (threat model).

## Reference

- Worked example pack (Phase 1): `tests/fixtures/market-sources/retry-demo-src/retry-demo/`
- Litmus packs (Phase 2): `market-packs/artifacts/`, `market-packs/pr-walkthrough/`
- Browser E2Es: `tests/e2e/ui/extension-host.spec.ts`, `artifacts-pack.spec.ts`, `pr-walkthrough-pack.spec.ts`
- Frozen Host API types: `src/shared/extension-host/host-api.ts`
- Action / route dispatch + handler ctx: `src/server/extension-host/action-dispatcher.ts`, `route-dispatcher.ts`
- Server-side Host API (`ctx.host`): `src/server/extension-host/server-host-api.ts`
- Pack identity + scoped authz: `pack-identity.ts`, `action-guard.ts`, `surface-binding.ts`
- Internal→contract adapter: `src/server/extension-host/contract-adapter.ts`
- Pack store + permissions + worker isolation: `pack-store.ts`, `permission-grants.ts`, `module-host-worker.ts`, `confinement-loader.ts`
- Session write (permit + WS): `session-write.ts`, `session-write-permit.ts`, `src/app/session-write-bridge.ts`
- Contribution-manifest parser: `src/server/agent/tool-contributions.ts`
- Client registries: `src/app/pack-renderers.ts`, `pack-panels.ts`, `pack-entrypoints.ts`
- Renderer render-context type: `src/ui/tools/types.ts`
