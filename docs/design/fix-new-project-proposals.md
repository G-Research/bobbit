# Fix new-project proposal acceptance

## Status and scope

This document is the implementation plan for the acceptance bug left by the
cross-project proposal work. It covers project proposals only. The other four
proposal types continue to default an omitted `projectId` to their source
session's project.

The authoritative intent signal for a `propose_project` draft is
`proposal.fields.projectId`:

- absent or blank means **create a new project**;
- present and naming an existing project means **target that project**;
- present and unknown means **reject with `UNKNOWN_PROJECT`**.

Neither the proposal slot's provenance metadata nor the source session's
`projectId` may change that classification. Source metadata is consulted only
after a create has been classified, to preserve the provisional Add Project
implementation strategy.

## Current behavior and root cause

### Seed path is already correct

`POST /api/sessions/:id/proposal/:type/seed` in `src/server/server.ts` deliberately
excludes `proposalType === "project"` from the goal/role/tool/staff target
resolver. Consequently a project draft emitted without `projectId` remains
without `fields.projectId`. `src/server/proposals/proposal-types.ts` also
correctly requires `root_path` only when `projectIdPresent(fields)` is false.
These behaviors must remain.

### Client acceptance conflates intent and source context

The failure is the interaction of three client behaviors:

1. `resolveProjectMode(sessionId, fields)` in `src/app/session-manager.ts`
   resolves an absent `fields.projectId` from the source session's project. A
   normal session and a Headquarters session therefore become `"registered"`.
2. The unified `onProposal` callback stores the source project in
   `ProposalSlot.projectId`. Despite its current comment, this value is source
   provenance, not necessarily the proposal target.
3. `projectIdForProjectProposal()` in `src/app/proposal-panels.ts` falls back
   from absent `fields.projectId` to `proposal.projectId`, then to the mutable
   session link. `acceptProjectProposalFromPanel()` therefore dispatches to
   `acceptRegisteredProjectProposalFromPanel()` and renames/configures the
   source project.

For Headquarters, the first mutation is `PUT /api/projects/headquarters`, which
correctly fails with `HEADQUARTERS_IMMUTABLE`. For an ordinary registered
project, the same bug can silently rename or reconfigure the source project.

The current tests expose the gap:

- `tests2/integration/cross-project-proposals.test.ts` proves that a create draft
  can be seeded, but does not accept it.
- `tests2/dom/resolve-project-mode.test.ts` currently codifies the wrong absent-id
  fallback to the source session.
- `tests2/dom/project-accept-dispatch.test.ts` covers explicit existing targets,
  but not absent-id direct creation.
- `tests2/browser/journeys/cross-project-proposal-banner.journey.spec.ts` checks
  explicit target mode/banner behavior, not a real absent-id accept.
- `tests2/browser/journeys/project-proposal-accept.journey.spec.ts` injects slots
  whose source project is also treated as the target; it does not seed and
  accept a new project from a normal or Headquarters session.

## Required semantic model

### Target resolution

Add a source-independent resolver, preferably in
`src/app/session-manager.ts` beside the existing exported
`resolveProjectMode` (or in a small `src/app/project-proposal-target.ts` module
if extraction makes the DOM tests cheaper):

```ts
export type ProjectProposalTarget =
  | { kind: "create" }
  | { kind: "existing"; projectId: string; provisional: boolean }
  | { kind: "unknown"; projectId: string };

export function resolveProjectProposalTarget(
  fields: Record<string, unknown> | undefined,
  projects = state.projects,
): ProjectProposalTarget;
```

Resolution is exactly:

1. Read and trim `fields.projectId`.
2. If it is absent/blank, return `{ kind: "create" }`. Stop; do not inspect the
   proposal slot or session.
3. If it is present, look it up in `state.projects`.
4. If absent from the registry, return `{ kind: "unknown", projectId }`. Never
   fall through to create or source-session behavior.
5. If found, return `{ kind: "existing", projectId, provisional }`.

Known provisional targets remain supported because PR #1005 already permits
an explicit existing provisional project to use the promote path. A normal
registered target uses the edit path.

`resolveProjectMode` should become a thin presentation/slot projection of this
resolver, with an expanded union:

```ts
type ProjectProposalMode =
  | "create"
  | "provisional"
  | "registered"
  | "invalid";
```

Map create to `"create"`, an existing provisional target to `"provisional"`,
an existing non-provisional target to `"registered"`, and unknown to
`"invalid"`. Remove `sessionId` from the resolver's decision. Update
`ProposalSlot` in `src/app/proposal-registry.ts`, the mirrored state shape in
`src/app/state.ts`, draft restoration in `src/app/session-manager.ts`, and the
panel's `data-mode`/button derivation accordingly. Both `"create"` and
`"provisional"` retain the **Accept Project** label; `"registered"` retains
**Apply Changes**. An invalid target remains visible but acceptance reports the
error.

