# Bobbit Extension Host — Phase 2 Implementation Plan

**Status:** implementation design. **Scope:** make the Phase-1 *reserved* contribution
shape REAL, **purely additively**. No change to v1 signatures in
`src/shared/extension-host/host-api.ts`; `HOST_API_VERSION` stays `1`
(`src/shared/extension-host/host-api.ts` declares it `as const`); each capability flips
its `host.capabilities` flag `false → true` as it lands.

**Source of truth:** `docs/design/extension-host.md` (the frozen v1 contract). Do not
change v1 signatures/types in that doc — they stay byte-identical (frozen). Its §3/§6
prose **status notes** are flipped from "frozen, not implemented" → "implemented" as each
capability lands (a status edit, not a contract change — see §16). This doc is the build
plan a coder executes with **zero further architectural decisions**. Every signature below
already exists frozen in v1; Phase 2 adds method *bodies* and wires capabilities through
the SAME authorization path Phase 1 built.

**Reuse, do not refork (hard constraint).** Three Phase-1 chokepoints are reused verbatim:

- **Per-session authorization guard** — `authorizeActionRequest()` /
  `transcriptHasToolUse()` (`src/server/extension-host/action-guard.ts:53` / `:106`).
  `invokeAction` and `session.postMessage` (tool-call-scoped) keep the full
  `authorizeActionRequest` (incl. toolUseId-ownership) verbatim. The pack-scoped
  capabilities (`store` / `session.read*` / `callRoute`) route through a new
  `authorizeScopedRequest()` — the SAME guard MINUS the toolUseId-ownership step (§2a). It
  is not a weakening of the action guard; it is the correct narrower authz for calls where
  no specific tool call is being acted on.
- **Generation-guarded renderer-registry chokepoint** — `applyRegistration()`
  (`src/ui/tools/renderer-registry.ts:95`) and the `{override}` /
  `unregisterPackRenderer` / `displacedBuiltins` machinery. Panels (B4) reuse this exact
  loader+reconcile pattern; they do not introduce a parallel registry.
- **Epoch-guarded module cache** — `ActionDispatcher` cache + `epoch` + bounded
  in-flight reload (`src/server/extension-host/action-dispatcher.ts:176` `loadModule`,
  `:142` `invalidate`). Route modules (B3) reuse this loader; the worker isolation (C3)
  wraps its single invocation seam (actions + routes only — stores run no pack code).

**Invariants preserved (pinned by existing tests; must stay green):**

- `buildPackList` byte-identical — `tests/pack-marketplace.test.ts`. Zero market packs ⇒
  resolution unchanged. All new contribution fields are additive
  (`tool-manager.ts:67 contributionFields` is "additive, never reorders").
- Tool-description budget — `tests/tool-description-budget.test.ts`.
- AGENTS.md byte budget — keep AGENTS.md edits to one line (a single pointer here).

---

## 0. Capability ledger (what flips, where the body lands)

| Slice | Capability | `host.capabilities` flag | Reserved key activated | Primary new file |
|---|---|---|---|---|
| A | server-resolved pack identity | (foundation — no flag) | — | `pack-identity.ts` |
| B1 | `host.store.{get,put,list}` | `store` | `stores:` | `pack-store.ts` |
| B2 | `host.session.{readTranscript,readToolCall}` | `session` (read) | — | `contract-adapter.ts` |
| B3 | `host.callRoute` | `callRoute` | `routes:` | `route-dispatcher.ts` |
| B4 | `host.ui.openPanel` | `ui` (panel) | `panels:` | `pack-panels.ts` |
| C1 | `host.ui.navigate` + entrypoints | `ui` (nav) | `entrypoints:` | `pack-entrypoints.ts` |
| C2 | `host.session.{postMessage,subscribe}` | `session` (write) | — | (extends B2 files) |
| C3 | server-module isolation (actions + routes only) | (hardening — no flag) | — | `module-host-worker.ts` |
| D1 | artifacts-as-pack (litmus) | — | renderer+panels+stores | `market-packs/artifacts/` |
| D2 | pr-walkthrough-as-pack (litmus) | — | panels+routes+stores+entrypoints | `market-packs/pr-walkthrough/` |

`ui` and `session` are single flags spanning two sub-capabilities each (frozen as one
namespace in v1). They flip to `true` only when **all** members of that namespace are
implemented: `ui` flips after **C1** (openPanel+navigate); `session` flips after **C2**
(reads+writes). Until then packs gate **solely** on `host.capabilities` — the single source
of truth — and MUST NOT rely on a method whose flag is `false`. There is no supported
feature-detection path through internal early method bodies (no "attempt the call in a
`try/catch`"); the flag is authoritative. This matches the v1 doc's "single source of truth
= capabilities" rule and avoids a half-true flag. (Sub-flag granularity is NOT added — that
would change the frozen `HostCapabilities` shape.)

**Capability-signaling convention (binding).** The `host.capabilities` namespace flag is
the **single source of truth** for whether a capability is usable. A pack MUST NOT rely on
a method while its flag is `false`. Bobbit's OWN slices MAY land method bodies ahead of the
flip (e.g. `session.read*` bodies ship in **B2**, but the `session` flag does not flip
until **C2**); during that interim the bodies are **internal-only** — no pack and no
acceptance test consumes them until the flag is `true`. Concretely, the litmus packs that
use session reads (D2) depend on **C2** (the flag-flip slice), not merely on B2 (the body
slice). This keeps "a flag is true ⇒ every member of that namespace is callable by packs"
an invariant, while letting Bobbit implement incrementally.

---

## 1. Shared-file edit ledger — SERIALIZE these

Five files are touched by multiple slices. The team-lead MUST serialize edits to each
(one task in flight at a time per file; later waves rebase). Every other new file is
single-owner and parallel-safe.

| Shared file | Slices that edit it | Nature of edit | Serialize? |
|---|---|---|---|
| `src/app/host-api.ts` | B1, B2, B3, B4, C1, C2 | Replace one `notImpl(...)` stub with a real body + flip its flag in `flags` | **YES** — every B/C slice rewrites a line in the same object literal |
| `src/server/extension-host/server-host-api.ts` | B1, B2, C2 | Replace `notImplemented(...)` with real body; flip `ServerHostCapabilities` flag; add `packId`/`contributionId` plumbing (A) | **YES** |
| `src/server/server.ts` | A, B1, B2, B3, C1, C2 | New endpoints in `handleApiRoute` + thread `packId` into `createServerHostApi` (A) | **YES** — single 13k-line file; new routes added near `:5216` |
| `src/server/agent/tool-contributions.ts` | A, B1, B3, B4, C1 | New parsers for reserved keys (panels/routes/stores/entrypoints) graduate from "shape-only" to "typed" | **YES** |
| `src/ui/tools/renderer-registry.ts` | B4 only | Export `applyRegistration`-backed helpers for the panel registry, OR B4 imports a sibling that reuses the chokepoint | **NO if B4 adds a sibling module** (preferred) |

**Decision for `renderer-registry.ts`:** B4 does NOT edit it. Instead `pack-panels.ts`
imports the existing exports and mirrors the `applyRegistration` pattern in its own
generation-guarded map (panels are a distinct registry keyed by `panelId`, not tool name).
If a shared generic is warranted, extract `makeGenerationGuardedRegistry()` in a
**separate Wave-A refactor task** owned solely by A, so B4 consumes a stable API. This
keeps `renderer-registry.ts` single-owner.

**Serialization mechanic for the four YES files:** each slice's task lists the shared file
in its spec; the team-lead schedules at most one such task per file concurrently and
rebases the next on merge. Because every edit is a localized stub-replacement in a known
object literal (client `flags`/method map; server capability map), conflicts are trivial
to rebase even when serialized loosely.

