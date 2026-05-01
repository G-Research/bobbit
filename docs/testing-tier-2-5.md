# Tier 2.5 — opt-in beat-capture + video reports for browser E2E

Tier 2.5 is a **layer on top of** the standard browser E2E suite
(`tests/e2e/ui/`). Tests that opt in capture a labeled screenshot at every
meaningful UX moment; the run produces a self-contained scrubbable HTML
report with a per-test WebM video and clickable thumbnail strip. The report
is for human review — a debugging artifact you can scrub through long after
the run finishes.

When `RECORDSCREEN=1` is **not** set, every Tier 2.5 mechanism is a no-op.
The opted-in tests behave identically to current master.

> The env var is named `RECORDSCREEN` because that's literally what it does
> — turn on screen recording / video reporting for the test run. The
> "Tier 2.5" label is a design-doc category for the layer; the runtime
> activation flag is `RECORDSCREEN`.

## What is Tier 2.5

A Tier 2.5 test is a **regular browser E2E test** with two changes:

1. The import line points at `./fixtures.ts` instead of `../gateway-harness.js`.
2. Sprinkle `await rec.capture("Label describing this UX moment")` at user-visible moments.

That's it. All existing assertions, helpers, and `gateway-harness` semantics carry over unchanged.

When `RECORDSCREEN=1`:

- A red cursor dot is injected so clicks are visible in screenshots.
- Each `rec.capture(label)` writes one PNG (~50ms) and appends an entry to an in-memory list.
- At end of run, the `tier-2-5-reporter` walks every `beats.jsonl`, runs ffmpeg-static to encode a WebM (each beat held for 1500ms) plus a thumbnail strip, and writes `tests/results/tier-2-5/report.html`. The report path is printed to stdout.

When `RECORDSCREEN` is unset:

- The cursor overlay is not injected.
- `BeatRecorder` methods early-return with **zero** filesystem activity.
- The reporter file is never even loaded by Playwright.

## How to opt a test in

```ts
// before
import { test, expect } from "../gateway-harness.js";

test("my test", async ({ page }) => {
  // ...
});
```

```ts
// after
import { test, expect } from "./fixtures.js";

test("my test", async ({ page, rec }) => {
  await rec.capture("Empty composer ready");
  // ... existing test body, sprinkled with rec.capture(...) calls ...
  await rec.capture("Final state — all assertions passed");
});
```

Run with capture on:

```bash
RECORDSCREEN=1 npm run test:e2e -- bg-wait-steer-flow.spec.ts
```

Run normally (no capture, identical to master):

```bash
npm run test:e2e -- bg-wait-steer-flow.spec.ts
```

The canonical worked example is [`tests/e2e/ui/bg-wait-steer-flow.spec.ts`](../tests/e2e/ui/bg-wait-steer-flow.spec.ts) — the test PR #433 added. Additional migrated specs that follow the same pattern: `queue-ui.spec.ts`, `jump-to-bottom.spec.ts`, `ask-user-choices-ui.spec.ts`, and `stories-streaming.spec.ts`. Use them as templates when picking beat boundaries for queue/steer flows, scroll-state interactions, ask-widget round-trips, and reconnect-mid-stream dedup respectively.

## Transcript-fidelity invariant

[`tests/e2e/ui/transcript-fidelity.spec.ts`](../tests/e2e/ui/transcript-fidelity.spec.ts) is a generic regression guard for the bug class that PRs #436 and #437 fixed: the live DOM diverging from the server snapshot. The post-refresh DOM is hydrated from the persisted message snapshot — it is the ground truth of "what really happened in this session". The live DOM is the result of streaming reducer state. After a multi-cycle `STREAM_BURST:3` mock-agent burst, the two views must agree exactly: same number of messages, same fingerprints, same order, no live-only duplicates.

The assertion shape:

1. Drive `STREAM_BURST:3` (three cycles of [propose_goal + chunked-text + bash_bg.wait + chunked-text]) to idle.
2. Snapshot the live DOM transcript (role + dynamic-text-stripped fingerprint per `<user-message>` / `<assistant-message>` / `<tool-message>` in DOM order).
3. Hard-refresh the page; snapshot again from the rehydrated server snapshot.
4. Assert: counts equal; no live fingerprint appears more than once; live\[i].fp === refresh\[i].fp at every index.

This is the assertion pattern the prototype used to *find* the bugs PRs #436 and #437 fixed; without it on master, the next bug in the same class — reducer-correct but renderer-visible, or transient-dup that needs multi-cycle accumulation to manifest — is only caught after a user reports it. If this test fails on master and the failure traces to a real bug, fix the production code in the same PR (precedent: PRs #433, #436, #437).

