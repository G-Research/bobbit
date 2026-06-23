# Add Project inline directory creation UX

Status: design-doc gate artifact  
Owner: goal `goal-a9ad7bc0`  
Scope: Add Project path step only.

## Problem

The current Add Project dialog supports creating a typed project directory, but the create action is placed in the modal footer beside Continue. A nonexistent directory is also easy to read as an invalid path rather than as a recoverable "create this folder" state.

## Goals

1. Keep path guidance where users already scan the path field.
2. Treat a nonexistent typed directory as a neutral creation opportunity, not a normal validation error.
3. Make `Create Directory` prominent and directly adjacent to `Directory doesn't exist`.
4. Preserve autocomplete, preflight, and footer layout invariants from the existing Add Project implementation.

## Affected ownership boundaries

| Area | Owner | Change |
|---|---|---|
| `src/app/dialogs.ts::showProjectDialog` | Add Project path-step state, status rendering, create action orchestration | Move create CTA from footer into `add-project-status-slot`; define status render priority; refresh detection/preflight after creation. |
| `src/app/api.ts::createDirectory` | Client API helper | Keep structured `errorFromResponse` behavior; no new response shape required. |
| `src/server/server.ts` `/api/create-directory` | Server filesystem contract | Existing endpoint remains the source of structured create failures. Preserve codes: `invalid_path`, `parent_not_found`, `exists_as_file`, `permission_denied`, `already_exists`, `create_failed`. |
| `src/ui/components/DirectoryPicker.ts` | Input value, suggestion lookup, keyboard behavior | No layout or lookup behavior change. Use existing `setCompletedPath()` from `showProjectDialog` after successful creation. |

## Path-step layout

Keep the existing structure:

```text
Project Directory label
[directory-picker input + Browse…]
[status / validation area: add-project-status-slot]
[preflight area: add-project-preflight-slot]
------------------------------------------------
Cancel                                Continue
```

The inline create UX lives only in `add-project-status-slot`. It must not be added to:

- the `DirectoryPicker` root, because suggestions/loading are absolute overlays below the picker;
- the modal footer, because footer position and actions must remain stable;
- a separate field hint outside the existing status/validation area.

## Required hint copy

When the path is empty, `add-project-status-slot` renders exactly:

> Type a path or click Browse to pick a directory, or type a path of a new directory to create it

Treatment: `text-xs text-muted-foreground`, readable in light/dark themes, no trailing period.

## Status-slot contract

`add-project-status-slot` is the single source for path guidance, checking, nonexistent-directory creation, and create errors.

Render priority:

1. `errorMessage`: show existing general error text.
2. `createErrorMessage`: show inline create block with error text and retry button when a path is present.
3. Empty path: show exact hint copy.
4. Detection loading or missing detection result: show `Checking directory…`.
5. `detectionResult.exists === false`: show inline create block with `Directory doesn't exist` and `Create Directory`.
6. Existing Bobbit project: show existing green register-project status.
7. Existing non-empty directory: show existing setup status.
8. Existing empty directory: show existing scaffold status.

This priority prevents duplicate footer actions and ensures create failures stay visible until the user changes the path or retries.

## Nonexistent directory UI

When the typed path is syntactically usable and detection reports `exists === false`, show a centered neutral block in `add-project-status-slot`:

```text
Directory doesn't exist
[Create Directory]
```

Recommended rendering:

```ts
html`
  <div
    class="flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-3 py-3 text-center"
    data-testid="add-project-inline-create"
  >
    <div class="text-xs font-medium text-foreground">Directory doesn't exist</div>
    ${Button({
      variant: "default",
      onClick: createTypedDirectory,
      disabled: busy || archiving || creatingDirectory,
      children: html`<span data-testid="add-project-create-directory">${creatingDirectory ? "Creating…" : "Create Directory"}</span>`,
    })}
  </div>
`;
```

Rationale:

- `items-center justify-center text-center` makes the action visible during normal form scanning.
- `min-h-[88px]` creates a real validation-area target without moving footer controls.
- Dashed neutral styling indicates “not created yet,” not “invalid.”
- `Button({ variant: "default" })` makes create discoverable and reuses the app button primitive.

## State machine

| Event/state | Dialog state updates | Detection/preflight behavior | UI result |
|---|---|---|---|
| Path empty | `pathValue = ""`; clear detection/preflight/create errors | No detection/preflight | Exact hint copy; Continue disabled |
| User types path | Clear `errorMessage` and `createErrorMessage`; bump detection/preflight tokens | Debounced detection and preflight for typed path | `Checking directory…` while pending |
| Detection says missing | `detectionResult.exists === false`; `detectionLoading = false` | Existing preflight may also report `path.exists`; do not make that the primary visible error | Centered `Directory doesn't exist` + `Create Directory`; Continue disabled |
| Click Create Directory | `creatingDirectory = true`; clear create/general errors; disable picker | No stale lookup should reopen suggestions; in-flight detection/preflight tokens are already guarded by `onEffectivePathChange` and refreshed after success | Inline button reads `Creating…`; dialog stays open |
| Create succeeds | `pathValue = created.path || typed`; `creatingDirectory = false`; call picker `setCompletedPath(createdPath)` | Call `onEffectivePathChange(createdPath, true)` to bump tokens and immediately rerun detection/preflight | Inline create block disappears after detection sees existing dir; normal scaffold/existing status appears |
| Create returns `already_exists` | Treat as recoverable success for UI flow; set completed path and rerun detection/preflight | Same as success | No create error; Continue becomes available when checks pass |
| Create fails structurally | `creatingDirectory = false`; set mapped `createErrorMessage`; keep path | Do not close modal; no auto-continue | Inline error block + retry `Create Directory` |
| User changes path after error | Clear create error via `onEffectivePathChange` | Debounced detection/preflight for new path | New checking/create/existing state |

