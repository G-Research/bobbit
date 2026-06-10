# Authoring guide: Extension Host pack contributions

This guide walks through making a **marketplace pack** that contributes Extension Host
surfaces — a chat-block **renderer**, an interactive **server action handler**, side
**panels**, pack-owned **routes**, non-chat **entrypoints**, implicit pack-scoped **stores**,
and **session** access. By the end you will understand every contribution point, *where each
one is declared on disk*, and the one mediated **Host API** they all flow through — with no
privileged escape hatch.

The schema is laid out so that **each contribution lives where its runtime scope already is**:

- **Tool-scoped** contributions (`renderer`, `actions`) stay on the tool YAML — they are the
  only ones that depend on a tool call / `toolUseId`.
- **Pack-scoped** contributions move off arbitrary tool YAMLs: panels and entrypoints are
  one-file-each under `panels/` and `entrypoints/`, and routes are a single module + allowlist
  declared on `pack.yaml`.
- **Shared implementation** lives in `lib/`, reachable from any declaring file via `../`.
- **Stores are implicit** — the namespace is already the server-derived `packId`, so there is
  nothing to declare.

This is the **V1 pack schema**. The authoritative schema contract — every field, every
addressing change, the wire shapes, and the security invariants — is
[docs/design/pack-schema-v1-rationalisation.md](design/pack-schema-v1-rationalisation.md).
This guide is the practical how-to.

**Read first:**

- [docs/marketplace.md](marketplace.md) — packs, sources, scopes/precedence, install/uninstall, activation controls, and the full threat model. This guide assumes you can already author and install a pack.
- [docs/design/extension-host.md](design/extension-host.md) — the contribution-point model, two-host architecture, the frozen Host API, the security guard sequence, the adapter layer, and the isolation model. The *why* and the contract. (Its per-tool schema examples predate V1 — read them through [pack-schema-v1-rationalisation.md](design/pack-schema-v1-rationalisation.md).)

**Status:** renderers, actions, panels, routes, entrypoints, implicit stores, session access, and worker isolation are all **implemented**. `HOST_API_VERSION` is `1`; `host.capabilities` reports all flags `true` on a current host.

The renderer+action working example lives at `tests/fixtures/market-sources/retry-demo-src/retry-demo/`; the full pack-scoped surface set is exercised by `market-packs/artifacts/` (a tool + panel + deep-link pack) and `market-packs/pr-walkthrough/` (a **no-tools / UI-only** pack).

## Big picture: what you are contributing, and where it lives

| Contribution | Declared in | Runs where | Host API surface |
|---|---|---|---|
| **Renderer** | tool YAML `renderer:` | Browser, main UI thread | `host.invokeAction`, `host.requestRender` |
| **Server actions** | tool YAML `actions:` | Gateway (confined worker) | the handler `ctx.host` |
| **Side panel** | `panels/<panel>.yaml` (auto-discovered) | Browser, main UI thread | opened via `host.ui.openPanel` |
| **Pack routes** | `pack.yaml` `routes:` | Gateway (confined worker) | called via `host.callRoute` |
| **Entrypoints** | `entrypoints/<ep>.yaml` (listed in `contents`) | Browser (launchers + deep-link routes) | `host.ui.navigate` / `openPanel` |
| **Pack store** | *implicit* — no declaration | Gateway | `host.store.{get,put,list}` (pack-namespaced) |

Plus the cross-cutting `host.session.*` (transcript reads, agent-driving posts, live events),
available to any surface that holds a `host`.

