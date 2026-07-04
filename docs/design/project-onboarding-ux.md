# Project onboarding UX — decision record

Status: shipped. V2 Add Project dialog is the default; legacy in-dialog browser
removed.

Tracked in goal `goal/project-onboar-c34ea1c5` (Tasks A–D shipped, this doc =
Task E).

Companion artefacts:

- Reusable picker: [`src/ui/components/DirectoryPicker.ts`](../../src/ui/components/DirectoryPicker.ts)
- Add Project dialog: [`src/app/dialogs.ts::showProjectDialog`](../../src/app/dialogs.ts)
- Auto-prompt formatter: [`src/app/project-assistant-autoprompt.ts`](../../src/app/project-assistant-autoprompt.ts)
- Server-side first-turn contract: [`src/server/agent/project-assistant.ts`](../../src/server/agent/project-assistant.ts)
- Pinning tests: [`tests/project-assistant-autoprompt.test.ts`](../../tests/project-assistant-autoprompt.test.ts), [`tests/e2e/ui/add-project-*.spec.ts`](../../tests/e2e/ui/)

This document records the **decisions** that survived implementation — not a
spec, not an implementation rehash. Read the linked source for "how"; read this
for "why".

## Background

The previous attempt (`goal/project-on-d860d29e`, never merged) built a static
story fixture for an interaction model the user could look at but not actually
use. The user found this unsatisfying — the experience was a mockup, not a
prototype against real APIs. This re-attempt deliberately started fresh on
`master` and built a **functional prototype wired into the live app**,
iterating on the running thing rather than on a 400-line design doc.

## Decisions

### D1. Prototype-first, design doc last

The previous attempt produced a long design doc and an interactive story
backed by mocked API boundaries; the user wanted to *drive* the flow against
real endpoints. This time the order was: build a working V2 dialog behind the
existing UI entry points → ship it as default → write a short decision record
(this doc). No upfront framing doc, no story fixture, no developer toggle —
the existing E2E suite is the safety net for "still works after promotion".

**Why:** Design docs solidify too early. Most of the interesting choices below
(browse-modal vs. inline, single-payload handoff, fallback `repo:.` item)
became obvious only once a real user could click through real preflight and
real scan output. Capturing them after the fact keeps the doc honest.

### D2. `DirectoryPicker` is a reusable light-DOM primitive

A new `<directory-picker>` Lit element owns the typeahead input, suggestion
list, keyboard navigation, and debounce. It does **not** import
`gatewayFetch`, does **not** open a browse modal, and does **not** run
detection/preflight. The caller injects a `browseDirectory` callback and
listens for path events.

Reasoning:

- **Light DOM** (`createRenderRoot() { return this }`) keeps Tailwind tokens
  and app CSS applicable. A shadow-bound variant would have forced a styling
  fork.
- **No API import** keeps the component testable in isolation and reusable
  for future surfaces (settings picker, goal-cwd field) without dragging the
  gateway client along.
- **Browse is an event, not a child component.** The picker emits
  `directory-browse-request`; the Add Project dialog composes the dedicated
  browse modal on top of itself. Future surfaces can provide an inline panel,
  a sheet, or no browse affordance at all without forking the input/suggestion
  logic.

Event surface (stable): `directory-input`, `directory-select`,
`directory-commit`, `directory-browse-request`, `directory-cancel`.
The public `setCompletedPath(path)` method lets parent flows commit a chosen
folder without triggering typeahead.

### D3. Browse is a dedicated modal, not an in-dialog list

The legacy dialog showed browse results in a `max-h-[200px]` panel beneath
the input. This was cramped, made the footer move, and on small viewports
left no room to actually browse.

The V2 dialog opens `openProjectBrowseDialog()` as a separate modal **on top
of** the Add Project dialog when the user clicks Browse. The parent dialog
stays mounted with its footer in place; the modal owns its own breadcrumb,
scrollable list, Up affordance, and Select-current button.

**Why a modal beats inline:** the original "near the input" intuition is
satisfied by the typeahead suggestion list; full directory browsing wants
significantly more vertical space and stable controls. Trying to do both in
one pane led directly to the footer-instability bug class.

### D4. Footer position is invariant — pinned by test

The V2 dialog has a fixed shell (`min(720px, 94vw)` × `min(720px, 92vh)`) with
sticky header, scrollable body, and a persistent footer container that is
identical across every state — empty input, typed path, preflight loading,
preflight pass/warn/fail, browse modal open, suggestions open, scan checklist,
error row, archiving.

Status-line and preflight regions are **reserved slots** (`min-h-[20px]`,
internal `overflow-y-auto`), not content-sized panes. Suggestions are
absolutely positioned by `DirectoryPicker` so they overlay rather than push.

This is pinned by [`add-project-footer-stability.spec.ts`](../../tests/e2e/ui/add-project-footer-stability.spec.ts),
which captures the footer bounding box before and after every transition and
fails with the offending state + pixel delta. Any future content addition
that wants to live in the body must use one of the existing reserved slots
or reserve its own.

