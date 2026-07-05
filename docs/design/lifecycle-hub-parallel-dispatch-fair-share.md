# LifecycleHub: parallel provider dispatch + fair-share context budget (EXT-04 + EXT-06)

Findings: `FINDINGS.md` EXT-04 (~line 958) and EXT-06 (~line 1002) in
`~/Documents/dev/bobbit-fable-refactor/FINDINGS.md`. Both live in the same
region of `src/server/agent/lifecycle-hub.ts` (`dispatch()`) and
`src/server/agent/context-blocks.ts` (`applyBudgets`), so they shipped as one
PR (tracker W3.11 + W3.12).

## EXT-04 — serial provider dispatch stacks timeouts

`LifecycleHub.dispatch()` used to `await` each provider's hook invocation one
at a time inside a `for…of` loop. N installed context providers on the same
hook (e.g. `beforePrompt`) therefore serialized up to `sum(provider.budget.timeoutMs)`
of wall-clock latency per turn — installing more extensions structurally
penalized every turn.

### Fix

`dispatch()` now fans every provider's invocation out via
`Promise.allSettled` (see the new private `runProvider()` helper, which
encapsulates the full per-provider try/catch that used to live inline in the
loop). Turn latency becomes `max(provider timeouts)` instead of their sum, for
free — no new hub-level deadline constant was introduced; the parallel
fan-out already turns "sum of N" into "max of N", and each provider's own
`budget.timeoutMs` is still enforced individually by `ModuleHost.invoke`'s
existing per-invoke terminate-on-timeout (each invocation gets its own worker
thread and its own timer, unaffected by how many siblings are running
alongside it).

**Determinism.** `Promise.allSettled` resolves its results array in the same
order as its input array regardless of completion order — a language
guarantee, not a race. `dispatch()` relies on this: it rebuilds `collected`
blocks, `diagnostics`, and `traceStates` by iterating `providers[i]` /
`settled[i]` together, so the merged block list, the returned diagnostics, and
the persisted `TraceEntry.providers[]` rows are all in **registration order**,
byte-identical to the pre-fix serial code — never completion-timing order.
Pinned by `tests/lifecycle-hub.test.ts`:
- *"dispatches providers concurrently against a shared deadline, not serial
  timeout-stacking"* — proves two providers actually start within the same
  wall-clock window (via `Date.now()`, which — unlike `performance.now()` — is
  comparable across worker threads).
- *"keeps registration-order determinism when a later-registered provider
  finishes first"* — a provider registered first but finishing last still
  produces `["slow", "fast"]` in both the returned blocks and the trace row
  order.

**Flag decision: default-ON, no feature flag.** This is a latency-only change
with provably byte-identical output ordering in the no-timeout happy path (the
pre-existing "merges provider blocks, applies budgets, and forces provenance"
test continues to pass unmodified — that is the equivalence pin). The
per-provider timeout *contract* is unchanged (same `ModuleHost.invoke`
mechanics, same `budget.timeoutMs`, same t0-per-provider accounting); the only
externally observable difference is that dispatch **which providers succeed
under real machine contention** could shift under heavy concurrent CPU load
(more worker threads spawned at once competing for cores) — an operational
risk, not a logic bug, and one that was already present any time the server
handles concurrent sessions. Given the size of the latency win and the
absence of any output-shape change, this shipped default-ON rather than behind
a flag.

**CLF coordination note.** The tracker flags a future coordination point:
*"LifecycleHub parallel provider dispatch (CLF: shared-deadline race lands
with model-backed cascade)"* — a later wave may run per-provider classifiers
(`dispatchDecision`, EXT-05 core) alongside this fan-out. That is safe by
construction: ordering here is keyed off the **static** `providers` array
index, never off completion timing, so a classifier cascade can be layered on
without touching the determinism guarantee above.

## EXT-06 — one shared greedy budget can fully starve a low-priority pack

`applyBudgets` (in `context-blocks.ts`) sorted every candidate block from every
provider into one global priority queue and applied a "stop entirely after the
first truncation" rule. A single high-priority pack with oversized demand
could trigger that stop early, silently dropping **every** lower-priority
pack's blocks afterward — even a tiny block that would have trivially fit in
the headroom the greedy pack left behind. There was no signal (to the
operator or the pack) that this had happened.

### Fix — two-phase fair-share allocation

`applyBudgets` now runs in two phases:

1. **Guarantee pass.** Each *contributing* pack (a distinct `providerId`
   present in the candidate blocks) is reserved up to
   `floor(globalMax / N)` of the shared budget, spent on **that pack's own**
   blocks in **that pack's own** priority order. Only whole blocks are
   admitted here — a block too large for the guarantee is deferred to phase 2
   rather than truncated down to a possibly-useless fair-share-sized sliver,
   so it gets a shot at the pack's *full* (non-fair-share-capped) budget
   instead.
2. **Leftover pass.** Whatever of the global budget phase 1 left unspent
   (packs that asked for less than their fair share) is handed out by
   **global** priority order across everything phase 1 deferred — this is the
   pre-existing greedy/truncate-then-stop policy, just running on the
   remainder instead of the whole budget.

The final `kept` list is re-sorted by `(priority desc, original index asc)`
regardless of which phase picked a given block, so callers (prompt rendering,
existing tests) see the same priority-ordered contract as before — the
two-phase split is purely internal bookkeeping.

**Byte-identical for a single contributing pack.** With `N=1`,
`fairShare === floor(globalMax/1) === globalMax`, so the guarantee cap never
binds tighter than the pre-fix single-phase algorithm already did. All four
pre-existing `tests/context-blocks.test.ts` cases (single- and dual-provider)
pass **unmodified** — see that file's git history for this PR: no existing
assertion was edited, only new cases were appended.

**Transparency marker.** A provider that returned valid candidate blocks but
ends up with **zero** kept blocks purely because the shared budget had no room
left for it (no thrown error, no timeout, nothing malformed) now gets an
explicit `"context omitted: shared budget exhausted"` entry in both the
returned `HubDiagnostic[]` and the persisted `TraceProviderRow.error` for that
provider (`lifecycle-hub.ts`, `STARVATION_MARKER`). This only fires when
nothing else already explains the zero — a real error/timeout takes
precedence over the starvation marker.

**No behavior change to the global cap itself** — `globalMaxTokens` (default
4000) is untouched; this fix only changes *how* the existing cap is
apportioned across contending packs.

### Tests

- `tests/context-blocks.test.ts`: `"fair-share floor: a low-priority pack's
  small block is no longer starved…"`, `"N packs, one greedy: the greedy pack
  no longer starves the rest"`, and `"a single contributing pack degrades to
  the pre-fix single-phase algorithm"` (the N=1 equivalence pin).
- `tests/lifecycle-hub.test.ts`: `"marks a fully-starved provider… in
  diagnostics and the trace"`.