**Why this layout.** Several of these contributions are already **pack-scoped** at runtime:
a `panelId` is opened through the Host API by any surface in the pack, routes resolve through
a pack-level registry keyed by the server-derived `packId`, stores are namespaced by `packId`,
and entrypoints are launchers for the whole pack. Bolting them onto an arbitrary carrier tool
was unintuitive and blocked clean UI-only packs. The V1 schema makes the on-disk layout match
the actual runtime scope, which is also what lets a pack ship **no tools at all** (see the
[no-tools pack](#worked-example-a-no-tools-pack-pr-walkthrough) below).

The two halves talk through **one Host API**. The renderer→action flow: a renderer calls
`host.invokeAction(tool, action, args)`; the gateway authorizes the call (like a tool call),
runs the matching handler, and returns its JSON; the renderer paints the result into its
**own local state**. Every other capability routes through that same mediated, authorized
boundary — there is no raw escape hatch.

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

## Directory layout

A pack is a directory with a `pack.yaml` plus an entity payload. The full V1 layout:

```
<pack>/
  pack.yaml                       # table of contents + pack-level routes ref
  roles/<name>.yaml
  skills/<name>/SKILL.md

  tools/<group>/
    <tool>.yaml                   # tool definition + renderer/actions ONLY
    actions.mjs                   # optional, co-located tool action module
    ToolRenderer.js               # optional, co-located tool renderer

  panels/<panel>.yaml             # pack-scoped panel definitions, one file each (auto-discovered)
  entrypoints/<ep>.yaml           # pack-scoped launcher/deep-link definitions, one file each

  lib/                            # shared implementation modules, NOT entities
    SharedRenderer.js
    ArtifactViewerPanel.js
    routes.mjs
    helpers.mjs
```

The pack **root** is the directory holding `pack.yaml` (installed at
`<scope>/.bobbit/config/market-packs/<name>/`). A pack may ship `tools/` only, pack-scoped
surfaces only, or any mix — a pack with **no `tools/` dir at all** is fully supported.

### `pack.yaml`

`pack.yaml` is a table of contents of the **user-facing / configurable** things, plus the
pack-level `routes` reference. Panels are **not** listed (they are support surfaces,
auto-discovered from `panels/*.yaml`).

```yaml
name: artifacts
description: "Search tool + artifact viewer."
version: 1.0.0
contents:
  roles:       []
  tools:       [artifact_demo]          # tools/<group> dir names
  skills:      []
  entrypoints: [artifacts-deeplink]     # entrypoints/<name>.yaml basenames; toggleable
routes:                                 # optional top-level block
  module: lib/routes.mjs                # relative to pack.yaml; contained in pack root
  names:  [bundle, publish]             # export allowlist
```

Rules:

- **`contents.entrypoints: string[]`** — each entry is the **basename** (no extension) of an
  `entrypoints/<name>.yaml` file. This list is the activation catalogue the Market UI toggles
  and the registry keys by. An entrypoint file not listed here is not loaded. Default-enabled.
- **`contents.panels` does not exist** — panels are auto-discovered from `panels/*.yaml`. They
  are support surfaces, not activation points, so there is nothing to list or toggle.
- **`routes: { module?, names? }`** (optional, top-level) — when present, the pack contributes
  server routes from `module`, gated by the `names` allowlist. Absent ⇒ no routes.
- **`contents.mcp` is rejected** — MCP installs are out of scope.
- **No `stores` key** — stores are implicit (see [Stores](#stores--implicit-pack-scoped-persistence-hoststore)).
- **No `permissions` key** — there is no permission system; trusted pack server code has
  ambient OS access (see [Server-module confinement](#server-module-confinement)).

Unknown top-level keys are ignored (forward-compat).

### Path resolution rule

Every path-bearing field resolves **relative to the YAML file that declares it**, and the
resolved absolute path must stay **inside the pack root**:

| Declaration site | Field(s) | Resolves relative to |
|---|---|---|
| `tools/<group>/<tool>.yaml` | `renderer`, `actions.module` | the tool YAML's dir |
| `panels/<panel>.yaml` | `entry` | the panel YAML's dir (`panels/`) |
| `pack.yaml` | `routes.module` | the pack root |

A path *may* use `..` segments (e.g. a tool YAML pointing at `../../lib/SharedRenderer.js`, a
panel pointing at `../lib/Panel.js`) **as long as the resolved path stays within the pack
root**. Absolute paths, drive-absolute paths, and leading `/`/`\` are rejected at parse time;
anything that resolves outside the pack root is rejected (realpath + symlink aware) at serve /
import time. This is what makes shared `lib/` modules reachable from every declaring file
without weakening the containment invariant.

## Step 1 — the tool YAML (renderer + actions only)

A tool YAML carries **only** the tool-scoped contributions. A pack tool needs **no
`provider:`** — the renderer endpoint and the action dispatcher resolve the tool's on-disk
location independently of `provider:`.

```yaml
# tools/<group>/<tool>.yaml
name: sample_action
description: A demo tool with a Retry button wired to a server action handler.
group: Demo
renderer: SampleActionRenderer.js   # beside this YAML; or ../../lib/Shared.js
actions:
  module: actions.mjs               # default would be actions.js
  names: [retry]                    # endpoint allowlist (defense in depth)
```

- **`renderer:`** — path to the pre-built ESM renderer, resolved relative to the tool YAML's
  dir and contained in the pack root. For a pack tool it must end in `.js` to be recognized as
  a pack renderer. May point at a shared module (`../../lib/SharedRenderer.js`).
- **`actions.module:`** — path (same rules) to the actions module. Defaults to `actions.js`.
- **`actions.names:`** — optional allowlist. When present the endpoint rejects any `:action`
  not in the list **before loading the module**.

A tool YAML carries no other contribution keys. `panels`/`routes`/`entrypoints`/`stores` on a
tool YAML are not part of the schema and are ignored — they belong in `panels/`,
`entrypoints/`, `pack.yaml.routes`, or are implicit. (There is no migration warning: the
parser reads only `renderer` + `actions` and treats any old pack-scoped key as it would any
unrecognized key.)

`pack.yaml` lists the tool **group** under `contents.tools`:

```yaml
contents:
  roles: []
  tools: [demo]      # the tools/<group> dir name
  skills: []
```

## Step 2 — the renderer module

A pack renderer is a **pre-built ES module** — Bobbit does not compile pack UI, so ship the
`.js`, not a `.ts`. Its default export is a **factory** that receives a host toolkit and
returns a `ToolRenderer`.

### Why a factory + toolkit (not bare imports)

The factory is called with `{ html, nothing, renderHeader }` drawn from **the app's own `lit`
instance**. Pack renderers must **never** bare-import `lit`: a second `lit` instance breaks
reactive directives, and content-hashed chunk names make import-map mapping fragile. Take
everything you need from the toolkit argument.

### The renderer contract

The factory returns an object with a single `render(params, result, isStreaming, ctx)` method
returning:

```ts
{ content: TemplateResult, isCustom: boolean }
```

- `content` — a `lit` template built with the toolkit's `html`.
- `isCustom` — `false` wraps your output in the standard tool card; `true` opts out.

The render context `ctx` carries `toolUseId`, `sessionId`, and `ctx.host` (the Host API,
bound to this render's session + tool-use id).

### Worked example

```js
// tools/demo/SampleActionRenderer.js
export default function createRenderer({ html, nothing, renderHeader }) {
  // toolUseId → latest handler result. Module-level so it survives re-mounts /
  // transcript re-renders WITHOUT mutating the transcript.
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
        ctx?.host?.requestRender?.();   // repaint so render() runs again
      };

      return {
        isCustom: false,
        content: html`
          <div class="flex items-center justify-between gap-2" data-testid="pack-renderer-root">
            <span class="text-sm text-muted-foreground">Sample action</span>
            ${shown ? html`<span data-testid="pack-result">${shown.message}</span>` : nothing}
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

### Renderer rules (enforced / reviewed)

- **No auto-invoke on render.** `host.invokeAction` may only be called from a **user gesture**
  (the click handler). A renderer that fires an action during `render()` is rejected.
- **Renderer-local result, no transcript mutation.** An action result flows back **only** as
  the `invokeAction` promise. Store it in local state and repaint; action handlers do not
  rewrite the transcript or the persisted tool result.
- **Repaint via `requestRender()`** after a result resolves, or mount your own `LitElement`
  and use native reactivity.
- **Theme tokens only.** Use Bobbit's CSS custom properties / utility classes; never hardcode
  colors.
- **Card contract.** Set `isCustom` deliberately.

The client registers your renderer lazily (placeholder on first paint, load-failure fallback
if the module fails), re-driven from `/api/tools` metadata on every cold load — so your
renderer **survives a page reload** with no install-time state, and an **uninstall** restores
the displaced built-in live.

## Step 3 — the server actions module

The actions module exports `const actions`, a map of action name → handler. It is imported by
the **gateway under plain Node**, so it must be ESM-loadable.

### Ship it as `.mjs`

A bare `.js` file containing `export` loads as **CommonJS** under Node and throws. Name the
module **`actions.mjs`** and point `actions.module` at it. (The renderer stays `.js` because
the browser always imports it as ESM.)

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

`ctx` is **verified by the endpoint** — `sessionId` and `toolUseId` have already passed the
guard. `args` is **untrusted, LLM-influenced JSON** — validate / whitelist it; never `eval`,
`exec`, `require`, or build filesystem/session paths from it.

```js
// tools/demo/actions.mjs
export const actions = {
  retry: async (_ctx, _args) => ({ message: "retried", at: Date.now() }),
};
```

The returned object is JSON-serialized back to the renderer as the `invokeAction` result.

### What `ctx.host` exposes (and what it deliberately does NOT)

There is **no `host.gateway.fetch`** and no other raw passthrough. The v1 contract removes the
escape hatch on purpose: Bobbit *serves* a typed contract rather than handing extensions a
window into internals. The only sanctioned pack→server path is the action endpoint itself.

The server-side `ctx.host` carries:

- `ctx.host.version` / `ctx.host.contractVersion` — the frozen contract revisions.
- `ctx.host.capabilities` — the **single source of truth** for what is implemented.
- `ctx.host.store.{get,put,list}` — pack-namespaced persistence, scoped to the
  **server-derived** `packId` (you never pass an id).
- `ctx.host.session.{readTranscript,readToolCall}` — own-session reads through the adapter.

There is deliberately **no** `ctx.host.callRoute` or `ctx.host.ui` server-side: a server
handler reaches its own pack's route by calling the function directly, and a server module has
no UI to drive. **Feature-detect with `ctx.host.capabilities.<name>`, never member presence.**

A handler may use raw `fs` / `child_process` / network directly — server modules are trusted
code with full ambient parity (see [Server-module confinement](#server-module-confinement)).

A renderer/panel reaching dynamic server data uses the client-side, pack-scoped, typed
`host.callRoute(name, init)` — it reaches **only** the calling pack's OWN routes. See the
[routes section](#routes--the-packs-own-server-endpoints-hostcallroute).

### Blast-radius controls you get for free

Handlers run in a **confined `worker_threads` worker** (see below), not the gateway process.
The dispatcher bounds blast radius: a **per-call timeout** (default 30s) spanning module
load+eval *and* execution (worker `terminate()`d on timeout, caller gets 504); a **global
concurrency cap** (default 8 in-flight); a **per-session rate limit**; **error isolation** (a
throw or crash becomes a 500, never a process crash); and **audit logging**.

### Server-module confinement

Pack server modules (`actions.mjs` / `routes.mjs`) are **trusted code — the same tier as a
tool or MCP server you installed** — and run with **full ambient parity**: normal `node:`
built-ins (`fs`/`child_process`/`net`/`http`…), normal network globals (`fetch`/`WebSocket`),
and the normal `process` with full env. There is **no `permissions` key and no capability
concept** — you `import("node:child_process")` / `node:fs` and call `fetch` exactly as a tool
would.

Every handler runs in a **confined worker**, but purely for **resource + crash isolation**:
terminated on timeout (the CPU control), bounded by memory caps, and any child process it
spawns is SIGKILLed on terminate. Separately, the module graph's `import`/`require` resolution
is **confined to the pack root** — so a handler may `import("../lib/helper.mjs")` (a sibling
of `tools/`), but an import that resolves outside the pack root is rejected. That containment
is import hygiene / loader stability, **not** an OS-level security boundary (it is near-cosmetic now
that `fs` is ambient).

> **Confinement root = pack root.** Earlier the import-containment root was the tool's group
> dir; under V1 it is the whole pack root, which is exactly what makes shared `lib/` modules
> importable from a pack's `actions.mjs` / `routes.mjs`.

The worker's **`process.cwd()` returns the session working dir** (the server-derived session
worktree) — a tool-parity convenience. Build spawn options / paths from `process.cwd()`:

```js
import { spawn } from "node:child_process";   // ambient — no declaration needed
import { join } from "node:path";
export const actions = {
  log: async (ctx) => new Promise((resolve, reject) => {
    const c = spawn("git", ["log", "-1", "--format=%H"], { cwd: process.cwd() });
    let out = ""; c.stdout.on("data", (d) => out += d);
    c.on("error", reject); c.on("close", () => resolve(out.trim()));
  }),
};
```

The only `ctx.host` capability is still the mediated Host-API proxy (the single ENFORCED
cross-pack / cross-session / UI-driving boundary).

## Step 4 — the client→server call (Host API recap)

```js
const result = await ctx.host.invokeAction("sample_action", "retry", { /* args */ });
```

- `sessionId` and `toolUseId` are **not** parameters — they come from the bound render context
  and are supplied to the endpoint internally. Keep `args` free of identity fields.
- This POSTs `/api/tools/sample_action/actions/retry` with `{ sessionId, toolUseId, args }`.
  The endpoint authorizes the call **like a tool call**: it requires `x-bobbit-session-id`,
  `body.sessionId === header`, `:tool` in `allowedTools`, `:action` in `actions.names` (when
  declared), and a `toolUseId` that exists in the header-bound session and was a call of
  `:tool`. Because the LLM can `curl` this endpoint with the admin token, *this* guard is the
  real gate.

`invokeAction` is the **only** action pack→server path — there is no lower-level raw-fetch
seam. The endpoint is built same-origin inside the client Host API
([`src/app/host-api.ts`](../src/app/host-api.ts)), so there is no caller-supplied URL or
`Authorization` header anywhere in the flow.

### Feature-detection and the durable forward path

Check capabilities via `host.capabilities`, never member presence:

```js
if (host.capabilities.invokeAction) { /* always true on a v1 host */ }
if (host.capabilities.has("callRoute")) { /* true on a current host */ }
```

A current host reports all client flags `true` — `{ invokeAction, requestRender, callRoute,
session, ui, store }`. `host.version` (`HOST_API_VERSION`, `1`) and `host.contractVersion`
(`HOST_CONTRACT_VERSION`) identify the contract revision. All capabilities are purely additive
(no signature churn), so code written against `capabilities` stays forward/backward-compatible.

## Step 5 — install, test, iterate

1. Register the source, then **Install** the pack into a scope (see [docs/marketplace.md](marketplace.md)).
2. `/api/tools` now lists your tool with `rendererKind: "pack"` (and `hasActions: true`).
   `/api/ext/contributions` lists your pack's panels/entrypoints/routes.
3. Open a session whose transcript contains a call of your tool → it renders with your pack
   renderer (placeholder → real renderer).
4. Click the action button → the handler runs → your renderer paints the result.
5. **Reload** → the renderer + panels + entrypoints still load (registration is re-driven from
   metadata).
6. **Update** the pack → caches invalidate synchronously; the next call uses the new code.
7. **Uninstall** → the renderer, panels, entrypoints, and actions disappear live; any
   displaced built-in is restored.

## Pack-scoped surfaces: panels, routes, entrypoints, stores, session

Everything below is reached through the **same** Host API your renderer holds (`ctx.host`, or
the `host` argument a panel/entrypoint is handed) and authorized through the **same**
per-session guard — there is still no raw escape hatch.

### How pack identity is bound (you never supply it)

The scoped capabilities (`host.store.*`, `host.callRoute`, `host.session.*`) all act **as a
specific pack** — store keys are namespaced by `packId`, `callRoute` reaches only your pack's
own routes, session reads are own-session. That identity must not be forgeable, so it is
**server-derived, never caller-supplied**:

- When the trusted app constructs a surface's Host API it asks the server to mint a
  **surface-binding token** (`POST /api/ext/surface-token`). For a **renderer/action** it
  passes `{ sessionId, tool }`; for a **panel/entrypoint/route** it passes
  `{ sessionId, contributionKind, contributionId, packId }`. The server resolves the winning
  contribution and returns an opaque, HMAC-signed token bound to
  `{sessionId, packId, contributionId, tool?}`.
- The token is held in the Host API **closure** — **your pack code never sees it, sets it, or
  sends it.** It is echoed automatically on every scoped call; the server re-validates it and
  derives `{packId, tool?}` from it, ignoring anything a caller tries to send.

**The trust boundary differs for tool-bound vs pack-bound surfaces.** A tool-bound surface
(renderer/action) is gated by `:tool ∈ allowedTools` (plus `toolUseId` ownership for actions).
A **pack-bound surface has no carrier tool**, so its gate is **pack installed + active in the
session's scope + caller's own session** — `allowedTools` no longer narrows which pack a
session may reach. This is exactly what enables **orphan / UI-only packs**: a launcher can open
a panel and obtain a pack-scoped Host API without inventing a dummy tool. It grants no
capability a tool-bound surface did not already have (store is `packId`-namespaced, `callRoute`
reaches only your own routes, session reads are own-session, session writes keep the
user-gesture + one-time permit gate).

**Practical consequence for you:** you just call `host.store.get(...)` /
`host.callRoute(...)` / `host.session.readToolCall(...)`. You never pass a pack id, a `tool`
name, or a token. (A same-realm malicious pack could still forge its own token — the
documented Model-A residual; see [marketplace.md](marketplace.md). The token closes the
*accidental* cross-pack path.)

### Stores — implicit, pack-scoped persistence (`host.store.*`)

There is **no `stores` declaration** — a store is created on first `host.store.put`, and its
namespace is the server-derived `packId`. Read/write it from any surface that holds a `host`:

```js
await host.store.put(artifactId, { type: "html", html });   // value is JSON-serialized
const payload = await host.store.get(artifactId);            // null if absent
const keys = await host.store.list("draft-");                // optional prefix filter
```

- **Backend:** one JSON file per key under `<state>/ext-store/<packId>/<encodedKey>.json`. Keys
  are percent-encoded and the resolved path is re-validated to stay inside the `packId` dir.
- **Cross-pack reads are rejected by construction** — the `packId` comes from the surface
  token, never the request.
- **Non-pack callers are rejected.** A deep-link carries only ids; the payload lives in the
  store, so a panel reopened from a URL rehydrates by `store.get(id)` and survives reload.

### Panels — persistent side panels (`host.ui.openPanel`)

A panel is a **pre-built ESM module** (same Blob-URL + factory-toolkit delivery as a renderer)
that mounts as a side-panel tab. Declare it in its own file under `panels/`. Panels are
**auto-discovered** — they are not listed in `contents` and are not individually toggleable.

```yaml
# panels/artifacts-viewer.yaml
id: artifacts.viewer            # unique WITHIN the owning pack (dotted ids allowed)
title: Artifact                 # optional tab label
entry: ../lib/ArtifactViewerPanel.js   # relative to THIS file; contained in pack root
```

```js
// From a renderer's click handler:
host.ui.openPanel({ panelId: "artifacts.viewer", params: { artifactId } });
```

The panel module's factory is handed the host toolkit **plus a `host`** bound to the active
session and the panel's pack (`toolUseId` is `undefined` — a panel originates no tool call).
So a panel can call `host.store.*`, `host.callRoute`, and `host.session.*` — everything a
renderer can except `invokeAction` (which is tool-call-scoped).

**Addressing.** Panel ids are only **pack-unique**, so the client keys its registry and the
serving URL by `{packId, panelId}`. The bytes are served bearer-only (static-asset-equivalent)
by the **pack-addressed** `GET /api/ext/packs/:packId/panels/:panelId`. The client reconciles
panels from `GET /api/ext/contributions` (pack-scoped), not `/api/tools`.
`host.ui.openPanel({ panelId })` stays **pack-relative** — the caller surface's bound `packId`
resolves `panelId` → `{packId, panelId}` before fetching bytes.

**Panel conventions (enforced — identical to renderer rules):** theme tokens only; preserve any
embedded iframe `sandbox` attribute (untrusted/LLM content goes in a `sandbox`ed iframe);
**no auto-invoke / navigation on mount**.

### Routes — the pack's own server endpoints (`host.callRoute`)

When a surface needs **dynamic server data**, the pack ships a route module and the surface
calls it by name. Routes are **pack-level** — declared once on `pack.yaml`, not on a tool:

```yaml
# pack.yaml
routes:
  module: lib/routes.mjs    # .mjs so Node loads it as ESM (like actions); contained in pack root
  names: [bundle, publish]  # the route names this module exports (allowlist)
```

```js
// lib/routes.mjs — a map of route name → handler, mirroring actions.mjs
export const routes = {
  // ctx is verified server-side {host, sessionId, toolUseId?, tool?}; req carries the HostRouteInit
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

- **Namespace by construction.** The client sends only the surface token; the server derives
  your `packId` from it and resolves the route **module** through a **pack-level
  `RouteRegistry`** keyed by `packId`. So a panel opened from anywhere in the pack reaches the
  pack's routes — opener-independent. There is no `<pack>` URL segment to forge, and the
  endpoint (`POST /api/ext/route/:name`) takes only the route `name`.
- **One route name per pack** (duplicate names are a hard rejection at registry build).
  Cross-pack names never collide (the registry is keyed by `packId`).
- **Route handlers run in the confined worker** — trusted code with full ambient parity, so a
  route may use `git`/`fs`/network directly.

#### Using ambient OS access inside a route

A route (or action) handler may use ambient OS surfaces directly. Example: the PR-walkthrough
`bundle` route recomputes a real `git diff` live —

```js
// lib/routes.mjs — child_process is ambient, no declaration needed
import { spawn } from "node:child_process";
export const routes = {
  bundle: async (ctx, req) => {
    // process.cwd() is the session working dir; git resolves via PATH.
    const diff = await new Promise((resolve, reject) => {
      const c = spawn("git", ["diff", req.query.baseSha, req.query.headSha], { cwd: process.cwd() });
      let out = ""; c.stdout.on("data", (d) => (out += d));
      c.on("error", reject); c.on("close", () => resolve(out));
    });
    return { diff };
  },
};
```

The worker terminates the handler on timeout and SIGKILLs any spawned child, but those are
**stability** guarantees, not a security boundary against your own code. See the
[no-tools pack case study](#worked-example-a-no-tools-pack-pr-walkthrough).

### Entrypoints — non-chat launchers + deep-link routes (`host.ui.navigate`)

Entrypoints put your pack on surfaces outside the chat transcript and register deep-linkable
SPA routes. Each entrypoint is its own file under `entrypoints/`, and its **basename must be
listed in `pack.yaml`'s `contents.entrypoints`** (the activation catalogue — an unlisted file
is not loaded).

**Launcher kind** (a click is the user gesture; it opens a panel or navigates a route):

```yaml
# entrypoints/pr-walkthrough-open.yaml
id: pr-walkthrough.open
kind: composer-slash          # composer-slash | git-widget-button | command-palette
label: PR Walkthrough         # required for launcher kinds
target:
  route: pr-walkthrough       # OR { panelId: ... }
  params:
    jobId: job-litmus-1
```

**`kind:"route"`** (a deep-linkable route — NO clickable surface; maps a host-global `routeId`
→ panel + URL params):

```yaml
# entrypoints/artifacts-deeplink.yaml
id: artifacts.deeplink        # unique within the owning pack
kind: route
routeId: artifacts            # host-global deep-link route id; duplicate = hard conflict
target:
  panelId: artifacts.viewer   # resolved within the same pack
paramKeys: [artifactId]       # the only params serialized into / parsed from the URL
```

```js
// A launcher's click handler (or your own panel button):
host.ui.navigate({ route: "pr-walkthrough", params: { jobId } });
```

- **Launcher kinds** register a label that, on click, calls `openPanel` or `navigate`. The
  click **is** the user gesture — never auto-invoke on mount.
- **`kind:"route"`** registers a deep-link in the client pack-route registry.
  `navigate({ route, params })` looks it up, filters `params` to the declared `paramKeys`, and
  serializes `#/ext/<routeId>?<params>` through the router — **you never build a URL string**.
  On load, that hash is parsed back, the panel reopened, and it rehydrates from `host.store.*`.
- **Ids and conflicts.** Entrypoint `id` is **pack-local**; `routeId` is **host-global** (two
  packs declaring the same `routeId` is a hard rejection at registry build). Panel ids referenced
  by `target.panelId` are pack-local.

### `host.session.*` — transcript reads, posts, and live events

Reads are **own-session-scoped**; writes require a **genuine user gesture + a server-minted
permit**.

```js
// READS (own session, mapped through the internal→contract adapter):
const env = await host.session.readTranscript({ offset: 0, limit: 50, pattern: "error" });
//   → { total, returned, messages: HostMessage[] }   (`pattern` is a literal substring)
const call = await host.session.readToolCall(toolUseId);
//   → ToolCallRecord | null

// LIVE EVENTS (typed; returns an unsubscribe fn):
const off = host.session.subscribe("tool_result", ({ record }) => { /* … */ });

// WRITE — drives the agent. MUST be called from a real user gesture:
await host.session.postMessage({ role: "user", text: "re-run the tests", resumeTurn: true });
```

- **Reads** return Host-API-owned contract shapes (`HostMessage`, `ToolCallRecord`, …) from
  the internal→contract adapter — never Bobbit's internal wire.
- **`postMessage` is the highest-risk capability.** Call it **only from a real user gesture**:
  it reads `navigator.userActivation` synchronously and **throws** on mount. It rides the app's
  authenticated session WebSocket (pack code has no handle) and carries a one-time,
  content-bound, server-minted permit — captured/replayed/forged/tampered frames are rejected.
- **Cross-session posting is impossible** — the target is the WS connection's own session.

## Activation controls (Market UI)

On the Market installed-pack surface you can toggle a pack's **user-facing entities** per
scope/project: **roles, tools, skills, and entrypoints**. Support surfaces — panels, routes,
stores, renderers, actions, `lib/` — are **not** independently toggleable.

What disabling does:

- **Disable a tool / role / skill** — it is removed from its resolved list; a lower-priority
  shadowed entity of the same name may reappear.
- **Disable an entrypoint** — its launcher + deep-link registration is removed (omitted from
  `/api/ext/contributions`). **A panel the entrypoint targets stays available** to any enabled
  tool/entrypoint that opens it — panels are not toggled by disabling an entrypoint.

Toggles persist via `pack_activation` (per scope/project), keyed by pack name + entity kind +
name; entrypoints are keyed by their `contents.entrypoints` basename (`listName`), so one
toggle disables both the launcher id and the deep-link `routeId` from that file. The toggle UI
reads an **unfiltered catalogue** straight from the installed pack's manifest (so a disabled
entity stays visible and re-enableable across reloads), while the runtime registries stay
filtered. See [marketplace.md](marketplace.md#activation-controls) for the endpoints and the
catalogue/runtime split.

## Bundling npm dependencies into a pack (vendoring)

A renderer/panel module is loaded by the client via a **Blob-URL `import()`** and handed the
host toolkit (`{ html, nothing, renderHeader }`) as a FACTORY parameter — it must NOT
bare-import `lit`. But it CAN use other npm libraries as long as they are **bundled into the
served module** ahead of time. "Bundling" is an author-side BUILD convention:

```
market-packs/<pack>/src/*.ts        ← SOURCE: imports npm deps freely (never `lit`)
        │  esbuild (scripts/build-market-packs.mjs)
        ▼
market-packs/<pack>/lib/<entry>.js  ← BUILT: self-contained ESM, committed (panels/shared)
market-packs/<pack>/tools/<group>/<entry>.js   ← BUILT: tool-local renderer
```

Run `npm run build:packs` (wired into `npm run build`). The build emits **tool renderers
tool-local** and **panels / shared bundles to `lib/`**. The marketplace ships the **built**
assets, so commit the bundles.

Two hard rules keep a bundle loadable by the Blob-URL loader:

1. **Never bundle `lit`** — it is injected. `lit`/`lit/*` are `external`; pack source must not
   import them.
2. **One self-contained file per entry — NO code splitting / dynamic chunks.** A Blob-URL
   module has no resolvable base for `import("./chunk.js")`, so every dep is inlined eagerly.

**Web Workers (the pdfjs wrinkle).** A library that spins up a Web Worker can't resolve a
sibling worker file from a `blob:` URL. Pre-bundle the worker SOURCE to a string and create a
Blob-URL `workerSrc` at runtime — see `market-packs/artifacts/src/binary-render.ts` + the
`virtual:pdf-worker` plugin in `scripts/build-market-packs.mjs`.

**Node-safety for unit tests.** Keep pure logic in a node-safe `helpers.ts`; libraries that
touch DOM globals at module-eval belong in a browser-only module asserted in the browser E2E.

## Worked example: a renderer + panel pack (artifacts)

`market-packs/artifacts/` is the built-in artifact viewer re-expressed as a pack at full
behavioral parity. Its layout shows where each contribution lives:

```
artifacts/
  pack.yaml                              # contents.tools: [artifact_demo], contents.entrypoints: [artifacts-deeplink]
  tools/artifact_demo/
    artifact_demo.yaml                   # renderer: ArtifactRenderer.js  (tool-scoped only)
    ArtifactRenderer.js                  # built inline-pill renderer
  panels/artifacts-viewer.yaml           # id: artifacts.viewer, entry: ../lib/ArtifactViewerPanel.js
  entrypoints/artifacts-deeplink.yaml    # kind: route, routeId: artifacts, target.panelId: artifacts.viewer
  lib/ArtifactViewerPanel.js             # built viewer panel (shared)
```

| Built-in piece | Pack contribution |
|---|---|
| Inline artifact pill | tool `renderer:` (`ArtifactRenderer.js`, an `isCustom` full-surface pill) |
| Viewer surface | `panels/artifacts-viewer.yaml` (`artifacts.viewer` → `../lib/ArtifactViewerPanel.js`), opened via `host.ui.openPanel({ panelId, params: { artifactId } })` |
| `persistPreviewArtifact` / `restorePreviewArtifact` | **implicit store** → `host.store.put/get(artifactId)`, pack-namespaced |
| Reopen a viewer by id / deep-link parity | `entrypoints/artifacts-deeplink.yaml` (`kind:"route"`, `routeId:"artifacts"`, `paramKeys:["artifactId"]`) + `host.ui.navigate({ route:"artifacts", params:{ artifactId } })` |

The canonical chain: `renderer` persists to the implicit `store` → `openPanel` rehydrates from
`store` → `navigate` serializes a deep-link route → reload re-parses the hash → reopens the
panel rehydrated from `store.get`. Real parity needs real libraries, so `highlight.js`,
`pdfjs-dist`, and `docx-preview` are **vendored** (see *Bundling* above), and HTML artifacts
render inside a `sandbox="allow-scripts"` iframe. Tests:
`tests/artifacts-pack-viewer.test.ts` (node) + `tests/e2e/ui/artifacts-pack.spec.ts` (browser).

## Worked example: a no-tools pack (pr-walkthrough)

`market-packs/pr-walkthrough/` is the maximal example — the PR-walkthrough feature re-expressed
as a pack with **no `tools/` dir at all**. It proves an **orphan / UI-only** pack can build a
full surface from pack-scoped contributions + the Host API alone, through pack-bound surface
auth, with **no tool in `allowedTools`**. It is no longer a test-only litmus: it now **ships as a
built-in first-party pack** and is the sole provider of the viewer — its old built-in code is
deleted (see [First-party packs dogfood the Host API](#first-party-packs-dogfood-the-host-api)
below and [docs/marketplace.md](marketplace.md#built-in-first-party-packs)).

```
pr-walkthrough/
  pack.yaml                              # contents.tools: []  +  contents.entrypoints: [4 files]  +  routes: { module: lib/routes.mjs, names: [bundle, publish] }
  panels/pr-walkthrough-panel.yaml       # id: pr-walkthrough.panel, entry: ../lib/panel.js
  entrypoints/
    pr-walkthrough-open.yaml             # composer-slash launcher
    pr-walkthrough-git-widget.yaml       # git-widget-button launcher
    pr-walkthrough-palette.yaml          # command-palette launcher
    pr-walkthrough-route.yaml            # kind: route, routeId: pr-walkthrough
  lib/
    panel.js                             # built viewer panel
    routes.mjs                           # hand-authored pack-level routes (bundle, publish)
```

| Built-in piece | Pack contribution |
|---|---|
| `PrWalkthroughPanel` viewer | `panels/pr-walkthrough-panel.yaml` (`pr-walkthrough.panel` → `../lib/panel.js`), opened via `host.ui.openPanel({ panelId })` — entrypoints carry **no** hard-coded `jobId`; the panel derives the real job + base/head SHAs from the **current session's** submitted YAML |
| `handlePrWalkthroughApiRoute` endpoints | `pack.yaml` `routes:` (`lib/routes.mjs`, names `bundle`/`publish`), reached via `host.callRoute("bundle", …)` (the route resolves the session's own job; the caller does not pass a `jobId`) — **never** a raw fetch |
| `walkthrough-store.ts` state | **implicit store** → `host.store.*`, pack-scoped |
| Deep-link + launchers | four `entrypoints/*.yaml` — three launchers (composer-slash, git-widget-button, command-palette) **and** a `kind:"route"` deep-link (`routeId:"pr-walkthrough"`) |
| Bespoke transcript access | `host.session.readToolCall(toolUseId)` (own-session, via the adapter) |
| Live `git diff` recompute | ambient `child_process`/`fs` → the `bundle` route runs **real `git`** live in the confined worker (`process.cwd()` = session worktree) |

Two non-obvious decisions worth copying:

1. **Pack-bound surfaces need no carrier tool.** The panel and launchers obtain a pack-scoped
   Host API through a pack-bound surface token (`{ contributionKind, contributionId, packId }`),
   authorized on *installed + active + own-session*. There is no dummy tool in `allowedTools` —
   that is the whole point of the no-tools pack.
2. **Pack-level route resolution is opener-independent.** The panel calls
   `host.callRoute("bundle", …)`; the server resolves the route **module** through the
   pack-level `RouteRegistry` (keyed by `packId`), so the panel-originated call reliably reaches
   the pack's routes without the route and opener sharing a tool. (The agent still produces the
   walkthrough **YAML** via `submit_pr_walkthrough_yaml`; the YAML→cards synthesis was extracted to
   the shared module `src/shared/pr-walkthrough/yaml-to-cards.ts` and **bundled into the pack's
   `publish` route**, so the pack maps the agent's YAML to review cards itself.
   See `docs/design/pr-walkthrough-pack-deletion.md`.)

Tests: `tests/e2e/ui/pr-walkthrough-pack.spec.ts` (no install — resolved by the built-in band →
launcher → panel renders from `callRoute` + store → `readToolCall` → deep-link → disable/re-enable).

## First-party packs dogfood the Host API

The Extension Host is not just for third-party packs: **Bobbit ships some of its own features as
packs**, resolved through the exact same `PackResolver` + Host API + activation system. The first
such feature is **`pr-walkthrough`**, which is now delivered *solely* as a built-in first-party
pack — its bespoke built-in viewer, viewer-feed routes, and UI launch wiring have been **deleted**,
so the pack is the only provider. (See [docs/marketplace.md](marketplace.md#built-in-first-party-packs)
for how built-in packs are shipped, resolved in place, and disabled.)

Why do this? It makes the pack contract **load-bearing for production code**, not just for tests —
if the Host API can't express a real shipped feature, the gap shows up in the app, not in a litmus.
Two pieces of the migration are worth understanding when authoring your own ambitious pack:

- **Launch re-expression — drive the current agent, don't mint a new principal.** The deleted
  built-in git-widget button launched a *new dedicated child walkthrough agent* (a fresh session
  with its own `allowedTools`). Spawning a new principal is **not pack-expressible by design** — a
  pack acts within the calling session's authority. So the pack re-expresses launch differently:
  the entrypoints just open the panel (`host.ui.navigate` to `#/ext/pr-walkthrough`), and the panel
  offers a gesture-gated **"Run PR walkthrough"** button that calls `host.session.postMessage` to
  direct the **current** session's agent to run the walkthrough using the retained agent tools
  (`readonly_bash` / `read_pr_walkthrough_bundle` / `submit_pr_walkthrough_yaml`). The agent emits
  its YAML; the panel reads that tool call (`host.session.readToolCall`) → `host.callRoute("publish")`
  → renders. This preserves the "click → walkthrough happens" UX without any privilege-minting
  escape hatch. The panel implements a small state machine (`no-submission` → `posting` → `waiting`
  → `publishing` → `rendered`, with timeout/refusal/missing-tool error states) so the launch flow is
  resilient, not just the happy path — see `market-packs/pr-walkthrough/src/panel.js`.
- **Shared synthesis, one source of truth, bundled into the pack.** The viewer must turn the
  submitted production YAML into the same cards the deleted built-in produced. That synthesis
  (`validatePrWalkthroughYaml` + `mapYamlToWalkthroughPayload` + `DiffReferenceMapper` + helpers)
  was extracted to a **pure shared module** `src/shared/pr-walkthrough/yaml-to-cards.ts` (no `node:`
  / server deps), re-exported so the agent side keeps working unchanged, and **bundled into the
  pack** by `npm run build:packs` → `market-packs/pr-walkthrough/lib/yaml-to-cards.mjs`. The pack's
  `publish` route runs that same code in the confined worker — so there is exactly one
  implementation of the synthesis, used by both the agent path and the pack viewer, with no
  duplicated logic to drift.

What stays agent-tool-side is the explicit carve-out: the `submit_pr_walkthrough_yaml` /
`read_pr_walkthrough_bundle` / `readonly_bash` tools, `WalkthroughAgentManager` and its
`/launch` + `/resolve` + `/export/*` lifecycle, and GitHub network/auth. Those are genuine *agent*
capabilities (model-backed synthesis, credentialed network), not contribution surfaces. Only the
viewer / route / store / deep-link / user-facing launch-gesture surfaces moved to the pack. Full
keep-vs-delete detail is in [docs/design/pr-walkthrough-pack-deletion.md](design/pr-walkthrough-pack-deletion.md)
and [docs/design/built-in-first-party-packs.md §8](design/built-in-first-party-packs.md).

## Security checklist

The Host API is the single security boundary. As an author, your obligations are:

- [ ] **Never auto-invoke an action on render** — only from a user gesture.
- [ ] **Validate / whitelist `args`** in every handler; never `eval`/`exec`/`require` it or derive paths from it.
- [ ] **Declare `actions.names`** so unknown actions are rejected before the module loads.
- [ ] **Keep `args` identity-free** — `sessionId`/`toolUseId` come from the verified context.
- [ ] **Don't bare-import `lit`** in a renderer or panel — use the factory toolkit.
- [ ] **Use theme tokens**, preserve any iframe `sandbox` attributes, never mutate the transcript from a renderer.
- [ ] **Go through the Host API** for every pack→server call — `host.invokeAction`, `host.callRoute`, `host.store.*`, `host.session.*`. There is no raw fetch by design.
- [ ] **Never build a URL or hash string** — `host.ui.openPanel` / `host.ui.navigate` take structured `{ panelId | route, params }` targets.
- [ ] **No post / navigate / action on mount** — panels and entrypoints act only from a real user gesture; `host.session.postMessage` is gesture-gated and throws on mount.
- [ ] **Never supply a pack id, `tool`, or token to a scoped call** — pack identity is server-derived from the surface-binding token held in the Host API closure.
- [ ] **Keep paths inside the pack root** — `renderer`, `actions.module`, panel `entry`, and `routes.module` resolve relative to their declaring file; `../lib/...` is fine, escaping the pack root is rejected.
- [ ] **Server modules are trusted code with full ambient parity** — `child_process`/`fs`/network/`process.env` are available directly (no declaration). The worker is resource/crash isolation only; design handlers to be fast.
- [ ] **Feature-detect via `host.capabilities`**, never member presence.

The deeper model — the allowlist-bypass fix, `toolUseId` ownership verification, the
`authorizeScopedRequest` vs `authorizeActionRequest` split, the tool-or-pack surface binding,
the contract adapter, and the worker isolation model — is documented in
[docs/design/extension-host.md](design/extension-host.md),
[docs/design/pack-schema-v1-rationalisation.md](design/pack-schema-v1-rationalisation.md), and
[docs/marketplace.md](marketplace.md) (threat model).

## Reference

- **Authoritative V1 schema:** `docs/design/pack-schema-v1-rationalisation.md`
- Renderer+action example pack: `tests/fixtures/market-sources/retry-demo-src/retry-demo/`
- Litmus packs: `market-packs/artifacts/` (tool + panel + deep-link), `market-packs/pr-walkthrough/` (no-tools / UI-only)
- Browser E2Es: `tests/e2e/ui/extension-host.spec.ts`, `artifacts-pack.spec.ts`, `pr-walkthrough-pack.spec.ts`
- Frozen Host API types: `src/shared/extension-host/host-api.ts`
- Action / route dispatch + handler ctx: `src/server/extension-host/action-dispatcher.ts`, `route-dispatcher.ts`
- Server-side Host API (`ctx.host`): `src/server/extension-host/server-host-api.ts`
- Pack identity + scoped authz: `src/server/extension-host/pack-identity.ts`, `action-guard.ts`, `surface-binding.ts`, `path-guard.ts`
- Pack-scoped contribution loaders + registry: `src/server/agent/pack-contributions.ts`, `src/server/extension-host/pack-contribution-registry.ts`
- Tool-scoped contribution parser: `src/server/agent/tool-contributions.ts`
- Internal→contract adapter: `src/server/extension-host/contract-adapter.ts`
- Pack store + worker isolation: `pack-store.ts`, `module-host-worker.ts`, `module-host-bootstrap.ts`, `confinement-loader.ts`
- Activation persistence: `src/server/agent/project-config-store.ts` (`pack_activation`)
- Client registries: `src/app/pack-renderers.ts`, `pack-panels.ts`, `pack-entrypoints.ts`, `host-api.ts`
- Renderer render-context type: `src/ui/tools/types.ts`
