# Project command environments

## Decision

Add a native, plaintext `env: Record<string, string>` to a component and to
**only** `type: command` workflow steps. It supplies literal process environment
values to workflow command execution; it is not a shell-prefix facility or a
secret store.

```yaml
components:
  - name: api
    repo: .
    commands:
      test: npm test
    env:
      NODE_OPTIONS: "--max-old-space-size=4096"
    config: {}
workflows:
  feature:
    gates:
      - id: implementation
        name: Implementation
        verify:
          - name: Tests
            type: command
            component: api
            command: test
            env:
              CI: "1"
```

For each command start, the effective environment is a fresh snapshot with this
precedence:

1. command-step `env`;
2. selected component `env`;
3. the Bobbit gateway process environment.

A free-form `{ run }` command has no selected component, so receives only step
overrides over the process environment. `{ component, run }` and
`{ component, command }` receive that component's map. A component map is never
consulted for another component, a non-command step, session/agent launch,
worktree setup, QA skill, or the gateway itself.

The snapshot is passed to the command launcher immediately before spawning. A
save can therefore affect the next invocation without a restart, but cannot
modify a process that has already started. Do not persist the merged host map in
active-verification state: recovery resumes the existing process and must never
make host values inspectable through APIs, logs, or WebSocket payloads.

## Alternatives considered

### Option A — native maps with spawn-time resolution (chosen)

Persist declared `components[].env` and command-step `env` maps, validate them
in `command-environment.ts`, then create one private merged snapshot immediately
before each spawn. The flow is YAML/API → store/validator → `resolveStep()`
selected component → `resolveCommandEnvironment()` → host spawn `env` or Docker
`-e` argv. Its changed files are the model/store/validator, harness and command
runner, plus the existing Components/workflow editors; its seams are shared
validation/round-trip, fake-spawn/Docker-argv, live next-invocation, and browser
save/reload tests. It adds the native model and safe transport while leaving
recovery to the already-running process/container.

### Option B — resolve at signal time and persist the merged environment (rejected)

This would merge before verification checks in `verifyGateSignal()`, write the
map to `ActiveVerification`/gate recovery state, and read it on restart. It
would change `verification-harness.ts`, active-verification persistence,
inspection/WebSocket payload contracts, and `docs/verification-restart.md`.
Its principal failure mode is persisting and potentially exposing unrelated host
`process.env` values; it also makes stale configuration replayable. Its test
seams are persistence shape, redaction, and restart replay tests. It loses
because recovery already follows the live process, so the extra state creates a
security and defect surface with no user benefit.

### Option C — minimal composition through opaque config or shell prefixes (rejected)

The smallest apparent change would reuse `Component.config`, the current
Components save flow, and the existing command-string wrapper: encode variables
as config entries or prepend `KEY=value` to a command. It would touch primarily
`settings-page.ts` and command construction, with existing Components fixtures
and command-runner tests as its seams. That flow makes values shell syntax;
quotes, `$()`, newlines, and Windows Git Bash conversion become injection or
literal-value failures, and Docker cannot receive an argv-safe declared map. It
also violates the required native schema and prohibition on opaque-config or
shell-prefix encoding, so it loses despite its smaller diff.

### Minimal composition retained by Option A

The selected design composes existing owners where their contracts fit:
`resolveProjectConfigStore(goalId)` supplies the fresh next-invocation read;
`freezeWorkflowDefinition()` and `structuredClone` carry snapshots;
`spawnTracked` and `VerificationCommandSpawnSpec` carry the immutable spawn
input; and the Components dirty/save model plus `buildSavePayload()` retain the
current UI lifecycle. Extend their protecting seams rather than replace them:
`tests2/integration/project-config-component-config.test.ts`, workflow-store
and workflow-step-shape core tests, fake command-runner tests,
`tests2/core/verification-sandbox-exec.test.ts`, and existing Components browser
fixtures.

### New defect-surface inventory