## Beat capture rules

These are the patterns that produced useful videos in the prototype that
caught PR #433 and PR #436. Copy them.

- **Capture before AND after every user-driven action.** Typing, clicking, awaiting an event — both the *before* and *after* states deserve a beat. The video should be a coherent narrative a reviewer can scrub through.
  - Before typing → `Empty composer ready`
  - After typing → `Typed: "STAY_BUSY:5000 working"`
  - Before clicking → `About to click Steer`
  - After clicking → `Clicked Steer — should abort wait`
  - After awaiting an event → `STEER_RECEIVED arrived in transcript`
- **Beats are cheap** (~50ms each — one screenshot, one label string). Err on more rather than fewer. 5–15 beats per test is the sweet spot.
- **Use descriptive labels** that read well as a slideshow. The label is shown beneath every thumbnail in the report and as the active-thumb caption while the video plays.
- **One test = one user story.** Don't combine "test send" + "test edit" + "test queue" into one test. Split them. The video for each test should be a coherent story.
- **Tag user prompts with monotonic markers** if the test is sensitive to ordering. `[T1 @123ms] my prompt` makes drift unambiguous in the chat scrape — a missing or out-of-order tag is a bug, not an ambiguity.

## Performance budget

- One `rec.capture()` call costs ~50ms (one Playwright viewport screenshot, no extra waits).
- 5–15 beats per test → ~250–750ms of test wall-time when `RECORDSCREEN=1`.
- ffmpeg encoding at end of run: ~200ms per test (VP9, ~200 KB per video).
- A 200-test suite with `RECORDSCREEN=1` typically adds ~30s wall-time vs the default run.
- Default off. Forever. There is no "always-on" mode and there should never be one — capture is a debugging tool, not a continuous-integration check.

## What Tier 2.5 is NOT

This list is non-negotiable. Each item below was tried, rejected, and would re-introduce flakiness or false-bug-classes if reintroduced.

- **It is not a replacement for unit tests.** Pure-Node tests for reducers, state machines, and pure functions remain the right tool — they run in milliseconds and isolate logic from the UI.
- **It is not a replacement for browser E2E.** Standard `tests/e2e/ui/` tests are simpler, faster, and run in CI by default. Tier 2.5 is for **multi-step user-journey** tests where the value of the recorded video is real.
- **It is not a manual-integration substitute.** Real-LLM tests (`tests/manual-integration/`) remain the only way to catch bugs that depend on real model latency, cost, or output content.
- **No synthetic event reordering / chaos pipes / `ErraticChannel` abstractions.** Production has no reorder buffer — TCP delivers in order and the server stamps monotonic `seq`. Faking disorder fakes a bug class that doesn't exist in production. The right way to expand mock fidelity is to identify what *real* LLM streams do (per AGENTS.md debug entries) and have the mock emit those patterns.
- **Don't slow scenarios down for visual clarity.** The "video controls + 1500ms beat hold" pattern solves visual review without slowing the test. `LINGER_MS` and `TYPE_DELAY_MS` were tried and reverted.
- **Don't auto-launch Chrome from the test.** The test writes the report to disk and prints its path; opening it is the user's job (or a one-line shell command). `child_process.spawn`-to-open-browser was tried and added flakiness for no value.
- **Don't `Read` the report file from an agent.** It's hundreds of KB of text + base64 thumbnails; burning agent context to summarize an HTML report is a waste. The report is for human eyes.
- **Don't make assertions on text fingerprints when DOM-element counts work.** Two cards with identical text fingerprints but separate DOM nodes is the bug, not the absence of one. Count nodes (`document.querySelectorAll("tool-message").length`).
- **No always-on video capture.** Default off, opt-in via `RECORDSCREEN=1`, no project-config knob, no `default-on` mode. Forever.

## Mock trigger reference

Every Tier 2.5 test uses the mock LLM agent at `tests/e2e/mock-agent-core.mjs`. The mock inspects user prompt text for trigger phrases and emits production-shape events (multi-delta `message_update`, `tool_execution_*` lifecycle, role-correct `message_end`) so any production reducer / state-machine change is exercised by tests that use these triggers.

The full trigger contract lives in the header comment of `mock-agent-core.mjs`. Summary:

| Category | Trigger | Behaviour |
| -------- | ------- | --------- |
| Busy / wait | `STAY_BUSY:<ms>` | Emit one Bash `tool_execution_start`, tick `<ms>`, emit `tool_execution_end`. |
| Busy / wait | `BG_WAIT:<ms>` | Drive the real gateway `BgProcessManager`: POST a `sleep <ceil(ms/1000)>` bg process, long-poll `wait`. `abortAllWaits` resolves it on steer/stop. Multi-delta `message_update` on both create and wait assistant messages. |
| Bursts | `MIXED_BURST:<n>` | `n` cycles (1..6) of [`propose_goal` + `BG_WAIT 1.5s`]. Stresses the message-ordering reducer. |
| Bursts | `STREAM_BURST:<n>` | Like `MIXED_BURST`, plus chunked-text streams before (no final `message_end`) and after each `bash_bg.wait`. Reproduces transient client-state bugs cleared by browser refresh. |
| Tools (real fs / shell) | `Read:<path>` | `fs.readFileSync(path, "utf-8")`. |
| Tools | `Write:<path>::<content>` | Recursive mkdir + `writeFileSync`. |
| Tools | `Edit:<path>::<old>::<new>` | read + replace + write. |
| Tools | `Bash:<cmd>` | `execSync(cmd, { cwd, timeout: 10_000 })`. |
| Proposals | `goal_proposal` | `propose_goal`. |
| Proposals | `project_proposal` | `propose_project`. |
| Proposals | `proposal_burst` | 3× `propose_goal` in one turn. |
| UI primitives | `ask_user_choices` | Single-select widget. |
| UI primitives | `ask_user_choices_multi` | Multi-select widget. |

**Steer round-trip** (RPC, not a prompt-text trigger): the mock's steer handler emits a synchronous `[STEER_RECEIVED] <text>` assistant message for back-compat, then aborts the in-flight turn and queues a fresh `handlePrompt(steeredText)` so a real `<user-message>` lands in the chat.

When in doubt about exact event semantics, read the header comment in `mock-agent-core.mjs` — it is the stable contract.

## Architecture

The fixture's plumbing is a few small files that nest cleanly into the existing E2E setup:

- **`tests/e2e/ui/cursor-overlay.ts`** — `CURSOR_OVERLAY_SCRIPT` string, fed to Playwright's `addInitScript`. Self-contained IIFE, idempotent (`window.__protoCursorInstalled` guard). Red dot tracks pointer events, flashes yellow on mousedown.
- **`tests/e2e/ui/beat-recorder.ts`** — `class BeatRecorder { capture(label); flush() }`. Each `capture()` writes one viewport PNG to `<testInfo.outputDir>/beats/<idx-padded-4>.png` and appends a record. `flush()` writes JSONL to `<testInfo.outputDir>/beats.jsonl`. Off-switch: every method early-returns when `RECORDSCREEN !== "1"`.
- **`tests/e2e/ui/fixtures.ts`** — extends `baseTest` from `../gateway-harness.js` with a `rec: BeatRecorder` fixture. Conditionally injects the cursor overlay, auto-flushes after `use(rec)`. Re-exports `expect` from Playwright.
- **`tests/e2e/report/tier-2-5-reporter.ts`** — Playwright `Reporter`. On `onEnd`, walks the test-results tree for `beats.jsonl`, encodes each test's `beats/*.png` into a 1500ms-per-beat WebM via ffmpeg-static, generates 240px thumbnails, and emits `tests/results/tier-2-5/report.html`. All references in the HTML are relative paths — **no base64 inlining**.
- **`playwright-e2e.config.ts`** — gated reporter registration: when `RECORDSCREEN=1`, the reporter is appended to the `reporter` array; otherwise the file is never loaded.

## Output layout

When `RECORDSCREEN=1`, end of run produces:

```
tests/results/tier-2-5/
├── report.html               # open this
├── videos/
│   └── <test-id>.webm        # one per test that captured ≥1 beat
└── thumbs/
    └── <test-id>/
        ├── 0000.jpg
        ├── 0001.jpg
        └── ...
```

`tests/results/tier-2-5/` is in `.gitignore`. Wipe it freely.

## See also

- [tests/e2e/ui/bg-wait-steer-flow.spec.ts](../tests/e2e/ui/bg-wait-steer-flow.spec.ts) — the canonical worked example.
- [tests/e2e/mock-agent-core.mjs](../tests/e2e/mock-agent-core.mjs) — the mock LLM, header comment lists the full trigger contract.
- [docs/testing-strategy.md](testing-strategy.md) — when to use Tier 2.5 vs unit / E2E / manual integration.
- [docs/design/unified-message-ordering-reducer.md](design/unified-message-ordering-reducer.md) — the reducer Tier 2.5's mock-fidelity bumps stress.
