# Listener & Timer Cleanup Standardisation

Status: proposal — Phase 1 not yet landed.
Owner: goal `standardise-listener-cleanup` (`goal/standardis-7465ad1d`).

## 1. Motivation

A grep of `src/ui/` + `src/app/` finds **128** `addEventListener` sites against only **78** `removeEventListener` / `AbortController` references — roughly 40 % of listener bindings have no greppable cleanup partner. Timers are worse: 127 `setTimeout` / `setInterval` sites with no consistent paired-clear pattern. The leak compounds across SPA navigation (session ↔ goal ↔ settings switching), where components are repeatedly connected and disconnected from the DOM.

This pattern is the suspected source-of-truth for several recurring debug-index entries:

- **Stop button stuck visible / duplicate user message on second send** — see [`docs/design/unify-session-status.md`](unify-session-status.md). A status-mutation listener that survives a session swap will replay stale state.
- **Scroll snaps back / tail-chat lost / false-positive Jump** — see [`docs/design/tail-chat-redesign.md`](tail-chat-redesign.md). The cited prohibition on magic-delay flags (`_programmaticEchoes`, `_settleWindow*`, `_suppressJumpUntilTs`) keeps coming back in disguise *because* there is no convention for reliably tearing down scroll listeners on disconnect — authors paper over the leak with timing flags instead of fixing the binding lifetime.
- **UI freezes after Docker container recreated / sandbox respawn drops events** — see [`docs/design/sandbox-recovery-frame-of-reference.md`](sandbox-recovery-frame-of-reference.md). In-place agent respawn relies on subscribers staying attached for exactly one lifetime; orphaned listeners from previous spawns observe stale `lastSeq` snapshots.

The fix is not per-site bandaids. It is a single, lint-enforceable convention.

## 2. Convention

**One `AbortController` per component lifecycle. Every `addEventListener` passes `{ signal }`. Every timer is registered against the same signal.**

### 2.1 `BobbitElement` base class

All Bobbit web components extend `LitElement` (`lit@^3.3.1`), not `HTMLElement` directly. `BobbitElement` therefore extends `LitElement` and chains through Lit's reactive lifecycle hooks (`connectedCallback` / `disconnectedCallback`), which Lit explicitly supports as long as `super` is called.

```ts
// src/ui/components/base/BobbitElement.ts
import { LitElement } from "lit";

export abstract class BobbitElement extends LitElement {
  // Recreated on every (re)connection. Aborted on disconnect.
  // Marked non-public; subclasses access via the `signal` getter.
  #lifecycle: AbortController = new AbortController();

  protected get signal(): AbortSignal {
    return this.#lifecycle.signal;
  }

  /** Subclasses override and call super.connectedCallback() FIRST. */
  override connectedCallback(): void {
    if (this.#lifecycle.signal.aborted) {
      // Re-attach: replace the spent controller.
      this.#lifecycle = new AbortController();
    }
    super.connectedCallback();
  }

  /** Subclasses override and call super.disconnectedCallback() LAST. */
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#lifecycle.abort();
  }

  /** Escape hatch for subclasses that need to abort early (e.g. on close()). */
  protected abortLifecycle(): void {
    this.#lifecycle.abort();
  }
}
```

Notes:

- `super.connectedCallback()` / `super.disconnectedCallback()` are mandatory — Lit relies on them to wire up the reactive update queue. Subclasses follow the same rule when overriding.
- The controller is **recreated** on `connectedCallback` if it was aborted, so reusable elements that move around the DOM (e.g. `ToolGroup`, `MessageEditor`) work transparently. First connect is a no-op (controller is fresh from the field initialiser).
- `signal` is a getter (not a field), so subclass code that captures `const signal = this.signal` *before* re-attach receives a stale signal — that is intentional: capture inside the binding call site, not in the constructor.
- `disconnectedCallback` aborts unconditionally after `super`; it is safe to call `abort()` on an already-aborted controller.
- This base class is **purely additive** to Lit — it does not touch `render()`, `update()`, or reactive properties. Existing `@customElement` / `@property` / `@state` decorators on subclasses continue to work unchanged.

