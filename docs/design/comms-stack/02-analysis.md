# Bobbit Real-Time Comms Stack — Step-2 Evidenced Analysis

> Adversarial verification of the 46 risk seams (S1..S46) catalogued in
> [01-understanding.md](01-understanding.md). Every seam was either **CONFIRMED** with an exact
> trigger sequence + file:line + user-visible symptom, **REFUTED** by citing the specific
> guard/test that prevents it, or marked **NEEDS-TRACE** where it hinges on an unobservable
> (real-LLM write granularity, real-SDK echo shape). File:line anchors are load-bearing and were
> re-verified against `src/`, `node_modules/@earendil-works/*`, and `tests/`.
>
> Baseline (lead-run, unchanged): `npm run check` clean; `npm run test:unit` = 1237 passed /
> 2 skipped / exit 0. The suite is **GREEN despite all confirmed defects** — §4 explains why.

---

## 1. Executive summary

The user observes **four symptom families in real use, including in a single local tab and worse
over a high-latency VPN**: (A) duplicate prompt/assistant bubbles, (B) attached images detached or
missing from a message live (reappearing on reload), (C) the session freezing / Stop doing nothing /
prompts silently lost, and (D) streaming jank and abrupt reconnects on large/attachment-heavy sends.

These are not random. They trace to a small number of **shared root causes** (collapsed in §5),
each surfaced through several seams:

- **Symptom B (detached/missing images)** is the `_pendingAttachments` **single-slot stash** (S1)
  plus the **bare-image-block render gap** in `UserMessage` (S6). The image *data* is never lost —
  the real pi-agent persists user image content blocks to its `.jsonl` and re-derives tiles via
  `enrichUserMessage` on the snapshot path — but the *live* echo path has no render branch and a
  racy single slot, so the tile is wrong/absent live and only "heals" on reload. Steered-image
  prompts additionally lose images at the server (S26).
- **Symptom A (duplicates)** is a cluster of dedup gaps that all reduce to **"the reducer cannot
  match an optimistic/live row against a server copy because there is no stable correlation id"**:
  same-text optimistic-vs-snapshot (S18), id-less empty-text assistant rows surviving a resync
  (S7/S10), skill-expansion text divergence (S17), a fast double-Enter with no in-flight lock (S4),
  the 30s ack timeout re-dispatching a slow-but-accepted prompt (S13), and the grant-respawn
  continuation re-prompt (S16).
- **Symptom C (freeze / dead Stop / lost prompt)** is the **seq-less bypass channel** (S5/S21) +
  the **overflow re-baseline bug** (S9) + the **perm-hole resume stall** (S25), plus **no send
  outbox** (S2) and **no server wedged-streaming watchdog** (S8).
- **Symptom D (jank / teardown)** is **full-base64 re-serialization on every queue mutation** (S19),
  **document bytes shipped but never used** (S20), the **default 100 MiB ws cap with no aggregate
  composer cap** (S31), **synchronous base64 encode on the main thread** (S35), and several
  unthrottled hot-path scans (S32, S34).

**41 of 46 seams are CONFIRMED as real defects.** Five are **REFUTED** (S12, S24, S28, S30, S41,
S43, S44, S45, S46 — see note below on count) or downgraded to a benign residual; two are
**NEEDS-TRACE** (S11 timing; S13/S15/S27 have a confirmed code defect with one unobservable
parameter). Severities were corrected from the seam table in several places (S1 high→medium, S6
medium→high, S7/S10/S17/S18/S21 → medium, etc.) based on whether the symptom is data loss vs
transient/cosmetic and how reachable the trigger is.

> Count note: of the original 46, the analysis confirms 41 as live defects (some at reduced
> severity), and refutes the user-visible-symptom claim for **S12, S24, S28, S30, S41, S43, S44,
> S45, S46** while preserving a benign residual or latent-robustness note for most of them. S15/S27
> are refuted as *mechanisms* but carry a NEEDS-TRACE residue.

---

## 2. CONFIRMED DEFECT REGISTER

Sorted by **(symptom family, severity desc)**. Each entry: id · severity · trigger · failure
file:line · user-visible symptom · test-catches · minimal repro · lowest-risk fix.
"Test catches" is `false` for every confirmed defect below — that absence is itself the bug (§4).

### Symptom family: image-attach

#### S6 — `UserMessage` has no render branch for bare image content blocks — **HIGH**
- **Trigger.** Any path that lands a `role:'user'` `message_end` carrying `{type:'image'}` content
  blocks into state without the `_pendingAttachments` enrichment firing — e.g. the 2nd of two
  concurrent image prompts (S1 overwrite), or a server `error` frame nulling the slot before the
  echo (remote-agent.ts:1694).
- **Failure line.** `src/ui/components/Messages.ts:183-195` (tiles rendered only for
  `role==='user-with-attachments' && attachments.length>0`; no branch walks `content` for
  `type:'image'`). Routed there for both roles by `MessageList.ts:225`.
- **Symptom.** Attached image is invisible in the transcript **live**; reappears after reload
  (snapshot path runs `enrichUserMessage`, message-reducer.ts:245/164-178). The live-event path
  never calls `enrichUserMessage` (message-reducer.ts:188-241) — that asymmetry *is* the symptom.
- **Why confirmed (refutations defeated).** (a) The optimistic `user-with-attachments` row does NOT
  protect it: the reducer text-fallback (message-reducer.ts:221-231) uses `extractText`, which
  filters to `c.type==='text'` only (message-reducer.ts:65-76), so it matches the bare echo and
  *removes the good optimistic row* (line 230), leaving the image-less echo. (b) The real agent
  echo is exactly this shape: pi-agent-core agent.js:248-259 builds
  `{role:'user', content:[{type:'text'},…{type:'image',data,mimeType}]}`.
- **Minimal repro.** Render `<user-message .message=${{role:'user', content:[{type:'text',text:'hi'},
  {type:'image',data:BASE64,mimeType:'image/png'}]}}>` and assert an `<img>`/tile appears. Currently
  nothing renders the image. No such test exists.
- **Lowest-risk fix.** In `UserMessage.render()`, when `attachments` is empty and `content` is an
  array, extract `type:'image' && data` blocks and render them as tiles (default
  `mimeType:'image/png'` to match `enrichUserMessage`). This makes the server-authoritative content
  self-sufficient and removes the dependency on the racy slot — closing S1's image leg too. Zero UX
  risk: strictly adds previously-dropped tiles.

#### S26 — Steered prompts forward only `steered[0].images`; live `steer()` RPC forwards no images; rollback drops images — **MEDIUM**
- **Trigger.** Streaming. User submits an image-bearing prompt (queued WITH images,
  session-manager.ts:1809-1813), then clicks the **Steer** pill on that queue row (`steerQueued`
  preserves `msg.images`, prompt-queue.ts:43-49). Next `tool_execution_end`/`agent_end` →
  `_dispatchSteer` → `rpcClient.steer(batchText)` drops the image. Two pills → both images lost.
- **Failure lines.** `session-manager.ts:2108-2109` and `:2139` (batch joins text only, dispatches
  `next.images = steered[0].images`); `rpc-bridge.ts:399-401` (`steer(text)` has no images field);
  `session-manager.ts:1948-1949` (rollback `enqueueAtFront(r.text,{isSteered:true})` omits
  `r.images`).
- **Symptom.** The model never receives the steered image(s); the agent answers as if no image was
  sent. On reload the image still renders in the user bubble (it persisted), so the user sees "the
  model ignored my image" with no trace why.
- **Corroboration (it is 100% Bobbit-side, not an SDK limit).** The SDK fully supports steered
  images: agent-session.js:893 `steer(text, images)` → 923-928 pushes `...images`; rpc-mode.js:316
  reads `command.images`. Only Bobbit's `rpcClient.steer` signature drops them.
- **Scope correction.** Plain user-attached-to-prompt images travel the **prompt** path
  (AgentInterface.ts:1497-1508 always `prompt()`, never `steer()`) and are **unaffected**. S26 bites
  only deliberately-promoted Steer-pill images — hence medium, not high.
- **Minimal repro.** Enqueue two steered `QueuedMessage`s with distinct `.images`; call
  `drainQueue`; assert the dispatched `prompt`/`steer` carried the union. Today only `steered[0]`.
- **Lowest-risk fix.** `next = {...steered[0], text:batchText, images: steered.flatMap(m=>m.images??[])}`;
  add an `images` param to `RpcBridge.steer` + the steer RPC command and forward
  `steered.flatMap(images)` from `_dispatchSteer`; fix rollback to pass `{images:r.images,…}`.

#### S1 — Single `_pendingAttachments` slot overwritten across concurrent/queued image prompts — **MEDIUM**
- **Trigger (single tab).** (1) Idle: attach img1, Enter → `_pendingAttachments=[img1]`, optimistic
  row created, send. (2) Server broadcasts `streaming` *before* awaiting `rpcClient.prompt`
  (session-manager.ts:2013 via 2070, before 2075), so the client flips to streaming while echo 1 is
  still in flight (window widened by VPN latency). (3) User attaches img2, Enter → `prompt()`
  overwrites `_pendingAttachments=[img2]` (remote-agent.ts:847); line 861 guard skips the optimistic
  row; server queues it. (4) Echo 1 → enriched with `[img2]` (WRONG) and slot nulled; reducer
  text-matches and removes the correct optimistic img1 row. (5) Echo 2 → slot null → stays
  `role:'user'` → S6 render gap → no tile.
- **Failure line.** `src/app/remote-agent.ts:847` (single unconditional slot), consumed once at
  `:2200-2207`.
- **Symptom.** Second image-bearing prompt attaches the WRONG thumbnail to the first message and NO
  thumbnail to the second; intermittently the image is simply missing live, reappearing on reload.
- **Severity correction.** Image data is never lost (server-authoritative content recovers fully on
  reload) → medium, not high. But the window is exactly echo 1's round-trip, which VPN latency
  widens — matching "worse over VPN" and "single local tab."
- **Minimal repro.** Reducer/live-path test feeding two optimistic-prompt + two `role:'user'`
  image-block `message_end` frames; assert each user row carries its OWN attachment.
  `tests/message-reducer.test.ts` has zero attachment coverage; the mock echoes text-only.
- **Lowest-risk fix.** Adopt S6's render-from-content fix so the slot becomes non-load-bearing for
  image DATA. Interim: key pending attachments by optimistic id / text (a `Map`) instead of one slot
  and match on echo.

### Symptom family: duplicate-render

#### S18 — Optimistic snapshot survivor deduped by server-id only, never by text — **MEDIUM**
- **Trigger.** (1) Idle, send `foo` while WS OPEN → optimistic row id `optimistic_…`; agent appends
  the id-less user `foo` row to `agent.state.messages` *before* emitting the echo. (2) A snapshot is
  requested while the echo is still in transit — via post-disconnect visibilitychange
  (`_hadDisconnectSinceLastSnapshot` true after any WS flap, remote-agent.ts:378), reconnect
  `resume_gap` (remote-agent.ts:1446), or `_pendingEvents` overflow (remote-agent.ts:1424). (3)
  Snapshot reduce keeps the optimistic row (no serverId match) AND adds the server row → 2 bubbles.
  (4) Live echo removes the optimistic by text and pushes its own copy → still 2.
- **Failure line.** `src/app/message-reducer.ts:403-408` (optimistic survivor dropped only when
  `serverIds.has(m.id)`; the pi user message is id-less — agent.js:255-259, persisted id-less,
  agent-session.js:269-279). Persists across further snapshots: the `_order>0` echo copy survives via
  the H3 guard (message-reducer.ts:383-385) while the negative-`_order` snapshot copy is re-added.
- **Symptom.** Same prompt bubble renders twice and stays duplicated until reload. For an image
  prompt the two copies diverge (one may show the image, the other not) via S1/S6.
- **Minimal repro.** `applyAll([{type:'optimistic-prompt', message:userMsg('optimistic_1','foo')},
  {type:'snapshot', messages:[userMsgNoId('foo')]}])` → assert length 1 (currently 2); then a live
  echo → assert still 1. Existing case (5) at message-reducer.test.ts:123 uses DIFFERENT text
  (`hi` vs `hello`), so the same-text overlap is never exercised.
