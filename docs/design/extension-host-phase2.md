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
  `invokeAction` (the ONLY tool-call-scoped capability) keeps the full
  `authorizeActionRequest` (incl. toolUseId-ownership) verbatim. The pack-scoped
  capabilities (`store` / `session.read*` / `callRoute` / `session.postMessage`) route
  through a new `authorizeScopedRequest()` — the SAME guard MINUS the toolUseId-ownership
  step (§2a). `session.postMessage` adds a MANDATORY client user-gesture token + audit on
  top of the scoped guard (it has no owned `toolUseId` when originated from a
  panel/entrypoint). This is not a weakening of the action guard; it is the correct
  narrower authz for calls where no specific tool call is being acted on.
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

## 0a. Trust model — code ORIGIN is the boundary (binding)

Phase 2's security model rests on a single distinction: **the trust boundary is code
ORIGIN, not the thread a piece of code runs on.** Pack code installed from the market is
*trusted* (the same tier as a tool or an MCP server the user chose to install); content
produced by the agent/LLM at runtime is *untrusted*. The three surfaces split accordingly:

- **Pack UI code — renderers (`renderer:`), panels (`panels:`), entrypoints
  (`entrypoints:`) — is TRUSTED and runs in the MAIN UI THREAD.** It is authored by the
  pack, reviewed at install, and may touch app globals (it shares the realm). This is an
  accepted Phase-2 scope decision (goal security model): pack UI is not adversarial code to
  be sandboxed away from the app; it is trusted code whose blast radius is bounded by the
  Host API being its only privileged surface. (Full realm-isolation of pack UI is a
  documented future hardening — §8 C2.) 
- **Agent/LLM-influenced CONTENT is ALWAYS rendered in a sandboxed iframe** (theme tokens
  only, no auto-invoke / navigation on mount). The pack UI decides *what* to render, but
  the untrusted *payload* (model output, transcript text, artifact HTML) is confined to the
  `sandbox`-attributed iframe — so a prompt-injected artifact cannot reach app globals even
  though the pack panel that frames it can.
- **Pack SERVER modules (`actions:` / `routes:`) are TRUSTED but run LEAST-PRIVILEGE by
  default.** They run in the C3 confined `worker_threads` worker (terminate-on-timeout,
  memory caps, module-import containment) and start with NO ambient OS capability. A pack
  may OPT IN to a narrow set (`git`/`fs`/`net`) via a manifest `permissions:` declaration
  (§9 C3.4) — a *declared, audited, server-resolved, default-deny* capability grant, never
  an ambient escape hatch.

The Host API remains the single privileged boundary for everything CROSS-pack, cross-
session, or UI-driving (`store`/`session`/`callRoute`/`ui.*`) — those stay typed, scoped,
server-authorized methods keyed off the server-resolved pack identity (§2/§2a). What the
declared-permission model adds is a way for a pack's OWN server module to reach OS
capabilities (git/fs/net) on ITS OWN behalf — bounded, declared, and killable — without
punching a hole in the cross-pack Host-API boundary.

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
| D1 | artifacts-as-pack (litmus) | — | renderer+panels+stores+navigate (C1, deep-link) | `market-packs/artifacts/` |
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
`toolUseId` (`transcriptHasToolUse`, `:106`). But `store.*`, `callRoute`,
`session.read*`, and `session.postMessage` are **pack-scoped**, not tool-call-scoped — no
specific prior tool call is being acted on (driving an agent turn does not act on one), and
a panel/entrypoint may originate the call with no owned `toolUseId` at all. For these,
`toolUseId`-ownership is the wrong check. (`session.postMessage` layers a MANDATORY client
user-gesture token + audit on top of the scoped guard — §8 C2.1.)

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
| `invokeAction` (Phase 1) | `authorizeActionRequest` | **required** (unchanged — the ONLY tool-call-scoped capability) |
| `store.*` (B1) | `authorizeScopedRequest` | not required |
| `callRoute` (B3) | `authorizeScopedRequest` | not required |
| `session.read*` (B2) | `authorizeScopedRequest` | not required |
| `session.postMessage` (C2) | `authorizeScopedRequest` + MANDATORY client user-gesture token | not required (panels/entrypoints have none; driving a turn acts on no prior tool call) |

### 2a.2 Panel / entrypoint host context binding

A renderer's host API is built `getHostApi(sessionId, toolUseId, packTool)` (A.3). A panel
or entrypoint has no tool call, so it binds `{ sessionId, packTool, packId, contributionId }`
from the **opening context**:

- A **renderer** that opens a panel carries `sessionId` + `packTool` already; it passes
  them to `openPanel`, and the panel host API is built `getHostApi(sessionId, undefined,
  packTool)` — `toolUseId` is `undefined`.
- An **entrypoint** carries `packTool` from its own contribution; the active session
  supplies `sessionId`. Same `getHostApi(sessionId, undefined, packTool)`.

So a panel/entrypoint CAN call `store.*` / `callRoute` / `session.read*` **and**
`session.postMessage` — all four route through `authorizeScopedRequest`, which needs no
`toolUseId`. `session.postMessage` additionally requires a genuine client user-gesture
token (C2.1) and is audited, so a panel/entrypoint may drive an agent turn ONLY from a real
user gesture (no auto-post on mount, v1 §5 v) — but it is no longer blocked by the
inapplicable toolUseId-ownership check. The ONLY capability a panel/entrypoint cannot reach
is `invokeAction` (the lone tool-call-scoped capability, which keeps
`authorizeActionRequest` + toolUseId-ownership because it acts on a specific prior tool
call). This does NOT weaken security: `invokeAction`'s full guard is unchanged, and
`postMessage` stays allowedTools-gated + header-bound + gesture-required + audited. This
also closes the D2 gap where a panel-originated `callRoute`/`store`/`readToolCall`/
`postMessage` had no owned `toolUseId` to satisfy the action guard.

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
   (`pattern` is a LITERAL, case-insensitive SUBSTRING filter — NOT a regex: the
   caller-controlled string is never compiled with `new RegExp(...)`, closing a
   catastrophic-backtracking ReDoS vector; the frozen `pattern?: string` type is
   contract-conformant either way — see `buildTranscriptEnvelope`)
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
`ActionDispatcher` (epoch cache + timeout + single invocation seam), plus a **pack-level
route registry** that deterministically maps `(packId, routeName) → declaring tool`.

```ts
export type RouteHandlerCtx = ActionHandlerCtx;   // reuse: {host, sessionId, toolUseId, tool}
export type RouteHandler = (ctx: RouteHandlerCtx, req: { method: string; query?: Record<string,string>; body?: unknown }) => Promise<unknown> | unknown;
export type RoutesModule = { routes: Record<string, RouteHandler> };

export class RouteDispatcher {
  constructor(toolManager: ActionToolLocationResolver, opts?: ActionDispatcherOptions);
  invalidate(): void;          // wired into invalidateResolverCaches (server.ts:2247)
  async dispatch(tool: string, name: string, ctx: RouteHandlerCtx, req: ..., resolver?): Promise<unknown>;
}

/** Pack-level route index: which tool in a pack declares which route name, and the
 *  resolved module path for that tool. Built lazily from tool metadata + cached on the
 *  project-scoped tool manager; invalidated alongside the dispatchers in
 *  invalidateResolverCaches (server.ts:2247). */
export class RouteRegistry {
  constructor(resolver: ActionToolLocationResolver);
  /** For `packId`, enumerate the pack's tools (those whose winning baseDir resolves to
   *  that packId), collect their `routes:` contributions into a single
   *  `routeName → { declaringTool, modulePath }` map (built once, cached), and look up
   *  `routeName`. Returns undefined if the pack declares no such route. */
  resolve(packId: string, routeName: string): { declaringTool: string; modulePath: string } | undefined;
  invalidate(): void;          // wired into invalidateResolverCaches (server.ts:2247)
}
```

**Reuse, not refork:** `RouteDispatcher` is structurally `ActionDispatcher` with `routes`
instead of `actions`. Extract the shared loader (epoch cache, bounded in-flight reload,
permit-held-until-settle, `runWithTimeout`) into a small base or shared helper so both
dispatchers use ONE copy — the C3 worker-isolation seam then wraps that single helper. The route
module path comes from a new `routes.module` contribution (default `routes.js`), resolved
via the same `resolveToolLocation` location as actions. `RouteRegistry` lives in the SAME
new file (no new §1 shared file); it is built lazily and cached on the project-scoped tool
manager and reuses `resolveToolLocation` to find each declaring tool's `modulePath`.

**`routes:` is PACK-scoped, not opener-tool-scoped — resolved via the registry, NOT the
opener tool's location.** The route module is selected by the server-resolved `packId`,
independent of which tool opened the surface that issued the `callRoute`. The opener
`packTool` (carried in the request body) is used ONLY to authorize the caller and derive
`packId` (B3.2 steps 1–2); the route **module** is then resolved from
`RouteRegistry.resolve(packId, name) → { declaringTool, modulePath }`, NOT from the opener
tool's `resolveToolLocation`. This removes the prior contradiction (opener-tool-scoped
module lookup vs pack-scoped intent): any panel, renderer, or entrypoint sharing that
`packId` reaches the SAME routes — a panel opened from tool X can reach a route declared on
tool Y in the same pack, because the registry indexes every routes-bearing tool in the
pack. **Deterministic conflict handling (hard rule):** a pack MUST NOT declare the same
route name on two tools; duplicates are **rejected at parse/metadata-build time** (B3.4 —
the one place a pack IS rejected for a real conflict). The registry therefore has at most
one declaring tool per `(packId, routeName)`, so resolution is unambiguous regardless of
how many tools in the pack declare `routes:`.

