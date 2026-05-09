# Transcript fidelity harness

> Status: **prototype landed**. Author: Bobbit (with user). 2026-05-09.
>
> Step 1 (skeleton + happy-path multiset assertion + negative test) is
> implemented under `tests/e2e/fidelity/`. See `## Prototype demo` below
> for current results.

## Why

Bobbit's debugging index in `AGENTS.md` is a catalogue of message-loss and
ordering bugs: snapshot/live race ("messages disappear and reappear"), steer
duplication, stuck status, false-positive jump-to-bottom, out-of-order
widgets after navigate, lost frames on resume. Each has a named design doc
and a pinned regression test, but the regressions keep finding new shapes
because we test *symptoms*, not the underlying invariant.

The underlying invariant is simple to state in English:

> Every event the agent emits should appear in the user's DOM **exactly
> once**, in the **logical order** the agent emitted it, with **no
> perceptible delay** from the user's interaction, **and stay there** —
> across reloads, reconnects, server restarts, and rapid steers.

This document describes a test harness that asserts exactly that, against
the real server, real WebSocket transport, real reducer, real snapshot/live
merge, real persistence — but a **deterministic scripted agent** instead of
a real LLM. We call the captured-DOM record an *observed transcript* and
the script an *expected transcript*; the harness diffs them.

Inspiration: the Earendil `pi/web-ui` example app is ~350 LOC and *cannot*
have any of these bugs because its agent runs in the same JS heap as the
view. We can't (and don't want to) collapse to that architecture, but we
can build an oracle that holds Bobbit to the same observable contract.

## Non-goals

- **Not** a replacement for unit / integration / manual tests. This is a
  new tier focused on observable transcript fidelity under perturbation.
- **Not** a tool for testing LLM behaviour. The agent is scripted; LLM
  flakiness is removed deliberately.
- **Not** a performance benchmark. Latency assertions are coarse
  ("first paint < 200 ms"), not micro-benchmarks.
