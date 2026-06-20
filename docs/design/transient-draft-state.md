# Transient Draft State — Unified Persistence Architecture & Guidelines

Status: implemented. Owner: goal *Unify transient drafts*.

This document outlines the architecture, design, and implementation of Bobbit's unified transient draft persistence pattern. This system preserves volatile, in-progress user input against accidental draft loss across the web client, while offering clear, standardized rules for choosing storage tiers.

It builds on the patterns established in [`composer-draft-persistence.md`](composer-draft-persistence.md) and [`../non-blocking-ask.md`](../non-blocking-ask.md).

---

## 1. The `ask_user_choices` Draft-Loss Solution

### 1.1 The Original Problem

The non-blocking `ask_user_choices` flow makes **submitted** answers fully durable by appending a tagged response envelope (`[ask_user_choices_response tool_use_id=…]`) to the session's `.jsonl` transcript. When reloaded, `AskUserChoicesRenderer` flips the widget to a read-only "answered" state by reading this transcript.

However, **pre-submit** state originally lived solely in the component-local Lit reactive state (`_draft`) of the `<ask-user-choices-widget>` component:

```ts
@state() private _activeTab = 0;
@state() private _focusedOption = 0;
@state() private _draft: DraftEntry[] = [];   // selections + Other text per question
@state() private _submitError = "";
```

Because this state was purely local, any event that unmounted or recreated the widget DOM element discarded the instance, resetting all pending selections and "Other" text fields to empty.

### 1.2 Widget Recreation Triggers

The interactive widget lives in the transcript of `<agent-interface>`. The element instance is discarded and recreated in all of the following scenarios:

1. **Page Reload / Hard Refresh**: The transcript is rebuilt from scratch. The pending `tool_use` is re-rendered as a fresh, empty interactive widget.
2. **LRU Session Cache Eviction**: The client caches up to `SESSION_CACHE_MAX = 10` session views. Cycling through more than 10 sessions evicts the oldest session. Switching back recreates its DOM elements from the transcript.
3. **WebSocket Reconnect & Stream-Driven Re-renders**: Reconnection and stream updates replace transcript messages, prompting Lit to swap or re-key DOM nodes.
4. **Route / View Switches**: Navigating away from and back to the chat panel unmounts and remounts the widget.

### 1.3 The Persistence Fix

To bridge these recreation events, pending selections and active tabs are persisted in the browser's `sessionStorage` tier using the unified `TransientDraftStore`.

- **Per-Tab Isolation**: By utilizing `sessionStorage`, drafts are safely isolated per browser tab. If a user opens the same pending session in two separate tabs, they can fill in their answers independently (avoiding state leakage), and whichever tab submits first writes to the transcript.
- **Idempotency & Finality**: Submitted answers remain backed by the server-side transcript. Once submitted, the draft store is cleared, and any re-render safely locks the widget into read-only mode without risk of draft resurrection.

---

## 2. Shared Durable Draft-State Store

To avoid scattered, ad-hoc, or non-standard uses of `sessionStorage`, `localStorage`, IndexedDB, or server endpoints, the project exposes a standardized, lightweight persistence pattern.

### 2.1 Storage Tier Selection Rules

Bobbit operates four distinct storage tiers. Developers must apply this decision table top-down when designing new user-input surfaces:

| Tier | Survives | Scope | Read Access | Capacity | Best For | Reference Implementation |
|---|---|---|---|---|---|---|
| **IndexedDB** | Reload, restart, tab close, browser restarts | Cross-tab / Global | Async | 10s–100s MB | Large or binary payloads (images, files, heavy extractions). | `PromptDraftAttachmentsStore` |
| **Server Draft Table** | Reload, restart, device switch, server restarts | Cross-tab / Cross-device | Async | Small (< 10 KB) | Small drafts that must be authoritative server-side or synchronized cross-device. | `session-manager.createDraftManager`, `proposal-helpers.ts` |
| **localStorage** | Reload, restart, tab close, browser restarts | Cross-tab / Global | Sync | ~5 MB | Small, non-sensitive drafts that intentionally persist globally. | `sidebar-filters` |
| **sessionStorage** | Reload, HMR, element unmount/recreation | Same-tab / Local | Sync | ~5 MB | Small, client-local, tab-isolated scratch drafts. | `TransientDraftStore` ("session" backend) |