### B3.2 Endpoint: `POST /api/ext/route/:name` (server.ts)

There is **no `<pack>` URL segment** — the only routable namespace is the one the server
derives from the `tool` the caller proves it owns, so there is nothing to forge. Body
`{ sessionId, toolUseId?, tool, init }` (`init` = v1 `HostRouteInit`: `method`/`body`/
`query`, **no path**). Flow:

```
1. authorizeScopedRequest({...})  → header-canonical session, body===header, session
   resolves, opener `body.tool` ∈ allowedTools  (§2a; toolUseId NOT required)
   — body.tool is used ONLY to authorize the caller + derive packId (steps 1–2)
2. resolvePackIdentityForTool(sessionToolManager, body.tool) → ident  (A; server-derived)
3. reject 403 if !ident.isPack
4. routeRegistry.resolve(ident.packId, name) → { declaringTool, modulePath }
   — reject 404 if undefined (the pack declares no such route)
   — the route MODULE is resolved from the registry's declaringTool for that packId,
     NOT from the opener body.tool (this is the fix for the prior contradiction)
5. routeDispatcher.dispatch(declaringTool, name, ctx, init, sessionToolManager)
   — ctx carries the SAME packId-bound host context (identity from ident.packId, NOT the
     opener tool), so a route opened from tool X but declared on tool Y runs with the
     pack's identity, not X's
6. audit + json(result)
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

> **Accepted by the team lead.** The goal's `/api/ext/<pack>/*` is namespace *intent*;
> `POST /api/ext/route/:name` (tool → server-derived `packId`) is a deliberate,
> security-equivalent refinement — a client-supplied `<pack>` URL segment is unbuildable —
> and is ACCEPTED.

### B3.3 Wiring

- Construct `RouteDispatcher` AND `RouteRegistry` near `actionDispatcher`
  (`server.ts:863`); add BOTH `routeDispatcher.invalidate()` and
  `routeRegistry.invalidate()` into `invalidateResolverCaches` (`server.ts:2247`,
  alongside `dispatcher.invalidate()`) so a pack install/uninstall rebuilds the pack-level
  route index.
- Client `host.callRoute` body in `src/app/host-api.ts`; flip `flags.callRoute = true`.
- Server `ServerHostApi.callRoute` is NOT added (frozen server surface has no callRoute —
  server handlers reach their own routes by calling the function directly; `callRoute` is a
  CLIENT capability for renderers/panels). Confirm against v1: `ServerHostApi` (server-host-api.ts)
  has no `callRoute` member — correct, leave it.

### B3.4 `routes:` activation (`tool-contributions.ts`)

`parseRoutes(raw)` → `RouteContribution = { module?: string; names?: string[] }` (mirrors
`parseActions`, same path-safety via `isSafeRelativePath`). Add wire field
`ToolInfo.routeNames?: string[]`.

**Duplicate-route rejection (the one hard parse-time conflict).** Per-tool parsing stays
tolerant (malformed `routes:` degrades, never rejects — same as every other contribution).
But when the pack-level `RouteRegistry` for a `packId` is built (B3.1), if two tools in the
SAME pack declare the SAME route name, that is a **hard, deterministic rejection** with a
clear error naming the conflicting tools + route — packs are otherwise never rejected, so
this is the single real-conflict failure. Rejection is at metadata/registry-build time
(not per-tool parse, which cannot see other tools), guaranteeing at most one declaring tool
per `(packId, routeName)` and making `RouteRegistry.resolve` unambiguous. Cross-pack route
names never collide (the registry is keyed by `packId`).

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

One-line responsibility: register pack-contributed launchers AND deep-linkable client
routes, and resolve structured navigation targets onto the SPA router.

```ts
// Launcher kinds (click → openPanel/navigate) PLUS a routable kind that declares a
// deep-linkable CLIENT route. "route" entrypoints have NO label/click surface — they
// register a routeId→panel mapping consumed by navigate + reload restoration.
export type EntrypointKind = "composer-slash" | "git-widget-button" | "command-palette" | "route";
export interface LauncherEntrypoint { id: string; tool: string; kind: "composer-slash" | "git-widget-button" | "command-palette"; label: string; target: RouteTarget | PanelTarget; }
/** A deep-linkable client route: maps a routeId → the panel it opens + the param names
 *  carried in the URL. `routeId` is the deep-link route name; `target` is the panel to
 *  open; `paramKeys` are the param names serialized into / parsed from the hash. */
export interface RouteEntrypoint { id: string; tool: string; kind: "route"; routeId: string; target: PanelTarget; paramKeys: string[]; }
export type EntrypointInfo = LauncherEntrypoint | RouteEntrypoint;
export function registerPackEntrypoints(eps: ReadonlyArray<EntrypointInfo>, projectId?: string): void;
export function reconcilePackEntrypointsForProject(projectId: string | undefined): Promise<void>;
/** Map a structured RouteTarget → the router's hash scheme (packs never build URLs). */
export function navigateToTarget(target: RouteTarget): void;
```

### C1.1a Client pack route registry (generation-guarded, project-scoped)

The `kind:"route"` entrypoints populate a client-side **pack route registry** that lives in
`pack-entrypoints.ts` and **mirrors the `pack-renderers.ts` / `pack-panels.ts`
generation-guarded chokepoint** (do NOT fork it — copy the `applyRegistration` contract:
capture generation before any await, drop superseded applies, reconcile-on-uninstall,
project-scoped, reload-safe). The registry is keyed by `routeId`:

```ts
interface PackRouteEntry { routeId: string; targetPanelId: string; paramKeys: string[]; tool: string; projectId?: string; }
//  routeId → PackRouteEntry   (at most ONE pack owns a routeId — see conflict handling)
export function lookupPackRoute(routeId: string): PackRouteEntry | undefined;
```

- **Ownership:** entries are owned by the contributing pack (carrying `tool`/`projectId`),
  so reconcile can drop a pack's routes precisely.
- **Registration:** `registerPackEntrypoints` is idempotent + reconciling, re-driven from
  `/api/tools` metadata (byte-for-byte the `registerPackRenderers`/`registerPackPanels`
  shape). The same generation guard prevents a superseded async apply from clobbering a
  newer registration.
- **Reconcile-on-uninstall:** `reconcilePackEntrypointsForProject(projectId)` removes
  routes (and launchers) whose declaring pack is no longer installed for that project — so
  a deep-link to an uninstalled pack's route no longer resolves (mirrors panel/renderer
  uninstall reconcile).

### C1.2 `navigate` resolution + hash serialization (packs never build URLs)

`RouteTarget = { route: string; params? }` (frozen v1). `navigateToTarget({ route, params })`
maps the structured target onto the SPA router (`src/app/routing.ts`) — the pack never
constructs a `#/...` string (v1 §3 structured addressing). Concrete scheme:

- Add an **`ext` `RouteView`** to `routing.ts` alongside the existing `"walkthrough"`.
- `navigateToTarget({ route, params })` looks up the registry (`lookupPackRoute(route)`),
  filters `params` to the registered `paramKeys`, and calls the existing `setHashRoute`
  helper to serialize **`#/ext/<routeId>?<url-encoded params>`** (e.g.
  `#/ext/artifacts?artifactId=abc123`). `routeId` and each `paramKey`/value are
  `encodeURIComponent`-escaped; only declared `paramKeys` are emitted.
- If `route` is not in the registry, `navigate` is a no-op (the pack named an unknown
  route — no crash, no raw URL).

### C1.2a Reload restoration (`#/ext/<routeId>` → panel rehydrated from store)

On load (and on hashchange), `getRouteFromHash` (`routing.ts`) detects the `ext` RouteView
and parses `#/ext/<routeId>?<params>` into `{ view: "ext", routeId, params }`. The app's
route handler then:

1. `lookupPackRoute(routeId)` → `{ targetPanelId, paramKeys }` (no entry ⇒ ignore; the
   owning pack may be uninstalled).
2. Filters the parsed query to `paramKeys` and calls
   `openPackPanel({ panelId: targetPanelId, params })` (B4 §6.3).