### D5. Wording: "repo/subdirectory", not "component"

The scan checklist uses "repo/subdirectory candidates" everywhere
(header, count, body copy, assistant handoff). "Component" is reserved for
the registered `propose_project.components[]` shape.

The distinction matters: at scan time the user has not yet decided which
candidates become components. Calling them components in the UI made early
testers assume their selection was irrevocable. The current wording makes
clear that unselected entries are *excluded from the initial proposal* but
can be added back later by the assistant.

### D6. Subset handoff = auto-prompt block + fenced JSON, not a server field

The user-confirmed scan subset reaches the project assistant via the existing
client-built auto-prompt sent on session creation. The prompt contains both:

1. An English bullet summary (Selected N of M, Not selected, instructions).
2. A fenced ```` ```json ```` block carrying the full
   `{ rootPath, items, selectedIds }` payload verbatim.

The server's project-assistant first-turn instructions
([`project-assistant.ts`](../../src/server/agent/project-assistant.ts) under
"User-confirmed initial repo/subdirectory selection") teach the model to
treat `selectedIds` as authoritative for the **first**
`propose_project.components` call, map each item's `repo` / `relativePath` /
`detectedCommands` verbatim, and mention excluded entries in chat.

**Why client-side prompt, not server session field:**

- Zero `/api/sessions` contract change — the existing `initialPrompt` path
  already carries arbitrary text, and the assistant runtime already replays
  it on reconnect.
- Two consumers (the English summary and the JSON) share **one** payload,
  removing the format-drift class of bugs.
- Pinned at two levels: [`tests/project-assistant-autoprompt.test.ts`](../../tests/project-assistant-autoprompt.test.ts)
  golden-output checks the formatter; [`add-project-multi-repo-subset.spec.ts`](../../tests/e2e/ui/add-project-multi-repo-subset.spec.ts)
  asserts the WebSocket frame the live dialog sends.

If a future use case needs the subset to survive a failed first WebSocket
connection, promote it to a real session field then. Today it does not.

### D7. One normalized `ProjectScanItem[]` + a `Set<id>` for selection

The dialog and the auto-prompt formatter share a single shape
([`ProjectScanItem`](../../src/app/project-assistant-autoprompt.ts)) built
once from the `/api/projects/scan` response. Selection state is a
`Set<string>` of `item.id` values, never a separate authoritative
`selected/unselected/allRepos/monorepo` payload.

`item.id` is `repo:<folder>` for multi-repo entries and
`workspace:<relativePath>` for monorepo workspaces, giving a stable string
key that survives JSON round-tripping into the assistant prompt without
collisions.

**Fallback `repo:.`:** when both `repos` and `monorepo.candidates` come back
empty, the dialog synthesizes a single `repo:.` item labeled `(root)` so the
single-repo path still routes through the assistant with a non-empty
`selectedIds`. This removed a class of "scan came back empty" UI dead ends.

### D8. `scanProject` vs `scanProjectRepos`

`scanProject(dirPath): Promise<{ repos, monorepo }>` was added to
[`src/app/api.ts`](../../src/app/api.ts) to expose the monorepo block the
V2 dialog needs. The legacy `scanProjectRepos()` is preserved as a
compatibility wrapper that drops `monorepo` and returns `repos[]`, so
existing call sites (settings rescan, post-archive flow) continue to
compile and behave identically.

### D9. Escape key layering: suggestions → browse → dialog

Escape closes the topmost layer only:

1. Open suggestions → Escape closes suggestions, focus stays in the input.
2. Browse modal open → Escape closes the modal, focus returns to the picker
   input.
3. Neither open → Escape closes the Add Project dialog.

This was the most-cited usability fix from Task D part 2 review. Each layer
owns its own `keydown` capture with a clean teardown so closing a child
layer never bubbles into closing the parent.

### D10. Sidebar `ProjectPickerPopover` was deliberately untouched

The legacy `ProjectPickerPopover` is the **project switcher** (jump between
already-registered projects from the sidebar), not the Add Project flow.
It stays as-is — fast, keyboard-driven, folder-only. The "delete legacy
dialog code" acceptance bullet referred to the in-dialog browser inside
`showProjectDialog`, which was replaced wholesale, not to the switcher.

See the comment block at the top of
[`src/ui/components/ProjectPickerPopover.ts`](../../src/ui/components/ProjectPickerPopover.ts)
for the boundary.

### D11. Directory suggestions are intent-gated

Typeahead no longer treats an existing value as an implicit request to browse
inside that folder. The picker derives an intent from the focused input:

- empty focused input → recent paths;
- typed prefix such as `/tmp/al` → browse `/tmp` with prefix `al`;
- trailing separator such as `/tmp/alpha/` → browse `/tmp/alpha` children;
- blurred input or exact completed path → no suggestions.

`setCompletedPath(path)` is used for suggestion picks, browse-modal selection,
Select current, and parent-driven value restoration. It clears suggestions,
cancels debounce, invalidates in-flight lookups, and records the exact path as
a completed value so focus restoration cannot reopen child suggestions.

Before applying async browse results, the picker re-checks the browse token,
focus state, current value, and lookup intent. This prevents stale responses
from reopening the popover after blur, selection, or continued typing.

**Why:** Selecting a folder and immediately seeing its children felt like an
unwanted drill-down. The trailing separator keeps child browsing available, but
makes the user's intent explicit.

The server-backed `GET /api/browse-directory` path now accepts `prefix` and
`limit` so the picker can ask the server for only the matching first page.
Filtering before statting entries keeps large directories responsive while the
client still defensively filters the returned names.

### D12. Directory creation stays inside Add Project

The empty path hint reads exactly: `Type a path or click Browse to pick a directory, or type a path of a new directory to create it`.

When detection says the typed path does not exist, `add-project-status-slot`
shows a centered neutral validation state with `Directory doesn't exist` and a
directly adjacent **Create Directory** button. The action is deliberately not
rendered in the footer; the footer remains limited to **Cancel** and
**Continue**.

