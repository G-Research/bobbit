# EP-5 — Extension Observability

**Status:** implementation design. **Source:** PR #1107, `goal/inspect-contex-e05766b3`. **Scope:** absorb its complete, tested Context trace inspector, then make the trace envelope safely extensible for later extension decision/advisory/audit outcomes. EP-5 is read-only: it neither changes session selection nor applies extension output.

## Decision

Use the existing `LifecycleHub` and its existing `ContextTraceStore` as the sole lifecycle-observability path. Absorb the complete #1107 series before adding any extension-specific row kinds. The inspector is a persisted, singleton **Context** side-panel tab which reads a bounded REST projection and treats WebSocket messages solely as invalidations.

Do not create an extension trace store, a WebSocket trace payload, or a second inspector. The later EP-2 through EP-4 producers append sanitized decision metadata to the same persisted trace entry; the existing provider trace row remains unchanged and readable.

## Current baseline and source delta

The current EP-5 parent baseline already has the lifecycle owners:

- `src/server/agent/lifecycle-hub.ts::LifecycleHub.dispatch()` invokes enabled providers, applies block budgets, constructs provider timing/block/error metadata, and calls `ContextTraceStore.appendTrace()`.
- `src/server/agent/context-trace-store.ts::ContextTraceStore` persists session-scoped JSONL and already protects the trace file name with `safeBasename()`.
- `src/server/server.ts` owns `GET /api/sessions/:id/context-trace` and constructs the shared `LifecycleHub`.
- The server-authoritative side-panel workspace exists, but the parent schema does not yet have a `context` tab kind or a Context action.

#1107 adds the complete user-visible path: the durable trace cap and append observer; session existence/URI decoding on the REST endpoint; metadata-only `context_trace_updated`; the Context workspace type/canonicalizer; controller, component, action, rendering, lifecycle cleanup, and its registered core/DOM/browser coverage. It also includes follow-up fixes for lifecycle dispatch, cached-session synchronization, stale session-menu invocations, inspector open/state behavior, and fixture stability. Those follow-ups are part of the absorption, not optional cleanup.

## Source absorption plan

1. Integrate the **entire tested #1107 change set through** `goal/inspect-contex-e05766b3` (including its mainline merge and all follow-up commits), rather than transplanting only initial UI commits. Preserve its source tests and test-map registrations.
2. Resolve any parent conflicts at the existing owners. Do not reimplement the branch under different paths or drop its fixes:
   - `c132ada8d` restores lifecycle trace dispatch;
   - `0034ddf37`, `075d77d50`, `bd0ac844e` establish invalidation, controller, and UI;
   - `34c8d20c1`, `f6de939d6`, `9428ca330`, `137cbd9bc` correct opening, cached synchronization, session scoping, and state;
   - `b96bfc213`, `5f25ba48b`, `7887860fa` retain the regression fixtures/tests;
   - `08cb85987`, `51f9a7280`, `f2718acac` carry the reviewed API, retention, and reference documentation.
3. First run the #1107 focused registrations unchanged. Only after that baseline is green may an EP-2+ slice add a new normalized item kind or trace field.
4. Keep #1107 source branch/PR intact until the parent contains the full series and its tests pass. The parent integration commit must explicitly record the absorbed source tip and any conflict resolution.

This satisfies the parent integration design's requirement to absorb #1107 completely instead of silently recreating a subset.

## Exact existing data flow

```text
LifecycleHub.dispatch(event, base)
  -> ModuleHost provider calls + block budget/validation
  -> ContextTraceStore.appendTrace(sessionId, TraceEntry)
       -> append JSONL, rotate only after > 2 MiB, then observer
       -> gateway broadcasts { type: "context_trace_updated", sessionId, ts }

active session's RemoteAgent.handleServerMessage()
  -> notifyContextTraceUpdated(sessionId)
  -> only an open active inspector calls refreshContextTrace(sessionId)
  -> GET /api/sessions/:id/context-trace?limit=N
  -> normalizeContextTracePayload(unknown)
  -> ContextTraceInspector receives only allow-listed display state
```

### Server and transport contracts

`src/server/agent/context-trace-store.ts` owns durable records. `appendTrace()` must finish append and cap rotation before invoking its optional `TraceAppendObserver`; observer failure is swallowed so an invalidation transport problem never loses durable trace data. `readTrace()` returns oldest-to-newest entries, retains only the latest requested rows, and skips corrupt/partial JSONL rows.

The trace file is capped at **2 MiB per session**. On overflow, retain newest complete lines that fit via temporary-file rename. This is diagnostic retention, not an audit archive.

`src/server/server.ts::createGateway()` installs the observer on the shared lifecycle trace store and calls `broadcastToSession(sessionId, { type: "context_trace_updated", sessionId, ts })`. `handleApiRoute()` reads the same store for:

```text
GET /api/sessions/:id/context-trace?limit=N
```

