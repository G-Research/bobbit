# Side-panel workspace

Bobbit's side-panel workspace is the durable, per-session model for everything that opens to the right of chat. It replaces the old preview-specific/localStorage side-pane state with a server-authoritative tab set shared by previews, pack panels, proposals, review documents, and the staff inbox.

The workspace owns only side panels. Chat is not a side-panel tab.

## Core invariant

For each session, the server is the source of truth for:

- ordered open tabs;
- the active tab id;
- the workspace size mode: `split`, `fullscreen`, or `collapsed`;
- tab source metadata needed to rehydrate content;
- the absence of closed tabs.

A closed tab is authoritative absence. Reload, reconnect, restart, WebSocket replay, render, localStorage, and content caches must not recreate it. A closed proposal tab stays closed even if the proposal draft still exists; a closed review tab stays closed even if its document/annotations are cached; a closed preview tab stays closed even if a mount or artifact still exists.

Tabs can be created or focused only through explicit workspace open/reopen events. The real app render path renders the server workspace it has hydrated; it does not derive tabs from `activeProposals`, review document caches, inbox booleans, preview mount state, or localStorage. File-based browser fixtures keep a local fallback so unit fixtures can run without a gateway, but that fallback is not the product authority.

## Data model and persistence

The shared model lives in `src/shared/side-panel-workspace.ts` and is stored on the persisted session record as `sidePanelWorkspace`.

```ts
export type SidePanelSizeMode = "collapsed" | "split" | "fullscreen";
export type SidePanelKind = "preview" | "proposal" | "review" | "inbox" | "pack";
```

A workspace contains:

- `version: 1`;
- `sessionId`;
- monotonic server `revision`;
- `tabs: SidePanelWorkspaceTab[]`;
- `activeTabId`;
- `sizeMode`;
- optional `metadata.migratedFromLocalStorageAt`;
- `updatedAt`.

Every committed mutation increments `revision`, persists the whole workspace through `SessionStore.update()`, and broadcasts the committed workspace to viewers of that session.

## Supported panel kinds

| Kind | Tab id shape | Source identity | Notes |
|---|---|---|---|
| Preview | `preview:entry:<encoded-entry>` or `preview:entry:<encoded-entry>:v:<N>` | `entry`, `artifactId?`, `contentHash?`, `version?`, `live?`, `historical?` | Live preview tabs update in place. Historical preview tabs represent immutable artifacts or restored older cards. |
| Pack | `pack:<encoded-packId>:<encoded-panelId>:<encoded-instanceKey>` | `packId`, `panelId`, `instanceKey`, `params?` | Covers PR walkthrough and artifact viewer pack panels. `instanceKey` is part of identity. |
| Proposal | `proposal:<type>` or `proposal:<type>:rev:<N>` | `proposalType`, `rev?`, `historical?` | Types are `goal`, `project`, `role`, `tool`, and `staff`. Current revisions update the current tab; historical revs open only by explicit reopen. |
| Review | `review:<encoded-documentId>` | stable `documentId`, display `title` | Title is metadata. Renames do not change identity. Closing the tab preserves content/annotations for explicit reopen. |
| Inbox | `inbox` | session id and optional `staffId` | Staff inbox opens/focuses through the same workspace APIs as other panels. |

### Legacy chat artifacts exclusion

`src/ui/ChatPanel.ts` and `src/ui/tools/artifacts/artifacts.ts` are not product-active right-side workspace surfaces in the current app. `ChatPanel.ts` is the older standalone/package-facing chat component that embeds its own `AgentInterface`, and `src/ui/tools/artifacts/artifacts.ts` is the legacy tool-renderer artifact model used by that component path. The app-level artifact experience is now served through pack panels, including the built-in artifacts pack, opened with `host.ui.openPanel()` and persisted as `pack:<packId>:<panelId>:<instanceKey>` workspace tabs.

Because those legacy files are superseded by pack artifact panels, they are excluded from the shared workspace migration instead of being migrated. The acceptance surface is the pack artifact panel path: artifact panels use the shared side-panel shell, server-backed tab identity, shared sizing controls, and popout/deep-link behavior. Do not reintroduce a second right-side split/collapse implementation in `ChatPanel.ts` for the current app workspace.

### Preview lifecycle

`preview_open` still writes the per-session preview mount and streams updates via preview SSE. Workspace tab creation is separate:

- explicit preview open/tool actions open or focus the current preview tab;
- historical card Open buttons explicitly open a versioned preview tab or focus an equivalent current tab when hashes match;
- `GET /api/preview/mount` bootstrap, `preview-changed` SSE events, and mount metadata refreshes patch metadata only for already-open tabs;
- closing a preview tab removes only the workspace tab, not the live mount or immutable artifacts.

This split prevents navigation, reload, or reconnect from resurrecting a preview tab just because a preview mount still exists. A later explicit preview Open action can reopen it.

### Proposal lifecycle

Proposal content and proposal tab presence are separate. The proposal slot/cache is the source of truth for editable content; the server workspace is the source of truth for whether the side-panel tab is open.

Current proposal tabs are keyed by proposal type (`proposal:goal`, `proposal:project`, etc.); an allowed explicit reveal updates/focuses that same tab. Historical proposal revisions use `proposal:<type>:rev:<N>` and are created only by explicit historical/reopen UI.

Source rules:

- non-explicit `rehydrate` events and ordinary `edit` events update proposal content only; they must not create or focus a workspace tab;
- fresh explicit sources (`tool`, `seed`, `restore`, and legacy proposal discovery) may create or focus the current proposal tab;
- explicit Open Proposal / Resubmit Proposal chat-renderer actions may reopen a closed proposal tab;
- opening a historical revision is always an explicit reopen action and uses the revisioned tab id.

Proposal close paths are durable workspace deletes. The tab close button, Dismiss, Create/Accept, and registered-project Apply Changes all remove the current proposal tab from the server workspace. Draft files, accepted/saved-state caches, form mirrors, and subsequent content-only rehydrates must not recreate that closed tab.

### Review lifecycle

Review tabs are keyed by stable document id, not title. `openMarkdownReviewDocument()` creates or preserves the document id, caches the content, and explicitly opens `review:<documentId>`.

Restoring cached or persisted review documents restores content only for review tabs that already exist in the server workspace. If a review tab was closed, the cached document and annotations may remain available for an explicit review reopen, but hydration must not recreate the tab from cache alone.

### Pack panel lifecycle

Pack panel identity is `{ packId, panelId, instanceKey }`. This allows singleton panels and parameterized content panels to share the same workspace without overwriting each other.

- Singleton panels use `instanceKey = "default"`.
- Parameterized panels declare `instanceMode: "parameterized"` and may declare `instanceParam` in their panel YAML.
- `host.ui.openPanel()` may pass `instanceKey` directly. If omitted, the host derives it from `instanceParam`, then from allowlisted params such as `artifactId`, and finally `default` only for singleton panels.
- Parameterized panels without a safe instance key are rejected/logged instead of using an unstable hash of arbitrary params.

The PR walkthrough is a normal singleton pack panel. It gets fullscreen, collapse, restore, split, and popout behavior because all pack tabs use the shared side-panel shell; there is no PR-specific resize state.

## Mutations and concurrency

The server canonicalizes and validates every tab before committing it. It rejects unknown kinds, malformed ids, mismatched `source.sessionId`, invalid proposal types, unsafe pack ids, unknown pack panels, oversized JSON params/state, and inconsistent pack instance metadata.

Mutation endpoints are serialized per session with an async lock. Clients may optimistically update in memory, but the next REST response or WebSocket payload replaces that optimistic state.

Rules:

- `open` upserts by tab id and focuses by default;
- stale `open` requests that include `baseActiveTabId` do not steal focus when they are rebased over a newer active-tab change from another device; the tab is still opened or updated, but the newer active tab remains active;
- `update` patches an already-open tab only and returns `404` if it is closed;
- `close` deletes the tab and chooses the next active tab like a browser tab strip;
- `active` may point only to an open tab or empty;
- `resize` persists `collapsed`, `split`, or `fullscreen`;
- `reorder` must include the exact current set of tab ids and requires a revision check;
- stale non-reorder mutations are rebased onto the latest workspace unless the caller requests strict revision matching.

Clients ignore server/WS payloads whose `revision` is not newer than the locally applied workspace.

## API surface

