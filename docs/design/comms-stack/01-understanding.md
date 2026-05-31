# Bobbit Real-Time Comms Stack — Consolidated Understanding (Reliability/UX Audit, Step 1)

> Single authoritative map of the prompt → WS → gateway → RPC → LLM → events → reducer → render
> pipeline, reconciled from seven independent layer maps. File:line anchors are load-bearing.
> "Step-2 verification" flags hypotheses that still need a reproduction or a trace before they
> count as proven defects.

---

## 0. How to read this document

- **§1** is the end-to-end sequence narrative (one read, keystroke → pixel).
- **§2** is per-layer detail (data flow, the few facts that resolve contradictions between maps).
- **§3** is the consolidated, **de-duplicated** risk-seam table sorted by severity, each tagged
  with a symptom family and whether it needs Step-2 verification.
- **§4** is the invariant ledger and the tests that pin each one (and the gaps where no test exists).

Symptom families used throughout: `duplicate-render`, `image-attach`, `flush-delay`,
`transient-failure`, `reorder`, `perf-resource`, `other`.

A recurring theme across all seven layers: **several "single-slot" or "single-channel" designs
(one `_pendingAttachments` field, one `send()` with no outbox, one unbuffered seq-less broadcast
channel) are each surfaced independently by 3-5 layers.** Those are collapsed here into one root
cause apiece so the audit doesn't fix the same bug five times.

---

## 1. End-to-end sequence narrative

### 1.1 Keystroke → intent (UI composer)

1. A key lands in `<message-editor>`'s `handleKeyDown` (`src/ui/components/MessageEditor.ts:338`).
   Plain **Enter without Shift** calls `e.preventDefault()` and, if `!processingFiles` and there is
   text or attachments, `handleSend()` (`MessageEditor.ts:362-366`).
   **There is no `e.isComposing` / `keyCode===229` guard** — an IME commit-Enter also sends.
2. `handleSend` (`MessageEditor.ts:454-465`) snapshots `const text = this.value`, dispatches a
   `message-send` event (draft cleanup), fires `this.onSend?.(text, this.attachments)`, resets
   history, and fire-and-forgets `addToHistory(text)`. **`handleSend` does not clear the textarea** —
   clearing is deferred to the consumer.
3. Attachments were already encoded at attach time by `loadAttachment`
   (`src/ui/utils/attachment-utils.ts:47-195`): file → ArrayBuffer → **synchronous chunked base64**
   (`String.fromCharCode(...chunk)` + `btoa`, lines 88-95). Images set `preview = content`
   (lines 150-160); PDF/DOCX/PPTX/text get `extractedText` and their base64 `content` is **not**
   used as model image data.

### 1.2 Intent → WS frame (UI → client transport)

4. `onSend` is wired in `AgentInterface` to call `this.sendMessage(input, attachments)`
   **without `await`** (`src/ui/components/AgentInterface.ts:2111-2113`).
5. `sendMessage` (`AgentInterface.ts:1421-1510`) early-returns on empty input, handles `/compact`
   inline, then for the non-streaming case runs **blocking awaits** —
   `await providerKeys.get(provider)` (1466), maybe `await onApiKeyRequired(provider)` (1475),
   then `await onBeforeSend()` (1486). **Only after those resolve** does it clear the editor
   (`value=""`, `attachments=[]`, lines 1490-1491), `_scrollToBottom()`, and call `session.prompt(...)`
   with a `UserMessageWithAttachments` when attachments exist (1499-1506) else the bare string (1508).
   During that async gap the textarea still holds the text and is still enabled.
6. `RemoteAgent.prompt` (`src/app/remote-agent.ts:814-885`): `extractText` → `text`; pull
   `attachments`; build `imageData` by **filtering** attachments to `type==="image" && content` and
   mapping to `{type:"image",data,mimeType}` (829-831) — documents are excluded. Detect
   `/walkthrough-pr` short-circuit (835-844). Stash `this._pendingAttachments = attachments` (847,
   **single slot, unconditional overwrite**) and `_pendingSkillExpansions` (851-854).
   **If `!isStreaming`**, build an optimistic row `id = optimistic_<Date.now()>_<rand>` and dispatch
   `optimistic-prompt` + `emit({type:"message_end"})` (861-877). Finally
   `send({type:"prompt", text, images?, attachments?})` (879-884).
7. `send()` (`remote-agent.ts:1253-1259`) **silently drops the frame** (console.warn only) when
   `ws.readyState !== OPEN`. There is **no outbox / retry** — the optimistic bubble is already
   rendered and the editor is already cleared.

### 1.3 WS frame → server enqueue

8. Server `ws.on("message")` parses (`src/server/ws/handler.ts:278-285`), enforces auth-first
   (288-318), routes by type (531). A `prompt` resolves slash-skill expansions on the host
   (568-573) and calls `sessionManager.enqueuePrompt(sessionId, originalText, {images, attachments, ...})`
   (581-586). The full base64 `attachments` array rides the WS frame even though only `images` are
   used as model input downstream.
9. `enqueuePrompt` (`src/server/agent/session-manager.ts:1707`) gates on error-state
   (1747-1794, incl. `MAX_CONSECUTIVE_ERROR_TURNS` park at 1757), then:
   - idle + empty queue → `dispatchDirectPrompt` (2061) → `rpcClient.prompt(text, images)` (2075);
   - else `promptQueue.enqueue` (`prompt-queue.ts:19`) + `broadcastQueue` (1688, **re-serializes
     and persists full base64 image data on every queue mutation**).
   A `steer` while streaming bypasses the queue → `deliverLiveSteer` (1834) → `_dispatchSteer`
   (1919): push `batchText` onto the `inFlightSteerTexts` shadow ledger (1937) **before** awaiting
   `rpcClient.steer(batchText)` (no images), rollback on RPC failure (1946-1951).