### 2.2 `LifecycleTimers` helper

A thin wrapper for `setTimeout` / `setInterval` that ties the timer to an `AbortSignal`. Either form below is acceptable; we standardise on the helper because it makes the lifetime relationship visible in greps.

```ts
// src/ui/components/base/lifecycle-timers.ts
export function onAbort(signal: AbortSignal, fn: () => void): void {
  if (signal.aborted) { fn(); return; }
  signal.addEventListener("abort", fn, { once: true });
}

export class LifecycleTimers {
  constructor(private readonly signal: AbortSignal) {}

  setTimeout(fn: () => void, ms: number): number {
    const id = window.setTimeout(fn, ms);
    onAbort(this.signal, () => window.clearTimeout(id));
    return id;
  }

  setInterval(fn: () => void, ms: number): number {
    const id = window.setInterval(fn, ms);
    onAbort(this.signal, () => window.clearInterval(id));
    return id;
  }

  raf(fn: FrameRequestCallback): number {
    const id = window.requestAnimationFrame(fn);
    onAbort(this.signal, () => window.cancelAnimationFrame(id));
    return id;
  }
}
```

Subclasses that want timers instantiate `new LifecycleTimers(this.signal)` once per connection (or lazily inside `connectedCallback`).

### 2.3 BEFORE / AFTER — `GitStatusWidget.ts`

**Before** (representative shape — current code uses Lit, decorators, and 5 `addEventListener` / 4 `removeEventListener` calls plus a `setInterval` with no greppable clear):

```ts
@customElement('git-status-widget')
export class GitStatusWidget extends LitElement {
  private _onWindowFocus = () => this._refresh();
  private _onVisibility  = () => this._refresh();
  private _pollId: number | null = null;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("focus",      this._onWindowFocus);
    document.addEventListener("visibilitychange", this._onVisibility);
    this._pollId = window.setInterval(() => this._refresh(), 30_000);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("focus",      this._onWindowFocus);
    document.removeEventListener("visibilitychange", this._onVisibility);
    if (this._pollId != null) window.clearInterval(this._pollId);
    this._pollId = null;
  }
}
```

**After**:

```ts
@customElement('git-status-widget')
export class GitStatusWidget extends BobbitElement {
  override connectedCallback() {
    super.connectedCallback();
    const { signal } = this;
    const timers = new LifecycleTimers(signal);

    window.addEventListener("focus",            () => this._refresh(), { signal });
    document.addEventListener("visibilitychange", () => this._refresh(), { signal });
    timers.setInterval(() => this._refresh(), 30_000);
  }
  // No disconnectedCallback override needed — base class aborts the signal
  // (after calling super.disconnectedCallback()).
}
```

Decorators, reactive properties, and `render()` are unchanged. Migration is purely a swap of the binding mechanics.

Net effect: -1 `disconnectedCallback`, -2 stored handler refs, +0 leaks possible because every binding is bound to `signal`.

## 3. Lint / static-check design

We pick **a custom AST scan in `tests/listener-cleanup.test.ts`** over an ESLint custom rule.

Justification:

- The repo already runs `tsc` via `npm run check` and Node-runner unit tests via `npm run test:unit`, both of which gate CI. There is no existing ESLint config wired to CI; standing one up just for one rule is more friction than benefit.
- The check is a simple AST predicate: `CallExpression` whose callee is `addEventListener`, with fewer than 3 args **or** whose 3rd arg lacks a `signal` property. The TypeScript compiler API is **already a direct dependency** (`typescript@^5.7.3`) and is what `npm run check` uses; we use `ts.createSourceFile(...)` + a manual recursive `forEachChild` walker. **No new dependency.** (An earlier draft of this doc claimed `ts-morph` was a transitive dep — it is not, and we do not need it; raw `typescript` is sufficient for a predicate this small.)
- A test file gives us co-location with the leak-regression test (Section 4) and makes the allowlist a plain text file under `tests/fixtures/`.

### 3.1 Allowlist format