REST endpoints are session-scoped:

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/sessions/:sessionId/side-panel-workspace` | Return the canonical workspace, creating an empty default if none was persisted. |
| `POST` | `/api/sessions/:sessionId/side-panel-workspace/open` | Validate and upsert a tab; focus by default except stale `baseActiveTabId` rebases that would steal focus. |
| `PATCH` | `/api/sessions/:sessionId/side-panel-workspace/tabs/:tabId` | Update an already-open tab. Does not create closed tabs. |
| `DELETE` | `/api/sessions/:sessionId/side-panel-workspace/tabs/:tabId` | Close a tab and preserve underlying content. |
| `POST` | `/api/sessions/:sessionId/side-panel-workspace/active` | Set the active tab id. |
| `POST` | `/api/sessions/:sessionId/side-panel-workspace/reorder` | Reorder all open tabs; requires `baseRevision` or `If-Match`. |
| `POST` | `/api/sessions/:sessionId/side-panel-workspace/resize` | Persist size mode. |
| `POST` | `/api/sessions/:sessionId/side-panel-workspace/migrate` | One-time migration from legacy localStorage keys when the server workspace is empty. |

Mutations broadcast:

```json
{ "type": "side_panel_workspace", "sessionId": "...", "workspace": { "version": 1 } }
```

## Shared shell and controls

The side-panel shell renders every tab kind with the same workspace chrome:

- tab strip and close buttons;
- active tab selection;
- drag reorder;
- fullscreen;
- collapse and restore;
- split view;
- popout/deep-link.

Panel-specific actions remain inside the panel or per-tab action slot. Preview keeps refresh/direct preview behavior; pack panels keep scoped Host API behavior; proposal/review/inbox panels keep their business actions.

Keyboard shortcuts target the active side panel, regardless of kind:

- expand: `collapsed -> split -> fullscreen`;
- collapse: `fullscreen -> split -> collapsed`;
- fullscreen toggle: non-fullscreen -> `fullscreen`, fullscreen -> `collapsed`.

## Popout and deep links

Preview popout keeps the content-origin route:

- live preview: `/preview/<sessionId>/<entry>`;
- artifact preview: `/preview/<sessionId>/_artifact/<artifactId>/<entry>`.

All other panel kinds use the app deep link:

```text
#/session/<sessionId>/panel/<encodedTabId>
```

The route hydrates the session workspace, validates that the exact tab id is still open, focuses it, and renders the side-panel workspace in fullscreen. If the tab has been closed, the route shows a safe "Panel is closed" state instead of reconstructing it from params. Pack-panel deep links reuse the session-scoped host factory and the server-validated tab record; they do not grant cross-session Host API access or bypass pack validation.

## Legacy localStorage migration

Legacy workspace keys are migration input only:

- `bobbit-panel-tabs-by-session`;
- `bobbit-panel-active-by-session`;
- `bobbit-preview-collapsed-<sessionId>`.

On first hydrate, if the server workspace is empty and has no migration stamp, the client reads those keys and posts `/migrate`. The server canonicalizes the migrated tabs, persists `metadata.migratedFromLocalStorageAt`, increments `revision`, and broadcasts the committed workspace.

Migration behavior:

- legacy pack ids without `instanceKey` become `:default` only when valid for the panel;
- legacy review title tabs become deterministic `legacy-title-<hash>` document ids;
- the old preview collapsed key maps to `sizeMode: "collapsed"`;
- closed tabs are not inferred from proposal/review/preview/inbox caches;
- after migration, the real app does not write workspace state to localStorage.

`src/app/panel-workspace.ts` still reads/writes legacy tab keys for `file://` unit fixtures and keeps preview version records in localStorage. That fixture fallback must not be treated as product persistence.

## Diagnostics

When a side-panel issue appears, check the server workspace first:

```bash
TOKEN=$(cat .bobbit/state/token)
GW=$(cat .bobbit/state/gateway-url)
curl -sk "$GW/api/sessions/<sessionId>/side-panel-workspace" \
  -H "Authorization: Bearer $TOKEN"
```

Useful checks:

- a closed tab should be absent from `tabs`, not hidden by local UI state;
- `activeTabId` should be empty or match an open tab id;
- `sizeMode` should reflect the last shared control or shortcut action;
- `revision` should increase after every committed mutation;
- duplicate artifact pack panels should differ by `source.instanceKey`;
- review tab ids should include document ids, not mutable titles;
- stale localStorage should not change the workspace after `migratedFromLocalStorageAt` is set.

Related docs: [architecture.md](architecture.md#side-panel-workspace), [preview-architecture.md](preview-architecture.md#side-panel-workspace-integration), [extension-host-authoring.md](extension-host-authoring.md#panels--persistent-side-panels-hostuiopenpanel), [rest-api.md](rest-api.md#side-panel-workspace), and [websocket-protocol.md](websocket-protocol.md#server--client).
