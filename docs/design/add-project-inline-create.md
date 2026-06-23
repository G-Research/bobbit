# Add Project inline directory creation UX

Status: shipped implementation reference
Owner: goal `goal-a9ad7bc0`
Scope: Add Project path step only.

## Context

The Add Project dialog is the path-first entry point for registering an existing
project or starting a new one. Directory browsing, typeahead, detection,
preflight, and project-assistant handoff all converge on the typed `rootPath`.

Inline directory creation solves one specific gap: users can type a new project
directory path without leaving Bobbit to create the folder manually. The
nonexistent-path state is treated as a recoverable creation opportunity, not as
a normal validation error.

## User-facing behavior

### Empty path guidance

When the path field is empty, `add-project-status-slot` renders the exact hint:

> Type a path or click Browse to pick a directory, or type a path of a new directory to create it

The hint keeps the original prefix, adds the creation suffix, uses subordinate
muted text, and lives in the status slot below the picker. It does not change
the picker height or suggestion overlay positioning.

### Nonexistent directory state

When the typed path is syntactically usable and detection reports that it does not exist, the status slot shows a centered inline block:

```text
Directory doesn't exist
[Create Directory]
```

Implementation selectors:

- Container: `data-testid="add-project-inline-create"`
- Status area: `data-testid="add-project-status-slot"`
- Button label span: `data-testid="add-project-create-directory"`

The button is directly adjacent to the message and is rendered in the
validation/status area, not in the modal footer. The path-step footer remains
limited to `Cancel` and `Continue`, so footer layout stays stable while typing,
opening suggestions, creating, or showing errors.

### Create Directory action

Clicking `Create Directory` calls the client `createDirectory()` helper, which
posts to `POST /api/create-directory` with the typed absolute path. While the
request is running, the button label changes to `Creating…` and the dialog stays
open.

On success:

1. The dialog uses the returned path when present, otherwise the typed path.
2. The `DirectoryPicker` is updated via `setCompletedPath()` so the created path is treated as a completed selection.
3. Detection and preflight are refreshed for the created directory.
4. The inline create block disappears after detection sees the directory.
5. The normal existing-directory/scaffolding state controls whether `Continue` is enabled.

A structured `already_exists` response is recoverable. The UI treats it like a
refresh signal: detection and preflight rerun, no create error is shown, and the
user can continue if the directory is otherwise valid.

### Inline errors

Creation failures are rendered inline in the same status slot with
`data-testid="add-project-create-error"`. They do not close the Add Project
dialog, do not move into the footer, and do not auto-continue.

Mapped errors stay stable for the known server codes:

| Server code | UI copy |
|---|---|
| `invalid_path` | `Enter an absolute directory path.` |
| `parent_not_found` | `The parent directory does not exist.` |
| `exists_as_file` | `A file already exists at that path.` |
| `permission_denied` | `Permission denied creating this directory.` |
| `already_exists` | Recover by refreshing detection/preflight. |
| Other / `create_failed` | `Could not create directory: <message>` |

Changing the path clears the create error and starts the normal detection/preflight cycle for the new value.

## Status-slot priority

`add-project-status-slot` is the single place for path guidance, checking text, nonexistent-directory creation, and create failures.

Render priority:

1. General path/dialog error.
2. Create error plus retry button when the current path can still be created.
3. Empty-path hint.
4. `Checking directory…` while detection is pending or missing.
5. `Directory doesn't exist` plus `Create Directory` when detection reports `exists === false`.
6. Existing configured Bobbit project status.
7. Existing non-empty directory setup status.
8. Existing empty-directory scaffolding status.

This ordering keeps missing-directory creation primary and prevents the preflight
`path.exists` failure from looking like the main validation error while the
inline create affordance is visible.

## Autocomplete invariants

The inline create UX preserves the `DirectoryPicker` intent-gating rules:

- Typing a prefix such as `/tmp/al` browses the parent directory with prefix `al`.
- Selecting a suggestion, Browse modal selection, Select current, picker sync, or successful creation marks the path as completed.
- Completed paths do not automatically open next-level child suggestions.
- Child suggestions appear only after explicit intent, such as typing a trailing
  path separator, continuing to edit, or using keyboard navigation to request
  suggestions.
- Suggestions never appear when the input is blurred.
- Arrow keys navigate suggestions, Enter selects/commits, and Escape closes suggestions before the outer dialog can close.
- Async lookup results are ignored if they are stale, the input blurred, the value changed, or the lookup intent no longer matches.

Successful creation intentionally uses `setCompletedPath()` so a newly-created
folder with children does not immediately open a suggestion popover. A trailing
separator after creation still lists children.

## API contract

`POST /api/create-directory` creates only the final path segment. It does not
recursively create missing parents, because silently creating a directory tree
can put a project somewhere the user did not intend.

Request:

```http
POST /api/create-directory
Content-Type: application/json

{ "path": "<absolute path>" }
```

Success:

```json
{ "path": "<created absolute path>" }
```

Structured API coverage lives in `tests/e2e/project-detect-browse.spec.ts` and
validates success, invalid input, existing directory, existing file, and
missing-parent failures.

## Implementation map

| Concern | Location |
|---|---|
| Path-step state, status-slot rendering, create orchestration | `src/app/dialogs.ts::showProjectDialog` |
| Browse modal composition | `src/app/dialogs.ts::openProjectBrowseDialog` |
| Client API helper | `src/app/api.ts::createDirectory` |
| Server create endpoint | `src/server/server.ts` handler for `POST /api/create-directory` |
| Picker completed-path and typeahead gating | `src/ui/components/DirectoryPicker.ts` |

## Test references

- `tests/e2e/ui/add-project-flow.spec.ts`
  - exact extended hint copy;
  - centered inline `Directory doesn't exist` + `Create Directory` in `add-project-status-slot`;
  - no `Create Directory` button in `add-project-footer`;
  - happy-path creation, detection refresh, preflight refresh, and scaffolding handoff;
  - recoverable `already_exists` refresh;
  - inline structured and routed server errors that keep the dialog open.
- `tests/e2e/ui/add-project-typeahead.spec.ts`
  - prefix suggestions;
  - completed-path suppression after suggestion selection;
  - no suggestion reopen after successful creation;
  - trailing-separator child suggestions after creation;
  - blur invalidation and Escape behavior.
- `tests/e2e/ui/add-project-browse-modal.spec.ts`
  - Browse/Select current writes a completed path and does not open child suggestions.
- `tests/e2e/project-detect-browse.spec.ts`
  - `POST /api/create-directory` response shape and structured error codes;
  - `GET /api/browse-directory` prefix/limit behavior used by typeahead.
- `tests/e2e/ui/add-project-footer-stability.spec.ts`
  - footer bounding-box stability across Add Project path-step transitions.

## Related docs

- [Project onboarding UX](project-onboarding-ux.md) — broader Add Project architecture and assistant handoff.
- [Add Project pre-flight & archive](../add-project-preflight.md) — preflight checks and archive flow.
- [REST API](../rest-api.md#add-project-directory-helpers) — directory browse/create endpoint details.
