# Project-proposal saved state after Apply Changes

## Problem

When a user clicks **Apply Changes** on a project-assistant proposal in an
already-registered project (the registered branch of the project proposal accept
flow), the proposal is cleared from `state.activeProposals.project` but the
assistant session keeps running. The project proposal panel previously fell back
to its empty-state branch and rendered `"Waiting for project analysis…"`, which
read as "nothing happened" — users were left wondering whether their changes had
taken effect and whether they needed to do anything else with the still-running
assistant.

The provisional path is different because it promotes the provisional project,
writes config, terminates the assistant session, and navigates to landing on a
successful accept.

## Solution

After a successful registered project proposal accept, we set a per-session flag
that swaps the empty-state branch for a confirmation view:

- **Heading**: "Changes Saved"
- **Body**: "Your project configuration has been updated."
- **Action**: a "Terminate Project Assistant" button that opens a confirmation
  dialog and, on confirm, tears the assistant session down via the same code path
  as the provisional accept.

A subsequent `<project_proposal>` from the assistant clears the flag and the
panel reverts to rendering the new proposal — the saved-state view never
co-exists with an active proposal.

## State

`src/app/state.ts`:

```ts
projectProposalAcceptedBySessionId: {} as Record<string, boolean>
```

A per-session boolean rather than a single global flag because multiple
assistant sessions can be open at once (the user can navigate between them) and
each must remember its own accepted/not-accepted state independently.

### Set

The registered accept handler in `src/app/proposal-panels.ts` sets
`state.projectProposalAcceptedBySessionId[propSessionId] = true` after the
config + rename PUTs succeed, then calls `saveProjectDraft(sessionId)` so the
flag is persisted to the on-disk project draft. Without that explicit save, a
reload would lose the marker because the panel relies on the draft restore path
to rehydrate state.

### Cleared

The flag is cleared symmetrically wherever the proposal slot itself is cleared:

| Site | Reason |
|---|---|
| Unified `onProposal` callback (`type === "project"` branch) in `connectToSession()` | A new `<project_proposal>` arrived; replace the saved view with the new proposal |
| `selectSession()` (when navigating away from a session that owned the proposal) | Same lifecycle as `activeProposals.project` cleanup |
| Draft-restore in `connectToSession()` when the active project proposal belongs to a different session | Same lifecycle as `activeProposals.project` cleanup |
| `terminateSession()` | Session is gone — drop its UI state |
| `terminateProjectAssistantSessionFromPanel()` | Explicit teardown via the new button |
| `backToSessions()` | Same lifecycle as `activeProposals.project` cleanup |

### Persistence (reload survival)

`projectDraft` in `session-manager.ts` round-trips the flag via its `serialize`
and `restore` callbacks:

```ts
serialize: (sessionId, _state) => ({
  …,
  accepted: state.projectProposalAcceptedBySessionId[sessionId] ?? false,
}),
restore: (sessionId, draft) => {
  …
  if (draft.accepted === true) {
    state.projectProposalAcceptedBySessionId[sessionId] = true;
  } else {
    delete state.projectProposalAcceptedBySessionId[sessionId];
  }
},
```

After Apply Changes, the registered accept handler calls
`saveProjectDraft(propSessionId)` (instead of deleting the project draft) so the
next reload re-hydrates the flag.

## Failure and pending contract

The accept handler is panel-owned so the button can reflect request state
immediately. While Accept Project / Apply Changes is in flight, the primary
button is disabled and its label changes to `Accepting…` or `Applying…`; this
prevents duplicate promote, rename, or config writes.

Accept is all-or-stay-open:

- Missing proposal or missing project linkage surfaces a `showConnectionError`
  message instead of returning silently.
- Promote, rename, and config-write failures surface `showConnectionError`, leave
  `state.activeProposals.project` intact, and keep the panel actionable.
- Success is the only path that clears the proposal, closes the project proposal
  tab, deletes the proposal file, and refreshes projects.

This matters because a silent no-op is indistinguishable from a slow or failed
configuration write. The project proposal panel must always give visible
feedback and preserve the draft on failure so the user can retry or edit.

## Termination helper

`terminateProjectAssistantSessionFromPanel(sessionId)` in
`src/app/proposal-panels.ts` is the panel path that tears down a project-assistant
session after a successful provisional accept. It is used by:

1. **Provisional accept path** — the provisional accept handler calls it silently
   after project promotion and config write succeed.
2. **Registered Terminate button** — `projectProposalPanel()` calls the shared
   session termination path after the user confirms the dialog.

Steps:

1. `uncacheSession(sessionId)`
2. If the session is currently active, `state.remoteAgent?.disconnect()` and
   null it out
3. `DELETE /api/sessions/:id` (404 is treated as already-gone, not an error)
4. Optimistically remove the session from `state.gatewaySessions` so the sidebar
   updates immediately rather than waiting for the next `refreshSessions()`
5. `deleteGoalDraft` / `deleteRoleDraft` / `deleteProjectDraft`
6. Drop the saved-state flag for this session
7. `refreshSessions()` and `setHashRoute("landing")`

The previous inline provisional teardown was extracted to this helper; behavior
is unchanged on the provisional path.

## Render path

`projectProposalPanel()` in `src/app/proposal-panels.ts` checks the flag in its
no-proposal branch:

```
if (!proposal) {
  if (accepted && sessId) {
    return <Changes Saved view with Terminate button>
  }
  return <Waiting for project analysis… view>
}
```

When the flag is set but a proposal arrives, the new proposal wins because the
unified `onProposal` callback clears the flag *before* the next render. The
panel's `data-state="accepted"` attribute and
`data-testid="project-changes-saved-heading"` make the saved-state view
addressable from E2E tests.

## Tests

`tests/e2e/ui/project-assistant-saved-state.spec.ts` covers:

1. Apply Changes → "Changes Saved" view appears with Terminate button
2. Reload preserves the saved state (proves draft persistence works)
3. A new `<project_proposal>` replaces the saved view with the new proposal
4. Terminate → confirm → session is gone and the user lands on the dashboard

`tests2/browser/journeys/project-proposal-accept.journey.spec.ts` covers the
no-op regression directly:

1. Registered Apply Changes shows pending feedback and suppresses duplicate
   rename requests while in flight
2. Registered rename failure shows an error and leaves the proposal actionable
3. Provisional config failure shows an error and keeps the proposal draft
4. Registered success clears and closes the proposal panel