Successful creation keeps the dialog mounted, sets the canonical created path
via `setCompletedPath()`, refreshes detection and preflight, and leaves
**Continue** on the normal scaffolding path. Because the created path is marked
completed, typeahead does not automatically reopen child suggestions; users can
still request children by typing a trailing separator or editing the path.

Failures remain inline in the same status slot and keep the dialog open. The API
returns structured `code` values so the UI can show stable messages for invalid
paths, missing parents, file-at-target conflicts, permission errors,
already-existing directories, and unexpected create failures. An
`already_exists` response is recoverable: the UI refreshes detection/preflight
and lets the user continue if the directory is usable.

**Why:** The scaffolding assistant already handled empty directories, but users
had to create the target folder outside Bobbit first. Keeping creation in the
same modal removes that round trip. Moving the action into the status slot makes
creation discoverable where users scan validation results, without destabilizing
the footer or autocomplete overlay.

See [Add Project inline directory creation UX](add-project-inline-create.md) for
the shipped behavior and test references.

## Where it lives

| Concern | File |
|---|---|
| Reusable picker primitive | `src/ui/components/DirectoryPicker.ts` |
| Dialog orchestration + browse modal | `src/app/dialogs.ts::showProjectDialog`, `openProjectBrowseDialog` |
| Add Project API helpers | `src/app/api.ts::browseDirectory`, `createDirectory`, `scanProject` (+ `scanProjectRepos` shim) |
| Add Project REST endpoints | `src/server/server.ts` handlers for browse, create, detect, scan, and preflight |
| Auto-prompt formatter + types | `src/app/project-assistant-autoprompt.ts` |
| Session wiring | `src/app/session-manager.ts::connectToSession` (`projectInitialScanContext` option) |
| Assistant first-turn contract | `src/server/agent/project-assistant.ts` (First message → User-confirmed initial selection) |

## Verification

Pinning tests (run on every check-in):

- `tests/project-assistant-autoprompt.test.ts` — formatter golden output,
  selected/unselected ordering, scaffolding/edit/new modes.
- `tests/e2e/ui/add-project-typeahead.spec.ts` — prefix suggestions,
  completed-path suppression, explicit trailing-separator child suggestions,
  keyboard behavior, Windows drive-root lookup, and blur invalidation.
- `tests/e2e/ui/add-project-browse-modal.spec.ts` — modal open/close, select
  current, focus return, and no child suggestions after browse selection.
- `tests/e2e/ui/add-project-footer-stability.spec.ts` — bounding-box
  invariant across all state transitions.
- `tests/e2e/ui/add-project-multi-repo-subset.spec.ts` — WebSocket frame
  contains the derived bullet summary + JSON payload.
- `tests/e2e/ui/add-project-select-all.spec.ts` — select/deselect-all,
  Continue disabled when count = 0.
- `tests/e2e/ui/add-project-flow.spec.ts` — typed directory creation happy
  path, scaffolding handoff, reload cleanup, recoverable `already_exists`, and
  structured create-error rendering.
- `tests/e2e/project-detect-browse.spec.ts` — create-directory API success and
  structured error codes; browse-directory prefix/limit/truncation behavior.
- Preserved: `add-project-preflight.spec.ts`, `add-project-post-archive.spec.ts`,
  and `add-project-symlink.spec.ts`.

If a future change to the auto-prompt format is required, update the
formatter, the server-side instructions in `project-assistant.ts`, **and**
both pinning tests in the same commit.

## Non-goals (kept out, on purpose)

- **Recursive directory creation.** `POST /api/create-directory` creates only
  the final path segment. Missing parents are a user-visible error so Bobbit
  does not silently create an unexpected directory tree.
- **Shadow-DOM variant of the picker.** Light DOM was a deliberate choice
  (see D2); a shadow variant would fork the styling story.
- **Persisting the subset across a failed first WebSocket.** See D6 — add a
  real `initialPrompt` server field if and only if a concrete user-visible
  failure demands it.
- **Refactor of detect / preflight / scan server logic.** Only the
  `scanProject` client helper was added; server endpoints are unchanged.