### 2.2 The `TransientDraftStore` Abstraction

`TransientDraftStore` is a thin, synchronous, namespaced wrapper over the browser's synchronous web-storage APIs (`sessionStorage` and `localStorage`). It is defined in `src/ui/storage/transient-draft-store.ts` and created via the factory function `createTransientDraftStore<T>(options)`.

```ts
export type DraftBackend = "session" | "local";

export interface TransientDraftStoreOptions {
  /** Stable namespace, e.g. "ask". Prefixes every storage key. */
  namespace: string;
  /** Web-storage tier. Default "session". */
  backend?: DraftBackend;
  /** Max live entries in this namespace (LRU by updatedAt). Default 50. */
  maxEntries?: number;
  /** Max serialized bytes per entry (writes above this are dropped). Default 32 KB. */
  maxEntryBytes?: number;
  /** Tombstone TTL in ms; cleared keys stay tombstoned this long. Default 5 min. */
  tombstoneTtlMs?: number;
}

export interface TransientDraftStore<T> {
  /** Synchronous read; null when absent, tombstoned, or unparseable. */
  load(key: string): T | null;
  /** Synchronous write; bumps gen + updatedAt, enforces bounds. No-op over maxEntryBytes or while tombstoned. */
  save(key: string, value: T): void;
  /** Delete the value + write a short-lived tombstone so a late save() can't resurrect. */
  clear(key: string): void;
  /** Drop a key entirely including any tombstone (hard delete). */
  forget(key: string): void;
}
```

### 2.3 Store Semantic Guarantees

#### 1. Keying and Namespacing
All keys are prefixed with a stable prefix: `bobbit_draft/<namespace>/<scopeKey>`.
For pending asks, the `scopeKey` is built as `sessionId + "::" + toolUseId`. The `toolUseId` (which may contain special characters or composite IDs like `call|fc`) is treated as an opaque string, remaining un-split and un-trimmed to preserve exact round-trip matching.

#### 2. Tombstone-Driven Clear
Calling `clear(key)` deletes the draft value and writes a short-lived tombstone:
```ts
{ tombstone: true, until: now + tombstoneTtlMs, gen: lastSeenGen }
```
While a tombstone is active:
- `load` synchronously returns `null`.
- `save` operations are rejected.
This is a robust defense against the **resurrection bug**, where a slow, in-flight, or debounced save operation scheduled *before* submission lands *after* submission and recreates the draft.

#### 3. Last-Write-Wins Generation Guard (`gen`)
Each stored record contains a monotonic `gen` counter:
```ts
interface ValueRecord<T> { v: T; updatedAt: number; gen: number; }
```
When a component calls `save`, the store ensures the new generation strictly exceeds any previously written generation for that key. Out-of-order stale writes are silently dropped.

#### 4. LRU Eviction & Size Caps
- **Per-Namespace LRU**: `save` operations automatically enforce the `maxEntries` constraint by evicting the oldest entries (sorted by `updatedAt` first, with tombstones evicted ahead of live drafts). It never evicts the key currently being written.
- **Oversize Byte Protection**: To prevent browser quota exhaustion and protect performance, writes exceeding `maxEntryBytes` (default 32 KB) are dropped. A warning is logged to the developer console once per namespace.
- **Tombstone Sweeping**: Expired tombstones are swept lazily from the storage pool upon subsequent reads or writes in the namespace.

#### 5. Fault Tolerance
All localStorage and sessionStorage accesses are wrapped in `try/catch` scopes. If a browser blocks storage access (e.g., inside Safari private browsing, sandboxed iframes, or when storage quotas are exceeded), the store gracefully degrades to no-op reads/writes for that operation. It **never** throws or disrupts the runtime.

---

## 3. How `ask_user_choices` Integrates the Pattern

The `<ask-user-choices-widget>` incorporates the `TransientDraftStore` synchronously:

1. **Initialization**: Creates a module-level static store instance:
   ```ts
   const askDraftStore = createTransientDraftStore<AskDraftRecord>({
     namespace: "ask",
     backend: "session",
   });
   ```
2. **Synchronous Restore & Shape Validation**: Seeding is triggered during `_ensureDraft()` (on mounting and question changes). Before applying a restored draft, `_sanitizeStored()` validates it against the current questions. It checks question counts, verifies the type matches (single-select vs. multi-select arrays), strips out options that are no longer valid, and clamps the active tab index. Mismatched or obsolete drafts are discarded.
3. **Persist on Change**: Every input mutator (`_selectOption`, `_setOtherText`, `_selectTab`, etc.) synchronously calls `askDraftStore.save(key, { draft: this._draft, activeTab: this._activeTab })`.
4. **Clean up on Submit**: When successfully submitted (or when the card mounts in a read-only state because an answer envelope is already in the transcript), `_clearDraftStore()` is invoked, executing `askDraftStore.clear(key)`. The tombstone prevents stale async saves from resurrecting the form.

---

## 4. Attachment Draft Resurrection Guard (Composer Follow-Up)

During the audit, a related async race was discovered and fixed in `<agent-interface>` (`AgentInterface.ts`), where composer attachment drafts could resurrect after being cleared.

### 4.1 The Race Bug
1. The user binds a session, and `_loadAttachmentDraft` schedules a slow, asynchronous IndexedDB read to get any saved attachments.
2. While the load is in-flight, the user attaches a file, types a message, and clicks **Send**.
3. Sending the message triggers `_clearAttachmentDraft()`, which clears the local attachment array (`this._attachments = []`) and deletes the draft from IndexedDB.
4. Finally, the slow IndexedDB read resolves. It sees that the session ID is unchanged, and `this._attachments` is currently empty.
5. It applies the loaded array, **resurrecting** the sent attachments inside the composer.

### 4.2 The Monotonic Generation Guard Fix
We introduced a monotonic generation token `_attachmentDraftGen` (type `number`) as a private field in `AgentInterface.ts`. 

- Every load, set, or clear operation on the attachment draft increments this counter:
  ```ts
  private _attachmentDraftGen = 0;
  ```
- When `_loadAttachmentDraft(sessionId)` is initiated, it captures the current generation value locally:
  ```ts
  const gen = ++this._attachmentDraftGen;
  ```
- Upon the async resolve of the IndexedDB lookup, the guard checks both variables:
  ```ts
  if (this._attachmentDraftSessionId !== sessionId) return;
  if (this._attachmentDraftGen !== gen) return;
  ```
- If a user sends a message or edits the attachment list while the load is in-flight, the generation is bumped. The guard intercepts this, and the slow in-flight read is safely discarded, preventing resurrection.

---

## 5. Completed Audit & Intentional Exceptions

The following table summarizes the auditing of user-input surfaces across Bobbit. The guiding principle is to **persist only user-authored content that is costly to recreate**, while letting modal-scoped scratch values and pure UI affordances reset to default.

| Surface | State | Verdict / Exception Rationale |
|---|---|---|
| **Message Composer Text** | Server draft + sessionStorage mirror | Already durable. Serves as the reference implementation for the server draft tier. |
| **Composer Attachments** | IndexedDB via `PromptDraftAttachmentsStore` | Already durable. Protected against async race resurrection via monotonic generation guards. |
| **Proposal Forms** | Server draft table | Already durable. Forms automatically persist draft state under `/api/sessions/:id/draft` with debounced sync. |
| **Sidebar Filters** | `localStorage` | Already durable. Persists lightweight filter options globally across tabs and browser restarts. |
| **`AnnotationPopover`** (Review-pane comment textarea) | Transient component `@state` | **Intentional Exception**. The committed comment is durable; the comment-in-progress is a transient hover-popover whose closure implies discard. Discarding is standard behavior. |
| **`GoalStatusWidget` Bypass Form** | Transient component `@state` | **Intentional Exception**. This is a short, modal-style justification that users complete in a single action. Low payoff for persistence. |
| **Dialogs & Modals** (`AddToInboxDialog`, `CustomProviderDialog`, `SystemPromptDialog`) | Dialog-local `@state` | **Intentional Exception**. Closing a modal explicitly signals discard. Retaining stale, half-written modal fields on reopening would cause confusion. |
| **Search / Picker Queries** (`DirectoryPicker`, `SearchBox`) | Transient query `@state` | **Intentional Exception**. Search queries are highly ephemeral and are expected to reset when the component is closed or unmounted. |
| **UI Affordances** (Collapsibles, expanded sections, copy flags) | Component `@state` | **Intentional Exception**. Purely visual layout state. Resetting to default on recreation is desired. |