---

## 2. Slice A — server-resolved pack identity (foundation, no deps)

**Goal:** every Host API instance (client + server) carries a **TRUSTED, host-derived**
`{ packId, contributionId }` that extension code can never set or forge (v1 §3.2). This is
the security keystone for B1/B3 (store namespacing, route namespace constraint).

### A.1 New file: `src/server/extension-host/pack-identity.ts`

One-line responsibility: derive a stable pack identity from a resolved winning
contribution location.

```ts
export interface PackIdentity {
  /** Stable id = the pack directory name under `market-packs/` (the segment AFTER
   *  the `market-packs` segment in baseDir). Empty string for a non-pack (builtin). */
  packId: string;
  /** The contributing tool/group key that won resolution: `${groupDir}/${tool}`. */
  contributionId: string;
  /** True when baseDir is a market-pack root (mirrors isMarketPackBaseDir). */
  isPack: boolean;
}

/** Derive identity from a resolved tool location. NEVER reads caller input. */
export function resolvePackIdentity(
  loc: { baseDir: string; groupDir: string } | undefined,
  tool: string,
): PackIdentity;

/** Resolve identity for a tool via a tool-location resolver (the session's
 *  project-scoped ToolManager, picked by resolveActionToolManager). */
export function resolvePackIdentityForTool(
  resolver: ActionToolLocationResolver,   // from action-dispatcher.ts
  tool: string,
): PackIdentity;
```

`packId` derivation reuses the **structural** path-segment logic already proven in
`tool-contributions.ts:isMarketPackBaseDir` (`tool-contributions.ts` `isMarketPackBaseDir`):
split `baseDir` on `[\\/]+`, find the `market-packs` segment, take the **next** segment.
This is the directory name an install writes
(`<scope>/.bobbit/config/market-packs/<name>/tools`), so it is stable across installs and
identical for every tool the pack contributes.

### A.2 Server host: thread identity into `createServerHostApi`

Edit `src/server/extension-host/server-host-api.ts` (`CreateServerHostApiOptions` at the
`createServerHostApi` definition near end of file):

```ts
export interface CreateServerHostApiOptions {
  sessionId: string;
  toolUseId?: string;
  packId: string;          // NEW — server-derived, never caller-supplied
  contributionId: string;  // NEW
}
```

`createServerHostApi` stores `packId`/`contributionId` in closure; B1/B2/B3 read them when
implementing `store`/`session`/`callRoute`. Capability flags stay computed from a `flags`
object (the existing `ServerHostCapabilities` shape is unchanged).

Edit the action endpoint (`src/server/server.ts:5216`): after the guard passes, compute
identity from the SAME `sessionToolManager` already resolved at `server.ts:5238`:

```ts
const ident = resolvePackIdentityForTool(sessionToolManager, tool);   // NEW
const host = createServerHostApi({
  sessionId: guard.sessionId, toolUseId,
  packId: ident.packId, contributionId: ident.contributionId,         // NEW
});
```

