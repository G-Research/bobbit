# Component config map

Move QA-testing settings (and any future per-component skill-consumed configuration) off the top level of `project.yaml` and onto each component's opaque `config: Record<string, string>` map, parallel to the existing `commands` map.

## Why

The seven legacy top-level QA keys — `qa_start_command`, `qa_build_command`,
`qa_health_check`, `qa_browser_entry`, `qa_env`, `qa_max_duration_minutes`,
`qa_max_scenarios` — assumed a single QA testbed per project. That broke as
soon as multi-repo and monorepo projects became first-class:

- A monorepo can have several runnable services that each want independent
  QA testing.
- Multi-repo projects already host components that point at distinct repos.
  A project-level QA setting can't know which one to spin up.

The fix is to push the settings down to the component that owns the testbed,
just like `commands` is already a per-component flat map. The `agent-qa`
workflow step gains an optional `component:` field that selects which
component's `config:` map the `/qa-test` skill reads.

A second motivation is **opacity**. Server code never spread `qa_env` into a
child process — it was only ever inlined by the agent at author time when it
constructed the start command. Hosting QA settings in an opaque
`Record<string, string>` removes the privileged "QA settings" surface from
the server entirely. Server-side, only two things look at the map:

- `getQaMaxDurationMinutes(componentName): number` — used by the verification
  harness to compute the QA step timeout.
- `isQaConfiguredOnAnyComponent(): boolean` — drives the "Enable QA Testing"
  toggle on the goal-creation form via
  `GET /api/projects/:id/qa-testing-config`.

Everything else (`qa_start_command`, `qa_build_command`, etc.) is read by
the `/qa-test` skill — which is an agent, not server code — directly from
`project.yaml`. The skill picks the component, reads the keys, and
constructs the bash command itself.

## Why drop `qa_env`

`qa_env` was only ever inlined into `qa_start_command` by the agent at
author time. There is no server-side process that ever spread a
`Record<string, string>` into a child process's environment.

Authors now inline env vars directly into `qa_start_command`, single-quoted
with `'\''` escapes for embedded quotes:

```yaml
config:
  qa_start_command: "PORT=$PORT NODE_ENV=test npm start"
```

The first-boot migration in `state-migration/migrate-project-yaml.ts`
performs this composition automatically for legacy projects: each entry of
`qa_env` becomes a `KEY=value` prefix on `qa_start_command` before the
seven keys are deleted from the top level.

## Data model

```ts
export interface Component {
  name: string;
  repo: string;                       // "." for single-repo, else a subfolder of rootPath
  relativePath?: string;
  worktreeSetupCommand?: string;
  commands?: Record<string, string>;  // flat name → shell. Absent ⇒ data-only.
  config?: Record<string, string>;    // NEW: opaque key→string map (max 100 entries)
}
```

Strict `Record<string, string>` only — no nested objects, numbers, or
booleans. Numeric budgets are stored stringified
(`qa_max_duration_minutes: "10"`); consumers parse with a default fallback.

Agent-qa workflow step gains an optional `component?: string` field that
names which component's `config:` map to read.

## Wire / persistence contract

- **`PUT /api/projects/:id/config`** rejects all seven legacy `qa_*` keys at
  the top level with HTTP 400 and a migration message pointing at
  `components[<name>].config[<key>]`.
- The `components` payload is unchanged shape-wise — just gains an optional
  `config` field per entry.
- **`GET /api/projects/:id/qa-testing-config`** returns
  `{ configured: boolean }` (was `{ config: QaTestingConfig | null }`).
- **On-disk legacy form is still tolerated**. The first-boot migration
  picks a target component (first `agent-qa` step's `component:`, then
  name-match against the project, then `components[0]`), inlines `qa_env`
  into `qa_start_command`, copies the rest into `config:`, and deletes the
  seven top-level keys. The migration is idempotent.

## Consumers

| Site | Key |
|---|---|
| `verification-harness.ts::runAgentQaStep` | `qa_max_duration_minutes` (timeout) |
| `verification-harness.ts::_rerunAgentQaStep` | same |
| `server.ts::GET /api/projects/:id/qa-testing-config` | `qa_start_command` (presence-only via `isQaConfiguredOnAnyComponent`) |
| `/qa-test` skill (agent) | all of `qa_start_command`, `qa_build_command`, `qa_health_check`, `qa_browser_entry`, `qa_max_duration_minutes`, `qa_max_scenarios` |

The harness resolves the component from the step's `component:` field,
falling back to the first component with `qa_start_command`, then a
name-match against the project, then `components[0]`. The fallback chain
keeps legacy goals (whose `agent-qa` step lacks `component:`) working.

## UI

- **Settings → Project**: the legacy QA-key form rows are gone. Each
  component card now has an editable `Config` key-value table next to its
  `commands` table. Both persist via `PUT /api/projects/:id/config` with the
  full `components` array.
- **Project-proposal panel** (Components / Workflows / Diff tabs):
  - Components view renders per-component
    `data-testid="component-config-${name}"` tables, read-only (Settings is
    the editor).
  - Diff view annotates per-key adds / removes / changes for both
    `commands` and `config`.
- **`onProjectProposal`** shallow-merge runs **per component**: when both
  prev and incoming have `components`, entries are matched by `name` and
  missing `commands` / `config` are carried over from the prev entry. A
  partial re-emit of one component (e.g. updating only `commands` on `web`)
  no longer clobbers its previous `config` map.

## Non-goals

- Non-string value types in `config` (numbers, booleans, nested objects).
- Cascading `config` across builtin → server → project layers; project-scoped
  only, like `commands`.
- A typed/structured env-var collection on Component — agents inline env
  vars into `qa_start_command`.

## Related docs

- [docs/qa-testing.md](../qa-testing.md) — Per-component config layout, `/qa-test` skill protocol.
- [docs/internals.md — Multi-repo & components](../internals.md#multi-repo--components) — Component schema.
- [docs/internals.md — Native-YAML project.yaml fields](../internals.md#native-yaml-projectyaml-fields) — Wire-format strictness.
- [docs/internals.md — Project-proposal panel structure](../internals.md#project-proposal-panel-structure) — Three-view panel + per-component config rendering.
- [docs/goals-workflows-tasks.md — `agent-qa` step type](../goals-workflows-tasks.md#agent-qa-step-type) — Workflow step + `component:` field.
