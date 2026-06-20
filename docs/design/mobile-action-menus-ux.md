# Mobile action menus UX note

**Status:** Decision note for the Mobile Action Menus goal.  
**Scope:** Mobile sidebar/landing rows and the mobile chat header. This is an implementation-oriented UX spec, not a prototype.

## Decisions

### Mobile sidebar and landing rows

- Keep the row as the primary navigation target, but reserve a right-aligned action cluster inside each relevant row.
- Session rows show quick icon buttons first, then the hamburger trigger:
  1. Edit / modify session, when available.
  2. Terminate / end team, when available.
  3. Hamburger for the full session menu.
- Quick buttons and the hamburger must be always visible on touch/mobile; do not rely on hover discovery.
- Use the same visual density as current mobile rows: compact icons, no text labels in the row action cluster, and alignment centered to the row height.
- Minimum effective tap target: 44px high and about 36-44px wide per control. If the visual icon remains smaller, increase the button hit area with padding.
- Action controls must call `preventDefault()` and `stopPropagation()` for pointer/click/keyboard activation so tapping them never selects, opens, or navigates the underlying row.
- Keep focus order predictable: row content first, then quick actions left-to-right, then hamburger.

### Mobile goal rows

- Goal rows expose a right-aligned hamburger trigger on mobile, even when they have no inline quick actions.
- The hamburger opens the existing `SidebarActionsPopover` for goal actions.
- Menu contents should match the desktop goal menu model and include applicable actions such as:
  - Dashboard / open goal.
  - Re-attempt.
  - Copy link.
  - Open on GitHub, when a GitHub branch URL is available or still loading.
  - Archive / destructive actions when already supported by the desktop menu.
- Popover-only goal actions remain popover-only; do not promote actions such as Re-attempt into permanent mobile inline buttons unless a separate decision changes the desktop action taxonomy.

### Mobile chat header

- In the mobile chat screen header, place icon-only quick actions immediately before the hamburger in the top-right action group.
- Show quick actions for:
  - Edit / modify session or goal-team details, when available.
  - Terminate session / end team, when available.
- Do not render text labels in the header action group. Use accessible names and optional tooltips/title text instead.
- The hamburger opens the full session action menu using the same `SidebarActionsPopover` component and action descriptors as the desktop/sidebar model.
- The full menu should include quick actions as menu rows as well, so the open menu remains complete and keyboard-accessible.
- On narrow widths, preserve the back button and title first. If space is constrained, keep the hamburger visible and allow lower-priority quick icons to collapse before the hamburger.

## Shared-element / FLIP motion

- Reuse the existing `SidebarActionsPopover` shared-element pattern rather than inventing a mobile-only animation.
- When opening from the sidebar row or mobile header hamburger, capture source rects for the visible quick action buttons and pass them into the popover so matching menu rows animate from the icon locations.
- The animation should communicate continuity: visible quick icons become their corresponding rows in the opened menu.
- If a quick action is not currently rendered, it should not produce a source rect; the menu row simply appears with the normal popover entrance.
- Respect reduced-motion settings by disabling or shortening transform animation while keeping the menu behavior identical.

## Accessibility and interaction requirements

- Render quick actions and hamburgers as real buttons.
- Every icon-only button needs a specific `aria-label`, for example:
  - `Edit session <title>`
  - `Terminate session <title>`
  - `Session actions for <title>`
  - `Goal actions for <title>`
- Hamburger buttons set `aria-haspopup="menu"` and keep `aria-expanded` synchronized with popover state.
- The popover keeps existing menu semantics: `role="menu"`, menu items with clear labels, roving keyboard focus, and disabled states where applicable.
- Keyboard behavior:
  - Enter/Space activates focused quick buttons and hamburger.
  - Escape closes an open popover and returns focus to the trigger.
  - Arrow-key behavior inside the popover follows the existing `SidebarActionsPopover` implementation.
- Pointer behavior:
  - Outside click/tap closes the popover.
  - Tapping a menu item runs the action and closes or refreshes the menu according to existing desktop behavior.
  - Tapping quick buttons or hamburger must never bubble to row navigation.

## Implementation anchors

- Sidebar rows: `src/app/render-helpers.ts` — `renderSessionRow`, `renderGoalGroup`, `renderSidebarQuickActions`, `renderSidebarActionsTrigger`, `openSidebarActionsPopover`.
- Mobile chat header: `src/app/render.ts` — `renderHeaderSessionActions` and header popover source-rect capture.
- Popover and motion: `src/ui/components/SidebarActionsPopover.ts` and `src/ui/components/sidebar-actions-flip.ts`.
- Tests should update the previous mobile invariant that hid sidebar hamburgers and add coverage for mobile row triggers, header quick icons, no header labels, and source rect capture for visible quick actions.
