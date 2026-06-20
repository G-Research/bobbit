# Transient Draft State — Audit & Unified Persistence Design

Status: design (proposal). Owner: goal *Unify transient drafts*.

This document audits volatile in-progress UI state across the web client, pins
down the exact `ask_user_choices` draft-loss failure mode, and proposes a small
shared draft-state abstraction so new components stop reimplementing one-off
`sessionStorage` / `localStorage` / IndexedDB / server-draft logic.

It builds directly on the composer fix described in
[`composer-draft-persistence.md`](composer-draft-persistence.md) and the
non-blocking ask model in [`../non-blocking-ask.md`](../non-blocking-ask.md).
Read those first — this doc generalises their patterns rather than restating
them.

---

## 1. The `ask_user_choices` failure mode

### 1.1 What persists today and what does not

The non-blocking `ask_user_choices` flow already makes **submitted** answers
fully durable: the user's submission becomes a tagged user-message envelope
(`[ask_user_choices_response tool_use_id=…]`) appended to the session `.jsonl`,
broadcast to all tabs, and replayed on reload. The renderer
(`AskUserChoicesRenderer`) flips the widget to read-only "answered" mode by
scanning the transcript via `ctx.getAskResponseAnswers(toolUseId)`. This is
correct and **must not change** (constraint: submitted answers stay
transcript-backed and cross-client visible).

The gap is entirely **pre-submit** state. The interactive widget
(`<ask-user-choices-widget>`, `src/ui/components/AskUserChoicesWidget.ts`) keeps
all in-progress input in component-local Lit reactive state:

```ts
@state() private _activeTab = 0;
@state() private _focusedOption = 0;
@state() private _draft: DraftEntry[] = [];   // selections + Other text per question
@state() private _submitError = "";
```

`_draft` is (re)initialised to empty in `_ensureDraft()`, called from
`connectedCallback()` and from `willUpdate()` when the `questions` property
changes. There is **no read-back from any persistent store** — so any event
that destroys and recreates the widget DOM element resets every pending
selection and any typed "Other" text to empty.

### 1.2 When the element is recreated (and the draft is lost)

The widget lives inside the rendered transcript of `<agent-interface>`. The
element instance — and therefore its `@state` — is discarded in all of these
cases:

1. **Page reload / hard refresh.** The transcript is rebuilt from scratch. The
   pending `tool_use` re-renders as a *fresh, empty* interactive widget (no
   envelope follows it yet, so the renderer correctly chooses interactive mode).
   Every prior selection is gone.
2. **Session switch beyond the LRU cache.** The client caches at most
   `SESSION_CACHE_MAX = 10` session views (`sessionCache`). Switching away and
   cycling through >10 other sessions evicts the origin session; switching back
   recreates its `<agent-interface>` and all child tool cards from the
   transcript — the widget comes back empty.
3. **WebSocket reconnect / stream-driven re-render.** Reconnect and
   `message_*` stream events can replace transcript message objects; if Lit
   re-keys or recreates the widget element the draft is dropped. The existing
   keyboard E2E already documents a related symptom — a streaming re-render
   detaching the auto-advance `setTimeout`'s `this` because the element
   instance was swapped.
4. **Route / view changes** that unmount and remount the chat panel.

Submitted answers survive all four (transcript-backed); **pre-submit selections
survive none of them**. This is the same *class* of bug the composer draft fix
addressed (Bug 1: state trapped in a recreatable element), scoped to a different
widget.

### 1.3 Why the current E2E does not catch it

`tests/e2e/ui/ask-user-choices-ui.spec.ts` ("composite widget lifecycle")
reloads mid-flow, but it reloads **before selecting anything** and only asserts
that the pending widget re-renders *interactive* (Submit visible, Other input
visible). It never selects an option / types Other text, reloads, and asserts
those selections are still present. So the draft-loss path is unverified.

### 1.4 Reproduction path (becomes the regression test)

1. Trigger a multi-question ask (`ask_user_choices_composite`).
2. On Q1 pick a concrete option; switch to Q2 and type text into the Other
   field (auto-selecting Other). **Do not submit.**
3. Either (a) reload the page, or (b) switch to another session, cycle through
   >10 sessions to force LRU eviction, then switch back.