- **Lowest-risk fix.** On the snapshot path, before keeping an optimistic survivor, also drop it when
  the snapshot has a server row with matching `(role-normalised|text)` not already claimed by another
  optimistic (mirror the server-survivor multiset at message-reducer.ts:362-372, multiset-counted to
  avoid collapsing legitimately-distinct same-text prompts). Server rows untouched.

#### S17 — Text-fallback optimistic dedup defeated by skill-expand `originalText` vs `modelText` divergence — **MEDIUM**
- **Trigger (deterministic, single tab).** Previous turn errored
  (`lastTurnErrored && consecutiveErrorTurns < MAX`). User sends a slash-skill prompt `/foo` the
  server will expand. Optimistic row content = `/foo`. Server stores `{modelText:'<expanded>'}` and
  takes the unstick branch, dispatching `prefixedDispatch = buildErrorRecoveryPrefix(…, dispatchText)`
  (session-manager.ts:1791-1792). Agent echoes the prefixed expanded body.
  `spliceSkillExpansionsIntoEvent` fails `p.modelText === body` (session-manager.ts:547) → echo
  arrives un-rewritten.
- **Failure line.** `src/app/message-reducer.ts:221-228` (exact-text fallback against `/foo` fails
  on the prefixed/expanded echo) defeated when `src/server/agent/session-manager.ts:547` splice
  misses.
- **Symptom.** Two user bubbles: `/foo` AND a bubble showing
  `[SYSTEM: previous turn failed …]\n\n<expanded skill text>`. Permanent across snapshots (S18:
  optimistic survives by id only). Model still saw the correct expansion — clutter/confusion, not
  wrong behavior.
- **Minimal repro.** optimistic `/foo` then live `message_end` `EXPANDED foo` → assert 1 user row
  (master gives 2). No reducer test exercises this divergence; an errored-turn-then-slash-skill E2E
  asserting exactly one user row is the missing pin.
- **Lowest-risk fix.** Carry a stable correlation id from optimistic row → server echo so
  reconciliation is id-based. Interim: include `modelText` as a candidate in the optimistic
  text-fallback, OR make the server splice match a prefix-stripped/normalized body.

#### S13 — 30s prompt-ack timeout double-sends a slow-but-accepted prompt (auto-compaction preflight) — **MEDIUM** · NEEDS-TRACE on the wall-clock
- **Trigger.** Long session at/over the auto-compaction threshold, large real context window
  (Claude ~200K), high-latency link. User sends prompt P. pi enters `_checkCompaction` →
  `_runAutoCompaction` → `await compact(...)` (agent-session.js:766-776, 1552) — a full
  whole-conversation LLM summarization — BEFORE `preflightResult(true)` (agent-session.js:825), and
  the prompt ack is emitted only from that preflight (rpc-mode.js:302-305).
- **Failure line.** `src/server/agent/rpc-bridge.ts:380-383` (timeout deletes the pending entry and
  rejects) + ack deferred behind compaction (agent-session.js:766-776,825). At 30s the timeout fires;
  `recoverPromptDispatch` (non-process-exit rejection, regex miss at session-manager.ts:2022)
  re-enqueues at front + `drainQueue` → second `prompt`. The late ack is orphaned
  (rpc-bridge.ts:602/607-611). `isStreaming` is false during compaction (flips true only inside
  `runWithLifecycle`, agent.js:316), so the 2nd prompt is not always rejected; when it is
  ("Agent is already processing."), recovery re-enqueues and the next `agent_end` runs it as a real
  2nd turn.
- **Symptom.** One user message answered twice after a long pause — the single-tab duplicate-turn the
  user reports on long VPN sessions.
- **The one unobservable.** Whether real auto-compaction over a full-size window actually exceeds 30s.
  Code path is fully proven; only the wall-clock is unverified. Bobbit's own `/compact` uses a 120s
  timeout (rpc-bridge.ts:441) while the prompt path uses 30s — the maintainers already know
  compaction is slow.
- **Minimal repro.** Spawn a real `RpcBridge` against a stub CLI whose `prompt` handler delays its
  success line >30s; assert the prompt rejects AND no second `prompt` command is written. The
  in-process mock acks instantly (in-process-mock-bridge.mjs:71-83, mock-agent-core.mjs:1831), so
  this is uncatchable in-process today.
- **Settling trace.** Instrument `rpc-bridge.sendCommand` to log wall-clock between the prompt write
  and its matching response/timeout for a real over-threshold Claude session over the VPN. A measured
  ack latency >30s straddling a `compaction_start`/`compaction_end` converts NEEDS-TRACE → confirmed.
- **Lowest-risk fix.** Raise the prompt-specific `sendCommand` timeout well beyond worst-case
  compaction (or make it compaction-aware / unbounded for `prompt`), relying on the existing
  `process_exit` path (rpc-bridge.ts:333-358) for genuine death detection. Alternatively keep the
  pending entry alive past timeout so a late ack still resolves it and cancels recovery.

#### S4 — `onSend` not awaited + editor cleared only after blocking awaits; no in-flight lock — **MEDIUM**
- **Trigger.** Production build (IndexedDB backend, idle session). User types, presses Enter twice
  in rapid succession (<~5ms) or holds Enter (OS auto-repeat). Enter#1 → `handleSend` fires `onSend`
  WITHOUT clearing (MessageEditor.ts:454-465) → `sendMessage` un-awaited (AgentInterface.ts:2111-2113)
  → suspends on `await getAppStorage().providerKeys.get(provider)` (AgentInterface.ts:1466, real IDB
  read). Editor not yet cleared. Enter#2 (separate macrotask) re-reads `this.value` → second send.
- **Failure line.** `src/ui/components/AgentInterface.ts:2111-2113` (un-awaited) + `:1464-1491`
  (clear deferred past the `providerKeys.get` await) + `MessageEditor.ts:454-465` (no in-flight
  guard, no synchronous clear).
- **Symptom.** Fast double-Enter on an idle session sends the same prompt twice — two identical user
  bubbles and two agent turns. Each `prompt()` mints a unique `optimistic_<ts>_<rand>` id
  (remote-agent.ts:862) so the two rows don't collapse.
- **Backend caveat.** Reproducible on the IndexedDB default; with a synchronous in-memory backend and
  no wired `onApiKeyRequired`/`onBeforeSend`, the gap collapses to one microtask and the race closes —
  hence medium.
- **Minimal repro.** Browser E2E: idle, type `dup`, dispatch two `keydown {key:'Enter'}` within a
  tick (stub backend `get()` to resolve on a macrotask). Assert one `dup` bubble + one `prompt`. The
  fixture `message-editor-send.html` clears synchronously inside `handleSend` (html:85) — the inverse
  of production — so it cannot catch this.
- **Lowest-risk fix.** Clear `this.value`/`this.attachments` synchronously in `handleSend` BEFORE
  invoking `onSend`, restoring on the abort/early-return paths — removes the un-cleared window without
  touching await ordering. (Or a synchronous `_sending` re-entrancy flag.)

#### S16 — `wasStreaming` continuation re-prompt fires on routine grant/role-switch respawns — **MEDIUM**
- **Trigger.** Session with an ungranted `ask`-policy tool. Agent streams (agent_start sets
  store `wasStreaming=true`, session-manager.ts:2240). Agent invokes the gated tool; the guard pauses
  the turn inside `beforeToolCall` on a blocking long-poll (tool-guard-extension.ts:70-114) — so
  `agent_end` has NOT fired and persisted `wasStreaming` is still true. User clicks Allow →
  `grantToolPermission` → `_restartSessionWithUpdatedRole` → `_respawnAgentInPlace`:
  `unsubscribe()` (session-manager.ts:2815) detaches the listener BEFORE `stop()` (2817), so the
  kill's `process_exit` never resets `wasStreaming`. `restoreSession(ps)` sees `ps.wasStreaming===true`
  and re-prompts.
- **Failure line.** `src/server/agent/session-manager.ts:3499-3505` (the `[SYSTEM: …continue where
  you left off…]` injection) reached via `_respawnAgentInPlace` from the grant path.
- **Symptom.** After clicking Allow, an unsolicited `[SYSTEM: …continue where you left off…]` user
  bubble appears and the agent runs a fresh continuation turn (re-deciding from replayed history,
  since the tool never executed) rather than resuming the paused tool call. The text is misleading —
  no infrastructure restart occurred. Settles open question #5: yes, `wasStreaming` is true here.
- **Minimal repro.** Build a `SessionInfo` whose store record has `wasStreaming=true`; call
  `_respawnAgentInPlace`/`restoreSession`; assert `rpcClient.prompt` is NOT called with the continue
  text. `restart-preserves-streaming-frame.test.ts` only checks seq/statusVersion carry-over.
- **Lowest-risk fix.** Pass a `respawnReason`/`_suppressContinuationPrompt` flag through
  `_respawnAgentInPlace`'s `ps` stash (alongside `_restartFrameOfReference`, session-manager.ts:2821)
  so `restoreSession` skips the continuation prompt for grant/role-switch/restartAgent respawns,
  keeping it only for genuine post-crash restores.

#### S7 — `streamingMessageId` dedup only stamped for tool-call rows; id-less empty-text assistant row has no dedup id — **MEDIUM** (overlaps S10)
- **Trigger.** Fresh session (not yet snapshotted, so `_hadDisconnectSinceLastSnapshot` still true).
  Send a prompt, click Stop mid-turn (or let it error). pi emits an assistant `message_end`
  `{content:[{type:'text',text:''}], stopReason:'aborted'|'error'}`, id-less
  (agent.js:329-345). One "Request aborted"/error banner renders. Then a snapshot resync fires while
  the row is live (fresh-session visibilitychange — needsResync true; or resume_gap; or overflow).
- **Failure line.** `src/app/remote-agent.ts:2189-2192` (the non-toolCall `else` sets
  `streamingMessageId=undefined`, stamps no id) + `AgentInterface.ts:1547-1554` (filter dead because
  `streamingMessageId` undefined and `streamingMessage` nulled). The snapshot survivor pass skips the
  multiset dedup because `extractText()` is empty (`t.length===0`, message-reducer.ts:364) → the live
  row survives via the H3 guard (message-reducer.ts:383) while the id-less snapshot copy is appended.
- **Symptom.** TWO "Request aborted" banners (or two error boxes). For NON-empty text the multiset
  dedup (message-reducer.ts:362-372) saves it — the residual dup is specifically the empty-text row.
- **Refutation defeated.** The everyday "second tab → visibilitychange" is *blocked* in steady state
  by the needsResync guard (remote-agent.ts:376-378). But fresh-session focus (the existing
  `new-tab-no-duplicate-messages.spec.ts` path), resume_gap, and overflow all still reach it — and
  that E2E only asserts on NON-empty `OK`, which the multiset correctly dedups, so it passes even
  with this bug.
- **Minimal repro.** Reducer: live `message_end {role:'assistant', content:[{type:'text',text:''}],
  stopReason:'error'}` at seq 10, then snapshot with the same id-less empty-text row → assert 1
  (master gives 2). `dual-render-noid-message.test.ts` covers only the toolCall case.
- **Lowest-risk fix (shared with S10).** Stamp a stable synthetic id (`synth:seq:<eventSeq>`) onto
  id-less assistant `message_end` rows at the reducer boundary so snapshot dedup matches by id
  regardless of text emptiness.

#### S10 — Forced-snapshot fallback double-applies id-less empty-text live rows — **MEDIUM**
- **Trigger.** Same id-less empty-text aborted/errored assistant row applied live at a positive seq,
  then a forced `get_messages` via pending-events overflow (remote-agent.ts:1418-1425), reconnect
  resume_gap (1438-1447), or post-disconnect visibilitychange (1377-1378). NOT plain visibilitychange
  (guarded at 376-378).
- **Failure line.** `src/app/message-reducer.ts:362-364` (multiset dedup skipped when `extractText`
  empty) → `:383` (H3 guard survives the live row) while the snapshot copy at `:437` is also added.
  Both copies get DISTINCT `keyFor` keys (positive vs `SNAPSHOT_ORDER_FLOOR+i` order → MessageList.ts:87-92)
  so `repeat()` renders both DOM nodes; `suppressAbortedBanner` (MessageList.ts:288-296) only fires
  for auto-compaction self-aborts, so a user Stop shows the banner.
