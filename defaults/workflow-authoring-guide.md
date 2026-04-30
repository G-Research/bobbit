# Workflow Authoring Guide

> **Audience:** the project assistant, workflow assistant, and goal assistant when generating or editing the inline `workflows:` block of a project's `project.yaml`.
>
> This guide is **not read at runtime**. It is included as context for assistant prompts so that hand-generated workflows are consistent and runnable. The runtime contract lives in `src/server/agent/workflow-validator.ts` and the gate runner; this document mirrors it.

## 1. Project model

A project is registered by its `name` and a `rootPath`. Inside `<rootPath>/.bobbit/config/project.yaml` we store:

```yaml
name: <project name>
worktree_root: <optional override>
sandbox: none | docker
sandbox_image: bobbit-agent
sandbox_tokens: [...]               # project-level
qa_start_command: ...               # project-level (used by agent-qa step type)
qa_health_check: ...
qa_browser_entry: ...
qa_env: { ... }
config_directories: [...]

components: [Component, ...]        # the only collection
workflows: { id: WorkflowDef, ... } # bespoke, inline
```

The **multi-repo invariant**: every component points at exactly one repo (or `"."` for single-repo). When a goal/session/staff worktree is provisioned, the agent gets a sibling worktree of every distinct repo at the same branch. Cross-repo work is expressed by declaring all the repos as components — *data-only* if they have no commands of their own.

### Single-repo vs multi-repo

| | Single-repo | Multi-repo |
|---|---|---|
| `rootPath` | the git repo | a container directory holding sibling repos |
| `components[*].repo` | always `"."` | folder name relative to `rootPath` |
| Worktree layout | `<wt-root>/<branchSlug>/` is the repo | `<wt-root>/<branchSlug>/<repo>/` per-repo |

Mode is inferred: any component with `repo !== "."` makes the project multi-repo.

## 2. Component model

```yaml
components:
  - name: api                     # unique within project; used as branch-dir label
    repo: "."                     # "." for single-repo, else a subfolder of rootPath
    relative_path: packages/api   # optional sub-path inside the repo
    worktree_setup_command: npm ci --prefer-offline --no-audit --no-fund
    commands:                     # flat name → shell map
      build:    npm run build
      test:     npm test
      check:    npm run check
      unit:     npm run test:unit
      e2e:      npx playwright test
      lint:     eslint .
      migrate:  npm run db:migrate
```

- **`name`** must match `[a-z0-9][a-z0-9-]*` and be unique. The default component for a single-repo project is named after the project (NOT `default`).
- **`repo`** is `"."` for single-repo. For multi-repo, it must be a single folder name one level deep under `rootPath` (no slashes, no `..`).
- **`relative_path`** is an optional sub-path inside the repo's worktree. Useful for monorepos: `repo: "."` and `relative_path: packages/api` means commands run at `<branch-container>/packages/api`.
- **`worktree_setup_command`** is a per-component runtime hook. Runs at the component's root path on worktree provision. 2-minute timeout, non-fatal, no deduplication.
- **`commands`** is a free-form map. There is no fixed schema for command names — workflows reference commands structurally by `(component, command)` pair. Common conventions: `build`, `check`, `test`, `unit`, `e2e`, `lint`, `format`, `migrate`. Use whatever your project actually has.

### Data-only components

A component without a `commands` map (or with an empty one) is **data-only**: it declares the existence of a repo but contributes no workflow steps. Use cases:

- Vendor / fixtures / shared assets repo that must be checked out alongside others.
- An e2e harness that lives in one component (`repo: e2e`) and shells into sibling worktrees of `api`, `web`, `shared`. Declare `api`/`web`/`shared` as data-only if they don't build/test in their own right.

Data-only components participate in worktree provisioning (they are checked out on the goal/session branch) but generate zero workflow steps automatically — and the validator never tries to resolve a `(component, command)` reference against them.

### Component working directory

The "component root" is the absolute path where its commands run:

```
componentRoot = <branch-container> / (component.repo === "." ? "" : component.repo) / (component.relative_path ?? "")
```

In single-repo, `<branch-container>` *is* the repo's worktree, so `componentRoot` collapses to `<branch-container>` (with optional `relative_path` appended). In multi-repo, the branch container is a sibling-repo container directory.

## 3. Workflow gates

