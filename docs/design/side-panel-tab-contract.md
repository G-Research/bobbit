# Side-Panel Tab Contract

Pinned by [`tests/e2e/ui/side-panel-tabs.spec.ts`](../../tests/e2e/ui/side-panel-tabs.spec.ts).
Companion to [`preview-architecture.md`](../preview-architecture.md) (v3 mount,
SSE, content origin) and [`reopenable-preview-widgets.md`](./reopenable-preview-widgets.md)
(historical preview tab UX).

---

## 1. Why this exists

Bobbit's UI has two main areas: the **chat** (transcript + prompt textarea)
and a **side pane** that hosts everything else the agent might surface
alongside the chat — HTML previews, draft proposals, review documents, and
the staff-agent inbox. Before this contract there were several parallel
sources of truth for what the side pane was showing:

- `activePanelTabId` (id-keyed)
- `assistantTab` / `previewPanelTab` (kind-keyed legacy state)
- A `legacyRequestedTab` fallback inside the render loop
- A `previewWorkspaceKey` shortcut for preview-only sessions

Different events updated different fields, and the render path consulted
them in a partly-ordered cascade. Two surprising classes of bug fell out of
that:

1. **Aliasing** — clicking tab *A* sometimes left *A*'s pill highlighted but
   rendered the content of tab *B*, because a kind-keyed fallback resolved
   before the id check did.
2. **Spontaneous reorder** — opening a new preview while a proposal was
   active could move proposal/review pills around the strip, or even mint a
   ghost "Chat" pill in the side-pane strip itself.

The contract rationalises this: every side-pane tab is identified by its
content, the active id is the *only* selector, and chat is structurally
outside the strip.

## 2. The mental model — chat is not a tab

The side-pane tab strip is a **Chrome-style tab bar that lives next to
chat**, not above the whole window. Chat is always the main area.

- The strip renders only side-pane tabs (preview / proposal / review /
  inbox). It never renders a `Chat` pill.
- Chat cannot be reordered, dismissed, or selected from the strip — there
  is no exposed `chat` tab id.
- If a non-staff session has zero side-pane tabs, the side pane is
  **hidden** and chat fills the main area. The strip itself disappears.
- Switching to a staff-agent session always shows the strip, because the
  pinned **Inbox** tab is always present for staff sessions.

On mobile the same model holds: the side-pane tab bar at the top of the
side pane only contains side-pane tabs, never a Chat pill. The existing
horizontal swipe still reveals the chat pane and the side pane as separate
slides — no touch drag reorder in this iteration.

## 3. Tab id is the address

Every side-pane tab has exactly one canonical id, and that id is the only
thing the renderer consults when deciding what to draw.

Valid side-pane tab ids (sources of truth in
[`src/app/panel-workspace.ts`](../../src/app/panel-workspace.ts)):

| Id | Meaning |
|---|---|
| `preview:entry:<encoded-filename>` | Current / latest preview for `<filename>`. Label is unversioned, e.g. `report.html`. |
| `preview:entry:<encoded-filename>:v:<N>` | Historical immutable preview artifact. Label is `report.html (vN)`. |
| `proposal:<type>` | Active proposal of `<type>` (`goal`, `project`, `role`, `tool`, `staff`). |
| `proposal:<type>:rev:<N>` | Historical proposal revision. |
| `review:<encoded-title>` | Review document by title. |
| `inbox` | Staff-agent inbox. Pinned, no close button, no drag handle. |

`isSidePanelTabId(id)` is the single guard the rest of the app uses.
Anything that does not parse as one of the shapes above is **not** a
side-pane tab and cannot become the active side-pane tab.

### Legacy ids dropped on load

Two legacy artefacts are migrated/dropped when `loadPersistedPanelWorkspace`
hydrates `panelTabsBySession` / `panelWorkspaceActiveBySession` from
`localStorage`:

| Legacy id | Resolution |
|---|---|
| `chat` (tab row or active id) | **Dropped.** `normalizeStoredPanelTab` filters chat rows and `normalizeActivePanelTabId` maps `"chat"` to `""`. No Chat pill survives the migration. |
| `preview` / `preview:live` | Mapped to `previewEntryTabId(currentEntry)` — the unversioned filename tab for whatever entry the live mount currently has. |