This reuses the existing `resolveActionToolManager(...)` resolution (`server.ts:5238`) — no
new precedence path; the dispatcher already loads the winning module from the same
resolver, so identity and module agree by construction (v1 §3.2 "that resolution IS the
pack identity").

### A.3 Client host: identity from the served renderer's tool

The client `getHostApi(sessionId, toolUseId)` (`src/app/host-api.ts`) gains a third bound
field — the **tool name** the renderer was served for (the pack that won that tool name IS
the identity, v1 §3.2). The factory in `pack-renderers.ts` already closes over `t.name`
when it registers a loader (`pack-renderers.ts` `registerLazyToolRenderer(t.name, ...)`).
Thread that name into the ctx so the client Host API can scope `callRoute`/`store`:

- Edit `src/ui/tools/types.ts` — `ToolRenderContext` gains `packTool?: string` (the tool
  name whose pack owns this renderer). Built-in renderers leave it undefined.
- Edit `src/ui/components/Messages.ts` / `ToolGroup.ts` ctx construction — pass the tool
  name. (These already set `host: getHostApi(...)` per v1 §3.1.)
- Edit `src/app/host-api.ts` — `getHostApi(sessionId, toolUseId, packTool?)`; the
  server resolves the actual `packId` from `packTool` on each scoped call, so the client
  never sends a `packId` (the server-derived rule holds — client only names a *tool*, and
  the server maps tool→winning pack).

**Capabilities computation:** no flag flips in A (identity is plumbing). A's acceptance is
purely the unit test (A.test) proving identity resolution + that no caller field can
override it.

### A.4 `host.capabilities` becomes computed per slice

Already structured for this: both hosts build `capabilities` from a `flags` object literal
(`host-api.ts` `const flags = {...}`; `server-host-api.ts` `const flags = {...}`). Each
later slice flips exactly one boolean in that literal — the single line a serialized edit
touches.

---

## 2a. Scoped-request authorization + panel/entrypoint host context

**Deps:** A. **Lands with A** (foundation for every scoped capability). Two pieces: a
narrower authorization guard, and the host-context binding for calls that originate from a
panel/entrypoint rather than from a specific tool call.

### 2a.1 `authorizeScopedRequest` — the action guard MINUS toolUseId-ownership

The Phase-1 action endpoint is **tool-call-scoped**: it acts on a specific `toolUseId`, so
`authorizeActionRequest` (`action-guard.ts:53`) requires that the caller owns that
`toolUseId` (`transcriptHasToolUse`, `:106`). But `store.*`, `callRoute`, and
`session.read*` are **pack-scoped**, not tool-call-scoped — no specific tool call is being
acted on, and a panel/entrypoint may originate the call with no owned `toolUseId` at all.
For these, `toolUseId`-ownership is the wrong check.

Factor the guard so toolUseId-ownership is a **separate, capability-specific** step:

```ts
// action-guard.ts — NEW export, reusing the same primitives
export function authorizeScopedRequest(opts): ScopedAuthzResult;
//   1. header-canonical session id (single-sourced, never from body alone)
//   2. body session id === header session id  (reject mismatch)
//   3. session resolves (project context + sessionStore)
//   4. the pack's contributing `tool` ∈ the session's allowedTools
//   5. → returns { sessionId, sessionToolManager } so the caller server-derives packId (A)
// It is authorizeActionRequest WITHOUT step (6) transcriptHasToolUse(toolUseId).
```

`authorizeScopedRequest` is **not a weakening** of the action guard: it keeps every check
except the one that only makes sense when a concrete tool call is the subject. `toolUseId`
is OPTIONAL on scoped requests (a panel/entrypoint call legitimately has none). Allocation:

| Endpoint | Guard | toolUseId-ownership? |
|---|---|---|
| `invokeAction` (Phase 1) | `authorizeActionRequest` | **required** (unchanged) |
| `session.postMessage` (C2) | `authorizeActionRequest` | **required** (drives the agent) |
| `store.*` (B1) | `authorizeScopedRequest` | not required |
| `callRoute` (B3) | `authorizeScopedRequest` | not required |
| `session.read*` (B2) | `authorizeScopedRequest` | not required |

### 2a.2 Panel / entrypoint host context binding

A renderer's host API is built `getHostApi(sessionId, toolUseId, packTool)` (A.3). A panel
or entrypoint has no tool call, so it binds `{ sessionId, packTool, packId, contributionId }`
from the **opening context**:

- A **renderer** that opens a panel carries `sessionId` + `packTool` already; it passes
  them to `openPanel`, and the panel host API is built `getHostApi(sessionId, undefined,
  packTool)` — `toolUseId` is `undefined`.
- An **entrypoint** carries `packTool` from its own contribution; the active session
  supplies `sessionId`. Same `getHostApi(sessionId, undefined, packTool)`.

So a panel/entrypoint can call `store.*` / `callRoute` / `session.read*` (they route through
`authorizeScopedRequest`, which needs no `toolUseId`), but it CANNOT call `invokeAction` or
`session.postMessage` without a real user-gesture-originated `toolUseId` (those keep
`authorizeActionRequest`). The user-gesture requirement for `postMessage` is still enforced;
no auto-invoke/post on mount (v1 §5 v). This closes the D2 gap where a panel-originated
`callRoute`/`store`/`readToolCall` had no owned `toolUseId` to satisfy the action guard.

---

## 3. Slice B1 — `stores:` + `host.store.*`

**Deps:** A. **Flag:** `store`. **Reserved key:** `stores:`.

### B1.1 New file: `src/server/extension-host/pack-store.ts`

One-line responsibility: file-backed, pack-namespaced KV persistence.

```ts
export interface PackStore {
  get<T = unknown>(packId: string, key: string): Promise<T | null>;
  put<T = unknown>(packId: string, key: string, value: T): Promise<void>;
  list(packId: string, prefix?: string): Promise<string[]>;
}
export function createPackStore(opts?: { rootDir?: string }): PackStore;
```

**Backend (concrete):** JSON files under
`bobbitStateDir()` + `/ext-store/<packId>/<safeKey>.json`
(`src/server/bobbit-dir.ts:34 bobbitStateDir`). One file per key.

- **Key namespacing:** the on-disk path is ALWAYS
  `path.join(root, "ext-store", packId, encodeKey(key))`. `packId` comes from the
  server-derived identity (never from the request body) — this is the cross-pack-read
  rejection: a pack physically cannot form a path outside its own `packId` dir.
- **`encodeKey`:** percent-encode (or sha256+`.json`) so arbitrary key strings can't
  traverse (`..`, `/`). Re-validate the resolved abs path stays within the `packId` dir
  (mirror the path-traversal re-validation at `action-dispatcher.ts:resolveModulePath`
  and `server.ts:5197` renderer endpoint).
- **Serialization:** `JSON.stringify` value under `{ v: 1, value }`. `get` returns
  `null` on missing file or parse failure.
- **`list(prefix)`:** `fs.readdir` the `packId` dir, decode names, filter by `prefix`,
  return decoded keys. No cross-pack dir is ever read.
- **Empty `packId` (non-pack) ⇒ reject** (`store` is pack-only).

### B1.2 Endpoint: `POST /api/ext/store/:op` (server.ts, near `:5216`)

Body `{ sessionId, toolUseId?, tool, key, value?, prefix? }`; `:op ∈ {get,put,list}`.
**Guard ordering (pack-scoped — reuse §2a):**

```
1. authorizeScopedRequest({...})  → header-canonical session, body===header, session
   resolves, `tool` ∈ allowedTools  (§2a; toolUseId NOT required — panels may originate)
2. resolvePackIdentityForTool(sessionToolManager, tool)  → packId  (A; server-derived)
3. reject if !ident.isPack  → 403
4. packStore[op](ident.packId, key, ...)  under the dispatcher timeout/try-catch
5. audit + json(result)
```

Because step 1 is `authorizeScopedRequest`, store inherits the allowedTools gate by
construction (v1 §5 "Phase-2 capabilities inherit the same rule") without demanding a tool
call the caller may not have. The `tool` in the body identifies which contribution; the
guard verifies the caller is authorized for that tool in this session, and identity is
derived server-side from it — the client never names a pack.

### B1.3 Server-host wiring

In `server-host-api.ts`, `createServerHostApi` now builds a real `store` bound to the
closure `packId`, delegating to a process-singleton `PackStore` (constructed near
`actionDispatcher` at `server.ts:863`, passed into `createServerHostApi`). Flip
`flags.store = true`. Server action handlers thus get `ctx.host.store.get/put/list` scoped
to their own pack.

### B1.4 Client-host wiring (`src/app/host-api.ts`)

Replace the three `store` stubs with bodies that POST `/api/ext/store/:op` via
`gatewayFetch` + `withSession` (same pattern as `invokeAction` at `host-api.ts`
`invokeAction`), passing the bound `packTool` as `tool`. Flip `flags.store = true`.

### B1.5 `stores:` activation (`tool-contributions.ts`)

Add `parseStores(raw, filePath)` graduating `reserved.stores` from `unknown[]` to a typed
`StoreContribution[] = { id: string }[]` (a declaration that the tool uses a store — the
runtime backend is keyed by `packId`, so the declaration is advisory/validation only).
Keep accepting + ignoring on shape failure (never reject). Surface via a new optional
`ToolInfo.storeIds?: string[]` wire field (additive — preserves byte-identical).

---

## 4. Slice B2 — internal→contract adapter + `host.session` READS

**Deps:** A. **Flag:** `session` (flips only after C2 adds writes). **No reserved key.**

### B2.1 New file: `src/server/extension-host/contract-adapter.ts`

One-line responsibility: map Bobbit's internal session/message JSONL rows onto the frozen,
versioned Host-API-owned contract shapes.

```ts
import { HOST_CONTRACT_VERSION } from "../../shared/extension-host/host-api.js";
import type { HostMessage, HostContentBlock, ToolCallRecord } from "../../shared/extension-host/host-api.js";

/** Parse one transcript JSONL string → HostMessage[]. Tolerant of both the
 *  Anthropic {type:"tool_use",id,name} and pi-coding-agent {toolCallId,toolName}
 *  shapes — REUSE the row-walking already in transcriptHasToolUse
 *  (action-guard.ts:106) but emit contract blocks instead of a boolean. */
export function transcriptToHostMessages(jsonl: string | null | undefined): HostMessage[];

/** Extract a single tool call (input+output) by id → ToolCallRecord | null. */
export function transcriptToToolCall(jsonl: string | null | undefined, toolUseId: string): ToolCallRecord | null;

export const CONTRACT_VERSION = HOST_CONTRACT_VERSION;
```

This is the **decoupling layer** (v1 §3): packs see only `HostMessage`/`HostContentBlock`/
`ToolCallRecord`; Bobbit's internal wire can change freely. The mapping logic generalizes
the existing `transcriptHasToolUse` row walk (`action-guard.ts:106`) — reuse its
shape-tolerance (handles `tool_use` / `toolCall` / `toolCallId`, `id`/`tool_use_id`,
`name`/`toolName`).

### B2.2 Endpoints (server.ts)

```
GET  /api/ext/session/transcript   ?tool&offset&limit&pattern   → TranscriptEnvelope
GET  /api/ext/session/tool-call    ?tool&toolUseId               → ToolCallRecord | null
```

**Guard ordering (pack-scoped, own-session reads — reuse §2a):**

```
1. authorizeScopedRequest({...})  → header-canonical session, `tool` (query) ∈ allowedTools
   (§2a; toolUseId NOT required — panels/entrypoints may originate the read)
2. read THE HEADER-BOUND session's transcript only:
   projectContextManager.getContextForSession(headerSessionId)?.sessionStore.get(headerSessionId)
   (the exact own-session read mcp-call uses, server.ts:11108) → agentSessionFile → sessionFileRead
3. contract-adapter maps rows → envelope; slice by offset/limit; filter by pattern
4. json(envelope)
```

Reads are scoped to the caller's OWN session by sourcing the transcript from the
header-bound session id (single-sourced identity, v1 §5 iii-b) — there is no parameter for
another session id.

### B2.3 Wiring

- Server host: `createServerHostApi` implements `session.readTranscript`/`readToolCall`
  against the adapter (bound `sessionId`). Keep `postMessage` throwing until C2.
- Client host (`src/app/host-api.ts`): replace `session.readTranscript`/`readToolCall`
  stubs with `gatewayFetch` GETs; keep `postMessage`/`subscribe` throwing until C2. Do
  NOT flip `flags.session` yet (it spans writes too).
- **Capability-signaling (per §0 convention):** the read bodies that ship here are
  **internal-only** until the `session` flag flips in **C2**. Because the flag is the
  single source of truth, no pack and no acceptance test consumes `session.read*` while
  `capabilities.session === false`. That is why D2 (which uses `readToolCall`) depends on
  **C2**, not on B2 — it must not read the transcript before the namespace is officially
  live. Bobbit lands the bodies early purely to decouple the work; the flip in C2 is what
  makes them publicly callable.

> Alternative considered: split `session` into `sessionRead`/`sessionWrite` flags. Rejected
> — changes the frozen `HostCapabilities` shape (a v1 break). Partial-namespace-live with a
> single flag flipping at full implementation is the additive-safe choice.

---

## 5. Slice B3 — `routes:` + `host.callRoute`

**Deps:** A. **Flag:** `callRoute`. **Reserved key:** `routes:`.

### B3.1 New file: `src/server/extension-host/route-dispatcher.ts`

One-line responsibility: load + dispatch a pack's contributed route module, mirroring
`ActionDispatcher` (epoch cache + timeout + single invocation seam).

```ts
export type RouteHandlerCtx = ActionHandlerCtx;   // reuse: {host, sessionId, toolUseId, tool}
export type RouteHandler = (ctx: RouteHandlerCtx, req: { method: string; query?: Record<string,string>; body?: unknown }) => Promise<unknown> | unknown;
export type RoutesModule = { routes: Record<string, RouteHandler> };

export class RouteDispatcher {
  constructor(toolManager: ActionToolLocationResolver, opts?: ActionDispatcherOptions);
  invalidate(): void;          // wired into invalidateResolverCaches (server.ts:2247)
  async dispatch(tool: string, name: string, ctx: RouteHandlerCtx, req: ..., resolver?): Promise<unknown>;
}
```

**Reuse, not refork:** `RouteDispatcher` is structurally `ActionDispatcher` with `routes`
instead of `actions`. Extract the shared loader (epoch cache, bounded in-flight reload,
permit-held-until-settle, `runWithTimeout`) into a small base or shared helper so both
dispatchers use ONE copy — the C3 worker-isolation seam then wraps that single helper. The route
module path comes from a new `routes.module` contribution (default `routes.js`), resolved
via the same `resolveToolLocation` location as actions.

**`routes:` is PACK-scoped, not opener-tool-scoped.** The route module is selected by the
server-resolved `packId`, independent of which tool opened the surface that issued the
`callRoute`. The opener `packTool` (carried in the request body) is used ONLY to derive
`packId` (step 2 below); once derived, the server loads the route module from the pack's
route contribution. Any panel, renderer, or entrypoint sharing that `packId` reaches the
SAME routes — a panel opened from tool X can reach a route declared on tool Y in the same
pack. **Deterministic selection rule (convention):** a pack declares `routes:` on a single
designated tool; the server loads that one route module for the whole pack. (If more than
one tool in a pack were to declare `routes:`, each route name resolves to its declaring
tool's module — but the documented convention is one routes-bearing tool per pack to keep
selection unambiguous.)

### B3.2 Endpoint: `POST /api/ext/route/:name` (server.ts)

There is **no `<pack>` URL segment** — the only routable namespace is the one the server
derives from the `tool` the caller proves it owns, so there is nothing to forge. Body
`{ sessionId, toolUseId?, tool, init }` (`init` = v1 `HostRouteInit`: `method`/`body`/
`query`, **no path**). Flow:

```
1. authorizeScopedRequest({...})  → header-canonical session, body===header, session
   resolves, pack's contributing `tool` ∈ allowedTools  (§2a; toolUseId NOT required)
2. resolvePackIdentityForTool(sessionToolManager, body.tool) → ident  (A; server-derived)
3. reject 403 if !ident.isPack
4. routeDispatcher.dispatch(body.tool, name, ctx, init, sessionToolManager)
   — dispatches ONLY against THAT pack's `routes.js` (the pack derived from `tool`)
5. audit + json(result)
```

The client `callRoute(name, init)` POSTs to `/api/ext/route/${encodeURIComponent(name)}`
with body `{ sessionId, toolUseId?, tool: packTool, init }`. The client never knows or
sends a `packId`: it names only the `tool` whose renderer/panel it was served for, and the
server maps tool → winning pack (step 2). **Namespace guarantee, by construction:** a pack
can reach only its OWN routes because the routed pack is *derived* from a tool the caller
is authorized for — there is no caller-supplied namespace segment to validate (v1 §3.2).

**Reconciliation with the goal's `/api/ext/<pack>/*`.** The goal spec's `/api/ext/<pack>/*`
shape describes the namespace *intent* — pack-scoped, constrained to the calling pack — not
a literal wire format. The implementation realizes the SAME security property server-side
via tool→`packId` derivation behind `POST /api/ext/route/:name`: a deliberate,
security-equivalent refinement. A client-supplied `<pack>` URL segment is unbuildable —
the client never knows `packId` (it only knows the `tool` it was served for; see Fix 1 in
the prior revision) — and a forgeable segment would be a weaker boundary than deriving the
pack from a proven-owned tool. This is an equivalence, not a contract mismatch.

### B3.3 Wiring

- Construct `RouteDispatcher` near `actionDispatcher` (`server.ts:863`); add
  `routeDispatcher.invalidate()` into `invalidateResolverCaches` (`server.ts:2247`,
  alongside `dispatcher.invalidate()`).
- Client `host.callRoute` body in `src/app/host-api.ts`; flip `flags.callRoute = true`.
- Server `ServerHostApi.callRoute` is NOT added (frozen server surface has no callRoute —
  server handlers reach their own routes by calling the function directly; `callRoute` is a
  CLIENT capability for renderers/panels). Confirm against v1: `ServerHostApi` (server-host-api.ts)
  has no `callRoute` member — correct, leave it.

### B3.4 `routes:` activation (`tool-contributions.ts`)

`parseRoutes(raw)` → `RouteContribution = { module?: string; names?: string[] }` (mirrors
`parseActions`, same path-safety via `isSafeRelativePath`). Add wire field
`ToolInfo.routeNames?: string[]`.

---

## 6. Slice B4 — `panels:` + `host.ui.openPanel`

**Deps:** A. **Flag:** `ui` (flips only after C1). **Reserved key:** `panels:`.

### B4.1 New file: `src/app/pack-panels.ts`

One-line responsibility: client registry of pack-contributed side-panel modules, mirroring
`pack-renderers.ts` + the `renderer-registry.ts` generation-guarded chokepoint.

```ts
export interface PackPanelInfo { panelId: string; tool: string; entry: string; title?: string; }
/** Idempotent + reconciling registration, re-driven from /api/tools metadata —
 *  byte-for-byte the registerPackRenderers shape (pack-renderers.ts). */
export function registerPackPanels(panels: ReadonlyArray<PackPanelInfo>, projectId?: string): void;
export function reconcilePackPanelsForProject(projectId: string | undefined): Promise<void>;
/** Load + mount a panel module by id (lazy Blob-URL import + host toolkit factory). */
export function openPackPanel(target: PanelTarget): void;
```

**Reuse the chokepoint, do not fork it.** Panels are keyed by `panelId` (not tool name), so
they get their OWN generation-guarded map inside `pack-panels.ts` that copies the
`applyRegistration` contract (`renderer-registry.ts:95`): capture generation before await,
drop superseded applies, reconcile-on-uninstall, project-scoped, reload-safe. The Blob-URL
lazy import + `/* @vite-ignore */` + host-toolkit factory are identical to
`pack-renderers.ts`. (If the team-lead prefers, an A-owned refactor extracts a shared
`makeGenerationGuardedRegistry` — see §1; B4 then consumes it.)

### B4.2 Panel serving endpoint (server.ts)

`GET /api/tools/:tool/panel/:panelId?projectId=` — bearer-only (static-asset-equivalent,
EXACTLY like the renderer endpoint at `server.ts:5170`, NO allowedTools check): resolve the
winning `{baseDir,groupDir}` via the project-scoped `resolveActionToolManager`, look up the
`panels[]` entry whose `id===panelId`, read its `entry` `.js` (path-traversal re-validated
as at `server.ts:5197`), respond `text/javascript`.

### B4.3 Panel host surface + `openPanel`

Mount panels into the existing panel workspace (`src/app/panel-workspace.ts` —
`setPanelTabsForSession`/`activeSidePanelTabIdForSession` already manage side-panel tabs).
`openPackPanel(target)` adds/focuses a tab whose content is the lazily-loaded pack panel
element, handing it the `PanelTarget.params` (e.g. `{ artifactId }`).

- Client `host.ui.openPanel` body in `src/app/host-api.ts` calls `openPackPanel`. Keep
  `ui.navigate` throwing until C1; do not flip `flags.ui` yet (spans navigate).
- **Conventions (enforced, v1 §4a renderer constraints apply to panels):** theme tokens
  only (no hardcoded colours / no `:root{}` / no `prefers-color-scheme`); preserve iframe
  `sandbox` attributes; no auto-invoke/navigation on mount.

### B4.4 `panels:` activation (`tool-contributions.ts`)

`parsePanels(raw)` → `PanelContribution = { id: string; title?: string; entry: string }[]`
(`entry` path-safe via `isSafeRelativePath`). Add wire field `ToolInfo.panels?: {id;title?}[]`.

---

## 7. Slice C1 — `entrypoints:` + `host.ui.navigate`

**Deps:** B4 (panels), B3 (routes — entrypoints may launch routes). **Flag:** `ui` flips
`true` here (openPanel + navigate now both implemented). **Reserved key:** `entrypoints:`.

### C1.1 New file: `src/app/pack-entrypoints.ts`

One-line responsibility: register pack-contributed launchers and resolve structured
navigation targets onto the SPA router.

```ts
export type EntrypointKind = "composer-slash" | "git-widget-button" | "command-palette";
export interface EntrypointInfo { id: string; tool: string; kind: EntrypointKind; label: string; target: RouteTarget | PanelTarget; }
export function registerPackEntrypoints(eps: ReadonlyArray<EntrypointInfo>, projectId?: string): void;
/** Map a structured RouteTarget → the router's hash scheme (packs never build URLs). */
export function navigateToTarget(target: RouteTarget): void;
```

### C1.2 `navigate` resolution (no hash strings in packs)

`RouteTarget = { route: string; params? }` (frozen v1). `navigateToTarget` maps `route` to
the SPA router (`src/app/routing.ts` — `RouteView` already includes `"walkthrough"`,
`setHashRoute`, `getRouteFromHash`). A pack-declared `route` resolves to a host-controlled
view; the pack never constructs `#/...` (v1 §3 structured addressing). Client
`host.ui.navigate` body calls `navigateToTarget`; **flip `flags.ui = true`** now.

### C1.3 Entrypoint surfaces

- **composer-slash:** register a slash-command into the composer's command list.
- **git-widget-button / command-palette:** register a button/launcher; on click →
  `openPanel` or `navigate` (NO auto-invoke on mount — invocation is the user gesture).

### C1.4 `entrypoints:` activation (`tool-contributions.ts`)

`parseEntrypoints(raw)` → typed `EntrypointContribution[]` (validate `kind` enum, `label`,
structured `target`). Wire field `ToolInfo.entrypoints?: EntrypointContribution[]`.

---

## 8. Slice C2 — `host.session` WRITES (`postMessage` + `subscribe`)

**Deps:** B2 (reads). **Flag:** `session` flips `true` here. **Highest-risk slice.**

### C2.1 Endpoint: `POST /api/ext/session/message` (server.ts)

Body `{ sessionId, toolUseId, tool, role: "user"|"system", text, resumeTurn? }`.

**Guard ordering (user-gesture, header-bound, audited):**

```
1. authorizeActionRequest({...})  → header-canonical session + toolUseId-ownership
   (action-guard.ts:53; postMessage is tool-call-scoped — NOT authorizeScopedRequest)
2. require role ∈ {user,system}; reject empty text
3. post into the HEADER-BOUND session ONLY:
   - resumeTurn !== false → sessionManager.enqueuePrompt(headerSessionId, text, {source:"extension"})
     (session-manager.ts:1802)
   - resumeTurn === false → deliver without resuming the agent turn
     (sessionManager.deliverLiveSteer, session-manager.ts:1967, or a non-resuming append)
4. AUDIT every post/resume: {tool, packId, sessionId, role, resumeTurn, ms}  (mandatory — v1 §5 C2)
5. json({ok:true})
```

`postMessage` drives the agent, so the session is the **header-bound** session (never a
parameter) and every call is audited. The user-gesture requirement is enforced client-side
exactly like `invokeAction` (no auto-invoke on mount — v1 §5 v); reviewers reject
render-time posts.

### C2.2 `subscribe` (live typed events)

Client-side: `host.session.subscribe(event, cb)` returns an unsubscribe fn, bridging the
existing session WebSocket / event bus (`src/app/verification-event-bus.ts`,
`gate-status-events.ts` patterns) into the frozen `HostSessionEventMap` (`tool_result` /
`status` / `message`) via the contract-adapter (B2.1) so payloads are contract shapes, not
internal wire. Scoped to the bound session.

### C2.3 Wiring

- Server host `ServerHostApi.session.postMessage` body (bound session); client
  `host.session.postMessage`/`subscribe` bodies. **Flip `flags.session = true`** on both
  hosts (reads from B2 + writes here = full namespace live).

---

## 9. Slice C3 — server-module isolation (worker_threads)

**Deps:** the slices whose pack server modules it isolates — **actions (B-baseline) +
routes (B3) ONLY**. **No flag** (hardening). **Store-handler scope (deliberate
interpretation):** the goal spec lists C3 as isolating "actions, routes, store handlers",
but Phase 2 has **NO pack-supplied store-handler module** — stores are host-backed KV
reached via `ctx.host.store.*`, so the spec's "store handlers" phrase has no pack-code
surface to isolate. C3 isolates **actions + routes**, which are the only pack-supplied
server modules; no required surface is left unisolated. (The store endpoint runs entirely
in the parent; no pack code runs in the store path, so there is nothing to confine.)
Realizes the
blast-radius seam Phase 1 left open (`action-dispatcher.ts` `runWithTimeout` doc: "does NOT
terminate timed-out work").

### C3.1 Decision: `worker_threads` (NOT `node:vm`)

`node:vm` does NOT bound CPU/memory and cannot be force-terminated mid-loop (a `while(1)`
hangs the event loop). `worker_threads.Worker` supports `worker.terminate()` (true
terminate-on-timeout) and `resourceLimits` (`maxOldGenerationSizeMb`, `stackSizeMb`) for
memory caps. **Choose `worker_threads`.** Note that `worker_threads` does NOT by itself
confine `process`/env/fs/network/built-ins — a worker inherits the parent env and can
`require('node:fs')` unless we explicitly deny it. C3.2 therefore adds a confinement
bootstrap; "isolation" in this doc means *that bootstrap + empty env + terminate/resource
caps*, not the bare worker.

### C3.2 New file: `src/server/extension-host/module-host-worker.ts`

One-line responsibility: run a pack server module (`actions` or `routes` member) in a
confined, terminate-able worker with resource caps, behind a request/response message
protocol whose ONLY granted capability is the host-API proxy.

```ts
export interface ModuleHostOptions { timeoutMs: number; maxOldGenerationSizeMb?: number; stackSizeMb?: number; }
export interface InvokeRequest { absModulePath: string; epoch: number; exportKind: "actions"|"routes"; member: string; ctx: SerializableCtx; arg: unknown; }
export class ModuleHost {
  constructor(opts: ModuleHostOptions);
  /** Run member in a confined worker; terminate on timeout → ActionError(504). */
  async invoke(req: InvokeRequest): Promise<unknown>;
  dispose(): void;
}
```

**Confinement (the real model — not "a bare worker_threads is a sandbox"):**

- **Empty env:** start the worker with NO inherited environment —
  `new Worker(bootstrapPath, { env: {}, workerData, resourceLimits, execArgv })`. The
  worker holds no gateway token and no secret (those live only in the parent process env).
- **Module-load deny-hook (runs BEFORE the pack module):** `bootstrapPath` is a confinement
  bootstrap that installs a loader/require interception (`module.register` /
  `Module._load` proxy / loader hook) which **denies** the pack module graph access to
  `node:fs`, `node:child_process`, `node:net`, `node:http`, `node:https`,
  `node:worker_threads`, and `node:process` (beyond a frozen minimal shim). It also
  freezes/removes dangerous globals before the pack module is imported. After installing
  the hook, the bootstrap dynamic-`import()`s the pack module (the SAME epoch-cache-busted
  URL the dispatcher builds, `action-dispatcher.ts:loadModule`).
- **Host-API-proxy-only capability:** the ONLY capability the pack code is handed is the
  `ctx.host` proxy over the parent `MessagePort`. Host calls that touch server state
  (`store` / `session`) are marshalled to the parent and authorized there (the worker has
  no ambient `process`/gateway access — v1 §5 isolation).
- **Message protocol:** parent posts `{absModulePath, epoch, member, ctx, arg}`; the
  bootstrap invokes `module[exportKind][member](ctx, arg)` and posts `{ok,result}` or
  `{error}`; host-API calls flow back over the same channel as request/response frames.

**Resource caps & the CPU control:**

- **Memory:** `new Worker(..., { resourceLimits: { maxOldGenerationSizeMb, stackSizeMb } })`.
- **CPU / wall-time (the explicit CPU-cap mapping):** **The goal's "CPU caps" requirement
  is satisfied by terminate-on-timeout (wall-time termination)** — `worker_threads` provides
  no per-core CPU throttle, so a runaway CPU loop is bounded by *killing the worker on
  timeout*. The parent races a timer and on timeout calls `worker.terminate()` (TRUE
  cancellation, unlike Phase 1's permit-hold), rejecting `ActionError(504)`. A runaway
  `while(1)` is *killed* by the timeout. **Memory caps are via `resourceLimits`.** This is
  the binding acceptance statement for the CPU-cap criterion (acceptance #3): wall-time
  termination IS the CPU-cap control — there is no claim of a CPU quota that
  `worker_threads` cannot deliver.

**No shippable residual-access fallback (NON-NEGOTIABLE).** Built-in / process / network
denial and no-ambient-access (except through the host-API proxy) are a **mandatory C3
acceptance requirement** — not a best-effort target with a weaker floor. There is NO
shippable configuration in which a pack module can `require`/import `node:fs`,
`node:child_process`, or network built-ins, or read `process.env` secrets. If the chosen
Node module-load deny-hook proves infeasible in the target Node version, an **alternative
isolation mechanism is REQUIRED before C3 can pass** — e.g. a restricted child-process
runtime (separate process with a deny-by-default module graph) or a stricter loader. The
no-ambient-access boundary is not negotiable and has no fallback that leaves residual
access.

A configuration with only terminate-on-timeout + memory caps + empty-env but WITHOUT
built-in/process/network denial is, at most, a NON-ACCEPTANCE interim milestone (a blocker
state for tracking incremental progress) — it explicitly does NOT satisfy goal acceptance
#3/#4 and must never be shipped as the Phase-2 end state.

### C3.3 Migration onto the SINGLE invocation seam

Phase 1 left exactly one invocation seam: `return await handler(ctx, args)` in
`ActionDispatcher.dispatch` (`action-dispatcher.ts`, "SINGLE invocation seam (design §5
iv)"). C3 replaces that one line with `return await this.moduleHost.invoke({...})` —
**callers unchanged**. The shared dispatcher base (B3.1) means actions + routes ride the
same seam (stores have no pack module, so they are not on this seam). Behind a config flag
(default on) so it can be disabled if a pack needs in-process for debugging.

---

## 10. Slice D1 — artifacts-as-pack (litmus)

**Deps:** B4 (panels), B1 (stores), renderer (Phase 1). Proves a built-in re-expressed as a
pack with parity.

### D1.1 Pack layout

`market-packs/artifacts/` (new built-in-shipped market pack; lives beside the existing
`tests/fixtures/market-sources/retry-demo-src/retry-demo` fixture pattern). Contributes:

- `renderer:` — the inline artifact pill, re-expressed from
  `src/ui/tools/artifacts/ArtifactPill.ts` + `artifacts-tool-renderer.ts` as a pre-built
  ESM factory renderer (host toolkit + `isCustom:true` full-surface pill).
- `panels:` — `artifacts.viewer`, re-expressed from `ArtifactElement.ts` + the per-type
  artifact components (`HtmlArtifact`/`MarkdownArtifact`/…). Opened via
  `host.ui.openPanel({ panelId: "artifacts.viewer", params: { artifactId } })`.
- `stores:` — replaces `persistPreviewArtifact`/`restorePreviewArtifact`
  (`src/server/preview/artifacts.ts:73`/`:165`): `host.store.put(artifactId, payload)` /
  `host.store.get(artifactId)`. Restore-by-id across reload becomes `store.get` +
  `openPanel` (v1 §6.1 — no bespoke `/api/preview/artifacts/:id/restore` route).

### D1.2 Test adaptation + deletion

Adapt existing artifact tests to drive the pack. Once parity is proven (E2E green), the
bespoke paths — `src/ui/tools/artifacts/*`, `src/server/preview/artifacts.ts` persist/restore
— are **deleted in a staged deletion PR** (acceptance allows "deletion PR demonstrably
ready"). The deletion is a separate task gated on D1 parity E2E green.

---

## 11. Slice D2 — pr-walkthrough-as-pack (litmus, maximal case)

**Deps:** B4, B3, B1, C1, **C2** (`session.readToolCall` — D2 consumes session reads, so
it depends on the slice that FLIPS the `session` flag, not merely on the B2 body slice;
see the §0 capability-signaling convention). Uses ALL reserved keys.

### D2.1 Pack layout

`market-packs/pr-walkthrough/` contributes:

- `panels:` — `pr-walkthrough.panel`, re-expressed from
  `src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts`. Opened via
  `host.ui.openPanel({ panelId, params: { jobId } })`.
- `routes:` — re-express `handlePrWalkthroughApiRoute` (`src/server/pr-walkthrough/routes.ts`,
  wired at `server.ts:2268`) as a pack `routes.js` module. The viewer loads its
  changeset/diff bundle via `host.callRoute("bundle", { query: { jobId } })` — which POSTs
  `/api/ext/route/bundle` with `tool=<pr-walkthrough tool>`; the server derives the pack
  from that tool and dispatches the pack's OWN `routes.js` (B3.2). NEVER a raw fetch
  (v1 §6.2).
- `stores:` — re-express `walkthrough-store.ts`
  (`WALKTHROUGH_STORE_SCHEMA_VERSION`, job/changeset state) onto `host.store.*`,
  pack-scoped.
- `entrypoints:` — git-widget button / command-palette launcher →
  `host.ui.navigate({ route: "pr-walkthrough", params: { jobId } })` (the SPA already has
  the `"walkthrough"` route — `routing.ts:5`/`:47`).
- `host.session.readToolCall` — read the `submit_pr_walkthrough_yaml` tool call's
  input/output (B2 implements the body; usable here only once C2 flips the `session` flag)
  instead of bespoke transcript access. The panel-originated read is authorized via
  `authorizeScopedRequest` (§2a), so it needs no owned `toolUseId`.

### D2.2 Test adaptation + deletion

Adapt PR-walkthrough tests + `tests/e2e/ui/extension-host.spec.ts` pattern. Stage deletion
of `src/ui/components/pr-walkthrough/`, `src/server/pr-walkthrough/routes.ts` bespoke
dispatch, and `defaults/tools/pr-walkthrough/` once parity E2E is green.

---

## 12. Wave / ownership plan

Each task owns its NEW files exclusively. Shared-file edits (§1) are serialized: at most one
task per YES-file in flight; the team-lead rebases the next on merge.

### Wave 0 (optional refactor, A-owned, before B4)
- **T0** Extract `makeGenerationGuardedRegistry()` from `renderer-registry.ts` IF B4 wants
  to share it. Owns: `renderer-registry.ts` (sole editor). Otherwise skip (B4 mirrors).

### Wave 1 — Foundation
- **A** pack identity + scoped authz (§2a). New: `pack-identity.ts`. Shared:
  `action-guard.ts` (add `authorizeScopedRequest`), `server-host-api.ts` (add
  packId/contributionId), `server.ts` (thread into action endpoint `:5216`),
  `tool-contributions.ts` (no-op or prep). Threads `packTool` through `types.ts` +
  `Messages.ts`/`ToolGroup.ts` + client `host-api.ts` signature; defines the
  panel/entrypoint host-context binding (§2a.2) the B/C slices consume.
  *Must land + test before any B slice.*

### Wave 2 — Capability slices (parallel after A, serialized on shared files)
- **B1 stores.** New: `pack-store.ts`. Shared: `server.ts` (+store endpoint),
  `server-host-api.ts` (store body + flag), `tool-contributions.ts` (`parseStores`),
  client `host-api.ts` (store body + flag).
- **B2 adapter + reads.** New: `contract-adapter.ts`. Shared: `server.ts` (+2 GET
  endpoints), `server-host-api.ts` (session read bodies), client `host-api.ts` (session
  read bodies).
- **B3 routes.** New: `route-dispatcher.ts`. Shared: `server.ts` (+route endpoint +
  `invalidateResolverCaches` line `:2247` + construct near `:863`),
  `tool-contributions.ts` (`parseRoutes`), client `host-api.ts` (callRoute body + flag).
- **B4 panels.** New: `pack-panels.ts`. Shared: `server.ts` (+panel GET endpoint),
  `tool-contributions.ts` (`parsePanels`), client `host-api.ts` (openPanel body). Touches
  `panel-workspace.ts` (single-owner for B4). Does NOT edit `renderer-registry.ts`.

  *Shared-file serialization order suggestion:* `tool-contributions.ts` B1→B3→B4;
  `host-api.ts` B1→B2→B3→B4; `server.ts` B1→B2→B3→B4; `server-host-api.ts` B1→B2.

### Wave 3 — after B
- **C1 entrypoints + navigate.** New: `pack-entrypoints.ts`. Shared: `host-api.ts`
  (navigate body + flip `flags.ui`), `tool-contributions.ts` (`parseEntrypoints`),
  `routing.ts` (single-owner), `server.ts` (entrypoint metadata if needed). Deps: B4, B3.
- **C2 session writes.** Shared: `server.ts` (+message endpoint), `server-host-api.ts`
  (postMessage body + flip `flags.session`), client `host-api.ts` (postMessage/subscribe +
  flip `flags.session`). Deps: B2.
- **C3 isolation.** New: `module-host-worker.ts` (+ confinement bootstrap). Edits the
  single seam in `action-dispatcher.ts` (+ shared dispatcher base from B3) — single-owner
  of the seam line. Deps: B3 (routes) + the action baseline. Isolates **actions + routes
  only** (stores run no pack code).

### Wave 4 — Litmus (after their deps)
- **D1 artifacts pack.** New: `market-packs/artifacts/`. Deps: B4, B1. + staged deletion PR.
- **D2 pr-walkthrough pack.** New: `market-packs/pr-walkthrough/`. Deps: B4, B3, B1, C1,
  **C2** (session-read flag flip). + staged deletion PR.

No two concurrent tasks own the same NEW file; the only contention is the five §1 shared
files, all serialized above.

---

## 13. Per-slice test list (maps to acceptance)

Unit tests prefer `file://` fixtures + the existing `tests/fixtures/market-sources/`
pattern (extend `retry-demo-src` or add per-slice fixture packs). E2Es follow
`tests/e2e/ui/extension-host.spec.ts`.

| Slice | Test (file) | Asserts | Accept # |
|---|---|---|---|
| A | `extension-host-pack-identity.test.ts` | packId derived from market-pack baseDir segment; non-pack → empty; caller `args`/`packId` cannot override server-derived id; cross-pack denial precondition; `authorizeScopedRequest` accepts a request with NO toolUseId but still enforces session-binding + allowedTools, and rejects body/header session mismatch | 2,4 |
| B1 | `extension-host-pack-store.test.ts` | put/get/list round-trip; keys namespaced under `<packId>/`; a second pack cannot read first pack's key (cross-pack read rejected); key traversal (`../`) rejected; non-pack rejected; guard ordering via `authorizeScopedRequest` (allowedTools → identity; succeeds without toolUseId) | 2,4 |
| B2 | `extension-host-contract-adapter.test.ts` | JSONL rows → `HostMessage`/`HostContentBlock`/`ToolCallRecord`; both tool_use shapes mapped; `CONTRACT_VERSION === HOST_CONTRACT_VERSION`; unknown block types tolerated; read scoped to own session (other session id has no parameter) | 2,4 |
| B3 | `extension-host-route-dispatcher.test.ts` | route resolution + precedence (pack shadows builtin); namespace-by-construction (`tool` → server-derived pack; dispatch hits ONLY that pack's `routes.js`; no `<pack>` URL segment to forge); `authorizeScopedRequest` reuse (no toolUseId required); epoch cache invalidation | 2,4 |
| B4 | `pack-panels-reconcile.spec.ts` (`file://`) | panel loader registers/reconciles; reload survival (re-driven from metadata); uninstall reconcile (generation-guarded); override; theme-token + sandbox conventions present | 2,4 |
| C1 | `pack-entrypoints.spec.ts` | entrypoint kinds register; `navigate(RouteTarget)` maps to router view (no hash baked in pack); no auto-invoke on mount | 2,4 |
| C2 | `extension-host-session-write.test.ts` | postMessage authorized against header-bound session; resumeTurn vs non-resume; every post audited; cross-session post impossible | 2,4 |
| C3 | `extension-host-module-isolation.test.ts` | a `while(1)` spin is terminated on timeout (terminate-on-timeout IS the CPU control); `resourceLimits` memory cap rejects oversized alloc; **a pack module CANNOT `require`/import `node:fs`/`node:child_process`/network built-ins** (deny-hook); **a pack module CANNOT read `process.env` secrets** (empty-env worker); crash isolated → error not process death; seam swap leaves callers unchanged | 3 |
| — | `tool-contributions.test.ts` (extend) | formerly-reserved keys now PARSED+TYPED (panels/routes/stores/entrypoints) and ACT (wire fields populated); malformed still degrades, never rejects | 2 |
| — | `host-api-v1-frozen.test.ts` (extend/add) | `HOST_API_VERSION===1` unchanged; v1 types compile unchanged; capabilities flip per host | 2 |
| — | existing `pack-marketplace.test.ts` / budget tests | `buildPackList` byte-identical; tool-description budget; AGENTS budget | invariants |
| **D1** | `tests/e2e/ui/artifacts-pack.spec.ts` (**mandatory E2E**) | install → inline pill renders → open viewer panel → persist across reload (store) → uninstall reconciles | **1** |
| **D2** | `tests/e2e/ui/pr-walkthrough-pack.spec.ts` (**mandatory E2E**) | install → entrypoint launches → panel renders from pack `callRoute` (`/api/ext/route/bundle` with `tool`) + store → `readToolCall` after `session` flag live → deep-link route → uninstall | **1** |

Gate: `npm run check`, `npm run test:unit`, `npm run test:e2e` green; the two litmus E2Es
are the acceptance proofs.

---

## 14. Acceptance criteria (from the goal) → satisfying slice

1. **Both built-ins ship as installable packs with behavioral parity; bespoke paths
   deleted (or deletion PR ready).** → **D1** (artifacts) + **D2** (pr-walkthrough), each
   with its mandatory E2E and a staged deletion PR gated on parity.
2. **Every reserved key live; every frozen Host API method implemented to v1 signature;
   `host.capabilities` all true; `HOST_API_VERSION` still 1 (v1 type compiles unchanged).**
   → `stores` (B1), `routes` (B3), `panels` (B4), `entrypoints` (C1); `store.*` (B1),
   `session.*` reads (B2) + writes (C2), `callRoute` (B3), `ui.*` openPanel (B4) +
   navigate (C1). Flags: `store`→B1, `callRoute`→B3, `ui`→C1, `session`→C2. Pinned by the
   v1-frozen compile test.
3. **Pack server modules (actions + routes) run in worker isolation with
   terminate-on-timeout + caps, and no ambient access.** → **C3** (`module-host-worker.ts`,
   `worker_threads` + empty env + module-load deny-hook + host-API-proxy-only +
   `terminate()` + `resourceLimits`), migrated onto the single `ActionDispatcher.dispatch`
   seam. **Built-in/process/network denial + no-ambient-access (except via the host-API
   proxy) is a MANDATORY, non-optional requirement of this criterion** — a pack module
   cannot import `node:fs`/`node:child_process`/network built-ins or read `process.env`
   secrets. There is NO shippable fallback that leaves residual access; if the deny-hook is
   infeasible an alternative isolation mechanism (restricted child-process runtime / stricter
   loader) is REQUIRED before C3 passes (§9). **The "CPU caps" requirement is satisfied by
   terminate-on-timeout (wall-time termination)** — `worker_threads` has no per-core throttle,
   so a runaway CPU loop is bounded by killing the worker on timeout; **memory caps via
   `resourceLimits`.** Stores run no pack code (no pack-supplied store-handler module — see
   §9), so the spec's "store handlers" phrase has no surface to isolate; C3 isolates actions
   + routes, the only pack-supplied server modules.
4. **A third-party pack could implement any surface using only public contributions + the
   Host API — no privileged escape hatch.** → guaranteed by routing the tool-call-scoped
   capabilities (`invokeAction`, `session.postMessage`) through `authorizeActionRequest`
   and the pack-scoped capabilities (`store`/`callRoute`/`session.read*`) through
   `authorizeScopedRequest` (§2a), both keyed off the **server-derived** pack identity (A) —
   never a caller field; `callRoute`'s namespace is the pack derived from the proven `tool`
   (B3.2 — no forgeable URL segment); `store` keys pack-namespaced (B1.1); no `gateway.fetch`
   reintroduced. Pinned by the cross-pack denial + namespace unit tests.

---

## 15. Security recap (the Host API stays the single boundary)

- The pack-scoped capabilities (`store`/`session.read*`/`callRoute`) call
  `authorizeScopedRequest` (§2a — the action guard MINUS toolUseId-ownership) FIRST, then
  key off the **server-resolved** `packId` (A) — never a caller field. The tool-call-scoped
  capabilities (`invokeAction`, `session.postMessage`) keep the full
  `authorizeActionRequest` (`action-guard.ts:53`, incl. toolUseId-ownership). `callRoute`'s
  reachable namespace is the pack the server derives from the proven `tool` — there is no
  `<pack>` URL segment to forge (B3.2); `store` keys are pack-namespaced with
  path-traversal re-validation (B1.1).
- `session.postMessage`/resume (C2) is highest-risk: user-gesture-only, header-bound
  session, every post/resume audited. Panel/entrypoint-originated calls bind their host
  context (`sessionId`/`packTool`) from the opening context (§2a.2) and CANNOT reach
  `postMessage`/`invokeAction` without a real user-gesture `toolUseId`.
- `panels`/`entrypoints` (B4/C1) run on the main UI thread over LLM-influenced data: iframe
  `sandbox` preserved, theme tokens only, no auto-invoke/navigation on mount.
- Server-module isolation (C3, actions + routes only) bounds blast radius:
  terminate-on-timeout (the CPU control, satisfying the "CPU caps" criterion), memory
  `resourceLimits`, empty-env worker, and a module-load deny-hook. **No-ambient-access
  (no `process`/gateway/fs/network access except through the host-API proxy channel) is a
  MANDATORY, non-negotiable boundary** — there is no shippable fallback that leaves residual
  access; if the deny-hook is infeasible an alternative isolation mechanism is required
  before C3 passes (§9). (No pack-supplied store-handler module exists, so the store path
  has no pack code to isolate.)

---

## 16. Documentation deliverables

The goal requires three docs to land alongside the code (owned by the workflow
**documentation gate / docs-writer**, not by a capability slice). They are part of
acceptance, not optional.

1. **`docs/design/extension-host.md` — status flip + new notes.** The v1 SIGNATURES/types
   stay **byte-identical** (frozen). Only the §3/§6 prose **status notes** change: as each
   capability lands, flip its "frozen, not implemented" note to "implemented" (a status
   edit, never a contract change). Add a short note on the internal→contract **adapter
   layer** (B2.1) and the **server-module isolation model** (C3: empty-env worker +
   deny-hook + host-API-proxy-only + terminate-on-timeout). This reconciles the
   top-of-doc caveat: "do not change v1 signatures; §3/§6 status notes are flipped to
   'implemented' as capabilities land."
2. **`docs/extension-host-authoring.md` — extend** with authoring guidance for
   `panels`/`stores`/`routes`/`entrypoints` + `host.session.*`, plus the **two migration
   case studies** (artifacts-as-pack D1, pr-walkthrough-as-pack D2).
3. **`docs/marketplace.md` — threat model update** for `routes`/`stores`/`panels`/
   `session`-write + the worker isolation model (terminate-on-timeout as the CPU control,
   empty-env, deny-hook, host-API-proxy-only; the `authorizeScopedRequest` vs
   `authorizeActionRequest` split).

Each deliverable maps to the workflow's documentation gate; the docs-writer signals it once
the corresponding capabilities have merged.
