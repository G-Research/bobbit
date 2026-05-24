# Project drag reorder UX

Design guidance for reordering project sections in the expanded desktop sidebar and mobile sidebar.

## Core behavior

- Project order is a global preference: every visible, non-hidden project appears in the persisted order across reloads and browser sessions.
- Reordering is available only from expanded sidebar surfaces: desktop expanded sidebar and mobile sidebar. The collapsed icon-only sidebar follows the saved order but has no drag affordance.
- Dragging is scoped to project headers only. Settings, new-goal, staff/session controls, and project content rows must never start a project drag.
- Clicking/tapping the project header outside the grab handle keeps the current expand/collapse behavior.

## Header anatomy

Project header order:

1. Expand/collapse chevron.
2. Reorder grab handle.
3. Project folder icon.
4. Project name and status badge, if present.
5. Header actions such as settings and new goal.

Use a six-dot or grip icon for the handle. Keep it visually lighter than the project name so it reads as an affordance, not content.

## Handle visibility

### Desktop

- Default: handle space is reserved but the icon is visually hidden to preserve sidebar calm and density.
- Header hover, handle hover, keyboard focus within the header, or active reorder mode: show the handle.
- Focused handle must have a visible focus ring and not rely on hover.
- When the handle is visible, it should not shift the folder icon or project text.

### Mobile/touch

- Handle is always visible because hover does not exist and the feature must be discoverable.
- Minimum touch target: 44px high by 36-44px wide, while preserving the current row rhythm.
- Touch interaction begins only from the handle. The rest of the header remains a normal expand/collapse target.

## Interaction states

| State | Visual treatment | Behavior |
|---|---|---|
| Default | Normal project row; desktop handle hidden, mobile handle visible. | Header click toggles expansion. |
| Hover | Desktop row background matches existing sidebar hover; handle fades in. | No reorder until the handle is dragged. |
| Focus | Focus ring on handle; row may show subtle active background. | Keyboard reorder controls become available. |
| Pressed | Handle shows active background and `grabbing` cursor. | Prevent project toggle. |
| Dragging | Dragged row becomes a raised ghost; original slot is reserved or dimmed. | Pointer controls candidate position. |
| Drop target | Thin insertion line between project headers; target row may nudge by 2-4px. | Shows exactly where the project will land. |
| Saving | Optional small muted spinner or "Saving order…" live status. | Keep local order optimistic. |
| Error | Revert to last server-confirmed order; show compact toast/banner. | Do not leave reorder mode stuck. |

## Transient reorder mode

- Enter reorder mode automatically once a pointer drag starts from a handle after a small movement threshold.
- Reorder mode is temporary and exits on drop, cancel, route change, or lost pointer capture.
- While active:
  - Show every project as a header-only row, regardless of current expansion.
  - Hide project body content visually only; do not mutate persisted expansion state or localStorage.
  - Keep header actions visible but inert for drag start; users should not accidentally open settings or create goals mid-drag.
  - Keep the project list in one continuous vertical stack with separators reduced or hidden so drop targets are clear.

## Temporary visual collapse and restore

- Before entering reorder mode, snapshot each project's expanded/collapsed state.
- During reorder mode, render all project contents as collapsed for visual clarity.
- On successful drop, restore the exact snapshot immediately after applying the new project order.
- On cancel or failed save, restore both the prior order and the prior expansion snapshot.
- Never call the normal project toggle path as part of drag start, drag move, drop, or cancel.

## Drag, drop, and cancel semantics

- Drag starts only from the grab handle, not the whole header.
- Use pointer capture so drag remains stable if the pointer leaves the narrow sidebar.
- A click/tap on the handle without meaningful movement should do nothing except focus the handle.
- Reorder by insertion position, not by swapping rows. The preview should answer: "drop before/after this project".
- Dropping outside the project list cancels and restores the previous order.
- Pressing Escape cancels and restores the previous order.
- Unknown, hidden, or stale project IDs should be ignored by the client UI and rejected gracefully by the server; the user should see the last valid order.
- New visible projects append to the end of the saved order. Removed projects disappear without leaving gaps or corrupting the saved order.

## Mobile touch details

- Use Pointer Events rather than HTML5 drag-and-drop so touch, stylus, and mouse share behavior.
- Apply `touch-action: none` only on the handle; the rest of the sidebar must keep normal vertical scrolling.
- While dragging near the top or bottom of the mobile list, auto-scroll slowly after a short dwell.
- Keep the dragged row under the finger with a slight horizontal offset so the insertion line remains visible.
- Do not require long-press. The visible handle is the explicit permission to drag.

## Accessibility cues

- Render the handle as a focusable button with an accessible name such as `Reorder <project name>`.
- Provide keyboard reorder parity:
  - Space or Enter lifts the focused project.
  - Arrow Up/Down moves the project one position while lifted.
  - Space or Enter drops.
  - Escape cancels.
- Announce state changes through a polite live region: "Picked up Bobbit", "Moved before Sandbox", "Dropped Bobbit at position 2 of 4", or "Reorder cancelled".
- Use visible focus rings and non-color cues for drop targets; the insertion line should have shape/spacing, not color alone.
- Respect reduced motion by disabling row lift/nudge animation while keeping the insertion line.
- Ensure the handle remains reachable in sidebar keyboard navigation order without trapping focus.

## Implementation notes for visual polish

- Use existing sidebar tokens and patterns: `var(--sidebar)`, `var(--secondary)`, `var(--muted-foreground)`, `var(--border)`, project accent color, and current rounded row styling.
- Prefer short transitions: 120-160ms opacity for handle reveal, 80-120ms transform for row nudge. Avoid springy motion in the dense sidebar.
- Preserve scroll position when entering and exiting reorder mode.
- If search/filtering is active, reorder only among the currently visible non-hidden project headers but persist a complete order that keeps non-visible projects in their relative positions.