Path: `tests/fixtures/listener-cleanup-allowlist.txt`. One repo-relative path per line, `#` comments allowed. Phase 1 lands the file with **all 19 currently-listening files in `src/ui/components/` exempt**, so the rule passes immediately. Each phase-2/3 migration commit removes exactly one line; the rule tightens monotonically.

```
# tests/fixtures/listener-cleanup-allowlist.txt
# Files exempt from the {signal} requirement until migrated.
# Remove a line in the same commit that migrates the file.
src/ui/components/AgentInterface.ts
src/ui/components/SandboxedIframe.ts
src/ui/components/GitStatusWidget.ts
# ...
```

The test fails with a diff-style message: *"file X uses addEventListener without `{ signal }` and is not on the allowlist"*. New files in `src/ui/components/**` that are **not** on the allowlist must comply from day one — this is the ratchet.

`src/app/**` is **not** scanned by the same rule (those files are audited per Section 5 instead).

## 4. Listener-leak regression test design

Path: `tests/listener-leak-regression.spec.ts`. Playwright `file://` fixture per the existing pattern (`tests/fixtures/*.html` loaded via `page.goto("file://...")`).

### 4.1 Harness

A single fixture page imports each migrated component module and exposes a `mountAndDispose(tag, attrs)` helper. Before any component is loaded the page wraps `EventTarget.prototype.addEventListener` / `removeEventListener` to maintain a per-target counter:

```ts
// in fixture HTML <script>
(function installListenerProbe() {
  const counts = new WeakMap<EventTarget, number>();
  const origAdd = EventTarget.prototype.addEventListener;
  const origRm  = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    counts.set(this, (counts.get(this) ?? 0) + 1);
    // If {signal} provided, decrement on abort so the counter tracks live refs.
    const signal = (opts && typeof opts === "object") ? opts.signal : undefined;
    if (signal) signal.addEventListener("abort", () => {
      counts.set(this, Math.max(0, (counts.get(this) ?? 0) - 1));
    }, { once: true });
    return origAdd.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    counts.set(this, Math.max(0, (counts.get(this) ?? 0) - 1));
    return origRm.call(this, type, fn, opts);
  };
  (window as any).__listenerCounts = counts;
  (window as any).__totalLiveListeners = (targets: EventTarget[]) =>
    targets.reduce((n, t) => n + (counts.get(t) ?? 0), 0);
})();
```

The probe is installed *before* component modules are imported so it captures every binding from construction onward.

### 4.2 Per-component assertion

For each migrated component:

```ts
test("GitStatusWidget releases listeners on disconnect", async ({ page }) => {
  await page.goto("file://" + fixture("listener-leak.html"));
  const baseline = await page.evaluate(() =>
    (window as any).__totalLiveListeners([window, document]));

  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => {
      const el = document.createElement("git-status-widget");
      document.body.appendChild(el);
      document.body.removeChild(el);
    });
  }

  const after = await page.evaluate(() =>
    (window as any).__totalLiveListeners([window, document]));
  expect(after).toBe(baseline);
});
```

Asserts that 10 mount/unmount cycles produce zero net listener growth on the long-lived globals (`window`, `document`). The component's own internal `EventTarget`s are GC'd with the element so they need not be probed. Test is added in Phase 2 alongside the first migrated component and grows entries as each subsequent file migrates.

## 5. Migration plan — file audit

Counts measured at `c84b4675` via `grep -c addEventListener` and `grep -c removeEventListener` / `AbortController`.

### 5.1 `src/ui/components/**`