```yaml
workflows:
  general:
    name: General
    description: Lightweight workflow for general-purpose goals.
    gates:
      - id: design-doc
        name: Design Document
        content: true              # gate accepts markdown content as a signal
        inject_downstream: true    # content is propagated to downstream gates' prompts
        verify:                    # array of verification steps
          - { name: "Design review", type: llm-review, role: architect, prompt: "..." }

      - id: implementation
        name: Implementation
        depends_on: [design-doc]
        verify: [...]

      - id: ready-to-merge
        name: Ready to Merge
        depends_on: [implementation]
        manual: true               # user must click "Mark passed" once deps are met
```

### Gate fields

| Field | Type | Meaning |
|---|---|---|
| `id` | string | unique within workflow; lowercase, alphanumeric + hyphens |
| `name` | string | display name |
| `description` | string? | optional narrative |
| `depends_on` | string[] | upstream gate IDs (must exist; no cycles) |
| `content` | boolean? | accepts markdown content via `gate_signal` |
| `inject_downstream` | boolean? | propagate content to downstream gate prompts |
| `optional` | boolean? | gate may be signaled with N/A |
| `manual` | boolean? | user must explicitly mark passed (no automatic verify) |
| `metadata` | map? | declared metadata schema for signals; values resolved via `{{agent.X}}`/`{{<gate>.meta.X}}` |
| `verify` | VerifyStep[] | verification steps (see §4) |

### 3.1 The implementation gate is a Ralph loop

The `implementation` gate's `verify` list is the agent's loop body. When verification
fails, the gate runner reports the failed steps to the implementing agent, which
fixes the code and re-signals the gate. The agent circles back through the same
verify list until it passes — this is the **Ralph loop**.

Practical implications when authoring workflows:

- **Verify steps must be self-contained checks**, not setup actions. The agent
  re-runs all of them on each iteration; a step that mutates external state
  (publishes a package, opens a PR) belongs in `ready-to-merge`, not `implementation`.
- **Phase your steps so cheap signals fail fast**: phase 0 = build, phase 1 = parallel
  test/check, phase 2 = expensive LLM reviews, phase 3 = optional QA. The runner
  short-circuits later phases when an earlier phase fails, so the Ralph loop spends
  its iterations on the cheapest signal that's still red.
- **Always include a gap-analysis step at design-time AND post-implementation**
  (except quick-fix). Design-time gap analysis catches missing requirements before
  the agent burns iterations; post-impl gap analysis catches drift between design
  and code. The seeded `general`, `feature`, and per-component flows include both.
- **The `description` field on the gate** surfaces in the project-proposal panel
  and the goal dashboard. Use it to remind reviewers that this gate is a loop, not
  a checkpoint.

## 4. Verification step shapes

There are three step `type:` values: `command`, `llm-review`, `agent-qa`.

### 4.1 `type: command` — three shapes

```yaml
# Shape A: structural — named command on a component (preferred)
- { name: "Build api", type: command, component: "api", command: "build" }

# Shape B: free-form shell, working dir derived from component
- { name: "Custom api thing", type: command, component: "api", run: "./scripts/special.sh" }

# Shape C: pure free-form, working dir = per-branch container root
- { name: "Push branch", type: command, run: "git push origin {{branch}}" }
```

Validator rules:

- Cannot have both `command:` and `run:` on the same step.
- Cannot have neither (a `type: command` step must produce a runnable shell string).
- A `command:` reference must resolve to `components[name].commands[name]` — unknown components or unknown command keys are a hard load-time error with a "Did you mean…" suggestion.
- Pure `{ run }` steps without `component:` run at the per-branch container root.

Common optional fields (apply to all three shapes):

| Field | Meaning |
|---|---|
| `phase: <int>` | groups parallel-runnable steps; phases run in ascending order |
| `expect: success \| failure` | flips pass/fail (use `failure` for TDD reproducing-tests) |
| `timeout: <seconds>` | per-step timeout (default 300s) |
| `optional: true` + `label:` + `description:` | renders as a user-toggleable "Enable X" affordance |

### 4.2 `type: llm-review`

Reviewer agent. Runs against the diff between the goal's branch and master, with access to repo files and gate content.

```yaml
- name: "Code quality review"
  type: llm-review
  role: code-reviewer       # any registered role; default if omitted
  phase: 2
  prompt: |
    Review the code changes on branch {{branch}} vs origin/{{master}} for quality.
```

### 4.3 `type: agent-qa`

