# SessionManager setter-injection interfaces — design spike (STR-03)

**Status**: design spike, no production code changed. This document is the
deliverable.

Finding: `~/Documents/dev/bobbit-fable-refactor/FINDINGS.md` STR-03
("SessionManager is a 218-method god-class that resolves 8 circular init
dependencies via post-construction setter wiring") plus
`RECONCILIATION-2026-07-05.md`'s re-verification. The reconciliation pass
confirmed there is **no live bug**: `server.ts`'s `createGateway()` calls
every setter synchronously, before `restoreSessions()` and before
`server.listen()`, and every read site of every setter-injected field is
null-guarded. The original finding had already self-downgraded to
"Cannot reproduce the stated failure," confidence 0.50. This spike treats
STR-03 as a maintainability/testability investment, not a correctness fix,
and asks the narrow question the reconciliation queued: **extract the
interfaces `SessionManager` actually needs from its setter-injected
collaborators, mechanical and behavior-preserving, as a first step —** and
gives an honest answer on whether that step is worth taking now.

All line numbers below were verified live against `src/server/agent/`
in this worktree (`fable/d6-design-spikes`, based on `origin/aj-current`,
`session-manager.ts` currently **8,908 lines**) on 2026-07-05 — grep and
read, not recalled.

---

## 1. What actually has a setter-injection cycle (and what doesn't)

The original finding's fix sketch names three collaborators —
"OrchestrationCore/StaffManager/TeamManager" — as if they were symmetric
setter-cycle participants. Direct evidence says otherwise; only two of the
three are genuinely circular, and there's a fourth (`InboxNudger`) the
original finding didn't name at all.

### 1.1 The seven post-construction setters (full enumeration)

`grep -n "^\tset[A-Z]" src/server/agent/session-manager.ts`:

| Setter | Line | Field | Type accepted | Call site (server.ts) |
|---|---|---|---|---|
| `setOnPrCreationDetected` | 1215 | `_onPrCreationDetected` | `(session: SessionInfo) => void` | 2601 |
| `setVerificationHarness` | 1219 | `_verificationHarness` | full `VerificationHarness` class | 2793 (also `teamManager.setVerificationHarness` at 2651 — a *different* setter on a *different* class) |
| `setSandboxManager` | 1241 | `sandboxManager` | full `SandboxManager` class | 2959 |
| `setOrchestrationCore` | 1252 | `orchestrationCore` | full `OrchestrationCore` class | 2064 |
| `setInboxNudger` | 1256 | `_inboxNudger` | full `InboxNudger` class | 1991 |
| `setStaffManager` | 1260 | `staffRecordSource` | **already narrowed**: `{ getStaff(id): PersistedStaff \| undefined }` | 1957 |
| `setMarketplaceMcpResolver` / `setMarketplacePiExtensionResolver` | 2334/2338 | resolver fields | plain callback types (never classes) | 1781–1782 |
| `setExtensionChannelServices` | 1551 | `_extensionChannelServices` | `ExtensionChannelServices` (already a plain data shape) | 1903 |

Two of these (`setOnPrCreationDetected`, the marketplace resolvers,
`setExtensionChannelServices`) already take a function type or a plain data
shape — there is no class reference to narrow, nothing for this spike to
do there. `setStaffManager` already takes a hand-narrowed structural type.
That leaves three genuine "full class reference, single-digit method
surface actually used" candidates: `setVerificationHarness`,
`setSandboxManager`, `setOrchestrationCore`, plus `setInboxNudger` which the
original finding missed. `setSandboxManager` turns out NOT to be a narrow
candidate at all — see §1.3.

### 1.2 TeamManager is not part of this cycle

`grep -n "teamManager\|TeamManager" session-manager.ts` (excluding doc
comments) returns **zero** field, setter, or method-call references.
`TeamManager`'s constructor (`team-manager.ts:298`) takes `sessionManager`
as its **first positional constructor argument** — a plain,
one-directional dependency (`TeamManager → SessionManager`), not a cycle.
`server.ts:2066` constructs `teamManager` well after `sessionManager` with
no setter round-trip in either direction. Comments in session-manager.ts
(lines 342, 485, 3079) note that TeamManager *reads* certain
`SessionManager`-owned fields (prompt provenance) directly off objects
`SessionManager` already hands it — an ordinary consumer relationship, not
an injection cycle. **Correction to carry forward**: STR-03's fix sketch
should drop TeamManager from the "interfaces to extract" list; there is no
SessionManager→TeamManager edge to narrow.

### 1.3 The three real candidates, by call-site count

This is the enumeration the deliverable is built on — every method
`SessionManager` calls on each setter-injected collaborator, found by
`grep -n "\.orchestrationCore\.\|_verificationHarness\?\?\.\|\.sandboxManager\." session-manager.ts` and read at each hit:

**OrchestrationCore** — field `orchestrationCore` (session-manager.ts:1251,
comment: *"Injected by server.ts after construction (the core is built near
teamManager and needs a ref back to this manager's narrow view)"*). Genuine
cycle: `OrchestrationCore`'s own constructor (`orchestration-core.ts:404`,
`server.ts:2025`) takes `sessionManager` as a dependency
(`OrchestrationCoreDeps.sessionManager`), so `OrchestrationCore →
SessionManager` is real, and `SessionManager → OrchestrationCore` (this
setter) closes the loop. **Exactly 2 call sites, both inside
`restoreSessions()`** (session-manager.ts:5051–5052):
```ts
this.orchestrationCore.rebuildIndexFromPersisted(persisted);
await this.orchestrationCore.remindOwnersWithLiveChildren(shouldSendRestartCollectionReminder);
```
No other method call anywhere in the file. `OrchestrationCore` itself is
~700 lines with ~15 public methods (`orchestration-core.ts`); `SessionManager`
uses 2 of them.

**StaffManager** (via `staffRecordSource`) — **1 call site**
(session-manager.ts:5519, inside `restoreSession`):
```ts
getStaff: this.staffRecordSource ? (id) => this.staffRecordSource!.getStaff(id) : undefined,
```
`StaffManager`'s constructor (`staff-manager.ts:46`) takes only
`ProjectContextManager` — it has **no dependency on SessionManager at
all**, so this isn't resolving a cycle; it's deferred wiring for
construction-order convenience (`staffManager` is built at `server.ts:1956`,
well after `sessionManager` at `server.ts:1483`, because `StaffManager`
itself doesn't need to exist that early). The setter already accepts the
narrow structural type `{ getStaff(id): PersistedStaff | undefined }`
(session-manager.ts:1260) — **this one is already done**, by whoever wrote
it. It's the existence proof that the narrow-interface pattern this spike
proposes for the other two is neither novel nor risky here: it already
ships, unremarked, for the smallest of the three.

**InboxNudger** (via `_inboxNudger`) — not named in the original finding,
but the same shape: full class type, **1 call site**
(session-manager.ts:3911, inside `handleAgentLifecycle`):
```ts
if (this._inboxNudger && session.staffId) {
    this._inboxNudger.onAgentStart(session.id);
}
```
`InboxNudger`'s constructor (`inbox-nudger.ts:32`,
`InboxNudgerDeps`) takes `sessionManager` — again a genuine
`InboxNudger → SessionManager` dependency, closed by this setter, same
shape as OrchestrationCore.

**VerificationHarness** — a fourth full-class setter, but **not a good
narrow-interface candidate**: 2 direct call sites
(`_verificationHarness?.swarmGovernor.checkTokenBudget` at 4923,
`.hardKillSwarmNode` at 4932) plus a getter closure threaded into
`ArchivedWorktreeManager`'s deps bag (`getVerificationHarness: () =>
this._verificationHarness` at 1486) whose own downstream usage is unclear
without reading `archived-worktree-manager.ts`'s consumption of it. Low
call count on the SessionManager side, but `VerificationHarness` itself is
the STR-04 god-object (6,979 lines, per RECONCILIATION-2026-07-05.md) —
narrowing this one touches a different, larger problem and is out of scope
here; flagged for STR-04's own eventual spike, not this one.

**SandboxManager** — the fourth full-class setter, and the one clear
**non-candidate**: `grep -n "this\.sandboxManager\b" session-manager.ts`
returns **14 call sites** across the file (`onContainerRecovered`, `.get()`,
`.ensureForProject()`, plus passed as a whole object into `sessionFileExists`/
`sanitizeAgentTranscriptFile` helper functions that themselves accept
`SandboxManager` as a parameter type). A "narrow interface" here would end
up re-declaring most of `SandboxManager`'s own public surface — there's no
compression to be had. Leave `setSandboxManager` as-is.

### 1.4 Verdict on scope

Of seven setters, **two** (`setOrchestrationCore`, `setInboxNudger`) are
textbook cases: a real circular dependency, a full-class type accepted, and
a call-site count in the single digits. **One** (`setStaffManager`) already
has the narrow interface — it just isn't in a shared, named, reusable
location yet. **One** (`setVerificationHarness`) is real but not worth
narrowing in isolation (its value lives in the deps-bag pattern that would
also need to reach into `ArchivedWorktreeManager`'s consumption, not a
SessionManager-only change). **Three** (`setOnPrCreationDetected`, the
marketplace resolvers, `setExtensionChannelServices`) need no work — they
never held a class reference to narrow. **One** (`setSandboxManager`) is a
correctly-typed wide dependency, not a narrowing candidate.

The mechanical scope this doc recommends is therefore: **name and share
the OrchestrationCore- and InboxNudger-consumer interfaces, and give
StaffManager's existing inline type a shared, importable name.** Three
interfaces, ~5 lines of type surface between them.

---

## 2. Interface sketches

Following the repo's existing `XxxDeps` naming convention (`McpWiringDeps`,
`ArchivedWorktreeDeps`, `InboxNudgerDeps`, `OrchestrationCoreDeps` — all
already `export interface` in their owning module, per
`grep -rn "^export interface.*Deps\b" src/server/agent/*.ts`), the new
module keeps the same shape but names the *consumer* side (what
`SessionManager` calls), not the *provider* side:

```ts
// src/server/agent/session-manager-consumer-types.ts
//
// Narrow interfaces for what SessionManager actually calls on its three
// setter-injected, class-typed collaborators (STR-03). Each interface lists
// ONLY the methods session-manager.ts calls today — verified by direct grep,
// re-check before extending (see docs/design/session-manager-setter-interfaces.md §1.3).
//
// This does not change any runtime behavior: OrchestrationCore, InboxNudger,
// and the staff-record source continue to be the same concrete classes;
// SessionManager's setters and fields simply get typed against these narrower
// shapes instead of the full class type, so a test double no longer needs to
// implement (or `as any`-cast around) the other 10-15 methods it never calls.

import type { PersistedStaff } from "./staff-store.js";
import type { PersistedSessionLike, ChildHandle } from "./orchestration-core.js";

/** What SessionManager calls on OrchestrationCore. 2 call sites today
 *  (restoreSessions, session-manager.ts:5051-5052). Both param/return types
 *  below are `orchestration-core.ts`'s own exports (confirmed exported at
 *  lines 168 and 244 respectively) — no new types needed. */
export interface OrchestrationCoreView {
  rebuildIndexFromPersisted(persisted: PersistedSessionLike[]): void;
  remindOwnersWithLiveChildren(filter?: (handle: ChildHandle) => boolean): Promise<number>;
}

/** What SessionManager calls on InboxNudger. 1 call site today
 *  (handleAgentLifecycle, session-manager.ts:3911). */
export interface InboxNudgerView {
  onAgentStart(sessionId: string): void;
}

/** Already the de facto interface at session-manager.ts:1260 — this just
 *  gives it a shared, importable name so InboxNudger.ts, staff-manager.ts,
 *  and session-manager.ts don't each restate the same inline shape. */
export interface StaffRecordSource {
  getStaff(id: string): PersistedStaff | undefined;
}
```

`session-manager.ts`'s setters and fields become:

```ts
private orchestrationCore: OrchestrationCoreView | null = null;
setOrchestrationCore(core: OrchestrationCoreView | null): void { this.orchestrationCore = core; }

private _inboxNudger: InboxNudgerView | null = null;
setInboxNudger(nudger: InboxNudgerView | null): void { this._inboxNudger = nudger; }

private staffRecordSource?: StaffRecordSource;
setStaffManager(sm: StaffRecordSource): void { this.staffRecordSource = sm; }
```

`OrchestrationCore` and `InboxNudger` already structurally satisfy these
interfaces (they're a subset of each class's real public surface), so
`server.ts:2064`'s `sessionManager.setOrchestrationCore(orchestrationCore)`
and `server.ts:1991`'s `sessionManager.setInboxNudger(inboxNudger)` compile
unchanged — TypeScript structural typing does the work; no call site
changes needed at all. This is the same "mechanical, no behavior change"
property route-registry.md and the SM-decomposition cohorts hold
themselves to.

---

## 3. Where this fits the ongoing SM-decomposition

`docs/design/session-manager-decomposition.md` is already mid-flight:
**cohort 1** (archived-worktree bookkeeping →
`archived-worktree-manager.ts`, PR #130) and **cohort 2** (MCP wiring →
`mcp-wiring.ts`, PR #135) are merged on `aj-current`; **cohort 3**
(lifecycle fence) is in flight per
`~/Documents/dev/bobbit-fable-refactor/TRACKER.md`. Both merged cohorts
use the same shape this doc proposes: a `deps: XxxDeps` bag threaded
through the extracted module's constructor, referencing narrow slices of
what the god-object exposes (`McpWiringDeps`, `ArchivedWorktreeDeps`).

That pattern is the natural home for this doc's interfaces, but the fit is
partial and worth stating precisely:

- **Same idiom, opposite direction.** `McpWiringDeps`/`ArchivedWorktreeDeps`
  narrow what an *extracted* module needs from `SessionManager` (the
  god-object as provider). This doc's `OrchestrationCoreView`/
  `InboxNudgerView` narrow what `SessionManager` needs *from* its
  collaborators (the god-object as consumer) — the mirror-image problem.
  Nothing stops both directions living in the SM-decomposition family of
  modules; `session-manager-consumer-types.ts` sits alongside
  `mcp-wiring.ts`/`archived-worktree-manager.ts` as a peer, not a
  dependent.
- **No shared "deps object" to populate — these three setters stay
  setters.** The decomposition's cohorts replace *outgoing* method calls
  (`SessionManager` calling its own methods that used to live in
  `session-manager.ts`) with calls into an extracted module's `deps`
  object built once at construction. `OrchestrationCore`/`InboxNudger`/
  `StaffManager` are not being extracted from `SessionManager` — they
  already live in their own files and are injected from outside because of
  boot-ordering, not because they're a cluster of methods this doc is
  pulling out. There is no "cohort 4: consumer interfaces" method-move to
  do; **the entire mechanical change is the three type annotations above**.
  Framing this as a decomposition cohort would overstate its size.
- **Real interaction**: if a future SM-decomposition cohort ever extracts
  the "session bring-up" cluster (cluster A in the decomposition doc —
  `createSession`/`restoreSession`/`forceAbort`/`assignRole`, explicitly
  flagged there as the highest-risk, do-it-last cohort) into its own
  module, THAT module would need `OrchestrationCoreView` too (it's the
  thing calling `rebuildIndexFromPersisted` inside `restoreSessions`).
  Landing the narrow interface now, before that extraction, means the
  eventual bring-up module imports an already-named, already-narrow type
  instead of either re-deriving it or importing the full `OrchestrationCore`
  class and re-widening the surface it depends on. That's the entire case
  for sequencing this before cluster A's extraction — it is a small
  prerequisite, not a blocking one.

---

## 4. What tests pin the boot-ordering assumption today

**None.** Checked directly:

- `grep -rn "setOrchestrationCore\|setStaffManager\|setInboxNudger" tests/`
  returns zero hits — no unit test calls any of the three setters at all.
- 34 test files construct `SessionManager` directly
  (`grep -rln "new SessionManager(" tests/`); the ones inspected
  (`tests/session-manager-no-precreate.test.ts` and others) all do
  `new SessionManager()` with no arguments, `as any`-cast the instance, and
  never populate `orchestrationCore`/`staffRecordSource`/`_inboxNudger` —
  they exercise the null-guarded fallback branch, not the wired branch.
- 4 test files call `restoreSessions()` directly
  (`session-manager-claude-restart.test.ts`,
  `session-manager-delegate-restore.test.ts`,
  `session-store-orphan-cleanup.test.ts`,
  `verification-resume-restart-prompt.test.ts`); none of them reference
  `orchestrationCore`/`OrchestrationCore` at all
  (`grep -n "orchestrationCore" <each file>` → 0 hits in all four). So the
  one place in the codebase that actually calls
  `orchestrationCore.rebuildIndexFromPersisted` under test never has a
  real (or even a stub) `OrchestrationCore` wired in — it always takes the
  `if (this.orchestrationCore)` false branch.

This means the reconciliation's own confidence claim — "boot ordering
already guarantees setter-before-use" — is true **only because it's read
directly out of `createGateway()`'s source order**, not because any test
would fail if that order regressed. **This is the actual argument for
doing the interface extraction now, independent of the god-class size
argument**: a `SessionManagerOrchestrationView` (or even just
`OrchestrationCoreView`) is small enough to hand-write a trivial fake for
in a new unit test — `{ rebuildIndexFromPersisted: mock.fn(),
remindOwnersWithLiveChildren: mock.fn() }` — and assert
`restoreSessions()` calls both in order with the right args, something
that is needlessly annoying to stub against the full `OrchestrationCore`
class today (it would need a fake `sessionManager` back-reference to even
construct one, since `OrchestrationCore`'s own constructor requires it —
see `orchestration-core.ts:404`). **A pinning test for the boot-ordering
invariant is a natural, cheap follow-up once the interface lands** —
worth calling out explicitly since "add the missing test" is this repo's
own stated bar for closing out a structural finding (AGENTS.md: "If a
regression isn't caught by a test, the missing test IS the bug").

---

## 5. Migration cost estimate

| Step | Effort | Risk |
|---|---|---|
| Create `session-manager-consumer-types.ts` with the 3 interfaces (§2) | **XS** (~20 lines, no imports beyond one type) | none — new file, nothing depends on it yet |
| Re-type `orchestrationCore` field + `setOrchestrationCore` param | **XS** (1 line changed) | none — structural typing, `OrchestrationCore` already satisfies it |
| Re-type `_inboxNudger` field + `setInboxNudger` param | **XS** (1 line changed) | none — same reasoning |
| Re-type `staffRecordSource` field + `setStaffManager` param to the named `StaffRecordSource` (currently inline) | **XS** (1 line changed, cosmetic — the shape doesn't change) | none |
| `npm run check` (typecheck both changed files + every importer) | **XS** | none — this is the actual verification step; if `OrchestrationCore`/`InboxNudger` ever stop structurally satisfying the narrow view, this is exactly where it would be caught |
| New pinning test for boot-ordering (§4) | **S** (one new small test file, hand-written fakes) | none — additive, doesn't touch production code |
| **Total** | **S** (well under a day; the design/enumeration work in this doc is most of the cost, not the code change) | **low** — every step is a type annotation or a new file; zero call-site rewrites, because TypeScript structural typing makes the narrowing invisible to every existing caller |

This is dramatically smaller than the original finding's `XL`/`high-risk`
effort/risk tags — but those tags were scoped to the **full** STR-03 fix
sketch ("kill the import cycles... AND split cohesive method clusters into
collaborator objects"). The interface-extraction slice this doc scopes is
explicitly *only* the first, mechanical half of that sketch, and the
reconciliation's own text agrees this half should be attempted "before any
deeper method-cluster extraction" if it's attempted at all.

---

## 6. Decision: is this worth doing before or after SM-decomposition finishes?

**Recommendation: land it now, as a standalone few-line PR, independent of
and not blocking cohort 3.** Reasoning:

- **The cost is genuinely tiny** (§5) — this is not staged/high-risk work
  in the way the original STR-03 finding's tags implied; those tags priced
  in method-cluster extraction this doc explicitly does not attempt.
- **It has one real, near-term consumer**: the SM-decomposition's own
  future cluster-A extraction (session bring-up — `restoreSession`,
  `createSession`, `forceAbort`, `assignRole`), explicitly flagged in
  `session-manager-decomposition.md` as the last, highest-risk cohort,
  would need `OrchestrationCoreView` the moment it's attempted. Landing the
  type now means that (much larger, much later) cohort inherits an
  already-reviewed, already-named type instead of inventing one under the
  pressure of a bigger diff.
- **It doesn't conflict with cohort 3.** Cohort 3 (lifecycle fence, per
  TRACKER.md) touches `_currentRespawnGeneration`/`_restoreCoordinators`/
  `_sessionRespawnGenerations` — none of which overlap the three setters
  touched here. No file-level or logical conflict; no sequencing
  dependency either way.
- **The honest counter-argument**: on its own, with no other change riding
  along, three renamed types deliver approximately zero *user-visible*
  value — the reconciliation was right that this was the weakest of the
  six items on its short list, and if the next queue is genuinely full,
  it's defensible to let this sit. But "defensible to defer" is different
  from "not worth doing" — the fix is cheap enough that bundling it into
  whatever PR next touches `session-manager.ts`'s top-of-file field
  declarations (which cohort 3's lifecycle-fence work will touch, per
  §1.1's field list) costs nothing extra and pays down real debt: a test
  double for `SessionManager`'s orchestration behavior, and a named type
  the next decomposition cohort can just import.

**Concretely**: not urgent enough to interrupt cohort 3, but the
implementation is small enough that "after SM-decomposition finishes" is
the wrong frame entirely — it's small enough to fold into any lane that's
already touching `session-manager.ts`'s constructor/field region, whenever
that next happens.