3. The panel **rehydrates its content from `host.store.get(...)`** (B1) using the id param
   (e.g. D1's `artifactId`) — the deep-link carries only ids, never payload, so a fresh
   load reconstructs the panel identically and reload survives.

This end-to-end flow (`navigate` → `#/ext/<routeId>?params` → `getRouteFromHash` → registry
lookup → `openPackPanel` → `store.get`) is the canonical deep-link path D1/D2 reuse.

### C1.3 Entrypoint surfaces

- **composer-slash:** register a slash-command into the composer's command list.
- **git-widget-button / command-palette:** register a button/launcher; on click →
  `openPanel` or `navigate` (NO auto-invoke on mount — invocation is the user gesture).
- **route:** registers a deep-linkable route only (no clickable surface); consumed by
  `navigate` + reload restoration (C1.2/C1.2a).

### C1.4 `entrypoints:` activation (`tool-contributions.ts`)

`parseEntrypoints(raw)` → typed `EntrypointContribution[]` (validate `kind` enum; for
launcher kinds require `label` + structured `target`; for `kind:"route"` require
`routeId` + `target.panelId` + a string-array `paramKeys`). Wire field
`ToolInfo.entrypoints?: EntrypointContribution[]`. Per-tool parsing stays tolerant
(malformed degrades, never rejects).

**Duplicate `routeId` rejection (hard, deterministic — mirrors B3.4 `RouteRegistry`).**
At metadata/registry-build time, if two packs (or two tools) declare the SAME `routeId`,
that is a **hard rejection** naming the conflicting packs/tools + routeId — at most ONE
pack owns a `routeId`, so `lookupPackRoute` is unambiguous. (Like B3's server route names,
this is the rare real-conflict failure; per-tool parse stays tolerant because it cannot see
other tools/packs — the conflict is only visible at registry build.)

---

## 8. Slice C2 — `host.session` WRITES (`postMessage` + `subscribe`)

**Deps:** B2 (reads). **Flag:** `session` flips `true` here. **Highest-risk slice.**

### C2.1 Transport: the TRUSTED session WebSocket (NOT a fetch)

> **Revision (session-write hardening).** Earlier revisions of this slice shipped
> `host.session.postMessage` as `POST /api/ext/session/message` carrying an unforgeable
> per-session `x-bobbit-session-secret` header (delivered to trusted UI over the WS, held
> in a client closure). That surface was **vulnerable**: a same-realm pack can
> monkey-patch `window.fetch`, CAPTURE the secret header during one legitimate
> user-gesture post, then REPLAY it without a gesture — exfiltrating the secret. The HTTP
> endpoint + the per-session secret + the exported secret getter have been **removed**.
> The session WRITE now rides the app's already-authenticated session WebSocket; the
> sections below describe the implemented design.

`host.session.postMessage` DRIVES the agent, so it is the highest-risk Host-API addition.
Its **transport** is now the app's already-authenticated session **WebSocket**, not a
`fetch`:

- Client: `host.session.postMessage(msg)` → `postSessionMessageOverWs(...)`
  (`src/app/session-write-bridge.ts`) → the per-session `RemoteAgent`'s WS-bound poster,
  which sends an `ext_session_post` frame and awaits a correlated `ext_session_post_result`
  ack (`src/app/remote-agent.ts`). The WS object is a **private field of `RemoteAgent`** —
  pack code has **no handle to it and cannot send on it**, and pack renderers/panels are
  Blob-URL modules that **cannot import** `session-write-bridge.ts` (the `host` object is
  their only surface). So there is **no session secret on any `fetch`** for a pack to
  monkey-patch/capture/replay, and **no fetch path** to the capability at all.
- Server: the WS handler (`src/server/ws/handler.ts`, `case "ext_session_post"`) runs the
  pure `handleSessionPost` (`src/server/extension-host/session-write.ts`) with the
  connection's **own server-authenticated `sessionId`** as the trusted target.

**Server-side guard ordering (pack-scoped, trusted-session, permit-gated, audited):**

```
1. authorizeScopedRequest({tool, sessionId(trusted), …}) → session resolves +
   the pack's `tool` ∈ allowedTools  (§2a)
   — NOT authorizeActionRequest: driving an agent turn does not act on a specific prior
     tool call, so toolUseId-ownership is the WRONG check and toolUseId is NOT required.
     This lets a panel/entrypoint (which binds toolUseId:undefined) call postMessage.
   — The session is the WS connection's OWN authenticated id (never a frame field), so the
     body===header invariant holds trivially and cross-session posting is impossible.
2. require role ∈ {user,system}; reject empty text
3. SERVER-derive the packId from `tool`; reject a non-pack caller
3b. REQUIRE the server-minted, one-time, content-bound write permit (§C2.1b):
    recompute contentHash = sha256(role + "\n" + text); consumeWritePermit(nonce,
    {sessionId(trusted), packId(derived), tool, contentHash}); reject (NO post) if the
    nonce is missing / unknown / expired / already-consumed / binding-mismatched.
4. role-aware delivery into the TRUSTED bound session ONLY (cross-session impossible):
   - "system" → framed as a system directive (<system-reminder>…</system-reminder>) so
     it is NOT silently delivered as raw user text (formatSessionMessage)
   - "user"   → delivered verbatim
   then by resumeTurn:
   - resumeTurn !== false → sessionManager.enqueuePrompt(sessionId, text, {source:"extension"})
   - resumeTurn === false → sessionManager.deliverLiveSteer(sessionId, text, {source:"extension"})
5. AUDIT every post/resume: {tool, packId, sessionId, role, resumeTurn, ms}  (mandatory — v1 §5 C2)
6. reply ext_session_post_result {ok}
```

### C2.1b Server-minted, one-time, content-bound write permit (closes same-realm replay)

The trusted-WS transport (§C2.1) removed the *secret-exfiltration* vector but did **not**
close the same-realm *forge/replay* vector: a same-realm pack can still monkey-patch
`WebSocket.prototype.send` (or capture the live socket) and FORGE or REPLAY an
`ext_session_post` frame — e.g. capture one legitimate gesture-driven post and resend it
later with no gesture. This is closed by a server-minted permit
(`src/server/extension-host/session-write-permit.ts`):

- **Two trusted-WS round-trips.** After the client's *synchronous* transient-activation
  assertion passes, `host.session.postMessage` computes `contentHash = sha256(role + "\n" +
  text)` (SubtleCrypto) and the poster:
  1. sends `ext_session_write_permit {tool, contentHash}`; the server derives the packId,
     `mintWritePermit({sessionId(trusted), packId, tool, contentHash})` (short TTL ~5s), and
     replies `ext_session_write_permit_result {nonce}`;
  2. sends `ext_session_post {tool, role, text, resumeTurn, nonce}`; the server recomputes
     `contentHash` from the posted role+text and `consumeWritePermit(nonce, binding)` —
     single-use, all-bindings-must-match, not-expired.
- **Net.** A captured post frame **replayed** = permit already consumed → rejected; a
  **forged** post without a mint = no valid nonce → rejected; a **tampered** role/text =
  hash mismatch → rejected; each agent-drive needs a **fresh mint** (fresh activation).
- **Residual (accepted; the realm-isolation follow-up).** A pack forging the MINT itself
  *during an unrelated genuine user gesture* is inherent to the same-realm model — pack code
  shares the realm's transient-activation state and (absent realm isolation) could ride a
  real gesture to mint+post. The permit removes the replay / forge-without-mint surface;
  eliminating mint-forgery requires running pack UI in an isolated realm (the documented
  follow-up below; the server-side authorization + audit remain the durable boundary).

### C2.1c Role-aware delivery (honor `PostMessageInput.role`)

The frozen contract `PostMessageInput { role: "user" | "system" }` requires BOTH roles to
work, and a "system" message must NOT be silently delivered as raw user input. Bobbit's
runtime feeds the model via two seams (a user prompt / a steer); there is no separate
model-level system-role command. So `formatSessionMessage` injects a genuine SYSTEM message
by framing the content in an explicit `<system-reminder>…</system-reminder>` envelope — the
model unambiguously perceives it as an out-of-band system directive — while "user" is
delivered verbatim. The framing applies to the delivered text only; the permit's contentHash
and the audit record bind/record the ORIGINAL role+text.

`postMessage` drives the agent, so the target is the **trusted, WS-authenticated** session
(never a parameter) and every call is audited. Its security posture is: **trusted-WS
transport (no capturable secret, pack cannot send) + allowedTools-gated + server-derived
packId + audited + client user-activation defense-in-depth (§below)** — secure without the
inapplicable toolUseId-ownership requirement. The full action guard WITH toolUseId-ownership
is unchanged for `invokeAction` (the only tool-call-scoped capability).

**Client user-activation is defense-in-depth ("no post on mount"), not the transport gate.**
The unforgeable gate is the transport (pack code cannot reach the trusted WS); on top of it
the client adds a browser-enforced activation check:

- `src/app/gesture-context.ts` exposes `consumeGesture()`, which reads
  `navigator.userActivation.isActive` — `true` ONLY during a genuine user-gesture call
  stack (a real button click, including a pack panel's own button), `false` on mount /
  programmatic calls.
- `host.session.postMessage` calls `consumeGesture()` **synchronously** at its prologue
  (before any `await`) and **throws** `"postMessage requires a user gesture"` when it is
  false, so a render/mount-time post fails loudly. This is browser-enforced state a pack
  cannot fabricate; it is NOT a method parameter, so the frozen v1 `postMessage` signature
  is **unchanged**. (`runWithUserGesture(fn)` is retained as a thin no-op wrapper for
  existing call sites; the activation read is the load-bearing check.)
- The module holds **no per-session secret and exports no secret getter** — that
  exfiltration surface is gone.

This mirrors `invokeAction`'s "no auto-invoke on mount" property (v1 §5 v) as a checked
precondition. The server still independently authorizes + audits every post; the activation
check is client-side defense-in-depth, not the only gate. (The server uses
`authorizeScopedRequest`, not `authorizeActionRequest`, precisely so a panel/entrypoint with
no owned `toolUseId` can still post when it holds a genuine user gesture.)

**Threat-model boundary (accepted Phase-2 scope).** Per the goal's accepted model, pack
UI logic — renderers (`renderer:`) and panels (`panels:`) — runs in the **main UI thread**
(pack source is trusted; embedded untrusted content is iframe-`sandbox`ed; no auto-invoke /
navigation on mount). A same-realm pack therefore CAN monkey-patch globals like
`window.fetch` **and `WebSocket.prototype.send`**. The session-write hardening removes the
concrete surfaces that mattered: **driving the agent now goes over the trusted session
WebSocket that pack code cannot access** (no session secret rides any `fetch`), AND every
post must carry a **server-minted, one-time, content-bound write permit** (§C2.1b) so a
captured/replayed/forged/tampered `ext_session_post` frame is rejected server-side. What
remains explicitly OUT of Phase 2 scope is **FULL realm isolation** of pack UI logic
(running renderers/panels in a separate iframe/worker realm so they cannot touch app globals
at all) — which is what would close the last residual (a pack forging the permit MINT during
a genuine user gesture). That is a documented future hardening, tracked beyond Phase 2; the
server-side authorization + audit are the durable boundary regardless of client realm. (Server pack *modules* — actions/routes — ARE
worker-isolated; see §9 C3. The open item is UI-thread isolation only.)

### C2.2 `subscribe` (live typed events)

Client-side: `host.session.subscribe(event, cb)` returns an unsubscribe fn, bridging the
existing session WebSocket / event bus (`src/app/verification-event-bus.ts`,
`gate-status-events.ts` patterns) into the frozen `HostSessionEventMap` (`tool_result` /
`status` / `message`) via the contract-adapter (B2.1) so payloads are contract shapes, not
internal wire. Scoped to the bound session.

### C2.3 Wiring

- New module `src/server/extension-host/session-write-permit.ts`: `mintWritePermit` /
  `consumeWritePermit` / `computeContentHash` (in-memory, per-gateway; short TTL; single-use).
- New WS frames (`src/server/ws/protocol.ts`): `ext_session_write_permit` (+ `…_result`
  carrying the nonce) for the mint; `ext_session_post` gains a required `nonce`.
- `src/server/extension-host/session-write.ts`: `handleSessionPost` requires + consumes the
  permit (§C2.1b) and applies role-aware delivery via `formatSessionMessage` (§C2.1c).
- Client `host.session.postMessage` (trusted-WS transport, §C2.1; computes the contentHash,
  mints then posts via `RemoteAgent`) + `subscribe` bodies.
  **Flip `flags.session = true`** (reads from B2 + writes here = full namespace live).
- There is intentionally **no** `ServerHostApi.session.postMessage`: driving the agent is a
  client-gesture-originated, trusted-WS capability (Fix B). The server host's `session`
  namespace exposes reads only.
- Transport plumbing: `ext_session_post` / `ext_session_post_result` WS frames
  (`src/server/ws/protocol.ts`); server handler in `src/server/ws/handler.ts`; the pure
  authorize/validate/post/audit core in `src/server/extension-host/session-write.ts`;
  client poster + registry in `src/app/session-write-bridge.ts` (registered by
  `RemoteAgent` on auth_ok).

---

## 9. Slice C3 — server-module isolation (worker_threads)

**Deps:** the slices whose pack server modules it isolates — **actions (B-baseline) +
routes (B3) ONLY**. **No flag** (hardening). Confinement is DEFAULT-DENY with a declared,
audited `permissions:` opt-in (§C3.4 — `git`/`fs`/`net`), server-resolved, never
caller-supplied. **Store-handler scope (deliberate
interpretation):** the goal spec lists C3 as isolating "actions, routes, store handlers",
but Phase 2 has **NO pack-supplied store-handler module** — stores are host-backed KV
reached via `ctx.host.store.*`, so the spec's "store handlers" phrase has no pack-code
surface to isolate. C3 isolates **actions + routes**, which are the only pack-supplied
server modules; no required surface is left unisolated. (The store endpoint runs entirely
in the parent; no pack code runs in the store path, so there is nothing to confine.)

> **Accepted by the team lead.** C3 isolating **actions + routes only** is a deliberate,
> ACCEPTED scope interpretation — Phase 2 ships no pack-supplied store-handler module
> (stores are host-backed KV reached via `ctx.host.store.*`); if a future phase adds pack
> store handlers they ride the same isolated seam.

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
bootstrap; "isolation" in this doc means *that bootstrap + minimal (default-empty) env +
terminate/resource caps*, not the bare worker. (Declared `permissions:` additively relax
the deny-list / env per §9 C3.4 — default-deny otherwise.)

### C3.2 New file: `src/server/extension-host/module-host-worker.ts`

One-line responsibility: run a pack server module (`actions` or `routes` member) in a
confined, terminate-able worker with resource caps, behind a request/response message
protocol whose ONLY granted capability is the host-API proxy.

```ts
export interface ModuleHostOptions { timeoutMs?: number; maxOldGenerationSizeMb?: number; stackSizeMb?: number; }
export interface InvokeRequest {
  url: string;                       // epoch-cache-busted file URL the dispatcher resolved
  packRoot: string;                  // validated pack group root — confines the module graph
  epoch: number;
  exportKind: "actions"|"routes";
  member: string;
  ctx: ActionHandlerCtx;             // live host stays in the PARENT; only identity+flags cross
  arg: unknown;
  permissions?: readonly string[];   // SERVER-RESOLVED grant set (git/fs/net); empty ⇒ deny-all
  workingDir?: string;               // session cwd; the worker's REAL cwd() when git/fs granted
}
export class ModuleHost {
  constructor(opts?: ModuleHostOptions);
  /** Run member in a confined worker; terminate on timeout → ActionError(504). */
  invoke(req: InvokeRequest, timeoutMs?: number): Promise<unknown>;
  dispose(): void;                   // terminate live workers + SIGKILL their tracked child PIDs
}
```

**Confinement is DEFAULT-DENY + DECLARED-PERMISSION RELAXATION (the real model — not "a
bare `worker_threads` is a sandbox"). With no `permissions:` grant the worker is fully
confined exactly as below; each declared grant ADDITIVELY un-gates one narrow capability
(§9 C3.4).**

- **Minimal env (default empty):** the worker starts with NO inherited environment —
  `new Worker(bootstrapUrl, { env, workerData, resourceLimits, execArgv })` where `env` is
  `{}` by default (`module-host-worker.ts` `ModuleHost.invoke`). The worker holds no
  gateway token and no secret (those live only in the parent process env). When `git`/`fs`
  is granted, `env` carries ONLY `PATH` (`needsRealProcess(grants)` → `{ PATH:
  process.env.PATH }`) so the `git` binary resolves and relative reads work — still never
  the host's full env / token / secret.
- **Module-load deny+confine hook (runs BEFORE the pack module):** the worker entry
  `module-host-bootstrap.ts` installs the in-thread `module.registerHooks({ resolve })`
  hook from `confinement-loader.ts` BEFORE importing pack code. It (a) DENIES the pack
  module graph any built-in whose first path segment is in the deny-list
  (`module-host-worker.ts` `DENIED_BUILTINS`: `fs`/`child_process`/`net`/`http`/`https`/
  `http2`/`dns`/`tls`/`dgram`/`worker_threads`/`module`/`process`/`vm`/…), and (b) CONFINES
  every resolved `file:` URL to the pack's own `packRoot` (no `../` walk, absolute path,
  symlink, or ancestor `node_modules` escape — `path-guard.ts`). The deny-list is computed
  per-grant by `deniedForGrants(DENIED_BUILTINS, grants)` (`permission-grants.ts`) — each
  grant REMOVES its entries (e.g. `git` un-denies `child_process`). After installing the
  hook, the bootstrap dynamic-`import()`s the pack module (the SAME epoch-cache-busted URL
  the dispatcher builds, `action-dispatcher.ts`/`route-dispatcher.ts` `resolveModuleUrl`).
- **Ambient-global stripping (default) / declared relaxation:** `removeAmbientGlobals`
  (`module-host-bootstrap.ts`) deletes the outbound-network globals (`fetch`/`WebSocket`/
  `XMLHttpRequest`/…) and REPLACES the ambient `process` with an inert FROZEN shim (empty
  frozen env, `cwd()=>"/"`, no `exit`/`kill`/`binding`/`dlopen`). With `net` granted the
  network globals are KEPT (`keepNetworkGlobals`); with `git`/`fs` granted the process shim
  gains a REAL `cwd()` (the session `workingDir`) + a frozen `{ PATH }` env
  (`needsRealProcess`). (`process.chdir()` is unsupported in a worker, so the session dir is
  surfaced via the shim's `cwd()`, which a `git`/`fs` pack passes explicitly to
  `spawn(…,{cwd})` / fs joins.)
- **Host-API-proxy-only capability:** the ONLY ambient capability pack code is handed
  (beyond any declared grant) is the `ctx.host` proxy over the parent `MessagePort`
  (`buildHostProxy`). Host calls that touch server state (`store`/`session`) are marshalled
  to the parent and authorized there against an allowlist
  (`module-host-worker.ts` `PROXYABLE` / `invokeHostMethod`).
- **Message protocol:** parent posts `{url, epoch, exportKind, member, ctx, arg}`; the
  bootstrap validates the `actions`/`routes` export + own-property member (export-map
  validation now lives in the WORKER so the parent never imports pack code), invokes
  `module[exportKind][member](ctx, arg)`, and posts `{kind:"result", ok, value}` or an
  error; host-API calls flow back as `host-call`/`host-reply` frames; spawned children are
  reported as `child-spawn`/`child-exit` frames (§9 C3.4).

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
- **Spawned-child reaping (declared `git`):** `worker.terminate()` reaps the THREAD but NOT
  OS child processes a `git`-granted handler spawned (they are children of the MAIN gateway
  process). `ModuleHost` tracks each child PID (reported as `child-spawn`/`child-exit`
  frames; the worker wraps the async `child_process` spawn surface via `createRequire`
  before the pack imports it) and on terminate-on-timeout / `dispose()` SIGKILLs any
  still-running child (`killChildren`), so a runaway `git` cannot outlive the wall-time cap.

### C3.4 Declared-permission grant model (REPLACES "no ambient access")

The earlier revision specified an ABSOLUTE no-ambient-access worker — a pack server module
could reach nothing but the host-API proxy. The merged model is **least-privilege by
default with a declared, audited opt-in**: the default is still deny-all (byte-identical to
the absolute model for a pack that declares nothing), but a pack manifest MAY declare a
narrow capability set that the still-confined, still-terminable worker grants.

**Manifest declaration (default-deny).** A tool/pack contributes
`permissions: ["git", "fs", "net"]` (any subset). `parsePermissions`
(`tool-contributions.ts`) parses it tolerantly into a typed `PackPermission[]` —
unknown/non-string entries are dropped with a warning, NEVER rejecting the tool; absent or
empty ⇒ deny-all. The recognized set is fixed (`PACK_PERMISSION_VALUES` in
`permission-grants.ts`): `git`, `fs`, `net`.

**Server-resolved grant (never caller-supplied).** The grant rides the SAME winning-
contribution resolution as the module path: `resolveToolLocation(tool)` returns
`{ baseDir, groupDir, …, permissions }`, and the dispatcher threads `loc.permissions` into
`ModuleHost.invoke({ …, permissions, workingDir })` (`action-dispatcher.ts` /
`route-dispatcher.ts` `resolveModulePath`/`dispatch`). The client never names a permission;
identity AND grants are derived server-side from the resolved winning contribution (the §2
keystone). A caller cannot escalate by claiming a permission its installed manifest does
not declare.

**Worker ungating (additive, narrow).** `permission-grants.ts` is PURE logic (no node
imports) the worker bootstrap imports statically BEFORE the deny-hook is installed. Each
grant un-gates exactly one thing:

| Grant | `deniedForGrants` removes | Globals | Process shim | Why narrow |
|---|---|---|---|---|
| `git` | `child_process` | (unchanged) | REAL `cwd()` (session dir) + `{ PATH }` env | spawn the `git` binary only; children tracked + SIGKILLed on terminate (§C3.2) |
| `fs`  | `fs` (covers `fs/promises`) | (unchanged) | REAL `cwd()` + `{ PATH }` env | relative reads resolve under the session dir; module-import containment (`packRoot`) STILL enforced |
| `net` | `net`/`http`/`https`/`http2`/`dns`/`tls`/`dgram` | KEEP `fetch`/`WebSocket`/… (`keepNetworkGlobals`) | (unchanged) | outbound network only |

Module-import containment (`packRoot` realpath confinement, `path-guard.ts`),
terminate-on-timeout, memory `resourceLimits`, the empty/minimal env (PATH only — never a
gateway token or secret), and the host-API-proxy allowlist ALL remain in force regardless
of grants. `fs`/`git` reads resolve under the session `workingDir`, not anywhere on disk
the worker pleases.

**Why this is NOT an escape hatch (the binding argument).** A declared permission is
strictly SAFER than the bespoke built-in code paths Phase 2 replaces:

- **Declared + audited:** the capability is visible in the manifest, resolved server-side,
  and every grant / route call / store mutation / session post is audited. There is no
  ambient capability a pack gets without declaring it.
- **Default-deny:** a pack that declares nothing has exactly the absolute-confinement
  worker. The dangerous default did not move.
- **Capped + killable:** even a granted `git` runs inside the terminate-on-timeout +
  memory-capped worker, and its spawned children are SIGKILLed on timeout. The bespoke
  PR-walkthrough route runs `git` **in-process, uncapped, unkillable** (`routes.ts`
  `execFile`); the declared-permission worker is a strict TIGHTENING of that status quo,
  not a loosening.
- **Trusted code tier:** pack server modules are installed-from-market trusted code (same
  tier as a tool / MCP server with shell access). The grant lets that trusted code do its
  job least-privilege; it does NOT widen the CROSS-pack Host-API boundary
  (store/session/callRoute stay server-authorized and pack-scoped).

So acceptance #4's "no privileged escape hatch" holds: cross-pack / cross-session /
UI-driving capabilities remain typed, scoped, server-authorized Host-API methods; a pack's
OWN ambient OS capability is a declared, default-deny, audited, resource-isolated,
terminable grant — a *declared capability*, not an ambient hole.

### C3.3 Migration onto the SINGLE invocation seam

Phase 1 left exactly one invocation seam: `return await handler(ctx, args)` in
`ActionDispatcher.dispatch` (`action-dispatcher.ts`, "SINGLE invocation seam (design §5
iv)"). C3 replaces that one line with `return await this.moduleHost.invoke({...})` —
**callers unchanged**. The shared dispatcher base (B3.1) means actions + routes ride the
same seam (stores have no pack module, so they are not on this seam).

**Worker isolation is UNCONDITIONAL — there is no in-process production path (NON-NEGOTIABLE).**
The seam ALWAYS routes through `ModuleHost.invoke`; there is **no config flag, env var, or
runtime toggle that runs a pack server module in-process** in any shippable, packaged, or CI
build. A second "in-process for debugging" path would be a production bypass of the C3
isolation boundary (it would reintroduce ambient `process`/fs/network access on
LLM-influenced code) and is therefore deleted, not gated — it directly violates acceptance
#3/#4.

If a local-dev debugging affordance is ever wanted, it is permitted ONLY under all three of
these constraints (and the recommendation remains: do not add one):

- **(a) Explicit local-dev mode only.** Honored solely when the gateway is running in an
  explicit local-dev mode (e.g. an unpackaged dev checkout); NEVER in a packaged build or
  under CI.
- **(b) Hard-fail in packaged builds.** If the bypass flag/env is set while running a
  packaged build (or CI), the gateway **refuses to boot** (startup hard-error) rather than
  silently running pack code in-process. There is no "log a warning and continue" path.
- **(c) Impossible to enable in the shipped configuration.** The shippable/packaged config
  cannot express the bypass at all — the toggle is inert (ignored) and unsettable there, so
  the shipped configuration can never disable isolation.

The packaging boundary (packaged-build / CI detection) is the single point that enforces
(a)–(c); a **config-invariant test** (§13, C3 row) pins that the shippable configuration
cannot disable isolation — the bypass is inert or hard-errors in a packaged build.

---

## 10. Slice D1 — artifacts-as-pack (litmus)

**Deps:** B4 (panels), B1 (stores), **C1** (`host.ui.navigate` — the artifact deep-link
routes through navigation, so D1 depends on the slice that implements `navigate`/routing,
not merely on B4+B1), renderer (Phase 1). Proves a built-in re-expressed as a pack with
parity — including the **deep-link** parity that acceptance #1 requires of BOTH built-ins.

### D1.0 Pack dependency bundling / vendoring (author-side build)

The artifacts built-in renders real `text/html`, Markdown, and rich types via heavyweight
npm deps (`highlight.js`, `pdfjs-dist`, `docx-preview`, …). A market pack ships
**self-contained** — there is **NO install-time npm** (the marketplace constraint: no
install-time package execution) — so those deps are BUNDLED at AUTHOR time:

- **esbuild bundle.** The pack's author-side build (an esbuild step run before publish,
  NOT at install) inlines every npm dependency into the pack's ESM entry modules
  (`renderer.js`, the `artifacts.viewer` panel entry). The built bundles are **committed +
  shipped** as the pack's self-contained assets; install writes files only (no package
  execution, no `npm install`).