QA agent. Stands up the project-level `qa_start_command` testbed and drives a real browser through scenarios. Requires `qa_start_command` to be set at project level — the validator warns (does not reject) if missing.

```yaml
- name: "QA testing"
  type: agent-qa
  role: qa-tester
  phase: 3
  optional: true
  label: Enable QA Testing
  description: Spawn a QA agent that builds, starts the server, and drives a real browser through scenarios.
  prompt: |
    Stand up the ephemeral testbed (qa_start_command), plan 3-5 scenarios,
    drive the browser, submit `verification_result`.
```

## 5. Runtime context tokens

Free-form `run:` strings and `prompt:` bodies may reference:

| Token | Meaning |
|---|---|
| `{{branch}}` | the goal/session branch name |
| `{{master}}` | the project's primary branch (e.g. `master`, `main`) |
| `{{goal_spec}}` | full markdown of the goal spec |
| `{{agent.<key>}}` | metadata supplied by the signaling agent |
| `{{<gate_id>.meta.<key>}}` | metadata from a passed upstream gate |

These are substituted by the gate runner before the step executes. **Do not** use `{{project.<key>}}` in command shapes — it is removed in favor of structural `{ component, command }` references. The validator will catch unresolved `{ component, command }` references at load time; unrecognized free-form tokens just pass through to the shell and fail at runtime as ordinary typos.

## 6. Pattern library

These are the typical gate sets per workflow style. Generators MAY extend, prune, or reorder freely.

> All non-quick-fix flows below include **both** a design-time gap-analysis step
> (in `design-doc` / `issue-analysis`) and a post-implementation gap-analysis step
> (in `implementation`, phase 2). See §3.1 — these two checks bracket the Ralph loop.

### 6.1 `general` — lightweight

```yaml
- design-doc       (content, llm-review)
- implementation   (build, check, unit, e2e in phase 1; llm-review in phase 2)
- documentation    (llm-review)
- ready-to-merge   (push, fast-forward, PR exists)
```

### 6.2 `feature` — full design + impl + multi-review + optional QA

```yaml
- design-doc       (content; design + gap-analysis llm-review)
- implementation   (build/check/unit/e2e, gap+code+security llm-review, optional agent-qa)
- documentation    (llm-review)
- ready-to-merge   (push/fast-forward/PR)
```

### 6.3 `bug-fix` — TDD

```yaml
- issue-analysis   (content, llm-review)
- reproducing-test (command with expect: failure; metadata declares test_command)
- implementation   (build/check/unit/e2e, llm-review)
- documentation
- ready-to-merge
```

### 6.4 `quick-fix` — minimal

```yaml
- implementation   (build/check/unit/e2e)
- ready-to-merge
```

### 6.5 `pr-review` (opt-in)

```yaml
- review           (llm-review against an existing PR)
```

## 7. Worked examples

### 7.1 Single-repo (Bobbit's own project.yaml)