| Addition | New control/state surface | Why it is required and protecting seam |
|---|---|---|
| `command-environment.ts` | Shared validation and overlay rules | Prevents REST/workflow/runtime rule drift; unit validation and precedence tests. |
| Native component and command-step `env` fields | YAML/API/proposal clone and serialization branches | Required structured data model; round-trip and backward-compatibility tests. |
| `resolveStep().component` | Selected-component ownership branch | Avoids a second divergent lookup; component-isolation resolution tests. |
| `VerificationCommandSpawnSpec.env` | Immutable host/Docker transport input | Avoids shell-prefix transport; fake-spawn and exact Docker-argv tests. |
| Component/workflow row state | Draft validation, focus, and type-change cleanup | Required editable UX; browser save/reload, accessibility, and non-command hiding tests. |
| Sandbox component-relative CWD mapping | Container path translation and escape rejection | Keeps a component-scoped command and its environment in the same component root; sandbox CWD adjacency tests. |

## Data model and canonicalization

### New shared module

Create `src/server/agent/command-environment.ts`. It is the single authority for
normalization, strict ingress validation, case-insensitive collision detection,
and runtime overlay. Export:

```ts
export type CommandEnvironment = Record<string, string>;
export const COMMAND_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_COMMAND_ENV_ENTRIES = 100;
export const MAX_COMMAND_ENV_KEY_LENGTH = 128;
export const MAX_COMMAND_ENV_VALUE_LENGTH = 16_384;

export function validateCommandEnvironment(
  value: unknown,
  path: string,
): string | null;

/** Clone valid persisted YAML while dropping malformed legacy entries safely. */
export function normalizeCommandEnvironment(value: unknown): CommandEnvironment | undefined;

/** Copy base then overlay each map with Windows/POSIX deterministic key handling. */
export function resolveCommandEnvironment(
  base: NodeJS.ProcessEnv,
  component?: CommandEnvironment,
  step?: CommandEnvironment,
): NodeJS.ProcessEnv;
```

`validateCommandEnvironment` rejects, rather than coerces, API/proposal input
that is not a plain object; has more than 100 entries; has a non-string value;
has an empty, over-length, or regex-invalid key; has an over-length value; or
contains two keys whose `toLocaleLowerCase("en-US")` values match. Empty string
values are valid. Error text includes the supplied JSON/YAML path, for example
`components[api].env.NODE_OPTIONS: value exceeds 16384 characters` or
`...env: duplicate keys "Path" and "PATH" (case-insensitive)`.

`normalizeCommandEnvironment` is deliberately defensive for existing hand-edited
YAML: it returns a cloned map only when every retained entry is valid and within
limits; otherwise it logs a targeted warning and omits the malformed map. It
never stringifies numbers, booleans, arrays, or objects. Strict validation is
used before writes, so normal use receives an HTTP 400 instead of silent loss.

`resolveCommandEnvironment` starts from a new `{ ...process.env }`-style copy.
For each component then step key it removes any existing key whose lowercase
form matches, then inserts the declared spelling/value. This makes `Path`,
`PATH`, and `path` deterministic on both Windows and POSIX while retaining the
configured spelling. It performs no `$VAR`, `%VAR%`, `~`, template, or shell
expansion. It returns a fresh map for every call and never mutates `process.env`
or either configuration map.

### Component type and YAML store

In `src/server/agent/project-config-store.ts`:

- add `env?: CommandEnvironment` to `Component`, as a sibling of `commands` and
  `config`;
- update `normalizeComponents()` to call `normalizeCommandEnvironment(r.env)`;
- update `serializeComponent()` to emit `env` when non-empty, after `commands`
  and before `config`;
- extend the defensive copies in `getComponents()`, `getComponent()`, and
  `setComponents()` to clone `env` as well as `commands`/`config`.

The canonical on-disk key is exactly `env`, not `command_env`, `config.env`, or a
shell prefix in `commands`. Existing YAML with no `env` round-trips unchanged;
there is no migration because no old structured command-environment field
exists. `components[].config` remains opaque skill configuration and must not be
reused for this execution-scoped model.

### Workflow types, parse, serialize, validation

In `project-config-store.ts`, add `env?: CommandEnvironment` to all three
command unions (`CommandStepStructural`, `CommandStepComponentRun`, and
`CommandStepFreeform`), not to LLM review, agent QA, or human sign-off unions.
That keeps `InlineVerifyStep` correct for proposal and YAML callers.

In `src/server/agent/workflow-store.ts`:

- add `env?: CommandEnvironment` to runtime `VerifyStep`;
- in `normalizeStep()`, read and normalize `r.env` only when `type ===
  "command"`; ignore/report it on malformed legacy non-command YAML;
- in `serializeStep()`, write `env` only when `s.type === "command"` and the
  map is non-empty.

In `src/server/agent/workflow-validator.ts`:

- add `env?: unknown` to `ValidatorVerifyStep`;
- call `validateCommandEnvironment(stepValue.env, `${prefix}: env`)` for a
  command step when present;
- reject an `env` field on every non-command step with a specific error instead
  of preserving a hidden, ineffective field.

The full-definition validator remains the security boundary before
`normalizeWorkflow()` can drop bad input. `freezeWorkflowDefinition()` continues
to `structuredClone` the normalized workflow, so `env` follows existing goal
snapshot, inline-goal, child inheritance, and workflow customization behavior.
`serializeStep`/`normalizeStep` preserve it across the inline workflow store.

## Wire, proposal, and persistence paths

All structured paths must accept and return the new fields without exposing a
merged host environment.

| Path | Required change |
|---|---|
| `POST /api/projects` in `src/server/server.ts` | Replace the config-only component validation with shared component validation which also invokes `validateCommandEnvironment(component.env, ...)`; include `env` in create normalization. |
| `PUT /api/projects/:id/config` in `server.ts` | Use the same validator before writes; include `env` in the normalized component passed to `setComponents()`. In the legacy top-level command-promotion path, preserve the default component’s `env` and every remaining component’s `env` just as it now preserves `config`. The response stays `{ ok: true }`. |
| `GET /api/projects/:id/structured` | `getComponents()` naturally returns declared component `env`; it must return no effective/process values. |
| `ProjectConfigStore::save/load` | Native YAML serialization and parse preserve the map with unrelated component fields. |
| `InlineWorkflowStore` and `/api/workflows` | Existing get/put/update flow obtains the field through the workflow normalizer/serializer. Validate on create, update, customize, project create, and project config PUT via `validateAllWorkflows()`. |
| Goal snapshots | `GoalManager.createGoal()` and `resolveChildWorkflow()` already use `structuredClone`; retain that behavior and add a clone regression for command `env`. |
| Project import/export | Project YAML is the structured source and project proposal acceptance uses the normal config PUT, so preserving the fields in both layers covers import/export. |

Extract the present `validateComponentsConfig()` in `server.ts` into a shared
`validateComponents()` helper near the component model (or expand it to call the
new module). It must validate both `config`'s existing contract and the new
`env` contract consistently for POST and PUT. Do not duplicate slightly
different rules in proposal tooling and REST routes.

Update the proposal surfaces:

- `defaults/tools/proposals/propose_project.yaml`: document component `env`,
  command-step `env`, plaintext/non-secret restriction, and literal behavior.
- `src/server/agent/project-assistant.ts`: amend its generated project schema
  and edit-mode “propose it back as-is” guidance to include `env` alongside
  `commands` and `config`.
- `src/app/proposal-registry.ts::projectMerge()`: preserve `env` in the
  per-component partial merge (`env: c.env ?? prevC.env`), matching existing
  commands/config behavior.
- `src/app/project-proposal-views.ts`: add `env` to `ProposalComponent` and
  `ProposalVerifyStep`; render a plaintext “Command Environment” component
  section and a command-step “Environment overrides” detail only for command
  steps. The read-only proposal view must show declared values, never resolved
  process values.
- `src/app/project-proposal-diff.ts`: make the structured proposal-diff view
  include `env` through its existing `components`/`workflows` payload rather
  than filtering it. Add per-key change annotations where it currently handles
  commands/config.

`src/app/project-proposal-diff.ts::PROJECT_NATIVE_FIELDS` already forwards
whole `components` and `workflows` structurally, so no separate top-level native
field is needed. Project proposal file serialization is generic YAML; the field
must be kept in the proposed nested object, not flattened.

## Runtime execution

### Resolve once at start

Extend `resolveStep()` in
`src/server/agent/verification-harness.ts` to return the selected component as
well as `cwd` and `runString`:

```ts
{ cwd: string; runString?: string; component?: Component }
```

