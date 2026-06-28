# Sidebar font-size control

## Purpose

The **System Settings → General → Appearance → Sidebar font size** control lets each browser tune sidebar readability without changing chat, header, or other app typography. The setting drives `--sidebar-font-scale` and the `.sidebar-root` font size, so all sidebar text and visual affordances should scale together.

This avoids the previous mismatch where labels grew or shrank but sidebar controls kept fixed-size icons, making chevrons drift, compound plus badges disappear, or action rows overflow at large font sizes.

## Control UX

Use a compact numeric field in **System Settings → General → Appearance**:

- Label: **Sidebar font size**
- Control: number input showing pixels, default **14**, range **10–32**, step **1**.
- Unit: show a persistent visual suffix, **px**, immediately beside or inside the input group. Keep the input value numeric only (`14`), not `14px`.
- Help text: `Controls text size in the sidebar only. Chat, header, and other areas are unchanged. Saved per browser.`
- Secondary range hint, either in help text or `aria-describedby`: `10–32 px`.

### Reset copy

Use explicit copy tied to the default:

- Button text: **Reset to 14 px**
- Avoid **Reset to Default** alone; it is ambiguous because existing users may remember older defaults.

### Clamping behavior

- Persisted scale values display as rounded pixels (`scale × 12`, nearest whole px).
- On commit (`change`, blur, or Enter), clamp to **10–32 px**, then save `px / 12` to `--sidebar-font-scale`.
- Do not aggressively clamp every keystroke while the user is typing; partial values like empty, `1`, or `3` should be possible until commit.
- If an invalid value is committed, restore or clamp visibly in the field rather than leaving a stale invalid number.
- Optional but helpful: when clamping occurs, briefly expose inline helper text such as `Minimum is 10 px` / `Maximum is 32 px`; do not rely on colour alone.

### Keyboard and accessibility expectations

- Use a native `input type="number"` with `min="10"`, `max="32"`, `step="1"`, `inputmode="numeric"`, and a visible focus ring matching existing settings inputs.
- Associate the label with the input via `for`/`id`; connect help/range text with `aria-describedby`.
- Ensure the accessible name includes the unit, e.g. `aria-label="Sidebar font size in pixels"`, or rely on label plus described suffix text.
- Arrow Up/Down should change by 1 px; Shift/Page step behaviour can remain browser-native.
- The px suffix must not be the only unit signal for assistive tech; include “pixels” in accessible text.
- Reset is a normal button reachable after the input in tab order, with no focus loss after activation.

### Visual consistency

Match existing settings primitives: `text-sm font-medium` label, `text-xs text-muted-foreground` help text, rounded bordered background input, tabular numeric value, and link-style muted reset action. Keep this control in the same Appearance group as the existing sidebar font-size setting; do not introduce a new section or slider-like visual pattern.

## Scaled sidebar affordances

The font-size setting applies to sidebar visual affordances, not just labels. Sidebar-only icon utilities should use `em` sizing or sidebar-scoped CSS custom properties under `.sidebar-root`; do not change global icon defaults.

Affordances expected to scale with the sidebar font size:

- Top action icons, including Roles, Tools, Skills, Workflows, Market, and New Goal.
- Compound New Goal, New Session, and New Staff icons, including their plus overlays.
- Disclosure chevrons for project, sessions/ungrouped sessions, staff, goals, team leads, live sessions, child sessions, archived sessions, and archived sections.
- Collapsed-sidebar affordances, including collapsed goal, team-lead, Sessions, Staff, and archived chevrons.
- Mobile sidebar/header affordances, including project/staff/session chevrons and role-picker chevrons.

Compound icons must keep the base icon and plus overlay as separate visible elements. The compound container should allow overflow so the badge is not clipped, and the plus overlay should remain visible at every supported font size.

Chevrons should remain centered in their row/control and visually attached to the disclosure target. Expanded desktop rows can keep their absolute-left slot model; mobile and collapsed layouts should use inline/flex slots so alignment follows the row.

## Spacing and overflow behavior

Sidebar action rows should use one sidebar-scoped gap source for related affordances. In rows with PR shortcuts plus regular quick actions, the gap between the PR icon and the first action should match the gap between adjacent actions.

At all supported sidebar font sizes:

- Expanded, collapsed, and mobile sidebars should avoid horizontal scrolling.
- Top and bottom action rows may truncate labels or use flexible button sizing, but icons should remain visible and usable.
- Scaling should preserve click target usability and layout density; avoid broad sidebar selectors that clip generic spans or SVGs.

## Implementation guardrails

- Keep scaling styles opt-in and scoped to `.sidebar-root`.
- Prefer explicit classes for scalable icons, compound icon boxes, plus overlays, chevron slots/glyphs, and action clusters.
- Do not introduce broad selectors such as generic `.sidebar-root svg`, `.sidebar-root button > span`, or overflow rules that can hide nested compound badges.
- Keep numeric constants used for layout arithmetic separate from CSS custom properties unless every consumer is audited.
- Do not affect icon sizing outside the sidebar.

## QA and regression coverage

Focused browser E2E coverage lives in `tests/e2e/ui/sidebar-font-scale.spec.ts`. It should cover both the setting and real sidebar affordances:

- The setting persists, clamps to the supported range, and updates `.sidebar-root` font size.
- Representative top action icons, compound icons, plus overlays, chevrons, and role-picker chevrons grow when the sidebar font size increases.
- New Goal, New Session, and New Staff plus overlays are present, non-zero sized, visible, and positioned over their base icons.
- Representative chevrons stay centered relative to their rows/controls.
- Collapsed-sidebar affordances scale and remain overflow-safe.
- PR/action-row gap equality is asserted within a small tolerance.
- Expanded/collapsed sidebar states do not horizontally overflow at small and large supported font sizes.

Recommended verification for sidebar font-size changes:

```bash
npm run check
npm run test:unit
npx playwright test tests/e2e/ui/sidebar-font-scale.spec.ts --reporter=line
```
