# Project command environments — frontend UX

## Scope

This spec covers the two editing surfaces for non-secret command environment variables:

1. **Project Settings → Components** — component-level defaults for named commands.
2. **Project Settings → Workflows** — per-command-step overrides inside **Advanced**.

It does not add an environment editor to agent sessions, QA steps, worktree setup, extensions, or Bobbit's host process. A Markdown artifact is sufficient because both surfaces already have established key/value and workflow-editor primitives; a standalone visual language would create false implementation differences.

This document is the canonical contract for exact user-facing copy and the
responsive `max-width: 600px` breakpoint. The system design defers to these
strings rather than defining competing UI text.

## Existing-pattern audit

- Component cards are rendered by `renderProjectComponentsTab()` in `src/app/settings-page.ts`. Expanded cards currently order fields as identity → worktree setup → **Commands** → **Config**, use `wf-input`, `wf-field-label`, `wf-criteria-add-btn`, and `wf-gate-delete`, and share one dirty/Save state.
- Component edit-state normalization and the Components-tab save payload live in `src/app/components-editor.ts`.
- Command verification steps are rendered by `renderVerifyStepEditor()` in `src/app/workflow-page.ts`. **Advanced** currently contains Phase, Timeout, Role when applicable, Component when applicable, then Description.
- The workflow renderer is shared by the project editor, read-only inspector, and embedded goal-draft editor. `notifyControlledChange()` owns embedded changes; page saves use draft owner/revision guards.
- `src/app/workflow-page.css` owns the exact form, error, add/remove, details, and responsive primitives used by both requested surfaces.

## 1. Component Command Environment

### Placement and hierarchy

Inside every expanded component card, insert the section **immediately after Commands and before Config**. It is a sibling `wf-field`; do not nest it inside Commands or Config.

Section order:

1. Header row: **`Command Environment (N)`** and, when `N > 0`, **`Add variable`**.
2. Explanatory copy.
3. Plaintext warning.
4. Empty state or editable rows.

Use this exact copy:

- Description: **`Values are injected into this component’s named commands at execution time. Saved changes affect the next command without restarting Bobbit.`**
- Warning: **`Stored as plaintext. Do not enter API keys, tokens, passwords, or other secrets. Use Sandbox Tokens or Provider API Keys for sensitive values.`**
  - `Sandbox Tokens` routes to this project's **Commands → Tokens** section.
  - `Provider API Keys` routes to **System Settings → Models → Provider API Keys**.
- Literal-value hint: **`Values are passed literally; Bobbit does not expand $VAR or ${VAR}.`**
- Empty state: **`No command environment variables.`**
- Empty-state action: **`Add variable`**.

The warning is always visible, including the empty state. Use a compact warning treatment with `var(--warning)`, an alert-triangle icon, and normal foreground text; it is guidance, not a blocking validation alert.

### Rows

Each row has:

- **Name** — text input, placeholder `VARIABLE_NAME`, monospace value.
- **Value** — text input, placeholder `Value (blank is allowed)`, normal text or monospace consistent with Commands.
- Remove icon button — accessible name **`Remove {name} variable`**, falling back to **`Remove variable {row number}`** while the name is blank. Visual tooltip: **`Remove variable`**.
- Optional origin text is unnecessary here: every row is component-owned.

Use real `<label for>` associations for every input. At desktop widths, labels may align as column headings while remaining programmatically associated per row. On narrow screens, show **Name** and **Value** above their inputs.

`Add variable` appends one blank row, marks the Components tab dirty, and focuses its Name input. Remove does not require confirmation; it marks dirty and moves focus to the next row's Name, otherwise the previous row's Name, otherwise `Add variable`.

A blank **value** is valid and means explicitly empty. Removing the row means inherit/unset. A blank **name** is an incomplete row and blocks Save; it must not be silently dropped.

### Validation

Validate locally on blur and after the first Save attempt; after that, revalidate edited rows on input. Save is blocked while any row is invalid. Use `wf-input-error`, `aria-invalid="true"`, `aria-describedby`, and an adjacent `wf-field-error`.