- **The host toolkit stays FACTORY-INJECTED, never bundled.** The renderer/panel toolkit
  (`html` / `nothing` / `renderHeader`, plus the `host` object) is supplied by Bobbit at
  load time via the factory signature the Phase-1 loader already uses
  (`pack-renderers.ts` / `pack-panels.ts`) — it is NOT inlined into the bundle. This keeps
  the host surface a single versioned injection point (a pack cannot pin a stale copy of
  the toolkit) and keeps bundles small. esbuild marks those toolkit names `external`.
- **pdfjs worker handling (decision).** `pdfjs-dist` needs a separate worker script
  (`pdf.worker.mjs`) that cannot be a normal bundled import (it is spawned as its own
  script). The decision is to SHIP the worker as a sibling pack asset and resolve it via
  `GlobalWorkerOptions.workerSrc` from the panel entry's OWN served asset path (never a
  hardcoded CDN), falling back to the main-thread "fake worker" only where a separate
  worker URL cannot be served. The worker asset is committed alongside the bundle.

This is how D1 reaches REAL parity with the built-in (genuine `hljs` highlighting, genuine
`pdfjs` / `docx-preview` rendering) rather than a degraded re-implementation — the SAME
libraries, bundled into the pack.

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

### D1.2 Artifact deep-link (parity with acceptance #1)

