# Composer Draft Persistence

This document explains the architecture and design of the composer draft persistence mechanism. It outlines how unsent prompt text and attached files (pasted/dragged images and documents) are preserved across session switching, page reloads, and WebSocket reconnects without risk of draft loss.

---

## 1. Problem Solved

Prior to this implementation, the message composer suffered from two distinct draft-loss bugs:

### Bug 1: Unsaved Composer Attachments
Attached files (pasted/dragged images or documents) were held solely within the transient memory state of the local `<message-editor>` element. Because they were never lifted to a persistent state or synchronized with the backend:
- Switching sessions evicted the `<message-editor>` instance from the client-side LRU cache (`sessionCache`, `SESSION_CACHE_MAX = 10`), losing attachments.
- Reloading the page or performing hard refreshes completely destroyed all pending attachments.
- Any Lit re-render that temporarily toggled the editor's read-only/preparing state recreated the DOM element, losing attachments instantly.

### Bug 2: Generation-Counter Desync (Post-Round-Trip Draft Loss)
Prompt text drafts are synchronized with the server via a debounced REST API, using a monotonic generation (`gen`) counter to reject out-of-order stale writes (e.g., preventing a late autosave from overwriting a newer tombstone after a message was already sent).

However, the client-side draft manager reset its generation counter `_draftGen` to `0` on every session bind. This caused a critical desync:
1. In visit 1, the user typed text, and the server stored the draft at `gen = 2`.
2. The user switched away, then switched back.
3. The client bound the session again, resetting its `_draftGen` to `0`.
4. The user appended more text. A save was triggered at `gen = 1`.
5. The server compared the incoming `gen = 1` with the existing `gen = 2`. Since `1 < 2`, the server silently discarded the write.
6. When the user switched away or back, the client restored the stale `gen = 2` draft from the server, clobbering the freshly edited local text.

---

## 2. Storage Design & Architectural Overview

Draft preservation splits storage based on data size and serialization costs to prevent memory and file bloat.

```
┌────────────────────────────────────────────────────────────────────────┐
│                            Message Composer                            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                  ┌─────────────────┴─────────────────┐
                  ▼                                   ▼
          [ Prompt Text ]                      [ Attachments ]
                  │                                   │
      ┌───────────┴───────────┐                       ▼
      ▼                       ▼             ┌───────────────────┐
[ sessionStorage ]     [ Server Draft ]     │ IndexedDB Store   │
 (Synchronous,          (Debounced REST,    │ (PromptDraft      │
  survives tab           sessions.json)     │  AttachmentsStore)│
  HMR/re-renders)                           └───────────────────┘
```

### Prompt Text Storage
- **Primary Source of Truth**: Keyed under the session's drafts map in the server's `sessions.json` file.
- **Client Cache**: Synchronously mirrored in browser `sessionStorage` (`bobbit_draft_<sessionId>`). This ensures the text is instantly available when Lit re-renders recreate the editor DOM.
- **Why**: Text drafts are lightweight (a few kilobytes at most) and easily serialized inline in the session configuration.

### Attached Files Storage
- **Primary Source of Truth**: Stored client-side in IndexedDB using `PromptDraftAttachmentsStore`.
- **Why**: Attached images (such as pasted screenshots) are base64-encoded blobs that can easily measure in megabytes. Storing these inside the server's inline `sessions.json` or transmitting them over REST autosaves on every keystroke would bloat memory, exhaust network bandwidth, and corrupt file performance. Keeping them in IndexedDB isolates the payload entirely while keeping them durable across page reloads.

---

## 3. Attachment Draft Store (`PromptDraftAttachmentsStore`)

The `PromptDraftAttachmentsStore` manages file persistence in IndexedDB.

### Database Schema
- **Store Name**: `prompt-draft-attachments`
- **Primary Key**: `sessionId` (each session maintains one list of pending files)
- **Indices**: `updatedAt` (epoch milliseconds of the last write, used for LRU eviction)

### Eviction and Safety Caps
To prevent IndexedDB from growing unbounded due to stale session drafts, the store enforces strict budget caps during every write operation:

1. **Per-Session File Cap** (`MAX_FILES_PER_SESSION = 10`): Slices incoming arrays to retain at most 10 attachments, matching the UI's `MessageEditor.maxFiles` rule.
2. **Session Count Cap** (`MAX_SESSIONS = 20`): A best-effort limit on how many historical sessions can retain file drafts. When exceeded, the oldest records (by `updatedAt`) are evicted.
3. **Total Byte Cap** (`MAX_TOTAL_BYTES = 64 * 1024 * 1024` / 64 MB): Measures base64 character counts in attachment properties (`content`, `preview`, `extractedText`). If the store exceeds 64 MB across all drafts, it evicts the oldest sessions first.
4. **Safety Filter**: The session currently being written (`keepSessionId`) is explicitly excluded from the candidate eviction list, guaranteeing the active draft is never self-evicted during its write.

---

## 4. Attachment State Lifting (`AgentInterface`)

To survive Lit component recreation, the file state is lifted out of the transient `<message-editor>` DOM element and managed within the parent `<agent-interface>` component.

### Data Flow & Component Binding

```
┌─────────────────────────────────────────────────────────┐
│                     AgentInterface                      │
│   @state() _attachments: Attachment[]                   │
└───────────┬─────────────────────────────▲───────────────┘
            │                             │
    (Bound Property)                (Composed Event)
    .attachments=${this._attachments}   onFilesChange=${...}
            │                             │
┌───────────▼─────────────────────────────┴───────────────┐
│                     MessageEditor                       │
└─────────────────────────────────────────────────────────┘
```