| File | `addEventListener` | Cleanup pattern | Target phase |
|---|---:|---|---|
| `AgentInterface.ts` | 9 | explicit `removeEventListener` (9) | Phase 2 |
| `SandboxedIframe.ts` | 9 | explicit `removeEventListener` (9) | Phase 2 |
| `GitStatusWidget.ts` | 5 | partial `removeEventListener` (4) | Phase 2 |
| `MessageEditor.ts` | 2 | partial `removeEventListener` (2) | Phase 2 |
| `Messages.ts` | 4 | partial `removeEventListener` (4) | Phase 3 |
| `BgProcessPill.ts` | 3 | partial `removeEventListener` (2) | Phase 3 |
| `sandbox/RuntimeMessageRouter.ts` | 2 | partial `removeEventListener` (1) | Phase 3 |
| `sandbox/ConsoleRuntimeProvider.ts` | 2 | none | Phase 3 |
| `sandbox/RuntimeMessageBridge.ts` | 1 | explicit `removeEventListener` (2) | Phase 3 |
| `review/ReviewDocument.ts` | 2 | explicit `removeEventListener` (2) | Phase 3 |
| `review/AnnotationPopover.ts` | 2 | explicit `removeEventListener` (2) | Phase 3 |
| `review/ReviewPane.ts` | 1 | explicit `removeEventListener` (1) | Phase 3 |
| `review/AnnotationStore.ts` | 1 | none | Phase 3 |
| `VerificationOutputModal.ts` | 2 | `AbortController` (2) | Phase 3 (already close, just rebase onto base class) |
| `ProjectPickerPopover.ts` | 2 | explicit `removeEventListener` (2) | Phase 3 |
| `ToolGroup.ts` | 1 | explicit `removeEventListener` (1) | Phase 3 |
| `SearchBox.ts` | 1 | explicit `removeEventListener` (1) | Phase 3 |
| `DiffBlock.ts` | 1 | explicit `removeEventListener` (1) | Phase 3 |
| `ContinueSessionChooser.ts` | 1 | explicit `removeEventListener` (1) | Phase 3 |

19 files, 50 listener bindings. `VerificationOutputModal.ts` already uses an `AbortController` and is the only "close" case today.

### 5.2 `src/app/**` hot files

| File | `addEventListener` | Cleanup pattern | Target phase |
|---|---:|---|---|
| `session-manager.ts` | 9 | partial `removeEventListener` (1) + 4 `AbortController` | Phase 5 |
| `follow-tail.ts` | 7 | none | Phase 5 (also Phase 2 if hot-listed) |
| `render.ts` | 6 | none | Phase 5 |
| `goal-dashboard.ts` | 6 | partial `removeEventListener` (2) + 2 `AbortController` | Phase 5 |
| `dialogs.ts` | 2 | explicit `removeEventListener` (2) | Phase 5 |
| `remote-agent.ts` | 1 | partial `removeEventListener` (1) | Phase 5 |

These modules bind to long-lived globals (`window`, `document`, the WebSocket) and are not web components, so `BobbitElement` does not apply directly. Each binding falls into one of two buckets:

- **App-lifetime** — listener correctly outlives any session/dialog (e.g. global keyboard shortcut, online/offline). Annotate `// app-lifetime listener` and leave bound for the page lifetime.
- **Scoped** — tied to a session, goal, dialog, or modal. Caller passes an `AbortController` (or `AbortSignal`) into the function that registers the listener, and aborts when the scope ends.

`follow-tail.ts` is called out in the goal as a Phase 2 hot file. It is implemented as plain functions, not a component; the migration is to thread an `AbortSignal` argument through the public entry points (`installFollowTail(...)` etc.) and convert each `addEventListener` to use it. Caller is `AgentInterface`, which already has `this.signal` once Phase 2 lands.

## 6. Phasing

Each phase = 1 PR. Within Phases 2 and 3, **one file per commit** so reverts stay surgical.

