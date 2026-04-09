# Design: QA Testing as a Verification Step

## Problem

The current QA testing implementation uses a standalone workflow gate (`qa-testing`) positioned between `implementation` and `documentation`. This creates an iteration problem: if QA finds a bug, the coder needs to change implementation code, but the `implementation` gate is already passed and frozen. There's no mechanism to invalidate it, so the workflow fights against the natural fix-and-retest cycle.

Additionally, the standalone gate requires the team lead to manually decide whether to run QA, spawn a test-engineer, and coordinate the handoff. This adds orchestration overhead to every goal.

## Solution

Replace the standalone `qa-testing` gate with a phased verification step on the `implementation` gate. QA testing becomes an automated verification check — just like type-checking and unit tests — that runs after cheaper checks pass. If QA fails, the implementation gate fails, the coder iterates, and re-signaling restarts the full verification pipeline.

## Design decisions

### 1. Phased verification

**Current state:** All verification steps on a gate run in parallel via `Promise.all()`.

**Change:** Add an optional `phase` field (integer, default 0) to `VerifyStep`. Steps within the same phase run in parallel. Phases run sequentially in ascending order. If any step in a phase fails, subsequent phases are skipped and the gate fails immediately.

```yaml
verify:
  - name: "Type check"
    type: command
    run: "{{project.typecheck_command}}"
    # phase: 0 (implicit default)

  - name: "Unit tests"
    type: command
    run: "{{project.test_unit_command}}"
    # phase: 0

  - name: "E2E tests"
    type: command
    run: "{{project.test_e2e_command}}"
    # phase: 0

  - name: "Code quality review"
    type: llm-review
    phase: 1
    prompt: |
      ...

  - name: "QA testing"
    type: agent-qa
    phase: 2
    optional: true
    label: "Enable QA Testing"
    prompt: |
      ...
```

Phase 0 (type-check, tests) runs first. If any fail, the gate fails immediately — phases 1 and 2 never start. Phase 1 (code reviews) runs next. Phase 2 (QA) runs only after everything else passes.

**Implementation:** In `VerificationHarness.verifyGateSignal()`, group steps by phase, sort phases ascending, and iterate with early-exit on failure. Within each phase, existing parallel execution is preserved.

### 2. Verification step artifacts

**Current state:** Step results store `{ passed: boolean, output: string }` where `output` is a short text summary.

**Change:** Add an optional `artifact` field to verification step results for rich content (full code reviews, HTML QA reports with screenshots).

```typescript
// In gate-store.ts — GateSignalStep
interface GateSignalStep {
  name: string;
  type: string;
  passed: boolean;
  output: string;              // short summary (existing)
  duration_ms?: number;
  expect?: string;
  artifact?: {                 // NEW
    content: string;           // full report body
    contentType: string;       // "text/markdown" | "text/html"
    metadata?: Record<string, string>;
  };
}
```

For `llm-review` steps, the reviewer's full analysis becomes the artifact (currently this detail is lost — only the truncated `output` is stored). For `agent-qa` steps, the HTML report with base64-embedded screenshots becomes the artifact.

**Size limit:** 10 MB per artifact. The harness enforces this before storage.

**Dashboard UI:** The goal dashboard's `renderSignalEntry()` already renders step output. It gains an "artifact" section: for `text/markdown`, render inline; for `text/html`, render in an iframe or provide a "View report" link that opens in a new tab. Artifact metadata is shown as key-value pairs alongside the step result.

### 3. New verification step type: `agent-qa`

A new step type that spawns a test-engineer agent to stand up an ephemeral environment, drive browser scenarios, and produce an HTML evidence report.

**Workflow YAML syntax:**

```yaml
- name: "QA testing"
  type: agent-qa
  phase: 2
  optional: true
  label: "Enable QA Testing"
  prompt: |
    You are performing QA testing for this goal. Your job is to verify the implementation
    works correctly by driving a real browser through user scenarios.

    Use the /qa-test skill to stand up an ephemeral environment and execute scenarios.

    The goal spec is:
    {{goal_spec}}

    Derive test scenarios from the goal spec and design document. Prioritise:
    1. Core functionality described in the acceptance criteria
    2. Edge cases mentioned in the spec
    3. Visual/layout correctness for UI changes
    4. Interaction flows (click, type, navigate, verify)

    If the user included explicit QA criteria in the goal spec, prioritise those.

    Evidence requirements:
    - Every scenario MUST include at least one screenshot showing the result
    - A textual description alone is NOT sufficient
    - Use before/after screenshots to demonstrate state changes

    Produce a self-contained HTML report with base64-embedded screenshots following
    the template in the /qa-test skill.

    Return your verdict:
    - <verdict>pass</verdict> if all scenarios pass and the implementation meets the spec
    - <verdict>fail</verdict> if any scenario fails or the implementation contradicts the spec
```

**Harness execution:** The `agent-qa` step reuses the session-based reviewer spawning from `llm-review`, but with key differences:

| Aspect | `llm-review` | `agent-qa` |
|--------|-------------|------------|
| Role | `reviewer` | `test-engineer` |
| Tools | Read-only (read, grep, bash) | Full tools + browser (Playwright MCP) + `/qa-test` skill |
| Timeout | Default (5 min) | `qa_max_duration_minutes` + 5 min buffer |
| Output parsing | `<verdict>` tag | `<verdict>` tag + HTML artifact extraction |
| Context injection | Signal content + upstream gates | Goal spec + upstream gate content (design doc, implementation diff) |

**Artifact extraction:** After the agent finishes, the harness searches the agent's output for the HTML report. The agent writes it to a known path or emits it in a structured block (e.g. `<qa_report>...</qa_report>`). The harness extracts this as the step's artifact with `contentType: "text/html"`.

### 4. Optional steps with goal-level toggles

**Workflow YAML:** Steps can declare `optional: true` with a `label` for UI display.

```yaml
- name: "QA testing"
  type: agent-qa
  optional: true
  label: "Enable QA Testing"
```

**Goal creation UI:** When the user picks a workflow from the dropdown, the UI reads the workflow's steps, finds those with `optional: true`, and renders toggles to the right of the dropdown:

```
Workflow: [Feature ▾]    ☐ Enable QA Testing
```

Toggles default to **off**. The user explicitly opts in per goal.

**Goal proposal format:** The `propose_goal` tool call accepts an optional `options` parameter:

```json
{
  "title": "Add dark mode toggle",
  "workflow": "feature",
  "options": "qa-testing",
  "spec": "..."
}
```

The `options` field contains a comma-separated list of optional step names that should be enabled. The goal assistant can recommend enabling QA when the goal involves UI changes.

**Storage:** The goal's `PersistedGoal` gains a new field:

```typescript
interface PersistedGoal {
  // ... existing fields ...
  /** Names of optional verification steps enabled for this goal */
  enabledOptionalSteps?: string[];
}
```

When the workflow is snapshotted onto the goal, `enabledOptionalSteps` is populated from the toggle state. The verification harness checks this list before running optional steps — if a step is `optional: true` and its name is not in `enabledOptionalSteps`, it is skipped with an auto-pass result ("Skipped — not enabled for this goal").

**Project config still matters for capability:** The `qa_start_command` project config key determines whether QA testing is *possible* for a project. The UI can use this to grey out / add a tooltip to the toggle: "Configure qa_start_command in project settings to enable". But the toggle is always the activation mechanism — config alone doesn't activate QA.

### 5. QA scenario sourcing

The QA agent derives scenarios **autonomously** from available context:

1. **Goal spec** — acceptance criteria, described behavior, edge cases
2. **Design document** — from the design-doc gate content (injected via upstream gate dependencies)
3. **Implementation diff** — the agent can run `git diff` to see what changed

No manual scenario definition is required. If the user wants specific scenarios tested, they include them in the goal spec (e.g. "QA must verify: (1) toggle appears, (2) state persists after reload"). The QA agent prioritises explicit criteria when present.

The goal assistant may recommend QA scenarios in the spec when it identifies UI-facing changes, but this is advisory — the QA agent makes its own decisions about what to test.

### 6. Success criteria and evidence requirements

Defined in the `agent-qa` step's prompt template (in the workflow YAML), not left to agent discretion.

**Pass criteria:**
- Every scenario includes at least one screenshot showing the result
- Observed behavior matches the goal spec / design doc intent
- No visual regressions in areas adjacent to the change

**Fail criteria:**
- Observed behavior contradicts the goal spec
- A feature described in the goal spec is missing or broken
- The UI is visually broken (layout collapse, overlapping elements, unreadable text)

**Evidence requirements:**
- Screenshots are mandatory — every scenario needs visual proof. Textual descriptions alone are insufficient because the purpose of QA testing is catching visual/interaction issues that automated tests miss.
- The report follows the HTML template from the `/qa-test` skill with base64-embedded screenshots.
- Each scenario has: description, steps taken, screenshots, and a PASS/FAIL verdict with explanation.

**No secondary LLM review:** The QA agent's verdict is final. The old model had an LLM reviewer checking the QA report — this adds cost and latency for little value since the QA agent already exercised judgment during live browser interaction.

## Workflow changes

### Before (current)

```
feature.yaml gates:
  design-doc → implementation → qa-testing → documentation → ready-to-merge
```

`qa-testing` is a standalone gate. The team lead decides whether to run it, spawns a test-engineer, and the agent signals the gate.

### After (proposed)

```
feature.yaml gates:
  design-doc → implementation → documentation → ready-to-merge
```

The `qa-testing` gate is removed. QA testing becomes a phase-2 verification step on the `implementation` gate:

```yaml
- id: implementation
  name: Implementation
  depends_on: [design-doc]
  verify:
    # Phase 0 — fast automated checks (parallel)
    - name: "Type check passes"
      type: command
      run: "{{project.typecheck_command}}"
    - name: "Unit tests"
      type: command
      run: "{{project.test_unit_command}}"
    - name: "E2E tests"
      type: command
      run: "{{project.test_e2e_command}}"

    # Phase 1 — code review (parallel, after phase 0 passes)
    - name: "Gap analysis"
      type: llm-review
      phase: 1
      prompt: |
        ...
    - name: "Code quality review"
      type: llm-review
      phase: 1
      prompt: |
        ...
    - name: "Security review"
      type: llm-review
      phase: 1
      prompt: |
        ...

    # Phase 2 — QA testing (after phase 1 passes, opt-in)
    - name: "QA testing"
      type: agent-qa
      phase: 2
      optional: true
      label: "Enable QA Testing"
      prompt: |
        ...
```