## API and error contract

`createDirectory(dirPath)` posts:

```http
POST /api/create-directory
Content-Type: application/json

{ "path": "<absolute path>" }
```

Success:

```json
{ "path": "<created absolute path>" }
```

Structured failures are normalized by `errorFromResponse()` in `src/app/api.ts` and mapped in `showProjectDialog`:

| Server code | UI copy |
|---|---|
| `invalid_path` | `Enter an absolute directory path.` |
| `parent_not_found` | `The parent directory does not exist.` |
| `exists_as_file` | `A file already exists at that path.` |
| `permission_denied` | `Permission denied creating this directory.` |
| `already_exists` | Recover: rerun detection/preflight and allow Continue when valid. If shown, `That directory already exists; refresh and continue.` |
| other / `create_failed` | `Could not create directory: <message>` |

No new API fields are required.

## Preflight composition

For a nonexistent typed path, the recoverable create state must be primary. Avoid showing a duplicate red `path.exists` row as the main user-facing validation state while `detectionResult.exists === false` and the inline create block is visible.

Implementation options:

- Hide the preflight panel while `showInlineCreate === true`, or
- filter/de-emphasize only the `path.exists` fail row for that state.

Continue remains disabled until the directory exists and preflight has no hard failures. Other existing-directory preflight failures remain visible and blocking.

## DirectoryPicker/autocomplete invariants

Do not change these invariants:

- Suggestions stay `position: absolute` below the picker and do not push layout.
- Suggestions never appear when the path input is blurred.
- Selecting a suggestion, Browse modal selection, Select current, picker sync, or successful creation marks the path as completed and must not auto-open child suggestions.
- Next-level suggestions appear only after explicit user intent: trailing separator, additional typing/editing, or keyboard request.
- Arrow navigation, Enter selection/commit, and Escape close behavior remain as pinned by `tests/e2e/ui/add-project-typeahead.spec.ts`.
- Stale async lookup results must not reopen suggestions after blur, selection, or a no-longer-qualifying input.

## Footer invariant

On the path step, the footer renders only:

- `Cancel`
- `Continue`

`Create Directory` is not rendered inside `add-project-footer`. The footer container remains outside scrollable content and stable across typing, suggestions, inline create, errors, and creation loading.

## Test plan

Browser E2E coverage should update/extend:

- `tests/e2e/ui/add-project-flow.spec.ts`
  - exact hint copy is visible on empty path;
  - nonexistent path shows `Directory doesn't exist` and inline `Create Directory` in `add-project-status-slot`;
  - create button is absent from `add-project-footer`;
  - successful creation creates the directory, removes inline create state, refreshes detection/preflight, and allows Continue;
  - create failures stay inline and modal remains open.
- `tests/e2e/ui/add-project-typeahead.spec.ts`
  - existing suggestion selection, blur invalidation, trailing separator, Enter, and Escape regressions still pass;
  - no popover appears after creation marks the completed path.
- `tests/e2e/ui/add-project-browse-modal.spec.ts`
  - Browse/Select current still sets a completed path without opening child suggestions.
- `tests/e2e/project-detect-browse.spec.ts`
  - existing `/api/create-directory` structured error coverage remains valid; extend only if a missing error code is uncovered.

Validation commands:

```bash
npm run check
npx playwright test tests/e2e/ui/add-project-flow.spec.ts tests/e2e/ui/add-project-typeahead.spec.ts tests/e2e/ui/add-project-browse-modal.spec.ts --reporter=line
npx playwright test tests/e2e/project-detect-browse.spec.ts --reporter=line
```

## Acceptance checklist

- Empty path hint exactly matches the required sentence.
- Nonexistent typed path shows `Directory doesn't exist` plus directly adjacent `Create Directory` in `add-project-status-slot`.
- The inline create block is centered and visually prominent.
- The footer does not render `Create Directory`.
- Create success creates the directory, marks the picker path completed, reruns detection/preflight, and removes the inline block.
- Create failures render inline in `add-project-create-error` and keep the modal open.
- Duplicate missing-path/preflight error treatment is suppressed while inline create is visible.
- DirectoryPicker overlay, keyboard behavior, blur gating, stale-result gating, and completed-path gating remain unchanged.