The stored `mode` remains a render hint only. As today,
`acceptProjectProposalFromPanel()` must re-run target resolution against the
current fields at click time so a revised draft cannot dispatch through a stale
mode.

### Provenance is not targeting

Rename project-slot `projectId` to `sourceProjectId` in:

- `src/app/proposal-registry.ts::ProposalSlot`;
- `src/app/state.ts::activeProposals`;
- the unified `onProposal` slot construction in
  `src/app/session-manager.ts::connectToSession`;
- project draft serialize/restore in `src/app/session-manager.ts`;
- provisional-create selection in `src/app/proposal-panels.ts`.

Restore old drafts with `p.sourceProjectId ?? p.projectId` for one-way backward
compatibility, but serialize only `sourceProjectId`. The comment must say this
is the project that owned the source session when the slot was created. It is
not an acceptance target.

This rename is important: retaining a generically named `proposal.projectId`
invites the exact fallback this fix removes.

## Acceptance data flow

### Dispatcher

Rewrite `src/app/proposal-panels.ts::acceptProjectProposalFromPanel()` as an
exhaustive dispatch over `resolveProjectProposalTarget(proposal.fields)`:

| Resolution | Acceptance path |
|---|---|
| `create` + source is the matching provisional project-assistant project | Existing provisional promote path |
| `create` + any other source (ordinary project, Headquarters, goal/staff session, etc.) | New direct-register path |
| `existing` + `provisional: true` | Existing provisional promote path against the explicit id |
| `existing` + `provisional: false` | Existing registered edit path against the explicit id |
| `unknown` | Set panel error with code `UNKNOWN_PROJECT`; perform no mutation |

Pass the selected project id into the provisional/registered helpers. Do not let
either helper resolve or fall back again. Delete
`projectIdForProjectProposal()` or replace it with helpers whose names expose
their limited roles, such as `sourceProvisionalProjectIdForCreate()`.

### Preserving the Add Project / project-assistant flow

An absent id is always create intent, including the Add Project assistant. The
difference is only how that create is fulfilled.

`sourceProvisionalProjectIdForCreate(proposal)` may inspect source metadata only
after the dispatcher has obtained `kind: "create"`. It returns an id only when
all of these are true:

1. the source session is a project assistant (`assistantType === "project"` or
   `"project-scaffolding"`), using the session record rather than the currently
   selected UI assistant type;
2. `proposal.sourceProjectId` (falling back to the source session link only for
   legacy slots) resolves to a project in `state.projects`;
3. that project has `provisional === true`.

That id is passed to the current
`acceptProvisionalProjectProposalFromPanel(proposal, projectId)`, preserving its
sequence:

1. `POST /api/projects/:id/promote` with the proposed name;
2. `PUT /api/projects/:id/config` with `buildProjectConfigDiff(fields)`;
3. `fetchProjects()` / `setProjects()` and settings-cache invalidation;
4. clear the proposal and proposal file only after both mutations succeed;
5. terminate the project-assistant session, clear its drafts, refresh sessions,
   refresh the sidebar, and navigate to landing.

Promotion is idempotent in
`src/server/agent/project-registry.ts::ProjectRegistry.promote`, so a config
failure can safely leave the draft open and retry the sequence.

A regular session that happens to belong to a provisional project must not be
promoted merely because of its source link; the assistant-type and provisional
checks are both required.

### Direct registration for ordinary and Headquarters sessions

Add `acceptNewProjectProposalFromPanel(proposal)` in
`src/app/proposal-panels.ts`.

1. Validate trimmed `fields.name` and `fields.root_path` before issuing a
   request. Although the server-backed draft parser requires both for create,
   click-time validation protects edited/restored slots. A missing value sets a
   panel error and leaves the draft intact.
2. `POST /api/projects` with `{ name, rootPath }`. Do not send `upsert`, and do
   not include the source/session project id. Registration therefore cannot
   reinterpret an already-registered path as the new target.
3. Read the returned project id and write the proposal config with the existing
   `writeProjectProposalConfig(created.id, fields)`. This preserves scalar,
   component, workflow, config-directory, and sandbox-token handling through
   `buildProjectConfigDiff` and the authoritative
   `PUT /api/projects/:id/config` validation.
4. Refresh `state.projects` after registration and again on full success so the
   new project appears in the sidebar. Invalidate the new project's Settings
   cache.
5. On full success, clear/close/delete the proposal artifacts, notify the
   proposing session, and keep that ordinary or Headquarters session running.
   Do not call `terminateProjectAssistantSessionFromPanel()` and do not navigate
   away.

