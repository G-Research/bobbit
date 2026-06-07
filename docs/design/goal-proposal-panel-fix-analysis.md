# Goal proposal panel — root-cause analysis (two failure modes)

Status: analysis only (no production code changed by this document).
Scope: the **goal-assistant** ("+ New Goal") right-hand proposal panel.
Owner hand-off: a coder can implement directly from §"Proposed fix" + §"Files to change" + §"Test strategy" below.

Related design docs: [editable-proposals.md](./editable-proposals.md),
[proposal-revision-snapshots.md](./proposal-revision-snapshots.md).
Related debugging notes: `docs/debugging.md` — "Proposal panel button enabled
mid-stream", "Out-of-order proposal … widgets".

---

## 0. The one fact that explains almost everything

There are **two parallel client-side stores** for a goal proposal, and the
**goal-assistant panel reads the wrong one**:

| Store | Written by | Read by |
| --- | --- | --- |
| `state.activeProposals.goal.fields` (the unified typed slot) | unified `remote.onProposal` — fed by **all** paths: the `propose_*` tool-use scan, the server `proposal_update` WS frames (`seed`/`edit`/`rehydrate`/`restore`), and REST rehydrate | the **non-assistant** goal panel `goalProposalPanel()` via `syncProposalFormState()` (`proposal-panels.ts:2075`) |
| `state.previewTitle` / `state.previewSpec` / `state.previewCwd` (legacy form-mirror) | **only** the legacy `remote.onGoalProposal` callback (`session-manager.ts:1419`) and `restoreGoalDraft` / user edits | the **goal-assistant** panel `goalPreviewPanel()` (`proposal-panels.ts:746`, reads `state.previewTitle`/`state.previewSpec` at `proposal-panels.ts:882-883`) |

Dispatch proof: `proposalPanelForWorkspaceType()` (`proposal-panels.ts:1981`)
routes a goal proposal to `goalPreviewPanel()` **iff**
`currentAssistantProposalType() === "goal"`; otherwise to `goalProposalPanel()`.
So the "+ New Goal" flow is the *only* surface that renders from the
legacy form-mirror, and it is the surface both bug reports describe.

The legacy form-mirror (`previewTitle`/`previewSpec`) is updated **only when
the legacy `onGoalProposal` callback runs**. That callback runs from exactly one
place: `RemoteAgent._checkToolProposals` (`remote-agent.ts:1866-1873`), which
fires the unified `onProposal` **and then** the legacy callback for a
`propose_*` tool-use block. It does **not** run from:

- the WS `proposal_update` handler (`remote-agent.ts:1700-1716`) — that fires
  `this._onProposal(...)` (unified) **only**, never the legacy callback;
- `rehydrateProposalsForSession` (`session-manager.ts:2629`) — it calls
  `onProposal(...)` (unified) **only** (`session-manager.ts:2645`);
- the WS-auth rehydrate broadcast (`ws/handler.ts:395-417`) — delivered to the
  client as a `proposal_update` frame, i.e. the unified-only path above.

Every failure below is a direct consequence of that gap.

---

## 1. FAILURE MODE A — revisions show stale content

### Reproduction
Goal-assistant session. `propose_goal` (content A) → panel shows A. Then either
(a) a 2nd `propose_goal` (content B), or (b) `edit_proposal type=goal` rewriting
the spec. Panel keeps showing A; it only flips to B after the user clicks the
"Open proposal" button on the newest tool card.

### Root cause (exact paths)

**Case (b) `edit_proposal type=goal` — the deterministic failure.**
`edit_proposal` is **not** a `propose_*` tool, so
`RemoteAgent._checkToolProposals` ignores it (the guard at
`remote-agent.ts:1830` requires `toolName.startsWith("propose_")`). The only
client update for an edit is the server broadcast:
`server.ts:7835-7842` sends `proposal_update {source:"edit", rev, fields}`.
On the client that lands in `remote-agent.ts:1700-1716`, which calls
`this._onProposal(type, fields, false, rev)` and **nothing else**. The unified
`onProposal` (`session-manager.ts:1568`) updates
`state.activeProposals.goal.fields` (`session-manager.ts:1614+`) and calls
`revealProposalPanel` + `renderApp` — but it **never writes
`state.previewTitle` / `state.previewSpec`**. The goal-assistant panel renders
from those two fields, so it still shows A. Deterministic, every time.

