# Authoring guide: ship a tool renderer + server actions in a pack

This guide walks through making a **marketplace pack** whose tool ships a custom chat-block **renderer** and an interactive **server action handler** — the Extension Host Phase-1 contributions. By the end you will have re-created the litmus sample: a tool that renders a **Retry** button which, on click, calls a gateway handler and shows the result, with no privileged escape hatch.

**Read first:**

- [docs/marketplace.md](marketplace.md) — packs, sources, scopes/precedence, install/uninstall. This guide assumes you can already author and install a pack.
- [docs/design/extension-host.md](design/extension-host.md) — the authoritative design: the contribution-point model, two-host architecture, the frozen Host API, the security guard sequence, and the Phase-2 roadmap. This guide is the practical how-to; that doc is the *why* and the contract.

The complete working example used throughout lives at `tests/fixtures/market-sources/retry-demo-src/retry-demo/` and is exercised by the extension-host browser E2E.

## Big picture: what you are contributing, and where it runs

A tool pack can contribute two things beyond the tool itself, each declared as a key in the tool's YAML:

| Contribution | YAML key | Runs where | Imported by |
|---|---|---|---|
| **Renderer** | `renderer:` | Browser, main UI thread | The client, via a Blob-URL dynamic `import()` |
| **Server actions** | `actions:` | The long-lived gateway process | The gateway, via dynamic `import()` |

The two halves talk through **one Host API**. A renderer calls `host.invokeAction(tool, action, args)`; the gateway authorizes the call (like a tool call), runs the matching handler, and returns its JSON; the renderer paints the result into its **own local state**. There is no other channel — that single, mediated API is also the security boundary.

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

> **Phase-2 keys are reserved, not rejected.** You may also include `panels:`, `entrypoints:`, `routes:`, or `stores:` (each must be an array). A Phase-1 server validates their shape, retains them verbatim, and ignores them — so a pack authored against the full future shape installs cleanly today.

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

In Phase 1 the server-side `ctx.host` therefore carries only:

- `ctx.host.version` / `ctx.host.contractVersion` — the frozen contract revisions.
- `ctx.host.capabilities` — the **single source of truth** for what is implemented (a Phase-1 server host reports `{ callRoute: false, session: false, store: false }`).

The frozen Phase-2 namespaces `ctx.host.session.*` and `ctx.host.store.*` are present-but-throwing stubs — calling one throws a loud `host.<member> is reserved for Phase 2` rather than failing silently. **Feature-detect with `ctx.host.capabilities.<name>` / `ctx.host.capabilities.has(name)`, never with member-presence checks** (`if (ctx.host.store)` would wrongly succeed against the stub).

A handler that genuinely needs raw `fs` / `process` / `exec` imports them directly — it already runs as trusted host code in the gateway process. The point of removing `gateway.fetch` is not to constrain trusted handler code, but to keep the *pack→server boundary* a typed, authorized contract with no raw transport to misdirect (see the security note below).

The durable forward path for reaching the gateway is the Phase-2, pack-scoped, typed `host.callRoute(name, init)` — frozen in [`src/shared/extension-host/host-api.ts`](../src/shared/extension-host/host-api.ts), not implemented in Phase 1. It reaches **only** the calling pack's OWN `/api/ext/<thisPack>/*` routes (it is impossible to address an arbitrary gateway path), authorized through the same per-session `allowedTools` guard as `invokeAction`. That is how a future pack will fetch its own dynamic server data without ever exposing a raw fetch.

### Blast-radius controls you get for free

Handlers run in the long-lived gateway process, so Bobbit bounds the damage a buggy or hostile handler can do: a **per-call timeout** (default 30s) that spans **both** the module load+evaluation *and* the handler execution — it returns 504 to the caller while the underlying promise keeps its concurrency permit until it actually settles; a **global concurrency cap** (default 8 in-flight); a **per-session token-bucket rate limit**; **try/catch isolation** (a throw becomes a 500, never a process crash); and **audit logging** of every invocation. You do not configure these from the pack; design your handlers to be fast and side-effect-careful regardless.

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

From a renderer, check capabilities the same way the server side does — via `ctx.host.capabilities`, never member presence:

```js
if (ctx.host.capabilities.invokeAction) { /* Phase-1, always true on a v1 host */ }
if (ctx.host.capabilities.has("callRoute")) { /* Phase-2 only; false today */ }
```

