# Proposal: Exploratory Validation in Workflows

## Problem

Automated tests (unit, integration, E2E) are deterministic and repeatable. They catch regressions but can't catch bugs that emerge from the interplay of real components — the exact category of bug that matters most for end-user experience.

The tool permission card bug is the canonical example: the E2E test passed because it simulated the guard with a direct REST call. The real flow (agent → guard extension → gateway broadcast → UI render) was never exercised. Only a real user — or an agent acting as one — could discover the card never appeared.

We need a way to produce **evidence that the real system works**, without replacing the deterministic test suite.

## Design Principles

1. **Evidence over process.** The gate artifact is an HTML report with screenshots and narration — not a pass/fail boolean. The human (or team lead) looks at the evidence and decides.

2. **Opt-in, not mandatory.** Not every goal needs this. A pure backend refactor doesn't need browser screenshots. A CSS tweak doesn't need an isolated gateway. The workflow selection determines whether exploratory validation runs.

3. **Budget-bounded.** Exploratory validation has a token/time budget. If the scenario can't be reproduced or verified within that budget, the gate produces a report explaining what was attempted and where it got stuck — still useful evidence.

4. **Complements automated tests.** This never replaces `npm test`. It answers a different question: "does the thing actually work when a human uses it?" The report might also identify gaps in automated coverage.

5. **Project-configurable.** Bobbit projects define *how* to stand up an isolated test environment (build command, server start command, health endpoint, browser entry point). Bobbit's own config is one instance of this.

## The Artifact: Validation Report

The gate artifact is an HTML file with:

```
## Validation Report: [Goal Title]

### Environment
- Branch: goal-fix-permission-card-abc123
- Commit: d7e1dd7
- Isolated gateway: http://127.0.0.1:59432 (temp dir, killed after)

### Scenario 1: Permission card appears on guard block
1. Created UX Designer session [screenshot]
2. Sent "Use bash_bg to run: echo hello" [screenshot]
3. Waited 20s for agent to call bash_bg
4. **PASS**: Permission card appeared with correct labels [screenshot]
   - Duration dropdown defaults to "This session"
   - Buttons: "Allow all tools in Shell" / "Allow just bash_bg" / "Deny"

### Scenario 2: Card persists across reconnection
5. Navigated to home page [screenshot]
6. Navigated back to session [screenshot]
7. **PASS**: Permission card still visible [screenshot]

### Scenario 3: Grant flow completes
8. Clicked "Allow all tools in Shell" [screenshot]
9. **PASS**: "Permission granted — re-executing with new tools..." [screenshot]
10. bash_bg executed successfully (bg-1, bg-2 visible) [screenshot]

### Automated Test Gap
The existing E2E test (tool-ask-policy.spec.ts) calls the REST endpoint
directly, bypassing the guard extension. Recommend adding a test that
exercises the real agent flow, or at minimum validates that the UI re-renders
on tool_permission_needed WS messages.
```

This is what the team lead (or human) reviews at the gate. The evidence speaks for itself.

## Workflow Integration

### New gate: `exploratory-validation`

Added to workflows that involve user-facing changes:

```yaml
# In feature.yaml or bug-fix.yaml
- id: exploratory-validation
  name: Exploratory Validation
  depends_on: [implementation]
  content: true           # The HTML report
  metadata:
    scenarios_passed: string
    scenarios_failed: string
    budget_used: string
  verify:
    - name: "Report quality"
      type: llm-review
      prompt: |
        Review this exploratory validation report.
        1. Does every scenario have screenshots as evidence?
        2. Are failures explained with enough detail to act on?
        3. Were automated test gaps identified?
```

This gate is optional — only workflows that include it require it. The `general` and `quick-fix` workflows would not include it.

### Who runs it

The **team lead** spawns a dedicated agent for this. Not a new role — use the existing `test-engineer` role with a specific task prompt that includes the validation protocol. The task prompt contains:
- The scenarios to validate (derived from the goal spec / design doc)
- The project's ephemeral environment config (how to start a server, what URL to hit)
- The budget (max time, max token spend)
- Instructions to produce the HTML report and signal the gate

### Workflow variants