- **Symptom.** Two stacked "Request aborted"/error banners after a forced resync; self-heals to one
  on a hard reload (snapshot-only). Empirically validated (real reducer run): 2 rows for empty text,
  1 for non-empty `OK`, 1 on fresh-reload.
- **Minimal repro.** As S7. The existing H3 multiset tests (message-reducer.test.ts:838-894) all use
  non-empty `OK` and never hit the `t.length===0` skip.
- **Lowest-risk fix.** Either add a content-empty equivalence key to the snapshot multiset (treat
  `(role|EMPTY|stopReason)` as a key) OR the shared S7 synthetic-id stamp.

#### S42 — `spliceInFlightSteers` collapses two identical-text steers (Set-based dedup) — **LOW** (transient, self-healing)
- **Trigger.** Two identical-text live steers while streaming (e.g. user re-sends `reroute` on a
  laggy link, or a team nudge + user steer of the same text). Each `_dispatchSteer` pushes `batchText`
  onto `inFlightSteerTexts` (session-manager.ts:1937); both coexist before either echo flushes. A
  `get_messages` resync fires in that window.
- **Failure line.** `src/server/agent/splice-inflight-message.ts:94` (`Set`) + `:105`
  (`presentUserTexts.has(text)` skip collapses the duplicate).
- **Symptom.** Only ONE of the two steer bubbles appears transiently in the resync'd transcript.
  Self-heals when the two real per-message echoes land (live-event path doesn't text-dedup steers
  against each other) and `_consumeSteerEcho`'s `indexOf` clears both ledger entries one-per-echo.
- **Note.** Every other touch point is multiset-correct (`_consumeSteerEcho` indexOf at :1971,
  rollback lastIndexOf at :1946, SDK `_steeringMessages.indexOf` at agent-session.js:249). Only
  `spliceInFlightSteers` uses a `Set`.
- **Minimal repro.** `spliceInFlightSteers([{id:'a1',role:'assistant',content:[{type:'text',text:'working'}]}],
  ['reroute','reroute'])` → assert 3 rows (1 assistant + 2 distinct steers); master returns 2. The
  existing tests (session-manager-getmessages-splice.test.ts:109-163) use only DISTINCT texts.
- **Lowest-risk fix.** Make the dedup multiset/positional (count per text, decrement one match per
  present snapshot row), mirroring the reducer's `serverPlainTextCounts`. Confined to snapshot
  continuity; already self-healing.

#### S40 — Auto-retry timer fire guard checks only `status!=='idle'`; force-abort during backoff doesn't cancel it — **MEDIUM**
- **Trigger (corrected actor).** A TEAM agent's turn errors transiently → `agent_end` broadcasts idle
  (session-manager.ts:2298) → `maybeAutoRetryTransient` (2313) schedules the timer. status is now
  `idle`. A team operator POSTs `/api/goals/:id/team/abort` (server.ts:6446) → `forceAbort` →
  early-returns at session-manager.ts:5667 because `status!=='streaming'`, WITHOUT
  `cancelPendingAutoRetry`. Timer fires (guard `status!=='idle'` passes) → `retryLastPrompt({auto:true})`.
- **Failure line.** `src/server/agent/session-manager.ts:2499` (guard) + `:5667` (forceAbort
  early-return without cancel). `cancelPendingAutoRetry` is called only at 1755/2557/5003/5878 — never
  forceAbort.
- **Symptom.** A spurious/unwanted assistant turn dispatches on a session someone just tried to stop.
- **Refutation that narrowed it.** The session-owner's own Stop button / Escape cannot reach this —
  all are `isStreaming`-gated (MessageEditor.ts:770/367, AgentInterface.ts:446) and `isStreaming` is
  `status==='streaming'` (false during backoff). `POST /api/sessions/:id/abort` is also guarded
  (server.ts:8752). The only unguarded production entry is the team/swarm abort route → medium.
- **Minimal repro.** Schedule a real timer (transient errored turn), call `forceAbort` on the idle
  session in the backoff window, advance fake timers; assert no `retryLastPrompt` dispatch.
  `auto-retry-policy.test.ts` only pins the pure `decideRetryPolicy`.
- **Lowest-risk fix.** Call `cancelPendingAutoRetry(session,'aborted')` at the top of `forceAbort`
  (before/regardless of the early-return), AND/OR add the guard to the team-abort endpoint. Strengthen
  the timer-fire guard to also bail on `lastTurnErrored===false` or a cancel-generation mismatch.

### Symptom family: transient-failure

#### S2 — Silent prompt send-drop over WS reconnect; no outbox — **HIGH**
- **Trigger.** WS drops (VPN flap) → `onclose` (remote-agent.ts:726) → `_scheduleReconnect`,
  `connectionStatus='reconnecting'`; `this.ws` stays the CLOSED socket through the backoff (>=1s,
  growing to 30s). User presses Enter (editor NOT disabled; banner is cosmetic, render.ts:1756-1772).
  `sendMessage` clears the editor (AgentInterface.ts:1490-1491), `prompt()` renders the optimistic
  bubble (remote-agent.ts:875-876) then `send()`. `send()`: `readyState!==OPEN` → `console.warn` +
  return.
- **Failure line.** `src/app/remote-agent.ts:1257`. No outbox/resend/retry anywhere
  (grep: zero `outbox|resend|pendingSend`). Reconnect's `auth_ok` runs resume/get_state but never
  re-delivers a never-sent frame.
- **Symptom.** Editor clears, the message bubble appears, but the gateway never received it; the
  agent never responds; the prompt (possibly image-bearing) is silently lost. Worse over VPN.
- **Refutation defeated.** `onBeforeSend` is UNSET in production (session-manager.ts:1755-1757), so it
  cannot gate on connection. `user-message-echo.spec.ts:82-116` deliberately waits for `message_end`
  BEFORE disconnecting (comment lines 88-89) — it pins the *opposite* (drop AFTER delivery).
- **Minimal repro.** In-process gateway E2E: force ws non-OPEN, call `prompt('hello')`; assert the
  optimistic bubble exists AND the server received zero prompt frames.
- **Lowest-risk fix.** Bounded `_pendingOutbox`: when `send()` finds `readyState!==OPEN`, queue the
  frame, keep the bubble in a "pending/unsent" visual state, flush after `auth_ok`. Gate only
  prompt/steer/retry (user-intent) frames; leave fire-and-forget control frames as-is. Surface a
  "reconnecting — will send" affordance instead of clearing irrevocably.

#### S3 — No IME composition guard on Enter-to-send — **MEDIUM**
- **Trigger.** Safari/WebKit (incl. iOS Safari, explicitly supported per MessageEditor.ts:891-893).
  CJK IME composition active; user presses Enter to confirm a candidate. WebKit fires keydown with
  `key==='Enter'`, `!shiftKey`, `isComposing===true`. `MessageEditor.ts:362` matches → `preventDefault()`
  + `handleSend()`.
- **Failure line.** `src/ui/components/MessageEditor.ts:362` (and the slash-menu Enter at `:349`).
  Grep for `isComposing|composition|keyCode|229` across `src/ui` = zero.
- **Symptom.** The message sends prematurely and the IME candidate is never confirmed; Enter is
  unusable for confirming candidates, forcing the Send button.
- **Engine caveat.** On Chromium/Firefox the composing Enter reports `key==='Process'` (`keyCode 229`),
  so line 362 doesn't match there — the defect is real specifically on Safari/WebKit and fragile
  elsewhere (relies on an undocumented per-engine remapping). Hence medium.
- **Minimal repro.** Dispatch a `compositionstart`, set a partial value, dispatch
  `keydown {key:'Enter', isComposing:true}`; assert `getSendCalls().length===0` (today 1). The
  existing `message-editor-send.spec.ts:16` uses `page.keyboard.press('Enter')` (isComposing false).
- **Lowest-risk fix.** `if (e.isComposing || e.keyCode === 229) return;` at the top of `handleKeyDown`
  (covers both branches). Zero UX risk for non-IME users.

#### S8 — Server-side wedged-streaming has no automatic recovery; forceAbort no-ops on drift-off-streaming, ~30s when streaming — **HIGH**
- **Trigger — shape (b), deterministic no-op.** `recoverPromptDispatch`/`agent_end` broadcasts idle
  (session-manager.ts:2038/2298) while the client still renders a stranded streaming row (S12-class).
  User clicks Stop → `forceAbort` → early-return at `:5667` (`status!=='streaming'`). Nothing happens.
- **Trigger — shape (a), delayed kill (NEEDS-TRACE on real upstream).** Status still `streaming`, the
  LLM stream wedged by an upstream that trickles keep-alive/SSE comments so undici's 5-min idle
  bodyTimeout never fires and the abort signal can't promptly cancel a not-currently-reading socket.
  `forceAbort` proceeds → `await rpcClient.abort()` blocks on `waitForIdle` up to the 30s
  `sendCommand` timeout (rpc-bridge.ts:380-383) → only then force-kill+restart (5707-5732).
- **Failure line.** `src/server/agent/session-manager.ts:5667`. No watchdog: `streamingStartedAt` is
  only set, never aged-out (team-manager.ts:532-534 merely nudges a team LEAD, never recovers). The
  15s heartbeat re-broadcasts the wedged status without bumping `statusVersion`
  (session-manager.ts:830) → client drops it idempotently (remote-agent.ts:1460). `status_resync`
  returns the wedged status verbatim.
- **Mechanism correction.** The seam's "abort writes to a stdin the loop won't read" is WRONG — rpc
  reads stdin fire-and-forget (rpc-mode.js:605) and `session.abort()` IS invoked; for a normally
  byte-hung HTTP read the abort signal cancels it well under 30s. The ~30s delay only bites when
  `waitForIdle` doesn't resolve in 30s (signal-ignoring op / keep-alive-trickling upstream / the
  up-to-5-min pre-idle-timeout window).
- **Symptom.** Spinner stuck on "thinking"; Stop does nothing (drift-to-idle) or appears to do nothing
  for ~30s (streaming + hung); frozen until the user finds `restart_agent`.
- **Minimal repro.** Real SessionManager + fake bridge that emits agent_start then never agent_end and
  makes `abort()` hang >30s; assert heartbeat keeps broadcasting streaming, forceAbort doesn't resolve
  until the timeout, no recovery without restart_agent. Separately `status='idle'` → forceAbort returns
  without touching the bridge.
- **Settling trace (shape a).** Log timestamps (Stop click) → (rpc abort response or 30s timeout) →
  (force-kill) against a real keep-alive-trickling gateway. ~30s gap confirms shape (a) in production.
- **Lowest-risk fix.** (1) In `forceAbort`, race `rpcClient.abort()` against the 3s grace timer
  (`Promise.race`, or fire abort un-awaited then `await settledPromise`) so force-kill happens at 3s.
  (2) Heartbeat watchdog: if `status==='streaming'` and `now-streamingStartedAt` exceeds a threshold
  with no recent agent activity, escalate to forceAbort/restart or surface a "may be stuck — restart"
  affordance. Keep `restart_agent` as the explicit hard recovery.

#### S21 — `auto_retry_pending`/`cancelled` seq-less & unbuffered — reconnect/multi-tab orphans a stale banner — **MEDIUM**
- **Trigger (permanent orphan).** Two tabs view session S; a turn errors transiently → seq-less
  `auto_retry_pending` (session-manager.ts:2489) → both show "Retrying in ~Xs…". Session already at
  `>=MAX_CONSECUTIVE_ERROR_TURNS`. Tab A's WS flaps. In Tab B the user sends a new prompt →
  `cancelPendingAutoRetry` broadcasts seq-less `auto_retry_cancelled` (2526), then PARKS the prompt
  (1757-1769) with NO dispatch and NO `agent_start`. Tab A misses the cancel (socket down) and, because
  parked, never gets a subsequent `agent_start`. A reconnects → resume replays only EventBuffer entries
  (the cancel is absent) and `get_state` carries no `autoRetryPending` → banner stuck forever.