A Phase-1 host reports `{ invokeAction: true, requestRender: true, callRoute: false, session: false, ui: false, store: false }`. The reserved Phase-2 members (`callRoute`, `session`, `ui`, `store`) are present-but-throwing stubs for type stability — `if (ctx.host.store)` would wrongly succeed, which is exactly why `capabilities` is the single source of truth. `ctx.host.version` (`HOST_API_VERSION`) and `ctx.host.contractVersion` (`HOST_CONTRACT_VERSION`) identify the contract revision only; they never imply a member is implemented.

When Phase 2 lands, the durable shape is already frozen in [`src/shared/extension-host/host-api.ts`](../src/shared/extension-host/host-api.ts) and your code is forward-compatible:

- **`host.callRoute(name, init)`** — the typed, pack-scoped replacement for raw fetch. It reaches only your pack's OWN `/api/ext/<thisPack>/*` routes, addressed by declared `name` (there is no `path`/URL field), authorized like a tool call.
- **Host-API-owned data contracts** — `HostMessage`, `HostContentBlock`, `ToolCallRecord`, and typed session-event payloads are stable shapes the contract *owns* and versions (`HOST_CONTRACT_VERSION`), mapped from Bobbit's internal wire format by an internal→contract adapter. Packs read these instead of Bobbit internals, so internal refactors never break a pack.
- **Structured addressing** — `host.ui.openPanel(target)` / `host.ui.navigate(target)` take typed `{ panelId | route, params }` objects, never hash strings, so the contract never bakes in today's router.

Write against `capabilities` today and these become available additively — no signature churn, no version bump.

## Step 6 — install, test, iterate

1. Register the source (the dir containing your pack), then **Install** the pack into a scope (see [docs/marketplace.md](marketplace.md)).
2. `/api/tools` now lists your tool with `rendererKind: "pack"` (and `hasActions: true`).
3. Open a session whose transcript contains a call of your tool → it renders with your pack renderer (placeholder → real renderer).
4. Click the action button → the handler runs → your renderer paints the result.
5. **Reload** the page → the renderer still loads (registration is re-driven from metadata).
6. **Update** the pack (edit + re-sync + Update) → caches invalidate synchronously; the next call uses the new code.
7. **Uninstall** → the renderer and actions disappear live (a subsequent action POST 404s); any displaced built-in is restored.

## Security checklist

The Host API is the single security boundary. As an author, your obligations are:

- [ ] **Never auto-invoke an action on render** — only from a user gesture.
- [ ] **Validate / whitelist `args`** in every handler; never `eval`/`exec`/`require` it or derive paths from it.
- [ ] **Declare `actions.names`** so unknown actions are rejected before the module loads.
- [ ] **Keep `args` identity-free** — `sessionId`/`toolUseId` come from the verified context, not from args.
- [ ] **Don't bare-import `lit`** in a renderer — use the factory toolkit.
- [ ] **Use theme tokens**, preserve any iframe `sandbox` attributes, and never mutate the transcript from a renderer.
- [ ] **Go through `host.invokeAction`** for every pack→server call — it is the sole, tool-authorized path. Do not hand-roll a gateway request or reach for any raw fetch; there is none by design.
- [ ] **Feature-detect via `host.capabilities`**, never member presence — reserved Phase-2 members are present-but-throwing stubs.

The deeper model — the allowlist-bypass fix, `toolUseId` ownership verification, single-sourced session identity, and the worker/vm isolation seam left for Phase 2 — is documented in [docs/design/extension-host.md §5](design/extension-host.md).

## Reference

- Worked example pack: `tests/fixtures/market-sources/retry-demo-src/retry-demo/`
- Browser E2E: `tests/e2e/ui/extension-host.spec.ts`
- Frozen Host API types: `src/shared/extension-host/host-api.ts`
- Action dispatcher + handler ctx: `src/server/extension-host/action-dispatcher.ts`
- Server-side Host API (`ctx.host`): `src/server/extension-host/server-host-api.ts`
- Contribution-manifest parser: `src/server/agent/tool-contributions.ts`
- Renderer render-context type: `src/ui/tools/types.ts`
- Client renderer registration: `src/app/pack-renderers.ts`
