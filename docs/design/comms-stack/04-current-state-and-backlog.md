# Bobbit Real-Time Comms Stack — Step-4: Current-State Verdict + Hand-off Task Backlog

> **Date:** 2026-06-10 · **Baseline:** master @ `6ec8c8f9` · Follows
> [01-understanding.md](01-understanding.md) (S1–S46 seam table),
> [02-analysis.md](02-analysis.md) (verdicts, RC1–RC8, test-fidelity §4),
> [03-remediation-plan.md](03-remediation-plan.md) (WP0–WP11 / PR-0..D).
>
> **What this document is:** (§2) a seam-by-seam verdict on what actually shipped vs. what the
> plan promised; (§3) settlement of the open NEEDS-TRACE residues; (§4) a register of NEW
> defects found beyond the 46 catalogued seams; (§5) the updated invariant ledger with every
> unpinned invariant flagged; (§6) **the deliverable — an ordered backlog of self-contained
> hand-off tasks** (each executable by an agent who sees only that task's text), grouped into
> waves with acceptance gates.
>
> **Status:** backlog not started. Workstream **CS** in
> [../fable-program-execution-plan.md](../fable-program-execution-plan.md) (program
> sequencing + master checklist). Land CS tasks in the §7 merge-map order; `session-manager.ts`
> is also touched by CE-G3 and EP — serialize per the execution plan's shared-seam table.
>
> **Method:** every claim was re-verified against the current tree by parallel adversarial
> audits (file:line anchors below are current as of `6ec8c8f9`, not the drifted anchors in
> docs 01–03). SDK ground truth was read from the installed `pi-coding-agent`/`pi-agent-core`
> and cross-checked against the published 0.77.0 tarball.
>
> **Environment caveat (re-verify before implementing):** `package.json` declares
> `@earendil-works/pi-* 0.77.0` but this checkout's `node_modules` contains only
> `@mariozechner/pi-*` (pi-coding-agent at **0.67.5**). The SDK-behaviour claims below
> (steer expansion-before-queue, steering queue retained across abort, ack-after-compaction,
> `switch_session` no-replay, SDK-internal auto-retry default-on) were verified against the
> published 0.77.0 sources and agree across three independent reads — but implementers must
> `npm install` and re-confirm SDK anchors in their own tree.

---

## 1. Executive summary

**What shipped.** One PR (#674, `d520620f`, 2026-06-01) landed: WP0 (partial), WP1 (RC2
images), WP2 (RC1 dedup, minus the prefixed-S17 leg), WP3 (S2 outbox + S31 caps), WP4 (RC3
seq-less broadcasts, minus the snapshot-reconcile step), the S9 half of WP5, the S8
grace-race + S40 halves of WP9/WP10, S42, S14, S3, and (earlier, separately) the WP11
search-flush teardown fix. **What did not ship:** WP5's S25 leg, WP6 (S16/S38), WP7
(S19/S20), WP8 except S14 (S32/S34/S35/S37), most WP10 standalones (S26/S33/S36/S43), S4,
S13, S29, two of the three WP11 flake fixes, and several promised WP0 harness legs (faithful
mock abort shape, `message_start`, steer-image threading, the behavioural auto-retry/status
harnesses).

**Symptom-family status.**
- **(B) images** — substantially fixed (render-from-content + live enrichment, faithful
  pins). Residuals: S26 steered images (data-loss, untouched), a **new deterministic
  duplicate** on blank-text attachment-only sends (F10), document attachments still never
  reach the model (S20).
- **(A) duplicates** — reducer-level holes closed and pinned. Residuals: the prefixed
  error-recovery echo (S17 leg, deliberately deferred, still open), a raw-role keying edge
  (F11a), S4 double-Enter (never shipped), and several **new server-side duplicate-turn
  mechanisms** that dwarf the reducer class: SDK-vs-Bobbit double auto-retry (F5),
  graceful-abort steer double-delivery (F3a), recovery-after-kill at-least-once re-dispatch
  (F2b, F9).
- **(C) freeze / dead Stop / lost prompts** — Stop is now reliable (3s force-kill, seq'd
  synthetic `agent_end`); the outbox closes the headline silent-loss. Residuals: S25 resume
  stall (open), outbox loss on navigation-away and mid-flush (F14), steers parked dormant in
  the SDK (F3b — deterministic, including across restart), prompts that never auto-drain
  after `preparing`/restore (F7), **a gateway-crash bug** (F1), and a respawn-concurrency
  cluster that can split-brain tabs and corrupt the status channel (F2).
- **(D) jank / teardown** — almost nothing shipped (only S14/S31). S19/S20/S32/S34/S35/S37
  all still open as catalogued.

**The biggest single discovery of this pass:** the prior audit's queue/steer/respawn
*interaction surfaces* hide a cluster of HIGH-severity, mostly deterministic server-side
bugs (F1–F7) that none of the 46 catalogued seams covered. They share three root causes:
**(RC-A)** no lifecycle fencing of the old `SessionInfo` across in-place respawn; **(RC-B)**
Bobbit's `idle` status conflates "dispatchable" with two busy states the SDK actually has
(compacting, internal-retry backoff); **(RC-C)** steer delivery is neither at-most-once nor
at-least-once — the shadow ledger, the SDK steering queue, and the persisted prompt queue
each own the text at different moments with no reconciliation contract.

---

## 2. Seam-by-seam current status (all 46 + plan packages)

Verdicts: ✅ fixed+faithfully pinned · 🟡 partially fixed / fixed-with-open-edge ·
❌ still open (unshipped) · ⚪ refuted/obsolete (no action). Anchors are current.

| Seam | Verdict | Current state (anchors) |
|---|---|---|
| S1 slot | 🟡 | Image leg closed: slot demoted to one-shot fallback `remote-agent.ts:2562-2580`, live enrich `message-reducer.ts:241`. Open: document/PDF tiles still slot-dependent; fallback branch itself unpinned. |
| S2 send-drop | 🟡 | Outbox shipped (`remote-agent.ts:243-245,1435-1477`, flush on auth_ok `:749`; pinned by `tests/remote-agent-outbox.spec.ts`, real bundle). Open edges → **F14**: navigation-away discards a non-empty outbox (`src/app/session-manager.ts:930-941` caches only when `connected`); `_flushOutbox` doesn't re-push on failure (`:1472-1477`); `unsent:true` rendered by nothing; no browser E2E. |
| S3 IME | ✅ | `MessageEditor.ts:507-513` (isComposing + keyCode 229, before slash-menu). Pinned: `message-editor-ime.spec.ts` (real component). |
| S4 double-Enter | ❌ | Never shipped (assigned PR-B). Editor still clears after awaits (`AgentInterface.ts:1467-1491`), `onSend` un-awaited `:2113`, no re-entrancy flag; fixture clears synchronously (inverse of prod). → **CS-D9**. |
| S5 seq-less bypass | ✅ | All three frames via `emitSessionEvent` (`session-manager.ts:2642,2677,6166`). Pinned: `seqless-broadcast-exhaustive.test.ts` (source-walk, scoped to session-manager.ts only — caveat noted in ledger). Exhaustive re-scan found **no remaining S5-class hole**; the on-attach `compaction_start` unicast (`handler.ts:356`) and the `BOBBIT_E2E` replay shim are intentional/benign. |
| S6 image render gap | ✅ | `Messages.ts:246-267` rich-wins-else-content + `imageAttachmentsFromContent:789-809`. Pinned: `user-message-image-render.spec.ts` (real Lit bundle). |
| S7/S10 id-less empty-text dup | ✅ | `synth:seq:` stamp `message-reducer.ts:249-251`, `plainTextEquivKey:90-94`, empty-aware multisets `:393-399,441-451`. Pinned: `message-reducer-dedup.test.ts` (real reducer). Full-stack E2E leg still missing (mock abort shape unfaithful) → **CS-H1**. |
| S8 wedged Stop | 🟡 | Grace race fixed: listener-before-abort, un-awaited IIFE+catch, force-kill at ~3s (`session-manager.ts:6101-6136`), seq'd synthetic agent_end `:6166`. Watchdog deliberately dropped (plan §2.5.2). Residual: force-kill branch never clears `streamingStartedAt`/persisted `wasStreaming` → stale heartbeat payload + phantom continuation after a later hard crash → **CS-R9**. Pinned: `session-manager-force-abort-grace.test.ts` (real SessionManager). |
| S9 overflow stall | ✅ | Overflow sets `_seqInitialized=false` (`remote-agent.ts:1672-1683`); three recovery paths consistent. Pinned: `remote-agent-seq-overflow.spec.ts` (real bundled `handleServerMessage`). |
| S11 hand-off flicker | ⚪ | Settled by analysis: reducer mutates state before emit; container clear + list inclusion commit in the same task's microtask drain — no paintable blank frame. No action; pin only if the hand-off ever moves off the synchronous path. |
| S12 | ⚪ | Stays refuted (container self-heal pinned). |
| S13 30s ack double-dispatch | ❌ | Unchanged: `rpc-bridge.ts:445` 30s default, pending deleted on timeout `:454-457`, `compact()` gets 120s `:521`; recovery re-dispatches via `recoverPromptDispatch` (`session-manager.ts:2166-2209`). → **CS-R8**. |
| S14 UTF-8 split | ✅ | Persistent `StringDecoder` (`rpc-bridge.ts:213-214,374,380`). Pinned: `rpc-bridge-utf8-split.test.ts` — real decoder + real `handleData`, but the test mirrors the stdout wiring itself (a revert of `:374` would pass); decoders never `end()`-flushed / not re-created in `_attachProcessHandlers` (low — respawns build new bridges). Hardening pin → **CS-H2**. |
| S15 switch_session seq inflation | ⚪ | Closed from source (0.77.0 AND 0.67.5): `switchSession` rebuilds state with a single `session_start`, no per-message replay. The `restoring` guard comment at `session-manager.ts:3694-3704` is **stale and false** → cleanup in **CS-P3**. |
| S16 continuation prompt | ❌ | WP6 never shipped: `restoreSession:3766-3776` unconditional on `wasStreaming`; all grant modes + restartAgent + role-switch reach it via `_respawnAgentInPlace:3015`. → **CS-D6** (after CS-R2). |
| S17 skill-expand dup | 🟡 | Unprefixed client fallback shipped (`reconstructModelText`, `message-reducer.ts:102-117,282-288`) but is **inert in production** (expansion is server-side; optimistic rows never carry `skillExpansions`). The real defect — prefixed error-recovery echo missing the exact-match splice (`session-manager.ts:553-584` vs prefix at `:1941`) — is still open and now joined by the same-seam envelope leak (huntB C10). → **CS-D3**. Characterization pin at `message-reducer-dedup.test.ts:75`. |
| S18 optimistic survivor | 🟡 | Multiset consume shipped + over-dedup non-regressions pinned (`message-reducer.ts:485-499,301-312`). Open edge: `plainTextEquivKey` uses **raw role**, so a `user-with-attachments` optimistic vs `role:user` snapshot copy (documents / blank-text) never matches → duplicate (F11a) → **CS-D2**. |
| S19 queue base64 broadcast | ❌ | `broadcastQueue` still broadcasts+persists `toArray()` (`session-manager.ts:1782-1789`); a single ~1.5MB image can trip the 4MiB overflow-terminate on a slow client. → **CS-P1**. |
| S20 document bytes | ❌ | `remote-agent.ts:950-955` ships full attachments; `dispatchDirectPrompt` (`:2225`) forwards only `(text, images)`. → **CS-P1**. |
| S21 orphaned banner | 🟡 | Frames now seq'd+replayable (S5 fix). Open: snapshot handler never clears `_state.autoRetryPending` (WP4 step 4 unimplemented; only writers `remote-agent.ts:2374,2386,2401`); the `clients.size===0` cancel-skip (`session-manager.ts:2663-2679`) + forceAbort-idle path leaves a stuck banner for a later resume. → **CS-D7**. |
| S22 status mirror tests | ❌ | `session-manager-status.test.ts` inline mirrors and `fixtures/remote-agent-status.html` (omits `_maybeReplayGrant` + archived branch) still the only pins. → **CS-H2**. |
| S23 seq fixture mirrors | 🟡 | Overflow branch now real-code-pinned; plain dedup/reorder/baseline + `_advanceTopLevelSeq` + resume_gap still mirror-pinned (`remote-agent-seq-dedup.html`, `remote-agent-sequence-hole.html`). → **CS-H2**. |
| S24 | ⚪ | Stays refuted. |
| S25 perm resume hole | ❌ | `EventBuffer.pushFrame` still non-retaining (`event-buffer.ts:41-43`); resume `since()` has a permanent hole across a DENIED/TIMED-OUT perm; `event-buffer.test.ts:209-233` still pins the **pre-fix** contract. Severity now medium-low (S9 overflow self-heals after 500 events). → **CS-D8**. |
| S26 steered images | ❌ | Four drop points: `rpc-bridge.ts:479-481` (no images param), batch `session-manager.ts:2073,2089`, rollback `:2098-2100`, reconcile `:2136-2138`, drain batch keeps only `steered[0].images` `:2257-2259`. SDK supports steer images (rpc-mode `session.steer(message, images)`). → **CS-D4**. |
| S27 steer-echo expansion mismatch | **confirmed-latent** | Settled from source, no unobservable left: SDK `steer()` expands `/skill:`-prefixed and template-prefixed text **before** queueing (agent-session `_expandSkillCommand`/`expandPromptTemplate`); Bobbit's ledger holds raw text (`session-manager.ts:2073,2087`); `_consumeSteerEcho` exact-`indexOf` misses (`:2114-2123`, its own comment admits it) → stale entry re-dispatches on a later abort (skill runs twice). → folded into **CS-R3/CS-R4**. |
| S28 | ⚪ | Stays refuted. |
| S29 reconnect refetch | ❌ | `onReconnect` (`remote-agent.ts:755-771`) → 3 REST calls per reconnect (`src/app/session-manager.ts:1384-1390`); git-status deduped, bg-processes + annotations not. Mitigated by backoff. → **CS-P4**. |
| S30/S41/S43/S44/S45 | ⚪ | Stay refuted (S43's residual listener leak → **CS-P3**). |
| S31 payload caps | ✅ | `WS_MAX_PAYLOAD_BYTES=256MiB` (`server.ts:264,1346`); composer measures the **real serialized frame** (`MessageEditor.ts:56,62-73`) as the FIRST statement of `handleSend` (`:654-668`, draft preserved). Pinned: `ws-max-payload.test.ts` + `message-editor-size-guard.spec.ts` (real component). |
| S32 proposal scans | ❌ | `remote-agent.ts:2125-2170`, fresh RegExps per delta. → **CS-P2**. |
| S33 truncated flush | ❌ | `remote-agent.ts:2462-2468` plain `break`. → **CS-P3**. |
| S34 rect loop | ❌ | `AgentInterface.ts:672-684` via `_updateAndPin:723-733`. → **CS-P2**. |
| S35 sync base64 | ❌ | `attachment-utils.ts:88-95`. → **CS-P2**. |
| S36 unguarded handler broadcast | ❌ | `handler.ts:154-196`. → **CS-P3**. |
| S37 aigw header fork | ❌ | `aigw-manager.ts:381-389`; the two aigw tests **pin the defect**. → **CS-P2**. |
| S38 grant replay | 🟡 | Delivery leg fixed (replay rides the outbox). Open: fixed 200ms timer, still fired from the idempotent/heartbeat branch (`remote-agent.ts:1232-1241,1719-1721`); zero tests of any kind. → **CS-D6**. |
| S39 deferred-block a11y | ❌ | Unchanged; correctly re-scoped out of WP10 (own staged package; not in this backlog — UI-a11y, not comms). |
| S40 forceAbort cancels retry | ✅ | `session-manager.ts:6089-6093` before the `:6096` early-return. Pinned in the force-abort-grace test (real SessionManager). |
| S42 splice multiset | ✅ | `splice-inflight-message.ts:85-130` count-map. Pinned: `session-manager-getmessages-splice.test.ts:170-186`. |
| S46 mime mislabel | ✅/🟡 | MIME preserved end-to-end. Cosmetic residual: `image-N.png` filename hardcoded in both helpers — and post-WP1 the generic name now shows **live** too. Fold into any future image touch (noted, not tasked). |
| WP11 | 🟡 | search-flush ENOENT ✅ (awaited `closeAll`, `remove()` deliberately fire-and-forget per the docs deviation note); project-assistant-saved-state ✅; pre-compaction-history ❌ (no `__pinAgentSessionFile`); dynamic-chat-tabs ❌ (still samples the GET-mount hash, not `currentFilenameTab.state.contentHash`). → **CS-T1**. |
| repro-h3 case (A) | fixme | Still `test.fixme` (`repro-h3-snapshot-live-interleave.spec.ts:144`), correctly — owned by the separate snapshot-live-race goal; the deterministic gate (WP0 step 10) was never authored. → **CS-T2**. |

---

## 3. NEEDS-TRACE residues — settled

| Residue | Outcome |
|---|---|
| **S11** | **Refuted as a defect.** The state mutation precedes the emit; the container clear and the message-list inclusion are issued synchronously in one task and commit in its microtask drain — the browser cannot paint between them. The two-scheduler structure remains (re-pin only if the hand-off is ever made async). |
| **S13** | **Confirmed latent, fix unshipped.** Code path fully proven (ack emitted only after in-prompt auto-compaction; 30s vs the maintainers' own 120s compact budget). The wall-clock measurement is not decision-relevant. → **CS-R8**. |
| **S15** | **Closed.** No per-message replay in `switchSession` (verified in both 0.77.0 and the installed 0.67.5). The `restoring` guard's comment is stale/false → cleanup in **CS-P3**. |
| **S27** | **Settled — confirmed latent with an exact trigger** (no unobservable left): a live steer whose text starts with `/skill:<pi-skill>` or `/<pi-prompt-template>` is expanded by the SDK before echo; the raw-text ledger entry never clears; a later abort in the same process lifetime re-dispatches it (skill runs twice). Severity low-medium; compounds with F4 (ledger never reconciled on respawn). → **CS-R3/CS-R4**. |
| **S29** | **Still open by design** (PR-D deferred); partially mitigated (reconnect backoff, git-status in-flight dedup, seq-resume instead of full refetch). → **CS-P4**. |

---

## 4. New findings register (beyond the 46)

Detailed diagnosis/repro/fix lives in the task cards (§6); this table maps finding → task.
Severity = (data-loss vs transient) × reachability.

| ID | Finding (one line) | Severity | Task |
|---|---|---|---|
| **F1** | `drainQueue`'s bare synchronous `rpcClient.prompt()` throw inside the recovery `setTimeout(0)` is an `uncaughtException` → `process.exit(1)` — **the whole gateway dies** (window: in-flight dispatch ∩ in-place respawn) | **HIGH (total outage)** | CS-R1 |
| **F2** | No lifecycle fencing across `_respawnAgentInPlace`: stale-`SessionInfo` writers corrupt `statusVersion` past the carried frame-of-reference (permanently wrong status, heartbeat can't heal), clobber the persisted store (duplicate turn), leave the auto-retry timer alive (phantom turn into the new process); concurrent respawns / `addClient` dormant-revives spawn N children on one `.jsonl` (split-brain tabs, leaked processes, lost seq seed); grant `newTools` computed from role not `session.allowedTools` (double grant-respawn) | **HIGH** | CS-R2 |
| **F3** | Steer delivery semantics: (a) graceful abort + in-flight steer → text delivered **twice** (SDK retains it, Bobbit re-enqueues from the ledger); (b) the `agent_end` "safety net" (`session-manager.ts:2413-2418`) and the live-steer/turn-end race dispatch `steer()` to an **idle** SDK → text parks dormant (no echo, pill gone, phantom splice row, injected into an arbitrary future turn — or lost on restart) | **HIGH (duplicate model instruction / silent input loss)** | CS-R3 |
| **F4** | Steer ledger durability: in-memory only — in-place respawn and gateway crash silently destroy accepted-but-undelivered steers (bubble persists, model never sees it); `_dispatchSteer`'s failure rollback double-enqueues when a reconcile already drained the ledger; S27 expansion mismatch leaves permanent entries | **MEDIUM-HIGH (input loss)** | CS-R4 |
| **F5** | The SDK's **internal** auto-retry is enabled by default (2s base) and Bobbit's `maybeAutoRetryTransient` (~1s) races it: Bobbit's retry fires into the SDK's idle backoff window → duplicate user message / unsolicited turn / double spend; SDK-internal attempts also inflate `consecutiveErrorTurns` toward the human-gate park | **HIGH (duplicate turns, cost)** | CS-R5 |
| **F6** | No compaction gate on any dispatch path: `enqueuePrompt`/`drainQueue`/`retryLastPrompt`/implicit-unstick all dispatch into an in-flight compaction (status is `idle` during compaction); SDK `compact()` clobbers in-flight turn state, and **manual compact disconnects all agent listeners** → a turn started then streams into the void and skips `.jsonl` persistence (permanent message loss) | **HIGH (message loss / context corruption)** | CS-R6 |
| **F7** | Prompts accepted during `preparing`/`starting` and queues restored at boot **never auto-drain** (no idle-transition drains the queue); during a respawn window `enqueuePrompt` returns success-shaped `{status:"queued"}` without enqueuing | **MEDIUM (delivery stall / silent loss)** | CS-R7 |
| **F8** | = S13 (30s ack double-dispatch), confirmed unshipped | MEDIUM | CS-R8 |
| **F9** | `messageQueue` + `wasStreaming` ride the 1s store debounce (not in `RECOVERY_CRITICAL_FIELDS`): hard-kill windows yield a phantom continuation turn, a duplicate prompt (at-least-once re-dispatch of an accepted prompt), or a lost queued prompt; plus the WP9 residual (force-kill never clears `streamingStartedAt`/`wasStreaming`) | MEDIUM | CS-R9 |
| **F10** | Blank-text attachment-only send → **deterministic duplicate user bubble**: server synthesizes `ATTACHMENT_ONLY_TEXT` ("Attachments:"), optimistic text is `""`, no reconciliation path matches | MEDIUM (deterministic, single-tab) | CS-D1 |
| **F11** | Reducer hardening: (a) raw-role `plainTextEquivKey` defeats S18 dedup for document/blank optimistic rows; (b) live-echo artifact consume picks the EARLIEST same-text historical row in a no-optimistic tab (multi-tab row vanishes); (c) `synth:seq:` ids reuse after a gateway restart (resume_gap doesn't reset reducer state) → sub-second row morph | LOW-MEDIUM | CS-D2 |
| **F12** | = prefixed-S17 + huntB C10: error-recovery prefix breaks the skill-expansion splice AND leaks the orphaned envelope in `pendingSkillExpansions` (can mis-splice a future byte-identical message) | LOW-MEDIUM | CS-D3 |
| **F13** | = S26 steered images (4 drop points) | MEDIUM (data loss) | CS-D4 |
| **F14** | Outbox edges: navigation-away discards a non-empty outbox (silent loss with "queued" pill shown); `_flushOutbox` drops frames on mid-flush close/throw (no re-push); `unsent:true` has zero UI readers; outboxed `retry` frames invisible; no spawned-gateway E2E (the auth_ok→flush wiring is untested) | MEDIUM | CS-D5 |
| **F15** | = S16 + S38 (grant/restart continuation double-prompt; heartbeat-branch replay) | MEDIUM | CS-D6 |
| **F16** | = S21 residual (snapshot never clears `autoRetryPending`; zero-clients cancel orphan) | LOW | CS-D7 |
| **F17** | = S25 perm resume hole | MEDIUM-LOW | CS-D8 |
| **F18** | = S4 double-Enter | MEDIUM | CS-D9 |
| **F19** | Late RPC `response` frames after a `sendCommand` timeout are re-broadcast as seq'd session events (`rpc-bridge.ts:688-698`); a straggling compact response can synthesize a spurious `compaction_end{success:false}` client-side (`remote-agent.ts:2706-2718`) | LOW | CS-P3 |
| **F20** | `_advanceTopLevelSeq` gap path + skipped `compaction_end` → snapshot handler re-adds the compacting placeholder (stale "Compacting…" card). Narrow post-S5 | LOW | (documented; fold into any CS-D8 follow-up) |

**NEEDS-TRACE (named unobservable + settling experiment):**
1. *Extension-command steer infinite redispatch* — a steer starting with a registered
   extension command makes SDK `steer()` throw → rollback re-enqueues → re-fails at every
   tool boundary, silently. Settle: steer `/login` mid-turn against the real agent; watch
   `queue_update` churn. (If confirmed → fold into CS-R3 acceptance.)
2. *Stop during prompt preflight ghost bubble* — abort before the run starts → no
   `agent_end` for the pending prompt → `recoverPromptDispatch` deliberately drops it; the
   optimistic bubble may persist with no echo until the next snapshot. Settle: client-side
   trace of the rendering outcome. (Arguably intended — user pressed Stop.)
3. *Compaction spinner stuck after `restart_agent` mid-compaction* — child killed before
   `compaction_end`; handler flips `isCompacting` on the old object only. Settle: mock
   harness — manual compact, restart mid-flight, assert the card reaches a terminal state.
   (CS-R6's gate should make this window rarer; verify there.)
4. *`exit`-vs-buffered-stdout race* triggering F1 without a respawn (child prints
   `agent_end` then exits; Node may deliver `exit` first). Settle: stub child. CS-R1's fix
   covers it regardless.
5. *`deliverLiveSteer` cap-park doesn't cancel a pending auto-retry timer*
   (`session-manager.ts:1994-2003` vs `enqueuePrompt:1880`) — product decision more than a
   trace; note in CS-R5.

---

## 5. Invariant ledger (current) — abridged to deltas + unpinned set

The full 50-invariant ledger with per-invariant enforcement points and fidelity judgments
was compiled during this audit; the load-bearing summary:

**Faithfully pinned (real production code under test):** IME guard; composer size guard
(first-statement ordering + draft retention); outbox enqueue/flush/pill (file:// real
bundle); overflow re-baseline (real `handleServerMessage`); seq-less-bypass-empty
(structural, scoped); EventBuffer push/seq/eviction/canResumeFrom; synth:seq stamping +
empty-text multisets + over-dedup non-regressions (real reducer); live==snapshot image
enrichment (real reducer) + tile render (real Lit bundle); streaming-row single-surface;
StreamingMessageContainer self-heal; forceAbort grace race + retry-cancel (real
SessionManager); splice multiset; UTF-8 decoder (object-level); queue persistence
exactly-once across restart (`steer-gateway-restart.spec.ts`); store durability
(tmp+fsync+rename + epoch latch); search-flush teardown.

**UNPINNED or mirror-pinned (each is a gap a regression walks through silently):**
1. S4 double-Enter — unenforced and unpinned. (CS-D9)
2. Prompt slow-ack budget (S13) — unpinned; mock acks instantly. (CS-R8)
3. Steer shadow-ledger transitions (push/rollback/consume/reconcile incl. the S27
   miss-path) — zero unit coverage; steer E2Es are happy-path. (CS-R3/R4)
4. Steered-image forwarding (S26) — unpinned. (CS-D4)
5. `broadcastQueue` payload projection (S19) — no projection exists. (CS-P1)
6. `snapshot-clears-streaming-message.test.ts` is a **source-text regex scan** — behaviourally unpinned. (CS-H2)
7. Snapshot-authoritative `autoRetryPending` clear — missing invariant + code. (CS-D7)
8. Auto-retry timer fire/cancel behaviour — `auto-retry-policy.test.ts` is a pure-decision
   mirror; `queue-dispatch.spec.ts` uses a fake timer object; the `status!=='idle'` fire
   guard is untested. (CS-H2, then CS-R5)
9. Handler-local broadcast back-pressure (S36) — unguarded and unpinned. (CS-P3)
10. Grant replay (S38) — zero tests. (CS-D6)
11. Respawn continuation suppression (S16) — unenforced. (CS-D6)
12. Perm-hole resume (S25) — unpinned; `event-buffer.test.ts:209-233` pins the *defective*
    contract. (CS-D8)
13. Client seq dedup/reorder baseline, `_advanceTopLevelSeq`, resume_gap, and the status
    state machine — still pinned only by hand-copied HTML mirrors
    (`remote-agent-seq-dedup.html`, `remote-agent-sequence-hole.html`,
    `remote-agent-status.html` — the latter omits `_maybeReplayGrant` and the archived
    branch); heartbeat/resync server halves are inline mirrors in
    `session-manager-status.test.ts`. (CS-H2)
14. The `eventSeq` plumb feeding the synth:seq stamp (`remote-agent.ts:2365`) — no
    real-RemoteAgent test; a frozen/zeroed seq would collapse all id-less rows to one id. (CS-H2)
15. `broadcastStatus` single-writer routing — convention + comment only, no structural pin. (CS-H2)
16. Respawn `_snapshotStreamingFrameOfReference` threading — the carry-over tests mirror
    the threading inline rather than driving `_respawnAgentInPlace`. (CS-R2 acceptance)
17. statusVersion monotonicity **across concurrent stale writers** — violated today (F2a);
    no pin. (CS-R2)
18. Steer-ledger / queue / `.jsonl` exactly-once delivery contract — does not exist as an
    invariant today (F3/F4/F9). (CS-R3/R4/R9 define and pin it)

---

## 6. THE BACKLOG — ordered waves of self-contained hand-off tasks

Conventions for every task: **master stays green** (`npm run check`, `npm run test:unit`,
`npm run test:e2e` at/above current baseline); **no flaky tests** (a failure is a real
bug); **test-first** — author the red test before the fix (where master-red would violate
the green gate, use a characterization-green + `test.fixme` tagged with this task's ID);
minimal root-cause change; never start background servers from bash (use the harness);
all anchors verified at `6ec8c8f9` — re-verify before editing. Wave order is
(symptom impact × confidence × low risk) under dependencies; tasks within a wave are
parallel unless a dependency says otherwise.

---

### WAVE 0 — Harness fidelity (unblocks faithful pins for waves 1–2)

#### CS-H1 — Complete the mock-agent fidelity work (WP0 leftovers + steer semantics)
- **Serves:** symptom families A and C; prerequisite for CS-R3, CS-D1, CS-D4 E2E legs.
- **Targeted code:** `tests/e2e/mock-agent-core.mjs` (abort case ~`:2112-2165`, steer case
  ~`:2057-2110`, prompt echo ~`:679-690`), `tests/e2e/in-process-mock-bridge.mjs`,
  `src/ui/components/Messages.ts:500/748` (add `data-testid="aborted-banner"` only),
  NEW `tests/mock-abort-shape.test.ts`.
- **Diagnosis:** the mock still cannot express three real wire behaviours, so whole defect
  classes are untestable: (1) the DEFAULT abort emits only `agent_end`+idle — the real SDK
  emits `message_start → message_end(role:'assistant', stopReason:'aborted',
  content:[{type:'text',text:''}], errorMessage) → turn_end → agent_end → idle`; the
  empty-text aborted row is exactly the S7/S10 dedup class. (2) `message_start` is never
  emitted anywhere. (3) The mock converts a steer into an immediate prompt and models
  abort-with-pending-steer as a *drop* — the real SDK **retains** the steering queue across
  a graceful abort and replays it at the next run's initial steering poll; all five steer
  E2Es currently pass against wrong semantics. Steer `images` are also discarded.
- **Steps:** (a) default abort → the full faithful sequence above (keep `MOCK_ABORT_AS_ERROR=1`
  as the explicit error-shape override); audit every abort-consuming spec for the new DOM
  banner row / message counts / first-message_end ordering. (b) emit
  `{type:'message_start', message}` before every `message_end`. (c) steer: retain
  steered texts across a graceful abort and replay them (own `message_start/end(user)`)
  at the start of the next run; add a `MOCK_STEER_DROP_ON_ABORT=1` override for the old
  behaviour; thread `msg.images` through the steer case. (d) `data-testid="aborted-banner"`.
- **Repro/red tests:** `mock-abort-shape.test.ts` (node:test over `MockAgentCore`) asserting
  the exact sequence incl. `turn_end`; a steer-retention unit case (steer → abort → next
  prompt → echo includes the retained steer exactly once).
- **Non-goals:** no production `src/` change beyond the `data-testid` attribute; do not
  change default echo timing.
- **Acceptance:** `git diff src/` contains only the testid; all existing unit+e2e pass with
  updated assertions; the two new node:test files green; every `message_end` in mock output
  preceded by `message_start`.
- **Risk:** the abort-shape change perturbs abort-consuming specs (known: `abort-status-e2e`,
  `steer-during-bash-tool`, error-gated-drain tests) — widen assertions deliberately, do not
  silence. Rollback: revert the mock file.

#### CS-H2 — Retire the mirror/inline pins; add the missing real-code harnesses
- **Serves:** invariant-ledger gaps #6, #8, #13–15; S22/S23.
- **Targeted code:** tests only. Replace/supplement: `tests/fixtures/remote-agent-status.html`
  + `remote-agent-status.spec.ts` (mirror omits `_maybeReplayGrant` + archived branch);
  `tests/fixtures/remote-agent-seq-dedup.html` / `remote-agent-sequence-hole.html` (dedup,
  reorder, baseline, `_advanceTopLevelSeq`, resume_gap branches); inline mirrors in
  `tests/session-manager-status.test.ts:107-159`; `tests/snapshot-clears-streaming-message.test.ts`
  (source-regex → behavioural); NEW `tests/session-manager-auto-retry-fire-cancel.test.ts`
  (real `SessionManager` + `t.mock.timers`: fire-while-idle, cancel-on-new-prompt,
  forceAbort-cancels — last one is green already, keep as regression pin); extend the
  bundled real-RemoteAgent seq spec (`tests/remote-agent-seq-overflow.spec.ts` pattern /
  `tests/fixtures/remote-agent-seq-entry.ts`) with: (i) dedup/reorder/baseline/resume_gap
  cases (retiring the HTML mirrors), (ii) **the eventSeq plumb pin** — two id-less
  `message_end`s at seqs N, N+1 → two distinct `synth:seq:` ids in `_state.messages`,
  (iii) a `session_status` case exercising `_maybeReplayGrant` coupling + archived branch.
  Add a stderr-tail + wiring variant to `tests/rpc-bridge-utf8-split.test.ts` (spawned stub
  CLI writing a split multibyte char, so a revert of `rpc-bridge.ts:374` goes red).
  Optional structural pin: every `session.status` write routes through `broadcastStatus`
  (source-walk, mirroring `seqless-broadcast-exhaustive.test.ts`).
- **Acceptance:** each retired mirror either deleted or reduced to a comment pointing at the
  real-code pin; new tests green; no production change.
- **Dependencies:** none; parallel with CS-H1. Low risk (test-only).

**Gate 0:** `git diff src/` empty bar the testid; suites green; the mock can express the
real abort/steer/image shapes; the seq/status/auto-retry real-code harnesses exist.

---

### WAVE 1 — Server reliability: crash, duplicate turns, lost input (the new F1–F7 cluster)

#### CS-R1 — Gateway crash: make `drainQueue` un-crashable (F1)
- **Serves:** symptom C (and total-outage prevention). Root cause RC-A edge.
- **Targeted code:** `src/server/agent/rpc-bridge.ts:445-448` (`sendCommand` throws
  synchronously when `!this.process?.stdin`); `src/server/agent/session-manager.ts:2289`
  (bare `session.rpcClient.prompt(...)` in `drainQueue`), `:2208` (recovery
  `setTimeout(0)` redrain), `src/server/cli.ts:280-296` (uncaughtException handler exits 1
  for non-EPIPE).
- **Diagnosis:** trigger — (1) a prompt dispatch is in flight (long window: >30s
  auto-compaction before the ack); (2) any in-place respawn starts: `_respawnAgentInPlace`
  calls `unsubscribe()` **before** `stop()` (`:3022-3024`), so `process_exit` never reaches
  `handleAgentLifecycle` and status never becomes `terminated`; (3) the pending prompt
  rejects "Agent process exited…" → `recoverPromptDispatch` passes its status gate
  (`:2172-2176`, status still `streaming`) → re-enqueue + `setTimeout(0) drainQueue(oldSession)`;
  (4) the timer fires with `oldSession.rpcClient.process === null` → **synchronous throw
  inside a timer → uncaughtException → `process.exit(1)`** — every session dies.
- **Repro:** mock bridge whose `prompt()` never acks; `enqueuePrompt` (idle) then
  `restartAgent()` while the dispatch is pending; assert the tick-0 redrain does not throw
  out of the timer (today it does — assert via an injected uncaughtException listener in a
  child-process harness, or unit-assert `sendCommand` returns a rejected promise).
- **Fix direction:** (a) make `sendCommand` never throw synchronously — return
  `Promise.reject` for the no-process case; (b) belt-and-braces: `drainQueue` checks
  `session.rpcClient.running` and wraps the dispatch in try/catch routing to
  `recoverPromptDispatch`. **Non-goals:** the broader respawn fencing (CS-R2) — this task
  only removes the crash.
- **Acceptance:** new red→green unit test (real `RpcBridge`): `sendCommand` with no child
  rejects (never throws); a `drainQueue` against a stopped bridge recovers instead of
  throwing. Existing `rpc-bridge-lifecycle.test.ts` green.
- **Risk:** callers relying on the synchronous throw (grep `sendCommand` call sites) —
  verify each handles rejection. Rollback: two small reverts.

#### CS-R2 — Respawn lifecycle fencing: mutex + old-`SessionInfo` neutralization (F2)
- **Serves:** symptom C (frozen status, split-brain tabs, duplicate turns, leaked
  processes). Root cause **RC-A** — fixes F2a–f once.
- **Targeted code:** `src/server/agent/session-manager.ts` — `_respawnAgentInPlace`
  (`:3015-3045`), `restoreSession` (`:3600-3780`), `restartAgent` (`:3052`),
  `_restartSessionWithUpdatedRole` (`:2957`), `grantToolPermission` (`:2804-2870`),
  `addClient` dormant revive (`:6028-6046`), `recoverSandboxSessions`, `ensureSessionAlive`
  (`:5221`), forceAbort respawn (`:6226-6273`), `recoverPromptDispatch` (`:2166-2209`),
  `maybeAutoRetryTransient`/timer fire (`:2594-2649`), `cancelPendingAutoRetry` call-site
  audit, `drainQueue` (`:2240-2310`).
- **Diagnosis (five legs, one root cause — no fencing of the old object):**
  (a) **statusVersion corruption:** the frame-of-reference is snapshotted at `:3023`, but
  in-flight `recoverPromptDispatch`/redrain then broadcast idle/streaming **on the old
  object**, bumping its statusVersion past the snapshot and delivering those versions to
  still-attached clients; the new session re-issues the consumed numbers with different
  statuses → the client's `v<=last` gate drops them; the heartbeat never bumps versions →
  **permanently wrong status** (e.g. stuck "streaming"/Stop on an idle session).
  (b) **store clobber → duplicate turn:** the stale redrain persists `wasStreaming:true`
  and a `messageQueue` containing a row the old child may already have accepted into the
  `.jsonl` (the kill ate the ack, not the prompt) while `restoreSession` consumes the same
  `ps` → continuation prompt + re-dispatch = the same user turn runs twice.
  (c) **auto-retry timer survives every respawn:** `cancelPendingAutoRetry` is called at
  `:1880,:2734,:5329,:6093,:6320` — never on any respawn path; the timer's guards read the
  OLD object (`sessions.has(id)` true via the new session; old `status` frozen `idle`) →
  fires `retryLastPrompt` into the fresh process → phantom "[SYSTEM: The model API returned
  an error…]" turn.
  (d) **concurrent respawns:** no per-session mutex; `sessions.delete` happens after the
  first await (child shutdown up to 3s), so a second trigger (double-click Restart, grant
  click, `recoverSandboxSessions`, `ensureSessionAlive`, `addClient` revive) starts a second
  full `restoreSession` → **two pi children appending to one `.jsonl`**, loser child leaks
  (cost double-count); the first run's `finally` deletes `ps._restartFrameOfReference` so
  the second restore can seed `EventBuffer` at seq 1 → every post-respawn frame silently
  dropped by attached clients.
  (e) **`addClient` dormant revive:** the dormant entry stays `terminated` in the map for
  the whole restore; every attach in that window fires another `restoreSession`; each
  revive's `.then()` registers its ws on whatever the map holds at that moment → tabs split
  across two `SessionInfo`s. Also (f): `grantToolPermission` computes `newTools` from the
  *role* rather than `session.allowedTools` (`:2804-2831`), so a second grant during the
  first's respawn also respawns.
- **Repro:** (d/e) delaying `RpcBridgeFactory` (2s start); dormant session; `addClient`
  twice 100ms apart → factory must be invoked once (today twice). (c) errored turn arms the
  timer; `restartAgent`; advance mock timers → `retryLastPrompt` must not dispatch. (a/b)
  never-acking bridge + `restartAgent` mid-dispatch → assert no statusVersion regression on
  the new session and no duplicate row in the restored queue.
- **Fix direction:** a per-session **respawn generation + in-flight restore promise**:
  every entry point (`addClient` revive, `restartAgent`, `_restartSessionWithUpdatedRole`,
  forceAbort respawn, `recoverSandboxSessions`, `ensureSessionAlive`) joins the in-flight
  promise instead of starting a second restore. A **neutralization epilogue** on the old
  object at the top of `_respawnAgentInPlace`: mark it terminated/fenced, clear
  `clients`, `cancelPendingAutoRetry(session)`, and stamp a generation that
  `recoverPromptDispatch`, `drainQueue`, and the retry-timer closure check before acting
  (stale generation → no-op). Fix (f) by computing `newTools` from `session.allowedTools`
  for session-scoped grants. **Non-goals:** WP6's continuation-prompt suppression (CS-D6 —
  but note both edit `restoreSession`/`_respawnAgentInPlace`: land CS-R2 first, rebase
  CS-D6); prompt idempotency keys (CS-R9).
- **Acceptance:** red→green real-`SessionManager` tests for (c), (d/e), plus a
  generation-fencing unit (stale recover/redrain no-ops); the in-place-respawn carry-over
  pins (`restart-preserves-streaming-frame.test.ts`, `sandbox-recovery-*`) stay green and
  are **extended to drive the real `_respawnAgentInPlace`** (closing ledger gap #16); no
  statusVersion regression observable by a fake client across a respawn-with-inflight-dispatch.
- **Risk:** the highest-touch task in the backlog (one file, many functions). Blast radius:
  every respawn path incl. sandbox recovery. Mitigate by keeping the fence read-only for
  all paths except the five entry points; rollback = revert the epilogue + generation
  checks.

#### CS-R3 — Steer delivery semantics: exactly-once between Bobbit and the SDK (F3 + S27 trigger)
- **Serves:** symptom A (duplicate steer) + C (silently lost steer). Root cause **RC-C**.
- **Targeted code:** `src/server/agent/session-manager.ts` — the `agent_end` "safety net"
  (`:2413-2418`), `_dispatchSteer` (`:2069-2105`), `_consumeSteerEcho` (`:2114-2123`),
  `_reconcileAfterAbort` (`:2133-2141`) + its call sites (agent_end-while-aborting ~`:2427`,
  forceAbort `:6160`), `deliverLiveSteer` (`:1994-2050`), drainQueue steered batch
  (`:2254-2259`); `src/server/agent/rpc-bridge.ts` (steer `:479-481`; optionally a
  `clear_queue` passthrough — SDK rpc supports it).
- **Diagnosis:**
  (a) **Graceful abort double-delivery:** `_dispatchSteer` pushes the ledger and the SDK
  enqueues the steer; user clicks Stop; the **graceful** settle path leaves the child alive
  — the SDK retains the steer in its steering queue, but `_reconcileAfterAbort` also
  re-enqueues the ledger text and the post-abort drain dispatches it via `prompt` → the
  next run echoes the prompt AND the initial steering poll injects the retained original →
  the steer appears twice in the transcript and twice in model context. The reconcile is
  only correct for force-kill (process dead).
  (b) **Dormant steer:** `rpcClient.steer()` on a non-running agent only enqueues — it
  never starts a run. Two paths do this: the agent_end safety net (deterministic — steers
  still queued at a non-tool-final `agent_end` are dispatched via `steer()` *after* the run
  ended, strictly before `drainQueue` would have dispatched them correctly via `prompt`),
  and the live-steer-vs-turn-end race (incl. team-manager nudges, `team-manager.ts:1907,1952`).
  Result: pill removed, no echo, ledger entry never clears (phantom `inflight-steer:` row in
  every snapshot), text invisible to the model until it pops into an arbitrary future turn —
  or is permanently lost on gateway restart (ledger is memory-only, row already removed from
  the persisted queue).
  (c) **S27:** the SDK expands `/skill:`/template steers before queueing; the echo carries
  expanded text; the raw-text ledger entry never matches → permanent entry → duplicate
  dispatch on a later abort.
- **Repro:** (a) real-`SessionManager` + fake bridge that retains steer texts across
  `abort()` and replays them on the next `prompt()` (CS-H1's mock semantics): streaming →
  steer("X") → graceful abort → assert exactly one user-message "X" (today two). (b) fake
  bridge that parks steers when no run is active: streaming text-only turn →
  `steerQueued(id)` → `agent_end` → assert the text was dispatched via `prompt` or still
  queued (today: `steer` RPC after agent_end, queue empty, ledger stuck). (c) steer text
  `/skill:x`, echo the expanded body, `forceAbort` → assert `inFlightSteerTexts` empty and
  no re-dispatch.
- **Fix direction:** (1) delete the agent_end safety net — leftover steered rows flow into
  `drainQueue`'s existing steered-batch `prompt` path; (2) make `_reconcileAfterAbort`
  bridge-aware: on graceful abort (process alive) do NOT re-enqueue — the SDK still owns
  the text; keep the ledger entry so the splice keeps the bubble, and let the next run's
  steering poll deliver it (or expose `clear_queue` over RPC and use it to make abort
  at-most-once, then re-enqueue uniformly — pick one model and pin it); re-enqueue only on
  force-kill; (3) `_dispatchSteer`'s catch: skip the row re-enqueue when the ledger splice
  missed (another path owns the rows — fixes the delayed-failure double-enqueue); (4) make
  `_consumeSteerEcho` expansion-tolerant (consume when the echo *starts with* / maps to a
  ledger entry after `/skill:`-expansion, or track a dispatch id). **Non-goals:** ledger
  persistence (CS-R4); steer images (CS-D4).
- **Acceptance:** the three repro tests red→green; all five steer E2Es green **against the
  CS-H1 retain-and-replay mock** (they currently pass against drop semantics — they must be
  re-validated, not just re-run); a new invariant test: after any abort path, for every
  ledger entry there is exactly one of {SDK-queued copy, Bobbit-queued row} (the
  exactly-once contract).
- **Dependencies:** CS-H1 (mock steer semantics). Coordinate with CS-R2 (same file; disjoint
  functions except forceAbort — rebase order CS-R2 → CS-R3).
- **Risk:** steer UX semantics change subtly (a steer landing at turn-end becomes a queued
  prompt — that is the *correct* documented semantics). Rollback per sub-fix.

#### CS-R4 — Steer ledger durability: persist + reconcile on respawn (F4)
- **Serves:** symptom C (user input silently lost). Root cause RC-C persistence leg.
- **Targeted code:** `src/server/agent/session-manager.ts` `_dispatchSteer` (`:2074-2087` —
  row removal persisted before the RPC; ledger push in-memory only), `_respawnAgentInPlace`
  (no reconcile call), `restoreSession`; `src/server/agent/session-store.ts:33-118`
  (`PersistedSession` — `inFlightSteerTexts` is not a field), `RECOVERY_CRITICAL_FIELDS`
  (`:513-522`); `src/server/agent/splice-inflight-message.ts` (snapshot splice reads the
  in-memory ledger).
- **Diagnosis:** a steer the SDK accepted mid-turn is destroyed by any in-place respawn
  (grant click, role switch, Restart, sandbox recovery): queue row already removed (and the
  removal persisted), ledger discarded with the old object, the `wasStreaming` continuation
  prompt resumes the turn **without the user's redirection** — and on reload even the
  bubble vanishes (splice reads an empty ledger). Across a gateway crash the same holds.
- **Repro:** real-`SessionManager`: dispatch a live steer (fake bridge holds it), then
  `_respawnAgentInPlace` → assert the steer text is re-enqueued as a steered row (today:
  gone). Crash leg: persist-and-reload cycle via the store, assert the ledger text survives
  as a queued row.
- **Fix direction:** persist the ledger (a `pendingSteerTexts` field next to
  `messageQueue`, synchronous-flush class); `restoreSession` re-enqueues persisted ledger
  entries as steered rows at front; `_respawnAgentInPlace` calls the (CS-R3
  bridge-aware) reconcile before tearing down. **Non-goals:** changing live-steer dispatch.
- **Acceptance:** repro tests red→green; `steer-gateway-restart.spec.ts` extended with a
  mid-turn live steer surviving the restart exactly once; no double-delivery when combined
  with CS-R3 (the exactly-once invariant test covers the join).
- **Dependencies:** CS-R3 (defines the reconcile semantics). Risk: store schema addition —
  forward-compatible (absent field = empty).

#### CS-R5 — Disable the double auto-retry layer (F5)
- **Serves:** symptom A/C (duplicate turns, unsolicited turns, premature error-park, cost).
  Root cause **RC-B**.
- **Targeted code:** `src/server/agent/rpc-bridge.ts` (bridge start — send
  `{type:"set_auto_retry", enabled:false}`; the rpc command exists, rpc-mode `:410-413`) OR
  `src/server/agent/session-manager.ts` `maybeAutoRetryTransient` (`:2594-2649`) +
  `handleAgentLifecycle` (`consecutiveErrorTurns` increment `:2377`); the SDK's internal
  retry is **enabled by default** (settings-manager `enabled ?? true`, maxRetries 3, base
  2000ms) and Bobbit never calls `set_auto_retry` (zero hits in `src/`).
- **Diagnosis:** on a retryable provider error the SDK emits `agent_end` first, then sleeps
  2s·2ⁿ⁻¹ and resumes via `agent.continue()` (no new user message). Bobbit sees the errored
  `agent_end` → arms its own timer (~1s first attempt — earlier than the SDK's 2s) → fires
  while status is idle (the SDK's backoff window is by construction an idle-status window)
  → `retryLastPrompt` re-sends the prompt as a **new user message**; the SDK's own continue
  then hits a busy agent and is swallowed. Duplicate user message / unsolicited "[SYSTEM:
  continue]" turn / double spend; SDK-internal attempts also increment
  `consecutiveErrorTurns` toward the human-gate park during an episode the SDK was
  handling.
- **Repro:** mock agent emits `message_end{stopReason:'error', errorMessage:'overloaded_error'}`
  + `agent_end`, then accepts the next prompt; assert exactly one driving dispatch.
- **Fix direction (pick one layer, recommend Bobbit-owned):** send `set_auto_retry
  enabled:false` at every bridge start so Bobbit's policy (with its UI banner, cancel paths,
  and S40 integration) is the only retry layer. Alternative: observe the SDK's
  `auto_retry_start`/`auto_retry_end` events (currently unhandled) and suppress/cancel
  Bobbit's timer — more moving parts. Also decide NEEDS-TRACE #5 (cap-park in
  `deliverLiveSteer` doesn't cancel the timer) here. **Non-goals:** changing backoff
  schedules.
- **Acceptance:** red→green unit (real SessionManager + mock bridge capturing
  `set_auto_retry`); the existing auto-retry banner E2E green; a regression pin that an
  SDK-style internal-retry sequence does not double-dispatch.
- **Risk:** behaviour change for users relying on SDK silent retry — Bobbit's banner+timer
  replaces it 1:1. Rollback: drop the command.

#### CS-R6 — Compaction dispatch gate (F6)
- **Serves:** symptom C (vanished messages, corrupted turns). Root cause **RC-B**.
- **Targeted code:** `src/server/agent/session-manager.ts` — `enqueuePrompt` direct branch
  (`:1949-1968`), `drainQueue` (`:2240+`), `retryLastPrompt` (`:2734+`), the
  implicit-unstick branch, the `compaction_start`/`compaction_end` handling
  (`session.isCompacting` set `:2476/:2490`, read today only by `handler.ts:737`).
- **Diagnosis:** during compaction the SDK is not streaming and Bobbit's status is `idle`;
  `enqueuePrompt`'s only gate is `status==='idle'` → prompts/steers/retries dispatch
  straight into an in-flight compaction. SDK `compact()` then clobbers
  `agent.state.messages`; **manual compact disconnects all agent event listeners for its
  whole duration** — a turn started in that window streams into the void and skips `.jsonl`
  persistence (permanent message loss). Reachable without exotic timing: queued prompt +
  `/compact`; threshold auto-compaction at `agent_end` racing the same `drainQueue`; a
  prompt typed during the visible compaction card.
- **Repro:** mock harness: start a (mock) compaction, `enqueuePrompt` → assert the prompt
  is parked and dispatches only after `compaction_end` (today: direct dispatch).
- **Fix direction:** treat `session.isCompacting` as busy at every dispatch site (park in
  `promptQueue`); drain on `compaction_end`. This single server-side gate also removes the
  SDK's concurrent-compaction and manual-disconnect hazards from production reach.
  **Non-goals:** touching SDK compaction internals; the composer disable is optional polish.
- **Acceptance:** red→green real-`SessionManager` test; `/compact`-then-prompt E2E ordering
  test; NEEDS-TRACE #3 (restart mid-compaction spinner) re-checked under the gate.
- **Dependencies:** none, but **must land before or with CS-R7** (drain-on-idle widens this
  hole if the gate is absent — the agent_end→drain path would dispatch into the
  threshold auto-compaction window).

#### CS-R7 — Drain the queue on every transition into idle (F7)
- **Serves:** symptom C (queued prompt stuck forever).
- **Targeted code:** `src/server/agent/session-manager.ts` — `drainQueue` call sites
  (today: agent_end `:2456`, enqueue-while-idle `:1968`, recovery timer `:2208`, forceAbort
  respawn `:6273`); the idle broadcasts that drain nothing: `session-setup.ts:1036`,
  `restoreSession:3746`, `_respawnAgentInPlace:3041`, `assignRole:5083`; the
  respawn-window enqueue bug `:1833-1834` (returns `{status:"queued"}` without enqueuing);
  `ws/handler.ts:489-510` (the comment promising "they'll drain when the session becomes
  idle" — currently false).
- **Diagnosis:** prompts accepted during `preparing`/`starting`, and queues restored at
  boot with `wasStreaming:false`, sit as pills forever — no `starting→idle` transition
  drains. Internal callers (team prompts, triggers) hitting the respawn window get a
  success-shaped return with the message dropped.
- **Repro:** enqueue during `preparing` (mock setup delay); assert dispatch on the idle
  transition (today: parked). Boot-restore with a persisted queue; assert drain.
- **Fix direction:** a single drain hook on every transition into `idle` (either inside
  `broadcastStatus` when `newStatus==='idle'` or an epilogue at the four call sites),
  gated on CS-R6's compaction check; make the respawn-window `enqueuePrompt` either await
  the in-flight restore (CS-R2's promise) or return an explicit error.
- **Acceptance:** red→green tests for both repro legs; the handler comment becomes true;
  abort-status-e2e (post-abort drain) stays green.
- **Dependencies:** CS-R6 (ordering constraint above); CS-R2 (restore promise, soft).

#### CS-R8 — S13: prompt ack must survive auto-compaction (F8)
- **Serves:** symptom A (duplicate turn after a long pause).
- **Targeted code:** `src/server/agent/rpc-bridge.ts:445` (30s default), `:454-457`
  (pending deleted on timeout — late ack orphaned at `:688-691`), `:466-476` (`prompt()`),
  `:521-522` (compact's 120s budget); `session-manager.ts:2166-2209`
  (`recoverPromptDispatch` re-dispatch).
- **Diagnosis:** the SDK acks a prompt only after in-prompt auto-compaction; >30s
  compaction → timeout → recovery re-enqueues → the next `agent_end` (i.e. the successful
  completion of the very prompt that "timed out") re-dispatches it — the same user message
  runs twice.
- **Repro:** stub CLI whose prompt handler delays its success line past an injectable
  lowered ack timeout; assert the prompt resolves once and exactly one `prompt` command is
  ever written (today: two).
- **Fix direction:** keep the pending entry alive past the timeout so a late ack resolves
  it and cancels recovery (preferred — preserves a liveness signal), or raise the
  prompt-specific budget ≥120s; rely on the `process_exit` path (`:407-432`) for genuine
  death. **Non-goals:** changing the busy-guard recovery machinery (correct for genuine
  rejections).
- **Acceptance:** the stub-CLI test red→green; `rpc-bridge-lifecycle.test.ts` green;
  enqueuePrompt/REST error mapping unchanged for genuine failures.

#### CS-R9 — Crash-window durability for `messageQueue`/`wasStreaming` + force-kill bookkeeping (F9 + WP9 residual)
- **Serves:** symptom A/C after hard crashes.
- **Targeted code:** `src/server/agent/session-store.ts:513-539`
  (`RECOVERY_CRITICAL_FIELDS` + 1s debounce); `session-manager.ts` force-kill branch
  (~`:6136-6167` — never clears `streamingStartedAt` or persists `wasStreaming:false`),
  agent_end clears (`:2445-2447`), heartbeat payload (`:879-885`), boot continuation
  (`:3766-3776`).
- **Diagnosis:** hard-kill inside the debounce window → disk keeps `wasStreaming:true`
  after a completed turn (phantom continuation on boot), or keeps a dequeued row
  (duplicate turn: continuation + re-dispatch of a prompt already in the `.jsonl`), or
  loses a freshly queued prompt entirely. Separately, the force-kill branch leaves
  in-memory `streamingStartedAt` set (heartbeat ships a stale value) and persisted
  `wasStreaming:true` (a later hard crash then fires a continuation for a turn the user
  deliberately killed).
- **Repro:** store-level: mutate queue/wasStreaming, simulate kill before the debounce
  flush, reload, assert the documented post-state. Force-kill: extend
  `session-manager-force-abort-grace.test.ts` to assert the store update.
- **Fix direction:** promote `messageQueue` + `wasStreaming` to the synchronous-flush set
  (both mutate at low frequency — turn boundaries and queue mutations); clear
  `streamingStartedAt` + persist `wasStreaming:false` in the force-kill branch. The full
  idempotency-key design (dedupe a re-dispatched prompt against the `.jsonl` tail) is a
  **non-goal** here — document it as the residual at-least-once edge.
- **Acceptance:** red→green store tests; force-abort test extended; restart E2Es green.

**Gate 1:** all Wave-1 reds green; a soak of the steer/abort/respawn E2E suite (incl. the
re-validated steer specs) 20/20 under `--repeat-each=20`; no statusVersion regression
observable across a respawn-with-inflight-dispatch; the exactly-once steer invariant test
green.

---

### WAVE 2 — Client-side duplicates, losses, and the deferred RC1/RC5 edges

#### CS-D1 — Blank-text attachment-only duplicate bubble (F10)
- **Targeted code:** `src/server/agent/rpc-bridge.ts:152-162` (`ATTACHMENT_ONLY_TEXT`
  synthesis, applied at `session-manager.ts:1847`); `src/app/remote-agent.ts:908-955`
  (prompt build) or `src/app/message-reducer.ts:264-300` (fallback candidate set).
- **Diagnosis:** attach an image, send with an empty composer (allowed:
  `MessageEditor.ts:564`, `AgentInterface.ts:1423`). Optimistic text `""`; server
  synthesizes "Attachments:"; echo text ≠ `""` → id-fallback, text-fallback and
  `reconstructModelText` all miss; snapshot keys (`…|EMPTY|` vs `…|Attachments:`) never
  match → **two user bubbles every time**, healing only on reload. Pre-existing, unlisted
  in the seam table; it is RC1's no-correlation-id root cause via a third text-divergence
  source.
- **Repro (real reducer, no harness change):** `optimistic-prompt {role:'user-with-attachments',
  content:[{text:''}], attachments:[img]}` → live `message_end {role:'user',
  content:[{text:'Attachments:'},{type:'image',…}]}` → assert 1 row (today 2).
- **Fix direction:** export the synthesis rule (pure constant/function) and mirror it
  client-side when building the optimistic row's candidate text set — or carry the
  optimistic id through the prompt frame (the principled RC1 fix; bigger). **Non-goal:**
  changing the server-side synthesis.
- **Acceptance:** reducer pin red→green; an E2E once CS-H1's auto-image-echo lands
  (blank-text + image → one bubble live and after reload).

#### CS-D2 — Reducer hardening bundle (F11 a/b/c)
- **Targeted code:** `src/app/message-reducer.ts:90-94` (`plainTextEquivKey` — raw role),
  `:301-312` (live-echo artifact consume — earliest-match), `:249-251` (synth:seq stamp);
  `src/app/remote-agent.ts:1697-1706` (resume_gap — no reducer epoch reset).
- **Diagnosis:** (a) `user-with-attachments` optimistic vs `role:'user'` snapshot copy
  (documents / blank-text; images are enriched back and safe) never key-match → duplicate
  until the next snapshot. (b) In a tab with no optimistic row, the artifact consume
  `findIndex` eats the EARLIEST id-less same-text user row — a *historical* row vanishes
  transiently when the same text is sent again from another tab. (c) After a gateway
  restart, `EventBuffer` restarts at seq 1; `resume_gap` re-baselines `_highestSeq` without
  clearing reducer rows → a new `synth:seq:N` replaces an unrelated old `synth:seq:N` row
  for the sub-second window before the snapshot.
- **Repro:** three reducer-unit cases (the agent reports give exact shapes); all
  expressible today.
- **Fix direction:** (a) normalise `user-with-attachments`→`user` inside
  `plainTextEquivKey`; (b) prefer the LAST matching artifact (`findLastIndex`) or scope to
  the snapshot tail; (c) include a connection-epoch nonce in the synth id
  (`synth:seq:<epoch>:<seq>`) or clear positive-`_order` synth ids on `resume_gap`.
- **Acceptance:** three pins red→green; the existing dedup + over-dedup suite stays green.

#### CS-D3 — Prefixed error-recovery splice (S17 leg + F12 envelope leak)
- **Targeted code:** `src/server/agent/session-manager.ts:553-584`
  (`spliceSkillExpansionsIntoEvent`, exact `p.modelText === body` match `:575`), `:1861-1867`
  (envelope stashed keyed on the UNprefixed modelText), `:1941-1942` (the
  `buildErrorRecoveryPrefix(...)` dispatch; structure `[SYSTEM:…]\n\n${userText}` —
  commit 52f11884 only reworded the snippet); characterization pin
  `tests/message-reducer-dedup.test.ts:75`.
- **Diagnosis:** errored prior turn + slash-skill prompt → dispatch is prefixed → the echo
  body never exact-matches the envelope → the user sees `/foo` AND a "[SYSTEM: previous
  turn failed…]\n\n<expanded skill>" wall of text, persistent until reload; the orphaned
  envelope stays in `pendingSkillExpansions` and can mis-splice a future byte-identical
  message.
- **Repro:** real-`SessionManager` unit — stash an envelope, dispatch prefixed, feed a
  synthetic prefixed echo through `emitSessionEvent`, assert the splice rewrites it (today:
  miss). Expressible now, no WP0 dependency.
- **Fix direction:** stash the envelope keyed on the **prefixed** text at the `:1941` call
  site (smallest), or make the splice match a prefix-stripped body. Then flip the
  characterization test at `message-reducer-dedup.test.ts:75` to the fixed expectation.
  **Non-goal:** the inert client-side `reconstructModelText` path (leave as harmless
  defence; optionally annotate it as production-inert).
- **Acceptance:** unit pin red→green; characterization test flipped; an errored-turn +
  slash-skill E2E asserting exactly one user row.

#### CS-D4 — S26: steered images end-to-end (F13)
- **Targeted code:** `src/server/agent/rpc-bridge.ts:479-481` (+ interface `:109`) — add
  `images?`; `session-manager.ts:2073/2089` (`_dispatchSteer` union
  `rows.flatMap(r=>r.images??[])`), `:2098-2100` (rollback re-enqueue with images),
  `:2136-2138` (reconcile with images), `:2257-2259` (drain batch union);
  `tests/e2e/mock-agent-core.mjs` steer-images threading (CS-H1).
- **Diagnosis:** four drop points lose steered images silently; the SDK supports steer
  images (`session.steer(message, images)` in rpc-mode). User symptom: "look at this
  screenshot" steers the model demonstrably never saw.
- **Repro:** unit — steer RPC payload contains `images`; real-`SessionManager` — a steered
  row with images reaches `rpcClient.steer(text, images)` and survives rollback/reconcile;
  batch — two steered rows with distinct images dispatch the union.
- **Fix direction:** as targeted above. **Verify first** that the installed SDK's steer RPC
  accepts images (env caveat in the header); if not, reject image steers with a visible
  error instead of silently threading. **Non-goals:** document attachments on steers.
- **Acceptance:** unit pins red→green; E2E with CS-H1's image echo (steered image renders
  AND reaches the mock's prompt/steer command args).
- **Dependencies:** CS-H1; coordinate with CS-R3/CS-R4 (same functions — land after, rebase).

#### CS-D5 — Outbox hardening (F14)
- **Targeted code:** `src/app/session-manager.ts:930-941` (navigation-away caches only when
  `connected`; else `remote.disconnect()` discards the instance + outbox);
  `src/app/remote-agent.ts:1464-1477` (`_flushOutbox` — empties up front, skips non-OPEN,
  swallows throws, no re-push), `:217` (`unsent:true` — zero UI readers), `:749` (auth_ok
  flush wiring — untested); NEW `tests/e2e/ui/send-outbox.spec.ts` (spawned gateway).
- **Diagnosis:** (a) VPN flap → prompt queued (pill shown) → user switches session →
  switches back → new `RemoteAgent`, outbox and pill gone — silent loss of typed intent
  exactly when the outbox was supposed to protect it. (b) A socket closing mid-flush drops
  the remaining frames (the guard's own failure recreates S2). (c) The promised
  "waiting to send" affordance doesn't exist (pills look ordinary; `retry` frames have no
  pill at all). (d) The auth_ok→flush wiring has no test — deleting the `_flushOutbox()`
  call passes the suite.
- **Repro:** (a) bundled-agent spec: non-OPEN ws, `prompt('x')`, simulate the
  session-switch path, assert the outbox survives (today: discarded). (b) flush with a
  socket that closes after frame 1 of 3 → assert frames 2–3 re-queued. (d) spawned-gateway
  E2E: kill the socket, prompt, reconnect, assert exactly one server copy.
- **Fix direction:** cache the outgoing agent even when reconnecting (it self-reconnects);
  re-push unsent remainder in `_flushOutbox`; render `unsent:true` distinctly in the pill
  strip (plan §2.5.2's chosen UX); decide whether `retry` belongs in the pill channel.
  **Non-goals:** cross-reload outbox persistence (accepted loss, no false "sent" state);
  ack-based delivery (S13's territory).
- **Acceptance:** the three reds green; the E2E pins auth_ok→flush; exactly-once on flush
  (no duplicate when the server also queued via another tab — document the multi-tab
  duplicate-intent caveat).

#### CS-D6 — WP6: respawn continuation suppression + grant-replay gating (F15 = S16+S38)
- **Targeted code:** `src/server/agent/session-manager.ts:3766-3776` (continuation gate),
  `:3032-3035` (`_respawnAgentInPlace` finally — delete the transient flag), `restartAgent`
  (`:3052+` mutatePs) and the **role-switch** caller of `_restartSessionWithUpdatedRole`
  (`:2957` — the three grant modes `:2850/:2856/:2870` must NOT set the flag);
  `src/app/remote-agent.ts:1719-1721` (remove the heartbeat-branch `_maybeReplayGrant`),
  `:1232-1241` (replay timer — keep).
- **Diagnosis:** `restoreSession` fires "[SYSTEM: …continue where you left off…]" whenever
  persisted `wasStreaming` — true for every deliberate respawn (grant pauses the turn
  before agent_end). Grant path: server continuation + client 200ms replay = two driving
  prompts. Plan review-option (i) is adopted: **keep** the continuation for the GRANT path
  (it is the robust driver; `switch_session` does not auto-continue), suppress only for
  `restartAgent` and role-switch; drop only the redundant heartbeat-branch client replay.
- **Repro:** real-`SessionManager`: persisted `wasStreaming:true` + `restartAgent` → assert
  zero continuation prompts (today 1); genuine boot restore → still 1. Client: heartbeat
  idle with a pending grant replay → no send; transition idle → one send (bundled-agent
  spec — also closes ledger gap #10).
- **Fix direction:** `_suppressContinuationPrompt` transient on `ps` per the WP6 spec
  (suppressed branch still clears `wasStreaming`); negative pin that
  `recoverSandboxSessions` does NOT set it. **Non-goals:** the 200ms timer redesign;
  suppressing for sandbox recovery.
- **Acceptance:** WP6's acceptance list verbatim (03-remediation §WP6): no continuation
  bubble on restart/role-switch; grant still driven; boot/Docker restores keep the prompt;
  `restart-preserves-streaming-frame`, `sandbox-recovery-*`, grant E2Es green.
- **Dependencies:** **after CS-R2** (same functions; CS-R2's fencing changes
  `_respawnAgentInPlace`/`restoreSession` — rebase this on top).

#### CS-D7 — Snapshot-authoritative auto-retry banner (F16, WP4 step 4)
- **Targeted code:** `src/app/remote-agent.ts` `case "messages"` snapshot branch
  (~`:1546-1638`, near the streaming clear `:1574/:1588`) — add
  `this._state.autoRetryPending = null;` (NOT in `case "state"`);
  `tests/e2e/ui/auto-retry-banner.spec.ts` (extend).
- **Diagnosis:** the only banner clears are live events (`:2374,2386,2401`); a cancel
  emitted with zero clients (`session-manager.ts:2663-2679` skip) or evicted from the ring
  leaves a reconnecting tab showing "Retrying in Xs…" forever (reachable via
  forceAbort-idle on a detached session, e.g. the team-abort route).
- **Repro:** inject `auto_retry_pending` via the window hook; drive a `messages` snapshot
  WITHOUT a cancel; assert the banner is gone (today: stays).
- **Fix direction & acceptance:** exactly WP4 step 4 + its spec extension; the now-seq'd
  pending replays after the snapshot if a retry is genuinely pending, so no flicker.

#### CS-D8 — S25: perm-frame resume hole (F17)
- **Targeted code:** `src/server/agent/event-buffer.ts:41-43` (`pushFrame` retain a benign
  `{type:'noop'}` seq-holder); `tests/event-buffer.test.ts:209-233` (BOTH tests pin the
  pre-fix contract — update to size 3 / `[1,2,3]`); NEW `tests/perm-frame-resume-hole.test.ts`;
  `perm-frame-late-joiner-seq-gap.test.ts` must stay green (still one `pushFrame` callsite
  `session-manager.ts:2909`; on-attach still via `getPendingToolPermission`,
  `handler.ts:436-444`).
- **Diagnosis:** a perm consumes seq N, never retained; resolved-while-disconnected
  (DENY `:2943-2949` / 5-min timeout `:2913-2916` / implicit deny `:2896-2900`) → resume
  `since(fromSeq)` replays around the hole → the client gap-buffers everything behind N.
  Self-heals only after 500 buffered events (S9 overflow). Do NOT retain the full payload:
  the resume loop routes ring entries into `handleAgentEvent`, which has no
  `tool_permission_needed` case — the card renders only from the top-level frame; a full
  payload would spuriously emit and never render.
- **Repro:** `buf.push(1..3); buf.pushFrame(); buf.push(5,6)`; feed `since(3)` into the
  FakeClient sequencer from the late-joiner test → today seqs 5–6 strand.
- **Fix direction & acceptance:** WP5 steps 2–4 + both test edits; eviction-window test
  re-verified (pushFrame now counts toward the 1000 cap); the retained holder never paints
  a card or a `_state.messages` row.

#### CS-D9 — S4: double-Enter sends twice (F18)
- **Targeted code:** `src/ui/components/MessageEditor.ts` `handleSend` (~`:654-679` — no
  clear, no re-entrancy flag); `src/ui/components/AgentInterface.ts:1467-1491` (clear after
  awaits), `:2113` (un-awaited onSend); fixture `tests/message-editor-send.html` clears
  synchronously (the inverse of production — replace per the CS-H2 real-bundle pattern).
- **Diagnosis:** Enter #1 fires `onSend` without clearing; `sendMessage` suspends on the
  IndexedDB `providerKeys.get` await; Enter #2 (auto-repeat / fast double) re-reads the
  same value → two identical prompts, two turns (each optimistic id unique, so no
  collapse).
- **Repro:** real-component bundle: macrotask-resolving storage stub, two `keydown{Enter}`
  in a tick → assert one send (today two).
- **Fix direction:** clear `this.value`/`this.attachments` synchronously in `handleSend`
  BEFORE invoking `onSend`, restoring on the abort/early-return paths (note: the size guard
  from S31 is already the first statement — keep it first), OR a synchronous `_sending`
  flag. **Non-goal:** touching the await ordering in `sendMessage`.
- **Acceptance:** red→green on the real bundle; size-guard + IME + draft specs stay green.

**Gate 2:** all Wave-2 reds green; the duplicate-bubble class has zero known reproducible
triggers (blank-text, role-keying, prefixed-skill, double-Enter all pinned); outbox
survives navigation and mid-flush failure; banner reconciles on snapshot; perm resume
hole-free.

---

### WAVE 3 — Payload, hot-path, perf (the unshipped PR-D)

These four tasks are specified in detail in [03-remediation-plan.md](03-remediation-plan.md)
(WP7, WP8, WP10) — the specs there remain accurate (anchors drifted; current ones below).

#### CS-P1 — WP7 payload slimming (S19+S20)
- `session-manager.ts:1782-1789` (`broadcastQueue` → `toBroadcastArray()`/`toPersistArray()`
  via a new pure `queue-projection.ts`; persist keeps `images[].data` for the restart
  re-dispatch invariant); `remote-agent.ts:950-955` (+ pure `stripAttachmentsForWire` in
  `attachment-utils.ts` — documents lose `content`/`preview` on the wire, images' bytes ride
  `images[].data` once); defensive ingestion strip sparing `msg.images`. Acceptance: WP7's
  list; key risk — UI pill strip must render metadata-only rows; verify document chips
  render from metadata after reload. Independent.

#### CS-P2 — WP8 hot-path bundle (S32, S34, S35, S37)
- S32: `remote-agent.ts:2125-2170` — `textHasProposalTag` indexOf precheck + cached
  regexes; byte-identical matched behaviour. S34: `AgentInterface.ts:672-684/723-733` —
  rAF-coalesce ONLY `_updateAndPin`'s jump-button call (the shared wrapper has ~11 callers
  incl. the scroll handler `:1198/:1207` — keep those synchronous); cancel in
  `disconnectedCallback`; the scroll-spec suite is the blast radius. S35:
  `attachment-utils.ts:88-95` — async `arrayBufferToBase64` yielding every ~1MB. S37:
  `aigw-manager.ts:381-389` — `"${BOBBIT_SESSION_ID}"` template; **update the two
  literal-pinning tests** (`aigw-headers.test.ts`, `aigw-header-resolver.test.ts`) to the
  throw-equivalence invariant — they currently pin the defect. Commit each seam separately.

#### CS-P3 — Standalone hygiene bundle (S33, S36, S43, F19, S15-comment)
- S33: `remote-agent.ts:2462-2468` trailing-edge flush (`_truncatedFlushTimer`; clear on
  `message_end`/reset; the no-stale-post-finalize assertion is the load-bearing red test).
- S36: extract `guardedBroadcast` (owns the WeakSets, diag label as param), behaviour
  pinned unchanged for `session-manager.broadcast`, then point `handler.ts:154-196` at it.
- S43: `rpc-bridge.ts:312-316` — `removeAllListeners()` before kill (+ drop the dead
  `.toString()`); spy-pin in `rpc-bridge-lifecycle.test.ts`.
- F19: filter `parsed.type === "response"` from the event fan-out at
  `rpc-bridge.ts:688-698` (late post-timeout responses must not become seq'd session
  events); client guard at `remote-agent.ts:2706-2718` optional.
- S15: rewrite the stale `restoring` comment at `session-manager.ts:3694-3704` (or simplify
  the guard) — the "replays every message" claim is false on pi ≥0.67.

#### CS-P4 — S29 reconnect hydration coalescing
- `src/app/session-manager.ts:1384-1390` + `:2730-2740`: add in-flight dedup for
  bg-processes and annotation-store refreshes (mirror the git-status guard `:2855-2857`);
  optionally debounce `onReconnect` bursts. Low risk; perf-only.

**Gate 3:** PR-D acceptance (03-plan Gate 4) holds: `queue_update` frames carry no base64;
no document bytes on the wire; hot-path pins green; all scroll/jump specs green within the
existing `settleFrames` budget.

---

### WAVE 4 — Test-debt mop-up

#### CS-T1 — WP11 leftovers (two flaky specs)
- pre-compaction-history: implement the test-only `__pinAgentSessionFile` hook
  (`session-manager.ts:4531-4541` is the production overwrite site) + the forced-`getState`
  prerequisite assertion, per WP11 steps 4–5 (UX decision #29 already chose the hook).
- dynamic-chat-tabs: sample the collapse hash from the field production reads —
  `currentFilenameTab.state.contentHash` via `page.evaluate` poll (decision at
  `src/app/preview-panel.ts:216-218`) — not the GET-mount response. Acceptance: 20/20 under
  `--repeat-each=20`; no quarantine/retries/timeout bumps.

#### CS-T2 — repro-h3 case (A) deterministic gate
- Author the deterministic snapshot↔in-flight gate (reuse the shipped `USER_ECHO_DELAY`
  knob; escalate to a `SNAPSHOT_GATE` trigger only if flaky) but **leave case A
  `test.fixme`** — the quarantine comment binds it to the separate snapshot-live-race goal
  (docs/design/snapshot-live-race-fix.md), which flips it in its own PR. This task only
  removes the harness excuse.

**Gate 4 (done):** symptoms A–D have no known reproducible trigger; every invariant in §5's
unpinned list is either pinned or explicitly accepted with a documented owner; suites green
with zero flakes.

---

## 7. Dependency / merge map

```
CS-H1 ──┬─→ CS-R3 ──→ CS-R4
        ├─→ CS-D4 (also after CS-R3/R4 — same functions)
        └─→ CS-D1 (E2E leg only)
CS-H2 (independent)
CS-R1 (independent, land first — trivial + total-outage fix)
CS-R2 ──→ CS-D6 (same functions; rebase)
CS-R6 ──→ CS-R7 (ordering constraint: gate before drain-on-idle)
CS-R5, CS-R8, CS-R9, CS-D1..D3, CS-D5, CS-D7..D9, CS-P1..P4, CS-T1..T2: parallel
File-conflict hotspots: session-manager.ts (CS-R1..R9, CS-D3, CS-D6, CS-P3 —
  serialize merges in task order), remote-agent.ts (CS-D2/D5/D7, CS-P2/P3 — distinct
  functions, merge cleanly), rpc-bridge.ts (CS-R1, CS-R8, CS-D4, CS-P3).
```

Recommended landing order: **CS-R1 → CS-H1‖CS-H2 → CS-R2 → CS-R5‖CS-R6 → CS-R3 → CS-R7 →
CS-R4 → CS-R8‖CS-R9 → Wave 2 (D1–D9, D6 after R2) → Wave 3 → Wave 4.**