- **Failure line.** `session-manager.ts:2489`/`:2526` (seq-less broadcast); orphan persists because
  `remote-agent.ts:2039` (auto_retry_cancelled) / `:2012` (agent_start) are the only clears, and the
  snapshot/state/session_status handlers never reset `autoRetryPending`. `cancelPendingAutoRetry`
  skips the broadcast entirely when `clients.size===0` (2520).
- **Symptom.** "Retrying in Xs due to provider overload…" banner that never clears after a reconnect
  during backoff or a multi-tab cancel race. The banner is a static `~Xs`
  (AgentInterface.ts:1623), so the common single-tab-flap case is a frozen-then-cleared banner (low
  noise); the permanent orphan needs the multi-tab/capped-park race → medium.
- **Minimal repro.** Two tabs, inject `auto_retry_pending` in both, drop A's WS, drive a capped
  new-prompt (or terminate while A disconnected) in B, reconnect A, assert
  `[data-testid=auto-retry-banner]` is gone. `auto-retry-banner.spec.ts` injects via `handleAgentEvent`
  and never exercises reconnect/replay or the `clients.size===0` skip.
- **Lowest-risk fix.** Route `auto_retry_pending`/`cancelled` through `emitSessionEvent` (seq +
  EventBuffer + replay). Independently, clear `autoRetryPending` on snapshot/state ingestion (treat the
  server snapshot as authoritative for banner state). (Shared root cause with S5.)

#### S5 — Three event broadcasts bypass `emitSessionEvent` (seq-less, unbuffered, never replayed) — **MEDIUM**
- **Trigger — resume-loss (primary, airtight).** A transient failure schedules an auto-retry →
  seq-less `auto_retry_pending`. Before it fires, the retry is cancelled server-side (new prompt /
  explicit retry / terminate) → seq-less `auto_retry_cancelled`. Drop the WS during the backoff and
  reconnect within the ring window (`canResumeFrom` true → resume branch, remote-agent.ts:680). Server
  replays only ring entries (handler.ts:924); the seq-less cancel is absent; `get_state` returns no
  snapshot → stale "Retrying…" banner persists indefinitely (nothing reconciles it).
- **Trigger — force-abort stale partial.** Force-abort (seq-less `agent_end` at session-manager.ts:5731
  + seq-less `session_status` idle at 5732). Reconnect within the ring before any snapshot →
  `session_status:idle` flips `isStreaming` false but the stale partial is cleared only by the lost
  `agent_end` handler (AgentInterface.ts:1106-1112) until a later visibility-tick snapshot.
- **Failure line.** `session-manager.ts:2489` (auto_retry_pending), `:2526` (auto_retry_cancelled),
  `:5731` (forceAbort agent_end) — all skip `emitSessionEvent` (the only `eventBuffer.push()` site,
  :507-523).
- **Reorder sub-claim (narrow).** Requires `_pendingEvents` non-empty (a live seq gap) when a seq-less
  frame arrives. WS-over-TCP keeps the seq'd stream contiguous for an attached client, and the one
  documented production gap source (perm-frame unicast pushFrame) is pinned closed by
  `perm-frame-late-joiner-seq-gap.test.ts`. So reorder is reachable only during a transient genuine-loss
  window or if that perm fix regresses → NEEDS-TRACE for the reorder sub-path only.
- **Symptom.** Orphaned "Retrying in Xs…" banner after a WS drop during backoff; on force-abort a
  resumed client may keep a stale streaming partial.
- **Minimal repro.** Drive `RemoteAgent.handleServerMessage` (NOT `handleAgentEvent`): event seq=1,
  event seq=3 (gap at 2), then seq-less `{type:'event', data:{type:'agent_end'}}` → assert agent_end
  side effects fired before the buffered seq=3 (reorder); separately deliver seq-less
  `auto_retry_pending` then a snapshot and assert `_state.autoRetryPending` is STILL set (resume-loss).
- **Lowest-risk fix.** Route all three through `emitSessionEvent` so they get a seq, enter the
  EventBuffer, and replay on resume (force-abort `agent_end` especially must be seq'd+buffered). Add a
  structural test asserting the seq-less broadcast set is exhaustive/intentional. If retry banners must
  stay outside the buffer by design, reconcile `_state.autoRetryPending` from authoritative server state
  on snapshot.

#### S38 — `_maybeReplayGrant` replays on a fixed 200ms with no idle-ready confirmation; fires from the idempotent heartbeat branch; replay `send()` can be dropped — **LOW** (symptom corrected: duplicate-risk, not "grant does nothing")
- **Trigger.** A grant pauses an `ask` tool. User clicks Allow → `_pendingGrantReplay` stashed →
  `grant_tool_permission`. Server `_respawnAgentInPlace` respawns and, because `ps.wasStreaming` is
  true (S16), ALSO fires its own continuation prompt (session-manager.ts:3502); then broadcasts idle
  (new statusVersion). Client `_maybeReplayGrant("idle")` (remote-agent.ts:1491) → +200ms
  `send({type:'prompt', text:original})`. Within the 200ms window status is usually still idle →
  `enqueuePrompt` dispatches the client replay too.
- **Failure line.** `src/app/remote-agent.ts:1161-1163` (fixed 200ms + bare `status==='idle'` check),
  also called from the idempotent heartbeat branch at `:1461`.
- **Symptom (corrected).** The genuine residual is a REDUNDANT/RACY SECOND prompt (system continuation
  + verbatim original re-send, different text so no dedup) → duplicated/confused turn, not a dropped
  grant. The original "grant does nothing" claim is refuted: the server's `wasStreaming` continuation
  prompt (3502) robustly re-drives the tool even if the client replay is dropped.
- **Minimal repro.** Set `_pendingGrantReplay`; deliver an idempotent heartbeat `session_status` idle
  (`v<=lastStatusVersion`) and assert the replay fires (heartbeat-triggered). Separately put ws
  non-OPEN, deliver idle with a pending replay → assert the frame is dropped and `_pendingGrantReplay`
  is now cleared (lost).
- **Lowest-risk fix.** Gate `_maybeReplayGrant` to the genuine non-idempotent idle TRANSITION only
  (drop the call at remote-agent.ts:1461); confirm session readiness via an explicit ready/snapshot
  signal rather than a 200ms timer; route the replay through the S2 outbox. (Pairs with the S16 fix to
  remove the double-prompt entirely.)

#### S43 — `MAX_SPAWN_RETRIES` stale handler bleed (refined) — **LOW** (residual: per-retry EventEmitter leak only)
> Confirmed in the all-verdicts ledger but the refutation note downgrades the *symptom*. The
> claimed spurious "Agent process exited" on a healthy spawn does NOT occur (spawn-phase
> ENOTCONN/EMFILE errors never emit a later `exit`; the persistent `on('error')` runs before the
> temporary `.once` and nulls `this.process` so the catch's `kill()` is a no-op). Residual real
> finding: after a spawn-phase error, the persistent `on('error')/on('exit')` handlers are never
> removed from the dead child — a tiny per-retry listener leak that references `this.process`, never
> fires again, and cannot null the replacement or emit a spurious `process_exit`.
- **Failure line.** `src/server/agent/rpc-bridge.ts:240-244` (catch nulls process without
  `removeAllListeners()`).
- **Lowest-risk fix.** `this.process?.removeAllListeners();` immediately before `kill()` at
  rpc-bridge.ts:242. Code-hygiene only.

### Symptom family: flush-delay

#### S9 — `_pendingEvents` overflow resets `_highestSeq=0` while `_seqInitialized` stays true; nothing re-baselines → permanent live stall — **MEDIUM**
- **Trigger.** A single live WS, long session. >500 events gap-buffer in `_pendingEvents` → overflow
  branch sets `_pendingEvents=[]`, `_highestSeq=0`, `_inResumeFallback=true`, `requestMessages()` —
  leaving `_seqInitialized=true`. Snapshot applies messages but never re-baselines `_highestSeq`. Next
  live event seq=N (large) hits `:1401` (re-baseline skipped because `_seqInitialized` true),
  `N!==0+1` → re-buffered; buffer refills to 500 → overflow again → indefinite.
- **Failure line.** `src/app/remote-agent.ts:1423` (`_highestSeq=0` with `_seqInitialized` left true) +
  snapshot handler `:1306-1388` never re-baselining. `reset()` (the only `_seqInitialized=false` setter,
  :1050) has zero callers in `src/`. Contrast resume_gap (`:1443` `=lastSeq`) and `_advanceTopLevelSeq`
  (`:1115` `=seq`) — the overflow path is the lone outlier.
- **Symptom.** Live streaming silently stalls — transcript freezes mid-turn — until a full page reload;
  plus a `get_messages` request storm every ~500 buffered events.
- **Reachability (why medium, not high).** After the perm-hole fix (perm-frame-late-joiner-seq-gap.test.ts),
  a single OPEN client cannot easily buffer 500 out-of-order events in current production (server seq is
  contiguous; every seq-consuming client case advances `_highestSeq`; reconnect routes through resume →
  re-baseline). But there is NO guard and NO pinning test for this recovery branch — any future regression
  (new seq-consuming frame lacking a client advance-path, or a perm-replay regression) re-opens a
  permanent reload-only stall. The mirror fixture `remote-agent-sequence-hole.html` even reproduces the
  same buggy `_highestSeq=0` line without exercising it.
- **Minimal repro.** Drive the REAL `RemoteAgent.handleServerMessage`: event seq=1, then 501 events
  seqs 3..503 (gap at 2) → assert `_highestSeq===0 && _seqInitialized===true`; deliver the `messages`
  snapshot, then a live event seq=504 → assert it is gap-buffered (stalled).
- **Lowest-risk fix.** Add `this._seqInitialized = false;` alongside `this._highestSeq = 0;` in the
  overflow block so the next seq'd frame re-baselines via `:1401-1408` (or set `_highestSeq=seq`
  mirroring the other two paths). Add a production-level (not HTML-fixture) test.

#### S25 — Resume across a resolved tool-permission `pushFrame` seq hole strands the buffer until 500-event overflow — **LOW** (trigger corrected: DENY/TIMEOUT, not GRANT)
- **Trigger (corrected).** Client A at `_highestSeq=J`, WS drops. While offline the agent requests a
  gated tool → `pushFrame` consumes seq K but does NOT retain it (event-buffer.ts:41-43, pinned by
  event-buffer.test.ts:209-221). On another tab the user **DENIES** (or it 5-min TIMES OUT) →
  `pendingGrantRequest` cleared with NO respawn; the agent continues, pushing K+1,K+2,… into the SAME
  buffer. A reconnects, resume `fromSeq=J` (J+1 still in the 1000-window so `canResumeFrom` true);
  `since(J)` replays J+1..K-1,K+1,… (K absent). A dispatches to K-1 then gap-buffers K+1 forever; the
  on-attach perm replay (handler.ts:458-461) doesn't re-send (getPendingToolPermission undefined once
  cleared). Stall until 500-event overflow → S9.
- **Why GRANT does NOT reproduce.** A grant respawns and reseeds the buffer
  (`seedNextSeq(lastSeq+1)`, session-manager.ts:3382) so `canResumeFrom(J)` is FALSE → `resume_gap` →
  clean snapshot recovery; the respawn completes before the guard long-poll resolves, so no post-grant
  events land in the old buffer. The prior agent's "user grants → stall" mechanism is refuted.
- **Failure line.** `src/server/agent/event-buffer.ts:41-43` (pushFrame seq consumed, not retained) +
  `handler.ts:924` `since()` over the hole + `:458-461` re-send gated on still-pending; client
  gap-buffers at `remote-agent.ts:1414-1417`.
- **Symptom.** After a disconnect straddling a DENIED/TIMED-OUT permission, live output freezes
  (gap-buffered) for up to ~500 events, then a snapshot refresh; combined with S9 the stream may never
  recover without reload. Narrow conjunctive trigger → low.