The `documentation` gate's `depends_on` changes from `[qa-testing]` back to `[implementation]`.

The same change applies to `bug-fix.yaml`.

## Implementation plan

### Phase 1: Phased verification (server)

1. Add `phase?: number` to `VerifyStep` in `workflow-store.ts`.
2. Update `VerificationHarness.verifyGateSignal()` to group steps by phase, execute phases sequentially, and short-circuit on failure.
3. Update `ActiveVerification` step tracking to include phase info.
4. Update WebSocket events to include phase transitions.

### Phase 2: Verification artifacts (server + UI)

1. Add `artifact` field to `GateSignalStep` in `gate-store.ts`.
2. Update `VerificationHarness` to populate artifacts from `llm-review` output (full review text) and future `agent-qa` output.
3. Enforce 10 MB artifact size limit.
4. Update goal dashboard `renderSignalEntry()` to display artifacts (markdown inline, HTML in iframe/new tab).
5. Add artifact metadata display.

### Phase 3: `agent-qa` step type (server)

1. Add `agent-qa` case to `VerificationHarness` step execution.
2. Implement session spawning with `test-engineer` role, full tool access, `/qa-test` skill.
3. Implement `<verdict>` + `<qa_report>` extraction from agent output.
4. Wire up timeout from `qa_max_duration_minutes` project config + buffer.
5. Update the `/qa-test` skill to emit structured output (`<qa_report>` block + `<verdict>` tag).

### Phase 4: Optional steps with toggles (server + UI)

1. Add `optional?: boolean` and `label?: string` to `VerifyStep` in `workflow-store.ts`.
2. Add `enabledOptionalSteps?: string[]` to `PersistedGoal` in `goal-store.ts`.
3. Update `GoalManager.createGoal()` to accept and store enabled optional steps.
4. Update `VerificationHarness` to skip optional steps not in `enabledOptionalSteps`.
5. Update goal creation UI to render toggles for optional steps when a workflow is selected.
6. Update goal assistant prompt and `propose_goal` tool to support `options` parameter.
7. Update REST API for goal creation to accept `enabledOptionalSteps`.

### Phase 5: Remove standalone qa-testing gate

1. Remove `qa-testing` gate from `feature.yaml` and `bug-fix.yaml`.
2. Add `agent-qa` verification step to `implementation` gate in both workflows.
3. Update `documentation` gate `depends_on` from `[qa-testing]` to `[implementation]`.
4. Update team-lead role prompt — remove the "QA Testing Gate" section.
5. Update docs and AGENTS.md.

### Phase 6: Testing

1. **Unit tests:** Phased verification execution, artifact storage/retrieval, optional step skipping.
2. **E2E tests:** Goal creation with QA toggle, verification phase progression, artifact display on dashboard.
3. **Integration test:** Full `agent-qa` step execution with ephemeral environment (if feasible in CI; may need to be manual).

## Migration

Existing goals with a snapshotted `qa-testing` gate are unaffected — their frozen workflow still contains the gate. New goals created after this change use the updated workflows.

No data migration is needed. The `enabledOptionalSteps` field defaults to `undefined` (no optional steps enabled) for existing goals.

## Files changed

| File | Change |
|------|--------|
| `src/server/agent/workflow-store.ts` | Add `phase`, `optional`, `label` to `VerifyStep` |
| `src/server/agent/gate-store.ts` | Add `artifact` to `GateSignalStep` |
| `src/server/agent/goal-store.ts` | Add `enabledOptionalSteps` to `PersistedGoal` |
| `src/server/agent/goal-manager.ts` | Accept `enabledOptionalSteps` in `createGoal()` |
| `src/server/agent/verification-harness.ts` | `agent-qa` type orchestration, artifact population |
| `src/server/agent/verification-logic.ts` | Phased execution, optional step skipping, variable substitution, cache reuse, error pattern matching |
| `src/server/agent/goal-assistant.ts` | Add `<options>` tag to proposal format |
| `src/server/server.ts` | Pass `enabledOptionalSteps` through goal creation API |
| `src/app/goal-dashboard.ts` | Artifact rendering, phase display |
| `src/app/goal-creation.ts` (or equivalent) | Workflow toggle UI |
| `.bobbit/config/workflows/feature.yaml` | Remove `qa-testing` gate, add `agent-qa` step to implementation |
| `.bobbit/config/workflows/bug-fix.yaml` | Same |
| `.bobbit/config/roles/team-lead.yaml` | Remove QA gate section |
| `.claude/skills/qa-test/SKILL.md` | Emit `<qa_report>` block + `<verdict>` tag |
| `docs/qa-testing.md` | Rewrite for new architecture |
| `AGENTS.md` | Update recipes and debugging |