- **Phase 1 — foundation.** Add `BobbitElement`, `LifecycleTimers`, `onAbort`, the AST test, and the empty allowlist (all 19 component files exempt). Zero behaviour change. Smallest possible PR.
- **Phase 2 — hot files.** The goal spec orders these as: `AgentInterface.ts`, `SandboxedIframe.ts`, `GitStatusWidget.ts`, `MessageEditor.ts`, then thread `AbortSignal` through `follow-tail.ts`. **We swap the order so the regression-test harness lands first against the smallest component**: `GitStatusWidget.ts` migrates *first* (alongside the leak-regression test infrastructure), then `MessageEditor.ts`, then `SandboxedIframe.ts`, then `AgentInterface.ts`, then `follow-tail.ts`. Rationale: `AgentInterface.ts` is the largest and most behaviour-sensitive file (scroll invariant, two-flag state machine); landing the regression test against it as the very first migration is unnecessarily risky. The goal spec's ordering is a suggestion, not a contract — completeness of Phase 2 is what matters. Each commit still removes exactly one file from the allowlist.
- **Phase 3 — long-tail components.** The remaining 14 files in `src/ui/components/**`. Each commit removes one allowlist entry and adds an entry to the leak-regression test.
- **Phase 4 — allowlist removal.** Once `src/ui/components/**` is empty in the allowlist, delete the allowlist file and tighten the AST test to fail on *any* offending site under `src/ui/components/**`. New components are now compliant by default.
- **Phase 5 — `src/app/` audit.** Walk the six hot files (Section 5.2). For each `addEventListener`: add `// app-lifetime listener` if global, else accept an `AbortSignal` parameter on the calling function and route it from the owning component. No allowlist for `src/app/**`; the audit is a one-shot, reviewed PR.

## 7. Constraints

- **Incremental.** The AST test is a ratchet, not a flag day. PRs land independently; the goal does not block on a single mega-migration.
- **No observable behaviour change.** This work is mechanical — swap how listeners are bound, not what they do. Bug fixes for the cited debug entries (`unify-session-status`, `tail-chat-redesign`, `sandbox-recovery-…`) belong to their own design docs.
- **Preserve the `AgentInterface` scroll invariant.** The two-flag `_isAtBottom` / `_escapedFromLock` model in `docs/design/tail-chat-redesign.md` is load-bearing. The Phase 2 migration of `AgentInterface.ts` only swaps the *binding mechanics* (handler-ref + `removeEventListener` → `{ signal }`); the scroll state machine is not touched.
- **Forbidden-pattern guard.** `_programmaticEchoes`, `_settleWindow*`, `_suppressJumpUntilTs` remain prohibited per `tail-chat-redesign.md`. This goal does not introduce a new lint check for them — the existing prohibition is documented and sufficient. If the migration ever tempts an author to reintroduce a magic-delay flag, that is a sign the listener convention is being misapplied (use `signal`, not a timing flag).

## 8. Open questions

1. **Re-attach semantics for `MessageEditor` and `ToolGroup`.** Both elements may get reparented during list re-renders. Is the "abort on disconnect, recreate on connect" model correct for them, or do callers rely on internal state (typed text, expand/collapse) surviving DOM moves? If the latter, we need a separate `cleanup()` method distinct from disconnect. **This question must be resolved before `MessageEditor.ts` is migrated in Phase 2** (it is the second file in the revised Phase 2 order). Resolution: read `Messages.ts` re-render path during the same PR that migrates `MessageEditor`, and if internal state survival is required, document the divergence (e.g. keep listener handler refs alive across disconnect, but still bind via `{ signal }` so abort cleanly disconnects them when the element is finally destroyed). The two concerns are orthogonal — `BobbitElement` does not require state to be discarded; it requires *listeners* to be released.
2. **`AnnotationStore.ts` is not a `HTMLElement`.** It uses `addEventListener` on its own custom `EventTarget`. Does it need `BobbitElement` semantics, or is it already lifetime-bounded by its owning `ReviewPane`? Likely just accepts an `AbortSignal` in its constructor — confirm during Phase 3.
3. **AST test runtime cost.** Parsing every file in `src/ui/components/**` on each `npm run test:unit` run is fine today (~20 files), but the test should be a single Node-runner test, not one-per-file, to keep the suite under the 30 s budget.
4. **Should `src/app/follow-tail.ts` migration land in Phase 2 or Phase 5?** The goal lists it in Phase 2 hot files, but it is not a component. The plan above treats it as Phase 2 (signal-threading work) since `AgentInterface` is its only caller and the two are tightly coupled. Confirm before starting Phase 2.
5. **Worker / `MessagePort` listeners.** `SandboxedIframe.ts` and the `sandbox/Runtime*` modules attach listeners to `MessagePort`s and `Worker`s, not just `window`. `{ signal }` is supported on these targets in modern browsers — verify our minimum browser baseline (the repo currently targets evergreen Chromium per Playwright config) before relying on it.