- **Minimal repro.** EventBuffer: push seq 1..3, `pushFrame()`→4, push 5..6; client at `_highestSeq=3`
  resumes `fromSeq=3`; `since(3)` returns [5,6] (4 absent); feed those through real
  `handleServerMessage` with the perm NOT re-sent → assert seq=5 gap-buffers and never dispatches.
  `perm-frame-late-joiner-seq-gap.test.ts` only covers attach while STILL pending.
- **Lowest-risk fix.** Retain perm frames in the EventBuffer (they are small) so `since()` is
  hole-free on resume; pair with the S9 fix so any residual gap self-recovers.

#### S14 — Per-chunk `chunk.toString('utf-8')` corrupts multibyte chars split across stdout reads — **MEDIUM**
- **Trigger.** Agent emits a single JSON line (one `message_update`/`message_end`/`tool_result`) larger
  than the OS pipe read size (~56-64KB; smaller on Windows named pipes / Docker stream frames)
  containing a multibyte char straddling a read boundary. Node delivers ≥2 `data` events splitting it.
- **Failure line.** `src/server/agent/rpc-bridge.ts:300` (and `:306` stderr tail) — `chunk.toString('utf-8')`
  per chunk, NO `StringDecoder`. The agent's OWN stdin reader uses `StringDecoder` (jsonl.js:19,25),
  proving the maintainers know the hazard.
- **Symptom.** Garbled/replacement characters (mojibake) in long assistant CJK/emoji/accented text or
  non-ASCII tool output. The line is NOT dropped (U+FFFD is a valid JSON string char, so
  `JSON.parse` at rpc-bridge.ts:596 still succeeds) — only the rendered text is corrupted.
- **Empirically reproduced** on the user's Windows 11 box: a 72KB CJK-only assistant reply splits into
  2 events → 2 U+FFFD via the bug path vs 0 via a `StringDecoder` path; `JSON.parse` succeeds in both.
- **Minimal repro.** Feed `RpcBridge.handleData` two chunks splitting a 4-byte emoji / 3-byte CJK across
  the boundary; assert the parsed text equals the original. Impossible via E2E (the in-process mock
  bypasses `handleData`).
- **Lowest-risk fix.** `private decoder = new StringDecoder('utf8')`; feed
  `this.handleData(this.decoder.write(chunk))`, flush `decoder.end()` on stream end. Same for the
  stderr tail at `:306`.

#### S11 — Streaming→finalized hand-off may momentarily show a row in neither surface — **NEEDS-TRACE** (timing)
- **Mechanism (confirmed).** At a no-tool-call `message_end`, `remote-agent.ts:2196-2197` nulls
  `streamingMessage`; `AgentInterface.ts:1098-1104` calls `_streamingContainer.setMessage(null,true)`
  (container's OWN `requestUpdate`) AND separately `_updateAndPin()` (AgentInterface's `requestUpdate`,
  re-evaluating `visibleMessages` so the finalized row passes). The container clear and the message-list
  inclusion live on TWO different Lit update queues.
- **Unobservable.** Whether Lit batches both into the same microtask checkpoint, or the container commits
  its clear a frame before the list inclusion (row in neither surface for one frame). Cannot be proven
  from static reading.
- **Symptom (if real).** Single-frame flicker where the just-finished bubble briefly vanishes before
  reappearing; on slow devices/VPN a visible blink at end-of-turn.
- **Settling trace.** Spawned-gateway E2E driving a plain-text (no-toolCall) stream then `message_end`,
  with a MutationObserver/rAF probe asserting the assistant text node is present in EITHER `<message-list>`
  OR `<streaming-message-container>` on every animation frame across the hand-off. `render-debounce.spec.ts`
  only covers PATH A coalescing.
- **Lowest-risk fix.** Drive both surfaces from one render owner: have `AgentInterface` clear the
  container inside its own `render()` (derive container `.message` from `streamingMessage`) instead of an
  out-of-band `setMessage(null,true)`, so the clear and inclusion commit in one Lit update.

#### S33 — Truncated-block throttle `break`s with no trailing flush — **LOW** (symptom corrected: cosmetic size-badge lag)
> Confirmed in the all-verdicts ledger; the refutation note downgrades the symptom. The dropped final
> truncated delta does NOT show stale tool *arguments*: a `_truncated` block only activates once content
> >32KB (truncate-large-content.ts:15/168), and the rendered preview is `content.slice(0,512)`
> (truncate-large-content.ts:116, WriteRenderer.ts:77-79) — fixed once length≥512 and identical at
> `message_end`. The only delta-varying element is the `formatSize(_originalLength)` badge
> (WriteRenderer.ts:159-163), which under-reports by the dropped delta's bytes for up to ~500ms before
> `message_end` corrects it.
- **Failure line.** `src/app/remote-agent.ts:2101-2103` (`break` with no trailing flush).
- **Lowest-risk fix.** Schedule a trailing-edge flush of the last dropped update at the throttle boundary
  (store + setTimeout to apply if no newer update arrives). Cosmetic; low priority.

### Symptom family: perf-resource

#### S19 — `broadcastQueue` re-serializes & re-persists full base64 image data on every queue mutation; can exceed the 4 MiB overflow-terminate threshold — **MEDIUM**
- **Trigger.** High-latency client; agent streaming (so the prompt is queued, not direct-dispatched —
  gate at session-manager.ts:1799). User queues ONE image prompt (even ~2-4 MB; composer cap 20 MB).
  `broadcastQueue` (session-manager.ts:1688-1694) calls `promptQueue.toArray()` (full `QueuedMessage`s
  incl. `images[].data` + `attachments[].content` + `attachments[].preview` — ~3x base64 per image,
  attachment-utils.ts:157-158) and broadcasts a `queue_update` JSON to every client. The next broadcast
  reads `bufferedAmount>4MiB` before its own send → defer → 10ms recheck still over → `client.terminate()`.
- **Failure line.** `src/server/agent/session-manager.ts:1688-1695`. Threshold is far lower than 20 MB
  (~3x duplication; a single ~1.5 MB source image already exceeds 4 MiB). The disk-rewrite sub-claim is
  overstated: `messageQueue` is not in `RECOVERY_CRITICAL_FIELDS` (session-store.ts:513-522) so the
  write is debounced ~1x/sec — the load-bearing path is the synchronous un-debounced WS broadcast.
- **Symptom.** On a slow/VPN client, an abrupt "Reconnecting to server…" as the overflow guard
  terminates the socket; on a fast local tab, only a CPU/re-JSON spike (socket drains in µs).
- **Minimal repro.** Enqueue an image-bearing prompt while streaming; assert the `queue_update` frame
  re-includes the full base64 and is bounded; drive `decideOverflowAction` with a `queue_update` >4MiB
  and a client whose `bufferedAmount` stays high across the 10ms recheck.
- **Lowest-risk fix.** `toBroadcastArray()` that omits `images.data` / `attachments.content` /
  `attachments.preview` while keeping ids — clients render placeholders and fetch full images lazily by
  id; persist images out-of-band.

#### S20 — Non-image attachments base64-inflated and shipped full-bytes over WS + into server memory/persistence, never used as model input — **MEDIUM**
- **Trigger.** User attaches a large PDF/DOCX/PPTX (up to 10×20 MB). `loadAttachment` base64-encodes the
  full bytes into `Attachment.content` (attachment-utils.ts:109/127/145). `RemoteAgent.prompt` keeps the
  full `attachments` and transmits the whole array (remote-agent.ts:884) incl. document `content`. Server
  forwards + stores it (handler.ts:583 → prompt-queue rows, dispatchedRowsForRecovery, broadcast/persisted
  queue), but `dispatchDirectPrompt` forwards only `(text, images)` to `rpcClient.prompt`
  (session-manager.ts:2075) — documents never reach the model.
- **Failure line.** `src/app/remote-agent.ts:884` (sends full attachments) + `session-manager.ts:2075`
  (attachments never reach model).
- **Refutation defeated.** `convertAttachments` (Messages.ts:667-684) WOULD turn a document's
  `extractedText` into model input via `defaultConvertToLlm`, but `customConvertToLlm` has ZERO callers in
  `src/` (the pi SUBPROCESS is authoritative; the client never calls `convertToLlm` on the prompt path).
  Even that dead path pushes only `extractedText`, never the base64 — so raw document bytes are NEVER
  model input under any code path.
- **Symptom.** Multi-hundred-MB prompt frames + matching server-memory/state growth for documents the
  model never sees; on a VPN link the oversized send is slow and aggravates the overflow/teardown family.
- **Minimal repro.** Capture the JSON-RPC stdio prompt request (or the persisted `.jsonl` user message)
  for a document-only prompt → it contains only `{role:user, content:[{type:text}]}` with no document
  text/bytes.
- **Lowest-risk fix.** Drop document `attachment.content` before sending on the remote path (send only
  metadata + `extractedText`); on the server omit `attachments.content` from queue persistence. (Separate
  follow-up: actually inject `extractedText` into the prompt so documents reach the model at all.)

#### S31 — Large multi-image base64 prompt frame exceeds the ws default `maxPayload` (100 MiB) → socket teardown (close 1009) — **MEDIUM**
- **Trigger.** Composer (single tab): attach 3 images ~13-16 MB each (each under the 20 MB per-file cap;
  3 ≤ maxFiles 10) and Send. Because each image's base64 rides the frame ~3x (`images[].data` +
  `attachments[].content` + `attachments[].preview`, attachment-utils.ts:158, remote-agent.ts:883), the
  total JSON exceeds 100 MiB. ws raises a RangeError 1009 at the frame-length header (receiver.js:415-429)
  BEFORE the app handler runs; the frame never reaches handler.ts:278.
- **Failure line.** `src/server/server.ts:1071` (`new WebSocketServer({…})` with no `maxPayload` → ws
  default 100 MiB) + `MessageEditor.ts:86-87` (per-file caps only, no aggregate cap).
- **Symptom.** Prompt bubble shown, composer cleared, then "Reconnecting…" and the prompt never reaches
  the agent — silent loss (combines with S2). Threshold is ~1/3 the raw size the seam assumed for images
  (document-only is ~1x → ~75 MB raw).
- **Minimal repro.** Capture the outgoing frame byte length in DevTools (WS) for N images vs 104857600;
  or E2E sending a frame whose JSON exceeds 100 MiB and assert close 1009 + no enqueue.
- **Lowest-risk fix.** Set an explicit `maxPayload` on the `WebSocketServer` above the legitimate
  aggregate cap, AND add an aggregate-size guard in the composer/`RemoteAgent.send` that rejects with a
  user-visible error instead of a silent socket teardown.

#### S32 — `message_update` runs two proposal scans (incl. growing-text regex) per text delta; throttle only covers `_truncated` blocks — **LOW**
- **Trigger.** A long plain-text assistant response. Each `message_update` (per text_delta, dozens/sec)
  hits `remote-agent.ts:2087`: `hasTruncated` false (no toolCall) → the 500ms throttle (2099-2105) is
  skipped → both `_checkToolProposals` (2111) and `_checkProposals` (2112) run; the latter joins all text
  (1805) and runs 5 fresh `new RegExp(...).exec()` over the FULL growing text (1809-1818) → O(n) per delta,
  ~O(n²) over the stream.
- **Failure line.** `src/app/remote-agent.ts:2107-2112` (unthrottled scans) + `:1805-1818` (per-delta
  regex over full text).
- **Symptom.** Streaming jank / GC pauses on very long responses on low-end devices. Per-unit work is
  cheap (literal open-tag scans) and only the single active session's `RemoteAgent` runs them → low.
- **Lowest-risk fix.** Throttle the proposal scans like the truncated path; short-circuit `_checkProposals`
  with a cheap `indexOf` precheck for `<..._proposal>` substrings before building RegExps; reuse compiled
  RegExps.

#### S34 — `AgentInterface` re-render bypasses the global rAF coalescer; `_updateAndPin` drives a per-event `getBoundingClientRect` loop over every `<user-message>` — **MEDIUM**
- **Trigger.** Long session (N≈200-300 prior user turns), pinned to bottom, agent streaming. Each
  unthrottled `message_update` (text deltas, ~tens/sec; server coalescing was rejected/reverted per
  reduce-server-cpu-experiment-stream-coalescing.md:5) → `_updateAndPin()` (AgentInterface.ts:1126) →
  `updateComplete.then(_refreshJumpToLastPromptButton)` (671-713): `container.getBoundingClientRect()`
  (675) forces ONE sync layout, then loops `getBoundingClientRect` over ALL N `<user-message>` nodes
  (679-684); the early-exit never triggers pinned-at-bottom (no below-message).