For `{ component, command }` and `{ component, run }`, set `component` to the
matched component. `{ run }` returns no component. This prevents a second,
possibly divergent component lookup and makes component isolation explicit.

In `VerificationHarness.verifyGateSignal()`, after `resolveStep()` and before
calling `runCommandStep()`:

1. read the project-local store with `resolveProjectConfigStore(signal.goalId)`;
2. get the fresh component list; resolve command/cwd/component from that one
   list;
3. substitute existing allowed command template variables in the resolved run
   string (unchanged behavior);
4. call `resolveCommandEnvironment(process.env, resolved.component?.env,
   step.env)` once, after all skip/push-safety checks and immediately before
   spawn;
5. pass the new snapshot into `runCommandStep`.

For sandbox goals, preserve the component-relative CWD as well as the
environment: derive `path.relative(goalBranchContainer(goal), resolvedCwd)` on
the host, reject an escaping relative path, and join it to
`/workspace-wt/<branch>` (or `/workspace` fallback). This bounded adjacency is
intentional: a component-scoped environment is not meaningfully isolated when
its command instead runs from another component's container root. Change the
current unconditional replacement so `api` and `packages/api` commands run in
their own container component root, not merely the worktree root; it does not
alter non-component CWD semantics.

This code must not use `projectConfigStore` captured for a different project;
verification already has `resolveProjectConfigStore(goalId)` for that purpose.
No `env` values enter `builtinVars`, `projectVars`, agent metadata, output,
diagnostics, gate state, or substitute-vars paths.

### Process and Docker transport

Change the private `runCommandStep` signature to accept an immutable
`commandEnv: NodeJS.ProcessEnv` argument. Thread it into both transports:

- Add `env?: NodeJS.ProcessEnv` to
  `VerificationCommandSpawnSpec` in
  `src/server/agent/verification-command-runner.ts`; the real runner passes it
  unchanged to `spawnTracked`. Fakes can inspect the exact snapshot without
  launching a shell.
- For host attached and detached paths, pass `commandEnv` through that spec.
  The detached shell wrapper still writes status/identity files, but it runs
  under the supplied spawn environment. Do not create `KEY=value command`
  strings.
- For Docker, construct `docker exec` argument-vector pairs before the
  container/image arguments: `['-e', `${key}=${value}`]` for each resolved map
  entry, then `['-i', '-w', normalizedCwd, containerId, ...]`. Keep
  `MSYS_NO_PATHCONV` and `MSYS2_ARG_CONV_EXCL` in the **host docker CLI**
  environment, merged with `commandEnv` only when appropriate for the CLI;
  the project values must be sent to the container exclusively through `-e`.
  Values are one argv item, never interpolated into `wrappedCmd`.

The map is inherited by the shell and its descendants just as normal process
environment does. Docker `-e` has the same literal key/value semantics. It must
be applied before the durable container wrapper is launched, so a restart sees
the running container payload rather than needing to reconstruct its
configuration.

### Recovery, cancellation, and concurrency

The durable command model in `verification-harness.ts` and
`docs/verification-restart.md` remains authoritative:

- Host detached execution has the spawned process's snapshot; resume waits for
  that existing process/exit record. It does not reload component or workflow
  environment from YAML.
- Docker recovery similarly follows the existing daemon-attested command; it
  does not re-run a command with a newer map.
- Windows pending/retry behavior remains unchanged: an interruption has no
  command verdict and any later re-signal captures then-current settings.
- Timeout/cancellation use current ownership records, not environment data.
  Do not add environment values to `ActiveVerification`, retained command
  diagnostics, gate inspection, or websocket events.
- Parallel signals each allocate their own `commandEnv` object. Never cache a
  mutable effective environment on a harness, project context, component, or
  `process.env`; this prevents project/worktree/component cross-talk.

This feature intentionally does not alter `src/server/skills/worktree-setup.ts`,
agent/session launch environments, extension host processes, arbitrary skills,
or sandbox-token/provider credential injection. If a future surface needs a
command environment, it requires its own explicit design and scope.

## Settings and workflow editor UX

### Components tab

Extend `src/app/components-editor.ts`:

```ts
export interface ComponentEditState {
  // existing fields
  env: Array<{ key: string; value: string }>;
}
export interface ServerComponent { env?: Record<string, string>; }
```

