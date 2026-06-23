# Sidebar font-size numeric control UX check

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
