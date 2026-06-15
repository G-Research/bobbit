# Side-Panel Tab Contract

Pinned by [`tests/e2e/ui/side-panel-tabs.spec.ts`](../../tests/e2e/ui/side-panel-tabs.spec.ts).
Companion to [`preview-architecture.md`](../preview-architecture.md) (v3 mount,
SSE, content origin) and [`reopenable-preview-widgets.md`](./reopenable-preview-widgets.md)
(historical preview tab UX).

> **Current contract:** the product workspace is server-authoritative.
> Open tabs, active tab, tab order, and size mode live on the session's persisted
> `sidePanelWorkspace`. Closed tabs are durable absence: render/content caches,
> preview mounts, proposal state, review documents, inbox state, and localStorage
> must not recreate them. See [`side-panel-workspace.md`](../side-panel-workspace.md)
> for the implementation contract. Historical sections in this design note are
> explicitly labelled and describe pre-workspace behavior only.

> **Current model — PR walkthrough is no longer a bespoke side-panel tab.** The
> PR-walkthrough viewer now ships as a built-in first-party **pack**
> (`market-packs/pr-walkthrough/`) rendered through the **generic `ext` route**
> at `#/ext/pr-walkthrough`, not as a `walkthrough:<changeset-id>` side-pane tab
> kind. The bespoke `walkthrough:` tab id, the slash/Git-Status/PR-link tab-upsert
> paths, the standalone `/walkthrough?...` route, `src/app/pr-walkthrough.ts`, and
> `tests/e2e/ui/pr-walkthrough-panel.spec.ts` are all **deleted**. The
> walkthrough-specific rows below are retained as **historical** context for the
> tab contract; see
> [docs/marketplace.md § Built-in (first-party) packs](../marketplace.md#built-in-first-party-packs)
> and [docs/design/pr-walkthrough-pack-deletion.md](./pr-walkthrough-pack-deletion.md)
> for the pack model.

---

## 1. Why this exists

Bobbit's UI has two main areas: the **chat** (transcript + prompt textarea)
and a **side pane** that hosts everything else the agent might surface
alongside the chat — HTML previews, draft proposals, review documents,
pack panels such as PR walkthrough, and the staff-agent inbox. The current
contract exists because older builds had several parallel sources of truth
for what the side pane was showing:

- id-keyed active tab state;
- kind-keyed preview/proposal/review state;
- render-time fallback tab derivation;
- preview-specific collapse/fullscreen state and localStorage keys.

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

- The strip renders only side-panel workspace tabs: preview, proposal,
  review, pack, and inbox. It never renders a persisted `Chat` pill.
- Chat cannot be reordered, dismissed, or selected from the strip — there
  is no exposed `chat` tab id.
- If a session has zero open side-panel tabs, the side pane is **hidden**
  and chat fills the main area. The strip itself disappears.
- The staff inbox is a normal workspace tab (`inbox`). It opens through
  explicit inbox/session actions, can be closed like other tabs, and stays
  closed across refresh until explicitly reopened.

On mobile the same persisted model holds: the workspace contains only side-pane
tabs. The UI may expose a chat affordance for the slider, but that affordance is
not a persisted workspace tab. The existing horizontal swipe still reveals the
chat pane and the side pane as separate slides — no touch drag reorder in this
iteration.

## 3. Tab id is the address

Every side-pane tab has exactly one canonical id, and that id is the only
thing the renderer consults when deciding what to draw. The authoritative
model is `SidePanelWorkspace` in
[`src/shared/side-panel-workspace.ts`](../../src/shared/side-panel-workspace.ts),
persisted on the session as `sidePanelWorkspace`.

Valid side-pane tab ids:

| Id | Meaning |
|---|---|
| `preview:entry:<encoded-filename>` | Current / latest preview for `<filename>`. Label is unversioned, e.g. `report.html`. |
| `preview:entry:<encoded-filename>:v:<N>` | Historical immutable preview artifact. Label is `report.html (vN)`. |
| `proposal:<type>` | Current proposal of `<type>` (`goal`, `project`, `role`, `tool`, `staff`). |
| `proposal:<type>:rev:<N>` | Historical proposal revision opened by an explicit reopen action. |
| `review:<encoded-documentId>` | Review document by stable document id. Title is display metadata only. |
| `pack:<encoded-packId>:<encoded-panelId>:<encoded-instanceKey>` | Pack-hosted panel instance, including PR walkthrough and artifact viewers. |
| `inbox` | Staff-agent inbox. Normal closeable/reorderable workspace tab. |
| ~~`walkthrough:<changeset-id>`~~ *(historical - deleted)* | Former PR / changeset walkthrough tab kind. **Removed**: the walkthrough viewer is now a first-party pack panel, not a bespoke side-pane tab id. |

Anything that does not canonicalize to one of the supported shapes is **not** a
side-pane tab and cannot become the active side-pane tab. Server validation also
checks that each tab's `source.sessionId` matches the route session and that pack
panel ids/instance keys are valid for a registered panel.

### Legacy ids are migration input only

Legacy localStorage keys are read only during the one-time workspace migration,
and only when the server workspace is empty and has no migration stamp:

| Legacy id/key | Resolution |
|---|---|
| `chat` (tab row or active id) | **Dropped.** Chat is not a side-panel tab. |
| `preview` / `preview:live` | Mapped to the current filename preview tab when the current entry is known. |
| `review:<encoded-title>` | Mapped to a deterministic legacy document id so future identity is document-based. |
| `pack:<packId>:<panelId>` | Mapped to `pack:<packId>:<panelId>:default` only for valid singleton panels. |
| `bobbit-preview-collapsed-<sessionId>` | Migrates to `sidePanelWorkspace.sizeMode = "collapsed"`. |
| `bobbit-panel-active-by-session` / `bobbit-panel-tabs-by-session` | Seed the initial server workspace order/active id during migration only. |

After migration, the product app does not write workspace state to localStorage.
Closed tabs are not inferred from proposal/review/preview/inbox caches. File-based
fixtures may keep local fallbacks so browser unit fixtures can run without a
gateway; those fallbacks are not the product source of truth.

### Activation is a server workspace mutation

`setActiveSidePanelTab(tabId)` posts to the session workspace API and may point
only to an open tab or to empty. The committed server response replaces any
optimistic in-memory state and is broadcast to other clients. The render path
then looks up the active tab by id in `workspace.tabs` and draws that exact
content. There is no second pass, no kind-based fallback, and no
`assistantTab -> preview` cascade. Aliasing cannot happen because there is only
one consulted authority.

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

The preview opener computes the target id via the preview tab helpers, then
calls the server workspace open/update API. Metadata patches for SSE/bootstrap
must target an already-open tab; they do not recreate a tab the user closed.

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

## 5. Proposal, review, pack, and inbox tabs

All side-panel kinds share the server-backed id-keyed activation and ordering
model with preview.

**Proposal tabs** open from proposal events or explicit reopen affordances.
`proposal:<type>` (no `:rev:` suffix) is the editable current slot for an active
proposal. `proposal:<type>:rev:<N>` tabs are historical revisions and are opened
only by explicit historical/reopen UI. A new current revision updates/focuses
the matching current tab instead of creating a duplicate. Closing a proposal tab
removes only the workspace tab unless the business action also dismisses the
proposal; refresh must not recreate it from `activeProposals`.

**Review tabs** use `review:<encoded-documentId>`. `documentId` is stable and
survives title changes; title is display metadata. Review content/annotations
may remain cached after close, but restoring those caches must not open a tab
unless the server workspace already contains it or the user explicitly reopens
it.

**Pack tabs** use `pack:<packId>:<panelId>:<instanceKey>`. The PR walkthrough is
a singleton pack panel; artifact-style pack panels can use distinct instance
keys so multiple artifacts coexist. Pack panel popout/deep links render only an
already-open server tab and reuse the session-scoped Host API.

**Walkthrough tabs** *(historical - deleted)*. The PR/changeset walkthrough
formerly used a `walkthrough:<changeset-id>` side-pane tab kind. **That tab kind,
those launch paths, and the standalone route are removed.** The walkthrough
viewer now ships as the built-in first-party pack at the generic
`#/ext/pr-walkthrough` route; a pack entrypoint opens the pack panel and the pack
persists its review state through its own pack-namespaced `host.store`. See
[docs/design/pr-walkthrough-pack-deletion.md](./pr-walkthrough-pack-deletion.md).

**Inbox** is a normal workspace tab with id `inbox`. Staff sessions can open or
focus it through explicit inbox/session actions. Closing the tab deletes it from
the server workspace and preserves that closed state across reload, restart, and
other devices until an explicit inbox action reopens it. It uses the same shared
close, reorder, collapse, fullscreen, restore, and popout controls as other tab
kinds.

## 6. Activation and ordering rules

### Focus and activation

- Activating a tab is a server workspace mutation (`active`) against an
  already-open tab id.
- The render path resolves the active id back to a workspace tab and draws that
  exact content. No kind-based fallback. No second-chance derivation.
- Agent/tool/UI events (`preview_open`, proposal, review, pack open, inbox open)
  may **create or update** a tab only by calling the workspace open/update APIs.
  That is the natural "the agent opened a tab and it took focus" UX.
- Selection, content arrival, and focus changes **never reorder** existing tabs.
  Order only changes when the user drags/reorders a tab or when a new tab is
  inserted by an explicit open mutation.

### Closing the active tab

The server chooses the next active tab like a browser tab strip:

1. List the open workspace tabs.
2. Find the index of the closed tab.
3. If found, activate the right neighbour; otherwise activate the left neighbour.
4. If no side-pane tabs remain, return `""` - the side pane hides and chat fills
   the main area.

### Session switching

The active side-pane tab id is stored **per session** in the server workspace.
Selecting a different session hydrates that session's workspace and restores its
own active id, order, and size mode; it never borrows another session's active
tab. Workspace changes broadcast over WebSocket so multiple browser contexts
converge on the same active tab and order.

## 7. Drag reorder

Source of truth: [SortableJS](https://github.com/SortableJS/Sortable) bound to
the tab-bar container in the side-panel shell. Drag commits a complete ordered id
list to the server workspace reorder API, using the latest workspace revision so
stale reorders cannot drop tabs opened by another device.

- Desktop pointer drag reorders side-pane tab pills horizontally via a
  SortableJS instance attached after every render to the inner tab-bar
  container (`[data-panel-tab-bar]`). The binding is idempotent - it reuses the
  existing instance unless the container element changes.
- `forceFallback: true` is on so SortableJS uses its own pointer emulator instead
  of native HTML5 DnD. This:
  - lets it work with `<div role="button">` pills (button elements swallow
    `pointerdown` and break native DnD);
  - gives us a JS-positioned floating clone (`Sortable.ghost`) we can re-style
    and constrain via inline `transform`;
  - keeps drag-detect responsive on touch devices.
- **Chrome-style Y-axis lock**: the drag loop rewrites the floating clone's
  translateY to `0`. The dragged tab tracks the cursor horizontally; vertical
  cursor wander has no visual effect.
- Close controls are filtered out of drag starts so clicking a close button never
  begins a reorder. Mobile-only chat affordances are UI-only and are not
  persisted as workspace tabs.
- Renders are suppressed while SortableJS owns the DOM. On drag end, the new tab
  id order is read from the DOM, posted to the server workspace, and the
  committed workspace response resumes rendering.
- Tab order persists in `sidePanelWorkspace.tabs` on the server and survives
  reload, restart, session switch, and another browser context joining later.
- New agent-opened tabs are inserted by the explicit open mutation; default UX is
  append/after-active without reordering existing tabs.
- Touch devices fall through SortableJS's touch emulator. The existing main-chat
  <-> side-pane swipe gesture remains.
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

The point of the contract is that preview, proposal, review, pack, and inbox
tabs all share the same model:

- One server-authoritative id-keyed activation authority.
- One stored order per session.
- One shared render shell that resolves content by tab id.

So:

- A new `preview_open` never removes, reorders, or mutates proposal / review /
  pack / inbox tabs.
- A proposal update never reorders preview, review, pack, or inbox tabs or mints
  duplicates.
- Opening a PR walkthrough opens or focuses the normal singleton pack tab. It
  does not have bespoke walkthrough resize state or a bespoke tab kind.
- User drag reorder persists the mixed-kind order exactly as committed to the
  server workspace.
- Active selection persists by id in `sidePanelWorkspace.activeTabId`, so reload,
  restart, session switch, and another browser context restore the same active
  preview/proposal/review/pack/inbox tab.

## 9. Implementation hot spots

| File | Responsibility |
|---|---|
| [`src/shared/side-panel-workspace.ts`](../../src/shared/side-panel-workspace.ts) | Shared workspace/tab model, size modes, and tab source records. |
| [`src/server/side-panel-workspace.ts`](../../src/server/side-panel-workspace.ts) | Server canonicalization, validation, mutation application, and concurrency rules. |
| [`src/app/side-panel-workspace.ts`](../../src/app/side-panel-workspace.ts) | Client hydrate/open/update/close/active/reorder/resize controller, optimistic state, and migration client. |
| [`src/app/panel-workspace.ts`](../../src/app/panel-workspace.ts) | Preview tab id/display helpers and legacy fixture fallback; not product workspace persistence. |
| [`src/app/preview-panel.ts`](../../src/app/preview-panel.ts) | Preview mount/SSE/bootstrap, preview opener integration, older-version-rehydration guard. |
| ~~`src/app/pr-walkthrough.ts`~~ *(deleted)* | Former owner of slash-command parsing, changeset-derived walkthrough tab id / title, tab upsert, and active-id selection. **Removed** with the bespoke walkthrough tab kind; the viewer is now the built-in pack at `#/ext/pr-walkthrough`. |
| [`src/app/render.ts`](../../src/app/render.ts) | Shared side-panel workspace shell, tab strip, controls, active-content lookup by id only, mobile slider integration. |
| [`src/ui/tools/renderers/PreviewRenderer.ts`](../../src/ui/tools/renderers/PreviewRenderer.ts) | Tool-card Open button; chooses between artifact restore, source remount, and recorded-entry select. |
| [`src/server/preview/artifacts.ts`](../../src/server/preview/artifacts.ts) | `persistPreviewArtifact`, `restorePreviewArtifact`, `findPreviewArtifactByHash`, `sweepOrphanArtifacts`. |
| [`src/server/server.ts`](../../src/server/server.ts) | Side-panel workspace REST routes plus preview mount/artifact/SSE routes. |
| [`defaults/tools/html/snapshot.ts`](../../defaults/tools/html/snapshot.ts) | v3 marker builder - emits `artifactId` and other artifact metadata when they fit the 250-byte cap. |

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
   review / inbox / pack and verify next-right / next-left activation.
   Close the last side-pane tab — the pane hides and closed state persists
   across reload.
5. **Inbox workspace tab** — in a staff-agent session, Inbox opens as `inbox`,
   uses the same close/reorder/fullscreen/collapse/popout controls as other
   side-panel tabs, and stays closed across reload until explicitly reopened.
6. **Drag reorder persistence** — drag tabs (SortableJS), assert server stored
   order, reload or open a second browser context, assert the same order.
   Y-axis is locked during the drag: the floating clone tracks the cursor
   only horizontally regardless of vertical movement. Mobile chat affordances
   remain UI-only and are never persisted as workspace tabs.
7. **Tab id == rendered content** — with preview + proposal + review +
   inbox visible, click every tab and assert `activePanelTabId` equals
   the clicked id and the rendered content matches that id. Repeat after
   closing representative tabs. No aliasing.
8. **Agent focus without spontaneous reorder** — with a proposal active,
   firing a new `preview_open` appends-or-updates the preview tab and
   takes focus. Subsequent updates / refreshes never reorder existing
   tabs unless a brand-new tab is appended.
9. **Mobile** — at phone viewport, the side-pane tab bar may expose a chat
   affordance that swipes the slider to the chat pane on tap; persisted workspace
   tabs remain preview / proposal / review / pack / inbox only. Chat is never
   persisted in the server workspace. The existing swipe gesture reveals chat and
   the side pane; no touch drag reorder.

Helper / reducer behaviour (id normalisation, version assignment, server
canonicalization, reorder revision checks, migration, and next-active selection)
is covered by unit tests against the side-panel workspace helpers plus preview
helpers. Existing preview regression coverage stays green:

- [`tests/preview-renderer.spec.ts`](../../tests/preview-renderer.spec.ts)
- [`tests/e2e/ui/dynamic-chat-tabs.spec.ts`](../../tests/e2e/ui/dynamic-chat-tabs.spec.ts)
- [`tests/e2e/ui/preview-happy-path.spec.ts`](../../tests/e2e/ui/preview-happy-path.spec.ts)
- [`tests/e2e/ui/preview-new-tab.spec.ts`](../../tests/e2e/ui/preview-new-tab.spec.ts)
- [`tests/e2e/ui/preview-refresh.spec.ts`](../../tests/e2e/ui/preview-refresh.spec.ts)

*(The former `tests/e2e/ui/pr-walkthrough-panel.spec.ts` was deleted with the
bespoke walkthrough tab; the pack-served viewer is now pinned by
`tests/e2e/ui/pr-walkthrough-pack.spec.ts`.)*

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