The two-request create needs an idempotent progress checkpoint. Add optional
`createdProjectId` to the project `ProposalSlot`/state mirror and project-draft
serialization. Immediately after a successful POST:

- store the returned id in the still-active slot;
- save the project draft;
- refresh projects before attempting the config PUT.

If config write fails, leave `fields` and the proposal file unchanged and show
an error explaining that registration succeeded but configuration still needs
to be retried. On retry, verify `createdProjectId` still exists and has the same
canonical/root path as `fields.root_path`; if so, skip POST and retry only the
config PUT. If the checkpoint project has disappeared, clear the checkpoint and
register again. If it exists at a different root, reject safely rather than
writing config to it. `createdProjectId` is acceptance-progress metadata; it
must never be copied into `fields.projectId` or used to reclassify create intent
as edit intent.

This checkpoint avoids both an unretryable "already registered" failure and
silent upsert into an unrelated project after a partial accept.

### Existing registered edit

Keep `acceptRegisteredProjectProposalFromPanel`, but change its signature to
receive the explicit, already-resolved `projectId`. It continues to:

1. rename with `PUT /api/projects/:id`;
2. apply `buildProjectConfigDiff(fields)` with
   `PUT /api/projects/:id/config`;
3. refresh projects/config caches;
4. clear/close/delete the proposal only on success;
5. keep the source session alive and notify it.

`root_path` remains optional for explicit edit drafts and is never used to
register or move the target. `projectId` remains routing metadata and is already
excluded by `buildProjectConfigDiff`.

### Explicit unknown target

Add a shared rejection helper in `src/app/proposal-panels.ts` that calls
`setProjectProposalAcceptError()` and `showConnectionError()` with:

- title: `Project proposal accept failed`;
- code: `UNKNOWN_PROJECT`;
- a message naming the unknown id and saying new-project proposals must omit
  `projectId`.

It returns `false` without a POST, PUT, promote, draft deletion, proposal close,
or state cleanup. The server's existing `422 UNKNOWN_PROJECT` guards on
`PUT /api/projects/:id`, `PUT /api/projects/:id/config`, and
`POST /api/projects/:id/promote` remain defense in depth for explicit-target
mutation calls.

The bare `POST /api/projects` endpoint cannot infer whether a caller previously
had an explicit proposal id. Therefore documentation and comments must not
claim that endpoint-level registry validation alone decides proposal intent.
Intent is selected from `fields.projectId` by the accept dispatcher; each chosen
server endpoint remains authoritative for that mutation.

## Error and state guarantees

Update `showProjectProposalResponseError()` in
`src/app/proposal-panels.ts` to prefer `details`, then `data.message`, then
`data.error`, then the fallback status. Current `UNKNOWN_PROJECT` responses use
`message`, which otherwise degrades to a generic status string. Preserve
`data.code` in `showConnectionError`.

All acceptance branches retain the current pending-state guard:
`_projectProposalAcceptPending` disables duplicate clicks and is reset in
`finally`.

Only complete success may:

- delete `state.activeProposals.project`;
- close `proposal:project`;
- delete the project draft or proposal file;
- set the registered-path saved-state marker;
- terminate a provisional assistant session.

Failures leave the editable fields and server-backed proposal file intact. A
partial direct create stores only the separate `createdProjectId` checkpoint;
it does not rewrite the proposal's semantic fields.

The Headquarters safety invariant follows structurally: an absent-id resolution
can only call `POST /api/projects`; the source id is not passed into rename,
config, or promote. A test must assert the absence of all
`/api/projects/headquarters` mutations, rather than merely asserting that the
visible error text changed.

## Server and documentation changes

### Server

No change is required to seed semantics in
`src/server/server.ts::POST /api/sessions/:id/proposal/:type/seed` or conditional
required fields in `src/server/proposals/proposal-types.ts`.

Keep the existing `UNKNOWN_PROJECT` guards on the three id-addressed project
mutation routes. Reword their comments so they describe endpoint defense in
depth, not the source of create-vs-edit classification. `POST /api/projects`
remains the accepted direct-create operation and is invoked only after the user
clicks Accept.

### Canonical documentation

Update `docs/cross-project-proposals.md` after implementation:

- project proposals are the exception to the general omitted-id default;
- absent `fields.projectId` always means create, independent of proposer;
- explicit known means target existing, explicit unknown means
  `UNKNOWN_PROJECT`;
- the accept dispatcher owns classification; id-addressed server endpoints own
  mutation validation;
- source/provenance metadata is never target fallback;
- provisional Add Project is an implementation strategy inside create intent.

