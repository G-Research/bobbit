# Project command environments

Project command environments configure non-secret, literal environment values for workflow command verification. They let a project author set execution options once on a component and selectively override them on a command step, without putting platform-specific shell prefixes into commands or restarting Bobbit.

This is a command-verification feature. It does not change the gateway, agent, or general-purpose process environment. For workflow syntax, see the [workflow authoring guide](../defaults/workflow-authoring-guide.md); the implementation decisions are recorded in the [design](design/project-command-environments.md) and [UX contract](design/project-command-environments-ux.md).

## YAML and API schema

`env` is a native YAML mapping, not an entry in the component's opaque `config` map and not part of a shell command string.

```yaml
components:
  - name: api
    repo: "."
    commands:
      test: npm test
      e2e: npm run test:e2e
    env:
      NODE_OPTIONS: "--max-old-space-size=4096"
      E2E_V2_PW_WORKERS: "4"
    config: {}

workflows:
  feature:
    name: Feature
    gates:
      - id: implementation
        name: Implementation
        verify:
          - name: E2E
            type: command
            component: api
            command: e2e
            env:
              CI: "1"
```

- `components[].env?: Record<string, string>` applies when a command step selects that component, including a component-linked free-form `run` step.
- `verify[].env?: Record<string, string>` is accepted only when `type: command`; it overrides the selected component's declaration for that invocation.
- Project creation, structured project configuration reads/writes, and project promotion preserve component declarations. Workflow create/read/update/clone APIs preserve command-step declarations. These APIs return only declared maps, never Bobbit's merged process environment.
- Project proposals, proposal diffs/views, goal workflow snapshots, child workflow copies, and project YAML import/export keep independent copies of both maps. Editing a draft or a child therefore cannot mutate another snapshot.

The `E2E_V2_PW_WORKERS` example is ordinary component configuration: it changes the selected command's environment only. Bobbit's E2E runner still defaults to `2` when no override is configured; there is no E2E-specific runtime branch in this feature.

### Validity and literal values

Each map has at most 100 entries. A key must match `/^[A-Za-z_][A-Za-z0-9_]*$/` and be at most 128 characters; a value must be a string of at most 16,384 characters. Keys that differ only by case, such as `Path` and `PATH`, are rejected in the same map so behavior remains deterministic on Windows and POSIX.

Values are literal. Bobbit does not expand `$VAR`, `${VAR}`, `%VAR%`, command substitution, templates, or shell syntax. `""` is a valid value and explicitly sets an empty variable. Removing that row omits the key and restores inheritance from the lower-precedence source. Empty maps are omitted when YAML is written.

## Settings and workflow editor

**Settings → Components** places **Command Environment (N)** after **Commands** and before **Config**. It has labelled name/value rows, add and accessible remove controls, inline validation, and an empty state of `No command environment variables.`. It uses the component card's normal dirty state and explicit Save/Saved/Failed feedback: there is no autosave and no restart request. A saved component map is reloaded as declared.

The section explains that saved changes affect the next command without restarting Bobbit. It also displays this warning:

> Stored as plaintext. Do not enter API keys, tokens, passwords, or other secrets. Use Sandbox Tokens or Provider API Keys for sensitive values.

Use the project's **Sandbox Tokens** for a value that must enter a sandbox, or **Settings → Models → Provider API Keys** for model-provider credentials. Command environments are deliberately not a secret store.

**Settings → Workflows** shows **Environment overrides (N)** under Advanced fields only for `command` verification steps. With a selected component, an empty map states that the step inherits that component's Command Environment; a pure free-form command states that it uses the Bobbit process environment. The editor shows declared precedence and whether an entered key overrides the component, but never shows host keys or values. Changing a step to a non-command type removes its environment overrides, and non-command types have no environment editor.

Both editors allow blank values, use real input labels and named remove buttons, show errors inline, and stack rows at narrow widths to avoid horizontal overflow.

## Runtime behavior

Bobbit resolves an independent environment snapshot immediately before each command spawn:

1. Bobbit process environment
2. selected component `env`
3. command-step `env`

Later sources replace an earlier key case-insensitively. A component-linked named command and a component-linked `run` step select that component. A pure `{ run }` step has no component layer, so it receives the process environment plus its step overrides only.

Because resolution occurs at the spawn boundary, saving a project or workflow affects the **next** command invocation without a gateway restart. A running child keeps its copied snapshot; later saves never mutate it. Each signal gets its own map, so components, projects, worktrees, and concurrent commands cannot cross-talk.

### Host and Docker execution

Host commands receive the complete resolved snapshot through the process spawn API. Bobbit does not compose an `export`, `VAR=value`, or other shell prefix, so literal values cannot alter command parsing.

For Docker command verification, the Docker CLI itself keeps the host environment required to communicate with Docker, but `docker exec` receives only declared component/step values as argv-safe `-e KEY=value` arguments. Bobbit's process environment is not copied into the container. The command still receives the container's normal base environment, with declared `-e` entries overlaying it. This distinction prevents gateway credentials and unrelated host values from crossing the container boundary while preserving the image/container runtime contract.

### Recovery, cancellation, and scope

A detached host command or Docker command that survives a gateway restart keeps the snapshot captured at its original spawn. Recovery follows that existing process and its durable ownership evidence; it does not reload YAML or expose a stored effective environment. A Windows command that becomes pending/retryable after interruption captures current declarations only if it is later re-signalled. Cancellation, timeouts, retained diagnostics, gate inspection, and websocket events do not persist or reveal the merged map. See [Exact process ownership for command verification](verification-restart.md) for the recovery model.

The feature is intentionally limited to workflow `type: command` execution. It does not inject values into the Bobbit gateway, agent sessions, extensions, arbitrary tools or skills, QA testbed startup, worktree setup, or provider/sandbox credential mechanisms. Those surfaces require their own scoped design.

## Compatibility and migration

No migration is required. Existing `project.yaml` files without `env`, existing string command maps, data-only components, and existing workflow YAML remain valid. Bobbit does not infer command environments from opaque `config`, `qa_env`, shell prefixes, or the host process. Add native `env` declarations only when a component or command step needs a non-secret literal value.
