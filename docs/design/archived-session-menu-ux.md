# Archived Session Menu UX

**Status:** Implemented UX brief for archived-session action menus.

**Scope:** Archived session rows in the sidebar and archived session actions in the chat/header area on desktop and mobile.

**Implementation reference:** See [Unified Session Actions — Archived session actions](../session-actions.md#archived-session-actions).

## UX intent

Archived sessions are read-only records, but users still need the same discovery pattern they use for live sessions: a compact hamburger trigger that opens safe session actions. The archived menu should feel like the existing session action menu, while clearly excluding actions that mutate, terminate, refresh, or extend live runtime state.

## Sidebar row trigger

- Add a right-aligned hamburger action trigger to archived session rows wherever active session rows expose one.
- Use the same icon-only button footprint, visual treatment, hover/focus states, and popover anchoring as active session row action triggers.
- Label the trigger `Session actions`, matching the live session actions trigger.
- Set `aria-haspopup="menu"` and synchronize `aria-expanded` with the popover state.
- On desktop, the trigger follows the active-row pattern: visually secondary, right-aligned with existing row metadata/timestamp treatment, and revealed consistently with the row action area.
- On mobile/touch, the trigger is always visible in the row action cluster; do not rely on hover.

## Chat/header trigger

- When an archived session is open read-only, show the same top-right session actions hamburger used for active sessions.
- Desktop placement: in the existing chat/header session action area, aligned with other header controls.
- Mobile placement: in the compact top-right mobile header action group, preserving back navigation and title priority.
- The header trigger uses the same accessible name, menu semantics, keyboard behavior, and focus restoration as the sidebar trigger.

## Menu contents and order

Archived menus include built-in, read-only-safe actions only. Do not include extension-provided `session-menu` launchers.

Order:

1. `Continue in new session` — only when the archived session satisfies the existing continue rules: non-goal, non-delegate, non-team, registered project, and transcript available. This uses `POST /api/sessions/:id/continue`, not the live Fork endpoint.
2. `Copy link`
3. `View System Prompt`
4. `Open in new window`

If Continue is not eligible, hide it rather than disabling it. The remaining read-only actions keep the same order.

## Excluded actions

Never show actions that imply live-session mutation, runtime control, or extension execution:

- `Modify` / `Rename`
- `Terminate` / `End team`
- `Refresh agent`
- Live `Fork`
- Extension launcher entries from `session-menu`
- Any destructive or project/runtime mutation action

## Row click preservation

Archived row navigation remains unchanged:

- Clicking/tapping the row opens the archived session read-only.
- Clicking/tapping the hamburger opens the menu only.
- Trigger and menu item handlers must stop row navigation by preventing default row activation and stopping propagation.
- Keyboard focus order should remain predictable: row content first, then row action trigger.
- Opening or closing the menu must not select, expand, collapse, or navigate the row unless the user explicitly chooses a menu item that navigates.

## Accessibility

- Use real `button` elements for icon triggers and menu items.
- Menu container uses `role="menu"`; items use `role="menuitem"`.
- Support Enter/Space activation on triggers and items.
- Escape closes the menu and returns focus to the hamburger trigger.
- Outside click/tap closes the menu without changing the current session selection.
- Focus states must match existing session action controls and be visible in both light and dark themes.
- Labels must be text-stable across sidebar and header so screen reader users encounter the same action names in both places.

## Desktop/mobile behavior parity

- Sidebar and header menus expose the same archived-safe action set for the same session state.
- Mobile uses the same menu labels and order as desktop.
- The hamburger remains visible on mobile even when `Continue in new session` is hidden, because the read-only actions still apply.
- Popover placement may adapt to viewport edges, but behavior and accessibility remain the same.

## Consistency rationale

This design intentionally reuses the active-session hamburger pattern, menu component behavior, and header action grouping. The only difference is the action descriptor source: archived sessions get a separate built-in-only action list so live controls, destructive actions, and extension launchers cannot leak into read-only archived contexts.