| Workflow | Has exploratory validation? | Why |
|----------|----------------------------|-----|
| `quick-fix` | No | Too small / low risk |
| `bug-fix` | Optional — team lead decides | Useful for UI bugs, unnecessary for logic-only fixes |
| `feature` | Yes, for UI-touching features | The whole point — verify the user experience |
| `general` | No | Lightweight by design |

Rather than hard-coding this, the team lead decides based on the goal. The gate exists in the workflow template, but the team lead can skip it (signal with "N/A — no UI changes") or invest heavily (multiple scenarios with screenshots).

## Project Configuration

Each project defines how to create an ephemeral test environment in `project.yaml`:

```yaml
# .bobbit/config/project.yaml
exploratory_validation:
  # How to build the project for testing
  build_command: "npm run build"

  # How to start an isolated server
  # Receives env vars: PORT, WORK_DIR, BOBBIT_DIR (if applicable)
  start_command: |
    node dist/server/cli.js \
      --host 127.0.0.1 \
      --port $PORT \
      --no-tls --auth \
      --cwd $WORK_DIR

  # How to check if the server is ready
  health_check: "http://127.0.0.1:$PORT/api/health"

  # How to authenticate the browser
  # Token is read from $WORK_DIR/.bobbit/state/token (or configured here)
  browser_entry: "http://127.0.0.1:$PORT/?token=$TOKEN"

  # Budget
  max_duration_minutes: 10
  max_scenarios: 5

  # Environment variables passed to the server
  env:
    BOBBIT_NO_OPEN: "1"
    BOBBIT_LLM_REVIEW_SKIP: "1"
```

For non-Bobbit projects this might look like:

```yaml
exploratory_validation:
  build_command: "npm run build"
  start_command: "PORT=$PORT node server.js"
  health_check: "http://127.0.0.1:$PORT/health"
  browser_entry: "http://127.0.0.1:$PORT"
  max_duration_minutes: 5
```

Projects without this config simply can't run exploratory validation — the gate is skipped.

## Bobbit Self-Improvement Loop

For Bobbit working on itself, this creates a feedback cycle:

1. **Goal created** — e.g. "Fix permission card not showing"
2. **Design doc** — analysis, root cause, fix plan
3. **Implementation** — code changes, automated tests pass
4. **Exploratory validation** — agent builds from goal branch, starts isolated gateway, drives browser through the exact user journey, produces HTML report with screenshots
5. **Human reviews report** — sees the card working (or not), approves merge

If the exploratory validation fails, the report shows exactly what went wrong — with screenshots. The team lead can spawn a coder to fix it without the human needing to reproduce anything.

This is the recursive self-improvement loop: Bobbit implements a feature, validates it works end-to-end, identifies gaps in its own test coverage, and documents everything with visual evidence.

## Implementation Path

### Phase 1: Manual protocol (done)
The `docs/agent-debug-cycle.md` documents the protocol. Any agent can follow it today with browser tools.

### Phase 2: Project config + skill
- Add `exploratory_validation` config to `project.yaml` schema
- Create a skill (`/validate`) that reads the project config and executes the protocol: build → start server → drive browser → capture screenshots → generate report
- The skill handles the ephemeral lifecycle (temp dir, port allocation, cleanup)

### Phase 3: Workflow gate
- Add `exploratory-validation` gate to `feature.yaml` and `bug-fix.yaml`
- Team lead prompt updated to spawn test-engineer with validation task when the gate exists
- Gate verification checks report quality (has screenshots, scenarios covered)

### Phase 4: Scenario inference
- The validation skill reads the goal spec and design doc to infer test scenarios
- "This goal changes the permission card" → scenarios: card appears, card persists, grant works, deny works
- Reduces the manual prompt needed from the team lead

## What This Is Not

- **Not a replacement for unit tests.** If a function is wrong, a unit test catches it. This catches integration failures.
- **Not a CI gate.** This runs inside the goal workflow, not in GitHub Actions. It's agent time, not pipeline time.
- **Not flaky test debugging.** If a test is flaky, fix the test. This is for things that aren't tested at all.
- **Not unlimited.** The budget cap prevents runaway spend. If the agent can't validate within budget, it reports what it tried.