The migration is one-way: the in-memory model never re-introduces a chat
tab row. `previewPanel.ts::selectSensiblePanelWorkspaceTab` still has a
branch that *would* upsert a chat row as a last-resort fallback, but the
panel-workspace normaliser strips it back out, so it never makes it onto
the visible strip.

### Activation is a pure id setter

`setActivePanelTabIdForSession(state, sessionId, tabId)`:

1. Normalises `tabId` (`chat` / unknown ids → `""`, legacy preview ids →
   current filename id).
2. Writes that string into `panelWorkspaceActiveBySession[sid]`.
3. Mirrors into `state.activePanelTabId` only when this session is the
   active one in the UI.

The render path then looks up the active tab by id and draws its content.
There is no second pass, no kind-based fallback, no
`assistantTab → preview` cascade. Aliasing cannot happen because there is
only one consulted authority.

## 4. Preview tabs

Preview is the only side-pane tab kind with a non-trivial identity story,
because previews can be **mutated** by the agent (live writes overwrite
the on-disk mount) but **historically restorable** (immutable artifacts
let the user reopen an old `preview_open` card and see the original bytes).

### 4.1 Current vs historical, one filename at a time

Tabs are scoped per **filename**. Two `preview_open` calls naming
`report.html` share the same current filename tab; opening `chart.html`
adds a second filename tab beside it.

For a given filename:

- **Current tab** — `preview:entry:<filename>` (no `v:` suffix). Updated
  in place on every new `preview_open` (and every SSE
  `preview-changed`). Label is the bare filename, e.g. `report.html`.
- **Historical tabs** — `preview:entry:<filename>:v:<N>`. One per distinct
  past content version of that filename. Label is `report.html (vN)`.

When the agent calls `preview_open(file.html)`:

1. If `preview:entry:file.html` does not exist, create it and take focus.
2. If it already exists, update it in place (label, content hash, version,
   artifact id, mtime) and take focus. Do not duplicate. Do not reorder.

This is enforced by `selectHtmlPreviewTab` in
[`src/app/preview-panel.ts`](../../src/app/preview-panel.ts), which finds the
existing current filename tab via `previewEntryTabId(entry)` before deciding
whether to upsert or split into a historical tab.

### 4.2 Version assignment

Versions are **per filename**, assigned in chronological content order. The
ledger lives in `previewVersionsBySession[sid][filename]` in
[`panel-workspace.ts`](../../src/app/panel-workspace.ts):

```ts
interface PreviewVersionRecord {
    latestVersion: number;
    latestContentHash?: string;
    hashToVersion: Record<string /* sha256 */, number>;
}
```

Rules (`registerPreviewVersion`, `previewTabIdentityForContent`):

- New content hash → next integer (`latestVersion + 1`).
- Same content hash as an earlier capture → reuse that earlier integer.
- `current: true` updates `latestContentHash` **only when** the registered
  version is ≥ `latestVersion`. Rehydrating an older artifact (e.g. SSE
  fires the older hash because a historical tab was just restored into the
  live mount) must **not** downgrade `latestContentHash` from v2 → v1.

Labels:

- Current tab — `previewTabDisplayTitle(entry)` → `report.html`. No
  version suffix, even though the tab carries an internal version number.
- Historical tab — `previewTabDisplayTitle(entry, version, true)` →
  `report.html (vN)`.

### 4.3 Immutable preview artifacts

Source of truth: [`src/server/preview/artifacts.ts`](../../src/server/preview/artifacts.ts)
and the artifact branches of `POST /api/preview/mount` in
[`src/server/server.ts`](../../src/server/server.ts).

Every successful `POST /api/preview/mount` captures the exact mounted
bytes into `<stateDir>/preview-artifacts/<sessionId>/<artifactId>/mount/`
along with an `artifact.json` recording `{artifactId, entry, contentHash,
files, mtime, createdAt}`. The capture re-hashes the staged copy and
verifies the entry file is present before committing the rename — so a
captured artifact is byte-identical to what was mounted at that moment.

Why a separate store rather than re-reading the original source path?
Because `preview_open(file=/path/to/report.html)` *mutates* the file on
disk on the next call. Once the user has overwritten `report.html`, the
old source path is gone forever; the artifact store is what makes
"reopen `report.html (v1)` after `report.html` has been edited twice"
possible.

