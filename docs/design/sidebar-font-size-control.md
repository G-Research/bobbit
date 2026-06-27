# Sidebar font-size control

The sidebar font-size setting is a browser-local appearance preference for the app shell sidebar. It changes the sidebar's text rhythm without changing chat, headers, dialogs, or other product surfaces.

## Recommendation

Use a compact numeric field in **System Settings → General → Appearance**:

- Label: **Sidebar font size**
- Control: number input showing pixels, default **14**, range **10–32**, step **1**.
- Unit: show a persistent visual suffix, **px**, immediately beside or inside the input group. Keep the input value numeric only (`14`), not `14px`.
- Help text: `Controls text size in the sidebar only. Chat, header, and other areas are unchanged. Saved per browser.`
- Secondary range hint, either in help text or `aria-describedby`: `10–32 px`.

## Reset copy

Use explicit copy tied to the new default:

- Button text: **Reset to 14 px**
- Avoid **Reset to Default** alone; it is ambiguous because existing users may remember the old 12 px default.

## Clamping behavior

- Persisted scale values should display as rounded pixels (`scale × 12`, nearest whole px).
- On commit (`change`, blur, or Enter), clamp to **10–32 px**, then save `px / 12` to `--sidebar-font-scale`.
- Do not aggressively clamp every keystroke while the user is typing; partial values like empty, `1`, or `3` should be possible until commit.
- If an invalid value is committed, restore/clamp visibly in the field rather than leaving a stale invalid number.
- Optional but helpful: when clamping occurs, briefly expose inline helper text such as `Minimum is 10 px` / `Maximum is 32 px`; do not rely on colour alone.

## Keyboard and accessibility expectations

- Use a native `input type="number"` with `min="10"`, `max="32"`, `step="1"`, `inputmode="numeric"`, and a visible focus ring matching existing settings inputs.
- Associate the label with the input via `for`/`id`; connect help/range text with `aria-describedby`.
- Ensure the accessible name includes the unit, e.g. `aria-label="Sidebar font size in pixels"`, or rely on label plus described suffix text.
- Arrow Up/Down should change by 1 px; Shift/Page step behaviour can remain browser-native.
- The px suffix must not be the only unit signal for assistive tech; include “pixels” in accessible text.
- Reset is a normal button reachable after the input in tab order, with no focus loss after activation.

## Consistency check

Match existing settings primitives: `text-sm font-medium` label, `text-xs text-muted-foreground` help text, rounded bordered background input, tabular numeric value, and link-style muted reset action. Keep this control in the same Appearance group as the existing sidebar font-size setting; do not introduce a new section or slider-like visual pattern.

## Sidebar affordance scaling

The setting writes the persisted scale to `--sidebar-font-scale`; `.sidebar-root` consumes it as its base `font-size`. Sidebar affordance icons then inherit that size through sidebar-scoped `em` and CSS-variable utilities instead of fixed pixel dimensions.

Covered affordances include:

- top action icons: Roles, Tools, Skills, Workflows, Market, and New Goal;
- add-goal, add-staff, and add-session compound icons, including the plus overlays;
- expanded, collapsed, mobile, project, staff, session, goal, team-lead, ungrouped, and archived disclosure chevrons;
- role-picker / “New session with role” chevrons;
- sidebar action rows where PR badges and adjacent action buttons share the same gap source.

These utilities are scoped under `.sidebar-root` so changing the sidebar font size cannot resize lucide icons or action spacing elsewhere in the app. The scope also keeps sidebar-specific density rules local: visual icon size follows the font scale, while click targets and non-sidebar surfaces keep their existing behavior.

## Regression coverage

`tests/e2e/ui/sidebar-font-scale.spec.ts` owns the full-stack regression coverage. The `sidebar icons, chevrons, overflow, and action gaps follow sidebar font size @repro` path checks desktop affordances, collapsed-sidebar chevrons, min/max horizontal overflow, vertical scrolling, and PR-to-action gap equality. The mobile `@repro` path checks project/sidebar affordances at a phone viewport, including project and sessions chevrons, add buttons, role-picker chevrons, max-size overflow, and vertical scrolling.