**Case (a) 2nd `propose_goal` — the intermittent failure.**
On a live turn the message-end scan *does* fire the legacy callback
(`remote-agent.ts:1873`), so previewTitle/Spec usually update. It becomes
**stale on any replay path where the tool-use block is deduped**: blockIds are
recorded in `_processedProposalIds` and persisted to `sessionStorage`
(`remote-agent.ts:1876-1885`, restored at `remote-agent.ts:631-635`). On a WS
reconnect or snapshot replay the already-seen `propose_goal` block is skipped
(`remote-agent.ts:1842`), so the legacy callback never re-fires; the only update
is the WS `rehydrate`/`seed` `proposal_update` frame — unified-only — which
again skips the form-mirror. Result: slot is correct, panel is stale.

**Why clicking "Open proposal" fixes it (confirms the diagnosis).**
The `proposal-open` handler's `openLiveProposal` (`session-manager.ts:1672`)
explicitly invokes `cb = callbackMap[type]` → `remote.onGoalProposal(liveFields)`
(`session-manager.ts:1678-1679`). That is the legacy callback, which writes
`state.previewTitle`/`state.previewSpec` → panel refreshes. So the manual click
is doing exactly the work the WS-push path omits.

### Which write wins the race, and why it is *not* the content cause
The goal spec flags the streaming/`serverRev===undefined` rev race in the
unified `onProposal`: `nextRev = (serverRev>0 ? serverRev : prev?.rev ?? 0)`
(`session-manager.ts:1611-1613`). Analysis of the ordering:

- For a `propose_goal` the mock/real agent **awaits** the `/seed` POST before
  emitting `message_end` (`mock-agent-core.mjs:1726-1728`), so the server
  `proposal_update {seed, rev:N}` is normally enqueued to the socket **before**
  the `message_end` tool-use scan. The scan then sees `prev.rev === N` and keeps
  N. Even in the inverted order the scan only ever copies `prev.rev` forward — it
  can never write a rev *higher* than the seed and the seed always carries the
  authoritative N, so the slot **rev converges to N** and the merged **content
  converges to B** regardless of order.
- For `edit_proposal` there is no tool-use scan at all, so there is no race.

Conclusion: the rev race is a real but **secondary** defect — it can transiently
leave `slot.rev` one behind the file, which corrupts the *"Open proposal"
live-vs-historical decision* (see §3), but it is **not** what makes the panel
content stale. The content staleness is 100% the form-mirror gap in §0. The
"server-stamped `rev` is the source of truth" acceptance criterion is satisfied
by the existing `nextRev` clamp **plus** the §3 hardening; it does not require
changing the content path.

### Historical-rev-tab behaviour (the acceptance sub-clause)
When a revision arrives while the active workspace tab is a historical rev tab
(`proposal:goal:rev:N`), the unified `onProposal` else-branch
(`session-manager.ts:1643`) calls `revealProposalPanel`, which selects the
**live** current-proposal tab (`proposal-registry.ts` `revealProposalPanel` →
`selectProposalWorkspaceTab` with no `rev`). On the next render
`proposalPanelContent` (`proposal-panels.ts:2271`) sees a non-historical tab and
clears `_proposalOverride` (`proposal-panels.ts:2295-2301`). That mechanism is
correct **once the live tab actually renders the right content** — which, for
the assistant panel, it currently does not, for the §0 reason. Intended
behaviour to implement/keep: *a new revision always switches the user from any
historical rev tab back to the live editable tab and shows the newest content.*

---

## 2. FAILURE MODE B — off-screen proposal never appears

### Reproduction
Open goal-assistant session S1. Switch to a different session S2. The S1
assistant emits `propose_goal` while the user is on S2. Switch back to S1 → the
panel is empty. (Reporter: frequently stays empty even after returning, and
across reload.)

### Root cause (exact paths)