4. **Observed today:** the widget re-renders interactive but empty — Q1 has no
   selection, Q2's Other text is gone.
   **Expected after fix:** Q1's selection and Q2's Other text are restored; the
   widget stays interactive until submit/dismiss.

---

## 2. Shared durable draft-state store

### 2.1 Goals

- One small reusable abstraction instead of scattered ad-hoc storage calls
  (constraint).
- A clear decision rule for *which* storage tier a given draft uses, by payload
  size and sensitivity.
- Consistent keying, freshness/tombstone semantics, bounds, and cross-tab /
  reload behaviour.
- Cheap to adopt: a component should be able to seed synchronously on create and
  write on change in two or three lines.

### 2.2 Storage tiers and the selection rule

We already operate four tiers. The shared store formalises *when* to use each.

| Tier | Survives | Cross-tab? | Sync read? | Capacity | Use for |
|---|---|---|---|---|---|
| **sessionStorage** | reload, element recreation, HMR (same tab) | No | Yes | ~5 MB | Small, client-local, low-sensitivity drafts whose value is "don't lose what I just typed in *this* tab": ask selections, ephemeral widget input. |
| **localStorage** | reload, restart, across tabs | Yes | Yes | ~5 MB | Small drafts that should also survive tab close / appear in sibling tabs *and* whose persistence is intentional (rare for transient input; today used for dismissal fingerprints, sidebar filters). |
| **IndexedDB** (`AppStorage` stores) | reload, restart, across tabs | Yes | No (async) | large (10s–100s MB) | Large or binary payloads: composer attachments (`PromptDraftAttachmentsStore`). |
| **Server draft table** (`/api/sessions/:id/draft`, `sessions.json`) | reload, restart, across tabs, across devices | Yes (same session) | No (async, debounced) | small only | Drafts that must be authoritative server-side / cross-device: composer prompt text, proposal-form bodies. |

**Selection rule (apply top-down, pick the first that matches):**

1. Payload may exceed a few KB or is binary (images, extracted text) → **IndexedDB**.
2. Draft must be visible on another device / is the server's source of truth
   (prompt text, proposal bodies) → **server draft table** (with the existing
   monotonic-gen guard).
3. Draft should appear in *other tabs* of the same browser or survive tab close,
   and is small + non-sensitive → **localStorage**.
4. Otherwise (small, client-local, per-tab is acceptable) → **sessionStorage**.

`ask_user_choices` pre-submit selections fall through to **(4) sessionStorage**:
they are small, client-local, and the goal's constraints explicitly allow draft
selections to be client-local unless server persistence is justified. Submitted
answers already live in the transcript (tier "server", via the envelope), so
cross-device / cross-tab convergence of the *final* answer is unaffected; only
the in-progress scratch state needs to survive a same-tab reload / recreation.
Per-tab isolation is in fact desirable: two tabs can independently fill the same
question, and whichever submits first wins via the idempotent submit endpoint.

> Why not the server draft table for ask selections? It would add a new
> server-persisted draft type per `tool_use_id`, risk leaking partial answers
> cross-device for what is throwaway scratch state, and buys nothing the
> transcript envelope doesn't already provide once submitted. sessionStorage is
> the minimal tier that fixes the reported bug.

### 2.3 The `TransientDraftStore` abstraction

A thin, synchronous, namespaced wrapper over `sessionStorage`/`localStorage`
(the two synchronous web-storage tiers). It deliberately does **not** wrap
IndexedDB or the server draft table — those already have purpose-built,
gen-guarded modules (`PromptDraftAttachmentsStore`, `createDraftManager`,
`proposal-helpers`); the shared store complements them rather than replacing
them. The store's job is the long tail of *small client-local* drafts that today
have no home and are lost on recreation.

Proposed module: `src/ui/storage/transient-draft-store.ts`.

```ts
type DraftBackend = "session" | "local";

interface TransientDraftStoreOptions {
  /** Stable namespace, e.g. "ask". Prefixes every key. */
  namespace: string;
  /** Web-storage tier. Default "session". */
  backend?: DraftBackend;
  /** Max live entries in this namespace (LRU by updatedAt). Default 50. */
  maxEntries?: number;
  /** Max serialized bytes per entry (writes above this are dropped). Default 32 KB. */
  maxEntryBytes?: number;
  /** Tombstone TTL in ms; cleared keys stay tombstoned this long. Default 5 min. */
  tombstoneTtlMs?: number;
}

interface TransientDraftStore<T> {
  /** Synchronous read; null when absent or tombstoned. */
  load(key: string): T | null;
  /** Synchronous write; bumps updatedAt, enforces bounds. No-op over maxEntryBytes. */
  save(key: string, value: T): void;
  /** Delete + write a short-lived tombstone so a late save() can't resurrect. */
  clear(key: string): void;
  /** Drop a key entirely including any tombstone (hard delete). */
  forget(key: string): void;
}
```

