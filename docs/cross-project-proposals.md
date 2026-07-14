# Cross-project proposals

Every `propose_*` tool accepts an optional `projectId`, but there are two
contracts:

- For `propose_goal`, `propose_role`, `propose_tool`, and `propose_staff`, an
  omitted or blank `projectId` defaults to the session's project. An explicit id
  targets that registered project, whether it is the source project or another
  one.
- For `propose_project`, `fields.projectId` is the create-versus-existing
  discriminator. Omitted or blank means **create a new project**; a non-empty id
  means **target that registered or provisional project**. The source session's
  project is never a fallback target.

The canonical cross-project use case is a **Headquarters** agent (server/global
scope) proposing goals, staff, roles, tools, or project-config edits into real
projects, without needing a session inside each project. But the mechanism is
general: any session may cross-target any registered project. There is **no
permission gating** — if instructed, any agent may propose across projects.

- Original design rationale: [design/cross-project-proposals.md](design/cross-project-proposals.md).
- Proposal lifecycle and the draft-file-as-source-of-truth model: [design/editable-proposals.md](design/editable-proposals.md).
- Headquarters / server scope and the `system` vs `headquarters` distinction: [headquarters.md](headquarters.md).

## Why this exists

Coordination work naturally originates outside the project it affects. A
Headquarters operator triaging across the whole server, or an agent that has
just finished analysing project A and wants to file follow-up work in project B,
should not have to spawn a session inside the target project just to emit a
proposal. Before this feature the seed endpoint hard-rejected any goal/staff
proposal whose `projectId` differed from the session's (`PROJECT_ID_MISMATCH`,
422) and force-overwrote it back to the session's project — so cross-project
proposals were impossible even though the accept side already read
`fields.projectId`.

For goal, role, tool, and staff proposals, the design keeps the default path
unchanged while making `proposal.fields.projectId` the accepted target. Project
proposals intentionally differ: only their own `fields.projectId` determines
create-versus-existing intent, so accepting a draft from Headquarters cannot
accidentally turn an omitted-id create into a protected Headquarters mutation.

## The five proposal types

Cross-project targeting applies to all five `propose_*` tools:

| Tool | Target semantics |
|---|---|
| `propose_goal` | Goal created under the target project's worktree/branch and validated against the target's workflows. |
| `propose_role` | Role config written to the target project's config store. |
| `propose_tool` | Tool config written to the target project's config store. |
| `propose_staff` | Staff agent created in the target project. |
| `propose_project` | Creates a new project, or targets an existing registered/provisional project (see [propose_project](#propose_project-edit-vs-create)). |

## Target resolution and validation (at seed time)

Resolution happens in the seed endpoint
(`POST /api/sessions/:id/proposal/:type/seed`), so it is identical whether the
proposal arrives via the tool or a direct API call. For the four project-scoped
types (`goal`, `role`, `tool`, `staff`):

1. **Explicit `projectId` wins.** A trimmed, non-empty `projectId` in the tool
   args is used as the target.
2. **Otherwise the session's project is the default.** A session in the hidden
   `system` scope maps to `headquarters` (matching the tool-side
   `argsWithProjectId` normalisation, so tool-mediated and direct-seed paths
   agree).
3. **The resolved target must be registered.** If it names no registered
   project, the seed is rejected with `422 UNKNOWN_PROJECT`. Because every
   resolvable *default* (a real project, or always-registered `headquarters`) is
   registered, this check is a no-op on the default path and only bites a
   caller-supplied unknown id.
4. **Hidden/synthetic projects are not valid explicit targets.** An explicit
   `projectId` naming a hidden project — notably the internal `system` anchor —
   is rejected with `422 UNKNOWN_PROJECT`. Callers must target `headquarters`,
   not `system`. The `system → headquarters` mapping applies to the *omitted
   default* only; it never silently rewrites an explicit target.
5. **The resolved target is stamped** onto the draft as `fields.projectId`,
   making it the single source of truth for the accept path.

Why validate the *resolved* target uniformly rather than trying to distinguish
"user typed it" from "tool injected it"? Because that distinction is invisible
to the server and differs across call paths. Validating the resolved value is
deterministic regardless of how the request was constructed, and stays a no-op
for the default path.

### Goal workflow validation uses the target

For `propose_goal`, the workflow named in the spec is validated against the
**target** project's registered workflows (with the inline-workflow fallback),
not the session's. A goal targeting project X must reference a workflow X
actually has; a workflow that only exists in the proposer's project will be
rejected. This prevents seeding a draft that can never be accepted in its target.
`parentGoalId` auto-injection for team-lead sessions and the inline-workflow
contract are unchanged.

### `propose_project`: edit vs create

`propose_project` is deliberately **excluded** from the seed-time target
resolver. The tool layer does not auto-inject a source project id, and the seed
endpoint leaves its fields untouched. `projectId` is not applied as project
configuration; it only expresses acceptance intent. Seeding or editing the
proposal never registers a project; registration begins only after the user
selects **Accept**.

At acceptance, the dispatcher trims and classifies the current
`fields.projectId` without consulting the stored panel mode:

| `fields.projectId` | Classification | Acceptance behaviour |
|---|---|---|
| absent, blank, or whitespace-only | Create | A normal-session proposal registers a distinct project from `name` + `root_path`; both are required. The source project is unchanged. |
| explicit id of a registered project | Existing registered target | Rename/config mutations address that project. `root_path` is not required and cannot select a different target. |
| explicit id of a provisional project | Existing provisional target | Promotion and config writes address that provisional project. |
| explicit unknown id | Invalid | Reject with `UNKNOWN_PROJECT`, issue no project mutation, and retain the editable draft. It never becomes create intent. |

This classification has no fallback to `proposal.projectId`,
`sourceProjectId`, the proposing session's `projectId`, or a previously stored
mode. `sourceProjectId` and session metadata record provenance only. A
`createdProjectId` may be retained as a retry checkpoint after registration so
a failed config write does not register the project twice; it also does not
change intent.

The provisional **Add Project** / project-assistant flow is an implementation
strategy applied only after create intent has been established. If the source
is a project-assistant session backed by a provisional project, acceptance may
promote that provisional project in place, write its config, remove the
assistant session, and refresh the project list. Source provenance is consulted
to choose this create implementation, never to reclassify the proposal as an
edit.

Responsibility is split deliberately:

- The proposal-panel accept dispatcher classifies create, existing, or invalid
  solely from current `fields.projectId`, then chooses registration, edit, or
  promotion.
- The id-addressed server mutation routes (`PUT /api/projects/:id`,
  `PUT /api/projects/:id/config`, and `POST /api/projects/:id/promote`) validate
  the dispatched id. An unknown mutation target returns `422 UNKNOWN_PROJECT`
  as defense in depth; these routes do not infer create intent.

Acceptance errors remain visible in the panel and do not clear the proposal.
If registration succeeds but the subsequent config write fails, the draft and
registration checkpoint remain available for a safe retry.

## Acceptance routes to the target

For goal, role, tool, and staff, acceptance applies the entity to the project
identified by the draft's `fields.projectId`. Project acceptance instead uses
the create-versus-existing classification above:

- **Goal** — created under the target project's worktree/branch and workflow.
- **Role / tool / staff** — written to the target project's config store /
  created in the target project.
- **Project** — config applied to the target (edit) or a new project registered
  (create).

For goal, role, tool, and staff, the UI target helpers prefer the draft's
`fields.projectId` and fall back to the session only when it is absent. Project
acceptance uses the separate classifier above and never falls back to the
session or proposal provenance.

## The "Proposing into &lt;Target Project&gt;" banner

When the resolved target project differs from the proposer's session project,
each of the five proposal panels shows a prominent banner —
**"Proposing into &lt;Target Project&gt;"** — tinted with the target project's
accent colour. This makes an unusual, easy-to-miss action unmissable before the
user accepts it.

- The banner shows the human-readable target **name** resolved from the
  registry, not the raw id.
- It appears for all five proposal types.
- For `propose_project`, the banner appears **only** for an explicit existing
  target that differs from the source, whether that target is registered or
  provisional. A create proposal has no registry target and gets no banner.
- When target == proposer (the common case), the helper returns nothing and the
  panel renders exactly as today, with no extra chrome.

The proposer's `system` scope normalises to `headquarters` for this comparison,
so an HQ session proposing into `headquarters` itself is treated as same-project
(no banner).

## The advisory tool nudge

The `projectId` parameter on all five tools carries this description:

> Defaults to this session. Set only for an explicit cross-project proposal.

This is an **advisory nudge only** — it steers agents away from setting
`projectId` unless the user is genuinely asking for a cross-project proposal.
It is not a boundary: correctness never depends on the agent honouring it, and
there is no permission check. For goal, role, tool, and staff, the target is
resolved and validated at seed time. For project proposals, despite the generic
wording, omission means create rather than "this session"; acceptance applies
the classifier above. The wording is kept within the per-parameter description
budget pinned by `tests2/core/tool-description-budget.test.ts`.

## Omitted-id guarantees

For goal, role, tool, and staff, omission preserves the normal same-project
path: the tool and seed endpoint resolve the session project (mapping `system →
headquarters`), stamp it onto the draft, and render no cross-project banner.

For project proposals, omission or blank input has the opposite and equally
strict meaning: create. It remains create regardless of whether the source
session belongs to Headquarters, a normal registered project, or a provisional
project. Only the post-classification Add Project strategy may use source
provenance to promote an already-created provisional project.