The route decodes `:id`, verifies a live or persisted session exists, and returns `404 { error: "Session not found" }` for an unknown or malformed id. A positive integer limit is capped at 1,000; omitted, invalid, or non-positive limits retain the endpoint's full default result. The response is ordered oldest-to-newest:

```ts
interface TraceProviderRow {
  id: string;
  ms: number;
  blocks: number;
  omitted: number;
  error?: string; // persisted diagnostic only; never UI text
}
interface TraceEntry {
  ts: number;
  hook: string;
  sessionId: string;
  providers: TraceProviderRow[];
}
```

`src/server/ws/protocol.ts::ServerMessage` adds only the invalidation frame. It must contain no trace entry, provider error, prompt, context block, decision value, or secret.

### Workspace, action, and controller

The #1107 workspace change is intentionally minimal:

- `src/shared/side-panel-workspace.ts` adds `SidePanelKind = ... | "context"` and source `{ type: "context"; sessionId }`.
- `src/server/side-panel-workspace.ts::canonicalizeContext()` accepts only singleton id `context` whose source session matches the workspace session. It persists no trace contents.
- `src/app/panel-workspace.ts` defines `CONTEXT_PANEL_TAB_ID = "context"`; `src/app/side-panel-workspace.ts` carries it through client normalization and the fixture fallback.
- `src/app/session-actions.ts::openContextTracePanel()` is the sole explicit opener. It rejects stale menu callbacks, optimistically opens/focuses the current session's workspace tab, then calls `openContextTraceInspector()`.

A closed Context tab is authoritative absence, even if trace rows exist. Hydration, refresh, reconnect, cached session activation, and WebSocket invalidation must not recreate it. Only **Session actions → View context trace** can reopen it. The action is visible only for the active session, including an active archived session view.

`src/app/context-trace.ts` is the client state owner:

- state is keyed by session, initial limit 100, grows by 100, and never exceeds 1,000;
- one abortable request carries a generation and may apply only while its session is active and the inspector is open;
- an inactive-session invalidation is remembered and causes one bounded revalidation on a later open/sync;
- session switch, disconnect, and tab close abort work through `stopContextTraceInspector()`;
- a failed initial request displays fixed local error copy; a failed refresh retains previously normalized rows and displays fixed local refresh copy;
- `restoreContextTraceInspectorFocus()` returns focus to the opener/menu trigger (or safe fallback) only when the Context tab closes.

`src/app/remote-agent.ts` receives the invalidation and then calls only `notifyContextTraceUpdated()`. Workspace hydration/replay calls `syncContextTraceInspector()`. `src/app/session-manager.ts` stops the controller before switching/backing out/disconnecting. `src/app/render.ts` renders the component only for the active `context` tab and wires refresh/retry/load-earlier events to the controller.

`src/ui/components/ContextTraceInspector.ts` is presentation only. It receives normalized state, focuses its heading once when opened, exposes semantic event times and provider metrics, and does not fetch or retain raw API payloads.

## Sanitization boundary

The REST response is untrusted input to the browser, including durable provider diagnostics. The controller's `normalizeContextTracePayload()` is the mandatory data firewall; the component accepts only `ContextInspectorItem` values produced by it.

The current allow-list is deliberately narrow:

| Raw field | Display rule |
|---|---|
| `hook` | exact known lifecycle hook, otherwise `Unknown event` |
| `ts`, `ms`, `blocks`, `omitted` | finite, non-negative, bounded integer; otherwise `0` |
| provider `id` | bounded identifier regex, otherwise `Unknown provider` |
| provider `error` | map only known timeout/malformed forms to fixed labels; all other non-empty errors become `Provider error` |
| every other field | ignored |

No raw error, stack, path, context block, prompt, provider config, gateway token, secret, or `sessionId` is interpolated. Lit text binding remains required; do not introduce `unsafeHTML` or render arbitrary error/reason/value strings. The component therefore remains safe even if old JSONL rows, an extension, or a proxy provides unexpected fields.

## Additive extension outcome rows

EP-5 ships without decision producers. Later slices need a compact explanation of whether a declared extension suggestion was shown, accepted, denied, or discarded, but they must never turn the inspector into a configuration, prompt, or secret viewer.

Add optional outcome rows to **the existing `TraceEntry` envelope**, not to `TraceProviderRow` and not to a second store:

```ts
type TraceOutcome = "advised" | "applied" | "denied" | "dropped" | "error" | "superseded";
type TraceOutcomeKind = "decision" | "advisory" | "audit";

interface TraceOutcomeRow {
  kind: TraceOutcomeKind;
  hookId: string;       // stable declared id, bounded safe identifier
  event: string;        // allow-listed lifecycle/decision event
  outcome: TraceOutcome;
  reason?: string;      // pre-sanitized bounded public code/label, not provider prose
  value?: string;       // non-secret selected identifier only, never payload/config
  ms?: number;          // finite non-negative duration
}

interface TraceEntry {
  // existing fields remain byte-for-byte compatible
  outcomes?: TraceOutcomeRow[];
}
```