#### Keying

`storageKey = "bobbit_draft/" + namespace + "/" + scopeKey`. Callers build
`scopeKey` from the entity identity. For ask: `scopeKey = sessionId + "::" + toolUseId`.
The `toolUseId` is an opaque exact-match value (may be a composite `call|fc`
form per the ask-envelope contract) and **must not be split, trimmed, or
normalised** — the store treats it as an opaque string.

Each stored record is `{ v: T; updatedAt: number; gen: number }`:

- `updatedAt` (epoch ms) drives LRU eviction.
- `gen` is a per-key monotonic counter (seeded from the loaded record) used only
  to make `save` last-write-wins deterministic and to let a freshness check
  detect a late async restore overwriting newer local input. Client-local
  sessionStorage writes are synchronous so cross-write races are rare, but the
  field keeps the model identical to the server prompt-draft guard and is needed
  when a component does an async seed (see §2.4 freshness).

#### Freshness / generation / tombstone semantics

- **Last-write-wins by gen.** `save` reads the current record, sets
  `gen = max(loadedGen, lastWrittenGen) + 1`. A write whose computed `gen` is
  not greater than the stored record's `gen` is ignored. This mirrors the
  server staleness guard so a stale async path can never clobber fresher input.
- **Tombstone on clear.** `clear(key)` deletes the value and writes a tombstone
  record `{ tombstone: true, until: now + tombstoneTtlMs }`. While a tombstone
  is live, `load` returns `null` and `save` is rejected. This prevents the
  classic resurrection bug: a debounced/async write scheduled *before* submit
  landing *after* submit would otherwise re-create a draft for an
  already-answered question. (Directly analogous to the composer's
  tombstone-on-send.) `forget` removes the tombstone too, for genuine teardown.
- **Touched-since-seed guard (caller side).** When a component seeds
  asynchronously (not needed for ask, which seeds synchronously), it tracks a
  "user edited since seed" flag and skips applying the seed if set — same
  pattern as `_draftTouchedSinceBind` in the composer.

#### Cleanup and bounds

- **Per-namespace LRU.** Every `save` enforces `maxEntries` by evicting the
  oldest entries (by `updatedAt`) in the same namespace, never the key just
  written.
- **Per-entry byte cap.** A `save` whose JSON exceeds `maxEntryBytes` is dropped
  (logged once) rather than risking a `QuotaExceededError`; oversize drafts are
  out of scope for this tier and indicate the caller picked the wrong tier.
- **Tombstone sweep.** Expired tombstones are removed lazily on the next
  `load`/`save` touching that namespace.
- **Submit/answered cleanup.** Callers call `clear(key)` when the draft is
  committed (ask submit success, or when the widget first renders read-only
  because an answer envelope already exists). Combined with LRU this bounds
  storage even if some keys are never explicitly cleared (e.g. the session was
  deleted server-side).
- All storage access is wrapped in try/catch (private-mode / quota / disabled
  storage degrade to in-memory no-op, never throw) — matching existing helpers.

#### Cross-tab / reload behaviour

- `backend: "session"` → per-tab; survives reload and element recreation within
  the tab; not shared across tabs; cleared when the tab closes. This is the ask
  default and the desired isolation.
- `backend: "local"` → shared across tabs and survives restart. A `storage`
  event listener can be exposed later if a surface needs live cross-tab mirroring
  of an in-progress draft; no current surface requires it, so it is out of scope.

### 2.4 How `ask_user_choices` uses it

In `AskUserChoicesWidget`:

- Construct one module-level store: `askDraftStore = new TransientDraftStore<DraftEntry[] & {activeTab:number}>({ namespace: "ask" })` (selections + active tab; `_focusedOption` and `_submitError` stay ephemeral — they carry no user content worth persisting).
- **Seed synchronously** in `_ensureDraft()` (already called from
  `connectedCallback` and on `questions` change): once `sessionId`, `toolUseId`,
  and `questions` are all present and the widget is **not** read-only, compute
  `scopeKey`, `load()` it, and use the stored `_draft`/`_activeTab` if shape
  matches the current `questions` (length + multi flags); otherwise initialise
  empty as today. Seeding is synchronous so there is no touched-since-seed race.