### 1.4 Server → agent subprocess → LLM (RPC bridge)

10. `RpcBridge.prompt` (`src/server/agent/rpc-bridge.ts:392-397`) builds `{type:"prompt", message, images}`
    (no `streamingBehavior`) and `sendCommand` (371-388) writes `JSON.stringify(msg)+"\n"` to child
    stdin with a **30s timeout**, registering a pending entry keyed `req_<n>`.
11. The pi-coding-agent subprocess (`--mode rpc`) parses one JSON/line, calls the AI gateway.
    For aigw, `writeAigwModelsJson` (`aigw-manager.ts:343`) routes Claude→Bedrock Converse,
    others→OpenAI-completions; the `x-opencode-session` header is **shell-resolved per call** via a
    `!node -e ...` command (387-390) — a subprocess fork per LLM request.

### 1.5 Agent → server events (RPC bridge → EventBuffer → broadcast)

12. Agent writes JSONL to stdout. `RpcBridge` stdout handler **decodes each Buffer independently**:
    `this.handleData(chunk.toString("utf-8"))` (`rpc-bridge.ts:299-301`) — a multibyte char split
    across chunk boundaries is corrupted before line-buffering. `handleData` (585-614) accumulates
    `lineBuffer`, splits on `\n`, strips trailing `\r`, `JSON.parse`s each line
    (`catch{continue}` silently drops bad lines), and routes `response` → pending Map vs everything
    else → `eventListeners`.
13. The live listener (`session-manager.ts:3440`) runs `handleAgentLifecycle` (which calls
    `broadcastStatus` FIRST — see §1.8) then `truncateLargeToolContent` then `emitSessionEvent`
    (507). `emitSessionEvent` splices pending skill-expansions, pushes the event into `EventBuffer`
    assigning a **monotonic per-session `seq` + wall-clock `ts`** (`event-buffer.ts:27-34`, 1000-entry
    ring), and `broadcast`s `{type:"event", data, seq, ts}` (510-522).
14. `broadcast()` (`session-manager.ts:399`) JSON-stringifies once and per-client applies the
    **ws-overflow-guard** (405-430, send-and-defer-check → terminate on a persistent spike).
    **NOTE the divergence:** a *second*, handler-local `broadcast()` (`handler.ts:178`) used for
    `task_changed`/`client_joined`/`set_image_model` has **no overflow guard and no seq**.

### 1.6 Server → client (WS ingestion + seq gate)

15. Client `case "event"` (`remote-agent.ts:1391-1435`) is the core ingestion gate:
    - `seq===undefined` → compat dispatch directly, **without advancing `_highestSeq`** (1393-1399);
    - first seq'd frame baselines `_highestSeq=seq-1`, `_seqInitialized=true` (1401-1408);
    - `seq<=_highestSeq` → silent drop (dedup, 1409-1413);
    - `seq!==_highestSeq+1` → push to `_pendingEvents`, sort, **overflow at 500 → reset
      `_highestSeq=0`, `_inResumeFallback=true`, `requestMessages()`** (1414-1428);
    - contiguous → `_highestSeq=seq`, `handleAgentEvent(data)`, `_drainOrderedEvents()` (1429-1434).
16. Top-level frames that consumed a server `seq` via `pushFrame` (tool_permission_needed) route
    through `_advanceTopLevelSeq` (1096-1121) so the next event isn't stranded as a permanent gap;
    on a gap it sets **`_highestSeq=seq`** (1115) — *asymmetric* with the overflow path's
    `_highestSeq=0` (1423). `resume_gap` resets `_highestSeq=lastSeq` (1443).
17. `_inResumeFallback` is **set** at 1114 / 1422 / 1445 but **read only at 1378** (snapshot handler,
    to clear itself). The `case "event"` path never reads it — so during the snapshot-refresh window,
    contiguous live events keep flowing into the reducer and the arriving snapshot re-applies them.

### 1.7 Client reducer → state (`message-reducer.ts`)

18. `handleAgentEvent` (`remote-agent.ts:2001`) mutates `_state` BEFORE emitting.
    - `message_update` (2087): stores `_state.streamingMessage`; for ordinary text streams runs two
      proposal scans per delta; throttle (500ms) only applies to `_truncated` tool blocks (2099-2105,
      `break` drops the update with no trailing flush).
    - `message_end` (2116-2234): normalize proposals, compute `streamingMessageId` (only when the row
      **has tool calls**, 2178), **enrich the FIRST `role:"user"` echo** with `_pendingAttachments`
      (2200-2207) and `_pendingSkillExpansions` (2208-2215), then `apply({type:"live-event"})`.
