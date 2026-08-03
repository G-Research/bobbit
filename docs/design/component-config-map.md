# Component config map

Move QA-testing settings (and any future per-component skill-consumed configuration) off the top level of `project.yaml` and onto each component's opaque `config: Record<string, string>` map. Components now have three sibling maps: `commands` for named shell commands, native `env` for generic literal command-verification environment, and opaque `config` for skill-consumed settings.

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
`Record<string, string>` into a QA child process.

This retirement is deliberately separate from native component `env`.
`components[].env` is generic, literal, non-secret configuration for workflow
`command` verification steps that select the component; it does not configure
QA skills or `qa_start_command`. QA authors still inline values directly into
`qa_start_command`, single-quoted with `'\''` escapes for embedded quotes:

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
  env?: Record<string, string>;       // literal, non-secret workflow command environment.
  config?: Record<string, string>;    // opaque skill-consumed key→string map (max 100 entries)
}
```

Both `env` and `config` are strict `Record<string, string>` maps — no nested
objects, numbers, or booleans. `env` values are literal plaintext and not a
secret store; the command-environment validator applies its own key, size, and
case-collision limits. `config` numeric budgets are stored stringified
(`qa_max_duration_minutes: "10"`); consumers parse with a default fallback.

A workflow `command` step selecting this component, either
`{ component, command }` or `{ component, run }`, receives its `env` map. Its
step-level `env` overrides component values. A pure `{ run }` step has no
component map. Agent-qa workflow steps instead use their optional
`component?: string` to select the component's `config:` map.

## Wire / persistence contract

- **`PUT /api/projects/:id/config`** rejects all seven legacy `qa_*` keys at
  the top level with HTTP 400 and a migration message pointing at
  `components[<name>].config[<key>]`.
- The `components` payload preserves its sibling native maps: optional
  `commands`, `env`, and `config` per entry. APIs expose declared `env` values,
  never a merged host-process environment.
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

- **Settings → Project → Components**: the legacy QA-key form rows are gone.
  Each component card orders the editable maps as **Commands**, **Command
  Environment**, then **Config**. Command Environment is the native `env` map:
  it explains that values are literal plaintext, non-secret, injected only into
  selected workflow command steps, and that a save affects the next command
  without restarting Bobbit. It persists with the card's normal explicit
  Save/Saved/Failed state through `PUT /api/projects/:id/config`. `Config`
  remains the opaque home for QA keys.
- **Project-proposal panel** (Components / Workflows / Diff tabs):
  - Components view renders declared per-component `commands`, `env`, and
    `config` maps read-only (Settings is the editor).
  - Diff view annotates per-key adds / removes / changes for all three maps.
- **`onProjectProposal`** shallow-merge runs **per component**: when both
  prev and incoming have `components`, entries are matched by `name` and
  missing `commands` / `env` / `config` are carried over from the prev entry.
  A partial re-emit of one component (e.g. updating only `commands` on `web`)
  no longer clobbers its previous command environment or `config` map.

## Non-goals

- Non-string value types in `config` (numbers, booleans, nested objects).
- Cascading `config` across builtin → server → project layers; project-scoped
  only, like `commands`.
- Reintroducing `qa_env`, or treating generic component `env` as a QA-skill
  setting. QA startup keeps literal shell text in `config.qa_start_command`.

## Related docs

- [docs/project-command-environments.md](../project-command-environments.md) — Canonical generic command-environment schema, precedence, security, and runtime scope.
- [docs/qa-testing.md](../qa-testing.md) — Per-component config layout, `/qa-test` skill protocol.
- [docs/internals.md — Multi-repo & components](../internals.md#multi-repo--components) — Component schema.
- [docs/internals.md — Native-YAML project.yaml fields](../internals.md#native-yaml-projectyaml-fields) — Wire-format strictness.
- [docs/internals.md — Project-proposal panel structure](../internals.md#project-proposal-panel-structure) — Three-view panel + per-component config rendering.
- [docs/goals-workflows-tasks.md — `agent-qa` step type](../goals-workflows-tasks.md#agent-qa-step-type) — Workflow step + `component:` field.