- **Failure line.** `src/ui/components/AgentInterface.ts:679-684` driven by `:1126`/`:722`.
- **Symptom.** Sustained main-thread layout work that grows with chat history during streaming → reduced
  frame rate, sluggish scroll, fan spin-up on long histories.
- **Mechanism correction.** The loop body is READS ONLY → 1 forced reflow + N cached rect reads per event
  (not O(N) reflows). Still unbounded-with-history work at the streaming frame rate, competing with the
  streaming and global paint schedulers, with zero test coverage. Magnitude (fan spin-up) NEEDS a
  long-transcript Performance trace.
- **Minimal repro.** Render with 200 `<user-message>` rows, spy on `Element.prototype.getBoundingClientRect`,
  drive 50 `message_update`s; assert call count ≈ 50×200.
- **Lowest-risk fix.** Schedule `_refreshJumpToLastPromptButton` via a single rAF (collapse bursts to
  one/frame); replace the per-node loop with an `IntersectionObserver` maintaining above/below counts so
  the hot path reads cached booleans.

#### S35 — Synchronous chunked base64 encode blocks the main thread at attach time — **LOW**
- **Trigger.** User pastes/drops a large attachment (single ~20 MB, or up to 10×20 MB serially).
  `loadAttachment` (attachment-utils.ts:88-95) iterates the `Uint8Array` in 32KB chunks building a JS
  binary string via `String.fromCharCode(...chunk)` then `btoa(binary)` — all synchronous, no yielding/
  Worker/`readAsDataURL`. The per-file cap (MessageEditor.ts:435/487/551) lets exactly-20MB through.
- **Failure line.** `src/ui/utils/attachment-utils.ts:88-95`.
- **Symptom.** Pasting/dropping a large file freezes the UI for hundreds of ms (single 20 MB) to ~1-2s
  (10×20 MB); the "Processing files" spinner freezes mid-animation.
- **Minimal repro.** Wrap lines 88-95 with `performance.now()` deltas (or a Long Tasks observer) while
  dropping one 20 MB and ten 20 MB files; expect one uninterrupted long task per file.
- **Lowest-risk fix.** Offload to `FileReader.readAsDataURL` (browser-native, async) or a Web Worker, or
  chunk the encode across rAF/setTimeout yields.

#### S36 — `handler.ts` local `broadcast()` lacks the bufferedAmount overflow guard — **LOW**
- **Trigger.** Multi-client session with a slow/VPN peer B. Client A repeatedly triggers fanout via the
  unguarded handler path — easiest production trigger: `set_image_model` (remote-agent.ts:1139 →
  handler.ts:632-647 broadcasts a `state` frame to all session.clients).
- **Failure line.** `src/server/ws/handler.ts:178-214` (plain JSON.stringify + `client.send()`, no
  bufferedAmount check / warn / terminate), vs the guarded `session-manager.ts:399-436`. Four unguarded
  fanout paths exist (handler.ts:178, the inline client_joined loop at 413-419, server.ts:1331-1339
  broadcastToSession).
- **Symptom.** On a slow client, bursts of `task_changed`/`set_image_model` grow `bufferedAmount` with no
  warn and no protective terminate (the memory-bounding terminate never runs). Low because frames are
  small and there is no production high-rate `task_*` browser emitter (only MCP server-side + tests).
- **Lowest-risk fix.** Route handler broadcasts through the same guarded helper (extract the guard into a
  shared module imported by both) so the overflow invariant is global.

#### S37 — aigw `x-opencode-session` header forks a subprocess on every LLM request via the UNCACHED resolver — **MEDIUM** (symptom corrected: overhead, not silent affinity loss)
- **Trigger.** Any aigw-routed turn. Each LLM round-trip calls `streamFn` (sdk.js:201) →
  `getApiKeyAndHeaders` (model-registry.js:577) → `resolveHeadersOrThrow` (the UNCACHED entrypoint) →
  `executeCommandUncached` → `spawnSync`/`execSync` (resolve-config-value.js:174-182). The
  `commandResultCache` is only consulted by the cached `resolveHeaders`, which the request path doesn't
  use. A turn with N tool calls = N+1 forks. In the Docker pool it is `execSync("sh -c node -e …")` — a
  shell fork PLUS full Node startup per request.
- **Failure line.** `src/server/agent/aigw-manager.ts:387-390` (the `!node -e` command-form header),
  resolved per-request at `model-registry.js:577`.
- **Symptom.** A node process spawn per LLM request → added latency + CPU on every agentic step,
  compounding over multi-tool turns; matches "worse over high-latency VPN / under load." (Corrected: the
  request path THROWS on empty resolution — resolve-config-value.js:207-208, rethrown sdk.js:203-204 — so
  a fork hiccup FAILS the turn with a visible error, NOT silent affinity loss.)
- **Minimal repro.** Spy on `child_process.spawnSync`/`execSync`; run a multi-step aigw turn; assert
  spawn count == number of LLM round-trips (not once per process).
- **Lowest-risk fix.** Replace the `!node -e` header with a static value resolved once: env-interpolation
  template `${BOBBIT_SESSION_ID}` (uses `resolveTemplate`, no spawn) instead of `!node -e …`, or inject
  `x-opencode-session` at the gateway proxy layer.

### Symptom family: other

#### S39 — Deferred-block placeholders hide content from non-Ctrl+F DOM consumers — **LOW** (scope narrowed to screen-reader virtual cursor)
- **Trigger.** Default config (`deferOffscreenRender` ON). Long transcript (>8 history rows render as
  placeholders). A screen-reader virtual-cursor read-from-top of the unscrolled region — without scrolling
  each placeholder into view and without a real Ctrl+F/Cmd+F/F3 keydown — reads empty placeholders.
- **Failure line.** `src/ui/components/DeferredBlock.ts:177-181` (empty placeholder until `resolved`;
  resolution only via IntersectionObserver-on-scroll or the single find-key listener at 212-235).
- **Symptom.** Screen-reader users skip un-scrolled transcript content (data is present in
  `state.messages`).