19. `apply()` (807) runs the pure reducer and mirrors `reducerState.messages → _state.messages`.
20. `reduce` (`message-reducer.ts:183`):
    - **live-event** (188-241): replace-by-id; reconcile optimistic vs echo by **id-match first**,
      then **exact whitespace-sensitive `extractText` equality** when the optimistic id starts with
      `optimistic_` (211-232, removes only the FIRST text match); stamp `server,seq,tick`; sort by
      `(_order,_insertionTick)`.
    - **snapshot** (243+): stamp `_order` (explicit, else `SNAPSHOT_ORDER_FLOOR+i`); build id /
      toolCallId / multiset-(role|text) equivalence sets; survivor pass with the **H3 guard**
      (`_order>0 && _order>serverMaxOrder` survives). `enrichUserMessage` (164-178) reconstructs
      attachments **only from `content` image chunks** — never from the `attachments` array and never
      for documents. Optimistic rows survive a snapshot **unless `serverIds.has(m.id)`** (403-408) —
      **never deduped by text on the snapshot path**.

### 1.8 Status channel (parallel to the event channel)

21. Status is a separate, **unbuffered, seq-less** channel. `broadcastStatus`
    (`session-status.ts:46-60`) is the single server writer: it mutates `session.status`,
    **bumps `statusVersion`**, and broadcasts a `session_status` frame. Called at ~15 transition
    sites. `_emitStatusHeartbeat` (`session-manager.ts:811`) re-broadcasts current status every 15s
    **without** bumping `statusVersion`.
22. Client `case "session_status"` (`remote-agent.ts:1450-1489`) is the SOLE live writer of
    `_state.status`: idempotent drop when `v<=lastStatusVersion` (still fires `_maybeReplayGrant` +
    `onStatusChange`), gap detection `v>last+1` → `status_resync` then apply, normal apply sets
    status + timing + `_isAborting`. `isStreaming`/`isArchived`/`isPreparing` are **getters over
    `_state.status`** (519-533), so the Stop button and the sprite cannot structurally diverge — but
    the status value itself can still be **transiently wrong** between an instant `streaming` frame
    and a dropped/late `idle` frame, with the 15s heartbeat as the only convergence.

### 1.9 Render (state.messages → DOM)

23. **Two independent flush schedulers.**
    - **PATH A** — global `renderApp()` (`src/app/state.ts:640`) is rAF-coalesced (one paint/frame).
    - **PATH B** — `AgentInterface` does **not** route through `renderApp()`; it calls
      `_updateAndPin()` → Lit `requestUpdate()` + `updateComplete.then(pin)` from ~10 event branches
      (`AgentInterface.ts:722-734`, called 1038-1127). `<streaming-message-container>` has a **third**
      rAF batcher in `setMessage()` (`StreamingMessageContainer.ts:262-307`).
24. **Transcript split:** finalized rows live in `<message-list>`; the in-flight assistant row lives
    in `<streaming-message-container>`. `visibleMessages` (`AgentInterface.ts:1547-1555`) drops the
    row whose id equals `streamingMessageId` OR is reference-equal to `streamingMessage`. The reducer
    stamps the SAME synthetic id (`computeStreamingMessageId`, `streaming-message-id.ts:21`) — but
    **only when the row has tool calls**; an id-less plain-text assistant row relies solely on the
    reference check, which a snapshot resync (fresh object identity) breaks.
25. `<message-list>` (`MessageList.ts:147-369`) builds keyed render items (`keyFor`, 87-92: id-based
    with `synth:<origin>:<order>:<tick>` fallback) and `repeat()`s. With `deferOffscreenRender` on
    (default), rows beyond the bottom 8 are `<deferred-block>` placeholders until an
    IntersectionObserver fires; only Ctrl+F force-resolves all.
26. Image attachments render as inline `data:<mime>;base64,<preview>` (`AttachmentTile.ts:49-55`) on
    `user-with-attachments` rows only; `UserMessage` (`Messages.ts:183-195`) has **no render branch
    for bare image content blocks**.

---

## 2. Per-layer detail

### Layer 1 — Composer & prompt send (UI → WS client)
Owns the keystroke→`send()` path, attachment encoding, optimistic-row creation, and echo
reconciliation enrichment. Critical facts: the editor is cleared *after* blocking awaits with the
async-send not awaited (no in-flight lock); `_pendingAttachments` is a single overwrite-on-each-send
slot; the optimistic echo exists only when idle. Reconciliation: id-match then exact-text fallback.

### Layer 2 — Client WS transport & event ingestion (`remote-agent.ts` + `message-reducer.ts`)
Owns the seq dedup/reorder/overflow gate, reconnect resume, `_advanceTopLevelSeq`, and the reducer
dispatch. Critical facts: `_inResumeFallback` is write-mostly (set 3×, read once, never in the event
path); the overflow path resets `_highestSeq=0` while leaving `_seqInitialized=true` (asymmetric with
`resume_gap`'s `=lastSeq` and `_advanceTopLevelSeq`'s `=seq`); the seq sequencer's two pinning tests
are **hand-copied HTML fixtures**, not the production `handleServerMessage`.

### Layer 3 — Render pipeline & flush (state.messages → DOM)
Owns the two-surface transcript split, the three flush schedulers, deferred-block offscreen render,
and stick-to-bottom. Critical facts: `streamingMessageId` dedup is only stamped for tool-call rows;
the truncated-block throttle can drop the final pre-`message_end` partial with no trailing flush; the
`_refreshJumpToLastPromptButton` `getBoundingClientRect` loop runs per burst event.