| Endpoint | Behaviour |
|---|---|
| `POST /api/preview/mount` with `html` / `file` | Mount, then `persistPreviewArtifact` captures the result. Response includes `artifactId`. |
| `POST /api/preview/mount` with `{ artifactId }` | `restorePreviewArtifact` rehydrates the named artifact into the single live mount. Body cannot combine `artifactId` with `html` / `file` / `assets` / `manifest`. |
| `POST /api/preview/artifacts/<artifactId>/restore?sessionId=<sid>` | Equivalent dedicated restore route used by the renderer's Open button. |
| `GET /api/preview/mount` | Bootstrap probe — looks up the artifact whose `contentHash` matches the current live mount and includes that `artifactId` in the response. |
| SSE `preview-changed` (bootstrap + live) | Includes `artifactId` whenever a known artifact matches the broadcast `contentHash`. |

Restore semantics are designed so a corrupt or wrong-session artifact
cannot alias to the *current* mounted content:

1. Validate the artifact record, mount directory, and file list.
2. Copy the artifact's `mount/` tree into a sibling tmp dir under
   `<stateDir>/preview/`.
3. Re-hash the staged copy and verify the recorded entry is present.
4. Snapshot the existing live mount into a backup dir.
5. Wipe the live mount's contents (preserving the inode so `fs.watch`
   keeps firing for SSE) and rename the staged tree into place.
6. On any error, roll back from the backup.

`broadcastPreviewChanged` fires after restore so subscribed clients
update their iframe / preview-tab state from the artifact, not from
whatever the source file path now contains.

### 4.4 The two reopen paths and same-content collapse

When the user clicks **Open** on a historical `preview_open` tool card
(see [`src/ui/tools/renderers/PreviewRenderer.ts`](../../src/ui/tools/renderers/PreviewRenderer.ts)):

| Marker shape | Restore source | Tab behaviour |
|---|---|---|
| v3 with `artifactId` | `POST /api/preview/artifacts/<id>/restore` | Always restorable. If `contentHash` matches the current filename tab, collapse to it; otherwise open / select the historical `:v:N` tab. |
| v3 without `artifactId`, with `html` / `file` original params | `POST /api/preview/mount {html\|file}` | Remount the original; the POST response's `artifactId` and `contentHash` are attached to the tab. Same collapse rule. |
| v3 without `artifactId` and no remount body | None (recorded entry / mtime / url) | Select the recorded entry; iframe points at the existing mount path. Best-effort. |
| Legacy `v1` (inline HTML in the block) | `POST /api/preview/mount {html}` | Stays historical even when the response includes `contentHash`. |
| Legacy `v2` (file path in the block) | `POST /api/preview/mount {file}` | Stays historical even when the response includes `contentHash`. |

The collapse rule (only for v3 markers):

- If the restored artifact's `contentHash` matches the pre-restore current
  filename tab's hash → no historical tab; select the existing current
  filename tab and short-circuit any remount POST that would just rewrite
  the same bytes.
- If the hashes differ → open `preview:entry:<file>:v:N`, using the
  per-filename version ledger to find or assign `N`.

Live SSE events for an older registered hash explicitly do **not**
rewrite the current filename tab's metadata: `selectHtmlPreviewTab`
detects "live event for hash whose registered version < latestVersion"
and returns without overwriting the current tab's label, hash, or
active selection. The historical tab the user just opened keeps focus.

### 4.5 The live mount stays single

The server still has exactly one live mount per session at
`<stateDir>/preview/<sid>/`. The artifact store is an **additional**
immutable restore source, not a second live mount. The product invariant
from the goal spec — "do not add per-tab live server mounts. One live mount
may remain the render target if each tab has an immutable restore source" —
is preserved: each historical tab restores its artifact into the same live
mount before the iframe renders it.

## 5. Proposal, review, and inbox tabs

All three kinds share the id-keyed activation and ordering model with
preview.

**Proposal tabs** are minted from the active-proposal slot for a session.
`proposal:<type>` (no `:rev:` suffix) is the editable slot for an active
proposal. `proposal:<type>:rev:<N>` tabs are historical immutable
revisions (snapshots committed earlier in the session). Active proposal
slots upsert their tab on creation; closing the tab dismisses the
proposal via the existing proposal-dismiss flow. Historical revisions
close cleanly on their own and never touch the active slot.

**Review tabs** use `review:<encoded-title>` and map 1:1 to entries in
the session's `reviewDocuments` map. Closing a review tab fires the
existing review-close behaviour.

**Inbox** is special. For staff-agent sessions it is an always-present,
pinned side-pane tab:

- The tab is created whenever `inboxPanelOpen` is true.
- `isPinnedPanelTab(tab)` returns true only for `id === "inbox"` and
  `kind === "inbox"`.
- The render path omits the close button (`closable = !isPinnedPanelTab`)
  and the drag handle (`draggable = isDesktop() && !isPinnedPanelTab`).
- `pinnedFirst()` always pulls Inbox to index 0 of the strip; reorder
  cannot drop another tab before it (see § 7).
- Inbox is unaffected by "close last side-pane tab in a non-staff
  session hides the pane" — staff sessions always keep the pane open.

## 6. Activation and ordering rules

### Focus and activation

- Activating a tab is a **pure id setter** —
  `setActivePanelTabIdForSession(state, sid, tab.id)`.
- The render path resolves the active id back to a `PanelWorkspaceTab` via
  `findPanelTab(tabs, activeId)` and draws that exact content. No
  kind-based fallback. No second-chance derivation.
- Agent-driven events (new `preview_open`, new proposal, new review) are
  allowed to **create or update** a tab and take focus. That is the
  natural "the agent opened a tab and it took focus" UX.
- Selection, content arrival, and focus changes **never reorder** existing
  tabs. Order only changes when:
  - The user drags a tab (§ 7), or
  - A new tab is appended (always at the end of non-pinned tabs).

### Closing the active tab

`nextActivePanelTabId(tabs, closedId)`:

1. List the side-pane tabs (`panelContentTabs` — anything `isSidePanelTabId`).
2. Find the index of the closed tab.
3. If found, activate `tabs[index + 1]` (right neighbour) else
   `tabs[index - 1]` (left neighbour).
4. If no side-pane tabs remain, return `""` — the side pane hides and
   chat fills the main area. In staff sessions the pinned Inbox keeps
   the pane open.

### Session switching

The active side-pane tab id is stored **per session** in
`panelWorkspaceActiveBySession[sid]` and persisted to `localStorage` under
`bobbit-panel-active-by-session`. Selecting a different session restores
its own last active id; it never borrows another session's active tab.

## 7. Drag reorder