- **Scope correction.** The seam's "in-app/programmatic search" and "copy-all" consumers do NOT exist in
  production: the only transcript search is the `read_session` tool reading the persisted `.jsonl`
  (transcript-reader.ts:412-447, never the DOM), and there is no copy-conversation/select-all-transcript
  feature. Only the SR path is a real trigger → low. (The claimed `aria-hidden` significance is a red
  herring — the placeholder is empty, so it's content *absence*, not the ARIA attribute.)
- **Lowest-risk fix.** Keep text in the DOM visually clipped (`content-visibility:auto` /
  `contain-intrinsic-size`) rather than removed, so accessibility/search/copy work while paint cost is
  still deferred; or expose a resolve-on-focus/resolve-on-find API.

---

## 3. REFUTED / NEEDS-TRACE

### Refuted (symptom does not occur in production; benign residual or latent-robustness note only)

| Seam | Verdict | Why refuted (the specific guard/test) | Residual / settling trace |
|------|---------|----------------------------------------|---------------------------|
| **S12** — two-channel status leaves a stale streaming row | REFUTED (symptom) | The state residue (`_state.streamingMessage` lingers non-null after idle) is real, but the rendered streaming bubble is driven by `<streaming-message-container>`'s private `_message`, NOT `_state.streamingMessage`. The container self-heals: `StreamingMessageContainer.updated()` (StreamingMessageContainer.ts:43-68) clears `_message` on `isStreaming`→false, and the instant `session_status:idle` drives `requestUpdate` (session-manager.ts:1242-1248) → `isStreaming=false` binding (AgentInterface.ts:1596) → the self-heal. **Pinned by `streaming-message-container-set-message.spec.ts:107-155`** against the REAL bundled component. | Hygiene-only: have the `session_status:idle` handler also null `_state.streamingMessage` so the field can't lie. Severity low. A Playwright run injecting the gap + asserting a stale DOM bubble post-idle would FAIL (self-heal). |
| **S24** — perm-frame seq-gap recovery leaves stuck spinner / compaction placeholder | REFUTED (trigger unreachable) | A perm frame can never arrive with `seq != _highestSeq+1` in production: `push`/`pushFrame` share one monotonic counter (event-buffer.ts:28/42); the agent emits NOTHING between `tool_execution_start` and the perm frame (the guard runs inside `beforeToolCall`, awaited after the start event), so `perm.seq == start.seq+1` always; reconnect-with-pending-perm replays the ORIGINAL seq (handler.ts:458-460) — contiguous, pinned by `perm-frame-late-joiner-seq-gap.test.ts`. Compaction can't be in-flight mid-tool-batch (`compact()` requires an idle harness). | The real cousin (snapshot not rebuilding `pendingToolCalls`/`_isCompacting`) is reachable only via S9 overflow or resume_gap — investigate THERE, not the perm-frame branch. |
| **S28** — cap-park parks prompts behind human-only Retry with "no signal / frozen session" | REFUTED (symptom) | The cap-park mechanism is real (consecutiveErrorTurns not reset on implicit unstick; park at session-manager.ts:1757) but TWO persistent signals exist: (1) the errored assistant `message_end` always carries a non-empty `errorMessage` (agent.js:329-338) rendered as a red "Error: …" block WITH a live Retry button (Messages.ts:393-419, wired via AgentInterface.ts:1578) that PERSISTS through every parked prompt (parking emits only a queue_update, not a user message_end); (2) `needsImmediateHumanAttention` (notification-policy.ts:156-167) lights the unseen dot. | Residual UX-polish nit: a parked prompt produces a queue pill with no NEW toast/inline hint adjacent to the composer, so a user focused on the input under high latency might overlook the banner above. Low. |
| **S30** — `compaction_end` synthesized-from-`response` double-fire | REFUTED | The synthesized `compaction_end` is produced via `this.emit(...)` (remote-agent.ts:2333-2337), and `emit` (800-804) only notifies UI subscribers — it never re-enters `handleAgentEvent`, so no card transition/reducer apply. The reducer compaction-result case filters by stable id (`compact_active`/`compacting_placeholder`/toolCallId, message-reducer.ts:539-543) → a single card even on a genuine double. **Pinned by message-reducer.test.ts case 12d.** | Optional cosmetic hardening (skip re-scheduling the card transition when `_compactionStartedAt` is null). Not required. |
| **S41** — attach `compaction_start` unicast duplicates the agent's seq'd one | REFUTED | The attach unicast reaches the client compat path → `_addCompactingPlaceholder` → reducer `compaction-placeholder` which filters by the stable ids `compacting_placeholder`/`compact_active` (message-reducer.ts:520-522) → a SINGLE card. The doc's premise ("reducer keys by content/time") is false; it keys by stable id. | Optional: guard `_compactionStartedAt` assignment in `case compaction_start` with `if (this._compactionStartedAt == null)` so a redundant second start doesn't skew duration. |
| **S43** — stale spawn handler emits spurious "Agent process exited" | REFUTED (symptom) | Spawn-phase transient errors (ENOTCONN/EMFILE/ENFILE/EAGAIN — the only codes the retry treats as transient) emit `error` but NEVER a later `exit` (verified empirically: spawn-failure 'error' is never followed by 'exit', kill() returns false). The persistent `on('error')` (registered at :205, before the temporary `.once` at :225) runs first and nulls `this.process`, so the catch's `kill()` is a no-op. The immediate-exit path fires the persistent exit handler synchronously during attempt 0 (before P1 exists), leaving `running===true`. Any transient `process_exit` during a successful retry start() is superseded by the "idle" broadcast at session-manager.ts:3479. | Residual: per-retry EventEmitter listener leak on the dead child (cannot null the replacement or emit a spurious exit). Fix: `removeAllListeners()` before kill at rpc-bridge.ts:242. Low. (Listed in §2 as the low residual.) |
| **S44** — `showLightbox` window listeners + detached `<img>` leak | REFUTED | ALL in-code removal paths funnel through `close()` (image-utils.ts:84-89), which removes all three window listeners and the overlay; backdrop/1x-image click (96-98) and Escape (91-93) both call it. The overlay is parented to `document.body`, so SPA re-renders don't detach it. The "removed without close()" leak requires an external actor that doesn't occur in the app. | Defensive hardening (scope listeners to the overlay; add a disconnectedCallback safety net). Low priority. To confirm: open/close 100× and assert listener + detached-`<img>` counts return to baseline. |
| **S45** — tool-result image blocks missing `mimeType` silently dropped | REFUTED (trigger unreachable) | The filter (image-utils.ts:113 requires truthy `mimeType`) is real, but NO producer emits a mimeType-less tool-result image block: built-in Read gates on `if (mimeType)` and always emits `{type:'image',data,mimeType}` (read.js:168/189/199); browser screenshot + generate_image always set it; and the MCP path is decisive — the dynamically-generated `mcp_<server>` execute body reduces every MCP result to text (tool-activation.ts:497-506/635-644), DISCARDING image blocks server-side before they reach the UI. | Latent defensive-consistency gap only. NEEDS-TRACE if a future image-capable MCP/tool bridge preserves image blocks — settle by capturing a `tool_result` in the `.jsonl` whose content has an image block with no mimeType (cannot be produced today). |
| **S46** — snapshot image restore mislabels non-PNG as image/png | REFUTED (MIME half) | pi-ai `ImageContent` has a REQUIRED `mimeType` (types.d.ts:163-167); the client always sends the real mimeType (remote-agent.ts:831; message-editor-attach.spec.ts:54/236 confirm .jpg→image/jpeg); pi persists verbatim (agent-session.js:279, plain JSON.stringify/parse); `get_messages` returns it verbatim. So at message-reducer.ts:172 `img.mimeType` is present and the `|| 'image/png'` fallback NEVER fires — `AttachmentTile.ts:50` emits the correct `data:image/jpeg`. | Residual (HOLDS, low): message-reducer.ts:171 hardcodes the filename `image-${i+1}.png`; the original filename isn't persisted in pi's `ImageContent`, so a restored JPEG shows "image-1.png" in alt/title/download — a cosmetic suffix mislabel only (MIME + data URL are correct). |

### Confirmed-mechanism-but-NEEDS-TRACE residue

| Seam | Status | The unobservable | The trace that settles it |
|------|--------|------------------|---------------------------|
| **S13** | CONFIRMED code path, NEEDS-TRACE wall-clock | Whether real auto-compaction over a full-size context window actually exceeds the 30s prompt-ack timeout. | Instrument `rpc-bridge.sendCommand` to log wall-clock between the prompt write and its matching response/timeout for a real over-threshold Claude session over the VPN; a measured >30s straddling `compaction_start`/`compaction_end` confirms the double-dispatch. |
| **S11** | NEEDS-TRACE (timing) | Whether Lit batches the container-clear and message-list-inclusion into the same microtask, or commits them a frame apart. | Spawned-gateway E2E with a rAF/MutationObserver probe asserting the finalized assistant text is in EITHER surface on every frame across the no-toolCall `message_end` hand-off. |
| **S5** (reorder sub-path only) | resume-loss CONFIRMED; reorder NEEDS-TRACE | Whether `_pendingEvents` can be non-empty (a real live seq gap) coincident with a seq-less frame on an attached client. | Force a real seq gap (packet drop or a regressed perm-frame unicast) and fire `auto_retry_pending` into the gap; assert the seq-less frame's side effects fire before the buffered seq'd content. |
| **S8** (shape a only) | shape (b) CONFIRMED; shape (a) ~30s delay NEEDS-TRACE | Whether a real wedged upstream keeps `waitForIdle` from resolving within 30s (keep-alive-trickling SSE vs the abort signal). | Timestamp (Stop click)→(rpc abort response/30s timeout)→(force-kill) against a real keep-alive-trickling gateway; ~30s gap confirms shape (a) in production. |
| **S15** | REFUTED mechanism, NEEDS-TRACE residue | The prior seam ("switch_session replays history through the seq-stamping emit, inflating seq") is refuted from source: pi's `switch_session` rebuilds session state via `createRuntime`/`buildSessionContext` WITHOUT emitting per-message events (agent-session-runtime.js:125-142; only an extension-level `session_start` at agent-session.js:1645). The in-process mock corroborates (switch_session emits nothing, mock-agent-core.mjs:1978). The Bobbit `restoring` guard/comment is stale. | In `test:manual`, restore a >5-event session and capture the EventBuffer seq before vs after `switch_session`; assert it advances by 0 (only by genuinely-new live frames), not by history length. Inferred from source against pi 0.77.0, not observed on the running binary → medium confidence. |
| **S27** | REFUTED mechanism, NEEDS-TRACE residue | The prior seam ("SDK echoes N separate messages for a batched steer, so the joined `batchText` ledger entry never matches") is refuted: Bobbit dispatches one `steer(batchText)` per batch (one ledger entry, session-manager.ts:1923/1937), the SDK queues it as ONE user message (agent-session.js:923-934), and the echo carries `text===batchText`, which `_consumeSteerEcho`'s `indexOf` (session-manager.ts:1971) matches. | Residual: skill/prompt-template expansion inside the agent (agent-session.js:899-900) could rewrite the echo body so it ≠ `batchText`. Queue two steers containing a `/skill:` invocation, dispatch as a batch, and confirm via a `get_messages` snapshot whether the echoed user text equals the joined raw `batchText` (matches ledger) or the expanded text (would survive → stale re-dispatch). |

---

### Trace results (settled — instrumented/lead-run, 2026-05-31)

The NEEDS-TRACE residue was settled by direct instrumentation + source verification (no API spend
required for any of them):

| Seam | Prior status | **Settled outcome** | Evidence |
|------|--------------|---------------------|----------|
| **S14** | NEEDS-TRACE (write granularity) | **CONFIRMED** — promote to a real defect | Deterministic repro mirroring the exact production decode (`rpc-bridge.ts:299-300` per-chunk `chunk.toString("utf-8")` → string `lineBuffer` accumulation, `:585-588`): a JSON `message_end` line split at every internal byte boundary corrupts the text at **16/115** split points for 3-byte CJK, **6/114** for 4-byte emoji (a whole `🚀`→`����`), **3/106** for 2-byte accented Latin; ASCII baseline 0/107. A persistent `StringDecoder` is clean at every split. Splits are inevitable once a multibyte payload exceeds the OS pipe buffer (smaller on Windows named pipes), so it is reachable in normal use. The repro logic becomes the WP8 red test. |
| **S13** | NEEDS-TRACE (compaction wall-clock) | **CONFIRMED** — wall-clock measurement is not decision-relevant | (1) Code path verified: the auto-compaction (`agent-session.js:766` `await this._checkCompaction` → `await this.agent.continue()`) runs INSIDE prompt handling, BEFORE `preflightResult(true)` at `:825` (the only ack emitter, rpc-mode.js:302-305). (2) **Asymmetric-timeout smoking gun:** `sendCommand` default is **30s** (`rpc-bridge.ts:371`) and `prompt()` uses it (`:396`), but `compact()` is explicitly given **120s** (`:441-442`) — the maintainers' own 4× budget concedes compaction routinely exceeds 30s. The prompt-path compaction is covered only by the 30s prompt timeout, so a >30s auto-compaction → ack timeout → `recoverPromptDispatch` re-dispatch → duplicate turn. The exact wall-clock would only add a number; the fix (give the compaction-gated prompt ack the generous budget, or keep the pending entry alive past timeout) is low-risk regardless. |
| **S15** | REFUTED mechanism, NEEDS-TRACE residue | **REFUTED — confirmed from source (high confidence)** | `switchSession` (`agent-session-runtime.js:125-142`) tears down + `createRuntime` with a single `{type:"session_start", reason:"resume"}` event (rebuilds `agent.state.messages` directly via `buildSessionContext`, cf. `newSession` `:163`); `bindExtensions` emits only `_sessionStartEvent` (`agent-session.js:1645`). **No per-message replay loop** → it cannot inflate Bobbit's per-session seq by history length. The Bobbit-side "restoring" guard/comment is stale. |
| **S11**, **S8 (shape a)**, **S5 (reorder leg)**, **S27** | NEEDS-TRACE | **Fix-invariant** — the chosen fix covers the behaviour regardless of the unobserved parameter | S11 (no-toolCall hand-off flicker): the single-render-owner fix removes the question; a flaky per-frame DOM probe is not worth it for a cosmetic single frame. S8 shape-a (wedged upstream >30s): the 3s force-kill fix covers shapes (a) AND (b) identically. S5 reorder leg: routing the three frames through `emitSessionEvent` fixes both the resume-loss (confirmed) and any reorder leg. S27: the id-based/multiset steer dedup (RC1/WP10) is correct whether the SDK echoes one message or N. None of these measurements change the decision or the fix. |

---

## 4. Test-suite fidelity report — why every confirmed defect passes CI

The suite is GREEN despite 41 confirmed defects because of a small set of **comfortable assumptions
baked into the mock agent and the pinning fixtures**. Prioritised by how many real bugs they hide.

### P0 — The mock agent structurally cannot echo user image content blocks (hides S1, S6, S18, S26, S46)
- **Comfortable assumption.** "The image attachment round-trip is exercised by the e2e harnesses."
- **Reality.** Both harnesses route every session through `MockAgentCore`. `handlePrompt` hard-codes
  the user echo as `{role:'user', content:[{type:'text', text}]}` (mock-agent-core.mjs:473-475) — zero
  image blocks anywhere (grep `type:'image'` returns nothing). `InProcessMockBridge.prompt(text, images)`
  accepts `images` (in-process-mock-bridge.mjs:87-91) but `handleCommand` case 'prompt'
  (mock-agent-core.mjs:1810-1832) reads only `msg.message` and DISCARDS `images`. `get_messages`
  (1959-1960) returns those text-only messages. So the entire client image pipeline — live bare-block
  render (S6), the `_pendingAttachments` slot carry-through (S1), `enrichUserMessage` snapshot
  reconstruction (S46) — runs against an echo with no image data at all. CI is green because the failure
  mode is excised at the mock boundary. Reducer cases (6)/(7) (message-reducer.test.ts:138-158) use
  text-only `userMsg`, never `user-with-attachments`; `message-editor-attach.spec.ts` stops at the
  composer and never sends; `inline-file-images.test.ts` is the QA-report inliner (orthogonal);
  `image-generation-providers.spec.ts` is the wrong direction (server pulls FROM provider).
- **What a faithful test needs.** A mock trigger (e.g. `ECHO_IMAGE_BLOCK`) whose `handlePrompt` builds
  the user echo as `{role:'user', content:[{type:'text',text},{type:'image',data,mimeType}]}` from the
  images actually forwarded on the prompt command, pushes it into `conversationMessages` (so
  `get_messages` returns it), PLUS a `MOCK_USER_ECHO_DELAY_MS` latency knob to widen the optimistic→echo
  gap. Drive it through the real `RemoteAgent` over a gateway, attach a real image, and assert the
  `<attachment-tile>` is present BOTH on the live echo AND after reload. Plus reducer unit cases:
  snapshot with image chunks → assert `enrichUserMessage` rebuilds a correctly-typed tile (non-PNG
  variant to pin the S46 filename suffix); live-event with image blocks → assert the tile renders (FAILS
  today — pins the S6 fix); optimistic `user-with-attachments` + same-text image echo → single row,
  attachment preserved (pins S1/S18).

### P0 — The riskiest seq path (S9 overflow) is untested in BOTH the fixture and production
- **Comfortable assumption.** "The seq sequencer is pinned by `remote-agent-seq-dedup.spec.ts`."
- **Reality.** `remote-agent-seq-dedup.html` (lines 40-58) HAND-COPIES `handleServerMessage` and the
  copy has NO `_pendingEventsMax`, NO overflow branch, NO `_highestSeq=0` reset, NO `_inResumeFallback`.
  Grep of `tests/` for `_pendingEventsMax`/`overflow`/`_inResumeFallback` = zero hits. So the single
  branch most likely to stall live streaming (S9) has zero coverage in both the fixture and any
  production-driving test. The fixture's own "if production diverges, update these" comment is
  aspirational; nothing enforces the match (S23).
- **What a faithful test needs.** A test that imports/drives the REAL `RemoteAgent.handleServerMessage`
  (or a generated bundle of the real source), feeds 501+ out-of-order seq'd frames to force the overflow,
  delivers the snapshot, then a fresh live event, and asserts it re-baselines (dispatches) rather than
  permanently gap-buffering. This settles open question #2.

### P1 — Heartbeat & `status_resync` self-heal pinned by inline-mirror copies that have drifted (S22, blinds S38)
- **Comfortable assumption.** "Status recovery is pinned by `session-manager-status.test.ts` /
  `remote-agent-status.spec.ts`."
- **Reality.** `session-manager-status.test.ts` defines `emitHeartbeat()`/`handleStatusResync()` as LOCAL
  functions (lines 108-121/151-159), NOT the real SessionManager/handler. `remote-agent-status.html`'s
  `handleSessionStatus` (42-59) has STRUCTURALLY DIVERGED from production (remote-agent.ts:1450-1493): it
  omits the `_maybeReplayGrant(msg.status)` calls in BOTH the idempotent (real :1461) and apply (real
  :1491) branches and the archived branch (:1479-1481). A regression breaking grant-replay/status coupling
  (S38) or the archived frame would pass every one of these tests. The one real-code heartbeat test
  (`session-manager-heartbeat.test.ts`) only checks set bookkeeping + "no version bump," never the
  recovery SCENARIO.
- **What a faithful test needs.** Drive the REAL `SessionManager._emitStatusHeartbeat` and the REAL
  handler `status_resync` against a real `SessionInfo`; import the REAL `RemoteAgent` class (not the HTML
  copy) and drive `case 'session_status'` so `_maybeReplayGrant`/archived coupling is exercised; have
  `session-status-recovery.spec.ts` reproduce a genuinely dropped frame rather than artificially setting
  `_lastStatusVersion=-1`.

### P1 — Server-side auto-retry timer fire/cancel is entirely untested behaviourally (S40, S5/S21)
- **Comfortable assumption.** "Auto-retry is pinned by `auto-retry-policy.test.ts` / `queue-dispatch.spec.ts`."
- **Reality.** NO test drives the real `SessionManager.maybeAutoRetryTransient`. `auto-retry-policy.test.ts`
  re-implements the decision tree as a local `decideRetryPolicy()` pure function (41-65);
  `queue-dispatch.spec.ts` uses a FAKE timer object `{cancelled:boolean}` (line 28), never a real
  `setTimeout`, never the real fire guard (`status!=='idle'`, session-manager.ts:2499). `auto-retry-banner.spec.ts`
  INJECTS the events client-side via `handleAgentEvent` and never exercises the server seq-less emit
  (S5/S21), reconnect-orphaned banner, or fire/cancel under the guard (S40).
- **What a faithful test needs.** A real-SessionManager unit test that schedules a real timer (transient
  errored turn), advances mocked timers, and asserts: (1) the fire guard is skipped when status flipped via
  a queue-drain/steer; (2) `forceAbort`/new-prompt cancels the timer; (3) the auto_retry frames' ordering
  vs `agent_start` on reconnect/replay.

### P1 — Server-side wedged-streaming (dead bridge, no agent_end) has no recovery test (S8)
- **Comfortable assumption.** "Abort/Stop is pinned by `abort-status-e2e.spec.ts`."
- **Reality.** That spec uses the mock agent which ALWAYS emits `agent_end` on abort, so only the happy
  grace-period path is tested, never the force-kill+respawn branch (session-manager.ts:5706-5732) or the
  heartbeat-faithfully-rebroadcasts-the-wedged-truth failure. The mock's default abort also uses the WRONG
  shape: it emits only `agent_end`+idle (no assistant message), and the opt-in `MOCK_ABORT_AS_ERROR=1`
  uses `stopReason:'error'` with `content:[]` — but the real user-abort emits `stopReason:'aborted'`,
  `content:[{type:'text',text:''}]`, which take different code paths (this is exactly the S7/S10 empty-text
  row the mock never produces).
- **What a faithful test needs.** A mock bridge that accepts a prompt, sets status=streaming, then goes
  silent (never agent_end, abort() hangs/fails); assert `forceAbort` enters the force-kill branch,
  broadcasts the synthetic agent_end+idle, and recovers — distinct from `restart_agent`. Separately, make
  the DEFAULT mock abort emit the real `stopReason:'aborted'` empty-text shape so S7/S10 are exercisable.

### P2 — The full-stack snapshot↔live race test (H3 case A) is `test.fixme` and the live cases carry no images
- **Reality.** `repro-h3-snapshot-live-interleave.spec.ts` is the ONLY test driving the real `RemoteAgent`
  over a spawned gateway, but case A (the actual mid-stream snapshot-resync race) is `test.fixme` (line
  144, "flaky on master (reproducible)"). The running cases B/C/D use plain-text only, call
  `ra.requestMessages()` directly (not a real visibilitychange/reconnect), and assert on `_state.messages`
  not rendered DOM — so the bare-image-block render gap (S6) wouldn't be caught even if an image were
  present.
- **What a faithful test needs.** Un-quarantine case A with a deterministic harness that lands a snapshot
  WHILE a `message_end` is in flight (the mock gating the `message_end` on a server signal), plus an
  image-attachment variant asserting on the rendered tile (DOM), not just the messages array.

### P2 — Other fidelity gaps (lower priority)
- **Mock omits `message_start`** for every message (real agent emits it for user + assistant + toolResult,
  agent-loop.js:51-52/97-98). Hides any reducer/echo ordering logic that assumes `message_start` precedes
  `message_end` (widens S4/S17/S18 window assumptions). Fix: emit `{type:'message_start', message}` before
  each `message_end`.
- **Mock echo timing is synchronous (~instant)** — the optimistic→echo race the user sees worse over VPN
  is never widened in CI. The only latency knob (`MOCK_STEER_ECHO_DELAY_MS`) is steer-only. Fix: an
  env-gated prompt-path echo-delay knob so tests can land a snapshot or a second send INSIDE the gap.
- **Mock default text reply emits no `message_update` stream** (faithful to id-absence — good for S7 — but
  not to streaming granularity, hiding S33/S11/S34's hot-path cost). Fix: stream N id-less deltas before
  `message_end`.
- **`ws-overflow-guard.test.ts` covers only the pure decision function** (OG-01..07), never the real
  broadcast loop and never the unguarded handler-local `broadcast()` (S36).
- **`rpc-bridge-lifecycle.test.ts` covers only crash-before-reply**, never the 30s slow-ack double-dispatch
  (S13). Fix: a stub CLI that delays its response past an injectable lowered ack timeout.
- **`snapshot-clears-streaming-message.test.ts` is a source-text regex scan**, not behavioral — a refactor
  that keeps the regex but breaks the clear (or the S12 two-channel interleave) passes.

---

## 5. Root-cause clusters (fix each once)

The 41 confirmed defects collapse into **eight root causes**. The Step-3 plan should fix each cluster
once rather than patching seams individually.

### RC1 — No stable correlation id between client-optimistic, server-persisted, and live-echo rows
Server user messages are persisted id-less (agent.js:255-259, agent-session.js:269-279) and the
optimistic id (`optimistic_<ts>_<rand>`) can never match a server copy, so reconciliation falls back to
exact-text — which breaks on skill-expansion divergence and same-text overlap.
**Covers:** S7, S10, S17, S18 (and the deep fix for S1's mis-attach). **One fix:** stamp a stable
synthetic id (`synth:seq:<eventSeq>`) on id-less server rows at the reducer boundary AND carry the
client's optimistic id through to the server echo, so all dedup is id-based regardless of text/emptiness.

### RC2 — The `_pendingAttachments` single-slot stash + the bare-image-block render gap
One slot (remote-agent.ts:847) carries image enrichment that only the live `message_end` consumes, and
`UserMessage` has no branch for `type:'image'` content blocks (Messages.ts:183-195); `enrichUserMessage`
runs only on snapshot.
**Covers:** S1, S6 (and the image leg of S18/S46). **One fix:** render attachment tiles directly from
`content` image blocks in `UserMessage`, and run `enrichUserMessage` on the live-event path too — making
the slot non-load-bearing for image DATA.

### RC3 — The seq-less, unbuffered bypass broadcast channel
Three frames (`auto_retry_pending`, `auto_retry_cancelled`, force-abort `agent_end`) skip
`emitSessionEvent`, so they get no seq, never enter the EventBuffer, and never replay on resume — and the
client compat path dispatches them without advancing `_highestSeq`.
**Covers:** S5, S21 (and the resume-loss half of S8's drift case). **One fix:** route all three through
`emitSessionEvent`; add a structural test asserting the seq-less broadcast set is exhaustive; reconcile
`autoRetryPending`/streaming-clear from authoritative server state on snapshot.

### RC4 — The client seq-recovery state machine has one un-rebaselined branch + one un-retained hole
The overflow branch sets `_highestSeq=0` while leaving `_seqInitialized=true` (nothing re-baselines), and
`pushFrame` consumes a perm seq without retaining it (a permanent hole on resume).
**Covers:** S9, S25 (and the tail of S5's reorder). **One fix:** in the overflow branch set
`_seqInitialized=false` (or `_highestSeq=seq`); retain perm frames in the EventBuffer so `since()` is
hole-free.

### RC5 — No back-pressure / commit safety on the user-intent send path
`send()` drops frames when not OPEN with no outbox (S2); the editor clears + optimistic bubble commit
before delivery is confirmed (S2/S31); no aggregate composer cap + default 100 MiB ws cap (S31); the grant
replay rides the same droppable `send()` (S38).
**Covers:** S2, S31, S38. **One fix:** a bounded `_pendingOutbox` for prompt/steer/retry frames flushed on
`auth_ok`, with the optimistic bubble in a "pending/unsent" state until delivered; an aggregate composer
size guard with a user-visible error; an explicit `maxPayload` on the WebSocketServer.

### RC6 — Full-base64 payloads carried/re-serialized/persisted where only metadata is needed
`broadcastQueue` re-serializes the whole base64 queue per mutation (S19); document `content` rides the wire
+ server memory but never reaches the model (S20); images base64-inflate ~3x on the frame (S31 threshold).
**Covers:** S19, S20 (and S31's threshold). **One fix:** a `toBroadcastArray()`/projection that strips
`images.data`/`attachments.content`/`attachments.preview` from broadcast+persist, keeping ids; drop
document `content` on the remote send (keep `extractedText`).

### RC7 — The respawn/continuation path doesn't distinguish in-place from cold restore
`wasStreaming` is true mid-grant-respawn, so the post-crash continuation prompt fires on routine grant/
role-switch respawns (S16), and the client grant-replay then races a second prompt (S38).
**Covers:** S16, S38. **One fix:** thread a `respawnReason`/`_suppressContinuationPrompt` flag through
`_respawnAgentInPlace` so `restoreSession` skips the continuation prompt for grant/role-switch/restartAgent.

### RC8 — Unbounded/unthrottled hot-path work + non-decoder stdout reads
Per-chunk UTF-8 decode without a `StringDecoder` (S14); per-delta proposal regex over growing text (S32);
per-event `getBoundingClientRect` loop (S34); synchronous base64 encode (S35); per-request subprocess fork
for the aigw header (S37).
**Covers:** S14, S32, S34, S35, S37. **One fix per item, all low-risk:** persistent `StringDecoder`;
throttle + `indexOf` precheck for proposals; rAF-coalesced jump-button + IntersectionObserver counts;
`readAsDataURL`/Worker for encode; static env-interpolation header instead of `!node -e`.

### Lower-risk standalone fixes (not in a cluster)
S3 (IME guard — one-line), S33 (trailing-flush — cosmetic), S36 (shared overflow guard), S39
(content-visibility instead of removal), S40 (cancel timer in forceAbort / guard the team-abort route),
S42 (multiset steer dedup), S43 (`removeAllListeners` before kill).
