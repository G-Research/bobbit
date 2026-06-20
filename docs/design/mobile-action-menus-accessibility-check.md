# Mobile action menus — UX/accessibility check

Goal: when a mobile hamburger action menu opens, the inline quick controls must stop behaving as separate controls until the menu closes. Source-rect capture for FLIP may use them immediately before opening, but the open state must not leave duplicated visible/clickable/focusable buttons.

## Current pattern risks

- `src/ui/components/SidebarActionsPopover.ts` currently fades row quick buttons by setting inline `opacity`. Opacity alone is not enough: the controls can remain clickable, keyboard-focusable, and exposed to assistive tech.
- `src/app/render.ts` mobile header direct actions are rendered independently from the hamburger open state, so they need the same explicit open-state gating as sidebar rows.
- The trigger already carries the right pattern (`aria-haspopup="menu"`, `aria-expanded` from open state); preserve that and assert it on open and after every close path.

## Implementer recommendations

1. Capture FLIP source rects before flipping render state, then hide quick controls from the rendered open state.
   - Sidebar: capture with `captureSidebarActionSourceRects(row)` in the trigger handler, then render the row with quick buttons hidden while `isSidebarActionsPopoverOpen(kind, entityId)` is true.
   - Header: capture from the header action surface before `openHeaderSessionActionsPopover`, then render direct quick actions hidden while `isHeaderSessionActionsPopoverOpen(session.id)` is true.
2. Do not rely on `opacity: 0` alone. Use one of these robust patterns:
   - Prefer not rendering the quick buttons while the matching mobile menu is open; or
   - Keep layout placeholders but set `visibility:hidden`, `pointer-events:none`, `aria-hidden="true"`, `tabindex="-1"`, and `disabled` on the actual buttons.
3. Hide only the quick action buttons, never the hamburger trigger. The trigger must remain visible and report `aria-expanded="true"` while the menu is open.
4. Restore controls from the single close state, not from animation callbacks alone. Escape, outside click, menu item selection, route change, and state re-render should all clear the open state and re-render quick buttons enabled/focusable.
5. Keep action handlers stopping propagation. Hidden controls must not receive events, and visible controls must not trigger row navigation.

## Tester recommendations

Add mobile assertions around the existing E2E coverage:

- Sidebar mobile session row:
  - Before open: `modify` and `terminate` quick buttons are visible and enabled.
  - After hamburger open: both are not visible and not focusable/clickable; hamburger has `aria-haspopup="menu"` and `aria-expanded="true"`; hash/row selection did not change.
  - After Escape, outside click, and a safe menu action such as Copy link: popover is gone, `aria-expanded="false"`, quick buttons are visible/enabled again.
- Header mobile session actions:
  - Before open: direct quick IDs are exactly `modify`, `terminate`.
  - After hamburger open: both direct quick buttons are hidden/non-interactive; popover still contains the full canonical action list; source rects still include `modify` and `terminate` for FLIP.
  - After each close path: direct quick buttons are restored.
- If the implementation keeps hidden placeholders instead of removing buttons, assert computed state too: no pointer events, disabled or `tabIndex < 0`, and `aria-hidden="true"`.

## Consistency rationale

This preserves the existing desktop sidebar model: hamburger remains the stable menu anchor, quick actions provide source geometry for the shared-element animation, and the popover is the only active action surface while open. The mobile change should be state-driven so all close paths restore the same accessible controls without special-case timing.
