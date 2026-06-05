# Bobbit Real-Time Comms Stack — Master Remediation Plan (Step 3)

> Derived from [01-understanding.md](01-understanding.md) (architecture map, file:line anchors) and
> [02-analysis.md](02-analysis.md) (the 41 confirmed defects, refutations, test-fidelity report §4,
> and the eight root-cause clusters RC1–RC8 in §5). Every step below is concrete enough for a
> less-capable agent: exact file, the precise change, why, and the test that goes red→green.
>
> **Hard constraints (the user's stated requirements — every step honours them):**
> 1. **Do not jeopardise existing UX.** Every change preserves current passing behaviour; pinned
>    invariants stay green.
> 2. **Test-first.** Each fix is preceded by a test that FAILS on master (red) and passes after
>    (green). Where the current infra structurally cannot express the failure (the mock never echoes
>    image content blocks; seq fixtures hand-copy production), the FIRST job is to make the harness
>    faithful — that is Wave 0 (WP0); everything else depends on it.
> 3. **Minimal resource use.** Prefer the smallest change that removes the ROOT CAUSE, not a symptom
>    patch. Refactors are staged and well-tested only where a seam is fundamentally fragile.
>
> **Baselines that must stay green throughout:** `npm run check` clean · `npm run test:unit` = 1237
> pass · `npm run test:e2e` = 1078 pass.
>
> **Ground truth (settled, not re-litigated):** the real pi-agent echoes user messages as
> `{role:"user", content:[text, ...imageBlocks]}` and persists them to `.jsonl`; Bobbit's server does
> NOT strip image blocks (truncate only touches tool blocks). So image DATA is always present in
> message content — the image fix renders from that authoritative content and demotes the racy
> `_pendingAttachments` slot.

---

## 1. Executive summary

### Current → desired state

The user observes **four symptom families in real use** — in a single local tab and worse over a
high-latency VPN:

- **(A) Duplicate prompt/assistant bubbles** — same prompt or "Request aborted" banner rendered twice.
- **(B) Attached images detached/missing live** — the tile is wrong or absent on the live echo and
  only "heals" on reload.
- **(C) Session freezing / Stop doing nothing / prompts silently lost** — a wedged stream, a dead
  Stop button, or a prompt that clears the editor but never reaches the gateway.
- **(D) Streaming jank and abrupt reconnects** on large/attachment-heavy sends.

These trace to **eight shared root causes** (RC1–RC8, 02-analysis §5), not 41 independent bugs. The
desired state: each root cause is removed once, at its seam, with a faithful failing-then-passing
test; the four symptoms are gone; baselines stay green; no flaky tests.

### Why the suite is green despite 41 confirmed defects

The CI suite passes because the **mock agent and the pinning fixtures bake in comfortable assumptions
that excise every failure mode at the test boundary** (02-analysis §4): the mock echoes user prompts
text-only (never image content blocks), the seq sequencer is pinned by a hand-copied HTML fixture
that omits the overflow branch entirely, status self-heal is pinned by inline reimplementations, and
the default mock abort emits the wrong wire shape. **The missing/lying test IS the bug.**

### Strategy: fidelity-first, root-cause-once, staged

1. **Fidelity-first.** Wave 0 (WP0) makes the mock/harness able to EXPRESS the real wire shapes
   (image echo, seq overflow/reorder, real-abort shape, `message_start`, deterministic snapshot↔live
   race). No production `src/` change. Nothing else can be truly pinned until it lands.
2. **Root-cause-once.** Each later package removes one RC cluster at its seam (render-from-content;
   id-based dedup; seq-less→`emitSessionEvent`; overflow re-baseline + perm-hole retention; send
   outbox; respawn flag; payload slimming; hot-path/decoder).
3. **Staged & gated.** Packages are sequenced into ordered waves with an explicit acceptance gate
   (tests green + specific new assertions) before the next wave proceeds. Where a fix's correct-
   behaviour assertion would turn master red before the owning package lands, we ship a
   **characterization-green** test (asserts the CURRENT buggy behaviour, named "documents Sx") plus a
   `test.fixme` stub tagged with the owning package — honouring "master always green" while still
   encoding every failure mode.

---

## 2. Waves

Ordering rule: **Wave 0 first** (nothing is faithfully pinnable without it), then by
**(user-symptom impact × confidence × low-risk)** respecting every `dependsOn`.

| Wave | Packages | Goal | Depends on |
|------|----------|------|------------|
| **0** | WP0 | Test-fidelity foundation: make the mock/harness express the real failure modes. No `src/` change. | — |
| **1** | WP1 (RC2 images), WP2 (RC1 dedup) | Kill symptom B (images) and symptom A (duplicate bubbles) at the reducer/render seam. | WP0 |
| **2** | WP3 (RC5 send outbox), WP4 (RC3 seq-less broadcasts) | Kill the "silent prompt loss" and "orphaned banner / stale partial" legs of symptom C. | WP0 (WP4: none) |
| **3** | WP5 (RC4 seq recovery), WP9 (S8 wedged watchdog), WP6 (RC7 respawn flag) | Kill the freeze/stall and dead-Stop legs of symptom C; remove the grant double-prompt. | WP0 (WP9/WP6: none) |
| **4** | WP7 (RC6 payload slimming), WP8 (RC8 hot-path/decoder), WP10 (standalone low-risk) | Kill symptom D (jank/teardown) and mop up the independent correctness/hygiene gaps. | WP0 |
| **5** | WP11 (flaky-test root-cause) | Remove the three e2e flakes + the search-flush teardown ENOENT so the gate is trustworthy. | — |

**Independence note:** WP4, WP6, WP9, and WP11 do not actually need WP0 (verified in their reviews —
their tests drive real `SessionManager`/`EventBuffer`/`RemoteAgent.handleServerMessage` or are source-
walks). They may land in parallel with their wave. Within a wave, packages are independent unless a
`dependsOn` is stated.

### Wave acceptance gates

Each gate is a hard precondition for the next wave. **All gates also require:** `npm run check` clean;
`npm run test:unit` ≥ 1237 pass (pre-existing) + the wave's new tests; `npm run test:e2e` ≥ 1078 pass
(pre-existing) + the wave's new tests.

- **Gate 0 (after WP0):** `git diff src/` is empty. The mock, given a prompt carrying `images` with
  the `ECHO_IMAGE_BLOCK` trigger, emits a `role:'user'` `message_end` whose `content` includes an
  image block AND `get_messages` returns it. The DEFAULT mock abort emits
  `message_start → message_end(role:'assistant', stopReason:'aborted', content:[{text:''}],
  errorMessage:<reason>) → turn_end → agent_end → session_status idle` (full faithful shape — see
  WP0 step 9). A bundled-real-`RemoteAgent` seq spec reproduces the overflow re-baseline state and a
  clean reorder. Real-`SessionManager` harnesses drive `_emitStatusHeartbeat`,
  `maybeAutoRetryTransient`, and `forceAbort` force-kill. repro-h3 case A has a deterministic harness
  and remains `test.fixme` tagged with its owning package.
- **Gate 1 (after WP1+WP2):** A `role:'user'` message with image content blocks renders one tile per
  image both live and after reload, with the block's own mimeType; two concurrent image prompts each
  keep their own tile. The four dedup holes (S7/S10/S17/S18) collapse to exactly one row; two
  legitimately-distinct same-text messages stay two.
- **Gate 2 (after WP3+WP4):** A prompt issued while the WS is not OPEN is queued and delivered exactly
  once after reconnect; an over-aggregate-size send is rejected with a visible error and retains the
  draft. The three seq-less broadcasts carry a seq, enter the EventBuffer, and replay on resume; a
  stale "Retrying…" banner clears on an authoritative snapshot.
- **Gate 3 (after WP5+WP9+WP6):** A forced `_pendingEvents` overflow re-baselines and the next live
  event dispatches; a perm `since()` resume is hole-free. `forceAbort` force-kills at the grace period
  (3s) under a wedged bridge, not at 30s; the heartbeat watchdog surfaces a wedged stream once. A
  tool-permission grant produces no `[SYSTEM: …continue…]` bubble and the grant still completes.
- **Gate 4 (after WP7+WP8+WP10):** `queue_update` frames carry no base64 image/doc bytes; the remote
  send carries no document `content`. The five RC8 fixes are green (UTF-8 split, proposal precheck,
  rAF-coalesced jump button, async base64, no-subprocess header). All eight WP10 fixes green with no
  pinned-invariant regression.
- **Gate 5 (after WP11):** Each of the three named e2e tests passes 20/20 under `--repeat-each=20`;
  the `[search] flex flush` ENOENT/error line no longer appears across a full e2e run; no
  quarantine/skip/retries/timeout-bump introduced.

---

## 2.5 Delivery structure (RESOLVED) — 4 PRs + a foundation, with the owner's UX decisions

The product owner chose to ship as **four independent PRs from four independent worktrees**, one per
symptom family, rather than sequential waves. The package specs in §3 are the implementation reference;
this section maps them onto the four PRs and records the resolved UX decisions (superseding the matching
entries in §4).

### 2.5.1 PR map

| PR | Symptom | Packages / seams | Branches from | Touches (src hotspots) |
|----|---------|------------------|---------------|------------------------|
| **PR-0 — Test-fidelity foundation** *(merge first; pure test infra, `git diff src/` empty)* | — | WP0 (all of it) + WP11's harness-only bits | `master` | `tests/` only (mock-agent-core.mjs, in-process-mock-bridge.mjs, new real-RemoteAgent + real-SessionManager harness helpers) |
| **PR-A — Images** | B | WP1 (render-from-content; demote slot) + **S26** (steered images) | PR-0 | `Messages.ts` (UserMessage render), `remote-agent.ts` (live enrich ~2200), `message-reducer.ts` (enrich-on-live) |
| **PR-B — Duplicates** | A | WP2 (RC1: S7/S10/S17/S18) + **S4** (double-Enter — newly assigned) + **S3** (IME guard) + WP11's two reload flakes | PR-0 | `message-reducer.ts` (dedup + synth-id), `remote-agent.ts` (synth-id stamp ~2189), `MessageEditor.ts`/`AgentInterface.ts` (sync clear + IME) |
| **PR-C — Reliability** | C | WP3 (outbox→queue pills) + WP4 (seq-less→emitSessionEvent) + WP5 (seq re-baseline + perm-hole) + WP6 (respawn flag) + WP9 (reliable Stop, **watchdog dropped**) + **S13** (30s ack — newly assigned) + S40 (auto-retry cancel) | `master` (WP4/6/9 don't need PR-0; WP3/5 do) | `session-manager.ts`, `remote-agent.ts` (send/auth_ok/seq), `event-buffer.ts`, `rpc-bridge.ts` (S13), `ws/protocol.ts` |
| **PR-D — Jank/teardown** | D | WP7 (payload slimming) + WP8 (RC8: S14/S32/S34/S35/S37) + WP10 standalones (S33, S36, S42, S43) + S29 (reconnect refetch coalesce) + WP11 search-flush ENOENT | PR-0 (minimal) | `session-manager.ts` (broadcast projection), `rpc-bridge.ts` (StringDecoder), `remote-agent.ts`/`AgentInterface.ts` (hot paths), `attachment-utils.ts`, `aigw-manager.ts`, `flex-store.ts` |

**Why a foundation PR-0 rather than splitting WP0 four ways:** WP0 edits the *shared* mock/harness
(`mock-agent-core.mjs`, `in-process-mock-bridge.mjs`) and adds shared real-class harness helpers. If all
four symptom PRs re-edited those files in parallel worktrees they would collide on merge (the
default-abort-shape change alone is needed by both PR-B and PR-C). Landing WP0 once, first, keeps the
four symptom PRs from touching the shared harness at all — they only add their own test files + edit
`src/`. PR-0 is pure test infra (no behaviour change), so it is safe to merge ahead of the fixes. *If you
require exactly four PRs, WP0's pieces are additive and can be split per-PR — but accept a rebase on the
one shared mock edit.*

**Honest conflict note (not fully disjoint):** the four symptom PRs are independent at the *feature*
level but two `src/` files are touched by more than one: `message-reducer.ts` (PR-A enrich-on-live +
PR-B dedup/synth-id) and `remote-agent.ts` (PR-A, PR-B, PR-C, PR-D each touch different regions). The
edits are in *distinct functions*, so they merge cleanly in practice — but to be safe, land PR-A → PR-B
→ PR-C → PR-D in that order and rebase, or resolve the few region overlaps at merge. Keep each PR's
edits confined to its named functions.

### 2.5.2 Resolved UX decisions (supersede §4)

- **S2 lost-prompt affordance (supersedes §4 #8, #9).** **Reuse the existing prompt-queue/steer pill
  strip** — do NOT invent a new "pending bubble." Concretely: render `_pendingOutbox` entries through
  the same `queuedMessages` channel that feeds the pill strip (`RemoteAgent` exposes outbox+server queue
  to `onQueueUpdate`; `AgentInterface` renders both at `:2110`), tagged `unsent:true` for a distinct
  "waiting to send" style. An offline send becomes a **pending pill above the composer** (not a
  transcript bubble); on `auth_ok` the outbox flushes FIFO, the server echoes, and the normal
  `queue_update` reconciliation removes the pill as the transcript row appears. This unifies
  offline-pending with the streaming-queued affordance the user already knows, and *drops* WP3 steps 5–6
  (the `_pendingSend` transcript-bubble marker and the `Messages.ts` change) in favour of the
  pill-strip render. WP3's outbox mechanics (steps 1–4, 7) and the S31 guard (step 8) are unchanged.
- **S31 oversized-attach (supersedes §4 #10).** **Reject with a clear inline error** before send
  (`[data-testid=composer-size-error]`, retain draft) — WP3 step 8 as written. Confirmed.
- **S8 wedged-streaming (supersedes §4 #23, #24).** **"Just make Stop reliable" — the heartbeat
  watchdog is DROPPED.** WP9 keeps ONLY step 1–2 (author `force-abort-grace-race.test.ts`; fix
  `forceAbort` to fire `abort()` un-awaited inside an async IIFE and race the 3s grace timer → force-kill
  at ~3s not ~30s, including the synchronous-throw wrap). Delete WP9 steps 3–9 and the
  `wedged-streaming-watchdog.test.ts`/`StreamingStallWarningEvent`/`streamingStallSurfacedAt` work. The
  client-side stale-streaming-row (the drift-to-idle leg) is healed by **PR-C/WP4** (seq-buffered
  `agent_end`), so no separate watchdog is needed.
- **Sequencing (supersedes §4 ordering).** Four parallel PRs as mapped above; recommended *merge* order
  PR-0 → PR-A → PR-B → PR-C → PR-D (for the conflict note), but they may be *developed* in parallel
  worktrees off PR-0.
- **Remaining §4 micro-decisions (#1–7, #11–22, #25–30):** accept the **Recommended** option as written
  unless flagged during implementation — each is a single-seam, one-line choice and the recommendation
  is the lowest-risk default.

### 2.5.3 Newly-assigned defects (gap caught in review)

The Step-3 package decomposition omitted two **confirmed** duplicate-render defects from `02-analysis.md`.
They are assigned here:

- **S4 — fast double-Enter sends twice** → **PR-B**. Fix (02-analysis S4): clear `this.value`/
  `this.attachments` **synchronously** in `MessageEditor.handleSend` BEFORE invoking `onSend` (restore on
  the abort/early-return paths), OR a synchronous `_sending` re-entrancy flag — removes the un-cleared
  window without touching the `await` ordering. Red test: idle, dispatch two `keydown{Enter}` within a
  tick against a macrotask-resolving storage stub; assert one bubble + one `prompt` frame.
- **S13 — 30s prompt-ack timeout double-dispatches a slow-but-accepted prompt** → **PR-C** (NEEDS-TRACE on
  the wall-clock; the fix is low-risk regardless). Fix (02-analysis S13): raise the prompt-specific
  `sendCommand` timeout well beyond worst-case auto-compaction (Bobbit's own `/compact` already uses
  120s), or keep the pending entry alive past timeout so a late ack resolves it and cancels recovery —
  relying on the existing `process_exit` path for genuine death detection. Red test: a stub CLI whose
  `prompt` handler delays its success line past an injectable lowered ack timeout; assert the prompt
  resolves and NO second `prompt` command is written.

Minor/deferred: **S11** (no-toolCall hand-off flicker — NEEDS-TRACE) and **S29** (un-coalesced
per-reconnect REST refetch — low perf) are tracked for PR-D follow-up, not blocking.

---

## 3. Packages

> Each package below has been revised to incorporate its review. Steps a reviewer flagged as
> UX-regressing or non-minimal are dropped or rewritten; review-corrected file anchors and shapes are
> used.

---

### WP0 — Test-fidelity foundation (Wave 0)

**Goal.** Make the mock/harness express the real comms-stack failure modes. **No production `src/`
change** (`git diff src/` must be empty).

**Root cause removed.** The mock and fixtures excise every failure mode at the test boundary
(02-analysis §4 P0–P2): the mock echoes prompts text-only and discards `images`; the seq fixture
hand-copies `handleServerMessage` without the overflow branch; status/auto-retry/wedge self-heal are
inline reimplementations; the default abort emits the wrong shape; `message_start`/`turn_end` are
omitted; echo timing is instant.

#### Prerequisite red tests (authored here, flipped green by later packages)

- `tests/mock-agent-core-image-echo.test.ts` (NEW, pure `node:test` over `MockAgentCore`) — pins that
  the mock can build `{role:'user', content:[text, image]}` from forwarded images. RED on master (echo
  is text-only; `handleCommand` discards `msg.images`). GREEN after steps 1–4.
- `tests/mock-abort-shape.test.ts` (NEW, pure `node:test`) — pins the DEFAULT abort emits the full
  faithful shape. RED on master (default abort emits no assistant message). GREEN after step 9.
- `tests/remote-agent-handle-server-message-seq.spec.ts` (NEW, bundled REAL `RemoteAgent`) — drives
  the real overflow + reorder branches. The pure-reorder case is GREEN on master and MUST stay green;
  the overflow-stall case is GREEN-as-characterization (documents the S9 stall for WP5 to flip).
- `tests/session-manager-heartbeat-resync.test.ts`, `tests/session-manager-auto-retry-fire-cancel.test.ts`,
  `tests/session-manager-wedged-streaming.test.ts` (NEW, real `SessionManager` + node mock timers /
  fake bridge) — characterization-green tests documenting S8/S40, with a `test.fixme` stub for the
  eventual correct-behaviour assertion tagged with the owning package (WP9/WP10/WP6 region).
- `tests/e2e/ui/image-attach-roundtrip.spec.ts` (NEW, browser E2E) — the WP1 target; WP0 authors the
  faithful harness, leaves the live-tile assertion for WP1.

#### Steps

1. `tests/e2e/mock-agent-core.mjs:469` (`handlePrompt`) and `:473-475` (echo build). Thread `images`
   and build the real echo shape ONLY when the `ECHO_IMAGE_BLOCK` trigger is present (opt-in; default
   path byte-identical). Emit `message_start` before the user `message_end`:
   ```js
   async handlePrompt(text, images) {
     this.currentAbortController = new AbortController();
     const echoImages = /ECHO_IMAGE_BLOCK/.test(text) && Array.isArray(images) && images.length
       ? images.map(im => ({ type: 'image', data: im.data, mimeType: im.mimeType || 'image/png' }))
       : [];
     const userMsg = { role: 'user', content: [{ type: 'text', text }, ...echoImages] };
     this.emit({ type: 'message_start', message: userMsg });
     this.conversationMessages.push(userMsg);
     this.emit({ type: 'message_end', message: userMsg });
     ...
   ```
2. `tests/e2e/mock-agent-core.mjs:1824-1831` (`handleCommand` case `'prompt'`/`'follow_up'`). Forward
   `msg.images` into the serialized `handlePrompt`:
   ```js
   const text = msg.message || "";
   const images = Array.isArray(msg.images) ? msg.images : undefined;
   this._promptChain = this._promptChain.catch(() => {})
     .then(() => this.handlePrompt(text, images))
     .catch(err => console.error('[mock-agent-core] Prompt error:', err));
   ```
3. `tests/e2e/mock-agent-core.mjs:1865-1885` (`handleCommand` case `'steer'`). Thread `images` on the
   steered prompt too (harmless today; enables WP10's S26 steer-image work). Note the steer ECHO
   handler lives in `tests/e2e/mock-agent-core.mjs` (imported by `in-process-mock-bridge.mjs:21`), NOT
   in the bridge file.
4. `tests/e2e/mock-agent-core.mjs:469` (`handlePrompt`) — add an echo-delay knob. Support both an env
   knob (`MOCK_USER_ECHO_DELAY_MS`) and an inline `USER_ECHO_DELAY=<ms>` in the prompt text so it
   survives the spawned/in-process boundary; apply the delay BEFORE emitting the user
   `message_start`/`message_end` so the gap sits between the optimistic row and the echo. Default (no
   knob) emits synchronously as before.
5. `tests/fixtures/remote-agent-seq-entry.ts` (NEW) + `tests/fixtures/remote-agent-seq.html` (NEW) +
   `tests/remote-agent-handle-server-message-seq.spec.ts` (NEW). Bundle the REAL `RemoteAgent` and
   drive the REAL `handleServerMessage` — mirror `tests/fixtures/spurious-idle-unread-entry.ts`
   (proven to bundle `app/` modules via `tests/fixtures/build-bundle.ts`). **Review corrections:**
   `handleServerMessage` is `async` and `private` — runtime-OK in the bundle, but `await` each call
   for deterministic ordering of the snapshot/`requestMessages` side effects; drop the redundant
   `(window).WebSocket = ... || {OPEN:1}` shim (real `WebSocket.OPEN===1` already exists in a browser
   page — the fake `{readyState:1}` ws works). Cases: (a) overflow — seq 1 then 501 frames with a gap,
   assert `ra._highestSeq===0 && ra._seqInitialized===true` and a `{type:'get_messages'}` was sent;
   (b) reorder — 1,3,2 → assert dispatch order `[1,2,3]` (GREEN on master, must stay green); (c)
   post-overflow stall — after snapshot, deliver seq=504 and assert it gap-buffers (characterizes S9).
6. `tests/session-manager-heartbeat-resync.test.ts` (NEW) — template
   `tests/session-manager-heartbeat.test.ts`. Real `SessionManager` via dynamic import (set
   `BOBBIT_DIR` to a mkdtemp first). Drive `_emitStatusHeartbeat` re-broadcast (GREEN), `status_resync`
   recovery (GREEN), and a wedged-streaming **characterization** (status `streaming`,
   `streamingStartedAt` long-past, no `agent_end`; assert NO escalation today — documents S8 for WP9).
   The `_maybeReplayGrant` grant-replay coupling is browser code → assert it in a browser spec reusing
   the step-5 bundle.
7. `tests/session-manager-auto-retry-fire-cancel.test.ts` (NEW) — template
   `tests/session-manager-direct-prompt-lifecycle.test.ts` (uses `t.mock.timers`). Real
   `SessionManager` + mock `rpcClient.prompt`. Cases: (1) timer fires while idle → prompt called
   (GREEN); (2) new prompt before fire → cancel → prompt NOT called (GREEN); (3) **characterization**:
   `forceAbort` the idle session in the backoff window → advance timers → assert prompt WAS called
   (documents S40 for WP10 to flip).
8. `tests/session-manager-wedged-streaming.test.ts` (NEW) — real `SessionManager` + fake bridge whose
   `abort()` never resolves and which never emits `agent_end`. Characterizes the current force-kill
   timing and the drift-to-idle no-op (documents S8 shape-(b) for WP9). Use a short `gracePeriodMs`
   (e.g. 50ms) so the test is fast. **Review note (from WP9):** the fake session MUST include
   `eventBuffer: new EventBuffer()` and be registered via `manager.addClient(id, makeClient())` (or
   `manager.sessionsWithConnectedClients.add(session)`) so the heartbeat loop actually scans it —
   bare `manager.sessions.set()` is skipped by `_emitStatusHeartbeat`.
9. `tests/e2e/mock-agent-core.mjs:1889-1943` (`handleCommand` case `'abort'`) — change the DEFAULT
   shape to the FULL faithful sequence. **Review correction (HIGH):** ground truth
   `node_modules/@earendil-works/pi-agent-core/dist/agent.js:329-345` emits
   `message_start → message_end → turn_end → agent_end` with `stopReason='aborted'` for a USER abort
   (never `'error'`), `errorMessage`=the real reason. Emit:
   ```js
   const abortedMsg = { role:'assistant', content:[{type:'text',text:''}], stopReason:'aborted', errorMessage:'Request aborted' };
   this.emit({ type:'message_start', message: abortedMsg });
   this.emit({ type:'message_end', message: abortedMsg });
   this.emit({ type:'turn_end' });          // ← was omitted; real agent always emits it
   this.emit({ type:'agent_end' });
   this.emit({ type:'session_status', status:'idle' });
   ```
   Keep `MOCK_ABORT_AS_ERROR=1` as an explicit `stopReason:'error', content:[]` override for the
   error-gated-drain tests, **but flag in the test file** that the SDK ground truth is that a user
   Stop is `stopReason:'aborted'` — the existing `steer-during-bash-tool.spec.ts` / comment at
   `session-manager.ts:2280-2291` premise (user Stop → `'error'` → `lastTurnErrored`) is a fiction
   that WP9/WP10 must settle, not WP0. **This is the ONE behaviour change to existing mock output:**
   widen the Step-9 audit net to cover (a) DOM transcript assertions (the new red "Request aborted"
   banner row — `Messages.ts:426-427`; suppressed only for auto-compaction self-aborts at
   `MessageList.ts:288-293`), (b) assistant-row counts, AND (c) "first message_end after cursor"
   ordering assertions (`abort-status-e2e.spec.ts`), not just message counts. **Also note:**
   `message_start` is a no-op in the STATE reducer (`remote-agent.ts:2081-2085`) but triggers
   `AgentInterface._updateAndPin()` (`AgentInterface.ts:1088`) — verify no follow-tail / scroll /
   jump-button spec regresses from the extra pin before merge.
10. `tests/e2e/ui/repro-h3-snapshot-live-interleave.spec.ts:144` (the `test.fixme`). AUTHOR a
    deterministic gate (reuse the `USER_ECHO_DELAY` knob from step 4 to widen the gap and fire
    `requestMessages()` inside it; escalate to a dedicated `SNAPSHOT_GATE` trigger only if the delay
    proves flaky under CI parallelism). **Review correction:** do NOT un-`fixme` case A — the comment
    at `spec.ts:140-143` ("Do NOT undo this fixme until that goal lands. See
    docs/design/snapshot-live-race-fix.md") and the "master always green" gate forbid it. Leave case A
    as `test.fixme('(A)…')` tagged `TODO(WP-seq)` + the docs reference; the owning package flips
    fixme→active in the same PR as its fix.

#### Acceptance criteria
- `git diff src/` is empty.
- `npm run check` clean; `test:unit` pre-existing 1237 still pass (only deltas are new WP0 tests + any
  abort-spec assertions updated in step 9); `test:e2e` pre-existing 1078 still pass.
- `mock-agent-core-image-echo.test.ts` green; every `message_end` is preceded by a `message_start`;
  default abort emits the full `message_start → message_end(aborted) → turn_end → agent_end → idle`
  sequence (`mock-abort-shape.test.ts` green, asserting `turn_end` between the aborted `message_end`
  and `agent_end`).
- The bundled-real-`RemoteAgent` seq spec reproduces the overflow re-baseline and a clean reorder.
- Real-`SessionManager` tests drive heartbeat-resync, auto-retry fire/cancel, and wedged force-kill,
  each with a characterization assertion (S8/S40) + a `test.fixme` stub tagged with the owning
  package.

#### Rollback
All WP0 artifacts are independently revertable with zero production `src/` impact: revert
`tests/e2e/mock-agent-core.mjs` to restore byte-identical default output; delete the new standalone
test files; revert the small step-9 abort-consumer assertion edits; revert repro-h3 to `test.fixme`.

---

### WP1 — RC2: Render images from authoritative content; demote the racy `_pendingAttachments` slot (Wave 1)

**Verdict: go** (review confirmed every anchor and the no-UX-regression claim).

**Root cause removed.** S6 — `UserMessage.render()` (`Messages.ts:183-195`) renders tiles only when
`role==='user-with-attachments' && attachments.length>0`, with no branch walking `content` for
`{type:'image',data}`. S1 — the live-event path's only enrichment is the single-slot
`_pendingAttachments` (decl `remote-agent.ts:206`, set `:847`, consumed `:2200-2207`, nulled by an
`error` frame at `:1694`); `enrichUserMessage` (`message-reducer.ts:164-178`) runs ONLY on the
snapshot path (`:245`), never on the live-event path (`:188-241`) — that asymmetry is why the image
"heals" only on reload.

#### Prerequisite red tests
- `tests/user-message-image-render.html` + `…-entry.ts` + `…-bundle.js` + `tests/user-message-image-render.spec.ts`
  (NEW). **Review correction:** mirror `tests/ask-user-choices-renderer.spec.ts` (which bundles the
  REAL `UserMessage`/`AttachmentTile` Lit components via esbuild with `--tsconfig=tsconfig.web.json`
  and the pdfjs empty-shim alias), NOT `message-editor-attach.html` (a hand-rolled vanilla replica
  that would defeat the S6 pin). Add the missing `-entry.ts` and `-bundle.js` artifacts. Cases:
  (i) `role:'user'` with one image block + no `attachments` → exactly one `attachment-tile`, `<img>`
  src starts `data:image/png;base64,`; (ii) no image block → zero tiles; (iii) JPEG block → src starts
  `data:image/jpeg;base64,`; (iv) `user-with-attachments` with BOTH a non-empty `attachments` array
  AND image content blocks → tiles come from `attachments` (rich wins), count not doubled.
- `tests/message-reducer.test.ts` (NEW cases): (i) live image echo → single stored row
  `role==='user-with-attachments'`, `attachments[0].content==='AAA'`; (ii) two concurrent optimistic +
  two image echoes → exactly 2 rows, each with its own image; (iii) an ASSISTANT live message whose
  content contains an image block is NOT enriched (pins the `role!=='user'` short-circuit). All red on
  master where applicable.
- `tests/e2e/ui/image-echo-live-and-reload.spec.ts` (NEW, browser E2E, depends on WP0 mock echo):
  live single-image tile from server echo, persists across reload, two concurrent distinct tiles.
  Assert `attachment-tile` count (not just `attachment-tile img`) === 1 per image-bearing row to catch
  a double-attach.

#### Steps
1. `src/ui/components/Messages.ts` (new top-level helper near `convertAttachments`, ~line 666). Add a
   pure `imageAttachmentsFromContent(content): Attachment[]` mirroring `enrichUserMessage` field-for-
   field (same `image-N.png` filename, same `mimeType || media_type || 'image/png'` fallback, same
   `preview` field). **Review note:** `Attachment` is already imported at `Messages.ts:16` — do NOT
   re-import it.
2. `src/ui/components/Messages.ts:183-195` (`UserMessage.render()`). Render tiles from EITHER the rich
   `attachments` array OR (when empty) the content image blocks; rich attachments win:
   ```ts
   const richAttachments = this.message.role === "user-with-attachments" ? (this.message.attachments ?? []) : [];
   const tiles = richAttachments.length > 0 ? richAttachments : imageAttachmentsFromContent(this.message.content);
   ```
   then map `tiles` to `<attachment-tile>`s.
3. `src/app/message-reducer.ts:188-241` (live-event case) + export `enrichUserMessage` (line 164).
   Apply the SAME `enrichUserMessage` the snapshot path uses, on the live-event path:
   `const incoming = enrichUserMessage(frame.message);` before reconciliation. It is a no-op for
   non-user / no-image / already-`user-with-attachments` rows, so assistant rows and the optimistic-
   echo text-fallback are unaffected.
4. `src/app/remote-agent.ts:2199-2207` (live-event `message_end` slot consumption). Demote the slot to
   a fallback used ONLY when the echo carries NO image block (so the reducer-derived tile and the slot
   never double-attach); clear the slot unconditionally (one-shot):
   ```ts
   if (msg.role === "user" && this._pendingAttachments) {
     const echoHasImage = Array.isArray(msg.content) && msg.content.some(c => c?.type === "image" && c?.data);
     if (!echoHasImage) msg = { ...msg, role: "user-with-attachments", attachments: this._pendingAttachments };
     this._pendingAttachments = null;
   }
   ```
5. Author `tests/user-message-image-render.*` (step-5 artifacts above).
6. Author `tests/e2e/ui/image-echo-live-and-reload.spec.ts` (depends on WP0).

#### Acceptance criteria
- A `role:'user'` message with `{type:'image',data,mimeType}` blocks renders one tile per image using
  the block's own mimeType (png/jpeg/webp round-trip).
- Live-event and snapshot paths enrich identically (no live/reload divergence); two concurrent image
  prompts each render their own tile; exactly one tile per image-bearing row (no double-attach); with
  the slot forced null the tile still appears from content.
- Existing pinned invariants stay green: optimistic-vs-echo reconciliation (reducer cases 5/6/7),
  snapshot survivor/H3 (cases 10/12), `new-tab-no-duplicate-messages.spec.ts`, `skills-chip.spec.ts`,
  `message-editor-attach.spec.ts`.

#### Rollback
Revert steps 1–4 (additive). Step 2 alone fixes the common single-image live case, so a partial
rollback of 3–4 still leaves the render branch working. New test files are delete-only. No
data/protocol change.

---

### WP2 — RC1: Stable correlation id / id-based dedup at the reducer boundary (Wave 1)

**Verdict: revise** — incorporates the over-dedup pin, the prefixed-S17 scope, and anchor fixes.

**Root cause removed.** There is no stable correlation id linking an optimistic row, the server-
persisted user row, and the live echo (RC1). Server user/aborted/errored rows are persisted id-less
(agent.js:255-259); the optimistic id can never match. The reducer falls back to exact-text
reconciliation with four holes: S7/S10 (id-less EMPTY-text rows skip the multiset), S18 (optimistic
survivor deduped by id only), S17 (skill-expanded echo text diverges).

#### Prerequisite red tests (all `tests/message-reducer.test.ts`, pure reducer, `needsHarnessChange:false`)
- **S7/S10:** id-less EMPTY-text aborted/errored assistant live row + snapshot with the same id-less
  empty row → ONE row; a second snapshot stays one (idempotent). RED on master (2).
- **S18:** optimistic same-text prompt + snapshot-before-echo → ONE; later id-less live echo → still
  ONE. RED on master (2 then 2).
- **S18 non-regression:** two id'd snapshot rows with the same text → TWO; two distinct optimistic+echo
  pairs → TWO. GREEN on master AND after fix (guards against over-dedup).
- **Step-4b over-dedup non-regression (NEW, from review):** an id-less prior-SNAPSHOT plain-text
  assistant `'OK'` row, then a genuinely-distinct NEW live assistant `message_end` with the SAME text
  at a later seq → assert BOTH survive (length 2). This is the only path the existing tests miss and
  the only behaviour-changing dedup that can regress passing UX.
- **S17 (scoped):** optimistic `/foo` with a whole-text `skillExpansions` + a live echo of the
  UNPREFIXED expanded body `EXPANDED foo` → ONE row. RED on master (2).
- **Prefixed-S17 scope-out (NEW, from review):** optimistic `/foo` + a live echo of the
  error-recovery-PREFIXED body `[SYSTEM: …]\n\n<expanded>` → asserts it currently stays 2 and is
  documented as NOT closed here (the server-side splice/prefix-strip fix at `session-manager.ts:547`
  owns it).
- **synth-id stamp:** id-less assistant live `message_end` at seq 7 → `id === 'synth:seq:7'`;
  re-deliver same seq → length 1 (replace-by-id).
- **keyFor reorder-stability (NEW, from review):** a synth:seq-stamped id-less live row, re-delivered/
  reordered via a later snapshot → stable render key (no DOM remount) — pins the "render-key stability
  IMPROVED" claim.

(The two full-stack E2E pins — empty-text abort + forced snapshot → ONE banner; same-text prompt with
snapshot-in-the-echo-gap → ONE bubble — are **WP0-gated and deferred**; the reducer-unit pins are the
gating red→green for this merge. **Review correction:** the aborted banner has no `data-testid`; add
`data-testid="aborted-banner"` to the `<span>` at `Messages.ts:426-428` as part of WP0/the E2E work,
or select on the `i18n('Request aborted')` text.)

#### Steps
1. `src/app/message-reducer.ts:188-207` (live-event case). Change `const incoming` → `let incoming`;
   stamp `synth:seq:<seq>` on id-less server rows BEFORE the replace-by-id block. (Distinct from the
   `synth:tc:` scheme in `src/app/streaming-message-id.ts:26`, stamped in `remote-agent.ts:2186-2188`
   BEFORE the reducer, so synth:seq never overwrites it and `streamingMessageId` stays intact.)
2. `src/app/message-reducer.ts:78-81` (after `normaliseText`). Add `plainTextEquivKey(m)`: returns
   `${role}|EMPTY|${stopReason}` when `normaliseText(extractText(m))` is empty, else `${role}|${text}`.
3. `src/app/message-reducer.ts:313-320` (snapshot multiset build) and `:362-372` (survivor consume).
   Replace both `(role|text)`-skip-empty constructions with `plainTextEquivKey`; remove the now-
   redundant `t.length>0` guards. Closes S7/S10's snapshot side while preserving the H3 cardinality
   contract.
4. `src/app/message-reducer.ts:403-408` (optimistic survivor) + live-event reconcile.
   (a) Optimistic survivor: after the id check, consume the SAME multiset budget by `plainTextEquivKey`.
   (b) Live-event: consume a matching id-less prior-snapshot ARTIFACT (`_origin:'server'`, `_order<=0`,
   id-less, plain-text) so the later id-less echo doesn't re-stack. **Review correction — tighten the
   match to avoid over-dedup:** only splice the artifact when the incoming live row is reconciling an
   optimistic/echo lineage (a user/steer echo), NOT an arbitrary assistant `message_end`. This prevents
   deleting a real prior-snapshot assistant row when a genuinely-distinct new same-text assistant reply
   arrives. The id-less + `_order<=0` scoping already excludes the id'd `inflight-steer:*` synthetic
   (`src/server/agent/splice-inflight-message.ts:113`), preserving the §9.3 lifecycle.
5. `src/app/message-reducer.ts:221-228` (optimistic text-fallback) + a `reconstructModelText(m)` helper
   near `extractText`. Splice the optimistic row's `skillExpansions` ranges right-to-left (mirrors
   `resolveSkillExpansions.ts:142-147`), returning verbatim text on stale ranges. Extend the fallback
   predicate to `(extractText(m) === text || reconstructModelText(m) === text)`. **Scope:** closes the
   UNPREFIXED skill-expand case only; the prefixed error-recovery case is explicitly out of scope (see
   the prefixed-S17 scope-out test) and deferred to the server-side splice fix.
6. Run `npm run check && npm run test:unit && npm run test:e2e`.

#### Acceptance criteria
- id-less server live rows carry `synth:seq:<seq>`; re-delivery replaces in place.
- S7/S10/S18/S17(unprefixed) collapse to ONE row each; two legitimately-distinct same-text messages
  stay TWO; an id-less prior-snapshot artifact + a distinct new same-text assistant reply stay TWO;
  the §9.3 id'd `inflight-steer:*` lifecycle is unchanged.
- The prefixed-S17 case is documented as not-closed-here.
- `npm run check` clean; `test:unit` (≥1237 + new) green; `test:e2e` (≥1078) green.

**dependsOn correction:** the reducer fix + all 8 unit pins are independent of WP0 (`needsHarnessChange:false`,
all expressible on master). Only the 2 deferred full-stack E2E pins depend on WP0. WP2 is mergeable on
its own.

#### Rollback
Confined to the pure `src/app/message-reducer.ts` + additive test cases. Each sub-fix independently
revertible (drop step 5 without affecting S7/S10/S18; drop step 4b leaving snapshot-side dedup intact).
No state/schema/wire change.

---

### WP3 — RC5: Send outbox + commit safety (lost prompts) (Wave 2)

**Verdict: revise** — incorporates the S31 arithmetic fix, the draft-cleanup ordering fix, the anchor
fix, and the streaming-queued scoping.

**Root cause removed.** No back-pressure/commit-safety on the user-intent send path. S2:
`RemoteAgent.send()` (`remote-agent.ts:1253-1259`) silently drops a frame when not OPEN (console.warn
only; zero outbox/resend). S31: the `WebSocketServer` (`server.ts:1071`) sets no `maxPayload`
(inherits ws default 100 MiB) and the composer enforces only per-file caps — a multi-image frame
(~3× base64 per image) can trip close-1009. S38: `_maybeReplayGrant` re-sends through the same
droppable `send()`.

#### Prerequisite red tests
- `tests/e2e/ui/send-outbox.spec.ts` (NEW, real `RemoteAgent` over the spawned gateway, model on
  `repro-h3-snapshot-live-interleave.spec.ts`). Idle session: close the socket, `ra.prompt('lost-xyz')`
  synchronously before reconnect; assert the optimistic bubble carries `[data-pending-send]` and after
  reconnect the server transcript has exactly ONE copy. RED on master.
- `tests/remote-agent-outbox.spec.ts` (NEW). When `ws.readyState!==OPEN`: `{type:'prompt'}` enqueues,
  `{type:'get_state'}` does not; on `auth_ok` the outbox flushes FIFO then clears; bounded (oldest
  dropped past cap). **Review addition:** also assert `{type:'steer'}` and `{type:'retry'}` enqueue
  while CLOSED and `set_model`/`status_resync`/`abort` do not.
- `tests/composer-aggregate-size-guard.spec.ts` (NEW, model on `message-editor-attach.spec.ts`). An
  over-aggregate Send → `onSend` NOT called, `[data-testid=composer-size-error]` shown, value/
  attachments retained.
- `tests/ws-max-payload.test.ts` (NEW). Assert the constructed wss options include a numeric
  `maxPayload === WS_MAX_PAYLOAD_BYTES` (extract the options into an exported const so it imports
  without booting a socket).
- `tests/e2e/ui/grant-replay-outbox.spec.ts` (NEW). The post-grant replay survives a flap and reaches
  the server exactly once.
- **Review additions:** a test that a frame measured at `maxAggregateSendBytes` still serializes
  (incl. `images[].data`) to under `WS_MAX_PAYLOAD_BYTES`; a test that an over-size rejection in
  `handleSend` does NOT fire the `'message-send'` draft-cleanup event.

#### Steps
1. `src/server/server.ts:1071`. Add `export const WS_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;` and
   construct `new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: WS_MAX_PAYLOAD_BYTES })`.
   Pick it strictly greater than the composer aggregate cap (step 8), yet bounded.
2. `src/app/remote-agent.ts` (fields near the reconnect-state block ~316-321). Add
   `_pendingOutbox: any[] = []`, `static OUTBOX_MAX = 50`,
   `static OUTBOX_FRAME_TYPES = new Set(['prompt','steer','retry'])`.
3. `src/app/remote-agent.ts:1253-1259` (`send()`). Enqueue user-intent frames when not OPEN; leave the
   OPEN-socket branch byte-identical:
   ```ts
   private send(msg: any): void {
     if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(msg)); return; }
     if (RemoteAgent.OUTBOX_FRAME_TYPES.has(msg?.type)) {
       if (this._pendingOutbox.length >= RemoteAgent.OUTBOX_MAX) this._pendingOutbox.shift();
       this._pendingOutbox.push(msg); return;
     }
     console.warn('[RemoteAgent] Message dropped (WS not open):', msg?.type);
   }
   ```
4. `src/app/remote-agent.ts:667-698` (the `auth_ok` branch). After `_setConnectionStatus('connected')`,
   call `this._flushOutbox()`. Add `_flushOutbox()` that atomically moves frames out, sends them FIFO
   (re-pushes on throw), then `_clearPendingSendMarkers()`.
5. `src/app/remote-agent.ts:861-877` (`prompt()`) and `:891-899` (`steer()`). Mark the optimistic
   message `_pendingSend:true` when the socket is not OPEN at construction. Add `_clearPendingSendMarkers()`
   that deletes the flag and emits `render`. (keyFor is id-based — mutating in place does not remount.)
   **Review scope correction:** `prompt()` only builds the optimistic bubble when `!isStreaming`
   (`remote-agent.ts:861`). A prompt issued while STREAMING + ws-closed is queued server-side with no
   optimistic bubble — the outbox still saves it (not lost), but there is no bubble to carry
   `_pendingSend`. Scope acceptance criterion #4 to the idle case (or add a streaming-queued affordance
   in a follow-up).
6. `src/ui/components/Messages.ts:179-199` (`UserMessage.render()`). Render a non-layout-shifting
   `[data-pending-send]` indicator when `this.message._pendingSend`.
7. `src/app/remote-agent.ts:1156-1165` (`_maybeReplayGrant`). The replay already calls
   `send({type:'prompt',…})`; because `'prompt'` is in `OUTBOX_FRAME_TYPES`, step 3 makes it outbox-
   safe. Comment-only change (the outbox now owns delivery).
8. `src/ui/components/MessageEditor.ts` (`handleSend`, ~454-465; constant near `maxFileSize` ~87). Add
   `maxAggregateSendBytes`. **Review correction (HIGH):** the prompt frame carries THREE base64 copies
   per image (`images[].data` derived at `remote-agent.ts:831` + `attachments[].content` +
   `attachments[].preview`). Measure the REAL serialized size — build the exact frame `prompt()` will
   send and use `JSON.stringify(frame).length` — then keep `maxAggregateSendBytes × inflation` strictly
   below `WS_MAX_PAYLOAD_BYTES`. **Review correction (MEDIUM, draft data-loss):** the size check + early
   return must be the FIRST statements in `handleSend`, BEFORE the `dispatchEvent('message-send')` at
   `MessageEditor.ts:458` (that event tombstones the saved draft at `session-manager.ts:765`). Show
   `[data-testid=composer-size-error]`, retain value/attachments. **Anchor fix:** the editor clear
   happens downstream in `AgentInterface.sendMessage` (`src/ui/components/AgentInterface.ts:1490-1491`),
   not in `MessageEditor.handleSend` — returning before `onSend` stops the downstream clear.
9. Author all prerequisite specs FIRST (red on master), then implement steps 1–8.

#### Acceptance criteria
- A prompt issued while not OPEN is queued (≤OUTBOX_MAX) and delivered FIFO after the next `auth_ok`;
  exactly one server copy. The OPEN-socket send path is byte-for-byte unchanged. Only prompt/steer/
  retry are buffered; control frames are not.
- The optimistic bubble (idle case) shows `[data-pending-send]` while queued; the marker clears on
  flush; the DOM key is unchanged.
- `maxPayload === WS_MAX_PAYLOAD_BYTES` strictly greater than `maxAggregateSendBytes` measured against
  the REAL serialized frame; a within-budget multi-image frame is accepted.
- An over-aggregate Send is rejected with `[data-testid=composer-size-error]` WITHOUT firing the
  `'message-send'` draft-cleanup or `onSend`.
- The post-grant replay survives a flap and reaches the server exactly once.

#### Rollback
Each leg independently revertible (S2 outbox; pending bubble; S31 maxPayload; S31 composer guard).
No data/state-file format changes.

---

### WP4 — RC3: Route the three seq-less bypass broadcasts through `emitSessionEvent` (Wave 2)

**Verdict: revise** — fixes the test-first step ordering, the allowlist overclaim, and the
behavioural-test framing.

**Root cause removed.** `auto_retry_pending` (`session-manager.ts:2489`), `auto_retry_cancelled`
(`:2526`), and the force-abort synthetic `agent_end` (`:5731`) are emitted via raw
`broadcast(session.clients, {type:"event", data})` instead of `emitSessionEvent` (the single
`eventBuffer.push()` + seq/ts-stamping path, `:507-523`). So they carry no seq (client compat path
dispatches without advancing `_highestSeq`) and never enter the ring (never replayed on resume) — S5
(resume-loss, stale partial) and S21 (orphaned banner).

#### Step 0 (TEST-FIRST — from review): write the tests and confirm RED on unmodified master
Author `tests/seqless-broadcast-exhaustive.test.ts`, `tests/auto-retry-seqless-routing.test.ts`, and
the `auto-retry-banner.spec.ts` extension FIRST; run on master to confirm RED (3 raw broadcast sites;
`seq===undefined`; `eventBuffer.size===0`; banner stays after snapshot). Only then apply the fixes.

#### Prerequisite red tests
- `tests/seqless-broadcast-exhaustive.test.ts` (NEW). **Review correction to the allowlist:** scope the
  source-walk to `broadcast(session.clients, {type:"event"})` callsites **within
  `src/server/agent/session-manager.ts` only** (NOT `send(...)`, NOT `src/server/` globally). A
  `src/server/`-wide grep would falsely flag `server.ts:2160-2161` (the `BOBBIT_E2E` test-replay
  shim) and `handler.ts:931` (the resume loop, which carries seq). Assert 3 raw broadcast sites on
  master → 0 after the fix; document the two unicast `send()` shims (`handler.ts` on-attach
  compaction_start; `server.ts:2161` test-replay) as out-of-scope.
- `tests/auto-retry-seqless-routing.test.ts` (NEW). **Review correction to framing:** drop the
  `maybeAutoRetryTransient` mixing. RED phase points the assertion at a fake doing the CURRENT raw
  broadcast (`seq===undefined`, eventBuffer untouched); GREEN phase calls the exported
  `emitSessionEvent(fakeSession, event)` and asserts seq is numeric, `eventBuffer.size` increments,
  `since()` replays. The fake session shares ONE `EventBuffer` across the three sub-cases (seqs 1/2/3;
  use `since(prevSeq)` tracking). `emitSessionEvent` IS exported and synchronous (verified).
- `tests/e2e/ui/auto-retry-banner.spec.ts` (EXTEND). Inject `auto_retry_pending` via the window hook;
  drive `remoteAgent.handleServerMessage({type:'messages', data:[…]})` (a snapshot) WITHOUT a preceding
  cancel → assert the banner is GONE. RED on master (snapshot handler never resets `autoRetryPending`).
  **Review guard:** wrap the `page.evaluate` in a try and assert no console error (the real `messages`
  handler runs `initAnnotationStore`, review-doc hydration, per-message emits — confirm `data:[]` does
  not throw; `handleServerMessage` is reachable because TS `private` is erased at runtime).

#### Steps
1. `src/server/agent/session-manager.ts:2489-2492`. `broadcast(...) → emitSessionEvent(session, pendingEvent)`.
2. `src/server/agent/session-manager.ts:2526-2529`. `broadcast(...) → emitSessionEvent(session, cancelledEvent)`.
   Leave the `clients.size > 0` guard as-is (the snapshot reconcile covers the empty-clients orphan;
   do not widen scope).
3. `src/server/agent/session-manager.ts:5731`. `broadcast(...) → emitSessionEvent(session, {type:"agent_end", messages:[]})`.
   Keep the immediately-following `broadcastStatus(session, "idle")` (5732) unchanged and in order
   (`emitSessionEvent`'s push is synchronous, so no new race).
4. `src/app/remote-agent.ts` — inside `case "messages":` snapshot handler, near the streaming clear at
   `:1337`. Add `this._state.autoRetryPending = null;` (server snapshot authoritative for banner
   state; the now-seq'd pending replays AFTER the snapshot if a retry is genuinely pending). Do NOT
   also clear in `case "state"` (partial frames).
5. Author `tests/seqless-broadcast-exhaustive.test.ts` + `tests/auto-retry-seqless-routing.test.ts`
   (finalize step 0).
6. Run all three gates.

#### Acceptance criteria
- Zero raw `broadcast(session.clients, {type:"event", …})` sites remain in
  `src/server/agent/session-manager.ts`; the structural test asserts this (RED on master / GREEN after).
- The three frames each carry a numeric seq, enter the EventBuffer, and replay via `since(fromSeq)`.
- A stale "Retrying…" banner clears on an authoritative `messages` snapshot even with no cancel
  received live.
- Existing live `auto-retry-banner.spec.ts` and `abort-status-e2e.spec.ts` (the `agent_end` matcher)
  stay green — wire envelope unchanged for attached clients.

**dependsOn:** none (the structural test is a source-walk; the routing test drives exported
`emitSessionEvent`; the snapshot-reconcile E2E uses the existing window hook).

#### Rollback
Restore the three raw broadcasts; remove the `autoRetryPending = null` line; delete the new test
files. The wire envelope only gains optional seq/ts the client already tolerates — older client
mid-rollout unaffected.

---

### WP5 — RC4: Seq-recovery re-baseline (S9) + perm-hole retention (S25) (Wave 3)

**Verdict: revise** — fixes the baseline-breaking second EventBuffer test, mandates the benign
seq-holder, and drops the unnecessary WP0 hard-dependency.

**Root cause removed.** S9: the `_pendingEvents` overflow branch (`remote-agent.ts:1418-1425`) sets
`_highestSeq=0` and `_inResumeFallback=true` but leaves `_seqInitialized=true`; the snapshot never
re-baselines `RemoteAgent._highestSeq`, so the next live event re-gap-buffers → permanent stall until
reload. S25: `EventBuffer.pushFrame()` (`event-buffer.ts:41-43`) consumes a perm seq WITHOUT retaining
it → `since(fromSeq)` has a permanent hole → a client resuming across a DENIED/TIMED-OUT permission
gap-buffers behind it forever.

#### Prerequisite red tests
- `tests/event-buffer.test.ts` — modify the `pushFrame stamps a fresh seq+ts but does NOT retain` test
  (lines 209-221) to the post-fix contract (`size===3`, `getAll().map(seq)===[1,2,3]`) and add a
  `since()`-hole-free test (`since(1)===[2,3,4]`). **Review correction (BASELINE-BREAKING):** ALSO
  update the SECOND test at lines 223-233 (`pushFrame seqs are monotonic and consumed even with no
  pushes`), which asserts `buf.size === 0` after three no-arg `pushFrame()` calls — after the fix
  retention is unconditional so size becomes 3. Change `assert.equal(buf.size, 0)` → `3` and add
  `assert.deepEqual(buf.getAll().map(e=>e.seq),[1,2,3])`. Without this the baseline regresses.
- `tests/remote-agent-seq-overflow.spec.ts` (NEW, browser E2E driving the REAL
  `RemoteAgent.handleServerMessage`, sibling to `repro-h3-snapshot-live-interleave.spec.ts`). Force
  overflow (seq 1 baseline, then seqs 3..503 with a gap at 2 → 501 gap-buffered events trip overflow
  on the 501st). Assert `ra._highestSeq===0 && ra._seqInitialized===false` post-fix; deliver seq=504 as
  a `message_end` and assert `ra._state.messages.some(m=>m.id==='m504')` and `ra._pendingEvents.length===0`.
  `await` each `handleServerMessage` call. RED on master.
- `tests/perm-frame-resume-hole.test.ts` (NEW). Build a `buf`; push 1..3; `pushFrame(permPayload)`
  (seq 4, DENY → no respawn); push 5..6; feed `buf.since(3)` into a FakeClient sequencer (copied from
  `perm-frame-late-joiner-seq-gap.test.ts`); assert `gapBuffered===0 && highestSeq===6`. RED on master
  (`since(3)===[5,6]`, 4 missing → client gap-buffers seq 5 forever).
- **Review addition:** an assertion that the since()-resumed retained perm frame does NOT produce a
  spurious permission card or a spurious `_state.messages` row (pins the benign-holder "never paints").

#### Steps
1. `tests/event-buffer.test.ts` — author the red prerequisites (both the 209-221 edit AND the 223-233
   edit). Run → these fail on master.
2. `src/server/agent/event-buffer.ts:41-43`. Make `pushFrame(frame?)` retain a frame-shaped event:
   ```ts
   pushFrame(frame?: unknown): { seq: number; ts: number } {
     const entry: BufferedEvent = { seq: this.nextSeq++, ts: Date.now(), event: frame };
     this.buffer.push(entry);
     if (this.buffer.length > this.maxSize) this.buffer.shift();
     return { seq: entry.seq, ts: entry.ts };
   }
   ```
   Keep the `{seq,ts}` return so the single callsite is source-compatible.
3. `src/server/agent/session-manager.ts:2702` (and the broadcast block at `:2717-2726`). **Review
   correction (DECISIVE — option B, not an open choice):** the resume loop at `handler.ts:931` wraps
   the retained ring entry as `{type:'event', data:entry.event, …}` → on resume it routes into
   `remote-agent.ts` `case "event"` → `handleAgentEvent`, which has NO `tool_permission_needed` case
   and unconditionally `emit`s (verified at `:2001`/`:2444`). So retaining the FULL payload would NEVER
   render the card from the replay (card rendering lives only in the TOP-LEVEL `case
   "tool_permission_needed"` at `:1657`, which the resume loop never reaches) AND would spuriously
   emit. Therefore: retain a BENIGN seq-holder (`{type:'noop'}` — verified no `noop` handler exists, so
   it falls through `emit` harmlessly and never touches `_state.messages`) as the ring entry; keep the
   FULL `tool_permission_needed` payload only on the LIVE broadcast (`:2717`) and on
   `pendingGrantRequest` (for the on-attach `getPendingToolPermission` still-pending replay). The seq
   just needs to EXIST in `since()` to unblock the sequencer; the card for the still-pending case comes
   from the on-attach branch, and the resolved-DENY case correctly shows no card.
4. `tests/perm-frame-resume-hole.test.ts` (NEW) — the S25 end-to-end resume test + the negative-control
   (filtering seq 4 out of `since()` → client gap-buffers).
5. `src/app/remote-agent.ts:1418-1425`. Confirm the S9 spec is red, THEN add `this._seqInitialized = false;`
   in the overflow block so the next seq'd frame re-baselines via the existing first-frame baseline
   (`:1401-1408`). Do NOT touch `resume_gap` (`:1443`) or `_advanceTopLevelSeq` (`:1115`).
6. `tests/remote-agent-seq-overflow.spec.ts` (NEW) — the production-driving S9 spec.
7. `tests/fixtures/remote-agent-seq-dedup.html` (optional hygiene) — add a one-line comment pointing to
   the new overflow spec as the authoritative pin (do NOT rely on the fixture for the overflow
   invariant).
8. Run the full suite; re-verify the EventBuffer eviction-window test ("after 1001 pushes oldest
   retained seq is 2") still holds (pushFrame now counts toward the 1000-cap).

#### Acceptance criteria
- After a forced overflow, `_seqInitialized===false && _highestSeq===0`; the next seq'd frame
  re-baselines and DISPATCHES (lands in `_state.messages`, `_pendingEvents` empty).
- `pushFrame` retains; `since(fromSeq)` is hole-free at the perm seq; a resuming client's
  `gapBuffered===0` and `highestSeq` advances through it.
- The retained holder never renders a card or a `_state.messages` row.
- `perm-frame-late-joiner-seq-gap.test.ts` stays GREEN (pushFrame still one callsite; on-attach still
  uses `getPendingToolPermission`); the EventBuffer eviction test still holds.

**dependsOn:** WP0 downgraded to soft/none (the three tests drive `EventBuffer` and the real
`handleServerMessage` directly; WP0's mock image-echo is a different seam).

#### Rollback
Two single-edit reverts (drop `_seqInitialized = false`; revert `pushFrame` to non-retaining + drop
the `noop` holder arg). Revert the `event-buffer.test.ts` edits. The two legs are independent. Land
S25 (server) and S9 (client) in the same release for a coherent version contract, but either can ship
alone.

---

### WP9 — S8: Wedged-streaming watchdog + faster Stop (Wave 3)

**Verdict: revise** — fixes the missing EventBuffer in the fake session, the heartbeat-scan
registration, the synchronous-throw bug, the missing clear site, and the wire-shape assertion target.

**Root cause removed.** Two S8 legs in `src/server/agent/session-manager.ts`: (1) `forceAbort`
(`:5662`) `await session.rpcClient.abort()` (`:5697`) BEFORE `await settledPromise`, so a wedged abort
RPC (30s `sendCommand` timeout) holds the 3s grace race open → force-kill at ~30s, not 3s. (2) No
watchdog: a wedged `streaming` state is re-broadcast by the 15s heartbeat without bumping
`statusVersion` (clients drop it idempotently) and never acted upon.

#### Prerequisite red tests
- `tests/force-abort-grace-race.test.ts` (NEW). Real `SessionManager`; inject a session with a fake
  `rpcClient` whose `abort()` returns a never-resolving Promise and which never emits `agent_end`;
  call `await manager.forceAbort(id, 50)`; assert it RESOLVES in <500ms and `stop()` was called. RED on
  master (hangs on the un-resolving abort to ~30s).
- `tests/wedged-streaming-watchdog.test.ts` (NEW). Reuse the heartbeat harness. **Review corrections:**
  the fake session MUST include `eventBuffer: new EventBuffer()` (else `emitSessionEvent` throws
  `Cannot read properties of undefined (reading 'push')`); register via
  `manager.addClient(id, makeClient())` (or `manager.sessionsWithConnectedClients.add(session)`) because
  `_emitStatusHeartbeat` iterates ONLY `sessionsWithConnectedClients`, NOT bare `manager.sessions.set()`.
  Cases: A (fires) — `streaming`, old `streamingStartedAt` + old `lastActivity`, connected client →
  assert the client received `{type:'event', data:{type:'streaming_stall_warning', …}}` (**assert on
  the INNER `frame.data.type`, not `frame.type` which is `'event'`**); B (recent activity) — no fire;
  C (idle) — no fire; D (fires at most once across two heartbeats). RED on master (no code path).
- **Review addition:** install a `process` `unhandledRejection`/`uncaughtException` guard in the
  force-abort test to pin the synchronous-throw fix (issue below).

#### Steps
1. Author `tests/force-abort-grace-race.test.ts` (red).
2. `src/server/agent/session-manager.ts:5695-5702`. Stop serialising the abort RPC ahead of the grace
   race. **Review correction (synchronous-throw bug):** `abort()`→`sendCommand` throws SYNCHRONOUSLY
   ('Agent process not running') when there is no stdin (`rpc-bridge.ts:372-374`), and
   `Promise.resolve(session.rpcClient.abort())` evaluates `abort()` BEFORE the wrap, so a sync throw
   escapes `.catch`. Wrap the CALL:
   ```ts
   // Fire graceful abort un-awaited; race it against the grace timer (settledPromise).
   void (async () => { await session.rpcClient.abort(); })().catch(() => {});
   const settled = await settledPromise;
   ```
   Leave the settle listener (`:5681-5693`), the settleTimer, and the force-kill branch (`:5704+`)
   unchanged — a fast/synchronous `agent_end` still returns gracefully without force-kill.
3. `src/server/ws/protocol.ts:24` (after `AutoRetryCancelledEvent`). Add `StreamingStallWarningEvent`
   `{ type:"streaming_stall_warning"; stalledForMs:number; surfacedAt:number }`.
4. `src/server/agent/session-manager.ts` (SessionInfo near `:252`; constant near `:647`). Add
   `streamingStallSurfacedAt?: number` and `static STREAMING_STALL_THRESHOLD_MS = 120_000`.
5. Wherever `session.streamingStartedAt = undefined` is set — `:2295` (agent_end), `:2376`
   (process_exit→'terminated') — also clear `session.streamingStallSurfacedAt = undefined`. **Review
   addition:** also clear it (and ideally `streamingStartedAt`) at the force-kill branch (~`:5732`),
   which broadcasts the synthetic `agent_end`+idle but never routes through `handleAgentLifecycle`, so
   the `:2295` clear never runs there.
6. `src/server/agent/session-manager.ts:818-833` (inside the `_emitStatusHeartbeat` loop, after the
   `broadcast(... session_status ...)`). Add the watchdog check gated on `status==='streaming'`,
   `!streamingStallSurfacedAt`, and `Date.now() - (lastActivity ?? streamingStartedAt) > THRESHOLD` →
   `this._handleStreamingStall(session)`.
7. `src/server/agent/session-manager.ts` (new private method). `_handleStreamingStall` sets
   `streamingStallSurfacedAt`, logs a warn, and emits via `emitSessionEvent(session, warn)` (seq-
   stamped + replayed — avoids the S5-class seq-less orphan). **Default policy: surface only** (non-
   destructive). Auto-recover (`this.forceAbort(session.id)`) is a one-line swap behind the same
   method if the product owner chooses it.
8. `src/app/remote-agent.ts:2017-2040` (handleAgentEvent switch — ONLY if surface-affordance chosen).
   Add a `case 'streaming_stall_warning'` setting `_state.streamingStall`; clear it in `agent_start`/
   `agent_end`. Render a non-blocking banner with the existing Stop + a `restart_agent` affordance.
9. `tests/e2e/ui/streaming-stall-affordance.spec.ts` (NEW — only if surface-affordance chosen). Per
   AGENTS.md, a browser E2E covering the banner appears, Stop clears it, and it clears on a subsequent
   `agent_start`.

#### Acceptance criteria
- `forceAbort` with a never-resolving `abort()` force-kills (`stop()`) at `gracePeriodMs` (3s), not at
  30s; a fast `agent_end` still returns gracefully. No unhandled rejection from the un-awaited abort.
- The watchdog fires `_handleStreamingStall` exactly once per streaming turn past threshold; never for
  recent-activity or non-streaming sessions; the signal travels through `emitSessionEvent`.
- `streamingStallSurfacedAt` is cleared at every `streamingStartedAt` clear AND at the force-kill
  branch.
- No pinned invariant regresses (status single-writer monotonicity, heartbeat statusVersion-not-
  bumped, `abort-status-e2e.spec.ts`).

#### Rollback
Revert step 2 (restore the serial await); remove steps 4–8. No data migration (`streamingStallSurfacedAt`
is in-memory only).

---

### WP6 — RC7: Respawn continuation flag (S16 + S38) (Wave 3)

**Verdict: revise** — the review found a LOAD-BEARING defect: suppressing the continuation prompt AND
gating the client replay to the transition-only would leave the granted tool with NO driver (because
`switch_session` does not auto-continue). **The plan adopts review-option (i):** keep the server
continuation prompt for the GRANT path (do not suppress there); suppress only for `restartAgent` and
role-switch, where the user is not mid-tool.

**Root cause removed.** S16: `restoreSession` (`session-manager.ts:3499-3509`) unconditionally
re-prompts `[SYSTEM: …continue where you left off…]` when persisted `ps.wasStreaming===true`. This
fires for deliberate in-place respawns too because `wasStreaming` is still true at respawn (the guard
long-poll pauses the turn before `agent_end`). S38: `_maybeReplayGrant` is called from BOTH the
idempotent heartbeat branch (`remote-agent.ts:1461`) and the genuine transition branch (`:1491`); a
routine 15s heartbeat mints a redundant second prompt.

#### Scope decision (from review issue #1)
- **GRANT respawn (`_restartSessionWithUpdatedRole`):** do NOT suppress the continuation prompt. The
  server continuation prompt remains the robust driver of the now-granted tool (`switch_session` only
  replays history; it does not auto-continue — verified: `restoreSession` issues `switch_session` and
  the agent goes idle). Suppressing it AND restricting the client replay would strand the grant on a
  dropped transition frame.
- **`restartAgent` and role-switch (non-grant):** suppress the continuation prompt (the user is not
  mid-tool; the agent resumes via its own session file).
- **S38:** still drop the heartbeat-branch replay (it is a redundant SECOND prompt for the grant,
  which the server already drives). The transition-branch replay remains as belt-and-suspenders.

#### Prerequisite red tests
- `tests/respawn-suppresses-continuation-prompt.test.ts` (NEW) — template
  `tests/sandbox-recovery-respawn-helper.test.ts`. Behaviour (shim): FakeManager.restoreSession mirrors
  `if (ps.wasStreaming && !ps._suppressContinuationPrompt) prompts.push(CONTINUE)`. (A) `restartAgent`
  respawn with the flag → prompts 0; (B) direct restore with `wasStreaming:true` no flag → prompts 1
  (genuine boot restore preserved); (C) cleanup → flag deleted in finally. SOURCE-PIN: assert the
  `if (ps.wasStreaming` line is followed by `&& !(ps as any)._suppressContinuationPrompt`; assert the
  suppressed branch still clears `wasStreaming`. **Review correction:** there are only TWO mutatePs
  call sites — `restartAgent` (`:2855`) and `_restartSessionWithUpdatedRole` (`:2758`). The grant path
  reaches the flag THROUGH `_restartSessionWithUpdatedRole`; do NOT hunt for a third edit site in
  `grantToolPermission`. **Scope to this WP:** only `restartAgent` and role-switch set the flag (NOT
  the grant path — see scope decision). Negative source-pin: `recoverSandboxSessions` does NOT set it.
- `tests/fixtures/remote-agent-status.html` (EDIT) + `tests/remote-agent-status.spec.ts`. Mirror BOTH
  current `_maybeReplayGrant` calls, then assert heartbeat does NOT replay and transition DOES.
- `tests/remote-agent-status-source.test.ts` (NEW, node:test). Assert the REAL `case "session_status"`
  idempotent sub-branch does NOT contain `_maybeReplayGrant` and the full block contains exactly one
  call.
- **Review addition:** a test for the dropped/missed idle-transition scenario — deliver the grant, drop
  the transition frame, deliver only a heartbeat → assert the grant is NOT permanently stranded
  (because the server continuation prompt drives it for the grant path under review-option (i)). And a
  test that the granted tool is actually re-driven after a grant respawn once the WP6 gating is applied
  (this likely needs WP0 mock fidelity — the mock-agent E2Es self-complete the tool via an independent
  HTTP long-poll, `mock-agent-core.mjs:1315`, so they cannot express it; mark acceptance #7 as
  lower-confidence/WP0-gated if the faithful test is not yet available).

#### Steps
1. Author `tests/respawn-suppresses-continuation-prompt.test.ts` (red).
2. `src/server/agent/session-manager.ts:3499-3509`. Gate the continuation re-prompt:
   ```ts
   const suppressContinuation = (ps as any)._suppressContinuationPrompt === true;
   if (ps.wasStreaming && !suppressContinuation) { /* existing body */ }
   else if (ps.wasStreaming && suppressContinuation) { restoreStore.update(ps.id, { wasStreaming: false }); }
   ```
   The `else if` clears persisted `wasStreaming` even when suppressed so a later genuine boot restore
   does not mis-fire.
3. `src/server/agent/session-manager.ts:2826-2827` (the `_respawnAgentInPlace` finally). Add
   `delete (ps as any)._suppressContinuationPrompt;` alongside the existing `_restartFrameOfReference`/
   `_overrideAllowedTools` deletes (transient — never leaks to disk).
4. `src/server/agent/session-manager.ts:2855` (`restartAgent` mutatePs). Add
   `(p as any)._suppressContinuationPrompt = true;`.
5. `src/server/agent/session-manager.ts:2758` (`_restartSessionWithUpdatedRole` mutatePs). **Per the
   scope decision, set the flag ONLY for the role-switch invocation, NOT the grant path.** If
   `_restartSessionWithUpdatedRole` is shared between role-switch and grant, branch on the caller (pass
   an explicit `suppressContinuation` arg from the role-switch caller and leave the grant caller
   passing false) so the grant keeps the server continuation prompt as its driver.
6. `src/server/agent/session-manager.ts` (`recoverSandboxSessions`, `restoreOneSession` boot,
   `ensureSessionAlive`). Do NOT set the flag — genuine interruptions keep the continuation prompt. Add
   a one-line comment at each suppressing caller explaining why these do not.
7. Finalize the source-pins (gate + suppressed-branch clear + the two suppressing callers + the
   negative `recoverSandboxSessions` pin).
8. `tests/fixtures/remote-agent-status.html` (EDIT). Mirror both `_maybeReplayGrant` calls; add the
   heartbeat-no-replay / transition-replay case; RED; then remove the idempotent-branch call; GREEN.
9. `src/app/remote-agent.ts:1460-1464`. Remove the heartbeat-branch `_maybeReplayGrant(msg.status)`
   call; keep `onStatusChange?.(msg.status)`. **Review correction:** rewrite the doc comment at
   `:1150-1165` (which currently documents the heartbeat replay as the missed-transition self-heal) to
   state that grant-replay is gated to the genuine idle transition and that the GRANT path's robust
   driver is the server continuation prompt (review-option (i)), so a dropped transition cannot strand
   the grant.
10. `tests/remote-agent-status-source.test.ts` (NEW) — the source-pin.
11. Run the full baseline.

#### Acceptance criteria
- After `restart_agent` / role-switch respawn, no `[SYSTEM: …continue…]` bubble. After a tool-permission
  GRANT, the server continuation prompt still drives the tool (no client double-prompt because the
  heartbeat replay is removed).
- Genuine boot restore and Docker container recovery STILL inject the continuation prompt when
  `wasStreaming` was true (no-flag default).
- A suppressed respawn clears persisted `wasStreaming:false`; the transient flag is deleted in finally.
- Client grant-replay fires only on a genuine idle transition; a dropped transition does not strand the
  grant (server drives it).
- Existing pins (`restart-preserves-streaming-frame.test.ts`, `sandbox-recovery-*`,
  `remote-agent-status.spec.ts`, `tool-ask-policy.spec.ts`, `mcp-tool-permission.spec.ts`) stay green.

#### Rollback
S16: revert the `:3499` gate + the two mutatePs flag sets + the finally delete; delete the new test.
S38: restore the idempotent-branch `_maybeReplayGrant`; revert the fixture; delete the source-pin. No
data migration (the flag is an in-memory transient on `ps`).

---

### WP7 — RC6: Payload slimming (S19, S20, S31-threshold) (Wave 4)

**Verdict: revise** — fixes the test-first violation for the remote-send strip (extract a pure helper),
the field-name confusion in the projection sketch, and adds the missing pins.

**Root cause removed.** Full-base64 payloads are carried/re-serialized/re-broadcast/persisted where
only metadata is needed. S19: `broadcastQueue` (`session-manager.ts:1688-1695`) broadcasts and persists
`promptQueue.toArray()` (full `images[].data` + `attachments[].content`/`preview`) on every mutation —
the synchronous un-debounced WS broadcast is the load-bearing leak (the persist is debounced ~1×/sec).
S20: `RemoteAgent.prompt()` (`remote-agent.ts:879-884`) ships full document `content` that
`dispatchDirectPrompt` never reads (documents never reach the model). S31-threshold: each image rides
the frame ~3×, inflating toward the 100 MiB cap.

#### Prerequisite red tests
- `tests/prompt-queue.spec.ts` — `toBroadcastArray()` strips `images[].data`/`attachments[].content`/
  `attachments[].preview` (keeping metadata); `toArray()` keeps full `images[].data`.
- `tests/payload-slimming.test.ts` (NEW). `broadcastQueue` projects: the `queue_update` frame and the
  persisted `messageQueue` carry no image data / attachment content / preview, while the in-memory
  `promptQueue` still re-dispatches the full image to `rpcClient.prompt`.
- `tests/e2e/queue-e2e.spec.ts` (EXTEND). Queue an image prompt while STAY_BUSY; assert the
  `queue_update` row has no image data. (The "agent receives the image on drain" half asserts via the
  captured prompt command image arg using the in-process mock bridge.)
- **Review correction (test-first violation):** `RemoteAgent` is browser-only and NOT Node-unit-
  instantiable. Do NOT write `tests/remote-agent-prompt-send.spec.ts` as a Node stub. Instead **extract
  a pure exported helper** `stripAttachmentsForWire(attachments)` in `attachment-utils.ts` and unit-test
  it in Node (RED on master: helper absent / document content present). `remote-agent.ts:879-884` then
  calls the helper, so the behaviour change is gated by a faithful red→green pure-function test.
- **Review additions:** a real-`SessionManager` pin (template `session-manager-direct-prompt-lifecycle.test.ts`)
  that `rpcClient.prompt` receives `images[0].data === original` on drain (guards an over-eager future
  strip of images from `toArray()`); a negative pin that the ingestion strip (step 5) does NOT strip
  `msg.images` (feed attachments WITH content AND images with data → `toArray()[0].attachments[0].content`
  undefined AND `toArray()[0].images[0].data` original).

#### Steps
1. `src/server/ws/protocol.ts:27-34` (doc) + `src/server/agent/queue-projection.ts` (NEW). Export pure
   `projectQueueForBroadcast(rows)` (strip `images[].data` AND `attachments[].content`/`preview`),
   `projectQueueForPersist(rows)` (strip only `attachments[].content`/`preview`, KEEP `images[].data`),
   and `stripAttachmentBytes(atts)`. **Review correction (data-model):** `Attachment` stores base64 in
   `content` (and a duplicate `preview`); there is NO `data` field on attachment objects — `images[].data`
   is a SEPARATE top-level `QueuedMessage` field. The attachments projector is simply
   `attachments?.map(a => { const {content, preview, ...rest} = a; return rest; })` (drop the dead
   `rest : rest` ternary).
2. `src/server/agent/prompt-queue.ts:102-105`. Add `toBroadcastArray()` / `toPersistArray()` delegating
   to the helpers; leave `toArray()` (the authoritative in-memory copy) untouched.
3. `src/server/agent/session-manager.ts:1688-1695` (`broadcastQueue`). Broadcast
   `session.promptQueue.toBroadcastArray()`; persist `…toPersistArray()`.
4. `src/ui/utils/attachment-utils.ts` — add `stripAttachmentsForWire(attachments)` (metadata +
   `extractedText`, no document `content`/`preview`; images keep nothing here because their bytes ride
   `images[].data`). `src/app/remote-agent.ts:879-884` builds `slimAttachments = stripAttachmentsForWire(attachments)`
   and sends `{type:'prompt', text, images?, attachments: slimAttachments}`. Leave
   `this._pendingAttachments = attachments` (`:847`) and the optimistic row (`:870`) UNCHANGED (local
   rendering uses the full objects, never the wire frame).
5. `src/server/ws/handler.ts:581-586` + `src/server/agent/session-manager.ts:1764/1811`. Defensive
   ingestion strip: project `msg.attachments` through `stripAttachmentBytes` before `enqueuePrompt`; do
   NOT touch `msg.images`.
6. (GATED by UX decision — see §4) `src/app/remote-agent.ts:879-884`. If chosen: append document
   `extractedText` to the model-facing `text` (`[Document: <name>]\n<extractedText>`, mirroring
   `convertAttachments` `Messages.ts:676-679`); keep the optimistic bubble showing the user's verbatim
   text. **Default for the WP7 PR: deferred** (pure slimming, zero model-behaviour change).
7. `tests/e2e/queue-e2e.spec.ts` (EXTEND) + `tests/payload-slimming.test.ts` (incl. the restart-
   persistence assertion: reload from persisted `messageQueue` → `images[].data` survived,
   `attachments[].content` did not).

#### Acceptance criteria
- `queue_update` frames carry NO `images[].data`/`attachments[].content`/`preview` — only metadata.
- Persisted `messageQueue` retains `images[].data` (queued image re-dispatches after restart) but no
  `attachments[].content`/`preview`.
- In-memory `promptQueue.toArray()` still carries full `images[].data`; drain re-dispatches the original
  bytes.
- `RemoteAgent.prompt()` WS frame carries no document base64 `content` (via the pure helper); image
  bytes travel once; local optimistic tile rendering unchanged.
- The defensive ingestion strip spares `msg.images`.

#### Rollback
Revert `broadcastQueue` to `toArray()`; revert `remote-agent.ts` to send full `attachments`; revert the
ingestion strip; delete `queue-projection.ts` + `stripAttachmentsForWire` + the two PromptQueue methods.
Persisted rows lacking stripped fields are forward-compatible. The extractedText injection (step 6) is
independently revertible.

---

### WP8 — RC8: Hot-path + decoder correctness/perf (S14, S32, S34, S35, S37) (Wave 4)

**Verdict: revise** — narrows the S34 seam to the burst caller only (the broad rAF change risks
flaking the most-asserted scroll specs), fixes the S37 comment/test to assert throw-equivalence, and
spells out the S34 fixture seeding.

**Root cause removed.** Five independent hot-path/decode defects (no shared state): S14 per-chunk
`chunk.toString('utf-8')` corrupts a multibyte char split across stdout reads (`rpc-bridge.ts:300`,
stderr `:306`); S32 per-delta proposal scans build 5 fresh RegExps with no precheck/throttle
(`remote-agent.ts:2107-2112`); S34 per-event `getBoundingClientRect` loop over every `<user-message>`
(`AgentInterface.ts:671-684` via `:722-734`); S35 synchronous chunked base64 blocks the main thread
(`attachment-utils.ts:88-95`); S37 the `!node -e` x-opencode-session header forks a subprocess per LLM
round-trip (`aigw-manager.ts:387-390`).

#### Prerequisite red tests
- `tests/rpc-bridge-utf8-split.test.ts` (NEW). Spawn a real `RpcBridge` against a stub CLI whose
  handler writes one event line in TWO `process.stdout.write()` calls splitting a 3-byte CJK and a
  4-byte emoji across the byte boundary; assert the captured text equals the original (no U+FFFD). RED
  on master. **Review addition:** a stderr-tail variant pinning the `:306` decoder edit too.
- `tests/proposal-scan-precheck.test.ts` (NEW). Import the new `textHasProposalTag` from
  `proposal-parsers.ts`; assert false on plain prose, true for each of the 5 tags. **Review addition:**
  a direct unit assertion that `_checkProposals` builds zero RegExps / runs no proposal callback on a
  long prose delta (pin the early-return wiring independently of the perf E2E).
- `tests/e2e/ui/streaming-hotpath-perf.spec.ts` (NEW). **Review correction (fixture seeding):** spell
  out the seed mechanism — push ~200 user `message_end` events through the fixture `emit()` (or set
  `FixtureSession.state.messages` and force a render) to create 200 finalized `<user-message>` rows;
  install a `getBoundingClientRect` counter via `page.evaluate` before the burst; emit 50
  `message_update`s; assert bounded sweep count. Depends on WP0's id-less-delta mock knob.
- `tests/attachment-base64-async.test.ts` (NEW). Import the new async `arrayBufferToBase64`; assert
  byte-correctness vs a reference and that it yields (a `setTimeout(0)` scheduled before the await fires
  before resolution) on a >1MB input. RED (symbol absent).
- `tests/aigw-no-subprocess-header.test.ts` (NEW). **Review correction:** assert the emitted header
  literal is `${BOBBIT_SESSION_ID}` (`isCommandConfigValue===false`), resolving it forks ZERO
  subprocesses, AND assert the REQUEST-path resolver behaviour: `resolveConfigValueOrThrow('${BOBBIT_SESSION_ID}','x')`
  THROWS when unset and returns the id when set (the request path THROWS on unset for BOTH the old `!cmd`
  and new template forms — `BOBBIT_SESSION_ID` is always set for real sessions). Do NOT assert "header
  dropped when unset" on the request path.

#### Steps
1. Author `tests/rpc-bridge-utf8-split.test.ts` (red).
2. `src/server/agent/rpc-bridge.ts:1` + `:142-144` + `:298-311`. Add
   `import { StringDecoder } from "node:string_decoder";`; add `_stdoutDecoder`/`_stderrDecoder` fields;
   replace `chunk.toString("utf-8")` at `:300` with `this._stdoutDecoder.write(chunk)` and at `:306`
   with `this._stderrDecoder.write(chunk)`; flush `decoder.end()` on exit/stop; re-create the decoders
   at the top of `_attachProcessHandlers` so a respawn starts clean. `handleData` untouched.
3. Author `tests/proposal-scan-precheck.test.ts` (red).
4. `src/app/proposal-parsers.ts:46` + `src/app/remote-agent.ts:1797-1818`. Export `textHasProposalTag(text)`
   (indexOf precheck over `<${tag}>` for all 5 tags) and `proposalRegexFor(tag)` (cached compiled
   RegExp, `lastIndex=0`). In `_checkProposals` add `if (!textHasProposalTag(text)) return;` after
   computing `text`, and replace the per-iteration `new RegExp(...)` with `proposalRegexFor(parser.tag)`.
5. **(OPTIONAL, default OFF — UX decision)** `src/app/remote-agent.ts:2099-2112`. Throttle the streaming
   scans (~200ms) only if the perf E2E still shows cost after the precheck. Default: no throttle (avoid
   preview-latency regression).
6. Author `tests/e2e/ui/streaming-hotpath-perf.spec.ts` (red; depends on WP0).
7. `src/ui/components/AgentInterface.ts` (`_updateAndPin`'s jump-button call at `:732`). **Review
   correction (minimal seam):** rAF-coalesce ONLY the burst caller, NOT the shared `_refreshJumpButton`
   wrapper (which has 11 callers, including the most-asserted scroll handler at `:1197`/`:1206`). Insert
   the rAF guard inside `_updateAndPin()` (or guard the wrapper so scroll/geometry sites bypass it) so
   the burst collapses to one geometry recompute per frame while `_handleScroll`'s recompute and the two
   known geometry sites (`setAutoScroll` `:502`, post-collapse `:834`) stay synchronous. Cancel the rAF
   in `disconnectedCallback`.
8. **(OPTIONAL, staged)** `src/ui/components/AgentInterface.ts:671-684`. Only if the perf E2E still shows
   the N-node loop dominating after rAF coalescing: replace the per-node `getBoundingClientRect` loop
   with an `IntersectionObserver` maintaining above/below counts.
9. Author `tests/attachment-base64-async.test.ts` (red).
10. `src/ui/utils/attachment-utils.ts:87-95`. Extract `export async function arrayBufferToBase64(buf)`
    that chunks at `0x8000` and `await`s a `setTimeout(0)` every ~1MB; replace the inline encode in
    `loadAttachment` with `await arrayBufferToBase64(arrayBuffer)`. Output bytes identical; all callers
    already await `loadAttachment`.
11. Author `tests/aigw-no-subprocess-header.test.ts` (red, with the throw-equivalence assertion).
12. `src/server/agent/aigw-manager.ts:381-390`. Replace the header literal with `"${BOBBIT_SESSION_ID}"`
    and fix the comment to state the truth (set → resolves with zero subprocess; unset → THROWS on the
    request path, same as `!cmd`; `BOBBIT_SESSION_ID` is always set for real sessions). UPDATE the two
    existing literal-pinning tests (`tests/aigw-headers.test.ts`, `tests/aigw-header-resolver.test.ts`)
    to the new invariant (the invariant CHANGED — no longer a shell command).
13. Run `npm run check && npm run test:unit && npm run test:e2e`.

#### Acceptance criteria
- S14: a 3-byte CJK and 4-byte emoji split across two stdout reads reassemble with zero U+FFFD; the
  stderr-tail variant passes; `rpc-bridge-lifecycle.test.ts` unaffected.
- S32: `textHasProposalTag` short-circuits plain prose (zero RegExps); matched-proposal behaviour
  byte-identical; proposal e2e stay green.
- S34: a 50-delta burst over 200 rows triggers an order-of-magnitude fewer `getBoundingClientRect`
  sweeps; ALL scroll/jump specs (`jump-to-last-prompt`, `chat-scroll`, `follow-tail`,
  `collapse-scroll-bugs`, `tail-chat-user-scroll-up`, `agent-interface-scroll`) stay green within the
  existing `settleFrames(2)` budget.
- S35: `arrayBufferToBase64` byte-correct and yields ≥ once on >1MB.
- S37: header literal is `${BOBBIT_SESSION_ID}`; resolving forks zero subprocesses; the request-path
  resolver throws-on-unset / returns-id-on-set equivalence to `!cmd` is pinned; the two aigw tests
  updated and green.

#### Rollback
Each seam is an independent self-contained revert behind its own test. Commit each seam separately so
`git revert <sha>` is surgical. No migrations.

---

### WP10 — Standalone low-risk fixes (S3, S26, S33, S36, S39, S40, S42, S43) (Wave 4)

**Verdict: revise** — the review found S39 as written BREAKS pinned `defer-offscreen-render.spec.ts`
assertions and defeats the perf feature; S39 is **removed from this package and re-scoped** as its own
staged change. S36 extraction is spelled out; S33 symmetry and clear-site are pinned; the S26 file
split and S43 spy approach are corrected.

**Root cause removed.** Eight independent localized gaps (02-analysis §5 "lower-risk standalone").

#### S3 — IME guard
- Red: `tests/message-editor-ime.html` + `…-entry.ts` + `…-bundle.js` + `tests/message-editor-ime.spec.ts`
  (NEW). **Review correction:** bundle the REAL `MessageEditor` (mirror
  `streaming-message-container-set-message.spec.ts`), NOT the hand-copy `message-editor-send.html`.
  Cases: composing Enter (`isComposing:true`) → 0 sends; `keyCode:229` → 0 sends; plain Enter → exactly
  1 send.
- Fix: `src/ui/components/MessageEditor.ts:338` (top of `handleKeyDown`, before the slash-menu block):
  `if (e.isComposing || e.keyCode === 229) return;` (covers both the Enter-to-send at `:362` and the
  slash-menu Enter at `:349`).

#### S26 — steered images
- Red: `tests/rpc-bridge-steer-images.test.ts` (NEW) — `RpcBridge.steer(text, images)` writes
  `images` on the steer RPC. `tests/session-manager-steer-images.test.ts` (NEW, real `SessionManager`)
  — live steer forwards images; a batched steer drains the UNION; a rollback re-enqueues with images.
- Fix: `src/server/agent/rpc-bridge.ts:399` (+ interface `:83`) add the `images?` param;
  `tests/e2e/mock-agent-core.mjs` steer ECHO handler forwards images (**review file-split correction:**
  the mock steer is in `in-process-mock-bridge.mjs:94-96` but the ECHO handler at `:1810-1832` lives in
  `tests/e2e/mock-agent-core.mjs`); `session-manager.ts:1939` (`_dispatchSteer`)
  `steer(batchText, rows.flatMap(r => r.images ?? []))`; `:1948-1949` rollback
  `enqueueAtFront(r.text, { images: r.images, isSteered: true })`; `:2107-2109` (drainQueue batch)
  `images: steered.flatMap(m => m.images ?? [])`.

#### S40 — cancel auto-retry in forceAbort
- Red: `tests/session-manager-forceabort-autoretry.test.ts` (NEW, real `SessionManager` + mock timers)
  — `forceAbort` on an idle-in-backoff session cancels the pending timer; the timer never dispatches
  `retryLastPrompt`. (This flips the WP0 characterization test.)
- Fix: `src/server/agent/session-manager.ts:2513-2516` add `'aborted'` to the cancel reason union;
  `:5662-5667` call `this.cancelPendingAutoRetry(session, 'aborted')` BEFORE the `status!=='streaming'`
  early-return. **Review note:** step 8 (the cancel) is the actual S40 fix; the defence-in-depth fire
  guard (`if (!session.lastTurnErrored) return` at `:2499`) is harmless belt-and-suspenders that does
  NOT itself close the team-abort trigger (the early-return path never clears `lastTurnErrored`) — label
  it as such so reviewers don't think the guard alone suffices.

#### S36 — shared overflow guard
- Red: assert the handler broadcast path defers/terminates on a high-`bufferedAmount` client AND
  (review addition) that the extracted helper preserves the session-manager `cpuDiagnostics`-branch
  behaviour (records under `'session-manager:broadcast'` with the guard intact).
- Fix: `src/server/ws/ws-broadcast.ts` (NEW) `export function guardedBroadcast(clients, msg, opts)`.
  **Review correction (extraction completeness):** the helper must own the two module-private WeakSets
  (`_pendingOverflowCheck`, `_warnedClients`), take the `cpuDiagnostics` label as a param (or keep the
  `recordWsBroadcast` call at the call site), and cover BOTH the diag and non-diag branches of each
  `broadcast()`. Stage: extract with `session-manager.broadcast` behaviourally unchanged (pinned by
  `ws-overflow-guard.test.ts`), then point `handler.ts:178` at it. (Migrating the other two fanout
  paths — `client_joined` loop, `server.ts:1331` `broadcastToSession` — is a follow-up.)

#### S42 — multiset steer dedup
- Red: `tests/session-manager-getmessages-splice.test.ts` (EXTEND) — two identical-text steers splice
  as two distinct rows (length 3). RED on master (Set collapses → 2).
- Fix: `src/server/agent/splice-inflight-message.ts:94-120` — replace the `Set` with a per-text count
  map, decrementing one match per present snapshot row (mirrors the reducer's `serverPlainTextCounts`).

#### S43 — removeAllListeners before kill
- Red: `tests/rpc-bridge-lifecycle.test.ts` (EXTEND). **Review correction:** make
  `spy on ChildProcess.prototype.removeAllListeners` the PRIMARY assertion (the pre-null child capture
  is awkward against the real-spawn harness).
- Fix: `src/server/agent/rpc-bridge.ts:242` — `this.process?.removeAllListeners();` before
  `this.process?.kill();` in the spawn-retry catch.

#### S33 — trailing-edge flush
- Red: `tests/remote-agent-truncated-flush.spec.ts` (NEW) — the final throttled truncated update is
  applied to `_state.streamingMessage` after the window; **review addition:** an explicit assertion
  that no late `streamingMessage` mutation occurs after `message_end` clears the flush timer.
- Fix: `src/app/remote-agent.ts:389-390` add `_truncatedFlushTimer`; `:2099-2105` stash the latest
  update and schedule a trailing flush (clear the prior timer on a newer update; clear on `message_end`
  and on reset/disconnect). **Review note:** emit the same wrapped shape `{...event, message: pending}`
  as the live path (`:2444`) for subscriber symmetry, not a stripped synthetic event.

#### S39 — REMOVED from WP10 (re-scoped)
The proposed `content-visibility:auto` on the full template (a) breaks `defer-offscreen-render.spec.ts`
placeholder-count assertions (lines 74-75, 99, 105, 116, 155-156, 168-169 assert
`.deferred-block-placeholder` present and `[data-real-content]` absent before intersection) and (b)
reintroduces the per-off-screen-block Lit/DOM construction the feature exists to avoid (content-
visibility defers paint, not template instantiation). **S39 is NOT a low-risk additive change.** It is
deferred to its own staged package that: keeps the empty placeholder for the IntersectionObserver/perf
path; exposes text to a11y via an `sr-only` text-only copy (the analysis's own option 3, 02-analysis
S39 fix); removes `aria-hidden` from the text-bearing node; updates the placeholder-count pins
deliberately; and adds BOTH a textContent-presence assertion AND a paint-cost assertion proving no
per-block DOM construction regression.

#### Acceptance criteria
- `npm run check` clean; `test:unit` (≥1237 + new) and `test:e2e` (≥1078 + new) green.
- S3 composing Enter does not send; normal Enter sends once. S26 live/batched/rollback all carry
  images. S40 `forceAbort` cancels the timer and the timer never dispatches after a force-abort. S36
  the handler broadcast goes through the guarded helper (diag + non-diag), `ws-overflow-guard.test.ts`
  green. S42 two identical-text steers splice as two rows. S43 the dead child has zero residual
  listeners. S33 the final throttled update is applied at the trailing edge with no stale post-finalize
  mutation.
- S39 is explicitly out of scope (re-scoped to its own staged package).

#### Rollback
Each item is independent and revertible in isolation; delete its new test file. S36 is the only
multi-file change — revert by pointing `handler.ts:178` back at its inline loop and deleting the
extracted helper. No migrations.

---

### WP11 — Flaky-test root-cause + search-flush teardown ENOENT (Wave 5)

**Verdict: revise** — fixes the wrong hash source (step 7), the step-3 in-place client-flag breakage,
the false SIGTERM-timeout mitigation, and the floating-promise on the project-deletion path.

**Root cause removed.** Four independent deterministic races (no quarantine — the project forbids it):
(1) the `[search] flex flush` ENOENT on close is a teardown-ordering bug (`flex-store.ts:483`):
`shutdown()` → `closeAll()` is SYNC and `ProjectContext.close()` does `void this.searchIndex.close()`
(fire-and-forget), so the orphaned flush rename races the harness `awaitableRm`; (2)
`pre-compaction-history.spec.ts` — a `getState()` after the test's `agentSessionFile` override reverts
it; (3) `project-assistant-saved-state.spec.ts` — a client-only `markAccepted` + double-rAF race; (4)
`dynamic-chat-tabs.spec.ts` — a `contentHash` settling race.

#### Prerequisite red tests
- `tests/search/flex-store.spec.ts` — close() resolves only after the final rename; a flush losing its
  dir mid-write surfaces (not silently swallowed).
- `tests/project-context-close.spec.ts` (NEW) — `close()`/`closeAll()` return an awaitable that
  resolves only after the search flush; **review addition:** a case that `remove(projectId)` (the
  project-deletion path) also awaits the flush.
- `tests/e2e/ui/pre-compaction-history.spec.ts` — the seeded `agentSessionFile` override survives a
  forced `getState()` (assert `probeJson.total===3` after forcing one).
- `tests/e2e/ui/project-assistant-saved-state.spec.ts` — every reliance on the "Changes Saved" heading
  is gated on a SERVER-authoritative draft poll (`accepted===true`).
- `tests/e2e/ui/dynamic-chat-tabs.spec.ts` — the historical v3 card collapses to the live tab with zero
  remount POSTs, **sampling the contentHash from the field production actually reads**.

#### Steps
1. `src/server/agent/project-context.ts:147-152`. `close(): void` → `async close(): Promise<void>` and
   `await this.searchIndex.close()` (drop the fire-and-forget comment).
2. `src/server/agent/project-context-manager.ts:321-327`. `closeAll(): Promise<void>` →
   `await Promise.allSettled([...].map(ctx => ctx.close()))`. **Review correction (floating promise):**
   ALSO make `remove(projectId)` (`:333`, the DELETE `/api/projects/:id` path) async and
   `await ctx.close()`, and await/void it at `server.ts:2832` — otherwise the project-deletion path
   re-introduces the fire-and-forget.
3. `src/server/server.ts:1777-1782` (`shutdown()`). `await projectContextManager.closeAll();` before
   sandbox/network teardown. **Review correction (false mitigation):** the `cli.ts:265-272` SIGTERM
   handler has NO timeout. Either add `Promise.race([gateway.shutdown(), timeout(Ns)])` in
   `cli.ts`, or rely solely on the bounded-I/O argument (atomic tmp+rename, `_closed` prevents new
   flushes, small corpus) — do not claim a mitigation that does not exist.
4. `src/server/agent/session-manager.ts` (near `:4262`). Add a module-level
   `__pinnedAgentSessionFiles` Map + exported `__pinAgentSessionFile`/`__clearPinnedAgentSessionFile`;
   guard the `update({agentSessionFile})` at `:4262` (and the parallel `:4644`/`:5714` if they write
   it) with the pinned value (production never calls `__pin*`, so behaviour is unchanged).
5. `tests/e2e/ui/pre-compaction-history.spec.ts:143-150`/`:206-213`. After each `store.update`, call
   `(gateway.sessionManager as any).__pinAgentSessionFile?.(sessionId, dedicatedJsonl)`; add a
   prerequisite assertion that forces a `getState()` before the probe and asserts `total===3`.
6. `tests/e2e/ui/project-assistant-saved-state.spec.ts`. Before every "Changes Saved" reliance, add an
   `expect.poll` on `GET /api/sessions/:id/draft?type=project` asserting `accepted===true`. **Review
   correction (in-place step-3 breakage):** KEEP `markAccepted`'s client-state mutation (the heading
   reads `state.projectProposalAcceptedBySessionId`, hydrated from the draft ONLY on reload via
   `session-manager.ts:578-579`; a server-only PUT never sets the client flag for the no-reload step 3).
   Add the server poll ALONGSIDE, or use the real "Apply Changes" click variant.
7. `tests/e2e/ui/dynamic-chat-tabs.spec.ts:338-356`/`:631-633`. **Review correction (wrong hash
   source):** the collapse decision at `preview-panel.ts:218` is
   `previewContentHashFromTab(currentFilenameTab) === contentHash`, reading the LIVE TAB's stored
   `tab.state.contentHash` — NOT `state.previewPanelContentHash` and NOT `previewTabsHaveSameContent`
   (verified: zero call sites in `src/app`). Sample the v3 card's hash from the live tab's stored hash
   via `page.evaluate` (poll until a stable 64-hex string), and assert the single-source-of-truth as
   `GET-mount contentHash === currentFilenameTab.state.contentHash`.
8. `tests/search/flex-store.spec.ts`. Add the two prerequisite cases (close() resolves after rename;
   close() does not reject when the dir is removed mid-write, exercising the `[search] flex flush error`
   catch).

#### Acceptance criteria
- The `[search] flex flush` ENOENT/error line no longer appears across a full e2e run; `shutdown()`
  awaits `closeAll()` (and `remove()` awaits `close()`) before any directory removal; SIGTERM no longer
  drops the last search flush.
- Each of the three named e2e tests passes 20/20 under `--repeat-each=20` on the browser project.
- No quarantine tag, no `test.skip('flaky…')`, no `retries:N`, no timeout bumps introduced.
- The pre-compaction and saved-state tests assert on SERVER-authoritative state; the v3 test samples
  the contentHash from the field production reads (`currentFilenameTab.state.contentHash`).

#### Rollback
Each fix is independent: revert the close()/closeAll()/remove()/shutdown() signature changes (restores
the noisy-but-harmless teardown log); delete the `__pinAgentSessionFile` hook + call sites; remove the
server draft polls; restore the GET-mount hash source; delete the two flex-store cases. No migrations.

---

## 4. Open UX decisions (for the product owner)

Collated from every package's `uxPolicyDecisions`. Each is wired as a single seam so the decision is a
one-line change.

1. **(WP0) Red-test disposition for unfixed defects (S8/S9/S40/H3-A).** Active-and-RED (breaks the
   green gate) vs `test.fixme`-with-owning-ref vs characterization-green. **Recommended:** per-defect —
   characterization-green for S8/S40 (master stays green, defect captured), `test.fixme` for S9 and
   H3-A (mirrors the existing repro-h3 quarantine).
2. **(WP0) H3-A snapshot↔in-flight gate mechanism.** New `SNAPSHOT_GATE` trigger vs reuse the
   `USER_ECHO_DELAY` knob vs server-signal park. **Recommended:** reuse the delay knob (smallest
   surface); escalate to `SNAPSHOT_GATE` only if flaky.
3. **(WP0/WP1) Image-echo trigger ergonomics.** Dedicated `ECHO_IMAGE_BLOCK` phrase vs auto-echo
   whenever images are forwarded vs hybrid env-gate. **Recommended:** start with the phrase (guaranteed
   green baseline); WP1 evaluates flipping to auto-echo once it confirms no existing test forwards
   images expecting a text-only echo.
4. **(WP1) Filename on a content-derived image tile.** Mirror `enrichUserMessage`'s `image-N.png` vs
   mimeType-derived extension vs no filename. **Recommended:** mirror `image-N.png` for byte-identical
   live==reload; file a tiny follow-up to make BOTH `enrichUserMessage` and `imageAttachmentsFromContent`
   mimeType-derived together (the visible image is already correct via the data-URL mimeType).
5. **(WP1) Keep `_pendingAttachments` after the fix?** Demote to a fallback (keep a safety net) vs
   remove entirely vs keep only the optimistic-row painting. **Recommended:** demote to fallback.
6. **(WP2) Land the full-stack E2E pins now or defer to ride on WP0?** **Recommended:** land the
   reducer fix + reducer-unit pins now; the E2E pins follow once WP0's harness fidelity lands.
7. **(WP2) Empty-text equivalence-key granularity.** Include `stopReason` (`role|EMPTY|stopReason`) vs
   role-only. **Recommended:** include `stopReason` (conservative; never merges an error banner into an
   abort banner).
8. **(WP3) Presenting an undeliverable prompt.** Pending-bubble (auto-deliver on reconnect) vs
   disable-composer vs error-and-retain. **Recommended:** pending-bubble (prompt never lost, user keeps
   flow).
9. **(WP3) Pending-bubble visual treatment.** Inline status glyph+tooltip vs reduced-opacity+label vs
   reconnect-style spinner. **Recommended:** glyph/opacity, non-layout-shifting, with `aria-label`.
10. **(WP3) Over-aggregate-size rejection presentation.** Inline error affordance (retain prompt) vs
    reuse the existing `alert()` vs a pre-emptive size meter. **Recommended:** inline error affordance.
11. **(WP4) Snapshot-authoritative banner reconcile scope.** `messages` snapshot only vs also `state`
    frames vs carry explicit `autoRetryPending` in the snapshot payload (protocol change).
    **Recommended:** `messages` snapshot only for this WP; the protocol-carry is a principled follow-up.
12. **(WP4) Buffer `auto_retry_cancelled` when `clients.size===0`?** Leave the skip (snapshot reconcile
    heals) vs remove the guard vs rely on a later replay. **Recommended:** leave the skip.
13. **(WP5) Retained perm-frame consumption on resume.** Full payload rendered from the event-channel
    replay vs benign seq-holder (card from the on-attach branch) vs full payload + client de-dup.
    **Recommended (now mandated, not open):** benign seq-holder — verified the event-channel replay
    cannot render the card and would spuriously emit.
14. **(WP5) S9 overflow re-baseline strategy.** `_seqInitialized=false` (defer to next frame) vs
    `_highestSeq=seq` vs both + snapshot-seq adoption. **Recommended:** `_seqInitialized=false`.
15. **(WP6) Suppress the continuation prompt for Docker sandbox container recovery?** Keep vs suppress.
    **Recommended:** KEEP (container death is a real interruption; the prompt text is literally true).
16. **(WP6) Continuation-prompt wording when it DOES fire.** Leave as-is vs soften "infrastructure
    server restarted". **Recommended:** leave as-is (RC7's defect is the WRONG scenario, not the
    wording).
17. **(WP6) Client replay readiness after dropping the heartbeat replay.** Keep the 200ms timer vs an
    explicit ready signal vs route through the S2 outbox. **Recommended:** keep the 200ms timer for
    this WP (the server continuation prompt is the robust grant driver under review-option (i)).
18. **(WP7) Should documents reach the model (inject `extractedText`)?** Inject now vs defer to a
    follow-up vs inject + a composer affordance. **Recommended:** defer (WP7 = pure slimming, zero
    model-behaviour change); inject in a tiny follow-up.
19. **(WP7) Persistence slimming for queued image prompts.** Keep `images[].data` (re-dispatch after
    restart) vs out-of-band blob store. **Recommended:** keep `images[].data` (minimal; preserves the
    restart invariant).
20. **(WP8) Throttle the streaming proposal scans (in addition to the precheck)?** No throttle vs
    200ms vs 500ms. **Recommended:** no throttle (the precheck should remove the cost; avoid
    preview-latency regression).
21. **(WP8) Large-attachment encode strategy.** Chunked async yields vs `FileReader.readAsDataURL` vs
    Web Worker. **Recommended:** chunked async yields (smallest, single code path).
22. **(WP8) S34 — rAF coalescing alone vs + IntersectionObserver counts.** **Recommended:** rAF
    coalescing only (scoped to the burst caller), then re-measure before adding the IO refactor.
23. **(WP9) Watchdog action on stall.** Surface only (non-destructive) vs auto-recover (forceAbort) vs
    hybrid escalate. **Recommended:** surface only (cannot kill a legitimately slow turn; Stop +
    restart_agent are the escape hatches).
24. **(WP9) Stall threshold + activity signal.** 120s vs 60s vs 300s against `lastActivity`.
    **Recommended:** 120s against `lastActivity` (single tunable constant).
25. **(WP10) S36 shared-guard scope.** `handler.ts:178` only now vs all four fanout paths.
    **Recommended:** `handler.ts:178` now, follow-up for the other two.
26. **(WP10/S39, re-scoped) Deferred-block a11y technique.** `content-visibility:auto` on the full
    template (breaks the perf feature + pinned tests) vs `sr-only` text-only copy vs resolve-on-focus.
    **Recommended:** `sr-only` text-only copy in S39's own staged package (NOT in WP10).
27. **(WP10) S33 trailing-flush timing.** Trailing-edge only vs leading+trailing vs no flush.
    **Recommended:** trailing-edge only.
28. **(WP11) SIGTERM wait for the search flush.** Await unconditionally vs `Promise.race` with a cap vs
    test-harness-only drain. **Recommended:** await unconditionally (bounded I/O; the harness caps
    teardown at 60s) — but add a real `cli.ts` race cap if a production stall is a concern.
29. **(WP11) pre-compaction fix mechanism.** Test-only `__pinAgentSessionFile` hook vs production
    `getState()` treating a host-set path as authoritative vs persist through the normal store.
    **Recommended:** test-only hook (the override is a test construct; production must keep recovery
    re-derivation).
30. **(WP11) saved-state re-arm.** Real Apply round-trip vs persist+poll vs client-only +
    render-settled signal. **Recommended:** keep the client-state mutation AND add the server poll (a
    server-only persist never sets the no-reload client flag).

---

## 5. Risk register & definition of done

### Risk register

| Risk | Where | Likelihood | Mitigation |
|------|-------|-----------|------------|
| The WP0 default-abort shape change perturbs existing abort-consuming specs (new "Request aborted" DOM row, message-count, first-message_end ordering). | WP0 step 9 | High without the audit | Widen the audit net to DOM + count + first-message_end ordering; keep `MOCK_ABORT_AS_ERROR` for error-gated-drain; flag the user-abort `'aborted'` vs `'error'` fiction for WP9/WP10 to settle. |
| `message_start` triggers `AgentInterface._updateAndPin()` (not inert in render). | WP0 steps 1/9 | Medium | Scope the "inert" claim to the state reducer; verify no follow-tail/scroll/jump-button spec regresses before merge. |
| WP2 step-4b over-dedup deletes a real prior-snapshot row when a distinct new same-text reply arrives. | WP2 | Medium | Tighten the match to optimistic/echo lineage + add the dedicated non-regression pin. |
| WP3 S31 guard measured against `content+preview` only still trips close-1009 (3× image inflation). | WP3 step 8 | High without the fix | Measure the REAL serialized frame (`JSON.stringify(frame).length`); keep the cap × inflation < `WS_MAX_PAYLOAD_BYTES`. |
| WP3 over-size rejection wipes the saved draft (`message-send` fires before the guard). | WP3 step 8 | Medium | Place the guard as the FIRST statements in `handleSend`, before the `dispatchEvent('message-send')`. |
| WP5 retention breaks the second EventBuffer test → baseline regresses. | WP5 step 1 | High without the edit | Update the 223-233 test to the post-retention contract (size 0→3). |
| WP5 full-payload perm holder spuriously emits / never renders the card. | WP5 step 3 | High if option A taken | Mandate the benign `{type:'noop'}` seq-holder; on-attach branch owns the still-pending card; DENY shows no card. |
| WP6 suppressing the grant continuation prompt + transition-only client replay strands the grant on a dropped frame. | WP6 | High if both legs suppress grant | Adopt review-option (i): keep the server continuation prompt for the GRANT path; suppress only restartAgent/role-switch; drop only the redundant heartbeat replay. |
| WP9 watchdog/force-abort tests throw (no EventBuffer; session not in `sessionsWithConnectedClients`) or leak an unhandled sync-throw. | WP9 | High without the fixes | Add `eventBuffer` to the fake session; register via `addClient`; wrap the un-awaited `abort()` in an async IIFE+catch. |
| WP9 watchdog kills a legitimately slow turn. | WP9 | Low (surface-only default) | Gate on `lastActivity`; default policy is non-destructive surface-only; 120s threshold. |
| WP8 broad rAF on the shared `_refreshJumpButton` wrapper flakes the most-asserted scroll specs (settleFrames budget). | WP8 step 7 | Medium | Coalesce ONLY the burst caller (`_updateAndPin`); keep scroll/geometry sites synchronous. |
| WP10/S39 `content-visibility` breaks `defer-offscreen-render.spec.ts` and defeats the perf feature. | WP10 | High if shipped as written | Remove S39 from WP10; re-scope to its own staged package with an `sr-only` copy + deliberate placeholder-pin updates. |
| WP11 step-7 samples the wrong hash field → the real divergence stays unfixed; step-6 server-only persist breaks the no-reload step-3 client flag. | WP11 | High without the corrections | Sample `currentFilenameTab.state.contentHash`; keep the client-state mutation + add the server poll. |
| WP11 SIGTERM stall behind a hung flush (no production timeout). | WP11 | Low (bounded I/O) | Await unconditionally + (optional) `cli.ts` race cap; do not claim a non-existent mitigation. |
| A package turns master red between WP0 and its fixing package. | Cross-wave | Medium | Characterization-green + `test.fixme`-with-owning-ref convention; the fixing package flips fixme→active in the same PR. |

### Definition of done

- **All four symptoms have a faithful failing-then-passing test:**
  - **B (images):** WP0 mock echoes image content blocks; WP1 `image-echo-live-and-reload.spec.ts` and
    the reducer/render pins are RED on master (no live tile), GREEN after.
  - **A (duplicates):** WP2 reducer pins (S7/S10/S17/S18) RED on master (2 rows), GREEN after; non-
    regression pins keep distinct same-text at 2.
  - **C (freeze / dead Stop / lost prompt):** WP3 outbox + WP4 seq-less routing + WP5 overflow/perm-hole
    + WP9 force-abort/watchdog — each RED (or characterization-then-flipped) on master, GREEN after.
  - **D (jank/teardown):** WP7 payload-slimming + WP8 hot-path/decoder pins RED on master, GREEN after.
- **Baselines still green:** `npm run check` clean; `npm run test:unit` ≥ 1237 pass; `npm run test:e2e`
  ≥ 1078 pass — after every wave.
- **No flaky tests:** WP11 makes each of the three named e2e tests pass 20/20 under `--repeat-each=20`,
  removes the search-flush ENOENT teardown noise, and introduces no quarantine/skip/retries/timeout
  bumps.
- **No production `src/` change in Wave 0** (`git diff src/` empty after WP0).
- **Every behaviour-changing seam is pinned by a test, not prose** (per AGENTS.md "the missing test IS
  the bug"); every `test.fixme` carries an explicit owning-package reference.
- **All 30 open UX decisions in §4 are resolved by the product owner** before the corresponding step
  ships (each is a single-seam, one-line change).