Acceptance #1 requires both built-ins to **deep-link**. The artifacts pack contributes a
deep-linkable target so a viewer can be reopened by id from a route/URL, rehydrating from
the store and surviving reload:

- **Declaration (C1 route entrypoint):** the artifacts pack declares a deep-linkable route
  via an `entrypoints:` `kind:"route"` contribution (§7.1):
  `{ kind: "route", routeId: "artifacts", target: { panelId: "artifacts.viewer" }, paramKeys: ["artifactId"] }`.
  At registry build this populates the client pack route registry (§7.1a) as
  `"artifacts" → { targetPanelId: "artifacts.viewer", paramKeys: ["artifactId"] }`. A pack
  never builds `#/...` strings; it calls
  `host.ui.navigate({ route: "artifacts", params: { artifactId } })` (frozen v1
  `RouteTarget`), and `navigateToTarget` serializes it through the registry.
- **Resolution chain (through the registry, §7.1a/§7.2/§7.2a):**
  `navigate({ route: "artifacts", params: { artifactId } })` → `lookupPackRoute("artifacts")`
  + `paramKeys` filter → `setHashRoute` serializes **`#/ext/artifacts?artifactId=…`** →
  `getRouteFromHash` parses the `ext` RouteView → `lookupPackRoute` resolves
  `artifacts.viewer` → `openPackPanel({ panelId: "artifacts.viewer", params: { artifactId } })`
  (the B4 panel) → the viewer rehydrates its content from `host.store.get(artifactId)` (B1,
  pack-scoped). The deep-link carries only the `artifactId`; all payload comes from the
  store, so a fresh load (or reload) reconstructs the viewer identically.