Rules for producers:

1. The core application/grant owner, not extension code, emits the row after validation/resolution. A hook may propose; it cannot assert `applied`.
2. `advised` means a valid suggestion was observed and not applied. `applied` requires the applicable future grant and core validation. `denied` records a validation/grant/policy/user-pin refusal. `dropped` records malformed, timeout, unavailable, or overlap-drop behavior. `error` is a core-classified failure. `superseded` records deterministic precedence loss.
3. `reason` is a finite catalog value or host-generated fixed label such as `Grant required`, `User pin`, `Unavailable value`, `Malformed result`, or `Timed out`. Do not store extension-provided explanation text unless a later contract defines a separate bounded sanitizer and consumer allow-list.
4. `value` is permitted only for a safe identifier selected from a core-provided allow-list (for example a model/role/workflow id). Never store prompts, tool arguments or patches, transcript text, secret references, config values, free-form rationale, URLs with credentials, or request/response bodies.
5. Bound row count and string sizes at append time; ignore malformed future rows at read/normalization time. Existing rows and clients remain valid when `outcomes` is absent.

The controller evolves additively with a discriminated item union, for example:

```ts
type ContextInspectorItem =
  | { kind: "trace"; entry: SafeTraceEntry }
  | { kind: "outcome"; outcome: SafeTraceOutcomeRow };
```

Its outcome normalizer must allow-list `kind`, safe identifiers, enumerated outcome, finite `ms`, and fixed reason/value labels. Unknown kinds are ignored. The first outcome consumer must add a dedicated sanitized presenter; it must not make existing provider cards interpret decision data.

## Compatibility and failure behavior

- The schema is additive. Existing JSONL rows, REST clients, lifecycle providers, and side-panel workspaces without `context` remain valid.
- Missing trace file, no entries, corrupt old lines, or unsupported future row kinds are non-fatal and render as no activity/ignored data.
- Trace append/observer, normalization, inspector fetch, and WebSocket delivery failures never affect a user turn, lifecycle dispatch, session creation, or extension application.
- Historical/archived sessions remain readable through the same endpoint if their persisted session exists. The inspector never needs a live agent.
- REST is the source of trace metadata. The WebSocket is invalidation only, so old clients can ignore its additive message and still function.

## Test and browser coverage ledger

Retain #1107's tests and register any new tests in `tests2/tests-map.json`.

| Coverage | Source test / required assertion |
|---|---|
| Store durability | `tests2/core/context-trace-store.test.ts`: ordered append/read, limit, 2 MiB full-line rotation, observer only after durability, observer failure isolation. |
| Workspace compatibility | `tests2/core/side-panel-workspace-store.test.ts` and `tests2/core/panel-workspace.test.ts`: singleton context canonicalization and close does not recreate it. |
| Sanitization and paging | `tests2/dom/context-trace-controller.test.ts`: encoded active-session endpoint, 100→200 bounded pagination, stale A→B→A fence, allow-listed normalization, fixed cached-error copy, inactive invalidation revalidation. |
| Presentation | `tests2/dom/context-trace-inspector.test.ts`: newest-first entries/provider order, stable loading/empty/error state, focus/tabpanel semantics, and no raw secret/error rendering. |
| Session action | `tests2/dom/session-menu.test.ts`, archived/sidebar fixtures: only active session action can open the Context tab. |
| Real browser journey | `tests2/browser/e2e/context-trace-inspector.spec.ts`: install fixture providers; assert safe provider ordering and suppressed raw context/error payload; close/reopen focus; A/B session scoping; append-triggered WS refresh; **cold reload** persists/reopens historical Context state. |

The browser journey must additionally cover pagination by producing more than 100 trace entries, selecting **Load 100 earlier**, and proving 200 returned entries remain newest-first. Its fixture must exercise a denied and a dropped future outcome after the additive outcome implementation lands: assert fixed safe labels/codes, absence of extension-provided raw reason/value, no secret-bearing fields, and coexistence with provider rows. These assertions belong with the first outcome producer, while EP-5's absorbed browser test remains the baseline for reload, trace sanitization, and live invalidation.

## Scope ledger

| In scope | Out of scope |
|---|---|
| Full #1107 absorption; read-only active/historical Context inspector; bounded durable metadata; REST read; metadata-only live invalidation; workspace persistence; sanitization; additive outcome envelope. | Applying extension decisions, granting capabilities, changing prompts/tools/configuration, rendering context bodies/prompts, raw provider diagnostics, a searchable audit archive, new polling, a second trace store, or exposing secret values. |
| Future-safe rows for decision/advisory/audit outcomes, including denied/dropped visibility through safe codes. | Free-form extension rationales, tool arguments/patches, raw error stacks, values not already safe core identifiers, and any client-supplied assertion that a change was applied. |
