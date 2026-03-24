# Goals, Workflows, Tasks & Gates

This document explains how Bobbit's goal orchestration system works — how goals, workflows, tasks, and gates relate to each other, and how context flows between agents.

## Concepts

### Goals

A **goal** is a unit of work with a title, spec (markdown), working directory, and state (`todo` | `in-progress` | `complete` | `shelved`). Goals optionally create a dedicated git worktree for isolated work.

Goals can run in **team mode**, where a Team Lead agent orchestrates multiple role agents (coders, reviewers, testers) working concurrently in their own worktrees.

### Workflows

A **workflow** is a reusable template that defines which gates a goal must pass, their dependency relationships (a DAG), and verification configs. Workflows are stored as YAML files in `.bobbit/config/workflows/`.

When a goal is created with a `workflowId`, the entire workflow is **snapshotted** into `PersistedGoal.workflow`. This frozen copy is immune to later template edits — the goal's requirements are locked at creation time.

Goals without workflows still work fine — workflows are optional.

#### Workflow data model

```typescript
interface VerifyStep {
  name: string;
  type: "command" | "llm-review";
  run?: string;       // Shell command (for type: "command")
  prompt?: string;    // Review prompt (for type: "llm-review")
  expect?: "success" | "failure";
  timeout?: number;
}

interface WorkflowGate {
  id: string;              // Unique within this workflow, e.g. "design-doc"
  name: string;            // Display name
  dependsOn: string[];     // Other gate IDs within THIS workflow (the DAG)
  content?: boolean;       // Whether this gate accepts markdown content
  injectDownstream?: boolean; // Whether passed content is injected into downstream agents
  metadata?: Record<string, string>; // Key-value metadata schema
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

Workflows are defined in `.bobbit/config/workflows/<id>.yaml`:

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
      - name: "Code review"
        type: llm-review
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
- **Combined** — mechanical + qualitative steps in sequence

Verification is async. On signal, the verification status is `"running"`. On completion: the gate transitions to `"passed"` (all steps pass) or `"failed"` (any step fails, with details). A WebSocket event `gate_verification_complete` is emitted. If no verification is defined, the gate auto-passes.

### Tasks

**Tasks** are the operational work items within a goal. They track what needs to be done, who's doing it, and what state it's in.

Tasks have a state machine: `todo` → `in-progress` → `complete` | `skipped` | `blocked`.

Tasks can declare:
- **`dependsOn`** — other task IDs that must complete first (advisory, not enforced)
- **`workflowGateId`** — which workflow gate this task should produce output for
- **`inputGateIds`** — which workflow gate IDs to inject as context when prompting the assigned agent

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
| `POST` | `/api/goals/:id/gates/:gateId/signal` | Signal a gate — triggers verification |
| `GET` | `/api/goals/:id/gates/:gateId/signals` | Get signal history for a gate |
| `GET` | `/api/goals/:id/gates/:gateId/content` | Get the current passed content of a gate |

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

| Location | What |
|---|---|
| `.bobbit/config/workflows/*.yaml` | Workflow templates (repo-local, version controlled) |
| `.bobbit/state/goals.json` | Goals with snapshotted workflows |
| `.bobbit/state/gates.json` | Gate state and signal history |
| `.bobbit/state/tasks.json` | Tasks with workflow gate links |

## Key source files

| File | Purpose |
|---|---|
| `src/server/agent/workflow-store.ts` | YAML persistence for workflow templates |
| `src/server/agent/workflow-manager.ts` | Workflow CRUD, DAG validation, cloning |
| `src/server/agent/verification-harness.ts` | Async verification (command + LLM review) |
| `src/server/agent/gate-store.ts` | Gate state and signal history persistence |
| `src/server/agent/task-store.ts` | Task persistence with `workflowGateId` and `inputGateIds` |
| `src/server/agent/team-manager.ts` | Context injection via `buildDependencyContext()` |
| `src/server/agent/system-prompt.ts` | System prompt assembly including gate context |
| `.bobbit/extensions/goal-tools.ts` | Agent tools: `gate_signal`, `gate_status`, `gate_list`, `task_create` |
| `.bobbit/extensions/team-lead-tools.ts` | Agent tools: `team_spawn`, `team_prompt` with context injection |
| `.bobbit/config/roles/team-lead.yaml` | Team Lead prompt template (workflow-aware) |
| `.bobbit/config/workflows/general.yaml` | Seed workflow: general-purpose lifecycle |