---

## 6. Test Suite Architecture

The implementation is protected from regressions by a comprehensive, multi-tiered test suite:

### 6.1 Store Unit Invariants (`tests/transient-draft-store.spec.ts`)
Pins the low-level behavior of `TransientDraftStore` inside a browser environment (`file://` browser unit test fixture):
- **Round-Trip and Key Isolation**: Validates that saved objects retrieve identically and that namespaces/scope keys do not collide.
- **Tombstone Behavior**: Assures `clear()` blocks write operations of equal/lesser generation, while `forget()` deletes the tombstone and lets fresh saves through.
- **Last-Write-Wins (`gen`)**: Confirms that writes with stale generations are discarded.
- **LRU and Size Protection**: Confirms oldest keys are evicted when limits are reached, and that oversize entries are discarded without throwing exceptions.
- **Degradation**: Assures that when `Storage` is disabled or throws, store methods safely no-op without surfacing exceptions.

### 6.2 Widget Element Unit Tests (`tests/ask-user-choices-widget.spec.ts`)
Validates `<ask-user-choices-widget>` lifecycle hooks, Lit rendering outputs, tab selections, and keyboard navigation.

### 6.3 Browser E2E Scenarios (`tests/e2e/ui/ask-user-choices-ui.spec.ts`)
Executes browser automation tests on a live server instance:
- `pre-submit selections survive reload`: Fills out an ask draft, reloads, and verifies radio options and typed "Other" strings are restored.
- `pre-submit selections survive cache-evicted session switch`: Fills out a draft, switches through 11 different sessions to force the origin session out of the LRU `sessionCache` (destroying the DOM element), switches back, and verifies the selections are successfully restored.
- `submit clears the draft — no resurrection after reload`: Submits the widget, reloads, and verifies the card remains read-only without resurrecting scratch states.
- `pre-submit drafts are per-tab isolated`: Opens two separate tabs on the same session, verifies that unsaved draft state does not leak from tab 1 to tab 2, and that once tab 1 submits, tab 2 converges into a read-only state.

### 6.4 Attachment Race Unit Tests (`tests/agent-interface-attachment-draft-race.test.ts`)
Uses a mock behavioral harness modeled on the `AgentInterface` component to simulate and verify async timing:
- **Clear-After-Send**: Assures that an async IndexedDB lookup resolving after message clearance is safely ignored and doesn't resurrect files.
- **Set-During-Load**: Assures that user-added attachments are not overwritten by a slow load resolving afterwards.
- **Session-Switch-During-Load**: Assures that drafts resolving for session 1 are not applied to session 2 when a fast switch occurs.

---

## 7. Delivery File Map

| File Path | Role |
|---|---|
| `src/ui/storage/transient-draft-store.ts` | The core factory function `createTransientDraftStore` and storage manager. |
| `src/ui/components/AskUserChoicesWidget.ts` | The widget integrated with `TransientDraftStore` for pre-submit ask persistence. |
| `src/ui/components/AgentInterface.ts` | The chat interface incorporating the `_attachmentDraftGen` resurrection guard. |
| `tests/transient-draft-store.spec.ts` | Unit tests for standard `TransientDraftStore` behaviors. |
| `tests/agent-interface-attachment-draft-race.test.ts` | Unit tests modeling the async resurrection race in `AgentInterface`. |
| `tests/e2e/ui/ask-user-choices-ui.spec.ts` | End-to-end reload, eviction, and isolation tests for the ask widget. |
| `docs/design/transient-draft-state.md` | This architectural reference and design guideline. |