Exact messages:

- Blank name: **`Variable name is required.`**
- Invalid name: **`Use letters, numbers, and underscores; start with a letter or underscore.`**
- Case-insensitive duplicate: **`“{name}” duplicates “{otherName}”. Variable names must be unique ignoring case.`** Mark every colliding row, not only the later one.
- Key/value length: **`Variable names can be at most {limit} characters.`** / **`Values can be at most {limit} characters.`** Use the shared server constants rather than a UI-only number.
- Entry cap: **`Maximum 100 variables per environment.`** Disable `Add variable` at 100 and associate this explanation with the disabled control.

Do not trim or transform values. Name validation uses `/^[A-Za-z_][A-Za-z0-9_]*$/`; duplicate comparison uses locale-independent lowercase/case-folding.

If the server rejects Save, retain the draft and dirty state. Map structured field errors to the matching row when available; otherwise keep the existing Components error banner and **`Failed.`** status.

### Dirty and save behavior

Reuse the existing Components-tab contract exactly:

- Any add/edit/remove marks the shared tab dirty and enables the existing **Save** button.
- No autosave and no restart request.
- While saving, button text is **`Saving…`** and editing state is preserved.
- Success clears dirty state and shows **`Saved.`** as `role="status"`; the plaintext warning remains.
- Saved values appear after a tab reload/page reload and apply to the next command invocation.
- Failure leaves the draft dirty and focusable for correction.
- Navigating away and back during the same mounted settings session keeps the existing in-memory dirty draft; a full browser reload discards unsaved changes, as today.

## 2. Workflow command-step Environment overrides

### Visibility and placement

Render this editor **only when `step.type === "command"`**. Do not render it for `llm-review`, `agent-qa`, `human-signoff`, or future non-command types. When changing away from `command`, remove `step.env` alongside other command-only fields so hidden stale YAML cannot survive.

Within the verification step's **Advanced** details, place it **after Component and before Description**. For a command step, the resulting order is Phase → Timeout → Component → **Environment overrides** → Description.

The block heading is **`Environment overrides (N)`**. Use the same row, add, remove, label, focus, validation, 100-entry cap, literal-value, and plaintext-warning behavior as the component editor. The add action is **`Add variable`**.

Copy:

- Intro: **`Overrides apply to this command step only.`**
- Warning: **`Stored as plaintext. Do not enter API keys, tokens, passwords, or other secrets. Use Sandbox Tokens or Provider API Keys for sensitive values.`**
- Literal hint: **`Values are passed literally; Bobbit does not expand $VAR or ${VAR}.`**

### Inheritance and runtime origin

Show a compact, non-editable precedence line immediately below the intro. Never enumerate or fetch host process variables.

Dynamic text:

| Command shape | Exact precedence text | Empty-state text |
|---|---|---|
| Named command with selected component `api` | **`Precedence: Step override → api Command Environment → Bobbit process environment.`** | **`No environment overrides. This step inherits api Command Environment.`** |
| Free-form `run` with selected component `api` | **`Precedence: Step override → api Command Environment → Bobbit process environment.`** | **`No environment overrides. This step inherits api Command Environment.`** |
| Free-form `run` without a component | **`Precedence: Step override → Bobbit process environment.`** | **`No environment overrides. This step uses the Bobbit process environment.`** |
| Named command before a valid component is selected | **`Select a component to show inherited command environment.`** | **`No environment overrides.`** |

Do not show inherited component values in this block. For each populated override row, show a compact origin badge:

- **`Overrides component`** when its name case-insensitively matches a key in the selected component environment.
- **`Step only`** when it does not.

The badge is informational; accessible text repeats the meaning. This communicates precedence/origin without exposing unrelated process values. If component metadata cannot load, omit row badges and retain the precedence line; editing must remain available.

### Workflow draft and save behavior