- **Not** a replacement for `mock-agent-core.mjs`. That mock has rich
  prompt-pattern triggers tied to existing tests; we add a *parallel*,
  simpler fake driven by an external script file. (We may consolidate
  later — see [Open questions](#open-questions).)

## Architecture

```
   ┌──────────────────────────────────────────────────────────────┐
   │ Playwright test                                              │
   │                                                              │
   │   loadScript(yaml)  ─────────┐                               │
   │                              ▼                               │
   │   ┌──────────────────────────────────┐                       │
   │   │ DOMRecorder (in-page)            │   ┌────────────────┐  │
   │   │ - MutationObserver on chat root  │──▶│ ObservedEvents │  │
   │   │ - records (t, id, kind, text)    │   └────────────────┘  │
   │   └──────────────────────────────────┘            │          │
   │                              ▲                    ▼          │
   │   browser ──── WebSocket ────┴───── gateway ──── Oracle      │
   │                                        │            │        │
   │                                        ▼            ▼        │
   │                                 ┌─────────────┐  diff(script,│
   │                                 │ ScriptedAgt │  observed)   │
   │                                 │ replays YAML│              │
   │                                 │ as agent    │  ─→ verdict  │
   │                                 │ protocol    │              │
   │                                 └─────────────┘              │
   └──────────────────────────────────────────────────────────────┘
```

### Four pieces

#### 1. Script schema

A test fixture (`tests/e2e/fidelity/scripts/*.yaml`) describing what the
agent should emit and when. Frame types match the existing agent-protocol
JSONL events on stdout, so the player is a thin replayer.

```yaml
# tests/e2e/fidelity/scripts/streaming-with-tool.yaml
name: streaming-with-tool
description: One user prompt, streamed text, one bash tool call, one final.

steps:
  # On startup
  - at: 0ms
    emit: { type: session_status, status: idle }

  # Wait for the user prompt to arrive on stdin
  - on: user_prompt
    capture: prompt          # bind to $prompt for later asserts

  - at: +20ms
    emit: { type: session_status, status: streaming }
  - at: +30ms
    emit: { type: message_update, id: m1, role: assistant, delta: "Hello" }
  - at: +60ms
    emit: { type: message_update, id: m1, delta: " world." }
  - at: +100ms
    emit:
      type: tool_execution_start
      id: t1
      tool: bash
      args: { command: "echo hi" }
  - at: +150ms
    emit: { type: tool_execution_end, id: t1, output: "hi\n", exit: 0 }
  - at: +180ms
    emit: { type: message_update, id: m2, role: assistant, delta: "Done." }
  - at: +200ms
    emit: { type: message_end,    id: m2 }
  - at: +210ms
    emit: { type: session_status, status: idle }
```

Times: `0ms`, `Nms` (absolute from script start), or `+Nms` (relative to
previous step). Steps with `on:` block until that input arrives.

#### 2. ScriptedAgent (the player)

A Node binary `tests/e2e/fidelity/scripted-agent.mjs` that:

1. Reads the script path from `BOBBIT_SCRIPT_AGENT=...` env var (set by
   the harness when spawning the agent).
2. Speaks the same JSONL agent protocol on stdin/stdout that the real
   agent CLI does — so it goes through the **real** `RpcBridge`, real
   server, real WS, real reducer.
3. Uses the same `--mode rpc --cwd ...` arg shape as the existing
   `mock-agent.mjs`, so the spawn site doesn't need to change beyond the
   binary path.

For prototype #1 we wire it through the existing `BOBBIT_AGENT_BIN`
override path used by the gateway harness. Long-term, we add a
`BOBBIT_FAKE_AGENT_SCRIPT` env that selects script + binary in one go.

#### 3. DOMRecorder (the oracle)

Runs in-page (injected by the Playwright fixture). Attaches a single
`MutationObserver` to the chat transcript root and records, for every
mutation:

```ts
type ObservedEvent =
  | { t: number; kind: "append";    messageId: string; role: string; text: string }
  | { t: number; kind: "update";    messageId: string; text: string }
  | { t: number; kind: "remove";    messageId: string }
  | { t: number; kind: "tool_open"; toolId: string;   name: string }
  | { t: number; kind: "tool_done"; toolId: string;   exit?: number }
  | { t: number; kind: "status";    status: string }
  | { t: number; kind: "user_send"; text: string }   // typed when send button clicked
```

Identifiers come from `data-message-id` / `data-tool-id` / `data-status`
attributes that the renderers already set. No polling. No sleeps. The
recorder is a passive witness — it never drives the test.

Output: an ordered array of `ObservedEvent`, dumped via
`window.__fidelity__.dump()` and pulled into the test process.

#### 4. Oracle diff engine

Pure function: `diff(script, observed) → Verdict`.

Verdict invariants (each is its own assertion so failures are pinpointed):

| # | Invariant                                                                | Bug class caught                       |
|---|--------------------------------------------------------------------------|----------------------------------------|
| 1 | Multiset of message IDs in observed == multiset in script.               | Silent swallow / duplication           |
| 2 | Final order of message IDs == script logical order.                      | Out-of-order widgets, reorder on nav   |
| 3 | For each message ID, observed text is **monotone-growing** (no shrink).  | H3 disappear-and-reappear              |
| 4 | No message ID is `remove`d once it has been finalised by `message_end`.  | Stale-snapshot eviction                |
| 5 | Multiset of tool IDs in observed == multiset in script.                  | Tool widget duplication / loss         |
| 6 | `t(first append for any assistant id) - t(user_send)` < firstPaintBudget | Sluggish first-token                   |
| 7 | `t(status=idle) - t(last script step)` < idleSettleBudget                | Stuck-streaming / ghost in-flight      |
| 8 | `t(user_send_observed) - t(send_clicked)` < echoBudget                   | Optimistic-echo lag                    |

Defaults: `firstPaintBudget=400ms`, `idleSettleBudget=500ms`,
`echoBudget=80ms`. All overridable per-script.

Each invariant produces a structured `Anomaly` with the offending event
indices, so a failed test prints:

```
✗ streaming-with-tool [reload-mid-stream]
  Invariant #3 (monotonicity) violated for messageId=m1
    observed text history:
      t=42ms   "Hello"
      t=72ms   "Hello world."
      t=410ms  "Hello"             ← shrank after reload
      t=440ms  "Hello world."
```

That diff *is* the bug report.

#### 5. Perturbation matrix

The same script is run under each perturbation. Perturbations are
scheduled by the test, not by the script. They are simply Playwright
actions interleaved with `await waitForScriptCheckpoint('+60ms')`.

| Perturbation             | How                                                |
|--------------------------|----------------------------------------------------|
| `clean`                  | Baseline.                                          |
| `ws-drop-mid`            | `await page.evaluate(()=>window.__fidelity__.dropWs())` mid-stream. |
| `server-restart-mid`     | Existing `restartServer()` helper (used by `steer-gateway-restart`). |
| `reload-mid`             | `page.reload()` mid-stream, wait for resume.       |
| `reload-post`            | `page.reload()` after script completes.            |
| `nav-away-and-back`      | Click sidebar to other session, then back.         |
| `slow-cpu-4x`            | `page.context().route` with CPU throttle on.       |
| `rapid-steer-during`     | Type + send a steer at `+50ms`. Script branches.   |

Each perturbation runs the same oracle. A failure cell in the matrix is a
real bug.

## How it slots into existing infrastructure

- **Reuses `tests/e2e/gateway-harness.ts`** — spawns the real gateway.
- **Reuses Playwright's `webServer` config** — no new bash-spawned servers.
- **Spawn override**: existing harness already supports `BOBBIT_AGENT_BIN`
  / `BOBBIT_AGENT_ARGS` for swapping the agent binary. We point that at
  `scripted-agent.mjs`. Zero changes to `RpcBridge` or `SessionManager`.
- **Outcome-only assertions** — same philosophy as `tail-chat-helpers.ts`.
- **Fixtures live alongside scripts** under `tests/e2e/fidelity/`.
- **Reducer / WS / persistence / preview** all run unmodified. The point
  is to exercise them, not stub them.

## File layout

```
tests/e2e/fidelity/
├── README.md                       # how to write a script
├── scripted-agent.mjs              # the player binary
├── script-loader.ts                # YAML parse + frame validator
├── dom-recorder.ts                 # injected page-side recorder
├── oracle.ts                       # diff(script, observed) → Verdict
├── harness.ts                      # Playwright fixture + perturbations
├── scripts/
│   ├── streaming-with-tool.yaml
│   ├── multi-turn.yaml
│   ├── steer-during-stream.yaml
│   └── ...
└── fidelity-matrix.spec.ts         # one test per (script × perturbation)
```

## Build order — smallest useful increment first

Each step is independently demoable and produces real signal.

1. **Step 1 — Skeleton + happy-path multiset assertion.**
   - Script schema (subset: `at`, `emit`, `on: user_prompt`).
   - `scripted-agent.mjs` that replays one script.
   - DOMRecorder for `append` / `update` / `status` only.
   - Oracle: invariants #1, #2, #5.
   - One script: `streaming-with-tool.yaml`.
   - One test: `clean` perturbation only.
   - **Stop here, demo, get feedback.**

2. **Step 2 — Monotonicity + timing budgets.**
   - Add `remove` and `user_send` to recorder.
   - Add invariants #3, #4, #6, #7, #8.
   - This step alone catches H3 without any perturbation.

3. **Step 3 — Reload-mid perturbation.**
   - `page.reload()` at a script checkpoint, wait for resume.
   - Oracle treats reload as transparent — invariants must hold across it.
   - **Highest-value perturbation per LOC.** Catches snapshot/live merge
     and `_bufferedProposalEvents` issues.

4. **Step 4 — WS-drop and server-restart perturbations.**
   - Reuses helpers from `steer-gateway-restart` and existing reconnect tests.

5. **Step 5 — Steer-during-stream and nav-away-and-back.**
   - Script gains a `branch_on_steer:` directive.

6. **Step 6 — Script library and CI.**
   - Port 5–10 representative scenarios from existing pain points.
   - Add to nightly CI matrix (not on every PR — too slow).

## Open questions

- **Consolidate with `mock-agent-core.mjs`?** That file has rich
  prompt-pattern triggers that existing tests depend on. The scripted
  agent is a *different* abstraction (external script vs prompt-keyed
  pattern). Initial proposal: keep both, see if scripts subsume triggers
  over time. No migration needed for existing tests.
- **DOM identifiers.** Are `data-message-id` / `data-tool-id` already
  reliably emitted by every renderer? Audit needed in Step 1. If not,
  we add them — the recorder needs a stable join key.
- **Streaming text "monotonicity"** — does the renderer ever legitimately
  *replace* a text block (e.g. on tool error)? If so, define the legal
  exceptions explicitly; don't loosen the invariant globally.
- **Latency budgets on CI.** Different runners have different speeds.
  Budgets may need to be expressed as percentiles over N runs rather
  than hard ceilings. Defer to Step 6.

## Success criteria for the prototype

The prototype (Steps 1–3) is successful if:

1. We can run `npm run test:e2e -- fidelity-matrix` and see at least one
   green script under `clean`.
2. We can deliberately introduce a bug (e.g. comment out `_order >
   snapshotMaxOrder` guard in the client merge path) and the harness
   catches it under `reload-mid` with a precise anomaly diff — *not* a
   timeout, *not* a screenshot diff.
3. The diff output is short enough to paste into a bug report and points
   directly at the violated invariant + offending event.

If those three hold, we have a real oracle. Subsequent steps are
mechanical.

## Prototype demo — Step 1 results

Run:

```bash
npm run build
npx playwright test --config playwright-e2e.config.ts --project=browser \
  tests/e2e/fidelity/fidelity-prototype.spec.ts
```

Two tests, both pass on a clean tree:

```
[fidelity verdict]
Verdict: PASS
Stats: slots observed=2 / expected=2  firstPaint=156ms  idleSettle=?ms
(no anomalies)
  ✓  fidelity prototype — happy-path script PASSES

[fidelity verdict]
Verdict: FAIL
Stats: slots observed=2 / expected=1  firstPaint=145ms  idleSettle=?ms
Anomalies (2):
  - {"code":"multiset_mismatch","expected":["user"],"observed":["user","assistant"],"detail":"role=assistant: expected=0 observed=1"}
  - {"code":"non_monotone_text","slot":1,"previous":"0s","next":"Streaming this then dropping it... 0s","tPrev":4301,"tNext":4324}
  ✓  silent-swallow script FAILS oracle (proves harness has teeth)
```

The second test feeds the oracle a **deliberately broken script**
(`scripts/broken-silent-swallow.json`) that announces an assistant
streaming message via `message_update` but never emits the matching
`message_end`. The oracle correctly flags two anomalies that pinpoint
exactly the kind of bug class production keeps regressing on:
*ghost-streaming-bubble* and *non-monotone-text-replacement*.

The diff output is structured enough to paste into a bug report and
points at the exact violated invariant — success criterion #3 met.

Success criteria status:

| # | Criterion                                          | Step 1 status |
|---|-----------------------------------------------------|---------------|
| 1 | Green clean run                                     | ✓ met         |
| 2 | Catches deliberate bug with precise diff (not timeout) | ✓ met (via negative-script test — broader-bug version comes in Step 3 with reload-mid) |
| 3 | Diff is paste-into-bug-report short                 | ✓ met         |

Caveats and follow-ups:

- **First-paint budget is 3000ms** in the happy-path script. Real first
  paint is ~150ms after the prompt is acknowledged, but on a freshly-
  created session the first WS round-trip carries session-bootstrap
  cost (~1.3s on Windows). Step 2 should tighten this once the harness
  reuses a warm session across scripts.
- **Idle-settle reads `?ms`** when the recorder doesn't observe any
  intermediate non-status / non-user_send event after the last status
  flip. Cosmetic — fix in Step 2.
- **No perturbations yet.** The clean baseline is the only column.
  Reload-mid (Step 3) is the highest-value next addition.

## First real bug caught + fixed — user-message render churn (2026-05-09)

With Step 2's slot-identity upgrade in place (stable `data-message-id`
attribute on `<user-message>` / `<assistant-message>`, recorder joins on
that key), the harness immediately surfaced a real production bug:

**On a single `sendMessage`, the user-message bubble flickers through
2–3 distinct DOM elements before settling.**

Representative observed trace (from
`test-results/fidelity-repros/happy-path-2026-05-09T13-17-28-146Z/`):

```
t=3630  append   <user-message> (no id)                                slot=A
t=3645  append   <user-message data-message-id="optimistic_...">      slot=B
t=3646  remove   slot=A
t=3649  append   <user-message> (no id)                                slot=C
t=3649  remove   slot=B
t=3728  update   slot=C  text="fid-1"  (final)
```

The oracle flagged `multiset_mismatch` (3 user appends vs 1 expected)
+ two `slot_removed` anomalies. The bug is invisible to the user (all
swaps complete in <50 ms) but real for screen readers, accessibility
tools, performance instrumentation, and any DOM-keyed test harness.

The bug was promoted to a **deterministic regression test** in
`tests/e2e/ui/regressions/user-message-render-churn.spec.ts` that
asserts two outcome-only invariants on a single `sendMessage`:

1. Exactly **one** persistent `<user-message>` survives.
2. **Zero** `<user-message>` elements are removed during the turn.

This test FAILS on master with a precise diagnostic:

```
<user-message> lifecycle for one sendMessage:
  adds:    2  (one without id, one with optimistic_*)
  removes: 1  (the optimistic bubble)
  DOM survivors at end: 1
Expected: 0 removes
Received: 1
```

**Fix**: `src/app/message-reducer.ts` — the live-event branch now
performs an *in-place upgrade* when an optimistic row matches the
incoming server echo. The optimistic `id` is preserved (so Lit's
`repeat()` render key stays stable across the handoff) and the row's
`_origin` flips to `"server"` while `_order` is updated to the live seq
for correct sort placement. A subtle correction in the same change:
the early "drop server entry with same id" filter now skips
optimistic-origin rows so the optimistic match below can still find
its target.

With the fix in place, the regression test passes, and the harness's
`happy-path` script also passes cleanly. `streaming-text` still
surfaces a separate handoff bug (the streaming `<assistant-message>`
rendered inside `StreamingMessageContainer` is torn down on
`message_end` and a fresh committed `<assistant-message>` appears in
`MessageList`); that's a structurally similar bug class but requires
coordination between two render containers and is tracked separately
as a `.fixme()` on the streaming-text fidelity test.

### Pattern — fidelity finding → deterministic regression

This is the loop the harness was built for:

1. Fidelity script + oracle catches an invariant violation (any of:
   multiset / order / monotone / no-remove / first-paint / idle-settle).
2. `repro-writer.ts` automatically captures the script + observed trace +
   verdict + a stand-alone `repro.spec.ts` under
   `test-results/fidelity-repros/`.
3. Operator triages the trace, distils the underlying invariant into a
   single hand-written outcome-only test, and parks it in
   `tests/e2e/ui/regressions/`.
4. The fidelity script gets `.fixme()`'d until the regression test goes
   green. Once green, both unblock together — the harness self-test and
   the regression test reinforce each other.

The payoff: the fidelity harness finds bugs *and* the deterministic
regressions it spawns are independent of the harness, so the bug fix
can't silently regress later when the harness is refactored.