1. **Binding**: `AgentInterface` holds the reactive `_attachments` array. It binds this array into `<message-editor>` via the `.attachments` property and listens for updates via the editor's `onFilesChange` callback.
2. **Loading (`_loadAttachmentDraft`)**: Whenever the active session changes (including slow-path cache-evicted loads and page refreshes), `AgentInterface` fires an asynchronous read from `PromptDraftAttachmentsStore`. It guards this with `_attachmentDraftSessionId` to ignore late async loads if the user switched sessions in the meantime.
3. **Saving (`_setAttachmentDraft`)**: When the user adds or removes files, `AgentInterface` updates its local state and writes to IndexedDB immediately. This is debounce-free because file modifications are infrequent, user-initiated events.
4. **Clearing (`_clearAttachmentDraft`)**: On successful message transmission or when running a `/compact` command, the draft attachments are deleted from IndexedDB to prevent resurrection.

---

## 5. Text Draft Generation Guard & Freshness Synchronization

To resolve **Bug 2**, the client-side generation tracking and the server-side staleness guard were aligned to ensure post-round-trip edits are never rejected.

### Synchronous Seeding & sessionStorage Mirroring
On binding a session (`_bindPromptDraftSession`), the client must synchronously seed `_draftGen` above any previously written generation:
- The highest generation ever written for a session's text draft is mirrored in `sessionStorage` (`bobbit_draft_gen_<sessionId>`).
- On bind, `_draftGen` is initialized to:
  $$\_draftGen = \max(\_draftSendGen, \_loadStoredDraftGen(sessionId))$$
- This guarantees that the very first save initiated after switching back to a session carries a generation number higher than what the server already holds, bypassing the server's rejection guard.

### Async Restore Backstop
When the asynchronous `_restorePromptDraft` finishes loading the server draft, it applies a second backstop to `_draftGen` using the actual loaded server generation:
$$\_draftGen = \max(\_draftGen, loadedGen, \_draftSendGen)$$
This handles cross-reload and cross-tab scenarios where the client's `sessionStorage` mirror might be absent but the server contains a higher generation.

### Freshness Guard (Local Overwrites Server)
To prevent a stale server draft from overwriting newer local edits, `_restorePromptDraft` implements a strict freshness check:
1. **Edits during load**: If the user typed in the composer *while* the server read was in-flight, `_draftTouchedSinceBind` is set to `true`, and the server draft is discarded.
2. **Local Mirror Divergence**: If the synchronous `sessionStorage` mirror holds different, non-empty content compared to the loaded server draft, the server draft is considered stale. The client retains the local content and immediately flushes it to the server to force convergence.

### Tombstone-on-Send Anti-Resurrection
On message send, the client:
1. Increments `_draftGen` to a fresh level and records it as `_draftSendGen` (and persists it to `sessionStorage`).
2. Clears local drafts from `sessionStorage` and IndexedDB.
3. Sends an empty-text draft write containing the new `_draftSendGen` to the server.
4. This "tombstone" ensures that any pre-send autosaves (which carry a lower generation number) arriving late at the server are rejected, preventing sent drafts from mysteriously reappearing in the composer.

---

## 6. User-Visible Guarantees

The combined design guarantees the following behaviors:
- **No Attachment Loss**: Pasting an image into session A, switching to session B, navigating through 15 other sessions (evicting A from RAM), and returning to A fully restores the attached image.
- **Durable Page Reloads**: Reloading the browser tab or hitting a hard refresh with a pending text draft and attached files fully restores the composer state.
- **Edit Resilience**: Typing text, switching tabs, returning, appending more text, and immediately switching away preserves every single character.

---

## 7. Regression Tests

Automated coverage enforces all invariants described in this document.

### Focused Unit Tests (`tests/session-store.test.ts`)
- `draft gen staleness guard`:
  - *accepts a strictly increasing gen*: Newer writes overwrite older ones.
  - *silently discards a stale (lower-gen) write*: Stale writes return `true` but do not mutate.
  - *accepts an equal-gen write*: Allows idempotent overwrites at the same generation.
  - *does not resurrect a tombstone*: Prevents a stale text save after an empty-text send from resurrecting.
  - *isolation and persistence*: Ensures guards operate per draft type independently and survive store reload.
- `attachment draft storage contract`:
  - *round-trips and isolates*: Verifies attachment drafts stay isolated from prompt text and survive store reloads.
  - *applies gen guard*: Ensures attachment-type drafts are subject to the same monotonic sequence checks.

### Browser E2E Tests (`tests/e2e/ui/stories-drafts.spec.ts`)
- `CT-02-b` (*Pasted image draft survives fast switch and reload*): Asserts attachment survival through fast session transitions and browser reloads.
- `CT-02-f` (*Pasted image draft survives cache-evicted slow-path switch*): Swings through 11 other sessions to evict the target session from the RAM cache, then asserts attachments are restored on slow-path recreation.
- `CT-02-h` (*Text survives gen-desync round-trips*): Types text, switches tabs, appends text, switches away immediately in the same tick (testing quick debounces), and asserts both paragraphs are safely stored and restored.

### E2E REST API Tests (`tests/e2e/draft-api.spec.ts`)
- Validates the REST endpoints (`PUT`, `GET`, `DELETE` on `/api/sessions/:id/draft`) correctly reject lower-gen payloads with status `200` (silently discarded) while accepting equal-or-higher-gen payloads and correctly cleaning drafts.