- Every row change produces a new `step.env` record through the existing immutable step-update path and calls `notifyControlledChange()`.
- Project Workflows keep their existing explicit **Save** action and save validation banner. Invalid env fields expand both the owning gate/step and its **Advanced** details on Save.
- The embedded goal-draft editor has no independent Save button; its existing `onChange` receives the env map as part of the workflow draft.
- Read-only workflow inspectors display populated overrides and precedence, but hide add/remove actions and disable inputs. Empty read-only overrides may show only the empty inheritance line.
- Deep-clone `env` in project selection, embedded editor seeding, proposal customization, and any workflow-draft cloning path. Expansion state and unsaved edits must not leak between editor instances.
- A successful save/reload reproduces blank values exactly. A failed save leaves the workflow draft intact.

## 3. Responsive and accessibility contract

- Reuse the existing `wf-*` input/button/error classes; add only a shared environment-row/grid class rather than a second key/value visual language.
- Desktop row grid: `minmax(9rem, .45fr) minmax(0, 1fr) auto`, with all parents `min-width: 0`.
- At `max-width: 600px`, stack Name, Value, origin badge, and remove action; inputs are `width: 100%`, remove aligns to the trailing edge, warning/help wraps, and no element creates horizontal scrolling.
- Touch targets for add/remove are at least 40×40 CSS px at the narrow breakpoint even though the desktop icon follows the existing 24px visual size.
- Visible focus uses the existing ring token on inputs **and buttons**; do not rely on hover or color alone.
- Warning includes icon + text. Errors include text + border + `aria-invalid`, and the top save summary uses `role="alert"`.
- Section count updates immediately and is exposed in the heading text. Save success uses `role="status"`.
- Preserve DOM/focus stability while typing: do not force a full application render for each value keystroke unless the current validation state requires it.
- Keyboard order is Name → Value → Remove → next row → Add variable → existing page controls. No drag interaction is introduced.

## 4. Consistency rationale

- **Inputs/labels:** reuse `wf-input`, `wf-field-label`, `wf-input-error`, `wf-field-error` from workflow and component editors.
- **Add/remove:** reuse `wf-criteria-add-btn` and the existing X-icon delete treatment (`wf-gate-delete`/shared equivalent), adding accessible names and narrow-screen hit-area styling.
- **Container:** use the existing sibling `wf-field` grouping in component cards and `wf-vstep-advanced-fields` in steps; no new card inside either surface.
- **Advanced disclosure:** environment stays in the existing command step **Advanced** disclosure because it is an execution override, not the primary command source.
- **Feedback:** reuse Components' Save/Saving/Saved/Failed state and Workflow's inline validation plus save-error banner.
- **Intentional difference from Commands/Config rows:** environment rows require associated labels, blank values, case-insensitive duplicate errors, origin badges, and security guidance. Those differences are required by the environment contract rather than a new design language.

## 5. Frontend implementation file map

| File | Frontend responsibility |
|---|---|
| `src/app/components-editor.ts` | Add `env` rows to `ComponentEditState`/server shape, preserve blank values, and include native `env` in the Components save payload. |
| `src/app/settings-page.ts` | Insert Command Environment between Commands and Config; add labels, warning, actions, local validation, focus management, dirty/save status semantics, and credential-navigation actions. |
| `src/app/api.ts` | Add `env?: Record<string, string>` to `VerifyStep` and relevant structured frontend types. |
| `src/app/workflow-page.ts` | Render command-only Advanced overrides; load selected component env key metadata for origin badges; validate; strip env on non-command type change; preserve env through immutable updates and every page/embed clone path; open invalid Advanced fields on Save. |
| `src/app/workflow-page.css` | Shared environment grid, warning, origin badge, focus-visible, error, disabled, and ≤600px stacking/hit-area rules. |
| `src/app/project-proposal-views.ts` | Extend proposal component/step types and read-only summaries so proposed component env and workflow step overrides are visible rather than silently absent. |
| `src/app/proposal-panels.ts` | Deep-clone each verification step's `env` during workflow customization so embedded drafts cannot mutate cached project workflows. |

Production validation and persistence remain server-owned; frontend limits/messages must consume or mirror the canonical shared contract rather than define a competing schema.