- **Persist on change**: every mutator that edits `_draft`/`_activeTab`
  (`_selectOption`, `_setOtherText`/`_onOtherInput`, `_clearActive`,
  `_selectTab`, `_clickPrimary` advance) calls `askDraftStore.save(scopeKey, …)`.
  Writes are tiny and synchronous; no debounce needed.
- **Clear on commit**: in `_submit()` on success, and at seed time when the
  widget is already read-only (`_isReadOnly()` true — an answer envelope exists),
  call `askDraftStore.clear(scopeKey)`. The tombstone prevents any late
  re-render from resurrecting the answered draft.
- Read-only mode never reads/writes drafts (answers come from the transcript).

This is additive to the widget's existing logic and changes none of its
validation, causality, or submitted-answer model (constraint).

---

## 3. Migration plan

### Phase 1 — ship the store + fix ask (this goal, high value)

1. Add `src/ui/storage/transient-draft-store.ts` (§2.3). Pure browser module,
   unit-testable via a `file://` `.spec.ts` fixture (no DOM beyond `window`).
2. Wire `AskUserChoicesWidget` to it (§2.4).
3. Add regression tests (§5).

### Phase 2 — opportunistic adoption (follow-up, lower value)

The composer (prompt text + attachments) and proposal forms already have robust,
purpose-built durable drafts; **do not** re-route them through the new store —
they correctly use the server-draft and IndexedDB tiers with gen guards, and
churning them adds risk for no gain. They remain the reference implementations
for tiers (2) and (1)/(IndexedDB).

Candidate surfaces to migrate *if/when* they prove lossy in practice (each is
currently a deliberate or low-impact exception — see §4):

- Inline review-pane comment-in-progress (`AnnotationPopover` textarea) — keyed
  by document id + anchor. Only worth it if users report losing long comments
  when the popover is dismissed by an incidental click.
- `GoalStatusWidget` bypass justification (`_bypassWhy` / `_bypassWho`).

None of these are in scope for the initial fix; they are recorded so a future
change has a documented home and a consistent tool to reach for.

---

## 4. Intentional exceptions (audited, deliberately not migrated)

Surfaces that hold component-local input but where loss-on-recreation is either
already solved or an acceptable / intended behaviour:

| Surface | State | Verdict |
|---|---|---|
| **Message composer text** (`MessageEditor` / `session-manager`) | server draft + sessionStorage mirror + gen guard | Already durable. Reference impl for server tier. |
| **Composer attachments** (`PromptDraftAttachmentsStore`) | IndexedDB, LRU + byte caps | Already durable. Reference impl for IndexedDB tier. |
| **Proposal forms** (goal/role/project/staff/tool — `proposal-panels`, `createDraftManager`, `proposal-helpers`) | server draft table, debounced, + `state` mirror | Already durable across reload/switch/restart. No change. |
| **`AnnotationPopover`** (review-pane inline comment input) | local `<textarea>` value; committed comments persist via `proposalBackend` | Exception. The *committed* comment is durable; the in-progress text is a transient floating popover whose dismissal is user-intended. Migrate only on demand (§3 Phase 2). |
| **`GoalStatusWidget` bypass form** (`_bypassWhy`/`_bypassWho`) | component `@state` | Exception. Short modal-style confirmation inside an expandable widget; an audit justification is meant to be entered and submitted in one sitting. Low payoff. |
| **`AddToInboxDialog`** (`_prompt`, title input), **`CustomProviderDialog`** (`manualModelsText`), **`SystemPromptDialog`** | dialog-local `@state` | Exception. Modal dialogs; closing intentionally discards. Persisting half-finished modal input would resurface stale data confusingly on reopen. |
| **Search / picker query state** — `DirectoryPicker`, `ProjectPickerPopover`, `SidebarActionsPopover`, `SearchBox` | `_query` / `_highlightIndex` `@state` | Exception. Search queries are intentionally ephemeral; persisting them would be surprising. |
| **Sidebar filters** (`sidebar-filters`) | already `localStorage`-backed | Already durable where intended. No change. |
| **Pure UI affordance state** — expand/collapse, copied flags, diff view mode, loading/error transients (e.g. `ThinkingBlock.isExpanded`, `ConsoleBlock.copied`, `GitStatusWidget` action flags) | `@state` | Exception. No user-authored content; recreation-to-default is correct. |

