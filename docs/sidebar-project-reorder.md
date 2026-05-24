# Sidebar project drag reorder

Project drag reorder lets users choose the order of project sections in the sidebar. The order is server-side project registry state, not per-browser UI state, so the same order appears after reloads and in other connected browser sessions.

This feature sits between the project registry/API and the sidebar render paths:

- The server stores visible-project order as contiguous project positions.
- `GET /api/projects` returns visible projects in that persisted order.
- The desktop sidebar and mobile landing page render projects in `state.projects` order.
- `PUT /api/projects/order` saves a complete visible-project order and broadcasts `projects_changed` so other clients can update without a reload.

See [REST API — Projects](rest-api.md#projects) for the wire contract.

## User model

### Where the handle appears

Project headers are ordered as:

1. expand/collapse chevron;
2. reorder grab handle;
3. folder icon;
4. project name/status;
5. project actions such as settings and new goal.

Desktop keeps the normal sidebar density by reserving the handle slot but hiding the icon until the project header is hovered, the header has focus within it, the handle itself is focused, or a reorder is active.

Mobile and other non-hover inputs always show the handle with a larger touch target so the affordance is discoverable.

The collapsed desktop sidebar does not render reorder handles, but it still follows the persisted project order when grouping visible items.

### Pointer and touch drag

Dragging starts only from the project reorder handle. The header itself still toggles expansion, and project action buttons stop propagation so settings/new-goal clicks do not begin a drag.

On pointer movement past the drag threshold, Bobbit enters transient reorder mode:

- all project sections collapse visually to header-only rows;
- the active row is highlighted;
- pointer position against row midpoints determines the insertion point;
- dropping inside the project list saves the new order;
- dropping before a real drag starts, dropping outside the list, pointer cancel, or `Escape` cancels.

The temporary collapse is visual-only. Bobbit does not change the persisted expanded/collapsed project set while reordering, so every project restores to its previous expansion state after drop or cancel.

### Keyboard and announcements

The handle is a focusable button labelled `Reorder <project name>`. Keyboard users can:

- press `Space` or `Enter` to lift the focused project;
- press `ArrowUp` or `ArrowDown` to move it;
- press `Space` or `Enter` again to drop;
- press `Escape` to cancel.

A polite live region announces pickup, moves, drop positions, and cancellation. The active handle also exposes pressed/grabbed state for assistive technology.

## Persistence and sync

The server treats the ordered array returned by `GET /api/projects` as the source of truth. Clients should preserve that array order rather than recomputing from timestamps.

When a reorder completes:

1. the client optimistically applies the reordered project array;
2. it sends the full visible project ID list to `PUT /api/projects/order`;
3. on success, it replaces local projects with the server-returned `projects` array;
4. the server broadcasts `projects_changed` with the same ordered project array;
5. connected clients apply the broadcast if the project array changed.

The regular session refresh path also fetches projects, so tabs without an active session WebSocket still converge on the saved order.

New visible projects append to the end of the current custom order. Removing a visible project compacts the remaining positions without changing their relative order.

## Validation and edge cases

Only visible, non-system projects participate in user ordering. Hidden projects, including the synthetic `system` project, remain hidden from `GET /api/projects` and must not be sent to the reorder endpoint.

`PUT /api/projects/order` requires a complete, duplicate-free list of the current visible project IDs:

- malformed bodies, non-string IDs, duplicate IDs, unknown IDs, and hidden/system IDs return `400` with `code: "invalid_project_order"`;
- otherwise valid lists that do not exactly match the current visible project set return `409` with `code: "stale_project_order"` plus the expected and received IDs;
- failed saves do not mutate the registry.

On save failure, the client shows the connection/error dialog and re-fetches projects. If the refetch returns no projects but there were projects before the drag, the client restores the original local order as a fallback.

## Implementation map

- Server registry: `src/server/agent/project-registry.ts` owns position migration, append/delete compaction, hidden/system exclusion, and `setVisibleOrder()` validation.
- REST route: `src/server/server.ts` handles reserved `PUT /api/projects/order` before project-id routes, prevents reserved collection subroutes from matching generic project-ID handlers, returns structured validation errors, and emits `projects_changed` on success.
- Client API/state: `src/app/api.ts` saves project order and refreshes projects during the session polling loop; `src/app/state.ts` gates project-array updates through equality checks.
- Desktop sidebar: `src/app/sidebar.ts` owns shared reorder state, pointer/keyboard handling, live-region rendering, optimistic save/restore, and expanded-sidebar rendering.
- Mobile landing: `src/app/render.ts` reuses the shared handle and reorder helpers while always showing the touch handle.
- Styling: `src/app/app.css` contains handle visibility, focus, touch target, active row, and live-region styles.