`componentToEditState()` turns an absent map into `[]`. `editStateToComponent()`
preserves blank **values** but excludes blank/whitespace keys; it emits `env`
when valid rows exist. Do not use the existing command rule (`value.trim()`),
because `""` has the documented explicit-empty meaning. The UI validates every
row before `buildSavePayload()`; the server repeats validation.

In `src/app/settings-page.ts::renderProjectComponentsTab()`, insert the section
immediately after `Commands` and before `Config`:

- heading `Command Environment (N)`;
- hint: “Values are injected into this component’s named commands at execution
  time. Saved changes affect the next command without restarting Bobbit.”;
- persistent warning: “Stored as plaintext. Do not enter API keys, tokens,
  passwords, or other secrets. Use Sandbox Tokens or Provider API Keys for
  sensitive values.” The exact user-facing copy is canonical in
  `project-command-environments-ux.md`;
- empty state exactly `No command environment variables.` plus an **Add
  variable** button;
- rows with visible/associated `Key` and `Value` labels, in-place keyboard
  editing, `aria-describedby` to per-row errors, and remove buttons with names
  such as `Remove command environment variable NODE_OPTIONS`;
- when rows exist, retain a clearly labelled **Add variable** action;
- row errors are shown as the user edits and block the existing card-level
  Save action until valid. The existing `dirty`, explicit Save, request, Saved,
  reload, and error model remains unchanged—no autosave or restart request.

