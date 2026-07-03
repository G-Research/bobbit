# Sidebar tree indentation

Sidebar tree indentation is a per-browser appearance preference for how far each nested sidebar level steps inward. It lives beside the sidebar font-size setting so users can trade tree readability against available label width without changing expansion-state keys, project ordering, or chat typography.

The preference feeds the shared sidebar tree builder metadata and CSS layout helpers used by desktop, mobile, and collapsed sidebar render paths. This keeps projects, goals, sub-goals, sessions, delegates, team leads, staff, and archived branches visually consistent while preserving existing chevron slots, truncation, active-row highlighting, and overflow behavior.

For the expansion-state model that consumes this layout metadata, see [Sidebar tree state](sidebar-tree-state.md).

## User setting

Location: **System Settings → General → Appearance → Sidebar tree indentation**.

The control is a numeric pixel input with a visible `px` suffix and a reset action.

| Property | Value |
|---|---|
| Storage key | `bobbit:sidebar-tree-indent` |
| Default | `16` px |
| Range | `8`–`28` px |
| Step | `1` px |
| Reset copy | `Reset to 16 px` |
| Scope | Current browser only |

Behavior:

- Values are saved in `localStorage` under `bobbit:sidebar-tree-indent`.
- Missing, empty, non-numeric, `NaN`, or unavailable storage falls back to `16` px.
- Finite out-of-range values clamp to the nearest bound.
- Decimal values round to the nearest 1 px step.
- Saving is best-effort: if storage writes fail, Bobbit still applies the clamped value in memory for the current page.
- Reset writes the default value and reapplies layout variables immediately.
- Partial low values are not aggressively clamped on every keystroke, so typing remains ergonomic; committed values are clamped.

The setting affects only sidebar tree spacing. It does not change persisted expansion keys, project ordering, session grouping, chevron widths, or chat layout.

## Layout model

`loadSidebarTreeLayoutPreference()` converts the saved pixel value into the resolved layout object passed to `buildSidebarTree()`:

```ts
{
  version: 1,
  indentMode: "comfortable",
  baseIndentPx: 16,
  nestedGoalIndentPx: 16
}
```

Rules:

- `baseIndentPx` and `nestedGoalIndentPx` both come from the clamped user preference in normal runtime use.
- The builder also accepts partial layout objects for tests and future callers; missing values fall back to builder defaults (`baseIndentPx: 5`, `nestedGoalIndentPx: 16`) before clamping.
- Project-forest and archived-forest goal rows use `nestedGoalIndentPx`.
- Runtime rows under goals, sessions, team leads, delegates, and spawned child goals use `baseIndentPx`.
- Collapsed sidebars use a derived value: `min(6, max(2, round(indent / 3)))` so nesting remains visible without pushing compact labels into overflow.

The tree builder emits `indentDepth`, `indentLevel`, and `indentPx` metadata on sidebar nodes. Renderers should prefer the shared helpers below instead of introducing new inline arithmetic.

## CSS variable contract

Runtime variables are owned by `document.documentElement`, not `.sidebar-root`. The sidebar root defines fallback defaults so first paint and storage failures still have safe spacing.

Runtime variables written by `applySidebarTreeLayoutVars()`:

| Variable | Meaning |
|---|---|
| `--sidebar-tree-base-indent` | User-configured spacing for non-goal nested runtime rows. |
| `--sidebar-tree-nested-goal-indent` | User-configured spacing for project/archived goal-tree levels. |
| `--sidebar-tree-collapsed-indent` | Derived capped spacing for collapsed-sidebar nesting. |

Fallback/default variables scoped under `.sidebar-root`:

| Variable | Default |
|---|---|
| `--sidebar-tree-base-indent-default` | `5px` |
| `--sidebar-tree-nested-goal-indent-default` | `16px` |
| `--sidebar-tree-collapsed-indent-default` | `5px` |
| `--sidebar-tree-half-indent` | Half of the active base indent |

Consumption should use logical padding and fallback-aware CSS, for example:

```css
padding-inline-start: var(--sidebar-tree-base-indent, var(--sidebar-tree-base-indent-default));
padding-inline-start: calc(var(--sidebar-tree-nested-goal-indent, var(--sidebar-tree-nested-goal-indent-default)) * 2);
```

Do not redeclare the runtime variable names on `.sidebar-root`. Keep row-internal chevron slots governed by the existing chevron variables such as `--sidebar-chevron-w`, `--sidebar-header-chevron-w`, `--sidebar-inline-chevron-w`, and `--sidebar-collapsed-chevron-w`.

## Layout helper contract

The pure preference and template helpers live in the sidebar tree layout module and are re-exported through app state for renderer call sites.

Preference helpers:

- `clampSidebarTreeIndentPx(px)` — rounds to the supported step; clamps finite out-of-range values; defaults invalid input.
- `loadSidebarTreeIndentPx()` — reads local storage safely and returns the effective pixel value.
- `saveSidebarTreeIndentPx(px)` — stores the clamped value when possible and returns it.
- `resetSidebarTreeIndentPreference()` — stores and returns the default value.
- `sidebarTreeIndentPxToLayout(px)` — converts the user value into the resolved layout object.
- `loadSidebarTreeLayoutPreference()` — reads storage and returns the resolved layout.
- `applySidebarTreeLayoutVars(pxOrLayout)` — writes runtime CSS variables to `document.documentElement`.

Template helpers:

- `sidebarTreeBaseIndentStyle()` — base child indentation.
- `sidebarTreeHalfIndentStyle()` — half-base indentation for compact section nesting.
- `sidebarTreeNodeIndentStyle(node)` — chooses nested-goal or base indentation from node metadata/context.
- `sidebarTreeLegacyGoalIndentStyle(depth)` — goal-depth indentation for legacy-style render paths.
- `sidebarTreeTruncationIndentStyle(depth)` — goal-depth indentation plus header chevron width for “show more” rows.
- `sidebarTreeCollapsedIndentStyle(depth?)` — capped collapsed-sidebar indentation.

Renderer guidance:

- Pass `loadSidebarTreeLayoutPreference()` into sidebar tree construction for desktop, mobile, and collapsed viewports.
- Use helper-generated `padding-inline-start` instead of hardcoded `padding-left`, `node.depth * 16`, or direct `node.indentPx` strings.
- Keep `min-w-0`, `truncate`, overflow gradients, active row classes, and chevron slot padding independent from the indent preference.

## Implementation map

- `src/app/sidebar-tree-layout.ts` owns storage, clamping, resolved-layout conversion, CSS variable application, and template style helpers.
- `src/app/state.ts` applies the saved layout variables during startup and re-exports helpers for app call sites.
- `src/app/sidebar-tree-builder.ts` consumes the resolved layout and emits node indentation metadata without changing expansion-state key semantics.
- `src/app/sidebar.ts` and `src/app/render.ts` pass the loaded layout into desktop, collapsed, and mobile tree construction and use the shared style helpers when rendering rows.
- `src/app/settings-page.ts` renders the Settings control and applies saved/reset values synchronously before re-rendering.

## Test coverage

Unit coverage:

- `tests/sidebar-tree-layout.test.ts` verifies clamping, rounding, corrupt and throwing storage, save/reset behavior, CSS variable application, and collapsed-indent derivation.
- `tests/sidebar-tree-builder.test.ts` verifies resolved layout defaults, edge clamping, custom base/nested indent metadata, and custom nested-goal indentation.

Browser coverage:

- `tests/e2e/ui/sidebar-indent.spec.ts` covers the Settings control, persistence across reload, reset behavior, seeded out-of-range storage clamping, visible nested-goal offset changes, and no horizontal overflow at max indentation in expanded desktop, collapsed desktop, and mobile sidebars.
- `tests/e2e/ui/sidebar-tree-restart.spec.ts` covers restart durability for the stored indentation value and runtime CSS variable application after gateway restart plus reload.

Recommended verification when changing this feature:

```bash
npm run check
npm run test:unit
npx playwright test tests/e2e/ui/sidebar-indent.spec.ts tests/e2e/ui/sidebar-tree-restart.spec.ts --reporter=line
```
