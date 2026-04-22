# Goals, Workflows, Tasks & Gates

This document explains how Bobbit's goal orchestration system works — how goals, workflows, tasks, and gates relate to each other, and how context flows between agents.

## Concepts

### Goals

A **goal** is a unit of work with a title, spec (markdown), working directory, and state (`todo` | `in-progress` | `complete` | `shelved`). Every goal is scoped to a registered project via its `projectId` field (see [internals.md — Multi-project architecture](internals.md#multi-project-architecture)). Worktrees are created relative to that project's `rootPath`.

`POST /api/goals` requires the caller to identify the project: either an explicit `projectId` in the request body, or a `cwd` matching a registered project's `rootPath`. There is no default-project fallback — a request with neither resolvable returns **400**. See the [Project resolution contract](rest-api.md#project-resolution-contract) in the REST API docs for the exact error shape.

Goals can run in **team mode**, where a Team Lead agent orchestrates multiple role agents (coders, reviewers, testers) working concurrently in their own worktrees. Goals carry an `autoStartTeam` flag (defaults to `true`). When enabled, the server automatically calls `teamManager.startTeam()` after worktree setup completes — no manual "Start Team" click needed. If auto-start fails but the worktree succeeded, the error is logged and the worktree remains usable; the user can start the team manually. The retry-setup handler also respects this flag.

### Workflows

A **workflow** is a reusable template that defines which gates a goal must pass, their dependency relationships (a DAG), and verification configs. Workflows are stored as YAML files in `defaults/workflows/`.

When a goal is created with a `workflowId`, the entire workflow is **snapshotted** into `PersistedGoal.workflow`. This frozen copy is immune to later template edits — the goal's requirements are locked at creation time.

Goals without workflows still work fine — workflows are optional.

#### Workflow data model

```typescript
interface VerifyStep {
  name: string;
  type: "command" | "llm-review" | "agent-qa";
  run?: string;       // Shell command (for type: "command")
  prompt?: string;    // Review/QA prompt (for type: "llm-review" or "agent-qa")
  expect?: "success" | "failure";
  timeout?: number;
  phase?: number;     // Execution phase (default 0). See "Phased verification" below.
  optional?: boolean; // If true, step runs only when enabled per-goal. See "Optional verify steps".
  label?: string;     // Human-readable label for the toggle in goal creation UI.
  description?: string; // Tooltip text shown as ⓘ icon next to the toggle. For agent-qa steps, overridden when qa_start_command is missing.
}

interface WorkflowGate {
  id: string;              // Unique within this workflow, e.g. "design-doc"
  name: string;            // Display name
  dependsOn: string[];     // Other gate IDs within THIS workflow (the DAG)
  content?: boolean;       // Whether this gate accepts markdown content
  injectDownstream?: boolean; // Whether passed content is injected into downstream agents
  metadata?: Record<string, string>; // Key-value metadata schema
  optional?: boolean;      // If true, team lead may signal with "N/A" (still must be signaled)
  verify?: VerifyStep[];   // Verification steps to run on signal
}

interface Workflow {
  id: string;
  name: string;
  description: string;
  gates: WorkflowGate[];
  createdAt: number;
  updatedAt: number;
}
```

#### Workflow YAML format

Workflows are defined in `defaults/workflows/<id>.yaml`:

```yaml
id: general
name: General
description: Lightweight workflow for general-purpose goals

gates:
  - id: design-doc
    name: Design Document
    content: true
    inject_downstream: true
    verify:
      - name: "Design quality"
        type: llm-review
        prompt: |
          Review this design document. Verify:
          1. Approach is clearly described
          2. File changes are listed
          3. Acceptance criteria are specific and testable

  - id: implementation
    name: Implementation
    depends_on: [design-doc]
    verify:
      - name: "Type check passes"
        type: command
        run: "npm run check"
        # phase: 0 (implicit default)
      - name: "Code review"
        type: llm-review
        phase: 1           # Runs only after phase-0 steps pass
        prompt: |
          Review the implementation for correctness, completeness, and code quality.

  - id: ready-to-merge
    name: Ready to Merge
    depends_on: [implementation]
    verify:
      - name: "All gates passed"
        type: command
        run: "echo 'All upstream gates passed'"
```

#### Dependency DAG

Each gate's `dependsOn` lists sibling gate IDs that must pass before it can be signaled. This serves two purposes:

1. **Signal gating** — the server returns 409 if you try to signal a gate before its dependencies have passed.
2. **Context injection** — when an agent is spawned to produce work for a gate, the passed content of upstream gates is automatically injected into the agent's system prompt.

### Gate states

Each gate has a status: `pending`, `passed`, or `failed`.

- **`pending`** — initial state; the gate has not been signaled, or was reset after an upstream re-signal.
- **`passed`** — the gate was signaled and all verification steps succeeded (or no verification was defined).
- **`failed`** — the gate was signaled but verification failed.

When a previously-passed gate is re-signaled, all transitive downstream gates are cascade-reset to `pending`.

### Signaling a gate

Agents signal gates via the `gate_signal` tool (or `POST /api/goals/:id/gates/:gateId/signal`). A signal can include:

- **Content** — markdown text (for content gates like design docs)
- **Metadata** — key-value pairs (for metadata gates like test results)

Each signal is recorded in the gate's signal history with a unique ID, timestamp, and session reference.

### Verification

Gates can define automated verification that runs when signaled:

- **Command** — runs shell commands, checks exit codes (e.g. `npm run check`)
- **LLM review** — spawns a sub-agent for qualitative review against a prompt
- **Agent QA** — spawns a test-engineer session that drives browser-based QA testing via the `/qa-test` skill
- **Combined** — mechanical + qualitative steps across phases

Verification is async. On signal, the verification status is `"running"`. On completion: the gate transitions to `"passed"` (all steps pass) or `"failed"` (any step fails, with details). A WebSocket event `gate_verification_complete` is emitted. If no verification is defined, the gate auto-passes.

#### Gate verification baselines

A gate's **baseline** is the git reference the reviewer diffs `HEAD` against when deciding what to comment on. Choosing the right baseline matters: too broad and the reviewer critiques upstream work that another agent already merged; too narrow and real goal-branch changes slip through unreviewed. It is also the single biggest source of false-positive "branch doesn't match design doc" findings when it drifts.

Gate verification is **baseline-aware** — different gate kinds compare against different git references:

| Gate kind              | Baseline                                  | How it's detected                     |
|------------------------|-------------------------------------------|---------------------------------------|
| Pre-implementation     | None — no diff is run                     | `content: true` AND no `depends_on` (see `isPreImplementationGate` in `src/server/agent/verification-logic.ts`) |
| Implementation & later | `origin/<primary>...HEAD`                 | All other verify-bearing gates        |
| `ready-to-merge`       | `origin/<primary>` via `git merge-base`   | Hardcoded in workflow YAML            |

**Why `origin/<primary>` and not local `<primary>`:** local refs are only as fresh as the last `git pull` on the host. Goal worktrees are created from `origin/<primary>`; verification must diff against the same anchor or it surfaces commits that have already been merged upstream as if they were goal-unique work. The harness runs `git fetch origin <primary>` before each review so `origin/<primary>` is current.

**Why pre-implementation gates skip the diff entirely:** a design-doc or issue-analysis gate, by workflow construction, runs before any code is committed. A branch with zero goal-unique commits is the normal expected state. Running a diff produces noise at best, and — if local `<primary>` is stale — false positives at worst. The reviewer prompt explicitly forbids `git diff` / `git log` for these gates.

**Primary branch detection:** the harness calls `detectPrimaryBranch(cwd)` from `src/server/skills/git.ts`, which uses `git symbolic-ref refs/remotes/origin/HEAD` with a `master` → `main` fallback. Never hardcode `"master"` in new gate logic — always resolve via this helper. The resolved baseline (e.g. `origin/main@abc1234`) is printed into every review prompt's "Signal Context" so failures are trivial to diagnose.

**How the harness enforces this per-gate:** reviewer/architect/spec-auditor role YAMLs contain a `{{REVIEW_CONTEXT}}` placeholder in their preamble. `buildReviewPrompt()` in `src/server/agent/verification-harness.ts` substitutes it with either (a) an "implementation review" block containing the concrete `origin/<primary>...HEAD` diff instructions and the resolved baseline SHA, or (b) a "pre-implementation" notice that explicitly forbids `git diff` / `git log` and reminds the reviewer that zero goal-unique commits is the normal state. The branching decision uses `isPreImplementationGate()` on the signalled gate — role YAMLs never hardcode diff commands.

**Migration note for user-authored workflow YAMLs in `.bobbit/config/workflows/`:** the harness resolves `{{master}}` to the dynamically-detected primary branch, but the `origin/` prefix is now injected only by built-in YAMLs (the ones in `defaults/workflows/`). User overrides that still say `{{master}}...HEAD` (without `origin/`) will diff against the local ref. To get the full RC1 fix, rewrite those references to `origin/{{master}}...HEAD` in your override. Pre-implementation gates in user overrides automatically benefit from the RC2 fix regardless, because that logic lives in the harness's review-prompt builder.

#### Phased verification

Verification steps have an optional `phase` field (integer, default 0). Steps are grouped by phase and phases execute **sequentially** in ascending order. Within each phase, steps run in **parallel** (preserving pre-phase behavior for phase-0 steps).

If any step in a phase fails, all subsequent phases are skipped immediately and the gate fails. Skipped steps are recorded with `skipped: true` on `GateSignalStep` and output `"Skipped — earlier phase failed"`. The `skipped` flag persists to disk so the UI can distinguish skipped steps from passed/failed ones after page reload.

This avoids wasting expensive LLM reviews (phase 1) when cheap command checks (phase 0) have already failed. In the built-in `feature` and `bug-fix` workflows, type-checking and tests run at phase 0, while code quality and security reviews run at phase 1.

```yaml
verify:
  - name: "Type check"
    type: command
    run: "npm run check"
    # phase: 0 (default — runs first)

  - name: "Unit tests"
    type: command
    run: "npm run test:unit"
    # phase: 0

  - name: "Code quality review"
    type: llm-review
    phase: 1              # Only runs if all phase-0 steps pass
    prompt: |
      Review for correctness, completeness, and code quality.
```

**Backward compatibility:** Steps without a `phase` field default to phase 0. Existing workflows and snapshotted goal workflows continue to work — all steps execute in parallel as before.

**WebSocket events:** The server broadcasts `gate_verification_phase_started` before each phase begins, including the phase number and which step indices belong to it. Step-level events (`gate_verification_step_started`, `gate_verification_step_complete`) include an optional `phase` field. The goal dashboard uses these to show phase progression in real time.

#### Verification step artifacts

Step results can carry an optional `artifact` containing rich content that would be too large or structured for the short `output` summary field.

```typescript
interface GateSignalStep {
  name: string;
  type: string;
  passed: boolean;
  skipped?: boolean;         // true when step was skipped (optional not enabled, or earlier phase failed)
  output: string;            // Short summary
  duration_ms: number;
  artifact?: {
    content: string;         // Full report body
    contentType: string;     // "text/markdown" | "text/html"
    metadata?: Record<string, string>;
  };
}
```

**LLM review artifacts:** When an `llm-review` step completes, the verification harness stores the reviewer's full analysis as a `text/markdown` artifact. The `output` field retains the short summary, while the artifact preserves the complete review text that was previously lost.

**Size limit:** Artifact content is capped at 10 MB. Content exceeding this limit is truncated.

**Dashboard rendering:** The goal dashboard renders artifacts based on their content type:
- **`text/markdown`** — shown inline in a collapsible "Full Review" section below the step result.
- **`text/html`** — a "View Report" button opens the HTML content in a new browser tab via a Blob URL.
- **Metadata** — if `artifact.metadata` is present, key-value pairs are displayed alongside the content.

#### Optional verify steps

Verify steps can be marked `optional: true` with a human-readable `label` for the UI toggle. Optional steps are **disabled by default** — they only run when explicitly enabled for a specific goal. Steps can also include a `description` string, which renders as an ⓘ tooltip icon next to the toggle. For `agent-qa` steps, the toggle is automatically greyed out when the project lacks `qa_start_command`, and the tooltip is overridden with a configuration hint.

**How it works:**
- Goals carry an `enabledOptionalSteps: string[]` field listing the `name` values of optional steps that should be active.
- At goal creation, the UI shows a checkbox for each optional step in the selected workflow. The goal assistant can pre-toggle steps via the `options` parameter (comma-separated step names) in its `propose_goal` tool call.
- During verification, the harness checks each step before phase grouping. If `step.optional === true` and the step's `name` is not in the goal's `enabledOptionalSteps`, the step is skipped with `{ passed: true, skipped: true, output: "Skipped — not enabled for this goal" }`.
- Skipped optional steps do not block the gate and do not affect phase pass/fail logic.

**Example in workflow YAML:**
```yaml
verify:
  - name: "Type check"
    type: command
    run: "npm run check"

  - name: "QA testing"
    type: agent-qa
    phase: 2
    optional: true
    label: "Enable QA Testing"
    description: "Spawn a QA agent that builds the project, starts an ephemeral server, and drives a real browser through user scenarios."
    prompt: |
      You are performing QA testing for this goal...
```

#### `agent-qa` step type

The `agent-qa` verification step type spawns a test-engineer agent session that performs automated QA testing. It is designed for browser-based validation of user-facing changes, using the `/qa-test` skill to manage an ephemeral environment.

**How it works:**
1. The harness spawns a test-engineer session with the step's `prompt` (after variable substitution with `{{goal_spec}}`, `{{branch}}`, etc.) and upstream gate content injected as context.
2. The agent uses the `/qa-test` skill to stand up an ephemeral server, drive browser scenarios, and produce an HTML report.
3. The agent calls the `verification_result` tool to deliver structured results: verdict (pass/fail), summary, and optional HTML report.
4. If the agent includes `report_html`, the HTML is stored as the step's artifact with `contentType: "text/html"`.
5. If the agent goes idle without calling the tool, the harness sends a reminder prompt. If idle again, the step fails.

**Timeout:** Reads `qa_max_duration_minutes` from project config (default 10) plus a 5-minute buffer for setup/teardown.

**Retry logic:** Up to 3 attempts with backoff on transient failures (same pattern as `llm-review`).

**Test environments:** Respects `BOBBIT_LLM_REVIEW_SKIP` — when set, `agent-qa` steps auto-pass without spawning an agent.

**Resume support:** If the server restarts during an `agent-qa` step, the harness re-executes the step from scratch on the next verification cycle.

The `agent-qa` step typically runs at phase 2 in the `feature` and `bug-fix` workflows — after command checks (phase 0) and LLM reviews (phase 1) have passed. See [QA Testing](qa-testing.md) for project configuration and the `/qa-test` skill protocol.

### Gate Re-Signal Cancellation

When a gate is re-signaled while a previous verification is still running:
- The in-flight verification is cancelled — its reviewer sessions are terminated and its results are suppressed
- The cancelled signal's verification status is persisted as `"failed"` in the gate store
- Only the latest signal's verification determines the gate's pass/fail status
- The team lead is not notified about superseded verification results
- Command steps that are already running will complete but their results won't update gate status

This prevents reviewer agent proliferation when gates are re-signaled multiple times. The cancellation is triggered by `cancelStaleVerifications()` in `verification-harness.ts`, which is called before starting a new verification in the gate signal handler.

**Zombie detection:** If the previous verification's reviewer sessions have all died (crashed, timed out), the server detects this via `areVerificationSessionsAlive()` and auto-cancels the zombie verification instead of returning a 409 duplicate error. This prevents deadlocks where a stuck verification blocks all future signals.

**Manual cancellation:** A stuck verification can also be cancelled via `POST /api/goals/:goalId/gates/:gateId/cancel-verification`. The goal dashboard shows a Cancel button in the signal entry header when a verification is in "running" state. The endpoint is idempotent — calling it when nothing is running returns `{ cancelled: false }`.

### Tasks

**Tasks** are the operational work items within a goal. They track what needs to be done, who's doing it, and what state it's in.

Tasks have a state machine: `todo` → `in-progress` → `complete` | `skipped` | `blocked`.

Tasks can declare:
- **`dependsOn`** — other task IDs that must complete first (advisory, not enforced)
- **`workflowGateId`** — which workflow gate this task should produce output for
- **`inputGateIds`** — which workflow gate IDs to inject as context when prompting the assigned agent

#### Git handoff fields

Tasks carry structured git fields that enable local-only merges between agents, eliminating the need for PR-based inter-agent handoffs:

- **`baseSha`** — the commit the agent started from. Auto-populated by the system when a task is assigned to a spawned agent (resolved from `git rev-parse HEAD` in the agent's worktree).
- **`headSha`** — the tip of the agent's finished work. Set by the agent on completion via `task_update(head_sha="...")`.
- **`branch`** — the agent's working branch name. Auto-populated by the system from the `TeamAgent` record when a task is assigned.

These fields replace the old `commitSha` field, which was a single optional field with ambiguous semantics. The `baseSha` + `headSha` pair precisely defines the agent's changeset, and `branch` gives the team lead a direct local ref to merge from.

**Why local merges?** Agents work in co-located git worktrees on the same machine. Routing merges through origin (via PRs) added latency, created orphaned PRs, and introduced a fragile parsing step where the team lead had to extract branch names from free-text summaries. Local merges are instant and deterministic.

#### Git handoff lifecycle

| When | Who | What |
|------|-----|------|
| `team_spawn` | System | Auto-populates `baseSha` (HEAD at spawn) and `branch` (agent's branch name) on the `TeamAgent` record |
| Task assignment | System | Copies `baseSha` and `branch` from the `TeamAgent` to the assigned task |
| Agent works | Agent | Commits normally on its branch |
| Agent finishes | Agent | `task_update(state="complete", head_sha="$(git rev-parse HEAD)", result_summary="...")` |
| Team lead merges | Team lead | `git merge <task.branch>` locally — no remote fetch needed |
| Cleanup | Team lead | `team_dismiss` cleans up the agent's worktree |

Agents still push to origin as a safety net (crash recovery, inspection), but the merge path is purely local. The only PR in the workflow is the final goal-to-primary-branch PR for human review.

Tasks and workflows are complementary layers:
- **Workflows** = quality layer (what gates to pass, in what order, with what verification)
- **Tasks** = operational layer (who's doing what, status tracking, assignment)

## Context injection

Context injection is the mechanism that feeds passed upstream gate content into agent prompts. This is how the design doc shapes the implementation, and the issue analysis feeds the reproducing test.

### At spawn time (`team_spawn`)

When spawning an agent via `team_spawn`, you can pass:

- **`workflowGateId`** (0 or 1) — declares which workflow gate the agent should produce output for. If `inputGateIds` is not set, the server auto-resolves inputs from the DAG's `dependsOn`.
- **`inputGateIds`** (0 or more) — explicit list of workflow gate IDs whose passed content to inject. Overrides automatic DAG resolution.

The resolved gate content is injected into the agent's **system prompt** under a `# Upstream Gates` section.

**Examples:**
```
# Auto-resolve from DAG (implementation depends on design-doc):
team_spawn(role="coder", task="Implement the fix", workflowGateId="implementation")

# Explicit inputs (reviewer needs more context than the formal DAG requires):
team_spawn(role="reviewer", task="Review the fix",
  workflowGateId="code-review",
  inputGateIds=["design-doc", "implementation", "test-results"])
```

### At prompt time (`team_prompt`)

When prompting an existing agent with new work via `team_prompt`, you can pass the same parameters:

- **`workflowGateId`** (optional) — what the agent should produce next
- **`inputGateIds`** (optional) — which gate content to inject as context

The resolved gate content is **prepended to the prompt message**, so the agent receives fresh context for the new task without needing to be respawned.

**Example:**
```
team_prompt(session_id="abc", message="Now review the implementation",
  workflowGateId="code-review",
  inputGateIds=["design-doc", "implementation", "test-results"])
```

### On gate signal (`gate_signal`)

When signaling a gate, the server checks that all upstream dependencies have passed. If any upstream gate has not passed, the signal is rejected with a 409 response listing the missing dependency.

## How it all fits together

Here's the typical flow for a team goal with a workflow:

```
1. User creates a goal with workflowId="general"
   → Server snapshots the workflow into the goal
   → Gate states initialized: design-doc=pending, implementation=pending, ready-to-merge=pending

2. Team Lead reads the workflow, sees the gate DAG:
   design-doc → implementation → ready-to-merge

3. Team Lead creates tasks linked to workflow gates:
   task_create(title="Write design doc", type="custom",
     workflowGateId="design-doc")

4. Team Lead spawns an agent with gate context:
   team_spawn(role="coder", task="Write design doc",
     workflowGateId="design-doc")
   → Agent gets the goal spec in its system prompt (no upstream deps for first gate)

5. Agent produces the design and signals the gate:
   gate_signal(gate_id="design-doc", content="# Design\n\n...")
   → Server runs verification (if configured) → gate status: passed

6. Team Lead spawns next agent with upstream context:
   team_spawn(role="coder", task="Implement the design",
     workflowGateId="implementation")
   → Agent receives the passed design-doc content in its system prompt

7. Agent completes implementation and signals:
   gate_signal(gate_id="implementation")
   → Verification runs (npm run check + LLM review) → gate status: passed

8. Process continues through the DAG until all gates pass

9. team_complete() — server verifies all workflow gates have passed
```

## REST API reference

### Workflows

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workflows` | List all workflow templates |
| `GET` | `/api/workflows/:id` | Get full workflow detail |
| `POST` | `/api/workflows` | Create a workflow |
| `PUT` | `/api/workflows/:id` | Update a workflow |
| `DELETE` | `/api/workflows/:id` | Delete (blocked if in-use by active goals) |
| `POST` | `/api/workflows/:id/clone` | Deep-copy a workflow with a new ID |

### Gates

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/goals/:id/gates` | List all gates for a goal with status and definitions |
| `GET` | `/api/goals/:id/gates/:gateId` | Get gate detail (status, signals, definition) |
| `GET` | `/api/goals/:id/gates/:gateId/inspect` | Scoped gate data retrieval — content, verification, or signal history |
| `POST` | `/api/goals/:id/gates/:gateId/signal` | Signal a gate — triggers verification |
| `GET` | `/api/goals/:id/gates/:gateId/signals` | Get signal history for a gate |
| `GET` | `/api/goals/:id/gates/:gateId/content` | Get the current passed content of a gate |
| `POST` | `/api/goals/:id/gates/:gateId/cancel-verification` | Cancel a stuck running verification (idempotent) |
| `GET` | `/api/goals/:id/verifications/active` | Get in-flight verification state (running steps, sessions) |

The gate list, gate detail, and task list endpoints support `?view=summary` for slim agent-facing responses. See [rest-api.md — Summary views](rest-api.md#summary-views-viewsummary) for response shapes and the [Gate inspect endpoint](rest-api.md#gate-inspect-endpoint) for the `/inspect` endpoint.

### Tasks (gate-linked)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/goals/:id/tasks` | Create task — accepts `workflowGateId` and `inputGateIds` |
| `PUT` | `/api/tasks/:id` | Update task — accepts `workflowGateId` and `inputGateIds` |

### Team (context injection)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/goals/:id/team/spawn` | Spawn agent — `workflowGateId` + `inputGateIds` for context injection |
| `POST` | `/api/goals/:id/team/prompt` | Prompt agent — `workflowGateId` + `inputGateIds` prepended to message |

## Storage

State is per-project — each project has its own copies of these files in `<project-root>/.bobbit/state/`. The server aggregates across all projects via `ProjectContextManager`.

| Location | What |
|---|---|
| `defaults/workflows/*.yaml` | Workflow templates (repo-local, version controlled) |
| `<project>/.bobbit/state/goals.json` | Goals with snapshotted workflows (includes `projectId`) |
| `<project>/.bobbit/state/gates.json` | Gate state and signal history |
| `<project>/.bobbit/state/tasks.json` | Tasks with workflow gate links |

## Key source files

| File | Purpose |
|---|---|
| `src/server/agent/workflow-store.ts` | YAML persistence for workflow templates |
| `src/server/agent/workflow-manager.ts` | Workflow CRUD, DAG validation, cloning |
| `src/server/agent/verification-harness.ts` | Async verification orchestration (command + LLM review + agent-qa, session lifecycle, artifact population) |
| `src/server/agent/verification-logic.ts` | Pure verification logic — variable substitution, phase grouping, optional step skipping, cache reuse, error pattern matching (unit-testable without server state) |
| `src/server/agent/gate-store.ts` | Gate state and signal history persistence |
| `src/server/agent/task-store.ts` | Task persistence with `workflowGateId` and `inputGateIds` |
| `src/server/agent/team-manager.ts` | Context injection via `buildDependencyContext()` |
| `src/server/agent/system-prompt.ts` | System prompt assembly including gate context |
| `defaults/tools/tasks/extension.ts` | Agent tools: `gate_signal`, `gate_status`, `gate_list`, `gate_inspect`, `task_create` |
| `defaults/tools/team/extension.ts` | Agent tools: `team_spawn`, `team_prompt` with context injection |
| `defaults/roles/team-lead.yaml` | Team Lead prompt template (workflow-aware) |
| `defaults/workflows/general.yaml` | Seed workflow: general-purpose lifecycle |