**Step 1 — the live event is dropped (and the draft is never written).**
S1's `RemoteAgent` stays alive in `sessionCache` while S2 is on screen, so S1's
`propose_goal` WS traffic is still processed. But both the unified `onProposal`
(`session-manager.ts:1569`) **and** the legacy `onGoalProposal`
(`session-manager.ts:1420`) early-return on
`if (activeSessionId() !== sessionId) return;`. Two consequences:
1. `state.activeProposals.goal` is never set for S1 (off-screen slot drop).
2. `saveGoalDraft(sessionId)` (the last line of the legacy goal branch,
   `session-manager.ts:1452`) never runs — so the IndexedDB goal draft for S1 is
   **never updated** with the new proposal. The on-disk *server* draft file *is*
   written (the agent's `/seed` POST persisted it), but the client draft is not.

**Step 2 — switch-back rehydrate restores the slot but not the panel.**
Both return paths repopulate the **unified slot only**, never the form-mirror:

- *Fast path* (cached chatPanel reuse, `connectToSession` ~`session-manager.ts:980-1145`):
  drops cross-session slots (`session-manager.ts:1023-1027`), then calls
  `rehydrateProposalsForSession(S1)` (`session-manager.ts:1110`) which GETs
  `/api/sessions/S1/proposals` (`server.ts:7952`) and dispatches each via
  `onProposal(...)` — **unified only** (`session-manager.ts:2645`). It also calls
  `restoreGoalDraft(S1)` (`session-manager.ts:1119`), but that restores the
  **stale/empty** client draft from Step 1, so `previewTitle`/`previewSpec` stay
  empty.
- *Slow path* (fresh WS connect): WS-auth rehydrate broadcast
  (`ws/handler.ts:395-417`) → client `proposal_update {rehydrate}` →
  `remote-agent.ts:1700-1716` → unified-only. Same outcome. (Buffering via
  `_bufferedProposalEvents`, `remote-agent.ts:453-471`, correctly replays the
  pre-wire frames — buffering is **not** the bug; the unified-only dispatch is.)
- *Reload*: identical to the slow path; additionally the snapshot replay's
  `_checkToolProposals` skips the deduped block, so the legacy callback never
  fires here either.

Net: on return the unified slot is correct, but the assistant panel
(`goalPreviewPanel`, reads `previewTitle`/`previewSpec`) renders empty. This is
the same §0 form-mirror gap, now reached through rehydrate instead of `edit`.

**Not the cause (ruled out, must not regress):**
- The dismissal short-circuit `isProposalDismissedTyped` (`session-manager.ts:1564`
  for first-emit; legacy `onGoalProposal` guard `session-manager.ts:1428-1431`)
  only fires when a fingerprint-identical proposal was previously dismissed; a
  never-seen off-screen proposal is not suppressed by it.
- The async `activeSessionId()` re-checks inside `rehydrateProposalsForSession`
  (`session-manager.ts:2630, 2639`) correctly abort only when the user switched
  away again; on a clean return they pass.

---

## 3. Proposed fix

### Primary fix (closes both modes) — make the unified `onProposal` the single writer of the goal form-mirror

In the unified `remote.onProposal` (`session-manager.ts:1568`), **after** the
slot is assigned and reveal side-effects run, mirror the merged goal fields into
the legacy form-mirror state when this is the goal assistant:

```ts
// after state.activeProposals[type] = slot;  (session-manager.ts ~1626)
if (type === "goal" && state.assistantType === "goal") {
  const g = merged as { title?: string; spec?: string; cwd?: string; workflow?: string };
  if (!state.previewTitleEdited && typeof g.title === "string") state.previewTitle = g.title;
  if (!state.previewSpecEdited  && typeof g.spec  === "string") state.previewSpec  = g.spec;
  if (!state.previewCwdEdited   && g.cwd) state.previewCwd = g.cwd;
  if (g.workflow) setSelectedWorkflowId(g.workflow);
  saveGoalDraft(sessionId); // persist so future fast-path restore is correct
}
```

Why this is sufficient and minimal:
- **Mode A (edit)**: the `proposal_update {edit}` frame now flows
  unified → mirror → panel re-renders with the edited spec. No manual click.
- **Mode A (2nd propose)**: redundantly correct — both the tool-scan legacy
  callback and the unified mirror now write the form-mirror; replay/dedup paths
  are covered by the unified path.
- **Mode B (all three sub-paths)**: `rehydrateProposalsForSession` (fast) and
  the WS rehydrate broadcast (slow/reload) both call unified `onProposal` → the
  mirror runs → `previewTitle`/`previewSpec` populate → panel shows the
  proposal. The `saveGoalDraft` call also repairs the never-written client draft
  so a subsequent fast-path `restoreGoalDraft` is correct too.
- Respects `previewTitleEdited`/`previewSpecEdited`/`previewCwdEdited` exactly
  like the legacy callback, so it never clobbers a user's in-progress edits.
- Does **not** touch the non-assistant `goalProposalPanel()` path (it already
  reads the slot) and does not touch project/role/tool/staff (their assistant
  panels have the *same latent pattern* but are out of scope; call this out for
  a follow-up — see §6).

Note on duplication: `_checkToolProposals` still calls the legacy
`onGoalProposal` after the unified `onProposal` (`remote-agent.ts:1866-1873`).
That remains harmless/idempotent (same edited-flag guards). Leaving it avoids
moving the goal-title summarisation (`remote.summarizeGoalTitle`,
`session-manager.ts:1443-1450`), which should stay on the tool-scan path. Do not
delete the legacy callback in this fix.

### Secondary hardening (rev correctness for the "Open proposal" button)

The transient stale-`slot.rev` window (§1) can make the newest card's
"Open proposal" open a **read-only historical** tab instead of the live tab,
because both `proposal-open` handler (`session-manager.ts:1655+`, the
`activeRev === numericRev` comparison) and
`preview-panel.selectProposalWorkspaceTab` (`preview-panel.ts:313-340`, via
`activeProposalRevForSession`) compare the requested rev against `slot.rev`.
Harden the unified `onProposal` so a no-`serverRev` tool-use scan can never
*lower* a slot rev it has already advanced:

```ts
const nextRev = (typeof serverRev === "number" && serverRev > 0)
  ? Math.max(Math.trunc(serverRev), prev?.rev ?? 0)   // never go backwards
  : (prev?.rev ?? 0);
```

This is defensive only; it does not affect the content path. (Optional: keep as
is if the team prefers — the primary fix already makes content correct.)

---

## 4. Files to change (implementation)

- `src/app/session-manager.ts`
  - Unified `remote.onProposal` (~`1568`): add the goal form-mirror block
    after the slot assignment (primary fix); optionally tighten `nextRev`
    (`1611-1613`, secondary).
  - No change required to `rehydrateProposalsForSession` (`2629`) — it inherits
    the fix because it dispatches through the unified `onProposal`. (Optional
    belt-and-braces: nothing.)
- No server changes required — `server.ts` (`/seed`, `/edit`, `/proposals`),
  `ws/handler.ts` rehydrate broadcast, and `remote-agent.ts` dispatch are all
  already correct; the bug is purely the client form-mirror gap.

(If the team instead prefers the deeper refactor — make `goalPreviewPanel()`
read from `state.activeProposals.goal.fields` and drop the `previewTitle/Spec`
mirror entirely — that touches `proposal-panels.ts:746-963`, the goal-draft
serialise/restore in `session-manager.ts:380-446`, and `createGoal` arg
plumbing. Higher blast radius; not recommended for this fix.)

---

## 5. Test strategy (reproducing browser E2Es — fail before, pass after)

Both specs use the spawned-gateway harness (`tests/e2e/ui/gateway-harness.js`)
and the mock agent (`tests/e2e/mock-agent-core.mjs`). The mock already mirrors
the real seed/edit endpoints (`_seedProposal` → `/seed`, `_editProposal` →
`/edit`, `mock-agent-core.mjs:1817-1835`), so `proposal_update {seed|edit}`
frames really fire. Model the files on
`tests/e2e/ui/goal-proposal-dismiss-reload.spec.ts` and
`tests/e2e/ui/proposal-edit-flow.spec.ts`.

### Mode A — `tests/e2e/ui/goal-proposal-revision-autoupdate.spec.ts` (new)
Triggers: `GOAL_PROPOSAL` (1st), then a 2nd `propose_goal`, then `edit_proposal`.

1. `+ New Goal` → `sendMessage("GOAL_PROPOSAL")`; assert the assistant title
   input (`input[placeholder='Goal title']`) shows `"E2E Test Goal"`.
2. **2nd propose_goal** — use the existing `GOAL_PROPOSAL_PARITY_EDIT` trigger
   (`mock-agent-core.mjs:299` → title `"Parity Goal A — edited"`, spec `"Body B."`)
   *or* add a dedicated `GOAL_PROPOSAL_REV2` trigger emitting a clearly different
   title+spec. After send, assert **without any click** that the title input
   flips to the new title and the spec preview shows the new body. (Fails on
   master via the §1(a) replay/intermittent path; to make it deterministic,
   trigger a WS reconnect — e.g. `page.evaluate` to drop/reopen the socket, or a
   `page.reload()` — between the 1st and 2nd so the 2nd arrives via
   rehydrate/`proposal_update`, exercising the unified-only path.)
3. **edit_proposal** — add a goal edit trigger to the mock (see below), send it,
   and assert **without any click** that the spec preview text updates to the
   edited content. This is the deterministic Mode-A repro.
4. Negative assertion: the panel never shows a superseded revision on the live
   current-proposal tab (assert the visible spec equals the newest, not the
   prior).

Mock-agent addition required: a goal edit trigger. There is currently only a
**project** edit trigger (`EDITABLE_PROPOSAL_EDIT`, `mock-agent-core.mjs:241`).
Add a sibling, e.g.:
```js
if (text.includes("GOAL_EDITABLE_EDIT")) {
  return { tool: "edit_proposal",
           input: { type: "goal", old_text: "<substring of current spec>", new_text: "EDITED SPEC BODY" },
           output: "Goal proposal edited." };
}
```
(Pair it with an initial `propose_goal` whose spec contains the `old_text`
substring.)

### Mode B — `tests/e2e/ui/goal-proposal-offscreen-return.spec.ts` (new)
Cover all three return paths. Use two sessions: S1 = goal assistant, S2 = a plain
session (`createSessionViaUI`).

1. **Fast-path switch-back**: open S1 (`+ New Goal`); switch to S2; drive S1's
   agent to emit `propose_goal` while away. Driving an *off-screen* turn: send
   the prompt to S1 *before* switching (so the turn lands while S2 is focused),
   or POST a prompt to S1 via the gateway REST API while S2 is active. Switch
   back to S1 (cached → fast path). Assert the title/spec inputs are populated
   (currently empty on master).
2. **Slow-path reconnect**: same setup, but force S1 out of the cache before
   return (navigate to landing / disconnect so the cached chatPanel is evicted),
   then connect fresh to S1. Assert populated.
3. **Reload**: after the off-screen proposal, `page.reload()` and connect to S1.
   Assert populated. (Exercises the WS-auth rehydrate broadcast +
   `_processedProposalIds` dedup path.)
4. Regression guards in the same file: a *dismissed* off-screen proposal must
   stay hidden on return (don't break `goal-proposal-dismiss-reload.spec.ts`'s
   invariant); and switching back must not surface another session's proposal.

Mock-agent note: `proposal_burst` (`mock-agent-core.mjs:290`,
`_handleProposalBurst` ~`1377`) is useful to assert burst-of-revisions
auto-update in the Mode-A file if desired, but the core Mode-B repro only needs a
single off-screen `propose_goal`.

### Existing suites to keep green
`npm run check`, `npm run test:unit`, `npm run test:e2e`. Specifically do not
regress: `proposal-edit-flow.spec.ts` (project edit live-update),
`goal-proposal-dismiss-reload.spec.ts` (dismissal stickiness),
`proposal-types-uX-parity.spec.ts` (per-type parity), and `message-reducer.test.ts`
scenarios 8/9 (proposal burst ordering).

---

## 6. Out-of-scope follow-up (flag, do not fix here)

The role/tool/staff/project **assistant** panels read their own form-mirror
state (`rolePreviewName`, `staffPreviewPrompt`, etc.) updated only by their
legacy `onXProposal` callbacks (`session-manager.ts:1473-1545`). They have the
**identical latent bug**: an `edit_proposal type=role|staff|…` or an off-screen
proposal will update the unified slot but not the form-mirror. The same
mirror-in-`onProposal` pattern generalises cleanly per type; recommend a
follow-up goal to apply it (and ultimately collapse the form-mirror into the
slot) for all assistant types.
