# Cross-project proposals

Every `propose_*` tool accepts an optional `projectId`. When omitted, a proposal
targets the session's own project (the overwhelmingly common path, unchanged).
When supplied, the proposal is seeded, validated, and accepted against the
**target** project instead — so an agent in one project can propose work into a
*different* one.

The canonical use case is a **Headquarters** agent (server/global scope)
proposing goals, staff, roles, tools, or project-config edits into real
projects, without needing a session inside each project. But the mechanism is
general: any session may cross-target any registered project. There is **no
permission gating** — if instructed, any agent may propose across projects.

- Design rationale and the exact code-level contract: [design/cross-project-proposals.md](design/cross-project-proposals.md).
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

The design keeps the default path byte-for-byte identical (correctness must
never regress for the common case) while making `proposal.fields.projectId` the
single source of truth for where a proposal lands.

## The five proposal types

Cross-project targeting applies to all five `propose_*` tools:

| Tool | Target semantics |
|---|---|
| `propose_goal` | Goal created under the target project's worktree/branch and validated against the target's workflows. |
| `propose_role` | Role config written to the target project's config store. |
| `propose_tool` | Tool config written to the target project's config store. |
| `propose_staff` | Staff agent created in the target project. |
| `propose_project` | Edits an existing registered project's config, or creates a brand-new project (see [propose_project](#propose_project-edit-vs-create)). |

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
resolver, because it is the one type allowed to name a brand-new, not-yet-
registered project. Its `projectId` is never auto-injected by the tool layer
and is never persisted into the applied config; it only routes acceptance.
Its behaviour is decided at the accept/mutation boundary:

| `fields.projectId` | Meaning | Behaviour |
|---|---|---|
| absent | Create a brand-new project | Registered from `name` + `root_path` exactly as today (unchanged). `root_path` is required. |
| present + names a **registered** project | Edit that project | Proposed config applied to that project. `name` / `root_path` describe the existing project; they do not register a new one. `root_path` may be omitted. |
| present but **not registered** | Ambiguous intent | Rejected with `UNKNOWN_PROJECT` — never silently re-routed into a create. New projects must omit `projectId`. |

Enforcement lives at the server mutation boundary (the `PUT /api/projects/:id`,
`PUT /api/projects/:id/config`, and `POST /api/projects/:id/promote` routes), so
direct/non-UI callers get identical semantics. An explicit-but-unknown id fails
there with a clear `422 UNKNOWN_PROJECT` rather than a generic 404. The UI
preflights for a nicer message but never overrides the server's decision.

## Acceptance routes to the target

Accepting a cross-project draft creates or applies the entity in the target
project, keyed off the draft's `fields.projectId`:

- **Goal** — created under the target project's worktree/branch and workflow.
- **Role / tool / staff** — written to the target project's config store /
  created in the target project.
- **Project** — config applied to the target (edit) or a new project registered
  (create).

The UI read helpers (`resolveGoalProposalProjectId`, `proposalProjectId`, and
the staff/role/tool/project equivalents in `src/app/proposal-panels.ts`) all
prefer the draft's `fields.projectId` and fall back to the session only when it
is absent — so an explicit target is honoured on accept and never clobbered.

## The "Proposing into &lt;Target Project&gt;" banner

When the resolved target project differs from the proposer's session project,
each of the five proposal panels shows a prominent banner —
**"Proposing into &lt;Target Project&gt;"** — tinted with the target project's
accent colour. This makes an unusual, easy-to-miss action unmissable before the
user accepts it.

- The banner shows the human-readable target **name** resolved from the
  registry, not the raw id.
- It appears for all five proposal types.
- For `propose_project`, the banner appears **only** for an explicit edit of an
  already-registered project. A brand-new project proposal is not "cross-project"
  in the target-registry sense and gets no banner.
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
It is not a boundary: correctness never depends on the agent honouring it. The
server validates and routes based on the resolved target regardless of the
agent's intent, and there is no permission check. The wording is kept within the
per-parameter description budget pinned by
`tests2/core/tool-description-budget.test.ts`.

## Default-path guarantee

When `projectId` is omitted the behaviour is byte-for-byte identical to before
this feature: the tool stamps the session's project (mapping `system →
headquarters`), the seed endpoint stamps the same value, uniform target
validation is a no-op, and no banner renders. This is the overwhelmingly common
path and was preserved exactly by design.
