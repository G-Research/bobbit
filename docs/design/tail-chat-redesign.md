# Tail-chat reliability — Issue Analysis & Redesign

Goal: replace the layered, partially-overlapping scroll-lock defenses in
`src/ui/components/AgentInterface.ts` with a single coherent model that keeps
the chat viewport pinned to the bottom across (1) tool-use card insertion,
(2) tool-result expansion, and (3) session navigate.

The proposal-panel variant in `src/app/follow-tail.ts` is **out of scope**.

---

## Outcome of the use-stick-to-bottom port

*Supersedes the rest of this document.* The post-PR-#468 regressions
(false-positive Jump button on Chromium desktop and tail-chat lost mid-
stream on iOS PWA) were resolved by porting the
[`use-stick-to-bottom`](https://github.com/stackblitz-labs/use-stick-to-bottom)
algorithm (731⭐, powers bolt.new) into vanilla TypeScript inside
`AgentInterface.ts`. The historical inventory and analysis below remain
for context, but the implementation no longer matches the section 6
proposal verbatim — the upstream library's empirically-tested model
turned out to handle several races we hadn't fully spelled out.

### New state model

| Field | Role |
|---|---|
| `_isAtBottom: boolean` (default `true`) | Sticky intent. Toggleable by gestures, RO callback, jump-to-bottom click. |
| `_escapedFromLock: boolean` (default `false`) | True ONLY after a user-driven scroll-up that takes the viewport OUT of the near-bottom band. Cleared by jump-to-bottom click, sendMessage, session navigate, near-bottom auto-relock, or `setAutoScroll(true)`. |
| `_resizeDifference: number` | Set by RO callback on every height delta; reset via `requestAnimationFrame(() => setTimeout(…, 1))`. The deferred scroll handler bails when this is non-zero — disambiguates resize-driven scroll events from user intent. |
| `_lastScrollTop: number` | Reference for up/down classification in the deferred scroll handler. |
| `_ignoreScrollToTop: number \| null` | Single-value latch set immediately before any programmatic `scrollTop` write. Replaces the 4-entry `_programmaticEchoes` ring buffer (deferred handler renders the ring obsolete — within one task only one programmatic write commits). |
| `_animation` | Spring rAF state used by the jump-to-bottom click landing. |
| `_lastUserGestureTs: number` | `performance.now()` of the latest wheel/touch/keydown gesture. Used by the deferred handler to gate user-vs-programmatic scroll-event classification — see "Gesture freshness gate" below. |

### Constants

- `STICK_TO_BOTTOM_OFFSET_PX = 70` — near-bottom band, matches upstream.
- Spring defaults `damping = 0.7, stiffness = 0.05, mass = 1.25` — upstream defaults.
- `USER_GESTURE_WINDOW_MS = 500` — "recent gesture" window for the freshness gate.

### Geometry getters

- `_targetScrollTop()` = `scrollHeight - 1 - clientHeight` (the `-1` is intentional, matches upstream; avoids float-rounding edge cases where the browser clamps `scrollTop` 1 sub-pixel above the integer target).
- `_scrollDifference()` = `targetScrollTop - scrollTop`.
- `_isNearBottom()` = `scrollDifference <= STICK_TO_BOTTOM_OFFSET_PX`.

### Deferred scroll handler

Fires synchronously on every `scroll` event but coalesces work into a
follow-up `setTimeout(0)` macrotask so any RO tick fired in the same
frame has had a chance to set `_resizeDifference` first. Snapshots
`(scrollTop, _ignoreScrollToTop, _lastUserGestureTs)` at dispatch time
so wheel→scroll pairs are treated atomically.

Deferred body, in order:

1. **Resize-in-flight bail.** If `_resizeDifference !== 0`, recompute the
   jump button (closes Bug A from the issue analysis: button visibility
   must be recomputed on every tick, including bail paths) and return.
2. **Echo latch.** If `scrollTop ≈ ignoreScrollToTop`, recompute the
   jump button and return.
3. **Gesture freshness gate.** If no wheel/touch/keydown gesture has
   fired within `USER_GESTURE_WINDOW_MS`, treat the scroll event as
   programmatic-from-elsewhere. If we're sticky and have drifted, queue
   a `requestAnimationFrame` re-pin; recompute the jump button; return.
   This preserves the contract that `el.scrollTop = X` (test harness or
   other on-page component) does NOT escape the lock if intent is still
   sticky.
4. **Up/down classification.** Compare to `lastScrollTop`:
   - User scroll OUT of the near-bottom band ⇒ `_escapedFromLock = true; _isAtBottom = false`.
   - Scroll down ⇒ `_escapedFromLock = false`.
5. **Near-bottom dominates.** If `_isNearBottom()`, force
   `_escapedFromLock = false; _isAtBottom = true`. Internalises
   upstream's `isAtBottom = isAtBottom || isNearBottom` public-API
   semantic so a 30-px wheel-up auto-relocks on the next content growth
   without requiring a Jump click.
6. **Recompute jump button.**

### Synchronous user-gesture handlers

- **`wheel` (deltaY < 0)**: `_isAtBottom = false`; cancel any in-flight
  spring; refresh button. Does NOT set `_escapedFromLock` synchronously
  — that decision is made by the deferred handler once scrollTop has
  actually moved, based on whether the wheel carried us out of the band.
- **`touchstart`**: cancel animation; deferred handler classifies.
- **`keydown` PageUp/ArrowUp/Home**: full escape (sets both flags) —
  these keys always carry the user out of the band on a single press.
- **`keydown` PageDown/ArrowDown/End**: cancel animation; deferred handler
  classifies (typically auto-relocks on near-bottom).

### ResizeObserver callback

1. Compute `delta = newHeight - lastObservedHeight`.
2. If `delta === 0` (width-only reflow) bail.
3. Set `_resizeDifference = delta`; schedule reset via `rAF + setTimeout(1ms)`.
4. **Overscroll clamp** (Bug E): if `scrollTop > targetScrollTop`, write
   `scrollTop = target`.
5. **Positive growth**: if `_isAtBottom && !_escapedFromLock`,
   `scrollToBottom({ animate: false })` synchronously.
6. **Negative shrink**: if `_isNearBottom() && !_escapedFromLock`,
   re-engage stick (`_isAtBottom = true`) and apply the post-collapse
   clamp inherited from the previous algorithm
   (`tests/collapse-scroll-bugs.spec.ts`).

### `scrollToBottomNow({ animate? })`

Promise-returning. With `animate: false` (default — used by RO growth,
image-load handler, session navigate, sendMessage), writes
`scrollTop = target` synchronously and resolves on the next rAF. With
`animate: true` (jump-to-bottom click only), runs a spring rAF loop
(damping 0.7, stiffness 0.05, mass 1.25) until `|delta| < 0.5 &&
|velocity| < 0.5`, re-reading the target each tick so RO growth during
the animation moves the goalpost.

### Capture-phase `load` handler

Installed once per session navigate on the scroll container. Catches
`<img>`/`<iframe>` decode reflows that fire BEFORE the next RO tick —
the load event lands on the same task as the layout commit, so pinning
synchronously here avoids a single-frame visible drift on Safari/iOS
where `overflow-anchor` has limited availability. NOT redundant with
the RO `delta>0` path: the RO callback runs on a microtask boundary
and can lag the load event by up to a frame.

### Jump-button visibility

Two-part: `!_isAtBottom && (dist > 0.5 × clientHeight)`. Recomputed at
every deferred-handler tick (including bail paths). The 50 % threshold
is legacy from `tests/e2e/ui/jump-to-bottom.spec.ts` — the 70 px
stickiness band is intentionally tighter than button visibility so a
user-driven scroll-down through the band hides the button before any
auto-relock fires.

### Sensitivity matrix

Each defense was neutered one at a time. "✅ fails" = the matching test
failed as expected; revert restored green.

| Neuter | Expected failing test | Result |
|---|---|---|
| `STICK_TO_BOTTOM_OFFSET_PX = 0` | `tail-chat-near-bottom-relock.spec.ts` | ✅ fails |
| Remove `gestureFresh` programmatic-scroll gate (treats every non-echo scroll as user intent) | `tail-chat-jump-button-false-positive.spec.ts` | ✅ fails |
| Re-add Bug A: `_refreshJumpButton` only flips TO `true` from raw geometry, never back to `false` | `tail-chat-jump-button-false-positive.spec.ts` | ✅ fails |
| Remove capture-phase `_imageLoadHandler` | `tail-chat-image-reflow.spec.ts` | ⚠️ passes in headless Chromium (RO catches the same reflow within a frame). Defense retained for documented Safari/iOS PWA race window where `overflow-anchor` is unavailable and load fires before RO; manual iOS verification documented in PR. |

### What we deliberately did not port from upstream

- **Selection guard** (`isSelecting()`). Our composer rarely overlaps
  the chat selection; would complicate the deferred-handler contract
  without a regression to point at. Defer until a real bug surfaces.
- **`ScrollBehavior: "smooth"`** override. Production CSS already
  uses `scroll-behavior: auto`; nothing to override.
- **`mergeAnimations` cache**. Single animation profile (the jump
  click); no need for the 14-line memoiser.

### Public surface preserved

- `setAutoScroll(enabled)` — routes through new flag model.
- `_stickToBottom` getter/setter and `_programmaticEchoes` array —
  legacy compat shims so existing E2E test setup (which pokes
  `ai._stickToBottom = true` and pushes echo entries) keeps working
  without a flood of test edits. Production code paths use the new
  flags directly.
- `data-testid="jump-to-bottom"` button + `style.opacity` /
  `style.pointerEvents` visibility model — unchanged.
- `overflow-anchor: none` inline style on the scroll container —
  retained. Single-contract: JS pin path is the only thing keeping the
  viewport at the tail; Chromium ≡ Safari.

---

## 1. Existing scroll mechanisms inventory (line-referenced)

All references are against `src/ui/components/AgentInterface.ts` at HEAD
of branch `goal-goal-fix-tail-c-c5ac4c6c-architect-f42377d3`.

### State fields

| Line | Field | Purpose |
|---|---|---|
| 187 | `_stickToBottom` (default `true`) | Master "should we tail" flag. Single source of truth in spirit, but mutated by 7 distinct call sites. |
| 193–194 | `_lastProgrammaticScrollTop` / `_lastProgrammaticScrollHeight` | Echo latch for browser-emitted scroll events that mirror our own `scrollTop` writes. |
| 195 | `_scrollContainer` | Cached `.overflow-y-auto` element. |
| 196 | `_resizeObserver` | Watches `.max-w-5xl` content container. |
| 197 | `_lastScrollHeight` | Cached `scrollHeight` to compute deltas. |
| 205 | `_wasAtBottomAtLastUserScroll` | Carry-over consulted in `state_update` branch when a transient scroll-up flipped `_stickToBottom` false right before a server snapshot. |
| 211–213 | `_settleWindowActive`, `_settleWindowDeadline`, `_lastSettleScrollHeight` | 3 s session-load settle window. |
| 219 | `_settleQuietTickCount` | Counts consecutive stable RO ticks for early-exit. |
| 223 | `_showJumpToBottom` | Visibility of jump-to-bottom button. |
| 229 | `_suppressJumpUntilTs` | 600 ms "don't re-show the button" deadline after the user clicks it. |

### Code paths that mutate `_stickToBottom` or call `scrollTo` / `scrollTop=`

| Line(s) | Site | Effect on flag | Programmatic scroll? |
|---|---|---|---|
| 282 | `setAutoScroll(enabled)` (public) | sets to `enabled` | no |
| 318–390 | ResizeObserver callback | reads only; writes via `_scrollToBottom()` and a manual `scrollTop = ...` for shrink-clamp (368) and grow-pin (387) | yes — both via latch |
| 471 | `setupSessionSubscription` | `= true` (session reset) | indirectly (rAF chain) |
| 489–493 | `setupSessionSubscription` rAF chain | none | three `_scrollToBottom()` calls |
| 642–675 | `_scrollToBottom()` | `= true` (line 643) + duplicates the scroll write twice (sync + rAF) | yes |
| 710 | `_handleScroll` | writes `_wasAtBottomAtLastUserScroll = _stickToBottom` (carry-over capture) | no |
| 729 | `_handleScroll` | `= geometricallyAtBottom` *unless* settle window active and not at bottom | no |
| 748 | `_handleUserIntent` (wheel/touchstart) | `= false` | no |
| 763 | `_handleScrollKeydown` | `= false` for nav keys | no |
| 780 | `_handleJumpToBottomClick` | `= true` | yes (via `_scrollToBottom`) |
| 862 | `sendMessage` | `= true` before `_scrollToBottom()` | yes |

So `_stickToBottom = true` happens at six sites, `= false` at three sites
(two of them user-intent, one of them geometry inside `_handleScroll`),
and the geometry path at 729 is the central source of fragility — any
race between programmatic write and a stale browser-emitted scroll event
that escapes the echo latch flips it to `false`.

### Observers

- **`_resizeObserver`** (318–390, attached at 393–395) observes only
  the inner `.max-w-5xl` content container, *not* the outer
  `.overflow-y-auto` viewport. Because tool cards (`message-list`,
  `streaming-message-container`) all render inside `.max-w-5xl`, their
  height growth IS observed.
- **`_pillResizeObserver`** (244, 1805–1812) — pill-strip overflow,
  unrelated to scroll.
- **`_pillStripObserver`** (236, 1835–1846) — measures pill-strip
  height for jump-button positioning, unrelated to scroll-lock.

### Event listeners

- `scroll` → `_handleScroll` (line 399). Geometry-based intent inferer.
- `wheel` → `_handleUserIntent` (line 403). Trusted user intent.
- `touchstart` → `_handleUserIntent` (line 404). Trusted user intent.
- `keydown` → `_handleScrollKeydown` (line 405). Trusted user intent.

### Timers

1. Three nested `requestAnimationFrame` calls at 491–493 (post-navigate).
2. One `requestAnimationFrame` at 662 inside `_scrollToBottom` (re-assert).
3. `_settleWindowDeadline = performance.now() + 3000` (503).
4. `_suppressJumpUntilTs = performance.now() + 600` (778) for jump-button.

All four are time-based, which is precisely what makes the system
non-deterministic across machines and load.

---

## 2. Commit history of patches

### `f8c9dece` — fix(ui): scroll lock vibration & stale message ordering (#370, 27 Apr)
The original vibration fix. Changed the ResizeObserver to ignore
`delta === 0` instead of clamping `scrollTop = scrollHeight` on every
zero-delta tick (which had been converting benign sub-pixel reflows into
a feedback loop). Introduced the `_lastProgrammaticScrollTop` /
`_lastProgrammaticScrollHeight` echo latch and removed the older
`_isAutoScrolling` timer. This established rule 1 ("auto-scroll only on
positive delta") and rule 2 ("programmatic scrolls are filtered, not
timed"). It did not address session-navigate or the geometry-based intent
flip in `_handleScroll`.

### `e0f9fafd` — Scroll-lock hardening + initial-scroll settle + Jump-to-bottom (#411, 30 Apr)
Layered five mechanical changes onto the f8c9dece foundation:
sub-pixel echo-latch tolerance (< 1 px instead of strict equality),
widened the stick-to-bottom tail from 5 px to 10 px, added the
`_wasAtBottomAtLastUserScroll` carry-over, introduced the 2 s
session-load settle window, and added the jump-to-bottom button. Each
change addressed a real bug — but the cumulative effect is the
proliferation we see today: two timers, two flags representing
overlapping concepts, and two parallel re-pin paths
(`_scrollToBottom()`'s rAF + the settle window's RO loop).

### `af046d81` — fix(ui): jump-to-bottom button + session-navigate scroll robustness (30 Apr)
Added the triple-rAF chain in `setupSessionSubscription`, bumped the
settle window from 2 s to 3 s, and tightened the early-exit condition
to "two consecutive stable ticks where we re-pinned" (instead of
"two consecutive same-height ticks"). It also added the 600 ms
`_suppressJumpUntilTs` window for jump-button click. The fact that
**a third timer was needed** to mask races between the existing two is
the smoking gun: the architecture is fighting itself.

### `3d406b86` — fix(ui): preserve stick-to-bottom during session-load settle window (30 Apr)
Realised that *during the settle window* browser-emitted scroll events
(triggered by DOM-swap reflow / async markdown / lazy images) were
flipping `_stickToBottom = false` via the geometry path in
`_handleScroll`, which then disabled the very settle-window re-pin meant
to fix this. Added a `if (_settleWindowActive && !geometricallyAtBottom)`
guard at line 726 to suppress geometry flips while the window was
active. Also widened the stick-grace band to `max(10 px, clientHeight *
0.10)` so a transient sub-pixel scroll-up didn't escape the tail.

The pattern over the four commits is unmistakable: each new patch
mitigates a race that the *previous* patch's mechanism introduced.
The settle window introduced races that needed a wasAtBottom carry-over.
The carry-over introduced races that needed a settle-window guard inside
`_handleScroll`. The jump-button click race needed a 600 ms timer. The
right move now is to delete most of this and replace it with one
deterministic event-driven loop.

---

## 3. The current scroll-lock invariant doc

`docs/internals.md` § "Chat scroll lock invariant" (lines 2171–2187)
states three rules:

1. **Auto-scroll only on positive delta.** RO callback writes scrollTop
   only when `delta > 0` and `_stickToBottom` is true.
2. **Programmatic scrolls are filtered, not timed.** Echo latch on
   `(scrollTop, scrollHeight)`, consumed once.
3. **User intent is observed, not inferred.** `wheel` / `touchstart` /
   `keydown` listeners are the only authoritative releases.

The doc then layers in: sub-pixel echo tolerance, the
`_wasAtBottomAtLastUserScroll` carry-over, and the 2/3 s settle window —
each as a separate mechanism. The doc ends with a list of
*don't-re-introduce* anti-patterns (`_isAutoScrolling`, parallel flags,
new timers), which is at odds with the current code's three timers.

The redesign keeps rules 1–3 intact and **doubles down on them** by
removing the geometry-based intent inferer and the time-based settle
window in favour of a content-driven loop.

---

## 4. Failure case root causes

### Case (1) — new tool-use card appears

Path:
- Server emits `message_update` → handler at 614 calls
  `_streamingContainer.setMessage(ev.message, !isStreaming)`.
- Lit commits the new tool_use block inside `streaming-message-container`,
  which lives inside `.max-w-5xl`.
- ResizeObserver (line 318) fires on next layout with positive delta.
- Because `_stickToBottom` is `true`, the observer writes
  `scrollTop = newScrollHeight` (line 387) and latches the target.
- Browser emits a scroll event. `_handleScroll` consumes the echo. ✓

The failure: when **two** message-updates land in quick succession (a
common pattern — e.g. a tool_use streamed in chunks, then immediately a
result), the second growth tick can write a *new* latch before the
browser has fired the first echo scroll event. The first echo arrives
with the *stale* `(scrollTop, scrollHeight)` pair; the latch now holds
the second pair; the comparison fails; the event falls through to the
geometry recompute. At that moment `scrollTop` is the *first* clamp
(`oldScrollHeight − clientHeight`) but `scrollHeight` is `newScrollHeight`.
Distance = `newScrollHeight − oldScrollHeight`, which exceeds the 10 %
stick-grace band → `_stickToBottom = false` (line 729). All subsequent
RO ticks find the flag false and stop re-pinning.

The new card extends below the fold and stays there.

**Root cause:** the echo latch holds *one* pair, but multiple programmatic
writes can be in flight before any echo event fires. The geometry path
at line 729 then mutates the master flag based on stale geometry.

### Case (2) — tool result returns and the card expands

The tool_result triggers a `message_update` that grows the existing
tool_use card's height (the result block expands inline).

- The growth IS inside `.max-w-5xl`, so the observer fires (confirmed by
  reading 393–395; the observer target is the inner content container,
  and `streaming-message-container`/`message-list` are both descendants).
- The RO callback computes positive delta, re-pins.
- The exact same race as case (1) triggers if a follow-up event lands
  before the echo scroll event resolves. In addition, syntax highlighting
  inside the tool_result is async — Shiki / highlight.js / our markdown
  pipeline can mutate the DOM after the initial result is rendered.
  The ResizeObserver fires *again* on the highlight-induced reflow.
  By that point the previous echo may or may not have been consumed,
  depending on browser scheduling. Same flip-to-false outcome.

So case (2) is **not** caused by mutations escaping the
`.max-w-5xl` subtree; it is the same multi-write echo-latch race as
case (1), aggravated by async highlighting.

### Case (3) — session navigate

Path:
- `willUpdate` sees `session` property change, calls
  `setupSessionSubscription` (line 287, 541).
- That function: resets `_stickToBottom = true`, hides jump-button,
  chains three rAFs of `_scrollToBottom()`, arms the 3 s settle window.
- Lit's first render commits the (potentially huge) message-list inside
  `.max-w-5xl`. ResizeObserver fires with massive positive delta.

Failure mode A — settle window exits too early:
- The settle window's "two consecutive quiet ticks" exit can fire as
  soon as **two RO frames** report the same `scrollHeight`. That's
  often within ~32 ms, well before lazy-loaded content (image natural
  dimensions on `<img>` decode, async syntax highlighters that yield
  to the macrotask queue, hydrated tool-content blocks fetched via
  `GET /api/sessions/:id/tool-content/...`) lands.
- After the window exits, the geometry path in `_handleScroll`
  re-engages. A queued scroll event from the navigate-time DOM swap
  with stale `(scrollTop, scrollHeight)` then flips `_stickToBottom =
  false`. Subsequent late image-load growth → observer fires →
  flag is false → no re-pin → user lands above the latest content.

Failure mode B — image and tool-content lazy load races:
- `<img>` `load` events are not observed. When an image decodes, the
  RO does see the resulting reflow inside `.max-w-5xl`, but only if the
  image is a direct descendant (it is). However, `GET /api/sessions/:id/
  tool-content/:mi/:bi` lazy hydration can occur *much* later than
  any reasonable settle deadline.
- The tightened "stable ticks" exit makes things worse for fast layouts:
  initial RO call (height = H0) → Lit render (H1, reset count) →
  syntax highlight (H2, reset) → stabilise on H2 (count=1, count=2 →
  EXIT). Image decodes 200 ms later → flag may have been flipped false
  by an interim scroll event.

**Root cause for case (3):** the settle window is a time-bounded heuristic
attempting to absorb arbitrarily-async growth. Time bounds are wrong;
the loop should terminate on observed quiet, not on a deadline, and
the geometry-based intent flip must not run during initial pin at all.

---

## 5. Test inventory (existing scroll-lock tests)

| File | What it asserts | Constraint on rewrite |
|---|---|---|
| `tests/agent-interface-scroll.spec.ts` | RO `delta === 0` must NOT clobber user `scrollTop` while `stickToBottom` true (the canonical vibration regression). | **Must still pass.** This is the heart of the no-snap-back invariant. |
| `tests/agent-interface-scroll-hardening.spec.ts` | Sub-pixel echo (< 1 px), 10-px tail, `wasAtBottom` carry-over, settle window re-anchors across staggered RO ticks, user-wheel cancels settle. | **Some constrain, some are obsolete.** The carry-over and settle-window tests assert internal mechanism details that the rewrite removes. They should be deleted or rewritten as outcome-only tests against the new model. The sub-pixel-echo and 10-px-tail behaviours can be kept as outcome assertions. |
| `tests/collapse-scroll-bugs.spec.ts` | Phantom padding after collapse; latest message visible after large collapse. | Must still pass. The shrink-clamp logic at line 366 stays. |
| `tests/scroll-anchor-shrink.spec.ts` | Shrink-while-scrolled-up does not jolt; shrink-while-stuck stays near bottom; grow-while-scrolled-up does not adjust. | Must still pass. |
| `tests/mobile-scroll-keyboard.spec.ts` | Stick-to-bottom on new content; user scroll-up unsticks; keyboard open behaviour; workflow bar unrelated. | Must still pass. |
| `tests/e2e/ui/jump-to-bottom.spec.ts` | Button shows on scroll-up, hides at bottom, click jumps + re-sticks; clean unmount. | Must still pass. The 600 ms suppression timer goes away — the test should pass by virtue of correct event sequencing instead. |
| `tests/follow-tail.spec.ts` | Proposal-panel variant. | Out of scope; do not touch. |

The rewrite preserves all *behavioural* tests. Tests that assert
*internal mechanism* (e.g. "settle window re-anchors across staggered
RO ticks") need to be replaced with outcome tests
("after the navigate, viewport is bottom-pinned within N ticks
regardless of when async growth lands").

`src/app/follow-tail.ts` audit: the proposal-panel variant uses a
WeakMap-keyed `LockState` per element with a 5-px tail and the same
three rules, but **no settle window, no carry-over, no jump button,
no multi-rAF chain**. It is the simpler, correct expression of the
rules. It does not share a root cause with the chat surface — its
re-render cadence (per Lit commit, via `queueMicrotask` from
`reconcileFollowTail`) avoids the multi-write echo race entirely.
**Out of scope. Do not touch.**

---

## 6. Proposed redesign — single source of truth

### 6.1 Single intent flag

One field, `_stickToBottom`, with a *single* mutation discipline:

- **Initialised** to `true` in the field declaration and re-asserted in
  `setupSessionSubscription` (session navigate) and `sendMessage`
  (user posts).
- **Flipped to `false` only by observed user gestures** —
  `wheel`, `touchstart`, `keydown` (PageUp/Down/Home/End/Arrow keys),
  and the *release* of the jump-to-bottom button (handled below).
  Geometry **never** flips it.
- **Flipped to `true` only programmatically** — `_scrollToBottom()`,
  `_handleJumpToBottomClick`, `setupSessionSubscription`, `sendMessage`.

Concretely, **the geometry recompute at line 729 is deleted**.
`_handleScroll`'s remaining responsibility is *only* to update the
visibility of the jump-to-bottom button. It must not mutate
`_stickToBottom`.

The `_wasAtBottomAtLastUserScroll` carry-over is **deleted**. It exists
solely to paper over the geometry path's mutation; once that path is
gone, the `state_update` branch can simply consult `_stickToBottom`.

### 6.2 Single re-pin path

Replace the four overlapping re-pin mechanisms with one method,
`_pinIfSticking()`:

```
_pinIfSticking():
  if !_stickToBottom or !_scrollContainer: return
  el = _scrollContainer
  target = el.scrollHeight - el.clientHeight
  if Math.abs(el.scrollTop - target) < 1: return  // already there, no op
  // Latch BEFORE write so the echo can be consumed.
  _lastProgrammaticScrollTop = target
  _lastProgrammaticScrollHeight = el.scrollHeight
  el.scrollTop = el.scrollHeight  // overshoot; browser clamps
```

This is called from:
1. The ResizeObserver callback when **`delta > 0`** AND `_stickToBottom`.
2. The `Lit.updateComplete` chain after every `requestUpdate` that we
   know mutates the transcript: `message_update`, `tool_execution_update`,
   `state_update`, `compaction_*`, `turn_*`, `agent_*`. Wrap the
   `requestUpdate()` calls in a tiny helper `_updateAndPin()` so this is
   automatic.
3. `setupSessionSubscription` initial pin.
4. `sendMessage`.
5. The jump-to-bottom click handler.

#### Echo-latch must hold a small queue

Replace the single-pair latch with a small ring buffer (length 4) of
recent `(scrollTop, scrollHeight)` writes. `_handleScroll` consumes the
*oldest* matching entry. This eliminates the multi-write race from
case (1) and (2) — both pending echoes are consumed even if they fire
in succession after a second programmatic write has already latched.

```
_programmaticEchoes: Array<{ top: number; height: number }> = []
// On programmatic write: push {target, scrollHeight}; cap length 4 (drop oldest).
// On scroll event: scan for an entry within 1 px tolerance; splice it; return.
//   else: it's user intent → handled by wheel/touch/key listeners.
//   geometry NEVER mutates _stickToBottom.
```

#### Termination via stabilisation, not deadline

For session-navigate, the initial pin runs a stabilisation observer
inside the existing ResizeObserver (no new observer). It tracks "ticks
since last positive delta" (`_quietTicks`). When `_quietTicks >= 3`
**and** at least 200 ms (real time) has elapsed since the navigate, OR
explicit user intent fires, the loop is considered done. The actual
*pinning* doesn't need to "finish" — pinning is just `_stickToBottom &&
RO fires`. The stabilisation merely tells us when to stop hiding
geometry-driven button-visibility recomputes (see below).

`<img>` `load` events are observed: in `setupSessionSubscription`, after
the first render, register a one-shot delegated `load` listener on
`.max-w-5xl` (capturing phase, so it catches all descendants) which
calls `_pinIfSticking()`. Removed when the next session navigate fires.

### 6.3 What gets DELETED

| Mechanism | Lines | Why it goes |
|---|---|---|
| Settle window (`_settleWindowActive`, `_settleWindowDeadline`, `_lastSettleScrollHeight`, `_settleQuietTickCount`) | 211–219, 326–354, 423–425, 502–505 | Time-bounded heuristic for arbitrarily-async content. Replaced by single re-pin path that runs on every layout-affecting event. |
| Jump-to-bottom suppression window (`_suppressJumpUntilTs`) | 229, 736–738, 778 | Mask for an echo race fixed by the ring-buffer latch. |
| Triple-rAF chain in `setupSessionSubscription` | 489–494 | Replaced by single `updateComplete.then(_pinIfSticking)` plus image-load delegate. |
| `_wasAtBottomAtLastUserScroll` carry-over | 205, 710, 750, 765, 781, 571 | Mask for geometry-based intent flips that no longer exist. |
| Geometry-based intent flip in `_handleScroll` (line 729) and the `_settleWindowActive`-aware bypass at 726 | 706–730 | Single biggest source of races. User intent is observed, not inferred. |
| Stick-grace 10 %-of-clientHeight band | 717 | No longer needed — without geometry-driven flips, no band is computed. |
| Inner `requestAnimationFrame` re-assert in `_scrollToBottom` | 662–674 | Replaced by image-load delegate + RO loop. |

### 6.4 Session navigate, redesigned

```
setupSessionSubscription:
  unsubscribe previous
  if !session: return
  _stickToBottom = true
  _showJumpToBottom = false; requestUpdate
  _programmaticEchoes = []
  await this.updateComplete
  _pinIfSticking()               // first paint
  // One-shot image-load delegate covers lazy decodes.
  _imageLoadHandler = (e) => { if (_stickToBottom) _pinIfSticking() }
  _scrollContainer.addEventListener("load", _imageLoadHandler, true)
  // The RO continues to fire on subsequent layout growth (markdown,
  // syntax highlighting, hydrated tool-content, image decode reflow).
  // Each tick with delta > 0 calls _pinIfSticking via the existing
  // observer body. No deadline.
```

The image-load delegate is removed in `disconnectedCallback` and
re-attached on each navigate (so we don't accumulate across sessions).

### 6.5 Jump-to-bottom button

`_showJumpToBottom` is recomputed in `_handleScroll` purely as a function
of geometry: `scrollHeight - scrollTop - clientHeight > clientHeight * 0.5`.
That recompute does NOT mutate `_stickToBottom`.

Click handler:
```
_handleJumpToBottomClick:
  _stickToBottom = true
  _showJumpToBottom = false; requestUpdate
  _pinIfSticking()
```

No 600 ms suppression. The ring-buffer echo latch absorbs the synchronous
+ rAF echoes correctly; once `_stickToBottom = true` and the pin write
has been latched, even if a transient growth lands before the echo
arrives, the second pin (next RO tick) re-pins, and the button geometry
recompute will see `scrollTop ≈ scrollHeight - clientHeight` → false.

### 6.6 Resulting state surface (target)

Fields kept:
- `_stickToBottom`
- `_lastScrollHeight`
- `_programmaticEchoes` (replaces the two `_lastProgrammatic*` fields)
- `_showJumpToBottom`
- `_scrollContainer`, `_resizeObserver`, `_imageLoadHandler`

Fields deleted:
- `_lastProgrammaticScrollTop`, `_lastProgrammaticScrollHeight`
- `_wasAtBottomAtLastUserScroll`
- `_settleWindowActive`, `_settleWindowDeadline`,
  `_lastSettleScrollHeight`, `_settleQuietTickCount`
- `_suppressJumpUntilTs`

Net change: **8 fields → 1 field** for the scroll-lock state surface.

---

## 7. Test strategy

All new tests live under `tests/e2e/ui/` (browser E2E using
`gateway-harness.ts`) so they exercise the real Lit pipeline + a real
browser scroll container. Each must **fail on master** before the fix
lands.

### 7.1 New tests (must fail on master)

| File | Scenario | Pass criterion |
|---|---|---|
| `tests/e2e/ui/tail-chat-tool-insert.spec.ts` | Open a session, scroll to bottom, then drive a sequence of `message_update` events that insert a new tool_use card with content tall enough to extend below the fold (use a mock or a bg-process echo loop to deterministically grow content). After each insert, await two rAFs. | `scrollTop + clientHeight >= scrollHeight - 4` (sub-pixel tail). |
| `tests/e2e/ui/tail-chat-tool-expand.spec.ts` | Same scaffold, but emit a tool_use first, then a tool_result that expands the existing card (`tool_execution_update` mid-stream). | Bottom-pinned after settle. |
| `tests/e2e/ui/tail-chat-rapid-stream.spec.ts` | Drive 10+ `message_update` events back-to-back within a single tick (use the in-process harness to feed the agent a deterministic sequence). | Bottom-pinned throughout — assert at the midpoint AND end. |
| `tests/e2e/ui/tail-chat-session-navigate.spec.ts` | Pre-create two long sessions (each transcript taller than the viewport, including markdown code blocks and at least one image). Navigate session A → session B → A → B → A. Each navigate must land at the bottom after `updateComplete + 100 ms`. | Five hops, each asserts bottom-pinned. |
| `tests/e2e/ui/tail-chat-user-scroll-up.spec.ts` | While streaming, dispatch a `wheel` event scrolling up by 200 px. Verify the jump-to-bottom button becomes visible, that subsequent `message_update` events do NOT re-pin (scrollTop preserved), then click the button and verify re-stick + tracking of new content. | All four states correct. |

### 7.2 Existing tests preserved

`tests/agent-interface-scroll.spec.ts` (vibration), `tests/scroll-anchor-
shrink.spec.ts` (shrink-clamp), `tests/collapse-scroll-bugs.spec.ts`
(collapse), `tests/mobile-scroll-keyboard.spec.ts` (mobile keyboard),
`tests/e2e/ui/jump-to-bottom.spec.ts` (button visibility). All must pass
unchanged.

### 7.3 Existing tests rewritten

`tests/agent-interface-scroll-hardening.spec.ts` currently asserts
internal mechanism (settle window re-anchors, carry-over scrolls on
state_update, etc.). Each test that names a deleted mechanism should
be **rewritten as an outcome test against the new model** — same
behavioural goal (e.g. "rapid RO ticks while user is at bottom keep us
pinned"), no reference to the removed flags. Tests that assert
mechanism-only details (e.g. "the settle window exits after two stable
ticks") should be **deleted**.

---

## 8. Files to touch / not touch

**Touch:**
- `src/ui/components/AgentInterface.ts` — the rewrite.
- `docs/internals.md` § "Chat scroll lock invariant" — replace with the
  new four-bullet model: (1) one flag, (2) one re-pin path, (3) ring-
  buffer echo latch, (4) user intent is observed.
- `AGENTS.md` debugging entry "Scroll snaps back / vibration" — point at
  the new model and explicitly note the deleted mechanisms.
- `tests/agent-interface-scroll-hardening.spec.ts` — rewrite outcome-only.
- New tests under `tests/e2e/ui/tail-chat-*.spec.ts`.

**Do not touch:**
- `src/app/follow-tail.ts` (proposal panels — different model, working).
- The jump-to-bottom button placement / styling (`_renderJumpToBottom`,
  pill-strip observers).
- The shrink-clamp logic at line 366 — it's the fix for
  collapse-scroll-bugs and is independent of the stick-to-bottom path.

---

## 9. Risks and open questions

**R1 — Ring-buffer latch sizing.** Length 4 is a guess. Under
fast-streaming bursts (10+ RO ticks before any scroll event fires) the
buffer could overflow and drop oldest entries; those echoes then fall
through to user-intent territory. Without geometry-based flips, that's
fine — they just become no-ops for `_stickToBottom`. But they DO update
button visibility. Test the rapid-stream scenario explicitly; if the
button flickers, increase the buffer to 8 or store an absolute
fingerprint per write rather than a fixed-length ring.

**R2 — Image-load delegate scope.** Listening for `load` in the capture
phase on `_scrollContainer` catches `<img>` and `<iframe>` loads, but
not `<video>` `loadedmetadata`. We don't currently render `<video>` in
chat content; if that changes, extend.

**R3 — Tool-content lazy hydration.** `GET /api/sessions/:id/tool-
content/:mi/:bi` injects HTML *after* arbitrary delays. The new model
relies on the RO firing whenever that injection grows `.max-w-5xl`. If
any lazy-content path renders into a fixed-height container that grows
*after* RO has stabilised, manual instrumentation is needed. Audit
`truncate-large-content.ts` consumers during implementation.

**R4 — Stale browser scroll events.** Browsers occasionally batch and
re-fire scroll events out of order with programmatic writes. The
ring-buffer mitigates the synchronous case but not a delayed firing
that lands after a user-intent event has already cleared `_stickToBottom`.
The new model is robust here: a stale echo arriving after user intent
just falls through and does nothing (geometry no longer mutates the
flag).

**R5 — Existing carry-over test coverage.** Some users may currently
rely on the `_wasAtBottomAtLastUserScroll` re-anchor on `state_update`.
With the carry-over deleted, a transient scroll-up that has already
flipped `_stickToBottom = false` will *not* be re-anchored on the next
server snapshot. This is correct (the user did scroll up), but if any
real path produces such transients without explicit user intent, that
path needs a separate fix. The new tests should cover state_update
behaviour explicitly.

**R6 — Mobile keyboard show/hide.** `mobile-scroll-keyboard.spec.ts`
asserts behaviour around viewport-resize from soft-keyboard show/hide.
The new model relies on the RO catching the resize. Visual viewport
resize on iOS Safari does fire RO on the content container as long as
the scroll container's height changes. Verify with the existing test
suite before declaring done.

**Open question — instrumentation gating.** During implementation,
gate diagnostic console output behind
`localStorage.bobbit_scroll_debug = "1"`. Decide before merge whether
to leave the gate in (small cost, free debugging for next regression)
or strip it (cleaner). My recommendation: leave it. The debugging
chapter in AGENTS.md should mention it.

---

## Outcome of the redesign

The plan above shipped in two passes. This section captures the
final state — what landed, what changed during implementation, and
what subsequent regression hunts taught us. Treat the rest of this
document as historical analysis; trust this section for current
behaviour.

### Production: one contract on both engines

`agent-interface .overflow-y-auto` carries inline
`overflow-anchor: none`. CSS scroll-anchoring is Chromium-only —
Safari (desktop and iOS PWA) has no implementation
([MDN: limited availability](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow-anchor)).
Leaving it on meant Chromium silently masked broken JS pin behaviour
while Safari users experienced every regression unfiltered. With
anchoring forced off everywhere, the four-rule JS model in
`AgentInterface` is the single contract on both engines; any future
regression must surface on Chromium too, where CI runs.

### `_imageLoadHandler` is gone

The capture-phase `load` listener on the scroll container — added
during the original redesign to catch lazy `<img>` / `<iframe>`
decode reflows on session-navigate — turned out to be a redundant
second write. The ResizeObserver attached to the content container
fires the same frame as the decode reflow, and its `delta > 0` branch
already routes through `_pinIfSticking()`. Two writes for the same
reflow produced an extra echo to absorb and a parallel failure mode
if either path drifted out of sync. Removing the load handler
collapses the contract back to "one re-pin path, fed by RO and the
session-event funnel". Image / iframe / Mermaid / KaTeX reflows are
now tested explicitly by `tests/e2e/ui/tail-chat-image-reflow.spec.ts`
— if RO ever stops covering the decode path, that test breaks first.

### Tests assert outcomes, not internals

Empirically demonstrated during the redesign: tests that asserted on
`_stickToBottom`, `_settleWindowActive`, or echo-buffer counts kept
passing after production paths were neutered to no-ops. Chromium's
default `overflow-anchor: auto` was hiding the bugs. The rewritten
suite asserts only what the user actually sees:

- **`expectLatestMessagePinned`** (`tests/e2e/ui/tail-chat-helpers.ts`)
  reads `getBoundingClientRect()` of the last rendered message and
  compares it to the scroll container's viewport. Two checks: the
  scroll container is within `tailPx` of the bottom, and the latest
  message's bottom is not below the viewport bottom (the canonical
  "tail-chat lost" symptom users report).
- **`disableScrollAnchoring`** cascades `overflow-anchor: none` to
  every descendant inside the test scope so Chromium-under-test
  matches Safari, forcing the JS pin path to be the only thing
  keeping the latest message visible. Production already sets
  `overflow-anchor: none` on the container; the helper is belt-and-
  braces against any nested `overflow-anchor: auto` reset.
- **Real preconditions only.** Tests drive `STREAM_BURST:N`,
  `STAY_BUSY:Nms`, real tool-result rendering, and *trusted*
  `page.mouse.wheel` events — never `dispatchEvent(new WheelEvent)`,
  never poking `_stickToBottom = true`, never seeding the echo
  buffer.
- **No private-field assertions.** If a test needs a new fact, the
  fact gets a named outcome helper alongside `expectLatestMessagePinned`.

### Sensitivity matrix (held at merge)

Each rewritten test was confirmed to fail when its corresponding
production path was deliberately neutered:

| Path neutered                                     | Tests that fail                             |
|---------------------------------------------------|---------------------------------------------|
| `_pinIfSticking()` made a no-op                   | `tail-chat-real-stream`, ≥2 rewritten specs |
| ResizeObserver `delta > 0` branch removed         | ≥2 rewritten specs                          |
| `overflow-anchor: none` reverted (Chromium auto)  | (silently passes — exposed by Safari only)  |
| Image-reflow path broken inside RO                | `tail-chat-image-reflow`                    |

The third row is why `disableScrollAnchoring` exists in the helper
file: with Chromium's default `auto`, even a fully-broken JS path can
still pin via CSS. Forcing `none` inside the test makes the JS
contract the only mechanism under test, which is what we ship to
Safari users anyway.

### Manual Safari / iOS PWA verification

The rewritten suite is CI-green on Chromium. iOS PWA verification
runs against the same code via `Add to Home Screen` and exercises
the JS pin path natively (no scroll-anchoring fallback). Any future
regression here should reproduce in CI too thanks to
`disableScrollAnchoring`; if it doesn't, the helper grew a hole and
needs widening before the underlying bug is fixed.

### Pointers for future debugging

- **Symptom: latest message slips below the fold during streaming.**
  Start at the RO `delta > 0` branch in `AgentInterface` and
  `_pinIfSticking()`. Run `tail-chat-real-stream.spec.ts` with
  `RECORDSCREEN=1` for a Tier 2.5 video; the failure point is
  usually obvious within 30 s of scrubbing.
- **Symptom: scroll snaps back while the user is mid-read.** Look at
  `_handleScroll` and the echo-ring consumption logic. The
  geometry-based intent flip is gone — if it has crept back in, kill
  it; if not, the echo ring is leaking a programmatic write.
- **Symptom: tail-chat works on Chromium, breaks on Safari.** That
  is exactly the failure mode `overflow-anchor: none` exists to
  prevent. Confirm the inline style is still on the scroll container
  in production CSS, and that no test removed it accidentally.
- **Resist re-adding any of the deleted defenses** listed in
  `AGENTS.md` and `docs/internals.md` — settle window, carry-over
  flag, suppress-jump timer, triple-rAF chain, geometry intent flip,
  10 % stick-grace band, inner rAF re-assert in `_scrollToBottom`,
  and `_imageLoadHandler`. Every one of them was eventually shown
  to be masking a bug elsewhere.