```yaml
name: bobbit
sandbox: docker
sandbox_image: bobbit-agent
sandbox_tokens:
  - { key: ANTHROPIC_OAUTH_TOKEN, enabled: true  }
  - { key: GITHUB_TOKEN,          enabled: true  }

qa_build_command: npm run build
qa_start_command: |
  PORT=$PORT WORK_DIR=$WORK_DIR BOBBIT_DIR=$WORK_DIR/.bobbit
  BOBBIT_NO_OPEN=1 BOBBIT_LLM_REVIEW_SKIP=1 BOBBIT_SKIP_NPM_CI=1
  node dist/server/cli.js --host 127.0.0.1 --port $PORT --no-tls --auth --cwd $WORK_DIR
qa_health_check:  http://127.0.0.1:$PORT/api/health
qa_browser_entry: http://127.0.0.1:$PORT/?token=$TOKEN
qa_max_duration_minutes: 10
qa_max_scenarios: 5

components:
  - name: bobbit
    repo: "."
    worktree_setup_command: npm ci --prefer-offline --no-audit --no-fund
    commands:
      build: npm run build
      check: npm run check
      unit:  npx playwright test --config tests/playwright.config.ts --reporter=json 2>/dev/null | node scripts/test-filter.mjs
      e2e:   npx playwright test --grep-invert 'mcp-integration|session-lifecycle-ui' --config playwright-e2e.config.ts --reporter=json 2>/dev/null | node scripts/test-filter.mjs

workflows:
  general:
    name: General
    gates:
      - id: design-doc
        name: Design Document
        content: true
        inject_downstream: true
        verify:
          - { name: "Design review", type: llm-review, role: architect, prompt: "Review this design document for structure, clarity, and completeness." }

      - id: implementation
        name: Implementation
        depends_on: [design-doc]
        verify:
          - { name: "Build bobbit", type: command, component: "bobbit", command: "build", timeout: 600 }
          - { name: "Check bobbit", type: command, phase: 1, component: "bobbit", command: "check" }
          - { name: "Unit bobbit",  type: command, phase: 1, component: "bobbit", command: "unit" }
          - { name: "E2E bobbit",   type: command, phase: 1, component: "bobbit", command: "e2e", timeout: 900 }
          - { name: "Code quality review", type: llm-review, role: code-reviewer, phase: 2, prompt: "Review the code changes on branch {{branch}} vs origin/{{master}} for quality." }

      - id: documentation
        name: Documentation
        depends_on: [implementation]
        verify:
          - { name: "Documentation coverage", type: llm-review, prompt: "Confirm every user-facing change is documented in AGENTS.md / docs/." }

      - id: ready-to-merge
        name: Ready to Merge
        depends_on: [documentation]
        verify:
          - { name: "Branch pushed to remote",   type: command, run: "git push origin {{branch}} && git ls-remote --heads origin {{branch}} | grep -q ." }
          - { name: "Master merged into branch", type: command, run: "git fetch origin {{master}} && git merge-base --is-ancestor origin/{{master}} {{branch}}" }
          - { name: "PR raised",                 type: command, run: "gh pr list --head {{branch}} --base {{master}} --state open --json url -q \".[0].url\" | grep -q ." }
```

### 7.2 Multi-repo (api + web + shared data-only)

```yaml
name: myproj
rootPath: /home/me/w/myproj         # container directory, NOT a git repo
sandbox: none

components:
  - name: api
    repo: api
    worktree_setup_command: npm ci --prefer-offline
    commands:
      build: npm run build
      test:  npm test
      check: npm run check
      e2e:   npm run e2e

  - name: web
    repo: web
    worktree_setup_command: npm ci --prefer-offline
    commands:
      build: npm run build
      test:  npm test
      check: npm run check

  - name: shared        # data-only — checked out on every branch but contributes no steps
    repo: shared

workflows:
  general:
    name: General
    gates:
      - id: implementation
        name: Implementation
        verify:
          - { name: "Build api",  type: command, component: "api", command: "build" }
          - { name: "Build web",  type: command, component: "web", command: "build" }
          - { name: "Check api",  type: command, phase: 1, component: "api", command: "check" }
          - { name: "Check web",  type: command, phase: 1, component: "web", command: "check" }
          - { name: "Test api",   type: command, phase: 1, component: "api", command: "test" }
          - { name: "Test web",   type: command, phase: 1, component: "web", command: "test" }
          - { name: "E2E api",    type: command, phase: 2, component: "api", command: "e2e" }

      - id: ready-to-merge
        name: Ready to Merge
        depends_on: [implementation]
        verify:
          - { name: "Push api", type: command, component: "api", run: "git push origin {{branch}} && git ls-remote --heads origin {{branch}} | grep -q ." }
          - { name: "Push web", type: command, component: "web", run: "git push origin {{branch}} && git ls-remote --heads origin {{branch}} | grep -q ." }
```

The `shared` data-only component generates no workflow steps. It's only present so the worktree pool checks it out alongside `api` and `web` on every goal/session branch — the e2e harness in `api` (or a separate `e2e` component) can then `cd ../shared/...` and consume its fixtures at the right revision.

## 8. Anti-patterns

- **Literal shell strings instead of structural references.** `{ run: "npm run build" }` works but loses validator coverage and breaks when the command rotates. Prefer `{ component, command }`.
- **Copy-paste step bodies across phases.** Use `phase:` to parallelize and structural references to share command definitions.
- **Over-broad `expect: failure`.** It's for TDD reproducing-tests where the gate must demonstrate the bug. Don't use it to paper over a flaky build.
- **`{{project.X}}` tokens in command shapes.** Removed; replaced by `{ component, command }`. The migration rewrites known usages on first server boot.
- **Pure `{ run }` steps that pretend to be component-scoped.** If a step belongs to a component, link it: `{ component, run }` so the working directory is correct.
- **Data-only components with workflow steps.** A component with no `commands` cannot be referenced by a structural step. The validator rejects this at load time.
