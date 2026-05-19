# Project Drag Reorder — design research

## Current shape

- Server registry is `src/server/agent/project-registry.ts`.
  - `RegisteredProject` has `id`, `name`, `rootPath`, `createdAt`, colors, `provisional?`, `hidden?`.
  - `ProjectRegistry.list()` is the source of project order and currently sorts by `createdAt` ascending.
  - `save()` writes `JSON.stringify(this.list())` to `<bobbit state>/projects.json`.
  - `register()`, `registerProvisional()`, `registerSystemProject()`, `remove()`, `removeProvisional()` are the mutation points that must preserve ordering invariants.
- Project REST routes live in `src/server/server.ts` under `// Project CRUD`.
  - `GET /api/projects` returns `projectRegistry.list().filter(p => !p.hidden)`.
  - `POST /api/projects` creates visible projects via `projectRegistry.register()`.
  - `DELETE /api/projects/:id` removes visible or provisional projects; hidden `system` stays hidden from `GET`.
- Client project list type/state lives in `src/app/state.ts`.
  - `Project` mirrors server fields.
  - `setProjects(projects)` preserves `activeProjectId` when possible.
  - `getSidebarData()` exposes `projects: state.projects`; sidebar order follows this array.
- Client project fetch/update helpers live in `src/app/api.ts`.
  - `fetchProjects()` calls `GET /api/projects` and returns either `data.projects` or a raw array.
  - Project changes are not polled after initial `refreshSessions()` except local add/remove paths that explicitly call `fetchProjects()`.
- Desktop sidebar project rendering is in `src/app/sidebar.ts`.
  - `renderProjectHeader(project, expanded)` renders chevron, folder, title, settings, new-goal.
  - `renderSidebar()` builds a `projectMap`, then renders `state.projects.map(...)`.
  - `renderCollapsedSidebar()` also iterates `state.projects.map(...)`; this already preserves whatever order `state.projects` has.
- Mobile project rendering is in `src/app/render.ts::renderMobileLanding()`.
  - It builds a `projectMap`, then renders `state.projects.map(...)` with an inline project header.
- Relevant existing docs/tests:
  - `docs/rest-api.md` documents project routes and should get the new reorder route.
  - `docs/sidebar-keyboard-navigation.md` says DOM order is the sidebar navigation source of truth; reordering project DOM rows will automatically affect keyboard traversal.
  - Registry tests are currently in `tests/multi-project.test.ts` and `tests/project-registry-symlink.test.ts`.
  - Project API/UI patterns are in `tests/e2e/project-delete-last.spec.ts`, `tests/e2e/project-bugs.spec.ts`, `tests/e2e/ui/project-management.spec.ts`, `tests/e2e/ui/single-project-sidebar.spec.ts`, `tests/e2e/ui/remove-first-project.spec.ts`.

## Proposed data model and migration

Add an explicit visible-project position to the registry record:

```ts
// src/server/agent/project-registry.ts
export interface RegisteredProject {
  // existing fields...
  position?: number; // visible project ordering, lower first; absent on legacy/hidden records
}
```

Migration belongs in `ProjectRegistry.load()` via a private normalizer:

- Add `private normalizeVisiblePositions(): boolean`.
- Consider only `!p.hidden` projects.
- Stable order for legacy records:
  1. finite numeric `position`, if present;
  2. `createdAt` ascending;
  3. original on-disk array index as a tie-breaker.
- Rewrite visible project positions to contiguous `0..n-1` when any position is missing, duplicated, non-finite, or non-contiguous.
- Do not assign or validate positions for `hidden` projects; they remain hidden and unaffected.
- If normalization changed visible records, `load()` should `save()` once after reading.

Mutation invariants:

- `ProjectRegistry.list()` sorts visible projects by `position` first, with `createdAt` fallback for unmigrated in-memory data; hidden projects can retain created-at ordering because UI filters them out.
- `register()` and `registerProvisional()` set `position = max(visible.position) + 1`, so new visible projects append to the current custom order.
- `registerSystemProject()` should not set `position` because `hidden: true` projects are not part of user order.
- `remove()` and `removeProvisional()` should delete the record, then normalize remaining visible positions before `save()`; this preserves relative order and removes gaps.
- Add `ProjectRegistry.setVisibleOrder(projectIds: string[]): RegisteredProject[]` to validate and persist a full visible order.

## API contract

Add the route before the existing `const projectGetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/)` block so `order` is not treated as a project id.

```http
PUT /api/projects/order
Content-Type: application/json

{ "projectIds": ["id-c", "id-a", "id-b"] }
```

Success:

```json
{ "projects": [/* visible non-hidden projects in saved order */] }
```

Validation in `ProjectRegistry.setVisibleOrder()` or the route:

- `projectIds` must be an array of strings.
- IDs must be unique.
- Every provided ID must exist.
- No provided ID may reference `hidden: true` or `SYSTEM_PROJECT_ID`.
- The provided set must exactly equal the current visible non-hidden project ID set.
  - Missing visible IDs or stale extra IDs should fail without mutating order.
- Recommended responses:
  - `400 { error, code: "invalid_project_order" }` for malformed, duplicate, unknown, or hidden IDs.
  - `409 { error, code: "stale_project_order", expectedProjectIds, receivedProjectIds }` when the visible project set changed since the client built its order.

After a successful save:

- Return the visible projects in new order.
- Broadcast `broadcastToAll({ type: "projects_changed", projects })` so already-connected browsers can update without reload.
- Update `docs/rest-api.md` Projects table with `PUT /api/projects/order`.

Client helper:

```ts
// src/app/api.ts
export async function saveProjectOrder(projectIds: string[]): Promise<Project[] | null>
```

It should `PUT /api/projects/order`, return `body.projects || body || []`, and surface errors through the existing connection-error dialog path.

For cross-tab/browser freshness, also change `refreshSessions()` in `src/app/api.ts` to refresh projects on every poll or handle the `projects_changed` WS event in `src/app/remote-agent.ts` plus `src/app/session-manager.ts`. Polling projects is simplest and covers landing pages that have no active session WebSocket; compare IDs/positions before calling `setProjects()` to avoid unnecessary renders.

## UI data flow

Shared state should stay client-only and transient; do not persist expansion changes while dragging.

Recommended helpers in `src/app/sidebar.ts` exported for mobile reuse:

- `isProjectReordering(): boolean`
- `projectOrderForRender(): Project[]`
- `startProjectReorder(e: PointerEvent, projectId: string): void`
- `handleProjectReorderMove(e: PointerEvent): void`
- `finishProjectReorder(cancel?: boolean): Promise<void>`
- `renderProjectReorderHandle(project: Project)`

Implementation shape:

- Add module-level reorder state:
  - `activeId`, `pointerId`, `startProjectIds`, `visualProjectIds`, `dropIndex`, `suppressNextClick`.
- The grab handle is the only drag start target.
  - It sits between the chevron and folder icon in `renderProjectHeader()` and the mobile inline header.
  - It calls `preventDefault()` and `stopPropagation()` on `pointerdown` and `click`, so dragging never toggles expansion.
  - Existing settings/new-goal buttons keep their `stopPropagation()` and never start drag.
- Use pointer events, not HTML5 drag-only APIs, so desktop mouse and mobile touch share the path.
  - Set `touch-action: none` on the handle.
  - Track movement with document-level `pointermove`/`pointerup`/`pointercancel` listeners after start.
  - Hit-test rows with `[data-project-reorder-id]` and row midpoint Y to compute target index.
- Temporary collapse:
  - During reorder, render project rows header-only by using `effectiveExpanded = isProjectReordering() ? false : isProjectExpanded(project.id)`.
  - Do not call `toggleProjectExpanded()` and do not write `bobbit-expanded-projects` during drag.
  - On drop/cancel, clear transient reorder state; the next render restores the previous persisted expansion state.
- Visual order:
  - While dragging, render `projectOrderForRender()` instead of raw `state.projects` in `renderSidebar()` and `renderMobileLanding()`.
  - On pointer movement, update `visualProjectIds` and `renderApp()`.
  - On drop, optimistically `setProjects(reorderedProjects)`, call `saveProjectOrder(visualProjectIds)`, then replace with server-returned projects. On failure, re-fetch `fetchProjects()` and restore server order.
- Desktop visibility:
  - Add CSS in `src/app/app.css` for `.project-reorder-handle` hidden by default and visible on `.group:hover`, `.group:focus-within`, and `[data-project-reordering="true"]`.
- Mobile visibility:
  - Under `@media (max-width: 767px)`, keep `.project-reorder-handle` always visible and use at least a 32px touch target.
- Collapsed sidebar:
  - No drag affordance needed. `renderCollapsedSidebar()` already uses `state.projects.map(...)`, so persisted order is enough.

Suggested test selectors:

- `data-testid="project-header" data-project-id=${project.id}` on each header.
- `data-testid="project-reorder-handle" data-project-id=${project.id}` on each handle.
- `data-project-reorder-id=${project.id}` on the row wrapper used for hit-testing.
- `data-project-reordering="true"` on the sidebar/mobile root while transient reorder mode is active.

## Test targets

Unit:

- `tests/multi-project.test.ts` or new `tests/project-registry-order.test.ts`:
  - legacy `projects.json` without `position` migrates in existing created-at/on-disk order;
  - `list()` respects custom positions over `createdAt`;
  - `setVisibleOrder()` persists and reloads;
  - `register()` and `registerProvisional()` append after a custom order;
  - `remove()` preserves remaining relative order and does not leave corrupt positions;
  - `registerSystemProject()` remains hidden and excluded from visible order validation.

API E2E:

- New `tests/e2e/project-reorder-api.spec.ts`:
  - create A/B/C, `PUT /api/projects/order` to C/A/B, then `GET /api/projects` returns C/A/B;
  - reload/restart harness still returns persisted order;
  - duplicate, unknown, hidden/system, missing visible, extra/stale IDs fail and leave order unchanged;
  - deleting a project after reorder keeps remaining order;
  - creating a new project after reorder appends at the end.

Browser E2E:

- New `tests/e2e/ui/project-drag-reorder.spec.ts`:
  - desktop: handle hidden until project header hover/focus; dragging handle reorders; project contents collapse while dragging and restore after drop/cancel; reload persists;
  - desktop: clicking header outside handle still toggles expansion; clicking settings/new-goal does not initiate reorder;
  - collapsed desktop sidebar shows projects in persisted order and no reorder handle;
  - mobile viewport: handle always visible; touch/pointer drag reorders; temporary collapse/restore and reload persistence match desktop.