- **Reload survival:** because the route lives in the SPA hash scheme (`#/ext/artifacts`)
  and the payload lives in the pack store, reloading on the deep-link route re-runs
  `getRouteFromHash` → registry lookup → `openPackPanel` → `store.get(artifactId)` with no
  dependence on in-memory state — the same store-backed restore-by-id D1.1 already relies
  on. Uninstalling the pack reconciles the route out of the registry (§7.1a), so the
  deep-link no longer resolves.

This makes artifact deep-link an opener-independent, store-rehydrated path identical in
shape to D2's `host.ui.navigate({ route: "pr-walkthrough", params: { jobId } })`
entrypoint (§11), proving the `navigate`→route→panel→store chain on the simpler litmus pack.

### D1.3 Test adaptation + deletion

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
  wired at `server.ts:2268`) as a pack `routes.js` module that declares
  `permissions: ["git", "fs"]` (§9 C3.4) so it recomputes the diff/changeset LIVE in the
  confined worker (§D2.3) and reads LLM-synthesized cards from `host.store`. The viewer
  loads its changeset/diff bundle via `host.callRoute("bundle", { query: { jobId } })` — which POSTs
  `/api/ext/route/bundle` with `tool=<pr-walkthrough tool>`; the server authorizes that
  tool, derives the pack, then resolves the `"bundle"` route via
  `RouteRegistry.resolve(packId, "bundle")` and dispatches the registry's declaring-tool
  module (B3.2). Because the panel is opened from the pack's panel surface (a DIFFERENT
  tool than the routes-bearing tool may be the opener), the **registry — not the opener
  tool's location — is what makes the panel-originated `callRoute("bundle", ...)` reliably
  reach the pack's route module**; this is the concrete acceptance proof that pack-level
  route resolution is opener-independent. NEVER a raw fetch (v1 §6.2).
- `stores:` — re-express `walkthrough-store.ts`
  (`WALKTHROUGH_STORE_SCHEMA_VERSION`, job/changeset state) onto `host.store.*`,
  pack-scoped.
- `entrypoints:` — TWO contributions: (1) a `kind:"route"` route entrypoint
  `{ routeId: "pr-walkthrough", target: { panelId: "pr-walkthrough.panel" }, paramKeys: ["jobId"] }`
  registering the deep-linkable route in the client pack route registry (§7.1a); (2) a
  git-widget button / command-palette launcher whose click calls
  `host.ui.navigate({ route: "pr-walkthrough", params: { jobId } })`, which serializes to
  `#/ext/pr-walkthrough?jobId=…` and resolves through the registry to open the panel
  rehydrated from `host.store.*` (§7.2/§7.2a). (This replaces the bespoke SPA
  `"walkthrough"` route — `routing.ts:5`/`:47` — with the generic `ext` route surface.)
- `host.session.readToolCall` — read the `submit_pr_walkthrough_yaml` tool call's
  input/output (B2 implements the body; usable here only once C2 flips the `session` flag)
  instead of bespoke transcript access. The panel-originated read is authorized via
  `authorizeScopedRequest` (§2a), so it needs no owned `toolUseId`.

### D2.2 Test adaptation + deletion

Adapt PR-walkthrough tests + `tests/e2e/ui/extension-host.spec.ts` pattern. Stage deletion
of `src/ui/components/pr-walkthrough/`, `src/server/pr-walkthrough/routes.ts` bespoke
dispatch, and `defaults/tools/pr-walkthrough/` once parity E2E is green.

### D2.3 Live changeset recompute IS pack-expressible via declared permissions

> **Reversal of the prior revision.** The earlier doc stated live changeset recompute was
> NOT pack-expressible because the worker had zero ambient access. The declared-permission
> model (§9 C3.4) reverses this: the pack's `routes.js` declares `permissions: ["git",
> "fs"]`, so the `bundle`/`resolve` route runs `git` + diff parsing + changeset assembly
> **LIVE in the confined worker** — exactly the work `routes.ts` does today via `execFile`,
> now resource-capped + killable. This is what lets the pack review PRs created AFTER it was
> installed (a static seeded bundle could only replay PRs known at publish time).

**What the pack route COMPUTES live (declared `git`/`fs`, in the worker):**

- `git` diff / show / merge-base against the session working dir (the worker's REAL
  `cwd()` under the `git` grant), producing the raw changeset (base/head SHAs, file list)
  and the parsed `DiffBlock[]` (the deterministic diff-parse logic from `routes.ts`). The
  `git` binary resolves via the worker's `{ PATH }` env; spawned children are SIGKILLed on
  terminate-on-timeout (§9 C3.2/C3.4).
- The deterministic, NON-LLM card layout — `synthesizeFallbackCards` (`routes.ts`) needs no
  model credentials and runs in-worker, producing the structural changeset header / phase
  rail / diff blocks / suggested-comment skeleton.

**The card-SYNTHESIS credential boundary (CRITICAL — resolve explicitly, do NOT guess).**
LLM card synthesis (`synthesizeCardsForResolver` → `completeModelText` /
`getAvailableModels`, `routes.ts`) needs MODEL CREDENTIALS. The confined worker has an
empty/minimal env (PATH only) and **no gateway token / model credentials** — by design
(§9 C3.2). The `net` grant would give outbound sockets but still NOT the gateway's model
keys. **So LLM synthesis MUST NOT run in the pack route worker.** The implemented split:

1. **LLM-enhanced cards are produced at AGENT-TOOL / submit time, persisted to the pack
   store.** The `submit_pr_walkthrough_yaml` agent tool (normal agent credentials, NOT the
   confined worker) synthesizes the rich cards; the pack's `publish` route writes them to
   `host.store` keyed by changeset id (`changesetIdForLocal(base, head)`). The pack
   `bundle`/`resolve` route, when it computes a changeset id that HAS stored cards, READS
   them via `host.store.get(...)` and renders them — full parity for any PR a walkthrough
   was authored for (`routes.ts` already prefers `resolved.cards` when present).
2. **For a changeset with NO stored cards (a freshly-recomputed post-install PR) the route
   returns the deterministic `synthesizeFallbackCards` output** it computed in-worker — a
   correct, non-LLM walkthrough — and MAY enqueue an agent-tool synthesis to upgrade it.
3. **Alternative (if richer LIVE LLM cards are wanted): a HOST-PROVIDED synthesis route.**
   A future `host`-side capability runs `completeModelText` IN THE PARENT (where model creds
   live) behind the same authorized proxy as `store`/`session`; the pack route calls it and
   credentials never enter the worker. Documented follow-up
   (`docs/design/pr-walkthrough-pack-deletion.md`); NOT required for D2 parity since path
   (1) covers every authored walkthrough.

**Precise reader/computer split for the A2 implementer:**

| Data | Where it comes from | Credentials? |
|---|---|---|
| base/head SHA, file list, `DiffBlock[]` | COMPUTED live in worker via declared `git`/`fs` | none (git binary via PATH) |
| structural fallback cards | COMPUTED live in worker (`synthesizeFallbackCards`) | none |
| LLM-enhanced cards | READ from `host.store` (written by the submit-time agent tool) | model creds used at submit time, in the AGENT, never the worker |
| GitHub review export | stays agent-tool / built-in (network + GitHub auth) | not in the worker |

So D2's `bundle` route is a LIVE git/diff computer for the diff + a STORE reader for the
LLM cards — never an in-worker LLM caller. The D2 E2E
(`tests/e2e/ui/pr-walkthrough-pack.spec.ts`) seeds a realistic persisted bundle through the
pack's own `publish` route (proving the READ/render path) AND drives a live recompute over a
real git working dir (proving the declared-`git` worker path), plus the maximal launcher
surface (`git-widget-button`) and the `kind:"route"` deep-link.

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
- **C1 entrypoints + navigate + client route registry.** New: `pack-entrypoints.ts`
  (launchers + `kind:"route"` deep-link routes + the generation-guarded, reconcile-on-
  uninstall, project-scoped client pack route registry — mirrors `pack-renderers.ts` /
  `pack-panels.ts`, does NOT fork). Shared: `host-api.ts` (navigate body + flip
  `flags.ui`), `tool-contributions.ts` (`parseEntrypoints` + duplicate-`routeId` rejection
  at registry build), `routing.ts` (single-owner — adds the `ext` `RouteView` +
  `#/ext/<routeId>?params` serialization/parse + reload-restoration handler that calls
  `openPackPanel`), `server.ts` (entrypoint metadata if needed). Deps: B4, B3.