Principle for the exceptions: persist only **user-authored content** that is
costly to recreate. Affordance state, search queries, and modal scratch input
either carry no authored content or have intended discard-on-close semantics.

---

## 5. Regression test plan

### 5.1 Store unit tests — `tests/transient-draft-store.spec.ts` (browser, file://)

Pinned invariants:

- **Round-trip + isolation**: `save`/`load` round-trips a value; distinct
  `(namespace, scopeKey)` pairs never collide; opaque composite keys with `|`
  are preserved verbatim.
- **Tombstone**: after `clear`, `load` returns `null` and a subsequent `save`
  (stale, lower/equal gen) is rejected until the tombstone expires; `forget`
  removes the tombstone and allows fresh writes.
- **Gen / last-write-wins**: an out-of-order `save` with a non-increasing gen
  does not overwrite a newer value.
- **Bounds**: exceeding `maxEntries` evicts the oldest by `updatedAt` and never
  the just-written key; a write over `maxEntryBytes` is dropped without throwing.
- **Backends**: `session` vs `local` write to the correct web-storage object;
  disabled/throwing storage degrades to a no-op (no exception escapes).

### 5.2 Ask widget E2E — extend `tests/e2e/ui/ask-user-choices-ui.spec.ts`

New scenarios (the §1.4 reproduction made executable):

- **`pre-submit selections survive reload`**: trigger composite ask, pick an
  option on Q1, type Other text on Q2 (no submit), `page.reload()`, assert the
  Q1 radio is still checked and the Q2 Other input still holds the text, and the
  widget is still interactive (Submit present).
- **`pre-submit selections survive cache-evicted session switch`**: same setup,
  then create/switch through >10 sessions to evict the origin from
  `sessionCache`, switch back, assert selections restored (slow-path
  recreation). Mirrors the composer's `CT-02-f` attachment test.
- **`per-tab isolation`**: open the same pending ask in a second tab; assert tab
  2 does **not** show tab 1's unsaved selections (sessionStorage is per-tab),
  and that after tab 1 submits, tab 2 flips read-only via the transcript
  envelope (existing cross-client behaviour, re-asserted).
- **`submit clears the draft (no resurrection)`**: fill + submit; reload; assert
  read-only answered card with the submitted answers and that no interactive
  scratch state reappears.

### 5.3 Guard against regressions in unchanged behaviour

- The existing ask E2E cases (Other cleanup via Escape, indicator shapes,
  keyboard-only submission, error-chip-then-retry, legacy answers) must continue
  to pass unchanged — they pin that validation, causality, and the
  submitted-answer model are untouched (constraint).

### 5.4 Verification commands

- `npm run check`
- `npm run test:unit` (includes the new `.spec.ts` store fixture)
- Targeted ask E2E: the extended `tests/e2e/ui/ask-user-choices-ui.spec.ts`
- Broader `npm run test:e2e` (or a justified subset) for the composer/proposal
  durability tests if the shared store touches shared storage wiring.

---

## 6. File map (proposed)

| File | Role |
|---|---|
| `src/ui/storage/transient-draft-store.ts` | New: synchronous namespaced sessionStorage/localStorage draft store with gen + tombstone + LRU/byte bounds. |
| `src/ui/components/AskUserChoicesWidget.ts` | Modified: seed `_draft`/`_activeTab` from the store; persist on change; clear on submit / read-only. |
| `tests/transient-draft-store.spec.ts` | New: store unit invariants (file:// browser fixture). |
| `tests/e2e/ui/ask-user-choices-ui.spec.ts` | Extended: pre-submit draft survival across reload / cache-evicted switch; per-tab isolation; submit-clears-draft. |
| `docs/design/transient-draft-state.md` | This document. |

Existing modules referenced (unchanged): `composer-draft-persistence.md`
patterns (`session-manager.createDraftManager`, `PromptDraftAttachmentsStore`),
`proposal-helpers.ts`, `non-blocking-ask.md` / `src/shared/ask-envelope.ts`.