Reconcile the same statements in comments for
`resolveProjectMode`, the unified slot construction,
`projectIdForProjectProposal`'s replacement, and `ProposalSlot`. Remove the
current `docs/cross-project-proposals.md` "default path byte-for-byte identical"
claim for `propose_project`; it is true for goal/role/tool/staff but is precisely
false for this bug.

## Test plan

All new tests belong in `tests2/` and must be registered in
`tests2/tests-map.json` through the normal inventory workflow.

### DOM/unit target and dispatch tests

Update `tests2/dom/resolve-project-mode.test.ts` (or replace it with a focused
`project-proposal-target.test.ts`) to pin the full matrix:

- absent id from a registered source resolves create;
- absent id from Headquarters resolves create;
- absent id from a provisional source still resolves create intent;
- explicit registered resolves registered;
- explicit provisional resolves provisional;
- explicit unknown resolves invalid/unknown and never falls back to either a
  registered or provisional source;
- blank id is treated as absent.

Extend `tests2/dom/project-accept-dispatch.test.ts` to click through the real
`acceptProjectProposalFromPanel()` and assert endpoint chains:

- ordinary registered source + absent id: `POST /api/projects`, then config PUT
  to the returned new id; no rename/config/promote against the source;
- Headquarters source + absent id: same create chain and zero requests whose
  path begins `/api/projects/headquarters`;
- explicit registered id: rename/config target that id and never POST create;
- explicit unknown id: no mutation requests, `UNKNOWN_PROJECT` panel error, and
  active proposal retained;
- Add Project assistant + absent id + provisional source: promote/config the
  provisional id, never POST a second project;
- explicit provisional target: preserve the existing promote case;
- a stale stored mode cannot override current-field resolution.

Also cover the direct-create `createdProjectId` retry: first POST succeeds,
config fails, proposal remains; second click performs no second POST and retries
config against the checkpoint id.

### Real integration/browser acceptance

Extend `tests2/integration/cross-project-proposals.test.ts` for seed contracts,
but do not count seed-only assertions as acceptance coverage. Add or extend a
browser journey (prefer
`tests2/browser/journeys/project-proposal-accept.journey.spec.ts`) that uses the
real seed endpoint, hydrates the real panel, clicks the real primary action, and
then queries the real API:

1. From a normal registered-project session, seed `{name, root_path}` with no
   `projectId`, accept it, assert a distinct project exists at the new root,
   assert the source project's name/root/config are unchanged, and clean up the
   created project/session/temp directory.
2. Repeat from a Headquarters session. Instrument network requests and assert
   no `PUT`/`POST` targets `/api/projects/headquarters`, while the distinct
   project is registered and appears after sidebar refresh.
3. Explicit registered `projectId` accepts through edit mode and changes only
   that target.
4. Explicit unknown `projectId` retains the proposal and surfaces
   `UNKNOWN_PROJECT`, with no create request.
5. Preserve the provisional project-assistant promotion journey: one project at
   the selected root, provisional flag cleared, proposed config persisted,
   assistant session removed, landing navigation completed, and sidebar
   refreshed.

Where browser cost is high, keep exact request-routing assertions in DOM tests
and reserve browser coverage for the two required user journeys plus the
provisional smoke. The acceptance tests must not inject a pre-classified slot as
their only setup; at least the ordinary and Headquarters cases must seed the
server-backed draft and activate the panel before clicking.

### Existing regression coverage to retain

Do not weaken:

- `tests2/core/project-proposal-diff.test.ts` (`projectId` is never config);
- pending/error/draft retention cases in
  `tests2/browser/journeys/project-proposal-accept.journey.spec.ts`;
- explicit cross-project banner journey;
- conditional `root_path` seed validation;
- provisional API promotion and project-assistant saved-state coverage.

## Verification commands

Run focused suites first, then project gates:

```bash
npx vitest run tests2/dom/resolve-project-mode.test.ts tests2/dom/project-accept-dispatch.test.ts
npx vitest run tests2/integration/cross-project-proposals.test.ts
npx playwright test tests2/browser/journeys/project-proposal-accept.journey.spec.ts
npm run check
npm run test:unit
npm run test:browser
npm run build
```

If the implementation adds or moves a browser test, use its registered v2 path
in the focused Playwright command and regenerate/reconcile `tests2/tests-map.json`
using the repository's testing-v2 inventory tooling rather than editing census
counts by hand.

## Non-goals

- Changing target semantics for goal, role, tool, or staff proposals.
- Auto-upserting an existing project at the proposed root.
- Stamping a newly-created id into `fields.projectId`.
- Terminating ordinary or Headquarters proposing sessions after creation.
- Removing support for explicit existing provisional targets.