- **C2 session writes.** New: `gesture-context.ts` (client gesture token — C2-owned).
  Shared: `server.ts` (+message endpoint), `server-host-api.ts` (postMessage body + flip
  `flags.session`), client `host-api.ts` (postMessage/subscribe + flip `flags.session`;
  postMessage consumes the gesture token). Deps: B2.
- **C3 isolation.** New: `module-host-worker.ts` (+ confinement bootstrap). Edits the
  single seam in `action-dispatcher.ts` (+ shared dispatcher base from B3) — single-owner
  of the seam line. Deps: B3 (routes) + the action baseline. Isolates **actions + routes
  only** (stores run no pack code).

### Wave 4 — Litmus (after their deps)
- **D1 artifacts pack.** New: `market-packs/artifacts/`. Deps: B4, B1, **C1** (`navigate`
  for the artifact deep-link route — §10). + staged deletion PR.
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
| B2 | `extension-host-contract-adapter.test.ts` | JSONL rows → `HostMessage`/`HostContentBlock`/`ToolCallRecord`; both tool_use shapes mapped; `CONTRACT_VERSION === HOST_CONTRACT_VERSION`; unknown block types tolerated; read scoped to own session (other session id has no parameter); **`pattern` is a LITERAL case-insensitive substring filter (regex metacharacters matched verbatim), and a pathological catastrophic-backtracking string is HARMLESS — no ReDoS, no throw** | 2,4 |
| B3 | `extension-host-route-dispatcher.test.ts` | route resolution + precedence (pack shadows builtin); namespace-by-construction (`tool` → server-derived pack; dispatch hits ONLY that pack's route; no `<pack>` URL segment to forge); **pack-level registry: opener tool X calling a route DECLARED by a different tool Y in the SAME pack resolves + dispatches Y's module correctly** (proves pack-scoped, opener-independent); **duplicate route names across a pack are rejected at metadata/registry-build time**; unknown route name → 404; `authorizeScopedRequest` reuse (no toolUseId required); epoch/registry cache invalidation | 2,4 |
| B4 | `pack-panels-reconcile.spec.ts` (`file://`) | panel loader registers/reconciles; reload survival (re-driven from metadata); uninstall reconcile (generation-guarded); override; theme-token + sandbox conventions present | 2,4 |
| C1 | `pack-entrypoints.spec.ts` (`file://`) | entrypoint kinds register (incl. `kind:"route"`); `navigate(RouteTarget)` maps to router view (no hash baked in pack); no auto-invoke on mount; **client route registry: an arbitrary THIRD-PARTY fixture pack (not artifacts/pr-walkthrough) registering `{kind:"route", routeId:"thirdparty.demo", target:{panelId:…}, paramKeys:[…]}` → `navigate({route:"thirdparty.demo",params})` serializes `#/ext/thirdparty.demo?…` and opens its panel**; **reload restoration: loading on `#/ext/<routeId>?params` → `getRouteFromHash` → `lookupPackRoute` → `openPackPanel` rehydrated from `store.get`**; **uninstall reconcile drops the route (`lookupPackRoute` returns undefined; deep-link no longer resolves)**; **duplicate `routeId` across packs rejected at registry build** | 1,2,4 |
| C2 | `extension-host-session-write.test.ts` + `extension-host-session-write-permit.test.ts` | postMessage authorized via **`authorizeScopedRequest`** against the header-bound session (NOT `authorizeActionRequest`); **postMessage SUCCEEDS from a panel/entrypoint context with NO `toolUseId` when a user gesture is active**; resumeTurn vs non-resume; every post audited; **cross-session post impossible (target = header-bound session, never a body param)**; body/header session mismatch rejected; **gesture token: NO postMessage POST fires on panel/renderer mount (no active gesture → throws synchronously), and a post DOES succeed when invoked from a user-gesture handler** (`runWithUserGesture`) — mirrors the Phase-1 "no action POST before click" control assertion; gesture consumed+cleared after one post; **server-minted write permit: post REQUIRES a nonce, permit is single-use (replay rejected), content-bound (sha256(role+"\n"+text) over {sessionId,packId,tool}), mismatch/expiry/reuse rejected with NO post**; **role-aware delivery: "system" framed as `<system-reminder>` (NOT delivered as raw user text), "user" verbatim** | 2,4 |
| C3 | `extension-host-module-isolation.test.ts` | a `while(1)` spin is terminated on timeout (terminate-on-timeout IS the CPU control); `resourceLimits` memory cap rejects oversized alloc; **with NO grant a pack module CANNOT `require`/import `node:fs`/`node:child_process`/network built-ins** (deny-hook) and **CANNOT read `process.env` secrets** (empty-env worker); **declared-permission grant: `permissions:["git"]` un-denies `child_process` (real `cwd()` + PATH-only env, no token) and a spawned child is SIGKILLed on terminate-on-timeout; `fs`/`net` un-gate only their own capability; an UNDECLARED capability stays denied (default-deny floor) — `deniedForGrants`/`normalizeGrants` (`permission-grants.ts`)**; crash isolated → error not process death; seam swap leaves callers unchanged | 3,4 |
| C3 | `extension-host-isolation-config-invariant.test.ts` | **config-invariant: the shippable/packaged configuration CANNOT disable worker isolation** — no shipped config key/env toggles in-process execution; if a bypass flag/env is set under a packaged build (or CI) the gateway hard-fails at startup (refuses to boot), and the toggle is inert/unsettable in the shipped config (any dev-only affordance is honored only in explicit local-dev mode); the production seam ALWAYS routes through `ModuleHost.invoke` | 3,4 |
| — | `tool-contributions.test.ts` (extend) | formerly-reserved keys now PARSED+TYPED (panels/routes/stores/entrypoints) and ACT (wire fields populated); malformed still degrades, never rejects | 2 |
| — | `host-api-v1-frozen.test.ts` (extend/add) | `HOST_API_VERSION===1` unchanged; v1 types compile unchanged; capabilities flip per host | 2 |
| — | existing `pack-marketplace.test.ts` / budget tests | `buildPackList` byte-identical; tool-description budget; AGENTS budget | invariants |
| **D1** | `tests/e2e/ui/artifacts-pack.spec.ts` (**mandatory E2E**) | install → inline pill renders → open viewer panel → persist across reload (store) → **deep-link: `navigate({route:"artifacts",params:{artifactId}})` opens the `artifacts.viewer` panel rehydrated from `store.get(artifactId)`, surviving reload on the deep-link route** → uninstall reconciles | **1** |
| **D2** | `tests/e2e/ui/pr-walkthrough-pack.spec.ts` (**mandatory E2E**) | install → entrypoint launches → panel renders from pack `callRoute` (`/api/ext/route/bundle` with `tool`) + store → `readToolCall` after `session` flag live → deep-link route → uninstall | **1** |

Gate: `npm run check`, `npm run test:unit`, `npm run test:e2e` green; the two litmus E2Es
are the acceptance proofs.

---

## 14. Acceptance criteria (from the goal) → satisfying slice

1. **Both built-ins ship as installable packs with behavioral parity (render, persist
   across reload, deep-link); bespoke paths deleted (or deletion PR ready).** → **D1**
   (artifacts) + **D2** (pr-walkthrough), each with its mandatory E2E and a staged deletion
   PR gated on parity. **Deep-link parity is covered for BOTH:** D1 via
   `host.ui.navigate({ route: "artifacts", params: { artifactId } })` → `artifacts.viewer`
   panel rehydrated from `host.store.get(artifactId)` (§10 D1.2; §13 D1 E2E deep-link
   assertion), D2 via `host.ui.navigate({ route: "pr-walkthrough", params: { jobId } })`
   (§11; §13 D2 E2E deep-link). Both deep-links are store-rehydrated and survive reload, and
   depend on C1 (`navigate`).
2. **Every reserved key live; every frozen Host API method implemented to v1 signature;
   `host.capabilities` all true; `HOST_API_VERSION` still 1 (v1 type compiles unchanged).**
   → `stores` (B1), `routes` (B3), `panels` (B4), `entrypoints` (C1); `store.*` (B1),
   `session.*` reads (B2) + writes (C2), `callRoute` (B3), `ui.*` openPanel (B4) +
   navigate (C1). Flags: `store`→B1, `callRoute`→B3, `ui`→C1, `session`→C2. Pinned by the
   v1-frozen compile test.
3. **Pack server modules (actions + routes) run in worker isolation with
   terminate-on-timeout + resource caps, least-privilege (default-deny ambient access).** →
   **C3** (`module-host-worker.ts`,
   `worker_threads` + minimal (default-empty) env + module-load deny-hook + host-API-proxy-only +
   `terminate()` + `resourceLimits`), migrated onto the single `ActionDispatcher.dispatch`
   seam. **Isolation is UNCONDITIONAL in shipped builds** — there is no config flag, env
   var, or runtime toggle that runs a pack server module in-process in any
   shippable/packaged/CI build (the "in-process for debugging" bypass is deleted, not gated;
   §9). Any local-dev debugging affordance is honored ONLY in explicit local-dev mode,
   hard-fails at startup in packaged builds/CI, and is impossible to enable in the shipped
   configuration; pinned by the §13 config-invariant test. **Least-privilege by DEFAULT
   (deny-all), with a declared, audited opt-in (§9 C3.4):** a pack that declares no
   `permissions:` cannot import `node:fs`/`node:child_process`/network built-ins or read
   `process.env` secrets — the deny-hook + empty env + ambient-global stripping are in
   force. A pack MAY declare `permissions: ["git"|"fs"|"net"]` (server-resolved via
   `resolveToolLocation`, never caller-supplied), which ADDITIVELY un-gates exactly that
   capability inside the STILL-confined, STILL-terminable, memory-capped worker
   (`packRoot` module-import containment + child-process kill-on-terminate preserved; env
   stays PATH-only, never a token/secret). The default-deny floor has no shippable bypass.
   **The "CPU caps" requirement is satisfied by
   terminate-on-timeout (wall-time termination)** — `worker_threads` has no per-core throttle,
   so a runaway CPU loop is bounded by killing the worker on timeout; **memory caps via
   `resourceLimits`.** Stores run no pack code (no pack-supplied store-handler module — see
   §9), so the spec's "store handlers" phrase has no surface to isolate; C3 isolates actions
   + routes, the only pack-supplied server modules.
4. **A third-party pack could implement any surface using only public contributions + the
   Host API — no privileged escape hatch.** → guaranteed by routing the lone
   tool-call-scoped capability (`invokeAction`) through `authorizeActionRequest` and the
   pack-scoped capabilities (`store`/`callRoute`/`session.read*`/`session.postMessage`)
   through `authorizeScopedRequest` (§2a), both keyed off the **server-derived** pack
   identity (A) — never a caller field. `session.postMessage` adds a mandatory user-gesture
   token + audit on top of the scoped guard (so a panel/entrypoint can drive a turn only
   from a real gesture, never on mount, and never cross-session). `callRoute`'s namespace is
   the pack derived from the proven `tool` (B3.2 — no forgeable URL segment); `store` keys
   pack-namespaced (B1.1); the client deep-link route is the server-independent
   `#/ext/<routeId>` registry surface (C1.1a, no privileged route), and no `gateway.fetch`
   is reintroduced. **No in-process execution escape hatch:** worker isolation is unconditional
   in shipped builds (no config can run pack server modules in-process — §9), so there is no
   privileged path around the host-API boundary. **Ambient OS capability for a pack's OWN
   server module (git/fs/net) is a DECLARED, audited, server-resolved, default-deny manifest
   `permissions:` grant inside the resource-isolated terminable worker (§9 C3.4) — a
   declared capability, not an ambient escape hatch; it does NOT widen the
   cross-pack/cross-session/UI-driving Host-API boundary (those stay typed, scoped,
   server-authorized methods).** Pinned by the cross-pack denial + namespace
   unit tests, the declared-permission grant test (§13 C3), and the §13 C3 config-invariant test.

---

## 15. Security recap (the Host API stays the single boundary)

- The pack-scoped capabilities (`store`/`session.read*`/`callRoute`/`session.postMessage`)
  call `authorizeScopedRequest` (§2a — the action guard MINUS toolUseId-ownership) FIRST,
  then key off the **server-resolved** `packId` (A) — never a caller field. The ONLY
  tool-call-scoped capability, `invokeAction`, keeps the full `authorizeActionRequest`
  (`action-guard.ts:53`, incl. toolUseId-ownership). `callRoute`'s reachable namespace is
  the pack the server derives from the proven `tool` — there is no `<pack>` URL segment to
  forge (B3.2); `store` keys are pack-namespaced with path-traversal re-validation (B1.1).
- `session.postMessage`/resume (C2) is highest-risk: it uses `authorizeScopedRequest`
  (allowedTools-gated + header-bound session + body===header + server-derived packId) PLUS
  a MANDATORY user-gesture token (enforced by a client-internal **gesture token** set only
  by genuine user-gesture handlers and consumed+cleared by `postMessage`, which throws if
  absent — C2.1), and every post/resume is audited. It does NOT require toolUseId-ownership
  (driving an agent turn acts on no specific prior tool call), so a panel/entrypoint — which
  binds its host context (`sessionId`/`packTool`) from the opening context (§2a.2) with
  `toolUseId:undefined` — CAN post WHEN it holds a real user gesture, but never on mount.
  Cross-session posting is impossible (target = header-bound session, never a body param).
  The ONLY capability a panel/entrypoint cannot reach is `invokeAction` (it keeps
  `authorizeActionRequest` + toolUseId-ownership) — unchanged, so security is not weakened.
- `panels`/`entrypoints` (B4/C1) run on the main UI thread over LLM-influenced data: iframe
  `sandbox` preserved, theme tokens only, no auto-invoke/navigation on mount.
- Server-module isolation (C3, actions + routes only) bounds blast radius:
  terminate-on-timeout (the CPU control, satisfying the "CPU caps" criterion), memory
  `resourceLimits`, empty-env worker, and a module-load deny-hook. **Isolation is
  UNCONDITIONAL in shipped builds** — no config can run a pack server module in-process
  (the "in-process for debugging" bypass is deleted; any local-dev affordance hard-fails in
  packaged builds/CI and is unsettable in the shipped config — §9, pinned by the §13
  config-invariant test). **Least-privilege by DEFAULT (deny-all) with a declared, audited
  opt-in (§9 C3.4):** a pack with no `permissions:` reaches nothing but the host-API proxy
  channel; a pack MAY declare `permissions: ["git"|"fs"|"net"]` (server-resolved, never
  caller-supplied) to ADDITIVELY un-gate that ONE capability inside the still-confined,
  still-terminable, memory-capped worker (`packRoot` module-import containment + spawned-
  child kill-on-terminate preserved; env stays PATH-only — never a gateway token/secret).
  This is a *declared capability*, not an ambient hole, and does NOT widen the cross-pack
  Host-API boundary. (No pack-supplied store-handler module exists, so the store path has no
  pack code to isolate.)

---

## 16. Documentation deliverables

The goal requires three docs to land alongside the code (owned by the workflow
**documentation gate / docs-writer**, not by a capability slice). They are part of
acceptance, not optional.

1. **`docs/design/extension-host.md` — status flip + new notes.** The v1 SIGNATURES/types
   stay **byte-identical** (frozen). Only the §3/§6 prose **status notes** change: as each
   capability lands, flip its "frozen, not implemented" note to "implemented" (a status
   edit, never a contract change). Add a short note on the internal→contract **adapter
   layer** (B2.1) and the **server-module isolation model** (C3: empty/minimal-env worker +
   deny-hook + host-API-proxy-only + terminate-on-timeout + the **declared-permission
   grant model**, §9 C3.4: default-deny with a server-resolved `git`/`fs`/`net` opt-in).
   This reconciles the
   top-of-doc caveat: "do not change v1 signatures; §3/§6 status notes are flipped to
   'implemented' as capabilities land."
2. **`docs/extension-host-authoring.md` — extend** with authoring guidance for
   `panels`/`stores`/`routes`/`entrypoints` + `host.session.*`, plus the **two migration
   case studies** (artifacts-as-pack D1, pr-walkthrough-as-pack D2).
3. **`docs/marketplace.md` — threat model update** for `routes`/`stores`/`panels`/
   `session`-write + the worker isolation model (terminate-on-timeout as the CPU control,
   empty/minimal-env, deny-hook, host-API-proxy-only; the **declared-permission grant
   model** — manifest `permissions:` default-deny, server-resolved, why it is a declared
   capability not an escape hatch; the trust-by-code-ORIGIN model — §0a; vendored/bundled
   pack deps — §D1.0; the `authorizeScopedRequest` vs `authorizeActionRequest` split).

Each deliverable maps to the workflow's documentation gate; the docs-writer signals it once
the corresponding capabilities have merged.