Replace current inline `style` row layouts with a small named class in
`src/app/workflow-page.css` (for example `.component-kv-row` and
`.component-env-warning`). Give all inputs `min-width: 0`, allow the row to
wrap/stack at `max-width: 600px` (the UX contract's canonical breakpoint), and
make the remove target keyboard-focusable. The narrow layout must show labels
and avoid horizontal scrolling.

`loadComponentsTab()` already maps server components through the pure helper;
therefore a successful reload shows persisted `env`. `saveComponentsTab()` keeps
using `buildSavePayload()` and `PUT /api/projects/:id/config`, so it gets the
same no-restart rule as other component changes. New component initial state
must include `env: []`.

### Workflow editor

In `src/app/api.ts`, add `env?: Record<string, string>` to UI `VerifyStep`.
In `src/app/workflow-page.ts`:

- deep-clone `v.env` in `showEdit()` and every local workflow cloning path,
  rather than sharing a record under the shallow `{ ...v }` clone;
- add a command-only “Environment overrides” editor inside the existing
  Advanced `<details>` in `renderVerifyStepEditor()`;
- render `Inherits the selected component command environment.` when the step
  map is absent/empty; for free-form command explain that only its overrides
  and the process environment apply;
- show precedence/origin as declared configuration only: “step override →
  component command environment → Bobbit process environment.” Do not list
  process keys or values;
- add/remove/edit rows with the same labels, error behavior, blank-value
  treatment, accessibility, and responsive layout as component rows;
- include `step.env` in `validateStep()` by calling a UI-safe mirror of the
  shared validation rules (or return server errors on Save); the browser must
  catch regex, duplicate, count, and length failures inline;
- add `step.env` to the Advanced open predicate so saved overrides remain
  discoverable;
- in `mutateStepForTypeChange()`, delete `next.env` when changing away from
  `command`; command-to-command changes retain it.

The editor must render no environment UI for `llm-review`, `agent-qa`,
`human-signoff`, or `subgoal`. Update all workflow draft/copy boundaries,
including `showEdit`, `compactPhases`, goal workflow fixture loading, proposal
views, `InlineWorkflowStore` structured clones, `GoalManager`,
`child-ready-to-merge.ts`, and `spawn-child-workflow.ts`, to prove an embedded
map is cloned rather than mutated by one editor/child snapshot.

## Security and compatibility

- This is explicitly plaintext configuration, not a secret facility. The UI,
  proposal docs, and user documentation must direct secrets to Sandbox Tokens
  or provider credential storage.
- The feature may return declared component/step `env` to an authorized project
  settings/workflow caller, because those are configured plaintext. It must
  never return unrelated `process.env` values or an effective merged map.
- Values are literal strings. No interpolation, template substitution, shell
  expansion, quoting, shell-prefix concatenation, or command-map rewriting.
- API validation rejects case-insensitive duplicate keys even on POSIX, making
  behavior portable to Windows. Existing maps without `env`, string command
  maps, data-only components, old workflow YAML, and legacy top-level command
  promotion continue unchanged.
- A blank value explicitly sets an empty variable. Removing the row omits the
  key, restoring inheritance. Component no-map and empty-map serialize as
  absent YAML to keep files terse.
- No automatic migration from `config`, shell prefixes, `qa_env`, or process
  state. In particular, legacy QA remains scoped to `config` and is outside
  this feature.

## Test plan

All new automated tests belong in `tests2/` and must be registered through the
normal `tests2/tests-map.json` inventory flow.

### Core/unit

Add focused tests near these existing seams:

- `tests2/core/command-environment.test.ts`: key regex, map/non-string errors,
  100-entry cap, key/value limits, blank values, case-insensitive collisions,
  no interpolation, deterministic overlay, and no mutation of inputs/process
  environment.
- Extend `tests2/core/verify-step-resolution.test.ts` and
  `tests2/core/workflow-step-shapes.test.ts`: structural, component-run, and
  free-form resolution expose the correct selected component and use only that
  environment.
- Extend workflow-store/validator tests (or add
  `tests2/core/workflow-command-environment.test.ts`): YAML normalization and
  serializer round trip; `env` rejected on non-command steps; snapshots and
  child cloning retain independent maps; old YAML remains valid.
- Extend `tests2/core/verification-sandbox-exec.test.ts` and the fake command
  runner tests: assert exact host spawn `env`, Docker `-e` argv pairs containing
  only declared component/step keys, and component-CWD adjacency (`api` and
  nested `packages/api` map to their matching container roots while escapes are
  rejected); malicious values containing spaces, quotes, `$()`, semicolons,
  newlines, and `=` remain a single literal value and never alter shell syntax.
- Add concurrent invocation tests using two project contexts/components and
  different values. Assert separate spawn specs, no shared object identity, and
  no component A/project A leakage into component B/project B.

### Integration and recovery

Extend or parallel
`tests2/integration/project-config-component-config.test.ts` with:

- POST/PUT/GET structured round trips for component `env`, preserving commands,
  config, workflows, and unrelated fields;
- strict bad-map 400 responses for project creation/config update;
- workflow REST round trips for command step overrides and rejection on a
  review/QA/signoff step;
- an in-process live-session test that runs a controlled command, saves a new
  component/step value, and proves only the next invocation receives it while a
  started command retains its original marker;
- host and sandbox execution cases that read a marker and prove values arrive
  as literal environment entries.

Extend restart tests around `tests2/core/verification-command-restart-lifecycle.test.ts`
and `tests/e2e/gate-verification-resume.spec.ts`: change settings while a
detached/container command is running, restart/recover it, and prove recovery
uses the original process (no new configured value); re-signal afterward and
prove the new value is used. Keep the existing retryable Windows and
container-ownership contracts intact.

### Browser journeys

Add a `tests2/browser` fixture/journey patterned after
`workflow-review-timeout-editor.spec.ts` and the Components tab fixtures:

1. expand a component card; discover Command Environment after Commands and
   before Config; see warning and exact empty state;
2. add, edit, remove, save, reload, and verify an empty value persists;
3. demonstrate inline invalid key, duplicate/case collision, and accessible
   remove label; verify no horizontal overflow at a narrow viewport;
4. set different component maps and prove independently persisted rows;
5. edit a command step Advanced override, save/reload, see inheritance/origin;
6. verify the editor is hidden after switching to each non-command type and
   stale env is not submitted; and
7. inspect the proposal Components/Workflows views for declared values only.

Run `npm run check`, `npm run test:unit`, `npm run test:browser`, and
`npm run test:e2e` before merge. Update `docs/internals.md`,
`defaults/workflow-authoring-guide.md`, the proposal tool guidance, and user
settings documentation with the YAML schema, precedence, literal/no-restart
semantics, host/container transport, scope limits, plaintext warning, backward
compatibility, and this generic example:

```yaml
env:
  E2E_V2_PW_WORKERS: "4"
```

The E2E runner itself keeps default worker count `2` when the variable is
absent; no Bobbit-specific runtime branch belongs in this feature.