Source of truth: [SortableJS](https://github.com/SortableJS/Sortable) bound
to the tab-bar container in [`src/app/render.ts`](../../src/app/render.ts)
(`ensurePanelSortable`), plus `reorderSidePanelTab` in
[`src/app/panel-workspace.ts`](../../src/app/panel-workspace.ts) for any
programmatic reorder paths (drag commits a fresh order directly off the DOM).

- Desktop pointer drag reorders side-pane tab pills horizontally via a
  SortableJS instance attached after every render to the inner tab-bar
  container (`[data-panel-tab-bar]`). `ensurePanelSortable` is idempotent
  — it re-uses the existing instance unless the container element
  changes (workspace switch).
- `forceFallback: true` is on so SortableJS uses its own pointer
  emulator instead of native HTML5 DnD. This:
  - lets it work with `<div role="button">` pills (button elements
    swallow `pointerdown` and break native DnD);
  - gives us a JS-positioned floating clone (`Sortable.ghost`) we can
    re-style and constrain via inline `transform`;
  - keeps drag-detect responsive on touch devices.
- **Chrome-style Y-axis lock**: `startPanelDragYLock` runs a
  `requestAnimationFrame` loop while a drag is in progress. Each frame
  it reads the floating clone's `transform: matrix(a,b,c,d,e,f)` and
  rewrites `f` (translateY) to `0`. The dragged tab tracks the cursor
  horizontally; vertical cursor wander has no visual effect.
- Pinned tabs (Inbox, mobile Chat pill) are skipped via the SortableJS
  `filter: ".goal-tab-pill--pinned, .goal-tab-close"` selector —
  attempting to pick one up does nothing. The `onMove` handler also
  returns `false` when the related drop target is pinned, blocking
  drops in front of the pinned slot.
- `setRenderSuppressed(true)` is invoked in `onStart` so any
  `renderApp()` calls during the drag are buffered. SortableJS owns the
  DOM during the drag; on `onEnd` the new tab id order is read off the
  DOM children, committed to `panelTabsBySession[sid]`, and renders
  resume with a single flush.
- Non-pinned tabs persist their stored order in `panelTabsBySession[sid]`
  (saved under the `bobbit-panel-tabs-by-session` localStorage key) and
  survive reload / session switch.
- New agent-opened tabs append at the **end** of the non-pinned tabs.
- Touch devices fall through SortableJS's touch emulator. The existing
  main-chat ↔ side-pane swipe gesture remains.
- No keyboard reorder shortcuts in this iteration.

## 7a. Historical proposal tabs

Proposal panel tabs follow the same canonical-vs-historical pattern as
preview tabs:

- The canonical tab id is `proposal:<type>` and always renders
  `state.activeProposals[type]` (the live slot, latest revision). Updates
  via `proposal_update` / `edit_proposal` flow into the slot and the
  canonical tab's panel re-renders in place. Label: `Goal`, `Project`,
  etc.
- Historical revisions get separate, immutable tabs at id
  `proposal:<type>:rev:<N>`. Label: `Goal (vN)` (matches preview
  versioned-tab format). The tab stores its frozen fields in
  `tab.state.fields` and the revision in `tab.state.rev`.
- Historical tabs are **never auto-spawned**. They appear only when the
  user explicitly opens an older revision card from the chat
  (`proposalOpenHandler` in `src/app/session-manager.ts` calls
  `selectProposalWorkspaceTab(type, { rev, fields, select: true })`).
- Historical tabs are **editable + submittable**, not read-only. When
  the user activates one, `proposalPanelContent` (in render.ts) sets a
  module-level `_proposalOverride = { type, fields, rev }`. The standard
  editable panel reads from the override (via `syncProposalFormState`
  and `projectProposalPanel`'s synthetic slot) instead of
  `state.activeProposals[type]`. The live slot is never clobbered —
  each tab is independent. Switching back to the canonical tab clears
  the override and re-hydrates from the live slot.
- The `data-historical-proposal="true"` attribute on the panel root
  marks the override branch so tests can distinguish historical vs live
  renders of the same editable form.

## 8. Cross-kind harmony

The point of the contract is that preview, proposal, review, and inbox
tabs all share the same model:

- One id-keyed activation authority.
- One stored order per session.
- One render path that resolves content by id.

So:

- A new `preview_open` never removes, reorders, or mutates proposal /
  review / inbox tabs.
- A proposal update never reorders preview tabs or mints duplicates.
- The strip renders in stored order, with pinned tabs pulled to the front
  by `pinnedFirst`. There is no hidden kind-based bucketing beyond that
  pin.

## 9. Implementation hot spots

| File | Responsibility |
|---|---|
| [`src/app/panel-workspace.ts`](../../src/app/panel-workspace.ts) | Tab id grammar, normalization, persistence, version ledger, pinned ordering, `nextActivePanelTabId`, `reorderSidePanelTab`. |
| [`src/app/preview-panel.ts`](../../src/app/preview-panel.ts) | `selectHtmlPreviewTab` (upsert / split / collapse), SSE bootstrap and live update, older-version-rehydration guard. |
| [`src/app/render.ts`](../../src/app/render.ts) | Side-pane tab strip rendering (Chrome-style with radial-gradient corner pseudos for active tab), mobile pane bar with pinned Chat pill, SortableJS attach (`ensurePanelSortable`) + X-axis lock raF loop, render suppression during drag, `_proposalOverride` for editable historical proposal tabs, active-content lookup by id only. |
| [`src/ui/tools/renderers/PreviewRenderer.ts`](../../src/ui/tools/renderers/PreviewRenderer.ts) | Tool-card Open button; chooses between artifact restore, source remount, and recorded-entry select; computes collapse-to-current before invoking `selectHtmlPreviewTab`. |
| [`src/server/preview/artifacts.ts`](../../src/server/preview/artifacts.ts) | `persistPreviewArtifact`, `restorePreviewArtifact`, `findPreviewArtifactByHash`, `sweepOrphanArtifacts`. |
| [`src/server/server.ts`](../../src/server/server.ts) (`/api/preview/mount`, `/api/preview/artifacts/:id/restore`, SSE) | Capture artifact on mount; include `artifactId` in mount responses, SSE bootstrap, and live events. |
| [`defaults/tools/html/snapshot.ts`](../../defaults/tools/html/snapshot.ts) | v3 marker builder — emits `artifactId` and other artifact metadata when they fit the 250-byte cap. |

## 10. Tests

Browser E2E lives in
[`tests/e2e/ui/side-panel-tabs.spec.ts`](../../tests/e2e/ui/side-panel-tabs.spec.ts).
The user stories the spec pins (each corresponds to assertions in the goal
spec):

1. **Chat is never a tab / empty side pane** — fresh non-staff session has
   no side-pane strip, no Chat pill, empty active id, chat fills the
   available space.
2. **Current preview lifecycle** — opening `a.html`, `b.html`, `c.html`
   yields exactly those tabs in creation order with `c.html` active.
   Re-opening `a.html` with new content updates that same tab in place;
   no duplicate, no reorder.
3. **Immutable historical preview artifacts** — capture `a.html` v1,
   mutate the source file, capture v2 / current, then reopen the v1 tool
   card. A separate `a.html (v1)` tab opens showing the original bytes;
   current `a.html` still shows v2. A matching-content reopen collapses
   to current with no duplicate / no unnecessary remount.
4. **Dismiss + next-active behaviour** — close a middle preview tab; only
   that tab disappears. Close active tabs across preview / proposal /
   review and verify next-right / next-left activation. Close the last
   non-pinned side-pane tab in a non-staff session — the pane hides.
5. **Pinned Inbox** — in a staff-agent session, Inbox is always present,
   pinned first, has no close button, cannot be dragged, and remains
   when other tabs are closed. Other tabs open beside it and close
   normally.
6. **Drag reorder persistence** — drag non-pinned tabs (SortableJS), assert
   stored order, reload, assert the same order. Verify drag cannot move a
   tab before pinned Inbox.
   Y-axis is locked during the drag: the floating clone tracks the cursor
   only horizontally regardless of vertical movement.
   The mobile Chat pill is pinned (filtered) and cannot be dragged.
7. **Tab id == rendered content** — with preview + proposal + review +
   inbox visible, click every tab and assert `activePanelTabId` equals
   the clicked id and the rendered content matches that id. Repeat after
   closing representative tabs. No aliasing.
8. **Agent focus without spontaneous reorder** — with a proposal active,
   firing a new `preview_open` appends-or-updates the preview tab and
   takes focus. Subsequent updates / refreshes never reorder existing
   tabs unless a brand-new tab is appended.
9. **Mobile** — at phone viewport, the side-pane tab bar leads with a
   pinned Chat pill that swipes the slider to the chat pane on tap; the
   remaining tabs are the side-pane tabs (preview / proposal / review /
   inbox). The Chat pill is NOT persisted in `panelTabsBySession[sid]`
   — it's a pure UI affordance rendered only when the bar is visible.
   The existing swipe gesture reveals chat and the side pane; no touch
   drag reorder.

Helper / reducer behaviour (id normalisation, version assignment, pinned
ordering, next-active selection) is covered by unit tests against the
pure functions in `panel-workspace.ts` and `preview-panel.ts`. Existing
preview regression coverage stays green:

- [`tests/preview-renderer.spec.ts`](../../tests/preview-renderer.spec.ts)
- [`tests/e2e/ui/dynamic-chat-tabs.spec.ts`](../../tests/e2e/ui/dynamic-chat-tabs.spec.ts)
- [`tests/e2e/ui/preview-happy-path.spec.ts`](../../tests/e2e/ui/preview-happy-path.spec.ts)
- [`tests/e2e/ui/preview-new-tab.spec.ts`](../../tests/e2e/ui/preview-new-tab.spec.ts)
- [`tests/e2e/ui/preview-refresh.spec.ts`](../../tests/e2e/ui/preview-refresh.spec.ts)

The v3 snapshot block stays pinned by
[`tests/e2e/preview-token-cost.spec.ts`](../../tests/e2e/preview-token-cost.spec.ts).
`artifactId` is included in the v3 payload only when it (and any other
optional fields the builder is trying to fit) keeps the marker block at
or under 250 bytes.

## 11. Constraints / non-goals

- **One live mount per session.** Per-tab live server mounts are still
  forbidden; each historical preview tab restores its artifact into the
  same live mount.
- **Legacy v1 / v2 markers** stay historical even when their remount
  response includes a `contentHash`. They predate immutable artifacts and
  cannot prove identity with the current live mount safely. New code
  emits only v3.
- **No keyboard reorder shortcuts** in this iteration.
- **No touch drag reorder** in this iteration. Mobile keeps the existing
  swipe-between-panes gesture.
- **AGENTS.md is not extended.** Operational guidance lives in this doc
  and in [`preview-architecture.md`](../preview-architecture.md).
