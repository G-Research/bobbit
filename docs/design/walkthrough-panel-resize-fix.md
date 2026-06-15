# PR Walkthrough panel-resize controls — historical design note

> **Superseded by the unified side-panel workspace.** PR walkthrough is now a
> normal `pack` side-panel tab, and every side-panel tab uses
> `sidePanelWorkspace.sizeMode` (`split`, `fullscreen`, `collapsed`) plus the
> shared side-panel shell. There is no walkthrough-specific resize state and no
> preview-specific fullscreen/collapse state in the current contract. See
> [Side-panel workspace](../side-panel-workspace.md) and
> [PR walkthrough pack deletion](./pr-walkthrough-pack-deletion.md).

## Current contract

The PR walkthrough panel gets fullscreen, split, collapse, restore, keyboard
shortcuts, and popout behavior because it is a normal pack panel in the shared
side-panel workspace:

- tab id shape: `pack:<packId>:<panelId>:<instanceKey>`;
- singleton instance key for the PR walkthrough panel;
- active tab, order, and size mode persisted on the session's server-backed
  `sidePanelWorkspace`;
- shared controls rendered by the generic side-panel shell;
- no PR-walkthrough-only fullscreen, auto-fullscreen, collapse, or resize path.

The standalone/deep-link surface renders the existing server workspace tab. It
must not reconstruct a pack panel from arbitrary route parameters or grant a
wider Host API scope than the session-backed tab already has.

## Historical context

This design note originally fixed dead resize controls by deleting
walkthrough-specific logic that overrode the then-shared preview-panel resize
state. That reasoning still matters: **delete special-casing instead of adding a
parallel PR walkthrough resize path**.

The old implementation details are no longer current:

- preview-specific fullscreen state was replaced by `sidePanelWorkspace.sizeMode`;
- preview-era per-session collapse keys are migration input only;
- the bespoke `walkthrough:<changeset-id>` tab kind and standalone
  `/walkthrough?...` route were removed;
- PR walkthrough now ships through the first-party pack route and opens a pack
  panel through `host.ui.openPanel`.

## Tests to keep current

Coverage should assert the shared workspace behavior, not a walkthrough-only
path:

- opening the PR walkthrough pack creates/focuses a pack tab;
- fullscreen, collapse, restore, and split controls work on that tab;
- keyboard shortcuts mutate the shared workspace size mode;
- popout/deep-link renders only the already-open server workspace tab;
- no auto-fullscreen or PR-specific resize state is introduced.