### Layer 4 — Server WS handler & event broadcast
Owns `emitSessionEvent` (the canonical seq-stamping emit), the production `broadcast()` overflow
guard, `EventBuffer`, resume/`canResumeFrom`, snapshot splicing (`spliceInFlightMessage` /
`spliceInFlightSteers`), `broadcastQueue`, and the single `pushFrame` perm-seq site. Critical facts:
**two** `broadcast()` implementations exist (only the session-manager one is guarded); **three**
event broadcasts (`auto_retry_pending` 2489, `auto_retry_cancelled` 2526, `forceAbort agent_end`
5731) bypass `emitSessionEvent` (no seq, no buffer, no replay); `broadcastQueue` re-sends/persists
full base64 image data on every mutation; batched steered prompts forward only `steered[0].images`.

### Layer 5 — Agent RPC bridge & remote LLM
Owns the JSONL framing, the 30s prompt-ack timeout, auto-retry policy, restart/respawn + seq seeding,
and side-channel LLM calls. Critical facts: per-chunk `toString("utf-8")` decode (multibyte split
hazard); 30s ack timeout can spuriously re-dispatch a slow-but-accepted prompt (pending entry deleted
on timeout, so the late ack can't guard the double-send); `wasStreaming` continuation re-prompt fires
on every `restoreSession` including routine grant/role respawns; `switch_session` restore replays the
full history through the seq-stamping emit, inflating `seq` past the seeded frame-of-reference.

### Layer 6 — Image & attachment end-to-end
Owns the composer→model→echo→snapshot→render image lifecycle. Critical facts: bare image content
blocks never render unless role is exactly `user-with-attachments` with a non-empty `attachments`
array; the single `_pendingAttachments` slot mis-attaches across concurrent image prompts;
`enrichUserMessage` restores image chunks only (documents lose their tile, non-PNG mislabeled as
`image/png`); WS `maxPayload` is the ws default (100 MB) while the composer allows 10×20 MB raw —
a multi-image base64 frame can exceed it and tear down the socket (close 1009).

### Layer 7 — Reliability, status & transient failures
Owns the status single-writer + version gate, heartbeat self-heal, abort/forceAbort, auto-retry, and
compaction races. Critical facts: status and `agent_start`/`agent_end` travel on **two independent
channels** with no shared ordering (status applies instantly; the seq'd lifecycle event can buffer
behind a gap, leaving `streamingMessage` cleanup — which lives only in the seq'd handler — stranded);
`forceAbort` no-ops unless `status==='streaming'`, so a **server-side wedged-streaming** state
(bridge dead, no `agent_end`) has no recovery short of `restart_agent`; the heartbeat and
`status_resync` real code paths are pinned only by **inline-mirror** unit tests.

---

## 3. Consolidated risk-seam table (de-duplicated, sorted by severity)

De-duplication notes:
- **S1 (single `_pendingAttachments` slot)** absorbs the separately-reported seams from Layers 1, 2,
  3, 5, and 6 — one root cause at `remote-agent.ts:847/2200`.
- **S2 (silent `send()` drop, no outbox)** absorbs Layers 1, 2, and 6.
- **S5 (seq-less bypass broadcasts)** absorbs Layers 4, 5, and 7.
- **S6 (bare-image-block render gap)** and **S1** are distinct (render branch vs. carry-through slot)
  but co-fire — both must be fixed for image reliability.

| # | Seam | Where (file:line) | Symptom | Severity | Step-2? | Why it matters (one line) |
|---|------|-------------------|---------|----------|---------|---------------------------|
| S1 | Single `_pendingAttachments` slot mis-attaches / drops thumbnails across concurrent or queued-while-streaming image prompts; documents never reconstructed on reload | `remote-agent.ts:847`, `:2200-2207`; `message-reducer.ts:164-178` | image-attach | **high** | no | Second image send overwrites the slot before the first echo lands → wrong/no tile; PDF/DOCX tiles vanish on reload |
| S2 | `send()` silently drops the prompt frame when WS not OPEN — optimistic bubble shown + editor cleared, but server never received it; no outbox/retry | `remote-agent.ts:1253-1259` (+ optimistic at 861-877; clear at `AgentInterface.ts:1490`) | transient-failure | **high** | no | User believes the (possibly image-bearing) prompt sent during reconnect; it was silently lost |
| S3 | No IME composition guard on Enter-to-send | `MessageEditor.ts:362` | transient-failure | **high** | no | CJK/dead-key commit-Enter fires a partial/garbled prompt and can produce a spurious second message |
| S4 | onSend not awaited + editor cleared only after blocking awaits ⇒ async window with text still present & textarea enabled, no in-flight lock | `AgentInterface.ts:2111-2113`, `:1461-1491`; `MessageEditor.ts:455` | duplicate-render | **high** | **yes** | A fast second Enter re-fires `onSend` with the same snapshot → duplicate prompt (needs repro to confirm no higher-level guard) |
| S5 | Three event broadcasts bypass `emitSessionEvent` (no seq, not buffered, not replayed): `auto_retry_pending`, `auto_retry_cancelled`, `forceAbort agent_end` | `session-manager.ts:2489`, `:2526`, `:5731` | reorder | **medium→high** | **yes** | Seq-less frames dispatch immediately (client compat path doesn't advance `_highestSeq`), reordering stop/retry relative to buffered content; banner orphaned on reconnect |
| S6 | Bare image content blocks never render unless role is exactly `user-with-attachments` with non-empty `attachments` | `Messages.ts:183-195` | image-attach | **high** | **yes** | If the server echo arrives role `user` with image blocks and the slot was consumed/null, the image has no render branch (depends on real agent echo shape — Step-2) |
| S7 | `streamingMessageId` dedup only stamped for tool-call rows; id-less plain-text assistant row relies on object-identity check that snapshot resync breaks | `AgentInterface.ts:1547-1554`; `remote-agent.ts:2178-2192` | duplicate-render | **high** | no | A snapshot resync can append a duplicate plain-text assistant bubble (the new-tab dup class) |
| S8 | Server-side wedged-streaming has no recovery: `forceAbort` no-ops unless `status==='streaming'`, heartbeat faithfully re-broadcasts the wedged truth | `session-manager.ts:5667` | transient-failure | **high** | **yes** | If the bridge dies without `agent_end`, Stop does nothing and only `restart_agent` recovers (needs a way to provoke a missing `agent_end`) |
| S9 | `_pendingEvents` overflow resets `_highestSeq=0` while `_seqInitialized` stays true ⇒ every later live event re-buffers as a gap; snapshot never re-baselines `_highestSeq` | `remote-agent.ts:1418-1425` | flush-delay | **medium→high** | **yes** | Live streaming can stall (buffer refills to 500, re-fires overflow) until something re-baselines; contrast `resume_gap`'s `=lastSeq` (needs forced-overflow repro) |
| S10 | Forced-snapshot fallback double-applies live events (no `_inResumeFallback` guard in the event path) | `remote-agent.ts:1378-1382` vs `1391-1435`; reducer survivor `message-reducer.ts:362-401` | duplicate-render | **medium** | **yes** | Id-less + text-empty + non-toolCall rows (pure thinking chunk, toolResult with omitted toolCallId) fall to the H3 survivor branch and render twice (needs a fixture that lands such a row in the window) |
| S11 | Two independent flush schedulers (global rAF vs container rAF vs Lit microtask) can momentarily show a row in neither surface at the streaming→finalized hand-off | `AgentInterface.ts:1091-1127`; `StreamingMessageContainer.ts:286` | flush-delay | medium | **yes** | Structural cause behind both flush-delay and duplicate hand-off glitches (needs timing repro) |
| S12 | Status (`session_status`) and `agent_start`/`agent_end` travel on two unordered channels; status applies instantly while the seq'd lifecycle event can buffer | `session-manager.ts:2241` vs `:3456`; cleanup only in `remote-agent.ts:2042` | flush-delay | medium | **yes** | UI shows idle while stale `streamingMessage` still renders until the gap fills or the 15s heartbeat converges |
| S13 | 30s prompt-ack timeout can fire on a slow-but-accepted prompt and re-dispatch it; pending entry deleted on timeout so the late ack can't guard the double-send | `rpc-bridge.ts:371-388`; recover at `session-manager.ts:2028-2058` | duplicate-render | medium | **yes** | Auto-compaction / Codex preflight mid-dispatch could delay the ack past 30s → duplicate turn (needs a slow-ack trace) |
| S14 | Per-chunk `chunk.toString("utf-8")` decode corrupts a multibyte char split across two stdout reads | `rpc-bridge.ts:299-301` | flush-delay | medium | **yes** | A dropped `message_end` line → message never reaches UI; dropped `response` → 30s timeout (severity depends on pi's write granularity — Step-2) |
| S15 | `switch_session` restore replays full history through the seq-stamping emit, inflating `seq` past the seeded frame-of-reference → guaranteed client gap → snapshot refresh after every in-place respawn | `session-manager.ts:3456` (unconditional) vs `3382` (seed) | flush-delay | medium | **yes** | Extra round-trip + flush stall per respawn; for >1000-event sessions the ring evicts the resume window (needs a long-session restore trace) |
| S16 | `wasStreaming` continuation re-prompt fires on EVERY `restoreSession`, including routine grant/role-switch respawns | `session-manager.ts:3499-3509` | duplicate-render | medium | **yes** | A respawn-while-streaming injects an unsolicited "continue where you left off" assistant turn (needs confirmation `wasStreaming` is true mid-respawn) |
| S17 | Text-fallback optimistic dedup collapses/duplicates identical prompts; skill-expanded `originalText` vs server `modelText` divergence defeats it | `message-reducer.ts:221-228` | duplicate-render | medium | **yes** | Same text twice or a model-text echo leaves an optimistic row un-removed until a later snapshot (needs the skill-expand echo shape) |
| S18 | Optimistic snapshot survivor deduped by id only, never by text ⇒ same-text optimistic + snapshot before live echo = persistent duplicate | `message-reducer.ts:403-408` | duplicate-render | medium | **yes** | A visibilitychange snapshot landing before the live echo renders the prompt twice (needs the snapshot-before-echo window) |
| S19 | `broadcastQueue` re-serializes & persists full base64 image data on every queue mutation | `session-manager.ts:1688-1694` | perf-resource | medium | no | Multi-MB queued image re-JSON'd + re-sent to all clients + rewritten to `sessions.json` per mutation; can push `bufferedAmount` toward the overflow terminate threshold |
| S20 | Non-image attachments base64-inflated and sent as full bytes over WS + into server memory but never used as model input | `remote-agent.ts:829-831`, `:884`; `handler.ts:583` | perf-resource | medium | no | Up to 10×20 MB redundant document bytes per send; model consumes only `extractedText` |
| S21 | `auto_retry_pending`/`cancelled` unbuffered (no seq, no replay) ⇒ reconnect during backoff orphans a stale "Retrying in Xs" banner | `session-manager.ts:2489`, `:2526`; client `remote-agent.ts:2017/2034` | transient-failure | medium | **yes** | Banner cleared only by `agent_start`/`auto_retry_cancelled`; a cancel-without-following-turn leaves it orphaned (needs reconnect-in-window repro) |
| S22 | Heartbeat & `status_resync` real code paths pinned only by inline-mirror unit tests | `tests/session-manager-status.test.ts:108`, `:151` | transient-failure | medium | no | A regression in the *real* sole self-heal mechanism would pass CI — the missing real-path test IS the bug |
| S23 | Seq sequencer pinned by hand-copied HTML fixtures, not production `handleServerMessage` | `tests/fixtures/remote-agent-seq-dedup.html`, `remote-agent-sequence-hole.html` | other | medium | no | S9 and S10 (the two riskiest branches) are effectively untested; fixtures can silently diverge |
| S24 | `_advanceTopLevelSeq` gap path sets `_highestSeq=seq` and only `requestMessages()` — non-message events in the skipped range (tool exec, compaction, agent start/end side effects) are lost | `remote-agent.ts:1107-1118` | transient-failure | medium | **yes** | Snapshot carries only the message list, not event side effects → stuck spinner / never-clearing streaming flag (needs a top-level-frame gap repro) |
| S25 | Resume across an un-granted tool-permission `pushFrame` seq hole strands the pending buffer until 500-event overflow | `handler.ts:917-934`; `event-buffer.ts:41-43` | flush-delay | medium | **yes** | Disconnect straddling an ungranted permission → resume can't fill the hole (perm only re-sent on full attach) → hard streaming stall (narrow window) |
| S26 | Batched steered prompts drop all but `steered[0].images`; `steer()` path forwards no images at all | `session-manager.ts:2104-2139`, `:1923` | image-attach | medium | no | Two queued steers each with a pasted image → only the first image attaches |
| S27 | Steer-batch echo never matches the shadow ledger (joined `batchText` vs per-message SDK echo) ⇒ ledger entry survives to next abort and re-dispatches | `session-manager.ts:1923-1937` vs `1964-1973` | duplicate-render | medium | **yes** | Depends on whether the SDK echoes batched steers as one or N messages (open question — Step-2) |
| S28 | `MAX_CONSECUTIVE_ERROR_TURNS` parks prompts behind human-only Retry; `consecutiveErrorTurns` not reset on implicit-unstick + a missed `auto_retry_cancelled` ⇒ looks frozen | `session-manager.ts:1757`, `:1777` | transient-failure | medium | **yes** | Session silently parks a queue while UI shows idle (needs an error-accretion repro) |
| S29 | Per-reconnect `onReconnect()` REST hydration fan-out (annotations/git/bg) is un-coalesced | `remote-agent.ts:677-693` | perf-resource | medium | no | Flapping mobile connection ⇒ O(reconnects) full history+annotation refetches |
| S30 | `compaction_end` synthesized-from-`response` path can double-fire with the real `compaction_end` | `remote-agent.ts:2333`, `:2340` | duplicate-render | low | **yes** | Second pass computes `durationMs` from a now-null `_compactionStartedAt` (mostly absorbed by reducer dedup) |
| S31 | Large multi-image base64 frame can exceed ws default `maxPayload` (100 MB) and tear down the socket (close 1009) | `server.ts:1071` | transient-failure | medium | **yes** | No guard between the 20 MB/file composer cap and the 100 MB socket cap (needs an actual >100 MB frame to confirm) |
| S32 | `message_update` runs two proposal scans per text delta; throttle only covers `_truncated` blocks | `remote-agent.ts:2087-2113` | perf-resource | low | no | O(messages·length) regex per token on long assistant messages — CPU/GC pressure on low-end devices |
| S33 | Truncated-block throttle `break`s with no trailing flush ⇒ final pre-`message_end` partial may never paint | `remote-agent.ts:2099-2105` | flush-delay | medium | **yes** | Last truncated update inside the 500ms shadow is dropped; user sees stale tool args until the finalized row swaps in |
| S34 | `AgentInterface` re-render bypasses the global rAF coalescer; ~10 branches call `_updateAndPin` ⇒ repeated forced reflows (`getBoundingClientRect` loop) under event bursts | `AgentInterface.ts:722-734`, `:671-713` | perf-resource | medium | **yes** | Competes with PATH A paints; the jump-button loop iterates every `<user-message>` per burst event (needs a long-transcript burst profile) |
| S35 | Synchronous chunked base64 encode of large attachments blocks the main thread at attach time | `attachment-utils.ts:88-95` | perf-resource | low | no | 20 MB image/PDF = hundreds of ms of paste/drop jank |
| S36 | `handler.ts` local `broadcast()` lacks the overflow guard `session-manager.broadcast()` enforces | `handler.ts:178-214` | perf-resource | low | no | `task_changed`/`set_image_model` bursts on a slow client have no terminate/defer protection — the guard invariant isn't global |
| S37 | aigw `x-opencode-session` header runs `child_process` (`!node -e`) on every model request | `aigw-manager.ts:387-390` | perf-resource | low | no | A subprocess fork per LLM call on the hot path; an exec hiccup silently drops the header |
| S38 | `_maybeReplayGrant` re-sends the original prompt on a fixed 200ms delay with no idle-ready confirmation | `remote-agent.ts:1156-1165`, `1450-1492` | transient-failure | low | **yes** | A momentary heartbeat-idle can dispatch the replay into a not-ready session → dropped server-side (guarded against double-fire, not against not-ready) |
| S39 | Deferred-block placeholders mask content from non-Ctrl+F DOM scans (screen reader virtual cursor, in-app search, copy-all of unscrolled region) | `DeferredBlock.ts:175-235` | other | low | no | Content present in `state.messages` but absent from DOM for non-find consumers |
| S40 | Auto-retry timer fire guard checks only `status!=='idle'`, not error/queue state | `session-manager.ts:2499` | duplicate-render | low | **yes** | A queue-drain (steer) that bypasses the cancel path could let a spurious retry inject after the user moved on |
| S41 | `attach` `compaction_start` unicast is seq-less and may duplicate the agent's own seq'd `compaction_start` | `handler.ts:373-375` | duplicate-render | low | **yes** | Two compaction cards if the reducer keys by content/time rather than a stable id |
| S42 | `spliceInFlightSteers` dedup is plain-text multiset ⇒ two identical-text steers collapse | `splice-inflight-message.ts:104-119` | duplicate-render | low | no | Transient under/over-count in a snapshot resync; self-heals on echo flush |
| S43 | `MAX_SPAWN_RETRIES` retry window can leave stale handlers firing while a replacement child spawns | `rpc-bridge.ts:202-262` | transient-failure | low | **yes** | A fast async ENOTCONN could surface a spurious "Agent process exited" on a healthy spawn (narrow Windows fd-pressure timing) |
| S44 | `showLightbox` window listeners + detached base64 `<img>` leak if the overlay is removed without `close()` | `image-utils.ts:67-89` | perf-resource | low | no | Repeated open/navigate cycles accumulate listeners + retained image memory |
| S45 | Tool-result image blocks lacking `mimeType` silently dropped (no default, unlike `enrichUserMessage`) | `image-utils.ts:113` | image-attach | low | no | An agent/tool image with `data` but no `mimeType` renders nothing |
| S46 | Snapshot image restore hardcodes `image-N.png` / defaults `image/png` | `message-reducer.ts:171-172` | image-attach | low | no | Restored JPEG/WEBP mislabeled (browsers usually sniff); fidelity regression |

---

## 4. Invariants and their pinning tests

Format: **invariant — where enforced — pinned by** (or **UNPINNED / partial** with the gap).

### Sequencing & transport
- **Per-session seq monotonicity; client dedups (`seq<=_highestSeq`) and reorders
  (`seq!=_highestSeq+1`).** `event-buffer.ts:27` (push) + `remote-agent.ts:1409-1428`. Pinned by
  `tests/remote-agent-seq-dedup.spec.ts`, `tests/message-reducer.test.ts` (case 3). **Partial:** the
  sequencer test drives a hand-copied HTML fixture, not production (S23).
- **First seq'd frame baselines `_highestSeq=seq-1` so the initial-connect gap doesn't stall.**
  `remote-agent.ts:1401-1408`. Pinned by the seq-dedup fixture + `restart-preserves-streaming-frame.test.ts`.
- **Top-level frames that consume a server seq (tool_permission) advance `_highestSeq`.**
  `remote-agent.ts:1096-1121`. Pinned by `tests/remote-agent-sequence-hole.spec.ts`,
  `tests/perm-frame-late-joiner-seq-gap.test.ts`.
- **Server replays the ORIGINAL perm seq/ts on late-join (single `pushFrame` callsite =
  `requestToolGrant`).** `session-manager.ts:2702`. Pinned by `tests/perm-frame-late-joiner-seq-gap.test.ts`.
- **Resume only when `canResumeFrom(fromSeq)`, else `resume_gap` → full snapshot.** `handler.ts:917`;
  `event-buffer.ts`. Pinned by `tests/event-buffer.test.ts` (canResumeFrom cases). **Gap:** no test
  covers resume across an un-granted perm seq hole (S25).
- **`seedNextSeq` preserves the seq frame-of-reference across in-place respawn.**
  `event-buffer.ts:88-92` + `session-manager.ts:3382`. Pinned by `tests/restart-preserves-streaming-frame.test.ts`,
  `tests/sandbox-recovery-preserves-streaming-frame.test.ts`.
- **Every retained live event carries seq+ts assigned once in `EventBuffer.push`; snapshot `_order`
  floor sorts before live.** `event-buffer.ts:15,27`. Pinned by `tests/event-buffer.test.ts`.
  **Gap:** no test asserts the **seq-less bypass set** (S5) is exhaustive/intentional.

### Reducer & render
- **Optimistic reconciled vs echo by id then exact-text (`optimistic_` prefix).**
  `message-reducer.ts:211-232`. Pinned by `tests/message-reducer.test.ts` cases (6)/(7) — **but those
  use `role:user`, not `user-with-attachments`** (S1/S6 gap).
- **Optimistic rows survive a snapshot (different server id) and are removed only on live echo
  (id-only).** `message-reducer.ts:403-408`. Pinned by `tests/message-reducer.test.ts` case (5) —
  **case (5) uses different text, so same-text duplicate (S18) is uncaught.**
- **Snapshot dedup is id/toolCallId/multiset-(role|text) based; H3 guard keeps a just-landed live row
  over a stale snapshot.** `message-reducer.ts:243-401`. Pinned by `tests/message-reducer.test.ts`
  snapshot survivor cases + case (10), `tests/e2e/ui/new-tab-no-duplicate-messages.spec.ts`.
- **Snapshot clears `streamingMessageId` and `_state.streamingMessage`.** Pinned by
  `tests/snapshot-clears-streaming-message.test.ts`.
- **Streaming row renders in exactly one surface (`visibleMessages` filter + shared
  `computeStreamingMessageId`).** `AgentInterface.ts:1547`, `streaming-message-id.ts:21`. Pinned by
  `tests/e2e/ui/new-tab-no-duplicate-messages.spec.ts`. **Gap:** id-less plain-text row (S7) relies on
  reference equality with no dedicated reorder-stability test for `keyFor`.
- **StreamingMessageContainer self-heals (`_immediateUpdate` reset; clears partial on
  isStreaming→false).** Pinned by `tests/streaming-message-container-set-message.spec.ts` (cases 1,2).
- **Deferred-render fidelity: live DOM == post-refresh DOM; every block resolves.** Pinned by
  `tests/defer-offscreen-render.spec.ts`, `tests/e2e/ui/transcript-fidelity.spec.ts`.
- **Follow-tail stick-to-bottom.** Pinned by `tests/follow-tail.spec.ts`,
  `tests/ui-fixtures/chat-scroll.spec.ts`, `tests/collapse-scroll-bugs.spec.ts`,
  `tests/agent-interface-scroll*.spec.ts`.
- **Editor draft survives reattach/reload.** Pinned by `tests/e2e/ui/draft-loss.spec.ts`.
- **Skill-expansion chips render optimistically, replaced on echo.** Pinned by
  `tests/e2e/ui/skills-chip.spec.ts`.

### Status & reliability
- **Single server writer (`broadcastStatus`) keeps `statusVersion` monotonic.** `session-status.ts:46`.
  Pinned by `tests/session-manager-status.test.ts` (monotonic case). **Partial:** heartbeat &
  `status_resync` sub-suites mirror logic inline, not the real sites (S22).
- **Divergence impossibility: `isStreaming` is a getter over `_state.status`.** `remote-agent.ts:519`.
  Pinned by `tests/remote-agent-status.spec.ts` — **but against a fixture copy, not the real class.**
- **Heartbeat self-heal within 15s; `status_resync` heals stuck-streaming.** Pinned by
  `tests/e2e/ui/session-status-recovery.spec.ts`.
- **Aborting status broadcast; steered/queued messages survive abort.** Pinned by
  `tests/e2e/abort-status-e2e.spec.ts`. **Gap:** no detection/test for **server-side** wedged-streaming
  with a dead bridge (S8).
- **Back-pressure: a single transient `bufferedAmount` spike never terminates; only a persistent one
  does.** `session-manager.ts:399-430`. Pinned by `tests/ws-overflow-guard.test.ts`. **Gap:** the
  handler-local `broadcast()` (S36) is unguarded and untested for this.
- **Pending RPC requests reject exactly once on child exit; idempotent `stop()`.** Pinned by
  `tests/rpc-bridge-lifecycle.test.ts`.
- **Backoff finite/non-negative/capped; provider-overload unbounded, others bounded 3×; dispatch
  failure re-enqueues at front.** Pinned by `tests/backoff-delay.test.ts`,
  `tests/auto-retry-policy.test.ts`, `tests/queue-dispatch.spec.ts`. **Gap:** no behavioural test that
  the auto-retry timer fires/cancels under the `status!=='idle'` guard (S40).
- **`spliceInFlightMessage`/`spliceInFlightSteers` reference-stable no-ops; recognise
  `user-with-attachments`.** Pinned by `tests/session-manager-getmessages-splice.test.ts`.
- **Composer caps ≤10 files / ≤20 MB.** Pinned by `tests/message-editor-attach.spec.ts`.
- **Title generation single-shot per session.** `session-manager.ts:4790-4800` (convention; no
  dedicated concurrency test cited).

### Biggest untested surfaces (per AGENTS.md "the missing test IS the bug")
1. **Image attachment round-trip** (composer → server echo → `get_messages` → render): zero reducer
   coverage of `enrichUserMessage` / `user-with-attachments`; the mock agent doesn't echo image blocks.
   Guards S1, S6, S18, S26.
2. **Production seq sequencer** end-to-end (real `RemoteAgent` over a spawned gateway): only the
   hand-copied fixtures exist. Guards S9, S10, S23.
3. **Real heartbeat / `status_resync` self-heal** against a live `SessionManager`. Guards S8, S22.
4. **Exhaustive seq-less-bypass-set assertion** (mirroring the perm-frame single-site pin). Guards S5.

---

## 5. Cross-layer open questions (carry into Step 2)

1. Does the real pi-coding-agent echo the user `message_end` as `role:"user"` (so enrichment fires)
   or already `user-with-attachments`/with image blocks (so S6's bare-block gap bites)? And does it
   persist user image blocks into its `.jsonl` so `enrichUserMessage` has anything to restore?
2. After the `_pendingEvents` overflow sets `_highestSeq=0`, what (if anything) re-baselines it once
   the snapshot lands? The snapshot updates the reducer's `highestSeq`, not `RemoteAgent._highestSeq`
   (S9).
3. Does the SDK echo batched steers as one concatenated message or N? Decides S27 and the
   batched-steer image drop (S26).
4. Can a prompt ack legitimately exceed 30s on the non-sandbox path (auto-compaction / Codex
   preflight mid-dispatch)? Decides S13.
5. Is `ps.wasStreaming` ever true when `_respawnAgentInPlace` runs for a routine grant/role switch?
   Decides S16.
6. Is there any guard between the 20 MB/file composer cap and the 100 MB ws socket cap? Decides S31.
7. Is there any in-flight/disabled lock on the send button/textarea during the `sendMessage` await
   window, or in `ChatPanel` upstream? Decides S4.
